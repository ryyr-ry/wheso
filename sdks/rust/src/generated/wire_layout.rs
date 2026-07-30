//! このファイルは自動生成されている。手で編集してはならない。
//!
//! 生成元: プロトコルのスキーマ定義
//! 再生成: 内部検証スクリプトを実行する
#![allow(dead_code)]

pub const PROTOCOL_VERSION: u8 = 1;
pub const WIRE_MAGIC: u8 = 161;
pub const MESSAGE_HEADER_BYTES: usize = 8;
pub const UNIT_HEADER_BYTES: usize = 20;
pub const MAX_UNITS_PER_MESSAGE: u32 = 255;
pub const MAX_MESSAGE_BYTES: usize = 16000000;
pub const MAX_SPATIAL_ID: u8 = 3;
pub const MAX_TEMPORAL_ID: u8 = 7;

pub const CHANNEL_VIDEO: u8 = 1;
pub const CHANNEL_AUDIO: u8 = 2;
pub const CHANNEL_SCREEN_VIDEO: u8 = 3;
pub const CHANNEL_SCREEN_AUDIO: u8 = 4;

pub const FLAG_KEY: u8 = 1;
pub const FLAG_DISCARDABLE: u8 = 2;
pub const FLAG_DTX: u8 = 4;
pub const FLAG_END_OF_FRAME: u8 = 8;
pub const FLAG_SCREEN_CONTENT: u8 = 16;
pub const FLAG_ACTIVE_SPEAKER: u8 = 32;
