/**
 * 描画の受け皿（sink）。
 *
 * 規範: sdk-api.md 5 節（受け皿と表示寸法の申告）、ADR-0015（ヘッドレス）。
 *
 * SDK は見た目を持たない。ここで行うのは「復号したフレームを指定された要素へ描く」ことと
 * 「その要素の大きさを観測して申告する」ことだけである。配置・装飾・操作部品は扱わない。
 *
 * 実装方式は 2 通りある（Q-014）。
 *   方式 A: 復号した VideoFrame を MediaStreamTrack へ変換し video 要素に入れる
 *   方式 B: canvas へ自前で描く
 * 方式 B を必須とし、方式 A は使える環境でのみ使う。ここでは B を実装する。
 */

import { DISPLAY_SIZE_REPORT_MIN_INTERVAL_MS } from "@wheso/core/src/generated/constants.ts";
import type { MediaFrame } from "../api/meeting.ts";

/** 受け皿が外へ伝えること。表示寸法の申告のみである。 */
export interface SinkCallbacks {
  /** 表示寸法が変わったときに呼ばれる。論理画素で渡す。 */
  readonly onDisplaySize: (width: number, height: number) => void;
}

/**
 * 描画先の最小の形。
 *
 * DOM の型に依存しない形で定義する理由は 2 つある。
 * 第 1 に、Node の試験環境には DOM が無く `instanceof` が使えない。
 * 第 2 に、利用側が canvas 以外（OffscreenCanvas など）を渡せるようにするためである。
 */
export interface SinkTarget {
  /** 寸法の観測に使う。 */
  getBoundingClientRect?: () => { readonly width: number; readonly height: number };
  /** 2D の文脈。無い場合は描画を行わない（方式 A で扱う）。 */
  getContext?: (kind: "2d") => unknown;
  width?: number;
  height?: number;
}

export interface Sink {
  /** フレームを 1 枚描く。呼び出し側が復号したものを渡す。 */
  readonly draw: (frame: MediaFrame) => void;
  /** 描画を止め、観測を解除する。 */
  readonly detach: () => void;
  /** 表示寸法を明示的に申告する。生のトラックを使う場合に必要である。 */
  readonly setDisplaySize: (width: number, height: number) => void;
  /** 直近に申告した幅。 */
  readonly displayWidth: () => number;
  /** 直近に申告した高さ。 */
  readonly displayHeight: () => number;
}

/** 寸法の観測に使う機構。試験では偽物を渡す。 */
export interface SizeObserverFactory {
  readonly observe: (target: SinkTarget, onResize: (width: number, height: number) => void) => () => void;
}

/** 既定の観測機構。ResizeObserver が無い環境では要素の属性のみを見る。 */
export function defaultSizeObserver(): SizeObserverFactory {
  return {
    observe: (target, onResize) => {
      const measure = target.getBoundingClientRect;
      if (typeof ResizeObserver === "undefined" || typeof Element === "undefined" || !(target instanceof Element)) {
        // 観測できない環境では初回のみ申告する。申告が無いと最低品質に留まる（ADR-0015）。
        if (typeof measure === "function") {
          const rect = measure.call(target);
          onResize(Math.trunc(rect.width), Math.trunc(rect.height));
        }
        return () => undefined;
      }
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const box = entry.contentRect;
          onResize(Math.trunc(box.width), Math.trunc(box.height));
        }
      });
      observer.observe(target);
      return () => observer.disconnect();
    },
  };
}

/** 時刻の取得。端に置く（コアは時刻を持たない）。試験では固定値を渡す。 */
export interface Clock {
  readonly nowMs: () => number;
}

export function systemClock(): Clock {
  return { nowMs: () => Date.now() };
}

/**
 * 受け皿を作る。
 *
 * 寸法の申告は `DISPLAY_SIZE_REPORT_MIN_INTERVAL_MS` より短い間隔では行わない。
 * 要素の大きさが連続して変わるとき（利用側の配置変更中）に申告が溢れるためである。
 */
export function createSink(
  target: SinkTarget,
  callbacks: SinkCallbacks,
  observerFactory: SizeObserverFactory = defaultSizeObserver(),
  clock: Clock = systemClock(),
): Sink {
  let width = 0;
  let heightReported = 0;
  let lastReportedAt = -DISPLAY_SIZE_REPORT_MIN_INTERVAL_MS;
  let pending: { readonly width: number; readonly height: number } | null = null;

  const report = (nextWidth: number, nextHeight: number): void => {
    if (nextWidth <= 0 || nextHeight <= 0) {
      return;
    }
    const now = clock.nowMs();
    if (now - lastReportedAt < DISPLAY_SIZE_REPORT_MIN_INTERVAL_MS) {
      // 間隔が短い間は保留する。次の申告で最新の値を送る。
      pending = { width: nextWidth, height: nextHeight };
      return;
    }
    lastReportedAt = now;
    pending = null;
    width = nextWidth;
    heightReported = nextHeight;
    callbacks.onDisplaySize(nextWidth, nextHeight);
  };

  const stopObserving = observerFactory.observe(target, (observedWidth, observedHeight) => {
    report(observedWidth, observedHeight);
  });

  const context = resolveContext(target);

  return {
    draw: (frame: MediaFrame): void => {
      // 保留していた申告があれば、描画の機会に合わせて送る。
      if (pending !== null) {
        const next = pending;
        pending = null;
        report(next.width, next.height);
      }
      if (context === null) {
        return;
      }
      context.drawImage(frame, 0, 0, context.canvas.width, context.canvas.height);
    },
    detach: (): void => {
      stopObserving();
    },
    setDisplaySize: (nextWidth: number, nextHeight: number): void => {
      report(nextWidth, nextHeight);
    },
    displayWidth: (): number => width,
    displayHeight: (): number => heightReported,
  };
}

/**
 * 描画先から 2D の文脈を得る。
 * 得られない場合（video 要素など）は null を返し、描画は方式 A に委ねる。
 */
function resolveContext(target: SinkTarget): CanvasLikeContext | null {
  if (typeof target.getContext !== "function") {
    return null;
  }
  const context = target.getContext("2d");
  if (context === null || typeof context !== "object") {
    return null;
  }
  const record: Record<string, unknown> = { ...context };
  // drawImage を持つことを実行時に確かめる。型を信用しない。
  if (typeof record["drawImage"] !== "function") {
    // スプレッドではメソッドが失われる実装もあるため、直接の参照でも確かめる。
    const direct = context;
    if (!hasDrawImage(direct)) {
      return null;
    }
    return direct;
  }
  return hasDrawImage(context) ? context : null;
}

/** 描画に使う最小の形。 */
interface CanvasLikeContext {
  drawImage: (image: MediaFrame, x: number, y: number, width: number, height: number) => void;
  canvas: { width: number; height: number };
}

function hasDrawImage(value: object): value is CanvasLikeContext {
  const candidate: { drawImage?: unknown; canvas?: unknown } = value;
  return typeof candidate.drawImage === "function" && typeof candidate.canvas === "object";
}
