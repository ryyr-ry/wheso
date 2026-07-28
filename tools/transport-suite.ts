/**
 * 各言語の疎通試験（段 B）の実行器。
 *
 * **実際にデプロイした PartyKit managed のノードに対して行う。** 局所実行環境
 * （partykit dev）は使わない。dev は Durable Object を局所で模しているだけであり、
 * 本番の動作とは前提が違う（TLS、実際の経路、実際の Durable Object の寿命）。
 *
 * 何をするか:
 *   1. 現在のコードを実環境へデプロイする（WHESO_SKIP_DEPLOY=1 で省略できる）
 *   2. 毎回**新しい会議 ID**の中継部屋を作り、実環境で開くまで待つ
 *      （同じ部屋を使い回すと前回の購読や送信者が残り、試験が互いに干渉する）
 *   3. TLS の終端を 1 つ立てる。自前の WebSocket クライアント（Swift / Rust / C++）は
 *      平文しか話せないため、局所の口から実環境へ TLS を張り直して中継する
 *   4. 指定された言語の疎通試験へ、接続先と鍵を環境変数で渡して実行する
 *   5. 続けて**否定対照**（誤った鍵）を同じ試験で回し、必ず失敗することを確かめる
 *
 * なぜ実行器を分けるか: 疎通試験は言語ごとに実行系が違う（gradle / swift / dart / cargo / g++）。
 * 一方で「実環境へ実データを流す」手順は共通である。共通部分をここへ集め、
 * 各言語は「環境変数で与えられた場所へ繋いで送受信する」だけにする。
 *
 * なぜ否定対照を仕組みに入れるか: 疎通が「通った」ことは認証が働いていることを示さない。
 * 認証を外しても通るなら、その試験は疎通を確かめていても防御を確かめていない。
 *
 * 実行:
 *   node tools/transport-suite.ts kotlin | swift | dart | rust | cpp | all
 *   WHESO_SDK_DOCKER=1 を付けると docker の公式イメージで実行する（局所に道具が無い場合）。
 *   WHESO_SKIP_DEPLOY=1 でデプロイを省く（コードを変えていないときだけ）。
 *
 * 各言語へ渡す環境変数:
 *   WHESO_WSS_BASE  実環境の口（TLS を話せる実行系はこちらを使う）
 *   WHESO_WS_BASE   例 ws://127.0.0.1:41234（TLS の終端。平文しか話せない実行系はこちら）
 *   WHESO_WS_HOST   Host ヘッダに書く名前。終端を経由する場合に必要
 *   WHESO_ROOM      中継部屋の名前（実行ごとに新しい）
 *   WHESO_NODE_KEY  ノード間認証の鍵
 *   WHESO_SENDER_PK 送信側の接続 ID（_pk）
 *   WHESO_SUB_PK    購読側の接続 ID（_pk）
 */

import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

import { DEV_NODE_KEY as HARNESS_NODE_KEY, deployLive, liveHost } from "../tests/support/live-env.ts";

/** 実環境のホスト。環境変数で与える（配備先の名前は公開ファイルに書かない）。 */
const HOST = liveHost();

/**
 * 会議 ID を新しく作る。形式は部屋名規範 1 節（Crockford 系の 26 文字。i / l / o / u を除く）。
 * 毎回変える理由: 実環境の Durable Object は試験の後も生き続ける。同じ部屋を使い回すと
 * 前回の購読者と送信者が残っており、受け取る件数が増えて試験が互いに干渉する。
 */
function newMeetingId(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let out = "";
  for (let index = 0; index < 26; index += 1) {
    const pick = Math.floor(Math.random() * alphabet.length);
    out += alphabet.charAt(pick);
  }
  return out;
}

/** 中継部屋の名前。auto-1-0 は「自動割当・第 1 層・0 番目」を表す（部屋名規範 1 節）。 */
const ROOM = `vsh-${newMeetingId()}-auto-1-0`;

/** 試験専用の鍵。秘密ではない。ハーネスと同じ値を使う（2 箇所に書くと必ずずれる）。 */
const DEV_NODE_KEY = HARNESS_NODE_KEY;

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

/**
 * 実環境へデプロイする。処理は試験と共通のハーネスに置いている
 * （鍵の渡し忘れを 1 箇所に閉じるため。実際に片方を忘れて参加入口の試験が落ちた）。
 */
async function deploy(): Promise<boolean> {
  if (process.env["WHESO_SKIP_DEPLOY"] === "1") {
    process.stdout.write("デプロイを省いた（WHESO_SKIP_DEPLOY=1）\n");
    return true;
  }
  process.stdout.write("実環境へデプロイしている…\n");
  return await deployLive();
}

/**
 * 中継部屋へ実際に WebSocket が開くまで待つ。部屋は初回接続時に組み立てられるため、
 * デプロイ直後の 1 回目は時間がかかることがある。
 */
