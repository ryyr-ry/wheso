/**
 * 中継ノードの判断コアの中核的な保証を検証する。
 *
 * 検証する保証は 6 つである。いずれも「これが無いと悪い回線で壊れる」ものである。
 *
 *   1. 購読者へ渡すのは**ちょうど 1 段**である（ADR-0027）
 *   2. はしごが縮んでも黒画面にならない（安全弁）
 *   3. 送信窓が閉じると破棄され、ack で開く（congestion.md 2 節）
 *   4. 破棄禁止のユニット（KEY・音声）は窓が閉じていても渡る
 *   5. ack が途絶えた購読だけが止まり、他は巻き込まれない（congestion.md 7 節）
 *   6. ノード全体の予算超過は通知するが**転送を止めない**（ADR-0025 の 5）
 *
 * 加えてチャネルの分離と決定性を確かめる。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chosenRungOf,
  initialState,
  step,
  type LadderRung,
  type ShardCommand,
  type ShardEvent,
  type ShardState,
} from "../packages/core/src/shard-core.ts";
import {
  ACK_TIMEOUT_MS,
  NODE_MAX_OUT_BYTES_PER_SEC,
  SEND_WINDOW_MS,
  V_1080P30,
  V_360P15,
  V_4K60,
} from "../packages/core/src/generated/constants.ts";
import {
  CHANNEL_AUDIO,
  CHANNEL_VIDEO,
  FLAG_DISCARDABLE,
  FLAG_END_OF_FRAME,
  FLAG_KEY,
  MAX_TEMPORAL_ID,
} from "../packages/core/src/generated/wire-layout.ts";
import { ERROR_DEFINITIONS } from "../packages/core/src/generated/errors.ts";

const SENDER = 1;
const A = 2;
const B = 3;

/** 3 段のはしご。段番号は密に詰める（ADR-0026）。 */
const RUNGS: readonly LadderRung[] = [
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
];

function announce(rungs: readonly LadderRung[]): ShardEvent {
  return { kind: "streamAnnounce", from: SENDER, ch: CHANNEL_VIDEO, rungs };
}

function subscribe(from: number, tier: number, ch = CHANNEL_VIDEO): ShardEvent {
  return {
    kind: "subscribe",
    from,
    to: SENDER,
    ch,
    want: true,
    maxSpatialId: tier,
    maxTemporalId: MAX_TEMPORAL_ID,
  };
}

function media(sid: number, seq: number, options: { key?: boolean; tid?: number; ch?: number; bytes?: number } = {}): ShardEvent {
  const key = options.key ?? false;
  const tid = options.tid ?? 0;
  const discardable = !key && tid >= 2;
  return {
    kind: "media",
    from: SENDER,
    ch: options.ch ?? CHANNEL_VIDEO,
    sid,
    tid,
    key,
    bytes: options.bytes ?? 1000,
    flags: FLAG_END_OF_FRAME | (key ? FLAG_KEY : 0) | (discardable ? FLAG_DISCARDABLE : 0),
    seq,
  };
}

function ack(from: number, sid: number, highestSeq: number, ch = CHANNEL_VIDEO): ShardEvent {
  return { kind: "ack", from, to: SENDER, ch, sid, highestSeq };
}

/** 出力コマンドから forward の宛先を取り出す。無ければ null。 */
function forwardTargets(commands: readonly ShardCommand[]): readonly number[] | null {
  for (const command of commands) {
    if (command.kind === "forward") {
      return command.to;
    }
  }
  return null;
}

function dropCount(commands: readonly ShardCommand[]): number {
  let total = 0;
  for (const command of commands) {
    if (command.kind === "drop") {
      total += command.count;
    }
  }
  return total;
}

/** 参加者とはしごと購読を用意する。 */
function setup(tiers: readonly { readonly id: number; readonly tier: number }[]): ShardState {
  let state = initialState(0);
  state = step(state, { kind: "join", id: SENDER }, 0).state;
  for (const entry of tiers) {
    state = step(state, { kind: "join", id: entry.id }, 0).state;
  }
  state = step(state, announce(RUNGS), 0).state;
  for (const entry of tiers) {
    state = step(state, subscribe(entry.id, entry.tier), 0).state;
  }
  return state;
}

/* ------------------------------------------------------------------------- */

test("購読者へ渡すのはちょうど 1 段である（simulcast の段は独立している）", () => {
  // A は最上段（2）を、B は中段（1）を要求する。
  const state = setup([
    { id: A, tier: 2 },
    { id: B, tier: 1 },
  ]);
  assert.equal(chosenRungOf(state, A, SENDER, CHANNEL_VIDEO), 2);
  assert.equal(chosenRungOf(state, B, SENDER, CHANNEL_VIDEO), 1);

  // 段 0 は誰にも渡らない（`spatialId <= tier` なら A と B の両方へ渡ってしまう）。
  assert.equal(forwardTargets(step(state, media(0, 1), 10).commands), null);
  // 段 1 は B だけへ渡る。
  assert.deepEqual(forwardTargets(step(state, media(1, 1), 10).commands), [B]);
  // 段 2 は A だけへ渡る。
  assert.deepEqual(forwardTargets(step(state, media(2, 1), 10).commands), [A]);
});

