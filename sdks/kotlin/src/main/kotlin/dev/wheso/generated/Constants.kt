// このファイルは自動生成されている。手で編集してはならない。
//
// 生成元: プロトコルのスキーマ定義
// 再生成: 内部検証スクリプトを実行する
package dev.wheso.generated

// nodeCapacity
public val NODE_MAX_OUT_MESSAGES_PER_SEC: Long = 20000L
public val NODE_MAX_OUT_BYTES_PER_SEC: Long = 280000000L
public val NODE_MAX_IN_MESSAGES_PER_SEC: Long = 20000L

// videoProfiles
public val V_4K60_SPATIAL_ID: Long = 3L
public val V_4K60_WIDTH: Long = 3840L
public val V_4K60_HEIGHT: Long = 2160L
public val V_4K60_FRAMERATE: Long = 60L
public val V_4K60_TARGET_BITRATE: Long = 25000000L
public val V_4K60_SCALABILITY_MODE: String = "L1T3"
public val V_4K60_TEMPORAL_LAYERS: Long = 3L
public val V_4K60_REQUIRES_HARDWARE_ENCODER: Boolean = true
public val V_1080P60_SPATIAL_ID: Long = 2L
public val V_1080P60_WIDTH: Long = 1920L
public val V_1080P60_HEIGHT: Long = 1080L
public val V_1080P60_FRAMERATE: Long = 60L
public val V_1080P60_TARGET_BITRATE: Long = 6000000L
public val V_1080P60_SCALABILITY_MODE: String = "L1T3"
public val V_1080P60_TEMPORAL_LAYERS: Long = 3L
public val V_1080P60_REQUIRES_HARDWARE_ENCODER: Boolean = false
public val V_1080P30_SPATIAL_ID: Long = 1L
public val V_1080P30_WIDTH: Long = 1920L
public val V_1080P30_HEIGHT: Long = 1080L
public val V_1080P30_FRAMERATE: Long = 30L
public val V_1080P30_TARGET_BITRATE: Long = 3000000L
public val V_1080P30_SCALABILITY_MODE: String = "L1T3"
public val V_1080P30_TEMPORAL_LAYERS: Long = 3L
public val V_1080P30_REQUIRES_HARDWARE_ENCODER: Boolean = false
public val V_360P15_SPATIAL_ID: Long = 0L
public val V_360P15_WIDTH: Long = 640L
public val V_360P15_HEIGHT: Long = 360L
public val V_360P15_FRAMERATE: Long = 15L
public val V_360P15_TARGET_BITRATE: Long = 200000L
public val V_360P15_SCALABILITY_MODE: String = "L1T2"
public val V_360P15_TEMPORAL_LAYERS: Long = 2L
public val V_360P15_REQUIRES_HARDWARE_ENCODER: Boolean = false
public val V_SCREEN_4K30_SPATIAL_ID: Long = 3L
public val V_SCREEN_4K30_WIDTH: Long = 3840L
public val V_SCREEN_4K30_HEIGHT: Long = 2160L
public val V_SCREEN_4K30_FRAMERATE: Long = 30L
public val V_SCREEN_4K30_TARGET_BITRATE: Long = 8000000L
public val V_SCREEN_4K30_SCALABILITY_MODE: String = "L1T2"
public val V_SCREEN_4K30_TEMPORAL_LAYERS: Long = 2L
public val V_SCREEN_4K30_CONTENT_HINT: String = "text"
public val V_SCREEN_4K30_REQUIRES_HARDWARE_ENCODER: Boolean = false
public val V_SCREEN_1080P30_SPATIAL_ID: Long = 1L
public val V_SCREEN_1080P30_WIDTH: Long = 1920L
public val V_SCREEN_1080P30_HEIGHT: Long = 1080L
public val V_SCREEN_1080P30_FRAMERATE: Long = 30L
public val V_SCREEN_1080P30_TARGET_BITRATE: Long = 2000000L
public val V_SCREEN_1080P30_SCALABILITY_MODE: String = "L1T2"
public val V_SCREEN_1080P30_TEMPORAL_LAYERS: Long = 2L
public val V_SCREEN_1080P30_CONTENT_HINT: String = "text"
public val V_SCREEN_1080P30_REQUIRES_HARDWARE_ENCODER: Boolean = false

// audioProfiles
public val A_VOICE_BITRATE: Long = 32000L
public val A_VOICE_CHANNELS: Long = 1L
public val A_VOICE_BYTES_PER_PACKET: Long = 80L
public val A_MUSIC_BITRATE: Long = 128000L
public val A_MUSIC_CHANNELS: Long = 2L
public val A_MUSIC_BYTES_PER_PACKET: Long = 320L

