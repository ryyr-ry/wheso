/**
 * 規範の埋め合わせ分の試験。
 *
 * 対象:
 *   - ワイヤ形式 2.7 の encoderDirective が 5 欄すべてを持ち、値が定数と一致する（ADR-0022）
 *   - 中継ノードが購読の和集合から上限層を決める
 *   - ワイヤ形式 2.5 のキーフレーム要求の間隔制限（送出側の抑制と受理側の無視）
 *   - 認証と濫用対策（受信メッセージレート、nodeHelloAck）
 *
 * 判定は「送られた JSON」で行う。伝送層の偽物を渡し、実際の送信内容を記録する。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createShardHandlerState,
  handleLifecycle,
  handleText,
  type ShardTransport,
} from "../packages/server/src/shard-handler.ts";
import {
  createSenderHandlerState,
  handleClientText as senderClientText,
  handleUpstreamText,
  type SenderTransport,
} from "../packages/server/src/sender-handler.ts";
import {
  createReceiverHandlerState,
  handleClientText as receiverClientText,
  type ReceiverTransport,
} from "../packages/server/src/receiver-handler.ts";
import { buildNodeHelloAck, parseNodeHelloAck } from "../packages/server/src/node-auth.ts";
import { admit, admitKeyframeRequest, initialRateWindow } from "../packages/core/src/rate-limit.ts";
import { videoProfileForSpatialId } from "../packages/core/src/profiles.ts";
import {
  KEYFRAME_REQUEST_MIN_INTERVAL_MS,
  MAX_INBOUND_MESSAGES_PER_SEC_PER_CLIENT,
  V_360P15,
  V_1080P60,
  V_4K60,
} from "../packages/core/src/generated/constants.ts";
import { CHANNEL_VIDEO } from "../packages/core/src/generated/wire-layout.ts";
import { ERROR_DEFINITIONS } from "../packages/core/src/generated/errors.ts";

const T0 = 5_000_000;

interface ShardLog {
  readonly texts: { readonly to: number; readonly text: string }[];
  readonly notified: number[];
}

function shardRecorder(): { transport: ShardTransport; log: ShardLog } {
  const log: ShardLog = { texts: [], notified: [] };
  const transport: ShardTransport = {
    sendBinary(): void {
      // メディアはこの試験の対象外である。
    },
    sendText(participantId, text): void {
      log.texts.push({ to: participantId, text });
    },
    close(): void {
      // 切断はこの試験の対象外である。
    },
    notifyControl(code): void {
      log.notified.push(code);
    },
  };
  return { transport, log };
}

/** JSON テキストから欄を読む。型が違えば試験を失敗させる。 */
function readMessage(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return { ...(value as object) };
}

function subscribeText(to: number, maxSpatialId: number): string {
  return JSON.stringify({ t: "subscribe", entries: [{ senderId: to, maxSpatialId }] });
}

test("中継ノードは購読の和集合から encoderDirective を送り、5 欄すべてを埋める", () => {
  const { transport, log } = shardRecorder();
  let state = createShardHandlerState(T0);
  state = handleLifecycle(state, { participantId: 11, isNode: true }, "open", T0, transport);
  state = handleLifecycle(state, { participantId: 42, isNode: true }, "open", T0, transport);
  state = handleText(state, { participantId: 11, isNode: true }, subscribeText(42, V_1080P60.spatialId), T0, transport);

  assert.equal(log.texts.length, 1, "指令を 1 通送る");
  const first = log.texts[0];
  assert.notEqual(first, undefined);
  assert.equal(first?.to, 42, "宛先は送信者である");
  const message = readMessage(first?.text ?? "{}");
  assert.equal(message["t"], "encoderDirective");
  assert.equal(message["channel"], CHANNEL_VIDEO);
  assert.equal(message["maxSpatialLayers"], V_1080P60.spatialId + 1);
  assert.equal(message["maxTemporalLayers"], V_1080P60.temporalLayers, "時間層数は定数から引く");
  assert.equal(message["targetBitrate"], V_1080P60.targetBitrate, "目標ビットレートは定数から引く");
  assert.equal(message["forceKeyframe"], false, "キーフレームは keyframeRequest で要求する");
});

