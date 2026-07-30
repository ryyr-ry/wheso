/**
 * 受信ノードの購読と段の配分を検証する。
 *
 * 規範: state-machines.md 2 節（購読の表）、congestion.md 4.3（段の配分）、
 *       ADR-0027（はしごと表示寸法）、ADR-0029（狭帯域では音声を守る）。
 *
 * 表と ADR から書く。実装をなぞらない（ADR-0012 の趣旨）。
 *
 * 検証する中核は 4 つである。
 *   1. 費用は**送信者の申告ビットレート**で見積もる（大域の定数を使わない）
 *   2. **表示寸法が段の上限**である（サムネイルが 4K を引かない）
 *   3. 初期状態は最低である（参加直後に高い段を要求しない）
 *   4. 帯域が足りないときは映像を落として**音声を守る**
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  initialReceiverState,
  receiverStep,
  RECEIVER_SELF_ID,
  type CatalogLadder,
  type ReceiverCommand,
  type ReceiverState,
} from "../packages/core/src/receiver-core.ts";
import { CHANNEL_AUDIO, CHANNEL_VIDEO, MAX_TEMPORAL_ID } from "../packages/core/src/generated/wire-layout.ts";
import {
  AUDIO_ONLY_ENTER_BPS,
  AUDIO_ONLY_EXIT_BPS,
  MIN_VIABLE_BPS,
  V_1080P30,
  V_360P15,
  V_4K60,
} from "../packages/core/src/generated/constants.ts";

/** 3 段のはしご（640 / 1920 / 3840）。段番号は 0 から密（ADR-0026）。 */
function ladderFor(senderId: number): CatalogLadder {
  return {
    senderId,
    channel: CHANNEL_VIDEO,
    rungs: [
      {
        sid: 0,
        width: V_360P15.width,
        height: V_360P15.height,
        framerate: V_360P15.framerate,
        temporalLayers: V_360P15.temporalLayers,
        targetBitrate: V_360P15.targetBitrate,
      },
      {
        sid: 1,
        width: V_1080P30.width,
        height: V_1080P30.height,
        framerate: V_1080P30.framerate,
        temporalLayers: V_1080P30.temporalLayers,
        targetBitrate: V_1080P30.targetBitrate,
      },
      {
        sid: 2,
        width: V_4K60.width,
        height: V_4K60.height,
        framerate: V_4K60.framerate,
        temporalLayers: V_4K60.temporalLayers,
        targetBitrate: V_4K60.targetBitrate,
      },
    ],
  };
}

/**
 * 目標（bytes/sec）を、回線の速度が指定の bits/sec になるように作る。
 *
 * `reallocate` は回線速度（target × 8）で AUDIO_ONLY を判定し、その 9/10 で段を買う。
 */
function budgetFor(bps: number): number {
  // 切り捨てる。切り上げると境界の直下を作れない（linkBps が閾値に一致してしまう）。
  return Math.trunc(bps / 8);
}

/** はしごと予算を与えた初期状態を作る。 */
function ready(senderIds: readonly number[], bps: number): ReceiverState {
  let state = initialReceiverState();
  state = receiverStep(state, { kind: "catalog", entries: senderIds.map(ladderFor) }, 0).state;
  state = receiverStep(state, { kind: "budget", bytesPerSec: budgetFor(bps) }, 0).state;
  return state;
}

function subscribeTo(
  state: ReceiverState,
  senderIds: readonly number[],
): { state: ReceiverState; commands: readonly ReceiverCommand[] } {
  return receiverStep(state, {
    kind: "subscribe",
    entries: senderIds.map((senderId) => ({
      senderId,
      channel: CHANNEL_VIDEO,
      maxSpatialId: 2,
      maxTemporalId: MAX_TEMPORAL_ID,
    })),
  });
}

function declare(state: ReceiverState, senderId: number, width: number): ReceiverState {
  return receiverStep(state, { kind: "displaySize", senderId, channel: CHANNEL_VIDEO, width }).state;
}

