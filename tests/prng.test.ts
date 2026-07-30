/**
 * conformance.md 3.2 の擬似乱数器のテスト。
 *
 * 検証する項目:
 *   - 同じ種から同じ列が出ること
 *   - 種 0 がエラーになること
 *   - 既知の列と一致すること（xorshift64 shifts=13,7,17）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrng, next } from "../packages/core/src/prng.ts";

test("createPrng: 種 0 はエラーを返す", () => {
  const result = createPrng(0n);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "E_PRNG_ZERO_SEED");
  }
});

test("createPrng: 正の種で成功する", () => {
  const result = createPrng(1n);
  assert.equal(result.ok, true);
});

test("createPrng: 大きな種で成功する", () => {
  const result = createPrng(0xDEADBEEFCAFEBABEn);
  assert.equal(result.ok, true);
});

test("next: 同じ種から同じ列が出る", () => {
  const r1 = createPrng(12345n);
  const r2 = createPrng(12345n);
  if (!r1.ok || !r2.ok) {
    assert.fail("createPrng が失敗した");
    return;
  }
  const seq1 = next(r1.value);
  const seq2 = next(r2.value);
  assert.equal(seq1.output, seq2.output);
  assert.equal(seq1.state.value, seq2.state.value);
});

test("next: 既知の列と一致する（種 1）", () => {
  // xorshift64 shifts=13,7,17 を種 1 から 10 回実行した期待値
  const expected: readonly bigint[] = [
    1082269761n,
    1152992998833853505n,
    11177516664432764457n,
    17678023832001937445n,
    9659130143999365733n,
    17775799001133815809n,
    11693034620340510321n,
    14279964170112293133n,
    9024654201992055039n,
    8332670729032836398n,
  ];

  const init = createPrng(1n);
  if (!init.ok) {
    assert.fail("createPrng(1n) が失敗した");
    return;
  }

  let state = init.value;
  for (let i = 0; i < expected.length; i += 1) {
    const result = next(state);
    const exp = expected[i];
    if (exp === undefined) {
      assert.fail("期待値配列が短い");
      return;
    }
    assert.equal(result.output, exp, `step ${i} が不一致`);
    state = result.state;
  }
});

test("next: 既知の列と一致する（種 42）", () => {
  const expected: readonly bigint[] = [
    45454805674n,
    11532217803599905471n,
    10021416941527320954n,
    2899061411254629736n,
    5661411637479084162n,
  ];

  const init = createPrng(42n);
  if (!init.ok) {
    assert.fail("createPrng(42n) が失敗した");
    return;
  }

  let state = init.value;
  for (let i = 0; i < expected.length; i += 1) {
    const result = next(state);
    const exp = expected[i];
    if (exp === undefined) {
      assert.fail("期待値配列が短い");
      return;
    }
    assert.equal(result.output, exp, `step ${i} が不一致`);
    state = result.state;
  }
});

test("next: 状態遷移は純関数（同じ入力で同じ出力）", () => {
  const init = createPrng(999n);
  if (!init.ok) {
    assert.fail("createPrng が失敗した");
    return;
  }

  // 10 ステップ進めた状態を記録
  let state = init.value;
  for (let i = 0; i < 10; i += 1) {
    state = next(state).state;
  }
  const checkpoint = state;

  // 同じ状態から再開して同じ列が出ることを確認
  const a = next(checkpoint);
  const b = next(checkpoint);
  assert.equal(a.output, b.output);
  assert.equal(a.state.value, b.state.value);
});

