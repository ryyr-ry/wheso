/**
 * このファイルは自動生成されている。手で編集してはならない。
 *
 * 生成元: プロトコルのスキーマ定義
 * 再生成: 内部検証スクリプトを実行する
 */

/* nodeCapacity */
/** 実測上限 25000 の 80%。根拠 F-024 */
export const NODE_MAX_OUT_MESSAGES_PER_SEC = 20000;
/** 実測上限 350 MB/s の 80%。根拠 F-024 */
export const NODE_MAX_OUT_BYTES_PER_SEC = 280000000;
/** 送信側と同一予算。根拠 F-024 */
export const NODE_MAX_IN_MESSAGES_PER_SEC = 20000;

/* videoProfiles */
export const V_4K60 = {
  spatialId: 3,
  width: 3840,
  height: 2160,
  framerate: 60,
  targetBitrate: 25000000,
  scalabilityMode: "L1T3",
  requiresHardwareEncoder: true,
} as const;
export const V_1080P60 = {
  spatialId: 2,
  width: 1920,
  height: 1080,
  framerate: 60,
  targetBitrate: 6000000,
  scalabilityMode: "L1T3",
  requiresHardwareEncoder: false,
} as const;
export const V_1080P30 = {
  spatialId: 1,
  width: 1920,
  height: 1080,
  framerate: 30,
  targetBitrate: 3000000,
  scalabilityMode: "L1T3",
  requiresHardwareEncoder: false,
} as const;
export const V_360P15 = {
  spatialId: 0,
  width: 640,
  height: 360,
  framerate: 15,
  targetBitrate: 200000,
  scalabilityMode: "L1T2",
  requiresHardwareEncoder: false,
} as const;
export const V_SCREEN_4K30 = {
  spatialId: 3,
  width: 3840,
  height: 2160,
  framerate: 30,
  targetBitrate: 8000000,
  scalabilityMode: "L1T2",
  contentHint: "text",
  requiresHardwareEncoder: false,
} as const;
export const V_SCREEN_1080P30 = {
  spatialId: 1,
  width: 1920,
  height: 1080,
  framerate: 30,
  targetBitrate: 2000000,
  scalabilityMode: "L1T2",
  contentHint: "text",
  requiresHardwareEncoder: false,
} as const;

/* audioProfiles */
export const A_VOICE = {
  bitrate: 32000,
  channels: 1,
  bytesPerPacket: 80,
} as const;
export const A_MUSIC = {
  bitrate: 128000,
  channels: 2,
  bytesPerPacket: 320,
} as const;

/* audio */
/** Opus の標準フレーム長 */
export const OPUS_FRAME_MS = 20;
/** 収容 80 人→160 人。追加遅延 20ms。ADR-0005 */
export const AUDIO_BUNDLE_MS = 40;
/** AUDIO_BUNDLE_MS / OPUS_FRAME_MS */
export const AUDIO_UNITS_PER_MESSAGE = 2;
/** 同時転送する発話者数の上限 */
export const AUDIO_SELECTIVE_FORWARD_COUNT = 5;
/** 発話停止後も転送対象に残す時間 */
export const AUDIO_SPEAKER_HOLD_MS = 800;
export const AUDIO_DTX_ENABLED = true;
export const AUDIO_FEC_ENABLED = true;

/* shardCapacity */
/** 標準構成（HQ 1 + LQ N-2）でメッセージ予算に到達する人数。根拠 F-024 */
export const V_SHARD_MAX_PARTICIPANTS = 35;
/** 選別転送 5 名 × 25 msg/s でメッセージ予算に到達する人数。根拠 F-024 */
export const A_SHARD_MAX_PARTICIPANTS = 160;
/** N(N-1) × 25Mbps / 8 <= 280MB/s。根拠 F-024 */
export const V_FULL_MESH_MAX_4K60 = 9;
/** N(N-1) × 60 <= 20000 */
export const V_FULL_MESH_MAX_1080P60 = 18;
/** N(N-1) × 30 <= 20000 */
export const V_FULL_MESH_MAX_1080P30 = 26;
/** N(N-1) × 15 <= 20000 */
export const V_FULL_MESH_MAX_360P15 = 37;

