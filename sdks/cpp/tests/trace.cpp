// トレースベクタの照合（C++、層 2: 決定同一）。
//
// 凍結トレース（spec/vectors/trace-shard.jsonl と trace-receiver.jsonl）を C++ の判断コアへ
// 流し、出力コマンド列が TypeScript の参照実装と**完全に一致**することを確かめる。
// 1 コマンドの相違も許さない（conformance.md 4.4）。欄の過不足も検出する。
//
// 相違した場合はベクタではなく実装を直す（ADR-0012）。
//
// 実行: bash sdks/cpp/run-tests.sh

#include <cstdint>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "../include/wheso/receiver_core.hpp"
#include "../include/wheso/shard_core.hpp"
#include "json.hpp"

using wheso::testing::asInt;
using wheso::testing::field;
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

/// 欄の集合。キーの昇順で並ぶため、欄の順序に依存せず、過不足を検出できる。
using Fields = std::map<std::string, std::string>;

std::string render(const Fields& fields) {
  std::string out = "{";
  bool first = true;
  for (const auto& [key, value] : fields) {
    if (!first) {
      out += ",";
    }
    first = false;
    out += key;
    out += ":";
    out += value;
  }
  out += "}";
  return out;
}

std::string integerText(double value) {
  std::ostringstream stream;
  stream << static_cast<std::int64_t>(value);
  return stream.str();
}

std::string integerText(std::int64_t value) {
  std::ostringstream stream;
  stream << value;
  return stream.str();
}

/// 期待値（JSON）を欄の集合へ写す。小数は現れない（整数のみを送る。ADR-0017）。
Fields expectedFields(const JsonPtr& value) {
  Fields fields;
  if (value == nullptr || value->kind != JsonValue::Kind::Object) {
    return fields;
  }
  for (const auto& [key, item] : value->object) {
    if (item == nullptr) {
      fields[key] = "null";
      continue;
    }
    switch (item->kind) {
      case JsonValue::Kind::Null:
        fields[key] = "null";
        break;
      case JsonValue::Kind::Bool:
        fields[key] = item->boolean ? "true" : "false";
        break;
      case JsonValue::Kind::Number:
        fields[key] = integerText(item->number);
        break;
      case JsonValue::Kind::String:
        fields[key] = item->text;
        break;
      case JsonValue::Kind::Array: {
        std::string out = "[";
        for (std::size_t index = 0; index < item->array.size(); index += 1) {
          if (index > 0) {
            out += ",";
          }
          const JsonPtr& element = item->array[index];
          out += element == nullptr ? "null" : integerText(element->number);
        }
        out += "]";
        fields[key] = out;
        break;
      }
      case JsonValue::Kind::Object:
        fields[key] = "{...}";
        break;
    }
  }
  return fields;
}

std::string listText(const std::vector<std::int64_t>& values) {
  std::string out = "[";
  for (std::size_t index = 0; index < values.size(); index += 1) {
    if (index > 0) {
      out += ",";
    }
    out += integerText(values[index]);
  }
  out += "]";
  return out;
}

/* --- 中継ノード ----------------------------------------------------------- */

bool toShardEvent(const JsonPtr& input, wheso::shard::Event& event) {
  const std::string kind = wheso::testing::asText(field(input, "kind"));
  if (kind == "media") {
    event.kind = wheso::shard::EventKind::Media;
    event.from = asInt(field(input, "from"));
    event.ch = asInt(field(input, "ch"));
    event.sid = asInt(field(input, "sid"));
    event.tid = asInt(field(input, "tid"));
    const JsonPtr key = field(input, "key");
    event.key = key != nullptr && key->kind == JsonValue::Kind::Bool && key->boolean;
    event.bytes = asInt(field(input, "bytes"));
    event.flags = asInt(field(input, "flags"));
    return true;
  }
  if (kind == "subscribe") {
    event.kind = wheso::shard::EventKind::Subscribe;
    event.from = asInt(field(input, "from"));
    event.to = asInt(field(input, "to"));
    const JsonPtr want = field(input, "want");
    event.want = want != nullptr && want->kind == JsonValue::Kind::Bool && want->boolean;
    event.max_spatial_id = asInt(field(input, "maxSpatialId"));
    return true;
  }
  if (kind == "join") {
    event.kind = wheso::shard::EventKind::Join;
    event.id = asInt(field(input, "id"));
    return true;
  }
  if (kind == "leave") {
    event.kind = wheso::shard::EventKind::Leave;
    event.id = asInt(field(input, "id"));
    return true;
  }
  if (kind == "link") {
    event.kind = wheso::shard::EventKind::Link;
    event.peer = asInt(field(input, "peer"));
    event.link_state = wheso::testing::asText(field(input, "state"));
    return true;
  }
  if (kind == "timer") {
    event.kind = wheso::shard::EventKind::Timer;
    return true;
  }
  if (kind == "budget") {
    event.kind = wheso::shard::EventKind::Budget;
    event.bytes_per_sec = asInt(field(input, "bytesPerSec"));
    return true;
  }
  if (kind == "report") {
    event.kind = wheso::shard::EventKind::Report;
    event.from = asInt(field(input, "from"));
    event.delay_us.clear();
    const JsonPtr samples = field(input, "delayUs");
    if (samples != nullptr && samples->kind == JsonValue::Kind::Array) {
      for (const JsonPtr& sample : samples->array) {
        event.delay_us.push_back(asInt(sample));
      }
    }
    return true;
  }
  return false;
}

