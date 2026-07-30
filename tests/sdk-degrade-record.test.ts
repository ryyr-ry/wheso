/**
 * SDK 経由の観測を判定の形へ組み直す純関数の試験。
 *
 * **なぜこれが必要か。** 判定そのものが正しくても、入力の組み立てが誤っていれば
 * 何も検証しない。旧い器では判定 D-1 の入力が空のまま「合格」になっていた（X-038）。
 * ここでは「落ちるべき観測で落ちる」ことを合成した観測で確かめる。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDegradeRecord, type ObservedRun } from "./support/sdk-degrade-record.ts";
import { judgeAll, judgeAvSkew, judgeDrops } from "./support/degrade-judge.ts";

const MS = 1000;

/**
 * 素の観測を作る。
 * 送信側は 2 段（0 と 1）を出し、購読者は段 0 を受ける。音声は映像と同じ取得時刻に置く。
 */
function baseRun(frames: number, options: { readonly arriveLayer0?: boolean } = {}): ObservedRun {
  const sentVideo = [];
  const sentAudio = [];
  const arrived = [];
  const decoded = [];
  const received = [];
  const playedAudio = [];
  let frameIndex = 0;
  for (let index = 0; index < frames; index += 1) {
    const captureUs = index * 66 * MS;
    const atMs = 1000 + index * 66;
    frameIndex += 1;
    sentVideo.push({
      frameIndex,
      spatialId: 0,
      temporalId: index % 3,
      isKey: index === 0,
      captureUs,
      atMs,
    });
    frameIndex += 1;
    // 段 1 も出す（simulcast）。購読者は選んでいないため判定の対象にならない。
    sentVideo.push({
      frameIndex,
      spatialId: 1,
      temporalId: index % 3,
      isKey: index === 0,
      captureUs,
      atMs,
    });
    sentAudio.push({ captureUs, atMs, silent: false });
    if (options.arriveLayer0 !== false) {
      arrived.push({ captureUs, spatialId: 0 });
      decoded.push({ captureUs, spatialId: 0, temporalId: index % 3, isKey: index === 0, atMs: atMs + 20 });
      received.push({ captureUs, sha256: "a".repeat(64), atMs: atMs + 25 });
      playedAudio.push({ captureUs, atMs: atMs + 25 });
    }
  }
  return {
    sentVideo,
    sentAudio,
    received,
    decoded,
    playedAudio,
    arrived,
    keyframeRequestAtMs: [],
    closures: [],
    lastSentAtMs: 1000 + frames * 66,
    // 0 は「窓を閉じていない」。末尾の切り落としを試験する回だけ上書きする。
    windowClosedAtMs: 0,
  };
}

test("購読者が選んでいない段は判定の対象にならない", () => {
  const built = buildDegradeRecord(baseRun(10));
  // 送信側は 20 ユニット出したが、判定の対象は選ばれた段の 10 件である。
  assert.equal(built.judgedSent, 10);
  assert.deepEqual(judgeDrops(built.record), []);
});

test("**選ばれた段の欠落は違反になる**（最上位の段という言い逃れを許さない）", () => {
  const run = baseRun(10);
  // 段 0 の 5 枚目（temporalId 1。破棄できない層）が届かなかったことにする。
  const missing = run.sentVideo[8];
  assert.ok(missing !== undefined && missing.spatialId === 0);
  const arrived = run.arrived.filter((entry) => entry.captureUs !== missing.captureUs);
  const violations = judgeDrops(buildDegradeRecord({ ...run, arrived }).record);
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.equal(violations[0]?.judgement, "B-2");
});

test("破棄できる層（最上位の時間層）の欠落は違反にならない", () => {
  const run = baseRun(10);
  // temporalId 2 のフレームを落とす。
  const discardable = run.sentVideo.filter((entry) => entry.spatialId === 0 && entry.temporalId === 2);
  assert.ok(discardable.length > 0);
  const dropped = new Set(discardable.map((entry) => entry.captureUs));
  const arrived = run.arrived.filter((entry) => !dropped.has(entry.captureUs));
  assert.deepEqual(judgeDrops(buildDegradeRecord({ ...run, arrived }).record), []);
});

