/**
 * 送信ノード（sender）の伝送層アダプタ。
 *
 * 判断は持たない（判断は sender-core.ts）。責務は 3 つに限る。
 *   1. クライアントのメディアと制御メッセージを入力イベントへ翻訳する
 *   2. 判断コアへ渡す
 *   3. 出力コマンドを、割当先シャードへの送信と接続操作へ写す
 */

import {
  initialSenderState,
  senderStep,
  SHARD_PEER_CURRENT,
  SHARD_PEER_NEXT,
  type SenderCommand,
  type SenderEvent,
  type SenderState,
} from "@wheso/core/src/sender-core.ts";
import { decodeMediaMessage, wireErrorCloseCode } from "@wheso/core/src/wire.ts";
import {
  admit,
  admitKeyframeRequest,
  initialRateWindow,
  type KeyframeMark,
  type RateWindow,
} from "@wheso/core/src/rate-limit.ts";
import { MAX_INBOUND_MESSAGES_PER_SEC_PER_CLIENT } from "@wheso/core/src/generated/constants.ts";
import { ERROR_DEFINITIONS } from "@wheso/core/src/generated/errors.ts";

/** 受信メッセージレートの窓の長さ。1 秒あたりの件数で規定されている（auth.md 5 節）。 */
const INBOUND_WINDOW_MS = 1000;

/** 送信の口。実装は Durable Object 側が与える。 */
export interface SenderTransport {
  /**
   * 渡さなかったことを記録する（観測のため。判断には使わない）。
   *
   * **これが無いと「送ったのに届かない」の原因が分からない。** 実測では送信ノードが
   * 52 件の入力のうち 43 件を渡さなかったが、計数が無いため窓なのか層の選択なのかを
   * 外から区別できなかった（F-064）。
   */
  noteDrop(priority: number): void;
  /** 割当先シャードへメディアを送る。peer は現行（1）か次期（2）である。 */
  sendToShard(peer: number, bytes: Uint8Array): void;
  /** 割当先シャードへ制御メッセージを送る。 */
  sendTextToShard(peer: number, text: string): void;
  /**
   * 送信側クライアントへ制御メッセージを送る。
   * キーフレーム要求（wire-format.md 2.5）とエンコーダ指令（2.7）の宛先はクライアントである。
   */
  sendTextToClient(text: string): void;
  /** シャードへの接続を開く。 */
  connectShard(peer: number): void;
  /** シャードへの接続を閉じる。 */
  disconnectShard(peer: number): void;
  /** クライアント接続を閉じる。 */
  closeClient(code: number, reason: string): void;
  /** 制御系へ報告する。 */
  notifyControl(code: string): void;
  /**
   * 制御系（`ctl` 部屋）へ本文をそのまま送る。
   * はしごの申告を会議全体へ配るために使う（ADR-0027 の 1）。
   */
  sendTextToControl(text: string): void;
  /** 指定時刻に timer イベントを起こすよう要求する。 */
  scheduleAt(atMs: number): void;
}

export interface SenderHandlerState {
  readonly core: SenderState;
  /**
   * クライアントへ通したキーフレーム要求の記録。
   * 上流から届いた要求のうち、規定間隔内の重複は無視する（wire-format.md 2.5）。
   */
  readonly keyframeMarks: readonly KeyframeMark[];
  /** クライアント接続からの受信メッセージ数の窓（auth.md 5 節）。 */
  readonly inbound: RateWindow;
  /**
   * このノードが担当する送信者のワイヤ上の ID。
   *
   * `hello` で受け取った値である（wire-format.md 2.1）。**0 を書いてはならない。**
   * 以前は `streamCatalogUpdate` に 0 を直書きしていたため、`ctl` が集約するはしごが
   * 全送信者で 1 件に潰れ、受信ノードは誰のはしごも引けなかった。
   */
  readonly senderId: number;
}

export function createSenderHandlerState(epoch: number, nowMs: number): SenderHandlerState {
  return { core: initialSenderState(epoch), keyframeMarks: [], inbound: initialRateWindow(nowMs), senderId: 0 };
}

