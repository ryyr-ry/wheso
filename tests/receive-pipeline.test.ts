/**
 * 受信経路の配線を検証する（段 F の F-6）。
 *
 * **これが無いと SDK はメディアを受け取れない。** 本ファイルまでは、E2E と段 D の試験が
 * すべて生の WebSocket を張って自前で復号していた。
 *
 * 検証する性質:
 *   1. バイナリを受けると復号器へ渡る（復号器の生成・段の切替・破棄が起きる）
 *   2. **音声は決して捨てない**
 *   3. 期限を過ぎた映像は捨てる（提示しない）
 *   4. goodput を数え、`report` に載せて上流へ送る
 *   5. 形式違反の上流メッセージでクライアントを落とさない
 *   6. 経路の不連続で対応付けを作り直す
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createPipeline,
  handleMedia,
  handleReportTimer,
  noteFramerate,
  noteRouteChange,
  releaseSenderState,
  type DecodeInput,
  type PipelineDeps,
} from "../packages/client/src/api/receive-pipeline.ts";
import { encodeMediaMessage } from "../packages/core/src/wire.ts";
import {
  CHANNEL_AUDIO,
  CHANNEL_VIDEO,
  FLAG_END_OF_FRAME,
  FLAG_KEY,
  WIRE_MAGIC,
} from "../packages/core/src/generated/wire-layout.ts";
import { REPORT_INTERVAL_MS } from "../packages/core/src/generated/constants.ts";

const SENDER = 4242;

interface Log {
  readonly configured: { senderId: number; channel: number; spatialId: number }[];
  readonly reset: { senderId: number; channel: number; spatialId: number }[];
  readonly closed: { senderId: number; channel: number }[];
  readonly decoded: DecodeInput[];
  readonly audio: DecodeInput[];
  readonly control: string[];
}

function recorder(clock: { ms: number }): { deps: PipelineDeps; log: Log } {
  const log: Log = { configured: [], reset: [], closed: [], decoded: [], audio: [], control: [] };
  const deps: PipelineDeps = {
    now: (): number => clock.ms,
    configureDecoder: (senderId, channel, spatialId): void => {
      log.configured.push({ senderId, channel, spatialId });
    },
    resetDecoder: (senderId, channel, spatialId): void => {
      log.reset.push({ senderId, channel, spatialId });
    },
    closeDecoder: (senderId, channel): void => {
      log.closed.push({ senderId, channel });
    },
    decodeVideo: (input): void => {
      log.decoded.push(input);
    },
    enqueueAudio: (input): void => {
      log.audio.push(input);
    },
    sendReceiveControl: (text): void => {
      log.control.push(text);
    },
  };
  return { deps, log };
}

function mediaBytes(options: {
  readonly channel?: number;
  readonly spatialId?: number;
  readonly temporalId?: number;
  readonly key?: boolean;
  readonly captureUs?: number;
  readonly seq?: number;
  readonly payloadBytes?: number;
}): Uint8Array {
  const key = options.key ?? true;
  const encoded = encodeMediaMessage({
    channel: options.channel ?? CHANNEL_VIDEO,
    senderId: SENDER,
    units: [
      {
        sequenceNumber: options.seq ?? 1,
        captureTimestampUs: BigInt(options.captureUs ?? 0),
        flags: FLAG_END_OF_FRAME | (key ? FLAG_KEY : 0),
        spatialId: options.spatialId ?? 0,
        temporalId: options.temporalId ?? 0,
        payload: new Uint8Array(options.payloadBytes ?? 64),
      },
    ],
  });
  assert.equal(encoded.ok, true, "符号化できる");
  return encoded.ok ? encoded.value : new Uint8Array(0);
}

/* ------------------------------------------------------------------------- */

test("バイナリを受けると復号器が用意され映像が復号される", () => {
  const clock = { ms: 1000 };
  const { deps, log } = recorder(clock);
  let state = createPipeline(4, clock.ms);
  state = handleMedia(state, mediaBytes({ key: true }), deps);
  assert.deepEqual(log.configured, [{ senderId: SENDER, channel: CHANNEL_VIDEO, spatialId: 0 }]);
  assert.equal(log.decoded.length, 1, "キーフレームは復号される");
  assert.equal(log.decoded[0]?.senderId, SENDER);
  assert.equal(log.decoded[0]?.payload.length, 64);
});

