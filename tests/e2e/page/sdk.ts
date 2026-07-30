/**
 * SDK 経由の実映像 E2E（検証階層 L4）。
 *
 * **何を証明するか。** 公開 API（`joinMeeting`）だけを使って 2 人が参加し、
 * **実際のカメラのトラック**を**実際の `VideoEncoder`（AV1）**で符号化し、
 * **実際にデプロイした 5 ノード**を通し、**実際の `VideoDecoder`** で復号して
 * `VideoFrame` が得られること。
 *
 * **なぜ既存の E2E では足りないか。** `main.ts` と `audio.ts` は生の WebSocket を張り、
 * 中継部屋へ直結して自前で符号化・復号する。中継の転送は確かめられるが、
 * **SDK の送信経路・受信経路・送信ノード・受信ノード・名簿は 1 度も通らない。**
 * 段 F まで、それらは実行経路上に存在しなかった（誤解カタログ X-039）。
 *
 * カメラは偽のデバイスを使う（`--use-fake-device-for-media-stream`）。CI の実行機に
 * カメラは無い（Q-020）。偽のデバイスは実際の `MediaStreamTrack` を返すため、
 * 取得（`MediaStreamTrackProcessor`）と符号化の経路は本物である。
 */

import { joinMeeting } from "../../../packages/client/src/api/join-meeting.ts";
import { issueToken } from "../../../packages/core/src/auth.ts";

