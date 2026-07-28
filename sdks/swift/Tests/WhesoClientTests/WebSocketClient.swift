// RFC 6455 の最小 WebSocket クライアント（Swift の試験用）。
//
// なぜ自前で書くか: Linux の Foundation は URLSession を libcurl で実装しており、
// libcurl に WebSocket が無い環境では実行時に「WebSockets not supported by libcurl」で
// 失敗する（swift:6.0 の公式イメージで実測）。URLSessionWebSocketTask は型としては
// 存在するため、構築だけでは気付けない。Network.framework は Linux に無い。
// swift-nio を足すと SDK に依存が増える（依存を持たない方針）。
//
// 実装の範囲は疎通試験に要るものだけである。
//   握手（HTTP Upgrade）、テキスト送信、バイナリ送信、フレーム受信、close の検出。
//   拡張（permessage-deflate）と断片の送信は行わない。受信の断片は繋ぐ。
// クライアントからの送信は必ずマスクする（RFC 6455 5.3）。
//
// 試験専用であり、製品コードには含めない（Sources ではなく Tests に置く）。

import Foundation

// プラットフォームごとに POSIX の口が入っている場所が違う。Linux は Glibc、
// macOS は Darwin である。名前が型の初期化子（connect / send）と衝突するため、
// モジュールを明示した関数値を 1 箇所で束ねる。
#if canImport(Glibc)
    import Glibc

    private let systemConnect = Glibc.connect
    private let systemSend = Glibc.send
#elseif canImport(Darwin)
    import Darwin

    private let systemConnect = Darwin.connect
    private let systemSend = Darwin.send
#endif

enum WebSocketError: Error, CustomStringConvertible {
    case badUrl(String)
    case connectFailed(String)
    case handshakeFailed(String)
    case ioFailed(String)
    case closed(code: UInt16, reason: String)

    var description: String {
        switch self {
        case .badUrl(let text): return "URL が読めない: \(text)"
        case .connectFailed(let text): return "接続できない: \(text)"
        case .handshakeFailed(let text): return "握手が失敗した: \(text)"
        case .ioFailed(let text): return "入出力が失敗した: \(text)"
        case .closed(let code, let reason): return "閉じられた: \(code) \(reason)"
        }
    }
}

/// 受信したフレーム。制御フレームは呼び出し側が読み飛ばす。
enum WebSocketFrame {
    case text(String)
    case binary([UInt8])
    case closed(code: UInt16, reason: String)
}

final class WebSocketClient {
    private let descriptor: Int32
    /// 受信の途中で余った分。フレーム境界とパケット境界は一致しない。
    private var pending: [UInt8] = []
    /// 断片化されたフレームの連結先。
    private var fragment: [UInt8] = []
    private var fragmentOpcode: UInt8 = 0

    private init(descriptor: Int32) {
        self.descriptor = descriptor
    }

    // MARK: - 接続

    /// `ws://host:port/path?query` へ接続して握手を済ませる。
    /// 平文のみを扱う（試験は局所実行環境に対してのみ行う）。
    /// hostHeader を与えると Host ヘッダをそれで書く。TLS の終端を経由して実環境へ
    /// 中継する場合、Host が 127.0.0.1 だと相手が部屋を引けないため必ず与える。
    static func connect(url: String, hostHeader: String? = nil, timeoutSec: Int32 = 30)
        -> Result<WebSocketClient, WebSocketError>
    {
        guard url.hasPrefix("ws://") else {
            return .failure(.badUrl("ws:// で始まらない: \(url)"))
        }
        let withoutScheme = String(url.dropFirst("ws://".count))
        guard let slash = withoutScheme.firstIndex(of: "/") else {
            return .failure(.badUrl("経路が無い: \(url)"))
        }
        let authority = String(withoutScheme[withoutScheme.startIndex..<slash])
        let path = String(withoutScheme[slash...])
        let hostAndPort = authority.split(separator: ":")
        guard let host = hostAndPort.first.map(String.init) else {
            return .failure(.badUrl("ホストが無い: \(url)"))
        }
        let port: UInt16
        if hostAndPort.count > 1, let parsed = UInt16(hostAndPort[1]) {
            port = parsed
        } else {
            port = 80
        }

        let descriptor = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        if descriptor < 0 {
            return .failure(.connectFailed("socket が失敗した"))
        }

        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        if inet_pton(AF_INET, host, &address.sin_addr) != 1 {
            close(descriptor)
            return .failure(.connectFailed("宛先が数値の IPv4 でない: \(host)"))
        }

        // 受信で無限に待たない。相手が黙った場合に試験が固まるのを防ぐ。
        var timeout = timeval(tv_sec: Int(timeoutSec), tv_usec: 0)
        _ = withUnsafeBytes(of: &timeout) { raw in
            setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, raw.baseAddress, socklen_t(raw.count))
        }

