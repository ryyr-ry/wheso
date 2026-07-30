/**
 * 受信ノード（receiver）のトレースベクタの生成と検査。
 *
 * 実行:
 *   node tools/traces-receiver.ts generate  ... spec/vectors/trace-receiver.jsonl を生成する
 *   node tools/traces-receiver.ts check     ... 参照実装の出力がベクタと完全一致することを検査する
 *
 * conformance.md 4 節の形式に従う。終了状態: 成功 0、相違 1、実行不能 2（同 9 節）。
 * 受信ノードは時刻に依存する判断を持たない（購読と配分は入力の値のみで決まる）ため、
 * `t` は入力の並び順を示す論理時刻として記録する。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type CatalogRung,
  initialReceiverState,
  receiverStep,
  type ReceiverEvent,
} from "../packages/core/src/receiver-core.ts";
import {
  AUDIO_ONLY_ENTER_BPS,
  AUDIO_ONLY_EXIT_BPS,
  TRACE_FORMAT_VERSION,
  V_1080P30,
  V_360P15,
  V_4K60,
} from "../packages/core/src/generated/constants.ts";
import {
  CHANNEL_AUDIO,
  CHANNEL_VIDEO,
  MAX_TEMPORAL_ID,
} from "../packages/core/src/generated/wire-layout.ts";
import { createPrng, next } from "../packages/core/src/prng.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const vectorPath = join(root, "spec", "vectors", "trace-receiver.jsonl");

/**
 * 段の上限。はしごの段番号であり、大域のプロファイル表とは対応しない（ADR-0026）。
 * 生成するはしごは 3 段（0・1・2）である。
 */
const TOP_RUNG = 2;

/** 3 段のはしご。代表点を使う（Q-021 の測定が済むまで）。 */
const THREE_RUNGS: readonly CatalogRung[] = [
  {
    sid: 0,
    width: V_360P15.width,
    height: V_360P15.height,
    framerate: V_360P15.framerate,
    temporalLayers: V_360P15.temporalLayers,
    targetBitrate: V_360P15.targetBitrate,
  },
  {
    sid: 1,
    width: V_1080P30.width,
    height: V_1080P30.height,
    framerate: V_1080P30.framerate,
    temporalLayers: V_1080P30.temporalLayers,
    targetBitrate: V_1080P30.targetBitrate,
  },
  {
    sid: 2,
    width: V_4K60.width,
    height: V_4K60.height,
    framerate: V_4K60.framerate,
    temporalLayers: V_4K60.temporalLayers,
    targetBitrate: V_4K60.targetBitrate,
  },
];

/** 2 段のはしご。段数が送信者ごとに違うことを記録する。 */
const TWO_RUNGS: readonly CatalogRung[] = [THREE_RUNGS[0], THREE_RUNGS[1]].filter(
  (rung): rung is CatalogRung => rung !== undefined,
);

/** 乱数から [lo, hi] の整数を返す。整数演算のみ。 */
function randRange(output: bigint, lo: number, hi: number): number {
  const span = hi - lo + 1;
  if (span <= 0) {
    return lo;
  }
  return lo + Number(output % BigInt(span));
}

/**
 * 入力イベント列を種から生成する。
 *
 * 網羅する事象:
 *   購読の追加と削除、表示寸法の申告、発話者の交替、予算の増減、
 *   遅延勾配による tier の上下、非表示と再表示、送信者の退出、メディアの転送と破棄。
 */
/**
 * 予算（bytes/sec）を、`reallocate` の判定値が境界の指定した側に落ちるように作る。
 *
 * `reallocate` は回線速度 `target × 8` を閾値と比べる。したがって
 * `target = floor(閾値 / 8) + offset` とすれば境界の直上・直下を作れる。
 * 整数除算のみで計算する（ADR-0017）。
 */
function enterBytes(offset: number): number {
  return Math.trunc(AUDIO_ONLY_ENTER_BPS / 8) + offset;
}

