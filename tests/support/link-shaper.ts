/**
 * 利用側の回線を**利用者権限で**劣化させる整形器（`tc` の代わり）。
 *
 * **なぜ必要か。** 段 D は `tc netem` で回線を劣化させる前提だが、`tc` は root を要する。
 * root の無い環境では 8 プロファイルすべてが飛ばされ、**判定 D-1・B-2・C-1・C-3 に実入力が
 * 一度も与えられない**。器のブラウザは既に局所の終端（`startTlsBridge`）を通って実環境へ
 * 繋がるため、そこで整形すれば root は要らない。
 *
 * **何を忠実に再現できるか。**
 *
 * | 劣化 | 再現 | 理由 |
 * |---|---|---|
 * | 帯域制限（`rateKbit`） | できる | トークンバケツ。**接続をまたいで共有する**（`tc` は装置単位であるため） |
 * | 遅延（`delayMs`） | できる | 解放時刻を後ろへずらす |
 * | ジッタ（`jitterMs`） | できる | ずらす量を振る。**順序は保つ**（下記） |
 * | 完全遮断（`outage`） | できる | 解放を止める。溜まった分は復帰時に流れる |
 * | 方向（`egressOnly`） | できる | 上りだけに適用する |
 * | 再順序・重複 | **できない** | ここは TCP のバイト列である。並べ替えれば TLS が壊れる。`tc` は IP パケットに対して行い、TCP が復元するため、利用側から見える影響は遅延だけである（プロファイルの注記も「TCP のため欠落はしない」と述べている） |
 *
 * **順序を壊してはならない。** ジッタを chunk ごとに独立に振ると解放順が入れ替わり、
 * TLS の復号が失敗して接続が落ちる。解放時刻は「直前の解放時刻」を下限にする。これは
 * 実際の回線でも同じである（TCP は順序を復元して引き渡す）。
 *
 * **背圧をかける。** 溜まった量が上限を超えたら読み元を止める。止めないと、帯域を絞っても
 * 送り手は詰まりを感じず、待ち行列が際限なく伸びるだけになる（測定が無意味になる）。
 */

import type { Socket } from "node:net";

/** 整形の状態。`rateKbit` が 0 なら帯域制限なし。 */
export interface ShapeState {
  readonly rateKbit: number;
  readonly delayMs: number;
  readonly jitterMs: number;
  /** 真の間は 1 バイトも解放しない（完全遮断）。 */
  readonly blackout: boolean;
}

export const NO_SHAPE: ShapeState = { rateKbit: 0, delayMs: 0, jitterMs: 0, blackout: false };

/** 整形器の観測。試験が「本当に効いたか」を確かめるために使う。 */
export interface ShapeStats {
  /** 解放したバイト数。 */
  readonly releasedBytes: number;
  /** 今溜まっているバイト数。 */
  readonly queuedBytes: number;
  /** 背圧をかけた回数。 */
  readonly pauses: number;
  /** 帯域制限で解放を待たせた回数。 */
  readonly throttles: number;
}

/** 1 方向ぶんの整形器。**複数の接続で共有する**（装置単位の制限を再現するため）。 */
export interface Shaper {
  readonly attach: (sink: (chunk: Buffer) => void, source: Socket | null) => ShaperPort;
  readonly set: (state: ShapeState) => void;
  readonly stats: () => ShapeStats;
  readonly stop: () => void;
}

/** 1 接続ぶんの投入口。 */
export interface ShaperPort {
  readonly push: (chunk: Buffer) => void;
  readonly detach: () => void;
}

/** 溜めてよい上限（バイト）。超えたら読み元を止める。 */
const HIGH_WATER_BYTES = 256 * 1024;

/** 背圧を解く水位（バイト）。 */
const LOW_WATER_BYTES = 64 * 1024;

/** バケツに溜めておける最大（ミリ秒ぶん）。突発の許容量である。 */
const BURST_MS = 50;

/**
 * 1 度に解放する上限（バイト）。これより大きい塊は割る。
 *
 * 大きい書き込み（64 KB など）をそのまま出すと、借りが大きくなりすぎて制限を突き抜ける。
 * 実際の回線もパケットに割って送る。4 KB は TCP の 1 セグメント（約 1.4 KB）の数個ぶんで
 * あり、予約の回数と精度の折り合いである。
 */
const MAX_RELEASE_BYTES = 4096;

interface Pending {
  readonly chunk: Buffer;
  readonly readyAtMs: number;
}