test("音声の対は送信側の取得時刻で決まる（無音は対にしない）", () => {
  const run = baseRun(6);
  const built = buildDegradeRecord(run);
  assert.equal(built.record.playedAudio?.length, built.record.presentedVideo?.length);
  assert.deepEqual(judgeAvSkew(built.record, 22, 30), []);

  // すべての音声を無音（DTX）にすると、対が無いため判定から外れる。
  const silent = run.sentAudio.map((entry) => ({ ...entry, silent: true }));
  const withoutAudio = buildDegradeRecord({ ...run, sentAudio: silent });
  assert.equal(withoutAudio.record.presentedVideo?.length, 0);
  assert.equal(withoutAudio.droppedForNoAudio, 6);
});

test("**送ったのに再生されていない音声は違反として残る**（音声は破棄禁止）", () => {
  const run = baseRun(6);
  // 3 枚目に対応する音声だけが再生されなかったことにする。
  const target = run.sentVideo.find((entry) => entry.spatialId === 0 && entry.frameIndex === 5);
  assert.ok(target !== undefined);
  const playedAudio = run.playedAudio.filter((entry) => entry.captureUs !== target.captureUs);
  const built = buildDegradeRecord({ ...run, playedAudio });
  const violations = judgeAvSkew(built.record, 22, 30);
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.match(violations[0]?.detail ?? "", /対応する音声/);
});

test("末尾（音声がまだ届いていない映像）は判定から外れる", () => {
  const run = baseRun(6);
  // 最後の 2 枚の音声がまだ届いていない状態。
  const cut = run.playedAudio.slice(0, 4);
  const built = buildDegradeRecord({ ...run, playedAudio: cut });
  assert.equal(built.record.presentedVideo?.length, 4);
  assert.deepEqual(judgeAvSkew(built.record, 22, 30), []);
});

test("音声が遅れすぎていれば D-1 が落ちる", () => {
  const run = baseRun(6);
  // 音声の再生を 200 ms 早める（映像が遅れて見える = 音声先行）。
  const early = run.playedAudio.map((entry) => ({ ...entry, atMs: entry.atMs - 200 }));
  const built = buildDegradeRecord({ ...run, playedAudio: early });
  const violations = judgeAvSkew(built.record, 22, 30);
  assert.ok(violations.length > 0, "先行しすぎを検出する");
});

test("段の切替が記録され、上げと下げを区別する", () => {
  const run = baseRun(6);
  const decoded = run.decoded.map((entry, index) =>
    index >= 3 ? { ...entry, spatialId: 1 } : entry,
  );
  const built = buildDegradeRecord({ ...run, decoded });
  assert.equal(built.switches.length, 1);
  assert.equal(built.switches[0]?.up, true);
  assert.equal(built.switches[0]?.from, 0);
  assert.equal(built.switches[0]?.to, 1);
});

test("1 枚も届かない観測では判定の対象が空になり、器の失敗として見える", () => {
  const built = buildDegradeRecord(baseRun(6, { arriveLayer0: false }));
  assert.equal(built.judgedSent, 0);
  assert.equal(built.record.received.length, 0);
});

