/**
 * テストベクタの生成と検証。
 *
 * 実行:
 *   node tools/vectors.ts generate   ... spec/vectors/*.json を生成する
 *   node tools/vectors.ts check      ... 既存のベクタに対して参照実装を検証する
 *
 * 検証内容:
 *   1. 期待バイト列を復号した結果が期待構造と一致する
 *   2. 期待構造を符号化した結果が期待バイト列と一致する（往復一致）
 *   3. 不正ベクタが指定のエラーコードで拒否される
 *   4. 破棄優先順位が規範の表と一致する
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHANNEL_AUDIO,
  CHANNEL_SCREEN_VIDEO,
  CHANNEL_VIDEO,
  FLAG_ACTIVE_SPEAKER,
  FLAG_DISCARDABLE,
  FLAG_DTX,
  FLAG_END_OF_FRAME,
  FLAG_KEY,
  FLAG_SCREEN_CONTENT,
  decodeMediaMessage,
  dropPriority,
  encodeMediaMessage,
  fromHex,
  toHex,
  type MediaMessage,
} from "../packages/core/src/wire.ts";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const vectorDir = join(here, "spec", "vectors");

interface UnitVector {
  readonly sequenceNumber: number;
  readonly captureTimestampUs: string;
  readonly flags: number;
  readonly spatialId: number;
  readonly temporalId: number;
  readonly payloadHex: string;
}

interface MediaVector {
  readonly name: string;
  readonly description: string;
  readonly bytesHex: string;
  readonly message: {
    readonly channel: number;
    readonly senderId: number;
    readonly units: readonly UnitVector[];
  };
}

interface InvalidVector {
  readonly name: string;
  readonly description: string;
  readonly bytesHex: string;
  readonly expectedErrorCode: string;
  readonly expectedCloseCode: number;
}

interface DropVector {
  readonly name: string;
  readonly channel: number;
  readonly flags: number;
  readonly expectedPriority: number | null;
}

function payload(pattern: readonly number[]): Uint8Array {
  return Uint8Array.from(pattern);
}

function toVector(name: string, description: string, message: MediaMessage): MediaVector {
  const encoded = encodeMediaMessage(message);
  if (!encoded.ok) {
    throw new Error(`cannot encode vector ${name}: ${encoded.error.code} ${encoded.error.detail}`);
  }
  return {
    name,
    description,
    bytesHex: toHex(encoded.value),
    message: {
      channel: message.channel,
      senderId: message.senderId,
      units: message.units.map((unit): UnitVector => ({
        sequenceNumber: unit.sequenceNumber,
        captureTimestampUs: unit.captureTimestampUs.toString(10),
        flags: unit.flags,
        spatialId: unit.spatialId,
        temporalId: unit.temporalId,
        payloadHex: toHex(unit.payload),
      })),
    },
  };
}

function buildMediaVectors(): readonly MediaVector[] {
  return [
    toVector("video-keyframe-minimal", "映像キーフレーム 1 ユニット。最小構成", {
      channel: CHANNEL_VIDEO,
      senderId: 1,
      units: [
        {
          sequenceNumber: 1,
          captureTimestampUs: 0n,
          flags: FLAG_KEY | FLAG_END_OF_FRAME,
          spatialId: 0,
          temporalId: 0,
          payload: payload([0x12, 0x34, 0x56, 0x78]),
        },
      ],
    }),
    toVector("video-delta-top-temporal", "映像 delta。最上位 temporal 層なので DISCARDABLE=1", {
      channel: CHANNEL_VIDEO,
      senderId: 0x0001e240,
      units: [
        {
          sequenceNumber: 0xfffffffe,
          captureTimestampUs: 1234567890123456n,
          flags: FLAG_DISCARDABLE | FLAG_END_OF_FRAME,
          spatialId: 3,
          temporalId: 2,
          payload: payload([0xaa, 0xbb, 0xcc]),
        },
      ],
    }),
    toVector("audio-bundle-two-units", "音声 40ms 束ね。2 ユニット。1 つは DTX", {
      channel: CHANNEL_AUDIO,
      senderId: 42,
      units: [
        {
          sequenceNumber: 1000,
          captureTimestampUs: 20000n,
          flags: FLAG_END_OF_FRAME,
          spatialId: 0,
          temporalId: 0,
          payload: payload([0x01, 0x02, 0x03, 0x04, 0x05]),
        },
        {
          sequenceNumber: 1001,
          captureTimestampUs: 40000n,
          flags: FLAG_END_OF_FRAME | FLAG_DTX,
          spatialId: 0,
          temporalId: 0,
          payload: payload([0x06, 0x07]),
        },
      ],
    }),
    toVector("screen-keyframe-active-speaker", "画面共有キーフレーム。SCREEN_CONTENT と ACTIVE_SPEAKER", {
      channel: CHANNEL_SCREEN_VIDEO,
      senderId: 7,
      units: [
        {
          sequenceNumber: 5,
          captureTimestampUs: 999999999999n,
          flags: FLAG_KEY | FLAG_END_OF_FRAME | FLAG_SCREEN_CONTENT | FLAG_ACTIVE_SPEAKER,
          spatialId: 1,
          temporalId: 0,
          payload: payload([0xff]),
        },
      ],
    }),
    toVector("video-max-flags", "全フラグ立て。境界値確認", {
      channel: CHANNEL_VIDEO,
      senderId: 0xffffffff,
      units: [
        {
          sequenceNumber: 0xffffffff,
          captureTimestampUs: 0xffffffffffffffffn,
          flags: 0x3f,
          spatialId: 3,
          temporalId: 7,
          payload: payload([0x00]),
        },
      ],
    }),
  ];
}

function buildInvalidVectors(): readonly InvalidVector[] {
  return [
    {
      name: "bad-magic",
      description: "magic が 0xA1 でない",
      bytesHex: "b201010100000001" + "00000001" + "0000000000000000" + "09000000" + "00000001" + "12",
      expectedErrorCode: "E_WIRE_MAGIC",
      expectedCloseCode: 4001,
    },
    {
      name: "bad-version",
      description: "version が 2",
      bytesHex: "a102010100000001" + "00000001" + "0000000000000000" + "09000000" + "00000001" + "12",
      expectedErrorCode: "E_WIRE_VERSION",
      expectedCloseCode: 4002,
    },
    {
      name: "unit-count-zero",
      description: "unitCount が 0",
      bytesHex: "a10101000000000112",
      expectedErrorCode: "E_WIRE_UNIT_COUNT",
      expectedCloseCode: 4004,
    },
    {
      name: "sender-id-zero",
      description: "senderId が 0",
      bytesHex: "a101010100000000" + "00000001" + "0000000000000000" + "09000000" + "00000001" + "12",
      expectedErrorCode: "E_WIRE_SENDER_ID",
      expectedCloseCode: 4005,
    },
    {
      name: "payload-length-zero",
      description: "payloadLength が 0",
      bytesHex: "a101010100000001" + "00000001" + "0000000000000000" + "09000000" + "00000000",
      expectedErrorCode: "E_WIRE_PAYLOAD_EMPTY",
      expectedCloseCode: 4006,
    },
    {
      name: "truncated-payload",
      description: "payloadLength がバッファ長を超える",
      bytesHex: "a101010100000001" + "00000001" + "0000000000000000" + "09000000" + "000000ff" + "12",
      expectedErrorCode: "E_WIRE_LENGTH_MISMATCH",
      expectedCloseCode: 4003,
    },
    {
      name: "trailing-bytes",
      description: "余剰バイトがある",
      bytesHex: "a101010100000001" + "00000001" + "0000000000000000" + "09000000" + "00000001" + "12" + "ff",
      expectedErrorCode: "E_WIRE_LENGTH_MISMATCH",
      expectedCloseCode: 4003,
    },
    {
      name: "bad-channel",
      description: "channel が 5",
      bytesHex: "a101050100000001" + "00000001" + "0000000000000000" + "09000000" + "00000001" + "12",
      expectedErrorCode: "E_WIRE_CHANNEL",
      expectedCloseCode: 4003,
    },
    {
      name: "spatial-id-out-of-range",
      description: "spatialId が 4",
      bytesHex: "a101010100000001" + "00000001" + "0000000000000000" + "09040000" + "00000001" + "12",
      expectedErrorCode: "E_WIRE_FIELD_RANGE",
      expectedCloseCode: 4003,
    },
    {
      name: "unit-order-not-ascending",
      description: "束ねた音声ユニットの sequenceNumber が昇順でない",
      bytesHex:
        "a101020200000001" +
        "00000002" + "0000000000000000" + "08000000" + "00000001" + "aa" +
        "00000001" + "0000000000000000" + "08000000" + "00000001" + "bb",
      expectedErrorCode: "E_WIRE_UNIT_ORDER",
      expectedCloseCode: 4007,
    },
    {
      name: "video-multiple-units",
      description: "映像チャネルで unitCount が 2（仕様 1.5 違反）",
      bytesHex:
        "a101010200000001" +
        "00000001" + "0000000000000000" + "08000000" + "00000001" + "aa" +
        "00000002" + "0000000000000000" + "08000000" + "00000001" + "bb",
      expectedErrorCode: "E_WIRE_UNIT_COUNT",
      expectedCloseCode: 4004,
    },
  ];
}

function buildDropVectors(): readonly DropVector[] {
  return [
    { name: "audio-never-dropped", channel: CHANNEL_AUDIO, flags: FLAG_END_OF_FRAME, expectedPriority: null },
    { name: "video-key-never-dropped", channel: CHANNEL_VIDEO, flags: FLAG_KEY, expectedPriority: null },
    { name: "discardable-plain", channel: CHANNEL_VIDEO, flags: FLAG_DISCARDABLE, expectedPriority: 1 },
    {
      name: "discardable-active-speaker",
      channel: CHANNEL_VIDEO,
      flags: FLAG_DISCARDABLE | FLAG_ACTIVE_SPEAKER,
      expectedPriority: 2,
    },
    {
      name: "discardable-screen-content",
      channel: CHANNEL_SCREEN_VIDEO,
      flags: FLAG_DISCARDABLE | FLAG_SCREEN_CONTENT,
      expectedPriority: 3,
    },
    {
      name: "discardable-screen-and-speaker",
      channel: CHANNEL_SCREEN_VIDEO,
      flags: FLAG_DISCARDABLE | FLAG_SCREEN_CONTENT | FLAG_ACTIVE_SPEAKER,
      expectedPriority: 3,
    },
    { name: "non-discardable-plain", channel: CHANNEL_VIDEO, flags: 0, expectedPriority: 4 },
    {
      name: "non-discardable-active-speaker",
      channel: CHANNEL_VIDEO,
      flags: FLAG_ACTIVE_SPEAKER,
      expectedPriority: 5,
    },
  ];
}

async function generate(): Promise<void> {
  await mkdir(vectorDir, { recursive: true });
  const media = buildMediaVectors();
  const invalid = buildInvalidVectors();
  const drop = buildDropVectors();
  await writeFile(join(vectorDir, "media.json"), `${JSON.stringify(media, null, 2)}\n`, "utf8");
  await writeFile(join(vectorDir, "invalid.json"), `${JSON.stringify(invalid, null, 2)}\n`, "utf8");
  await writeFile(join(vectorDir, "drop-order.json"), `${JSON.stringify(drop, null, 2)}\n`, "utf8");
  process.stdout.write(`generated ${media.length} media, ${invalid.length} invalid, ${drop.length} drop vectors\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonArray(path: string): Promise<readonly Record<string, unknown>[]> {
  const text = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} is not an array`);
  }
  const out: Record<string, unknown>[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) {
      throw new Error(`${path} contains a non-object entry`);
    }
    out.push(entry);
  }
  return out;
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string") {
    throw new Error(`missing string field: ${key}`);
  }
  return value;
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`missing number field: ${key}`);
  }
  return value;
}

let failures = 0;

function check(condition: boolean, label: string): void {
  if (!condition) {
    failures += 1;
    process.stdout.write(`FAIL ${label}\n`);
  }
}

async function runCheck(): Promise<void> {
  const media = await readJsonArray(join(vectorDir, "media.json"));
  for (const vector of media) {
    const name = readString(vector, "name");
    const bytesHex = readString(vector, "bytesHex");
    const decodedHex = fromHex(bytesHex);
    if (!decodedHex.ok) {
      check(false, `${name}: hex 解釈に失敗`);
      continue;
    }
    const decoded = decodeMediaMessage(decodedHex.value);
    if (!decoded.ok) {
      check(false, `${name}: 復号に失敗 (${decoded.error.code})`);
      continue;
    }
    const expected = vector["message"];
    if (!isRecord(expected)) {
      check(false, `${name}: message フィールドが不正`);
      continue;
    }
    check(decoded.value.channel === readNumber(expected, "channel"), `${name}: channel`);
    check(decoded.value.senderId === readNumber(expected, "senderId"), `${name}: senderId`);
    const expectedUnits = expected["units"];
    if (!Array.isArray(expectedUnits)) {
      check(false, `${name}: units が配列でない`);
      continue;
    }
    check(decoded.value.units.length === expectedUnits.length, `${name}: unitCount`);
    for (let i = 0; i < decoded.value.units.length; i += 1) {
      const actual = decoded.value.units[i];
      const expectedUnit = expectedUnits[i];
      if (actual === undefined || !isRecord(expectedUnit)) {
        check(false, `${name}: unit ${i} 欠落`);
        continue;
      }
      check(actual.sequenceNumber === readNumber(expectedUnit, "sequenceNumber"), `${name}: unit ${i} seq`);
      check(
        actual.captureTimestampUs === BigInt(readString(expectedUnit, "captureTimestampUs")),
        `${name}: unit ${i} timestamp`,
      );
      check(actual.flags === readNumber(expectedUnit, "flags"), `${name}: unit ${i} flags`);
      check(actual.spatialId === readNumber(expectedUnit, "spatialId"), `${name}: unit ${i} spatialId`);
      check(actual.temporalId === readNumber(expectedUnit, "temporalId"), `${name}: unit ${i} temporalId`);
      check(toHex(actual.payload) === readString(expectedUnit, "payloadHex"), `${name}: unit ${i} payload`);
    }
    // 往復一致
    const reencoded = encodeMediaMessage(decoded.value);
    if (!reencoded.ok) {
      check(false, `${name}: 再符号化に失敗 (${reencoded.error.code})`);
      continue;
    }
    check(toHex(reencoded.value) === bytesHex, `${name}: 往復一致`);
  }

  const invalid = await readJsonArray(join(vectorDir, "invalid.json"));
  for (const vector of invalid) {
    const name = readString(vector, "name");
    const bytesHex = readString(vector, "bytesHex");
    const expectedCode = readString(vector, "expectedErrorCode");
    const decodedHex = fromHex(bytesHex);
    if (!decodedHex.ok) {
      check(false, `${name}: hex 解釈に失敗`);
      continue;
    }
    const decoded = decodeMediaMessage(decodedHex.value);
    if (decoded.ok) {
      check(false, `${name}: 拒否されるべきだが成功した`);
      continue;
    }
    check(decoded.error.code === expectedCode, `${name}: エラーコード（期待 ${expectedCode} 実際 ${decoded.error.code}）`);
  }

  const drop = await readJsonArray(join(vectorDir, "drop-order.json"));
  for (const vector of drop) {
    const name = readString(vector, "name");
    const channel = readNumber(vector, "channel");
    const flags = readNumber(vector, "flags");
    const expectedRaw = vector["expectedPriority"];
    const expected = expectedRaw === null ? null : typeof expectedRaw === "number" ? expectedRaw : Number.NaN;
    const actual = dropPriority(channel, flags);
    check(actual === expected, `${name}: 破棄優先順位（期待 ${String(expected)} 実際 ${String(actual)}）`);
  }

  if (failures === 0) {
    process.stdout.write(
      `OK: media ${media.length} 件、invalid ${invalid.length} 件、drop ${drop.length} 件すべて一致\n`,
    );
    return;
  }
  process.stdout.write(`${failures} 件の不一致\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "check";
  if (mode === "generate") {
    await generate();
    return;
  }
  if (mode === "check") {
    await runCheck();
    return;
  }
  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exitCode = 1;
}

main().catch((error: unknown): void => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
  process.stderr.write(`FAILED: ${detail}\n`);
  process.exitCode = 1;
});
