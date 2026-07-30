/**
 * 段 D の判定（受入条件 4 節）。
 *
 * ここは**純関数**である。時刻・乱数・入出力に触れない。記録（送信と受信の一覧）を受け取り、
 * 違反の一覧を返す。理由は 2 つある。
 *
 * 1. 判定そのものを試験できる。「落ちるべき記録で落ちる」ことを合成した記録で確かめられる。
 *    劣化下で緑になっただけでは、判定が働いているのか、何も見ていないのか区別できない。
 * 2. 閾値は生成物（spec/schema/impairment.json）から来る。判定を器（ブラウザ）へ持ち込むと
 *    値が二重管理になる。
 */

import {
  AV_SKEW_AUDIO_LAG_MAX_MS,
  AV_SKEW_AUDIO_LEAD_MAX_MS,
} from "../../packages/core/src/generated/constants.ts";

export interface DegradeSent {
  readonly frameIndex: number;
  readonly temporalId: number;
  readonly isKey: boolean;
  readonly atMs: number;
  /** 空間層。simulcast の上位層は購読の上限が下がれば転送されない（破棄が許される）。 */
  readonly spatialId?: number;
}

export interface DegradeReceived {
  readonly frameIndex: number;
  /** 空間層。与えられない場合は 0 として扱う（合成した記録で判定を試験するときに使う）。 */
  readonly spatialId?: number;
  readonly temporalId: number;
  readonly isKey: boolean;
  readonly sha256: string;
  readonly atMs: number;
}

/**
 * 音声の再生 1 件（判定 D-1 の入力）。
 *
 * **映像と対応が取れる印**が必要である。送信側は映像に既知の模様を描き、同時刻の音声に
 * その模様に対応する既知のトーンを入れる。受信側は復号した映像の模様と再生した音声の
 * トーンを別々に記録し、判定が突き合わせる。時刻の差だけを見ても、どのフレームと
 * どの音が対応するのかが分からない（実際に同じ誤りで判定が空になり得る）。
 */
export interface DegradePlayedAudio {
  /** 対応する映像の frameIndex。送信側が模様とトーンを同じ番号で作る。 */
  readonly frameIndex: number;
  /** 再生した局所時刻（ミリ秒）。 */
  readonly atMs: number;
}

/** 映像の提示 1 件（判定 D-1 の入力）。復号ではなく**提示**の時刻である。 */
export interface DegradePresentedVideo {
  readonly frameIndex: number;
  /** 提示した局所時刻（ミリ秒）。 */
  readonly atMs: number;
}

export interface DegradeRecord {
  readonly sent: readonly DegradeSent[];
  readonly received: readonly DegradeReceived[];
  /** 音声の再生の記録。判定 D-1 に使う。無ければ D-1 は判定しない。 */
  readonly playedAudio?: readonly DegradePlayedAudio[];
  /** 映像の提示の記録。判定 D-1 に使う。無ければ D-1 は判定しない。 */
  readonly presentedVideo?: readonly DegradePresentedVideo[];
  /** 最後に送った時刻。これ以降の受信間隔は「固まった」の判定に含めない。 */
  readonly lastSentAtMs: number;
  readonly keyframeRequests: number;
  /** 接続が閉じた記録（閉鎖コードと時刻）。空であれば切れていない。 */
  readonly closures?: readonly string[];
  /**
   * ワイヤで届いた frameIndex の一覧（復号の成否に依らない）。
   * 与えられた場合、転送の判定（B-2）はこちらに対して行う。与えられない場合は
   * received を使う（合成した記録で判定そのものを試験するときに使う）。
   */
  readonly arrived?: readonly number[];
}

export interface Violation {
  /** 受入条件の判定番号（A-1 など）。 */
  readonly judgement: string;
  readonly detail: string;
}

/**
 * 判定 A-3: frameIndex が**同一の送信者・空間層の中で**単調増加である（受入条件 4.1）。
 *
 * 層をまとめて見てはならない。simulcast では層ごとに復号器が別であり、出力の順序は
 * 層の間で交錯する。まとめて見ると正常な交錯を逆行と誤判定する（実測で 2 件出た）。
 */
