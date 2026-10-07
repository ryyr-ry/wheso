/**
 * 復号の失敗からの回復（`media/browser-media.ts`）。
 *
 * **なぜ Node で試験できるか。** この層はブラウザの大域（`VideoDecoder` /
 * `EncodedVideoChunk`）を実行時に引くだけである。偽の大域を置けば、**閉じた復号器へ
 * 渡し続けていないか**という肝心の判断を Node で確かめられる。実物の符号化は E2E が見る。
 *
 * **何を防ぐ試験か。** WebCodecs では復号の失敗が復号器を `closed` にし、以後の
 * `reset` / `configure` / `decode` はすべて失敗する。同じ実体を使い回すと **1 度の失敗で
 * 以後 1 枚も出ない**。実測（実環境・劣化なし）: 復号器へ 546 件渡して出力は 69 枚、
 * 生成された復号器は 1 個だけで、キーフレームが 9 枚届いても回復しなかった。
 * 直した後は 612 件渡して 611 枚出た（復号器は 2 個作られた）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { browserMediaDeps } from "../packages/client/src/media/browser-media.ts";
import { CHANNEL_VIDEO } from "../packages/core/src/generated/wire-layout.ts";
import { VIDEO_JITTER_MAX_FRAMES } from "../packages/core/src/generated/constants.ts";

/** 偽の塊から取得時刻を読む（`EncodedVideoChunk` の `timestamp` に相当）。 */
function chunkTimestampOf(chunk: unknown): number {
  if (typeof chunk !== "object" || chunk === null) {
    return 0;
  }
  const init: unknown = Reflect.get(chunk, "init");
  if (typeof init !== "object" || init === null) {
    return 0;
  }
  const value: unknown = Reflect.get(init, "timestamp");
  return typeof value === "number" ? value : 0;
}

/** 偽の復号器。`fail()` を呼ぶと WebCodecs と同じく `closed` になる。 */
interface FakeState {
  readonly instances: FakeDecoder[];
}

class FakeDecoder {
  public state = "unconfigured";
  public readonly submitted: unknown[] = [];
  private readonly output: (frame: unknown) => void;
  private readonly onError: (error: unknown) => void;

  public constructor(init: { readonly output: (frame: unknown) => void; readonly error: (error: unknown) => void }) {
    this.output = init.output;
    this.onError = init.error;
  }

  public configure(): void {
    if (this.state === "closed") {
      throw new Error("closed");
    }
    this.state = "configured";
  }

  public decode(chunk: unknown): void {
    if (this.state !== "configured") {
      // WebCodecs は閉じた復号器への投入を例外にする。
      throw new Error("closed");
    }
    this.submitted.push(chunk);
    // 復号できたことにして 1 枚返す（`close` を持たせる。利用側が呼ぶ）。
    //
    // **取得時刻は投入された塊のものを返す**（WebCodecs と同じ）。固定値を返すと、
    // 「後戻りを渡さない」判断（受入条件 A-3）を試験が誤って壊す。
    this.output({
      displayWidth: 64,
      displayHeight: 64,
      timestamp: chunkTimestampOf(chunk),
      close: (): void => undefined,
    });
  }

  public reset(): void {
    if (this.state === "closed") {
      throw new Error("closed");
    }
    this.state = "unconfigured";
  }

  public close(): void {
    this.state = "closed";
  }

  /** 復号の失敗を起こす。WebCodecs と同じく、実体は閉じる。 */
  public fail(): void {
    this.state = "closed";
    this.onError(new Error("Decoding error."));
  }
}

function installFakes(): FakeState {
  const instances: FakeDecoder[] = [];
  class Spy extends FakeDecoder {
    public constructor(init: {
      readonly output: (frame: unknown) => void;
      readonly error: (error: unknown) => void;
    }) {
      super(init);
      instances.push(this);
    }
  }
  Reflect.set(globalThis, "VideoDecoder", Spy);
  class FakeChunk {
    public readonly init: unknown;

    public constructor(init: unknown) {
      this.init = init;
    }
  }
  Reflect.set(globalThis, "EncodedVideoChunk", FakeChunk);
  return { instances };
}

function removeFakes(): void {
  Reflect.deleteProperty(globalThis, "VideoDecoder");
  Reflect.deleteProperty(globalThis, "EncodedVideoChunk");
}

interface Harness {
  readonly deps: ReturnType<typeof browserMediaDeps>;
  readonly fakes: FakeState;
  readonly frames: number[];
  readonly errors: number[];
}

/** 予定時刻を待たずに直ちに走らせる（門の待ちは別の試験が見る）。 */
function harness(): Harness {
  const fakes = installFakes();
  const frames: number[] = [];
  const errors: number[] = [];
  const deps = browserMediaDeps({
    now: (): number => 0,
    scheduleAt: (_atMs, fire): (() => void) => {
      fire();
      return (): void => undefined;
    },
    onFrame: (senderId): void => {
      frames.push(senderId);
    },
    onDecodeError: (senderId): void => {
      errors.push(senderId);
    },
    onAudioScheduled: (): void => undefined,
  });
  return { deps, fakes, frames, errors };
}

