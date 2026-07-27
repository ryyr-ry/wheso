// 実音声映像の照合（Dart、段 A の実データ版）。
//
// 合成したベクタではなく、**実際に符号化された AV1 と Opus**（spec/vectors/real-media.json）に
// 対して、ワイヤ形式の符号化・復号が往復で一致し、破棄可否と破棄優先順位の判断が
// 凍結資産と一致することを確かめる。同じ資産を 6 言語すべてが照合する。
//
// 資産を実装に合わせて変更してはならない（ADR-0012）。
// 動的型（dynamic）を使わない。JSON は Object? で受け、is で絞る。

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:test/test.dart';
import 'package:wheso_client/src/wire.dart';

Map<String, Object?> readMap(Object? value, String where) {
  if (value is Map<String, Object?>) {
    return value;
  }
  throw StateError('$where: 連想配列ではない');
}

List<Object?> readList(Object? value, String where) {
  if (value is List<Object?>) {
    return value;
  }
  throw StateError('$where: 配列ではない');
}

int readInt(Map<String, Object?> map, String key, String where) {
  final value = map[key];
  if (value is int) {
    return value;
  }
  throw StateError('$where: $key が整数ではない');
}

String readString(Map<String, Object?> map, String key, String where) {
  final value = map[key];
  if (value is String) {
    return value;
  }
  throw StateError('$where: $key が文字列ではない');
}

bool readBool(Map<String, Object?> map, String key, String where) {
  final value = map[key];
  if (value is bool) {
    return value;
  }
  throw StateError('$where: $key が真偽値ではない');
}

Uint8List hexToBytes(String hex) {
  final bytes = Uint8List(hex.length ~/ 2);
  for (var index = 0; index + 1 < hex.length; index += 2) {
    bytes[index ~/ 2] = int.parse(hex.substring(index, index + 2), radix: 16);
  }
  return bytes;
}

String bytesToHex(Uint8List bytes) {
  final builder = StringBuffer();
  for (final byte in bytes) {
    builder.write(byte.toRadixString(16).padLeft(2, '0'));
  }
  return builder.toString();
}

Map<String, Object?> readAsset() {
  final file = File('../../spec/vectors/real-media.json');
  return readMap(jsonDecode(file.readAsStringSync()), 'real-media.json');
}

