// 最小の JSON 読み取りと 16 進変換（C++ の試験用）。
//
// 依存を持たない方針（licensing.md）のため、外部の JSON 解析器を使わない。
// 汎用ではなく、凍結ベクタとトレースの形（配列とオブジェクトの入れ子、整数、文字列、
// 真偽値、null）だけを読む。適合試験とトレース試験の両方から使うためヘッダへ切り出す。
#pragma once

#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

namespace wheso::testing {

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

inline std::vector<std::uint8_t> hexToBytes(const std::string& hex) {
  std::vector<std::uint8_t> bytes;
  for (std::size_t index = 0; index + 1 < hex.size(); index += 2) {
    const std::string pair = hex.substr(index, 2);
    bytes.push_back(static_cast<std::uint8_t>(std::strtoul(pair.c_str(), nullptr, 16)));
  }
  return bytes;
}

inline std::string bytesToHex(const std::vector<std::uint8_t>& bytes) {
  static const char* digits = "0123456789abcdef";
  std::string out;
  out.reserve(bytes.size() * 2);
  for (const std::uint8_t byte : bytes) {
    out.push_back(digits[(byte >> 4) & 0x0F]);
    out.push_back(digits[byte & 0x0F]);
  }
  return out;
}


/// ファイルを丸ごと読んで JSON として解析する。開けない場合は空を返す。
inline JsonPtr readJsonFile(const std::string& path) {
  std::ifstream file(path);
  if (!file.is_open()) {
    return nullptr;
  }
  std::stringstream buffer;
  buffer << file.rdbuf();
  const std::string text = buffer.str();
  JsonReader reader(text);
  return reader.parse();
}

}  // namespace wheso::testing
