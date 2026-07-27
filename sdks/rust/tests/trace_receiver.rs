//! 受信ノードのトレースベクタの照合（層 2: 決定同一）。
//!
//! 凍結トレース（spec/vectors/trace-receiver.jsonl）を Rust の判断コアへ流し、
//! 出力コマンド列が TypeScript の参照実装と**完全に一致**することを確かめる。
//! 1 コマンドの相違も許さない（conformance.md 4.4）。
//!
//! 相違した場合はベクタではなく実装を直す（ADR-0012）。

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use wheso_client::receiver_core::{
    initial_receiver_state, receiver_step, ReceiverCommand, ReceiverEvent, SubscribeEntry,
};

fn trace_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop();
    path.pop();
    path.push("spec");
    path.push("vectors");
    path.push("trace-receiver.jsonl");
    path
}

/// 入力行を ReceiverEvent に変換する。未知の種類は None（ベクタに無いはずである）。
fn to_event(input: &Value) -> Option<ReceiverEvent> {
    let kind = input.get("kind")?.as_str()?;
    match kind {
        "subscribe" => {
            let raw = input.get("entries")?.as_array()?;
            let mut entries = Vec::with_capacity(raw.len());
            for entry in raw {
                entries.push(SubscribeEntry {
                    sender_id: entry.get("senderId")?.as_i64()?,
                    channel: entry.get("channel")?.as_i64()?,
                    max_spatial_id: entry.get("maxSpatialId")?.as_i64()?,
                    max_temporal_id: entry.get("maxTemporalId")?.as_i64()?,
                });
            }
            Some(ReceiverEvent::Subscribe { entries })
        }
        "leave" => Some(ReceiverEvent::Leave { id: input.get("id")?.as_i64()? }),
        "visibility" => Some(ReceiverEvent::Visibility { visible: input.get("visible")?.as_bool()? }),
        "budget" => Some(ReceiverEvent::Budget { bytes_per_sec: input.get("bytesPerSec")?.as_i64()? }),
        "activeSpeaker" => {
            // null は「発話者なし」を意味する。欄の欠落と区別する。
            let value = input.get("id")?;
            let id = if value.is_null() { None } else { Some(value.as_i64()?) };
            Some(ReceiverEvent::ActiveSpeaker { id })
        }
        "displaySize" => Some(ReceiverEvent::DisplaySize {
            sender_id: input.get("senderId")?.as_i64()?,
            channel: input.get("channel")?.as_i64()?,
            width: input.get("width")?.as_i64()?,
        }),
        "report" => {
            let samples = input.get("delayUs")?.as_array()?;
            let mut delay_us = Vec::with_capacity(samples.len());
            for sample in samples {
                delay_us.push(sample.as_i64()?);
            }
            Some(ReceiverEvent::Report { delay_us })
        }
        "media" => Some(ReceiverEvent::Media {
            from: input.get("from")?.as_i64()?,
            ch: input.get("ch")?.as_i64()?,
            sid: input.get("sid")?.as_i64()?,
            tid: input.get("tid")?.as_i64()?,
            key: input.get("key").and_then(Value::as_bool).unwrap_or(false),
            bytes: input.get("bytes").and_then(Value::as_i64).unwrap_or(0),
            flags: input.get("flags").and_then(Value::as_i64).unwrap_or(0),
            seq: input.get("seq").and_then(Value::as_i64).unwrap_or(0),
        }),
        "timer" => Some(ReceiverEvent::Timer),
        _ => None,
    }
}

/// 出力コマンドを TypeScript と同じ JSON 表現へ写す。欄名も順序も一致させる。
fn to_json(command: &ReceiverCommand) -> Value {
    match command {
        ReceiverCommand::SubscribeChange { to, channel, want, max_spatial_id, max_temporal_id } => json!({
            "kind": "subscribeChange",
            "to": to,
            "channel": channel,
            "want": want,
            "maxSpatialId": max_spatial_id,
            "maxTemporalId": max_temporal_id
        }),
        ReceiverCommand::KeyframeRequest { for_id, channel, spatial_id } => json!({
            "kind": "keyframeRequest",
            "for": for_id,
            "channel": channel,
            "spatialId": spatial_id
        }),
        ReceiverCommand::SetTier { for_id, channel, tier } => json!({
            "kind": "setTier",
            "for": for_id,
            "channel": channel,
            "tier": tier
        }),
        ReceiverCommand::Forward { to } => json!({ "kind": "forward", "to": to }),
        ReceiverCommand::Drop { priority, count } => {
            json!({ "kind": "drop", "priority": priority, "count": count })
        }
        ReceiverCommand::Notify { code } => json!({ "kind": "notify", "code": code }),
        ReceiverCommand::Ack { sender_id, channel, spatial_id, highest_seq } => json!({
            "kind": "ack",
            "senderId": sender_id,
            "channel": channel,
            "spatialId": spatial_id,
            "highestSeq": highest_seq
        }),
    }
}

/// 予算の初期値。生成器（tools/traces-receiver.ts）と一致させる必要がある。
/// 一致しなければ最初の再配分から出力が分かれる。
const INITIAL_BUDGET_BYTES_PER_SEC: i64 = 7_000_000;

#[test]
fn frozen_receiver_trace_matches_typescript_reference() {
    let text = match fs::read_to_string(trace_path()) {
        Ok(value) => value,
        Err(error) => {
            panic!("トレースベクタを読めない: {error}");
        }
    };
    let mut lines = text.lines();

    let header_line = lines.next().unwrap_or("");
    let header: Value = match serde_json::from_str(header_line) {
        Ok(value) => value,
        Err(error) => panic!("見出し行を解析できない: {error}"),
    };
    assert_eq!(header.get("unit").and_then(Value::as_str), Some("receiver"), "受信ノードのトレースである");

    let mut state = initial_receiver_state(INITIAL_BUDGET_BYTES_PER_SEC);
    let mut pending: Option<ReceiverEvent> = None;
    let mut checked = 0_usize;

    for (index, line) in lines.enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let row: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error) => panic!("{} 行目を解析できない: {error}", index + 2),
        };
        if let Some(input) = row.get("in") {
            pending = to_event(input);
            assert!(pending.is_some(), "{}行目の入力を解釈できる: {input}", index + 2);
            continue;
        }
        let expected = match row.get("out").and_then(Value::as_array) {
            Some(value) => value,
            None => continue,
        };
        let event = match pending.take() {
            Some(value) => value,
            None => panic!("{}行目に対応する入力が無い", index + 2),
        };
        let result = receiver_step(&state, &event);
        state = result.state;
        let actual: Vec<Value> = result.commands.iter().map(to_json).collect();
        assert_eq!(
            &actual,
            expected,
            "{}行目の出力コマンド列が一致する（入力 {event:?}）",
            index + 2
        );
        checked += 1;
    }

    assert!(checked > 100, "十分な行数を照合した（実際 {checked}）");
}
