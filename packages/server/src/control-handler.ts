/**
 * 制御ノード（control、`ctl` 部屋）の伝送層。
 *
 * 責務:
 *   1. `hello` のトークンを検証し、要求された部屋への接続を認可する（auth.md 3.4）
 *   2. `helloAck` を返す
 *   3. 参加者の一覧を保持し、変化を配信する
 *   4. 各ノードからの状態通知（過負荷など）を集約する
 *
 * トークン検証は全ノードで行う。部屋名が決定論的であるため、検証を省いたノードは
 * 第三者から接続可能になる（wire-format.md 2.1、auth.md 3.4）。
 *
 * 判断のうち純粋なもの（認可の可否、参加者集合の更新）はこのファイルの純関数に置く。
 * 署名検証は暗号 API を使うため非同期であり、入口から呼ぶ。
 */

import { allowedClientRooms, verifyClientToken } from "@wheso/core/src/auth.ts";
import { ERROR_DEFINITIONS } from "@wheso/core/src/generated/errors.ts";
import { PROTOCOL_VERSION } from "@wheso/core/src/generated/wire-layout.ts";
import { AUDIO_BUNDLE_MS, OPUS_FRAME_MS } from "@wheso/core/src/generated/constants.ts";
import { type Result, err, ok } from "@wheso/core/src/result.ts";

/** 参加者 1 人。 */
export interface Participant {
  readonly userId: string;
  readonly senderId: number;
  readonly role: "host" | "presenter" | "viewer";
}

export interface ControlState {
  /** userId の昇順で保持する。反復順序が配信内容に影響するため決定的にする。 */
  readonly participants: readonly Participant[];
  /** ノードから届いた状態通知の記録。過負荷の検出に使う。 */
  readonly nodeStatuses: readonly number[];
}

export interface ControlError {
  readonly code: string;
  readonly closeCode: number;
  readonly detail: string;
}

export function createControlState(): ControlState {
  return { participants: [], nodeStatuses: [] };
}

/** `hello` の内容。実行時検査を通した後の型である。 */
export interface HelloMessage {
  readonly protocolVersion: number;
  readonly token: string;
  readonly senderId: number;
}

/** テキストから `hello` を取り出す。形式違反は失敗として返す（例外を投げない）。 */
export function parseHello(text: string): Result<HelloMessage, ControlError> {
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    return err(controlError("E_CTRL_PARSE", "JSON として解析できない"));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(controlError("E_CTRL_PARSE", "オブジェクトではない"));
  }
  const record: Record<string, unknown> = { ...value };
  if (record["t"] !== "hello") {
    return err(controlError("E_CTRL_PARSE", "hello ではない"));
  }
  const protocolVersion = record["protocolVersion"];
  const token = record["token"];
  const senderId = record["senderId"];
  if (typeof protocolVersion !== "number" || !Number.isInteger(protocolVersion)) {
    return err(controlError("E_CTRL_VERSION", "protocolVersion が整数でない"));
  }
  if (protocolVersion !== PROTOCOL_VERSION) {
    return err(controlError("E_CTRL_VERSION", `protocolVersion=${protocolVersion}`));
  }
  if (typeof token !== "string" || token.length === 0) {
    return err(controlError("E_AUTH", "token が無い"));
  }
  if (typeof senderId !== "number" || !Number.isInteger(senderId) || senderId <= 0) {
    return err(controlError("E_WIRE_SENDER_ID", "senderId が正の整数でない"));
  }
  return ok({ protocolVersion, token, senderId });
}

export interface AuthorizeOptions {
  readonly keyBytes: Uint8Array;
  readonly token: string;
  readonly meetingId: string;
  /** 接続してきた部屋の名前。`ctl-<会議 ID>-<利用者 ID>` の形である。 */
  readonly roomName: string;
  readonly nowSec: number;
}

export interface AuthorizedClient {
  readonly userId: string;
  readonly role: "host" | "presenter" | "viewer";
}

/**
 * トークンを検証し、部屋名の認可を行う。
 *
 * 認可は「要求された部屋名が (aud, sub) から導出できるか」で判定する（auth.md 3.4）。
 * トークンに部屋一覧を含めない理由は、発行側の付与漏れと過剰付与を構造的に防ぐためである。
 */
export async function authorize(options: AuthorizeOptions): Promise<Result<AuthorizedClient, ControlError>> {
  const verified = await verifyClientToken({
    keyBytes: options.keyBytes,
    token: options.token,
    expectedMeetingId: options.meetingId,
    roomName: options.roomName,
    nowSec: options.nowSec,
  });
  if (!verified.ok) {
    return err(controlError(verified.error.code, verified.error.detail));
  }
  const claims = verified.value;
  const allowed = allowedClientRooms(claims.aud, claims.sub);
  if (!allowed.includes(options.roomName)) {
    return err(controlError("E_AUTH_ROOM", `room=${options.roomName}`));
  }
  return ok({ userId: claims.sub, role: claims.role });
}

/** `helloAck` の本文を作る（wire-format.md 2.2）。 */
export function helloAck(senderId: number, serverEpochMs: number): string {
  return JSON.stringify({
    t: "helloAck",
    protocolVersion: PROTOCOL_VERSION,
    assignedSenderId: senderId,
    serverEpochMs,
    constants: { audioBundleMs: AUDIO_BUNDLE_MS, opusFrameMs: OPUS_FRAME_MS },
  });
}

/** 参加者を追加する。同じ userId は上書きする。純関数。 */
export function addParticipant(state: ControlState, participant: Participant): ControlState {
  const rest = state.participants.filter((entry) => entry.userId !== participant.userId);
  const merged = [...rest, participant].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  return { ...state, participants: merged };
}

/** 参加者を除去する。純関数。 */
export function removeParticipant(state: ControlState, userId: string): ControlState {
  return { ...state, participants: state.participants.filter((entry) => entry.userId !== userId) };
}

/** ノードからの状態通知を記録する。純関数。 */
export function recordNodeStatus(state: ControlState, code: number): ControlState {
  return { ...state, nodeStatuses: [...state.nodeStatuses, code] };
}

/** 参加者一覧の配信内容を作る。 */
export function participantsMessage(state: ControlState): string {
  return JSON.stringify({
    t: "participants",
    entries: state.participants.map((entry) => ({
      userId: entry.userId,
      senderId: entry.senderId,
      role: entry.role,
    })),
  });
}

/** 過負荷の通知が届いているか。届いていればシャードの再分割が必要である。 */
export function needsResharding(state: ControlState): boolean {
  return state.nodeStatuses.includes(ERROR_DEFINITIONS.E_NODE_OVERLOADED.closeCode);
}

/** エラーコードからクローズコードを引く。未知のコードは既定値を使う。 */
function controlError(code: string, detail: string): ControlError {
  const table: Record<string, { readonly closeCode: number }> = { ...ERROR_DEFINITIONS };
  const entry = table[code];
  // 未知のコードは認証失敗として扱う。曖昧な成功を返さないためである。
  const closeCode = entry?.closeCode ?? ERROR_DEFINITIONS.E_AUTH.closeCode;
  return { code, closeCode, detail };
}
