//! SHA-256 と HMAC-SHA256（Rust の試験用）。
//!
//! なぜ自前で持つか: ノード間認証の照合にしか要らないため、依存（sha2 / hmac）を増やさない
//! （SDK 本体は依存を持たない。licensing.md）。試験の中だけで持つ。
//! 実装は FIPS 180-4 と RFC 2104 をそのまま写したものである。
//!
//! 正しさは既知の答え（RFC 4231）で確かめる（tests/transport.rs の digest_matches_known_answers）。
//! 確かめずに使うと、疎通試験が失敗したときに原因が実装なのか手順なのか切り分けられない。
//!
//! unwrap / expect / panic! を使わない（AGENTS 5.4）。添字は範囲を確かめてから触る。

const ROUND_CONSTANTS: [u32; 64] = [
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
];

/// SHA-256（FIPS 180-4）。
pub fn sha256(message: &[u8]) -> [u8; 32] {
    let mut hash: [u32; 8] = [
        0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c, 0x1f83_d9ab,
        0x5be0_cd19,
    ];
    let mut padded = message.to_vec();
    let bit_length = (message.len() as u64) * 8;
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    for shift in (0..64).step_by(8).rev() {
        padded.push(((bit_length >> shift) & 0xff) as u8);
    }

    for block in padded.chunks_exact(64) {
        let mut schedule = [0u32; 64];
        for (index, word) in block.chunks_exact(4).enumerate() {
            // chunks_exact(4) は必ず 4 要素であるが、添字の安全のため取り出しを確かめる。
            let (Some(b0), Some(b1), Some(b2), Some(b3)) =
                (word.first(), word.get(1), word.get(2), word.get(3))
            else {
                continue;
            };
            if let Some(slot) = schedule.get_mut(index) {
                *slot = (u32::from(*b0) << 24)
                    | (u32::from(*b1) << 16)
                    | (u32::from(*b2) << 8)
                    | u32::from(*b3);
            }
        }
        for index in 16..64 {
            let previous15 = schedule.get(index - 15).copied().unwrap_or(0);
            let previous2 = schedule.get(index - 2).copied().unwrap_or(0);
            let s0 = previous15.rotate_right(7) ^ previous15.rotate_right(18) ^ (previous15 >> 3);
            let s1 = previous2.rotate_right(17) ^ previous2.rotate_right(19) ^ (previous2 >> 10);
            let sum = schedule
                .get(index - 16)
                .copied()
                .unwrap_or(0)
                .wrapping_add(s0)
                .wrapping_add(schedule.get(index - 7).copied().unwrap_or(0))
                .wrapping_add(s1);
            if let Some(slot) = schedule.get_mut(index) {
                *slot = sum;
            }
        }

        let mut a = hash[0];
        let mut b = hash[1];
        let mut c = hash[2];
        let mut d = hash[3];
        let mut e = hash[4];
        let mut f = hash[5];
        let mut g = hash[6];
        let mut h = hash[7];
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choose = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(choose)
                .wrapping_add(ROUND_CONSTANTS.get(index).copied().unwrap_or(0))
                .wrapping_add(schedule.get(index).copied().unwrap_or(0));
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        hash[0] = hash[0].wrapping_add(a);
        hash[1] = hash[1].wrapping_add(b);
        hash[2] = hash[2].wrapping_add(c);
        hash[3] = hash[3].wrapping_add(d);
        hash[4] = hash[4].wrapping_add(e);
        hash[5] = hash[5].wrapping_add(f);
        hash[6] = hash[6].wrapping_add(g);
        hash[7] = hash[7].wrapping_add(h);
    }

    let mut out = [0u8; 32];
    for (index, value) in hash.iter().enumerate() {
        let base = index * 4;
        if let Some(slot) = out.get_mut(base) {
            *slot = (value >> 24) as u8;
        }
        if let Some(slot) = out.get_mut(base + 1) {
            *slot = (value >> 16) as u8;
        }
        if let Some(slot) = out.get_mut(base + 2) {
            *slot = (value >> 8) as u8;
        }
        if let Some(slot) = out.get_mut(base + 3) {
            *slot = *value as u8;
        }
    }
    out
}

/// HMAC-SHA256（RFC 2104）。ブロック長は 64 バイトである。
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK_SIZE: usize = 64;
    let mut normalized = if key.len() > BLOCK_SIZE {
        sha256(key).to_vec()
    } else {
        key.to_vec()
    };
    while normalized.len() < BLOCK_SIZE {
        normalized.push(0);
    }
    let mut inner = Vec::with_capacity(BLOCK_SIZE + message.len());
    let mut outer = Vec::with_capacity(BLOCK_SIZE + 32);
    for byte in normalized.iter().take(BLOCK_SIZE) {
        inner.push(byte ^ 0x36);
        outer.push(byte ^ 0x5c);
    }
    inner.extend_from_slice(message);
    let inner_hash = sha256(&inner);
    outer.extend_from_slice(&inner_hash);
    sha256(&outer)
}

/// base64（標準の英数字表）。詰め物の有無は呼び出し側が選ぶ。
fn base64_encode(bytes: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk.first().copied().unwrap_or(0);
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        let triple = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        let indexes = [
            ((triple >> 18) & 0x3f) as usize,
            ((triple >> 12) & 0x3f) as usize,
            ((triple >> 6) & 0x3f) as usize,
            (triple & 0x3f) as usize,
        ];
        let keep = chunk.len() + 1;
        for (position, index) in indexes.iter().enumerate() {
            if position < keep {
                if let Some(symbol) = alphabet.get(*index) {
                    out.push(char::from(*symbol));
                }
            } else if pad {
                out.push('=');
            }
        }
    }
    out
}

/// base64url（詰め物なし）。認証規範の符号化に合わせる。
pub fn base64_url_no_pad(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    base64_encode(bytes, ALPHABET, false)
}

/// base64（標準・詰め物あり）。WebSocket の握手鍵に使う。
pub fn base64_standard(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    base64_encode(bytes, ALPHABET, true)
}

pub fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub fn hex_to_bytes(hex: &str) -> Vec<u8> {
    let chars: Vec<char> = hex.chars().collect();
    let mut bytes = Vec::with_capacity(chars.len() / 2);
    let mut index = 0;
    while index + 1 < chars.len() {
        let high = chars.get(index).and_then(|c| c.to_digit(16)).unwrap_or(0);
        let low = chars.get(index + 1).and_then(|c| c.to_digit(16)).unwrap_or(0);
        bytes.push(((high << 4) | low) as u8);
        index += 2;
    }
    bytes
}
