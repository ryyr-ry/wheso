//! ワイヤフォーマットの実装。
//!
//! 規範: wire-format.md 1 節（バイト配置）と 1.4（破棄優先順位）。
//! TypeScript の参照実装とバイト単位で一致しなければならない（conformance.md 2 節の層 1）。
//!
//! パニックしない。添字アクセスは範囲を確かめてから行う。

use crate::generated::wire_layout::{
    CHANNEL_AUDIO, CHANNEL_SCREEN_AUDIO, FLAG_ACTIVE_SPEAKER, FLAG_DISCARDABLE, FLAG_KEY,
    FLAG_SCREEN_CONTENT, MAX_MESSAGE_BYTES, MAX_UNITS_PER_MESSAGE, MESSAGE_HEADER_BYTES,
    PROTOCOL_VERSION, UNIT_HEADER_BYTES, WIRE_MAGIC,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireError {
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
}

impl WireError {
    /// 規範のエラー名。TypeScript 側の文字列と一致させる。
    pub fn name(self) -> &'static str {
        match self {
            WireError::Magic => "E_WIRE_MAGIC",
            WireError::Version => "E_WIRE_VERSION",
            WireError::Channel => "E_WIRE_CHANNEL",
            WireError::UnitCount => "E_WIRE_UNIT_COUNT",
            WireError::SenderId => "E_WIRE_SENDER_ID",
            WireError::LengthMismatch => "E_WIRE_LENGTH_MISMATCH",
            WireError::PayloadEmpty => "E_WIRE_PAYLOAD_EMPTY",
            WireError::TooLarge => "E_WIRE_TOO_LARGE",
            WireError::UnitOrder => "E_WIRE_UNIT_ORDER",
            WireError::FieldRange => "E_WIRE_FIELD_RANGE",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unit {
    pub sequence_number: u32,
    pub capture_timestamp_us: u64,
    pub flags: u8,
    pub spatial_id: u8,
    pub temporal_id: u8,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaMessage {
    pub channel: u8,
    pub sender_id: u32,
    pub units: Vec<Unit>,
}

fn is_video(channel: u8) -> bool {
    channel != CHANNEL_AUDIO && channel != CHANNEL_SCREEN_AUDIO
}

fn known_channel(channel: u8) -> bool {
    (1..=4).contains(&channel)
}

/// メディアメッセージを符号化する。
pub fn encode_media_message(message: &MediaMessage) -> Result<Vec<u8>, WireError> {
    if !known_channel(message.channel) {
        return Err(WireError::Channel);
    }
    if message.sender_id == 0 {
        return Err(WireError::SenderId);
    }
    if message.units.is_empty() {
        return Err(WireError::UnitCount);
    }
    if message.units.len() as u32 > MAX_UNITS_PER_MESSAGE {
        return Err(WireError::UnitCount);
    }
    // 映像は常に 1 ユニットである（wire-format.md 1.5）。
    if is_video(message.channel) && message.units.len() != 1 {
        return Err(WireError::UnitCount);
    }

    let mut total = MESSAGE_HEADER_BYTES;
    let mut previous: Option<u32> = None;
    for unit in &message.units {
        if unit.payload.is_empty() {
            return Err(WireError::PayloadEmpty);
        }
        if unit.spatial_id > 3 || unit.temporal_id > 7 {
            return Err(WireError::FieldRange);
        }
        if let Some(previous_sequence) = previous {
            if unit.sequence_number <= previous_sequence {
                return Err(WireError::UnitOrder);
            }
        }
        previous = Some(unit.sequence_number);
        total += UNIT_HEADER_BYTES + unit.payload.len();
    }
    if total > MAX_MESSAGE_BYTES {
        return Err(WireError::TooLarge);
    }

    let mut bytes = Vec::with_capacity(total);
    bytes.push(WIRE_MAGIC);
    bytes.push(PROTOCOL_VERSION);
    bytes.push(message.channel);
    bytes.push(message.units.len() as u8);
    bytes.extend_from_slice(&message.sender_id.to_be_bytes());
    for unit in &message.units {
        bytes.extend_from_slice(&unit.sequence_number.to_be_bytes());
        bytes.extend_from_slice(&unit.capture_timestamp_us.to_be_bytes());
        bytes.push(unit.flags);
        bytes.push(unit.spatial_id);
        bytes.push(unit.temporal_id);
        bytes.push(0); // reserved
        bytes.extend_from_slice(&(unit.payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&unit.payload);
    }
    Ok(bytes)
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    let mut buffer = [0u8; 4];
    buffer.copy_from_slice(slice);
    Some(u32::from_be_bytes(buffer))
}

fn read_u64(bytes: &[u8], offset: usize) -> Option<u64> {
    let slice = bytes.get(offset..offset + 8)?;
    let mut buffer = [0u8; 8];
    buffer.copy_from_slice(slice);
    Some(u64::from_be_bytes(buffer))
}

/// メディアメッセージを復号する。
pub fn decode_media_message(bytes: &[u8]) -> Result<MediaMessage, WireError> {
    if bytes.len() < MESSAGE_HEADER_BYTES {
        return Err(WireError::LengthMismatch);
    }
    if bytes.first().copied() != Some(WIRE_MAGIC) {
        return Err(WireError::Magic);
    }
    if bytes.get(1).copied() != Some(PROTOCOL_VERSION) {
        return Err(WireError::Version);
    }
    let channel = match bytes.get(2).copied() {
        Some(value) => value,
        None => return Err(WireError::LengthMismatch),
    };
    if !known_channel(channel) {
        return Err(WireError::Channel);
    }
    let unit_count = match bytes.get(3).copied() {
        Some(value) => value,
        None => return Err(WireError::LengthMismatch),
    };
    if unit_count == 0 {
        return Err(WireError::UnitCount);
    }
    if is_video(channel) && unit_count != 1 {
        return Err(WireError::UnitCount);
    }
    let sender_id = match read_u32(bytes, 4) {
        Some(value) => value,
        None => return Err(WireError::LengthMismatch),
    };
    if sender_id == 0 {
        return Err(WireError::SenderId);
    }

    let mut offset = MESSAGE_HEADER_BYTES;
    let mut units: Vec<Unit> = Vec::with_capacity(unit_count as usize);
    let mut previous: Option<u32> = None;
    for _ in 0..unit_count {
        if offset + UNIT_HEADER_BYTES > bytes.len() {
            return Err(WireError::LengthMismatch);
        }
        let sequence_number = match read_u32(bytes, offset) {
            Some(value) => value,
            None => return Err(WireError::LengthMismatch),
        };
        let capture_timestamp_us = match read_u64(bytes, offset + 4) {
            Some(value) => value,
            None => return Err(WireError::LengthMismatch),
        };
        let flags = match bytes.get(offset + 12).copied() {
            Some(value) => value,
            None => return Err(WireError::LengthMismatch),
        };
        let spatial_id = match bytes.get(offset + 13).copied() {
            Some(value) => value,
            None => return Err(WireError::LengthMismatch),
        };
        let temporal_id = match bytes.get(offset + 14).copied() {
            Some(value) => value,
            None => return Err(WireError::LengthMismatch),
        };
        if spatial_id > 3 || temporal_id > 7 {
            return Err(WireError::FieldRange);
        }
        let payload_length = match read_u32(bytes, offset + 16) {
            Some(value) => value as usize,
            None => return Err(WireError::LengthMismatch),
        };
        if payload_length == 0 {
            return Err(WireError::PayloadEmpty);
        }
        let payload_start = offset + UNIT_HEADER_BYTES;
        let payload_end = payload_start + payload_length;
        let payload = match bytes.get(payload_start..payload_end) {
            Some(slice) => slice.to_vec(),
            None => return Err(WireError::LengthMismatch),
        };
        if let Some(previous_sequence) = previous {
            if sequence_number <= previous_sequence {
                return Err(WireError::UnitOrder);
            }
        }
        previous = Some(sequence_number);
        units.push(Unit {
            sequence_number,
            capture_timestamp_us,
            flags,
            spatial_id,
            temporal_id,
            payload,
        });
        offset = payload_end;
    }
    if offset != bytes.len() {
        return Err(WireError::LengthMismatch);
    }
    Ok(MediaMessage { channel, sender_id, units })
}

/// 破棄優先順位。wire-format.md 1.4 の判定順序をそのまま実装する。
/// None は破棄禁止を意味する。
pub fn drop_priority(channel: u8, flags: u8) -> Option<u8> {
    if channel == CHANNEL_AUDIO || channel == CHANNEL_SCREEN_AUDIO {
        return None;
    }
    if flags & FLAG_KEY != 0 {
        return None;
    }
    let discardable = flags & FLAG_DISCARDABLE != 0;
    let screen = flags & FLAG_SCREEN_CONTENT != 0;
    let speaker = flags & FLAG_ACTIVE_SPEAKER != 0;
    if discardable && screen {
        return Some(3);
    }
    if discardable && speaker {
        return Some(2);
    }
    if discardable {
        return Some(1);
    }
    if speaker {
        return Some(5);
    }
    Some(4)
}

/// DISCARDABLE の算出。独自判断を書かず規範の規則をそのまま実装する。
pub fn compute_discardable(
    channel: u8,
    is_key_frame: bool,
    temporal_id: u8,
    temporal_layer_count: u8,
) -> bool {
    if channel == CHANNEL_AUDIO || channel == CHANNEL_SCREEN_AUDIO {
        return false;
    }
    if is_key_frame {
        return false;
    }
    if temporal_layer_count <= 1 {
        return false;
    }
    temporal_id == temporal_layer_count - 1
}
