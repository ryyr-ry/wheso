/**
 * 中継ノード（shard）の Durable Object 入口。
 *
 * ここには判断を書かない。責務は 3 つに限る。
 *   1. 接続と時刻という副作用を扱う
 *   2. 参加者 ID と接続 ID の対応を持つ
 *   3. shard-handler へ委ね、返された送信を実行する
 *
 * PartyKit は既定輸出のクラスを要求するため、本ファイルのみ既定輸出を用いる
 * （lint-policy.md 5 節の例外）。判断を持つコードは名前付き輸出のみである。
 *
 * 時刻の扱い: Date.now() はメッセージ受信ごとに更新される。I/O が無い間は進まない
 * （evidence F-020、F-021）。したがって時刻は「イベントを受け取った瞬間」にのみ読み、
 * 判断コアへ入力として渡す。コアの内部では時刻を取得しない。
 */

import type * as Party from "partykit/server";

import { deriveMeetingSecret } from "@wheso/core/src/auth.ts";
import { fnv1a32 } from "@wheso/core/src/naming.ts";
import { ACK_INTERVAL_MS } from "@wheso/core/src/generated/constants.ts";
import { ERROR_DEFINITIONS } from "@wheso/core/src/generated/errors.ts";

/**
 * タイマーの間隔。
 *
 * ack の周期（`ACK_INTERVAL_MS`）と同じにする。判定の入力は ack の到着であり、
 * それより細かく起こしても新しい情報が無く、粗くすると死接続の検出が遅れる。
 * 数値をここに書かない（AGENTS 5.3）。
 */
const SHARD_TIMER_INTERVAL_MS = ACK_INTERVAL_MS;

import {
  buildNodeHelloAck,
  createNodeGateState,
  forgetNode,
  isNodeAuthenticated,
  markNodeAuthenticated,
  parseNodeHello,
  recordDroppedBeforeHello,
  verifyNodeHello,
  type NodeGateState,
} from "./node-auth.ts";

import type { ShardTarget } from "./shard-handler.ts";
import {
  createShardHandlerState,
  handleBinary,
  handleLifecycle,
  handleText,
  handleTimer,
  type ShardHandlerState,
  type ShardPeer,
  type ShardTransport,
} from "./shard-handler.ts";

/** 中継部屋の名前から会議 ID を取り出す。`vsh-<会議 ID>-<region>-<epoch>-<index>` の形である。 */
function meetingIdFromRoom(roomId: string): string | null {
  const parts = roomId.split("-");
  const meetingId = parts[1];
  return meetingId === undefined || meetingId.length === 0 ? null : meetingId;
}

/**
 * 接続 ID から参加者 ID を得る。参加者 ID は 32bit の正の整数である（wire-format.md 1.1）。
 *
 * **`Number.parseInt` を使ってはならない。** 先頭の数字だけを拾うため、実行環境が付ける
 * 接続 ID（`330abc…` のような文字列）から `330` という偽の参加者 ID が生まれる。
 * 実測ではこれが原因で、ノード間接続が偽の ID で登録され、転送の宛先が解決できず
 * 媒体が 1 件も届かなかった（`outNoConnection` が 4 件、`binaryOut` が 0 件）。
 *
 * 試験と道具は `?_pk=<数値>` で接続する。その場合だけ接続 ID がそのまま参加者 ID である。
 * したがって**全体が数字である**ことを要求する。
 */
