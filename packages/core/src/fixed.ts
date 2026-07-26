/**
 * conformance.md 3.3 の整数演算。
 *
 * コアの算術を整数に限定し、浮動小数点を使わない。
 * 遅延勾配の計算と閾値判定を交差乗算で行う。
 *
 * lint-policy.md 9 節: コアで浮動小数点・時刻・乱数・入出力を使わない。
 */

import {
  DELAY_TREND_DEGRADE_DEN,
  DELAY_TREND_DEGRADE_NUM,
  DELAY_TREND_RECOVER_DEN,
  DELAY_TREND_RECOVER_NUM,
} from "./generated/constants.ts";

/* ------------------------------------------------------------------------- */
/* 閾値                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * 閾値は有理数（分子と分母の整数対）としてスキーマに定義されている。
 *
 * なぜ小数の定数から変換しないか: 小数から有理数への変換は浮動小数点演算を伴い、
 * 言語ごとに丸めが一致しない。閾値の境界で判定が反転すると、トレースベクタの
 * 完全一致（conformance.md 4.4）が壊れる。したがって分子と分母を単一情報源
 * （spec/schema/constants.json）に整数として持たせ、コアは整数のみを読む。
 * ADR-0017。
 */
const DEGRADE_RATIONAL = { num: DELAY_TREND_DEGRADE_NUM, den: DELAY_TREND_DEGRADE_DEN } as const;
const RECOVER_RATIONAL = { num: DELAY_TREND_RECOVER_NUM, den: DELAY_TREND_RECOVER_DEN } as const;

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
 * 輻輳の予兆を判定する。
 *
 * 判定: slope > DELAY_TREND_DEGRADE
 * 交差乗算: numerator / denominator > degradeNum / degradeDen
 *         ⟺ numerator × degradeDen > denominator × degradeNum
 *
 * 分母（denominator と degradeDen）が共に正であるため不等号の向きは変わらない。
 */
export function isDegrading(slope: Slope): boolean {
  // numerator × degradeDen > denominator × degradeNum
  return slope.numerator * DEGRADE_RATIONAL.den > slope.denominator * DEGRADE_RATIONAL.num;
}

/**
 * 回復を判定する。
 *
 * 判定: slope < DELAY_TREND_RECOVER
 * 交差乗算: numerator / denominator < recoverNum / recoverDen
 *         ⟺ numerator × recoverDen < denominator × recoverNum
 *
 * recoverDen は正（200）。denominator は正。不等号の向きは変わらない。
 */
export function isRecovering(slope: Slope): boolean {
  // numerator × recoverDen < denominator × recoverNum
  return slope.numerator * RECOVER_RATIONAL.den < slope.denominator * RECOVER_RATIONAL.num;
}

/* ------------------------------------------------------------------------- */
/* 巻き戻り 32bit 演算                                                       */
/* ------------------------------------------------------------------------- */

/**
 * 32bit 符号なし整数に切り詰める。
 *
 * 既存の naming.ts は `hash >>> 0` と `Math.imul` で 32bit 巻き戻りを行う。
 * 本関数は同じ意味を明示的なヘルパとして提供する。
 * naming.ts の fnv1a32 / fmix32 と結果が一致する。
 */
export function wrap32(value: number): number {
  return value >>> 0;
}

/* ------------------------------------------------------------------------- */
/* 切り捨て整数除算                                                          */
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
export function truncDiv(dividend: number, divisor: number): number {
  // divisor === 0 の場合は Infinity が返る。呼び出し側で防ぐ前提。
  return Math.trunc(dividend / divisor);
}

/** 観測窓の大きさ。generated の定数から公開する。 */
export { DELAY_TREND_WINDOW } from "./generated/constants.ts";
