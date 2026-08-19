//! 中継ノード（shard）の判断コア（Rust 版）。
//!
//! TypeScript の参照実装（packages/core/src/shard-core.ts）と**同じ入力列から同じ出力列**を
//! 返さなければならない（conformance.md 2 節の層 2）。検証は凍結トレースベクタで行う。
//!
//! sans-IO。時刻は入力として受け取り、内部で取得しない。
//! 浮動小数点を使わない。パニックしない。

use crate::generated::constants::{
    MAX_UNEXPECTED_EVENTS,
    ACK_TIMEOUT_MS, AUDIO_SELECTIVE_FORWARD_COUNT, AUDIO_SELECTIVE_MIN_COUNT,
    AUDIO_SPEAKER_HOLD_MS,
    NODE_MAX_OUT_BYTES_PER_SEC, NODE_MAX_OUT_MESSAGES_PER_SEC,
    SEND_WINDOW_MS, SHARD_TREND_ENTER_KEY_ONLY_DEN, SHARD_TREND_ENTER_KEY_ONLY_NUM,
    SHARD_TREND_ENTER_SPATIAL_DEN, SHARD_TREND_ENTER_SPATIAL_NUM, SHARD_TREND_ENTER_T1_DEN,
    SHARD_TREND_ENTER_T1_NUM, SHARD_TREND_ENTER_T2_DEN, SHARD_TREND_ENTER_T2_NUM,
    SHARD_TREND_EXIT_DEN, SHARD_TREND_EXIT_KEY_ONLY_DEN, SHARD_TREND_EXIT_KEY_ONLY_NUM,
    SHARD_TREND_EXIT_NUM, SHARD_UTIL_ENTER_KEY_ONLY_DEN, SHARD_UTIL_ENTER_KEY_ONLY_NUM,
    SHARD_UTIL_ENTER_SPATIAL_DEN, SHARD_UTIL_ENTER_SPATIAL_NUM, SHARD_UTIL_ENTER_T1_DEN,
    SHARD_UTIL_ENTER_T1_NUM, SHARD_UTIL_ENTER_T2_DEN, SHARD_UTIL_ENTER_T2_NUM,
    SHARD_UTIL_EXIT_KEY_ONLY_DEN, SHARD_UTIL_EXIT_KEY_ONLY_NUM, SHARD_UTIL_EXIT_SPATIAL_DEN,
    SHARD_UTIL_EXIT_SPATIAL_NUM, SHARD_UTIL_EXIT_T1_DEN, SHARD_UTIL_EXIT_T1_NUM,
    SHARD_UTIL_EXIT_T2_DEN, SHARD_UTIL_EXIT_T2_NUM, SHARD_UTIL_WINDOW_MS,
    SHEDDING_HYSTERESIS_MS,
};
use crate::generated::errors::E_NODE_OVERLOADED_CLOSE_CODE;
use crate::generated::wire_layout::{CHANNEL_AUDIO, CHANNEL_SCREEN_AUDIO, FLAG_ACTIVE_SPEAKER};
use crate::fixed::delay_slope;
use crate::wire::drop_priority;

// ─────────────────────────────────────────────────────────────────────────────
// 輻輳状態（state-machines.md 3 節）
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// 購読（Subscription）
// ─────────────────────────────────────────────────────────────────────────────

/// 購読 1 本の状態。判断はすべてここに閉じる（ADR-0025）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subscription {
    pub subscriber_id: i64,
    pub target_id: i64,
    pub channel: i64,
    /// 購読者が要求した最大 spatialId（段番号）。
    pub max_spatial_id: i64,
    /// 購読者が要求した最大 temporalId。
    pub max_temporal_id: i64,
    /// 送信窓が追跡している段。-1 は「まだ渡していない」を表す。
    pub window_sid: i64,
    /// この購読へ渡した最大 sequenceNumber。
    pub highest_sent: i64,
    /// ack で確認された最大 sequenceNumber。
    pub highest_acked: i64,
    /// 最後に ack を受けた時刻。
    pub last_ack_at_ms: i64,
    /// ack が途絶えて転送を止めているか。
    pub stalled: bool,
    /// 輻輳状態（購読単位で持つ。ADR-0025）。
    pub congestion: Congestion,
    /// 輻輳状態に入った時刻。ヒステリシスの判定に使う。
    pub congestion_entered_at: i64,
    /// 輻輳による段の引き下げ量。SHEDDING_SPATIAL 以降で 1 になる。
    pub tier_penalty: i64,
    /// 破棄不可のユニット（優先順位 4・5）を落とした段。落としていなければ −1。
    ///
    /// 規範 1.4: 順位 4・5 を破棄する場合はデコーダの参照連鎖が壊れるため、
    /// 同一 (senderId, channel, spatialId) の次の KEY まで連続して破棄し、
    /// keyframeRequest を送る。
    pub awaiting_key_sid: i64,
}

// ─────────────────────────────────────────────────────────────────────────────
// はしご（Ladder）
// ─────────────────────────────────────────────────────────────────────────────

/// はしごの 1 段（ADR-0026）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LadderRung {
    pub sid: i64,
    pub width: i64,
    pub height: i64,
    pub framerate: i64,
    pub temporal_layers: i64,
    pub target_bitrate: i64,
}

/// 送信者が申告した、または観測されたはしご。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ladder {
    pub from: i64,
    pub ch: i64,
    /// sid の昇順。
    pub rungs: Vec<LadderRung>,
    /// 申告（streamAnnounce）に由来するか。false は観測のみ（fps が分からない）。
    pub announced: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// その他の状態
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReceiverTrend {
    pub subscriber_id: i64,
    pub numerator: i64,
    pub denominator: i64,
}

/// 送信者ごとの直近の発話時刻（ADR-0024）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeakerActivity {
    pub sender_id: i64,
    pub last_speech_at_ms: i64,
}

/// 送信者 1 人に指令したエンコーダの上限段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncoderTier {
    pub target_id: i64,
    pub tier: i64,
}

