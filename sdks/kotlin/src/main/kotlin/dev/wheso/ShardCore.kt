// 中継ノード（shard）の判断コア（Kotlin）。
//
// TypeScript の参照実装（packages/core/src/shard-core.ts）と**同じ入力列から同じ出力列**を
// 返さなければならない（conformance.md 2 節の層 2）。照合は凍結トレースで行う。
// 相違した場合はベクタではなく実装を直す（ADR-0012）。
//
// sans-IO。時刻は入力として受け取り、内部で取得しない。
// 浮動小数点を使わない。例外を投げない。反復順序は決定的にする。
package dev.wheso

import dev.wheso.generated.Errors
import dev.wheso.generated.NODE_MAX_OUT_BYTES_PER_SEC
import dev.wheso.generated.NODE_MAX_OUT_MESSAGES_PER_SEC
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

/** 輻輳状態（state-machines.md 3 節）。 */
public enum class Congestion(public val label: String) {
    NORMAL("NORMAL"),
    SHEDDING_T2("SHEDDING_T2"),
    SHEDDING_T1("SHEDDING_T1"),
    SHEDDING_SPATIAL("SHEDDING_SPATIAL"),
    KEY_ONLY("KEY_ONLY"),
}

/** 購読 1 件。 */
public data class Subscription(val subscriberId: Long, val targetId: Long, val maxSpatialId: Long)

/** 受信者ごとの遅延勾配。分子と分母の整数対で持つ（ADR-0017）。 */
public data class ReceiverTrend(val subscriberId: Long, val numerator: Long, val denominator: Long)

/** 送信者とチャネルごとの最大 spatialId。 */
public data class MaxSpatial(val from: Long, val ch: Long, val sid: Long)

/** 送信者 1 人に指令したエンコーダの上限層（ADR-0022）。 */
public data class EncoderTier(val targetId: Long, val tier: Long)

public data class ShardState(
    val congestion: Congestion,
    val congestionEnteredAt: Long,
    val participants: List<Long>,
    val subscriptions: List<Subscription>,
    val budgetBytesPerSec: Long,
    val sentBytesInWindow: Long,
    val sentMessagesInWindow: Long,
    val windowStartMs: Long,
    val unexpectedEvents: List<String>,
    val trends: List<ReceiverTrend>,
    val maxSpatial: List<MaxSpatial>,
    val encoderTiers: List<EncoderTier>,
)

/** 入力イベント。sealed で閉じる（判定漏れを防ぐ）。 */
public sealed interface ShardEvent {
    public data class Media(
        val from: Long,
        val ch: Long,
        val sid: Long,
        val tid: Long,
        val key: Boolean,
        val bytes: Long,
        val flags: Long,
    ) : ShardEvent

    public data class Subscribe(
        val from: Long,
        val to: Long,
        val want: Boolean,
        val maxSpatialId: Long,
    ) : ShardEvent

    public data class Join(val id: Long) : ShardEvent

    public data class Leave(val id: Long) : ShardEvent

    public data class Link(val peer: Long, val state: String) : ShardEvent

    public object Timer : ShardEvent

    public data class Budget(val bytesPerSec: Long) : ShardEvent

    public data class Report(val from: Long, val delayUs: List<Long>) : ShardEvent
}

/** 出力コマンド。 */
public sealed interface ShardCommand {
    public data class Forward(val to: List<Long>) : ShardCommand

    public data class Drop(val priority: Long, val count: Long) : ShardCommand

    public data class Notify(val code: Long) : ShardCommand

    public data class SetTier(val targetId: Long, val tier: Long) : ShardCommand
}

public data class ShardStepResult(val state: ShardState, val commands: List<ShardCommand>)

/** 初期状態。トレースの最初の時刻を渡す。 */
public fun initialShardState(t: Long): ShardState = ShardState(
    congestion = Congestion.NORMAL,
    congestionEnteredAt = t,
    participants = emptyList(),
    subscriptions = emptyList(),
    budgetBytesPerSec = NODE_MAX_OUT_BYTES_PER_SEC,
    sentBytesInWindow = 0L,
    sentMessagesInWindow = 0L,
    windowStartMs = t,
    unexpectedEvents = emptyList(),
    trends = emptyList(),
    maxSpatial = emptyList(),
    encoderTiers = emptyList(),
)

