/**
 * 中継ノード（shard）の判断コア。
 *
 * sans-IO の純関数状態機械。時刻・乱数・浮動小数点・入出力・並行に触れない。
 * 規範: congestion.md 2 節（送信窓）・7 節（計上は接続単位）、state-machines.md 3 節、
 *       wire-format.md 1.4（破棄優先順位）、ADR-0025（購読単位への分解）、
 *       ADR-0027（spatialId はちょうど 1 段を選ぶ）。
 *
 * 設計の要点は 3 つである。
 *
 * 1. **判断は購読ごとに独立している。** 遅い受信者 1 人が他の受信者の品質を落としてはならない
 *    （congestion.md 7 節が名指しで禁じている）。輻輳状態・送信窓・遅延勾配はすべて購読が持つ。
 * 2. **送信窓が破棄を有効にする唯一の機構である。** TCP は一度 send() に渡したバイトを
 *    取り消せない。したがって「渡す前」に落とすしかない。未確認の媒体を再生時間で数え、
 *    SEND_WINDOW_MS を超える間は渡さない。未確認の量は受信側の ack から求める。
 * 3. **解像度方向は simulcast である。** 各段は独立した完全なストリームであり（ADR-0004）、
 *    下位段は復号に不要である。したがって購読者へ渡すのは**ちょうど 1 段**である。
 *    `spatialId <= tier` で渡すと同じ内容が二重に届き、デコーダが段の切替として
 *    reset を繰り返して 1 枚も復号できない（ADR-0027）。
 */

