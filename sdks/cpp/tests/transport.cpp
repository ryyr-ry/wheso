// 疎通試験（C++、段 B）。
//
// 何を証明するか: C++ の SDK が**実際の Durable Object**（partykit dev）へ WebSocket で
// 接続し、実際に符号化された AV1（spec/vectors/real-media.json）を送り、購読者として
// **1 バイトも変わらずに**受け取れること。段 A（凍結ベクタ・トレース・実データ照合）は
// 判断とバイト列の同一性を示すが、実際に線を通ることは示さない。
//
// 依存を追加しない: WebSocket と HMAC は tests/net.hpp（自前）を使う。
//
// 実行の前提: 実環境（PartyKit managed）へデプロイされていること。環境変数で場所と鍵を受け取る
// （WHESO_WS_BASE / WHESO_ROOM / WHESO_NODE_KEY / WHESO_SENDER_PK / WHESO_SUB_PK）。
// 無い場合は飛ばす。起動は tools/transport-suite.ts の責務である。

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "json.hpp"
#include "net.hpp"

namespace {

using wheso::testing::asText;
using wheso::testing::asUnsigned;
using wheso::testing::base64UrlNoPad;
using wheso::testing::bytesToHex;
using wheso::testing::field;
using wheso::testing::Frame;
using wheso::testing::FrameKind;
using wheso::testing::hexToBytes;
using wheso::testing::hmacSha256;
using wheso::testing::JsonPtr;
using wheso::testing::readJsonFile;
using wheso::testing::sha256;
using wheso::testing::toBytes;
using wheso::testing::WebSocketClient;

int checks = 0;
int failures = 0;

void expectEqual(const std::string& actual, const std::string& expected, const std::string& what) {
  ++checks;
  if (actual != expected) {
    ++failures;
    std::cout << "FAIL " << what << "\n  期待 " << expected << "\n  実際 " << actual << "\n";
  }
}

void expectTrue(bool condition, const std::string& what) {
  ++checks;
  if (!condition) {
    ++failures;
    std::cout << "FAIL " << what << "\n";
  }
}

/// 時刻窓の長さ。認証規範の NODE_AUTH_TIME_WINDOW_SEC と一致させる。
constexpr std::int64_t kTimeWindowSec = 300;

/// 送る枚数。全部送ると試験が長くなるため先頭に限る（キーフレームを含む）。
constexpr std::size_t kSendCount = 10;

/// 自前の SHA-256 と HMAC が既知の答えと一致することを先に確かめる。
/// 誤ったまま疎通試験を回すと、接続拒否の原因が実装か手順か切り分けられない。
void verifyDigest() {
  // FIPS 180-4 の例。
  // 反復子は必ず**同じ**変数から取る。sha256(...) を 2 回書いて begin と end を別々の
  // 一時オブジェクトから取ると、距離が不正になり std::length_error で落ちる（実測）。
  const std::array<std::uint8_t, 32> abc = sha256(toBytes("abc"));
  expectEqual(bytesToHex(std::vector<std::uint8_t>(abc.begin(), abc.end())),
              "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA-256 abc");
  const std::array<std::uint8_t, 32> empty = sha256({});
  expectEqual(bytesToHex(std::vector<std::uint8_t>(empty.begin(), empty.end())),
              "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "SHA-256 空");
  // 64 バイト境界を跨ぐ長さ（詰め物の分岐を通す）。
  const std::array<std::uint8_t, 32> long1000 = sha256(std::vector<std::uint8_t>(1000, 'a'));
  expectEqual(bytesToHex(std::vector<std::uint8_t>(long1000.begin(), long1000.end())),
              "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
              "SHA-256 1000 バイト");

  // RFC 4231 のベクタ 1・2・3・6。
  const std::array<std::uint8_t, 32> v1 =
      hmacSha256(std::vector<std::uint8_t>(20, 0x0b), toBytes("Hi There"));
  expectEqual(bytesToHex(std::vector<std::uint8_t>(v1.begin(), v1.end())),
              "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7", "RFC 4231 の 1");
  const std::array<std::uint8_t, 32> v2 =
      hmacSha256(toBytes("Jefe"), toBytes("what do ya want for nothing?"));
  expectEqual(bytesToHex(std::vector<std::uint8_t>(v2.begin(), v2.end())),
              "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843", "RFC 4231 の 2");
  const std::array<std::uint8_t, 32> v3 =
      hmacSha256(std::vector<std::uint8_t>(20, 0xaa), std::vector<std::uint8_t>(50, 0xdd));
  expectEqual(bytesToHex(std::vector<std::uint8_t>(v3.begin(), v3.end())),
              "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe", "RFC 4231 の 3");
  const std::array<std::uint8_t, 32> v6 =
      hmacSha256(std::vector<std::uint8_t>(131, 0xaa),
                 toBytes("Test Using Larger Than Block-Size Key - Hash Key First"));
  expectEqual(bytesToHex(std::vector<std::uint8_t>(v6.begin(), v6.end())),
              "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54", "RFC 4231 の 6");

  // base64url は詰め物を付けない。期待値は標準 base64 からの置換で導いた。
  expectEqual(base64UrlNoPad({0xff}), "_w", "base64url 1 バイト");
  expectEqual(base64UrlNoPad({0xff, 0xfe}), "__4", "base64url 2 バイト");
  expectEqual(base64UrlNoPad({0xff, 0xfe, 0xfd}), "__79", "base64url 3 バイト");
}

/// nodeHello の authTag を作る。
/// 会議シークレット = HMAC(鍵, "meeting-secret:v1:<会議 ID>")
/// authTag = base64url(HMAC(会議シークレット, "node-auth:v1:<部屋名>:<役割>:<時刻窓>"))
/// 参照実装（packages/core/src/auth.ts）と 1 文字でも違えば 4023 で切られる。
std::string buildAuthTag(const std::string& key, const std::string& room, const std::string& role) {
  std::string meetingId;
  std::size_t first = room.find('-');
  if (first != std::string::npos) {
    const std::size_t second = room.find('-', first + 1);
    meetingId = second == std::string::npos ? room.substr(first + 1)
                                            : room.substr(first + 1, second - first - 1);
  }
  const std::array<std::uint8_t, 32> secret =
      hmacSha256(toBytes(key), toBytes("meeting-secret:v1:" + meetingId));
  const std::int64_t seconds = static_cast<std::int64_t>(
      std::chrono::duration_cast<std::chrono::seconds>(
          std::chrono::system_clock::now().time_since_epoch())
          .count());
  const std::int64_t window = seconds / kTimeWindowSec;
  const std::array<std::uint8_t, 32> tag =
      hmacSha256(std::vector<std::uint8_t>(secret.begin(), secret.end()),
                 toBytes("node-auth:v1:" + room + ":" + role + ":" + std::to_string(window)));
  return base64UrlNoPad(std::vector<std::uint8_t>(tag.begin(), tag.end()));
}

std::string environmentOr(const char* name, const std::string& fallback) {
  const char* value = std::getenv(name);
  return value == nullptr ? fallback : std::string(value);
}

}  // namespace

int main(int argc, char** argv) {
  const std::string vectorsDirectory = argc > 1 ? argv[1] : "../../spec/vectors";

  verifyDigest();

  const std::string base = environmentOr("WHESO_WS_BASE", "");
  const std::string room = environmentOr("WHESO_ROOM", "");
  const std::string key = environmentOr("WHESO_NODE_KEY", "");
  const std::string senderPk = environmentOr("WHESO_SENDER_PK", "");
  const std::string subPk = environmentOr("WHESO_SUB_PK", "");
  // 実環境へは TLS の終端を経由して繋ぐため、Host ヘッダに実環境の名前を書く。
  const std::string wsHost = environmentOr("WHESO_WS_HOST", "");
  if (base.empty() || room.empty() || key.empty() || senderPk.empty() || subPk.empty()) {
    // 局所実行環境が無い場所では飛ばす。実行器が環境変数を与える。
    std::cout << "SKIP 疎通試験（環境変数が無い）\n";
    std::cout << "検査 " << checks << " 件、失敗 " << failures << " 件\n";
    return failures == 0 ? 0 : 1;
  }

  const JsonPtr asset = readJsonFile(vectorsDirectory + "/real-media.json");
  const JsonPtr video = field(asset, "video");
  const JsonPtr frames = field(video, "frames");
  expectTrue(frames != nullptr && frames->array.size() >= kSendCount, "資産に 10 枚以上ある");
  if (frames == nullptr || frames->array.size() < kSendCount) {
    std::cout << "検査 " << checks << " 件、失敗 " << failures << " 件\n";
    return 1;
  }
  const std::uint64_t senderId = asUnsigned(field(asset, "senderId"));
  const std::uint64_t channel = asUnsigned(field(video, "channel"));
  const std::int64_t framerate = wheso::testing::asInt(field(video, "framerate"), 30);

  // 購読側を先に開く。順序を逆にすると転送先が無く、送ったものが消える。
  WebSocketClient subscriber;
  std::string failure;
  if (!subscriber.connect(base + "/parties/shard/" + room + "?_pk=" + subPk, 30, failure, wsHost)) {
    std::cout << "FAIL 購読側が繋がらない: " << failure << "\n";
    return 1;
  }
  expectTrue(subscriber.sendText("{\"t\":\"nodeHello\",\"role\":\"receiver\",\"nodeId\":\"" + room +
                                     "\",\"authTag\":\"" + buildAuthTag(key, room, "receiver") +
                                     "\"}",
                                 failure),
             "購読側の nodeHello が送れる");
  expectTrue(subscriber.sendText("{\"t\":\"subscribe\",\"entries\":[{\"senderId\":" +
                                     std::to_string(senderId) + ",\"channel\":" +
                                     std::to_string(channel) +
                                     ",\"maxSpatialId\":3,\"maxTemporalId\":7}]}",
                                 failure),
             "購読が送れる");

  // 受信を先に仕掛ける。仕掛ける前に送ると取りこぼす。
  std::mutex guard;
  std::vector<std::string> receivedHex;
  std::thread pump([&subscriber, &guard, &receivedHex]() {
    for (;;) {
      const Frame frame = subscriber.receive();
      if (frame.kind == FrameKind::Binary) {
        const std::lock_guard<std::mutex> lock(guard);
        receivedHex.push_back(bytesToHex(frame.payload));
        // 受け取った順と大きさを残す。件数が足りない場合、欠落（届いていない）と
        // 解釈のずれ（境界を誤って待ち続ける）を記録から区別するために要る。
        std::cout << "受信 " << receivedHex.size() << " 件目 " << frame.payload.size()
                  << " バイト\n";
        if (receivedHex.size() >= kSendCount) {
          return;
        }
      } else if (frame.kind == FrameKind::Closed) {
        // 認証に失敗すると 4023（E_NODE_AUTH）で切られる。原因を残す。
        std::cout << "購読側が閉じられた: " << frame.code << " " << frame.reason << "\n";
        return;
      } else if (frame.kind == FrameKind::None) {
        std::cout << "購読側の受信が終わった（時間切れか切断）。未処理の残り "
                  << subscriber.pendingSize() << " バイト\n";
        return;
      }
      // 制御メッセージ（nodeHelloAck など）は数えない。
    }
  });

  // 購読の登録が処理される猶予を置く。
  std::this_thread::sleep_for(std::chrono::milliseconds(1000));

  WebSocketClient sender;
  if (!sender.connect(base + "/parties/shard/" + room + "?_pk=" + senderPk, 30, failure, wsHost)) {
    std::cout << "FAIL 送信側が繋がらない: " << failure << "\n";
    subscriber.disconnect();
    pump.join();
    return 1;
  }
  expectTrue(sender.sendText("{\"t\":\"nodeHello\",\"role\":\"sender\",\"nodeId\":\"" + room +
                                 "\",\"authTag\":\"" + buildAuthTag(key, room, "sender") + "\"}",
                             failure),
             "送信側の nodeHello が送れる");
  std::this_thread::sleep_for(std::chrono::milliseconds(500));

  std::vector<std::string> sentHex;
  for (std::size_t index = 0; index < kSendCount; ++index) {
    const JsonPtr frame = frames->array[index];
    const std::string hex = asText(field(frame, "expectedMessageHex"));
    expectTrue(!hex.empty(), std::to_string(index) + " 番目に期待バイト列がある");
    sentHex.push_back(hex);
    expectTrue(sender.sendBinary(hexToBytes(hex), failure), std::to_string(index) + " 番目が送れる");
    std::cout << "送信 " << index << " 番目 " << (hex.size() / 2) << " バイト\n";
    // 実際の間隔で送る。詰めて送ると予算超過の破棄が働き、疎通の検証にならない。
    std::this_thread::sleep_for(
        std::chrono::milliseconds(1000 / (framerate < 1 ? 1 : framerate)));
  }

  // 転送は非同期であるため、送り終えた時点では届いていない。揃うまで待つ。
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
  for (;;) {
    std::size_t count = 0;
    {
      const std::lock_guard<std::mutex> lock(guard);
      count = receivedHex.size();
    }
    if (count >= kSendCount || std::chrono::steady_clock::now() >= deadline) {
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }

  std::vector<std::string> snapshot;
  {
    const std::lock_guard<std::mutex> lock(guard);
    snapshot = receivedHex;
  }
  subscriber.disconnect();
  sender.disconnect();
  pump.join();

  expectTrue(snapshot.size() == kSendCount,
             "購読者が 10 件を受け取る（実際 " + std::to_string(snapshot.size()) + " 件）");
  for (std::size_t index = 0; index < kSendCount && index < snapshot.size(); ++index) {
    expectEqual(snapshot[index], sentHex[index],
                std::to_string(index) + " 番目のバイト列が 1 バイトも変わらない");
  }

  std::cout << "検査 " << checks << " 件、失敗 " << failures << " 件\n";
  if (failures != 0) {
    return 1;
  }
  std::cout << "OK: C++ が実行中のノードへ実データを通した\n";
  return 0;
}
