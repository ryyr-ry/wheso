/**
 * 受信ノード（receiver）の Durable Object 入口。
 *
 * 判断は書かない。責務は接続と時刻という副作用の扱い、および
 * クライアント接続と上流（中継ノード）接続の区別のみである。
 *
 * PartyKit は既定輸出のクラスを要求するため、本ファイルのみ既定輸出を用いる
 * （lint-policy.md 9.4 の例外）。
 *
 * 接続の区別: クライアントは接続時に `?role=client`、上流ノードは `?role=upstream` を付ける。
 * 役割の宣言が無い接続はクライアントとして扱う。ノード間接続の認証は control ノードの
 * 実装時に nodeHello（wire-format.md 2.8）で行う。
 */

import type * as Party from "partykit/server";

import { NODE_MAX_OUT_BYTES_PER_SEC } from "@wheso/core/src/generated/constants.ts";

import { ACK_INTERVAL_MS } from "@wheso/core/src/generated/constants.ts";

import {
  createReceiverHandlerState,
  handleAckTimer,
  handleClientBinary,
  handleClientText,
  handleUpstreamBinary,
  type ReceiverHandlerState,
  type ReceiverTransport,
} from "./receiver-handler.ts";

type Role = "client" | "upstream";

export class ReceiverNode implements Party.Server {
  private state: ReceiverHandlerState;

  private readonly roles = new Map<string, Role>();

  private clientConnectionId: string | null = null;

  private readonly transport: ReceiverTransport;

  constructor(readonly room: Party.Room) {
    this.state = createReceiverHandlerState(NODE_MAX_OUT_BYTES_PER_SEC, Date.now());
    this.transport = {
      sendToClient: (bytes) => {
        this.withClient((connection) => connection.send(bytes));
      },
      sendTextToClient: (text) => {
        this.withClient((connection) => connection.send(text));
      },
      sendUpstream: (text) => {
        for (const [id, role] of this.roles) {
          if (role !== "upstream") {
            continue;
          }
          const connection = this.room.getConnection(id);
          if (connection !== undefined && connection !== null) {
            connection.send(text);
          }
        }
      },
      closeClient: (code, reason) => {
        this.withClient((connection) => connection.close(code, reason));
      },
    };
  }

  onAlarm(): void {
    // ACK_INTERVAL_MS ごとに受信位置を上流へ返す（congestion.md 2 節）。
    const now = Date.now();
    this.state = handleAckTimer(this.state, now, this.transport);
    void this.room.storage.setAlarm(now + ACK_INTERVAL_MS);
  }

  onConnect(connection: Party.Connection, context: Party.ConnectionContext): void {
    const role = roleFromUrl(context.request.url);
    // 最初の接続で ack の周期を始める。
    void this.room.storage.setAlarm(Date.now() + ACK_INTERVAL_MS);
    this.roles.set(connection.id, role);
    if (role === "client") {
      this.clientConnectionId = connection.id;
    }
  }

  onClose(connection: Party.Connection): void {
    if (this.clientConnectionId === connection.id) {
      this.clientConnectionId = null;
    }
    this.roles.delete(connection.id);
  }

  onMessage(message: string | ArrayBuffer, sender: Party.Connection): void {
    const now = Date.now();
    const role = this.roles.get(sender.id) ?? "client";
    if (typeof message === "string") {
      if (role === "client") {
        this.state = handleClientText(this.state, message, now, this.transport);
      }
      // 上流からの制御メッセージは現時点で扱う対象が無い。未知として無視する。
      return;
    }
    const bytes = new Uint8Array(message);
    if (role === "upstream") {
      this.state = handleUpstreamBinary(this.state, bytes, now, this.transport);
      return;
    }
    // 受信ノードはクライアントからのメディアを扱わない。形式違反のみ検出して閉じる。
    this.state = handleClientBinary(this.state, bytes, now, this.transport);
  }

  private withClient(action: (connection: Party.Connection) => void): void {
    if (this.clientConnectionId === null) {
      return;
    }
    const connection = this.room.getConnection(this.clientConnectionId);
    if (connection !== undefined && connection !== null) {
      action(connection);
    }
  }
}

/** 接続 URL から役割を読む。宣言が無ければクライアントとして扱う。 */
function roleFromUrl(url: string): Role {
  const marker = "role=upstream";
  return url.includes(marker) ? "upstream" : "client";
}

export default ReceiverNode;
