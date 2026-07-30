/**
 * ブラウザの復号と音声再生（端）。
 *
 * 規範: client-architecture.md 4 節（受信パイプライン）、5 節（スレッド配置）、
 *       ADR-0028（音声を再生クロックの基準にする）。
 *
 * **ここには判断を置かない。** 復号するかどうかは `media/decoder-pool.ts` が決め、
 * 提示してよいかは `core/playout.ts` が決める。本ファイルが行うのは、決まったことを
 * 実際の `VideoDecoder` / `AudioDecoder` / `AudioContext` へ写すことだけである。
 *
 * **この層は Node では検証できない。** WebCodecs と Web Audio はブラウザにしか無い。
 * したがって受信経路の判断は `receive-pipeline` の試験で、この層は E2E（段 D）で確かめる。
 * 型で守れない部分は実行時に検査する（型定義を信用しない。AGENTS 5.4 の 3）。
 */

import { A_VOICE, OPUS_FRAME_MS } from "@wheso/core/src/generated/constants.ts";
import type { DecodeInput, PipelineDeps } from "../api/receive-pipeline.ts";
import { createPresentGate } from "../sync/present-gate.ts";

/** 復号できた映像 1 枚。型は環境ごとに異なるため未知の型で受け渡す。 */
export type DecodedFrame = unknown;

export interface BrowserMediaOptions {
  /** 局所の単調時計（ミリ秒）。提示の門が使う。 */
  readonly now: () => number;
  /** 指定時刻に発火させる。戻り値は取り消しの手続き。提示の門が使う。 */
  readonly scheduleAt: (atMs: number, fire: () => void) => () => void;
  /** 復号できた映像を受け取る。呼び出し側が受け皿へ描く。 */
  readonly onFrame: (senderId: number, frame: DecodedFrame) => void;
  /** 復号に失敗したことを伝える。キーフレームの再要求に使う。 */
  readonly onDecodeError: (senderId: number, channel: number) => void;
}

/** 復号器 1 個ぶんの記録。 */
interface VideoEntry {
  readonly key: string;
  readonly senderId: number;
  /** `VideoDecoder` の実体。型はブラウザにしか無いため未知の型で保持する。 */
  readonly decoder: unknown;
}

/**
 * 端を作る。
 *
 * WebCodecs が無い環境では何もしない実装を返す。**例外を投げない。**
 * 投げると、能力の無い環境で参加そのものが失敗する。
 */
