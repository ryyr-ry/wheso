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
  /**
   * 復号器へ渡せた frameIndex の一覧（分かる場合）。
   *
   * **依存構造の判定はここで行う**（受入条件 A-2）。参照が欠けたまま復号器へ渡すと画が
   * 壊れる。提示の集合で判定してはならない: 復号器の出力が入れ替わったとき、順序を守る
   * ために後戻りした枠を捨てる（A-3）。捨てた枠は「復号はできたが描かなかった」だけで
   * あり、依存構造の違反ではない。
   */
  readonly decodedIndexes?: readonly number[];
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

/**
 * 判定 A-1 の前提: **照合の対象になった枠**でハッシュが得られている。
 *
 * 器は画素の読み戻しが高価であるため一部の枠だけを照合する（毎枚行うと頁の主筋が詰まり、
 * 音声が途切れる。実測 875 ms）。空文字は「照合の対象外」を表す。半端な長さは器の失敗で
 * あり、**それは見逃してはならない**。
 *
 * **1 枚も得られていなければ不合格である。** そうでないと、器が壊れて全部空になったときに
 * 判定 A-1 が空洞のまま緑になる。
 */
export function judgeHashes(record: DegradeRecord): readonly Violation[] {
  const violations: Violation[] = [];
  let hashed = 0;
  for (const entry of record.received) {
    if (entry.sha256.length === 0) {
      continue;
    }
    if (entry.sha256.length !== 64) {
      violations.push({
        judgement: "A-1",
        detail: `${String(entry.frameIndex)} 番目のハッシュが 64 文字でない（${String(entry.sha256.length)}）`,
      });
      continue;
    }
    hashed += 1;
  }
  if (record.received.length > 0 && hashed === 0) {
    violations.push({
      judgement: "A-1",
      detail: `${String(record.received.length)} 枚 描いたのにハッシュが 1 枚も得られていない（器が壊れている）`,
    });
  }
  return violations;
}

/**
 * 判定 C-1 / C-2: 連続する描画の間隔が上限を超えない。
 * 送信が終わった後の受信は評価に入れない（送信を止めれば描画も止まる）。
 *
 * **時刻の順に見る。** 記録は提示の順に並ぶが、順序が入れ替わる不具合があると、記録の
 * 並びのままでは間隔が実際より長く見える（実測: 真の最悪が 782 ms のところを 2,490 ms と
 * 読んだ。約 2.5 秒の逆行が 1 件あったためである）。順序の異常は判定 A-3 が見る。
 * C-1 は**間隔だけ**を見る。
 */