function tierOf(state: ReceiverState, senderId: number): number | undefined {
  return state.streams.find((s) => s.senderId === senderId && s.channel === CHANNEL_VIDEO)?.spatialId;
}

/* ------------------------------------------------------------------------- */

test("初期状態の目標は最低の成立点である（参加直後に高い段を要求しない）", () => {
  const state = initialReceiverState();
  assert.equal(state.targetBytesPerSec, Math.trunc(MIN_VIABLE_BPS / 8));
  assert.equal(state.targetCeilingBytesPerSec, Math.trunc(MIN_VIABLE_BPS / 8));
  assert.equal(state.audioOnly, false);
});

test("表 1 行目: 購読に含まれると SUBSCRIBED になり購読要求とキーフレーム要求を送る", () => {
  const result = subscribeTo(ready([7], V_4K60.targetBitrate * 4), [7]);
  assert.equal(result.state.streams[0]?.phase, "SUBSCRIBED");
  const kinds = result.commands.map((c) => c.kind);
  assert.ok(kinds.includes("subscribeChange"));
  assert.ok(kinds.includes("keyframeRequest"));
});

test("表 2 行目: 購読から外れると解除要求を送る", () => {
  const first = subscribeTo(ready([7, 8], V_4K60.targetBitrate * 4), [7, 8]);
  const second = subscribeTo(first.state, [7]);
  const removals = second.commands.filter((c) => c.kind === "subscribeChange" && !c.want);
  assert.equal(removals.length, 1);
  assert.equal(second.state.streams.length, 1);
});

test("表 6 行目: 送信者が退出すると購読とはしごが消える", () => {
  const state = subscribeTo(ready([7, 8], V_4K60.targetBitrate * 4), [7, 8]).state;
  const after = receiverStep(state, { kind: "leave", id: 7 });
  assert.deepEqual(
    after.state.streams.map((s) => s.senderId),
    [8],
  );
  assert.deepEqual(
    after.state.catalog.map((entry) => entry.senderId),
    [8],
  );
});

test("表 7 行目と 8 行目: 非表示で PAUSED になり、再表示で購読とキーフレーム要求を送る", () => {
  const state = subscribeTo(ready([7], V_4K60.targetBitrate * 4), [7]).state;
  const hidden = receiverStep(state, { kind: "visibility", visible: false });
  assert.equal(hidden.state.streams[0]?.phase, "PAUSED");
  assert.equal(hidden.commands.filter((c) => c.kind === "subscribeChange" && !c.want).length, 1);

  const shown = receiverStep(hidden.state, { kind: "visibility", visible: true });
  assert.equal(shown.state.streams[0]?.phase, "SUBSCRIBED");
  const kinds = shown.commands.map((c) => c.kind);
  assert.ok(kinds.includes("subscribeChange"));
  assert.ok(kinds.includes("keyframeRequest"));
});

test("**表示寸法が段の上限である**（サムネイルは 4K を引かない）", () => {
  // 予算は 4K を 4 本買える。表示寸法だけが上限を決める。
  let state = subscribeTo(ready([7, 8, 9], V_4K60.targetBitrate * 4), [7, 8, 9]).state;
  state = declare(state, 7, 160);
  state = declare(state, 8, 1280);
  state = declare(state, 9, 3840);
  assert.equal(tierOf(state, 7), 0, "160 px は最下段（640）で足りる");
  assert.equal(tierOf(state, 8), 1, "1280 px は 1920 の段");
  assert.equal(tierOf(state, 9), 2, "3840 px は最上段");
});

test("表示寸法の申告が無い相手は最下段に留まる（ADR-0015）", () => {
  const state = subscribeTo(ready([7], V_4K60.targetBitrate * 10), [7]).state;
  assert.equal(tierOf(state, 7), 0);
});