export function judgeMonotonic(record: DegradeRecord): readonly Violation[] {
  const violations: Violation[] = [];
  const lastByLayer = new Map<number, number>();
  for (const entry of record.received) {
    const spatialId = entry.spatialId ?? 0;
    const previous = lastByLayer.get(spatialId) ?? 0;
    if (entry.frameIndex <= previous) {
      violations.push({
        judgement: "A-3",
        detail: `空間層 ${String(spatialId)} の frameIndex が逆行または重複した（${String(previous)} の次に ${String(entry.frameIndex)}）`,
      });
    }
    lastByLayer.set(spatialId, entry.frameIndex);
  }
  return violations;
}

/** 判定 A-1 の前提: すべての受信フレームでハッシュが得られている。 */
export function judgeHashes(record: DegradeRecord): readonly Violation[] {
  const violations: Violation[] = [];
  for (const entry of record.received) {
    if (entry.sha256.length !== 64) {
      violations.push({
        judgement: "A-1",
        detail: `${String(entry.frameIndex)} 番目のハッシュが 64 文字でない（${String(entry.sha256.length)}）`,
      });
    }
  }
  return violations;
}

/**
 * 判定 C-1 / C-2: 連続する描画の間隔が上限を超えない。
 * 送信が終わった後の受信は評価に入れない（送信を止めれば描画も止まる）。
 */
export function judgeContinuity(record: DegradeRecord, maxGapMs: number): readonly Violation[] {
  let previous: number | undefined;
  let worst = 0;
  let worstAt = 0;
  for (const entry of record.received) {
    if (entry.atMs > record.lastSentAtMs) {
      break;
    }
    if (previous !== undefined && entry.atMs - previous > worst) {
      worst = entry.atMs - previous;
      worstAt = entry.atMs;
    }
    previous = entry.atMs;
  }
  if (worst > maxGapMs) {
    return [
      {
        judgement: "C-1",
        detail: `描画の間隔が ${String(maxGapMs)} ms を超えた（最悪 ${worst.toFixed(0)} ms、${worstAt.toFixed(0)} ms 時点）`,
      },
    ];
  }
  return [];
}

/**
 * 判定 B-2: 落ちたフレームは破棄可能なものだけである。
 *
 * 破棄が許されるのは最上位の時間層に限る。キーフレームと基底層が落ちていれば、
 * 依存構造が壊れた状態で描画したか、単発の欠落が起きたことを意味する。
 */
/**
 * 判定 B-2: 落ちたフレームは破棄可能なものだけである。
 *
 * 破棄が許されるのは次の 2 つである。
 *   1. 最上位の時間層（時間スケーラビリティの上の層）
 *   2. 最上位の空間層（購読の上限が下がれば転送されない）
 * キーフレームと基底層が落ちていれば、依存構造が壊れた状態で描画したことを意味する。
 */
export function judgeDrops(record: DegradeRecord): readonly Violation[] {
  // 転送の欠落を見る。復号できたかは別の問題であり、混ぜると原因の層を取り違える。
  const arrived = new Set(
    record.arrived !== undefined
      ? record.arrived
      : record.received.map((entry) => entry.frameIndex),
  );
  const temporalIds = record.sent.map((entry) => entry.temporalId);
  const highestTemporal = temporalIds.length === 0 ? 0 : Math.max(...temporalIds);
  const spatialIds = record.sent.map((entry) => entry.spatialId ?? 0);
  const highestSpatial = spatialIds.length === 0 ? 0 : Math.max(...spatialIds);
  const violations: Violation[] = [];
  for (const entry of record.sent) {
    if (arrived.has(entry.frameIndex)) {
      continue;
    }
    const spatialId = entry.spatialId ?? 0;
    // 最上位の空間層は購読の上限が下がれば転送されない。これは破棄として正しい。
    if (spatialId >= highestSpatial && highestSpatial > 0) {
      continue;
    }
    if (entry.isKey) {
      violations.push({
        judgement: "B-2",
        detail: `キーフレーム ${String(entry.frameIndex)} が落ちた（空間層 ${String(spatialId)}）`,
      });
      continue;
    }
    if (entry.temporalId < highestTemporal) {
      violations.push({
        judgement: "B-2",
        detail: `破棄できない層のフレーム ${String(entry.frameIndex)} が落ちた（空間層 ${String(spatialId)} / 時間層 ${String(entry.temporalId)}）`,
      });
    }
  }
  return violations;
}

