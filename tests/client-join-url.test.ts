/**
 * 参加 URL の解析と部屋名の決定の試験。
 * 規範: sdk-api.md 1 節、auth.md 3.4（5 つの個人部屋のみ）、room-naming.md。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseJoinUrl, planRooms, roomUrl } from "../packages/client/src/api/join-url.ts";

const MEETING = "01jxy8kq2r3mz5v7h9abcderfa";
const USER = "0123456789abcdef0123456789abcdef";

test("参加 URL からホスト・会議 ID・トークンを取り出す", () => {
  const result = parseJoinUrl(`https://example.test/j/${MEETING}#tok.en.value`);
  assert.equal(result.ok, true, result.ok ? "" : result.error.detail);
  if (result.ok) {
    assert.equal(result.value.host, "example.test");
    assert.equal(result.value.meetingId, MEETING);
    assert.equal(result.value.token, "tok.en.value");
  }
});

test("トークンが無い URL は拒否する", () => {
  const result = parseJoinUrl(`https://example.test/j/${MEETING}`);
  assert.equal(result.ok, false);
});

test("経路が /j/<meetingId> でない URL は拒否する", () => {
  assert.equal(parseJoinUrl("https://example.test/join/x#t").ok, false);
  assert.equal(parseJoinUrl("https://example.test/#t").ok, false);
});

test("会議 ID の文法に合わない URL は拒否する", () => {
  const result = parseJoinUrl("https://example.test/j/NOT-A-ULID#t");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "E_NAME_MEETING_ID");
  }
});

test("URL として解析できない文字列でも例外を投げない", () => {
  assert.equal(parseJoinUrl("これは URL ではない").ok, false);
});

test("接続先は 5 つの個人部屋のみである", () => {
  const result = planRooms(MEETING, USER);
  assert.equal(result.ok, true, result.ok ? "" : result.error.detail);
  if (!result.ok) {
    return;
  }
  const plan = result.value;
  assert.equal(plan.ctl, `ctl-${MEETING}-${USER}`);
  assert.equal(plan.vs, `vs-${MEETING}-${USER}`);
  assert.equal(plan.vr, `vr-${MEETING}-${USER}`);
  assert.equal(plan.as, `as-${MEETING}-${USER}`);
  assert.equal(plan.ar, `ar-${MEETING}-${USER}`);
});

test("利用者 ID の文法に合わない場合は拒否する", () => {
  assert.equal(planRooms(MEETING, "short").ok, false);
});

test("部屋名から party への写像が partykit.json と一致する", () => {
  const cases: readonly { readonly room: string; readonly party: string }[] = [
    { room: `ctl-${MEETING}-${USER}`, party: "control" },
    { room: `vs-${MEETING}-${USER}`, party: "sender" },
    { room: `as-${MEETING}-${USER}`, party: "sender" },
    { room: `vr-${MEETING}-${USER}`, party: "receiver" },
    { room: `ar-${MEETING}-${USER}`, party: "receiver" },
  ];
  for (const entry of cases) {
    const result = roomUrl("example.test", entry.room);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value, `wss://example.test/parties/${entry.party}/${entry.room}`);
    }
  }
});

test("中継部屋の名前を渡しても URL を作らない（クライアントは直結できない）", () => {
  const result = roomUrl("example.test", `vsh-${MEETING}-auto-1-0`);
  assert.equal(result.ok, false, "個人部屋以外は拒否する");
});

test("開発時は ws も選べる", () => {
  const result = roomUrl("127.0.0.1:1999", `ctl-${MEETING}-${USER}`, false);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.value.startsWith("ws://"));
  }
});
