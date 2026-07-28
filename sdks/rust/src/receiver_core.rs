//! 受信ノード（receiver）の判断コア（Rust）。
//!
//! 規範: state-machines.md 2 節（購読と tier）、congestion.md 4.3（tier の選択）、
//! conformance.md 4 節（入力イベントと出力コマンド）。
//!
//! TypeScript の参照実装（`packages/core/src/receiver-core.ts`）と**同一の出力**を
//! 返さなければならない。照合は凍結トレース（spec/vectors/trace-receiver.jsonl）で行う。
//! 相違した場合はベクタではなく実装を直す（ADR-0012）。
//!
//! sans-IO の純関数である。時刻・乱数・浮動小数点・入出力・並行に触れない。

use crate::fixed::{delay_slope, trunc_div, Slope};
use crate::generated::constants::{
    RATE_HOLD_MS,
    RATE_PROBE_BPS,
    RATE_RECOVER_STREAK,
    DISPLAY_SIZE_UNSPECIFIED_SPATIAL_ID, SHARD_TREND_ENTER_T2_DEN, SHARD_TREND_ENTER_T2_NUM,
    SHARD_TREND_EXIT_DEN, SHARD_TREND_EXIT_NUM, V_360P15_SPATIAL_ID, V_360P15_TARGET_BITRATE,
    V_4K60_SPATIAL_ID, V_4K60_TARGET_BITRATE,
};

/// 品質低下の警告。文言は利用側が国際化キーから作る（sdk-api.md 6 節）。
const DEGRADED_WARNING: &str = "W_DEGRADED";

/// 受信者自身の識別子。転送先は常にこの 1 人である。
pub const RECEIVER_SELF_ID: i64 = 0;

/// (senderId, channel) ごとの購読状態（state-machines.md 2 節）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamPhase {
    Unsubscribed,
    Subscribed,
    Paused,
}

/// 1 本のストリームの状態。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamState {
    pub sender_id: i64,
    pub channel: i64,
    pub phase: StreamPhase,
    /// 現在要求している最大 spatialId。
    pub spatial_id: i64,
    /// 現在要求している最大 temporalId。
    pub temporal_id: i64,
    /// 利用側が申告した表示寸法（論理画素）。未申告は 0。
    pub display_width: i64,
}