/** `hello` を通したときに担当する送信者 ID を記録する。 */
export function noteSenderId(state: SenderHandlerState, senderId: number): SenderHandlerState {
  return { ...state, senderId };
}

/**
 * クライアントから届いたメディアを処理する。
 *
 * 形式違反はクライアント接続を閉じる（wire-format.md 0 節）。
 * 転送はメッセージ単位で行う。
 */
export function handleClientMedia(
  state: SenderHandlerState,
  bytes: Uint8Array,
  nowMs: number,
  transport: SenderTransport,
): SenderHandlerState {
  const limited = countInbound(state, nowMs, transport);
  if (limited.exceeded) {
    return limited.state;
  }
  const decoded = decodeMediaMessage(bytes);
  if (!decoded.ok) {
    transport.closeClient(wireErrorCloseCode(decoded.error.code), decoded.error.code);
    return limited.state;
  }

  let core = limited.state.core;
  let sent = false;
  for (const unit of decoded.value.units) {
    const event: SenderEvent = {
      kind: "media",
      ch: decoded.value.channel,
      sid: unit.spatialId,
      tid: unit.temporalId,
      seq: unit.sequenceNumber,
      bytes: unit.payload.length,
      flags: unit.flags,
    };
    const result = senderStep(core, event, nowMs);
    core = result.state;
    for (const command of result.commands) {
      if (command.kind === "forward") {
        if (!sent) {
          sent = true;
          for (const peer of command.to) {
            transport.sendToShard(peer, bytes);
          }
        }
        continue;
      }
      applyCommand(command, transport);
    }
  }
  return { ...limited.state, core };
}

/** クライアントの制御メッセージを処理する。未知の `t` は無視する。 */
export function handleClientText(
  state: SenderHandlerState,
  text: string,
  nowMs: number,
  transport: SenderTransport,
): SenderHandlerState {
  const limited = countInbound(state, nowMs, transport);
  if (limited.exceeded) {
    return limited.state;
  }
  // はしごの申告は 3 箇所が必要とする。
  //   1. 送信ノード自身（送信窓の fps。congestion.md 2 節）
  //   2. 中継ノード（渡す段を 1 つ選ぶ。ADR-0027 の 3）
  //   3. `ctl` 部屋（会議全体へ配り、受信ノードが費用と段を決める。ADR-0027 の 1）
  // 1 箇所でも欠けると、段の選択か費用の見積りが実体と合わなくなる。
  relayAnnounce(text, limited.state.senderId, transport);
  return stepText(limited.state, text, nowMs, transport);
}

/** `streamAnnounce` を中継ノードと `ctl` 部屋へ写す。判断は行わない。 */
function relayAnnounce(text: string, senderId: number, transport: SenderTransport): void {
  const message = parseObject(text);
  if (message === null || message["t"] !== "streamAnnounce") {
    return;
  }
  const streams = message["streams"];
  if (!Array.isArray(streams)) {
    return;
  }
  // 中継ノードへはそのまま渡す（形式は wire-format.md 2.3 のまま）。
  transport.sendTextToShard(SHARD_PEER_CURRENT, text);

  // `ctl` へはチャネルごとに 1 通にまとめて渡す。カタログの単位が (senderId, channel) である。
  const byChannel = new Map<number, Record<string, unknown>[]>();
  for (const stream of streams) {
    if (typeof stream !== "object" || stream === null) {
      continue;
    }
    const record: Record<string, unknown> = { ...stream };
    const channel = record["channel"];
    if (!isInteger(channel)) {
      continue;
    }
    const existing = byChannel.get(channel);
    if (existing === undefined) {
      byChannel.set(channel, [record]);
      continue;
    }
    existing.push(record);
  }
  for (const channel of [...byChannel.keys()].sort((a, b) => a - b)) {
    const rungs = byChannel.get(channel);
    if (rungs === undefined) {
      continue;
    }
    transport.sendTextToControl(
      JSON.stringify({
        t: "streamCatalogUpdate",
        // 送信者 ID はワイヤの senderId であり、`ctl` が hello で受け取った値と一致する。
        senderId,
        channel,
        rungs: rungs.map((rung) => ({
          spatialId: rung["spatialId"],
          width: rung["width"],
          height: rung["height"],
          framerate: rung["framerate"],
          temporalLayers: rung["temporalLayers"],
          targetBitrate: rung["targetBitrate"],
        })),
      }),
    );
  }
}

