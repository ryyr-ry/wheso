/**
 * 受信ノードの購読と tier が state-machines.md 2 節の表と一行ずつ一致することを検証する。
 *
 * 表から書く。実装をなぞらない（ADR-0012 の趣旨）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  initialReceiverState,
  receiverStep,
  RECEIVER_SELF_ID,
  type ReceiverCommand,
  type ReceiverState,
} from "../packages/core/src/receiver-core.ts";
import { CHANNEL_VIDEO } from "../packages/core/src/generated/wire-layout.ts";
import { V_360P15, V_4K60 } from "../packages/core/src/generated/constants.ts";

/** 高品質 1 本を賄える予算（bytes/sec）。4K60 は 25 Mbps。 */
const BUDGET_ONE_HIGH = Math.trunc((V_4K60.targetBitrate * 10) / (8 * 9)) + 1;

function subscribeTo(state: ReceiverState, senderIds: readonly number[]): {
  state: ReceiverState;
  commands: readonly ReceiverCommand[];
} {
  return receiverStep(state, {
    kind: "subscribe",
    entries: senderIds.map((senderId) => ({
      senderId,
      channel: CHANNEL_VIDEO,
      maxSpatialId: V_4K60.spatialId,
      maxTemporalId: 7,
    })),
  });
}

test("表 1 行目: 購読に含まれると SUBSCRIBED になり購読要求とキーフレーム要求を送る", () => {
  const result = subscribeTo(initialReceiverState(BUDGET_ONE_HIGH), [7]);
  const stream = result.state.streams[0];
  assert.equal(stream?.phase, "SUBSCRIBED");
  const kinds = result.commands.map((c) => c.kind);
  assert.ok(kinds.includes("subscribeChange"), "上流へ購読要求を送る");
  assert.ok(kinds.includes("keyframeRequest"), "キーフレーム要求を送る");
});

test("表 2 行目: 購読から外れると解除要求を送る", () => {
  const first = subscribeTo(initialReceiverState(BUDGET_ONE_HIGH), [7, 8]);
  const second = subscribeTo(first.state, [7]);
  const removals = second.commands.filter((c) => c.kind === "subscribeChange" && !c.want);
  assert.equal(removals.length, 1, "外れた 1 本の解除を送る");
  assert.equal(second.state.streams.length, 1);
});

test("表 3 行目: tier を下げるときはキーフレームを要求しない", () => {
  let state = subscribeTo(initialReceiverState(BUDGET_ONE_HIGH), [7]).state;
  state = receiverStep(state, { kind: "displaySize", senderId: 7, channel: CHANNEL_VIDEO, width: 3840 }).state;
  assert.equal(state.streams[0]?.spatialId, V_4K60.spatialId, "高品質が割り当たる");

  // 遅延が増える標本列を与えると tier を 1 段下げる。
  const rising: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    rising.push(10_000 + i * 1_000);
  }
  const lowered = receiverStep(state, { kind: "report", delayUs: rising });
  assert.equal(lowered.state.streams[0]?.spatialId, V_4K60.spatialId - 1, "1 段下がる");
  assert.equal(
    lowered.commands.filter((c) => c.kind === "keyframeRequest").length,
    0,
    "下げるときは要求しない",
  );
  assert.equal(lowered.commands.filter((c) => c.kind === "setTier").length, 1);
});

test("表 4 行目: tier を上げるときはキーフレームを要求する", () => {
  let state = subscribeTo(initialReceiverState(BUDGET_ONE_HIGH), [7]).state;
  state = receiverStep(state, { kind: "displaySize", senderId: 7, channel: CHANNEL_VIDEO, width: 3840 }).state;
  const rising: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    rising.push(10_000 + i * 1_000);
  }
  state = receiverStep(state, { kind: "report", delayUs: rising }).state;

  const falling: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    falling.push(30_000 - i * 1_000);
  }
  const raised = receiverStep(state, { kind: "report", delayUs: falling });
  assert.equal(raised.state.streams[0]?.spatialId, V_4K60.spatialId, "1 段上がる");
  assert.equal(
    raised.commands.filter((c) => c.kind === "keyframeRequest").length,
    1,
    "上げるときは要求する",
  );
});

test("表 6 行目: 送信者が退出すると購読が消える", () => {
  const state = subscribeTo(initialReceiverState(BUDGET_ONE_HIGH), [7, 8]).state;
  const after = receiverStep(state, { kind: "leave", id: 7 });
  assert.deepEqual(
    after.state.streams.map((s) => s.senderId),
    [8],
  );
});

test("表 7 行目と 8 行目: 非表示で PAUSED になり、再表示で購読とキーフレーム要求を送る", () => {
  const state = subscribeTo(initialReceiverState(BUDGET_ONE_HIGH), [7]).state;
  const hidden = receiverStep(state, { kind: "visibility", visible: false });
  assert.equal(hidden.state.streams[0]?.phase, "PAUSED");
  assert.equal(
    hidden.commands.filter((c) => c.kind === "subscribeChange" && !c.want).length,
    1,
    "解除を送る",
  );

  const shown = receiverStep(hidden.state, { kind: "visibility", visible: true });
  assert.equal(shown.state.streams[0]?.phase, "SUBSCRIBED");
  const kinds = shown.commands.map((c) => c.kind);
  assert.ok(kinds.includes("subscribeChange"));
  assert.ok(kinds.includes("keyframeRequest"));
});

