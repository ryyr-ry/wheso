/**
 * クライアントのメディア接続の判断コア。
 *
 * sans-IO の純関数状態機械。時刻・乱数・浮動小数点・入出力・並行に触れない。
 * 規範: state-machines.md 1 節の表（9 状態・22 遷移）。
 *
 * 表に無い遷移を実装してはならない。表に無いイベントは無視して記録する。
 */

import {
  HEARTBEAT_TIMEOUT_MS,
  RECONNECT_BACKOFF_MS,
  STANDBY_SWAP_TIMEOUT_MS,
  VIDEO_STALL_RESET_MS,
} from "@wheso/core/src/generated/constants.ts";
import { ERROR_DEFINITIONS } from "@wheso/core/src/generated/errors.ts";

/** 接続の状態（state-machines.md 1 節）。 */
export type ConnectionPhase =
  | "IDLE"
  | "CONNECTING"
  | "HELLO_SENT"
  | "ACTIVE"
  | "DEGRADED"
  | "SWAPPING"
  | "RECONNECT_WAIT"
  | "FAILED"
  | "CLOSED";

export interface ConnectionState {
  readonly phase: ConnectionPhase;
  /** 連続した接続試行の回数。成功で 0 に戻る。 */
  readonly attempts: number;
  /** 現在の状態に入った論理時刻。時限の判定に使う。 */
  readonly enteredAt: number;
  /** 予備接続が使えるか。切替の可否を決める。 */
  readonly standbyReady: boolean;
  /** 表に無いイベントの記録。 */
  readonly unexpectedEvents: readonly string[];
}

export type ConnectionEvent =
  | { readonly kind: "open" }
  | { readonly kind: "close" }
  | { readonly kind: "socketOpen" }
  | { readonly kind: "socketError" }
  | { readonly kind: "socketClose"; readonly code: number }
  | { readonly kind: "helloAck" }
  | { readonly kind: "reportTimer" }
  | { readonly kind: "trendDegrade" }
  | { readonly kind: "trendRecover" }
  | { readonly kind: "stall"; readonly durationMs: number }
  | { readonly kind: "standbyReady"; readonly ready: boolean }
  | { readonly kind: "standbyKeyframe" }
  | { readonly kind: "timeout" };

export type ConnectionCommand =
  | { readonly kind: "createSocket" }
  | { readonly kind: "sendHello" }
  | { readonly kind: "sendStreamAnnounce" }
  | { readonly kind: "sendReport" }
  | { readonly kind: "startStandby" }
  | { readonly kind: "swapToStandby" }
  | { readonly kind: "closeSocket" }
  | { readonly kind: "closeStandby" }
  | { readonly kind: "tierDown" }
  | { readonly kind: "tierUp" }
  | { readonly kind: "warn"; readonly code: string }
  | { readonly kind: "fail"; readonly code: number }
  | { readonly kind: "schedule"; readonly at: number };

export interface ConnectionStepResult {
  readonly state: ConnectionState;
  readonly commands: readonly ConnectionCommand[];
}

export function initialConnectionState(t: number): ConnectionState {
  return { phase: "IDLE", attempts: 0, enteredAt: t, standbyReady: false, unexpectedEvents: [] };
}

