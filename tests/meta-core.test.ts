/**
 * MetaRoom の判断コアの試験。
 *
 * 規範から書く。
 *   - room-naming.md 3 節: シャード数は単調非減少
 *   - room-naming.md 4 節: epoch は単調増加。シャード数が増えたときのみ上げる
 *   - 上書き表の範囲外の指定は拒否する（Rendezvous の結果へ落とさない）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { initialMetaState, metaStep, type MetaState } from "../packages/core/src/meta-core.ts";
import { V_SHARD_MAX_PARTICIPANTS } from "../packages/core/src/generated/constants.ts";

function joinMany(state: MetaState, count: number, from = 1): MetaState {
  let current = state;
  for (let i = 0; i < count; i += 1) {
    current = metaStep(current, { kind: "join", id: from + i }).state;
  }
  return current;
}

test("初期状態は epoch 1・シャード 1", () => {
  const state = initialMetaState();
  assert.equal(state.epoch, 1);
  assert.equal(state.shards, 1);
});

test("収容上限を超えるとシャードが増え epoch が上がる", () => {
  const withinOne = joinMany(initialMetaState(), V_SHARD_MAX_PARTICIPANTS);
  assert.equal(withinOne.shards, 1, "上限までは 1 シャード");
  assert.equal(withinOne.epoch, 1, "epoch は上がらない");

  const overflow = metaStep(withinOne, { kind: "join", id: 9999 });
  assert.equal(overflow.state.shards, 2);
  assert.equal(overflow.state.epoch, 2);
  const change = overflow.commands.filter((c) => c.kind === "epochChange");
  assert.equal(change.length, 1, "epoch の変化を配信する");
  assert.equal(change[0]?.kind === "epochChange" ? change[0].shards : 0, 2);
});

test("退出してもシャード数は減らない（再配置を避けるため）", () => {
  let state = joinMany(initialMetaState(), V_SHARD_MAX_PARTICIPANTS + 1);
  assert.equal(state.shards, 2);
  const epochAfterGrowth = state.epoch;
  for (let i = 0; i < V_SHARD_MAX_PARTICIPANTS; i += 1) {
    state = metaStep(state, { kind: "leave", id: 1 + i }).state;
  }
  assert.equal(state.shards, 2, "減らさない");
  assert.equal(state.epoch, epochAfterGrowth, "epoch も動かさない");
});

test("同じ参加者の重複 join は無視される", () => {
  const first = metaStep(initialMetaState(), { kind: "join", id: 5 });
  const second = metaStep(first.state, { kind: "join", id: 5 });
  assert.equal(second.state.participants.length, 1);
  assert.equal(second.commands.length, 0);
});

test("epoch は単調増加のみで、増加は 1 段ずつである", () => {
  let state = initialMetaState();
  const epochs: number[] = [state.epoch];
  for (let i = 0; i < V_SHARD_MAX_PARTICIPANTS * 3; i += 1) {
    state = metaStep(state, { kind: "join", id: i + 1 }).state;
    epochs.push(state.epoch);
  }
  for (let i = 1; i < epochs.length; i += 1) {
    const previous = epochs[i - 1] ?? 0;
    const current = epochs[i] ?? 0;
    assert.ok(current >= previous, "後退しない");
    assert.ok(current - previous <= 1, "一度に 2 段以上上がらない");
  }
  assert.equal(state.shards, 3, "35 人ごとに 1 シャード増える");
});

test("上書き表: 範囲内の指定は登録され配信される", () => {
  const grown = joinMany(initialMetaState(), V_SHARD_MAX_PARTICIPANTS + 1);
  const result = metaStep(grown, { kind: "override", participantId: 3, shardIndex: 1 });
  assert.deepEqual(result.state.overrides, [{ participantId: 3, shardIndex: 1 }]);
  assert.deepEqual(result.commands.map((c) => c.kind), ["publishOverrides"]);
});

test("上書き表: 範囲外の指定は拒否し Rendezvous の結果へ落とさない", () => {
  const state = initialMetaState();
  const result = metaStep(state, { kind: "override", participantId: 3, shardIndex: 5 });
  assert.deepEqual(result.state.overrides, [], "登録しない");
  const notify = result.commands.filter((c) => c.kind === "notify");
  assert.equal(notify.length, 1);
  assert.equal(notify[0]?.kind === "notify" ? notify[0].code : "", "E_NAME_SHARD_INDEX");
});

test("上書き表: 参加者の退出で該当の上書きが消える", () => {
  const grown = joinMany(initialMetaState(), V_SHARD_MAX_PARTICIPANTS + 1);
  const withOverride = metaStep(grown, { kind: "override", participantId: 3, shardIndex: 1 }).state;
  const afterLeave = metaStep(withOverride, { kind: "leave", id: 3 });
  assert.deepEqual(afterLeave.state.overrides, []);
});

test("同じ入力列を 2 回流すと同じ出力になる（決定性）", () => {
  const run = (): string => {
    let state = initialMetaState();
    const log: string[] = [];
    for (let i = 0; i < 80; i += 1) {
      const result = metaStep(state, { kind: "join", id: 100 - i });
      state = result.state;
      log.push(JSON.stringify(result.commands));
    }
    log.push(JSON.stringify(state.participants));
    return log.join("|");
  };
  assert.equal(run(), run());
});
