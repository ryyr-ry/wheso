/**
 * 受信経路の配線。
 *
 * 規範: client-architecture.md 4 節（受信パイプライン）、ADR-0028（再生クロック）、
 *       congestion.md 4.1（goodput）、wire-format.md 2.6（report）。
 *
 * **これが無いと SDK はメディアを受け取れない。** 段 F の F-6 まで、`JoinSocket` は
 * `send` / `close` / `onText` の 3 つしか持たず、バイナリを受ける口が存在しなかった。
 * そのため E2E と段 D の試験はすべて生の WebSocket を張って自前で復号していた。
 *
 * ここは端（副作用の層）である。判断は次の純関数に委ねる。
 *   復号の可否      media/decoder-pool.ts
 *   提示の可否      core/playout.ts
 *   バッファの深さ  sync/jitter-buffer.ts
 *   報告の内容      quality/reporter.ts
 *
 * 時刻と復号器は注入する。理由は 2 つある。第 1 に、WebCodecs の無い環境（Node の試験）で
 * 経路そのものを検証できること。第 2 に、判断を純関数に閉じ込めたまま端だけを差し替えられること。
 */

import { decodeMediaMessage, type Unit } from "@wheso/core/src/wire.ts";
import { CHANNEL_AUDIO, CHANNEL_SCREEN_AUDIO, FLAG_KEY } from "@wheso/core/src/generated/wire-layout.ts";
import {
  AV_RESYNC_GAP_MS,
  DELAY_TREND_DEGRADE_DEN,
  DELAY_TREND_DEGRADE_NUM,
  OPUS_FRAME_MS,
  REPORT_INTERVAL_MS,
  VIDEO_JITTER_MAX_FRAMES,
} from "@wheso/core/src/generated/constants.ts";
import { delaySlope, wrap32 } from "@wheso/core/src/fixed.ts";
import { advanceSequence } from "./send-pipeline.ts";
import {
  audioPresentAtMs,
  decidePresent,
  forgetSender as forgetPlayout,
  initialPlayout,
  noteAudio,
  noteAudioBuffer,
  noteDiscontinuity,
  resyncTotal,
  type PlayoutState,
} from "@wheso/core/src/playout.ts";
import {
  decideDecode,
  noteGap,
  initialDecoderPool,
  markDecodeFailure,
  releaseSender,
  type DecoderPoolState,
} from "../media/decoder-pool.ts";
import { audioJitterPackets, jitterP99Ms, videoJitterFrames } from "../sync/jitter-buffer.ts";
import {
  initialReporter,
  recordArrivalDelay,
  recordAudioLoss,
  recordLinkEstimate,
  recordStall,
  recordVideoDrop,
  shouldReport,
  takeReport,
  type ReporterState,
} from "../quality/reporter.ts";

/** 復号へ渡す 1 ユニット。実際の `EncodedVideoChunk` の組み立ては端が行う。 */
export interface DecodeInput {
  /**
   * 提示すべき時刻（局所の単調時計。ミリ秒）。
   *
   * **映像を音声に合わせるために必要である**（ADR-0028 の 1、ADR-0042）。到着した順に
   * 直ちに描くと、音声は束ね（`AUDIO_BUNDLE_MS`）で遅れるのに映像は遅れないため、
   * 映像が音声より先行する（実測: p99 88 ms。F-063）。
   *
   * 利用側（`media/browser-media.ts` と試験の器）はこの時刻まで待ってから復号へ渡す。
   * 音声には使わない（音声は待たせない）。
   */
  readonly presentAtMs: number;
  readonly senderId: number;
  readonly channel: number;
  readonly spatialId: number;
  readonly temporalId: number;
  readonly key: boolean;
  readonly captureTimestampUs: number;
  readonly payload: Uint8Array;
}

/** 端が持つ副作用の口。試験では記録する偽物を渡す。 */
export interface PipelineDeps {
  /** 局所の単調時計（ミリ秒）。 */
  readonly now: () => number;
  /** 復号器を用意する。 */
  readonly configureDecoder: (senderId: number, channel: number, spatialId: number) => void;
  /** 復号器を初期化する（段の切替）。 */
  readonly resetDecoder: (senderId: number, channel: number, spatialId: number) => void;
  /** 復号器を破棄する。 */
  readonly closeDecoder: (senderId: number, channel: number) => void;
  /** 映像を復号する。 */
  readonly decodeVideo: (input: DecodeInput) => void;
  /** 音声を再生キューへ入れる。**音声は決して捨てない。** */
  readonly enqueueAudio: (input: DecodeInput) => void;
  /** 受信部屋へ制御メッセージを送る（`report` など）。 */
  readonly sendReceiveControl: (text: string) => void;
}

