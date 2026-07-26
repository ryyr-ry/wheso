/**
 * 中継ノード（shard）の判断コア。
 *
 * sans-IO の純関数状態機械。時刻・乱数・浮動小数点・入出力・並行に触れない。
 * 規範: state-machines.md 3 節、conformance.md 4 節、wire-format.md 1.4。
 */

import {
  SHEDDING_HYSTERESIS_MS,
  NODE_MAX_OUT_BYTES_PER_SEC,
  NODE_MAX_OUT_MESSAGES_PER_SEC,
} from "./generated/constants.ts";

import { dropPriority } from "./wire.ts";

// --- Result 型 ---
// wire.ts が既に定義しているが、担当外ファイルを変更しないため独自に定義する。
// prng_fixed 担当が共通 Result を作成した場合はそちらへ移行する。

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T, E>(value: T): Result<T, E> {
  return { ok: true, value };
}

export function err<T, E>(error: E): Result<T, E> {
  return { ok: false, error };
}

// --- 輻輳状態 (state-machines.md 3 節) ---

export type CongestionState =
  | "NORMAL"
  | "SHEDDING_T2"
  | "SHEDDING_T1"
  | "SHEDDING_SPATIAL"
  | "KEY_ONLY";

// --- 入力イベント (conformance.md 4.2) ---

export interface MediaEvent {
  readonly kind: "media";
  readonly from: number;
  readonly ch: number;
  readonly sid: number;
  readonly tid: number;
  readonly key: boolean;
  readonly bytes: number;
  readonly flags: number;
}

export interface SubscribeEvent {
  readonly kind: "subscribe";
  readonly from: number;
  readonly to: number;
  readonly want: boolean;
  /** 購読者が要求する最大 spatialId（tier） */
  readonly maxSpatialId: number;
}

export interface JoinEvent {
  readonly kind: "join";
  readonly id: number;
}

export interface LeaveEvent {
  readonly kind: "leave";
  readonly id: number;
}

export interface LinkEvent {
  readonly kind: "link";
  readonly peer: number;
  readonly state: "up" | "down" | "failed";
}

export interface TimerEvent {
  readonly kind: "timer";
}

export interface BudgetEvent {
  readonly kind: "budget";
  readonly bytesPerSec: number;
}

export type ShardEvent =
  | MediaEvent
  | SubscribeEvent
  | JoinEvent
  | LeaveEvent
  | LinkEvent
  | TimerEvent
  | BudgetEvent;

// --- 出力コマンド (conformance.md 4.3) ---

export interface ForwardCommand {
  readonly kind: "forward";
  readonly to: readonly number[];
}

export interface DropCommand {
  readonly kind: "drop";
  readonly priority: number;
  readonly count: number;
}

export interface SetTierCommand {
  readonly kind: "setTier";
  readonly for: number;
  readonly tier: number;
}

export interface KeyframeRequestCommand {
  readonly kind: "keyframeRequest";
  readonly for: number;
}

export interface ConnectCommand {
  readonly kind: "connect";
  readonly peer: number;
}

export interface DisconnectCommand {
  readonly kind: "disconnect";
  readonly peer: number;
}

export interface ScheduleCommand {
  readonly kind: "schedule";
  readonly at: number;
}

export interface CloseCommand {
  readonly kind: "close";
  readonly code: number;
}

export type ShardCommand =
  | ForwardCommand
  | DropCommand
  | SetTierCommand
  | KeyframeRequestCommand
  | ConnectCommand
  | DisconnectCommand
  | ScheduleCommand
  | CloseCommand;

// --- 購読情報 ---

export interface Subscription {
  readonly subscriberId: number;
  readonly targetId: number;
  readonly maxSpatialId: number;
}

// --- 状態 ---

