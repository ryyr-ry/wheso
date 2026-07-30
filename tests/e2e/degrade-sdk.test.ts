/**
 * 段 D（劣化）を **SDK 経由**で行う試験（F-10）。
 *
 * **何を証明するか。** 劣化した回線の下で、**製品の判断**（購読単位の輻輳制御・段の選択・
 * 提示の門・A/V 同期・`ack` による送信窓）が働き、実環境の 5 ノードを通って映像が届き
 * 続け、落ちたのは破棄可能な層だけであり、固まらず、音声と映像のずれが許容の内側に
 * 留まること（受入条件 3 節・4 節）。
 *
 * **旧い試験（`degrade.test.ts`）との違い。** 旧い器は生の WebSocket で中継部屋へ直結し、
 * simulcast と輻輳制御を自前に持っていた。緑だったのは器の自前実装であり、製品の判断は
 * 1 度も通らなかった。さらに旧い器は `ack` を返さないため、購読単位の送信窓（ADR-0025）を
 * 入れた後は `ACK_TIMEOUT_MS` で中継ノードから切断される（実測: 公開 CI で 9 本すべてが
 * `code=4034` で落ちた）。
 *
 * 構成:
 *   1. 実環境へデプロイし、この実行のための会議を用意する（`tests/support/live-env.ts`）
 *   2. SDK の器（`tests/e2e/page/degrade-sdk.ts`）を束ねてブラウザで開く
 *   3. プロファイルの段を時刻に沿ってループバックの qdisc へ適用する（`tools/impair.ts`）
 *   4. 観測を純関数で判定の形へ組み直し（`tests/support/sdk-degrade-record.ts`）判定する
 *
 * 劣化を適用できない環境（root が無い）では**明示的に飛ばす**。黙って劣化なしで走らせると
 * 「劣化下でも動いた」という空虚な緑になる。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";

import { DEV_TOKEN_KEY, newMeetingId, startLive, type LiveEnvironment } from "../support/live-env.ts";
import {
  IMPAIRMENT_DURATION_SEC,
  IMPAIRMENT_MAX_GAP_MS,
  IMPAIRMENT_MAX_GAP_WITH_OUTAGE_MS,
  IMPAIRMENT_PROFILES,
} from "../../packages/core/src/generated/impairment.ts";
import { applyStep, canImpair, clearImpairment, prepareDevice, stepAt } from "../../tools/impair.ts";
import { judgeAll } from "../support/degrade-judge.ts";
import { buildDegradeRecord, type ObservedRun } from "../support/sdk-degrade-record.ts";
import {
  bridgeReaches,
  bundlePage,
  FAKE_MEDIA_ARGS,
  findFreePort,
  servePage,
  startTlsBridge,
  type Bridge,
  type PageServer,
} from "../support/browser-harness.ts";

/** 利用者 ID は部屋名の文法に従う（16 進 32 文字。room-naming.md 1 節）。 */
const USER_SENDER = "550e8400e29b41d4a716446655440501";
const USER_HEALTHY = "550e8400e29b41d4a716446655440502";
const USER_IMPAIRED = "550e8400e29b41d4a716446655440503";

let browser: Browser | null = null;
let page: PageServer | null = null;
/** 主の終端。N-0 から N-7 では送信側と受信側の両方がここを通る。 */
let bridgeA: Bridge | null = null;
/** N-8 用の 2 本目。参加者ごとに別ポートにすることで劣化を分ける。 */
let bridgeB: Bridge | null = null;
let live: LiveEnvironment | null = null;
let impairAvailable = false;

before(async () => {
  impairAvailable = canImpair();
  if (!impairAvailable) {
    process.stdout.write("SKIP 段 D（劣化を適用できない。tc に root が要る）\n");
    return;
  }
  prepareDevice();
  live = await startLive();
  bridgeA = startTlsBridge(await findFreePort(), live.host);
  bridgeB = startTlsBridge(await findFreePort(), live.host);

  // 終端そのものが通ることを先に確かめる。ここを飛ばすと、ブラウザ側の失敗が
  // 「終端が壊れている」のか「器が壊れている」のか切り分けられない。
  assert.equal(await bridgeReaches(bridgeA.port, live.room), true, "終端 A から実環境の部屋へ繋がる");
  assert.equal(await bridgeReaches(bridgeB.port, live.room), true, "終端 B から実環境の部屋へ繋がる");

  const script = await bundlePage("degrade-sdk.ts");
  assert.notEqual(script, "", "SDK の器を束ねられる");
  page = await servePage(await findFreePort(), script);
  browser = await chromium.launch({ args: [...FAKE_MEDIA_ARGS] });
});