// audio
public val OPUS_FRAME_MS: Long = 20L
public val AUDIO_BUNDLE_MS: Long = 40L
public val AUDIO_UNITS_PER_MESSAGE: Long = 2L
public val AUDIO_SELECTIVE_FORWARD_COUNT: Long = 5L
public val AUDIO_SPEAKER_HOLD_MS: Long = 800L
public val AUDIO_DTX_ENABLED: Boolean = true
public val AUDIO_FEC_ENABLED: Boolean = false

// shardCapacity
public val V_SHARD_MAX_PARTICIPANTS: Long = 35L
public val A_SHARD_MAX_PARTICIPANTS: Long = 160L
public val V_FULL_MESH_MAX_4K60: Long = 9L
public val V_FULL_MESH_MAX_1080P60: Long = 18L
public val V_FULL_MESH_MAX_1080P30: Long = 26L
public val V_FULL_MESH_MAX_360P15: Long = 37L

// congestion
public val REPORT_INTERVAL_MS: Long = 200L
public val DELAY_TREND_WINDOW: Long = 20L
public val DELAY_TREND_DEGRADE: Long = 5000L
public val DELAY_TREND_RECOVER: Long = 1500L
public val KEYFRAME_REQUEST_MIN_INTERVAL_MS: Long = 500L
public val AUDIO_STALL_RESET_MS: Long = 500L
public val VIDEO_STALL_RESET_MS: Long = 1500L
public val STANDBY_CONNECTION_ENABLED: Boolean = true
public val SHEDDING_HYSTERESIS_MS: Long = 500L
public val SEND_WINDOW_MS: Long = 200L
public val ACK_INTERVAL_MS: Long = 50L
public val ACK_TIMEOUT_MS: Long = 5000L
public val UPLINK_DEGRADE_STREAK: Long = 3L
public val UPLINK_RECOVER_MS: Long = 5000L
public val UPLINK_UPGRADE_HOLD_MS: Long = 10000L
public val ENCODE_QUEUE_LIMIT: Long = 3L
public val ENCODE_QUEUE_HOLD_MS: Long = 2000L
public val THERMAL_UPGRADE_HOLD_MS: Long = 30000L
public val UPLINK_BACKLOG_BYTES: Long = 100000L
public val RATE_HOLD_MS: Long = 1000L
public val RATE_PROBE_BPS: Long = 200000L
public val RATE_RECOVER_STREAK: Long = 3L
public val RATE_DECREASE_FACTOR: Double = 0.85
public val LATE_FRAME_TOLERANCE_MS: Long = 33L
public val MIN_VIABLE_BPS: Long = 244960L
public val AUDIO_ONLY_ENTER_BPS: Long = 244960L
public val AUDIO_ONLY_EXIT_BPS: Long = 448320L
public val AUDIO_SELECTIVE_MIN_COUNT: Long = 1L
public val DELAY_TREND_DEGRADE_NUM: Long = 5000L
public val DELAY_TREND_DEGRADE_DEN: Long = 1L
public val DELAY_TREND_RECOVER_NUM: Long = 1500L
public val DELAY_TREND_RECOVER_DEN: Long = 1L

// jitterBuffer
public val VIDEO_JITTER_MIN_FRAMES: Long = 2L
public val VIDEO_JITTER_MAX_FRAMES: Long = 10L
public val AUDIO_JITTER_MIN_PACKETS: Long = 2L
public val AUDIO_JITTER_MAX_PACKETS: Long = 8L
public val AV_SKEW_TOLERANCE_MS: Long = 20L
public val AV_SKEW_AUDIO_LEAD_MAX_MS: Long = 22L
public val AV_SKEW_AUDIO_LAG_MAX_MS: Long = 30L
public val AV_DRIFT_STEP_US: Long = 20L
public val AV_RESYNC_GAP_MS: Long = 1000L

// timeouts
public val NODE_CONNECT_TIMEOUT_MS: Long = 5000L
public val RECONNECT_BACKOFF_MS: List<Long> = listOf(500L, 1000L, 2000L, 5000L)
public val HEARTBEAT_INTERVAL_MS: Long = 3000L
public val HEARTBEAT_TIMEOUT_MS: Long = 9000L
public val DUAL_SUBSCRIBE_TIMEOUT_MS: Long = 2000L
public val STANDBY_SWAP_TIMEOUT_MS: Long = 3000L
public val EPOCH_DUAL_SUBSCRIBE_TIMEOUT_MS: Long = 2000L

