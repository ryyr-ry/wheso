/**
 * ノード間認証（nodeHello）の試験。
 *
 * 監査の指摘（重大度 高）「DO 間接続が無認証」に対する試験である。
 * 規範: wire-format.md 2.8、errors.md 3.1。
 */

import { nodeAuthTimeWindow } from "../packages/core/src/auth.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createNodeGateState,
  forgetNode,
  isNodeAuthenticated,
  markNodeAuthenticated,
  parseNodeHello,
  recordDroppedBeforeHello,
  verifyNodeHello,
} from "../packages/server/src/node-auth.ts";
import { deriveMeetingSecret, nodeAuthTag } from "../packages/core/src/auth.ts";
import { ERROR_DEFINITIONS } from "../packages/core/src/generated/errors.ts";

const NODE_KEY = new TextEncoder().encode("node-key-for-conformance-testing-only");
const MEETING = "01jxy8kq2r3mz5v7h9abcderfa";
const ROOM = "vsh-01jxy8kq2r3mz5v7h9abcderfa-auto-1-0";
const NOW_SEC = 1_800_000_000;

async function secret(): Promise<Uint8Array> {
  const derived = await deriveMeetingSecret(NODE_KEY, MEETING);
  assert.equal(derived.ok, true, "会議シークレットを導出できる");
  return derived.ok ? derived.value : new Uint8Array(0);
}

async function helloText(role: string, room: string, nowSec: number): Promise<string> {
  const meetingSecret = await secret();
  const tag = await nodeAuthTag(meetingSecret, room, role, nodeAuthTimeWindow(nowSec));
  assert.equal(tag.ok, true, "authTag を作れる");
  return JSON.stringify({ t: "nodeHello", role, nodeId: room, authTag: tag.ok ? tag.value : "" });
}

test("正しい authTag の nodeHello は受理される", async () => {
  const parsed = parseNodeHello(await helloText("sender", ROOM, NOW_SEC));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error.detail);
  if (!parsed.ok) {
    return;
  }
  const verified = await verifyNodeHello({
    meetingSecret: await secret(),
    targetRoomName: ROOM,
    hello: parsed.value,
    nowSec: NOW_SEC,
  });
  assert.equal(verified.ok, true, verified.ok ? "" : verified.error.detail);
});

test("別の部屋名で作った authTag は拒否される", async () => {
  const parsed = parseNodeHello(await helloText("sender", "vsh-01jxy8kq2r3mz5v7h9abcderfa-auto-1-9", NOW_SEC));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  const verified = await verifyNodeHello({
    meetingSecret: await secret(),
    targetRoomName: ROOM,
    hello: parsed.value,
    nowSec: NOW_SEC,
  });
  assert.equal(verified.ok, false, "部屋名が違えば拒否する");
  if (!verified.ok) {
    assert.equal(verified.error.closeCode, ERROR_DEFINITIONS.E_NODE_AUTH.closeCode);
  }
});

test("別の役割で作った authTag は拒否される", async () => {
  const text = await helloText("receiver", ROOM, NOW_SEC);
  const parsed = parseNodeHello(text.replace('"role":"receiver"', '"role":"shard"'));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  const verified = await verifyNodeHello({
    meetingSecret: await secret(),
    targetRoomName: ROOM,
    hello: parsed.value,
    nowSec: NOW_SEC,
  });
  assert.equal(verified.ok, false, "役割が違えば拒否する");
});

test("古い時刻窓の authTag は拒否される", async () => {
  // 2 つ以上前の窓は許さない（現在と 1 つ前のみ）。
  const parsed = parseNodeHello(await helloText("sender", ROOM, NOW_SEC - 3600));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  const verified = await verifyNodeHello({
    meetingSecret: await secret(),
    targetRoomName: ROOM,
    hello: parsed.value,
    nowSec: NOW_SEC,
  });
  assert.equal(verified.ok, false, "古い窓は拒否する");
});

test("形式違反の nodeHello は失敗として返る（例外を投げない）", () => {
  assert.equal(parseNodeHello("{壊れている").ok, false);
  assert.equal(parseNodeHello(JSON.stringify({ t: "hello" })).ok, false);
  assert.equal(parseNodeHello(JSON.stringify({ t: "nodeHello", role: "unknown", nodeId: "a", authTag: "b" })).ok, false);
  assert.equal(parseNodeHello(JSON.stringify({ t: "nodeHello", role: "sender", nodeId: "", authTag: "b" })).ok, false);
  assert.equal(parseNodeHello(JSON.stringify({ t: "nodeHello", role: "sender", nodeId: "a" })).ok, false);
});

test("認証前のメディアは破棄され、数が記録される", () => {
  let gate = createNodeGateState();
  assert.equal(isNodeAuthenticated(gate, "c1"), false, "既定では未認証");
  gate = recordDroppedBeforeHello(gate);
  gate = recordDroppedBeforeHello(gate);
  assert.equal(gate.droppedBeforeHello, 2, "破棄した数を数える");

  gate = markNodeAuthenticated(gate, "c1", "sender");
  assert.equal(isNodeAuthenticated(gate, "c1"), true);
  assert.equal(isNodeAuthenticated(gate, "c2"), false);

  gate = forgetNode(gate, "c1");
  assert.equal(isNodeAuthenticated(gate, "c1"), false, "切断で認証を取り消す");
});

test("認証の記録は接続 ID の昇順で保持される（決定性）", () => {
  let gate = createNodeGateState();
  gate = markNodeAuthenticated(gate, "c3", "shard");
  gate = markNodeAuthenticated(gate, "c1", "sender");
  gate = markNodeAuthenticated(gate, "c2", "receiver");
  assert.deepEqual(
    gate.authenticated.map((entry) => entry.connectionId),
    ["c1", "c2", "c3"],
  );
});
