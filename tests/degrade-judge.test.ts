/**
 * 段 D の判定（受入条件 4 節）の試験。
 *
 * なぜ必要か: 劣化下で試験が緑になっただけでは、判定が働いているのか何も見ていないのか
 * 区別できない。**落ちるべき記録で落ちること**を合成した記録で確かめる。
 * ここが空洞だと、段 D 全体が「動いた気がする」だけの試験になる。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  judgeAll,
  judgeCompleteness,
  judgeContinuity,
  judgeDrops,
  judgeHashes,
  judgeKeyframeRequests,
  judgeMonotonic,
  type DegradeRecord,
  type DegradeReceived,
  type DegradeSent,
} from "./support/degrade-judge.ts";

const HASH = "a".repeat(64);

/** 健全な記録を作る。時間層は 0,1,2 を巡回させ、最初の 1 枚をキーフレームにする。 */
function healthyRecord(count: number, intervalMs = 66): DegradeRecord {
  const sent: DegradeSent[] = [];
  const received: DegradeReceived[] = [];
  for (let index = 0; index < count; index += 1) {
    const frameIndex = index + 1;
    const temporalId = index === 0 ? 0 : index % 3;
    const atMs = index * intervalMs;
    sent.push({ frameIndex, temporalId, isKey: index === 0, atMs });
    received.push({ frameIndex, temporalId, isKey: index === 0, sha256: HASH, atMs: atMs + 20 });
  }
  return {
    sent,
    received,
    lastSentAtMs: (count - 1) * intervalMs,
    keyframeRequests: 0,
  };
}

test("健全な記録は全判定を通る", () => {
  const violations = judgeAll(healthyRecord(30), { maxGapMs: 1000, requireComplete: true });
  assert.deepEqual(violations, []);
});

test("A-3: frameIndex の逆行を検出する", () => {
  const base = healthyRecord(10);
  const received = [...base.received];
  const swapped = received[5];
  const previous = received[4];
  assert.ok(swapped !== undefined && previous !== undefined);
  received[5] = { ...swapped, frameIndex: previous.frameIndex - 1 };
  const violations = judgeMonotonic({ ...base, received });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.judgement, "A-3");
});

test("A-3: frameIndex の重複を検出する", () => {
  const base = healthyRecord(10);
  const received = [...base.received];
  const target = received[3];
  const previous = received[2];
  assert.ok(target !== undefined && previous !== undefined);
  received[3] = { ...target, frameIndex: previous.frameIndex };
  const violations = judgeMonotonic({ ...base, received });
  assert.equal(violations.length, 1);
});

test("A-1: ハッシュが取れていない記録を検出する", () => {
  const base = healthyRecord(5);
  const received = [...base.received];
  const target = received[2];
  assert.ok(target !== undefined);
  received[2] = { ...target, sha256: "" };
  const violations = judgeHashes({ ...base, received });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.judgement, "A-1");
});

test("C-1: 描画が止まった記録を検出する", () => {
  const base = healthyRecord(10);
  const received = base.received.map((entry, index) =>
    // 5 枚目以降を 1.2 秒ずらす。途中で 1.2 秒の空白ができる。
    index >= 5 ? { ...entry, atMs: entry.atMs + 1200 } : entry,
  );
  const violations = judgeContinuity({ ...base, received, lastSentAtMs: 100_000 }, 1000);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.judgement, "C-1");
});

test("C-1: 送信を止めた後の空白は違反にしない", () => {
  const base = healthyRecord(10);
  // 最後の受信だけが 3 秒後に来る。送信は既に終わっている。
  const received = [...base.received];
  const last = received[received.length - 1];
  assert.ok(last !== undefined);
  received[received.length - 1] = { ...last, atMs: base.lastSentAtMs + 3000 };
  const violations = judgeContinuity({ ...base, received }, 1000);
  assert.deepEqual(violations, [], "送信終了後の空白は固まりではない");
});

test("B-2: 最上位の時間層の欠落は許す", () => {
  const base = healthyRecord(30);
  // 時間層 2（最上位）のフレームだけを落とす。破棄可能であるため違反ではない。
  const received = base.received.filter((entry) => entry.temporalId !== 2);
  const violations = judgeDrops({ ...base, received });
  assert.deepEqual(violations, []);
});

test("B-2: 基底層の欠落を検出する", () => {
  const base = healthyRecord(30);
  // 時間層 0（基底層）のうち 1 枚を落とす。依存構造が壊れるため違反である。
  const target = base.sent.find((entry) => entry.temporalId === 0 && !entry.isKey);
  assert.ok(target !== undefined);
  const received = base.received.filter((entry) => entry.frameIndex !== target.frameIndex);
  const violations = judgeDrops({ ...base, received });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.judgement, "B-2");
});

test("B-2: キーフレームの欠落を検出する", () => {
  const base = healthyRecord(30);
  const received = base.received.filter((entry) => !entry.isKey);
  const violations = judgeDrops({ ...base, received });
  assert.ok(violations.length >= 1);
  assert.ok(violations.some((entry) => entry.detail.includes("キーフレーム")));
});

test("B-1: 劣化なしの欠落を検出する", () => {
  const base = healthyRecord(20);
  const received = base.received.slice(0, 19);
  const violations = judgeCompleteness({ ...base, received });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.judgement, "B-1");
});

test("E-1: キーフレーム要求を検出する", () => {
  const base = healthyRecord(10);
  const violations = judgeKeyframeRequests({ ...base, keyframeRequests: 1 });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.judgement, "E-1");
});

test("劣化下では欠落を許すが、破棄できない層の欠落は許さない", () => {
  const base = healthyRecord(30);
  const dropTop = base.received.filter((entry) => entry.temporalId !== 2);
  // 劣化下（requireComplete = false）では最上位の欠落を通す。
  assert.deepEqual(judgeAll({ ...base, received: dropTop }, { maxGapMs: 1500, requireComplete: false }), []);
  // 同じ記録を劣化なしの基準で見ると B-1 で落ちる。
  const strict = judgeAll({ ...base, received: dropTop }, { maxGapMs: 1500, requireComplete: true });
  assert.equal(strict.length, 1);
  assert.equal(strict[0]?.judgement, "B-1");
});
