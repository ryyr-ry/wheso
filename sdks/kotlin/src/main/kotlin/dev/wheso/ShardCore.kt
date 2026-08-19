// 中継ノード（shard）の判断コア（Kotlin）。
//
// TypeScript の参照実装（packages/core/src/shard-core.ts）と**同じ入力列から同じ出力列**を
// 返さなければならない（conformance.md 2 節の層 2）。照合は凍結トレースで行う。
// 相違した場合はベクタではなく実装を直す（ADR-0012）。
//
// sans-IO。時刻は入力として受け取り、内部で取得しない。
// 浮動小数点を使わない。例外を投げない。反復順序は決定的にする。
package dev.wheso

import dev.wheso.generated.ACK_TIMEOUT_MS
import dev.wheso.generated.MAX_UNEXPECTED_EVENTS
import dev.wheso.generated.AUDIO_SELECTIVE_FORWARD_COUNT
import dev.wheso.generated.AUDIO_SELECTIVE_MIN_COUNT
import dev.wheso.generated.AUDIO_SPEAKER_HOLD_MS
import dev.wheso.generated.CHANNEL_AUDIO
import dev.wheso.generated.CHANNEL_SCREEN_AUDIO
import dev.wheso.generated.Errors
import dev.wheso.generated.FLAG_ACTIVE_SPEAKER
import dev.wheso.generated.FLAG_KEY
import dev.wheso.generated.NODE_MAX_OUT_BYTES_PER_SEC
import dev.wheso.generated.NODE_MAX_OUT_MESSAGES_PER_SEC
import dev.wheso.generated.SEND_WINDOW_MS
import dev.wheso.generated.SHARD_TREND_ENTER_KEY_ONLY_DEN
import dev.wheso.generated.SHARD_TREND_ENTER_KEY_ONLY_NUM
import dev.wheso.generated.SHARD_TREND_ENTER_SPATIAL_DEN
import dev.wheso.generated.SHARD_TREND_ENTER_SPATIAL_NUM
import dev.wheso.generated.SHARD_TREND_ENTER_T1_DEN
import dev.wheso.generated.SHARD_TREND_ENTER_T1_NUM
import dev.wheso.generated.SHARD_TREND_ENTER_T2_DEN
import dev.wheso.generated.SHARD_TREND_ENTER_T2_NUM
import dev.wheso.generated.SHARD_TREND_EXIT_DEN
import dev.wheso.generated.SHARD_TREND_EXIT_KEY_ONLY_DEN
import dev.wheso.generated.SHARD_TREND_EXIT_KEY_ONLY_NUM
import dev.wheso.generated.SHARD_TREND_EXIT_NUM
import dev.wheso.generated.SHARD_UTIL_ENTER_KEY_ONLY_DEN
import dev.wheso.generated.SHARD_UTIL_ENTER_KEY_ONLY_NUM
import dev.wheso.generated.SHARD_UTIL_ENTER_SPATIAL_DEN
import dev.wheso.generated.SHARD_UTIL_ENTER_SPATIAL_NUM
import dev.wheso.generated.SHARD_UTIL_ENTER_T1_DEN
import dev.wheso.generated.SHARD_UTIL_ENTER_T1_NUM
import dev.wheso.generated.SHARD_UTIL_ENTER_T2_DEN
import dev.wheso.generated.SHARD_UTIL_ENTER_T2_NUM
import dev.wheso.generated.SHARD_UTIL_EXIT_KEY_ONLY_DEN
import dev.wheso.generated.SHARD_UTIL_EXIT_KEY_ONLY_NUM
import dev.wheso.generated.SHARD_UTIL_EXIT_SPATIAL_DEN
import dev.wheso.generated.SHARD_UTIL_EXIT_SPATIAL_NUM
import dev.wheso.generated.SHARD_UTIL_EXIT_T1_DEN
import dev.wheso.generated.SHARD_UTIL_EXIT_T1_NUM
import dev.wheso.generated.SHARD_UTIL_EXIT_T2_DEN
import dev.wheso.generated.SHARD_UTIL_EXIT_T2_NUM
import dev.wheso.generated.SHARD_UTIL_WINDOW_MS
import dev.wheso.generated.SHEDDING_HYSTERESIS_MS

// --- 輻輳状態（state-machines.md 3 節） ---

public enum class Congestion(public val label: String) {
    NORMAL("NORMAL"),
    SHEDDING_T2("SHEDDING_T2"),
    SHEDDING_T1("SHEDDING_T1"),
    SHEDDING_SPATIAL("SHEDDING_SPATIAL"),
    KEY_ONLY("KEY_ONLY"),
}

// --- はしごの 1 段（ADR-0026） ---

public data class LadderRung(
    val sid: Long,
    val width: Long,
    val height: Long,
    val framerate: Long,
    val temporalLayers: Long,
    val targetBitrate: Long,
)

// --- 購読 1 本の状態。判断はすべてここに閉じる（ADR-0025） ---

