/**
 * E2E の本体（ブラウザ側）。
 *
 * 目的: 実際の映像と音声が、実際の Durable Object を通って、実際に復号できることを示す。
 * 単体試験と結合試験が通っても、符号化・転送・復号の全体が動く証明にはならない。
 *
 * 流れ:
 *   1. 既知の模様を描いた `VideoFrame` を作る（カメラを使わない。CI にカメラは無い）
 *   2. WebCodecs の `VideoEncoder` で符号化する（AV1 が使えなければ H.264）
 *   3. core の `packEncoded` でワイヤ形式にし、送信側の WebSocket で中継部屋へ送る
 *   4. 受信側の WebSocket で受け取り、core の `decodeMediaMessage` で解析する
 *   5. `VideoDecoder` で復号し、画素を読んで送った模様と一致することを確かめる
 *
 * 結果は `window.__whesoResult` に入れる。Playwright 側がこれを読む。
 */

import { packEncoded } from "../../../packages/client/src/media/encoder-set.ts";
import { decodeMediaMessage } from "../../../packages/core/src/wire.ts";
import { deriveMeetingSecret, nodeAuthTag, nodeAuthTimeWindow } from "../../../packages/core/src/auth.ts";
import { CHANNEL_VIDEO } from "../../../packages/core/src/generated/wire-layout.ts";

interface E2eResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly codec: string;
  readonly framesSent: number;
  readonly framesDecoded: number;
  /** 復号した画素の平均色。送信側の模様と一致するはずである。 */
  readonly decodedColor: readonly number[];
  readonly expectedColor: readonly number[];
  readonly glassToGlassMs: number;
}

declare global {
  interface Window {
    __whesoResult?: E2eResult;
    __whesoRun?: (wsBase: string, room: string, nodeKey: string) => Promise<E2eResult>;
    /** 否定対照。購読しない送信者を指定するため、何も届かず失敗するはずである。 */
    __whesoRunNegative?: (wsBase: string, room: string, nodeKey: string) => Promise<E2eResult>;
  }
}

const WIDTH = 320;
const HEIGHT = 240;
const FRAME_COUNT = 30;
/** 送信する模様の色（R, G, B）。復号後にこの色に近いことを確かめる。 */
const PATTERN_COLOR: readonly number[] = [32, 160, 64];

/** 既知の模様を描いた canvas を作る。位置で変化する縞を入れ、単色との違いを検出できるようにする。 */
function drawPattern(index: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("2d context を得られない");
  }
  context.fillStyle = `rgb(${PATTERN_COLOR[0]}, ${PATTERN_COLOR[1]}, ${PATTERN_COLOR[2]})`;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  // 動きを入れる。動きが無いとエンコーダが 1 枚しか出さないことがある。
  context.fillStyle = "rgb(255, 255, 255)";
  context.fillRect((index * 8) % WIDTH, 0, 8, HEIGHT);
  return canvas;
}

/** 使える符号化器を探す。AV1 を優先し、無ければ H.264 を使う。 */
async function pickCodec(): Promise<string | null> {
  const candidates = ["av01.0.04M.08", "avc1.42E01F", "vp8"];
  for (const codec of candidates) {
    const support = await VideoEncoder.isConfigSupported({
      codec,
      width: WIDTH,
      height: HEIGHT,
      framerate: 15,
      bitrate: 300_000,
    });
    if (support.supported === true) {
      return codec;
    }
  }
  return null;
}

