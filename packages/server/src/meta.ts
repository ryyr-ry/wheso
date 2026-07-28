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

export class MetaNode implements Party.Server {
  private state: MetaState;

  constructor(readonly room: Party.Room) {
    // 参加者数の上限は会議作成時に指定する（auth.md 5 節）。環境変数で与える。
    // 与えられない場合は 0（指定なし）とし、人数では拒否しない。
    this.state = initialMetaState(capacityOf(room));
  }

  onMessage(message: string | ArrayBuffer, sender: Party.Connection): void {
    if (typeof message !== "string") {
      // meta 部屋にメディアは来ない。無視する（未知は閉じない）。
      void sender;
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
