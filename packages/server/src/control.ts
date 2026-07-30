/**
 * 制御ノード（control、`ctl` 部屋）の Durable Object 入口。
 *
 * 判断は書かない。責務は接続・時刻・鍵の取得という副作用の扱いのみである。
 * PartyKit は既定輸出のクラスを要求するため、本ファイルのみ既定輸出を用いる
 * （lint-policy.md 9.4 の例外）。
 *
 * 鍵は環境変数から読む。クライアントへ渡してはならない（Q-019）。
 * 部屋名は `ctl-<会議 ID>-<利用者 ID>` である。会議 ID は部屋名から取り出す。
 */

import type * as Party from "partykit/server";

import {
  addParticipant,
  authorize,
  createControlState,
  helloAck,
  needsResharding,
  parseCatalogUpdate,
  parseHello,
  participantsMessage,
  recordCatalogEntry,
  recordDirectory,
  recordNodeStatus,
  removeCatalogFor,
  removeParticipant,
  streamCatalogMessage,
  type ControlState,
} from "./control-handler.ts";
import {
  buildNodeHelloAck,
  createNodeGateState,
  forgetNode,
  isNodeAuthenticated,
  markNodeAuthenticated,
  parseNodeHello,
  verifyNodeHello,
  type NodeGateState,
} from "./node-auth.ts";
import { deriveMeetingSecret } from "@wheso/core/src/auth.ts";
import { ERROR_DEFINITIONS } from "@wheso/core/src/generated/errors.ts";
import { MAX_CONNECT_ATTEMPTS_PER_MIN } from "@wheso/core/src/generated/constants.ts";
import { admit, initialRateWindow, type RateWindow } from "@wheso/core/src/rate-limit.ts";
import { buildNodeHello } from "./node-link.ts";

/** 認証前の接続に許す猶予。これを超えて hello が来ない接続は閉じる。 */
const HELLO_TIMEOUT_MS = 5000;


/**
 * 接続試行を数える窓の長さ。規範は「20 回/分」であるため 1 分とする（auth.md 5 節）。
 * 秒数をここに書かないため、分をミリ秒へ直す形で表す。
 */
const CONNECT_WINDOW_MS = 60_000;

export class ControlNode implements Party.Server {
  private state: ControlState = createControlState();

  /** 接続 ID から認証済みの利用者 ID を引く。未認証の接続は含まない。 */
  private readonly authenticated = new Map<string, string>();

  /**
   * 接続試行の計数（auth.md 5 節。1 利用者あたり 20 回/分）。
   *
   * この部屋は 1 利用者専用である（部屋名が `ctl-<会議 ID>-<利用者 ID>`）。
   * したがって部屋あたりの試行を数えれば利用者あたりの制限になる。
   * カウンタはインメモリで保持し、evict で失われてよい（規範に明記がある）。
   */
  private connectWindow: RateWindow = initialRateWindow(0);

  /** ノード間認証の関門。はしごの申告と状態通知はノードから来る。 */
  private gate: NodeGateState = createNodeGateState();

  /**
   * 認証の処理中の接続。処理中に届いたメッセージは捨てる。
   * hello として解釈すると形式違反で接続を閉じてしまう。
   */
  private readonly authenticating = new Set<string>();
  /**
   * 接続を開いた時刻（接続 ID → ミリ秒）。**認証の猶予を接続ごとに数えるために持つ。**
   * アラームの刻みを猶予と混同すると、開いた直後の接続が `hello` の到着前に閉じられる。
   */
  private readonly openedAtMs = new Map<string, number>();





  constructor(readonly room: Party.Room) {}

