// このファイルは自動生成されている。手で編集してはならない。
//
// 生成元: エラーの機械可読定義
#pragma once

#include <cstdint>

namespace wheso::errors {
inline constexpr std::int64_t E_WIRE_MAGIC_CLOSE_CODE = 4001;
inline constexpr std::int64_t E_WIRE_VERSION_CLOSE_CODE = 4002;
inline constexpr std::int64_t E_WIRE_LENGTH_MISMATCH_CLOSE_CODE = 4003;
inline constexpr std::int64_t E_WIRE_UNIT_COUNT_CLOSE_CODE = 4004;
inline constexpr std::int64_t E_WIRE_SENDER_ID_CLOSE_CODE = 4005;
inline constexpr std::int64_t E_WIRE_PAYLOAD_EMPTY_CLOSE_CODE = 4006;
inline constexpr std::int64_t E_WIRE_UNIT_ORDER_CLOSE_CODE = 4007;
inline constexpr std::int64_t E_WIRE_TOO_LARGE_CLOSE_CODE = 4008;
inline constexpr std::int64_t E_WIRE_CHANNEL_CLOSE_CODE = 4003;
inline constexpr std::int64_t E_WIRE_FIELD_RANGE_CLOSE_CODE = 4003;
inline constexpr std::int64_t E_CTRL_VERSION_CLOSE_CODE = 4010;
inline constexpr std::int64_t E_CTRL_NO_HELLO_CLOSE_CODE = 4011;
inline constexpr std::int64_t E_CTRL_DUPLICATE_HELLO_CLOSE_CODE = 4012;
inline constexpr std::int64_t E_CTRL_SCHEMA_CLOSE_CODE = 4013;
inline constexpr std::int64_t E_AUTH_CLOSE_CODE = 4020;
inline constexpr std::int64_t E_AUTH_EXPIRED_CLOSE_CODE = 4021;
inline constexpr std::int64_t E_AUTH_AUDIENCE_CLOSE_CODE = 4022;
inline constexpr std::int64_t E_NODE_AUTH_CLOSE_CODE = 4023;
inline constexpr std::int64_t E_FORBIDDEN_CLOSE_CODE = 4024;
inline constexpr std::int64_t E_AUTH_ROOM_CLOSE_CODE = 4022;
inline constexpr std::int64_t E_AUTH_KIND_CLOSE_CODE = 4020;
inline constexpr std::int64_t E_RATE_LIMIT_MESSAGES_CLOSE_CODE = 4030;
inline constexpr std::int64_t E_RATE_LIMIT_CONNECT_CLOSE_CODE = 4031;
inline constexpr std::int64_t E_NODE_OVERLOADED_CLOSE_CODE = 4032;
inline constexpr std::int64_t E_ROOM_FULL_CLOSE_CODE = 4033;
inline constexpr std::int64_t E_ACK_TIMEOUT_CLOSE_CODE = 4034;
inline constexpr std::int64_t E_EPOCH_STALE_CLOSE_CODE = 4040;
inline constexpr std::int64_t E_MEETING_ENDED_CLOSE_CODE = 4041;
inline constexpr std::int64_t E_EVICTED_CLOSE_CODE = 4042;
inline constexpr std::int64_t E_MEETING_LOCKED_CLOSE_CODE = 4043;
inline constexpr std::int64_t E_NAME_MEETING_ID_CLOSE_CODE = 4050;
inline constexpr std::int64_t E_NAME_USER_ID_CLOSE_CODE = 4051;
inline constexpr std::int64_t E_NAME_REGION_CLOSE_CODE = 4052;
inline constexpr std::int64_t E_NAME_EPOCH_CLOSE_CODE = 4053;
inline constexpr std::int64_t E_NAME_SHARD_INDEX_CLOSE_CODE = 4054;
inline constexpr std::int64_t E_NAME_SHARD_COUNT_CLOSE_CODE = 4055;
inline constexpr std::int64_t E_NAME_TOO_LONG_CLOSE_CODE = 4056;

inline constexpr const char* W_DECODE_FAILED = "W_DECODE_FAILED";
inline constexpr const char* W_ENCODER_UNSUPPORTED = "W_ENCODER_UNSUPPORTED";
inline constexpr const char* W_NO_HARDWARE_ENCODER = "W_NO_HARDWARE_ENCODER";
inline constexpr const char* W_DEGRADED = "W_DEGRADED";
inline constexpr const char* W_STANDBY_SWAP = "W_STANDBY_SWAP";
inline constexpr const char* W_UNEXPECTED_EVENT = "W_UNEXPECTED_EVENT";
}  // namespace wheso::errors
