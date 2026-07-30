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
  joinWith,
  type JoinSocket,
} from "../../packages/client/src/api/join-meeting.ts";
import type { FrameSink } from "../../packages/client/src/api/meeting.ts";

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

function sink(): FrameSink {
  return {
    attach: (): void => undefined,
    detach: (): void => undefined,
    setDisplaySize: (): void => undefined,
    draw: (): void => undefined,
  };
}

/**
 * 実物の WebSocket を `JoinSocket` の形に包む。送信は接続確立まで溜める。
 *
 * `received` に届いたテキストをすべて記録する。**記録しないと判定が空洞になる。**
 * 以前はこの引数が無く、判定は常に空の配列を検査していたため必ず失敗していた。
 */
function realSocket(url: string, closeCodes: number[], received: string[] = []): JoinSocket {
  const socket = new globalThis.WebSocket(url);
  openSockets.push(socket);
  socket.binaryType = "arraybuffer";
  const pending: string[] = [];
  let open = false;
  const handlers: ((text: string) => void)[] = [];
  const binaryHandlers: ((bytes: Uint8Array) => void)[] = [];
  const openHandlers: (() => void)[] = [];
  const closeHandlers: ((code: number) => void)[] = [];
  socket.addEventListener("open", () => {
    open = true;
    for (const text of pending) {
      socket.send(text);
    }
    pending.length = 0;
    for (const handler of openHandlers) {
      handler();
    }
  });
  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data === "string") {
      received.push(event.data);
      for (const handler of handlers) {
        handler(event.data);
      }
      return;
    }
    if (event.data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(event.data);
      for (const handler of binaryHandlers) {
        handler(bytes);
      }
    }
  });
  socket.addEventListener("close", (event: CloseEvent) => {
    closeCodes.push(event.code);
    for (const handler of closeHandlers) {
      handler(event.code);
    }
  });
  return {
    send: (text): void => {
      if (open) {
        socket.send(text);
        return;
      }
      pending.push(text);
    },
    sendBinary: (bytes): void => socket.send(bytes),
    close: (): void => socket.close(),
    onText: (handler): void => {
      handlers.push(handler);
    },
    onBinary: (handler): void => {
      binaryHandlers.push(handler);
    },
    onOpen: (handler): void => {
      openHandlers.push(handler);
    },
    onClose: (handler): void => {
      closeHandlers.push(handler);
    },
    bufferedBytes: (): number => socket.bufferedAmount,
  };
}

test("参加 URL から 5 個の部屋へ接続し helloAck で active になる", async () => {
  const closeCodes: number[] = [];
  const received: string[] = [];
  const url = await joinUrlFor(USER_ID);
  const joined = await joinWith(url, {
    openSocket: (address) => realSocket(address, closeCodes, received),
    createSink: () => sink(),
    bindOutput: (): void => undefined,
    capability: { hardwareAv1For4K60: false, encodeAv1: true, mobile: false, charging: true },
    scheduleAt: (atMs: number, fire: () => void): (() => void) => {
      const timer = globalThis.setTimeout(fire, Math.max(0, atMs - Date.now()));
      return (): void => globalThis.clearTimeout(timer);
    },
    setPeriodic: (intervalMs: number, fire: () => void): (() => void) => {
      const timer = globalThis.setInterval(fire, intervalMs);
      return (): void => globalThis.clearInterval(timer);
    },
    // 取得と符号化は Node に無い。この試験は参加とリンクの到達を確かめる。
    capture: {
      bindCapture: (): void => undefined,
      startCapture: async () => ({ source: null, video: false, audio: false }),
      configureVideo: (): void => undefined,
      configureAudio: (): void => undefined,
      requestKeyframe: (): void => undefined,
      setVideoEnabled: (): void => undefined,
      setAudioEnabled: (): void => undefined,
      encodeQueueSize: (): number => 0,
      close: (): void => undefined,
    },
    media: {
      configureDecoder: (): void => undefined,
      resetDecoder: (): void => undefined,
      closeDecoder: (): void => undefined,
      decodeVideo: (): void => undefined,
      enqueueAudio: (): void => undefined,
    },
    // はしごは源から導出する（ADR-0026）。
    source: { width: 1920, height: 1080, framerate: 30 },
    now: () => Date.now(),
  });
  assert.equal(joined.ok, true, "参加できる");
  if (!joined.ok) {
    return;
  }
  assert.equal(joined.value.links.size, 5, "5 個の部屋へリンクを張る");

  const deadline = Date.now() + 30_000;
  while (joined.value.meeting.state !== "active" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(joined.value.meeting.state, "active", "helloAck を受けて active になる");
  assert.ok(
    received.some((text) => text.includes('"t":"helloAck"')),
    `ctl 部屋が helloAck を返す（受信 ${String(received.length)} 件）`,
  );

  // **5 本すべてが ACTIVE へ到達しなければならない。**
  // `ACTIVE` に入らない部屋は `subscribe` と `streamAnnounce` を 1 度も送らない
  // （state-machines.md 1 節。`sendSubscribe` は ACTIVE への遷移でのみ出る）。
  // 到達しない部屋は 9 秒で時限切れになり、以後は無限に再接続を繰り返す。
  const phaseDeadline = Date.now() + 30_000;
  const phases = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [role, link] of joined.value.links) {
      out.set(role, link.phase());
    }
    return out;
  };
  while (Date.now() < phaseDeadline) {
    const current = phases();
    if ([...current.values()].every((phase) => phase === "ACTIVE")) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.deepEqual(
    [...phases().entries()].filter(([, phase]) => phase !== "ACTIVE"),
    [],
    "5 本すべてのリンクが ACTIVE である（helloAck を返さない部屋は再接続を繰り返す）",
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