test("キーフレームより先に差分が来たら復号しない（参照が欠ける）", () => {
  const clock = { ms: 1000 };
  const { deps, log } = recorder(clock);
  let state = createPipeline(4, clock.ms);
  state = handleMedia(state, mediaBytes({ key: false }), deps);
  assert.equal(log.configured.length, 1, "復号器は用意する");
  assert.equal(log.decoded.length, 0, "復号はしない");
});

test("段が変わると復号器を初期化してキーフレームを待つ", () => {
  const clock = { ms: 1000 };
  const { deps, log } = recorder(clock);
  let state = createPipeline(4, clock.ms);
  state = handleMedia(state, mediaBytes({ spatialId: 0, key: true }), deps);
  clock.ms += 20;
  state = handleMedia(state, mediaBytes({ spatialId: 1, key: false, seq: 2 }), deps);
  assert.deepEqual(log.reset, [{ senderId: SENDER, channel: CHANNEL_VIDEO, spatialId: 1 }]);
  assert.equal(log.decoded.length, 1, "段の切替直後の差分は復号しない");
});

test("**連番の飛びを見たら復号へ渡さず、キーフレームを要求する**（ADR-0049）", () => {
  // TCP 上では経路で欠落しない（F-024）。飛びは上流が意図的に捨てたことを意味し、
  // その後の差分は参照が欠けている。渡すと復号器が閉じる（ADR-0047）。
  const clock = { ms: 1000 };
  const { deps, log } = recorder(clock);
  let state = createPipeline(4, clock.ms);
  state = handleMedia(state, mediaBytes({ key: true, seq: 1, captureUs: 0 }), deps);
  assert.equal(log.decoded.length, 1, "キーフレームは復号される");

  clock.ms += 66;
  state = handleMedia(state, mediaBytes({ key: false, seq: 2, captureUs: 66_000 }), deps);
  assert.equal(log.decoded.length, 2, "続きは復号される");

  // 連番が 3 を飛ばして 4 になる（上流が 3 を捨てた）。
  clock.ms += 66;
  const before = log.control.length;
  state = handleMedia(state, mediaBytes({ key: false, seq: 4, captureUs: 132_000 }), deps);
  assert.equal(log.decoded.length, 2, "**渡さない**");
  assert.ok(
    log.control.slice(before).some((text: string) => text.includes("keyframeRequest")),
    "キーフレームを要求する",
  );

  // 以後の差分も渡さない（キーフレーム待ち）。
  clock.ms += 66;
  state = handleMedia(state, mediaBytes({ key: false, seq: 5, captureUs: 198_000 }), deps);
  assert.equal(log.decoded.length, 2, "KEY まで渡さない");

  // キーフレームが来たら再開する。
  clock.ms += 66;
  state = handleMedia(state, mediaBytes({ key: true, seq: 6, captureUs: 264_000 }), deps);
  assert.equal(log.decoded.length, 3, "KEY で再開する");
  assert.ok(state.decoders.entries.length > 0);
});