/// 出力コマンドを TypeScript と同じ欄名の集合へ写す。
Fields shardFields(const wheso::shard::Command& command) {
  Fields fields;
  switch (command.kind) {
    case wheso::shard::CommandKind::Forward:
      fields["kind"] = "forward";
      fields["to"] = listText(command.to);
      break;
    case wheso::shard::CommandKind::Drop:
      fields["kind"] = "drop";
      fields["priority"] = integerText(command.priority);
      fields["count"] = integerText(command.count);
      break;
    case wheso::shard::CommandKind::Notify:
      fields["kind"] = "notify";
      fields["code"] = integerText(command.code);
      break;
    case wheso::shard::CommandKind::SetTier:
      fields["kind"] = "setTier";
      fields["for"] = integerText(command.target_id);
      fields["tier"] = integerText(command.tier);
      break;
  }
  return fields;
}

/* --- 受信ノード ----------------------------------------------------------- */

/// 生成器（tools/traces-receiver.ts）と一致させる初期予算。
constexpr std::int64_t INITIAL_RECEIVER_BUDGET = 7000000;

bool toReceiverEvent(const JsonPtr& input, wheso::receiver::Event& event) {
  const std::string kind = wheso::testing::asText(field(input, "kind"));
  if (kind == "subscribe") {
    event.kind = wheso::receiver::EventKind::SubscribeList;
    event.entries.clear();
    const JsonPtr entries = field(input, "entries");
    if (entries != nullptr && entries->kind == JsonValue::Kind::Array) {
      for (const JsonPtr& element : entries->array) {
        wheso::receiver::SubscribeEntry entry;
        entry.sender_id = asInt(field(element, "senderId"));
        entry.channel = asInt(field(element, "channel"));
        entry.max_spatial_id = asInt(field(element, "maxSpatialId"));
        entry.max_temporal_id = asInt(field(element, "maxTemporalId"));
        event.entries.push_back(entry);
      }
    }
    return true;
  }
  if (kind == "leave") {
    event.kind = wheso::receiver::EventKind::Leave;
    event.id = asInt(field(input, "id"));
    return true;
  }
  if (kind == "visibility") {
    event.kind = wheso::receiver::EventKind::Visibility;
    const JsonPtr visible = field(input, "visible");
    event.visible = visible != nullptr && visible->kind == JsonValue::Kind::Bool && visible->boolean;
    return true;
  }
  if (kind == "budget") {
    event.kind = wheso::receiver::EventKind::Budget;
    event.bytes_per_sec = asInt(field(input, "bytesPerSec"));
    return true;
  }
  if (kind == "activeSpeaker") {
    event.kind = wheso::receiver::EventKind::ActiveSpeaker;
    const JsonPtr id = field(input, "id");
    // null は「発話者なし」を意味する。欄の欠落と区別する。
    if (id == nullptr || id->kind == JsonValue::Kind::Null) {
      event.speaker_id.reset();
    } else {
      event.speaker_id = asInt(id);
    }
    return true;
  }
  if (kind == "displaySize") {
    event.kind = wheso::receiver::EventKind::DisplaySize;
    event.sender_id = asInt(field(input, "senderId"));
    event.channel = asInt(field(input, "channel"));
    event.width = asInt(field(input, "width"));
    return true;
  }
  if (kind == "report") {
    event.kind = wheso::receiver::EventKind::Report;
    event.delay_us.clear();
    const JsonPtr samples = field(input, "delayUs");
    if (samples != nullptr && samples->kind == JsonValue::Kind::Array) {
      for (const JsonPtr& sample : samples->array) {
        event.delay_us.push_back(asInt(sample));
      }
    }
    return true;
  }
  if (kind == "media") {
    event.kind = wheso::receiver::EventKind::Media;
    event.from = asInt(field(input, "from"));
    event.ch = asInt(field(input, "ch"));
    event.sid = asInt(field(input, "sid"));
    event.tid = asInt(field(input, "tid"));
    event.seq = asInt(field(input, "seq"));
    return true;
  }
  if (kind == "timer") {
    event.kind = wheso::receiver::EventKind::Timer;
    return true;
  }
  return false;
}

