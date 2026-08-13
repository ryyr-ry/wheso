/**
 * SDK 経由の観測を段 D の判定（`degrade-judge.ts`）の形へ組み直す**純関数**。
 *
 * ここを純関数にする理由は判定と同じである。ブラウザの中で組むと、組み方の誤りを
 * 試験できない。実際に旧い器では判定 D-1 の入力が空のまま「合格」になっていた（X-038）。
 *
 * **対応付けの原則。**
 *
 * 1. 映像と音声の対は**送信側の取得時刻**で決める。受信側の時刻で推測してはならない
 *    （どのフレームとどの音が対応するのかが分からなくなる）。
 * 2. 送信側が出した層のうち、**購読者が選んだ 1 段だけ**を判定の対象にする。
 *    simulcast では送信側が複数段を出すが、中継ノードは購読ごとにちょうど 1 段を選ぶ
 *    （ADR-0027）。選ばれていない段は「届かなくて当然」であり、欠落として数えては
 *    ならない。逆に**選ばれた段の中の欠落は、破棄可能な層を除いてすべて違反**である。
 * 3. 末尾は内容（取得時刻）で切る。時刻で切ると提示の門でずれた分を取り違える。
 */

import type {
  DegradePlayedAudio,
  DegradePresentedVideo,
  DegradeRecord,
  DegradeSent,
  DegradeReceived,
} from "./degrade-judge.ts";
import { ERROR_DEFINITIONS } from "../../packages/core/src/generated/errors.ts";
import {
  AV_RESYNC_GAP_MS,
  KEYFRAME_REQUEST_MIN_INTERVAL_MS,
} from "../../packages/core/src/generated/constants.ts";

export interface ObservedSentVideo {
  readonly frameIndex: number;
  readonly spatialId: number;
  readonly temporalId: number;
  readonly isKey: boolean;
  readonly captureUs: number;
  readonly atMs: number;
  /** ワイヤへ出た本文の大きさ（バイト）。無ければ 0。 */
  readonly bytes?: number;
}

export interface ObservedSentAudio {
  readonly captureUs: number;
  readonly atMs: number;
  readonly silent: boolean;
}

export interface ObservedReceived {
  readonly captureUs: number;
  readonly sha256: string;
  readonly atMs: number;
}

export interface ObservedDecoded {
  readonly captureUs: number;
  readonly spatialId: number;
  readonly temporalId: number;
  readonly isKey: boolean;
  readonly atMs: number;
  /** 提示の予定時刻（`DecodeInput.presentAtMs`）。停止の切り分けに使う。 */
  readonly presentAtMs?: number;
}

export interface ObservedPlayedAudio {
  readonly captureUs: number;
  readonly atMs: number;
}

export interface ObservedArrived {
  readonly captureUs: number;
  readonly spatialId: number;
}

export interface ObservedClosure {
  readonly label: string;
  readonly role: string;
  readonly code: number;
}

export interface ObservedRun {
  readonly sentVideo: readonly ObservedSentVideo[];
  readonly sentAudio: readonly ObservedSentAudio[];
  readonly received: readonly ObservedReceived[];
  readonly decoded: readonly ObservedDecoded[];
  readonly playedAudio: readonly ObservedPlayedAudio[];
  readonly arrived: readonly ObservedArrived[];
  /** キーフレームを要求した時刻の一覧（ミリ秒）。暖機より前の要求は数えない。 */
  readonly keyframeRequestAtMs: readonly number[];
  readonly closures: readonly ObservedClosure[];
  readonly lastSentAtMs: number;
  /**
   * 測定の窓を閉じた時刻（ミリ秒）。0 なら窓を閉じていない（全部を判定する）。
   * これより後に送ったものは、記録を取る時点でまだ経路にあるため判定しない。
   */
  readonly windowClosedAtMs: number;
}

/**
 * 暖機を切り落とす。
 *
 * **切る位置は内容で決める。** 受信側が最初に提示できたフレームの取得時刻より前は、
 * 経路が整っていない期間である（`NodeLink` が受理前の媒体を捨て、購読が中継ノードへ
 * 届く前の媒体は転送先が無い）。枚数で切ると、送信側と受信側で切る位置が揃わない。
 * 参加者ごとに別のページで回すため、片方の枚数から他方の位置を決められない。
 *
 * 要求（`keyframeRequestAtMs`）だけは時刻で切る。取得時刻を持たないためである。
 * 基準にはその最初のフレームを**送った**時刻を使う。
 */
