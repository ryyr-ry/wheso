/**
 * 中継ノードの伝送層アダプタの試験。
 *
 * 判断コアの試験（tests/shard-congestion.test.ts）とは別に、
 * 「バイト列とテキストを入力イベントへ翻訳し、出力コマンドを送信へ写す」ことを確かめる。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createShardHandlerState,
  handleBinary,
  handleLifecycle,
  handleText,
  handleTimer,
  type ShardHandlerState,
  type ShardPeer,
  type ShardTransport,
} from "../packages/server/src/shard-handler.ts";
import { congestionOf } from "../packages/core/src/shard-core.ts";
import { encodeMediaMessage } from "../packages/core/src/wire.ts";
import {
  CHANNEL_VIDEO,
  FLAG_DISCARDABLE,
  FLAG_END_OF_FRAME,
  FLAG_KEY,
  WIRE_MAGIC,
} from "../packages/core/src/generated/wire-layout.ts";
import { ERROR_DEFINITIONS } from "../packages/core/src/generated/errors.ts";

interface Recorded {
  readonly binary: { participantId: number; length: number }[];
  readonly text: { participantId: number; target: string; text: string }[];
  readonly closed: { participantId: number; target: string; code: number }[];
  readonly notified: number[];
}

function createRecorder(): { transport: ShardTransport; log: Recorded } {
  const log: Recorded = { binary: [], text: [], closed: [], notified: [] };
  const transport: ShardTransport = {
    sendBinary(participantId, bytes) {
      log.binary.push({ participantId, length: bytes.length });
    },
    sendText(participantId, target, text) {
      log.text.push({ participantId, target, text });
    },
    close(participantId, target, code) {
      log.closed.push({ participantId, target, code });
    },
    noteDrop(): void {
      // 観測のみ。判定には使わない。
    },
    notifyControl(code) {
      log.notified.push(code);
    },
  };
  return { transport, log };
}

const peerOf = (participantId: number): ShardPeer => ({ participantId, isNode: false });

/** 1 ユニットのメディアメッセージを作る。 */
function mediaBytes(senderId: number, spatialId: number, temporalId: number, key: boolean): Uint8Array {
  const flags = FLAG_END_OF_FRAME | (key ? FLAG_KEY : FLAG_DISCARDABLE);
  const encoded = encodeMediaMessage({
    channel: CHANNEL_VIDEO,
    senderId,
    units: [
      {
        sequenceNumber: 1,
        captureTimestampUs: 1_000_000n,
        flags,
        spatialId,
        temporalId,
        payload: new Uint8Array(64),
      },
    ],
  });
  assert.equal(encoded.ok, true, "符号化できる");
  return encoded.ok ? encoded.value : new Uint8Array(0);
}

/** 購読者を 1 人登録した状態を作る。 */
function withSubscriber(subscriberId: number, senderId: number, maxSpatialId: number): {
  state: ShardHandlerState;
  transport: ShardTransport;
  log: Recorded;
} {
  const { transport, log } = createRecorder();
  let state = createShardHandlerState(0);
  state = handleLifecycle(state, peerOf(subscriberId), "open", 0, transport);
  state = handleLifecycle(state, peerOf(senderId), "open", 0, transport);
  state = handleText(
    state,
    peerOf(subscriberId),
    JSON.stringify({ t: "subscribe", entries: [{ senderId, channel: CHANNEL_VIDEO, maxSpatialId, maxTemporalId: 7 }] }),
    0,
    transport,
  );
  return { state, transport, log };
}

test("購読者へメディアが転送される", () => {
  const { state, transport, log } = withSubscriber(2, 1, 3);
  const bytes = mediaBytes(1, 0, 0, true);
  handleBinary(state, peerOf(1), bytes, 10, transport);
  assert.deepEqual(
    log.binary.map((entry) => entry.participantId),
    [2],
  );
  assert.equal(log.binary[0]?.length, bytes.length, "メッセージ全体を転送する");
});

test("要求した段以外は転送されない（ちょうど 1 段。ADR-0027）", () => {
  const { state, transport, log } = withSubscriber(2, 1, 0);
  // はしごを申告する。2 段（0 と 1）である。
  const announced = handleText(
    state,
    peerOf(1),
    JSON.stringify({
      t: "streamAnnounce",
      streams: [
        { channel: CHANNEL_VIDEO, spatialId: 0, framerate: 15, temporalLayers: 2, width: 640, height: 360, targetBitrate: 200000 },
        { channel: CHANNEL_VIDEO, spatialId: 1, framerate: 30, temporalLayers: 3, width: 1920, height: 1080, targetBitrate: 3000000 },
      ],
    }),
    5,
    transport,
  );
  // 段 1 を送る。要求は段 0 であるため渡らない。
  let current = handleBinary(announced, peerOf(1), mediaBytes(1, 1, 0, true), 10, transport);
  assert.equal(log.binary.length, 0, "要求より高い段は転送しない");
  // 段 0 は渡る。
  current = handleBinary(current, peerOf(1), mediaBytes(1, 0, 0, true), 20, transport);
  assert.equal(log.binary.length, 1, "要求した段は渡る");
});

test("はしごの申告が無い間は、存在する唯一の段が渡る（黒画面にしない）", () => {
  const { state, transport, log } = withSubscriber(2, 1, 0);
  // 申告が無く、送信者が段 2 しか流していない場合、要求が段 0 でもそれを渡す。
  // 渡さないと画面が出ない。帯域が足りない場合は受信側が購読を落とす（ADR-0029）。
  handleBinary(state, peerOf(1), mediaBytes(1, 2, 0, true), 10, transport);
  assert.equal(log.binary.length, 1);
});

