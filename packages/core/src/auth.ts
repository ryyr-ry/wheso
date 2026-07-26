/**
 * 認証と認可の参照実装。
 *
 * 規範は プロトコル規範 auth である。
 *
 * 依存は Web Crypto (crypto.subtle) のみである。Cloudflare Workers と Node.js の
 * 双方で同一のコードが動作する。Buffer などランタイム固有の API は使用しない。
 *
 * 本ファイルの制約（spec/lint-policy.md）:
 *   any / 型アサーション / 非 null 断定を使用しない。例外を投げない。
 */

import { err, ok, type Result } from "./wire.ts";
import { personalRoom, validateMeetingId, validateUserId } from "./naming.ts";

export type AuthErrorCode =
  | "E_AUTH"
  | "E_AUTH_EXPIRED"
  | "E_AUTH_AUDIENCE"
  | "E_AUTH_ROOM"
  | "E_AUTH_KIND"
  | "E_NODE_AUTH";

export interface AuthError {
  readonly code: AuthErrorCode;
  readonly detail: string;
}

export const TOKEN_MAX_AGE_SEC = 60;
export const TOKEN_CLOCK_SKEW_SEC = 5;
export const NODE_AUTH_TIME_WINDOW_SEC = 300;

export interface TokenClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
  readonly kind: "client" | "node";
  readonly role: "host" | "presenter" | "viewer";
}

/* ------------------------------------------------------------------------- */
/* base64url                                                                 */
/* ------------------------------------------------------------------------- */

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    if (b0 === undefined) {
      break;
    }
    const triple = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += BASE64URL_ALPHABET.charAt((triple >> 18) & 0x3f);
    out += BASE64URL_ALPHABET.charAt((triple >> 12) & 0x3f);
    if (b1 !== undefined) {
      out += BASE64URL_ALPHABET.charAt((triple >> 6) & 0x3f);
    }
    if (b2 !== undefined) {
      out += BASE64URL_ALPHABET.charAt(triple & 0x3f);
    }
  }
  return out;
}

export function base64UrlDecode(text: string): Result<Uint8Array, AuthError> {
  const values: number[] = [];
  for (const char of text) {
    const index = BASE64URL_ALPHABET.indexOf(char);
    if (index < 0) {
      return err({ code: "E_AUTH", detail: `invalid base64url character` });
    }
    values.push(index);
  }
  const byteLength = Math.floor((values.length * 6) / 8);
  const bytes = new Uint8Array(byteLength);
  let bitBuffer = 0;
  let bitCount = 0;
  let outIndex = 0;
  for (const value of values) {
    bitBuffer = (bitBuffer << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[outIndex] = (bitBuffer >> bitCount) & 0xff;
      outIndex += 1;
    }
  }
  return ok(bytes);
}

