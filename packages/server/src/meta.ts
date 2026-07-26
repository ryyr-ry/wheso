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

export class MetaNode implements Party.Server {
  private state: MetaState = initialMetaState();

  constructor(readonly room: Party.Room) {}

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
    }
  }
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
  return null;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

export default MetaNode;
