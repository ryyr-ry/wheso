/**
 * 遅延勾配の分布を実測する（Q-026）。
 *
 * **なぜ必要か。** `DELAY_TREND_DEGRADE` は 1/100 と定められているが、比較の対象は
 * `delaySlope` が返す**マイクロ秒/標本**である。0.01 マイクロ秒/標本は実際の揺れより
 * 桁違いに小さく、健全な回線でも常に「劣化」と判定される。実測でブラウザの SDK が
 * `AUDIO_ONLY` へ落ち続けることを確認した（実測）。
 *
 * このツールは、実環境に対して SDK で 2 人の会議を行い、受信側が算出する勾配の分布を
 * 集める。**推測値を書かないため**（AGENTS 5.2）、閾値はこの出力から決める。
 *
 * 実行:
 *   WHESO_LIVE_HOST=<配備先> node tools/measure-trend.ts [秒数]
 *
 * 出力: 勾配（マイクロ秒/標本）の分位数と、現在の閾値を超えた割合。
 */

import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { build } from "esbuild";
import { chromium } from "playwright";

import { deriveMeetingSecret, nodeAuthTag, nodeAuthTimeWindow } from "../packages/core/src/auth.ts";
import {
  DELAY_TREND_DEGRADE_DEN,
  DELAY_TREND_DEGRADE_NUM,
  DELAY_TREND_RECOVER_DEN,
  DELAY_TREND_RECOVER_NUM,
} from "../packages/core/src/generated/constants.ts";

const root = new URL("..", import.meta.url).pathname;
const TOKEN_KEY = "wheso-dev-token-key-not-a-secret";
const USER_A = "550e8400e29b41d4a716446655440aaa";
const USER_B = "550e8400e29b41d4a716446655440bbb";

interface Slope {
  readonly num: number;
  readonly den: number;
}

interface SdkResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly aFrames: number;
  readonly bFrames: number;
  readonly aUplinkBps: number;
  readonly bDownlinkBps: number;
  readonly slopes: readonly Slope[];
  readonly sockets: readonly {
    readonly kind: string;
    readonly text: number;
    readonly binary: number;
    readonly sentText: number;
    readonly keyframeRequests: number;
  }[];
  readonly decoder: {
    readonly created: number;
    readonly configured: number;
    readonly decoded: number;
    readonly output: number;
    readonly errors: number;
    readonly messages: readonly string[];
  };
  readonly logs: readonly string[];
}

function newMeetingId(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let out = "";
  for (let index = 0; index < 26; index += 1) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}

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

/** 分位数（昇順に整列済みの配列から）。 */
function quantile(sorted: readonly number[], perMille: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.trunc((sorted.length * perMille) / 1000));
  return sorted[index] ?? 0;
}

/** 認証付きの観測口を読む。**どの層で媒体が止まるかはこれでしか分からない。** */
async function nodeStatus(host: string, meetingId: string): Promise<string> {
  const secret = await deriveMeetingSecret(new TextEncoder().encode("wheso-dev-node-key-not-a-secret"), meetingId);
  if (!secret.ok) {
    return "観測: 会議シークレットを導出できない";
  }
  const rooms: readonly { readonly party: string; readonly room: string }[] = [
    { party: "shard", room: `vsh-${meetingId}-auto-1-0` },
    { party: "sender", room: `vs-${meetingId}-${USER_A}` },
    { party: "receiver", room: `vr-${meetingId}-${USER_B}` },
  ];
  const lines: string[] = [];
  for (const entry of rooms) {
    const tag = await nodeAuthTag(secret.value, entry.room, "shard", nodeAuthTimeWindow(Math.trunc(Date.now() / 1000)));
    if (!tag.ok) {
      continue;
    }
    try {
      const response = await fetch(`https://${host}/parties/${entry.party}/${entry.room}`, {
        headers: { "x-wheso-node-role": "shard", "x-wheso-node-auth": tag.value },
      });
      lines.push(`${entry.room.slice(0, 3)}: ${(await response.text()).slice(0, 3000)}`);
    } catch {
      lines.push(`${entry.party}: 観測できない`);
    }
  }
  return lines.join("\n");
}

/** 走行中の要点だけを 1 行で返す。 */
async function pollCounters(host: string, meetingId: string): Promise<string> {
  const secret = await deriveMeetingSecret(new TextEncoder().encode("wheso-dev-node-key-not-a-secret"), meetingId);
  if (!secret.ok) {
    return "観測: 導出できない";
  }
  const targets: readonly { readonly party: string; readonly room: string; readonly label: string }[] = [
    { party: "shard", room: `vsh-${meetingId}-auto-1-0`, label: "vsh" },
    { party: "sender", room: `vs-${meetingId}-${USER_A}`, label: "vsA" },
    { party: "sender", room: `vs-${meetingId}-${USER_B}`, label: "vsB" },
    { party: "receiver", room: `vr-${meetingId}-${USER_B}`, label: "vrB" },
  ];
  const parts: string[] = [];
  for (const entry of targets) {
    const tag = await nodeAuthTag(secret.value, entry.room, "shard", nodeAuthTimeWindow(Math.trunc(Date.now() / 1000)));
    if (!tag.ok) {
      continue;
    }
    try {
      const response = await fetch(`https://${host}/parties/${entry.party}/${entry.room}`, {
        headers: { "x-wheso-node-role": "shard", "x-wheso-node-auth": tag.value },
      });
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null) {
        continue;
      }
      const record: Record<string, unknown> = { ...body };
      const counters = record["counters"];
      const summary: Record<string, unknown> = typeof counters === "object" && counters !== null ? { ...counters } : {};
      const windows = record["windows"];
      const received = record["received"];
      const ladders = record["ladders"];
      const subs = record["subscriptions"];
      const shardExtra =
        entry.label === "vsh"
          ? ` L=${JSON.stringify(Array.isArray(ladders) ? ladders.map((l: unknown) => (typeof l === "object" && l !== null ? { ...l } : l)) : ladders).slice(0, 300)} S=${JSON.stringify(subs).slice(0, 300)}`
          : "";
      const extra =
        shardExtra !== ""
          ? shardExtra
          : Array.isArray(windows) && windows.length > 0
          ? ` w=${JSON.stringify(windows[0])}`
          : Array.isArray(received)
            ? ` r=${JSON.stringify(received)}`
            : "";
      parts.push(
        `${entry.label}[${Object.entries(summary)
          .filter(([key]) => key !== "textOutNoConnection" && key !== "nodeAuthFail" && key !== "alarmErrors" && key !== "droppedBeforeHello")
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(",")}]${extra}`,
      );
    } catch {
      parts.push(`${entry.label}[読めない]`);
    }
  }
  return parts.join(" ");
}

