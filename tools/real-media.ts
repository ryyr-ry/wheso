/**
 * 実音声映像の凍結資産の生成と照合。
 *
 *   node tools/real-media.ts capture   … Chromium で実際に符号化し spec/vectors/real-media.json を作る
 *   node tools/real-media.ts check     … 凍結資産が参照実装と一致することを確かめる（Chromium 不要）
 *
 * なぜ 2 段に分けるか: 符号化はブラウザにしか無い（Rust や C++ に符号化器を持ち込むと依存の
 * 方針に反する。licensing.md）。一方で照合は全言語が行う。実データを 1 度だけ採取して凍結し、
 * 以後は資産として扱う。採取をやり直すとバイト列が変わるため、凍結後は原則として再採取しない。
 *
 * 凍結資産の内容:
 *   実際の AV1 フレーム 30 枚と Opus パケット 50 個の**生のバイト列**
 *   それぞれをワイヤ形式に載せた**期待バイト列**（メッセージ全体）
 *   破棄可否（DISCARDABLE）と破棄優先順位の**期待値**
 *
 * 全言語はこの 1 個の資産に対して、同じバイト列を作り、復号して元に戻し、
 * 同じ判断（破棄可否と優先順位）を返すことを検証する。
 */

import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { chromium } from "playwright";

import {
  computeDiscardable,
  dropPriority,
  encodeMediaMessage,
  decodeMediaMessage,
  type MediaMessage,
} from "../packages/core/src/wire.ts";
import {
  AUDIO_UNITS_PER_MESSAGE,
  V_1080P30,
} from "../packages/core/src/generated/constants.ts";
import {
  CHANNEL_AUDIO,
  CHANNEL_VIDEO,
  FLAG_ACTIVE_SPEAKER,
  FLAG_DISCARDABLE,
  FLAG_END_OF_FRAME,
  FLAG_KEY,
} from "../packages/core/src/generated/wire-layout.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rawPath = join(root, "spec", "vectors", "real-media-raw.json");
const assetPath = join(root, "spec", "vectors", "real-media.json");

/** 採取した生データの形（tests/e2e/page/capture.ts の出力）。 */
interface RawFrame {
  readonly sequenceNumber: number;
  readonly keyFrame: boolean;
  readonly temporalId: number;
  readonly payloadHex: string;
  readonly patternValue: number;
}

interface RawPacket {
  readonly sequenceNumber: number;
  readonly payloadHex: string;
}

