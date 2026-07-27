// ワイヤフォーマットの実装（C++、ヘッダのみ）。
//
// 規範: wire-format.md 1 節（バイト配置）と 1.4（破棄優先順位）。
// TypeScript の参照実装とバイト単位で一致しなければならない（conformance.md 2 節の層 1）。
//
// 例外を投げない。範囲外の添字アクセスをしない。
#pragma once

#include <cstdint>
#include <optional>
#include <string_view>
#include <vector>

#include "generated/wire_layout.hpp"

namespace wheso {

enum class WireError {
  Magic,
  Version,
  Channel,
  UnitCount,
  SenderId,
  LengthMismatch,
  PayloadEmpty,
  TooLarge,
  UnitOrder,
  FieldRange,
};

/// 規範のエラー名。TypeScript 側の文字列と一致させる。
inline std::string_view wire_error_name(WireError error) {
  switch (error) {
    case WireError::Magic:
      return "E_WIRE_MAGIC";
    case WireError::Version:
      return "E_WIRE_VERSION";
    case WireError::Channel:
      return "E_WIRE_CHANNEL";
    case WireError::UnitCount:
      return "E_WIRE_UNIT_COUNT";
    case WireError::SenderId:
      return "E_WIRE_SENDER_ID";
    case WireError::LengthMismatch:
      return "E_WIRE_LENGTH_MISMATCH";
    case WireError::PayloadEmpty:
      return "E_WIRE_PAYLOAD_EMPTY";
    case WireError::TooLarge:
      return "E_WIRE_TOO_LARGE";
    case WireError::UnitOrder:
      return "E_WIRE_UNIT_ORDER";
    case WireError::FieldRange:
      return "E_WIRE_FIELD_RANGE";
  }
  return "E_WIRE_MAGIC";
}

struct Unit {
  std::uint32_t sequence_number;
  std::uint64_t capture_timestamp_us;
  std::uint8_t flags;
  std::uint8_t spatial_id;
  std::uint8_t temporal_id;
  std::vector<std::uint8_t> payload;
};

struct MediaMessage {
  std::uint8_t channel;
  std::uint32_t sender_id;
  std::vector<Unit> units;
};

template <typename T>
struct WireResult {
  bool ok;
  T value;
  WireError error;

