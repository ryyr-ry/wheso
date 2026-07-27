// トレースベクタの照合（Swift、層 2: 決定同一）。
//
// 凍結トレース（spec/vectors/trace-shard.jsonl と trace-receiver.jsonl）を Swift の判断コアへ
// 流し、出力コマンド列が TypeScript の参照実装と**完全に一致**することを確かめる。
// 1 コマンドの相違も許さない（conformance.md 4.4）。
//
// 相違した場合はベクタではなく実装を直す（ADR-0012）。
//
// 動的型（Any）を使わない（lint-policy.md 1 節）。トレースは行ごとに構造が変わるため
// Decodable の固定構造では読めない。型付きの JSON 値を宣言して読む。

import Foundation
import XCTest

@testable import WhesoClient

/// 型付きの JSON 値。`Any` を使わずに可変構造を読むために宣言する。
indirect enum JsonValue: Decodable, Equatable {
    case object([String: JsonValue])
    case array([JsonValue])
    case integer(Int64)
    case text(String)
    case boolean(Bool)
    case null

    init(from decoder: Decoder) throws {
        if let container = try? decoder.container(keyedBy: DynamicKey.self) {
            var object: [String: JsonValue] = [:]
            for key in container.allKeys {
                object[key.stringValue] = try container.decode(JsonValue.self, forKey: key)
            }
            self = .object(object)
            return
        }
        if var container = try? decoder.unkeyedContainer() {
            var array: [JsonValue] = []
            while !container.isAtEnd {
                array.append(try container.decode(JsonValue.self))
            }
            self = .array(array)
            return
        }
        let single = try decoder.singleValueContainer()
        if single.decodeNil() {
            self = .null
            return
        }
        if let value = try? single.decode(Bool.self) {
            self = .boolean(value)
            return
        }
        if let value = try? single.decode(Int64.self) {
            self = .integer(value)
            return
        }
        if let value = try? single.decode(String.self) {
            self = .text(value)
            return
        }
        // 小数はトレースに現れない（整数のみを送る。ADR-0017）。現れた場合は誤りである。
        throw DecodingError.dataCorrupted(
            DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "整数・文字列・真偽値・null 以外が現れた")
        )
    }

    /// 連想配列の欄を読む。
    func field(_ name: String) -> JsonValue? {
        if case .object(let object) = self {
            return object[name]
        }
        return nil
    }

    var asInteger: Int64? {
        if case .integer(let value) = self {
            return value
        }
        return nil
    }

    var asText: String? {
        if case .text(let value) = self {
            return value
        }
        return nil
    }

    var asBool: Bool? {
        if case .boolean(let value) = self {
            return value
        }
        return nil
    }

    var asArray: [JsonValue]? {
        if case .array(let value) = self {
            return value
        }
        return nil
    }

    var isNull: Bool {
        self == .null
    }
}

/// 任意の欄名を受ける鍵。
struct DynamicKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil

    init?(stringValue: String) {
        self.stringValue = stringValue
    }

    init?(intValue: Int) {
        return nil
    }
}

final class TraceTests: XCTestCase {
    /// 生成器（tools/traces-receiver.ts）と一致させる初期予算。
    private let initialReceiverBudget: Int64 = 7_000_000

