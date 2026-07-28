//! 疎通試験（Rust、段 B）。
//!
//! 何を証明するか: Rust の SDK が**実際の Durable Object**（partykit dev）へ WebSocket で
//! 接続し、実際に符号化された AV1（spec/vectors/real-media.json）を送り、購読者として
//! **1 バイトも変わらずに**受け取れること。段 A（凍結ベクタ・トレース・実データ照合）は
//! 判断とバイト列の同一性を示すが、実際に線を通ることは示さない。
//!
//! 依存を追加しない: WebSocket は tests/support/websocket.rs（自前の RFC 6455）、
//! HMAC は tests/support/digest.rs（自前）を使う。どちらも試験の中だけに置く。
//!
//! 実行の前提: 実環境（PartyKit managed）へデプロイされていること。環境変数で場所と鍵を受け取る
//! （WHESO_WS_BASE / WHESO_ROOM / WHESO_NODE_KEY / WHESO_SENDER_PK / WHESO_SUB_PK）。
//! 無い場合は飛ばす。起動は tools/transport-suite.ts の責務である。

mod support;

use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

use support::digest::{base64_url_no_pad, bytes_to_hex, hex_to_bytes, hmac_sha256, sha256};
use support::websocket::{Frame, WebSocketClient};

/// 時刻窓の長さ。認証規範の NODE_AUTH_TIME_WINDOW_SEC と一致させる。
const TIME_WINDOW_SEC: u64 = 300;

/// 送る枚数。全部送ると試験が長くなるため先頭に限る（キーフレームを含む）。
const SEND_COUNT: usize = 10;

fn asset_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop();
    path.pop();
    path.push("spec");
    path.push("vectors");
    path.push("real-media.json");
    path
}

/// nodeHello の authTag を作る。
/// 会議シークレット = HMAC(鍵, "meeting-secret:v1:<会議 ID>")
/// authTag = base64url(HMAC(会議シークレット, "node-auth:v1:<部屋名>:<役割>:<時刻窓>"))
/// 参照実装（packages/core/src/auth.ts）と 1 文字でも違えば 4023 で切られる。
fn build_auth_tag(key: &str, room: &str, role: &str) -> String {
    let meeting_id = room.split('-').nth(1).unwrap_or("");
    let secret = hmac_sha256(key.as_bytes(), format!("meeting-secret:v1:{meeting_id}").as_bytes());
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    let window = seconds / TIME_WINDOW_SEC;
    let tag = hmac_sha256(
        &secret,
        format!("node-auth:v1:{room}:{role}:{window}").as_bytes(),
    );
    base64_url_no_pad(&tag)
}

