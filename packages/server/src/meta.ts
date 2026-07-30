/**
 * MetaRoom（meta 部屋）の Durable Object 入口。
 *
 * 判断は書かない。責務は接続と配信という副作用の扱いのみである。
 * PartyKit は既定輸出のクラスを要求するため、本ファイルのみ既定輸出を用いる
 * （lint-policy.md 9.4 の例外）。
 *
 * 接続元は制御ノードと送信・受信ノードである。クライアントは直結できない
 * （auth.md 3.4。個人部屋のみ許可される）。
 */

import type * as Party from "partykit/server";

import {
  initialMetaState,
  metaStep,
  type MetaCommand,
  type MetaEvent,
  type MetaState,
} from "@wheso/core/src/meta-core.ts";
import { ERROR_DEFINITIONS } from "@wheso/core/src/generated/errors.ts";
import { deriveMeetingSecret } from "@wheso/core/src/auth.ts";
import {
  buildNodeHelloAck,
  createNodeGateState,
  forgetNode,
  isNodeAuthenticated,
  markNodeAuthenticated,
  parseNodeHello,
  verifyNodeHello,
  type NodeGateState,
} from "./node-auth.ts";

export class MetaNode implements Party.Server {
  private state: MetaState;

  /** ノード間認証の関門。クライアントは直結できない（auth.md 3.4）。 */
  private gate: NodeGateState = createNodeGateState();

  /**
   * 会議全体の参加者名簿。
   *
   * **なぜ meta が持つか。** `ctl` 部屋は 1 利用者に 1 個である（`ctl-<会議 ID>-<利用者 ID>`）。
   * したがって `ctl` は自分以外の参加者を知らない。名簿を持てるのは会議に 1 個しかない
   * 部屋、すなわち `meta` だけである。ここが無いと**誰も他の参加者を知らず、購読が始まらない**。
   *
   * 名簿は判断ではないため判断コア（`meta-core`）には置かない。コアが持つのは人数と
   * epoch の決定である。
   */
  private readonly directory = new Map<string, { readonly senderId: number; readonly role: string }>();

  constructor(readonly room: Party.Room) {
    // 参加者数の上限は会議作成時に指定する（auth.md 5 節）。環境変数で与える。
    // 与えられない場合は 0（指定なし）とし、人数では拒否しない。
    this.state = initialMetaState(capacityOf(room));
  }

  onClose(connection: Party.Connection): void {
    this.gate = forgetNode(this.gate, connection.id);
  }

