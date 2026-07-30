/**
 * 段 E（耐久）の試験。
 *
 * 何を証明するか: 長時間の滞在と**再デプロイを挟んだ復旧**（conformance.md 1 節の段 E）。
 * 短い試験では、寿命の長い接続で起きる問題（idle での切断、状態の肥大、再デプロイによる
 * 入れ替え）が現れない。
 *
 * 構成:
 *   1. 実環境へデプロイし、この実行のための部屋を用意する
 *   2. 購読者と送信者を開き、実データ（spec/vectors/real-media.json）を繰り返し送る
 *   3. 途中で**再デプロイ**する。Durable Object は入れ替わり、接続は切れる
 *   4. 自動で再接続し、送受信が続くことを確かめる
 *   5. 復旧までの時間を測って記録する（Q-009 は未測定であり、ここで実測する）
 *
 * 長さは WHESO_ENDURANCE_SEC で与える（既定は短い。夜間の CI で 30 分にする）。
 * 毎回 30 分回すと他の検査と並べられないためである。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { DEV_NODE_KEY, deployLive, startLive, type LiveEnvironment } from "../support/live-env.ts";
import { deriveMeetingSecret, nodeAuthTag, nodeAuthTimeWindow } from "../../packages/core/src/auth.ts";
import { CHANNEL_VIDEO } from "../../packages/core/src/generated/wire-layout.ts";

/** 送信の間隔（ミリ秒）。実データの fps に合わせる。 */
const SEND_INTERVAL_MS = 33;

/** 再接続の試行間隔。詰めて試すと相手の起動を待てない。 */
const RECONNECT_DELAY_MS = 500;

/** 復旧を待つ上限。これを超えたら復旧しなかったものとする。 */
const RECOVERY_TIMEOUT_MS = 60_000;

let live: LiveEnvironment | null = null;
let frames: readonly string[] = [];

function durationSec(): number {
  const raw = process.env["WHESO_ENDURANCE_SEC"];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  // 既定は 3 分。夜間の CI で 1800（30 分）を渡す。
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** 実データの期待バイト列を読む。段 B と同じ資産を使う。 */
async function loadFrames(): Promise<readonly string[]> {
  const path = new URL("../../spec/vectors/real-media.json", import.meta.url).pathname;
  const text = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const record: Record<string, unknown> = { ...parsed };
  const video = record["video"];
  if (typeof video !== "object" || video === null) {
    return [];
  }
  const videoRecord: Record<string, unknown> = { ...video };
  const list = videoRecord["frames"];
  if (!Array.isArray(list)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const frame: Record<string, unknown> = { ...entry };
    const hex = frame["expectedMessageHex"];
    if (typeof hex === "string") {
      out.push(hex);
    }
  }
  return out;
}

async function authTag(room: string, role: string): Promise<string> {
  const parts = room.split("-");
  const meetingId = parts[1] ?? "";
  const secret = await deriveMeetingSecret(new TextEncoder().encode(DEV_NODE_KEY), meetingId);
  if (!secret.ok) {
    return "";
  }
  const window = nodeAuthTimeWindow(Math.trunc(Date.now() / 1000));
  const tag = await nodeAuthTag(secret.value, room, role, window);
  return tag.ok ? tag.value : "";
}

interface Link {
  /** 現在の接続。再接続で差し替わる。 */
  socket: globalThis.WebSocket;
  /** 接続が閉じた回数。再デプロイと意図的な切断で増える。 */
  closes: number;
  /** 現在の接続を閉じる。古い参照を掴まないよう、必ずこの口から閉じる。 */
  closeCurrent: () => void;
  /** 試験の終わり。再接続を止める。 */
  stop: () => void;
}

/**
 * 接続を開き、閉じたら自動で開き直す。
 *
 * 再デプロイでは Durable Object が入れ替わり、既存の接続は切れる。切れたまま試験を
 * 続けると「耐久」ではなく「1 度の接続の寿命」を測ることになる。
 */
async function openWithReconnect(
  url: string,
  role: string,
  room: string,
  onBinary: (bytes: Uint8Array) => void,
  onOpen: () => void,
): Promise<Link> {
  let stopped = false;
  const first = new globalThis.WebSocket(url);
  const link: Link = {
    socket: first,
    closes: 0,
    closeCurrent: () => {
      link.socket.close();
    },
    stop: () => {
      stopped = true;
      link.socket.close();
    },
  };
  let current = first;

  const attach = (socket: globalThis.WebSocket): void => {
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      void (async () => {
        socket.send(
          JSON.stringify({ t: "nodeHello", role, nodeId: room, authTag: await authTag(room, role) }),
        );
        onOpen();
      })();
    });
    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (event.data instanceof ArrayBuffer) {
        onBinary(new Uint8Array(event.data));
      }
    });
    socket.addEventListener("close", () => {
      if (stopped) {
        return;
      }
      link.closes += 1;
      setTimeout(() => {
        if (stopped) {
          return;
        }
        current = new globalThis.WebSocket(url);
        // 現在の接続を差し替える。差し替えないと、外から閉じるときに古い接続を掴む。
        link.socket = current;
        attach(current);
      }, RECONNECT_DELAY_MS);
    });
    socket.addEventListener("error", () => {
      // close も続いて起きる。ここでは何もしない。
    });
  };
  attach(current);

  return link;
}

before(async () => {
  live = await startLive();
  frames = await loadFrames();
});

after(() => {
  // 実環境は落とさない。
});