test("**予定が遠すぎるときは写像を作り直し、その枠は直ちに出す**（ADR-0053）", () => {
  // 予定は音声の再生位置からの写像で作る（ADR-0028）。頁が一瞬止まった時点で対応を取ると、
  // その分だけ写像が狂ったまま残る（補正は 1 パケット 20 µs であり数秒の狂いは埋まらない）。
  //
  // **捨ててはならない**（狂いが続く間ずっと捨てる。実測: 届いた 318 枚のうち復号器へ渡った
  // のは 63 枚）。**待たせてもならない**（音声より数秒早い映像を出す。実測 8.2 秒）。
  // 作り直して 1 枚だけ直ちに出すのが、映像を止めずずれを 1 枚に留める。
  const clock = { ms: 1000 };
  const { deps, log } = recorder(clock);
  let state = createPipeline(4, clock.ms);
  state = handleMedia(state, mediaBytes({ channel: CHANNEL_AUDIO, seq: 1, captureUs: 0 }), deps);
  clock.ms += 20;
  state = handleMedia(state, mediaBytes({ key: true, seq: 1, captureUs: 0 }), deps);
  const decodedBefore = log.decoded.length;
  assert.ok(decodedBefore > 0, "対応が取れている枠は渡る");

  // **映像だけが 10 秒先を走っている**（予定が 10 秒先になる）。
  //
  // 1 枚では作り直さない（本当に外れた 1 枚は規範どおり扱う）。ジッタバッファの深さを
  // 超えて続いたときに作り直す。
  const controlBefore = log.control.length;
  for (let index = 0; index < 12; index += 1) {
    clock.ms += 20;
    state = handleMedia(
      state,
      mediaBytes({ key: false, seq: 2 + index, captureUs: 10_000_000 + index * 50_000 }),
      deps,
    );
  }
  assert.ok(log.decoded.length > decodedBefore, "**続けて外れたら捨てずに渡す**（映像を止めない）");
  const scheduled = log.decoded[log.decoded.length - 1];
  assert.equal(scheduled?.presentAtMs, clock.ms, "**直ちに出す**（10 秒後ではない）");
  assert.deepEqual(
    log.control.slice(controlBefore).filter((text: string) => text.includes("keyframeRequest")),
    [],
    "キーフレームは要求しない（待ち続けになる）",
  );

  // 続きも渡る（写像は作り直されている）。
  clock.ms += 20;
  state = handleMedia(state, mediaBytes({ channel: CHANNEL_AUDIO, seq: 2, captureUs: 20_000 }), deps);
  clock.ms += 20;
  state = handleMedia(state, mediaBytes({ key: false, seq: 3, captureUs: 40_000 }), deps);
  // 対応が取れた後は規範の `decidePresent` が可否を決める（持つ・出す・捨てる）。
  // ここで確かめるのは「止まっていない」ことである。
  assert.ok(log.decoded.length >= decodedBefore + 1, `止まっていない（${String(log.decoded.length)}）`);
});

test("**遅れの側に狂った写像も作り直し、キーフレームで復帰する**", () => {
  // 走行の頭で頁が止まると、対応を取った時点の分だけ写像が遅れの側へ狂う。規範の
  // `decidePresent` は期限切れを捨てるため、**届いた枠のほとんどが捨てられ続ける**
  // （実測: 届いた 347 枚のうち提示は 56 枚、SDK が思うずれは 2,406 ms）。
  //
  // 続けて外れたら写像を作り直す。捨てた分だけ連番が飛ぶため、**そこからは規範 1.4 の
  // 経路（キーフレーム待ちと要求）で復帰する**（ADR-0049）。作り直さなければ復帰の
  // きっかけが永久に来ない。
  const clock = { ms: 1000 };
  const { deps, log } = recorder(clock);
  let state = createPipeline(4, clock.ms);
  state = handleMedia(state, mediaBytes({ channel: CHANNEL_AUDIO, seq: 1, captureUs: 10_000_000 }), deps);
  clock.ms += 20;
  state = handleMedia(state, mediaBytes({ key: true, seq: 1, captureUs: 10_000_000 }), deps);
  const decodedBefore = log.decoded.length;
  const controlBefore = log.control.length;

  // **10 秒古い映像**が続けて届く（写像の上では期限切れである）。
  for (let index = 0; index < 12; index += 1) {
    clock.ms += 20;
    state = handleMedia(state, mediaBytes({ key: false, seq: 2 + index, captureUs: index * 50_000 }), deps);
  }
  assert.ok(state.discardedVideo > 0, "外れている間は捨てる（規範どおり）");
  assert.ok(
    log.control.slice(controlBefore).some((text: string) => text.includes("keyframeRequest")),
    "**復帰のきっかけを出す**（キーフレームを要求する）",
  );

  // キーフレームが来たら復帰する（写像は作り直されている）。
  clock.ms += 20;
  state = handleMedia(state, mediaBytes({ channel: CHANNEL_AUDIO, seq: 2, captureUs: 600_000 }), deps);
  clock.ms += 20;
  state = handleMedia(state, mediaBytes({ key: true, seq: 14, captureUs: 600_000 }), deps);
  assert.ok(
    log.decoded.length > decodedBefore,
    `キーフレームで復帰する（復号 ${String(log.decoded.length)}）`,
  );
});