import { CHANNEL_AUDIO, CHANNEL_SCREEN_AUDIO, FLAG_ACTIVE_SPEAKER, FLAG_KEY } from "./generated/wire-layout.ts";
import {
  ACK_TIMEOUT_MS,
  AUDIO_SELECTIVE_FORWARD_COUNT,
  MAX_UNEXPECTED_EVENTS,
  AUDIO_SELECTIVE_MIN_COUNT,
  AUDIO_SPEAKER_HOLD_MS,
  SEND_WINDOW_MS,
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

/* ------------------------------------------------------------------------- */
/* Result 型                                                                 */
/* ------------------------------------------------------------------------- */

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T, E>(value: T): Result<T, E> {
  return { ok: true, value };
}

export function err<T, E>(error: E): Result<T, E> {
  return { ok: false, error };
}

/* ------------------------------------------------------------------------- */
/* 輻輳状態（state-machines.md 3 節）                                        */
/* ------------------------------------------------------------------------- */

export type CongestionState =
  | "NORMAL"
  | "SHEDDING_T2"
  | "SHEDDING_T1"
  | "SHEDDING_SPATIAL"
  | "KEY_ONLY";

/* ------------------------------------------------------------------------- */
/* 入力イベント（conformance.md 4.2）                                        */
/* ------------------------------------------------------------------------- */

export interface MediaEvent {
  readonly kind: "media";
  readonly from: number;
  readonly ch: number;
  readonly sid: number;
  readonly tid: number;
  readonly key: boolean;
  readonly bytes: number;
  readonly flags: number;
  /**
   * ワイヤの sequenceNumber。送信窓（congestion.md 2 節）の計算に使う。
   * 同一 (senderId, channel, spatialId) 内で単調増加する。
   */
  readonly seq: number;
}

export interface SubscribeEvent {
  readonly kind: "subscribe";
  readonly from: number;
  readonly to: number;
  /**
   * 購読するチャネル。購読は (subscriberId, targetId, channel) で一意である。
   * チャネルを見ないと、映像の購読が音声まで転送してしまう。
   */
  readonly ch: number;
  readonly want: boolean;
  /** 購読者が要求する最大 spatialId（tier）。段番号である（ADR-0026）。 */
  readonly maxSpatialId: number;
  /** 購読者が要求する最大 temporalId。時間方向は SVC であり下位層が必要である。 */
  readonly maxTemporalId: number;
}

/**
 * 受信側からの受信位置の通知（congestion.md 2 節）。
 *
 * これが無いと未確認の量が分からず、送信窓が働かない。送信窓が働かないと
 * カーネルキューに数秒分が溜まり、破棄を決めても効果が出ない（「詰まったら固まる」の原因）。
 */
export interface AckEvent {
  readonly kind: "ack";
  /** ack を返した購読者。 */
  readonly from: number;
  /** どの送信者のストリームに対する ack か。 */
  readonly to: number;
  readonly ch: number;
  /**
   * どの段に対する ack か。
   *
   * **段ごとに sequenceNumber の空間が独立している**（wire-format.md 1.2: 同一
   * (senderId, channel, spatialId) 内で単調増加）。段を無視して ack を適用すると、
   * 別の段の seq が混ざって未確認量の計算が壊れる。
   */
  readonly sid: number;
  /** その時点で到着済みの最大 sequenceNumber。 */
  readonly highestSeq: number;
}

/** はしごの 1 段（ADR-0026）。 */
export interface LadderRung {
  /** 段番号。0 が最下段であり密に詰める。 */
  readonly sid: number;
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
  readonly temporalLayers: number;
  readonly targetBitrate: number;
}

/**
 * 送信者が申告したはしご（wire-format.md 2.3、ADR-0026）。
 *
 * 中継ノードがこれを必要とする理由は 2 つある。
 *   1. 送信窓の計算に fps が必要である（未確認フレーム数を再生時間へ直すため）
 *   2. 購読者へ渡す 1 段を選ぶために、存在する段の集合が必要である
 */
export interface StreamAnnounceEvent {
  readonly kind: "streamAnnounce";
  readonly from: number;
  readonly ch: number;
  /** 段。sid の昇順で受け取る必要はない。内部で昇順に整列する。 */
  readonly rungs: readonly LadderRung[];
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
 * 受信者からの測定報告（conformance.md 4.2、ADR-0021）。
 *
 * 勾配は**その受信者の購読にのみ**適用する。他人の勾配で自分の品質を落としてはならない
 * （ADR-0025 の 4）。
 */
export interface ReportEvent {
  readonly kind: "report";
  readonly from: number;
  /** 片道遅延の標本列（マイクロ秒の整数）。 */
  readonly delayUs: readonly number[];
}

/**
 * 購読者からのキーフレーム要求（ADR-0039）。
 *
 * 会議の途中で購読を張ると最初に届くのは差分フレームであり、購読者の復号器は
 * キーフレームまで何も出せない。以前はこの事象が無く、要求は中継ノードで捨てられて
 * いたため**購読者には永久に何も表示されなかった**（F-053）。
 *
 * 要求できるのは**自分が購読している送信者の段**のみとする。購読していない相手の
 * 符号化器をキーフレームで乱すことを防ぐ。
 */
export interface KeyframeRequestEvent {
  readonly kind: "keyframeRequest";
  /** 要求した購読者。 */
  readonly from: number;
  /** キーフレームを出してほしい送信者。 */
  readonly target: number;
  readonly ch: number;
  readonly sid: number;
}

export type ShardEvent =
  | MediaEvent
  | KeyframeRequestEvent
  | SubscribeEvent
  | AckEvent
  | StreamAnnounceEvent
  | JoinEvent
  | LeaveEvent
  | LinkEvent
  | TimerEvent
  | BudgetEvent
  | ReportEvent;

/* ------------------------------------------------------------------------- */
/* 出力コマンド（conformance.md 4.3）                                         */
/* ------------------------------------------------------------------------- */

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

/**
 * キーフレームの要求（wire-format.md 2.5）。
 *
 * **`channel` と `spatialId` を持たせる。** 送信者は段ごとに独立した符号化器を持つため
 * （simulcast。ADR-0004）、どの段のキーフレームを求めているかを伝えなければ、
 * 受け取った側は要求を適用できない。以前は `for` だけを持っており、受け取る送信ノードが
 * 必須検査で捨てていたため、要求は 1 度も通らなかった。
 */
export interface KeyframeRequestCommand {
  readonly kind: "keyframeRequest";
  readonly for: number;
  readonly channel: number;
  readonly spatialId: number;
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
 * 接続は閉じない。ノード全体の予算超過でシャードの再分割を要求するために使う。
 */
export interface NotifyCommand {
  readonly kind: "notify";
  readonly code: number;
}

/**
 * 上流（送信ノード）へ返す受信位置（congestion.md 2 節）。
 *
 * **送信ノードの送信窓はこれが無いと開かない。** 送信ノードは未確認のフレーム数から
 * `inFlightMs` を求め、`SEND_WINDOW_MS` を超える間は渡さない。中継ノードが受信位置を
 * 返さなければ、送信ノードは最初の数枚を渡した後に永久に窓を閉じる（実測: 10 枚のうち
 * 4 枚だけが中継ノードへ届いた）。受信ノードが中継ノードへ返すのと同じ機構である。
 */
export interface AckUpstreamCommand {
  readonly kind: "ackUpstream";
  /** 宛先の送信者。 */
  readonly to: number;
  readonly channel: number;
  readonly spatialId: number;
  readonly highestSeq: number;
}

export type ShardCommand =
  | ForwardCommand
  | AckUpstreamCommand
  | DropCommand
  | SetTierCommand
  | KeyframeRequestCommand
  | ConnectCommand
  | DisconnectCommand
  | ScheduleCommand
  | CloseCommand
  | NotifyCommand;

/* ------------------------------------------------------------------------- */
/* 状態                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * 購読 1 本の状態。
 *
 * **判断はすべてここに閉じる。** ノード全体の状態は転送の可否に影響させない
 * （ADR-0025 の 3・5）。
 */
export interface Subscription {
  readonly subscriberId: number;
  readonly targetId: number;
  readonly channel: number;
  /** 購読者が要求した最大 spatialId（段番号）。 */
  readonly maxSpatialId: number;
  /** 購読者が要求した最大 temporalId。 */
  readonly maxTemporalId: number;

  /* --- 送信窓（congestion.md 2 節） --- */
  /**
   * 送信窓が追跡している段。段ごとに sequenceNumber の空間が独立しているため、
   * 渡す段が変わったら窓を作り直す必要がある。−1 は「まだ渡していない」を表す。
   */
  readonly windowSid: number;
  /** この購読へ渡した最大 sequenceNumber（`windowSid` の空間における値）。 */
  readonly highestSent: number;
  /** ack で確認された最大 sequenceNumber。 */
  readonly highestAcked: number;
  /** 最後に ack を受けた時刻。ACK_TIMEOUT_MS の判定に使う。 */
  readonly lastAckAtMs: number;
  /**
   * ack が途絶えて転送を止めているか。
   * 止めた後も購読は残す。再び ack が届けば復帰する（再接続で購読が張り直されるため）。
   */
  readonly stalled: boolean;

  /* --- 輻輳（state-machines.md 3 節を購読単位で適用する） --- */
  readonly congestion: CongestionState;
  readonly congestionEnteredAt: number;
  /**
   * 輻輳による段の引き下げ量。SHEDDING_SPATIAL 以降で 1 になる。
   *
   * 最上位 spatialId を「破棄」してはならない。simulcast では購読者へ渡しているのは
   * 1 段だけであり、その段を破棄すると画面が消える。段を 1 つ下げるのが正しい
   * （ADR-0027 の 4）。
   */
  readonly tierPenalty: number;
  /**
   * 破棄不可のユニット（優先順位 4・5）を落とした段。落としていなければ −1。
   *
   * **規範 1.4**: 順位 4 と 5 を破棄する場合は、デコーダの参照連鎖が壊れるため、
   * **必ず同一 (senderId, channel, spatialId) の次の KEY ユニットまで連続して破棄し**、
   * 受信者へ `keyframeRequest` を送る。
   *
   * これを持たないと、参照が欠けたフレーム列をそのまま渡すことになる。実測（実環境・
   * 劣化なし）では復号器へ 613 件渡して出力が 148 枚しか得られず、`Decoding error` が
   * 記録された。**送った側から見れば「届いている」のに、見る側では映像が出ない。**
   */
  readonly awaitingKeySid: number;
}

/**
 * 送信者ごとの直近の発話時刻。音声の選別転送に使う（ADR-0024）。
 * senderId の昇順で保持する（決定性のため）。
 */
export interface SpeakerActivity {
  readonly senderId: number;
  /** 最後に ACTIVE_SPEAKER=1 の音声が届いた時刻。 */
  readonly lastSpeechAtMs: number;
}

/** 受信者 1 人の遅延勾配。分子と分母の整数対で持つ（ADR-0017）。 */
export interface ReceiverTrend {
  readonly subscriberId: number;
  readonly numerator: number;
  readonly denominator: number;
}

/** 送信者が申告した、または観測されたはしご。 */
export interface Ladder {
  readonly from: number;
  readonly ch: number;
  /** sid の昇順。 */
  readonly rungs: readonly LadderRung[];
  /** 申告（streamAnnounce）に由来するか。false は観測のみ（fps が分からない）。 */
  readonly announced: boolean;
}

/** 送信者 1 人に指令したエンコーダの上限段。 */
export interface EncoderTier {
  readonly targetId: number;
  readonly tier: number;
}

export interface ShardState {
  /** 参加者 ID の集合（昇順で保持）。 */
  readonly participants: readonly number[];
  /** 購読の一覧。(subscriberId, targetId, channel) で一意。昇順で保持。 */
  readonly subscriptions: readonly Subscription[];
  /** 送信者ごとのはしご。(from, ch) の昇順で保持。 */
  readonly ladders: readonly Ladder[];
  /** 受信者ごとの遅延勾配。subscriberId の昇順で保持。 */
  readonly trends: readonly ReceiverTrend[];
  /** 送信者ごとの直近の発話時刻（ADR-0024）。senderId の昇順で保持。 */
  readonly speakers: readonly SpeakerActivity[];
  /** 送信者ごとに指令したエンコーダの上限段（ADR-0022）。targetId の昇順で保持。 */
  readonly encoderTiers: readonly EncoderTier[];

  /* --- ノード全体の予算。転送の可否には使わない（ADR-0025 の 5） --- */
  readonly budgetBytesPerSec: number;
  readonly sentBytesInWindow: number;
  readonly sentMessagesInWindow: number;
  readonly windowStartMs: number;
  /** 現在の窓で過負荷を通知したか。同じ窓で繰り返し通知しない。 */
  readonly overloadNotified: boolean;

  /**
   * 送信者ごとに受け取った最大の sequenceNumber。
   * `timer` で `ackUpstream` として返す（congestion.md 2 節）。
   * (from, ch, sid) の昇順で保持する（決定性のため）。
   */
  readonly received: readonly ReceivedMark[];

  /** 表に無いイベントの記録（W_UNEXPECTED_EVENT）。 */
  readonly unexpectedEvents: readonly string[];
}

/** 受け取った位置。`ackUpstream` の内容になる。 */
export interface ReceivedMark {
  readonly from: number;
  readonly ch: number;
  readonly sid: number;
  readonly highestSeq: number;
}

export function initialState(t: number): ShardState {
  return {
    participants: [],
    subscriptions: [],
    ladders: [],
    trends: [],
    speakers: [],
    encoderTiers: [],
    budgetBytesPerSec: NODE_MAX_OUT_BYTES_PER_SEC,
    sentBytesInWindow: 0,
    sentMessagesInWindow: 0,
    windowStartMs: t,
    overloadNotified: false,
    received: [],
    unexpectedEvents: [],
  };
}

export interface StepResult {
  readonly state: ShardState;
  readonly commands: readonly ShardCommand[];
}

/* ------------------------------------------------------------------------- */
/* ステップ関数                                                              */
/* ------------------------------------------------------------------------- */

export function step(state: ShardState, event: ShardEvent, t: number): StepResult {
  switch (event.kind) {
    case "media":
      return handleMedia(state, event, t);
    case "subscribe":
      return handleSubscribe(state, event, t);
    case "ack":
      return handleAck(state, event, t);
    case "streamAnnounce":
      return handleStreamAnnounce(state, event, t);
    case "join":
      return handleJoin(state, event);
    case "leave":
      return handleLeave(state, event);
    case "link":
      return ignoreEvent(state, "link");
    case "timer":
      return handleTimer(state, t);
    case "budget":
      return handleBudget(state, event, t);
    case "report":
      return handleReport(state, event, t);
    case "keyframeRequest":
      return handleKeyframeRequest(state, event);
  }
}

/**
 * 購読者のキーフレーム要求を送信者への要求へ直す。
 *
 * 購読が無い相手への要求は無視して記録する（表に無い遷移として扱う。AGENTS 5.4）。
 * 間隔制限は実行側が持つ（`rate-limit.ts`。wire-format.md 2.5）。
 */
function handleKeyframeRequest(state: ShardState, event: KeyframeRequestEvent): StepResult {
  const subscribed = state.subscriptions.some(
    (sub) => sub.subscriberId === event.from && sub.targetId === event.target && sub.channel === event.ch,
  );
  if (!subscribed) {
    return ignoreEvent(state, "keyframeRequest");
  }
  return {
    state,
    commands: [
      {
        kind: "keyframeRequest",
        for: event.target,
        channel: event.ch,
        spatialId: event.sid,
      },
    ],
  };
}

function ignoreEvent(state: ShardState, name: string): StepResult {
  // state-machines.md 3 節の表に無いイベントは無視して記録する（AGENTS 5.4）。
  //
  // **記録には上限を設ける。** 上限が無いと、購読に対応しない `ack` が届くたびに
  // 文字列が積まれ続ける（ack は購読ごとに毎秒 20 件届く）。Durable Object の記憶は
  // 128 MB であり、無制限に伸びる配列は必ず溢れる。古い側を捨てる。
  const appended = [...state.unexpectedEvents, name];
  const trimmed =
    appended.length > MAX_UNEXPECTED_EVENTS
      ? appended.slice(appended.length - MAX_UNEXPECTED_EVENTS)
      : appended;
  return {
    state: { ...state, unexpectedEvents: trimmed },
    commands: [],
  };
}

/* ------------------------------------------------------------------------- */
/* メディア                                                                  */
/* ------------------------------------------------------------------------- */

function isAudioChannel(ch: number): boolean {
  return ch === CHANNEL_AUDIO || ch === CHANNEL_SCREEN_AUDIO;
}

function handleMedia(state: ShardState, event: MediaEvent, t: number): StepResult {
  const windowed = observeLadder(maybeResetWindow(state, t), event);

  // 音声で ACTIVE_SPEAKER が立っていれば発話時刻を記録する（選別転送。ADR-0024）。
  // 記録は選別の前に行う。今まさに発話している送信者の音声は通す必要がある。
  const audio = isAudioChannel(event.ch);
  const speaking = (event.flags & FLAG_ACTIVE_SPEAKER) !== 0;
  const withSpeech: ShardState =
    audio && speaking
      ? { ...windowed, speakers: recordSpeech(windowed.speakers, event.from, t) }
      : windowed;

  const priority = dropPriority(event.ch, event.flags);
  // 受け取った位置を記録する。ack はタイマーでまとめて返す（フレームごとに返すと
  // メッセージレートを食う。制約はレートである。F-024）。
  const marked = markReceived(withSpeech, event);

  const targets: number[] = [];
  const dropped = new Map<number, number>();
  const nextSubscriptions: Subscription[] = [];
  // 参照連鎖が切れた購読が 1 つでもあれば、送信者へキーフレームを 1 度だけ要求する
  // （規範 1.4）。購読ごとに出すと同じ要求が並ぶ。要求は段ごとに 1 件で足りる。
  let wantsKeyframe = false;

  for (const sub of marked.subscriptions) {
    if (sub.targetId !== event.from || sub.channel !== event.ch) {
      nextSubscriptions.push(sub);
      continue;
    }
    const decision = decideForSubscription(marked, sub, event, priority, t);
    nextSubscriptions.push(decision.subscription);
    if (decision.requestKeyframe) {
      wantsKeyframe = true;
    }
    if (decision.forward) {
      targets.push(sub.subscriberId);
      continue;
    }
    if (decision.dropPriority !== null) {
      const current = dropped.get(decision.dropPriority) ?? 0;
      dropped.set(decision.dropPriority, current + 1);
    }
  }

  // 昇順に整列する（決定性のため。仕様に順序の指定が無い場合は昇順）。
  targets.sort((a, b) => a - b);

  const commands: ShardCommand[] = [];
  // 破棄は優先順位の昇順でまとめて 1 件ずつ報告する。順序を固定しないと
  // トレースベクタの完全一致（conformance.md 4.4）が壊れる。
  for (const key of [...dropped.keys()].sort((a, b) => a - b)) {
    const count = dropped.get(key);
    if (count !== undefined && count > 0) {
      commands.push({ kind: "drop", priority: key, count });
    }
  }
  // 破棄の報告の後に置く（順序を固定しないとトレースの完全一致が壊れる）。
  if (wantsKeyframe) {
    commands.push({ kind: "keyframeRequest", for: event.from, channel: event.ch, spatialId: event.sid });
  }

  if (targets.length === 0) {
    return { state: { ...marked, subscriptions: nextSubscriptions }, commands };
  }

  commands.push({ kind: "forward", to: targets });

  // ノード全体の予算を計上する。**転送の可否には使わない。**
  // 超過はシャードの再分割が必要な水準であり、個別の購読の問題ではない（ADR-0025 の 5）。
  const accounted: ShardState = {
    ...marked,
    subscriptions: nextSubscriptions,
    sentMessagesInWindow: marked.sentMessagesInWindow + targets.length,
    sentBytesInWindow: marked.sentBytesInWindow + targets.length * event.bytes,
  };
  const overload = notifyNodeOverload(accounted, t);
  return { state: overload.state, commands: [...commands, ...overload.commands] };
}

interface SubscriptionDecision {
  readonly subscription: Subscription;
  readonly forward: boolean;
  /** 破棄として報告する優先順位。報告しない場合は null。 */
  readonly dropPriority: number | null;
  /**
   * 送信者へキーフレームを要求するか（規範 1.4）。
   *
   * 順位 4・5 を落としたときだけ真になる。順位 1 から 3 のみで対処できる場合は
   * **要求を発生させてはならない**（規範 1.4 の最後の段）。
   */
  readonly requestKeyframe: boolean;
}

/**
 * 購読 1 本に対する転送の可否を決める。
 *
 * 判定の順序を固定する。順序を変えると挙動が変わる。
 *   1. ack が途絶えている  → 渡さない（報告もしない。相手は既に居ない）
 *   2. 段の選択に合わない  → 渡さない（報告しない。輻輳ではなく層の選択である）
 *   3. temporalId の超過   → 渡さない（同上）
 *   4. 輻輳状態による破棄  → 渡さない（報告する）
 *   5. 送信窓が閉じている  → 渡さない（報告する）
 *   6. それ以外            → 渡す
 *
 * 4 と 5 では、破棄禁止のユニット（KEY と音声）は必ず渡す（wire-format.md 1.4）。
 */
function decideForSubscription(
  state: ShardState,
  sub: Subscription,
  event: MediaEvent,
  priority: number | null,
  t: number,
): SubscriptionDecision {
  if (sub.stalled) {
    return { subscription: sub, forward: false, dropPriority: null, requestKeyframe: false };
  }

  // 音声の選別転送（ADR-0024、ADR-0029 の 2）。
  //
  // **本数は購読者ごとに決める。** 帯域が細い購読者へ 5 本の音声を送ると、
  // 音声だけで 208 kbps を占め、映像の余地が無くなる（MIN_VIABLE_BPS の導出）。
  // 輻輳の段が深いほど本数を減らす。減らす順序は ADR-0024 の順位に従う。
  if (isAudioChannel(event.ch) && !isAudioForwarded(state, sub, event.from, t)) {
    // 輻輳による破棄ではないため priority は 0 とする（ADR-0024 の 5）。
    return { subscription: sub, forward: false, dropPriority: 0, requestKeyframe: false };
  }

  // 音声は段を持たない（spatialId は常に 0。wire-format.md 1.2）。段の選択は映像のみ。
  if (!isAudioChannel(event.ch)) {
    const chosen = chooseRung(state, sub);
    if (event.sid !== chosen) {
      return { subscription: sub, forward: false, dropPriority: null, requestKeyframe: false };
    }
    if (event.tid > sub.maxTemporalId) {
      return { subscription: sub, forward: false, dropPriority: null, requestKeyframe: false };
    }
  }

  const mustForward = priority === null;
  const isKey = (event.flags & FLAG_KEY) !== 0;

  // **参照連鎖が切れている間は、次の KEY まで落とし続ける**（規範 1.4）。
  //
  // 順位 4・5 を 1 件落とした後に後続を渡すと、復号器は参照の無いフレームを受け取り、
  // 出力を止める。実測では復号器へ 613 件渡して出力は 148 枚、`Decoding error` が
  // 記録された。落とし続ければ復号器は「キーフレーム待ち」に入り、要求で復帰する。
  if (!isAudioChannel(event.ch) && sub.awaitingKeySid === event.sid) {
    if (!isKey) {
      // 落とす。要求は最初の 1 回で送っているため、ここでは繰り返さない
      // （受信ノードの間隔制限が抑制するが、そもそも作らない方が良い）。
      return { subscription: sub, forward: false, dropPriority: priority, requestKeyframe: false };
    }
    // KEY が来た。参照連鎖が回復するため、待ちを解いて渡す。
    return forwardDecision(state, { ...sub, awaitingKeySid: -1 }, event);
  }

  if (!mustForward && shouldDropInCongestion(sub, event, priority)) {
    return dropWithChain(sub, event, priority);
  }

  if (!mustForward && isWindowClosed(state, sub, event)) {
    return dropWithChain(sub, event, priority);
  }

  return forwardDecision(state, sub, event);
}

/**
 * 破棄する。順位 4・5 なら次の KEY までの連続破棄を始め、キーフレームを要求する（規範 1.4）。
 * 順位 1 から 3（破棄可能なユニット）では連鎖を始めず、要求も作らない。
 */
function dropWithChain(sub: Subscription, event: MediaEvent, priority: number | null): SubscriptionDecision {
  const breaksChain = priority === 4 || priority === 5;
  if (!breaksChain) {
    return { subscription: sub, forward: false, dropPriority: priority, requestKeyframe: false };
  }
  return {
    subscription: { ...sub, awaitingKeySid: event.sid },
    forward: false,
    dropPriority: priority,
    requestKeyframe: true,
  };
}

/** 転送する。段が変わっていれば窓を作り直す。 */
function forwardDecision(state: ShardState, sub: Subscription, event: MediaEvent): SubscriptionDecision {
  const chosen = isAudioChannel(event.ch) ? 0 : chooseRung(state, sub);
  if (chosen !== sub.windowSid) {
    // 渡す段が変わった。seq の空間が変わるため窓を作り直す。
    // 作り直さないと、別の段の seq と比較して未確認量が誤る。
    return {
      subscription: { ...sub, windowSid: chosen, highestSent: event.seq, highestAcked: event.seq - 1 },
      forward: true,
      dropPriority: null,
      requestKeyframe: false,
    };
  }
  const highestSent = event.seq > sub.highestSent ? event.seq : sub.highestSent;
  return {
    subscription: { ...sub, highestSent },
    forward: true,
    dropPriority: null,
    requestKeyframe: false,
  };
}

/**
 * 送信窓が閉じているか（congestion.md 2 節）。
 *
 *   inFlightMs = 未確認フレーム数 / fps × 1000
 *   inFlightMs > SEND_WINDOW_MS ⇔ 未確認フレーム数 × 1000 > SEND_WINDOW_MS × fps
 *
 * 除算を避けて交差乗算で比較する。fps が分からない（streamAnnounce が未着）場合は
 * 窓を評価しない。評価するには「未確認フレーム数を再生時間へ直す」ための fps が必要であり、
 * 到着間隔から推定すると時刻と浮動小数点をコアへ持ち込むことになる（ADR-0017）。
 */
function isWindowClosed(state: ShardState, sub: Subscription, event: MediaEvent): boolean {
  const framerate = framerateOf(state, sub);
  if (framerate <= 0) {
    return false;
  }
  // **窓がまだこの連番の空間に無いときは評価しない**（ADR-0038）。
  //
  // 購読を張った時点の窓は `windowSid = -1`、`highestSent = 0`、`highestAcked = 0` である。
  // 一方、流れている媒体の連番は既に大きい（会議の途中で購読を張れば数百番）。この 2 つを
  // そのまま比べると未確認フレーム数が数百となり、最初の 1 件から「窓が閉じている」と
  // 判定される。渡さないので ack も来ず、`highestAcked` は永久に 0 のままとなり、
  // **その購読へは 1 枚も届かない**（実測: 中継の binaryOut が 0、windowSid が -1 のまま
  // 全ユニットが破棄された。F-049）。
  //
  // 窓は「段（連番の空間）ごと」に作り直すものであり（後段の `chosen !== sub.windowSid`）、
  // 空間が違う間は評価する意味がない。音声は段を持たないため 0 と比べる。
  const chosen = isAudioChannel(event.ch) ? 0 : chooseRung(state, sub);
  if (chosen !== sub.windowSid) {
    return false;
  }
  const inFlight = inFlightFrames(sub, event.seq);
  return inFlight * 1000 > SEND_WINDOW_MS * framerate;
}

/** 未確認のフレーム数。ack が無い間は「渡した分すべて」が未確認である。 */
function inFlightFrames(sub: Subscription, seq: number): number {
  const highest = seq > sub.highestSent ? seq : sub.highestSent;
  const inFlight = highest - sub.highestAcked - 1;
  return inFlight < 0 ? 0 : inFlight;
}

/** この購読が渡している段の fps。申告が無ければ 0 を返す。 */
function framerateOf(state: ShardState, sub: Subscription): number {
  const ladder = findLadder(state, sub.targetId, sub.channel);
  if (ladder === undefined || !ladder.announced) {
    return 0;
  }
  const chosen = chooseRung(state, sub);
  for (const rung of ladder.rungs) {
    if (rung.sid === chosen) {
      return rung.framerate;
    }
  }
  return 0;
}

/**
 * この購読へ渡す段を 1 つ選ぶ（ADR-0027 の 3）。
 *
 *   有効な要求段 = max(0, maxSpatialId − tierPenalty)
 *   選ぶ段       = max{存在する段 | 段 <= 有効な要求段}
 *   該当が無ければ最下段（存在する段の最小値）
 *
 * 最後の規則が再ネゴシエーションの安全弁である。はしごが縮んだ直後に古い段を
 * 要求されても、存在する段から選ぶため黒画面にならない。
 */
function chooseRung(state: ShardState, sub: Subscription): number {
  const wanted = sub.maxSpatialId - sub.tierPenalty;
  const effective = wanted < 0 ? 0 : wanted;
  const ladder = findLadder(state, sub.targetId, sub.channel);
  if (ladder === undefined || ladder.rungs.length === 0) {
    // 段の情報が無い間は要求どおりの段だけを通す。観測されれば次から選択が効く。
    return effective;
  }
  let best = -1;
  let lowest = -1;
  for (const rung of ladder.rungs) {
    if (lowest < 0 || rung.sid < lowest) {
      lowest = rung.sid;
    }
    if (rung.sid <= effective && rung.sid > best) {
      best = rung.sid;
    }
  }
  if (best >= 0) {
    return best;
  }
  return lowest < 0 ? effective : lowest;
}

/**
 * 輻輳状態に応じた破棄判定（state-machines.md 3 節を購読単位で適用する）。
 *
 * SHEDDING_SPATIAL では段を破棄しない。段の引き下げは tierPenalty で行い、
 * ここでは SHEDDING_T1 と同じ条件（temporalId >= 1）を維持する（ADR-0027 の 4）。
 */
function shouldDropInCongestion(sub: Subscription, event: MediaEvent, priority: number): boolean {
  switch (sub.congestion) {
    case "NORMAL":
      return false;
    case "SHEDDING_T2":
      // 送信側が DISCARDABLE を立てた層を破棄する。判定は flags 由来の優先順位で行う。
      return priority <= 3;
    case "SHEDDING_T1":
      return event.tid >= 1;
    case "SHEDDING_SPATIAL":
      return event.tid >= 1;
    case "KEY_ONLY":
      // priority が null でない = KEY ではない。すべて破棄する。
      return true;
  }
}

/* ------------------------------------------------------------------------- */
/* 音声の選別転送（ADR-0024）                                                */
/* ------------------------------------------------------------------------- */

function isAudioForwarded(
  state: ShardState,
  sub: Subscription,
  senderId: number,
  t: number,
): boolean {
  const limit = audioLimitFor(sub);
  const active: SpeakerActivity[] = [];
  for (const entry of state.speakers) {
    if (t - entry.lastSpeechAtMs <= AUDIO_SPEAKER_HOLD_MS) {
      active.push(entry);
    }
  }
  if (active.length <= limit) {
    // 上限に達していない。全員の音声を通す。DTX の無音で環境音が完全に消えると
    // 通話が不自然になるためである（ADR-0024 の 6）。
    return true;
  }
  const ordered = [...active].sort((a, b) => {
    if (a.lastSpeechAtMs !== b.lastSpeechAtMs) {
      return b.lastSpeechAtMs - a.lastSpeechAtMs;
    }
    return a.senderId - b.senderId;
  });
  const chosen = ordered.slice(0, limit);
  return chosen.some((entry) => entry.senderId === senderId);
}

/**
 * この購読者へ同時に転送する音声の本数（ADR-0029 の 2）。
 *
 * 輻輳の段が深いほど減らす。**1 本は必ず残す。** 音声が 0 本になると会議が成立しない
 * （ADR-0029 の 4 の優先順位の最上位）。
 */
function audioLimitFor(sub: Subscription): number {
  const reduced = AUDIO_SELECTIVE_FORWARD_COUNT - congestionDepth(sub.congestion);
  return reduced < AUDIO_SELECTIVE_MIN_COUNT ? AUDIO_SELECTIVE_MIN_COUNT : reduced;
}

/** 輻輳の深さ。NORMAL が 0 で、段が深くなるほど大きい。 */
function congestionDepth(state: CongestionState): number {
  switch (state) {
    case "NORMAL":
      return 0;
    case "SHEDDING_T2":
      return 1;
    case "SHEDDING_T1":
      return 2;
    case "SHEDDING_SPATIAL":
      return 3;
    case "KEY_ONLY":
      return 4;
  }
}

function recordSpeech(
  speakers: readonly SpeakerActivity[],
  senderId: number,
  t: number,
): readonly SpeakerActivity[] {
  const updated: SpeakerActivity[] = [];
  let replaced = false;
  for (const entry of speakers) {
    if (entry.senderId === senderId) {
      updated.push({ senderId, lastSpeechAtMs: t });
      replaced = true;
      continue;
    }
    updated.push(entry);
  }
  if (!replaced) {
    updated.push({ senderId, lastSpeechAtMs: t });
    updated.sort((a, b) => a.senderId - b.senderId);
  }
  return updated;
}

/**
 * 受け取った位置を更新する。後戻りする値では更新しない。
 * 順序は from, ch, sid の昇順に保つ（決定性のため）。
 */
function markReceived(state: ShardState, event: MediaEvent): ShardState {
  if (event.seq <= 0) {
    return state;
  }
  const existing = state.received.find(
    (mark) => mark.from === event.from && mark.ch === event.ch && mark.sid === event.sid,
  );
  if (existing !== undefined && existing.highestSeq >= event.seq) {
    return state;
  }
  const rest = state.received.filter(
    (mark) => !(mark.from === event.from && mark.ch === event.ch && mark.sid === event.sid),
  );
  const merged = [...rest, { from: event.from, ch: event.ch, sid: event.sid, highestSeq: event.seq }].sort(
    (a, b) => (a.from !== b.from ? a.from - b.from : a.ch !== b.ch ? a.ch - b.ch : a.sid - b.sid),
  );
  return { ...state, received: merged };
}

/* ------------------------------------------------------------------------- */
/* 購読                                                                      */
/* ------------------------------------------------------------------------- */

function handleSubscribe(state: ShardState, event: SubscribeEvent, t: number): StepResult {
  const rest = state.subscriptions.filter(
    (s) => !(s.subscriberId === event.from && s.targetId === event.to && s.channel === event.ch),
  );
  if (!event.want) {
    return withEncoderTiers({ ...state, subscriptions: rest.sort(subscriptionOrder) });
  }
  const existing = state.subscriptions.find(
    (s) => s.subscriberId === event.from && s.targetId === event.to && s.channel === event.ch,
  );
  // 購読を張り直したときは送信窓と輻輳状態を初期化する。再接続の直後に古い
  // 未確認量が残っていると、窓が閉じたまま復帰できない。
  const created: Subscription = {
    subscriberId: event.from,
    targetId: event.to,
    channel: event.ch,
    maxSpatialId: event.maxSpatialId,
    maxTemporalId: event.maxTemporalId,
    windowSid: existing?.windowSid ?? -1,
    highestSent: existing?.highestSent ?? 0,
    highestAcked: existing?.highestAcked ?? 0,
    lastAckAtMs: t,
    stalled: false,
    congestion: existing?.congestion ?? "NORMAL",
    congestionEnteredAt: existing?.congestionEnteredAt ?? t,
    tierPenalty: existing?.tierPenalty ?? 0,
    awaitingKeySid: existing?.awaitingKeySid ?? -1,
  };
  return withEncoderTiers({
    ...state,
    subscriptions: [...rest, created].sort(subscriptionOrder),
  });
}

/**
 * 購読の和集合から送信者ごとの必要な上限段を求め、変化した送信者へ `setTier` を出す
 * （ADR-0022）。
 *
 * 誰も高い段を要求していない送信者に高い段を作らせ続けると、送信側の負荷と上りの帯域が
 * 無駄になる。購読者が居なくなった送信者には指令を出さない（宛先が無く、設定は次の購読で決まる）。
 */
function withEncoderTiers(state: ShardState): StepResult {
  const targets: number[] = [];
  for (const sub of state.subscriptions) {
    if (!targets.includes(sub.targetId)) {
      targets.push(sub.targetId);
    }
  }
  targets.sort((a, b) => a - b);

  const nextTiers: EncoderTier[] = [];
  const commands: ShardCommand[] = [];
  for (const targetId of targets) {
    let tier = 0;
    for (const sub of state.subscriptions) {
      if (sub.targetId === targetId && sub.maxSpatialId > tier) {
        tier = sub.maxSpatialId;
      }
    }
    nextTiers.push({ targetId, tier });
    const previous = state.encoderTiers.find((entry) => entry.targetId === targetId);
    if (previous === undefined || previous.tier !== tier) {
      commands.push({ kind: "setTier", for: targetId, tier });
    }
  }
  return { state: { ...state, encoderTiers: nextTiers }, commands };
}

function subscriptionOrder(a: Subscription, b: Subscription): number {
  if (a.subscriberId !== b.subscriberId) {
    return a.subscriberId - b.subscriberId;
  }
  if (a.targetId !== b.targetId) {
    return a.targetId - b.targetId;
  }
  return a.channel - b.channel;
}

/* ------------------------------------------------------------------------- */
/* ack                                                                       */
/* ------------------------------------------------------------------------- */

function handleAck(state: ShardState, event: AckEvent, t: number): StepResult {
  const target = state.subscriptions.find(
    (s) => s.subscriberId === event.from && s.targetId === event.to && s.channel === event.ch,
  );
  if (target === undefined) {
    return ignoreEvent(state, "ack");
  }
  if (event.sid !== target.windowSid) {
    // 渡していない段への ack である。段を変えた直後に古い ack が届くことがある。
    // 適用すると別の seq 空間の値が混ざるため無視する。
    return ignoreEvent(state, "ack");
  }
  // 後戻りする ack は無視する。順序の逆転は TCP 上では起きないが、重複した ack は届く。
  const highestAcked = event.highestSeq > target.highestAcked ? event.highestSeq : target.highestAcked;
  const updated: Subscription = { ...target, highestAcked, lastAckAtMs: t, stalled: false };
  const subscriptions = state.subscriptions
    .filter((s) => s !== target)
    .concat([updated])
    .sort(subscriptionOrder);
  // ack で未確認量が減るため、輻輳状態を再評価する。評価しないと回復方向の遷移が起きない。
  return evaluateAll({ ...state, subscriptions }, t);
}

/* ------------------------------------------------------------------------- */
/* streamAnnounce                                                            */
/* ------------------------------------------------------------------------- */

function handleStreamAnnounce(state: ShardState, event: StreamAnnounceEvent, t: number): StepResult {
  const rungs = [...event.rungs].sort((a, b) => a.sid - b.sid);
  const rest = state.ladders.filter((entry) => !(entry.from === event.from && entry.ch === event.ch));
  const ladder: Ladder = { from: event.from, ch: event.ch, rungs, announced: true };
  const ladders = [...rest, ladder].sort(ladderOrder);
  // はしごが変わると選ぶ段と fps が変わるため、輻輳状態を再評価する。
  return evaluateAll({ ...state, ladders }, t);
}

/**
 * 観測からはしごを補う。
 *
 * 申告（streamAnnounce）が届く前でも、届いたユニットの spatialId から段の集合が分かる。
 * これにより「ちょうど 1 段を選ぶ」判断を申告の前から行える。fps は観測では分からないため
 * `announced` を false のままにし、送信窓は評価しない。
 */
function observeLadder(state: ShardState, event: MediaEvent): ShardState {
  if (isAudioChannel(event.ch)) {
    // 音声は段を持たない。
    return state;
  }
  const existing = findLadder(state, event.from, event.ch);
  if (existing !== undefined) {
    if (existing.announced || existing.rungs.some((rung) => rung.sid === event.sid)) {
      return state;
    }
    const rungs = [...existing.rungs, observedRung(event.sid)].sort((a, b) => a.sid - b.sid);
    const rest = state.ladders.filter((entry) => !(entry.from === event.from && entry.ch === event.ch));
    return {
      ...state,
      ladders: [...rest, { ...existing, rungs }].sort(ladderOrder),
    };
  }
  const created: Ladder = {
    from: event.from,
    ch: event.ch,
    rungs: [observedRung(event.sid)],
    announced: false,
  };
  return { ...state, ladders: [...state.ladders, created].sort(ladderOrder) };
}

/** 観測のみで作る段。寸法とビットレートは不明であるため 0 とし、判断に使わない。 */
function observedRung(sid: number): LadderRung {
  return { sid, width: 0, height: 0, framerate: 0, temporalLayers: 0, targetBitrate: 0 };
}

function findLadder(state: ShardState, from: number, ch: number): Ladder | undefined {
  return state.ladders.find((entry) => entry.from === from && entry.ch === ch);
}

function ladderOrder(a: Ladder, b: Ladder): number {
  return a.from !== b.from ? a.from - b.from : a.ch - b.ch;
}

/* ------------------------------------------------------------------------- */
/* 参加と退出                                                                */
/* ------------------------------------------------------------------------- */

function handleJoin(state: ShardState, event: JoinEvent): StepResult {
  if (state.participants.includes(event.id)) {
    return { state, commands: [] };
  }
  return {
    state: { ...state, participants: [...state.participants, event.id].sort((a, b) => a - b) },
    commands: [],
  };
}

function handleLeave(state: ShardState, event: LeaveEvent): StepResult {
  // 退出者に関わるものはすべて除去する。残すと居なくなった相手の古い観測が
  // 判定に影響し続ける（購読・勾配・はしご・指令の記録）。
  return withEncoderTiers({
    ...state,
    participants: state.participants.filter((id) => id !== event.id),
    subscriptions: state.subscriptions.filter(
      (s) => s.subscriberId !== event.id && s.targetId !== event.id,
    ),
    trends: state.trends.filter((trend) => trend.subscriberId !== event.id),
    ladders: state.ladders.filter((entry) => entry.from !== event.id),
    speakers: state.speakers.filter((entry) => entry.senderId !== event.id),
    encoderTiers: state.encoderTiers.filter((entry) => entry.targetId !== event.id),
    received: state.received.filter((mark) => mark.from !== event.id),
  });
}

/* ------------------------------------------------------------------------- */
/* タイマー・予算・報告                                                      */
/* ------------------------------------------------------------------------- */

function handleTimer(state: ShardState, t: number): StepResult {
  const windowed = maybeResetWindow(state, t);
  const stalled = detectAckTimeout(windowed, t);
  const evaluated = evaluateAll(stalled.state, t);
  // 上流（送信ノード）へ受信位置を返す。返さないと送信ノードの窓が開かない。
  const acks: ShardCommand[] = evaluated.state.received.map((mark) => ({
    kind: "ackUpstream" as const,
    to: mark.from,
    channel: mark.ch,
    spatialId: mark.sid,
    highestSeq: mark.highestSeq,
  }));
  return {
    state: evaluated.state,
    commands: [...stalled.commands, ...evaluated.commands, ...acks],
  };
}

/**
 * ack が途絶えた購読を検出する（congestion.md 7 節）。
 *
 * `ACK_TIMEOUT_MS` の間 `ack` が届かない購読は、切断されたものとして転送を止め、
 * 接続を閉じる。閉じない場合、既に居ない相手へ送り続けてノードの予算を食う。
 *
 * **未確認の媒体が無い購読は対象にしない。** 何も渡していない相手には返すべき ack が無い。
 * 対象にすると、まだ映像を送っていない参加者の接続を一斉に閉じてしまう。
 */
function detectAckTimeout(state: ShardState, t: number): StepResult {
  const commands: ShardCommand[] = [];
  const subscriptions: Subscription[] = [];
  for (const sub of state.subscriptions) {
    const outstanding = sub.highestSent > sub.highestAcked;
    if (!sub.stalled && !outstanding) {
      // **未確認が無い間は時計を進める**（ADR-0041）。
      //
      // 「無通信」と「無応答」は別である。購読してから長く媒体が流れない相手（音声が
      // 後から始まる、話し始めるまで送らない）では `lastAckAtMs` が購読の時刻のまま
      // 古くなる。そこへ最初の 1 件を渡すと、渡した直後に「`ACK_TIMEOUT_MS` の間 ack が
      // 無い」と判定され、**1 件目で停止扱いになり以後すべて捨てられた**（実測: 音声が
      // 40 秒後に流れ始めた購読が `stalled: true` になり、6 個のうち 1 個しか届かなかった。
      // F-060）。時限は「未確認が生じた時点」から数えなければならない。
      subscriptions.push({ ...sub, lastAckAtMs: t });
      continue;
    }
    if (sub.stalled || t - sub.lastAckAtMs < ACK_TIMEOUT_MS) {
      subscriptions.push(sub);
      continue;
    }
    subscriptions.push({ ...sub, stalled: true });
    commands.push({ kind: "disconnect", peer: sub.subscriberId });
  }
  // disconnect は購読者 ID の昇順で出す（購読の並びが昇順であるため自然に満たされる）。
  return { state: { ...state, subscriptions }, commands };
}

function handleBudget(state: ShardState, event: BudgetEvent, t: number): StepResult {
  return evaluateAll({ ...state, budgetBytesPerSec: event.bytesPerSec }, t);
}

function handleReport(state: ShardState, event: ReportEvent, t: number): StepResult {
  const slope: Slope = delaySlope(event.delayUs);
  const rest = state.trends.filter((entry) => entry.subscriberId !== event.from);
  const updated: ReceiverTrend = {
    subscriberId: event.from,
    numerator: slope.numerator,
    denominator: slope.denominator,
  };
  const trends = [...rest, updated].sort((a, b) => a.subscriberId - b.subscriberId);
  return evaluateAll({ ...state, trends }, t);
}

/* ------------------------------------------------------------------------- */
/* 輻輳状態の遷移（購読単位）                                                */
/* ------------------------------------------------------------------------- */

/**
 * すべての購読の輻輳状態を評価する。
 *
 * 購読ごとに独立に評価する。ある購読が KEY_ONLY でも、他の購読は NORMAL のままである
 * （congestion.md 7 節、ADR-0025 の 3）。
 */
function evaluateAll(state: ShardState, t: number): StepResult {
  const commands: ShardCommand[] = [];
  const subscriptions: Subscription[] = [];
  for (const sub of state.subscriptions) {
    const result = evaluateSubscription(state, sub, t);
    subscriptions.push(result.subscription);
    commands.push(...result.commands);
  }
  return { state: { ...state, subscriptions }, commands };
}

interface EvaluateResult {
  readonly subscription: Subscription;
  readonly commands: readonly ShardCommand[];
}

function evaluateSubscription(state: ShardState, sub: Subscription, t: number): EvaluateResult {
  // ヒステリシス: 現状態に入ってから SHEDDING_HYSTERESIS_MS 以内は遷移しない。
  // 振動を防ぐためである（state-machines.md 3 節）。
  if (t - sub.congestionEnteredAt < SHEDDING_HYSTERESIS_MS) {
    return { subscription: sub, commands: [] };
  }

  let next = sub.congestion;
  switch (sub.congestion) {
    case "NORMAL":
      if (
        fillGreater(state, sub, SHARD_UTIL_ENTER_T2_NUM, SHARD_UTIL_ENTER_T2_DEN) ||
        trendGreater(state, sub, SHARD_TREND_ENTER_T2_NUM, SHARD_TREND_ENTER_T2_DEN)
      ) {
        next = "SHEDDING_T2";
      }
      break;
    case "SHEDDING_T2":
      if (
        fillGreater(state, sub, SHARD_UTIL_ENTER_T1_NUM, SHARD_UTIL_ENTER_T1_DEN) ||
        trendGreater(state, sub, SHARD_TREND_ENTER_T1_NUM, SHARD_TREND_ENTER_T1_DEN)
      ) {
        next = "SHEDDING_T1";
      } else if (
        fillLess(state, sub, SHARD_UTIL_EXIT_T2_NUM, SHARD_UTIL_EXIT_T2_DEN) &&
        trendLess(state, sub, SHARD_TREND_EXIT_NUM, SHARD_TREND_EXIT_DEN)
      ) {
        next = "NORMAL";
      }
      break;
    case "SHEDDING_T1":
      if (
        fillGreater(state, sub, SHARD_UTIL_ENTER_SPATIAL_NUM, SHARD_UTIL_ENTER_SPATIAL_DEN) ||
        trendGreater(state, sub, SHARD_TREND_ENTER_SPATIAL_NUM, SHARD_TREND_ENTER_SPATIAL_DEN)
      ) {
        next = "SHEDDING_SPATIAL";
      } else if (
        fillLess(state, sub, SHARD_UTIL_EXIT_T1_NUM, SHARD_UTIL_EXIT_T1_DEN) &&
        trendLess(state, sub, SHARD_TREND_EXIT_NUM, SHARD_TREND_EXIT_DEN)
      ) {
        next = "SHEDDING_T2";
      }
      break;
    case "SHEDDING_SPATIAL":
      if (
        fillGreater(state, sub, SHARD_UTIL_ENTER_KEY_ONLY_NUM, SHARD_UTIL_ENTER_KEY_ONLY_DEN) ||
        trendGreater(state, sub, SHARD_TREND_ENTER_KEY_ONLY_NUM, SHARD_TREND_ENTER_KEY_ONLY_DEN)
      ) {
        next = "KEY_ONLY";
      } else if (
        fillLess(state, sub, SHARD_UTIL_EXIT_SPATIAL_NUM, SHARD_UTIL_EXIT_SPATIAL_DEN) &&
        trendLess(state, sub, SHARD_TREND_EXIT_NUM, SHARD_TREND_EXIT_DEN)
      ) {
        next = "SHEDDING_T1";
      }
      break;
    case "KEY_ONLY":
      if (
        fillLess(state, sub, SHARD_UTIL_EXIT_KEY_ONLY_NUM, SHARD_UTIL_EXIT_KEY_ONLY_DEN) &&
        trendLess(state, sub, SHARD_TREND_EXIT_KEY_ONLY_NUM, SHARD_TREND_EXIT_KEY_ONLY_DEN)
      ) {
        next = "SHEDDING_SPATIAL";
      }
      break;
  }

  if (next === sub.congestion) {
    return { subscription: sub, commands: [] };
  }

  // SHEDDING_SPATIAL 以降は段を 1 つ下げる。段を破棄すると画面が消える（ADR-0027 の 4）。
  const penalty = next === "SHEDDING_SPATIAL" || next === "KEY_ONLY" ? 1 : 0;
  const updated: Subscription = {
    ...sub,
    congestion: next,
    congestionEnteredAt: t,
    tierPenalty: penalty,
  };
  const commands: ShardCommand[] = [];
  if (penalty !== sub.tierPenalty) {
    // 渡す段が変わった。**購読者へ `setTier` を送ってはならない。**
    // `setTier` は「送信者に作らせる段の上限」を意味する指令であり（ADR-0022、
    // wire-format.md 2.7 の encoderDirective）、購読者に送ると「お前の符号化器を変えろ」
    // という意味になる。以前は同じコマンドを両方の意味で使っていたため、輻輳で段を
    // 下げると購読者の送信品質が落ちた。
    //
    // 購読者は段の変化を媒体そのものから知る（ヘッダの spatialId。復号器プールが
    // 段の切替を検出してキーフレームを待つ）。したがって通知は不要である。
    // 必要なのは送信者へのキーフレーム要求だけである（simulcast では別ストリームへ
    // 切り替わるため、下げる向きでもキーフレームが必要。ADR-0027 の 4）。
    commands.push({
      kind: "keyframeRequest",
      for: sub.targetId,
      channel: sub.channel,
      spatialId: chooseRung(state, updated),
    });
  }
  return { subscription: updated, commands };
}

/**
 * 送信窓の充填率が閾値を超えているか。
 *
 * 購読単位の輻輳の入力は「送信窓がどれだけ埋まっているか」である
 * （congestion.md 7 節が接続ごとに `inFlightMs` を持つと定めている）。
 * ノード全体の利用率を入力にしてはならない。遅い受信者 1 人が全体を落とすためである。
 *
 *   fill = inFlightMs / SEND_WINDOW_MS
 *   fill > num/den ⇔ 未確認フレーム数 × 1000 × den > num × SEND_WINDOW_MS × fps
 *
 * fps が分からない間（申告が未着）は fill を 0 とみなす。勾配のみで判定する。
 */
function fillGreater(state: ShardState, sub: Subscription, num: number, den: number): boolean {
  const framerate = framerateOf(state, sub);
  if (framerate <= 0) {
    return false;
  }
  const inFlight = inFlightFrames(sub, sub.highestSent);
  return inFlight * 1000 * den > num * SEND_WINDOW_MS * framerate;
}

function fillLess(state: ShardState, sub: Subscription, num: number, den: number): boolean {
  const framerate = framerateOf(state, sub);
  if (framerate <= 0) {
    // 充填率を評価できない。回復を妨げないため、条件を満たすとみなす。
    return num > 0;
  }
  const inFlight = inFlightFrames(sub, sub.highestSent);
  return inFlight * 1000 * den < num * SEND_WINDOW_MS * framerate;
}

/**
 * この購読者の遅延勾配が閾値を超えているか。
 *
 * **他の購読者の勾配は見ない。** 見ると、回線の悪い 1 人が全員の品質を落とす
 * （ADR-0025 の 4）。報告が無い場合は false（勾配が不明なら劣化と判定しない）。
 */
function trendGreater(state: ShardState, sub: Subscription, num: number, den: number): boolean {
  const trend = state.trends.find((entry) => entry.subscriberId === sub.subscriberId);
  if (trend === undefined) {
    return false;
  }
  // denominator は delaySlope の定義により常に正である（conformance.md 3.3）。
  return trend.numerator * den > num * trend.denominator;
}

/** 報告が無い場合は回復条件を満たすとみなす。 */
function trendLess(state: ShardState, sub: Subscription, num: number, den: number): boolean {
  const trend = state.trends.find((entry) => entry.subscriberId === sub.subscriberId);
  if (trend === undefined) {
    return true;
  }
  return trend.numerator * den < num * trend.denominator;
}

/* ------------------------------------------------------------------------- */
/* ノード全体の予算                                                          */
/* ------------------------------------------------------------------------- */

/**
 * ノード全体の予算超過を制御系へ通知する（ADR-0025 の 5）。
 *
 * **転送の可否には使わない。** 超過はシャードの再分割が必要な水準であり、
 * 個別の購読の問題ではない。同じ窓で繰り返し通知しない。
 */
function notifyNodeOverload(state: ShardState, t: number): StepResult {
  if (state.overloadNotified) {
    return { state, commands: [] };
  }
  const elapsed = t - state.windowStartMs;
  if (elapsed <= 0) {
    return { state, commands: [] };
  }
  const messagesOver = state.sentMessagesInWindow * 1000 > NODE_MAX_OUT_MESSAGES_PER_SEC * elapsed;
  const bytesOver = state.sentBytesInWindow * 1000 > state.budgetBytesPerSec * elapsed;
  if (!messagesOver && !bytesOver) {
    return { state, commands: [] };
  }
  return {
    state: { ...state, overloadNotified: true },
    commands: [{ kind: "notify", code: ERROR_DEFINITIONS.E_NODE_OVERLOADED.closeCode }],
  };
}

function maybeResetWindow(state: ShardState, t: number): ShardState {
  const elapsed = t - state.windowStartMs;
  if (elapsed >= SHARD_UTIL_WINDOW_MS) {
    return {
      ...state,
      sentBytesInWindow: 0,
      sentMessagesInWindow: 0,
      windowStartMs: t,
      overloadNotified: false,
    };
  }
  return state;
}

/* ------------------------------------------------------------------------- */
/* 観測のための補助（判断には使わない）                                      */
/* ------------------------------------------------------------------------- */

/** 指定した購読の現在の輻輳状態。試験と観測のために公開する。 */
export function congestionOf(
  state: ShardState,
  subscriberId: number,
  targetId: number,
  channel: number,
): CongestionState | undefined {
  return state.subscriptions.find(
    (s) => s.subscriberId === subscriberId && s.targetId === targetId && s.channel === channel,
  )?.congestion;
}

/** 指定した購読へ現在渡している段。試験と観測のために公開する。 */
export function chosenRungOf(
  state: ShardState,
  subscriberId: number,
  targetId: number,
  channel: number,
): number | undefined {
  const sub = state.subscriptions.find(
    (s) => s.subscriberId === subscriberId && s.targetId === targetId && s.channel === channel,
  );
  return sub === undefined ? undefined : chooseRung(state, sub);
}
