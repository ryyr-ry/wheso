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
import { deriveMeetingSecret, nodeAuthTag, nodeAuthTimeWindow } from "../../packages/core/src/auth.ts";
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
/** 部屋名は試験ごとに変える。同じ部屋を使い回すと前の試験の状態が残る。 */
const ROOM_BASE = "vsh-01jxy8kq2r3mz5v7h9abcderfa-auto-1";
function roomFor(index: number): string {
  return `${ROOM_BASE}-${index}`;
}
const ROOM = roomFor(0);

/**
 * 局所実行環境で使う開発用のノード鍵。
 * 本番の鍵は環境の秘密として与える（Q-019）。この値は試験専用であり秘密ではない。
 */
const DEV_NODE_KEY = "wheso-dev-node-key-not-a-secret";

/** 中継部屋へノードとして認証する。認証前のメディアは破棄される（wire-format.md 2.8）。 */
async function sendNodeHello(socket: globalThis.WebSocket, room: string, role: string): Promise<void> {
  const parts = room.split("-");
  const meetingId = parts[1] ?? "";
  const secret = await deriveMeetingSecret(new TextEncoder().encode(DEV_NODE_KEY), meetingId);
  assert.equal(secret.ok, true, "会議シークレットを導出できる");
  if (!secret.ok) {
    return;
  }
  const window = nodeAuthTimeWindow(Math.trunc(Date.now() / 1000));
  const tag = await nodeAuthTag(secret.value, room, role, window);
  assert.equal(tag.ok, true, "authTag を作れる");
  socket.send(JSON.stringify({ t: "nodeHello", role, nodeId: room, authTag: tag.ok ? tag.value : "" }));
}

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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

before(async () => {
  PORT = await findFreePort();
  BASE = `http://127.0.0.1:${PORT}`;
  WS_BASE = `ws://127.0.0.1:${PORT}`;
  // detached で起動し、終了時にプロセス群ごと落とす。
  // partykit dev は子プロセス（実行環境）を起動するため、親だけ落とすと残る。
  server = spawn("npx", ["partykit", "dev", "--port", String(PORT), "--var", `WHESO_NODE_KEY=${DEV_NODE_KEY}`], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdio: "ignore",
    detached: true,
  });
  const ready = await waitForReady(90_000);
  assert.equal(ready, true, "partykit dev が起動する");

  // 主入口が応えても、役割ごとの部屋は初回接続時に組み立てられる。
  // 実際に WebSocket が開くまで待つ。待たないと最初の試験が組み立てを待って時限に達する。
  const socketReady = await waitForSocket(60_000);
  assert.equal(socketReady, true, "中継部屋へ WebSocket が開く");
});

/** 中継部屋へ実際に接続できるまで待つ。 */
async function waitForSocket(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const opened = await new Promise<boolean>((resolve) => {
      const probe = new globalThis.WebSocket(`${WS_BASE}/parties/shard/${ROOM}?_pk=99`);
      const timer = setTimeout(() => {
        probe.close();
        resolve(false);
      }, 5000);
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
    if (opened) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

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

function connect(participantId: number, room: string = ROOM): globalThis.WebSocket {
  const socket = new globalThis.WebSocket(`${WS_BASE}/parties/shard/${room}?_pk=${participantId}`);
  // 開いた接続を記録し、試験の終わりに必ず閉じる。
  // 閉じ忘れると実行ループが終わらず、試験プロセスが終了しない。
  openSockets.push(socket);
  return socket;
}

/**
 * 接続が開くまで再試行する。
 * 局所実行環境は部屋（Durable Object）を初回接続時に組み立てるため、
 * 最初の 1 回が停滞することがある。停滞したら作り直す方が確実である。
 */
async function connectReady(participantId: number, room: string = ROOM): Promise<globalThis.WebSocket> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const socket = connect(participantId, room);
    socket.binaryType = "arraybuffer";
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(true);
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        resolve(false);
      }, { once: true });
    });
    if (opened) {
      return socket;
    }
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`接続が開かない: room=${room} id=${participantId}`);
}