after(async () => {
  await browser?.close();
  browser = null;
  await page?.close();
  page = null;
  bridgeA?.close();
  bridgeA = null;
  bridgeB?.close();
  bridgeB = null;
  if (impairAvailable) {
    clearImpairment();
  }
});

/** 試験の長さ。既定は規範の 60 秒。CI では短くできる。 */
function durationSec(): number {
  const raw = process.env["WHESO_DEGRADE_SEC"];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : IMPAIRMENT_DURATION_SEC;
}

/** プロファイルの段を時刻に沿って適用し続ける。終わったら劣化を解除する。 */
function driveProfile(
  profileId: string,
  seconds: number,
  port: number,
): { stop: () => void; failures: () => number; applied: () => number } {
  const profile = IMPAIRMENT_PROFILES.find((entry) => entry.id === profileId);
  if (profile === undefined) {
    throw new Error(`未知のプロファイル: ${profileId}`);
  }
  const startedAt = Date.now();
  let appliedAtSec = -1;
  let appliedCount = 0;
  let failureCount = 0;
  const timer = setInterval(() => {
    const elapsedSec = Math.trunc((Date.now() - startedAt) / 1000);
    if (elapsedSec > seconds) {
      return;
    }
    const step = stepAt(profile, elapsedSec);
    if (step !== undefined && step.atSec !== appliedAtSec) {
      appliedAtSec = step.atSec;
      if (applyStep(step, port)) {
        appliedCount += 1;
      } else {
        failureCount += 1;
      }
    }
    const outage = profile.outage;
    if (outage !== undefined && elapsedSec > 0 && elapsedSec % outage.everySec === 0) {
      void (async () => {
        const { outage: applyOutage } = await import("../../tools/impair.ts");
        await applyOutage(outage.durationMs, port);
        const back = stepAt(profile, elapsedSec);
        if (back !== undefined) {
          applyStep(back, port);
        }
      })();
    }
  }, 1000);
  return {
    stop: (): void => {
      clearInterval(timer);
      clearImpairment();
    },
    failures: (): number => failureCount,
    applied: (): number => appliedCount,
  };
}

/* ------------------------------------------------------------------------- */
/* 観測の読み取り（動的型を使わずに実行時に検査する）                        */
/* ------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

interface ParticipantView {
  readonly label: string;
  readonly run: ObservedRun;
  /** 符号化器が出したユニットの数。ワイヤへ出た数との差は送信経路の判断である。 */
  readonly encodedVideoCount: number;
  readonly uplinkBps: number;
  readonly downlinkBps: number;
  readonly participantCount: number;
}

/**
 * 参加者 1 人ぶんの観測を読む。
 *
 * 送信側の記録（`sentVideo` / `sentAudio`）は送信する参加者にしか無いため、
 * 受信側の判定を組むときは送信側の記録を差し込む。
 */
