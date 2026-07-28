// SHA-256 / HMAC-SHA256 / base64 / RFC 6455 の最小 WebSocket クライアント（C++ の試験用）。
//
// なぜ自前で書くか: この SDK は依存を持たない（licensing.md）。OpenSSL や Boost.Beast を
// 足すと構築の前提が増え、コンパイラだけで完結するという性質が失われる。疎通試験に要るのは
// 握手と送受信、そして HMAC だけであり、POSIX のソケットで足りる。
//
// 実装の範囲は疎通試験に要るものだけである。
//   握手（HTTP Upgrade）、テキスト送信、バイナリ送信、フレーム受信、close の検出。
//   拡張（permessage-deflate）と断片の送信は行わない。受信の断片は繋ぐ。
// クライアントからの送信は必ずマスクする（RFC 6455 5.3）。
//
// SHA-256 の正しさは既知の答え（FIPS 180-4 と RFC 4231）で確かめる（transport.cpp）。
// 確かめずに使うと、疎通試験が失敗したときに原因が実装か手順か切り分けられない。
#pragma once

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <array>
#include <cstdint>
#include <cstring>
#include <optional>
#include <string>
#include <vector>

namespace wheso::testing {

// MARK: - SHA-256

inline std::uint32_t rotateRight(std::uint32_t value, std::uint32_t count) {
  return (value >> count) | (value << (32 - count));
}

inline std::array<std::uint8_t, 32> sha256(const std::vector<std::uint8_t>& message) {
  static const std::array<std::uint32_t, 64> kRound = {
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
      0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
      0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
      0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
      0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
      0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
      0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
      0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
      0xc67178f2};

  std::array<std::uint32_t, 8> hash = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                       0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  std::vector<std::uint8_t> padded = message;
  const std::uint64_t bitLength = static_cast<std::uint64_t>(message.size()) * 8;
  padded.push_back(0x80);
  while (padded.size() % 64 != 56) {
    padded.push_back(0);
  }
  for (int shift = 56; shift >= 0; shift -= 8) {
    padded.push_back(static_cast<std::uint8_t>((bitLength >> shift) & 0xff));
  }

  for (std::size_t offset = 0; offset + 64 <= padded.size(); offset += 64) {
    std::array<std::uint32_t, 64> schedule{};
    for (std::size_t index = 0; index < 16; ++index) {
      const std::size_t base = offset + index * 4;
      schedule[index] = (static_cast<std::uint32_t>(padded[base]) << 24) |
                        (static_cast<std::uint32_t>(padded[base + 1]) << 16) |
                        (static_cast<std::uint32_t>(padded[base + 2]) << 8) |
                        static_cast<std::uint32_t>(padded[base + 3]);
    }
    for (std::size_t index = 16; index < 64; ++index) {
      const std::uint32_t p15 = schedule[index - 15];
      const std::uint32_t p2 = schedule[index - 2];
      const std::uint32_t s0 = rotateRight(p15, 7) ^ rotateRight(p15, 18) ^ (p15 >> 3);
      const std::uint32_t s1 = rotateRight(p2, 17) ^ rotateRight(p2, 19) ^ (p2 >> 10);
      schedule[index] = schedule[index - 16] + s0 + schedule[index - 7] + s1;
    }
    std::uint32_t a = hash[0];
    std::uint32_t b = hash[1];
    std::uint32_t c = hash[2];
    std::uint32_t d = hash[3];
    std::uint32_t e = hash[4];
    std::uint32_t f = hash[5];
    std::uint32_t g = hash[6];
    std::uint32_t h = hash[7];
    for (std::size_t index = 0; index < 64; ++index) {
      const std::uint32_t s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const std::uint32_t choose = (e & f) ^ (~e & g);
      const std::uint32_t temp1 = h + s1 + choose + kRound[index] + schedule[index];
      const std::uint32_t s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const std::uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
      const std::uint32_t temp2 = s0 + majority;
      h = g;
      g = f;
      f = e;
      e = d + temp1;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2;
    }
    hash[0] += a;
    hash[1] += b;
    hash[2] += c;
    hash[3] += d;
    hash[4] += e;
    hash[5] += f;
    hash[6] += g;
    hash[7] += h;
  }

  std::array<std::uint8_t, 32> out{};
  for (std::size_t index = 0; index < 8; ++index) {
    out[index * 4] = static_cast<std::uint8_t>(hash[index] >> 24);
    out[index * 4 + 1] = static_cast<std::uint8_t>(hash[index] >> 16);
    out[index * 4 + 2] = static_cast<std::uint8_t>(hash[index] >> 8);
    out[index * 4 + 3] = static_cast<std::uint8_t>(hash[index]);
  }
  return out;
}

inline std::vector<std::uint8_t> toBytes(const std::string& text) {
  return std::vector<std::uint8_t>(text.begin(), text.end());
}

/// HMAC-SHA256（RFC 2104）。ブロック長は 64 バイトである。
inline std::array<std::uint8_t, 32> hmacSha256(const std::vector<std::uint8_t>& key,
                                               const std::vector<std::uint8_t>& message) {
  constexpr std::size_t kBlockSize = 64;
  std::vector<std::uint8_t> normalized = key;
  if (normalized.size() > kBlockSize) {
    const std::array<std::uint8_t, 32> shortened = sha256(normalized);
    normalized.assign(shortened.begin(), shortened.end());
  }
  normalized.resize(kBlockSize, 0);
  std::vector<std::uint8_t> inner;
  std::vector<std::uint8_t> outer;
  inner.reserve(kBlockSize + message.size());
  outer.reserve(kBlockSize + 32);
  for (std::size_t index = 0; index < kBlockSize; ++index) {
    inner.push_back(static_cast<std::uint8_t>(normalized[index] ^ 0x36));
    outer.push_back(static_cast<std::uint8_t>(normalized[index] ^ 0x5c));
  }
  inner.insert(inner.end(), message.begin(), message.end());
  const std::array<std::uint8_t, 32> innerHash = sha256(inner);
  outer.insert(outer.end(), innerHash.begin(), innerHash.end());
  return sha256(outer);
}

// MARK: - base64

inline std::string base64Encode(const std::vector<std::uint8_t>& bytes, const char* alphabet,
                                bool pad) {
  std::string out;
  for (std::size_t offset = 0; offset < bytes.size(); offset += 3) {
    const std::size_t remaining = bytes.size() - offset;
    const std::uint32_t b0 = bytes[offset];
    const std::uint32_t b1 = remaining > 1 ? bytes[offset + 1] : 0;
    const std::uint32_t b2 = remaining > 2 ? bytes[offset + 2] : 0;
    const std::uint32_t triple = (b0 << 16) | (b1 << 8) | b2;
    const std::size_t keep = (remaining > 3 ? 3 : remaining) + 1;
    for (std::size_t position = 0; position < 4; ++position) {
      const std::uint32_t index = (triple >> (18 - 6 * position)) & 0x3f;
      if (position < keep) {
        out.push_back(alphabet[index]);
      } else if (pad) {
        out.push_back('=');
      }
    }
  }
  return out;
}

/// base64url（詰め物なし）。認証規範の符号化に合わせる。
inline std::string base64UrlNoPad(const std::vector<std::uint8_t>& bytes) {
  return base64Encode(bytes, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
                      false);
}

/// base64（標準・詰め物あり）。WebSocket の握手鍵に使う。
inline std::string base64Standard(const std::vector<std::uint8_t>& bytes) {
  return base64Encode(bytes, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
                      true);
}

// MARK: - WebSocket

enum class FrameKind { Text, Binary, Closed, None };

struct Frame {
  FrameKind kind = FrameKind::None;
  std::vector<std::uint8_t> payload;
  std::uint16_t code = 0;
  std::string reason;
};

class WebSocketClient {
 public:
  WebSocketClient() = default;
  WebSocketClient(const WebSocketClient&) = delete;
  WebSocketClient& operator=(const WebSocketClient&) = delete;

