// 擬似乱数と整数演算（C++、ヘッダのみ）。
//
// 規範: conformance.md 3.2（xorshift64）と 3.3（整数演算）。
// TypeScript の参照実装と同じ結果を返さなければならない。検証はテストベクタで行う。
//
// 例外を投げない。失敗は Result 相当（std::optional と誤り列）で返す。
// 浮動小数点を使わない。
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string_view>
#include <vector>

#include "generated/constants.hpp"

namespace wheso {

enum class CoreError {
  PrngZeroSeed,
  PrngShifts,
  DivideByZero,
  Range,
};

template <typename T>
struct Result {
  bool ok;
  T value;
  CoreError error;

  static Result success(T v) { return Result{true, v, CoreError::Range}; }
  static Result failure(CoreError e) { return Result{false, T{}, e}; }
};

/// 移動量を定数文字列から読む。数値をコードに書かない。
inline std::optional<std::array<std::uint32_t, 3>> prng_shifts() {
  const std::string_view text = constants::PRNG_MULTIPLIER_SHIFTS;
  std::array<std::uint32_t, 3> shifts{0, 0, 0};
  std::size_t index = 0;
  std::uint32_t current = 0;
  bool has_digit = false;
  for (const char character : text) {
    if (character >= '0' && character <= '9') {
      current = current * 10 + static_cast<std::uint32_t>(character - '0');
      has_digit = true;
      continue;
    }
    if (character == ',') {
      if (!has_digit || index >= shifts.size()) {
        return std::nullopt;
      }
      shifts[index] = current;
      index += 1;
      current = 0;
      has_digit = false;
      continue;
    }
    if (character == ' ') {
      continue;
    }
    return std::nullopt;
  }
  if (!has_digit || index != shifts.size() - 1) {
    return std::nullopt;
  }
  shifts[index] = current;
  return shifts;
}

struct PrngState {
  std::uint64_t value;
};

/// 擬似乱数器を初期化する。種 0 は xorshift の不動点であるため禁止する。
inline Result<PrngState> create_prng(std::uint64_t seed) {
  if (!prng_shifts().has_value()) {
    return Result<PrngState>::failure(CoreError::PrngShifts);
  }
  if (seed == 0) {
    return Result<PrngState>::failure(CoreError::PrngZeroSeed);
  }
  return Result<PrngState>::success(PrngState{seed});
}

struct PrngStep {
  PrngState state;
  std::uint64_t output;
};

/// 状態遷移。conformance.md 3.2 の 3 段の xorshift をそのまま実装する。
inline Result<PrngStep> prng_next(PrngState state) {
  const auto shifts = prng_shifts();
  if (!shifts.has_value()) {
    return Result<PrngStep>::failure(CoreError::PrngShifts);
  }
  std::uint64_t s = state.value;
  // 符号なし整数の左シフトは 64 bit で巻き戻る。規範どおりの 3 段である。
  s ^= s << shifts->at(0);
  s ^= s >> shifts->at(1);
  s ^= s << shifts->at(2);
  return Result<PrngStep>::success(PrngStep{PrngState{s}, s});
}

/// 最小二乗の傾き。分子と分母の整数対で表す。除算しない（ADR-0017）。
struct Slope {
  std::int64_t numerator;
  std::int64_t denominator;
};

inline Slope delay_slope(const std::vector<std::int64_t>& samples_us) {
  const std::int64_t n = static_cast<std::int64_t>(samples_us.size());
  if (n < 2) {
    return Slope{0, 1};
  }
  std::int64_t sx = 0;
  std::int64_t sy = 0;
  std::int64_t sxy = 0;
  std::int64_t sxx = 0;
  for (std::size_t index = 0; index < samples_us.size(); index += 1) {
    const std::int64_t i = static_cast<std::int64_t>(index);
    const std::int64_t y = samples_us[index];
    sx += i;
    sy += y;
    sxy += i * y;
    sxx += i * i;
  }
  return Slope{n * sxy - sx * sy, n * sxx - sx * sx};
}

/// 交差乗算で閾値と比べる。浮動小数点を使わない。
inline bool is_degrading(Slope slope) {
  return slope.numerator * constants::DELAY_TREND_DEGRADE_DEN >
         constants::DELAY_TREND_DEGRADE_NUM * slope.denominator;
}

inline bool is_recovering(Slope slope) {
  return slope.numerator * constants::DELAY_TREND_RECOVER_DEN <
         constants::DELAY_TREND_RECOVER_NUM * slope.denominator;
}

/// 32 bit の巻き戻り。ハッシュ計算で使う。
inline std::uint32_t wrap32(std::int64_t value) {
  return static_cast<std::uint32_t>(static_cast<std::uint64_t>(value) & 0xFFFFFFFFULL);
}

/// 切り捨ての整数除算。0 除算と安全整数域外は失敗として返す。
inline Result<std::int64_t> trunc_div(std::int64_t dividend, std::int64_t divisor) {
  if (divisor == 0) {
    return Result<std::int64_t>::failure(CoreError::DivideByZero);
  }
  // TypeScript 側は安全整数（2^53）を超える値を扱わない。同じ範囲に限る。
  constexpr std::int64_t safe = 9007199254740991LL;
  const std::int64_t abs_dividend = dividend < 0 ? -dividend : dividend;
  const std::int64_t abs_divisor = divisor < 0 ? -divisor : divisor;
  if (abs_dividend > safe || abs_divisor > safe) {
    return Result<std::int64_t>::failure(CoreError::Range);
  }
  return Result<std::int64_t>::success(dividend / divisor);
}

}  // namespace wheso