export function browserMediaDeps(options: BrowserMediaOptions): Omit<PipelineDeps, "now" | "sendReceiveControl"> {
  // 提示の門。映像だけに使う（音声は待たせない）。
  const gate = createPresentGate({ now: options.now, scheduleAt: options.scheduleAt });
  const videos = new Map<string, VideoEntry>();
  const audio = createAudioSink();

  const videoDecoderCtor = Reflect.get(globalThis, "VideoDecoder");
  const chunkCtor = Reflect.get(globalThis, "EncodedVideoChunk");

  function keyOf(senderId: number, channel: number): string {
    return `${String(senderId)}:${String(channel)}`;
  }

  return {
    configureDecoder: (senderId, channel, spatialId): void => {
      if (typeof videoDecoderCtor !== "function") {
        return;
      }
      const key = keyOf(senderId, channel);
      closeVideo(videos, key);
      const decoder = construct(videoDecoderCtor, [
        {
          output: (frame: DecodedFrame): void => {
            options.onFrame(senderId, frame);
            // **`VideoFrame` は明示的に閉じる。** 閉じないと復号器の資源が尽き、
            // 数百枚で復号が止まる（WebCodecs の要件）。利用側は同期に使い終える。
            closeFrame(frame);
          },
          error: (): void => {
            options.onDecodeError(senderId, channel);
          },
        },
      ]);
      if (decoder === null) {
        return;
      }
      // コーデックは AV1 を既定とする。H.264 の場合は申告から決めるべきであり、
      // その配線は送信側のはしごの申告（ADR-0026 の 7）を受け取ってから行う。
      const configured = callMethod(decoder, "configure", [
        { codec: "av01.0.08M.08", optimizeForLatency: true },
      ]);
      if (!configured) {
        return;
      }
      void spatialId;
      videos.set(key, { key, senderId, decoder });
    },

    resetDecoder: (senderId, channel, spatialId): void => {
      const key = keyOf(senderId, channel);
      const entry = videos.get(key);
      if (entry === undefined) {
        return;
      }
      // 段が変わった。復号器を初期化してキーフレームを待つ（規則 4）。
      callMethod(entry.decoder, "reset", []);
      callMethod(entry.decoder, "configure", [
        { codec: "av01.0.08M.08", optimizeForLatency: true },
      ]);
      void spatialId;
    },

    closeDecoder: (senderId, channel): void => {
      // 順序の記録も捨てる。残すと退出した相手の予定時刻に縛られる。
      gate.release(senderId);
      closeVideo(videos, keyOf(senderId, channel));
    },

    decodeVideo: (input): void => {
      const entry = videos.get(keyOf(input.senderId, input.channel));
      if (entry === undefined || typeof chunkCtor !== "function") {
        return;
      }
      const chunk = construct(chunkCtor, [
        {
          type: input.key ? "key" : "delta",
          timestamp: input.captureTimestampUs,
          data: input.payload,
        },
      ]);
      if (chunk === null) {
        return;
      }
      // **提示予定時刻まで待つ**（ADR-0042）。直ちに復号して描くと、束ねで遅れる音声に
      // 対して映像が先行する（実測 p99 88 ms。F-063）。門が順序も保証する。
      gate.submit(input.senderId, input.presentAtMs, () => {
        callMethod(entry.decoder, "decode", [chunk]);
      });
    },

    enqueueAudio: (input): void => {
      // **音声は決して捨てない。** 復号器が無い環境でも呼び出しは失敗させない。
      audio.enqueue(input);
    },
  };
}

/** `VideoFrame` / `AudioData` を明示的に閉じる。閉じないと資源が漏れる。 */
function closeFrame(frame: unknown): void {
  callMethod(frame, "close", []);
}

