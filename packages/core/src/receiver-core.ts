/**
 * 受信ノード（receiver）の判断コア。
 *
 * sans-IO の純関数状態機械。時刻・乱数・浮動小数点・入出力・並行に触れない。
 * 規範: state-machines.md 2 節（購読と tier）、congestion.md 4.1・4.2・4.3、
 *       conformance.md 4 節、ADR-0027（はしごの利用）、ADR-0029（狭帯域では音声を守る）。
 *
 * 画質の判断主体は受信側ユーザー部屋である。この責務を他へ移してはならない。
 *
 * 設計の要点は 4 つである。
 *
 * 1. **費用は送信者の申告ビットレートで見積もる。** 大域のプロファイル表を使ってはならない。
 *    720p30 しか送れない端末を 25 Mbps で見積もると、予算の計算が実体と合わない（ADR-0027 の 2）。
 * 2. **表示寸法が段の上限を決める。** 160 px のタイルが 4K を引いてはならない。
 *    これが「サムネイルはサムネイルの費用で済む」を成立させる唯一の仕組みである。
 * 3. **初期状態は常に最低である。** 参加直後に最上段を要求すると、細い回線では最初の
 *    1 秒で詰まる。goodput が観測できてから AIMD で上げる（ADR-0028 の原則、congestion.md 6 節）。
 * 4. **帯域が足りないときは映像を捨てて音声を守る。** 映像を維持すると破棄禁止の音声が
 *    遅延し、会話が壊れる（ADR-0029）。
 */

import {
  MAX_UNEXPECTED_EVENTS,
  AUDIO_ONLY_ENTER_BPS,
  AUDIO_ONLY_EXIT_BPS,
  MIN_VIABLE_BPS,
  RATE_HOLD_MS,
  RATE_PROBE_BPS,
  RATE_RECOVER_STREAK,
  SHARD_TREND_ENTER_T2_DEN,
  SHARD_TREND_ENTER_T2_NUM,
  SHARD_TREND_EXIT_DEN,
  SHARD_TREND_EXIT_NUM,
} from "./generated/constants.ts";
import { WARNING_DEFINITIONS } from "./generated/errors.ts";
import { CHANNEL_AUDIO, CHANNEL_SCREEN_AUDIO } from "./generated/wire-layout.ts";
import { delaySlope, truncDiv, type Slope } from "./fixed.ts";

/** 品質低下の警告。文言は利用側が国際化キーから作る（sdk-api.md 6 節）。 */
const DEGRADED_WARNING: keyof typeof WARNING_DEFINITIONS = "W_DEGRADED";

/**
 * (senderId, channel) ごとの購読状態（state-machines.md 2 節）。
 *
 * `AUDIO_ONLY` は ADR-0029 で追加した。映像の購読を落として音声だけを維持する状態である。
 * `PAUSED`（非表示）と区別する理由は、復帰の条件が違うことである。`PAUSED` は表示に戻れば
 * 復帰し、`AUDIO_ONLY` は帯域が戻れば復帰する。
 */
export type StreamPhase = "UNSUBSCRIBED" | "SUBSCRIBED" | "PAUSED" | "AUDIO_ONLY";

/** 1 本のストリームの状態。 */
export interface StreamState {
  readonly senderId: number;
  readonly channel: number;
  readonly phase: StreamPhase;
  /** 現在要求している段番号（ADR-0026）。 */
  readonly spatialId: number;
  /** 現在要求している最大 temporalId。 */
  readonly temporalId: number;
  /** 利用側が申告した表示寸法（論理画素）。未申告は 0。 */
  readonly displayWidth: number;
}

/** カタログの 1 段。`streamCatalog` から取り込む（ADR-0027 の 1）。 */
export interface CatalogRung {
  readonly sid: number;
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
  readonly temporalLayers: number;
  readonly targetBitrate: number;
}

/** 送信者 1 人・1 チャネルのはしご。 */
export interface CatalogLadder {
  readonly senderId: number;
  readonly channel: number;
  /** sid の昇順で保持する。 */
  readonly rungs: readonly CatalogRung[];
}