function participantIdOf(connectionId: string): number {
  if (!/^[0-9]+$/.test(connectionId)) {
    return 0;
  }
  const parsed = Number.parseInt(connectionId, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * ノードが名乗った部屋名から参加者 ID を導く。
 *
 * **ノード間接続には `_pk` が無い**（`stub.socket()` は接続 ID を自分で決める）。
 * したがって接続 ID からは参加者 ID が取れず、転送の宛先が 0 になって**何も届かない**。
 * 部屋名は `<役割>-<会議 ID>-<利用者 ID>` であり、利用者 ID を `fnv1a32` にかけると
 * クライアントの `senderIdOf` と同じ値になる。算出は `naming.ts` の参照実装に委ねる。
 */
function participantIdFromNodeId(nodeId: string): number {
  const parts = nodeId.split("-");
  const userId = parts[2];
  if (userId === undefined || userId.length === 0) {
    return 0;
  }
  const hash = fnv1a32(userId);
  return hash === 0 ? 1 : hash;
}

export class ShardNode implements Party.Server {
  private state: ShardHandlerState;

  /**
   * ノード間認証の関門。
   * 部屋名は決定論的であるため、認証が無ければ第三者がメディアを注入できる
   * （wire-format.md 2.8、auth.md）。nodeHello を受けるまでメディアを受け付けない。
   */
  private gate: NodeGateState = createNodeGateState();

  /**
   * 接続 ID から参加者 ID への対応。
   * ノード間接続では `nodeHello` の名乗りから導く（`_pk` が無いため）。
   */
  private readonly peerIds = new Map<string, number>();

  /**
   * 観測のための計数。判断には使わない。
   *
   * 媒体が届かないときに「受け取ったが転送しなかった」と「転送したが宛先が無かった」を
   * 区別するために持つ。区別できないと原因の層を取り違える。
   */
  /** 破棄の内訳（優先順位ごとの件数）。観測のため。 */
  private drops: Record<string, number> = {};

  /** この実体を見分ける印（観測のみ）。休止からの起き直しを検出する（X-043）。 */
  private readonly instanceId = `${String(Date.now() % 1_000_000)}-${String(Math.trunc(Math.random() * 100_000))}`;

  private readonly startedAtMs = Date.now();

  /** 最後に時限処理を回した時刻。媒体の到着で回すため記録する。 */
  private lastTickAtMs = 0;

  private counters = {
    binaryIn: 0,
    binaryOut: 0,
    outNoConnection: 0,
    textIn: 0,
    textOut: 0,
    textOutNoConnection: 0,
    nodeAuthOk: 0,
    nodeAuthFail: 0,
    droppedBeforeHello: 0,
    alarms: 0,
    alarmErrors: 0,
  };

  private readonly transport: ShardTransport;

  constructor(readonly room: Party.Room) {
    this.state = createShardHandlerState(Date.now());
    this.transport = {
      sendBinary: (participantId, bytes) => {
        // 媒体の宛先は購読者、すなわち**受信ノード**である。
        const connection = this.connectionFor(participantId, "receiver");
        if (connection === null) {
          this.counters = { ...this.counters, outNoConnection: this.counters.outNoConnection + 1 };
          return;
        }
        this.counters = { ...this.counters, binaryOut: this.counters.binaryOut + 1 };
        connection.send(bytes);
      },
      sendText: (participantId, target, text) => {
        const connection = this.connectionFor(participantId, target);
        if (connection === null) {
          this.counters = { ...this.counters, textOutNoConnection: this.counters.textOutNoConnection + 1 };
          return;
        }
        this.counters = { ...this.counters, textOut: this.counters.textOut + 1 };
        connection.send(text);
      },
      close: (participantId, target, code, reason) => {
        const connection = this.connectionFor(participantId, target);
        if (connection !== null) {
          connection.close(code, reason);
        }
      },
      noteDrop: (priority, count) => {
        const key = String(priority);
        const current = this.drops[key] ?? 0;
        this.drops = { ...this.drops, [key]: current + count };
      },
      notifyControl: (code) => {
        // 制御系への通知は全接続への制御メッセージとして送る。
        // ctl 部屋への直接接続は control ノードの実装後に置き換える。
        this.room.broadcast(JSON.stringify({ t: "nodeStatus", code }));
      },
    };
  }

  onConnect(connection: Party.Connection): void {
    const peer = this.peerOf(connection);
    this.state = handleLifecycle(this.state, peer, "open", Date.now(), this.transport);
    // **タイマーを予約する。** 予約しないと `handleTimer` が 1 度も呼ばれず、
    // ack が途絶えた購読の検出（congestion.md 7 節）と輻輳の回復方向の遷移
    // （state-machines.md 3 節）が起きない。段 F まで予約が無く、どちらも死んでいた。
    void this.room.storage.setAlarm(Date.now() + SHARD_TIMER_INTERVAL_MS);
  }

  /**
   * 媒体の到着に合わせて時限処理（ack の返送と輻輳の評価）を回す。
   *
   * **アラームだけに頼ってはならない。** 規範は `ACK_INTERVAL_MS`（50 ms）ごとの ack を
   * 前提に送信窓（`SEND_WINDOW_MS` = 200 ms ぶん）を定めているが、実行環境のアラームは
   * それより粗く発火する（実測: 10 秒で 104 回 ≒ 100 ms 間隔）。ack が遅れると送信ノードの
   * 窓が閉じ、破棄が始まる（実測: 52 件のうち 42 件が破棄された。F-064）。
   *
   * 媒体が流れている間は入力があるため、入力に合わせて回せばアラームの粗さに依らない。
   * 呼ぶ間隔は `ACK_INTERVAL_MS` で律する（毎フレーム返すとメッセージレートを食う。F-024）。
   */
  private maybeTick(nowMs: number): void {
    if (nowMs - this.lastTickAtMs < ACK_INTERVAL_MS) {
      return;
    }
    this.lastTickAtMs = nowMs;
    this.state = handleTimer(this.state, nowMs, this.transport);
  }

  onClose(connection: Party.Connection): void {
    const peer = this.peerOf(connection);
    this.gate = forgetNode(this.gate, connection.id);
    this.peerIds.delete(connection.id);
    this.state = handleLifecycle(this.state, peer, "close", Date.now(), this.transport);
  }

  async onMessage(message: string | ArrayBuffer, sender: Party.Connection): Promise<void> {
    const now = Date.now();
    const peer = this.peerOf(sender);

    if (typeof message === "string") {
      // nodeHello なら認証を試みる。それ以外は購読などの制御として扱う。
      const hello = parseNodeHello(message);
      if (hello.ok) {
        await this.authenticate(hello.value.role, hello.value.authTag, hello.value.nodeId, sender);
        return;
      }
      this.counters = { ...this.counters, textIn: this.counters.textIn + 1 };
      this.state = handleText(this.state, peer, message, now, this.transport);
      // **制御の到着でも ack を返す。** 規範は 50 ms ごとの ack を前提に送信窓を 200 ms と
      // 定めている（congestion.md 2 節: 「4 回の更新で窓を使い切るまでの粒度」）。媒体の
      // 到着だけを引き金にすると、ack の間隔が**媒体の間隔**で決まってしまう（10 fps なら
      // 100 ms。実測 p50 95 ms）。すると窓の更新は 2 回しか入らず、1 度の遅れで窓が閉じて
      // 破棄不可のユニットが落ちる。購読者の ack や報告も入力であるから、これも引き金にする。
      this.maybeTick(now);
      return;
    }

    // メディアは認証済みの接続からのみ受け付ける。
    // 認証前に届いたものは破棄する（wire-format.md 2.8）。
    if (!isNodeAuthenticated(this.gate, sender.id)) {
      this.gate = recordDroppedBeforeHello(this.gate);
      this.counters = { ...this.counters, droppedBeforeHello: this.counters.droppedBeforeHello + 1 };
      return;
    }
    this.counters = { ...this.counters, binaryIn: this.counters.binaryIn + 1 };
    this.state = handleBinary(this.state, peer, new Uint8Array(message), now, this.transport);
    // 媒体の到着に合わせて ack を返す（アラームの粗さに依らない。F-064）。
    this.maybeTick(now);
  }

  /** nodeHello の HMAC を検証し、通れば以後のメディアを受け付ける。 */
  private async authenticate(
    role: string,
    authTag: string,
    nodeId: string,
    sender: Party.Connection,
  ): Promise<void> {
    const nodeKey = this.room.env["WHESO_NODE_KEY"];
    if (typeof nodeKey !== "string" || nodeKey.length === 0) {
      // 鍵が無い環境では認証できない。開いたままにしない。
      sender.close(ERROR_DEFINITIONS.E_NODE_AUTH.closeCode, "node key missing");
      return;
    }
    const meetingId = meetingIdFromRoom(this.room.id);
    if (meetingId === null) {
      sender.close(ERROR_DEFINITIONS.E_NAME_MEETING_ID.closeCode, "E_NAME_MEETING_ID");
      return;
    }
    const secret = await deriveMeetingSecret(new TextEncoder().encode(nodeKey), meetingId);
    if (!secret.ok) {
      sender.close(ERROR_DEFINITIONS.E_NODE_AUTH.closeCode, "secret derivation failed");
      return;
    }
    const parsed = parseNodeHello(JSON.stringify({ t: "nodeHello", role, nodeId: this.room.id, authTag }));
    if (!parsed.ok) {
      sender.close(parsed.error.closeCode, parsed.error.code);
      return;
    }
    const verified = await verifyNodeHello({
      meetingSecret: secret.value,
      targetRoomName: this.room.id,
      hello: parsed.value,
      nowSec: Math.trunc(Date.now() / 1000),
    });
    if (!verified.ok) {
      this.counters = { ...this.counters, nodeAuthFail: this.counters.nodeAuthFail + 1 };
      sender.close(verified.error.closeCode, verified.error.code);
      return;
    }
    this.counters = { ...this.counters, nodeAuthOk: this.counters.nodeAuthOk + 1 };
    this.gate = markNodeAuthenticated(this.gate, sender.id, parsed.value.role);
    // 参加者 ID を学ぶ。`_pk` が無いノード間接続では、名乗った部屋名から導く。
    if (participantIdOf(sender.id) === 0) {
      const derived = participantIdFromNodeId(nodeId);
      if (derived > 0) {
        this.peerIds.set(sender.id, derived);
        // 参加として数え直す。接続時は ID が判らなかったため 0 で数えていた。
        this.state = handleLifecycle(
          this.state,
          { participantId: derived, isNode: true },
          "open",
          Date.now(),
          this.transport,
        );
      }
    }
    // 受理したことを伝える。接続元はこれを受けて転送を開始する（state-machines.md 4 節）。
    sender.send(buildNodeHelloAck(this.room.id));
  }

  onAlarm(): void {
    // 回復方向の遷移は送信が止まった状態でも起きる必要がある（state-machines.md 3 節）。
    const now = Date.now();
    this.counters = { ...this.counters, alarms: this.counters.alarms + 1 };
    // **アラームも同じ律で通す。** 直接 `handleTimer` を呼ぶと、入力で回した直後に
    // 二重に ack を返し、`ACK_INTERVAL_MS` の下限を破る（メッセージレートを無駄に食う）。
    this.maybeTick(now);
    // 接続がある間だけ起き続ける。誰も居ない部屋を起こし続けない。
    // **`onAlarm` では `room.id` と `context.parties` に触れられない**（PartyKit の制約）。
    // ここでは接続の数と storage しか使わない。
    if ([...this.room.getConnections()].length > 0) {
      void this.room.storage.setAlarm(now + SHARD_TIMER_INTERVAL_MS);
    }
  }

  /**
   * 観測の口（observability.md）。
   *
   * **なぜ必要か。** 媒体が届かないとき、原因が購読の未登録・宛先の解決の失敗・
   * 輻輳による破棄・送信窓のどれなのかを外から区別できなかった。区別できないまま
   * 実装を直そうとすると、正しい実装を壊す（誤解カタログ X-034 と同じ型の誤り）。
   *
   * 認証は `nodeHello` と同じ HMAC を頭部で受ける。**会議の内容は返さない**（媒体の
   * 中身とペイロードは含めない）。返すのは計数と購読の構造だけである。
   */
  async onRequest(request: Party.Request): Promise<Response> {
    const role = request.headers.get("x-wheso-node-role");
    const tag = request.headers.get("x-wheso-node-auth");
    const roomName = this.roomNameFrom(request);
    if (role === null || tag === null || roomName === null || !(await this.verifyTag(role, tag, roomName))) {
      return new Response(JSON.stringify({ t: "error", code: "E_NODE_AUTH" }), { status: 401 });
    }
    const core = this.state.core;
    return new Response(
      JSON.stringify({
        t: "shardStatus",
        // **実体の印。** Durable Object は休止から起き直すと記憶が消える。同じ試験の中で
        // これが変われば「状態が消えた」ことが分かり、論理の欠陥と区別できる（X-043）。
        instance: this.instanceId,
        startedAtMs: this.startedAtMs,
        participants: core.participants,
        peers: [...this.peerIds.entries()].map(([connectionId, participantId]) => ({
          connectionId,
          participantId,
          role: this.gate.authenticated.find((entry) => entry.connectionId === connectionId)?.role ?? null,
        })),
        subscriptions: core.subscriptions.map((sub) => ({
          subscriberId: sub.subscriberId,
          targetId: sub.targetId,
          channel: sub.channel,
          maxSpatialId: sub.maxSpatialId,
          windowSid: sub.windowSid,
          congestionEnteredAt: sub.congestionEnteredAt,
          highestSent: sub.highestSent,
          highestAcked: sub.highestAcked,
          stalled: sub.stalled,
          congestion: sub.congestion,
          tierPenalty: sub.tierPenalty,
        })),
        ladders: core.ladders.map((entry) => ({
          from: entry.from,
          ch: entry.ch,
          announced: entry.announced,
          rungs: entry.rungs.map((rung) => rung.sid),
        })),
        received: core.received,
        counters: this.counters,
        drops: this.drops,
        unexpectedEvents: core.unexpectedEvents.length,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  /** 頭部の認証タグを検証する（WebSocket の `nodeHello` と同じ算出）。 */
  /**
   * 要求の URL から部屋名を取る。
   *
   * **`onRequest` では `room.id` に触れられないことがある**（実測: «Party.id is not yet
   * initialized»。F-050）。休止から起きた直後や、接続より先に要求が来た場合に起きる。
   * 経路の最後の区切りが部屋名であり、これは常に手に入る。
   */
  private roomNameFrom(request: Party.Request): string | null {
    const segments = new URL(request.url).pathname.split("/").filter((part) => part !== "");
    const last = segments[segments.length - 1];
    return last === undefined ? null : last;
  }

  private async verifyTag(role: string, tag: string, roomName: string): Promise<boolean> {
    const nodeKey = this.room.env["WHESO_NODE_KEY"];
    if (typeof nodeKey !== "string" || nodeKey.length === 0) {
      return false;
    }
    const meetingId = meetingIdFromRoom(roomName);
    if (meetingId === null) {
      return false;
    }
    const secret = await deriveMeetingSecret(new TextEncoder().encode(nodeKey), meetingId);
    if (!secret.ok) {
      return false;
    }
    const parsed = parseNodeHello(
      JSON.stringify({ t: "nodeHello", role, nodeId: roomName, authTag: tag }),
    );
    if (!parsed.ok) {
      return false;
    }
    const verified = await verifyNodeHello({
      meetingSecret: secret.value,
      targetRoomName: this.room.id,
      hello: parsed.value,
      nowSec: Math.trunc(Date.now() / 1000),
    });
    return verified.ok;
  }

  /**
   * 参加者 ID から接続を引く。
   *
   * **2 通りの接続がある。**
   *   1. `?_pk=<数値>` で繋いだ接続 … 接続 ID がそのまま参加者 ID である（試験と道具）
   *   2. ノード間接続（`stub.socket()`） … 接続 ID は実行環境が決める文字列であり、
   *      参加者 ID は `nodeHello` の名乗りから導いて `peerIds` に記録してある
   *
   * 2 を引けないと**転送の宛先が見つからず、媒体が 1 バイトも届かない**（実際にそうなった。
   * 中継ノードは正しく転送を決めていたが、宛先の接続を `getConnection(String(id))` で
   * 探していたため常に見つからなかった）。
   */
  private connectionFor(participantId: number, target: ShardTarget): Party.Connection | null {
    for (const [connectionId, id] of this.peerIds) {
      if (id !== participantId) {
        continue;
      }
      // **役割が一致する接続だけを選ぶ。** 1 人の参加者は送信ノードと受信ノードの両方から
      // 繋ぐため、参加者 ID だけでは宛先が決まらない（`ShardTarget` の説明を参照）。
      const role = this.gate.authenticated.find((entry) => entry.connectionId === connectionId)?.role;
      if (role !== target) {
        continue;
      }
      const found = this.room.getConnection(connectionId);
      if (found !== undefined && found !== null) {
        return found;
      }
    }
    // `?_pk=<数値>` で繋いだ接続（試験と道具）。役割は名乗りで決まるため、ここでは
    // 参加者 ID の一致だけを見る。
    const direct = this.room.getConnection(String(participantId));
    return direct === undefined || direct === null ? null : direct;
  }

  private peerOf(connection: Party.Connection): ShardPeer {
    const learned = this.peerIds.get(connection.id);
    if (learned !== undefined) {
      return { participantId: learned, isNode: true };
    }
    return { participantId: participantIdOf(connection.id), isNode: false };
  }
}

export default ShardNode;
