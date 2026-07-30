/**
 * 中継ノードの輻輳状態機械が state-machines.md 3 節の表と一行ずつ一致することを検証する。
 *
 * **判断は購読ごとに独立している**（congestion.md 7 節、ADR-0025）。したがって本ファイルは
 * 「1 本の購読の遷移が表どおりであること」と「1 本の購読の劣化が他へ波及しないこと」の
 * 両方を確かめる。後者が無いと、規範が名指しで禁じた形（遅い受信者 1 人が全体を落とす）を
 * 検出できない。
 *
 * なぜ表から書くか: 実装をなぞる試験は実装の誤りを検出しない（ADR-0012 の趣旨）。
 * 閾値の境界（すぐ上とすぐ下）で判定が変わることを確かめる。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  congestionOf,
  initialState,
  step,
  type CongestionState,
  type ShardEvent,
  type ShardState,
} from "../packages/core/src/shard-core.ts";
import {
  SEND_WINDOW_MS,
  SHEDDING_HYSTERESIS_MS,
  SHARD_TREND_EXIT_DEN,
  SHARD_TREND_EXIT_NUM,
  SHARD_UTIL_ENTER_T2_DEN,
  SHARD_UTIL_ENTER_T2_NUM,
  V_360P15,
} from "../packages/core/src/generated/constants.ts";
import {
  CHANNEL_VIDEO,
  FLAG_DISCARDABLE,
  FLAG_END_OF_FRAME,
  FLAG_KEY,
  MAX_TEMPORAL_ID,
} from "../packages/core/src/generated/wire-layout.ts";

const SENDER = 1;
const SUBSCRIBER = 2;
const OTHER = 3;

/** 最下段のみのはしご。fps が既知になるため送信窓を評価できる。 */
const SINGLE_RUNG: ShardEvent = {
  kind: "streamAnnounce",
  from: SENDER,
  ch: CHANNEL_VIDEO,
  rungs: [
    {
      sid: 0,
      width: V_360P15.width,
      height: V_360P15.height,
      framerate: V_360P15.framerate,
      temporalLayers: V_360P15.temporalLayers,
      targetBitrate: V_360P15.targetBitrate,
    },
  ],
};

function subscribeOf(from: number, to: number): ShardEvent {
  return {
    kind: "subscribe",
    from,
    to,
    ch: CHANNEL_VIDEO,
    want: true,
    maxSpatialId: 0,
    maxTemporalId: MAX_TEMPORAL_ID,
  };
}

/**
 * 勾配を作る遅延標本列。
 *
 * 標本番号 i に対して y = base + slope × i とすれば、最小二乗の勾配は slope になる。
 * 閾値は有理数で与えられているため、超えるには slope を閾値より大きく取る。
 */
function delaySamples(slopePerSample: number): readonly number[] {
  const out: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    out.push(100000 + slopePerSample * i);
  }
  return out;
}

/** 1 本の購読を持ち、はしごが申告済みの状態を作る。 */
function withOneSubscription(subscribers: readonly number[]): ShardState {
  let state = initialState(0);
  state = step(state, { kind: "join", id: SENDER }, 0).state;
  for (const id of subscribers) {
    state = step(state, { kind: "join", id }, 0).state;
  }
  state = step(state, SINGLE_RUNG, 0).state;
  for (const id of subscribers) {
    state = step(state, subscribeOf(id, SENDER), 0).state;
  }
  return state;
}

/**
 * 遷移が起きる時刻。
 *
 * 状態は `initialState(0)` と購読の生成（t=0）で始まるため、`congestionEnteredAt` は 0 である。
 * したがって最初の遷移は `SHEDDING_HYSTERESIS_MS` を跨いだ最初の評価で起きる。
 * 以後 1 段ごとに同じ時間だけ待つ必要がある。
 */
function settleAt(step_: number): number {
  return (SHEDDING_HYSTERESIS_MS + 1) * step_;
}

/* ------------------------------------------------------------------------- */
/* 規範 1.4: 順位 4・5 を落としたら次の KEY まで落とし続ける                  */
/* ------------------------------------------------------------------------- */

/**
 * 映像 1 件の事象を作る。
 *
 * `discardable` が偽なら破棄不可（優先順位 4）であり、規範 1.4 の連鎖の対象になる。
 * 旗は生成物から引く（数値を書かない）。
 */
function videoEvent(seq: number, options: { readonly key?: boolean; readonly discardable?: boolean }): ShardEvent {
  const key = options.key === true;
  const discardable = options.discardable === true;
  return {
    kind: "media",
    from: SENDER,
    ch: CHANNEL_VIDEO,
    sid: 0,
    tid: discardable ? 2 : 0,
    key,
    seq,
    bytes: 1200,
    flags:
      FLAG_END_OF_FRAME |
      (key ? FLAG_KEY : 0) |
      (discardable ? FLAG_DISCARDABLE : 0),
  };
}

