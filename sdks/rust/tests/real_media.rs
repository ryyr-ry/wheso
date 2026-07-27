//! 実音声映像の照合（Rust、段 A の実データ版）。
//!
//! 合成したベクタではなく、**実際に符号化された AV1 と Opus**（spec/vectors/real-media.json）に
//! 対して、ワイヤ形式の符号化・復号が往復で一致し、破棄可否と破棄優先順位の判断が
//! 凍結資産と一致することを確かめる。同じ資産を 6 言語すべてが照合する。
//!
//! 資産を実装に合わせて変更してはならない（ADR-0012）。

use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use wheso_client::wire::{
    compute_discardable, decode_media_message, drop_priority, encode_media_message, MediaMessage, Unit,
};

fn asset_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop();
    path.pop();
    path.push("spec");
    path.push("vectors");
    path.push("real-media.json");
    path
}

fn hex_to_bytes(hex: &str) -> Vec<u8> {
    let chars: Vec<char> = hex.chars().collect();
    let mut bytes = Vec::with_capacity(chars.len() / 2);
    let mut index = 0;
    while index + 1 < chars.len() {
        let high = chars[index].to_digit(16).unwrap_or(0);
        let low = chars[index + 1].to_digit(16).unwrap_or(0);
        let value = (high * 16 + low) as u8;
        bytes.push(value);
        index += 2;
    }
    bytes
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn read_asset() -> Value {
    let text = match fs::read_to_string(asset_path()) {
        Ok(value) => value,
        Err(error) => panic!("資産を読めない: {error}"),
    };
    match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => panic!("資産を解析できない: {error}"),
    }
}

fn integer(value: &Value, key: &str) -> i64 {
    match value.get(key).and_then(Value::as_i64) {
        Some(found) => found,
        None => panic!("{key} が整数ではない"),
    }
}

fn text(value: &Value, key: &str) -> String {
    match value.get(key).and_then(Value::as_str) {
        Some(found) => found.to_string(),
        None => panic!("{key} が文字列ではない"),
    }
}

fn boolean(value: &Value, key: &str) -> bool {
    match value.get(key).and_then(Value::as_bool) {
        Some(found) => found,
        None => panic!("{key} が真偽値ではない"),
    }
}

#[test]
fn real_video_encodes_to_frozen_bytes_and_round_trips() {
    let asset = read_asset();
    let sender_id = integer(&asset, "senderId");
    let video = match asset.get("video") {
        Some(value) => value,
        None => panic!("video が無い"),
    };
    let framerate = integer(video, "framerate");
    let channel = integer(video, "channel");
    let frames = match video.get("frames").and_then(Value::as_array) {
        Some(value) => value,
        None => panic!("frames が無い"),
    };
    assert!(frames.len() >= 30, "映像が 30 枚以上ある（実際 {}）", frames.len());

    let mut checked = 0_usize;
    for frame in frames {
        let sequence_number = integer(frame, "sequenceNumber");
        let payload_hex = text(frame, "payloadHex");
        let unit = Unit {
            sequence_number: u32::try_from(sequence_number).unwrap_or(0),
            capture_timestamp_us: u64::try_from((sequence_number - 1) * 1_000_000 / framerate).unwrap_or(0),
            flags: u8::try_from(integer(frame, "expectedFlags")).unwrap_or(0),
            spatial_id: u8::try_from(integer(frame, "spatialId")).unwrap_or(0),
            temporal_id: u8::try_from(integer(frame, "temporalId")).unwrap_or(0),
            payload: hex_to_bytes(&payload_hex),
        };
        let message = MediaMessage {
            channel: u8::try_from(channel).unwrap_or(1),
            sender_id: u32::try_from(sender_id).unwrap_or(0),
            units: vec![unit],
        };
        let encoded = match encode_media_message(&message) {
            Ok(value) => value,
            Err(error) => panic!("映像 {sequence_number} の符号化に失敗した: {error:?}"),
        };
        assert_eq!(
            bytes_to_hex(&encoded),
            text(frame, "expectedMessageHex"),
            "映像 {sequence_number} のバイト列が資産と一致する"
        );

        let decoded = match decode_media_message(&encoded) {
            Ok(value) => value,
            Err(error) => panic!("映像 {sequence_number} の復号に失敗した: {error:?}"),
        };
        let first = match decoded.units.first() {
            Some(value) => value,
            None => panic!("復号したユニットが無い"),
        };
        assert_eq!(bytes_to_hex(&first.payload), payload_hex, "ペイロードが往復する");
        checked += 1;
    }
    assert!(checked >= 30, "30 枚以上を照合した（実際 {checked}）");
}