public data class Subscription(
    val subscriberId: Long,
    val targetId: Long,
    val channel: Long,
    val maxSpatialId: Long,
    val maxTemporalId: Long,
    val windowSid: Long,
    val highestSent: Long,
    val highestAcked: Long,
    val lastAckAtMs: Long,
    val stalled: Boolean,
    val congestion: Congestion,
    val congestionEnteredAt: Long,
    val tierPenalty: Long,
    /**
     * 破棄不可のユニット（優先順位 4・5）を落とした段。落としていなければ −1。
     *
     * 規範 1.4: 順位 4 と 5 を破棄する場合は、デコーダの参照連鎖が壊れるため、
     * 必ず同一 (senderId, channel, spatialId) の次の KEY ユニットまで連続して破棄し、
     * 受信者へ keyframeRequest を送る。
     */
    val awaitingKeySid: Long,
)

public data class Ladder(
    val from: Long,
    val ch: Long,
    val rungs: List<LadderRung>,
    val announced: Boolean,
)

public data class ReceiverTrend(val subscriberId: Long, val numerator: Long, val denominator: Long)

public data class SpeakerActivity(val senderId: Long, val lastSpeechAtMs: Long)

public data class EncoderTier(val targetId: Long, val tier: Long)

/** 受け取った位置。ackUpstream の内容になる（受信ノードの ReceivedMark とは別の型である）。 */
public data class ShardReceivedMark(val from: Long, val ch: Long, val sid: Long, val highestSeq: Long)

public data class ShardState(
    val participants: List<Long>,
    val subscriptions: List<Subscription>,
    val ladders: List<Ladder>,
    val trends: List<ReceiverTrend>,
    val speakers: List<SpeakerActivity>,
    val encoderTiers: List<EncoderTier>,
    val budgetBytesPerSec: Long,
    val sentBytesInWindow: Long,
    val sentMessagesInWindow: Long,
    val windowStartMs: Long,
    val overloadNotified: Boolean,
    val received: List<ShardReceivedMark>,
    val unexpectedEvents: List<String>,
)

// --- 入力イベント ---

public sealed interface ShardEvent {
    public data class Media(
        val from: Long, val ch: Long, val sid: Long, val tid: Long,
        val key: Boolean, val bytes: Long, val flags: Long, val seq: Long,
    ) : ShardEvent

    public data class Subscribe(
        val from: Long, val to: Long, val ch: Long, val want: Boolean,
        val maxSpatialId: Long, val maxTemporalId: Long,
    ) : ShardEvent

    public data class Ack(
        val from: Long, val to: Long, val ch: Long, val sid: Long, val highestSeq: Long,
    ) : ShardEvent

    public data class StreamAnnounce(val from: Long, val ch: Long, val rungs: List<LadderRung>) : ShardEvent

    public data class Join(val id: Long) : ShardEvent
    public data class Leave(val id: Long) : ShardEvent
    public data class Link(val peer: Long, val state: String) : ShardEvent
    public object Timer : ShardEvent
    public data class Budget(val bytesPerSec: Long) : ShardEvent
    public data class Report(val from: Long, val delayUs: List<Long>) : ShardEvent

    /// 購読者からのキーフレーム要求（ADR-0039）。
    /// 購読していない相手への要求は無視して記録する。
    public data class KeyframeRequest(val from: Long, val target: Long, val ch: Long, val sid: Long) : ShardEvent
}

// --- 出力コマンド ---

public sealed interface ShardCommand {
    public data class Forward(val to: List<Long>) : ShardCommand
    public data class Drop(val priority: Long, val count: Long) : ShardCommand
    public data class SetTier(val targetId: Long, val tier: Long) : ShardCommand
    /** キーフレームの要求。段ごとに符号化器が別であるため channel と spatialId を持つ（ADR-0033）。 */
    public data class KeyframeRequest(val targetId: Long, val channel: Long, val spatialId: Long) : ShardCommand

    /** 上流（送信ノード）へ返す受信位置。これが無いと送信ノードの送信窓が開かない。 */
    public data class AckUpstream(
        val to: Long,
        val channel: Long,
        val spatialId: Long,
        val highestSeq: Long,
    ) : ShardCommand
    public data class Connect(val peer: Long) : ShardCommand
    public data class Disconnect(val peer: Long) : ShardCommand
    public data class Schedule(val at: Long) : ShardCommand
    public data class Close(val code: Long) : ShardCommand
    public data class Notify(val code: Long) : ShardCommand
}

public data class ShardStepResult(val state: ShardState, val commands: List<ShardCommand>)

public fun initialShardState(t: Long): ShardState = ShardState(
    participants = emptyList(), subscriptions = emptyList(), ladders = emptyList(),
    trends = emptyList(), speakers = emptyList(), encoderTiers = emptyList(),
    budgetBytesPerSec = NODE_MAX_OUT_BYTES_PER_SEC, sentBytesInWindow = 0L,
    sentMessagesInWindow = 0L, windowStartMs = t, overloadNotified = false,
    received = emptyList(),
    unexpectedEvents = emptyList(),
)

