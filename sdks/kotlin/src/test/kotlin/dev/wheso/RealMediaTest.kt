// 実音声映像の照合（Kotlin、段 A の実データ版）。
//
// 合成したベクタではなく、**実際に符号化された AV1 と Opus**（spec/vectors/real-media.json）に
// 対して、ワイヤ形式の符号化・復号が往復で一致し、破棄可否と破棄優先順位の判断が
// 凍結資産と一致することを確かめる。同じ資産を 6 言語すべてが照合する。
//
// 資産を実装に合わせて変更してはならない（ADR-0012）。
package dev.wheso

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class RealMediaTest {
    private fun readAsset(): JsonObject =
        Json.parseToJsonElement(File("../../spec/vectors/real-media.json").readText()).jsonObject

    private fun intOf(obj: JsonObject, key: String): Int =
        obj[key]?.jsonPrimitive?.content?.toIntOrNull() ?: error("$key が整数ではない")

    private fun textOf(obj: JsonObject, key: String): String =
        obj[key]?.jsonPrimitive?.content ?: error("$key が文字列ではない")

    private fun boolOf(obj: JsonObject, key: String): Boolean =
        obj[key]?.jsonPrimitive?.content == "true"

    private fun hexToBytes(hex: String): ByteArray {
        val bytes = ByteArray(hex.length / 2)
        for (index in bytes.indices) {
            bytes[index] = hex.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
        return bytes
    }

    private fun bytesToHex(bytes: ByteArray): String {
        val builder = StringBuilder(bytes.size * 2)
        for (byte in bytes) {
            builder.append("%02x".format(byte.toInt() and 0xFF))
        }
        return builder.toString()
    }

    @Test
    fun realVideoEncodesToFrozenBytesAndRoundTrips() {
        val asset = readAsset()
        val senderId = intOf(asset, "senderId").toLong()
        val video = asset["video"]?.jsonObject ?: error("video が無い")
        val framerate = intOf(video, "framerate")
        val channel = intOf(video, "channel")
        val frames = video["frames"]?.jsonArray ?: error("frames が無い")
        assertTrue(frames.size >= 30, "映像が 30 枚以上ある（実際 ${frames.size}）")

        var checked = 0
        for (element in frames) {
            val frame = element.jsonObject
            val sequenceNumber = intOf(frame, "sequenceNumber")
            val payloadHex = textOf(frame, "payloadHex")
            val built = MediaMessage(
                channel = channel,
                senderId = senderId,
                units = listOf(
                    Unit2(
                        sequenceNumber = sequenceNumber.toLong(),
                        captureTimestampUs = (sequenceNumber - 1).toLong() * 1_000_000L / framerate.toLong(),
                        flags = intOf(frame, "expectedFlags"),
                        spatialId = intOf(frame, "spatialId"),
                        temporalId = intOf(frame, "temporalId"),
                        payload = hexToBytes(payloadHex),
                    ),
                ),
            )
            val encoded = encodeMediaMessage(built)
            assertTrue(encoded is WireOutcome.Ok, "映像 $sequenceNumber を符号化できる")
            val bytes = (encoded as WireOutcome.Ok).value
            assertEquals(
                textOf(frame, "expectedMessageHex"),
                bytesToHex(bytes),
                "映像 $sequenceNumber のバイト列が資産と一致する",
            )

            val decoded = decodeMediaMessage(bytes)
            assertTrue(decoded is WireOutcome.Ok, "映像 $sequenceNumber を復号できる")
            assertEquals(
                payloadHex,
                bytesToHex((decoded as WireOutcome.Ok).value.units[0].payload),
                "ペイロードが往復する",
            )
            checked += 1
        }
        assertTrue(checked >= 30, "30 枚以上を照合した（実際 $checked）")
    }

    @Test
    fun realVideoDecisionsMatchFrozenAsset() {
        val asset = readAsset()
        val video = asset["video"]?.jsonObject ?: error("video が無い")
        val channel = intOf(video, "channel")
        val temporalLayers = intOf(video, "temporalLayers")
        val frames = video["frames"]?.jsonArray ?: error("frames が無い")

        var discardableCount = 0
        for (element in frames) {
            val frame = element.jsonObject
            val discardable = computeDiscardable(
                channel,
                boolOf(frame, "keyFrame"),
                intOf(frame, "temporalId"),
                temporalLayers,
            )
            assertEquals(boolOf(frame, "expectedDiscardable"), discardable, "破棄可否が資産と一致する")
            if (discardable) {
                discardableCount += 1
            }
            val priority = dropPriority(channel, intOf(frame, "expectedFlags"))
            val expected = frame["expectedDropPriority"]
            if (expected == null || expected is JsonNull) {
                assertNull(priority, "破棄禁止が一致する")
            } else {
                assertEquals(expected.jsonPrimitive.content.toInt(), priority, "優先順位が一致する")
            }
        }
        // 最上位の時間層は破棄可能である。1 枚も無ければ判断を検証していない。
        assertTrue(discardableCount > 0, "破棄可能なフレームがある（実際 $discardableCount 枚）")
    }

    @Test
    fun realAudioBundlesMatchFrozenBytesAndAreNeverDroppable() {
        val asset = readAsset()
        val senderId = intOf(asset, "senderId").toLong()
        val audio = asset["audio"]?.jsonObject ?: error("audio が無い")
        val frameMs = intOf(audio, "frameMs")
        val unitsPerMessage = intOf(audio, "unitsPerMessage")
        val channel = intOf(audio, "channel")
        val bundles = audio["bundles"]?.jsonArray ?: error("bundles が無い")
        assertTrue(bundles.size >= 20, "音声束が 20 個以上ある（実際 ${bundles.size}）")

        var checked = 0
        for (index in bundles.indices) {
            val bundle = bundles[index].jsonObject
            val payloads = bundle["payloadsHex"]?.jsonArray ?: error("payloadsHex が無い")
            assertEquals(unitsPerMessage, payloads.size, "束ねる数が規範どおりである")
            val first = intOf(bundle, "firstSequenceNumber")
            val flags = intOf(bundle, "expectedFlags")

            val units = payloads.mapIndexed { offset, payload ->
                Unit2(
                    sequenceNumber = (first + offset).toLong(),
                    captureTimestampUs =
                        (index * unitsPerMessage + offset).toLong() * frameMs.toLong() * 1000L,
                    flags = flags,
                    spatialId = 0,
                    temporalId = 0,
                    payload = hexToBytes(payload.jsonPrimitive.content),
                )
            }
            val encoded = encodeMediaMessage(
                MediaMessage(channel = channel, senderId = senderId, units = units),
            )
            assertTrue(encoded is WireOutcome.Ok, "音声束 $index を符号化できる")
            val bytes = (encoded as WireOutcome.Ok).value
            assertEquals(
                textOf(bundle, "expectedMessageHex"),
                bytesToHex(bytes),
                "音声束 $index のバイト列が資産と一致する",
            )
            val decoded = decodeMediaMessage(bytes)
            assertTrue(decoded is WireOutcome.Ok, "音声束 $index を復号できる")
            assertEquals(
                unitsPerMessage,
                (decoded as WireOutcome.Ok).value.units.size,
                "ユニット数が往復する",
            )

            // 音声は決して破棄しない（規範）。
            assertNull(dropPriority(channel, flags), "音声は破棄禁止である")
            assertFalse(computeDiscardable(channel, false, 0, 1), "音声は破棄可能にならない")
            checked += 1
        }
        assertTrue(checked >= 20, "20 束以上を照合した（実際 $checked）")
    }
}
