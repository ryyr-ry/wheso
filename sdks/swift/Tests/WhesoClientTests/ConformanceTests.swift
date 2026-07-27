// 適合試験（Swift、段 A）。
//
// 凍結ベクタ（spec/vectors）に対して TypeScript の参照実装と同一の結果を出すことを確かめる。
// ベクタを実装に合わせて変更してはならない。実装を直す（ADR-0012）。
//
// 実行: swift test（sdks/swift で）

import Foundation
import XCTest

@testable import WhesoClient

final class ConformanceTests: XCTestCase {
    /// 凍結ベクタを読む。リポジトリ直下の spec/vectors を参照する。
    private func readVector(_ name: String) throws -> Any {
        let here = URL(fileURLWithPath: #filePath)
        let root = here
            .deletingLastPathComponent()  // WhesoClientTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // swift
            .deletingLastPathComponent()  // sdks
        let path = root.appendingPathComponent("spec/vectors/\(name)")
        let data = try Data(contentsOf: path)
        return try JSONSerialization.jsonObject(with: data, options: [])
    }

    private func hexToBytes(_ hex: String) -> [UInt8] {
        var bytes: [UInt8] = []
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2, limitedBy: hex.endIndex) ?? hex.endIndex
            if next == index {
                break
            }
            let part = String(hex[index..<next])
            bytes.append(UInt8(part, radix: 16) ?? 0)
            index = next
        }
        return bytes
    }

    private func bytesToHex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    private func intValue(_ value: Any?) -> Int64 {
        if let number = value as? NSNumber {
            return number.int64Value
        }
        if let text = value as? String {
            return Int64(text) ?? 0
        }
        return 0
    }

    private func unsignedValue(_ value: Any?) -> UInt64 {
        if let text = value as? String {
            return UInt64(text) ?? 0
        }
        if let number = value as? NSNumber {
            return number.uint64Value
        }
        return 0
    }

    func testPrngMatchesFrozenVectors() throws {
        let root = try readVector("prng.json") as? [String: Any]
        let vectors = root?["vectors"] as? [[String: Any]] ?? []
        XCTAssertFalse(vectors.isEmpty, "ベクタが空でない")
        for entry in vectors {
            let seed = unsignedValue(entry["seed"])
            let created = whesoCreatePrng(seed: seed)
            if seed == 0 {
                XCTAssertTrue(isFailure(created), "種 0 は失敗する")
                continue
            }
            guard case .success(var state) = created else {
                XCTFail("擬似乱数器を作れる")
                continue
            }
            let outputs = entry["outputs"] as? [Any] ?? []
            for expected in outputs {
                guard case .success(let step) = whesoPrngNext(state) else {
                    XCTFail("状態遷移できる")
                    break
                }
                state = step.state
                XCTAssertEqual(step.output, unsignedValue(expected), "出力が一致する")
            }
        }
    }

    func testMediaVectorsRoundTrip() throws {
        let entries = try readVector("media.json") as? [[String: Any]] ?? []
        XCTAssertFalse(entries.isEmpty)
        for entry in entries {
            let name = entry["name"] as? String ?? "(名前なし)"
            let expectedHex = entry["bytesHex"] as? String ?? ""
            let message = entry["message"] as? [String: Any] ?? [:]
            var units: [WhesoUnit] = []
            for unit in message["units"] as? [[String: Any]] ?? [] {
                units.append(
                    WhesoUnit(
                        sequenceNumber: UInt32(truncatingIfNeeded: intValue(unit["sequenceNumber"])),
                        captureTimestampUs: unsignedValue(unit["captureTimestampUs"]),
                        flags: UInt8(truncatingIfNeeded: intValue(unit["flags"])),
                        spatialId: UInt8(truncatingIfNeeded: intValue(unit["spatialId"])),
                        temporalId: UInt8(truncatingIfNeeded: intValue(unit["temporalId"])),
                        payload: hexToBytes(unit["payloadHex"] as? String ?? "")
                    )
                )
            }
            let built = WhesoMediaMessage(
                channel: UInt8(truncatingIfNeeded: intValue(message["channel"])),
                senderId: UInt32(truncatingIfNeeded: intValue(message["senderId"])),
                units: units
            )
            guard case .success(let encoded) = whesoEncodeMediaMessage(built) else {
                XCTFail("\(name): 符号化できる")
                continue
            }
            XCTAssertEqual(bytesToHex(encoded), expectedHex, "\(name): バイト列が一致する")

            guard case .success(let decoded) = whesoDecodeMediaMessage(hexToBytes(expectedHex)) else {
                XCTFail("\(name): 復号できる")
                continue
            }
            XCTAssertEqual(decoded, built, "\(name): 復号が一致する")
        }
    }

    func testInvalidVectorsRejectWithSameError() throws {
        let entries = try readVector("invalid.json") as? [[String: Any]] ?? []
        XCTAssertFalse(entries.isEmpty)
        for entry in entries {
            let name = entry["name"] as? String ?? "(名前なし)"
            let bytes = hexToBytes(entry["bytesHex"] as? String ?? "")
            let expected = entry["expectedErrorCode"] as? String ?? ""
            switch whesoDecodeMediaMessage(bytes) {
            case .success:
                XCTFail("\(name): 受理してはならない")
            case .failure(let error):
                XCTAssertEqual(error.name, expected, "\(name): 同じエラーで拒否する")
            }
        }
    }

    func testDropOrderMatchesFrozenVectors() throws {
        let entries = try readVector("drop-order.json") as? [[String: Any]] ?? []
        XCTAssertFalse(entries.isEmpty)
        for entry in entries {
            let name = entry["name"] as? String ?? "(名前なし)"
            let channel = UInt8(truncatingIfNeeded: intValue(entry["channel"]))
            let flags = UInt8(truncatingIfNeeded: intValue(entry["flags"]))
            let actual = whesoDropPriority(channel: channel, flags: flags)
            let expectedRaw = entry["expectedPriority"]
            if expectedRaw == nil || expectedRaw is NSNull {
                XCTAssertNil(actual, "\(name): 破棄禁止")
                continue
            }
            XCTAssertEqual(actual, UInt8(truncatingIfNeeded: intValue(expectedRaw)), "\(name): 優先順位が一致する")
        }
    }

    func testSlopeAndThresholds() {
        var rising: [Int64] = []
        var flat: [Int64] = []
        var falling: [Int64] = []
        for index in 0..<20 {
            rising.append(10_000 + Int64(index) * 1_000)
            flat.append(10_000)
            falling.append(30_000 - Int64(index) * 1_000)
        }
        XCTAssertTrue(whesoDelaySlope(rising).numerator > 0)
        XCTAssertEqual(whesoDelaySlope(flat).numerator, 0)
        XCTAssertTrue(whesoDelaySlope(falling).numerator < 0)
        XCTAssertTrue(whesoDelaySlope(rising).denominator > 0, "分母は常に正")
        XCTAssertTrue(whesoIsDegrading(whesoDelaySlope(rising)))
        XCTAssertFalse(whesoIsDegrading(whesoDelaySlope(flat)))
        XCTAssertTrue(whesoIsRecovering(whesoDelaySlope(falling)))
    }

    func testDiscardableAndDivision() {
        XCTAssertFalse(whesoComputeDiscardable(channel: 2, isKeyFrame: false, temporalId: 0, temporalLayerCount: 1))
        XCTAssertFalse(whesoComputeDiscardable(channel: 1, isKeyFrame: true, temporalId: 0, temporalLayerCount: 3))
        XCTAssertFalse(whesoComputeDiscardable(channel: 1, isKeyFrame: false, temporalId: 1, temporalLayerCount: 3))
        XCTAssertTrue(whesoComputeDiscardable(channel: 1, isKeyFrame: false, temporalId: 2, temporalLayerCount: 3))

        if case .success(let value) = whesoTruncDiv(10, 3) {
            XCTAssertEqual(value, 3)
        } else {
            XCTFail("正の割り算")
        }
        if case .success(let value) = whesoTruncDiv(-10, 3) {
            XCTAssertEqual(value, -3)
        } else {
            XCTFail("負はゼロ方向")
        }
        XCTAssertTrue(isFailure(whesoTruncDiv(10, 0)), "0 除算は失敗する")
        XCTAssertTrue(isFailure(whesoTruncDiv(9_007_199_254_740_993, 3)), "安全整数域外は失敗する")
    }

    private func isFailure<T, E: Error>(_ result: Result<T, E>) -> Bool {
        if case .failure = result {
            return true
        }
        return false
    }
}
