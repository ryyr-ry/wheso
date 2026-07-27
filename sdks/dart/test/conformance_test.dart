// 適合試験（Dart、段 A）。
//
// 凍結ベクタ（spec/vectors）に対して TypeScript の参照実装と同一の結果を出すことを確かめる。
// ベクタを実装に合わせて変更してはならない。実装を直す（ADR-0012）。
//
// 実行: dart test（sdks/dart で）
//
// 動的型（dynamic）を使わない（lint-policy.md 1 節）。JSON は Object? で受け、
// `is` による実行時検査で絞る（原則 2: 外部入力は未知の型で受け取り実行時に検査する）。
// 欠損したフィールドを既定値へ落とさない。落とすとベクタの取り違えを検出できない。

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:test/test.dart';
import 'package:wheso_client/src/fixed.dart';
import 'package:wheso_client/src/wire.dart';

/// 凍結ベクタの位置。リポジトリ直下の spec/vectors を参照する。
Object? readVector(String name) {
  final file = File('../../spec/vectors/$name');
  final text = file.readAsStringSync();
  return jsonDecode(text);
}

/// 配列として読む。配列でなければ試験を失敗させる。
List<Object?> readList(Object? value, String where) {
  if (value is List<Object?>) {
    return value;
  }
  throw StateError('$where: 配列ではない');
}

/// 連想配列として読む。
Map<String, Object?> readMap(Object? value, String where) {
  if (value is Map<String, Object?>) {
    return value;
  }
  throw StateError('$where: 連想配列ではない');
}

/// 整数として読む。欠損や型違いは失敗させる。
int readInt(Map<String, Object?> map, String key, String where) {
  final value = map[key];
  if (value is int) {
    return value;
  }
  throw StateError('$where: $key が整数ではない');
}

/// null を許す整数として読む。キーの欠落は失敗させる。
int? readNullableInt(Map<String, Object?> map, String key, String where) {
  if (!map.containsKey(key)) {
    throw StateError('$where: $key が無い');
  }
  final value = map[key];
  if (value == null) {
    return null;
  }
  if (value is int) {
    return value;
  }
  throw StateError('$where: $key が整数でも null でもない');
}

/// 文字列として読む。
String readString(Map<String, Object?> map, String key, String where) {
  final value = map[key];
  if (value is String) {
    return value;
  }
  throw StateError('$where: $key が文字列ではない');
}

/// 64 bit の符号なし整数を、同じビット列の符号付き整数として読む。
int readUnsigned64(Map<String, Object?> map, String key, String where) {
  return BigInt.parse(readString(map, key, where)).toSigned(64).toInt();
}