// auth
public val TOKEN_MAX_AGE_SEC: Long = 60L
public val TOKEN_CLOCK_SKEW_SEC: Long = 5L
public val NODE_AUTH_TIME_WINDOW_SEC: Long = 300L
public val MAX_CONNECT_ATTEMPTS_PER_MIN: Long = 20L
public val MAX_INBOUND_MESSAGES_PER_SEC_PER_CLIENT: Long = 400L

// naming
public val MAX_ROOM_NAME_LENGTH: Long = 96L
public val FNV1A_OFFSET_BASIS: Long = 2166136261L
public val FNV1A_PRIME: Long = 16777619L
public val FMIX32_C1: Long = 2246822507L
public val FMIX32_C2: Long = 3266489909L

// slo
public val STALL_RATIO_P95: Double = 0.005
public val AUDIO_GAP_RATIO_P95: Double = 0.001
public val AV_SKEW_MS_P99: Long = 30L
public val KEYFRAME_REQUEST_RATE_P95: Long = 1L
public val GLASS_TO_GLASS_MS_P50: Long = 150L
public val NODE_UTILIZATION_P95: Double = 0.8

// conformance
public val TRACE_FORMAT_VERSION: Long = 1L
public val FUZZ_STEPS_PER_RUN: Long = 2000L
public val FUZZ_RUNS_PER_PULL_REQUEST: Long = 20L
public val FUZZ_RUNS_NIGHTLY: Long = 5000L
public val PRNG_MULTIPLIER_SHIFTS: String = "13,7,17"

// display
public val DISPLAY_SIZE_UNSPECIFIED_SPATIAL_ID: Long = 0L
public val DISPLAY_SIZE_REPORT_MIN_INTERVAL_MS: Long = 200L

// lineBudget
public val LINE_BUDGET_TYPESCRIPT: Long = 6L
public val LINE_BUDGET_FRAMEWORK: Long = 6L
public val LINE_BUDGET_MOBILE: Long = 10L
public val LINE_BUDGET_NATIVE: Long = 10L

// shardCongestion
public val SHARD_UTIL_WINDOW_MS: Long = 1000L
public val SHARD_UTIL_ENTER_T2_NUM: Long = 9L
public val SHARD_UTIL_ENTER_T2_DEN: Long = 10L
public val SHARD_UTIL_ENTER_T1_NUM: Long = 1L
public val SHARD_UTIL_ENTER_T1_DEN: Long = 1L
public val SHARD_UTIL_ENTER_SPATIAL_NUM: Long = 11L
public val SHARD_UTIL_ENTER_SPATIAL_DEN: Long = 10L
public val SHARD_UTIL_ENTER_KEY_ONLY_NUM: Long = 6L
public val SHARD_UTIL_ENTER_KEY_ONLY_DEN: Long = 5L
public val SHARD_UTIL_EXIT_T2_NUM: Long = 4L
public val SHARD_UTIL_EXIT_T2_DEN: Long = 5L
public val SHARD_UTIL_EXIT_T1_NUM: Long = 17L
public val SHARD_UTIL_EXIT_T1_DEN: Long = 20L
public val SHARD_UTIL_EXIT_SPATIAL_NUM: Long = 9L
public val SHARD_UTIL_EXIT_SPATIAL_DEN: Long = 10L
public val SHARD_UTIL_EXIT_KEY_ONLY_NUM: Long = 1L
public val SHARD_UTIL_EXIT_KEY_ONLY_DEN: Long = 1L
public val SHARD_TREND_ENTER_T2_NUM: Long = 5000L
public val SHARD_TREND_ENTER_T2_DEN: Long = 1L
public val SHARD_TREND_ENTER_T1_NUM: Long = 15000L
public val SHARD_TREND_ENTER_T1_DEN: Long = 1L
public val SHARD_TREND_ENTER_SPATIAL_NUM: Long = 30000L
public val SHARD_TREND_ENTER_SPATIAL_DEN: Long = 1L
public val SHARD_TREND_ENTER_KEY_ONLY_NUM: Long = 50000L
public val SHARD_TREND_ENTER_KEY_ONLY_DEN: Long = 1L
public val SHARD_TREND_EXIT_NUM: Long = 1500L
public val SHARD_TREND_EXIT_DEN: Long = 1L
public val SHARD_TREND_EXIT_KEY_ONLY_NUM: Long = 0L
public val SHARD_TREND_EXIT_KEY_ONLY_DEN: Long = 1L

// observability
public val MAX_UNEXPECTED_EVENTS: Long = 64L