/** 送信者ごとの観測。fps とバッファ深度の算出に使う。 */
interface SenderObservation {
  readonly senderId: number;
  /** 直近の到着間隔の標本（ミリ秒）。ジッタの p99 に使う。 */
  readonly arrivalGapsMs: readonly number[];
  /** 直近に映像が届いた局所時刻。 */
  readonly lastVideoAtMs: number;
  /** 直近に音声が届いた局所時刻。 */
  readonly lastAudioAtMs: number;
  /** その送信者の映像の fps の推定（申告が無い間は 0）。 */
  readonly framerate: number;
  /**
   * 予定が規範の不連続の閾値を超えて続けて外れた回数。写像の狂いを 1 枚の遅れと
   * 区別するために数える（0 で切れる）。
   */
  readonly farSkewStreak: number;
  /**
   * 申告された時間層の数（カタログから取り込む）。0 なら未申告。
   *
   * **破棄可否の判定に必要である**（`computeDiscardable`）。申告が無いと、期限を過ぎた
   * ユニットを捨てたときに参照連鎖が切れたかどうかを決められない。
   */
  readonly temporalLayers: number;
  /**
   * 直近に受け取った音声の sequenceNumber。欠落の計数に使う。
   * 音声は破棄禁止であるため、欠落は経路の異常を意味する（congestion.md 5 節）。
   */
  readonly lastAudioSeq: number;
  /** 直近に復号へ渡した映像の段。`receivedProfile` の呼び名に使う。 */
  readonly lastVideoSpatialId: number;
  /**
   * 直近に受け取った映像の sequenceNumber（段ごと）。
   *
   * **連番の飛びは「上流が意図的に捨てた」ことを意味する。** TCP 上では経路で欠落しない
   * （F-024）。飛びを見たら参照連鎖が切れているため、復号器へ渡さずキーフレームを待つ
   * （ADR-0049）。段ごとに持つのは、段が変わると連番の空間も変わるためである。
   */
  readonly lastVideoSeq: readonly { readonly spatialId: number; readonly seq: number }[];
  /**
   * 片道遅延の基準（マイクロ秒）。チャネルごとに持つ。
   *
   * **送信側の取得時刻と受信側の時計は同じ原点を持たない**（Q-022）。`VideoFrame.timestamp`
   * はトラックの開始からの経過であり、`AudioData.timestamp` は別の原点を持つ。差をそのまま
   * 標本にすると、映像と音声で桁の違う値が交互に並び、勾配が常に「劣化」と読まれる
   * （実測: ブラウザで AIMD が目標を潰し、映像の購読が解除され続けた）。
   *
   * 最初の観測を基準として引く。**勾配だけを使うため原点は問わない**（ADR-0021）。
   */
  readonly delayBaselineUs: readonly { readonly channel: number; readonly baseUs: number }[];
}

export interface PipelineState {
  readonly decoders: DecoderPoolState;
  readonly playout: PlayoutState;
  readonly reporter: ReporterState;
  /** senderId の昇順で保持する。 */
  readonly observations: readonly SenderObservation[];
  /** goodput の窓に入ったバイト数（ヘッダを含む）。 */
  readonly windowBytes: number;
  /** goodput の窓の開始時刻。 */
  readonly windowStartMs: number;
  /** 直近に算出した下り帯域（bits/sec）。 */
  readonly downlinkBps: number;
  /** 提示できずに捨てた映像の枚数。観測のために数える。 */
  readonly discardedVideo: number;
  /** 期限より早く届いて保持した枚数。 */
  readonly heldVideo: number;
  /**
   * 直近の報告で送った到着遅延の標本の数。
   *
   * **新しい観測が無いときは報告しない。** 同じ標本列を送り続けると、受信ノードは
   * 「遅延が増え続けている」と読み、AIMD で目標帯域を下げ続ける。媒体が一瞬止まっただけで
   * 目標が潰れ、`AUDIO_ONLY` へ落ちて二度と映像に戻らない（実測）。
   */
  readonly reportedSamples: number;
  /** 提示した映像の枚数。停止の割合（SLI）の分母になる。 */
  readonly presentedVideo: number;
  /** 停止として数えた回数。停止の割合の分子になる。 */
  readonly stalls: number;
  /**
   * 音声と映像のずれの標本（ミリ秒）。正なら映像が遅れている。
   * 観測のためだけに保つ（判断は `playout.ts` が行う）。
   */
  readonly skewSamplesMs: readonly number[];
}

/** goodput を測る窓の長さ。congestion.md 4.1 は「直近 1 秒」と定める。 */
const GOODPUT_WINDOW_MS = 1000;

/** 到着間隔の標本数の上限。ジッタの p99 を求めるのに足る量に留める。 */
const ARRIVAL_SAMPLE_LIMIT = 50;

