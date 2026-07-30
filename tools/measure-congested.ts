/**
 * 輻輳させたときの遅延勾配を実測する（Q-026 の第 2 段）。
 *
 * **なぜ Node で測るか。** 健全な側は SDK とブラウザで測った（`tools/measure-trend.ts`）。
 * 輻輳側は「経路が飽和したときに勾配がどこまで上がるか」を知る必要がある。`tc` は root を
 * 要するため手元では使えない（CI の `impair` ジョブのみ）。代わりに**実際に飽和させる**。
 * 送信と受信を同じ処理の中に置くため、片道遅延に時計の原点差が入らない（Q-022 の問題を
 * 回避できる）。すなわちここで測る値は**真の遅延の増加**である。
 *
 * 手順:
 *   1. 中継部屋へ購読者として繋ぎ、`nodeHello`（役割 receiver）を通して購読を送る
 *   2. 同じ部屋へ送信者として繋ぎ、`nodeHello`（役割 sender）と `streamAnnounce` を送る
 *   3. 指定の速さで大きなフレームを送り続ける（既定は経路が詰まる量）
 *   4. 購読者側で `now - captureTimestamp` を標本にし、`delaySlope` の分布を出す
 *
 * 実行:
 *   WHESO_LIVE_HOST=<配備先> node tools/measure-congested.ts [秒数] [Mbps]
 */

import { deriveMeetingSecret, nodeAuthTag, nodeAuthTimeWindow } from "../packages/core/src/auth.ts";
import { delaySlope } from "../packages/core/src/fixed.ts";
import { encodeMediaMessage } from "../packages/core/src/wire.ts";
import {
  CHANNEL_VIDEO,
  FLAG_END_OF_FRAME,
  FLAG_KEY,
} from "../packages/core/src/generated/wire-layout.ts";
import { DELAY_TREND_WINDOW } from "../packages/core/src/generated/constants.ts";

const NODE_KEY = "wheso-dev-node-key-not-a-secret";
const SENDER_ID = 4242;
const SUBSCRIBER_PK = 9001;
/** 送る fps。申告と一致させる（送信窓の計算に使われる）。 */
const FPS = 30;

function newMeetingId(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let out = "";
  for (let index = 0; index < 26; index += 1) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}

/** 非圧縮性のペイロードを作る（測定の 5 原則の 1。F-022）。 */
function incompressible(size: number): Uint8Array {
  const out = new Uint8Array(size);
  let state = 0x9e3779b9;
  for (let index = 0; index < size; index += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[index] = state & 0xff;
  }
  return out;
}

function quantile(sorted: readonly number[], perMille: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.trunc((sorted.length * perMille) / 1000));
  return sorted[index] ?? 0;
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("接続の時限")), 20_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("接続に失敗"));
    });
  });
  return socket;
}

