/**
 * トレースベクタの検証テスト。
 *
 * 1. 凍結ベクタを参照実装に流して一致すること。
 * 2. 同じ種のファジングが 2 回とも同じ出力になること。
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runTraceLines, runFuzz, selftestPrng, type PrngVector } from "../packages/core/src/conformance-harness.ts";
import { generateShardEvents } from "../tools/generate-events.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const vectorDir = join(root, "spec", "vectors");

describe("traces", () => {
  it("凍結トレースベクタが参照実装と完全一致する", async () => {
    const content = await readFile(join(vectorDir, "trace-shard.jsonl"), "utf8");
    const frozenLines = content.trim().split("\n");

    const result = runTraceLines(frozenLines);
    assert.ok(result.ok, `trace 実行失敗: ${result.ok ? "" : result.error.detail}`);

    // 凍結ベクタの out 行を取得して比較する
    const expectedOuts: string[] = [];
    for (const line of frozenLines) {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        if ("out" in obj) {
          expectedOuts.push(line);
        }
      }
    }

    assert.equal(
      result.value.length,
      expectedOuts.length,
      `出力行数の不一致: 期待 ${expectedOuts.length} 実際 ${result.value.length}`,
    );

    for (let i = 0; i < expectedOuts.length; i += 1) {
      const expected = expectedOuts[i];
      const actualLine: string | undefined = result.value[i];
      assert.equal(actualLine, expected, `行 ${i + 1} 不一致`);
    }
  });

  it("同じ種のファジングが決定的である（2 回同じ出力）", () => {
    const seed = 99999n;
    const steps = 250;

    const events1 = generateShardEvents(seed, steps);
    assert.ok(events1.ok);
    const out1 = runFuzz(events1.value);

    const events2 = generateShardEvents(seed, steps);
    assert.ok(events2.ok);
    const out2 = runFuzz(events2.value);

    assert.equal(out1.length, out2.length, "出力行数が異なる");
    for (let i = 0; i < out1.length; i += 1) {
      assert.equal(out1[i], out2[i], `行 ${i + 1} が異なる`);
    }
  });

  it("prng selftest がベクタと一致する", async () => {
    const prngText = await readFile(join(vectorDir, "prng.json"), "utf8");
    const prngData = JSON.parse(prngText) as { vectors: PrngVector[] };
    const result = selftestPrng(prngData.vectors);
    assert.ok(result.ok, `selftest 失敗: ${result.ok ? "" : result.error.detail}`);
  });

  it("異なる種は異なる出力を生成する", () => {
    const events1 = generateShardEvents(111n, 200);
    assert.ok(events1.ok);
    const out1 = runFuzz(events1.value);

    const events2 = generateShardEvents(222n, 200);
    assert.ok(events2.ok);
    const out2 = runFuzz(events2.value);

    // 少なくとも一部の行が異なるはず（同一出力は統計的に不可能）
    let hasDiff = false;
    const minLen = Math.min(out1.length, out2.length);
    for (let i = 0; i < minLen; i += 1) {
      if (out1[i] !== out2[i]) {
        hasDiff = true;
        break;
      }
    }
    assert.ok(hasDiff || out1.length !== out2.length, "異なる種なのに出力が同一");
  });
});
