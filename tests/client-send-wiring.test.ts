/**
 * 入口（`joinWith`）が取得と送出を繋いでいることを検証する。
 *
 * **なぜ独立した試験にするか。** `send-pipeline` の単体試験は「渡されたものを正しく
 * ワイヤ化して渡す」ことしか示さない。渡す側（取得の端）と受ける側（送信部屋のソケット）が
 * 入口で繋がっていなければ、単体試験は緑のまま 1 バイトも出ない。段 F まで実際に
 * その状態であり、符号化器を作る場所が製品コードに存在しなかった。
 *
 * 検証する性質:
 *   1. 参加すると取得が始まり、はしごに合わせて符号化器が用意される
 *   2. 符号化できた映像は**映像送信部屋のソケットへバイナリとして出る**
 *   3. 符号化できた音声は束ねられて**音声送信部屋のソケットへ出る**
 *   4. 源の実測値がはしごに反映される（ADR-0026。拡大しない）
 *   5. `keyframeRequest` は取得の端へ届く（wire-format.md 2.5）
 *   6. カメラを切ると取得も止まる
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { joinWith, type JoinSocket } from "../packages/client/src/api/join-meeting.ts";
import type { FrameSink } from "../packages/client/src/api/meeting.ts";
import type { CaptureDeps, CaptureOutput } from "../packages/client/src/media/browser-capture.ts";
import type { SendRung } from "../packages/core/src/ladder.ts";
import { issueToken } from "../packages/core/src/auth.ts";
import { AUDIO_UNITS_PER_MESSAGE } from "../packages/core/src/generated/constants.ts";
import { decodeMediaMessage } from "../packages/core/src/wire.ts";

const MEETING_ID = "01jxy8kq2r3mz5v7h9abcderfa";
const USER_ID = "550e8400e29b41d4a716446655440000";
const TOKEN_KEY = "wheso-dev-token-key-not-a-secret";
const T0 = 5_000_000;

interface FakeSocket extends JoinSocket {
  readonly texts: string[];
  readonly binaries: Uint8Array[];
  readonly fireOpen: () => void;
  readonly fireText: (text: string) => void;
}

function fakeSocket(): FakeSocket {
  const texts: string[] = [];
  const binaries: Uint8Array[] = [];
  const openHandlers: (() => void)[] = [];
  const textHandlers: ((text: string) => void)[] = [];
  return {
    texts,
    binaries,
    send: (text): void => {
      texts.push(text);
    },
    sendBinary: (bytes): void => {
      binaries.push(bytes);
    },
    close: (): void => undefined,
    onText: (handler): void => {
      textHandlers.push(handler);
    },
    onBinary: (): void => undefined,
    onOpen: (handler): void => {
      openHandlers.push(handler);
    },
    onClose: (): void => undefined,
    bufferedBytes: (): number => 0,
    fireOpen: (): void => {
      for (const handler of openHandlers) {
        handler();
      }
    },
    fireText: (text): void => {
      for (const handler of textHandlers) {
        handler(text);
      }
    },
  };
}

function sink(): FrameSink {
  return {
    attach: (): void => undefined,
    detach: (): void => undefined,
    setDisplaySize: (): void => undefined,
    draw: (): void => undefined,
  };
}

interface CaptureRecord {
  readonly deps: CaptureDeps;
  readonly configured: SendRung[][];
  readonly keyframes: number[];
  readonly videoEnabled: boolean[];
  readonly audioEnabled: boolean[];
  output: () => CaptureOutput | null;
  readonly started: () => number;
}

/** 取得の偽物。実測の源を返し、出力の宛先を記録する。 */
function fakeCapture(source: { width: number; height: number; framerate: number } | null): CaptureRecord {
  const configured: SendRung[][] = [];
  const keyframes: number[] = [];
  const videoEnabled: boolean[] = [];
  const audioEnabled: boolean[] = [];
  let output: CaptureOutput | null = null;
  let starts = 0;
  return {
    configured,
    keyframes,
    videoEnabled,
    audioEnabled,
    output: (): CaptureOutput | null => output,
    started: (): number => starts,
    deps: {
      bindCapture: (next): void => {
        output = next;
      },
      startCapture: async (request) => {
        starts += 1;
        return {
          source: request.camera ? source : null,
          video: request.camera && source !== null,
          audio: request.microphone,
        };
      },
      configureVideo: (rungs): void => {
        configured.push([...rungs]);
      },
      configureAudio: (): void => undefined,
      requestKeyframe: (spatialId): void => {
        keyframes.push(spatialId);
      },
      setVideoEnabled: (enabled): void => {
        videoEnabled.push(enabled);
      },
      setAudioEnabled: (enabled): void => {
        audioEnabled.push(enabled);
      },
      encodeQueueSize: (): number => 0,
      close: (): void => undefined,
    },
  };
}

async function joinUrl(): Promise<string> {
  const nowSec = Math.trunc(T0 / 1000);
  const token = await issueToken(new TextEncoder().encode(TOKEN_KEY), {
    iss: "wheso-test",
    sub: USER_ID,
    aud: MEETING_ID,
    iat: nowSec,
    exp: nowSec + 60,
    jti: "j-send-wiring",
    kind: "client",
    role: "host",
  });
  assert.equal(token.ok, true);
  return `https://example.test/j/${MEETING_ID}#${token.ok ? token.value : ""}`;
}