function readParticipant(value: unknown): ParticipantView {
  const record = asRecord(value);
  return {
    label: str(record["label"]),
    run: {
      sentVideo: list(record["sentVideo"]).map((entry) => {
        const item = asRecord(entry);
        return {
          frameIndex: num(item["frameIndex"]),
          spatialId: num(item["spatialId"]),
          temporalId: num(item["temporalId"]),
          isKey: item["isKey"] === true,
          captureUs: num(item["captureUs"]),
          atMs: num(item["atMs"]),
        };
      }),
      sentAudio: list(record["sentAudio"]).map((entry) => {
        const item = asRecord(entry);
        return { captureUs: num(item["captureUs"]), atMs: num(item["atMs"]), silent: item["silent"] === true };
      }),
      received: list(record["received"]).map((entry) => {
        const item = asRecord(entry);
        return { captureUs: num(item["captureUs"]), sha256: str(item["sha256"]), atMs: num(item["atMs"]) };
      }),
      decoded: list(record["decoded"]).map((entry) => {
        const item = asRecord(entry);
        return {
          captureUs: num(item["captureUs"]),
          spatialId: num(item["spatialId"]),
          temporalId: num(item["temporalId"]),
          isKey: item["isKey"] === true,
          atMs: num(item["atMs"]),
        };
      }),
      playedAudio: list(record["playedAudio"]).map((entry) => {
        const item = asRecord(entry);
        return { captureUs: num(item["captureUs"]), atMs: num(item["atMs"]) };
      }),
      arrived: list(record["arrived"]).map((entry) => {
        const item = asRecord(entry);
        return { captureUs: num(item["captureUs"]), spatialId: num(item["spatialId"]) };
      }),
      keyframeRequests: num(record["keyframeRequests"]),
      closures: list(record["closures"]).map((entry) => {
        const item = asRecord(entry);
        return { label: str(item["label"]), role: str(item["role"]), code: num(item["code"]) };
      }),
      lastSentAtMs: num(record["lastSentAtMs"]),
    },
    encodedVideoCount: num(record["encodedVideoCount"]),
    uplinkBps: num(record["uplinkBps"]),
    downlinkBps: num(record["downlinkBps"]),
    participantCount: num(record["participantCount"]),
  };
}
interface RunView {
  readonly ok: boolean;
  readonly detail: string;
  readonly sender: ParticipantView;
  readonly receivers: readonly ParticipantView[];
  readonly logs: readonly string[];
}

function readRun(value: unknown): RunView {
  const record = asRecord(value);
  return {
    ok: record["ok"] === true,
    detail: str(record["detail"]),
    sender: readParticipant(record["sender"]),
    receivers: list(record["receivers"]).map((entry) => readParticipant(entry)),
    logs: list(record["logs"]).map((entry) => str(entry)),
  };
}

/** 送信側の記録と受信側の記録を 1 つの観測へ合わせる。 */
function merge(sender: ParticipantView, receiver: ParticipantView): ObservedRun {
  return {
    ...receiver.run,
    sentVideo: sender.run.sentVideo,
    sentAudio: sender.run.sentAudio,
    lastSentAtMs: sender.run.lastSentAtMs,
  };
}

interface Spec {
  readonly label: string;
  readonly base: string;
  readonly userId: string;
  readonly send: boolean;
}

/** ブラウザで器を回す。 */
async function runHarness(specs: readonly Spec[], meetingId: string, durationMs: number): Promise<RunView> {
  const browserRef = browser;
  const pageRef = page;
  if (browserRef === null || pageRef === null) {
    throw new Error("ブラウザが起動していない");
  }
  const tab = await browserRef.newPage();
  const logs: string[] = [];
  tab.on("console", (message) => logs.push(message.text()));
  tab.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));
  try {
    await tab.goto(`http://127.0.0.1:${String(pageRef.port)}/`);
    await tab.waitForFunction("typeof window.__whesoDegradeSdk === 'function'", undefined, { timeout: 30_000 });
    const raw: unknown = await tab.evaluate(
      async ([specsJson, meeting, tokenKey, duration]) => {
        const runner = window.__whesoDegradeSdk;
        if (runner === undefined) {
          return { ok: false, detail: "器が無い" };
        }
        const parsed: unknown = JSON.parse(String(specsJson));
        if (!Array.isArray(parsed)) {
          return { ok: false, detail: "設定を読めない" };
        }
        const list = parsed.map((entry: unknown) => {
          const item: Record<string, unknown> =
            typeof entry === "object" && entry !== null ? { ...entry } : {};
          return {
            label: String(item["label"]),
            base: String(item["base"]),
            userId: String(item["userId"]),
            send: item["send"] === true,
          };
        });
        return await runner(list, String(meeting), String(tokenKey), Number(duration));
      },
      [JSON.stringify(specs), meetingId, DEV_TOKEN_KEY, durationMs],
    );
    const view = readRun(raw);
    return { ...view, logs: [...view.logs, ...logs.slice(0, 10)] };
  } finally {
    await tab.close();
  }
}

/* ------------------------------------------------------------------------- */
/* N-0 から N-7: 送信側と受信側が同じ劣化を受ける                            */
/* ------------------------------------------------------------------------- */

