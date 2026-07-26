/**
 * shard-core の検証。
 *
 * - tier 超過ユニットが転送されないこと
 * - 破棄順位が spec/vectors/drop-order.json の全件と一致すること
 * - 同じ入力列に対して 2 回実行すると同じ出力列が出ること（決定性）
 * - 状態遷移が state-machines.md 3 節の表に無い遷移を行わないこと
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  step,
  initialState,
  type ShardEvent,
  type MediaEvent,
  type CongestionState,
} from "../packages/core/src/shard-core.ts";

import { dropPriority } from "../packages/core/src/wire.ts";

import {
  FLAG_KEY,
  FLAG_DISCARDABLE,
  CHANNEL_VIDEO,
  CHANNEL_AUDIO,
} from "../packages/core/src/generated/wire-layout.ts";

import { NODE_MAX_OUT_BYTES_PER_SEC } from "../packages/core/src/generated/constants.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));
const vectorsPath = join(thisDir, "..", "spec", "vectors", "drop-order.json");

// --- テスト: tier 超過ユニットが転送されない ---

describe("shard-core: tier フィルタリング", () => {
  it("spatialId が tier 以下のユニットのみ転送される", () => {
    const t = 1000;
    let state = initialState(t);

    // 参加者 10（送信者）と 20（受信者）を追加
    const joinResult1 = step(state, { kind: "join", id: 10 }, t);
    state = joinResult1.state;
    const joinResult2 = step(state, { kind: "join", id: 20 }, t);
    state = joinResult2.state;

    // 受信者 20 が送信者 10 を購読、maxSpatialId=1（tier=1）
    const subResult = step(state, {
      kind: "subscribe",
      from: 20,
      to: 10,
      want: true,
      maxSpatialId: 1,
    }, t);
    state = subResult.state;

    // spatialId=0 のユニット → 転送される
    const media0: MediaEvent = {
      kind: "media",
      from: 10,
      ch: CHANNEL_VIDEO,
      sid: 0,
      tid: 0,
      key: true,
      bytes: 5000,
      flags: FLAG_KEY,
    };
    const result0 = step(state, media0, t + 1);
    state = result0.state;
    assert.equal(result0.commands.length, 1);
    const cmd0 = result0.commands[0];
    assert.ok(cmd0 !== undefined);
    assert.equal(cmd0.kind, "forward");
    if (cmd0.kind === "forward") {
      assert.deepEqual(cmd0.to, [20]);
    }

    // spatialId=1 のユニット → 転送される（tier と等しい）
    const media1: MediaEvent = {
      kind: "media",
      from: 10,
      ch: CHANNEL_VIDEO,
      sid: 1,
      tid: 0,
      key: true,
      bytes: 5000,
      flags: FLAG_KEY,
    };
    const result1 = step(state, media1, t + 2);
    state = result1.state;
    assert.equal(result1.commands.length, 1);
    const cmd1 = result1.commands[0];
    assert.ok(cmd1 !== undefined);
    assert.equal(cmd1.kind, "forward");

    // spatialId=2 のユニット → tier 超過、転送されない
    const media2: MediaEvent = {
      kind: "media",
      from: 10,
      ch: CHANNEL_VIDEO,
      sid: 2,
      tid: 0,
      key: true,
      bytes: 5000,
      flags: FLAG_KEY,
    };
    const result2 = step(state, media2, t + 3);
    // 転送先が無いためコマンドが出ない
    assert.equal(result2.commands.length, 0);

    // spatialId=3 のユニット → tier 超過、転送されない
    const media3: MediaEvent = {
      kind: "media",
      from: 10,
      ch: CHANNEL_VIDEO,
      sid: 3,
      tid: 0,
      key: true,
      bytes: 5000,
      flags: FLAG_KEY,
    };
    const result3 = step(state, media3, t + 4);
    assert.equal(result3.commands.length, 0);
  });

  it("複数の受信者で tier が異なる場合、各自の tier に応じて転送される", () => {
    const t = 2000;
    let state = initialState(t);

    // 送信者 1、受信者 2（tier=0）、受信者 3（tier=2）
    state = step(state, { kind: "join", id: 1 }, t).state;
    state = step(state, { kind: "join", id: 2 }, t).state;
    state = step(state, { kind: "join", id: 3 }, t).state;

    state = step(state, { kind: "subscribe", from: 2, to: 1, want: true, maxSpatialId: 0 }, t).state;
    state = step(state, { kind: "subscribe", from: 3, to: 1, want: true, maxSpatialId: 2 }, t).state;

    // spatialId=0 → 受信者 2 と 3 の両方
    const r0 = step(state, {
      kind: "media", from: 1, ch: CHANNEL_VIDEO, sid: 0, tid: 0, key: true, bytes: 1000, flags: FLAG_KEY,
    }, t + 1);
    state = r0.state;
    const fwd0 = r0.commands[0];
    assert.ok(fwd0 !== undefined);
    assert.equal(fwd0.kind, "forward");
    if (fwd0.kind === "forward") {
      assert.deepEqual(fwd0.to, [2, 3]);
    }

    // spatialId=1 → 受信者 3 のみ（2 は tier=0）
    const r1 = step(state, {
      kind: "media", from: 1, ch: CHANNEL_VIDEO, sid: 1, tid: 0, key: true, bytes: 1000, flags: FLAG_KEY,
    }, t + 2);
    state = r1.state;
    const fwd1 = r1.commands[0];
    assert.ok(fwd1 !== undefined);
    assert.equal(fwd1.kind, "forward");
    if (fwd1.kind === "forward") {
      assert.deepEqual(fwd1.to, [3]);
    }

    // spatialId=3 → 誰にも転送されない（3 の tier=2）
    const r3 = step(state, {
      kind: "media", from: 1, ch: CHANNEL_VIDEO, sid: 3, tid: 0, key: true, bytes: 1000, flags: FLAG_KEY,
    }, t + 3);
    assert.equal(r3.commands.length, 0);
  });
});

// --- テスト: 破棄順位が drop-order.json と一致する ---

interface DropOrderVector {
  readonly name: string;
  readonly channel: number;
  readonly flags: number;
  readonly expectedPriority: number | null;
}

function isDropOrderVector(v: unknown): v is DropOrderVector {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj["name"] === "string" &&
    typeof obj["channel"] === "number" &&
    typeof obj["flags"] === "number" &&
    (typeof obj["expectedPriority"] === "number" || obj["expectedPriority"] === null)
  );
}

describe("shard-core: 破棄順位", () => {
  it("drop-order.json の全件と一致する", async () => {
    const content = await readFile(vectorsPath, "utf8");
    const parsed: unknown = JSON.parse(content);
    assert.ok(Array.isArray(parsed), "drop-order.json は配列であること");

    for (const entry of parsed) {
      assert.ok(isDropOrderVector(entry), `不正なベクタ: ${JSON.stringify(entry)}`);
      const actual = dropPriority(entry.channel, entry.flags);
      assert.equal(
        actual,
        entry.expectedPriority,
        `${entry.name}: expected=${entry.expectedPriority}, actual=${actual}`,
      );
    }
  });
});

// --- テスト: 決定性 ---

describe("shard-core: 決定性", () => {
  it("同じ入力列に対して 2 回実行すると同じ出力列が出る", () => {
    const events: Array<{ event: ShardEvent; t: number }> = [
      { event: { kind: "join", id: 1 }, t: 100 },
      { event: { kind: "join", id: 2 }, t: 100 },
      { event: { kind: "join", id: 3 }, t: 100 },
      { event: { kind: "subscribe", from: 2, to: 1, want: true, maxSpatialId: 2 }, t: 100 },
      { event: { kind: "subscribe", from: 3, to: 1, want: true, maxSpatialId: 1 }, t: 100 },
      { event: { kind: "media", from: 1, ch: CHANNEL_VIDEO, sid: 0, tid: 0, key: true, bytes: 2000, flags: FLAG_KEY }, t: 200 },
      { event: { kind: "media", from: 1, ch: CHANNEL_VIDEO, sid: 1, tid: 1, key: false, bytes: 1500, flags: FLAG_DISCARDABLE }, t: 201 },
      { event: { kind: "media", from: 1, ch: CHANNEL_VIDEO, sid: 2, tid: 0, key: false, bytes: 3000, flags: 0 }, t: 202 },
      { event: { kind: "media", from: 1, ch: CHANNEL_AUDIO, sid: 0, tid: 0, key: false, bytes: 80, flags: 0 }, t: 203 },
      { event: { kind: "budget", bytesPerSec: 100000000 }, t: 300 },
      { event: { kind: "leave", id: 3 }, t: 400 },
      { event: { kind: "media", from: 1, ch: CHANNEL_VIDEO, sid: 0, tid: 0, key: true, bytes: 2000, flags: FLAG_KEY }, t: 500 },
    ];

    function runOnce(): string[] {
      let state = initialState(0);
      const outputs: string[] = [];
      for (const { event, t } of events) {
        const result = step(state, event, t);
        state = result.state;
        outputs.push(JSON.stringify(result.commands));
      }
      return outputs;
    }

    const run1 = runOnce();
    const run2 = runOnce();

    assert.equal(run1.length, run2.length);
    for (let i = 0; i < run1.length; i += 1) {
      const r1 = run1[i];
      const r2 = run2[i];
      assert.ok(r1 !== undefined);
      assert.ok(r2 !== undefined);
      assert.equal(r1, r2, `出力列のインデックス ${i} が不一致`);
    }
  });
});

// --- テスト: 状態遷移が表に無い遷移を行わない ---

// state-machines.md 3 節の有効な遷移を定義する
const VALID_TRANSITIONS: ReadonlyMap<CongestionState, ReadonlySet<CongestionState>> = new Map([
  ["NORMAL", new Set<CongestionState>(["NORMAL", "SHEDDING_T2"])],
  ["SHEDDING_T2", new Set<CongestionState>(["SHEDDING_T2", "NORMAL", "SHEDDING_T1"])],
  ["SHEDDING_T1", new Set<CongestionState>(["SHEDDING_T1", "SHEDDING_T2", "SHEDDING_SPATIAL"])],
  ["SHEDDING_SPATIAL", new Set<CongestionState>(["SHEDDING_SPATIAL", "SHEDDING_T1", "KEY_ONLY"])],
  ["KEY_ONLY", new Set<CongestionState>(["KEY_ONLY", "SHEDDING_SPATIAL"])],
]);

describe("shard-core: 状態遷移の合法性", () => {
  it("輻輳状態の遷移が表に存在するもののみ", () => {
    // 様々な予算条件で遷移を発生させ、全てが合法であることを検証する
    let state = initialState(0);

    // 参加者と購読を作り、大量のメディアで負荷を上げる
    state = step(state, { kind: "join", id: 1 }, 0).state;
    state = step(state, { kind: "join", id: 2 }, 0).state;
    state = step(state, { kind: "subscribe", from: 2, to: 1, want: true, maxSpatialId: 3 }, 0).state;

    const transitions: Array<{ from: CongestionState; to: CongestionState }> = [];
    let t = 100;

    // 予算を非常に小さくして負荷超過を誘発する
    const budgetResult = step(state, { kind: "budget", bytesPerSec: 100 }, t);
    state = budgetResult.state;

    // 多数のメディアイベントを送って状態遷移を発生させる
    for (let i = 0; i < 200; i += 1) {
      t += 600; // ヒステリシスを超える
      const media: MediaEvent = {
        kind: "media",
        from: 1,
        ch: CHANNEL_VIDEO,
        sid: 0,
        tid: 0,
        key: false,
        bytes: 50000,
        flags: 0,
      };
      const result = step(state, media, t);
      state = result.state;

      // 予算イベントで遷移を評価
      const budgetEval = step(state, { kind: "budget", bytesPerSec: 100 }, t + 1);
      if (budgetEval.state.congestion !== state.congestion) {
        transitions.push({ from: state.congestion, to: budgetEval.state.congestion });
      }
      state = budgetEval.state;
    }

    // 予算を大きくして回復させる
    for (let i = 0; i < 100; i += 1) {
      t += 600;
      const budgetEval = step(state, { kind: "budget", bytesPerSec: NODE_MAX_OUT_BYTES_PER_SEC * 10 }, t);
      if (budgetEval.state.congestion !== state.congestion) {
        transitions.push({ from: state.congestion, to: budgetEval.state.congestion });
      }
      state = budgetEval.state;
    }

    // 全ての遷移が合法であることを検証
    for (const tr of transitions) {
      const validSet = VALID_TRANSITIONS.get(tr.from);
      assert.ok(validSet !== undefined, `未知の状態: ${tr.from}`);
      assert.ok(
        validSet.has(tr.to),
        `不正な遷移: ${tr.from} → ${tr.to}（許可: ${[...validSet].join(", ")}）`,
      );
    }
  });

  it("表に無いイベント（link）は無視して記録される", () => {
    const t = 1000;
    let state = initialState(t);

    const result = step(state, { kind: "link", peer: 5, state: "up" }, t);
    assert.equal(result.commands.length, 0);
    assert.ok(result.state.unexpectedEvents.length > 0);
    const lastEvent = result.state.unexpectedEvents[result.state.unexpectedEvents.length - 1];
    assert.equal(lastEvent, "link");
  });
});
