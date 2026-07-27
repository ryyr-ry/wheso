//! トレースベクタの照合（層 2: 決定同一）。
//!
//! 凍結トレース（spec/vectors/trace-shard.jsonl）を Rust の判断コアへ流し、
//! 出力コマンド列が TypeScript の参照実装と**完全に一致**することを確かめる。
//! 1 コマンドの相違も許さない（conformance.md 4.4）。
//!
//! 相違した場合はベクタではなく実装を直す（ADR-0012）。

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use wheso_client::shard_core::{initial_state, step, ShardCommand, ShardEvent};

fn trace_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop();
    path.pop();
    path.push("spec");
    path.push("vectors");
    path.push("trace-shard.jsonl");
    path
}

/// 入力行を ShardEvent に変換する。未知の種類は None（ベクタに無いはずである）。
fn to_event(input: &Value) -> Option<ShardEvent> {
    let kind = input.get("kind")?.as_str()?;
    match kind {
        "media" => Some(ShardEvent::Media {
            from: input.get("from")?.as_i64()?,
            ch: input.get("ch")?.as_i64()?,
            sid: input.get("sid")?.as_i64()?,
            tid: input.get("tid")?.as_i64()?,
            key: input.get("key").and_then(Value::as_bool).unwrap_or(false),
            bytes: input.get("bytes")?.as_i64()?,
            flags: input.get("flags")?.as_i64()?,
        }),
        "subscribe" => Some(ShardEvent::Subscribe {
            from: input.get("from")?.as_i64()?,
            to: input.get("to")?.as_i64()?,
            want: input.get("want")?.as_bool()?,
            max_spatial_id: input.get("maxSpatialId")?.as_i64()?,
        }),
        "join" => Some(ShardEvent::Join { id: input.get("id")?.as_i64()? }),
        "leave" => Some(ShardEvent::Leave { id: input.get("id")?.as_i64()? }),
        "link" => Some(ShardEvent::Link {
            peer: input.get("peer").and_then(Value::as_i64).unwrap_or(0),
            state: input
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        }),
        "timer" => Some(ShardEvent::Timer),
        "budget" => Some(ShardEvent::Budget {
            bytes_per_sec: input.get("bytesPerSec")?.as_i64()?,
        }),
        "report" => {
            let samples = input.get("delayUs")?.as_array()?;
            let mut delay_us = Vec::with_capacity(samples.len());
            for sample in samples {
                delay_us.push(sample.as_i64()?);
            }
            Some(ShardEvent::Report {
                from: input.get("from")?.as_i64()?,
                delay_us,
            })
        }
        _ => None,
    }
}

/// 出力コマンドを、ベクタと同じ形の JSON にする。
fn to_json(command: &ShardCommand) -> Value {
    match command {
        ShardCommand::Forward { to } => json!({ "kind": "forward", "to": to }),
        ShardCommand::Drop { priority, count } => {
            json!({ "kind": "drop", "priority": priority, "count": count })
        }
        ShardCommand::Notify { code } => json!({ "kind": "notify", "code": code }),
    }
}

#[test]
fn frozen_trace_matches_typescript_reference() {
    let text = match fs::read_to_string(trace_path()) {
        Ok(text) => text,
        Err(error) => panic!("トレースを読めない: {error}"),
    };
    let mut lines = text.lines();
    let header = lines.next().unwrap_or("");
    let header_value: Value = match serde_json::from_str(header) {
        Ok(value) => value,
        Err(error) => panic!("先頭行を解析できない: {error}"),
    };
    assert_eq!(header_value.get("unit").and_then(Value::as_str), Some("shard"));

    let mut state: Option<_> = None;
    let mut pending: Option<Value> = None;
    let mut compared = 0usize;
    let mut commands_compared = 0usize;

    for (index, line) in lines.enumerate() {
        let record: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error) => panic!("{}行目を解析できない: {error}", index + 2),
        };
        let t = record.get("t").and_then(Value::as_i64).unwrap_or(0);

        if let Some(input) = record.get("in") {
            if state.is_none() {
                state = Some(initial_state(t));
            }
            pending = Some(input.clone());
            continue;
        }

        let expected = match record.get("out").and_then(Value::as_array) {
            Some(array) => array.clone(),
            None => continue,
        };
        let input = match pending.take() {
            Some(value) => value,
            None => panic!("{}行目: 対応する in が無い", index + 2),
        };
        let event = match to_event(&input) {
            Some(event) => event,
            None => panic!("{}行目: 未知の入力 {input}", index + 2),
        };
        let current = match state.take() {
            Some(value) => value,
            None => initial_state(t),
        };
        let result = step(&current, &event, t);
        state = Some(result.state);

        let actual: Vec<Value> = result.commands.iter().map(to_json).collect();
        assert_eq!(
            actual.len(),
            expected.len(),
            "{}行目: 出力コマンドの数が一致する（入力 {input}）",
            index + 2
        );
        for (position, expected_command) in expected.iter().enumerate() {
            assert_eq!(
                actual.get(position),
                Some(expected_command),
                "{}行目の {position} 番目のコマンドが一致する",
                index + 2
            );
            commands_compared += 1;
        }
        compared += 1;
    }

    assert!(compared > 100, "十分な数の入力を照合する（実際 {compared}）");
    assert!(commands_compared > 50, "出力コマンドも照合する（実際 {commands_compared}）");
}
