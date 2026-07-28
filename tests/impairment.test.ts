/**
 * 劣化プロファイル（段 D）の定義と段の選択の試験。
 *
 * ここで確かめるのは「定義が受入条件と食い違っていないこと」と「時刻から段を選ぶ規則が
 * 正しいこと」である。劣化が**実際に効いているか**は OS の qdisc を触る必要があるため、
 * `node tools/impair.ts selftest` が担い、CI の impair ジョブが実行する。
 *
 * 定義を試験する理由: プロファイルが誤っていても劣化試験は緑になる。たとえば N-4 の遅延を
 * 0 にすると netem の再順序は働かないが、試験は「再順序下でも動いた」と報告してしまう。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  IMPAIRMENT_DURATION_SEC,
  IMPAIRMENT_PROFILES,
} from "../packages/core/src/generated/impairment.ts";
import { profileById, stepAt } from "../tools/impair.ts";

test("受入条件の 8 プロファイルが揃っている", () => {
  const ids = IMPAIRMENT_PROFILES.map((profile) => profile.id);
  assert.deepEqual(ids, ["N-0", "N-1", "N-2", "N-3", "N-4", "N-5", "N-6", "N-7"]);
  for (const profile of IMPAIRMENT_PROFILES) {
    assert.ok(profile.note.length > 0, `${profile.id} に意図が書かれている`);
    assert.ok(profile.steps.length > 0, `${profile.id} に段がある`);
  }
});

test("段は時刻の昇順で、試験の長さの内側にある", () => {
  for (const profile of IMPAIRMENT_PROFILES) {
    let previous = -1;
    for (const step of profile.steps) {
      assert.ok(step.atSec > previous, `${profile.id} の段が昇順である（${String(step.atSec)}）`);
      assert.ok(
        step.atSec < IMPAIRMENT_DURATION_SEC,
        `${profile.id} の段が ${String(IMPAIRMENT_DURATION_SEC)} 秒の内側にある`,
      );
      previous = step.atSec;
    }
    assert.equal(profile.steps[0]?.atSec, 0, `${profile.id} は 0 秒から始まる`);
  }
});

test("N-0 は劣化なしである（基準になる）", () => {
  const profile = profileById("N-0");
  assert.ok(profile !== undefined);
  const step = profile.steps[0];
  assert.ok(step !== undefined);
  assert.equal(step.rateKbit, 0, "帯域制限が無い");
  assert.equal(step.delayMs, 0, "遅延が無い");
  assert.equal(step.jitterMs, 0, "ジッタが無い");
  assert.equal(step.reorderPercent, 0, "再順序が無い");
  assert.equal(step.duplicatePercent, 0, "重複が無い");
});

test("N-4 は再順序に必要な遅延を伴う", () => {
  // netem の reorder は遅延が 0 だと働かない。ここを取り違えると、再順序を検証したつもりで
  // 何も起きていない試験になる。
  const profile = profileById("N-4");
  assert.ok(profile !== undefined);
  const step = profile.steps[0];
  assert.ok(step !== undefined);
  assert.ok(step.reorderPercent > 0, "再順序が設定されている");
  assert.ok(step.delayMs > 0, "再順序に必要な遅延が設定されている");
  assert.ok(step.duplicatePercent > 0, "重複が設定されている");
});

test("N-5 は周期的な遮断を持つ", () => {
  const profile = profileById("N-5");
  assert.ok(profile !== undefined);
  assert.ok(profile.outage !== undefined, "遮断の定義がある");
  assert.ok(profile.outage.everySec > 0, "周期が正である");
  assert.ok(profile.outage.durationMs > 0, "遮断の長さが正である");
  assert.ok(
    profile.outage.everySec < IMPAIRMENT_DURATION_SEC,
    "試験の長さの中で少なくとも 1 回起きる",
  );
});

test("N-2 は降下してから元の帯域へ戻る", () => {
  const profile = profileById("N-2");
  assert.ok(profile !== undefined);
  const rates = profile.steps.map((step) => step.rateKbit);
  const first = rates[0];
  const last = rates[rates.length - 1];
  assert.ok(first !== undefined && last !== undefined);
  assert.equal(last, first, "復帰後の帯域が降下前と同じである（判定 C-3 の前提）");
  assert.ok(Math.min(...rates) < first, "途中で降下している");
});

test("N-6 は単調に降下する", () => {
  const profile = profileById("N-6");
  assert.ok(profile !== undefined);
  const rates = profile.steps.map((step) => step.rateKbit);
  for (let index = 1; index < rates.length; index += 1) {
    const previous = rates[index - 1];
    const current = rates[index];
    assert.ok(previous !== undefined && current !== undefined);
    assert.ok(current < previous, `${String(index)} 段目が前より低い`);
  }
});

test("N-7 は送信側だけを劣化させる", () => {
  const profile = profileById("N-7");
  assert.ok(profile !== undefined);
  assert.equal(profile.egressOnly, true, "上りのみの劣化である");
});

test("時刻から段を選ぶ規則が正しい", () => {
  const profile = profileById("N-2");
  assert.ok(profile !== undefined);
  // 0 秒では最初の段。段の境界では新しい段。境界の直前では前の段。
  assert.equal(stepAt(profile, 0)?.atSec, 0);
  assert.equal(stepAt(profile, 9)?.atSec, 0);
  assert.equal(stepAt(profile, 10)?.atSec, 10);
  assert.equal(stepAt(profile, 14)?.atSec, 10);
  assert.equal(stepAt(profile, 15)?.atSec, 15);
  assert.equal(stepAt(profile, 59)?.atSec, 45, "最後の段が試験の終わりまで続く");
});

test("未知のプロファイルは見つからない", () => {
  assert.equal(profileById("N-99"), undefined);
});
