/**
 * 同一送信者の映像と音声の同期の判断コア。
 *
 * 規範:
 *   - client-architecture.md 4 節の規則 3: 同期は同一 `senderId` の
 *     `captureTimestampUs` の差だけで行う。他の送信者との時刻整合は取らない
 *   - 定数規範 7 節: `AV_SKEW_TOLERANCE_MS` の範囲では補正しない。
 *     `AV_SKEW_RESYNC_MS` を超えたら次のキーフレームまで映像をスキップして再同期する
 *
 * sans-IO の純関数である。浮動小数点を使わない。時刻は引数で受け取る。
 * 音声を基準にする理由は、音声が輻輳で捨てられず、再生クロックが `AudioContext` で
 * 進み続けるためである（音声を待たせると会話が壊れる）。
 */

import { AV_SKEW_RESYNC_MS, AV_SKEW_TOLERANCE_MS } from "@wheso/core/src/generated/constants.ts";

/** マイクロ秒からミリ秒への換算。整数除算のみを使う（ADR-0017）。 */
const US_PER_MS = 1000;

/** 送信者 1 人の同期状態。 */
export interface AvSyncEntry {
  readonly senderId: number;
  /** 直近に再生した音声の取得時刻（マイクロ秒）。 */
  readonly audioTimestampUs: number;
  /** 再同期のためキーフレームを待っているか。 */
  readonly awaitingKeyframe: boolean;
}

export interface AvSyncState {
  /** senderId の昇順で保持する。 */
  readonly entries: readonly AvSyncEntry[];
}

export function initialAvSync(): AvSyncState {
  return { entries: [] };
}

/**
 * 映像フレーム 1 枚の扱い。
 *
 *   present … そのまま提示する（ずれが許容内）
 *   hold    … 映像が先行している。音声が追いつくまで保持する
 *   drop    … 映像が遅れている。捨てて追いつく
 *   resync  … ずれが大きい。次のキーフレームまで映像を捨てる
 */
export type AvSyncDecision = "present" | "hold" | "drop" | "resync";

export interface AvSyncResult {
  readonly state: AvSyncState;
  readonly decision: AvSyncDecision;
  /** 映像から音声を引いた差（ミリ秒）。正なら映像が先行している。観測に使う。 */
  readonly skewMs: number;
}

function find(state: AvSyncState, senderId: number): AvSyncEntry | undefined {
  return state.entries.find((entry) => entry.senderId === senderId);
}

function replace(state: AvSyncState, entry: AvSyncEntry): AvSyncState {
  const rest = state.entries.filter((existing) => existing.senderId !== entry.senderId);
  return { entries: [...rest, entry].sort((a, b) => a.senderId - b.senderId) };
}

/** 音声を再生したことを記録する。基準時刻はここで進む。 */
export function noteAudioPlayed(state: AvSyncState, senderId: number, timestampUs: number): AvSyncState {
  const existing = find(state, senderId);
  if (existing === undefined) {
    return replace(state, { senderId, audioTimestampUs: timestampUs, awaitingKeyframe: false });
  }
  if (timestampUs <= existing.audioTimestampUs) {
    // 後戻りする時刻では更新しない。順序の逆転で基準が巻き戻ると同期が振動する。
    return state;
  }
  return replace(state, { ...existing, audioTimestampUs: timestampUs });
}

/** 送信者の退出。記録を捨てる。 */
export function forgetSender(state: AvSyncState, senderId: number): AvSyncState {
  return { entries: state.entries.filter((entry) => entry.senderId !== senderId) };
}

/**
 * 映像フレームの提示可否を決める。
 *
 * 音声をまだ 1 度も再生していない送信者は、音声の到着を待たずに提示する。
 * 音声が無い参加者（マイク無効）でも映像が止まらないようにするためである。
 */
export function decideVideo(
  state: AvSyncState,
  senderId: number,
  videoTimestampUs: number,
  isKeyFrame: boolean,
): AvSyncResult {
  const existing = find(state, senderId);
  if (existing === undefined) {
    return { state, decision: "present", skewMs: 0 };
  }

  // マイクロ秒の差をミリ秒へ落とす。切り捨てはゼロ方向であり、符号で挙動が変わらない。
  const diffUs = videoTimestampUs - existing.audioTimestampUs;
  const skewMs = Math.trunc(diffUs / US_PER_MS);
  const magnitude = skewMs < 0 ? -skewMs : skewMs;

  if (existing.awaitingKeyframe) {
    if (!isKeyFrame) {
      return { state, decision: "resync", skewMs };
    }
    return { state: replace(state, { ...existing, awaitingKeyframe: false }), decision: "present", skewMs };
  }

  if (magnitude > AV_SKEW_RESYNC_MS) {
    // ずれが大きすぎる。次のキーフレームまで映像を捨てて作り直す。
    return { state: replace(state, { ...existing, awaitingKeyframe: true }), decision: "resync", skewMs };
  }
  if (magnitude <= AV_SKEW_TOLERANCE_MS) {
    return { state, decision: "present", skewMs };
  }
  return { state, decision: skewMs > 0 ? "hold" : "drop", skewMs };
}

/** 観測用。直近のずれの最大値を返す。SLI（AV_SKEW_MS_P99）の入力になる。 */
export function maxSkewMs(results: readonly AvSyncResult[]): number {
  let worst = 0;
  for (const result of results) {
    const magnitude = result.skewMs < 0 ? -result.skewMs : result.skewMs;
    if (magnitude > worst) {
      worst = magnitude;
    }
  }
  return worst;
}