export function createPipeline(maxDecoders: number, nowMs: number): PipelineState {
  return {
    decoders: initialDecoderPool(maxDecoders),
    playout: initialPlayout(),
    reporter: initialReporter(nowMs),
    observations: [],
    windowBytes: 0,
    windowStartMs: nowMs,
    downlinkBps: 0,
    discardedVideo: 0,
    heldVideo: 0,
    presentedVideo: 0,
    stalls: 0,
    skewSamplesMs: [],
    reportedSamples: -1,
  };
}

/**
 * `sequenceNumber` の「新しいか」を巻き戻しに耐える形で比べる（wire-format.md 1.2）。
 *
 * 番号は 2^32 で 1 へ戻る。単純な大小比較では、戻った直後に「古い」と読んでしまい、
 * **長い通話で映像が二度と出なくなる**。差を符号付き 32 bit として読むことで、
 * 半周までの差を正しく扱える。切り詰めは `wrap32` の 1 箇所に任せる。
 */
function isNewerSeq(candidate: number, known: number): boolean {
  return (wrap32(candidate - known) | 0) > 0;
}

function isAudio(channel: number): boolean {
  return channel === CHANNEL_AUDIO || channel === CHANNEL_SCREEN_AUDIO;
}

function observationOf(state: PipelineState, senderId: number): SenderObservation {
  const found = state.observations.find((entry) => entry.senderId === senderId);
  if (found !== undefined) {
    return found;
  }
  return {
    senderId,
    arrivalGapsMs: [],
    lastVideoAtMs: 0,
    lastAudioAtMs: 0,
    framerate: 0,
    farSkewStreak: 0,
    temporalLayers: 0,
    lastAudioSeq: 0,
    lastVideoSpatialId: -1,
    lastVideoSeq: [],
    delayBaselineUs: [],
  };
}

function replaceObservation(state: PipelineState, next: SenderObservation): PipelineState {
  const rest = state.observations.filter((entry) => entry.senderId !== next.senderId);
  return { ...state, observations: [...rest, next].sort((a, b) => a.senderId - b.senderId) };
}

/**
 * 上流から届いたバイナリを処理する。
 *
 * 手順:
 *   1. 復号する。形式違反は捨てる（接続は閉じない。上流の異常でクライアントを落とさない）
 *   2. goodput とジッタの標本を更新する
 *   3. 音声は再生キューへ入れ、再生クロックの対応付けを更新する
 *   4. 映像は再生クロックで提示の可否を決め、通れば復号器へ渡す
 */
export function handleMedia(state: PipelineState, bytes: Uint8Array, deps: PipelineDeps): PipelineState {
  const nowMs = deps.now();
  const decoded = decodeMediaMessage(bytes);
  if (!decoded.ok) {
    // 上流の形式違反はこちらの落ちる理由にならない。捨てて数える。
    return state;
  }

  let next = accountGoodput(state, bytes.length, nowMs);
  const senderId = decoded.value.senderId;
  const channel = decoded.value.channel;

  for (const unit of decoded.value.units) {
    next = isAudio(channel)
      ? handleAudioUnit(next, senderId, channel, unit, nowMs, deps)
      : handleVideoUnit(next, senderId, channel, unit, nowMs, deps);
  }
  return next;
}

/** goodput を計上する。窓が満了したら bits/sec を確定する。 */
function accountGoodput(state: PipelineState, byteCount: number, nowMs: number): PipelineState {
  const elapsed = nowMs - state.windowStartMs;
  if (elapsed < GOODPUT_WINDOW_MS) {
    return { ...state, windowBytes: state.windowBytes + byteCount };
  }
  // bits/sec = バイト数 × 8 × 1000 / 経過ミリ秒。整数演算のみ（ADR-0017）。
  const total = state.windowBytes + byteCount;
  const bps = elapsed > 0 ? Math.trunc((total * 8 * 1000) / elapsed) : 0;
  return { ...state, windowBytes: 0, windowStartMs: nowMs, downlinkBps: bps };
}

