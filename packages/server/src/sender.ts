/**
 * 送信ノード（sender）の Durable Object 入口。
 *
 * 判断は書かない。責務は接続・時刻・アラームという副作用の扱いのみである。
 * PartyKit は既定輸出のクラスを要求するため、本ファイルのみ既定輸出を用いる
 * （lint-policy.md 9.4 の例外）。
 *
 * 接続の形:
 *   - 入ってくる接続 … 送信側クライアント 1 人。`hello` のトークンを検証し `helloAck` を返す
 *   - 出ていく接続   … 割当先の中継ノード（現行 epoch と次期 epoch の 2 本まで）
 *
 * **中継ノードへは自分から繋ぐ**（`node-link.ts`）。段 F まではこの接続が存在せず、
 * クライアントから受けた媒体はどこへも行かなかった。
 */

import type * as Party from "partykit/server";
import { ERROR_DEFINITIONS } from "@wheso/core/src/generated/errors.ts";

import { REGION_AUTO, resolveAudioShard, resolveVideoShard } from "@wheso/core/src/naming.ts";
import { NODE_CONNECT_TIMEOUT_MS } from "@wheso/core/src/generated/constants.ts";
import { deriveMeetingSecret, verifyNodeAuthTag } from "@wheso/core/src/auth.ts";

import { admitClient, meetingIdFromPersonalRoom } from "./client-auth.ts";
import { openNodeLink, type NodeLink } from "./node-link.ts";
import {
  createSenderHandlerState,
  handleClientMedia,
  handleClientText,
  handleNewEpochFrame,
  handleStaleBacklog,
  handleTimer,
  noteSenderId,
  handleUpstreamText,
  type SenderHandlerState,
  type SenderTransport,
} from "./sender-handler.ts";
import { SHARD_PEER_CURRENT, SHARD_PEER_NEXT } from "@wheso/core/src/sender-core.ts";

/** 認証前の接続に許す猶予。これを超えて hello が来ない接続は閉じる（auth.md 5 節）。 */
const HELLO_TIMEOUT_MS = 5000;

/** 割当先への接続が整う前に溜める制御メッセージの上限。 */
const MAX_PENDING_SHARD = 32;

/** この部屋が担う役割。`vs` は映像、`as` は音声である。 */
type SendRole = "vs" | "as";

export class SenderNode implements Party.Server {
  private state: SenderHandlerState;

  /** 認証を通ったクライアント接続。送信部屋は 1 人ぶんだが再接続で重なり得る。 */
  private readonly clients = new Set<string>();
  /**
   * 接続を開いた時刻（接続 ID → ミリ秒）。**認証の猶予を接続ごとに数えるために持つ。**
   * アラームの刻みを猶予と混同すると、開いた直後の接続が `hello` の到着前に閉じられる。
   */
  private readonly openedAtMs = new Map<string, number>();

  /**
   * 認証の処理中の接続。
   *
   * `hello` の検証は非同期（署名の検証）である。その間に別のメッセージが届くと、
   * 「最初の 1 通は hello である」という前提で解析して失敗し、形式違反として
   * 接続を閉じてしまう（実測: 受信部屋が `report` を hello と解釈して 4020 で切った）。
   * 処理中の接続からのメッセージは**捨てる**（報告は周期的、購読は ACTIVE で送り直される）。
   */
  private readonly authenticating = new Set<string>();

  /** 観測のための計数。判断には使わない。 */
  private counters = { mediaIn: 0, textIn: 0, forwarded: 0 };

  /** 渡さなかった数の内訳（優先順位ごと）。観測のみ。 */
  private drops: Record<string, number> = {};

  /** 割当先の中継ノードへの接続。鍵は peer（現行 1 / 次期 2）である。 */
  private readonly shards = new Map<number, NodeLink>();

  /** 接続の確立中に二重に開かないための印。 */
  private readonly connecting = new Set<number>();

  /** peer ごとの直近の試行時刻。試行が返らない場合に再試行するために持つ（F-046）。 */
  private readonly attemptAtMs = new Map<number, number>();

  /** `ctl` 部屋への接続。はしごの申告と状態通知の宛先である。 */
  private control: NodeLink | null = null;

  private connectingControl = false;

  private controlAttemptAtMs = 0;

  /** 割当先への接続が整う前に送ろうとした制御メッセージ（はしごの申告など）。 */
  private pendingShard: string[] = [];

  private readonly transport: SenderTransport;

  /** 新 epoch から最初のフレームを受けたかどうか。二重購読の終了判定に使う。 */
  private sawNewEpochFrame = false;

  /** この部屋の会議 ID と利用者 ID。`onMessage` の文脈でのみ読む（アラームでは読めない）。 */
  private identity: { readonly meetingId: string; readonly userId: string; readonly role: SendRole } | null =
    null;