test("**遅れて届いた古いユニットを復号へ渡さない**（受入条件 A-3）", () => {
  // 予備の接続へ切り替えたときや張り直したときに、上流が自分の位置から送り直す。
  // 既に描いた番号より古いものを渡すと描画が巻き戻り、参照先も既に置き換わっている。
  const clock = { ms: 1000 };
  const { deps, log } = recorder(clock);
  let state = createPipeline(4, clock.ms);
  state = handleMedia(state, mediaBytes({ key: true, seq: 100, captureUs: 0 }), deps);
  clock.ms += 66;
  state = handleMedia(state, mediaBytes({ key: false, seq: 101, captureUs: 66_000 }), deps);
  assert.equal(log.decoded.length, 2);

  // 100 番台を描いた後に 99 が届く（切替で送り直された）。
  clock.ms += 66;
  state = handleMedia(state, mediaBytes({ key: false, seq: 99, captureUs: 33_000 }), deps);
  assert.equal(log.decoded.length, 2, "**渡さない**（逆行させない）");

  // 同じ番号が 2 度届いても渡さない（重複も A-3 の不合格である）。
  clock.ms += 66;
  state = handleMedia(state, mediaBytes({ key: false, seq: 101, captureUs: 66_000 }), deps);
  assert.equal(log.decoded.length, 2, "重複も渡さない");

  // 続きは通る（古いものを覚え直していない）。
  clock.ms += 66;
  state = handleMedia(state, mediaBytes({ key: false, seq: 102, captureUs: 132_000 }), deps);
  assert.equal(log.decoded.length, 3, "前へ進むものは通る");

  // **キーフレームは古い番号でも通す**（送り手が番号を作り直した場合に詰まらせない）。
  clock.ms += 66;
  state = handleMedia(state, mediaBytes({ key: true, seq: 5, captureUs: 198_000 }), deps);
  assert.equal(log.decoded.length, 4, "キーフレームは自己完結しているため通す");
});

test("**連番が 2^32 で戻っても古いと読まない**（wire-format.md 1.2）", () => {
  // 単純な大小比較だと巻き戻した直後に「古い」と読み、長い通話で映像が二度と出なくなる。
  const clock = { ms: 1000 };
  const { deps, log } = recorder(clock);
  let state = createPipeline(4, clock.ms);
  const last = 4_294_967_295;
  state = handleMedia(state, mediaBytes({ key: true, seq: last - 1, captureUs: 0 }), deps);
  clock.ms += 66;
  state = handleMedia(state, mediaBytes({ key: false, seq: last, captureUs: 66_000 }), deps);
  assert.equal(log.decoded.length, 2);

  // 巻き戻して 1 へ戻る（0 は使わない）。飛びとしても逆行としても扱ってはならない。
  clock.ms += 66;
  state = handleMedia(state, mediaBytes({ key: false, seq: 1, captureUs: 132_000 }), deps);
  assert.equal(log.decoded.length, 3, "巻き戻しの次を渡す");
  clock.ms += 66;
  const beforeTail = log.decoded.length;
  const controlBefore = log.control.length;
  state = handleMedia(state, mediaBytes({ key: false, seq: 2, captureUs: 198_000 }), deps);
  assert.equal(
    log.decoded.length,
    4,
    `その続きも渡す（前 ${String(beforeTail)} / 制御 ${JSON.stringify(log.control.slice(controlBefore))}）`,
  );
});

test("連番が飛んでいなければ何もしない（誤検知しない）", () => {
  const clock = { ms: 1000 };
  const { deps, log } = recorder(clock);
  let state = createPipeline(4, clock.ms);
  state = handleMedia(state, mediaBytes({ key: true, seq: 10, captureUs: 0 }), deps);
  for (let index = 1; index <= 5; index += 1) {
    clock.ms += 66;
    state = handleMedia(
      state,
      mediaBytes({ key: false, seq: 10 + index, captureUs: index * 66_000 }),
      deps,
    );
  }
  assert.equal(log.decoded.length, 6, "連番が続く間は全部渡す");
  assert.equal(
    log.control.filter((text: string) => text.includes("keyframeRequest")).length,
    0,
    "要求は出さない",
  );
});

test("**音声は決して捨てない**", () => {
  const clock = { ms: 1000 };
  const { deps, log } = recorder(clock);
  let state = createPipeline(4, clock.ms);
  // 期限を大きく過ぎた時刻で音声を受けても再生キューへ入る。
  state = handleMedia(state, mediaBytes({ channel: CHANNEL_AUDIO, captureUs: 0 }), deps);
  clock.ms += 10_000;
  state = handleMedia(state, mediaBytes({ channel: CHANNEL_AUDIO, captureUs: 20_000, seq: 2 }), deps);
  assert.equal(log.audio.length, 2, "2 つとも再生キューへ入る");
  assert.equal(log.decoded.length, 0, "音声は映像の復号器へ行かない");
});

