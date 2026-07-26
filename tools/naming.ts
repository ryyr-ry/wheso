/**
 * 部屋名とシャード割当の検証。
 *
 * 実行:
 *   node tools/naming.ts generate  ... spec/vectors/naming.json を生成
 *   node tools/naming.ts check     ... ベクタと分布特性を検証
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assignByRendezvous,
  coordinatorRoom,
  fanoutRoom,
  fmix32,
  fnv1a32,
  metaRoom,
  personalRoom,
  reassignmentRatio,

  resolveAudioShard,
  resolveVideoShard,
  shardCount,
  shardRoom,
} from "../packages/core/src/naming.ts";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const vectorDir = join(here, "spec", "vectors");

const MEETING_ID = "01jxy8kq2r3mz5v7h9abcderfa".slice(0, 26);
const USER_A = "550e8400e29b41d4a716446655440000";
const USER_B = "6ba7b8109dad11d180b400c04fd430c8";

let failures = 0;

function check(condition: boolean, label: string): void {
  if (!condition) {
    failures += 1;
    process.stdout.write(`FAIL ${label}\n`);
  }
}

function unwrapName(result: { ok: true; value: string } | { ok: false; error: { code: string; detail: string } }): string {
  if (result.ok) {
    return result.value;
  }
  failures += 1;
  process.stdout.write(`FAIL 部屋名生成: ${result.error.code} ${result.error.detail}\n`);
  return "";
}

interface HashVector {
  readonly input: string;
  readonly fnv1a32: number;
  readonly fmix32OfFnv: number;
}

interface NameVector {
  readonly kind: string;
  readonly args: readonly (string | number)[];
  readonly name: string;
}

interface AssignVector {
  readonly namespace: string;
  readonly userId: string;
  readonly shardCount: number;
  readonly shardIndex: number;
}

function buildHashVectors(): readonly HashVector[] {
  const inputs = ["", "a", "abc", "video:550e8400e29b41d4a716446655440000:0", `audio:${USER_B}:3`];
  return inputs.map((input): HashVector => {
    const base = fnv1a32(input);
    return { input, fnv1a32: base, fmix32OfFnv: fmix32(base) };
  });
}

function buildNameVectors(): readonly NameVector[] {
  return [
    { kind: "meta", args: [MEETING_ID], name: unwrapName(metaRoom(MEETING_ID)) },
    { kind: "ctl", args: [MEETING_ID, USER_A], name: unwrapName(personalRoom("ctl", MEETING_ID, USER_A)) },
    { kind: "vs", args: [MEETING_ID, USER_A], name: unwrapName(personalRoom("vs", MEETING_ID, USER_A)) },
    { kind: "vr", args: [MEETING_ID, USER_A], name: unwrapName(personalRoom("vr", MEETING_ID, USER_A)) },
    { kind: "as", args: [MEETING_ID, USER_A], name: unwrapName(personalRoom("as", MEETING_ID, USER_A)) },
    { kind: "ar", args: [MEETING_ID, USER_A], name: unwrapName(personalRoom("ar", MEETING_ID, USER_A)) },
    { kind: "vsh", args: [MEETING_ID, "auto", 1, 0], name: unwrapName(shardRoom("vsh", MEETING_ID, "auto", 1, 0)) },
    { kind: "ash", args: [MEETING_ID, "auto", 7, 3], name: unwrapName(shardRoom("ash", MEETING_ID, "auto", 7, 3)) },
    {
      kind: "vfo",
      args: [MEETING_ID, "auto", 2, 1, 4],
      name: unwrapName(fanoutRoom("vfo", MEETING_ID, "auto", 2, 1, 4)),
    },
    { kind: "vco", args: [MEETING_ID, "auto", 5], name: unwrapName(coordinatorRoom("vco", MEETING_ID, "auto", 5)) },
    { kind: "aag", args: [MEETING_ID, "auto", 5], name: unwrapName(coordinatorRoom("aag", MEETING_ID, "auto", 5)) },
  ];
}

function buildAssignVectors(): readonly AssignVector[] {
  const out: AssignVector[] = [];
  for (const namespace of ["video", "audio"]) {
    for (const userId of [USER_A, USER_B]) {
      for (const count of [1, 2, 3, 8, 35]) {
        const assigned = assignByRendezvous(`${namespace}:${userId}`, count);
        if (assigned.ok) {
          out.push({ namespace, userId, shardCount: count, shardIndex: assigned.value });
        }
      }
    }
  }
  return out;
}

async function generate(): Promise<void> {
  await mkdir(vectorDir, { recursive: true });
  const payload = {
    description:
      "部屋名とシャード割当のテストベクタ。全言語の実装はこれと同一の結果を出さなければならない。",
    hash: buildHashVectors(),
    names: buildNameVectors(),
    assignments: buildAssignVectors(),
  };
  await writeFile(join(vectorDir, "naming.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(
    `generated ${payload.hash.length} hash, ${payload.names.length} name, ${payload.assignments.length} assignment vectors\n`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

async function runCheck(): Promise<void> {
  const text = await readFile(join(vectorDir, "naming.json"), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    process.stdout.write("FAIL naming.json が不正\n");
    process.exitCode = 1;
    return;
  }

  const hashVectors = parsed["hash"];
  if (Array.isArray(hashVectors)) {
    for (const entry of hashVectors) {
      if (!isRecord(entry)) {
        continue;
      }
      const input = readString(entry, "input");
      check(fnv1a32(input) === readNumber(entry, "fnv1a32"), `fnv1a32("${input}")`);
      check(fmix32(fnv1a32(input)) === readNumber(entry, "fmix32OfFnv"), `fmix32(fnv1a32("${input}"))`);
    }
  }

  const nameVectors = parsed["names"];
  if (Array.isArray(nameVectors)) {
    const rebuilt = buildNameVectors();
    check(rebuilt.length === nameVectors.length, "部屋名ベクタの件数");
    for (let i = 0; i < nameVectors.length; i += 1) {
      const expected = nameVectors[i];
      const actual = rebuilt[i];
      if (!isRecord(expected) || actual === undefined) {
        check(false, `部屋名ベクタ ${i}`);
        continue;
      }
      check(actual.name === readString(expected, "name"), `部屋名 ${readString(expected, "kind")}`);
    }
  }

  const assignVectors = parsed["assignments"];
  if (Array.isArray(assignVectors)) {
    for (const entry of assignVectors) {
      if (!isRecord(entry)) {
        continue;
      }
      const namespace = readString(entry, "namespace");
      const userId = readString(entry, "userId");
      const count = readNumber(entry, "shardCount");
      const assigned = assignByRendezvous(`${namespace}:${userId}`, count);
      check(assigned.ok && assigned.value === readNumber(entry, "shardIndex"), `割当 ${namespace}/${userId}/${count}`);
    }
  }

  // 性質検証 1: 映像と音声のハッシュ空間が分離していること
  let sameCount = 0;
  const keys: string[] = [];
  for (let i = 0; i < 2000; i += 1) {
    const userId = fnv1a32(`user${i}`).toString(16).padStart(8, "0").repeat(4);
    keys.push(`video:${userId}`);
    const video = assignByRendezvous(`video:${userId}`, 8);
    const audio = assignByRendezvous(`audio:${userId}`, 8);
    if (video.ok && audio.ok && video.value === audio.value) {
      sameCount += 1;
    }
  }
  const sameRatio = sameCount / 2000;
  check(sameRatio > 0.08 && sameRatio < 0.17, `映像と音声の割当一致率が 1/8 付近（実際 ${sameRatio.toFixed(3)}）`);

  // 性質検証 2: 分布の均一性（8 シャードで偏差 20% 以内）
  const buckets = new Array<number>(8).fill(0);
  for (const key of keys) {
    const assigned = assignByRendezvous(key, 8);
    if (!assigned.ok) {
      continue;
    }
    const current = buckets[assigned.value];
    if (current !== undefined) {
      buckets[assigned.value] = current + 1;
    }
  }
  const expectedPerBucket = keys.length / 8;
  let maxDeviation = 0;
  for (const count of buckets) {
    maxDeviation = Math.max(maxDeviation, Math.abs(count - expectedPerBucket) / expectedPerBucket);
  }
  check(maxDeviation < 0.2, `分布の偏差が 20% 未満（実際 ${(maxDeviation * 100).toFixed(1)}%）`);
  process.stdout.write(`  分布 (8 シャード, ${keys.length} 件): ${buckets.join(", ")}\n`);

  // 性質検証 3: Rendezvous hashing の再配置量が 1/newCount 付近であること
  for (const [oldCount, newCount] of [
    [1, 2],
    [2, 3],
    [8, 9],
    [16, 17],
  ]) {
    if (oldCount === undefined || newCount === undefined) {
      continue;
    }
    const ratio = reassignmentRatio(keys, oldCount, newCount);
    const expected = 1 / newCount;
    const tolerance = expected * 0.35;
    check(
      Math.abs(ratio - expected) < tolerance,
      `再配置率 ${oldCount}→${newCount}: 期待 ${expected.toFixed(3)} 実際 ${ratio.toFixed(3)}`,
    );
    process.stdout.write(`  再配置率 ${oldCount}→${newCount}: ${(ratio * 100).toFixed(1)}%（理論値 ${(expected * 100).toFixed(1)}%）\n`);
  }

  // 性質検証 4: modulo 割当との比較（modulo は再配置が過大であることの実証）
  let moduloMoved = 0;
  for (const key of keys) {
    const before = fmix32(fnv1a32(key)) % 8;
    const after = fmix32(fnv1a32(key)) % 9;
    if (before !== after) {
      moduloMoved += 1;
    }
  }
  const moduloRatio = moduloMoved / keys.length;
  check(moduloRatio > 0.8, `modulo 割当の再配置率が 80% を超える（実際 ${(moduloRatio * 100).toFixed(1)}%）`);
  process.stdout.write(
    `  参考: modulo 割当 8→9 の再配置率 ${(moduloRatio * 100).toFixed(1)}%（Rendezvous は 11% 付近）\n`,
  );

  // 性質検証 5: シャード数の単調非減少
  const monotonic = shardCount(10, 35, 3);
  check(monotonic.ok && monotonic.value === 3, "シャード数は直前の値より小さくならない");
  const grown = shardCount(80, 35, 1);
  check(grown.ok && grown.value === 3, "シャード数は ceil(N / maxPerShard)");

  // 性質検証 6: 上書き表が Rendezvous より優先される
  const overrides = new Map<string, number>([[USER_A, 7]]);
  const resolved = resolveVideoShard({
    userId: USER_A,
    meetingId: MEETING_ID,
    region: "auto",
    epoch: 3,
    shardCount: 8,
    overrides,
  });
  check(resolved.ok && resolved.value.shardIndex === 7 && resolved.value.source === "override", "上書き表の優先");
  const resolvedAudio = resolveAudioShard({
    userId: USER_A,
    meetingId: MEETING_ID,
    region: "auto",
    epoch: 3,
    shardCount: 8,
    overrides: new Map<string, number>(),
  });
  check(resolvedAudio.ok && resolvedAudio.value.source === "rendezvous", "上書きが無い場合は Rendezvous");

  if (failures === 0) {
    process.stdout.write("OK: 部屋名とシャード割当のすべての検証に成功\n");
    return;
  }
  process.stdout.write(`${failures} 件の不一致\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "check";
  if (mode === "generate") {
    await generate();
    return;
  }
  if (mode === "check") {
    await runCheck();
    return;
  }
  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exitCode = 1;
}

main().catch((error: unknown): void => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
  process.stderr.write(`FAILED: ${detail}\n`);
  process.exitCode = 1;
});
