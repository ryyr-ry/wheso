/**
 * ネットワーク劣化の適用（段 D）。
 *
 * 何のためにあるか: 帯域が安定した状態で動くことは何も証明しない。劣化させて動き続ける
 * ことを確かめる（受入条件 3 節）。プロファイルの値は spec/schema/impairment.json にあり、
 * 生成物（packages/core/src/generated/impairment.ts）から読む。数値をここに書かない。
 *
 * どこへ適用するか: **ループバック（lo）の qdisc** へ適用する。段 D の試験はブラウザから
 * 局所の中継口（TLS 終端）へ繋ぎ、そこから実環境へ出る。ブラウザ↔終端が lo を通るため、
 * lo に qdisc を置けばクライアント側の上り下りに確実に効く。
 *
 * なぜ Chrome DevTools Protocol を使わないか: Network.emulateNetworkConditions は
 * WebSocket に適用されない実装が存在する（受入条件 3.1）。OS 層なら確実である。
 *
 * なぜアプリ層の中継で遅延させないか: TCP のバイト列を遅らせることはできても、
 * **再順序と重複は再現できない**（IP パケット単位の現象であり、バイト列を重複させると
 * ストリームが壊れる）。N-4 が検証できない手段は採らない。
 *
 * 権限: `tc` の変更には root が必要である。手元では sudo が使えないことがあるため、
 * 使えない場合は明示的に飛ばす（黙って劣化なしで走らせると、劣化試験が空洞になる）。
 *
 * 実行:
 *   node tools/impair.ts show
 *   node tools/impair.ts prepare          装置の MTU を実際の経路に合わせる
 *   node tools/impair.ts apply N-1        プロファイルの最初の段を適用する
 *   node tools/impair.ts step N-2 15      指定秒の段を適用する
 *   node tools/impair.ts outage 500       指定ミリ秒だけ完全に遮断する
 *   node tools/impair.ts clear
 *   node tools/impair.ts selftest         劣化が実際に効いていることを測る
 */

import { spawnSync } from "node:child_process";
import { createServer, connect, type Socket } from "node:net";
import { performance } from "node:perf_hooks";

import {
  IMPAIRMENT_BURST_DIVISOR,
  IMPAIRMENT_BURST_KBIT,
  IMPAIRMENT_DEVICE_MTU,
  IMPAIRMENT_LATENCY_MS,
  IMPAIRMENT_MIN_DELAY_INCREASE_MS,
  IMPAIRMENT_MIN_SECONDS_AT_PROBE_RATE,
  IMPAIRMENT_PROBE_BYTES,
  IMPAIRMENT_PROBE_DELAY_MS,
  IMPAIRMENT_PROBE_RATE_KBIT,
  IMPAIRMENT_PROFILES,
  type ImpairmentProfile,
  type ImpairmentStep,
} from "../packages/core/src/generated/impairment.ts";

/** 劣化を適用する装置。段 D はブラウザと局所の中継口の間を劣化させる。 */
const DEVICE = "lo";

interface CommandResult {
  readonly ok: boolean;
  readonly output: string;
}

/**
 * tc を実行する。root でなければ sudo を試す。
 * 失敗を例外にしない（呼び出し側が「使えないので飛ばす」と判断できるようにする）。
 */
function runTc(args: readonly string[]): CommandResult {
  const direct = spawnSync("tc", args, { encoding: "utf8" });
  if (direct.status === 0) {
    return { ok: true, output: `${direct.stdout}${direct.stderr}` };
  }
  const viaSudo = spawnSync("sudo", ["-n", "tc", ...args], { encoding: "utf8" });
  if (viaSudo.status === 0) {
    return { ok: true, output: `${viaSudo.stdout}${viaSudo.stderr}` };
  }
  return {
    ok: false,
    output: `${direct.stderr}${viaSudo.stderr}`.trim(),
  };
}

/** ip を実行する。tc と同じく失敗を例外にしない。 */
function runIp(args: readonly string[]): CommandResult {
  const direct = spawnSync("ip", args, { encoding: "utf8" });
  if (direct.status === 0) {
    return { ok: true, output: `${direct.stdout}${direct.stderr}` };
  }
  const viaSudo = spawnSync("sudo", ["-n", "ip", ...args], { encoding: "utf8" });
  if (viaSudo.status === 0) {
    return { ok: true, output: `${viaSudo.stdout}${viaSudo.stderr}` };
  }
  return { ok: false, output: `${direct.stderr}${viaSudo.stderr}`.trim() };
}

