// 適合試験（Dart、段 A）。
//
// 凍結ベクタ（spec/vectors）に対して TypeScript の参照実装と同一の結果を出すことを確かめる。
// ベクタを実装に合わせて変更してはならない。実装を直す（ADR-0012）。
//
// 実行: dart test（sdks/dart で）

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:test/test.dart';
import 'package:wheso_client/src/fixed.dart';
import 'package:wheso_client/src/wire.dart';

/// 凍結ベクタの位置。リポジトリ直下の spec/vectors を参照する。
dynamic readVector(String name) {
  final file = File('../../spec/vectors/$name');
  final text = file.readAsStringSync();
  return jsonDecode(text);
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

void main() {
  test('擬似乱数が凍結ベクタと一致する', () {
    final root = readVector('prng.json');
    final vectors = root['vectors'] as List<dynamic>;
    expect(vectors, isNotEmpty);
    for (final entry in vectors) {
      final seedText = entry['seed'] as String;
      // 64 bit の符号なし整数は Dart の int（64 bit 符号付き）と同じビット列で扱う。
      final seed = BigInt.parse(seedText).toSigned(64).toInt();
      final created = createPrng(seed);
      if (seed == 0) {
        expect(created.isOk, isFalse, reason: '種 0 は失敗する');
        continue;
      }
      expect(created.isOk, isTrue);
      var state = created.value!;
      final outputs = entry['outputs'] as List<dynamic>;
      for (final expected in outputs) {
        final stepped = prngNext(state);
        expect(stepped.isOk, isTrue);
        state = stepped.value!.state;
        final expectedValue = BigInt.parse(expected as String).toSigned(64).toInt();
        expect(stepped.value!.output, equals(expectedValue), reason: '出力が一致する');
      }
    }
  });

  test('メディアベクタが符号化・復号で一致する', () {
    final entries = readVector('media.json') as List<dynamic>;
    expect(entries, isNotEmpty);
    for (final entry in entries) {
      final expectedHex = entry['bytesHex'] as String;
      final message = entry['message'] as Map<String, dynamic>;
      final units = <Unit>[];
      for (final unit in message['units'] as List<dynamic>) {
        units.add(Unit(
          sequenceNumber: unit['sequenceNumber'] as int,
          captureTimestampUs: BigInt.parse(unit['captureTimestampUs'] as String).toSigned(64).toInt(),
          flags: unit['flags'] as int,
          spatialId: unit['spatialId'] as int,
          temporalId: unit['temporalId'] as int,
          payload: hexToBytes(unit['payloadHex'] as String),
        ));
      }
      final built = MediaMessage(
        channel: message['channel'] as int,
        senderId: message['senderId'] as int,
        units: units,
      );
      final encoded = encodeMediaMessage(built);
      expect(encoded.isOk, isTrue, reason: '符号化できる');
      expect(bytesToHex(encoded.value!), equals(expectedHex), reason: '${entry['name']}: バイト列が一致する');

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
    final entries = readVector('invalid.json') as List<dynamic>;
    expect(entries, isNotEmpty);
    for (final entry in entries) {
      final bytes = hexToBytes(entry['bytesHex'] as String);
      final decoded = decodeMediaMessage(bytes);
      expect(decoded.isOk, isFalse, reason: '${entry['name']}: 受理しない');
      expect(wireErrorName(decoded.error!), equals(entry['expectedErrorCode'] as String),
          reason: '${entry['name']}: 同じエラー');
    }
  });

  test('破棄順位が凍結ベクタと一致する', () {
    final entries = readVector('drop-order.json') as List<dynamic>;
    expect(entries, isNotEmpty);
    for (final entry in entries) {
      final actual = dropPriority(entry['channel'] as int, entry['flags'] as int);
      expect(actual, equals(entry['expectedPriority']), reason: '${entry['name']}');
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
