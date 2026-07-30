/**
 * 段 E（耐久）を **SDK 経由**で行う試験（F-11）。
 *
 * **何を証明するか。** 公開 API（`joinMeeting`）だけで参加した 2 人が、長い時間
 * 送受信を続け、途中の**再デプロイ**と**経路の切断**から自力で復旧し、音声と映像のずれが
 * 許容の内側に留まること。ドリフト補正（ADR-0028）は短い試験では現れない。
 *
 * **旧い試験（`endurance.test.ts`）との違い。** 旧い試験は生の WebSocket を張り、再接続も
 * 自前に持っていた。したがって緑になっても、製品の接続状態機械（`state-machines.md` 1 節）と
 * 予備接続（ADR-0032）は 1 度も通らない。段 E は再接続と epoch 移行の誤りを検出するための
 * 段であるから、器が自前で再接続しては意味を持たない。
 *
 * **なぜ切断を自分で起こすか。** 再デプロイでは既存の接続が切れない（実行環境は古い実体を
 * 動かし続ける）。切断が起きないと再接続の経路が 1 度も通らない（実測）。
 *
 * 実行:
 *
 * ```
 * export WHESO_PARTYKIT_PROJECT=<配備先の企画>
 * export WHESO_LIVE_HOST=<配備先のホスト>
 * WHESO_ENDURANCE_SEC=1800 npm run test:endurance:sdk    # 30 分
 * WHESO_ENDURANCE_SEC=180  npm run test:endurance:sdk    # 手早く確かめる
 * ```
 *
 * **公開 CI の並列ジョブに入れてはならない**。途中で再デプロイする
 * ため、同じ配備先を共有する他のジョブが入れ替わったノードに当たる。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";

import { DEV_TOKEN_KEY, deployLive, newMeetingId, startLive, type LiveEnvironment } from "../support/live-env.ts";
import {
  bundlePage,
  FAKE_MEDIA_ARGS,
  findFreePort,
  servePage,
  type PageServer,
} from "../support/browser-harness.ts";
import { buildDegradeRecord, type ObservedRun } from "../support/sdk-degrade-record.ts";
import { deriveMeetingSecret, nodeAuthTag, nodeAuthTimeWindow } from "../../packages/core/src/auth.ts";
import { DEV_NODE_KEY } from "../support/live-env.ts";
import { judgeAll, judgeAvSkew } from "../support/degrade-judge.ts";
import { IMPAIRMENT_MAX_GAP_WITH_OUTAGE_MS } from "../../packages/core/src/generated/impairment.ts";
import {
  AV_SKEW_AUDIO_LAG_MAX_MS,
  AV_SKEW_AUDIO_LEAD_MAX_MS,
} from "../../packages/core/src/generated/constants.ts";

/** 利用者 ID は部屋名の文法に従う（16 進 32 文字。room-naming.md 1 節）。 */
const USER_SENDER = "550e8400e29b41d4a716446655440601";
const USER_RECEIVER = "550e8400e29b41d4a716446655440602";

/** 復旧の上限。これを超えて戻らなければ失敗である。 */
const RECOVERY_TIMEOUT_MS = 60_000;

/** 経過を刻む間隔。長い試験で「いつ止まったか」を残すために要る。 */
const TICK_MS = 15_000;

let page: PageServer | null = null;
let live: LiveEnvironment | null = null;

function durationSec(): number {
  const raw = process.env["WHESO_ENDURANCE_SEC"];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180;
}

before(async () => {
  live = await startLive();
  const script = await bundlePage("degrade-sdk.ts");
  assert.notEqual(script, "", "SDK の器を束ねられる");
  page = await servePage(await findFreePort(), script);
});

after(async () => {
  await page?.close();
  page = null;
});