test("**参照連鎖が切れた回数を数える**（判定 E-1 の許容の根拠。ADR-0046）", () => {
  const clean = buildDegradeRecord(baseRun(10));
  assert.equal(clean.chainBreaks, 0, "何も落ちていなければ 0");

  // 破棄できない層（時間層 0）を 1 枚落とす。
  const run = baseRun(10);
  const missing = run.sentVideo.find((entry) => entry.spatialId === 0 && entry.temporalId === 0 && entry.frameIndex > 2);
  assert.ok(missing !== undefined);
  const arrived = run.arrived.filter((entry) => entry.captureUs !== missing.captureUs);
  assert.equal(buildDegradeRecord({ ...run, arrived }).chainBreaks, 1, "連鎖が切れた回数を数える");

  // 破棄できる層（最上位の時間層）は連鎖を切らない。
  const discardable = run.sentVideo.find((entry) => entry.spatialId === 0 && entry.temporalId === 2);
  assert.ok(discardable !== undefined);
  const arrived2 = run.arrived.filter((entry) => entry.captureUs !== discardable.captureUs);
  assert.equal(buildDegradeRecord({ ...run, arrived: arrived2 }).chainBreaks, 0, "破棄可能は数えない");
});

test("**暖機は内容で切る**（提示できた最初のフレームより前を捨てる）", () => {
  const run = baseRun(10);
  // 最初の 3 枚は経路が整う前で、届かず提示もされなかったことにする。
  const early = new Set(run.sentVideo.filter((entry) => entry.frameIndex <= 6).map((entry) => entry.captureUs));
  const trimmed = buildDegradeRecord({
    ...run,
    arrived: run.arrived.filter((entry) => !early.has(entry.captureUs)),
    decoded: run.decoded.filter((entry) => !early.has(entry.captureUs)),
    received: run.received.filter((entry) => !early.has(entry.captureUs)),
    playedAudio: run.playedAudio.filter((entry) => !early.has(entry.captureUs)),
  });
  // 3 枚ぶん（段 0 と段 1 の対で 6 ユニット）を切るため、判定の対象は 7 件になる。
  assert.equal(trimmed.judgedSent, 7, "切った後の送信だけを判定する");
  assert.deepEqual(judgeDrops(trimmed.record), [], "経路が整う前の欠落は違反にしない");
  assert.equal(trimmed.chainBreaks, 0);
});

test("**暖機より後の欠落は切り落とされない**（切り落としが穴にならない）", () => {
  const run = baseRun(10);
  // 後半の 1 枚（破棄できない層）だけを落とす。
  const late = run.sentVideo.find((entry) => entry.spatialId === 0 && entry.temporalId === 0 && entry.frameIndex > 10);
  assert.ok(late !== undefined);
  const built = buildDegradeRecord({
    ...run,
    arrived: run.arrived.filter((entry) => entry.captureUs !== late.captureUs),
  });
  assert.equal(built.chainBreaks, 1, "落ちたことを数える");
  assert.equal(judgeDrops(built.record).length, 1, "違反として残る");
});

test("暖機の切り落としでキーフレーム要求も切られる（時刻で切る）", () => {
  const run = baseRun(10);
  const early = new Set(run.sentVideo.filter((entry) => entry.frameIndex <= 6).map((entry) => entry.captureUs));
  const firstKept = run.sentVideo.find((entry) => !early.has(entry.captureUs));
  assert.ok(firstKept !== undefined);
  const built = buildDegradeRecord({
    ...run,
    arrived: run.arrived.filter((entry) => !early.has(entry.captureUs)),
    decoded: run.decoded.filter((entry) => !early.has(entry.captureUs)),
    received: run.received.filter((entry) => !early.has(entry.captureUs)),
    // 1 件目は暖機の中、2 件目は後である。
    keyframeRequestAtMs: [firstKept.atMs - 500, firstKept.atMs + 500],
  });
  assert.equal(built.record.keyframeRequests, 1, "暖機の中の要求は数えない");
});