/** 次のメッセージを待つ。時限内に来なければ null を返す。 */
function nextMessage(socket: globalThis.WebSocket, timeoutMs: number): Promise<ArrayBuffer | string | null> {
  return new Promise((resolve) => {
    // このタイマーは「届かないこと」の判定に必要であるため unref してはならない。
    // unref すると実行ループが空になった時点で発火せず、Promise が解決しないまま時限に達する。
    const timer = setTimeout(() => resolve(null), timeoutMs);
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

function mediaBytes(senderId: number, spatialId: number, payloadBytes = 64): Uint8Array {
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
        payload: new Uint8Array(payloadBytes),
      },
    ],
  });
  assert.equal(encoded.ok, true);
  return encoded.ok ? encoded.value : new Uint8Array(0);
}

test("実行環境で購読者へメディアが転送される", { timeout: 60_000 }, async () => {
  const subscriber = await connectReady(2);
  const sender = await connectReady(1);
  await sendNodeHello(sender, ROOM, "sender");

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

test("実行環境で tier を超える spatialId は転送されない", { timeout: 60_000 }, async () => {
  // 「届かないこと」を待ち時間で判定すると不確実になる。
  // 代わりに標識を使う: tier 超過のフレームの直後に tier 内のフレームを送り、
  // 最初に届くメッセージが後者であることを確かめる。前者が転送されていれば先に届く。
  const room = roomFor(1);
  const subscriber = await connectReady(4, room);
  const sender = await connectReady(3, room);
  await sendNodeHello(sender, room, "sender");

  subscriber.send(
    JSON.stringify({
      t: "subscribe",
      entries: [{ senderId: 3, channel: CHANNEL_VIDEO, maxSpatialId: 0, maxTemporalId: 7 }],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));

  // tier 超過（spatialId 3、ペイロード 64 バイト）
  const over = mediaBytes(3, 3, 64);
  // tier 内の標識（spatialId 0、ペイロード 128 バイト）
  const marker = mediaBytes(3, 0, 128);
  assert.notEqual(over.length, marker.length, "長さで区別できる");
  sender.send(over);
  sender.send(marker);

  const received = await nextMessage(subscriber, 10_000);
  assert.ok(received instanceof ArrayBuffer, "標識が届く");
  assert.equal(
    received instanceof ArrayBuffer ? received.byteLength : 0,
    marker.length,
    "最初に届くのは tier 内のフレームである（tier 超過は転送されない）",
  );
  subscriber.close();
  sender.close();
});

test("実行環境で形式違反のメディアは接続が閉じられる", { timeout: 60_000 }, async () => {
  const sender = await connectReady(5, roomFor(2));
  await sendNodeHello(sender, roomFor(2), "sender");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const closed = new Promise<number>((resolve) => {
    sender.addEventListener("close", (event: CloseEvent) => resolve(event.code), { once: true });
    setTimeout(() => resolve(-1), 5000);
  });
  sender.send(new Uint8Array([WIRE_MAGIC ^ 0xff, 1, CHANNEL_VIDEO, 1, 0, 0, 0, 1]));
  const code = await closed;
  assert.notEqual(code, -1, "閉じられる");
  assert.ok(code >= 4000, `プロトコル違反のコードで閉じる（実際 ${code}）`);
});

void FLAG_DISCARDABLE;

test("実行環境で nodeHello なしのメディアは転送されない", { timeout: 60_000 }, async () => {
  // 監査の指摘（重大度 高）「DO 間接続が無認証」への対処を実環境で確かめる。
  // 認証しない送信者のメディアは破棄され、認証した送信者のメディアだけが届く。
  const room = roomFor(3);
  const subscriber = await connectReady(7, room);
  const unauthenticated = await connectReady(6, room);

  subscriber.send(
    JSON.stringify({
      t: "subscribe",
      entries: [
        { senderId: 6, channel: CHANNEL_VIDEO, maxSpatialId: 3, maxTemporalId: 7 },
        { senderId: 8, channel: CHANNEL_VIDEO, maxSpatialId: 3, maxTemporalId: 7 },
      ],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 認証していない接続からの送信（届いてはならない）
  unauthenticated.send(mediaBytes(6, 0, 64));

  // 認証した別の接続からの送信（標識。これが最初に届くべきである）
  const authenticated = await connectReady(8, room);
  await sendNodeHello(authenticated, room, "sender");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const marker = mediaBytes(8, 0, 128);
  authenticated.send(marker);

  const received = await nextMessage(subscriber, 10_000);
  assert.ok(received instanceof ArrayBuffer, "標識が届く");
  assert.equal(
    received instanceof ArrayBuffer ? received.byteLength : 0,
    marker.length,
    "認証していない送信者のメディアは転送されない",
  );
  subscriber.close();
  unauthenticated.close();
  authenticated.close();
});