/** 1 ステップの状態遷移。 */
public fun shardStep(state: ShardState, event: ShardEvent, t: Long): ShardStepResult = when (event) {
    is ShardEvent.Media -> handleMedia(state, event, t)
    is ShardEvent.Subscribe -> handleSubscribe(state, event)
    is ShardEvent.Join -> handleJoin(state, event.id)
    is ShardEvent.Leave -> handleLeave(state, event.id)
    // 表に無いイベントは無視して記録する。
    is ShardEvent.Link -> ShardStepResult(
        state.copy(unexpectedEvents = state.unexpectedEvents + "link"),
        emptyList(),
    )
    is ShardEvent.Timer -> evaluateCongestion(maybeResetWindow(state, t), t)
    is ShardEvent.Budget -> evaluateCongestion(state.copy(budgetBytesPerSec = event.bytesPerSec), t)
    is ShardEvent.Report -> handleReport(state, event.from, event.delayUs, t)
}

/**
 * メディアの転送。
 *
 * 判定の順序を参照実装に揃える。順序を変えると出力が変わる。
 *   1. 窓の更新と観測した最大 spatialId の更新
 *   2. 輻輳状態による破棄
 *   3. 購読者の抽出（tier を満たす者のみ、昇順）
 *   4. 予算超過なら破棄可能なものを破棄
 *   5. 転送し、計数を進めてから輻輳を再評価する
 */
private fun handleMedia(state: ShardState, unit: ShardEvent.Media, t: Long): ShardStepResult {
    val windowed = maybeResetWindow(state, t)
    val next = updateMaxSpatial(windowed, unit.from, unit.ch, unit.sid)
    val priority = dropPriority(unit.ch.toInt(), unit.flags.toInt())?.toLong()

    if (shouldDropInCongestion(next, unit.sid, unit.tid, unit.from, unit.ch, priority)) {
        return ShardStepResult(next, listOf(ShardCommand.Drop(priority ?: 0L, 1L)))
    }

    val targets = next.subscriptions
        .filter { it.targetId == unit.from && unit.sid <= it.maxSpatialId }
        .map { it.subscriberId }
        .sorted()

    if (targets.isEmpty()) {
        return ShardStepResult(next, emptyList())
    }

    val msgCost = targets.size.toLong()
    val byteCost = msgCost * unit.bytes
    val projectedMessages = next.sentMessagesInWindow + msgCost
    val projectedBytes = next.sentBytesInWindow + byteCost

    if (isOverBudget(projectedMessages, projectedBytes, next, t) && priority != null) {
        return ShardStepResult(next, listOf(ShardCommand.Drop(priority, 1L)))
    }

    val afterForward = next.copy(
        sentBytesInWindow = next.sentBytesInWindow + byteCost,
        sentMessagesInWindow = next.sentMessagesInWindow + msgCost,
    )
    val evaluated = evaluateCongestion(afterForward, t)
    return ShardStepResult(
        evaluated.state,
        listOf<ShardCommand>(ShardCommand.Forward(targets)) + evaluated.commands,
    )
}

private fun handleSubscribe(state: ShardState, event: ShardEvent.Subscribe): ShardStepResult {
    val filtered = state.subscriptions.filterNot {
        it.subscriberId == event.from && it.targetId == event.to
    }
    val next = if (event.want) {
        (filtered + Subscription(event.from, event.to, event.maxSpatialId))
            .sortedWith(compareBy({ it.subscriberId }, { it.targetId }))
    } else {
        filtered
    }
    return withEncoderTiers(state.copy(subscriptions = next))
}

/**
 * 購読の和集合から送信者ごとの必要な上限層を求め、変化した送信者へ setTier を出す。
 * 出力の順序は targetId の昇順に固定する（conformance.md 4.4 の完全一致）。
 */
private fun withEncoderTiers(state: ShardState): ShardStepResult {
    val targets = state.subscriptions.map { it.targetId }.distinct().sorted()
    val nextTiers = mutableListOf<EncoderTier>()
    val commands = mutableListOf<ShardCommand>()
    for (targetId in targets) {
        var tier = 0L
        for (sub in state.subscriptions) {
            if (sub.targetId == targetId && sub.maxSpatialId > tier) {
                tier = sub.maxSpatialId
            }
        }
        nextTiers.add(EncoderTier(targetId, tier))
        val previous = state.encoderTiers.firstOrNull { it.targetId == targetId }
        // 購読者が居なくなった送信者には指令を出さない（記録のみ除去する）。
        if (previous == null || previous.tier != tier) {
            commands.add(ShardCommand.SetTier(targetId, tier))
        }
    }
    return ShardStepResult(state.copy(encoderTiers = nextTiers), commands)
}

private fun handleJoin(state: ShardState, id: Long): ShardStepResult {
    if (state.participants.contains(id)) {
        return ShardStepResult(state, emptyList())
    }
    return ShardStepResult(state.copy(participants = (state.participants + id).sorted()), emptyList())
}