Fields receiverFields(const wheso::receiver::Command& command) {
  Fields fields;
  switch (command.kind) {
    case wheso::receiver::CommandKind::SubscribeChange:
      fields["kind"] = "subscribeChange";
      fields["to"] = integerText(command.to);
      fields["channel"] = integerText(command.channel);
      fields["want"] = command.want ? "true" : "false";
      fields["maxSpatialId"] = integerText(command.max_spatial_id);
      fields["maxTemporalId"] = integerText(command.max_temporal_id);
      break;
    case wheso::receiver::CommandKind::KeyframeRequest:
      fields["kind"] = "keyframeRequest";
      fields["for"] = integerText(command.target_id);
      fields["channel"] = integerText(command.channel);
      fields["spatialId"] = integerText(command.spatial_id);
      break;
    case wheso::receiver::CommandKind::SetTier:
      fields["kind"] = "setTier";
      fields["for"] = integerText(command.target_id);
      fields["channel"] = integerText(command.channel);
      fields["tier"] = integerText(command.tier);
      break;
    case wheso::receiver::CommandKind::Forward:
      fields["kind"] = "forward";
      fields["to"] = listText(command.forward_to);
      break;
    case wheso::receiver::CommandKind::Drop:
      fields["kind"] = "drop";
      fields["priority"] = integerText(command.priority);
      fields["count"] = integerText(command.count);
      break;
    case wheso::receiver::CommandKind::Notify:
      fields["kind"] = "notify";
      fields["code"] = command.code;
      break;
    case wheso::receiver::CommandKind::Ack:
      fields["kind"] = "ack";
      fields["senderId"] = integerText(command.sender_id);
      fields["channel"] = integerText(command.channel);
      fields["spatialId"] = integerText(command.spatial_id);
      fields["highestSeq"] = integerText(command.highest_seq);
      break;
  }
  return fields;
}

std::vector<std::string> readLines(const std::string& path) {
  std::vector<std::string> lines;
  std::ifstream file(path);
  if (!file.is_open()) {
    std::cout << "FAIL トレースを開けない: " << path << "\n";
    failures += 1;
    return lines;
  }
  std::string line;
  while (std::getline(file, line)) {
    if (!line.empty()) {
      lines.push_back(line);
    }
  }
  return lines;
}

JsonPtr parseLine(const std::string& line) {
  JsonReader reader(line);
  return reader.parse();
}

