/**
 * 送信ノード（sender）の Durable Object 入口。
 *
 * 判断は書かない。責務は接続・時刻・アラームという副作用の扱いのみである。
 * PartyKit は既定輸出のクラスを要求するため、本ファイルのみ既定輸出を用いる
 * （lint-policy.md 9.4 の例外）。
 *
 * 接続の区別:
 *   - `role=client`（既定）… 送信側クライアント。メディアと streamAnnounce を送ってくる
 *   - `role=shard&peer=1|2` … 割当先シャードへの接続。ack と新 epoch のフレームが来る
 */

import type * as Party from "partykit/server";

import {
  createSenderHandlerState,
  handleClientMedia,
  handleClientText,
  handleNewEpochFrame,
  handleTimer,
  handleUpstreamText,
  type SenderHandlerState,
  type SenderTransport,
} from "./sender-handler.ts";
import { SHARD_PEER_CURRENT, SHARD_PEER_NEXT } from "@wheso/core/src/sender-core.ts";

type Role = { readonly kind: "client" } | { readonly kind: "shard"; readonly peer: number };

export class SenderNode implements Party.Server {
  private state: SenderHandlerState;

  private readonly roles = new Map<string, Role>();

  private readonly transport: SenderTransport;

  /** 新 epoch から最初のフレームを受けたかどうか。二重購読の終了判定に使う。 */
  private sawNewEpochFrame = false;

  constructor(readonly room: Party.Room) {
    this.state = createSenderHandlerState(1);
    this.transport = {
      sendToShard: (peer, bytes) => {
        this.eachShard(peer, (connection) => connection.send(bytes));
      },
      sendTextToShard: (peer, text) => {
        this.eachShard(peer, (connection) => connection.send(text));
      },
      connectShard: (peer) => {
        // 新しい epoch のシャードへの接続は入口が張る。実際の接続確立は
        // PartyKit の room.context.parties 経由で行うため、ここでは意図を記録し
        // クライアントへ通知する。接続の実体は control ノードの実装時に置き換える。
        this.room.broadcast(JSON.stringify({ t: "shardConnect", peer }));
      },
      disconnectShard: (peer) => {
        this.eachShard(peer, (connection) => connection.close(1000, "epoch migration"));
      },
      closeClient: (code, reason) => {
        for (const [id, role] of this.roles) {
          if (role.kind !== "client") {
            continue;
          }
          const connection = this.room.getConnection(id);
          if (connection !== undefined && connection !== null) {
            connection.close(code, reason);
          }
        }
      },
      notifyControl: (code) => {
        this.room.broadcast(JSON.stringify({ t: "nodeStatus", code }));
      },
      scheduleAt: (atMs) => {
        // 二重購読の時限は入口のアラームで起こす。コアは時刻を取得しない。
        void this.room.storage.setAlarm(atMs);
      },
    };
  }

  onConnect(connection: Party.Connection, context: Party.ConnectionContext): void {
    this.roles.set(connection.id, roleFromUrl(context.request.url));
  }

  onClose(connection: Party.Connection): void {
    this.roles.delete(connection.id);
  }

  onMessage(message: string | ArrayBuffer, sender: Party.Connection): void {
    const now = Date.now();
    const role = this.roles.get(sender.id) ?? { kind: "client" as const };

    if (typeof message === "string") {
      this.state =
        role.kind === "client"
          ? handleClientText(this.state, message, now, this.transport)
          : handleUpstreamText(this.state, message, now, this.transport);
      return;
    }

    if (role.kind === "shard") {
      // 新 epoch のシャードからフレームが届いたら二重購読を終える（state-machines.md 5 節）。
      if (role.peer === SHARD_PEER_NEXT && !this.sawNewEpochFrame) {
        this.sawNewEpochFrame = true;
        this.state = handleNewEpochFrame(this.state, now, this.transport);
      }
      return;
    }

    this.state = handleClientMedia(this.state, new Uint8Array(message), now, this.transport);
  }

  onAlarm(): void {
    this.state = handleTimer(this.state, Date.now(), this.transport);
  }

  private eachShard(peer: number, action: (connection: Party.Connection) => void): void {
    for (const [id, role] of this.roles) {
      if (role.kind !== "shard" || role.peer !== peer) {
        continue;
      }
      const connection = this.room.getConnection(id);
      if (connection !== undefined && connection !== null) {
        action(connection);
      }
    }
  }
}

/** 接続 URL から役割を読む。宣言が無ければクライアントとして扱う。 */
function roleFromUrl(url: string): Role {
  if (!url.includes("role=shard")) {
    return { kind: "client" };
  }
  return { kind: "shard", peer: url.includes("peer=2") ? SHARD_PEER_NEXT : SHARD_PEER_CURRENT };
}

export default SenderNode;