async function waitForRoom(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const opened = await new Promise<boolean>((resolve) => {
      const probe = new globalThis.WebSocket(`wss://${HOST}/parties/shard/${ROOM}?_pk=99`);
      const timer = setTimeout(() => {
        probe.close();
        resolve(false);
      }, 10_000);
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
      setTimeout(resolve, 1000);
    });
  }
  return false;
}

/**
 * TLS の終端を立てる。局所の平文の口へ来た接続を、実環境へ TLS で張り直して中継する。
 *
 * なぜ必要か: Swift / Rust / C++ の疎通試験は依存を増やさないために RFC 6455 を自前で
 * 実装しており、TLS は持たない（TLS を自前で書くのは誤りであり、OpenSSL を足すと
 * 依存が増える）。SFU の処理は実環境の Durable Object が行うため、暗号の終端だけを
 * ここで担っても「実環境に対する試験」であることは変わらない。
 *
 * Host ヘッダはクライアントが書くため、各言語へ WHESO_WS_HOST で正しい名前を渡す。
 * 終端側で書き換えると HTTP を解釈することになり、余計な誤りの余地が生まれる。
 */
function startTlsBridge(port: number): Server {
  const server = createServer((client: Socket) => {
    const upstream = tlsConnect({ host: HOST, port: 443, servername: HOST }, () => {
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  server.listen(port, "127.0.0.1");
  return server;
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
  {
    name: "rust",
    tool: "cargo",
    image: "rust:1-slim",
    // --nocapture を付ける理由: 切断コード（4023 など）を println で残しており、
    // 失敗の原因が認証か手順かを出力から判別できるようにする。
    command: "cargo test --manifest-path sdks/rust/Cargo.toml --test transport -- --nocapture",
  },
  {
    name: "cpp",
    tool: "g++",
    image: "gcc:13",
    // -pthread が必要な理由: 受信を別スレッドで回すため。付けないと実行時に落ちる。
    command:
      "cd sdks/cpp && mkdir -p build && g++ -std=c++20 -Wall -Wextra -Werror -O1 -pthread -Iinclude -o build/transport tests/transport.cpp && ./build/transport ../../spec/vectors",
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
    // TLS を話せる実行系（JDK / Dart）はこちらを使い、実環境へ直に繋ぐ。
    WHESO_WSS_BASE: `wss://${HOST}`,
    // 平文しか話せない実行系（Swift / Rust / C++）は終端を経由する。
    WHESO_WS_BASE: `ws://127.0.0.1:${port}`,
    WHESO_WS_HOST: HOST,
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
    // 時限を設ける理由: 試験が固まると実行系ごと待ち続ける。実測では構築を含めて
    // 1 言語 2 分で終わるため、5 分を超えたら異常として殺し、失敗として扱う。
    const timer = setTimeout(() => {
      process.stdout.write(`  ${target.name}: 時間切れで打ち切った（${negative ? "否定対照" : "疎通"}）\n`);
      child.kill("SIGKILL");
    }, 300_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
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

  if (!(await deploy())) {
    process.stderr.write("実環境へのデプロイが失敗した\n");
    process.exitCode = 1;
    return;
  }

  const port = await findFreePort();
  const bridge = startTlsBridge(port);

  let failed = false;
  try {
    if (!(await waitForRoom(120_000))) {
      process.stderr.write(`中継部屋へ接続できない（wss://${HOST}/parties/shard/${ROOM}）\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`実環境に接続した（${HOST}、部屋 ${ROOM}、TLS 終端のポート ${port}）\n`);

    for (const target of targets) {
      const native = await hasTool(target.tool);
      if (!native && process.env["WHESO_SDK_DOCKER"] !== "1") {
        process.stdout.write(
          `  ${target.name}: SKIP（${target.tool} が無い。WHESO_SDK_DOCKER=1 で docker 実行）\n`,
        );
        continue;
      }

      process.stdout.write(`  ${target.name}: 疎通を開始する\n`);
      const ok = await runOne(target, port, false);
      process.stdout.write(`  ${target.name}: 疎通 ${ok ? "OK" : "FAIL"}\n`);
      if (!ok) {
        failed = true;
      }

      // 否定対照。誤った鍵では失敗しなければならない。通ったら認証が働いていない。
      process.stdout.write(`  ${target.name}: 否定対照を開始する\n`);
      const rejected = await runOne(target, port, true);
      if (rejected) {
        process.stdout.write(`  ${target.name}: 否定対照 FAIL（誤った鍵でも通った）\n`);
        failed = true;
      } else {
        process.stdout.write(`  ${target.name}: 否定対照 OK（誤った鍵では通らない）\n`);
      }
    }
  } finally {
    bridge.close();
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`OK: 疎通試験（段 B）が実環境（${HOST}）で通った\n`);
}

await main();
