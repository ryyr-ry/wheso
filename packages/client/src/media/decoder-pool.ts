/**
 * デコーダプールの判断コア。
 *
 * 規範: client-architecture.md 4 節の規則 1・4。
 *   1. デコーダは送信者ごとに 1 つ。購読解除で閉じる。同時数は端末の能力で制限する
 *   4. spatialId が切り替わるときはキーフレームを待つ。temporalId の変化では触らない
 *
 * sans-IO の純関数である。時刻・乱数・浮動小数点・入出力に触れない
 * （lint-policy.md 9 節）。実際の `VideoDecoder` の生成と破棄は端が行う。
 */

import { FLAG_KEY } from "@wheso/core/src/generated/wire-layout.ts";

/** 1 本のストリームに割り当てたデコーダ。 */
export interface DecoderEntry {
  readonly senderId: number;
  readonly channel: number;
  /** 現在復号している spatialId。 */
  readonly spatialId: number;
  /** キーフレームを待っている間は true。待機中の delta は復号しない。 */
  readonly awaitingKeyframe: boolean;
}

export interface DecoderPoolState {
  /** senderId, channel の昇順で保持する。反復順序が判断に影響するため決定的にする。 */
  readonly entries: readonly DecoderEntry[];
  /** 同時に持てるデコーダの上限。能力判定の結果を入力として受け取る。 */
  readonly maxConcurrent: number;
  /** 上限に達したため割り当てられなかった回数。観測のために数える。 */
  readonly rejected: number;
}

/** 復号の対象。ワイヤから取り出した値をそのまま渡す。 */
export interface DecodeUnit {
  readonly senderId: number;
  readonly channel: number;
  readonly spatialId: number;
  readonly temporalId: number;
  readonly flags: number;
}

/**
 * 端が行うべき操作。
 *
 *   configure … デコーダを生成して設定する。続いて decode するかは `decode` 欄で決まる
 *   reset     … 既存のデコーダを初期化する（spatialId の切替）
 *   close     … デコーダを破棄する
 */
export type DecoderAction =
  | { readonly kind: "decode"; readonly senderId: number; readonly channel: number }
  | { readonly kind: "configure"; readonly senderId: number; readonly channel: number; readonly spatialId: number }
  | { readonly kind: "reset"; readonly senderId: number; readonly channel: number; readonly spatialId: number }
  | { readonly kind: "close"; readonly senderId: number; readonly channel: number }
  | { readonly kind: "skip"; readonly reason: "awaitingKeyframe" | "poolFull" };

export interface DecoderPoolResult {
  readonly state: DecoderPoolState;
  /** 実行する順序で並ぶ。端はこの順序どおりに実行する。 */
  readonly actions: readonly DecoderAction[];
}

export function initialDecoderPool(maxConcurrent: number): DecoderPoolState {
  return { entries: [], maxConcurrent, rejected: 0 };
}

function isKey(flags: number): boolean {
  return (flags & FLAG_KEY) !== 0;
}

function entryOrder(a: DecoderEntry, b: DecoderEntry): number {
  return a.senderId !== b.senderId ? a.senderId - b.senderId : a.channel - b.channel;
}

function find(state: DecoderPoolState, senderId: number, channel: number): DecoderEntry | undefined {
  return state.entries.find((entry) => entry.senderId === senderId && entry.channel === channel);
}

function replace(state: DecoderPoolState, entry: DecoderEntry): DecoderPoolState {
  const rest = state.entries.filter(
    (existing) => !(existing.senderId === entry.senderId && existing.channel === entry.channel),
  );
  return { ...state, entries: [...rest, entry].sort(entryOrder) };
}

/**
 * ユニット 1 個に対する操作を決める。
 *
 * 判定の順序を規範に合わせて固定する。順序を変えると挙動が変わる。
 *   1. デコーダが無い → 上限を検査し、余裕があれば configure（キーフレーム待ちで始める）
 *   2. spatialId が変わった → reset してキーフレーム待ちに入る
 *   3. キーフレーム待ちで delta → skip（復号すると参照が欠けて破綻する）
 *   4. それ以外 → decode。temporalId の変化では何もしない
 */
export function decideDecode(state: DecoderPoolState, unit: DecodeUnit): DecoderPoolResult {
  const existing = find(state, unit.senderId, unit.channel);

  if (existing === undefined) {
    if (state.entries.length >= state.maxConcurrent) {
      // 上限に達している。既存の復号を壊さないため、新規は割り当てない。
      return { state: { ...state, rejected: state.rejected + 1 }, actions: [{ kind: "skip", reason: "poolFull" }] };
    }
    const created: DecoderEntry = {
      senderId: unit.senderId,
      channel: unit.channel,
      spatialId: unit.spatialId,
      awaitingKeyframe: !isKey(unit.flags),
    };
    const actions: DecoderAction[] = [
      { kind: "configure", senderId: unit.senderId, channel: unit.channel, spatialId: unit.spatialId },
    ];
    actions.push(
      isKey(unit.flags)
        ? { kind: "decode", senderId: unit.senderId, channel: unit.channel }
        : { kind: "skip", reason: "awaitingKeyframe" },
    );
    return { state: replace(state, created), actions };
  }

  if (existing.spatialId !== unit.spatialId) {
    // 解像度が切り替わった。デコーダを初期化し、キーフレームまで復号しない。
    const reset: DecoderEntry = {
      ...existing,
      spatialId: unit.spatialId,
      awaitingKeyframe: !isKey(unit.flags),
    };
    const actions: DecoderAction[] = [
      { kind: "reset", senderId: unit.senderId, channel: unit.channel, spatialId: unit.spatialId },
    ];
    actions.push(
      isKey(unit.flags)
        ? { kind: "decode", senderId: unit.senderId, channel: unit.channel }
        : { kind: "skip", reason: "awaitingKeyframe" },
    );
    return { state: replace(state, reset), actions };
  }

  if (existing.awaitingKeyframe) {
    if (!isKey(unit.flags)) {
      return { state, actions: [{ kind: "skip", reason: "awaitingKeyframe" }] };
    }
    return {
      state: replace(state, { ...existing, awaitingKeyframe: false }),
      actions: [{ kind: "decode", senderId: unit.senderId, channel: unit.channel }],
    };
  }

  // temporalId の変化ではデコーダを触らない（規則 4）。
  return { state, actions: [{ kind: "decode", senderId: unit.senderId, channel: unit.channel }] };
}

/** 購読解除と退出。デコーダを破棄する（規則 1）。 */
export function releaseSender(state: DecoderPoolState, senderId: number): DecoderPoolResult {
  const removed = state.entries.filter((entry) => entry.senderId === senderId);
  if (removed.length === 0) {
    return { state, actions: [] };
  }
  const actions: DecoderAction[] = removed
    .slice()
    .sort(entryOrder)
    .map((entry) => ({ kind: "close" as const, senderId: entry.senderId, channel: entry.channel }));
  return {
    state: { ...state, entries: state.entries.filter((entry) => entry.senderId !== senderId) },
    actions,
  };
}


/**
 * 復号の失敗を受けた場合。キーフレーム待ちへ戻す。
 * 端はこの結果を見てキーフレーム要求を送る（要求の送出は自ノードが担う）。
 */
export function markDecodeFailure(state: DecoderPoolState, senderId: number, channel: number): DecoderPoolResult {
  const existing = find(state, senderId, channel);
  if (existing === undefined) {
    return { state, actions: [] };
  }
  return {
    state: replace(state, { ...existing, awaitingKeyframe: true }),
    actions: [{ kind: "reset", senderId, channel, spatialId: existing.spatialId }],
  };
}
