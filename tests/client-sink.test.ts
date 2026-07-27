/**
 * 描画の受け皿の試験。
 *
 * 規範: sdk-api.md 5 節（寸法の申告）、ADR-0015（SDK は見た目を持たない）。
 * 描画そのものはブラウザでのみ動くため、ここでは寸法の申告の規則を検証する。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createSink,
  type Clock,
  type SinkTarget,
  type SizeObserverFactory,
} from "../packages/client/src/render/sink.ts";
import { DISPLAY_SIZE_REPORT_MIN_INTERVAL_MS } from "../packages/core/src/generated/constants.ts";

/** 観測を手で起こせる偽の機構。 */
function fakeObserver(): {
  factory: SizeObserverFactory;
  fire: (width: number, height: number) => void;
  disconnected: () => number;
} {
  let handler: ((width: number, height: number) => void) | null = null;
  let disconnects = 0;
  return {
    factory: {
      observe: (_element, onResize) => {
        handler = onResize;
        return () => {
          disconnects += 1;
        };
      },
    },
    fire: (width, height) => {
      handler?.(width, height);
    },
    disconnected: () => disconnects,
  };
}

/** 手で進められる時計。コアは時刻を持たないため端で注入する。 */
function fakeClock(): { clock: Clock; advance: (ms: number) => void } {
  let now = 0;
  return {
    clock: { nowMs: () => now },
    advance: (ms) => {
      now += ms;
    },
  };
}

/** 描画先の代わり。寸法の申告の検証には描画能力を必要としない。 */
function fakeTarget(): SinkTarget {
  return { getBoundingClientRect: () => ({ width: 0, height: 0 }) };
}

test("観測した寸法が申告される", () => {
  const reports: { width: number; height: number }[] = [];
  const observer = fakeObserver();
  const { clock } = fakeClock();
  const target = fakeTarget();
  createSink(
    target,
    { onDisplaySize: (width, height) => reports.push({ width, height }) },
    observer.factory,
    clock,
  );
  observer.fire(1920, 1080);
  assert.deepEqual(reports, [{ width: 1920, height: 1080 }]);
});

test("最小間隔より短い連続した変化は申告しない（申告が溢れないため）", () => {
  const reports: { width: number; height: number }[] = [];
  const observer = fakeObserver();
  const { clock, advance } = fakeClock();
  const target = fakeTarget();
  createSink(
    target,
    { onDisplaySize: (width, height) => reports.push({ width, height }) },
    observer.factory,
    clock,
  );
  observer.fire(640, 360);
  observer.fire(800, 450);
  observer.fire(1280, 720);
  assert.equal(reports.length, 1, "最初の 1 回のみ");

  advance(DISPLAY_SIZE_REPORT_MIN_INTERVAL_MS);
  observer.fire(1920, 1080);
  assert.equal(reports.length, 2, "間隔が空けば申告する");
  assert.deepEqual(reports[1], { width: 1920, height: 1080 });
});

test("0 以下の寸法は申告しない（表示されていないため）", () => {
  const reports: { width: number; height: number }[] = [];
  const observer = fakeObserver();
  const { clock } = fakeClock();
  createSink(
    fakeTarget(),
    { onDisplaySize: (width, height) => reports.push({ width, height }) },
    observer.factory,
    clock,
  );
  observer.fire(0, 0);
  observer.fire(-1, 100);
  assert.equal(reports.length, 0);
});

test("明示的な申告もできる（生のトラックを使う場合）", () => {
  const reports: { width: number; height: number }[] = [];
  const observer = fakeObserver();
  const { clock } = fakeClock();
  const sink = createSink(
    fakeTarget(),
    { onDisplaySize: (width, height) => reports.push({ width, height }) },
    observer.factory,
    clock,
  );
  sink.setDisplaySize(3840, 2160);
  assert.deepEqual(reports, [{ width: 3840, height: 2160 }]);
  assert.equal(sink.displayWidth(), 3840);
  assert.equal(sink.displayHeight(), 2160);
});

test("detach で観測を解除する", () => {
  const observer = fakeObserver();
  const { clock } = fakeClock();
  const sink = createSink(
    fakeTarget(),
    { onDisplaySize: () => undefined },
    observer.factory,
    clock,
  );
  assert.equal(observer.disconnected(), 0);
  sink.detach();
  assert.equal(observer.disconnected(), 1);
});
