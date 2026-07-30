/**
 * 提示の門の試験（ADR-0042）。
 *
 * 固定するのは 3 つである。
 *
 * 1. 予定時刻まで待つ（早く着いた映像を直ちに描かない）
 * 2. 送信者ごとに順序が保たれる（復号器の参照連鎖を壊さない）
 * 3. 予定が遠すぎるときは待たない（映像を止めない）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createPresentGate } from "../packages/client/src/sync/present-gate.ts";

interface Clock {
  readonly deps: { now: () => number; scheduleAt: (atMs: number, fire: () => void) => () => void };
  advanceTo(ms: number): void;
  readonly pending: { atMs: number; fire: () => void }[];
}

function clock(startMs: number): Clock {
  let current = startMs;
  const pending: { atMs: number; fire: () => void }[] = [];
  return {
    pending,
    deps: {
      now: (): number => current,
      scheduleAt: (atMs, fire): (() => void) => {
        pending.push({ atMs, fire });
        return (): void => undefined;
      },
    },
    advanceTo: (ms): void => {
      current = ms;
      const due = pending.filter((entry) => entry.atMs <= ms);
      for (const entry of due) {
        pending.splice(pending.indexOf(entry), 1);
        entry.fire();
      }
    },
  };
}

test("**予定時刻まで待つ**（早く着いた映像を直ちに描かない）", () => {
  const c = clock(1000);
  const gate = createPresentGate(c.deps);
  const order: number[] = [];
  gate.submit(1, 1050, () => order.push(1));
  assert.deepEqual(order, [], "まだ渡さない");
  assert.equal(c.pending.length, 1, "予約が入る");
  c.advanceTo(1050);
  assert.deepEqual(order, [1], "時刻が来たら渡す");
});

test("予定が既に過ぎていれば直ちに渡す", () => {
  const c = clock(1000);
  const gate = createPresentGate(c.deps);
  const order: number[] = [];
  gate.submit(1, 990, () => order.push(1));
  assert.deepEqual(order, [1], "待たない");
  assert.equal(c.pending.length, 0, "予約しない");
});

test("**送信者ごとに順序が保たれる**（参照連鎖を壊さない）", () => {
  const c = clock(1000);
  const gate = createPresentGate(c.deps);
  const order: number[] = [];
  // 予定が前後しても、渡す順序は投入した順である。
  gate.submit(1, 1100, () => order.push(1));
  gate.submit(1, 1050, () => order.push(2));
  gate.submit(1, 1200, () => order.push(3));
  c.advanceTo(1300);
  assert.deepEqual(order, [1, 2, 3], "投入した順に渡る");
});

test("送信者が違えば互いに影響しない", () => {
  const c = clock(1000);
  const gate = createPresentGate(c.deps);
  const order: string[] = [];
  gate.submit(1, 1100, () => order.push("a1"));
  gate.submit(2, 1010, () => order.push("b1"));
  c.advanceTo(1010);
  assert.deepEqual(order, ["b1"], "別の送信者は待たされない");
  c.advanceTo(1100);
  assert.deepEqual(order, ["b1", "a1"]);
});

test("**予定が遠すぎても順序を壊さない**（対応付けを作り直した直後）", () => {
  // 対応付けを作り直すと、まだ経路にある古い映像が未来へ写ることがある（実測: 2.5 秒先）。
  // そこで待たずに出すのは正しいが、**先に予約済みのフレームより前に出してはならない**。
  // 出すと復号器へ入る順序が入れ替わり、判定 A-3（frameIndex の逆行）と判定 C-1（描画の
  // 間隔）が同時に出る（実測: 間隔が 4.8 秒と読まれた）。
  const c = clock(1000);
  const gate = createPresentGate(c.deps);
  const order: string[] = [];
  // 1 枚目は 500 ms 先に予約される（待つ）。
  gate.submit(1, 1500, () => order.push("待つ"));
  assert.deepEqual(order, [] as readonly string[], "まだ出ない");
  assert.equal(c.pending.length, 1, "予約されている");

  // 2 枚目は写像の作り直しで 5 秒先になった。待たないが、1 枚目より後でなければならない。
  gate.submit(1, 1000 + 5000, () => order.push("遠い"));
  assert.deepEqual(order, [] as readonly string[], "**1 枚目を追い越さない**");
  assert.equal(c.pending.length, 2, "順序を保つため予約する");

  // 時計を進めると、予約された順に出る。
  c.advanceTo(1600);
  assert.deepEqual(order, ["待つ", "遠い"], "予約の順に出る");
});

test("予定が遠すぎるとき、先行が無ければ直ちに渡す（映像を止めない）", () => {
  const c = clock(1000);
  const gate = createPresentGate(c.deps);
  const order: number[] = [];
  gate.submit(1, 1000 + 5000, () => order.push(1));
  assert.deepEqual(order, [1], "直ちに渡す");
  assert.equal(c.pending.length, 0, "予約しない");
});

test("解放すると順序の記録が消える", () => {
  const c = clock(1000);
  const gate = createPresentGate(c.deps);
  const order: number[] = [];
  gate.submit(1, 1100, () => order.push(1));
  gate.release(1);
  // 解放後は前回の時刻に縛られない。
  gate.submit(1, 1000, () => order.push(2));
  assert.deepEqual(order, [2], "直ちに渡る");
});