/* ------------------------------------------------------------------------- */
/* HMAC                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * ArrayBuffer を後ろ盾に持つ Uint8Array へ複製する。
 *
 * crypto.subtle は BufferSource（ArrayBuffer 由来）を要求するが、
 * TextEncoder などが返す Uint8Array は ArrayBufferLike（SharedArrayBuffer を含む）
 * を後ろ盾に持つ型として推論される。型アサーションを使わずに整合させるため複製する。
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function importHmacKey(keyBytes: Uint8Array): Promise<Result<CryptoKey, AuthError>> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(keyBytes),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return ok(key);
  } catch {
    return err({ code: "E_AUTH", detail: "cannot import key" });
  }
}

export async function hmacSha256(keyBytes: Uint8Array, message: string): Promise<Result<Uint8Array, AuthError>> {
  const key = await importHmacKey(keyBytes);
  if (!key.ok) {
    return key;
  }
  try {
    const encoded = toArrayBuffer(new TextEncoder().encode(message));
    const signature = await crypto.subtle.sign("HMAC", key.value, encoded);
    return ok(new Uint8Array(signature));
  } catch {
    return err({ code: "E_AUTH", detail: "sign failed" });
  }
}

/** 定数時間比較。タイミング攻撃を防ぐ。 */
export function constantTimeEquals(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/* ------------------------------------------------------------------------- */
/* クライアントトークン                                                      */
/* ------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function readNumberField(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function parseClaims(json: string): Result<TokenClaims, AuthError> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    return err({ code: "E_AUTH", detail: "claims not json" });
  }
  if (!isRecord(decoded)) {
    return err({ code: "E_AUTH", detail: "claims not object" });
  }
  const iss = readStringField(decoded, "iss");
  const sub = readStringField(decoded, "sub");
  const aud = readStringField(decoded, "aud");
  const jti = readStringField(decoded, "jti");
  const kindRaw = readStringField(decoded, "kind");
  const roleRaw = readStringField(decoded, "role");
  const iat = readNumberField(decoded, "iat");
  const exp = readNumberField(decoded, "exp");
  if (iss === null || sub === null || aud === null || jti === null || iat === null || exp === null) {
    return err({ code: "E_AUTH", detail: "missing claim" });
  }
  if (kindRaw !== "client" && kindRaw !== "node") {
    return err({ code: "E_AUTH_KIND", detail: `kind=${String(kindRaw)}` });
  }
  if (roleRaw !== "host" && roleRaw !== "presenter" && roleRaw !== "viewer") {
    return err({ code: "E_AUTH", detail: `role=${String(roleRaw)}` });
  }
  return ok({ iss, sub, aud, iat, exp, jti, kind: kindRaw, role: roleRaw });
}

/** HS256 のトークンを生成する。テストと開発用途に用いる。本番の発行はアプリサーバが行う。 */
export async function issueToken(
  keyBytes: Uint8Array,
  claims: TokenClaims,
): Promise<Result<string, AuthError>> {
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const signature = await hmacSha256(keyBytes, signingInput);
  if (!signature.ok) {
    return signature;
  }
  return ok(`${signingInput}.${base64UrlEncode(signature.value)}`);
}

export interface VerifyOptions {
  readonly keyBytes: Uint8Array;
  readonly token: string;
  readonly expectedMeetingId: string;
  readonly roomName: string;
  readonly nowSec: number;
}

/**
 * トークンを検証し、要求された部屋への接続を認可する。
 *
 * 検証順序:
 *   1. 形式（3 分割、ヘッダの alg）
 *   2. 署名
 *   3. 有効期限
 *   4. aud が会議 ID と一致
 *   5. 要求された部屋名が (aud, sub) から導出できる
 */
export async function verifyClientToken(options: VerifyOptions): Promise<Result<TokenClaims, AuthError>> {
  const parts = options.token.split(".");
  if (parts.length !== 3) {
    return err({ code: "E_AUTH", detail: "token must have 3 parts" });
  }
  const headerPart = parts[0];
  const payloadPart = parts[1];
  const signaturePart = parts[2];
  if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
    return err({ code: "E_AUTH", detail: "token part missing" });
  }

  const headerBytes = base64UrlDecode(headerPart);
  if (!headerBytes.ok) {
    return headerBytes;
  }
  let headerObject: unknown;
  try {
    headerObject = JSON.parse(new TextDecoder().decode(headerBytes.value));
  } catch {
    return err({ code: "E_AUTH", detail: "header not json" });
  }
  if (!isRecord(headerObject) || headerObject["alg"] !== "HS256") {
    return err({ code: "E_AUTH", detail: "alg must be HS256" });
  }

  const expected = await hmacSha256(options.keyBytes, `${headerPart}.${payloadPart}`);
  if (!expected.ok) {
    return expected;
  }
  const provided = base64UrlDecode(signaturePart);
  if (!provided.ok) {
    return provided;
  }
  if (!constantTimeEquals(expected.value, provided.value)) {
    return err({ code: "E_AUTH", detail: "signature mismatch" });
  }

  const payloadBytes = base64UrlDecode(payloadPart);
  if (!payloadBytes.ok) {
    return payloadBytes;
  }
  const claims = parseClaims(new TextDecoder().decode(payloadBytes.value));
  if (!claims.ok) {
    return claims;
  }

  if (claims.value.exp <= options.nowSec) {
    return err({ code: "E_AUTH_EXPIRED", detail: `exp=${claims.value.exp} now=${options.nowSec}` });
  }
  if (claims.value.iat > options.nowSec + TOKEN_CLOCK_SKEW_SEC) {
    return err({ code: "E_AUTH", detail: "iat in the future" });
  }
  if (claims.value.exp - claims.value.iat > TOKEN_MAX_AGE_SEC) {
    return err({ code: "E_AUTH", detail: "token lifetime too long" });
  }
  if (claims.value.kind !== "client") {
    return err({ code: "E_AUTH_KIND", detail: "client token required" });
  }
  if (claims.value.aud !== options.expectedMeetingId) {
    return err({ code: "E_AUTH_AUDIENCE", detail: "aud mismatch" });
  }
  const meeting = validateMeetingId(claims.value.aud);
  if (!meeting.ok) {
    return err({ code: "E_AUTH_AUDIENCE", detail: "aud is not a meetingId" });
  }
  const user = validateUserId(claims.value.sub);
  if (!user.ok) {
    return err({ code: "E_AUTH", detail: "sub is not a userId" });
  }
  const allowed = allowedClientRooms(claims.value.aud, claims.value.sub);
  if (!allowed.includes(options.roomName)) {
    return err({ code: "E_AUTH_ROOM", detail: "room not permitted for this subject" });
  }
  return ok(claims.value);
}

