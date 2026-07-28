/**
 * 段 D（劣化）の記録の器（ブラウザ側）。
 *
 * 目的: 劣化した回線の下で、実際の映像と音声が実環境のノードを通って届き続けることを、
 * **フレームごとの記録**として残す。判定（受入条件 4 節）は Node 側が記録に対して行う。
 * ここで判定しない理由は、判定の閾値が規範の値であり、ブラウザ側へ持ち込むと
 * 二重管理になるためである。
 *
 * 何を記録するか:
 *   送信 1 枚ごとに frameIndex / spatialId / temporalId / isKey / 送信時刻
 *   受信 1 枚ごとに frameIndex / 復号画素のハッシュ / 復号時刻
 *   音声は束ごとに sequenceNumber / 到着時刻（欠落 0 を確かめるため）
 *   キーフレーム要求の受信回数（判定 E-1）
 *
 * frameIndex をどう運ぶか: ワイヤの sequenceNumber をそのまま使う。送信側が 1 から
 * 単調に増やし、受信側は復号せずに読める。これにより「どのフレームが落ちたか」を
 * 画素に頼らず特定できる。
 *
 * ハッシュは復号後の画素（RGBA の生バイト列）に対して SHA-256 を取る。判定 A-1 の
 * 「decodedSha256 が期待値と一致する」の期待値は、同じ入力を同じ符号化器で処理した
 * 送信側が、符号化前の画素から作る（AV1 は非可逆であるため、送信側の**符号化前**の
 * 画素と受信側の**復号後**の画素は一致しない。よって判定 A-1 は「劣化なし（N-0）の
 * 記録を基準とし、劣化下の記録がそれと一致すること」で行う。基準の作り方は Node 側にある）。
 */

import { packEncoded } from "../../../packages/client/src/media/encoder-set.ts";
import { decodeMediaMessage } from "../../../packages/core/src/wire.ts";
import { delaySlope } from "../../../packages/core/src/fixed.ts";
import {
  SHARD_TREND_ENTER_T2_DEN,
  SHARD_TREND_ENTER_T2_NUM,
  SHARD_TREND_EXIT_DEN,
  SHARD_TREND_EXIT_NUM,
} from "../../../packages/core/src/generated/constants.ts";
import { deriveMeetingSecret, nodeAuthTag, nodeAuthTimeWindow } from "../../../packages/core/src/auth.ts";
import {
  CHANNEL_VIDEO,
  FLAG_KEY,
} from "../../../packages/core/src/generated/wire-layout.ts";
import {
  IMPAIRMENT_MAX_BUFFERED_BYTES,
  IMPAIRMENT_VIDEO_BITRATE,
} from "../../../packages/core/src/generated/impairment.ts";

interface SentRecord {
  readonly frameIndex: number;
  readonly spatialId: number;
  readonly temporalId: number;
  readonly isKey: boolean;
  readonly atMs: number;
  readonly bytes: number;
}

interface ReceivedRecord {
  readonly frameIndex: number;
  readonly temporalId: number;
  readonly isKey: boolean;
  readonly sha256: string;
  readonly atMs: number;
}

interface DegradeResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly codec: string;
  readonly sent: readonly SentRecord[];
  readonly received: readonly ReceivedRecord[];
  /** 最後に送った時刻。これ以降の受信間隔は「固まった」の判定に含めない。 */
  readonly lastSentAtMs: number;
  /** キーフレーム要求の受信回数。判定 E-1 は全プロファイルで 0 を要求する。 */
  readonly keyframeRequests: number;
  /**
   * 接続が閉じた記録。劣化下で欠落が出たとき、SFU が層を捨てたのか経路が切れたのかを
   * 区別するために要る（区別できないと、原因を取り違えたまま実装を直そうとする）。
   */
  readonly closures: readonly string[];
  /**
   * **ワイヤで届いた** frameIndex の一覧（復号の成否に依らない）。
   * received（復号できたもの）と分ける理由: 欠落が「転送で捨てられた」のか
   * 「届いたが復号器が出力しなかった」のかを区別できないと、原因の層を取り違える。
   */
  readonly arrived: readonly number[];
  /** 購読上限層を変えた履歴。輻輳制御が働いたことの証拠になる。 */
  readonly tierChanges: readonly string[];
  readonly durationMs: number;
}

