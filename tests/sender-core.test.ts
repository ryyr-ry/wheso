/**
 * 送信ノードの判断コアの試験。
 *
 * 規範から書く。実装をなぞらない。
 *   - congestion.md 2 節: 送信窓（未確認の媒体を再生時間で数える）
 *   - state-machines.md 5 節: epoch 移行の表 5 行
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  initialSenderState,
  senderStep,
  SHARD_PEER_CURRENT,
  SHARD_PEER_NEXT,
  type SenderCommand,
  type SenderState,
} from "../packages/core/src/sender-core.ts";
import {
  EPOCH_DUAL_SUBSCRIBE_TIMEOUT_MS,
  SEND_WINDOW_MS,
} from "../packages/core/src/generated/constants.ts";
import {
  CHANNEL_AUDIO,
  CHANNEL_VIDEO,
  FLAG_DISCARDABLE,
  FLAG_END_OF_FRAME,
  FLAG_KEY,
} from "../packages/core/src/generated/wire-layout.ts";

const FPS = 60;

/** fps を宣言した初期状態。 */
function announced(): SenderState {
  return senderStep(initialSenderState(1), { kind: "streamAnnounce", ch: CHANNEL_VIDEO, sid: 3, framerate: FPS }, 0)
    .state;
}

function sendMedia(state: SenderState, seq: number, flags: number, t = 0): { state: SenderState; commands: readonly SenderCommand[] } {
  return senderStep(state, { kind: "media", ch: CHANNEL_VIDEO, sid: 3, tid: 2, seq, bytes: 40_000, flags }, t);
}

test("送信窓の内側では転送する", () => {
  // 未確認 1 フレームは 1/60 秒 = 16.7 ms。SEND_WINDOW_MS（200）の内側である。
  const result = sendMedia(announced(), 2, FLAG_END_OF_FRAME | FLAG_DISCARDABLE);
  assert.deepEqual(result.commands.map((c) => c.kind), ["forward"]);
});

test("送信窓を超えると破棄可能なユニットは渡さない", () => {
  // 未確認フレーム数 n の再生時間は n/60 秒。200 ms を超えるのは n > 12 である。
  const boundary = Math.trunc((SEND_WINDOW_MS * FPS) / 1000); // 12
  const inside = sendMedia(announced(), boundary + 1, FLAG_END_OF_FRAME | FLAG_DISCARDABLE);
  assert.deepEqual(inside.commands.map((c) => c.kind), ["forward"], "境界の内側は渡す");

  const outside = sendMedia(announced(), boundary + 2, FLAG_END_OF_FRAME | FLAG_DISCARDABLE);
  assert.deepEqual(outside.commands.map((c) => c.kind), ["drop"], "境界を超えたら渡さない");
});

test("送信窓を超えてもキーフレームと音声は渡す", () => {
  const key = sendMedia(announced(), 100, FLAG_END_OF_FRAME | FLAG_KEY);
  assert.deepEqual(key.commands.map((c) => c.kind), ["forward"], "KEY は破棄禁止");

  const audioState = senderStep(
    initialSenderState(1),
    { kind: "streamAnnounce", ch: CHANNEL_AUDIO, sid: 0, framerate: 25 },
    0,
  ).state;
  const audio = senderStep(
    audioState,
    { kind: "media", ch: CHANNEL_AUDIO, sid: 0, tid: 0, seq: 500, bytes: 208, flags: FLAG_END_OF_FRAME },
    0,
  );
  assert.deepEqual(audio.commands.map((c) => c.kind), ["forward"], "音声は破棄禁止");
});

test("ack が届くと窓が開く", () => {
  let state = announced();
  const boundary = Math.trunc((SEND_WINDOW_MS * FPS) / 1000);
  const blocked = sendMedia(state, boundary + 2, FLAG_END_OF_FRAME | FLAG_DISCARDABLE);
  assert.deepEqual(blocked.commands.map((c) => c.kind), ["drop"]);

  state = senderStep(state, { kind: "ack", ch: CHANNEL_VIDEO, sid: 3, highestSeq: boundary }, 0).state;
  const allowed = sendMedia(state, boundary + 2, FLAG_END_OF_FRAME | FLAG_DISCARDABLE);
  assert.deepEqual(allowed.commands.map((c) => c.kind), ["forward"], "確認が進めば渡せる");
});

test("後戻りする ack は無視される", () => {
  let state = announced();
  state = senderStep(state, { kind: "ack", ch: CHANNEL_VIDEO, sid: 3, highestSeq: 100 }, 0).state;
  const after = senderStep(state, { kind: "ack", ch: CHANNEL_VIDEO, sid: 3, highestSeq: 50 }, 0);
  assert.equal(after.state.windows[0]?.highestAcked, 100);
});

test("表 1 行目: 割当先が変わらない epoch 変化では接続を張り替えない", () => {
  const result = senderStep(announced(), { kind: "epochChange", epoch: 2, assignmentChanged: false }, 100);
  assert.equal(result.state.phase, "STEADY");
  assert.equal(result.state.epoch, 2);
  assert.equal(result.commands.length, 0);
});