  /**
   * 名簿の登録と取得（HTTP）。
   *
   * **なぜ WebSocket ではなく要求応答にするか。** ノード間の WebSocket（`stub.socket()`）は
   * 相手の応答を必要とする握手であり、`onMessage` の中で待つと自分の入力ゲートが閉じたまま
   * 完了しない。待たずに背後で進めると、入力の無い部屋（`ctl` は心拍しか来ない）では
   * 停止して中断される。名簿は join / leave のときだけ動く低頻度の情報であるため、
   * 要求応答で確実に扱う（F-046）。
   *
   * 認証は WebSocket と同じ `nodeHello` の HMAC を頭部で受ける。**認証の無い経路を
   * 開けてはならない**（部屋は外から到達可能である）。
   */
  async onRequest(request: Party.Request): Promise<Response> {
    const role = request.headers.get("x-wheso-node-role");
    const tag = request.headers.get("x-wheso-node-auth");
    if (role === null || tag === null) {
      return new Response(JSON.stringify({ t: "error", code: "E_NODE_AUTH" }), { status: 401 });
    }
    const verified = await this.verifyTag(role, tag);
    if (!verified) {
      return new Response(JSON.stringify({ t: "error", code: "E_NODE_AUTH" }), { status: 401 });
    }
    const body = await request.text();
    const entry = parseRegister(body);
    if (entry !== null) {
      if (entry.kind === "register") {
        this.directory.set(entry.userId, { senderId: entry.senderId, role: entry.role });
      } else {
        this.directory.delete(entry.userId);
      }
      this.publishDirectory();
    } else {
      const event = parseEvent(body);
      if (event !== null) {
        const result = metaStep(this.state, event);
        this.state = result.state;
        for (const command of result.commands) {
          this.publish(command);
        }
      }
    }
    // 現在の名簿を返す。要求した `ctl` はこれを自分の利用者へ配る。
    return new Response(this.directoryMessage(), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  /** 頭部の認証タグを検証する（WebSocket の `nodeHello` と同じ算出）。 */
  private async verifyTag(role: string, tag: string): Promise<boolean> {
    const nodeKey = this.room.env["WHESO_NODE_KEY"];
    if (typeof nodeKey !== "string" || nodeKey.length === 0) {
      return false;
    }
    const meetingId = this.room.id.startsWith("meta-") ? this.room.id.slice("meta-".length) : "";
    if (meetingId.length === 0) {
      return false;
    }
    const secret = await deriveMeetingSecret(new TextEncoder().encode(nodeKey), meetingId);
    if (!secret.ok) {
      return false;
    }
    const parsed = parseNodeHello(
      JSON.stringify({ t: "nodeHello", role, nodeId: this.room.id, authTag: tag }),
    );
    if (!parsed.ok) {
      return false;
    }
    const result = await verifyNodeHello({
      meetingSecret: secret.value,
      targetRoomName: this.room.id,
      hello: parsed.value,
      nowSec: Math.trunc(Date.now() / 1000),
    });
    return result.ok;
  }

  async onMessage(message: string | ArrayBuffer, sender: Party.Connection): Promise<void> {
    if (typeof message !== "string") {
      // meta 部屋にメディアは来ない。無視する（未知は閉じない）。
      return;
    }

    // ノードの名乗りを先に見る。**認証していない接続からは何も受け付けない。**
    const hello = parseNodeHello(message);
    if (hello.ok) {
      await this.authenticateNode(hello.value.role, hello.value.authTag, sender);
      return;
    }
    if (!isNodeAuthenticated(this.gate, sender.id)) {
      sender.close(ERROR_DEFINITIONS.E_NODE_AUTH.closeCode, "E_NODE_AUTH");
      return;
    }

    // 名簿の更新。参加者一覧を会議全体へ配る。
    const entry = parseRegister(message);
    if (entry !== null) {
      if (entry.kind === "register") {
        this.directory.set(entry.userId, { senderId: entry.senderId, role: entry.role });
      } else {
        this.directory.delete(entry.userId);
      }
      this.publishDirectory();
      return;
    }

    const event = parseEvent(message);
    if (event === null) {
      return;
    }
    const result = metaStep(this.state, event);
    this.state = result.state;
    for (const command of result.commands) {
      this.publish(command);
    }
  }

  /** `nodeHello` の HMAC を検証する。 */
  private async authenticateNode(role: string, authTag: string, sender: Party.Connection): Promise<void> {
    const nodeKey = this.room.env["WHESO_NODE_KEY"];
    if (typeof nodeKey !== "string" || nodeKey.length === 0) {
      sender.close(ERROR_DEFINITIONS.E_NODE_AUTH.closeCode, "node key missing");
      return;
    }
    // 部屋名は `meta-<会議 ID>` である（room-naming.md 1 節）。
    const meetingId = this.room.id.startsWith("meta-") ? this.room.id.slice("meta-".length) : null;
    if (meetingId === null || meetingId.length === 0) {
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
    sender.send(buildNodeHelloAck(this.room.id));
    // 名乗った直後に現在の名簿を渡す。渡さないと後から参加した側が既存の参加者を知らない。
    sender.send(this.directoryMessage());
  }

  /** 名簿を全接続（各利用者の `ctl`）へ配る。 */
  private publishDirectory(): void {
    this.room.broadcast(this.directoryMessage());
  }

  private directoryMessage(): string {
    // 反復順序を決定的にする（利用者 ID の昇順）。
    const entries = [...this.directory.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([userId, value]) => ({ userId, senderId: value.senderId, role: value.role }));
    return JSON.stringify({ t: "participants", entries });
  }

  /** 出力コマンドを全接続へ配信する。ノードは自分の割当先を決定論的に計算する。 */
  private publish(command: MetaCommand): void {
    switch (command.kind) {
      case "epochChange":
        this.room.broadcast(
          JSON.stringify({ t: "epochChange", epoch: command.epoch, shards: command.shards }),
        );
        return;
      case "publishOverrides":
        this.room.broadcast(
          JSON.stringify({
            t: "overrides",
            epoch: command.epoch,
            entries: this.state.overrides.map((entry) => ({
              participantId: entry.participantId,
              shardIndex: entry.shardIndex,
            })),
          }),
        );
        return;
      case "notify":
        this.room.broadcast(JSON.stringify({ t: "nodeStatus", code: command.code }));
        return;
      case "publishParticipants":
        this.room.broadcast(
          JSON.stringify({ t: "participants", participants: [...command.participants] }),
        );
        return;
      case "reject":
        // 拒否は接続してきた参加者へ届ける。どの接続かはノードが id で対応させるため、
        // 対象を明示した通知として配信する（meta へはノードのみが繋ぐ。auth.md 3.4）。
        this.room.broadcast(
          JSON.stringify({ t: "reject", id: command.id, code: command.code }),
        );
        return;
      case "closeAll":
        // 会議の終了。規範のクローズコードで全接続を閉じる（errors.md）。
        for (const connection of this.room.getConnections()) {
          connection.close(ERROR_DEFINITIONS[command.code].closeCode, command.code);
        }
        return;
      case "recordEnd":
        // 外部データベースへの記録は本ノードの責務ではない（制御系が受け取って行う）。
        // ここでは通知に留める。ノード内に会議の履歴を溜めない（何も記録しない方針）。
        this.room.broadcast(JSON.stringify({ t: "meetingEnded" }));
        return;
    }
  }
}

/** 名簿の更新。`ctl` が自分の利用者を登録・解除する。未知の形式は null。 */
function parseRegister(
  text: string,
): { readonly kind: "register" | "unregister"; readonly userId: string; readonly senderId: number; readonly role: string } | null {
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record: Record<string, unknown> = { ...value };
  const t = record["t"];
  if (t !== "register" && t !== "unregister") {
    return null;
  }
  const userId = record["userId"];
  const senderId = record["senderId"];
  const role = record["role"];
  if (typeof userId !== "string" || userId.length === 0) {
    return null;
  }
  if (t === "unregister") {
    return { kind: "unregister", userId, senderId: 0, role: "viewer" };
  }
  if (!isInteger(senderId) || typeof role !== "string") {
    return null;
  }
  return { kind: "register", userId, senderId, role };
}

/** 会議の参加者上限を環境から読む。数値でなければ 0（指定なし）とする。 */
function capacityOf(room: Party.Room): number {
  const raw = room.env["WHESO_MEETING_CAPACITY"];
  if (typeof raw !== "string") {
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** 制御メッセージを入力イベントへ翻訳する。未知の `t` は null。 */
function parseEvent(text: string): MetaEvent | null {
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record: Record<string, unknown> = { ...value };
  const t = record["t"];
  const id = record["id"];
  const participantId = record["participantId"];
  const shardIndex = record["shardIndex"];
  if (t === "join" && isInteger(id)) {
    return { kind: "join", id };
  }
  if (t === "leave" && isInteger(id)) {
    return { kind: "leave", id };
  }
  if (t === "override" && isInteger(participantId) && isInteger(shardIndex)) {
    return { kind: "override", participantId, shardIndex };
  }
  if (t === "clearOverride" && isInteger(participantId)) {
    return { kind: "clearOverride", participantId };
  }
  // 会議のライフサイクル（state-machines.md 6 節）。主催者の操作は制御系が中継する。
  if (t === "lock") {
    return { kind: "lock" };
  }
  if (t === "unlock") {
    return { kind: "unlock" };
  }
  if (t === "end") {
    return { kind: "end" };
  }
  return null;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

export default MetaNode;
