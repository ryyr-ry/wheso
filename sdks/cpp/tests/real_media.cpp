// 実音声映像の照合（C++、段 A の実データ版）。
//
// 合成したベクタではなく、**実際に符号化された AV1 と Opus**（spec/vectors/real-media.json）に
// 対して、ワイヤ形式の符号化・復号が往復で一致し、破棄可否と破棄優先順位の判断が
// 凍結資産と一致することを確かめる。同じ資産を 6 言語すべてが照合する。
//
// 資産を実装に合わせて変更してはならない（ADR-0012）。

#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

#include "../include/wheso/wire.hpp"
#include "json.hpp"

using wheso::testing::asInt;
using wheso::testing::asText;
using wheso::testing::bytesToHex;
using wheso::testing::field;
using wheso::testing::hexToBytes;
using wheso::testing::JsonPtr;
using wheso::testing::JsonValue;
using wheso::testing::readJsonFile;

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

bool asBool(const JsonPtr& value) {
  return value != nullptr && value->kind == JsonValue::Kind::Bool && value->boolean;
}

void testVideo(const JsonPtr& asset) {
  const std::int64_t sender_id = asInt(field(asset, "senderId"));
  const JsonPtr video = field(asset, "video");
  expect(video != nullptr, "video がある");
  if (video == nullptr) {
    return;
  }
  const std::int64_t framerate = asInt(field(video, "framerate"));
  const std::int64_t channel = asInt(field(video, "channel"));
  const std::int64_t temporal_layers = asInt(field(video, "temporalLayers"));
  const JsonPtr frames = field(video, "frames");
  expect(frames != nullptr && frames->kind == JsonValue::Kind::Array, "frames がある");
  if (frames == nullptr) {
    return;
  }
  expect(frames->array.size() >= 30, "映像が 30 枚以上ある");

  int discardable_count = 0;
  int checked = 0;
  for (const JsonPtr& frame : frames->array) {
    const std::int64_t sequence_number = asInt(field(frame, "sequenceNumber"));
    const std::string payload_hex = asText(field(frame, "payloadHex"));
    const std::uint8_t flags = static_cast<std::uint8_t>(asInt(field(frame, "expectedFlags")));

    wheso::Unit unit{};
    unit.sequence_number = static_cast<std::uint32_t>(sequence_number);
    unit.capture_timestamp_us =
        static_cast<std::uint64_t>((sequence_number - 1) * 1000000 / framerate);
    unit.flags = flags;
    unit.spatial_id = static_cast<std::uint8_t>(asInt(field(frame, "spatialId")));
    unit.temporal_id = static_cast<std::uint8_t>(asInt(field(frame, "temporalId")));
    unit.payload = hexToBytes(payload_hex);

    wheso::MediaMessage message{};
    message.channel = static_cast<std::uint8_t>(channel);
    message.sender_id = static_cast<std::uint32_t>(sender_id);
    message.units.push_back(unit);

    const auto encoded = wheso::encode_media_message(message);
    expect(encoded.ok, "映像を符号化できる");
    if (!encoded.ok) {
      return;
    }
    expect(bytesToHex(encoded.value) == asText(field(frame, "expectedMessageHex")),
           "映像のバイト列が資産と一致する");

    const auto decoded = wheso::decode_media_message(encoded.value);
    expect(decoded.ok, "映像を復号できる");
    if (!decoded.ok) {
      return;
    }
    expect(!decoded.value.units.empty() && bytesToHex(decoded.value.units[0].payload) == payload_hex,
           "ペイロードが往復する");

    const bool discardable = wheso::compute_discardable(
        static_cast<std::uint8_t>(channel), asBool(field(frame, "keyFrame")),
        static_cast<std::uint8_t>(asInt(field(frame, "temporalId"))),
        static_cast<std::uint8_t>(temporal_layers));
    expect(discardable == asBool(field(frame, "expectedDiscardable")), "破棄可否が資産と一致する");
    if (discardable) {
      discardable_count += 1;
    }

    const auto priority = wheso::drop_priority(static_cast<std::uint8_t>(channel), flags);
    const JsonPtr expected = field(frame, "expectedDropPriority");
    if (expected == nullptr || expected->kind == JsonValue::Kind::Null) {
      expect(!priority.has_value(), "破棄禁止が一致する");
    } else {
      expect(priority.has_value() &&
                 static_cast<std::int64_t>(priority.value()) == asInt(expected),
             "優先順位が一致する");
    }
    checked += 1;
  }
  expect(checked >= 30, "映像を 30 枚以上照合した");
  // 最上位の時間層は破棄可能である。1 枚も無ければ判断を検証していない。
  expect(discardable_count > 0, "破棄可能なフレームがある");
}

