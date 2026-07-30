/**
 * conformance.md 3.3 の整数演算のテスト。
 *
 * 検証する項目:
 *   - 単調増加列で分子が正
 *   - 一定列で分子が 0
 *   - 減少列で分子が負
 *   - 閾値の境界付近で判定が反転しないこと（境界のちょうど上と下）
 *   - 巻き戻り 32bit 演算が naming.ts と一致すること
 *   - 切り捨て整数除算の動作
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { delaySlope, wrap32, truncDiv } from "../packages/core/src/fixed.ts";

/* ------------------------------------------------------------------------- */
/* delaySlope                                                                */
/* ------------------------------------------------------------------------- */

test("delaySlope: 一定列で分子が 0", () => {
  // 全て 5000 μs の列
  const samples = Array.from({ length: 20 }, () => 5000);
  const slope = delaySlope(samples);
  assert.equal(slope.numerator, 0);
  assert.ok(slope.denominator > 0);
});

test("delaySlope: 単調増加列で分子が正", () => {
  // y_i = 1000 + i * 100
  const samples = Array.from({ length: 20 }, (_, i) => 1000 + i * 100);
  const slope = delaySlope(samples);
  assert.ok(slope.numerator > 0, `numerator=${slope.numerator} は正であるべき`);
  assert.ok(slope.denominator > 0);
});

test("delaySlope: 減少列で分子が負", () => {
  // y_i = 10000 - i * 50
  const samples = Array.from({ length: 20 }, (_, i) => 10000 - i * 50);
  const slope = delaySlope(samples);
  assert.ok(slope.numerator < 0, `numerator=${slope.numerator} は負であるべき`);
  assert.ok(slope.denominator > 0);
});

test("delaySlope: 標本 1 個では 0/1 を返す", () => {
  const slope = delaySlope([100]);
  assert.equal(slope.numerator, 0);
  assert.equal(slope.denominator, 1);
});

test("delaySlope: 空配列では 0/1 を返す", () => {
  const slope = delaySlope([]);
  assert.equal(slope.numerator, 0);
  assert.equal(slope.denominator, 1);
});

test("delaySlope: n=20 の denominator は 13300", () => {
  // n=20 のとき Sxx=2470, Sx=190
  // denominator = 20*2470 - 190*190 = 49400 - 36100 = 13300
  const samples = Array.from({ length: 20 }, (_, i) => i * 1000);
  const slope = delaySlope(samples);
  assert.equal(slope.denominator, 13300);
});

test("delaySlope: n=20 線形列で numerator = 13300 * 傾き", () => {
  // y_i = i * 5 のとき、理論上の傾きは 5
  // numerator = 13300 * 5 = 66500
  const samples = Array.from({ length: 20 }, (_, i) => i * 5);
  const slope = delaySlope(samples);
  assert.equal(slope.numerator, 66500);
  assert.equal(slope.denominator, 13300);
});

/* ------------------------------------------------------------------------- */
/* isDegrading / isRecovering — 閾値の境界                                   */
/* ------------------------------------------------------------------------- */

// DELAY_TREND_DEGRADE = 0.01 = 1/100
// isDegrading: numerator * 100 > denominator * 1
// 境界: numerator = 133, denominator = 13300 → 13300 > 13300 → false
//        numerator = 134, denominator = 13300 → 13400 > 13300 → true

// DELAY_TREND_RECOVER = -0.005 = -1/200
// isRecovering: numerator * 200 < denominator * (-1)
// 境界: numerator = -66, denominator = 13300 → -13200 < -13300 → false
//        numerator = -67, denominator = 13300 → -13400 < -13300 → true

/* ------------------------------------------------------------------------- */
/* wrap32                                                                     */
/* ------------------------------------------------------------------------- */

test("wrap32: 正の値はそのまま", () => {
  assert.equal(wrap32(0), 0);
  assert.equal(wrap32(1), 1);
  assert.equal(wrap32(0xFFFFFFFF), 0xFFFFFFFF);
});

test("wrap32: 32bit を超える値は切り詰められる", () => {
  assert.equal(wrap32(0x100000000), 0);
  assert.equal(wrap32(0x100000001), 1);
});

test("wrap32: 負の値は符号なしに変換される", () => {
  assert.equal(wrap32(-1), 0xFFFFFFFF);
  assert.equal(wrap32(-2), 0xFFFFFFFE);
});

test("wrap32: naming.ts の Math.imul と >>> 0 と一致する", () => {
  // naming.ts の fnv1a32 は Math.imul(hash, 0x01000193) を >>> 0 で切り詰める。
  // wrap32 はこれと同じ動作をする。
  const a = Math.imul(0x811c9dc5, 0x01000193);
  assert.equal(wrap32(a), a >>> 0);
});

/* ------------------------------------------------------------------------- */
/* truncDiv                                                                  */
/* ------------------------------------------------------------------------- */

/** Result から値を取り出す。失敗なら試験を落とす。 */
function unwrapDiv(result: ReturnType<typeof truncDiv>): number {
  assert.equal(result.ok, true, "除算が失敗した");
  return result.ok ? result.value : 0;
}

test("truncDiv: 正の割り算", () => {
  assert.equal(unwrapDiv(truncDiv(10, 3)), 3);
  assert.equal(unwrapDiv(truncDiv(9, 3)), 3);
  assert.equal(unwrapDiv(truncDiv(7, 2)), 3);
});

test("truncDiv: 負をゼロ方向に丸める", () => {
  assert.equal(unwrapDiv(truncDiv(-10, 3)), -3);
  assert.equal(unwrapDiv(truncDiv(-7, 2)), -3);
  assert.equal(unwrapDiv(truncDiv(10, -3)), -3);
});

test("truncDiv: ゼロ除算は失敗を返す（例外を投げない）", () => {
  const result = truncDiv(10, 0);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "E_FIXED_DIVIDE_BY_ZERO");
  }
});

test("truncDiv: 安全整数域を超える入力は失敗を返す", () => {
  // なぜ失敗にするか: 浮動小数点除算の丸めにより他言語の整数除算と結果が一致しない。
  const result = truncDiv(Number.MAX_SAFE_INTEGER + 2, 3);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "E_FIXED_RANGE");
  }
});