  onConnect(connection: Party.Connection): void {
    // 接続試行のレート制限。超過は E_RATE_LIMIT_CONNECT で閉じる。
    // 判断は純関数（rate-limit.ts）に置き、ここでは時刻の取得と切断だけを行う。
    const decision = admit(this.connectWindow, Date.now(), CONNECT_WINDOW_MS, MAX_CONNECT_ATTEMPTS_PER_MIN);
    this.connectWindow = decision.window;
    if (!decision.allowed) {
      connection.close(
        ERROR_DEFINITIONS.E_RATE_LIMIT_CONNECT.closeCode,
        "E_RATE_LIMIT_CONNECT",
      );
      return;
    }
    // 未認証の接続を放置しない。猶予を過ぎたら閉じる（auth.md 5 節の濫用対策）。
    // **猶予は接続ごとに数える**（アラームの刻みを猶予と混同しない）。
    this.openedAtMs.set(connection.id, Date.now());
    void this.room.storage.setAlarm(Date.now() + HELLO_TIMEOUT_MS);
  }

  onClose(connection: Party.Connection): void {
    this.gate = forgetNode(this.gate, connection.id);
    this.authenticating.delete(connection.id);
    this.openedAtMs.delete(connection.id);
    const userId = this.authenticated.get(connection.id);
    if (userId === undefined) {
      return;
    }
    this.authenticated.delete(connection.id);
    // 会議全体の名簿から外す。外さないと退出した参加者を購読し続ける。
    void this.callMeta(JSON.stringify({ t: "unregister", userId }));
    const leaving = this.state.participants.find((entry) => entry.userId === userId);
    this.state = removeParticipant(this.state, userId);
    if (leaving !== undefined) {
      void this.callMeta(JSON.stringify({ t: "leave", id: leaving.senderId }));
      // 退出した送信者のはしごを消す。残すと居ない相手の段を要求させてしまう。
      this.state = removeCatalogFor(this.state, leaving.senderId);
      this.room.broadcast(streamCatalogMessage(this.state));
    }
    this.room.broadcast(participantsMessage(this.state));
  }

  async onMessage(message: string | ArrayBuffer, sender: Party.Connection): Promise<void> {
    if (typeof message !== "string") {
      // 制御部屋にメディアは来ない。形式違反として閉じる。
      sender.close(ERROR_DEFINITIONS.E_CTRL_SCHEMA.closeCode, "E_CTRL_SCHEMA");
      return;
    }

    // ノードの名乗り（nodeHello）を先に見る。
    // **HTTP でこれを受けてはならない。** 部屋は外から到達可能であり、認証の無い経路を
    // 開けると第三者がはしごの申告を偽装できる。ノードも WebSocket で HMAC を通す。
    const nodeHello = parseNodeHello(message);
    if (nodeHello.ok) {
      await this.authenticateNode(nodeHello.value.role, nodeHello.value.authTag, sender);
      return;
    }

    if (!this.authenticated.has(sender.id) && !isNodeAuthenticated(this.gate, sender.id)) {
      if (this.authenticating.has(sender.id)) {
        return;
      }
      this.authenticating.add(sender.id);
      await this.handleHello(message, sender);
      this.authenticating.delete(sender.id);
      return;
    }

    // 心拍を受けたら `meta` への接続を確かめる。
    // **接続はここ（`onMessage` の文脈）でしか張れない**（`onAlarm` は `context.parties` に
    // 触れられない）。かつ背後で進めるには入力が続く必要がある（F-046）。
    if (isHeartbeat(message)) {
      // **応える**（規範 1 節の `HEARTBEAT_TIMEOUT_MS`）。応えないとクライアントは切れたことを
      // 知る手立てを持たない（`close` の事象が来ない切れ方が実際にある。段 E の実測）。
      sender.send(JSON.stringify({ t: "heartbeatAck" }));
      // 名簿を取り直す。他の参加者の出入りはここで反映される（低頻度の情報である）。
      await this.callMeta(JSON.stringify({ t: "poll" }));
      return;
    }

    // 認証済みの接続からの通知を集約する。未知の `t` は無視する。
    const catalogUpdate = parseCatalogUpdate(message);
    if (catalogUpdate !== null) {
      // はしごが変わったら会議全体へ配る。受信ノードはこれで費用と段を決める（ADR-0027）。
      this.state = recordCatalogEntry(this.state, catalogUpdate);
      this.room.broadcast(streamCatalogMessage(this.state));
      return;
    }
    const parsed = parseStatus(message);
    if (parsed !== null) {
      this.state = recordNodeStatus(this.state, parsed);
      // 過負荷が続くならシャードの追加が必要である（congestion.md 7 節）。
      // 判断は純関数に置き、ここでは通知だけを行う。
      if (needsResharding(this.state)) {
        this.room.broadcast(JSON.stringify({ t: "warning", code: "W_SHARD_PRESSURE" }));
      }
      return;
    }
    // 媒体の状態（カメラ・マイク）を会議全体へ配る。参加者一覧の表示に使う。
    const mediaState = parseMediaState(message);
    const userId = this.authenticated.get(sender.id);
    if (mediaState !== null && userId !== undefined) {
      this.room.broadcast(
        JSON.stringify({ t: "mediaState", userId, kind: mediaState.kind, enabled: mediaState.enabled }),
      );
    }
  }

