// このファイルは自動生成されている。手で編集してはならない。
//
// 生成元: プロトコルのスキーマ定義
// 再生成: 内部検証スクリプトを実行する
#pragma once
#include <cstdint>
#include <string_view>

namespace wheso::wire_layout {

inline constexpr std::uint8_t PROTOCOL_VERSION = 1;
inline constexpr std::uint8_t WIRE_MAGIC = 161;
inline constexpr std::size_t MESSAGE_HEADER_BYTES = 8;
inline constexpr std::size_t UNIT_HEADER_BYTES = 20;
inline constexpr std::size_t MAX_UNITS_PER_MESSAGE = 255;
inline constexpr std::size_t MAX_MESSAGE_BYTES = 16000000;
inline constexpr std::uint8_t MAX_SPATIAL_ID = 3;
inline constexpr std::uint8_t MAX_TEMPORAL_ID = 7;

inline constexpr std::uint8_t CHANNEL_VIDEO = 1;
inline constexpr std::uint8_t CHANNEL_AUDIO = 2;
inline constexpr std::uint8_t CHANNEL_SCREEN_VIDEO = 3;
inline constexpr std::uint8_t CHANNEL_SCREEN_AUDIO = 4;

inline constexpr std::uint8_t FLAG_KEY = 1;
inline constexpr std::uint8_t FLAG_DISCARDABLE = 2;
inline constexpr std::uint8_t FLAG_DTX = 4;
inline constexpr std::uint8_t FLAG_END_OF_FRAME = 8;
inline constexpr std::uint8_t FLAG_SCREEN_CONTENT = 16;
inline constexpr std::uint8_t FLAG_ACTIVE_SPEAKER = 32;

}  // namespace wheso::wire_layout
