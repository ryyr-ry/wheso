/**
 * 認証と認可の検証。
 *
 * 実行: node tools/auth.ts
 *
 * 検証内容:
 *   1. base64url の往復一致
 *   2. HMAC-SHA256 が RFC 4231 のテストベクタと一致する
 *   3. 正当なトークンが受理される
 *   4. 改竄、期限切れ、aud 不一致、部屋不一致、種別違いが拒否される
 *   5. ノード間認証タグの検証と時刻窓の境界処理
 */
import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEquals,
  deriveMeetingSecret,
  hmacSha256,
  issueToken,
  nodeAuthTag,
  nodeAuthTimeWindow,
  verifyClientToken,
  verifyNodeAuthTag,
  type TokenClaims,
} from "../packages/core/src/auth.ts";
import { personalRoom, shardRoom } from "../packages/core/src/naming.ts";

const MEETING_ID = "01jxy8kq2r3mz5v7h9abcderfa";
const OTHER_MEETING_ID = "01jxy8kq2r3mz5v7h9abcderfb";
const USER_A = "550e8400e29b41d4a716446655440000";
const USER_B = "6ba7b8109dad11d180b400c04fd430c8";
const NOW = 1_784_973_771;

let failures = 0;

function check(condition: boolean, label: string): void {
  if (!condition) {
    failures += 1;
    process.stdout.write(`FAIL ${label}\n`);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function baseClaims(): TokenClaims {
  return {
    iss: "wheso-auth",
    sub: USER_A,
    aud: MEETING_ID,
    iat: NOW,
    exp: NOW + 60,
    jti: "0000000000000001",
    kind: "client",
    role: "host",
  };
}

async function main(): Promise<void> {
  const key = new TextEncoder().encode("test-signing-key-do-not-use-in-production");
  const nodeKey = new TextEncoder().encode("test-node-key-do-not-use-in-production");

  // 1. base64url の往復
  for (const length of [0, 1, 2, 3, 4, 5, 31, 32, 64]) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      bytes[i] = (i * 37 + 11) & 0xff;
    }
    const encoded = base64UrlEncode(bytes);
    const decoded = base64UrlDecode(encoded);
    check(decoded.ok && bytesToHex(decoded.value) === bytesToHex(bytes), `base64url 往復 length=${length}`);
    check(!encoded.includes("=") && !encoded.includes("+") && !encoded.includes("/"), `base64url 文字集合 length=${length}`);
  }

  // 2. HMAC-SHA256 が RFC 4231 テストケース 1 と一致すること
  //    key = 0x0b × 20, data = "Hi There"
  //    期待値 = b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7
  const rfcKey = hexToBytes("0b".repeat(20));
  const rfcResult = await hmacSha256(rfcKey, "Hi There");
  check(
    rfcResult.ok &&
      bytesToHex(rfcResult.value) === "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    "HMAC-SHA256 が RFC 4231 テストケース 1 と一致",
  );

  // 3. 定数時間比較
  check(constantTimeEquals(hexToBytes("00ff"), hexToBytes("00ff")), "定数時間比較 一致");
  check(!constantTimeEquals(hexToBytes("00ff"), hexToBytes("00fe")), "定数時間比較 不一致");
  check(!constantTimeEquals(hexToBytes("00ff"), hexToBytes("00ffaa")), "定数時間比較 長さ違い");

  // 4. 正当なトークン
  const ctlRoom = personalRoom("ctl", MEETING_ID, USER_A);
  const vsRoom = personalRoom("vs", MEETING_ID, USER_A);
  if (!ctlRoom.ok || !vsRoom.ok) {
    process.stdout.write("FAIL 部屋名生成\n");
    process.exitCode = 1;
    return;
  }
  const token = await issueToken(key, baseClaims());
  if (!token.ok) {
    process.stdout.write("FAIL トークン発行\n");
    process.exitCode = 1;
    return;
  }
  const good = await verifyClientToken({
    keyBytes: key,
    token: token.value,
    expectedMeetingId: MEETING_ID,
    roomName: ctlRoom.value,
    nowSec: NOW + 1,
  });
  check(good.ok, `正当なトークンが受理される${good.ok ? "" : ` (${good.error.code})`}`);

  const goodVs = await verifyClientToken({
    keyBytes: key,
    token: token.value,
    expectedMeetingId: MEETING_ID,
    roomName: vsRoom.value,
    nowSec: NOW + 1,
  });
  check(goodVs.ok, "同一利用者の映像送信部屋も受理される");

  // 5. 拒否されるべき場合
  const tampered = `${token.value.slice(0, -2)}${token.value.endsWith("aa") ? "bb" : "aa"}`;
  const tamperedResult = await verifyClientToken({
    keyBytes: key,
    token: tampered,
    expectedMeetingId: MEETING_ID,
    roomName: ctlRoom.value,
    nowSec: NOW + 1,
  });
  check(!tamperedResult.ok && tamperedResult.error.code === "E_AUTH", "署名改竄を拒否");

  const wrongKey = new TextEncoder().encode("another-key");
  const wrongKeyResult = await verifyClientToken({
    keyBytes: wrongKey,
    token: token.value,
    expectedMeetingId: MEETING_ID,
    roomName: ctlRoom.value,
    nowSec: NOW + 1,
  });
  check(!wrongKeyResult.ok && wrongKeyResult.error.code === "E_AUTH", "鍵違いを拒否");

  const expiredResult = await verifyClientToken({
    keyBytes: key,
    token: token.value,
    expectedMeetingId: MEETING_ID,
    roomName: ctlRoom.value,
    nowSec: NOW + 61,
  });
  check(!expiredResult.ok && expiredResult.error.code === "E_AUTH_EXPIRED", "期限切れを拒否");

  const audResult = await verifyClientToken({
    keyBytes: key,
    token: token.value,
    expectedMeetingId: OTHER_MEETING_ID,
    roomName: ctlRoom.value,
    nowSec: NOW + 1,
  });
  check(!audResult.ok && audResult.error.code === "E_AUTH_AUDIENCE", "会議 ID 不一致を拒否");

  const otherUserRoom = personalRoom("ctl", MEETING_ID, USER_B);
  if (otherUserRoom.ok) {
    const roomResult = await verifyClientToken({
      keyBytes: key,
      token: token.value,
      expectedMeetingId: MEETING_ID,
      roomName: otherUserRoom.value,
      nowSec: NOW + 1,
    });
    check(!roomResult.ok && roomResult.error.code === "E_AUTH_ROOM", "他利用者の個人部屋への接続を拒否");
  }

  const shard = shardRoom("vsh", MEETING_ID, "auto", 1, 0);
  if (shard.ok) {
    const shardResult = await verifyClientToken({
      keyBytes: key,
      token: token.value,
      expectedMeetingId: MEETING_ID,
      roomName: shard.value,
      nowSec: NOW + 1,
    });
    check(!shardResult.ok && shardResult.error.code === "E_AUTH_ROOM", "クライアントのシャード直結を拒否");
  }

  const nodeKindToken = await issueToken(key, { ...baseClaims(), kind: "node" });
  if (nodeKindToken.ok) {
    const kindResult = await verifyClientToken({
      keyBytes: key,
      token: nodeKindToken.value,
      expectedMeetingId: MEETING_ID,
      roomName: ctlRoom.value,
      nowSec: NOW + 1,
    });
    check(!kindResult.ok && kindResult.error.code === "E_AUTH_KIND", "node 種別のトークンをクライアント経路で拒否");
  }

  const longLived = await issueToken(key, { ...baseClaims(), exp: NOW + 3600 });
  if (longLived.ok) {
    const longResult = await verifyClientToken({
      keyBytes: key,
      token: longLived.value,
      expectedMeetingId: MEETING_ID,
      roomName: ctlRoom.value,
      nowSec: NOW + 1,
    });
    check(!longResult.ok && longResult.error.code === "E_AUTH", "有効期間が長すぎるトークンを拒否");
  }

  // 6. ノード間認証
  const secret = await deriveMeetingSecret(nodeKey, MEETING_ID);
  const otherSecret = await deriveMeetingSecret(nodeKey, OTHER_MEETING_ID);
  if (!secret.ok || !otherSecret.ok) {
    process.stdout.write("FAIL 会議秘密鍵の導出\n");
    process.exitCode = 1;
    return;
  }
  check(
    bytesToHex(secret.value) !== bytesToHex(otherSecret.value),
    "会議ごとに異なる秘密鍵が導出される",
  );

  if (shard.ok) {
    const window = nodeAuthTimeWindow(NOW);
    const tag = await nodeAuthTag(secret.value, shard.value, "shard", window);
    if (!tag.ok) {
      process.stdout.write("FAIL タグ生成\n");
      process.exitCode = 1;
      return;
    }
    const verified = await verifyNodeAuthTag(secret.value, shard.value, "shard", tag.value, NOW);
    check(verified.ok && verified.value === window, "ノード間タグが受理される");

    // 時刻窓の境界: 1 つ前の窓のタグも受理される
    const previousTag = await nodeAuthTag(secret.value, shard.value, "shard", window - 1);
    if (previousTag.ok) {
      const boundary = await verifyNodeAuthTag(secret.value, shard.value, "shard", previousTag.value, NOW);
      check(boundary.ok && boundary.value === window - 1, "1 つ前の時刻窓のタグも受理される");
    }

    // 2 つ前は拒否
    const oldTag = await nodeAuthTag(secret.value, shard.value, "shard", window - 2);
    if (oldTag.ok) {
      const oldResult = await verifyNodeAuthTag(secret.value, shard.value, "shard", oldTag.value, NOW);
      check(!oldResult.ok && oldResult.error.code === "E_NODE_AUTH", "2 つ前の時刻窓のタグを拒否");
    }

    // 別の部屋名のタグは拒否
    const otherShard = shardRoom("vsh", MEETING_ID, "auto", 1, 1);
    if (otherShard.ok) {
      const crossResult = await verifyNodeAuthTag(secret.value, otherShard.value, "shard", tag.value, NOW);
      check(!crossResult.ok && crossResult.error.code === "E_NODE_AUTH", "別の部屋名のタグを拒否");
    }

    // 別の会議の秘密鍵では拒否
    const crossMeeting = await verifyNodeAuthTag(otherSecret.value, shard.value, "shard", tag.value, NOW);
    check(!crossMeeting.ok && crossMeeting.error.code === "E_NODE_AUTH", "別会議の秘密鍵では拒否");

    // 役割違いは拒否
    const roleResult = await verifyNodeAuthTag(secret.value, shard.value, "fanout", tag.value, NOW);
    check(!roleResult.ok && roleResult.error.code === "E_NODE_AUTH", "役割違いのタグを拒否");
  }

  if (failures === 0) {
    process.stdout.write("OK: 認証と認可のすべての検証に成功\n");
    return;
  }
  process.stdout.write(`${failures} 件の不一致\n`);
  process.exitCode = 1;
}

main().catch((error: unknown): void => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
  process.stderr.write(`FAILED: ${detail}\n`);
  process.exitCode = 1;
});