test("はしごを知らない相手は最下段に留まる（知らない相手へ高い段を要求しない）", () => {
  let state = initialReceiverState();
  state = receiverStep(state, { kind: "budget", bytesPerSec: budgetFor(V_4K60.targetBitrate * 4) }, 0).state;
  state = subscribeTo(state, [7]).state;
  state = declare(state, 7, 3840);
  assert.equal(tierOf(state, 7), 0);
});

test("**費用は申告ビットレートで見積もる**（予算に収まる段まで落とす）", () => {
  // 予算は 4K 1 本ぶん + 少し。2 人が 4K を要求すると、2 人目は下の段になる。
  let state = subscribeTo(ready([7, 8], V_4K60.targetBitrate + V_1080P30.targetBitrate), [7, 8]).state;
  state = declare(state, 7, 3840);
  state = declare(state, 8, 3840);
  const tiers = [tierOf(state, 7), tierOf(state, 8)].sort((a, b) => (a ?? 0) - (b ?? 0));
  assert.equal(tiers[1], 2, "1 人は最上段を得る");
  assert.ok((tiers[0] ?? 0) < 2, `もう 1 人は下の段になる（実際 ${String(tiers[0])}）`);
});

test("発話者が優先して高い段を得る", () => {
  let state = subscribeTo(ready([7, 8], V_4K60.targetBitrate + V_1080P30.targetBitrate), [7, 8]).state;
  state = declare(state, 7, 3840);
  state = declare(state, 8, 3840);
  state = receiverStep(state, { kind: "activeSpeaker", id: 8 }).state;
  assert.equal(tierOf(state, 8), 2, "発話者が最上段を得る");
  assert.ok((tierOf(state, 7) ?? 0) < 2, "もう 1 人は下がる");
});

test("**帯域が足りないと映像を落として音声を守る**（ADR-0029）", () => {
  let state = initialReceiverState();
  state = receiverStep(state, { kind: "catalog", entries: [ladderFor(7)] }, 0).state;
  state = receiverStep(state, {
    kind: "subscribe",
    entries: [
      { senderId: 7, channel: CHANNEL_VIDEO, maxSpatialId: 2, maxTemporalId: MAX_TEMPORAL_ID },
      { senderId: 7, channel: CHANNEL_AUDIO, maxSpatialId: 0, maxTemporalId: 0 },
    ],
  }).state;

  // 入る境界の直下へ落とす。
  const low = receiverStep(state, { kind: "budget", bytesPerSec: budgetFor(AUDIO_ONLY_ENTER_BPS - 1) });
  assert.equal(low.state.audioOnly, true);
  const video = low.state.streams.find((s) => s.channel === CHANNEL_VIDEO);
  const audio = low.state.streams.find((s) => s.channel === CHANNEL_AUDIO);
  assert.equal(video?.phase, "AUDIO_ONLY", "映像の購読を落とす");
  assert.equal(audio?.phase, "SUBSCRIBED", "**音声は維持する**");
  const removals = low.commands.filter((c) => c.kind === "subscribeChange" && !c.want);
  assert.equal(removals.length, 1);
  assert.equal(removals[0]?.kind === "subscribeChange" ? removals[0].channel : 0, CHANNEL_VIDEO);
  assert.ok(low.commands.some((c) => c.kind === "notify" && c.code === "W_DEGRADED"));
});

