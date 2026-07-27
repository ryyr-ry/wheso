// 擬似乱数と整数演算（Kotlin）。
//
// 規範: conformance.md 3.2（xorshift64）と 3.3（整数演算）。
// TypeScript の参照実装と同じ結果を返さなければならない。検証はテストベクタで行う。
//
// 例外を投げない。失敗は Result で返す。浮動小数点を使わない。
// Kotlin の Long は 64 bit 符号付きであり `shl` は巻き戻る。論理右シフトは `ushr` を使う。
package dev.wheso

import dev.wheso.generated.DELAY_TREND_DEGRADE_DEN
import dev.wheso.generated.DELAY_TREND_DEGRADE_NUM
import dev.wheso.generated.DELAY_TREND_RECOVER_DEN
import dev.wheso.generated.DELAY_TREND_RECOVER_NUM
import dev.wheso.generated.PRNG_MULTIPLIER_SHIFTS

/** 失敗の種類。 */
public enum class CoreErrorKind {
    PRNG_ZERO_SEED,
    PRNG_SHIFTS,
    DIVIDE_BY_ZERO,
    RANGE,
}

/** 成功か失敗のどちらかを表す。例外を投げないための型である。 */
public sealed class Outcome<out T> {
    public data class Ok<out T>(val value: T) : Outcome<T>()
    public data class Err(val kind: CoreErrorKind) : Outcome<Nothing>()

    public val isOk: Boolean get() = this is Ok
}

/** 擬似乱数器の状態。 */
public data class PrngState(val value: Long)

/** 状態遷移の結果。 */
public data class PrngStep(val state: PrngState, val output: Long)

/** 移動量を定数文字列から読む。数値をコードに書かない。 */
internal fun prngShifts(): List<Int>? {
    val parts = PRNG_MULTIPLIER_SHIFTS.split(",")
    if (parts.size != 3) {
        return null
    }
    val shifts = mutableListOf<Int>()
    for (part in parts) {
        val parsed = part.trim().toIntOrNull() ?: return null
        shifts.add(parsed)
    }
    return shifts
}

/** 擬似乱数器を初期化する。種 0 は xorshift の不動点であるため禁止する。 */
public fun createPrng(seed: Long): Outcome<PrngState> {
    prngShifts() ?: return Outcome.Err(CoreErrorKind.PRNG_SHIFTS)
    if (seed == 0L) {
        return Outcome.Err(CoreErrorKind.PRNG_ZERO_SEED)
    }
    return Outcome.Ok(PrngState(seed))
}

/**
 * 状態遷移。conformance.md 3.2 の 3 段の xorshift をそのまま実装する。
 *
 * 右シフトは論理シフト（ushr）を使う。算術シフトを使うと負の値で上位ビットが
 * 埋まり、他言語と結果が食い違う。
 */
public fun prngNext(state: PrngState): Outcome<PrngStep> {
    val shifts = prngShifts() ?: return Outcome.Err(CoreErrorKind.PRNG_SHIFTS)
    var s = state.value
    s = s xor (s shl shifts[0])
    s = s xor (s ushr shifts[1])
    s = s xor (s shl shifts[2])
    return Outcome.Ok(PrngStep(PrngState(s), s))
}

/** 最小二乗の傾き。分子と分母の整数対で表す。除算しない（ADR-0017）。 */
public data class Slope(val numerator: Long, val denominator: Long)

/** 遅延の標本列から傾きを求める。 */
public fun delaySlope(samplesUs: List<Long>): Slope {
    val n = samplesUs.size.toLong()
    if (n < 2L) {
        return Slope(0L, 1L)
    }
    var sx = 0L
    var sy = 0L
    var sxy = 0L
    var sxx = 0L
    for (index in samplesUs.indices) {
        val i = index.toLong()
        val y = samplesUs[index]
        sx += i
        sy += y
        sxy += i * y
        sxx += i * i
    }
    return Slope(n * sxy - sx * sy, n * sxx - sx * sx)
}

/** 傾きが劣化閾値を超えるか。交差乗算で判定する。 */
public fun isDegrading(slope: Slope): Boolean =
    slope.numerator * DELAY_TREND_DEGRADE_DEN > DELAY_TREND_DEGRADE_NUM * slope.denominator

/** 傾きが回復閾値を下回るか。 */
public fun isRecovering(slope: Slope): Boolean =
    slope.numerator * DELAY_TREND_RECOVER_DEN < DELAY_TREND_RECOVER_NUM * slope.denominator

/** 32 bit の巻き戻り。ハッシュ計算で使う。 */
public fun wrap32(value: Long): Long = value and 0xFFFFFFFFL

/** 切り捨ての整数除算。0 除算と安全整数域外は失敗として返す。 */
public fun truncDiv(dividend: Long, divisor: Long): Outcome<Long> {
    if (divisor == 0L) {
        return Outcome.Err(CoreErrorKind.DIVIDE_BY_ZERO)
    }
    // TypeScript 側は安全整数（2^53）を超える値を扱わない。同じ範囲に限る。
    val safe = 9007199254740991L
    if (kotlin.math.abs(dividend) > safe || kotlin.math.abs(divisor) > safe) {
        return Outcome.Err(CoreErrorKind.RANGE)
    }
    return Outcome.Ok(dividend / divisor)
}
