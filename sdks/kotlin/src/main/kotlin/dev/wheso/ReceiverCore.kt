// 受信ノード（receiver）の判断コア（Kotlin）。
//
// 規範: state-machines.md 2 節（購読と tier）、congestion.md 4.3（tier の選択）。
// TypeScript の参照実装（packages/core/src/receiver-core.ts）と**同一の出力**を返さなければ
// ならない。照合は凍結トレース（spec/vectors/trace-receiver.jsonl）で行う。
// 相違した場合はベクタではなく実装を直す（ADR-0012）。
//
// sans-IO。時刻・乱数・浮動小数点・入出力に触れない。除算は整数の切り捨てのみを使う。
package dev.wheso

import dev.wheso.generated.DISPLAY_SIZE_UNSPECIFIED_SPATIAL_ID
import dev.wheso.generated.SHARD_TREND_ENTER_T2_DEN
import dev.wheso.generated.SHARD_TREND_ENTER_T2_NUM
import dev.wheso.generated.SHARD_TREND_EXIT_DEN
import dev.wheso.generated.SHARD_TREND_EXIT_NUM
import dev.wheso.generated.V_360P15_SPATIAL_ID
import dev.wheso.generated.V_360P15_TARGET_BITRATE
import dev.wheso.generated.V_4K60_SPATIAL_ID
import dev.wheso.generated.V_4K60_TARGET_BITRATE

/** 品質低下の警告。文言は利用側が国際化キーから作る（sdk-api.md 6 節）。 */
private const val DEGRADED_WARNING: String = "W_DEGRADED"

/** 受信者自身の識別子。転送先は常にこの 1 人である。 */
public const val RECEIVER_SELF_ID: Long = 0L

/** (senderId, channel) ごとの購読状態（state-machines.md 2 節）。 */
public enum class StreamPhase { UNSUBSCRIBED, SUBSCRIBED, PAUSED }

/** 1 本のストリームの状態。 */
public data class StreamState(
    val senderId: Long,
    val channel: Long,
    val phase: StreamPhase,
    /** 現在要求している最大 spatialId。 */
    val spatialId: Long,
    /** 現在要求している最大 temporalId。 */
    val temporalId: Long,
    /** 利用側が申告した表示寸法（論理画素）。未申告は 0。 */
    val displayWidth: Long,
)

/** 受信済みの位置。ack の内容になる。 */
public data class ReceivedMark(
    val senderId: Long,
    val channel: Long,
    val spatialId: Long,
    val highestSeq: Long,
)

