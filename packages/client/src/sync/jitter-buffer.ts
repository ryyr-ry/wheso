/**
 * ジッタバッファの判断コア。
 *
 * sans-IO の純関数。時刻・乱数・浮動小数点・入出力に触れない。
 * 規範: constants.md 7 節（深度の決定式）、congestion.md 5 節（再生期限を過ぎたフレーム）。
 *
 * 深度の式:
 *   VIDEO_JITTER_FRAMES  = clamp(ceil(jitterP99Ms / (1000 / framerate)) + 1, 最小, 最大)
 *   AUDIO_JITTER_PACKETS = clamp(ceil(jitterP99Ms / OPUS_FRAME_MS) + 1, 最小, 最大)
 *
 * 除算は整数で行う。ceil(a / b) は整数演算で ((a + b - 1) / b) の切り捨てとして表す。
 * 浮動小数点を使うと言語ごとに丸めが変わり、深度が 1 フレームずれる（ADR-0017）。
 */

import {
  AUDIO_JITTER_MAX_PACKETS,
  AUDIO_JITTER_MIN_PACKETS,
  LATE_FRAME_TOLERANCE_MS,
  OPUS_FRAME_MS,
  VIDEO_JITTER_MAX_FRAMES,
  VIDEO_JITTER_MIN_FRAMES,
} from "@wheso/core/src/generated/constants.ts";
import { CHANNEL_AUDIO, CHANNEL_SCREEN_AUDIO, FLAG_KEY } from "@wheso/core/src/generated/wire-layout.ts";

/** 切り上げの整数除算。負の値は扱わない（遅延と間隔は非負である）。 */
function ceilDiv(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  if (numerator <= 0) {
    return 0;
  }
  return Math.trunc((numerator + denominator - 1) / denominator);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/**
 * 映像のバッファ深度（フレーム数）。
 *
 * 1 フレームの間隔は 1000 / framerate ミリ秒である。除算を避けるため
 * ceil(jitter / (1000 / fps)) = ceil(jitter × fps / 1000) と変形する。
 */
export function videoJitterFrames(jitterP99Ms: number, framerate: number): number {
  if (framerate <= 0) {
    return VIDEO_JITTER_MIN_FRAMES;
  }
  const frames = ceilDiv(jitterP99Ms * framerate, 1000) + 1;
  return clamp(frames, VIDEO_JITTER_MIN_FRAMES, VIDEO_JITTER_MAX_FRAMES);
}

/** 音声のバッファ深度（パケット数）。 */
export function audioJitterPackets(jitterP99Ms: number): number {
  const packets = ceilDiv(jitterP99Ms, OPUS_FRAME_MS) + 1;
  return clamp(packets, AUDIO_JITTER_MIN_PACKETS, AUDIO_JITTER_MAX_PACKETS);
}

/**
 * 到着間隔の標本から p99 を求める。
 *
 * 浮動小数点を使わないため、順位は「上位 1% の境界の添字」を整数で求める。
 * 標本が少ない場合は最大値を返す。標本の並びは呼び出し側で変えない（決定性のため
 * 昇順に整列した複製を作る）。
 */
export function jitterP99Ms(samplesMs: readonly number[]): number {
  if (samplesMs.length === 0) {
    return 0;
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  // 添字 = ceil(99 × n / 100) - 1。n = 1 のとき 0 になる。
  const index = clamp(ceilDiv(99 * sorted.length, 100) - 1, 0, sorted.length - 1);
  return sorted[index] ?? 0;
}

/** 1 個のユニットの再生判定に必要な情報。 */
export interface PlayoutUnit {
  readonly channel: number;
  readonly flags: number;
  /** 再生予定時刻（ミリ秒）。 */
  readonly playoutAtMs: number;
}

/** 判定の結果。 */
export type PlayoutDecision = "decode" | "discard" | "wait";

/**
 * 再生期限を過ぎたフレームの扱い（congestion.md 5 節）。
 *
 *   判定: 再生予定時刻 < 現在時刻 - LATE_FRAME_TOLERANCE_MS
 *   KEY=1 なら復号する（参照連鎖の起点として必要）
 *   音声なら再生する（音声は捨てない）
 *   それ以外は捨てる
 */
export function decidePlayout(unit: PlayoutUnit, nowMs: number): PlayoutDecision {
  if (unit.playoutAtMs > nowMs) {
    return "wait";
  }
  const late = unit.playoutAtMs < nowMs - LATE_FRAME_TOLERANCE_MS;
  if (!late) {
    return "decode";
  }
  if ((unit.flags & FLAG_KEY) !== 0) {
    return "decode";
  }
  if (unit.channel === CHANNEL_AUDIO || unit.channel === CHANNEL_SCREEN_AUDIO) {
    return "decode";
  }
  return "discard";
}
