/**
 * ワイヤフォーマットの参照実装。
 *
 * 規範は プロトコル規範 wire-format である。本ファイルは規範に対する唯一の参照実装であり、
 * 他言語の実装は テストベクタ のベクタを通すことで適合を示す。
 *
 * 本ファイルの制約（spec/lint-policy.md）:
 *   - any を使用しない
 *   - 型アサーション (as) を使用しない
 *   - 非 null 断定 (!) を使用しない
 *   - 例外を投げない。失敗は Result で返す
 */

// 定数は スキーマ定義 から生成された定義を単一情報源とする。
// 手でここに数値を書いてはならない（lint-policy.md 9 節）。
import {
  CHANNEL_AUDIO,
  CHANNEL_SCREEN_AUDIO,
  CHANNEL_SCREEN_VIDEO,
  CHANNEL_VIDEO,
  FLAG_ACTIVE_SPEAKER,
  FLAG_DISCARDABLE,
  FLAG_KEY,
  FLAG_SCREEN_CONTENT,
  MAX_MESSAGE_BYTES,
  MAX_UNITS_PER_MESSAGE,
  MESSAGE_HEADER_BYTES,
  PROTOCOL_VERSION,
  UNIT_HEADER_BYTES,
  UNIT_HEADER_OFFSET,
  VIDEO_CHANNEL_REQUIRES_SINGLE_UNIT,
  WIRE_MAGIC,
} from "./generated/wire-layout.ts";

export {
  CHANNEL_AUDIO,
  CHANNEL_SCREEN_AUDIO,
  CHANNEL_SCREEN_VIDEO,
  CHANNEL_VIDEO,
  FLAG_ACTIVE_SPEAKER,
  FLAG_DISCARDABLE,
  FLAG_DTX,
  FLAG_END_OF_FRAME,
  FLAG_KEY,
  FLAG_SCREEN_CONTENT,
  MAX_MESSAGE_BYTES,
  MAX_UNITS_PER_MESSAGE,
  MESSAGE_HEADER_BYTES,
  UNIT_HEADER_BYTES,
  WIRE_MAGIC,
} from "./generated/wire-layout.ts";

/** プロトコル版。生成物の PROTOCOL_VERSION と同一である。 */
export const WIRE_VERSION = PROTOCOL_VERSION;

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T, E>(value: T): Result<T, E> {
  return { ok: true, value };
}

export function err<T, E>(error: E): Result<T, E> {
  return { ok: false, error };
}

export type WireErrorCode =
  | "E_WIRE_MAGIC"
  | "E_WIRE_VERSION"
  | "E_WIRE_LENGTH_MISMATCH"
  | "E_WIRE_UNIT_COUNT"
  | "E_WIRE_SENDER_ID"
  | "E_WIRE_PAYLOAD_EMPTY"
  | "E_WIRE_UNIT_ORDER"
  | "E_WIRE_TOO_LARGE"
  | "E_WIRE_CHANNEL"
  | "E_WIRE_FIELD_RANGE";

export interface WireError {
  readonly code: WireErrorCode;
  readonly detail: string;
}

/** errors.md に定義された WebSocket クローズコードへの写像。 */
export function wireErrorCloseCode(code: WireErrorCode): number {
  switch (code) {
    case "E_WIRE_MAGIC":
      return 4001;
    case "E_WIRE_VERSION":
      return 4002;
    case "E_WIRE_LENGTH_MISMATCH":
      return 4003;
    case "E_WIRE_UNIT_COUNT":
      return 4004;
    case "E_WIRE_SENDER_ID":
      return 4005;
    case "E_WIRE_PAYLOAD_EMPTY":
      return 4006;
    case "E_WIRE_UNIT_ORDER":
      return 4007;
    case "E_WIRE_TOO_LARGE":
      return 4008;
    case "E_WIRE_CHANNEL":
      return 4003;
    case "E_WIRE_FIELD_RANGE":
      return 4003;
  }
}

export interface Unit {
  readonly sequenceNumber: number;
  readonly captureTimestampUs: bigint;
  readonly flags: number;
  readonly spatialId: number;
  readonly temporalId: number;
  readonly payload: Uint8Array;
}

export interface MediaMessage {
  readonly channel: number;
  readonly senderId: number;
  readonly units: readonly Unit[];
}

function isValidChannel(channel: number): boolean {
  return (
    channel === CHANNEL_VIDEO ||
    channel === CHANNEL_AUDIO ||
    channel === CHANNEL_SCREEN_VIDEO ||
    channel === CHANNEL_SCREEN_AUDIO
  );
}

function isUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function isUint8(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xff;
}

