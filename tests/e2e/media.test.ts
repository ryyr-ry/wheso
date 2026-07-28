/**
 * 実映像の E2E 試験（検証階層 L4 の最小形）。
 *
 * 何を証明するか: 実際の映像が、実際の符号化器で符号化され、実際の Durable Object を
 * 通って転送され、実際の復号器で復号でき、画素が送信した模様と一致すること。
 *
 * 構成:
 *   1. 現在のコードを**実環境**（PartyKit managed）へデプロイする
 *   2. E2E の本体（tests/e2e/page/main.ts）を esbuild で束ね、局所の口から静的に配る
 *   3. Chromium（Playwright）で開き、window.__whesoRun を呼ぶ。**繋ぐ先は実環境**である
 *   4. 結果を検査する
 *
 * 局所実行環境（partykit dev）は使わない。理由は tests/support/live-env.ts の冒頭にある。
 * ブラウザは wss で実環境へ直に繋ぐ（TLS の終端は要らない）。
 *
 * カメラは使わない。CI の実行機にカメラは無い。映像は canvas から作る（Q-020）。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright";

import { DEV_NODE_KEY, newMeetingId, startLive } from "../support/live-env.ts";

/**
 * 部屋名は実行ごとに新しくする。実環境の Durable Object は試験の後も生き続けるため、
 * 固定名を使い回すと前回の購読と送信者の登録が残り、結果が変わる。
 */
const MEETING_ID = newMeetingId();
const ROOM = `vsh-${MEETING_ID}-auto-1-0`;
/** 音声の中継部屋。映像とは別の経路を通る（ADR-0005）。 */
const AUDIO_ROOM = `ash-${MEETING_ID}-auto-1-0`;
const root = new URL("../..", import.meta.url).pathname;

let wsBase = "";
let pageServer: Server | null = null;
let browser: Browser | null = null;
let pagePort = 0;

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

/** E2E の本体を束ねる。型は esbuild が落とす。入口ごとに 1 回呼ぶ。 */
async function bundleEntry(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [`${root}/tests/e2e/page/${entry}`],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  const file = result.outputFiles[0];
  return file === undefined ? "" : file.text;
}

before(async () => {
  pagePort = await findFreePort();

  // デプロイし、部屋が開くまで待つ。ブラウザはここへ wss で直に繋ぐ。
  const live = await startLive();
  wsBase = live.wsBase;

  const videoScript = await bundleEntry("main.ts");
  const audioScript = await bundleEntry("audio.ts");
  assert.notEqual(videoScript, "", "映像の本体を束ねられる");
  assert.notEqual(audioScript, "", "音声の本体を束ねられる");

  // WebCodecs は secure context を要求する。127.0.0.1 は secure context として扱われる。
  pageServer = createServer((request, response) => {
    if (request.url === "/main.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(videoScript);
      return;
    }
    if (request.url === "/audio.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(audioScript);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><meta charset="utf-8"><title>wheso e2e</title>' +
        '<script type="module" src="/main.js"></script>' +
        '<script type="module" src="/audio.js"></script>',
    );
  });
  await new Promise<void>((resolve) => {
    pageServer?.listen(pagePort, "127.0.0.1", () => resolve());
  });


  browser = await chromium.launch({
    args: [
      // カメラは無いため偽のデバイスを許すが、映像は canvas から作るため実際には使わない。
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
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
  // 実環境は落とさない（デプロイしたノードは残る）。
});

test("実映像が符号化・転送・復号され、画素が一致する", { timeout: 180_000 }, async () => {
  assert.ok(browser !== null, "ブラウザが起動している");
  const page = await browser.newPage();
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));

  await page.goto(`http://127.0.0.1:${pagePort}/`);
  await page.waitForFunction("typeof window.__whesoRun === 'function'", undefined, { timeout: 30_000 });

  const result = await page.evaluate(
    async ([wsBase, room, nodeKey]) => {
      const run = window.__whesoRun;
      if (run === undefined) {
        return { ok: false, detail: "本体が読み込まれていない" };
      }
      return await run(String(wsBase), String(room), String(nodeKey));
    },
    [wsBase, ROOM, DEV_NODE_KEY],
  );

  assert.equal(
    result.ok,
    true,
    `E2E が成功する（詳細: ${JSON.stringify(result)} / ログ: ${logs.join(" | ")}）`,
  );
  // 何をどれだけ通したかを残す。数を確かめないと「動いた」と言えない。
  process.stdout.write(`E2E 結果: ${JSON.stringify(result)}\n`);
  const record: Record<string, unknown> = { ...result };
  const sent = record["framesSent"];
  const decoded = record["framesDecoded"];
  assert.ok(typeof sent === "number" && sent >= 10, `符号化して送ったフレームが 10 枚以上（実際 ${String(sent)}）`);
  assert.ok(
    typeof decoded === "number" && decoded >= 10,
    `復号できたフレームが 10 枚以上（実際 ${String(decoded)}）`,
  );
  await page.close();
});

test("否定対照: 購読していない送信者の映像は届かず、検査が失敗する", { timeout: 180_000 }, async () => {
  // 目的: 上の試験が「常に成功する空の検査」でないことを示す。
  // 転送されない構成では復号できるフレームが 0 になり、検査が失敗しなければならない。
  assert.ok(browser !== null);
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${pagePort}/`);
  await page.waitForFunction("typeof window.__whesoRunNegative === 'function'", undefined, {
    timeout: 30_000,
  });
  const result = await page.evaluate(
    async ([wsBase, room, nodeKey]) => {
      const run = window.__whesoRunNegative;
      if (run === undefined) {
        return { ok: true, detail: "本体が読み込まれていない" };
      }
      return await run(String(wsBase), String(room), String(nodeKey));
    },
    [wsBase, ROOM, DEV_NODE_KEY],
  );
  process.stdout.write(`否定対照の結果: ${JSON.stringify(result)}\n`);
  assert.equal(result.ok, false, "届かない構成では失敗する");
  const record: Record<string, unknown> = { ...result };
  assert.equal(record["framesDecoded"], 0, "復号できるフレームは 0 である");
  await page.close();
});

test("実音声が Opus で符号化・束ね・転送・復号され、波形が戻る", { timeout: 180_000 }, async () => {
  assert.ok(browser !== null);
  const page = await browser.newPage();
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));

  await page.goto(`http://127.0.0.1:${pagePort}/`);
  await page.waitForFunction("typeof window.__whesoAudioRun === 'function'", undefined, { timeout: 30_000 });

  const result = await page.evaluate(
    async ([wsBase, room, nodeKey]) => {
      const run = window.__whesoAudioRun;
      if (run === undefined) {
        return { ok: false, detail: "本体が読み込まれていない" };
      }
      return await run(String(wsBase), String(room), String(nodeKey));
    },
    [wsBase, AUDIO_ROOM, DEV_NODE_KEY],
  );

  process.stdout.write(`音声 E2E 結果: ${JSON.stringify(result)}\n`);
  assert.equal(result.ok, true, `音声 E2E が成功する（詳細: ${JSON.stringify(result)} / ログ: ${logs.join(" | ")}）`);
  const record: Record<string, unknown> = { ...result };
  assert.ok(
    typeof record["packetsDecoded"] === "number" && record["packetsDecoded"] >= 10,
    `復号できたパケットが 10 個以上（実際 ${String(record["packetsDecoded"])}）`,
  );
  await page.close();
});
