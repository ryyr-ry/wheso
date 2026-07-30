/**
 * 個人部屋のクライアント認証（`ctl` / `vs` / `vr` / `as` / `ar` に共通）。
 *
 * 規範: auth.md 3.4（接続できるのは 5 つの個人部屋のみ）、auth.md 冒頭
 *       「**認証は全ノードで必須であり、省略できるノードは存在しない**」、
 *       wire-format.md 2.1（hello）・2.2（helloAck）。
 *
 * **なぜ共通化するか。** 以前は `ctl` だけがトークンを検証しており、`vs` / `vr` / `as` / `ar`
 * は誰でも接続できた。部屋名は `(会議 ID, 利用者 ID)` から決定論的に決まるため、
 * 名前を知る第三者が受信部屋へ繋いでメディアを流し込める状態だった。検証を 4 箇所に
 * 書き写すと必ず 1 箇所が古くなるため、判断はこのファイルの 1 箇所に置く。
 *
 * あわせて **`helloAck` を全部屋が返す**。返さない部屋のリンクは接続の状態機械が
 * `ACTIVE` へ到達できず、`subscribe` と `streamAnnounce` を 1 度も送らない
 * （state-machines.md 1 節）。実際にその状態であり、媒体系の 4 部屋は 9 秒ごとに
 * 再接続を繰り返していた。
 */

import { type Result, err, ok } from "@wheso/core/src/result.ts";
import { ERROR_DEFINITIONS } from "@wheso/core/src/generated/errors.ts";

import { authorize, helloAck, parseHello, type ControlError } from "./control-handler.ts";

/** 個人部屋の役割。auth.md 3.4 の 5 つに限る。 */
export type PersonalRole = "ctl" | "vs" | "vr" | "as" | "ar";

/** 認証を通ったクライアント。 */
export interface AdmittedClient {
  readonly userId: string;
  readonly role: "host" | "presenter" | "viewer";
  readonly senderId: number;
  /** そのまま送り返す `helloAck` の本文。 */
  readonly ackText: string;
}

export interface AdmitOptions {
  /** 接続してきた部屋の名前（`<役割>-<会議 ID>-<利用者 ID>`）。 */
  readonly roomId: string;
  /** その部屋が担う役割。部屋名の先頭と一致しなければ拒否する。 */
  readonly expectedRole: PersonalRole;
  /** トークンの署名鍵。環境変数から入口が渡す（Q-019）。 */
  readonly tokenKey: string;
  /** 受け取った本文。 */
  readonly text: string;
  /** 現在時刻（ミリ秒）。入口が取得する。 */
  readonly nowMs: number;
}

/**
 * 個人部屋の名前から会議 ID を取り出す。
 *
 * 形式は `<役割>-<会議 ID>-<利用者 ID>` である（room-naming.md 1 節）。
 * 役割が期待と違う場合は null を返す。**別の役割の部屋名で認可してはならない。**
 */
export function meetingIdFromPersonalRoom(roomId: string, expectedRole: PersonalRole): string | null {
  const parts = roomId.split("-");
  const role = parts[0];
  const meetingId = parts[1];
  if (role !== expectedRole || meetingId === undefined || meetingId.length === 0) {
    return null;
  }
  return meetingId;
}

/**
 * `hello` を検証し、通れば `helloAck` の本文を返す。
 *
 * 失敗はクローズコードを持つ誤りとして返す。例外を投げない（lint-policy.md 原則 1）。
 */
export async function admitClient(options: AdmitOptions): Promise<Result<AdmittedClient, ControlError>> {
  const hello = parseHello(options.text);
  if (!hello.ok) {
    return err(hello.error);
  }
  if (options.tokenKey.length === 0) {
    // 鍵が無い環境では認証できない。開いたままにしない。
    return err({
      code: "E_AUTH",
      closeCode: ERROR_DEFINITIONS.E_AUTH.closeCode,
      detail: "token key missing",
    });
  }
  const meetingId = meetingIdFromPersonalRoom(options.roomId, options.expectedRole);
  if (meetingId === null) {
    return err({
      code: "E_NAME_MEETING_ID",
      closeCode: ERROR_DEFINITIONS.E_NAME_MEETING_ID.closeCode,
      detail: `room=${options.roomId}`,
    });
  }
  const authorized = await authorize({
    keyBytes: new TextEncoder().encode(options.tokenKey),
    token: hello.value.token,
    meetingId,
    roomName: options.roomId,
    nowSec: Math.trunc(options.nowMs / 1000),
  });
  if (!authorized.ok) {
    return err(authorized.error);
  }
  return ok({
    userId: authorized.value.userId,
    role: authorized.value.role,
    senderId: hello.value.senderId,
    ackText: helloAck(hello.value.senderId, options.nowMs),
  });
}
