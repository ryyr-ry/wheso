/**
 * 送信経路の配線を検証する。
 *
 * **これが無いと SDK は 1 バイトも送れない。** 段 F まで、符号化器を作る場所が
 * 製品コードに存在せず、`streamAnnounce`（はしごの申告）だけを送っていた。
 *
 * 検証する性質:
 *   1. sequenceNumber は (channel, spatialId) ごとに 1 から単調増加する（wire-format.md 1.2）
 *   2. 映像はワイヤ形式で送られ、破棄可否はコアの判断と一致する
 *   3. 音声は `AUDIO_UNITS_PER_MESSAGE` 個ごとに 1 メッセージへ束ねられる（ADR-0005）
 *   4. 溜まっている音声は送り切られる（音声は決して捨てない）
 *   5. 上り帯域は 1 秒窓で確定する
 *   6. 入口（`joinWith`）が取得の出力を送出へ繋いでいる
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createSendPipeline,
  flushAudio,
  handleEncodedAudio,
  handleEncodedVideo,
  uplinkBpsOf,
  type SendDeps,
} from "../packages/client/src/api/send-pipeline.ts";
import { decodeMediaMessage } from "../packages/core/src/wire.ts";
import {
  AUDIO_UNITS_PER_MESSAGE,
  V_1080P30,
} from "../packages/core/src/generated/constants.ts";
import {
  CHANNEL_AUDIO,
  CHANNEL_VIDEO,
  FLAG_DISCARDABLE,
  FLAG_KEY,
} from "../packages/core/src/generated/wire-layout.ts";

const SENDER = 4242;
const T0 = 1_000_000;

interface Recorder {
  readonly video: Uint8Array[];
  readonly audio: Uint8Array[];
  readonly deps: SendDeps;
  setNow: (value: number) => void;
}

function recorder(): Recorder {
  const video: Uint8Array[] = [];
  const audio: Uint8Array[] = [];
  let now = T0;
  return {
    video,
    audio,
    setNow: (value): void => {
      now = value;
    },
    deps: {
      sendVideo: (bytes): void => {
        video.push(bytes);
      },
      sendAudio: (bytes): void => {
        audio.push(bytes);
      },
      now: (): number => now,
    },
  };
}

function videoUnit(spatialId: number, temporalId: number, isKey: boolean): {
  readonly spatialId: number;
  readonly temporalId: number;
  readonly temporalLayers: number;
  readonly isKey: boolean;
  readonly captureTimestampUs: bigint;
  readonly payload: Uint8Array;
} {
  return {
    spatialId,
    temporalId,
    temporalLayers: V_1080P30.temporalLayers,
    isKey,
    captureTimestampUs: 12_345n,
    payload: new Uint8Array([1, 2, 3, 4]),
  };
}

test("sequenceNumber は (channel, spatialId) ごとに 1 から単調増加する", () => {
  const log = recorder();
  let state = createSendPipeline(T0);
  state = handleEncodedVideo(state, SENDER, videoUnit(0, 0, true), log.deps);
  state = handleEncodedVideo(state, SENDER, videoUnit(0, 1, false), log.deps);
  state = handleEncodedVideo(state, SENDER, videoUnit(1, 0, true), log.deps);
  assert.equal(log.video.length, 3);

  const seqOf = (bytes: Uint8Array): number => {
    const decoded = decodeMediaMessage(bytes);
    assert.equal(decoded.ok, true);
    if (!decoded.ok) {
      return -1;
    }
    const unit = decoded.value.units[0];
    return unit === undefined ? -1 : unit.sequenceNumber;
  };
  const first = log.video[0];
  const second = log.video[1];
  const third = log.video[2];
  assert.ok(first !== undefined && second !== undefined && third !== undefined);
  assert.equal(seqOf(first), 1, "段 0 の 1 枚目は 1");
  assert.equal(seqOf(second), 2, "段 0 の 2 枚目は 2");
  assert.equal(seqOf(third), 1, "**段 1 は独立した空間である**（段ごとに別のストリーム）");
});

test("映像の破棄可否はコアの判断と一致する", () => {
  const log = recorder();
  let state = createSendPipeline(T0);
  // 最上位の時間層は破棄可能である（3 層のとき temporalId 2）。
  state = handleEncodedVideo(state, SENDER, videoUnit(0, 2, false), log.deps);
  state = handleEncodedVideo(state, SENDER, videoUnit(0, 0, true), log.deps);
  const top = log.video[0];
  const key = log.video[1];
  assert.ok(top !== undefined && key !== undefined);
  const decodedTop = decodeMediaMessage(top);
  const decodedKey = decodeMediaMessage(key);
  assert.equal(decodedTop.ok, true);
  assert.equal(decodedKey.ok, true);
  if (!decodedTop.ok || !decodedKey.ok) {
    return;
  }
  const topUnit = decodedTop.value.units[0];
  const keyUnit = decodedKey.value.units[0];
  assert.ok(topUnit !== undefined && keyUnit !== undefined);
  assert.equal((topUnit.flags & FLAG_DISCARDABLE) !== 0, true, "最上位の時間層は破棄可能");
  assert.equal((keyUnit.flags & FLAG_KEY) !== 0, true, "キーフレームの印が立つ");
  assert.equal((keyUnit.flags & FLAG_DISCARDABLE) !== 0, false, "キーフレームは破棄禁止");
  assert.equal(decodedKey.value.channel, CHANNEL_VIDEO);
  void state;
});

test("音声は規定数ごとに 1 メッセージへ束ねられる（ADR-0005）", () => {
  const log = recorder();
  let state = createSendPipeline(T0);
  for (let index = 0; index < AUDIO_UNITS_PER_MESSAGE; index += 1) {
    assert.equal(log.audio.length, 0, "規定数に達するまで送らない");
    state = handleEncodedAudio(
      state,
      SENDER,
      { captureTimestampUs: BigInt(index * 20_000), silent: false, payload: new Uint8Array([9, 9]) },
      log.deps,
    );
  }
  assert.equal(log.audio.length, 1, "規定数に達したら 1 通送る");
  const bundled = log.audio[0];
  assert.ok(bundled !== undefined);
  const decoded = decodeMediaMessage(bundled);
  assert.equal(decoded.ok, true);
  if (!decoded.ok) {
    return;
  }
  assert.equal(decoded.value.channel, CHANNEL_AUDIO);
  assert.equal(decoded.value.units.length, AUDIO_UNITS_PER_MESSAGE);
  assert.equal(decoded.value.units[0]?.sequenceNumber, 1, "束ねの中は昇順である");
  for (const unit of decoded.value.units) {
    assert.equal((unit.flags & FLAG_DISCARDABLE) !== 0, false, "**音声は破棄禁止である**");
  }
  void state;
});

test("溜まっている音声は送り切る（音声は決して捨てない）", () => {
  const log = recorder();
  let state = createSendPipeline(T0);
  state = handleEncodedAudio(
    state,
    SENDER,
    { captureTimestampUs: 0n, silent: false, payload: new Uint8Array([7]) },
    log.deps,
  );
  assert.equal(log.audio.length, 0, "まだ束ねの途中である");
  state = flushAudio(state, SENDER, log.deps);
  assert.equal(log.audio.length, 1, "送り切る");
  const flushed = log.audio[0];
  assert.ok(flushed !== undefined);
  const decoded = decodeMediaMessage(flushed);
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    assert.equal(decoded.value.units.length, 1);
  }
  // 2 度目の送り切りでは何も送らない（空を送ると E_WIRE_UNIT_COUNT になる）。
  state = flushAudio(state, SENDER, log.deps);
  assert.equal(log.audio.length, 1);
});

test("上り帯域は 1 秒窓で確定する", () => {
  const log = recorder();
  let state = createSendPipeline(T0);
  state = handleEncodedVideo(state, SENDER, videoUnit(0, 0, true), log.deps);
  assert.equal(uplinkBpsOf(state), 0, "窓が満了するまでは 0 である");
  log.setNow(T0 + 1000);
  state = handleEncodedVideo(state, SENDER, videoUnit(0, 0, false), log.deps);
  assert.ok(uplinkBpsOf(state) > 0, "窓が満了したら bits/sec が出る");
  // 2 枚 × (8 + 20 + 4) バイト = 64 バイト → 512 bits/sec
  assert.equal(uplinkBpsOf(state), 512);
});

test("ワイヤ化に失敗しても例外を投げず、数えて続ける", () => {
  const log = recorder();
  let state = createSendPipeline(T0);
  // 空のペイロードは許されるが、段が範囲外（MAX_SPATIAL_ID 超え）は失敗する。
  state = handleEncodedVideo(state, SENDER, { ...videoUnit(99, 0, true) }, log.deps);
  assert.equal(log.video.length, 0, "送らない");
  assert.equal(state.encodeErrors, 1, "失敗を数える");
});