interface Harness {
  readonly sockets: Map<string, FakeSocket>;
  readonly capture: CaptureRecord;
}

async function join(
  options: { camera?: boolean; microphone?: boolean } = {},
  source: { width: number; height: number; framerate: number } | null = {
    width: 1920,
    height: 1080,
    framerate: 30,
  },
): Promise<Harness> {
  const sockets = new Map<string, FakeSocket>();
  const capture = fakeCapture(source);
  const joined = await joinWith(
    await joinUrl(),
    {
      openSocket: (_url, role): JoinSocket => {
        const created = fakeSocket();
        sockets.set(role, created);
        return created;
      },
      createSink: (): FrameSink => sink(),
      bindOutput: (): void => undefined,
      capability: { hardwareAv1For4K60: false, encodeAv1: true, mobile: false, charging: true },
      source: { width: 640, height: 360, framerate: 15 },
      now: (): number => T0,
      scheduleAt: (): (() => void) => (): void => undefined,
      setPeriodic: (): (() => void) => (): void => undefined,
      media: {
        configureDecoder: (): void => undefined,
        resetDecoder: (): void => undefined,
        closeDecoder: (): void => undefined,
        decodeVideo: (): void => undefined,
        enqueueAudio: (): void => undefined,
        videoDecodeLatencyMs: (): number => 0,
      },
      capture: capture.deps,
    },
    options,
  );
  assert.equal(joined.ok, true, "参加できる");
  // 送出はソケットが開いてから行う（開く前の媒体は捨てる）。
  for (const socket of sockets.values()) {
    socket.fireOpen();
  }
  return { sockets, capture };
}

test("参加すると取得が始まり、源の実測値からはしごが決まる", async () => {
  const harness = await join();
  assert.equal(harness.capture.started(), 1, "取得を始める");
  const rungs = harness.capture.configured[harness.capture.configured.length - 1];
  assert.ok(rungs !== undefined && rungs.length > 0, "符号化器を用意する");
  for (const rung of rungs) {
    assert.ok(rung.width <= 1920 && rung.framerate <= 30, "**源より大きい段を作らない**（ADR-0026）");
  }
  assert.ok(
    rungs.some((rung) => rung.width === 1920),
    "源に収まる最上段を作る（注入した既定の 640 のままではない）",
  );
});

test("符号化できた映像は映像送信部屋へバイナリとして出る", async () => {
  const harness = await join();
  const output = harness.capture.output();
  assert.ok(output !== null, "取得の出力が繋がっている");
  output.onVideo({
    spatialId: 0,
    temporalId: 0,
    temporalLayers: 3,
    isKey: true,
    captureTimestampUs: 1_000n,
    payload: new Uint8Array([1, 2, 3]),
  });
  const videoSocket = harness.sockets.get("vs");
  assert.ok(videoSocket !== undefined);
  assert.equal(videoSocket.binaries.length, 1, "**映像送信部屋へ 1 通出る**");
  const bytes = videoSocket.binaries[0];
  assert.ok(bytes !== undefined);
  const decoded = decodeMediaMessage(bytes);
  assert.equal(decoded.ok, true, "ワイヤ形式として正しい");
  // 他の部屋へは出ない。
  assert.equal(harness.sockets.get("as")?.binaries.length, 0);
  assert.equal(harness.sockets.get("vr")?.binaries.length, 0);
});

test("符号化できた音声は束ねられて音声送信部屋へ出る", async () => {
  const harness = await join();
  const output = harness.capture.output();
  assert.ok(output !== null);
  for (let index = 0; index < AUDIO_UNITS_PER_MESSAGE; index += 1) {
    output.onAudio({
      captureTimestampUs: BigInt(index * 20_000),
      silent: false,
      payload: new Uint8Array([5, 5]),
    });
  }
  const audioSocket = harness.sockets.get("as");
  assert.ok(audioSocket !== undefined);
  assert.equal(audioSocket.binaries.length, 1, "**音声送信部屋へ 1 通出る**");
  assert.equal(harness.sockets.get("vs")?.binaries.length, 0, "映像部屋へは出ない");
});

test("キーフレーム要求は取得の端へ届く", async () => {
  const harness = await join();
  const videoSocket = harness.sockets.get("vs");
  assert.ok(videoSocket !== undefined);
  videoSocket.fireText(JSON.stringify({ t: "keyframeRequest", senderId: 1, channel: 1, spatialId: 1 }));
  assert.deepEqual(harness.capture.keyframes, [1], "要求された段でキーフレームを出す");
});

test("カメラを切って参加すると取得を止めた状態で始まる", async () => {
  const harness = await join({ camera: false });
  assert.deepEqual(harness.capture.videoEnabled.slice(0, 1), [false], "映像の送出を止める");
  const rungs = harness.capture.configured[0];
  assert.ok(rungs !== undefined, "はしごは用意する（再開に備える）");
});
