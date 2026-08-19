// 受信ノード（receiver）の判断コア（Kotlin）。
//
// 規範: state-machines.md 2 節（購読と tier）、congestion.md 4.1〜4.3、ADR-0027〜0029。
// TypeScript の参照実装（packages/core/src/receiver-core.ts）と**同一の出力**を返さなければ
// ならない。照合は凍結トレース（spec/vectors/trace-receiver.jsonl）で行う。
// 相違した場合はベクタではなく実装を直す（ADR-0012）。
//
// sans-IO。時刻・乱数・浮動小数点・入出力に触れない。除算は整数の切り捨てのみを使う。
package dev.wheso

import dev.wheso.generated.MAX_UNEXPECTED_EVENTS
import dev.wheso.generated.AUDIO_ONLY_ENTER_BPS
import dev.wheso.generated.AUDIO_ONLY_EXIT_BPS
import dev.wheso.generated.CHANNEL_AUDIO
import dev.wheso.generated.CHANNEL_SCREEN_AUDIO
import dev.wheso.generated.MIN_VIABLE_BPS
import dev.wheso.generated.RATE_HOLD_MS
import dev.wheso.generated.RATE_PROBE_BPS
import dev.wheso.generated.RATE_RECOVER_STREAK
import dev.wheso.generated.SHARD_TREND_ENTER_T2_DEN
import dev.wheso.generated.SHARD_TREND_ENTER_T2_NUM
import dev.wheso.generated.SHARD_TREND_EXIT_DEN
import dev.wheso.generated.SHARD_TREND_EXIT_NUM

/** 品質低下の警告。文言は利用側が国際化キーから作る（sdk-api.md 6 節）。 */
private const val DEGRADED_WARNING: String = "W_DEGRADED"

/** 受信者自身の識別子。転送先は常にこの 1 人である。 */
public const val RECEIVER_SELF_ID: Long = 0L

/** (senderId, channel) ごとの購読状態（state-machines.md 2 節）。 */
public enum class StreamPhase { UNSUBSCRIBED, SUBSCRIBED, PAUSED, AUDIO_ONLY }

/** 1 本のストリームの状態。 */
public data class StreamState(
    val senderId: Long,
    val channel: Long,
    val phase: StreamPhase,
    val spatialId: Long,
    val temporalId: Long,
    val displayWidth: Long,
)

/** カタログの 1 段。streamCatalog から取り込む（ADR-0027 の 1）。 */
public data class CatalogRung(
    val sid: Long,
    val width: Long,
    val height: Long,
    val framerate: Long,
    val temporalLayers: Long,
    val targetBitrate: Long,
)

/** 送信者 1 人・1 チャネルのはしご。 */
public data class CatalogLadder(
    val senderId: Long,
    val channel: Long,
    val rungs: List<CatalogRung>,
)

/** 受信済みの位置。ack の内容になる。 */
public data class ReceivedMark(
    val senderId: Long,
    val channel: Long,
    val spatialId: Long,
    val highestSeq: Long,
)

public data class ReceiverState(
    val streams: List<StreamState>,
    val catalog: List<CatalogLadder>,
    val visible: Boolean,
    val targetBytesPerSec: Long,
    val activeSpeakerId: Long?,
    val trend: Slope,
    val degraded: Boolean,
    val audioOnly: Boolean,
    val rateHoldUntilMs: Long,
    val recoverStreak: Long,
    val targetCeilingBytesPerSec: Long,
    val unexpectedEvents: List<String>,
    val received: List<ReceivedMark>,
)

public data class SubscribeEntry(
    val senderId: Long,
    val channel: Long,
    val maxSpatialId: Long,
    val maxTemporalId: Long,
)

/** 入力イベント。 */
public sealed interface ReceiverEvent {
    public data class SubscribeList(val entries: List<SubscribeEntry>) : ReceiverEvent
    public data class Leave(val id: Long) : ReceiverEvent
    public data class Visibility(val visible: Boolean) : ReceiverEvent
    public data class Budget(val bytesPerSec: Long) : ReceiverEvent

