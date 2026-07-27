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

import { deriveMeetingSecret } from "@wheso/core/src/auth.ts";
import { ERROR_DEFINITIONS } from "@wheso/core/src/generated/errors.ts";

import {
  createNodeGateState,
  forgetNode,
  isNodeAuthenticated,
  markNodeAuthenticated,
  parseNodeHello,
  recordDroppedBeforeHello,
  verifyNodeHello,
  type NodeGateState,
} from "./node-auth.ts";

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

/** 中継部屋の名前から会議 ID を取り出す。`vsh-<会議 ID>-<region>-<epoch>-<index>` の形である。 */
function meetingIdFromRoom(roomId: string): string | null {
  const parts = roomId.split("-");
  const meetingId = parts[1];
  return meetingId === undefined || meetingId.length === 0 ? null : meetingId;
}

/** 接続 ID から参加者 ID を得る。参加者 ID は 32bit の正の整数である（wire-format.md 1.1）。 */
function participantIdOf(connectionId: string): number {
  // 接続 ID は文字列である。数値の参加者 ID を持つのは hello 以後だが、
  // 中継ノードはノード間接続を主とするため、接続 ID の数値表現をそのまま使う。
  const parsed = Number.parseInt(connectionId, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export class ShardNode implements Party.Server {
  private state: ShardHandlerState;

  /**
   * ノード間認証の関門。
   * 部屋名は決定論的であるため、認証が無ければ第三者がメディアを注入できる
   * （wire-format.md 2.8、auth.md）。nodeHello を受けるまでメディアを受け付けない。
   */
  private gate: NodeGateState = createNodeGateState();

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
    this.gate = forgetNode(this.gate, connection.id);
    this.state = handleLifecycle(this.state, peer, "close", Date.now(), this.transport);
  }

  async onMessage(message: string | ArrayBuffer, sender: Party.Connection): Promise<void> {
    const now = Date.now();
    const peer = this.peerOf(sender);

    if (typeof message === "string") {
      // nodeHello なら認証を試みる。それ以外は購読などの制御として扱う。
      const hello = parseNodeHello(message);
      if (hello.ok) {
        await this.authenticate(hello.value.role, hello.value.authTag, sender);
        return;
      }
      this.state = handleText(this.state, peer, message, now, this.transport);
      return;
    }

    // メディアは認証済みの接続からのみ受け付ける。
    // 認証前に届いたものは破棄する（wire-format.md 2.8）。
    if (!isNodeAuthenticated(this.gate, sender.id)) {
      this.gate = recordDroppedBeforeHello(this.gate);
      return;
    }
    this.state = handleBinary(this.state, peer, new Uint8Array(message), now, this.transport);
  }

  /** nodeHello の HMAC を検証し、通れば以後のメディアを受け付ける。 */
  private async authenticate(role: string, authTag: string, sender: Party.Connection): Promise<void> {
    const nodeKey = this.room.env["WHESO_NODE_KEY"];
    if (typeof nodeKey !== "string" || nodeKey.length === 0) {
      // 鍵が無い環境では認証できない。開いたままにしない。
      sender.close(ERROR_DEFINITIONS.E_NODE_AUTH.closeCode, "node key missing");
      return;
    }
    const meetingId = meetingIdFromRoom(this.room.id);
    if (meetingId === null) {
      sender.close(ERROR_DEFINITIONS.E_NAME_MEETING_ID.closeCode, "E_NAME_MEETING_ID");
      return;
    }
    const secret = await deriveMeetingSecret(new TextEncoder().encode(nodeKey), meetingId);
    if (!secret.ok) {
      sender.close(ERROR_DEFINITIONS.E_NODE_AUTH.closeCode, "secret derivation failed");
      return;
    }
    const parsed = parseNodeHello(JSON.stringify({ t: "nodeHello", role, nodeId: this.room.id, authTag }));
    if (!parsed.ok) {
      sender.close(parsed.error.closeCode, parsed.error.code);
      return;
    }
    const verified = await verifyNodeHello({
      meetingSecret: secret.value,
      targetRoomName: this.room.id,
      hello: parsed.value,
      nowSec: Math.trunc(Date.now() / 1000),
    });
    if (!verified.ok) {
      sender.close(verified.error.closeCode, verified.error.code);
      return;
    }
    this.gate = markNodeAuthenticated(this.gate, sender.id, parsed.value.role);
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
