/**
 * ジッタバッファの深度と再生判定の試験。
 * 規範: constants.md 7 節の式、congestion.md 5 節の遅れたフレームの扱い。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  audioJitterPackets,
  decidePlayout,
  jitterP99Ms,
  videoJitterFrames,
} from "../packages/client/src/sync/jitter-buffer.ts";
import {
  AUDIO_JITTER_MAX_PACKETS,
  AUDIO_JITTER_MIN_PACKETS,
  LATE_FRAME_TOLERANCE_MS,
  OPUS_FRAME_MS,
  VIDEO_JITTER_MAX_FRAMES,
  VIDEO_JITTER_MIN_FRAMES,
} from "../packages/core/src/generated/constants.ts";
import {
  CHANNEL_AUDIO,
  CHANNEL_VIDEO,
  FLAG_END_OF_FRAME,
  FLAG_KEY,
} from "../packages/core/src/generated/wire-layout.ts";

test("映像の深度は式どおりで下限と上限に収まる", () => {
  // 60 fps でジッタ 0 なら ceil(0) + 1 = 1 → 下限 2 に丸められる。
  assert.equal(videoJitterFrames(0, 60), VIDEO_JITTER_MIN_FRAMES);
  // ジッタ 17 ms、60 fps: ceil(17 × 60 / 1000) = ceil(1.02) = 2、+1 で 3。
  assert.equal(videoJitterFrames(17, 60), 3);
  // ジッタ 100 ms、60 fps: ceil(6) = 6、+1 で 7。
  assert.equal(videoJitterFrames(100, 60), 7);
  // 大きなジッタは上限で止まる。
  assert.equal(videoJitterFrames(1000, 60), VIDEO_JITTER_MAX_FRAMES);
});

test("映像の深度は fps に依存する", () => {
  // 同じジッタでも fps が低いほど必要なフレーム数は少ない。
  assert.ok(videoJitterFrames(50, 15) <= videoJitterFrames(50, 60));
});

test("fps が 0 のときは下限を返す（0 除算をしない）", () => {
  assert.equal(videoJitterFrames(50, 0), VIDEO_JITTER_MIN_FRAMES);
});

test("音声の深度は式どおりで下限と上限に収まる", () => {
  assert.equal(audioJitterPackets(0), AUDIO_JITTER_MIN_PACKETS);
  // ジッタ 20 ms: ceil(20 / 20) = 1、+1 で 2。
  assert.equal(audioJitterPackets(OPUS_FRAME_MS), 2);
  // ジッタ 41 ms: ceil(41 / 20) = 3、+1 で 4。
  assert.equal(audioJitterPackets(41), 4);
  assert.equal(audioJitterPackets(10_000), AUDIO_JITTER_MAX_PACKETS);
});

test("p99 は標本を昇順に見た上位 1% の境界を返し、入力を壊さない", () => {
  const samples = [5, 1, 3, 2, 4];
  const copy = [...samples];
  assert.equal(jitterP99Ms(samples), 5);
  assert.deepEqual(samples, copy, "引数の配列を並べ替えない");
  assert.equal(jitterP99Ms([]), 0);
  assert.equal(jitterP99Ms([7]), 7);

  // 最近傍順位の定義（添字 = ceil(99 × n / 100) - 1）に従う。
  // 100 標本のうち外れ値が 1 個なら、p99 は外れ値の 1 つ下（= 2）になる。
  const many: number[] = [];
  for (let i = 0; i < 99; i += 1) {
    many.push(2);
  }
  many.push(50);
  assert.equal(jitterP99Ms(many), 2);

  // 外れ値が 2 個あれば p99 が外れ値側に上がる。
  const twoOutliers = [...many.slice(0, 98), 50, 50];
  assert.equal(jitterP99Ms(twoOutliers), 50);
});

test("再生予定が未来のユニットは待つ", () => {
  const decision = decidePlayout(
    { channel: CHANNEL_VIDEO, flags: FLAG_END_OF_FRAME, playoutAtMs: 1000 },
    900,
  );
  assert.equal(decision, "wait");
});

test("許容範囲内の遅れは復号する", () => {
  const decision = decidePlayout(
    { channel: CHANNEL_VIDEO, flags: FLAG_END_OF_FRAME, playoutAtMs: 1000 },
    1000 + LATE_FRAME_TOLERANCE_MS,
  );
  assert.equal(decision, "decode");
});

test("許容範囲を超えて遅れた映像は捨てる", () => {
  const decision = decidePlayout(
    { channel: CHANNEL_VIDEO, flags: FLAG_END_OF_FRAME, playoutAtMs: 1000 },
    1000 + LATE_FRAME_TOLERANCE_MS + 1,
  );
  assert.equal(decision, "discard");
});

test("遅れてもキーフレームは復号する（参照連鎖の起点）", () => {
  const decision = decidePlayout(
    { channel: CHANNEL_VIDEO, flags: FLAG_END_OF_FRAME | FLAG_KEY, playoutAtMs: 1000 },
    5000,
  );
  assert.equal(decision, "decode");
});

test("遅れても音声は再生する（音声は捨てない）", () => {
  const decision = decidePlayout(
    { channel: CHANNEL_AUDIO, flags: FLAG_END_OF_FRAME, playoutAtMs: 1000 },
    5000,
  );
  assert.equal(decision, "decode");
});