    /** 観測した goodput。**目標を下げない**（congestion.md 4.1）。 */
    public data class Goodput(val bytesPerSec: Long) : ReceiverEvent
    public data class ActiveSpeaker(val id: Long?) : ReceiverEvent
    public data class Catalog(val entries: List<CatalogLadder>) : ReceiverEvent
    public data class DisplaySize(val senderId: Long, val channel: Long, val width: Long) : ReceiverEvent
    public data class Report(val delayUs: List<Long>) : ReceiverEvent
    public data class Media(
        val from: Long,
        val ch: Long,
        val sid: Long,
        val tid: Long,
        val seq: Long,
    ) : ReceiverEvent

    /// 購読者からのキーフレーム要求（ADR-0039）。状態は変えない。
    public data class KeyframeRequest(val senderId: Long, val channel: Long, val spatialId: Long) : ReceiverEvent

    public object Timer : ReceiverEvent
}

/** 出力コマンド。 */
public sealed interface ReceiverCommand {
    public data class SubscribeChange(
        val to: Long,
        val channel: Long,
        val want: Boolean,
        val maxSpatialId: Long,
        val maxTemporalId: Long,
    ) : ReceiverCommand
    public data class KeyframeRequest(val targetId: Long, val channel: Long, val spatialId: Long) : ReceiverCommand
    public data class SetTier(val targetId: Long, val channel: Long, val tier: Long) : ReceiverCommand
    public data class Forward(val to: List<Long>) : ReceiverCommand
    public data class Drop(val priority: Long, val count: Long) : ReceiverCommand
    public data class Notify(val code: String) : ReceiverCommand
    public data class Ack(
        val senderId: Long,
        val channel: Long,
        val spatialId: Long,
        val highestSeq: Long,
    ) : ReceiverCommand
}

public data class ReceiverStepResult(val state: ReceiverState, val commands: List<ReceiverCommand>)

/**
 * 初期状態。目標は最低から始める。引数を取らない理由は呼び出し側に委ねると
 * 無関係な値を渡す誤りが起きるためである。
 */
public fun initialReceiverState(): ReceiverState {
    val floorResult = truncDiv(MIN_VIABLE_BPS, 8L)
    val floor = if (floorResult is Outcome.Ok) floorResult.value else 0L
    return ReceiverState(
        streams = emptyList(),
        catalog = emptyList(),
        visible = true,
        targetBytesPerSec = floor,
        activeSpeakerId = null,
        trend = Slope(0L, 1L),
        degraded = false,
        audioOnly = false,
        rateHoldUntilMs = 0L,
        recoverStreak = 0L,
        targetCeilingBytesPerSec = floor,
        unexpectedEvents = emptyList(),
        received = emptyList(),
    )
}

/** 純関数の状態遷移。時刻は AIMD の待ち（RATE_HOLD_MS）に使う。 */
public fun receiverStep(state: ReceiverState, event: ReceiverEvent, t: Long = 0L): ReceiverStepResult = when (event) {
    is ReceiverEvent.SubscribeList -> handleSubscribeList(state, event.entries)
    is ReceiverEvent.Leave -> handleLeave(state, event.id)
    is ReceiverEvent.Visibility -> handleVisibility(state, event.visible)
    is ReceiverEvent.Budget -> handleBudget(state, event.bytesPerSec)
    is ReceiverEvent.Goodput -> handleGoodput(state, event.bytesPerSec)
    is ReceiverEvent.ActiveSpeaker -> reallocate(state.copy(activeSpeakerId = event.id))
    is ReceiverEvent.Catalog -> handleCatalog(state, event.entries)
    is ReceiverEvent.DisplaySize -> handleDisplaySize(state, event.senderId, event.channel, event.width)
    is ReceiverEvent.Report -> handleReport(state, event.delayUs, t)
    is ReceiverEvent.Media -> handleMedia(state, event)
    is ReceiverEvent.KeyframeRequest -> ReceiverStepResult(
        state,
        listOf(ReceiverCommand.KeyframeRequest(event.senderId, event.channel, event.spatialId)),
    )
    is ReceiverEvent.Timer -> ReceiverStepResult(
        state,
        state.received.map { ReceiverCommand.Ack(it.senderId, it.channel, it.spatialId, it.highestSeq) },
    )
}