export interface ShardState {
  /** 現在の輻輳状態 */
  readonly congestion: CongestionState;
  /** 輻輳状態に遷移した時刻（ヒステリシス判定用） */
  readonly congestionEnteredAt: number;
  /** 参加者 ID の集合（昇順で保持） */
  readonly participants: readonly number[];
  /** 購読の一覧。(subscriberId, targetId) で一意 */
  readonly subscriptions: readonly Subscription[];
  /** 帯域予算 bytes/sec。budget イベントで更新される */
  readonly budgetBytesPerSec: number;
  /** 現フレームまでの累積送信バイト（1 秒窓のレート推定用） */
  readonly sentBytesInWindow: number;
  /** 現フレームまでの累積送信メッセージ（1 秒窓のレート推定用） */
  readonly sentMessagesInWindow: number;
  /** 窓の開始時刻 */
  readonly windowStartMs: number;
  /** 無視されたイベントの記録（W_UNEXPECTED_EVENT） */
  readonly unexpectedEvents: readonly string[];
}

// --- 初期状態 ---

export function initialState(t: number): ShardState {
  return {
    congestion: "NORMAL",
    congestionEnteredAt: t,
    participants: [],
    subscriptions: [],
    budgetBytesPerSec: NODE_MAX_OUT_BYTES_PER_SEC,
    sentBytesInWindow: 0,
    sentMessagesInWindow: 0,
    windowStartMs: t,
    unexpectedEvents: [],
  };
}

// --- ステップ関数 ---

export interface StepResult {
  readonly state: ShardState;
  readonly commands: readonly ShardCommand[];
}

/**
 * 純関数の状態遷移。
 * 入力イベントを受け取り、新しい状態と出力コマンド列を返す。
 */
export function step(state: ShardState, event: ShardEvent, t: number): StepResult {
  switch (event.kind) {
    case "media":
      return handleMedia(state, event, t);
    case "subscribe":
      return handleSubscribe(state, event, t);
    case "join":
      return handleJoin(state, event, t);
    case "leave":
      return handleLeave(state, event, t);
    case "link":
      return handleLink(state, event, t);
    case "timer":
      return handleTimer(state, t);
    case "budget":
      return handleBudget(state, event, t);
  }
}

// --- 内部: メディアイベント処理 ---

function handleMedia(state: ShardState, event: MediaEvent, t: number): StepResult {
  const commands: ShardCommand[] = [];

  // 窓のリセット（1 秒経過したら）
  const newState = maybeResetWindow(state, t);

  // 破棄優先順位を計算（wire.ts の dropPriority を再利用する）
  const priority = dropPriority(event.ch, event.flags);

  // 輻輳状態に応じた破棄判定
  const shouldDrop = shouldDropInCongestion(newState.congestion, event, priority);

  if (shouldDrop) {
    // 破棄する場合
    const p = priority !== null ? priority : 0;
    commands.push({ kind: "drop", priority: p, count: 1 });
    return { state: newState, commands };
  }

  // 転送先の決定: 購読者のうち tier（maxSpatialId）以下の spatialId を持つユニットのみ転送
  // 仕様に順序が無い場合は subscriberId の昇順とする（決定性のため）
  const targets: number[] = [];
  for (const sub of newState.subscriptions) {
    // 購読対象が送信者と一致し、かつユニットの spatialId が tier 以下
    if (sub.targetId === event.from && event.sid <= sub.maxSpatialId) {
      targets.push(sub.subscriberId);
    }
  }
  // 昇順に整列（決定性のため。仕様に順序指定が無い場合は昇順）
  targets.sort((a, b) => a - b);

  if (targets.length === 0) {
    // 転送先が無い場合はコマンドを出さない
    return { state: newState, commands };
  }

  // 予算超過の判定
  const msgCost = targets.length;
  const byteCost = targets.length * event.bytes;
  const updatedSent = newState.sentBytesInWindow + byteCost;
  const updatedMessages = newState.sentMessagesInWindow + msgCost;

  // 予算超過時は破棄順位の低いものから破棄する
  if (isOverBudget(updatedMessages, updatedSent, newState, t)) {
    // 破棄可能なユニットのみ破棄する（KEY と音声は破棄禁止）
    if (priority !== null) {
      commands.push({ kind: "drop", priority, count: 1 });
      return { state: newState, commands };
    }
    // 破棄禁止のユニットは転送する（KEY / 音声）
  }

  commands.push({ kind: "forward", to: targets });

  const stateAfterForward: ShardState = {
    ...newState,
    sentBytesInWindow: newState.sentBytesInWindow + byteCost,
    sentMessagesInWindow: newState.sentMessagesInWindow + msgCost,
  };

  return { state: stateAfterForward, commands };
}

