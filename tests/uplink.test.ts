/**
 * 上り輻輳と発熱による送信の降格を検証する（段 F の F-8）。
 *
 * 規範: congestion.md 3 節（ADR-0014）、client-architecture.md 10 節。
 *
 * 検証する性質:
 *   1. 滞留が 1 回超えただけでは降格しない（正常な揺れで誤検知しない）
 *   2. 規定回数連続したら 1 段降格する
 *   3. 滞留が 0 の状態が続けば昇格するが、降格の直後は昇格しない
 *   4. **発熱の昇格待ちは上りより長い**（冷えるまで戻らない）
 *   5. **1 段は必ず残す**（映像を完全に止めない）
 *   6. 符号化の待ち行列が続いたら降格する
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dropOf,
  initialUplink,
  noteBufferedAmount,
  noteEncodeQueue,
  type UplinkState,
} from "../packages/core/src/uplink.ts";
import {
  ENCODE_QUEUE_HOLD_MS,
  ENCODE_QUEUE_LIMIT,
  THERMAL_UPGRADE_HOLD_MS,
  UPLINK_BACKLOG_BYTES,
  UPLINK_DEGRADE_STREAK,
  UPLINK_RECOVER_MS,
  UPLINK_UPGRADE_HOLD_MS,
} from "../packages/core/src/generated/constants.ts";

/** 3 段のはしごを想定する。 */
const RUNGS = 3;

/** 滞留を規定回数だけ超えさせる。 */
function saturate(state: UplinkState, t: number): { state: UplinkState; t: number; changed: boolean } {
  let current = state;
  let now = t;
  let changed = false;
  for (let i = 0; i < UPLINK_DEGRADE_STREAK; i += 1) {
    const result = noteBufferedAmount(current, UPLINK_BACKLOG_BYTES + 1, RUNGS, now);
    current = result.state;
    changed = changed || result.changed;
    now += 200;
  }
  return { state: current, t: now, changed };
}

test("滞留が 1 回超えただけでは降格しない（正常な揺れで誤検知しない）", () => {
  const first = noteBufferedAmount(initialUplink(), UPLINK_BACKLOG_BYTES + 1, RUNGS, 0);
  assert.equal(first.changed, false);
  assert.equal(dropOf(first.state), 0);
});

test("規定回数連続したら 1 段降格する", () => {
  const result = saturate(initialUplink(), 0);
  assert.equal(result.changed, true);
  assert.equal(dropOf(result.state), 1);
  assert.equal(result.state.lastReason, "uplink");
});

test("滞留が上限以下に戻ると連続回数が切れる", () => {
  let state = initialUplink();
  state = noteBufferedAmount(state, UPLINK_BACKLOG_BYTES + 1, RUNGS, 0).state;
  state = noteBufferedAmount(state, UPLINK_BACKLOG_BYTES + 1, RUNGS, 200).state;
  // 1 回下回る。
  state = noteBufferedAmount(state, 1, RUNGS, 400).state;
  assert.equal(state.backlogStreak, 0);
  // 再び超えても、連続は 1 回目からである。
  const again = noteBufferedAmount(state, UPLINK_BACKLOG_BYTES + 1, RUNGS, 600);
  assert.equal(again.changed, false);
  assert.equal(dropOf(again.state), 0);
});

test("滞留が 0 の状態が続けば昇格するが、降格の直後は昇格しない", () => {
  const degraded = saturate(initialUplink(), 0);
  assert.equal(dropOf(degraded.state), 1);
  const downgradeAt = degraded.state.lastDowngradeAtMs;

  // 回復の時間は経っているが、降格からの待ちが明けていない。
  let state = degraded.state;
  let t = downgradeAt;
  state = noteBufferedAmount(state, 0, RUNGS, t).state;
  t += UPLINK_RECOVER_MS;
  const tooEarly = noteBufferedAmount(state, 0, RUNGS, t);
  assert.equal(tooEarly.changed, false, "降格から 10 秒は昇格しない");
  assert.equal(dropOf(tooEarly.state), 1);

  // 待ちが明けると昇格する。
  t = downgradeAt + UPLINK_UPGRADE_HOLD_MS + 1;
  const raised = noteBufferedAmount(tooEarly.state, 0, RUNGS, t);
  assert.equal(raised.changed, true);
  assert.equal(dropOf(raised.state), 0);
});