  constructor(readonly room: Party.Room) {
    this.state = createSenderHandlerState(1, Date.now());
    this.transport = {
      noteDrop: (priority) => {
        const drops = { ...this.drops };
        drops[String(priority)] = (drops[String(priority)] ?? 0) + 1;
        this.drops = drops;
      },
      sendToShard: (peer, bytes) => {
        this.counters = { ...this.counters, forwarded: this.counters.forwarded + 1 };
        this.shards.get(peer)?.sendBinary(bytes);
      },
      sendTextToShard: (peer, text) => {
        const link = this.shards.get(peer);
        if (link === undefined) {
          // 接続が整う前の申告を捨てない。捨てると中継ノードが fps を知らず、
          // 送信窓と段の選択が働かない。
          this.pendingShard.push(text);
          if (this.pendingShard.length > MAX_PENDING_SHARD) {
            this.pendingShard.shift();
          }
          return;
        }
        link.sendText(text);
      },
      sendTextToClient: (text) => {
        this.eachClient((connection) => connection.send(text));
      },
      connectShard: (peer) => {
        // 実際の接続は非同期である。結果は待たない（コマンドは同期に処理する）。
        void this.ensureShardLink(peer);
      },
      disconnectShard: (peer) => {
        const link = this.shards.get(peer);
        if (link !== undefined) {
          link.close();
          this.shards.delete(peer);
        }
      },
      closeClient: (code, reason) => {
        this.eachClient((connection) => connection.close(code, reason));
      },
      notifyControl: (code) => {
        void this.sendToControl(JSON.stringify({ t: "nodeStatus", code }));
      },
      sendTextToControl: (text) => {
        void this.sendToControl(text);
      },
      scheduleAt: (atMs) => {
        // 二重購読の時限は入口のアラームで起こす。コアは時刻を取得しない。
        void this.room.storage.setAlarm(atMs);
      },
    };
  }

  onConnect(connection: Party.Connection): void {
    // 未認証の接続を放置しない（auth.md 5 節の濫用対策）。
    // **猶予は接続ごとに数える。** アラームは送信窓の時限でも鳴るため、刻みを猶予と
    // 混同すると開いた直後の接続が `hello` の到着前に閉じられる。
    this.openedAtMs.set(connection.id, Date.now());
    void this.room.storage.setAlarm(Date.now() + HELLO_TIMEOUT_MS);
  }

  onClose(connection: Party.Connection): void {
    this.clients.delete(connection.id);
    this.authenticating.delete(connection.id);
    this.openedAtMs.delete(connection.id);
  }

  async onMessage(message: string | ArrayBuffer, sender: Party.Connection): Promise<void> {
    const now = Date.now();

    if (typeof message === "string") {
      if (!this.clients.has(sender.id)) {
        if (this.authenticating.has(sender.id)) {
          // 認証の処理中である。捨てる（hello として解釈してはならない）。
          return;
        }
        this.authenticating.add(sender.id);
        await this.authenticateClient(message, sender, now);
        this.authenticating.delete(sender.id);
        return;
      }
      // **心拍に応える**（規範 1 節の `HEARTBEAT_TIMEOUT_MS`）。応えないと静かな部屋
      // （`vs` / `as`）では受信が 1 度も起きず、クライアントは切れたことを知れない
      // （実測: 段 E で `close` の事象が来ず、音声が二度と戻らなかった）。
      if (message.includes('"t":"heartbeat"')) {
        sender.send(JSON.stringify({ t: "heartbeatAck" }));
        // **割当先への接続を進める。** 心拍は「入力が続くこと」を担っている（F-046）。
        // 応えてすぐ返すと接続が張られず、媒体が上流へ渡らない。
        void this.ensureShardLink(SHARD_PEER_CURRENT);
        return;
      }
      // クライアントの制御メッセージ。はしごの申告は中継ノードと ctl へ写す。
      // **`await` してはならない**（入力ゲートで握手が完了しない。F-046）。
      void this.ensureShardLink(SHARD_PEER_CURRENT);
      this.state = handleClientText(this.state, message, now, this.transport);
      return;
    }

    if (!this.clients.has(sender.id)) {
      // 認証前のメディアは扱わない。閉じるのは形式違反のときだけである。
      return;
    }
    // 媒体を受けた時点で割当先への接続を確かめる。**接続はアラームからは張れない。**
    // **`await` してはならない**（F-046）。最初の数枚は接続が整うまで捨てられる。
    void this.ensureShardLink(SHARD_PEER_CURRENT);
    this.counters = { ...this.counters, mediaIn: this.counters.mediaIn + 1 };
    this.state = handleClientMedia(this.state, new Uint8Array(message), now, this.transport);
  }