function exitBytes(offset: number): number {
  return Math.trunc(AUDIO_ONLY_EXIT_BPS / 8) + offset;
}

function generateReceiverEvents(seed: bigint, steps: number): readonly ReceiverEvent[] {
  const prng = createPrng(seed);
  if (!prng.ok) {
    return [];
  }
  let state = prng.value;
  const advance = (): bigint => {
    const result = next(state);
    state = result.state;
    return result.output;
  };

  const events: ReceiverEvent[] = [];
  const senders = [11, 12, 13, 14];
  /**
   * 送信者ごとの sequenceNumber。ack の算出（受信位置の記録）を覆うために必要である。
   * 番号を持たないメディアだけを流すと、後戻りの判定と ack の出力が検証されない。
   */
  const nextSeq = new Map<number, number>();

  // はしごを配る（ADR-0027）。**これが無いと受信ノードは費用も段も決められない。**
  // 段は 3 段（640/1920/3840）。全員が同じはしごを持つ場合と、2 段しか持たない場合を混ぜる。
  events.push({
    kind: "catalog",
    entries: senders.map((senderId, index) => ({
      senderId,
      channel: CHANNEL_VIDEO,
      rungs: (index % 2 === 0 ? THREE_RUNGS : TWO_RUNGS).map((rung) => ({ ...rung })),
    })),
  });

  // 購読の確立
  events.push({
    kind: "subscribe",
    entries: senders.map((senderId) => ({
      senderId,
      channel: CHANNEL_VIDEO,
      maxSpatialId: TOP_RUNG,
      maxTemporalId: MAX_TEMPORAL_ID,
    })),
  });

  // 表示寸法の申告（一部の送信者のみ申告する。未申告は最低品質に留まる）
  events.push({ kind: "displaySize", senderId: 11, channel: CHANNEL_VIDEO, width: 3840 });
  events.push({ kind: "displaySize", senderId: 12, channel: CHANNEL_VIDEO, width: 1920 });

  const rising: number[] = [];
  const falling: number[] = [];
  // 増減どちらの条件も満たさない標本列。連続回数が切れることを記録するために使う。
  const flat: number[] = new Array<number>(20).fill(20_000);
  for (let i = 0; i < 20; i += 1) {
    rising.push(10_000 + i * 60_000);
    falling.push(1_200_000 - i * 60_000);
  }

  for (let i = 0; i < steps; i += 1) {
    const roll = randRange(advance(), 0, 99);
    if (roll < 40) {
      const senderIndex = randRange(advance(), 0, senders.length - 1);
      const from = senders[senderIndex] ?? senders[0] ?? 11;
      const sid = randRange(advance(), 0, TOP_RUNG);
      const tid = randRange(advance(), 0, 2);
      const ch = roll < 34 ? CHANNEL_VIDEO : CHANNEL_AUDIO;
      // 番号は基本的に増やすが、一定の割合で後戻りさせる（順序の逆転で更新しないことを検証する）。
      const previous = nextSeq.get(from) ?? 0;
      const shape = randRange(advance(), 0, 9);
      // 8 割は前進、1 割は同じ番号の再送、1 割は後戻り。
      // 同じ番号の再送を入れないと「後戻りでは更新しない」判定が検証されない。
      const seq = shape === 0 && previous > 0 ? previous : shape === 1 && previous > 3 ? previous - 3 : previous + 1;
      nextSeq.set(from, seq > previous ? seq : previous);
      events.push({
        kind: "media",
        from,
        ch,
        sid,
        tid,
        key: sid === 0 && tid === 0,
        bytes: randRange(advance(), 200, 50_000),
        flags: tid === 2 ? 0b1010 : 0b1000,
        seq,
      });
      continue;
    }
    if (roll < 44) {
      // ack の周期。受信位置をまとめて返す経路を覆う。
      events.push({ kind: "timer" });
      continue;
    }
    if (roll < 55) {
      events.push({ kind: "report", delayUs: roll % 2 === 0 ? rising : falling });
      continue;
    }
    if (roll < 58) {
      // キーフレーム要求（ADR-0039）。段は 0〜2 を回す。
      events.push({
        kind: "keyframeRequest",
        senderId: 11 + (roll % 2),
        channel: CHANNEL_VIDEO,
        spatialId: roll % 3,
      });
      continue;
    }
    if (roll < 68) {
      const budget = randRange(advance(), 100_000, 12_000_000);
      events.push({ kind: "budget", bytesPerSec: budget });
      continue;
    }
    if (roll < 72) {
      // 観測した goodput。**目標を下げない**ことを覆う（congestion.md 4.1）。
      const observed = randRange(advance(), 0, 4_000_000);
      events.push({ kind: "goodput", bytesPerSec: observed });
      continue;
    }
    if (roll < 78) {
      const senderIndex = randRange(advance(), 0, senders.length - 1);
      events.push({ kind: "activeSpeaker", id: senders[senderIndex] ?? null });
      continue;
    }
    if (roll < 86) {
      const senderIndex = randRange(advance(), 0, senders.length - 1);
      const width = randRange(advance(), 0, 3840);
      events.push({
        kind: "displaySize",
        senderId: senders[senderIndex] ?? 11,
        channel: CHANNEL_VIDEO,
        width,
      });
      continue;
    }
    if (roll < 92) {
      events.push({ kind: "visibility", visible: i % 2 === 0 });
      continue;
    }
    if (roll < 96) {
      const count = randRange(advance(), 1, senders.length);
      events.push({
        kind: "subscribe",
        entries: senders.slice(0, count).map((senderId) => ({
          senderId,
          channel: CHANNEL_VIDEO,
          maxSpatialId: TOP_RUNG,
          maxTemporalId: MAX_TEMPORAL_ID,
        })),
      });
      continue;
    }
    const senderIndex = randRange(advance(), 0, senders.length - 1);
    events.push({ kind: "leave", id: senders[senderIndex] ?? 11 });
  }

  // --- AIMD（congestion.md 4.2）を確実に通す段 ---
  //
  // なぜ専用の段が必要か: 混合イベント列では「劣化の報告が待ち（RATE_HOLD_MS）を跨いで
  // 続く」場面と「回復の報告が 3 回連続する」場面が偶然にしか起きない。
  // トレースに現れない入力は検証されない（X-024 と同じ誤り）。
  //
  // 減少を 3 回（待ちを跨いで）、次に回復を 4 回続ける。1 イベント 50 ms であるため、
  // 待ち（1000 ms）を跨ぐには 20 イベントぶんの間隔が要る。間に timer を挟んで進める。
  for (let round = 0; round < 3; round += 1) {
    events.push({ kind: "report", delayUs: rising });
    for (let filler = 0; filler < 21; filler += 1) {
      events.push({ kind: "timer" });
    }
  }
  for (let round = 0; round < 4; round += 1) {
    events.push({ kind: "report", delayUs: falling });
  }
  // 増減どちらでもない報告を挟み、連続回数が切れることも記録する。
  events.push({ kind: "report", delayUs: flat });
  for (let round = 0; round < 4; round += 1) {
    events.push({ kind: "report", delayUs: falling });
  }

  // --- 音声だけの状態（ADR-0029）を確実に通す段 ---
  //
  // 予算を AUDIO_ONLY_ENTER_BPS より下へ落とすと、映像の購読を落として音声だけになる。
  // 予算を AUDIO_ONLY_EXIT_BPS より上へ戻すと、**最下段から**映像へ復帰する。
  // 混合イベント列では境界をまたぐ組み合わせが偶然にしか起きないため、専用の段を作る。
  events.push({
    kind: "subscribe",
    entries: [
      { senderId: 11, channel: CHANNEL_VIDEO, maxSpatialId: TOP_RUNG, maxTemporalId: MAX_TEMPORAL_ID },
      { senderId: 11, channel: CHANNEL_AUDIO, maxSpatialId: 0, maxTemporalId: 0 },
    ],
  });
  // 入る境界のすぐ上（映像は維持される）。
  events.push({ kind: "budget", bytesPerSec: enterBytes(1) });
  // 入る境界のすぐ下（映像を落とす）。
  events.push({ kind: "budget", bytesPerSec: enterBytes(-1) });
  // 出る境界のすぐ下（まだ戻らない。ヒステリシス）。
  events.push({ kind: "budget", bytesPerSec: exitBytes(-1) });
  // 出る境界のすぐ上（最下段から戻る）。
  events.push({ kind: "budget", bytesPerSec: exitBytes(1) });

  // **goodput は目標を下げない。** 媒体が止まって goodput が 0 になっても
  // `AUDIO_ONLY` へ落ちてはならない（実測でここが壊れていた）。
  events.push({ kind: "goodput", bytesPerSec: 0 });
  events.push({ kind: "goodput", bytesPerSec: 1 });
  events.push({ kind: "goodput", bytesPerSec: enterBytes(-1) });
  // 上げる方向には効く（天井を押し上げる）。
  events.push({ kind: "goodput", bytesPerSec: 12_000_000 });
  events.push({ kind: "report", delayUs: [0, -1_000, -2_000, -3_000, -4_000] });
  events.push({ kind: "report", delayUs: [0, -1_000, -2_000, -3_000, -4_000] });
  events.push({ kind: "report", delayUs: [0, -1_000, -2_000, -3_000, -4_000] });
  // 標本が 1 個の報告は勾配が定まらないため無視される。
  events.push({ kind: "report", delayUs: [5_000] });
  events.push({ kind: "report", delayUs: [] });

  return events;
}