public fun shardStep(state: ShardState, event: ShardEvent, t: Long): ShardStepResult = when (event) {
    is ShardEvent.Media -> handleMedia(state, event, t)
    is ShardEvent.Subscribe -> handleSubscribe(state, event, t)
    is ShardEvent.Ack -> handleAck(state, event, t)
    is ShardEvent.StreamAnnounce -> handleStreamAnnounce(state, event, t)
    is ShardEvent.Join -> handleJoin(state, event.id)
    is ShardEvent.Leave -> handleLeave(state, event.id)
    is ShardEvent.Link -> ignoreEvent(state, "link")
    is ShardEvent.Timer -> handleTimer(state, t)
    is ShardEvent.Budget -> handleBudget(state, event, t)
    is ShardEvent.Report -> handleReport(state, event, t)
    is ShardEvent.KeyframeRequest -> handleKeyframeRequest(state, event)
}

private fun ignoreEvent(state: ShardState, name: String): ShardStepResult =
    ShardStepResult(state.copy(unexpectedEvents = appendUnexpected(state.unexpectedEvents, name)), emptyList())

/// 購読者のキーフレーム要求を送信者への要求へ直す（ADR-0039）。
/// 購読が無い相手への要求は無視して記録する。
private fun handleKeyframeRequest(state: ShardState, event: ShardEvent.KeyframeRequest): ShardStepResult {
    val subscribed = state.subscriptions.any {
        it.subscriberId == event.from && it.targetId == event.target && it.channel == event.ch
    }
    if (!subscribed) return ignoreEvent(state, "keyframeRequest")
    return ShardStepResult(
        state,
        listOf(ShardCommand.KeyframeRequest(event.target, event.ch, event.sid)),
    )
}

private fun isAudioChannel(ch: Long): Boolean =
    ch == CHANNEL_AUDIO.toLong() || ch == CHANNEL_SCREEN_AUDIO.toLong()

private fun handleMedia(state: ShardState, event: ShardEvent.Media, t: Long): ShardStepResult {
    val windowed = observeLadder(maybeResetWindow(state, t), event)
    val audio = isAudioChannel(event.ch)
    val speaking = (event.flags and FLAG_ACTIVE_SPEAKER.toLong()) != 0L
    val withSpeech = if (audio && speaking) {
        windowed.copy(speakers = recordSpeech(windowed.speakers, event.from, t))
    } else windowed

    val priority = dropPriority(event.ch.toInt(), event.flags.toInt())?.toLong()
    // 受け取った位置を記録する。ack はタイマーでまとめて返す（congestion.md 2 節）。
    val marked = markReceived(withSpeech, event)
    val targets = mutableListOf<Long>()
    val dropped = mutableMapOf<Long, Long>()
    val nextSubs = mutableListOf<Subscription>()
    // 参照連鎖が切れた購読が 1 つでもあれば、送信者へキーフレームを 1 度だけ要求する
    // （規範 1.4）。購読ごとに出すと同じ要求が並ぶ。要求は段ごとに 1 件で足りる。
    var wantsKeyframe = false

    for (sub in marked.subscriptions) {
        if (sub.targetId != event.from || sub.channel != event.ch) {
            nextSubs.add(sub); continue
        }
        val d = decideForSubscription(marked, sub, event, priority, t)
        nextSubs.add(d.subscription)
        if (d.requestKeyframe) wantsKeyframe = true
        if (d.forward) { targets.add(sub.subscriberId) }
        else if (d.dropPriority != null) { dropped[d.dropPriority] = (dropped[d.dropPriority] ?: 0L) + 1L }
    }

    targets.sort()
    val commands = mutableListOf<ShardCommand>()
    // 破棄は優先順位の昇順でまとめて 1 件ずつ報告する。
    for (key in dropped.keys.sorted()) {
        val count = dropped[key]
        if (count != null && count > 0L) commands.add(ShardCommand.Drop(key, count))
    }
    // 破棄の報告の後に置く（順序を固定しないとトレースの完全一致が壊れる）。
    if (wantsKeyframe) {
        commands.add(ShardCommand.KeyframeRequest(event.from, event.ch, event.sid))
    }

    if (targets.isEmpty()) {
        return ShardStepResult(marked.copy(subscriptions = nextSubs), commands)
    }
    commands.add(ShardCommand.Forward(targets.toList()))

    val accounted = marked.copy(
        subscriptions = nextSubs,
        sentMessagesInWindow = marked.sentMessagesInWindow + targets.size.toLong(),
        sentBytesInWindow = marked.sentBytesInWindow + targets.size.toLong() * event.bytes,
    )
    val overload = notifyNodeOverload(accounted, t)
    return ShardStepResult(overload.state, commands + overload.commands)
}

