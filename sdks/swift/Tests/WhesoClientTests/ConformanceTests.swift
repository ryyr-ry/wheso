// 適合試験（Swift、段 A）。
//
// 凍結ベクタ（spec/vectors）に対して TypeScript の参照実装と同一の結果を出すことを確かめる。
// ベクタを実装に合わせて変更してはならない。実装を直す（ADR-0012）。
//
// 実行: swift test（sdks/swift で）
//
// 動的型（Any）を使わない（lint-policy.md 1 節）。JSON は Decodable で構造を宣言して読む。
// 欠損したフィールドを既定値へ落とさない。落とすと、ベクタの取り違えを試験が検出できなくなる。

import Foundation
import XCTest

@testable import WhesoClient

private struct PrngFile: Decodable {
    let vectors: [PrngVector]
}

private struct PrngVector: Decodable {
    let seed: String
    let outputs: [String]
}

private struct MediaVector: Decodable {
    let name: String
    let bytesHex: String
    let message: MediaMessageVector
}

private struct MediaMessageVector: Decodable {
    let channel: Int
    let senderId: Int
    let units: [UnitVector]
}

private struct UnitVector: Decodable {
    let sequenceNumber: Int
    let captureTimestampUs: String
    let flags: Int
    let spatialId: Int
    let temporalId: Int
    let payloadHex: String
}

private struct InvalidVector: Decodable {
    let name: String
    let bytesHex: String
    let expectedErrorCode: String
}

/// `expectedPriority` は null を取り得る（破棄禁止の意味）。
/// ただしキーの欠落は誤りであるため、`decodeIfPresent` を使わず復号を失敗させる。
private struct DropVector: Decodable {
    let name: String
    let channel: Int
    let flags: Int
    let expectedPriority: Int?

    private enum CodingKeys: String, CodingKey {
        case name
        case channel
        case flags
        case expectedPriority
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        channel = try container.decode(Int.self, forKey: .channel)
        flags = try container.decode(Int.self, forKey: .flags)
        expectedPriority = try container.decode(Int?.self, forKey: .expectedPriority)
    }
}

final class ConformanceTests: XCTestCase {
    /// 凍結ベクタを読む。リポジトリ直下の spec/vectors を参照する。
    private func readVector<T: Decodable>(_ name: String, _ type: T.Type) throws -> T {
        let here = URL(fileURLWithPath: #filePath)
        let root = here
            .deletingLastPathComponent()  // ConformanceTests.swift を落とす
            .deletingLastPathComponent()  // WhesoClientTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // swift
            .deletingLastPathComponent()  // sdks
        let path = root.appendingPathComponent("spec/vectors/\(name)")
        let data = try Data(contentsOf: path)
        return try JSONDecoder().decode(type, from: data)
    }

    /// 16 進文字列をバイト列にする。不正な入力は nil を返す（0 で埋めない）。
    private func hexToBytes(_ hex: String) -> [UInt8]? {
        if hex.count % 2 != 0 {
            return nil
        }
        var bytes: [UInt8] = []
        var index = hex.startIndex
        while index < hex.endIndex {
            guard let next = hex.index(index, offsetBy: 2, limitedBy: hex.endIndex) else {
                return nil
            }
            guard let value = UInt8(hex[index..<next], radix: 16) else {
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

    func testPrngMatchesFrozenVectors() throws {
        let file = try readVector("prng.json", PrngFile.self)
        XCTAssertFalse(file.vectors.isEmpty, "ベクタが空でない")
        for entry in file.vectors {
            guard let seed = UInt64(entry.seed) else {
                XCTFail("種を整数として読める: \(entry.seed)")
                continue
            }
            let created = whesoCreatePrng(seed: seed)
            if seed == 0 {
                XCTAssertTrue(isFailure(created), "種 0 は失敗する")
                continue
            }
            guard case .success(var state) = created else {
                XCTFail("擬似乱数器を作れる")
                continue
            }
            XCTAssertFalse(entry.outputs.isEmpty, "出力列が空でない")
            for expectedText in entry.outputs {
                guard let expected = UInt64(expectedText) else {
                    XCTFail("期待値を整数として読める: \(expectedText)")
                    break
                }
                guard case .success(let step) = whesoPrngNext(state) else {
                    XCTFail("状態遷移できる")
                    break
                }
                state = step.state
                XCTAssertEqual(step.output, expected, "出力が一致する")
            }
        }
    }

    func testMediaVectorsRoundTrip() throws {
        let entries = try readVector("media.json", [MediaVector].self)
        XCTAssertFalse(entries.isEmpty)
        for entry in entries {
            var units: [WhesoUnit] = []
            var payloadFailed = false
            for unit in entry.message.units {
                guard let payload = hexToBytes(unit.payloadHex),
                      let timestamp = UInt64(unit.captureTimestampUs)
                else {
                    XCTFail("\(entry.name): ユニットの 16 進とタイムスタンプを読める")
                    payloadFailed = true
                    break
                }
                units.append(
                    WhesoUnit(
                        sequenceNumber: UInt32(truncatingIfNeeded: unit.sequenceNumber),
                        captureTimestampUs: timestamp,
                        flags: UInt8(truncatingIfNeeded: unit.flags),
                        spatialId: UInt8(truncatingIfNeeded: unit.spatialId),
                        temporalId: UInt8(truncatingIfNeeded: unit.temporalId),
                        payload: payload
                    )
                )
            }
            if payloadFailed {
                continue
            }
            let built = WhesoMediaMessage(
                channel: UInt8(truncatingIfNeeded: entry.message.channel),
                senderId: UInt32(truncatingIfNeeded: entry.message.senderId),
                units: units
            )
            guard case .success(let encoded) = whesoEncodeMediaMessage(built) else {
                XCTFail("\(entry.name): 符号化できる")
                continue
            }
            XCTAssertEqual(bytesToHex(encoded), entry.bytesHex, "\(entry.name): バイト列が一致する")

            guard let expectedBytes = hexToBytes(entry.bytesHex) else {
                XCTFail("\(entry.name): 期待バイト列を読める")
                continue
            }
            guard case .success(let decoded) = whesoDecodeMediaMessage(expectedBytes) else {
                XCTFail("\(entry.name): 復号できる")
                continue
            }
            XCTAssertEqual(decoded, built, "\(entry.name): 復号が一致する")
        }
    }

    func testInvalidVectorsRejectWithSameError() throws {
        let entries = try readVector("invalid.json", [InvalidVector].self)
        XCTAssertFalse(entries.isEmpty)
        for entry in entries {
            guard let bytes = hexToBytes(entry.bytesHex) else {
                XCTFail("\(entry.name): 16 進を読める")
                continue
            }
            switch whesoDecodeMediaMessage(bytes) {
            case .success:
                XCTFail("\(entry.name): 受理してはならない")
            case .failure(let error):
                XCTAssertEqual(error.name, entry.expectedErrorCode, "\(entry.name): 同じエラーで拒否する")
            }
        }
    }

    func testDropOrderMatchesFrozenVectors() throws {
        let entries = try readVector("drop-order.json", [DropVector].self)
        XCTAssertFalse(entries.isEmpty)
        for entry in entries {
            let actual = whesoDropPriority(
                channel: UInt8(truncatingIfNeeded: entry.channel),
                flags: UInt8(truncatingIfNeeded: entry.flags)
            )
            guard let expected = entry.expectedPriority else {
                XCTAssertNil(actual, "\(entry.name): 破棄禁止")
                continue
            }
            XCTAssertEqual(actual, UInt8(truncatingIfNeeded: expected), "\(entry.name): 優先順位が一致する")
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