/** 純関数の状態遷移。 */
export function connectionStep(
  state: ConnectionState,
  event: ConnectionEvent,
  t: number,
): ConnectionStepResult {
  // 予備接続の可否は状態に依らず記録する。遷移は起こさない。
  if (event.kind === "standbyReady") {
    return { state: { ...state, standbyReady: event.ready }, commands: [] };
  }

  switch (state.phase) {
    case "IDLE":
      if (event.kind === "open") {
        return moveTo(state, "CONNECTING", t, [{ kind: "createSocket" }]);
      }
      return ignore(state, event);

    case "CONNECTING":
      if (event.kind === "socketOpen") {
        return moveTo(state, "HELLO_SENT", t, [
          { kind: "sendHello" },
          { kind: "schedule", at: t + HEARTBEAT_TIMEOUT_MS },
        ]);
      }
      if (event.kind === "socketError" || event.kind === "socketClose") {
        return scheduleReconnect(state, t);
      }
      if (event.kind === "close") {
        return moveTo(state, "CLOSED", t, [{ kind: "closeSocket" }]);
      }
      return ignore(state, event);

    case "HELLO_SENT":
      if (event.kind === "helloAck") {
        return moveTo({ ...state, attempts: 0 }, "ACTIVE", t, [
          { kind: "sendStreamAnnounce" },
          { kind: "startStandby" },
        ]);
      }
      if (event.kind === "socketClose") {
        return isFatal(event.code)
          ? moveTo(state, "FAILED", t, [{ kind: "fail", code: event.code }])
          : scheduleReconnect(state, t);
      }
      if (event.kind === "timeout") {
        return scheduleReconnect(state, t, [{ kind: "closeSocket" }]);
      }
      if (event.kind === "close") {
        return moveTo(state, "CLOSED", t, [{ kind: "closeSocket" }]);
      }
      return ignore(state, event);

    case "ACTIVE":
      if (event.kind === "reportTimer") {
        return { state, commands: [{ kind: "sendReport" }] };
      }
      if (event.kind === "trendDegrade") {
        return moveTo(state, "DEGRADED", t, [
          { kind: "tierDown" },
          { kind: "warn", code: "W_DEGRADED" },
        ]);
      }
      if (event.kind === "stall") {
        if (event.durationMs <= VIDEO_STALL_RESET_MS) {
          return ignore(state, event);
        }
        return state.standbyReady
          ? moveTo(state, "SWAPPING", t, [
              { kind: "swapToStandby" },
              { kind: "schedule", at: t + STANDBY_SWAP_TIMEOUT_MS },
            ])
          : scheduleReconnect(state, t, [{ kind: "closeSocket" }]);
      }
      if (event.kind === "socketClose") {
        return isFatal(event.code)
          ? moveTo(state, "FAILED", t, [{ kind: "fail", code: event.code }])
          : scheduleReconnect(state, t);
      }
      if (event.kind === "close") {
        return moveTo(state, "CLOSED", t, [{ kind: "closeSocket" }]);
      }
      return ignore(state, event);

    case "DEGRADED":
      if (event.kind === "trendRecover") {
        return moveTo(state, "ACTIVE", t, [{ kind: "tierUp" }]);
      }
      if (event.kind === "trendDegrade") {
        // 既に最低の場合は何もしない（表 16 行目）。tier の下限判定は呼び出し側が持つ。
        return { state, commands: [] };
      }
      if (event.kind === "socketClose") {
        return isFatal(event.code)
          ? moveTo(state, "FAILED", t, [{ kind: "fail", code: event.code }])
          : scheduleReconnect(state, t);
      }
      if (event.kind === "reportTimer") {
        return { state, commands: [{ kind: "sendReport" }] };
      }
      if (event.kind === "close") {
        return moveTo(state, "CLOSED", t, [{ kind: "closeSocket" }]);
      }
      return ignore(state, event);

    case "SWAPPING":
      if (event.kind === "standbyKeyframe") {
        return moveTo({ ...state, standbyReady: false }, "ACTIVE", t, [
          { kind: "closeSocket" },
          { kind: "startStandby" },
          { kind: "warn", code: "W_STANDBY_SWAP" },
        ]);
      }
      if (event.kind === "timeout" && t - state.enteredAt >= STANDBY_SWAP_TIMEOUT_MS) {
        return scheduleReconnect(state, t, [{ kind: "closeSocket" }, { kind: "closeStandby" }]);
      }
      if (event.kind === "close") {
        return moveTo(state, "CLOSED", t, [{ kind: "closeSocket" }, { kind: "closeStandby" }]);
      }
      return ignore(state, event);

    case "RECONNECT_WAIT":
      if (event.kind === "timeout") {
        return moveTo(state, "CONNECTING", t, [{ kind: "createSocket" }]);
      }
      if (event.kind === "close") {
        return moveTo(state, "CLOSED", t, []);
      }
      return ignore(state, event);

    case "FAILED":
      if (event.kind === "open") {
        // 利用者の明示操作のみで復帰する（表 22 行目）。試行回数を 0 に戻す。
        return moveTo({ ...state, attempts: 0 }, "CONNECTING", t, [{ kind: "createSocket" }]);
      }
      return ignore(state, event);

    case "CLOSED":
      return ignore(state, event);
  }
}

/** 再接続の待機へ入る。待ち時間は表に従い、試行回数で決まる。 */
function scheduleReconnect(
  state: ConnectionState,
  t: number,
  extra: readonly ConnectionCommand[] = [],
): ConnectionStepResult {
  const attempts = state.attempts + 1;
  const backoff = backoffFor(state.attempts);
  return {
    state: { ...state, phase: "RECONNECT_WAIT", attempts, enteredAt: t },
    commands: [...extra, { kind: "schedule", at: t + backoff }],
  };
}

/**
 * 待ち時間を選ぶ。
 * 試行回数が表の長さ未満なら該当する値、それ以上なら最後の値を使う。
 */
export function backoffFor(attempts: number): number {
  const table: readonly number[] = RECONNECT_BACKOFF_MS;
  const index = attempts < table.length ? attempts : table.length - 1;
  return table[index] ?? 0;
}

/** 再接続してはならないクローズコードか（errors.md の回復可否）。 */
export function isFatal(code: number): boolean {
  for (const definition of Object.values(ERROR_DEFINITIONS)) {
    if (definition.closeCode === code) {
      return !definition.autoReconnect;
    }
  }
  // 未知のコードは回復可能として扱う。切断の理由が分からない場合に会議を諦めない。
  return false;
}

function moveTo(
  state: ConnectionState,
  phase: ConnectionPhase,
  t: number,
  commands: readonly ConnectionCommand[],
): ConnectionStepResult {
  return { state: { ...state, phase, enteredAt: t }, commands };
}

/** 表に無いイベントは無視して記録する。 */
function ignore(state: ConnectionState, event: ConnectionEvent): ConnectionStepResult {
  return {
    state: { ...state, unexpectedEvents: [...state.unexpectedEvents, event.kind] },
    commands: [],
  };
}