interface IsolationResult {
  readonly participants: readonly DegradeResult[];
}

declare global {
  interface Window {
    __whesoDegradeResult?: DegradeResult;
    __whesoDegrade?: (
      wsBase: string,
      room: string,
      nodeKey: string,
      durationMs: number,
    ) => Promise<DegradeResult>;
    /**
     * N-8（参加者ごとに別々の劣化）。参加者ごとに別の終端（別ポート）へ繋ぎ、
     * 同時に送受信する。悪い回線の 1 人が他の参加者を壊さないことを確かめるための器である。
     */
    __whesoIsolation?: (
      specs: readonly { readonly wsBase: string; readonly senderId: number }[],
      room: string,
      nodeKey: string,
      durationMs: number,
    ) => Promise<IsolationResult>;
  }
}

const WIDTH = 320;
const HEIGHT = 240;
const FRAMERATE = 15;

/**
 * 空間層の定義（simulcast の 2 段）。
 *
 * なぜ 2 段必要か: 帯域が足りないとき、受信側は購読の上限層を下げて量を減らす。層が
 * 1 段しかないと下げる先が無く、下り帯域が詰まったまま無選別に落ちる（実測: N-6 で
 * 送 892 / 届 853 と、破棄できない層まで欠落した）。
 *
 * 解像度は CI の軟体符号化器で回る大きさに留める。規範のプロファイル（1080p 以上）は
 * CPU が足りず、符号化の遅れが判定を不安定にする。
 */
const LAYERS: readonly { readonly spatialId: number; readonly width: number; readonly height: number; readonly share: number }[] = [
  { spatialId: 0, width: 160, height: 120, share: 4 },
  { spatialId: 1, width: WIDTH, height: HEIGHT, share: 6 },
];

/**
 * 1 人の参加者の接続の指定。
 *
 * wsBase を参加者ごとに変えられるようにしてある。**別のポートの終端を指すことで、
 * 参加者ごとに別々の劣化を掛けられる**（N-8。劣化はポート単位で適用する。ADR-0023）。
 */
interface ParticipantSpec {
  readonly wsBase: string;
  readonly senderId: number;
}

/** 購読側の接続 ID。送信側と衝突しないように離す。 */
function subscriberPk(senderId: number): number {
  return senderId + 100;
}

/**
 * 既知の模様を描く。frameIndex が判る形にする理由: 復号後のハッシュだけでは
 * 「どのフレームか」が判らない。左上に index を階段状の輝度で埋め込む。
 */
function drawPattern(index: number, width: number, height: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("2d context を得られない");
  }
  context.fillStyle = "rgb(32, 160, 64)";
  context.fillRect(0, 0, width, height);

  // **非圧縮性のノイズを敷く**（測定の 5 原則の 1）。
  //
  // なぜ必要か: 単純な模様では符号化器が指定したビットレートを使わない。2.5 Mbps を
  // 指定しても数百 kbps しか出ず、帯域を絞っても影響が現れなかった（N-8 で健全側と
  // 劣化側がどちらも 904 枚と実測）。それでは「悪い回線」が存在せず、劣化試験が空洞になる。
  //
  // 画素ごとに乱数を書くと CPU が持たないため、8 画素の矩形で塗る。矩形の単位でも
  // 隣接画素の相関が消えるため、フレーム間予測もフレーム内予測も効かない。
  const blockSize = 8;
  let seed = (index + 1) * 2654435761;
  for (let y = 0; y < height; y += blockSize) {
    for (let x = 0; x < width; x += blockSize) {
      // 決定的な擬似乱数（xorshift）。ブラウザの乱数に依らず再現できるようにする。
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const level = Math.abs(seed) % 256;
      context.fillStyle = `rgb(${level}, ${(level * 7) % 256}, ${(level * 13) % 256})`;
      context.fillRect(x, y, blockSize, blockSize);
    }
  }

  // 動きを入れる。動きが無いとエンコーダが同じフレームを出さないことがある。
  context.fillStyle = "rgb(255, 255, 255)";
  context.fillRect((index * 8) % width, 0, 8, height);
  // index を輝度で埋め込む（8 段。復号後も残る大きさにする）。
  const level = (index % 8) * 32;
  context.fillStyle = `rgb(${level}, ${level}, ${level})`;
  context.fillRect(0, 0, Math.trunc(width / 10), Math.trunc(height / 8));
  return canvas;
}

