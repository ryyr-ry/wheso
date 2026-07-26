/**
 * 局所実行環境（partykit dev）に対する結合試験（検証階層 L3）。
 *
 * 目的は「単体試験が通ることと、実際の Durable Object 実行環境で動くことは別である」
 * という前提に立ち、実物の WebSocket で転送が成立することを確かめることである。
 *
 * 実行: node --test tests/integration/local-relay.test.ts
 * 起動に時間がかかるため単体試験とは分けている（npm run test:integration）。
 *
 * 検証すること:
 *   1. 中継部屋へ 2 本の WebSocket を張り、購読者へメディアが転送される
 *   2. 要求 tier を超える spatialId は転送されない
 *   3. 形式違反のメディアは接続が閉じられる
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";

import { encodeMediaMessage } from "../../packages/core/src/wire.ts";
import {
  CHANNEL_VIDEO,
  FLAG_DISCARDABLE,
  FLAG_END_OF_FRAME,
  FLAG_KEY,
  WIRE_MAGIC,
} from "../../packages/core/src/generated/wire-layout.ts";

/**
 * 空きポートを 1 個確保する。
 * 固定ポートにすると、前の実行が残っていた場合に衝突して失敗する。
 */
async function findFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

let PORT = 0;
let BASE = "";
let WS_BASE = "";
const ROOM = "vsh-01jxy8kq2r3mz5v7h9abcderfa-auto-1-0";

let server: ChildProcess | null = null;

/** 起動を待つ。主入口の健全性応答が返れば準備完了とする。 */
async function waitForReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/party/main`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        return true;
      }
    } catch {
      // 起動前は接続できない。待って再試行する。
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500).unref();
    });
  }
  return false;
}

before(async () => {
  PORT = await findFreePort();
  BASE = `http://127.0.0.1:${PORT}`;
  WS_BASE = `ws://127.0.0.1:${PORT}`;
  // detached で起動し、終了時にプロセス群ごと落とす。
  // partykit dev は子プロセス（実行環境）を起動するため、親だけ落とすと残る。
  server = spawn("npx", ["partykit", "dev", "--port", String(PORT)], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdio: "ignore",
    detached: true,
  });
  const ready = await waitForReady(90_000);
  assert.equal(ready, true, "partykit dev が起動する");
});

after(() => {
  for (const socket of openSockets) {
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
      socket.close();
    }
  }
  openSockets.length = 0;
  const pid = server?.pid;
  server = null;
  if (pid === undefined) {
    return;
  }
  try {
    // 負の PID はプロセス群を指す。実行環境の子プロセスまで落とす。
    process.kill(-pid, "SIGKILL");
  } catch {
    // 既に終了している場合は何もしない。
  }
});

/** 接続 ID を指定して中継部屋へ繋ぐ。中継ノードは接続 ID を参加者 ID として読む。 */
const openSockets: globalThis.WebSocket[] = [];

function connect(participantId: number): globalThis.WebSocket {
  const socket = new globalThis.WebSocket(`${WS_BASE}/parties/shard/${ROOM}?_pk=${participantId}`);
  // 開いた接続を記録し、試験の終わりに必ず閉じる。
  // 閉じ忘れると実行ループが終わらず、試験プロセスが終了しない。
  openSockets.push(socket);
  return socket;
}

function waitOpen(socket: globalThis.WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("接続に失敗した")), { once: true });
  });
}

/** 次のメッセージを待つ。時限内に来なければ null を返す。 */
function nextMessage(socket: globalThis.WebSocket, timeoutMs: number): Promise<ArrayBuffer | string | null> {
  return new Promise((resolve) => {
    // タイマーが実行ループを掴み続けないようにする。試験の終了を妨げないためである。
    const timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref();
    socket.addEventListener(
      "message",
      (event: MessageEvent<unknown>) => {
        clearTimeout(timer);
        const data = event.data;
        if (data instanceof ArrayBuffer) {
          resolve(data);
          return;
        }
        if (typeof data === "string") {
          resolve(data);
          return;
        }
        if (data instanceof Blob) {
          void data.arrayBuffer().then((buffer) => resolve(buffer));
          return;
        }
        resolve(null);
      },
      { once: true },
    );
  });
}

function mediaBytes(senderId: number, spatialId: number): Uint8Array {
  const encoded = encodeMediaMessage({
    channel: CHANNEL_VIDEO,
    senderId,
    units: [
      {
        sequenceNumber: 1,
        captureTimestampUs: 1_000_000n,
        flags: FLAG_END_OF_FRAME | FLAG_KEY,
        spatialId,
        temporalId: 0,
        payload: new Uint8Array(64),
      },
    ],
  });
  assert.equal(encoded.ok, true);
  return encoded.ok ? encoded.value : new Uint8Array(0);
}

test("実行環境で購読者へメディアが転送される", { timeout: 30_000 }, async () => {
  const subscriber = connect(2);
  const sender = connect(1);
  subscriber.binaryType = "arraybuffer";
  await waitOpen(subscriber);
  await waitOpen(sender);

  subscriber.send(
    JSON.stringify({
      t: "subscribe",
      entries: [{ senderId: 1, channel: CHANNEL_VIDEO, maxSpatialId: 3, maxTemporalId: 7 }],
    }),
  );
  // 購読の登録が処理される猶予を置く。
  await new Promise((resolve) => setTimeout(resolve, 300));

  const bytes = mediaBytes(1, 0);
  sender.send(bytes);

  const received = await nextMessage(subscriber, 5000);
  assert.ok(received instanceof ArrayBuffer, "バイナリが届く");
  assert.equal(
    received instanceof ArrayBuffer ? received.byteLength : 0,
    bytes.length,
    "メッセージ全体が届く",
  );
  subscriber.close();
  sender.close();
});

test("実行環境で tier を超える spatialId は転送されない", { timeout: 30_000 }, async () => {
  const subscriber = connect(4);
  const sender = connect(3);
  subscriber.binaryType = "arraybuffer";
  await waitOpen(subscriber);
  await waitOpen(sender);

  subscriber.send(
    JSON.stringify({
      t: "subscribe",
      entries: [{ senderId: 3, channel: CHANNEL_VIDEO, maxSpatialId: 0, maxTemporalId: 7 }],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));

  sender.send(mediaBytes(3, 3));
  const received = await nextMessage(subscriber, 2000);
  assert.equal(received, null, "tier 超過は届かない");
  subscriber.close();
  sender.close();
});

test("実行環境で形式違反のメディアは接続が閉じられる", { timeout: 30_000 }, async () => {
  const sender = connect(5);
  await waitOpen(sender);
  const closed = new Promise<number>((resolve) => {
    sender.addEventListener("close", (event: CloseEvent) => resolve(event.code), { once: true });
    setTimeout(() => resolve(-1), 5000).unref();
  });
  sender.send(new Uint8Array([WIRE_MAGIC ^ 0xff, 1, CHANNEL_VIDEO, 1, 0, 0, 0, 1]));
  const code = await closed;
  assert.notEqual(code, -1, "閉じられる");
  assert.ok(code >= 4000, `プロトコル違反のコードで閉じる（実際 ${code}）`);
});

void FLAG_DISCARDABLE;