test("表 2 行目: 割当先が変わると DUAL_SUBSCRIBE になり新 epoch へ接続する", () => {
  const result = senderStep(announced(), { kind: "epochChange", epoch: 2, assignmentChanged: true }, 100);
  assert.equal(result.state.phase, "DUAL_SUBSCRIBE");
  assert.equal(result.state.targetEpoch, 2);
  const kinds = result.commands.map((c) => c.kind);
  assert.ok(kinds.includes("connect"));
  assert.ok(kinds.includes("schedule"));
});

test("二重購読中は新旧の両方へ転送する（欠落を作らないため）", () => {
  const dual = senderStep(announced(), { kind: "epochChange", epoch: 2, assignmentChanged: true }, 100).state;
  const forwarded = sendMedia(dual, 2, FLAG_END_OF_FRAME | FLAG_DISCARDABLE, 110);
  const command = forwarded.commands[0];
  assert.equal(command?.kind, "forward");
  assert.deepEqual(command?.kind === "forward" ? command.to : [], [SHARD_PEER_CURRENT, SHARD_PEER_NEXT]);
});

test("表 3 行目: 新 epoch の最初のフレームで MIGRATING へ移り旧購読を解除する", () => {
  const dual = senderStep(announced(), { kind: "epochChange", epoch: 2, assignmentChanged: true }, 100).state;
  const migrating = senderStep(dual, { kind: "newEpochFrame" }, 150);
  assert.equal(migrating.state.phase, "MIGRATING");
  assert.deepEqual(migrating.commands.map((c) => c.kind), ["unsubscribeStale"]);
});

test("表 5 行目: 旧接続のバッファが空になったら閉じて STEADY へ戻る", () => {
  let state = senderStep(announced(), { kind: "epochChange", epoch: 2, assignmentChanged: true }, 100).state;
  state = senderStep(state, { kind: "newEpochFrame" }, 150).state;
  const pending = senderStep(state, { kind: "staleBacklog", bytes: 4000 }, 160);
  assert.equal(pending.state.phase, "MIGRATING", "残量があるうちは閉じない");

  const done = senderStep(pending.state, { kind: "staleBacklog", bytes: 0 }, 170);
  assert.equal(done.state.phase, "STEADY");
  assert.equal(done.state.epoch, 2, "新しい epoch へ確定する");
  assert.deepEqual(done.commands.map((c) => c.kind), ["disconnect"]);
});

test("表 4 行目: 時限内にフレームが来なければ新接続を閉じて報告する", () => {
  const dual = senderStep(announced(), { kind: "epochChange", epoch: 2, assignmentChanged: true }, 100).state;
  const early = senderStep(dual, { kind: "timer" }, 100 + EPOCH_DUAL_SUBSCRIBE_TIMEOUT_MS - 1);
  assert.equal(early.state.phase, "DUAL_SUBSCRIBE", "時限前は待つ");

  const expired = senderStep(dual, { kind: "timer" }, 100 + EPOCH_DUAL_SUBSCRIBE_TIMEOUT_MS);
  assert.equal(expired.state.phase, "STEADY");
  const notify = expired.commands.filter((c) => c.kind === "notify");
  assert.equal(notify.length, 1);
  assert.equal(notify[0]?.kind === "notify" ? notify[0].code : "", "E_EPOCH_STALE");
  assert.ok(expired.commands.some((c) => c.kind === "disconnect" && c.peer === SHARD_PEER_NEXT));
});

test("epoch は後退しない", () => {
  const result = senderStep(announced(), { kind: "epochChange", epoch: 1, assignmentChanged: true }, 100);
  assert.equal(result.state.phase, "STEADY");
  assert.deepEqual(result.state.unexpectedEvents, ["epochChange"]);
});

test("同じ入力列を 2 回流すと同じ出力になる（決定性）", () => {
  const run = (): readonly SenderCommand[] => {
    let state = initialSenderState(1);
    const collected: SenderCommand[] = [];
    const events = [
      { kind: "streamAnnounce" as const, ch: CHANNEL_VIDEO, sid: 3, framerate: FPS },
      { kind: "media" as const, ch: CHANNEL_VIDEO, sid: 3, tid: 2, seq: 1, bytes: 40_000, flags: 0b1010 },
      { kind: "epochChange" as const, epoch: 2, assignmentChanged: true },
      { kind: "media" as const, ch: CHANNEL_VIDEO, sid: 3, tid: 2, seq: 2, bytes: 40_000, flags: 0b1010 },
      { kind: "newEpochFrame" as const },
      { kind: "staleBacklog" as const, bytes: 0 },
    ];
    let t = 0;
    for (const event of events) {
      t += 10;
      const result = senderStep(state, event, t);
      state = result.state;
      collected.push(...result.commands);
    }
    return collected;
  };
  assert.deepEqual(run(), run());
});
