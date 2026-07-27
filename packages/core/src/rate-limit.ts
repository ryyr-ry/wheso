/**
 * 流量の制限。判断は純関数で行い、時刻は引数で受け取る（lint-policy.md 9 節）。
 *
 * 規範:
 *   - auth.md 5 節（濫用対策）… 接続試行 20 回/分、受信メッセージ 400 件/秒
 *   - wire-format.md 2.5（keyframeRequest）… 同一 (senderId, channel, spatialId) への要求は
 *     KEYFRAME_REQUEST_MIN_INTERVAL_MS 以内に 2 回以上送らない。受信側は超過分を無視する
 *
 * 窓は固定窓とする。カウンタは Durable Object のインメモリ状態で保持し、
 * evict で失われてよい（auth.md 5 節に明記がある。evict は接続が無い状態で起こる）。
 */

import { KEYFRAME_REQUEST_MIN_INTERVAL_MS } from "./generated/constants.ts";

/** 固定窓の計数。 */
export interface RateWindow {
  /** 窓の開始時刻（ミリ秒）。 */
  readonly startMs: number;
  /** 窓の中で数えた件数。 */
  readonly count: number;
}

export interface RateDecision {
  readonly window: RateWindow;
  /** 制限内であれば true。false の場合は呼び出し側が拒否する。 */
  readonly allowed: boolean;
}

export function initialRateWindow(nowMs: number): RateWindow {
  return { startMs: nowMs, count: 0 };
}

/**
 * 1 件を計上し、制限内かどうかを返す。
 *
 * 窓が満了していれば新しい窓を開く。境界は「開始時刻 + 窓長 <= 現在時刻」で判定する。
 * 比較を `<` にすると、窓長と等しい時刻の到着が旧窓に数えられ、実装間で差が出る。
 */
export function admit(window: RateWindow, nowMs: number, windowMs: number, limit: number): RateDecision {
  const current = nowMs - window.startMs >= windowMs ? { startMs: nowMs, count: 0 } : window;
  const count = current.count + 1;
  return { window: { startMs: current.startMs, count }, allowed: count <= limit };
}

/** キーフレーム要求の宛先。 */
export interface KeyframeKey {
  readonly senderId: number;
  readonly channel: number;
  readonly spatialId: number;
}

/** 直近に要求を通した時刻の記録。senderId, channel, spatialId の昇順で保持する。 */
export interface KeyframeMark extends KeyframeKey {
  readonly atMs: number;
}

export interface KeyframeDecision {
  readonly marks: readonly KeyframeMark[];
  /** 送出（または受理）してよければ true。 */
  readonly allowed: boolean;
}

/**
 * キーフレーム要求の間隔を判定する。
 *
 * 同一の (senderId, channel, spatialId) に対して
 * `KEYFRAME_REQUEST_MIN_INTERVAL_MS` 以内の 2 回目以降を通さない。
 * 送出側は送らず、受理側は無視する（wire-format.md 2.5）。
 */
export function admitKeyframeRequest(
  marks: readonly KeyframeMark[],
  key: KeyframeKey,
  nowMs: number,
): KeyframeDecision {
  const existing = marks.find(
    (mark) => mark.senderId === key.senderId && mark.channel === key.channel && mark.spatialId === key.spatialId,
  );
  if (existing !== undefined && nowMs - existing.atMs < KEYFRAME_REQUEST_MIN_INTERVAL_MS) {
    return { marks, allowed: false };
  }
  const rest = marks.filter(
    (mark) => !(mark.senderId === key.senderId && mark.channel === key.channel && mark.spatialId === key.spatialId),
  );
  const merged = [...rest, { ...key, atMs: nowMs }].sort(keyframeOrder);
  return { marks: merged, allowed: true };
}

function keyframeOrder(a: KeyframeMark, b: KeyframeMark): number {
  if (a.senderId !== b.senderId) {
    return a.senderId - b.senderId;
  }
  if (a.channel !== b.channel) {
    return a.channel - b.channel;
  }
  return a.spatialId - b.spatialId;
}
