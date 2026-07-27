/**
 * 実音声映像の照合（TypeScript、段 A の実データ版）。
 *
 * 何を証明するか: 合成したベクタではなく、**実際に符号化された AV1 と Opus** に対して、
 * ワイヤ形式の符号化・復号が往復で一致し、破棄可否と破棄優先順位の判断が凍結資産と
 * 一致すること。同じ資産を 6 言語すべてが照合する（言語間の差はここで露出する）。
 *
 * 資産の作り方は tools/real-media.ts にある。資産を実装に合わせて変更してはならない（ADR-0012）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  computeDiscardable,
  dropPriority,
  decodeMediaMessage,
  encodeMediaMessage,
  type MediaMessage,
} from "../packages/core/src/wire.ts";
import { CHANNEL_AUDIO, CHANNEL_VIDEO } from "../packages/core/src/generated/wire-layout.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.trunc(hex.length / 2));
  for (let index = 0; index + 1 < hex.length; index += 2) {
    bytes[Math.trunc(index / 2)] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function readAsset(): Record<string, unknown> {
  const text = readFileSync(new URL("../spec/vectors/real-media.json", import.meta.url), "utf8");
  const value: unknown = JSON.parse(text);
  assert.ok(isRecord(value), "資産が連想配列である");
  return value;
}

function numberOf(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  assert.equal(typeof value, "number", `${key} が数値である`);
  return typeof value === "number" ? value : 0;
}

function textOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  assert.equal(typeof value, "string", `${key} が文字列である`);
  return typeof value === "string" ? value : "";
}

function boolOf(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  assert.equal(typeof value, "boolean", `${key} が真偽値である`);
  return value === true;
}

test("実 AV1 の資産が空でなく、キーフレームと時間層 3 層を含む", () => {
  const asset = readAsset();
  const video = asset["video"];
  assert.ok(isRecord(video));
  const frames = video["frames"];
  assert.ok(Array.isArray(frames));
  assert.ok(frames.length >= 30, `映像が 30 枚以上ある（実際 ${frames.length}）`);
  assert.equal(numberOf(video, "temporalLayers"), 3, "L1T3 である");

  const temporalIds = new Set<number>();
  let keyFrames = 0;
  for (const frame of frames) {
    assert.ok(isRecord(frame));
    temporalIds.add(numberOf(frame, "temporalId"));
    if (boolOf(frame, "keyFrame")) {
      keyFrames += 1;
    }
    assert.ok(textOf(frame, "payloadHex").length > 0, "ペイロードが空でない");
  }
  assert.deepEqual([...temporalIds].sort(), [0, 1, 2], "時間層 0〜2 が現れる");
  assert.ok(keyFrames >= 1, "キーフレームを含む");
});

test("実 AV1 のワイヤ符号化が資産のバイト列と一致し、復号が往復する", () => {
  const asset = readAsset();
  const senderId = numberOf(asset, "senderId");
  const video = asset["video"];
  assert.ok(isRecord(video));
  const frames = video["frames"];
  assert.ok(Array.isArray(frames));
  const framerate = numberOf(video, "framerate");

  let checked = 0;
  for (const frame of frames) {
    assert.ok(isRecord(frame));
    const sequenceNumber = numberOf(frame, "sequenceNumber");
    const payload = hexToBytes(textOf(frame, "payloadHex"));
    const message: MediaMessage = {
      channel: CHANNEL_VIDEO,
      senderId,
      units: [
        {
          sequenceNumber,
          captureTimestampUs: BigInt(Math.trunc(((sequenceNumber - 1) * 1_000_000) / framerate)),
          flags: numberOf(frame, "expectedFlags"),
          spatialId: numberOf(frame, "spatialId"),
          temporalId: numberOf(frame, "temporalId"),
          payload,
        },
      ],
    };
    const encoded = encodeMediaMessage(message);
    assert.equal(encoded.ok, true, "符号化できる");
    if (!encoded.ok) {
      return;
    }
    assert.equal(bytesToHex(encoded.value), textOf(frame, "expectedMessageHex"), `映像 ${sequenceNumber} のバイト列`);

    const decoded = decodeMediaMessage(encoded.value);
    assert.equal(decoded.ok, true, "復号できる");
    if (!decoded.ok) {
      return;
    }
    const unit = decoded.value.units[0];
    assert.ok(unit !== undefined);
    assert.equal(bytesToHex(unit?.payload ?? new Uint8Array()), textOf(frame, "payloadHex"), "ペイロードが往復する");
    checked += 1;
  }
  assert.ok(checked >= 30, `30 枚以上を照合した（実際 ${checked}）`);
});

test("実 AV1 の破棄可否と破棄優先順位が資産と一致する", () => {
  const asset = readAsset();
  const video = asset["video"];
  assert.ok(isRecord(video));
  const frames = video["frames"];
  assert.ok(Array.isArray(frames));
  const temporalLayers = numberOf(video, "temporalLayers");

  let discardableCount = 0;
  for (const frame of frames) {
    assert.ok(isRecord(frame));
    const flags = numberOf(frame, "expectedFlags");
    const discardable = computeDiscardable(
      CHANNEL_VIDEO,
      boolOf(frame, "keyFrame"),
      numberOf(frame, "temporalId"),
      temporalLayers,
    );
    assert.equal(discardable, boolOf(frame, "expectedDiscardable"), "破棄可否が一致する");
    if (discardable) {
      discardableCount += 1;
    }
    const priority = dropPriority(CHANNEL_VIDEO, flags);
    const expected = frame["expectedDropPriority"];
    if (expected === null) {
      assert.equal(priority, null, "破棄禁止が一致する");
    } else {
      assert.equal(priority, expected, "優先順位が一致する");
    }
  }
  // 最上位の時間層は破棄可能である。1 枚も無ければ判断を検証していない。
  assert.ok(discardableCount > 0, `破棄可能なフレームがある（実際 ${discardableCount} 枚）`);
});

test("実 Opus の束ねが資産のバイト列と一致し、音声は破棄禁止である", () => {
  const asset = readAsset();
  const senderId = numberOf(asset, "senderId");
  const audio = asset["audio"];
  assert.ok(isRecord(audio));
  const bundles = audio["bundles"];
  assert.ok(Array.isArray(bundles));
  assert.ok(bundles.length >= 20, `音声束が 20 個以上ある（実際 ${bundles.length}）`);
  const frameMs = numberOf(audio, "frameMs");
  const unitsPerMessage = numberOf(audio, "unitsPerMessage");

  let checked = 0;
  for (let index = 0; index < bundles.length; index += 1) {
    const bundle = bundles[index];
    assert.ok(isRecord(bundle));
    const payloads = bundle["payloadsHex"];
    assert.ok(Array.isArray(payloads));
    assert.equal(payloads.length, unitsPerMessage, "束ねる数が規範どおりである");
    const first = numberOf(bundle, "firstSequenceNumber");
    const flags = numberOf(bundle, "expectedFlags");

    const units = payloads.map((payloadHex, offset) => {
      assert.equal(typeof payloadHex, "string");
      const hex = typeof payloadHex === "string" ? payloadHex : "";
      return {
        sequenceNumber: first + offset,
        captureTimestampUs: BigInt((index * unitsPerMessage + offset) * frameMs * 1000),
        flags,
        spatialId: 0,
        temporalId: 0,
        payload: hexToBytes(hex),
      };
    });
    const encoded = encodeMediaMessage({ channel: CHANNEL_AUDIO, senderId, units });
    assert.equal(encoded.ok, true, "符号化できる");
    if (!encoded.ok) {
      return;
    }
    assert.equal(bytesToHex(encoded.value), textOf(bundle, "expectedMessageHex"), `音声束 ${index} のバイト列`);

    const decoded = decodeMediaMessage(encoded.value);
    assert.equal(decoded.ok, true, "復号できる");
    if (!decoded.ok) {
      return;
    }
    assert.equal(decoded.value.units.length, unitsPerMessage, "ユニット数が往復する");

    // 音声は決して破棄しない（規範）。
    assert.equal(dropPriority(CHANNEL_AUDIO, flags), null, "音声は破棄禁止である");
    assert.equal(computeDiscardable(CHANNEL_AUDIO, false, 0, 1), false, "音声は破棄可能にならない");
    checked += 1;
  }
  assert.ok(checked >= 20, `20 束以上を照合した（実際 ${checked}）`);
});
