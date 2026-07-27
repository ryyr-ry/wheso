// ワイヤフォーマットの実装（Dart）。
//
// 規範: wire-format.md 1 節（バイト配置）と 1.4（破棄優先順位）。
// TypeScript の参照実装とバイト単位で一致しなければならない（conformance.md 2 節の層 1）。
//
// 例外を投げない。範囲外の添字アクセスをしない。

import 'dart:typed_data';

import 'generated/wire_layout.dart' as layout;

/// ワイヤ形式の失敗。規範のエラー名を持つ。
enum WireErrorKind {
  magic,
  version,
  channel,
  unitCount,
  senderId,
  lengthMismatch,
  payloadEmpty,
  tooLarge,
  unitOrder,
  fieldRange,
}

/// 規範のエラー名。TypeScript 側の文字列と一致させる。
String wireErrorName(WireErrorKind kind) {
  switch (kind) {
    case WireErrorKind.magic:
      return 'E_WIRE_MAGIC';
    case WireErrorKind.version:
      return 'E_WIRE_VERSION';
    case WireErrorKind.channel:
      return 'E_WIRE_CHANNEL';
    case WireErrorKind.unitCount:
      return 'E_WIRE_UNIT_COUNT';
    case WireErrorKind.senderId:
      return 'E_WIRE_SENDER_ID';
    case WireErrorKind.lengthMismatch:
      return 'E_WIRE_LENGTH_MISMATCH';
    case WireErrorKind.payloadEmpty:
      return 'E_WIRE_PAYLOAD_EMPTY';
    case WireErrorKind.tooLarge:
      return 'E_WIRE_TOO_LARGE';
    case WireErrorKind.unitOrder:
      return 'E_WIRE_UNIT_ORDER';
    case WireErrorKind.fieldRange:
      return 'E_WIRE_FIELD_RANGE';
  }
}

/// 成功か失敗のどちらかを表す。
class WireResult<T> {
  const WireResult.ok(this.value)
      : isOk = true,
        error = null;
  const WireResult.err(this.error)
      : isOk = false,
        value = null;

  final bool isOk;
  final T? value;
  final WireErrorKind? error;
}

class Unit {
  const Unit({
    required this.sequenceNumber,
    required this.captureTimestampUs,
    required this.flags,
    required this.spatialId,
    required this.temporalId,
    required this.payload,
  });

  final int sequenceNumber;
  final int captureTimestampUs;
  final int flags;
  final int spatialId;
  final int temporalId;
  final Uint8List payload;
}

class MediaMessage {
  const MediaMessage({required this.channel, required this.senderId, required this.units});

  final int channel;
  final int senderId;
  final List<Unit> units;
}

bool _isAudio(int channel) =>
    channel == layout.CHANNEL_AUDIO || channel == layout.CHANNEL_SCREEN_AUDIO;

bool _knownChannel(int channel) => channel >= 1 && channel <= 4;

/// メディアメッセージを符号化する。
WireResult<Uint8List> encodeMediaMessage(MediaMessage message) {
  if (!_knownChannel(message.channel)) {
    return const WireResult.err(WireErrorKind.channel);
  }
  if (message.senderId == 0) {
    return const WireResult.err(WireErrorKind.senderId);
  }
  if (message.units.isEmpty || message.units.length > layout.MAX_UNITS_PER_MESSAGE) {
    return const WireResult.err(WireErrorKind.unitCount);
  }
  // 映像は常に 1 ユニットである（wire-format.md 1.5）。
  if (!_isAudio(message.channel) && message.units.length != 1) {
    return const WireResult.err(WireErrorKind.unitCount);
  }

  var total = layout.MESSAGE_HEADER_BYTES;
  int? previous;
  for (final unit in message.units) {
    if (unit.payload.isEmpty) {
      return const WireResult.err(WireErrorKind.payloadEmpty);
    }
    if (unit.spatialId > 3 || unit.temporalId > 7) {
      return const WireResult.err(WireErrorKind.fieldRange);
    }
    if (previous != null && unit.sequenceNumber <= previous) {
      return const WireResult.err(WireErrorKind.unitOrder);
    }
    previous = unit.sequenceNumber;
    total += layout.UNIT_HEADER_BYTES + unit.payload.length;
  }
  if (total > layout.MAX_MESSAGE_BYTES) {
    return const WireResult.err(WireErrorKind.tooLarge);
  }

  final bytes = Uint8List(total);
  final view = ByteData.view(bytes.buffer);
  bytes[0] = layout.WIRE_MAGIC;
  bytes[1] = layout.PROTOCOL_VERSION;
  bytes[2] = message.channel;
  bytes[3] = message.units.length;
  view.setUint32(4, message.senderId);
  var offset = layout.MESSAGE_HEADER_BYTES;
  for (final unit in message.units) {
    view.setUint32(offset, unit.sequenceNumber);
    view.setUint64(offset + 4, unit.captureTimestampUs);
    bytes[offset + 12] = unit.flags;
    bytes[offset + 13] = unit.spatialId;
    bytes[offset + 14] = unit.temporalId;
    bytes[offset + 15] = 0; // reserved
    view.setUint32(offset + 16, unit.payload.length);
    bytes.setRange(offset + layout.UNIT_HEADER_BYTES, offset + layout.UNIT_HEADER_BYTES + unit.payload.length,
        unit.payload);
    offset += layout.UNIT_HEADER_BYTES + unit.payload.length;
  }
  return WireResult.ok(bytes);
}