/** 実行の結果。試験側が検査する。 */
interface SdkResult {
  readonly ok: boolean;
  readonly detail: string;
  /** A が認識した参加者の数（自分を含む）。 */
  readonly aParticipants: number;
  readonly bParticipants: number;
  /** B が復号できたフレームの枚数。 */
  readonly bFrames: number;
  /** B が復号したフレームの寸法（最初の 1 枚）。 */
  readonly firstFrame: { readonly width: number; readonly height: number } | null;
  /** A が復号できたフレームの枚数（対称であることの確認）。 */
  readonly aFrames: number;
  /** A の上り帯域（bits/sec）。0 なら 1 バイトも送っていない。 */
  readonly aUplinkBps: number;
  /** B の下り帯域（bits/sec）。 */
  readonly bDownlinkBps: number;
  /**
   * 遅延勾配の観測（分子と分母の対）。**閾値を実測で決めるための入力である**（Q-026）。
   * 単位はマイクロ秒/標本である。
   */
  readonly slopes: readonly { readonly num: number; readonly den: number }[];
  /**
   * 部屋の種別ごとの受信数（試験側の計測）。
   *
   * **公開 API だけでは「ブラウザに届いていない」と「届いたが復号されない」を区別できない。**
   * 実測ではこの区別が付かず 2 度回り道をした。ここで WebSocket を包んで数える。
   */
  readonly sockets: readonly {
    readonly kind: string;
    readonly text: number;
    readonly binary: number;
    readonly sentText: number;
    readonly keyframeRequests: number;
  }[];
  /** 復号器の計数（試験側の計測）。 */
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

declare global {
  interface Window {
    __whesoSdk?: (
      host: string,
      meetingId: string,
      tokenKey: string,
      userA: string,
      userB: string,
      durationMs: number,
    ) => Promise<SdkResult>;
    __whesoSdkResult?: SdkResult;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 復号できたフレームの寸法を読む。型はブラウザにしか無いため実行時に検査する。 */
function frameSize(frame: unknown): { readonly width: number; readonly height: number } | null {
  if (typeof frame !== "object" || frame === null) {
    return null;
  }
  const width = Reflect.get(frame, "displayWidth");
  const height = Reflect.get(frame, "displayHeight");
  if (typeof width !== "number" || typeof height !== "number") {
    return null;
  }
  return { width, height };
}

async function tokenFor(tokenKey: string, meetingId: string, userId: string): Promise<string> {
  const nowSec = Math.trunc(Date.now() / 1000);
  const issued = await issueToken(new TextEncoder().encode(tokenKey), {
    iss: "wheso-e2e",
    sub: userId,
    aud: meetingId,
    iat: nowSec,
    exp: nowSec + 60,
    jti: `e2e-${String(nowSec)}-${userId.slice(-3)}`,
    kind: "client",
    role: "host",
  });
  return issued.ok ? issued.value : "";
}

async function run(
  host: string,
  meetingId: string,
  tokenKey: string,
  userA: string,
  userB: string,
  durationMs: number,
): Promise<SdkResult> {
  const logs: string[] = [];
  let bFrames = 0;
  let aFrames = 0;
  const slopes: { readonly num: number; readonly den: number }[] = [];
  // 部屋の種別（vr / ar / ctl / vs / as / meta）ごとに数える。
  const socketCounts = new Map<
    string,
    { text: number; binary: number; sentText: number; keyframeRequests: number }
  >();
  const OriginalSocket = globalThis.WebSocket;
  class CountingSocket extends OriginalSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const text = String(url);
      const match = /\/parties\/[a-z]+\/([a-z]+)-/.exec(text);
      const kind = match?.[1] ?? "other";
      const entry = socketCounts.get(kind) ?? { text: 0, binary: 0, sentText: 0, keyframeRequests: 0 };
      socketCounts.set(kind, entry);
      const originalSend = this.send.bind(this);
      this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView): void => {
        if (typeof data === "string") {
          entry.sentText += 1;
          if (data.includes("keyframeRequest")) {
            entry.keyframeRequests += 1;
          }
        }
        originalSend(data);
      };
      this.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data === "string") {
          entry.text += 1;
          return;
        }
        entry.binary += 1;
      });
    }
  }
  globalThis.WebSocket = CountingSocket;

  // **復号器を包む。** 「投入されていない」「設定されていない」「例外で落ちた」を
  // 公開 API からは区別できない。試験側で数える。
  const decoderCounts = { created: 0, configured: 0, decoded: 0, output: 0, errors: 0 };
  const decoderErrors: string[] = [];
  const OriginalDecoder = globalThis.VideoDecoder;
  class CountingDecoder extends OriginalDecoder {
    constructor(init: VideoDecoderInit) {
      super({
        output: (frame: VideoFrame): void => {
          decoderCounts.output += 1;
          init.output(frame);
        },
        error: (error: DOMException): void => {
          decoderCounts.errors += 1;
          if (decoderErrors.length < 5) {
            decoderErrors.push(String(error.message));
          }
          init.error(error);
        },
      });
      decoderCounts.created += 1;
    }

    override configure(config: VideoDecoderConfig): void {
      decoderCounts.configured += 1;
      super.configure(config);
    }

    override decode(chunk: EncodedVideoChunk): void {
      decoderCounts.decoded += 1;
      super.decode(chunk);
    }
  }
  globalThis.VideoDecoder = CountingDecoder;
  let firstFrame: { readonly width: number; readonly height: number } | null = null;

  // 取得と符号化の前提を記録する。無い機能があれば原因がここで判る。
  logs.push(`VideoEncoder=${String(typeof Reflect.get(globalThis, "VideoEncoder"))}`);
  logs.push(`VideoDecoder=${String(typeof Reflect.get(globalThis, "VideoDecoder"))}`);
  logs.push(`TrackProcessor=${String(typeof Reflect.get(globalThis, "MediaStreamTrackProcessor"))}`);
  try {
    const probe: unknown = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (typeof probe === "object" && probe !== null) {
      const tracks: unknown = Reflect.apply(Reflect.get(probe, "getTracks"), probe, []);
      if (Array.isArray(tracks)) {
        logs.push(`tracks=${String(tracks.length)}`);
        for (const track of tracks) {
          const settings: unknown = Reflect.apply(Reflect.get(track, "getSettings"), track, []);
          logs.push(`track ${String(Reflect.get(track, "kind"))} ${JSON.stringify(settings)}`);
          Reflect.apply(Reflect.get(track, "stop"), track, []);
        }
      }
    }
  } catch (error) {
    logs.push(`getUserMedia 失敗: ${error instanceof Error ? error.message : "不明"}`);
  }
  const supported = await Reflect.apply(
    Reflect.get(Reflect.get(globalThis, "VideoEncoder"), "isConfigSupported"),
    Reflect.get(globalThis, "VideoEncoder"),
    [{ codec: "av01.0.08M.08", width: 640, height: 360, framerate: 15, bitrate: 200000, scalabilityMode: "L1T2" }],
  );
  logs.push(`av1 640x360 L1T2=${JSON.stringify(supported)}`);

  const tokenA = await tokenFor(tokenKey, meetingId, userA);
  const tokenB = await tokenFor(tokenKey, meetingId, userB);
  if (tokenA.length === 0 || tokenB.length === 0) {
    return {
      ok: false,
      detail: "トークンを発行できない",
      aParticipants: 0,
      bParticipants: 0,
      bFrames: 0,
      firstFrame: null,
      aFrames: 0,
      aUplinkBps: 0,
      bDownlinkBps: 0,
      slopes,
      sockets: [...socketCounts.entries()].map(([kind, value]) => ({
      kind,
      text: value.text,
      binary: value.binary,
      sentText: value.sentText,
      keyframeRequests: value.keyframeRequests,
    })),
      decoder: { ...decoderCounts, messages: decoderErrors },
      logs,
    };
  }

  // **公開 API だけを使う。** 注入は既定（ブラウザ）に任せる。
  const joinedA = await joinMeeting(`https://${host}/j/${meetingId}#${tokenA}`);
  if (!joinedA.ok) {
    return {
      ok: false,
      detail: `A が参加できない: ${joinedA.error.code} ${joinedA.error.detail}`,
      aParticipants: 0,
      bParticipants: 0,
      bFrames: 0,
      firstFrame: null,
      aFrames: 0,
      aUplinkBps: 0,
      bDownlinkBps: 0,
      slopes,
      sockets: [...socketCounts.entries()].map(([kind, value]) => ({
      kind,
      text: value.text,
      binary: value.binary,
      sentText: value.sentText,
      keyframeRequests: value.keyframeRequests,
    })),
      decoder: { ...decoderCounts, messages: decoderErrors },
      logs,
    };
  }
  const joinedB = await joinMeeting(`https://${host}/j/${meetingId}#${tokenB}`);
  if (!joinedB.ok) {
    return {
      ok: false,
      detail: `B が参加できない: ${joinedB.error.code} ${joinedB.error.detail}`,
      aParticipants: joinedA.value.meeting.participants.length,
      bParticipants: 0,
      bFrames: 0,
      firstFrame: null,
      aFrames: 0,
      aUplinkBps: 0,
      bDownlinkBps: 0,
      slopes,
      sockets: [...socketCounts.entries()].map(([kind, value]) => ({
      kind,
      text: value.text,
      binary: value.binary,
      sentText: value.sentText,
      keyframeRequests: value.keyframeRequests,
    })),
      decoder: { ...decoderCounts, messages: decoderErrors },
      logs,
    };
  }

  // 生のフレームを数える。既定では発火しないため明示的に購読する（sdk-api.md 4 節）。
  joinedA.value.meeting.subscribeFrames();
  joinedB.value.meeting.subscribeFrames();
  joinedB.value.meeting.on("frameReceived", (event) => {
    bFrames += 1;
    if (firstFrame === null) {
      firstFrame = frameSize(event.frame);
    }
  });
  joinedA.value.meeting.on("frameReceived", () => {
    aFrames += 1;
  });
  // 勾配を記録する。判定には使わない（閾値を決めるための観測である）。
  joinedB.value.meeting.on("qualityChanged", (quality) => {
    if (quality.delayTrendDenominator !== 0 && slopes.length < 2000) {
      slopes.push({ num: quality.delayTrendNumerator, den: quality.delayTrendDenominator });
    }
  });
  joinedA.value.meeting.on("error", (code) => logs.push(`A error ${String(code)}`));
  joinedB.value.meeting.on("error", (code) => logs.push(`B error ${String(code)}`));
  joinedA.value.meeting.on("warning", (code) => logs.push(`A warn ${String(code)}`));
  joinedB.value.meeting.on("warning", (code) => logs.push(`B warn ${String(code)}`));

  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    await sleep(500);
    // **早く抜けない。** 勾配の分布を測るため、指定の時間ぶん流し続ける（Q-026）。
  }

  const result: SdkResult = {
    ok: bFrames > 0 && aFrames > 0,
    detail:
      bFrames > 0 && aFrames > 0
        ? "双方向に復号できた"
        : `復号できていない（A ${String(aFrames)} 枚 / B ${String(bFrames)} 枚）`,
    aParticipants: joinedA.value.meeting.participants.length,
    bParticipants: joinedB.value.meeting.participants.length,
    bFrames,
    firstFrame,
    aFrames,
    aUplinkBps: joinedA.value.meeting.quality.uplinkBps,
    bDownlinkBps: joinedB.value.meeting.quality.downlinkBps,
    slopes,
    sockets: [...socketCounts.entries()].map(([kind, value]) => ({
      kind,
      text: value.text,
      binary: value.binary,
      sentText: value.sentText,
      keyframeRequests: value.keyframeRequests,
    })),
    decoder: { ...decoderCounts, messages: decoderErrors },
    logs,
  };
  joinedA.value.meeting.leave();
  joinedB.value.meeting.leave();
  return result;
}

window.__whesoSdk = async (host, meetingId, tokenKey, userA, userB, durationMs) => {
  try {
    const result = await run(host, meetingId, tokenKey, userA, userB, durationMs);
    window.__whesoSdkResult = result;
    return result;
  } catch (error) {
    const failed: SdkResult = {
      ok: false,
      detail: error instanceof Error ? `${error.name}: ${error.message}` : "不明な失敗",
      aParticipants: 0,
      bParticipants: 0,
      bFrames: 0,
      firstFrame: null,
      aFrames: 0,
      aUplinkBps: 0,
      bDownlinkBps: 0,
      slopes: [],
      sockets: [],
      decoder: { created: 0, configured: 0, decoded: 0, output: 0, errors: 0, messages: [] },
      logs: [],
    };
    window.__whesoSdkResult = failed;
    return failed;
  }
};