function handleAudioUnit(
  state: PipelineState,
  senderId: number,
  channel: number,
  unit: Unit,
  nowMs: number,
  deps: PipelineDeps,
): PipelineState {
  const captureUs = Number(unit.captureTimestampUs);
  const observation = observationOf(state, senderId);
  const gap = observation.lastAudioAtMs === 0 ? 0 : nowMs - observation.lastAudioAtMs;

  // 音声のバッファ深度は到着間隔の p99 から決める（constants.md 7 節）。
  const jitter = jitterP99Ms(observation.arrivalGapsMs);
  const depthMs = audioJitterPackets(jitter) * OPUS_FRAME_MS;

  const anchored = noteAudio(state.playout, senderId, captureUs, nowMs, depthMs);
  let next: PipelineState = { ...state, playout: anchored.state };

  // 滞留の推定は「到着間隔の p99 と目標深度の差」で代用する。実際の再生キューの長さは
  // 端（AudioWorklet）が持つが、判断に必要なのは目標からの離れ方であり、
  // それは到着の統計から求まる。値そのものではなく符号と大小だけを使う。
  const drift = noteAudioBuffer(next.playout, senderId, jitter, depthMs);
  next = { ...next, playout: drift.state };

  // **音声は決して捨てない**（wire-format.md 1.4）。無条件に再生キューへ入れる。
  deps.enqueueAudio({
    senderId,
    channel,
    spatialId: unit.spatialId,
    temporalId: unit.temporalId,
    key: (unit.flags & FLAG_KEY) !== 0,
    captureTimestampUs: captureUs,
    // 音声も同じ再生クロックに合わせる（ADR-0042）。写像はジッタ深度を足した位置にあり、
    // 無視して鳴らすと音声が映像より深度ぶん先行する（F-063）。
    presentAtMs: audioPresentAtMs(next.playout, senderId, captureUs, nowMs),
    payload: unit.payload,
  });

  const samples = appendSample(observation.arrivalGapsMs, gap);
  next = replaceObservation(next, {
    ...observation,
    arrivalGapsMs: samples,
    lastAudioAtMs: nowMs,
    lastAudioSeq: unit.sequenceNumber,
  });
  // 音声の欠落を数える。**音声は破棄禁止であるため、欠落は経路の異常である**
  // （wire-format.md 1.4）。数えないと、経路が壊れていることを受信ノードへ伝えられない。
  if (observation.lastAudioSeq > 0 && unit.sequenceNumber > observation.lastAudioSeq + 1) {
    const lost = unit.sequenceNumber - observation.lastAudioSeq - 1;
    next = { ...next, reporter: recordAudioLoss(next.reporter, lost) };
  }
  // 片道遅延の標本。**チャネルごとに基準化する**（原点が違うため。Q-022）。
  const audioDelay = normalizedDelay(next, senderId, channel, nowMs * 1000 - captureUs);
  next = { ...audioDelay.state, reporter: recordArrivalDelay(audioDelay.state.reporter, audioDelay.sampleUs) };
  return next;
}

