/**
 * 音声の選別転送（ADR-0024）の試験。
 *
 * 何を確かめるか: 中継ノードが「直近に発話した上位 AUDIO_SELECTIVE_FORWARD_COUNT 名」の
 * 音声だけを転送し、それ以外を破棄すること。発話が止まってからも AUDIO_SPEAKER_HOLD_MS は
 * 対象に残ること。順位が決定的であること（時刻が同じなら senderId の昇順）。
 *
 * なぜ必要か: 選別転送は収容人数の計算の前提である（constants.md 3.1。束ねありで 160 人）。
 * 全員の音声を転送すると、160 人の会議で送信メッセージレートが予算を超える。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { initialState, step, type ShardEvent, type ShardState } from "../packages/core/src/shard-core.ts";
import {
  AUDIO_SELECTIVE_FORWARD_COUNT,
  AUDIO_SELECTIVE_MIN_COUNT,
  AUDIO_SPEAKER_HOLD_MS,
  SHEDDING_HYSTERESIS_MS,
} from "../packages/core/src/generated/constants.ts";
import {
  CHANNEL_AUDIO,
  CHANNEL_VIDEO,
  FLAG_ACTIVE_SPEAKER,
  FLAG_END_OF_FRAME,
  MAX_SPATIAL_ID,
  MAX_TEMPORAL_ID,
} from "../packages/core/src/generated/wire-layout.ts";

/** 参加者を入れ、全員が全員を購読している状態を作る。 */
function meetingWith(senderIds: readonly number[], subscriberId: number, t = 0): ShardState {
  let state = initialState(t);
  for (const id of [...senderIds, subscriberId]) {
    state = step(state, { kind: "join", id }, t).state;
  }
  for (const id of senderIds) {
    // 音声と映像の両方を購読する。購読は (subscriberId, targetId, channel) で一意である。
    state = step(
      state,
      { kind: "subscribe", from: subscriberId, to: id, ch: CHANNEL_AUDIO, want: true, maxSpatialId: 0, maxTemporalId: 0 },
      t,
    ).state;
    state = step(
      state,
      {
        kind: "subscribe",
        from: subscriberId,
        to: id,
        ch: CHANNEL_VIDEO,
        want: true,
        maxSpatialId: MAX_SPATIAL_ID,
        maxTemporalId: MAX_TEMPORAL_ID,
      },
      t,
    ).state;
  }
  return state;
}

/** 送信者ごとの音声の sequenceNumber。同一ストリーム内で単調増加させる。 */
const audioSeq = new Map<number, number>();

function audioFrom(senderId: number, speaking: boolean): ShardEvent {
  const seq = (audioSeq.get(senderId) ?? 0) + 1;
  audioSeq.set(senderId, seq);
  return {
    kind: "media",
    from: senderId,
    ch: CHANNEL_AUDIO,
    sid: 0,
    tid: 0,
    key: false,
    bytes: 160,
    flags: speaking ? FLAG_END_OF_FRAME | FLAG_ACTIVE_SPEAKER : FLAG_END_OF_FRAME,
    seq,
  };
}

/** 転送されたか（forward コマンドが出たか）。 */
function forwarded(state: ShardState, event: ShardEvent, t: number): { forwarded: boolean; state: ShardState } {
  const result = step(state, event, t);
  return {
    forwarded: result.commands.some((command) => command.kind === "forward"),
    state: result.state,
  };
}

test("発話者が上限以下なら全員の音声を転送する", () => {
  const senders = [10, 11, 12, 13, 14];
  assert.equal(senders.length, AUDIO_SELECTIVE_FORWARD_COUNT, "上限と同数で試す");
  let state = meetingWith(senders, 1);
  let at = 100;
  for (const id of senders) {
    const outcome = forwarded(state, audioFrom(id, true), at);
    state = outcome.state;
    assert.equal(outcome.forwarded, true, `${String(id)} の音声が転送される`);
    at += 10;
  }
});

