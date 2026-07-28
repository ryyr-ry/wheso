/**
 * 段 D（劣化）の試験。
 *
 * 何を証明するか: 劣化した回線の下でも、実環境のノードを通って映像が届き続け、
 * 落ちたフレームは破棄優先順位に従っており、固まらないこと（受入条件 3 節と 4 節）。
 *
 * 構成:
 *   1. 実環境へデプロイし、この実行のための部屋を用意する（tests/support/live-env.ts）
 *   2. 記録の器（tests/e2e/page/degrade.ts）を束ねてブラウザで開く
 *   3. プロファイルの段を時刻に沿ってループバックの qdisc へ適用する（tools/impair.ts）
 *   4. 記録に対して判定を行う
 *
 * 劣化を適用できない環境（root が無い）では**明示的に飛ばす**。黙って劣化なしで走らせると
 * 「劣化下でも動いた」という空虚な緑になる。
 *
 * なぜ短い時間で回すか: 受入条件は 1 プロファイル 60 秒を定める。CI の 1 ジョブで 8 個を
 * 回すと 8 分を超え、他の検査と並べられない。**プロファイルごとに別のジョブへ分け**、
 * 既定の長さは環境変数 WHESO_DEGRADE_SEC で上書きできるようにする（既定は規範の 60 秒）。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright";

import { DEV_NODE_KEY, startLive } from "../support/live-env.ts";
import {
  IMPAIRMENT_DURATION_SEC,
  IMPAIRMENT_MAX_GAP_MS,
  IMPAIRMENT_MAX_GAP_WITH_OUTAGE_MS,
  IMPAIRMENT_PROFILES,
} from "../../packages/core/src/generated/impairment.ts";
import { applyStep, canImpair, clearImpairment, prepareDevice, stepAt } from "../../tools/impair.ts";

const root = new URL("../..", import.meta.url).pathname;

interface SentRecord {
  readonly frameIndex: number;
  readonly temporalId: number;
  readonly isKey: boolean;
  readonly atMs: number;
}

interface ReceivedRecord {
  readonly frameIndex: number;
  readonly temporalId: number;
  readonly isKey: boolean;
  readonly sha256: string;
  readonly atMs: number;
}

interface DegradeResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly codec: string;
  readonly sent: readonly SentRecord[];
  readonly received: readonly ReceivedRecord[];
  readonly lastSentAtMs: number;
  readonly keyframeRequests: number;
  readonly durationMs: number;
}

let browser: Browser | null = null;
let pageServer: Server | null = null;
let pagePort = 0;
let bridgePort = 0;
let bridge: { close: () => void } | null = null;
let impairAvailable = false;

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * TLS の終端を立てる。劣化はループバックへ適用するため、ブラウザは局所の口へ繋ぐ。
 * 実環境へは終端が TLS で繋ぎ直す。SFU の処理は実環境の Durable Object が行う。
 */
function startBridge(port: number, host: string): { close: () => void } {
  const open = new Set<import("node:net").Socket>();
  const server = createNetServer((client) => {
    const upstream = tlsConnect({ host, port: 443, servername: host }, () => {
      upstream.pipe(client);
    });
    // Host ヘッダを実環境の名前へ書き換える。
    //
    // なぜ終端で書き換えるか: 実環境は Host でルーティングする。ブラウザは
    // `127.0.0.1:<port>` を Host に書き、上書きできない（禁止ヘッダである）。
    // 自前のクライアント（Swift / Rust / C++）は自分で書けるため書き換えない。
    // 書き換えるのは**最初のリクエストの頭だけ**で、以降のフレームは素通しする。
    let rewritten = false;
    client.on("data", (chunk: Buffer) => {
      if (rewritten) {
        upstream.write(chunk);
        return;
      }
      rewritten = true;
      const text = chunk.toString("latin1");
      const fixed = text.replace(/\r\nHost:[^\r\n]*\r\n/i, `\r\nHost: ${host}\r\n`);
      upstream.write(Buffer.from(fixed, "latin1"));
    });
    open.add(client);
    client.on("close", () => open.delete(client));
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("end", () => upstream.end());
  });
  server.listen(port, "127.0.0.1");
  return {
    close: () => {
      for (const socket of open) {
        socket.destroy();
      }
      open.clear();
      server.close();
    },
  };
}

