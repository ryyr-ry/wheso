/**
 * リンク（1 部屋への接続の管理）の配線を検証する（段 F の F-6）。
 *
 * **これが無いと再接続も予備接続も実行経路上に存在しない。** 段 F まで、接続状態機械
 * （9 状態 22 遷移）は試験の中でだけ動いており、入口から読み込まれていなかった。
 *
 * 検証する性質:
 *   1. 開くと `hello` を送り、`helloAck` で `ACTIVE` になる
 *   2. `ACTIVE` へ入るときに `streamAnnounce` と **`subscribe`** を送る（ADR-0032）
 *   3. 回復可能なコードで切れるとバックオフ後に再接続し、**購読を送り直す**
 *   4. 回復不可のコードでは再接続しない
 *   5. 接続確立前の送信は溜めて、開いたときに送る
 *   6. メディアは受信経路へ渡る
 *   7. 経路が切れたら不連続を伝える（再生クロックの対応付けを作り直させる）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createLink, type LinkDeps, type LinkSocket } from "../packages/client/src/api/link.ts";
import { RECONNECT_BACKOFF_MS } from "../packages/core/src/generated/constants.ts";
import { ERROR_DEFINITIONS } from "../packages/core/src/generated/errors.ts";

interface FakeSocket extends LinkSocket {
  readonly sent: string[];
  readonly fireOpen: () => void;
  readonly fireClose: (code: number) => void;
  readonly fireText: (text: string) => void;
  readonly fireBinary: (bytes: Uint8Array) => void;
  readonly closed: () => boolean;
}

function fakeSocket(): FakeSocket {
  const sent: string[] = [];
  let openHandler: (() => void) | null = null;
  let closeHandler: ((code: number) => void) | null = null;
  let textHandler: ((text: string) => void) | null = null;
  let binaryHandler: ((bytes: Uint8Array) => void) | null = null;
  let isClosed = false;
  return {
    sent,
    send: (text): void => {
      sent.push(text);
    },
    sendBinary: (): void => undefined,
    close: (): void => {
      isClosed = true;
    },
    onText: (handler): void => {
      textHandler = handler;
    },
    onBinary: (handler): void => {
      binaryHandler = handler;
    },
    onOpen: (handler): void => {
      openHandler = handler;
    },
    onClose: (handler): void => {
      closeHandler = handler;
    },
    fireOpen: (): void => openHandler?.(),
    fireClose: (code): void => closeHandler?.(code),
    fireText: (text): void => textHandler?.(text),
    fireBinary: (bytes): void => binaryHandler?.(bytes),
    bufferedBytes: (): number => 0,
    closed: (): boolean => isClosed,
  };
}

interface Harness {
  readonly deps: LinkDeps;
  readonly sockets: FakeSocket[];
  readonly media: Uint8Array[];
  readonly warns: string[];
  readonly fails: number[];
  readonly routeChanges: { count: number };
  readonly clock: { ms: number };
  readonly timers: { atMs: number; fire: () => void }[];
  /** 予約された時刻まで進めて発火させる。 */
  readonly advanceTo: (atMs: number) => void;
}

