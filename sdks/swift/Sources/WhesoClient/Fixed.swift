// 擬似乱数と整数演算（Swift）。
//
// 規範: conformance.md 3.2（xorshift64）と 3.3（整数演算）。
// TypeScript の参照実装と同じ結果を返さなければならない。検証はテストベクタで行う。
//
// 例外を投げない（try! も fatalError も使わない）。失敗は Result で返す。
// 浮動小数点を使わない。

public enum WhesoCoreError: Error, Equatable {
    case prngZeroSeed
    case prngShifts
    case divideByZero
    case range
}

/// 擬似乱数器の状態。
public struct WhesoPrngState: Equatable {
    public let value: UInt64

    public init(value: UInt64) {
        self.value = value
    }
}

/// 状態遷移の結果。
public struct WhesoPrngStep: Equatable {
    public let state: WhesoPrngState
    public let output: UInt64
}

/// 移動量を定数文字列から読む。数値をコードに書かない。
public func whesoPrngShifts() -> [UInt64]? {
    let parts = WhesoConstants.PRNG_MULTIPLIER_SHIFTS.split(separator: ",")
    if parts.count != 3 {
        return nil
    }
    var shifts: [UInt64] = []
    for part in parts {
        guard let parsed = UInt64(part.trimmingCharacters(in: .whitespaces)) else {
            return nil
        }
        shifts.append(parsed)
    }
    return shifts
}

/// 擬似乱数器を初期化する。種 0 は xorshift の不動点であるため禁止する。
public func whesoCreatePrng(seed: UInt64) -> Result<WhesoPrngState, WhesoCoreError> {
    if whesoPrngShifts() == nil {
        return .failure(.prngShifts)
    }
    if seed == 0 {
        return .failure(.prngZeroSeed)
    }
    return .success(WhesoPrngState(value: seed))
}

/// 状態遷移。conformance.md 3.2 の 3 段の xorshift をそのまま実装する。
///
/// UInt64 の左シフトは溢れを落とすため、`&<<` で明示する。溢れで停止させない。
public func whesoPrngNext(_ state: WhesoPrngState) -> Result<WhesoPrngStep, WhesoCoreError> {
    guard let shifts = whesoPrngShifts() else {
        return .failure(.prngShifts)
    }
    var s = state.value
    s ^= s &<< shifts[0]
    s ^= s >> shifts[1]
    s ^= s &<< shifts[2]
    return .success(WhesoPrngStep(state: WhesoPrngState(value: s), output: s))
}

/// 最小二乗の傾き。分子と分母の整数対で表す。除算しない（ADR-0017）。
public struct WhesoSlope: Equatable {
    public let numerator: Int64
    public let denominator: Int64
}

/// 遅延の標本列から傾きを求める。
public func whesoDelaySlope(_ samplesUs: [Int64]) -> WhesoSlope {
    let n = Int64(samplesUs.count)
    if n < 2 {
        return WhesoSlope(numerator: 0, denominator: 1)
    }
    var sx: Int64 = 0
    var sy: Int64 = 0
    var sxy: Int64 = 0
    var sxx: Int64 = 0
    for index in 0..<samplesUs.count {
        let i = Int64(index)
        let y = samplesUs[index]
        sx += i
        sy += y
        sxy += i * y
        sxx += i * i
    }
    return WhesoSlope(numerator: n * sxy - sx * sy, denominator: n * sxx - sx * sx)
}

/// 傾きが劣化閾値を超えるか。交差乗算で判定する。
public func whesoIsDegrading(_ slope: WhesoSlope) -> Bool {
    slope.numerator * WhesoConstants.DELAY_TREND_DEGRADE_DEN
        > WhesoConstants.DELAY_TREND_DEGRADE_NUM * slope.denominator
}

/// 傾きが回復閾値を下回るか。
public func whesoIsRecovering(_ slope: WhesoSlope) -> Bool {
    slope.numerator * WhesoConstants.DELAY_TREND_RECOVER_DEN
        < WhesoConstants.DELAY_TREND_RECOVER_NUM * slope.denominator
}

/// 32 bit の巻き戻り。ハッシュ計算で使う。
public func whesoWrap32(_ value: Int64) -> UInt32 {
    UInt32(truncatingIfNeeded: value)
}

/// 切り捨ての整数除算。0 除算と安全整数域外は失敗として返す。
public func whesoTruncDiv(_ dividend: Int64, _ divisor: Int64) -> Result<Int64, WhesoCoreError> {
    if divisor == 0 {
        return .failure(.divideByZero)
    }
    // TypeScript 側は安全整数（2^53）を超える値を扱わない。同じ範囲に限る。
    let safe: Int64 = 9_007_199_254_740_991
    if dividend.magnitude > UInt64(safe) || divisor.magnitude > UInt64(safe) {
        return .failure(.range)
    }
    return .success(dividend / divisor)
}