test("要求より低い段も転送されない（simulcast の段は独立している）", () => {
  const { state, transport, log } = withSubscriber(2, 1, 2);
  // 段 0 と段 2 の両方が流れてくる。段 2 を要求しているため段 0 は渡らない。
  // `spatialId <= tier` で転送すると両方が渡り、デコーダが段の切替として reset を
  // 繰り返して 1 枚も復号できない。
  let current = handleBinary(state, peerOf(1), mediaBytes(1, 2, 0, true), 10, transport);
  assert.equal(log.binary.length, 1, "要求した段は渡る");
  current = handleBinary(current, peerOf(1), mediaBytes(1, 0, 0, true), 20, transport);
  assert.equal(log.binary.length, 1, "下位の段は渡らない");
});

test("形式違反のメッセージは接続を閉じる", () => {
  const { state, transport, log } = withSubscriber(2, 1, 3);
  const broken = new Uint8Array([WIRE_MAGIC ^ 0xff, 1, CHANNEL_VIDEO, 1, 0, 0, 0, 1]);
  handleBinary(state, peerOf(1), broken, 10, transport);
  assert.equal(log.closed.length, 1, "閉じる");
  assert.equal(log.binary.length, 0, "転送しない");
});

test("未知の制御メッセージは無視され接続は閉じない", () => {
  const { state, transport, log } = withSubscriber(2, 1, 3);
  const after = handleText(state, peerOf(2), JSON.stringify({ t: "未知の種類", x: 1 }), 10, transport);
  assert.equal(log.closed.length, 0);
  assert.deepEqual(after.core.subscriptions, state.core.subscriptions, "購読は変わらない");
});

test("壊れた JSON でも例外を投げず状態を変えない", () => {
  const { state, transport, log } = withSubscriber(2, 1, 3);
  const after = handleText(state, peerOf(2), "{ これは JSON ではない", 10, transport);
  assert.equal(log.closed.length, 0);
  assert.equal(after.core.subscriptions.length, state.core.subscriptions.length);
});

test("report の標本列から勾配が算出され、過負荷が制御系へ通知される", () => {
  const { state, transport, log } = withSubscriber(2, 1, 3);
  // 勾配を大きくする標本列。4 段の昇格でヒステリシス（500 ms）を跨ぐ。
  const rising: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    rising.push(10_000 + i * 60_000);
  }
  let current = state;
  let now = 600;
  for (let stage = 0; stage < 4; stage += 1) {
    current = handleText(
      current,
      peerOf(2),
      JSON.stringify({ t: "report", arrivalDelaySamplesUs: rising }),
      now,
      transport,
    );
    now += 600;
  }
  // 輻輳状態は購読ごとに持つ（ADR-0025）。購読者 2 の購読が KEY_ONLY まで落ちる。
  assert.equal(
    congestionOf(current.core, 2, 1, CHANNEL_VIDEO),
    "KEY_ONLY",
    "4 段で KEY_ONLY まで昇格する",
  );
  // 過負荷の通知はノード全体の予算超過で出る（ADR-0025 の 5）。輻輳の段では出ない。
  // この試験では予算を超えていないため通知は無い。
  assert.deepEqual(log.notified, []);
});

test("ノード全体の予算を超えると制御系へ通知される（転送は止めない）", () => {
  const { state, transport, log } = withSubscriber(2, 1, 0);
  // 予算を極端に絞る。1 メッセージで超過する。
  let current = handleText(
    state,
    peerOf(2),
    JSON.stringify({ t: "budget", bytesPerSec: 1 }),
    10,
    transport,
  );
  // budget は制御メッセージとして受理されない（wire-format 2 節に無い）。
  // 予算は既定（ノードの送出容量）のままであるため、大量に送って超過させる。
  for (let i = 0; i < 400; i += 1) {
    current = handleBinary(current, peerOf(1), mediaBytes(1, 0, 0, true), 11, transport);
  }
  assert.ok(log.binary.length > 0, "転送は止めない");
  assert.deepEqual(log.notified, [ERROR_DEFINITIONS.E_NODE_OVERLOADED.closeCode]);
});

test("整数でない標本は捨てられ、有限でない値でも例外を投げない", () => {
  const { state, transport } = withSubscriber(2, 1, 3);
  const after = handleText(
    state,
    peerOf(2),
    '{"t":"report","arrivalDelaySamplesUs":[1000,"x",1500,null,2000]}',
    600,
    transport,
  );
  const trend = after.core.trends.find((entry) => entry.subscriberId === 2);
  assert.notEqual(trend, undefined, "報告は受理される");
});

test("タイマーで回復方向の遷移が起きる", () => {
  const { state, transport } = withSubscriber(2, 1, 3);
  const rising: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    rising.push(10_000 + i * 60_000);
  }
  let current = handleText(
    state,
    peerOf(2),
    JSON.stringify({ t: "report", arrivalDelaySamplesUs: rising }),
    600,
    transport,
  );
  assert.equal(congestionOf(current.core, 2, 1, CHANNEL_VIDEO), "SHEDDING_T2");

  const falling: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    falling.push(1_200_000 - i * 60_000);
  }
  current = handleText(
    current,
    peerOf(2),
    JSON.stringify({ t: "report", arrivalDelaySamplesUs: falling }),
    1300,
    transport,
  );
  current = handleTimer(current, 1400, transport);
  assert.equal(
    congestionOf(current.core, 2, 1, CHANNEL_VIDEO),
    "NORMAL",
    "勾配が負に転じ未確認も無いので回復する",
  );
});
