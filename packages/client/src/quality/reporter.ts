/**
 * 測定値の集約と `report` の作成。
 *
 * 規範:
 *   - wire-format.md 2.6 と ADR-0021: 勾配は送らない。片道遅延の**標本列**を整数で送る。
 *     標本数の上限は `DELAY_TREND_WINDOW` であり、超える分は古い側から捨てる
 *   - sdk-api.md 4 節: 周期は `REPORT_INTERVAL_MS`
 *   - client-architecture.md 6 節: クライアントの責務は測定と報告に限る。
 *     tier を自分で決めてはならない
 *
 * sans-IO の純関数である。時刻は引数で受け取り、送信は端が行う。
 * 勾配の算出をここに持たない理由は ADR-0021 にある（算出は受信ノードの 1 箇所に集約する）。
 */

import {
  DELAY_TREND_WINDOW,
  REPORT_INTERVAL_MS,
} from "@wheso/core/src/generated/constants.ts";
import { buildReport, type ReportInput } from "../media/capability.ts";

export interface ReporterState {
  /** 片道遅延の標本列（マイクロ秒）。古い側が先頭である。 */
  readonly samplesUs: readonly number[];
  /** 直近の窓で観測した再生の停止回数。 */
  readonly playoutStalls: number;
  /** 直近の窓で失われた音声パケット数。 */
  readonly audioPacketsLost: number;
  /** 直近の窓で捨てた映像フレーム数。 */
  readonly videoFramesDropped: number;
  /** 下り帯域の推定（bits/sec）。 */
  readonly downlinkBps: number;
  /** ジッタの推定（ミリ秒）。 */
  readonly jitterMs: number;
  /** バッファの傾き。 */
  readonly bufferHealth: "stable" | "growing" | "draining";
  /** 直近に報告した論理時刻。 */
  readonly lastReportAtMs: number;
}

export function initialReporter(nowMs: number): ReporterState {
  return {
    samplesUs: [],
    playoutStalls: 0,
    audioPacketsLost: 0,
    videoFramesDropped: 0,
    downlinkBps: 0,
    jitterMs: 0,
    bufferHealth: "stable",
    lastReportAtMs: nowMs,
  };
}

/**
 * 片道遅延の標本を 1 個加える。
 *
 * 上限を超える場合は**古い側**を捨てる。新しい側を捨てると勾配が過去を向く。
 */
export function recordArrivalDelay(state: ReporterState, delayUs: number): ReporterState {
  const appended = [...state.samplesUs, delayUs];
  const samplesUs =
    appended.length > DELAY_TREND_WINDOW ? appended.slice(appended.length - DELAY_TREND_WINDOW) : appended;
  return { ...state, samplesUs };
}

/** 再生が止まったことを記録する。 */
export function recordStall(state: ReporterState): ReporterState {
  return { ...state, playoutStalls: state.playoutStalls + 1 };
}

/** 音声パケットの欠落を記録する。 */
export function recordAudioLoss(state: ReporterState, count: number): ReporterState {
  if (count <= 0) {
    return state;
  }
  return { ...state, audioPacketsLost: state.audioPacketsLost + count };
}

/** 映像フレームを捨てたことを記録する。 */
export function recordVideoDrop(state: ReporterState): ReporterState {
  return { ...state, videoFramesDropped: state.videoFramesDropped + 1 };
}

/** 下り帯域とジッタの推定を更新する。 */
export function recordLinkEstimate(
  state: ReporterState,
  downlinkBps: number,
  jitterMs: number,
  bufferHealth: ReporterState["bufferHealth"],
): ReporterState {
  return { ...state, downlinkBps, jitterMs, bufferHealth };
}

/** 報告の時期に達したか。周期の管理は端が行うが、判定はここに置く。 */
export function shouldReport(state: ReporterState, nowMs: number): boolean {
  return nowMs - state.lastReportAtMs >= REPORT_INTERVAL_MS;
}

export interface ReportOutput {
  readonly state: ReporterState;
  /** 送る本文。端はこれをそのまま制御リンクへ送る。 */
  readonly text: string;
}

/**
 * 報告を作り、窓の計数を 0 に戻す。
 *
 * 標本列は残す。勾配は直近の窓をまたいで連続していなければならないためである
 * （報告のたびに空にすると、受信ノードは常に短い列から勾配を求めることになる）。
 */
export function takeReport(state: ReporterState, nowMs: number): ReportOutput {
  const input: ReportInput = {
    downlinkBps: state.downlinkBps,
    arrivalDelaySamplesUs: state.samplesUs,
    playoutStalls: state.playoutStalls,
    audioPacketsLost: state.audioPacketsLost,
    videoFramesDropped: state.videoFramesDropped,
    jitterMs: state.jitterMs,
    bufferHealth: state.bufferHealth,
  };
  return {
    state: {
      ...state,
      playoutStalls: 0,
      audioPacketsLost: 0,
      videoFramesDropped: 0,
      lastReportAtMs: nowMs,
    },
    text: buildReport(input),
  };
}