test("再デプロイを挟んでも送受信が続き、復旧する", { timeout: 3_600_000 }, async (context) => {
  if (live === null || frames.length === 0) {
    context.skip("実環境または資産が無い");
    return;
  }
  const environment = live;
  const seconds = durationSec();

  let receivedCount = 0;
  let subscriberOpens = 0;
  const subscriber = await openWithReconnect(
    `${environment.wsBase}/parties/shard/${environment.room}?_pk=7001`,
    "receiver",
    environment.room,
    () => {
      receivedCount += 1;
    },
    () => {
      subscriberOpens += 1;
      // 開き直したら購読をやり直す。購読は接続に紐づくため、再接続では消える。
      subscriber.socket.send(
        JSON.stringify({
          t: "subscribe",
          entries: [{ senderId: 4242, channel: CHANNEL_VIDEO, maxSpatialId: 3, maxTemporalId: 7 }],
        }),
      );
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 1500));

  let senderOpens = 0;
  const sender = await openWithReconnect(
    `${environment.wsBase}/parties/shard/${environment.room}?_pk=4242`,
    "sender",
    environment.room,
    () => {
      // 送信側は受け取らない。
    },
    () => {
      senderOpens += 1;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // --- 送り続ける。途中で再デプロイする ---
  const startedAt = Date.now();
  const redeployAtMs = startedAt + Math.trunc((seconds * 1000) / 3);
  /**
   * 意図的に接続を切る時刻。
   *
   * なぜ必要か: 再デプロイでは既存の接続が切れなかった（実測。Cloudflare は既存の
   * Durable Object を動かし続ける）。切断が起きないと**再接続の経路が 1 度も通らない**。
   * 段 E は「再接続と epoch 移行の誤り」を検出するための段であるため、切断を自分で起こす。
   */
  const cutAtMs = startedAt + Math.trunc((seconds * 1000 * 2) / 3);
  let cutStarted = false;
  let countAtCut = 0;
  let recoveredAfterCutMs = -1;
  let redeployStarted = false;
  let redeployDoneAt = 0;
  let countAtRedeploy = 0;
  let recoveredAfterMs = -1;
  let index = 0;

  while (Date.now() - startedAt < seconds * 1000) {
    if (!redeployStarted && Date.now() >= redeployAtMs) {
      redeployStarted = true;
      countAtRedeploy = receivedCount;
      // 再デプロイは待たずに始める（送信は続ける）。Durable Object が入れ替わる。
      void (async () => {
        const ok = await deployLive();
        redeployDoneAt = Date.now();
        assert.equal(ok, true, "再デプロイが成功する");
      })();
    }
    if (!cutStarted && Date.now() >= cutAtMs) {
      cutStarted = true;
      countAtCut = receivedCount;
      // 購読側を切る。自動再接続が働き、購読をやり直して受信が戻るはずである。
      process.stdout.write(
        `切断を行う（購読側の状態 ${String(subscriber.socket.readyState)}、受信 ${String(receivedCount)} 件）\n`,
      );
      subscriber.closeCurrent();
    }
    if (cutStarted && recoveredAfterCutMs < 0 && receivedCount > countAtCut + 5) {
      recoveredAfterCutMs = Date.now() - cutAtMs;
    }
    const hex = frames[index % frames.length];
    index += 1;
    if (hex !== undefined && sender.socket.readyState === sender.socket.OPEN) {
      sender.socket.send(hexToBytes(hex));
    }
    if (
      redeployDoneAt > 0 &&
      recoveredAfterMs < 0 &&
      receivedCount > countAtRedeploy &&
      Date.now() - redeployDoneAt < RECOVERY_TIMEOUT_MS
    ) {
      recoveredAfterMs = Date.now() - redeployDoneAt;
    }
    await new Promise((resolve) => setTimeout(resolve, SEND_INTERVAL_MS));
  }

  process.stdout.write(
    `段 E の実測: ${String(seconds)} 秒、受信 ${String(receivedCount)} 件、` +
      `購読側の接続 ${String(subscriberOpens)} 回（切断 ${String(subscriber.closes)} 回）、` +
      `送信側の接続 ${String(senderOpens)} 回（切断 ${String(sender.closes)} 回）、` +
      `再デプロイからの復旧 ${recoveredAfterMs < 0 ? "未計測" : `${String(recoveredAfterMs)} ms`}、` +
      `切断からの復旧 ${recoveredAfterCutMs < 0 ? "未計測" : `${String(recoveredAfterCutMs)} ms`}\n`,
  );

  assert.ok(receivedCount > 0, "受信が成立している");
  assert.ok(redeployStarted, "再デプロイを行った");
  assert.ok(
    receivedCount > countAtRedeploy,
    `再デプロイの後も受信が続く（前 ${String(countAtRedeploy)} / 後 ${String(receivedCount)}）`,
  );
  assert.ok(cutStarted, "意図的な切断を行った");
  assert.ok(subscriber.closes > 0, "購読側の切断が起きた（再接続の経路を通った）");
  assert.ok(
    recoveredAfterCutMs >= 0,
    `切断から復旧して受信が戻る（受信 ${String(receivedCount)} / 切断時 ${String(countAtCut)}）`,
  );
  assert.ok(
    recoveredAfterCutMs < RECOVERY_TIMEOUT_MS,
    `復旧が ${String(RECOVERY_TIMEOUT_MS)} ms 以内である（実測 ${String(recoveredAfterCutMs)} ms）`,
  );
});
