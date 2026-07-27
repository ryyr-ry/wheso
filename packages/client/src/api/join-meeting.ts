/**
 * 参加の入口。
 *
 * 規範: sdk-api.md 1 節（最小の呼び出しと行数予算）、2 節（設定）、
 * client-architecture.md 2 節（5 個の部屋への接続）、wire-format.md 2.1〜2.4。
 *
 * ここは端である。時刻・接続・カメラの取得を扱い、判断は持たない。
 * 環境依存はすべて注入する。理由は 2 つある。第 1 に、判断コアと同じく
 * 試験で決定的に動かせること。第 2 に、カメラの無い CI で検証できること（Q-020）。
 *
 * 失敗は例外ではなく `Result` で返す（lint-policy.md 原則 1）。
 */

import { type Result, err, ok } from "@wheso/core/src/result.ts";
import { readClaimsUnverified } from "@wheso/core/src/auth.ts";
import { CHANNEL_VIDEO, PROTOCOL_VERSION } from "@wheso/core/src/generated/wire-layout.ts";

import { parseJoinUrl, planRooms, roomUrl, type PersonalRoomRole } from "./join-url.ts";
import { createMeeting, type Meeting, type ParticipantRole, type VideoSinkHandle } from "./meeting.ts";
import {
  buildStreamAnnounce,
  framerateOf,
  selectProfiles,
  temporalLayersOf,
  type DeviceCapability,
  type ProfileId,
} from "../media/capability.ts";

export interface JoinError {
  readonly code: string;
  readonly detail: string;
}

/** 接続 1 本の最小の形。実装は WebSocket でも試験の偽物でもよい。 */
export interface JoinSocket {
  readonly send: (text: string) => void;
  readonly close: () => void;
  /** テキストの受信を購読する。 */
  readonly onText: (handler: (text: string) => void) => void;
}

/** 環境依存の注入。 */
export interface JoinDeps {
  /** 部屋の URL へ接続する。失敗した場合は null を返す（例外を投げない）。 */
  readonly openSocket: (url: string, role: PersonalRoomRole) => JoinSocket | null;
  /** 参加者ごとの受け皿を作る。 */
  readonly createSink: (participantId: string) => VideoSinkHandle;
  /** 能力探査の結果。送信プロファイルの決定に使う（sdk-api.md 2 節）。 */
  readonly capability: DeviceCapability;
  /** 論理時刻。 */
  readonly now: () => number;
}

/** 設定（sdk-api.md 2 節）。全項目が省略可能である。 */
export interface JoinOptions {
  readonly camera?: boolean;
  readonly microphone?: boolean;
  readonly videoProfile?: "auto" | ProfileId;
  readonly audioProfile?: "voice" | "music";
  readonly maxReceiveHighQuality?: "auto" | number;
  readonly lowLatencyMode?: boolean;
  readonly displayName?: string;
  /** トークンの取得。既定は URL のフラグメントから取る（有効期間 60 秒。auth.md 3.3）。 */
  readonly tokenProvider?: () => string;
  readonly onError?: (code: string) => void;
}

/** 参加した結果。接続の実体を返すのは、入口が閉じるためである。 */
export interface JoinedMeeting {
  readonly meeting: Meeting;
  /** 役割ごとの接続。利用者は触らない。 */
  readonly sockets: ReadonlyMap<PersonalRoomRole, JoinSocket>;
}

/** 参加 URL から senderId を導く。ワイヤの senderId は 32 bit の非 0 整数である。 */
export function senderIdFrom(userId: string): number {
  // FNV-1a の 32 bit。乱数を使わない（同じ利用者は同じ値になる必要がある）。
  let hash = 0x811c9dc5;
  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash ^ userId.charCodeAt(index)) >>> 0;
    hash = Math.trunc(hash * 0x01000193) >>> 0;
  }
  // 0 は不正である（wire-format.md 1.1）。0 になった場合は 1 に寄せる。
  return hash === 0 ? 1 : hash;
}

/**
 * 会議に参加する。
 *
 * 手順:
 *   1. 参加 URL を解析する（`https://<host>/j/<meetingId>#<token>`）
 *   2. 5 個の部屋名を計算する（room-naming.md）
 *   3. 5 本の接続を開き、各接続へ `hello` を送る
 *   4. 送信プロファイルを決めて `streamAnnounce` を送る
 *   5. ctl 部屋の `participants` を `Meeting` へ反映する
 *
 * 描画は行わない（ADR-0015）。受け皿は参加者ごとに作る。
 */
