// 疎通試験（Dart、段 B）。
//
// 何を証明するか: Dart の SDK が**実際の Durable Object**（partykit dev）へ WebSocket で
// 接続し、実際に符号化された AV1（spec/vectors/real-media.json）を送り、購読者として
// **1 バイトも変わらずに**受け取れること。段 A（凍結ベクタ・トレース・実データ照合）は
// 判断とバイト列の同一性を示すが、実際に線を通ることは示さない。
//
// 依存を追加しない: WebSocket は dart:io（標準）、HMAC は test/support/digest.dart の
// 自前実装を使う。自前 HMAC は digest_test.dart が RFC 4231 で検証している。
//
// 実行の前提: 実環境（PartyKit managed）へデプロイされていること。環境変数で場所と鍵を受け取る
// （WHESO_WS_BASE / WHESO_ROOM / WHESO_NODE_KEY / WHESO_SENDER_PK / WHESO_SUB_PK）。
// 無い場合は飛ばす。起動は tools/transport-suite.ts の責務である。

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';

import 'support/digest.dart';

/// 時刻窓の長さ。認証規範の NODE_AUTH_TIME_WINDOW_SEC と一致させる。
const int timeWindowSec = 300;

/// 送る枚数。全部送ると試験が長くなるため先頭に限る（キーフレームを含む）。
const int sendCount = 10;

/// nodeHello の authTag を作る。
/// 会議シークレット = HMAC(鍵, "meeting-secret:v1:<会議 ID>")
/// authTag = base64url(HMAC(会議シークレット, "node-auth:v1:<部屋名>:<役割>:<時刻窓>"))
/// 参照実装（packages/core/src/auth.ts）と 1 文字でも違えば 4023 で切られる。
String buildAuthTag(String key, String room, String role) {
  final List<String> parts = room.split('-');
  final String meetingId = parts.length > 1 ? parts[1] : '';
  final List<int> secret =
      hmacSha256(utf8.encode(key), utf8.encode('meeting-secret:v1:$meetingId'));
  final int window =
      (DateTime.now().millisecondsSinceEpoch ~/ 1000) ~/ timeWindowSec;
  return base64UrlNoPad(
    hmacSha256(secret, utf8.encode('node-auth:v1:$room:$role:$window')),
  );
}

/// 資産を読む。試験の作業ディレクトリは sdks/dart である。
Object? readAsset() {
  final File file = File('../../spec/vectors/real-media.json');
  return jsonDecode(file.readAsStringSync());
}

/// 型を確かめて地図として取り出す。dynamic を使わない。
Map<String, Object?> asMap(Object? value, String what) {
  if (value is Map<String, Object?>) {
    return value;
  }
  throw StateError('$what が地図でない');
}

List<Object?> asList(Object? value, String what) {
  if (value is List<Object?>) {
    return value;
  }
  throw StateError('$what が並びでない');
}

int asInt(Object? value, String what) {
  if (value is int) {
    return value;
  }
  throw StateError('$what が整数でない');
}

String asText(Object? value, String what) {
  if (value is String) {
    return value;
  }
  throw StateError('$what が文字列でない');
}

void main() {
  test('実データが実行中のノードを通って戻る', () async {
    final Map<String, String> environment = Platform.environment;
    // dart:io の WebSocket は TLS を話せるため、実環境へ直に繋ぐ（wss）。
    // WHESO_WSS_BASE が無い場合だけ平文の口（TLS 終端）へ落ちる。
    final String? base =
        environment['WHESO_WSS_BASE'] ?? environment['WHESO_WS_BASE'];
    final String? room = environment['WHESO_ROOM'];
    final String? key = environment['WHESO_NODE_KEY'];
    final String? senderPk = environment['WHESO_SENDER_PK'];
    final String? subPk = environment['WHESO_SUB_PK'];
    if (base == null ||
        room == null ||
        key == null ||
        senderPk == null ||
        subPk == null) {
      // 局所実行環境が無い場所では飛ばす。実行器が環境変数を与える。
      print('SKIP 疎通試験（環境変数が無い）');
      return;
    }

    final Map<String, Object?> asset = asMap(readAsset(), '資産');
    final Map<String, Object?> video = asMap(asset['video'], 'video');
    final List<Object?> frames = asList(video['frames'], 'frames');
    final int senderId = asInt(asset['senderId'], 'senderId');
    final int channel = asInt(video['channel'], 'channel');
    final Object? rawFramerate = video['framerate'];
    final int framerate = rawFramerate is int ? rawFramerate : 30;
    expect(frames.length, greaterThanOrEqualTo(sendCount));

    // 購読側を先に開く。順序を逆にすると転送先が無く、送ったものが消える。
    final WebSocket subscriber =
        await WebSocket.connect('$base/parties/shard/$room?_pk=$subPk');
    final List<String> receivedHex = <String>[];
    // 受信を先に仕掛ける。仕掛ける前に送ると取りこぼす。
    subscriber.listen(
      (Object? message) {
        if (message is List<int>) {
          receivedHex.add(bytesToHex(message));
        }
        // 制御メッセージ（nodeHelloAck など）は数えない。
      },
      onDone: () {
        // 認証に失敗すると 4023（E_NODE_AUTH）で切られる。原因を残す。
        print('購読側が閉じられた: ${subscriber.closeCode} ${subscriber.closeReason}');
      },
    );

    subscriber.add(
      '{"t":"nodeHello","role":"receiver","nodeId":"$room","authTag":"${buildAuthTag(key, room, 'receiver')}"}',
    );
    subscriber.add(
      '{"t":"subscribe","entries":[{"senderId":$senderId,"channel":$channel,"maxSpatialId":3,"maxTemporalId":7}]}',
    );
    // 購読の登録が処理される猶予を置く。
    await Future<void>.delayed(const Duration(milliseconds: 1000));

    final WebSocket sender =
        await WebSocket.connect('$base/parties/shard/$room?_pk=$senderPk');
    sender.listen(
      (Object? message) {},
      onDone: () {
        print('送信側が閉じられた: ${sender.closeCode} ${sender.closeReason}');
      },
    );
    sender.add(
      '{"t":"nodeHello","role":"sender","nodeId":"$room","authTag":"${buildAuthTag(key, room, 'sender')}"}',
    );
    await Future<void>.delayed(const Duration(milliseconds: 500));

    final List<String> sentHex = <String>[];
    for (int index = 0; index < sendCount; index++) {
      final Map<String, Object?> frame = asMap(frames[index], 'frame');
      final String hex = asText(frame['expectedMessageHex'], 'expectedMessageHex');
      sentHex.add(hex);
      sender.add(hexToBytes(hex));
      // 実際の間隔で送る。詰めて送ると予算超過の破棄が働き、疎通の検証にならない。
      await Future<void>.delayed(
        Duration(milliseconds: (1000 / (framerate < 1 ? 1 : framerate)).ceil()),
      );
    }

    // 転送は非同期であるため、送り終えた時点では届いていない。揃うまで待つ。
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 30));
    while (receivedHex.length < sendCount && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }

    expect(receivedHex.length, sendCount, reason: '購読者が $sendCount 件を受け取る');
    for (int index = 0; index < sendCount; index++) {
      expect(
        receivedHex[index],
        sentHex[index],
        reason: '$index 番目のバイト列が 1 バイトも変わらない',
      );
    }

    await subscriber.close();
    await sender.close();
  }, timeout: const Timeout(Duration(minutes: 2)));
}