interface RawCapture {
  readonly video: {
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    readonly framerate: number;
    readonly scalabilityMode: string;
    readonly temporalLayers: number;
    readonly frames: readonly RawFrame[];
  };
  readonly audio: {
    readonly codec: string;
    readonly bitrate: number;
    readonly sampleRate: number;
    readonly channels: number;
    readonly frameMs: number;
    readonly packets: readonly RawPacket[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.trunc(hex.length / 2));
  for (let index = 0; index + 1 < hex.length; index += 2) {
    bytes[Math.trunc(index / 2)] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** 生データを実行時に検査して型を確定する。型定義を信用しない（原則 2）。 */
function parseRaw(text: string): RawCapture | null {
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const video = value["video"];
  const audio = value["audio"];
  if (!isRecord(video) || !isRecord(audio)) {
    return null;
  }
  const frames = video["frames"];
  const packets = audio["packets"];
  if (!Array.isArray(frames) || !Array.isArray(packets)) {
    return null;
  }
  const parsedFrames: RawFrame[] = [];
  for (const frame of frames) {
    if (!isRecord(frame)) {
      return null;
    }
    const sequenceNumber = frame["sequenceNumber"];
    const keyFrame = frame["keyFrame"];
    const temporalId = frame["temporalId"];
    const payloadHex = frame["payloadHex"];
    const patternValue = frame["patternValue"];
    if (
      typeof sequenceNumber !== "number" ||
      typeof keyFrame !== "boolean" ||
      typeof temporalId !== "number" ||
      typeof payloadHex !== "string" ||
      typeof patternValue !== "number"
    ) {
      return null;
    }
    parsedFrames.push({ sequenceNumber, keyFrame, temporalId, payloadHex, patternValue });
  }
  const parsedPackets: RawPacket[] = [];
  for (const packet of packets) {
    if (!isRecord(packet)) {
      return null;
    }
    const sequenceNumber = packet["sequenceNumber"];
    const payloadHex = packet["payloadHex"];
    if (typeof sequenceNumber !== "number" || typeof payloadHex !== "string") {
      return null;
    }
    parsedPackets.push({ sequenceNumber, payloadHex });
  }
  const numberField = (record: Record<string, unknown>, key: string): number => {
    const found = record[key];
    return typeof found === "number" ? found : 0;
  };
  const textField = (record: Record<string, unknown>, key: string): string => {
    const found = record[key];
    return typeof found === "string" ? found : "";
  };
  return {
    video: {
      codec: textField(video, "codec"),
      width: numberField(video, "width"),
      height: numberField(video, "height"),
      framerate: numberField(video, "framerate"),
      scalabilityMode: textField(video, "scalabilityMode"),
      temporalLayers: numberField(video, "temporalLayers"),
      frames: parsedFrames,
    },
    audio: {
      codec: textField(audio, "codec"),
      bitrate: numberField(audio, "bitrate"),
      sampleRate: numberField(audio, "sampleRate"),
      channels: numberField(audio, "channels"),
      frameMs: numberField(audio, "frameMs"),
      packets: parsedPackets,
    },
  };
}

/** 送信者 ID は資産の中で固定する。言語ごとに変えると期待バイト列が変わる。 */
const SENDER_ID = 4242;

/**
 * 生データから凍結資産を作る。
 *
 * 判断（DISCARDABLE と破棄優先順位）は参照実装の関数のみを使う。
 * 独自に計算してはならない（AGENTS 5.4 の「触ってはならないもの」）。
 */
function buildAsset(raw: RawCapture): Record<string, unknown> {
  const videoEntries: Record<string, unknown>[] = [];
  for (const frame of raw.video.frames) {
    const payload = hexToBytes(frame.payloadHex);
    const discardable = computeDiscardable(
      CHANNEL_VIDEO,
      frame.keyFrame,
      frame.temporalId,
      raw.video.temporalLayers,
    );
    // 発話者の旗は映像には立てない。画面共有でもない。したがって flags は
    // 終端・キー・破棄可否の 3 つで決まる。
    let flags = FLAG_END_OF_FRAME;
    if (frame.keyFrame) {
      flags |= FLAG_KEY;
    }
    if (discardable) {
      flags |= FLAG_DISCARDABLE;
    }
    const message: MediaMessage = {
      channel: CHANNEL_VIDEO,
      senderId: SENDER_ID,
      units: [
        {
          sequenceNumber: frame.sequenceNumber,
          captureTimestampUs: BigInt(
            Math.trunc(((frame.sequenceNumber - 1) * 1_000_000) / raw.video.framerate),
          ),
          flags,
          spatialId: V_1080P30.spatialId,
          temporalId: frame.temporalId,
          payload,
        },
      ],
    };
    const encoded = encodeMediaMessage(message);
    if (!encoded.ok) {
      throw new Error(`映像 ${frame.sequenceNumber} の符号化に失敗した: ${encoded.error.code}`);
    }
    videoEntries.push({
      sequenceNumber: frame.sequenceNumber,
      keyFrame: frame.keyFrame,
      temporalId: frame.temporalId,
      spatialId: V_1080P30.spatialId,
      patternValue: frame.patternValue,
      payloadHex: frame.payloadHex,
      expectedFlags: flags,
      expectedDiscardable: discardable,
      expectedDropPriority: dropPriority(CHANNEL_VIDEO, flags),
      expectedMessageHex: bytesToHex(encoded.value),
    });
  }

  // 音声は AUDIO_UNITS_PER_MESSAGE 個ずつ束ねる（ADR-0005）。
  const audioEntries: Record<string, unknown>[] = [];
  for (let start = 0; start + AUDIO_UNITS_PER_MESSAGE <= raw.audio.packets.length; start += AUDIO_UNITS_PER_MESSAGE) {
    const bundle = raw.audio.packets.slice(start, start + AUDIO_UNITS_PER_MESSAGE);
    const units = bundle.map((packet, offset) => ({
      sequenceNumber: packet.sequenceNumber,
      captureTimestampUs: BigInt((start + offset) * raw.audio.frameMs * 1000),
      // 音声は破棄しない。発話者の旗のみ立てる（優先順位の判定が音声で null になることを確かめる）。
      flags: FLAG_END_OF_FRAME | FLAG_ACTIVE_SPEAKER,
      spatialId: 0,
      temporalId: 0,
      payload: hexToBytes(packet.payloadHex),
    }));
    const message: MediaMessage = { channel: CHANNEL_AUDIO, senderId: SENDER_ID, units };
    const encoded = encodeMediaMessage(message);
    if (!encoded.ok) {
      throw new Error(`音声束 ${start} の符号化に失敗した: ${encoded.error.code}`);
    }
    audioEntries.push({
      firstSequenceNumber: bundle[0]?.sequenceNumber ?? 0,
      unitCount: bundle.length,
      payloadsHex: bundle.map((packet) => packet.payloadHex),
      expectedFlags: FLAG_END_OF_FRAME | FLAG_ACTIVE_SPEAKER,
      expectedDiscardable: computeDiscardable(CHANNEL_AUDIO, false, 0, 1),
      expectedDropPriority: dropPriority(CHANNEL_AUDIO, FLAG_END_OF_FRAME | FLAG_ACTIVE_SPEAKER),
      expectedMessageHex: bytesToHex(encoded.value),
    });
  }

  return {
    $comment:
      "実際に符号化された AV1 と Opus の凍結資産。ブラウザで 1 度採取したものであり、実装に合わせて変更してはならない（ADR-0012）。",
    senderId: SENDER_ID,
    video: {
      codec: raw.video.codec,
      width: raw.video.width,
      height: raw.video.height,
      framerate: raw.video.framerate,
      scalabilityMode: raw.video.scalabilityMode,
      temporalLayers: raw.video.temporalLayers,
      channel: CHANNEL_VIDEO,
      frames: videoEntries,
    },
    audio: {
      codec: raw.audio.codec,
      bitrate: raw.audio.bitrate,
      sampleRate: raw.audio.sampleRate,
      channels: raw.audio.channels,
      frameMs: raw.audio.frameMs,
      unitsPerMessage: AUDIO_UNITS_PER_MESSAGE,
      channel: CHANNEL_AUDIO,
      bundles: audioEntries,
    },
  };
}

async function findFreePort(): Promise<number> {
  const { createServer: createNet } = await import("node:net");
  return await new Promise<number>((resolve, reject) => {
    const probe = createNet();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Chromium で実際に符号化して生データを採取する。 */
async function capture(): Promise<void> {
  const bundled = await build({
    entryPoints: [join(root, "tests", "e2e", "page", "capture.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  const script = bundled.outputFiles[0]?.text ?? "";
  const port = await findFreePort();
  const server: Server = createServer((request, response) => {
    if (request.url === "/capture.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(script);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><meta charset="utf-8"><script type="module" src="/capture.js"></script>');
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  // WebCodecs は secure context を要求する。127.0.0.1 は secure context として扱われる。
  const browser = await chromium.launch({ args: ["--enable-features=SharedArrayBuffer"] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction("typeof window.__whesoCapture === 'function'", null, { timeout: 30_000 });
    const result: unknown = await page.evaluate("window.__whesoCapture?.()");
    if (!isRecord(result) || result["ok"] !== true) {
      const detail = isRecord(result) && typeof result["detail"] === "string" ? result["detail"] : "不明";
      throw new Error(`採取に失敗した: ${detail}`);
    }
    await writeFile(rawPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    process.stdout.write(`採取した生データを書き出した: ${rawPath}\n`);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  await generate();
}

/** 生データから凍結資産を作る（Chromium 不要）。 */
async function generate(): Promise<void> {
  const rawText = await readFile(rawPath, "utf8");
  const raw = parseRaw(rawText);
  if (raw === null) {
    throw new Error("生データを解釈できない。capture を先に実行する");
  }
  const asset = buildAsset(raw);
  await writeFile(assetPath, `${JSON.stringify(asset, null, 2)}\n`, "utf8");
  const video = asset["video"];
  const audio = asset["audio"];
  const videoCount = isRecord(video) && Array.isArray(video["frames"]) ? video["frames"].length : 0;
  const audioCount = isRecord(audio) && Array.isArray(audio["bundles"]) ? audio["bundles"].length : 0;
  process.stdout.write(`generated real-media.json: 映像 ${videoCount} 枚 / 音声束 ${audioCount} 個\n`);
}

/**
 * 凍結資産が参照実装と一致することを確かめる。
 *
 * 期待バイト列を作り直して比べる。作り直しても一致するなら、資産は参照実装の出力である。
 * あわせて復号して元のペイロードに戻ることを確かめる（往復）。
 */
async function check(): Promise<void> {
  const rawText = await readFile(rawPath, "utf8");
  const raw = parseRaw(rawText);
  if (raw === null) {
    throw new Error("生データを解釈できない");
  }
  const rebuilt = buildAsset(raw);
  const frozenText = await readFile(assetPath, "utf8");
  const rebuiltText = `${JSON.stringify(rebuilt, null, 2)}\n`;
  if (frozenText !== rebuiltText) {
    process.stderr.write("real-media.json が参照実装の出力と一致しない。実装を直す（ADR-0012）\n");
    process.exitCode = 1;
    return;
  }

  // 往復の確認。復号したペイロードが生データと一致することを確かめる。
  let checked = 0;
  const video = rebuilt["video"];
  if (isRecord(video) && Array.isArray(video["frames"])) {
    for (const entry of video["frames"]) {
      if (!isRecord(entry)) {
        continue;
      }
      const hex = entry["expectedMessageHex"];
      const payloadHex = entry["payloadHex"];
      if (typeof hex !== "string" || typeof payloadHex !== "string") {
        continue;
      }
      const decoded = decodeMediaMessage(hexToBytes(hex));
      if (!decoded.ok) {
        process.stderr.write(`映像の復号に失敗した: ${decoded.error.code}\n`);
        process.exitCode = 1;
        return;
      }
      const unit = decoded.value.units[0];
      if (unit === undefined || bytesToHex(unit.payload) !== payloadHex) {
        process.stderr.write("映像のペイロードが往復で一致しない\n");
        process.exitCode = 1;
        return;
      }
      checked += 1;
    }
  }
  const audio = rebuilt["audio"];
  if (isRecord(audio) && Array.isArray(audio["bundles"])) {
    for (const entry of audio["bundles"]) {
      if (!isRecord(entry)) {
        continue;
      }
      const hex = entry["expectedMessageHex"];
      const payloads = entry["payloadsHex"];
      if (typeof hex !== "string" || !Array.isArray(payloads)) {
        continue;
      }
      const decoded = decodeMediaMessage(hexToBytes(hex));
      if (!decoded.ok) {
        process.stderr.write(`音声の復号に失敗した: ${decoded.error.code}\n`);
        process.exitCode = 1;
        return;
      }
      if (decoded.value.units.length !== payloads.length) {
        process.stderr.write("音声の束の数が往復で一致しない\n");
        process.exitCode = 1;
        return;
      }
      for (let index = 0; index < payloads.length; index += 1) {
        const unit = decoded.value.units[index];
        const expected = payloads[index];
        if (unit === undefined || typeof expected !== "string" || bytesToHex(unit.payload) !== expected) {
          process.stderr.write("音声のペイロードが往復で一致しない\n");
          process.exitCode = 1;
          return;
        }
      }
      checked += 1;
    }
  }
  if (checked < 30) {
    process.stderr.write(`照合した件数が少なすぎる（${checked} 件）。資産が壊れている\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`OK: real-media.json が参照実装と一致し、往復も一致する（${checked} 件）\n`);
}

const mode = process.argv[2] ?? "check";
if (mode === "capture") {
  await capture();
} else if (mode === "generate") {
  await generate();
} else if (mode === "check") {
  await check();
} else {
  process.stderr.write("使い方: node tools/real-media.ts capture | generate | check\n");
  process.exitCode = 2;
}
