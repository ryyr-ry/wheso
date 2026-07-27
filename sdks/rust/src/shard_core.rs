//! 中継ノード（shard）の判断コア（Rust 版）。
//!
//! TypeScript の参照実装（packages/core/src/shard-core.ts）と**同じ入力列から同じ出力列**を
//! 返さなければならない（conformance.md 2 節の層 2）。検証は凍結トレースベクタで行う。
//!
//! sans-IO。時刻は入力として受け取り、内部で取得しない。
//! 浮動小数点を使わない。パニックしない。

use crate::generated::constants::{
    NODE_MAX_OUT_BYTES_PER_SEC, NODE_MAX_OUT_MESSAGES_PER_SEC, SHARD_TREND_ENTER_KEY_ONLY_DEN,
    SHARD_TREND_ENTER_KEY_ONLY_NUM, SHARD_TREND_ENTER_SPATIAL_DEN, SHARD_TREND_ENTER_SPATIAL_NUM,
    SHARD_TREND_ENTER_T1_DEN, SHARD_TREND_ENTER_T1_NUM, SHARD_TREND_ENTER_T2_DEN,
    SHARD_TREND_ENTER_T2_NUM, SHARD_TREND_EXIT_DEN, SHARD_TREND_EXIT_KEY_ONLY_DEN,
    SHARD_TREND_EXIT_KEY_ONLY_NUM, SHARD_TREND_EXIT_NUM, SHARD_UTIL_ENTER_KEY_ONLY_DEN,
    SHARD_UTIL_ENTER_KEY_ONLY_NUM, SHARD_UTIL_ENTER_SPATIAL_DEN, SHARD_UTIL_ENTER_SPATIAL_NUM,
    SHARD_UTIL_ENTER_T1_DEN, SHARD_UTIL_ENTER_T1_NUM, SHARD_UTIL_ENTER_T2_DEN,
    SHARD_UTIL_ENTER_T2_NUM, SHARD_UTIL_EXIT_KEY_ONLY_DEN, SHARD_UTIL_EXIT_KEY_ONLY_NUM,
    SHARD_UTIL_EXIT_SPATIAL_DEN, SHARD_UTIL_EXIT_SPATIAL_NUM, SHARD_UTIL_EXIT_T1_DEN,
    SHARD_UTIL_EXIT_T1_NUM, SHARD_UTIL_EXIT_T2_DEN, SHARD_UTIL_EXIT_T2_NUM, SHARD_UTIL_WINDOW_MS,
    SHEDDING_HYSTERESIS_MS,
};
use crate::fixed::delay_slope;
use crate::wire::drop_priority;

/// 輻輳状態（state-machines.md 3 節）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Congestion {
    Normal,
    SheddingT2,
    SheddingT1,
    SheddingSpatial,
    KeyOnly,
}

