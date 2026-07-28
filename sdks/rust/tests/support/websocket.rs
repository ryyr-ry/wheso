//! RFC 6455 の最小 WebSocket クライアント（Rust の試験用）。
//!
//! なぜ自前で書くか: tungstenite / tokio を足すと依存木が大きくなる（SDK 本体は依存を持たない。
//! licensing.md）。疎通試験に要るのは握手と送受信だけであり、標準ライブラリの TcpStream で足りる。
//!
//! 実装の範囲は疎通試験に要るものだけである。
//!   握手（HTTP Upgrade）、テキスト送信、バイナリ送信、フレーム受信、close の検出。
//!   拡張（permessage-deflate）と断片の送信は行わない。受信の断片は繋ぐ。
//! クライアントからの送信は必ずマスクする（RFC 6455 5.3）。
//!
//! unwrap / expect / panic! / unsafe を使わない（AGENTS 5.4）。失敗は Result で返す。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::digest::base64_standard;

#[derive(Debug)]
pub enum WsError {
    BadUrl(String),
    Connect(String),
    Handshake(String),
    Io(String),
}

impl std::fmt::Display for WsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WsError::BadUrl(text) => write!(formatter, "URL が読めない: {text}"),
            WsError::Connect(text) => write!(formatter, "接続できない: {text}"),
            WsError::Handshake(text) => write!(formatter, "握手が失敗した: {text}"),
            WsError::Io(text) => write!(formatter, "入出力が失敗した: {text}"),
        }
    }
}

/// 受信したフレーム。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Text(String),
    Binary(Vec<u8>),
    Closed { code: u16, reason: String },
}

/// HTTP の頭の終わり（空行）を探す。フレームは空行の直後から始まる。
fn find_header_end(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 4 {
        return None;
    }
    for index in 0..=(bytes.len() - 4) {
        if bytes.get(index) == Some(&0x0d)
            && bytes.get(index + 1) == Some(&0x0a)
            && bytes.get(index + 2) == Some(&0x0d)
            && bytes.get(index + 3) == Some(&0x0a)
        {
            return Some(index + 4);
        }
    }
    None
}

pub struct WebSocketClient {
    stream: TcpStream,
    /// 受信の途中で余った分。フレーム境界とパケット境界は一致しない。
    pending: Vec<u8>,
    fragment: Vec<u8>,
    fragment_opcode: u8,
}

impl WebSocketClient {
    /// `ws://host:port/path?query` へ接続して握手を済ませる。平文のみを扱う。
    /// host_header を与えると Host ヘッダをそれで書く。TLS の終端を経由して実環境へ
    /// 中継する場合、Host が 127.0.0.1 だと相手が部屋を引けないため必ず与える。
    pub fn connect(
        url: &str,
        host_header: Option<&str>,
        read_timeout: Duration,
    ) -> Result<Self, WsError> {
        let rest = url
            .strip_prefix("ws://")
            .ok_or_else(|| WsError::BadUrl(format!("ws:// で始まらない: {url}")))?;
        let slash = rest
            .find('/')
            .ok_or_else(|| WsError::BadUrl(format!("経路が無い: {url}")))?;
        let authority = rest.get(..slash).unwrap_or("");
        let path = rest.get(slash..).unwrap_or("/");

        let stream =
            TcpStream::connect(authority).map_err(|error| WsError::Connect(error.to_string()))?;
        // 受信で無限に待たない。相手が黙った場合に試験が固まるのを防ぐ。
        stream
            .set_read_timeout(Some(read_timeout))
            .map_err(|error| WsError::Connect(error.to_string()))?;

        let mut client = Self {
            stream,
            pending: Vec::new(),
            fragment: Vec::new(),
            fragment_opcode: 0,
        };
        client.handshake(host_header.unwrap_or(authority), path)?;
        Ok(client)
    }

    fn handshake(&mut self, authority: &str, path: &str) -> Result<(), WsError> {
        // 握手鍵は 16 バイトの任意値である。乱数の質は問われない（RFC 6455 4.1）。
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.subsec_nanos())
            .unwrap_or(0);
        let mut seed = [0u8; 16];
        for (index, slot) in seed.iter_mut().enumerate() {
            *slot = (nanos.wrapping_mul(index as u32 + 1) & 0xff) as u8;
        }
        let key = base64_standard(&seed);
        let request = format!(
            "GET {path} HTTP/1.1\r\nHost: {authority}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        self.stream
            .write_all(request.as_bytes())
            .map_err(|error| WsError::Handshake(error.to_string()))?;

        let mut header: Vec<u8> = Vec::new();
        loop {
            let chunk = self.read_some(1024)?;
            if chunk.is_empty() {
                return Err(WsError::Handshake("応答が途切れた".to_string()));
            }
            header.extend_from_slice(&chunk);
            if let Some(end) = find_header_end(&header) {
                // 空行より後ろは最初のフレームである。捨てずに残す。
                self.pending = header.get(end..).unwrap_or(&[]).to_vec();
                let text = String::from_utf8_lossy(header.get(..end).unwrap_or(&[])).to_string();
                if !text.starts_with("HTTP/1.1 101") {
                    let first = text.lines().next().unwrap_or("").to_string();
                    return Err(WsError::Handshake(format!("101 が返らなかった: {first}")));
                }
                // Sec-WebSocket-Accept の検証は行わない。相手は自分が立てた局所実行環境であり、
                // 中間者を想定する状況ではない。
                return Ok(());
            }
            if header.len() > 64 * 1024 {
                return Err(WsError::Handshake("応答の頭が大きすぎる".to_string()));
            }
        }
    }

    pub fn send_text(&mut self, text: &str) -> Result<(), WsError> {
        self.send_frame(0x1, text.as_bytes())
    }

