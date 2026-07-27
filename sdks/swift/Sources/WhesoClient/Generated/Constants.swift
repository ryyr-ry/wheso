// このファイルは自動生成されている。手で編集してはならない。
//
// 生成元: プロトコルのスキーマ定義
// 再生成: 内部検証スクリプトを実行する

public enum WhesoConstants {
    // nodeCapacity
    public static let NODE_MAX_OUT_MESSAGES_PER_SEC: Int64 = 20000
    public static let NODE_MAX_OUT_BYTES_PER_SEC: Int64 = 280000000
    public static let NODE_MAX_IN_MESSAGES_PER_SEC: Int64 = 20000

    // videoProfiles
    public static let V_4K60_SPATIAL_ID: Int64 = 3
    public static let V_4K60_WIDTH: Int64 = 3840
    public static let V_4K60_HEIGHT: Int64 = 2160
    public static let V_4K60_FRAMERATE: Int64 = 60
    public static let V_4K60_TARGET_BITRATE: Int64 = 25000000
    public static let V_4K60_SCALABILITY_MODE: String = "L1T3"
    public static let V_4K60_TEMPORAL_LAYERS: Int64 = 3
    public static let V_4K60_REQUIRES_HARDWARE_ENCODER: Bool = true
    public static let V_1080P60_SPATIAL_ID: Int64 = 2
    public static let V_1080P60_WIDTH: Int64 = 1920
    public static let V_1080P60_HEIGHT: Int64 = 1080
    public static let V_1080P60_FRAMERATE: Int64 = 60
    public static let V_1080P60_TARGET_BITRATE: Int64 = 6000000
    public static let V_1080P60_SCALABILITY_MODE: String = "L1T3"
    public static let V_1080P60_TEMPORAL_LAYERS: Int64 = 3
    public static let V_1080P60_REQUIRES_HARDWARE_ENCODER: Bool = false
    public static let V_1080P30_SPATIAL_ID: Int64 = 1
    public static let V_1080P30_WIDTH: Int64 = 1920
    public static let V_1080P30_HEIGHT: Int64 = 1080
    public static let V_1080P30_FRAMERATE: Int64 = 30
    public static let V_1080P30_TARGET_BITRATE: Int64 = 3000000
    public static let V_1080P30_SCALABILITY_MODE: String = "L1T3"
    public static let V_1080P30_TEMPORAL_LAYERS: Int64 = 3
    public static let V_1080P30_REQUIRES_HARDWARE_ENCODER: Bool = false
    public static let V_360P15_SPATIAL_ID: Int64 = 0
    public static let V_360P15_WIDTH: Int64 = 640
    public static let V_360P15_HEIGHT: Int64 = 360
    public static let V_360P15_FRAMERATE: Int64 = 15
    public static let V_360P15_TARGET_BITRATE: Int64 = 200000
    public static let V_360P15_SCALABILITY_MODE: String = "L1T2"
    public static let V_360P15_TEMPORAL_LAYERS: Int64 = 2
    public static let V_360P15_REQUIRES_HARDWARE_ENCODER: Bool = false
    public static let V_SCREEN_4K30_SPATIAL_ID: Int64 = 3
    public static let V_SCREEN_4K30_WIDTH: Int64 = 3840
    public static let V_SCREEN_4K30_HEIGHT: Int64 = 2160
    public static let V_SCREEN_4K30_FRAMERATE: Int64 = 30
    public static let V_SCREEN_4K30_TARGET_BITRATE: Int64 = 8000000
    public static let V_SCREEN_4K30_SCALABILITY_MODE: String = "L1T2"
    public static let V_SCREEN_4K30_TEMPORAL_LAYERS: Int64 = 2
    public static let V_SCREEN_4K30_CONTENT_HINT: String = "text"
    public static let V_SCREEN_4K30_REQUIRES_HARDWARE_ENCODER: Bool = false
    public static let V_SCREEN_1080P30_SPATIAL_ID: Int64 = 1
    public static let V_SCREEN_1080P30_WIDTH: Int64 = 1920
    public static let V_SCREEN_1080P30_HEIGHT: Int64 = 1080
    public static let V_SCREEN_1080P30_FRAMERATE: Int64 = 30
    public static let V_SCREEN_1080P30_TARGET_BITRATE: Int64 = 2000000
    public static let V_SCREEN_1080P30_SCALABILITY_MODE: String = "L1T2"
    public static let V_SCREEN_1080P30_TEMPORAL_LAYERS: Int64 = 2
    public static let V_SCREEN_1080P30_CONTENT_HINT: String = "text"
    public static let V_SCREEN_1080P30_REQUIRES_HARDWARE_ENCODER: Bool = false

