/**
 * ブラウザを使う試験の共通の足場。
 *
 * **なぜ 1 箇所へ集めるか。** 段 D の器・SDK の E2E・実映像の E2E がそれぞれ同じ
 * 「空きポートを取る／TLS を終端する／ページを束ねて配る」を持っていた。口が 3 つあると
 * 必ず 1 つが古くなる（実測: 終端の Host 書き換えの修正が 1 箇所にしか入っておらず、
 * 別の試験だけが「WebSocket を開けない」で落ちた）。
 *
 * TLS を終端する理由: 劣化（`tc`）はループバックへ適用する。ブラウザは局所の口へ繋ぎ、
 * 終端が実環境へ TLS で繋ぎ直す。SFU の処理は実環境の Durable Object が行う。
 */

import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { build } from "esbuild";
import { createShaper, type ShapeState, type ShapeStats } from "./link-shaper.ts";

const root = new URL("../..", import.meta.url).pathname;

/** 空いている TCP ポートを 1 つ取る。 */
export async function findFreePort(): Promise<number> {
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

export interface Bridge {
  readonly port: number;
  readonly close: () => void;
  /**
   * 利用側の回線を劣化させる（`tc` の代わり。**root を要さない**）。
   *
   * 上り（ブラウザ → 実環境）と下り（実環境 → ブラウザ）を別に設定できる。`tc` は装置
   * 単位で効くため、帯域は**この終端を通る全接続で共有する**。
   */
  readonly shape: (egress: ShapeState, ingress: ShapeState) => void;
  /** 整形の観測（本当に効いたかを数で確かめるため）。 */
  readonly shapeStats: () => { readonly egress: ShapeStats; readonly ingress: ShapeStats };
}

/**
 * TLS の終端を立てる。
 *
 * Host ヘッダを実環境の名前へ書き換える。実環境は Host でルーティングするが、ブラウザは
 * `127.0.0.1:<port>` を Host に書き、上書きできない（禁止ヘッダである）。書き換えるのは
 * **最初のリクエストの頭だけ**で、以降のフレームは素通しする。
 */
export function startTlsBridge(port: number, host: string): Bridge {
  const open = new Set<Socket>();
  // 方向ごとに 1 個。**接続をまたいで共有する**（装置単位の制限を再現するため）。
  const egress = createShaper((): number => Date.now());
  const ingress = createShaper((): number => Date.now());
  const server = createNetServer((client) => {
    // **小さな書き込みを遅らせない。** 制御メッセージ（`hello` など）は数十バイトであり、
    // Nagle と遅延 ACK が噛み合うと数百ミリ秒遅れる。認証には猶予（`HELLO_TIMEOUT_MS`）が
    // あるため、遅れは接続の切断として現れる。
    client.setNoDelay(true);
    const upstream = tlsConnect({ host, port: 443, servername: host }, () => {
      upstream.setNoDelay(true);
    });
    // **`pipe` を使わない。** 整形器を通すため、書き込みを自分で行う。
    const down = ingress.attach((chunk: Buffer): void => {
      if (client.writable) {
        client.write(chunk);
      }
    }, upstream);
    const up = egress.attach((chunk: Buffer): void => {
      if (upstream.writable) {
        upstream.write(chunk);
      }
    }, client);
    upstream.on("data", (chunk: Buffer) => down.push(chunk));
    let rewritten = false;
    client.on("data", (chunk: Buffer) => {
      if (rewritten) {
        up.push(chunk);
        return;
      }
      rewritten = true;
      const text = chunk.toString("latin1");
      const fixed = text.replace(/\r\nHost:[^\r\n]*\r\n/i, `\r\nHost: ${host}\r\n`);
      up.push(Buffer.from(fixed, "latin1"));
    });
    client.on("close", () => {
      up.detach();
      down.detach();
    });
    open.add(client);
    client.on("close", () => open.delete(client));
    // **穏やかに閉じる。** `destroy` は書き込み待ちを捨てるため、閉鎖コードを載せた
    // WebSocket の終了フレームが失われ、ブラウザには 1006（コードなしの異常終了）として
    // 見える。実測: 終端を挟むと 60 秒で 17 件の切断が現れ、挟まないと 0 件だった。
    // 切断は接続の張り直しを呼び、張り直しの最中に `hello` が猶予を越えると
    // `E_AUTH`（4020）で閉じられる。**器が作った異常を製品の欠陥と読み違える。**
    upstream.on("error", () => client.end());
    client.on("error", () => upstream.end());
    upstream.on("close", () => client.end());
    client.on("end", () => upstream.end());
  });
  server.listen(port, "127.0.0.1");
  return {
    port,
    close: (): void => {
      egress.stop();
      ingress.stop();
      for (const socket of open) {
        socket.destroy();
      }
      open.clear();
      server.close();
    },
    shape: (up, down): void => {
      egress.set(up);
      ingress.set(down);
    },
    shapeStats: () => ({ egress: egress.stats(), ingress: ingress.stats() }),
  };
}

/** ページの本体を束ねる。束ねられなければ空文字を返す（呼び出し側が落とす）。 */
export async function bundlePage(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [`${root}tests/e2e/page/${entry}`],
    bundle: true,
    format: "esm",
    write: false,
    target: "es2022",
    logLevel: "silent",
  });
  const file = result.outputFiles?.[0];
  return file === undefined ? "" : file.text;
}

export interface PageServer {
  readonly port: number;
  readonly close: () => Promise<void>;
}

/**
 * 束ねた本体を 127.0.0.1 で配る。
 *
 * WebCodecs は secure context を要求する。`127.0.0.1` は secure context として扱われる
 * ため、証明書を用意せずに実際の符号化器を動かせる。
 */
export async function servePage(port: number, script: string): Promise<PageServer> {
  const server: Server = createServer((request, response) => {
    if (request.url === "/page.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(script);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><meta charset="utf-8"><title>wheso</title>' +
        '<script type="module" src="/page.js"></script>',
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    port,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/** 実環境の部屋へ終端を通して開けることを先に確かめる。 */
export async function bridgeReaches(port: number, room: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = new globalThis.WebSocket(
      `ws://127.0.0.1:${String(port)}/parties/shard/${room}?_pk=98`,
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
}

/**
 * 偽のカメラとマイクを使うための起動引数。
 *
 * CI の実行機にカメラは無い（Q-020）。偽のデバイスは実際の `MediaStreamTrack` を返すため、
 * 取得（`MediaStreamTrackProcessor`）と符号化の経路は本物である。
 */
export const FAKE_MEDIA_ARGS: readonly string[] = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  // xvfb 環境では GPU が無いため、ソフトウェアレンダリングを明示的に有効にする。
  // 無いと Canvas への描画が極端に遅くなり、C-1（描画間隔超過）と B-2（提示遅延）が発生する。
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--disable-gpu-compositing",
];