test("より高い層を要求する購読者が増えると指令が上がり、同じ層では再送しない", () => {
  const { transport, log } = shardRecorder();
  let state = createShardHandlerState(T0);
  for (const id of [11, 12, 42]) {
    state = handleLifecycle(state, { participantId: id, isNode: true }, "open", T0, transport);
  }
  state = handleText(state, { participantId: 11, isNode: true }, subscribeText(42, V_360P15.spatialId), T0, transport);
  assert.equal(log.texts.length, 1);

  // 同じ層を要求する 2 人目では指令を送らない。
  state = handleText(state, { participantId: 12, isNode: true }, subscribeText(42, V_360P15.spatialId), T0, transport);
  assert.equal(log.texts.length, 1, "層が変わらなければ再送しない");

  // 上位を要求すると和集合が上がる。
  state = handleText(state, { participantId: 12, isNode: true }, subscribeText(42, V_4K60.spatialId), T0, transport);
  assert.equal(log.texts.length, 2);
  const raised = readMessage(log.texts[1]?.text ?? "{}");
  assert.equal(raised["maxSpatialLayers"], V_4K60.spatialId + 1);

  // 上位を要求していた者が退出すると和集合が下がる。
  state = handleLifecycle(state, { participantId: 12, isNode: true }, "close", T0, transport);
  assert.equal(log.texts.length, 3);
  const lowered = readMessage(log.texts[2]?.text ?? "{}");
  assert.equal(lowered["maxSpatialLayers"], V_360P15.spatialId + 1, "残った購読者の要求まで下がる");
});

test("購読者が全員居なくなった送信者へは指令を送らない", () => {
  const { transport, log } = shardRecorder();
  let state = createShardHandlerState(T0);
  state = handleLifecycle(state, { participantId: 11, isNode: true }, "open", T0, transport);
  state = handleText(state, { participantId: 11, isNode: true }, subscribeText(42, V_4K60.spatialId), T0, transport);
  const before = log.texts.length;
  state = handleLifecycle(state, { participantId: 11, isNode: true }, "close", T0, transport);
  assert.equal(log.texts.length, before, "宛先の意味が無いため送らない");
});

test("tier に対応するプロファイルを表引きし、範囲外は最低品質へ丸める", () => {
  assert.equal(videoProfileForSpatialId(V_4K60.spatialId).targetBitrate, V_4K60.targetBitrate);
  assert.equal(videoProfileForSpatialId(V_360P15.spatialId).temporalLayers, V_360P15.temporalLayers);
  assert.equal(videoProfileForSpatialId(-1).spatialId, V_360P15.spatialId, "負は最低品質");
  assert.equal(videoProfileForSpatialId(99).spatialId, V_360P15.spatialId, "過大は最低品質");
});

test("同一の (senderId, channel, spatialId) への要求は規定間隔内に 2 回通らない", () => {
  const key = { senderId: 42, channel: CHANNEL_VIDEO, spatialId: 2 };
  const first = admitKeyframeRequest([], key, T0);
  assert.equal(first.allowed, true);
  const second = admitKeyframeRequest(first.marks, key, T0 + KEYFRAME_REQUEST_MIN_INTERVAL_MS - 1);
  assert.equal(second.allowed, false, "境界の 1 ms 前は通さない");
  const third = admitKeyframeRequest(second.marks, key, T0 + KEYFRAME_REQUEST_MIN_INTERVAL_MS);
  assert.equal(third.allowed, true, "間隔に達したら通す");
  const other = admitKeyframeRequest(third.marks, { ...key, spatialId: 3 }, T0);
  assert.equal(other.allowed, true, "別の spatialId は独立して数える");
});

test("受信ノードはキーフレーム要求の重複を上流へ送らない", () => {
  const upstream: string[] = [];
  const transport: ReceiverTransport = {
    sendToClient(): void {},
    sendTextToClient(): void {},
    sendUpstream(text): void {
      upstream.push(text);
    },
    closeClient(): void {},
  };
  // 高品質 1 本を賄える予算にする。
  const budget = Math.trunc((V_4K60.targetBitrate * 10) / (8 * 9)) + 1;
  let state = createReceiverHandlerState(budget, T0);
  const subscribe = JSON.stringify({
    t: "subscribe",
    entries: [{ senderId: 7, channel: CHANNEL_VIDEO, maxSpatialId: V_4K60.spatialId, maxTemporalId: 7 }],
  });
  state = receiverClientText(state, subscribe, T0, transport);
  const firstCount = upstream.filter((text) => text.includes("keyframeRequest")).length;
  assert.equal(firstCount, 1, "最初の購読で 1 回要求する");

  // 同じ購読をすぐに送り直しても、要求は間隔制限で抑制される。
  state = receiverClientText(state, subscribe, T0 + 1, transport);
  const secondCount = upstream.filter((text) => text.includes("keyframeRequest")).length;
  assert.equal(secondCount, 1, "規定間隔内は送らない");

  // 送出する要求には spatialId が入る（既定値 0 を書かない）。
  const request = upstream.find((text) => text.includes("keyframeRequest")) ?? "{}";
  const message = readMessage(request);
  assert.equal(message["spatialId"], V_4K60.spatialId);
  assert.equal(message["channel"], CHANNEL_VIDEO);
  assert.equal(state.keyframeMarks.length, 1);
});

interface SenderLog {
  readonly toClient: string[];
  readonly closed: number[];
}

