/**
 * 送信プロファイルの選択と、測定報告の作成。
 *
 * どちらも純関数である。能力探査（ブラウザ API の呼び出し）は入力として受け取る。
 * 規範: sdk-api.md 2 節（`videoProfile: "auto"` の決定手順）、
 *       wire-format.md 2.6（report の形式。標本列を整数で送る。ADR-0021）。
 *
 * 同じ能力入力に対して全 SDK が同じプロファイル集合を返さなければならない
 * （conformance.md 7 節）。したがってここに時刻・乱数・浮動小数点を持ち込まない。
 */

import {
  DELAY_TREND_WINDOW,
} from "@wheso/core/src/generated/constants.ts";

/** 能力探査の結果。ブラウザ API の呼び出し結果をそのまま入力にする。 */
export interface DeviceCapability {
  /** ハードウェアの AV1 符号化器で 4K60 が実時間に達するか。 */
  readonly hardwareAv1For4K60: boolean;
  /** AV1 の符号化が可能か。 */
  readonly encodeAv1: boolean;
  /** 携帯端末か。 */
  readonly mobile: boolean;
  /** 充電中か。 */
  readonly charging: boolean;
}

/** プロファイルの識別子。定数と対応する。 */
export type ProfileId = "V_4K60" | "V_1080P60" | "V_1080P30" | "V_360P15" | "H264_1080P30" | "H264_360P15";



/** 報告に載せる観測値。すべて整数である。 */export interface ReportInput {
  /** 下り帯域の推定（bits/sec）。 */
  readonly downlinkBps: number;
  /** 片道遅延の標本列（マイクロ秒）。上限は DELAY_TREND_WINDOW。 */
  readonly arrivalDelaySamplesUs: readonly number[];
  readonly playoutStalls: number;
  readonly audioPacketsLost: number;
  readonly videoFramesDropped: number;
  readonly jitterMs: number;
  readonly bufferHealth: "stable" | "growing" | "draining";
}

/**
 * report メッセージを作る（wire-format.md 2.6）。
 *
 * 勾配を計算して送らない。標本列を送り、算出は受信ノードが行う（ADR-0021）。
 * 標本が上限を超える場合は新しい側を残して切り捨てる。
 */
export function buildReport(input: ReportInput): string {
  const samples = input.arrivalDelaySamplesUs.filter((value) => Number.isInteger(value));
  const trimmed =
    samples.length > DELAY_TREND_WINDOW ? samples.slice(samples.length - DELAY_TREND_WINDOW) : samples;
  return JSON.stringify({
    t: "report",
    downlinkBps: input.downlinkBps,
    arrivalDelaySamplesUs: trimmed,
    playoutStalls: input.playoutStalls,
    audioPacketsLost: input.audioPacketsLost,
    videoFramesDropped: input.videoFramesDropped,
    jitterMs: input.jitterMs,
    bufferHealth: input.bufferHealth,
  });
}


