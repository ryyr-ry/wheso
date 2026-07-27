// SHA-256 と HMAC-SHA256（Swift の試験用）。
//
// なぜ自前で持つか: Linux では CryptoKit が使えず、swift-crypto を足すと SDK に依存が増える
// （依存を持たない方針。ライセンス規範）。ノード間認証の照合にしか要らないため試験の中だけで持つ。
// 実装は FIPS 180-4 と RFC 2104 をそのまま写したものである。
//
// 正しさは既知の答え（RFC 4231）で確かめる（DigestTests.swift）。確かめずに使うと、
// 疎通試験が失敗したときに原因が実装なのか手順なのか切り分けられない。

import Foundation

enum WhesoDigest {
    private static let roundConstants: [UInt32] = [
        0x428a_2f98, 0x7137_4491, 0xb5c0_fbcf, 0xe9b5_dba5, 0x3956_c25b, 0x59f1_11f1, 0x923f_82a4,
        0xab1c_5ed5, 0xd807_aa98, 0x1283_5b01, 0x2431_85be, 0x550c_7dc3, 0x72be_5d74, 0x80de_b1fe,
        0x9bdc_06a7, 0xc19b_f174, 0xe49b_69c1, 0xefbe_4786, 0x0fc1_9dc6, 0x240c_a1cc, 0x2de9_2c6f,
        0x4a74_84aa, 0x5cb0_a9dc, 0x76f9_88da, 0x983e_5152, 0xa831_c66d, 0xb003_27c8, 0xbf59_7fc7,
        0xc6e0_0bf3, 0xd5a7_9147, 0x06ca_6351, 0x1429_2967, 0x27b7_0a85, 0x2e1b_2138, 0x4d2c_6dfc,
        0x5338_0d13, 0x650a_7354, 0x766a_0abb, 0x81c2_c92e, 0x9272_2c85, 0xa2bf_e8a1, 0xa81a_664b,
        0xc24b_8b70, 0xc76c_51a3, 0xd192_e819, 0xd699_0624, 0xf40e_3585, 0x106a_a070, 0x19a4_c116,
        0x1e37_6c08, 0x2748_774c, 0x34b0_bcb5, 0x391c_0cb3, 0x4ed8_aa4a, 0x5b9c_ca4f, 0x682e_6ff3,
        0x748f_82ee, 0x78a5_636f, 0x84c8_7814, 0x8cc7_0208, 0x90be_fffa, 0xa450_6ceb, 0xbef9_a3f7,
        0xc671_78f2,
    ]

    private static func rotateRight(_ value: UInt32, _ count: UInt32) -> UInt32 {
        (value >> count) | (value << (32 - count))
    }

    static func sha256(_ message: [UInt8]) -> [UInt8] {
        var hash: [UInt32] = [
            0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c, 0x1f83_d9ab,
            0x5be0_cd19,
        ]
        var padded = message
        let bitLength = UInt64(message.count) * 8
        padded.append(0x80)
        while padded.count % 64 != 56 {
            padded.append(0)
        }
        var shift = 56
        while shift >= 0 {
            padded.append(UInt8(truncatingIfNeeded: bitLength >> UInt64(shift)))
            shift -= 8
        }

        var offset = 0
        while offset + 64 <= padded.count {
            var schedule = [UInt32](repeating: 0, count: 64)
            for index in 0..<16 {
                let base = offset + index * 4
                schedule[index] = (UInt32(padded[base]) << 24) | (UInt32(padded[base + 1]) << 16)
                    | (UInt32(padded[base + 2]) << 8) | UInt32(padded[base + 3])
            }
            for index in 16..<64 {
                let previous15 = schedule[index - 15]
                let previous2 = schedule[index - 2]
                let s0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >> 3)
                let s1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >> 10)
                schedule[index] = schedule[index - 16] &+ s0 &+ schedule[index - 7] &+ s1
            }
            var a = hash[0]
            var b = hash[1]
            var c = hash[2]
            var d = hash[3]
            var e = hash[4]
            var f = hash[5]
            var g = hash[6]
            var h = hash[7]
            for index in 0..<64 {
                let s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
                let choose = (e & f) ^ (~e & g)
                let temp1 = h &+ s1 &+ choose &+ roundConstants[index] &+ schedule[index]
                let s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
                let majority = (a & b) ^ (a & c) ^ (b & c)
                let temp2 = s0 &+ majority
                h = g
                g = f
                f = e
                e = d &+ temp1
                d = c
                c = b
                b = a
                a = temp1 &+ temp2
            }
            hash[0] = hash[0] &+ a
            hash[1] = hash[1] &+ b
            hash[2] = hash[2] &+ c
            hash[3] = hash[3] &+ d
            hash[4] = hash[4] &+ e
            hash[5] = hash[5] &+ f
            hash[6] = hash[6] &+ g
            hash[7] = hash[7] &+ h
            offset += 64
        }

        var out: [UInt8] = []
        for value in hash {
            out.append(UInt8(truncatingIfNeeded: value >> 24))
            out.append(UInt8(truncatingIfNeeded: value >> 16))
            out.append(UInt8(truncatingIfNeeded: value >> 8))
            out.append(UInt8(truncatingIfNeeded: value))
        }
        return out
    }

    /// HMAC-SHA256（RFC 2104）。ブロック長は 64 バイトである。
    static func hmacSha256(key: [UInt8], message: [UInt8]) -> [UInt8] {
        let blockSize = 64
        var normalized = key
        if normalized.count > blockSize {
            normalized = sha256(normalized)
        }
        while normalized.count < blockSize {
            normalized.append(0)
        }
        var inner: [UInt8] = []
        var outer: [UInt8] = []
        for index in 0..<blockSize {
            inner.append(normalized[index] ^ 0x36)
            outer.append(normalized[index] ^ 0x5c)
        }
        return sha256(outer + sha256(inner + message))
    }

    /// base64url（詰め物なし）。認証規範の符号化に合わせる。
    static func base64UrlNoPad(_ bytes: [UInt8]) -> String {
        Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
