/**
 * 実音声映像の採取（ブラウザ内で実行する）。
 *
 * 何のために存在するか: 6 言語の SDK が「実際に符号化された AV1 と Opus」を同一に扱うことを
 * 検証するには、実データが必要である。ブラウザ以外の言語には符号化器が無い（Rust の rav1e や
 * C++ の libaom を持ち込むと依存の方針に反する。licensing.md）。そこで**ブラウザで 1 度だけ
 * 符号化し、その結果を凍結資産として全言語で共有する**。
 *
 * 採取するもの:
 *   映像 … AV1（L1T3）で 30 フレーム。キーフレームと delta、時間層 0〜2 を含む
 *   音声 … Opus（32 kbps モノラル）で 50 パケット（20 ms × 50 = 1 秒）
 *
 * カメラとマイクは使わない。CI の実行機に無い（Q-020）。映像は canvas、音声は正弦波で作る。
 */

interface CapturedFrame {
  readonly sequenceNumber: number;
  readonly keyFrame: boolean;
  readonly temporalId: number;
  readonly payloadHex: string;
  /** 元の模様の平均色（0〜255）。復号後の検証で使う。 */
  readonly patternValue: number;
}

interface CapturedPacket {
  readonly sequenceNumber: number;
  readonly payloadHex: string;
}

interface CaptureResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly video: {
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    readonly framerate: number;
    readonly scalabilityMode: string;
    readonly temporalLayers: number;
    readonly frames: readonly CapturedFrame[];
  };
  readonly audio: {
    readonly codec: string;
    readonly bitrate: number;
    readonly sampleRate: number;
    readonly channels: number;
    readonly frameMs: number;
    readonly packets: readonly CapturedPacket[];
  };
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** 時間層 ID をメタデータから取り出す。実装によって位置が異なる（F-011、F-028）。 */
function temporalIdOf(metadata: unknown): number {
  if (typeof metadata !== "object" || metadata === null) {
    return 0;
  }
  const record: Record<string, unknown> = { ...metadata };
  const svc = record["svc"];
  if (typeof svc === "object" && svc !== null) {
    const inner: Record<string, unknown> = { ...svc };
    const value = inner["temporalLayerId"];
    if (typeof value === "number") {
      return value;
    }
  }
  const direct = record["temporalLayerId"];
  return typeof direct === "number" ? direct : 0;
}

/** 映像を採取する。模様は 1 フレームごとに明るさを変える（復号後に照合できる）。 */
async function captureVideo(
  width: number,
  height: number,
  framerate: number,
  count: number,
): Promise<{ readonly frames: CapturedFrame[]; readonly detail: string }> {
  const frames: CapturedFrame[] = [];
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) {
    return { frames, detail: "2d の文脈を取れない" };
  }

  const chunks: { chunk: EncodedVideoChunk; temporalId: number }[] = [];
  let encodeError = "";
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      chunks.push({ chunk, temporalId: temporalIdOf(metadata) });
    },
    error: (error: DOMException) => {
      encodeError = error.message;
    },
  });
  encoder.configure({
    codec: "av01.0.04M.08",
    width,
    height,
    framerate,
    bitrate: 1_000_000,
    scalabilityMode: "L1T3",
    latencyMode: "realtime",
  });

  const patterns: number[] = [];
  for (let index = 0; index < count; index += 1) {
    // 明るさを段階的に変える。復号後の平均色で送信順を確認できる。
    const value = 20 + index * 7;
    patterns.push(value);
    context.fillStyle = `rgb(${value}, ${value}, ${value})`;
    context.fillRect(0, 0, width, height);
    const frame = new VideoFrame(canvas, { timestamp: (index * 1_000_000) / framerate });
    encoder.encode(frame, { keyFrame: index === 0 });
    frame.close();
  }
  await encoder.flush();
  encoder.close();

  if (encodeError !== "") {
    return { frames, detail: `符号化に失敗した: ${encodeError}` };
  }

  for (let index = 0; index < chunks.length; index += 1) {
    const entry = chunks[index];
    if (entry === undefined) {
      continue;
    }
    const buffer = new Uint8Array(entry.chunk.byteLength);
    entry.chunk.copyTo(buffer);
    frames.push({
      sequenceNumber: index + 1,
      keyFrame: entry.chunk.type === "key",
      temporalId: entry.temporalId,
      payloadHex: toHex(buffer),
      patternValue: patterns[index] ?? 0,
    });
  }
  return { frames, detail: "" };
}

