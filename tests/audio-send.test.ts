/**
 * 音声の送出（束ねとワイヤ化）を検証する（段 F の F-8）。
 *
 * 規範: ADR-0005（`AUDIO_BUNDLE_MS` 単位で束ねる）、ADR-0030（FEC を無効にする）、
 *       wire-format.md 1.3（音声は常に破棄禁止）。
 *
 * 検証する性質:
 *   1. `AUDIO_UNITS_PER_MESSAGE` に達するまで送らない
 *   2. 達したら 1 メッセージにまとめ、往復して元に戻る
 *   3. **音声は DISCARDABLE を立てない**（決して破棄しない）
 *   4. DTX の印が保たれる（受信側がロスと解釈しない）
 *   5. `flush` は溜まったものを捨てない
 *   6. **FEC は無効である**（TCP 上では無意味）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addFrame,
  audioConfigFor,
  flush,
  initialAudioBundle,
  type AudioBundleState,
  type OpusFrame,
} from "../packages/client/src/media/audio-send.ts";
import { decodeMediaMessage } from "../packages/core/src/wire.ts";
import {
  AUDIO_UNITS_PER_MESSAGE,
  A_MUSIC,
  A_VOICE,
  OPUS_FRAME_MS,
} from "../packages/core/src/generated/constants.ts";
import {
  CHANNEL_AUDIO,
  FLAG_DISCARDABLE,
  FLAG_DTX,
} from "../packages/core/src/generated/wire-layout.ts";

const SENDER = 4242;

function frame(seq: number, silent = false): OpusFrame {
  return {
    sequenceNumber: seq,
    captureTimestampUs: BigInt(seq * OPUS_FRAME_MS * 1000),
    silent,
    payload: new Uint8Array(A_VOICE.bytesPerPacket).fill(seq),
  };
}

/** 規定数だけ溜めて、できたメッセージを返す。 */
function bundle(frames: readonly OpusFrame[]): { state: AudioBundleState; message: Uint8Array | null } {
  let state = initialAudioBundle();
  let message: Uint8Array | null = null;
  for (const entry of frames) {
    const result = addFrame(state, entry, SENDER);
    assert.equal(result.ok, true, "束ねに失敗しない");
    if (!result.ok) {
      break;
    }
    state = result.value.state;
    if (result.value.message !== null) {
      message = result.value.message;
    }
  }
  return { state, message };
}

test("規定数に達するまで送らない", () => {
  let state = initialAudioBundle();
  for (let i = 1; i < AUDIO_UNITS_PER_MESSAGE; i += 1) {
    const result = addFrame(state, frame(i), SENDER);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.message, null, `${String(i)} 個目では送らない`);
    state = result.value.state;
  }
  assert.equal(state.pending.length, AUDIO_UNITS_PER_MESSAGE - 1);
});

test("規定数に達したら 1 メッセージにまとめ、往復して元に戻る", () => {
  const frames: OpusFrame[] = [];
  for (let i = 1; i <= AUDIO_UNITS_PER_MESSAGE; i += 1) {
    frames.push(frame(i));
  }
  const result = bundle(frames);
  assert.notEqual(result.message, null, "メッセージができる");
  assert.equal(result.state.pending.length, 0, "溜まりは空になる");

  const decoded = decodeMediaMessage(result.message ?? new Uint8Array(0));
  assert.equal(decoded.ok, true);
  if (!decoded.ok) {
    return;
  }
  assert.equal(decoded.value.channel, CHANNEL_AUDIO);
  assert.equal(decoded.value.senderId, SENDER);
  assert.equal(decoded.value.units.length, AUDIO_UNITS_PER_MESSAGE);
  for (let i = 0; i < AUDIO_UNITS_PER_MESSAGE; i += 1) {
    const unit: { sequenceNumber: number; captureTimestampUs: bigint; payload: Uint8Array } | undefined =
      decoded.value.units[i];
    const source = frames[i];
    assert.ok(unit !== undefined && source !== undefined);
    assert.equal(unit.sequenceNumber, source.sequenceNumber);
    assert.equal(unit.captureTimestampUs, source.captureTimestampUs);
    assert.deepEqual([...unit.payload], [...source.payload], "ペイロードが往復する");
  }
});