test("上限を超えたら古い発話者の音声を破棄する", () => {
  // 6 人が発話する。最も古い発話者が対象から外れる。
  const senders = [10, 11, 12, 13, 14, 15];
  let state = meetingWith(senders, 1);
  let at = 100;
  for (const id of senders) {
    state = step(state, audioFrom(id, true), at).state;
    at += 10;
  }
  // 直後にもう一度、各送信者の音声を流す。最も古い 10 番が落ちる。
  const oldest = forwarded(state, audioFrom(10, false), at);
  assert.equal(oldest.forwarded, false, "最も古い発話者の音声は転送されない");
  const newest = forwarded(state, audioFrom(15, false), at);
  assert.equal(newest.forwarded, true, "最も新しい発話者の音声は転送される");
});

test("発話し直せば対象へ戻る", () => {
  const senders = [10, 11, 12, 13, 14, 15];
  let state = meetingWith(senders, 1);
  let at = 100;
  for (const id of senders) {
    state = step(state, audioFrom(id, true), at).state;
    at += 10;
  }
  // 10 番が発話し直す（ACTIVE_SPEAKER=1）。記録が更新され、最新になる。
  const again = forwarded(state, audioFrom(10, true), at + 10);
  assert.equal(again.forwarded, true, "発話中の音声は必ず転送される");
  state = again.state;
  // 今度は 11 番が最も古い。
  const nowOldest = forwarded(state, audioFrom(11, false), at + 20);
  assert.equal(nowOldest.forwarded, false, "入れ替わって 11 番が対象から外れる");
});

test("発話が止まっても保持時間の内側は対象に残る", () => {
  const senders = [10, 11, 12, 13, 14, 15];
  let state = meetingWith(senders, 1);
  let at = 1000;
  for (const id of senders) {
    state = step(state, audioFrom(id, true), at).state;
    at += 10;
  }
  // 保持時間の内側。6 人が候補に残るため、最も古い 10 番は落ちる。
  const inside = forwarded(state, audioFrom(10, false), at + AUDIO_SPEAKER_HOLD_MS - 100);
  assert.equal(inside.forwarded, false, "保持時間の内側では 6 人が候補に残り、最古が落ちる");

  // 保持時間を過ぎると候補が消える。候補が上限以下になるため全員通る。
  const outside = forwarded(state, audioFrom(10, false), at + AUDIO_SPEAKER_HOLD_MS + 100);
  assert.equal(outside.forwarded, true, "保持時間を過ぎれば候補が消え、音声は通る");
});

test("同時刻の発話は senderId の昇順で選ぶ（決定性）", () => {
  const senders = [10, 11, 12, 13, 14, 15];
  let state = meetingWith(senders, 1);
  // 全員が**同じ時刻**に発話する。
  for (const id of senders) {
    state = step(state, audioFrom(id, true), 500).state;
  }
  // 昇順で上位 5 名（10..14）が対象。15 番が外れる。
  const excluded = forwarded(state, audioFrom(15, false), 500);
  assert.equal(excluded.forwarded, false, "同時刻なら senderId の大きい方が外れる");
  const included = forwarded(state, audioFrom(14, false), 500);
  assert.equal(included.forwarded, true, "同時刻なら senderId の小さい方が残る");
});

test("映像は選別転送の対象外である", () => {
  const senders = [10, 11, 12, 13, 14, 15];
  let state = meetingWith(senders, 1);
  let at = 100;
  for (const id of senders) {
    state = step(state, audioFrom(id, true), at).state;
    at += 10;
  }
  // 音声で外れた 10 番の**映像**は転送される。選別は音声だけの規則である。
  const video = forwarded(
    state,
    {
      kind: "media",
      from: 10,
      ch: CHANNEL_VIDEO,
      sid: 0,
      tid: 0,
      seq: 1,
      key: true,
      bytes: 900,
      flags: FLAG_END_OF_FRAME,
    },
    at,
  );
  assert.equal(video.forwarded, true, "映像は選別転送で落ちない");
});

test("発話の記録は senderId の昇順に保たれる（9 言語で一致させるため）", () => {
  const senders = [15, 12, 10, 14, 11, 13];
  let state = meetingWith(senders, 1);
  let at = 100;
  for (const id of senders) {
    state = step(state, audioFrom(id, true), at).state;
    at += 10;
  }
  const ids = state.speakers.map((entry) => entry.senderId);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "senderId の昇順である");
  assert.equal(ids.length, senders.length, "全員が記録されている");
});