/**
 * 装置の MTU を実際のクライアント経路に合わせる。
 *
 * なぜ必要か: ループバックの既定 MTU は 65536 バイト（512 kbit）である。tbf の burst
 * （32 kbit）より 1 パケットが大きいと、パケットが 1 つも通らず TCP が ETIMEDOUT で
 * 壊れる（CI で実測。帯域制限を適用した直後に接続が死んだ）。
 * 家庭回線の MTU に合わせて下げることで、劣化の再現も実際の経路に近づく。
 */
export function prepareDevice(): boolean {
  const applied = runIp(["link", "set", "dev", DEVICE, "mtu", String(IMPAIRMENT_DEVICE_MTU)]);
  return applied.ok;
}

/** 劣化を適用できるかを確かめる。使えない環境では段 D を飛ばす。 */
export function canImpair(): boolean {
  const probe = runTc(["qdisc", "show", "dev", DEVICE]);
  if (!probe.ok) {
    return false;
  }
  // 読めても書けないことがある。実際に置いて消せるかで判定する。
  const added = runTc(["qdisc", "add", "dev", DEVICE, "root", "netem", "delay", "1ms"]);
  if (!added.ok) {
    return false;
  }
  clearImpairment();
  return true;
}

export function clearImpairment(): boolean {
  // 無い状態で消すと失敗するため、結果を見て判断しない（冪等に保つ）。
  runTc(["qdisc", "del", "dev", DEVICE, "root"]);
  const shown = runTc(["qdisc", "show", "dev", DEVICE]);
  return shown.ok && !shown.output.includes("netem") && !shown.output.includes("tbf");
}

export function showImpairment(): string {
  const shown = runTc(["qdisc", "show", "dev", DEVICE]);
  return shown.output.trim();
}

/**
 * 1 つの段を適用する。
 *
 * 構造: root に tbf（帯域）、その子に netem（遅延・ジッタ・再順序・重複）を置く。
 * 帯域制限が無い段では tbf を置かず netem だけを root に置く（tbf は帯域が必須である）。
 */
/**
 * 1 つの段を、**指定したポート宛（および発）の通信だけ**に適用する。
 *
 * なぜポートで絞るか: 装置全体（ループバック）に qdisc を置くと、試験に無関係な通信も
 * 同じ制限を受ける。段 D ではページの配信と Playwright の CDP がループバックを通るため、
 * 帯域を絞ると Chromium との通信ごと詰まり、**劣化ではなく試験系が壊れる**。
 * 実測では N-6（50 Mbps）で 5.7 秒、N-7（2 Mbps）で 17.3 秒に両方向の接続が 1006
 * （異常切断）になった。原因は経路の共有である。
 *
 * 構造:
 *   root に prio（3 バンド）を置き、既定の通信はバンド 1（無劣化）へ流す。
 *   バンド 3 に tbf（帯域）と netem（遅延・ジッタ・再順序・重複）を置く。
 *   u32 フィルタで「送信元ポート または 宛先ポートが port」の通信だけをバンド 3 へ送る。
 *
 * この形は N-8（参加者ごとに別々の劣化）への道でもある。参加者ごとに別のポートを使えば、
 * 同じ装置の上で別々の劣化を掛けられる（ネットワーク名前空間を作らずに済む）。
 *
 * port が 0 の場合は装置全体へ適用する（自己検査で使う）。
 */
