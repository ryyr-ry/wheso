/**
 * 受信ノードの伝送層アダプタの試験。
 *
 * 判断コアの試験（tests/receiver-core.test.ts）とは別に、
 * 制御メッセージの翻訳と、出力コマンドの送信への写しを確かめる。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createReceiverHandlerState,
  handleClientBinary,
  handleClientText,
  handleSenderLeave,
  handleUpstreamBinary,
  type ReceiverHandlerState,
  type ReceiverTransport,
} from "../packages/server/src/receiver-handler.ts";
import { encodeMediaMessage } from "../packages/core/src/wire.ts";
import {
  CHANNEL_VIDEO,
  FLAG_END_OF_FRAME,
  FLAG_KEY,
  WIRE_MAGIC,
} from "../packages/core/src/generated/wire-layout.ts";
import { V_4K60 } from "../packages/core/src/generated/constants.ts";

interface Log {
  readonly client: number[];
  readonly clientText: string[];
  readonly upstream: string[];
  readonly closed: number[];
}

function recorder(): { transport: ReceiverTransport; log: Log } {
  const log: Log = { client: [], clientText: [], upstream: [], closed: [] };
  const transport: ReceiverTransport = {
    sendToClient(bytes) {
      log.client.push(bytes.length);
    },
    sendTextToClient(text) {
      log.clientText.push(text);
    },
    sendUpstream(text) {
      log.upstream.push(text);
    },
    closeClient(code) {
      log.closed.push(code);
    },
  };
  return { transport, log };
}

function mediaBytes(senderId: number, spatialId: number, temporalId: number): Uint8Array {
  const encoded = encodeMediaMessage({
    channel: CHANNEL_VIDEO,
    senderId,
    units: [
      {
        sequenceNumber: 1,
        captureTimestampUs: 1_000_000n,
        flags: FLAG_END_OF_FRAME | FLAG_KEY,
        spatialId,
        temporalId,
        payload: new Uint8Array(32),
      },
    ],
  });
  assert.equal(encoded.ok, true);
  return encoded.ok ? encoded.value : new Uint8Array(0);
}

/** 高品質 1 本を賄える予算（bytes/sec）。 */
const BUDGET = Math.trunc((V_4K60.targetBitrate * 10) / (8 * 9)) + 1;

function subscribed(): { state: ReceiverHandlerState; transport: ReceiverTransport; log: Log } {
  const { transport, log } = recorder();
  let state = createReceiverHandlerState(BUDGET);
  state = handleClientText(
    state,
    JSON.stringify({
      t: "subscribe",
      entries: [{ senderId: 7, channel: CHANNEL_VIDEO, maxSpatialId: V_4K60.spatialId, maxTemporalId: 7 }],
    }),
    transport,
  );
  return { state, transport, log };
}

test("購読メッセージは上流への購読要求とキーフレーム要求になる", () => {
  const { log } = subscribed();
  const kinds: string[] = [];
  for (const text of log.upstream) {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }
    const record: Record<string, unknown> = { ...parsed };
    const kind = record["t"];
    if (typeof kind === "string") {
      kinds.push(kind);
    }
  }
  assert.ok(kinds.includes("subscribe"), "購読要求を上流へ送る");
  assert.ok(kinds.includes("keyframeRequest"), "キーフレーム要求を上流へ送る");
});

test("要求 tier 以下のメディアはクライアントへ転送される", () => {
  const { state, transport, log } = subscribed();
  handleUpstreamBinary(state, mediaBytes(7, 0, 0), transport);
  assert.equal(log.client.length, 1, "クライアントへ 1 回転送する");
});

test("要求 tier を超えるメディアは転送されない", () => {
  const { state, transport, log } = subscribed();
  // 表示寸法の申告が無いため tier は 0 に留まる（ADR-0015）。
  handleUpstreamBinary(state, mediaBytes(7, 3, 0), transport);
  assert.equal(log.client.length, 0);
});

test("表示寸法を申告すると上流へ tier の更新が送られる", () => {
  const { state, transport, log } = subscribed();
  const before = log.upstream.length;
  handleClientText(
    state,
    JSON.stringify({ t: "displaySize", senderId: 7, channel: CHANNEL_VIDEO, width: 3840 }),
    transport,
  );
  assert.ok(log.upstream.length > before, "上流へ購読の更新が送られる");
  const added = log.upstream.slice(before);
  // setTier は購読の更新として、続くキーフレーム要求は別のメッセージとして送られる。
  assert.ok(
    added.some((text) => text.includes(`"maxSpatialId":${V_4K60.spatialId}`)),
    "高品質の tier を含む購読更新がある",
  );
  assert.ok(added.some((text) => text.includes("keyframeRequest")), "キーフレーム要求も送る");
});

test("上流の壊れたメディアはクライアント接続を閉じない", () => {
  const { state, transport, log } = subscribed();
  const broken = new Uint8Array([WIRE_MAGIC ^ 0xff, 1, CHANNEL_VIDEO, 1, 0, 0, 0, 1]);
  handleUpstreamBinary(state, broken, transport);
  assert.equal(log.closed.length, 0, "上流の不正で利用者を切断しない");
  assert.equal(log.client.length, 0);
});

test("クライアントが送った壊れたメディアは接続を閉じる", () => {
  const { state, transport, log } = subscribed();
  const broken = new Uint8Array([WIRE_MAGIC ^ 0xff, 1, CHANNEL_VIDEO, 1, 0, 0, 0, 1]);
  handleClientBinary(state, broken, transport);
  assert.equal(log.closed.length, 1);
});

test("report の下り帯域が予算に反映される", () => {
  const { state, transport, log } = subscribed();
  const before = log.upstream.length;
  const after = handleClientText(
    state,
    JSON.stringify({ t: "report", downlinkBps: 400_000, arrivalDelaySamplesUs: [1000, 1000, 1000] }),
    transport,
  );
  assert.equal(after.core.targetBytesPerSec, Math.trunc(400_000 / 8));
  assert.ok(log.upstream.length >= before, "予算の変化に応じて上流へ反映しうる");
});

test("送信者の退出で購読が消える", () => {
  const { state, transport } = subscribed();
  const after = handleSenderLeave(state, 7, transport);
  assert.equal(after.core.streams.length, 0);
});

test("未知の制御メッセージと壊れた JSON は無視される", () => {
  const { state, transport, log } = subscribed();
  const a = handleClientText(state, JSON.stringify({ t: "未知", x: 1 }), transport);
  const b = handleClientText(a, "{壊れている", transport);
  assert.equal(log.closed.length, 0);
  assert.equal(b.core.streams.length, state.core.streams.length);
});

test("非表示の通知で購読が解除され、再表示で購読とキーフレーム要求が出る", () => {
  const { state, transport, log } = subscribed();
  const hidden = handleClientText(state, JSON.stringify({ t: "visibility", visible: false }), transport);
  assert.equal(hidden.core.streams[0]?.phase, "PAUSED");
  const beforeShow = log.upstream.length;
  const shown = handleClientText(hidden, JSON.stringify({ t: "visibility", visible: true }), transport);
  assert.equal(shown.core.streams[0]?.phase, "SUBSCRIBED");
  assert.ok(log.upstream.length > beforeShow);
});