function harness(options: { readonly usesStandby?: boolean } = {}): Harness {
  const sockets: FakeSocket[] = [];
  const media: Uint8Array[] = [];
  const warns: string[] = [];
  const fails: number[] = [];
  const routeChanges = { count: 0 };
  const clock = { ms: 1000 };
  const timers: { atMs: number; fire: () => void }[] = [];

  const deps: LinkDeps = {
    openSocket: (): LinkSocket | null => {
      const created = fakeSocket();
      sockets.push(created);
      return created;
    },
    now: (): number => clock.ms,
    scheduleAt: (atMs, fire): (() => void) => {
      const entry = { atMs, fire };
      timers.push(entry);
      return (): void => {
        const index = timers.indexOf(entry);
        if (index >= 0) {
          timers.splice(index, 1);
        }
      };
    },
    helloText: (): string => JSON.stringify({ t: "hello" }),
    announceText: (): string => JSON.stringify({ t: "streamAnnounce", streams: [] }),
    subscribeText: (): string => JSON.stringify({ t: "subscribe", entries: [] }),
    onMedia: (bytes): void => {
      media.push(bytes);
    },
    onText: (): void => {
      // 内容の解釈は入口の責務である。
    },
    onWarn: (code): void => {
      warns.push(code);
    },
    onFail: (code): void => {
      fails.push(code);
    },
    onRouteChange: (): void => {
      routeChanges.count += 1;
    },
    usesStandby: options.usesStandby ?? false,
  };

  const advanceTo = (atMs: number): void => {
    clock.ms = atMs;
    const due = timers.filter((entry) => entry.atMs <= atMs);
    for (const entry of due) {
      const index = timers.indexOf(entry);
      if (index >= 0) {
        timers.splice(index, 1);
      }
      entry.fire();
    }
  };

  return { deps, sockets, media, warns, fails, routeChanges, clock, timers, advanceTo };
}

function messageKinds(sent: readonly string[]): readonly string[] {
  return sent.map((text) => {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      return "?";
    }
    const record: Record<string, unknown> = { ...parsed };
    return typeof record["t"] === "string" ? record["t"] : "?";
  });
}

/* ------------------------------------------------------------------------- */

test("開くと hello を送り、helloAck で ACTIVE になる", () => {
  const h = harness();
  const link = createLink(h.deps);
  link.open();
  assert.equal(link.phase(), "CONNECTING");
  const socket = h.sockets[0];
  assert.ok(socket !== undefined);
  socket.fireOpen();
  assert.equal(link.phase(), "HELLO_SENT");
  assert.deepEqual(messageKinds(socket.sent), ["hello"]);
  socket.fireText(JSON.stringify({ t: "helloAck" }));
  assert.equal(link.phase(), "ACTIVE");
});

test("**ACTIVE へ入るときに streamAnnounce と subscribe を送る**（ADR-0032）", () => {
  const h = harness();
  const link = createLink(h.deps);
  link.open();
  const socket = h.sockets[0];
  assert.ok(socket !== undefined);
  socket.fireOpen();
  socket.fireText(JSON.stringify({ t: "helloAck" }));
  assert.deepEqual(messageKinds(socket.sent), ["hello", "streamAnnounce", "subscribe"]);
});

test("**回復可能なコードで切れると再接続し、購読を送り直す**", () => {
  const h = harness();
  const link = createLink(h.deps);
  link.open();
  const first = h.sockets[0];
  assert.ok(first !== undefined);
  first.fireOpen();
  first.fireText(JSON.stringify({ t: "helloAck" }));

  // 回復可能なコードで切る。
  first.fireClose(ERROR_DEFINITIONS.E_WIRE_TOO_LARGE.closeCode);
  assert.equal(link.phase(), "RECONNECT_WAIT");
  assert.equal(h.routeChanges.count, 1, "経路が切れたことを伝える");

  // バックオフの満了で再接続する。
  const backoff = RECONNECT_BACKOFF_MS[0] ?? 500;
  h.advanceTo(h.clock.ms + backoff);
  assert.equal(link.phase(), "CONNECTING");
  const second = h.sockets[1];
  assert.ok(second !== undefined, "新しいソケットを開く");
  second.fireOpen();
  second.fireText(JSON.stringify({ t: "helloAck" }));
  assert.equal(link.phase(), "ACTIVE");
  assert.deepEqual(
    messageKinds(second.sent),
    ["hello", "streamAnnounce", "subscribe"],
    "**購読を送り直す。送らないと無音の黒画面になる**",
  );
  assert.equal(link.connects(), 2);
});

test("回復不可のコードでは再接続しない", () => {
  const h = harness();
  const link = createLink(h.deps);
  link.open();
  const socket = h.sockets[0];
  assert.ok(socket !== undefined);
  socket.fireOpen();
  socket.fireText(JSON.stringify({ t: "helloAck" }));
  socket.fireClose(ERROR_DEFINITIONS.E_AUTH.closeCode);
  assert.equal(link.phase(), "FAILED");
  assert.deepEqual(h.fails, [ERROR_DEFINITIONS.E_AUTH.closeCode]);
  assert.equal(h.sockets.length, 1, "再接続しない");
});