/**
 * 上流（シャードや制御系）からのメッセージを処理する。
 *
 * ack と epochChange はコアへ渡す。keyframeRequest と encoderDirective は
 * 送信側クライアントが宛先であるため中継する。中継は判断ではない。
 * キーフレーム要求は規定間隔内の重複を無視する（wire-format.md 2.5）。
 */
export function handleUpstreamText(
  state: SenderHandlerState,
  text: string,
  nowMs: number,
  transport: SenderTransport,
): SenderHandlerState {
  const message = parseObject(text);
  if (message === null) {
    return state;
  }
  const t = message["t"];
  if (t === "keyframeRequest") {
    const senderId = message["senderId"];
    const channel = message["channel"];
    const spatialId = message["spatialId"];
    if (!isInteger(senderId) || !isInteger(channel) || !isInteger(spatialId)) {
      return state;
    }
    const decision = admitKeyframeRequest(state.keyframeMarks, { senderId, channel, spatialId }, nowMs);
    if (!decision.allowed) {
      // 超過分は無視する。無視した事実は記録の対象であり、接続は閉じない。
      return { ...state, keyframeMarks: decision.marks };
    }
    transport.sendTextToClient(JSON.stringify({ t: "keyframeRequest", senderId, channel, spatialId }));
    return { ...state, keyframeMarks: decision.marks };
  }
  if (t === "encoderDirective") {
    // 指令の内容は中継元（中継ノード）が決める。ここでは形を変えずに渡す。
    transport.sendTextToClient(text);
    return state;
  }
  return stepText(state, text, nowMs, transport);
}

/** 制御メッセージをコアへ渡し、出力コマンドを実行する。 */
function stepText(
  state: SenderHandlerState,
  text: string,
  nowMs: number,
  transport: SenderTransport,
): SenderHandlerState {
  const message = parseObject(text);
  if (message === null) {
    return state;
  }
  let core = state.core;
  for (const event of toSenderEvents(message)) {
    const result = senderStep(core, event, nowMs);
    core = result.state;
    for (const command of result.commands) {
      applyCommand(command, transport);
    }
  }
  return { ...state, core };
}

/**
 * クライアント接続からの受信を 1 件計上する。
 * 上限を超えた接続は閉じる（auth.md 5 節、E_RATE_LIMIT_MESSAGES）。
 */
function countInbound(
  state: SenderHandlerState,
  nowMs: number,
  transport: SenderTransport,
): { readonly state: SenderHandlerState; readonly exceeded: boolean } {
  const decision = admit(state.inbound, nowMs, INBOUND_WINDOW_MS, MAX_INBOUND_MESSAGES_PER_SEC_PER_CLIENT);
  const next: SenderHandlerState = { ...state, inbound: decision.window };
  if (decision.allowed) {
    return { state: next, exceeded: false };
  }
  transport.closeClient(ERROR_DEFINITIONS.E_RATE_LIMIT_MESSAGES.closeCode, "E_RATE_LIMIT_MESSAGES");
  return { state: next, exceeded: true };
}

/** 新 epoch のシャードから最初のフレームが届いたことを伝える。 */
export function handleNewEpochFrame(
  state: SenderHandlerState,
  nowMs: number,
  transport: SenderTransport,
): SenderHandlerState {
  const result = senderStep(state.core, { kind: "newEpochFrame" }, nowMs);
  for (const command of result.commands) {
    applyCommand(command, transport);
  }
  return { ...state, core: result.state };
}