/** MediaMessage をバイト列へ符号化する。 */
export function encodeMediaMessage(message: MediaMessage): Result<Uint8Array, WireError> {
  if (!isValidChannel(message.channel)) {
    return err({ code: "E_WIRE_CHANNEL", detail: `channel=${message.channel}` });
  }
  if (!isUint32(message.senderId) || message.senderId === 0) {
    return err({ code: "E_WIRE_SENDER_ID", detail: `senderId=${message.senderId}` });
  }
  const unitCount = message.units.length;
  if (unitCount === 0) {
    return err({ code: "E_WIRE_UNIT_COUNT", detail: "unitCount=0" });
  }
  if (unitCount > MAX_UNITS_PER_MESSAGE) {
    return err({ code: "E_WIRE_UNIT_COUNT", detail: `unitCount=${unitCount}` });
  }
  if (
    VIDEO_CHANNEL_REQUIRES_SINGLE_UNIT &&
    (message.channel === CHANNEL_VIDEO || message.channel === CHANNEL_SCREEN_VIDEO) &&
    unitCount !== 1
  ) {
    return err({ code: "E_WIRE_UNIT_COUNT", detail: `video channel requires unitCount=1, got ${unitCount}` });
  }

  let totalBytes = MESSAGE_HEADER_BYTES;
  let previousSequence = -1;
  for (const unit of message.units) {
    if (unit.payload.length === 0) {
      return err({ code: "E_WIRE_PAYLOAD_EMPTY", detail: `seq=${unit.sequenceNumber}` });
    }
    if (!isUint32(unit.sequenceNumber)) {
      return err({ code: "E_WIRE_FIELD_RANGE", detail: `sequenceNumber=${unit.sequenceNumber}` });
    }
    if (unit.captureTimestampUs < 0n || unit.captureTimestampUs > 0xffffffffffffffffn) {
      return err({ code: "E_WIRE_FIELD_RANGE", detail: "captureTimestampUs out of range" });
    }
    if (!isUint8(unit.flags) || !isUint8(unit.spatialId) || !isUint8(unit.temporalId)) {
      return err({ code: "E_WIRE_FIELD_RANGE", detail: "flags/spatialId/temporalId out of range" });
    }
    if (unit.spatialId > 3) {
      return err({ code: "E_WIRE_FIELD_RANGE", detail: `spatialId=${unit.spatialId}` });
    }
    if (unit.temporalId > 7) {
      return err({ code: "E_WIRE_FIELD_RANGE", detail: `temporalId=${unit.temporalId}` });
    }
    if (unitCount > 1 && unit.sequenceNumber <= previousSequence) {
      return err({ code: "E_WIRE_UNIT_ORDER", detail: `seq=${unit.sequenceNumber}` });
    }
    previousSequence = unit.sequenceNumber;
    totalBytes += UNIT_HEADER_BYTES + unit.payload.length;
  }
  if (totalBytes > MAX_MESSAGE_BYTES) {
    return err({ code: "E_WIRE_TOO_LARGE", detail: `totalBytes=${totalBytes}` });
  }

  const buffer = new Uint8Array(totalBytes);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  view.setUint8(0, WIRE_MAGIC);
  view.setUint8(1, WIRE_VERSION);
  view.setUint8(2, message.channel);
  view.setUint8(3, unitCount);
  view.setUint32(4, message.senderId, false);

  let offset = MESSAGE_HEADER_BYTES;
  for (const unit of message.units) {
    view.setUint32(offset + UNIT_HEADER_OFFSET.sequenceNumber, unit.sequenceNumber, false);
    view.setBigUint64(offset + UNIT_HEADER_OFFSET.captureTimestampHighUs, unit.captureTimestampUs, false);
    view.setUint8(offset + UNIT_HEADER_OFFSET.flags, unit.flags);
    view.setUint8(offset + UNIT_HEADER_OFFSET.spatialId, unit.spatialId);
    view.setUint8(offset + UNIT_HEADER_OFFSET.temporalId, unit.temporalId);
    view.setUint8(offset + UNIT_HEADER_OFFSET.reserved, 0);
    view.setUint32(offset + UNIT_HEADER_OFFSET.payloadLength, unit.payload.length, false);
    buffer.set(unit.payload, offset + UNIT_HEADER_BYTES);
    offset += UNIT_HEADER_BYTES + unit.payload.length;
  }
  return ok(buffer);
}