/**
 * クライアントが接続を許可される部屋の一覧。
 * 共有部屋（シャード、コーディネータ、MetaRoom）へクライアントは接続できない。
 */
export function allowedClientRooms(meetingId: string, userId: string): readonly string[] {
  const rooms: string[] = [];
  for (const role of ["ctl", "vs", "vr", "as", "ar"] as const) {
    const name = personalRoom(role, meetingId, userId);
    if (name.ok) {
      rooms.push(name.value);
    }
  }
  return rooms;
}

/* ------------------------------------------------------------------------- */
/* ノード間認証                                                              */
/* ------------------------------------------------------------------------- */

/** 会議ごとの秘密鍵を導出する。ノード共通鍵をそのまま使い回さない。 */
export async function deriveMeetingSecret(
  nodeKeyBytes: Uint8Array,
  meetingId: string,
): Promise<Result<Uint8Array, AuthError>> {
  const meeting = validateMeetingId(meetingId);
  if (!meeting.ok) {
    return err({ code: "E_NODE_AUTH", detail: "invalid meetingId" });
  }
  return hmacSha256(nodeKeyBytes, `meeting-secret:v1:${meeting.value}`);
}

export function nodeAuthTimeWindow(nowSec: number): number {
  return Math.floor(nowSec / NODE_AUTH_TIME_WINDOW_SEC);
}

export async function nodeAuthTag(
  meetingSecret: Uint8Array,
  targetRoomName: string,
  role: string,
  timeWindow: number,
): Promise<Result<string, AuthError>> {
  const signature = await hmacSha256(meetingSecret, `node-auth:v1:${targetRoomName}:${role}:${timeWindow}`);
  if (!signature.ok) {
    return err({ code: "E_NODE_AUTH", detail: signature.error.detail });
  }
  return ok(base64UrlEncode(signature.value));
}

/**
 * ノード間認証タグを検証する。
 * 時刻窓の境界での失敗を避けるため、現在の窓と 1 つ前の窓の両方を許容する。
 */
export async function verifyNodeAuthTag(
  meetingSecret: Uint8Array,
  targetRoomName: string,
  role: string,
  providedTag: string,
  nowSec: number,
): Promise<Result<number, AuthError>> {
  const provided = base64UrlDecode(providedTag);
  if (!provided.ok) {
    return err({ code: "E_NODE_AUTH", detail: "tag not base64url" });
  }
  const currentWindow = nodeAuthTimeWindow(nowSec);
  for (const window of [currentWindow, currentWindow - 1]) {
    const expected = await nodeAuthTag(meetingSecret, targetRoomName, role, window);
    if (!expected.ok) {
      return err({ code: "E_NODE_AUTH", detail: expected.error.detail });
    }
    const expectedBytes = base64UrlDecode(expected.value);
    if (!expectedBytes.ok) {
      return err({ code: "E_NODE_AUTH", detail: "internal encoding error" });
    }
    if (constantTimeEquals(expectedBytes.value, provided.value)) {
      return ok(window);
    }
  }
  return err({ code: "E_NODE_AUTH", detail: "tag mismatch" });
}
