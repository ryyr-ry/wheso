/**
 * 再生クロックと音声映像の同期を検証する（ADR-0028、F-043）。
 *
 * 検証する性質。いずれも「これが無いとずれる、または映像が止まる」ものである。
 *
 *   1. **音声が届かなくても映像は止まらない**（旧設計の致命的な欠陥）
 *   2. 音声を 1 度も受けていない相手の映像はそのまま提示する
 *   3. 許容は非対称である（音声先行に厳しい。ITU-R BT.1359-0）
 *   4. 期限を過ぎた映像は捨てる。遅らせて出さない
 *   5. ドリフトは連続に補正する。跳ばない
 *   6. 不連続（長い欠落・再接続）のときだけ対応付けを作り直す
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decidePresent,
  forgetSender,
  initialPlayout,
  mapToLocalMs,
  noteAudio,
  noteAudioBuffer,
  noteDiscontinuity,
  resyncTotal,
  type PlayoutState,
} from "../packages/core/src/playout.ts";
import {
  AV_DRIFT_STEP_US,
  AV_RESYNC_GAP_MS,
  AV_SKEW_AUDIO_LAG_MAX_MS,
  AV_SKEW_AUDIO_LEAD_MAX_MS,
} from "../packages/core/src/generated/constants.ts";

const SENDER = 7;
/** 音声のジッタバッファの深さ（ミリ秒）。 */
const DEPTH = 40;

/** 送信側の取得時刻。0 から始まる単調増加のマイクロ秒である。 */
function us(ms: number): number {
  return ms * 1000;
}

/** 対応付けを確立した状態を作る。局所時刻 1000 ms のときに取得時刻 0 の音声を受けた。 */
function anchored(): PlayoutState {
  return noteAudio(initialPlayout(), SENDER, us(0), 1000, DEPTH).state;
}

test("音声を 1 度も受けていない相手の映像はそのまま提示する（映像を止めない）", () => {
  const result = decidePresent(initialPlayout(), SENDER, us(0), 1000);
  assert.equal(result.decision, "free");
});

test("**音声が届かなくなっても映像は止まらない**（写像は局所時計で進む）", () => {
  const state = anchored();
  // 以後、音声は 1 つも届かない（選別転送で落とされた、無音が続いた）。
  // 局所時刻と取得時刻が同じだけ進むなら、いつまでも提示できる。
  for (let elapsed = 0; elapsed <= 60_000; elapsed += 1_000) {
    const decision = decidePresent(state, SENDER, us(elapsed), 1000 + DEPTH + elapsed);
    assert.equal(
      decision.decision,
      "present",
      `${String(elapsed)} ms 後も提示できる（実際 ${decision.decision}）`,
    );
  }
});

test("対応付けはジッタバッファの深さだけ先に置く", () => {
  const state = anchored();
  const clock = state.clocks[0];
  assert.ok(clock !== undefined);
  assert.equal(clock.anchorLocalMs, 1000 + DEPTH);
  assert.equal(mapToLocalMs(clock, us(0)), 1000 + DEPTH);
  assert.equal(mapToLocalMs(clock, us(100)), 1000 + DEPTH + 100);
});

test("許容は非対称である（音声先行に厳しい。ITU-R BT.1359-0）", () => {
  assert.ok(
    AV_SKEW_AUDIO_LEAD_MAX_MS < AV_SKEW_AUDIO_LAG_MAX_MS,
    "音声先行の上限は音声遅れの上限より小さい",
  );
  const state = anchored();
  const target = 1000 + DEPTH;
  // 映像が遅れている（音声が先行している）方向。
  assert.equal(decidePresent(state, SENDER, us(0), target + AV_SKEW_AUDIO_LEAD_MAX_MS).decision, "present");
  assert.equal(
    decidePresent(state, SENDER, us(0), target + AV_SKEW_AUDIO_LEAD_MAX_MS + 1).decision,
    "discard",
    "音声先行の上限を超えたら捨てる",
  );
  // 映像が先行している（音声が遅れている）方向。
  assert.equal(decidePresent(state, SENDER, us(0), target - AV_SKEW_AUDIO_LAG_MAX_MS).decision, "present");
  assert.equal(
    decidePresent(state, SENDER, us(0), target - AV_SKEW_AUDIO_LAG_MAX_MS - 1).decision,
    "hold",
    "音声遅れの上限を超えたら持つ",
  );
});