/** バイト列を MediaMessage へ復号する。 */
export function decodeMediaMessage(bytes: Uint8Array): Result<MediaMessage, WireError> {
  if (bytes.length < MESSAGE_HEADER_BYTES) {
    return err({ code: "E_WIRE_LENGTH_MISMATCH", detail: `length=${bytes.length}` });
  }
  if (bytes.length > MAX_MESSAGE_BYTES) {
    return err({ code: "E_WIRE_TOO_LARGE", detail: `length=${bytes.length}` });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint8(0);
  if (magic !== WIRE_MAGIC) {
    return err({ code: "E_WIRE_MAGIC", detail: `magic=0x${magic.toString(16)}` });
  }
  const version = view.getUint8(1);
  if (version !== WIRE_VERSION) {
    return err({ code: "E_WIRE_VERSION", detail: `version=${version}` });
  }
  const channel = view.getUint8(2);
  if (!isValidChannel(channel)) {
    return err({ code: "E_WIRE_CHANNEL", detail: `channel=${channel}` });
  }
  const unitCount = view.getUint8(3);
  if (unitCount === 0) {
    return err({ code: "E_WIRE_UNIT_COUNT", detail: "unitCount=0" });
  }
  if (VIDEO_CHANNEL_REQUIRES_SINGLE_UNIT && (channel === CHANNEL_VIDEO || channel === CHANNEL_SCREEN_VIDEO) && unitCount !== 1) {
    return err({ code: "E_WIRE_UNIT_COUNT", detail: `video channel requires unitCount=1, got ${unitCount}` });
  }
  const senderId = view.getUint32(4, false);
  if (senderId === 0) {
    return err({ code: "E_WIRE_SENDER_ID", detail: "senderId=0" });
  }

  const units: Unit[] = [];
  let offset = MESSAGE_HEADER_BYTES;
  let previousSequence = -1;
  for (let index = 0; index < unitCount; index += 1) {
    if (offset + UNIT_HEADER_BYTES > bytes.length) {
      return err({ code: "E_WIRE_LENGTH_MISMATCH", detail: `unit ${index} header truncated` });
    }
    const sequenceNumber = view.getUint32(offset + UNIT_HEADER_OFFSET.sequenceNumber, false);
    const captureTimestampUs = view.getBigUint64(offset + UNIT_HEADER_OFFSET.captureTimestampHighUs, false);
    const flags = view.getUint8(offset + UNIT_HEADER_OFFSET.flags);
    const spatialId = view.getUint8(offset + UNIT_HEADER_OFFSET.spatialId);
    const temporalId = view.getUint8(offset + UNIT_HEADER_OFFSET.temporalId);
    const payloadLength = view.getUint32(offset + UNIT_HEADER_OFFSET.payloadLength, false);
    if (payloadLength === 0) {
      return err({ code: "E_WIRE_PAYLOAD_EMPTY", detail: `unit ${index}` });
    }
    if (spatialId > 3 || temporalId > 7) {
      return err({ code: "E_WIRE_FIELD_RANGE", detail: `unit ${index} spatialId/temporalId` });
    }
    const payloadStart = offset + UNIT_HEADER_BYTES;
    const payloadEnd = payloadStart + payloadLength;
    if (payloadEnd > bytes.length) {
      return err({ code: "E_WIRE_LENGTH_MISMATCH", detail: `unit ${index} payload truncated` });
    }
    if (unitCount > 1 && sequenceNumber <= previousSequence) {
      return err({ code: "E_WIRE_UNIT_ORDER", detail: `unit ${index} seq=${sequenceNumber}` });
    }
    previousSequence = sequenceNumber;
    units.push({
      sequenceNumber,
      captureTimestampUs,
      flags,
      spatialId,
      temporalId,
      payload: bytes.slice(payloadStart, payloadEnd),
    });
    offset = payloadEnd;
  }
  if (offset !== bytes.length) {
    return err({ code: "E_WIRE_LENGTH_MISMATCH", detail: `trailing bytes=${bytes.length - offset}` });
  }
  return ok({ channel, senderId, units });
}

/**
 * 破棄優先順位を返す。wire-format.md 1.4 の表に対応する。
 * null は「破棄してはならない」を意味する。
 */
export function dropPriority(channel: number, flags: number): number | null {
  if (channel === CHANNEL_AUDIO || channel === CHANNEL_SCREEN_AUDIO) {
    return null;
  }
  const isKey = (flags & FLAG_KEY) !== 0;
  if (isKey) {
    return null;
  }
  const discardable = (flags & FLAG_DISCARDABLE) !== 0;
  const activeSpeaker = (flags & FLAG_ACTIVE_SPEAKER) !== 0;
  const screenContent = (flags & FLAG_SCREEN_CONTENT) !== 0;
  if (discardable) {
    if (screenContent) {
      return 3;
    }
    if (activeSpeaker) {
      return 2;
    }
    return 1;
  }
  return activeSpeaker ? 5 : 4;
}

/**
 * DISCARDABLE ビットを規範どおりに算出する。wire-format.md 1.3。
 * 送信側は必ず本関数の結果を用いる。
 */
export function computeDiscardable(
  channel: number,
  isKeyFrame: boolean,
  temporalId: number,
  temporalLayerCount: number,
): boolean {
  if (channel === CHANNEL_AUDIO || channel === CHANNEL_SCREEN_AUDIO) {
    return false;
  }
  if (isKeyFrame) {
    return false;
  }
  if (temporalLayerCount <= 1) {
    return false;
  }
  return temporalId === temporalLayerCount - 1;
}


export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

export function fromHex(hex: string): Result<Uint8Array, WireError> {
  if (hex.length % 2 !== 0) {
    return err({ code: "E_WIRE_LENGTH_MISMATCH", detail: "odd hex length" });
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const pair = hex.slice(i * 2, i * 2 + 2);
    const value = Number.parseInt(pair, 16);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return err({ code: "E_WIRE_LENGTH_MISMATCH", detail: `bad hex at ${i}` });
    }
    bytes[i] = value;
  }
  return ok(bytes);
}