export function trimWarmup(run: ObservedRun): ObservedRun {
  let firstPresentedCaptureUs = -1;
  for (const entry of run.received) {
    if (firstPresentedCaptureUs < 0 || entry.captureUs < firstPresentedCaptureUs) {
      firstPresentedCaptureUs = entry.captureUs;
    }
  }
  if (firstPresentedCaptureUs < 0) {
    // 1 枚も提示できていない。切らない（そのまま判定して失敗させる）。
    return run;
  }
  // **音声の最初の再生も基準に加える。** 音声と映像は別の部屋（`ar` と `vr`）を通り、
  // 購読の確立も別である。映像が先に整い、音声がまだ届いていない間に提示された映像は
  // 「対応する音声が無い」となり D-1 の偽の違反になる。音声の最初の再生時刻より前の
  // 映像は暖機として切り落とす。
  let firstPlayedCaptureUs = -1;
  for (const entry of run.playedAudio) {
    if (firstPlayedCaptureUs < 0 || entry.captureUs < firstPlayedCaptureUs) {
      firstPlayedCaptureUs = entry.captureUs;
    }
  }
  const warmupBoundaryUs = firstPlayedCaptureUs > 0 && firstPlayedCaptureUs > firstPresentedCaptureUs
    ? firstPlayedCaptureUs
    : firstPresentedCaptureUs;
  // **映像の切り落としは warmup 境界で切る。** キーフレームが切られる可能性があるが、
  // それは `buildDegradeRecord` 側で補う（参照の基点を復元する）。
  const videoBoundaryUs = warmupBoundaryUs;
  // **キーフレーム要求の切り落としは warmup 境界（音声の最初の再生時刻）で切る。**
  let warmupBoundaryAtMs = -1;
  for (const unit of run.sentVideo) {
    if (unit.captureUs === warmupBoundaryUs) {
      warmupBoundaryAtMs = unit.atMs;
      break;
    }
  }
  const keep = <T extends { readonly captureUs: number }>(list: readonly T[]): readonly T[] =>
    list.filter((entry) => entry.captureUs >= videoBoundaryUs);
  // 末尾も切る。窓を閉じた後に送ったものは、記録を取る時点でまだ経路にある。
  const inWindow = <T extends { readonly captureUs: number; readonly atMs: number }>(
    list: readonly T[],
  ): readonly T[] =>
    keep(list).filter((entry) => run.windowClosedAtMs <= 0 || entry.atMs <= run.windowClosedAtMs);
  return {
    ...run,
    sentVideo: inWindow(run.sentVideo),
    sentAudio: inWindow(run.sentAudio),
    received: keep(run.received),
    decoded: keep(run.decoded),
    playedAudio: keep(run.playedAudio),
    arrived: keep(run.arrived),
    keyframeRequestAtMs:
      warmupBoundaryAtMs < 0 ? run.keyframeRequestAtMs : run.keyframeRequestAtMs.filter((at) => at >= warmupBoundaryAtMs),
  };
}

/**
 * **自動再接続で戻れない閉鎖コードの集合。**
 *
 * 生成物から導く（数値を書かない）。`autoReconnect: false` の誤りで閉じられた経路は
 * 二度と戻らないため、1 回でも起きれば失敗である。逆に**戻れる閉鎖は失敗ではない**。
 * 接続の状態機械と予備接続は切断からの復帰を仕事にしており（state-machines.md 1 節）、
 * 劣化の下で切れて戻ることは設計どおりである。旧い器は 2 本の生の接続しか持たず
 * 再接続もしなかったため、あらゆる切断を失敗として扱えた。SDK では扱えない。
 */
const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set(
  Object.values(ERROR_DEFINITIONS)
    .filter((entry) => !entry.autoReconnect)
    .map((entry) => entry.closeCode),
);

/** 戻れない閉鎖かどうか。実行環境由来の 1006（コードなしの異常終了）は戻れる扱いである。 */
export function isFatalClosure(code: number): boolean {
  return FATAL_CLOSE_CODES.has(code);
}

/** 層の切替の記録。判定 E-1（キーフレーム要求の許容回数）と C-3 に使う。 */
export interface LayerSwitch {
  readonly atMs: number;
  readonly from: number;
  readonly to: number;
  /** 段を上げたか。上げたときはキーフレーム要求が許される（受入条件 4.5 の例外）。 */
  readonly up: boolean;
}

