/**
 * 受信ノード（receiver）の判断コア。
 *
 * sans-IO の純関数状態機械。時刻・乱数・浮動小数点・入出力・並行に触れない。
 * 規範: state-machines.md 2 節（購読と tier）、congestion.md 4.3（tier の選択）、
 * conformance.md 4 節（入力イベントと出力コマンド）。
 *
 * 画質の判断主体は受信側ユーザー部屋である。この責務を他へ移してはならない。
 */

import {
  V_360P15,
  V_4K60,
  DISPLAY_SIZE_UNSPECIFIED_SPATIAL_ID,
  SHARD_TREND_ENTER_T2_DEN,
  SHARD_TREND_ENTER_T2_NUM,
  SHARD_TREND_EXIT_DEN,
  SHARD_TREND_EXIT_NUM,
} from "./generated/constants.ts";
import { WARNING_DEFINITIONS } from "./generated/errors.ts";

/** 品質低下の警告。文言は利用側が国際化キーから作る（sdk-api.md 6 節）。 */
const DEGRADED_WARNING: keyof typeof WARNING_DEFINITIONS = "W_DEGRADED";
import { delaySlope, truncDiv, type Slope } from "./fixed.ts";

/** (senderId, channel) ごとの購読状態（state-machines.md 2 節）。 */
export type StreamPhase = "UNSUBSCRIBED" | "SUBSCRIBED" | "PAUSED";

/** 1 本のストリームの状態。 */
export interface StreamState {
  readonly senderId: number;
  readonly channel: number;
  readonly phase: StreamPhase;
  /** 現在要求している最大 spatialId。 */
  readonly spatialId: number;
  /** 現在要求している最大 temporalId。 */
  readonly temporalId: number;
  /** 利用側が申告した表示寸法（論理画素）。未申告は 0。 */
  readonly displayWidth: number;
}

export interface ReceiverState {
  /** senderId, channel の昇順で保持する。反復順序が判断に影響するため決定的にする。 */
  readonly streams: readonly StreamState[];
  /** 受信者が表示中か。非表示なら購読を止める。 */
  readonly visible: boolean;
  /** 下り帯域の目標値（bytes/sec）。budget イベントで更新する。 */
  readonly targetBytesPerSec: number;
  /** 発話中の送信者。最低保証の対象である。 */
  readonly activeSpeakerId: number | null;
  /** 直近の遅延勾配。tier の上下に使う。 */
  readonly trend: Slope;
  /** 品質が最低保証を下回っているか。W_DEGRADED の通知に使う。 */
  readonly degraded: boolean;
  /** 表に無いイベントの記録。 */
  readonly unexpectedEvents: readonly string[];
  /**
   * (senderId, channel, spatialId) ごとに受信した最大の sequenceNumber。
   * 送信側が送信窓を計算するために ack で返す（congestion.md 2 節）。
   * senderId, channel, spatialId の昇順で保持する。
   */
  readonly received: readonly ReceivedMark[];
}

/** 受信済みの位置。ack の内容になる。 */
export interface ReceivedMark {
  readonly senderId: number;
  readonly channel: number;
  readonly spatialId: number;
  readonly highestSeq: number;
}

export interface SubscribeEntry {
  readonly senderId: number;
  readonly channel: number;
  readonly maxSpatialId: number;
  readonly maxTemporalId: number;
}

export type ReceiverEvent =
  | { readonly kind: "subscribe"; readonly entries: readonly SubscribeEntry[] }
  | { readonly kind: "leave"; readonly id: number }
  | { readonly kind: "visibility"; readonly visible: boolean }
  | { readonly kind: "budget"; readonly bytesPerSec: number }
  | { readonly kind: "activeSpeaker"; readonly id: number | null }
  | { readonly kind: "displaySize"; readonly senderId: number; readonly channel: number; readonly width: number }
  | { readonly kind: "report"; readonly delayUs: readonly number[] }
  | {
      readonly kind: "media";
      readonly from: number;
      readonly ch: number;
      readonly sid: number;
      readonly tid: number;
      readonly key: boolean;
      readonly bytes: number;
      readonly flags: number;
      /** 受信した sequenceNumber。ack の算出に使う。既定は 0（不明）。 */
      readonly seq?: number;
    }
  | { readonly kind: "timer" };