function closeVideo(videos: Map<string, VideoEntry>, key: string): void {
  const entry = videos.get(key);
  if (entry === undefined) {
    return;
  }
  callMethod(entry.decoder, "close", []);
  videos.delete(key);
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
    // 復号器の状態遷移の失敗は致命的でない。次のキーフレームで復帰する。
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

/** 音声の再生口。 */
interface AudioSink {
  readonly enqueue: (input: DecodeInput) => void;
}

/**
 * 音声の再生。
 *
 * `AudioDecoder` で Opus を復号し、`AudioContext` の時刻に沿って並べる。
 * **`AudioContext.currentTime` が再生クロックの基準である**（client-architecture.md 4 節の
 * 規則 5、ADR-0028 の原則 1）。音声を遅らせて映像を待つことはしない。
 *
 * Web Audio が無い環境では何もしない。参加そのものは成立させる。
 */
function createAudioSink(): AudioSink {
  const contextCtor = Reflect.get(globalThis, "AudioContext");
  const decoderCtor = Reflect.get(globalThis, "AudioDecoder");
  const chunkCtor = Reflect.get(globalThis, "EncodedAudioChunk");
  if (typeof contextCtor !== "function" || typeof decoderCtor !== "function" || typeof chunkCtor !== "function") {
    return { enqueue: (): void => undefined };
  }
  const context = construct(contextCtor, []);
  if (context === null) {
    return { enqueue: (): void => undefined };
  }

  const decoders = new Map<number, unknown>();
  /** 送信者ごとの次の再生位置（秒）。`AudioContext` の時刻軸で持つ。 */
  const nextAt = new Map<number, number>();

  /** `context` は未知の型である。参照のたびに実行時に検査する（型定義を信用しない）。 */
  function readProperty(target: unknown, name: string): unknown {
    if (typeof target !== "object" || target === null) {
      return undefined;
    }
    return Reflect.get(target, name);
  }

  function writeProperty(target: unknown, name: string, value: unknown): void {
    if (typeof target !== "object" || target === null) {
      return;
    }
    Reflect.set(target, name, value);
  }

  function scheduleAt(senderId: number): number {
    const now = readProperty(context, "currentTime");
    const current = typeof now === "number" ? now : 0;
    const planned = nextAt.get(senderId);
    if (planned === undefined || planned < current) {
      // 初回、または遅れた。**音声は待たせない。** 直ちに鳴らす位置へ置き直す。
      return current;
    }
    return planned;
  }

  function play(senderId: number, data: unknown): void {
    // **`AudioData` をそのまま `AudioBufferSourceNode.buffer` へ入れてはならない。**
    // 型が違うため «Failed to convert value to 'AudioBuffer'» で失敗する（実測。
    // ブラウザの E2E で毎パケット例外が出ていた）。標本を写して `AudioBuffer` を作る。
    const buffer = toAudioBuffer(data);
    if (buffer === null) {
      return;
    }
    const source = callWithResult(context, "createBufferSource", []);
    if (source === null) {
      return;
    }
    writeProperty(source, "buffer", buffer);
    const destination = readProperty(context, "destination");
    callMethod(source, "connect", [destination]);
    const at = scheduleAt(senderId);
    callMethod(source, "start", [at]);
    const duration = readProperty(buffer, "duration");
    const seconds = typeof duration === "number" ? duration : OPUS_FRAME_MS / 1000;
    nextAt.set(senderId, at + seconds);
  }

  /**
   * `AudioData` を `AudioBuffer` へ写す。
   *
   * `AudioData.copyTo` はチャネルごとに `Float32Array` へ写す（`planar-f32`）。
   * 写せない場合は null を返す（例外を投げない）。
   */
  function toAudioBuffer(data: unknown): unknown {
    if (typeof data !== "object" || data === null) {
      return null;
    }
    const frames = readProperty(data, "numberOfFrames");
    const channels = readProperty(data, "numberOfChannels");
    const rate = readProperty(data, "sampleRate");
    if (typeof frames !== "number" || typeof channels !== "number" || typeof rate !== "number") {
      return null;
    }
    if (frames <= 0 || channels <= 0 || rate <= 0) {
      return null;
    }
    const buffer = callWithResult(context, "createBuffer", [channels, frames, rate]);
    if (buffer === null) {
      return null;
    }
    for (let channel = 0; channel < channels; channel += 1) {
      const target = callWithResult(buffer, "getChannelData", [channel]);
      if (!(target instanceof Float32Array)) {
        return null;
      }
      if (!callMethod(data, "copyTo", [target, { planeIndex: channel, format: "f32-planar" }])) {
        return null;
      }
    }
    // 写し終えたら解放する。閉じないと復号器の資源が尽きる。
    callMethod(data, "close", []);
    return buffer;
  }

  function decoderFor(senderId: number): unknown {
    const existing = decoders.get(senderId);
    if (existing !== undefined) {
      return existing;
    }
    const created = construct(decoderCtor, [
      {
        output: (frame: unknown): void => {
          play(senderId, frame);
        },
        error: (): void => {
          // 音声の復号の失敗は次のパケットで復帰する。捨てて続ける。
        },
      },
    ]);
    if (created === null) {
      return null;
    }
    callMethod(created, "configure", [
      { codec: "opus", sampleRate: 48000, numberOfChannels: A_VOICE.channels },
    ]);
    decoders.set(senderId, created);
    return created;
  }

  return {
    enqueue: (input): void => {
      const decoder = decoderFor(input.senderId);
      if (decoder === null) {
        return;
      }
      const chunk = construct(chunkCtor, [
        { type: "key", timestamp: input.captureTimestampUs, data: input.payload },
      ]);
      if (chunk === null) {
        return;
      }
      callMethod(decoder, "decode", [chunk]);
    },
  };
}

/** 未知の型のメソッドを呼び、戻り値を得る。失敗したら null。 */
function callWithResult(target: unknown, name: string, args: readonly unknown[]): unknown {
  if (typeof target !== "object" || target === null) {
    return null;
  }
  const method = Reflect.get(target, name);
  if (typeof method !== "function") {
    return null;
  }
  try {
    return Reflect.apply(method, target, args);
  } catch {
    return null;
  }
}