private fun handleLeave(state: ShardState, id: Long): ShardStepResult {
    val next = state.copy(
        participants = state.participants.filterNot { it == id },
        subscriptions = state.subscriptions.filterNot { it.subscriberId == id || it.targetId == id },
        // 退出者の遅延勾配と観測した spatialId も除去する。
        // 残すと、居なくなった相手の古い観測が輻輳の判定に影響し続ける。
        trends = state.trends.filterNot { it.subscriberId == id },
        maxSpatial = state.maxSpatial.filterNot { it.from == id },
        // 退出者への指令の記録も除去する。残すと再参加時に指令が出ない。
        encoderTiers = state.encoderTiers.filterNot { it.targetId == id },
    )
    return withEncoderTiers(next)
}

private fun handleReport(state: ShardState, from: Long, delayUs: List<Long>, t: Long): ShardStepResult {
    val slope = delaySlope(delayUs)
    val trends = (state.trends.filterNot { it.subscriberId == from } +
        ReceiverTrend(from, slope.numerator, slope.denominator)).sortedBy { it.subscriberId }
    return evaluateCongestion(state.copy(trends = trends), t)
}

private fun maybeResetWindow(state: ShardState, t: Long): ShardState {
    if (t - state.windowStartMs >= SHARD_UTIL_WINDOW_MS) {
        return state.copy(sentBytesInWindow = 0L, sentMessagesInWindow = 0L, windowStartMs = t)
    }
    return state
}

private fun updateMaxSpatial(state: ShardState, from: Long, ch: Long, sid: Long): ShardState {
    val existing = state.maxSpatial.firstOrNull { it.from == from && it.ch == ch }
    if (existing != null && existing.sid >= sid) {
        return state
    }
    val merged = (state.maxSpatial.filterNot { it.from == from && it.ch == ch } + MaxSpatial(from, ch, sid))
        .sortedWith(compareBy({ it.from }, { it.ch }))
    return state.copy(maxSpatial = merged)
}

private fun maxSpatialFor(state: ShardState, from: Long, ch: Long): Long =
    state.maxSpatial.firstOrNull { it.from == from && it.ch == ch }?.sid ?: 0L

/**
 * 輻輳状態による破棄の判定。
 *
 * 破棄禁止（優先順位が無い = 音声とキーフレーム）は常に転送する。
 */
private fun shouldDropInCongestion(
    state: ShardState,
    sid: Long,
    tid: Long,
    from: Long,
    ch: Long,
    priority: Long?,
): Boolean {
    if (priority == null) {
        return false
    }
    return when (state.congestion) {
        Congestion.NORMAL -> false
        Congestion.SHEDDING_T2 -> priority <= 3L
        Congestion.SHEDDING_T1 -> tid >= 1L
        // (送信者, チャネル) ごとの最大 spatialId のみを破棄する。
        // 全層を破棄すると受信側の復号が完全に止まる。
        Congestion.SHEDDING_SPATIAL -> sid >= maxSpatialFor(state, from, ch) || tid >= 1L
        Congestion.KEY_ONLY -> true
    }
}

/** 窓内の予算を超えるか。時刻の差で正規化する（浮動小数点を使わない）。 */
private fun isOverBudget(
    projectedMessages: Long,
    projectedBytes: Long,
    state: ShardState,
    t: Long,
): Boolean {
    val window = t - state.windowStartMs
    if (window <= 0L) {
        return false
    }
    val messageOver = projectedMessages * 1000L > NODE_MAX_OUT_MESSAGES_PER_SEC * window
    val byteOver = projectedBytes * 1000L > state.budgetBytesPerSec * window
    return messageOver || byteOver
}

private fun utilGreater(state: ShardState, t: Long, num: Long, den: Long): Boolean {
    val window = t - state.windowStartMs
    if (window <= 0L) {
        return false
    }
    return state.sentMessagesInWindow * 1000L * den > num * window * NODE_MAX_OUT_MESSAGES_PER_SEC
}

private fun utilLess(state: ShardState, t: Long, num: Long, den: Long): Boolean {
    val window = t - state.windowStartMs
    if (window <= 0L) {
        // 窓が始まっていない場合は利用率 0 とみなす。閾値が正なら下回る。
        return num > 0L
    }
    return state.sentMessagesInWindow * 1000L * den < num * window * NODE_MAX_OUT_MESSAGES_PER_SEC
}

/** 1 人でも閾値を超えるか（劣化は OR で評価する）。 */
private fun trendGreater(state: ShardState, num: Long, den: Long): Boolean =
    state.trends.any { it.numerator * den > num * it.denominator }