/** 音声を採取する。正弦波を符号化する（無音だと DTX で空になり検証にならない）。 */
async function captureAudio(
  sampleRate: number,
  channels: number,
  bitrate: number,
  frameMs: number,
  count: number,
): Promise<{ readonly packets: CapturedPacket[]; readonly detail: string }> {
  const packets: CapturedPacket[] = [];
  const chunks: EncodedAudioChunk[] = [];
  let encodeError = "";
  const encoder = new AudioEncoder({
    output: (chunk) => {
      chunks.push(chunk);
    },
    error: (error: DOMException) => {
      encodeError = error.message;
    },
  });
  encoder.configure({
    codec: "opus",
    sampleRate,
    numberOfChannels: channels,
    bitrate,
  });

  const samplesPerFrame = Math.trunc((sampleRate * frameMs) / 1000);
  for (let index = 0; index < count; index += 1) {
    const data = new Float32Array(samplesPerFrame * channels);
    for (let position = 0; position < samplesPerFrame; position += 1) {
      const time = (index * samplesPerFrame + position) / sampleRate;
      // 440 Hz の正弦波。振幅は 0.5 とする。
      const value = Math.sin(2 * Math.PI * 440 * time) * 0.5;
      for (let channel = 0; channel < channels; channel += 1) {
        data[position * channels + channel] = value;
      }
    }
    const audioData = new AudioData({
      format: "f32",
      sampleRate,
      numberOfFrames: samplesPerFrame,
      numberOfChannels: channels,
      timestamp: index * frameMs * 1000,
      data,
    });
    encoder.encode(audioData);
    audioData.close();
  }
  await encoder.flush();
  encoder.close();

  if (encodeError !== "") {
    return { packets, detail: `符号化に失敗した: ${encodeError}` };
  }

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === undefined) {
      continue;
    }
    const buffer = new Uint8Array(chunk.byteLength);
    chunk.copyTo(buffer);
    packets.push({ sequenceNumber: index + 1, payloadHex: toHex(buffer) });
  }
  return { packets, detail: "" };
}

async function run(): Promise<CaptureResult> {
  const width = 320;
  const height = 240;
  const framerate = 30;
  const frameCount = 30;
  const sampleRate = 48_000;
  const channels = 1;
  const bitrate = 32_000;
  const frameMs = 20;
  const packetCount = 50;

  const video = await captureVideo(width, height, framerate, frameCount);
  const audio = await captureAudio(sampleRate, channels, bitrate, frameMs, packetCount);
  const detail = [video.detail, audio.detail].filter((text) => text !== "").join(" / ");

  return {
    ok: detail === "" && video.frames.length > 0 && audio.packets.length > 0,
    detail,
    video: {
      codec: "av01.0.04M.08",
      width,
      height,
      framerate,
      scalabilityMode: "L1T3",
      temporalLayers: 3,
      frames: video.frames,
    },
    audio: {
      codec: "opus",
      bitrate,
      sampleRate,
      channels,
      frameMs,
      packets: audio.packets,
    },
  };
}

declare global {
  interface Window {
    __whesoCapture?: () => Promise<CaptureResult>;
  }
}

window.__whesoCapture = run;

// 輸出を 1 個持たせてモジュールとして扱わせる（declare global はモジュール内でのみ有効）。
export type { CaptureResult };