  /**
   * 観測の口（observability.md）。認証は `nodeHello` と同じ HMAC を頭部で受ける。
   *
   * 媒体が上流へ渡らないとき、原因が「接続が無い」「受理前で捨てた」「送信窓が閉じた」の
   * どれなのかを外から区別するために持つ。**会議の内容は返さない。**
   */
  async onRequest(request: Party.Request): Promise<Response> {
    const role = request.headers.get("x-wheso-node-role");
    const tag = request.headers.get("x-wheso-node-auth");
    const identity = this.identity;
    if (role === null || tag === null || identity === null) {
      return new Response(JSON.stringify({ t: "error", code: "E_NODE_AUTH" }), { status: 401 });
    }
    const nodeKey = this.room.env["WHESO_NODE_KEY"];
    if (typeof nodeKey !== "string" || nodeKey.length === 0) {
      return new Response(JSON.stringify({ t: "error", code: "E_NODE_AUTH" }), { status: 401 });
    }
    const secret = await deriveMeetingSecret(new TextEncoder().encode(nodeKey), identity.meetingId);
    if (!secret.ok) {
      return new Response(JSON.stringify({ t: "error", code: "E_NODE_AUTH" }), { status: 401 });
    }
    const verified = await verifyNodeAuthTag(secret.value, this.room.id, role, tag, Math.trunc(Date.now() / 1000));
    if (!verified.ok) {
      return new Response(JSON.stringify({ t: "error", code: "E_NODE_AUTH" }), { status: 401 });
    }
    const current = this.shards.get(SHARD_PEER_CURRENT);
    return new Response(
      JSON.stringify({
        t: "senderStatus",
        senderId: this.state.senderId,
        clients: this.clients.size,
        link: current === undefined ? null : {
          targetRoom: current.targetRoom,
          ready: current.isReady(),
          droppedBeforeReady: current.droppedBeforeReady(),
        },
        pendingShard: this.pendingShard.length,
        windows: this.state.core.windows,
        // Q-027 の測定。**判断には使わない**（窓の幅を決めるための観測である）。
        ackIntervalsMs: this.state.core.ackIntervalsMs,
        windowDropInFlight: this.state.core.windowDropInFlight,
        phase: this.state.core.phase,
        epoch: this.state.core.epoch,
        counters: this.counters,
        drops: this.drops,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  onAlarm(): void {
    const now = Date.now();
    // 猶予を過ぎた未認証の接続を閉じる。**経過は接続ごとに見る。**
    for (const connection of this.room.getConnections()) {
      if (this.clients.has(connection.id)) {
        continue;
      }
      const openedAt = this.openedAtMs.get(connection.id);
      if (openedAt === undefined) {
        // 実行環境が入れ替わると表は空になる。空を猶予切れと読んではならない（F-046）。
        this.openedAtMs.set(connection.id, now);
        continue;
      }
      if (now - openedAt < HELLO_TIMEOUT_MS) {
        continue;
      }
      connection.close(ERROR_DEFINITIONS.E_HELLO_TIMEOUT.closeCode, "hello timeout");
    }
    // 旧接続の残量を伝える。0 になったら旧接続を閉じる判断が下る（state-machines.md 5 節）。
    const stale = this.shards.get(SHARD_PEER_CURRENT);
    if (stale !== undefined) {
      this.state = handleStaleBacklog(this.state, stale.droppedBeforeReady(), now, this.transport);
    }
    this.state = handleTimer(this.state, now, this.transport);
  }

  /** クライアントの `hello` を検証し、通れば `helloAck` を返す。 */
  private async authenticateClient(text: string, sender: Party.Connection, nowMs: number): Promise<void> {
    const tokenKey = this.room.env["WHESO_TOKEN_KEY"];
    const role = this.roleOfRoom();
    const admitted = await admitClient({
      roomId: this.room.id,
      expectedRole: role,
      tokenKey: typeof tokenKey === "string" ? tokenKey : "",
      text,
      nowMs,
    });
    if (!admitted.ok) {
      sender.close(admitted.error.closeCode, admitted.error.code);
      return;
    }
    const meetingId = meetingIdFromPersonalRoom(this.room.id, role);
    const userId = this.room.id.split("-")[2];
    if (meetingId !== null && userId !== undefined) {
      this.identity = { meetingId, userId, role };
    }
    this.clients.add(sender.id);
    // 担当する送信者 ID を記録する。はしごの申告に載せる（0 を書いてはならない）。
    this.state = noteSenderId(this.state, admitted.value.senderId);
    sender.send(admitted.value.ackText);
  }

  /**
   * 割当先の中継ノードへの接続を確かめる。無ければ張る。
   *
   * 割当は部屋名から決定論的に決まる（room-naming.md 1 節）。中央へ問い合わせない。
   * シャード数は現時点では 1 である（複数シャードは段 5。`meta` が epoch と数を配る）。
   */
  private async ensureShardLink(peer: number): Promise<void> {
    if (this.shards.has(peer)) {
      return;
    }
    const attempted = this.attemptAtMs.get(peer) ?? 0;
    if (this.connecting.has(peer) && Date.now() - attempted < NODE_CONNECT_TIMEOUT_MS) {
      return;
    }
    const identity = this.identity;
    if (identity === null) {
      return;
    }
    const nodeKey = this.room.env["WHESO_NODE_KEY"];
    if (typeof nodeKey !== "string" || nodeKey.length === 0) {
      return;
    }
    const epoch = peer === SHARD_PEER_NEXT ? this.state.core.epoch + 1 : this.state.core.epoch;
    const input = {
      userId: identity.userId,
      meetingId: identity.meetingId,
      region: REGION_AUTO,
      epoch,
      shardCount: 1,
      overrides: new Map<string, number>(),
    };
    const assignment = identity.role === "vs" ? resolveVideoShard(input) : resolveAudioShard(input);
    if (!assignment.ok) {
      return;
    }
    this.connecting.add(peer);
    this.attemptAtMs.set(peer, Date.now());
    const link = await openNodeLink({
      room: this.room,
      party: "shard",
      targetRoom: assignment.value.roomName,
      meetingId: identity.meetingId,
      role: "sender",
      nodeKey,
      nowMs: Date.now(),
      onText: (text) => {
        this.state = handleUpstreamText(this.state, text, Date.now(), this.transport);
      },
      onBinary: () => {
        // 新 epoch のシャードからフレームが届いたら二重購読を終える（state-machines.md 5 節）。
        if (peer === SHARD_PEER_NEXT && !this.sawNewEpochFrame) {
          this.sawNewEpochFrame = true;
          this.state = handleNewEpochFrame(this.state, Date.now(), this.transport);
        }
      },
      onClose: () => {
        this.shards.delete(peer);
      },
    });
    this.connecting.delete(peer);
    if (!link.ok) {
      return;
    }
    this.shards.set(peer, link.value);
    for (const text of this.pendingShard) {
      link.value.sendText(text);
    }
    this.pendingShard = [];
  }

  /**
   * `ctl` 部屋へ送る。
   *
   * はしごの申告と状態通知の宛先である（ADR-0027 の 1）。`ctl` は 1 利用者 1 部屋であり、
   * 部屋名は自分の部屋名から導ける（役割だけが違う）。
   *
   * **HTTP ではなく WebSocket で送り、`nodeHello` の HMAC を通す。** 部屋は外から到達可能
   * であるため、認証の無い経路を開けると第三者がはしごの申告を偽装できる。
   */
  private async sendToControl(text: string): Promise<void> {
    // 接続の確立は待たない（F-046）。未確立の間の本文は `NodeLink` が溜めて送る。
    void this.ensureControlLink();
    this.control?.sendText(text);
  }

  /** `ctl` への接続を確かめる。無ければ張る。 */
  private async ensureControlLink(): Promise<void> {
    if (this.control !== null) {
      return;
    }
    if (this.connectingControl && Date.now() - this.controlAttemptAtMs < NODE_CONNECT_TIMEOUT_MS) {
      return;
    }
    const identity = this.identity;
    if (identity === null) {
      return;
    }
    const nodeKey = this.room.env["WHESO_NODE_KEY"];
    if (typeof nodeKey !== "string" || nodeKey.length === 0) {
      return;
    }
    this.connectingControl = true;
    this.controlAttemptAtMs = Date.now();
    const link = await openNodeLink({
      room: this.room,
      party: "control",
      targetRoom: `ctl-${identity.meetingId}-${identity.userId}`,
      meetingId: identity.meetingId,
      role: "sender",
      nodeKey,
      nowMs: Date.now(),
      onText: () => {
        // `ctl` からの配信（participants / streamCatalog）はクライアントが直接受ける。
        // 送信ノードは扱わない。
      },
      onBinary: () => {
        // `ctl` に媒体は流れない。
      },
      onClose: () => {
        this.control = null;
      },
    });
    this.connectingControl = false;
    if (link.ok) {
      this.control = link.value;
    }
  }

  /** 部屋名の先頭から役割を読む。 */
  private roleOfRoom(): SendRole {
    return this.room.id.startsWith("as-") ? "as" : "vs";
  }

  private eachClient(action: (connection: Party.Connection) => void): void {
    for (const id of this.clients) {
      const connection = this.room.getConnection(id);
      if (connection !== undefined && connection !== null) {
        action(connection);
      }
    }
  }
}

export default SenderNode;
