/**
 * クライアントのメディア接続の判断コア。
 *
 * sans-IO の純関数状態機械。時刻・乱数・浮動小数点・入出力・並行に触れない。
 * 規範: state-machines.md 1 節の表（9 状態・22 遷移）。
 *
 * 表に無い遷移を実装してはならない。表に無いイベントは無視して記録する。
 */

import {
  MAX_UNEXPECTED_EVENTS,
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
  /**
   * 最後にこの接続で何かを受け取った論理時刻。**死活監視に使う**（規範 1 節の
   * `HEARTBEAT_TIMEOUT_MS`）。0 は「まだ受け取っていない」。
   */
  readonly lastInboundAt: number;
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
  /**
   * この接続で何かを受け取った（本文でも媒体でも）。**死活監視の起点である。**
   *
   * `close` の事象が来ない切れ方が実際にある。実測（段 E）: 経路を落としたとき、
   * `vr` だけが `close` を受け取り、`ctl` / `vs` / `as` / `ar` は `CLOSING` のまま
   * `close` が来なかった。したがって**音声が二度と戻らなかった**（`ar` が再接続しない）。
   * 実際の回線でも同じことが起きる（Wi-Fi を切る、経路が消える）。
   */
  | { readonly kind: "inbound" }
  /**
   * 死活の点検（心拍の周期で呼ぶ）。**`timeout` と分ける。**
   *
   * `timeout` は予約した時限（`HELLO_SENT` の猶予、切替の時限、再接続の待ち）の満了を表す。
   * 死活の点検を同じ事象で表すと、点検のたびにそれらが満了したことになる。実測（段 E）:
   * 心拍の周期（3 秒）で `timeout` を送っていたため、(1) `HELLO_SENT` の接続が `helloAck` を
   * 待たずに捨てられ、(2) 再接続の待ちが即座に明けた。結果として映像の受信部屋が 100 秒で
   * 19 本の接続を開き、到着が 1,295/1,553 まで落ちた。
   */
  | { readonly kind: "livenessCheck" }
  | { readonly kind: "timeout" };

export type ConnectionCommand =
  | { readonly kind: "createSocket" }
  | { readonly kind: "sendHello" }
  | { readonly kind: "sendStreamAnnounce" }
  /**
   * 購読を送り直す。
   *
   * **購読は接続に紐づく。** 接続が切れると受信ノード側の購読が消えるため、再接続しても
   * 映像が来ない（無音の黒画面）。`ACTIVE` へ入るすべての遷移で送り直す（ADR-0032）。
   */
  | { readonly kind: "sendSubscribe" }
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
  return { phase: "IDLE", attempts: 0, enteredAt: t, standbyReady: false, lastInboundAt: 0, unexpectedEvents: [] };
}

/** 純関数の状態遷移。 */
export function connectionStep(
  state: ConnectionState,
  event: ConnectionEvent,
  t: number,
): ConnectionStepResult {
  // 受け取った時刻は状態に依らず記録する。遷移は起こさない。
  if (event.kind === "inbound") {
    return { state: { ...state, lastInboundAt: t }, commands: [] };
  }

  // **死活監視**（規範 1 節の `HEARTBEAT_TIMEOUT_MS`）。
  //
  // `close` の事象が来ない切れ方が実際にある。実測（段 E）: 経路を落としたとき `vr` だけが
  // `close` を受け取り、`ctl` / `vs` / `as` / `ar` は `CLOSING` のまま `close` が来ず、
  // **音声が二度と戻らなかった**。心拍の応答が途絶えたら、こちらから閉じて張り直す。
  //
  // 判定は「確立してから」に限る（`HELLO_SENT` の時限は表の別の行が扱う）。
  if (event.kind === "livenessCheck") {
    if (
      (state.phase === "ACTIVE" || state.phase === "DEGRADED") &&
      state.lastInboundAt > 0 &&
      t - state.lastInboundAt >= HEARTBEAT_TIMEOUT_MS
    ) {
      return scheduleReconnect(state, t, [{ kind: "closeSocket" }]);
    }
    // 点検しただけである。**表に無い遷移として記録してはならない**（毎回記録が膨らむ）。
    return { state, commands: [] };
  }

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
          { kind: "sendSubscribe" },
          { kind: "startStandby" },
        ]);
      }
      if (event.kind === "socketClose") {
        return isFatal(event.code)
          ? moveTo(state, "FAILED", t, [{ kind: "fail", code: event.code }])
          : scheduleReconnect(state, t);
      }
      if (event.kind === "timeout" && t - state.enteredAt >= HEARTBEAT_TIMEOUT_MS) {
        // 猶予を過ぎた。**経過で判定する**（早すぎる時限で `helloAck` を待たずに捨てない）。
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
          // 予備接続には購読を送ってあるが、切替後に段が変わっている可能性がある。
          // 送り直しは冪等であり、送らないと古い段のまま固定される。
          { kind: "sendSubscribe" },
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
    state: { ...state, unexpectedEvents: appendUnexpected(state.unexpectedEvents, event.kind) },
    commands: [],
  };
}

/**
 * 表に無いイベントの記録に 1 件加える。**上限を超えたら古い側を捨てる。**
 * 上限が無いと記録が無制限に伸び、Durable Object の記憶（128 MB。F-006）を食う。
 */
function appendUnexpected(events: readonly string[], name: string): readonly string[] {
  const appended = [...events, name];
  return appended.length > MAX_UNEXPECTED_EVENTS
    ? appended.slice(appended.length - MAX_UNEXPECTED_EVENTS)
    : appended;
}