// --- 内部: 購読イベント処理 ---

function handleSubscribe(state: ShardState, event: SubscribeEvent, _t: number): StepResult {
  if (event.want) {
    // 購読追加。既存の同一 (subscriberId, targetId) があれば更新
    const filtered = state.subscriptions.filter(
      (s) => !(s.subscriberId === event.from && s.targetId === event.to),
    );
    const newSub: Subscription = {
      subscriberId: event.from,
      targetId: event.to,
      maxSpatialId: event.maxSpatialId,
    };
    const newSubscriptions = [...filtered, newSub].sort(subscriptionOrder);
    return {
      state: { ...state, subscriptions: newSubscriptions },
      commands: [],
    };
  }
  // 購読解除
  const newSubscriptions = state.subscriptions.filter(
    (s) => !(s.subscriberId === event.from && s.targetId === event.to),
  );
  return {
    state: { ...state, subscriptions: newSubscriptions },
    commands: [],
  };
}

// --- 内部: 参加イベント処理 ---

function handleJoin(state: ShardState, event: JoinEvent, _t: number): StepResult {
  // 重複チェック
  if (state.participants.includes(event.id)) {
    return { state, commands: [] };
  }
  const newParticipants = [...state.participants, event.id].sort((a, b) => a - b);
  return {
    state: { ...state, participants: newParticipants },
    commands: [],
  };
}

// --- 内部: 退出イベント処理 ---

function handleLeave(state: ShardState, event: LeaveEvent, _t: number): StepResult {
  const newParticipants = state.participants.filter((id) => id !== event.id);
  // 退出者に関する購読も除去する
  const newSubscriptions = state.subscriptions.filter(
    (s) => s.subscriberId !== event.id && s.targetId !== event.id,
  );
  return {
    state: { ...state, participants: newParticipants, subscriptions: newSubscriptions },
    commands: [],
  };
}

// --- 内部: リンクイベント処理 ---

function handleLink(state: ShardState, _event: LinkEvent, _t: number): StepResult {
  // 中継ノードの輻輳状態機械にはリンクイベントの遷移が定義されていない。
  // state-machines.md 3 節の表に無いイベントは無視して記録する。
  return {
    state: {
      ...state,
      unexpectedEvents: [...state.unexpectedEvents, "link"],
    },
    commands: [],
  };
}

// --- 内部: タイマーイベント処理 ---

function handleTimer(state: ShardState, t: number): StepResult {
  // タイマーは輻輳遷移の再評価に使う可能性があるが、
  // state-machines.md 3 節の表にはタイマーによる遷移が定義されていない。
  // 窓のリセットのみ行う。
  const newState = maybeResetWindow(state, t);
  return { state: newState, commands: [] };
}

// --- 内部: 予算イベント処理 ---

function handleBudget(state: ShardState, event: BudgetEvent, t: number): StepResult {
  const commands: ShardCommand[] = [];
  const newState: ShardState = {
    ...state,
    budgetBytesPerSec: event.bytesPerSec,
  };

  // 予算更新に伴い輻輳状態の遷移を評価する
  const result = evaluateCongestionTransition(newState, t);
  if (result.commands.length > 0) {
    commands.push(...result.commands);
  }
  return { state: result.state, commands };
}

// --- 内部: 輻輳状態の遷移評価 ---
// state-machines.md 3 節の表に従う。
// util = 要求レート ÷ 予算。整数演算で交差乗算する。