void testAudio(const JsonPtr& asset) {
  const std::int64_t sender_id = asInt(field(asset, "senderId"));
  const JsonPtr audio = field(asset, "audio");
  expect(audio != nullptr, "audio がある");
  if (audio == nullptr) {
    return;
  }
  const std::int64_t frame_ms = asInt(field(audio, "frameMs"));
  const std::int64_t units_per_message = asInt(field(audio, "unitsPerMessage"));
  const std::int64_t channel = asInt(field(audio, "channel"));
  const JsonPtr bundles = field(audio, "bundles");
  expect(bundles != nullptr && bundles->kind == JsonValue::Kind::Array, "bundles がある");
  if (bundles == nullptr) {
    return;
  }
  expect(bundles->array.size() >= 20, "音声束が 20 個以上ある");

  int checked = 0;
  for (std::size_t index = 0; index < bundles->array.size(); index += 1) {
    const JsonPtr& bundle = bundles->array[index];
    const JsonPtr payloads = field(bundle, "payloadsHex");
    expect(payloads != nullptr && payloads->kind == JsonValue::Kind::Array, "payloadsHex がある");
    if (payloads == nullptr) {
      return;
    }
    expect(static_cast<std::int64_t>(payloads->array.size()) == units_per_message,
           "束ねる数が規範どおりである");
    const std::int64_t first_sequence = asInt(field(bundle, "firstSequenceNumber"));
    const std::uint8_t flags = static_cast<std::uint8_t>(asInt(field(bundle, "expectedFlags")));

    wheso::MediaMessage message{};
    message.channel = static_cast<std::uint8_t>(channel);
    message.sender_id = static_cast<std::uint32_t>(sender_id);
    for (std::size_t offset = 0; offset < payloads->array.size(); offset += 1) {
      const std::int64_t position =
          static_cast<std::int64_t>(index) * units_per_message + static_cast<std::int64_t>(offset);
      wheso::Unit unit{};
      unit.sequence_number =
          static_cast<std::uint32_t>(first_sequence + static_cast<std::int64_t>(offset));
      unit.capture_timestamp_us = static_cast<std::uint64_t>(position * frame_ms * 1000);
      unit.flags = flags;
      unit.spatial_id = 0;
      unit.temporal_id = 0;
      unit.payload = hexToBytes(asText(payloads->array[offset]));
      message.units.push_back(unit);
    }

    const auto encoded = wheso::encode_media_message(message);
    expect(encoded.ok, "音声束を符号化できる");
    if (!encoded.ok) {
      return;
    }
    expect(bytesToHex(encoded.value) == asText(field(bundle, "expectedMessageHex")),
           "音声束のバイト列が資産と一致する");

    const auto decoded = wheso::decode_media_message(encoded.value);
    expect(decoded.ok, "音声束を復号できる");
    if (!decoded.ok) {
      return;
    }
    expect(static_cast<std::int64_t>(decoded.value.units.size()) == units_per_message,
           "ユニット数が往復する");

    // 音声は決して破棄しない（規範）。
    expect(!wheso::drop_priority(static_cast<std::uint8_t>(channel), flags).has_value(),
           "音声は破棄禁止である");
    expect(!wheso::compute_discardable(static_cast<std::uint8_t>(channel), false, 0, 1),
           "音声は破棄可能にならない");
    checked += 1;
  }
  expect(checked >= 20, "音声束を 20 個以上照合した");
}

}  // namespace

int main(int argc, char** argv) {
  std::string dir = "spec/vectors";
  if (argc > 1) {
    dir = argv[1];
  }
  const JsonPtr asset = readJsonFile(dir + "/real-media.json");
  if (asset == nullptr) {
    std::cout << "FAIL 資産を開けない: " << dir << "/real-media.json\n";
    return 1;
  }
  testVideo(asset);
  testAudio(asset);
  std::cout << "検査 " << checks << " 件、失敗 " << failures << " 件\n";
  if (failures > 0) {
    return 1;
  }
  if (checks < 100) {
    std::cout << "FAIL 検査の件数が少なすぎる（試験が動いていない可能性）\n";
    return 1;
  }
  std::cout << "OK: C++ が実 AV1 / Opus の凍結資産と一致する\n";
  return 0;
}
