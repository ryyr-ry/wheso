/**
 * 中継ノード（shard）の伝送層アダプタ。
 *
 * 責務は 3 つに限る。
 *   1. 受信したバイト列とテキストを入力イベントへ翻訳する
 *   2. 判断コア（shard-core）へ渡す
 *   3. 返ってきた出力コマンドを実際の送信・切断へ写す
 *
 * 判断は一切行わない。判断を書くと 9 言語で一致しなくなる（conformance.md 2 節）。
 * 時刻は呼び出し側から受け取る。ここでも取得しない（lint-policy.md 9 節）。
 */

import {
  initialState,
  step,
  type ShardCommand,
  type ShardEvent,
  type ShardState,
} from "@wheso/core/src/shard-core.ts";
import { decodeMediaMessage, wireErrorCloseCode } from "@wheso/core/src/wire.ts";
import { videoProfileForSpatialId } from "@wheso/core/src/profiles.ts";
import { CHANNEL_VIDEO } from "@wheso/core/src/generated/wire-layout.ts";
import { DELAY_TREND_WINDOW } from "@wheso/core/src/generated/constants.ts";
import { ERROR_DEFINITIONS } from "@wheso/core/src/generated/errors.ts";

/** 送信と切断の口。実装は Durable Object 側が与える。試験では偽物を渡す。 */
export interface ShardTransport {
  /** 参加者 ID へバイナリを送る。接続が無い場合は何もしない。 */
  sendBinary(participantId: number, bytes: Uint8Array): void;
  /** 参加者 ID へテキスト（制御メッセージ）を送る。 */
  sendText(participantId: number, text: string): void;
  /** 接続を閉じる。 */
  close(participantId: number, code: number, reason: string): void;
  /** 制御系（ctl 部屋）へ通知する。 */
  notifyControl(code: number): void;
}

/** 参加者 1 人の接続。 */
export interface ShardPeer {
  readonly participantId: number;
  /** ノード間接続の場合は true。nodeHello の検証済みを意味する。 */
  readonly isNode: boolean;
}

export interface ShardHandlerState {
  readonly core: ShardState;
  /** 直近に転送したバイト列。forward コマンドの実体である。 */
  readonly pendingPayload: Uint8Array | null;
}

/** 初期状態。 */
export function createShardHandlerState(nowMs: number): ShardHandlerState {
  return { core: initialState(nowMs), pendingPayload: null };
}

/**
 * バイナリメッセージ（メディア）を処理する。
 *
 * 1 メッセージに複数のユニットが入るため、ユニットごとに入力イベントを作る。
 * 転送はメッセージ単位で行う。ユニット単位に分解して送り直すと、
 * 受信側の順序保証とヘッダの整合が壊れる。
 */
export function handleBinary(
  state: ShardHandlerState,
  peer: ShardPeer,
  bytes: Uint8Array,
  nowMs: number,
  transport: ShardTransport,
): ShardHandlerState {
  const decoded = decodeMediaMessage(bytes);
  if (!decoded.ok) {
    // 形式違反は接続を閉じる（wire-format.md 0 節の規則 3・4）。
    transport.close(peer.participantId, wireErrorCloseCode(decoded.error.code), decoded.error.code);
    return state;
  }

  let core = state.core;
  let forwardedOnce = false;
  for (const unit of decoded.value.units) {
    const event: ShardEvent = {
      kind: "media",
      from: decoded.value.senderId,
      ch: decoded.value.channel,
      sid: unit.spatialId,
      tid: unit.temporalId,
      key: (unit.flags & 0x01) !== 0,
      bytes: unit.payload.length,
      flags: unit.flags,
    };
    const result = step(core, event, nowMs);
    core = result.state;
    for (const command of result.commands) {
      if (command.kind === "forward" && !forwardedOnce) {
        // 同一メッセージを複数ユニット分だけ重複送信しないため、最初の forward でのみ送る。
        forwardedOnce = true;
        for (const target of command.to) {
          transport.sendBinary(target, bytes);
        }
        continue;
      }
      applyNonForward(command, transport);
    }
  }
  return { ...state, core };
}

/**
 * テキストメッセージ（制御）を処理する。
 *
 * 未知の `t` は無視する（wire-format.md 2 節）。接続は閉じない。前方互換のためである。
 */
export function handleText(
  state: ShardHandlerState,
  peer: ShardPeer,
  text: string,
  nowMs: number,
  transport: ShardTransport,
): ShardHandlerState {
  const parsed = parseJson(text);
  if (parsed === null) {
    return state;
  }
  const events = toEvents(parsed, peer.participantId);
  let core = state.core;
  for (const event of events) {
    const result = step(core, event, nowMs);
    core = result.state;
    for (const command of result.commands) {
      applyNonForward(command, transport);
    }
  }
  return { ...state, core };
}