function evaluateCongestionTransition(state: ShardState, t: number): StepResult {
  // ヒステリシス: 現状態に入ってから SHEDDING_HYSTERESIS_MS 以内は遷移しない
  const elapsed = t - state.congestionEnteredAt;
  if (elapsed < SHEDDING_HYSTERESIS_MS) {
    return { state, commands: [] };
  }

  // util の計算: sentMessagesInWindow / 窓の経過秒 / NODE_MAX_OUT_MESSAGES_PER_SEC
  // 交差乗算で比較する。
  // util > threshold  ⇔  sentMessages * 1000 > threshold_num * windowDuration * NODE_MAX / threshold_den
  // ここでは簡易的に: util = sentMessages * 1000 / (windowDuration * NODE_MAX)
  // 比較は全て交差乗算で行う。

  const windowDuration = t - state.windowStartMs;
  if (windowDuration <= 0) {
    return { state, commands: [] };
  }

  // 整数でのレート比較: util > X を判定する
  // util = sentMessages / (windowDuration_sec * MAX_MPS)
  //      = sentMessages * 1000 / (windowDuration * MAX_MPS)
  // util > X/10  ⇔  sentMessages * 1000 * 10 > X * windowDuration * MAX_MPS
  const sentMsgScaled = state.sentMessagesInWindow * 10000; // * 1000 * 10
  const maxMps = NODE_MAX_OUT_MESSAGES_PER_SEC;

  // util のスケールされた値: sentMessages * 10000
  // 閾値のスケールされた値: threshold * windowDuration * maxMps / 1（thresholdは10倍済み）
  // util > 0.9  ⇔ sentMsgScaled > 9 * windowDuration * maxMps
  // util > 1.0  ⇔ sentMsgScaled > 10 * windowDuration * maxMps
  // util > 1.1  ⇔ sentMsgScaled > 11 * windowDuration * maxMps
  // util > 1.2  ⇔ sentMsgScaled > 12 * windowDuration * maxMps
  // util < 0.8  ⇔ sentMsgScaled < 8 * windowDuration * maxMps
  // util < 0.85 ⇔ sentMsgScaled * 100 < 85 * windowDuration * maxMps * 100
  //             ... より正確に: sentMessages * 10000 * 20 < 17 * windowDuration * maxMps * 20
  //             簡略化: sentMessages * 200000 < 17 * windowDuration * maxMps * 20 は不要
  //             util < 0.85 ⇔ sentMsgScaled * 2 < 17 * windowDuration * maxMps

  const base = windowDuration * maxMps;

  const utilGt09 = sentMsgScaled > 9 * base;
  const utilGt10 = sentMsgScaled > 10 * base;
  const utilGt11 = sentMsgScaled > 11 * base;
  const utilGt12 = sentMsgScaled > 12 * base;
  const utilLt08 = sentMsgScaled < 8 * base;
  // util < 0.85: sentMsgScaled / base < 8.5 ⇔ sentMsgScaled * 2 < 17 * base
  const utilLt085 = sentMsgScaled * 2 < 17 * base;
  // util < 0.9: sentMsgScaled < 9 * base
  const utilLt09 = sentMsgScaled < 9 * base;
  // util < 1.0: sentMsgScaled < 10 * base
  const utilLt10 = sentMsgScaled < 10 * base;

  // maxTrend の入力は report イベントで来るが、shard の状態機械では
  // budget イベントと util のみで遷移を判定する（report は receiver の責務）。
  // state-machines.md 3 節の条件には maxTrend があるが、shard は util のみで判定する。
  // maxTrend 条件は「または」で結合されているため、util 条件のみで遷移可能。

  let newCongestion = state.congestion;
  const commands: ShardCommand[] = [];

  switch (state.congestion) {
    case "NORMAL":
      if (utilGt09) {
        newCongestion = "SHEDDING_T2";
      }
      break;
    case "SHEDDING_T2":
      if (utilGt10) {
        newCongestion = "SHEDDING_T1";
      } else if (utilLt08) {
        newCongestion = "NORMAL";
      }
      break;
    case "SHEDDING_T1":
      if (utilGt11) {
        newCongestion = "SHEDDING_SPATIAL";
      } else if (utilLt085) {
        newCongestion = "SHEDDING_T2";
      }
      break;
    case "SHEDDING_SPATIAL":
      if (utilGt12) {
        newCongestion = "KEY_ONLY";
      } else if (utilLt09) {
        newCongestion = "SHEDDING_T1";
      }
      break;
    case "KEY_ONLY":
      if (utilLt10) {
        newCongestion = "SHEDDING_SPATIAL";
      }
      break;
  }

  if (newCongestion !== state.congestion) {
    const newState: ShardState = {
      ...state,
      congestion: newCongestion,
      congestionEnteredAt: t,
    };
    return { state: newState, commands };
  }

  return { state, commands };
}

