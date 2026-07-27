/**
 * 各言語の疎通試験（段 B）の実行器。
 *
 * 何をするか:
 *   1. 空きポートで局所実行環境（partykit dev）を起動する
 *   2. 中継部屋へ実際に WebSocket が開くまで待つ
 *   3. 指定された言語の疎通試験へ、接続先と鍵を環境変数で渡して実行する
 *   4. 続けて**否定対照**（誤った鍵）を同じ試験で回し、必ず失敗することを確かめる
 *   5. 終了後に実行環境をプロセス群ごと落とす
 *
 * なぜ実行器を分けるか: 疎通試験は言語ごとに実行系が違う（gradle / swift / dart / cargo / g++）。
 * 一方で「実行環境を 1 つ立てて実データを流す」手順は共通である。共通部分をここへ集め、
 * 各言語は「環境変数で与えられた場所へ繋いで送受信する」だけにする。
 *
 * なぜ否定対照を仕組みに入れるか: 疎通が「通った」ことは認証が働いていることを示さない。
 * 認証を外しても通るなら、その試験は疎通を確かめていても防御を確かめていない。
 *
 * 実行:
 *   node tools/transport-suite.ts kotlin | swift | dart | all
 *   WHESO_SDK_DOCKER=1 を付けると docker の公式イメージで実行する（局所に道具が無い場合）。
 *
 * 各言語へ渡す環境変数:
 *   WHESO_WS_BASE   例 ws://127.0.0.1:1999
 *   WHESO_ROOM      中継部屋の名前
 *   WHESO_NODE_KEY  ノード間認証の鍵
 *   WHESO_SENDER_PK 送信側の接続 ID（_pk）
 *   WHESO_SUB_PK    購読側の接続 ID（_pk）
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

/** 中継部屋の名前。会議 ID は部屋名規範 1 節の形式（ULID を小文字化した 26 文字）である。 */
const ROOM = "vsh-01jxy8kq2r3mz5v7h9abcderfa-auto-1-0";

/** 試験専用の鍵。秘密ではない。本番の鍵は環境の秘密として与える（Q-019）。 */
const DEV_NODE_KEY = "wheso-dev-node-key-not-a-secret";

/**
 * 否定対照に使う誤った鍵。
 * 実測では、誤った鍵で nodeHello を送るとクローズコード 4023（E_NODE_AUTH）で切られる。
 */
const WRONG_NODE_KEY = "wrong-key-for-negative-control";

/** 接続 ID。中継ノードは `_pk` を参加者 ID として扱う。 */
const SENDER_PK = "4242";
const SUBSCRIBER_PK = "7001";

const root = new URL("..", import.meta.url).pathname;

async function findFreePort(): Promise<number> {
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

async function waitForDev(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/party/main`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // 起動前は接続できない。待って再試行する。
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  return false;
}

/** 中継部屋へ実際に WebSocket が開くまで待つ。部屋は初回接続時に組み立てられる。 */
async function waitForRoom(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const opened = await new Promise<boolean>((resolve) => {
      const probe = new globalThis.WebSocket(`ws://127.0.0.1:${port}/parties/shard/${ROOM}?_pk=99`);
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
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  return false;
}

interface Target {
  readonly name: string;
  /** 局所に道具があるかを判定する実行ファイル。 */
  readonly tool: string;
  /** docker の公式イメージ（道具が無い場合に使う）。 */
  readonly image: string;
  /** 実行する命令。リポジトリ直下から実行する。 */
  readonly command: string;
}

const TARGETS: readonly Target[] = [
  {
    name: "kotlin",
    tool: "gradle",
    image: "gradle:8-jdk17",
    // cleanTest を付ける理由: Gradle は入力が変わらないと試験を再実行しない（UP-TO-DATE）。
    // 環境変数だけを変える否定対照では前回の成功結果が再利用され、誤った鍵でも
    // 「通った」ように見える。実測でこの誤りが起きた。
    command: "cd sdks/kotlin && gradle cleanTest test --no-daemon --tests dev.wheso.TransportTest",
  },
  {
    name: "swift",
    tool: "swift",
    image: "swift:6.0",
    command: "cd sdks/swift && swift test --filter TransportTests",
  },
  {
    name: "dart",
    tool: "dart",
    image: "dart:stable",
    command: "cd sdks/dart && dart pub get > /dev/null 2>&1 && dart test test/transport_test.dart",
  },
];

async function hasTool(tool: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = spawn("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
    probe.on("exit", (code) => resolve(code === 0));
    probe.on("error", () => resolve(false));
  });
}

