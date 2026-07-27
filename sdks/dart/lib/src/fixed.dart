// 擬似乱数と整数演算（Dart）。
//
// 規範: conformance.md 3.2（xorshift64）と 3.3（整数演算）。
// TypeScript の参照実装と同じ結果を返さなければならない。検証はテストベクタで行う。
//
// 例外を投げない。失敗は Result で返す。
// 浮動小数点を使わない。Dart の int は 64 bit の 2 の補数であり、`<<` は巻き戻る。

import 'generated/constants.dart' as constants;

/// 失敗の種類。
enum CoreErrorKind {
  prngZeroSeed,
  prngShifts,
  divideByZero,
  range,
}

/// 成功か失敗のどちらかを表す。例外を投げないための型である。
class Result<T> {
  const Result.ok(this.value)
      : isOk = true,
        error = null;
  const Result.err(this.error)
      : isOk = false,
        value = null;

  final bool isOk;
  final T? value;
  final CoreErrorKind? error;
}

/// 擬似乱数器の状態。
class PrngState {
  const PrngState(this.value);
  final int value;
}

/// 状態遷移の結果。
class PrngStep {
  const PrngStep(this.state, this.output);
  final PrngState state;
  final int output;
}

/// 移動量を定数文字列から読む。数値をコードに書かない。
List<int>? prngShifts() {
  final parts = constants.PRNG_MULTIPLIER_SHIFTS.split(',');
  if (parts.length != 3) {
    return null;
  }
  final shifts = <int>[];
  for (final part in parts) {
    final parsed = int.tryParse(part.trim());
    if (parsed == null) {
      return null;
    }
    shifts.add(parsed);
  }
  return shifts;
}

/// 擬似乱数器を初期化する。種 0 は xorshift の不動点であるため禁止する。
Result<PrngState> createPrng(int seed) {
  if (prngShifts() == null) {
    return const Result.err(CoreErrorKind.prngShifts);
  }
  if (seed == 0) {
    return const Result.err(CoreErrorKind.prngZeroSeed);
  }
  return Result.ok(PrngState(seed));
}

/// 状態遷移。conformance.md 3.2 の 3 段の xorshift をそのまま実装する。
///
/// Dart の `>>` は符号付きの算術シフトであるため、論理シフトの `>>>` を使う。
/// 使わないと負の値で上位ビットが埋まり、他言語と結果が食い違う。
Result<PrngStep> prngNext(PrngState state) {
  final shifts = prngShifts();
  if (shifts == null) {
    return const Result.err(CoreErrorKind.prngShifts);
  }
  var s = state.value;
  s ^= s << shifts[0];
  s ^= s >>> shifts[1];
  s ^= s << shifts[2];
  return Result.ok(PrngStep(PrngState(s), s));
}

/// 最小二乗の傾き。分子と分母の整数対で表す。除算しない（ADR-0017）。
class Slope {
  const Slope(this.numerator, this.denominator);
  final int numerator;
  final int denominator;
}

/// 遅延の標本列から傾きを求める。
Slope delaySlope(List<int> samplesUs) {
  final n = samplesUs.length;
  if (n < 2) {
    return const Slope(0, 1);
  }
  var sx = 0;
  var sy = 0;
  var sxy = 0;
  var sxx = 0;
  for (var index = 0; index < n; index += 1) {
    final i = index;
    final y = samplesUs[index];
    sx += i;
    sy += y;
    sxy += i * y;
    sxx += i * i;
  }
  return Slope(n * sxy - sx * sy, n * sxx - sx * sx);
}

/// 傾きが劣化閾値を超えるか。交差乗算で判定する。
bool isDegrading(Slope slope) =>
    slope.numerator * constants.DELAY_TREND_DEGRADE_DEN >
    constants.DELAY_TREND_DEGRADE_NUM * slope.denominator;

/// 傾きが回復閾値を下回るか。
bool isRecovering(Slope slope) =>
    slope.numerator * constants.DELAY_TREND_RECOVER_DEN <
    constants.DELAY_TREND_RECOVER_NUM * slope.denominator;

/// 32 bit の巻き戻り。ハッシュ計算で使う。
int wrap32(int value) => value & 0xFFFFFFFF;

/// 切り捨ての整数除算。0 除算と安全整数域外は失敗として返す。
Result<int> truncDiv(int dividend, int divisor) {
  if (divisor == 0) {
    return const Result.err(CoreErrorKind.divideByZero);
  }
  // TypeScript 側は安全整数（2^53）を超える値を扱わない。同じ範囲に限る。
  const safe = 9007199254740991;
  if (dividend.abs() > safe || divisor.abs() > safe) {
    return const Result.err(CoreErrorKind.range);
  }
  return Result.ok(dividend ~/ divisor);
}