test("**窓を閉じた後に送ったものは判定しない**（排水の間の送出）", () => {
  const run = baseRun(10);
  // 最後の 2 枚（4 ユニット）は窓を閉じた後に送ったことにする。
  const boundary = run.sentVideo[run.sentVideo.length - 5]?.atMs ?? 0;
  const late = new Set(run.sentVideo.filter((entry) => entry.atMs > boundary).map((entry) => entry.captureUs));
  assert.ok(late.size > 0, "窓の外の送出がある");
  const built = buildDegradeRecord({
    ...run,
    windowClosedAtMs: boundary,
    // 窓の外のものは届いていない（まだ経路にある）。
    arrived: run.arrived.filter((entry) => !late.has(entry.captureUs)),
    decoded: run.decoded.filter((entry) => !late.has(entry.captureUs)),
    received: run.received.filter((entry) => !late.has(entry.captureUs)),
  });
  assert.deepEqual(judgeDrops(built.record), [], "排水の間の送出は欠落として数えない");
  assert.equal(built.chainBreaks, 0);
});

test("**窓の内側の欠落は切り落とされない**（末尾の切り落としが穴にならない）", () => {
  const run = baseRun(10);
  const boundary = run.sentVideo[run.sentVideo.length - 1]?.atMs ?? 0;
  // 窓の内側（真ん中）の破棄できない層を 1 枚落とす。
  const middle = run.sentVideo.find((entry) => entry.spatialId === 0 && entry.temporalId === 0 && entry.frameIndex > 8);
  assert.ok(middle !== undefined);
  const built = buildDegradeRecord({
    ...run,
    windowClosedAtMs: boundary,
    arrived: run.arrived.filter((entry) => entry.captureUs !== middle.captureUs),
  });
  assert.equal(built.chainBreaks, 1);
  assert.equal(judgeDrops(built.record).length, 1, "違反として残る");
});

test("**音声の経路が整う前の映像は D-1 の対象にしない**（確立の順序は同期の失敗ではない）", () => {
  const run = baseRun(10);
  // 先頭 3 枚に対応する音声はまだ再生されていない（音声の購読が後から整った）。
  const early = new Set(
    run.sentAudio.filter((_entry, index) => index < 3).map((entry) => entry.captureUs),
  );
  const built = buildDegradeRecord({
    ...run,
    playedAudio: run.playedAudio.filter((entry) => !early.has(entry.captureUs)),
  });
  assert.deepEqual(judgeAvSkew(built.record, 22, 30), [], "先頭は違反にしない");
  assert.equal(built.droppedForNoAudio, 3, "外した数を数える");
});

test("**整った後に音声が欠けたら違反として残る**（頭の切り落としが穴にならない）", () => {
  const run = baseRun(10);
  // 真ん中の 1 件だけ再生されていない。
  const middle = run.sentAudio[5];
  assert.ok(middle !== undefined);
  const built = buildDegradeRecord({
    ...run,
    playedAudio: run.playedAudio.filter((entry) => entry.captureUs !== middle.captureUs),
  });
  const violations = judgeAvSkew(built.record, 22, 30);
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.match(violations[0]?.detail ?? "", /対応する音声/);
});

test("**戻れない閉鎖だけが失敗になる**（設計どおりの再接続を失敗と読まない）", () => {
  const run = baseRun(6);
  // E_AUTH（4020）は `autoReconnect: false` である。1 度でも起きれば経路は戻らない。
  const fatal = buildDegradeRecord({
    ...run,
    closures: [{ label: "受信", role: "vr", code: 4020 }],
  });
  const fatalViolations = judgeAll(fatal.record, { maxGapMs: 1000, requireComplete: true });
  assert.equal(fatalViolations.length, 1, JSON.stringify(fatalViolations));
  assert.equal(fatalViolations[0]?.judgement, "接続");
  assert.deepEqual(fatal.transientClosures, []);

  // 実行環境由来の 1006 と、戻れる規範の閉鎖は失敗にしない（報告だけ）。
  const transient = buildDegradeRecord({
    ...run,
    closures: [
      { label: "受信", role: "vr", code: 1006 },
      { label: "受信", role: "ar", code: 4030 },
    ],
  });
  assert.deepEqual(judgeAll(transient.record, { maxGapMs: 1000, requireComplete: true }), []);
  assert.equal(transient.transientClosures.length, 2);
});