/* congestion */
/** 5 Hz。輻輳の立ち上がりに追従できる最小周期 */
export const REPORT_INTERVAL_MS = 200;
/** 200ms × 20 = 4 秒の観測窓 */
export const DELAY_TREND_WINDOW = 20;
/** 暫定値。未検証 Q-012 */
export const DELAY_TREND_DEGRADE = 0.01;
/** ヒステリシスのため劣化閾値より小さい。未検証 Q-012 */
export const DELAY_TREND_RECOVER = -0.005;
export const KEYFRAME_REQUEST_MIN_INTERVAL_MS = 500;
export const AUDIO_STALL_RESET_MS = 500;
/** 予備接続を常時保持するため短くできる */
export const VIDEO_STALL_RESET_MS = 1500;
/** 切替時の停止を 0 にする */
export const STANDBY_CONNECTION_ENABLED = true;
/** 状態の振動を防ぐ最小滞留時間 */
export const SHEDDING_HYSTERESIS_MS = 500;
/** ジッタバッファ最大深度 167 ms + 1 フレーム */
export const SEND_WINDOW_MS = 200;
/** 送信窓 200 ms を 4 分割する粒度 */
export const ACK_INTERVAL_MS = 50;
/** ack 100 回連続欠落 */
export const ACK_TIMEOUT_MS = 5000;
/** 4K60 の 2 フレーム分。ADR-0014 */
export const UPLINK_BACKLOG_BYTES = 100000;
/** レート減少後の観測期間 */
export const RATE_HOLD_MS = 1000;
/** 加算的増加の刻み。360p15 の 1 本分 */
export const RATE_PROBE_BPS = 200000;
/** 3 回で約 0.61 に収束する */
export const RATE_DECREASE_FACTOR = 0.85;
/** 60 fps の 2 フレーム分 */
export const LATE_FRAME_TOLERANCE_MS = 33;
/** 360p15 200,000 + 音声 32,000 */
export const MIN_VIABLE_BPS = 232000;
/** DELAY_TREND_DEGRADE を有理数 1/100 として表した分子。コアは浮動小数点を使わないため、閾値も整数対で与える。ADR-0017 */
export const DELAY_TREND_DEGRADE_NUM = 1;
/** 同分母。ADR-0017 */
export const DELAY_TREND_DEGRADE_DEN = 100;
/** DELAY_TREND_RECOVER を有理数 -1/200 として表した分子。ADR-0017 */
export const DELAY_TREND_RECOVER_NUM = -1;
/** 同分母。ADR-0017 */
export const DELAY_TREND_RECOVER_DEN = 200;

/* jitterBuffer */
export const VIDEO_JITTER_MIN_FRAMES = 2;
export const VIDEO_JITTER_MAX_FRAMES = 10;
export const AUDIO_JITTER_MIN_PACKETS = 2;
export const AUDIO_JITTER_MAX_PACKETS = 8;
/** この範囲では補正しない */
export const AV_SKEW_TOLERANCE_MS = 20;
/** 超過時は次のキーフレームまでスキップ */
export const AV_SKEW_RESYNC_MS = 200;

/* timeouts */
/** DO 間接続の実測 438ms の 10 倍以上。根拠 F-016 */
export const NODE_CONNECT_TIMEOUT_MS = 5000;
/** 4 回目以降は 5000ms 固定 */
export const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 5000] as const;
export const HEARTBEAT_INTERVAL_MS = 3000;
/** 3 回連続欠落で切断とみなす */
export const HEARTBEAT_TIMEOUT_MS = 9000;
/** epoch 移行で新シャードからフレームが来ない場合の打ち切り */
export const DUAL_SUBSCRIBE_TIMEOUT_MS = 2000;
export const STANDBY_SWAP_TIMEOUT_MS = 3000;

/* auth */
/** 部屋名が決定論的であるため短命にする。ADR-0006 */
export const TOKEN_MAX_AGE_SEC = 60;
export const TOKEN_CLOCK_SKEW_SEC = 5;
export const NODE_AUTH_TIME_WINDOW_SEC = 300;
export const MAX_CONNECT_ATTEMPTS_PER_MIN = 20;
/** 映像 60 + 音声 25 + 制御 5 に余裕を持たせた値 */
export const MAX_INBOUND_MESSAGES_PER_SEC_PER_CLIENT = 400;