async function main(): Promise<void> {
  const host = process.env["WHESO_LIVE_HOST"];
  if (host === undefined || host === "") {
    process.stdout.write("WHESO_LIVE_HOST が無い\n");
    process.exitCode = 1;
    return;
  }
  const seconds = Number.parseInt(process.argv[2] ?? "30", 10);
  const mbps = Number.parseInt(process.argv[3] ?? "60", 10);
  const durationMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000;
  const targetMbps = Number.isFinite(mbps) && mbps > 0 ? mbps : 60;
  // 1 フレームの大きさ = 目標のビットレート / fps / 8。
  const frameBytes = Math.trunc((targetMbps * 1_000_000) / FPS / 8);

  const meetingId = newMeetingId();
  const room = `vsh-${meetingId}-auto-1-0`;
  const secret = await deriveMeetingSecret(new TextEncoder().encode(NODE_KEY), meetingId);
  if (!secret.ok) {
    process.stdout.write("会議シークレットを導出できない\n");
    process.exitCode = 1;
    return;
  }
  const window_ = nodeAuthTimeWindow(Math.trunc(Date.now() / 1000));
  const receiverTag = await nodeAuthTag(secret.value, room, "receiver", window_);
  const senderTag = await nodeAuthTag(secret.value, room, "sender", window_);
  if (!receiverTag.ok || !senderTag.ok) {
    process.stdout.write("認証タグを作れない\n");
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `測定を始める（会議 ${meetingId} / ${String(durationMs / 1000)} 秒 / 目標 ${String(
      targetMbps,
    )} Mbps / 1 フレーム ${String(frameBytes)} バイト）\n`,
  );

  const samplesUs: number[] = [];
  const slopes: number[] = [];
  let received = 0;
  /** 受け取った最大の連番。ack はこれを返す（件数では窓が開かない）。 */
  let highestSeq = 0;

  const subscriber = await openSocket(`wss://${host}/parties/shard/${room}?_pk=${String(SUBSCRIBER_PK)}`);
  subscriber.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data === "string") {
      return;
    }
    received += 1;
    const bytes = new Uint8Array(event.data instanceof ArrayBuffer ? event.data : new ArrayBuffer(0));
    // ユニットヘッダの取得時刻（メッセージヘッダ 8 + 上位 4 + 下位 4）。
    if (bytes.length < 16) {
      return;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const seq = view.getUint32(8, false);
    if (seq > highestSeq) {
      highestSeq = seq;
    }
    const high = view.getUint32(8 + 4, false);
    const low = view.getUint32(8 + 8, false);
    const captureUs = high * 4294967296 + low;
    const nowUs = Date.now() * 1000;
    samplesUs.push(nowUs - captureUs);
    if (samplesUs.length > DELAY_TREND_WINDOW) {
      samplesUs.shift();
    }
    if (samplesUs.length === DELAY_TREND_WINDOW) {
      const slope = delaySlope(samplesUs);
      slopes.push(slope.numerator / slope.denominator);
    }
  });
  subscriber.send(
    JSON.stringify({ t: "nodeHello", role: "receiver", nodeId: `vr-${meetingId}-x`, authTag: receiverTag.value }),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  subscriber.send(
    JSON.stringify({
      t: "subscribe",
      entries: [{ senderId: SENDER_ID, channel: CHANNEL_VIDEO, maxSpatialId: 0, maxTemporalId: 7 }],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 800));

  const sender = await openSocket(`wss://${host}/parties/shard/${room}?_pk=${String(SENDER_ID)}`);
  sender.send(
    JSON.stringify({ t: "nodeHello", role: "sender", nodeId: `vs-${meetingId}-y`, authTag: senderTag.value }),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  sender.send(
    JSON.stringify({
      t: "streamAnnounce",
      streams: [
        {
          channel: CHANNEL_VIDEO,
          spatialId: 0,
          codec: "av01.0.08M.08",
          scalabilityMode: "L1T1",
          spatialLayers: 1,
          temporalLayers: 1,
          width: 1920,
          height: 1080,
          framerate: FPS,
          targetBitrate: targetMbps * 1_000_000,
        },
      ],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));

  // ack を返し続ける。返さないと送信窓と ack タイムアウトで購読が切られる。
  const ackTimer = setInterval(() => {
    if (highestSeq > 0) {
      subscriber.send(
        JSON.stringify({ t: "ack", senderId: SENDER_ID, channel: CHANNEL_VIDEO, spatialId: 0, highestSeq }),
      );
    }
  }, 50);

  const payload = incompressible(frameBytes);
  let sequence = 1;
  let sent = 0;
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const encoded = encodeMediaMessage({
      channel: CHANNEL_VIDEO,
      senderId: SENDER_ID,
      units: [
        {
          sequenceNumber: sequence,
          captureTimestampUs: BigInt(Date.now()) * 1000n,
          flags: FLAG_END_OF_FRAME | (sequence === 1 ? FLAG_KEY : 0),
          spatialId: 0,
          temporalId: 0,
          payload,
        },
      ],
    });
    if (!encoded.ok) {
      process.stdout.write(`符号化に失敗: ${encoded.error.code}\n`);
      break;
    }
    sender.send(encoded.value);
    sent += 1;
    sequence += 1;
    await new Promise((resolve) => setTimeout(resolve, Math.trunc(1000 / FPS)));
  }
  clearInterval(ackTimer);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  subscriber.close();
  sender.close();

  const sorted = [...slopes].sort((a, b) => a - b);
  const delays = [...samplesUs].sort((a, b) => a - b);
  process.stdout.write(
    [
      `送出 ${String(sent)} 件 / 受信 ${String(received)} 件`,
      `勾配の標本数: ${String(sorted.length)}`,
      `勾配（マイクロ秒/標本）: 最小 ${String(quantile(sorted, 0))} / 中央 ${String(
        quantile(sorted, 500),
      )} / p90 ${String(quantile(sorted, 900))} / p99 ${String(quantile(sorted, 990))} / 最大 ${String(
        sorted[sorted.length - 1] ?? 0,
      )}`,
      `直近の片道遅延（マイクロ秒）: 中央 ${String(quantile(delays, 500))} / 最大 ${String(
        delays[delays.length - 1] ?? 0,
      )}`,
    ].join("\n") + "\n",
  );
}

await main();