function handleVideoUnit(
  state: PipelineState,
  senderId: number,
  channel: number,
  unit: Unit,
  nowMs: number,
  deps: PipelineDeps,
): PipelineState {
  const captureUs = Number(unit.captureTimestampUs);
  const observation = observationOf(state, senderId);
  const gap = observation.lastVideoAtMs === 0 ? 0 : nowMs - observation.lastVideoAtMs;

  let next: PipelineState = replaceObservation(state, {
    ...observation,
    arrivalGapsMs: appendSample(observation.arrivalGapsMs, gap),
    lastVideoAtMs: nowMs,
  });
  const videoDelay = normalizedDelay(next, senderId, channel, nowMs * 1000 - captureUs);
  next = { ...videoDelay.state, reporter: recordArrivalDelay(videoDelay.state.reporter, videoDelay.sampleUs) };

  // 停止の記録。到着間隔がバッファの深さを大きく超えたら停止として数える。
  const jitter = jitterP99Ms(observation.arrivalGapsMs);
  const depthFrames = videoJitterFrames(jitter, observation.framerate);
  if (observation.framerate > 0 && gap > depthFrames * Math.trunc(1000 / observation.framerate)) {
    next = { ...next, reporter: recordStall(next.reporter), stalls: next.stalls + 1 };
  }

  // 提示の可否を再生クロックで決める（ADR-0028）。
  let presentation = decidePresent(next.playout, senderId, captureUs, nowMs);
  // **予定が遠すぎるなら写像が古い。作り直して、この枠は直ちに出す。**
  //
  // 予定は音声の再生位置からの写像で作る。頁が一瞬止まった時点で対応を取ると、その分だけ
  // 写像が狂ったまま残る（ずれの補正は 1 パケット 20 µs であり、数秒の狂いは埋まらない）。
  //
  // 捨ててはならない: 狂いが続く間ずっと捨てることになる（実測: 届いた 318 枚のうち復号器へ
  // 渡ったのは 63 枚）。待たせてもならない: 音声より数秒早い映像を出すことになる（実測
  // 8.2 秒）。**作り直して 1 枚だけ直ちに出す**のが、映像を止めずずれを 1 枚に留める。
  //
  // **両向きに見る。** 遅れの側（音声が先行）で狂うと規範の `decidePresent` が全部を
  // 「期限切れ」として捨てる（実測: 走行の頭で写像が 2.4 秒狂い、届いた 347 枚のうち
  // 提示は 56 枚だった）。狂いが規範の不連続の閾値を超えたら、向きに依らず作り直す。
  const farSkew = presentation.skewMs > AV_RESYNC_GAP_MS || -presentation.skewMs > AV_RESYNC_GAP_MS;
  const streak = farSkew ? observationOf(next, senderId).farSkewStreak + 1 : 0;
  next = replaceObservation(next, { ...observationOf(next, senderId), farSkewStreak: streak });
  // **1 枚では作り直さない。** 1 枚だけ大きく外れているのは、本当に古い枠が遅れて届いた
  // 場合である（規範どおり捨てる）。**続けて**外れているなら写像そのものが狂っている。
  // 境目はジッタバッファの深さ（`VIDEO_JITTER_MAX_FRAMES`）に置く。それだけ続けて外れる
  // 状態はバッファでは説明できない。
  if (streak > VIDEO_JITTER_MAX_FRAMES) {
    next = replaceObservation(next, { ...observationOf(next, senderId), farSkewStreak: 0 });
    next = noteRouteChange(next, senderId);
    presentation = { decision: "present", skewMs: 0 };
  }
  // ずれの標本を残す（観測のみ。判断は playout.ts が行う）。
  next = { ...next, skewSamplesMs: appendSample(next.skewSamplesMs, presentation.skewMs, true) };
  if (presentation.decision === "discard") {
    // **期限を過ぎた映像は捨てる。遅らせて出さない。** 結果は fps の低下である。
    //
    // ここで参照連鎖を切ってキーフレームを要求してはならない。規範の閾値
    // （`AV_SKEW_AUDIO_LEAD_MAX_MS` = 22 ms）は狭く、揺れのある回線では破棄が頻繁に
    // 起きる。要求を出すと「遅れて届いたキーフレームも捨てる」を繰り返して**生きた
    // ままの停止**になる（実測: 段 E で連鎖切れ 513 件・要求 37 山・提示 71 枚）。
    // 参照の欠けた差分は `noteGap`（連番の飛び）と復号の失敗の側で拾う。
    //
    // **キーフレームは捨てない**（wire-format.md 1.4「KEY=1 のユニットは破棄しては
    // ならない」）。写像が狂っている間にキーフレームまで捨てると、参照連鎖の回復が
    // 永久に来ない。要求したキーフレームが届いても捨てられるため、要求と破棄の輪が
    // 回り続ける（実測 N-0: 要求 9 回・復号器の失敗 11 回・生成 12 回。判定 A-2 が
    // 「キーフレームを提示していないのに delta を提示した」を量産した）。
    // 1 枚のずれは次のフレームから回復する（ADR-0028 の原則 3 はキーフレームを例外と
    // する。ADR-0056）。
    if ((unit.flags & FLAG_KEY) === 0) {
      return {
        ...next,
        discardedVideo: next.discardedVideo + 1,
        reporter: recordVideoDrop(next.reporter),
      };
    }
  }
  if (presentation.decision === "hold") {
    // まだ早い。復号はするが提示は端が待つ。ここでは数えるだけにする。
    next = { ...next, heldVideo: next.heldVideo + 1 };
  }

  // **連番の飛びを見たら参照連鎖が切れている**（ADR-0049）。
  //
  // TCP 上では経路で欠落しない（F-024）。したがって飛びは上流が意図的に捨てたことを意味し、
  // その後の差分は参照が欠けている。渡すと `Decoding error` になり、WebCodecs では復号器が
  // 閉じる（ADR-0047）。渡さずにキーフレームを待ち、要求する。
  const seenSeq = observationOf(next, senderId).lastVideoSeq.find(
    (entry) => entry.spatialId === unit.spatialId,
  );
  const missed = seenSeq !== undefined && isNewerSeq(unit.sequenceNumber, advanceSequence(seenSeq.seq));
  // **遅れて届いた古いユニットを渡してはならない**（受入条件 A-3）。
  //
  // 予備の接続へ切り替えたときや、接続を張り直したときに、上流が自分の位置から送り直す。
  // すると既に描いた番号より古いものが後から届く。渡すと (1) 描画が巻き戻り（A-3 の逆行）、
  // (2) 参照先の枠が既に置き換わっていて `Decoding error` になる（ADR-0047 で復号器が閉じる）。
  // **キーフレームは例外である。** 自己完結しており、送り手が番号を作り直した場合
  // （頁の再読込など）に受け取り続けられなくなるのを避ける。
  const regressed =
    seenSeq !== undefined &&
    !isNewerSeq(unit.sequenceNumber, seenSeq.seq) &&
    (unit.flags & FLAG_KEY) === 0;
  if (regressed) {
    return { ...next, reporter: recordVideoDrop(next.reporter) };
  }
  // 覚えるのは前へ進んだときだけである。古い番号を覚えると次の判定が壊れる。
  if (seenSeq === undefined || isNewerSeq(unit.sequenceNumber, seenSeq.seq)) {
    next = replaceObservation(next, {
      ...observationOf(next, senderId),
      lastVideoSeq: rememberSeq(
        observationOf(next, senderId).lastVideoSeq,
        unit.spatialId,
        unit.sequenceNumber,
      ),
    });
  }
  if (missed && (unit.flags & FLAG_KEY) === 0) {
    // **ギャップの大きさと時間層の数で破棄可否を判定する。**
    //
    // サーバーは非破棄可能ユニットを落とすとき chain を開始し（`dropWithChain`）、
    // 次の KEY まで全非キーフレームを落とし続ける（`shard-core.ts` 行 734-742）。
    // したがって非破棄可能ユニットの脱落は常にギャップ >= 2 を生む。
    //
    // 一方、破棄可能ユニット（最上位時間層 T2）の脱落は chain なしで落とされる
    // （`dropWithChain` 行 760-762: priority 1-3 は `breaksChain = false`）。
    // このときギャップ = 1 であり、より低い層は届いているため復号器は正しく動く。
    //
    // **時間層が 1 以下（または未知）のときはギャップ = 1 でも要求する。**
    // 時間層が 1 なら破棄可能な層が存在せず、gap = 1 は非破棄可能ユニットの脱落である。
    // 時間層が 0（未申告）なら何が落ちたか分からないため、安全に要求する。
    const temporalLayers = observationOf(next, senderId).temporalLayers;
    const gap = wrap32(unit.sequenceNumber - seenSeq.seq) - 1;
    if (gap > 1 || temporalLayers <= 1) {
      const gapResult = noteGap(next.decoders, senderId, channel);
      next = { ...next, decoders: gapResult.state, reporter: recordVideoDrop(next.reporter) };
      if (gapResult.actions.length > 0) {
        deps.sendReceiveControl(
          JSON.stringify({ t: "keyframeRequest", senderId, channel, spatialId: unit.spatialId }),
        );
      }
      return next;
    }
  }

  // 復号の可否は decoder-pool の判断のみを使う（独自判断を書かない）。
  const pool = decideDecode(next.decoders, {
    senderId,
    channel,
    spatialId: unit.spatialId,
    temporalId: unit.temporalId,
    flags: unit.flags,
  });
  next = { ...next, decoders: pool.state };

  const input: DecodeInput = {
    senderId,
    channel,
    spatialId: unit.spatialId,
    temporalId: unit.temporalId,
    key: (unit.flags & FLAG_KEY) !== 0,
    captureTimestampUs: captureUs,
    // `skewMs = localNow − M(videoTs)` であるから、提示すべき時刻は `now − skew` である
    // （ADR-0028 の 2 の写像 M）。早く着いた分だけ待つ（ADR-0042）。
    presentAtMs: nowMs - presentation.skewMs,
    payload: unit.payload,
  };
  for (const action of pool.actions) {
    switch (action.kind) {
      case "configure":
        deps.configureDecoder(action.senderId, action.channel, action.spatialId);
        break;
      case "reset":
        deps.resetDecoder(action.senderId, action.channel, action.spatialId);
        break;
      case "close":
        deps.closeDecoder(action.senderId, action.channel);
        break;
      case "decode":
        deps.decodeVideo(input);
        next = {
          ...next,
          presentedVideo: next.presentedVideo + 1,
        };
        next = replaceObservation(next, {
          ...observationOf(next, senderId),
          lastVideoSpatialId: unit.spatialId,
        });
        break;
      case "skip":
        next = { ...next, reporter: recordVideoDrop(next.reporter) };
        // **キーフレーム待ちなら要求する**（wire-format.md 2.5）。
        //
        // 会議の途中で購読を張ると、最初に届くのは差分フレームである。復号器は
        // キーフレームまで何も出せないため、要求しなければ**そのまま永久に待つ**。
        // 送信側の符号化器は自然なキーフレームを長い間隔でしか出さない
        // （実測: ブラウザへ映像 537 件が届いたのに `decode` は 0 回だった。F-053）。
        //
        // 間隔制限は受信ノードが持つ（`rate-limit.ts`）。ここでは毎回送ってよい。
        if (action.reason === "awaitingKeyframe") {
          deps.sendReceiveControl(
            JSON.stringify({
              t: "keyframeRequest",
              senderId,
              channel,
              spatialId: unit.spatialId,
            }),
          );
        }
        break;
    }
  }
  return next;
}