test("利用者の明示操作で FAILED から復帰する", () => {
  const h = harness();
  const link = createLink(h.deps);
  link.open();
  const socket = h.sockets[0];
  assert.ok(socket !== undefined);
  socket.fireOpen();
  socket.fireText(JSON.stringify({ t: "helloAck" }));
  socket.fireClose(ERROR_DEFINITIONS.E_AUTH.closeCode);
  link.open();
  assert.equal(link.phase(), "CONNECTING");
  assert.equal(h.sockets.length, 2);
});

test("**`ACTIVE` へ入るまで制御メッセージを送らない**（溜めて後で送る）", () => {
  const h = harness();
  const link = createLink(h.deps);
  link.open();
  link.send(JSON.stringify({ t: "displaySize" }));
  const socket = h.sockets[0];
  assert.ok(socket !== undefined);
  assert.equal(socket.sent.length, 0, "接続前は送らない");
  socket.fireOpen();
  assert.equal(
    messageKinds(socket.sent).includes("displaySize"),
    false,
    "**開いただけでは送らない。** hello の応答を待っている間に別のメッセージを送ると、"
      + "受け取ったノードが「最初の 1 通は hello」の前提で解析して失敗し接続を閉じる"
      + "（実測: 受信部屋が report を hello と解釈してクローズコード 4020 で切った）",
  );
  assert.ok(messageKinds(socket.sent).includes("hello"), "hello は送る");
  socket.fireText(JSON.stringify({ t: "helloAck" }));
  assert.ok(messageKinds(socket.sent).includes("displaySize"), "ACTIVE へ入ったら溜めた分を送る");
});

test("メディアは受信経路へ渡る", () => {
  const h = harness();
  const link = createLink(h.deps);
  link.open();
  const socket = h.sockets[0];
  assert.ok(socket !== undefined);
  socket.fireOpen();
  socket.fireText(JSON.stringify({ t: "helloAck" }));
  socket.fireBinary(new Uint8Array([1, 2, 3]));
  assert.equal(h.media.length, 1);
  assert.deepEqual([...(h.media[0] ?? [])], [1, 2, 3]);
});

test("受信側の部屋は予備接続を持ち、送信側は持たない", () => {
  const withStandby = harness({ usesStandby: true });
  const link = createLink(withStandby.deps);
  link.open();
  const socket = withStandby.sockets[0];
  assert.ok(socket !== undefined);
  socket.fireOpen();
  socket.fireText(JSON.stringify({ t: "helloAck" }));
  assert.equal(withStandby.sockets.length, 2, "主接続と予備接続の 2 本を開く");

  const without = harness({ usesStandby: false });
  const plain = createLink(without.deps);
  plain.open();
  const only = without.sockets[0];
  assert.ok(only !== undefined);
  only.fireOpen();
  only.fireText(JSON.stringify({ t: "helloAck" }));
  assert.equal(without.sockets.length, 1, "送信側は予備を持たない");
});

test("close() で閉じ、以後は何も起きない", () => {
  const h = harness();
  const link = createLink(h.deps);
  link.open();
  const socket = h.sockets[0];
  assert.ok(socket !== undefined);
  socket.fireOpen();
  socket.fireText(JSON.stringify({ t: "helloAck" }));
  link.close();
  assert.equal(link.phase(), "CLOSED");
  assert.equal(socket.closed(), true);
  link.noteReportTimer();
  assert.equal(link.phase(), "CLOSED", "閉じた後は遷移しない");
});

test("ソケットを開けない場合も例外を投げず再接続を待つ", () => {
  const h = harness();
  const failing: LinkDeps = { ...h.deps, openSocket: (): LinkSocket | null => null };
  const link = createLink(failing);
  link.open();
  assert.equal(link.phase(), "RECONNECT_WAIT");
});