  ~WebSocketClient() { disconnect(); }

  /// `ws://host:port/path?query` へ接続して握手を済ませる。平文のみを扱う。
  /// hostHeader が空でなければ Host ヘッダをそれで書く。TLS の終端を経由して実環境へ
  /// 中継する場合、Host が 127.0.0.1 だと相手が部屋を引けないため必ず与える。
  bool connect(const std::string& url, int timeoutSec, std::string& failure,
               const std::string& hostHeader = "") {
    const std::string prefix = "ws://";
    if (url.rfind(prefix, 0) != 0) {
      failure = "ws:// で始まらない: " + url;
      return false;
    }
    const std::string rest = url.substr(prefix.size());
    const std::size_t slash = rest.find('/');
    if (slash == std::string::npos) {
      failure = "経路が無い: " + url;
      return false;
    }
    const std::string authority = rest.substr(0, slash);
    const std::string path = rest.substr(slash);
    const std::size_t colon = authority.find(':');
    const std::string host = colon == std::string::npos ? authority : authority.substr(0, colon);
    const int port = colon == std::string::npos ? 80 : std::atoi(authority.substr(colon + 1).c_str());

    descriptor_ = ::socket(AF_INET, SOCK_STREAM, 0);
    if (descriptor_ < 0) {
      failure = "socket が失敗した";
      return false;
    }
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<std::uint16_t>(port));
    if (::inet_pton(AF_INET, host.c_str(), &address.sin_addr) != 1) {
      failure = "宛先が数値の IPv4 でない: " + host;
      disconnect();
      return false;
    }
    // 受信で無限に待たない。相手が黙った場合に試験が固まるのを防ぐ。
    timeval timeout{};
    timeout.tv_sec = timeoutSec;
    timeout.tv_usec = 0;
    ::setsockopt(descriptor_, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));

