/**
 * SDK 経由の実映像 E2E（検証階層 L4）。
 *
 * **何を証明するか。** 公開 API（`joinMeeting`）だけで 2 人が参加し、実際のカメラの
 * トラックを実際の `VideoEncoder`（AV1）で符号化し、実際にデプロイした 5 ノードを通して
 * 実際の `VideoDecoder` で復号できること。**送信ノード・中継ノード・受信ノード・名簿の
 * すべてを通る。**
 *
 * 既存の E2E（`media.test.ts`）は生の WebSocket で中継部屋へ直結する。中継の転送は
 * 確かめられるが SDK の経路は 1 度も通らない。段 F まで、SDK には送信経路が存在せず、
 * 復号したフレームの行き先も無かった（誤解カタログ X-039）。
 *
 * 実行: WHESO_LIVE_HOST=<配備先> npm run test:e2e:sdk
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright";

import { DEV_TOKEN_KEY, liveHost, newMeetingId, startLive } from "../support/live-env.ts";

const MEETING_ID = newMeetingId();
/** 利用者 ID は部屋名の文法に従う（16 進 32 文字。room-naming.md 1 節）。 */
const USER_A = "550e8400e29b41d4a716446655440aaa";
const USER_B = "550e8400e29b41d4a716446655440bbb";
const root = new URL("../..", import.meta.url).pathname;

let host = "";
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

before(async () => {
  pagePort = await findFreePort();
  await startLive();
  host = liveHost();

  const bundled = await build({
    entryPoints: [`${root}/tests/e2e/page/sdk.ts`],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  const file = bundled.outputFiles[0];
  const script = file === undefined ? "" : file.text;
  assert.notEqual(script, "", "SDK の本体を束ねられる");

  // WebCodecs は secure context を要求する。127.0.0.1 は secure context として扱われる。
  pageServer = createServer((request, response) => {
    if (request.url === "/sdk.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(script);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><meta charset="utf-8"><title>wheso sdk e2e</title>' +
        '<script type="module" src="/sdk.js"></script>',
    );
  });
  await new Promise<void>((resolve) => {
    pageServer?.listen(pagePort, "127.0.0.1", () => resolve());
  });

  browser = await chromium.launch({
    args: [
      // **偽のカメラを使う。** CI の実行機にカメラは無い（Q-020）。偽のデバイスは実際の
      // `MediaStreamTrack` を返すため、取得と符号化の経路は本物である。
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
});

interface SdkResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly aParticipants: number;
  readonly bParticipants: number;
  readonly bFrames: number;
  readonly firstFrame: { readonly width: number; readonly height: number } | null;
  readonly aFrames: number;
  readonly aUplinkBps: number;
  readonly bDownlinkBps: number;
  readonly logs: readonly string[];
}

test("SDK 経由で 2 人が実カメラの映像を符号化・転送・復号できる", { timeout: 240_000 }, async () => {
  assert.ok(browser !== null, "ブラウザが起動している");
  const page = await browser.newPage();
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));

  await page.goto(`http://127.0.0.1:${String(pagePort)}/`);
  await page.waitForFunction("typeof window.__whesoSdk === 'function'", undefined, { timeout: 30_000 });

  const raw = await page.evaluate(
    async ([liveHostName, meetingId, tokenKey, userA, userB]) => {
      const runner = window.__whesoSdk;
      if (typeof runner !== "function") {
        return null;
      }
      return await runner(
        String(liveHostName),
        String(meetingId),
        String(tokenKey),
        String(userA),
        String(userB),
        90_000,
      );
    },
    [host, MEETING_ID, DEV_TOKEN_KEY, USER_A, USER_B],
  );

  assert.notEqual(raw, null, `SDK の本体が実行できる（記録: ${logs.join(" | ")}）`);
  const result: SdkResult | null = raw;
  if (result === null) {
    return;
  }
  const report = `${result.detail} / 参加者 A ${String(result.aParticipants)} B ${String(
    result.bParticipants,
  )} / 復号 A ${String(result.aFrames)} B ${String(result.bFrames)} / 上り ${String(
    result.aUplinkBps,
  )} bps / 下り ${String(result.bDownlinkBps)} bps / ページ記録 ${result.logs.join(" | ")} / ${logs
    .slice(0, 10)
    .join(" | ")}`;

  assert.equal(result.aParticipants, 2, `A が 2 人を認識する（${report}）`);
  assert.equal(result.bParticipants, 2, `B が 2 人を認識する（${report}）`);
  // **双方向に復号できること。** 片方向だけでは購読の向きの誤りを見逃す。
  assert.ok(result.bFrames > 0, `B が A の映像を復号できる（${report}）`);
  assert.ok(result.aFrames > 0, `A が B の映像を復号できる（${report}）`);
  assert.notEqual(result.firstFrame, null, `復号したフレームの寸法が読める（${report}）`);
  const size = result.firstFrame;
  if (size !== null) {
    assert.ok(size.width > 0 && size.height > 0, `寸法が正である（${String(size.width)}x${String(size.height)}）`);
  }
  // 上りが 0 なら 1 バイトも送っていない（符号化器が動いていない）。
  assert.ok(result.aUplinkBps > 0, `A が実際に送出している（${report}）`);
  process.stdout.write(`SDK E2E の実測: ${report}\n`);
});