private data class SubscriptionDecision(
    val subscription: Subscription,
    val forward: Boolean,
    val dropPriority: Long?,
    /**
     * 送信者へキーフレームを要求するか（規範 1.4）。
     * 順位 4・5 を落としたときだけ真になる。順位 1〜3 のみで対処できる場合は要求しない。
     */
    val requestKeyframe: Boolean,
)

private fun decideForSubscription(
    state: ShardState, sub: Subscription, event: ShardEvent.Media, priority: Long?, t: Long,
): SubscriptionDecision {
    if (sub.stalled) {
        // 音声は接続が停止していても通す（音声は破棄禁止）。
        // stalled は「ACK_TIMEOUT_MS の間 ack が届かない」状態であり、接続が切れたと判断した
        // ものである。しかし音声を落とすと、復帰しても stalled が解除されない限り音声が
        // 届かない。映像は stalled の間落としてよい（接続が切れた相手へ映像を送り続けると
        // ノードの予算を食う）。音声だけは通すことで、接続が復帰したときに音声が即座に戻る。
        if (isAudioChannel(event.ch)) return forwardDecision(state, sub, event)
        return SubscriptionDecision(sub, false, null, false)
    }

    // 音声の選別転送（ADR-0024、ADR-0029 の 2）。
    // 本数は購読者ごとに決める。帯域が細い購読者へ多数の音声を送ると映像の余地が無くなる。
    if (isAudioChannel(event.ch) && !isAudioForwarded(state, sub, event.from, t)) {
        // 輻輳による破棄ではないため priority は 0 とする（ADR-0024 の 5）。
        return SubscriptionDecision(sub, false, 0L, false)
    }

    if (!isAudioChannel(event.ch)) {
        val chosen = chooseRung(state, sub)
        if (event.sid != chosen) return SubscriptionDecision(sub, false, null, false)
        if (event.tid > sub.maxTemporalId) return SubscriptionDecision(sub, false, null, false)
    }

    val mustForward = priority == null
    val isKey = (event.flags and FLAG_KEY.toLong()) != 0L

    // 参照連鎖が切れている間は、次の KEY まで落とし続ける（規範 1.4）。
    // 順位 4・5 を 1 件落とした後に後続を渡すと、復号器は参照の無いフレームを受け取り
    // 出力を止める。落とし続ければ復号器は「キーフレーム待ち」に入り、要求で復帰する。
    if (!isAudioChannel(event.ch) && sub.awaitingKeySid == event.sid) {
        if (!isKey) {
            // 落とす。要求は最初の 1 回で送っているため繰り返さない。
            return SubscriptionDecision(sub, false, priority, false)
        }
        // KEY が来た。参照連鎖が回復するため、待ちを解いて渡す。
        return forwardDecision(state, sub.copy(awaitingKeySid = -1L), event)
    }

    if (!mustForward && shouldDropInCongestion(sub, event, priority)) {
        return dropWithChain(sub, event, priority)
    }
    if (!mustForward && isWindowClosed(state, sub, event)) {
        return dropWithChain(sub, event, priority)
    }

    return forwardDecision(state, sub, event)
}

/**
 * 破棄する。順位 4・5 なら次の KEY までの連続破棄を始め、キーフレームを要求する（規範 1.4）。
 * 順位 1〜3（破棄可能なユニット）では連鎖を始めず、要求も作らない。
 */
private fun dropWithChain(sub: Subscription, event: ShardEvent.Media, priority: Long?): SubscriptionDecision {
    val breaksChain = priority == 4L || priority == 5L
    if (!breaksChain) {
        return SubscriptionDecision(sub, false, priority, false)
    }
    return SubscriptionDecision(
        sub.copy(awaitingKeySid = event.sid),
        false,
        priority,
        true,
    )
}

/** 転送する。段が変わっていれば窓を作り直す。 */
private fun forwardDecision(state: ShardState, sub: Subscription, event: ShardEvent.Media): SubscriptionDecision {
    val chosen = if (isAudioChannel(event.ch)) 0L else chooseRung(state, sub)
    if (chosen != sub.windowSid) {
        // 渡す段が変わった。seq 空間が変わるため窓を作り直す。
        val updated = sub.copy(windowSid = chosen, highestSent = event.seq, highestAcked = event.seq - 1L)
        return SubscriptionDecision(updated, true, null, false)
    }
    val highestSent = if (event.seq > sub.highestSent) event.seq else sub.highestSent
    return SubscriptionDecision(sub.copy(highestSent = highestSent), true, null, false)
}

private fun chooseRung(state: ShardState, sub: Subscription): Long {
    val wanted = sub.maxSpatialId - sub.tierPenalty
    val effective = if (wanted < 0L) 0L else wanted
    val ladder = findLadder(state, sub.targetId, sub.channel)
    if (ladder == null || ladder.rungs.isEmpty()) return effective
    var best = -1L
    var lowest = -1L
    for (rung in ladder.rungs) {
        if (lowest < 0L || rung.sid < lowest) lowest = rung.sid
        if (rung.sid <= effective && rung.sid > best) best = rung.sid
    }
    return if (best >= 0L) best else if (lowest < 0L) effective else lowest
}