export type ReceiverCommand =
  | { readonly kind: "subscribeChange"; readonly to: number; readonly channel: number; readonly want: boolean; readonly maxSpatialId: number; readonly maxTemporalId: number }
  | { readonly kind: "keyframeRequest"; readonly for: number; readonly channel: number; readonly spatialId: number }
  | { readonly kind: "setTier"; readonly for: number; readonly channel: number; readonly tier: number }
  | { readonly kind: "forward"; readonly to: readonly number[] }
  | { readonly kind: "drop"; readonly priority: number; readonly count: number }
  | { readonly kind: "notify"; readonly code: string }
  | {
      readonly kind: "ack";
      readonly senderId: number;
      readonly channel: number;
      readonly spatialId: number;
      readonly highestSeq: number;
    };

export interface ReceiverStepResult {
  readonly state: ReceiverState;
  readonly commands: readonly ReceiverCommand[];
}

/** 受信者自身の識別子。転送先は常にこの 1 人である。 */
export const RECEIVER_SELF_ID = 0;

export function initialReceiverState(targetBytesPerSec: number): ReceiverState {
  return {
    streams: [],
    visible: true,
    targetBytesPerSec,
    activeSpeakerId: null,
    trend: { numerator: 0, denominator: 1 },
    degraded: false,
    unexpectedEvents: [],
    received: [],
  };
}

/** 純関数の状態遷移。 */
export function receiverStep(state: ReceiverState, event: ReceiverEvent): ReceiverStepResult {
  switch (event.kind) {
    case "subscribe":
      return handleSubscribe(state, event.entries);
    case "leave":
      return handleLeave(state, event.id);
    case "visibility":
      return handleVisibility(state, event.visible);
    case "budget":
      return reallocate({ ...state, targetBytesPerSec: event.bytesPerSec });
    case "activeSpeaker":
      return reallocate({ ...state, activeSpeakerId: event.id });
    case "displaySize":
      return handleDisplaySize(state, event.senderId, event.channel, event.width);
    case "report":
      return handleReport(state, event.delayUs);
    case "media":
      return handleMedia(state, event);
    case "timer":
      // ACK_INTERVAL_MS ごとに、受信済みの位置を ack として返す。
      // 呼び出し側が周期を管理する（コアは時刻を持たない）。
      return {
        state,
        commands: state.received.map((mark) => ({
          kind: "ack" as const,
          senderId: mark.senderId,
          channel: mark.channel,
          spatialId: mark.spatialId,
          highestSeq: mark.highestSeq,
        })),
      };
  }
}

/** 購読一覧の適用。表 1 行目と 2 行目に対応する。 */
function handleSubscribe(state: ReceiverState, entries: readonly SubscribeEntry[]): ReceiverStepResult {
  const commands: ReceiverCommand[] = [];
  const kept: StreamState[] = [];

  // 一覧に含まれるものを SUBSCRIBED にする。新規は購読要求とキーフレーム要求を出す。
  for (const entry of [...entries].sort(entryOrder)) {
    const existing = findStream(state, entry.senderId, entry.channel);
    if (existing === undefined || existing.phase === "UNSUBSCRIBED") {
      commands.push({
        kind: "subscribeChange",
        to: entry.senderId,
        channel: entry.channel,
        want: true,
        maxSpatialId: entry.maxSpatialId,
        maxTemporalId: entry.maxTemporalId,
      });
      commands.push({
        kind: "keyframeRequest",
        for: entry.senderId,
        channel: entry.channel,
        spatialId: entry.maxSpatialId,
      });
      kept.push({
        senderId: entry.senderId,
        channel: entry.channel,
        phase: "SUBSCRIBED",
        spatialId: entry.maxSpatialId,
        temporalId: entry.maxTemporalId,
        displayWidth: existing?.displayWidth ?? 0,
      });
      continue;
    }
    kept.push({ ...existing, phase: "SUBSCRIBED" });
  }

  // 一覧から外れたものは購読解除する（表 2 行目）。
  for (const stream of state.streams) {
    const stillWanted = entries.some(
      (entry) => entry.senderId === stream.senderId && entry.channel === stream.channel,
    );
    if (!stillWanted && stream.phase !== "UNSUBSCRIBED") {
      commands.push({
        kind: "subscribeChange",
        to: stream.senderId,
        channel: stream.channel,
        want: false,
        maxSpatialId: 0,
        maxTemporalId: 0,
      });
    }
  }

  const next = reallocate({ ...state, streams: kept.sort(streamOrder) });
  return { state: next.state, commands: [...commands, ...next.commands] };
}

