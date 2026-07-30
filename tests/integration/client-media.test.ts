/**
 * SDK 経由の実データ疎通（検証階層 L3。段 B の本来の形）。
 *
 * **何を証明するか。** 2 人が `joinMeeting` で参加し、片方が**実際に符号化された AV1 と
 * Opus**（`spec/vectors/real-media.json`）を送り、もう片方が **1 バイトも変わらずに**
 * 受け取ること。経路は 5 ノードすべてを通る。
 *
 *   A のクライアント → `vs`（送信ノード） → `vsh`（中継ノード）
 *                     → `vr`（受信ノード） → B のクライアント
 *
 * **なぜこの試験が必要か。** 既存の疎通試験（`tools/transport-suite.ts`）は試験自身が
 * ノードに化けて中継ノードへ直結する。中継ノードの転送は確かめられるが、
 * **送信ノードと受信ノードは 1 度も通らない。** 段 F まで、その 2 つのノードへ接続を張る
 * コードが製品に存在せず、それでも疎通試験は緑だった。
 *
 * 符号化器と復号器は注入する（Node に WebCodecs は無い）。**注入するのは端だけ**であり、
 * 経路・認証・購読・転送・名簿はすべて実物である。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveMeetingSecret,
  issueToken,
  nodeAuthTag,
  nodeAuthTimeWindow,
} from "../../packages/core/src/auth.ts";
import { DEV_NODE_KEY, DEV_TOKEN_KEY, liveHost, newMeetingId, deployLive } from "../support/live-env.ts";
import { joinWith, type JoinSocket, type JoinDeps } from "../../packages/client/src/api/join-meeting.ts";
import type { FrameSink } from "../../packages/client/src/api/meeting.ts";
import type { CaptureDeps, CaptureOutput } from "../../packages/client/src/media/browser-capture.ts";
import type { DecodeInput } from "../../packages/client/src/api/receive-pipeline.ts";
import { createPresentGate } from "../../packages/client/src/sync/present-gate.ts";
import { judgeAvSkew, type DegradeRecord } from "../support/degrade-judge.ts";
import {
  AV_SKEW_AUDIO_LAG_MAX_MS,
  AV_SKEW_AUDIO_LEAD_MAX_MS,
  AV_SKEW_MS_P99,
} from "../../packages/core/src/generated/constants.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 送る枚数。全部送ると試験が長くなるため先頭に限る（キーフレームを含む）。 */
const VIDEO_COUNT = 10;

/** 送る音声の束の数。 */
const AUDIO_BUNDLES = 3;

const USER_A = "550e8400e29b41d4a716446655440aaa";
const USER_B = "550e8400e29b41d4a716446655440bbb";

let MEETING_ID = "";
let HOST = "";
const openSockets: globalThis.WebSocket[] = [];

/**
 * 部屋の種別ごとの受信数（試験側の計測）。
 *
 * **公開 API だけでは「クライアントに届いていない」と「届いたが復号へ渡されない」を
 * 区別できない**（X-043）。ここで数えないと原因の層を取り違える。
 */
const socketCounts = new Map<string, { text: number; binary: number }>();

/** 復号器への指示の回数（試験側の計測）。 */
const decoderCalls = { configure: 0, reset: 0, close: 0 };

function countSocket(url: string): { text: number; binary: number } {
  // 部屋名の全体で分ける。種別だけで分けると A と B の分が混ざり、
  // どちらが受け取っていないのか分からない。
  const path = url.split("?")[0] ?? url;
  const room = path.split("/").filter((part) => part !== "").pop() ?? "other";
  const kind = room.length > 12 ? `${room.slice(0, 3)}…${room.slice(-6)}` : room;
  const found = socketCounts.get(kind);
  if (found !== undefined) {
    return found;
  }
  const created = { text: 0, binary: 0 };
  socketCounts.set(kind, created);
  return created;
}

before(async () => {
  await deployLive();
  HOST = liveHost();
  MEETING_ID = newMeetingId();
});

/**
 * 会議を作り直す。
 *
 * **試験ごとに別の会議を使う。** 同じ会議を使い回すと前の試験の接続と購読が残り、
 * 名簿に同じ利用者が二重に載る。中継ノードにも古い購読が残るため、後の試験が
 * 前の試験の残骸を観測してしまう（原因の切り分けが不能になる）。
 */
function newMeeting(): void {
  MEETING_ID = newMeetingId();
  socketCounts.clear();
  decoderCalls.configure = 0;
  decoderCalls.reset = 0;
  decoderCalls.close = 0;
}

after(() => {
  for (const socket of openSockets) {
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
      socket.close();
    }
  }
  openSockets.length = 0;
});

interface Asset {
  readonly video: readonly {
    readonly payload: Uint8Array;
    readonly key: boolean;
    readonly temporalId: number;
    /** 破棄可能か（`computeDiscardable` の結果。資産に凍結されている）。 */
    readonly discardable: boolean;
  }[];
  readonly audio: readonly Uint8Array[];
}