export async function joinMeeting(
  url: string,
  deps: JoinDeps,
  options: JoinOptions = {},
): Promise<Result<JoinedMeeting, JoinError>> {
  const target = parseJoinUrl(url);
  if (!target.ok) {
    return err({ code: target.error.code, detail: target.error.detail });
  }
  const token = options.tokenProvider === undefined ? target.value.token : options.tokenProvider();
  if (token.length === 0) {
    return err({ code: "E_AUTH", detail: "トークンが無い" });
  }

  // 部屋名の導出には利用者 ID が必要である。署名の検証はここでは行わない
  // （全ノードが検証する。auth.md 3.4）。
  const claims = readClaimsUnverified(token);
  if (!claims.ok) {
    return err({ code: claims.error.code, detail: claims.error.detail });
  }
  const userId = claims.value.sub;

  const plan = planRooms(target.value.meetingId, userId);
  if (!plan.ok) {
    return err({ code: plan.error.code, detail: plan.error.detail });
  }

  const senderId = senderIdFrom(userId);
  const sockets = new Map<PersonalRoomRole, JoinSocket>();
  const roles: readonly PersonalRoomRole[] = ["ctl", "vs", "vr", "as", "ar"];

  for (const role of roles) {
    const room = plan.value[role];
    const address = roomUrl(target.value.host, room, target.value.secure);
    if (!address.ok) {
      closeAll(sockets);
      return err({ code: address.error.code, detail: address.error.detail });
    }
    const socket = deps.openSocket(address.value, role);
    if (socket === null) {
      closeAll(sockets);
      return err({ code: "E_TRANSPORT", detail: `${role} 部屋へ接続できない` });
    }
    sockets.set(role, socket);
  }

  const meeting = createMeeting({
    meetingId: target.value.meetingId,
    selfId: userId,
    displayName: options.displayName ?? "",
    links: {
      sendControl: (text) => sockets.get("ctl")?.send(text),
      sendVideoControl: (text) => sockets.get("vs")?.send(text),
      sendAudioControl: (text) => sockets.get("as")?.send(text),
      closeAll: () => closeAll(sockets),
    },
    sinks: { create: (participantId) => deps.createSink(participantId) },
  });

  // 制御メッセージの受信を配線する。ctl 以外は自ノードからの通知のみを扱う。
  const control = sockets.get("ctl");
  if (control !== undefined) {
    control.onText((text) => {
      applyControlMessage(meeting, text, deps.now(), options.onError);
    });
  }

  // 各接続へ hello を送る。検証は全ノードが行う（wire-format.md 2.1）。
  const hello = JSON.stringify({
    t: "hello",
    protocolVersion: PROTOCOL_VERSION,
    token,
    senderId,
    capabilities: {
      decodeAv1: deps.capability.encodeAv1,
      encodeAv1: deps.capability.encodeAv1,
      platform: "browser",
    },
  });
  for (const socket of sockets.values()) {
    socket.send(hello);
  }

  // 送信プロファイルを決め、構成を申告する。
  // 申告が届く前のメディアは temporalLayers = 1 として扱われる（wire-format.md 2.3）。
  const profiles = resolveProfiles(deps.capability, options.videoProfile);
  const announce = buildStreamAnnounce(
    profiles.map((profile) => ({
      channel: CHANNEL_VIDEO,
      profile,
      framerate: framerateOf(profile),
      temporalLayers: temporalLayersOf(profile),
    })),
  );
  sockets.get("vs")?.send(announce);

  const camera = options.camera ?? true;
  const microphone = options.microphone ?? true;
  if (!camera) {
    meeting.setCamera(false);
  }
  if (!microphone) {
    meeting.setMicrophone(false);
  }

  return ok({ meeting, sockets });
}

/** 設定の `videoProfile` を解決する。`auto` は能力から選ぶ（sdk-api.md 2 節）。 */
export function resolveProfiles(
  capability: DeviceCapability,
  requested: "auto" | ProfileId = "auto",
): readonly ProfileId[] {
  if (requested === "auto") {
    return selectProfiles(capability);
  }
  // 明示された 1 本と、常に生成する最低品質を組む（定数規範 2 節）。
  return requested === "V_360P15" ? [requested] : [requested, "V_360P15"];
}

/**
 * ctl 部屋からのメッセージを `Meeting` へ反映する。
 *
 * 未知の `t` は無視する（wire-format.md 2 節）。前方互換のためである。
 */
export function applyControlMessage(
  meeting: Meeting,
  text: string,
  nowMs: number,
  onError?: (code: string) => void,
): void {
  const message = parseObject(text);
  if (message === null) {
    return;
  }
  const kind = message["t"];
  if (kind === "helloAck") {
    meeting.setState("active");
    return;
  }
  if (kind === "participants") {
    const entries = message["entries"];
    if (!Array.isArray(entries)) {
      return;
    }
    const seen: string[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const record: Record<string, unknown> = { ...entry };
      const userId = record["userId"];
      const role = record["role"];
      if (typeof userId !== "string" || !isRole(role)) {
        continue;
      }
      seen.push(userId);
      meeting.addParticipant({ id: userId, displayName: userId, role });
    }
    for (const existing of meeting.participants) {
      if (!seen.includes(existing.id)) {
        meeting.removeParticipant(existing.id);
      }
    }
    return;
  }
  if (kind === "activeSpeaker") {
    const id = message["participantId"];
    meeting.setActiveSpeaker(typeof id === "string" ? id : null);
    return;
  }
  if (kind === "chat") {
    const from = message["from"];
    const body = message["text"];
    if (typeof from !== "string" || typeof body !== "string") {
      return;
    }
    meeting.receiveChat(from, body, nowMs);
    return;
  }
  if (kind === "warning") {
    const code = message["code"];
    if (typeof code === "string") {
      meeting.warn(code);
    }
    return;
  }
  if (kind === "error") {
    const code = message["code"];
    if (typeof code === "string") {
      meeting.fail(code);
      // 文言は SDK が持たない。利用側へコードを渡す（sdk-api.md 2 節の onError）。
      onError?.(code);
    }
    return;
  }
  // 未知の t は無視する。
}

function isRole(value: unknown): value is ParticipantRole {
  return value === "host" || value === "presenter" || value === "viewer";
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    return { ...value };
  } catch {
    return null;
  }
}

function closeAll(sockets: ReadonlyMap<PersonalRoomRole, JoinSocket>): void {
  for (const socket of sockets.values()) {
    socket.close();
  }
}