async function pickCodec(): Promise<string | null> {
  const candidates = ["av01.0.04M.08", "avc1.42E01F", "vp8"];
  for (const codec of candidates) {
    const support = await VideoEncoder.isConfigSupported({
      codec,
      width: WIDTH,
      height: HEIGHT,
      framerate: FRAMERATE,
      bitrate: IMPAIRMENT_VIDEO_BITRATE,
    });
    if (support.supported === true) {
      return codec;
    }
  }
  return null;
}

/** 復号後の画素の SHA-256。判定 A-1 はこの値の一致で行う。 */
async function hashFrame(frame: VideoFrame): Promise<string> {
  const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
  const context = canvas.getContext("2d");
  if (context === null) {
    return "";
  }
  context.drawImage(frame, 0, 0);
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function waitOpen(socket: WebSocket, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    // 閉じられた理由（コード）を残す。4023 なら認証、それ以外は経路の問題である。
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("close", (event: CloseEvent) => {
      reject(new Error(`${label} が閉じた（code=${String(event.code)} reason=${event.reason}）`));
    });
    socket.addEventListener("error", () => {
      reject(new Error(`${label} を開けない（url=${socket.url}）`));
    });
    setTimeout(() => {
      reject(new Error(`${label} が 20 秒で開かない（url=${socket.url}）`));
    }, 20_000);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendNodeHello(socket: WebSocket, room: string, nodeKey: string, role: string): Promise<void> {
  const parts = room.split("-");
  const meetingId = parts[1] ?? "";
  const secret = await deriveMeetingSecret(new TextEncoder().encode(nodeKey), meetingId);
  if (!secret.ok) {
    return;
  }
  const window = nodeAuthTimeWindow(Math.trunc(Date.now() / 1000));
  const tag = await nodeAuthTag(secret.value, room, role, window);
  socket.send(JSON.stringify({ t: "nodeHello", role, nodeId: room, authTag: tag.ok ? tag.value : "" }));
}

async function run(
  spec: ParticipantSpec,
  room: string,
  nodeKey: string,
  durationMs: number,
): Promise<DegradeResult> {
  const wsBase = spec.wsBase;
  const senderId = spec.senderId;
  const fail = (detail: string, codec = ""): DegradeResult => ({
    ok: false,
    detail,
    codec,
    sent: [],
    received: [],
    lastSentAtMs: 0,
    keyframeRequests: 0,
    closures: [],
    arrived: [],
    tierChanges: [],
    durationMs: 0,
  });

  const codec = await pickCodec();
  if (codec === null) {
    return fail("使える符号化器が無い");
  }

  const receiver = new WebSocket(`${wsBase}/parties/shard/${room}?_pk=${String(subscriberPk(senderId))}`);
  receiver.binaryType = "arraybuffer";
  const sender = new WebSocket(`${wsBase}/parties/shard/${room}?_pk=${String(senderId)}`);
  await Promise.all([waitOpen(receiver, "購読側"), waitOpen(sender, "送信側")]);

  // 購読側を先に登録する。逆にすると転送先が無く、送ったものが消える。
  await sendNodeHello(receiver, room, nodeKey, "receiver");
  receiver.send(
    JSON.stringify({
      t: "subscribe",
      entries: [{ senderId, channel: CHANNEL_VIDEO, maxSpatialId: 3, maxTemporalId: 7 }],
    }),
  );
  await sendNodeHello(sender, room, nodeKey, "sender");
  await sleep(500);

  const sent: SentRecord[] = [];
  const received: ReceivedRecord[] = [];
  let keyframeRequests = 0;
  let decodeError = "";
  const closures: string[] = [];
  const arrived: number[] = [];
  /** 直近の遅延標本（マイクロ秒）。tier の上下判断に使う。 */
  let delaySamplesUs: number[] = [];
  /** 現在の購読上限層。最初は最上位を要求する。 */
  let currentTier = LAYERS[LAYERS.length - 1]?.spatialId ?? 0;
  /** tier を変えた回数と履歴。判定と診断に使う。 */
  const tierChanges: string[] = [];
  receiver.addEventListener("close", (event: CloseEvent) => {
    closures.push(`購読側 code=${String(event.code)} at=${performance.now().toFixed(0)}ms`);
  });
  sender.addEventListener("close", (event: CloseEvent) => {
    closures.push(`送信側 code=${String(event.code)} at=${performance.now().toFixed(0)}ms`);
  });

  /**
   * 復号器は**空間層ごとに**持つ。1 つの復号器へ異なる解像度のフレームを入れると
   * 設定と食い違い、復号器が閉じる（実測: 全プロファイルが
   * 「Cannot call 'decode' on a closed codec」で失敗した）。
   *
   * 受信したフレームと frameIndex を結び付けるため、層ごとに待ち行列から順に引く。
   * 復号器は入力順に出力するため、この対応は崩れない。
   */
  const pendingByLayer = new Map<number, { frameIndex: number; temporalId: number; isKey: boolean }[]>();
  const decoders = new Map<number, VideoDecoder>();
  for (const layer of LAYERS) {
    const queue: { frameIndex: number; temporalId: number; isKey: boolean }[] = [];
    pendingByLayer.set(layer.spatialId, queue);
    const decoder = new VideoDecoder({
      output: (frame) => {
        const head = queue.shift();
        // 時刻は**復号できた瞬間**に取る。ハッシュの計算完了を待って記録すると、
        // 計算がまとまって遅れたときに「固まった」と誤判定する。
        const atMs = performance.now();
        const slot = received.length;
        received.push({
          frameIndex: head?.frameIndex ?? 0,
          temporalId: head?.temporalId ?? 0,
          isKey: head?.isKey ?? false,
          sha256: "",
          atMs,
        });
        void hashFrame(frame).then((sha256) => {
          const entry = received[slot];
          if (entry !== undefined) {
            received[slot] = { ...entry, sha256 };
          }
          frame.close();
        });
      },
      error: (error) => {
        decodeError = error.message;
      },
    });
    decoder.configure({ codec, codedWidth: layer.width, codedHeight: layer.height });
    decoders.set(layer.spatialId, decoder);
  }

  receiver.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string") {
      // キーフレーム要求が来たら数える（判定 E-1）。
      if (event.data.includes("keyframeRequest")) {
        keyframeRequests += 1;
      }
      return;
    }
    if (!(event.data instanceof ArrayBuffer)) {
      return;
    }
    const decoded = decodeMediaMessage(new Uint8Array(event.data));
    if (!decoded.ok) {
      decodeError = `ワイヤ解析に失敗: ${decoded.error.code}`;
      return;
    }
    for (const unit of decoded.value.units) {
      const isKey = (unit.flags & FLAG_KEY) !== 0;
      arrived.push(unit.sequenceNumber);
      const decoder = decoders.get(unit.spatialId);
      const queue = pendingByLayer.get(unit.spatialId);
      if (decoder === undefined || queue === undefined) {
        // 知らない層は数えない（購読の上限を下げた直後に届くことがある）。
        continue;
      }
      // 遅延の標本を集める。送信と受信が同じページであるため時計が共通であり、
      // 撮影時刻との差がそのまま片道の遅延になる。
      delaySamplesUs.push(Math.trunc(performance.now() * 1000) - Number(unit.captureTimestampUs));
      queue.push({
        frameIndex: unit.sequenceNumber,
        temporalId: unit.temporalId,
        isKey,
      });
      decoder.decode(
        new EncodedVideoChunk({
          type: isKey ? "key" : "delta",
          timestamp: Number(unit.captureTimestampUs),
          data: unit.payload,
        }),
      );
    }
  });

  // 送信側もキーフレーム要求を受け取る立場にある（中継が送信ノード経由で伝える）。
  sender.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string" && event.data.includes("keyframeRequest")) {
      keyframeRequests += 1;
    }
  });

  let frameIndex = 0;
  let encodeError = "";

  /**
   * 層ごとの符号化器。同じ映像を 2 つの解像度で符号化し、spatialId を付けて送る
   * （simulcast）。受信側が上限層を下げれば、中継ノードは上の層を転送しなくなる。
   */
  const encoders: { readonly spatialId: number; readonly width: number; readonly height: number; readonly encoder: VideoEncoder }[] = [];
  const totalShare = LAYERS.reduce((sum, layer) => sum + layer.share, 0);
  for (const layer of LAYERS) {
    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        const payload = new Uint8Array(chunk.byteLength);
        chunk.copyTo(payload);
        // frameIndex は層をまたいで一意にする。層ごとに同じ番号を使うと、
        // 受信側で「どの層のどのフレームか」を区別できない。
        const index = frameIndex + 1;
        frameIndex = index;
        const temporalId = temporalOf(metadata);
        const packed = packEncoded({
          channel: CHANNEL_VIDEO,
          senderId,
          sequenceNumber: index,
          captureTimestampUs: BigInt(Math.trunc(chunk.timestamp)),
          spatialId: layer.spatialId,
          temporalId,
          temporalLayers: 3,
          isKey: chunk.type === "key",
          payload,
        });
        if (!packed.ok) {
          encodeError = `詰め込みに失敗: ${packed.error.code}`;
          return;
        }
        // 送信が詰まっている間は送らない。詰めて送ると劣化ではなく自分で輻輳を作る。
        // 閾値が大きいと詰まりに気付かず送り続け、経路が壊れてから欠落として現れる。
        if (sender.bufferedAmount > IMPAIRMENT_MAX_BUFFERED_BYTES) {
          return;
        }
        sender.send(packed.value);
        sent.push({
          frameIndex: index,
          spatialId: layer.spatialId,
          temporalId,
          isKey: chunk.type === "key",
          atMs: performance.now(),
          bytes: packed.value.byteLength,
        });
      },
      error: (error) => {
        encodeError = error.message;
      },
    });
    const bitrate = Math.trunc((IMPAIRMENT_VIDEO_BITRATE * layer.share) / totalShare);
    const config: VideoEncoderConfig = codec.startsWith("av01")
      ? {
          codec,
          width: layer.width,
          height: layer.height,
          framerate: FRAMERATE,
          bitrate,
          scalabilityMode: "L1T3",
        }
      : { codec, width: layer.width, height: layer.height, framerate: FRAMERATE, bitrate };
    encoder.configure(config);
    encoders.push({ spatialId: layer.spatialId, width: layer.width, height: layer.height, encoder });
  }

  /**
   * 購読の上限層を上下させる。
   *
   * 判断は受信ノードの判断コアと同じ規則を使う（遅延勾配が悪化したら下げ、回復したら
   * 上げる。閾値は SHARD_TREND_* の定数）。器が判断を持たないと、下り帯域が詰まったまま
   * 無選別に落ち、破棄優先順位の検証ができない（実測: N-6 で破棄できない層まで欠落した）。
   */
  const adjustTier = (): void => {
    if (delaySamplesUs.length < 4) {
      return;
    }
    const trend = delaySlope(delaySamplesUs);
    delaySamplesUs = [];
    const degrading =
      trend.numerator * SHARD_TREND_ENTER_T2_DEN > SHARD_TREND_ENTER_T2_NUM * trend.denominator;
    const recovering =
      trend.numerator * SHARD_TREND_EXIT_DEN < SHARD_TREND_EXIT_NUM * trend.denominator;
    const lowest = LAYERS[0]?.spatialId ?? 0;
    const highest = LAYERS[LAYERS.length - 1]?.spatialId ?? 0;
    const next = degrading
      ? Math.max(lowest, currentTier - 1)
      : recovering
        ? Math.min(highest, currentTier + 1)
        : currentTier;
    if (next === currentTier) {
      return;
    }
    currentTier = next;
    tierChanges.push(`${degrading ? "下げ" : "上げ"}→${String(next)} at=${performance.now().toFixed(0)}ms`);
    receiver.send(
      JSON.stringify({
        t: "subscribe",
        entries: [{ senderId, channel: CHANNEL_VIDEO, maxSpatialId: next, maxTemporalId: 7 }],
      }),
    );
  };

  const startedAt = performance.now();
  const frameIntervalMs = Math.trunc(1000 / FRAMERATE);
  let index = 0;
  let lastAdjustMs = performance.now();
  while (performance.now() - startedAt < durationMs) {
    for (const entry of encoders) {
      const canvas = drawPattern(index, entry.width, entry.height);
      const frame = new VideoFrame(canvas, { timestamp: index * frameIntervalMs * 1000 });
      // キーフレームは最初の 1 枚だけにする。判定 E-1（要求 0 回）を確かめるため、
      // 定期キーフレームで欠落が隠れないようにする。
      entry.encoder.encode(frame, { keyFrame: index === 0 });
      frame.close();
    }
    index += 1;
    // 1 秒ごとに層を見直す。頻繁に変えるとキーフレーム要求が増え、判定 E-1 に触れる。
    if (performance.now() - lastAdjustMs >= 1000) {
      lastAdjustMs = performance.now();
      adjustTier();
    }
    await sleep(frameIntervalMs);
  }
  for (const entry of encoders) {
    await entry.encoder.flush();
  }
  const lastSentAtMs = sent[sent.length - 1]?.atMs ?? 0;
  // 転送と復号が追いつくのを待つ。実環境の往復（片道 12.5 ms）と復号の待ちを見込む。
  await sleep(3000);
  for (const decoder of decoders.values()) {
    // 閉じた復号器へ flush すると例外になる。誤りが記録されている場合は飛ばす。
    if (decodeError === "") {
      await decoder.flush();
    }
  }
  await sleep(1000);

  const durationActual = performance.now() - startedAt;
  receiver.close();
  sender.close();

  if (encodeError !== "") {
    return fail(`符号化に失敗: ${encodeError}`, codec);
  }
  if (decodeError !== "") {
    return fail(`復号に失敗: ${decodeError}`, codec);
  }

  return {
    ok: sent.length > 0 && received.length > 0,
    detail: "",
    codec,
    sent,
    received,
    lastSentAtMs,
    keyframeRequests,
    closures,
    arrived,
    tierChanges,
    durationMs: Math.trunc(durationActual),
  };
}

