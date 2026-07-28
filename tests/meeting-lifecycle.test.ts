/**
 * 会議のライフサイクル（state-machines.md 6 節）の試験。
 *
 * 状態は CREATED / OPEN / LOCKED / ENDED である。表に無い遷移は無視して記録する
 * （AGENTS 5.4「状態機械の表に無い遷移を実装しない」）。
 *
 * なぜ必要か: 実装前は誰でもいつでも参加でき、終了した会議へも入れた。施錠と終了は
 * 主催者の権限であり、これが無いと会議を閉じられない。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { initialMetaState, metaStep, type MetaState } from "../packages/core/src/meta-core.ts";

/** 参加者を順に入れる。 */
function withParticipants(state: MetaState, ids: readonly number[]): MetaState {
  let current = state;
  for (const id of ids) {
    current = metaStep(current, { kind: "join", id }).state;
  }
  return current;
}

test("最初の参加者で CREATED から OPEN へ移り、参加者リストを配信する", () => {
  const state = initialMetaState();
  assert.equal(state.lifecycle, "CREATED", "誰も繋いでいない間は CREATED である");
  const result = metaStep(state, { kind: "join", id: 1 });
  assert.equal(result.state.lifecycle, "OPEN");
  assert.deepEqual(
    result.commands.filter((command) => command.kind === "publishParticipants"),
    [{ kind: "publishParticipants", participants: [1] }],
  );
});

test("参加のたびに参加者リストを配信する", () => {
  let state = initialMetaState();
  state = metaStep(state, { kind: "join", id: 1 }).state;
  const result = metaStep(state, { kind: "join", id: 2 });
  const published = result.commands.filter((command) => command.kind === "publishParticipants");
  assert.equal(published.length, 1);
  assert.deepEqual(published[0], { kind: "publishParticipants", participants: [1, 2] });
});

test("上限に達した会議は E_ROOM_FULL で拒否する", () => {
  const state = withParticipants(initialMetaState(2), [1, 2]);
  const result = metaStep(state, { kind: "join", id: 3 });
  assert.deepEqual(result.commands, [{ kind: "reject", id: 3, code: "E_ROOM_FULL" }]);
  assert.deepEqual(result.state.participants, [1, 2], "拒否された参加者は加わらない");
});

test("上限の指定が無い会議は人数で拒否しない", () => {
  // 規範は「会議作成時に指定」と定める。既定で勝手な上限を課さない。
  const state = withParticipants(initialMetaState(), [1, 2, 3, 4, 5]);
  const result = metaStep(state, { kind: "join", id: 6 });
  assert.equal(
    result.commands.some((command) => command.kind === "reject"),
    false,
  );
});

test("施錠すると新規参加を拒否する", () => {
  let state = withParticipants(initialMetaState(), [1, 2]);
  state = metaStep(state, { kind: "lock" }).state;
  assert.equal(state.lifecycle, "LOCKED");
  const result = metaStep(state, { kind: "join", id: 3 });
  assert.deepEqual(result.commands, [{ kind: "reject", id: 3, code: "E_MEETING_LOCKED" }]);
});

test("施錠中でも既に居る参加者の再接続は拒否しない", () => {
  // 回線の切り替え（予備接続）で同じ参加者が繋ぎ直すことがある。施錠は新規参加を止める
  // ためのものであり、既存の参加者を追い出すものではない。
  let state = withParticipants(initialMetaState(), [1, 2]);
  state = metaStep(state, { kind: "lock" }).state;
  const result = metaStep(state, { kind: "join", id: 2 });
  assert.equal(
    result.commands.some((command) => command.kind === "reject"),
    false,
  );
});

test("解錠すると再び参加できる", () => {
  let state = withParticipants(initialMetaState(), [1]);
  state = metaStep(state, { kind: "lock" }).state;
  state = metaStep(state, { kind: "unlock" }).state;
  assert.equal(state.lifecycle, "OPEN");
  const result = metaStep(state, { kind: "join", id: 2 });
  assert.equal(
    result.commands.some((command) => command.kind === "reject"),
    false,
  );
});

test("主催者の終了で全参加者を切断し、終了を記録する", () => {
  const state = withParticipants(initialMetaState(), [1, 2, 3]);
  const result = metaStep(state, { kind: "end" });
  assert.equal(result.state.lifecycle, "ENDED");
  assert.deepEqual(result.commands, [
    { kind: "closeAll", code: "E_MEETING_ENDED" },
    { kind: "recordEnd" },
  ]);
  assert.deepEqual(result.state.participants, [], "終了後は参加者を残さない");
});

test("施錠中でも終了できる", () => {
  let state = withParticipants(initialMetaState(), [1]);
  state = metaStep(state, { kind: "lock" }).state;
  const result = metaStep(state, { kind: "end" });
  assert.equal(result.state.lifecycle, "ENDED");
});

test("全員が退出すると会議は終了し、終了を記録する", () => {
  let state = withParticipants(initialMetaState(), [1, 2]);
  state = metaStep(state, { kind: "leave", id: 1 }).state;
  assert.equal(state.lifecycle, "OPEN", "1 人残っていれば続く");
  const result = metaStep(state, { kind: "leave", id: 2 });
  assert.equal(result.state.lifecycle, "ENDED");
  assert.deepEqual(result.commands, [{ kind: "recordEnd" }]);
});

test("終了した会議への参加は E_MEETING_ENDED で拒否する", () => {
  let state = withParticipants(initialMetaState(), [1]);
  state = metaStep(state, { kind: "end" }).state;
  const result = metaStep(state, { kind: "join", id: 2 });
  assert.deepEqual(result.commands, [{ kind: "reject", id: 2, code: "E_MEETING_ENDED" }]);
  assert.equal(result.state.lifecycle, "ENDED", "ENDED は終端である");
});

test("ENDED からは施錠も解錠もできず、記録だけが残る", () => {
  let state = withParticipants(initialMetaState(), [1]);
  state = metaStep(state, { kind: "end" }).state;
  const locked = metaStep(state, { kind: "lock" });
  assert.equal(locked.state.lifecycle, "ENDED");
  assert.deepEqual(locked.commands, [], "表に無い遷移は副作用を出さない");
  assert.ok(locked.state.unexpectedEvents.includes("lock"), "無視した記録が残る");
  const ended = metaStep(state, { kind: "end" });
  assert.ok(ended.state.unexpectedEvents.includes("end"));
});

test("CREATED からの施錠は表に無いため無視する", () => {
  const result = metaStep(initialMetaState(), { kind: "lock" });
  assert.equal(result.state.lifecycle, "CREATED");
  assert.ok(result.state.unexpectedEvents.includes("lock"));
});

test("OPEN での解錠は表に無いため無視する", () => {
  const state = withParticipants(initialMetaState(), [1]);
  const result = metaStep(state, { kind: "unlock" });
  assert.equal(result.state.lifecycle, "OPEN");
  assert.ok(result.state.unexpectedEvents.includes("unlock"));
});