/** 判定 B-1: 劣化なしでは欠落が 0 である。 */
export function judgeCompleteness(record: DegradeRecord): readonly Violation[] {
  if (record.received.length === record.sent.length) {
    return [];
  }
  return [
    {
      judgement: "B-1",
      detail: `欠落がある（送 ${String(record.sent.length)} / 受 ${String(record.received.length)}）`,
    },
  ];
}

/**
 * 判定 E-1: キーフレーム要求が 0 回である。
 *
 * ただし受入条件 4.5 は例外を 2 つ認めている。**遮断からの復帰時**と
 * **tier の spatialId を変更したとき**である。層を上げるときは参照フレームが無いため
 * 要求が必要であり、これを違反にすると規範より厳しくなる。
 *
 * 許される回数を超えた要求は違反である。超えた分は「破棄の実装の誤り」を意味する
 * （TCP 上では欠落が起こらないため、依存構造に従って捨てれば参照連鎖は壊れない）。
 */
export function judgeKeyframeRequests(record: DegradeRecord, allowed = 0): readonly Violation[] {
  if (record.keyframeRequests <= allowed) {
    return [];
  }
  return [
    {
      judgement: "E-1",
      detail: `キーフレーム要求が ${String(record.keyframeRequests)} 回発生した（許されるのは ${String(allowed)} 回）`,
    },
  ];
}

export interface JudgeOptions {
  readonly maxGapMs: number;
  /** 劣化なしの段では欠落 0 を要求する（判定 B-1）。 */
  readonly requireComplete: boolean;
  /**
   * 許されるキーフレーム要求の回数（受入条件 4.5 の例外）。
   * tier の spatialId を変更した回数と、遮断からの復帰回数の合計を渡す。
   */
  readonly allowedKeyframeRequests?: number;
  /**
   * 音声と映像のずれの許容（判定 D-1）。
   *
   * **非対称である**（F-043、ADR-0028）。既定は生成物の定数を使う。
   * 判定そのものを試験するときだけ上書きする。
   */
  readonly audioLeadMaxMs?: number;
  readonly audioLagMaxMs?: number;
}

/**
 * 接続が切れていないこと。
 *
 * これを独立した判定にする理由: 経路が切れると以降の全フレームが届かず、B-2（破棄できない
 * 層が落ちた）の違反が大量に並ぶ。原因は破棄の判断ではなく経路であり、真の原因が
 * 埋もれる。切断を先に報告し、B-2 は切断が無い場合にのみ意味を持つ。
 */
export function judgeConnections(record: DegradeRecord): readonly Violation[] {
  const closures = record.closures ?? [];
  if (closures.length === 0) {
    return [];
  }
  return [
    {
      judgement: "接続",
      detail: `試験の途中で接続が切れた（${closures.join(", ")}）`,
    },
  ];
}

/**
 * 判定 D-1: 音声と映像のずれが許容の内側である（受入条件 4.6、ADR-0028）。
 *
 * ```
 * skew = 映像を提示した時刻 − 対応する音声を再生した時刻
 * skew > 0  映像が遅れている = 音声が先行している  → 許容は audioLeadMaxMs
 * skew < 0  映像が先行している = 音声が遅れている  → 許容は audioLagMaxMs
 * ```
 *
 * 許容が**非対称**である理由は、人が音声の先行に厳しいことである（ITU-R BT.1359-0。F-043）。
 * 対称の閾値で判定すると、音声先行の側で見えるずれを合格にしてしまう。
 *
 * 記録が無い場合は判定しない。**ただし「記録が無いから合格」ではない。**
 * 呼び出し側は記録を用意する責務を持つ（用意しないと D-1 は空になる）。
 * その空洞を防ぐため、`judgeAll` は音声の記録がある場合に限り D-1 を数える。
 */