async function run(wsBase: string, room: string, nodeKey: string, subscribeSenderId = 1): Promise<E2eResult> {
  const fail = (detail: string, codec = ""): E2eResult => ({
    ok: false,
    detail,
    codec,
    framesSent: 0,
    framesDecoded: 0,
    decodedColor: [],
    expectedColor: PATTERN_COLOR,
    glassToGlassMs: 0,
  });

  const codec = await pickCodec();
  if (codec === null) {
    return fail("使える符号化器が無い");
  }

  // --- 受信側と送信側の接続を張る ---
  const receiver = new WebSocket(`${wsBase}/parties/shard/${room}?_pk=2`);
  receiver.binaryType = "arraybuffer";
  const sender = new WebSocket(`${wsBase}/parties/shard/${room}?_pk=1`);
  await Promise.all([waitOpen(receiver), waitOpen(sender)]);

  receiver.send(
    JSON.stringify({
      t: "subscribe",
      entries: [{ senderId: subscribeSenderId, channel: CHANNEL_VIDEO, maxSpatialId: 3, maxTemporalId: 7 }],
    }),
  );
  await sendNodeHello(sender, room, nodeKey);
  await sleep(300);

  // --- 復号器を用意する ---
  const decodedFrames: VideoFrame[] = [];
  let decodeError = "";
  const decoder = new VideoDecoder({
    output: (frame) => {
      decodedFrames.push(frame);
    },
    error: (error) => {
      decodeError = error.message;
    },
  });
  decoder.configure({ codec, codedWidth: WIDTH, codedHeight: HEIGHT });

  const arrivals: ArrayBuffer[] = [];
  receiver.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.data instanceof ArrayBuffer) {
      arrivals.push(event.data);
    }
  });

  // --- 符号化して送る ---
  let framesSent = 0;
  let encodeError = "";
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const payload = new Uint8Array(chunk.byteLength);
      chunk.copyTo(payload);
      const packed = packEncoded({
        channel: CHANNEL_VIDEO,
        senderId: 1,
        sequenceNumber: framesSent + 1,
        captureTimestampUs: BigInt(Math.trunc(chunk.timestamp)),
        spatialId: 0,
        temporalId: temporalOf(metadata),
        temporalLayers: 1,
        isKey: chunk.type === "key",
        payload,
      });
      if (!packed.ok) {
        encodeError = `詰め込みに失敗: ${packed.error.code}`;
        return;
      }
      sender.send(packed.value);
      framesSent += 1;
    },
    error: (error) => {
      encodeError = error.message;
    },
  });
  encoder.configure({ codec, width: WIDTH, height: HEIGHT, framerate: 15, bitrate: 300_000 });

  const startedAt = performance.now();
  for (let index = 0; index < FRAME_COUNT; index += 1) {
    const canvas = drawPattern(index);
    const frame = new VideoFrame(canvas, { timestamp: index * 66_667 });
    encoder.encode(frame, { keyFrame: index === 0 });
    frame.close();
    await sleep(10);
  }
  await encoder.flush();
  if (encodeError !== "") {
    return fail(`符号化に失敗: ${encodeError}`, codec);
  }

  // --- 到着を待ち、解析して復号する ---
  await waitUntil(() => arrivals.length >= framesSent, subscribeSenderId === 1 ? 8000 : 2000);
  const glassToGlassMs = performance.now() - startedAt;

  for (const buffer of arrivals) {
    const decodedMessage = decodeMediaMessage(new Uint8Array(buffer));
    if (!decodedMessage.ok) {
      return fail(`ワイヤ解析に失敗: ${decodedMessage.error.code}`, codec);
    }
    for (const unit of decodedMessage.value.units) {
      const isKey = (unit.flags & 0x01) !== 0;
      decoder.decode(
        new EncodedVideoChunk({
          type: isKey ? "key" : "delta",
          timestamp: Number(unit.captureTimestampUs),
          data: unit.payload,
        }),
      );
    }
  }
  await decoder.flush();
  if (decodeError !== "") {
    return fail(`復号に失敗: ${decodeError}`, codec);
  }

  // --- 画素を確かめる ---
  const lastFrame = decodedFrames[decodedFrames.length - 1];
  if (lastFrame === undefined) {
    return fail("復号したフレームが無い", codec);
  }
  const color = await averageColor(lastFrame);
  for (const frame of decodedFrames) {
    frame.close();
  }

  // 縞（白）が 8/320 画素分入るため平均はわずかに明るくなる。AV1 は非可逆であるため
  // 完全一致はしないが、実測の差は 4〜5 である。許容幅 10 とし、別の映像が来たら落ちるようにする。
  // 監査の指摘: 許容幅 40 では「近い色のノイズ」を通してしまう。
  const TOLERANCE = 10;
  const withinTolerance = PATTERN_COLOR.every((expected, index) => {
    const actual = color[index] ?? 0;
    return Math.abs(actual - expected) <= TOLERANCE;
  });

  return {
    ok: withinTolerance && arrivals.length >= framesSent && framesSent > 0,
    detail: withinTolerance ? "" : "復号した画素が送信した模様と一致しない",
    codec,
    framesSent,
    framesDecoded: decodedFrames.length,
    decodedColor: color,
    expectedColor: PATTERN_COLOR,
    glassToGlassMs: Math.trunc(glassToGlassMs),
  };
}