// --- 内部: 輻輳状態に応じた破棄判定 ---

function shouldDropInCongestion(
  congestion: CongestionState,
  event: MediaEvent,
  priority: number | null,
): boolean {
  // 破棄禁止のユニット（KEY / 音声）は常に転送する
  if (priority === null) {
    return false;
  }

  switch (congestion) {
    case "NORMAL":
      return false;
    case "SHEDDING_T2":
      // temporalId が最大の層を破棄する → DISCARDABLE が立っているもの = priority 1,2,3
      return priority <= 3;
    case "SHEDDING_T1":
      // temporalId >= 1 を破棄する → priority 1,2,3 に加え priority 4,5 のうち temporal > 0
      // しかし priority 4,5 は DISCARDABLE=0 であり temporal 層の判定は flags だけでは不可能。
      // state-machines.md の記述: 「temporalId >= 1 を破棄する」
      // event.tid で判定する。
      return event.tid >= 1;
    case "SHEDDING_SPATIAL":
      // 最上位 spatialId を破棄する（+ SHEDDING_T1 の条件も維持）
      // event.sid が最大層であるかの判定が必要だが、最大層の情報は状態に無い。
      // priority に基づいて判定: priority 1-5 は全て破棄対象
      // ただし KEY は priority null なので既にフィルタされている。
      return true;
    case "KEY_ONLY":
      // KEY 以外を全て破棄する。priority !== null は既に KEY でない。
      return true;
  }
}

// --- 内部: 予算超過判定 ---

function isOverBudget(
  projectedMessages: number,
  projectedBytes: number,
  state: ShardState,
  t: number,
): boolean {
  const windowDuration = t - state.windowStartMs;
  if (windowDuration <= 0) {
    return false;
  }
  // メッセージレート超過: projectedMessages * 1000 > NODE_MAX_OUT_MESSAGES_PER_SEC * windowDuration
  const msgOver =
    projectedMessages * 1000 > NODE_MAX_OUT_MESSAGES_PER_SEC * windowDuration;
  // バイトレート超過: projectedBytes * 1000 > budgetBytesPerSec * windowDuration
  const byteOver =
    projectedBytes * 1000 > state.budgetBytesPerSec * windowDuration;
  return msgOver || byteOver;
}

// --- 内部: 窓リセット ---

function maybeResetWindow(state: ShardState, t: number): ShardState {
  // 1 秒経過したら窓をリセットする
  const elapsed = t - state.windowStartMs;
  if (elapsed >= 1000) {
    return {
      ...state,
      sentBytesInWindow: 0,
      sentMessagesInWindow: 0,
      windowStartMs: t,
    };
  }
  return state;
}

// --- 内部: 購読のソート順（決定性のため subscriberId, targetId の昇順） ---

function subscriptionOrder(a: Subscription, b: Subscription): number {
  if (a.subscriberId !== b.subscriberId) {
    return a.subscriberId - b.subscriberId;
  }
  return a.targetId - b.targetId;
}
