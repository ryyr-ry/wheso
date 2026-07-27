// ワイヤフォーマットの実装（Kotlin）。
//
// 規範: wire-format.md 1 節（バイト配置）と 1.4（破棄優先順位）。
// TypeScript の参照実装とバイト単位で一致しなければならない（conformance.md 2 節の層 1）。
//
// 例外を投げない。範囲外の添字アクセスをしない。
package dev.wheso

import dev.wheso.generated.CHANNEL_AUDIO
import dev.wheso.generated.CHANNEL_SCREEN_AUDIO
import dev.wheso.generated.FLAG_ACTIVE_SPEAKER
import dev.wheso.generated.FLAG_DISCARDABLE
import dev.wheso.generated.FLAG_KEY
import dev.wheso.generated.FLAG_SCREEN_CONTENT
import dev.wheso.generated.MAX_MESSAGE_BYTES
import dev.wheso.generated.MAX_UNITS_PER_MESSAGE
import dev.wheso.generated.MESSAGE_HEADER_BYTES
import dev.wheso.generated.PROTOCOL_VERSION
import dev.wheso.generated.UNIT_HEADER_BYTES
import dev.wheso.generated.WIRE_MAGIC

/** ワイヤ形式の失敗。規範のエラー名を持つ。 */
public enum class WireErrorKind(public val errorName: String) {
    MAGIC("E_WIRE_MAGIC"),
    VERSION("E_WIRE_VERSION"),
    CHANNEL("E_WIRE_CHANNEL"),
    UNIT_COUNT("E_WIRE_UNIT_COUNT"),
    SENDER_ID("E_WIRE_SENDER_ID"),
    LENGTH_MISMATCH("E_WIRE_LENGTH_MISMATCH"),
    PAYLOAD_EMPTY("E_WIRE_PAYLOAD_EMPTY"),
    TOO_LARGE("E_WIRE_TOO_LARGE"),
    UNIT_ORDER("E_WIRE_UNIT_ORDER"),
    FIELD_RANGE("E_WIRE_FIELD_RANGE"),
}

public sealed class WireOutcome<out T> {
    public data class Ok<out T>(val value: T) : WireOutcome<T>()
    public data class Err(val kind: WireErrorKind) : WireOutcome<Nothing>()

    public val isOk: Boolean get() = this is Ok
}

public data class Unit2(
    val sequenceNumber: Long,
    val captureTimestampUs: Long,
    val flags: Int,
    val spatialId: Int,
    val temporalId: Int,
    val payload: ByteArray,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) {
            return true
        }
        val casted = other as? Unit2 ?: return false
        return sequenceNumber == casted.sequenceNumber &&
            captureTimestampUs == casted.captureTimestampUs &&
            flags == casted.flags &&
            spatialId == casted.spatialId &&
            temporalId == casted.temporalId &&
            payload.contentEquals(casted.payload)
    }

    override fun hashCode(): Int {
        var result = sequenceNumber.hashCode()
        result = 31 * result + captureTimestampUs.hashCode()
        result = 31 * result + flags
        result = 31 * result + spatialId
        result = 31 * result + temporalId
        result = 31 * result + payload.contentHashCode()
        return result
    }
}

public data class MediaMessage(val channel: Int, val senderId: Long, val units: List<Unit2>)

private fun isAudio(channel: Int): Boolean = channel == CHANNEL_AUDIO || channel == CHANNEL_SCREEN_AUDIO

private fun knownChannel(channel: Int): Boolean = channel in 1..4

private fun putBe32(bytes: ByteArray, offset: Int, value: Long) {
    bytes[offset] = ((value shr 24) and 0xFF).toByte()
    bytes[offset + 1] = ((value shr 16) and 0xFF).toByte()
    bytes[offset + 2] = ((value shr 8) and 0xFF).toByte()
    bytes[offset + 3] = (value and 0xFF).toByte()
}

private fun putBe64(bytes: ByteArray, offset: Int, value: Long) {
    for (index in 0 until 8) {
        bytes[offset + index] = ((value ushr ((7 - index) * 8)) and 0xFF).toByte()
    }
}