/** 送信者の退出。表 6 行目に対応する。 */
function handleLeave(state: ReceiverState, id: number): ReceiverStepResult {
  const streams = state.streams.filter((stream) => stream.senderId !== id);
  if (streams.length === state.streams.length) {
    return { state, commands: [] };
  }
  // 退出者の受信位置も除去する。残すと居ない相手へ ack を返し続ける。
  const received = state.received.filter((mark) => mark.senderId !== id);
  return reallocate({ ...state, streams, received });
}

/** 表示・非表示。表 7 行目と 8 行目に対応する。 */
function handleVisibility(state: ReceiverState, visible: boolean): ReceiverStepResult {
  if (visible === state.visible) {
    return { state, commands: [] };
  }
  const commands: ReceiverCommand[] = [];
  const streams: StreamState[] = [];
  for (const stream of state.streams) {
    if (!visible && stream.phase === "SUBSCRIBED") {
      // 非表示では購読を解除するが、状態は保持する（PAUSED）。
      commands.push({
        kind: "subscribeChange",
        to: stream.senderId,
        channel: stream.channel,
        want: false,
        maxSpatialId: 0,
        maxTemporalId: 0,
      });
      streams.push({ ...stream, phase: "PAUSED" });
      continue;
    }
    if (visible && stream.phase === "PAUSED") {
      commands.push({
        kind: "subscribeChange",
        to: stream.senderId,
        channel: stream.channel,
        want: true,
        maxSpatialId: stream.spatialId,
        maxTemporalId: stream.temporalId,
      });
      commands.push({
        kind: "keyframeRequest",
        for: stream.senderId,
        channel: stream.channel,
        spatialId: stream.spatialId,
      });
      streams.push({ ...stream, phase: "SUBSCRIBED" });
      continue;
    }
    streams.push(stream);
  }
  return { state: { ...state, visible, streams }, commands };
}

/** 表示寸法の申告。未申告の相手は最低品質に留める（ADR-0015）。 */
function handleDisplaySize(
  state: ReceiverState,
  senderId: number,
  channel: number,
  width: number,
): ReceiverStepResult {
  const existing = findStream(state, senderId, channel);
  if (existing === undefined) {
    return {
      state: { ...state, unexpectedEvents: [...state.unexpectedEvents, "displaySize"] },
      commands: [],
    };
  }
  const streams = state.streams.map((stream) =>
    stream.senderId === senderId && stream.channel === channel ? { ...stream, displayWidth: width } : stream,
  );
  return reallocate({ ...state, streams });
}

/**
 * 測定報告。勾配が劣化閾値を超えたら tier を 1 段下げ、回復閾値を下回ったら 1 段上げる
 * （constants.md 6 節）。比較は整数の交差乗算で行う。
 */
