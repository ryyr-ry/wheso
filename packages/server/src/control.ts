/**
 * 制御ノード（control、`ctl` 部屋）の Durable Object 入口。
 *
 * 判断は書かない。責務は接続・時刻・鍵の取得という副作用の扱いのみである。
 * PartyKit は既定輸出のクラスを要求するため、本ファイルのみ既定輸出を用いる
 * （lint-policy.md 9.4 の例外）。
 *
 * 鍵は環境変数から読む。クライアントへ渡してはならない（Q-019）。
 * 部屋名は `ctl-<会議 ID>-<利用者 ID>` である。会議 ID は部屋名から取り出す。
 */

import type * as Party from "partykit/server";

import {
  addParticipant,
  authorize,
  createControlState,
  helloAck,
  parseHello,
  participantsMessage,
  recordNodeStatus,
  removeParticipant,
  type ControlState,
} from "./control-handler.ts";
import { ERROR_DEFINITIONS } from "@wheso/core/src/generated/errors.ts";

/** 認証前の接続に許す猶予。これを超えて hello が来ない接続は閉じる。 */
const HELLO_TIMEOUT_MS = 5000;

export class ControlNode implements Party.Server {
  private state: ControlState = createControlState();

  /** 接続 ID から認証済みの利用者 ID を引く。未認証の接続は含まない。 */
  private readonly authenticated = new Map<string, string>();

  constructor(readonly room: Party.Room) {}

  onConnect(connection: Party.Connection): void {
    // 未認証の接続を放置しない。猶予を過ぎたら閉じる（auth.md 5 節の濫用対策）。
    void this.room.storage.setAlarm(Date.now() + HELLO_TIMEOUT_MS);
    void connection;
  }

  onClose(connection: Party.Connection): void {
    const userId = this.authenticated.get(connection.id);
    if (userId === undefined) {
      return;
    }
    this.authenticated.delete(connection.id);
    this.state = removeParticipant(this.state, userId);
    this.room.broadcast(participantsMessage(this.state));
  }

  async onMessage(message: string | ArrayBuffer, sender: Party.Connection): Promise<void> {
    if (typeof message !== "string") {
      // 制御部屋にメディアは来ない。形式違反として閉じる。
      sender.close(ERROR_DEFINITIONS.E_CTRL_SCHEMA.closeCode, "E_CTRL_SCHEMA");
      return;
    }

    if (!this.authenticated.has(sender.id)) {
      await this.handleHello(message, sender);
      return;
    }

    // 認証済みの接続からの通知を集約する。未知の `t` は無視する。
    const parsed = parseStatus(message);
    if (parsed !== null) {
      this.state = recordNodeStatus(this.state, parsed);
    }
  }

  onAlarm(): void {
    // 猶予を過ぎた未認証の接続を閉じる。
    for (const connection of this.room.getConnections()) {
      if (!this.authenticated.has(connection.id)) {
        connection.close(ERROR_DEFINITIONS.E_AUTH.closeCode, "hello timeout");
      }
    }
  }

  private async handleHello(message: string, sender: Party.Connection): Promise<void> {
    const hello = parseHello(message);
    if (!hello.ok) {
      sender.close(hello.error.closeCode, hello.error.code);
      return;
    }
    const keyText = this.room.env["WHESO_TOKEN_KEY"];
    if (typeof keyText !== "string" || keyText.length === 0) {
      // 鍵が無い環境では認証できない。開いたままにしない。
      sender.close(ERROR_DEFINITIONS.E_AUTH.closeCode, "key missing");
      return;
    }
    const meetingId = meetingIdFromRoom(this.room.id);
    if (meetingId === null) {
      sender.close(ERROR_DEFINITIONS.E_NAME_MEETING_ID.closeCode, "E_NAME_MEETING_ID");
      return;
    }
    const result = await authorize({
      keyBytes: new TextEncoder().encode(keyText),
      token: hello.value.token,
      meetingId,
      roomName: this.room.id,
      nowSec: Math.trunc(Date.now() / 1000),
    });
    if (!result.ok) {
      sender.close(result.error.closeCode, result.error.code);
      return;
    }
    this.authenticated.set(sender.id, result.value.userId);
    this.state = addParticipant(this.state, {
      userId: result.value.userId,
      senderId: hello.value.senderId,
      role: result.value.role,
    });
    sender.send(helloAck(hello.value.senderId, Date.now()));
    this.room.broadcast(participantsMessage(this.state));
  }
}

/** `ctl-<会議 ID>-<利用者 ID>` から会議 ID を取り出す。 */
function meetingIdFromRoom(roomId: string): string | null {
  const parts = roomId.split("-");
  const role = parts[0];
  const meetingId = parts[1];
  if (role !== "ctl" || meetingId === undefined) {
    return null;
  }
  return meetingId;
}

/** ノードからの状態通知のコードを取り出す。未知の形式は null。 */
function parseStatus(text: string): number | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const record: Record<string, unknown> = { ...value };
    if (record["t"] !== "nodeStatus") {
      return null;
    }
    const code = record["code"];
    return typeof code === "number" && Number.isInteger(code) ? code : null;
  } catch {
    return null;
  }
}

export default ControlNode;