test("最上段より高い段を要求しても、存在する最上段が渡る", () => {
  const state = setup([{ id: A, tier: 3 }]);
  assert.equal(chosenRungOf(state, A, SENDER, CHANNEL_VIDEO), 2);
  assert.deepEqual(forwardTargets(step(state, media(2, 1), 10).commands), [A]);
});

test("はしごが縮んでも黒画面にならない（存在する段から選ぶ）", () => {
  let state = setup([{ id: A, tier: 2 }]);
  // 発熱で段を 1 本に減らした。
  state = step(state, announce(RUNGS.slice(0, 1)), 10).state;
  assert.equal(chosenRungOf(state, A, SENDER, CHANNEL_VIDEO), 0);
  assert.deepEqual(forwardTargets(step(state, media(0, 1), 20).commands), [A]);
});

test("チャネルは分離される（映像の購読で音声を転送しない）", () => {
  let state = initialState(0);
  state = step(state, { kind: "join", id: SENDER }, 0).state;
  state = step(state, { kind: "join", id: A }, 0).state;
  state = step(state, announce(RUNGS), 0).state;
  // 映像のみ購読する。
  state = step(state, subscribe(A, 0), 0).state;
  assert.deepEqual(forwardTargets(step(state, media(0, 1), 10).commands), [A]);
  // 音声は購読していないため渡らない。
  assert.equal(forwardTargets(step(state, media(0, 1, { ch: CHANNEL_AUDIO }), 10).commands), null);
});

test("送信窓が閉じると破棄され、ack で再び開く（congestion.md 2 節）", () => {
  // 最下段は 15 fps。SEND_WINDOW_MS（200 ms）は 3 フレームに相当する。
  const framesInWindow = Math.trunc((SEND_WINDOW_MS * V_360P15.framerate) / 1000);
  let state = setup([{ id: A, tier: 0 }]);
  let t = 10;
  let forwarded = 0;
  let dropped = 0;
  for (let i = 1; i <= framesInWindow + 4; i += 1) {
    // 破棄可能なユニット（最上位の時間層）を送る。窓が閉じたら破棄される。
    const result = step(state, media(0, i, { tid: 2 }), t);
    state = result.state;
    if (forwardTargets(result.commands) !== null) {
      forwarded += 1;
    }
    dropped += dropCount(result.commands);
    t += 5;
  }
  // 窓の分だけ渡り、その先は破棄される。
  assert.ok(forwarded >= 1, `少なくとも 1 枚は渡る（実際 ${String(forwarded)}）`);
  assert.ok(dropped >= 1, `窓が閉じて破棄が起きる（実際 ${String(dropped)}）`);

  // ack を返すと窓が開き、再び渡る。
  state = step(state, ack(A, 0, framesInWindow + 4), t).state;
  const after = step(state, media(0, framesInWindow + 5, { tid: 2 }), t + 5);
  assert.deepEqual(forwardTargets(after.commands), [A]);
});

test("破棄禁止のユニットは窓が閉じていても渡る（KEY と音声）", () => {
  let state = setup([{ id: A, tier: 0 }]);
  state = step(state, subscribe(A, 0, CHANNEL_AUDIO), 0).state;
  let t = 10;
  // 窓を確実に閉じる。
  for (let i = 1; i <= 20; i += 1) {
    state = step(state, media(0, i, { tid: 2 }), t).state;
    t += 5;
  }
  // KEY は渡る。
  assert.deepEqual(forwardTargets(step(state, media(0, 100, { key: true }), t).commands), [A]);
  // 音声は渡る。
  assert.deepEqual(
    forwardTargets(step(state, media(0, 100, { ch: CHANNEL_AUDIO }), t).commands),
    [A],
  );
});

test("段が違う ack は適用されない（段ごとに seq の空間が独立している）", () => {
  let state = setup([{ id: A, tier: 0 }]);
  let t = 10;
  for (let i = 1; i <= 20; i += 1) {
    state = step(state, media(0, i, { tid: 2 }), t).state;
    t += 5;
  }
  // 段 1 への ack を送る。渡しているのは段 0 であるため適用されない。
  const wrong = step(state, ack(A, 1, 100), t);
  assert.deepEqual(wrong.commands, []);
  // 窓は閉じたままである。
  assert.equal(forwardTargets(step(wrong.state, media(0, 21, { tid: 2 }), t + 5).commands), null);
  // 正しい段の ack なら開く。
  const right = step(state, ack(A, 0, 20), t);
  assert.deepEqual(forwardTargets(step(right.state, media(0, 21, { tid: 2 }), t + 5).commands), [A]);
});

