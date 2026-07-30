/**
 * AIMD（congestion.md 4.2）の試験。
 *
 * 規範の法則:
 *   劣化時: target = target × 0.85（整数演算で 17/20、切り捨て）。次の判定まで
 *           RATE_HOLD_MS 待つ
 *   回復時: 判定が 3 回連続したら target += RATE_PROBE_BPS。上限を超えない
 *
 * なぜ試験するか: 実装前は target が外から与えられるだけで、遅延に応じて動かなかった。
 * 目標が動かないと、帯域が細い回線では詰まったまま、太い回線では品質が戻らない。
 *
 * 0.85 を浮動小数点で計算してはならない。9 言語で同じ値を出す必要がある（ADR-0017）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { initialReceiverState, receiverStep, type ReceiverState } from "../packages/core/src/receiver-core.ts";
import {
  MIN_VIABLE_BPS,
  RATE_HOLD_MS,
  RATE_PROBE_BPS,
  RATE_RECOVER_STREAK,
} from "../packages/core/src/generated/constants.ts";

/** 目標の初期値（bytes/sec）。値そのものに意味は無いが、17/20 の切り捨てが見える大きさにする。 */
const INITIAL_TARGET = 1_000_000;

/** 遅延が増え続ける標本列。勾配が閾値を超える。 */
function risingDelays(): number[] {
  const samples: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    samples.push(10_000 + index * 60_000);
  }
  return samples;
}

/** 遅延が減り続ける標本列。勾配が回復の閾値を下回る。 */
function fallingDelays(): number[] {
  const samples: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    samples.push(1_200_000 - index * 60_000);
  }
  return samples;
}

/** 遅延が一定の標本列。増減どちらの条件も満たさない。 */
/**
 * 増減どちらでもない標本列。
 *
 * **平坦（勾配 0）は「回復」である**。遅延が伸びていなければ待ち行列は育っておらず、
 * 目標を上げて良い（ADR-0037）。中立の帯は回復閾値 1,500 と劣化閾値 5,000 の間である。
 * 勾配 3,000 マイクロ秒/標本の列を作る。
 */
function flatDelays(): number[] {
  return Array.from({ length: 20 }, (_unused, index) => 20_000 + index * 3_000);
}

function reportAt(state: ReceiverState, samples: readonly number[], t: number): ReceiverState {
  return receiverStep(state, { kind: "report", delayUs: samples }, t).state;
}

/**
 * 指定した下り帯域を持つ初期状態を作る。
 *
 * 初期状態は最低から始まる（参加直後に高い段を要求しないため）。試験で帯域を与えるには
 * `budget` イベントを流す。これは goodput の観測に相当する（congestion.md 4.1）。
 */
function stateWithBudget(bytesPerSec: number): ReceiverState {
  return receiverStep(initialReceiverState(), { kind: "budget", bytesPerSec }, 0).state;
}

test("劣化で target が 0.85 倍になる（整数演算・切り捨て）", () => {
  const state = stateWithBudget(INITIAL_TARGET);
  const after = reportAt(state, risingDelays(), 0);
  // 17/20 を整数で。1_000_000 × 17 / 20 = 850_000。
  assert.equal(after.targetBytesPerSec, 850_000);
});

test("切り捨てが規範どおりである（浮動小数点を使わない）", () => {
  // 17/20 の切り捨てが見える値を選ぶ。**下限（MIN_VIABLE_BPS/8）より上で選ぶ**
  // （ADR-0040 で予兆による減少は下限で止まるため、下限以下では切り捨てが観測できない）。
  // 100_001 × 17 = 1_700_017、1_700_017 / 20 = 85_000.85 → 85_000。
  const state = stateWithBudget(100_001);
  const after = reportAt(state, risingDelays(), 0);
  assert.equal(after.targetBytesPerSec, 85_000, "切り上げや四捨五入ではない");
});