/** 送信窓を閉じるまで破棄不可のフレームを送り込み、最初に落ちた時点を返す。 */
function pushUntilDrop(state: ShardState, startSeq: number): { readonly state: ShardState; readonly seq: number } {
  let current = state;
  for (let seq = startSeq; seq < startSeq + 40; seq += 1) {
    const result = step(current, videoEvent(seq, {}), 1);
    current = result.state;
    if (result.commands.some((command) => command.kind === "drop")) {
      return { state: current, seq };
    }
  }
  return { state: current, seq: -1 };
}

test("**破棄不可のユニットを落としたら、次の KEY まで落とし続ける**（規範 1.4）", () => {
  // 参照が欠けたフレーム列を渡すと復号器は出力を止める。実測では復号器へ 613 件渡して
  // 出力が 148 枚しか得られず `Decoding error` が記録された。
  const started = withOneSubscription([SUBSCRIBER]);
  const dropped = pushUntilDrop(started, 1);
  assert.notEqual(dropped.seq, -1, "送信窓が閉じて破棄が起きる");

  // 以後、KEY でないフレームは 1 件も転送されない。
  let state = dropped.state;
  for (let seq = dropped.seq + 1; seq <= dropped.seq + 5; seq += 1) {
    const result = step(state, videoEvent(seq, {}), 1);
    state = result.state;
    assert.equal(
      result.commands.some((command) => command.kind === "forward"),
      false,
      `KEY が来るまで転送しない（seq=${String(seq)}）`,
    );
  }

  // KEY が来たら転送を再開する。
  const recovered = step(state, videoEvent(dropped.seq + 6, { key: true }), 1);
  assert.equal(
    recovered.commands.some((command) => command.kind === "forward"),
    true,
    "KEY で参照連鎖が回復するため転送する",
  );
});

test("**破棄不可を落としたらキーフレームを要求する**（規範 1.4）", () => {
  const started = withOneSubscription([SUBSCRIBER]);
  let state = started;
  let requested = 0;
  for (let seq = 1; seq <= 12; seq += 1) {
    const result = step(state, videoEvent(seq, {}), 1);
    state = result.state;
    requested += result.commands.filter((command) => command.kind === "keyframeRequest").length;
  }
  assert.ok(requested > 0, "要求を送る（送らないと復号器は永久にキーフレームを待つ）");
});

test("破棄可能なユニットだけを落とした場合はキーフレームを要求しない（規範 1.4）", () => {
  // 順位 1 から 3 のみで対処できる場合、要求を発生させてはならない。
  const started = withOneSubscription([SUBSCRIBER]);
  let state = started;
  let requested = 0;
  let dropped = 0;
  for (let seq = 1; seq <= 30; seq += 1) {
    // 破棄可能（最上位の時間層）だけを送り続ける。
    const result = step(state, videoEvent(seq, { discardable: true }), 1);
    state = result.state;
    requested += result.commands.filter((command) => command.kind === "keyframeRequest").length;
    dropped += result.commands.filter((command) => command.kind === "drop").length;
  }
  assert.ok(dropped > 0, "破棄可能なユニットは落ちる（窓が閉じるため）");
  assert.equal(requested, 0, "**要求は 1 件も出さない**");
});

test("購読の輻輳状態は勾配の閾値をまたいだときだけ 1 段ずつ進む（表の劣化方向）", () => {
  let state = withOneSubscription([SUBSCRIBER]);
  // 4 つの閾値（1/100、3/100、3/50、1/10）すべてを超える勾配を 1 度だけ報告する。
  // 以後はヒステリシスを跨ぐたびに 1 段ずつ落ちる。
  state = step(state, { kind: "report", from: SUBSCRIBER, delayUs: delaySamples(60_000) }, 1).state;

  const expected: readonly CongestionState[] = ["SHEDDING_T2", "SHEDDING_T1", "SHEDDING_SPATIAL", "KEY_ONLY"];
  for (let i = 0; i < expected.length; i += 1) {
    state = step(state, { kind: "timer" }, settleAt(i + 1)).state;
    assert.equal(congestionOf(state, SUBSCRIBER, SENDER, CHANNEL_VIDEO), expected[i]);
  }
  // KEY_ONLY は終端である。さらに待っても進まない。
  state = step(state, { kind: "timer" }, settleAt(6)).state;
  assert.equal(congestionOf(state, SUBSCRIBER, SENDER, CHANNEL_VIDEO), "KEY_ONLY");
});