/**
 * 標本を 1 個加える。上限を超えたら古い側を捨てる。
 *
 * 既定では 0 以下を捨てる（到着間隔は正でなければ意味を持たない）。
 * ずれの標本は負の値も意味を持つため `allowNonPositive` で受け入れる。
 */
/**
 * 片道遅延の標本を基準化する。チャネルごとに最初の観測を基準にする。
 * 基準が無ければ作り、その回の標本は 0 とする。
 */
function normalizedDelay(
  state: PipelineState,
  senderId: number,
  channel: number,
  rawUs: number,
): { readonly state: PipelineState; readonly sampleUs: number } {
  const observation = observationOf(state, senderId);
  const found = observation.delayBaselineUs.find((entry) => entry.channel === channel);
  if (found !== undefined) {
    return { state, sampleUs: rawUs - found.baseUs };
  }
  const next = replaceObservation(state, {
    ...observation,
    delayBaselineUs: [...observation.delayBaselineUs, { channel, baseUs: rawUs }].sort(
      (a, b) => a.channel - b.channel,
    ),
  });
  return { state: next, sampleUs: 0 };
}

/**
 * 段ごとの連番の記録を更新する。段の昇順に保つ（反復順序が判断に影響しないようにする）。
 * 後戻り（再送）では更新しない。上流は連番を単調増加で振る（wire-format.md 1.2）。
 */
