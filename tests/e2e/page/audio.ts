/**
 * 音声の E2E（ブラウザ側）。
 *
 * 目的: 実際の音声が Opus で符号化され、規範どおり 40 ms 単位に束ねられ、
 * 実際の Durable Object を通って転送され、復号して波形が戻ることを示す。
 *
 * 音源はマイクを使わない（CI にマイクは無い）。既知の正弦波を生成する。
 * 判定は復号した音声の実効値（RMS）が送信した波形と近いことで行う。
 * 音声は非可逆であり波形は一致しないが、無音との区別は明確に付く。
 */

import { encodeMediaMessage, decodeMediaMessage } from "../../../packages/core/src/wire.ts";
import { deriveMeetingSecret, nodeAuthTag, nodeAuthTimeWindow } from "../../../packages/core/src/auth.ts";
import {
  AUDIO_BUNDLE_MS,
  AUDIO_UNITS_PER_MESSAGE,
  OPUS_FRAME_MS,
} from "../../../packages/core/src/generated/constants.ts";
import {
  CHANNEL_AUDIO,
  FLAG_END_OF_FRAME,
} from "../../../packages/core/src/generated/wire-layout.ts";

interface AudioE2eResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly bundleUnits: number;
  readonly messagesSent: number;
  readonly messagesReceived: number;
  readonly packetsDecoded: number;
  readonly sentRms: number;
  readonly decodedRms: number;
}

declare global {
  interface Window {
    __whesoAudioRun?: (wsBase: string, room: string, nodeKey: string) => Promise<AudioE2eResult>;
  }
}

const SAMPLE_RATE = 48_000;
const FREQUENCY_HZ = 440;
/** 送る音声の長さ。40 ms の束ねを 10 回作る。 */
const MESSAGE_COUNT = 10;

/** 正弦波の 1 フレーム分（20 ms）を作る。 */
function sineFrame(frameIndex: number): Float32Array<ArrayBuffer> {
  const samplesPerFrame = Math.trunc((SAMPLE_RATE * OPUS_FRAME_MS) / 1000);
  const data = new Float32Array(new ArrayBuffer(samplesPerFrame * 4));
  for (let i = 0; i < samplesPerFrame; i += 1) {
    const t = (frameIndex * samplesPerFrame + i) / SAMPLE_RATE;
    data[i] = Math.sin(2 * Math.PI * FREQUENCY_HZ * t) * 0.5;
  }
  return data;
}

function rms(data: Float32Array<ArrayBuffer>): number {
  let sum = 0;
  for (const value of data) {
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, data.length));
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

