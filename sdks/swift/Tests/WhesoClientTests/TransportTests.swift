// 疎通試験（Swift、段 B）。
//
// 何を証明するか: Swift の SDK が**実際の Durable Object**（partykit dev）へ WebSocket で
// 接続し、実際に符号化された AV1（spec/vectors/real-media.json）を送り、購読者として
// **1 バイトも変わらずに**受け取れること。段 A（凍結ベクタ・トレース・実データ照合）は
// 判断とバイト列の同一性を示すが、実際に線を通ることは示さない。
//
// 依存を追加しない: WebSocket は WebSocketClient.swift（自前の RFC 6455）、HMAC は
// Digest.swift（自前）を使う。どちらも試験の中だけに置く。
// Linux の URLSessionWebSocketTask は libcurl に WebSocket が無いため実行時に失敗する（実測）。
// 自前 HMAC は DigestTests.swift が RFC 4231 で検証している。
//
// 実行の前提: 実環境（PartyKit managed）へデプロイされていること。環境変数で場所と鍵を受け取る
// （WHESO_WS_BASE / WHESO_ROOM / WHESO_NODE_KEY / WHESO_SENDER_PK / WHESO_SUB_PK）。
// 無い場合は飛ばす。起動は tools/transport-suite.ts の責務である。

import Foundation
import XCTest

/// 受信したバイナリを溜める入れ物。受信は別スレッドで動くため錠で守る。
private final class Inbox: @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [[UInt8]] = []

    func append(_ bytes: [UInt8]) {
        lock.lock()
        frames.append(bytes)
        lock.unlock()
    }

    var count: Int {
        lock.lock()
        let value = frames.count
        lock.unlock()
        return value
    }

    var all: [[UInt8]] {
        lock.lock()
        let value = frames
        lock.unlock()
        return value
    }
}

final class TransportTests: XCTestCase {
    /// 時刻窓の長さ。認証規範の NODE_AUTH_TIME_WINDOW_SEC と一致させる。
    private let timeWindowSec: Int64 = 300

    /// 送る枚数。全部送ると試験が長くなるため先頭に限る（キーフレームを含む）。
    private let sendCount = 10

    /// nodeHello の authTag を作る。
    /// 会議シークレット = HMAC(鍵, "meeting-secret:v1:<会議 ID>")
    /// authTag = base64url(HMAC(会議シークレット, "node-auth:v1:<部屋名>:<役割>:<時刻窓>"))
    /// 参照実装（packages/core/src/auth.ts）と 1 文字でも違えば 4023 で切られる。
    private func buildAuthTag(key: String, room: String, role: String) -> String {
        let parts = room.split(separator: "-")
        let meetingId = parts.count > 1 ? String(parts[1]) : ""
        let secret = WhesoDigest.hmacSha256(
            key: Array(key.utf8),
            message: Array("meeting-secret:v1:\(meetingId)".utf8)
        )
        let window = Int64(Date().timeIntervalSince1970) / timeWindowSec
        let tag = WhesoDigest.hmacSha256(
            key: secret,
            message: Array("node-auth:v1:\(room):\(role):\(window)".utf8)
        )
        return WhesoDigest.base64UrlNoPad(tag)
    }

