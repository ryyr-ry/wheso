/**
 * 中継ノードの輻輳状態機械が state-machines.md 3 節の表と一行ずつ一致することを検証する。
 *
 * なぜ表から書くか: 実装をなぞるテストは実装の誤りを検出しない（ADR-0012 の趣旨）。
 * 本ファイルは規範の表だけを見て書き、閾値の境界（すぐ上とすぐ下）で判定が変わることを確かめる。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  initialState,
  step,
  type CongestionState,
  type ReceiverTrend,
  type ShardState,
} from "../packages/core/src/shard-core.ts";
import {
  NODE_MAX_OUT_MESSAGES_PER_SEC,
  SHEDDING_HYSTERESIS_MS,
} from "../packages/core/src/generated/constants.ts";

/** 指定の状態・利用率・勾配を持つ状態を組み立てる。 */
function stateWith(
  congestion: CongestionState,
  utilNumerator: number,
  utilDenominator: number,
  trend: ReceiverTrend | null,
): ShardState {
  // util = sentMessagesInWindow × 1000 / (windowMs × MAX_MPS)
  // 窓が満了すると実装は窓をリセットするため、評価時刻は窓長より手前に置く。
  // windowMs = WINDOW_MS_FOR_TEST のとき sent = util × MAX_MPS × windowMs / 1000。
  const sent = Math.trunc(
    (utilNumerator * NODE_MAX_OUT_MESSAGES_PER_SEC * WINDOW_MS_FOR_TEST) / (utilDenominator * 1000),
  );
  const base = initialState(0);
  return {
    ...base,
    congestion,
    congestionEnteredAt: 0,
    sentMessagesInWindow: sent,
    windowStartMs: 0,
    trends: trend === null ? [] : [trend],
  };
}

/** 勾配（マイクロ秒 / 標本）を分子と分母で与える。 */
function trendOf(numerator: number, denominator: number): ReceiverTrend {
  return { subscriberId: 1, numerator, denominator };
}

/**
 * 評価に使う窓の長さ。SHARD_UTIL_WINDOW_MS（1000 ms）に達すると実装が窓をリセットし
 * 利用率が 0 になるため、手前の 900 ms で評価する。ヒステリシス 500 ms は満たす。
 */
const WINDOW_MS_FOR_TEST = 900;

/** ヒステリシスを跨いだ評価時刻。 */
const AFTER_HOLD = WINDOW_MS_FOR_TEST;

test("表 1 行目: NORMAL は util > 0.9 で SHEDDING_T2 へ遷移する", () => {
  const below = step(stateWith("NORMAL", 89, 100, null), { kind: "timer" }, AFTER_HOLD);
  assert.equal(below.state.congestion, "NORMAL");
  const above = step(stateWith("NORMAL", 91, 100, null), { kind: "timer" }, AFTER_HOLD);
  assert.equal(above.state.congestion, "SHEDDING_T2");
});

test("表 1 行目: NORMAL は maxTrend > 0.01 でも SHEDDING_T2 へ遷移する", () => {
  // 勾配 0.009 は閾値未満、0.011 は閾値超。分母 1000 で表す。
  const below = step(stateWith("NORMAL", 1, 100, trendOf(9, 1000)), { kind: "timer" }, AFTER_HOLD);
  assert.equal(below.state.congestion, "NORMAL");
  const above = step(stateWith("NORMAL", 1, 100, trendOf(11, 1000)), { kind: "timer" }, AFTER_HOLD);
  assert.equal(above.state.congestion, "SHEDDING_T2");
});

test("表 2 行目: SHEDDING_T2 は util > 1.0 または maxTrend > 0.03 で SHEDDING_T1 へ遷移する", () => {
  const byUtil = step(stateWith("SHEDDING_T2", 101, 100, null), { kind: "timer" }, AFTER_HOLD);
  assert.equal(byUtil.state.congestion, "SHEDDING_T1");
  const byTrend = step(
    stateWith("SHEDDING_T2", 95, 100, trendOf(31, 1000)),
    { kind: "timer" },
    AFTER_HOLD,
  );
  assert.equal(byTrend.state.congestion, "SHEDDING_T1");
  // 0.029 では遷移しない
  const notYet = step(
    stateWith("SHEDDING_T2", 95, 100, trendOf(29, 1000)),
    { kind: "timer" },
    AFTER_HOLD,
  );
  assert.equal(notYet.state.congestion, "SHEDDING_T2");
});

