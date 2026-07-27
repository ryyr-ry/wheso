// ワイヤフォーマットの実装（Swift）。
//
// 規範: wire-format.md 1 節（バイト配置）と 1.4（破棄優先順位）。
// TypeScript の参照実装とバイト単位で一致しなければならない（conformance.md 2 節の層 1）。
//
// 例外を投げない。範囲外の添字アクセスをしない。

public enum WhesoWireError: Error, Equatable {
    case magic
    case version
    case channel
    case unitCount
    case senderId
    case lengthMismatch
    case payloadEmpty
    case tooLarge
    case unitOrder
    case fieldRange

    /// 規範のエラー名。TypeScript 側の文字列と一致させる。
    public var name: String {
        switch self {
        case .magic: return "E_WIRE_MAGIC"
        case .version: return "E_WIRE_VERSION"
        case .channel: return "E_WIRE_CHANNEL"
        case .unitCount: return "E_WIRE_UNIT_COUNT"
        case .senderId: return "E_WIRE_SENDER_ID"
        case .lengthMismatch: return "E_WIRE_LENGTH_MISMATCH"
        case .payloadEmpty: return "E_WIRE_PAYLOAD_EMPTY"
        case .tooLarge: return "E_WIRE_TOO_LARGE"
        case .unitOrder: return "E_WIRE_UNIT_ORDER"
        case .fieldRange: return "E_WIRE_FIELD_RANGE"
        }
    }
}

public struct WhesoUnit: Equatable {
    public let sequenceNumber: UInt32
    public let captureTimestampUs: UInt64
    public let flags: UInt8
    public let spatialId: UInt8
    public let temporalId: UInt8
    public let payload: [UInt8]

    public init(
        sequenceNumber: UInt32,
        captureTimestampUs: UInt64,
        flags: UInt8,
        spatialId: UInt8,
        temporalId: UInt8,
        payload: [UInt8]
    ) {
        self.sequenceNumber = sequenceNumber
        self.captureTimestampUs = captureTimestampUs
        self.flags = flags
        self.spatialId = spatialId
        self.temporalId = temporalId
        self.payload = payload
    }
}

public struct WhesoMediaMessage: Equatable {
    public let channel: UInt8
    public let senderId: UInt32
    public let units: [WhesoUnit]

    public init(channel: UInt8, senderId: UInt32, units: [WhesoUnit]) {
        self.channel = channel
        self.senderId = senderId
        self.units = units
    }
}

private func isAudioChannel(_ channel: UInt8) -> Bool {
    channel == WhesoWireLayout.CHANNEL_AUDIO || channel == WhesoWireLayout.CHANNEL_SCREEN_AUDIO
}

private func knownChannel(_ channel: UInt8) -> Bool {
    channel >= 1 && channel <= 4
}

private func appendBigEndian32(_ bytes: inout [UInt8], _ value: UInt32) {
    bytes.append(UInt8(truncatingIfNeeded: value >> 24))
    bytes.append(UInt8(truncatingIfNeeded: value >> 16))
    bytes.append(UInt8(truncatingIfNeeded: value >> 8))
    bytes.append(UInt8(truncatingIfNeeded: value))
}

private func appendBigEndian64(_ bytes: inout [UInt8], _ value: UInt64) {
    var shift = 56
    while shift >= 0 {
        bytes.append(UInt8(truncatingIfNeeded: value >> UInt64(shift)))
        shift -= 8
    }
}

private func readBigEndian32(_ bytes: [UInt8], _ offset: Int) -> UInt32? {
    if offset + 4 > bytes.count {
        return nil
    }
    var value: UInt32 = 0
    for index in 0..<4 {
        value = (value << 8) | UInt32(bytes[offset + index])
    }
    return value
}

private func readBigEndian64(_ bytes: [UInt8], _ offset: Int) -> UInt64? {
    if offset + 8 > bytes.count {
        return nil
    }
    var value: UInt64 = 0
    for index in 0..<8 {
        value = (value << 8) | UInt64(bytes[offset + index])
    }
    return value
}

/// メディアメッセージを符号化する。
public func whesoEncodeMediaMessage(_ message: WhesoMediaMessage) -> Result<[UInt8], WhesoWireError> {
    if !knownChannel(message.channel) {
        return .failure(.channel)
    }
    if message.senderId == 0 {
        return .failure(.senderId)
    }
    if message.units.isEmpty || message.units.count > WhesoWireLayout.MAX_UNITS_PER_MESSAGE {
        return .failure(.unitCount)
    }
    // 映像は常に 1 ユニットである（wire-format.md 1.5）。
    if !isAudioChannel(message.channel) && message.units.count != 1 {
        return .failure(.unitCount)
    }

    var total = WhesoWireLayout.MESSAGE_HEADER_BYTES
    var previous: UInt32?
    for unit in message.units {
        if unit.payload.isEmpty {
            return .failure(.payloadEmpty)
        }
        if unit.spatialId > 3 || unit.temporalId > 7 {
            return .failure(.fieldRange)
        }
        if let last = previous, unit.sequenceNumber <= last {
            return .failure(.unitOrder)
        }
        previous = unit.sequenceNumber
        total += WhesoWireLayout.UNIT_HEADER_BYTES + unit.payload.count
    }
    if total > WhesoWireLayout.MAX_MESSAGE_BYTES {
        return .failure(.tooLarge)
    }

    var bytes: [UInt8] = []
    bytes.reserveCapacity(total)
    bytes.append(WhesoWireLayout.WIRE_MAGIC)
    bytes.append(WhesoWireLayout.PROTOCOL_VERSION)
    bytes.append(message.channel)
    bytes.append(UInt8(truncatingIfNeeded: message.units.count))
    appendBigEndian32(&bytes, message.senderId)
    for unit in message.units {
        appendBigEndian32(&bytes, unit.sequenceNumber)
        appendBigEndian64(&bytes, unit.captureTimestampUs)
        bytes.append(unit.flags)
        bytes.append(unit.spatialId)
        bytes.append(unit.temporalId)
        bytes.append(0)  // reserved
        appendBigEndian32(&bytes, UInt32(truncatingIfNeeded: unit.payload.count))
        bytes.append(contentsOf: unit.payload)
    }
    return .success(bytes)
}