async function run(wsBase: string, room: string, nodeKey: string): Promise<AudioE2eResult> {
  const fail = (detail: string): AudioE2eResult => ({
    ok: false,
    detail,
    bundleUnits: AUDIO_UNITS_PER_MESSAGE,
    messagesSent: 0,
    messagesReceived: 0,
    packetsDecoded: 0,
    sentRms: 0,
    decodedRms: 0,
  });

  const support = await AudioEncoder.isConfigSupported({
    codec: "opus",
    sampleRate: SAMPLE_RATE,
    numberOfChannels: 1,
    bitrate: 32_000,
  });
  if (support.supported !== true) {
    return fail("Opus の符号化器が使えない");
  }

  const receiver = new WebSocket(`${wsBase}/parties/shard/${room}?_pk=2`);
  receiver.binaryType = "arraybuffer";
  const sender = new WebSocket(`${wsBase}/parties/shard/${room}?_pk=1`);
  await Promise.all([waitOpen(receiver), waitOpen(sender)]);

  receiver.send(
    JSON.stringify({
      t: "subscribe",
      entries: [{ senderId: 1, channel: CHANNEL_AUDIO, maxSpatialId: 0, maxTemporalId: 0 }],
    }),
  );
  await sendNodeHello(sender, room, nodeKey);
  await sleep(300);

  const arrivals: ArrayBuffer[] = [];
  receiver.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.data instanceof ArrayBuffer) {
      arrivals.push(event.data);
    }
  });

  // --- 符号化して 40 ms 単位に束ねる ---
  const encodedPackets: Uint8Array[] = [];
  let encodeError = "";
  const encoder = new AudioEncoder({
    output: (chunk) => {
      const payload = new Uint8Array(chunk.byteLength);
      chunk.copyTo(payload);
      encodedPackets.push(payload);
    },
    error: (error) => {
      encodeError = error.message;
    },
  });
  encoder.configure({ codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: 32_000 });

  const sentSamples: number[] = [];
  const frameTotal = MESSAGE_COUNT * AUDIO_UNITS_PER_MESSAGE;
  for (let frameIndex = 0; frameIndex < frameTotal; frameIndex += 1) {
    const data = sineFrame(frameIndex);
    for (const value of data) {
      sentSamples.push(value);
    }
    const audioData = new AudioData({
      format: "f32",
      sampleRate: SAMPLE_RATE,
      numberOfFrames: data.length,
      numberOfChannels: 1,
      timestamp: Math.trunc((frameIndex * OPUS_FRAME_MS * 1000)),
      data,
    });
    encoder.encode(audioData);
    audioData.close();
  }
  await encoder.flush();
  if (encodeError !== "") {
    return fail(`符号化に失敗: ${encodeError}`);
  }
  if (encodedPackets.length < AUDIO_UNITS_PER_MESSAGE) {
    return fail(`符号化された数が足りない: ${encodedPackets.length}`);
  }

  // 束ねて送る。sequenceNumber は昇順に並べる（wire-format.md 1.5）。
  let messagesSent = 0;
  let sequence = 1;
  for (let offset = 0; offset + AUDIO_UNITS_PER_MESSAGE <= encodedPackets.length; offset += AUDIO_UNITS_PER_MESSAGE) {
    const units = [];
    for (let i = 0; i < AUDIO_UNITS_PER_MESSAGE; i += 1) {
      const payload = encodedPackets[offset + i];
      if (payload === undefined) {
        continue;
      }
      units.push({
        sequenceNumber: sequence,
        captureTimestampUs: BigInt(sequence) * BigInt(OPUS_FRAME_MS * 1000),
        flags: FLAG_END_OF_FRAME,
        spatialId: 0,
        temporalId: 0,
        payload,
      });
      sequence += 1;
    }
    const encoded = encodeMediaMessage({ channel: CHANNEL_AUDIO, senderId: 1, units });
    if (!encoded.ok) {
      return fail(`束ねに失敗: ${encoded.error.code}`);
    }
    sender.send(encoded.value);
    messagesSent += 1;
  }

  await waitUntil(() => arrivals.length >= messagesSent, 8000);

  // --- 復号して波形を確かめる ---
  const decodedChunks: Float32Array<ArrayBuffer>[] = [];
  let decodeError = "";
  const decoder = new AudioDecoder({
    output: (data) => {
      const buffer = new Float32Array(new ArrayBuffer(data.numberOfFrames * 4));
      data.copyTo(buffer, { planeIndex: 0, format: "f32-planar" });
      decodedChunks.push(buffer);
      data.close();
    },
    error: (error) => {
      decodeError = error.message;
    },
  });
  decoder.configure({ codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 1 });

  let packetsDecoded = 0;
  let lastSequence = 0;
  for (const buffer of arrivals) {
    const message = decodeMediaMessage(new Uint8Array(buffer));
    if (!message.ok) {
      return fail(`ワイヤ解析に失敗: ${message.error.code}`);
    }
    if (message.value.units.length !== AUDIO_UNITS_PER_MESSAGE) {
      return fail(`束ねの数が規範と異なる: ${message.value.units.length}`);
    }
    for (const unit of message.value.units) {
      if (unit.sequenceNumber <= lastSequence) {
        return fail("sequenceNumber が昇順でない");
      }
      lastSequence = unit.sequenceNumber;
      decoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: Number(unit.captureTimestampUs),
          data: unit.payload,
        }),
      );
      packetsDecoded += 1;
    }
  }
  await decoder.flush();
  if (decodeError !== "") {
    return fail(`復号に失敗: ${decodeError}`);
  }

  const totalLength = decodedChunks.reduce((total, chunk) => total + chunk.length, 0);
  const decodedAll = new Float32Array(new ArrayBuffer(totalLength * 4));
  let position = 0;
  for (const chunk of decodedChunks) {
    decodedAll.set(chunk, position);
    position += chunk.length;
  }

  const sentBuffer = new Float32Array(new ArrayBuffer(sentSamples.length * 4));
  sentBuffer.set(sentSamples);
  const sentRms = rms(sentBuffer);
  const decodedRms = rms(decodedAll);
  // 非可逆であるため一致はしない。無音（0）と明確に区別できることを要求する。
  const withinTolerance = decodedRms > sentRms * 0.5 && decodedRms < sentRms * 1.5;

  return {
    ok: withinTolerance && arrivals.length >= messagesSent && packetsDecoded > 0,
    detail: withinTolerance ? "" : "復号した音声の実効値が送信した波形と離れている",
    bundleUnits: AUDIO_UNITS_PER_MESSAGE,
    messagesSent,
    messagesReceived: arrivals.length,
    packetsDecoded,
    sentRms: Math.round(sentRms * 1000) / 1000,
    decodedRms: Math.round(decodedRms * 1000) / 1000,
  };
}

window.__whesoAudioRun = async (wsBase: string, room: string, nodeKey: string): Promise<AudioE2eResult> => {
  try {
    return await run(wsBase, room, nodeKey);
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
    return {
      ok: false,
      detail,
      bundleUnits: AUDIO_UNITS_PER_MESSAGE,
      messagesSent: 0,
      messagesReceived: 0,
      packetsDecoded: 0,
      sentRms: 0,
      decodedRms: 0,
    };
  }
};

void AUDIO_BUNDLE_MS;