/** 種から参照実装を実行しトレース行を返す。 */
function runTrace(seed: bigint, steps: number): readonly string[] {
  const events = generateReceiverEvents(seed, steps);
  const lines: string[] = [
    JSON.stringify({ v: TRACE_FORMAT_VERSION, unit: "receiver", seed: Number(seed) }),
  ];
  let state = initialReceiverState();
  let t = 0;
  for (const event of events) {
    lines.push(JSON.stringify({ t, in: event }));
    const result = receiverStep(state, event, t);
    state = result.state;
    lines.push(JSON.stringify({ t, out: result.commands }));
    // 刻みを実時間らしくする。1 刻みでは AIMD の待ち（RATE_HOLD_MS = 1000）を跨げず、
    // 減少が 1 回しか現れない。トレースに現れない入力は検証されない。
    t += 50;
  }
  return lines;
}

const SEED = 4242n;
const STEPS = 400;

async function generate(): Promise<void> {
  const lines = runTrace(SEED, STEPS);
  await mkdir(dirname(vectorPath), { recursive: true });
  await writeFile(vectorPath, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(`generated trace-receiver.jsonl: ${lines.length} lines, seed=${SEED}\n`);
}

async function check(): Promise<void> {
  let content = "";
  try {
    content = await readFile(vectorPath, "utf8");
  } catch {
    process.stderr.write("spec/vectors/trace-receiver.jsonl が無い。generate を先に実行する\n");
    process.exitCode = 2;
    return;
  }
  const expected = content.trim().split("\n");
  const actual = runTrace(SEED, STEPS);
  if (expected.length !== actual.length) {
    process.stderr.write(`行数が異なる: 期待 ${expected.length} 実際 ${actual.length}\n`);
    process.exitCode = 1;
    return;
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i] !== actual[i]) {
      process.stderr.write(`行 ${i + 1} が一致しない\n  期待: ${expected[i]}\n  実際: ${actual[i]}\n`);
      process.exitCode = 1;
      return;
    }
  }
  process.stdout.write(`OK: trace-receiver.jsonl ${expected.length} 行すべて一致\n`);
}

const mode = process.argv[2] ?? "check";
if (mode === "generate") {
  await generate();
} else {
  await check();
}
