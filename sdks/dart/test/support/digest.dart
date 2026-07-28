// SHA-256 と HMAC-SHA256（Dart の試験用）。
//
// なぜ自前で持つか: ノード間認証の照合にしか要らないため、実行時依存（crypto パッケージ）を
// 増やさない（依存を持たない方針。ライセンス規範）。試験の中だけで持つ。
// 実装は FIPS 180-4 と RFC 2104 をそのまま写したものである。
//
// 正しさは既知の答え（RFC 4231）で確かめる（digest_test.dart）。確かめずに使うと、
// 疎通試験が失敗したときに原因が実装なのか手順なのか切り分けられない。
//
// Dart の int は 64 ビットであるため、32 ビットの演算では必ず 0xFFFFFFFF で切る。
// 切り忘れると上位に桁が残り、値が静かに壊れる。

import 'dart:convert';
import 'dart:typed_data';

const List<int> _roundConstants = <int>[
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

int _rotateRight(int value, int count) =>
    ((value >> count) | (value << (32 - count))) & 0xFFFFFFFF;

/// SHA-256（FIPS 180-4）。
Uint8List sha256Bytes(List<int> message) {
  final List<int> hash = <int>[
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  final List<int> padded = List<int>.from(message);
  final int bitLength = message.length * 8;
  padded.add(0x80);
  while (padded.length % 64 != 56) {
    padded.add(0);
  }
  for (int shift = 56; shift >= 0; shift -= 8) {
    padded.add((bitLength >> shift) & 0xFF);
  }

  final List<int> schedule = List<int>.filled(64, 0);
  for (int offset = 0; offset + 64 <= padded.length; offset += 64) {
    for (int index = 0; index < 16; index++) {
      final int base = offset + index * 4;
      schedule[index] = ((padded[base] << 24) |
              (padded[base + 1] << 16) |
              (padded[base + 2] << 8) |
              padded[base + 3]) &
          0xFFFFFFFF;
    }
    for (int index = 16; index < 64; index++) {
      final int previous15 = schedule[index - 15];
      final int previous2 = schedule[index - 2];
      final int s0 = _rotateRight(previous15, 7) ^
          _rotateRight(previous15, 18) ^
          (previous15 >> 3);
      final int s1 = _rotateRight(previous2, 17) ^
          _rotateRight(previous2, 19) ^
          (previous2 >> 10);
      schedule[index] =
          (schedule[index - 16] + s0 + schedule[index - 7] + s1) & 0xFFFFFFFF;
    }
    int a = hash[0];
    int b = hash[1];
    int c = hash[2];
    int d = hash[3];
    int e = hash[4];
    int f = hash[5];
    int g = hash[6];
    int h = hash[7];
    for (int index = 0; index < 64; index++) {
      final int s1 =
          _rotateRight(e, 6) ^ _rotateRight(e, 11) ^ _rotateRight(e, 25);
      final int choose = (e & f) ^ ((~e & 0xFFFFFFFF) & g);
      final int temp1 =
          (h + s1 + choose + _roundConstants[index] + schedule[index]) &
              0xFFFFFFFF;
      final int s0 =
          _rotateRight(a, 2) ^ _rotateRight(a, 13) ^ _rotateRight(a, 22);
      final int majority = (a & b) ^ (a & c) ^ (b & c);
      final int temp2 = (s0 + majority) & 0xFFFFFFFF;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) & 0xFFFFFFFF;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) & 0xFFFFFFFF;
    }
    hash[0] = (hash[0] + a) & 0xFFFFFFFF;
    hash[1] = (hash[1] + b) & 0xFFFFFFFF;
    hash[2] = (hash[2] + c) & 0xFFFFFFFF;
    hash[3] = (hash[3] + d) & 0xFFFFFFFF;
    hash[4] = (hash[4] + e) & 0xFFFFFFFF;
    hash[5] = (hash[5] + f) & 0xFFFFFFFF;
    hash[6] = (hash[6] + g) & 0xFFFFFFFF;
    hash[7] = (hash[7] + h) & 0xFFFFFFFF;
  }

  final Uint8List out = Uint8List(32);
  for (int index = 0; index < 8; index++) {
    out[index * 4] = (hash[index] >> 24) & 0xFF;
    out[index * 4 + 1] = (hash[index] >> 16) & 0xFF;
    out[index * 4 + 2] = (hash[index] >> 8) & 0xFF;
    out[index * 4 + 3] = hash[index] & 0xFF;
  }
  return out;
}

/// HMAC-SHA256（RFC 2104）。ブロック長は 64 バイトである。
Uint8List hmacSha256(List<int> key, List<int> message) {
  const int blockSize = 64;
  // 可変長の写しを持つ。sha256Bytes は固定長の Uint8List を返すため、
  // そのまま使うと詰め物の追加で「Cannot add to a fixed-length list」になる（実測）。
  List<int> normalized = List<int>.from(key);
  if (normalized.length > blockSize) {
    normalized = List<int>.from(sha256Bytes(normalized));
  }
  while (normalized.length < blockSize) {
    normalized.add(0);
  }
  final List<int> inner = <int>[];
  final List<int> outer = <int>[];
  for (int index = 0; index < blockSize; index++) {
    inner.add(normalized[index] ^ 0x36);
    outer.add(normalized[index] ^ 0x5c);
  }
  return sha256Bytes(<int>[...outer, ...sha256Bytes(<int>[...inner, ...message])]);
}

/// base64url（詰め物なし）。認証規範の符号化に合わせる。
String base64UrlNoPad(List<int> bytes) =>
    base64Url.encode(bytes).replaceAll('=', '');

String bytesToHex(List<int> bytes) {
  final StringBuffer buffer = StringBuffer();
  for (final int byte in bytes) {
    buffer.write(byte.toRadixString(16).padLeft(2, '0'));
  }
  return buffer.toString();
}

Uint8List hexToBytes(String hex) {
  final Uint8List bytes = Uint8List(hex.length ~/ 2);
  for (int index = 0; index < bytes.length; index++) {
    bytes[index] = int.parse(hex.substring(index * 2, index * 2 + 2), radix: 16);
  }
  return bytes;
}
