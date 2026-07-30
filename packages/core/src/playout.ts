/**
 * 再生クロックと音声映像の同期の判断コア。
 *
 * 規範: ADR-0028（再生クロック基準の写像と連続したドリフト補正）、F-043（許容値の一次情報）、
 *       client-architecture.md 4 節の規則 3・5、congestion.md 5 節。
 *
 * **音声と映像のずれは、いかなる状況でも許されない。** 旧実装は「その送信者の、最後に
 * 再生した音声の取得時刻」を基準にしていたため、音声の選別転送（ADR-0024）で音声が
 * 届かなくなった参加者では基準が凍り、映像が止まった。会議で同時に発話するのは 1〜2 人
 * であるから、ほとんどの参加者の映像が止まる設計だった。
 *
 * 本ファイルは 3 つの原則で作る。
 *
 * 1. **音声は待たせない。映像を音声に合わせる。**
 * 2. **基準は「音声の到着」ではなく「対応付けと局所の単調時計」。**
 *    音声が届かない間（無音・DTX・選別転送で落とされた）も写像は進むため映像は止まらない。
 * 3. **期限に間に合わない映像は捨てる。遅らせて出さない。**
 *    結果は fps の低下であり、ずれではない。
 *
 * sans-IO の純関数である。時刻は引数で受け取る。浮動小数点を使わない（ADR-0017）。
 */

import {
  AV_DRIFT_STEP_US,
  AV_RESYNC_GAP_MS,
  AV_SKEW_AUDIO_LAG_MAX_MS,
  AV_SKEW_AUDIO_LEAD_MAX_MS,
  AV_SKEW_TOLERANCE_MS,
} from "./generated/constants.ts";

/** マイクロ秒からミリ秒への換算。整数除算のみを使う。 */
const US_PER_MS = 1000;

/**
 * 送信者 1 人ぶんの対応付け。
 *
 * ```
 * M(ts) = anchorLocalMs + (ts − anchorCaptureUs) / 1000 + driftCorrectionUs / 1000
 * ```
 *
 * `anchor` はストリームの開始時と不連続の直後にだけ決める。以後は**局所の単調時計**で
 * 進むため、音声が届かなくても写像は進む。
 */
export interface SenderClock {
  readonly senderId: number;
  /**
   * 対応付けが確立しているか。
   *
   * **0 を番兵にしてはならない。** 取得時刻 0 は正当な値であり（`VideoFrame.timestamp` は
   * 0 から始まる）、0 を「未確立」と解釈すると開始直後の映像が同期の対象外になる。
   */
  readonly hasAnchor: boolean;
  /** 対応付けの基準となる送信側の取得時刻（マイクロ秒）。 */
  readonly anchorCaptureUs: number;
  /** 対応付けの基準となる受信側の局所時刻（ミリ秒）。 */
  readonly anchorLocalMs: number;
  /**
   * ドリフト補正の累積（マイクロ秒）。**跳ばせない。**
   * 1 回の補正は `AV_DRIFT_STEP_US` に限る。
   */
  readonly driftCorrectionUs: number;
  /** 直近に観測した音声の取得時刻（マイクロ秒）。不連続の検出に使う。 */
  readonly lastAudioCaptureUs: number;
  /** 直近に音声を観測した局所時刻（ミリ秒）。不連続の検出に使う。 */
  readonly lastAudioLocalMs: number;
  /** 不連続で対応付けを作り直した回数。SLI として数える（ADR-0028 の帰結）。 */
  readonly resyncCount: number;
}

export interface PlayoutState {
  /** senderId の昇順で保持する。反復順序が判断に影響するため決定的にする。 */
  readonly clocks: readonly SenderClock[];
}

export function initialPlayout(): PlayoutState {
  return { clocks: [] };
}

function find(state: PlayoutState, senderId: number): SenderClock | undefined {
  return state.clocks.find((clock) => clock.senderId === senderId);
}

function replace(state: PlayoutState, clock: SenderClock): PlayoutState {
  const rest = state.clocks.filter((existing) => existing.senderId !== clock.senderId);
  return { clocks: [...rest, clock].sort((a, b) => a.senderId - b.senderId) };
}

/** 送信者の退出。記録を捨てる。 */
export function forgetSender(state: PlayoutState, senderId: number): PlayoutState {
  return { clocks: state.clocks.filter((clock) => clock.senderId !== senderId) };
}

/* ------------------------------------------------------------------------- */
/* 対応付けの確立                                                            */
/* ------------------------------------------------------------------------- */

export interface AnchorResult {
  readonly state: PlayoutState;
  /** 対応付けを新しく作ったか。作ったときはキーフレームを要求する。 */
  readonly established: boolean;
}

