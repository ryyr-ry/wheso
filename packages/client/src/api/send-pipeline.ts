/**
 * 送信経路の配線。
 *
 * 規範: wire-format.md 1.2（sequenceNumber は同一 (senderId, channel, spatialId) 内で
 *       1 から単調増加）、ADR-0004（解像度方向は simulcast）、ADR-0005（音声の束ね）、
 *       ADR-0026（はしごは源から導出する）、congestion.md 3 節（上りの輻輳）。
 *
 * **これが無いと SDK は 1 バイトも送れない。** 段 F まで、`media/encoder-set.ts` と
 * `media/audio-send.ts` は試験と E2E の器からしか参照されておらず、製品の実行経路に
 * 符号化器を作る場所が存在しなかった。`streamAnnounce`（はしごの申告）だけを送り、
 * 実際には何も送らない状態だった。
 *
 * ここは端（副作用の層）である。判断は次に委ねる。
 *   ワイヤ化と破棄可否  core/wire.ts（`packEncoded` が `computeDiscardable` を使う）
 *   束ねの単位          media/audio-send.ts（`AUDIO_UNITS_PER_MESSAGE`）
 *   はしご              core/ladder.ts
 *
 * 実際の `VideoEncoder` / `AudioEncoder` は `media/browser-capture.ts` が持つ。
 * 分けている理由は、WebCodecs の無い環境（Node の試験）でも連番と束ねを検証できることである。
 */

import { CHANNEL_AUDIO, CHANNEL_VIDEO } from "@wheso/core/src/generated/wire-layout.ts";
import { wrap32 } from "@wheso/core/src/fixed.ts";
import { packEncoded } from "../media/encoder-set.ts";
import { addFrame, flush, initialAudioBundle, type AudioBundleState, type OpusFrame } from "../media/audio-send.ts";

/** 符号化できた映像 1 枚。`VideoEncoder` の出力を端が写した形である。 */
export interface EncodedVideo {
  readonly spatialId: number;
  readonly temporalId: number;
  readonly temporalLayers: number;
  readonly isKey: boolean;
  readonly captureTimestampUs: bigint;
  readonly payload: Uint8Array;
}

/** 送出の口。実際の WebSocket は入口が与える。 */
export interface SendDeps {
  /** 映像送信部屋へ送る。 */
  readonly sendVideo: (bytes: Uint8Array) => void;
  /** 音声送信部屋へ送る。 */
  readonly sendAudio: (bytes: Uint8Array) => void;
  /** 局所の単調時計（ミリ秒）。 */
  readonly now: () => number;
}

/** 連番の記録。(channel, spatialId) ごとに独立している。 */
interface SequenceMark {
  readonly channel: number;
  readonly spatialId: number;
  /** 次に使う値。**1 から始める**（wire-format.md 1.2）。 */
  readonly next: number;
}

export interface SendPipelineState {
  /** channel, spatialId の昇順で保持する。 */
  readonly sequences: readonly SequenceMark[];
  readonly audio: AudioBundleState;
  /** 送出したバイト数（窓の中）。上り帯域の観測に使う。 */
  readonly windowBytes: number;
  readonly windowStartMs: number;
  /** 直近に算出した上り帯域（bits/sec）。 */
  readonly uplinkBps: number;
  /** 送出したメッセージ数。観測のために数える。 */
  readonly sentMessages: number;
  /** ワイヤ化に失敗した回数。0 でなければ実装の誤りである。 */
  readonly encodeErrors: number;
}

/** 上り帯域を測る窓の長さ。下りと同じ 1 秒とする（congestion.md 4.1）。 */
const UPLINK_WINDOW_MS = 1000;

export function createSendPipeline(nowMs: number): SendPipelineState {
  return {
    sequences: [],
    audio: initialAudioBundle(),
    windowBytes: 0,
    windowStartMs: nowMs,
    uplinkBps: 0,
    sentMessages: 0,
    encodeErrors: 0,
  };
}

function nextSequence(
  state: SendPipelineState,
  channel: number,
  spatialId: number,
): { readonly value: number; readonly state: SendPipelineState } {
  const found = state.sequences.find((mark) => mark.channel === channel && mark.spatialId === spatialId);
  const value = found === undefined ? 1 : found.next;
  const rest = state.sequences.filter((mark) => !(mark.channel === channel && mark.spatialId === spatialId));
  // **2^32 で 1 に戻る**（wire-format.md 1.2）。0 は使わない（未設定と区別できなくなる）。
  // 巻き戻しを実装しないと、長時間の通話で `sequenceNumber` が u32 を超えて符号化に失敗し、
  // 映像が止まる。切り詰めは `fixed.ts` の 1 箇所に置く。
  const advanced = wrap32(value + 1);
  const next = advanced === 0 ? 1 : advanced;
  const merged = [...rest, { channel, spatialId, next }].sort((a, b) =>
    a.channel !== b.channel ? a.channel - b.channel : a.spatialId - b.spatialId,
  );
  return { value, state: { ...state, sequences: merged } };
}