export function applyStep(step: ImpairmentStep, port = 0): boolean {
  clearImpairment();

  const netemArgs: string[] = [];
  if (step.delayMs > 0 || step.jitterMs > 0 || step.reorderPercent > 0) {
    netemArgs.push("delay", `${String(step.delayMs)}ms`);
    if (step.jitterMs > 0) {
      netemArgs.push(`${String(step.jitterMs)}ms`);
    }
  }
  if (step.reorderPercent > 0) {
    // netem の reorder は「gap 無しで送る確率」を先に取る。遅延が無いと働かないため、
    // 呼び出し側は必ず delayMs を伴わせる（N-4 は 10 ms を持つ）。
    netemArgs.push("reorder", `${String(100 - step.reorderPercent)}%`, `${String(step.reorderPercent)}%`);
  }
  if (step.duplicatePercent > 0) {
    netemArgs.push("duplicate", `${String(step.duplicatePercent)}%`);
  }

  if (step.rateKbit <= 0 && netemArgs.length === 0) {
    // N-0（劣化なし）。何も置かない状態が正しい。
    return true;
  }

  // burst は帯域に比例させる（規範の目安は rate の 1/250 秒）。固定値にすると
  // 高い帯域で小さすぎ、TCP のバーストが常に落ちて接続が壊れる（実測）。
  const burstKbit = Math.max(
    Math.trunc(step.rateKbit / IMPAIRMENT_BURST_DIVISOR),
    IMPAIRMENT_BURST_KBIT,
  );

  if (port <= 0) {
    // 装置全体へ適用する（自己検査。ほかの通信が無い前提で使う）。
    if (step.rateKbit > 0) {
      const added = runTc([
        "qdisc", "add", "dev", DEVICE, "root", "handle", "1:",
        "tbf", "rate", `${String(step.rateKbit)}kbit`,
        "burst", `${String(burstKbit)}kbit`,
        "latency", `${String(IMPAIRMENT_LATENCY_MS)}ms`,
      ]);
      if (!added.ok) {
        return false;
      }
      if (netemArgs.length === 0) {
        return true;
      }
      return runTc([
        "qdisc", "add", "dev", DEVICE, "parent", "1:", "handle", "10:", "netem", ...netemArgs,
      ]).ok;
    }
    return runTc(["qdisc", "add", "dev", DEVICE, "root", "netem", ...netemArgs]).ok;
  }

  // ポート限定。既定のバンドは無劣化のままにする。
  const root = runTc(["qdisc", "add", "dev", DEVICE, "root", "handle", "1:", "prio", "bands", "3"]);
  if (!root.ok) {
    return false;
  }

  // バンド 3（1:3）に劣化を積む。帯域と遅延の両方がある場合は tbf の子に netem を置く。
  if (step.rateKbit > 0) {
    const shaped = runTc([
      "qdisc", "add", "dev", DEVICE, "parent", "1:3", "handle", "30:",
      "tbf", "rate", `${String(step.rateKbit)}kbit`,
      "burst", `${String(burstKbit)}kbit`,
      "latency", `${String(IMPAIRMENT_LATENCY_MS)}ms`,
    ]);
    if (!shaped.ok) {
      return false;
    }
    if (netemArgs.length > 0) {
      const delayed = runTc([
        "qdisc", "add", "dev", DEVICE, "parent", "30:", "handle", "31:", "netem", ...netemArgs,
      ]);
      if (!delayed.ok) {
        return false;
      }
    }
  } else {
    const delayed = runTc([
      "qdisc", "add", "dev", DEVICE, "parent", "1:3", "handle", "30:", "netem", ...netemArgs,
    ]);
    if (!delayed.ok) {
      return false;
    }
  }

  // 送信元と宛先の両方向を拾う。片方だけでは上りか下りのどちらかが素通しになる。
  const asDestination = runTc([
    "filter", "add", "dev", DEVICE, "protocol", "ip", "parent", "1:", "prio", "1",
    "u32", "match", "ip", "dport", String(port), "0xffff", "flowid", "1:3",
  ]);
  const asSource = runTc([
    "filter", "add", "dev", DEVICE, "protocol", "ip", "parent", "1:", "prio", "1",
    "u32", "match", "ip", "sport", String(port), "0xffff", "flowid", "1:3",
  ]);
  return asDestination.ok && asSource.ok;
}