// --- 内部ユーティリティ ---

private val streamOrder = compareBy<StreamState>({ it.senderId }, { it.channel })
private val entryOrder = compareBy<SubscribeEntry>({ it.senderId }, { it.channel })

private fun findStream(state: ReceiverState, senderId: Long, channel: Long): StreamState? =
    state.streams.firstOrNull { it.senderId == senderId && it.channel == channel }

private fun isAudio(channel: Long): Boolean =
    channel == CHANNEL_AUDIO.toLong() || channel == CHANNEL_SCREEN_AUDIO.toLong()

private fun ladderOf(state: ReceiverState, senderId: Long, channel: Long): List<CatalogRung> {
    val entry = state.catalog.firstOrNull { it.senderId == senderId && it.channel == channel }
    return entry?.rungs ?: emptyList()
}

/** 表示寸法から要求すべき段の上限を返す。表示幅以上の幅を持つ最小の段。 */
private fun rungCapFor(state: ReceiverState, stream: StreamState): Long {
    val rungs = ladderOf(state, stream.senderId, stream.channel)
    if (rungs.isEmpty()) return 0L
    var lowest = rungs[0]
    var top = rungs[0]
    for (rung in rungs) {
        if (rung.sid < lowest.sid) lowest = rung
        if (rung.sid > top.sid) top = rung
    }
    if (stream.displayWidth <= 0L) return lowest.sid
    var best: CatalogRung? = null
    for (rung in rungs) {
        if (rung.width < stream.displayWidth) continue
        val current = best
        if (current == null || rung.width < current.width) best = rung
    }
    return if (best == null) top.sid else best.sid
}

/** 段の費用（bits/sec）。申告が無ければ 0。 */
private fun costOf(state: ReceiverState, stream: StreamState, sid: Long): Long {
    for (rung in ladderOf(state, stream.senderId, stream.channel)) {
        if (rung.sid == sid) return rung.targetBitrate
    }
    return 0L
}

/** はしごの最下段。カタログが無ければ 0。 */
private fun lowestRung(state: ReceiverState, stream: StreamState): Long {
    val rungs = ladderOf(state, stream.senderId, stream.channel)
    var lowest = -1L
    for (rung in rungs) {
        if (lowest < 0L || rung.sid < lowest) lowest = rung.sid
    }
    return if (lowest < 0L) 0L else lowest
}

/** はしごの最上段。カタログが無ければ 0。 */
private fun highestRung(state: ReceiverState, stream: StreamState): Long {
    val rungs = ladderOf(state, stream.senderId, stream.channel)
    var top = -1L
    for (rung in rungs) {
        if (rung.sid > top) top = rung.sid
    }
    return if (top < 0L) 0L else top
}

private fun streamKey(stream: StreamState): String = "${stream.senderId}:${stream.channel}"

// --- handleBudget ---

/** goodput の観測。天井を押し上げるだけに使う（congestion.md 4.1）。 */
/** 観測した goodput。天井を押し上げ、目標を上げる方向にだけ使う（congestion.md 4.1）。 */
private fun handleGoodput(state: ReceiverState, bytesPerSec: Long): ReceiverStepResult {
    if (bytesPerSec <= 0L) return ReceiverStepResult(state, emptyList())
    val ceiling = if (bytesPerSec > state.targetCeilingBytesPerSec) bytesPerSec else state.targetCeilingBytesPerSec
    // 規範 4.1: available = max(goodput, 現在の目標レート)。**天井で切らない。**
    // 中継ノードは目標の分しか転送しないため goodput は常に目標以下に留まる。
    // 天井で切ると目標は最低成立点から一生上がらない。
    val target = if (bytesPerSec > state.targetBytesPerSec) bytesPerSec else state.targetBytesPerSec
    if (target == state.targetBytesPerSec && ceiling == state.targetCeilingBytesPerSec) {
        return ReceiverStepResult(state, emptyList())
    }
    return reallocate(state.copy(targetBytesPerSec = target, targetCeilingBytesPerSec = ceiling))
}

