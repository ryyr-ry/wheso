/**
 * PartyKit の主入口。
 *
 * 主入口は会議の入口として使う。役割ごとの部屋は `partykit.json` の `parties` に定義し、
 * それぞれ別のファイルが担う（shard / receiver / sender / control / meta）。
 *
 * ここには判断を書かない。HTTP の応答と健全性の確認のみを扱う。
 * PartyKit は既定輸出のクラスを要求するため、本ファイルのみ既定輸出を用いる
 * （lint-policy.md 9.4 の例外）。
 */

import type * as Party from "partykit/server";

import { PROTOCOL_VERSION } from "@wheso/core/src/generated/wire-layout.ts";

export class MainNode implements Party.Server {
  constructor(readonly room: Party.Room) {}

  /**
   * 健全性の確認に応える。
   * 実装の有無を外から確かめられるようにするためであり、会議の情報は返さない。
   */
  onRequest(): Response {
    return new Response(JSON.stringify({ t: "health", protocolVersion: PROTOCOL_VERSION }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}

export default MainNode;