        let connected = withUnsafePointer(to: &address) { pointer -> Int32 in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { rebound in
                systemConnect(descriptor, rebound, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if connected < 0 {
            close(descriptor)
            return .failure(.connectFailed("connect が失敗した: \(host):\(port)"))
        }

        let client = WebSocketClient(descriptor: descriptor)
        if let failure = client.handshake(host: hostHeader ?? authority, path: path) {
            client.disconnect()
            return .failure(failure)
        }
        return .success(client)
    }

    private func handshake(host: String, path: String) -> WebSocketError? {
        var keyBytes: [UInt8] = []
        for _ in 0..<16 {
            keyBytes.append(UInt8.random(in: 0...255))
        }
        let key = Data(keyBytes).base64EncodedString()
        let request = [
            "GET \(path) HTTP/1.1",
            "Host: \(host)",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: \(key)",
            "Sec-WebSocket-Version: 13",
            "", "",
        ].joined(separator: "\r\n")
        if let failure = writeAll(Array(request.utf8)) {
            return .handshakeFailed(failure.description)
        }

        // 応答の頭を丸ごと読む。本文の始まりは空行である。
        var header: [UInt8] = []
        while true {
            switch readSome(limit: 1024) {
            case .failure(let error):
                return .handshakeFailed(error.description)
            case .success(let chunk):
                if chunk.isEmpty {
                    return .handshakeFailed("握手の応答が途切れた")
                }
                header.append(contentsOf: chunk)
                if let end = findHeaderEnd(header) {
                    // 空行より後ろは最初のフレームである。捨てずに残す。
                    pending = Array(header[end...])
                    header = Array(header[..<end])
                    let text = String(decoding: header, as: UTF8.self)
                    // 期待するのは 101 のみ。認証はこの後の nodeHello で行うため、
                    // ここで 4023 になることはない（切断は握手後に起きる）。
                    guard text.hasPrefix("HTTP/1.1 101") else {
                        let firstLine = text.split(separator: "\r\n").first.map(String.init) ?? text
                        return .handshakeFailed("101 が返らなかった: \(firstLine)")
                    }
                    // Sec-WebSocket-Accept の検証は行わない。相手は自分が立てた
                    // 局所実行環境であり、中間者を想定する状況ではない。
                    return nil
                }
                if header.count > 64 * 1024 {
                    return .handshakeFailed("応答の頭が大きすぎる")
                }
            }
        }
    }

    private func findHeaderEnd(_ bytes: [UInt8]) -> Int? {
        if bytes.count < 4 {
            return nil
        }
        for index in 0...(bytes.count - 4) {
            if bytes[index] == 0x0d, bytes[index + 1] == 0x0a, bytes[index + 2] == 0x0d,
                bytes[index + 3] == 0x0a
            {
                return index + 4
            }
        }
        return nil
    }

    func disconnect() {
        close(descriptor)
    }

    // MARK: - 送信

    func send(text: String) -> WebSocketError? {
        sendFrame(opcode: 0x1, payload: Array(text.utf8))
    }

    func send(binary: [UInt8]) -> WebSocketError? {
        sendFrame(opcode: 0x2, payload: binary)
    }

    /// 1 フレームを組んで送る。クライアントは必ずマスクする（RFC 6455 5.3）。
    private func sendFrame(opcode: UInt8, payload: [UInt8]) -> WebSocketError? {
        var frame: [UInt8] = [0x80 | opcode]
        let length = payload.count
        if length < 126 {
            frame.append(0x80 | UInt8(length))
        } else if length < 65536 {
            frame.append(0x80 | 126)
            frame.append(UInt8(truncatingIfNeeded: length >> 8))
            frame.append(UInt8(truncatingIfNeeded: length))
        } else {
            frame.append(0x80 | 127)
            var shift = 56
            while shift >= 0 {
                frame.append(UInt8(truncatingIfNeeded: length >> shift))
                shift -= 8
            }
        }
        var mask: [UInt8] = []
        for _ in 0..<4 {
            mask.append(UInt8.random(in: 0...255))
        }
        frame.append(contentsOf: mask)
        for (index, byte) in payload.enumerated() {
            frame.append(byte ^ mask[index % 4])
        }
        return writeAll(frame)
    }

    // MARK: - 受信

    /// 1 フレームを受け取る。断片は連結し、ping には pong を返す。
    /// 制御フレーム（pong など）は読み飛ばして次を待つ。
    func receive() -> Result<WebSocketFrame, WebSocketError> {
        while true {
            guard let header = try? peekBytes(2) else {
                return .failure(.ioFailed("フレームの頭が読めない"))
            }
            let isFinal = (header[0] & 0x80) != 0
            let opcode = header[0] & 0x0f
            let masked = (header[1] & 0x80) != 0
            let short = Int(header[1] & 0x7f)
            var offset = 2
            var length = short
            if short == 126 {
                guard let extended = try? peekBytes(4) else {
                    return .failure(.ioFailed("長さ（16 ビット）が読めない"))
                }
                length = Int(extended[2]) << 8 | Int(extended[3])
                offset = 4
            } else if short == 127 {
                guard let extended = try? peekBytes(10) else {
                    return .failure(.ioFailed("長さ（64 ビット）が読めない"))
                }
                var value = 0
                for index in 2..<10 {
                    value = value << 8 | Int(extended[index])
                }
                length = value
                offset = 10
            }
            // サーバからの送信はマスクされない（RFC 6455 5.1）。来た場合も鍵の分だけ進める。
            let maskLength = masked ? 4 : 0
            let total = offset + maskLength + length
            guard let whole = try? peekBytes(total) else {
                return .failure(.ioFailed("本体が読めない（\(total) バイト）"))
            }
            var payload = Array(whole[(offset + maskLength)..<total])
            if masked {
                let mask = Array(whole[offset..<(offset + 4)])
                for index in payload.indices {
                    payload[index] = payload[index] ^ mask[index % 4]
                }
            }
            pending.removeFirst(total)

            switch opcode {
            case 0x0:
                fragment.append(contentsOf: payload)
                if isFinal {
                    let joined = fragment
                    let kind = fragmentOpcode
                    fragment = []
                    fragmentOpcode = 0
                    if kind == 0x1 {
                        return .success(.text(String(decoding: joined, as: UTF8.self)))
                    }
                    return .success(.binary(joined))
                }
            case 0x1, 0x2:
                if isFinal {
                    if opcode == 0x1 {
                        return .success(.text(String(decoding: payload, as: UTF8.self)))
                    }
                    return .success(.binary(payload))
                }
                fragment = payload
                fragmentOpcode = opcode
            case 0x8:
                var code: UInt16 = 1005
                var reason = ""
                if payload.count >= 2 {
                    code = UInt16(payload[0]) << 8 | UInt16(payload[1])
                    reason = String(decoding: payload[2...], as: UTF8.self)
                }
                return .success(.closed(code: code, reason: reason))
            case 0x9:
                // ping には pong を返す。返さないと相手が切ることがある。
                if let failure = sendFrame(opcode: 0xa, payload: payload) {
                    return .failure(failure)
                }
            default:
                // pong などは読み飛ばす。
                break
            }
        }
    }

    // MARK: - 下位の入出力

    /// 少なくとも count バイトが溜まるまで読み、溜まった全体を返す（消費はしない）。
    private func peekBytes(_ count: Int) throws -> [UInt8] {
        while pending.count < count {
            let chunk = try readSome(limit: max(count - pending.count, 4096)).get()
            if chunk.isEmpty {
                throw WebSocketError.ioFailed("相手が閉じた")
            }
            pending.append(contentsOf: chunk)
        }
        return pending
    }

    private func readSome(limit: Int) -> Result<[UInt8], WebSocketError> {
        var buffer = [UInt8](repeating: 0, count: limit)
        let received = buffer.withUnsafeMutableBytes { raw -> Int in
            guard let base = raw.baseAddress else {
                return -1
            }
            return recv(descriptor, base, limit, 0)
        }
        if received < 0 {
            return .failure(.ioFailed("recv が失敗した（時間切れの可能性）"))
        }
        return .success(Array(buffer[0..<received]))
    }

    private func writeAll(_ bytes: [UInt8]) -> WebSocketError? {
        var sent = 0
        while sent < bytes.count {
            let written = bytes.withUnsafeBytes { raw -> Int in
                guard let base = raw.baseAddress else {
                    return -1
                }
                return systemSend(descriptor, base + sent, bytes.count - sent, 0)
            }
            if written <= 0 {
                return .ioFailed("send が失敗した")
            }
            sent += written
        }
        return nil
    }
}