    private func traceLines(_ name: String) throws -> [String] {
        let here = URL(fileURLWithPath: #filePath)
        let root = here
            .deletingLastPathComponent()  // TraceTests.swift を落とす
            .deletingLastPathComponent()  // WhesoClientTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // swift
            .deletingLastPathComponent()  // sdks
        let path = root.appendingPathComponent("spec/vectors/\(name)")
        let text = try String(contentsOf: path, encoding: .utf8)
        return text.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
    }

    private func parse(_ line: String) throws -> JsonValue {
        guard let data = line.data(using: .utf8) else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "UTF-8 として読めない")
            )
        }
        return try JSONDecoder().decode(JsonValue.self, from: data)
    }

    // MARK: - 中継ノード

    private func toShardEvent(_ input: JsonValue) -> WhesoShardEvent? {
        guard let kind = input.field("kind")?.asText else {
            return nil
        }
        switch kind {
        case "media":
            guard let from = input.field("from")?.asInteger,
                  let ch = input.field("ch")?.asInteger,
                  let sid = input.field("sid")?.asInteger,
                  let tid = input.field("tid")?.asInteger,
                  let bytes = input.field("bytes")?.asInteger,
                  let flags = input.field("flags")?.asInteger
            else {
                return nil
            }
            return .media(
                from: from,
                ch: ch,
                sid: sid,
                tid: tid,
                key: input.field("key")?.asBool ?? false,
                bytes: bytes,
                flags: flags
            )
        case "subscribe":
            guard let from = input.field("from")?.asInteger,
                  let to = input.field("to")?.asInteger,
                  let want = input.field("want")?.asBool,
                  let maxSpatialId = input.field("maxSpatialId")?.asInteger
            else {
                return nil
            }
            return .subscribe(from: from, to: to, want: want, maxSpatialId: maxSpatialId)
        case "join":
            guard let id = input.field("id")?.asInteger else {
                return nil
            }
            return .join(id: id)
        case "leave":
            guard let id = input.field("id")?.asInteger else {
                return nil
            }
            return .leave(id: id)
        case "link":
            return .link(
                peer: input.field("peer")?.asInteger ?? 0,
                state: input.field("state")?.asText ?? ""
            )
        case "timer":
            return .timer
        case "budget":
            guard let bytesPerSec = input.field("bytesPerSec")?.asInteger else {
                return nil
            }
            return .budget(bytesPerSec: bytesPerSec)
        case "report":
            guard let from = input.field("from")?.asInteger,
                  let samples = input.field("delayUs")?.asArray
            else {
                return nil
            }
            var delayUs: [Int64] = []
            for sample in samples {
                guard let value = sample.asInteger else {
                    return nil
                }
                delayUs.append(value)
            }
            return .report(from: from, delayUs: delayUs)
        default:
            return nil
        }
    }

    /// 出力コマンドを TypeScript と同じ JSON 表現へ写す。欄名も一致させる。
    private func toJson(_ command: WhesoShardCommand) -> JsonValue {
        switch command {
        case .forward(let to):
            return .object(["kind": .text("forward"), "to": .array(to.map { .integer($0) })])
        case .drop(let priority, let count):
            return .object([
                "kind": .text("drop"),
                "priority": .integer(priority),
                "count": .integer(count),
            ])
        case .notify(let code):
            return .object(["kind": .text("notify"), "code": .integer(code)])
        case .setTier(let targetId, let tier):
            return .object([
                "kind": .text("setTier"),
                "for": .integer(targetId),
                "tier": .integer(tier),
            ])
        }
    }

    func testFrozenShardTraceMatchesTypescriptReference() throws {
        let lines = try traceLines("trace-shard.jsonl")
        XCTAssertGreaterThan(lines.count, 100, "トレースが十分な行数を持つ")

        let header = try parse(lines[0])
        XCTAssertEqual(header.field("unit")?.asText, "shard", "中継ノードのトレースである")

        var state: WhesoShardState?
        var pending: JsonValue?
        var checked = 0

        for line in lines.dropFirst() {
            let row = try parse(line)
            if let input = row.field("in") {
                pending = input
                continue
            }
            guard let expected = row.field("out")?.asArray else {
                continue
            }
            guard let input = pending else {
                XCTFail("出力に対応する入力が無い")
                return
            }
            pending = nil
            guard let event = toShardEvent(input) else {
                XCTFail("入力を解釈できない: \(input)")
                return
            }
            guard let t = row.field("t")?.asInteger else {
                XCTFail("時刻が無い")
                return
            }
            // 初期状態の時刻はトレースの最初の t と一致させる必要がある。
            let current = state ?? whesoInitialShardState(t)
            let result = whesoShardStep(current, event, t)
            state = result.state
            let actual = result.commands.map(toJson)
            XCTAssertEqual(actual, expected, "入力 \(input) に対する出力が一致する")
            checked += 1
        }
        XCTAssertGreaterThan(checked, 100, "十分な行数を照合した（実際 \(checked)）")
    }

    // MARK: - 受信ノード

    private func toReceiverEvent(_ input: JsonValue) -> WhesoReceiverEvent? {
        guard let kind = input.field("kind")?.asText else {
            return nil
        }
        switch kind {
        case "subscribe":
            guard let raw = input.field("entries")?.asArray else {
                return nil
            }
            var entries: [WhesoSubscribeEntry] = []
            for element in raw {
                guard let senderId = element.field("senderId")?.asInteger,
                      let channel = element.field("channel")?.asInteger,
                      let maxSpatialId = element.field("maxSpatialId")?.asInteger,
                      let maxTemporalId = element.field("maxTemporalId")?.asInteger
                else {
                    return nil
                }
                entries.append(WhesoSubscribeEntry(
                    senderId: senderId,
                    channel: channel,
                    maxSpatialId: maxSpatialId,
                    maxTemporalId: maxTemporalId
                ))
            }
            return .subscribeList(entries: entries)
        case "leave":
            guard let id = input.field("id")?.asInteger else {
                return nil
            }
            return .leave(id: id)
        case "visibility":
            guard let visible = input.field("visible")?.asBool else {
                return nil
            }
            return .visibility(visible: visible)
        case "budget":
            guard let bytesPerSec = input.field("bytesPerSec")?.asInteger else {
                return nil
            }
            return .budget(bytesPerSec: bytesPerSec)
        case "activeSpeaker":
            // null は「発話者なし」を意味する。欄の欠落と区別する。
            guard let value = input.field("id") else {
                return nil
            }
            if value.isNull {
                return .activeSpeaker(id: nil)
            }
            guard let id = value.asInteger else {
                return nil
            }
            return .activeSpeaker(id: id)
        case "displaySize":
            guard let senderId = input.field("senderId")?.asInteger,
                  let channel = input.field("channel")?.asInteger,
                  let width = input.field("width")?.asInteger
            else {
                return nil
            }
            return .displaySize(senderId: senderId, channel: channel, width: width)
        case "report":
            guard let samples = input.field("delayUs")?.asArray else {
                return nil
            }
            var delayUs: [Int64] = []
            for sample in samples {
                guard let value = sample.asInteger else {
                    return nil
                }
                delayUs.append(value)
            }
            return .report(delayUs: delayUs)
        case "media":
            guard let from = input.field("from")?.asInteger,
                  let ch = input.field("ch")?.asInteger,
                  let sid = input.field("sid")?.asInteger,
                  let tid = input.field("tid")?.asInteger
            else {
                return nil
            }
            return .media(from: from, ch: ch, sid: sid, tid: tid, seq: input.field("seq")?.asInteger ?? 0)
        case "timer":
            return .timer
        default:
            return nil
        }
    }

    private func toJson(_ command: WhesoReceiverCommand) -> JsonValue {
        switch command {
        case .subscribeChange(let to, let channel, let want, let maxSpatialId, let maxTemporalId):
            return .object([
                "kind": .text("subscribeChange"),
                "to": .integer(to),
                "channel": .integer(channel),
                "want": .boolean(want),
                "maxSpatialId": .integer(maxSpatialId),
                "maxTemporalId": .integer(maxTemporalId),
            ])
        case .keyframeRequest(let targetId, let channel, let spatialId):
            return .object([
                "kind": .text("keyframeRequest"),
                "for": .integer(targetId),
                "channel": .integer(channel),
                "spatialId": .integer(spatialId),
            ])
        case .setTier(let targetId, let channel, let tier):
            return .object([
                "kind": .text("setTier"),
                "for": .integer(targetId),
                "channel": .integer(channel),
                "tier": .integer(tier),
            ])
        case .forward(let to):
            return .object(["kind": .text("forward"), "to": .array(to.map { .integer($0) })])
        case .drop(let priority, let count):
            return .object([
                "kind": .text("drop"),
                "priority": .integer(priority),
                "count": .integer(count),
            ])
        case .notify(let code):
            return .object(["kind": .text("notify"), "code": .text(code)])
        case .ack(let senderId, let channel, let spatialId, let highestSeq):
            return .object([
                "kind": .text("ack"),
                "senderId": .integer(senderId),
                "channel": .integer(channel),
                "spatialId": .integer(spatialId),
                "highestSeq": .integer(highestSeq),
            ])
        }
    }

    func testFrozenReceiverTraceMatchesTypescriptReference() throws {
        let lines = try traceLines("trace-receiver.jsonl")
        XCTAssertGreaterThan(lines.count, 100, "トレースが十分な行数を持つ")

        let header = try parse(lines[0])
        XCTAssertEqual(header.field("unit")?.asText, "receiver", "受信ノードのトレースである")

        var state = whesoInitialReceiverState(initialReceiverBudget)
        var pending: JsonValue?
        var checked = 0

        for line in lines.dropFirst() {
            let row = try parse(line)
            if let input = row.field("in") {
                pending = input
                continue
            }
            guard let expected = row.field("out")?.asArray else {
                continue
            }
            guard let input = pending else {
                XCTFail("出力に対応する入力が無い")
                return
            }
            pending = nil
            guard let event = toReceiverEvent(input) else {
                XCTFail("入力を解釈できない: \(input)")
                return
            }
            let result = whesoReceiverStep(state, event)
            state = result.state
            let actual = result.commands.map(toJson)
            XCTAssertEqual(actual, expected, "入力 \(input) に対する出力が一致する")
            checked += 1
        }
        XCTAssertGreaterThan(checked, 100, "十分な行数を照合した（実際 \(checked)）")
    }
}
