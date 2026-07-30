/**
 * 送信のはしごを送信源から導出する。
 *
 * 規範: ADR-0026（`spatialId` は送信者ごとの段番号。はしごは源から導出する）、
 *       ADR-0027（会議全体へ配る）、`sdk-api.md` 2 節、`constants.md` 2 節。
 *
 * **なぜ源から導出するか。** `spatialId` を大域のプロファイル表に固定で結び付けると、
 * 表に無い源を表現できない。720p30 のカメラ、1600×1200 の画面共有、4:3 の前面カメラは
 * いずれも該当が無い。無理に当てはめると実体と異なる解像度とビットレートを申告することになり、
 * 受信ノードの費用計算が壊れる。
 *
 * **絶対に拡大しない。** 源より大きい解像度、源より高い fps を作らない。
 *
 * sans-IO の純関数である。時刻・乱数・浮動小数点・入出力に触れない。
 * 同じ入力に対して 6 言語が同じはしごを返さなければならない（conformance.md 7 節）。
 */

import {
  V_1080P30,
  V_1080P60,
  V_360P15,
  V_4K60,
  V_SCREEN_1080P30,
  V_SCREEN_4K30,
} from "./generated/constants.ts";

/** 内容の種別。破棄規則と縮小の可否が変わる。 */
export type ContentKind = "camera" | "screen";

/** 送信源の実測値。`MediaStreamTrack` の設定から取る。 */
export interface SourceSpec {
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
}

/** 符号化の能力。探査の結果を入力として受け取る（判定は純関数に閉じる）。 */
export interface EncodeCapability {
  /** ハードウェアの AV1 符号化器で 4K60 が実時間に達するか。 */
  readonly hardwareAv1For4K60: boolean;
  /** AV1 の符号化が可能か。 */
  readonly encodeAv1: boolean;
  readonly mobile: boolean;
  readonly charging: boolean;
  /**
   * 発熱や CPU 不足で落とす段数。0 は制限なし。
   * 上段から順に落とす（`client-architecture.md` 10 節）。
   */
  readonly thermalDrop: number;
}

/** はしごの 1 段。`streamAnnounce`（wire-format.md 2.3）の全欄を持つ。 */
export interface SendRung {
  /** 段番号。0 が最下段であり密に詰める（ADR-0026）。 */
  readonly sid: number;
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
  readonly temporalLayers: number;
  readonly targetBitrate: number;
  readonly codec: string;
  readonly scalabilityMode: string;
}

/**
 * 候補となる代表点。
 *
 * **測定が済むまで代表点しか作らない**（Q-021）。任意の解像度に対するビットレートの係数が
 * 未測定であり、推測した値を書いてはならない。したがって源に収まる代表点だけを段にする。
 * 係数が測定されたら、源から比率で作る形へ拡張する。
 */
interface Candidate {
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
  readonly temporalLayers: number;
  readonly targetBitrate: number;
  readonly scalabilityMode: string;
  /** ハードウェアの AV1 符号化器を要するか。 */
  readonly requiresHardware: boolean;
}

const AV1_CODEC = "av01.0.08M.08";
const H264_CODEC = "avc1.42E01F";
const SINGLE_LAYER_MODE = "L1T1";

/** カメラの候補。幅の昇順、同幅なら fps の昇順で並べる。 */
const CAMERA_CANDIDATES: readonly Candidate[] = [
  {
    width: V_360P15.width,
    height: V_360P15.height,
    framerate: V_360P15.framerate,
    temporalLayers: V_360P15.temporalLayers,
    targetBitrate: V_360P15.targetBitrate,
    scalabilityMode: V_360P15.scalabilityMode,
    requiresHardware: false,
  },
  {
    width: V_1080P30.width,
    height: V_1080P30.height,
    framerate: V_1080P30.framerate,
    temporalLayers: V_1080P30.temporalLayers,
    targetBitrate: V_1080P30.targetBitrate,
    scalabilityMode: V_1080P30.scalabilityMode,
    requiresHardware: false,
  },
  {
    width: V_1080P60.width,
    height: V_1080P60.height,
    framerate: V_1080P60.framerate,
    temporalLayers: V_1080P60.temporalLayers,
    targetBitrate: V_1080P60.targetBitrate,
    scalabilityMode: V_1080P60.scalabilityMode,
    requiresHardware: false,
  },
  {
    width: V_4K60.width,
    height: V_4K60.height,
    framerate: V_4K60.framerate,
    temporalLayers: V_4K60.temporalLayers,
    targetBitrate: V_4K60.targetBitrate,
    scalabilityMode: V_4K60.scalabilityMode,
    requiresHardware: true,
  },
];

/**
 * 画面共有の候補。
 *
 * **1/4 の段（640×360 相当）を作らない。** 文字が読めなくなる。可読性が最優先である
 * （ADR-0026 の 5）。したがって候補は 1080p と 4K の 2 個だけである。
 */