test("表 3 行目: SHEDDING_T2 は util < 0.8 かつ maxTrend < -0.005 でのみ NORMAL へ戻る", () => {
  const both = step(
    stateWith("SHEDDING_T2", 79, 100, trendOf(-6, 1000)),
    { kind: "timer" },
    AFTER_HOLD,
  );
  assert.equal(both.state.congestion, "NORMAL");
  // util だけ満たす場合は戻らない（条件は「かつ」）
  const utilOnly = step(
    stateWith("SHEDDING_T2", 79, 100, trendOf(0, 1)),
    { kind: "timer" },
    AFTER_HOLD,
  );
  assert.equal(utilOnly.state.congestion, "SHEDDING_T2");
  // 勾配だけ満たす場合も戻らない
  const trendOnly = step(
    stateWith("SHEDDING_T2", 85, 100, trendOf(-6, 1000)),
    { kind: "timer" },
    AFTER_HOLD,
  );
  assert.equal(trendOnly.state.congestion, "SHEDDING_T2");
});

test("表 4 行目: SHEDDING_T1 は util > 1.1 または maxTrend > 0.06 で SHEDDING_SPATIAL へ遷移する", () => {
  const byUtil = step(stateWith("SHEDDING_T1", 111, 100, null), { kind: "timer" }, AFTER_HOLD);
  assert.equal(byUtil.state.congestion, "SHEDDING_SPATIAL");
  const byTrend = step(
    stateWith("SHEDDING_T1", 100, 100, trendOf(61, 1000)),
    { kind: "timer" },
    AFTER_HOLD,
  );
  assert.equal(byTrend.state.congestion, "SHEDDING_SPATIAL");
  const notYet = step(stateWith("SHEDDING_T1", 109, 100, null), { kind: "timer" }, AFTER_HOLD);
  assert.equal(notYet.state.congestion, "SHEDDING_T1");
});

test("表 5 行目: SHEDDING_T1 は util < 0.85 かつ maxTrend < -0.005 で SHEDDING_T2 へ戻る", () => {
  const both = step(
    stateWith("SHEDDING_T1", 84, 100, trendOf(-6, 1000)),
    { kind: "timer" },
    AFTER_HOLD,
  );
  assert.equal(both.state.congestion, "SHEDDING_T2");
  const utilOnly = step(
    stateWith("SHEDDING_T1", 84, 100, trendOf(1, 1000)),
    { kind: "timer" },
    AFTER_HOLD,
  );
  assert.equal(utilOnly.state.congestion, "SHEDDING_T1");
});

test("表 6 行目: SHEDDING_SPATIAL は util > 1.2 で KEY_ONLY へ遷移し E_NODE_OVERLOADED を通知する", () => {
  const result = step(stateWith("SHEDDING_SPATIAL", 121, 100, null), { kind: "timer" }, AFTER_HOLD);
  assert.equal(result.state.congestion, "KEY_ONLY");
  const notify = result.commands.filter((c) => c.kind === "notify");
  assert.equal(notify.length, 1, "KEY_ONLY への遷移で通知が 1 件出る");
  const notYet = step(stateWith("SHEDDING_SPATIAL", 119, 100, null), { kind: "timer" }, AFTER_HOLD);
  assert.equal(notYet.state.congestion, "SHEDDING_SPATIAL");
  assert.equal(notYet.commands.length, 0);
});

test("表 7 行目: SHEDDING_SPATIAL は util < 0.9 かつ maxTrend < -0.005 で SHEDDING_T1 へ戻る", () => {
  const both = step(
    stateWith("SHEDDING_SPATIAL", 89, 100, trendOf(-6, 1000)),
    { kind: "timer" },
    AFTER_HOLD,
  );
  assert.equal(both.state.congestion, "SHEDDING_T1");
});