async function runOne(target: Target, port: number, negative: boolean): Promise<boolean> {
  const env: Record<string, string> = {
    WHESO_WS_BASE: `ws://127.0.0.1:${port}`,
    WHESO_ROOM: ROOM,
    WHESO_NODE_KEY: negative ? WRONG_NODE_KEY : DEV_NODE_KEY,
    WHESO_SENDER_PK: SENDER_PK,
    WHESO_SUB_PK: SUBSCRIBER_PK,
  };

  const native = await hasTool(target.tool);
  if (!native && process.env["WHESO_SDK_DOCKER"] !== "1") {
    return true;
  }

  // docker からは host のポートへ繋ぐ必要があるため network=host を使う。
  const dockerEnv = Object.entries(env)
    .map(([key, value]) => `-e ${key}=${value}`)
    .join(" ");
  const command = native
    ? target.command
    : `docker run --rm --network host ${dockerEnv} -v "${root}":/w -w /w ${target.image} bash -c '${target.command}'`;

  return await new Promise<boolean>((resolve) => {
    const child = spawn("bash", ["-c", command], {
      cwd: root,
      stdio: negative ? "ignore" : "inherit",
      env: { ...process.env, ...env },
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function main(): Promise<void> {
  const requested = process.argv[2] ?? "all";
  const targets = requested === "all" ? TARGETS : TARGETS.filter((entry) => entry.name === requested);
  if (targets.length === 0) {
    process.stderr.write(`未知の対象: ${requested}\n`);
    process.exitCode = 2;
    return;
  }

  const port = await findFreePort();
  const dev: ChildProcess = spawn(
    "npx",
    ["partykit", "dev", "--port", String(port), "--var", `WHESO_NODE_KEY=${DEV_NODE_KEY}`],
    { cwd: root, stdio: "ignore", detached: true },
  );

  let failed = false;
  try {
    if (!(await waitForDev(port, 90_000))) {
      process.stderr.write("局所実行環境が起動しない\n");
      process.exitCode = 1;
      return;
    }
    if (!(await waitForRoom(port, 60_000))) {
      process.stderr.write("中継部屋へ接続できない\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`局所実行環境が起動した（ポート ${port}、部屋 ${ROOM}）\n`);

    for (const target of targets) {
      const native = await hasTool(target.tool);
      if (!native && process.env["WHESO_SDK_DOCKER"] !== "1") {
        process.stdout.write(
          `  ${target.name}: SKIP（${target.tool} が無い。WHESO_SDK_DOCKER=1 で docker 実行）\n`,
        );
        continue;
      }

      const ok = await runOne(target, port, false);
      process.stdout.write(`  ${target.name}: 疎通 ${ok ? "OK" : "FAIL"}\n`);
      if (!ok) {
        failed = true;
      }

      // 否定対照。誤った鍵では失敗しなければならない。通ったら認証が働いていない。
      const rejected = await runOne(target, port, true);
      if (rejected) {
        process.stdout.write(`  ${target.name}: 否定対照 FAIL（誤った鍵でも通った）\n`);
        failed = true;
      } else {
        process.stdout.write(`  ${target.name}: 否定対照 OK（誤った鍵では通らない）\n`);
      }
    }
  } finally {
    if (dev.pid !== undefined) {
      try {
        // detached で起動しているためプロセス群ごと落とす。親だけでは実行環境が残る。
        process.kill(-dev.pid, "SIGTERM");
      } catch {
        dev.kill("SIGTERM");
      }
    }
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("OK: 疎通試験（段 B）が通った\n");
}

await main();
