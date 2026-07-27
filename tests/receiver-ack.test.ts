/**
 * ack の試験。
 *
 * 規範: congestion.md 2 節（未確認の媒体を再生時間で数える。ack は 50 ms ごとに
 * その時点で到着済みの最大 sequenceNumber のみを送る）、wire-format.md 2.5.1。
 *
 * 監査の指摘（重大度 高）「ack の送信が未実装で送信窓が機能しない」に対する試験である。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  initialReceiverState,
  receiverStep,
  type ReceiverCommand,
  type ReceiverState,
} from "../packages/core/src/receiver-core.ts";
import {
  createReceiverHandlerState,
  handleAckTimer,
  handleClientText,
  handleUpstreamBinary,
  type ReceiverTransport,
} from "../packages/server/src/receiver-handler.ts";
import { encodeMediaMessage } from "../packages/core/src/wire.ts";
import { CHANNEL_VIDEO, FLAG_END_OF_FRAME, FLAG_KEY } from "../packages/core/src/generated/wire-layout.ts";
import { V_4K60 } from "../packages/core/src/generated/constants.ts";

const BUDGET = Math.trunc((V_4K60.targetBitrate * 10) / (8 * 9)) + 1;

function subscribed(): ReceiverState {
  return receiverStep(initialReceiverState(BUDGET), {
    kind: "subscribe",
    entries: [{ senderId: 7, channel: CHANNEL_VIDEO, maxSpatialId: V_4K60.spatialId, maxTemporalId: 7 }],
  }).state;
}

function receive(state: ReceiverState, seq: number, sid = 0): ReceiverState {
  return receiverStep(state, {
    kind: "media",
    from: 7,
    ch: CHANNEL_VIDEO,
    sid,
    tid: 0,
    key: true,
    bytes: 1000,
    flags: FLAG_END_OF_FRAME | FLAG_KEY,
    seq,
  }).state;
}

/** 試験で使う論理時刻。伝送層は時刻を引数で受け取る（lint-policy.md 9 節）。 */
const T0 = 1_000_000;

test("受信した最大 sequenceNumber がタイマーで ack として出る", () => {
  let state = subscribed();
  state = receive(state, 10);
  state = receive(state, 11);
  const result = receiverStep(state, { kind: "timer" });
  const acks = result.commands.filter((command) => command.kind === "ack");
  assert.equal(acks.length, 1, "1 本のストリームにつき 1 個");
  const ack = acks[0];
  assert.equal(ack?.kind === "ack" ? ack.highestSeq : 0, 11, "最大の位置を返す");
});

test("後戻りする sequenceNumber では ack が下がらない", () => {
  let state = subscribed();
  state = receive(state, 20);
  state = receive(state, 5);
  const result = receiverStep(state, { kind: "timer" });
  const ack = result.commands.find((command) => command.kind === "ack");
  assert.equal(ack?.kind === "ack" ? ack.highestSeq : 0, 20);
});

test("spatialId ごとに別の ack を返す（送信窓はストリーム単位である）", () => {
  let state = subscribed();
  state = receiverStep(state, { kind: "displaySize", senderId: 7, channel: CHANNEL_VIDEO, width: 3840 }).state;
  state = receive(state, 3, 0);
  state = receive(state, 9, V_4K60.spatialId);
  const result = receiverStep(state, { kind: "timer" });
  const acks = result.commands.filter((command) => command.kind === "ack");
  assert.equal(acks.length, 2, "層ごとに返す");
  const sequences = acks.map((command) => (command.kind === "ack" ? command.highestSeq : 0)).sort((a, b) => a - b);
  assert.deepEqual(sequences, [3, 9]);
});

test("退出した送信者への ack は返さない", () => {
  let state = subscribed();
  state = receive(state, 10);
  state = receiverStep(state, { kind: "leave", id: 7 }).state;
  const result = receiverStep(state, { kind: "timer" });
  assert.equal(result.commands.filter((command) => command.kind === "ack").length, 0);
});

test("何も受信していなければ ack を返さない", () => {
  const result = receiverStep(subscribed(), { kind: "timer" });
  assert.equal(result.commands.filter((command) => command.kind === "ack").length, 0);
});

test("伝送層は ack を上流へ制御メッセージとして送る", () => {
  const upstream: string[] = [];
  const transport: ReceiverTransport = {
    sendToClient() {
      // 転送の内容は本試験の対象外である。
    },
    sendTextToClient() {
      // 同上。
    },
    sendUpstream(text) {
      upstream.push(text);
    },
    closeClient() {
      // 同上。
    },
  };

  let state = createReceiverHandlerState(BUDGET, T0);
  state = handleClientText(
    state,
    JSON.stringify({
      t: "subscribe",
      entries: [{ senderId: 7, channel: CHANNEL_VIDEO, maxSpatialId: 0, maxTemporalId: 7 }],
    }),
    T0,
    transport,
  );

  const encoded = encodeMediaMessage({
    channel: CHANNEL_VIDEO,
    senderId: 7,
    units: [
      {
        sequenceNumber: 4821,
        captureTimestampUs: 1_000_000n,
        flags: FLAG_END_OF_FRAME | FLAG_KEY,
        spatialId: 0,
        temporalId: 0,
        payload: new Uint8Array(16),
      },
    ],
  });
  assert.equal(encoded.ok, true);
  if (!encoded.ok) {
    return;
  }
  state = handleUpstreamBinary(state, encoded.value, T0, transport);

  const before = upstream.length;
  handleAckTimer(state, T0, transport);
  const added = upstream.slice(before);
  assert.ok(
    added.some((text) => text.includes('"t":"ack"') && text.includes('"highestSeq":4821')),
    `ack が上流へ送られる（実際: ${added.join(" | ")}）`,
  );
});

test("ack コマンドの形が規範のフィールドを持つ", () => {
  let state = subscribed();
  state = receive(state, 1);
  const result: readonly ReceiverCommand[] = receiverStep(state, { kind: "timer" }).commands;
  const ack = result.find((command) => command.kind === "ack");
  assert.ok(ack !== undefined);
  if (ack?.kind === "ack") {
    assert.equal(typeof ack.senderId, "number");
    assert.equal(typeof ack.channel, "number");
    assert.equal(typeof ack.spatialId, "number");
    assert.equal(typeof ack.highestSeq, "number");
  }
});
