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
    MAX_UNEXPECTED_EVENTS,
    AUDIO_ONLY_ENTER_BPS, AUDIO_ONLY_EXIT_BPS, MIN_VIABLE_BPS,
    RATE_HOLD_MS, RATE_PROBE_BPS, RATE_RECOVER_STREAK,
    SHARD_TREND_ENTER_T2_DEN, SHARD_TREND_ENTER_T2_NUM,
    SHARD_TREND_EXIT_DEN, SHARD_TREND_EXIT_NUM,
};
use crate::generated::wire_layout::{CHANNEL_AUDIO, CHANNEL_SCREEN_AUDIO};

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
    AudioOnly,
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

/// カタログの 1 段。streamCatalog から取り込む（ADR-0027 の 1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CatalogRung {
    pub sid: i64,
    pub width: i64,
    pub height: i64,
    pub framerate: i64,
    pub temporal_layers: i64,
    pub target_bitrate: i64,
}

/// 送信者 1 人・1 チャネルのはしご。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogLadder {
    pub sender_id: i64,
    pub channel: i64,
    /// sid の昇順で保持する。
    pub rungs: Vec<CatalogRung>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiverState {
    /// sender_id, channel の昇順で保持する。反復順序が判断に影響するため決定的にする。
    pub streams: Vec<StreamState>,
    /// 会議全体のはしご。sender_id, channel の昇順で保持する。
    pub catalog: Vec<CatalogLadder>,
    pub visible: bool,
    pub target_bytes_per_sec: i64,
    pub active_speaker_id: Option<i64>,
    pub trend: Slope,
    pub degraded: bool,
    /// 音声だけの状態か（ADR-0029）。
    pub audio_only: bool,
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
    /// 観測した goodput。**目標を下げない**（congestion.md 4.1）。
    Goodput {
        bytes_per_sec: i64,
    },
    ActiveSpeaker {
        id: Option<i64>,
    },
    Catalog {
        entries: Vec<CatalogLadder>,
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
    /// 購読者からのキーフレーム要求（ADR-0039）。
    /// コアは要求をそのままコマンドに直す。間隔制限は実行側が持つ。
    KeyframeRequest {
        sender_id: i64,
        channel: i64,
        spatial_id: i64,
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

/// 初期状態。目標は最低から始める。引数を取らない（呼び出し側に委ねると無関係な値を渡す誤りが起きる）。
pub fn initial_receiver_state() -> ReceiverState {
    let floor = match trunc_div(MIN_VIABLE_BPS, 8) {
        Ok(v) => v,
        Err(_) => 0,
    };
    ReceiverState {
        streams: Vec::new(),
        catalog: Vec::new(),
        visible: true,
        target_bytes_per_sec: floor,
        active_speaker_id: None,
        trend: Slope { numerator: 0, denominator: 1 },
        degraded: false,
        audio_only: false,
        rate_hold_until_ms: 0,
        recover_streak: 0,
        target_ceiling_bytes_per_sec: floor,
        unexpected_events: Vec::new(),
        received: Vec::new(),
    }
}

/// 純関数の状態遷移。時刻は AIMD の待ち（RATE_HOLD_MS）に使う。
pub fn receiver_step(state: &ReceiverState, event: &ReceiverEvent, t: i64) -> ReceiverStepResult {
    match event {
        ReceiverEvent::Subscribe { entries } => handle_subscribe(state, entries),
        ReceiverEvent::Leave { id } => handle_leave(state, *id),
        ReceiverEvent::Visibility { visible } => handle_visibility(state, *visible),
        ReceiverEvent::Budget { bytes_per_sec } => handle_budget(state, *bytes_per_sec),
        ReceiverEvent::Goodput { bytes_per_sec } => handle_goodput(state, *bytes_per_sec),
        ReceiverEvent::ActiveSpeaker { id } => {
            let mut next = state.clone();
            next.active_speaker_id = *id;
            reallocate(next)
        }
        ReceiverEvent::Catalog { entries } => handle_catalog(state, entries),
        ReceiverEvent::DisplaySize { sender_id, channel, width } => {
            handle_display_size(state, *sender_id, *channel, *width)
        }
        ReceiverEvent::Report { delay_us } => handle_report(state, delay_us, t),
        ReceiverEvent::Media { from, ch, sid, tid, seq, .. } => handle_media(
            state,
            MediaInput { from: *from, ch: *ch, sid: *sid, tid: *tid, seq: *seq },
        ),
        ReceiverEvent::KeyframeRequest { sender_id, channel, spatial_id } => {
            // 判断は無い。要求をコマンドへ直すだけである（間隔制限は実行側）。
            ReceiverStepResult {
                state: state.clone(),
                commands: vec![ReceiverCommand::KeyframeRequest {
                    for_id: *sender_id,
                    channel: *channel,
                    spatial_id: *spatial_id,
                }],
            }
        }
        ReceiverEvent::Timer => {
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

fn is_audio(ch: i64) -> bool {
    ch == i64::from(CHANNEL_AUDIO) || ch == i64::from(CHANNEL_SCREEN_AUDIO)
}

/// 購読一覧の適用。新規購読は最下段から始める（congestion.md 6 節、ADR-0028）。
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
            // 最下段から始める。参加直後に上限を要求すると細い回線で詰まる。
            let start = if is_audio(entry.channel) {
                0
            } else {
                lowest_rung(state, entry.sender_id, entry.channel)
            };
            commands.push(ReceiverCommand::SubscribeChange {
                to: entry.sender_id,
                channel: entry.channel,
                want: true,
                max_spatial_id: start,
                max_temporal_id: entry.max_temporal_id,
            });
            commands.push(ReceiverCommand::KeyframeRequest {
                for_id: entry.sender_id,
                channel: entry.channel,
                spatial_id: start,
            });
            kept.push(StreamState {
                sender_id: entry.sender_id,
                channel: entry.channel,
                phase: StreamPhase::Subscribed,
                spatial_id: start,
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

    // 一覧から外れたものは購読解除する。
    for stream in &state.streams {
        let still_wanted = entries
            .iter()
            .any(|e| e.sender_id == stream.sender_id && e.channel == stream.channel);
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

/// 送信者の退出。カタログと受信位置も除去する。
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
    let received: Vec<ReceivedMark> = state
        .received
        .iter()
        .filter(|mark| mark.sender_id != id)
        .copied()
        .collect();
    let catalog: Vec<CatalogLadder> = state
        .catalog
        .iter()
        .filter(|entry| entry.sender_id != id)
        .cloned()
        .collect();
    let mut next = state.clone();
    next.streams = streams;
    next.received = received;
    next.catalog = catalog;
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
        push_unexpected(&mut next.unexpected_events, "displaySize");
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

/// 遅延の報告に対する応答。tier を即応で動かし、target を AIMD で収束させる。
fn handle_report(state: &ReceiverState, delay_us: &[i64], t: i64) -> ReceiverStepResult {
    // 標本が 2 個未満では勾配が定まらない。定まらない値で AIMD を動かしてはならない。
    if delay_us.len() < 2 {
        return ReceiverStepResult { state: state.clone(), commands: Vec::new() };
    }
    let trend = delay_slope(delay_us);
    let degrading =
        trend.numerator * SHARD_TREND_ENTER_T2_DEN > SHARD_TREND_ENTER_T2_NUM * trend.denominator;
    let recovering =
        trend.numerator * SHARD_TREND_EXIT_DEN < SHARD_TREND_EXIT_NUM * trend.denominator;

    let mut target = state.target_bytes_per_sec;
    let mut hold_until = state.rate_hold_until_ms;
    let mut streak = state.recover_streak;
    if degrading {
        streak = 0;
        if t >= state.rate_hold_until_ms {
            let lowered = match trunc_div(target * 17, 20) {
                Ok(value) => value,
                Err(_) => target,
            };
            // 予兆で最低成立点を割らない（ADR-0040）
            let floor = match trunc_div(MIN_VIABLE_BPS, 8) {
                Ok(value) => value,
                Err(_) => 0,
            };
            target = if lowered < floor { floor } else { lowered };
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
            // 上限は望む品質の申告ビットレート（規範 4.2）。観測した goodput を
            // 上限にすると輪が閉じて目標が上がらない。申告が無い間は上限を作らない。
            let declared = desired_cost_bytes_per_sec(state);
            // 上限が最低成立点を下回ってはならない（ADR-0040）。最下段の申告は
            // MIN_VIABLE_BPS より小さいため、申告だけで切ると目標が最低成立点の
            // 下へ押し戻され AUDIO_ONLY の出入りを往復する（実測で振動した）。
            let minimum = match trunc_div(MIN_VIABLE_BPS, 8) {
                Ok(value) => value,
                Err(_) => 0,
            };
            let cap = if declared > 0 && declared < minimum { minimum } else { declared };
            target = if cap > 0 && raised > cap { cap } else { raised };
            streak = 0;
        }
    } else {
        streak = 0;
    }

    let after_rate = ReceiverState {
        trend,
        target_bytes_per_sec: target,
        rate_hold_until_ms: hold_until,
        recover_streak: streak,
        ..state.clone()
    };

    if !degrading && !recovering {
        return ReceiverStepResult { state: after_rate, commands: Vec::new() };
    }

    // 状態機械。tier を 1 段動かす。
    let delta: i64 = if degrading { -1 } else { 1 };
    let mut commands: Vec<ReceiverCommand> = Vec::new();
    let mut streams: Vec<StreamState> = Vec::new();
    for stream in &after_rate.streams {
        if stream.phase != StreamPhase::Subscribed || is_audio(stream.channel) {
            // 音声には段が無い。
            streams.push(*stream);
            continue;
        }
        let floor = lowest_rung(&after_rate, stream.sender_id, stream.channel);
        let cap = rung_cap_for(&after_rate, stream);
        let raw = stream.spatial_id + delta;
        let next_spatial = if raw < floor { floor } else if raw > cap { cap } else { raw };
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
        // 段が変わるとキーフレームが必要。下げる向きでも simulcast の別ストリームに切り替わる。
        commands.push(ReceiverCommand::KeyframeRequest {
            for_id: stream.sender_id,
            channel: stream.channel,
            spatial_id: next_spatial,
        });
    }
    let stepped = ReceiverState { streams, ..after_rate };
    if target == state.target_bytes_per_sec {
        return ReceiverStepResult { state: stepped, commands };
    }
    // 音声だけの状態の出入りだけをやり直す（規範 4.3、ADR-0029）。
    //
    // 配分の全部をやり直してはならない。reallocate は「買える最良の段」を選ぶため、
    // 予算が潤沢な回線では遅延勾配による降格を直後に打ち消してしまう（実測で発生）。
    // 勾配は予算に現れない詰まりの予兆であり、予算で無かったことにしてはならない。
    //
    // 音声だけの出入りは reallocate にしか無いため、境界を跨いだときだけ呼ぶ。
    // 呼ばなければ回復の勾配がいくら続いても映像が戻らない（実測で確認）。
    if !crosses_audio_only(&stepped) {
        return ReceiverStepResult { state: stepped, commands };
    }
    let reallocated = reallocate(stepped);
    let mut merged = commands;
    merged.extend(reallocated.commands);
    ReceiverStepResult { state: reallocated.state, commands: merged }
}

/// いまの目標が音声だけの状態の境界を跨いでいるか（ADR-0029 のヒステリシス）。
///
/// 跨いでいる場合だけ配分をやり直す。判定は reallocate と同じ式でなければならないため、
/// 回線の速度（目標 × 8）で見る。予算（9/10）で見ると余裕を二重に引くことになる。
fn crosses_audio_only(state: &ReceiverState) -> bool {
    let link_bps = state.target_bytes_per_sec * 8;
    let wanted = if state.audio_only {
        link_bps < AUDIO_ONLY_EXIT_BPS
    } else {
        link_bps < AUDIO_ONLY_ENTER_BPS
    };
    wanted != state.audio_only
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

/// 音声を最優先、次に発話者、次に senderId 昇順。順序は決定的でなければならない。
fn priority_order(state: &ReceiverState, a: &StreamState, b: &StreamState) -> std::cmp::Ordering {
    let a_audio: i64 = if is_audio(a.channel) { 0 } else { 1 };
    let b_audio: i64 = if is_audio(b.channel) { 0 } else { 1 };
    if a_audio != b_audio {
        return a_audio.cmp(&b_audio);
    }
    let a_speaker: i64 = if state.active_speaker_id == Some(a.sender_id) { 0 } else { 1 };
    let b_speaker: i64 = if state.active_speaker_id == Some(b.sender_id) { 0 } else { 1 };
    a_speaker.cmp(&b_speaker)
        .then(a.sender_id.cmp(&b.sender_id))
        .then(a.channel.cmp(&b.channel))
}

/// 帯域予算から段を配分する（congestion.md 4.3、ADR-0027、ADR-0029）。
fn reallocate(state: ReceiverState) -> ReceiverStepResult {
    let mut commands: Vec<ReceiverCommand> = Vec::new();
    // 回線の速度（bits/sec）。
    let link_bps = state.target_bytes_per_sec * 8;
    // 段を買うための予算。ヘッダと制御の余裕を 10% 取る。
    let budget_bps = match trunc_div(link_bps * 9, 10) {
        Ok(v) => v,
        Err(_) => 0,
    };

    // AUDIO_ONLY の出入り。判定は回線の速度そのもので行う（10% を引く前の値）。
    let audio_only = if state.audio_only {
        link_bps < AUDIO_ONLY_EXIT_BPS
    } else {
        link_bps < AUDIO_ONLY_ENTER_BPS
    };

    if audio_only {
        let mut streams: Vec<StreamState> = Vec::new();
        for stream in &state.streams {
            if is_audio(stream.channel) {
                // 音声は維持する。
                streams.push(*stream);
                continue;
            }
            if stream.phase == StreamPhase::Subscribed {
                commands.push(ReceiverCommand::SubscribeChange {
                    to: stream.sender_id,
                    channel: stream.channel,
                    want: false,
                    max_spatial_id: 0,
                    max_temporal_id: 0,
                });
                streams.push(StreamState { phase: StreamPhase::AudioOnly, ..*stream });
                continue;
            }
            streams.push(*stream);
        }
        if !state.degraded {
            commands.push(ReceiverCommand::Notify { code: DEGRADED_WARNING.to_string() });
        }
        streams.sort_by(stream_order);
        return ReceiverStepResult {
            state: ReceiverState { streams, audio_only: true, degraded: true, ..state },
            commands,
        };
    }

    // AUDIO_ONLY から復帰する。最下段から始める。
    let mut revived: Vec<StreamState> = Vec::new();
    for stream in &state.streams {
        if stream.phase == StreamPhase::AudioOnly {
            let floor = lowest_rung(&state, stream.sender_id, stream.channel);
            revived.push(StreamState { phase: StreamPhase::Subscribed, spatial_id: floor, ..*stream });
            commands.push(ReceiverCommand::SubscribeChange {
                to: stream.sender_id,
                channel: stream.channel,
                want: true,
                max_spatial_id: floor,
                max_temporal_id: stream.temporal_id,
            });
            commands.push(ReceiverCommand::KeyframeRequest {
                for_id: stream.sender_id,
                channel: stream.channel,
                spatial_id: floor,
            });
            continue;
        }
        revived.push(*stream);
    }
    let base = ReceiverState { streams: revived, audio_only: false, ..state };

    // 予算で段を買う。
    let mut ordered: Vec<StreamState> = base
        .streams
        .iter()
        .filter(|s| s.phase == StreamPhase::Subscribed)
        .copied()
        .collect();
    ordered.sort_by(|a, b| priority_order(&base, a, b));

    let mut assigned: Vec<(i64, i64, i64)> = Vec::new(); // (sender_id, channel, chosen_sid)
    let mut remaining = budget_bps;
    let mut degraded = false;

    for stream in &ordered {
        if is_audio(stream.channel) {
            // 音声は段を持たない。費用は予算から引く。
            remaining -= cost_of(&base, stream.sender_id, stream.channel, 0);
            continue;
        }
        let floor = lowest_rung(&base, stream.sender_id, stream.channel);
        let cap = rung_cap_for(&base, stream);
        let mut chosen = floor;
        // 上限から下へ降りて、予算に収まる最も高い段を選ぶ。
        let mut sid = cap;
        while sid >= floor {
            let cost = cost_of(&base, stream.sender_id, stream.channel, sid);
            if cost <= remaining {
                chosen = sid;
                break;
            }
            sid -= 1;
        }
        let chosen_cost = cost_of(&base, stream.sender_id, stream.channel, chosen);
        if chosen_cost > remaining {
            // 最下段さえ入らない。最低保証として最下段を維持し警告する。
            degraded = true;
        }
        remaining -= chosen_cost;
        assigned.push((stream.sender_id, stream.channel, chosen));
    }

    let mut streams: Vec<StreamState> = Vec::new();
    for stream in &base.streams {
        let next_sid = assigned.iter().find(|(s, c, _)| *s == stream.sender_id && *c == stream.channel);
        match next_sid {
            Some((_, _, sid)) if *sid != stream.spatial_id => {
                commands.push(ReceiverCommand::SetTier {
                    for_id: stream.sender_id,
                    channel: stream.channel,
                    tier: *sid,
                });
                commands.push(ReceiverCommand::KeyframeRequest {
                    for_id: stream.sender_id,
                    channel: stream.channel,
                    spatial_id: *sid,
                });
                streams.push(StreamState { spatial_id: *sid, ..*stream });
            }
            _ => streams.push(*stream),
        }
    }

    if degraded && !base.degraded {
        commands.push(ReceiverCommand::Notify { code: DEGRADED_WARNING.to_string() });
    }

    streams.sort_by(stream_order);
    ReceiverStepResult {
        state: ReceiverState { streams, degraded, ..base },
        commands,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 帯域とカタログ
// ─────────────────────────────────────────────────────────────────────────────

/// 望む段の申告ビットレートの合計（bytes/sec）。
/// AIMD の回復時に上限として使う（規範 4.2）。カタログ未着（合計 0）のときは
/// 呼び出し側が上限を作らない。知らないことは制約ではない。
fn desired_cost_bytes_per_sec(state: &ReceiverState) -> i64 {
    let mut bits: i64 = 0;
    for stream in &state.streams {
        if stream.phase != StreamPhase::Subscribed {
            continue;
        }
        if is_audio(stream.channel) {
            bits += cost_of(state, stream.sender_id, stream.channel, stream.spatial_id);
        } else {
            bits += cost_of(state, stream.sender_id, stream.channel, rung_cap_for(state, stream));
        }
    }
    match trunc_div(bits, 8) {
        Ok(value) => value,
        Err(_) => 0,
    }
}

/// 観測した goodput。天井を押し上げ、目標を上げる方向にだけ使う（congestion.md 4.1）。
fn handle_goodput(state: &ReceiverState, bytes_per_sec: i64) -> ReceiverStepResult {
    if bytes_per_sec <= 0 {
        return ReceiverStepResult { state: state.clone(), commands: Vec::new() };
    }
    let ceiling = if bytes_per_sec > state.target_ceiling_bytes_per_sec {
        bytes_per_sec
    } else {
        state.target_ceiling_bytes_per_sec
    };
    // 規範 4.1: available = max(goodput, 現在の目標レート)。**天井で切らない。**
    // 中継ノードは目標の分しか転送しないため goodput は常に目標以下に留まる。
    // 天井で切ると目標が最低成立点から一生上がらない（desiredCostBytesPerSec の注記）。
    let target = if bytes_per_sec > state.target_bytes_per_sec {
        bytes_per_sec
    } else {
        state.target_bytes_per_sec
    };
    if target == state.target_bytes_per_sec && ceiling == state.target_ceiling_bytes_per_sec {
        return ReceiverStepResult { state: state.clone(), commands: Vec::new() };
    }
    let mut next = state.clone();
    next.target_bytes_per_sec = target;
    next.target_ceiling_bytes_per_sec = ceiling;
    reallocate(next)
}

fn handle_budget(state: &ReceiverState, bytes_per_sec: i64) -> ReceiverStepResult {
    let ceiling = if bytes_per_sec > state.target_ceiling_bytes_per_sec {
        bytes_per_sec
    } else {
        state.target_ceiling_bytes_per_sec
    };
    let mut next = state.clone();
    next.target_bytes_per_sec = bytes_per_sec;
    next.target_ceiling_bytes_per_sec = ceiling;
    reallocate(next)
}

/// カタログの取り込み。はしごが変わると段の上限と費用が変わるため再配分する。
fn handle_catalog(state: &ReceiverState, entries: &[CatalogLadder]) -> ReceiverStepResult {
    let mut normalized: Vec<CatalogLadder> = entries
        .iter()
        .map(|entry| {
            let mut rungs = entry.rungs.clone();
            rungs.sort_by_key(|r| r.sid);
            CatalogLadder { sender_id: entry.sender_id, channel: entry.channel, rungs }
        })
        .collect();
    normalized.sort_by(|a, b| {
        a.sender_id.cmp(&b.sender_id).then(a.channel.cmp(&b.channel))
    });
    let mut next = state.clone();
    next.catalog = normalized;
    reallocate(next)
}

/// カタログからはしごを引く。
fn ladder_of(state: &ReceiverState, sender_id: i64, channel: i64) -> &[CatalogRung] {
    match state.catalog.iter().find(|item| item.sender_id == sender_id && item.channel == channel) {
        Some(entry) => &entry.rungs,
        None => &[],
    }
}

/// 表示寸法から要求すべき段の上限を返す。
/// 規則: 表示幅以上の幅を持つ最小の段。無ければ最上段。未申告は最下段。カタログ無しは 0。
fn rung_cap_for(state: &ReceiverState, stream: &StreamState) -> i64 {
    let rungs = ladder_of(state, stream.sender_id, stream.channel);
    if rungs.is_empty() {
        return 0;
    }
    let mut lowest_sid = rungs[0].sid;
    let mut top_sid = rungs[0].sid;
    for rung in rungs {
        if rung.sid < lowest_sid { lowest_sid = rung.sid; }
        if rung.sid > top_sid { top_sid = rung.sid; }
    }
    if stream.display_width <= 0 {
        return lowest_sid;
    }
    let mut best: Option<&CatalogRung> = None;
    for rung in rungs {
        if rung.width < stream.display_width {
            continue;
        }
        match best {
            None => best = Some(rung),
            Some(b) if rung.width < b.width => best = Some(rung),
            _ => {}
        }
    }
    match best {
        Some(rung) => rung.sid,
        None => top_sid,
    }
}

/// 段の費用（bits/sec）。申告が無ければ 0。
fn cost_of(state: &ReceiverState, sender_id: i64, channel: i64, sid: i64) -> i64 {
    for rung in ladder_of(state, sender_id, channel) {
        if rung.sid == sid {
            return rung.target_bitrate;
        }
    }
    0
}

/// はしごの最下段。カタログが無ければ 0。
fn lowest_rung(state: &ReceiverState, sender_id: i64, channel: i64) -> i64 {
    let rungs = ladder_of(state, sender_id, channel);
    let mut lowest: i64 = -1;
    for rung in rungs {
        if lowest < 0 || rung.sid < lowest {
            lowest = rung.sid;
        }
    }
    if lowest < 0 { 0 } else { lowest }
}

/// はしごの最上段。カタログが無ければ 0。
fn highest_rung(state: &ReceiverState, sender_id: i64, channel: i64) -> i64 {
    let rungs = ladder_of(state, sender_id, channel);
    let mut top: i64 = -1;
    for rung in rungs {
        if rung.sid > top {
            top = rung.sid;
        }
    }
    if top < 0 { 0 } else { top }
}

/// 表に無いイベントの記録に 1 件加える。上限を超えたら古い側を捨てる（ADR-0034）。
fn push_unexpected(events: &mut Vec<String>, name: &str) {
    events.push(name.to_string());
    let limit = MAX_UNEXPECTED_EVENTS as usize;
    if events.len() > limit {
        let excess = events.len() - limit;
        events.drain(0..excess);
    }
}
