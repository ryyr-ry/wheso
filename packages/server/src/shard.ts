/**
 * 中継ノード（shard）の Durable Object 入口。
 *
 * ここには判断を書かない。責務は 3 つに限る。
 *   1. 接続と時刻という副作用を扱う
 *   2. 参加者 ID と接続 ID の対応を持つ
 *   3. shard-handler へ委ね、返された送信を実行する
 *
 * PartyKit は既定輸出のクラスを要求するため、本ファイルのみ既定輸出を用いる
 * （lint-policy.md 5 節の例外）。判断を持つコードは名前付き輸出のみである。
 *
 * 時刻の扱い: Date.now() はメッセージ受信ごとに更新される。I/O が無い間は進まない
 * （evidence F-020、F-021）。したがって時刻は「イベントを受け取った瞬間」にのみ読み、
 * 判断コアへ入力として渡す。コアの内部では時刻を取得しない。
 */

import type * as Party from "partykit/server";

import {
  createShardHandlerState,
  handleBinary,
  handleLifecycle,
  handleText,
  handleTimer,
  type ShardHandlerState,
  type ShardPeer,
  type ShardTransport,
} from "./shard-handler.ts";

/** 接続 ID から参加者 ID を得る。参加者 ID は 32bit の正の整数である（wire-format.md 1.1）。 */
function participantIdOf(connectionId: string): number {
  // 接続 ID は文字列である。数値の参加者 ID を持つのは hello 以後だが、
  // 中継ノードはノード間接続を主とするため、接続 ID の数値表現をそのまま使う。
  const parsed = Number.parseInt(connectionId, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export class ShardNode implements Party.Server {
  private state: ShardHandlerState;

  private readonly transport: ShardTransport;

  constructor(readonly room: Party.Room) {
    this.state = createShardHandlerState(Date.now());
    this.transport = {
      sendBinary: (participantId, bytes) => {
        const connection = this.room.getConnection(String(participantId));
        if (connection !== undefined && connection !== null) {
          connection.send(bytes);
        }
      },
      sendText: (participantId, text) => {
        const connection = this.room.getConnection(String(participantId));
        if (connection !== undefined && connection !== null) {
          connection.send(text);
        }
      },
      close: (participantId, code, reason) => {
        const connection = this.room.getConnection(String(participantId));
        if (connection !== undefined && connection !== null) {
          connection.close(code, reason);
        }
      },
      notifyControl: (code) => {
        // 制御系への通知は全接続への制御メッセージとして送る。
        // ctl 部屋への直接接続は control ノードの実装後に置き換える。
        this.room.broadcast(JSON.stringify({ t: "nodeStatus", code }));
      },
    };
  }

  onConnect(connection: Party.Connection): void {
    const peer = this.peerOf(connection);
    this.state = handleLifecycle(this.state, peer, "open", Date.now(), this.transport);
  }

  onClose(connection: Party.Connection): void {
    const peer = this.peerOf(connection);
    this.state = handleLifecycle(this.state, peer, "close", Date.now(), this.transport);
  }

  onMessage(message: string | ArrayBuffer, sender: Party.Connection): void {
    const now = Date.now();
    const peer = this.peerOf(sender);
    if (typeof message === "string") {
      this.state = handleText(this.state, peer, message, now, this.transport);
      return;
    }
    this.state = handleBinary(this.state, peer, new Uint8Array(message), now, this.transport);
  }

  onAlarm(): void {
    // 回復方向の遷移は送信が止まった状態でも起きる必要がある（state-machines.md 3 節）。
    this.state = handleTimer(this.state, Date.now(), this.transport);
  }

  private peerOf(connection: Party.Connection): ShardPeer {
    return { participantId: participantIdOf(connection.id), isNode: false };
  }
}

export default ShardNode;
