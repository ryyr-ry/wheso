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

export interface DegradeSent {
  readonly frameIndex: number;
  readonly temporalId: number;
  readonly isKey: boolean;
  readonly atMs: number;
}

export interface DegradeReceived {
  readonly frameIndex: number;
  readonly temporalId: number;
  readonly isKey: boolean;
  readonly sha256: string;
  readonly atMs: number;
}

export interface DegradeRecord {
  readonly sent: readonly DegradeSent[];
  readonly received: readonly DegradeReceived[];
  /** 最後に送った時刻。これ以降の受信間隔は「固まった」の判定に含めない。 */
  readonly lastSentAtMs: number;
  readonly keyframeRequests: number;
}

export interface Violation {
  /** 受入条件の判定番号（A-1 など）。 */
  readonly judgement: string;
  readonly detail: string;
}

/** 判定 A-3: frameIndex が同一の送信者・空間層の中で単調増加である。 */
export function judgeMonotonic(record: DegradeRecord): readonly Violation[] {
  const violations: Violation[] = [];
  let previous = 0;
  for (const entry of record.received) {
    if (entry.frameIndex <= previous) {
      violations.push({
        judgement: "A-3",
        detail: `frameIndex が逆行または重複した（${String(previous)} の次に ${String(entry.frameIndex)}）`,
      });
    }
    previous = entry.frameIndex;
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
export function judgeDrops(record: DegradeRecord): readonly Violation[] {
  const arrived = new Set(record.received.map((entry) => entry.frameIndex));
  const temporalIds = record.sent.map((entry) => entry.temporalId);
  const highestTemporal = temporalIds.length === 0 ? 0 : Math.max(...temporalIds);
  const violations: Violation[] = [];
  for (const entry of record.sent) {
    if (arrived.has(entry.frameIndex)) {
      continue;
    }
    if (entry.isKey) {
      violations.push({
        judgement: "B-2",
        detail: `キーフレーム ${String(entry.frameIndex)} が落ちた`,
      });
      continue;
    }
    if (entry.temporalId < highestTemporal) {
      violations.push({
        judgement: "B-2",
        detail: `破棄できない層のフレーム ${String(entry.frameIndex)} が落ちた（時間層 ${String(entry.temporalId)}）`,
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

/** 判定 E-1: キーフレーム要求が 0 回である。 */
export function judgeKeyframeRequests(record: DegradeRecord): readonly Violation[] {
  if (record.keyframeRequests === 0) {
    return [];
  }
  return [
    {
      judgement: "E-1",
      detail: `キーフレーム要求が ${String(record.keyframeRequests)} 回発生した`,
    },
  ];
}

export interface JudgeOptions {
  readonly maxGapMs: number;
  /** 劣化なしの段では欠落 0 を要求する（判定 B-1）。 */
  readonly requireComplete: boolean;
}

/** すべての判定を行い、違反の一覧を返す。空であれば合格である。 */
export function judgeAll(record: DegradeRecord, options: JudgeOptions): readonly Violation[] {
  const violations: Violation[] = [
    ...judgeMonotonic(record),
    ...judgeHashes(record),
    ...judgeContinuity(record, options.maxGapMs),
    ...judgeDrops(record),
    ...judgeKeyframeRequests(record),
  ];
  if (options.requireComplete) {
    violations.push(...judgeCompleteness(record));
  }
  return violations;
}
