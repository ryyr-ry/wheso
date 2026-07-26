/**
 * エンコーダ層の純粋部分の試験。
 *
 * WebCodecs 自体はブラウザでのみ動くため、ここでは
 * 「設定の引き当て」「ワイヤ形式への詰め込み」「temporalId の取り出し」を検証する。
 * 実際の符号化は E2E 試験（ブラウザ）で確認する。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  codecOf,
  packEncoded,
  specOf,
  temporalIdFrom,
} from "../packages/client/src/media/encoder-set.ts";
import { decodeMediaMessage } from "../packages/core/src/wire.ts";
import { V_360P15, V_4K60 } from "../packages/core/src/generated/constants.ts";
import {
  CHANNEL_AUDIO,
  CHANNEL_VIDEO,
  FLAG_DISCARDABLE,
  FLAG_KEY,
} from "../packages/core/src/generated/wire-layout.ts";

test("プロファイルの設定は定数から引かれる", () => {
  const spec = specOf("V_4K60");
  assert.equal(spec.ok, true);
  if (spec.ok) {
    assert.equal(spec.value.width, V_4K60.width);
    assert.equal(spec.value.bitrate, V_4K60.targetBitrate);
    assert.equal(spec.value.scalabilityMode, V_4K60.scalabilityMode);
    assert.equal(spec.value.temporalLayers, 3, "L1T3 は時間層 3 段");
  }
});

test("サムネイルは L1T2 であり時間層は 2 段", () => {
  const spec = specOf("V_360P15");
  assert.equal(spec.ok, true);
  if (spec.ok) {
    assert.equal(spec.value.scalabilityMode, V_360P15.scalabilityMode);
    assert.equal(spec.value.temporalLayers, 2);
  }
});

test("H.264 は単層として扱う（temporal SVC が使えないため）", () => {
  const spec = specOf("H264_1080P30");
  assert.equal(spec.ok, true);
  if (spec.ok) {
    assert.equal(spec.value.temporalLayers, 1);
    assert.equal(spec.value.scalabilityMode, "L1T1");
  }
  assert.ok(codecOf("H264_1080P30").startsWith("avc1"));
  assert.ok(codecOf("V_4K60").startsWith("av01"));
});

test("最上位の時間層は DISCARDABLE が立つ（core の判定に従う）", () => {
  const packed = packEncoded({
    channel: CHANNEL_VIDEO,
    senderId: 7,
    sequenceNumber: 10,
    captureTimestampUs: 1_000_000n,
    spatialId: 3,
    temporalId: 2,
    temporalLayers: 3,
    isKey: false,
    payload: new Uint8Array(16),
  });
  assert.equal(packed.ok, true);
  if (!packed.ok) {
    return;
  }
  const decoded = decodeMediaMessage(packed.value);
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    const unit = decoded.value.units[0];
    assert.equal((unit?.flags ?? 0) & FLAG_DISCARDABLE, FLAG_DISCARDABLE);
  }
});

test("キーフレームは DISCARDABLE が立たない", () => {
  const packed = packEncoded({
    channel: CHANNEL_VIDEO,
    senderId: 7,
    sequenceNumber: 1,
    captureTimestampUs: 0n,
    spatialId: 3,
    temporalId: 0,
    temporalLayers: 3,
    isKey: true,
    payload: new Uint8Array(16),
  });
  assert.equal(packed.ok, true);
  if (!packed.ok) {
    return;
  }
  const decoded = decodeMediaMessage(packed.value);
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    const unit = decoded.value.units[0];
    assert.equal((unit?.flags ?? 0) & FLAG_KEY, FLAG_KEY);
    assert.equal((unit?.flags ?? 0) & FLAG_DISCARDABLE, 0);
  }
});

test("音声は DISCARDABLE が立たない（音声は捨てない）", () => {
  const packed = packEncoded({
    channel: CHANNEL_AUDIO,
    senderId: 7,
    sequenceNumber: 1,
    captureTimestampUs: 0n,
    spatialId: 0,
    temporalId: 0,
    temporalLayers: 1,
    isKey: false,
    payload: new Uint8Array(80),
  });
  assert.equal(packed.ok, true);
  if (!packed.ok) {
    return;
  }
  const decoded = decodeMediaMessage(packed.value);
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    assert.equal((decoded.value.units[0]?.flags ?? 0) & FLAG_DISCARDABLE, 0);
  }
});

test("詰め込んだメッセージは往復して同じ内容になる", () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const packed = packEncoded({
    channel: CHANNEL_VIDEO,
    senderId: 12345,
    sequenceNumber: 4821,
    captureTimestampUs: 1_784_973_771_566_000n,
    spatialId: 2,
    temporalId: 1,
    temporalLayers: 3,
    isKey: false,
    payload,
  });
  assert.equal(packed.ok, true);
  if (!packed.ok) {
    return;
  }
  const decoded = decodeMediaMessage(packed.value);
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    assert.equal(decoded.value.senderId, 12345);
    const unit = decoded.value.units[0];
    assert.equal(unit?.sequenceNumber, 4821);
    assert.equal(unit?.captureTimestampUs, 1_784_973_771_566_000n);
    assert.equal(unit?.spatialId, 2);
    assert.equal(unit?.temporalId, 1);
    assert.deepEqual(unit?.payload, payload);
  }
});

test("temporalId は実装差を吸収して取り出せる", () => {
  assert.equal(temporalIdFrom({ svc: { temporalLayerId: 2 } }), 2, "svc の下にある場合");
  assert.equal(temporalIdFrom({ temporalLayerId: 1 }), 1, "直下にある場合");
  assert.equal(temporalIdFrom({}), 0, "無い場合は単層として扱う");
  assert.equal(temporalIdFrom(null), 0);
  assert.equal(temporalIdFrom({ svc: { temporalLayerId: "x" } }), 0, "数でなければ 0");
});