  static WireResult success(T v) { return WireResult{true, std::move(v), WireError::Magic}; }
  static WireResult failure(WireError e) { return WireResult{false, T{}, e}; }
};

inline bool is_audio_channel(std::uint8_t channel) {
  return channel == wire_layout::CHANNEL_AUDIO || channel == wire_layout::CHANNEL_SCREEN_AUDIO;
}

inline bool known_channel(std::uint8_t channel) { return channel >= 1 && channel <= 4; }

inline void push_be32(std::vector<std::uint8_t>& out, std::uint32_t value) {
  out.push_back(static_cast<std::uint8_t>((value >> 24) & 0xFF));
  out.push_back(static_cast<std::uint8_t>((value >> 16) & 0xFF));
  out.push_back(static_cast<std::uint8_t>((value >> 8) & 0xFF));
  out.push_back(static_cast<std::uint8_t>(value & 0xFF));
}

inline void push_be64(std::vector<std::uint8_t>& out, std::uint64_t value) {
  for (int shift = 56; shift >= 0; shift -= 8) {
    out.push_back(static_cast<std::uint8_t>((value >> shift) & 0xFF));
  }
}

inline std::optional<std::uint32_t> read_be32(const std::vector<std::uint8_t>& bytes, std::size_t offset) {
  if (offset + 4 > bytes.size()) {
    return std::nullopt;
  }
  std::uint32_t value = 0;
  for (std::size_t index = 0; index < 4; index += 1) {
    value = (value << 8) | bytes[offset + index];
  }
  return value;
}

inline std::optional<std::uint64_t> read_be64(const std::vector<std::uint8_t>& bytes, std::size_t offset) {
  if (offset + 8 > bytes.size()) {
    return std::nullopt;
  }
  std::uint64_t value = 0;
  for (std::size_t index = 0; index < 8; index += 1) {
    value = (value << 8) | bytes[offset + index];
  }
  return value;
}

/// メディアメッセージを符号化する。
inline WireResult<std::vector<std::uint8_t>> encode_media_message(const MediaMessage& message) {
  using Out = WireResult<std::vector<std::uint8_t>>;
  if (!known_channel(message.channel)) {
    return Out::failure(WireError::Channel);
  }
  if (message.sender_id == 0) {
    return Out::failure(WireError::SenderId);
  }
  if (message.units.empty() || message.units.size() > wire_layout::MAX_UNITS_PER_MESSAGE) {
    return Out::failure(WireError::UnitCount);
  }
  // 映像は常に 1 ユニットである（wire-format.md 1.5）。
  if (!is_audio_channel(message.channel) && message.units.size() != 1) {
    return Out::failure(WireError::UnitCount);
  }

  std::size_t total = wire_layout::MESSAGE_HEADER_BYTES;
  std::optional<std::uint32_t> previous;
  for (const Unit& unit : message.units) {
    if (unit.payload.empty()) {
      return Out::failure(WireError::PayloadEmpty);
    }
    if (unit.spatial_id > 3 || unit.temporal_id > 7) {
      return Out::failure(WireError::FieldRange);
    }
    if (previous.has_value() && unit.sequence_number <= previous.value()) {
      return Out::failure(WireError::UnitOrder);
    }
    previous = unit.sequence_number;
    total += wire_layout::UNIT_HEADER_BYTES + unit.payload.size();
  }
  if (total > wire_layout::MAX_MESSAGE_BYTES) {
    return Out::failure(WireError::TooLarge);
  }

  std::vector<std::uint8_t> bytes;
  bytes.reserve(total);
  bytes.push_back(wire_layout::WIRE_MAGIC);
  bytes.push_back(wire_layout::PROTOCOL_VERSION);
  bytes.push_back(message.channel);
  bytes.push_back(static_cast<std::uint8_t>(message.units.size()));
  push_be32(bytes, message.sender_id);
  for (const Unit& unit : message.units) {
    push_be32(bytes, unit.sequence_number);
    push_be64(bytes, unit.capture_timestamp_us);
    bytes.push_back(unit.flags);
    bytes.push_back(unit.spatial_id);
    bytes.push_back(unit.temporal_id);
    bytes.push_back(0);  // reserved
    push_be32(bytes, static_cast<std::uint32_t>(unit.payload.size()));
    bytes.insert(bytes.end(), unit.payload.begin(), unit.payload.end());
  }
  return Out::success(std::move(bytes));
}

/// メディアメッセージを復号する。
inline WireResult<MediaMessage> decode_media_message(const std::vector<std::uint8_t>& bytes) {
  using Out = WireResult<MediaMessage>;
  if (bytes.size() < wire_layout::MESSAGE_HEADER_BYTES) {
    return Out::failure(WireError::LengthMismatch);
  }
  if (bytes[0] != wire_layout::WIRE_MAGIC) {
    return Out::failure(WireError::Magic);
  }
  if (bytes[1] != wire_layout::PROTOCOL_VERSION) {
    return Out::failure(WireError::Version);
  }
  const std::uint8_t channel = bytes[2];
  if (!known_channel(channel)) {
    return Out::failure(WireError::Channel);
  }
  const std::uint8_t unit_count = bytes[3];
  if (unit_count == 0) {
    return Out::failure(WireError::UnitCount);
  }
  if (!is_audio_channel(channel) && unit_count != 1) {
    return Out::failure(WireError::UnitCount);
  }
  const auto sender_id = read_be32(bytes, 4);
  if (!sender_id.has_value()) {
    return Out::failure(WireError::LengthMismatch);
  }
  if (sender_id.value() == 0) {
    return Out::failure(WireError::SenderId);
  }

  MediaMessage message;
  message.channel = channel;
  message.sender_id = sender_id.value();
  std::size_t offset = wire_layout::MESSAGE_HEADER_BYTES;
  std::optional<std::uint32_t> previous;
  for (std::uint8_t index = 0; index < unit_count; index += 1) {
    if (offset + wire_layout::UNIT_HEADER_BYTES > bytes.size()) {
      return Out::failure(WireError::LengthMismatch);
    }
    const auto sequence_number = read_be32(bytes, offset);
    const auto timestamp = read_be64(bytes, offset + 4);
    if (!sequence_number.has_value() || !timestamp.has_value()) {
      return Out::failure(WireError::LengthMismatch);
    }
    const std::uint8_t flags = bytes[offset + 12];
    const std::uint8_t spatial_id = bytes[offset + 13];
    const std::uint8_t temporal_id = bytes[offset + 14];
    if (spatial_id > 3 || temporal_id > 7) {
      return Out::failure(WireError::FieldRange);
    }
    const auto payload_length = read_be32(bytes, offset + 16);
    if (!payload_length.has_value()) {
      return Out::failure(WireError::LengthMismatch);
    }
    if (payload_length.value() == 0) {
      return Out::failure(WireError::PayloadEmpty);
    }
    const std::size_t payload_start = offset + wire_layout::UNIT_HEADER_BYTES;
    const std::size_t payload_end = payload_start + payload_length.value();
    if (payload_end > bytes.size()) {
      return Out::failure(WireError::LengthMismatch);
    }
    if (previous.has_value() && sequence_number.value() <= previous.value()) {
      return Out::failure(WireError::UnitOrder);
    }
    previous = sequence_number.value();
    Unit unit;
    unit.sequence_number = sequence_number.value();
    unit.capture_timestamp_us = timestamp.value();
    unit.flags = flags;
    unit.spatial_id = spatial_id;
    unit.temporal_id = temporal_id;
    unit.payload.assign(bytes.begin() + static_cast<std::ptrdiff_t>(payload_start),
                        bytes.begin() + static_cast<std::ptrdiff_t>(payload_end));
    message.units.push_back(std::move(unit));
    offset = payload_end;
  }
  if (offset != bytes.size()) {
    return Out::failure(WireError::LengthMismatch);
  }
  return Out::success(std::move(message));
}

/// 破棄優先順位。wire-format.md 1.4 の判定順序をそのまま実装する。
/// 空の optional は破棄禁止を意味する。
inline std::optional<std::uint8_t> drop_priority(std::uint8_t channel, std::uint8_t flags) {
  if (is_audio_channel(channel)) {
    return std::nullopt;
  }
  if ((flags & wire_layout::FLAG_KEY) != 0) {
    return std::nullopt;
  }
  const bool discardable = (flags & wire_layout::FLAG_DISCARDABLE) != 0;
  const bool screen = (flags & wire_layout::FLAG_SCREEN_CONTENT) != 0;
  const bool speaker = (flags & wire_layout::FLAG_ACTIVE_SPEAKER) != 0;
  if (discardable && screen) {
    return static_cast<std::uint8_t>(3);
  }
  if (discardable && speaker) {
    return static_cast<std::uint8_t>(2);
  }
  if (discardable) {
    return static_cast<std::uint8_t>(1);
  }
  if (speaker) {
    return static_cast<std::uint8_t>(5);
  }
  return static_cast<std::uint8_t>(4);
}

/// DISCARDABLE の算出。独自判断を書かず規範の規則をそのまま実装する。
inline bool compute_discardable(std::uint8_t channel, bool is_key_frame, std::uint8_t temporal_id,
                                std::uint8_t temporal_layer_count) {
  if (is_audio_channel(channel)) {
    return false;
  }
  if (is_key_frame) {
    return false;
  }
  if (temporal_layer_count <= 1) {
    return false;
  }
  return temporal_id == temporal_layer_count - 1;
}

}  // namespace wheso