private fun isWindowClosed(state: ShardState, sub: Subscription, event: ShardEvent.Media): Boolean {
    val framerate = framerateOf(state, sub)
    if (framerate <= 0L) return false
    // 窓がまだこの連番の空間に無いときは評価しない（ADR-0038）。
    val chosen = if (isAudioChannel(event.ch)) 0L else chooseRung(state, sub)
    if (chosen != sub.windowSid) return false
    val inFlight = inFlightFrames(sub, event.seq)
    return inFlight * 1000L > SEND_WINDOW_MS * framerate
}

private fun inFlightFrames(sub: Subscription, seq: Long): Long {
    val highest = if (seq > sub.highestSent) seq else sub.highestSent
    val inFlight = highest - sub.highestAcked - 1L
    return if (inFlight < 0L) 0L else inFlight
}

private fun framerateOf(state: ShardState, sub: Subscription): Long {
    val ladder = findLadder(state, sub.targetId, sub.channel)
    if (ladder == null || !ladder.announced) return 0L
    val chosen = chooseRung(state, sub)
    for (rung in ladder.rungs) { if (rung.sid == chosen) return rung.framerate }
    return 0L
}

private fun shouldDropInCongestion(sub: Subscription, event: ShardEvent.Media, priority: Long?): Boolean {
    if (priority == null) return false
    return when (sub.congestion) {
        Congestion.NORMAL -> false
        Congestion.SHEDDING_T2 -> priority <= 3L
        Congestion.SHEDDING_T1 -> event.tid >= 1L
        Congestion.SHEDDING_SPATIAL -> event.tid >= 1L
        Congestion.KEY_ONLY -> true
    }
}

private fun isAudioForwarded(state: ShardState, sub: Subscription, senderId: Long, t: Long): Boolean {
    val limit = audioLimitFor(sub)
    val active = state.speakers.filter { t - it.lastSpeechAtMs <= AUDIO_SPEAKER_HOLD_MS }
    if (active.size.toLong() <= limit) return true
    val ordered = active.sortedWith(compareByDescending<SpeakerActivity> { it.lastSpeechAtMs }.thenBy { it.senderId })
    return ordered.take(limit.toInt()).any { it.senderId == senderId }
}

/**
 * この購読者へ同時に転送する音声の本数（ADR-0029 の 2）。
 * 輻輳の段が深いほど減らす。1 本は必ず残す。
 */
private fun audioLimitFor(sub: Subscription): Long {
    val reduced = AUDIO_SELECTIVE_FORWARD_COUNT - congestionDepth(sub.congestion)
    return if (reduced < AUDIO_SELECTIVE_MIN_COUNT) AUDIO_SELECTIVE_MIN_COUNT else reduced
}

/** 輻輳の深さ。NORMAL が 0 で、段が深くなるほど大きい。 */
private fun congestionDepth(state: Congestion): Long = when (state) {
    Congestion.NORMAL -> 0L
    Congestion.SHEDDING_T2 -> 1L
    Congestion.SHEDDING_T1 -> 2L
    Congestion.SHEDDING_SPATIAL -> 3L
    Congestion.KEY_ONLY -> 4L
}

private fun recordSpeech(speakers: List<SpeakerActivity>, senderId: Long, t: Long): List<SpeakerActivity> {
    val updated = mutableListOf<SpeakerActivity>()
    var replaced = false
    for (entry in speakers) {
        if (entry.senderId == senderId) { updated.add(SpeakerActivity(senderId, t)); replaced = true; continue }
        updated.add(entry)
    }
    if (!replaced) { updated.add(SpeakerActivity(senderId, t)); updated.sortBy { it.senderId } }
    return updated
}

private fun handleSubscribe(state: ShardState, event: ShardEvent.Subscribe, t: Long): ShardStepResult {
    val rest = state.subscriptions.filter {
        !(it.subscriberId == event.from && it.targetId == event.to && it.channel == event.ch)
    }
    if (!event.want) return withEncoderTiers(state.copy(subscriptions = rest.sortedWith(subscriptionOrder)))
    val existing = state.subscriptions.find {
        it.subscriberId == event.from && it.targetId == event.to && it.channel == event.ch
    }
    val created = Subscription(
        subscriberId = event.from, targetId = event.to, channel = event.ch,
        maxSpatialId = event.maxSpatialId, maxTemporalId = event.maxTemporalId,
        windowSid = existing?.windowSid ?: -1L, highestSent = existing?.highestSent ?: 0L,
        highestAcked = existing?.highestAcked ?: 0L, lastAckAtMs = t, stalled = false,
        congestion = existing?.congestion ?: Congestion.NORMAL,
        congestionEnteredAt = existing?.congestionEnteredAt ?: t,
        tierPenalty = existing?.tierPenalty ?: 0L,
        awaitingKeySid = existing?.awaitingKeySid ?: -1L,
    )
    return withEncoderTiers(state.copy(subscriptions = (rest + created).sortedWith(subscriptionOrder)))
}

