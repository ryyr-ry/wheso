// 適合試験（C++、段 A）。
//
// 凍結ベクタ（spec/vectors）に対して TypeScript の参照実装と同一の結果を出すことを確かめる。
// ベクタを実装に合わせて変更してはならない。実装を直す（ADR-0012）。
//
// 依存を持たないため、必要最小限の JSON 読み取りを本ファイル内に持つ。
// 汎用の JSON 解析器ではない。ベクタの形（配列とオブジェクトの入れ子）だけを読む。
//
// 実行: bash sdks/cpp/run-tests.sh

#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include "../include/wheso/fixed.hpp"
#include "../include/wheso/wire.hpp"
#include "json.hpp"

using wheso::testing::bytesToHex;
using wheso::testing::hexToBytes;
using wheso::testing::JsonPtr;
using wheso::testing::JsonReader;
using wheso::testing::JsonValue;

namespace {

int failures = 0;
int checks = 0;

void expect(bool condition, const std::string& description) {
  checks += 1;
  if (!condition) {
    failures += 1;
    std::cout << "FAIL " << description << "\n";
  }
}

std::string vectorDir = "spec/vectors";

JsonPtr readVector(const std::string& name) {
  const std::string path = vectorDir + "/" + name;
  std::ifstream file(path);
  if (!file.is_open()) {
    std::cout << "FAIL ベクタを開けない: " << path << "\n";
    failures += 1;
    return nullptr;
  }
  std::stringstream buffer;
  buffer << file.rdbuf();
  const std::string text = buffer.str();
  JsonReader reader(text);
  return reader.parse();
}

/* --- 試験 ---------------------------------------------------------------- */

void testPrng() {
  const JsonPtr root = readVector("prng.json");
  const JsonPtr vectors = field(root, "vectors");
  expect(vectors != nullptr && !vectors->array.empty(), "prng: ベクタが空でない");
  if (vectors == nullptr) {
    return;
  }
  for (const JsonPtr& entry : vectors->array) {
    const std::uint64_t seed = asUnsigned(field(entry, "seed"));
    const JsonPtr outputs = field(entry, "outputs");
    const auto created = wheso::create_prng(seed);
    if (seed == 0) {
      expect(!created.ok, "prng: 種 0 は失敗する");
      continue;
    }
    expect(created.ok, "prng: 擬似乱数器を作れる");
    if (!created.ok || outputs == nullptr) {
      continue;
    }
    wheso::PrngState state = created.value;
    for (const JsonPtr& expected : outputs->array) {
      const auto stepped = wheso::prng_next(state);
      expect(stepped.ok, "prng: 状態遷移できる");
      if (!stepped.ok) {
        break;
      }
      state = stepped.value.state;
      expect(stepped.value.output == asUnsigned(expected), "prng: 出力が一致する");
    }
  }
}

void testMedia() {
  const JsonPtr root = readVector("media.json");
  expect(root != nullptr && !root->array.empty(), "media: ベクタが空でない");
  if (root == nullptr) {
    return;
  }
  for (const JsonPtr& entry : root->array) {
    const std::string expectedHex = asText(field(entry, "bytesHex"));
    const JsonPtr message = field(entry, "message");
    wheso::MediaMessage built;
    built.channel = static_cast<std::uint8_t>(asInt(field(message, "channel")));
    built.sender_id = static_cast<std::uint32_t>(asInt(field(message, "senderId")));
    const JsonPtr units = field(message, "units");
    if (units != nullptr) {
      for (const JsonPtr& unit : units->array) {
        wheso::Unit built_unit;
        built_unit.sequence_number = static_cast<std::uint32_t>(asInt(field(unit, "sequenceNumber")));
        built_unit.capture_timestamp_us = asUnsigned(field(unit, "captureTimestampUs"));
        built_unit.flags = static_cast<std::uint8_t>(asInt(field(unit, "flags")));
        built_unit.spatial_id = static_cast<std::uint8_t>(asInt(field(unit, "spatialId")));
        built_unit.temporal_id = static_cast<std::uint8_t>(asInt(field(unit, "temporalId")));
        built_unit.payload = hexToBytes(asText(field(unit, "payloadHex")));
        built.units.push_back(std::move(built_unit));
      }
    }
    const auto encoded = wheso::encode_media_message(built);
    expect(encoded.ok, "media: 符号化できる");
    if (!encoded.ok) {
      continue;
    }
    expect(bytesToHex(encoded.value) == expectedHex, "media: 符号化がベクタと一致する");

    const auto decoded = wheso::decode_media_message(hexToBytes(expectedHex));
    expect(decoded.ok, "media: 復号できる");
    if (!decoded.ok) {
      continue;
    }
    expect(decoded.value.channel == built.channel, "media: channel が一致する");
    expect(decoded.value.sender_id == built.sender_id, "media: senderId が一致する");
    expect(decoded.value.units.size() == built.units.size(), "media: ユニット数が一致する");
    for (std::size_t index = 0; index < decoded.value.units.size() && index < built.units.size(); index += 1) {
      expect(decoded.value.units[index].sequence_number == built.units[index].sequence_number,
             "media: sequenceNumber が一致する");
      expect(decoded.value.units[index].capture_timestamp_us == built.units[index].capture_timestamp_us,
             "media: timestamp が一致する");
      expect(decoded.value.units[index].payload == built.units[index].payload, "media: payload が一致する");
    }
  }
}

void testInvalid() {
  const JsonPtr root = readVector("invalid.json");
  expect(root != nullptr && !root->array.empty(), "invalid: ベクタが空でない");
  if (root == nullptr) {
    return;
  }
  for (const JsonPtr& entry : root->array) {
    const std::vector<std::uint8_t> bytes = hexToBytes(asText(field(entry, "bytesHex")));
    const std::string expected = asText(field(entry, "expectedErrorCode"));
    const auto decoded = wheso::decode_media_message(bytes);
    expect(!decoded.ok, std::string("invalid: 受理しない ") + asText(field(entry, "name")));
    if (decoded.ok) {
      continue;
    }
    expect(std::string(wheso::wire_error_name(decoded.error)) == expected,
           std::string("invalid: 同じエラーで拒否する ") + asText(field(entry, "name")));
  }
}

void testDropOrder() {
  const JsonPtr root = readVector("drop-order.json");
  expect(root != nullptr && !root->array.empty(), "drop-order: ベクタが空でない");
  if (root == nullptr) {
    return;
  }
  for (const JsonPtr& entry : root->array) {
    const std::uint8_t channel = static_cast<std::uint8_t>(asInt(field(entry, "channel")));
    const std::uint8_t flags = static_cast<std::uint8_t>(asInt(field(entry, "flags")));
    const JsonPtr expectedValue = field(entry, "expectedPriority");
    const auto actual = wheso::drop_priority(channel, flags);
    const bool expectedNull = expectedValue == nullptr || expectedValue->kind == JsonValue::Kind::Null;
    if (expectedNull) {
      expect(!actual.has_value(), std::string("drop-order: 破棄禁止 ") + asText(field(entry, "name")));
      continue;
    }
    expect(actual.has_value() && actual.value() == static_cast<std::uint8_t>(asInt(expectedValue)),
           std::string("drop-order: 優先順位が一致する ") + asText(field(entry, "name")));
  }
}

void testSlope() {
  std::vector<std::int64_t> rising;
  std::vector<std::int64_t> flat;
  std::vector<std::int64_t> falling;
  for (std::int64_t index = 0; index < 20; index += 1) {
    rising.push_back(10000 + index * 1000);
    flat.push_back(10000);
    falling.push_back(30000 - index * 1000);
  }
  expect(wheso::delay_slope(rising).numerator > 0, "slope: 増加は正");
  expect(wheso::delay_slope(flat).numerator == 0, "slope: 一定は 0");
  expect(wheso::delay_slope(falling).numerator < 0, "slope: 減少は負");
  expect(wheso::delay_slope(rising).denominator > 0, "slope: 分母は常に正");
  expect(wheso::is_degrading(wheso::delay_slope(rising)), "slope: 増加は劣化");
  expect(!wheso::is_degrading(wheso::delay_slope(flat)), "slope: 一定は劣化でない");
  expect(wheso::is_recovering(wheso::delay_slope(falling)), "slope: 減少は回復");
}

void testDiscardableAndDiv() {
  expect(!wheso::compute_discardable(2, false, 0, 1), "discardable: 音声は false");
  expect(!wheso::compute_discardable(1, true, 0, 3), "discardable: キーは false");
  expect(!wheso::compute_discardable(1, false, 1, 3), "discardable: 最上位でない層は false");
  expect(wheso::compute_discardable(1, false, 2, 3), "discardable: 最上位の層は true");

  expect(wheso::trunc_div(10, 3).ok && wheso::trunc_div(10, 3).value == 3, "trunc_div: 正の割り算");
  expect(wheso::trunc_div(-10, 3).ok && wheso::trunc_div(-10, 3).value == -3, "trunc_div: 負はゼロ方向");
  expect(!wheso::trunc_div(10, 0).ok, "trunc_div: 0 除算は失敗");
  expect(!wheso::trunc_div(9007199254740993LL, 3).ok, "trunc_div: 安全整数域外は失敗");
}

}  // namespace

int main(int argc, char** argv) {
  // 第 1 引数でベクタの置き場所を受け取る。既定はリポジトリ直下からの相対である。
  if (argc > 1 && argv[1] != nullptr) {
    vectorDir = argv[1];
  }
  testPrng();
  testMedia();
  testInvalid();
  testDropOrder();
  testSlope();
  testDiscardableAndDiv();

  std::cout << "検査 " << checks << " 件、失敗 " << failures << " 件\n";
  if (failures == 0) {
    std::cout << "OK: C++ の実装が凍結ベクタと一致する\n";
    return 0;
  }
  return 1;
}