/// メディアメッセージを復号する。
WireResult<MediaMessage> decodeMediaMessage(Uint8List bytes) {
  if (bytes.length < layout.MESSAGE_HEADER_BYTES) {
    return const WireResult.err(WireErrorKind.lengthMismatch);
  }
  if (bytes[0] != layout.WIRE_MAGIC) {
    return const WireResult.err(WireErrorKind.magic);
  }
  if (bytes[1] != layout.PROTOCOL_VERSION) {
    return const WireResult.err(WireErrorKind.version);
  }
  final channel = bytes[2];
  if (!_knownChannel(channel)) {
    return const WireResult.err(WireErrorKind.channel);
  }
  final unitCount = bytes[3];
  if (unitCount == 0) {
    return const WireResult.err(WireErrorKind.unitCount);
  }
  if (!_isAudio(channel) && unitCount != 1) {
    return const WireResult.err(WireErrorKind.unitCount);
  }
  final view = ByteData.view(bytes.buffer, bytes.offsetInBytes, bytes.length);
  final senderId = view.getUint32(4);
  if (senderId == 0) {
    return const WireResult.err(WireErrorKind.senderId);
  }

  final units = <Unit>[];
  var offset = layout.MESSAGE_HEADER_BYTES;
  int? previous;
  for (var index = 0; index < unitCount; index += 1) {
    if (offset + layout.UNIT_HEADER_BYTES > bytes.length) {
      return const WireResult.err(WireErrorKind.lengthMismatch);
    }
    final sequenceNumber = view.getUint32(offset);
    final timestamp = view.getUint64(offset + 4);
    final flags = bytes[offset + 12];
    final spatialId = bytes[offset + 13];
    final temporalId = bytes[offset + 14];
    if (spatialId > 3 || temporalId > 7) {
      return const WireResult.err(WireErrorKind.fieldRange);
    }
    final payloadLength = view.getUint32(offset + 16);
    if (payloadLength == 0) {
      return const WireResult.err(WireErrorKind.payloadEmpty);
    }
    final payloadStart = offset + layout.UNIT_HEADER_BYTES;
    final payloadEnd = payloadStart + payloadLength;
    if (payloadEnd > bytes.length) {
      return const WireResult.err(WireErrorKind.lengthMismatch);
    }
    if (previous != null && sequenceNumber <= previous) {
      return const WireResult.err(WireErrorKind.unitOrder);
    }
    previous = sequenceNumber;
    units.add(Unit(
      sequenceNumber: sequenceNumber,
      captureTimestampUs: timestamp,
      flags: flags,
      spatialId: spatialId,
      temporalId: temporalId,
      payload: Uint8List.fromList(bytes.sublist(payloadStart, payloadEnd)),
    ));
    offset = payloadEnd;
  }
  if (offset != bytes.length) {
    return const WireResult.err(WireErrorKind.lengthMismatch);
  }
  return WireResult.ok(MediaMessage(channel: channel, senderId: senderId, units: units));
}

/// 破棄優先順位。wire-format.md 1.4 の判定順序をそのまま実装する。
/// null は破棄禁止を意味する。
int? dropPriority(int channel, int flags) {
  if (_isAudio(channel)) {
    return null;
  }
  if ((flags & layout.FLAG_KEY) != 0) {
    return null;
  }
  final discardable = (flags & layout.FLAG_DISCARDABLE) != 0;
  final screen = (flags & layout.FLAG_SCREEN_CONTENT) != 0;
  final speaker = (flags & layout.FLAG_ACTIVE_SPEAKER) != 0;
  if (discardable && screen) {
    return 3;
  }
  if (discardable && speaker) {
    return 2;
  }
  if (discardable) {
    return 1;
  }
  if (speaker) {
    return 5;
  }
  return 4;
}

/// DISCARDABLE の算出。独自判断を書かず規範の規則をそのまま実装する。
bool computeDiscardable(int channel, bool isKeyFrame, int temporalId, int temporalLayerCount) {
  if (_isAudio(channel)) {
    return false;
  }
  if (isKeyFrame) {
    return false;
  }
  if (temporalLayerCount <= 1) {
    return false;
  }
  return temporalId == temporalLayerCount - 1;
}