test("**音声は DISCARDABLE を立てない**（決して破棄しない）", () => {
  const frames: OpusFrame[] = [];
  for (let i = 1; i <= AUDIO_UNITS_PER_MESSAGE; i += 1) {
    frames.push(frame(i));
  }
  const result = bundle(frames);
  const decoded = decodeMediaMessage(result.message ?? new Uint8Array(0));
  assert.equal(decoded.ok, true);
  if (!decoded.ok) {
    return;
  }
  for (const unit of decoded.value.units) {
    assert.equal(unit.flags & FLAG_DISCARDABLE, 0, "破棄可能の印を立てない");
    assert.equal(unit.spatialId, 0, "音声は段を持たない");
    assert.equal(unit.temporalId, 0);
  }
});

test("DTX の印が保たれる（受信側がロスと解釈しない）", () => {
  const frames: OpusFrame[] = [];
  for (let i = 1; i <= AUDIO_UNITS_PER_MESSAGE; i += 1) {
    frames.push(frame(i, i % 2 === 0));
  }
  const result = bundle(frames);
  const decoded = decodeMediaMessage(result.message ?? new Uint8Array(0));
  assert.equal(decoded.ok, true);
  if (!decoded.ok) {
    return;
  }
  for (let i = 0; i < AUDIO_UNITS_PER_MESSAGE; i += 1) {
    const unit: { flags: number } | undefined = decoded.value.units[i];
    assert.ok(unit !== undefined);
    const expected = (i + 1) % 2 === 0;
    assert.equal((unit.flags & FLAG_DTX) !== 0, expected, `${String(i)} 個目の DTX`);
  }
});

test("順序が崩れて渡されても昇順に並べる（E_WIRE_UNIT_ORDER を避ける）", () => {
  let state = initialAudioBundle();
  // 逆順に渡す。
  for (let i = AUDIO_UNITS_PER_MESSAGE; i >= 1; i -= 1) {
    const result = addFrame(state, frame(i), SENDER);
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    state = result.value.state;
    if (result.value.message !== null) {
      const decoded = decodeMediaMessage(result.value.message);
      assert.equal(decoded.ok, true, "昇順に並べたので符号化できる");
      if (!decoded.ok) {
        return;
      }
      const sequences = decoded.value.units.map((unit) => unit.sequenceNumber);
      const sorted = [...sequences].sort((a, b) => a - b);
      assert.deepEqual(sequences, sorted);
    }
  }
});

test("flush は溜まったものを捨てない", () => {
  const partial = addFrame(initialAudioBundle(), frame(1), SENDER);
  assert.equal(partial.ok, true);
  if (!partial.ok) {
    return;
  }
  assert.equal(partial.value.message, null);
  const flushed = flush(partial.value.state, SENDER);
  assert.equal(flushed.ok, true);
  if (!flushed.ok) {
    return;
  }
  assert.notEqual(flushed.value.message, null, "溜まっていたものを送る");
  const decoded = decodeMediaMessage(flushed.value.message ?? new Uint8Array(0));
  assert.equal(decoded.ok, true);
  if (!decoded.ok) {
    return;
  }
  assert.equal(decoded.value.units.length, 1);
});

test("溜まりが空なら flush は何も作らない", () => {
  const flushed = flush(initialAudioBundle(), SENDER);
  assert.equal(flushed.ok, true);
  if (!flushed.ok) {
    return;
  }
  assert.equal(flushed.value.message, null);
});

test("**FEC は無効である**（TCP 上では無意味。ADR-0030）", () => {
  const voice = audioConfigFor("voice");
  assert.equal(voice.fec, false, "in-band FEC を使わない");
  assert.equal(voice.dtx, true, "DTX は使う（狭帯域で効く）");
  assert.equal(voice.bitrate, A_VOICE.bitrate);
  assert.equal(voice.numberOfChannels, A_VOICE.channels);

  const music = audioConfigFor("music");
  assert.equal(music.bitrate, A_MUSIC.bitrate);
  assert.equal(music.numberOfChannels, A_MUSIC.channels);
  assert.equal(music.fec, false);
});