test("符号化の待ち行列が続いたら降格する", () => {
  let state = initialUplink();
  // 上限以下では何も起きない。
  const under = noteEncodeQueue(state, ENCODE_QUEUE_LIMIT, RUNGS, 0);
  assert.equal(under.changed, false);
  assert.equal(under.state.queueOverSinceMs, null);

  // 超えた直後は待つ。
  state = noteEncodeQueue(state, ENCODE_QUEUE_LIMIT + 1, RUNGS, 1000).state;
  const early = noteEncodeQueue(state, ENCODE_QUEUE_LIMIT + 1, RUNGS, 1000 + ENCODE_QUEUE_HOLD_MS - 1);
  assert.equal(early.changed, false);

  // 規定の時間が続くと降格する。
  const late = noteEncodeQueue(state, ENCODE_QUEUE_LIMIT + 1, RUNGS, 1000 + ENCODE_QUEUE_HOLD_MS);
  assert.equal(late.changed, true);
  assert.equal(dropOf(late.state), 1);
  assert.equal(late.state.lastReason, "thermal");
});

test("待ち行列が上限以下に戻ると起点が切れる", () => {
  let state = initialUplink();
  state = noteEncodeQueue(state, ENCODE_QUEUE_LIMIT + 1, RUNGS, 0).state;
  state = noteEncodeQueue(state, ENCODE_QUEUE_LIMIT, RUNGS, 100).state;
  assert.equal(state.queueOverSinceMs, null);
  const again = noteEncodeQueue(state, ENCODE_QUEUE_LIMIT + 1, RUNGS, 200 + ENCODE_QUEUE_HOLD_MS);
  assert.equal(again.changed, false, "起点が切れているので直ちには降格しない");
});

test("**発熱の昇格待ちは上りより長い**（冷えるまで戻らない）", () => {
  assert.ok(
    THERMAL_UPGRADE_HOLD_MS > UPLINK_UPGRADE_HOLD_MS,
    "発熱の待ちは上りの待ちより長い",
  );
  let state = initialUplink();
  state = noteEncodeQueue(state, ENCODE_QUEUE_LIMIT + 1, RUNGS, 0).state;
  const degraded = noteEncodeQueue(state, ENCODE_QUEUE_LIMIT + 1, RUNGS, ENCODE_QUEUE_HOLD_MS);
  assert.equal(degraded.state.lastReason, "thermal");
  const at = degraded.state.lastDowngradeAtMs;

  // 上りの待ちは明けたが、発熱の待ちは明けていない。
  let current = noteBufferedAmount(degraded.state, 0, RUNGS, at).state;
  const early = noteBufferedAmount(current, 0, RUNGS, at + UPLINK_UPGRADE_HOLD_MS + 1);
  assert.equal(early.changed, false, "上りの待ちでは昇格させない");

  current = early.state;
  const late = noteBufferedAmount(current, 0, RUNGS, at + THERMAL_UPGRADE_HOLD_MS + 1);
  assert.equal(late.changed, true, "発熱の待ちが明けたら昇格する");
});

test("**1 段は必ず残す**（映像を完全に止めない）", () => {
  let state = initialUplink();
  let t = 0;
  for (let round = 0; round < 10; round += 1) {
    const result = saturate(state, t);
    state = result.state;
    t = result.t;
  }
  assert.equal(dropOf(state), RUNGS - 1, "落とせるのは段数 − 1 まで");

  // 段数が 1 の相手はこれ以上落とせない。
  const single = saturate(initialUplink(), 0);
  const singleAgain = saturate(single.state, single.t);
  void singleAgain;
  const onlyOne = saturate(initialUplink(), 0);
  const capped = noteBufferedAmount(
    { ...onlyOne.state, drop: 0 },
    UPLINK_BACKLOG_BYTES + 1,
    1,
    onlyOne.t,
  );
  assert.equal(capped.changed, false, "段数 1 では落とさない");
});

test("同じ入力に対して同じ結果を返す（決定的である）", () => {
  const run = (): string => {
    let state = initialUplink();
    const out: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const buffered = i % 4 === 0 ? UPLINK_BACKLOG_BYTES + 1 : 0;
      const result = noteBufferedAmount(state, buffered, RUNGS, i * 200);
      state = result.state;
      out.push(`${String(result.changed)}:${String(dropOf(state))}`);
      const queue = i % 7 === 0 ? ENCODE_QUEUE_LIMIT + 1 : 0;
      const queued = noteEncodeQueue(state, queue, RUNGS, i * 200);
      state = queued.state;
      out.push(`${String(queued.changed)}:${String(dropOf(state))}`);
    }
    return out.join(",");
  };
  assert.equal(run(), run());
});