test("期限を過ぎた映像は捨てる（遅らせて出さない）", () => {
  const clock = { ms: 1000 };
  const { deps, log } = recorder(clock);
  let state = createPipeline(4, clock.ms);
  // 音声で対応付けを確立する。
  state = handleMedia(state, mediaBytes({ channel: CHANNEL_AUDIO, captureUs: 0 }), deps);
  // まず範囲内のキーフレームで復号器を作る（差分の参照先を用意する）。
  const clockAfter = state.playout.clocks[0];
  assert.ok(clockAfter !== undefined);
  clock.ms = clockAfter.anchorLocalMs;
  state = handleMedia(state, mediaBytes({ channel: CHANNEL_VIDEO, captureUs: 0, key: true, seq: 1 }), deps);
  assert.equal(log.decoded.length, 1, "キーフレームは復号される");
  // 取得時刻 0 の**差分**を、対応付けの目標から大きく遅れた局所時刻で受ける。
  clock.ms += 5_000;
  const before = log.decoded.length;
  state = handleMedia(state, mediaBytes({ channel: CHANNEL_VIDEO, captureUs: 0, key: false, seq: 2 }), deps);
  assert.equal(log.decoded.length, before, "差分は復号器へ渡さない");
  assert.ok(state.discardedVideo > 0, "捨てた枚数を数える");
});

test("**期限を過ぎてもキーフレームは捨てない**（wire-format.md 1.4、ADR-0056）", () => {
  // 写像が狂っている間、差分は捨てられてよい。しかしキーフレームまで捨てると、
  // 参照連鎖の回復が永久に来ない。要求したキーフレームが届いても捨てられ、要求と
  // 破棄の輪が回る（実測 N-0: 要求 9 回・復号器の失敗 11 回・生成 12 回）。
  const clock = { ms: 1000 };
  const { deps, log } = recorder(clock);
  let state = createPipeline(4, clock.ms);
  // 音声で対応付けを確立する。
  state = handleMedia(state, mediaBytes({ channel: CHANNEL_AUDIO, captureUs: 0 }), deps);
  const clockAfter = state.playout.clocks[0];
  assert.ok(clockAfter !== undefined);
  clock.ms = clockAfter.anchorLocalMs;
  state = handleMedia(state, mediaBytes({ channel: CHANNEL_VIDEO, captureUs: 0, key: true, seq: 1 }), deps);
  assert.equal(log.decoded.length, 1);
  // 写像の上で 5 秒遅れた局所時刻へ進める。以降の映像は期限切れ（discard）になる。
  clock.ms += 5_000;
  // 期限切れの差分は捨てられる（規範どおり。ADR-0028 の原則 3）。
  state = handleMedia(state, mediaBytes({ channel: CHANNEL_VIDEO, captureUs: 66_000, key: false, seq: 2 }), deps);
  assert.equal(log.decoded.length, 1, "差分は捨てる");
  assert.ok(state.discardedVideo > 0, "捨てた枚数を数える");
  // 期限切れのキーフレームは渡る。参照連鎖の回復のためである（ADR-0056）。
  clock.ms += 66;
  state = handleMedia(state, mediaBytes({ channel: CHANNEL_VIDEO, captureUs: 132_000, key: true, seq: 3 }), deps);
  assert.equal(log.decoded.length, 2, "キーフレームは捨てない（復号へ渡る）");
});

test("対応付けの範囲内の映像は復号される", () => {
  const clock = { ms: 1000 };
  const { deps, log } = recorder(clock);
  let state = createPipeline(4, clock.ms);
  state = handleMedia(state, mediaBytes({ channel: CHANNEL_AUDIO, captureUs: 0 }), deps);
  // 音声のバッファ深度ぶん進んだ時刻に、同じ取得時刻の映像が来る。
  const clockAfter = state.playout.clocks[0];
  assert.ok(clockAfter !== undefined);
  clock.ms = clockAfter.anchorLocalMs;
  state = handleMedia(state, mediaBytes({ channel: CHANNEL_VIDEO, captureUs: 0, key: true, seq: 2 }), deps);
  assert.equal(log.decoded.length, 1);
  assert.equal(state.discardedVideo, 0);
});