interface Participant {
  readonly label: string;
  readonly browser: Browser;
  readonly tab: Page;
  /** 器の実行が終わったときに解決する。記録を返す。 */
  readonly finished: Promise<unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

function readList<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * ノードの計数を読む（`observability.md`）。
 *
 * **どの層で止まったかを層ごとの数で決める**（X-054）。段 E では音声が戻らなかったため、
 * 音声の経路（`ash` 中継と `ar` 受信）も読む。
 */
async function nodeCounters(
  host: string,
  meetingId: string,
  role: string,
  party: string,
  room: string,
): Promise<string> {
  const secret = await deriveMeetingSecret(new TextEncoder().encode(DEV_NODE_KEY), meetingId);
  if (!secret.ok) {
    return `${role}: 秘密を作れない`;
  }
  const tag = await nodeAuthTag(secret.value, room, role, nodeAuthTimeWindow(Math.trunc(Date.now() / 1000)));
  if (!tag.ok) {
    return `${role}: 印を作れない`;
  }
  try {
    const response = await fetch(`https://${host}/parties/${party}/${room}`, {
      headers: { "x-wheso-node-role": role, "x-wheso-node-auth": tag.value },
    });
    if (response.status !== 200) {
      return `${role}: status=${String(response.status)}`;
    }
    const body: unknown = await response.json();
    const record = asRecord(body);
    const counters = asRecord(record["counters"]);
    const subs = readList<unknown>(record["subscriptions"]).map((entry) => {
      const item = asRecord(entry);
      return `${String(item["subscriberId"])}<-${String(item["targetId"])} ch=${String(item["channel"])} ${String(
        item["congestion"],
      )} stalled=${String(item["stalled"])}`;
    });
    // ack の間隔は「窓が閉じるか」を決める（congestion.md 2 節）。分位で出す。
    const acks = readList<number>(record["ackIntervalsMs"])
      .slice()
      .sort((left, right) => left - right);
    const at = (ratio: number): number => acks[Math.min(acks.length - 1, Math.trunc(acks.length * ratio))] ?? 0;
    const ackText =
      acks.length === 0
        ? ""
        : ` ack間隔=[件数 ${String(acks.length)} p50 ${String(at(0.5))} p90 ${String(at(0.9))} p99 ${String(
            at(0.99),
          )} 最大 ${String(acks[acks.length - 1] ?? 0)}]`;
    return (
      `${role}: in=${String(counters["binaryIn"] ?? counters["upstreamBinaryIn"])}` +
      ` out=${String(counters["binaryOut"] ?? counters["toClient"])}` +
      ` drops=${JSON.stringify(record["drops"])} clients=${String(record["clients"])}` +
      ` streams=${JSON.stringify(record["streams"])}` +
      ackText +
      (subs.length > 0 ? ` subs=[${subs.join(" | ")}]` : "")
    );
  } catch (error) {
    return `${role}: 読めない ${error instanceof Error ? error.message : "不明"}`;
  }
}

/** 参加者 1 人を**別のブラウザ**で起こす（主筋を分ける。F-071）。 */
async function startParticipant(
  spec: { readonly label: string; readonly base: string; readonly userId: string; readonly send: boolean },
  meetingId: string,
  participantCount: number,
  durationMs: number,
  logs: string[],
): Promise<Participant> {
  const pageRef = page;
  if (pageRef === null) {
    throw new Error("ページを配れていない");
  }
  const instance = await chromium.launch({ args: [...FAKE_MEDIA_ARGS] });
  const tab = await instance.newPage();
  tab.on("pageerror", (error) => logs.push(`${spec.label} pageerror: ${error.message}`));
  await tab.goto(`http://127.0.0.1:${String(pageRef.port)}/`);
  await tab.waitForFunction("typeof window.__whesoDegradeOne === 'function'", undefined, { timeout: 30_000 });
  const finished = tab.evaluate(
    async ([specJson, meeting, tokenKey, count, duration]) => {
      const runner = window.__whesoDegradeOne;
      if (runner === undefined) {
        return null;
      }
      const parsed: unknown = JSON.parse(String(specJson));
      const item: Record<string, unknown> = typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
      return await runner(
        {
          label: String(item["label"]),
          base: String(item["base"]),
          userId: String(item["userId"]),
          send: item["send"] === true,
        },
        String(meeting),
        String(tokenKey),
        Number(count),
        Number(duration),
      );
    },
    [JSON.stringify(spec), meetingId, DEV_TOKEN_KEY, String(participantCount), String(durationMs)],
  );
  return { label: spec.label, browser: instance, tab, finished };
}

/** 走行中の計数を読む。ページが忙しいと読めないことがあるため失敗を許す。 */
async function counts(participant: Participant): Promise<Record<string, number>> {
  try {
    const raw: unknown = await participant.tab.evaluate(() => {
      const reader = window.__whesoCounts;
      return reader === undefined ? {} : reader();
    });
    const record = asRecord(raw);
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(record)) {
      out[key] = num(value);
    }
    return out;
  } catch {
    return {};
  }
}