test("**予兆による減少は最低成立点で止まる**（ADR-0040）", () => {
  const floor = Math.trunc(MIN_VIABLE_BPS / 8);
  // 下限のすぐ上から始める。0.85 倍すれば下限を割る値である。
  let state = stateWithBudget(floor + 1000);
  state = reportAt(state, risingDelays(), 0);
  assert.equal(state.targetBytesPerSec, floor, "下限で止まる");
  // 何度報告しても下限より下がらない。
  state = reportAt(state, risingDelays(), RATE_HOLD_MS * 2);
  state = reportAt(state, risingDelays(), RATE_HOLD_MS * 4);
  assert.equal(state.targetBytesPerSec, floor, "繰り返しても割らない");
});

test("減らした直後は RATE_HOLD_MS の間もう減らさない", () => {
  let state = stateWithBudget(INITIAL_TARGET);
  state = reportAt(state, risingDelays(), 0);
  assert.equal(state.targetBytesPerSec, 850_000);

  // 待ちの内側。1 回の揺れで連続して落とさない。
  state = reportAt(state, risingDelays(), RATE_HOLD_MS - 1);
  assert.equal(state.targetBytesPerSec, 850_000, "待ちの間は変わらない");

  // 待ちが明ければ再び減る。850_000 × 17 / 20 = 722_500。
  state = reportAt(state, risingDelays(), RATE_HOLD_MS);
  assert.equal(state.targetBytesPerSec, 722_500);
});

test("回復は 3 回連続してから増える", () => {
  let state = stateWithBudget(INITIAL_TARGET);
  // 一度下げて、増える余地を作る。
  state = reportAt(state, risingDelays(), 0);
  const lowered = state.targetBytesPerSec;

  for (let attempt = 1; attempt < RATE_RECOVER_STREAK; attempt += 1) {
    state = reportAt(state, fallingDelays(), RATE_HOLD_MS * attempt);
    assert.equal(state.targetBytesPerSec, lowered, `${String(attempt)} 回目では増えない`);
    assert.equal(state.recoverStreak, attempt);
  }
  state = reportAt(state, fallingDelays(), RATE_HOLD_MS * RATE_RECOVER_STREAK);
  assert.equal(state.targetBytesPerSec, lowered + RATE_PROBE_BPS / 8, "3 回目で加算される");
  assert.equal(state.recoverStreak, 0, "増やしたら連続回数を戻す");
});

test("回復の連続が途切れたら数え直す", () => {
  let state = stateWithBudget(INITIAL_TARGET);
  state = reportAt(state, risingDelays(), 0);
  const lowered = state.targetBytesPerSec;
  state = reportAt(state, fallingDelays(), 1000);
  state = reportAt(state, fallingDelays(), 2000);
  assert.equal(state.recoverStreak, 2);
  // 増減どちらでもない報告が挟まると 0 に戻る。
  state = reportAt(state, flatDelays(), 3000);
  assert.equal(state.recoverStreak, 0);
  state = reportAt(state, fallingDelays(), 4000);
  state = reportAt(state, fallingDelays(), 5000);
  assert.equal(state.targetBytesPerSec, lowered, "2 回では増えない");
});

test("加算的増加は上限（初めに与えられた目標）を超えない", () => {
  let state = stateWithBudget(INITIAL_TARGET);
  // 下げた分より大きい増加が来ても、上限で止まる。
  state = reportAt(state, risingDelays(), 0);
  for (let attempt = 1; attempt <= RATE_RECOVER_STREAK * 20; attempt += 1) {
    state = reportAt(state, fallingDelays(), RATE_HOLD_MS * attempt);
  }
  assert.equal(state.targetBytesPerSec, INITIAL_TARGET, "上限で止まる");
});

test("増減どちらでもない報告では target が動かない", () => {
  const state = stateWithBudget(INITIAL_TARGET);
  const after = reportAt(state, flatDelays(), 0);
  assert.equal(after.targetBytesPerSec, INITIAL_TARGET);
});