/** 全員が閾値を下回るか（回復は AND で評価する）。記録が無い場合は真とする。 */
private fun trendLess(state: ShardState, num: Long, den: Long): Boolean =
    state.trends.all { it.numerator * den < num * it.denominator }

/** 輻輳状態の評価（state-machines.md 3 節）。ヒステリシスの間は遷移しない。 */
private fun evaluateCongestion(state: ShardState, t: Long): ShardStepResult {
    if (t - state.congestionEnteredAt < SHEDDING_HYSTERESIS_MS) {
        return ShardStepResult(state, emptyList())
    }
    val nextPhase = when (state.congestion) {
        Congestion.NORMAL ->
            if (utilGreater(state, t, SHARD_UTIL_ENTER_T2_NUM, SHARD_UTIL_ENTER_T2_DEN) ||
                trendGreater(state, SHARD_TREND_ENTER_T2_NUM, SHARD_TREND_ENTER_T2_DEN)
            ) {
                Congestion.SHEDDING_T2
            } else {
                Congestion.NORMAL
            }
        Congestion.SHEDDING_T2 ->
            if (utilGreater(state, t, SHARD_UTIL_ENTER_T1_NUM, SHARD_UTIL_ENTER_T1_DEN) ||
                trendGreater(state, SHARD_TREND_ENTER_T1_NUM, SHARD_TREND_ENTER_T1_DEN)
            ) {
                Congestion.SHEDDING_T1
            } else if (utilLess(state, t, SHARD_UTIL_EXIT_T2_NUM, SHARD_UTIL_EXIT_T2_DEN) &&
                trendLess(state, SHARD_TREND_EXIT_NUM, SHARD_TREND_EXIT_DEN)
            ) {
                Congestion.NORMAL
            } else {
                Congestion.SHEDDING_T2
            }
        Congestion.SHEDDING_T1 ->
            if (utilGreater(state, t, SHARD_UTIL_ENTER_SPATIAL_NUM, SHARD_UTIL_ENTER_SPATIAL_DEN) ||
                trendGreater(state, SHARD_TREND_ENTER_SPATIAL_NUM, SHARD_TREND_ENTER_SPATIAL_DEN)
            ) {
                Congestion.SHEDDING_SPATIAL
            } else if (utilLess(state, t, SHARD_UTIL_EXIT_T1_NUM, SHARD_UTIL_EXIT_T1_DEN) &&
                trendLess(state, SHARD_TREND_EXIT_NUM, SHARD_TREND_EXIT_DEN)
            ) {
                Congestion.SHEDDING_T2
            } else {
                Congestion.SHEDDING_T1
            }
        Congestion.SHEDDING_SPATIAL ->
            if (utilGreater(state, t, SHARD_UTIL_ENTER_KEY_ONLY_NUM, SHARD_UTIL_ENTER_KEY_ONLY_DEN) ||
                trendGreater(state, SHARD_TREND_ENTER_KEY_ONLY_NUM, SHARD_TREND_ENTER_KEY_ONLY_DEN)
            ) {
                Congestion.KEY_ONLY
            } else if (utilLess(state, t, SHARD_UTIL_EXIT_SPATIAL_NUM, SHARD_UTIL_EXIT_SPATIAL_DEN) &&
                trendLess(state, SHARD_TREND_EXIT_NUM, SHARD_TREND_EXIT_DEN)
            ) {
                Congestion.SHEDDING_T1
            } else {
                Congestion.SHEDDING_SPATIAL
            }
        Congestion.KEY_ONLY ->
            if (utilLess(state, t, SHARD_UTIL_EXIT_KEY_ONLY_NUM, SHARD_UTIL_EXIT_KEY_ONLY_DEN) &&
                trendLess(state, SHARD_TREND_EXIT_KEY_ONLY_NUM, SHARD_TREND_EXIT_KEY_ONLY_DEN)
            ) {
                Congestion.SHEDDING_SPATIAL
            } else {
                Congestion.KEY_ONLY
            }
    }
    if (nextPhase == state.congestion) {
        return ShardStepResult(state, emptyList())
    }
    val commands = mutableListOf<ShardCommand>()
    if (nextPhase == Congestion.KEY_ONLY) {
        // 過負荷を制御系へ知らせる。接続は閉じない。
        commands.add(ShardCommand.Notify(Errors.E_NODE_OVERLOADED_CLOSE_CODE))
    }
    return ShardStepResult(state.copy(congestion = nextPhase, congestionEnteredAt = t), commands)
}