#[test]
fn real_video_decisions_match_frozen_asset() {
    let asset = read_asset();
    let video = match asset.get("video") {
        Some(value) => value,
        None => panic!("video が無い"),
    };
    let temporal_layers = integer(video, "temporalLayers");
    let channel = integer(video, "channel");
    let frames = match video.get("frames").and_then(Value::as_array) {
        Some(value) => value,
        None => panic!("frames が無い"),
    };

    let mut discardable_count = 0_usize;
    for frame in frames {
        let flags = u8::try_from(integer(frame, "expectedFlags")).unwrap_or(0);
        let discardable = compute_discardable(
            u8::try_from(channel).unwrap_or(1),
            boolean(frame, "keyFrame"),
            u8::try_from(integer(frame, "temporalId")).unwrap_or(0),
            u8::try_from(temporal_layers).unwrap_or(1),
        );
        assert_eq!(
            discardable,
            boolean(frame, "expectedDiscardable"),
            "破棄可否が資産と一致する"
        );
        if discardable {
            discardable_count += 1;
        }
        let priority = drop_priority(u8::try_from(channel).unwrap_or(1), flags);
        let expected = frame.get("expectedDropPriority");
        match expected {
            Some(Value::Null) | None => assert_eq!(priority, None, "破棄禁止が一致する"),
            Some(value) => {
                let wanted = value.as_i64().unwrap_or(-1);
                assert_eq!(priority.map(i64::from), Some(wanted), "優先順位が一致する");
            }
        }
    }
    // 最上位の時間層は破棄可能である。1 枚も無ければ判断を検証していない。
    assert!(discardable_count > 0, "破棄可能なフレームがある（実際 {discardable_count} 枚）");
}

#[test]
fn real_audio_bundles_match_frozen_bytes_and_never_droppable() {
    let asset = read_asset();
    let sender_id = integer(&asset, "senderId");
    let audio = match asset.get("audio") {
        Some(value) => value,
        None => panic!("audio が無い"),
    };
    let frame_ms = integer(audio, "frameMs");
    let units_per_message = integer(audio, "unitsPerMessage");
    let channel = integer(audio, "channel");
    let bundles = match audio.get("bundles").and_then(Value::as_array) {
        Some(value) => value,
        None => panic!("bundles が無い"),
    };
    assert!(bundles.len() >= 20, "音声束が 20 個以上ある（実際 {}）", bundles.len());

    let mut checked = 0_usize;
    for (index, bundle) in bundles.iter().enumerate() {
        let payloads = match bundle.get("payloadsHex").and_then(Value::as_array) {
            Some(value) => value,
            None => panic!("payloadsHex が無い"),
        };
        assert_eq!(
            i64::try_from(payloads.len()).unwrap_or(0),
            units_per_message,
            "束ねる数が規範どおりである"
        );
        let first_sequence = integer(bundle, "firstSequenceNumber");
        let flags = u8::try_from(integer(bundle, "expectedFlags")).unwrap_or(0);

        let mut units = Vec::with_capacity(payloads.len());
        for (offset, payload) in payloads.iter().enumerate() {
            let hex = match payload.as_str() {
                Some(value) => value,
                None => panic!("payloadsHex の要素が文字列ではない"),
            };
            let position = i64::try_from(index).unwrap_or(0) * units_per_message
                + i64::try_from(offset).unwrap_or(0);
            units.push(Unit {
                sequence_number: u32::try_from(first_sequence + i64::try_from(offset).unwrap_or(0)).unwrap_or(0),
                capture_timestamp_us: u64::try_from(position * frame_ms * 1000).unwrap_or(0),
                flags,
                spatial_id: 0,
                temporal_id: 0,
                payload: hex_to_bytes(hex),
            });
        }
        let message = MediaMessage {
            channel: u8::try_from(channel).unwrap_or(2),
            sender_id: u32::try_from(sender_id).unwrap_or(0),
            units,
        };
        let encoded = match encode_media_message(&message) {
            Ok(value) => value,
            Err(error) => panic!("音声束 {index} の符号化に失敗した: {error:?}"),
        };
        assert_eq!(
            bytes_to_hex(&encoded),
            text(bundle, "expectedMessageHex"),
            "音声束 {index} のバイト列が資産と一致する"
        );
        let decoded = match decode_media_message(&encoded) {
            Ok(value) => value,
            Err(error) => panic!("音声束 {index} の復号に失敗した: {error:?}"),
        };
        assert_eq!(
            i64::try_from(decoded.units.len()).unwrap_or(0),
            units_per_message,
            "ユニット数が往復する"
        );

        // 音声は決して破棄しない（規範）。
        assert_eq!(
            drop_priority(u8::try_from(channel).unwrap_or(2), flags),
            None,
            "音声は破棄禁止である"
        );
        assert!(
            !compute_discardable(u8::try_from(channel).unwrap_or(2), false, 0, 1),
            "音声は破棄可能にならない"
        );
        checked += 1;
    }
    assert!(checked >= 20, "20 束以上を照合した（実際 {checked}）");
}
