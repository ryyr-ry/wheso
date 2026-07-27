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
  SHARD_UTIL_WINDOW_MS,
  SHARD_UTIL_ENTER_T2_NUM,
  SHARD_UTIL_ENTER_T2_DEN,
  SHARD_UTIL_ENTER_T1_NUM,
  SHARD_UTIL_ENTER_T1_DEN,
  SHARD_UTIL_ENTER_SPATIAL_NUM,
  SHARD_UTIL_ENTER_SPATIAL_DEN,
  SHARD_UTIL_ENTER_KEY_ONLY_NUM,
  SHARD_UTIL_ENTER_KEY_ONLY_DEN,
  SHARD_UTIL_EXIT_T2_NUM,
  SHARD_UTIL_EXIT_T2_DEN,
  SHARD_UTIL_EXIT_T1_NUM,
  SHARD_UTIL_EXIT_T1_DEN,
  SHARD_UTIL_EXIT_SPATIAL_NUM,
  SHARD_UTIL_EXIT_SPATIAL_DEN,
  SHARD_UTIL_EXIT_KEY_ONLY_NUM,
  SHARD_UTIL_EXIT_KEY_ONLY_DEN,
  SHARD_TREND_ENTER_T2_NUM,
  SHARD_TREND_ENTER_T2_DEN,
  SHARD_TREND_ENTER_T1_NUM,
  SHARD_TREND_ENTER_T1_DEN,
  SHARD_TREND_ENTER_SPATIAL_NUM,
  SHARD_TREND_ENTER_SPATIAL_DEN,
  SHARD_TREND_ENTER_KEY_ONLY_NUM,
  SHARD_TREND_ENTER_KEY_ONLY_DEN,
  SHARD_TREND_EXIT_NUM,
  SHARD_TREND_EXIT_DEN,
  SHARD_TREND_EXIT_KEY_ONLY_NUM,
  SHARD_TREND_EXIT_KEY_ONLY_DEN,
} from "./generated/constants.ts";

import { ERROR_DEFINITIONS } from "./generated/errors.ts";
import { delaySlope, type Slope } from "./fixed.ts";
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

/**
 * 受信者からの測定報告（conformance.md 4.2）。
 * state-machines.md 3 節の遷移条件 maxTrend の入力である。
 */
export interface ReportEvent {
  readonly kind: "report";
  readonly from: number;
  /** 片道遅延の標本列（マイクロ秒の整数）。勾配の算出に用いる */
  readonly delayUs: readonly number[];
}

export type ShardEvent =
  | MediaEvent
  | SubscribeEvent
  | JoinEvent
  | LeaveEvent
  | LinkEvent
  | TimerEvent
  | BudgetEvent
  | ReportEvent;

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

/**
 * 制御系へのエラー通知（conformance.md 4.3）。
 * 接続は閉じない。KEY_ONLY への遷移でシャードの再分割を要求するために使う。
 */
export interface NotifyCommand {
  readonly kind: "notify";
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
  | CloseCommand
  | NotifyCommand;

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
  /**
   * 受信者ごとの遅延勾配。report イベントで更新する。
   * subscriberId の昇順で保持する（決定性のため）。
   */
  readonly trends: readonly ReceiverTrend[];
  /**
   * (senderId, channel) ごとに観測した spatialId の最大値。
   * SHEDDING_SPATIAL で「最上位 spatialId のみ」を破棄するために必要である。
   * senderId, channel の昇順で保持する。
   */
  readonly maxSpatial: readonly MaxSpatial[];
}

/** 受信者 1 人の遅延勾配。分子と分母の整数対で持つ（ADR-0017）。 */
export interface ReceiverTrend {
  readonly subscriberId: number;
  readonly numerator: number;
  readonly denominator: number;
}

/** 送信者とチャネルごとの最大 spatialId。 */
export interface MaxSpatial {
  readonly from: number;
  readonly ch: number;
  readonly sid: number;
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
    trends: [],
    maxSpatial: [],
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
    case "report":
      return handleReport(state, event, t);
  }
}

