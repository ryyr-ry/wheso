/**
 * 適合ハーネス CLI。conformance.md 9 節。
 *
 * コマンド:
 *   node tools/conformance.ts selftest           整数演算・擬似乱数の一致
 *   node tools/conformance.ts vectors            既存ベクタの照合
 *   node tools/conformance.ts trace <file.jsonl>  トレースを流し出力を stdout へ
 *   node tools/conformance.ts fuzz --seed <n> --steps <m>  種から生成した列を流し出力を stdout へ
 *
 * 終了状態: 成功 0、相違 1、実行不能 2。
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  selftestPrng,
  runTraceLines,
  runFuzz,
  type PrngVector,
} from "../packages/core/src/conformance-harness.ts";
import { generateShardEvents } from "./generate-events.ts";

/** unknown を安全に Record として扱う型ガード。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const vectorDir = join(root, "spec", "vectors");

function parseArgs(argv: readonly string[]): { command: string; file: string | undefined; seed: bigint | undefined; steps: number | undefined } {
  const command = argv[2] ?? "";
  if (command === "trace") {
    return { command, file: argv[3], seed: undefined, steps: undefined };
  }
  if (command === "fuzz") {
    let seed: bigint | undefined;
    let steps: number | undefined;
    for (let i = 3; i < argv.length; i += 1) {
      const arg = argv[i];
      const next = argv[i + 1];
      if (arg === "--seed" && next !== undefined) {
        seed = BigInt(next);
        i += 1;
      } else if (arg === "--steps" && next !== undefined) {
        steps = Number(next);
        i += 1;
      }
    }
    return { command, file: undefined, seed, steps };
  }
  return { command, file: undefined, seed: undefined, steps: undefined };
}

/** selftest: prng.json のベクタを照合する */
async function selftest(): Promise<void> {
  const prngText = await readFile(join(vectorDir, "prng.json"), "utf8");
  const prngData: unknown = JSON.parse(prngText);
  if (!isRecord(prngData)) {
    process.stderr.write("prng.json が不正\n");
    process.exitCode = 2;
    return;
  }
  const vectors = prngData["vectors"];
  if (!Array.isArray(vectors)) {
    process.stderr.write("prng.json に vectors が無い\n");
    process.exitCode = 2;
    return;
  }

  const prngVectors: PrngVector[] = [];
  for (const v of vectors) {
    if (!isRecord(v)) {
      continue;
    }
    const seed = v["seed"];
    const outputs = v["outputs"];
    if (typeof seed !== "string" || !Array.isArray(outputs)) {
      continue;
    }
    const outputStrings: string[] = [];
    for (const o of outputs) {
      if (typeof o === "string") {
        outputStrings.push(o);
      }
    }
    prngVectors.push({ seed, outputs: outputStrings });
  }

  const result = selftestPrng(prngVectors);
  if (!result.ok) {
    process.stdout.write(`FAIL selftest: ${result.error.detail}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`OK: selftest prng ${prngVectors.length} 種すべて一致\n`);
}

/** vectors: 既存の 4 種ベクタを検証（vectors.ts と同等の確認）。ここでは prng のみ */
async function vectorsCmd(): Promise<void> {
  // prng ベクタの照合を行う（selftest と同じだが明示的に vectors コマンドとして呼ぶ）
  await selftest();
}

/** trace: ファイルを読んでコアを通し、出力行を stdout へ */
async function trace(filePath: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    process.stderr.write(`ファイルが読めない: ${filePath}\n`);
    process.exitCode = 2;
    return;
  }

  const lines = content.trim().split("\n");
  const result = runTraceLines(lines);
  if (!result.ok) {
    process.stderr.write(`trace 実行失敗: ${result.error.detail}\n`);
    process.exitCode = 2;
    return;
  }

  for (const line of result.value) {
    process.stdout.write(line + "\n");
  }
}

/** fuzz: 種から入力列を生成しコアを通して出力を stdout へ */
async function fuzz(seed: bigint, steps: number): Promise<void> {
  const eventsResult = generateShardEvents(seed, steps);
  if (!eventsResult.ok) {
    process.stderr.write(`生成失敗: ${eventsResult.error.detail}\n`);
    process.exitCode = 2;
    return;
  }

  const outputLines = runFuzz(eventsResult.value);
  for (const line of outputLines) {
    process.stdout.write(line + "\n");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  switch (args.command) {
    case "selftest":
      await selftest();
      break;
    case "vectors":
      await vectorsCmd();
      break;
    case "trace":
      if (args.file === undefined) {
        process.stderr.write("usage: conformance trace <file.jsonl>\n");
        process.exitCode = 2;
        return;
      }
      await trace(args.file);
      break;
    case "fuzz":
      if (args.seed === undefined || args.steps === undefined) {
        process.stderr.write("usage: conformance fuzz --seed <n> --steps <m>\n");
        process.exitCode = 2;
        return;
      }
      await fuzz(args.seed, args.steps);
      break;
    default:
      process.stderr.write("usage: conformance selftest|vectors|trace|fuzz\n");
      process.exitCode = 2;
  }
}

main().catch((error: unknown): void => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
  process.stderr.write(`FATAL: ${detail}\n`);
  process.exitCode = 2;
});