test("goodput を数えて report として上流へ送る", () => {
  const clock = { ms: 1000 };
  const { deps, log } = recorder(clock);
  let state = createPipeline(4, clock.ms);
  // 1 秒の窓に 10 通（各 92 バイト）を流す。
  for (let i = 0; i < 10; i += 1) {
    clock.ms += 50;
    state = handleMedia(state, mediaBytes({ key: true, seq: i + 1 }), deps);
  }
  // 窓を満了させる。
  clock.ms += GOODPUT_MARGIN_MS;
  state = handleMedia(state, mediaBytes({ key: true, seq: 100 }), deps);
  assert.ok(state.downlinkBps > 0, `下り帯域が算出される（実際 ${String(state.downlinkBps)}）`);

  clock.ms += REPORT_INTERVAL_MS;
  state = handleReportTimer(state, deps);
  assert.equal(log.control.length, 1, "報告を 1 通送る");
  const parsed: unknown = JSON.parse(log.control[0] ?? "{}");
  assert.ok(typeof parsed === "object" && parsed !== null);
  const record: Record<string, unknown> = { ...parsed };
  assert.equal(record["t"], "report");
  assert.equal(record["downlinkBps"], state.downlinkBps);
  assert.ok(Array.isArray(record["arrivalDelaySamplesUs"]), "標本列を送る（勾配は送らない）");
});

/** goodput の窓（1 秒）を確実に跨ぐための余白。 */
const GOODPUT_MARGIN_MS = 1200;

test("報告の周期の内側では送らない", () => {
  const clock = { ms: 1000 };
  const { deps, log } = recorder(clock);
  let state = createPipeline(4, clock.ms);
  clock.ms += REPORT_INTERVAL_MS - 1;
  state = handleReportTimer(state, deps);
  assert.equal(log.control.length, 0);
});

test("形式違反の上流メッセージでクライアントを落とさない", () => {
  const clock = { ms: 1000 };
  const { deps, log } = recorder(clock);
  const state = createPipeline(4, clock.ms);
  const broken = new Uint8Array([WIRE_MAGIC ^ 0xff, 1, CHANNEL_VIDEO, 1, 0, 0, 0, 1]);
  const after = handleMedia(state, broken, deps);
  assert.equal(log.decoded.length, 0);
  assert.equal(log.closed.length, 0, "復号器を閉じない");
  assert.deepEqual(after.observations, state.observations, "状態を変えない");
});

test("送信者の退出で復号器と再生クロックが解放される", () => {
  const clock = { ms: 1000 };
  const { deps, log } = recorder(clock);
  let state = createPipeline(4, clock.ms);
  state = handleMedia(state, mediaBytes({ key: true }), deps);
  state = handleMedia(state, mediaBytes({ channel: CHANNEL_AUDIO, captureUs: 0, seq: 2 }), deps);
  state = releaseSenderState(state, SENDER, deps);
  assert.deepEqual(log.closed, [{ senderId: SENDER, channel: CHANNEL_VIDEO }]);
  assert.equal(state.playout.clocks.length, 0);
  assert.equal(state.observations.length, 0);
});

test("経路の不連続で対応付けを作り直す（再接続・予備接続への切替）", () => {
  const clock = { ms: 1000 };
  const { deps } = recorder(clock);
  let state = createPipeline(4, clock.ms);
  state = handleMedia(state, mediaBytes({ channel: CHANNEL_AUDIO, captureUs: 0 }), deps);
  assert.equal(state.playout.clocks[0]?.hasAnchor, true);
  state = noteRouteChange(state, SENDER);
  assert.equal(state.playout.clocks[0]?.hasAnchor, false, "対応付けを捨てる");
});

test("申告された fps を取り込む（停止の判定に使う）", () => {
  const clock = { ms: 1000 };
  const state = noteFramerate(createPipeline(4, clock.ms), SENDER, 30);
  assert.equal(state.observations[0]?.senderId, SENDER);
});

test("同じ入力に対して同じ副作用を出す（決定的である）", () => {
  const run = (): string => {
    const clock = { ms: 1000 };
    const { deps, log } = recorder(clock);
    let state = createPipeline(4, clock.ms);
    for (let i = 0; i < 5; i += 1) {
      clock.ms += 33;
      state = handleMedia(state, mediaBytes({ key: i === 0, seq: i + 1, captureUs: i * 33_000 }), deps);
    }
    return JSON.stringify({
      configured: log.configured,
      reset: log.reset,
      decodedCount: log.decoded.length,
      discarded: state.discardedVideo,
    });
  };
  assert.equal(run(), run());
});
