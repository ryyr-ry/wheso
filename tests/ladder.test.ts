/**
 * はしごの導出（ADR-0026）と表示寸法から段への写像（ADR-0027）を検証する。
 *
 * 検証する性質:
 *   1. 源より大きい解像度・高い fps を作らない（拡大しない）
 *   2. 段数が源と内容種別と能力で 1〜3 になる
 *   3. 画面共有は 1/4 の段を作らない（文字の可読性）
 *   4. 段番号が 0 から密に振られる
 *   5. 表示寸法から「表示幅以上で最小の段」が選ばれる
 *   6. 発熱降格で段が上から落ちるが、必ず 1 段は残る
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  declaredFramerate,
  buildLadderAnnounce,
  deriveLadder,
  type EncodeCapability,
  type SourceSpec,
} from "../packages/core/src/ladder.ts";
import {
  V_1080P30,
  V_1080P60,
  V_360P15,
  V_4K60,
  V_SCREEN_1080P30,
  V_SCREEN_4K30,
} from "../packages/core/src/generated/constants.ts";
import { CHANNEL_VIDEO } from "../packages/core/src/generated/wire-layout.ts";

const HW: EncodeCapability = {
  hardwareAv1For4K60: true,
  encodeAv1: true,
  mobile: false,
  charging: true,
  thermalDrop: 0,
};

const SW: EncodeCapability = { ...HW, hardwareAv1For4K60: false };

function source(width: number, height: number, framerate: number): SourceSpec {
  return { width, height, framerate };
}

test("**申告する fps は「源 ÷ 整数」に丸め、間引きの間隔は切り捨てる**（ADR-0052）", () => {
  // 源が代表点の整数倍でないと、代表点の fps を申告しても均等に出せない。実測（F-073）:
  // 源 20 fps から 15 fps を作ると 50 / 50 / 100 ms の繰り返しになり、2 枚が 100 ms に
  // 固まって送信窓（申告 fps × SEND_WINDOW_MS ぶんの枚数）を閉じ、破棄不可まで落ちた。
  //
  // **間引きの間隔は切り捨てる**（ADR-0052 が ADR-0051 を置き換える）。切り上げると申告が
  // 代表点より下がり（源 20 → 10）、窓が 2 枚に縮む一方で ack の間隔は媒体の間隔（100 ms）で
  // 決まるため、規範が前提とする「窓あたり 4 回の ack」が 2 回になる（F-078・F-079）。
  // 切り捨てれば間引きが無くなり（k=1）、間隔は完全に均等で、窓は 4 枚、ack は 50 ms になる。
  assert.equal(declaredFramerate(30, 15), 15, "整数倍ならそのまま（30 ÷ 2）");
  assert.equal(declaredFramerate(60, 15), 15, "60 ÷ 4");
  assert.equal(declaredFramerate(60, 30), 30, "60 ÷ 2");
  assert.equal(declaredFramerate(30, 30), 30, "間引かない");
  assert.equal(declaredFramerate(20, 15), 20, "**間引かない**（20 ÷ 1。代表点を上回って申告する）");
  assert.equal(declaredFramerate(25, 15), 25, "25 ÷ 1");
  assert.equal(declaredFramerate(24, 15), 24, "24 ÷ 1");
  assert.equal(declaredFramerate(50, 15), 16, "50 ÷ 3 = 16.67 → 切り捨てる（出せる値を上回らない）");
  assert.equal(declaredFramerate(45, 15), 15, "45 ÷ 3");
  // 源が代表点以下なら源をそのまま申告する（拡大しない。ADR-0026）。
  assert.equal(declaredFramerate(10, 15), 10);
  assert.equal(declaredFramerate(15, 15), 15);
});

test("4K60 の源とハードウェア符号化器では 3 段になる", () => {
  const rungs = deriveLadder(source(V_4K60.width, V_4K60.height, V_4K60.framerate), "camera", HW);
  assert.equal(rungs.length, 3);
  assert.deepEqual(
    rungs.map((r) => r.sid),
    [0, 1, 2],
    "段番号は 0 から密に振る",
  );
  assert.equal(rungs[0]?.width, V_360P15.width, "最下段は最小の代表点である");
  assert.equal(rungs[2]?.width, V_4K60.width, "最上段は源に収まる最大の代表点である");
});

test("拡大しない（源より大きい段を作らない）", () => {
  // 1280×720@30 の源。1080p の代表点は幅が源を超えるため作らない。
  const rungs = deriveLadder(source(1280, 720, 30), "camera", HW);
  for (const rung of rungs) {
    assert.ok(rung.width <= 1280, `段の幅 ${String(rung.width)} が源を超えない`);
    assert.ok(rung.height <= 720, `段の高さ ${String(rung.height)} が源を超えない`);
    assert.ok(rung.framerate <= 30, `段の fps ${String(rung.framerate)} が源を超えない`);
  }
});

test("1080p30 の源では 2 段になる（60 fps の代表点は源を超える）", () => {
  const rungs = deriveLadder(source(V_1080P30.width, V_1080P30.height, V_1080P30.framerate), "camera", SW);
  assert.equal(rungs.length, 2);
  assert.equal(rungs[0]?.width, V_360P15.width);
  assert.equal(rungs[1]?.width, V_1080P30.width);
  assert.equal(rungs[1]?.framerate, V_1080P30.framerate);
});

test("1080p60 の源とソフトウェア符号化器では 3 段になる", () => {
  const rungs = deriveLadder(source(V_1080P60.width, V_1080P60.height, V_1080P60.framerate), "camera", SW);
  assert.equal(rungs.length, 3);
  assert.equal(rungs[2]?.framerate, V_1080P60.framerate);
});

test("代表点が収まらない小さな源では源そのものを 1 段にする", () => {
  const rungs = deriveLadder(source(320, 240, 30), "camera", HW);
  assert.equal(rungs.length, 1);
  assert.equal(rungs[0]?.width, 320);
  assert.equal(rungs[0]?.height, 240);
  assert.equal(rungs[0]?.sid, 0);
});

test("携帯で充電していないときは 60 fps の段を作らない", () => {
  const mobile: EncodeCapability = { ...HW, mobile: true, charging: false };
  const rungs = deriveLadder(source(V_4K60.width, V_4K60.height, V_4K60.framerate), "camera", mobile);
  for (const rung of rungs) {
    assert.ok(rung.framerate <= V_1080P30.framerate, `fps ${String(rung.framerate)} が 30 以下である`);
  }
});

test("画面共有は 2 段で、1/4 の段（文字が読めない段）を作らない", () => {
  const rungs = deriveLadder(source(V_SCREEN_4K30.width, V_SCREEN_4K30.height, V_SCREEN_4K30.framerate), "screen", HW);
  assert.equal(rungs.length, 2);
  assert.equal(rungs[0]?.width, V_SCREEN_1080P30.width);
  assert.equal(rungs[1]?.width, V_SCREEN_4K30.width);
  for (const rung of rungs) {
    assert.ok(rung.width >= V_SCREEN_1080P30.width, "360p 相当の段は作らない");
  }
});

test("AV1 が使えないと単層になる（H.264 は時間スケーラビリティを使えない）", () => {
  const noAv1: EncodeCapability = { ...HW, encodeAv1: false, hardwareAv1For4K60: false };
  const rungs = deriveLadder(source(V_1080P30.width, V_1080P30.height, V_1080P30.framerate), "camera", noAv1);
  for (const rung of rungs) {
    assert.equal(rung.temporalLayers, 1);
    assert.equal(rung.scalabilityMode, "L1T1");
    assert.equal(rung.codec, "avc1.42E01F");
  }
});

test("発熱降格は上段から落とし、必ず 1 段は残す", () => {
  const src = source(V_4K60.width, V_4K60.height, V_4K60.framerate);
  const one = deriveLadder(src, "camera", { ...HW, thermalDrop: 1 });
  const many = deriveLadder(src, "camera", { ...HW, thermalDrop: 99 });
  const full = deriveLadder(src, "camera", HW);
  assert.ok(one.length <= full.length);
  assert.equal(many.length, 1, "落としきっても 1 段は残る");
  assert.equal(many[0]?.width, V_360P15.width, "残るのは最下段である");
});

test("streamAnnounce は規範の全欄を送る（width / height / targetBitrate を落とさない）", () => {
  const rungs = deriveLadder(source(V_4K60.width, V_4K60.height, V_4K60.framerate), "camera", HW);
  const text = buildLadderAnnounce(CHANNEL_VIDEO, rungs);
  const parsed: unknown = JSON.parse(text);
  assert.ok(typeof parsed === "object" && parsed !== null);
  const record: Record<string, unknown> = { ...parsed };
  assert.equal(record["t"], "streamAnnounce");
  const streams = record["streams"];
  assert.ok(Array.isArray(streams));
  assert.equal(streams.length, rungs.length);
  for (const stream of streams) {
    assert.ok(typeof stream === "object" && stream !== null);
    const entry: Record<string, unknown> = { ...stream };
    for (const key of [
      "channel",
      "spatialId",
      "codec",
      "scalabilityMode",
      "spatialLayers",
      "temporalLayers",
      "width",
      "height",
      "framerate",
      "targetBitrate",
    ]) {
      assert.ok(entry[key] !== undefined, `${key} が含まれる`);
    }
  }
});

test("同じ入力に対して常に同じはしごを返す（決定的である）", () => {
  const src = source(V_4K60.width, V_4K60.height, V_4K60.framerate);
  assert.equal(
    JSON.stringify(deriveLadder(src, "camera", HW)),
    JSON.stringify(deriveLadder(src, "camera", HW)),
  );
});
