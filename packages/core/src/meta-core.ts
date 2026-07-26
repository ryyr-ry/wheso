/**
 * MetaRoom（meta 部屋）の判断コア。
 *
 * sans-IO の純関数状態機械。規範:
 *   - room-naming.md 3 節（シャード数の算出）と 4 節（epoch の管理）
 *   - state-machines.md 5 節（epoch 移行。移行の実行は送信ノードの責務）
 *
 * 不変条件:
 *   1. epoch は単調増加のみ
 *   2. シャード数は単調非減少（減らすと再配置が起きるため会議中は減らさない）
 */

import { shardCount } from "./naming.ts";
import { V_SHARD_MAX_PARTICIPANTS } from "./generated/constants.ts";

export interface MetaState {
  /** 参加者 ID。昇順で保持する。反復順序が算出に影響するため決定的にする。 */
  readonly participants: readonly number[];
  /** 現在の epoch。1 から始まり単調増加する。 */
  readonly epoch: number;
  /** 現在のシャード数。単調非減少である。 */
  readonly shards: number;
  /** 容量均衡のための上書き表。参加者 ID からシャード番号へ。昇順で保持する。 */
  readonly overrides: readonly { readonly participantId: number; readonly shardIndex: number }[];
  /** 表に無いイベントの記録。 */
  readonly unexpectedEvents: readonly string[];
}

export type MetaEvent =
  | { readonly kind: "join"; readonly id: number }
  | { readonly kind: "leave"; readonly id: number }
  | { readonly kind: "override"; readonly participantId: number; readonly shardIndex: number }
  | { readonly kind: "clearOverride"; readonly participantId: number };

export type MetaCommand =
  | { readonly kind: "epochChange"; readonly epoch: number; readonly shards: number }
  | { readonly kind: "publishOverrides"; readonly epoch: number }
  | { readonly kind: "notify"; readonly code: string };

export interface MetaStepResult {
  readonly state: MetaState;
  readonly commands: readonly MetaCommand[];
}

export function initialMetaState(): MetaState {
  return { participants: [], epoch: 1, shards: 1, overrides: [], unexpectedEvents: [] };
}

export function metaStep(state: MetaState, event: MetaEvent): MetaStepResult {
  switch (event.kind) {
    case "join":
      return handleJoin(state, event.id);
    case "leave":
      return handleLeave(state, event.id);
    case "override":
      return handleOverride(state, event.participantId, event.shardIndex);
    case "clearOverride":
      return handleClearOverride(state, event.participantId);
  }
}

function handleJoin(state: MetaState, id: number): MetaStepResult {
  if (state.participants.includes(id)) {
    return { state, commands: [] };
  }
  const participants = [...state.participants, id].sort((a, b) => a - b);
  return recomputeShards({ ...state, participants });
}

function handleLeave(state: MetaState, id: number): MetaStepResult {
  const participants = state.participants.filter((entry) => entry !== id);
  if (participants.length === state.participants.length) {
    return { state, commands: [] };
  }
  // 退出でシャード数を減らさない。減らすと再配置が起き、会議中の品質が落ちる
  // （room-naming.md 3 節。シャード数は単調非減少）。
  const overrides = state.overrides.filter((entry) => entry.participantId !== id);
  return { state: { ...state, participants, overrides }, commands: [] };
}

/**
 * 参加者数からシャード数を再計算する。
 *
 * 増える場合のみ epoch を上げる。epoch を部屋名に含めるため、
 * 異なるシャード数を前提としたノードが同じ部屋に混在しない（room-naming.md 4 節）。
 */
function recomputeShards(state: MetaState): MetaStepResult {
  const computed = shardCount(state.participants.length, V_SHARD_MAX_PARTICIPANTS, state.shards);
  if (!computed.ok) {
    return {
      state: { ...state, unexpectedEvents: [...state.unexpectedEvents, "shardCount"] },
      commands: [{ kind: "notify", code: computed.error.code }],
    };
  }
  if (computed.value <= state.shards) {
    return { state, commands: [] };
  }
  const epoch = state.epoch + 1;
  return {
    state: { ...state, shards: computed.value, epoch },
    commands: [{ kind: "epochChange", epoch, shards: computed.value }],
  };
}

/** 上書き表の登録。範囲外の指定は拒否する（設定の誤りを隠蔽しない）。 */
function handleOverride(state: MetaState, participantId: number, shardIndex: number): MetaStepResult {
  if (shardIndex < 0 || shardIndex >= state.shards) {
    // room-naming.md 3 節: 範囲外は Rendezvous の結果へ落とさず拒否する。
    return {
      state: { ...state, unexpectedEvents: [...state.unexpectedEvents, "override"] },
      commands: [{ kind: "notify", code: "E_NAME_SHARD_INDEX" }],
    };
  }
  const rest = state.overrides.filter((entry) => entry.participantId !== participantId);
  const overrides = [...rest, { participantId, shardIndex }].sort(
    (a, b) => a.participantId - b.participantId,
  );
  return { state: { ...state, overrides }, commands: [{ kind: "publishOverrides", epoch: state.epoch }] };
}

function handleClearOverride(state: MetaState, participantId: number): MetaStepResult {
  const overrides = state.overrides.filter((entry) => entry.participantId !== participantId);
  if (overrides.length === state.overrides.length) {
    return { state, commands: [] };
  }
  return { state: { ...state, overrides }, commands: [{ kind: "publishOverrides", epoch: state.epoch }] };
}