/// 自前の SHA-256 と HMAC が既知の答えと一致することを先に確かめる。
/// 誤ったまま疎通試験を回すと、接続拒否の原因が実装か手順か切り分けられない。
#[test]
fn digest_matches_known_answers() {
    // FIPS 180-4 の例。
    assert_eq!(
        bytes_to_hex(&sha256(b"abc")),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        bytes_to_hex(&sha256(b"")),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    // 64 バイト境界を跨ぐ長さ（詰め物の分岐を通す）。
    let long = vec![b'a'; 1000];
    assert_eq!(
        bytes_to_hex(&sha256(&long)),
        "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"
    );

    // RFC 4231 のベクタ 1・2・3・6。
    assert_eq!(
        bytes_to_hex(&hmac_sha256(&[0x0b; 20], b"Hi There")),
        "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
    );
    assert_eq!(
        bytes_to_hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    );
    assert_eq!(
        bytes_to_hex(&hmac_sha256(&[0xaa; 20], &[0xdd; 50])),
        "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"
    );
    assert_eq!(
        bytes_to_hex(&hmac_sha256(
            &[0xaa; 131],
            b"Test Using Larger Than Block-Size Key - Hash Key First"
        )),
        "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
    );

    // base64url は詰め物を付けない。期待値は標準 base64 からの置換で導いた。
    assert_eq!(base64_url_no_pad(&[0xff]), "_w");
    assert_eq!(base64_url_no_pad(&[0xff, 0xfe]), "__4");
    assert_eq!(base64_url_no_pad(&[0xff, 0xfe, 0xfd]), "__79");
}

#[test]
fn real_media_travels_through_live_node() {
    let (Ok(base), Ok(room), Ok(key), Ok(sender_pk), Ok(sub_pk)) = (
        env::var("WHESO_WS_BASE"),
        env::var("WHESO_ROOM"),
        env::var("WHESO_NODE_KEY"),
        env::var("WHESO_SENDER_PK"),
        env::var("WHESO_SUB_PK"),
    ) else {
        // 局所実行環境が無い場所では飛ばす。実行器が環境変数を与える。
        println!("SKIP 疎通試験（環境変数が無い）");
        return;
    };

    // 実環境へは TLS の終端を経由して繋ぐため、Host ヘッダに実環境の名前を書く。
    let host_header = env::var("WHESO_WS_HOST").ok();

    let Ok(text) = fs::read_to_string(asset_path()) else {
        assert!(false, "資産が読めない");
        return;
    };
    let Ok(asset) = serde_json::from_str::<Value>(&text) else {
        assert!(false, "資産が JSON として読めない");
        return;
    };
    let frames = asset["video"]["frames"].as_array().cloned().unwrap_or_default();
    let sender_id = asset["senderId"].as_u64().unwrap_or(0);
    let channel = asset["video"]["channel"].as_u64().unwrap_or(0);
    let framerate = asset["video"]["framerate"].as_u64().unwrap_or(30).max(1);
    assert!(frames.len() >= SEND_COUNT, "資産に {SEND_COUNT} 枚以上ある");

    // 購読側を先に開く。順序を逆にすると転送先が無く、送ったものが消える。
    let mut subscriber = match WebSocketClient::connect(
        &format!("{base}/parties/shard/{room}?_pk={sub_pk}"),
        host_header.as_deref(),
        Duration::from_secs(30),
    ) {
        Ok(client) => client,
        Err(error) => {
            assert!(false, "購読側が繋がらない: {error}");
            return;
        }
    };
    let receiver_tag = build_auth_tag(&key, &room, "receiver");
    assert!(
        subscriber
            .send_text(&format!(
                "{{\"t\":\"nodeHello\",\"role\":\"receiver\",\"nodeId\":\"{room}\",\"authTag\":\"{receiver_tag}\"}}"
            ))
            .is_ok(),
        "購読側の nodeHello が送れる"
    );
    assert!(
        subscriber
            .send_text(&format!(
                "{{\"t\":\"subscribe\",\"entries\":[{{\"senderId\":{sender_id},\"channel\":{channel},\"maxSpatialId\":3,\"maxTemporalId\":7}}]}}"
            ))
            .is_ok(),
        "購読が送れる"
    );

    // 受信を先に仕掛ける。仕掛ける前に送ると取りこぼす。
    let inbox: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let collected = Arc::clone(&inbox);
    let pump = thread::spawn(move || {
        loop {
            match subscriber.receive() {
                Ok(Frame::Binary(bytes)) => {
                    let mut guard = match collected.lock() {
                        Ok(guard) => guard,
                        Err(_) => return,
                    };
                    guard.push(bytes_to_hex(&bytes));
                    if guard.len() >= SEND_COUNT {
                        return;
                    }
                }
                // 制御メッセージ（nodeHelloAck など）は数えない。
                Ok(Frame::Text(_)) => {}
                Ok(Frame::Closed { code, reason }) => {
                    // 認証に失敗すると 4023（E_NODE_AUTH）で切られる。原因を残す。
                    println!("購読側が閉じられた: {code} {reason}");
                    return;
                }
                Err(error) => {
                    println!("購読側の受信が終わった: {error}");
                    return;
                }
            }
        }
    });

    // 購読の登録が処理される猶予を置く。
    thread::sleep(Duration::from_millis(1000));

    let mut sender = match WebSocketClient::connect(
        &format!("{base}/parties/shard/{room}?_pk={sender_pk}"),
        host_header.as_deref(),
        Duration::from_secs(30),
    ) {
        Ok(client) => client,
        Err(error) => {
            assert!(false, "送信側が繋がらない: {error}");
            return;
        }
    };
    let sender_tag = build_auth_tag(&key, &room, "sender");
    assert!(
        sender
            .send_text(&format!(
                "{{\"t\":\"nodeHello\",\"role\":\"sender\",\"nodeId\":\"{room}\",\"authTag\":\"{sender_tag}\"}}"
            ))
            .is_ok(),
        "送信側の nodeHello が送れる"
    );
    thread::sleep(Duration::from_millis(500));

    let mut sent_hex: Vec<String> = Vec::new();
    for index in 0..SEND_COUNT {
        let hex = frames
            .get(index)
            .and_then(|frame| frame["expectedMessageHex"].as_str())
            .unwrap_or("");
        assert!(!hex.is_empty(), "{index} 番目に期待バイト列がある");
        sent_hex.push(hex.to_string());
        assert!(
            sender.send_binary(&hex_to_bytes(hex)).is_ok(),
            "{index} 番目が送れる"
        );
        // 実際の間隔で送る。詰めて送ると予算超過の破棄が働き、疎通の検証にならない。
        thread::sleep(Duration::from_millis(1000 / framerate));
    }

    // 転送は非同期であるため、送り終えた時点では届いていない。揃うまで待つ。
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let count = inbox.lock().map(|guard| guard.len()).unwrap_or(0);
        if count >= SEND_COUNT || Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let received: Vec<String> = inbox.lock().map(|guard| guard.clone()).unwrap_or_default();
    let _ = pump.join();

    assert_eq!(received.len(), SEND_COUNT, "購読者が {SEND_COUNT} 件を受け取る");
    for index in 0..SEND_COUNT {
        assert_eq!(
            received.get(index),
            sent_hex.get(index),
            "{index} 番目のバイト列が 1 バイトも変わらない"
        );
    }
}