for (const profile of IMPAIRMENT_PROFILES) {
  test(`SDK 経由 ${profile.id}: ${profile.note}`, { timeout: 420_000 }, async (context) => {
    if (!impairAvailable || live === null || bridgeA === null) {
      context.skip("劣化を適用できない（tc に root が要る）");
      return;
    }
    const seconds = durationSec();
    const meetingId = newMeetingId();
    const base = `http://127.0.0.1:${String(bridgeA.port)}`;
    const driver = driveProfile(profile.id, seconds, bridgeA.port);
    let view: RunView;
    try {
      view = await runHarness(
        [
          { label: "送信", base, userId: USER_SENDER, send: true },
          { label: "受信", base, userId: USER_HEALTHY, send: false },
        ],
        meetingId,
        seconds * 1000,
      );
    } finally {
      driver.stop();
    }

    // 劣化が実際に適用されたことを先に確かめる。適用に失敗したまま緑になると、
    // 「劣化下でも動いた」という空虚な報告になる。
    assert.equal(driver.failures(), 0, "劣化の適用が失敗していない");
    assert.ok(driver.applied() > 0, "劣化の段が少なくとも 1 度適用された");

    assert.ok(view.ok, `器が記録を取れる（${view.detail} / ${view.logs.join(" | ")}）`);
    const receiver = view.receivers[0];
    assert.ok(receiver !== undefined, "受信側の記録がある");
    const built = buildDegradeRecord(merge(view.sender, receiver));

    process.stdout.write(
      `SDK ${profile.id} の実測: 符号化 ${String(view.sender.encodedVideoCount)}` +
        ` / ワイヤ ${String(view.sender.run.sentVideo.length)}` +
        ` / 判定対象 ${String(built.judgedSent)} / 届 ${String(built.record.arrived?.length ?? 0)}` +
        ` / 提示 ${String(built.record.received.length)}` +
        ` / 音声 ${String(built.record.playedAudio?.length ?? 0)}` +
        ` / 段の切替 ${String(built.switches.length)}` +
        ` / 要求 ${String(built.record.keyframeRequests)}` +
        ` / 上り ${String(view.sender.uplinkBps)} bps` +
        ` / 戻れない切断 ${built.record.closures?.length === 0 ? "なし" : (built.record.closures ?? []).join(", ")}` +
        ` / 戻れた切断 ${built.transientClosures.length === 0 ? "なし" : built.transientClosures.join(", ")}\n`,
    );

    assert.ok(built.judgedSent > 0, "判定の対象となる送信がある");
    assert.ok(built.record.received.length > 0, "1 枚以上を提示できている");

    const violations = judgeAll(built.record, {
      maxGapMs: profile.outage === undefined ? IMPAIRMENT_MAX_GAP_MS : IMPAIRMENT_MAX_GAP_WITH_OUTAGE_MS,
      // 劣化なしの段だけ欠落 0 を要求する（判定 B-1）。
      requireComplete: profile.id === "N-0",
      // 段を上げた回数だけキーフレーム要求を許す（受入条件 4.5 の例外）。
      // 遮断のある段は復帰のたびにも許される。
      // 段を上げた回数、遮断からの復帰、**参照連鎖が切れた回数**だけ許す
      // （受入条件 4.5 の例外と規範 1.4。ADR-0046）。連鎖が切れたら要求するのが規範である。
      allowedKeyframeRequests:
        built.switches.filter((entry) => entry.up).length +
        built.chainBreaks +
        (profile.outage === undefined ? 0 : Math.trunc(seconds / profile.outage.everySec) + 1),
    });
    assert.deepEqual(
      violations.map((entry) => `${entry.judgement}: ${entry.detail}`),
      [],
      `受入条件の違反が無い（判定対象 ${String(built.judgedSent)} / 提示 ${String(
        built.record.received.length,
      )}）`,
    );
  });
}

/* ------------------------------------------------------------------------- */
/* N-8: 参加者ごとに別々の劣化                                               */
/* ------------------------------------------------------------------------- */

/**
 * **悪い回線の 1 人が他の参加者を壊さないこと。** SFU の要件はこれであり、これを検証
 * しない試験は意味を持たない（受入条件 3.2 の注記）。
 *
 * SDK 経由では 3 人にする。送信者 1 人と受信者 2 人であり、**受信者の一方だけを劣化させる**。
 * 2 人（送信者と受信者）では、劣化させた側の上りと下りが同じ口を通るため「悪い 1 人」と
 * 「送信者」を分離できない。
 */
