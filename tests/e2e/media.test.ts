/**
 * 実映像の E2E 試験（検証階層 L4 の最小形）。
 *
 * 何を証明するか: 実際の映像が、実際の符号化器で符号化され、実際の Durable Object を
 * 通って転送され、実際の復号器で復号でき、画素が送信した模様と一致すること。
 *
 * 構成:
 *   1. 空きポートで `partykit dev` を起動する（認証情報は不要。F-039）
 *   2. E2E の本体（tests/e2e/page/main.ts）を esbuild で束ね、静的に配る
 *   3. Chromium（Playwright）で開き、window.__whesoRun を呼ぶ
 *   4. 結果を検査する
 *
 * カメラは使わない。CI の実行機にカメラは無い。映像は canvas から作る（Q-020）。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright";

const ROOM = "vsh-01jxy8kq2r3mz5v7h9abcderfa-auto-1-0";
const root = new URL("../..", import.meta.url).pathname;

let devServer: ChildProcess | null = null;
let pageServer: Server | null = null;
let browser: Browser | null = null;
let devPort = 0;
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

/** E2E の本体を束ねる。型は esbuild が落とす。 */
async function bundlePage(): Promise<string> {
  const result = await build({
    entryPoints: [`${root}/tests/e2e/page/main.ts`],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  const file = result.outputFiles[0];
  return file === undefined ? "" : file.text;
}

async function waitForDev(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/party/main`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        return true;
      }
    } catch {
      // 起動前は接続できない。
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500).unref();
    });
  }
  return false;
}

before(async () => {
  devPort = await findFreePort();
  pagePort = await findFreePort();

  devServer = spawn("npx", ["partykit", "dev", "--port", String(devPort)], {
    cwd: root,
    stdio: "ignore",
    detached: true,
  });

  const script = await bundlePage();
  assert.notEqual(script, "", "E2E の本体を束ねられる");

  // WebCodecs は secure context を要求する。127.0.0.1 は secure context として扱われる。
  pageServer = createServer((request, response) => {
    if (request.url === "/main.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(script);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><meta charset="utf-8"><title>wheso e2e</title><script type="module" src="/main.js"></script>');
  });
  await new Promise<void>((resolve) => {
    pageServer?.listen(pagePort, "127.0.0.1", () => resolve());
  });

  const ready = await waitForDev(`http://127.0.0.1:${devPort}`, 120_000);
  assert.equal(ready, true, "partykit dev が起動する");

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
  const pid = devServer?.pid;
  devServer = null;
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // 既に終了している場合は何もしない。
    }
  }
});

test("実映像が符号化・転送・復号され、画素が一致する", { timeout: 180_000 }, async () => {
  assert.notEqual(browser, null, "ブラウザが起動している");
  const page = await (browser as Browser).newPage();
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));

  await page.goto(`http://127.0.0.1:${pagePort}/`);
  await page.waitForFunction("typeof window.__whesoRun === 'function'", undefined, { timeout: 30_000 });

  const result = await page.evaluate(
    async ([wsBase, room]) => {
      const run = window.__whesoRun;
      if (run === undefined) {
        return { ok: false, detail: "本体が読み込まれていない" };
      }
      return await run(String(wsBase), String(room));
    },
    [`ws://127.0.0.1:${devPort}`, ROOM],
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
  assert.notEqual(browser, null);
  const page = await (browser as Browser).newPage();
  await page.goto(`http://127.0.0.1:${pagePort}/`);
  await page.waitForFunction("typeof window.__whesoRunNegative === 'function'", undefined, {
    timeout: 30_000,
  });
  const result = await page.evaluate(
    async ([wsBase, room]) => {
      const run = window.__whesoRunNegative;
      if (run === undefined) {
        return { ok: true, detail: "本体が読み込まれていない" };
      }
      return await run(String(wsBase), String(room));
    },
    [`ws://127.0.0.1:${devPort}`, ROOM],
  );
  process.stdout.write(`否定対照の結果: ${JSON.stringify(result)}\n`);
  assert.equal(result.ok, false, "届かない構成では失敗する");
  const record: Record<string, unknown> = { ...result };
  assert.equal(record["framesDecoded"], 0, "復号できるフレームは 0 である");
  await page.close();
});
