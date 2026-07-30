/**
 * このファイルは自動生成されている。手で編集してはならない。
 *
 * 生成元: プロトコルのスキーマ定義
 * 再生成: 内部検証スクリプトを実行する
 */

export const PROTOCOL_VERSION = 1;
export const WIRE_MAGIC = 161;
export const MESSAGE_HEADER_BYTES = 8;
export const UNIT_HEADER_BYTES = 20;
export const MAX_UNITS_PER_MESSAGE = 255;
export const MAX_MESSAGE_BYTES = 16000000;
export const MAX_SPATIAL_ID = 3;
export const MAX_TEMPORAL_ID = 7;
export const DOCUMENTED_RECEIVE_LIMIT_BYTES = 33554432;

/** メッセージヘッダのフィールド位置。 */
export const MESSAGE_HEADER_OFFSET = {
  magic: 0,
  version: 1,
  channel: 2,
  unitCount: 3,
  senderId: 4,
} as const;

/** ユニットヘッダのフィールド位置。 */
export const UNIT_HEADER_OFFSET = {
  sequenceNumber: 0,
  captureTimestampHighUs: 4,
  captureTimestampLowUs: 8,
  flags: 12,
  spatialId: 13,
  temporalId: 14,
  reserved: 15,
  payloadLength: 16,
} as const;

/** Channel */
export const CHANNEL_VIDEO = 1; // カメラ映像
export const CHANNEL_AUDIO = 2; // 音声
export const CHANNEL_SCREEN_VIDEO = 3; // 画面共有映像
export const CHANNEL_SCREEN_AUDIO = 4; // 画面共有音声

/** UnitFlag のビット定義。 */
export const FLAG_KEY = 1; // 他フレームに依存せず復号できる
export const FLAG_DISCARDABLE = 2; // 破棄しても後続の復号に影響しない
export const FLAG_DTX = 4; // 音声の不連続送信（無音）
export const FLAG_END_OF_FRAME = 8; // このユニットでフレームが完結する
export const FLAG_SCREEN_CONTENT = 16; // 文字や図が主体
export const FLAG_ACTIVE_SPEAKER = 32; // 送信者が発話中

export const VIDEO_CHANNEL_REQUIRES_SINGLE_UNIT = true;
