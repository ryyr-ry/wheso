/**
 * 符号化器の時刻をエポック基準のマイクロ秒へ直す。
 *
 * **`VideoFrame.timestamp` と `AudioData.timestamp` は同じ原点を持たない**（Q-022）。
 * どちらもトラックの開始からの経過であり、開始時刻が別であるため、両者をそのまま
 * ワイヤへ載せると受信側の A/V 同期が壊れる。受信側は音声の時刻を基準に映像の
 * 提示時刻を決めるため（`playout.ts` の `mapToLocalMs`）、原点が数秒ずれるだけで
 * **すべての映像が「早すぎる」または「遅すぎる」と判定され 1 枚も提示されない**
 * （実測: ブラウザへ映像 1,131 件が届いていたのに提示は 0 枚。F-052）。
 *
 * チャネルごとに最初のフレームで差を求め、以後はそれを足す。こうすると
 * **フレーム間の間隔は符号化器の時刻のまま保たれ**、原点だけがエポックに揃う。
 */
function makeEpochClock(): (timestampUs: number) => number {
  let offsetUs: number | null = null;
  return (timestampUs: number): number => {
    if (offsetUs === null) {
      offsetUs = Date.now() * 1000 - timestampUs;
    }
    return timestampUs + offsetUs;
  };
}

/**
 * ブラウザの取得と符号化（端）。
 *
 * 規範: ADR-0004（解像度方向は simulcast。段ごとに独立した `VideoEncoder`）、
 *       ADR-0026（はしごは源から導出する。拡大しない）、
 *       client-architecture.md 3 節（送信経路）、10 節（発熱と CPU による降格）。
 *
 * **ここには判断を置かない。** 何段作るかは `core/ladder.ts` が決め、連番と束ねは
 * `api/send-pipeline.ts` が決め、破棄可否は `core/wire.ts` が決める。本ファイルが行うのは、
 * 決まったことを実際の `VideoEncoder` / `AudioEncoder` / `MediaStreamTrack` へ写すことだけである。
 *
 * **この層は Node では検証できない。** WebCodecs と `MediaStreamTrackProcessor` は
 * ブラウザにしか無い。したがって送信の判断は `send-pipeline` の試験で、この層は E2E で確かめる。
 * 型で守れない部分は実行時に検査する（型定義を信用しない。AGENTS 5.4 の 3）。
 */

import type { SendRung, SourceSpec } from "@wheso/core/src/ladder.ts";
import { audioConfigFor } from "./audio-send.ts";
import { temporalIdFrom } from "./encoder-set.ts";
import type { EncodedVideo } from "../api/send-pipeline.ts";

/** 符号化できたものを入口へ渡す口。 */
export interface CaptureOutput {
  readonly onVideo: (video: EncodedVideo) => void;
  readonly onAudio: (frame: { readonly captureTimestampUs: bigint; readonly silent: boolean; readonly payload: Uint8Array }) => void;
}

/** 取得と符号化の口。試験では記録する偽物を渡す。 */
export interface CaptureDeps {
  /** 出力の宛先を繋ぐ。**接続を開く前に呼ぶ。** */
  readonly bindCapture: (output: CaptureOutput) => void;
  /**
   * 取得を始める。カメラとマイクを取り、符号化して出力へ流す。
   *
   * 戻り値は**源の実測値**である（`MediaStreamTrack.getSettings()` 由来）。
   * はしごは源から導出するため実測値が必要である（ADR-0026）。取得できない環境では
   * `source` が null になり、呼び出し側は注入された既定値を使う。
   *
   * **取得と符号化を同じ口にする理由。** 別々にすると、寸法を測るためだけに
   * `getUserMedia` を呼んでトラックを開いたまま捨てる実装になる（実際にそうなっていた。
   * `camera: false` でもカメラのランプが点いたままだった）。
   */
  readonly startCapture: (options: CaptureRequest) => Promise<CaptureStarted>;
  /**
   * はしごに合わせて符号化器を用意する。
   * 既にある段はそのまま使う（作り直すとキーフレームが必要になり画面が乱れる）。
   */
  readonly configureVideo: (rungs: readonly SendRung[]) => void;
  /** 音声の符号化器を用意する。 */
  readonly configureAudio: (profile: "voice" | "music") => void;
  /** 指定した段で次のフレームをキーフレームにする（`keyframeRequest` への応答）。 */
  readonly requestKeyframe: (spatialId: number) => void;
  /** 送出の入切。カメラとマイクの操作に対応する。 */
  readonly setVideoEnabled: (enabled: boolean) => void;
  readonly setAudioEnabled: (enabled: boolean) => void;
  /** 符号化の待ち行列の長さ（最大値）。CPU 由来の降格に使う（ADR-0014）。 */
  readonly encodeQueueSize: () => number;
  /** 取得を止め、資源を解放する。 */
  readonly close: () => void;
}