function handleReport(state: ReceiverState, delayUs: readonly number[]): ReceiverStepResult {
  const trend = delaySlope(delayUs);
  const degrading = trend.numerator * SHARD_TREND_ENTER_T2_DEN > SHARD_TREND_ENTER_T2_NUM * trend.denominator;
  const recovering = trend.numerator * SHARD_TREND_EXIT_DEN < SHARD_TREND_EXIT_NUM * trend.denominator;
  if (!degrading && !recovering) {
    return { state: { ...state, trend }, commands: [] };
  }
  const delta = degrading ? -1 : 1;
  const commands: ReceiverCommand[] = [];
  const streams: StreamState[] = [];
  for (const stream of state.streams) {
    if (stream.phase !== "SUBSCRIBED") {
      streams.push(stream);
      continue;
    }
    const nextSpatial = clampSpatial(stream.spatialId + delta);
    if (nextSpatial === stream.spatialId) {
      streams.push(stream);
      continue;
    }
    streams.push({ ...stream, spatialId: nextSpatial });
    commands.push({ kind: "setTier", for: stream.senderId, channel: stream.channel, tier: nextSpatial });
    // spatialId が変わる場合のみキーフレームを要求する（表 4 行目と 3 行目の違い）。
    if (nextSpatial > stream.spatialId) {
      commands.push({
        kind: "keyframeRequest",
        for: stream.senderId,
        channel: stream.channel,
        spatialId: nextSpatial,
      });
    }
  }
  return { state: { ...state, trend, streams }, commands };
}

/** メディアの転送。要求 tier を超えるユニットは転送しない。 */
function handleMedia(
  state: ReceiverState,
  event: Extract<ReceiverEvent, { kind: "media" }>,
): ReceiverStepResult {
  const stream = findStream(state, event.from, event.ch);
  if (stream === undefined || stream.phase !== "SUBSCRIBED") {
    return { state, commands: [] };
  }
  if (event.sid > stream.spatialId || event.tid > stream.temporalId) {
    return { state, commands: [{ kind: "drop", priority: 1, count: 1 }] };
  }
  // 受信した位置を記録する。ack はタイマーでまとめて返す（congestion.md 2 節）。
  // フレームごとに返さない理由は、メッセージレートが中継ノードの制約であるためである。
  return { state: markReceived(state, event), commands: [{ kind: "forward", to: [RECEIVER_SELF_ID] }] };
}

/**
 * 帯域予算から tier を配分する（congestion.md 4.3）。
 *
 *   budget = target × 9/10          ヘッダと制御の余裕を 10% 取る
 *   高品質の人数 = floor(budget / 高品質プロファイルのビットレート)
 *   残りはサムネイル
 *   いずれにも足りない場合は発話者 1 人のサムネイルのみ
 *
 * 除算は整数で行い、切り捨てる。浮動小数点を使わない（ADR-0017）。
 */
function reallocate(state: ReceiverState): ReceiverStepResult {
  const commands: ReceiverCommand[] = [];
  // bytes/sec を bits/sec に直して比較する。8 倍は整数演算である。
  // なぜ truncDiv を使うか: `/` は浮動小数点除算であり、言語間で丸めが一致しない。
  // 整数除算（切り捨て）に限定する（ADR-0017）。
  const budgetResult = truncDiv(state.targetBytesPerSec * 8 * 9, 10);
  const budgetBps = budgetResult.ok ? budgetResult.value : 0;
  const highQualityResult = truncDiv(budgetBps, V_4K60.targetBitrate);
  const highQualityCount = highQualityResult.ok ? highQualityResult.value : 0;
  const thumbnailCost = V_360P15.targetBitrate;

  const video = state.streams.filter((stream) => stream.phase === "SUBSCRIBED");
  const ordered = [...video].sort((a, b) => priorityOrder(state, a, b));

  const streams: StreamState[] = [];
  let assignedHigh = 0;
  let remaining = budgetBps;
  let degraded = false;

  for (const stream of state.streams) {
    if (stream.phase !== "SUBSCRIBED") {
      streams.push(stream);
      continue;
    }
    const rank = ordered.findIndex(
      (candidate) => candidate.senderId === stream.senderId && candidate.channel === stream.channel,
    );
    let nextSpatial: number;
    if (stream.displayWidth === 0) {
      // 表示寸法の申告が無い相手は最低品質に留める（ADR-0015）。
      nextSpatial = DISPLAY_SIZE_UNSPECIFIED_SPATIAL_ID;
    } else if (assignedHigh < highQualityCount && rank < highQualityCount) {
      nextSpatial = V_4K60.spatialId;
      assignedHigh += 1;
      remaining -= V_4K60.targetBitrate;
    } else if (remaining >= thumbnailCost) {
      nextSpatial = V_360P15.spatialId;
      remaining -= thumbnailCost;
    } else {
      // 予算が尽きた。発話者のサムネイルのみを維持する（最低保証）。
      nextSpatial = V_360P15.spatialId;
      degraded = true;
    }
    if (nextSpatial !== stream.spatialId) {
      commands.push({ kind: "setTier", for: stream.senderId, channel: stream.channel, tier: nextSpatial });
      if (nextSpatial > stream.spatialId) {
        // spatialId が上がる場合はエンコーダ出力が切り替わるためキーフレームが必要である。
        commands.push({
          kind: "keyframeRequest",
          for: stream.senderId,
          channel: stream.channel,
          spatialId: nextSpatial,
        });
      }
    }
    streams.push({ ...stream, spatialId: nextSpatial });
  }

  if (degraded && !state.degraded) {
    // 最低保証（発話者のサムネイル 1 本と全員の音声）を下回った。利用側へ警告する。
    commands.push({ kind: "notify", code: DEGRADED_WARNING });
  }

  return { state: { ...state, streams: streams.sort(streamOrder), degraded }, commands };
}

