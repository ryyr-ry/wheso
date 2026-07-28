/**
 * 参加入口の結合試験（検証階層 L3）。
 *
 * 目的は「単体試験の偽物では、部屋名・トークン・接続経路の食い違いが検出できない」
 * という点を埋めることである。実物の Durable Object（実環境。PartyKit managed）に対して
 * `joinMeeting` を呼び、5 個の部屋へ接続して `helloAck` を受けることを確かめる。
 *
 * 実行: node --test tests/integration/client-join.test.ts
 *
 * 検証すること:
 *   1. 参加 URL から 5 個の部屋へ接続し、ctl 部屋の helloAck で active になる
 *   2. 別人のトークンでは接続が拒否される（否定対照）
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { issueToken } from "../../packages/core/src/auth.ts";
import { DEV_TOKEN_KEY, startLive } from "../support/live-env.ts";
import {
  applyControlMessage,
  joinWith,
  type JoinSocket,
} from "../../packages/client/src/api/join-meeting.ts";
import type { VideoSinkHandle } from "../../packages/client/src/api/meeting.ts";

const MEETING_ID = "01jxy8kq2r3mz5v7h9abcderfa";
const USER_ID = "550e8400e29b41d4a716446655440000";
const OTHER_USER_ID = "550e8400e29b41d4a716446655440001";

let BASE = "";
let WS_BASE = "";
const openSockets: globalThis.WebSocket[] = [];

before(async () => {
  // デプロイし、接続できる状態になるまで待つ。実環境に対して試験する理由は
  // tests/support/live-env.ts の冒頭にある。
  const live = await startLive();
  BASE = live.httpBase;
  WS_BASE = live.wsBase;
});

after(() => {
  // 実環境は落とさない（デプロイしたノードは残る）。開いた接続だけを閉じる。
  for (const socket of openSockets) {
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
      socket.close();
    }
  }
  openSockets.length = 0;
});

/** 実物の署名を持つトークンを作る。有効期間は規範の上限（60 秒）に従う。 */
async function tokenFor(userId: string): Promise<Awaited<ReturnType<typeof issueToken>>> {
  const nowSec = Math.trunc(Date.now() / 1000);
  return await issueToken(new TextEncoder().encode(DEV_TOKEN_KEY), {
    iss: "wheso-test",
    sub: userId,
    aud: MEETING_ID,
    iat: nowSec,
    exp: nowSec + 60,
    jti: `j-${String(nowSec)}-${userId.slice(0, 4)}`,
    kind: "client",
    role: "host",
  });
}

/** 参加 URL を作る。トークンは実物の署名を持つ（全ノードが検証する）。 */
async function joinUrlFor(userId: string): Promise<string> {
  const token = await tokenFor(userId);
  assert.equal(token.ok, true, "トークンを発行できる");
  return `${BASE}/j/${MEETING_ID}#${token.ok ? token.value : ""}`;
}

function sink(): VideoSinkHandle {
  return {
    attach: (): void => undefined,
    detach: (): void => undefined,
    setDisplaySize: (): void => undefined,
  };
}

/** 実物の WebSocket を `JoinSocket` の形に包む。送信は接続確立まで溜める。 */
function realSocket(url: string, closeCodes: number[]): JoinSocket {
  const socket = new globalThis.WebSocket(url);
  openSockets.push(socket);
  const pending: string[] = [];
  let open = false;
  const handlers: ((text: string) => void)[] = [];
  socket.addEventListener("open", () => {
    open = true;
    for (const text of pending) {
      socket.send(text);
    }
    pending.length = 0;
  });
  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") {
      return;
    }
    for (const handler of handlers) {
      handler(event.data);
    }
  });
  socket.addEventListener("close", (event: CloseEvent) => {
    closeCodes.push(event.code);
  });
  return {
    send: (text): void => {
      if (open) {
        socket.send(text);
        return;
      }
      pending.push(text);
    },
    close: (): void => socket.close(),
    onText: (handler): void => {
      handlers.push(handler);
    },
  };
}

test("参加 URL から 5 個の部屋へ接続し helloAck で active になる", async () => {
  const closeCodes: number[] = [];
  const received: string[] = [];
  const url = await joinUrlFor(USER_ID);
  const joined = await joinWith(url, {
    openSocket: (address) => realSocket(address, closeCodes),
    createSink: () => sink(),
    capability: { hardwareAv1For4K60: false, encodeAv1: true, mobile: false, charging: true },
    now: () => Date.now(),
  });
  assert.equal(joined.ok, true, "参加できる");
  if (!joined.ok) {
    return;
  }
  assert.equal(joined.value.sockets.size, 5, "5 個の部屋へ接続する");

  // ctl 部屋の応答を待つ。入口が配線した経路とは別に、試験でも内容を確かめる。
  const control = joined.value.sockets.get("ctl");
  assert.notEqual(control, undefined);
  control?.onText((text) => {
    received.push(text);
    applyControlMessage(joined.value.meeting, text, Date.now());
  });

  const deadline = Date.now() + 30_000;
  while (joined.value.meeting.state !== "active" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(joined.value.meeting.state, "active", "helloAck を受けて active になる");
  assert.ok(
    received.some((text) => text.includes('"t":"helloAck"')),
    "ctl 部屋が helloAck を返す",
  );
  joined.value.meeting.leave();
});

test("他人の部屋へは接続できない（否定対照）", async () => {
  // 自分のトークンで、他人の利用者 ID の部屋名へ接続を試みる。
  // 部屋名の認可は (aud, sub) から導出できるかで判定される（auth.md 3.4）。
  const token = await tokenFor(USER_ID);
  assert.equal(token.ok, true);
  const room = `ctl-${MEETING_ID}-${OTHER_USER_ID}`;
  const socket = new globalThis.WebSocket(`${WS_BASE}/parties/control/${room}`);
  openSockets.push(socket);
  const closed = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => resolve(0), 20_000);
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          t: "hello",
          protocolVersion: 1,
          token: token.ok ? token.value : "",
          senderId: 12345,
          capabilities: { platform: "browser" },
        }),
      );
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      clearTimeout(timer);
      resolve(event.code);
    });
  });
  assert.notEqual(closed, 0, "接続が閉じられる");
  assert.ok(closed >= 4000 && closed < 5000, `認証系のクローズコードで閉じる（実際 ${closed}）`);
});
