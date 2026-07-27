// このファイルは自動生成されている。手で編集してはならない。
//
// 生成元: プロトコルのスキーマ定義
// 再生成: 内部検証スクリプトを実行する
#pragma once
#include <cstdint>
#include <string_view>

namespace wheso::constants {

// nodeCapacity
inline constexpr std::int64_t NODE_MAX_OUT_MESSAGES_PER_SEC = 20000;
inline constexpr std::int64_t NODE_MAX_OUT_BYTES_PER_SEC = 280000000;
inline constexpr std::int64_t NODE_MAX_IN_MESSAGES_PER_SEC = 20000;

// videoProfiles
inline constexpr std::int64_t V_4K60_SPATIAL_ID = 3;
inline constexpr std::int64_t V_4K60_WIDTH = 3840;
inline constexpr std::int64_t V_4K60_HEIGHT = 2160;
inline constexpr std::int64_t V_4K60_FRAMERATE = 60;
inline constexpr std::int64_t V_4K60_TARGET_BITRATE = 25000000;
inline constexpr std::string_view V_4K60_SCALABILITY_MODE = "L1T3";
inline constexpr std::int64_t V_4K60_TEMPORAL_LAYERS = 3;
inline constexpr bool V_4K60_REQUIRES_HARDWARE_ENCODER = true;
inline constexpr std::int64_t V_1080P60_SPATIAL_ID = 2;
inline constexpr std::int64_t V_1080P60_WIDTH = 1920;
inline constexpr std::int64_t V_1080P60_HEIGHT = 1080;
inline constexpr std::int64_t V_1080P60_FRAMERATE = 60;
inline constexpr std::int64_t V_1080P60_TARGET_BITRATE = 6000000;
inline constexpr std::string_view V_1080P60_SCALABILITY_MODE = "L1T3";
inline constexpr std::int64_t V_1080P60_TEMPORAL_LAYERS = 3;
inline constexpr bool V_1080P60_REQUIRES_HARDWARE_ENCODER = false;
inline constexpr std::int64_t V_1080P30_SPATIAL_ID = 1;
inline constexpr std::int64_t V_1080P30_WIDTH = 1920;
inline constexpr std::int64_t V_1080P30_HEIGHT = 1080;
inline constexpr std::int64_t V_1080P30_FRAMERATE = 30;
inline constexpr std::int64_t V_1080P30_TARGET_BITRATE = 3000000;
inline constexpr std::string_view V_1080P30_SCALABILITY_MODE = "L1T3";
inline constexpr std::int64_t V_1080P30_TEMPORAL_LAYERS = 3;
inline constexpr bool V_1080P30_REQUIRES_HARDWARE_ENCODER = false;
inline constexpr std::int64_t V_360P15_SPATIAL_ID = 0;
inline constexpr std::int64_t V_360P15_WIDTH = 640;
inline constexpr std::int64_t V_360P15_HEIGHT = 360;
inline constexpr std::int64_t V_360P15_FRAMERATE = 15;
inline constexpr std::int64_t V_360P15_TARGET_BITRATE = 200000;
inline constexpr std::string_view V_360P15_SCALABILITY_MODE = "L1T2";
inline constexpr std::int64_t V_360P15_TEMPORAL_LAYERS = 2;
inline constexpr bool V_360P15_REQUIRES_HARDWARE_ENCODER = false;
inline constexpr std::int64_t V_SCREEN_4K30_SPATIAL_ID = 3;
inline constexpr std::int64_t V_SCREEN_4K30_WIDTH = 3840;
inline constexpr std::int64_t V_SCREEN_4K30_HEIGHT = 2160;
inline constexpr std::int64_t V_SCREEN_4K30_FRAMERATE = 30;
inline constexpr std::int64_t V_SCREEN_4K30_TARGET_BITRATE = 8000000;
inline constexpr std::string_view V_SCREEN_4K30_SCALABILITY_MODE = "L1T2";
inline constexpr std::int64_t V_SCREEN_4K30_TEMPORAL_LAYERS = 2;
inline constexpr std::string_view V_SCREEN_4K30_CONTENT_HINT = "text";
inline constexpr bool V_SCREEN_4K30_REQUIRES_HARDWARE_ENCODER = false;
inline constexpr std::int64_t V_SCREEN_1080P30_SPATIAL_ID = 1;
inline constexpr std::int64_t V_SCREEN_1080P30_WIDTH = 1920;
inline constexpr std::int64_t V_SCREEN_1080P30_HEIGHT = 1080;
inline constexpr std::int64_t V_SCREEN_1080P30_FRAMERATE = 30;
inline constexpr std::int64_t V_SCREEN_1080P30_TARGET_BITRATE = 2000000;
inline constexpr std::string_view V_SCREEN_1080P30_SCALABILITY_MODE = "L1T2";
inline constexpr std::int64_t V_SCREEN_1080P30_TEMPORAL_LAYERS = 2;
inline constexpr std::string_view V_SCREEN_1080P30_CONTENT_HINT = "text";
inline constexpr bool V_SCREEN_1080P30_REQUIRES_HARDWARE_ENCODER = false;

// audioProfiles
inline constexpr std::int64_t A_VOICE_BITRATE = 32000;
inline constexpr std::int64_t A_VOICE_CHANNELS = 1;
inline constexpr std::int64_t A_VOICE_BYTES_PER_PACKET = 80;
inline constexpr std::int64_t A_MUSIC_BITRATE = 128000;
inline constexpr std::int64_t A_MUSIC_CHANNELS = 2;
inline constexpr std::int64_t A_MUSIC_BYTES_PER_PACKET = 320;

// audio
inline constexpr std::int64_t OPUS_FRAME_MS = 20;
inline constexpr std::int64_t AUDIO_BUNDLE_MS = 40;
inline constexpr std::int64_t AUDIO_UNITS_PER_MESSAGE = 2;
inline constexpr std::int64_t AUDIO_SELECTIVE_FORWARD_COUNT = 5;
inline constexpr std::int64_t AUDIO_SPEAKER_HOLD_MS = 800;
inline constexpr bool AUDIO_DTX_ENABLED = true;
inline constexpr bool AUDIO_FEC_ENABLED = true;

// shardCapacity
inline constexpr std::int64_t V_SHARD_MAX_PARTICIPANTS = 35;
inline constexpr std::int64_t A_SHARD_MAX_PARTICIPANTS = 160;
inline constexpr std::int64_t V_FULL_MESH_MAX_4K60 = 9;
inline constexpr std::int64_t V_FULL_MESH_MAX_1080P60 = 18;
inline constexpr std::int64_t V_FULL_MESH_MAX_1080P30 = 26;
inline constexpr std::int64_t V_FULL_MESH_MAX_360P15 = 37;

// congestion
inline constexpr std::int64_t REPORT_INTERVAL_MS = 200;
inline constexpr std::int64_t DELAY_TREND_WINDOW = 20;
inline constexpr double DELAY_TREND_DEGRADE = 0.01;
inline constexpr double DELAY_TREND_RECOVER = -0.005;
inline constexpr std::int64_t KEYFRAME_REQUEST_MIN_INTERVAL_MS = 500;
inline constexpr std::int64_t AUDIO_STALL_RESET_MS = 500;
inline constexpr std::int64_t VIDEO_STALL_RESET_MS = 1500;
inline constexpr bool STANDBY_CONNECTION_ENABLED = true;
inline constexpr std::int64_t SHEDDING_HYSTERESIS_MS = 500;
inline constexpr std::int64_t SEND_WINDOW_MS = 200;
inline constexpr std::int64_t ACK_INTERVAL_MS = 50;
inline constexpr std::int64_t ACK_TIMEOUT_MS = 5000;
inline constexpr std::int64_t UPLINK_BACKLOG_BYTES = 100000;
inline constexpr std::int64_t RATE_HOLD_MS = 1000;
inline constexpr std::int64_t RATE_PROBE_BPS = 200000;
inline constexpr double RATE_DECREASE_FACTOR = 0.85;
inline constexpr std::int64_t LATE_FRAME_TOLERANCE_MS = 33;
inline constexpr std::int64_t MIN_VIABLE_BPS = 232000;
inline constexpr std::int64_t DELAY_TREND_DEGRADE_NUM = 1;
inline constexpr std::int64_t DELAY_TREND_DEGRADE_DEN = 100;
inline constexpr std::int64_t DELAY_TREND_RECOVER_NUM = -1;
inline constexpr std::int64_t DELAY_TREND_RECOVER_DEN = 200;

// jitterBuffer
inline constexpr std::int64_t VIDEO_JITTER_MIN_FRAMES = 2;
inline constexpr std::int64_t VIDEO_JITTER_MAX_FRAMES = 10;
inline constexpr std::int64_t AUDIO_JITTER_MIN_PACKETS = 2;
inline constexpr std::int64_t AUDIO_JITTER_MAX_PACKETS = 8;
inline constexpr std::int64_t AV_SKEW_TOLERANCE_MS = 20;
inline constexpr std::int64_t AV_SKEW_RESYNC_MS = 200;

// timeouts
inline constexpr std::int64_t NODE_CONNECT_TIMEOUT_MS = 5000;
inline constexpr std::int64_t HEARTBEAT_INTERVAL_MS = 3000;
inline constexpr std::int64_t HEARTBEAT_TIMEOUT_MS = 9000;
inline constexpr std::int64_t DUAL_SUBSCRIBE_TIMEOUT_MS = 2000;
inline constexpr std::int64_t STANDBY_SWAP_TIMEOUT_MS = 3000;
inline constexpr std::int64_t EPOCH_DUAL_SUBSCRIBE_TIMEOUT_MS = 2000;

// auth
inline constexpr std::int64_t TOKEN_MAX_AGE_SEC = 60;
inline constexpr std::int64_t TOKEN_CLOCK_SKEW_SEC = 5;
inline constexpr std::int64_t NODE_AUTH_TIME_WINDOW_SEC = 300;
inline constexpr std::int64_t MAX_CONNECT_ATTEMPTS_PER_MIN = 20;
inline constexpr std::int64_t MAX_INBOUND_MESSAGES_PER_SEC_PER_CLIENT = 400;

// naming
inline constexpr std::int64_t MAX_ROOM_NAME_LENGTH = 96;
inline constexpr std::int64_t FNV1A_OFFSET_BASIS = 2166136261;
inline constexpr std::int64_t FNV1A_PRIME = 16777619;
inline constexpr std::int64_t FMIX32_C1 = 2246822507;
inline constexpr std::int64_t FMIX32_C2 = 3266489909;

// slo
inline constexpr double STALL_RATIO_P95 = 0.005;
inline constexpr double AUDIO_GAP_RATIO_P95 = 0.001;
inline constexpr std::int64_t AV_SKEW_MS_P99 = 80;
inline constexpr std::int64_t KEYFRAME_REQUEST_RATE_P95 = 1;
inline constexpr std::int64_t GLASS_TO_GLASS_MS_P50 = 150;
inline constexpr double NODE_UTILIZATION_P95 = 0.8;

// conformance
inline constexpr std::int64_t TRACE_FORMAT_VERSION = 1;
inline constexpr std::int64_t FUZZ_STEPS_PER_RUN = 2000;
inline constexpr std::int64_t FUZZ_RUNS_PER_PULL_REQUEST = 20;
inline constexpr std::int64_t FUZZ_RUNS_NIGHTLY = 5000;
inline constexpr std::string_view PRNG_MULTIPLIER_SHIFTS = "13,7,17";

// display
inline constexpr std::int64_t DISPLAY_SIZE_UNSPECIFIED_SPATIAL_ID = 0;
inline constexpr std::int64_t DISPLAY_SIZE_REPORT_MIN_INTERVAL_MS = 200;

// lineBudget
inline constexpr std::int64_t LINE_BUDGET_TYPESCRIPT = 6;
inline constexpr std::int64_t LINE_BUDGET_FRAMEWORK = 6;
inline constexpr std::int64_t LINE_BUDGET_MOBILE = 10;
inline constexpr std::int64_t LINE_BUDGET_NATIVE = 10;

// shardCongestion
inline constexpr std::int64_t SHARD_UTIL_WINDOW_MS = 1000;
inline constexpr std::int64_t SHARD_UTIL_ENTER_T2_NUM = 9;
inline constexpr std::int64_t SHARD_UTIL_ENTER_T2_DEN = 10;
inline constexpr std::int64_t SHARD_UTIL_ENTER_T1_NUM = 1;
inline constexpr std::int64_t SHARD_UTIL_ENTER_T1_DEN = 1;
inline constexpr std::int64_t SHARD_UTIL_ENTER_SPATIAL_NUM = 11;
inline constexpr std::int64_t SHARD_UTIL_ENTER_SPATIAL_DEN = 10;
inline constexpr std::int64_t SHARD_UTIL_ENTER_KEY_ONLY_NUM = 6;
inline constexpr std::int64_t SHARD_UTIL_ENTER_KEY_ONLY_DEN = 5;
inline constexpr std::int64_t SHARD_UTIL_EXIT_T2_NUM = 4;
inline constexpr std::int64_t SHARD_UTIL_EXIT_T2_DEN = 5;
inline constexpr std::int64_t SHARD_UTIL_EXIT_T1_NUM = 17;
inline constexpr std::int64_t SHARD_UTIL_EXIT_T1_DEN = 20;
inline constexpr std::int64_t SHARD_UTIL_EXIT_SPATIAL_NUM = 9;
inline constexpr std::int64_t SHARD_UTIL_EXIT_SPATIAL_DEN = 10;
inline constexpr std::int64_t SHARD_UTIL_EXIT_KEY_ONLY_NUM = 1;
inline constexpr std::int64_t SHARD_UTIL_EXIT_KEY_ONLY_DEN = 1;
inline constexpr std::int64_t SHARD_TREND_ENTER_T2_NUM = 1;
inline constexpr std::int64_t SHARD_TREND_ENTER_T2_DEN = 100;
inline constexpr std::int64_t SHARD_TREND_ENTER_T1_NUM = 3;
inline constexpr std::int64_t SHARD_TREND_ENTER_T1_DEN = 100;
inline constexpr std::int64_t SHARD_TREND_ENTER_SPATIAL_NUM = 3;
inline constexpr std::int64_t SHARD_TREND_ENTER_SPATIAL_DEN = 50;
inline constexpr std::int64_t SHARD_TREND_ENTER_KEY_ONLY_NUM = 1;
inline constexpr std::int64_t SHARD_TREND_ENTER_KEY_ONLY_DEN = 10;
inline constexpr std::int64_t SHARD_TREND_EXIT_NUM = -1;
inline constexpr std::int64_t SHARD_TREND_EXIT_DEN = 200;
inline constexpr std::int64_t SHARD_TREND_EXIT_KEY_ONLY_NUM = 0;
inline constexpr std::int64_t SHARD_TREND_EXIT_KEY_ONLY_DEN = 1;

}  // namespace wheso::constants
