/**
 * 受信ノード（receiver）の伝送層アダプタ。
 *
 * 責務は 3 つに限る。判断は持たない（判断は receiver-core.ts）。
 *   1. 受信したバイト列とテキストを入力イベントへ翻訳する
 *   2. 判断コアへ渡す
 *   3. 出力コマンドを、クライアントへの送信と上流（中継ノード）への制御送信へ写す
 *
 * 時刻は呼び出し側から受け取る。ここでは取得しない（lint-policy.md 9 節）。
 */

import {
  initialReceiverState,
  receiverStep,
  RECEIVER_SELF_ID,
  type ReceiverCommand,
  type ReceiverEvent,
  type ReceiverState,
  type SubscribeEntry,
} from "@wheso/core/src/receiver-core.ts";
import { decodeMediaMessage, wireErrorCloseCode } from "@wheso/core/src/wire.ts";
import {
  admit,
  admitKeyframeRequest,
  initialRateWindow,
  type KeyframeMark,
  type RateWindow,
} from "@wheso/core/src/rate-limit.ts";
import {
  DELAY_TREND_WINDOW,
  MAX_INBOUND_MESSAGES_PER_SEC_PER_CLIENT,
} from "@wheso/core/src/generated/constants.ts";
import { ERROR_DEFINITIONS } from "@wheso/core/src/generated/errors.ts";

/** 受信メッセージレートの窓の長さ。1 秒あたりの件数で規定されている（auth.md 5 節）。 */
const INBOUND_WINDOW_MS = 1000;

/** 送信の口。実装は Durable Object 側が与える。試験では偽物を渡す。 */
export interface ReceiverTransport {
  /** 受信者クライアントへメディアを送る。 */
  sendToClient(bytes: Uint8Array): void;
  /** 受信者クライアントへ制御メッセージを送る。 */
  sendTextToClient(text: string): void;
  /** 上流（中継ノード）へ制御メッセージを送る。 */
  sendUpstream(text: string): void;
  /** クライアント接続を閉じる。 */
  closeClient(code: number, reason: string): void;
}

export interface ReceiverHandlerState {
  readonly core: ReceiverState;
  /**
   * キーフレーム要求を通した時刻の記録。
   * 同一 (senderId, channel, spatialId) への要求を規定間隔内に 2 回送らない（wire-format.md 2.5）。
   * 時刻を扱うためコアではなくこの層に置く（lint-policy.md 9.2）。
   */
  readonly keyframeMarks: readonly KeyframeMark[];
  /** クライアント接続からの受信メッセージ数の窓（auth.md 5 節）。 */
  readonly inbound: RateWindow;
}

export function createReceiverHandlerState(targetBytesPerSec: number, nowMs: number): ReceiverHandlerState {
  return { core: initialReceiverState(targetBytesPerSec), keyframeMarks: [], inbound: initialRateWindow(nowMs) };
}

/**
 * 上流から届いたメディアを処理する。
 *
 * 転送はメッセージ単位で行う。ユニット単位に分解すると受信側の順序と
 * ヘッダの整合が壊れる（wire-format.md 1 節）。
 */
export function handleUpstreamBinary(
  state: ReceiverHandlerState,
  bytes: Uint8Array,
  nowMs: number,
  transport: ReceiverTransport,
): ReceiverHandlerState {
  const decoded = decodeMediaMessage(bytes);
  if (!decoded.ok) {
    // 上流からの形式違反は自分のクライアント接続を閉じる理由にならないため、
    // 破棄して記録に留める。閉じるのは自分が送った側の場合である。
    return state;
  }

  let next = state;
  let forwarded = false;
  for (const unit of decoded.value.units) {
    const event: ReceiverEvent = {
      kind: "media",
      from: decoded.value.senderId,
      ch: decoded.value.channel,
      sid: unit.spatialId,
      tid: unit.temporalId,
      key: (unit.flags & 0x01) !== 0,
      bytes: unit.payload.length,
      flags: unit.flags,
      seq: unit.sequenceNumber,
    };
    const result = receiverStep(next.core, event);
    const rest: ReceiverCommand[] = [];
    for (const command of result.commands) {
      if (command.kind === "forward") {
        if (!forwarded && command.to.includes(RECEIVER_SELF_ID)) {
          forwarded = true;
          transport.sendToClient(bytes);
        }
        continue;
      }
      rest.push(command);
    }
    next = applyCommands({ ...next, core: result.state }, rest, nowMs, transport);
  }
  return next;
}