public data class ReceiverState(
    /** senderId, channel の昇順で保持する。反復順序が判断に影響するため決定的にする。 */
    val streams: List<StreamState>,
    val visible: Boolean,
    val targetBytesPerSec: Long,
    val activeSpeakerId: Long?,
    val trend: Slope,
    val degraded: Boolean,
    val unexpectedEvents: List<String>,
    /** senderId, channel, spatialId の昇順で保持する。 */
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

    public data class ActiveSpeaker(val id: Long?) : ReceiverEvent

    public data class DisplaySize(val senderId: Long, val channel: Long, val width: Long) : ReceiverEvent

    public data class Report(val delayUs: List<Long>) : ReceiverEvent

    public data class Media(
        val from: Long,
        val ch: Long,
        val sid: Long,
        val tid: Long,
        /** 受信した sequenceNumber。ack の算出に使う。既定は 0（不明）。 */
        val seq: Long,
    ) : ReceiverEvent

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

    public data class KeyframeRequest(val targetId: Long, val channel: Long, val spatialId: Long) :
        ReceiverCommand

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

public fun initialReceiverState(targetBytesPerSec: Long): ReceiverState = ReceiverState(
    streams = emptyList(),
    visible = true,
    targetBytesPerSec = targetBytesPerSec,
    activeSpeakerId = null,
    trend = Slope(0L, 1L),
    degraded = false,
    unexpectedEvents = emptyList(),
    received = emptyList(),
)

/** 純関数の状態遷移。 */
public fun receiverStep(state: ReceiverState, event: ReceiverEvent): ReceiverStepResult = when (event) {
    is ReceiverEvent.SubscribeList -> handleSubscribeList(state, event.entries)
    is ReceiverEvent.Leave -> handleLeave(state, event.id)
    is ReceiverEvent.Visibility -> handleVisibility(state, event.visible)
    is ReceiverEvent.Budget -> reallocate(state.copy(targetBytesPerSec = event.bytesPerSec))
    is ReceiverEvent.ActiveSpeaker -> reallocate(state.copy(activeSpeakerId = event.id))
    is ReceiverEvent.DisplaySize -> handleDisplaySize(state, event.senderId, event.channel, event.width)
    is ReceiverEvent.Report -> handleReport(state, event.delayUs)
    is ReceiverEvent.Media -> handleMedia(state, event)
    // ACK_INTERVAL_MS ごとに、受信済みの位置を ack として返す。
    // 呼び出し側が周期を管理する（コアは時刻を持たない）。
    is ReceiverEvent.Timer -> ReceiverStepResult(
        state,
        state.received.map { ReceiverCommand.Ack(it.senderId, it.channel, it.spatialId, it.highestSeq) },
    )
}

private val streamOrder = compareBy<StreamState>({ it.senderId }, { it.channel })
private val entryOrder = compareBy<SubscribeEntry>({ it.senderId }, { it.channel })

private fun findStream(state: ReceiverState, senderId: Long, channel: Long): StreamState? =
    state.streams.firstOrNull { it.senderId == senderId && it.channel == channel }

/** spatialId の範囲は最低品質から最高品質までである。 */
private fun clampSpatial(value: Long): Long {
    if (value < V_360P15_SPATIAL_ID) {
        return V_360P15_SPATIAL_ID
    }
    if (value > V_4K60_SPATIAL_ID) {
        return V_4K60_SPATIAL_ID
    }
    return value
}

/** 購読一覧の適用。表 1 行目と 2 行目に対応する。 */
private fun handleSubscribeList(
    state: ReceiverState,
    entries: List<SubscribeEntry>,
): ReceiverStepResult {
    val commands = mutableListOf<ReceiverCommand>()
    val kept = mutableListOf<StreamState>()

    for (entry in entries.sortedWith(entryOrder)) {
        val existing = findStream(state, entry.senderId, entry.channel)
        if (existing == null || existing.phase == StreamPhase.UNSUBSCRIBED) {
            commands.add(
                ReceiverCommand.SubscribeChange(
                    to = entry.senderId,
                    channel = entry.channel,
                    want = true,
                    maxSpatialId = entry.maxSpatialId,
                    maxTemporalId = entry.maxTemporalId,
                ),
            )
            commands.add(
                ReceiverCommand.KeyframeRequest(entry.senderId, entry.channel, entry.maxSpatialId),
            )
            kept.add(
                StreamState(
                    senderId = entry.senderId,
                    channel = entry.channel,
                    phase = StreamPhase.SUBSCRIBED,
                    spatialId = entry.maxSpatialId,
                    temporalId = entry.maxTemporalId,
                    displayWidth = existing?.displayWidth ?: 0L,
                ),
            )
            continue
        }
        kept.add(existing.copy(phase = StreamPhase.SUBSCRIBED))
    }

    // 一覧から外れたものは購読解除する（表 2 行目）。
    for (stream in state.streams) {
        val stillWanted = entries.any { it.senderId == stream.senderId && it.channel == stream.channel }
        if (!stillWanted && stream.phase != StreamPhase.UNSUBSCRIBED) {
            commands.add(
                ReceiverCommand.SubscribeChange(stream.senderId, stream.channel, false, 0L, 0L),
            )
        }
    }

    val after = reallocate(state.copy(streams = kept.sortedWith(streamOrder)))
    return ReceiverStepResult(after.state, commands + after.commands)
}

/** 送信者の退出。表 6 行目に対応する。 */
private fun handleLeave(state: ReceiverState, id: Long): ReceiverStepResult {
    val streams = state.streams.filterNot { it.senderId == id }
    if (streams.size == state.streams.size) {
        return ReceiverStepResult(state, emptyList())
    }
    // 退出者の受信位置も除去する。残すと居ない相手へ ack を返し続ける。
    val received = state.received.filterNot { it.senderId == id }
    return reallocate(state.copy(streams = streams, received = received))
}

/** 表示・非表示。表 7 行目と 8 行目に対応する。 */
private fun handleVisibility(state: ReceiverState, visible: Boolean): ReceiverStepResult {
    if (visible == state.visible) {
        return ReceiverStepResult(state, emptyList())
    }
    val commands = mutableListOf<ReceiverCommand>()
    val streams = mutableListOf<StreamState>()
    for (stream in state.streams) {
        if (!visible && stream.phase == StreamPhase.SUBSCRIBED) {
            // 非表示では購読を解除するが、状態は保持する（PAUSED）。
            commands.add(ReceiverCommand.SubscribeChange(stream.senderId, stream.channel, false, 0L, 0L))
            streams.add(stream.copy(phase = StreamPhase.PAUSED))
            continue
        }
        if (visible && stream.phase == StreamPhase.PAUSED) {
            commands.add(
                ReceiverCommand.SubscribeChange(
                    stream.senderId,
                    stream.channel,
                    true,
                    stream.spatialId,
                    stream.temporalId,
                ),
            )
            commands.add(
                ReceiverCommand.KeyframeRequest(stream.senderId, stream.channel, stream.spatialId),
            )
            streams.add(stream.copy(phase = StreamPhase.SUBSCRIBED))
            continue
        }
        streams.add(stream)
    }
    return ReceiverStepResult(state.copy(visible = visible, streams = streams), commands)
}

/** 表示寸法の申告。未申告の相手は最低品質に留める（ADR-0015）。 */
private fun handleDisplaySize(
    state: ReceiverState,
    senderId: Long,
    channel: Long,
    width: Long,
): ReceiverStepResult {
    if (findStream(state, senderId, channel) == null) {
        return ReceiverStepResult(
            state.copy(unexpectedEvents = state.unexpectedEvents + "displaySize"),
            emptyList(),
        )
    }
    val streams = state.streams.map {
        if (it.senderId == senderId && it.channel == channel) it.copy(displayWidth = width) else it
    }
    return reallocate(state.copy(streams = streams))
}

/** 測定報告。勾配が劣化閾値を超えたら tier を 1 段下げ、回復閾値を下回ったら 1 段上げる。 */
private fun handleReport(state: ReceiverState, delayUs: List<Long>): ReceiverStepResult {
    val trend = delaySlope(delayUs)
    val degrading = trend.numerator * SHARD_TREND_ENTER_T2_DEN >
        SHARD_TREND_ENTER_T2_NUM * trend.denominator
    val recovering = trend.numerator * SHARD_TREND_EXIT_DEN < SHARD_TREND_EXIT_NUM * trend.denominator
    if (!degrading && !recovering) {
        return ReceiverStepResult(state.copy(trend = trend), emptyList())
    }
    val delta = if (degrading) -1L else 1L
    val commands = mutableListOf<ReceiverCommand>()
    val streams = mutableListOf<StreamState>()
    for (stream in state.streams) {
        if (stream.phase != StreamPhase.SUBSCRIBED) {
            streams.add(stream)
            continue
        }
        val nextSpatial = clampSpatial(stream.spatialId + delta)
        if (nextSpatial == stream.spatialId) {
            streams.add(stream)
            continue
        }
        streams.add(stream.copy(spatialId = nextSpatial))
        commands.add(ReceiverCommand.SetTier(stream.senderId, stream.channel, nextSpatial))
        // spatialId が変わる場合のみキーフレームを要求する（表 4 行目と 3 行目の違い）。
        if (nextSpatial > stream.spatialId) {
            commands.add(ReceiverCommand.KeyframeRequest(stream.senderId, stream.channel, nextSpatial))
        }
    }
    return ReceiverStepResult(state.copy(trend = trend, streams = streams), commands)
}

/** メディアの転送。要求 tier を超えるユニットは転送しない。 */
private fun handleMedia(state: ReceiverState, event: ReceiverEvent.Media): ReceiverStepResult {
    val stream = findStream(state, event.from, event.ch)
    if (stream == null || stream.phase != StreamPhase.SUBSCRIBED) {
        return ReceiverStepResult(state, emptyList())
    }
    if (event.sid > stream.spatialId || event.tid > stream.temporalId) {
        return ReceiverStepResult(state, listOf(ReceiverCommand.Drop(1L, 1L)))
    }
    // 受信した位置を記録する。ack はタイマーでまとめて返す（congestion.md 2 節）。
    return ReceiverStepResult(
        markReceived(state, event),
        listOf(ReceiverCommand.Forward(listOf(RECEIVER_SELF_ID))),
    )
}

/** 受信した位置を更新する。後戻りする値では更新しない。 */
private fun markReceived(state: ReceiverState, event: ReceiverEvent.Media): ReceiverState {
    if (event.seq <= 0L) {
        return state
    }
    val existing = state.received.firstOrNull {
        it.senderId == event.from && it.channel == event.ch && it.spatialId == event.sid
    }
    if (existing != null && existing.highestSeq >= event.seq) {
        return state
    }
    val merged = (
        state.received.filterNot {
            it.senderId == event.from && it.channel == event.ch && it.spatialId == event.sid
        } + ReceivedMark(event.from, event.ch, event.sid, event.seq)
        ).sortedWith(compareBy({ it.senderId }, { it.channel }, { it.spatialId }))
    return state.copy(received = merged)
}

/** 発話者を先に、次に senderId の昇順で並べる。順序は決定的でなければならない。 */
private fun priorityRank(state: ReceiverState, stream: StreamState): Triple<Int, Long, Long> {
    val speaker = if (state.activeSpeakerId == stream.senderId) 0 else 1
    return Triple(speaker, stream.senderId, stream.channel)
}

/**
 * 帯域予算から tier を配分する（congestion.md 4.3）。
 * 除算は整数で行い、切り捨てる。浮動小数点を使わない（ADR-0017）。
 */
private fun reallocate(state: ReceiverState): ReceiverStepResult {
    val commands = mutableListOf<ReceiverCommand>()
    val budgetOutcome = truncDiv(state.targetBytesPerSec * 8L * 9L, 10L)
    val budgetBps = when (budgetOutcome) {
        is Outcome.Ok -> budgetOutcome.value
        is Outcome.Err -> 0L
    }
    val highOutcome = truncDiv(budgetBps, V_4K60_TARGET_BITRATE)
    val highQualityCount = when (highOutcome) {
        is Outcome.Ok -> highOutcome.value
        is Outcome.Err -> 0L
    }
    val thumbnailCost = V_360P15_TARGET_BITRATE

    val ordered = state.streams
        .filter { it.phase == StreamPhase.SUBSCRIBED }
        .sortedWith(
            compareBy(
                { priorityRank(state, it).first },
                { priorityRank(state, it).second },
                { priorityRank(state, it).third },
            ),
        )

    val streams = mutableListOf<StreamState>()
    var assignedHigh = 0L
    var remaining = budgetBps
    var degraded = false

    for (stream in state.streams) {
        if (stream.phase != StreamPhase.SUBSCRIBED) {
            streams.add(stream)
            continue
        }
        val rank = ordered.indexOfFirst {
            it.senderId == stream.senderId && it.channel == stream.channel
        }.toLong()
        val nextSpatial: Long
        if (stream.displayWidth == 0L) {
            // 表示寸法の申告が無い相手は最低品質に留める（ADR-0015）。
            nextSpatial = DISPLAY_SIZE_UNSPECIFIED_SPATIAL_ID
        } else if (assignedHigh < highQualityCount && rank < highQualityCount) {
            nextSpatial = V_4K60_SPATIAL_ID
            assignedHigh += 1L
            remaining -= V_4K60_TARGET_BITRATE
        } else if (remaining >= thumbnailCost) {
            nextSpatial = V_360P15_SPATIAL_ID
            remaining -= thumbnailCost
        } else {
            // 予算が尽きた。発話者のサムネイルのみを維持する（最低保証）。
            nextSpatial = V_360P15_SPATIAL_ID
            degraded = true
        }
        if (nextSpatial != stream.spatialId) {
            commands.add(ReceiverCommand.SetTier(stream.senderId, stream.channel, nextSpatial))
            if (nextSpatial > stream.spatialId) {
                // spatialId が上がる場合はエンコーダ出力が切り替わるためキーフレームが必要である。
                commands.add(
                    ReceiverCommand.KeyframeRequest(stream.senderId, stream.channel, nextSpatial),
                )
            }
        }
        streams.add(stream.copy(spatialId = nextSpatial))
    }

    if (degraded && !state.degraded) {
        // 最低保証（発話者のサムネイル 1 本と全員の音声）を下回った。利用側へ警告する。
        commands.add(ReceiverCommand.Notify(DEGRADED_WARNING))
    }

    return ReceiverStepResult(
        state.copy(streams = streams.sortedWith(streamOrder), degraded = degraded),
        commands,
    )
}