async function main(): Promise<void> {
  const host = process.env["WHESO_LIVE_HOST"];
  if (host === undefined || host === "") {
    process.stdout.write("WHESO_LIVE_HOST が無い（実環境の配備先を環境変数で与える）\n");
    process.exitCode = 1;
    return;
  }
  const seconds = Number.parseInt(process.argv[2] ?? "60", 10);
  const durationMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000;

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
  if (script === "") {
    process.stdout.write("本体を束ねられない\n");
    process.exitCode = 1;
    return;
  }

  const port = await findFreePort();
  const server: Server = createServer((request, response) => {
    if (request.url === "/sdk.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(script);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><meta charset="utf-8"><title>wheso trend</title>' +
        '<script type="module" src="/sdk.js"></script>',
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const browser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const page = await browser.newPage();
  const meetingId = newMeetingId();
  process.stdout.write(`測定を始める（会議 ${meetingId} / ${String(durationMs / 1000)} 秒）\n`);
  await page.goto(`http://127.0.0.1:${String(port)}/`);
  await page.waitForFunction("typeof window.__whesoSdk === 'function'", undefined, { timeout: 30_000 });

  const runPromise: Promise<SdkResult | null> = page.evaluate(
    async ([liveHost, meeting, tokenKey, userA, userB, duration]) => {
      const runner = window.__whesoSdk;
      if (typeof runner !== "function") {
        return null;
      }
      return await runner(
        String(liveHost),
        String(meeting),
        String(tokenKey),
        String(userA),
        String(userB),
        Number(duration),
      );
    },
    [host, meetingId, TOKEN_KEY, USER_A, USER_B, String(durationMs)],
  );

  // **走行中に計数を追う。** 一度だけ読むと「止まった位置」しか分からず、
  // どちらの向きが先に止まったかが分からない（F-047 の教訓）。
  let running = true;
  const poller = (async (): Promise<void> => {
    while (running) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      if (!running) {
        break;
      }
      const line = await pollCounters(host, meetingId);
      process.stdout.write(`${line}\n`);
    }
  })();
  const raw: SdkResult | null = await runPromise;
  running = false;
  await poller;

  const status = await nodeStatus(host, meetingId);
  await browser.close();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  if (raw === null) {
    process.stdout.write("本体を実行できない\n");
    process.exitCode = 1;
    return;
  }

  const values = raw.slopes
    .filter((slope) => slope.den !== 0)
    .map((slope) => slope.num / slope.den)
    .sort((a, b) => a - b);
  const degradeThreshold = DELAY_TREND_DEGRADE_NUM / DELAY_TREND_DEGRADE_DEN;
  const recoverThreshold = DELAY_TREND_RECOVER_NUM / DELAY_TREND_RECOVER_DEN;
  const over = values.filter((value) => value > degradeThreshold).length;
  const under = values.filter((value) => value < recoverThreshold).length;

  process.stdout.write(
    [
      `結果: ${raw.detail}`,
      `復号: A ${String(raw.aFrames)} 枚 / B ${String(raw.bFrames)} 枚`,
      `帯域: 上り ${String(raw.aUplinkBps)} bps / 下り ${String(raw.bDownlinkBps)} bps`,
      `勾配の標本数: ${String(values.length)}`,
      `勾配（マイクロ秒/標本）: 最小 ${String(quantile(values, 0))} / p10 ${String(
        quantile(values, 100),
      )} / 中央 ${String(quantile(values, 500))} / p90 ${String(quantile(values, 900))} / p99 ${String(
        quantile(values, 990),
      )} / 最大 ${String(values[values.length - 1] ?? 0)}`,
      `現在の閾値: 劣化 > ${String(degradeThreshold)} / 回復 < ${String(recoverThreshold)}`,
      `劣化と判定される割合: ${String(over)} / ${String(values.length)}`,
      `回復と判定される割合: ${String(under)} / ${String(values.length)}`,
      `ブラウザの受信: ${raw.sockets.map((s) => `${s.kind} in:text=${String(s.text)},bin=${String(s.binary)} out:text=${String(s.sentText)},kf=${String(s.keyframeRequests)}`).join(" / ")}`,
      `復号器: 生成 ${String(raw.decoder.created)} / 設定 ${String(raw.decoder.configured)} / 投入 ${String(
        raw.decoder.decoded,
      )} / 出力 ${String(raw.decoder.output)} / 失敗 ${String(raw.decoder.errors)} ${raw.decoder.messages.join(" ; ")}`,
      `ページの記録: ${raw.logs.slice(-4).join(" | ")}`,
      `ノードの状態:\n${status}`,
    ].join("\n") + "\n",
  );
}

await main();
