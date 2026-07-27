/**
 * 参加 URL の解析と部屋名の決定。
 *
 * 規範: sdk-api.md 1 節（`https://<host>/j/<meetingId>#<token>`）、
 *       auth.md 3.4（接続できるのは 5 つの個人部屋のみ）、room-naming.md。
 *
 * 純関数である。入出力を行わない。時刻も取らない。
 */

import { allowedClientRooms } from "@wheso/core/src/auth.ts";
import { validateMeetingId, validateUserId } from "@wheso/core/src/naming.ts";
import { type Result, err, ok } from "@wheso/core/src/result.ts";

export interface JoinUrlError {
  readonly code: string;
  readonly detail: string;
}

/** 参加 URL から取り出した情報。 */
export interface JoinTarget {
  readonly host: string;
  readonly meetingId: string;
  readonly token: string;
}

/**
 * 参加 URL を解析する。
 *
 * トークンはフラグメントに置かれる。理由はサーバのアクセスログとリファラに残らないことである
 * （sdk-api.md 1 節）。したがって解析はクライアント側でのみ行う。
 */
export function parseJoinUrl(url: string): Result<JoinTarget, JoinUrlError> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return err({ code: "E_JOIN_URL", detail: "URL として解析できない" });
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  const marker = segments[0];
  const meetingId = segments[1];
  if (marker !== "j" || meetingId === undefined) {
    return err({ code: "E_JOIN_URL", detail: "経路が /j/<meetingId> でない" });
  }
  const validated = validateMeetingId(meetingId);
  if (!validated.ok) {
    return err({ code: validated.error.code, detail: validated.error.detail });
  }
  const token = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  if (token.length === 0) {
    return err({ code: "E_JOIN_URL", detail: "トークンがフラグメントに無い" });
  }
  return ok({ host: parsed.host, meetingId: validated.value, token });
}

/** 個人部屋の役割。auth.md 3.4 の 5 つに限る。 */
export type PersonalRoomRole = "ctl" | "vs" | "vr" | "as" | "ar";

/** 接続先の一覧。5 つの個人部屋のみである。 */
export interface RoomPlan {
  readonly ctl: string;
  readonly vs: string;
  readonly vr: string;
  readonly as: string;
  readonly ar: string;
}

/**
 * 接続する部屋の名前を決める。
 *
 * 部屋名は決定論的であり、中央へ問い合わせない（room-naming.md 1 節）。
 * 許可される部屋は `(会議 ID, 利用者 ID)` から導出される 5 つのみである。
 */
export function planRooms(meetingId: string, userId: string): Result<RoomPlan, JoinUrlError> {
  const meeting = validateMeetingId(meetingId);
  if (!meeting.ok) {
    return err({ code: meeting.error.code, detail: meeting.error.detail });
  }
  const user = validateUserId(userId);
  if (!user.ok) {
    return err({ code: user.error.code, detail: user.error.detail });
  }
  const allowed = allowedClientRooms(meeting.value, user.value);
  const plan: Partial<Record<PersonalRoomRole, string>> = {};
  for (const room of allowed) {
    const role = room.split("-")[0];
    if (role === "ctl" || role === "vs" || role === "vr" || role === "as" || role === "ar") {
      plan[role] = room;
    }
  }
  const { ctl, vs, vr, as: audioSend, ar } = plan;
  if (ctl === undefined || vs === undefined || vr === undefined || audioSend === undefined || ar === undefined) {
    return err({ code: "E_JOIN_URL", detail: "個人部屋の導出に失敗した" });
  }
  return ok({ ctl, vs, vr, as: audioSend, ar });
}

/** 部屋へ接続する URL を作る。役割ごとに party が分かれる。 */
export function roomUrl(host: string, room: string, secure = true): Result<string, JoinUrlError> {
  const role = room.split("-")[0];
  const party = partyOf(role);
  if (party === null) {
    return err({ code: "E_JOIN_URL", detail: `未知の役割: ${String(role)}` });
  }
  const scheme = secure ? "wss" : "ws";
  return ok(`${scheme}://${host}/parties/${party}/${room}`);
}

/** 個人部屋の役割から party の名前を引く。partykit.json の parties と一致させる。 */
function partyOf(role: string | undefined): string | null {
  switch (role) {
    case "ctl":
      return "control";
    case "vs":
    case "as":
      return "sender";
    case "vr":
    case "ar":
      return "receiver";
    default:
      return null;
  }
}