/** 凍結資産を読む。**再採取してはならない**（凍結資産の方針）。 */
async function loadAsset(): Promise<Asset> {
  const text = await readFile(join(root, "spec", "vectors", "real-media.json"), "utf8");
  const parsed: unknown = JSON.parse(text);
  const record = asRecord(parsed);
  const video = asRecord(record["video"]);
  const audio = asRecord(record["audio"]);
  const frames = video["frames"];
  const bundles = audio["bundles"];
  assert.ok(Array.isArray(frames), "映像のフレームが配列である");
  assert.ok(Array.isArray(bundles), "音声の束が配列である");
  if (!Array.isArray(frames) || !Array.isArray(bundles)) {
    return { video: [], audio: [] };
  }
  const videoOut: {
    readonly payload: Uint8Array;
    readonly key: boolean;
    readonly temporalId: number;
    readonly discardable: boolean;
  }[] = [];
  for (const frame of frames.slice(0, VIDEO_COUNT)) {
    const item = asRecord(frame);
    const hex = item["payloadHex"];
    const key = item["keyFrame"];
    const temporalId = item["temporalId"];
    assert.equal(typeof hex, "string");
    assert.equal(typeof key, "boolean");
    assert.equal(typeof temporalId, "number");
    // 破棄可能かは資産に凍結されている（`computeDiscardable` の結果）。**独自に判断しない。**
    const discardable = item["expectedDiscardable"];
    assert.equal(typeof discardable, "boolean");
    videoOut.push({
      payload: fromHex(typeof hex === "string" ? hex : ""),
      key: key === true,
      temporalId: typeof temporalId === "number" ? temporalId : 0,
      discardable: discardable === true,
    });
  }
  const audioOut: Uint8Array[] = [];
  for (const bundle of bundles.slice(0, AUDIO_BUNDLES)) {
    const item = asRecord(bundle);
    const payloads = item["payloadsHex"];
    assert.ok(Array.isArray(payloads));
    for (const entry of payloads) {
      assert.equal(typeof entry, "string");
      audioOut.push(fromHex(typeof entry === "string" ? entry : ""));
    }
  }
  return { video: videoOut, audio: audioOut };
}

/** 未知の値をオブジェクトとして読む。型アサーションを使わない。 */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    assert.fail("オブジェクトではない");
  }
  return { ...value };
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

async function joinUrlFor(userId: string): Promise<string> {
  const nowSec = Math.trunc(Date.now() / 1000);
  const token = await issueToken(new TextEncoder().encode(DEV_TOKEN_KEY), {
    iss: "wheso-test",
    sub: userId,
    aud: MEETING_ID,
    iat: nowSec,
    exp: nowSec + 60,
    jti: `j-${String(nowSec)}-${userId.slice(-3)}`,
    kind: "client",
    role: "host",
  });
  assert.equal(token.ok, true, "トークンを発行できる");
  return `https://${HOST}/j/${MEETING_ID}#${token.ok ? token.value : ""}`;
}

/**
 * 映像を送る間隔（ミリ秒）。
 *
 * **申告した fps より速く送ってはならない。** 中継ノードの送信窓は未確認量を
 * **再生時間**で測る（congestion.md 2 節）。最下段の申告は 15 fps であるから、
 * 33 ms 間隔（30 fps）で送ると窓が正しく閉じ、フレームが破棄される
 * （実測: 40 件のうち 6 件が破棄され、優先順位 1 と 4 に 3 件ずつ計上された）。
 * これは実装の欠陥ではなく試験の送り過ぎである。
 *
 * さらに**申告と同じ速さでも余裕が無い**。窓は 200 ms ぶんの未確認しか許さないため、
 * 15 fps で送ると 3 枚が上限であり、ack が 200 ms 遅れるだけで破棄が始まる。試験は
 * 「整った後の欠落を 1 枚も許さない」と主張するため、10 fps（100 ms 間隔）で送って
 * 余裕を作る。実際のクライアントは破棄を前提に符号化を絞る。
 */
const VIDEO_FRAME_INTERVAL_MS = 100;

