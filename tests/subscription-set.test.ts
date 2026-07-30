/**
 * 購読メッセージが「望む集合」として扱われることの試験（wire-format.md 2.4）。
 *
 * ここで固定するのは 2 つである。
 *
 * 1. 中継ノードは `entries` に含まれない購読を**解除する**。以前は追加しか作らず、
 *    解除が伝わらなかった。
 * 2. 受信ノードは変更のたびに**現在の集合すべて**を送る。以前は変更 1 件だけを載せ、
 *    購読解除では空配列を送っていたため、上流の接続が張り直されると
 *    「受信ノードは購読済み・中継は購読なし」という食い違いが固定された（F-056）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createShardHandlerState,
  handleText,
  type ShardPeer,
  type ShardTransport,
} from "../packages/server/src/shard-handler.ts";
import {
  createReceiverHandlerState,
  handleClientText,
  upstreamSubscribeText,
  type ReceiverTransport,
} from "../packages/server/src/receiver-handler.ts";
import { CHANNEL_AUDIO, CHANNEL_VIDEO } from "../packages/core/src/generated/wire-layout.ts";

const peerOf = (participantId: number): ShardPeer => ({ participantId, isNode: false });

function shardRecorder(): { transport: ShardTransport; texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    transport: {
      noteDrop: (): void => undefined,
      sendBinary: (): void => undefined,
      sendText: (_id, _target, text): void => {
        texts.push(text);
      },
      close: (): void => undefined,
      notifyControl: (): void => undefined,
    },
  };
}

function subscribeText(entries: readonly { senderId: number; channel: number }[]): string {
  return JSON.stringify({
    t: "subscribe",
    entries: entries.map((entry) => ({ ...entry, maxSpatialId: 0, maxTemporalId: 7 })),
  });
}

test("**中継は entries に含まれない購読を解除する**（wire-format.md 2.4）", () => {
  const { transport } = shardRecorder();
  let state = createShardHandlerState(0);
  // 2 本購読する。
  state = handleText(
    state,
    peerOf(10),
    subscribeText([
      { senderId: 20, channel: CHANNEL_VIDEO },
      { senderId: 21, channel: CHANNEL_VIDEO },
    ]),
    10,
    transport,
  );
  assert.equal(state.core.subscriptions.length, 2, "2 本登録される");

  // 1 本だけを望む集合として送る。もう 1 本は解除されなければならない。
  state = handleText(state, peerOf(10), subscribeText([{ senderId: 20, channel: CHANNEL_VIDEO }]), 20, transport);
  assert.equal(state.core.subscriptions.length, 1, "含まれない購読は消える");
  assert.equal(state.core.subscriptions[0]?.targetId, 20);

  // 空の集合は全解除である。
  state = handleText(state, peerOf(10), subscribeText([]), 30, transport);
  assert.equal(state.core.subscriptions.length, 0, "空の集合で全部消える");
});

test("**中継は他の購読者の購読を消さない**", () => {
  const { transport } = shardRecorder();
  let state = createShardHandlerState(0);
  state = handleText(state, peerOf(10), subscribeText([{ senderId: 20, channel: CHANNEL_VIDEO }]), 10, transport);
  state = handleText(state, peerOf(11), subscribeText([{ senderId: 20, channel: CHANNEL_VIDEO }]), 11, transport);
  assert.equal(state.core.subscriptions.length, 2);

  // 10 が全部やめても 11 の購読は残る。
  state = handleText(state, peerOf(10), subscribeText([]), 20, transport);
  assert.equal(state.core.subscriptions.length, 1, "他の購読者は残る");
  assert.equal(state.core.subscriptions[0]?.subscriberId, 11);
});

test("**受信ノードは変更のたびに現在の集合すべてを上流へ送る**（F-056）", () => {
  const upstream: string[] = [];
  const transport: ReceiverTransport = {
    sendToClient: (): void => undefined,
    sendTextToClient: (): void => undefined,
    sendUpstream: (text): void => {
      upstream.push(text);
    },
    closeClient: (): void => undefined,
  };
  let state = createReceiverHandlerState(0);
  state = handleClientText(
    state,
    JSON.stringify({
      t: "subscribe",
      entries: [{ senderId: 20, channel: CHANNEL_VIDEO, maxSpatialId: 0, maxTemporalId: 7 }],
    }),
    10,
    transport,
  );
  state = handleClientText(
    state,
    JSON.stringify({
      t: "subscribe",
      entries: [
        { senderId: 20, channel: CHANNEL_VIDEO, maxSpatialId: 0, maxTemporalId: 7 },
        { senderId: 21, channel: CHANNEL_VIDEO, maxSpatialId: 0, maxTemporalId: 7 },
      ],
    }),
    20,
    transport,
  );

  // 上流へはキーフレーム要求も流れる。購読の文だけを見る。
  const subscribes = upstream.filter((text) => text.includes('"t":"subscribe"'));
  const last = subscribes[subscribes.length - 1];
  assert.ok(last !== undefined, "上流へ購読を送っている");
  const parsed: unknown = JSON.parse(last);
  assert.ok(typeof parsed === "object" && parsed !== null);
  const record: Record<string, unknown> = { ...parsed };
  const entries = record["entries"];
  assert.ok(Array.isArray(entries), "entries がある");
  assert.equal(entries.length, 2, "**変更 1 件ではなく集合すべてを載せる**");
});

test("望む集合の文はコアの状態から作られ、解除済みを含まない", () => {
  const text = upstreamSubscribeText({
    streams: [
      { senderId: 20, channel: CHANNEL_VIDEO, phase: "SUBSCRIBED", spatialId: 1, temporalId: 7, displayWidth: 0 },
      { senderId: 21, channel: CHANNEL_AUDIO, phase: "UNSUBSCRIBED", spatialId: 0, temporalId: 0, displayWidth: 0 },
    ],
    catalog: [],
    visible: true,
    targetBytesPerSec: 1000,
    activeSpeakerId: null,
    trend: { numerator: 0, denominator: 1 },
    degraded: false,
    audioOnly: false,
    rateHoldUntilMs: 0,
    recoverStreak: 0,
    targetCeilingBytesPerSec: 1000,
    unexpectedEvents: [],
    received: [],
  });
  const parsed: unknown = JSON.parse(text);
  assert.ok(typeof parsed === "object" && parsed !== null);
  const record: Record<string, unknown> = { ...parsed };
  const entries = record["entries"];
  assert.ok(Array.isArray(entries));
  assert.equal(entries.length, 1, "UNSUBSCRIBED は含めない");
  const firstEntry: unknown = entries[0];
  assert.ok(typeof firstEntry === "object" && firstEntry !== null);
  const first: Record<string, unknown> = { ...firstEntry };
  assert.equal(first["senderId"], 20);
  assert.equal(first["maxSpatialId"], 1, "段は状態の値を使う");
});