    // audioProfiles
    public static let A_VOICE_BITRATE: Int64 = 32000
    public static let A_VOICE_CHANNELS: Int64 = 1
    public static let A_VOICE_BYTES_PER_PACKET: Int64 = 80
    public static let A_MUSIC_BITRATE: Int64 = 128000
    public static let A_MUSIC_CHANNELS: Int64 = 2
    public static let A_MUSIC_BYTES_PER_PACKET: Int64 = 320

    // audio
    public static let OPUS_FRAME_MS: Int64 = 20
    public static let AUDIO_BUNDLE_MS: Int64 = 40
    public static let AUDIO_UNITS_PER_MESSAGE: Int64 = 2
    public static let AUDIO_SELECTIVE_FORWARD_COUNT: Int64 = 5
    public static let AUDIO_SPEAKER_HOLD_MS: Int64 = 800
    public static let AUDIO_DTX_ENABLED: Bool = true
    public static let AUDIO_FEC_ENABLED: Bool = true

    // shardCapacity
    public static let V_SHARD_MAX_PARTICIPANTS: Int64 = 35
    public static let A_SHARD_MAX_PARTICIPANTS: Int64 = 160
    public static let V_FULL_MESH_MAX_4K60: Int64 = 9
    public static let V_FULL_MESH_MAX_1080P60: Int64 = 18
    public static let V_FULL_MESH_MAX_1080P30: Int64 = 26
    public static let V_FULL_MESH_MAX_360P15: Int64 = 37

    // congestion
    public static let REPORT_INTERVAL_MS: Int64 = 200
    public static let DELAY_TREND_WINDOW: Int64 = 20
    public static let DELAY_TREND_DEGRADE: Double = 0.01
    public static let DELAY_TREND_RECOVER: Double = -0.005
    public static let KEYFRAME_REQUEST_MIN_INTERVAL_MS: Int64 = 500
    public static let AUDIO_STALL_RESET_MS: Int64 = 500
    public static let VIDEO_STALL_RESET_MS: Int64 = 1500
    public static let STANDBY_CONNECTION_ENABLED: Bool = true
    public static let SHEDDING_HYSTERESIS_MS: Int64 = 500
    public static let SEND_WINDOW_MS: Int64 = 200
    public static let ACK_INTERVAL_MS: Int64 = 50
    public static let ACK_TIMEOUT_MS: Int64 = 5000
    public static let UPLINK_BACKLOG_BYTES: Int64 = 100000
    public static let RATE_HOLD_MS: Int64 = 1000
    public static let RATE_PROBE_BPS: Int64 = 200000
    public static let RATE_DECREASE_FACTOR: Double = 0.85
    public static let LATE_FRAME_TOLERANCE_MS: Int64 = 33
    public static let MIN_VIABLE_BPS: Int64 = 232000
    public static let DELAY_TREND_DEGRADE_NUM: Int64 = 1
    public static let DELAY_TREND_DEGRADE_DEN: Int64 = 100
    public static let DELAY_TREND_RECOVER_NUM: Int64 = -1
    public static let DELAY_TREND_RECOVER_DEN: Int64 = 200

    // jitterBuffer
    public static let VIDEO_JITTER_MIN_FRAMES: Int64 = 2
    public static let VIDEO_JITTER_MAX_FRAMES: Int64 = 10
    public static let AUDIO_JITTER_MIN_PACKETS: Int64 = 2
    public static let AUDIO_JITTER_MAX_PACKETS: Int64 = 8
    public static let AV_SKEW_TOLERANCE_MS: Int64 = 20
    public static let AV_SKEW_RESYNC_MS: Int64 = 200

    // timeouts
    public static let NODE_CONNECT_TIMEOUT_MS: Int64 = 5000
    public static let RECONNECT_BACKOFF_MS: [Int64] = [500, 1000, 2000, 5000]
    public static let HEARTBEAT_INTERVAL_MS: Int64 = 3000
    public static let HEARTBEAT_TIMEOUT_MS: Int64 = 9000
    public static let DUAL_SUBSCRIBE_TIMEOUT_MS: Int64 = 2000
    public static let STANDBY_SWAP_TIMEOUT_MS: Int64 = 3000
    public static let EPOCH_DUAL_SUBSCRIBE_TIMEOUT_MS: Int64 = 2000

    // auth
    public static let TOKEN_MAX_AGE_SEC: Int64 = 60
    public static let TOKEN_CLOCK_SKEW_SEC: Int64 = 5
    public static let NODE_AUTH_TIME_WINDOW_SEC: Int64 = 300
    public static let MAX_CONNECT_ATTEMPTS_PER_MIN: Int64 = 20
    public static let MAX_INBOUND_MESSAGES_PER_SEC_PER_CLIENT: Int64 = 400