/** 発話者を先に、次に senderId の昇順で並べる。順序は決定的でなければならない。 */
function priorityOrder(state: ReceiverState, a: StreamState, b: StreamState): number {
  const aSpeaker = state.activeSpeakerId === a.senderId ? 0 : 1;
  const bSpeaker = state.activeSpeakerId === b.senderId ? 0 : 1;
  if (aSpeaker !== bSpeaker) {
    return aSpeaker - bSpeaker;
  }
  if (a.senderId !== b.senderId) {
    return a.senderId - b.senderId;
  }
  return a.channel - b.channel;
}

/**
 * 受信した位置を更新する。後戻りする値では更新しない。
 * 順序は senderId, channel, spatialId の昇順に保つ（決定性のため）。
 */
function markReceived(state: ReceiverState, event: Extract<ReceiverEvent, { kind: "media" }>): ReceiverState {
  const seq = event.seq ?? 0;
  if (seq <= 0) {
    return state;
  }
  const existing = state.received.find(
    (mark) => mark.senderId === event.from && mark.channel === event.ch && mark.spatialId === event.sid,
  );
  if (existing !== undefined && existing.highestSeq >= seq) {
    return state;
  }
  const rest = state.received.filter(
    (mark) => !(mark.senderId === event.from && mark.channel === event.ch && mark.spatialId === event.sid),
  );
  const merged = [...rest, { senderId: event.from, channel: event.ch, spatialId: event.sid, highestSeq: seq }].sort(
    (a, b) =>
      a.senderId !== b.senderId
        ? a.senderId - b.senderId
        : a.channel !== b.channel
          ? a.channel - b.channel
          : a.spatialId - b.spatialId,
  );
  return { ...state, received: merged };
}

function streamOrder(a: StreamState, b: StreamState): number {
  return a.senderId !== b.senderId ? a.senderId - b.senderId : a.channel - b.channel;
}

function entryOrder(a: SubscribeEntry, b: SubscribeEntry): number {
  return a.senderId !== b.senderId ? a.senderId - b.senderId : a.channel - b.channel;
}

function findStream(state: ReceiverState, senderId: number, channel: number): StreamState | undefined {
  return state.streams.find((stream) => stream.senderId === senderId && stream.channel === channel);
}

/** spatialId の範囲は最低品質から最高品質までである。 */
function clampSpatial(value: number): number {
  if (value < V_360P15.spatialId) {
    return V_360P15.spatialId;
  }
  if (value > V_4K60.spatialId) {
    return V_4K60.spatialId;
  }
  return value;
}