void main() {
  test('実 AV1 のワイヤ符号化が資産と一致し、復号が往復する', () {
    final asset = readAsset();
    final senderId = readInt(asset, 'senderId', '資産');
    final video = readMap(asset['video'], 'video');
    final framerate = readInt(video, 'framerate', 'video');
    final channel = readInt(video, 'channel', 'video');
    final frames = readList(video['frames'], 'frames');
    expect(frames.length, greaterThanOrEqualTo(30), reason: '映像が 30 枚以上ある');

    var checked = 0;
    for (final raw in frames) {
      final frame = readMap(raw, 'frame');
      final sequenceNumber = readInt(frame, 'sequenceNumber', 'frame');
      final payloadHex = readString(frame, 'payloadHex', 'frame');
      final built = MediaMessage(
        channel: channel,
        senderId: senderId,
        units: <Unit>[
          Unit(
            sequenceNumber: sequenceNumber,
            captureTimestampUs: (sequenceNumber - 1) * 1000000 ~/ framerate,
            flags: readInt(frame, 'expectedFlags', 'frame'),
            spatialId: readInt(frame, 'spatialId', 'frame'),
            temporalId: readInt(frame, 'temporalId', 'frame'),
            payload: hexToBytes(payloadHex),
          ),
        ],
      );
      final encoded = encodeMediaMessage(built);
      expect(encoded.isOk, isTrue, reason: '符号化できる');
      final bytes = encoded.value;
      if (bytes == null) {
        throw StateError('符号化の結果が無い');
      }
      expect(bytesToHex(bytes), equals(readString(frame, 'expectedMessageHex', 'frame')),
          reason: '映像 $sequenceNumber のバイト列が資産と一致する');

      final decoded = decodeMediaMessage(bytes);
      expect(decoded.isOk, isTrue, reason: '復号できる');
      final message = decoded.value;
      if (message == null) {
        throw StateError('復号の結果が無い');
      }
      expect(bytesToHex(message.units[0].payload), equals(payloadHex), reason: 'ペイロードが往復する');
      checked += 1;
    }
    expect(checked, greaterThanOrEqualTo(30));
  });

  test('実 AV1 の破棄可否と破棄優先順位が資産と一致する', () {
    final asset = readAsset();
    final video = readMap(asset['video'], 'video');
    final channel = readInt(video, 'channel', 'video');
    final temporalLayers = readInt(video, 'temporalLayers', 'video');
    final frames = readList(video['frames'], 'frames');

    var discardableCount = 0;
    for (final raw in frames) {
      final frame = readMap(raw, 'frame');
      final discardable = computeDiscardable(
        channel,
        readBool(frame, 'keyFrame', 'frame'),
        readInt(frame, 'temporalId', 'frame'),
        temporalLayers,
      );
      expect(discardable, equals(readBool(frame, 'expectedDiscardable', 'frame')),
          reason: '破棄可否が資産と一致する');
      if (discardable) {
        discardableCount += 1;
      }
      final priority = dropPriority(channel, readInt(frame, 'expectedFlags', 'frame'));
      expect(priority, equals(frame['expectedDropPriority']), reason: '優先順位が資産と一致する');
    }
    // 最上位の時間層は破棄可能である。1 枚も無ければ判断を検証していない。
    expect(discardableCount, greaterThan(0), reason: '破棄可能なフレームがある');
  });

  test('実 Opus の束ねが資産と一致し、音声は破棄禁止である', () {
    final asset = readAsset();
    final senderId = readInt(asset, 'senderId', '資産');
    final audio = readMap(asset['audio'], 'audio');
    final frameMs = readInt(audio, 'frameMs', 'audio');
    final unitsPerMessage = readInt(audio, 'unitsPerMessage', 'audio');
    final channel = readInt(audio, 'channel', 'audio');
    final bundles = readList(audio['bundles'], 'bundles');
    expect(bundles.length, greaterThanOrEqualTo(20), reason: '音声束が 20 個以上ある');

    var checked = 0;
    for (var index = 0; index < bundles.length; index += 1) {
      final bundle = readMap(bundles[index], 'bundle');
      final payloads = readList(bundle['payloadsHex'], 'payloadsHex');
      expect(payloads.length, equals(unitsPerMessage), reason: '束ねる数が規範どおりである');
      final first = readInt(bundle, 'firstSequenceNumber', 'bundle');
      final flags = readInt(bundle, 'expectedFlags', 'bundle');

      final units = <Unit>[];
      for (var offset = 0; offset < payloads.length; offset += 1) {
        final payload = payloads[offset];
        if (payload is! String) {
          throw StateError('payloadsHex の要素が文字列ではない');
        }
        units.add(Unit(
          sequenceNumber: first + offset,
          captureTimestampUs: (index * unitsPerMessage + offset) * frameMs * 1000,
          flags: flags,
          spatialId: 0,
          temporalId: 0,
          payload: hexToBytes(payload),
        ));
      }
      final encoded = encodeMediaMessage(
        MediaMessage(channel: channel, senderId: senderId, units: units),
      );
      expect(encoded.isOk, isTrue, reason: '符号化できる');
      final bytes = encoded.value;
      if (bytes == null) {
        throw StateError('符号化の結果が無い');
      }
      expect(bytesToHex(bytes), equals(readString(bundle, 'expectedMessageHex', 'bundle')),
          reason: '音声束 $index のバイト列が資産と一致する');

      final decoded = decodeMediaMessage(bytes);
      expect(decoded.isOk, isTrue, reason: '復号できる');
      expect(decoded.value?.units.length, equals(unitsPerMessage), reason: 'ユニット数が往復する');

      // 音声は決して破棄しない（規範）。
      expect(dropPriority(channel, flags), isNull, reason: '音声は破棄禁止である');
      expect(computeDiscardable(channel, false, 0, 1), isFalse, reason: '音声は破棄可能にならない');
      checked += 1;
    }
    expect(checked, greaterThanOrEqualTo(20));
  });
}
