/**
 * MetaRoom（meta 部屋）の判断コア。
 *
 * sans-IO の純関数状態機械。規範:
 *   - room-naming.md 3 節（シャード数の算出）と 4 節（epoch の管理）
 *   - state-machines.md 5 節（epoch 移行。移行の実行は送信ノードの責務）
 *   - state-machines.md 6 節（会議のライフサイクル。CREATED / OPEN / LOCKED / ENDED）
 *
 * 不変条件:
 *   1. epoch は単調増加のみ
 *   2. シャード数は単調非減少（減らすと再配置が起きるため会議中は減らさない）
 *   3. ENDED は終端である。ENDED から他の状態へ戻らない
 */

import { shardCount } from "./naming.ts";
import { V_SHARD_MAX_PARTICIPANTS, MAX_UNEXPECTED_EVENTS } from "./generated/constants.ts";
import { type ErrorName } from "./generated/errors.ts";

/**
 * 会議の状態（state-machines.md 6 節）。
 * CREATED は「部屋は作られたが誰も繋いでいない」状態である。
 */
export type MeetingLifecycle = "CREATED" | "OPEN" | "LOCKED" | "ENDED";

export interface MetaState {
  /** 会議のライフサイクル。 */
  readonly lifecycle: MeetingLifecycle;
  /**
   * 参加者数の上限。**会議作成時に指定する**（auth.md 5 節）。
   * 0 以下は「指定なし」を表し、上限の判定を行わない。既定値をここで決めない理由は、
   * 会議の上限はシャードの収容上限とは別の概念であり、規範が作成時の指定に委ねているためである。
   */
  readonly capacity: number;
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
  /** 主催者が施錠する。新規参加を拒否する。 */
  | { readonly kind: "lock" }
  /** 主催者が解錠する。 */
  | { readonly kind: "unlock" }
  /** 主催者が会議を終了する。全参加者を切断する。 */
  | { readonly kind: "end" }
  | { readonly kind: "override"; readonly participantId: number; readonly shardIndex: number }
  | { readonly kind: "clearOverride"; readonly participantId: number };

export type MetaCommand =
  | { readonly kind: "epochChange"; readonly epoch: number; readonly shards: number }
  | { readonly kind: "publishOverrides"; readonly epoch: number }
  | { readonly kind: "notify"; readonly code: string }
  /** 参加者リストを配信する（state-machines.md 6 節の副作用）。 */
  | { readonly kind: "publishParticipants"; readonly participants: readonly number[] }
  /** 参加を拒否する。宛先は接続してきた参加者である。 */
  | { readonly kind: "reject"; readonly id: number; readonly code: ErrorName }
  /** 全参加者を切断する。 */
  | { readonly kind: "closeAll"; readonly code: ErrorName }
  /** 会議の終了を外部データベースへ記録する。 */
  | { readonly kind: "recordEnd" };

export interface MetaStepResult {
  readonly state: MetaState;
  readonly commands: readonly MetaCommand[];
}

/**
 * 初期状態。参加者上限は会議作成時に指定する（auth.md 5 節）。
 * 指定しない場合は 0（上限なし）とする。会議の上限を勝手に決めない。
 */
export function initialMetaState(capacity = 0): MetaState {
  return {
    lifecycle: "CREATED",
    capacity,
    participants: [],
    epoch: 1,
    shards: 1,
    overrides: [],
    unexpectedEvents: [],
  };
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
    case "lock":
      return handleLock(state);
    case "unlock":
      return handleUnlock(state);
    case "end":
      return handleEnd(state);
  }
}

/** 主催者による施錠。OPEN のときのみ効く（state-machines.md 6 節）。 */
function handleLock(state: MetaState): MetaStepResult {
  if (state.lifecycle !== "OPEN") {
    // 表に無い遷移は無視して記録する（AGENTS 5.4）。
    return {
      state: { ...state, unexpectedEvents: appendUnexpected(state.unexpectedEvents, "lock") },
      commands: [],
    };
  }
  return { state: { ...state, lifecycle: "LOCKED" }, commands: [] };
}