interface Lane {
  readonly sink: (chunk: Buffer) => void;
  readonly source: Socket | null;
  queue: Pending[];
  queuedBytes: number;
  lastReadyAtMs: number;
  paused: boolean;
  detached: boolean;
}

/**
 * 再現できる擬似乱数（線形合同法）。
 *
 * ジッタに `Math.random` を使うと走行ごとに結果が変わり、**測定の食い違いが劣化のせいか
 * 実装のせいか分からなくなる**。種を固定して再現できるようにする。
 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    // 定数は Numerical Recipes の LCG。整数演算のみで回す。
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

export function createShaper(now: () => number, seed = 1): Shaper {
  const lanes = new Set<Lane>();
  let state: ShapeState = NO_SHAPE;
  let credit = 0;
  let lastRefillMs = now();
  let releasedBytes = 0;
  let pauses = 0;
  let throttles = 0;
  const random = createRandom(seed);

  /** 1 ミリ秒あたりに解放してよいバイト数。0 は無制限を表す。 */
  const bytesPerMs = (): number => (state.rateKbit <= 0 ? 0 : (state.rateKbit * 1000) / 8 / 1000);

  function refill(atMs: number): void {
    const perMs = bytesPerMs();
    if (perMs <= 0) {
      credit = 0;
      lastRefillMs = atMs;
      return;
    }
    const elapsed = atMs - lastRefillMs;
    if (elapsed <= 0) {
      return;
    }
    lastRefillMs = atMs;
    const cap = perMs * BURST_MS;
    const filled = credit + elapsed * perMs;
    credit = filled > cap ? cap : filled;
  }

  function applyBackpressure(lane: Lane): void {
    if (lane.source === null) {
      return;
    }
    if (!lane.paused && lane.queuedBytes > HIGH_WATER_BYTES) {
      lane.paused = true;
      pauses += 1;
      lane.source.pause();
      return;
    }
    if (lane.paused && lane.queuedBytes <= LOW_WATER_BYTES) {
      lane.paused = false;
      lane.source.resume();
    }
  }

  function releaseFrom(lane: Lane, atMs: number, unlimited: boolean): boolean {
    const head = lane.queue[0];
    if (head === undefined || head.readyAtMs > atMs) {
      return false;
    }
    if (unlimited) {
      lane.queue.shift();
      lane.queuedBytes -= head.chunk.length;
      releasedBytes += head.chunk.length;
      lane.sink(head.chunk);
      return true;
    }
    if (credit < 1) {
      throttles += 1;
      return false;
    }
    // **借りを作る。上限より大きい塊は割る。**
    //
    // 足りない分だけ割って出すと、残りのために毎回 1 ミリ秒の予約を挟むことになる。
    // 実行系が忙しいと `setTimeout(…, 1)` は 10〜50 ms 遅れるため、**制限に達していないのに
    // 通信が固まる**（実測: 8 Mbps の制限で待たせた回数 43 に対し、破棄不可のフレームが
    // 44 枚落ちた）。credit を負にすれば平均の速度は同じで、待ちは「借りを返す時間」に
    // まとまる。`tc` の tbf も塊単位で送る。
    if (head.chunk.length > MAX_RELEASE_BYTES) {
      const part = head.chunk.subarray(0, MAX_RELEASE_BYTES);
      const rest = head.chunk.subarray(MAX_RELEASE_BYTES);
      lane.queue[0] = { chunk: rest, readyAtMs: head.readyAtMs };
      lane.queuedBytes -= part.length;
      credit -= part.length;
      releasedBytes += part.length;
      lane.sink(part);
      return true;
    }
    lane.queue.shift();
    lane.queuedBytes -= head.chunk.length;
    credit -= head.chunk.length;
    releasedBytes += head.chunk.length;
    lane.sink(head.chunk);
    return true;
  }

  /** 予約中の解放（`setTimeout` の取り消し用）。 */
  let pending: ReturnType<typeof setTimeout> | null = null;

  /**
   * 出せるものを出す。**刻みで回さない。**
   *
   * 一定周期の刻みで解放すると、(1) その間に届いた分がまとめて出て突発になり、(2) 実行
   * 系が忙しいと刻み自体が遅れる（ブラウザ 2 個と CDP の通信で埋まる）。実測: 5 ms の
   * 刻みで回していたとき、帯域 8 Mbps（実際の通信量は約 350 kbps）でも提示が 375/594 に
   * 落ちた。**制限に達していないのに器が壊していた。** 出来事駆動にすれば、制限に達しない
   * 限り遅れは入らない。
   */
  function drain(): void {
    const atMs = now();
    refill(atMs);
    if (state.blackout) {
      for (const lane of lanes) {
        applyBackpressure(lane);
      }
      schedule(atMs);
      return;
    }
    const unlimited = bytesPerMs() <= 0;
    let progressed = true;
    while (progressed) {
      progressed = false;
      // **接続をまたいで公平に回す。** 1 本に全部与えると装置単位の制限にならない。
      for (const lane of lanes) {
        if (releaseFrom(lane, atMs, unlimited)) {
          progressed = true;
        }
        applyBackpressure(lane);
      }
      if (!unlimited && credit < 1) {
        break;
      }
    }
    schedule(atMs);
  }

  /** 次に解放できる時刻へ予約する。待つものが無ければ何も予約しない。 */
  function schedule(atMs: number): void {
    if (pending !== null) {
      clearTimeout(pending);
      pending = null;
    }
    let earliest = Number.POSITIVE_INFINITY;
    let waiting = 0;
    for (const lane of lanes) {
      const head = lane.queue[0];
      if (head === undefined) {
        continue;
      }
      waiting += 1;
      if (head.readyAtMs < earliest) {
        earliest = head.readyAtMs;
      }
    }
    if (waiting === 0) {
      return;
    }
    const perMs = bytesPerMs();
    // 帯域待ちなら、1 バイトぶんの credit が溜まる時刻まで待つ。
    // 借り（負の credit）を返し切るまで待つ。1 バイトぶんではなく借り全部である。
    const creditWaitMs = perMs <= 0 || credit >= 1 ? 0 : Math.ceil((1 - credit) / perMs);
    const readyWaitMs = earliest === Number.POSITIVE_INFINITY ? 0 : earliest - atMs;
    const waitMs = Math.max(1, readyWaitMs > creditWaitMs ? readyWaitMs : creditWaitMs);
    pending = setTimeout(drain, waitMs);
    if (typeof pending === "object" && pending !== null && "unref" in pending) {
      pending.unref();
    }
  }

  return {
    attach: (sink, source): ShaperPort => {
      const lane: Lane = {
        sink,
        source,
        queue: [],
        queuedBytes: 0,
        lastReadyAtMs: 0,
        paused: false,
        detached: false,
      };
      lanes.add(lane);
      return {
        push: (chunk): void => {
          if (lane.detached || chunk.length === 0) {
            return;
          }
          // **劣化が無いときは待ち行列を通さない。**
          //
          // 刻み（`TICK_MS`）で解放すると、その間に届いた分がまとめて出る。**器が作った
          // 突発**であり、送信窓（`SEND_WINDOW_MS`）を閉じて破棄を生む。実測: N-0（劣化
          // なし）で破棄不可のフレームが 47 回落ちた。素通しにすれば器は何も足さない。
          if (
            state.rateKbit <= 0 &&
            state.delayMs <= 0 &&
            state.jitterMs <= 0 &&
            !state.blackout &&
            lane.queue.length === 0
          ) {
            releasedBytes += chunk.length;
            lane.sink(chunk);
            return;
          }
          const atMs = now();
          const jitter = state.jitterMs <= 0 ? 0 : Math.trunc(random() * (state.jitterMs + 1));
          const wanted = atMs + state.delayMs + jitter;
          // **順序を保つ。** 直前の解放時刻より前へは置かない。
          const readyAtMs = wanted < lane.lastReadyAtMs ? lane.lastReadyAtMs : wanted;
          lane.lastReadyAtMs = readyAtMs;
          lane.queue.push({ chunk, readyAtMs });
          lane.queuedBytes += chunk.length;
          applyBackpressure(lane);
          // **積んだらその場で流す。** 刻みを待たない（待つと突発になる）。
          drain();
        },
        detach: (): void => {
          lane.detached = true;
          lanes.delete(lane);
        },
      };
    },
    set: (next): void => {
      // 帯域が変わったらバケツを作り直す（前の残りを持ち越さない）。
      if (next.rateKbit !== state.rateKbit) {
        credit = 0;
        lastRefillMs = now();
      }
      state = next;
      // 遮断が明けた・帯域が広がった場合に溜まりを流す。
      drain();
    },
    stats: (): ShapeStats => {
      let queued = 0;
      for (const lane of lanes) {
        queued += lane.queuedBytes;
      }
      return { releasedBytes, queuedBytes: queued, pauses, throttles };
    },
    stop: (): void => {
      if (pending !== null) {
        clearTimeout(pending);
        pending = null;
      }
      for (const lane of lanes) {
        lane.detached = true;
      }
      lanes.clear();
    },
  };
}