private fun readBe32(bytes: ByteArray, offset: Int): Long? {
    if (offset + 4 > bytes.size) {
        return null
    }
    var value = 0L
    for (index in 0 until 4) {
        value = (value shl 8) or (bytes[offset + index].toLong() and 0xFF)
    }
    return value
}

private fun readBe64(bytes: ByteArray, offset: Int): Long? {
    if (offset + 8 > bytes.size) {
        return null
    }
    var value = 0L
    for (index in 0 until 8) {
        value = (value shl 8) or (bytes[offset + index].toLong() and 0xFF)
    }
    return value
}

/** メディアメッセージを符号化する。 */
public fun encodeMediaMessage(message: MediaMessage): WireOutcome<ByteArray> {
    if (!knownChannel(message.channel)) {
        return WireOutcome.Err(WireErrorKind.CHANNEL)
    }
    if (message.senderId == 0L) {
        return WireOutcome.Err(WireErrorKind.SENDER_ID)
    }
    if (message.units.isEmpty() || message.units.size > MAX_UNITS_PER_MESSAGE) {
        return WireOutcome.Err(WireErrorKind.UNIT_COUNT)
    }
    // 映像は常に 1 ユニットである（wire-format.md 1.5）。
    if (!isAudio(message.channel) && message.units.size != 1) {
        return WireOutcome.Err(WireErrorKind.UNIT_COUNT)
    }

    var total = MESSAGE_HEADER_BYTES
    var previous: Long? = null
    for (unit in message.units) {
        if (unit.payload.isEmpty()) {
            return WireOutcome.Err(WireErrorKind.PAYLOAD_EMPTY)
        }
        if (unit.spatialId > 3 || unit.temporalId > 7) {
            return WireOutcome.Err(WireErrorKind.FIELD_RANGE)
        }
        val last = previous
        if (last != null && unit.sequenceNumber <= last) {
            return WireOutcome.Err(WireErrorKind.UNIT_ORDER)
        }
        previous = unit.sequenceNumber
        total += UNIT_HEADER_BYTES + unit.payload.size
    }
    if (total > MAX_MESSAGE_BYTES) {
        return WireOutcome.Err(WireErrorKind.TOO_LARGE)
    }

    val bytes = ByteArray(total)
    bytes[0] = WIRE_MAGIC.toByte()
    bytes[1] = PROTOCOL_VERSION.toByte()
    bytes[2] = message.channel.toByte()
    bytes[3] = message.units.size.toByte()
    putBe32(bytes, 4, message.senderId)
    var offset = MESSAGE_HEADER_BYTES
    for (unit in message.units) {
        putBe32(bytes, offset, unit.sequenceNumber)
        putBe64(bytes, offset + 4, unit.captureTimestampUs)
        bytes[offset + 12] = unit.flags.toByte()
        bytes[offset + 13] = unit.spatialId.toByte()
        bytes[offset + 14] = unit.temporalId.toByte()
        bytes[offset + 15] = 0
        putBe32(bytes, offset + 16, unit.payload.size.toLong())
        unit.payload.copyInto(bytes, offset + UNIT_HEADER_BYTES)
        offset += UNIT_HEADER_BYTES + unit.payload.size
    }
    return WireOutcome.Ok(bytes)
}

