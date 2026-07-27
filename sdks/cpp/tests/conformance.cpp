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

/* --- 最小の JSON 読み取り ------------------------------------------------- */

struct JsonValue;
using JsonPtr = std::shared_ptr<JsonValue>;

struct JsonValue {
  enum class Kind { Null, Bool, Number, String, Array, Object } kind = Kind::Null;
  bool boolean = false;
  double number = 0;
  std::string text;
  std::vector<JsonPtr> array;
  std::map<std::string, JsonPtr> object;
};

class JsonReader {
 public:
  explicit JsonReader(const std::string& source) : source_(source) {}

  JsonPtr parse() {
    skip();
    return parseValue();
  }

 private:
  const std::string& source_;
  std::size_t position_ = 0;

  void skip() {
    while (position_ < source_.size()) {
      const char c = source_[position_];
      if (c == ' ' || c == '\n' || c == '\t' || c == '\r') {
        position_ += 1;
        continue;
      }
      break;
    }
  }

  JsonPtr parseValue() {
    if (position_ >= source_.size()) {
      return std::make_shared<JsonValue>();
    }
    const char c = source_[position_];
    if (c == '{') {
      return parseObject();
    }
    if (c == '[') {
      return parseArray();
    }
    if (c == '"') {
      auto value = std::make_shared<JsonValue>();
      value->kind = JsonValue::Kind::String;
      value->text = parseString();
      return value;
    }
    if (source_.compare(position_, 4, "true") == 0) {
      position_ += 4;
      auto value = std::make_shared<JsonValue>();
      value->kind = JsonValue::Kind::Bool;
      value->boolean = true;
      return value;
    }
    if (source_.compare(position_, 5, "false") == 0) {
      position_ += 5;
      auto value = std::make_shared<JsonValue>();
      value->kind = JsonValue::Kind::Bool;
      value->boolean = false;
      return value;
    }
    if (source_.compare(position_, 4, "null") == 0) {
      position_ += 4;
      return std::make_shared<JsonValue>();
    }
    return parseNumber();
  }

  std::string parseString() {
    std::string out;
    position_ += 1;  // 開きの引用符
    while (position_ < source_.size()) {
      const char c = source_[position_];
      if (c == '"') {
        position_ += 1;
        return out;
      }
      if (c == '\\' && position_ + 1 < source_.size()) {
        const char escaped = source_[position_ + 1];
        position_ += 2;
        if (escaped == 'n') {
          out.push_back('\n');
        } else if (escaped == 'u') {
          // ベクタの文字列に含まれる非 ASCII は比較に使わないため読み飛ばす。
          position_ += 4;
        } else {
          out.push_back(escaped);
        }
        continue;
      }
      out.push_back(c);
      position_ += 1;
    }
    return out;
  }

  JsonPtr parseNumber() {
    const std::size_t start = position_;
    while (position_ < source_.size()) {
      const char c = source_[position_];
      const bool numeric = (c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E';
      if (!numeric) {
        break;
      }
      position_ += 1;
    }
    auto value = std::make_shared<JsonValue>();
    value->kind = JsonValue::Kind::Number;
    value->text = source_.substr(start, position_ - start);
    value->number = std::strtod(value->text.c_str(), nullptr);
    return value;
  }

  JsonPtr parseArray() {
    auto value = std::make_shared<JsonValue>();
    value->kind = JsonValue::Kind::Array;
    position_ += 1;  // '['
    skip();
    while (position_ < source_.size() && source_[position_] != ']') {
      value->array.push_back(parseValue());
      skip();
      if (position_ < source_.size() && source_[position_] == ',') {
        position_ += 1;
        skip();
      }
    }
    if (position_ < source_.size()) {
      position_ += 1;  // ']'
    }
    return value;
  }

  JsonPtr parseObject() {
    auto value = std::make_shared<JsonValue>();
    value->kind = JsonValue::Kind::Object;
    position_ += 1;  // '{'
    skip();
    while (position_ < source_.size() && source_[position_] != '}') {
      const std::string key = parseString();
      skip();
      if (position_ < source_.size() && source_[position_] == ':') {
        position_ += 1;
        skip();
      }
      value->object[key] = parseValue();
      skip();
      if (position_ < source_.size() && source_[position_] == ',') {
        position_ += 1;
        skip();
      }
    }
    if (position_ < source_.size()) {
      position_ += 1;  // '}'
    }
    return value;
  }
};

JsonPtr field(const JsonPtr& value, const std::string& key) {
  if (value == nullptr || value->kind != JsonValue::Kind::Object) {
    return nullptr;
  }
  const auto found = value->object.find(key);
  return found == value->object.end() ? nullptr : found->second;
}

std::int64_t asInt(const JsonPtr& value, std::int64_t fallback = 0) {
  if (value == nullptr) {
    return fallback;
  }
  if (value->kind == JsonValue::Kind::Number) {
    return static_cast<std::int64_t>(value->number);
  }
  if (value->kind == JsonValue::Kind::String) {
    return static_cast<std::int64_t>(std::strtoll(value->text.c_str(), nullptr, 10));
  }
  return fallback;
}

std::uint64_t asUnsigned(const JsonPtr& value) {
  if (value == nullptr) {
    return 0;
  }
  if (value->kind == JsonValue::Kind::String) {
    return std::strtoull(value->text.c_str(), nullptr, 10);
  }
  return static_cast<std::uint64_t>(value->number);
}

std::string asText(const JsonPtr& value) {
  return value == nullptr ? std::string() : value->text;
}

/// ベクタの置き場所。実行時に引数で受け取る（構築先に依存しないため）。
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

std::vector<std::uint8_t> hexToBytes(const std::string& hex) {
  std::vector<std::uint8_t> bytes;
  for (std::size_t index = 0; index + 1 < hex.size(); index += 2) {
    const std::string pair = hex.substr(index, 2);
    bytes.push_back(static_cast<std::uint8_t>(std::strtoul(pair.c_str(), nullptr, 16)));
  }
  return bytes;
}

std::string bytesToHex(const std::vector<std::uint8_t>& bytes) {
  static const char* digits = "0123456789abcdef";
  std::string out;
  out.reserve(bytes.size() * 2);
  for (const std::uint8_t byte : bytes) {
    out.push_back(digits[(byte >> 4) & 0x0F]);
    out.push_back(digits[byte & 0x0F]);
  }
  return out;
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
