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
  temporalLayers: 3,
  requiresHardwareEncoder: true,
} as const;
export const V_1080P60 = {
  spatialId: 2,
  width: 1920,
  height: 1080,
  framerate: 60,
  targetBitrate: 6000000,
  scalabilityMode: "L1T3",
  temporalLayers: 3,
  requiresHardwareEncoder: false,
} as const;
export const V_1080P30 = {
  spatialId: 1,
  width: 1920,
  height: 1080,
  framerate: 30,
  targetBitrate: 3000000,
  scalabilityMode: "L1T3",
  temporalLayers: 3,
  requiresHardwareEncoder: false,
} as const;
export const V_360P15 = {
  spatialId: 0,
  width: 640,
  height: 360,
  framerate: 15,
  targetBitrate: 200000,
  scalabilityMode: "L1T2",
  temporalLayers: 2,
  requiresHardwareEncoder: false,
} as const;
export const V_SCREEN_4K30 = {
  spatialId: 3,
  width: 3840,
  height: 2160,
  framerate: 30,
  targetBitrate: 8000000,
  scalabilityMode: "L1T2",
  temporalLayers: 2,
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
  temporalLayers: 2,
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
/** TCP 上ではパケットロスによる欠落が起きないため、in-band FEC は 1 バイトも役に立たずビットレートだけを押し上げる（ADR-0030、congestion.md 0 節） */
export const AUDIO_FEC_ENABLED = false;

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
/** 健全な回線での勾配の最大 1,495 と輻輳時の最小 28,896 の間（F-048）。単位はマイクロ秒/標本である。旧値 0.01 は無次元の比として与えられており、比較の相手が勾配（マイクロ秒/標本）であるため常に成立していた（ADR-0037）。ADR-0037 */
export const DELAY_TREND_DEGRADE = 5000;
/** 健全な回線での勾配の最大 1,495 を含み、輻輳時の最小 28,896 を含まない上限（F-048）。「遅延が増えていない」を回復の条件とする。旧値 -0.005 は健全時の中央 -39 でも満たされず、目標を上げられなかった（ADR-0037）。ADR-0037 */
export const DELAY_TREND_RECOVER = 1500;
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
/** 上りの滞留が UPLINK_BACKLOG_BYTES を超えた観測が何回連続したら降格するか。congestion.md 3 節の「3 回連続（200 ms 周期）」。1 回で降格すると正常な送信の揺れで誤検知する */
export const UPLINK_DEGRADE_STREAK = 3;
/** 滞留が 0 の状態がこの時間続いたら 1 段昇格する。congestion.md 3 節の「5 秒」 */
export const UPLINK_RECOVER_MS = 5000;
/** 降格の直後はこの時間だけ昇格しない。congestion.md 3 節の「直近の降格から 10 秒」。上りの回復判定（5 秒）の 2 倍にして振動を防ぐ */
export const UPLINK_UPGRADE_HOLD_MS = 10000;
/** 符号化の待ち行列（encodeQueueSize）がこの値を超えた状態が続いたら降格する。client-architecture.md 10 節。3 は「1 フレームの符号化中に次の 2 枚が待っている」状態であり、実時間に追いついていない */
export const ENCODE_QUEUE_LIMIT = 3;
/** 符号化の待ち行列が上限を超えた状態がこの時間続いたら降格する。client-architecture.md 10 節の「2 秒」 */
export const ENCODE_QUEUE_HOLD_MS = 2000;
/** 発熱による降格の後はこの時間だけ昇格しない。client-architecture.md 10 節の「30 秒」。上りの昇格待ち（10 秒）より長いのは、発熱が回復するのに時間がかかるためである */
export const THERMAL_UPGRADE_HOLD_MS = 30000;
/** 4K60 の 2 フレーム分。ADR-0014 */
export const UPLINK_BACKLOG_BYTES = 100000;
/** レート減少後の観測期間 */
export const RATE_HOLD_MS = 1000;
/** 加算的増加の刻み。360p15 の 1 本分 */
export const RATE_PROBE_BPS = 200000;
/** 回復判定が 3 回連続したときのみ加算的増加を許す（congestion 4.2）。1 回で増やすと利用可能帯域の境界で振動する */
export const RATE_RECOVER_STREAK = 3;
/** 3 回で約 0.61 に収束する */
export const RATE_DECREASE_FACTOR = 0.85;
/** 60 fps の 2 フレーム分 */
export const LATE_FRAME_TOLERANCE_MS = 33;
/** ヘッダを含めた実効レートで再導出（ADR-0029 の 3）。音声 1 本 41,600 + 360p15 1 本 203,360。音声 1 本 = (MESSAGE_HEADER_BYTES 8 + AUDIO_UNITS_PER_MESSAGE 2 × (UNIT_HEADER_BYTES 20 + A_VOICE.bytesPerPacket 80)) × 8 × 1000 / AUDIO_BUNDLE_MS 40。360p15 = 200,000 + 15 fps × (8 + 20) × 8。旧値 232,000 はヘッダを無視していた */
export const MIN_VIABLE_BPS = 244960;
/** MIN_VIABLE_BPS と同じ。これを下回ったら映像の購読を落として音声だけにする（ADR-0029 の 1） */
export const AUDIO_ONLY_ENTER_BPS = 244960;
/** MIN_VIABLE_BPS 244,960 の 1.83 倍ではなく、音声 5 本 208,000 + 360p15 203,360 + 余裕 36,960（音声 1 本ぶんに近い値）。映像へ戻す条件を入る条件より高くしてヒステリシスを作る（ADR-0029 の 1） */
export const AUDIO_ONLY_EXIT_BPS = 448320;
/** 帯域が足りないときに残す音声の本数の下限。1 本を切ると会議が成立しない（ADR-0029 の 4 の優先順位の最上位） */
export const AUDIO_SELECTIVE_MIN_COUNT = 1;
/** DELAY_TREND_DEGRADE を有理数 5000/1 として表した分子。コアは浮動小数点を使わない。ADR-0037 */
export const DELAY_TREND_DEGRADE_NUM = 5000;
/** 同分母。ADR-0037 */
export const DELAY_TREND_DEGRADE_DEN = 1;
/** DELAY_TREND_RECOVER を有理数 1500/1 として表した分子。ADR-0037 */
export const DELAY_TREND_RECOVER_NUM = 1500;
/** 同分母。ADR-0037 */
export const DELAY_TREND_RECOVER_DEN = 1;

/* jitterBuffer */
export const VIDEO_JITTER_MIN_FRAMES = 2;
export const VIDEO_JITTER_MAX_FRAMES = 10;
export const AUDIO_JITTER_MIN_PACKETS = 2;
export const AUDIO_JITTER_MAX_PACKETS = 8;
/** この範囲では補正しない（不感帯）。ITU-R BT.1359-0 の送出許容（音声先行 +22.5 ms）の内側に取る。F-043 */
export const AV_SKEW_TOLERANCE_MS = 20;
/** 音声が映像より先行してよい上限。ITU-R BT.1359-0 の +22.5 ms を整数へ切り捨てた値。許容は非対称であり、人は音声先行に厳しい。F-043、ADR-0028 */
export const AV_SKEW_AUDIO_LEAD_MAX_MS = 22;
/** 音声が映像より遅れてよい上限。ITU-R BT.1359-0 の -30 ms。F-043、ADR-0028 */
export const AV_SKEW_AUDIO_LAG_MAX_MS = 30;
/** ドリフト補正の 1 回あたりの刻み（マイクロ秒）。48 kHz の 1 標本は 20.83 µs であり、これを切り捨てた値。1 パケット（OPUS_FRAME_MS = 20 ms）あたり 1 標本の挿入または削除で吸収できる最小の量である。20 µs / 20 ms = 1000 ppm までのクロック差に追従できる。追従の十分性は Q-023 で確かめる。ADR-0028 */
export const AV_DRIFT_STEP_US = 20;
/** これを超える欠落は不連続として扱い、対応付けを作り直す。映像のジッタバッファの最大深度（VIDEO_JITTER_MAX_FRAMES 10 / 60 fps = 167 ms）の 6 倍を超える欠落は、回線の揺れでは説明できない。ADR-0028 */
export const AV_RESYNC_GAP_MS = 1000;

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
/** 二重購読で新 epoch からフレームを待つ上限。state-machines.md 5 節の表 4 行目 */
export const EPOCH_DUAL_SUBSCRIBE_TIMEOUT_MS = 2000;

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
/** ITU-R BT.1359-0 の送出許容のうち緩い側（音声遅れ 30 ms）。旧値 80 は音声先行方向で検知閾値（+45 ms）を超えており、ずれが見える水準であった。F-043、ADR-0028 */
export const AV_SKEW_MS_P99 = 30;
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
/** 最初の段。健全時の最大 1,495 の 3.3 倍（F-048）。単位はマイクロ秒/標本。ADR-0037 */
export const SHARD_TREND_ENTER_T2_NUM = 5000;
/** 同分母。ADR-0037 */
export const SHARD_TREND_ENTER_T2_DEN = 1;
/** 8 Mbps 過剰時の中央 44,503 に至る途中（F-048）。旧比 1:3 を保つ。単位はマイクロ秒/標本。ADR-0037 */
export const SHARD_TREND_ENTER_T1_NUM = 15000;
/** 同分母。ADR-0037 */
export const SHARD_TREND_ENTER_T1_DEN = 1;
/** 8 Mbps 過剰時の中央 44,503 を下回る（F-048）。旧比 1:6 を保つ。単位はマイクロ秒/標本。ADR-0037 */
export const SHARD_TREND_ENTER_SPATIAL_NUM = 30000;
/** 同分母。ADR-0037 */
export const SHARD_TREND_ENTER_SPATIAL_DEN = 1;
/** 8 Mbps 過剰時の中央 44,503 を上回り 16 Mbps 過剰時の中央 237,691 を下回る（F-048）。旧比 1:10 を保つ。単位はマイクロ秒/標本。ADR-0037 */
export const SHARD_TREND_ENTER_KEY_ONLY_NUM = 50000;
/** 同分母。ADR-0037 */
export const SHARD_TREND_ENTER_KEY_ONLY_DEN = 1;
/** 健全な回線での勾配の最大 1,495 を含み、輻輳時の最小 28,896 を含まない上限（F-048）。「遅延が増えていない」を回復の条件とする。旧値 -0.005 は健全時の中央 -39 でも満たされず、目標を上げられなかった（ADR-0037）。ADR-0037 */
export const SHARD_TREND_EXIT_NUM = 1500;
/** 同分母。ADR-0037 */
export const SHARD_TREND_EXIT_DEN = 1;
/** KEY_ONLY → SHEDDING_SPATIAL の maxTrend 閾値 0 の分子。ADR-0017 */
export const SHARD_TREND_EXIT_KEY_ONLY_NUM = 0;
/** KEY_ONLY → SHEDDING_SPATIAL の maxTrend 閾値 0 の分母。ADR-0017 */
export const SHARD_TREND_EXIT_KEY_ONLY_DEN = 1;

/* observability */
/** 表に無いイベントの記録の上限。無制限に積むと Durable Object の記憶（128 MB。F-006）を食う。原因の特定には直近の数十件で足りるため、古い側を捨てる。根拠 F-006 */
export const MAX_UNEXPECTED_EVENTS = 64;