/** メディアメッセージを復号する。 */
public fun decodeMediaMessage(bytes: ByteArray): WireOutcome<MediaMessage> {
    if (bytes.size < MESSAGE_HEADER_BYTES) {
        return WireOutcome.Err(WireErrorKind.LENGTH_MISMATCH)
    }
    if ((bytes[0].toInt() and 0xFF) != WIRE_MAGIC) {
        return WireOutcome.Err(WireErrorKind.MAGIC)
    }
    if ((bytes[1].toInt() and 0xFF) != PROTOCOL_VERSION) {
        return WireOutcome.Err(WireErrorKind.VERSION)
    }
    val channel = bytes[2].toInt() and 0xFF
    if (!knownChannel(channel)) {
        return WireOutcome.Err(WireErrorKind.CHANNEL)
    }
    val unitCount = bytes[3].toInt() and 0xFF
    if (unitCount == 0) {
        return WireOutcome.Err(WireErrorKind.UNIT_COUNT)
    }
    if (!isAudio(channel) && unitCount != 1) {
        return WireOutcome.Err(WireErrorKind.UNIT_COUNT)
    }
    val senderId = readBe32(bytes, 4) ?: return WireOutcome.Err(WireErrorKind.LENGTH_MISMATCH)
    if (senderId == 0L) {
        return WireOutcome.Err(WireErrorKind.SENDER_ID)
    }

    val units = mutableListOf<Unit2>()
    var offset = MESSAGE_HEADER_BYTES
    var previous: Long? = null
    for (index in 0 until unitCount) {
        if (offset + UNIT_HEADER_BYTES > bytes.size) {
            return WireOutcome.Err(WireErrorKind.LENGTH_MISMATCH)
        }
        val sequenceNumber = readBe32(bytes, offset) ?: return WireOutcome.Err(WireErrorKind.LENGTH_MISMATCH)
        val timestamp = readBe64(bytes, offset + 4) ?: return WireOutcome.Err(WireErrorKind.LENGTH_MISMATCH)
        val flags = bytes[offset + 12].toInt() and 0xFF
        val spatialId = bytes[offset + 13].toInt() and 0xFF
        val temporalId = bytes[offset + 14].toInt() and 0xFF
        if (spatialId > 3 || temporalId > 7) {
            return WireOutcome.Err(WireErrorKind.FIELD_RANGE)
        }
        val payloadLength = readBe32(bytes, offset + 16) ?: return WireOutcome.Err(WireErrorKind.LENGTH_MISMATCH)
        if (payloadLength == 0L) {
            return WireOutcome.Err(WireErrorKind.PAYLOAD_EMPTY)
        }
        val payloadStart = offset + UNIT_HEADER_BYTES
        val payloadEnd = payloadStart + payloadLength.toInt()
        if (payloadEnd > bytes.size) {
            return WireOutcome.Err(WireErrorKind.LENGTH_MISMATCH)
        }
        val last = previous
        if (last != null && sequenceNumber <= last) {
            return WireOutcome.Err(WireErrorKind.UNIT_ORDER)
        }
        previous = sequenceNumber
        units.add(
            Unit2(
                sequenceNumber = sequenceNumber,
                captureTimestampUs = timestamp,
                flags = flags,
                spatialId = spatialId,
                temporalId = temporalId,
                payload = bytes.copyOfRange(payloadStart, payloadEnd),
            ),
        )
        offset = payloadEnd
    }
    if (offset != bytes.size) {
        return WireOutcome.Err(WireErrorKind.LENGTH_MISMATCH)
    }
    return WireOutcome.Ok(MediaMessage(channel = channel, senderId = senderId, units = units))
}

/**
 * 破棄優先順位。wire-format.md 1.4 の判定順序をそのまま実装する。
 * null は破棄禁止を意味する。
 */
public fun dropPriority(channel: Int, flags: Int): Int? {
    if (isAudio(channel)) {
        return null
    }
    if (flags and FLAG_KEY != 0) {
        return null
    }
    val discardable = flags and FLAG_DISCARDABLE != 0
    val screen = flags and FLAG_SCREEN_CONTENT != 0
    val speaker = flags and FLAG_ACTIVE_SPEAKER != 0
    if (discardable && screen) {
        return 3
    }
    if (discardable && speaker) {
        return 2
    }
    if (discardable) {
        return 1
    }
    if (speaker) {
        return 5
    }
    return 4
}

/** DISCARDABLE の算出。独自判断を書かず規範の規則をそのまま実装する。 */
public fun computeDiscardable(
    channel: Int,
    isKeyFrame: Boolean,
    temporalId: Int,
    temporalLayerCount: Int,
): Boolean {
    if (isAudio(channel)) {
        return false
    }
    if (isKeyFrame) {
        return false
    }
    if (temporalLayerCount <= 1) {
        return false
    }
    return temporalId == temporalLayerCount - 1
}