export interface CaptureRequest {
  readonly camera: boolean;
  readonly microphone: boolean;
}

export interface CaptureStarted {
  /** 源の実測値。取得できなければ null。 */
  readonly source: SourceSpec | null;
  /** 映像の取得が成立したか。 */
  readonly video: boolean;
  /** 音声の取得が成立したか。 */
  readonly audio: boolean;
}

/** 符号化器 1 個ぶんの記録。 */
interface VideoEncoderEntry {
  readonly spatialId: number;
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
  readonly temporalLayers: number;
  /** `VideoEncoder` の実体。型はブラウザにしか無いため未知の型で保持する。 */
  readonly encoder: unknown;
}

/**
 * ブラウザの端を作る。
 *
 * WebCodecs が無い環境では「何もしない実装」を返す。**例外を投げない。**
 * 投げると、能力の無い環境で参加そのものが失敗する。
 */
export function browserCaptureDeps(): CaptureDeps {
  const videoEncoders = new Map<number, VideoEncoderEntry>();
  let output: CaptureOutput | null = null;
  // 映像と音声で別の原点を 1 つのエポックへ揃える（F-052）。
  const videoClock = makeEpochClock();
  const audioClock = makeEpochClock();
  let audioEncoder: unknown = null;
  let videoEnabled = true;
  let audioEnabled = true;
  /** 次のフレームでキーフレームを要求する段。 */
  const keyframeWanted = new Set<number>();
  /**
   * 段ごとの「次に符号化器へ渡してよい時刻」（ミリ秒）。
   * 申告 fps を超えて渡さないために持つ（`encodeFrame` の注記）。
   */
  const nextDueMs = new Map<number, number>();
  /** 取得したトラックの読み出しを止めるための取り消し。 */
  const stops: (() => void)[] = [];

  const videoEncoderCtor = Reflect.get(globalThis, "VideoEncoder");
  const audioEncoderCtor = Reflect.get(globalThis, "AudioEncoder");

  function emitVideo(spatialId: number, chunk: unknown, metadata: unknown): void {
    const entry = videoEncoders.get(spatialId);
    if (entry === undefined || output === null) {
      return;
    }
    const payload = copyChunk(chunk);
    if (payload === null) {
      return;
    }
    const timestamp = readNumber(chunk, "timestamp");
    // **`{...chunk}` で読んではならない。** 分配は自分自身の列挙可能な欄しか写さないため、
    // プロトタイプ上のゲッター（`type`）が失われ、キーフレームの判定が常に false になる。
    const type = typeof chunk === "object" && chunk !== null ? Reflect.get(chunk, "type") : undefined;
    output.onVideo({
      spatialId,
      temporalId: temporalIdFrom(metadata),
      temporalLayers: entry.temporalLayers,
      isKey: type === "key",
      captureTimestampUs: BigInt(videoClock(timestamp ?? 0)),
      payload,
    });
  }

  return {
    bindCapture: (next): void => {
      output = next;
    },

    startCapture: async (request): Promise<CaptureStarted> => {
      const empty: CaptureStarted = { source: null, video: false, audio: false };
      const navigatorObject = Reflect.get(globalThis, "navigator");
      if (typeof navigatorObject !== "object" || navigatorObject === null) {
        return empty;
      }
      const devices = Reflect.get(navigatorObject, "mediaDevices");
      if (typeof devices !== "object" || devices === null) {
        return empty;
      }
      const getUserMedia = Reflect.get(devices, "getUserMedia");
      if (typeof getUserMedia !== "function") {
        return empty;
      }
      if (!request.camera && !request.microphone) {
        // **要求されていない装置を開かない。** 開くとランプが点き、利用者を驚かせる。
        return empty;
      }
      let stream: unknown;
      try {
        stream = await Reflect.apply(getUserMedia, devices, [
          { video: request.camera, audio: request.microphone },
        ]);
      } catch {
        // 拒否された。参加そのものは成立させる（受信はできる）。
        return empty;
      }
      const videoTrack = firstTrack(stream, "getVideoTracks");
      const audioTrack = firstTrack(stream, "getAudioTracks");
      if (videoTrack !== null) {
        pump(videoTrack, encodeFrame);
      }
      if (audioTrack !== null) {
        pump(audioTrack, encodeAudio);
      }
      return {
        source: sourceOf(videoTrack),
        video: videoTrack !== null,
        audio: audioTrack !== null,
      };
    },

    configureVideo: (rungs): void => {
      if (typeof videoEncoderCtor !== "function") {
        return;
      }
      // 無くなった段の符号化器を閉じる。**はしごが縮んだら資源も返す。**
      for (const [spatialId, entry] of [...videoEncoders]) {
        if (!rungs.some((rung) => rung.sid === spatialId)) {
          callMethod(entry.encoder, "close", []);
          videoEncoders.delete(spatialId);
        }
      }
      for (const rung of rungs) {
        const existing = videoEncoders.get(rung.sid);
        if (
          existing !== undefined &&
          existing.width === rung.width &&
          existing.height === rung.height &&
          existing.framerate === rung.framerate
        ) {
          // 同じ設定である。作り直さない（作り直すとキーフレームが必要になる）。
          continue;
        }
        if (existing !== undefined) {
          callMethod(existing.encoder, "close", []);
          videoEncoders.delete(rung.sid);
        }
        const spatialId = rung.sid;
        const encoder = construct(videoEncoderCtor, [
          {
            output: (chunk: unknown, metadata: unknown): void => {
              emitVideo(spatialId, chunk, metadata);
            },
            error: (): void => {
              // 符号化の失敗は次のフレームで復帰する。段を閉じない。
            },
          },
        ]);
        if (encoder === null) {
          continue;
        }
        const configured = callMethod(encoder, "configure", [
          {
            codec: rung.codec,
            width: rung.width,
            height: rung.height,
            framerate: rung.framerate,
            bitrate: rung.targetBitrate,
            scalabilityMode: rung.scalabilityMode,
            latencyMode: "realtime",
          },
        ]);
        if (!configured) {
          continue;
        }
        videoEncoders.set(rung.sid, {
          spatialId: rung.sid,
          width: rung.width,
          height: rung.height,
          framerate: rung.framerate,
          temporalLayers: rung.temporalLayers,
          encoder,
        });
      }
    },

    configureAudio: (profile): void => {
      if (typeof audioEncoderCtor !== "function" || output === null) {
        return;
      }
      const config = audioConfigFor(profile);
      const created = construct(audioEncoderCtor, [
        {
          output: (chunk: unknown): void => {
            if (output === null) {
              return;
            }
            const payload = copyChunk(chunk);
            if (payload === null) {
              return;
            }
            const timestamp = readNumber(chunk, "timestamp");
            output.onAudio({
              captureTimestampUs: BigInt(audioClock(timestamp ?? 0)),
              // DTX の判定は符号化器の出力の大きさでは決められない。無音の印は
              // 取得側が付けるべきものであり、ここでは常に false とする。
              silent: false,
              payload,
            });
          },
          error: (): void => undefined,
        },
      ]);
      if (created === null) {
        return;
      }
      callMethod(created, "configure", [
        {
          codec: config.codec,
          sampleRate: config.sampleRate,
          numberOfChannels: config.numberOfChannels,
          bitrate: config.bitrate,
        },
      ]);
      audioEncoder = created;
    },

    requestKeyframe: (spatialId): void => {
      keyframeWanted.add(spatialId);
    },

    setVideoEnabled: (enabled): void => {
      videoEnabled = enabled;
    },

    setAudioEnabled: (enabled): void => {
      audioEnabled = enabled;
    },

    encodeQueueSize: (): number => {
      let worst = 0;
      for (const entry of videoEncoders.values()) {
        const size = readNumber(entry.encoder, "encodeQueueSize");
        if (size !== null && size > worst) {
          worst = size;
        }
      }
      return worst;
    },

    close: (): void => {
      for (const stop of stops) {
        stop();
      }
      stops.length = 0;
      for (const entry of videoEncoders.values()) {
        callMethod(entry.encoder, "close", []);
      }
      videoEncoders.clear();
      callMethod(audioEncoder, "close", []);
      audioEncoder = null;
      output = null;
    },
  };

  /**
   * 映像フレームを符号化する（すべての段へ渡す）。
   *
   * 段ごとに独立した符号化器へ同じフレームを渡す（simulcast。ADR-0004）。
   * 縮小は符号化器が行う（`configure` の width / height）。
   *
   * **申告した fps を超えて渡してはならない。**
   *
   * `VideoEncoder` の `framerate` は助言であり、投入した数がそのまま出る。取得の
   * トラックは 30 fps で回るため、15 fps と申告した段へ全フレームを渡すと**申告の 2 倍**が
   * ワイヤへ出る。中継ノードの送信窓は申告 fps から幅を決める
   * （`inFlight × 1000 > SEND_WINDOW_MS × framerate`。congestion.md 2 節）ため、
   * 2 倍の速さで届くと窓が閉じ、**基底層まで捨てられる**。
   * 実測（2026-07-30、実環境・劣化なし）: 符号化 1,472 件のうちワイヤへ 1,342 件、
   * 中継ノードが 842 件（うち優先度 4 が 417 件）を捨て、購読者へは 413 件しか届かなかった。
   * 受信側は 1 枚おきに欠けた（判定 B-2 が 363 件）。
   *
   * 間隔は整数で数える。段ごとに「次に渡してよい時刻」を持ち、それより前のフレームは
   * その段に渡さない（他の段には渡す。段ごとに fps が違う）。
   */
  function encodeFrame(frame: unknown): void {
    if (!videoEnabled) {
      closeFrame(frame);
      return;
    }
    const nowMs = Date.now();
    for (const entry of videoEncoders.values()) {
      if (!dueForRung(entry.spatialId, entry.framerate, nowMs)) {
        continue;
      }
      const wantKey = keyframeWanted.delete(entry.spatialId);
      callMethod(entry.encoder, "encode", [frame, { keyFrame: wantKey }]);
    }
    closeFrame(frame);
  }

  /**
   * その段へこのフレームを渡してよいか。
   *
   * 申告 fps の間隔を空ける。**間隔は「前に渡した時刻」からではなく「予定の時刻」から
   * 進める**（前者だと 1 回の遅れが累積し、実効 fps が申告より下がり続ける）。
   * 予定が現在から 1 間隔以上遅れていれば現在に合わせ直す（停止からの復帰）。
   */
  function dueForRung(spatialId: number, framerate: number, nowMs: number): boolean {
    if (framerate <= 0) {
      return true;
    }
    const intervalMs = Math.trunc(1000 / framerate);
    const planned = nextDueMs.get(spatialId);
    if (planned === undefined) {
      nextDueMs.set(spatialId, nowMs + intervalMs);
      return true;
    }
    if (nowMs < planned) {
      return false;
    }
    const advanced = planned + intervalMs;
    nextDueMs.set(spatialId, advanced <= nowMs ? nowMs + intervalMs : advanced);
    return true;
  }

  /** 音声のかたまりを符号化する。 */
  function encodeAudio(data: unknown): void {
    if (!audioEnabled) {
      closeFrame(data);
      return;
    }
    callMethod(audioEncoder, "encode", [data]);
    closeFrame(data);
  }

  /**
   * トラックからフレームを読み出し続ける。
   *
   * `MediaStreamTrackProcessor` を使う。無い環境では読み出せないため何もしない
   * （**例外を投げない**。参加そのものは成立させる）。
   */
  function pump(track: unknown, encode: (frame: unknown) => void): void {
    const processorCtor = Reflect.get(globalThis, "MediaStreamTrackProcessor");
    if (typeof processorCtor !== "function") {
      return;
    }
    const processor = construct(processorCtor, [{ track }]);
    if (processor === null) {
      return;
    }
    const readable = typeof processor === "object" ? Reflect.get(processor, "readable") : null;
    if (typeof readable !== "object" || readable === null) {
      return;
    }
    const getReader = Reflect.get(readable, "getReader");
    if (typeof getReader !== "function") {
      return;
    }
    let reader: unknown;
    try {
      reader = Reflect.apply(getReader, readable, []);
    } catch {
      return;
    }
    let stopped = false;
    stops.push(() => {
      stopped = true;
      callMethod(reader, "cancel", []);
      callMethod(track, "stop", []);
    });
    // 同じ理由で、読み出しのメソッドも分配せずに引く（`read` はプロトタイプ上にある）。
    const read = typeof reader === "object" && reader !== null ? Reflect.get(reader, "read") : undefined;
    if (typeof read !== "function") {
      return;
    }
    const loop = async (): Promise<void> => {
      while (!stopped) {
        let result: unknown;
        try {
          result = await Reflect.apply(read, reader, []);
        } catch {
          return;
        }
        if (typeof result !== "object" || result === null) {
          return;
        }
        if (Reflect.get(result, "done") === true) {
          return;
        }
        encode(Reflect.get(result, "value"));
      }
    };
    void loop();
  }
}