/**
 * 音声の到着で対応付けを確立する。
 *
 * `jitterDepthMs` は音声のジッタバッファの深さである（`constants.md` 7 節の式で決める）。
 * 対応付けの基準時刻をこの分だけ future に置くことで、揺れた到着を吸収する。
 *
 * すでに対応付けがある場合は作り直さない。**作り直すと映像が跳ぶ。**
 * 作り直すのは不連続を検出したときだけである（`noteAudioGap`）。
 */
export function noteAudio(
  state: PlayoutState,
  senderId: number,
  captureUs: number,
  localNowMs: number,
  jitterDepthMs: number,
): AnchorResult {
  const existing = find(state, senderId);
  if (existing === undefined) {
    return {
      state: replace(state, {
        senderId,
        hasAnchor: true,
        anchorCaptureUs: captureUs,
        anchorLocalMs: localNowMs + jitterDepthMs,
        driftCorrectionUs: 0,
        lastAudioCaptureUs: captureUs,
        lastAudioLocalMs: localNowMs,
        resyncCount: 0,
      }),
      established: true,
    };
  }

  // 不連続の検出。送信側の時刻が飛んだか、局所時刻が飛んだかのどちらかで判定する。
  // 片方だけを見ると、無音（DTX）で送信側の時刻だけが飛ぶ場合と、
  // 停止で局所時刻だけが飛ぶ場合を区別できない。
  const captureGapMs = Math.trunc((captureUs - existing.lastAudioCaptureUs) / US_PER_MS);
  const localGapMs = localNowMs - existing.lastAudioLocalMs;
  const discontinuous =
    !existing.hasAnchor ||
    captureGapMs < 0 ||
    captureGapMs > AV_RESYNC_GAP_MS ||
    localGapMs > AV_RESYNC_GAP_MS;

  if (discontinuous) {
    return {
      state: replace(state, {
        senderId,
        hasAnchor: true,
        anchorCaptureUs: captureUs,
        anchorLocalMs: localNowMs + jitterDepthMs,
        driftCorrectionUs: 0,
        lastAudioCaptureUs: captureUs,
        lastAudioLocalMs: localNowMs,
        resyncCount: existing.resyncCount + 1,
      }),
      established: true,
    };
  }

  return {
    state: replace(state, {
      ...existing,
      lastAudioCaptureUs: captureUs,
      lastAudioLocalMs: localNowMs,
    }),
    established: false,
  };
}

/**
 * 再接続や予備接続への切替を明示的に不連続として扱う（ADR-0028 の補正の方式）。
 *
 * 経路が変わると片道遅延が変わるため、対応付けをそのまま使うとずれる。
 * 跳ぶのはこの場合と `AV_RESYNC_GAP_MS` を超える欠落のときだけである。
 */
export function noteDiscontinuity(state: PlayoutState, senderId: number): PlayoutState {
  const existing = find(state, senderId);
  if (existing === undefined) {
    return state;
  }
  // 対応付けを捨てる。次の音声で作り直す。
  return {
    clocks: state.clocks.map((clock) =>
      clock.senderId === senderId
        ? { ...clock, hasAnchor: false }
        : clock,
    ),
  };
}

/* ------------------------------------------------------------------------- */
/* 映像の提示                                                                */
/* ------------------------------------------------------------------------- */

/**
 * 映像 1 枚の扱い。
 *
 *   present … 提示する
 *   hold    … まだ早い。次の機会まで持つ
 *   discard … 期限を過ぎた。**捨てる。遅らせて出さない**
 *   free    … 対応付けがまだ無い。音声の到着を待たずにそのまま提示する
 */
export type PresentDecision = "present" | "hold" | "discard" | "free";

export interface PresentResult {
  readonly decision: PresentDecision;
  /**
   * 局所時刻から見たずれ（ミリ秒）。
   * 正なら映像が遅れている（音声が先行している）。観測に使う。
   */
  readonly skewMs: number;
}

/**
 * 映像を提示してよいかを決める。
 *
 * ずれの許容は**非対称**である（F-043）。音声先行（映像が遅れる）に厳しく、
 * 音声遅れ（映像が先行する）に緩い。人の知覚がそうなっている。
 *
 *   skew = localNow − M(videoTs)
 *   skew > 0   映像が遅れている = 音声が先行している
 *   skew < 0   映像が先行している = 音声が遅れている
 */