  /**
   * `meta` 部屋へ自分の利用者を登録し、会議全体の名簿を受け取る。
   *
   * **要求応答（HTTP）で行う。** ノード間の WebSocket は握手が相手の応答を必要とするため、
   * `onMessage` の中で待つと入力ゲートが閉じたまま完了せず、待たずに背後で進めると
   * 入力の無い部屋では停止して中断される（F-046）。名簿は join / leave のときだけ動く
   * 低頻度の情報であり、要求応答で確実に扱う。
   *
   * 認証は `nodeHello` と同じ HMAC を頭部で送る。認証の無い経路を開けてはならない。
   */
  private async callMeta(body: string): Promise<void> {
    const meetingId = meetingIdFromRoom(this.room.id);
    const nodeKey = this.room.env["WHESO_NODE_KEY"];
    if (meetingId === null || typeof nodeKey !== "string" || nodeKey.length === 0) {
      return;
    }
    const namespace = this.room.context.parties["meta"];
    if (namespace === undefined) {
      return;
    }
    const room = `meta-${meetingId}`;
    const hello = await buildNodeHello(nodeKey, meetingId, room, "coordinator", Date.now(), this.room.id);
    if (!hello.ok) {
      return;
    }
    const parsed = parseNodeHello(hello.value);
    if (!parsed.ok) {
      return;
    }
    let response: Response;
    try {
      response = await namespace.get(room).fetch({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-wheso-node-role": parsed.value.role,
          "x-wheso-node-auth": parsed.value.authTag,
        },
        body,
      });
    } catch {
      // 名簿の更新に失敗した。心拍で再試行する。
      return;
    }
    if (response.status !== 200) {
      return;
    }
    const text = await response.text();
    const withDirectory = recordDirectory(this.state, text);
    if (withDirectory === null) {
      return;
    }
    this.state = withDirectory;
    this.room.broadcast(participantsMessage(this.state));
  }

  /** `nodeHello` の HMAC を検証する。通ればノードとして扱う。 */
  private async authenticateNode(role: string, authTag: string, sender: Party.Connection): Promise<void> {
    const nodeKey = this.room.env["WHESO_NODE_KEY"];
    if (typeof nodeKey !== "string" || nodeKey.length === 0) {
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
      sender.close(verified.error.closeCode, verified.error.code);
      return;
    }
    this.gate = markNodeAuthenticated(this.gate, sender.id, parsed.value.role);
    sender.send(buildNodeHelloAck(this.room.id));
  }

  onAlarm(): void {
    const now = Date.now();
    // 猶予を過ぎた未認証の接続を閉じる。ノードとして認証されたものは残す。
    // **経過は接続ごとに見る**（アラームの刻みは猶予ではない）。
    for (const connection of this.room.getConnections()) {
      if (this.authenticated.has(connection.id) || isNodeAuthenticated(this.gate, connection.id)) {
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
  }

  /**
   * `hello` を処理する。
   *
   * **例外で中断させない。** 実行環境の呼び出し（`room.id` など）は初期化前に例外を投げる
   * ことがある（F-050）。例外が伝播すると接続は閉じコードなしで切られ（1006）、
   * クライアントは「認証に失敗した」のか「落ちた」のか区別できない。**実測で 1006 が
   * 出た**（F-057）。捕らえて規範のコードで閉じ、理由に内容を載せる。
   */
  private async handleHello(message: string, sender: Party.Connection): Promise<void> {
    try {
      await this.handleHelloInner(message, sender);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      // 閉じる理由は 123 バイト以内でなければ閉じフレームが不正になる。
      sender.close(ERROR_DEFINITIONS.E_AUTH.closeCode, `internal: ${detail}`.slice(0, 100));
    }
  }

  private async handleHelloInner(message: string, sender: Party.Connection): Promise<void> {
    const hello = parseHello(message);
    if (!hello.ok) {
      sender.close(hello.error.closeCode, hello.error.code);
      return;
    }
    const keyText = this.room.env["WHESO_TOKEN_KEY"];
    if (typeof keyText !== "string" || keyText.length === 0) {
      // 鍵が無い環境では認証できない。開いたままにしない。
      sender.close(ERROR_DEFINITIONS.E_AUTH.closeCode, "key missing");
      return;
    }
    const meetingId = meetingIdFromRoom(this.room.id);
    if (meetingId === null) {
      sender.close(ERROR_DEFINITIONS.E_NAME_MEETING_ID.closeCode, "E_NAME_MEETING_ID");
      return;
    }
    const result = await authorize({
      keyBytes: new TextEncoder().encode(keyText),
      token: hello.value.token,
      meetingId,
      roomName: this.room.id,
      nowSec: Math.trunc(Date.now() / 1000),
    });
    if (!result.ok) {
      sender.close(result.error.closeCode, result.error.code);
      return;
    }
    this.authenticated.set(sender.id, result.value.userId);
    this.state = addParticipant(this.state, {
      userId: result.value.userId,
      senderId: hello.value.senderId,
      role: result.value.role,
    });
    sender.send(helloAck(hello.value.senderId, Date.now()));
    // 自分の分だけは即座に配る（`meta` の応答を待たずに自分が見える）。
    this.room.broadcast(participantsMessage(this.state));
    // 会議全体の名簿へ登録する。**これが無いと他の参加者から見えない。**
    // 会議全体の名簿へ登録し、現在の名簿を受け取る（要求応答。F-046）。
    await this.callMeta(
      JSON.stringify({
        t: "register",
        userId: result.value.userId,
        senderId: hello.value.senderId,
        role: result.value.role,
      }),
    );
    // 人数と epoch の判断はコアが行う（`meta-core`）。参加を数える。
    await this.callMeta(JSON.stringify({ t: "join", id: hello.value.senderId }));
  }
}

/** `ctl-<会議 ID>-<利用者 ID>` から会議 ID を取り出す。 */
function meetingIdFromRoom(roomId: string): string | null {
  const parts = roomId.split("-");
  const role = parts[0];
  const meetingId = parts[1];
  if (role !== "ctl" || meetingId === undefined) {
    return null;
  }
  return meetingId;
}

/** 心拍かどうか。ノードを起こし続けるために使う（timeouts の規範）。 */
function isHeartbeat(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const record: Record<string, unknown> = { ...value };
    return record["t"] === "heartbeat";
  } catch {
    return false;
  }
}

/** ノードからの状態通知のコードを取り出す。未知の形式は null。 */
function parseStatus(text: string): number | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const record: Record<string, unknown> = { ...value };
    if (record["t"] !== "nodeStatus") {
      return null;
    }
    const code = record["code"];
    return typeof code === "number" && Number.isInteger(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * 媒体の状態（カメラ・マイク）を取り出す。未知の形式は null。
 *
 * 会議全体へ配る理由は、参加者一覧に消音と映像の停止を出すためである
 * （product-requirements.md の権限表）。配らないと他の参加者の状態が永久に既定値のままになる。
 */
function parseMediaState(text: string): { readonly kind: "camera" | "microphone"; readonly enabled: boolean } | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const record: Record<string, unknown> = { ...value };
    if (record["t"] !== "mediaState") {
      return null;
    }
    const kind = record["kind"];
    const enabled = record["enabled"];
    if ((kind !== "camera" && kind !== "microphone") || typeof enabled !== "boolean") {
      return null;
    }
    return { kind, enabled };
  } catch {
    return null;
  }
}

export default ControlNode;