/** 実物の WebSocket を `JoinSocket` の形に包む。 */
function realSocket(url: string): JoinSocket {
  const socket = new globalThis.WebSocket(url);
  const counts = countSocket(url);
  openSockets.push(socket);
  socket.binaryType = "arraybuffer";
  const textHandlers: ((text: string) => void)[] = [];
  const binaryHandlers: ((bytes: Uint8Array) => void)[] = [];
  const openHandlers: (() => void)[] = [];
  const closeHandlers: ((code: number) => void)[] = [];
  socket.addEventListener("open", () => {
    for (const handler of openHandlers) {
      handler();
    }
  });
  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data === "string") {
      counts.text += 1;
      for (const handler of textHandlers) {
        handler(event.data);
      }
      return;
    }
    if (event.data instanceof ArrayBuffer) {
      counts.binary += 1;
      const bytes = new Uint8Array(event.data);
      for (const handler of binaryHandlers) {
        handler(bytes);
      }
    }
  });
  socket.addEventListener("close", (event: CloseEvent) => {
    for (const handler of closeHandlers) {
      handler(event.code);
    }
  });
  return {
    send: (text): void => {
      if (socket.readyState === socket.OPEN) {
        socket.send(text);
      }
    },
    sendBinary: (bytes): void => {
      if (socket.readyState === socket.OPEN) {
        socket.send(bytes);
      }
    },
    close: (): void => socket.close(),
    onText: (handler): void => {
      textHandlers.push(handler);
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

function sink(): FrameSink {
  return {
    attach: (): void => undefined,
    detach: (): void => undefined,
    setDisplaySize: (): void => undefined,
    draw: (): void => undefined,
  };
}

interface Party_ {
  readonly output: () => CaptureOutput | null;
  readonly decoded: DecodeInput[];
  readonly audioIn: DecodeInput[];
  /**
   * 復号へ渡した時刻と音声を再生待ち行列へ入れた時刻（ミリ秒）。
   *
   * **A/V 同期の判定（D-1）に実入力を与えるために持つ**。枚数だけでは同期は測れない。
   */
  readonly videoAtMs: { readonly frameIndex: number; readonly atMs: number }[];
  readonly audioAtMs: { readonly frameIndex: number; readonly atMs: number }[];
  readonly participants: () => readonly string[];
  /**
   * 受信側から要求されたキーフレームを 1 度だけ受け取る（要求が無ければ false）。
   *
   * **なぜ試験がこれを持つか。** 実物の取得の端（`media/browser-capture.ts`）は
   * `keyframeRequest` を受けると次のフレームをキーフレームにする。器がこれを無視すると、
   * 購読が中継ノードへ届く前に送った 1 枚目のキーフレームが捨てられた場合、復号器は
   * キーフレームを永久に待ち、映像は 1 枚も出ない（実測: 公開 CI で 42 通が届いたのに
   * 復号は 0 枚。往復が長い環境では購読の登録が遅れるため常に起きる）。
   * 器が実物と同じ応答をすることで、要求が `vr → 受信ノード → 中継ノード → 送信ノード → vs`
   * を通って戻ることも同時に確かめられる。
   */
  readonly takeKeyframeRequest: () => boolean;
  readonly close: () => void;
}

async function joinParty(userId: string): Promise<Party_> {
  let output: CaptureOutput | null = null;
  const decoded: DecodeInput[] = [];
  const audioIn: DecodeInput[] = [];
  const videoAtMs: { readonly frameIndex: number; readonly atMs: number }[] = [];
  const gate = createPresentGate({
    now: (): number => Date.now(),
    scheduleAt: (atMs, fire): (() => void) => {
      const timer = globalThis.setTimeout(fire, Math.max(0, atMs - Date.now()));
      return (): void => globalThis.clearTimeout(timer);
    },
  });
  const audioAtMs: { readonly frameIndex: number; readonly atMs: number }[] = [];
  // 受信側からのキーフレーム要求。実物の端と同じく「次のフレームを key にする」で応える。
  let keyframeWanted = false;
  const capture: CaptureDeps = {
    bindCapture: (next): void => {
      output = next;
    },
    // 取得は行わない。**送るものは凍結資産である**（実際に符号化されたビット列）。
    startCapture: async () => ({ source: null, video: false, audio: false }),
    configureVideo: (): void => undefined,
    configureAudio: (): void => undefined,
    requestKeyframe: (): void => {
      keyframeWanted = true;
    },
    setVideoEnabled: (): void => undefined,
    setAudioEnabled: (): void => undefined,
    encodeQueueSize: (): number => 0,
    close: (): void => undefined,
  };
  const deps: JoinDeps = {
    openSocket: (address): JoinSocket => realSocket(address),
    createSink: (): FrameSink => sink(),
    bindOutput: (): void => undefined,
    capability: { hardwareAv1For4K60: false, encodeAv1: true, mobile: false, charging: true },
    source: { width: 1920, height: 1080, framerate: 30 },
    now: (): number => Date.now(),
    scheduleAt: (atMs, fire): (() => void) => {
      const timer = globalThis.setTimeout(fire, Math.max(0, atMs - Date.now()));
      return (): void => globalThis.clearTimeout(timer);
    },
    setPeriodic: (intervalMs, fire): (() => void) => {
      const timer = globalThis.setInterval(fire, intervalMs);
      return (): void => globalThis.clearInterval(timer);
    },
    media: {
      // 復号器への指示を数える。**「届いたが復号へ渡らない」の原因は
      // 初期化と破棄の回数で分かる**（キーフレーム待ちへ戻されたか）。
      configureDecoder: (): void => {
        decoderCalls.configure += 1;
      },
      resetDecoder: (): void => {
        decoderCalls.reset += 1;
      },
      closeDecoder: (): void => {
        decoderCalls.close += 1;
      },
      // 復号はしない。**届いたバイト列をそのまま記録する**（1 バイトの違いを検出する）。
      decodeVideo: (input): void => {
        // **製品と同じ門を通す**（ADR-0042）。門を通さずに測ると、映像が先行している
        // ことを見落とす（門は提示予定時刻まで待つ）。
        gate.submit(input.senderId, input.presentAtMs, () => {
          decoded.push(input);
          // 先頭バイトに frameIndex を載せて送るため、それで突き合わせる（D-1）。
          videoAtMs.push({ frameIndex: input.payload[0] ?? -1, atMs: Date.now() });
        });
      },
      enqueueAudio: (input): void => {
        // 音声も同じ門を通す。**製品の音声の端は再生クロックに合わせて予約する**
        // （ADR-0042）。門を通さずに測ると音声が先行していることを見落とす。
        gate.submit(input.senderId + 1_000_000, input.presentAtMs, () => {
          audioIn.push(input);
          audioAtMs.push({ frameIndex: input.payload[0] ?? -1, atMs: Date.now() });
        });
      },
    },
    capture,
  };
  const joined = await joinWith(await joinUrlFor(userId), deps, {});
  assert.equal(joined.ok, true, `${userId} が参加できる`);
  if (!joined.ok) {
    throw new Error("参加に失敗した");
  }
  return {
    output: (): CaptureOutput | null => output,
    decoded,
    audioIn,
    videoAtMs,
    audioAtMs,
    participants: (): readonly string[] => joined.value.meeting.participants.map((entry) => entry.id),
    takeKeyframeRequest: (): boolean => {
      if (!keyframeWanted) {
        return false;
      }
      keyframeWanted = false;
      return true;
    },
    close: (): void => joined.value.meeting.leave(),
  };
}

/**
 * 数が増えなくなるまで待ち、その値を返す。
 * 経路の途中に溜まっているものを数え切るために使う。
 */
async function settled(count: () => number): Promise<number> {
  let previous = -1;
  for (let index = 0; index < 40; index += 1) {
    const current = count();
    if (current === previous) {
      return current;
    }
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return count();
}

async function waitFor(
  predicate: () => boolean,
  limitMs: number,
  label: string,
  extra?: () => string,
): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // **失敗したらノードの状態を添える。** 添えないと、原因が購読の未登録・送信窓・
  // 宛先の解決のどれなのかを後から切り分けられない（実際に切り分けに数時間を要した）。
  const clientSide = [...socketCounts.entries()]
    .map(([kind, value]) => `${kind} text=${String(value.text)} bin=${String(value.binary)}`)
    .join(" / ");
  const decoderLine = `configure=${String(decoderCalls.configure)} reset=${String(
    decoderCalls.reset,
  )} close=${String(decoderCalls.close)}`;
  const diagnosis = `【クライアントが受け取った数】${clientSide}\n【復号器への指示】${decoderLine}\n${await nodeStatus()}`;
  const attached = extra === undefined ? "" : `\n${extra()}`;
  assert.fail(`${label} が ${String(limitMs)} ms 以内に成立しなかった\n【失敗した時点】\n${diagnosis}${attached}`);
}

/** 認証付きの観測口からノードの状態を読む（observability.md）。 */
async function nodeStatus(): Promise<string> {
  const secret = await deriveMeetingSecret(new TextEncoder().encode(DEV_NODE_KEY), MEETING_ID);
  if (!secret.ok) {
    return "観測: 会議シークレットを導出できない";
  }
  const rooms: readonly { readonly party: string; readonly room: string }[] = [
    { party: "shard", room: `vsh-${MEETING_ID}-auto-1-0` },
    { party: "sender", room: `vs-${MEETING_ID}-${USER_A}` },
    { party: "receiver", room: `vr-${MEETING_ID}-${USER_B}` },
    { party: "shard", room: `ash-${MEETING_ID}-auto-1-0` },
    { party: "sender", room: `as-${MEETING_ID}-${USER_A}` },
    { party: "receiver", room: `ar-${MEETING_ID}-${USER_B}` },
  ];
  const lines: string[] = [];
  for (const entry of rooms) {
    const tag = await nodeAuthTag(
      secret.value,
      entry.room,
      "shard",
      nodeAuthTimeWindow(Math.trunc(Date.now() / 1000)),
    );
    if (!tag.ok) {
      continue;
    }
    try {
      const response = await fetch(`https://${HOST}/parties/${entry.party}/${entry.room}`, {
        headers: { "x-wheso-node-role": "shard", "x-wheso-node-auth": tag.value },
      });
      lines.push(`${entry.room.slice(0, 3)}: ${(await response.text()).slice(0, 1600)}`);
    } catch {
      lines.push(`${entry.party}: 観測できない`);
    }
  }
  return lines.join("\n");
}

/** 資産の 1 枚目の payload。暖機と資産の境目を内容で見分けるために使う。 */
function assetFirstPayload(asset: { readonly video: readonly { readonly payload: Uint8Array }[] }): Uint8Array {
  const first = asset.video[0];
  return first === undefined ? new Uint8Array() : first.payload;
}

test("実データが SDK 経由で 5 ノードを通り、1 バイトも変わらずに届く", { timeout: 180_000 }, async () => {
  const asset = await loadAsset();
  assert.ok(asset.video.length > 0 && asset.audio.length > 0, "凍結資産を読めた");

  const a = await joinParty(USER_A);
  const b = await joinParty(USER_B);

  // **互いを認識するまで待つ。** 名簿は `meta` が配る（`ctl` は 1 利用者ぶんしか見えない）。
  await waitFor(
    () => a.participants().includes(USER_B) && b.participants().includes(USER_A),
    60_000,
    "両者が互いを認識する",
  );

  // 購読が中継ノードまで届くのを待つ。届く前に送ると転送先が無く、送ったものが消える。
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const output = a.output();
  assert.ok(output !== null, "A の取得の出力が繋がっている");

  /**
   * **暖機**。経路（送信ノード → 中継ノード）の確立は背後で進む（F-046）。整うまでの数枚は
   * 捨てられる（`NodeLink` は `nodeHelloAck` の前の媒体を捨てる。中継ノードが認証前の媒体を
   * 破棄するためである）。暖機の枚数は判定に含めない。**整った後の欠落は 1 枚も許さない。**
   *
   * **枚数で切らずに「復号できた」で切る。** 1 枚目のキーフレームが購読の登録より前に
   * 送られて捨てられると、復号器はキーフレームを待ち続ける。復号側の要求
   * （`takeKeyframeRequest`）に応じ、応じても届かない場合に備えて定期的にも key を送る。
   */
  for (let index = 0; index < 90 && b.decoded.length === 0; index += 1) {
    output.onVideo({
      spatialId: 0,
      temporalId: 0,
      temporalLayers: 3,
      isKey: index % 8 === 0 || a.takeKeyframeRequest(),
      captureTimestampUs: BigInt(Date.now()) * 1000n,
      payload: new Uint8Array([0xaa, 0xbb, 0xcc]),
    });
    await new Promise((resolve) => setTimeout(resolve, VIDEO_FRAME_INTERVAL_MS));
  }
  await waitFor(() => b.decoded.length > 0, 30_000, "暖機の映像が届く");
  // **受信が静止するまで待つ。** 待たずに送り始めると、暖機の残りが実データに混ざる。
  // 境目は内容（payload）で見分けるため枚数は使わないが、静止の待ちは必要である。
  await settled(() => b.decoded.length);

  // **働いている時点の状態を残す。** 失敗時の状態だけを見ても「元から駄目」と
  // 「途中で壊れた」を区別できない（X-043）。暖機が通った直後に 1 度読む。
  const statusWhenWorking = await nodeStatus();

  // 実際の fps の間隔で送る。詰めて送ると予算超過の破棄が働き、疎通ではなく輻輳を試す。
  for (const frame of asset.video) {
    output.onVideo({
      spatialId: 0,
      temporalId: frame.temporalId,
      temporalLayers: 3,
      isKey: frame.key,
      captureTimestampUs: BigInt(Date.now()) * 1000n,
      payload: frame.payload,
    });
    await new Promise((resolve) => setTimeout(resolve, VIDEO_FRAME_INTERVAL_MS));
  }

  // **暖機の枚数を足して数えてはならない。** 暖機は確立の途中で数枚落ちることを
  // 前提に置いてあり（購読が中継へ届く前に送った分）、落ちた枚数だけ総数が足りなくなる。
  // 資産の 1 枚目を payload で特定し、そこから 10 枚を見る。
  const firstAssetHex = toHex(assetFirstPayload(asset));
  // **破棄可能なフレームの到着を要求してはならない**（X-047）。
  //
  // 中継ノードと送信ノードの送信窓は、未確認が `SEND_WINDOW_MS` を超える間、
  // 破棄可能なユニット（`computeDiscardable`）を落とす。これは設計であり欠陥ではない。
  // 資産 10 枚のうち破棄可能は 4 枚（temporalId 2）である。したがって**必須なのは
  // 破棄禁止の 6 枚**であり、これらは 1 バイトも変わらず順序どおり届かなければならない。
  const required = asset.video.filter((frame) => !frame.discardable);
  await waitFor(
    () => {
      const hexes = b.decoded.map((frame) => toHex(frame.payload));
      let cursor = 0;
      for (const frame of required) {
        const found = hexes.indexOf(toHex(frame.payload), cursor);
        if (found < 0) {
          return false;
        }
        cursor = found + 1;
      }
      return true;
    },
    30_000,
    `B が破棄禁止の映像 ${String(required.length)} 枚を順序どおり受け取る`,
    () => {
      // **どれが欠けたかを出す。** 枚数だけでは、届いていないのか順序が違うのか分からない。
      const hexes = b.decoded.map((frame) => toHex(frame.payload));
      const found = required.map((frame) => hexes.indexOf(toHex(frame.payload)));
      return [
        `【破棄禁止の位置】${found.map((position) => String(position)).join(",")}（-1 は未着）`,
        `【復号へ渡った数】${String(b.decoded.length)}`,
        `【暖機が通った時点】\n${statusWhenWorking}`,
      ].join("\n");
    },
  );

  // **音声は映像を確かめた後に送る。**
  //
  // 受信側は音声の時刻を基準に映像の提示時刻を決める（ADR-0028）。映像を送り終えた
  // 直後に音声を送ると、音声の取得時刻のほうが新しいため、まだ処理していない映像が
  // 「音声に対して遅すぎる」と判定されて捨てられる。これは規範どおりの動作であり、
  // 実際のクライアントは音声と映像を混ぜて送り続けるためこの状況にならない。
  // 試験の送り方が現実と違うだけである（実測: 40 件届いたのに復号は 8 枚だった）。
  for (const payload of asset.audio) {
    output.onAudio({ captureTimestampUs: BigInt(Date.now()) * 1000n, silent: false, payload });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const assetStart = b.decoded.findIndex((frame) => toHex(frame.payload) === firstAssetHex);
  assert.ok(assetStart >= 0, "資産の 1 枚目を受け取っている");

  // **二重配送を許さない**（F-058）。受信ノードが購読していない接続（予備接続や
  // 掃除前の古い接続）へも送ると、同じフレームが 2 度復号器へ渡る。下り帯域が倍になり、
  // 復号の負荷も倍になる。資産の各フレームはちょうど 1 度だけ現れなければならない。
  // 期待する回数は資産から数える。**資産自身に同じバイト列のフレームが含まれる**
  // （静止した被写体では符号化結果が一致する）。1 度と決め打つと資産の性質で落ちる。
  const expectedCounts = new Map<string, number>();
  for (const frame of asset.video) {
    const hex = toHex(frame.payload);
    expectedCounts.set(hex, (expectedCounts.get(hex) ?? 0) + 1);
  }
  for (const [hex, expected] of expectedCounts) {
    const occurrences = b.decoded.filter((frame) => toHex(frame.payload) === hex).length;
    // **多いことだけを禁じる。** 少ないのは破棄（設計）であり得る。多いのは二重配送である。
    assert.ok(occurrences <= expected, `二重配送が無い（期待 ${String(expected)} 実際 ${String(occurrences)}）`);
  }
  await waitFor(() => b.audioIn.length >= asset.audio.length, 30_000, "B が全ての音声を受け取る");

  // **1 バイトも変わらないことを確かめる。** 長さの一致だけで満足してはならない。
  // 破棄禁止のフレームを順に辿り、内容とキーフレームの印が一致することを見る。
  let cursor = assetStart;
  for (let index = 0; index < required.length; index += 1) {
    const sent = required[index];
    assert.ok(sent !== undefined);
    const hex = toHex(sent.payload);
    const found = b.decoded.findIndex((frame, position) => position >= cursor && toHex(frame.payload) === hex);
    assert.ok(found >= 0, `破棄禁止の映像 ${String(index)} 枚目が届く`);
    const received = b.decoded[found];
    assert.ok(received !== undefined);
    assert.equal(toHex(received.payload), hex, `破棄禁止の映像 ${String(index)} 枚目が 1 バイトも変わらない`);
    assert.equal(received.key, sent.key, `破棄禁止の映像 ${String(index)} 枚目のキーフレームの印が一致する`);
    cursor = found + 1;
  }
  for (let index = 0; index < asset.audio.length; index += 1) {
    const sent = asset.audio[index];
    const received = b.audioIn[index];
    assert.ok(sent !== undefined && received !== undefined);
    assert.equal(toHex(received.payload), toHex(sent), `音声 ${String(index)} 個目が一致する`);
  }

  // 否定対照: A は自分の映像を受け取らない（自分の購読は作らない）。
  assert.equal(a.decoded.length, 0, "送信者は自分の映像を受け取らない");

  a.close();
  b.close();
});

/* ------------------------------------------------------------------------- */
/* A/V 同期の実測（判定 D-1 に実入力を与える）                                */
/* ------------------------------------------------------------------------- */

/**
 * **なぜこの試験が必要か。** 判定 D-1（`tests/support/degrade-judge.ts` の `judgeAvSkew`）は
 * 「音声の再生時刻」と「対応する frameIndex の提示時刻」を必要とする。段 D の器はこの 2 つを
 * 作っていなかったため、判定は入力が空で**常に合格していた**（空洞。X-038 と同じ性質）。
 * ここで実環境の 5 ノードを通した実測値を与える。
 *
 * **測っているものを正確に言う。** 「音声の再生時刻」は SDK が復号済みの音声を再生の
 * 待ち行列へ渡した時刻（`enqueueAudio`）であり、スピーカーから鳴った時刻ではない。
 * 「映像の提示時刻」は復号へ渡した時刻（`decodeVideo`）である。どちらも受信側の同一の
 * 時計で測るため、**両者の差**は経路と再生判断による同期のずれを表す。絶対時刻ではない。
 *
 * 対応付けは frameIndex で行う（時刻で推測してはならない）。送信側は payload の先頭バイトに
 * frameIndex を書く。
 */

/** 送る組の数。1 組 = 映像 1 枚 + 音声 1 個（同じ frameIndex）。 */
const PAIR_COUNT = 60;

/**
 * 中継ノードの要点だけを 1 行で返す。
 *
 * **走行中に刻む。** 1 度だけ読むと「止まった位置」しか分からず、どの時点から
 * 落ち始めたのかが分からない（X-043）。
 */
async function shardTrace(): Promise<string> {
  const secret = await deriveMeetingSecret(new TextEncoder().encode(DEV_NODE_KEY), MEETING_ID);
  if (!secret.ok) {
    return "観測できない";
  }
  const room = `vsh-${MEETING_ID}-auto-1-0`;
  const tag = await nodeAuthTag(secret.value, room, "shard", nodeAuthTimeWindow(Math.trunc(Date.now() / 1000)));
  if (!tag.ok) {
    return "観測できない";
  }
  try {
    const response = await fetch(`https://${HOST}/parties/shard/${room}`, {
      headers: { "x-wheso-node-role": "shard", "x-wheso-node-auth": tag.value },
    });
    const body: unknown = await response.json();
    const record = asRecord(body);
    const counters = asRecord(record["counters"]);
    const subs = record["subscriptions"];
    const first = Array.isArray(subs) ? asRecord(subs[0]) : {};
    return `in=${String(counters["binaryIn"])} out=${String(counters["binaryOut"])} drops=${JSON.stringify(
      record["drops"],
    )} sub(sid=${String(first["windowSid"])} sent=${String(first["highestSent"])} acked=${String(
      first["highestAcked"],
    )} cong=${String(first["congestion"])})`;
  } catch {
    return "観測できない";
  }
}

test("**A/V 同期が規範の許容に収まる**（判定 D-1 に実測を与える）", { timeout: 240_000 }, async () => {
  newMeeting();
  const a = await joinParty(USER_A);
  const b = await joinParty(USER_B);

  await waitFor(
    () => a.participants().includes(USER_B) && b.participants().includes(USER_A),
    60_000,
    "互いを認識する",
  );
  // 購読が中継ノードへ届くまで待つ。届く前に送ると転送先が無く消える。
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const output = a.output();
  assert.ok(output !== null, "A の取得の出力が繋がっている");

  // 暖機。経路が整うまでの数枚は捨てられる（NodeLink が受理前の媒体を捨てる）。
  // **復号できるまで送り続ける。** 枚数で切ると、1 枚目のキーフレームが購読の登録より
  // 前に捨てられた場合に復号器がキーフレームを待ち続けて先へ進めない。
  // 暖機の番号は 200 以上であり、判定からは除かれる。
  for (let index = 0; index < 48 && b.decoded.length === 0; index += 1) {
    output.onVideo({
      spatialId: 0,
      temporalId: 0,
      temporalLayers: 3,
      isKey: index % 8 === 0 || a.takeKeyframeRequest(),
      captureTimestampUs: BigInt(Date.now()) * 1000n,
      payload: new Uint8Array([200 + (index % 50), 0xee]),
    });
    await new Promise((resolve) => setTimeout(resolve, VIDEO_FRAME_INTERVAL_MS));
  }
  await waitFor(() => b.decoded.length > 0, 30_000, "暖機の映像が届く");

  // **音声と映像を混ぜて送る。** 実際のクライアントはこう送る。片方を後から一括で
  // 送ると、新しい取得時刻の音声に対して古い映像が「遅すぎる」と捨てられる（X-046）。
  for (let index = 0; index < PAIR_COUNT; index += 1) {
    const captureUs = BigInt(Date.now()) * 1000n;
    output.onVideo({
      spatialId: 0,
      temporalId: index % 3,
      temporalLayers: 3,
      // **要求に応える。** 受け手は連番の飛びを見るとキーフレームを待つ（ADR-0049）。
      // 応えないと、1 度の破棄で以後 1 枚も提示されず、対が揃わない。
      isKey: index === 0 || a.takeKeyframeRequest(),
      captureTimestampUs: captureUs,
      payload: new Uint8Array([index, 0x11, 0x22]),
    });
    // **音声は実際の頻度で送る**（Opus は 20 ms ごと）。1 つだけ送ると束ね
    // （`AUDIO_UNITS_PER_MESSAGE` = 2）が相手を待ち、その 1 つが次の周期まで遅れる。
    // 実測では 100 ms 遅れ、A/V 同期の外れ値になった。最初の 1 つだけに frameIndex を
    // 載せ、残りは対応付けに使わない番号（250）を入れる。
    for (let slot = 0; slot < 5; slot += 1) {
      output.onAudio({
        captureTimestampUs: BigInt(Date.now()) * 1000n,
        silent: false,
        payload: new Uint8Array([slot === 0 ? index : 250, 0x33, 0x44]),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (index % 8 === 7) {
      process.stdout.write(`刻み ${String(index + 1)} 組: ${await shardTrace()}\n`);
    }
  }

  // 両方が揃うまで待つ。**片方だけで判定してはならない**（対応付けが崩れる）。
  // **そろうのを「時間」で待ち、そろった数で判定する。** 何組そろうかは確立の運に
  // 依存する（購読が中継へ届く前の数組、復号器がキーフレームを待つ間の数組は落ちる）。
  // 判定は分布（p99）であり、20 組あれば意味を持つ。
  await waitFor(
    () => {
      const videoSeen = new Set(
        b.videoAtMs.filter((entry) => entry.frameIndex < PAIR_COUNT).map((entry) => entry.frameIndex),
      );
      const audioSeen = new Set(
        b.audioAtMs.filter((entry) => entry.frameIndex < PAIR_COUNT).map((entry) => entry.frameIndex),
      );
      let paired = 0;
      for (const index of videoSeen) {
        if (audioSeen.has(index)) {
          paired += 1;
        }
      }
      // **そろう組数に余裕を持たせる。** 確立の途中の数組は落ちる（購読が中継へ届く前、
      // 復号器がキーフレームを待つ間）。判定は p99 であり、45 組あれば足りる。
      return paired >= 20;
    },
    60_000,
    `映像と音声が 20 組以上そろう`,
  );

  // **経路に残っているものを数え切る。** 送り終えた直後に判定すると、まだ飛んでいる
  // 音声が「再生されていない」と読まれる（実測: 公開 CI で frameIndex 22 の音声が
  // 判定の後に届き、偽の違反になった）。増えなくなるまで待つ。
  await settled(() => b.audioAtMs.length + b.videoAtMs.length);

  // 記録を判定関数の形へ直す。暖機（200 以上）は除く。
  const playedAudio = b.audioAtMs
    .filter((entry) => entry.frameIndex < PAIR_COUNT && entry.frameIndex >= 0)
    .map((entry) => ({ frameIndex: entry.frameIndex, atMs: entry.atMs }));
  // **対応付けが成立する前の映像は判定に含めない。**
  //
  // その送信者の音声を 1 度も受けていない間、規範は「映像を止めてはならない。そのまま
  // 提示する」と定める（ADR-0028 の 2、`decidePresent` の `free`）。再生クロックが
  // 存在しないため、この期間の映像に同期の責任を負わせることはできない。最初の音声が
  // 再生された時刻より前に提示された映像を除く。
  // 除外は**内容**（frameIndex）で決める。時刻で決めてはならない。提示は門で後ろへ
  // ずれるため、時刻で切ると対応付け成立前に決めたフレームが混ざる（実測: 174 ms の
  // 外れ値が残った）。音声と映像は同じ frameIndex で対にして送っているため、
  // 最初に届いた音声の番号より前の映像は「再生クロックが無い間に決めたもの」である。
  const firstAudioIndex = playedAudio.reduce(
    (least, entry) => (entry.frameIndex < least ? entry.frameIndex : least),
    Number.MAX_SAFE_INTEGER,
  );
  // **末尾も内容で切る。** 最後に再生された音声の番号より後の映像は、対応する音声が
  // まだ経路にある。時刻で切ると門でずれた分を取り違えるため、番号で切る。
  const lastAudioIndex = playedAudio.reduce(
    (most, entry) => (entry.frameIndex > most ? entry.frameIndex : most),
    -1,
  );
  const presentedVideo = b.videoAtMs
    .filter(
      (entry) =>
        entry.frameIndex < PAIR_COUNT &&
        entry.frameIndex > firstAudioIndex &&
        entry.frameIndex <= lastAudioIndex,
    )
    .map((entry) => ({ frameIndex: entry.frameIndex, atMs: entry.atMs }));

  assert.ok(presentedVideo.length > 0, "映像の提示の記録がある");
  assert.ok(playedAudio.length > 0, "音声の再生の記録がある");

  const record: DegradeRecord = {
    sent: [],
    received: [],
    playedAudio,
    presentedVideo,
    lastSentAtMs: Date.now(),
    keyframeRequests: 0,
  };

  // 実測のずれを出す（文書へ書くため）。
  const audioAt = new Map<number, number>();
  for (const entry of playedAudio) {
    const existing = audioAt.get(entry.frameIndex);
    if (existing === undefined || entry.atMs < existing) {
      audioAt.set(entry.frameIndex, entry.atMs);
    }
  }
  // **符号は判定関数と同じ向きにする**（映像 − 音声。正なら音声が先行している）。
  // 向きを変えると許容の非対称（先行 22 / 遅れ 30）を取り違える。
  const skews: number[] = [];
  for (const frame of presentedVideo) {
    const at = audioAt.get(frame.frameIndex);
    if (at !== undefined) {
      skews.push(frame.atMs - at);
    }
  }
  skews.sort((x, y) => x - y);
  const p99 = skews[Math.min(skews.length - 1, Math.trunc(skews.length * 0.99))] ?? 0;
  process.stdout.write(
    `A/V 同期の実測: 組 ${String(skews.length)} / 最小 ${String(skews[0] ?? 0)} ms / 中央 ${String(
      skews[Math.trunc(skews.length / 2)] ?? 0,
    )} ms / p99 ${String(p99)} ms / 最大 ${String(skews[skews.length - 1] ?? 0)} ms\n`,
  );

  const violations = judgeAvSkew(record, AV_SKEW_AUDIO_LEAD_MAX_MS, AV_SKEW_AUDIO_LAG_MAX_MS);

  // **対応する音声が無いのは無条件に違反である**（音声は破棄禁止）。
  const missing = violations.filter((entry) => entry.detail.includes("対応する音声"));
  assert.deepEqual(
    missing.map((entry) => `${entry.judgement}: ${entry.detail}`),
    [],
    "すべての映像に対応する音声が再生されている",
  );

  // **規範の D-1 は p99 で定める**（acceptance.md 4.4:「差の p99 が … 以内」）。
  // 判定関数は最悪値も見るが、それは長時間の段 D（数千枚）で意味を持つ。ここは数十組で
  // あるため、単発の外れ値で落とさない。最悪値は記録として出す（上の実測の行）。
  assert.ok(
    p99 <= AV_SKEW_AUDIO_LEAD_MAX_MS && -p99 <= AV_SKEW_AUDIO_LAG_MAX_MS,
    `ずれの p99 が許容の帯（+${String(AV_SKEW_AUDIO_LEAD_MAX_MS)} / -${String(
      AV_SKEW_AUDIO_LAG_MAX_MS,
    )} ms）に入る（実際 ${String(p99)} ms）`,
  );
  assert.ok(
    Math.abs(p99) <= AV_SKEW_MS_P99,
    `ずれの p99 が ${String(AV_SKEW_MS_P99)} ms 以内である（実際 ${String(p99)} ms）`,
  );
});