/** フレームの平均色を求める。描画して読み出す。 */
async function averageColor(frame: VideoFrame): Promise<readonly number[]> {
  const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
  const context = canvas.getContext("2d");
  if (context === null) {
    return [];
  }
  context.drawImage(frame, 0, 0);
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let r = 0;
  let g = 0;
  let b = 0;
  const pixels = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i] ?? 0;
    g += data[i + 1] ?? 0;
    b += data[i + 2] ?? 0;
  }
  return [Math.trunc(r / pixels), Math.trunc(g / pixels), Math.trunc(b / pixels)];
}

/**
 * メタデータから temporalId を取り出す。
 * 型定義に `svc` が無い環境があるため、型を信用せず実行時に検査する。
 */
function temporalOf(metadata: unknown): number {
  if (typeof metadata !== "object" || metadata === null) {
    return 0;
  }
  const record: Record<string, unknown> = { ...metadata };
  const svc = record["svc"];
  if (typeof svc === "object" && svc !== null) {
    const svcRecord: Record<string, unknown> = { ...svc };
    const layer = svcRecord["temporalLayerId"];
    if (typeof layer === "number") {
      return layer;
    }
  }
  return 0;
}

function waitOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === socket.OPEN) {
      resolve();
      return;
    }
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("接続に失敗した")), { once: true });
  });
}

/**
 * 中継部屋へノードとして認証する（wire-format.md 2.8）。
 * 認証前のメディアは破棄されるため、送信の前に必ず送る。
 */
async function sendNodeHello(socket: WebSocket, room: string, nodeKey: string): Promise<void> {
  const parts = room.split("-");
  const meetingId = parts[1] ?? "";
  const secret = await deriveMeetingSecret(new TextEncoder().encode(nodeKey), meetingId);
  if (!secret.ok) {
    return;
  }
  const window = nodeAuthTimeWindow(Math.trunc(Date.now() / 1000));
  const tag = await nodeAuthTag(secret.value, room, "sender", window);
  if (!tag.ok) {
    return;
  }
  socket.send(JSON.stringify({ t: "nodeHello", role: "sender", nodeId: room, authTag: tag.value }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (condition()) {
      return true;
    }
    await sleep(50);
  }
  return condition();
}

window.__whesoRunNegative = async (wsBase: string, room: string, nodeKey: string): Promise<E2eResult> => {
  // 購読していない送信者を指定する。中継ノードは転送しないため、復号できるフレームは 0 になる。
  const result = await run(wsBase, room, nodeKey, 999);
  window.__whesoResult = result;
  return result;
};

window.__whesoRun = async (wsBase: string, room: string, nodeKey: string): Promise<E2eResult> => {
  try {
    const result = await run(wsBase, room, nodeKey);
    window.__whesoResult = result;
    return result;
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
    const failed: E2eResult = {
      ok: false,
      detail,
      codec: "",
      framesSent: 0,
      framesDecoded: 0,
      decodedColor: [],
      expectedColor: PATTERN_COLOR,
      glassToGlassMs: 0,
    };
    window.__whesoResult = failed;
    return failed;
  }
};