export function judgeContinuity(record: DegradeRecord, maxGapMs: number): readonly Violation[] {
  let previous: number | undefined;
  let worst = 0;
  let worstAt = 0;
  for (const entry of [...record.received].sort((a, b) => a.atMs - b.atMs)) {
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
  // **どの番号が欠けたかを出す。** 端（暖機・締め）と定常の欠落は原因が違う。
  const arrived = new Set(record.received.map((entry) => entry.frameIndex));
  const missing = record.sent
    .map((entry) => entry.frameIndex)
    .filter((index) => !arrived.has(index));
  const head = missing.slice(0, 8).join(", ");
  const first = record.sent[0]?.frameIndex ?? 0;
  const last = record.sent[record.sent.length - 1]?.frameIndex ?? 0;
  return [
    {
      judgement: "B-1",
      detail:
        `欠落がある（送 ${String(record.sent.length)} / 受 ${String(record.received.length)}）` +
        `。判定の範囲は ${String(first)}〜${String(last)}、欠けた番号 ${String(missing.length)} 件` +
        `（最初の 8 件: ${head}）`,
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
  /**
   * 「対の音声が鳴っていない」を違反として数えるか。既定は数える（音声は破棄禁止）。
   *
   * **段 E では数えない。** 段 E は自分でリンクを切る試験であり、切れている間に経路にあった
   * 音声は失われる。これは輻輳による破棄ではなく試験が起こした断である。規範の判定 D-1 は
   * 「差の p99」を問うものであり、欠落は別の主張である（混ぜると断のたびに数十件の違反が
   * 出て、同期の欠陥が見えなくなる。実測 126 件）。段 E は欠落の数を**印字して**残す。
   */
  countMissingAudio = true,
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
  /** どのフレームで最も大きくずれたかを残す（暖機の端か定常かを見分けるため）。 */
  let worstLeadFrame = -1;
  let worstLeadValue = 0;
  let worstLagFrame = -1;
  let worstLagValue = 0;
  const violations: Violation[] = [];
  for (const frame of video) {
    const at = audioAt.get(frame.frameIndex);
    if (at === undefined) {
      // 対応する音声が無い。音声は破棄禁止であるため、通常はこれ自体が違反である。
      if (countMissingAudio) {
        violations.push({
          judgement: "D-1",
          detail: `frameIndex ${String(frame.frameIndex)} に対応する音声が再生されていない（音声は破棄禁止）`,
        });
      }
      continue;
    }
    const skew = frame.atMs - at;
    if (skew > worstLeadValue) {
      worstLeadValue = skew;
      worstLeadFrame = frame.frameIndex;
    }
    if (-skew > worstLagValue) {
      worstLagValue = -skew;
      worstLagFrame = frame.frameIndex;
    }
    skews.push(skew);
  }

  if (skews.length === 0) {
    return violations;
  }

  // **判定は p99 で行う**（受入条件 4.4: 「差の p99 が許容以内」）。
  //
  // 最大値で判定してはならない。許容の根拠は ITU-R BT.1359-0 の**知覚**の閾値であり
  // （F-043、ADR-0028）、規範は受入の判定を p99 と定めている。1 度の予定の乱れで走行全体を
  // 不合格にすると、実装の欠陥と実行環境の揺れを区別できない（器の判定規則。F-075）。
  // 許容は非対称であるため、上側（音声が先行）と下側（音声が遅れ）を別に見る。
  const sorted = [...skews].sort((left, right) => left - right);
  const rankOf = (percent: number): number => {
    // 整数の順位で求める（浮動小数点を使わない。ADR-0017）。
    const index = Math.trunc((percent * sorted.length + 99) / 100) - 1;
    return index < 0 ? 0 : index >= sorted.length ? sorted.length - 1 : index;
  };
  const upper = sorted[rankOf(99)] ?? 0;
  const lower = sorted[rankOf(1)] ?? 0;
  const worst = sorted[sorted.length - 1] ?? 0;
  const best = sorted[0] ?? 0;

  if (upper > audioLeadMaxMs) {
    violations.push({
      judgement: "D-1",
      detail:
        `音声が先行しすぎている（p99 ${String(upper)} ms、許容 ${String(audioLeadMaxMs)} ms、` +
        `最大 ${String(worst)} ms は frameIndex ${String(worstLeadFrame)}、組 ${String(sorted.length)}）`,
    });
  }
  if (-lower > audioLagMaxMs) {
    violations.push({
      judgement: "D-1",
      detail:
        `音声が遅れすぎている（p99 ${String(-lower)} ms、許容 ${String(audioLagMaxMs)} ms、` +
        `最大 ${String(-best)} ms は frameIndex ${String(worstLagFrame)}、組 ${String(sorted.length)}）`,
    });
  }
  return violations;
}

/**
 * 判定 A-2: 提示したフレームの集合が**依存構造の上で有効である**（受入条件 4.1）。
 *
 * 時間スケーラビリティでは、時間層 T のフレームは「同じキーフレーム以降で、より低い層の
 * 直近のフレーム」を参照する（`wire-format.md` 1.3）。したがって次が成り立たなければ、
 * 復号器は参照の無いフレームを描いたことになる。
 *
 *   キーフレーム以降に、より低い層のフレームが 1 枚も提示されていない層のフレームを
 *   提示してはならない。
 *
 * **なぜ判定 B-2 と別に要るか。** B-2 は「落ちたものが破棄可能だったか」を見る。A-2 は
 * 「描いたものが有効だったか」を見る。落ちてよいものだけが落ちていても、受け側が参照の
 * 欠けたフレームを描いていれば画は壊れる（ADR-0049 で受け側の守りを入れた理由でもある）。
 *
 * 判定には送信側の記録（層とキーフレームの旗）を使う。提示の記録は `frameIndex` で引く。
 */
export function judgeDependencies(record: DegradeRecord): readonly Violation[] {
  // 復号器へ渡せた集合が分かるならそれを見る（分からない器では提示の集合で代用する）。
  const presentedIndexes = new Set(
    record.decodedIndexes ?? record.received.map((entry) => entry.frameIndex),
  );
  const violations: Violation[] = [];
  /**
   * 層ごとの「直近に送られたフレーム」の位置と、それが提示されたか。
   * 参照するのは**より低い層の直近のフレーム**であるため、層ごとに最後の 1 枚を覚える。
   */
  const lastByLayer = new Map<number, { readonly frameIndex: number; readonly presented: boolean }>();
  // **`sent` にキーフレームが無いときは `sawKey = true` で始める。**
  //
  // `trimWarmup` が音声の再生開始時刻で映像を切ったとき、最初のキーフレームが
  // 切られて delta フレームだけが残ることがある（実測: headed Chrome で frameIndex
  // 25〜44 が A-2）。このとき `sent` にキーフレームが存在しない。キーフレームは
  // warmup より前に届いて復号に渡されているため、残った delta フレームの参照は
  // 有効である。`sawKey = false` で始めると「参照が無い」A-2 違反を量産する。
  const hasKeyInSent = record.sent.some((entry) => entry.isKey);
  let sawKey = !hasKeyInSent;
  // 送出の順（frameIndex の昇順）で見る。提示の順序の異常は A-3 が見る。
  for (const meta of [...record.sent].sort((a, b) => a.frameIndex - b.frameIndex)) {
    const presented = presentedIndexes.has(meta.frameIndex);
    if (meta.isKey) {
      // キーフレームは参照を持たない。ここから数え直す。
      lastByLayer.clear();
      sawKey = sawKey || presented;
      if (presented) {
        lastByLayer.set(meta.temporalId, { frameIndex: meta.frameIndex, presented: true });
      }
      continue;
    }
    if (!presented) {
      lastByLayer.set(meta.temporalId, { frameIndex: meta.frameIndex, presented: false });
      continue;
    }
    if (!sawKey) {
      violations.push({
        judgement: "A-2",
        detail: `キーフレームを提示していないのに ${String(meta.frameIndex)} を提示した（参照が無い）`,
      });
      lastByLayer.set(meta.temporalId, { frameIndex: meta.frameIndex, presented: true });
      continue;
    }
    if (meta.temporalId > 0) {
      // **より低い層の直近のフレーム**を探す（それが参照先である）。
      let nearest: { readonly frameIndex: number; readonly presented: boolean } | undefined;
      for (let layer = 0; layer < meta.temporalId; layer += 1) {
        const candidate = lastByLayer.get(layer);
        if (candidate === undefined) {
          continue;
        }
        if (nearest === undefined || candidate.frameIndex > nearest.frameIndex) {
          nearest = candidate;
        }
      }
      if (nearest !== undefined && !nearest.presented) {
        violations.push({
          judgement: "A-2",
          detail:
            `${String(meta.frameIndex)}（時間層 ${String(meta.temporalId)}）を提示したが、` +
            `参照先の ${String(nearest.frameIndex)} を提示していない`,
        });
      }
    }
    lastByLayer.set(meta.temporalId, { frameIndex: meta.frameIndex, presented: true });
  }
  return violations;
}

/**
 * 判定 A-1 の完全形: **同じ段を受けた購読者は同じ画素を得る**（受入条件 4.1）。
 *
 * ハッシュを 1 人ぶんだけ見ても「同一に再生された」ことは言えない。転符号化しない設計
 * （ADR-0001）であるから、同じ段の同じフレームは全員に同じバイト列で届き、同じ画素になる。
 * **食い違えば転送か復号のどこかが壊れている。**
 *
 * 走行をまたいで比べることはできない（カメラの内容が毎回違う）。同じ走行の購読者どうしで
 * 比べる。N-8（参加者ごとに別々の劣化）では 2 人の購読者が居るため、この判定が働く。
 */
export function judgeIdenticalPixels(
  records: readonly { readonly label: string; readonly record: DegradeRecord }[],
): readonly Violation[] {
  if (records.length < 2) {
    return [];
  }
  const first = records[0];
  if (first === undefined) {
    return [];
  }
  const violations: Violation[] = [];
  const base = new Map<number, string>();
  for (const entry of first.record.received) {
    if (entry.sha256.length === 64) {
      base.set(entry.frameIndex, entry.sha256);
    }
  }
  for (const other of records.slice(1)) {
    for (const entry of other.record.received) {
      const expected = base.get(entry.frameIndex);
      if (expected === undefined || entry.sha256.length !== 64) {
        // 片方にしか届いていないフレームは比べられない（劣化が違えば当然である）。
        continue;
      }
      if (entry.sha256 !== expected) {
        violations.push({
          judgement: "A-1",
          detail:
            `${String(entry.frameIndex)} の画素が購読者ごとに違う` +
            `（${first.label} と ${other.label}）`,
        });
      }
    }
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
    ...judgeDependencies(record),
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