function rememberSeq(
  list: readonly { readonly spatialId: number; readonly seq: number }[],
  spatialId: number,
  seq: number,
): readonly { readonly spatialId: number; readonly seq: number }[] {
  const rest = list.filter((entry) => entry.spatialId !== spatialId);
  const found = list.find((entry) => entry.spatialId === spatialId);
  // **大小ではなく「新しいか」で選ぶ。** 数の大小で選ぶと、2^32 で巻き戻した瞬間に
  // 印が 0xFFFFFFFF に貼り付き、以後すべてが「飛び」に見えて映像が二度と出ない
  // （実測: 単体試験で検出した）。
  const kept = found !== undefined && !isNewerSeq(seq, found.seq) ? found.seq : seq;
  return [...rest, { spatialId, seq: kept }].sort((a, b) => a.spatialId - b.spatialId);
}

function appendSample(
  samples: readonly number[],
  value: number,
  allowNonPositive = false,
): readonly number[] {
  if (!allowNonPositive && value <= 0) {
    return samples;
  }
  const appended = [...samples, value];
  return appended.length > ARRIVAL_SAMPLE_LIMIT
    ? appended.slice(appended.length - ARRIVAL_SAMPLE_LIMIT)
    : appended;
}

/**
 * 送信者が申告した fps を取り込む（`streamCatalog` 由来）。
 * 停止の判定とバッファ深度の算出に使う。
 */
export function noteFramerate(state: PipelineState, senderId: number, framerate: number): PipelineState {
  const observation = observationOf(state, senderId);
  return replaceObservation(state, { ...observation, framerate });
}

/**
 * 申告された時間層の数を控える（カタログから）。
 *
 * **破棄可否（`computeDiscardable`）に必要である。** 申告が無いと、期限を過ぎたユニットを
 * 捨てたときに参照連鎖が切れたかどうかを決められず、参照の欠けた差分を復号器へ渡してしまう。
 */
export function noteTemporalLayers(
  state: PipelineState,
  senderId: number,
  temporalLayers: number,
): PipelineState {
  const observation = observationOf(state, senderId);
  return replaceObservation(state, { ...observation, temporalLayers });
}

/** 送信者の退出。復号器と再生クロックを解放する。 */
export function releaseSenderState(
  state: PipelineState,
  senderId: number,
  deps: PipelineDeps,
): PipelineState {
  const released = releaseSender(state.decoders, senderId);
  for (const action of released.actions) {
    if (action.kind === "close") {
      deps.closeDecoder(action.senderId, action.channel);
    }
  }
  return {
    ...state,
    decoders: released.state,
    playout: forgetPlayout(state.playout, senderId),
    observations: state.observations.filter((entry) => entry.senderId !== senderId),
  };
}

/**
 * 経路の不連続を伝える（再接続、予備接続への切替）。
 *
 * 経路が変わると片道遅延が変わる。対応付けをそのまま使うとずれるため、作り直させる
 * （ADR-0028 の補正の方式）。
 */
export function noteRouteChange(state: PipelineState, senderId: number): PipelineState {
  return { ...state, playout: noteDiscontinuity(state.playout, senderId) };
}

/**
 * `REPORT_INTERVAL_MS` の周期で呼ばれ、測定値を受信部屋へ送る。
 *
 * 送るのは勾配ではなく**標本列**である（ADR-0021）。勾配の算出は受信ノードが 1 箇所で行う。
 */
