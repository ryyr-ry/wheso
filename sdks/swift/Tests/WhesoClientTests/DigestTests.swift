// 自前の SHA-256 と HMAC-SHA256 の検証（Swift）。
//
// なぜ必要か: 疎通試験（TransportTests）はノード間認証の HMAC が正しいことに依存する。
// HMAC が誤っていれば接続が拒否され「線が通らない」ように見える。逆に、誤った HMAC でも
// 通ってしまえば認証が働いていないことになる。どちらの誤解も避けるため既知の答えで先に確かめる。

import Foundation
import XCTest

final class DigestTests: XCTestCase {
    private func hex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    func testSha256MatchesKnownAnswers() {
        // FIPS 180-4 の例。
        XCTAssertEqual(
            hex(WhesoDigest.sha256(Array("abc".utf8))),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        )
        XCTAssertEqual(
            hex(WhesoDigest.sha256([])),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        )
        // 64 バイト境界を跨ぐ長さ（詰め物の分岐を通す）。
        XCTAssertEqual(
            hex(WhesoDigest.sha256(Array(String(repeating: "a", count: 1000).utf8))),
            "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"
        )
    }

    func testHmacSha256MatchesRfc4231() {
        // テストベクタ 1。
        XCTAssertEqual(
            hex(WhesoDigest.hmacSha256(key: [UInt8](repeating: 0x0b, count: 20), message: Array("Hi There".utf8))),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        )
        // テストベクタ 2。
        XCTAssertEqual(
            hex(
                WhesoDigest.hmacSha256(
                    key: Array("Jefe".utf8),
                    message: Array("what do ya want for nothing?".utf8)
                )
            ),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        )
        // テストベクタ 3。
        XCTAssertEqual(
            hex(
                WhesoDigest.hmacSha256(
                    key: [UInt8](repeating: 0xaa, count: 20),
                    message: [UInt8](repeating: 0xdd, count: 50)
                )
            ),
            "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"
        )
        // テストベクタ 6（鍵がブロック長より長い。鍵をハッシュする分岐を通す）。
        XCTAssertEqual(
            hex(
                WhesoDigest.hmacSha256(
                    key: [UInt8](repeating: 0xaa, count: 131),
                    message: Array("Test Using Larger Than Block-Size Key - Hash Key First".utf8)
                )
            ),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        )
    }

    func testBase64UrlHasNoPadding() {
        // 詰め物を付けない（認証規範の符号化）。長さ 1・2・3 の各場合を通す。
        // 期待値は標準 base64 からの置換で導いた（手計算では誤りやすい）。
        XCTAssertEqual(WhesoDigest.base64UrlNoPad([0xff]), "_w")
        XCTAssertEqual(WhesoDigest.base64UrlNoPad([0xff, 0xfe]), "__4")
        XCTAssertEqual(WhesoDigest.base64UrlNoPad([0xff, 0xfe, 0xfd]), "__79")
    }
}
