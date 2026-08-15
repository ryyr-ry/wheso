/**
 * 受信経路が「届いたユニットを 1 つも落とさずに復号へ渡す」ことの試験。
 *
 * **なぜ必要か。** 実環境ではクライアントのソケットに 40 件届いているのに復号へ渡ったのが
 * それより少ない、という状態が起きた（F-059）。ノードの計数では「クライアントへ送った」
 * までしか分からず、経路の中のどこで落ちたかは外から見えない。ここで局所に固定する。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createPipeline,
  handleMedia,
  noteFramerate,
  type DecodeInput,
  type PipelineDeps,
  type PipelineState,
} from "../packages/client/src/api/receive-pipeline.ts";
import { encodeMediaMessage } from "../packages/core/src/wire.ts";
import { CHANNEL_VIDEO, FLAG_END_OF_FRAME, FLAG_KEY } from "../packages/core/src/generated/wire-layout.ts";

const SENDER = 1393789807;

interface Harness {
  readonly deps: PipelineDeps;
  readonly decoded: DecodeInput[];
  setNow(ms: number): void;
}

function harness(): Harness {
  const decoded: DecodeInput[] = [];
  let now = 1_000_000;
  return {
    decoded,
    setNow: (ms): void => {
      now = ms;
    },
    deps: {
      now: (): number => now,
      configureDecoder: (): void => undefined,
      resetDecoder: (): void => undefined,
      closeDecoder: (): void => undefined,
      decodeVideo: (input): void => {
        decoded.push(input);
      },
      enqueueAudio: (): void => undefined,
        videoDecodeLatencyMs: (): number => 0,
      sendReceiveControl: (): void => undefined,
    },
  };
}

/** 1 フレーム 1 メッセージのバイト列を作る。 */
function videoMessage(sequenceNumber: number, captureUs: number, key: boolean, payload: Uint8Array): Uint8Array {
  const encoded = encodeMediaMessage({
    channel: CHANNEL_VIDEO,
    senderId: SENDER,
    units: [
      {
        sequenceNumber,
        captureTimestampUs: BigInt(captureUs),
        flags: FLAG_END_OF_FRAME | (key ? FLAG_KEY : 0),
        spatialId: 0,
        temporalId: 0,
        payload,
      },
    ],
  });
  assert.equal(encoded.ok, true, "符号化できる");
  return encoded.ok ? encoded.value : new Uint8Array();
}

test("**届いた 40 枚すべてが復号へ渡る**（欠落を許さない。F-059）", () => {
  const h = harness();
  let state: PipelineState = createPipeline(4, 1_000_000);
  state = noteFramerate(state, SENDER, 15);

  const intervalMs = 67;
  for (let index = 0; index < 40; index += 1) {
    const nowMs = 1_000_000 + index * intervalMs;
    h.setNow(nowMs);
    // 取得時刻は送信側の時計。受信側の時計と原点は同じ（同一処理で作るため）。
    const captureUs = nowMs * 1000;
    const payload = new Uint8Array([index & 0xff, 0xaa, 0xbb]);
    state = handleMedia(state, videoMessage(index + 1, captureUs, index === 0, payload), h.deps);
  }

  assert.equal(h.decoded.length, 40, `40 枚すべてが復号へ渡る（実際 ${String(h.decoded.length)}）`);
  for (let index = 0; index < 40; index += 1) {
    const entry = h.decoded[index];
    assert.ok(entry !== undefined);
    assert.equal(entry.payload[0], index & 0xff, `${String(index)} 枚目の内容が一致する`);
  }
});

test("音声を先に受けても映像は落ちない（提示時刻の対応付けが働く）", () => {
  const h = harness();
  let state: PipelineState = createPipeline(4, 1_000_000);
  state = noteFramerate(state, SENDER, 15);

  // 音声を 1 個受けて再生クロックの基準を作る。
  const audio = encodeMediaMessage({
    channel: 2,
    senderId: SENDER,
    units: [
      {
        sequenceNumber: 1,
        captureTimestampUs: BigInt(1_000_000 * 1000),
        flags: FLAG_END_OF_FRAME,
        spatialId: 0,
        temporalId: 0,
        payload: new Uint8Array([1, 2, 3]),
      },
    ],
  });
  assert.equal(audio.ok, true);
  if (audio.ok) {
    state = handleMedia(state, audio.value, h.deps);
  }

  for (let index = 0; index < 10; index += 1) {
    const nowMs = 1_000_000 + index * 67;
    h.setNow(nowMs);
    state = handleMedia(
      state,
      videoMessage(index + 1, nowMs * 1000, index === 0, new Uint8Array([index, 9, 9])),
      h.deps,
    );
  }
  assert.equal(h.decoded.length, 10, `映像 10 枚すべてが復号へ渡る（実際 ${String(h.decoded.length)}）`);
});
