/**
 * デコーダプールと A/V 同期の判断コアの試験。
 *
 * 規範: client-architecture.md 4 節の規則 1・3・4、定数規範 7 節。
 * 判断は純関数であるため、ブラウザ API を使わずに全経路を検査できる。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideDecode,
  initialDecoderPool,
  markDecodeFailure,
  releaseSender,
  releaseStream,
  type DecodeUnit,
} from "../packages/client/src/media/decoder-pool.ts";
import {
  decideVideo,
  forgetSender,
  initialAvSync,
  maxSkewMs,
  noteAudioPlayed,
} from "../packages/client/src/sync/av-sync.ts";
import { AV_SKEW_RESYNC_MS, AV_SKEW_TOLERANCE_MS } from "../packages/core/src/generated/constants.ts";
import { CHANNEL_VIDEO, FLAG_KEY } from "../packages/core/src/generated/wire-layout.ts";

function unit(overrides: Partial<DecodeUnit> = {}): DecodeUnit {
  return {
    senderId: 7,
    channel: CHANNEL_VIDEO,
    spatialId: 1,
    temporalId: 0,
    flags: 0,
    ...overrides,
  };
}

test("最初のキーフレームで設定し復号する", () => {
  const result = decideDecode(initialDecoderPool(4), unit({ flags: FLAG_KEY }));
  assert.deepEqual(
    result.actions.map((action) => action.kind),
    ["configure", "decode"],
  );
  assert.equal(result.state.entries.length, 1);
  assert.equal(result.state.entries[0]?.awaitingKeyframe, false);
});

test("キーフレームより先に delta が来たら設定するが復号しない", () => {
  const result = decideDecode(initialDecoderPool(4), unit());
  assert.deepEqual(
    result.actions.map((action) => action.kind),
    ["configure", "skip"],
  );
  assert.equal(result.state.entries[0]?.awaitingKeyframe, true);

  // 待機中の delta も復号しない。
  const stillWaiting = decideDecode(result.state, unit({ temporalId: 1 }));
  assert.deepEqual(stillWaiting.actions, [{ kind: "skip", reason: "awaitingKeyframe" }]);

  // キーフレームが来たら復号し、待機を解く。
  const resumed = decideDecode(stillWaiting.state, unit({ flags: FLAG_KEY }));
  assert.deepEqual(resumed.actions, [{ kind: "decode", senderId: 7, channel: CHANNEL_VIDEO }]);
  assert.equal(resumed.state.entries[0]?.awaitingKeyframe, false);
});

test("spatialId が変わると初期化してキーフレームを待つ", () => {
  const first = decideDecode(initialDecoderPool(4), unit({ flags: FLAG_KEY }));
  const switched = decideDecode(first.state, unit({ spatialId: 3 }));
  assert.deepEqual(
    switched.actions.map((action) => action.kind),
    ["reset", "skip"],
  );
  assert.equal(switched.state.entries[0]?.spatialId, 3);
  assert.equal(switched.state.entries[0]?.awaitingKeyframe, true);
});

test("temporalId の変化ではデコーダを触らない（規則 4）", () => {
  const first = decideDecode(initialDecoderPool(4), unit({ flags: FLAG_KEY }));
  const same = decideDecode(first.state, unit({ temporalId: 2 }));
  assert.deepEqual(same.actions, [{ kind: "decode", senderId: 7, channel: CHANNEL_VIDEO }]);
  assert.deepEqual(same.state.entries, first.state.entries, "状態は変わらない");
});

test("同時デコード数の上限を超えたら新規を割り当てない", () => {
  let state = initialDecoderPool(2);
  for (const senderId of [1, 2]) {
    state = decideDecode(state, unit({ senderId, flags: FLAG_KEY })).state;
  }
  const rejected = decideDecode(state, unit({ senderId: 3, flags: FLAG_KEY }));
  assert.deepEqual(rejected.actions, [{ kind: "skip", reason: "poolFull" }]);
  assert.equal(rejected.state.entries.length, 2, "既存の復号を壊さない");
  assert.equal(rejected.state.rejected, 1);
});

test("退出とストリーム解除でデコーダを閉じる（規則 1）", () => {
  let state = initialDecoderPool(4);
  state = decideDecode(state, unit({ senderId: 7, channel: 1, flags: FLAG_KEY })).state;
  state = decideDecode(state, unit({ senderId: 7, channel: 2, flags: FLAG_KEY })).state;
  const released = releaseSender(state, 7);
  assert.equal(released.actions.length, 2, "送信者の全ストリームを閉じる");
  assert.equal(released.state.entries.length, 0);

  const single = releaseStream(
    decideDecode(initialDecoderPool(4), unit({ flags: FLAG_KEY })).state,
    7,
    CHANNEL_VIDEO,
  );
  assert.deepEqual(single.actions, [{ kind: "close", senderId: 7, channel: CHANNEL_VIDEO }]);
  assert.equal(releaseSender(initialDecoderPool(4), 99).actions.length, 0, "居ない相手では何もしない");
});

test("復号失敗でキーフレーム待ちへ戻す", () => {
  const first = decideDecode(initialDecoderPool(4), unit({ flags: FLAG_KEY }));
  const failed = markDecodeFailure(first.state, 7, CHANNEL_VIDEO);
  assert.deepEqual(failed.actions, [{ kind: "reset", senderId: 7, channel: CHANNEL_VIDEO, spatialId: 1 }]);
  assert.equal(failed.state.entries[0]?.awaitingKeyframe, true);
  assert.equal(markDecodeFailure(initialDecoderPool(4), 7, CHANNEL_VIDEO).actions.length, 0);
});

test("音声を再生していない送信者の映像はそのまま提示する", () => {
  const result = decideVideo(initialAvSync(), 7, 1_000_000, false);
  assert.equal(result.decision, "present");
  assert.equal(result.skewMs, 0);
});

test("許容内のずれでは補正しない", () => {
  const state = noteAudioPlayed(initialAvSync(), 7, 1_000_000);
  const withinUs = AV_SKEW_TOLERANCE_MS * 1000;
  assert.equal(decideVideo(state, 7, 1_000_000 + withinUs, false).decision, "present");
  assert.equal(decideVideo(state, 7, 1_000_000 - withinUs, false).decision, "present");
});

test("映像が先行すれば保持し、遅れれば捨てる", () => {
  const state = noteAudioPlayed(initialAvSync(), 7, 1_000_000);
  const overUs = (AV_SKEW_TOLERANCE_MS + 1) * 1000;
  const ahead = decideVideo(state, 7, 1_000_000 + overUs, false);
  assert.equal(ahead.decision, "hold");
  assert.equal(ahead.skewMs, AV_SKEW_TOLERANCE_MS + 1);
  const behind = decideVideo(state, 7, 1_000_000 - overUs, false);
  assert.equal(behind.decision, "drop");
  assert.equal(behind.skewMs, -(AV_SKEW_TOLERANCE_MS + 1));
});

test("ずれが再同期の閾値を超えると次のキーフレームまで捨てる", () => {
  const state = noteAudioPlayed(initialAvSync(), 7, 1_000_000);
  const farUs = (AV_SKEW_RESYNC_MS + 1) * 1000;
  const first = decideVideo(state, 7, 1_000_000 + farUs, false);
  assert.equal(first.decision, "resync");
  assert.equal(first.state.entries[0]?.awaitingKeyframe, true);

  // 待機中の delta も捨てる。
  const stillWaiting = decideVideo(first.state, 7, 1_000_000, false);
  assert.equal(stillWaiting.decision, "resync");

  // キーフレームで復帰する。
  const resumed = decideVideo(stillWaiting.state, 7, 1_000_000, true);
  assert.equal(resumed.decision, "present");
  assert.equal(resumed.state.entries[0]?.awaitingKeyframe, false);
});

test("基準時刻は後戻りせず、退出で記録が消える", () => {
  const state = noteAudioPlayed(initialAvSync(), 7, 2_000_000);
  const backwards = noteAudioPlayed(state, 7, 1_000_000);
  assert.equal(backwards.entries[0]?.audioTimestampUs, 2_000_000, "巻き戻さない");
  assert.equal(forgetSender(backwards, 7).entries.length, 0);
});

test("観測用のずれの最大値は絶対値で求める", () => {
  const state = noteAudioPlayed(initialAvSync(), 7, 1_000_000);
  const results = [
    decideVideo(state, 7, 1_000_000 + 30_000, false),
    decideVideo(state, 7, 1_000_000 - 50_000, false),
  ];
  assert.equal(maxSkewMs(results), 50);
  assert.equal(maxSkewMs([]), 0);
});