test("**段 E: 再デプロイと切断を挟んでも送受信が続き、自力で復旧する**", { timeout: 3_600_000 }, async () => {
  const liveRef = live;
  assert.ok(liveRef !== null, "実環境が用意されている");
  if (liveRef === null) {
    return;
  }
  const seconds = durationSec();
  const meetingId = newMeetingId();
  const base = `https://${liveRef.host}`;
  const logs: string[] = [];

  const sender = await startParticipant(
    { label: "送信", base, userId: USER_SENDER, send: true },
    meetingId,
    2,
    seconds * 1000,
    logs,
  );
  const receiver = await startParticipant(
    { label: "受信", base, userId: USER_RECEIVER, send: false },
    meetingId,
    2,
    seconds * 1000,
    logs,
  );

  const startedAt = Date.now();
  const redeployAtMs = startedAt + Math.trunc((seconds * 1000) / 3);
  const dropAtMs = startedAt + Math.trunc((seconds * 1000 * 2) / 3);
  let redeployDoneAtMs = 0;
  let redeployOk = false;
  let droppedLinks = 0;
  let dropDoneAtMs = 0;
  /** 切断の直後に提示が戻るまでの時間。戻らなければ 0 のままである。 */
  let recoveredAfterMs = 0;
  let presentedAtDrop = 0;

  // 経過を刻みながら、決めた時点で再デプロイと切断を起こす。
  while (Date.now() - startedAt < seconds * 1000) {
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
    const now = Date.now();
    const senderCounts = await counts(sender);
    const receiverCounts = await counts(receiver);
    process.stdout.write(
      `刻み ${String(Math.trunc((now - startedAt) / 1000))} 秒: ` +
        `送 ${String(senderCounts["sentVideo"] ?? 0)} / 到着 ${String(receiverCounts["arrived"] ?? 0)}` +
        ` / 提示 ${String(receiverCounts["presented"] ?? 0)}` +
        ` / 音声 ${String(receiverCounts["playedAudio"] ?? 0)}` +
        ` / 復号器 生成 ${String(receiverCounts["decoderCreated"] ?? 0)} 失敗 ${String(
          receiverCounts["decoderFailed"] ?? 0,
        )}` +
        ` / 切断 ${String(receiverCounts["closures"] ?? 0)}\n`,
    );

    if (redeployDoneAtMs === 0 && now >= redeployAtMs) {
      // **送信を止めずに再デプロイする。** 実行環境は古い実体を動かし続けるため、
      // 既存の接続は切れない。
      process.stdout.write("再デプロイを始める\n");
      redeployOk = await deployLive();
      redeployDoneAtMs = Date.now();
      process.stdout.write(`再デプロイ ${redeployOk ? "成功" : "失敗"}（${String(redeployDoneAtMs - now)} ms）\n`);
    }

    if (dropDoneAtMs === 0 && redeployDoneAtMs > 0 && now >= dropAtMs) {
      // **経路を故意に落とす。** 再接続の経路を通すために要る（5.11.2）。
      presentedAtDrop = receiverCounts["presented"] ?? 0;
      const closed: unknown = await receiver.tab.evaluate(() => {
        const dropper = window.__whesoDropLinks;
        return dropper === undefined ? "" : dropper();
      });
      const detail = typeof closed === "string" ? closed : "";
      droppedLinks = detail === "" ? 0 : detail.split(",").length;
      dropDoneAtMs = Date.now();
      process.stdout.write(`受信側の接続を落とした: ${detail}\n`);
    }

    // **層ごとの数を毎回刻む。** 止まった瞬間の層を後から特定できるようにする（X-054）。
    const videoShard = await nodeCounters(liveRef.host, meetingId, "shard", "shard", `vsh-${meetingId}-auto-1-0`);
    const videoReceiver = await nodeCounters(
      liveRef.host,
      meetingId,
      "receiver",
      "receiver",
      `vr-${meetingId}-${USER_RECEIVER}`,
    );
    process.stdout.write(`  映像の中継: ${videoShard}\n  映像の受信: ${videoReceiver}\n`);

    if (dropDoneAtMs > 0 && recoveredAfterMs === 0) {
      const presented = receiverCounts["presented"] ?? 0;
      if (presented > presentedAtDrop) {
        recoveredAfterMs = now - dropDoneAtMs;
        process.stdout.write(`切断から ${String(recoveredAfterMs)} ms で提示が戻った\n`);
      }
    }
  }

  const senderRaw = asRecord(await sender.finished);
  const receiverRaw = asRecord(await receiver.finished);
  // **節点の側の状態を、頁を閉じる前に読む。** 復旧しなかったとき、原因が
  // 「クライアントが購読を送り直していない」のか「節点が上流を張れていない」のかは、
  // 節点の購読表（`streams`）と上流の状態を見なければ区別できない。
  const receiverNode = await nodeCounters(
    liveRef.host,
    meetingId,
    "receiver",
    "receiver",
    `vr-${meetingId}-${USER_RECEIVER}`,
  );
  // 送信ノードの側は ack の間隔と窓の破棄を持つ（Q-027 の判断材料）。
  const senderNode = await nodeCounters(
    liveRef.host,
    meetingId,
    "sender",
    "sender",
    `vs-${meetingId}-${USER_SENDER}`,
  );
  await sender.tab.close();
  await receiver.tab.close();
  await sender.browser.close();
  await receiver.browser.close();

  const run: ObservedRun = {
    sentVideo: readList(senderRaw["sentVideo"]),
    sentAudio: readList(senderRaw["sentAudio"]),
    received: readList(receiverRaw["received"]),
    decoded: readList(receiverRaw["decoded"]),
    playedAudio: readList(receiverRaw["playedAudio"]),
    arrived: readList(receiverRaw["arrived"]),
    keyframeRequestAtMs: readList(receiverRaw["keyframeRequestAtMs"]),
    closures: readList(receiverRaw["closures"]),
    lastSentAtMs: num(senderRaw["lastSentAtMs"]),
    windowClosedAtMs: num(senderRaw["windowClosedAtMs"]),
  };
  const built = buildDegradeRecord(run);
  const decoderIo = asRecord(receiverRaw["decoderIo"]);

  process.stdout.write(
    `段 E の実測（${String(seconds)} 秒）: 送 ${String(run.sentVideo.length)}` +
      ` / 判定対象 ${String(built.judgedSent)} / 到着 ${String(built.record.arrived?.length ?? 0)}` +
      ` / 提示 ${String(built.record.received.length)}` +
      ` / 音声（ワイヤ ${String(run.sentAudio.length)} / 再生 ${String(run.playedAudio.length)}）` +
      ` / 対 ${String(built.record.playedAudio?.length ?? 0)}` +
      ` / 復号器（生成 ${String(num(decoderIo["created"]))} 投入 ${String(num(decoderIo["submitted"]))}` +
      ` 出力 ${String(num(decoderIo["output"]))} 失敗 ${String(num(decoderIo["failed"]))}）` +
      ` / 要求 ${String(built.record.keyframeRequests)} / 連鎖切れ ${String(built.chainBreaks)}` +
      ` / 復旧 ${String(recoveredAfterMs)} ms` +
      ` / 部屋の開閉 ${readList<unknown>(receiverRaw["socketStats"])
        .map((entry) => {
          const item = asRecord(entry);
          return `${String(item["kind"])} 開 ${String(num(item["opened"]))} 閉 ${String(num(item["closed"]))} 最後 ${String(num(item["lastCode"]))}`;
        })
        .join(" / ")}` +
      ` / 節点 ${receiverNode} / ${senderNode}` +
      ` / 戻れない切断 ${(built.record.closures ?? []).join(", ") || "なし"}` +
      ` / 戻れた切断 ${built.transientClosures.join(", ") || "なし"}\n`,
  );

  // --- 判定 ---

  assert.equal(redeployOk, true, `途中の再デプロイが成功する（記録: ${logs.join(" | ")}）`);
  assert.ok(droppedLinks > 0, "受信側の接続を実際に落とした（落とせなければ再接続を試験できない）");
  assert.ok(
    recoveredAfterMs > 0 && recoveredAfterMs <= RECOVERY_TIMEOUT_MS,
    `切断から ${String(RECOVERY_TIMEOUT_MS)} ms 以内に提示が戻る（実測 ${String(recoveredAfterMs)} ms）`,
  );
  assert.ok(built.record.received.length > 0, "映像を提示できている");
  assert.ok((built.record.playedAudio?.length ?? 0) > 0, "音声と映像の対がある");

  // **復号器は壊れたままにならない。** 規範は「復号の失敗が起きない」ことを約束しない。
  // 約束するのは**映像が止まらない**ことである（ADR-0047）。したがって見るのは 2 点である。
  //
  //   1. 失敗のたびに作り直している（`created >= failed`）
  //   2. **最後まで提示が続いている**（窓を閉じる直前の 10 秒に提示がある）
  //
  // 出力と投入の比を閾値にしてはならない。キーフレームを待つ間の欠落は規範どおりであり、
  // 比は待ち時間の長さで動く（実測: 同じ実装で 82% と 99% の回があった）。
  const created = num(decoderIo["created"]);
  const failed = num(decoderIo["failed"]);
  assert.ok(
    created >= failed,
    `復号の失敗のたびに作り直している（生成 ${String(created)} / 失敗 ${String(failed)}）`,
  );
  const windowClosedAt = run.windowClosedAtMs > 0 ? run.windowClosedAtMs : run.lastSentAtMs;
  const tailFrom = windowClosedAt - 10_000;
  const tailPresented = built.record.received.filter((entry) => entry.atMs >= tailFrom).length;
  assert.ok(
    tailPresented > 0,
    `最後の 10 秒でも提示が続いている（提示 ${String(tailPresented)} 枚）`,
  );
  // 音声も最後まで続いている（**音声は決して止めない**）。
  const tailAudio = run.playedAudio.filter((entry) => entry.atMs >= tailFrom).length;
  assert.ok(tailAudio > 0, `最後の 10 秒でも音声が続いている（再生 ${String(tailAudio)} 件）`);

  // 受入条件の判定。**切断を含むため間隔の上限は遮断のある段と同じにする**（C-2）。
  // 連鎖が切れた回数と、切断からの復帰ぶんのキーフレーム要求を許す。
  const violations = judgeAll(built.record, {
    maxGapMs: IMPAIRMENT_MAX_GAP_WITH_OUTAGE_MS,
    requireComplete: false,
    allowedKeyframeRequests: built.chainBreaks + built.switches.filter((entry) => entry.up).length + 2,
  });
  // C-1（描画の間隔）は切断の間の停止を含むため別に見る。
  // B-2（破棄できない層の欠落）は送信窓の破棄であり、原因と選択肢は Q-027 に登録済みである。
  // **混ぜて 1 つの判定にしてはならない。** 混ぜると、復旧の欠陥と窓の設定の未決を
  // 区別できなくなる。
  const recovery = violations.filter(
    (entry) => entry.judgement !== "C-1" && entry.judgement !== "B-2" && entry.judgement !== "D-1",
  );
  assert.deepEqual(
    recovery.map((entry) => `${entry.judgement}: ${entry.detail}`),
    [],
    `切断と再デプロイからの復旧に欠陥が無い（提示 ${String(built.record.received.length)}）`,
  );

  // **切断の間は同期を測らない。** 切断の間、音声は止まる（経路が無い）。その期間の映像に
  // 「対応する音声が無い」と言っても、それは同期の失敗ではなく経路の断である。規範の
  // 再生クロックも不連続として作り直す（ADR-0028、`noteAudio` の resync）。切断の時刻は
  // 試験が知っているため、その窓を外して測る。**外すのは D-1 だけ**である。
  // **試験が起こした中断は 2 つある**（切断だけではない）。再デプロイは実行環境の全ノードを
  // 作り直すため、同じだけ媒体が途切れる。**片方だけ外すと、外し忘れた側のずれが違反として
  // 現れる**（実測: 再デプロイ直後の 1 組だけで D-1 が赤になった）。復旧に要した時間は
  // 切断について測っているため、再デプロイ側は同じ幅を使う（どちらも全ノードの作り直しで
  // ある）。3 秒はクロックの作り直しが落ち着くまでの余裕である（ADR-0028）。
  const settleMs = recoveredAfterMs + 3000;
  const interruptions: readonly { readonly from: number; readonly to: number }[] = [
    { from: redeployAtMs, to: redeployDoneAtMs + settleMs },
    { from: dropDoneAtMs, to: dropDoneAtMs + settleMs },
  ];
  // **音声の側を間引いてはならない。** D-1 は「映像 1 枚に対応する音声が鳴ったか」を見る。
  // 両方を同じ窓で間引くと、窓の外の映像に対応する音声だけが消え、**健全な組が違反として
  // 現れる**（実測: 中断の境目で frameIndex 321〜330 の 10 組が「音声が無い」と読まれた）。
  // 判定するのは映像の側だけを間引き、対応先の音声は全部残す。境目の組も外れるように、
  // 映像の窓は前後へ `settleMs` ぶん広げる。
  const syncRecord = {
    ...built.record,
    presentedVideo: (built.record.presentedVideo ?? []).filter(
      (entry) =>
        !interruptions.some(
          (window) => entry.atMs >= window.from - settleMs && entry.atMs <= window.to + settleMs,
        ),
    ),
  };
  const skew = judgeAvSkew(syncRecord, AV_SKEW_AUDIO_LEAD_MAX_MS, AV_SKEW_AUDIO_LAG_MAX_MS);
  assert.deepEqual(
    skew.map((entry) => `${entry.judgement}: ${entry.detail}`),
    [],
    `中断の窓の外では音声と映像のずれが許容の内側である（対 ${String(
      syncRecord.presentedVideo?.length ?? 0,
    )} 組・違反 ${String(skew.length)} 件・最初の 3 件 ${skew
      .slice(0, 3)
      .map((entry) => entry.detail)
      .join(" / ")}）`,
  );

  const drops = violations.filter((entry) => entry.judgement === "B-2");
  assert.deepEqual(
    drops.map((entry) => `${entry.judgement}: ${entry.detail}`),
    [],
    `送信窓の破棄が無い（**Q-027 の決定を待っている**。申告 fps と取得 fps が割り切れないため` +
      `窓が数回閉じる。連鎖切れ ${String(built.chainBreaks)} 件）`,
  );
});