/** 接続の確立と切断を入力イベントへ翻訳する。 */
export function handleLifecycle(
  state: ShardHandlerState,
  peer: ShardPeer,
  kind: "open" | "close",
  nowMs: number,
  transport: ShardTransport,
): ShardHandlerState {
  const event: ShardEvent =
    kind === "open" ? { kind: "join", id: peer.participantId } : { kind: "leave", id: peer.participantId };
  const result = step(state.core, event, nowMs);
  for (const command of result.commands) {
    applyNonForward(command, transport);
  }
  return { ...state, core: result.state };
}

/** タイマー満了を入力イベントへ翻訳する。回復方向の遷移はこれで起きる。 */
export function handleTimer(
  state: ShardHandlerState,
  nowMs: number,
  transport: ShardTransport,
): ShardHandlerState {
  const result = step(state.core, { kind: "timer" }, nowMs);
  for (const command of result.commands) {
    applyNonForward(command, transport);
  }
  return { ...state, core: result.state };
}

/** forward 以外の出力コマンドを実行する。 */
function applyNonForward(command: ShardCommand, transport: ShardTransport): void {
  switch (command.kind) {
    case "forward":
      // forward は呼び出し側が扱う。ここでは何もしない。
      return;
    case "drop":
      // 破棄は送らないことで表現される。記録は観測系の責務である。
      return;
    case "notify":
      transport.notifyControl(command.code);
      return;
    case "close":
      // close の対象は接続ではなく相手のノードである。code のみを制御系へ伝える。
      transport.notifyControl(command.code);
      return;
    case "keyframeRequest":
      transport.sendText(command.for, JSON.stringify({ t: "keyframeRequest", senderId: command.for }));
      return;
    case "setTier": {
      // エンコーダ指令は規範（ワイヤ形式 2.7）の 5 フィールドをすべて満たす。
      // 値は tier に対応するプロファイルの定数から引く。数値を書かない。
      const profile = videoProfileForSpatialId(command.tier);
      transport.sendText(
        command.for,
        JSON.stringify({
          t: "encoderDirective",
          channel: CHANNEL_VIDEO,
          maxSpatialLayers: command.tier + 1,
          maxTemporalLayers: profile.temporalLayers,
          targetBitrate: profile.targetBitrate,
          // キーフレームは keyframeRequest で個別に要求する（ワイヤ形式 2.5）。
          forceKeyframe: false,
        }),
      );
      return;
    }
    case "connect":
    case "disconnect":
    case "schedule":
      // 上位のノード間接続とタイマーは Durable Object 側が扱う。
      return;
  }
}

/** JSON を解析する。失敗しても例外を投げない。 */
function parseJson(text: string): Record<string, unknown> | null {
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

/**
 * 制御メッセージを入力イベント列へ翻訳する。
 *
 * subscribe は entries ごとに 1 個のイベントになる。
 * report は標本列を整数として渡す（ADR-0021）。
 */
function toEvents(message: Record<string, unknown>, from: number): readonly ShardEvent[] {
  const t = message["t"];
  if (t === "subscribe") {
    const entries = message["entries"];
    if (!Array.isArray(entries)) {
      return [];
    }
    const events: ShardEvent[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const record: Record<string, unknown> = { ...entry };
      const senderId = record["senderId"];
      const maxSpatialId = record["maxSpatialId"];
      if (!isFiniteInteger(senderId) || !isFiniteInteger(maxSpatialId)) {
        continue;
      }
      events.push({ kind: "subscribe", from, to: senderId, want: true, maxSpatialId });
    }
    return events;
  }
  if (t === "report") {
    const samples = message["arrivalDelaySamplesUs"];
    if (!Array.isArray(samples)) {
      return [];
    }
    const delayUs: number[] = [];
    for (const sample of samples) {
      if (isFiniteInteger(sample)) {
        delayUs.push(sample);
      }
    }
    // 上限を超える標本は先頭から切り捨てる（wire-format.md 2.6）。
    const trimmed = delayUs.length > DELAY_TREND_WINDOW ? delayUs.slice(delayUs.length - DELAY_TREND_WINDOW) : delayUs;
    return [{ kind: "report", from, delayUs: trimmed }];
  }
  // 未知の t は無視する。接続は閉じない。
  return [];
}

/** 有限の整数であることを実行時に検査する。NaN と Infinity を除く（wire-format.md 2 節）。 */
function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

/** 過負荷の通知に使うクローズコード。制御系がファンアウト追加を判断する。 */
export const OVERLOAD_CODE = ERROR_DEFINITIONS.E_NODE_OVERLOADED.closeCode;