test("音声だけの状態から戻る条件は入る条件より高い（ヒステリシス）", () => {
  let state = initialReceiverState();
  state = receiverStep(state, { kind: "catalog", entries: [ladderFor(7)] }, 0).state;
  state = subscribeTo(state, [7]).state;
  state = receiverStep(state, { kind: "budget", bytesPerSec: budgetFor(AUDIO_ONLY_ENTER_BPS - 1) }).state;
  assert.equal(state.audioOnly, true);

  // 出る境界の直下ではまだ戻らない。
  const still = receiverStep(state, { kind: "budget", bytesPerSec: budgetFor(AUDIO_ONLY_EXIT_BPS - 1) });
  assert.equal(still.state.audioOnly, true, "入る条件を超えても出る条件までは戻さない");

  // 出る境界の直上で戻る。復帰は最下段から始める。
  const back = receiverStep(still.state, { kind: "budget", bytesPerSec: budgetFor(AUDIO_ONLY_EXIT_BPS + 1) });
  assert.equal(back.state.audioOnly, false);
  assert.equal(back.state.streams[0]?.phase, "SUBSCRIBED");
  assert.equal(back.state.streams[0]?.spatialId, 0, "復帰は最下段から（congestion.md 6 節）");
});

test("勾配が悪化すると段が 1 つ下がり、回復すると表示寸法の上限まで戻る", () => {
  let state = subscribeTo(ready([7], V_4K60.targetBitrate * 4), [7]).state;
  state = declare(state, 7, 3840);
  assert.equal(tierOf(state, 7), 2);

  const rising: number[] = [];
  const falling: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    rising.push(10_000 + i * 60_000);
    falling.push(1_200_000 - i * 60_000);
  }
  const lowered = receiverStep(state, { kind: "report", delayUs: rising }, 0);
  assert.equal(tierOf(lowered.state, 7), 1, "1 段下がる");
  assert.equal(lowered.commands.filter((c) => c.kind === "setTier").length, 1);

  const raised = receiverStep(lowered.state, { kind: "report", delayUs: falling }, 0);
  assert.equal(tierOf(raised.state, 7), 2, "1 段上がる");
  assert.ok(
    raised.commands.some((c) => c.kind === "keyframeRequest"),
    "段が変わるのでキーフレームを要求する",
  );
});

test("勾配が回復しても表示寸法の上限を超えて上げない", () => {
  let state = subscribeTo(ready([7], V_4K60.targetBitrate * 4), [7]).state;
  state = declare(state, 7, 160);
  assert.equal(tierOf(state, 7), 0);
  const falling: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    falling.push(1_200_000 - i * 60_000);
  }
  const raised = receiverStep(state, { kind: "report", delayUs: falling }, 0);
  assert.equal(tierOf(raised.state, 7), 0, "サムネイルのままである");
});

test("要求段を超えるユニットは転送しない", () => {
  const state = subscribeTo(ready([7], V_4K60.targetBitrate * 4), [7]).state;
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
  assert.deepEqual(
    dropped.commands.map((c) => c.kind),
    ["drop"],
  );

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
  assert.deepEqual(
    forwarded.commands.map((c) => c.kind),
    ["forward"],
  );
  assert.deepEqual(
    forwarded.commands[0]?.kind === "forward" ? forwarded.commands[0].to : [],
    [RECEIVER_SELF_ID],
  );
});

test("同じ入力列を 2 回流すと同じ出力になる（決定性）", () => {
  const run = (): readonly ReceiverCommand[] => {
    let state = ready([7, 8, 9], V_4K60.targetBitrate * 2);
    const collected: ReceiverCommand[] = [];
    const events: readonly Parameters<typeof receiverStep>[1][] = [
      {
        kind: "subscribe",
        entries: [7, 8, 9].map((senderId) => ({
          senderId,
          channel: CHANNEL_VIDEO,
          maxSpatialId: 2,
          maxTemporalId: MAX_TEMPORAL_ID,
        })),
      },
      { kind: "displaySize", senderId: 9, channel: CHANNEL_VIDEO, width: 1920 },
      { kind: "activeSpeaker", id: 8 },
      { kind: "displaySize", senderId: 8, channel: CHANNEL_VIDEO, width: 3840 },
      { kind: "leave", id: 7 },
    ];
    for (const event of events) {
      const result = receiverStep(state, event, 0);
      state = result.state;
      collected.push(...result.commands);
    }
    return collected;
  };
  assert.deepEqual(run(), run());
});