private fun handleBudget(state: ReceiverState, bytesPerSec: Long): ReceiverStepResult {
    val ceiling = if (bytesPerSec > state.targetCeilingBytesPerSec) bytesPerSec else state.targetCeilingBytesPerSec
    return reallocate(state.copy(targetBytesPerSec = bytesPerSec, targetCeilingBytesPerSec = ceiling))
}

// --- handleCatalog ---

private fun handleCatalog(state: ReceiverState, entries: List<CatalogLadder>): ReceiverStepResult {
    val normalized = entries
        .map { CatalogLadder(it.senderId, it.channel, it.rungs.sortedBy { r -> r.sid }) }
        .sortedWith(compareBy({ it.senderId }, { it.channel }))
    return reallocate(state.copy(catalog = normalized))
}

// --- handleSubscribeList ---

private fun handleSubscribeList(state: ReceiverState, entries: List<SubscribeEntry>): ReceiverStepResult {
    val commands = mutableListOf<ReceiverCommand>()
    val kept = mutableListOf<StreamState>()

    for (entry in entries.sortedWith(entryOrder)) {
        val existing = findStream(state, entry.senderId, entry.channel)
        if (existing == null || existing.phase == StreamPhase.UNSUBSCRIBED) {
            // 新規購読は最下段から始める（congestion.md 6 節、ADR-0028）。
            val dummy = StreamState(entry.senderId, entry.channel, StreamPhase.SUBSCRIBED, 0L, 0L, 0L)
            val start = if (isAudio(entry.channel)) 0L else lowestRung(state, dummy)
            commands.add(ReceiverCommand.SubscribeChange(entry.senderId, entry.channel, true, start, entry.maxTemporalId))
            commands.add(ReceiverCommand.KeyframeRequest(entry.senderId, entry.channel, start))
            kept.add(StreamState(
                senderId = entry.senderId,
                channel = entry.channel,
                phase = StreamPhase.SUBSCRIBED,
                spatialId = start,
                temporalId = entry.maxTemporalId,
                displayWidth = existing?.displayWidth ?: 0L,
            ))
            continue
        }
        kept.add(existing.copy(phase = StreamPhase.SUBSCRIBED))
    }

    for (stream in state.streams) {
        val stillWanted = entries.any { it.senderId == stream.senderId && it.channel == stream.channel }
        if (!stillWanted && stream.phase != StreamPhase.UNSUBSCRIBED) {
            commands.add(ReceiverCommand.SubscribeChange(stream.senderId, stream.channel, false, 0L, 0L))
        }
    }

    val after = reallocate(state.copy(streams = kept.sortedWith(streamOrder)))
    return ReceiverStepResult(after.state, commands + after.commands)
}

// --- handleLeave ---

private fun handleLeave(state: ReceiverState, id: Long): ReceiverStepResult {
    val streams = state.streams.filterNot { it.senderId == id }
    if (streams.size == state.streams.size) return ReceiverStepResult(state, emptyList())
    // 退出者の受信位置とはしごも除去する。残すと居ない相手へ ack を返し続ける。
    val received = state.received.filterNot { it.senderId == id }
    val catalog = state.catalog.filterNot { it.senderId == id }
    return reallocate(state.copy(streams = streams, received = received, catalog = catalog))
}

// --- handleVisibility ---