/// メディアメッセージを復号する。
public func whesoDecodeMediaMessage(_ bytes: [UInt8]) -> Result<WhesoMediaMessage, WhesoWireError> {
    if bytes.count < WhesoWireLayout.MESSAGE_HEADER_BYTES {
        return .failure(.lengthMismatch)
    }
    if bytes[0] != WhesoWireLayout.WIRE_MAGIC {
        return .failure(.magic)
    }
    if bytes[1] != WhesoWireLayout.PROTOCOL_VERSION {
        return .failure(.version)
    }
    let channel = bytes[2]
    if !knownChannel(channel) {
        return .failure(.channel)
    }
    let unitCount = Int(bytes[3])
    if unitCount == 0 {
        return .failure(.unitCount)
    }
    if !isAudioChannel(channel) && unitCount != 1 {
        return .failure(.unitCount)
    }
    guard let senderId = readBigEndian32(bytes, 4) else {
        return .failure(.lengthMismatch)
    }
    if senderId == 0 {
        return .failure(.senderId)
    }

    var units: [WhesoUnit] = []
    var offset = WhesoWireLayout.MESSAGE_HEADER_BYTES
    var previous: UInt32?
    for _ in 0..<unitCount {
        if offset + WhesoWireLayout.UNIT_HEADER_BYTES > bytes.count {
            return .failure(.lengthMismatch)
        }
        guard let sequenceNumber = readBigEndian32(bytes, offset),
              let timestamp = readBigEndian64(bytes, offset + 4),
              let payloadLength = readBigEndian32(bytes, offset + 16)
        else {
            return .failure(.lengthMismatch)
        }
        let flags = bytes[offset + 12]
        let spatialId = bytes[offset + 13]
        let temporalId = bytes[offset + 14]
        if spatialId > 3 || temporalId > 7 {
            return .failure(.fieldRange)
        }
        if payloadLength == 0 {
            return .failure(.payloadEmpty)
        }
        let payloadStart = offset + WhesoWireLayout.UNIT_HEADER_BYTES
        let payloadEnd = payloadStart + Int(payloadLength)
        if payloadEnd > bytes.count {
            return .failure(.lengthMismatch)
        }
        if let last = previous, sequenceNumber <= last {
            return .failure(.unitOrder)
        }
        previous = sequenceNumber
        units.append(
            WhesoUnit(
                sequenceNumber: sequenceNumber,
                captureTimestampUs: timestamp,
                flags: flags,
                spatialId: spatialId,
                temporalId: temporalId,
                payload: Array(bytes[payloadStart..<payloadEnd])
            )
        )
        offset = payloadEnd
    }
    if offset != bytes.count {
        return .failure(.lengthMismatch)
    }
    return .success(WhesoMediaMessage(channel: channel, senderId: senderId, units: units))
}

/// 破棄優先順位。wire-format.md 1.4 の判定順序をそのまま実装する。
/// nil は破棄禁止を意味する。
public func whesoDropPriority(channel: UInt8, flags: UInt8) -> UInt8? {
    if isAudioChannel(channel) {
        return nil
    }
    if flags & WhesoWireLayout.FLAG_KEY != 0 {
        return nil
    }
    let discardable = flags & WhesoWireLayout.FLAG_DISCARDABLE != 0
    let screen = flags & WhesoWireLayout.FLAG_SCREEN_CONTENT != 0
    let speaker = flags & WhesoWireLayout.FLAG_ACTIVE_SPEAKER != 0
    if discardable && screen {
        return 3
    }
    if discardable && speaker {
        return 2
    }
    if discardable {
        return 1
    }
    if speaker {
        return 5
    }
    return 4
}

/// DISCARDABLE の算出。独自判断を書かず規範の規則をそのまま実装する。
public func whesoComputeDiscardable(
    channel: UInt8,
    isKeyFrame: Bool,
    temporalId: UInt8,
    temporalLayerCount: UInt8
) -> Bool {
    if isAudioChannel(channel) {
        return false
    }
    if isKeyFrame {
        return false
    }
    if temporalLayerCount <= 1 {
        return false
    }
    return temporalId == temporalLayerCount - 1
}