    private func readAsset() throws -> JsonValue {
        let here = URL(fileURLWithPath: #filePath)
        let root = here
            .deletingLastPathComponent()  // TransportTests.swift を落とす
            .deletingLastPathComponent()  // WhesoClientTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // swift
            .deletingLastPathComponent()  // sdks
        let path = root.appendingPathComponent("spec/vectors/real-media.json")
        let data = try Data(contentsOf: path)
        return try JSONDecoder().decode(JsonValue.self, from: data)
    }

    private func hexToBytes(_ hex: String) -> [UInt8]? {
        if hex.count % 2 != 0 {
            return nil
        }
        var bytes: [UInt8] = []
        var index = hex.startIndex
        while index < hex.endIndex {
            guard let next = hex.index(index, offsetBy: 2, limitedBy: hex.endIndex),
                let value = UInt8(hex[index..<next], radix: 16)
            else {
                return nil
            }
            bytes.append(value)
            index = next
        }
        return bytes
    }

    private func bytesToHex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// JSON の文字列値を作る。引用符を並べ書きすると読めなくなるため 1 箇所に集める。
    private func quoted(_ text: String) -> String {
        "\"\(text)\""
    }

    func testRealMediaTravelsThroughLiveNode() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let base = environment["WHESO_WS_BASE"],
            let room = environment["WHESO_ROOM"],
            let key = environment["WHESO_NODE_KEY"],
            let senderPk = environment["WHESO_SENDER_PK"],
            let subPk = environment["WHESO_SUB_PK"]
        else {
            // 局所実行環境が無い場所では飛ばす。実行器が環境変数を与える。
            print("SKIP 疎通試験（環境変数が無い）")
            return
        }

        // 実環境へは TLS の終端を経由して繋ぐため、Host ヘッダに実環境の名前を書く。
        let wsHost = environment["WHESO_WS_HOST"]

        let asset = try readAsset()
        let video = try XCTUnwrap(asset.field("video"), "video が無い")
        let frames = try XCTUnwrap(video.field("frames")?.asArray, "frames が無い")
        let senderId = try XCTUnwrap(asset.field("senderId")?.asInteger, "senderId が無い")
        let channel = try XCTUnwrap(video.field("channel")?.asInteger, "channel が無い")
        let framerate = video.field("framerate")?.asInteger ?? 30
        XCTAssertGreaterThanOrEqual(frames.count, sendCount, "資産に \(sendCount) 枚以上ある")

        // 購読側を先に開く。順序を逆にすると転送先が無く、送ったものが消える。
        let subscriber: WebSocketClient
        switch WebSocketClient.connect(
            url: "\(base)/parties/shard/\(room)?_pk=\(subPk)", hostHeader: wsHost
        ) {
        case .failure(let error):
            XCTFail("購読側が繋がらない: \(error.description)")
            return
        case .success(let client):
            subscriber = client
        }

        let receiverTag = buildAuthTag(key: key, room: room, role: "receiver")
        XCTAssertNil(
            subscriber.send(
                text:
                    "{\"t\":\"nodeHello\",\"role\":\"receiver\",\"nodeId\":\(quoted(room)),\"authTag\":\(quoted(receiverTag))}"
            ),
            "購読側の nodeHello が送れる"
        )
        XCTAssertNil(
            subscriber.send(
                text:
                    "{\"t\":\"subscribe\",\"entries\":[{\"senderId\":\(senderId),\"channel\":\(channel),\"maxSpatialId\":3,\"maxTemporalId\":7}]}"
            ),
            "購読が送れる"
        )

        // 受信を先に仕掛ける。仕掛ける前に送ると取りこぼす。
        let inbox = Inbox()
        let closeCode = Inbox()
        let want = sendCount
        let pump = Thread {
            while inbox.count < want {
                switch subscriber.receive() {
                case .failure:
                    // 時間切れか切断。理由は下の判定で件数として現れる。
                    return
                case .success(.binary(let bytes)):
                    inbox.append(bytes)
                case .success(.text):
                    // 制御メッセージ（nodeHelloAck など）は数えない。
                    break
                case .success(.closed(let code, let reason)):
                    // 認証に失敗すると 4023（E_NODE_AUTH）で切られる。原因を残す。
                    print("購読側が閉じられた: \(code) \(reason)")
                    closeCode.append([UInt8(truncatingIfNeeded: code >> 8), UInt8(truncatingIfNeeded: code)])
                    return
                }
            }
        }
        pump.start()
        // 購読の登録が処理される猶予を置く。
        Thread.sleep(forTimeInterval: 1.0)

        let sender: WebSocketClient
        switch WebSocketClient.connect(
            url: "\(base)/parties/shard/\(room)?_pk=\(senderPk)", hostHeader: wsHost
        ) {
        case .failure(let error):
            XCTFail("送信側が繋がらない: \(error.description)")
            subscriber.disconnect()
            return
        case .success(let client):
            sender = client
        }
        let senderTag = buildAuthTag(key: key, room: room, role: "sender")
        XCTAssertNil(
            sender.send(
                text:
                    "{\"t\":\"nodeHello\",\"role\":\"sender\",\"nodeId\":\(quoted(room)),\"authTag\":\(quoted(senderTag))}"
            ),
            "送信側の nodeHello が送れる"
        )
        Thread.sleep(forTimeInterval: 0.5)

        var sentHex: [String] = []
        for index in 0..<sendCount {
            let frame = frames[index]
            let hex = try XCTUnwrap(frame.field("expectedMessageHex")?.asText, "期待バイト列が無い")
            let bytes = try XCTUnwrap(hexToBytes(hex), "16 進が読める")
            sentHex.append(hex)
            XCTAssertNil(sender.send(binary: bytes), "\(index) 番目が送れる")
            // 実際の間隔で送る。詰めて送ると予算超過の破棄が働き、疎通の検証にならない。
            Thread.sleep(forTimeInterval: 1.0 / Double(max(framerate, 1)))
        }

        // 転送は非同期であるため、送り終えた時点では届いていない。揃うまで待つ。
        let deadline = Date().addingTimeInterval(30)
        while inbox.count < sendCount, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }

        let receivedHex = inbox.all.map { bytesToHex($0) }
        XCTAssertEqual(receivedHex.count, sendCount, "購読者が \(sendCount) 件を受け取る")
        for index in 0..<min(receivedHex.count, sendCount) {
            XCTAssertEqual(
                receivedHex[index], sentHex[index],
                "\(index) 番目のバイト列が 1 バイトも変わらない"
            )
        }

        subscriber.disconnect()
        sender.disconnect()
    }
}