/** `VideoFrame` / `AudioData` は明示的に閉じる。閉じないと資源が漏れる。 */
function closeFrame(frame: unknown): void {
  callMethod(frame, "close", []);
}

/** ストリームから最初のトラックを取る。無ければ null。 */
function firstTrack(stream: unknown, method: string): unknown {
  if (typeof stream !== "object" || stream === null) {
    return null;
  }
  const getTracks = Reflect.get(stream, method);
  if (typeof getTracks !== "function") {
    return null;
  }
  let tracks: unknown;
  try {
    tracks = Reflect.apply(getTracks, stream, []);
  } catch {
    return null;
  }
  if (!Array.isArray(tracks)) {
    return null;
  }
  return tracks[0] ?? null;
}

/**
 * トラックの実測値から源を作る。
 *
 * **推測で大きい値を返してはならない**（ADR-0026）。欄が 1 つでも欠けたら null を返し、
 * 呼び出し側の既定値に委ねる。
 */
function sourceOf(track: unknown): SourceSpec | null {
  if (typeof track !== "object" || track === null) {
    return null;
  }
  const getSettings = Reflect.get(track, "getSettings");
  if (typeof getSettings !== "function") {
    return null;
  }
  let settings: unknown;
  try {
    settings = Reflect.apply(getSettings, track, []);
  } catch {
    return null;
  }
  const width = readNumber(settings, "width");
  const height = readNumber(settings, "height");
  const framerate = readNumber(settings, "frameRate");
  if (width === null || height === null || framerate === null) {
    return null;
  }
  return { width, height, framerate };
}