/* naming */
/** 最長は fanout 部屋の 60 文字。余裕を持たせた上限 */
export const MAX_ROOM_NAME_LENGTH = 96;
export const FNV1A_OFFSET_BASIS = 2166136261;
export const FNV1A_PRIME = 16777619;
export const FMIX32_C1 = 2246822507;
export const FMIX32_C2 = 3266489909;

/* slo */
export const STALL_RATIO_P95 = 0.005;
export const AUDIO_GAP_RATIO_P95 = 0.001;
/** 人間の知覚閾値 */
export const AV_SKEW_MS_P99 = 80;
export const KEYFRAME_REQUEST_RATE_P95 = 1;
/** クライアント↔DO 往復 25ms + DO 間 2ms + 処理。根拠 F-017,F-018 */
export const GLASS_TO_GLASS_MS_P50 = 150;
/** constants.md 1 節の安全率と一致 */
export const NODE_UTILIZATION_P95 = 0.8;

/* conformance */
/** トレースベクタの形式版。互換性を壊す変更で増やす。ADR-0016 */
export const TRACE_FORMAT_VERSION = 1;
/** 1 回の差分ファジングで流す入力イベント数。プルリクエストごとの所要時間から決めた上限。ADR-0016 */
export const FUZZ_STEPS_PER_RUN = 2000;
/** プルリクエストごとの試行回数。ADR-0016 */
export const FUZZ_RUNS_PER_PULL_REQUEST = 20;
/** 夜間の試行回数。ADR-0016 */
export const FUZZ_RUNS_NIGHTLY = 5000;
/** conformance.md 3.2 の xorshift の移動量。ADR-0016 */
export const PRNG_MULTIPLIER_SHIFTS = "13,7,17";

/* display */
/** 表示寸法の申告が無い相手に要求する層。最低品質（V_360P15）に相当する。既定を高品質にすると申告漏れが帯域予算を壊す。ADR-0015 */
export const DISPLAY_SIZE_UNSPECIFIED_SPATIAL_ID = 0;
/** 寸法変化の申告の最小間隔。REPORT_INTERVAL_MS と同じ周期に揃える。ADR-0015 */
export const DISPLAY_SIZE_REPORT_MIN_INTERVAL_MS = 200;

/* lineBudget */
/** sdk-api.md 1 節の行数予算。ADR-0015 */
export const LINE_BUDGET_TYPESCRIPT = 6;
/** 同上（React / Vue / Svelte）。ADR-0015 */
export const LINE_BUDGET_FRAMEWORK = 6;
/** 同上（Flutter / Swift / Kotlin）。ADR-0015 */
export const LINE_BUDGET_MOBILE = 10;
/** 同上（Rust / C++）。ADR-0015 */
export const LINE_BUDGET_NATIVE = 10;