function senderRecorder(): { transport: SenderTransport; log: SenderLog } {
  const log: SenderLog = { toClient: [], closed: [] };
  const transport: SenderTransport = {
    sendToShard(): void {},
    sendTextToShard(): void {},
    sendTextToClient(text): void {
      log.toClient.push(text);
    },
    connectShard(): void {},
    disconnectShard(): void {},
    closeClient(code): void {
      log.closed.push(code);
    },
    notifyControl(): void {},
    scheduleAt(): void {},
  };
  return { transport, log };
}

test("送信ノードはキーフレーム要求とエンコーダ指令をクライアントへ中継する", () => {
  const { transport, log } = senderRecorder();
  let state = createSenderHandlerState(1, T0);
  const request = JSON.stringify({
    t: "keyframeRequest",
    senderId: 42,
    channel: CHANNEL_VIDEO,
    spatialId: 3,
  });
  state = handleUpstreamText(state, request, T0, transport);
  assert.equal(log.toClient.length, 1, "クライアントへ中継する");

  // 規定間隔内の重複は無視する（受理側の防御）。
  state = handleUpstreamText(state, request, T0 + KEYFRAME_REQUEST_MIN_INTERVAL_MS - 1, transport);
  assert.equal(log.toClient.length, 1, "超過分を無視する");
  state = handleUpstreamText(state, request, T0 + KEYFRAME_REQUEST_MIN_INTERVAL_MS, transport);
  assert.equal(log.toClient.length, 2, "間隔に達したら中継する");

  const directive = JSON.stringify({
    t: "encoderDirective",
    channel: CHANNEL_VIDEO,
    maxSpatialLayers: 3,
    maxTemporalLayers: 3,
    targetBitrate: V_1080P60.targetBitrate,
    forceKeyframe: false,
  });
  state = handleUpstreamText(state, directive, T0, transport);
  assert.equal(log.toClient.length, 3, "指令も中継する");
  assert.equal(log.toClient[2], directive, "形を変えない");
  assert.equal(log.closed.length, 0);
});

test("固定窓の計数は上限を超えた件で拒否し、窓が明けたら再び通す", () => {
  let window = initialRateWindow(T0);
  for (let index = 0; index < MAX_INBOUND_MESSAGES_PER_SEC_PER_CLIENT; index += 1) {
    const decision = admit(window, T0, 1000, MAX_INBOUND_MESSAGES_PER_SEC_PER_CLIENT);
    window = decision.window;
    assert.equal(decision.allowed, true);
  }
  const over = admit(window, T0, 1000, MAX_INBOUND_MESSAGES_PER_SEC_PER_CLIENT);
  assert.equal(over.allowed, false, "上限 + 1 件目を拒否する");
  const nextWindow = admit(over.window, T0 + 1000, 1000, MAX_INBOUND_MESSAGES_PER_SEC_PER_CLIENT);
  assert.equal(nextWindow.allowed, true, "窓が明けたら通す");
  assert.equal(nextWindow.window.count, 1);
});

test("送信ノードは受信メッセージレートの上限を超えた接続を閉じる", () => {
  const { transport, log } = senderRecorder();
  let state = createSenderHandlerState(1, T0);
  const text = JSON.stringify({ t: "未知" });
  for (let index = 0; index <= MAX_INBOUND_MESSAGES_PER_SEC_PER_CLIENT; index += 1) {
    state = senderClientText(state, text, T0, transport);
  }
  assert.equal(log.closed.length, 1, "1 回だけ閉じる");
  assert.equal(log.closed[0], ERROR_DEFINITIONS.E_RATE_LIMIT_MESSAGES.closeCode);
});

test("受信ノードは受信メッセージレートの上限を超えた接続を閉じる", () => {
  const closed: number[] = [];
  const transport: ReceiverTransport = {
    sendToClient(): void {},
    sendTextToClient(): void {},
    sendUpstream(): void {},
    closeClient(code): void {
      closed.push(code);
    },
  };
  let state = createReceiverHandlerState(V_360P15.targetBitrate, T0);
  for (let index = 0; index <= MAX_INBOUND_MESSAGES_PER_SEC_PER_CLIENT; index += 1) {
    state = receiverClientText(state, JSON.stringify({ t: "未知" }), T0, transport);
  }
  assert.equal(closed.length, 1);
  assert.equal(closed[0], ERROR_DEFINITIONS.E_RATE_LIMIT_MESSAGES.closeCode);
});

test("nodeHelloAck は往復で一致し、形式違反は失敗として返る", () => {
  const room = "m-abc123-vs-1";
  const parsed = parseNodeHelloAck(buildNodeHelloAck(room));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.value.nodeId : "", room);

  assert.equal(parseNodeHelloAck("{壊れている").ok, false);
  assert.equal(parseNodeHelloAck(JSON.stringify({ t: "nodeHello" })).ok, false);
  assert.equal(parseNodeHelloAck(JSON.stringify({ t: "nodeHelloAck" })).ok, false);
  assert.equal(parseNodeHelloAck(JSON.stringify({ t: "nodeHelloAck", nodeId: "" })).ok, false);
});
