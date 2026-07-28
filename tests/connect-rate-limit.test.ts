/**
 * 接続試行のレート制限（auth.md 5 節。1 利用者あたり 20 回/分）の試験。
 *
 * 判断は純関数（packages/core/src/rate-limit.ts の admit）であり、時刻を引数で受け取る。
 * ここで確かめるのは境界である。境界を取り違えると、制限が 1 回ゆるい／きついだけでなく、
 * 窓の切り替わりで実装間の差が出る（9 言語で一致させる必要がある）。
 *
 * 制御ノードの側でこれを使う位置は onConnect である（部屋名が利用者を一意に決めるため、
 * 部屋あたりの試行を数えれば利用者あたりの制限になる）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { admit, initialRateWindow } from "../packages/core/src/rate-limit.ts";
import { MAX_CONNECT_ATTEMPTS_PER_MIN } from "../packages/core/src/generated/constants.ts";

/** 規範の窓。20 回/分であるため 1 分。 */
const WINDOW_MS = 60_000;

test("上限までは通し、上限を 1 回超えたら拒否する", () => {
  let window = initialRateWindow(0);
  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS_PER_MIN; attempt += 1) {
    const decision = admit(window, 100, WINDOW_MS, MAX_CONNECT_ATTEMPTS_PER_MIN);
    window = decision.window;
    assert.equal(decision.allowed, true, `${String(attempt)} 回目は通る`);
  }
  const over = admit(window, 100, WINDOW_MS, MAX_CONNECT_ATTEMPTS_PER_MIN);
  assert.equal(over.allowed, false, `${String(MAX_CONNECT_ATTEMPTS_PER_MIN + 1)} 回目は拒否する`);
});

test("窓が満了すると計数が戻る", () => {
  let window = initialRateWindow(0);
  for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS_PER_MIN + 3; attempt += 1) {
    window = admit(window, 100, WINDOW_MS, MAX_CONNECT_ATTEMPTS_PER_MIN).window;
  }
  // 窓の内側では拒否され続ける。窓の開始は initialRateWindow(0) の 0 であるため、
  // 「内側」は経過が窓長未満、すなわち 0 + WINDOW_MS - 1 までである。
  assert.equal(admit(window, WINDOW_MS - 1, WINDOW_MS, MAX_CONNECT_ATTEMPTS_PER_MIN).allowed, false);
  // 窓長と等しい経過で新しい窓が開く（境界は「以上」で判定する）。
  const fresh = admit(window, 0 + WINDOW_MS, WINDOW_MS, MAX_CONNECT_ATTEMPTS_PER_MIN);
  assert.equal(fresh.allowed, true, "窓長と等しい時刻の到着は新しい窓に数える");
  assert.equal(fresh.window.count, 1, "新しい窓の計数は 1 から始まる");
  assert.equal(fresh.window.startMs, WINDOW_MS, "窓の開始時刻が更新される");
});

test("窓の内側では開始時刻が変わらない", () => {
  const first = admit(initialRateWindow(500), 500, WINDOW_MS, MAX_CONNECT_ATTEMPTS_PER_MIN);
  const second = admit(first.window, 500 + WINDOW_MS - 1, WINDOW_MS, MAX_CONNECT_ATTEMPTS_PER_MIN);
  assert.equal(second.window.startMs, 500, "窓の開始時刻は満了まで固定である");
  assert.equal(second.window.count, 2);
});

test("拒否された試行も計数に入る（濫用を止めるため）", () => {
  let window = initialRateWindow(0);
  for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS_PER_MIN + 5; attempt += 1) {
    window = admit(window, 10, WINDOW_MS, MAX_CONNECT_ATTEMPTS_PER_MIN).window;
  }
  assert.equal(
    window.count,
    MAX_CONNECT_ATTEMPTS_PER_MIN + 5,
    "拒否した分も数える。数えないと拒否のたびに枠が空き、制限が働かない",
  );
});

test("上限は規範の値である", () => {
  // 数値をコードに書かない（AGENTS 5.3）。生成物から読むことをここで固定する。
  assert.equal(MAX_CONNECT_ATTEMPTS_PER_MIN, 20, "auth.md 5 節の 20 回/分");
});