impl Congestion {
    pub fn name(self) -> &'static str {
        match self {
            Congestion::Normal => "NORMAL",
            Congestion::SheddingT2 => "SHEDDING_T2",
            Congestion::SheddingT1 => "SHEDDING_T1",
            Congestion::SheddingSpatial => "SHEDDING_SPATIAL",
            Congestion::KeyOnly => "KEY_ONLY",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subscription {
    pub subscriber_id: i64,
    pub target_id: i64,
    pub max_spatial_id: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReceiverTrend {
    pub subscriber_id: i64,
    pub numerator: i64,
    pub denominator: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MaxSpatial {
    pub from: i64,
    pub ch: i64,
    pub sid: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShardState {
    pub congestion: Congestion,
    pub congestion_entered_at: i64,
    pub participants: Vec<i64>,
    pub subscriptions: Vec<Subscription>,
    pub budget_bytes_per_sec: i64,
    pub sent_bytes_in_window: i64,
    pub sent_messages_in_window: i64,
    pub window_start_ms: i64,
    pub unexpected_events: Vec<String>,
    pub trends: Vec<ReceiverTrend>,
    pub max_spatial: Vec<MaxSpatial>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShardEvent {
    Media {
        from: i64,
        ch: i64,
        sid: i64,
        tid: i64,
        key: bool,
        bytes: i64,
        flags: i64,
    },
    Subscribe {
        from: i64,
        to: i64,
        want: bool,
        max_spatial_id: i64,
    },
    Join {
        id: i64,
    },
    Leave {
        id: i64,
    },
    Link {
        peer: i64,
        state: String,
    },
    Timer,
    Budget {
        bytes_per_sec: i64,
    },
    Report {
        from: i64,
        delay_us: Vec<i64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShardCommand {
    Forward { to: Vec<i64> },
    Drop { priority: i64, count: i64 },
    Notify { code: i64 },
}

pub struct StepResult {
    pub state: ShardState,
    pub commands: Vec<ShardCommand>,
}

pub fn initial_state(t: i64) -> ShardState {
    ShardState {
        congestion: Congestion::Normal,
        congestion_entered_at: t,
        participants: Vec::new(),
        subscriptions: Vec::new(),
        budget_bytes_per_sec: NODE_MAX_OUT_BYTES_PER_SEC,
        sent_bytes_in_window: 0,
        sent_messages_in_window: 0,
        window_start_ms: t,
        unexpected_events: Vec::new(),
        trends: Vec::new(),
        max_spatial: Vec::new(),
    }
}

/// 過負荷を通知するクローズコード。errors.json の E_NODE_OVERLOADED と一致させる。
const NODE_OVERLOADED_CLOSE_CODE: i64 = 4032;

pub fn step(state: &ShardState, event: &ShardEvent, t: i64) -> StepResult {
    match event {
        ShardEvent::Media { from, ch, sid, tid, key: _, bytes, flags } => handle_media(
            state,
            &MediaUnit {
                from: *from,
                ch: *ch,
                sid: *sid,
                tid: *tid,
                bytes: *bytes,
                flags: *flags,
            },
            t,
        ),
        ShardEvent::Subscribe { from, to, want, max_spatial_id } => {
            handle_subscribe(state, *from, *to, *want, *max_spatial_id)
        }
        ShardEvent::Join { id } => handle_join(state, *id),
        ShardEvent::Leave { id } => handle_leave(state, *id),
        ShardEvent::Link { .. } => {
            // 表に無いイベントは無視して記録する。
            let mut next = state.clone();
            next.unexpected_events.push("link".to_string());
            StepResult { state: next, commands: Vec::new() }
        }
        ShardEvent::Timer => {
            let reset = maybe_reset_window(state, t);
            evaluate_congestion(&reset, t)
        }
        ShardEvent::Budget { bytes_per_sec } => {
            let mut next = state.clone();
            next.budget_bytes_per_sec = *bytes_per_sec;
            evaluate_congestion(&next, t)
        }
        ShardEvent::Report { from, delay_us } => handle_report(state, *from, delay_us, t),
    }
}

/// メディアの 1 ユニット。引数を並べずに束ねる（検査の抑制を使わないため）。
struct MediaUnit {
    from: i64,
    ch: i64,
    sid: i64,
    tid: i64,
    bytes: i64,
    flags: i64,
}

fn handle_media(state: &ShardState, unit: &MediaUnit, t: i64) -> StepResult {
    let MediaUnit { from, ch, sid, tid, bytes, flags } = *unit;
    let mut next = update_max_spatial(&maybe_reset_window(state, t), from, ch, sid);
    let priority = drop_priority(ch as u8, flags as u8).map(i64::from);

    if should_drop_in_congestion(&next, sid, tid, from, ch, priority) {
        let value = priority.unwrap_or(0);
        return StepResult {
            state: next,
            commands: vec![ShardCommand::Drop { priority: value, count: 1 }],
        };
    }

    let mut targets: Vec<i64> = Vec::new();
    for sub in &next.subscriptions {
        if sub.target_id == from && sid <= sub.max_spatial_id {
            targets.push(sub.subscriber_id);
        }
    }
    targets.sort_unstable();

    if targets.is_empty() {
        return StepResult { state: next, commands: Vec::new() };
    }

    let msg_cost = targets.len() as i64;
    let byte_cost = msg_cost * bytes;
    let updated_messages = next.sent_messages_in_window + msg_cost;
    let updated_bytes = next.sent_bytes_in_window + byte_cost;

    if is_over_budget(updated_messages, updated_bytes, &next, t) {
        if let Some(value) = priority {
            return StepResult {
                state: next,
                commands: vec![ShardCommand::Drop { priority: value, count: 1 }],
            };
        }
    }

    let mut commands = vec![ShardCommand::Forward { to: targets }];
    next.sent_bytes_in_window += byte_cost;
    next.sent_messages_in_window += msg_cost;
    let evaluated = evaluate_congestion(&next, t);
    commands.extend(evaluated.commands);
    StepResult { state: evaluated.state, commands }
}

fn handle_subscribe(
    state: &ShardState,
    from: i64,
    to: i64,
    want: bool,
    max_spatial_id: i64,
) -> StepResult {
    let mut next = state.clone();
    next.subscriptions
        .retain(|sub| !(sub.subscriber_id == from && sub.target_id == to));
    if want {
        next.subscriptions.push(Subscription {
            subscriber_id: from,
            target_id: to,
            max_spatial_id,
        });
        next.subscriptions.sort_by(|a, b| {
            (a.subscriber_id, a.target_id).cmp(&(b.subscriber_id, b.target_id))
        });
    }
    StepResult { state: next, commands: Vec::new() }
}

fn handle_join(state: &ShardState, id: i64) -> StepResult {
    if state.participants.contains(&id) {
        return StepResult { state: state.clone(), commands: Vec::new() };
    }
    let mut next = state.clone();
    next.participants.push(id);
    next.participants.sort_unstable();
    StepResult { state: next, commands: Vec::new() }
}

fn handle_leave(state: &ShardState, id: i64) -> StepResult {
    let mut next = state.clone();
    next.participants.retain(|value| *value != id);
    next.subscriptions
        .retain(|sub| sub.subscriber_id != id && sub.target_id != id);
    StepResult { state: next, commands: Vec::new() }
}

fn handle_report(state: &ShardState, from: i64, delay_us: &[i64], t: i64) -> StepResult {
    let slope = delay_slope(delay_us);
    let mut next = state.clone();
    next.trends.retain(|trend| trend.subscriber_id != from);
    next.trends.push(ReceiverTrend {
        subscriber_id: from,
        numerator: slope.numerator,
        denominator: slope.denominator,
    });
    next.trends.sort_by_key(|trend| trend.subscriber_id);
    evaluate_congestion(&next, t)
}

fn maybe_reset_window(state: &ShardState, t: i64) -> ShardState {
    if t - state.window_start_ms >= SHARD_UTIL_WINDOW_MS {
        let mut next = state.clone();
        next.sent_bytes_in_window = 0;
        next.sent_messages_in_window = 0;
        next.window_start_ms = t;
        return next;
    }
    state.clone()
}

fn update_max_spatial(state: &ShardState, from: i64, ch: i64, sid: i64) -> ShardState {
    let existing = state
        .max_spatial
        .iter()
        .find(|entry| entry.from == from && entry.ch == ch)
        .copied();
    if let Some(entry) = existing {
        if entry.sid >= sid {
            return state.clone();
        }
    }
    let mut next = state.clone();
    next.max_spatial
        .retain(|entry| !(entry.from == from && entry.ch == ch));
    next.max_spatial.push(MaxSpatial { from, ch, sid });
    next.max_spatial.sort_by_key(|entry| (entry.from, entry.ch));
    next
}

fn max_spatial_for(state: &ShardState, from: i64, ch: i64) -> i64 {
    state
        .max_spatial
        .iter()
        .find(|entry| entry.from == from && entry.ch == ch)
        .map(|entry| entry.sid)
        .unwrap_or(0)
}

fn should_drop_in_congestion(
    state: &ShardState,
    sid: i64,
    tid: i64,
    from: i64,
    ch: i64,
    priority: Option<i64>,
) -> bool {
    if priority.is_none() {
        return false;
    }
    match state.congestion {
        Congestion::Normal => false,
        Congestion::SheddingT2 => priority.unwrap_or(9) <= 3,
        Congestion::SheddingT1 => tid >= 1,
        Congestion::SheddingSpatial => sid >= max_spatial_for(state, from, ch) || tid >= 1,
        Congestion::KeyOnly => true,
    }
}

fn is_over_budget(
    projected_messages: i64,
    projected_bytes: i64,
    state: &ShardState,
    t: i64,
) -> bool {
    let window = t - state.window_start_ms;
    if window <= 0 {
        return false;
    }
    let message_over = projected_messages * 1000 > NODE_MAX_OUT_MESSAGES_PER_SEC * window;
    let byte_over = projected_bytes * 1000 > state.budget_bytes_per_sec * window;
    message_over || byte_over
}

fn util_greater(state: &ShardState, t: i64, num: i64, den: i64) -> bool {
    let window = t - state.window_start_ms;
    if window <= 0 {
        return false;
    }
    state.sent_messages_in_window * 1000 * den > num * window * NODE_MAX_OUT_MESSAGES_PER_SEC
}

fn util_less(state: &ShardState, t: i64, num: i64, den: i64) -> bool {
    let window = t - state.window_start_ms;
    if window <= 0 {
        return num > 0;
    }
    state.sent_messages_in_window * 1000 * den < num * window * NODE_MAX_OUT_MESSAGES_PER_SEC
}

fn trend_greater(state: &ShardState, num: i64, den: i64) -> bool {
    state
        .trends
        .iter()
        .any(|trend| trend.numerator * den > num * trend.denominator)
}

fn trend_less(state: &ShardState, num: i64, den: i64) -> bool {
    state
        .trends
        .iter()
        .all(|trend| trend.numerator * den < num * trend.denominator)
}

fn evaluate_congestion(state: &ShardState, t: i64) -> StepResult {
    if t - state.congestion_entered_at < SHEDDING_HYSTERESIS_MS {
        return StepResult { state: state.clone(), commands: Vec::new() };
    }
    let next_phase = match state.congestion {
        Congestion::Normal => {
            if util_greater(state, t, SHARD_UTIL_ENTER_T2_NUM, SHARD_UTIL_ENTER_T2_DEN)
                || trend_greater(state, SHARD_TREND_ENTER_T2_NUM, SHARD_TREND_ENTER_T2_DEN)
            {
                Congestion::SheddingT2
            } else {
                Congestion::Normal
            }
        }
        Congestion::SheddingT2 => {
            if util_greater(state, t, SHARD_UTIL_ENTER_T1_NUM, SHARD_UTIL_ENTER_T1_DEN)
                || trend_greater(state, SHARD_TREND_ENTER_T1_NUM, SHARD_TREND_ENTER_T1_DEN)
            {
                Congestion::SheddingT1
            } else if util_less(state, t, SHARD_UTIL_EXIT_T2_NUM, SHARD_UTIL_EXIT_T2_DEN)
                && trend_less(state, SHARD_TREND_EXIT_NUM, SHARD_TREND_EXIT_DEN)
            {
                Congestion::Normal
            } else {
                Congestion::SheddingT2
            }
        }
        Congestion::SheddingT1 => {
            if util_greater(state, t, SHARD_UTIL_ENTER_SPATIAL_NUM, SHARD_UTIL_ENTER_SPATIAL_DEN)
                || trend_greater(state, SHARD_TREND_ENTER_SPATIAL_NUM, SHARD_TREND_ENTER_SPATIAL_DEN)
            {
                Congestion::SheddingSpatial
            } else if util_less(state, t, SHARD_UTIL_EXIT_T1_NUM, SHARD_UTIL_EXIT_T1_DEN)
                && trend_less(state, SHARD_TREND_EXIT_NUM, SHARD_TREND_EXIT_DEN)
            {
                Congestion::SheddingT2
            } else {
                Congestion::SheddingT1
            }
        }
        Congestion::SheddingSpatial => {
            if util_greater(state, t, SHARD_UTIL_ENTER_KEY_ONLY_NUM, SHARD_UTIL_ENTER_KEY_ONLY_DEN)
                || trend_greater(state, SHARD_TREND_ENTER_KEY_ONLY_NUM, SHARD_TREND_ENTER_KEY_ONLY_DEN)
            {
                Congestion::KeyOnly
            } else if util_less(state, t, SHARD_UTIL_EXIT_SPATIAL_NUM, SHARD_UTIL_EXIT_SPATIAL_DEN)
                && trend_less(state, SHARD_TREND_EXIT_NUM, SHARD_TREND_EXIT_DEN)
            {
                Congestion::SheddingT1
            } else {
                Congestion::SheddingSpatial
            }
        }
        Congestion::KeyOnly => {
            if util_less(state, t, SHARD_UTIL_EXIT_KEY_ONLY_NUM, SHARD_UTIL_EXIT_KEY_ONLY_DEN)
                && trend_less(state, SHARD_TREND_EXIT_KEY_ONLY_NUM, SHARD_TREND_EXIT_KEY_ONLY_DEN)
            {
                Congestion::SheddingSpatial
            } else {
                Congestion::KeyOnly
            }
        }
    };

    if next_phase == state.congestion {
        return StepResult { state: state.clone(), commands: Vec::new() };
    }
    let mut commands = Vec::new();
    if next_phase == Congestion::KeyOnly {
        commands.push(ShardCommand::Notify { code: NODE_OVERLOADED_CLOSE_CODE });
    }
    let mut next = state.clone();
    next.congestion = next_phase;
    next.congestion_entered_at = t;
    StepResult { state: next, commands }
}