    pub fn send_binary(&mut self, bytes: &[u8]) -> Result<(), WsError> {
        self.send_frame(0x2, bytes)
    }

    /// 1 フレームを組んで送る。クライアントは必ずマスクする（RFC 6455 5.3）。
    fn send_frame(&mut self, opcode: u8, payload: &[u8]) -> Result<(), WsError> {
        let mut frame: Vec<u8> = vec![0x80 | opcode];
        let length = payload.len();
        if length < 126 {
            frame.push(0x80 | (length as u8));
        } else if length < 65536 {
            frame.push(0x80 | 126);
            frame.push((length >> 8) as u8);
            frame.push(length as u8);
        } else {
            frame.push(0x80 | 127);
            for shift in (0..64).step_by(8).rev() {
                frame.push(((length as u64) >> shift) as u8);
            }
        }
        // マスク鍵も任意値である。固定でも規範に反しないが、時刻から作る。
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.subsec_nanos())
            .unwrap_or(0);
        let mask = [
            (nanos & 0xff) as u8,
            ((nanos >> 8) & 0xff) as u8,
            ((nanos >> 16) & 0xff) as u8,
            ((nanos >> 24) & 0xff) as u8,
        ];
        frame.extend_from_slice(&mask);
        for (index, byte) in payload.iter().enumerate() {
            let key = mask.get(index % 4).copied().unwrap_or(0);
            frame.push(byte ^ key);
        }
        self.stream
            .write_all(&frame)
            .map_err(|error| WsError::Io(error.to_string()))
    }

    /// 1 フレームを受け取る。断片は連結し、ping には pong を返す。
    pub fn receive(&mut self) -> Result<Frame, WsError> {
        loop {
            let header = self.peek(2)?;
            let first = header.first().copied().unwrap_or(0);
            let second = header.get(1).copied().unwrap_or(0);
            let is_final = (first & 0x80) != 0;
            let opcode = first & 0x0f;
            let masked = (second & 0x80) != 0;
            let short = usize::from(second & 0x7f);
            let (mut offset, mut length) = (2usize, short);
            if short == 126 {
                let extended = self.peek(4)?;
                length = (usize::from(extended.get(2).copied().unwrap_or(0)) << 8)
                    | usize::from(extended.get(3).copied().unwrap_or(0));
                offset = 4;
            } else if short == 127 {
                let extended = self.peek(10)?;
                let mut value: usize = 0;
                for index in 2..10 {
                    value = (value << 8) | usize::from(extended.get(index).copied().unwrap_or(0));
                }
                length = value;
                offset = 10;
            }
            // サーバからの送信はマスクされない（RFC 6455 5.1）。来た場合も鍵の分だけ進める。
            let mask_length = if masked { 4 } else { 0 };
            let total = offset + mask_length + length;
            let whole = self.peek(total)?;
            let mut payload = whole
                .get((offset + mask_length)..total)
                .unwrap_or(&[])
                .to_vec();
            if masked {
                let mask = whole.get(offset..(offset + 4)).unwrap_or(&[]).to_vec();
                for index in 0..payload.len() {
                    let key = mask.get(index % 4).copied().unwrap_or(0);
                    if let Some(slot) = payload.get_mut(index) {
                        *slot ^= key;
                    }
                }
            }
            if total <= self.pending.len() {
                self.pending.drain(..total);
            }

            match opcode {
                0x0 => {
                    self.fragment.extend_from_slice(&payload);
                    if is_final {
                        let joined = std::mem::take(&mut self.fragment);
                        let kind = self.fragment_opcode;
                        self.fragment_opcode = 0;
                        if kind == 0x1 {
                            return Ok(Frame::Text(String::from_utf8_lossy(&joined).to_string()));
                        }
                        return Ok(Frame::Binary(joined));
                    }
                }
                0x1 | 0x2 => {
                    if is_final {
                        if opcode == 0x1 {
                            return Ok(Frame::Text(String::from_utf8_lossy(&payload).to_string()));
                        }
                        return Ok(Frame::Binary(payload));
                    }
                    self.fragment = payload;
                    self.fragment_opcode = opcode;
                }
                0x8 => {
                    let mut code = 1005u16;
                    let mut reason = String::new();
                    if payload.len() >= 2 {
                        code = (u16::from(payload.first().copied().unwrap_or(0)) << 8)
                            | u16::from(payload.get(1).copied().unwrap_or(0));
                        reason =
                            String::from_utf8_lossy(payload.get(2..).unwrap_or(&[])).to_string();
                    }
                    return Ok(Frame::Closed { code, reason });
                }
                0x9 => {
                    // ping には pong を返す。返さないと相手が切ることがある。
                    self.send_frame(0xa, &payload)?;
                }
                _ => {}
            }
        }
    }

    /// 少なくとも count バイトが溜まるまで読み、溜まった全体を返す（消費はしない）。
    fn peek(&mut self, count: usize) -> Result<Vec<u8>, WsError> {
        while self.pending.len() < count {
            let want = count.saturating_sub(self.pending.len()).max(4096);
            let chunk = self.read_some(want)?;
            if chunk.is_empty() {
                return Err(WsError::Io("相手が閉じた".to_string()));
            }
            self.pending.extend_from_slice(&chunk);
        }
        Ok(self.pending.clone())
    }

    fn read_some(&mut self, limit: usize) -> Result<Vec<u8>, WsError> {
        let mut buffer = vec![0u8; limit];
        match self.stream.read(&mut buffer) {
            Ok(received) => Ok(buffer.get(..received).unwrap_or(&[]).to_vec()),
            Err(error) => Err(WsError::Io(error.to_string())),
        }
    }
}
