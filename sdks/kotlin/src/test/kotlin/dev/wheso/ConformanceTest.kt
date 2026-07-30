// 適合試験（Kotlin、段 A）。
//
// 凍結ベクタ（spec/vectors）に対して TypeScript の参照実装と同一の結果を出すことを確かめる。
// ベクタを実装に合わせて変更してはならない。実装を直す（ADR-0012）。
//
// 実行: gradle test（sdks/kotlin で）
package dev.wheso

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class ConformanceTest {
    private fun readVector(name: String): JsonElement {
        // 凍結ベクタはリポジトリ直下の spec/vectors にある。
        val file = File("../../spec/vectors/$name")
        return Json.parseToJsonElement(file.readText())
    }

    private fun hexToBytes(hex: String): ByteArray {
        val bytes = ByteArray(hex.length / 2)
        for (index in bytes.indices) {
            val part = hex.substring(index * 2, index * 2 + 2)
            bytes[index] = part.toInt(16).toByte()
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

    private fun intOf(element: JsonElement?): Long {
        val primitive = element?.jsonPrimitive ?: return 0L
        val text = primitive.content
        return text.toLongOrNull() ?: 0L
    }

    /** 64 bit の符号なし整数を、同じビット列の Long として読む。 */
    private fun unsignedOf(element: JsonElement?): Long {
        val text = element?.jsonPrimitive?.content ?: return 0L
        return text.toULongOrNull()?.toLong() ?: (text.toLongOrNull() ?: 0L)
    }

    @Test
    fun prngMatchesFrozenVectors() {
        val root = readVector("prng.json").jsonObject
        val vectors = root["vectors"]?.jsonArray ?: JsonArray(emptyList())
        assertTrue(vectors.isNotEmpty(), "ベクタが空でない")
        for (entry in vectors) {
            val record = entry.jsonObject
            val seed = unsignedOf(record["seed"])
            val created = createPrng(seed)
            if (seed == 0L) {
                assertFalse(created.isOk, "種 0 は失敗する")
                continue
            }
            assertTrue(created.isOk, "擬似乱数器を作れる")
            var state = (created as Outcome.Ok).value
            val outputs = record["outputs"]?.jsonArray ?: JsonArray(emptyList())
            for (expected in outputs) {
                val stepped = prngNext(state)
                assertTrue(stepped.isOk, "状態遷移できる")
                val step = (stepped as Outcome.Ok).value
                state = step.state
                assertEquals(unsignedOf(expected), step.output, "出力が一致する")
            }
        }
    }

    @Test
    fun mediaVectorsRoundTrip() {
        val entries = readVector("media.json").jsonArray
        assertTrue(entries.isNotEmpty())
        for (entry in entries) {
            val record = entry.jsonObject
            val name = record["name"]?.jsonPrimitive?.content ?: "(名前なし)"
            val expectedHex = record["bytesHex"]?.jsonPrimitive?.content ?: ""
            val message = record["message"]?.jsonObject ?: JsonObject(emptyMap())
            val units = mutableListOf<Unit2>()
            for (unit in message["units"]?.jsonArray ?: JsonArray(emptyList())) {
                val unitRecord = unit.jsonObject
                units.add(
                    Unit2(
                        sequenceNumber = intOf(unitRecord["sequenceNumber"]),
                        captureTimestampUs = unsignedOf(unitRecord["captureTimestampUs"]),
                        flags = intOf(unitRecord["flags"]).toInt(),
                        spatialId = intOf(unitRecord["spatialId"]).toInt(),
                        temporalId = intOf(unitRecord["temporalId"]).toInt(),
                        payload = hexToBytes(unitRecord["payloadHex"]?.jsonPrimitive?.content ?: ""),
                    ),
                )
            }
            val built = MediaMessage(
                channel = intOf(message["channel"]).toInt(),
                senderId = intOf(message["senderId"]),
                units = units,
            )
            val encoded = encodeMediaMessage(built)
            assertTrue(encoded.isOk, "$name: 符号化できる")
            assertEquals(expectedHex, bytesToHex((encoded as WireOutcome.Ok).value), "$name: バイト列が一致する")

            val decoded = decodeMediaMessage(hexToBytes(expectedHex))
            assertTrue(decoded.isOk, "$name: 復号できる")
            val value = (decoded as WireOutcome.Ok).value
            assertEquals(built.channel, value.channel)
            assertEquals(built.senderId, value.senderId)
            assertEquals(built.units, value.units, "$name: ユニットが一致する")
        }
    }

    @Test
    fun invalidVectorsRejectWithSameError() {
        val entries = readVector("invalid.json").jsonArray
        assertTrue(entries.isNotEmpty())
        for (entry in entries) {
            val record = entry.jsonObject
            val name = record["name"]?.jsonPrimitive?.content ?: "(名前なし)"
            val bytes = hexToBytes(record["bytesHex"]?.jsonPrimitive?.content ?: "")
            val expected = record["expectedErrorCode"]?.jsonPrimitive?.content ?: ""
            val decoded = decodeMediaMessage(bytes)
            assertFalse(decoded.isOk, "$name: 受理しない")
            assertEquals(expected, (decoded as WireOutcome.Err).kind.errorName, "$name: 同じエラー")
        }
    }

    @Test
    fun dropOrderMatchesFrozenVectors() {
        val entries = readVector("drop-order.json").jsonArray
        assertTrue(entries.isNotEmpty())
        for (entry in entries) {
            val record = entry.jsonObject
            val name = record["name"]?.jsonPrimitive?.content ?: "(名前なし)"
            val channel = intOf(record["channel"]).toInt()
            val flags = intOf(record["flags"]).toInt()
            val expectedElement = record["expectedPriority"]
            val actual = dropPriority(channel, flags)
            if (expectedElement == null || expectedElement is JsonNull) {
                assertEquals(null, actual, "$name: 破棄禁止")
                continue
            }
            assertEquals(intOf(expectedElement).toInt(), actual, "$name: 優先順位が一致する")
        }
    }

    @Test
    fun slopeAndThresholdsMatchSpecification() {
        val rising = (0 until 20).map { 10000L + it * 60000L }
        val flat = (0 until 20).map { 10000L }
        val falling = (0 until 20).map { 1200000L - it * 60000L }

        assertTrue(delaySlope(rising).numerator > 0)
        assertEquals(0L, delaySlope(flat).numerator)
        assertTrue(delaySlope(falling).numerator < 0)
        assertTrue(delaySlope(rising).denominator > 0, "分母は常に正")
        assertTrue(isDegrading(delaySlope(rising)))
        assertFalse(isDegrading(delaySlope(flat)))
        assertTrue(isRecovering(delaySlope(falling)))
    }

    @Test
    fun discardableAndDivisionMatchSpecification() {
        assertFalse(computeDiscardable(2, false, 0, 1), "音声は false")
        assertFalse(computeDiscardable(1, true, 0, 3), "キーは false")
        assertFalse(computeDiscardable(1, false, 1, 3), "最上位でない層は false")
        assertTrue(computeDiscardable(1, false, 2, 3), "最上位の層は true")

        assertEquals(3L, (truncDiv(10L, 3L) as Outcome.Ok).value)
        assertEquals(-3L, (truncDiv(-10L, 3L) as Outcome.Ok).value)
        assertFalse(truncDiv(10L, 0L).isOk)
        assertFalse(truncDiv(9007199254740993L, 3L).isOk)
    }
}