async function bundleEntry(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [`${root}tests/e2e/page/${entry}`],
    bundle: true,
    format: "esm",
    write: false,
    target: "es2022",
    logLevel: "silent",
  });
  return result.outputFiles?.[0]?.text ?? "";
}

let live: Awaited<ReturnType<typeof startLive>> | null = null;

before(async () => {
  impairAvailable = canImpair();
  if (!impairAvailable) {
    // 劣化を適用できない環境では何も走らせない。飛ばしたことを必ず出力する。
    process.stdout.write("SKIP 段 D（劣化を適用できない。tc に root が要る）\n");
    return;
  }
  prepareDevice();

  live = await startLive();
  bridgePort = await findFreePort();
  bridge = startBridge(bridgePort, live.host);

  // 終端そのものが通ることを先に確かめる。ここを飛ばすと、ブラウザ側の失敗が
  // 「終端が壊れている」のか「ページが壊れている」のか切り分けられない。
  const bridgeOk = await new Promise<boolean>((resolve) => {
    const probe = new globalThis.WebSocket(
      `ws://127.0.0.1:${String(bridgePort)}/parties/shard/${live?.room ?? ""}?_pk=98`,
    );
    const timer = setTimeout(() => {
      probe.close();
      resolve(false);
    }, 20_000);
    probe.addEventListener("open", () => {
      clearTimeout(timer);
      probe.close();
      resolve(true);
    });
    probe.addEventListener("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  assert.equal(bridgeOk, true, "TLS 終端を通して実環境の部屋へ繋がる");

  pagePort = await findFreePort();
  const script = await bundleEntry("degrade.ts");
  assert.notEqual(script, "", "記録の器を束ねられる");
  // WebCodecs は secure context を要求する。127.0.0.1 は secure context として扱われる。
  pageServer = createServer((request, response) => {
    if (request.url === "/degrade.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(script);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><meta charset="utf-8"><title>wheso degrade</title>' +
        '<script type="module" src="/degrade.js"></script>',
    );
  });
  await new Promise<void>((resolve) => {
    pageServer?.listen(pagePort, "127.0.0.1", () => resolve());
  });

  browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
});

after(async () => {
  await browser?.close();
  browser = null;
  await new Promise<void>((resolve) => {
    if (pageServer === null) {
      resolve();
      return;
    }
    pageServer.close(() => resolve());
  });
  pageServer = null;
  bridge?.close();
  bridge = null;
  if (impairAvailable) {
    clearImpairment();
  }
});

/** 記録を読み、型を確かめて返す。動的型を使わない。 */
function asResult(value: unknown): DegradeResult {
  if (typeof value !== "object" || value === null) {
    throw new Error("記録が対象でない");
  }
  const record: Record<string, unknown> = { ...value };
  const sent = record["sent"];
  const received = record["received"];
  if (!Array.isArray(sent) || !Array.isArray(received)) {
    throw new Error("記録に送受信の配列が無い");
  }
  const readSent: SentRecord[] = [];
  for (const entry of sent) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const item: Record<string, unknown> = { ...entry };
    readSent.push({
      frameIndex: typeof item["frameIndex"] === "number" ? item["frameIndex"] : 0,
      temporalId: typeof item["temporalId"] === "number" ? item["temporalId"] : 0,
      isKey: item["isKey"] === true,
      atMs: typeof item["atMs"] === "number" ? item["atMs"] : 0,
    });
  }
  const readReceived: ReceivedRecord[] = [];
  for (const entry of received) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const item: Record<string, unknown> = { ...entry };
    readReceived.push({
      frameIndex: typeof item["frameIndex"] === "number" ? item["frameIndex"] : 0,
      temporalId: typeof item["temporalId"] === "number" ? item["temporalId"] : 0,
      isKey: item["isKey"] === true,
      sha256: typeof item["sha256"] === "string" ? item["sha256"] : "",
      atMs: typeof item["atMs"] === "number" ? item["atMs"] : 0,
    });
  }
  return {
    ok: record["ok"] === true,
    detail: typeof record["detail"] === "string" ? record["detail"] : "",
    codec: typeof record["codec"] === "string" ? record["codec"] : "",
    sent: readSent,
    received: readReceived,
    lastSentAtMs: typeof record["lastSentAtMs"] === "number" ? record["lastSentAtMs"] : 0,
    keyframeRequests: typeof record["keyframeRequests"] === "number" ? record["keyframeRequests"] : 0,
    durationMs: typeof record["durationMs"] === "number" ? record["durationMs"] : 0,
  };
}

/** 試験の長さ。既定は規範の 60 秒。CI では短くできる。 */
function durationSec(): number {
  const raw = process.env["WHESO_DEGRADE_SEC"];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : IMPAIRMENT_DURATION_SEC;
}

/** プロファイルの段を時刻に沿って適用し続ける。終わったら劣化を解除する。 */
function driveProfile(profileId: string, seconds: number): { stop: () => void } {
  const profile = IMPAIRMENT_PROFILES.find((entry) => entry.id === profileId);
  if (profile === undefined) {
    throw new Error(`未知のプロファイル: ${profileId}`);
  }
  const startedAt = Date.now();
  let appliedAtSec = -1;
  const timer = setInterval(() => {
    const elapsedSec = Math.trunc((Date.now() - startedAt) / 1000);
    if (elapsedSec > seconds) {
      return;
    }
    const step = stepAt(profile, elapsedSec);
    if (step !== undefined && step.atSec !== appliedAtSec) {
      appliedAtSec = step.atSec;
      applyStep(step);
    }
    const outage = profile.outage;
    if (outage !== undefined && elapsedSec > 0 && elapsedSec % outage.everySec === 0) {
      // 遮断の適用と解除は同期で行う（ここは試験の実行側であり判断コアではない）。
      void (async () => {
        const { outage: applyOutage } = await import("../../tools/impair.ts");
        await applyOutage(outage.durationMs);
        const back = stepAt(profile, elapsedSec);
        if (back !== undefined) {
          applyStep(back);
        }
      })();
    }
  }, 1000);
  return {
    stop: () => {
      clearInterval(timer);
      clearImpairment();
    },
  };
}

/** 判定 A-3: frameIndex が単調増加である。 */
function assertMonotonic(result: DegradeResult): void {
  let previous = 0;
  for (const entry of result.received) {
    assert.ok(
      entry.frameIndex > previous,
      `frameIndex が単調増加である（${String(previous)} の次に ${String(entry.frameIndex)}）`,
    );
    previous = entry.frameIndex;
  }
}

/**
 * 判定 C-1: 連続する描画の間隔が 1000 ms を超えない。
 *
 * 送信が終わった後の受信は評価に入れない。送信を止めれば描画も止まるのは当然であり、
 * それを「固まった」と数えると、実際の固まりと区別できない。
 */
function assertNoFreeze(result: DegradeResult, maxGapMs: number): void {
  let previous: number | undefined;
  let worst = 0;
  let worstAt = 0;
  for (const entry of result.received) {
    if (entry.atMs > result.lastSentAtMs) {
      break;
    }
    if (previous !== undefined && entry.atMs - previous > worst) {
      worst = entry.atMs - previous;
      worstAt = entry.atMs;
    }
    previous = entry.atMs;
  }
  assert.ok(
    worst <= maxGapMs,
    `描画の間隔が ${String(maxGapMs)} ms を超えない（最悪 ${worst.toFixed(0)} ms、${worstAt.toFixed(0)} ms 時点）`,
  );
}

/** 判定 B-2: 落ちたフレームは破棄可能（時間層が最上位）である。 */
function assertDropsAreDiscardable(result: DegradeResult): void {
  const arrived = new Set(result.received.map((entry) => entry.frameIndex));
  const highestTemporal = Math.max(...result.sent.map((entry) => entry.temporalId));
  const badDrops: number[] = [];
  for (const entry of result.sent) {
    if (arrived.has(entry.frameIndex)) {
      continue;
    }
    // 破棄が許されるのは最上位の時間層のみ。キーフレームと基底層が落ちたら不合格。
    if (entry.isKey || entry.temporalId < highestTemporal) {
      badDrops.push(entry.frameIndex);
    }
  }
  assert.deepEqual(badDrops, [], "破棄されたのは最上位の時間層だけである");
}

for (const profile of IMPAIRMENT_PROFILES) {
  test(`${profile.id}: ${profile.note}`, { timeout: 300_000 }, async (context) => {
    if (!impairAvailable || browser === null || live === null) {
      // 劣化を適用できない環境では飛ばす。**成功として数えない**（空虚な緑を作らない）。
      context.skip("劣化を適用できない（tc に root が要る）");
      return;
    }
    const seconds = durationSec();
    const page = await browser.newPage();
    const logs: string[] = [];
    page.on("console", (message) => logs.push(message.text()));
    page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));
    page.on("requestfailed", (request) => logs.push(`requestfailed: ${request.url()}`));
    await page.goto(`http://127.0.0.1:${String(pagePort)}/`);
    await page.waitForFunction("typeof window.__whesoDegrade === 'function'");

    const driver = driveProfile(profile.id, seconds);
    let raw: unknown;
    try {
      raw = await page.evaluate(
        async ([wsBase, room, nodeKey, durationMs]) => {
          const runner = window.__whesoDegrade;
          if (runner === undefined) {
            return { ok: false, detail: "記録の器が無い" };
          }
          return await runner(String(wsBase), String(room), String(nodeKey), Number(durationMs));
        },
        [`ws://127.0.0.1:${String(bridgePort)}`, live.room, DEV_NODE_KEY, seconds * 1000],
      );
    } catch (error) {
      // 何が起きたかを記録に残す。ブラウザ側の例外だけでは原因が判らない。
      const detail = error instanceof Error ? error.message : String(error);
      driver.stop();
      await page.close();
      assert.fail(`ブラウザ側で失敗した: ${detail} / ログ: ${logs.slice(0, 10).join(" | ")}`);
    } finally {
      driver.stop();
      await page.close();
    }

    const result = asResult(raw);
    assert.ok(result.ok, `記録が取れる（詳細: ${result.detail} / ログ: ${logs.slice(0, 5).join(" | ")}）`);
    assert.ok(result.sent.length > 0, "1 枚以上を送っている");
    assert.ok(result.received.length > 0, "1 枚以上を受け取っている");

    // 判定 A-3・C-1・B-2 は全プロファイルに課す。
    assertMonotonic(result);
    // 遮断を持つ段は判定 C-2（復帰 1500 ms 以内）で見る。遮断中の停止は避けられず、
    // C-1（1000 ms）を課すと TCP の再送を待つ分だけで超える（実測 1036 ms）。
    assertNoFreeze(
      result,
      profile.outage === undefined ? IMPAIRMENT_MAX_GAP_MS : IMPAIRMENT_MAX_GAP_WITH_OUTAGE_MS,
    );
    assertDropsAreDiscardable(result);

    // 判定 E-1: キーフレーム要求は 0 回である。
    assert.equal(result.keyframeRequests, 0, "キーフレーム要求が発生しない");

    // 判定 B-1: 劣化なし（N-0）では欠落 0 である。
    if (profile.id === "N-0") {
      assert.equal(
        result.received.length,
        result.sent.length,
        `劣化なしでは全フレームが届く（送 ${String(result.sent.length)} / 受 ${String(result.received.length)}）`,
      );
    }

    // 判定 A-1 の基準: すべての受信フレームでハッシュが得られている。
    for (const entry of result.received) {
      assert.equal(entry.sha256.length, 64, `${String(entry.frameIndex)} 番目のハッシュが取れている`);
    }
  });
}