function input(key: boolean, captureUs: number): {
  readonly presentAtMs: number;
  readonly senderId: number;
  readonly channel: number;
  readonly spatialId: number;
  readonly temporalId: number;
  readonly key: boolean;
  readonly captureTimestampUs: number;
  readonly payload: Uint8Array;
} {
  return {
    presentAtMs: 0,
    senderId: 7,
    channel: CHANNEL_VIDEO,
    spatialId: 0,
    temporalId: 0,
    key,
    captureTimestampUs: captureUs,
    payload: new Uint8Array([1, 2, 3]),
  };
}

test("**復号の失敗の後は復号器を作り直す**（同じ実体へ渡し続けない）", () => {
  const h = harness();
  try {
    h.deps.configureDecoder(7, CHANNEL_VIDEO, 0);
    h.deps.decodeVideo(input(true, 1000));
    assert.equal(h.fakes.instances.length, 1, "最初の復号器が作られる");
    assert.equal(h.frames.length, 1, "1 枚出る");

    // 復号の失敗を起こす（実体は閉じる）。
    const first = h.fakes.instances[0];
    assert.ok(first !== undefined);
    first.fail();
    assert.equal(h.errors.length, 1, "失敗が伝わる");

    // 閉じた実体へ差分を渡してはならない。要求のために失敗を伝える。
    const errorsBefore = h.errors.length;
    h.deps.decodeVideo(input(false, 2000));
    assert.equal(h.fakes.instances.length, 1, "差分では作り直さない（キーフレームを待つ）");
    assert.equal(h.errors.length, errorsBefore + 1, "キーフレームを要求させる");

    // キーフレームが来たら作り直して渡す。
    h.deps.decodeVideo(input(true, 3000));
    assert.equal(h.fakes.instances.length, 2, "**復号器を作り直す**");
    const second = h.fakes.instances[1];
    assert.ok(second !== undefined);
    assert.equal(second.submitted.length, 1, "新しい実体へ渡す");
    assert.equal(h.frames.length, 2, "映像が戻る");

    // 以後の差分も新しい実体へ渡る。
    h.deps.decodeVideo(input(false, 4000));
    assert.equal(second.submitted.length, 2, "回復後は続けて渡す");
    assert.equal(h.frames.length, 3);
  } finally {
    removeFakes();
  }
});

test("**取得時刻が後戻りした枠は渡さない**（受入条件 A-3）", () => {
  // 復号器を作り直すとき、古い実体が抱えていた枠が新しい実体の出力より後に出てくる。
  // そのまま渡すと画が巻き戻る（実測: 段 E で「260 の次に 259」「899 の次に 891」）。
  const { deps, fakes, frames } = harness();
  try {
    deps.configureDecoder(7, CHANNEL_VIDEO, 0);
    deps.decodeVideo(input(true, 1000));
    deps.decodeVideo(input(false, 66_000));
    assert.equal(
      frames.length,
      2,
      `前へ進む枠は渡す（復号器 ${String(fakes.instances.length)} 個 / 投入 ${String(
        fakes.instances[0]?.submitted.length ?? -1,
      )} 件 / 状態 ${String(fakes.instances[0]?.state)}）`,
    );

    // 古い枠が後から出てくる（作り直しの取り零し）。
    deps.decodeVideo(input(false, 33_000));
    assert.equal(frames.length, 2, "**後戻りは渡さない**");

    // 同じ時刻の重複も渡さない。
    deps.decodeVideo(input(false, 66_000));
    assert.equal(frames.length, 2, "重複も渡さない");

    // 続きは通る（後戻りを覚え直していない）。
    deps.decodeVideo(input(false, 99_000));
    assert.equal(frames.length, 3, "前へ進む枠は通る");

    // **購読を捨てたら忘れる**（相手が入り直すと取得時刻は戻り得る）。
    deps.closeDecoder(7, CHANNEL_VIDEO);
    deps.configureDecoder(7, CHANNEL_VIDEO, 0);
    deps.decodeVideo(input(true, 500));
    assert.equal(frames.length, 4, "入り直した相手の枠は通す");
  } finally {
    removeFakes();
  }
});

test("段の切替で復号器を初期化する（閉じていなければ作り直さない）", () => {
  const h = harness();
  try {
    h.deps.configureDecoder(7, CHANNEL_VIDEO, 0);
    h.deps.resetDecoder(7, CHANNEL_VIDEO, 1);
    assert.equal(h.fakes.instances.length, 1, "作り直さない（初期化で足りる）");
    const only = h.fakes.instances[0];
    assert.ok(only !== undefined);
    assert.equal(only.state, "configured", "初期化のあと設定し直す");
  } finally {
    removeFakes();
  }
});