/// 受信済みの位置。ack の内容になる。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReceivedMark {
    pub sender_id: i64,
    pub channel: i64,
    pub spatial_id: i64,
    pub highest_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiverState {
    /// sender_id, channel の昇順で保持する。反復順序が判断に影響するため決定的にする。
    pub streams: Vec<StreamState>,
    pub visible: bool,
    pub target_bytes_per_sec: i64,
    pub active_speaker_id: Option<i64>,
    pub trend: Slope,
    pub degraded: bool,
    /// 次に減少の判定を行える時刻（AIMD。congestion 4.2）。
    pub rate_hold_until_ms: i64,
    /// 回復判定が連続した回数。規範は 3 回連続で加算的増加を許す。
    pub recover_streak: i64,
    /// 目標ビットレートの上限（bytes/sec）。加算的増加はこれを超えない。
    pub target_ceiling_bytes_per_sec: i64,
    pub unexpected_events: Vec<String>,
    /// sender_id, channel, spatial_id の昇順で保持する。
    pub received: Vec<ReceivedMark>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubscribeEntry {
    pub sender_id: i64,
    pub channel: i64,
    pub max_spatial_id: i64,
    pub max_temporal_id: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiverEvent {
    Subscribe {
        entries: Vec<SubscribeEntry>,
    },
    Leave {
        id: i64,
    },
    Visibility {
        visible: bool,
    },
    Budget {
        bytes_per_sec: i64,
    },
    ActiveSpeaker {
        id: Option<i64>,
    },
    DisplaySize {
        sender_id: i64,
        channel: i64,
        width: i64,
    },
    Report {
        delay_us: Vec<i64>,
    },
    Media {
        from: i64,
        ch: i64,
        sid: i64,
        tid: i64,
        key: bool,
        bytes: i64,
        flags: i64,
        /// 受信した sequenceNumber。ack の算出に使う。既定は 0（不明）。
        seq: i64,
    },
    Timer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiverCommand {
    SubscribeChange {
        to: i64,
        channel: i64,
        want: bool,
        max_spatial_id: i64,
        max_temporal_id: i64,
    },
    KeyframeRequest {
        for_id: i64,
        channel: i64,
        spatial_id: i64,
    },
    SetTier {
        for_id: i64,
        channel: i64,
        tier: i64,
    },
    Forward {
        to: Vec<i64>,
    },
    Drop {
        priority: i64,
        count: i64,
    },
    Notify {
        code: String,
    },
    Ack {
        sender_id: i64,
        channel: i64,
        spatial_id: i64,
        highest_seq: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiverStepResult {
    pub state: ReceiverState,
    pub commands: Vec<ReceiverCommand>,
}

pub fn initial_receiver_state(target_bytes_per_sec: i64) -> ReceiverState {
    ReceiverState {
        streams: Vec::new(),
        visible: true,
        target_bytes_per_sec,
        active_speaker_id: None,
        trend: Slope { numerator: 0, denominator: 1 },
        degraded: false,
        rate_hold_until_ms: 0,
        recover_streak: 0,
        target_ceiling_bytes_per_sec: target_bytes_per_sec,
        unexpected_events: Vec::new(),
        received: Vec::new(),
    }
}

/// 純関数の状態遷移。
/// 純関数の状態遷移。時刻は AIMD の待ち（RATE_HOLD_MS）に使う。
pub fn receiver_step(state: &ReceiverState, event: &ReceiverEvent, t: i64) -> ReceiverStepResult {
    match event {
        ReceiverEvent::Subscribe { entries } => handle_subscribe(state, entries),
        ReceiverEvent::Leave { id } => handle_leave(state, *id),
        ReceiverEvent::Visibility { visible } => handle_visibility(state, *visible),
        ReceiverEvent::Budget { bytes_per_sec } => {
            let mut next = state.clone();
            next.target_bytes_per_sec = *bytes_per_sec;
            reallocate(next)
        }
        ReceiverEvent::ActiveSpeaker { id } => {
            let mut next = state.clone();
            next.active_speaker_id = *id;
            reallocate(next)
        }
        ReceiverEvent::DisplaySize { sender_id, channel, width } => {
            handle_display_size(state, *sender_id, *channel, *width)
        }
        ReceiverEvent::Report { delay_us } => handle_report(state, delay_us, t),
        ReceiverEvent::Media { from, ch, sid, tid, seq, .. } => handle_media(
            state,
            MediaInput { from: *from, ch: *ch, sid: *sid, tid: *tid, seq: *seq },
        ),
        ReceiverEvent::Timer => {
            // ACK_INTERVAL_MS ごとに、受信済みの位置を ack として返す。
            // 呼び出し側が周期を管理する（コアは時刻を持たない）。
            let commands = state
                .received
                .iter()
                .map(|mark| ReceiverCommand::Ack {
                    sender_id: mark.sender_id,
                    channel: mark.channel,
                    spatial_id: mark.spatial_id,
                    highest_seq: mark.highest_seq,
                })
                .collect();
            ReceiverStepResult { state: state.clone(), commands }
        }
    }
}

/// メディアの入力。判断に使う欄のみを持つ。
///
/// `key` / `bytes` / `flags` は受信ノードの判断に影響しない（層と tier のみで決まる）。
/// 持たないことで「使っていない」ことが型から分かる。
struct MediaInput {
    from: i64,
    ch: i64,
    sid: i64,
    tid: i64,
    seq: i64,
}

fn stream_order(a: &StreamState, b: &StreamState) -> std::cmp::Ordering {
    (a.sender_id, a.channel).cmp(&(b.sender_id, b.channel))
}

fn entry_order(a: &SubscribeEntry, b: &SubscribeEntry) -> std::cmp::Ordering {
    (a.sender_id, a.channel).cmp(&(b.sender_id, b.channel))
}

fn find_stream(state: &ReceiverState, sender_id: i64, channel: i64) -> Option<StreamState> {
    state
        .streams
        .iter()
        .find(|stream| stream.sender_id == sender_id && stream.channel == channel)
        .copied()
}

/// spatialId の範囲は最低品質から最高品質までである。
fn clamp_spatial(value: i64) -> i64 {
    if value < V_360P15_SPATIAL_ID {
        return V_360P15_SPATIAL_ID;
    }
    if value > V_4K60_SPATIAL_ID {
        return V_4K60_SPATIAL_ID;
    }
    value
}

/// 購読一覧の適用。表 1 行目と 2 行目に対応する。
fn handle_subscribe(state: &ReceiverState, entries: &[SubscribeEntry]) -> ReceiverStepResult {
    let mut commands: Vec<ReceiverCommand> = Vec::new();
    let mut kept: Vec<StreamState> = Vec::new();

    let mut sorted: Vec<SubscribeEntry> = entries.to_vec();
    sorted.sort_by(entry_order);

    for entry in &sorted {
        let existing = find_stream(state, entry.sender_id, entry.channel);
        let unsubscribed = match existing {
            None => true,
            Some(stream) => stream.phase == StreamPhase::Unsubscribed,
        };
        if unsubscribed {
            commands.push(ReceiverCommand::SubscribeChange {
                to: entry.sender_id,
                channel: entry.channel,
                want: true,
                max_spatial_id: entry.max_spatial_id,
                max_temporal_id: entry.max_temporal_id,
            });
            commands.push(ReceiverCommand::KeyframeRequest {
                for_id: entry.sender_id,
                channel: entry.channel,
                spatial_id: entry.max_spatial_id,
            });
            kept.push(StreamState {
                sender_id: entry.sender_id,
                channel: entry.channel,
                phase: StreamPhase::Subscribed,
                spatial_id: entry.max_spatial_id,
                temporal_id: entry.max_temporal_id,
                display_width: match existing {
                    Some(stream) => stream.display_width,
                    None => 0,
                },
            });
            continue;
        }
        if let Some(stream) = existing {
            kept.push(StreamState { phase: StreamPhase::Subscribed, ..stream });
        }
    }

    // 一覧から外れたものは購読解除する（表 2 行目）。
    for stream in &state.streams {
        let still_wanted = entries
            .iter()
            .any(|entry| entry.sender_id == stream.sender_id && entry.channel == stream.channel);
        if !still_wanted && stream.phase != StreamPhase::Unsubscribed {
            commands.push(ReceiverCommand::SubscribeChange {
                to: stream.sender_id,
                channel: stream.channel,
                want: false,
                max_spatial_id: 0,
                max_temporal_id: 0,
            });
        }
    }

    kept.sort_by(stream_order);
    let mut next = state.clone();
    next.streams = kept;
    let after = reallocate(next);
    let mut merged = commands;
    merged.extend(after.commands);
    ReceiverStepResult { state: after.state, commands: merged }
}

/// 送信者の退出。表 6 行目に対応する。
fn handle_leave(state: &ReceiverState, id: i64) -> ReceiverStepResult {
    let streams: Vec<StreamState> = state
        .streams
        .iter()
        .filter(|stream| stream.sender_id != id)
        .copied()
        .collect();
    if streams.len() == state.streams.len() {
        return ReceiverStepResult { state: state.clone(), commands: Vec::new() };
    }
    // 退出者の受信位置も除去する。残すと居ない相手へ ack を返し続ける。
    let received: Vec<ReceivedMark> = state
        .received
        .iter()
        .filter(|mark| mark.sender_id != id)
        .copied()
        .collect();
    let mut next = state.clone();
    next.streams = streams;
    next.received = received;
    reallocate(next)
}

/// 表示・非表示。表 7 行目と 8 行目に対応する。
fn handle_visibility(state: &ReceiverState, visible: bool) -> ReceiverStepResult {
    if visible == state.visible {
        return ReceiverStepResult { state: state.clone(), commands: Vec::new() };
    }
    let mut commands: Vec<ReceiverCommand> = Vec::new();
    let mut streams: Vec<StreamState> = Vec::new();
    for stream in &state.streams {
        if !visible && stream.phase == StreamPhase::Subscribed {
            // 非表示では購読を解除するが、状態は保持する（PAUSED）。
            commands.push(ReceiverCommand::SubscribeChange {
                to: stream.sender_id,
                channel: stream.channel,
                want: false,
                max_spatial_id: 0,
                max_temporal_id: 0,
            });
            streams.push(StreamState { phase: StreamPhase::Paused, ..*stream });
            continue;
        }
        if visible && stream.phase == StreamPhase::Paused {
            commands.push(ReceiverCommand::SubscribeChange {
                to: stream.sender_id,
                channel: stream.channel,
                want: true,
                max_spatial_id: stream.spatial_id,
                max_temporal_id: stream.temporal_id,
            });
            commands.push(ReceiverCommand::KeyframeRequest {
                for_id: stream.sender_id,
                channel: stream.channel,
                spatial_id: stream.spatial_id,
            });
            streams.push(StreamState { phase: StreamPhase::Subscribed, ..*stream });
            continue;
        }
        streams.push(*stream);
    }
    let mut next = state.clone();
    next.visible = visible;
    next.streams = streams;
    ReceiverStepResult { state: next, commands }
}

/// 表示寸法の申告。未申告の相手は最低品質に留める（ADR-0015）。
fn handle_display_size(
    state: &ReceiverState,
    sender_id: i64,
    channel: i64,
    width: i64,
) -> ReceiverStepResult {
    if find_stream(state, sender_id, channel).is_none() {
        let mut next = state.clone();
        next.unexpected_events.push("displaySize".to_string());
        return ReceiverStepResult { state: next, commands: Vec::new() };
    }
    let streams: Vec<StreamState> = state
        .streams
        .iter()
        .map(|stream| {
            if stream.sender_id == sender_id && stream.channel == channel {
                StreamState { display_width: width, ..*stream }
            } else {
                *stream
            }
        })
        .collect();
    let mut next = state.clone();
    next.streams = streams;
    reallocate(next)
}

/// 測定報告。勾配が劣化閾値を超えたら tier を 1 段下げ、回復閾値を下回ったら 1 段上げる。
/// 遅延の報告に対する応答。規範は 2 つの層を定めている。
///
/// 1. 状態機械（state-machines 3 節）: 遅延勾配が閾値を超えたら tier を 1 段下げる
/// 2. 輻輳制御（congestion 4.2 の AIMD）: target を劣化時に 0.85 倍し、回復が 3 回
///    連続したら RATE_PROBE_BPS を加える（上限を超えない）
///
/// 0.85 は浮動小数点で計算しない。target * 17 / 20 の整数演算とし切り捨てる（ADR-0017）。
fn handle_report(state: &ReceiverState, delay_us: &[i64], t: i64) -> ReceiverStepResult {
    let trend = delay_slope(delay_us);
    let degrading =
        trend.numerator * SHARD_TREND_ENTER_T2_DEN > SHARD_TREND_ENTER_T2_NUM * trend.denominator;
    let recovering =
        trend.numerator * SHARD_TREND_EXIT_DEN < SHARD_TREND_EXIT_NUM * trend.denominator;

    // --- AIMD。target を更新する ---
    let mut target = state.target_bytes_per_sec;
    let mut hold_until = state.rate_hold_until_ms;
    let mut streak = state.recover_streak;
    if degrading {
        streak = 0;
        // 待ちの間は減らさない。1 回の揺れで連続して落とさないためである。
        if t >= state.rate_hold_until_ms {
            // 除算の失敗（分母 0）は起こらないが、結果を無視せず明示的に扱う。
            target = match trunc_div(target * 17, 20) {
                Ok(value) => value,
                Err(_) => target,
            };
            hold_until = t + RATE_HOLD_MS;
        }
    } else if recovering {
        streak = state.recover_streak + 1;
        if streak >= RATE_RECOVER_STREAK {
            let increment = match trunc_div(RATE_PROBE_BPS, 8) {
                Ok(value) => value,
                Err(_) => 0,
            };
            let raised = target + increment;
            target = if raised > state.target_ceiling_bytes_per_sec {
                state.target_ceiling_bytes_per_sec
            } else {
                raised
            };
            streak = 0;
        }
    } else {
        // 増減の条件を満たさない。連続回数を切る。
        streak = 0;
    }

    if !degrading && !recovering {
        let mut next = state.clone();
        next.trend = trend;
        next.target_bytes_per_sec = target;
        next.rate_hold_until_ms = hold_until;
        next.recover_streak = streak;
        return ReceiverStepResult { state: next, commands: Vec::new() };
    }
    let delta: i64 = if degrading { -1 } else { 1 };
    let mut commands: Vec<ReceiverCommand> = Vec::new();
    let mut streams: Vec<StreamState> = Vec::new();
    for stream in &state.streams {
        if stream.phase != StreamPhase::Subscribed {
            streams.push(*stream);
            continue;
        }
        let next_spatial = clamp_spatial(stream.spatial_id + delta);
        if next_spatial == stream.spatial_id {
            streams.push(*stream);
            continue;
        }
        streams.push(StreamState { spatial_id: next_spatial, ..*stream });
        commands.push(ReceiverCommand::SetTier {
            for_id: stream.sender_id,
            channel: stream.channel,
            tier: next_spatial,
        });
        // spatialId が変わる場合のみキーフレームを要求する（表 4 行目と 3 行目の違い）。
        if next_spatial > stream.spatial_id {
            commands.push(ReceiverCommand::KeyframeRequest {
                for_id: stream.sender_id,
                channel: stream.channel,
                spatial_id: next_spatial,
            });
        }
    }
    let mut next = state.clone();
    next.trend = trend;
    next.streams = streams;
    next.target_bytes_per_sec = target;
    next.rate_hold_until_ms = hold_until;
    next.recover_streak = streak;
    ReceiverStepResult { state: next, commands }
}

/// メディアの転送。要求 tier を超えるユニットは転送しない。
fn handle_media(state: &ReceiverState, input: MediaInput) -> ReceiverStepResult {
    let stream = match find_stream(state, input.from, input.ch) {
        None => return ReceiverStepResult { state: state.clone(), commands: Vec::new() },
        Some(stream) => stream,
    };
    if stream.phase != StreamPhase::Subscribed {
        return ReceiverStepResult { state: state.clone(), commands: Vec::new() };
    }
    if input.sid > stream.spatial_id || input.tid > stream.temporal_id {
        return ReceiverStepResult {
            state: state.clone(),
            commands: vec![ReceiverCommand::Drop { priority: 1, count: 1 }],
        };
    }
    // 受信した位置を記録する。ack はタイマーでまとめて返す（congestion.md 2 節）。
    ReceiverStepResult {
        state: mark_received(state, &input),
        commands: vec![ReceiverCommand::Forward { to: vec![RECEIVER_SELF_ID] }],
    }
}

/// 受信した位置を更新する。後戻りする値では更新しない。
fn mark_received(state: &ReceiverState, input: &MediaInput) -> ReceiverState {
    let seq = input.seq;
    if seq <= 0 {
        return state.clone();
    }
    let existing = state.received.iter().find(|mark| {
        mark.sender_id == input.from && mark.channel == input.ch && mark.spatial_id == input.sid
    });
    if let Some(mark) = existing {
        if mark.highest_seq >= seq {
            return state.clone();
        }
    }
    let mut merged: Vec<ReceivedMark> = state
        .received
        .iter()
        .filter(|mark| {
            !(mark.sender_id == input.from && mark.channel == input.ch && mark.spatial_id == input.sid)
        })
        .copied()
        .collect();
    merged.push(ReceivedMark {
        sender_id: input.from,
        channel: input.ch,
        spatial_id: input.sid,
        highest_seq: seq,
    });
    merged.sort_by(|a, b| {
        (a.sender_id, a.channel, a.spatial_id).cmp(&(b.sender_id, b.channel, b.spatial_id))
    });
    let mut next = state.clone();
    next.received = merged;
    next
}

/// 発話者を先に、次に senderId の昇順で並べる。順序は決定的でなければならない。
fn priority_order(state: &ReceiverState, a: &StreamState, b: &StreamState) -> std::cmp::Ordering {
    let a_speaker = if state.active_speaker_id == Some(a.sender_id) { 0 } else { 1 };
    let b_speaker = if state.active_speaker_id == Some(b.sender_id) { 0 } else { 1 };
    (a_speaker, a.sender_id, a.channel).cmp(&(b_speaker, b.sender_id, b.channel))
}

/// 帯域予算から tier を配分する（congestion.md 4.3）。
///
/// 除算は整数で行い、切り捨てる。浮動小数点を使わない（ADR-0017）。
fn reallocate(state: ReceiverState) -> ReceiverStepResult {
    let mut commands: Vec<ReceiverCommand> = Vec::new();
    let budget_bps = match trunc_div(state.target_bytes_per_sec * 8 * 9, 10) {
        Ok(value) => value,
        Err(_) => 0,
    };
    let high_quality_count = match trunc_div(budget_bps, V_4K60_TARGET_BITRATE) {
        Ok(value) => value,
        Err(_) => 0,
    };
    let thumbnail_cost = V_360P15_TARGET_BITRATE;

    let mut ordered: Vec<StreamState> = state
        .streams
        .iter()
        .filter(|stream| stream.phase == StreamPhase::Subscribed)
        .copied()
        .collect();
    ordered.sort_by(|a, b| priority_order(&state, a, b));

    let mut streams: Vec<StreamState> = Vec::new();
    let mut assigned_high: i64 = 0;
    let mut remaining = budget_bps;
    let mut degraded = false;

    for stream in &state.streams {
        if stream.phase != StreamPhase::Subscribed {
            streams.push(*stream);
            continue;
        }
        let rank: i64 = match ordered
            .iter()
            .position(|candidate| candidate.sender_id == stream.sender_id && candidate.channel == stream.channel)
        {
            Some(index) => i64::try_from(index).unwrap_or(i64::MAX),
            None => -1,
        };
        let next_spatial: i64;
        if stream.display_width == 0 {
            // 表示寸法の申告が無い相手は最低品質に留める（ADR-0015）。
            next_spatial = DISPLAY_SIZE_UNSPECIFIED_SPATIAL_ID;
        } else if assigned_high < high_quality_count && rank < high_quality_count {
            next_spatial = V_4K60_SPATIAL_ID;
            assigned_high += 1;
            remaining -= V_4K60_TARGET_BITRATE;
        } else if remaining >= thumbnail_cost {
            next_spatial = V_360P15_SPATIAL_ID;
            remaining -= thumbnail_cost;
        } else {
            // 予算が尽きた。発話者のサムネイルのみを維持する（最低保証）。
            next_spatial = V_360P15_SPATIAL_ID;
            degraded = true;
        }
        if next_spatial != stream.spatial_id {
            commands.push(ReceiverCommand::SetTier {
                for_id: stream.sender_id,
                channel: stream.channel,
                tier: next_spatial,
            });
            if next_spatial > stream.spatial_id {
                // spatialId が上がる場合はエンコーダ出力が切り替わるためキーフレームが必要である。
                commands.push(ReceiverCommand::KeyframeRequest {
                    for_id: stream.sender_id,
                    channel: stream.channel,
                    spatial_id: next_spatial,
                });
            }
        }
        streams.push(StreamState { spatial_id: next_spatial, ..*stream });
    }

    if degraded && !state.degraded {
        // 最低保証（発話者のサムネイル 1 本と全員の音声）を下回った。利用側へ警告する。
        commands.push(ReceiverCommand::Notify { code: DEGRADED_WARNING.to_string() });
    }

    let mut next = state;
    next.streams = streams;
    next.streams.sort_by(stream_order);
    next.degraded = degraded;
    ReceiverStepResult { state: next, commands }
}