private fun handleVisibility(state: ReceiverState, visible: Boolean): ReceiverStepResult {
    if (visible == state.visible) return ReceiverStepResult(state, emptyList())
    val commands = mutableListOf<ReceiverCommand>()
    val streams = mutableListOf<StreamState>()
    for (stream in state.streams) {
        if (!visible && stream.phase == StreamPhase.SUBSCRIBED) {
            commands.add(ReceiverCommand.SubscribeChange(stream.senderId, stream.channel, false, 0L, 0L))
            streams.add(stream.copy(phase = StreamPhase.PAUSED))
            continue
        }
        if (visible && stream.phase == StreamPhase.PAUSED) {
            commands.add(ReceiverCommand.SubscribeChange(stream.senderId, stream.channel, true, stream.spatialId, stream.temporalId))
            commands.add(ReceiverCommand.KeyframeRequest(stream.senderId, stream.channel, stream.spatialId))
            streams.add(stream.copy(phase = StreamPhase.SUBSCRIBED))
            continue
        }
        streams.add(stream)
    }
    return ReceiverStepResult(state.copy(visible = visible, streams = streams), commands)
}

// --- handleDisplaySize ---

private fun handleDisplaySize(state: ReceiverState, senderId: Long, channel: Long, width: Long): ReceiverStepResult {
    if (findStream(state, senderId, channel) == null) {
        return ReceiverStepResult(
            state.copy(unexpectedEvents = appendUnexpected(state.unexpectedEvents, "displaySize")),
            emptyList(),
        )
    }
    val streams = state.streams.map {
        if (it.senderId == senderId && it.channel == channel) it.copy(displayWidth = width) else it
    }
    return reallocate(state.copy(streams = streams))
}

/**
 * SUBSCRIBED なストリームが**望む段**の申告ビットレートの合計を bytes/sec で返す。
 *
 * AIMD の回復上限に使う。goodput の観測最大値（targetCeilingBytesPerSec）を上限に
 * すると、中継ノードが目標の分しか転送しないため goodput は目標を超えず、
 * target ≤ goodput ≤ target の輪が閉じて目標が最低成立点から一生上がらない。
 * 実測（実環境・劣化なし）で中継ノードが基底層 417 件を含む 842 件を捨て、
 * 送信 1,342 件に対し到着 577 件だった。
 */
private fun desiredCostBytesPerSec(state: ReceiverState): Long {
    var bits = 0L
    for (stream in state.streams) {
        if (stream.phase != StreamPhase.SUBSCRIBED) continue
        if (isAudio(stream.channel)) {
            bits += costOf(state, stream, stream.spatialId)
            continue
        }
        bits += costOf(state, stream, rungCapFor(state, stream))
    }
    val bytes = truncDiv(bits, 8L)
    return if (bytes is Outcome.Ok) bytes.value else 0L
}

// --- handleReport ---

/**
 * いまの目標が音声だけの状態の境界を跨いでいるか（ADR-0029 のヒステリシス）。
 *
 * 跨いでいる場合だけ配分をやり直す。判定は reallocate と同じ式でなければならないため、
 * 回線の速度（目標 × 8）で見る。予算（9/10）で見ると余裕を二重に引くことになる。
 */
private fun crossesAudioOnly(state: ReceiverState): Boolean {
    val linkBps = state.targetBytesPerSec * 8L
    val wanted = if (state.audioOnly) linkBps < AUDIO_ONLY_EXIT_BPS else linkBps < AUDIO_ONLY_ENTER_BPS
    return wanted != state.audioOnly
}

