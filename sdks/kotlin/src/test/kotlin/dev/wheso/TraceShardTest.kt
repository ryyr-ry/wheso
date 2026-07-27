// トレースベクタの照合（Kotlin、層 2: 決定同一）。
//
// 凍結トレース（spec/vectors/trace-shard.jsonl）を Kotlin の判断コアへ流し、
// 出力コマンド列が TypeScript の参照実装と**完全に一致**することを確かめる。
// 1 コマンドの相違も許さない（conformance.md 4.4）。
//
// 相違した場合はベクタではなく実装を直す（ADR-0012）。
package dev.wheso

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class TraceShardTest {
    private fun longOf(obj: JsonObject, key: String): Long {
        val value = obj[key]?.jsonPrimitive?.content
        return value?.toLongOrNull() ?: error("$key が整数ではない")
    }

    private fun toEvent(input: JsonObject): ShardEvent {
        return when (input["kind"]?.jsonPrimitive?.content) {
            "media" -> ShardEvent.Media(
                from = longOf(input, "from"),
                ch = longOf(input, "ch"),
                sid = longOf(input, "sid"),
                tid = longOf(input, "tid"),
                key = input["key"]?.jsonPrimitive?.content == "true",
                bytes = longOf(input, "bytes"),
                flags = longOf(input, "flags"),
            )
            "subscribe" -> ShardEvent.Subscribe(
                from = longOf(input, "from"),
                to = longOf(input, "to"),
                want = input["want"]?.jsonPrimitive?.content == "true",
                maxSpatialId = longOf(input, "maxSpatialId"),
            )
            "join" -> ShardEvent.Join(longOf(input, "id"))
            "leave" -> ShardEvent.Leave(longOf(input, "id"))
            "link" -> ShardEvent.Link(
                peer = input["peer"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                state = input["state"]?.jsonPrimitive?.content ?: "",
            )
            "timer" -> ShardEvent.Timer
            "budget" -> ShardEvent.Budget(longOf(input, "bytesPerSec"))
            "report" -> {
                val samples = input["delayUs"]?.jsonArray ?: error("delayUs が無い")
                ShardEvent.Report(
                    from = longOf(input, "from"),
                    delayUs = samples.map { it.jsonPrimitive.content.toLongOrNull() ?: error("整数でない") },
                )
            }
            else -> error("未知のイベント: ${input["kind"]}")
        }
    }

    /** 出力コマンドを TypeScript と同じ JSON 表現へ写す。欄名も一致させる。 */
    private fun toJson(command: ShardCommand): JsonObject = when (command) {
        is ShardCommand.Forward -> buildJsonObject {
            put("kind", JsonPrimitive("forward"))
            put("to", buildJsonArray { command.to.forEach { add(JsonPrimitive(it)) } })
        }
        is ShardCommand.Drop -> buildJsonObject {
            put("kind", JsonPrimitive("drop"))
            put("priority", JsonPrimitive(command.priority))
            put("count", JsonPrimitive(command.count))
        }
        is ShardCommand.Notify -> buildJsonObject {
            put("kind", JsonPrimitive("notify"))
            put("code", JsonPrimitive(command.code))
        }
        is ShardCommand.SetTier -> buildJsonObject {
            put("kind", JsonPrimitive("setTier"))
            put("for", JsonPrimitive(command.targetId))
            put("tier", JsonPrimitive(command.tier))
        }
    }

    /** 期待値の並びを、欄の順序に依存しない形で比べる。 */
    private fun normalize(array: JsonArray): List<Map<String, String>> =
        array.map { element ->
            element.jsonObject.entries.associate { (key, value) ->
                key to (if (value is JsonArray) value.toString() else value.jsonPrimitive.content)
            }
        }

    @Test
    fun frozenShardTraceMatchesTypescriptReference() {
        val lines = File("../../spec/vectors/trace-shard.jsonl")
            .readLines()
            .filter { it.isNotBlank() }
        assertTrue(lines.size > 100, "トレースが十分な行数を持つ")

        val header = Json.parseToJsonElement(lines.first()).jsonObject
        assertEquals("shard", header["unit"]?.jsonPrimitive?.content, "中継ノードのトレースである")

        var state: ShardState? = null
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
            val t = longOf(row, "t")
            // 初期状態の時刻はトレースの最初の t と一致させる必要がある。
            val current = state ?: initialShardState(t)
            val result = shardStep(current, toEvent(event), t)
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