export interface ReceiverState {
  /** senderId, channel の昇順で保持する。反復順序が判断に影響するため決定的にする。 */
  readonly streams: readonly StreamState[];
  /** 会議全体のはしご。senderId, channel の昇順で保持する。 */
  readonly catalog: readonly CatalogLadder[];
  /** 受信者が表示中か。非表示なら購読を止める。 */
  readonly visible: boolean;
  /** 下り帯域の目標値（bytes/sec）。report の goodput から更新する。 */
  readonly targetBytesPerSec: number;
  /** 発話中の送信者。最低保証の対象である。 */
  readonly activeSpeakerId: number | null;
  /** 直近の遅延勾配。tier の上下に使う。 */
  readonly trend: Slope;
  /** 品質が最低保証を下回っているか。W_DEGRADED の通知に使う。 */
  readonly degraded: boolean;
  /** 音声だけの状態か（ADR-0029）。 */
  readonly audioOnly: boolean;
  /**
   * 次に減少の判定を行える時刻（AIMD。congestion.md 4.2）。
   * 劣化で減らした直後は RATE_HOLD_MS 待つ。待たないと 1 回の揺れで連続して落ちる。
   */
  readonly rateHoldUntilMs: number;
  /**
   * 回復判定が連続した回数。規範は「3 回連続」で加算的増加を許す。
   * 1 回の回復で増やすと、利用可能帯域の境界で振動する。
   */
  readonly recoverStreak: number;
  /**
   * 観測した goodput の最大値（bytes/sec）。**観測であり、上限ではない。**
   *
   * 規範 4.1 は「goodput は下限としてのみ使う。上限の推定には使わない」と定める。
   * この値で目標を切ってはならない。中継ノードは目標の分しか転送しないため、
   * goodput は目標を超えず、切ると目標が最低成立点に張り付く（実測。`desiredCostBytesPerSec`
   * の注記）。観測として持つのは、届いた量を観測項目として報告するためである
   * （`observability.md`）。
   */
  readonly targetCeilingBytesPerSec: number;
  /** 表に無いイベントの記録。 */
  readonly unexpectedEvents: readonly string[];
  /**
   * (senderId, channel, spatialId) ごとに受信した最大の sequenceNumber。
   * 送信側が送信窓を計算するために ack で返す（congestion.md 2 節）。
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
  | { readonly kind: "goodput"; readonly bytesPerSec: number }
  | { readonly kind: "activeSpeaker"; readonly id: number | null }
  | { readonly kind: "catalog"; readonly entries: readonly CatalogLadder[] }
  | { readonly kind: "displaySize"; readonly senderId: number; readonly channel: number; readonly width: number }
  | { readonly kind: "report"; readonly delayUs: readonly number[] }
  /**
   * 購読者（クライアント）からのキーフレーム要求（ADR-0039）。
   *
   * 会議の途中で購読を張ると最初に届くのは差分フレームであり、復号器はキーフレームまで
   * 何も出せない。以前はこの事象が無く、クライアントの要求は受信ノードで捨てられていた
   * ため、**そのまま永久に何も表示されなかった**（F-053）。
   *
   * 間隔制限は出力コマンドの実行側が持つ（`rate-limit.ts`）。コアは要求をそのまま
   * `keyframeRequest` コマンドに直す。
   */
  | {
      readonly kind: "keyframeRequest";
      readonly senderId: number;
      readonly channel: number;
      readonly spatialId: number;
    }
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
  | {
      readonly kind: "subscribeChange";
      readonly to: number;
      readonly channel: number;
      readonly want: boolean;
      readonly maxSpatialId: number;
      readonly maxTemporalId: number;
    }
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

/**
 * 初期状態。
 *
 * **目標は最低から始める。** 引数を取らない理由は、初期値を呼び出し側に委ねると
 * ノードの送出容量（280 MB/s）のような無関係な値を渡す誤りが起きることである
 * （実際に起きた）。開始点は規範が定める最低の成立点である。
 */
export function initialReceiverState(): ReceiverState {
  const floorBytes = truncDiv(MIN_VIABLE_BPS, 8);
  const floor = floorBytes.ok ? floorBytes.value : 0;
  return {
    streams: [],
    catalog: [],
    visible: true,
    targetBytesPerSec: floor,
    activeSpeakerId: null,
    trend: { numerator: 0, denominator: 1 },
    degraded: false,
    audioOnly: false,
    rateHoldUntilMs: 0,
    recoverStreak: 0,
    targetCeilingBytesPerSec: floor,
    unexpectedEvents: [],
    received: [],
  };
}

/**
 * 純関数の状態遷移。
 *
 * 時刻を引数で受ける理由: AIMD の減少には RATE_HOLD_MS の待ちがある（congestion.md 4.2）。
 * コアは時計を持たないため、呼び出し側が観測した時刻を渡す（中継ノードの step と同じ形）。
 */
export function receiverStep(state: ReceiverState, event: ReceiverEvent, t = 0): ReceiverStepResult {
  switch (event.kind) {
    case "subscribe":
      return handleSubscribe(state, event.entries);
    case "leave":
      return handleLeave(state, event.id);
    case "visibility":
      return handleVisibility(state, event.visible);
    case "budget":
      return handleBudget(state, event.bytesPerSec);
    case "goodput":
      return handleGoodput(state, event.bytesPerSec);
    case "activeSpeaker":
      return reallocate({ ...state, activeSpeakerId: event.id });
    case "catalog":
      return handleCatalog(state, event.entries);
    case "displaySize":
      return handleDisplaySize(state, event.senderId, event.channel, event.width);
    case "report":
      return handleReport(state, event.delayUs, t);
    case "keyframeRequest":
      // 判断は無い。要求をコマンドへ直すだけである（間隔制限は実行側）。
      return {
        state,
        commands: [
          {
            kind: "keyframeRequest",
            for: event.senderId,
            channel: event.channel,
            spatialId: event.spatialId,
          },
        ],
      };
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

/* ------------------------------------------------------------------------- */
/* 帯域とカタログ                                                            */
/* ------------------------------------------------------------------------- */

/**
 * 下り帯域の観測（goodput 由来。congestion.md 4.1）。
 *
 * goodput は**上限の推定には使わない**。送信側が帯域を使い切っていない場合、goodput は
 * 利用可能帯域より小さくなる。上限として使うと品質が下がったまま戻らない。
 * したがって観測値は「これまでに見た最大」として天井を押し上げるだけに使う。
 */
function handleBudget(state: ReceiverState, bytesPerSec: number): ReceiverStepResult {
  const ceiling =
    bytesPerSec > state.targetCeilingBytesPerSec ? bytesPerSec : state.targetCeilingBytesPerSec;
  return reallocate({ ...state, targetBytesPerSec: bytesPerSec, targetCeilingBytesPerSec: ceiling });
}

/**
 * 観測した goodput（congestion.md 4.1）。
 *
 * **これは目標の指定ではない。** goodput は「少なくともこれだけは通った」ことしか語らない。
 * 送信側が帯域を使い切っていない間、goodput は利用可能帯域より小さい。目標へ代入すると、
 * 映像が一瞬止まっただけで目標が 0 に近づき、`AUDIO_ONLY` へ落ちて**二度と映像に戻らない**
 * （実測: 目標が 5 バイト/秒まで潰れ、映像の購読が解除された）。
 *
 * したがって goodput は**天井を押し上げ、目標を上げる方向にだけ**使う。下げるのは輻輳の
 * 信号（遅延勾配）に対する AIMD だけである。
 */
function handleGoodput(state: ReceiverState, bytesPerSec: number): ReceiverStepResult {
  if (bytesPerSec <= 0) {
    return { state, commands: [] };
  }
  const ceiling =
    bytesPerSec > state.targetCeilingBytesPerSec ? bytesPerSec : state.targetCeilingBytesPerSec;
  // 規範 4.1 は `available = max(goodput, 現在の目標レート)` と定める。**天井で切らない。**
  // 天井は「これまでに見た最大の goodput」であり、中継ノードは目標の分しか転送しないため
  // 常に目標以下に留まる。ここで切ると目標は最低成立点から一生上がらない（実測の記録は
  // `desiredCostBytesPerSec` の注記にある）。
  const target = bytesPerSec > state.targetBytesPerSec ? bytesPerSec : state.targetBytesPerSec;
  if (target === state.targetBytesPerSec && ceiling === state.targetCeilingBytesPerSec) {
    return { state, commands: [] };
  }
  return reallocate({ ...state, targetBytesPerSec: target, targetCeilingBytesPerSec: ceiling });
}

function handleCatalog(state: ReceiverState, entries: readonly CatalogLadder[]): ReceiverStepResult {
  const normalized = entries
    .map((entry) => ({
      senderId: entry.senderId,
      channel: entry.channel,
      rungs: [...entry.rungs].sort((a, b) => a.sid - b.sid),
    }))
    .sort((a, b) => (a.senderId !== b.senderId ? a.senderId - b.senderId : a.channel - b.channel));
  // はしごが変わると段の上限と費用が変わるため、配分を作り直す。
  return reallocate({ ...state, catalog: normalized });
}

function ladderOf(state: ReceiverState, senderId: number, channel: number): readonly CatalogRung[] {
  const entry = state.catalog.find((item) => item.senderId === senderId && item.channel === channel);
  return entry === undefined ? [] : entry.rungs;
}

/**
 * 表示寸法から要求すべき段の上限を返す。
 *
 * 規則: **表示幅以上の幅を持つ最小の段**。無ければ最上段。未申告（0 以下）は最下段。
 * カタログが無い相手は最下段に留める。知らない相手へ高い段を要求してはならない。
 */
function rungCapFor(state: ReceiverState, stream: StreamState): number {
  const rungs = ladderOf(state, stream.senderId, stream.channel);
  if (rungs.length === 0) {
    return 0;
  }
  let lowest = rungs[0];
  let top = rungs[0];
  for (const rung of rungs) {
    if (lowest === undefined || rung.sid < lowest.sid) {
      lowest = rung;
    }
    if (top === undefined || rung.sid > top.sid) {
      top = rung;
    }
  }
  if (lowest === undefined || top === undefined) {
    return 0;
  }
  if (stream.displayWidth <= 0) {
    return lowest.sid;
  }
  let best: CatalogRung | undefined;
  for (const rung of rungs) {
    if (rung.width < stream.displayWidth) {
      continue;
    }
    if (best === undefined || rung.width < best.width) {
      best = rung;
    }
  }
  return best === undefined ? top.sid : best.sid;
}

/**
 * いま望んでいる品質を全部受け取るのに要する量（bytes/sec）。
 *
 * 規範 4.2 は加算的増加の上限を「**現在のプロファイルの目標ビットレート**」と定める。
 * 購読が複数あるため、望む段（`rungCapFor`）の申告ビットレートの合計を上限とする。
 * 音声は段を持たないため、申告があるものをそのまま数える。
 *
 * **観測した goodput を上限にしてはならない**（規範 4.1）。中継ノードは目標の分しか
 * 転送しないため、goodput は目標を超えない。goodput で上限を作ると
 * 「目標 ≤ goodput ≤ 目標」の輪が閉じ、**目標は最低成立点から一生上がらない**。
 * 実測（2026-07-30、実環境・劣化なし）: 目標が 30,620 bytes/s（`MIN_VIABLE_BPS/8`）に
 * 張り付き、中継ノードが基底層 417 件を含む 842 件を捨てた。送信は 1,342 件、
 * 到着は 577 件だった。
 */
function desiredCostBytesPerSec(state: ReceiverState): number {
  let bits = 0;
  for (const stream of state.streams) {
    if (stream.phase !== "SUBSCRIBED") {
      continue;
    }
    if (isAudio(stream.channel)) {
      bits += costOf(state, stream, stream.spatialId);
      continue;
    }
    bits += costOf(state, stream, rungCapFor(state, stream));
  }
  const bytes = truncDiv(bits, 8);
  return bytes.ok ? bytes.value : 0;
}

/** 段の費用（bits/sec）。申告が無ければ 0（費用不明なら予算を減らさない）。 */
function costOf(state: ReceiverState, stream: StreamState, sid: number): number {
  for (const rung of ladderOf(state, stream.senderId, stream.channel)) {
    if (rung.sid === sid) {
      return rung.targetBitrate;
    }
  }
  return 0;
}

/** はしごの最下段。カタログが無ければ 0。 */
function lowestRung(state: ReceiverState, stream: StreamState): number {
  const rungs = ladderOf(state, stream.senderId, stream.channel);
  let lowest = -1;
  for (const rung of rungs) {
    if (lowest < 0 || rung.sid < lowest) {
      lowest = rung.sid;
    }
  }
  return lowest < 0 ? 0 : lowest;
}

/** はしごの最上段。カタログが無ければ 0。 */
function highestRung(state: ReceiverState, stream: StreamState): number {
  const rungs = ladderOf(state, stream.senderId, stream.channel);
  let top = -1;
  for (const rung of rungs) {
    if (rung.sid > top) {
      top = rung.sid;
    }
  }
  return top < 0 ? 0 : top;
}

function isAudio(channel: number): boolean {
  return channel === CHANNEL_AUDIO || channel === CHANNEL_SCREEN_AUDIO;
}

/* ------------------------------------------------------------------------- */
/* 購読                                                                      */
/* ------------------------------------------------------------------------- */

/** 購読一覧の適用。表 1 行目と 2 行目に対応する。 */
function handleSubscribe(state: ReceiverState, entries: readonly SubscribeEntry[]): ReceiverStepResult {
  const commands: ReceiverCommand[] = [];
  const kept: StreamState[] = [];

  for (const entry of [...entries].sort(entryOrder)) {
    const existing = findStream(state, entry.senderId, entry.channel);
    if (existing === undefined || existing.phase === "UNSUBSCRIBED") {
      // **最下段から始める。** 参加直後に要求の上限（`maxSpatialId`）を要求すると、
      // 細い回線では最初の 1 秒で詰まる。段は goodput と表示寸法に応じて `reallocate` が
      // 上げる（congestion.md 6 節、ADR-0028 の原則）。
      const start = isAudio(entry.channel)
        ? 0
        : lowestRung(state, {
            senderId: entry.senderId,
            channel: entry.channel,
            phase: "SUBSCRIBED",
            spatialId: 0,
            temporalId: 0,
            displayWidth: 0,
          });
      commands.push({
        kind: "subscribeChange",
        to: entry.senderId,
        channel: entry.channel,
        want: true,
        maxSpatialId: start,
        maxTemporalId: entry.maxTemporalId,
      });
      commands.push({
        kind: "keyframeRequest",
        for: entry.senderId,
        channel: entry.channel,
        spatialId: start,
      });
      kept.push({
        senderId: entry.senderId,
        channel: entry.channel,
        phase: "SUBSCRIBED",
        spatialId: start,
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
  // 退出者の受信位置とはしごも除去する。残すと居ない相手へ ack を返し続ける。
  const received = state.received.filter((mark) => mark.senderId !== id);
  const catalog = state.catalog.filter((entry) => entry.senderId !== id);
  return reallocate({ ...state, streams, received, catalog });
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
      state: { ...state, unexpectedEvents: appendUnexpected(state.unexpectedEvents, "displaySize") },
      commands: [],
    };
  }
  const streams = state.streams.map((stream) =>
    stream.senderId === senderId && stream.channel === channel ? { ...stream, displayWidth: width } : stream,
  );
  return reallocate({ ...state, streams });
}

/* ------------------------------------------------------------------------- */
/* 報告と AIMD                                                               */
/* ------------------------------------------------------------------------- */

/**
 * 遅延の報告に対する応答。**規範は 2 つの層を定めている**（X-037）。
 *
 * 1. 状態機械（state-machines.md 3 節）: 遅延勾配が閾値を超えたら **tier を 1 段下げる**。
 *    回復したら 1 段上げる。これは即応の制御である。
 * 2. 輻輳制御（congestion.md 4.2 の AIMD）: **target（帯域目標）**を劣化時に 0.85 倍し、
 *    回復が 3 回連続したら RATE_PROBE_BPS を加える。これは目標値の収束である。
 *
 * 両方を行う。tier は即応、target は収束であり、役割が違う。
 *
 * 0.85 は浮動小数点で計算しない。`target × 17 / 20` の整数演算とし、除算は切り捨てる
 * （congestion.md 4.1.1、ADR-0017）。9 言語で同じ値を出す必要がある。
 */
function handleReport(
  state: ReceiverState,
  delayUs: readonly number[],
  t: number,
): ReceiverStepResult {
  // **標本が 2 個未満では勾配が定まらない。** 定まらない値で AIMD を動かすと、
  // 媒体が止まっている間も「劣化している」と読み続けて目標が潰れる（実測）。
  // 観測が無いことは輻輳の信号ではない。
  if (delayUs.length < 2) {
    return { state, commands: [] };
  }
  const trend = delaySlope(delayUs);
  const degrading = trend.numerator * SHARD_TREND_ENTER_T2_DEN > SHARD_TREND_ENTER_T2_NUM * trend.denominator;
  const recovering = trend.numerator * SHARD_TREND_EXIT_DEN < SHARD_TREND_EXIT_NUM * trend.denominator;

  let target = state.targetBytesPerSec;
  let holdUntil = state.rateHoldUntilMs;
  let streak = state.recoverStreak;
  if (degrading) {
    streak = 0;
    // 待ちの間は減らさない。1 回の揺れで連続して落とさないためである。
    if (t >= state.rateHoldUntilMs) {
      const reduced = truncDiv(target * 17, 20);
      const lowered = reduced.ok ? reduced.value : target;
      // **予兆で最低成立点を割らない**（ADR-0040）。
      //
      // 遅延の勾配は「待ち行列が育っている」という**予兆**であり、実測した通過量では
      // ない。予兆で `MIN_VIABLE_BPS` を割ると、初期状態がちょうどこの点にあるため
      // 1 度の減少で `AUDIO_ONLY`（ADR-0029）へ落ち、映像が全部止まる。実測では
      // 3 回に 1 回この経路に入った（F-054）。音声だけにするのは、**実測した予算**
      // （`budget` 事象）が最低を下回ったときに限る。
      const floorResult = truncDiv(MIN_VIABLE_BPS, 8);
      const floor = floorResult.ok ? floorResult.value : 0;
      target = lowered < floor ? floor : lowered;
      holdUntil = t + RATE_HOLD_MS;
    }
  } else if (recovering) {
    streak = state.recoverStreak + 1;
    if (streak >= RATE_RECOVER_STREAK) {
      const probeBytes = truncDiv(RATE_PROBE_BPS, 8);
      const raised = target + (probeBytes.ok ? probeBytes.value : 0);
      // 上限は**望む品質の申告ビットレート**である（規範 4.2）。観測した goodput を
      // 上限にすると輪が閉じて目標が上がらない（`desiredCostBytesPerSec` の注記）。
      // 申告がまだ無い（カタログ未着）間は上限を作らない。知らないことは制約ではない。
      const declared = desiredCostBytesPerSec(state);
      // **上限が最低成立点を下回ってはならない**（ADR-0040）。最下段の申告（200 kbps）は
      // `MIN_VIABLE_BPS`（音声を含む 244,960）より小さい。申告だけで切ると目標が
      // 最低成立点の下へ押し戻され、`AUDIO_ONLY` の出入りを往復する（実測で振動した）。
      const floorForCap = truncDiv(MIN_VIABLE_BPS, 8);
      const minimum = floorForCap.ok ? floorForCap.value : 0;
      const cap = declared > 0 && declared < minimum ? minimum : declared;
      target = cap > 0 && raised > cap ? cap : raised;
      streak = 0;
    }
  } else {
    // 増減の条件を満たさない。連続回数を切る（間に非回復が入れば数え直す）。
    streak = 0;
  }

  const afterRate: ReceiverState = {
    ...state,
    trend,
    targetBytesPerSec: target,
    rateHoldUntilMs: holdUntil,
    recoverStreak: streak,
  };

  if (!degrading && !recovering) {
    return { state: afterRate, commands: [] };
  }

  // --- 状態機械（state-machines.md 3 節）。tier を 1 段動かす ---
  const delta = degrading ? -1 : 1;
  const commands: ReceiverCommand[] = [];
  const streams: StreamState[] = [];
  for (const stream of afterRate.streams) {
    if (stream.phase !== "SUBSCRIBED" || isAudio(stream.channel)) {
      // 音声には段が無い。輻輳でも音声の段を動かしてはならない。
      streams.push(stream);
      continue;
    }
    const floor = lowestRung(afterRate, stream);
    // 上限は「表示寸法から決まる段」と「はしごの最上段」の小さい方である。
    // 勾配が回復しても、表示が小さいままなら上げてはならない。
    const cap = rungCapFor(afterRate, stream);
    const raw = stream.spatialId + delta;
    const nextSpatial = raw < floor ? floor : raw > cap ? cap : raw;
    if (nextSpatial === stream.spatialId) {
      streams.push(stream);
      continue;
    }
    streams.push({ ...stream, spatialId: nextSpatial });
    commands.push({ kind: "setTier", for: stream.senderId, channel: stream.channel, tier: nextSpatial });
    // 段が変わるとエンコーダの別ストリームへ切り替わるためキーフレームが必要である。
    // simulcast では下げる向きでも必要である（ADR-0027 の 4）。
    commands.push({
      kind: "keyframeRequest",
      for: stream.senderId,
      channel: stream.channel,
      spatialId: nextSpatial,
    });
  }
  const stepped: ReceiverState = { ...afterRate, streams };
  if (target === state.targetBytesPerSec) {
    return { state: stepped, commands };
  }
  // **音声だけの状態の出入りだけをやり直す**（規範 4.3、ADR-0029）。
  //
  // なぜ配分の全部をやり直さないか: 段は輻輳の状態機械が 1 段ずつ動かす
  // （`state-machines.md` 3 節）。`reallocate` は「買える最良の段」を選ぶため、予算が
  // 潤沢な回線では**遅延勾配による降格を直後に打ち消してしまう**（実測: 降格の試験で
  // 段が 2 から 1 へ下がらなくなった）。勾配は予算に現れない詰まりの予兆であり、
  // 予算の都合で無かったことにしてはならない。
  //
  // なぜ音声だけの出入りはやり直すか: その判断は `reallocate` にしか無い。報告の経路で
  // 呼ばなければ、回復の勾配がいくら続いても映像が戻らない（実測: 目標が 29,620 →
  // 154,620 bytes/s まで回復しても `audioOnly` が true のままで、購読の命令が 1 件も
  // 出なかった）。**音声だけの会議から二度と戻れない。**
  if (!crossesAudioOnly(stepped)) {
    return { state: stepped, commands };
  }
  const reallocated = reallocate(stepped);
  return { state: reallocated.state, commands: [...commands, ...reallocated.commands] };
}

/**
 * いまの目標が音声だけの状態の境界を跨いでいるか（ADR-0029 のヒステリシス）。
 *
 * 跨いでいる場合だけ配分をやり直す。判定は `reallocate` と同じ式でなければならないため、
 * 回線の速度（目標 × 8）で見る。予算（9/10）で見ると余裕を二重に引くことになる。
 */
function crossesAudioOnly(state: ReceiverState): boolean {
  const linkBps = state.targetBytesPerSec * 8;
  const wanted = state.audioOnly ? linkBps < AUDIO_ONLY_EXIT_BPS : linkBps < AUDIO_ONLY_ENTER_BPS;
  return wanted !== state.audioOnly;
}

/** メディアの転送。要求 tier を超えるユニットは転送しない。 */
function handleMedia(
  state: ReceiverState,
  event: Extract<ReceiverEvent, { kind: "media" }>,
): ReceiverStepResult {
  const stream = findStream(state, event.from, event.ch);
  if (stream === undefined || stream.phase !== "SUBSCRIBED") {
    // **音声は購読が未確立でも転送する（音声は破棄禁止）。**
    //
    // 音声と映像は別の部屋（`ar` と `vr`）を通り、購読の確立も別である。`vr` の購読が
    // 先に確立し、`ar` が後に確立する間に届いた音声がここで消える。また、upstream の
    // 確立が非同期であるため、`subscribe` を受け取った後でも `subscribeChange` が
    // shard に届くまでの間に音声が届くことがある。
    //
    // 映像は落として正しい（購読していない送信者の映像を復号器へ渡すと参照が壊れる）。
    // 音声は段を持たず、参照連鎖の制約が無いため、購読未確立でもクライアントへ渡して
    // よい。ack 位置も記録する（`markReceived` は `stream` に依存しない）。ack 位置が
    // 記録されれば shard の送信窓が進み、`stalled` になりにくくなる。
    if (isAudio(event.ch)) {
      return { state: markReceived(state, event), commands: [{ kind: "forward", to: [RECEIVER_SELF_ID] }] };
    }
    return { state, commands: [] };
  }
  if (event.sid > stream.spatialId || event.tid > stream.temporalId) {
    return { state, commands: [{ kind: "drop", priority: 1, count: 1 }] };
  }
  // 受信した位置を記録する。ack はタイマーでまとめて返す（congestion.md 2 節）。
  // フレームごとに返さない理由は、メッセージレートが中継ノードの制約であるためである。
  return { state: markReceived(state, event), commands: [{ kind: "forward", to: [RECEIVER_SELF_ID] }] };
}

/* ------------------------------------------------------------------------- */
/* 段の配分（congestion.md 4.3、ADR-0027、ADR-0029）                          */
/* ------------------------------------------------------------------------- */

/**
 * 帯域予算から段を配分する。
 *
 * ```
 * budget = target × 8 × 9/10          ヘッダと制御の余裕を 10% 取る
 * budget < AUDIO_ONLY_ENTER_BPS       → 映像を落として音声だけにする（ADR-0029）
 * それ以外                            → 発話者優先の順に、表示寸法の上限まで予算で買う
 * ```
 *
 * 費用は**送信者の申告ビットレート**である（ADR-0027 の 2）。大域の定数を使わない。
 * 除算は整数で行い、切り捨てる（ADR-0017）。
 */
function reallocate(state: ReceiverState): ReceiverStepResult {
  const commands: ReceiverCommand[] = [];
  // 回線の速度（bits/sec）。8 倍は整数演算である。
  const linkBps = state.targetBytesPerSec * 8;
  // 段を買うための予算。ヘッダと制御の余裕を 10% 取る（congestion.md 4.3）。
  const budgetResult = truncDiv(linkBps * 9, 10);
  const budgetBps = budgetResult.ok ? budgetResult.value : 0;

  // --- 音声だけの状態への出入り（ヒステリシス。ADR-0029 の 1） ---
  //
  // 判定は**回線の速度そのもの**で行う。10% を引いた予算で判定してはならない。
  // `MIN_VIABLE_BPS` はヘッダを含めた実効レートとして導出されているため、
  // 予算で判定すると余裕を二重に引くことになり、最低の成立点でも音声だけに落ちる
  // （実際にそうなった。初期状態が常に AUDIO_ONLY になった）。
  const audioOnly = state.audioOnly
    ? linkBps < AUDIO_ONLY_EXIT_BPS
    : linkBps < AUDIO_ONLY_ENTER_BPS;

  if (audioOnly) {
    const streams: StreamState[] = [];
    for (const stream of state.streams) {
      if (isAudio(stream.channel)) {
        // 音声は維持する。**絶対に落としてはならない。**
        streams.push(stream);
        continue;
      }
      if (stream.phase === "SUBSCRIBED") {
        commands.push({
          kind: "subscribeChange",
          to: stream.senderId,
          channel: stream.channel,
          want: false,
          maxSpatialId: 0,
          maxTemporalId: 0,
        });
        streams.push({ ...stream, phase: "AUDIO_ONLY" });
        continue;
      }
      streams.push(stream);
    }
    if (!state.degraded) {
      commands.push({ kind: "notify", code: DEGRADED_WARNING });
    }
    return {
      state: { ...state, streams: streams.sort(streamOrder), audioOnly: true, degraded: true },
      commands,
    };
  }

  // --- 映像へ戻す（AUDIO_ONLY から復帰する） ---
  const revived: StreamState[] = [];
  for (const stream of state.streams) {
    if (stream.phase === "AUDIO_ONLY") {
      revived.push({ ...stream, phase: "SUBSCRIBED", spatialId: lowestRung(state, stream) });
      commands.push({
        kind: "subscribeChange",
        to: stream.senderId,
        channel: stream.channel,
        want: true,
        // 復帰は最下段から始める。高い段から始めると再び詰まる（congestion.md 6 節）。
        maxSpatialId: lowestRung(state, stream),
        maxTemporalId: stream.temporalId,
      });
      commands.push({
        kind: "keyframeRequest",
        for: stream.senderId,
        channel: stream.channel,
        spatialId: lowestRung(state, stream),
      });
      continue;
    }
    revived.push(stream);
  }
  const base: ReceiverState = { ...state, streams: revived, audioOnly: false };

  // --- 予算で段を買う ---
  const ordered = [...base.streams.filter((stream) => stream.phase === "SUBSCRIBED")].sort((a, b) =>
    priorityOrder(base, a, b),
  );
  const assigned = new Map<string, number>();
  let remaining = budgetBps;
  let degraded = false;

  for (const stream of ordered) {
    if (isAudio(stream.channel)) {
      // 音声は段を持たない。費用は予算から引くが、段の選択は行わない。
      remaining -= costOf(base, stream, 0);
      continue;
    }
    const floor = lowestRung(base, stream);
    const cap = rungCapFor(base, stream);
    let chosen = floor;
    // 上限から下へ降りて、予算に収まる最も高い段を選ぶ。
    for (let sid = cap; sid >= floor; sid -= 1) {
      const cost = costOf(base, stream, sid);
      if (cost <= remaining) {
        chosen = sid;
        break;
      }
    }
    const chosenCost = costOf(base, stream, chosen);
    if (chosenCost > remaining) {
      // 最下段さえ入らない。最低保証として最下段を維持し、警告する（congestion.md 4.3）。
      degraded = true;
    }
    remaining -= chosenCost;
    assigned.set(streamKey(stream), chosen);
  }

  const streams: StreamState[] = [];
  for (const stream of base.streams) {
    const next = assigned.get(streamKey(stream));
    if (next === undefined || next === stream.spatialId) {
      streams.push(stream);
      continue;
    }
    commands.push({ kind: "setTier", for: stream.senderId, channel: stream.channel, tier: next });
    commands.push({
      kind: "keyframeRequest",
      for: stream.senderId,
      channel: stream.channel,
      spatialId: next,
    });
    streams.push({ ...stream, spatialId: next });
  }

  if (degraded && !base.degraded) {
    commands.push({ kind: "notify", code: DEGRADED_WARNING });
  }

  return {
    state: { ...base, streams: streams.sort(streamOrder), degraded },
    commands,
  };
}

/** 発話者を先に、次に senderId の昇順で並べる。順序は決定的でなければならない。 */
function priorityOrder(state: ReceiverState, a: StreamState, b: StreamState): number {
  // 音声を先に配分する。音声が最優先である（ADR-0029 の 4）。
  const aAudio = isAudio(a.channel) ? 0 : 1;
  const bAudio = isAudio(b.channel) ? 0 : 1;
  if (aAudio !== bAudio) {
    return aAudio - bAudio;
  }
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

function streamKey(stream: StreamState): string {
  return `${String(stream.senderId)}:${String(stream.channel)}`;
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

/** 観測用。最上段を外から確かめられるようにする（試験のため）。 */
export function highestRungOf(state: ReceiverState, senderId: number, channel: number): number {
  return highestRung(state, { senderId, channel, phase: "SUBSCRIBED", spatialId: 0, temporalId: 0, displayWidth: 0 });
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
