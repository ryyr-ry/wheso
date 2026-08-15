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

import { A_VOICE, AUDIO_JITTER_MAX_PACKETS, OPUS_FRAME_MS } from "@wheso/core/src/generated/constants.ts";
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
  /**
   * 音声 1 個が**実際に鳴る時刻**（局所の壁時計。ミリ秒）を伝える観測。
   *
   * **なぜ製品側に置くか。** 受入条件 4.4（判定 D-1）は「音声バーストの検出時刻」と
   * 「描画時刻」の差を測る。**鳴る時刻は `AudioContext` の時計の上にしかない**ため、
   * 外からは観測できない。予定時刻（`audioPresentAtMs`）で代用すると、実際の音の位置
   * ではなく写像の値を測ることになる（実測: 器がそれで p99 1,976 ms の偽のずれを
   * 報じた。SDK 自身の観測は 129 ms であった）。振る舞いは変えない。
   */
  readonly onAudioScheduled: (senderId: number, captureUs: number, atMs: number) => void;
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
  /**
   * 復号器ごとに、**最後に渡した枠の取得時刻**（マイクロ秒）。
   *
   * 復号器を作り直したとき、古い実体の枠が新しい実体の出力より後に出てくる。後戻りを
   * 渡さないための印である（受入条件 A-3）。購読を捨てるときに忘れる。
   */
  const presentedUs = new Map<string, number>();
  /**
   * `captureUs → presentAtMs`。復号器の非同期出力へ提示予定時刻を届ける。
   *
   * 復号は即座に開始し、復号器の出力時に門で待つ（ADR-0042）。門を復号の前に置くと
   * 復号遅延が提示時刻に加算され、音声との skew が生む。
   */
  const videoPresentByCapture = new Map<number, number>();
  const audio = createAudioSink(options.onAudioScheduled);

  const videoDecoderCtor = Reflect.get(globalThis, "VideoDecoder");
  const chunkCtor = Reflect.get(globalThis, "EncodedVideoChunk");

  function keyOf(senderId: number, channel: number): string {
    return `${String(senderId)}:${String(channel)}`;
  }

  return {
    configureDecoder: (senderId, channel, spatialId): void => {
      createDecoder(senderId, channel);
      void spatialId;
    },

    resetDecoder: (senderId, channel, spatialId): void => {
      const key = keyOf(senderId, channel);
      const entry = videos.get(key);
      if (entry === undefined) {
        createDecoder(senderId, channel);
        void spatialId;
        return;
      }
      // **閉じた復号器は作り直す。** WebCodecs では復号の失敗が復号器を `closed` にし、
      // 以後の `reset` / `configure` / `decode` はすべて失敗する（例外になる）。同じ実体を
      // 使い回すと、**1 度の失敗で以後 1 枚も出なくなる**。実測（実環境・劣化なし）: 復号器へ
      // 546 件渡して出力は 69 枚、`Decoding error` が 1 件。生成された復号器は最初の 1 個
      // だけであり、キーフレームが 9 枚届いても回復しなかった。
      if (stateOf(entry.decoder) === "closed") {
        createDecoder(senderId, channel);
        void spatialId;
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
      // **作り直し（ADR-0047）では消さない。** 消すと古い実体の枠を再び通してしまう。
      // ここは購読を捨てる経路であり、相手が入り直したときに取得時刻が戻り得る。
      presentedUs.delete(keyOf(senderId, channel));
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
      // **復号は即座に開始し、出力を門で待たせる**（ADR-0042）。
      //
      // 門を復号の前に置くと、復号遅延が提示時刻に加算される。音声は復号後に
      // AudioContext の時計で再生時刻へ合わせるため復号遅延が skew に混入しないが、
      // 映像は門の後に復号するため復号遅延ぶん遅れ、音声が先行する。
      videoPresentByCapture.set(input.captureTimestampUs, input.presentAtMs);
      // 待っている間に復号器が閉じることがある（失敗は非同期に届く）。閉じていたら
      // 作り直す。**閉じた実体へ渡し続けてはならない**（例外になり、以後何も出ない）。
      if (stateOf(entry.decoder) === "closed") {
        // **差分では作り直さない。** 作り直した復号器はキーフレームからしか始められない
        // ため、差分ごとに作ると実体を捨てて作るだけを繰り返す。失敗を伝えて要求させ、
        // キーフレームが来たときに作り直す。
        if (!input.key) {
          options.onDecodeError(input.senderId, input.channel);
          return;
        }
        const rebuilt = createDecoder(input.senderId, input.channel);
        if (rebuilt === null) {
          return;
        }
        callMethod(rebuilt.decoder, "decode", [chunk]);
        return;
      }
      callMethod(entry.decoder, "decode", [chunk]);
    },

    enqueueAudio: (input): void => {
      // **音声は決して捨てない。** 復号器が無い環境でも呼び出しは失敗させない。
      audio.enqueue(input);
    },
  };

  /** 復号器の状態を読む（`unconfigured` / `configured` / `closed`）。読めなければ空文字。 */
  function stateOf(decoder: unknown): string {
    const value = typeof decoder === "object" && decoder !== null ? Reflect.get(decoder, "state") : undefined;
    return typeof value === "string" ? value : "";
  }

  /** 復号器を作り直す。古い実体は閉じる。 */
  function createDecoder(senderId: number, channel: number): VideoEntry | null {
    if (typeof videoDecoderCtor !== "function") {
      return null;
    }
    const key = keyOf(senderId, channel);
    closeVideo(videos, key);
    const decoder = construct(videoDecoderCtor, [
      {
        output: (frame: DecodedFrame): void => {
          // **描画は後戻りしない**（受入条件 A-3）。
          //
          // 復号器を作り直すとき（復号の失敗の後。ADR-0047）、古い実体が抱えていた枠が
          // 新しい実体の出力より後に出てくることがある。そのまま渡すと画が巻き戻る
          // （実測: 段 E で「260 の次に 259」「899 の次に 891」）。取得時刻が前へ
          // 進んでいないものは捨てる。**枠は必ず閉じる**（閉じないと資源が尽きる）。
          const stamp = frameTimestampUs(frame);
          const seen = presentedUs.get(key);
          if (stamp !== undefined && seen !== undefined && stamp <= seen) {
            closeFrame(frame);
            return;
          }
          if (stamp !== undefined) {
            presentedUs.set(key, stamp);
          }
          // **提示予定時刻まで待ってから描画へ渡す**（ADR-0042）。
          //
          // 復号は即座に開始したため、復号遅延は既に経過している。門は出力を
          // presentAtMs まで待たせ、復号遅延を skew に混入させない。
          const presentAt = stamp !== undefined ? videoPresentByCapture.get(stamp) : undefined;
          if (stamp !== undefined) {
            videoPresentByCapture.delete(stamp);
          }
          const scheduledPresent = presentAt ?? 0;
          gate.submit(senderId, scheduledPresent, () => {
            options.onFrame(senderId, frame);
            // **`VideoFrame` は明示的に閉じる。** 閉じないと復号器の資源が尽き、
            // 数百枚で復号が止まる（WebCodecs の要件）。利用側は同期に使い終える。
            closeFrame(frame);
          });
        },
        error: (): void => {
          options.onDecodeError(senderId, channel);
        },
      },
    ]);
    if (decoder === null) {
      return null;
    }
    // コーデックは AV1 を既定とする。H.264 の場合は申告から決めるべきであり、
    // その配線は送信側のはしごの申告（ADR-0026 の 7）を受け取ってから行う。
    const configured = callMethod(decoder, "configure", [
      { codec: "av01.0.08M.08", optimizeForLatency: true },
    ]);
    if (!configured) {
      return null;
    }
    const entry: VideoEntry = { key, senderId, decoder };
    videos.set(key, entry);
    return entry;
  }
}