test("表 8 行目: KEY_ONLY は util < 1.0 かつ maxTrend < 0 で SHEDDING_SPATIAL へ戻る", () => {
  const both = step(
    stateWith("KEY_ONLY", 99, 100, trendOf(-1, 1000)),
    { kind: "timer" },
    AFTER_HOLD,
  );
  assert.equal(both.state.congestion, "SHEDDING_SPATIAL");
  // 勾配が 0 のとき（< 0 を満たさない）は戻らない
  const zeroTrend = step(
    stateWith("KEY_ONLY", 99, 100, trendOf(0, 1)),
    { kind: "timer" },
    AFTER_HOLD,
  );
  assert.equal(zeroTrend.state.congestion, "KEY_ONLY");
});

test("ヒステリシス: 遷移から 500 ms 未満では再遷移しない", () => {
  const state = stateWith("NORMAL", 200, 100, null);
  const tooEarly = step(state, { kind: "timer" }, SHEDDING_HYSTERESIS_MS - 1);
  assert.equal(tooEarly.state.congestion, "NORMAL");
  const justEnough = step(state, { kind: "timer" }, SHEDDING_HYSTERESIS_MS);
  assert.equal(justEnough.state.congestion, "SHEDDING_T2");
});

test("SHEDDING_SPATIAL は最上位 spatialId のみを破棄し、下位層は転送する", () => {
  // 送信者 1 の最大 spatialId を 3 として観測させ、その後 SHEDDING_SPATIAL に置く。
  let state = initialState(0);
  const sub = step(state, { kind: "subscribe", from: 2, to: 1, want: true, maxSpatialId: 3 }, 0);
  state = sub.state;
  const observed = step(
    state,
    { kind: "media", from: 1, ch: 1, sid: 3, tid: 0, key: true, bytes: 1000, flags: 0b1001 },
    10,
  );
  state = { ...observed.state, congestion: "SHEDDING_SPATIAL", congestionEnteredAt: 10 };

  // 最上位（sid=3）かつ temporalId 0 の非 KEY は破棄される
  const top = step(
    state,
    { kind: "media", from: 1, ch: 1, sid: 3, tid: 0, key: false, bytes: 1000, flags: 0b1000 },
    20,
  );
  assert.deepEqual(
    top.commands.map((c) => c.kind),
    ["drop"],
    "最上位 spatialId は破棄される",
  );

  // 下位層（sid=0）で temporalId 0 なら転送される
  const low = step(
    state,
    { kind: "media", from: 1, ch: 1, sid: 0, tid: 0, key: false, bytes: 1000, flags: 0b1000 },
    20,
  );
  assert.deepEqual(
    low.commands.map((c) => c.kind),
    ["forward"],
    "下位 spatialId は転送される（全層破棄は過剰）",
  );
});

test("凍結トレースを再生すると輻輳 5 状態すべてと回復方向の遷移が現れる", () => {
  const lines = readFileSync("spec/vectors/trace-shard.jsonl", "utf8").trim().split("\n");
  const visited = new Set<CongestionState>();
  let recovered = 0;
  let state = initialState(1000);
  for (const line of lines) {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || !("in" in parsed)) {
      continue;
    }
    const record: Record<string, unknown> = { ...parsed };
    const t = typeof record["t"] === "number" ? record["t"] : 0;
    const event = record["in"];
    // トレースの入力は shard-core の ShardEvent と同じ形である。
    const before = state.congestion;
    const result = step(state, event as never, t);
    state = result.state;
    visited.add(state.congestion);
    if (rank(state.congestion) < rank(before)) {
      recovered += 1;
    }
  }
  assert.deepEqual(
    [...visited].sort(),
    ["KEY_ONLY", "NORMAL", "SHEDDING_SPATIAL", "SHEDDING_T1", "SHEDDING_T2"],
    "5 状態すべてを通る",
  );
  assert.ok(recovered >= 1, `回復方向の遷移が 1 回以上ある（実際 ${recovered} 回）`);
});

function rank(state: CongestionState): number {
  switch (state) {
    case "NORMAL":
      return 0;
    case "SHEDDING_T2":
      return 1;
    case "SHEDDING_T1":
      return 2;
    case "SHEDDING_SPATIAL":
      return 3;
    case "KEY_ONLY":
      return 4;
  }
}