/** ポート限定で 100% 落とす（遮断）。 */
function applyLossOnPort(port: number): CommandResult {
  const root = runTc(["qdisc", "add", "dev", DEVICE, "root", "handle", "1:", "prio", "bands", "3"]);
  if (!root.ok) {
    return root;
  }
  const loss = runTc([
    "qdisc", "add", "dev", DEVICE, "parent", "1:3", "handle", "30:", "netem", "loss", "100%",
  ]);
  if (!loss.ok) {
    return loss;
  }
  const asDestination = runTc([
    "filter", "add", "dev", DEVICE, "protocol", "ip", "parent", "1:", "prio", "1",
    "u32", "match", "ip", "dport", String(port), "0xffff", "flowid", "1:3",
  ]);
  if (!asDestination.ok) {
    return asDestination;
  }
  return runTc([
    "filter", "add", "dev", DEVICE, "protocol", "ip", "parent", "1:", "prio", "1",
    "u32", "match", "ip", "sport", String(port), "0xffff", "flowid", "1:3",
  ]);
}

export function profileById(id: string): ImpairmentProfile | undefined {
  return IMPAIRMENT_PROFILES.find((entry) => entry.id === id);
}

/** 指定した秒に有効な段を返す。段は atSec の昇順である。 */
export function stepAt(profile: ImpairmentProfile, atSec: number): ImpairmentStep | undefined {
  let current: ImpairmentStep | undefined;
  for (const step of profile.steps) {
    if (step.atSec <= atSec) {
      current = step;
    }
  }
  return current;
}

/**
 * 完全な遮断。指定したポートの通信だけを 100% 落とす。
 * port が 0 の場合は装置全体を落とす（自己検査で使う）。
 */
export async function outage(durationMs: number, port = 0): Promise<boolean> {
  clearImpairment();
  const added =
    port <= 0
      ? runTc(["qdisc", "add", "dev", DEVICE, "root", "netem", "loss", "100%"])
      : applyLossOnPort(port);
  if (!added.ok) {
    return false;
  }
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  return clearImpairment();
}

/* ------------------------------------------------------------------------- */
/* 実効性の確認                                                              */
/* ------------------------------------------------------------------------- */

/**
 * 局所に echo する口を立て、指定バイト数を送って往復にかかる時間を測る。
 * 劣化が「効いている」ことを、時間という観測量で確かめるために使う。
 */
