/**
 * 送信ノード（sender）の判断コア。
 *
 * sans-IO の純関数状態機械。時刻・乱数・浮動小数点・入出力・並行に触れない。
 * 規範:
 *   - congestion.md 2 節（送信窓。未確認の媒体を再生時間で数える）
 *   - state-machines.md 5 節（epoch 移行。STEADY / DUAL_SUBSCRIBE / MIGRATING）
 *   - wire-format.md 1.4（破棄優先順位）、2.3（streamAnnounce）
 *
 * 送信ノードはクライアントから受けたメディアを割当先のシャードへ渡す。
 * 渡せない量は破棄優先順位に従って捨てる。捨てる判断はここで行う。
 */

import {
  SEND_WINDOW_MS,
  EPOCH_DUAL_SUBSCRIBE_TIMEOUT_MS,
} from "./generated/constants.ts";
import { dropPriority } from "./wire.ts";

/** epoch 移行の状態（state-machines.md 5 節）。 */
export type MigrationPhase = "STEADY" | "DUAL_SUBSCRIBE" | "MIGRATING";

/** 1 本のストリーム（channel, spatialId）の送信窓。 */
export interface StreamWindow {
  readonly channel: number;
  readonly spatialId: number;
  /** 送信済みの最大 sequenceNumber。 */
  readonly highestSent: number;
  /** ack で確認された最大 sequenceNumber。 */
  readonly highestAcked: number;
  /** このストリームの fps。streamAnnounce で通知される。 */
  readonly framerate: number;
}

export interface SenderState {
  /** channel, spatialId の昇順で保持する。反復順序が判断に影響するため決定的にする。 */
  readonly windows: readonly StreamWindow[];
  readonly phase: MigrationPhase;
  /** 現在の epoch。単調増加のみ。 */
  readonly epoch: number;
  /** 移行先の epoch。DUAL_SUBSCRIBE と MIGRATING の間のみ有効。 */
  readonly targetEpoch: number | null;
  /** DUAL_SUBSCRIBE に入った時刻。時限の判定に使う。 */
  readonly dualSubscribeSince: number | null;
  /** 旧接続に残っている未送出のバイト数。0 で旧接続を閉じられる。 */
  readonly staleBacklogBytes: number;
  /** 表に無いイベントの記録。 */
  readonly unexpectedEvents: readonly string[];
}

export type SenderEvent =
  | {
      readonly kind: "media";
      readonly ch: number;
      readonly sid: number;
      readonly tid: number;
      readonly seq: number;
      readonly bytes: number;
      readonly flags: number;
    }
  | { readonly kind: "ack"; readonly ch: number; readonly sid: number; readonly highestSeq: number }
  | {
      readonly kind: "streamAnnounce";
      readonly ch: number;
      readonly sid: number;
      readonly framerate: number;
    }
  | { readonly kind: "epochChange"; readonly epoch: number; readonly assignmentChanged: boolean }
  | { readonly kind: "newEpochFrame" }
  | { readonly kind: "staleBacklog"; readonly bytes: number }
  | { readonly kind: "timer" };

export type SenderCommand =
  | { readonly kind: "forward"; readonly to: readonly number[] }
  | { readonly kind: "drop"; readonly priority: number; readonly count: number }
  | { readonly kind: "connect"; readonly peer: number }
  | { readonly kind: "disconnect"; readonly peer: number }
  | { readonly kind: "unsubscribeStale" }
  | { readonly kind: "notify"; readonly code: string }
  | { readonly kind: "schedule"; readonly at: number };

export interface SenderStepResult {
  readonly state: SenderState;
  readonly commands: readonly SenderCommand[];
}

/** 割当先のシャードは 1 個である。宛先は epoch ごとに 1 個の論理接続で表す。 */
export const SHARD_PEER_CURRENT = 1;
export const SHARD_PEER_NEXT = 2;