export function handleReportTimer(state: PipelineState, deps: PipelineDeps): PipelineState {
  const nowMs = deps.now();
  if (!shouldReport(state.reporter, nowMs)) {
    return state;
  }
  // 新しい観測が無ければ送らない。観測が無いことは輻輳の信号ではない。
  if (state.reporter.samplesUs.length === state.reportedSamples) {
    return state;
  }
  // 直近の下り帯域を載せる。これが受信ノードの予算になる（congestion.md 4.1）。
  const withEstimate = recordLinkEstimate(
    state.reporter,
    state.downlinkBps,
    jitterOf(state),
    bufferHealthOf(state),
  );
  const report = takeReport(withEstimate, nowMs);
  deps.sendReceiveControl(report.text);
  return { ...state, reporter: report.state, reportedSamples: state.reporter.samplesUs.length };
}

function jitterOf(state: PipelineState): number {
  let worst = 0;
  for (const observation of state.observations) {
    const value = jitterP99Ms(observation.arrivalGapsMs);
    if (value > worst) {
      worst = value;
    }
  }
  return worst;
}

function bufferHealthOf(state: PipelineState): ReporterState["bufferHealth"] {
  if (state.discardedVideo > 0) {
    return "draining";
  }
  if (state.heldVideo > 0) {
    return "growing";
  }
  return "stable";
}

/** 観測用。報告の周期を外から確かめられるようにする。 */
export const PIPELINE_REPORT_INTERVAL_MS = REPORT_INTERVAL_MS;

/** 観測用。不連続で対応付けを作り直した回数（SLI）。 */
export function resyncCount(state: PipelineState): number {
  return resyncTotal(state.playout);
}

/**
 * 復号が失敗したことを受ける。
 *
 * 復号器をキーフレーム待ちへ戻し、**キーフレームを要求する**（wire-format.md 2.5）。
 * 要求しないと、参照連鎖が壊れた復号器は次の自然なキーフレームまで何も出さない。
 * 要求の間隔制限は受信ノードが持つ（`rate-limit.ts`）。
 */
export function noteDecodeError(
  state: PipelineState,
  senderId: number,
  channel: number,
  deps: PipelineDeps,
): PipelineState {
  const failed = markDecodeFailure(state.decoders, senderId, channel);
  for (const action of failed.actions) {
    if (action.kind === "reset") {
      deps.resetDecoder(action.senderId, action.channel, action.spatialId);
    }
  }
  const spatialId = observationOf(state, senderId).lastVideoSpatialId;
  deps.sendReceiveControl(
    JSON.stringify({
      t: "keyframeRequest",
      senderId,
      channel,
      spatialId: spatialId < 0 ? 0 : spatialId,
    }),
  );
  return { ...state, decoders: failed.state };
}


/** 観測の写し（`sdk-api.md` 3 節の `quality`）。判断には使わない。 */
export interface QualitySnapshot {
  readonly downlinkBps: number;
  readonly delayTrendNumerator: number;
  readonly delayTrendDenominator: number;
  readonly stallRatioPerMille: number;
  readonly avSkewMs: number;
  /** 直近に映像が届いてから経過した時間（ミリ秒）。停止の判定に使う。 */
  readonly stalledForMs: number;
  /** 遅延が増加傾向にあるか。閾値は規範の値を使う。 */
  readonly degrading: boolean;
}

/**
 * 観測の写しを作る。
 *
 * **勾配の算出は判断ではない。** 段の決定は受信ノードが行う（ADR-0021）。ここで求めるのは
 * 利用側へ見せる値と、リンクへ伝える「増加傾向か」だけである。算出は `delaySlope`
 * （共通の純関数）に委ね、独自の式を書かない。
 */
export function qualitySnapshot(state: PipelineState, nowMs: number): QualitySnapshot {
  const slope = delaySlope(state.reporter.samplesUs);
  const total = state.presentedVideo + state.stalls;
  const stallRatioPerMille = total === 0 ? 0 : Math.trunc((state.stalls * 1000) / total);
  let worstSkew = 0;
  for (const sample of state.skewSamplesMs) {
    const magnitude = sample < 0 ? -sample : sample;
    if (magnitude > worstSkew) {
      worstSkew = magnitude;
    }
  }
  let stalledForMs = 0;
  for (const observation of state.observations) {
    if (observation.lastVideoAtMs === 0) {
      continue;
    }
    const elapsed = nowMs - observation.lastVideoAtMs;
    if (elapsed > stalledForMs) {
      stalledForMs = elapsed;
    }
  }
  return {
    downlinkBps: state.downlinkBps,
    delayTrendNumerator: slope.numerator,
    delayTrendDenominator: slope.denominator,
    stallRatioPerMille,
    avSkewMs: worstSkew,
    stalledForMs,
    degrading: slope.numerator * DELAY_TREND_DEGRADE_DEN > DELAY_TREND_DEGRADE_NUM * slope.denominator,
  };
}

/** 観測用。直近に復号へ渡した段。`receivedProfile` の呼び名に使う。 */
export function receivedSpatialId(state: PipelineState, senderId: number): number {
  return observationOf(state, senderId).lastVideoSpatialId;
}