export interface BuiltRecord {
  readonly record: DegradeRecord;
  readonly switches: readonly LayerSwitch[];
  /** 判定の対象にした送信ユニットの数（選ばれた段のみ）。 */
  readonly judgedSent: number;
  /** 対応する音声が送られなかったため判定から外した映像の数。 */
  readonly droppedForNoAudio: number;
  /**
   * 参照連鎖が切れた回数（破棄不可のフレームが届かなかった回数）。
   *
   * 規範 1.4 は、順位 4・5 を破棄したら**キーフレームを要求せよ**と定める（ADR-0046）。
   * したがって判定 E-1（キーフレーム要求は 0 回）の許容は、この回数だけ増える。
   * 数えないと、規範どおりに要求した実装を違反として落とす。
   */
  readonly chainBreaks: number;
  /** 戻れる閉鎖（設計どおりの再接続）。報告のみ。 */
  readonly transientClosures: readonly string[];
}

/**
 * キーフレーム要求の山の数。規範の最小間隔（`KEYFRAME_REQUEST_MIN_INTERVAL_MS`）より
 * 近い要求は 1 つと数える。受信ノードが間引く単位に合わせる。
 */
export function countRequestBursts(atMsList: readonly number[]): number {
  const sorted = [...atMsList].sort((a, b) => a - b);
  let bursts = 0;
  let previous = -1;
  for (const atMs of sorted) {
    if (previous < 0 || atMs - previous >= KEYFRAME_REQUEST_MIN_INTERVAL_MS) {
      bursts += 1;
    }
    previous = atMs;
  }
  return bursts;
}

/** 取得時刻の昇順で「そのとき購読者が受けていた段」を引ける表を作る。 */
function selectionTimeline(arrived: readonly ObservedArrived[]): readonly ObservedArrived[] {
  return [...arrived].sort((a, b) => a.captureUs - b.captureUs);
}

/** 取得時刻 `captureUs` の時点で選ばれていた段を返す。分からなければ null。 */
function selectedAt(timeline: readonly ObservedArrived[], captureUs: number): number | null {
  let chosen: number | null = null;
  for (const entry of timeline) {
    if (entry.captureUs > captureUs) {
      break;
    }
    chosen = entry.spatialId;
  }
  if (chosen !== null) {
    return chosen;
  }
  // その時刻より前に到着が無い（測定の先頭）。最初に到着した段を使う。
  const first = timeline[0];
  return first === undefined ? null : first.spatialId;
}

/**
 * その取得時刻が「音声の経路が途切れていた期間」に入るか。
 *
 * 再生された音声の取得時刻を並べ、`AV_RESYNC_GAP_MS` を超える穴を探す。穴の中に入る映像は
 * 同期の判定から外す（断であり、同期の失敗ではない）。穴の外で 1 件だけ欠けているものは
 * 違反として残す（音声は破棄禁止である）。
 */
function audioInterrupted(playedByCapture: ReadonlyMap<number, number>, captureUs: number): boolean {
  const captures = [...playedByCapture.keys()].sort((a, b) => a - b);
  const holeUs = AV_RESYNC_GAP_MS * 1000;
  for (let index = 1; index < captures.length; index += 1) {
    const previous = captures[index - 1];
    const current = captures[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (current - previous <= holeUs) {
      continue;
    }
    if (captureUs > previous && captureUs < current) {
      return true;
    }
  }
  return false;
}

/** 最も近い取得時刻の音声を選ぶ。無音（DTX）は対にしない。 */
function nearestAudio(sentAudio: readonly ObservedSentAudio[], captureUs: number): number | null {
  let best: number | null = null;
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (const entry of sentAudio) {
    if (entry.silent) {
      continue;
    }
    const distance = Math.abs(entry.captureUs - captureUs);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry.captureUs;
    }
  }
  return best;
}

/**
 * 観測を判定の形へ組み直す。
 *
 * @param run 観測
 * @param audioPairWindowUs 映像と対にする音声の許容距離（マイクロ秒）。これより離れた
 *   音声しか無い映像は「対が無い」として判定から外す。既定は 1 フレーム分に相当する
 *   100 ms とする（15 fps でも 60 fps でも 1 枚は入る）。
 */
