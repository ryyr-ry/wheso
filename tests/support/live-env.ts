/**
 * 実環境（PartyKit managed）に対する試験の共通ハーネス。
 *
 * **なぜ局所実行環境（partykit dev）を使わないか**: dev は Durable Object を局所で
 * 模しているだけであり、本番と前提が違う。TLS が無い、経路が無い、オブジェクトの寿命が
 * プロセスに縛られる、料金と制限が働かない。dev で緑になっても本番で通る保証にならない。
 * 検証はすべて実際にデプロイしたノードに対して行う。
 *
 * 使い方:
 *   const live = await startLive();      デプロイし、新しい部屋を用意して待つ
 *   live.wsBase   wss://<配備先>
 *   live.httpBase https://<配備先>
 *   live.room     この実行のためだけの中継部屋の名前
 *
 * 環境変数:
 *   WHESO_LIVE_HOST   接続先の名前（必須。配備先の名前は公開ファイルに書かない）
 *   WHESO_SKIP_DEPLOY=1 でデプロイを省く（コードを変えていないときだけ）
 */

import { spawn } from "node:child_process";

/** 試験専用の鍵。秘密ではない。本番の鍵は環境の秘密として与える（Q-019）。 */
export const DEV_NODE_KEY = "wheso-dev-node-key-not-a-secret";

/** 参加トークンの署名鍵（試験専用）。参加入口の結合試験がこれで署名する。 */
export const DEV_TOKEN_KEY = "wheso-dev-token-key-not-a-secret";

/**
 * 実環境のホスト。**環境変数 WHESO_LIVE_HOST で与える。**
 *
 * なぜ既定値を書かないか: 公開するファイルに配備先の名前を書かない方針である。
 * 与え忘れたら黙って別の場所を叩くのではなく、その場で失敗させる。
 */
export function liveHost(): string {
  const host = process.env["WHESO_LIVE_HOST"];
  if (host === undefined || host === "") {
    throw new Error("WHESO_LIVE_HOST が無い（実環境の配備先を環境変数で与える）");
  }
  return host;
}

/**
 * 配備する PartyKit のプロジェクト名。**環境変数 WHESO_PARTYKIT_PROJECT で与える。**
 *
 * **なぜ必須にするか。** `partykit.json` の `name` を既定として使うと、環境変数を
 * 与え忘れたときに**設定ファイルに書かれたプロジェクトへ配備してしまう**。同じ帳場に別の
 * プロジェクトがあると、試験のための配備が無関係のプロジェクトを上書きする（実際に起きた）。
 * 配備先は必ず呼び出し側が名指しする。
 */
export function livePartykitProject(): string {
  const project = process.env["WHESO_PARTYKIT_PROJECT"];
  if (project === undefined || project === "") {
    throw new Error("WHESO_PARTYKIT_PROJECT が無い（配備先のプロジェクト名を環境変数で与える）");
  }
  const host = liveHost();
  // **プロジェクト名とホストが対応していなければ失敗させる。** 片方だけを書き換えると、
  // 「A へ配備して B を試験する」状態になり、何を測っているのか分からなくなる。
  if (!host.startsWith(`${project}.`)) {
    throw new Error(
      `WHESO_PARTYKIT_PROJECT（${project}）と WHESO_LIVE_HOST（${host}）が対応していない`,
    );
  }
  return project;
}

/**
 * 会議 ID を新しく作る。形式は部屋名規範 1 節（26 文字。i / l / o / u を含まない）。
 *
 * 毎回変える理由: 実環境の Durable Object は試験の後も生き続ける。同じ部屋を使い回すと
 * 前回の購読者と送信者の登録が残り、受け取る件数が変わって試験が互いに干渉する。
 */
export function newMeetingId(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let out = "";
  for (let index = 0; index < 26; index += 1) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}

/** 中継部屋の名前。auto-1-0 は「自動割当・第 1 層・0 番目」を表す（部屋名規範 1 節）。 */
export function newShardRoom(meetingId: string): string {
  return `vsh-${meetingId}-auto-1-0`;
}

/** 実環境へデプロイする。鍵は変数として渡す。**配備先は必ず名指しする。** */
export async function deployLive(): Promise<boolean> {
  if (process.env["WHESO_SKIP_DEPLOY"] === "1") {
    return true;
  }
  const root = new URL("../..", import.meta.url).pathname;
  // 名指しできない状態では配備しない（`partykit.json` の既定へ落ちるのを防ぐ）。
  const project = livePartykitProject();
  return await new Promise<boolean>((resolve) => {
    // 鍵は 2 種類とも渡す。片方を忘れると、その鍵を使う試験だけが実環境で失敗する。
    const child = spawn(
      "npx",
      [
        "partykit",
        "deploy",
        "--name",
        project,
        "--var",
        `WHESO_NODE_KEY=${DEV_NODE_KEY}`,
        "--var",
        `WHESO_TOKEN_KEY=${DEV_TOKEN_KEY}`,
      ],
      { cwd: root, stdio: "ignore" },
    );
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

/** 主入口が応えるまで待つ。デプロイ直後は伝播に時間がかかることがある。 */
export async function waitForMain(httpBase: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${httpBase}/party/main`, { signal: AbortSignal.timeout(5000) });
      // 主入口は GET に対して本文を返さない実装であるため、状態のみを見る。
      // 到達できていれば十分である（部屋の準備は次の待機で確かめる）。
      if (response.status < 500) {
        return true;
      }
    } catch {
      // 伝播前は接続できない。待って再試行する。
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

/**
 * 中継部屋へ実際に WebSocket が開くまで待つ。
 * 部屋は初回接続時に組み立てられるため、1 回目は時間がかかることがある。
 */
export async function waitForRoom(wsBase: string, room: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const opened = await new Promise<boolean>((resolve) => {
      const probe = new globalThis.WebSocket(`${wsBase}/parties/shard/${room}?_pk=99`);
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
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

export interface LiveEnvironment {
  readonly host: string;
  readonly httpBase: string;
  readonly wsBase: string;
  readonly meetingId: string;
  readonly room: string;
}

/** デプロイし、この実行のための部屋を用意して、接続できる状態になるまで待つ。 */
export async function startLive(): Promise<LiveEnvironment> {
  const deployed = await deployLive();
  if (!deployed) {
    throw new Error("実環境へのデプロイが失敗した");
  }
  const host = liveHost();
  const meetingId = newMeetingId();
  const environment: LiveEnvironment = {
    host,
    httpBase: `https://${host}`,
    wsBase: `wss://${host}`,
    meetingId,
    room: newShardRoom(meetingId),
  };
  const reachable = await waitForMain(environment.httpBase, 120_000);
  if (!reachable) {
    throw new Error(`実環境へ到達できない: ${environment.httpBase}`);
  }
  const ready = await waitForRoom(environment.wsBase, environment.room, 120_000);
  if (!ready) {
    throw new Error(`中継部屋へ接続できない: ${environment.room}`);
  }
  return environment;
}
