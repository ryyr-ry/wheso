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
import { judgeAll } from "../support/degrade-judge.ts";

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
  readonly closures: readonly string[];
  readonly durationMs: number;
}

let browser: Browser | null = null;
let pageServer: Server | null = null;
let pagePort = 0;
let bridgePort = 0;
let bridge: { close: () => void } | null = null;
/** N-8 用の 2 本目の終端。参加者ごとに別ポートにすることで劣化を分ける。 */
let bridgePortB = 0;
let bridgeB: { close: () => void } | null = null;
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
  bridgePortB = await findFreePort();
  bridgeB = startBridge(bridgePortB, live.host);

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
  bridgeB?.close();
  bridgeB = null;
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
    closures: Array.isArray(record["closures"])
      ? record["closures"].filter((entry): entry is string => typeof entry === "string")
      : [],
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
function driveProfile(
  profileId: string,
  seconds: number,
  port: number,
): { stop: () => void; failures: () => number; applied: () => number } {
  const profile = IMPAIRMENT_PROFILES.find((entry) => entry.id === profileId);
  if (profile === undefined) {
    throw new Error(`未知のプロファイル: ${profileId}`);
  }
  const startedAt = Date.now();
  let appliedAtSec = -1;
  // 適用の成否を数える。失敗を見逃すと「劣化なしで走って緑」という空洞になる。
  let appliedCount = 0;
  let failureCount = 0;
  const timer = setInterval(() => {
    const elapsedSec = Math.trunc((Date.now() - startedAt) / 1000);
    if (elapsedSec > seconds) {
      return;
    }
    const step = stepAt(profile, elapsedSec);
    if (step !== undefined && step.atSec !== appliedAtSec) {
      appliedAtSec = step.atSec;
      if (applyStep(step, port)) {
        appliedCount += 1;
      } else {
        failureCount += 1;
      }
    }
    const outage = profile.outage;
    if (outage !== undefined && elapsedSec > 0 && elapsedSec % outage.everySec === 0) {
      // 遮断の適用と解除は同期で行う（ここは試験の実行側であり判断コアではない）。
      void (async () => {
        const { outage: applyOutage } = await import("../../tools/impair.ts");
        await applyOutage(outage.durationMs, port);
        const back = stepAt(profile, elapsedSec);
        if (back !== undefined) {
          applyStep(back, port);
        }
      })();
    }
  }, 1000);
  return {
    stop: () => {
      clearInterval(timer);
      clearImpairment();
    },
    failures: () => failureCount,
    applied: () => appliedCount,
  };
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

    // 劣化は**この試験の終端のポートだけ**に掛ける。装置全体に掛けると、ページの配信と
    // Playwright の CDP も同じ制限を受け、劣化ではなく試験系が壊れる（実測）。
    const driver = driveProfile(profile.id, seconds, bridgePort);
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

    // 劣化が実際に適用されたことを先に確かめる。適用に失敗したまま緑になると、
    // 「劣化下でも動いた」という空虚な報告になる。
    assert.equal(driver.failures(), 0, "劣化の適用が失敗していない");
    if (profile.id !== "N-0") {
      assert.ok(driver.applied() > 0, "劣化が少なくとも 1 度適用された");
    }

    const result = asResult(raw);
    assert.ok(result.ok, `記録が取れる（詳細: ${result.detail} / ログ: ${logs.slice(0, 5).join(" | ")}）`);
    assert.ok(result.sent.length > 0, "1 枚以上を送っている");
    assert.ok(result.received.length > 0, "1 枚以上を受け取っている");

    // 判定は共通の純関数で行う（tests/support/degrade-judge.ts）。
    // 遮断を持つ段は C-2（復帰 1500 ms 以内）で見る。遮断中の停止は避けられず、
    // C-1（1000 ms）を課すと TCP の再送を待つ分だけで超える（実測 1036 ms）。
    const violations = judgeAll(result, {
      maxGapMs: profile.outage === undefined ? IMPAIRMENT_MAX_GAP_MS : IMPAIRMENT_MAX_GAP_WITH_OUTAGE_MS,
      // 劣化なしの段だけ欠落 0 を要求する（判定 B-1）。
      requireComplete: profile.id === "N-0",
    });
    assert.deepEqual(
      violations.map((entry) => `${entry.judgement}: ${entry.detail}`),
      [],
      `受入条件の違反が無い（送 ${String(result.sent.length)} / 受 ${String(result.received.length)}` +
        ` / 接続断 ${result.closures.length === 0 ? "なし" : result.closures.join(", ")}）`,
    );
  });
}

