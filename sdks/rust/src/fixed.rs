//! 擬似乱数と整数演算。
//!
//! 規範: conformance.md 3.2（xorshift64）と 3.3（整数演算）。
//! TypeScript の実装と同じ結果を返さなければならない。検証はテストベクタで行う。
//!
//! パニックしない。失敗は Result で返す（lint-policy.md の禁止構文）。
//! 浮動小数点を使わない。

use crate::generated::constants::{
    DELAY_TREND_DEGRADE_DEN, DELAY_TREND_DEGRADE_NUM, DELAY_TREND_RECOVER_DEN,
    DELAY_TREND_RECOVER_NUM, PRNG_MULTIPLIER_SHIFTS,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreError {
    /// 種 0 は xorshift の不動点であるため禁止する。
    PrngZeroSeed,
    /// 生成物の移動量の形式が壊れている。
    PrngShifts,
    /// 0 での除算。
    DivideByZero,
    /// 安全に扱える整数の範囲を超えた。
    Range,
}

/// 擬似乱数器の状態。不透明な値として扱う。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrngState {
    value: u64,
}

/// 移動量を定数文字列から読む。数値をコードに書かない。
fn shifts() -> Result<(u32, u32, u32), CoreError> {
    let mut parts = PRNG_MULTIPLIER_SHIFTS.split(',');
    let a = parts.next().and_then(|s| s.trim().parse::<u32>().ok());
    let b = parts.next().and_then(|s| s.trim().parse::<u32>().ok());
    let c = parts.next().and_then(|s| s.trim().parse::<u32>().ok());
    match (a, b, c) {
        (Some(a), Some(b), Some(c)) => Ok((a, b, c)),
        _ => Err(CoreError::PrngShifts),
    }
}

/// 擬似乱数器を初期化する。
pub fn create_prng(seed: u64) -> Result<PrngState, CoreError> {
    shifts()?;
    if seed == 0 {
        return Err(CoreError::PrngZeroSeed);
    }
    Ok(PrngState { value: seed })
}

/// 状態遷移。conformance.md 3.2 の 3 段の xorshift をそのまま実装する。
pub fn next(state: PrngState) -> Result<(PrngState, u64), CoreError> {
    let (a, b, c) = shifts()?;
    let mut s = state.value;
    // 64 bit の巻き戻りを明示する。Rust の << は溢れを落とすため wrapping を使う。
    s ^= s.wrapping_shl(a);
    s ^= s >> b;
    s ^= s.wrapping_shl(c);
    Ok((PrngState { value: s }, s))
}

/// 最小二乗の傾き。分子と分母の整数対で表す。除算しない（ADR-0017）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slope {
    pub numerator: i64,
    pub denominator: i64,
}

/// 遅延の標本列から傾きを求める。
///
/// numerator   = n × Σ(i × y) − Σi × Σy
/// denominator = n × Σ(i × i) − (Σi)²
///
/// denominator は n >= 2 のとき常に正である。
pub fn delay_slope(samples_us: &[i64]) -> Slope {
    let n = samples_us.len() as i64;
    if n < 2 {
        return Slope { numerator: 0, denominator: 1 };
    }
    let mut sx: i64 = 0;
    let mut sy: i64 = 0;
    let mut sxy: i64 = 0;
    let mut sxx: i64 = 0;
    for (index, value) in samples_us.iter().enumerate() {
        let i = index as i64;
        sx += i;
        sy += *value;
        sxy += i * *value;
        sxx += i * i;
    }
    Slope {
        numerator: n * sxy - sx * sy,
        denominator: n * sxx - sx * sx,
    }
}

/// 傾きが劣化閾値を超えるか。交差乗算で判定する。
pub fn is_degrading(slope: Slope) -> bool {
    slope.numerator * DELAY_TREND_DEGRADE_DEN > DELAY_TREND_DEGRADE_NUM * slope.denominator
}

/// 傾きが回復閾値を下回るか。
pub fn is_recovering(slope: Slope) -> bool {
    slope.numerator * DELAY_TREND_RECOVER_DEN < DELAY_TREND_RECOVER_NUM * slope.denominator
}

/// 32 bit の巻き戻り。ハッシュ計算で使う。
pub fn wrap32(value: i64) -> u32 {
    (value as u64 & 0xFFFF_FFFF) as u32
}

/// 切り捨ての整数除算。0 除算と範囲外は失敗として返す。
pub fn trunc_div(dividend: i64, divisor: i64) -> Result<i64, CoreError> {
    if divisor == 0 {
        return Err(CoreError::DivideByZero);
    }
    // TypeScript 側は安全整数（2^53）を超える値を扱わない。同じ範囲に限る。
    const SAFE: i64 = 9_007_199_254_740_991;
    if dividend.abs() > SAFE || divisor.abs() > SAFE {
        return Err(CoreError::Range);
    }
    Ok(dividend / divisor)
}
