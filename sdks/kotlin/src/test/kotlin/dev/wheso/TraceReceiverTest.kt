// 受信ノードのトレースベクタの照合（Kotlin、層 2: 決定同一）。
//
// 凍結トレース（spec/vectors/trace-receiver.jsonl）を Kotlin の判断コアへ流し、
// 出力コマンド列が TypeScript の参照実装と**完全に一致**することを確かめる。
// 相違した場合はベクタではなく実装を直す（ADR-0012）。
package dev.wheso

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class TraceReceiverTest {
    /** 生成器（tools/traces-receiver.ts）と一致させる初期予算。 */
    private val initialBudgetBytesPerSec: Long = 7_000_000L

    private fun longOf(obj: JsonObject, key: String): Long {
        val value = obj[key]?.jsonPrimitive?.content
        return value?.toLongOrNull() ?: error("$key が整数ではない")
    }

    private fun toEvent(input: JsonObject): ReceiverEvent {
        return when (input["kind"]?.jsonPrimitive?.content) {
            "subscribe" -> {
                val raw = input["entries"]?.jsonArray ?: error("entries が無い")
                ReceiverEvent.SubscribeList(
                    raw.map { element ->
                        val entry = element.jsonObject
                        SubscribeEntry(
                            senderId = longOf(entry, "senderId"),
                            channel = longOf(entry, "channel"),
                            maxSpatialId = longOf(entry, "maxSpatialId"),
                            maxTemporalId = longOf(entry, "maxTemporalId"),
                        )
                    },
                )
            }
            "leave" -> ReceiverEvent.Leave(longOf(input, "id"))
            "visibility" -> ReceiverEvent.Visibility(
                input["visible"]?.jsonPrimitive?.content == "true",
            )
            "budget" -> ReceiverEvent.Budget(longOf(input, "bytesPerSec"))
            "activeSpeaker" -> {
                // null は「発話者なし」を意味する。欄の欠落と区別する。
                val value = input["activeSpeaker"] ?: input["id"] ?: error("id が無い")
                if (value is JsonNull) {
                    ReceiverEvent.ActiveSpeaker(null)
                } else {
                    ReceiverEvent.ActiveSpeaker(value.jsonPrimitive.content.toLongOrNull())
                }
            }
            "displaySize" -> ReceiverEvent.DisplaySize(
                senderId = longOf(input, "senderId"),
                channel = longOf(input, "channel"),
                width = longOf(input, "width"),
            )
            "report" -> {
                val samples = input["delayUs"]?.jsonArray ?: error("delayUs が無い")
                ReceiverEvent.Report(
                    samples.map { it.jsonPrimitive.content.toLongOrNull() ?: error("整数でない") },
                )
            }
            "media" -> ReceiverEvent.Media(
                from = longOf(input, "from"),
                ch = longOf(input, "ch"),
                sid = longOf(input, "sid"),
                tid = longOf(input, "tid"),
                seq = input["seq"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
            )
            "timer" -> ReceiverEvent.Timer
            else -> error("未知のイベント: ${input["kind"]}")
        }
    }

    /** 出力コマンドを TypeScript と同じ JSON 表現へ写す。欄名も一致させる。 */
    private fun toJson(command: ReceiverCommand): JsonObject = when (command) {
        is ReceiverCommand.SubscribeChange -> buildJsonObject {
            put("kind", JsonPrimitive("subscribeChange"))
            put("to", JsonPrimitive(command.to))
            put("channel", JsonPrimitive(command.channel))
            put("want", JsonPrimitive(command.want))
            put("maxSpatialId", JsonPrimitive(command.maxSpatialId))
            put("maxTemporalId", JsonPrimitive(command.maxTemporalId))
        }
        is ReceiverCommand.KeyframeRequest -> buildJsonObject {
            put("kind", JsonPrimitive("keyframeRequest"))
            put("for", JsonPrimitive(command.targetId))
            put("channel", JsonPrimitive(command.channel))
            put("spatialId", JsonPrimitive(command.spatialId))
        }
        is ReceiverCommand.SetTier -> buildJsonObject {
            put("kind", JsonPrimitive("setTier"))
            put("for", JsonPrimitive(command.targetId))
            put("channel", JsonPrimitive(command.channel))
            put("tier", JsonPrimitive(command.tier))
        }
        is ReceiverCommand.Forward -> buildJsonObject {
            put("kind", JsonPrimitive("forward"))
            put("to", buildJsonArray { command.to.forEach { add(JsonPrimitive(it)) } })
        }
        is ReceiverCommand.Drop -> buildJsonObject {
            put("kind", JsonPrimitive("drop"))
            put("priority", JsonPrimitive(command.priority))
            put("count", JsonPrimitive(command.count))
        }
        is ReceiverCommand.Notify -> buildJsonObject {
            put("kind", JsonPrimitive("notify"))
            put("code", JsonPrimitive(command.code))
        }
        is ReceiverCommand.Ack -> buildJsonObject {
            put("kind", JsonPrimitive("ack"))
            put("senderId", JsonPrimitive(command.senderId))
            put("channel", JsonPrimitive(command.channel))
            put("spatialId", JsonPrimitive(command.spatialId))
            put("highestSeq", JsonPrimitive(command.highestSeq))
        }
    }

    /** 欄の順序に依存せず、欄の過不足も検出する形へ正規化する。 */
    private fun normalize(array: JsonArray): List<Map<String, String>> =
        array.map { element ->
            element.jsonObject.entries.associate { (key, value) ->
                key to (if (value is JsonArray) value.toString() else value.jsonPrimitive.content)
            }
        }

    @Test
    fun frozenReceiverTraceMatchesTypescriptReference() {
        val lines = File("../../spec/vectors/trace-receiver.jsonl")
            .readLines()
            .filter { it.isNotBlank() }
        assertTrue(lines.size > 100, "トレースが十分な行数を持つ")

        val header = Json.parseToJsonElement(lines.first()).jsonObject
        assertEquals("receiver", header["unit"]?.jsonPrimitive?.content, "受信ノードのトレースである")

        var state = initialReceiverState(initialBudgetBytesPerSec)
        var pending: JsonObject? = null
        var checked = 0

        for (line in lines.drop(1)) {
            val row = Json.parseToJsonElement(line).jsonObject
            val input = row["in"]
            if (input != null) {
                pending = input.jsonObject
                continue
            }
            val out = row["out"] ?: continue
            val event = pending ?: error("出力に対応する入力が無い")
            pending = null
            val result = receiverStep(state, toEvent(event))
            state = result.state
            val actual = buildJsonArray { result.commands.forEach { add(toJson(it)) } }
            assertEquals(
                normalize(out.jsonArray),
                normalize(actual),
                "入力 $event に対する出力が一致する",
            )
            checked += 1
        }
        assertTrue(checked > 100, "十分な行数を照合した（実際 $checked）")
    }
}
