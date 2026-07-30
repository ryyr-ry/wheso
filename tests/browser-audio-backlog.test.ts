/**
 * 音声の予約が未来へ積み上がらないこと（`media/browser-media.ts`）。
 *
 * **なぜ Node で試験できるか。** 音声の出口はブラウザの大域（`AudioContext`）を実行時に
 * 引くだけである。偽の大域を置けば「いつ鳴らす予約をしたか」を Node で確かめられる。
 *
 * **何を防ぐ試験か。** 束ねて届く音声を隙間なく後ろへ繋ぐだけだと、切断からの復旧などで
 * 一度に届いたぶんが未来へ積み上がり、再生が恒久的に遅れる。実測（段 E・100 秒）: 音声が
 * 映像より 4.6 秒遅れ、提示の門が「予定が遠すぎる」と判断して映像を先に出したため、判定
 * D-1 が p99 4,655 ms で不合格になった。積み上がった音声は再生期限を過ぎており、鳴らせば
 * 以後ずっと遅れる。捨てるのは輻輳による破棄ではなく、深さを守るための追い付きである。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { browserMediaDeps } from "../packages/client/src/media/browser-media.ts";
import {
  AUDIO_JITTER_MAX_PACKETS,
  OPUS_FRAME_MS,
} from "../packages/core/src/generated/constants.ts";

/** 予約された開始時刻（秒）。 */
const started: number[] = [];
/** 偽の再生時計。試験が進める。 */
const clock = { seconds: 0 };

class FakeAudioBuffer {
  public readonly duration: number;
  private readonly channels: Float32Array[];

  public constructor(init: { readonly length: number; readonly sampleRate: number }) {
    this.duration = init.length / init.sampleRate;
    this.channels = [new Float32Array(init.length)];
  }

  public getChannelData(index: number): Float32Array {
    const found = this.channels[index];
    return found === undefined ? new Float32Array(0) : found;
  }
}

class FakeSource {
  public buffer: unknown = null;

  public connect(): void {
    // 出力先は試験では見ない。
  }

  public start(at: number): void {
    started.push(at);
  }
}

class FakeAudioContext {
  public get currentTime(): number {
    return clock.seconds;
  }

  public get destination(): unknown {
    return {};
  }

  public createBufferSource(): unknown {
    return new FakeSource();
  }

  public createBuffer(channels: number, length: number, sampleRate: number): unknown {
    void channels;
    return new FakeAudioBuffer({ length, sampleRate });
  }

  public resume(): void {
    // 既に動いているものとして扱う。
  }
}

/** 1 パケット（20 ms・48 kHz）の `AudioData` 相当。 */
function audioData(): unknown {
  const frames = (48_000 * OPUS_FRAME_MS) / 1000;
  return {
    numberOfFrames: frames,
    numberOfChannels: 1,
    sampleRate: 48_000,
    format: "f32-planar",
    copyTo: (destination: unknown): void => {
      void destination;
    },
    close: (): void => undefined,
  };
}

/** 偽の Opus 復号器。投入されたらすぐ 1 パケット返す。 */
class FakeAudioDecoder {
  private readonly output: (data: unknown) => void;

  public constructor(init: { readonly output: (data: unknown) => void; readonly error: (error: unknown) => void }) {
    this.output = init.output;
  }

  public configure(): void {
    // 設定は成功したものとして扱う。
  }

  public decode(): void {
    this.output(audioData());
  }
}

class FakeEncodedAudioChunk {
  public readonly init: unknown;

  // Node の TS 剥がしはパラメータプロパティを通さないため、明示的に代入する。
  public constructor(init: unknown) {
    this.init = init;
  }
}

test("**音声の予約はジッタバッファの深さより先へ積み上がらない**（ADR-0028 の再同期）", () => {
  started.length = 0;
  clock.seconds = 0;
  Reflect.set(globalThis, "AudioContext", FakeAudioContext);
  Reflect.set(globalThis, "AudioDecoder", FakeAudioDecoder);
  Reflect.set(globalThis, "EncodedAudioChunk", FakeEncodedAudioChunk);
  try {
    const deps = browserMediaDeps({
      now: (): number => 0,
      scheduleAt: (_atMs, fire): (() => void) => {
        fire();
        return (): void => undefined;
      },
      onFrame: (): void => undefined,
      onDecodeError: (): void => undefined,

    });
    // 一度に大量の音声が届く（復旧直後に経路の分がまとめて届く状況）。
    const burst = AUDIO_JITTER_MAX_PACKETS * 10;
    for (let index = 0; index < burst; index += 1) {
      deps.enqueueAudio({
        senderId: 11,
        channel: 2,
        spatialId: 0,
        temporalId: 0,
        key: true,
        captureTimestampUs: index * OPUS_FRAME_MS * 1000,
        presentAtMs: 0,
        payload: new Uint8Array([1, 2, 3]),
      });
    }
    assert.equal(started.length, burst, "すべて鳴らす予約はする（音声は捨てない）");

    const maxAhead = (AUDIO_JITTER_MAX_PACKETS * OPUS_FRAME_MS) / 1000;
    const worst = started.reduce((left, right) => (right > left ? right : left), 0);
    assert.ok(
      worst <= maxAhead + OPUS_FRAME_MS / 1000,
      `**先へ積み上げない**（最も遠い予約 ${String(worst)} 秒 / 上限 ${String(maxAhead)} 秒）`,
    );

    // 時計が進めば、続きは現在時刻の近くへ置かれる（恒久的な遅れが残らない）。
    clock.seconds = 100;
    started.length = 0;
    deps.enqueueAudio({
      senderId: 11,
      channel: 2,
      spatialId: 0,
      temporalId: 0,
      key: true,
      captureTimestampUs: 9_999_000,
      presentAtMs: 0,
      payload: new Uint8Array([1, 2, 3]),
    });
    const after = started[0] ?? -1;
    assert.ok(
      after >= 100 && after <= 100 + maxAhead,
      `時計が進んだ後は現在の近くへ置く（${String(after)} 秒）`,
    );
  } finally {
    Reflect.deleteProperty(globalThis, "AudioContext");
    Reflect.deleteProperty(globalThis, "AudioDecoder");
    Reflect.deleteProperty(globalThis, "EncodedAudioChunk");
  }
});
