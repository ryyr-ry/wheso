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

import {
  initialReceiverState,
  receiverStep,
  type CatalogLadder,
  type ReceiverState,
} from "../packages/core/src/receiver-core.ts";
import {
  AUDIO_ONLY_ENTER_BPS,
  MIN_VIABLE_BPS,
  RATE_HOLD_MS,
  RATE_PROBE_BPS,
  RATE_RECOVER_STREAK,
  V_1080P30,
} from "../packages/core/src/generated/constants.ts";
import { CHANNEL_VIDEO, MAX_TEMPORAL_ID } from "../packages/core/src/generated/wire-layout.ts";

/** 目標の初期値（bytes/sec）。値そのものに意味は無いが、17/20 の切り捨てが見える大きさにする。 */
const INITIAL_TARGET = 1_000_000;

/**
 * 1 段だけのはしご。上限（申告ビットレートの合計）の試験に使う。
 *
 * 段が 1 つなら「望む段」は必ずその段であり、上限が一意に定まる。
 */
const SMALL_RUNG_BITRATE = V_1080P30.targetBitrate;

function smallLadder(senderId: number): CatalogLadder {
  return {
    senderId,
    channel: CHANNEL_VIDEO,
    rungs: [
      {
        sid: 0,
        width: V_1080P30.width,
        height: V_1080P30.height,
        framerate: V_1080P30.framerate,
        temporalLayers: V_1080P30.temporalLayers,
        targetBitrate: V_1080P30.targetBitrate,
      },
    ],
  };
}

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

test("**回復が続けば目標は観測した goodput を超えて上がる**（規範 4.1: goodput は下限）", () => {
  // 中継ノードは目標の分しか転送しないため、goodput は目標を超えない。goodput を
  // 上限にすると「目標 ≤ goodput ≤ 目標」の輪が閉じ、目標は最低成立点から一生上がらない。
  // 実測（実環境・劣化なし）: 目標が 30,620 bytes/s に張り付き、中継ノードが基底層 417 件を
  // 含む 842 件を捨てた。到着は送信 1,342 件に対し 577 件だった。
  const floor = Math.trunc(MIN_VIABLE_BPS / 8);
  let state = initialReceiverState();
  assert.equal(state.targetBytesPerSec, floor, "初期状態は最低成立点である");
  // 観測できた goodput は最低成立点ぶんしかない（中継が目標で切っているため）。
  state = receiverStep(state, { kind: "goodput", bytesPerSec: floor }, 0).state;
  assert.equal(state.targetCeilingBytesPerSec, floor, "天井は観測値である");

  // 勾配は健全（回復）。3 回連続で加算的増加が起きる。
  for (let attempt = 1; attempt <= RATE_RECOVER_STREAK; attempt += 1) {
    state = reportAt(state, fallingDelays(), RATE_HOLD_MS * attempt);
  }
  assert.equal(
    state.targetBytesPerSec,
    floor + Math.trunc(RATE_PROBE_BPS / 8),
    "**天井で切られずに増える**",
  );
  assert.ok(
    state.targetBytesPerSec > state.targetCeilingBytesPerSec,
    "観測した goodput を超えて探る（AIMD の探りはそういうものである）",
  );
});

test("加算的増加は申告ビットレートの合計で止まる（規範 4.2）", () => {
  // 上限は「現在のプロファイルの目標ビットレート」である。はしごを与え、購読を張り、
  // 表示寸法を与えて段を決めた上で、いくら回復が続いても合計を超えないことを見る。
  let state = initialReceiverState();
  state = receiverStep(state, { kind: "catalog", entries: [smallLadder(7)] }, 0).state;
  state = receiverStep(
    state,
    {
      kind: "subscribe",
      entries: [{ senderId: 7, channel: CHANNEL_VIDEO, maxSpatialId: 0, maxTemporalId: MAX_TEMPORAL_ID }],
    },
    0,
  ).state;
  state = receiverStep(
    state,
    { kind: "displaySize", senderId: 7, channel: CHANNEL_VIDEO, width: 4096 },
    0,
  ).state;
  for (let attempt = 1; attempt <= RATE_RECOVER_STREAK * 30; attempt += 1) {
    state = reportAt(state, fallingDelays(), RATE_HOLD_MS * attempt);
  }
  const cap = Math.trunc(SMALL_RUNG_BITRATE / 8);
  assert.equal(state.targetBytesPerSec, cap, "申告ビットレートで止まる");
});

test("**回復が続けば音声だけの状態から映像へ戻る**（規範 4.3、ADR-0029）", () => {
  // AIMD が目標を上げても配分をやり直さないと、`AUDIO_ONLY` の解除が判断されない。
  // 実測: 目標が 29,620 → 154,620 bytes/s まで回復しても `audioOnly` が true のままで、
  // 購読の命令が 1 件も出なかった。**音声だけの会議から二度と戻れない。**
  let state = initialReceiverState();
  state = receiverStep(state, { kind: "catalog", entries: [smallLadder(7)] }, 0).state;
  state = receiverStep(
    state,
    {
      kind: "subscribe",
      entries: [{ senderId: 7, channel: CHANNEL_VIDEO, maxSpatialId: 0, maxTemporalId: MAX_TEMPORAL_ID }],
    },
    0,
  ).state;
  // 予算を音声だけの境界より下へ落とす。
  const low = Math.trunc(AUDIO_ONLY_ENTER_BPS / 8) - 1000;
  state = receiverStep(state, { kind: "budget", bytesPerSec: low }, 0).state;
  assert.equal(state.audioOnly, true, "映像を落として音声を守る");
  // 観測できた goodput も小さい（中継が目標で切っているため）。
  state = receiverStep(state, { kind: "goodput", bytesPerSec: low }, 0).state;
  assert.equal(state.audioOnly, true);

  // 回復が続く。
  let restored = false;
  for (let attempt = 1; attempt <= RATE_RECOVER_STREAK * 6 && !restored; attempt += 1) {
    const result = receiverStep(state, { kind: "report", delayUs: fallingDelays() }, RATE_HOLD_MS * attempt);
    state = result.state;
    if (result.commands.some((command) => command.kind === "subscribeChange")) {
      restored = true;
    }
  }
  assert.equal(restored, true, "**購読をやり直す命令が出る**");
  assert.equal(state.audioOnly, false, "映像へ戻る");
});

test("増減どちらでもない報告では target が動かない", () => {
  const state = stateWithBudget(INITIAL_TARGET);
  const after = reportAt(state, flatDelays(), 0);
  assert.equal(after.targetBytesPerSec, INITIAL_TARGET);
});