/**
 * クライアントから届いた制御メッセージを処理する。
 *
 * 未知の `t` は無視する（wire-format.md 2 節）。接続は閉じない。
 */
export function handleClientText(
  state: ReceiverHandlerState,
  text: string,
  nowMs: number,
  transport: ReceiverTransport,
): ReceiverHandlerState {
  const limited = countInbound(state, nowMs, transport);
  if (limited.exceeded) {
    return limited.state;
  }
  const parsed = parseObject(text);
  if (parsed === null) {
    return limited.state;
  }
  let next = limited.state;
  for (const event of toReceiverEvents(parsed)) {
    const result = receiverStep(next.core, event);
    next = applyCommands({ ...next, core: result.state }, result.commands, nowMs, transport);
  }
  return next;
}

/**
 * ACK_INTERVAL_MS の周期で呼ばれ、受信済みの位置を ack として上流へ返す。
 * 周期の管理は入口（Durable Object）が行う。コアは時刻を持たない。
 */
export function handleAckTimer(
  state: ReceiverHandlerState,
  nowMs: number,
  transport: ReceiverTransport,
): ReceiverHandlerState {
  const result = receiverStep(state.core, { kind: "timer" });
  return applyCommands({ ...state, core: result.state }, result.commands, nowMs, transport);
}

/** 送信者の退出を入力イベントへ翻訳する。 */
export function handleSenderLeave(
  state: ReceiverHandlerState,
  senderId: number,
  nowMs: number,
  transport: ReceiverTransport,
): ReceiverHandlerState {
  const result = receiverStep(state.core, { kind: "leave", id: senderId });
  return applyCommands({ ...state, core: result.state }, result.commands, nowMs, transport);
}

/** 形式違反のメディアをクライアントから受けた場合は接続を閉じる。 */
export function handleClientBinary(
  state: ReceiverHandlerState,
  bytes: Uint8Array,
  nowMs: number,
  transport: ReceiverTransport,
): ReceiverHandlerState {
  const limited = countInbound(state, nowMs, transport);
  if (limited.exceeded) {
    return limited.state;
  }
  const decoded = decodeMediaMessage(bytes);
  if (!decoded.ok) {
    transport.closeClient(wireErrorCloseCode(decoded.error.code), decoded.error.code);
  }
  // 受信ノードはクライアントからのメディアを扱わない。送信は送信ノードの責務である。
  return limited.state;
}

/**
 * クライアント接続からの受信を 1 件計上する。
 * 上限を超えた接続は閉じる（auth.md 5 節、E_RATE_LIMIT_MESSAGES）。
 * 上流（ノード間）からの受信は数えない。濫用対策は利用者の接続に対する防御である。
 */
function countInbound(
  state: ReceiverHandlerState,
  nowMs: number,
  transport: ReceiverTransport,
): { readonly state: ReceiverHandlerState; readonly exceeded: boolean } {
  const decision = admit(state.inbound, nowMs, INBOUND_WINDOW_MS, MAX_INBOUND_MESSAGES_PER_SEC_PER_CLIENT);
  const next: ReceiverHandlerState = { ...state, inbound: decision.window };
  if (decision.allowed) {
    return { state: next, exceeded: false };
  }
  transport.closeClient(ERROR_DEFINITIONS.E_RATE_LIMIT_MESSAGES.closeCode, "E_RATE_LIMIT_MESSAGES");
  return { state: next, exceeded: true };
}

/**
 * 出力コマンドを実行する。keyframeRequest のみ間隔制限を通す（wire-format.md 2.5）。
 * 抑制した要求は送らず、記録も更新しない（次の要求は前回の通過時刻から計る）。
 */
function applyCommands(
  state: ReceiverHandlerState,
  commands: readonly ReceiverCommand[],
  nowMs: number,
  transport: ReceiverTransport,
): ReceiverHandlerState {
  let marks = state.keyframeMarks;
  for (const command of commands) {
    if (command.kind === "keyframeRequest") {
      const decision = admitKeyframeRequest(
        marks,
        { senderId: command.for, channel: command.channel, spatialId: command.spatialId },
        nowMs,
      );
      marks = decision.marks;
      if (!decision.allowed) {
        continue;
      }
      transport.sendUpstream(
        JSON.stringify({
          t: "keyframeRequest",
          senderId: command.for,
          channel: command.channel,
          spatialId: command.spatialId,
        }),
      );
      continue;
    }
    applyCommand(command, transport);
  }
  return { ...state, keyframeMarks: marks };
}

