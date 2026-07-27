// 実音声映像の照合（Swift、段 A の実データ版）。
//
// 合成したベクタではなく、**実際に符号化された AV1 と Opus**（spec/vectors/real-media.json）に
// 対して、ワイヤ形式の符号化・復号が往復で一致し、破棄可否と破棄優先順位の判断が
// 凍結資産と一致することを確かめる。同じ資産を 6 言語すべてが照合する。
//
// 資産を実装に合わせて変更してはならない（ADR-0012）。
// 動的型（Any）を使わない。可変構造は TraceTests.swift の JsonValue で読む。

import Foundation
import XCTest

@testable import WhesoClient

final class RealMediaTests: XCTestCase {
    private func readAsset() throws -> JsonValue {
        let here = URL(fileURLWithPath: #filePath)
        let root = here
            .deletingLastPathComponent()  // RealMediaTests.swift を落とす
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

    func testRealVideoEncodesToFrozenBytesAndRoundTrips() throws {
        let asset = try readAsset()
        guard let senderId = asset.field("senderId")?.asInteger,
              let video = asset.field("video"),
              let framerate = video.field("framerate")?.asInteger,
              let channel = video.field("channel")?.asInteger,
              let frames = video.field("frames")?.asArray
        else {
            XCTFail("資産の構造が想定と違う")
            return
        }
        XCTAssertGreaterThanOrEqual(frames.count, 30, "映像が 30 枚以上ある")

        var checked = 0
        for frame in frames {
            guard let sequenceNumber = frame.field("sequenceNumber")?.asInteger,
                  let payloadHex = frame.field("payloadHex")?.asText,
                  let flags = frame.field("expectedFlags")?.asInteger,
                  let spatialId = frame.field("spatialId")?.asInteger,
                  let temporalId = frame.field("temporalId")?.asInteger,
                  let expectedHex = frame.field("expectedMessageHex")?.asText,
                  let payload = hexToBytes(payloadHex)
            else {
                XCTFail("映像の欄が読めない")
                return
            }
            let unit = WhesoUnit(
                sequenceNumber: UInt32(truncatingIfNeeded: sequenceNumber),
                captureTimestampUs: UInt64(truncatingIfNeeded: (sequenceNumber - 1) * 1_000_000 / framerate),
                flags: UInt8(truncatingIfNeeded: flags),
                spatialId: UInt8(truncatingIfNeeded: spatialId),
                temporalId: UInt8(truncatingIfNeeded: temporalId),
                payload: payload
            )
            let message = WhesoMediaMessage(
                channel: UInt8(truncatingIfNeeded: channel),
                senderId: UInt32(truncatingIfNeeded: senderId),
                units: [unit]
            )
            guard case .success(let encoded) = whesoEncodeMediaMessage(message) else {
                XCTFail("映像 \(sequenceNumber) を符号化できる")
                return
            }
            XCTAssertEqual(bytesToHex(encoded), expectedHex, "映像 \(sequenceNumber) のバイト列が資産と一致する")

            guard case .success(let decoded) = whesoDecodeMediaMessage(encoded) else {
                XCTFail("映像 \(sequenceNumber) を復号できる")
                return
            }
            XCTAssertEqual(bytesToHex(decoded.units.first?.payload ?? []), payloadHex, "ペイロードが往復する")
            checked += 1
        }
        XCTAssertGreaterThanOrEqual(checked, 30, "30 枚以上を照合した")
    }

    func testRealVideoDecisionsMatchFrozenAsset() throws {
        let asset = try readAsset()
        guard let video = asset.field("video"),
              let channel = video.field("channel")?.asInteger,
              let temporalLayers = video.field("temporalLayers")?.asInteger,
              let frames = video.field("frames")?.asArray
        else {
            XCTFail("資産の構造が想定と違う")
            return
        }

        var discardableCount = 0
        for frame in frames {
            guard let keyFrame = frame.field("keyFrame")?.asBool,
                  let temporalId = frame.field("temporalId")?.asInteger,
                  let flags = frame.field("expectedFlags")?.asInteger,
                  let expectedDiscardable = frame.field("expectedDiscardable")?.asBool
            else {
                XCTFail("映像の判断の欄が読めない")
                return
            }
            let discardable = whesoComputeDiscardable(
                channel: UInt8(truncatingIfNeeded: channel),
                isKeyFrame: keyFrame,
                temporalId: UInt8(truncatingIfNeeded: temporalId),
                temporalLayerCount: UInt8(truncatingIfNeeded: temporalLayers)
            )
            XCTAssertEqual(discardable, expectedDiscardable, "破棄可否が資産と一致する")
            if discardable {
                discardableCount += 1
            }
            let priority = whesoDropPriority(
                channel: UInt8(truncatingIfNeeded: channel),
                flags: UInt8(truncatingIfNeeded: flags)
            )
            guard let expected = frame.field("expectedDropPriority") else {
                XCTFail("優先順位の欄が無い")
                return
            }
            if expected.isNull {
                XCTAssertNil(priority, "破棄禁止が一致する")
            } else {
                XCTAssertEqual(priority.map { Int64($0) }, expected.asInteger, "優先順位が一致する")
            }
        }
        // 最上位の時間層は破棄可能である。1 枚も無ければ判断を検証していない。
        XCTAssertGreaterThan(discardableCount, 0, "破棄可能なフレームがある")
    }

    func testRealAudioBundlesMatchFrozenBytesAndAreNeverDroppable() throws {
        let asset = try readAsset()
        guard let senderId = asset.field("senderId")?.asInteger,
              let audio = asset.field("audio"),
              let frameMs = audio.field("frameMs")?.asInteger,
              let unitsPerMessage = audio.field("unitsPerMessage")?.asInteger,
              let channel = audio.field("channel")?.asInteger,
              let bundles = audio.field("bundles")?.asArray
        else {
            XCTFail("資産の構造が想定と違う")
            return
        }
        XCTAssertGreaterThanOrEqual(bundles.count, 20, "音声束が 20 個以上ある")

        var checked = 0
        for (index, bundle) in bundles.enumerated() {
            guard let payloads = bundle.field("payloadsHex")?.asArray,
                  let first = bundle.field("firstSequenceNumber")?.asInteger,
                  let flags = bundle.field("expectedFlags")?.asInteger,
                  let expectedHex = bundle.field("expectedMessageHex")?.asText
            else {
                XCTFail("音声束の欄が読めない")
                return
            }
            XCTAssertEqual(Int64(payloads.count), unitsPerMessage, "束ねる数が規範どおりである")

            var units: [WhesoUnit] = []
            for (offset, payload) in payloads.enumerated() {
                guard let hex = payload.asText, let bytes = hexToBytes(hex) else {
                    XCTFail("音声のペイロードが読めない")
                    return
                }
                let position = Int64(index) * unitsPerMessage + Int64(offset)
                units.append(WhesoUnit(
                    sequenceNumber: UInt32(truncatingIfNeeded: first + Int64(offset)),
                    captureTimestampUs: UInt64(truncatingIfNeeded: position * frameMs * 1000),
                    flags: UInt8(truncatingIfNeeded: flags),
                    spatialId: 0,
                    temporalId: 0,
                    payload: bytes
                ))
            }
            let message = WhesoMediaMessage(
                channel: UInt8(truncatingIfNeeded: channel),
                senderId: UInt32(truncatingIfNeeded: senderId),
                units: units
            )
            guard case .success(let encoded) = whesoEncodeMediaMessage(message) else {
                XCTFail("音声束 \(index) を符号化できる")
                return
            }
            XCTAssertEqual(bytesToHex(encoded), expectedHex, "音声束 \(index) のバイト列が資産と一致する")

            guard case .success(let decoded) = whesoDecodeMediaMessage(encoded) else {
                XCTFail("音声束 \(index) を復号できる")
                return
            }
            XCTAssertEqual(Int64(decoded.units.count), unitsPerMessage, "ユニット数が往復する")

            // 音声は決して破棄しない（規範）。
            XCTAssertNil(
                whesoDropPriority(
                    channel: UInt8(truncatingIfNeeded: channel),
                    flags: UInt8(truncatingIfNeeded: flags)
                ),
                "音声は破棄禁止である"
            )
            XCTAssertFalse(
                whesoComputeDiscardable(
                    channel: UInt8(truncatingIfNeeded: channel),
                    isKeyFrame: false,
                    temporalId: 0,
                    temporalLayerCount: 1
                ),
                "音声は破棄可能にならない"
            )
            checked += 1
        }
        XCTAssertGreaterThanOrEqual(checked, 20, "20 束以上を照合した")
    }
}