/**
 * 時間層を metadata から読む。得られない場合は 0 とする。
 * 型定義に svc が無い実装があるため、動的な形として受けて実行時に検査する
 * （型定義を信用しない。AGENTS 5.4 の 3）。
 */
function temporalOf(metadata: unknown): number {
  if (typeof metadata !== "object" || metadata === null) {
    return 0;
  }
  const record: Record<string, unknown> = { ...metadata };
  const svc = record["svc"];
  if (typeof svc === "object" && svc !== null) {
    const svcRecord: Record<string, unknown> = { ...svc };
    const layer = svcRecord["temporalLayerId"];
    if (typeof layer === "number") {
      return layer;
    }
  }
  return 0;
}

window.__whesoDegrade = async (wsBase, room, nodeKey, durationMs) => {
  // 例外を投げずに結果として返す。投げると Playwright 側で理由が失われる。
  try {
    const result = await run({ wsBase, senderId: 1 }, room, nodeKey, durationMs);
    window.__whesoDegradeResult = result;
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const failed: DegradeResult = {
      ok: false,
      detail,
      codec: "",
      sent: [],
      received: [],
      lastSentAtMs: 0,
      keyframeRequests: 0,
      closures: [],
      arrived: [],
      tierChanges: [],
      durationMs: 0,
    };
    window.__whesoDegradeResult = failed;
    return failed;
  }
};

window.__whesoIsolation = async (specs, room, nodeKey, durationMs) => {
  // 参加者を**同時に**動かす。順に動かすと「悪い回線の影響」を測れない。
  const results = await Promise.all(
    specs.map(async (spec) => {
      try {
        return await run({ wsBase: spec.wsBase, senderId: spec.senderId }, room, nodeKey, durationMs);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          detail,
          codec: "",
          sent: [],
          received: [],
          lastSentAtMs: 0,
          keyframeRequests: 0,
          closures: [],
          arrived: [],
          tierChanges: [],
          durationMs: 0,
        };
      }
    }),
  );
  return { participants: results };
};
