/**
 * トレースベクタの生成と検査。
 *
 * 実行:
 *   node tools/traces.ts generate   ... spec/vectors/trace-shard.jsonl を生成する
 *   node tools/traces.ts check      ... 参照実装の出力がベクタと完全一致することを検査する
 *
 * conformance.md 4 節の形式に従う。
 * 終了状態: 成功 0、相違 1、実行不能 2（conformance.md 9 節）。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { step, initialState } from "../packages/core/src/shard-core.ts";
import { TRACE_FORMAT_VERSION } from "../packages/core/src/generated/constants.ts";
import { generateShardEvents } from "./generate-events.ts";

/** unknown を安全に Record として扱う型ガード。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const vectorPath = join(root, "spec", "vectors", "trace-shard.jsonl");

/** 種から参照実装を実行しトレース行を返す。 */
function runTrace(seed: bigint, steps: number): readonly string[] {
  const eventsResult = generateShardEvents(seed, steps);
  if (!eventsResult.ok) {
    process.stderr.write(`生成に失敗: ${eventsResult.error.detail}\n`);
    process.exitCode = 2;
    return [];
  }

  const events = eventsResult.value;
  const lines: string[] = [];

  // 先頭行
  lines.push(JSON.stringify({ v: TRACE_FORMAT_VERSION, unit: "shard", seed: Number(seed) }));

  // 初期時刻は最初のイベントの時刻
  const firstEvent = events[0];
  if (firstEvent === undefined) {
    return lines;
  }
  let state = initialState(firstEvent.t);

  for (const timedEvent of events) {
    const { t, event } = timedEvent;
    // in 行
    lines.push(JSON.stringify({ t, in: event }));

    // 実行
    const result = step(state, event, t);
    state = result.state;

    // out 行（空でも [] を明記）
    lines.push(JSON.stringify({ t, out: result.commands }));
  }

  return lines;
}

/** 生成: 種 42 で 300 ステップのトレースを生成し保存する。 */
async function generate(): Promise<void> {
  const seed = 42n;
  const steps = 300;
  const lines = runTrace(seed, steps);
  if (lines.length === 0) {
    process.exitCode = 2;
    return;
  }
  await mkdir(dirname(vectorPath), { recursive: true });
  await writeFile(vectorPath, lines.join("\n") + "\n", "utf8");
  process.stdout.write(`generated trace-shard.jsonl: ${lines.length} lines, seed=${seed}, steps=${steps}\n`);
}

/** 検査: 凍結ベクタを読み、参照実装で再生して一致を確認する。 */
async function check(): Promise<void> {
  let content: string;
  try {
    content = await readFile(vectorPath, "utf8");
  } catch {
    process.stderr.write(`trace-shard.jsonl が読めない。先に generate を実行する。\n`);
    process.exitCode = 2;
    return;
  }

  const frozenLines = content.trim().split("\n");
  const headerRaw = frozenLines[0];
  if (headerRaw === undefined) {
    process.stderr.write("trace-shard.jsonl が空\n");
    process.exitCode = 2;
    return;
  }

  // ヘッダから seed と steps を取得して再生成する
  const header: unknown = JSON.parse(headerRaw);
  if (!isRecord(header)) {
    process.stderr.write("ヘッダ行が不正\n");
    process.exitCode = 2;
    return;
  }
  const seed = header["seed"];
  if (typeof seed !== "number") {
    process.stderr.write("ヘッダに seed が無い\n");
    process.exitCode = 2;
    return;
  }

  // 凍結ベクタの in 行数から steps を推定する（ただし generate と同じ種なので同じ結果になる）
  // 再生成して行単位で比較する
  const regenerated = runTrace(BigInt(seed), 300);

  let mismatches = 0;
  const maxLines = Math.max(frozenLines.length, regenerated.length);
  for (let i = 0; i < maxLines; i += 1) {
    const frozen = frozenLines[i];
    const actual = regenerated[i];
    if (frozen !== actual) {
      mismatches += 1;
      if (mismatches <= 10) {
        process.stdout.write(`行 ${i + 1} 不一致:\n`);
        process.stdout.write(`  凍結: ${frozen ?? "(欠落)"}\n`);
        process.stdout.write(`  実際: ${actual ?? "(欠落)"}\n`);
      }
    }
  }

  if (mismatches > 0) {
    process.stdout.write(`${mismatches} 行の不一致\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`OK: trace-shard.jsonl ${frozenLines.length} 行すべて一致\n`);
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "check";
  if (mode === "generate") {
    await generate();
    return;
  }
  if (mode === "check") {
    await check();
    return;
  }
  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exitCode = 2;
}

main().catch((error: unknown): void => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
  process.stderr.write(`FATAL: ${detail}\n`);
  process.exitCode = 2;
});
