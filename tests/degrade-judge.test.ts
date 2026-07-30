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
  judgeConnections,
  judgeCompleteness,
  judgeContinuity,
  judgeDependencies,
  judgeIdenticalPixels,
  judgeDrops,
  judgeHashes,
  judgeAvSkew,
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

test("**C-1 は記録の並びではなく時刻の順で間隔を測る**（逆行で間隔を誤らない）", () => {
  // 提示の順序が入れ替わる不具合があると、記録の並びのままでは間隔が実際より長く見える。
  // 実測: 真の最悪が 782 ms のところを 2,490 ms と読んだ（約 2.5 秒の逆行が 1 件）。
  // 順序の異常は判定 A-3 が見る。C-1 は間隔だけを見る。
  const base = healthyRecord(40);
  const received = [...base.received];
  const last = received[received.length - 1];
  assert.ok(last !== undefined);
  // 最後の 1 件を先頭付近へ移す。並びのまま測ると 2 秒を超える跳びが 2 度現れる。
  received.splice(received.length - 1, 1);
  received.splice(1, 0, last);
  const spanMs = (received[received.length - 1]?.atMs ?? 0) - (received[0]?.atMs ?? 0);
  assert.ok(spanMs > 1000, `記録の長さが 1 秒を超える（${String(spanMs)} ms）`);
  assert.deepEqual(
    judgeContinuity({ ...base, received, lastSentAtMs: 100_000 }, 1000),
    [],
    "並びを入れ替えても間隔の判定は変わらない",
  );
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

test("**A-2: キーフレームより前に描いたら違反である**（参照が無い）", () => {
  const base = healthyRecord(10);
  // キーフレームを提示しなかったことにする（送信はしている）。
  const received = base.received.filter((entry) => !(base.sent.find((s) => s.frameIndex === entry.frameIndex)?.isKey ?? false));
  const violations = judgeDependencies({ ...base, received });
  assert.ok(violations.length > 0, "参照の無い提示を検出する");
  assert.equal(violations[0]?.judgement, "A-2");
});

test("**A-2: 低い層を落としたまま高い層を描いたら違反である**", () => {
  const base = healthyRecord(30);
  // 時間層 1 のフレームを提示せず、層 2 は提示したことにする。
  const received = base.received.filter((entry) => {
    const meta = base.sent.find((s) => s.frameIndex === entry.frameIndex);
    return meta === undefined || meta.isKey || meta.temporalId !== 1;
  });
  const violations = judgeDependencies({ ...base, received });
  assert.ok(violations.length > 0, JSON.stringify(violations.slice(0, 2)));
  assert.equal(violations[0]?.judgement, "A-2");
});

test("**A-2 は復号できた集合で判定する**（提示の集合ではない）", () => {
  // 復号器の出力が入れ替わったとき、順序を守るために後戻りした枠を捨てる（A-3）。
  // 捨てた枠は「復号はできたが描かなかった」だけであり、依存構造の違反ではない。
  const base = healthyRecord(30);
  const layerOne = base.sent.find((entry) => !entry.isKey && entry.temporalId === 1);
  assert.ok(layerOne !== undefined);
  const dropped = base.sent.find((entry) => entry.frameIndex === layerOne.frameIndex - 1);
  assert.ok(dropped !== undefined, "1 つ前の枠がある");

  // 提示からは落ちているが、復号器へは渡せていた記録。
  const record = {
    ...base,
    received: base.received.filter((entry) => entry.frameIndex !== dropped.frameIndex),
    decodedIndexes: base.received.map((entry) => entry.frameIndex),
  };
  assert.deepEqual(judgeDependencies(record), [], "復号できていれば違反ではない");

  // 復号器へも渡っていなければ違反である。
  const missing = {
    ...record,
    decodedIndexes: record.decodedIndexes.filter((index) => index !== dropped.frameIndex),
  };
  assert.ok(judgeDependencies(missing).length > 0, "復号できていなければ違反である");
});

test("A-2: 健全な記録では違反が無い", () => {
  assert.deepEqual(judgeDependencies(healthyRecord(30)), []);
  // 最上位の層だけを落とした記録も有効である（破棄可能であり参照されない）。
  const base = healthyRecord(30);
  const topOnly = base.received.filter((entry) => {
    const meta = base.sent.find((s) => s.frameIndex === entry.frameIndex);
    return meta === undefined || meta.temporalId !== 2;
  });
  assert.deepEqual(judgeDependencies({ ...base, received: topOnly }), []);
});

test("**A-1 の完全形: 同じ段を受けた購読者は同じ画素を得る**", () => {
  const base = healthyRecord(10);
  const same = { label: "健全", record: base };
  const other = { label: "劣化", record: base };
  assert.deepEqual(judgeIdenticalPixels([same, other]), [], "同じなら違反は無い");

  // 片方の画素が違う。転送か復号のどこかが壊れている。
  const differing = {
    label: "劣化",
    record: {
      ...base,
      received: base.received.map((entry, index) =>
        index === 4 ? { ...entry, sha256: "f".repeat(64) } : entry,
      ),
    },
  };
  const violations = judgeIdenticalPixels([same, differing]);
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.equal(violations[0]?.judgement, "A-1");

  // 片方にしか届いていないフレームは比べない（劣化が違えば当然である）。
  const fewer = { label: "劣化", record: { ...base, received: base.received.slice(0, 3) } };
  assert.deepEqual(judgeIdenticalPixels([same, fewer]), []);
  // 1 人では判定しない。
  assert.deepEqual(judgeIdenticalPixels([same]), []);
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

test("接続が切れた記録は、それ自体を違反として報告する", () => {
  const base = healthyRecord(30);
  // 途中で切れ、以降が届かない記録を作る。
  const truncated = { ...base, received: base.received.slice(0, 10), closures: ["購読側 code=1006 at=5768ms"] };
  const violations = judgeConnections(truncated);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.judgement, "接続");

  // judgeAll では切断だけを返す。B-2 の大量違反に埋もれさせない。
  const all = judgeAll(truncated, { maxGapMs: 1000, requireComplete: false });
  assert.equal(all.length, 1, "報告は切断 1 件だけである");
  assert.equal(all[0]?.judgement, "接続");
});

test("接続が切れていなければ通常の判定を行う", () => {
  const base = healthyRecord(30);
  const clean = { ...base, closures: [] };
  assert.deepEqual(judgeAll(clean, { maxGapMs: 1000, requireComplete: true }), []);
});

test("A-3: 空間層をまたぐ交錯は逆行にしない", () => {
  // simulcast では層ごとに復号器が別であり、出力の順序は層の間で交錯する。
  // 層をまとめて見ると正常な交錯を逆行と誤判定する（実測で 2 件出た）。
  const base = healthyRecord(4);
  const interleaved = [
    { frameIndex: 1, spatialId: 0, temporalId: 0, isKey: true, sha256: HASH, atMs: 10 },
    { frameIndex: 2, spatialId: 1, temporalId: 0, isKey: true, sha256: HASH, atMs: 12 },
    { frameIndex: 3, spatialId: 0, temporalId: 1, isKey: false, sha256: HASH, atMs: 20 },
    { frameIndex: 4, spatialId: 1, temporalId: 1, isKey: false, sha256: HASH, atMs: 22 },
    // 層 0 の次のフレームは層 1 の 4 より小さい番号ではないが、層 1 より後に出ることがある。
    { frameIndex: 5, spatialId: 0, temporalId: 2, isKey: false, sha256: HASH, atMs: 30 },
  ];
  assert.deepEqual(judgeMonotonic({ ...base, received: interleaved }), []);
});

test("A-3: 同じ層の中の逆行は検出する", () => {
  const base = healthyRecord(4);
  const broken = [
    { frameIndex: 3, spatialId: 0, temporalId: 0, isKey: true, sha256: HASH, atMs: 10 },
    { frameIndex: 2, spatialId: 0, temporalId: 1, isKey: false, sha256: HASH, atMs: 20 },
  ];
  const violations = judgeMonotonic({ ...base, received: broken });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.judgement, "A-3");
});

/* ------------------------------------------------------------------------- */
/* 判定 D-1: 音声と映像のずれ（ADR-0028、F-043）                              */
/* ------------------------------------------------------------------------- */

/** 映像と音声が同じ番号で対応している記録を作る。ずれを `skewMs` で与える。 */
function syncedRecord(count: number, skewMs: number): DegradeRecord {
  const base = healthyRecord(count);
  const played = [];
  const presented = [];
  for (let i = 1; i <= count; i += 1) {
    const audioAt = i * 20;
    played.push({ frameIndex: i, atMs: audioAt });
    presented.push({ frameIndex: i, atMs: audioAt + skewMs });
  }
  return { ...base, playedAudio: played, presentedVideo: presented };
}

test("D-1: ずれが無ければ違反にならない", () => {
  assert.deepEqual(judgeAvSkew(syncedRecord(10, 0), 22, 30), []);
});

test("D-1: 許容の内側（境界）は違反にならない", () => {
  // 映像が遅れる方向（音声先行）の境界。
  assert.deepEqual(judgeAvSkew(syncedRecord(10, 22), 22, 30), []);
  // 映像が先行する方向（音声遅れ）の境界。
  assert.deepEqual(judgeAvSkew(syncedRecord(10, -30), 22, 30), []);
});

test("**D-1 の否定対照: 意図的に 100 ms ずらすと落ちる**", () => {
  const lead = judgeAvSkew(syncedRecord(10, 100), 22, 30);
  assert.ok(lead.length > 0, "音声先行の 100 ms を検出する");
  assert.ok(lead.every((v) => v.judgement === "D-1"));
  assert.ok(
    lead.some((v) => v.detail.includes("音声が先行しすぎている")),
    `内容に方向が出る（実際 ${JSON.stringify(lead)}）`,
  );

  const lag = judgeAvSkew(syncedRecord(10, -100), 22, 30);
  assert.ok(lag.length > 0, "音声遅れの 100 ms を検出する");
  assert.ok(lag.some((v) => v.detail.includes("音声が遅れすぎている")));
});

test("**D-1 の許容は非対称である**（音声先行に厳しい。F-043）", () => {
  // 25 ms の音声先行は落ちるが、25 ms の音声遅れは落ちない。
  assert.ok(judgeAvSkew(syncedRecord(10, 25), 22, 30).length > 0, "音声先行 25 ms は落ちる");
  assert.deepEqual(judgeAvSkew(syncedRecord(10, -25), 22, 30), [], "音声遅れ 25 ms は通る");
});

test("D-1: 対応する音声が再生されていないフレームは違反である（音声は破棄禁止）", () => {
  const record = syncedRecord(5, 0);
  const missing: DegradeRecord = {
    ...record,
    playedAudio: (record.playedAudio ?? []).filter((entry) => entry.frameIndex !== 3),
  };
  const violations = judgeAvSkew(missing, 22, 30);
  assert.equal(violations.length, 1);
  assert.ok(violations[0]?.detail.includes("対応する音声が再生されていない"));
});

test("D-1: 記録が無ければ判定しない（**合格ではなく未判定である**）", () => {
  const base = healthyRecord(5);
  assert.deepEqual(judgeAvSkew(base, 22, 30), [], "記録が無いので空を返す");
  // judgeAll でも空になる。呼び出し側が記録を用意する責務を持つ。
  const violations = judgeAll(base, { maxGapMs: 1000, requireComplete: true });
  assert.ok(
    violations.every((v) => v.judgement !== "D-1"),
    "D-1 は現れない",
  );
});

test("D-1: 単発の外れ値と定常のずれを区別して報告する", () => {
  const record = syncedRecord(100, 0);
  // 1 件だけ大きくずらす。最大値では落ちるが、p99 の報告は別に出る。
  const presented = [...(record.presentedVideo ?? [])];
  const first = presented[0];
  assert.ok(first !== undefined);
  presented[0] = { frameIndex: first.frameIndex, atMs: first.atMs + 500 };
  const violations = judgeAvSkew({ ...record, presentedVideo: presented }, 22, 30);
  assert.ok(violations.some((v) => v.detail.includes("音声が先行しすぎている")), "最大値で落ちる");
  assert.ok(
    !violations.some((v) => v.detail.includes("p99")),
    "1 件の外れ値では p99 の違反は出さない",
  );
});

test("D-1 は judgeAll に組み込まれている", () => {
  const record = syncedRecord(10, 100);
  const violations = judgeAll(record, { maxGapMs: 1000, requireComplete: false });
  assert.ok(
    violations.some((v) => v.judgement === "D-1"),
    "judgeAll が D-1 を数える",
  );
});