function readNumber(target: unknown, name: string): number | null {
  if (typeof target !== "object" || target === null) {
    return null;
  }
  const value = Reflect.get(target, name);
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

/** チャンクの中身を写す。`copyTo` を持つ実装（WebCodecs）に従う。 */
function copyChunk(chunk: unknown): Uint8Array | null {
  const size = readNumber(chunk, "byteLength");
  if (size === null || size <= 0) {
    return null;
  }
  const buffer = new Uint8Array(size);
  if (!callMethod(chunk, "copyTo", [buffer])) {
    return null;
  }
  return buffer;
}

/** 未知の型のオブジェクトのメソッドを呼ぶ。存在しなければ何もしない（例外を投げない）。 */
function callMethod(target: unknown, name: string, args: readonly unknown[]): boolean {
  if (typeof target !== "object" || target === null) {
    return false;
  }
  const method = Reflect.get(target, name);
  if (typeof method !== "function") {
    return false;
  }
  try {
    Reflect.apply(method, target, args);
    return true;
  } catch {
    return false;
  }
}

/** 未知の型の構築子を呼ぶ。失敗したら null を返す（例外を投げない）。 */
function construct(ctor: unknown, args: readonly unknown[]): unknown {
  if (typeof ctor !== "function") {
    return null;
  }
  try {
    return Reflect.construct(ctor, args);
  } catch {
    return null;
  }
}