export function decidePresent(
  state: PlayoutState,
  senderId: number,
  videoCaptureUs: number,
  localNowMs: number,
): PresentResult {
  const clock = find(state, senderId);
  if (clock === undefined || !clock.hasAnchor) {
    // 音声を 1 度も受けていない相手（マイク無効、選別転送の対象外で始まった）。
    // 映像を止めてはならない。そのまま提示する。
    return { decision: "free", skewMs: 0 };
  }
  const targetMs = mapToLocalMs(clock, videoCaptureUs);
  const skewMs = localNowMs - targetMs;

  if (skewMs < -AV_SKEW_AUDIO_LAG_MAX_MS) {
    // まだ早い。持つ。
    return { decision: "hold", skewMs };
  }
  if (skewMs > AV_SKEW_AUDIO_LEAD_MAX_MS) {
    // 音声が先行しすぎている。**捨てる。** 出すとずれが見える。
    return { decision: "discard", skewMs };
  }
  return { decision: "present", skewMs };
}

/**
 * その送信者の音声を再生すべき時刻（局所のミリ秒）。
 *
 * **音声にも同じ写像を使う**（ADR-0042）。映像だけを写像に合わせて待たせ、音声を到着した
 * 順に直ちに鳴らすと、写像はジッタ深度を足した位置に置かれているため**音声が映像より
 * 深度ぶん先行する**（実測: 中央 −170 ms。F-063）。音声を「待たせない」とは、
 * 音声デバイスのクロックで連続に出すことであり（ADR-0028 の 1）、
 * 深度を無視して鳴らすことではない。
 *
 * 対応付けが無い場合（この送信者の音声が 1 度も来ていない）は到着時刻を返す。
 */
export function audioPresentAtMs(state: PlayoutState, senderId: number, captureUs: number, localNowMs: number): number {
  const clock = find(state, senderId);
  if (clock === undefined || !clock.hasAnchor) {
    return localNowMs;
  }
  return mapToLocalMs(clock, captureUs);
}

/** 対応付けを適用する。整数演算のみ。 */
export function mapToLocalMs(clock: SenderClock, captureUs: number): number {
  const deltaUs = captureUs - clock.anchorCaptureUs + clock.driftCorrectionUs;
  return clock.anchorLocalMs + Math.trunc(deltaUs / US_PER_MS);
}

/* ------------------------------------------------------------------------- */
/* ドリフト補正                                                              */
/* ------------------------------------------------------------------------- */

export interface DriftResult {
  readonly state: PlayoutState;
  /**
   * 音声側が吸収すべき量（マイクロ秒）。正なら音声を少し伸ばす（標本を挿入する）。
   * 0 なら何もしない。**1 回の量は `AV_DRIFT_STEP_US` に限る。**
   */
  readonly resampleUs: number;
}

/**
 * 音声バッファの充填量からクロック差を推定し、対応付けを**連続に**補正する。
 *
 * 送信端末の取得クロックと受信端末の音声デバイスクロックは別の発振器で動く。差が
 * 100 ppm なら 30 分で 180 ms ずれる。閾値を超えたときに跳んで合わせると、長時間の
 * 会議で繰り返し映像が飛ぶ。したがって**跳ばずに、毎回わずかに動かす**。
 *
 * 判定は不感帯（`AV_SKEW_TOLERANCE_MS`）の外でのみ行う。内側では動かさない。
 * 動かし続けると、揺れに追従して発振する。
 *
 * @param fillMs   その送信者の音声バッファの現在の滞留（ミリ秒）
 * @param targetMs 目標の滞留（ジッタバッファの深さ。ミリ秒）
 */
export function noteAudioBuffer(
  state: PlayoutState,
  senderId: number,
  fillMs: number,
  targetMs: number,
): DriftResult {
  const clock = find(state, senderId);
  if (clock === undefined) {
    return { state, resampleUs: 0 };
  }
  const errorMs = fillMs - targetMs;
  if (errorMs <= AV_SKEW_TOLERANCE_MS && errorMs >= -AV_SKEW_TOLERANCE_MS) {
    // 不感帯の内側。動かさない。
    return { state, resampleUs: 0 };
  }
  // 滞留が増えている = 送信側のクロックが速い = 写像を future へ動かす。
  const step = errorMs > 0 ? AV_DRIFT_STEP_US : -AV_DRIFT_STEP_US;
  return {
    state: replace(state, { ...clock, driftCorrectionUs: clock.driftCorrectionUs + step }),
    resampleUs: step,
  };
}

/** 観測用。不連続で作り直した回数の合計（SLI）。 */
export function resyncTotal(state: PlayoutState): number {
  let total = 0;
  for (const clock of state.clocks) {
    total += clock.resyncCount;
  }
  return total;
}