test("破棄された音声は輻輳の破棄と区別できる（priority 0）", () => {
  const senders = [10, 11, 12, 13, 14, 15];
  let state = meetingWith(senders, 1);
  let at = 100;
  for (const id of senders) {
    state = step(state, audioFrom(id, true), at).state;
    at += 10;
  }
  const result = step(state, audioFrom(10, false), at);
  const drops = result.commands.filter((command) => command.kind === "drop");
  assert.equal(drops.length, 1, "破棄が 1 件出る");
  const drop = drops[0];
  assert.ok(drop !== undefined && drop.kind === "drop");
  assert.equal(drop.priority, 0, "選別による破棄は priority 0 である（輻輳ではない）");
});

test("上限ちょうどの発話者がいるとき、発話していない者の音声も通る", () => {
  // ADR-0024 の 6 項。DTX で無音の間に相手の環境音が完全に消えると通話が不自然になるため、
  // 対象が上限に達していなければ発話していない送信者の音声も転送する。
  const speaking = [10, 11, 12, 13, 14];
  const silent = 15;
  let state = meetingWith([...speaking, silent], 1);
  let at = 100;
  for (const id of speaking) {
    state = step(state, audioFrom(id, true), at).state;
    at += 10;
  }
  assert.equal(state.speakers.length, AUDIO_SELECTIVE_FORWARD_COUNT, "発話者が上限ちょうどである");
  const outcome = forwarded(state, audioFrom(silent, false), at);
  assert.equal(outcome.forwarded, true, "発話していない送信者の音声も通る");
});

test("**音声の本数は購読者ごとに帯域で決まる**（輻輳が深いほど減る。ADR-0029 の 2）", () => {
  // 上限（5 名）を超える 7 名が発話している状態を作る。
  const senders = [1, 2, 3, 4, 5, 6, 7];
  let state = meetingWith(senders, 100, 0);
  let t = 10;
  for (const id of senders) {
    state = step(state, audioFrom(id, true), t).state;
    t += 5;
  }

  // NORMAL では上限どおり 5 名が通る。最も古い発話者 2 名は落ちる。
  const forwardedAtNormal = senders.filter((id) => {
    const result = step(state, audioFrom(id, false), t);
    return result.commands.some((command) => command.kind === "forward");
  });
  assert.equal(
    forwardedAtNormal.length,
    AUDIO_SELECTIVE_FORWARD_COUNT,
    `NORMAL では上限どおり（実際 ${String(forwardedAtNormal.length)}）`,
  );

  // 購読者の勾配を悪化させて輻輳の段を深くする。段が深いほど本数が減る。
  const rising: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    rising.push(10_000 + i * 60_000);
  }
  let degraded = step(state, { kind: "report", from: 100, delayUs: rising }, t).state;
  let previous = forwardedAtNormal.length;
  for (let stage = 0; stage < 4; stage += 1) {
    t += SHEDDING_HYSTERESIS_MS + 1;
    degraded = step(degraded, { kind: "timer" }, t).state;
    // 発話の記録を作り直す。ヒステリシスの待ち（501 ms）を 2 回跨ぐと
    // AUDIO_SPEAKER_HOLD_MS（800 ms）を超えて候補が消えるため、そのままでは
    // 「候補が上限以下だから全員通る」状態になり、本数の判定にならない。
    for (const id of senders) {
      degraded = step(degraded, audioFrom(id, true), t).state;
      t += 1;
    }
    const forwarded = senders.filter((id) => {
      const result = step(degraded, audioFrom(id, false), t);
      return result.commands.some((command) => command.kind === "forward");
    });
    assert.ok(
      forwarded.length <= previous,
      `段が深くなるほど本数は増えない（前 ${String(previous)} 後 ${String(forwarded.length)}）`,
    );
    previous = forwarded.length;
  }
  assert.ok(previous >= AUDIO_SELECTIVE_MIN_COUNT, "**1 本は必ず残る**");
  assert.ok(previous < AUDIO_SELECTIVE_FORWARD_COUNT, "実際に減っている");
});