// ─────────────────────────────────────────────────────────────────────────────
// 状態
// ─────────────────────────────────────────────────────────────────────────────

/// 受け取った位置。ackUpstream の内容になる（congestion.md 2 節）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceivedMark {
    pub from: i64,
    pub ch: i64,
    pub sid: i64,
    pub highest_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShardState {
    pub participants: Vec<i64>,
    pub subscriptions: Vec<Subscription>,
    pub ladders: Vec<Ladder>,
    pub trends: Vec<ReceiverTrend>,
    pub speakers: Vec<SpeakerActivity>,
    pub encoder_tiers: Vec<EncoderTier>,
    pub budget_bytes_per_sec: i64,
    pub sent_bytes_in_window: i64,
    pub sent_messages_in_window: i64,
    pub window_start_ms: i64,
    pub overload_notified: bool,
    /// 送信者ごとに受け取った最大の sequenceNumber。timer で ackUpstream として返す。
    pub received: Vec<ReceivedMark>,
    pub unexpected_events: Vec<String>,
}

pub fn initial_state(t: i64) -> ShardState {
    ShardState {
        participants: Vec::new(),
        subscriptions: Vec::new(),
        ladders: Vec::new(),
        trends: Vec::new(),
        speakers: Vec::new(),
        encoder_tiers: Vec::new(),
        budget_bytes_per_sec: NODE_MAX_OUT_BYTES_PER_SEC,
        sent_bytes_in_window: 0,
        sent_messages_in_window: 0,
        window_start_ms: t,
        overload_notified: false,
        received: Vec::new(),
        unexpected_events: Vec::new(),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 入力イベント
// ─────────────────────────────────────────────────────────────────────────────

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
        seq: i64,
    },
    Subscribe {
        from: i64,
        to: i64,
        ch: i64,
        want: bool,
        max_spatial_id: i64,
        max_temporal_id: i64,
    },
    Ack {
        from: i64,
        to: i64,
        ch: i64,
        sid: i64,
        highest_seq: i64,
    },
    StreamAnnounce {
        from: i64,
        ch: i64,
        rungs: Vec<LadderRung>,
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
    /// 購読者からのキーフレーム要求（ADR-0039）。
    /// 購読していない相手への要求は無視して記録する。
    KeyframeRequest {
        from: i64,
        target: i64,
        ch: i64,
        sid: i64,
    },
}

// ─────────────────────────────────────────────────────────────────────────────
// 出力コマンド
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShardCommand {
    Forward { to: Vec<i64> },
    Drop { priority: i64, count: i64 },
    SetTier { target_id: i64, tier: i64 },
    /// キーフレームの要求。段ごとに符号化器が別であるため channel と spatial_id を持つ（ADR-0033）。
    KeyframeRequest { target_id: i64, channel: i64, spatial_id: i64 },
    /// 上流（送信ノード）へ返す受信位置。これが無いと送信ノードの送信窓が開かない。
    AckUpstream { to: i64, channel: i64, spatial_id: i64, highest_seq: i64 },
    Disconnect { peer: i64 },
    Notify { code: i64 },
}

pub struct StepResult {
    pub state: ShardState,
    pub commands: Vec<ShardCommand>,
}

// ─────────────────────────────────────────────────────────────────────────────
// ステップ関数
// ─────────────────────────────────────────────────────────────────────────────

pub fn step(state: &ShardState, event: &ShardEvent, t: i64) -> StepResult {
    match event {
        ShardEvent::Media { from, ch, sid, tid, key: _, bytes, flags, seq } => {
            handle_media(state, &MediaFields {
                from: *from, ch: *ch, sid: *sid, tid: *tid,
                bytes: *bytes, flags: *flags, seq: *seq,
            }, t)
        }
        ShardEvent::Subscribe { from, to, ch, want, max_spatial_id, max_temporal_id } => {
            handle_subscribe(state, *from, *to, *ch, *want, *max_spatial_id, *max_temporal_id, t)
        }
        ShardEvent::Ack { from, to, ch, sid, highest_seq } => {
            handle_ack(state, *from, *to, *ch, *sid, *highest_seq, t)
        }
        ShardEvent::StreamAnnounce { from, ch, rungs } => {
            handle_stream_announce(state, *from, *ch, rungs, t)
        }
        ShardEvent::Join { id } => handle_join(state, *id),
        ShardEvent::Leave { id } => handle_leave(state, *id),
        ShardEvent::Link { .. } => {
            let mut next = state.clone();
            push_unexpected(&mut next.unexpected_events, "link");
            StepResult { state: next, commands: Vec::new() }
        }
        ShardEvent::Timer => handle_timer(state, t),
        ShardEvent::Budget { bytes_per_sec } => {
            let mut next = state.clone();
            next.budget_bytes_per_sec = *bytes_per_sec;
            evaluate_all(&next, t)
        }
        ShardEvent::Report { from, delay_us } => handle_report(state, *from, delay_us, t),
        ShardEvent::KeyframeRequest { from, target, ch, sid } => {
            handle_keyframe_request(state, *from, *target, *ch, *sid)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 音声チャネル判定
// ─────────────────────────────────────────────────────────────────────────────

fn is_audio_channel(ch: i64) -> bool {
    ch == i64::from(CHANNEL_AUDIO) || ch == i64::from(CHANNEL_SCREEN_AUDIO)
}

// ─────────────────────────────────────────────────────────────────────────────
// メディア
// ─────────────────────────────────────────────────────────────────────────────

/// メディアユニットのフィールドを束ねる（引数が多くなることへの抑制を避けるため）。
struct MediaFields {
    from: i64,
    ch: i64,
    sid: i64,
    tid: i64,
    bytes: i64,
    flags: i64,
    seq: i64,
}

fn handle_media(state: &ShardState, m: &MediaFields, t: i64) -> StepResult {
    let MediaFields { from, ch, sid, tid, bytes, flags, seq } = *m;
    let windowed = observe_ladder(&maybe_reset_window(state, t), from, ch, sid);

    // 音声で ACTIVE_SPEAKER が立っていれば発話時刻を記録する（選別転送。ADR-0024）。
    let audio = is_audio_channel(ch);
    let speaking = (flags & i64::from(FLAG_ACTIVE_SPEAKER)) != 0;
    let with_speech = if audio && speaking {
        let mut s = windowed.clone();
        s.speakers = record_speech(&windowed.speakers, from, t);
        s
    } else {
        windowed
    };

    let priority = drop_priority(ch as u8, flags as u8).map(i64::from);
    // 受け取った位置を記録する。ack はタイマーでまとめて返す（congestion.md 2 節）。
    let with_speech = mark_received(&with_speech, from, ch, sid, seq);

    let mut targets: Vec<i64> = Vec::new();
    let mut dropped: Vec<(i64, i64)> = Vec::new(); // (priority, count) を後で集約する
    let mut next_subscriptions: Vec<Subscription> = Vec::new();
    // 参照連鎖が切れた購読が 1 つでもあれば、送信者へキーフレームを 1 度だけ要求する
    // （規範 1.4）。購読ごとに出すと同じ要求が並ぶ。要求は段ごとに 1 件で足りる。
    let mut wants_keyframe = false;

    for sub in &with_speech.subscriptions {
        if sub.target_id != from || sub.channel != ch {
            next_subscriptions.push(sub.clone());
            continue;
        }
        let decision = decide_for_subscription(&with_speech, sub, sid, tid, seq, ch, priority, t);
        next_subscriptions.push(decision.subscription);
        if decision.request_keyframe {
            wants_keyframe = true;
        }
        if decision.forward {
            targets.push(sub.subscriber_id);
        } else if let Some(dp) = decision.drop_priority {
            dropped.push((dp, 1));
        }
    }

    // 購読者 ID の昇順（決定性のため）。
    targets.sort_unstable();

    // 破棄は priority の昇順でまとめる。
    let mut drop_map: Vec<(i64, i64)> = Vec::new();
    dropped.sort_unstable();
    for (p, _) in &dropped {
        if let Some(last) = drop_map.last_mut() {
            if last.0 == *p {
                last.1 += 1;
                continue;
            }
        }
        drop_map.push((*p, 1));
    }

    let mut commands: Vec<ShardCommand> = Vec::new();
    for (p, c) in &drop_map {
        commands.push(ShardCommand::Drop { priority: *p, count: *c });
    }
    // 破棄の報告の後に置く（順序を固定しないとトレースの完全一致が壊れる）。
    if wants_keyframe {
        commands.push(ShardCommand::KeyframeRequest { target_id: from, channel: ch, spatial_id: sid });
    }

    if targets.is_empty() {
        let mut s = with_speech;
        s.subscriptions = next_subscriptions;
        return StepResult { state: s, commands };
    }

    commands.push(ShardCommand::Forward { to: targets.clone() });

    // ノード全体の予算を計上する。転送の可否には使わない（ADR-0025 の 5）。
    let msg_cost = targets.len() as i64;
    let byte_cost = msg_cost * bytes;
    let mut accounted = with_speech;
    accounted.subscriptions = next_subscriptions;
    accounted.sent_messages_in_window += msg_cost;
    accounted.sent_bytes_in_window += byte_cost;

    let overload = notify_node_overload(&accounted, t);
    commands.extend(overload.commands);
    StepResult { state: overload.state, commands }
}

// ─────────────────────────────────────────────────────────────────────────────
// 購読ごとの転送判定
// ─────────────────────────────────────────────────────────────────────────────

struct SubscriptionDecision {
    subscription: Subscription,
    forward: bool,
    drop_priority: Option<i64>,
    /// 送信者へキーフレームを要求するか（規範 1.4）。
    /// 順位 4・5 を落としたときだけ真になる。
    request_keyframe: bool,
}

/// 購読 1 本に対する転送の可否を決める。判定の順序は TS と同一でなければならない。
fn decide_for_subscription(
    state: &ShardState,
    sub: &Subscription,
    sid: i64,
    tid: i64,
    seq: i64,
    ch: i64,
    priority: Option<i64>,
    t: i64,
) -> SubscriptionDecision {
    // 1. ack が途絶えている → 渡さない
    if sub.stalled {
        // 音声は接続が停止していても通す（音声は破棄禁止）。
        // stalled は「ACK_TIMEOUT_MS の間 ack が届かない」状態であり、接続が切れたと判断した
        // ものである。しかし音声を落とすと、復帰しても stalled が解除されない限り音声が
        // 届かない。映像は stalled の間落としてよい（接続が切れた相手へ映像を送り続けると
        // ノードの予算を食う）。音声だけは通すことで、接続が復帰したときに音声が即座に戻る。
        if is_audio_channel(ch) {
            return forward_decision(state, &sub, sid, tid, seq, ch);
        }
        return SubscriptionDecision { subscription: sub.clone(), forward: false, drop_priority: None, request_keyframe: false };
    }

    // 音声の選別転送（ADR-0024、ADR-0029 の 2）。
    // 本数は購読者ごとに決める。帯域が細い購読者へ多数の音声を送ると映像の余地が無くなる。
    if is_audio_channel(ch) && !is_audio_forwarded(state, sub, sub.target_id, t) {
        // 輻輳による破棄ではないため priority は 0 とする（ADR-0024 の 5）。
        return SubscriptionDecision { subscription: sub.clone(), forward: false, drop_priority: Some(0), request_keyframe: false };
    }

    // 音声は段を持たない。段の選択は映像のみ。
    if !is_audio_channel(ch) {
        let chosen = choose_rung(state, sub);
        // 2. 段が合わない → 渡さない
        if sid != chosen {
            return SubscriptionDecision { subscription: sub.clone(), forward: false, drop_priority: None, request_keyframe: false };
        }
        // 3. temporalId の超過 → 渡さない
        if tid > sub.max_temporal_id {
            return SubscriptionDecision { subscription: sub.clone(), forward: false, drop_priority: None, request_keyframe: false };
        }
    }

    let must_forward = priority.is_none();

    // **参照連鎖が切れている間は、次の KEY まで落とし続ける**（規範 1.4）。
    // 音声を除外した後、priority が None ⟺ KEY（drop_priority の定義より）。
    if !is_audio_channel(ch) && sub.awaiting_key_sid == sid {
        if !must_forward {
            // 落とす。要求は最初の 1 回で送っているため繰り返さない。
            return SubscriptionDecision { subscription: sub.clone(), forward: false, drop_priority: priority, request_keyframe: false };
        }
        // KEY が来た。参照連鎖が回復するため、待ちを解いて渡す。
        let cleared = Subscription { awaiting_key_sid: -1, ..sub.clone() };
        return forward_decision(state, &cleared, sid, tid, seq, ch);
    }

    // 4. 輻輳状態による破棄
    if !must_forward && should_drop_in_congestion(sub, tid, priority) {
        return drop_with_chain(sub, sid, priority);
    }

    // 5. 送信窓が閉じている
    if !must_forward && is_window_closed(state, sub, seq, ch) {
        return drop_with_chain(sub, sid, priority);
    }

    // 6. 渡す
    forward_decision(state, sub, sid, tid, seq, ch)
}

/// 破棄する。順位 4・5 なら次の KEY までの連続破棄を始め、キーフレームを要求する（規範 1.4）。
/// 順位 1〜3（破棄可能なユニット）では連鎖を始めず、要求も作らない。
fn drop_with_chain(sub: &Subscription, sid: i64, priority: Option<i64>) -> SubscriptionDecision {
    let breaks_chain = priority == Some(4) || priority == Some(5);
    if !breaks_chain {
        return SubscriptionDecision { subscription: sub.clone(), forward: false, drop_priority: priority, request_keyframe: false };
    }
    SubscriptionDecision {
        subscription: Subscription { awaiting_key_sid: sid, ..sub.clone() },
        forward: false,
        drop_priority: priority,
        request_keyframe: true,
    }
}

/// 転送する。段が変わっていれば窓を作り直す。
fn forward_decision(state: &ShardState, sub: &Subscription, _sid: i64, _tid: i64, seq: i64, ch: i64) -> SubscriptionDecision {
    let chosen = if is_audio_channel(ch) { 0 } else { choose_rung(state, sub) };
    if chosen != sub.window_sid {
        // 渡す段が変わった。seq の空間が変わるため窓を作り直す。
        let updated = Subscription {
            window_sid: chosen,
            highest_sent: seq,
            highest_acked: seq - 1,
            ..sub.clone()
        };
        return SubscriptionDecision { subscription: updated, forward: true, drop_priority: None, request_keyframe: false };
    }
    let highest_sent = if seq > sub.highest_sent { seq } else { sub.highest_sent };
    let updated = Subscription { highest_sent, ..sub.clone() };
    SubscriptionDecision { subscription: updated, forward: true, drop_priority: None, request_keyframe: false }
}

/// この購読へ渡す段を 1 つ選ぶ（ADR-0027 の 3）。
fn choose_rung(state: &ShardState, sub: &Subscription) -> i64 {
    let wanted = sub.max_spatial_id - sub.tier_penalty;
    let effective = if wanted < 0 { 0 } else { wanted };
    let ladder = find_ladder(state, sub.target_id, sub.channel);
    let rungs = match ladder {
        Some(l) if !l.rungs.is_empty() => &l.rungs,
        _ => return effective,
    };
    let mut best: i64 = -1;
    let mut lowest: i64 = -1;
    for rung in rungs {
        if lowest < 0 || rung.sid < lowest {
            lowest = rung.sid;
        }
        if rung.sid <= effective && rung.sid > best {
            best = rung.sid;
        }
    }
    if best >= 0 {
        return best;
    }
    if lowest < 0 { effective } else { lowest }
}

/// 送信窓が閉じているか（congestion.md 2 節）。交差乗算で除算を避ける。
fn is_window_closed(state: &ShardState, sub: &Subscription, seq: i64, ch: i64) -> bool {
    let framerate = framerate_of(state, sub);
    if framerate <= 0 {
        return false;
    }
    // 窓がまだこの連番の空間に無いときは評価しない（ADR-0038）。
    // 購読を張った時点の窓は window_sid = -1 であり、流れている媒体の連番は既に大きい。
    // そのまま比べると最初の 1 件から窓が閉じていると判定され、1 枚も届かない。
    let chosen = if is_audio_channel(ch) { 0 } else { choose_rung(state, sub) };
    if chosen != sub.window_sid {
        return false;
    }
    let in_flight = in_flight_frames(sub, seq);
    // inFlightMs > SEND_WINDOW_MS ⇔ in_flight * 1000 > SEND_WINDOW_MS * framerate
    in_flight * 1000 > SEND_WINDOW_MS * framerate
}

/// 未確認のフレーム数。
fn in_flight_frames(sub: &Subscription, seq: i64) -> i64 {
    let highest = if seq > sub.highest_sent { seq } else { sub.highest_sent };
    let in_flight = highest - sub.highest_acked - 1;
    if in_flight < 0 { 0 } else { in_flight }
}

/// この購読が渡している段の fps。申告が無ければ 0。
fn framerate_of(state: &ShardState, sub: &Subscription) -> i64 {
    let ladder = match find_ladder(state, sub.target_id, sub.channel) {
        Some(l) => l,
        None => return 0,
    };
    if !ladder.announced {
        return 0;
    }
    let chosen = choose_rung(state, sub);
    for rung in &ladder.rungs {
        if rung.sid == chosen {
            return rung.framerate;
        }
    }
    0
}

/// 輻輳状態に応じた破棄判定。
fn should_drop_in_congestion(sub: &Subscription, tid: i64, priority: Option<i64>) -> bool {
    match sub.congestion {
        Congestion::Normal => false,
        Congestion::SheddingT2 => {
            match priority {
                Some(p) => p <= 3,
                None => false,
            }
        }
        Congestion::SheddingT1 => tid >= 1,
        Congestion::SheddingSpatial => tid >= 1,
        Congestion::KeyOnly => true,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 音声の選別転送（ADR-0024）
// ─────────────────────────────────────────────────────────────────────────────

/// 音声の選別転送（ADR-0024、ADR-0029 の 2）。購読者ごとに本数を決める。
fn is_audio_forwarded(state: &ShardState, sub: &Subscription, sender_id: i64, t: i64) -> bool {
    let limit = audio_limit_for(sub);
    let mut active: Vec<&SpeakerActivity> = Vec::new();
    for entry in &state.speakers {
        if t - entry.last_speech_at_ms <= AUDIO_SPEAKER_HOLD_MS {
            active.push(entry);
        }
    }
    if (active.len() as i64) <= limit {
        // 上限に達していない。全員の音声を通す。DTX の無音で環境音が完全に消えると
        // 通話が不自然になるためである（ADR-0024 の 6）。
        return true;
    }
    // 時刻の降順、同時刻なら sender_id の昇順。
    active.sort_by(|a, b| {
        b.last_speech_at_ms
            .cmp(&a.last_speech_at_ms)
            .then(a.sender_id.cmp(&b.sender_id))
    });
    active
        .iter()
        .take(limit as usize)
        .any(|entry| entry.sender_id == sender_id)
}

/// この購読者へ同時に転送する音声の本数（ADR-0029 の 2）。
/// 輻輳の段が深いほど減らす。1 本は必ず残す。
fn audio_limit_for(sub: &Subscription) -> i64 {
    let reduced = AUDIO_SELECTIVE_FORWARD_COUNT - congestion_depth(sub.congestion);
    if reduced < AUDIO_SELECTIVE_MIN_COUNT {
        AUDIO_SELECTIVE_MIN_COUNT
    } else {
        reduced
    }
}

/// 輻輳の深さ。NORMAL が 0 で、段が深くなるほど大きい。
fn congestion_depth(state: Congestion) -> i64 {
    match state {
        Congestion::Normal => 0,
        Congestion::SheddingT2 => 1,
        Congestion::SheddingT1 => 2,
        Congestion::SheddingSpatial => 3,
        Congestion::KeyOnly => 4,
    }
}

fn record_speech(speakers: &[SpeakerActivity], sender_id: i64, t: i64) -> Vec<SpeakerActivity> {
    let mut updated: Vec<SpeakerActivity> = Vec::new();
    let mut replaced = false;
    for entry in speakers {
        if entry.sender_id == sender_id {
            updated.push(SpeakerActivity { sender_id, last_speech_at_ms: t });
            replaced = true;
            continue;
        }
        updated.push(entry.clone());
    }
    if !replaced {
        updated.push(SpeakerActivity { sender_id, last_speech_at_ms: t });
        updated.sort_by_key(|e| e.sender_id);
    }
    updated
}

// ─────────────────────────────────────────────────────────────────────────────
// 購読
// ─────────────────────────────────────────────────────────────────────────────

fn handle_subscribe(
    state: &ShardState,
    from: i64,
    to: i64,
    ch: i64,
    want: bool,
    max_spatial_id: i64,
    max_temporal_id: i64,
    t: i64,
) -> StepResult {
    let existing = state.subscriptions.iter().find(
        |s| s.subscriber_id == from && s.target_id == to && s.channel == ch,
    );
    let rest: Vec<Subscription> = state
        .subscriptions
        .iter()
        .filter(|s| !(s.subscriber_id == from && s.target_id == to && s.channel == ch))
        .cloned()
        .collect();

    if !want {
        let mut next = state.clone();
        next.subscriptions = rest;
        next.subscriptions.sort_by(subscription_order);
        return with_encoder_tiers(next);
    }

    let created = Subscription {
        subscriber_id: from,
        target_id: to,
        channel: ch,
        max_spatial_id,
        max_temporal_id,
        window_sid: existing.map(|e| e.window_sid).unwrap_or(-1),
        highest_sent: existing.map(|e| e.highest_sent).unwrap_or(0),
        highest_acked: existing.map(|e| e.highest_acked).unwrap_or(0),
        last_ack_at_ms: t,
        stalled: false,
        congestion: existing.map(|e| e.congestion).unwrap_or(Congestion::Normal),
        congestion_entered_at: existing.map(|e| e.congestion_entered_at).unwrap_or(t),
        tier_penalty: existing.map(|e| e.tier_penalty).unwrap_or(0),
        awaiting_key_sid: existing.map(|e| e.awaiting_key_sid).unwrap_or(-1),
    };

    let mut next = state.clone();
    next.subscriptions = rest;
    next.subscriptions.push(created);
    next.subscriptions.sort_by(subscription_order);
    with_encoder_tiers(next)
}

/// 購読の和集合から送信者ごとの上限段を求め、変化した送信者へ setTier を出す（ADR-0022）。
fn with_encoder_tiers(mut state: ShardState) -> StepResult {
    let mut targets: Vec<i64> = Vec::new();
    for sub in &state.subscriptions {
        if !targets.contains(&sub.target_id) {
            targets.push(sub.target_id);
        }
    }
    targets.sort_unstable();

    let mut next_tiers: Vec<EncoderTier> = Vec::new();
    let mut commands: Vec<ShardCommand> = Vec::new();
    for target_id in &targets {
        let mut tier: i64 = 0;
        for sub in &state.subscriptions {
            if sub.target_id == *target_id && sub.max_spatial_id > tier {
                tier = sub.max_spatial_id;
            }
        }
        next_tiers.push(EncoderTier { target_id: *target_id, tier });
        let previous = state.encoder_tiers.iter().find(|e| e.target_id == *target_id);
        match previous {
            Some(e) if e.tier == tier => {}
            _ => commands.push(ShardCommand::SetTier { target_id: *target_id, tier }),
        }
    }
    state.encoder_tiers = next_tiers;
    StepResult { state, commands }
}

fn subscription_order(a: &Subscription, b: &Subscription) -> std::cmp::Ordering {
    a.subscriber_id
        .cmp(&b.subscriber_id)
        .then(a.target_id.cmp(&b.target_id))
        .then(a.channel.cmp(&b.channel))
}

// ─────────────────────────────────────────────────────────────────────────────
// ack
// ─────────────────────────────────────────────────────────────────────────────

fn handle_ack(state: &ShardState, from: i64, to: i64, ch: i64, sid: i64, highest_seq: i64, t: i64) -> StepResult {
    let target = state.subscriptions.iter().find(
        |s| s.subscriber_id == from && s.target_id == to && s.channel == ch,
    );
    let target = match target {
        Some(sub) => sub,
        None => {
            // 購読が無い ack は無視する。
            let mut next = state.clone();
            push_unexpected(&mut next.unexpected_events, "ack");
            return StepResult { state: next, commands: Vec::new() };
        }
    };

    if sid != target.window_sid {
        // 渡していない段への ack。段を変えた直後に古い ack が届く。無視する。
        let mut next = state.clone();
        push_unexpected(&mut next.unexpected_events, "ack");
        return StepResult { state: next, commands: Vec::new() };
    }

    // 後戻りする ack は無視する。
    let highest_acked = if highest_seq > target.highest_acked { highest_seq } else { target.highest_acked };
    let updated = Subscription {
        highest_acked,
        last_ack_at_ms: t,
        stalled: false,
        ..target.clone()
    };
    let mut next = state.clone();
    let idx = next.subscriptions.iter().position(|s| {
        s.subscriber_id == from && s.target_id == to && s.channel == ch
    });
    if let Some(i) = idx {
        next.subscriptions[i] = updated;
    }
    // ack で未確認量が減るため、輻輳状態を再評価する。
    evaluate_all(&next, t)
}

// ─────────────────────────────────────────────────────────────────────────────
// streamAnnounce
// ─────────────────────────────────────────────────────────────────────────────

fn handle_stream_announce(state: &ShardState, from: i64, ch: i64, rungs: &[LadderRung], t: i64) -> StepResult {
    let mut sorted_rungs: Vec<LadderRung> = rungs.to_vec();
    sorted_rungs.sort_by_key(|r| r.sid);

    let mut next = state.clone();
    next.ladders.retain(|l| !(l.from == from && l.ch == ch));
    next.ladders.push(Ladder { from, ch, rungs: sorted_rungs, announced: true });
    next.ladders.sort_by(ladder_order);
    // はしごが変わると段と fps が変わるため再評価する。
    evaluate_all(&next, t)
}

// ─────────────────────────────────────────────────────────────────────────────
// 参加と退出
// ─────────────────────────────────────────────────────────────────────────────

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
    next.participants.retain(|v| *v != id);
    next.subscriptions.retain(|s| s.subscriber_id != id && s.target_id != id);
    next.trends.retain(|t| t.subscriber_id != id);
    next.ladders.retain(|l| l.from != id);
    next.speakers.retain(|s| s.sender_id != id);
    next.encoder_tiers.retain(|e| e.target_id != id);
    next.received.retain(|m| m.from != id);
    with_encoder_tiers(next)
}

// ─────────────────────────────────────────────────────────────────────────────
// タイマー
// ─────────────────────────────────────────────────────────────────────────────

fn handle_timer(state: &ShardState, t: i64) -> StepResult {
    let windowed = maybe_reset_window(state, t);
    let stalled = detect_ack_timeout(&windowed, t);
    let evaluated = evaluate_all(&stalled.state, t);
    let mut commands = stalled.commands;
    commands.extend(evaluated.commands);
    // 上流（送信ノード）へ受信位置を返す。返さないと送信ノードの窓が開かない。
    for mark in &evaluated.state.received {
        commands.push(ShardCommand::AckUpstream {
            to: mark.from,
            channel: mark.ch,
            spatial_id: mark.sid,
            highest_seq: mark.highest_seq,
        });
    }
    StepResult { state: evaluated.state, commands }
}

/// 受け取った位置を更新する。後戻りする値では更新しない。順序は from, ch, sid の昇順。
fn mark_received(state: &ShardState, from: i64, ch: i64, sid: i64, seq: i64) -> ShardState {
    if seq <= 0 {
        return state.clone();
    }
    if let Some(existing) = state
        .received
        .iter()
        .find(|m| m.from == from && m.ch == ch && m.sid == sid)
    {
        if existing.highest_seq >= seq {
            return state.clone();
        }
    }
    let mut next = state.clone();
    next.received
        .retain(|m| !(m.from == from && m.ch == ch && m.sid == sid));
    next.received.push(ReceivedMark { from, ch, sid, highest_seq: seq });
    next.received.sort_by(|a, b| {
        (a.from, a.ch, a.sid).cmp(&(b.from, b.ch, b.sid))
    });
    next
}

/// ack が途絶えた購読を検出する（congestion.md 7 節）。
fn detect_ack_timeout(state: &ShardState, t: i64) -> StepResult {
    let mut commands: Vec<ShardCommand> = Vec::new();
    let mut subscriptions: Vec<Subscription> = Vec::new();
    for sub in &state.subscriptions {
        let outstanding = sub.highest_sent > sub.highest_acked;
        if !sub.stalled && !outstanding {
            // 未確認が無い間は時計を進める（ADR-0041）。
            // 「無通信」と「無応答」を区別するため、未確認の媒体が無い購読は
            // lastAckAtMs を現在時刻で更新する。
            let mut updated = sub.clone();
            updated.last_ack_at_ms = t;
            subscriptions.push(updated);
            continue;
        }
        if sub.stalled || t - sub.last_ack_at_ms < ACK_TIMEOUT_MS {
            subscriptions.push(sub.clone());
            continue;
        }
        let mut stalled_sub = sub.clone();
        stalled_sub.stalled = true;
        subscriptions.push(stalled_sub);
        commands.push(ShardCommand::Disconnect { peer: sub.subscriber_id });
    }
    let mut next = state.clone();
    next.subscriptions = subscriptions;
    StepResult { state: next, commands }
}

// ─────────────────────────────────────────────────────────────────────────────
// 報告（report）
// ─────────────────────────────────────────────────────────────────────────────

fn handle_report(state: &ShardState, from: i64, delay_us: &[i64], t: i64) -> StepResult {
    let slope = delay_slope(delay_us);
    let mut next = state.clone();
    next.trends.retain(|tr| tr.subscriber_id != from);
    next.trends.push(ReceiverTrend {
        subscriber_id: from,
        numerator: slope.numerator,
        denominator: slope.denominator,
    });
    next.trends.sort_by_key(|tr| tr.subscriber_id);
    evaluate_all(&next, t)
}

/// 購読者のキーフレーム要求を送信者への要求へ直す（ADR-0039）。
///
/// 購読が無い相手への要求は無視して記録する（表に無い遷移として扱う）。
fn handle_keyframe_request(state: &ShardState, from: i64, target: i64, ch: i64, sid: i64) -> StepResult {
    let subscribed = state.subscriptions.iter().any(|sub| {
        sub.subscriber_id == from && sub.target_id == target && sub.channel == ch
    });
    if !subscribed {
        let mut next = state.clone();
        push_unexpected(&mut next.unexpected_events, "keyframeRequest");
        return StepResult { state: next, commands: Vec::new() };
    }
    StepResult {
        state: state.clone(),
        commands: vec![ShardCommand::KeyframeRequest {
            target_id: target,
            channel: ch,
            spatial_id: sid,
        }],
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// はしごの観測
// ─────────────────────────────────────────────────────────────────────────────

/// 観測からはしごを補う。申告が届く前でも段の集合が分かる。
fn observe_ladder(state: &ShardState, from: i64, ch: i64, sid: i64) -> ShardState {
    if is_audio_channel(ch) {
        return state.clone();
    }
    let existing = find_ladder(state, from, ch);
    match existing {
        Some(ladder) => {
            if ladder.announced || ladder.rungs.iter().any(|r| r.sid == sid) {
                return state.clone();
            }
            let mut rungs = ladder.rungs.clone();
            rungs.push(observed_rung(sid));
            rungs.sort_by_key(|r| r.sid);
            let mut next = state.clone();
            next.ladders.retain(|l| !(l.from == from && l.ch == ch));
            next.ladders.push(Ladder { from, ch, rungs, announced: false });
            next.ladders.sort_by(ladder_order);
            next
        }
        None => {
            let mut next = state.clone();
            next.ladders.push(Ladder {
                from,
                ch,
                rungs: vec![observed_rung(sid)],
                announced: false,
            });
            next.ladders.sort_by(ladder_order);
            next
        }
    }
}

fn observed_rung(sid: i64) -> LadderRung {
    LadderRung { sid, width: 0, height: 0, framerate: 0, temporal_layers: 0, target_bitrate: 0 }
}

fn find_ladder(state: &ShardState, from: i64, ch: i64) -> Option<&Ladder> {
    state.ladders.iter().find(|l| l.from == from && l.ch == ch)
}

fn ladder_order(a: &Ladder, b: &Ladder) -> std::cmp::Ordering {
    a.from.cmp(&b.from).then(a.ch.cmp(&b.ch))
}

// ─────────────────────────────────────────────────────────────────────────────
// 輻輳状態の遷移（購読単位）
// ─────────────────────────────────────────────────────────────────────────────

/// すべての購読の輻輳状態を評価する。購読ごとに独立（ADR-0025 の 3）。
fn evaluate_all(state: &ShardState, t: i64) -> StepResult {
    let mut commands: Vec<ShardCommand> = Vec::new();
    let mut subscriptions: Vec<Subscription> = Vec::new();
    for sub in &state.subscriptions {
        let result = evaluate_subscription(state, sub, t);
        subscriptions.push(result.0);
        commands.extend(result.1);
    }
    let mut next = state.clone();
    next.subscriptions = subscriptions;
    StepResult { state: next, commands }
}

/// 購読 1 本の輻輳状態を評価する。
fn evaluate_subscription(state: &ShardState, sub: &Subscription, t: i64) -> (Subscription, Vec<ShardCommand>) {
    // ヒステリシス: 現状態に入ってから一定時間は遷移しない（振動を防ぐ）。
    if t - sub.congestion_entered_at < SHEDDING_HYSTERESIS_MS {
        return (sub.clone(), Vec::new());
    }

    let next = match sub.congestion {
        Congestion::Normal => {
            if fill_greater(state, sub, SHARD_UTIL_ENTER_T2_NUM, SHARD_UTIL_ENTER_T2_DEN)
                || trend_greater(state, sub, SHARD_TREND_ENTER_T2_NUM, SHARD_TREND_ENTER_T2_DEN)
            {
                Congestion::SheddingT2
            } else {
                Congestion::Normal
            }
        }
        Congestion::SheddingT2 => {
            if fill_greater(state, sub, SHARD_UTIL_ENTER_T1_NUM, SHARD_UTIL_ENTER_T1_DEN)
                || trend_greater(state, sub, SHARD_TREND_ENTER_T1_NUM, SHARD_TREND_ENTER_T1_DEN)
            {
                Congestion::SheddingT1
            } else if fill_less(state, sub, SHARD_UTIL_EXIT_T2_NUM, SHARD_UTIL_EXIT_T2_DEN)
                && trend_less(state, sub, SHARD_TREND_EXIT_NUM, SHARD_TREND_EXIT_DEN)
            {
                Congestion::Normal
            } else {
                Congestion::SheddingT2
            }
        }
        Congestion::SheddingT1 => {
            if fill_greater(state, sub, SHARD_UTIL_ENTER_SPATIAL_NUM, SHARD_UTIL_ENTER_SPATIAL_DEN)
                || trend_greater(state, sub, SHARD_TREND_ENTER_SPATIAL_NUM, SHARD_TREND_ENTER_SPATIAL_DEN)
            {
                Congestion::SheddingSpatial
            } else if fill_less(state, sub, SHARD_UTIL_EXIT_T1_NUM, SHARD_UTIL_EXIT_T1_DEN)
                && trend_less(state, sub, SHARD_TREND_EXIT_NUM, SHARD_TREND_EXIT_DEN)
            {
                Congestion::SheddingT2
            } else {
                Congestion::SheddingT1
            }
        }
        Congestion::SheddingSpatial => {
            if fill_greater(state, sub, SHARD_UTIL_ENTER_KEY_ONLY_NUM, SHARD_UTIL_ENTER_KEY_ONLY_DEN)
                || trend_greater(state, sub, SHARD_TREND_ENTER_KEY_ONLY_NUM, SHARD_TREND_ENTER_KEY_ONLY_DEN)
            {
                Congestion::KeyOnly
            } else if fill_less(state, sub, SHARD_UTIL_EXIT_SPATIAL_NUM, SHARD_UTIL_EXIT_SPATIAL_DEN)
                && trend_less(state, sub, SHARD_TREND_EXIT_NUM, SHARD_TREND_EXIT_DEN)
            {
                Congestion::SheddingT1
            } else {
                Congestion::SheddingSpatial
            }
        }
        Congestion::KeyOnly => {
            if fill_less(state, sub, SHARD_UTIL_EXIT_KEY_ONLY_NUM, SHARD_UTIL_EXIT_KEY_ONLY_DEN)
                && trend_less(state, sub, SHARD_TREND_EXIT_KEY_ONLY_NUM, SHARD_TREND_EXIT_KEY_ONLY_DEN)
            {
                Congestion::SheddingSpatial
            } else {
                Congestion::KeyOnly
            }
        }
    };

    if next == sub.congestion {
        return (sub.clone(), Vec::new());
    }

    let penalty = if next == Congestion::SheddingSpatial || next == Congestion::KeyOnly { 1 } else { 0 };
    let updated = Subscription {
        congestion: next,
        congestion_entered_at: t,
        tier_penalty: penalty,
        ..sub.clone()
    };

    let mut commands: Vec<ShardCommand> = Vec::new();
    if penalty != sub.tier_penalty {
        // 購読者へ setTier を送ってはならない（ADR-0033）。段の変化は媒体の spatialId で伝わる。
        commands.push(ShardCommand::KeyframeRequest {
            target_id: sub.target_id,
            channel: sub.channel,
            spatial_id: choose_rung(state, &updated),
        });
    }
    (updated, commands)
}

// ─────────────────────────────────────────────────────────────────────────────
// fill / trend ヘルパー
// ─────────────────────────────────────────────────────────────────────────────

/// 送信窓の充填率が閾値を超えているか（購読単位）。
fn fill_greater(state: &ShardState, sub: &Subscription, num: i64, den: i64) -> bool {
    let framerate = framerate_of(state, sub);
    if framerate <= 0 {
        return false;
    }
    let in_flight = in_flight_frames(sub, sub.highest_sent);
    in_flight * 1000 * den > num * SEND_WINDOW_MS * framerate
}

fn fill_less(state: &ShardState, sub: &Subscription, num: i64, den: i64) -> bool {
    let framerate = framerate_of(state, sub);
    if framerate <= 0 {
        // 充填率を評価できない。回復を妨げないため、条件を満たすとみなす。
        return num > 0;
    }
    let in_flight = in_flight_frames(sub, sub.highest_sent);
    in_flight * 1000 * den < num * SEND_WINDOW_MS * framerate
}

/// この購読者の遅延勾配が閾値を超えているか。他の購読者の勾配は見ない（ADR-0025 の 4）。
fn trend_greater(state: &ShardState, sub: &Subscription, num: i64, den: i64) -> bool {
    let trend = state.trends.iter().find(|t| t.subscriber_id == sub.subscriber_id);
    match trend {
        None => false,
        Some(t) => t.numerator * den > num * t.denominator,
    }
}

fn trend_less(state: &ShardState, sub: &Subscription, num: i64, den: i64) -> bool {
    let trend = state.trends.iter().find(|t| t.subscriber_id == sub.subscriber_id);
    match trend {
        None => true,
        Some(t) => t.numerator * den < num * t.denominator,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ノード全体の予算
// ─────────────────────────────────────────────────────────────────────────────

/// ノード全体の予算超過を通知する。転送の可否には使わない（ADR-0025 の 5）。
fn notify_node_overload(state: &ShardState, t: i64) -> StepResult {
    if state.overload_notified {
        return StepResult { state: state.clone(), commands: Vec::new() };
    }
    let elapsed = t - state.window_start_ms;
    if elapsed <= 0 {
        return StepResult { state: state.clone(), commands: Vec::new() };
    }
    let messages_over = state.sent_messages_in_window * 1000 > NODE_MAX_OUT_MESSAGES_PER_SEC * elapsed;
    let bytes_over = state.sent_bytes_in_window * 1000 > state.budget_bytes_per_sec * elapsed;
    if !messages_over && !bytes_over {
        return StepResult { state: state.clone(), commands: Vec::new() };
    }
    let mut next = state.clone();
    next.overload_notified = true;
    StepResult {
        state: next,
        commands: vec![ShardCommand::Notify { code: E_NODE_OVERLOADED_CLOSE_CODE }],
    }
}

fn maybe_reset_window(state: &ShardState, t: i64) -> ShardState {
    let elapsed = t - state.window_start_ms;
    if elapsed >= SHARD_UTIL_WINDOW_MS {
        let mut next = state.clone();
        next.sent_bytes_in_window = 0;
        next.sent_messages_in_window = 0;
        next.window_start_ms = t;
        next.overload_notified = false;
        return next;
    }
    state.clone()
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