private fun handleReport(state: ReceiverState, delayUs: List<Long>, t: Long): ReceiverStepResult {
    // 標本が 2 個未満では勾配が定まらない。定まらない値で AIMD を動かしてはならない。
    if (delayUs.size < 2) return ReceiverStepResult(state, emptyList())
    val trend = delaySlope(delayUs)
    val degrading = trend.numerator * SHARD_TREND_ENTER_T2_DEN > SHARD_TREND_ENTER_T2_NUM * trend.denominator
    val recovering = trend.numerator * SHARD_TREND_EXIT_DEN < SHARD_TREND_EXIT_NUM * trend.denominator

    var target = state.targetBytesPerSec
    var holdUntil = state.rateHoldUntilMs
    var streak = state.recoverStreak
    if (degrading) {
        streak = 0L
        if (t >= state.rateHoldUntilMs) {
            val reduced = truncDiv(target * 17L, 20L)
            val lowered = if (reduced is Outcome.Ok) reduced.value else target
            // 予兆で最低成立点を割らない（ADR-0040）
            val floorResult = truncDiv(MIN_VIABLE_BPS, 8L)
            val floor = if (floorResult is Outcome.Ok) floorResult.value else 0L
            target = if (lowered < floor) floor else lowered
            holdUntil = t + RATE_HOLD_MS
        }
    } else if (recovering) {
        streak = state.recoverStreak + 1L
        if (streak >= RATE_RECOVER_STREAK) {
            val increment = truncDiv(RATE_PROBE_BPS, 8L)
            val raised = target + (if (increment is Outcome.Ok) increment.value else 0L)
            // 上限は望む品質の申告ビットレート（規範 4.2）。観測した goodput を
            // 上限にすると輪が閉じて目標が上がらない。申告が無い間は上限を作らない。
            val declared = desiredCostBytesPerSec(state)
            // 上限が最低成立点を下回ってはならない（ADR-0040）。最下段の申告は
            // MIN_VIABLE_BPS より小さいため、申告だけで切ると目標が最低成立点の下へ
            // 押し戻され、AUDIO_ONLY の出入りを往復する（実測で振動した）。
            val floorForCap = truncDiv(MIN_VIABLE_BPS, 8L)
            val minimum = if (floorForCap is Outcome.Ok) floorForCap.value else 0L
            val cap = if (declared > 0L && declared < minimum) minimum else declared
            target = if (cap > 0L && raised > cap) cap else raised
            streak = 0L
        }
    } else {
        streak = 0L
    }

    val afterRate = state.copy(
        trend = trend,
        targetBytesPerSec = target,
        rateHoldUntilMs = holdUntil,
        recoverStreak = streak,
    )

    if (!degrading && !recovering) {
        return ReceiverStepResult(afterRate, emptyList())
    }

    // --- 状態機械（state-machines.md 3 節）。tier を 1 段動かす ---
    val delta = if (degrading) -1L else 1L
    val commands = mutableListOf<ReceiverCommand>()
    val streams = mutableListOf<StreamState>()
    for (stream in afterRate.streams) {
        if (stream.phase != StreamPhase.SUBSCRIBED || isAudio(stream.channel)) {
            streams.add(stream)
            continue
        }
        val floor = lowestRung(afterRate, stream)
        val cap = rungCapFor(afterRate, stream)
        val raw = stream.spatialId + delta
        val nextSpatial = when {
            raw < floor -> floor
            raw > cap -> cap
            else -> raw
        }
        if (nextSpatial == stream.spatialId) {
            streams.add(stream)
            continue
        }
        streams.add(stream.copy(spatialId = nextSpatial))
        commands.add(ReceiverCommand.SetTier(stream.senderId, stream.channel, nextSpatial))
        // 段が変わるとエンコーダの別ストリームへ切り替わるためキーフレームが必要である（ADR-0027 の 4）。
        commands.add(ReceiverCommand.KeyframeRequest(stream.senderId, stream.channel, nextSpatial))
    }
    val stepped = afterRate.copy(streams = streams)

    // 目標が変わっていなければ、そのまま返す。
    if (target == state.targetBytesPerSec) {
        return ReceiverStepResult(stepped, commands)
    }
    // 音声だけの状態の出入りだけをやり直す（規範 4.3、ADR-0029）。
    //
    // なぜ配分の全部をやり直さないか: reallocate は「買える最良の段」を選ぶため、
    // 予算が潤沢な回線では遅延勾配による降格を直後に打ち消してしまう（実測:
    // 降格の試験で段が 2 から 1 へ下がらなくなった）。
    //
    // なぜ音声だけの出入りはやり直すか: その判断は reallocate にしか無い。報告の経路で
    // 呼ばなければ、回復の勾配がいくら続いても映像が戻らない（実測: 目標が 29,620 →
    // 154,620 bytes/s まで回復しても audioOnly が true のまま）。
    if (!crossesAudioOnly(stepped)) {
        return ReceiverStepResult(stepped, commands)
    }
    val reallocated = reallocate(stepped)
    return ReceiverStepResult(reallocated.state, commands + reallocated.commands)
}

