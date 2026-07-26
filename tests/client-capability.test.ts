/**
 * 送信プロファイルの選択と報告作成の試験。
 * 規範: sdk-api.md 2 節の決定手順、wire-format.md 2.6（ADR-0021）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildReport,
  buildStreamAnnounce,
  selectProfiles,
  spatialIdOf,
  type DeviceCapability,
} from "../packages/client/src/media/capability.ts";
import { DELAY_TREND_WINDOW, V_4K60 } from "../packages/core/src/generated/constants.ts";
import { CHANNEL_VIDEO } from "../packages/core/src/generated/wire-layout.ts";

const base: DeviceCapability = {
  hardwareAv1For4K60: false,
  encodeAv1: true,
  mobile: false,
  charging: true,
};

test("手順 1: ハードウェア AV1 で 4K60 が出るなら 4K60 とサムネイル", () => {
  assert.deepEqual(selectProfiles({ ...base, hardwareAv1For4K60: true }), ["V_4K60", "V_360P15"]);
});

test("手順 2: 携帯かつ非充電なら 1080p30 とサムネイル", () => {
  assert.deepEqual(selectProfiles({ ...base, mobile: true, charging: false }), ["V_1080P30", "V_360P15"]);
});

test("手順 2: 携帯でも充電中なら 1080p60 とサムネイル", () => {
  assert.deepEqual(selectProfiles({ ...base, mobile: true, charging: true }), ["V_1080P60", "V_360P15"]);
});

test("手順 3: AV1 が使えないなら H.264 の 2 本", () => {
  assert.deepEqual(selectProfiles({ ...base, encodeAv1: false }), ["H264_1080P30", "H264_360P15"]);
});

test("サムネイルは常に含まれる（誰にでも渡せる最低品質を確保する）", () => {
  const cases: readonly DeviceCapability[] = [
    { ...base, hardwareAv1For4K60: true },
    { ...base },
    { ...base, mobile: true, charging: false },
    { ...base, encodeAv1: false },
  ];
  for (const capability of cases) {
    const profiles = selectProfiles(capability);
    assert.equal(profiles.length, 2, "常に 2 本");
    assert.ok(
      profiles.some((profile) => spatialIdOf(profile) === 0),
      "最低品質を含む",
    );
  }
});

test("同じ入力に対して常に同じ結果を返す（9 言語で一致させるため）", () => {
  const capability: DeviceCapability = { ...base, hardwareAv1For4K60: true };
  assert.deepEqual(selectProfiles(capability), selectProfiles(capability));
});

test("4K60 の spatialId は定数と一致する", () => {
  assert.equal(spatialIdOf("V_4K60"), V_4K60.spatialId);
});

test("report は標本列を含み、勾配を含まない", () => {
  const text = buildReport({
    downlinkBps: 4_200_000,
    arrivalDelaySamplesUs: [12_500, 12_900, 13_400],
    playoutStalls: 0,
    audioPacketsLost: 0,
    videoFramesDropped: 3,
    jitterMs: 35,
    bufferHealth: "stable",
  });
  const parsed: unknown = JSON.parse(text);
  const record: Record<string, unknown> = typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
  assert.equal(record["t"], "report");
  assert.deepEqual(record["arrivalDelaySamplesUs"], [12_500, 12_900, 13_400]);
  assert.equal(record["arrivalDelayTrend"], undefined, "勾配は送らない（ADR-0021）");
});

test("report の標本は上限で切り捨てられ、新しい側が残る", () => {
  const samples: number[] = [];
  for (let i = 0; i < DELAY_TREND_WINDOW + 10; i += 1) {
    samples.push(i);
  }
  const text = buildReport({
    downlinkBps: 1_000_000,
    arrivalDelaySamplesUs: samples,
    playoutStalls: 0,
    audioPacketsLost: 0,
    videoFramesDropped: 0,
    jitterMs: 1,
    bufferHealth: "stable",
  });
  const parsed: unknown = JSON.parse(text);
  const record: Record<string, unknown> = typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
  const trimmed = record["arrivalDelaySamplesUs"];
  assert.ok(Array.isArray(trimmed));
  assert.equal(Array.isArray(trimmed) ? trimmed.length : 0, DELAY_TREND_WINDOW);
  assert.equal(Array.isArray(trimmed) ? trimmed[trimmed.length - 1] : 0, DELAY_TREND_WINDOW + 9);
});

test("streamAnnounce は temporalLayers を含む（DISCARDABLE の判定に必要）", () => {
  const text = buildStreamAnnounce([
    { channel: CHANNEL_VIDEO, profile: "V_4K60", framerate: 60, temporalLayers: 3 },
  ]);
  assert.ok(text.includes("temporalLayers"));
  assert.ok(text.includes(`"spatialId":${V_4K60.spatialId}`));
});