/** 出力コマンドを実際の送信へ写す。 */
function applyCommand(command: ReceiverCommand, transport: ReceiverTransport): void {
  switch (command.kind) {
    case "subscribeChange":
      // 上流へ購読の変更を伝える。entries 形式は wire-format.md 2.4 に従う。
      transport.sendUpstream(
        JSON.stringify({
          t: "subscribe",
          entries: command.want
            ? [
                {
                  senderId: command.to,
                  channel: command.channel,
                  maxSpatialId: command.maxSpatialId,
                  maxTemporalId: command.maxTemporalId,
                },
              ]
            : [],
        }),
      );
      return;
    case "keyframeRequest":
      // 間隔制限を通す必要があるため applyCommands が扱う。ここへは到達しない。
      return;
    case "setTier":
      // tier の変更は上流への購読更新として伝える。クライアントへは通知しない。
      transport.sendUpstream(
        JSON.stringify({
          t: "subscribe",
          entries: [
            {
              senderId: command.for,
              channel: command.channel,
              maxSpatialId: command.tier,
              maxTemporalId: 7,
            },
          ],
        }),
      );
      return;
    case "notify":
      transport.sendTextToClient(JSON.stringify({ t: "warning", code: command.code }));
      return;
    case "ack":
      // ack は制御リンクで上流へ返す。媒体リンクが詰まると ack が届かず
      // 送信窓が閉じたまま復帰できないためである（wire-format.md 2.5.1）。
      transport.sendUpstream(
        JSON.stringify({
          t: "ack",
          senderId: command.senderId,
          channel: command.channel,
          spatialId: command.spatialId,
          highestSeq: command.highestSeq,
        }),
      );
      return;
    case "drop":
      // 破棄は送らないことで表現される。
      return;
    case "forward":
      // forward は呼び出し側が扱う。
      return;
  }
}

/** JSON オブジェクトとして解析する。失敗しても例外を投げない。 */
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

/** クライアントの制御メッセージを入力イベント列へ翻訳する。 */
function toReceiverEvents(message: Record<string, unknown>): readonly ReceiverEvent[] {
  const t = message["t"];
  if (t === "subscribe") {
    const entries = message["entries"];
    if (!Array.isArray(entries)) {
      return [];
    }
    const parsed: SubscribeEntry[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const record: Record<string, unknown> = { ...entry };
      const senderId = record["senderId"];
      const channel = record["channel"];
      const maxSpatialId = record["maxSpatialId"];
      const maxTemporalId = record["maxTemporalId"];
      if (
        !isInteger(senderId) ||
        !isInteger(channel) ||
        !isInteger(maxSpatialId) ||
        !isInteger(maxTemporalId)
      ) {
        continue;
      }
      parsed.push({ senderId, channel, maxSpatialId, maxTemporalId });
    }
    return [{ kind: "subscribe", entries: parsed }];
  }
  if (t === "report") {
    const samples = message["arrivalDelaySamplesUs"];
    const downlink = message["downlinkBps"];
    const events: ReceiverEvent[] = [];
    if (Array.isArray(samples)) {
      const delayUs: number[] = [];
      for (const sample of samples) {
        if (isInteger(sample)) {
          delayUs.push(sample);
        }
      }
      const trimmed =
        delayUs.length > DELAY_TREND_WINDOW ? delayUs.slice(delayUs.length - DELAY_TREND_WINDOW) : delayUs;
      events.push({ kind: "report", delayUs: trimmed });
    }
    if (isInteger(downlink) && downlink > 0) {
      // bits/sec を bytes/sec に直す。整数除算で切り捨てる。
      events.push({ kind: "budget", bytesPerSec: Math.trunc(downlink / 8) });
    }
    return events;
  }
  if (t === "displaySize") {
    const senderId = message["senderId"];
    const channel = message["channel"];
    const width = message["width"];
    if (!isInteger(senderId) || !isInteger(channel) || !isInteger(width)) {
      return [];
    }
    return [{ kind: "displaySize", senderId, channel, width }];
  }
  if (t === "visibility") {
    const visible = message["visible"];
    if (typeof visible !== "boolean") {
      return [];
    }
    return [{ kind: "visibility", visible }];
  }
  if (t === "activeSpeaker") {
    const id = message["id"];
    if (id === null) {
      return [{ kind: "activeSpeaker", id: null }];
    }
    if (!isInteger(id)) {
      return [];
    }
    return [{ kind: "activeSpeaker", id }];
  }
  // 未知の t は無視する。
  return [];
}

/** 有限の整数であることを実行時に検査する（wire-format.md 2 節）。 */
function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}