export function initialSenderState(epoch: number): SenderState {
  return {
    windows: [],
    phase: "STEADY",
    epoch,
    targetEpoch: null,
    dualSubscribeSince: null,
    staleBacklogBytes: 0,
    unexpectedEvents: [],
  };
}

export function senderStep(state: SenderState, event: SenderEvent, t: number): SenderStepResult {
  switch (event.kind) {
    case "media":
      return handleMedia(state, event);
    case "ack":
      return handleAck(state, event);
    case "streamAnnounce":
      return handleAnnounce(state, event);
    case "epochChange":
      return handleEpochChange(state, event, t);
    case "newEpochFrame":
      return handleNewEpochFrame(state);
    case "staleBacklog":
      return handleStaleBacklog(state, event.bytes);
    case "timer":
      return handleTimer(state, t);
  }
}

/**
 * メディアの送出判定。
 *
 * 未確認の媒体を再生時間で数え、SEND_WINDOW_MS を超える間は送らない。
 *   inFlightMs = 未確認フレーム数 ÷ fps × 1000
 * 除算を避けるため、比較は交差乗算で行う。
 *   inFlightMs > SEND_WINDOW_MS ⇔ 未確認フレーム数 × 1000 > SEND_WINDOW_MS × fps
 */
function handleMedia(state: SenderState, event: Extract<SenderEvent, { kind: "media" }>): SenderStepResult {
  const window = findWindow(state, event.ch, event.sid);
  const framerate = window?.framerate ?? 0;
  const highestAcked = window?.highestAcked ?? 0;
  const inFlight = event.seq - highestAcked - 1 < 0 ? 0 : event.seq - highestAcked - 1;

  const priority = dropPriority(event.ch, event.flags);
  const overWindow = framerate > 0 && inFlight * 1000 > SEND_WINDOW_MS * framerate;

  if (overWindow && priority !== null) {
    // 窓が閉じている間は渡さない。破棄禁止のユニット（KEY・音声）は渡す。
    return { state, commands: [{ kind: "drop", priority, count: 1 }] };
  }

  const updated = upsertWindow(state, {
    channel: event.ch,
    spatialId: event.sid,
    highestSent: event.seq > (window?.highestSent ?? 0) ? event.seq : (window?.highestSent ?? 0),
    highestAcked,
    framerate,
  });

  // 二重購読中は新旧の両方へ渡す。切替の瞬間に映像を途切れさせないためである。
  const targets =
    state.phase === "DUAL_SUBSCRIBE" ? [SHARD_PEER_CURRENT, SHARD_PEER_NEXT] : [SHARD_PEER_CURRENT];
  return { state: updated, commands: [{ kind: "forward", to: targets }] };
}

/** ack の適用。確認済みの位置は単調増加のみとする。 */
function handleAck(state: SenderState, event: Extract<SenderEvent, { kind: "ack" }>): SenderStepResult {
  const window = findWindow(state, event.ch, event.sid);
  if (window === undefined) {
    return {
      state: { ...state, unexpectedEvents: [...state.unexpectedEvents, "ack"] },
      commands: [],
    };
  }
  if (event.highestSeq <= window.highestAcked) {
    // 後戻りする ack は無視する。順序の逆転は TCP 上では起きないが、
    // 重複した ack が届くことはある。
    return { state, commands: [] };
  }
  return {
    state: upsertWindow(state, { ...window, highestAcked: event.highestSeq }),
    commands: [],
  };
}

/** streamAnnounce の適用。fps は送信窓の計算に必要である（congestion.md 2 節）。 */
function handleAnnounce(
  state: SenderState,
  event: Extract<SenderEvent, { kind: "streamAnnounce" }>,
): SenderStepResult {
  const window = findWindow(state, event.ch, event.sid);
  return {
    state: upsertWindow(state, {
      channel: event.ch,
      spatialId: event.sid,
      highestSent: window?.highestSent ?? 0,
      highestAcked: window?.highestAcked ?? 0,
      framerate: event.framerate,
    }),
    commands: [],
  };
}

