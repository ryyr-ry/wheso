/**
 * ノード間認証（nodeHello）。
 *
 * 規範: wire-format.md 2.8（nodeHello の形式）、errors.md 3.1（HMAC の算出）、auth.md。
 *
 * なぜ必要か: 部屋名は決定論的であるため、認証を省いたノードは第三者から接続できる。
 * クライアントは個人部屋にしか繋げないが（auth.md 3.4）、中継部屋や MetaRoom は
 * ノード間接続を受けるため、ノード側の認証が無いと外部から media を注入できる。
 *
 * `nodeHello` を受け取る前に届いたメディアメッセージは破棄する（wire-format.md 2.8）。
 */

import { nodeAuthTimeWindow, verifyNodeAuthTag } from "@wheso/core/src/auth.ts";
import { ERROR_DEFINITIONS } from "@wheso/core/src/generated/errors.ts";
import { type Result, err, ok } from "@wheso/core/src/result.ts";

/** ノードの役割（wire-format.md 2.8）。 */
export type NodeRole = "sender" | "receiver" | "shard" | "fanout" | "coordinator";

export interface NodeHello {
  readonly role: NodeRole;
  readonly nodeId: string;
  readonly authTag: string;
}

export interface NodeAuthError {
  readonly code: string;
  readonly closeCode: number;
  readonly detail: string;
}

function authError(detail: string): NodeAuthError {
  return {
    code: "E_NODE_AUTH",
    closeCode: ERROR_DEFINITIONS.E_NODE_AUTH.closeCode,
    detail,
  };
}

/** テキストから nodeHello を取り出す。形式違反は失敗として返す（例外を投げない）。 */
export function parseNodeHello(text: string): Result<NodeHello, NodeAuthError> {
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    return err(authError("JSON として解析できない"));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(authError("オブジェクトではない"));
  }
  const record: Record<string, unknown> = { ...value };
  if (record["t"] !== "nodeHello") {
    return err(authError("nodeHello ではない"));
  }
  const role = record["role"];
  const nodeId = record["nodeId"];
  const authTag = record["authTag"];
  if (!isNodeRole(role)) {
    return err(authError(`role が不正: ${String(role)}`));
  }
  if (typeof nodeId !== "string" || nodeId.length === 0) {
    return err(authError("nodeId が無い"));
  }
  if (typeof authTag !== "string" || authTag.length === 0) {
    return err(authError("authTag が無い"));
  }
  return ok({ role, nodeId, authTag });
}

function isNodeRole(value: unknown): value is NodeRole {
  return (
    value === "sender" || value === "receiver" || value === "shard" || value === "fanout" || value === "coordinator"
  );
}

export interface VerifyNodeOptions {
  /** 会議シークレット。会議ごとに導出される（auth.md 3.5）。 */
  readonly meetingSecret: Uint8Array;
  /** 接続先の部屋名。HMAC の入力である。 */
  readonly targetRoomName: string;
  readonly hello: NodeHello;
  readonly nowSec: number;
}

/**
 * nodeHello の HMAC を検証する。
 *
 * 現在の時刻窓と 1 つ前の窓を許す（境界での失敗を避けるため。auth.ts の実装に従う）。
 */
export async function verifyNodeHello(options: VerifyNodeOptions): Promise<Result<number, NodeAuthError>> {
  const verified = await verifyNodeAuthTag(
    options.meetingSecret,
    options.targetRoomName,
    options.hello.role,
    options.hello.authTag,
    options.nowSec,
  );
  if (!verified.ok) {
    return err(authError(verified.error.detail));
  }
  return ok(verified.value);
}

/** 現在の時刻窓。試験と送信側で使う。 */
export function currentNodeAuthWindow(nowSec: number): number {
  return nodeAuthTimeWindow(nowSec);
}

/** 接続ごとの認証状態。nodeHello を受けるまで media を受け付けない。 */
export interface NodeGateState {
  /** 認証済みの接続 ID と役割。 */
  readonly authenticated: readonly { readonly connectionId: string; readonly role: NodeRole }[];
  /** 認証前に届いて破棄したメディアの数。観測のために数える。 */
  readonly droppedBeforeHello: number;
}

export function createNodeGateState(): NodeGateState {
  return { authenticated: [], droppedBeforeHello: 0 };
}

/** 認証済みかどうか。 */
export function isNodeAuthenticated(state: NodeGateState, connectionId: string): boolean {
  return state.authenticated.some((entry) => entry.connectionId === connectionId);
}

/** 認証を記録する。接続 ID の昇順で保持する（決定性のため）。 */
export function markNodeAuthenticated(
  state: NodeGateState,
  connectionId: string,
  role: NodeRole,
): NodeGateState {
  const rest = state.authenticated.filter((entry) => entry.connectionId !== connectionId);
  const merged = [...rest, { connectionId, role }].sort((a, b) =>
    a.connectionId < b.connectionId ? -1 : a.connectionId > b.connectionId ? 1 : 0,
  );
  return { ...state, authenticated: merged };
}

/** 認証前に届いたメディアを破棄したことを記録する。 */
export function recordDroppedBeforeHello(state: NodeGateState): NodeGateState {
  return { ...state, droppedBeforeHello: state.droppedBeforeHello + 1 };
}

/** 接続が切れたときに認証を取り消す。 */
export function forgetNode(state: NodeGateState, connectionId: string): NodeGateState {
  return {
    ...state,
    authenticated: state.authenticated.filter((entry) => entry.connectionId !== connectionId),
  };
}