/** 旧接続の残量を伝える。0 になったら旧接続を閉じる判断が下る。 */
export function handleStaleBacklog(
  state: SenderHandlerState,
  bytes: number,
  nowMs: number,
  transport: SenderTransport,
): SenderHandlerState {
  const result = senderStep(state.core, { kind: "staleBacklog", bytes }, nowMs);
  for (const command of result.commands) {
    applyCommand(command, transport);
  }
  return { ...state, core: result.state };
}

/** タイマー満了。二重購読の時限を判定する。 */
export function handleTimer(
  state: SenderHandlerState,
  nowMs: number,
  transport: SenderTransport,
): SenderHandlerState {
  const result = senderStep(state.core, { kind: "timer" }, nowMs);
  for (const command of result.commands) {
    applyCommand(command, transport);
  }
  return { ...state, core: result.state };
}

function applyCommand(command: SenderCommand, transport: SenderTransport): void {
  switch (command.kind) {
    case "forward":
      // forward は呼び出し側が扱う。
      return;
    case "drop":
      // 渡さないことで表現される。理由の内訳は優先順位で観測する。
      transport.noteDrop(command.priority);
      return;
    case "connect":
      transport.connectShard(command.peer);
      return;
    case "disconnect":
      transport.disconnectShard(command.peer);
      return;
    case "unsubscribeStale":
      // 旧接続の購読を解除する。宛先は現行の接続である。
      transport.sendTextToShard(SHARD_PEER_CURRENT, JSON.stringify({ t: "subscribe", entries: [] }));
      return;
    case "notify":
      transport.notifyControl(command.code);
      return;
    case "keyframeRequest":
      // **自分の取得側へ要求する**（規範 1.4）。送信窓で順位 4・5 を落としたら、次の KEY まで
      // 落とし続ける。要求しなければ、復号器は次の自然なキーフレームまで何も出せない
      // （実測: 復号器が 428 件受け取って 204 枚しか出さず `Decoding error` を記録した）。
      transport.sendTextToClient(
        JSON.stringify({ t: "keyframeRequest", channel: command.channel, spatialId: command.spatialId }),
      );
      return;
    case "schedule":
      transport.scheduleAt(command.at);
      return;
  }
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    return { ...value };
  } catch {
    return null;
  }
}

/** 制御メッセージを入力イベント列へ翻訳する。 */
function toSenderEvents(message: Record<string, unknown>): readonly SenderEvent[] {
  const t = message["t"];
  if (t === "ack") {
    const ch = message["channel"];
    const sid = message["spatialId"];
    const highestSeq = message["highestSeq"];
    if (!isInteger(ch) || !isInteger(sid) || !isInteger(highestSeq)) {
      return [];
    }
    return [{ kind: "ack", ch, sid, highestSeq }];
  }
  if (t === "streamAnnounce") {
    const streams = message["streams"];
    if (!Array.isArray(streams)) {
      return [];
    }
    const events: SenderEvent[] = [];
    for (const stream of streams) {
      if (typeof stream !== "object" || stream === null) {
        continue;
      }
      const record: Record<string, unknown> = { ...stream };
      const ch = record["channel"];
      const framerate = record["framerate"];
      // spatialId は宣言に含まれない場合があるため、既定は最上位でなく 0 とする。
      const sid = record["spatialId"];
      if (!isInteger(ch) || !isInteger(framerate)) {
        continue;
      }
      events.push({ kind: "streamAnnounce", ch, sid: isInteger(sid) ? sid : 0, framerate });
    }
    return events;
  }
  if (t === "epochChange") {
    const epoch = message["epoch"];
    const assignmentChanged = message["assignmentChanged"];
    if (!isInteger(epoch) || typeof assignmentChanged !== "boolean") {
      return [];
    }
    return [{ kind: "epochChange", epoch, assignmentChanged }];
  }
  return [];
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

/** 次期 epoch の接続を表す識別子。入口が接続の対応付けに使う。 */
export const SENDER_PEERS = { current: SHARD_PEER_CURRENT, next: SHARD_PEER_NEXT } as const;
