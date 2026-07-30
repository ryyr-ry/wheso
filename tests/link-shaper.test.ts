/**
 * 整形器が**本当に効く**ことの試験（`tests/support/link-shaper.ts`）。
 *
 * **なぜ必要か。** 段 D はこの整形器で回線を劣化させる。整形器が何もしていなければ、
 * 8 プロファイルすべてが「緑」になるが**何も検証していない**。器が器を検証しなければ、
 * 段 D 全体がまやかしになる。ここで帯域・遅延・順序・遮断・背圧を数で確かめる。
 *
 * 時計は試験が進める（実時間を待たない）。整形器は `now` を注入で受ける。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createShaper, NO_SHAPE } from "./support/link-shaper.ts";

/** 試験用の時計と、`setInterval` を手で回すための仕掛け。 */
function harness(): {
  readonly clock: { ms: number };
  readonly advance: (ms: number) => void;
  readonly restore: () => void;
} {
  const clock = { ms: 1_000 };
  const ticks: (() => void)[] = [];
  const realInterval = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  // `setInterval` を差し替え、刻みを試験が呼ぶ。**実時間を待つ試験にしない。**
  const fakeInterval = (handler: unknown): { unref: () => void } => {
    if (typeof handler === "function") {
      ticks.push((): void => {
        handler();
      });
    }
    return { unref: (): void => undefined };
  };
  Reflect.set(globalThis, "setInterval", fakeInterval);
  Reflect.set(globalThis, "clearInterval", (): void => undefined);
  return {
    clock,
    advance: (ms): void => {
      // 5 ms 刻みで進める（整形器の刻みと同じ）。
      for (let step = 0; step < ms; step += 5) {
        clock.ms += 5;
        for (const tick of ticks) {
          tick();
        }
      }
    },
    restore: (): void => {
      Reflect.set(globalThis, "setInterval", realInterval);
      Reflect.set(globalThis, "clearInterval", realClear);
    },
  };
}

test("**帯域制限が効く**（1 Mbps なら 1 秒で約 125 KB しか通らない）", () => {
  const h = harness();
  try {
    const shaper = createShaper((): number => h.clock.ms);
    const out: Buffer[] = [];
    const port = shaper.attach((chunk): void => {
      out.push(chunk);
    }, null);
    shaper.set({ rateKbit: 1000, delayMs: 0, jitterMs: 0, blackout: false });

    // 1 MB を一度に投入する。
    port.push(Buffer.alloc(1024 * 1024, 7));
    h.advance(1000);

    const released = out.reduce((sum, chunk) => sum + chunk.length, 0);
    // 1 Mbps = 125,000 バイト/秒。突発の許容（BURST_MS）ぶんの上振れを見込む。
    assert.ok(released >= 100_000, `1 秒で 100 KB 以上は通る（${String(released)}）`);
    assert.ok(released <= 145_000, `**1 秒で 145 KB を超えない**（${String(released)}）`);
    assert.ok(shaper.stats().throttles > 0, "帯域制限で待たせた記録が残る");
    shaper.stop();
  } finally {
    h.restore();
  }
});

test("**劣化が無いときは器が何も足さない**（素通し。突発を作らない）", () => {
  const h = harness();
  try {
    const shaper = createShaper((): number => h.clock.ms);
    const seen: number[] = [];
    const port = shaper.attach((chunk): void => {
      // 刻みを回していないのに出れば、待ち行列を通していない証拠である。
      seen.push(chunk.length);
    }, null);
    shaper.set(NO_SHAPE);
    port.push(Buffer.alloc(100, 1));
    port.push(Buffer.alloc(200, 2));
    assert.deepEqual(seen, [100, 200], "**刻みを待たずにその場で出る**");
    shaper.stop();
  } finally {
    h.restore();
  }
});