test("期限を過ぎた映像は捨てる。遅らせて出さない（結果は fps の低下である）", () => {
  const state = anchored();
  const late = decidePresent(state, SENDER, us(0), 1000 + DEPTH + 500);
  assert.equal(late.decision, "discard");
  assert.ok(late.skewMs > 0, "ずれは正（映像が遅れている）");
});

test("補正の刻みは 1000 ppm のクロック差に追従できる", () => {
  // AV_DRIFT_STEP_US を OPUS_FRAME_MS（20 ms）ごとに適用できる。
  // 20 µs / 20 ms = 1000 ppm。30 分（1800 秒）で 1.8 秒ぶんのずれを吸収できる。
  const ppm = Math.trunc((AV_DRIFT_STEP_US * 1_000_000) / (20 * 1000));
  assert.equal(ppm, 1000);
});

test("規定を超える欠落は不連続として対応付けを作り直す", () => {
  let state = anchored();
  // 通常の間隔では作り直さない。
  const normal = noteAudio(state, SENDER, us(20), 1020, DEPTH);
  assert.equal(normal.established, false);
  state = normal.state;

  // 送信側の時刻が大きく飛んだ。
  const jumped = noteAudio(state, SENDER, us(20 + AV_RESYNC_GAP_MS + 1), 1030, DEPTH);
  assert.equal(jumped.established, true, "作り直す");
  assert.equal(resyncTotal(jumped.state), 1, "回数を数える（SLI）");
});

test("局所時刻が大きく飛んだ場合も不連続として扱う（停止からの復帰）", () => {
  const state = anchored();
  const resumed = noteAudio(state, SENDER, us(20), 1000 + AV_RESYNC_GAP_MS + 100, DEPTH);
  assert.equal(resumed.established, true);
  assert.equal(resyncTotal(resumed.state), 1);
});

test("後戻りする取得時刻は不連続として扱う", () => {
  const state = noteAudio(anchored(), SENDER, us(100), 1100, DEPTH).state;
  const back = noteAudio(state, SENDER, us(50), 1150, DEPTH);
  assert.equal(back.established, true);
});

test("再接続と予備接続への切替は明示的に不連続とする", () => {
  const state = noteDiscontinuity(anchored(), SENDER);
  // 対応付けが無くなるため、次の映像は「そのまま提示」に戻る。
  assert.equal(decidePresent(state, SENDER, us(0), 1000).decision, "free");
  // 次の音声で作り直す。
  const rebuilt = noteAudio(state, SENDER, us(500), 2000, DEPTH);
  assert.equal(rebuilt.established, true);
  assert.equal(decidePresent(rebuilt.state, SENDER, us(500), 2000 + DEPTH).decision, "present");
});

test("送信者の退出で記録が消える", () => {
  const state = forgetSender(anchored(), SENDER);
  assert.equal(state.clocks.length, 0);
});

test("同じ入力に対して同じ結果を返す（決定的である）", () => {
  const run = (): string => {
    let state = initialPlayout();
    const out: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const noted = noteAudio(state, SENDER, us(i * 20), 1000 + i * 20, DEPTH);
      state = noted.state;
      out.push(String(noted.established));
      const drift = noteAudioBuffer(state, SENDER, DEPTH + 30, DEPTH);
      state = drift.state;
      out.push(String(drift.resampleUs));
      out.push(decidePresent(state, SENDER, us(i * 20), 1000 + i * 20 + DEPTH).decision);
    }
    return out.join(",");
  };
  assert.equal(run(), run());
});