test("勾配が回復の閾値を下回ると 1 段ずつ戻る（表の回復方向）", () => {
  let state = withOneSubscription([SUBSCRIBER]);
  state = step(state, { kind: "report", from: SUBSCRIBER, delayUs: delaySamples(60_000) }, 1).state;
  for (let i = 0; i < 4; i += 1) {
    state = step(state, { kind: "timer" }, settleAt(i + 1)).state;
  }
  assert.equal(congestionOf(state, SUBSCRIBER, SENDER, CHANNEL_VIDEO), "KEY_ONLY");

  // 勾配を負にする。**KEY_ONLY からの回復だけは別の閾値（0）を使う**ため、
  // 一般の回復閾値（1,500 マイクロ秒/標本）を下回るだけでは足りず、負でなければならない。
  // 報告そのものが評価を起こすため、この時点で 1 段戻る（ヒステリシスを跨いでいる）。
  const recovering = -Math.trunc(SHARD_TREND_EXIT_NUM / SHARD_TREND_EXIT_DEN);
  state = step(state, { kind: "report", from: SUBSCRIBER, delayUs: delaySamples(recovering) }, settleAt(5)).state;
  assert.equal(congestionOf(state, SUBSCRIBER, SENDER, CHANNEL_VIDEO), "SHEDDING_SPATIAL");

  const back: readonly CongestionState[] = ["SHEDDING_T1", "SHEDDING_T2", "NORMAL"];
  for (let i = 0; i < back.length; i += 1) {
    state = step(state, { kind: "timer" }, settleAt(6 + i)).state;
    assert.equal(congestionOf(state, SUBSCRIBER, SENDER, CHANNEL_VIDEO), back[i]);
  }
});

test("ヒステリシスの内側では遷移しない", () => {
  let state = withOneSubscription([SUBSCRIBER]);
  state = step(state, { kind: "report", from: SUBSCRIBER, delayUs: delaySamples(60_000) }, 1).state;
  // 跨ぐ手前では NORMAL のままである。
  state = step(state, { kind: "timer" }, SHEDDING_HYSTERESIS_MS - 1).state;
  assert.equal(congestionOf(state, SUBSCRIBER, SENDER, CHANNEL_VIDEO), "NORMAL");
  // 跨ぐと遷移する。
  state = step(state, { kind: "timer" }, SHEDDING_HYSTERESIS_MS + 1).state;
  assert.equal(congestionOf(state, SUBSCRIBER, SENDER, CHANNEL_VIDEO), "SHEDDING_T2");
});

test("**購読者 1 人の劣化が他の購読者へ波及しない**（congestion.md 7 節）", () => {
  let state = withOneSubscription([SUBSCRIBER, OTHER]);
  // 悪い購読者だけが劣化した勾配を報告する。
  state = step(state, { kind: "report", from: SUBSCRIBER, delayUs: delaySamples(60_000) }, 1).state;

  const expected: readonly CongestionState[] = ["SHEDDING_T2", "SHEDDING_T1", "SHEDDING_SPATIAL", "KEY_ONLY"];
  for (let i = 0; i < expected.length; i += 1) {
    state = step(state, { kind: "timer" }, settleAt(i + 1)).state;
    assert.equal(congestionOf(state, SUBSCRIBER, SENDER, CHANNEL_VIDEO), expected[i]);
    // **もう 1 人は NORMAL のままでなければならない。**
    assert.equal(congestionOf(state, OTHER, SENDER, CHANNEL_VIDEO), "NORMAL");
  }
});

test("送信窓の充填率でも劣化する（ack が返らないとき）", () => {
  // 最下段は 15 fps であり、SEND_WINDOW_MS（200 ms）は 3 フレームに相当する。
  // 充填率が SHARD_UTIL_ENTER_T2（9/10）を超えるには未確認が 3 フレーム弱で足りる。
  const framesForThreshold =
    Math.trunc((SHARD_UTIL_ENTER_T2_NUM * SEND_WINDOW_MS * V_360P15.framerate) / (SHARD_UTIL_ENTER_T2_DEN * 1000)) + 2;
  let state = withOneSubscription([SUBSCRIBER]);
  let t = 1;
  for (let i = 0; i < framesForThreshold + 2; i += 1) {
    state = step(
      state,
      {
        kind: "media",
        from: SENDER,
        ch: CHANNEL_VIDEO,
        sid: 0,
        tid: 0,
        key: false,
        bytes: 1000,
        flags: FLAG_END_OF_FRAME,
        seq: i + 1,
      },
      t,
    ).state;
    t += 5;
  }
  // 勾配の報告は無い。窓だけで劣化する。
  state = step(state, { kind: "timer" }, SHEDDING_HYSTERESIS_MS + 1).state;
  assert.notEqual(congestionOf(state, SUBSCRIBER, SENDER, CHANNEL_VIDEO), "NORMAL");
});

test("報告が無く未確認も無い購読は劣化しない", () => {
  let state = withOneSubscription([SUBSCRIBER]);
  state = step(state, { kind: "timer" }, SHEDDING_HYSTERESIS_MS * 10).state;
  assert.equal(congestionOf(state, SUBSCRIBER, SENDER, CHANNEL_VIDEO), "NORMAL");
});
