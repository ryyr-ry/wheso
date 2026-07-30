/**
 * 上り輻輳と発熱による送信の降格の判断コア。
 *
 * 規範: congestion.md 3 節（`bufferedAmount` を上り輻輳の信号にする。ADR-0014）、
 *       client-architecture.md 10 節（`encodeQueueSize` による降格）、ADR-0026（はしごの段数）。
 *
 * **なぜ必要か。** 家庭回線とモバイルでは上りが下りより細い。上りが飽和すると、まず
 * 自分の映像が届かなくなり、次に音声が遅れる。下りの制御（受信ノードの tier）は
 * これを直せない。原因が自分の送出側にあるためである。
 *
 * **なぜ 2 つの信号を持つか。** 帯域が足りない場合と、端末が符号化に追いつかない場合は
 * 別の現象である。前者は `bufferedAmount`（送出待ち）に、後者は `encodeQueueSize`
 * （符号化待ち）に現れる。片方だけを見ると、もう片方で固まったときに何も起きない。
 *
 * sans-IO の純関数である。時刻は引数で受け取る。浮動小数点を使わない（ADR-0017）。
 */

import {
  ENCODE_QUEUE_HOLD_MS,
  ENCODE_QUEUE_LIMIT,
  THERMAL_UPGRADE_HOLD_MS,
  UPLINK_BACKLOG_BYTES,
  UPLINK_DEGRADE_STREAK,
  UPLINK_RECOVER_MS,
  UPLINK_UPGRADE_HOLD_MS,
} from "./generated/constants.ts";

/** 降格の理由。観測と試験のために区別する。 */
export type DowngradeReason = "uplink" | "thermal";

export interface UplinkState {
  /**
   * 落とす段数（ADR-0026 の `thermalDrop`）。0 は制限なし。
   * **上限は「はしごの段数 − 1」である。** 1 段は必ず残す（映像を完全に止めない）。
   */
  readonly drop: number;
  /** 直近の降格の理由。昇格の待ち時間が理由によって違う。 */
  readonly lastReason: DowngradeReason | null;
  /** 滞留が上限を超えた観測の連続回数。 */
  readonly backlogStreak: number;
  /** 滞留が 0 になった時刻。ここから `UPLINK_RECOVER_MS` 続けば昇格できる。 */
  readonly idleSinceMs: number | null;
  /** 符号化の待ち行列が上限を超え始めた時刻。 */
  readonly queueOverSinceMs: number | null;
  /** 直近に降格した時刻。昇格の待ちに使う。 */
  readonly lastDowngradeAtMs: number;
}

export function initialUplink(): UplinkState {
  return {
    drop: 0,
    lastReason: null,
    backlogStreak: 0,
    idleSinceMs: null,
    queueOverSinceMs: null,
    // 参加直後に昇格しないよう、待ちの起点を 0 ではなく「まだ降格していない」で表す。
    lastDowngradeAtMs: 0,
  };
}

export interface UplinkResult {
  readonly state: UplinkState;
  /**
   * 段数が変わったか。変わったら送信側は符号化器を作り直し、
   * `streamAnnounce` を送り直す（ADR-0026 の 6）。
   */
  readonly changed: boolean;
  readonly reason: DowngradeReason | null;
}

/**
 * 送出待ちの量を観測する（`REPORT_INTERVAL_MS` の周期で呼ぶ）。
 *
 * ```
 * bufferedAmount > UPLINK_BACKLOG_BYTES が UPLINK_DEGRADE_STREAK 回連続 → 1 段降格
 * bufferedAmount が 0 の状態が UPLINK_RECOVER_MS 続く                  → 1 段昇格
 *   ただし直近の降格から UPLINK_UPGRADE_HOLD_MS は昇格しない
 * ```
 *
 * @param bufferedBytes 送出待ちのバイト数。ネイティブでは未完了の送信件数から換算する
 */
