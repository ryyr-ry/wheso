// 自前の SHA-256 と HMAC-SHA256 の検証（Dart）。
//
// なぜ必要か: 疎通試験（transport_test.dart）はノード間認証の HMAC が正しいことに依存する。
// HMAC が誤っていれば接続が拒否され「線が通らない」ように見える。逆に、誤った HMAC でも
// 通ってしまえば認証が働いていないことになる。どちらの誤解も避けるため既知の答えで先に確かめる。

import 'package:test/test.dart';

import 'support/digest.dart';

void main() {
  test('SHA-256 が既知の答えと一致する', () {
    // FIPS 180-4 の例。
    expect(
      bytesToHex(sha256Bytes('abc'.codeUnits)),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      bytesToHex(sha256Bytes(<int>[])),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    // 64 バイト境界を跨ぐ長さ（詰め物の分岐を通す）。
    expect(
      bytesToHex(sha256Bytes(List<int>.filled(1000, 0x61))),
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
  });

  test('HMAC-SHA256 が RFC 4231 のベクタと一致する', () {
    // ベクタ 1。
    expect(
      bytesToHex(hmacSha256(List<int>.filled(20, 0x0b), 'Hi There'.codeUnits)),
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
    // ベクタ 2。
    expect(
      bytesToHex(
        hmacSha256('Jefe'.codeUnits, 'what do ya want for nothing?'.codeUnits),
      ),
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
    // ベクタ 3。
    expect(
      bytesToHex(
        hmacSha256(List<int>.filled(20, 0xaa), List<int>.filled(50, 0xdd)),
      ),
      '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe',
    );
    // ベクタ 6（鍵がブロック長より長い。鍵をハッシュする分岐を通す）。
    expect(
      bytesToHex(
        hmacSha256(
          List<int>.filled(131, 0xaa),
          'Test Using Larger Than Block-Size Key - Hash Key First'.codeUnits,
        ),
      ),
      '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
    );
  });

  test('base64url に詰め物が付かない', () {
    // 期待値は標準 base64 からの置換で導いた（手計算では誤りやすい）。
    expect(base64UrlNoPad(<int>[0xff]), '_w');
    expect(base64UrlNoPad(<int>[0xff, 0xfe]), '__4');
    expect(base64UrlNoPad(<int>[0xff, 0xfe, 0xfd]), '__79');
  });

  test('16 進の相互変換が往復する', () {
    final List<int> bytes = <int>[0x00, 0x0f, 0xa1, 0xff];
    expect(bytesToHex(bytes), '000fa1ff');
    expect(hexToBytes('000fa1ff'), bytes);
  });
}