test("閉じた復号器の初期化は作り直しになる", () => {
  const h = harness();
  try {
    h.deps.configureDecoder(7, CHANNEL_VIDEO, 0);
    const first = h.fakes.instances[0];
    assert.ok(first !== undefined);
    first.fail();
    h.deps.resetDecoder(7, CHANNEL_VIDEO, 0);
    assert.equal(h.fakes.instances.length, 2, "閉じていたら作り直す");
  } finally {
    removeFakes();
  }
});

test("**出力は提示予定時刻まで保持し、開放は順序に沿って行う**（ADR-0058）", () => {
  installFakes();
  const frames: number[] = [];
  let nowMs = 1000;
  const pending: (() => void)[] = [];
  try {
    const deps = browserMediaDeps({
      now: (): number => nowMs,
      scheduleAt: (_atMs, fire): (() => void) => {
        pending.push(fire);
        return (): void => undefined;
      },
      onFrame: (senderId): void => {
        frames.push(senderId);
      },
      onDecodeError: (): void => undefined,
      onAudioScheduled: (): void => undefined,
    });
    deps.configureDecoder(7, CHANNEL_VIDEO, 0);

    // 予定が未来（presentAtMs 2000 > now 1000）の枠: 保持し、まだ出さない。
    deps.decodeVideo({ ...input(true, 1000), presentAtMs: 2000 });
    assert.equal(frames.length, 0, "予定が未来の間は保持する");

    // 予定が過去（presentAtMs 500）の枠: 順序に加えられ、先頭の予約に続く。
    // 直ちに出すと未来の予約（2000）より先になり、受け取りの列が逆行する
    // （受入条件 A-3。実測: 「157 の次に 152」）。
    deps.decodeVideo({ ...input(false, 2000), presentAtMs: 500 });
    assert.equal(frames.length, 0, "過去の予定も順序に沿って待つ");

    // 時刻が先頭の予定（2000）へ進み、予約の発火で順に開放される。
    assert.ok(pending.length >= 1, "先頭の予約がある");
    nowMs = 2000;
    for (const fire of [...pending]) {
      fire();
    }
    assert.equal(frames.length, 2, "予定時刻に開放する");
  } finally {
    removeFakes();
  }
});

test("**保持の上限を超えたら古い側から開放する**（VideoFrame の資源を守る）", () => {
  installFakes();
  const frames: number[] = [];
  try {
    const deps = browserMediaDeps({
      now: (): number => 1000,
      scheduleAt: (_atMs, fire): (() => void) => {
        // 予約は作るが発火しない（時刻が進まないため）。保持だけを観察する。
        void fire;
        return (): void => undefined;
      },
      onFrame: (senderId): void => {
        frames.push(senderId);
      },
      onDecodeError: (): void => undefined,
      onAudioScheduled: (): void => undefined,
    });
    deps.configureDecoder(7, CHANNEL_VIDEO, 0);
    // 上限 + 2 枚の未来の予定を投入する。上限を超えた分は先頭（古い側）から出る。
    // 順序を守るため先頭から出すので、逆行は起きない。
    for (let index = 0; index <= VIDEO_JITTER_MAX_FRAMES + 1; index += 1) {
      deps.decodeVideo({ ...input(false, (index + 1) * 66_000), presentAtMs: 1200 + index });
    }
    assert.equal(
      frames.length,
      2,
      `上限を超えたぶんだけ古い側から開放する（実際 ${String(frames.length)} 枚）`,
    );
  } finally {
    removeFakes();
  }
});

test("**closeDecoder は保持している出力をすべて開放する**（退出で資源を漏らさない）", () => {
  installFakes();
  const frames: number[] = [];
  try {
    const deps = browserMediaDeps({
      now: (): number => 1000,
      scheduleAt: (_atMs, fire): (() => void) => {
        void fire;
        return (): void => undefined;
      },
      onFrame: (senderId): void => {
        frames.push(senderId);
      },
      onDecodeError: (): void => undefined,
      onAudioScheduled: (): void => undefined,
    });
    deps.configureDecoder(7, CHANNEL_VIDEO, 0);
    // 2 枚を保持させる（予定は未来）。
    deps.decodeVideo({ ...input(true, 1000), presentAtMs: 2000 });
    deps.decodeVideo({ ...input(false, 66_000), presentAtMs: 2100 });
    assert.equal(frames.length, 0, "保持している");
    // 購読を捨てる。保持していた枠はすべて出て資源が閉じる。
    deps.closeDecoder(7, CHANNEL_VIDEO);
    assert.equal(frames.length, 2, "保持していた枠をすべて開放する");
  } finally {
    removeFakes();
  }
});