const SCREEN_CANDIDATES: readonly Candidate[] = [
  {
    width: V_SCREEN_1080P30.width,
    height: V_SCREEN_1080P30.height,
    framerate: V_SCREEN_1080P30.framerate,
    temporalLayers: V_SCREEN_1080P30.temporalLayers,
    targetBitrate: V_SCREEN_1080P30.targetBitrate,
    scalabilityMode: V_SCREEN_1080P30.scalabilityMode,
    requiresHardware: false,
  },
  {
    width: V_SCREEN_4K30.width,
    height: V_SCREEN_4K30.height,
    framerate: V_SCREEN_4K30.framerate,
    temporalLayers: V_SCREEN_4K30.temporalLayers,
    targetBitrate: V_SCREEN_4K30.targetBitrate,
    scalabilityMode: V_SCREEN_4K30.scalabilityMode,
    requiresHardware: false,
  },
];

/** 段数の上限。カメラは 3、画面共有は 2（ADR-0026、DECISIONS.md の決定）。 */
export const MAX_CAMERA_RUNGS = 3;
export const MAX_SCREEN_RUNGS = 2;

/**
 * はしごを導出する。
 *
 * 手順:
 *   1. 源に収まる候補だけを残す（拡大しない）
 *   2. 能力で上限を切る（ハードウェア符号化器の要否、携帯の非充電時、発熱降格）
 *   3. 上限の段数まで、上から順に間隔を空けて選ぶ
 *   4. 段番号を 0 から密に振る
 *
 * 候補が 1 つも残らない場合は、源をそのまま 1 段として返す。返さないと映像を送れない。
 */
export function deriveLadder(
  source: SourceSpec,
  kind: ContentKind,
  capability: EncodeCapability,
): readonly SendRung[] {
  const candidates = kind === "screen" ? SCREEN_CANDIDATES : CAMERA_CANDIDATES;
  const maxRungs = kind === "screen" ? MAX_SCREEN_RUNGS : MAX_CAMERA_RUNGS;
  const codec = capability.encodeAv1 ? AV1_CODEC : H264_CODEC;

  const fitting: Candidate[] = [];
  for (const candidate of candidates) {
    // 拡大しない。源より大きい解像度・高い fps は作らない。
    if (candidate.width > source.width || candidate.height > source.height) {
      continue;
    }
    if (candidate.framerate > source.framerate) {
      continue;
    }
    // ハードウェア符号化器を要する段は、能力が無ければ作れない。
    if (candidate.requiresHardware && !capability.hardwareAv1For4K60) {
      continue;
    }
    // 携帯で充電していないときは 60 fps を作らない（電池と発熱のため。sdk-api.md 2 節）。
    if (capability.mobile && !capability.charging && candidate.framerate > V_1080P30.framerate) {
      continue;
    }
    fitting.push(candidate);
  }

  if (fitting.length === 0) {
    // 代表点がひとつも収まらない小さな源（例: 320×240）。源をそのまま 1 段にする。
    // ビットレートは最下段の代表点の値を用いる（Q-021 の測定が済むまでの扱い）。
    return [
      {
        sid: 0,
        width: source.width,
        height: source.height,
        framerate: source.framerate,
        temporalLayers: capability.encodeAv1 ? V_360P15.temporalLayers : 1,
        targetBitrate: V_360P15.targetBitrate,
        codec,
        scalabilityMode: capability.encodeAv1 ? V_360P15.scalabilityMode : SINGLE_LAYER_MODE,
      },
    ];
  }

  // 発熱降格は上段から落とす。1 段は必ず残す（映像が完全に止まらないようにする）。
  const dropped = capability.thermalDrop < 0 ? 0 : capability.thermalDrop;
  const keepCount = fitting.length - dropped < 1 ? 1 : fitting.length - dropped;
  const usable = fitting.slice(0, keepCount);

  const selected = pickSpread(usable, maxRungs);

  const rungs: SendRung[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index];
    if (candidate === undefined) {
      continue;
    }
    rungs.push({
      sid: index,
      width: candidate.width,
      height: candidate.height,
      framerate: declaredFramerate(source.framerate, candidate.framerate),
      // H.264 は時間スケーラビリティを使えない（F-027）。
      temporalLayers: capability.encodeAv1 ? candidate.temporalLayers : 1,
      targetBitrate: candidate.targetBitrate,
      codec,
      scalabilityMode: capability.encodeAv1 ? candidate.scalabilityMode : SINGLE_LAYER_MODE,
    });
  }
  return rungs;
}

/**
 * 昇順に並んだ候補から、最大 `limit` 個を「間隔を空けて」選ぶ。
 *
 * 必ず最上段と最下段を含める。狭帯域のための最下段と、能力を出し切る最上段の両方が要る。
 * 中間は等間隔に取る。`limit` 以下なら全部返す。
 *
 * 添字の計算は整数のみで行う（ADR-0017）。
 */