test("SDK 経由 N-8: 劣化した購読者が健全な購読者を壊さない", { timeout: 420_000 }, async (context) => {
  if (!impairAvailable || live === null || bridgeA === null || bridgeB === null) {
    context.skip("劣化を適用できない（tc に root が要る）");
    return;
  }
  const seconds = durationSec();
  const meetingId = newMeetingId();
  const healthyBase = `http://127.0.0.1:${String(bridgeA.port)}`;
  const impairedBase = `http://127.0.0.1:${String(bridgeB.port)}`;
  // 劣化させるのは受信者 B のポートだけである。送信者と受信者 A には何も掛けない。
  const driver = driveProfile("N-6", seconds, bridgeB.port);
  let view: RunView;
  try {
    view = await runHarness(
      [
        { label: "送信", base: healthyBase, userId: USER_SENDER, send: true },
        { label: "健全", base: healthyBase, userId: USER_HEALTHY, send: false },
        { label: "劣化", base: impairedBase, userId: USER_IMPAIRED, send: false },
      ],
      meetingId,
      seconds * 1000,
    );
  } finally {
    driver.stop();
  }

  assert.equal(driver.failures(), 0, "劣化の適用が失敗していない");
  assert.ok(driver.applied() > 0, "劣化が少なくとも 1 度適用された");
  assert.ok(view.ok, `器が記録を取れる（${view.detail} / ${view.logs.join(" | ")}）`);

  const healthy = view.receivers.find((entry) => entry.label === "健全");
  const impaired = view.receivers.find((entry) => entry.label === "劣化");
  assert.ok(healthy !== undefined && impaired !== undefined, "2 人ぶんの受信記録がある");

  const healthyBuilt = buildDegradeRecord(merge(view.sender, healthy));
  const impairedBuilt = buildDegradeRecord(merge(view.sender, impaired));

  process.stdout.write(
    `SDK N-8 の実測: 送(全段) ${String(view.sender.run.sentVideo.length)}` +
      ` / 健全 判定対象 ${String(healthyBuilt.judgedSent)} 届 ${String(
        healthyBuilt.record.arrived?.length ?? 0,
      )} 提示 ${String(healthyBuilt.record.received.length)}` +
      ` / 劣化 判定対象 ${String(impairedBuilt.judgedSent)} 届 ${String(
        impairedBuilt.record.arrived?.length ?? 0,
      )} 提示 ${String(impairedBuilt.record.received.length)} 段の切替 ${String(impairedBuilt.switches.length)}` +
      ` / 劣化側の戻れない切断 ${(impairedBuilt.record.closures ?? []).join(", ") || "なし"}` +
      ` / 劣化側の戻れた切断 ${impairedBuilt.transientClosures.length === 0 ? "なし" : impairedBuilt.transientClosures.join(", ")}\n`,
  );

  // 劣化側も成立していること（壊れていたら比較の意味が無い）。
  assert.ok(impairedBuilt.record.received.length > 0, "劣化した購読者も映像を提示できている");

  // **劣化が実際に劣化側へ効いたこと。** 効き方は 2 通りある。段を下げる（切替が起きる）か、
  // 転送で捨てられる（届いた数が判定対象より少ない）である。
  const switched = impairedBuilt.switches.length > 0;
  const dropped = (impairedBuilt.record.arrived?.length ?? 0) < impairedBuilt.judgedSent;
  const fewerPresented = impairedBuilt.record.received.length < healthyBuilt.record.received.length;
  assert.ok(
    switched || dropped || fewerPresented,
    `劣化側に劣化の影響が現れている（切替 ${String(impairedBuilt.switches.length)} / 届 ${String(
      impairedBuilt.record.arrived?.length ?? 0,
    )} / 判定対象 ${String(impairedBuilt.judgedSent)}）`,
  );

  // **健全な購読者は無傷であること。** これが N-8 の主張である。
  const violations = judgeAll(healthyBuilt.record, {
    maxGapMs: IMPAIRMENT_MAX_GAP_MS,
    requireComplete: false,
    allowedKeyframeRequests:
      healthyBuilt.switches.filter((entry) => entry.up).length + healthyBuilt.chainBreaks,
  });
  assert.deepEqual(
    violations.map((entry) => `${entry.judgement}: ${entry.detail}`),
    [],
    `健全な購読者に違反が無い（提示 ${String(healthyBuilt.record.received.length)} / 劣化側 提示 ${String(
      impairedBuilt.record.received.length,
    )}）`,
  );
});