test("ack が途絶えた購読だけが止まり、他の購読は巻き込まれない", () => {
  let state = setup([
    { id: A, tier: 0 },
    { id: B, tier: 0 },
  ]);
  // 1 枚渡す。両方が未確認を持つ。
  state = step(state, media(0, 1, { key: true }), 10).state;
  // B だけが ack を返す。
  state = step(state, ack(B, 0, 1), 20).state;
  // ACK_TIMEOUT_MS を跨いでタイマーを打つ。
  const timer = step(state, { kind: "timer" }, 20 + ACK_TIMEOUT_MS + 1);
  state = timer.state;
  const disconnects = timer.commands.filter((c) => c.kind === "disconnect");
  assert.equal(disconnects.length, 1, "止まるのは ack を返さなかった 1 本だけである");
  assert.deepEqual(disconnects[0], { kind: "disconnect", peer: A });

  // 以後、A へは渡らず B へは渡る。
  const after = step(state, media(0, 2, { key: true }), 20 + ACK_TIMEOUT_MS + 10);
  assert.deepEqual(forwardTargets(after.commands), [B]);

  // 購読を張り直すと復帰する（再接続の経路）。
  const resubscribed = step(after.state, subscribe(A, 0), 20 + ACK_TIMEOUT_MS + 20);
  const revived = step(resubscribed.state, media(0, 3, { key: true }), 20 + ACK_TIMEOUT_MS + 30);
  assert.deepEqual(forwardTargets(revived.commands), [A, B]);
});

test("何も渡していない購読は ack 待ちで止められない", () => {
  const state = setup([{ id: A, tier: 0 }]);
  const timer = step(state, { kind: "timer" }, ACK_TIMEOUT_MS * 3);
  assert.equal(
    timer.commands.filter((c) => c.kind === "disconnect").length,
    0,
    "返すべき ack が無い相手を切ってはならない",
  );
});

test("ノード全体の予算超過は通知するが転送を止めない", () => {
  let state = setup([{ id: A, tier: 0 }]);
  // 予算を極端に絞る。
  state = step(state, { kind: "budget", bytesPerSec: 1000 }, 10).state;
  const result = step(state, media(0, 1, { key: true, bytes: 500000 }), 20);
  // 転送は行われる。
  assert.deepEqual(forwardTargets(result.commands), [A]);
  // 通知も出る。
  const notify = result.commands.filter((c) => c.kind === "notify");
  assert.equal(notify.length, 1);
  assert.deepEqual(notify[0], { kind: "notify", code: ERROR_DEFINITIONS.E_NODE_OVERLOADED.closeCode });
  // 同じ窓では繰り返し通知しない。
  const again = step(result.state, media(0, 2, { key: true, bytes: 500000 }), 30);
  assert.equal(again.commands.filter((c) => c.kind === "notify").length, 0);
});

test("退出すると購読・はしご・勾配・指令の記録がすべて消える", () => {
  let state = setup([{ id: A, tier: 2 }]);
  state = step(state, { kind: "report", from: A, delayUs: [1, 2, 3] }, 10).state;
  assert.equal(state.subscriptions.length, 1);
  assert.equal(state.trends.length, 1);
  assert.equal(state.ladders.length, 1);

  state = step(state, { kind: "leave", id: A }, 20).state;
  assert.equal(state.subscriptions.length, 0);
  assert.equal(state.trends.length, 0);
  assert.ok(!state.participants.includes(A));

  state = step(state, { kind: "leave", id: SENDER }, 30).state;
  assert.equal(state.ladders.length, 0);
  assert.equal(state.encoderTiers.length, 0);
});

test("同じ入力列に対して 2 回実行すると同じ出力列が出る", () => {
  const events: readonly { readonly event: ShardEvent; readonly t: number }[] = [
    { event: { kind: "join", id: SENDER }, t: 0 },
    { event: { kind: "join", id: A }, t: 1 },
    { event: { kind: "join", id: B }, t: 2 },
    { event: announce(RUNGS), t: 3 },
    { event: subscribe(A, 2), t: 4 },
    { event: subscribe(B, 0), t: 5 },
    { event: media(2, 1, { key: true }), t: 10 },
    { event: media(0, 1, { key: true }), t: 11 },
    { event: ack(A, 2, 1), t: 12 },
    { event: { kind: "report", from: B, delayUs: [1, 2, 3, 4] }, t: 13 },
    { event: { kind: "timer" }, t: 1000 },
  ];

  function run(): string {
    let state = initialState(0);
    const out: ShardCommand[] = [];
    for (const entry of events) {
      const result = step(state, entry.event, entry.t);
      state = result.state;
      out.push(...result.commands);
    }
    return JSON.stringify(out);
  }

  assert.equal(run(), run());
});

test("表に無いイベント（link）は無視して記録される", () => {
  const state = initialState(0);
  const result = step(state, { kind: "link", peer: 1, state: "down" }, 10);
  assert.deepEqual(result.commands, []);
  assert.deepEqual(result.state.unexpectedEvents, ["link"]);
});

test("初期の帯域予算はノードの送出容量である", () => {
  assert.equal(initialState(0).budgetBytesPerSec, NODE_MAX_OUT_BYTES_PER_SEC);
});