// --- 内部: メディアイベント処理 ---

function handleMedia(state: ShardState, event: MediaEvent, t: number): StepResult {
  const commands: ShardCommand[] = [];

  // 窓のリセット（観測窓が満了したら）
  // 観測した spatialId の最大値も更新する。SHEDDING_SPATIAL の判定に使う。
  const newState = updateMaxSpatial(maybeResetWindow(state, t), event);

  // 破棄優先順位を計算（wire.ts の dropPriority を再利用する）
  const priority = dropPriority(event.ch, event.flags);

  // 輻輳状態に応じた破棄判定
  const shouldDrop = shouldDropInCongestion(newState, event, priority);

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

  // 転送により利用率が上がるため、輻輳状態を再評価する。
  // 評価しないと util が閾値を超えても遷移が起きない（state-machines.md 3 節）。
  const evaluated = evaluateCongestionTransition(stateAfterForward, t);
  return { state: evaluated.state, commands: [...commands, ...evaluated.commands] };
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
  // 退出者の遅延勾配と観測した spatialId も除去する。
  // 残すと、居なくなった相手の古い観測が輻輳の判定に影響し続ける。
  const newTrends = state.trends.filter((trend) => trend.subscriberId !== event.id);
  const newMaxSpatial = state.maxSpatial.filter((entry) => entry.from !== event.id);
  return {
    state: {
      ...state,
      participants: newParticipants,
      subscriptions: newSubscriptions,
      trends: newTrends,
      maxSpatial: newMaxSpatial,
    },
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
  // タイマーは窓のリセットと輻輳状態の再評価に使う。
  // 送信が止まった場合、util は時間の経過だけで下がる。タイマーで再評価しないと
  // 回復方向の遷移（表の 3 行目・5 行目・7 行目・8 行目）が起きない。
  const newState = maybeResetWindow(state, t);
  return evaluateCongestionTransition(newState, t);
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

// --- 内部: 測定報告の処理 ---

function handleReport(state: ShardState, event: ReportEvent, t: number): StepResult {
  // 遅延勾配は fixed.ts の整数演算で求める。浮動小数点を使わない（ADR-0017）。
  const slope: Slope = delaySlope(event.delayUs);
  const rest = state.trends.filter((entry) => entry.subscriberId !== event.from);
  const updated: ReceiverTrend = {
    subscriberId: event.from,
    numerator: slope.numerator,
    denominator: slope.denominator,
  };
  // subscriberId の昇順で保持する。反復順序が結果に影響するため決定的にする必要がある。
  const trends = [...rest, updated].sort((a, b) => a.subscriberId - b.subscriberId);
  return evaluateCongestionTransition({ ...state, trends }, t);
}

// --- 内部: 輻輳状態の遷移評価 ---
// state-machines.md 3 節の表に一行ずつ対応する。
// 遷移の入力は util（要求レート ÷ 予算）と maxTrend（受信者の遅延勾配の最大値）である。
// 劣化側は「または」、回復側は「かつ」で結合する。
// 比較は全て整数の交差乗算で行う（ADR-0017）。浮動小数点を使わない。

/** util > num/den を判定する。util = 送信メッセージ数 ÷ (窓の秒数 × 予算レート)。 */
function utilGreater(state: ShardState, t: number, num: number, den: number): boolean {
  const windowMs = t - state.windowStartMs;
  if (windowMs <= 0) {
    return false;
  }
  // util = sent × 1000 / (windowMs × maxMps)
  // util > num/den ⇔ sent × 1000 × den > num × windowMs × maxMps
  // 分母（windowMs × maxMps × den）は正であるため不等号の向きは変わらない。
  return state.sentMessagesInWindow * 1000 * den > num * windowMs * NODE_MAX_OUT_MESSAGES_PER_SEC;
}

/** util < num/den を判定する。 */
function utilLess(state: ShardState, t: number, num: number, den: number): boolean {
  const windowMs = t - state.windowStartMs;
  if (windowMs <= 0) {
    // 窓が開いた直後は送信量が 0 であり、利用率は 0 とみなす。
    return num > 0;
  }
  return state.sentMessagesInWindow * 1000 * den < num * windowMs * NODE_MAX_OUT_MESSAGES_PER_SEC;
}

/** maxTrend > num/den を判定する。報告が無い場合は false（勾配が不明なら劣化と判定しない）。 */
function trendGreater(state: ShardState, num: number, den: number): boolean {
  for (const trend of state.trends) {
    // trend > num/den ⇔ trend.numerator × den > num × trend.denominator
    // denominator は delaySlope の定義により常に正である（conformance.md 3.3）。
    if (trend.numerator * den > num * trend.denominator) {
      return true;
    }
  }
  return false;
}

/** maxTrend < num/den を判定する。報告が 1 つも無い場合は回復条件を満たすとみなす。 */
function trendLess(state: ShardState, num: number, den: number): boolean {
  for (const trend of state.trends) {
    if (!(trend.numerator * den < num * trend.denominator)) {
      return false;
    }
  }
  return true;
}

function evaluateCongestionTransition(state: ShardState, t: number): StepResult {
  // ヒステリシス: 現状態に入ってから SHEDDING_HYSTERESIS_MS 以内は遷移しない。
  // 振動を防ぐためである（state-machines.md 3 節）。
  if (t - state.congestionEnteredAt < SHEDDING_HYSTERESIS_MS) {
    return { state, commands: [] };
  }

  let next = state.congestion;
  switch (state.congestion) {
    case "NORMAL":
      if (
        utilGreater(state, t, SHARD_UTIL_ENTER_T2_NUM, SHARD_UTIL_ENTER_T2_DEN) ||
        trendGreater(state, SHARD_TREND_ENTER_T2_NUM, SHARD_TREND_ENTER_T2_DEN)
      ) {
        next = "SHEDDING_T2";
      }
      break;
    case "SHEDDING_T2":
      if (
        utilGreater(state, t, SHARD_UTIL_ENTER_T1_NUM, SHARD_UTIL_ENTER_T1_DEN) ||
        trendGreater(state, SHARD_TREND_ENTER_T1_NUM, SHARD_TREND_ENTER_T1_DEN)
      ) {
        next = "SHEDDING_T1";
      } else if (
        utilLess(state, t, SHARD_UTIL_EXIT_T2_NUM, SHARD_UTIL_EXIT_T2_DEN) &&
        trendLess(state, SHARD_TREND_EXIT_NUM, SHARD_TREND_EXIT_DEN)
      ) {
        next = "NORMAL";
      }
      break;
    case "SHEDDING_T1":
      if (
        utilGreater(state, t, SHARD_UTIL_ENTER_SPATIAL_NUM, SHARD_UTIL_ENTER_SPATIAL_DEN) ||
        trendGreater(state, SHARD_TREND_ENTER_SPATIAL_NUM, SHARD_TREND_ENTER_SPATIAL_DEN)
      ) {
        next = "SHEDDING_SPATIAL";
      } else if (
        utilLess(state, t, SHARD_UTIL_EXIT_T1_NUM, SHARD_UTIL_EXIT_T1_DEN) &&
        trendLess(state, SHARD_TREND_EXIT_NUM, SHARD_TREND_EXIT_DEN)
      ) {
        next = "SHEDDING_T2";
      }
      break;
    case "SHEDDING_SPATIAL":
      if (
        utilGreater(state, t, SHARD_UTIL_ENTER_KEY_ONLY_NUM, SHARD_UTIL_ENTER_KEY_ONLY_DEN) ||
        trendGreater(state, SHARD_TREND_ENTER_KEY_ONLY_NUM, SHARD_TREND_ENTER_KEY_ONLY_DEN)
      ) {
        next = "KEY_ONLY";
      } else if (
        utilLess(state, t, SHARD_UTIL_EXIT_SPATIAL_NUM, SHARD_UTIL_EXIT_SPATIAL_DEN) &&
        trendLess(state, SHARD_TREND_EXIT_NUM, SHARD_TREND_EXIT_DEN)
      ) {
        next = "SHEDDING_T1";
      }
      break;
    case "KEY_ONLY":
      if (
        utilLess(state, t, SHARD_UTIL_EXIT_KEY_ONLY_NUM, SHARD_UTIL_EXIT_KEY_ONLY_DEN) &&
        trendLess(state, SHARD_TREND_EXIT_KEY_ONLY_NUM, SHARD_TREND_EXIT_KEY_ONLY_DEN)
      ) {
        next = "SHEDDING_SPATIAL";
      }
      break;
  }

  if (next === state.congestion) {
    return { state, commands: [] };
  }

  const commands: ShardCommand[] = [];
  if (next === "KEY_ONLY") {
    // シャードの再分割が必要な水準である。制御系へ通知する（state-machines.md 3 節）。
    commands.push({ kind: "notify", code: ERROR_DEFINITIONS.E_NODE_OVERLOADED.closeCode });
  }
  return {
    state: { ...state, congestion: next, congestionEnteredAt: t },
    commands,
  };
}

// --- 内部: 輻輳状態に応じた破棄判定 ---

function shouldDropInCongestion(
  state: ShardState,
  event: MediaEvent,
  priority: number | null,
): boolean {
  // 破棄禁止のユニット（KEY / 音声）は常に転送する（wire-format.md 1.4）
  if (priority === null) {
    return false;
  }

  switch (state.congestion) {
    case "NORMAL":
      return false;
    case "SHEDDING_T2":
      // temporalId が最大の層を破棄する。最大層は送信側が DISCARDABLE を立てているため、
      // 破棄可否の判断は flags 由来の優先順位（1〜3）で行う。
      return priority <= 3;
    case "SHEDDING_T1":
      // temporalId >= 1 を破棄する。
      return event.tid >= 1;
    case "SHEDDING_SPATIAL":
      // 最上位 spatialId のみを破棄する。全層を破棄するとサムネイルまで消えるため、
      // (senderId, channel) ごとに観測した最大 spatialId と一致する場合に限る。
      // 加えて SHEDDING_T1 の条件（temporalId >= 1）も維持する。
      return event.sid >= maxSpatialFor(state, event.from, event.ch) || event.tid >= 1;
    case "KEY_ONLY":
      // KEY 以外を全て破棄する。priority !== null は KEY でないことを意味する。
      return true;
  }
}

/** (senderId, channel) について観測した最大 spatialId。未観測なら 0 を返す。 */
function maxSpatialFor(state: ShardState, from: number, ch: number): number {
  for (const entry of state.maxSpatial) {
    if (entry.from === from && entry.ch === ch) {
      return entry.sid;
    }
  }
  return 0;
}

/** 観測した spatialId の最大値を更新する。順序は決定的（from, ch の昇順）に保つ。 */
function updateMaxSpatial(state: ShardState, event: MediaEvent): ShardState {
  const current = state.maxSpatial.find((e) => e.from === event.from && e.ch === event.ch);
  if (current !== undefined && current.sid >= event.sid) {
    return state;
  }
  const rest = state.maxSpatial.filter((e) => !(e.from === event.from && e.ch === event.ch));
  const updated: MaxSpatial = { from: event.from, ch: event.ch, sid: event.sid };
  const merged = [...rest, updated].sort((a, b) => (a.from !== b.from ? a.from - b.from : a.ch - b.ch));
  return { ...state, maxSpatial: merged };
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
  if (elapsed >= SHARD_UTIL_WINDOW_MS) {
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
