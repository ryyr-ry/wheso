//! 適合試験（段 A）。
//!
//! 凍結ベクタ（spec/vectors）に対して TypeScript の参照実装と同一の結果を出すことを確かめる。
//! ベクタを実装に合わせて変更してはならない。実装を直す（ADR-0012）。
//!
//! 実行: cargo test（sdks/rust で）

use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use wheso_client::{
    compute_discardable, create_prng, decode_media_message, delay_slope, drop_priority,
    encode_media_message, is_degrading, is_recovering, next, trunc_div, MediaMessage, Unit,
};

/// 凍結ベクタの位置。リポジトリの spec/vectors を参照する。
fn vector_path(name: &str) -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop();
    path.pop();
    path.push("spec");
    path.push("vectors");
    path.push(name);
    path
}

fn read_vector(name: &str) -> Value {
    let text = match fs::read_to_string(vector_path(name)) {
        Ok(text) => text,
        Err(error) => panic!("ベクタを読めない: {name}: {error}"),
    };
    match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => panic!("ベクタを解析できない: {name}: {error}"),
    }
}

fn hex_to_bytes(hex: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(hex.len() / 2);
    let chars: Vec<char> = hex.chars().collect();
    let mut index = 0;
    while index + 1 < chars.len() {
        let high = chars[index].to_digit(16).unwrap_or(0) as u8;
        let low = chars[index + 1].to_digit(16).unwrap_or(0) as u8;
        bytes.push((high << 4) | low);
        index += 2;
    }
    bytes
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

#[test]
fn prng_matches_frozen_vectors() {
    let vectors = read_vector("prng.json");
    let entries = vectors["vectors"].as_array().expect("vectors は配列である");
    assert!(!entries.is_empty(), "ベクタが空でない");
    for entry in entries {
        let seed_text = entry["seed"].as_str().expect("seed は文字列である");
        let seed: u64 = seed_text.parse().expect("seed を解析できる");
        let expected = entry["outputs"].as_array().expect("outputs は配列である");

        let created = create_prng(seed);
        if seed == 0 {
            assert!(created.is_err(), "種 0 は失敗する");
            continue;
        }
        let mut state = created.expect("擬似乱数器を作れる");
        for (index, expected_output) in expected.iter().enumerate() {
            let (nextState, output) = next(state).expect("状態遷移できる");
            state = nextState;
            let expected_value: u64 = expected_output
                .as_str()
                .expect("出力は文字列である")
                .parse()
                .expect("出力を解析できる");
            assert_eq!(output, expected_value, "seed={seed} の {index} 番目が一致する");
        }
    }
}

#[test]
fn prng_rejects_zero_seed() {
    assert!(create_prng(0).is_err(), "種 0 は禁止である");
}

#[test]
fn media_vectors_round_trip() {
    let vectors = read_vector("media.json");
    let entries = vectors.as_array().expect("配列である");
    assert!(!entries.is_empty());
    for entry in entries {
        let name = entry["name"].as_str().unwrap_or("(名前なし)");
        let expected_hex = entry["bytesHex"].as_str().expect("bytesHex がある");
        let message = &entry["message"];

        let mut units: Vec<Unit> = Vec::new();
        for unit in message["units"].as_array().expect("units は配列である") {
            units.push(Unit {
                sequence_number: unit["sequenceNumber"].as_u64().unwrap_or(0) as u32,
                capture_timestamp_us: unit["captureTimestampUs"]
                    .as_str()
                    .unwrap_or("0")
                    .parse()
                    .unwrap_or(0),
                flags: unit["flags"].as_u64().unwrap_or(0) as u8,
                spatial_id: unit["spatialId"].as_u64().unwrap_or(0) as u8,
                temporal_id: unit["temporalId"].as_u64().unwrap_or(0) as u8,
                payload: hex_to_bytes(unit["payloadHex"].as_str().unwrap_or("")),
            });
        }
        let built = MediaMessage {
            channel: message["channel"].as_u64().unwrap_or(0) as u8,
            sender_id: message["senderId"].as_u64().unwrap_or(0) as u32,
            units,
        };

        // 符号化がベクタのバイト列と一致する（層 1: ビット同一）
        let encoded = encode_media_message(&built).expect("符号化できる");
        assert_eq!(bytes_to_hex(&encoded), expected_hex, "{name}: 符号化が一致する");

        // 復号して同じ内容に戻る
        let decoded = decode_media_message(&hex_to_bytes(expected_hex)).expect("復号できる");
        assert_eq!(decoded, built, "{name}: 復号が一致する");
    }
}

#[test]
fn invalid_vectors_reject_with_same_error() {
    let vectors = read_vector("invalid.json");
    let entries = vectors.as_array().expect("配列である");
    assert!(!entries.is_empty());
    for entry in entries {
        let name = entry["name"].as_str().unwrap_or("(名前なし)");
        let bytes = hex_to_bytes(entry["bytesHex"].as_str().unwrap_or(""));
        let expected = entry["expectedErrorCode"].as_str().unwrap_or("");
        match decode_media_message(&bytes) {
            Ok(_) => panic!("{name}: 受理してはならない"),
            Err(error) => assert_eq!(error.name(), expected, "{name}: 同じエラーで拒否する"),
        }
    }
}

#[test]
fn drop_order_matches_frozen_vectors() {
    let vectors = read_vector("drop-order.json");
    let entries = vectors.as_array().expect("配列である");
    assert!(!entries.is_empty());
    for entry in entries {
        let name = entry["name"].as_str().unwrap_or("(名前なし)");
        let channel = entry["channel"].as_u64().unwrap_or(0) as u8;
        let flags = entry["flags"].as_u64().unwrap_or(0) as u8;
        let expected = entry["expectedPriority"].as_u64().map(|value| value as u8);
        assert_eq!(drop_priority(channel, flags), expected, "{name}: 破棄順位が一致する");
    }
}

#[test]
fn discardable_matches_specification() {
    // wire-format.md 1.3 の規則。音声とキーは常に false、最上位の時間層のみ true。
    assert!(!compute_discardable(2, false, 0, 1), "音声は破棄可能にしない");
    assert!(!compute_discardable(1, true, 0, 3), "キーは破棄可能にしない");
    assert!(!compute_discardable(1, false, 1, 3), "最上位でない層は false");
    assert!(compute_discardable(1, false, 2, 3), "最上位の層は true");
    assert!(!compute_discardable(1, false, 0, 1), "単層は false");
}

#[test]
fn slope_and_thresholds_match_specification() {
    // 単調増加は正、一定は 0、減少は負。
    let rising: Vec<i64> = (0..20).map(|i| 10_000 + i * 1_000).collect();
    let flat: Vec<i64> = vec![10_000; 20];
    let falling: Vec<i64> = (0..20).map(|i| 30_000 - i * 1_000).collect();

    assert!(delay_slope(&rising).numerator > 0);
    assert_eq!(delay_slope(&flat).numerator, 0);
    assert!(delay_slope(&falling).numerator < 0);

    assert!(is_degrading(delay_slope(&rising)), "増加は劣化と判定する");
    assert!(!is_degrading(delay_slope(&flat)), "一定は劣化でない");
    assert!(is_recovering(delay_slope(&falling)), "減少は回復と判定する");

    // 分母は常に正である（conformance.md 3.3）。
    assert!(delay_slope(&rising).denominator > 0);
}

#[test]
fn trunc_div_rejects_zero_and_out_of_range() {
    assert_eq!(trunc_div(10, 3), Ok(3));
    assert_eq!(trunc_div(-10, 3), Ok(-3));
    assert!(trunc_div(10, 0).is_err(), "0 除算は失敗する");
    assert!(trunc_div(i64::MAX, 3).is_err(), "安全整数域を超える値は失敗する");
}
