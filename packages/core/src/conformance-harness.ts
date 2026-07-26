/**
 * 適合ハーネスのコア。
 *
 * conformance.md 9 節の CLI のうち、入出力を伴わない処理を提供する。
 * tools/conformance.ts が CLI として呼ぶ。
 *
 * lint-policy.md 9 節: コアは入出力を行わない。本ファイルは tools/ が呼ぶ
 * ブリッジであるが packages/core に置く。入出力は行わず純関数のみとする。
 */

import { createPrng, next } from "./prng.ts";
import { type Result, ok, err } from "./result.ts";
import {
  step,
  initialState,
  type ShardEvent,
  type ShardState,
  type ShardCommand,
} from "./shard-core.ts";

export interface HarnessError {
  readonly code: string;
  readonly detail: string;
}

/** selftest: 擬似乱数器のベクタ照合。期待値を外から受け取る。 */
export interface PrngVector {
  readonly seed: string;
  readonly outputs: readonly string[];
}

export function selftestPrng(vectors: readonly PrngVector[]): Result<true, HarnessError> {
  for (const vec of vectors) {
    const seedBig = BigInt(vec.seed);
    const prngResult = createPrng(seedBig);
    if (!prngResult.ok) {
      return err({ code: "E_SELFTEST", detail: `seed ${vec.seed}: ${prngResult.error.detail}` });
    }
    let state = prngResult.value;
    for (let i = 0; i < vec.outputs.length; i += 1) {
      const expected = vec.outputs[i];
      if (expected === undefined) {
        continue;
      }
      const r = next(state);
      state = r.state;
      const actual = r.output.toString();
      if (actual !== expected) {
        return err({
          code: "E_SELFTEST",
          detail: `seed ${vec.seed} output[${i}]: 期待 ${expected} 実際 ${actual}`,
        });
      }
    }
  }
  return ok(true);
}

/** unknown を Record<string, unknown> として安全に扱う型ガード。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ShardEvent の型ガード。全フィールドの検査は行わず kind の存在を確認する。 */
function isShardEvent(value: unknown): value is ShardEvent {
  if (!isRecord(value)) {
    return false;
  }
  const kind = value["kind"];
  return (
    kind === "media" ||
    kind === "subscribe" ||
    kind === "join" ||
    kind === "leave" ||
    kind === "link" ||
    kind === "timer" ||
    kind === "budget" ||
    kind === "report"
  );
}

/** trace: JSONL を解釈して shard コアを実行し、出力コマンド行を返す。 */
export interface TraceOutput {
  readonly t: number;
  readonly out: readonly ShardCommand[];
}

export function runTraceLines(lines: readonly string[]): Result<readonly string[], HarnessError> {
  if (lines.length === 0) {
    return err({ code: "E_TRACE", detail: "空のトレース" });
  }

  const headerRaw = lines[0];
  if (headerRaw === undefined) {
    return err({ code: "E_TRACE", detail: "ヘッダ行が無い" });
  }
  const header: unknown = JSON.parse(headerRaw);
  if (!isRecord(header)) {
    return err({ code: "E_TRACE", detail: "ヘッダが不正" });
  }
  if (header["unit"] !== "shard") {
    return err({ code: "E_TRACE", detail: `未対応の unit: ${String(header["unit"])}` });
  }

  const outputLines: string[] = [];
  let state: ShardState | undefined;

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") {
      continue;
    }
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) {
      continue;
    }

    // in 行のみ処理する。out 行は期待値なので読み飛ばす。
    const inField = parsed["in"];
    if (inField !== undefined) {
      const t = typeof parsed["t"] === "number" ? parsed["t"] : 0;
      if (!isShardEvent(inField)) {
        continue;
      }

      if (state === undefined) {
        state = initialState(t);
      }

      const result = step(state, inField, t);
      state = result.state;

      // 出力行を書く
      outputLines.push(JSON.stringify({ t, out: result.commands }));
    }
    // out 行は読み飛ばす
  }

  return ok(outputLines);
}

/**
 * fuzz: 種と歩数から入力列を生成し、shard コアを実行して出力行を返す。
 *
 * 入力列の生成規則は generate-events.ts と同一にするため、
 * 呼び出し側（tools/conformance.ts）が generateShardEvents を呼んでイベント列を渡す。
 */
export function runFuzz(events: readonly { readonly t: number; readonly event: ShardEvent }[]): readonly string[] {
  const outputLines: string[] = [];

  if (events.length === 0) {
    return outputLines;
  }

  const firstEvent = events[0];
  if (firstEvent === undefined) {
    return outputLines;
  }
  let state = initialState(firstEvent.t);

  for (const timedEvent of events) {
    const { t, event } = timedEvent;
    const result = step(state, event, t);
    state = result.state;
    outputLines.push(JSON.stringify({ t, out: result.commands }));
  }

  return outputLines;
}