    if (::connect(descriptor_, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0) {
      failure = "connect が失敗した: " + authority;
      disconnect();
      return false;
    }
    return handshake(hostHeader.empty() ? authority : hostHeader, path, failure);
  }

  void disconnect() {
    if (descriptor_ >= 0) {
      ::close(descriptor_);
      descriptor_ = -1;
    }
  }

  bool sendText(const std::string& text, std::string& failure) {
    return sendFrame(0x1, toBytes(text), failure);
  }

  bool sendBinary(const std::vector<std::uint8_t>& bytes, std::string& failure) {
    return sendFrame(0x2, bytes, failure);
  }

  /// 1 フレームを受け取る。断片は連結し、ping には pong を返す。
  /// 読めなかった場合は kind = None を返す（時間切れか切断）。
  /// 未処理の受信バイト数。解釈のずれを診断するために覗く。
  std::size_t pendingSize() const { return pending_.size(); }

  Frame receive() {
    for (;;) {
      if (!fill(2)) {
        return Frame{};
      }
      const bool isFinal = (pending_[0] & 0x80) != 0;
      const std::uint8_t opcode = static_cast<std::uint8_t>(pending_[0] & 0x0f);
      const bool masked = (pending_[1] & 0x80) != 0;
      const std::size_t shortLength = static_cast<std::size_t>(pending_[1] & 0x7f);
      std::size_t offset = 2;
      std::size_t length = shortLength;
      if (shortLength == 126) {
        if (!fill(4)) {
          return Frame{};
        }
        length = (static_cast<std::size_t>(pending_[2]) << 8) | pending_[3];
        offset = 4;
      } else if (shortLength == 127) {
        if (!fill(10)) {
          return Frame{};
        }
        std::size_t value = 0;
        for (std::size_t index = 2; index < 10; ++index) {
          value = (value << 8) | pending_[index];
        }
        length = value;
        offset = 10;
      }
      // サーバからの送信はマスクされない（RFC 6455 5.1）。来た場合も鍵の分だけ進める。
      const std::size_t maskLength = masked ? 4 : 0;
      const std::size_t total = offset + maskLength + length;
      if (!fill(total)) {
        return Frame{};
      }
      std::vector<std::uint8_t> payload(pending_.begin() + static_cast<long>(offset + maskLength),
                                        pending_.begin() + static_cast<long>(total));
      if (masked) {
        for (std::size_t index = 0; index < payload.size(); ++index) {
          payload[index] = static_cast<std::uint8_t>(payload[index] ^ pending_[offset + index % 4]);
        }
      }
      pending_.erase(pending_.begin(), pending_.begin() + static_cast<long>(total));

      if (opcode == 0x0) {
        fragment_.insert(fragment_.end(), payload.begin(), payload.end());
        if (isFinal) {
          Frame frame;
          frame.kind = fragmentOpcode_ == 0x1 ? FrameKind::Text : FrameKind::Binary;
          frame.payload = fragment_;
          fragment_.clear();
          fragmentOpcode_ = 0;
          return frame;
        }
      } else if (opcode == 0x1 || opcode == 0x2) {
        if (isFinal) {
          Frame frame;
          frame.kind = opcode == 0x1 ? FrameKind::Text : FrameKind::Binary;
          frame.payload = payload;
          return frame;
        }
        fragment_ = payload;
        fragmentOpcode_ = opcode;
      } else if (opcode == 0x8) {
        Frame frame;
        frame.kind = FrameKind::Closed;
        if (payload.size() >= 2) {
          frame.code = static_cast<std::uint16_t>((payload[0] << 8) | payload[1]);
          frame.reason = std::string(payload.begin() + 2, payload.end());
        }
        return frame;
      } else if (opcode == 0x9) {
        // ping には pong を返す。返さないと相手が切ることがある。
        std::string ignored;
        if (!sendFrame(0xa, payload, ignored)) {
          return Frame{};
        }
      }
    }
  }