export function noteBufferedAmount(
  state: UplinkState,
  bufferedBytes: number,
  rungCount: number,
  t: number,
): UplinkResult {
  if (bufferedBytes > UPLINK_BACKLOG_BYTES) {
    const streak = state.backlogStreak + 1;
    if (streak < UPLINK_DEGRADE_STREAK) {
      return {
        state: { ...state, backlogStreak: streak, idleSinceMs: null },
        changed: false,
        reason: null,
      };
    }
    return degrade({ ...state, backlogStreak: 0, idleSinceMs: null }, rungCount, "uplink", t);
  }

  // 滞留が上限以下。連続回数を切る。
  const cleared: UplinkState = { ...state, backlogStreak: 0 };
  if (bufferedBytes > 0) {
    // 0 ではない。回復の起点にはならない。
    return { state: { ...cleared, idleSinceMs: null }, changed: false, reason: null };
  }
  const idleSince = cleared.idleSinceMs ?? t;
  const withIdle: UplinkState = { ...cleared, idleSinceMs: idleSince };
  if (t - idleSince < UPLINK_RECOVER_MS) {
    return { state: withIdle, changed: false, reason: null };
  }
  return upgrade(withIdle, t);
}

/**
 * 符号化の待ち行列を観測する（`REPORT_INTERVAL_MS` の周期で呼ぶ）。
 *
 * ```
 * encodeQueueSize > ENCODE_QUEUE_LIMIT が ENCODE_QUEUE_HOLD_MS 続く → 1 段降格
 *   降格の後は THERMAL_UPGRADE_HOLD_MS 昇格しない
 * ```
 *
 * 発熱の直接の指標は存在しない。符号化が実時間に追いつかないことが唯一の観測可能な兆候である
 * （client-architecture.md 10 節）。
 */
export function noteEncodeQueue(
  state: UplinkState,
  queueSize: number,
  rungCount: number,
  t: number,
): UplinkResult {
  if (queueSize <= ENCODE_QUEUE_LIMIT) {
    return { state: { ...state, queueOverSinceMs: null }, changed: false, reason: null };
  }
  const since = state.queueOverSinceMs ?? t;
  const withSince: UplinkState = { ...state, queueOverSinceMs: since };
  if (t - since < ENCODE_QUEUE_HOLD_MS) {
    return { state: withSince, changed: false, reason: null };
  }
  return degrade({ ...withSince, queueOverSinceMs: null }, rungCount, "thermal", t);
}

/** 1 段落とす。**1 段は必ず残す。** */
function degrade(
  state: UplinkState,
  rungCount: number,
  reason: DowngradeReason,
  t: number,
): UplinkResult {
  // 落とせる上限は「段数 − 1」である。段数が 1 の相手はこれ以上落とせない。
  const limit = rungCount - 1 < 0 ? 0 : rungCount - 1;
  if (state.drop >= limit) {
    // すでに最低である。状態は進めるが段は変えない（表に無い遷移を作らない）。
    return { state: { ...state, lastReason: reason, lastDowngradeAtMs: t }, changed: false, reason };
  }
  return {
    state: { ...state, drop: state.drop + 1, lastReason: reason, lastDowngradeAtMs: t },
    changed: true,
    reason,
  };
}

/**
 * 1 段戻す。
 *
 * 昇格の待ちは**降格の理由によって違う**。上りの飽和は回線が空けばすぐ戻るが、
 * 発熱は端末が冷えるまで戻らない。同じ待ちにすると、発熱している端末が
 * 昇格と降格を繰り返して余計に熱くなる。
 */
function upgrade(state: UplinkState, t: number): UplinkResult {
  if (state.drop === 0) {
    return { state, changed: false, reason: null };
  }
  const hold = state.lastReason === "thermal" ? THERMAL_UPGRADE_HOLD_MS : UPLINK_UPGRADE_HOLD_MS;
  if (t - state.lastDowngradeAtMs < hold) {
    return { state, changed: false, reason: null };
  }
  return {
    // 昇格したら回復の起点を切る。切らないと 1 周期で複数段上がる。
    state: { ...state, drop: state.drop - 1, idleSinceMs: t },
    changed: true,
    reason: null,
  };
}

/** 観測用。落としている段数。`deriveLadder` の `thermalDrop` へ渡す。 */
export function dropOf(state: UplinkState): number {
  return state.drop;
}