function pickSpread(candidates: readonly Candidate[], limit: number): readonly Candidate[] {
  if (limit <= 0) {
    return [];
  }
  if (candidates.length <= limit) {
    return candidates;
  }
  if (limit === 1) {
    const top = candidates[candidates.length - 1];
    return top === undefined ? [] : [top];
  }
  const out: Candidate[] = [];
  const last = candidates.length - 1;
  for (let k = 0; k < limit; k += 1) {
    // 添字 = round(k × last / (limit − 1)) を整数演算で表す。
    // round(a/b) = (2a + b) / (2b) の切り捨て（a, b は非負）。
    const numerator = 2 * k * last + (limit - 1);
    const index = Math.trunc(numerator / (2 * (limit - 1)));
    const candidate = candidates[index];
    if (candidate === undefined) {
      continue;
    }
    // 同じ段を二重に入れない。
    const duplicate = out.some(
      (entry) => entry.width === candidate.width && entry.framerate === candidate.framerate,
    );
    if (!duplicate) {
      out.push(candidate);
    }
  }
  return out;
}

/**
 * `streamAnnounce` の本文を作る（wire-format.md 2.3、ADR-0026 の 7）。
 *
 * **全欄を送る。** `width` / `height` / `targetBitrate` を落としてはならない。
 * 受信ノードはこの値で費用を見積もり、表示寸法から段を選ぶ（ADR-0027 の 2）。
 * 落とすと大域の定数を使うことになり、送信者の実体と合わなくなる。
 */
export function buildLadderAnnounce(channel: number, rungs: readonly SendRung[]): string {
  return JSON.stringify({
    t: "streamAnnounce",
    streams: rungs.map((rung) => ({
      channel,
      spatialId: rung.sid,
      codec: rung.codec,
      scalabilityMode: rung.scalabilityMode,
      spatialLayers: 1,
      temporalLayers: rung.temporalLayers,
      width: rung.width,
      height: rung.height,
      framerate: rung.framerate,
      targetBitrate: rung.targetBitrate,
    })),
  });
}

/**
 * 申告する fps。**送信側が実際に出せる値だけを申告する。**
 *
 * 送出は取得したフレームを間引いて作る。間引きは整数でしかできないため、実際に出る fps は
 * `源 ÷ k`（k は 1 以上の整数）である。代表点の fps をそのまま申告すると、源が代表点の
 * 整数倍でない装置では**間隔が不均等**になる（源 20 fps から 15 fps を作ると
 * 50 / 50 / 100 ms の繰り返しになる。F-073）。
 *
 * ```
 * k    = max(1, floor(源 ÷ 代表点))   間引きの間隔
 * 申告 = floor(源 ÷ k)                実際に出せる fps（切り捨てる）
 * ```
 *
 * 源 30・代表点 15 なら k=2 で申告 15。源 20・代表点 15 なら **k=1 で申告 20**
 * （間引かない）。源 25・代表点 15 なら k=1 で申告 25。
 *
 * **なぜ切り上げず切り捨てるか**（ADR-0052。ADR-0051 を置き換える）。切り上げると
 * k が大きくなり、申告 fps が代表点より**下がる**（源 20 → 申告 10）。すると
 * 中継ノードの送信窓（`SEND_WINDOW_MS` × 申告 fps）が 2 枚に縮む一方、ack の間隔は
 * 媒体の間隔（100 ms）で決まるため、窓の更新が 2 回しか入らず 1 度の遅れで閉じる
 * （規範 `congestion.md` 2 節は 4 回の更新を前提に 200 ms を定めている。F-078・F-079）。
 * 切り捨てれば k=1 となり、間引きが無くなって間隔は完全に均等になり、窓は 4 枚、
 * ack は 50 ms 間隔になる。**規範の前提が成り立つ。**
 *
 * ビットレートは段の `targetBitrate` のまま符号化器へ渡す。fps を上げても**ワイヤの
 * ビットレートは申告どおりに保たれる**（F-077 で実測。誤差 ±10 %）。1 枚あたりの
 * 情報量が減るだけである。
 */
export function declaredFramerate(sourceFramerate: number, candidateFramerate: number): number {
  if (sourceFramerate <= 0 || candidateFramerate <= 0) {
    return candidateFramerate;
  }
  if (sourceFramerate <= candidateFramerate) {
    // 源が代表点以下なら間引かない。源をそのまま申告する（拡大しない。ADR-0026）。
    return sourceFramerate;
  }
  // k = floor(源 ÷ 代表点)（1 以上）。**切り上げてはならない**（ADR-0052 の理由）。
  const k = Math.trunc(sourceFramerate / candidateFramerate);
  const step = k < 1 ? 1 : k;
  // 申告 = floor(源 ÷ k)。切り捨てる（実際に出る値を上回って申告しない）。
  return Math.trunc(sourceFramerate / step);
}
