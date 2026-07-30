/**
 * 音声の送出（束ねとワイヤ化）。
 *
 * 規範: ADR-0005（音声を `AUDIO_BUNDLE_MS` 単位で束ねて送る）、wire-format.md 1.5、
 *       ADR-0030（in-band FEC を無効にする）、constants.md 3 節。
 *
 * **なぜ束ねるか。** Opus のフレームは 20 ms（`OPUS_FRAME_MS`）である。1 フレームを
 * 1 メッセージで送ると、80 バイトのペイロードに 28 バイトのヘッダが付き、
 * メッセージレートも 50 msg/s になる。中継 DO の制約はメッセージレートであるため
 * （F-024）、束ねることで収容人数が 80 人から 160 人へ増える。
 *
 * **なぜ束ね数を固定にするか。** `AUDIO_UNITS_PER_MESSAGE` は
 * `AUDIO_BUNDLE_MS / OPUS_FRAME_MS` から導出される。実行中に変えると、受信側の
 * ジッタバッファの深さの計算（`constants.md` 7 節）が合わなくなる。
 *
 * 束ねの判断は純関数である。実際の `AudioEncoder` は端が持つ。
 */

import {
  A_MUSIC,
  A_VOICE,
  AUDIO_DTX_ENABLED,
  AUDIO_FEC_ENABLED,
  AUDIO_UNITS_PER_MESSAGE,
} from "@wheso/core/src/generated/constants.ts";
import { CHANNEL_AUDIO, FLAG_DTX, FLAG_END_OF_FRAME } from "@wheso/core/src/generated/wire-layout.ts";
import { encodeMediaMessage, type Unit } from "@wheso/core/src/wire.ts";
import { type Result, err, ok } from "@wheso/core/src/result.ts";

export interface AudioSendError {
  readonly code: string;
  readonly detail: string;
}

/** 符号化された Opus フレーム 1 個。 */
export interface OpusFrame {
  readonly sequenceNumber: number;
  readonly captureTimestampUs: bigint;
  /** 無音区間か（DTX）。受信側はロスと解釈せず快適雑音を作る。 */
  readonly silent: boolean;
  readonly payload: Uint8Array;
}

/** 束ねの状態。溜まったフレームを保持する。 */
export interface AudioBundleState {
  /** 溜まっているフレーム。`AUDIO_UNITS_PER_MESSAGE` に達したら送る。 */
  readonly pending: readonly OpusFrame[];
}

export function initialAudioBundle(): AudioBundleState {
  return { pending: [] };
}

export interface BundleResult {
  readonly state: AudioBundleState;
  /** 送るべきバイト列。まだ溜める途中なら null。 */
  readonly message: Uint8Array | null;
}

/**
 * フレームを 1 個加える。`AUDIO_UNITS_PER_MESSAGE` に達したらメッセージを作る。
 *
 * `sequenceNumber` は同一 (senderId, channel, spatialId) 内で単調増加しなければならない
 * （wire-format.md 1.2）。束ねの中では昇順に並べる。順序が崩れると
 * `E_WIRE_UNIT_ORDER` で接続が閉じられる。
 */
export function addFrame(
  state: AudioBundleState,
  frame: OpusFrame,
  senderId: number,
  channel: number = CHANNEL_AUDIO,
): Result<BundleResult, AudioSendError> {
  const pending = [...state.pending, frame].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  if (pending.length < AUDIO_UNITS_PER_MESSAGE) {
    return ok({ state: { pending }, message: null });
  }
  const units: Unit[] = pending.map((entry) => ({
    sequenceNumber: entry.sequenceNumber,
    captureTimestampUs: entry.captureTimestampUs,
    // 音声は常に破棄禁止である（wire-format.md 1.3）。DISCARDABLE を立てない。
    flags: FLAG_END_OF_FRAME | (entry.silent ? FLAG_DTX : 0),
    spatialId: 0,
    temporalId: 0,
    payload: entry.payload,
  }));
  const encoded = encodeMediaMessage({ channel, senderId, units });
  if (!encoded.ok) {
    return err({ code: encoded.error.code, detail: encoded.error.detail });
  }
  return ok({ state: { pending: [] }, message: encoded.value });
}

/**
 * 溜まっているものを強制的に送る（通話の終了時、または話し終わりの区切り）。
 *
 * 溜めたまま捨てると音声が欠ける。**音声は決して捨てない**（wire-format.md 1.4）。
 */
export function flush(
  state: AudioBundleState,
  senderId: number,
  channel: number = CHANNEL_AUDIO,
): Result<BundleResult, AudioSendError> {
  if (state.pending.length === 0) {
    return ok({ state, message: null });
  }
  const units: Unit[] = [...state.pending]
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
    .map((entry) => ({
      sequenceNumber: entry.sequenceNumber,
      captureTimestampUs: entry.captureTimestampUs,
      flags: FLAG_END_OF_FRAME | (entry.silent ? FLAG_DTX : 0),
      spatialId: 0,
      temporalId: 0,
      payload: entry.payload,
    }));
  const encoded = encodeMediaMessage({ channel, senderId, units });
  if (!encoded.ok) {
    return err({ code: encoded.error.code, detail: encoded.error.detail });
  }
  return ok({ state: { pending: [] }, message: encoded.value });
}

/** 音声の符号化の設定。`AudioEncoder.configure` へ渡す形である。 */
export interface AudioEncoderConfig {
  readonly codec: string;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly bitrate: number;
  /** 無音区間の送信を止めるか。狭帯域で有効に効く。 */
  readonly dtx: boolean;
  /**
   * in-band FEC を使うか。
   *
   * **TCP 上では常に false である**（ADR-0030）。ロスが起こらない経路では 1 バイトも
   * 役に立たず、ビットレートだけを 20〜30% 押し上げる。
   */
  readonly fec: boolean;
}

/** 音声の設定を作る（sdk-api.md 2 節の `audioProfile`）。 */
export function audioConfigFor(profile: "voice" | "music"): AudioEncoderConfig {
  const constant = profile === "music" ? A_MUSIC : A_VOICE;
  return {
    codec: "opus",
    // Opus の標準の標本化周波数。`OPUS_FRAME_MS` の導出と対応する。
    sampleRate: 48000,
    numberOfChannels: constant.channels,
    bitrate: constant.bitrate,
    dtx: AUDIO_DTX_ENABLED,
    fec: AUDIO_FEC_ENABLED,
  };
}