/* shardCongestion */
/** 容量利用率を測る観測窓。1 秒あたりのレート予算と直接比較できる長さにする。ADR-0017 */
export const SHARD_UTIL_WINDOW_MS = 1000;
/** NORMAL → SHEDDING_T2 の util 閾値 0.9 の分子。ADR-0017 */
export const SHARD_UTIL_ENTER_T2_NUM = 9;
/** NORMAL → SHEDDING_T2 の util 閾値 0.9 の分母。ADR-0017 */
export const SHARD_UTIL_ENTER_T2_DEN = 10;
/** SHEDDING_T2 → SHEDDING_T1 の util 閾値 1.0 の分子。ADR-0017 */
export const SHARD_UTIL_ENTER_T1_NUM = 1;
/** SHEDDING_T2 → SHEDDING_T1 の util 閾値 1.0 の分母。ADR-0017 */
export const SHARD_UTIL_ENTER_T1_DEN = 1;
/** SHEDDING_T1 → SHEDDING_SPATIAL の util 閾値 1.1 の分子。ADR-0017 */
export const SHARD_UTIL_ENTER_SPATIAL_NUM = 11;
/** SHEDDING_T1 → SHEDDING_SPATIAL の util 閾値 1.1 の分母。ADR-0017 */
export const SHARD_UTIL_ENTER_SPATIAL_DEN = 10;
/** SHEDDING_SPATIAL → KEY_ONLY の util 閾値 1.2 の分子。ADR-0017 */
export const SHARD_UTIL_ENTER_KEY_ONLY_NUM = 6;
/** SHEDDING_SPATIAL → KEY_ONLY の util 閾値 1.2 の分母。ADR-0017 */
export const SHARD_UTIL_ENTER_KEY_ONLY_DEN = 5;
/** SHEDDING_T2 → NORMAL の util 閾値 0.8 の分子。ADR-0017 */
export const SHARD_UTIL_EXIT_T2_NUM = 4;
/** SHEDDING_T2 → NORMAL の util 閾値 0.8 の分母。ADR-0017 */
export const SHARD_UTIL_EXIT_T2_DEN = 5;
/** SHEDDING_T1 → SHEDDING_T2 の util 閾値 0.85 の分子。ADR-0017 */
export const SHARD_UTIL_EXIT_T1_NUM = 17;
/** SHEDDING_T1 → SHEDDING_T2 の util 閾値 0.85 の分母。ADR-0017 */
export const SHARD_UTIL_EXIT_T1_DEN = 20;
/** SHEDDING_SPATIAL → SHEDDING_T1 の util 閾値 0.9 の分子。ADR-0017 */
export const SHARD_UTIL_EXIT_SPATIAL_NUM = 9;
/** SHEDDING_SPATIAL → SHEDDING_T1 の util 閾値 0.9 の分母。ADR-0017 */
export const SHARD_UTIL_EXIT_SPATIAL_DEN = 10;
/** KEY_ONLY → SHEDDING_SPATIAL の util 閾値 1.0 の分子。ADR-0017 */
export const SHARD_UTIL_EXIT_KEY_ONLY_NUM = 1;
/** KEY_ONLY → SHEDDING_SPATIAL の util 閾値 1.0 の分母。ADR-0017 */
export const SHARD_UTIL_EXIT_KEY_ONLY_DEN = 1;
/** NORMAL → SHEDDING_T2 の maxTrend 閾値 0.01 の分子。ADR-0017 */
export const SHARD_TREND_ENTER_T2_NUM = 1;
/** NORMAL → SHEDDING_T2 の maxTrend 閾値 0.01 の分母。ADR-0017 */
export const SHARD_TREND_ENTER_T2_DEN = 100;
/** SHEDDING_T2 → SHEDDING_T1 の maxTrend 閾値 0.03 の分子。ADR-0017 */
export const SHARD_TREND_ENTER_T1_NUM = 3;
/** SHEDDING_T2 → SHEDDING_T1 の maxTrend 閾値 0.03 の分母。ADR-0017 */
export const SHARD_TREND_ENTER_T1_DEN = 100;
/** SHEDDING_T1 → SHEDDING_SPATIAL の maxTrend 閾値 0.06 の分子。ADR-0017 */
export const SHARD_TREND_ENTER_SPATIAL_NUM = 3;
/** SHEDDING_T1 → SHEDDING_SPATIAL の maxTrend 閾値 0.06 の分母。ADR-0017 */
export const SHARD_TREND_ENTER_SPATIAL_DEN = 50;
/** SHEDDING_SPATIAL → KEY_ONLY の maxTrend 閾値 0.1 の分子。ADR-0017 */
export const SHARD_TREND_ENTER_KEY_ONLY_NUM = 1;
/** SHEDDING_SPATIAL → KEY_ONLY の maxTrend 閾値 0.1 の分母。ADR-0017 */
export const SHARD_TREND_ENTER_KEY_ONLY_DEN = 10;
/** 回復側の maxTrend 閾値 -0.005 の分子。ADR-0017 */
export const SHARD_TREND_EXIT_NUM = -1;
/** 回復側の maxTrend 閾値 -0.005 の分母。ADR-0017 */
export const SHARD_TREND_EXIT_DEN = 200;
/** KEY_ONLY → SHEDDING_SPATIAL の maxTrend 閾値 0 の分子。ADR-0017 */
export const SHARD_TREND_EXIT_KEY_ONLY_NUM = 0;
/** KEY_ONLY → SHEDDING_SPATIAL の maxTrend 閾値 0 の分母。ADR-0017 */
export const SHARD_TREND_EXIT_KEY_ONLY_DEN = 1;

