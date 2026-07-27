// 疎通試験（Kotlin、段 B）。
//
// 何を証明するか: Kotlin の SDK が**実際の Durable Object**（partykit dev）へ WebSocket で
// 接続し、実際に符号化された AV1（spec/vectors/real-media.json）を送り、購読者として
// **1 バイトも変わらずに**受け取れること。段 A（凍結ベクタとトレース）は判断の同一性を
// 示すが、実際に線を通ることは示さない。
//
// 依存を追加しない: WebSocket は java.net.http（JDK 11 以降）、HMAC は javax.crypto を使う。
//
// 実行の前提: 局所実行環境が起動していること。環境変数で場所と鍵を受け取る
// （WHESO_WS_BASE / WHESO_ROOM / WHESO_NODE_KEY / WHESO_SENDER_PK / WHESO_SUB_PK）。
// 無い場合は飛ばす。起動は tools/transport-suite.ts の責務である。
package dev.wheso

import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.nio.ByteBuffer
import java.util.Base64
import java.util.concurrent.CompletionStage
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class TransportTest {
    /** 時刻窓の長さ。認証規範の NODE_AUTH_TIME_WINDOW_SEC と一致させる。 */
    private val timeWindowSec = 300L

    /** 送る枚数。全部送ると試験が長くなるため先頭に限る（キーフレームを含む）。 */
    private val sendCount = 10

    private fun hmacSha256(key: ByteArray, message: String): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(message.toByteArray(Charsets.UTF_8))
    }

    /** base64url（詰め物なし）。認証規範の符号化に合わせる。 */
    private fun base64Url(bytes: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    /**
     * nodeHello の authTag を作る。
     * 会議シークレット = HMAC(鍵, "meeting-secret:v1:<会議 ID>")
     * authTag = base64url(HMAC(会議シークレット, "node-auth:v1:<部屋名>:<役割>:<時刻窓>"))
     * 参照実装（packages/core/src/auth.ts）と同じ文字列でなければ接続が拒否される。
     */
    private fun buildAuthTag(key: String, room: String, role: String): String {
        val meetingId = room.split("-").getOrNull(1) ?: ""
        val secret = hmacSha256(key.toByteArray(Charsets.UTF_8), "meeting-secret:v1:$meetingId")
        val window = (System.currentTimeMillis() / 1000L) / timeWindowSec
        return base64Url(hmacSha256(secret, "node-auth:v1:$room:$role:$window"))
    }

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

    private fun readAsset(): JsonObject =
        Json.parseToJsonElement(File("../../spec/vectors/real-media.json").readText()).jsonObject

    /** 受信したバイナリを溜める購読者。断片が来る場合があるため last まで繋ぐ。 */
    private class Collector(private val expected: Int) : WebSocket.Listener {
        val received = ConcurrentLinkedQueue<ByteArray>()
        val done = CountDownLatch(1)
        private val partial = mutableListOf<Byte>()

        override fun onOpen(webSocket: WebSocket) {
            webSocket.request(Long.MAX_VALUE)
        }

        override fun onBinary(webSocket: WebSocket, data: ByteBuffer, last: Boolean): CompletionStage<*>? {
            val chunk = ByteArray(data.remaining())
            data.get(chunk)
            partial.addAll(chunk.toList())
            if (last) {
                received.add(partial.toByteArray())
                partial.clear()
                if (received.size >= expected) {
                    done.countDown()
                }
            }
            webSocket.request(1)
            return null
        }

        override fun onClose(webSocket: WebSocket, statusCode: Int, reason: String): CompletionStage<*>? {
            println("購読側が閉じられた: $statusCode $reason")
            done.countDown()
            return null
        }

        override fun onError(webSocket: WebSocket, error: Throwable) {
            println("購読側の誤り: ${error.message}")
            done.countDown()
        }
    }

    private fun connect(url: String, listener: WebSocket.Listener): WebSocket =
        HttpClient.newHttpClient()
            .newWebSocketBuilder()
            .buildAsync(URI.create(url), listener)
            .get(30, TimeUnit.SECONDS)

    @Test
    fun realMediaTravelsThroughLiveNode() {
        val environment = System.getenv()
        val base = environment["WHESO_WS_BASE"]
        val room = environment["WHESO_ROOM"]
        val key = environment["WHESO_NODE_KEY"]
        val senderPk = environment["WHESO_SENDER_PK"]
        val subPk = environment["WHESO_SUB_PK"]
        if (base == null || room == null || key == null || senderPk == null || subPk == null) {
            // 局所実行環境が無い場所では飛ばす。CI では実行器が環境変数を与える。
            println("SKIP 疎通試験（環境変数が無い）")
            return
        }

        val asset = readAsset()
        val video = asset["video"]?.jsonObject ?: error("video が無い")
        val frames = video["frames"]?.jsonArray ?: error("frames が無い")
        val senderId = asset["senderId"]?.jsonPrimitive?.content?.toLong() ?: error("senderId が無い")
        val channel = video["channel"]?.jsonPrimitive?.content?.toInt() ?: error("channel が無い")
        val framerate = video["framerate"]?.jsonPrimitive?.content?.toInt() ?: 30
        assertTrue(frames.size >= sendCount, "資産に $sendCount 枚以上ある")

        // 購読側を先に開く。順序を逆にすると転送先が無く、送ったものが消える。
        val collector = Collector(sendCount)
        val subscriber = connect("$base/parties/shard/$room?_pk=$subPk", collector)
        // JDK の WebSocket は前の送信が完了する前に次を呼ぶと失敗する。1 件ずつ待つ。
        subscriber.sendText(
            """{"t":"nodeHello","role":"receiver","nodeId":"$room","authTag":"${buildAuthTag(key, room, "receiver")}"}""",
            true,
        ).get(10, TimeUnit.SECONDS)
        subscriber.sendText(
            """{"t":"subscribe","entries":[{"senderId":$senderId,"channel":$channel,"maxSpatialId":3,"maxTemporalId":7}]}""",
            true,
        ).get(10, TimeUnit.SECONDS)
        // 購読の登録が処理される猶予を置く。
        Thread.sleep(1000)

        val sender = connect(
            "$base/parties/shard/$room?_pk=$senderPk",
            object : WebSocket.Listener {
                override fun onOpen(webSocket: WebSocket) {
                    webSocket.request(Long.MAX_VALUE)
                }

                override fun onClose(webSocket: WebSocket, statusCode: Int, reason: String): CompletionStage<*>? {
                    println("送信側が閉じられた: $statusCode $reason")
                    return null
                }
            },
        )
        sender.sendText(
            """{"t":"nodeHello","role":"sender","nodeId":"$room","authTag":"${buildAuthTag(key, room, "sender")}"}""",
            true,
        ).get(10, TimeUnit.SECONDS)
        Thread.sleep(500)

        val sentHex = mutableListOf<String>()
        for (index in 0 until sendCount) {
            val frame = frames[index].jsonObject
            val hex = frame["expectedMessageHex"]?.jsonPrimitive?.content ?: error("期待バイト列が無い")
            sentHex.add(hex)
            sender.sendBinary(ByteBuffer.wrap(hexToBytes(hex)), true).get(10, TimeUnit.SECONDS)
            // 実際の間隔で送る。詰めて送ると予算超過の破棄が働き、疎通の検証にならない。
            Thread.sleep((1000L / framerate).coerceAtLeast(1L))
        }

        assertTrue(
            collector.done.await(30, TimeUnit.SECONDS),
            "購読者が $sendCount 件を受け取る（実際 ${collector.received.size} 件）",
        )
        val receivedHex = collector.received.map { bytesToHex(it) }
        assertEquals(sendCount, receivedHex.size, "受け取った件数が一致する")
        for (index in 0 until sendCount) {
            assertEquals(
                sentHex[index],
                receivedHex[index],
                "$index 番目のバイト列が 1 バイトも変わらない",
            )
        }

        subscriber.abort()
        sender.abort()
    }
}
