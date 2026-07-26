/**
 * 制御ノードの認証と参加者管理の試験。
 *
 * auth.md 3.4 の認可（要求された部屋名が (aud, sub) から導出できるか）を、
 * 実際に署名したトークンで検証する。偽物の署名・期限切れ・他人の部屋を拒むことを確かめる。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addParticipant,
  authorize,
  createControlState,
  helloAck,
  needsResharding,
  parseHello,
  participantsMessage,
  recordNodeStatus,
  removeParticipant,
} from "../packages/server/src/control-handler.ts";
import { issueToken } from "../packages/core/src/auth.ts";
import { ERROR_DEFINITIONS } from "../packages/core/src/generated/errors.ts";
import { PROTOCOL_VERSION } from "../packages/core/src/generated/wire-layout.ts";

const KEY = new TextEncoder().encode("test-secret-key-for-conformance-only");
const MEETING = "01jxy8kq2r3mz5v7h9abcderfa";
const USER = "0123456789abcdef0123456789abcdef";
const NOW_SEC = 1_800_000_000;

async function tokenFor(userId: string, meetingId: string, nowSec: number): Promise<string> {
  const issued = await issueToken(KEY, {
    iss: "wheso-test",
    sub: userId,
    aud: meetingId,
    iat: nowSec,
    exp: nowSec + 60,
    jti: `${userId}-${nowSec}`,
    kind: "client",
    role: "host",
  });
  assert.equal(issued.ok, true, "トークンを発行できる");
  return issued.ok ? issued.value : "";
}

test("hello の形式検査: 版が違えば拒否する", () => {
  const wrong = parseHello(
    JSON.stringify({ t: "hello", protocolVersion: PROTOCOL_VERSION + 1, token: "x", senderId: 1 }),
  );
  assert.equal(wrong.ok, false);
  if (!wrong.ok) {
    assert.equal(wrong.error.code, "E_CTRL_VERSION");
  }
});

test("hello の形式検査: senderId が 0 なら拒否する", () => {
  const result = parseHello(
    JSON.stringify({ t: "hello", protocolVersion: PROTOCOL_VERSION, token: "x", senderId: 0 }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "E_WIRE_SENDER_ID");
  }
});

test("hello の形式検査: 壊れた JSON でも例外を投げない", () => {
  const result = parseHello("{壊れている");
  assert.equal(result.ok, false);
});

test("正しいトークンと自分の部屋なら認可される", async () => {
  const token = await tokenFor(USER, MEETING, NOW_SEC);
  const result = await authorize({
    keyBytes: KEY,
    token,
    meetingId: MEETING,
    roomName: `ctl-${MEETING}-${USER}`,
    nowSec: NOW_SEC + 1,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error.detail);
  if (result.ok) {
    assert.equal(result.value.userId, USER);
    assert.equal(result.value.role, "host");
  }
});

test("他人の個人部屋へは接続できない", async () => {
  const token = await tokenFor(USER, MEETING, NOW_SEC);
  const result = await authorize({
    keyBytes: KEY,
    token,
    meetingId: MEETING,
    roomName: `ctl-${MEETING}-fedcba9876543210fedcba9876543210`,
    nowSec: NOW_SEC + 1,
  });
  assert.equal(result.ok, false, "拒否される");
});

test("中継ノードの部屋へ直結できない", async () => {
  const token = await tokenFor(USER, MEETING, NOW_SEC);
  const result = await authorize({
    keyBytes: KEY,
    token,
    meetingId: MEETING,
    roomName: `vshard-${MEETING}-auto-1-0`,
    nowSec: NOW_SEC + 1,
  });
  assert.equal(result.ok, false, "個人部屋ではないので拒否される");
});

test("署名を書き換えたトークンは拒否される", async () => {
  const token = await tokenFor(USER, MEETING, NOW_SEC);
  const parts = token.split(".");
  const tampered = `${parts[0] ?? ""}.${parts[1] ?? ""}.${(parts[2] ?? "").replace(/.$/, "A")}`;
  const result = await authorize({
    keyBytes: KEY,
    token: tampered,
    meetingId: MEETING,
    roomName: `ctl-${MEETING}-${USER}`,
    nowSec: NOW_SEC + 1,
  });
  assert.equal(result.ok, false);
});

test("期限切れのトークンは拒否される", async () => {
  const token = await tokenFor(USER, MEETING, NOW_SEC);
  const result = await authorize({
    keyBytes: KEY,
    token,
    meetingId: MEETING,
    roomName: `ctl-${MEETING}-${USER}`,
    nowSec: NOW_SEC + 3600,
  });
  assert.equal(result.ok, false);
});

test("別の会議のトークンは拒否される", async () => {
  const token = await tokenFor(USER, "01jxy8kq2r3mz5v7h9abcderfb", NOW_SEC);
  const result = await authorize({
    keyBytes: KEY,
    token,
    meetingId: MEETING,
    roomName: `ctl-${MEETING}-${USER}`,
    nowSec: NOW_SEC + 1,
  });
  assert.equal(result.ok, false);
});

test("別の鍵で署名したトークンは拒否される", async () => {
  const other = new TextEncoder().encode("another-key-entirely-different-one");
  const issued = await issueToken(other, {
    iss: "wheso-test",
    sub: USER,
    aud: MEETING,
    iat: NOW_SEC,
    exp: NOW_SEC + 60,
    jti: "x",
    kind: "client",
    role: "host",
  });
  assert.equal(issued.ok, true);
  const result = await authorize({
    keyBytes: KEY,
    token: issued.ok ? issued.value : "",
    meetingId: MEETING,
    roomName: `ctl-${MEETING}-${USER}`,
    nowSec: NOW_SEC + 1,
  });
  assert.equal(result.ok, false);
});

test("helloAck は版と定数を含む", () => {
  const text = helloAck(12345, 1_784_973_771_566);
  const parsed: unknown = JSON.parse(text);
  assert.equal(typeof parsed, "object");
  const record: Record<string, unknown> = typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
  assert.equal(record["t"], "helloAck");
  assert.equal(record["protocolVersion"], PROTOCOL_VERSION);
  assert.equal(record["assignedSenderId"], 12345);
});

test("参加者の追加と除去は userId の昇順を保つ", () => {
  let state = createControlState();
  state = addParticipant(state, { userId: "u003", senderId: 3, role: "viewer" });
  state = addParticipant(state, { userId: "u001", senderId: 1, role: "host" });
  state = addParticipant(state, { userId: "u002", senderId: 2, role: "presenter" });
  assert.deepEqual(
    state.participants.map((entry) => entry.userId),
    ["u001", "u002", "u003"],
  );
  state = removeParticipant(state, "u002");
  assert.deepEqual(
    state.participants.map((entry) => entry.userId),
    ["u001", "u003"],
  );
  assert.ok(participantsMessage(state).includes("u003"));
});

test("同じ userId の再参加は上書きされる（重複しない）", () => {
  let state = createControlState();
  state = addParticipant(state, { userId: "u001", senderId: 1, role: "viewer" });
  state = addParticipant(state, { userId: "u001", senderId: 9, role: "host" });
  assert.equal(state.participants.length, 1);
  assert.equal(state.participants[0]?.senderId, 9);
});

test("過負荷の通知が届いたら再分割が必要と判定する", () => {
  let state = createControlState();
  assert.equal(needsResharding(state), false);
  state = recordNodeStatus(state, ERROR_DEFINITIONS.E_NODE_OVERLOADED.closeCode);
  assert.equal(needsResharding(state), true);
});