private fun withEncoderTiers(state: ShardState): ShardStepResult {
    val targets = mutableListOf<Long>()
    for (sub in state.subscriptions) { if (!targets.contains(sub.targetId)) targets.add(sub.targetId) }
    targets.sort()
    val nextTiers = mutableListOf<EncoderTier>()
    val commands = mutableListOf<ShardCommand>()
    for (targetId in targets) {
        var tier = 0L
        for (sub in state.subscriptions) { if (sub.targetId == targetId && sub.maxSpatialId > tier) tier = sub.maxSpatialId }
        nextTiers.add(EncoderTier(targetId, tier))
        val previous = state.encoderTiers.find { it.targetId == targetId }
        if (previous == null || previous.tier != tier) commands.add(ShardCommand.SetTier(targetId, tier))
    }
    return ShardStepResult(state.copy(encoderTiers = nextTiers), commands)
}

private val subscriptionOrder: Comparator<Subscription> =
    compareBy<Subscription> { it.subscriberId }.thenBy { it.targetId }.thenBy { it.channel }

private fun handleAck(state: ShardState, event: ShardEvent.Ack, t: Long): ShardStepResult {
    val target = state.subscriptions.find {
        it.subscriberId == event.from && it.targetId == event.to && it.channel == event.ch
    }
    if (target == null) return ignoreEvent(state, "ack")
    if (event.sid != target.windowSid) return ignoreEvent(state, "ack")
    val highestAcked = if (event.highestSeq > target.highestAcked) event.highestSeq else target.highestAcked
    val updated = target.copy(highestAcked = highestAcked, lastAckAtMs = t, stalled = false)
    val subs = (state.subscriptions.filter { it !== target } + updated).sortedWith(subscriptionOrder)
    return evaluateAll(state.copy(subscriptions = subs), t)
}

private fun handleStreamAnnounce(state: ShardState, event: ShardEvent.StreamAnnounce, t: Long): ShardStepResult {
    val rungs = event.rungs.sortedBy { it.sid }
    val rest = state.ladders.filter { !(it.from == event.from && it.ch == event.ch) }
    val ladder = Ladder(from = event.from, ch = event.ch, rungs = rungs, announced = true)
    return evaluateAll(state.copy(ladders = (rest + ladder).sortedWith(ladderOrder)), t)
}

private fun observeLadder(state: ShardState, event: ShardEvent.Media): ShardState {
    if (isAudioChannel(event.ch)) return state
    val existing = findLadder(state, event.from, event.ch)
    if (existing != null) {
        if (existing.announced || existing.rungs.any { it.sid == event.sid }) return state
        val rungs = (existing.rungs + observedRung(event.sid)).sortedBy { it.sid }
        val rest = state.ladders.filter { !(it.from == event.from && it.ch == event.ch) }
        return state.copy(ladders = (rest + existing.copy(rungs = rungs)).sortedWith(ladderOrder))
    }
    val created = Ladder(event.from, event.ch, listOf(observedRung(event.sid)), false)
    return state.copy(ladders = (state.ladders + created).sortedWith(ladderOrder))
}

private fun observedRung(sid: Long): LadderRung = LadderRung(sid, 0L, 0L, 0L, 0L, 0L)

private fun findLadder(state: ShardState, from: Long, ch: Long): Ladder? =
    state.ladders.find { it.from == from && it.ch == ch }

private val ladderOrder: Comparator<Ladder> = compareBy<Ladder> { it.from }.thenBy { it.ch }

private fun handleJoin(state: ShardState, id: Long): ShardStepResult {
    if (state.participants.contains(id)) return ShardStepResult(state, emptyList())
    return ShardStepResult(state.copy(participants = (state.participants + id).sorted()), emptyList())
}

private fun handleLeave(state: ShardState, id: Long): ShardStepResult {
    return withEncoderTiers(state.copy(
        participants = state.participants.filter { it != id },
        subscriptions = state.subscriptions.filter { it.subscriberId != id && it.targetId != id },
        trends = state.trends.filter { it.subscriberId != id },
        ladders = state.ladders.filter { it.from != id },
        speakers = state.speakers.filter { it.senderId != id },
        encoderTiers = state.encoderTiers.filter { it.targetId != id },
        received = state.received.filter { it.from != id },
    ))
}

private fun handleTimer(state: ShardState, t: Long): ShardStepResult {
    val windowed = maybeResetWindow(state, t)
    val stalled = detectAckTimeout(windowed, t)
    val evaluated = evaluateAll(stalled.state, t)
    // 上流（送信ノード）へ受信位置を返す。返さないと送信ノードの窓が開かない。
    val acks = evaluated.state.received.map {
        ShardCommand.AckUpstream(it.from, it.ch, it.sid, it.highestSeq)
    }
    return ShardStepResult(evaluated.state, stalled.commands + evaluated.commands + acks)
}

