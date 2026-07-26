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

/** 移動量の 3 個組。 */
interface Shifts {
  readonly a: bigint;
  readonly b: bigint;
  readonly c: bigint;
}

/**
 * 移動量を定数文字列から解析する。数値をコードに直接書かない。
 *
 * なぜ例外を投げないか: 失敗は Result で返す（コーディング規約）。
 * 例外は他言語で panic に相当し、9 言語で同一の挙動にならない。
 */
function parseShifts(raw: string): Result<Shifts, PrngError> {
  const parts = raw.split(",");
  const first = parts[0];
  const second = parts[1];
  const third = parts[2];
  if (first === undefined || second === undefined || third === undefined) {
    return err({ code: "E_PRNG_SHIFTS", detail: "PRNG_MULTIPLIER_SHIFTS の形式が不正" });
  }
  return ok({ a: BigInt(first), b: BigInt(second), c: BigInt(third) });
}

const SHIFTS_RESULT = parseShifts(PRNG_MULTIPLIER_SHIFTS);

/** 64bit の範囲に切り詰める。BigInt は任意精度であるため巻き戻りを明示する。 */
const MASK_64 = 0xFFFFFFFFFFFFFFFFn;

/** PRNG の状態。不透明な値として扱う。 */
export interface PrngState {
  readonly value: bigint;
}

export type PrngErrorCode = "E_PRNG_ZERO_SEED" | "E_PRNG_SHIFTS";

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
  // 生成物の形式が壊れている場合はここで検出する。読み込み時に例外を投げない。
  if (!SHIFTS_RESULT.ok) {
    return err(SHIFTS_RESULT.error);
  }
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
  // 移動量が解析できない場合は状態を変えずに返す。createPrng が先に失敗を返すため、
  // 正常な経路ではここに到達しない。例外を投げないための分岐である。
  if (!SHIFTS_RESULT.ok) {
    return { state, output: state.value };
  }
  const shifts = SHIFTS_RESULT.value;
  let s = state.value;
  s = (s ^ ((s << shifts.a) & MASK_64)) & MASK_64;
  s = (s ^ (s >> shifts.b)) & MASK_64;
  s = (s ^ ((s << shifts.c) & MASK_64)) & MASK_64;
  return { state: { value: s }, output: s };
}