async function measure(bytes: number): Promise<number> {
  const payload = Buffer.alloc(bytes, 0x61);
  const server = createServer((socket: Socket) => {
    let received = 0;
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received >= bytes) {
        socket.end("done");
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  const started = performance.now();
  const elapsed = await new Promise<number>((resolve) => {
    const client = connect({ host: "127.0.0.1", port }, () => {
      client.write(payload);
    });
    client.on("data", () => {
      const value = performance.now() - started;
      client.destroy();
      resolve(value);
    });
    // 劣化が強いと接続そのものが壊れる。例外にせず、経過時間として扱う
    // （呼び出し側は「時間がかかった」ことを劣化の効果として判定する）。
    client.on("error", () => {
      const value = performance.now() - started;
      client.destroy();
      resolve(value);
    });
    setTimeout(() => {
      client.destroy();
      resolve(performance.now() - started);
    }, 120_000);
  });
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return elapsed;
}

/**
 * 劣化が実際に効いていることを測る。
 *
 * これを持たない劣化試験は空洞である。qdisc の適用に失敗していても、あるいは装置を
 * 間違えていても、試験は「劣化下でも動いた」と報告してしまう。
 */
export async function selftest(): Promise<boolean> {
  if (!canImpair()) {
    process.stdout.write("SKIP 劣化を適用できない（tc に root が要る）\n");
    return true;
  }

  if (!prepareDevice()) {
    process.stdout.write("FAIL 装置の MTU を設定できない\n");
    return false;
  }
  process.stdout.write(`装置 ${DEVICE} の MTU を ${String(IMPAIRMENT_DEVICE_MTU)} にした\n`);

  const baselineTime = await measure(IMPAIRMENT_PROBE_BYTES);
  process.stdout.write(`劣化なしの往復: ${baselineTime.toFixed(1)} ms\n`);

  // 帯域を絞ると、同じバイト数の送出に理論値ぶんの時間がかかる。
  const rateOk = applyStep({
    atSec: 0,
    rateKbit: IMPAIRMENT_PROBE_RATE_KBIT,
    delayMs: 0,
    jitterMs: 0,
    reorderPercent: 0,
    duplicatePercent: 0,
  });
  if (!rateOk) {
    process.stdout.write("FAIL 帯域制限を適用できない\n");
    clearImpairment();
    return false;
  }
  const rateTime = await measure(IMPAIRMENT_PROBE_BYTES);
  clearImpairment();
  const rateSeconds = rateTime / 1000;
  process.stdout.write(
    `帯域 ${String(IMPAIRMENT_PROBE_RATE_KBIT)} kbit での往復: ${rateTime.toFixed(1)} ms\n`,
  );

  // 遅延を入れると往復が確実に増える。
  const delayOk = applyStep({
    atSec: 0,
    rateKbit: 0,
    delayMs: IMPAIRMENT_PROBE_DELAY_MS,
    jitterMs: 0,
    reorderPercent: 0,
    duplicatePercent: 0,
  });
  if (!delayOk) {
    process.stdout.write("FAIL 遅延を適用できない\n");
    clearImpairment();
    return false;
  }
  const delayTime = await measure(1024);
  clearImpairment();
  process.stdout.write(`遅延 ${String(IMPAIRMENT_PROBE_DELAY_MS)} ms での往復: ${delayTime.toFixed(1)} ms\n`);

  let failed = false;
  if (rateSeconds < IMPAIRMENT_MIN_SECONDS_AT_PROBE_RATE) {
    process.stdout.write(
      `FAIL 帯域制限が効いていない（${rateSeconds.toFixed(2)} 秒 < ${String(IMPAIRMENT_MIN_SECONDS_AT_PROBE_RATE)} 秒）\n`,
    );
    failed = true;
  }
  if (delayTime < IMPAIRMENT_MIN_DELAY_INCREASE_MS) {
    process.stdout.write(
      `FAIL 遅延が効いていない（${delayTime.toFixed(1)} ms < ${String(IMPAIRMENT_MIN_DELAY_INCREASE_MS)} ms）\n`,
    );
    failed = true;
  }

  // 遮断が効くこと。100% 落とす間は往復が成立しない。
  const outageOk = await outage(300);
  if (!outageOk) {
    process.stdout.write("FAIL 遮断を適用できない\n");
    failed = true;
  }

  if (failed) {
    return false;
  }
  process.stdout.write("OK: 劣化（帯域・遅延・遮断）が実際に効いている\n");
  return true;
}

/* ------------------------------------------------------------------------- */
/* 入口                                                                      */
/* ------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const command = process.argv[2] ?? "show";
  if (command === "show") {
    process.stdout.write(`${showImpairment()}\n`);
    return;
  }
  if (command === "prepare") {
    const ok = prepareDevice();
    process.stdout.write(ok ? `MTU を ${String(IMPAIRMENT_DEVICE_MTU)} にした\n` : "MTU を設定できない（root が要る）\n");
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (command === "clear") {
    process.stdout.write(clearImpairment() ? "劣化を解除した\n" : "解除できない（root が要る）\n");
    return;
  }
  if (command === "selftest") {
    const ok = await selftest();
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (command === "outage") {
    const ms = Number(process.argv[3] ?? "500");
    const ok = await outage(ms);
    process.stdout.write(ok ? `遮断 ${String(ms)} ms を適用して解除した\n` : "遮断を適用できない\n");
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (command === "apply" || command === "step") {
    const id = process.argv[3] ?? "";
    const profile = profileById(id);
    if (profile === undefined) {
      process.stderr.write(`未知のプロファイル: ${id}\n`);
      process.exitCode = 2;
      return;
    }
    const atSec = command === "step" ? Number(process.argv[4] ?? "0") : 0;
    const step = stepAt(profile, atSec);
    if (step === undefined) {
      process.stderr.write(`${id} に ${String(atSec)} 秒の段が無い\n`);
      process.exitCode = 2;
      return;
    }
    prepareDevice();
    const ok = applyStep(step);
    process.stdout.write(
      ok
        ? `${id} の ${String(step.atSec)} 秒の段を適用した（${showImpairment()}）\n`
        : `${id} を適用できない（root が要る）\n`,
    );
    process.exitCode = ok ? 0 : 1;
    return;
  }
  process.stderr.write(`未知の命令: ${command}\n`);
  process.exitCode = 2;
}

// 輸入されたときは実行しない（試験から関数を使う）。
if (process.argv[1] !== undefined && process.argv[1].endsWith("impair.ts")) {
  await main();
}