Uint8List hexToBytes(String hex) {
  if (hex.length % 2 != 0) {
    throw StateError('16 進の長さが偶数ではない');
  }
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

void main() {
  test('擬似乱数が凍結ベクタと一致する', () {
    final root = readMap(readVector('prng.json'), 'prng.json');
    final vectors = readList(root['vectors'], 'prng.json vectors');
    expect(vectors, isNotEmpty);
    for (final rawEntry in vectors) {
      final entry = readMap(rawEntry, 'prng ベクタ');
      // 64 bit の符号なし整数は Dart の int（64 bit 符号付き）と同じビット列で扱う。
      final seed = readUnsigned64(entry, 'seed', 'prng ベクタ');
      final created = createPrng(seed);
      if (seed == 0) {
        expect(created.isOk, isFalse, reason: '種 0 は失敗する');
        continue;
      }
      expect(created.isOk, isTrue);
      var state = created.value!;
      final outputs = readList(entry['outputs'], 'prng outputs');
      expect(outputs, isNotEmpty);
      for (final rawExpected in outputs) {
        if (rawExpected is! String) {
          throw StateError('prng outputs: 文字列ではない');
        }
        final stepped = prngNext(state);
        expect(stepped.isOk, isTrue);
        state = stepped.value!.state;
        final expectedValue = BigInt.parse(rawExpected).toSigned(64).toInt();
        expect(stepped.value!.output, equals(expectedValue), reason: '出力が一致する');
      }
    }
  });

  test('メディアベクタが符号化・復号で一致する', () {
    final entries = readList(readVector('media.json'), 'media.json');
    expect(entries, isNotEmpty);
    for (final rawEntry in entries) {
      final entry = readMap(rawEntry, 'media ベクタ');
      final name = readString(entry, 'name', 'media ベクタ');
      final expectedHex = readString(entry, 'bytesHex', name);
      final message = readMap(entry['message'], '$name message');
      final units = <Unit>[];
      for (final rawUnit in readList(message['units'], '$name units')) {
        final unit = readMap(rawUnit, '$name unit');
        units.add(Unit(
          sequenceNumber: readInt(unit, 'sequenceNumber', name),
          captureTimestampUs: readUnsigned64(unit, 'captureTimestampUs', name),
          flags: readInt(unit, 'flags', name),
          spatialId: readInt(unit, 'spatialId', name),
          temporalId: readInt(unit, 'temporalId', name),
          payload: hexToBytes(readString(unit, 'payloadHex', name)),
        ));
      }
      final built = MediaMessage(
        channel: readInt(message, 'channel', name),
        senderId: readInt(message, 'senderId', name),
        units: units,
      );
      final encoded = encodeMediaMessage(built);
      expect(encoded.isOk, isTrue, reason: '符号化できる');
      expect(bytesToHex(encoded.value!), equals(expectedHex), reason: '$name: バイト列が一致する');

      final decoded = decodeMediaMessage(hexToBytes(expectedHex));
      expect(decoded.isOk, isTrue, reason: '復号できる');
      expect(decoded.value!.channel, equals(built.channel));
      expect(decoded.value!.senderId, equals(built.senderId));
      expect(decoded.value!.units.length, equals(built.units.length));
      for (var index = 0; index < built.units.length; index += 1) {
        expect(decoded.value!.units[index].sequenceNumber, equals(built.units[index].sequenceNumber));
        expect(decoded.value!.units[index].captureTimestampUs, equals(built.units[index].captureTimestampUs));
        expect(decoded.value!.units[index].payload, equals(built.units[index].payload));
      }
    }
  });

  test('不正なベクタが同じエラー名で拒否される', () {
    final entries = readList(readVector('invalid.json'), 'invalid.json');
    expect(entries, isNotEmpty);
    for (final rawEntry in entries) {
      final entry = readMap(rawEntry, 'invalid ベクタ');
      final name = readString(entry, 'name', 'invalid ベクタ');
      final bytes = hexToBytes(readString(entry, 'bytesHex', name));
      final decoded = decodeMediaMessage(bytes);
      expect(decoded.isOk, isFalse, reason: '$name: 受理しない');
      expect(wireErrorName(decoded.error!),
          equals(readString(entry, 'expectedErrorCode', name)),
          reason: '$name: 同じエラー');
    }
  });

  test('破棄順位が凍結ベクタと一致する', () {
    final entries = readList(readVector('drop-order.json'), 'drop-order.json');
    expect(entries, isNotEmpty);
    for (final rawEntry in entries) {
      final entry = readMap(rawEntry, 'drop ベクタ');
      final name = readString(entry, 'name', 'drop ベクタ');
      final actual = dropPriority(readInt(entry, 'channel', name), readInt(entry, 'flags', name));
      expect(actual, equals(readNullableInt(entry, 'expectedPriority', name)), reason: name);
    }
  });

  test('勾配と閾値が規範どおりである', () {
    final rising = <int>[];
    final flat = <int>[];
    final falling = <int>[];
    for (var index = 0; index < 20; index += 1) {
      rising.add(10000 + index * 1000);
      flat.add(10000);
      falling.add(30000 - index * 1000);
    }
    expect(delaySlope(rising).numerator > 0, isTrue);
    expect(delaySlope(flat).numerator, equals(0));
    expect(delaySlope(falling).numerator < 0, isTrue);
    expect(delaySlope(rising).denominator > 0, isTrue, reason: '分母は常に正');
    expect(isDegrading(delaySlope(rising)), isTrue);
    expect(isDegrading(delaySlope(flat)), isFalse);
    expect(isRecovering(delaySlope(falling)), isTrue);
  });

  test('DISCARDABLE と整数除算が規範どおりである', () {
    expect(computeDiscardable(2, false, 0, 1), isFalse, reason: '音声は false');
    expect(computeDiscardable(1, true, 0, 3), isFalse, reason: 'キーは false');
    expect(computeDiscardable(1, false, 1, 3), isFalse, reason: '最上位でない層は false');
    expect(computeDiscardable(1, false, 2, 3), isTrue, reason: '最上位の層は true');

    expect(truncDiv(10, 3).value, equals(3));
    expect(truncDiv(-10, 3).value, equals(-3));
    expect(truncDiv(10, 0).isOk, isFalse);
    expect(truncDiv(9007199254740993, 3).isOk, isFalse);
  });
}