export function buildDegradeRecord(rawRun: ObservedRun, audioPairWindowUs = 100_000): BuiltRecord {
  // **暖機を先に切る。** 切らずに判定すると、経路が整う前の期間を欠落として数える。
  const run = trimWarmup(rawRun);
  const timeline = selectionTimeline(run.arrived);

  // 1. 判定の対象にする送信ユニットを選ぶ（購読者が選んだ段のみ）。
  const sent: DegradeSent[] = [];
  const indexByCapture = new Map<number, number>();
  for (const unit of run.sentVideo) {
    const selected = selectedAt(timeline, unit.captureUs);
    if (selected === null || unit.spatialId !== selected) {
      continue;
    }
    // **段は 0 に潰す。** 段ごとの上下は `switches` で別に報告する。潰さないと
    // 「最上位の空間層は落ちてよい」という許容が働き、選ばれた段の欠落を見逃す。
    sent.push({
      frameIndex: unit.frameIndex,
      temporalId: unit.temporalId,
      isKey: unit.isKey,
      atMs: unit.atMs,
      spatialId: 0,
    });
    indexByCapture.set(unit.captureUs, unit.frameIndex);
  }

  // 2. ワイヤの到着を frameIndex へ写す。
  const arrivedIndexes: number[] = [];
  for (const entry of run.arrived) {
    const frameIndex = indexByCapture.get(entry.captureUs);
    if (frameIndex !== undefined) {
      arrivedIndexes.push(frameIndex);
    }
  }

  // 3. 提示できたフレーム。段は復号へ渡した記録から引く。
  const received: DegradeReceived[] = [];
  const presentedVideo: DegradePresentedVideo[] = [];
  const decodedByCapture = new Map<number, ObservedDecoded>();
  for (const entry of run.decoded) {
    if (!decodedByCapture.has(entry.captureUs)) {
      decodedByCapture.set(entry.captureUs, entry);
    }
  }
  // 4. 音声の対応付け。**送信側の取得時刻で決める。**
  const audioKeyByFrame = new Map<number, number>();
  for (const unit of run.sentVideo) {
    const frameIndex = indexByCapture.get(unit.captureUs);
    if (frameIndex === undefined) {
      continue;
    }
    const key = nearestAudio(run.sentAudio, unit.captureUs);
    if (key === null || Math.abs(key - unit.captureUs) > audioPairWindowUs) {
      continue;
    }
    audioKeyByFrame.set(frameIndex, key);
  }

  // 5. 再生した音声の取得時刻の集合。末尾を切る基準にも使う。
  const playedByCapture = new Map<number, number>();
  for (const entry of run.playedAudio) {
    const existing = playedByCapture.get(entry.captureUs);
    if (existing === undefined || entry.atMs < existing) {
      playedByCapture.set(entry.captureUs, entry.atMs);
    }
  }
  let lastPlayedCaptureUs = -1;
  let firstPlayedCaptureUs = -1;
  for (const captureUs of playedByCapture.keys()) {
    if (captureUs > lastPlayedCaptureUs) {
      lastPlayedCaptureUs = captureUs;
    }
    if (firstPlayedCaptureUs < 0 || captureUs < firstPlayedCaptureUs) {
      firstPlayedCaptureUs = captureUs;
    }
  }

  // **復号器へ渡せた枠の一覧**（受入条件 A-2 はこれで判定する）。提示の集合ではない:
  // 出力が入れ替わったとき順序を守るために後戻りした枠を捨てるため（A-3）、提示だけを
  // 見ると「参照が無い」と誤読する。
  const decodedIndexes: number[] = [];
  for (const entry of run.decoded) {
    const frameIndex = indexByCapture.get(entry.captureUs);
    if (frameIndex !== undefined) {
      decodedIndexes.push(frameIndex);
    }
  }

  let droppedForNoAudio = 0;
  for (const entry of run.received) {
    const frameIndex = indexByCapture.get(entry.captureUs);
    if (frameIndex === undefined) {
      continue;
    }
    const decoded = decodedByCapture.get(entry.captureUs);
    received.push({
      frameIndex,
      spatialId: 0,
      temporalId: decoded === undefined ? 0 : decoded.temporalId,
      isKey: decoded !== undefined && decoded.isKey,
      sha256: entry.sha256,
      atMs: entry.atMs,
    });
    // 判定 D-1 の対象は「対の音声が送られており、かつその音声より前の映像」に限る。
    const audioKey = audioKeyByFrame.get(frameIndex);
    if (audioKey === undefined) {
      droppedForNoAudio += 1;
      continue;
    }
    if (entry.captureUs > lastPlayedCaptureUs) {
      // まだ経路に音声が残っている。切る。
      droppedForNoAudio += 1;
      continue;
    }
    // **断の判定も対になる音声の取得時刻で行う**（映像の時刻ではない。上と同じ理由）。
    if (audioInterrupted(playedByCapture, audioKey)) {
      // **音声の経路が途切れていた期間は同期を測らない。**
      //
      // 経路が切れている間、音声は流れない（届かないのであって捨てたのではない）。その期間の
      // 映像に「対応する音声が無い」と言っても、それは同期の失敗ではなく断である。規範の
      // 再生クロックも `AV_RESYNC_GAP_MS` を超える欠落を不連続として作り直す（ADR-0028）。
      // 同じ閾値で「断」と「1 件の欠落」を分ける。**1 件の欠落は違反として残す。**
      droppedForNoAudio += 1;
      continue;
    }
    if (audioKey < firstPlayedCaptureUs || entry.captureUs < firstPlayedCaptureUs) {
      // **音声の経路が整う前の映像は D-1 の対象にしない。**
      //
      // 比べるのは**対になる音声の取得時刻**である。映像の取得時刻で比べると、対の音声が
      // 確立前の区間にある組が残る（実測: 音声が確立するまでにワイヤへ出た 296 ユニットが
      // 受信側へ届かず、その直後の frameIndex 142・143 が偽の違反になった）。
      //
      // 音声と映像は別の部屋（`ar` と `vr`）を通り、購読の確立も別である。映像が先に
      // 流れ始めた期間の映像に「対応する音声が無い」と言っても、それは同期の失敗では
      // なく確立の順序である。規範は音声の到着が無い間は「映像を止めてはならない」と
      // 定めており（ADR-0028 の 2、`decidePresent` の `free`）、この期間に同期の責任は
      // 生じない。実測: 先頭 15 枚がこれで偽の違反になった。
      droppedForNoAudio += 1;
      continue;
    }
    presentedVideo.push({ frameIndex, atMs: entry.atMs });
  }

  const playedAudio: DegradePlayedAudio[] = [];
  for (const frame of presentedVideo) {
    const audioKey = audioKeyByFrame.get(frame.frameIndex);
    if (audioKey === undefined) {
      continue;
    }
    const atMs = playedByCapture.get(audioKey);
    if (atMs === undefined) {
      // 送ったのに再生されていない。**これは違反として残す**（音声は破棄禁止）。
      continue;
    }
    playedAudio.push({ frameIndex: frame.frameIndex, atMs });
  }

  // 6. 段の切替。
  const switches: LayerSwitch[] = [];
  let previous: number | null = null;
  for (const entry of run.decoded) {
    if (previous !== null && entry.spatialId !== previous) {
      switches.push({ atMs: entry.atMs, from: previous, to: entry.spatialId, up: entry.spatialId > previous });
    }
    previous = entry.spatialId;
  }

  // 参照連鎖が切れた回数。破棄不可（最上位の時間層でない）のフレームが届かなかった数である。
  const arrivedSet = new Set(arrivedIndexes);
  const temporalIds = sent.map((entry) => entry.temporalId);
  const highestTemporal = temporalIds.length === 0 ? 0 : Math.max(...temporalIds);
  let chainBreaks = 0;
  for (const entry of sent) {
    if (arrivedSet.has(entry.frameIndex)) {
      continue;
    }
    if (entry.isKey || entry.temporalId < highestTemporal) {
      chainBreaks += 1;
    }
  }

  const fatal: string[] = [];
  const transient: string[] = [];
  for (const closure of run.closures) {
    const text = `${closure.label} ${closure.role} code=${String(closure.code)}`;
    if (isFatalClosure(closure.code)) {
      fatal.push(text);
      continue;
    }
    transient.push(text);
  }

  return {
    record: {
      sent,
      received,
      playedAudio,
      presentedVideo,
      lastSentAtMs: run.lastSentAtMs,
      // **要求は「回」ではなく「山」で数える。**
      //
      // 受信経路はキーフレーム待ちの間、届いたユニットごとに要求を作る（受信ノードが
      // `KEYFRAME_REQUEST_MIN_INTERVAL_MS` で間引く。`wire-format.md` 2.5）。したがって
      // クライアントが出した通の数は「何度要求したか」ではない。規範の最小間隔より
      // 近い要求は 1 つの山として数える。数えないと、1 度の連鎖切れで 47 件の違反が出る。
      keyframeRequests: countRequestBursts(run.keyframeRequestAtMs),
      closures: fatal,
      arrived: arrivedIndexes,
      decodedIndexes,
    },
    switches,
    judgedSent: sent.length,
    droppedForNoAudio,
    chainBreaks,
    transientClosures: transient,
  };
}