export function judgeAvSkew(
  record: DegradeRecord,
  audioLeadMaxMs: number,
  audioLagMaxMs: number,
): readonly Violation[] {
  const audio = record.playedAudio;
  const video = record.presentedVideo;
  if (audio === undefined || video === undefined || audio.length === 0 || video.length === 0) {
    return [];
  }
  // frameIndex で突き合わせる。時刻だけで対応を推測してはならない。
  const audioAt = new Map<number, number>();
  for (const entry of audio) {
    const existing = audioAt.get(entry.frameIndex);
    // 同じ番号が複数回鳴った場合は最初の 1 回を採る（再生は 1 度きりであるべき）。
    if (existing === undefined || entry.atMs < existing) {
      audioAt.set(entry.frameIndex, entry.atMs);
    }
  }

  const skews: number[] = [];
  const violations: Violation[] = [];
  for (const frame of video) {
    const at = audioAt.get(frame.frameIndex);
    if (at === undefined) {
      // 対応する音声が無い。音声は破棄禁止であるため、これ自体が違反である。
      violations.push({
        judgement: "D-1",
        detail: `frameIndex ${String(frame.frameIndex)} に対応する音声が再生されていない（音声は破棄禁止）`,
      });
      continue;
    }
    skews.push(frame.atMs - at);
  }

  if (skews.length === 0) {
    return violations;
  }

  // p99 を整数の順位で求める（浮動小数点を使わない）。
  const sorted = [...skews].sort((a, b) => a - b);
  const index = Math.trunc((99 * sorted.length + 99) / 100) - 1;
  const bounded = index < 0 ? 0 : index >= sorted.length ? sorted.length - 1 : index;
  const p99 = sorted[bounded] ?? 0;

  let worstLead = 0;
  let worstLag = 0;
  for (const skew of skews) {
    if (skew > worstLead) {
      worstLead = skew;
    }
    if (-skew > worstLag) {
      worstLag = -skew;
    }
  }

  if (worstLead > audioLeadMaxMs) {
    violations.push({
      judgement: "D-1",
      detail: `音声が先行しすぎている（最大 ${String(worstLead)} ms、許容 ${String(audioLeadMaxMs)} ms）`,
    });
  }
  if (worstLag > audioLagMaxMs) {
    violations.push({
      judgement: "D-1",
      detail: `音声が遅れすぎている（最大 ${String(worstLag)} ms、許容 ${String(audioLagMaxMs)} ms）`,
    });
  }
  // p99 も報告する。最大値だけでは、単発の外れ値と定常のずれを区別できない。
  if (p99 > audioLeadMaxMs || -p99 > audioLagMaxMs) {
    violations.push({
      judgement: "D-1",
      detail: `ずれの p99 が許容の外にある（${String(p99)} ms、許容 +${String(audioLeadMaxMs)} / -${String(audioLagMaxMs)} ms）`,
    });
  }
  return violations;
}

/** すべての判定を行い、違反の一覧を返す。空であれば合格である。 */
export function judgeAll(record: DegradeRecord, options: JudgeOptions): readonly Violation[] {
  // 接続が切れていたら、そこで報告を打ち切る。以降の判定は経路の失敗の写しになる。
  const closed = judgeConnections(record);
  if (closed.length > 0) {
    return closed;
  }
  const violations: Violation[] = [
    ...judgeMonotonic(record),
    ...judgeHashes(record),
    ...judgeContinuity(record, options.maxGapMs),
    ...judgeDrops(record),
    ...judgeKeyframeRequests(record, options.allowedKeyframeRequests ?? 0),
    ...judgeAvSkew(
      record,
      options.audioLeadMaxMs ?? AV_SKEW_AUDIO_LEAD_MAX_MS,
      options.audioLagMaxMs ?? AV_SKEW_AUDIO_LAG_MAX_MS,
    ),
  ];
  if (options.requireComplete) {
    violations.push(...judgeCompleteness(record));
  }
  return violations;
}