/** epoch の変化。表 1 行目と 2 行目に対応する。 */
function handleEpochChange(
  state: SenderState,
  event: Extract<SenderEvent, { kind: "epochChange" }>,
  t: number,
): SenderStepResult {
  if (event.epoch <= state.epoch) {
    // epoch は単調増加のみである。後退する通知は無視して記録する。
    return {
      state: { ...state, unexpectedEvents: [...state.unexpectedEvents, "epochChange"] },
      commands: [],
    };
  }
  if (!event.assignmentChanged) {
    // 割当先が変わらないなら接続を張り替えない。
    return { state: { ...state, epoch: event.epoch }, commands: [] };
  }
  if (state.phase !== "STEADY") {
    // 移行中の新たな epoch 変化は表に無い。記録して無視する。
    return {
      state: { ...state, unexpectedEvents: [...state.unexpectedEvents, "epochChange"] },
      commands: [],
    };
  }
  return {
    state: {
      ...state,
      phase: "DUAL_SUBSCRIBE",
      targetEpoch: event.epoch,
      dualSubscribeSince: t,
    },
    commands: [
      { kind: "connect", peer: SHARD_PEER_NEXT },
      { kind: "schedule", at: t + EPOCH_DUAL_SUBSCRIBE_TIMEOUT_MS },
    ],
  };
}

/** 新 epoch からの最初のフレーム。表 3 行目に対応する。 */
function handleNewEpochFrame(state: SenderState): SenderStepResult {
  if (state.phase !== "DUAL_SUBSCRIBE") {
    return {
      state: { ...state, unexpectedEvents: [...state.unexpectedEvents, "newEpochFrame"] },
      commands: [],
    };
  }
  return {
    state: { ...state, phase: "MIGRATING" },
    commands: [{ kind: "unsubscribeStale" }],
  };
}

/** 旧接続の残量。空になったら閉じる（表 5 行目）。 */
function handleStaleBacklog(state: SenderState, bytes: number): SenderStepResult {
  const next: SenderState = { ...state, staleBacklogBytes: bytes };
  if (state.phase !== "MIGRATING" || bytes > 0) {
    return { state: next, commands: [] };
  }
  const epoch = state.targetEpoch ?? state.epoch;
  return {
    state: { ...next, phase: "STEADY", epoch, targetEpoch: null, dualSubscribeSince: null },
    commands: [{ kind: "disconnect", peer: SHARD_PEER_CURRENT }],
  };
}

/** 時限切れ。表 4 行目に対応する。 */
function handleTimer(state: SenderState, t: number): SenderStepResult {
  if (state.phase !== "DUAL_SUBSCRIBE" || state.dualSubscribeSince === null) {
    return { state, commands: [] };
  }
  if (t - state.dualSubscribeSince < EPOCH_DUAL_SUBSCRIBE_TIMEOUT_MS) {
    return { state, commands: [] };
  }
  // 新 epoch からフレームが来ない。新接続を閉じて元へ戻し、制御系へ報告する。
  return {
    state: { ...state, phase: "STEADY", targetEpoch: null, dualSubscribeSince: null },
    commands: [
      { kind: "disconnect", peer: SHARD_PEER_NEXT },
      { kind: "notify", code: "E_EPOCH_STALE" },
    ],
  };
}

function findWindow(state: SenderState, channel: number, spatialId: number): StreamWindow | undefined {
  return state.windows.find((entry) => entry.channel === channel && entry.spatialId === spatialId);
}

/** 窓を更新する。順序は channel, spatialId の昇順に保つ（決定性のため）。 */
function upsertWindow(state: SenderState, window: StreamWindow): SenderState {
  const rest = state.windows.filter(
    (entry) => !(entry.channel === window.channel && entry.spatialId === window.spatialId),
  );
  const merged = [...rest, window].sort((a, b) =>
    a.channel !== b.channel ? a.channel - b.channel : a.spatialId - b.spatialId,
  );
  return { ...state, windows: merged };
}
