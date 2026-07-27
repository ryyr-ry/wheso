/**
 * 予備接続の維持と切替。
 *
 * 規範:
 *   - client-architecture.md 2 節: 予備接続を持つのは受信側（`vr` と `ar`）のみである。
 *     送信側の停滞は自分のエンコーダを絞れば解消するため予備を持たない
 *   - state-machines.md 1 節: 切替は `SWAPPING` で行い、`STANDBY_SWAP_TIMEOUT_MS` を
 *     超えたら失敗として扱う。切替の可否は接続コア（transport/connection.ts）が決める
 *   - client-architecture.md 7 節の完了条件: 切替時にフレーム欠落 0、停止時間 0
 *
 * ここは端（副作用の層）である。判断は持たない。
 * 欠落 0 を満たす手順は次のとおりである。
 *   1. 予備接続を開き、購読を送る（この時点で両方の接続からフレームが届く）
 *   2. 予備接続でキーフレームを受けるまで、主接続のフレームを使い続ける
 *   3. キーフレームを受けたら主を切り替え、旧主を閉じる
 * 先に旧主を閉じると、キーフレームが来るまでの間が欠落になる。
 */

import { STANDBY_CONNECTION_ENABLED } from "@wheso/core/src/generated/constants.ts";

/** 接続 1 本の最小の形。実装は WebSocket でも試験の偽物でもよい。 */
export interface StandbySocket {
  /** 制御メッセージを送る。 */
  readonly send: (text: string) => void;
  /** 閉じる。 */
  readonly close: () => void;
}

export interface StandbyDeps {
  /** 予備接続を開く。失敗した場合は null を返す（例外を投げない）。 */
  readonly openSocket: () => StandbySocket | null;
  /** 購読を再送するための本文を作る。主接続と同じ購読を予備にも送る。 */
  readonly subscribeText: () => string;
}

export type StandbyPhase = "IDLE" | "OPENING" | "WAITING_KEYFRAME" | "READY" | "DISABLED";

export interface StandbyState {
  readonly phase: StandbyPhase;
  /** 予備接続。無ければ null。 */
  readonly socket: StandbySocket | null;
  /** 予備で受けたフレーム数。観測のために数える。 */
  readonly framesOnStandby: number;
}

export function initialStandby(): StandbyState {
  // 規範で無効にされている場合は開かない。設定を無視して開くと接続数が倍になる。
  return {
    phase: STANDBY_CONNECTION_ENABLED ? "IDLE" : "DISABLED",
    socket: null,
    framesOnStandby: 0,
  };
}

/** 予備接続を開き、購読を送る。接続コアの `startStandby` に対応する。 */
export function startStandby(state: StandbyState, deps: StandbyDeps): StandbyState {
  if (state.phase === "DISABLED") {
    return state;
  }
  if (state.socket !== null) {
    // 二重に開かない。上流への同時接続は 2 本までである（state-machines.md 4 節）。
    return state;
  }
  const socket = deps.openSocket();
  if (socket === null) {
    return { ...state, phase: "IDLE" };
  }
  socket.send(deps.subscribeText());
  return { phase: "WAITING_KEYFRAME", socket, framesOnStandby: 0 };
}

/** 予備でフレームを受けた。キーフレームであれば切替可能になる。 */
export function noteStandbyFrame(state: StandbyState, isKeyFrame: boolean): StandbyState {
  if (state.socket === null) {
    return state;
  }
  const framesOnStandby = state.framesOnStandby + 1;
  if (state.phase === "WAITING_KEYFRAME" && isKeyFrame) {
    return { ...state, phase: "READY", framesOnStandby };
  }
  return { ...state, framesOnStandby };
}

/** 接続コアへ渡す「切替の可否」。判断はコアが行う。 */
export function isStandbyReady(state: StandbyState): boolean {
  return state.phase === "READY";
}

export interface SwapResult {
  readonly state: StandbyState;
  /** 新しい主接続。切替できない場合は null（呼び出し側は主を保持し続ける）。 */
  readonly promoted: StandbySocket | null;
}

/**
 * 予備を主へ昇格させる。旧主は呼び出し側が閉じる。
 *
 * 準備できていない予備へは切り替えない。切り替えるとキーフレームが来るまで
 * 描画が止まり、完了条件（停止時間 0）を満たさない。
 */
export function swapToStandby(state: StandbyState): SwapResult {
  if (state.phase !== "READY" || state.socket === null) {
    return { state, promoted: null };
  }
  return { state: { phase: "IDLE", socket: null, framesOnStandby: 0 }, promoted: state.socket };
}

/** 予備を閉じる。接続コアの `closeStandby` に対応する。 */
export function closeStandby(state: StandbyState): StandbyState {
  if (state.socket === null) {
    return { ...state, phase: state.phase === "DISABLED" ? "DISABLED" : "IDLE" };
  }
  state.socket.close();
  return { phase: state.phase === "DISABLED" ? "DISABLED" : "IDLE", socket: null, framesOnStandby: 0 };
}