    // naming
    public static let MAX_ROOM_NAME_LENGTH: Int64 = 96
    public static let FNV1A_OFFSET_BASIS: Int64 = 2166136261
    public static let FNV1A_PRIME: Int64 = 16777619
    public static let FMIX32_C1: Int64 = 2246822507
    public static let FMIX32_C2: Int64 = 3266489909

    // slo
    public static let STALL_RATIO_P95: Double = 0.005
    public static let AUDIO_GAP_RATIO_P95: Double = 0.001
    public static let AV_SKEW_MS_P99: Int64 = 80
    public static let KEYFRAME_REQUEST_RATE_P95: Int64 = 1
    public static let GLASS_TO_GLASS_MS_P50: Int64 = 150
    public static let NODE_UTILIZATION_P95: Double = 0.8

    // conformance
    public static let TRACE_FORMAT_VERSION: Int64 = 1
    public static let FUZZ_STEPS_PER_RUN: Int64 = 2000
    public static let FUZZ_RUNS_PER_PULL_REQUEST: Int64 = 20
    public static let FUZZ_RUNS_NIGHTLY: Int64 = 5000
    public static let PRNG_MULTIPLIER_SHIFTS: String = "13,7,17"

    // display
    public static let DISPLAY_SIZE_UNSPECIFIED_SPATIAL_ID: Int64 = 0
    public static let DISPLAY_SIZE_REPORT_MIN_INTERVAL_MS: Int64 = 200

    // lineBudget
    public static let LINE_BUDGET_TYPESCRIPT: Int64 = 6
    public static let LINE_BUDGET_FRAMEWORK: Int64 = 6
    public static let LINE_BUDGET_MOBILE: Int64 = 10
    public static let LINE_BUDGET_NATIVE: Int64 = 10

    // shardCongestion
    public static let SHARD_UTIL_WINDOW_MS: Int64 = 1000
    public static let SHARD_UTIL_ENTER_T2_NUM: Int64 = 9
    public static let SHARD_UTIL_ENTER_T2_DEN: Int64 = 10
    public static let SHARD_UTIL_ENTER_T1_NUM: Int64 = 1
    public static let SHARD_UTIL_ENTER_T1_DEN: Int64 = 1
    public static let SHARD_UTIL_ENTER_SPATIAL_NUM: Int64 = 11
    public static let SHARD_UTIL_ENTER_SPATIAL_DEN: Int64 = 10
    public static let SHARD_UTIL_ENTER_KEY_ONLY_NUM: Int64 = 6
    public static let SHARD_UTIL_ENTER_KEY_ONLY_DEN: Int64 = 5
    public static let SHARD_UTIL_EXIT_T2_NUM: Int64 = 4
    public static let SHARD_UTIL_EXIT_T2_DEN: Int64 = 5
    public static let SHARD_UTIL_EXIT_T1_NUM: Int64 = 17
    public static let SHARD_UTIL_EXIT_T1_DEN: Int64 = 20
    public static let SHARD_UTIL_EXIT_SPATIAL_NUM: Int64 = 9
    public static let SHARD_UTIL_EXIT_SPATIAL_DEN: Int64 = 10
    public static let SHARD_UTIL_EXIT_KEY_ONLY_NUM: Int64 = 1
    public static let SHARD_UTIL_EXIT_KEY_ONLY_DEN: Int64 = 1
    public static let SHARD_TREND_ENTER_T2_NUM: Int64 = 1
    public static let SHARD_TREND_ENTER_T2_DEN: Int64 = 100
    public static let SHARD_TREND_ENTER_T1_NUM: Int64 = 3
    public static let SHARD_TREND_ENTER_T1_DEN: Int64 = 100
    public static let SHARD_TREND_ENTER_SPATIAL_NUM: Int64 = 3
    public static let SHARD_TREND_ENTER_SPATIAL_DEN: Int64 = 50
    public static let SHARD_TREND_ENTER_KEY_ONLY_NUM: Int64 = 1
    public static let SHARD_TREND_ENTER_KEY_ONLY_DEN: Int64 = 10
    public static let SHARD_TREND_EXIT_NUM: Int64 = -1
    public static let SHARD_TREND_EXIT_DEN: Int64 = 200
    public static let SHARD_TREND_EXIT_KEY_ONLY_NUM: Int64 = 0
    public static let SHARD_TREND_EXIT_KEY_ONLY_DEN: Int64 = 1

}
