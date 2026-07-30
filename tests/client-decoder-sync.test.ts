/**
 * 音声映像の同期は `tests/playout.test.ts` が検証する（ADR-0028 で方式を置き換えた）。
 * 本ファイルはデコーダプールのみを対象とする。
 *
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
  type DecodeUnit,
} from "../packages/client/src/media/decoder-pool.ts";
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

test("復号失敗でキーフレーム待ちへ戻す", () => {
  const first = decideDecode(initialDecoderPool(4), unit({ flags: FLAG_KEY }));
  const failed = markDecodeFailure(first.state, 7, CHANNEL_VIDEO);
  assert.deepEqual(failed.actions, [{ kind: "reset", senderId: 7, channel: CHANNEL_VIDEO, spatialId: 1 }]);
  assert.equal(failed.state.entries[0]?.awaitingKeyframe, true);
  assert.equal(markDecodeFailure(initialDecoderPool(4), 7, CHANNEL_VIDEO).actions.length, 0);
});
