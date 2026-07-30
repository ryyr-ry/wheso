/**
 * conformance.md 3.3 の整数演算。
 *
 * コアの算術を整数に限定し、浮動小数点を使わない。
 * 遅延勾配の計算と閾値判定を交差乗算で行う。
 *
 * lint-policy.md 9 節: コアで浮動小数点・時刻・乱数・入出力を使わない。
 */

import { type Result, ok, err } from "./result.ts";

/* ------------------------------------------------------------------------- */
/* 閾値                                                                      */
/* ------------------------------------------------------------------------- */

/*
 * 閾値の判定は呼び出し側が行う。
 *
 * 閾値は有理数（分子と分母の整数対）としてスキーマに定義されており、判定は交差乗算で
 * 行う（ADR-0017）。**このファイルに閾値を持たせない。** 中継ノードと受信ノードは
 * 同じ勾配に対して別の閾値を使うため（購読単位と会議単位）、閾値を共有すると
 * どちらかが誤った値で判定する。
 */

/** 整数演算の失敗。例外を投げず Result で返す（コーディング規約）。 */
export type FixedErrorCode = "E_FIXED_DIVIDE_BY_ZERO" | "E_FIXED_RANGE";

export interface FixedError {
  readonly code: FixedErrorCode;
  readonly detail: string;
}

/* ------------------------------------------------------------------------- */
/* 勾配                                                                      */
/* ------------------------------------------------------------------------- */

/** 勾配の有理数表現。分子と分母の整数対で持つ。 */
export interface Slope {
  /** 最小二乗直線の傾きの分子。 */
  readonly numerator: number;
  /**
   * 最小二乗直線の傾きの分母。
   * n >= 2 かつ標本番号が相異なるとき常に正。
   */
  readonly denominator: number;
}

/**
 * 観測窓の遅延列から最小二乗の勾配を求める。
 *
 * conformance.md 3.3:
 *   Sx  = Σ i
 *   Sy  = Σ y_i
 *   Sxy = Σ (i × y_i)
 *   Sxx = Σ (i × i)
 *   numerator   = n × Sxy − Sx × Sy
 *   denominator = n × Sxx − Sx × Sx
 *
 * 中間値が 64bit に収まる根拠:
 *   n = DELAY_TREND_WINDOW = 20
 *   y_i の上限を 10^9 マイクロ秒（1000 秒）とする。
 *   Sxy の最大値 = Σ(i × 10^9) = (19 × 20 / 2) × 10^9 = 190 × 10^9
 *   n × Sxy = 20 × 190 × 10^9 = 3.8 × 10^12
 *   Sx × Sy の最大値 = 190 × 20 × 10^9 = 3.8 × 10^12
 *   numerator の絶対値上限 ≈ 3.8 × 10^12
 *   Number.MAX_SAFE_INTEGER = 2^53 - 1 ≈ 9.0 × 10^15
 *   3.8 × 10^12 << 9.0 × 10^15 であるため number の安全整数域に収まる。
 *
 *   denominator = n × Sxx - Sx^2 = 20 × 2470 - 190^2 = 49400 - 36100 = 13300
 *   （n=20 で固定なので定数）
 *
 * 結論: number の安全整数域で完結し bigint は不要。
 *
 * @param samplesUs 片道遅延のマイクロ秒列。最大 DELAY_TREND_WINDOW 個。
 * @returns 勾配の有理数表現。標本が 2 個未満の場合は 0/1 を返す。
 */
export function delaySlope(samplesUs: readonly number[]): Slope {
  const n = samplesUs.length;
  if (n < 2) {
    // 勾配を定義できない。中立の 0/1 を返す（判定は常に false になる）。
    return { numerator: 0, denominator: 1 };
  }

  // Sx = n(n-1)/2 だが、直接計算しても同じ。明示的にループで示す。
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    const yi = samplesUs[i];
    // noUncheckedIndexedAccess により yi は number | undefined。
    // 配列長は n で確認済みだが型システムは知らないため検査する。
    if (yi === undefined) {
      // 到達しない。型ガードのためだけに存在する。
      continue;
    }
    sx += i;
    sy += yi;
    sxy += i * yi;
    sxx += i * i;
  }

  const numerator = n * sxy - sx * sy;
  const denominator = n * sxx - sx * sx;

  // denominator は n >= 2 かつ i が相異なるとき常に正。
  // ここに到達する時点で n >= 2 であるため denominator > 0 が保証される。
  return { numerator, denominator };
}

/* ------------------------------------------------------------------------- */
/* 閾値判定                                                                  */
/* ------------------------------------------------------------------------- */




/**
 * 切り捨て整数除算。商をゼロ方向に丸める。
 *
 * JavaScript の整数除算に相当する Math.trunc(a / b) を、
 * 浮動小数点除算を経由せずに書くことはできない（言語の制約）。
 * しかし被除数と除数が Number.MAX_SAFE_INTEGER 以下であれば
 * Math.trunc(a / b) は正確な整数商を返す。
 *
 * コアで浮動小数点を禁止する規則との整合: 本関数は除算結果を整数として
 * 返すヘルパであり、中間の浮動小数点値を判断に使わない。
 * conformance.md 3.3:「除算が避けられない箇所は整数除算と切り捨てを明記する」
 */
export function truncDiv(dividend: number, divisor: number): Result<number, FixedError> {
  if (divisor === 0) {
    return err({ code: "E_FIXED_DIVIDE_BY_ZERO", detail: "0 で除算できない" });
  }
  // なぜ安全整数域を検査するか: JavaScript の `/` は浮動小数点除算であり、
  // 安全整数域（2^53）を超えると商が丸められ、Rust や Swift の整数除算と
  // 結果が一致しない（例: 9007199254740993 / 3）。9 言語で同一の結果を
  // 要求するため（ADR-0017）、域外は失敗として返す。
  if (!Number.isSafeInteger(dividend) || !Number.isSafeInteger(divisor)) {
    return err({ code: "E_FIXED_RANGE", detail: "安全整数域を超える値は扱わない" });
  }
  return ok(Math.trunc(dividend / divisor));
}

/** 観測窓の大きさ。generated の定数から公開する。 */
export { DELAY_TREND_WINDOW } from "./generated/constants.ts";

/**
 * 32 bit の符号なしへの切り詰め。
 *
 * `naming.ts` の `fnv1a32`（`Math.imul` と `>>> 0`）と同じ動作をする。ハッシュと
 * `sequenceNumber` の巻き戻し（wire-format.md 1.2）で使う。**言語ごとに違う演算子を
 * 使わないため、切り詰めを 1 箇所に置く。**
 */
export function wrap32(value: number): number {
  return value >>> 0;
}