/**
 * N-8: 参加者ごとに別々の劣化（受入条件 3.2 の最重要項目）。
 *
 * 何を確かめるか: **悪い回線の 1 人が他の参加者を壊さないこと。** SFU の要件はこれであり、
 * これを検証しない試験は意味を持たない（受入条件 3.2 の注記）。
 *
 * どう分けるか: 参加者ごとに別のポートの終端へ繋ぎ、劣化をポート単位で適用する（ADR-0023）。
 * 参加者 A は劣化なし、参加者 B に N-6（60 秒で 50 Mbps から 1 Mbps へ連続降下）を掛ける。
 */
test("N-8: 参加者ごとに別々の劣化を掛けても、健全な参加者は壊れない", { timeout: 300_000 }, async (context) => {
  if (!impairAvailable || browser === null || live === null) {
    context.skip("劣化を適用できない（tc に root が要る）");
    return;
  }
  const seconds = durationSec();
  const page = await browser.newPage();
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));
  await page.goto(`http://127.0.0.1:${String(pagePort)}/`);
  await page.waitForFunction("typeof window.__whesoIsolation === 'function'");

  // 参加者 B のポートだけを劣化させる。A のポートには何も掛けない。
  const driver = driveProfile("N-6", seconds, bridgePortB);
  let raw: unknown;
  try {
    raw = await page.evaluate(
      async ([baseA, baseB, room, nodeKey, durationMs]) => {
        const runner = window.__whesoIsolation;
        if (runner === undefined) {
          return { participants: [] };
        }
        return await runner(
          [
            { wsBase: String(baseA), senderId: 11 },
            { wsBase: String(baseB), senderId: 12 },
          ],
          String(room),
          String(nodeKey),
          Number(durationMs),
        );
      },
      [
        `ws://127.0.0.1:${String(bridgePort)}`,
        `ws://127.0.0.1:${String(bridgePortB)}`,
        live.room,
        DEV_NODE_KEY,
        seconds * 1000,
      ],
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    driver.stop();
    await page.close();
    assert.fail(`ブラウザ側で失敗した: ${detail} / ログ: ${logs.slice(0, 10).join(" | ")}`);
    return;
  } finally {
    driver.stop();
  }
  await page.close();

  assert.equal(driver.failures(), 0, "劣化の適用が失敗していない");
  assert.ok(driver.applied() > 0, "劣化が少なくとも 1 度適用された");

  const participants = asParticipants(raw);
  assert.equal(participants.length, 2, "2 人ぶんの記録がある");
  const healthy = participants[0];
  const impaired = participants[1];
  assert.ok(healthy !== undefined && impaired !== undefined);

  // 実測を必ず残す。緑のときも数値が見えないと「劣化が効いていたのか」を後から確かめられない。
  process.stdout.write(
    `N-8 の実測: 健全 送 ${String(healthy.sent.length)} / 受 ${String(healthy.received.length)}` +
      `、劣化 送 ${String(impaired.sent.length)} / 受 ${String(impaired.received.length)}` +
      `、劣化側の接続断 ${impaired.closures.length === 0 ? "なし" : impaired.closures.join(", ")}\n`,
  );

  // 劣化した参加者も送受信は成立しているはずである（壊れていたら比較の意味が無い）。
  assert.ok(impaired.sent.length > 0, "劣化した参加者も送信できている");

  // **劣化が実際に劣化側へ効いたこと。** これが無いと「悪い回線の 1 人」が存在せず、
  // N-8 の主張（他の参加者を壊さない）を検証したことにならない。
  // 効き方は 2 通りある。送出待ちが溢れて送信を止める（送信枚数が減る）か、
  // 帯域が足りず転送で捨てられる（受信が送信より少ない）である。
  const fewerSent = impaired.sent.length < healthy.sent.length;
  const droppedInTransit = impaired.received.length < impaired.sent.length;
  assert.ok(
    fewerSent || droppedInTransit,
    `劣化側に劣化の影響が現れている（送 ${String(impaired.sent.length)} 対 健全 ${String(healthy.sent.length)}` +
      ` / 受 ${String(impaired.received.length)}）`,
  );

  // **健全な参加者は無傷であること。** これが N-8 の主張である。
  const violations = judgeAll(healthy, { maxGapMs: IMPAIRMENT_MAX_GAP_MS, requireComplete: true });
  assert.deepEqual(
    violations.map((entry) => `${entry.judgement}: ${entry.detail}`),
    [],
    `健全な参加者に違反が無い（送 ${String(healthy.sent.length)} / 受 ${String(healthy.received.length)}` +
      ` / 劣化側 送 ${String(impaired.sent.length)} / 受 ${String(impaired.received.length)}）`,
  );
});

/** N-8 の記録を型を確かめて読む。 */
function asParticipants(value: unknown): readonly DegradeResult[] {
  if (typeof value !== "object" || value === null) {
    throw new Error("記録が対象でない");
  }
  const record: Record<string, unknown> = { ...value };
  const participants = record["participants"];
  if (!Array.isArray(participants)) {
    throw new Error("参加者の配列が無い");
  }
  return participants.map((entry) => asResult(entry));
}