/** `VideoFrame` / `AudioData` を明示的に閉じる。閉じないと資源が漏れる。 */
/**
 * 復号できた枠の取得時刻（マイクロ秒）を読む。読めなければ `undefined`。
 *
 * **型定義を信用しない**（AGENTS 5.4 の 3）。実行環境によっては `timestamp` を持たない
 * 実装があり得るため、数であることを実行時に確かめる。
 */
function frameTimestampUs(frame: unknown): number | undefined {
  if (typeof frame !== "object" || frame === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(frame, "timestamp");
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

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
function createAudioSink(onScheduled: (senderId: number, captureUs: number, atMs: number) => void): AudioSink {
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
  // ADR-0042: 音声も同じ再生クロックに載せる。
  // 最初の `enqueue` で `Date.now()` と `AudioContext.currentTime` の対応付けを固定する。
  // それ以降は更新しない（更新すると過去の `presentAtMs` の写像がずれる）。
  // 2 つの時計のドリフトは実環境では無視できる（ADR-0042 の実測: p99 1〜2 ms）。
  let dateBaseMs = 0;
  let contextBaseSeconds = 0;
  /** `captureUs → presentAtMs`。復号器の非同期出力へ presentAtMs を届ける。 */
  const presentByCapture = new Map<number, number>();

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

  /**
   * 先へ予約してよい上限（秒）。音声のジッタバッファの深さと同じにする
   * （`AUDIO_JITTER_MAX_PACKETS` × `OPUS_FRAME_MS`）。
   */
  const maxAheadSeconds = (AUDIO_JITTER_MAX_PACKETS * OPUS_FRAME_MS) / 1000;

  function scheduleAt(senderId: number, presentAtMs: number): number {
    const now = readProperty(context, "currentTime");
    const current = typeof now === "number" ? now : 0;
    // ADR-0042: `presentAtMs`（壁時計・ミリ秒）を AudioContext 時刻（秒）へ写す。
    // `Date.now()` は呼ばない（JS イベントループの遅延が skew に混入するのを防ぐ）。
    // 対応付けは `enqueue` 時に毎回更新されるため、ドリフトは 1 フレーム分以下。
    let target = current;
    if (presentAtMs > 0 && dateBaseMs > 0) {
      const mapped = contextBaseSeconds + (presentAtMs - dateBaseMs) / 1000;
      if (mapped >= current && mapped - current <= maxAheadSeconds) {
        target = mapped;
      } else if (mapped - current > maxAheadSeconds) {
        // **写像は作り直さない。** 作り直すと、以後の映像の予定が毎回無効になり、
        // 「予定が遠すぎる」判断と噛み合って連鎖切れを量産する（実測: 段 E で連鎖切れが
        // 18 件 → 87 件、提示が 2,084 枚 → 1,496 枚に悪化した）。捨てるのは高々
        // ジッタバッファの深さ 1 個ぶんであり、写像の誤差はその範囲に収まる。
        // **溜まった分を捨てて現在へ戻す**（ADR-0028 の再同期）。
        //
        // 束ねて届く音声を隙間なく後ろへ繋ぐだけだと、切断からの復旧などで一度に届いた
        // ぶんが未来へ積み上がり、再生が**恒久的に**遅れる。実測（段 E）: 音声が映像より
        // 4.6 秒遅れ、提示の門が「予定が遠すぎる」と判断して映像を先に出したため、
        // 判定 D-1 が p99 4,655 ms で不合格になった。
        //
        // 積み上がった音声は再生期限を過ぎており、鳴らせば以後ずっと遅れる。捨てるのは
        // 輻輳による破棄ではなく、ジッタバッファの深さを守るための追い付きである。
        target = current;
      }
    }
    // `nextAt` は連続再生の順序保証。`presentAtMs` が遅れている場合は `nextAt` へ従う。
    // ただし `nextAt` が `maxAheadSeconds` より遠い場合は `current` へ戻す（ADR-0028 の再同期）。
    const planned = nextAt.get(senderId);
    if (planned !== undefined && planned >= current && planned - current <= maxAheadSeconds && planned > target) {
      target = planned;
    }
    return target;
  }

  function play(senderId: number, data: unknown, captureUs: number): void {
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
    // ADR-0042: 復号器の非同期出力へ `presentAtMs` を届ける。`captureUs` で引く。
    const presentAtMs = presentByCapture.get(captureUs) ?? 0;
    presentByCapture.delete(captureUs);
    const at = scheduleAt(senderId, presentAtMs);
    callMethod(source, "start", [at]);
    // 予約は `AudioContext` の時計の上にある。壁時計へ写して観測へ出す。
    const nowSeconds = readProperty(context, "currentTime");
    const offsetMs = typeof nowSeconds === "number" ? (at - nowSeconds) * 1000 : 0;
    onScheduled(senderId, captureUs, Date.now() + offsetMs);
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
          // 取得時刻は復号できた音声そのものが持つ（`AudioData.timestamp`）。
          const stamp = readProperty(frame, "timestamp");
          play(senderId, frame, typeof stamp === "number" ? stamp : 0);
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
      // ADR-0042: 最初の `enqueue` でのみ対応付けを固定する。以降は更新しない。
      if (dateBaseMs === 0) {
        const now = readProperty(context, "currentTime");
        if (typeof now === "number") {
          dateBaseMs = Date.now();
          contextBaseSeconds = now;
        }
      }
      presentByCapture.set(input.captureTimestampUs, input.presentAtMs);
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