// --- handleMedia ---

private fun handleMedia(state: ReceiverState, event: ReceiverEvent.Media): ReceiverStepResult {
    val stream = findStream(state, event.from, event.ch)
    if (stream == null || stream.phase != StreamPhase.SUBSCRIBED) {
        // 音声は購読が未確立でも転送する（音声は破棄禁止）。
        // 音声と映像は別の部屋を通り、購読の確立も別である。音声の購読が遅れて確立する間に
        // 届いた音声がここで消えるのを防ぐ。映像は落として正しい（購読していない送信者の
        // 映像を復号器へ渡すと参照が壊れる）。音声は段を持たず参照連鎖の制約が無い。
        // ack 位置も記録する。ack 位置が記録されれば中継の送信窓が進み、stalled になりにくい。
        if (isAudio(event.ch)) {
            return ReceiverStepResult(
                markReceived(state, event),
                listOf(ReceiverCommand.Forward(listOf(RECEIVER_SELF_ID))),
            )
        }
        return ReceiverStepResult(state, emptyList())
    }
    if (event.sid > stream.spatialId || event.tid > stream.temporalId) {
        return ReceiverStepResult(state, listOf(ReceiverCommand.Drop(1L, 1L)))
    }
    return ReceiverStepResult(
        markReceived(state, event),
        listOf(ReceiverCommand.Forward(listOf(RECEIVER_SELF_ID))),
    )
}

private fun markReceived(state: ReceiverState, event: ReceiverEvent.Media): ReceiverState {
    if (event.seq <= 0L) return state
    val existing = state.received.firstOrNull {
        it.senderId == event.from && it.channel == event.ch && it.spatialId == event.sid
    }
    if (existing != null && existing.highestSeq >= event.seq) return state
    val merged = (
        state.received.filterNot {
            it.senderId == event.from && it.channel == event.ch && it.spatialId == event.sid
        } + ReceivedMark(event.from, event.ch, event.sid, event.seq)
        ).sortedWith(compareBy({ it.senderId }, { it.channel }, { it.spatialId }))
    return state.copy(received = merged)
}

// --- reallocate ---

/** 発話者を先に、音声を最優先に、次に senderId の昇順で並べる。 */
private fun priorityOrder(state: ReceiverState, a: StreamState, b: StreamState): Int {
    val aAudio = if (isAudio(a.channel)) 0 else 1
    val bAudio = if (isAudio(b.channel)) 0 else 1
    if (aAudio != bAudio) return aAudio - bAudio
    val aSpeaker = if (state.activeSpeakerId == a.senderId) 0 else 1
    val bSpeaker = if (state.activeSpeakerId == b.senderId) 0 else 1
    if (aSpeaker != bSpeaker) return aSpeaker - bSpeaker
    if (a.senderId != b.senderId) return a.senderId.compareTo(b.senderId)
    return a.channel.compareTo(b.channel)
}

/**
 * 帯域予算から段を配分する（congestion.md 4.3、ADR-0027、ADR-0029）。
 * linkBps = target*8 で AUDIO_ONLY の判定を行い、段を買う予算は linkBps*9/10。
 */
