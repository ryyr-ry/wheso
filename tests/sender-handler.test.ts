/**
 * 送信ノードの伝送層アダプタの試験。
 * 制御メッセージの翻訳と、出力コマンドの接続操作・送信への写しを確かめる。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createSenderHandlerState,
  handleClientMedia,
  handleClientText,
  handleNewEpochFrame,
  handleStaleBacklog,
  handleTimer,
  type SenderHandlerState,
  type SenderTransport,
} from "../packages/server/src/sender-handler.ts";
import { encodeMediaMessage } from "../packages/core/src/wire.ts";
import {
  CHANNEL_VIDEO,
  FLAG_DISCARDABLE,
  FLAG_END_OF_FRAME,
  WIRE_MAGIC,
} from "../packages/core/src/generated/wire-layout.ts";
import { EPOCH_DUAL_SUBSCRIBE_TIMEOUT_MS, SEND_WINDOW_MS } from "../packages/core/src/generated/constants.ts";

interface Log {
  readonly toShard: { peer: number; length: number }[];
  readonly textToShard: { peer: number; text: string }[];
  readonly connected: number[];
  readonly disconnected: number[];
  readonly closed: number[];
  readonly notified: string[];
  readonly scheduled: number[];
  readonly textToClient: string[];
  readonly textToControl: string[];
}

function recorder(): { transport: SenderTransport; log: Log } {
  const log: Log = {
    toShard: [],
    textToShard: [],
    connected: [],
    disconnected: [],
    closed: [],
    notified: [],
    scheduled: [],
    textToClient: [],
    textToControl: [],
  };
  const transport: SenderTransport = {
    noteDrop(): void {},
    sendToShard(peer, bytes) {
      log.toShard.push({ peer, length: bytes.length });
    },
    sendTextToShard(peer, text) {
      log.textToShard.push({ peer, text });
    },
    sendTextToClient(text) {
      log.textToClient.push(text);
    },
    connectShard(peer) {
      log.connected.push(peer);
    },
    disconnectShard(peer) {
      log.disconnected.push(peer);
    },
    closeClient(code) {
      log.closed.push(code);
    },
    sendTextToControl(text) {
      log.textToControl.push(text);
    },
    notifyControl(code) {
      log.notified.push(code);
    },
    scheduleAt(atMs) {
      log.scheduled.push(atMs);
    },
  };
  return { transport, log };
}

const FPS = 60;

function mediaBytes(seq: number): Uint8Array {
  const encoded = encodeMediaMessage({
    channel: CHANNEL_VIDEO,
    senderId: 42,
    units: [
      {
        sequenceNumber: seq,
        captureTimestampUs: BigInt(seq) * 16_667n,
        flags: FLAG_END_OF_FRAME | FLAG_DISCARDABLE,
        spatialId: 3,
        temporalId: 2,
        payload: new Uint8Array(48),
      },
    ],
  });
  assert.equal(encoded.ok, true);
  return encoded.ok ? encoded.value : new Uint8Array(0);
}

function announced(transport: SenderTransport): SenderHandlerState {
  const state = createSenderHandlerState(1, 0);
  return handleClientText(
    state,
    JSON.stringify({ t: "streamAnnounce", streams: [{ channel: CHANNEL_VIDEO, spatialId: 3, framerate: FPS }] }),
    0,
    transport,
  );
}

test("クライアントのメディアは割当先シャードへ渡される", () => {
  const { transport, log } = recorder();
  const state = announced(transport);
  handleClientMedia(state, mediaBytes(2), 10, transport);
  assert.deepEqual(log.toShard.map((entry) => entry.peer), [1]);
});

test("形式違反のメディアはクライアント接続を閉じる", () => {
  const { transport, log } = recorder();
  const state = announced(transport);
  const broken = new Uint8Array([WIRE_MAGIC ^ 0xff, 1, CHANNEL_VIDEO, 1, 0, 0, 0, 1]);
  handleClientMedia(state, broken, 10, transport);
  assert.equal(log.closed.length, 1);
  assert.equal(log.toShard.length, 0);
});

test("送信窓を超えると渡さない。ack が届けば再び渡す", () => {
  const { transport, log } = recorder();
  const state = announced(transport);
  const boundary = Math.trunc((SEND_WINDOW_MS * FPS) / 1000);

  handleClientMedia(state, mediaBytes(boundary + 2), 10, transport);
  assert.equal(log.toShard.length, 0, "窓の外は渡さない");

  const acked = handleClientText(
    state,
    JSON.stringify({ t: "ack", senderId: 42, channel: CHANNEL_VIDEO, spatialId: 3, highestSeq: boundary }),
    20,
    transport,
  );
  handleClientMedia(acked, mediaBytes(boundary + 2), 30, transport);
  assert.equal(log.toShard.length, 1, "確認が進めば渡す");
});

test("epoch 変化で新接続を開き、期限を予約する", () => {
  const { transport, log } = recorder();
  const state = announced(transport);
  handleClientText(
    state,
    JSON.stringify({ t: "epochChange", epoch: 2, assignmentChanged: true }),
    100,
    transport,
  );
  assert.deepEqual(log.connected, [2]);
  assert.deepEqual(log.scheduled, [100 + EPOCH_DUAL_SUBSCRIBE_TIMEOUT_MS]);
});

test("二重購読中は新旧の両方へ渡し、移行完了で旧を閉じる", () => {
  const { transport, log } = recorder();
  let state = announced(transport);
  state = handleClientText(
    state,
    JSON.stringify({ t: "epochChange", epoch: 2, assignmentChanged: true }),
    100,
    transport,
  );
  state = handleClientMedia(state, mediaBytes(2), 110, transport);
  assert.deepEqual(log.toShard.map((entry) => entry.peer), [1, 2], "新旧の両方へ渡す");

  state = handleNewEpochFrame(state, 120, transport);
  // 件数ではなく内容で確かめる。件数はほかの中継（はしごの申告）でも増えるため、
  // 件数で判定すると無関係な変更で壊れる。
  const unsubscribes = log.textToShard.filter((entry) => entry.text.includes("\"subscribe\""));
  assert.equal(unsubscribes.length, 1, "旧接続の購読を解除する");
  assert.equal(unsubscribes[0]?.peer, 1, "解除の宛先は旧接続である");
  state = handleStaleBacklog(state, 0, 130, transport);
  assert.deepEqual(log.disconnected, [1], "旧接続を閉じる");
  assert.equal(state.core.phase, "STEADY");
  assert.equal(state.core.epoch, 2);
});

test("期限内にフレームが来なければ新接続を閉じ E_EPOCH_STALE を報告する", () => {
  const { transport, log } = recorder();
  let state = announced(transport);
  state = handleClientText(
    state,
    JSON.stringify({ t: "epochChange", epoch: 2, assignmentChanged: true }),
    100,
    transport,
  );
  state = handleTimer(state, 100 + EPOCH_DUAL_SUBSCRIBE_TIMEOUT_MS, transport);
  assert.deepEqual(log.disconnected, [2]);
  assert.deepEqual(log.notified, ["E_EPOCH_STALE"]);
  assert.equal(state.core.phase, "STEADY");
});

test("未知の制御メッセージと壊れた JSON は無視される", () => {
  const { transport, log } = recorder();
  const state = announced(transport);
  const a = handleClientText(state, JSON.stringify({ t: "未知" }), 10, transport);
  const b = handleClientText(a, "{壊れている", 20, transport);
  assert.equal(log.closed.length, 0);
  assert.equal(b.core.windows.length, state.core.windows.length);
});