/** 受け取った位置を更新する。後戻りする値では更新しない。順序は from, ch, sid の昇順。 */
private fun markReceived(state: ShardState, event: ShardEvent.Media): ShardState {
    if (event.seq <= 0L) return state
    val existing = state.received.firstOrNull {
        it.from == event.from && it.ch == event.ch && it.sid == event.sid
    }
    if (existing != null && existing.highestSeq >= event.seq) return state
    val rest = state.received.filter {
        !(it.from == event.from && it.ch == event.ch && it.sid == event.sid)
    }
    val merged = (rest + ShardReceivedMark(event.from, event.ch, event.sid, event.seq))
        .sortedWith(compareBy({ it.from }, { it.ch }, { it.sid }))
    return state.copy(received = merged)
}

private fun detectAckTimeout(state: ShardState, t: Long): ShardStepResult {
    val commands = mutableListOf<ShardCommand>()
    val subs = mutableListOf<Subscription>()
    for (sub in state.subscriptions) {
        val outstanding = sub.highestSent > sub.highestAcked
        if (!sub.stalled && !outstanding) {
            // 未確認が無い間は時計を進める（ADR-0041）。
            // 「無通信」と「無応答」を区別するため、未確認の媒体が無い購読は
            // lastAckAtMs を現在時刻で更新する。
            subs.add(sub.copy(lastAckAtMs = t))
            continue
        }
        if (sub.stalled || t - sub.lastAckAtMs < ACK_TIMEOUT_MS) { subs.add(sub); continue }
        subs.add(sub.copy(stalled = true))
        commands.add(ShardCommand.Disconnect(sub.subscriberId))
    }
    return ShardStepResult(state.copy(subscriptions = subs), commands)
}

private fun handleBudget(state: ShardState, event: ShardEvent.Budget, t: Long): ShardStepResult =
    evaluateAll(state.copy(budgetBytesPerSec = event.bytesPerSec), t)

private fun handleReport(state: ShardState, event: ShardEvent.Report, t: Long): ShardStepResult {
    val slope = delaySlope(event.delayUs)
    val rest = state.trends.filter { it.subscriberId != event.from }
    val updated = ReceiverTrend(event.from, slope.numerator, slope.denominator)
    return evaluateAll(state.copy(trends = (rest + updated).sortedBy { it.subscriberId }), t)
}

private fun evaluateAll(state: ShardState, t: Long): ShardStepResult {
    val commands = mutableListOf<ShardCommand>()
    val subs = mutableListOf<Subscription>()
    for (sub in state.subscriptions) {
        val r = evaluateSubscription(state, sub, t)
        subs.add(r.first); commands.addAll(r.second)
    }
    return ShardStepResult(state.copy(subscriptions = subs), commands)
}