test("表示寸法の申告が無い相手は最低品質に留まる", () => {
  const state = subscribeTo(initialReceiverState(BUDGET_ONE_HIGH * 10), [7]).state;
  assert.equal(state.streams[0]?.spatialId, V_360P15.spatialId, "申告が無ければサムネイル");
});

test("congestion.md 4.3: 予算に収まる人数だけが高品質になる", () => {
  // 2 人を購読し、寸法を申告する。予算は高品質 1 本分しかない。
  let state = subscribeTo(initialReceiverState(BUDGET_ONE_HIGH), [7, 8]).state;
  state = receiverStep(state, { kind: "displaySize", senderId: 7, channel: CHANNEL_VIDEO, width: 3840 }).state;
  state = receiverStep(state, { kind: "displaySize", senderId: 8, channel: CHANNEL_VIDEO, width: 3840 }).state;
  const tiers = state.streams.map((s) => s.spatialId).sort((a, b) => a - b);
  assert.deepEqual(tiers, [V_360P15.spatialId, V_4K60.spatialId], "1 本だけ高品質、残りはサムネイル");
});

test("発話者が優先して高品質になる", () => {
  let state = subscribeTo(initialReceiverState(BUDGET_ONE_HIGH), [7, 8]).state;
  state = receiverStep(state, { kind: "displaySize", senderId: 7, channel: CHANNEL_VIDEO, width: 3840 }).state;
  state = receiverStep(state, { kind: "displaySize", senderId: 8, channel: CHANNEL_VIDEO, width: 3840 }).state;
  state = receiverStep(state, { kind: "activeSpeaker", id: 8 }).state;
  const high = state.streams.filter((s) => s.spatialId === V_4K60.spatialId).map((s) => s.senderId);
  assert.deepEqual(high, [8], "発話者が高品質を得る");
});

test("予算が最低保証を下回ると W_DEGRADED を 1 回だけ通知する", () => {
  // サムネイル 1 本すら賄えない予算にする。
  const subscribed = subscribeTo(initialReceiverState(1000), [7, 8]).state;
  // 寸法を申告すると予算の割り当て対象になる。予算はサムネイル 1 本に足りない。
  const first = receiverStep(subscribed, { kind: "displaySize", senderId: 7, channel: CHANNEL_VIDEO, width: 640 });
  const notify = first.commands.filter((c) => c.kind === "notify");
  assert.equal(notify.length, 1, "低下した時点で 1 回通知する");
  assert.equal(notify[0]?.kind === "notify" ? notify[0].code : "", "W_DEGRADED");
  assert.equal(first.state.degraded, true);

  // 低下が続く間は繰り返し通知しない（利用側の表示が点滅するため）。
  const again = receiverStep(first.state, { kind: "displaySize", senderId: 8, channel: CHANNEL_VIDEO, width: 640 });
  assert.equal(again.commands.filter((c) => c.kind === "notify").length, 0);
});

test("要求 tier を超えるユニットは転送しない", () => {
  const state = subscribeTo(initialReceiverState(BUDGET_ONE_HIGH), [7]).state;
  // 申告が無いため tier は 0。spatialId 2 のユニットは捨てる。
  const dropped = receiverStep(state, {
    kind: "media",
    from: 7,
    ch: CHANNEL_VIDEO,
    sid: 2,
    tid: 0,
    key: true,
    bytes: 1000,
    flags: 0b1001,
  });
  assert.deepEqual(dropped.commands.map((c) => c.kind), ["drop"]);

  const forwarded = receiverStep(state, {
    kind: "media",
    from: 7,
    ch: CHANNEL_VIDEO,
    sid: 0,
    tid: 0,
    key: true,
    bytes: 1000,
    flags: 0b1001,
  });
  assert.deepEqual(forwarded.commands.map((c) => c.kind), ["forward"]);
  assert.deepEqual(
    forwarded.commands[0]?.kind === "forward" ? forwarded.commands[0].to : [],
    [RECEIVER_SELF_ID],
  );
});

test("同じ入力列を 2 回流すと同じ出力になる（決定性）", () => {
  const run = (): readonly ReceiverCommand[] => {
    let state = initialReceiverState(BUDGET_ONE_HIGH);
    const collected: ReceiverCommand[] = [];
    const events = [
      { kind: "subscribe" as const, entries: [7, 8, 9].map((senderId) => ({ senderId, channel: CHANNEL_VIDEO, maxSpatialId: 3, maxTemporalId: 7 })) },
      { kind: "displaySize" as const, senderId: 9, channel: CHANNEL_VIDEO, width: 1920 },
      { kind: "activeSpeaker" as const, id: 8 },
      { kind: "displaySize" as const, senderId: 8, channel: CHANNEL_VIDEO, width: 3840 },
      { kind: "leave" as const, id: 7 },
    ];
    for (const event of events) {
      const result = receiverStep(state, event);
      state = result.state;
      collected.push(...result.commands);
    }
    return collected;
  };
  assert.deepEqual(run(), run());
});