/** 送出したバイト数を計上する。窓が満了したら bits/sec を確定する。 */
function accountUplink(state: SendPipelineState, byteCount: number, nowMs: number): SendPipelineState {
  const elapsed = nowMs - state.windowStartMs;
  if (elapsed < UPLINK_WINDOW_MS) {
    return { ...state, windowBytes: state.windowBytes + byteCount, sentMessages: state.sentMessages + 1 };
  }
  const total = state.windowBytes + byteCount;
  // bits/sec = バイト数 × 8 × 1000 / 経過ミリ秒。整数演算のみ（ADR-0017）。
  const bps = elapsed > 0 ? Math.trunc((total * 8 * 1000) / elapsed) : 0;
  return {
    ...state,
    windowBytes: 0,
    windowStartMs: nowMs,
    uplinkBps: bps,
    sentMessages: state.sentMessages + 1,
  };
}

/**
 * 符号化できた映像 1 枚を送る。
 *
 * 段ごとに連番が独立している（simulcast では段ごとに別のストリームである）。
 * 連番を共有すると受信側の送信窓（`inFlightFrames`）が段の切替で壊れる。
 */
export function handleEncodedVideo(
  state: SendPipelineState,
  senderId: number,
  video: EncodedVideo,
  deps: SendDeps,
): SendPipelineState {
  const assigned = nextSequence(state, CHANNEL_VIDEO, video.spatialId);
  const packed = packEncoded({
    channel: CHANNEL_VIDEO,
    senderId,
    sequenceNumber: assigned.value,
    captureTimestampUs: video.captureTimestampUs,
    spatialId: video.spatialId,
    temporalId: video.temporalId,
    temporalLayers: video.temporalLayers,
    isKey: video.isKey,
    payload: video.payload,
  });
  if (!packed.ok) {
    // ワイヤ化の失敗は数える。**送らないことで表現する**（例外を投げない）。
    return { ...assigned.state, encodeErrors: assigned.state.encodeErrors + 1 };
  }
  deps.sendVideo(packed.value);
  return accountUplink(assigned.state, packed.value.length, deps.now());
}

/**
 * 符号化できた音声 1 フレームを溜める。`AUDIO_UNITS_PER_MESSAGE` に達したら送る。
 *
 * 連番は束ねの中で昇順でなければならない（wire-format.md 1.2）。ここで採番する。
 */
export function handleEncodedAudio(
  state: SendPipelineState,
  senderId: number,
  frame: Omit<OpusFrame, "sequenceNumber">,
  deps: SendDeps,
): SendPipelineState {
  const assigned = nextSequence(state, CHANNEL_AUDIO, 0);
  const added = addFrame(
    assigned.state.audio,
    { ...frame, sequenceNumber: assigned.value },
    senderId,
    CHANNEL_AUDIO,
  );
  if (!added.ok) {
    return { ...assigned.state, encodeErrors: assigned.state.encodeErrors + 1 };
  }
  const next: SendPipelineState = { ...assigned.state, audio: added.value.state };
  if (added.value.message === null) {
    return next;
  }
  deps.sendAudio(added.value.message);
  return accountUplink(next, added.value.message.length, deps.now());
}

/**
 * 溜まっている音声を送り切る（退出時・停止時）。
 * **音声は決して捨てない**（wire-format.md 1.4）。
 */
export function flushAudio(state: SendPipelineState, senderId: number, deps: SendDeps): SendPipelineState {
  const flushed = flush(state.audio, senderId, CHANNEL_AUDIO);
  if (!flushed.ok) {
    return { ...state, encodeErrors: state.encodeErrors + 1 };
  }
  const next: SendPipelineState = { ...state, audio: flushed.value.state };
  if (flushed.value.message === null) {
    return next;
  }
  deps.sendAudio(flushed.value.message);
  return accountUplink(next, flushed.value.message.length, deps.now());
}

/** 観測用。上り帯域（bits/sec）。 */
export function uplinkBpsOf(state: SendPipelineState): number {
  return state.uplinkBps;
}