void testShardTrace(const std::string& dir) {
  const std::vector<std::string> lines = readLines(dir + "/trace-shard.jsonl");
  expect(lines.size() > 100, "中継トレースが十分な行数を持つ");
  if (lines.empty()) {
    return;
  }
  const JsonPtr header = parseLine(lines[0]);
  expect(wheso::testing::asText(field(header, "unit")) == "shard", "中継ノードのトレースである");

  bool started = false;
  wheso::shard::State state;
  JsonPtr pending = nullptr;
  int checkedRows = 0;

  for (std::size_t index = 1; index < lines.size(); index += 1) {
    const JsonPtr row = parseLine(lines[index]);
    const JsonPtr input = field(row, "in");
    if (input != nullptr) {
      pending = input;
      continue;
    }
    const JsonPtr out = field(row, "out");
    if (out == nullptr || out->kind != JsonValue::Kind::Array) {
      continue;
    }
    if (pending == nullptr) {
      expect(false, "出力に対応する入力が無い");
      return;
    }
    const std::int64_t t = asInt(field(row, "t"));
    // 初期状態の時刻はトレースの最初の t と一致させる必要がある。
    if (!started) {
      state = wheso::shard::initial_state(t);
      started = true;
    }
    wheso::shard::Event event;
    if (!toShardEvent(pending, event)) {
      expect(false, "入力を解釈できない（行 " + std::to_string(index + 1) + "）");
      return;
    }
    pending = nullptr;
    const wheso::shard::StepResult result = wheso::shard::step(state, event, t);
    state = result.state;

    bool same = result.commands.size() == out->array.size();
    if (same) {
      for (std::size_t position = 0; position < result.commands.size(); position += 1) {
        const std::string actual = render(shardFields(result.commands[position]));
        const std::string wanted = render(expectedFields(out->array[position]));
        if (actual != wanted) {
          same = false;
          std::cout << "  行 " << (index + 1) << " の " << position << " 番目が不一致\n";
          std::cout << "    期待: " << wanted << "\n";
          std::cout << "    実際: " << actual << "\n";
          break;
        }
      }
    } else {
      std::cout << "  行 " << (index + 1) << " のコマンド数が不一致（期待 " << out->array.size()
                << " / 実際 " << result.commands.size() << "）\n";
    }
    expect(same, "中継トレース 行 " + std::to_string(index + 1));
    checkedRows += 1;
  }
  expect(checkedRows > 100, "中継トレースを十分な行数照合した");
}

void testReceiverTrace(const std::string& dir) {
  const std::vector<std::string> lines = readLines(dir + "/trace-receiver.jsonl");
  expect(lines.size() > 100, "受信トレースが十分な行数を持つ");
  if (lines.empty()) {
    return;
  }
  const JsonPtr header = parseLine(lines[0]);
  expect(wheso::testing::asText(field(header, "unit")) == "receiver", "受信ノードのトレースである");

  wheso::receiver::State state = wheso::receiver::initial_state(INITIAL_RECEIVER_BUDGET);
  JsonPtr pending = nullptr;
  int checkedRows = 0;

  for (std::size_t index = 1; index < lines.size(); index += 1) {
    const JsonPtr row = parseLine(lines[index]);
    const JsonPtr input = field(row, "in");
    if (input != nullptr) {
      pending = input;
      continue;
    }
    const JsonPtr out = field(row, "out");
    if (out == nullptr || out->kind != JsonValue::Kind::Array) {
      continue;
    }
    if (pending == nullptr) {
      expect(false, "出力に対応する入力が無い");
      return;
    }
    wheso::receiver::Event event;
    if (!toReceiverEvent(pending, event)) {
      expect(false, "入力を解釈できない（行 " + std::to_string(index + 1) + "）");
      return;
    }
    pending = nullptr;
    const wheso::receiver::StepResult result = wheso::receiver::step(state, event);
    state = result.state;

    bool same = result.commands.size() == out->array.size();
    if (same) {
      for (std::size_t position = 0; position < result.commands.size(); position += 1) {
        const std::string actual = render(receiverFields(result.commands[position]));
        const std::string wanted = render(expectedFields(out->array[position]));
        if (actual != wanted) {
          same = false;
          std::cout << "  行 " << (index + 1) << " の " << position << " 番目が不一致\n";
          std::cout << "    期待: " << wanted << "\n";
          std::cout << "    実際: " << actual << "\n";
          break;
        }
      }
    } else {
      std::cout << "  行 " << (index + 1) << " のコマンド数が不一致（期待 " << out->array.size()
                << " / 実際 " << result.commands.size() << "）\n";
    }
    expect(same, "受信トレース 行 " + std::to_string(index + 1));
    checkedRows += 1;
  }
  expect(checkedRows > 100, "受信トレースを十分な行数照合した");
}

}  // namespace

int main(int argc, char** argv) {
  std::string dir = "spec/vectors";
  if (argc > 1) {
    dir = argv[1];
  }
  testShardTrace(dir);
  testReceiverTrace(dir);
  std::cout << "検査 " << checks << " 件、失敗 " << failures << " 件\n";
  if (failures > 0) {
    return 1;
  }
  if (checks < 200) {
    std::cout << "FAIL 検査の件数が少なすぎる（試験が動いていない可能性）\n";
    return 1;
  }
  std::cout << "OK: C++ の判断コアが凍結トレースと一致する\n";
  return 0;
}