/** 主催者による解錠。LOCKED のときのみ効く。 */
function handleUnlock(state: MetaState): MetaStepResult {
  if (state.lifecycle !== "LOCKED") {
    return {
      state: { ...state, unexpectedEvents: appendUnexpected(state.unexpectedEvents, "unlock") },
      commands: [],
    };
  }
  return { state: { ...state, lifecycle: "OPEN" }, commands: [] };
}

/**
 * 主催者による終了。OPEN と LOCKED から ENDED へ移る。
 * ENDED は終端であり、参加者リストは空にする（残すと退出の順序で状態が変わる）。
 */
function handleEnd(state: MetaState): MetaStepResult {
  if (state.lifecycle !== "OPEN" && state.lifecycle !== "LOCKED") {
    return {
      state: { ...state, unexpectedEvents: appendUnexpected(state.unexpectedEvents, "end") },
      commands: [],
    };
  }
  return {
    state: { ...state, lifecycle: "ENDED", participants: [] },
    commands: [{ kind: "closeAll", code: "E_MEETING_ENDED" }, { kind: "recordEnd" }],
  };
}

function handleJoin(state: MetaState, id: number): MetaStepResult {
  // 終了した会議への接続は拒否する（state-machines.md 6 節）。
  if (state.lifecycle === "ENDED") {
    return { state, commands: [{ kind: "reject", id, code: "E_MEETING_ENDED" }] };
  }
  // 施錠中は新規参加を拒否する。既に居る参加者の再接続は拒否しない。
  if (state.lifecycle === "LOCKED" && !state.participants.includes(id)) {
    return { state, commands: [{ kind: "reject", id, code: "E_MEETING_LOCKED" }] };
  }
  if (state.participants.includes(id)) {
    return { state, commands: [] };
  }
  // 上限に達していれば拒否する。判定は「追加する前の人数」で行う。
  // capacity が 0 以下のときは指定なしであり、判定しない。
  if (state.capacity > 0 && state.participants.length >= state.capacity) {
    return { state, commands: [{ kind: "reject", id, code: "E_ROOM_FULL" }] };
  }
  const participants = [...state.participants, id].sort((a, b) => a - b);
  // 最初の参加者で CREATED から OPEN へ移る。
  const lifecycle: MeetingLifecycle = state.lifecycle === "CREATED" ? "OPEN" : state.lifecycle;
  const recomputed = recomputeShards({ ...state, participants, lifecycle });
  return {
    state: recomputed.state,
    // 参加者リストの配信は join のたびに行う（6 節の副作用）。
    commands: [...recomputed.commands, { kind: "publishParticipants", participants }],
  };
}

function handleLeave(state: MetaState, id: number): MetaStepResult {
  const participants = state.participants.filter((entry) => entry !== id);
  if (participants.length === state.participants.length) {
    return { state, commands: [] };
  }
  // 退出でシャード数を減らさない。減らすと再配置が起き、会議中の品質が落ちる
  // （room-naming.md 3 節。シャード数は単調非減少）。
  const overrides = state.overrides.filter((entry) => entry.participantId !== id);
  // 全員が退出したら会議は終了する（state-machines.md 6 節）。
  if (participants.length === 0 && (state.lifecycle === "OPEN" || state.lifecycle === "LOCKED")) {
    return {
      state: { ...state, participants, overrides, lifecycle: "ENDED" },
      commands: [{ kind: "recordEnd" }],
    };
  }
  return {
    state: { ...state, participants, overrides },
    commands: [{ kind: "publishParticipants", participants }],
  };
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
      state: { ...state, unexpectedEvents: appendUnexpected(state.unexpectedEvents, "shardCount") },
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
      state: { ...state, unexpectedEvents: appendUnexpected(state.unexpectedEvents, "override") },
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

/**
 * 表に無いイベントの記録に 1 件加える。**上限を超えたら古い側を捨てる。**
 * 上限が無いと記録が無制限に伸び、Durable Object の記憶（128 MB。F-006）を食う。
 */
function appendUnexpected(events: readonly string[], name: string): readonly string[] {
  const appended = [...events, name];
  return appended.length > MAX_UNEXPECTED_EVENTS
    ? appended.slice(appended.length - MAX_UNEXPECTED_EVENTS)
    : appended;
}