private fun evaluateSubscription(state: ShardState, sub: Subscription, t: Long): Pair<Subscription, List<ShardCommand>> {
    if (t - sub.congestionEnteredAt < SHEDDING_HYSTERESIS_MS) return Pair(sub, emptyList())
    var next = sub.congestion
    when (sub.congestion) {
        Congestion.NORMAL -> {
            if (fillGreater(state, sub, SHARD_UTIL_ENTER_T2_NUM, SHARD_UTIL_ENTER_T2_DEN) ||
                trendGreater(state, sub, SHARD_TREND_ENTER_T2_NUM, SHARD_TREND_ENTER_T2_DEN)) next = Congestion.SHEDDING_T2
        }
        Congestion.SHEDDING_T2 -> {
            if (fillGreater(state, sub, SHARD_UTIL_ENTER_T1_NUM, SHARD_UTIL_ENTER_T1_DEN) ||
                trendGreater(state, sub, SHARD_TREND_ENTER_T1_NUM, SHARD_TREND_ENTER_T1_DEN)) next = Congestion.SHEDDING_T1
            else if (fillLess(state, sub, SHARD_UTIL_EXIT_T2_NUM, SHARD_UTIL_EXIT_T2_DEN) &&
                trendLess(state, sub, SHARD_TREND_EXIT_NUM, SHARD_TREND_EXIT_DEN)) next = Congestion.NORMAL
        }
        Congestion.SHEDDING_T1 -> {
            if (fillGreater(state, sub, SHARD_UTIL_ENTER_SPATIAL_NUM, SHARD_UTIL_ENTER_SPATIAL_DEN) ||
                trendGreater(state, sub, SHARD_TREND_ENTER_SPATIAL_NUM, SHARD_TREND_ENTER_SPATIAL_DEN)) next = Congestion.SHEDDING_SPATIAL
            else if (fillLess(state, sub, SHARD_UTIL_EXIT_T1_NUM, SHARD_UTIL_EXIT_T1_DEN) &&
                trendLess(state, sub, SHARD_TREND_EXIT_NUM, SHARD_TREND_EXIT_DEN)) next = Congestion.SHEDDING_T2
        }
        Congestion.SHEDDING_SPATIAL -> {
            if (fillGreater(state, sub, SHARD_UTIL_ENTER_KEY_ONLY_NUM, SHARD_UTIL_ENTER_KEY_ONLY_DEN) ||
                trendGreater(state, sub, SHARD_TREND_ENTER_KEY_ONLY_NUM, SHARD_TREND_ENTER_KEY_ONLY_DEN)) next = Congestion.KEY_ONLY
            else if (fillLess(state, sub, SHARD_UTIL_EXIT_SPATIAL_NUM, SHARD_UTIL_EXIT_SPATIAL_DEN) &&
                trendLess(state, sub, SHARD_TREND_EXIT_NUM, SHARD_TREND_EXIT_DEN)) next = Congestion.SHEDDING_T1
        }
        Congestion.KEY_ONLY -> {
            if (fillLess(state, sub, SHARD_UTIL_EXIT_KEY_ONLY_NUM, SHARD_UTIL_EXIT_KEY_ONLY_DEN) &&
                trendLess(state, sub, SHARD_TREND_EXIT_KEY_ONLY_NUM, SHARD_TREND_EXIT_KEY_ONLY_DEN)) next = Congestion.SHEDDING_SPATIAL
        }
    }
    if (next == sub.congestion) return Pair(sub, emptyList())
    val penalty = if (next == Congestion.SHEDDING_SPATIAL || next == Congestion.KEY_ONLY) 1L else 0L
    val updated = sub.copy(congestion = next, congestionEnteredAt = t, tierPenalty = penalty)
    val commands = mutableListOf<ShardCommand>()
    if (penalty != sub.tierPenalty) {
        // 購読者へ setTier を送ってはならない（ADR-0033）。段の変化は媒体の spatialId で伝わる。
        commands.add(ShardCommand.KeyframeRequest(sub.targetId, sub.channel, chooseRung(state, updated)))
    }
    return Pair(updated, commands)
}

private fun fillGreater(state: ShardState, sub: Subscription, num: Long, den: Long): Boolean {
    val framerate = framerateOf(state, sub)
    if (framerate <= 0L) return false
    val inFlight = inFlightFrames(sub, sub.highestSent)
    return inFlight * 1000L * den > num * SEND_WINDOW_MS * framerate
}

private fun fillLess(state: ShardState, sub: Subscription, num: Long, den: Long): Boolean {
    val framerate = framerateOf(state, sub)
    if (framerate <= 0L) return num > 0L
    val inFlight = inFlightFrames(sub, sub.highestSent)
    return inFlight * 1000L * den < num * SEND_WINDOW_MS * framerate
}

private fun trendGreater(state: ShardState, sub: Subscription, num: Long, den: Long): Boolean {
    val trend = state.trends.find { it.subscriberId == sub.subscriberId } ?: return false
    return trend.numerator * den > num * trend.denominator
}

private fun trendLess(state: ShardState, sub: Subscription, num: Long, den: Long): Boolean {
    val trend = state.trends.find { it.subscriberId == sub.subscriberId } ?: return true
    return trend.numerator * den < num * trend.denominator
}

private fun notifyNodeOverload(state: ShardState, t: Long): ShardStepResult {
    if (state.overloadNotified) return ShardStepResult(state, emptyList())
    val elapsed = t - state.windowStartMs
    if (elapsed <= 0L) return ShardStepResult(state, emptyList())
    val messagesOver = state.sentMessagesInWindow * 1000L > NODE_MAX_OUT_MESSAGES_PER_SEC * elapsed
    val bytesOver = state.sentBytesInWindow * 1000L > state.budgetBytesPerSec * elapsed
    if (!messagesOver && !bytesOver) return ShardStepResult(state, emptyList())
    return ShardStepResult(state.copy(overloadNotified = true), listOf(ShardCommand.Notify(Errors.E_NODE_OVERLOADED_CLOSE_CODE)))
}

private fun maybeResetWindow(state: ShardState, t: Long): ShardState {
    if (t - state.windowStartMs >= SHARD_UTIL_WINDOW_MS) {
        return state.copy(sentBytesInWindow = 0L, sentMessagesInWindow = 0L, windowStartMs = t, overloadNotified = false)
    }
    return state
}

/**
 * 表に無いイベントの記録に 1 件加える。上限を超えたら古い側を捨てる（ADR-0034）。
 * 上限が無いと記録が無制限に伸び、Durable Object の記憶（128 MB。F-006）を食う。
 */
private fun appendUnexpected(events: List<String>, name: String): List<String> {
    val appended = events + name
    val limit = MAX_UNEXPECTED_EVENTS.toInt()
    return if (appended.size > limit) appended.subList(appended.size - limit, appended.size) else appended
}