 private:
  bool handshake(const std::string& authority, const std::string& path, std::string& failure) {
    // 握手鍵は 16 バイトの任意値である（RFC 6455 4.1）。乱数の質は問われない。
    std::vector<std::uint8_t> seed(16);
    for (std::size_t index = 0; index < seed.size(); ++index) {
      seed[index] = static_cast<std::uint8_t>(0x30 + index);
    }
    const std::string request = "GET " + path +
                                " HTTP/1.1\r\nHost: " + authority +
                                "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                                "Sec-WebSocket-Key: " + base64Standard(seed) +
                                "\r\nSec-WebSocket-Version: 13\r\n\r\n";
    if (!writeAll(toBytes(request), failure)) {
      return false;
    }
    for (;;) {
      const std::vector<std::uint8_t> chunk = readSome(1024);
      if (chunk.empty()) {
        failure = "握手の応答が途切れた";
        return false;
      }
      pending_.insert(pending_.end(), chunk.begin(), chunk.end());
      const std::optional<std::size_t> end = findHeaderEnd();
      if (end.has_value()) {
        const std::string text(pending_.begin(), pending_.begin() + static_cast<long>(*end));
        // 空行より後ろは最初のフレームである。捨てずに残す。
        pending_.erase(pending_.begin(), pending_.begin() + static_cast<long>(*end));
        if (text.rfind("HTTP/1.1 101", 0) != 0) {
          failure = "101 が返らなかった: " + text.substr(0, text.find('\r'));
          return false;
        }
        // Sec-WebSocket-Accept の検証は行わない。相手は自分が立てた局所実行環境であり、
        // 中間者を想定する状況ではない。
        return true;
      }
      if (pending_.size() > 64 * 1024) {
        failure = "応答の頭が大きすぎる";
        return false;
      }
    }
  }

  std::optional<std::size_t> findHeaderEnd() const {
    if (pending_.size() < 4) {
      return std::nullopt;
    }
    for (std::size_t index = 0; index + 3 < pending_.size(); ++index) {
      if (pending_[index] == 0x0d && pending_[index + 1] == 0x0a && pending_[index + 2] == 0x0d &&
          pending_[index + 3] == 0x0a) {
        return index + 4;
      }
    }
    return std::nullopt;
  }

  /// 1 フレームを組んで送る。クライアントは必ずマスクする（RFC 6455 5.3）。
  bool sendFrame(std::uint8_t opcode, const std::vector<std::uint8_t>& payload,
                 std::string& failure) {
    std::vector<std::uint8_t> frame;
    frame.push_back(static_cast<std::uint8_t>(0x80 | opcode));
    const std::size_t length = payload.size();
    if (length < 126) {
      frame.push_back(static_cast<std::uint8_t>(0x80 | length));
    } else if (length < 65536) {
      frame.push_back(static_cast<std::uint8_t>(0x80 | 126));
      frame.push_back(static_cast<std::uint8_t>(length >> 8));
      frame.push_back(static_cast<std::uint8_t>(length));
    } else {
      frame.push_back(static_cast<std::uint8_t>(0x80 | 127));
      for (int shift = 56; shift >= 0; shift -= 8) {
        frame.push_back(static_cast<std::uint8_t>((static_cast<std::uint64_t>(length) >> shift)));
      }
    }
    // マスク鍵も任意値である。固定でも規範に反しない。
    const std::array<std::uint8_t, 4> mask = {0x12, 0x34, 0x56, 0x78};
    frame.insert(frame.end(), mask.begin(), mask.end());
    for (std::size_t index = 0; index < payload.size(); ++index) {
      frame.push_back(static_cast<std::uint8_t>(payload[index] ^ mask[index % 4]));
    }
    return writeAll(frame, failure);
  }

  /// 少なくとも count バイトが溜まるまで読む（消費はしない）。
  bool fill(std::size_t count) {
    while (pending_.size() < count) {
      const std::vector<std::uint8_t> chunk = readSome(count - pending_.size() > 4096
                                                           ? count - pending_.size()
                                                           : 4096);
      if (chunk.empty()) {
        return false;
      }
      pending_.insert(pending_.end(), chunk.begin(), chunk.end());
    }
    return true;
  }

  std::vector<std::uint8_t> readSome(std::size_t limit) {
    std::vector<std::uint8_t> buffer(limit);
    const long received = ::recv(descriptor_, buffer.data(), limit, 0);
    if (received <= 0) {
      return {};
    }
    buffer.resize(static_cast<std::size_t>(received));
    return buffer;
  }

  bool writeAll(const std::vector<std::uint8_t>& bytes, std::string& failure) {
    std::size_t sent = 0;
    while (sent < bytes.size()) {
      const long written = ::send(descriptor_, bytes.data() + sent, bytes.size() - sent, 0);
      if (written <= 0) {
        failure = "send が失敗した";
        return false;
      }
      sent += static_cast<std::size_t>(written);
    }
    return true;
  }

  int descriptor_ = -1;
  std::vector<std::uint8_t> pending_;
  std::vector<std::uint8_t> fragment_;
  std::uint8_t fragmentOpcode_ = 0;
};

}  // namespace wheso::testing