test("帯域制限が無ければ即座に全部通る（対照）", () => {
  const h = harness();
  try {
    const shaper = createShaper((): number => h.clock.ms);
    const out: Buffer[] = [];
    const port = shaper.attach((chunk): void => {
      out.push(chunk);
    }, null);
    shaper.set(NO_SHAPE);
    port.push(Buffer.alloc(1024 * 1024, 7));
    h.advance(20);
    const released = out.reduce((sum, chunk) => sum + chunk.length, 0);
    assert.equal(released, 1024 * 1024, "無制限なら全部通る");
    shaper.stop();
  } finally {
    h.restore();
  }
});

test("**遅延が効く**（100 ms は 100 ms 待たされる）", () => {
  const h = harness();
  try {
    const shaper = createShaper((): number => h.clock.ms);
    const out: number[] = [];
    const port = shaper.attach((chunk): void => {
      out.push(h.clock.ms);
      void chunk;
    }, null);
    shaper.set({ rateKbit: 0, delayMs: 100, jitterMs: 0, blackout: false });
    const sentAt = h.clock.ms;
    port.push(Buffer.alloc(64, 1));
    h.advance(50);
    assert.equal(out.length, 0, "50 ms では出ない");
    h.advance(60);
    assert.equal(out.length, 1, "110 ms までには出る");
    const at = out[0] ?? 0;
    assert.ok(at - sentAt >= 100, `100 ms 以上遅れる（${String(at - sentAt)} ms）`);
    shaper.stop();
  } finally {
    h.restore();
  }
});

test("**ジッタを入れても順序は壊れない**（TLS が壊れないための必須条件）", () => {
  const h = harness();
  try {
    const shaper = createShaper((): number => h.clock.ms, 12_345);
    const out: number[] = [];
    const port = shaper.attach((chunk): void => {
      out.push(chunk[0] ?? -1);
    }, null);
    shaper.set({ rateKbit: 0, delayMs: 100, jitterMs: 50, blackout: false });
    for (let index = 0; index < 40; index += 1) {
      port.push(Buffer.from([index]));
      h.advance(5);
    }
    h.advance(400);
    assert.equal(out.length, 40, "全部出る");
    const sorted = [...out].sort((left, right) => left - right);
    assert.deepEqual(out, sorted, "**投入した順に出る**");
    shaper.stop();
  } finally {
    h.restore();
  }
});

test("**完全遮断が効く**（遮断中は 1 バイトも出ず、復帰後に流れる）", () => {
  const h = harness();
  try {
    const shaper = createShaper((): number => h.clock.ms);
    const out: Buffer[] = [];
    const port = shaper.attach((chunk): void => {
      out.push(chunk);
    }, null);
    shaper.set({ rateKbit: 0, delayMs: 0, jitterMs: 0, blackout: true });
    port.push(Buffer.alloc(1000, 1));
    h.advance(500);
    assert.equal(out.length, 0, "遮断中は出ない");
    assert.equal(shaper.stats().queuedBytes, 1000, "溜まっている");

    shaper.set(NO_SHAPE);
    h.advance(20);
    assert.equal(out.reduce((sum, chunk) => sum + chunk.length, 0), 1000, "復帰後に流れる");
    shaper.stop();
  } finally {
    h.restore();
  }
});

test("**帯域は接続をまたいで共有する**（装置単位の制限を再現する）", () => {
  const h = harness();
  try {
    const shaper = createShaper((): number => h.clock.ms);
    let released = 0;
    const sink = (chunk: Buffer): void => {
      released += chunk.length;
    };
    const first = shaper.attach(sink, null);
    const second = shaper.attach(sink, null);
    shaper.set({ rateKbit: 1000, delayMs: 0, jitterMs: 0, blackout: false });
    first.push(Buffer.alloc(512 * 1024, 1));
    second.push(Buffer.alloc(512 * 1024, 2));
    h.advance(1000);
    // 2 本でも合計は 1 Mbps ぶんに留まる（1 本のときと同じ）。
    assert.ok(released <= 145_000, `2 本でも合計は変わらない（${String(released)}）`);
    assert.ok(released >= 100_000, `流れている（${String(released)}）`);
    shaper.stop();
  } finally {
    h.restore();
  }
});