private fun reallocate(state: ReceiverState): ReceiverStepResult {
    val commands = mutableListOf<ReceiverCommand>()
    // 回線の速度（bits/sec）。AUDIO_ONLY の判定はこの値そのもので行う（10% を引く前）。
    val linkBps = state.targetBytesPerSec * 8L
    val budgetResult = truncDiv(linkBps * 9L, 10L)
    val budgetBps = if (budgetResult is Outcome.Ok) budgetResult.value else 0L

    // --- 音声だけの状態への出入り（ヒステリシス。ADR-0029 の 1） ---
    val audioOnly = if (state.audioOnly) {
        linkBps < AUDIO_ONLY_EXIT_BPS
    } else {
        linkBps < AUDIO_ONLY_ENTER_BPS
    }

    if (audioOnly) {
        val streams = mutableListOf<StreamState>()
        for (stream in state.streams) {
            if (isAudio(stream.channel)) {
                streams.add(stream)
                continue
            }
            if (stream.phase == StreamPhase.SUBSCRIBED) {
                commands.add(ReceiverCommand.SubscribeChange(stream.senderId, stream.channel, false, 0L, 0L))
                streams.add(stream.copy(phase = StreamPhase.AUDIO_ONLY))
                continue
            }
            streams.add(stream)
        }
        if (!state.degraded) {
            commands.add(ReceiverCommand.Notify(DEGRADED_WARNING))
        }
        return ReceiverStepResult(
            state.copy(streams = streams.sortedWith(streamOrder), audioOnly = true, degraded = true),
            commands,
        )
    }

    // --- 映像へ戻す（AUDIO_ONLY から復帰する） ---
    val revived = mutableListOf<StreamState>()
    for (stream in state.streams) {
        if (stream.phase == StreamPhase.AUDIO_ONLY) {
            val low = lowestRung(state, stream)
            revived.add(stream.copy(phase = StreamPhase.SUBSCRIBED, spatialId = low))
            commands.add(ReceiverCommand.SubscribeChange(stream.senderId, stream.channel, true, low, stream.temporalId))
            commands.add(ReceiverCommand.KeyframeRequest(stream.senderId, stream.channel, low))
            continue
        }
        revived.add(stream)
    }
    val base = state.copy(streams = revived, audioOnly = false)

    // --- 予算で段を買う ---
    val ordered = base.streams
        .filter { it.phase == StreamPhase.SUBSCRIBED }
        .sortedWith { a, b -> priorityOrder(base, a, b) }

    val assigned = mutableMapOf<String, Long>()
    var remaining = budgetBps
    var degraded = false

    for (stream in ordered) {
        if (isAudio(stream.channel)) {
            remaining -= costOf(base, stream, 0L)
            continue
        }
        val floor = lowestRung(base, stream)
        val cap = rungCapFor(base, stream)
        var chosen = floor
        var sid = cap
        while (sid >= floor) {
            val cost = costOf(base, stream, sid)
            if (cost <= remaining) {
                chosen = sid
                break
            }
            sid -= 1L
        }
        val chosenCost = costOf(base, stream, chosen)
        if (chosenCost > remaining) {
            degraded = true
        }
        remaining -= chosenCost
        assigned[streamKey(stream)] = chosen
    }

    val streams = mutableListOf<StreamState>()
    for (stream in base.streams) {
        val next = assigned[streamKey(stream)]
        if (next == null || next == stream.spatialId) {
            streams.add(stream)
            continue
        }
        commands.add(ReceiverCommand.SetTier(stream.senderId, stream.channel, next))
        commands.add(ReceiverCommand.KeyframeRequest(stream.senderId, stream.channel, next))
        streams.add(stream.copy(spatialId = next))
    }

    if (degraded && !base.degraded) {
        commands.add(ReceiverCommand.Notify(DEGRADED_WARNING))
    }

    return ReceiverStepResult(
        base.copy(streams = streams.sortedWith(streamOrder), degraded = degraded),
        commands,
    )
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
