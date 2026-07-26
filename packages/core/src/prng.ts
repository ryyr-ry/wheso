/**
 * conformance.md 3.2 の擬似乱数器。
 *
 * 全 9 SDK が同一の乱数列を生成することを保証するため、
 * 生成器を規範で固定する。言語標準の乱数を使ってはならない。
 *
 * 64bit xorshift。移動量は generated/constants.ts の
 * PRNG_MULTIPLIER_SHIFTS から取得する。
 */

import { PRNG_MULTIPLIER_SHIFTS } from "./generated/constants.ts";
import { type Result, ok, err } from "./result.ts";

/** 移動量を定数文字列から解析する。数値をコードに直接書かない。 */
function parseShifts(raw: string): { readonly a: bigint; readonly b: bigint; readonly c: bigint } {
  const parts = raw.split(",");
  const first = parts[0];
  const second = parts[1];
  const third = parts[2];
  if (first === undefined || second === undefined || third === undefined) {
    // 生成物の形式が壊れている場合にここに到達する。
    // 実行時に検出できるよう、固定の値ではなく解析を行う。
    throw new Error("PRNG_MULTIPLIER_SHIFTS の形式が不正");
  }
  return {
    a: BigInt(first),
    b: BigInt(second),
    c: BigInt(third),
  };
}

const SHIFTS = parseShifts(PRNG_MULTIPLIER_SHIFTS);

/** 64bit の範囲に切り詰める。BigInt は任意精度であるため巻き戻りを明示する。 */
const MASK_64 = 0xFFFFFFFFFFFFFFFFn;

/** PRNG の状態。不透明な値として扱う。 */
export interface PrngState {
  readonly value: bigint;
}

export type PrngErrorCode = "E_PRNG_ZERO_SEED";

export interface PrngError {
  readonly code: PrngErrorCode;
  readonly detail: string;
}

/**
 * 擬似乱数器を初期化する。
 *
 * 種 0 は xorshift の不動点であるためエラーとする。
 * 規範（conformance.md 3.2）:「初期状態は 0 以外の値とする。種に 0 を与えてはならない。」
 */
export function createPrng(seed: bigint): Result<PrngState, PrngError> {
  if (seed === 0n) {
    return err({ code: "E_PRNG_ZERO_SEED", detail: "種 0 は xorshift の不動点であり禁止" });
  }
  // 64bit に正規化する。負の BigInt が渡された場合でも確定的に動作させるため。
  return ok({ value: seed & MASK_64 });
}

/**
 * 状態遷移を行い、次の状態と出力を返す純関数。
 *
 * conformance.md 3.2:
 *   state ← state XOR (state << 13)
 *   state ← state XOR (state >> 7)
 *   state ← state XOR (state << 17)
 *   出力 ← state
 */
export function next(state: PrngState): { readonly state: PrngState; readonly output: bigint } {
  let s = state.value;
  s = (s ^ ((s << SHIFTS.a) & MASK_64)) & MASK_64;
  s = (s ^ (s >> SHIFTS.b)) & MASK_64;
  s = (s ^ ((s << SHIFTS.c) & MASK_64)) & MASK_64;
  return { state: { value: s }, output: s };
}
