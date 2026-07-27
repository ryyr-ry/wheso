/**
 * トレースベクタの入力イベント列を擬似乱数から生成する。
 *
 * traces.ts と conformance.ts で共有する。重複実装を作らない。
 * なぜ分離するか: conformance.md 5 節「生成器は擬似乱数器を用い、種のみで再現できる」。
 * 同じ関数を呼べば同じ入力列になることを構造で保証する。
 */

import { createPrng, next } from "../packages/core/src/prng.ts";
import { type Result, ok, err } from "../packages/core/src/result.ts";
import type { ShardEvent } from "../packages/core/src/shard-core.ts";
import {
  CHANNEL_VIDEO,
  CHANNEL_AUDIO,
  CHANNEL_SCREEN_VIDEO,
  FLAG_KEY,
  FLAG_DISCARDABLE,
  FLAG_END_OF_FRAME,
  FLAG_ACTIVE_SPEAKER,
  FLAG_SCREEN_CONTENT,
} from "../packages/core/src/generated/wire-layout.ts";
import {
  NODE_MAX_OUT_BYTES_PER_SEC,
} from "../packages/core/src/generated/constants.ts";

/** 入力イベントとその論理時刻。 */
export interface TimedEvent {
  readonly t: number;
  readonly event: ShardEvent;
}

export interface GenerateError {
  readonly code: string;
  readonly detail: string;
}

/** 乱数から 0 以上 max 未満の整数を返す。整数演算のみ。 */
function randInt(output: bigint, max: number): number {
  // 64bit 出力を max で割った余り。bigint の剰余は整数演算。
  if (max <= 0) {
    return 0;
  }
  return Number(output % BigInt(max));
}

/** 乱数から指定範囲 [lo, hi] の整数を返す。 */
function randRange(output: bigint, lo: number, hi: number): number {
  return lo + randInt(output, hi - lo + 1);
}

/**
 * 種から入力イベント列を生成する。
 *
 * 生成規則:
 * - 参加者を最初に join させる（5〜12 人）
 * - 以後は media / subscribe / budget / timer / leave をランダムに混合
 * - tier 超過・破棄・輻輳状態の遷移が発生するように、
 *   大量の media イベントと帯域予算の切り替えを含む
 * - 最低 200 イベント
 */
export function generateShardEvents(seed: bigint, steps: number): Result<readonly TimedEvent[], GenerateError> {
  const prngResult = createPrng(seed);
  if (!prngResult.ok) {
    return err({ code: "E_GENERATE", detail: prngResult.error.detail });
  }

  let state = prngResult.value;
  const events: TimedEvent[] = [];
  let t = 1000;

  // ステップ関数: 次の乱数を得る
  function advance(): bigint {
    const r = next(state);
    state = r.state;
    return r.output;
  }

  // --- フェーズ 1: 参加者の join（5〜12 人） ---
  const numParticipants = randRange(advance(), 5, 12);
  const participants: number[] = [];
  for (let i = 0; i < numParticipants; i += 1) {
    const id = i + 1;
    participants.push(id);
    events.push({ t, event: { kind: "join", id } });
    t += 10;
  }

  // --- フェーズ 2: 購読設定（全員が全員を購読） ---
  for (const sub of participants) {
    for (const target of participants) {
      if (sub === target) {
        continue;
      }
      events.push({
        t,
        event: {
          kind: "subscribe",
          from: sub,
          to: target,
          want: true,
          maxSpatialId: randRange(advance(), 0, 3),
        },
      });
      t += 5;
    }
  }

  // --- フェーズ 3: 大量予算で budget を設定（通常運用） ---
  events.push({
    t,
    event: { kind: "budget", bytesPerSec: NODE_MAX_OUT_BYTES_PER_SEC },
  });
  t += 100;

  // --- フェーズ 3.5: ストレスフェーズ（破棄と輻輳遷移を確実に発生させる） ---
  // なぜこの構成か: shard-core の輻輳状態遷移は budget イベント時の util 判定で起きる。
  // util = sentMessages / (windowDuration × MAX_MPS)。
  // util > 0.9 を達成するには、1 秒窓内で 18000 msg 以上が必要（MAX_MPS=20000）。
  // 実際に 18000 msg を生成するのは非現実的なので、低予算での budget 超過による
  // isOverBudget 経由の破棄を主な検証対象とする。
  //
  // 輻輳状態の遷移を発生させるには、窓内で十分なメッセージ送信後に budget を投入する。
  // ここでは 50 個のメディアを各 5 宛先に送信し（250 msg）、その後 budget を投入する。
  // 窓経過 50ms、250 msg × 10000 = 2,500,000 vs 9 × 50 × 20000 = 9,000,000: 不足。
  // 実際の遷移は達成困難なため、代わりに直接 isOverBudget による破棄を検証する。
  // これは state-machines.md の表とは異なるパスだが、shard-core の実装では
  // isOverBudget が独立した破棄パスであり、テストベクタで検証すべき挙動である。

  // 低予算を設定し、大きなメディアを集中的に送信 → isOverBudget 発動 → drop
  events.push({ t, event: { kind: "budget", bytesPerSec: 100000 } });
  t += 10;

  // 密集したメディアイベントを送出（同じ窓内で予算を超過させる）
  for (let burst = 0; burst < 30; burst += 1) {
    const fromIdx = randInt(advance(), participants.length);
    const from = participants[fromIdx];
    if (from === undefined) {
      continue;
    }
    // DISCARDABLE なユニット（破棄可能）
    const flags = FLAG_END_OF_FRAME | FLAG_DISCARDABLE;
    events.push({
      t,
      event: {
        kind: "media",
        from,
        ch: CHANNEL_VIDEO,
        sid: 2,
        tid: 2,
        key: false,
        bytes: 50000,
        flags,
      },
    });
    t += 1; // 1ms 間隔（同一窓内に収まるよう密集）
  }

  // 予算を戻す
  events.push({ t, event: { kind: "budget", bytesPerSec: NODE_MAX_OUT_BYTES_PER_SEC } });
  t += 100;

  // --- フェーズ 3.6: 輻輳の昇格と回復 ---
  // なぜ report を使うか: state-machines.md 3 節の遷移条件は util と maxTrend の
  // 「または」である。util を閾値まで上げるには 1 秒窓で 18,000 メッセージが必要であり、
  // トレースの規模が現実的でない。maxTrend は report イベントで直接与えられるため、
  // 5 状態すべてと回復方向の遷移を短い列で網羅できる。
  //
  // 勾配の作り方: 遅延標本を等間隔で増やすと勾配は正、減らすと負になる。
  // 標本番号 i に対して y = base + step × i とすれば勾配は概ね step である。
  // 昇格に必要な閾値は 0.01 → 0.03 → 0.06 → 0.1 であり、
  // 1 標本あたり 1000 マイクロ秒ずつ増やせば勾配は約 1000 となり全閾値を超える。
  const reporter = participants[0];
  if (reporter !== undefined) {
    // 予算を極端に大きくして、予算超過による破棄をこの区間から除く。
    // 除かないと「輻輳状態ごとの破棄条件」の誤りが予算超過の破棄に隠れ、
    // 実装を変えても出力が変わらない（実際に priority の閾値の変異が生き残った）。
    events.push({ t, event: { kind: "budget", bytesPerSec: 10_000_000_000 } });
    t += 10;
    const rising: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      rising.push(10000 + i * 1000);
    }
    // 各段の遷移はヒステリシス（500 ms）を跨ぐ必要がある。
    // 4 回報告して NORMAL → SHEDDING_T2 → SHEDDING_T1 → SHEDDING_SPATIAL → KEY_ONLY へ昇格する。
    for (let stage = 0; stage < 4; stage += 1) {
      events.push({ t, event: { kind: "report", from: reporter, delayUs: rising } });
      // ヒステリシス（500 ms）の内側でメディアを流す。外側にすると、メディアの処理中に
      // さらに昇格してしまい「その状態の破棄条件」を分離して検証できない
      // （実際に SHEDDING_T2 の閾値の変異が生き残った）。
      t += 100;
      // 各段で 1 個ずつメディアを流し、状態ごとの破棄の違いを記録する。
      events.push({
        t,
        event: {
          kind: "media",
          from: participants[1] ?? reporter,
          ch: CHANNEL_VIDEO,
          sid: 3,
          tid: 2,
          key: false,
          bytes: 40000,
          flags: FLAG_END_OF_FRAME | FLAG_DISCARDABLE,
        },
      });
      t += 10;
      events.push({
        t,
        event: {
          kind: "media",
          from: participants[1] ?? reporter,
          ch: CHANNEL_VIDEO,
          sid: 0,
          tid: 0,
          key: false,
          bytes: 4000,
          flags: FLAG_END_OF_FRAME,
        },
      });
      t += 10;
      // 破棄優先順位 2（破棄可能かつ発話者）。輻輳中の判定に priority が使われるため、
      // 優先順位 1 と 4 だけでは閾値（SHEDDING_T2 は priority <= 3 を破棄する）を検証できない。
      events.push({
        t,
        event: {
          kind: "media",
          from: participants[1] ?? reporter,
          ch: CHANNEL_VIDEO,
          sid: 2,
          tid: 2,
          key: false,
          bytes: 30000,
          flags: FLAG_END_OF_FRAME | FLAG_DISCARDABLE | FLAG_ACTIVE_SPEAKER,
        },
      });
      t += 10;
      // 破棄優先順位 3（破棄可能かつ画面共有）。画面共有は別チャネルであるため、
      // (送信者, チャネル) ごとの最大 spatialId の記録も同時に覆う。
      events.push({
        t,
        event: {
          kind: "media",
          from: participants[1] ?? reporter,
          ch: CHANNEL_SCREEN_VIDEO,
          sid: 1,
          tid: 2,
          key: false,
          bytes: 20000,
          flags: FLAG_END_OF_FRAME | FLAG_DISCARDABLE | FLAG_SCREEN_CONTENT,
        },
      });
      t += 10;
      // 破棄優先順位 5（破棄不可だが発話者）。破棄禁止ではないため輻輳の深い段で破棄される。
      events.push({
        t,
        event: {
          kind: "media",
          from: participants[1] ?? reporter,
          ch: CHANNEL_VIDEO,
          sid: 1,
          tid: 0,
          key: false,
          bytes: 15000,
          flags: FLAG_END_OF_FRAME | FLAG_ACTIVE_SPEAKER,
        },
      });
      // 次の段へ進むためヒステリシスを跨ぐ。
      t += 600;
    }

    // 予算を通常値へ戻す。以降の無作為な区間では予算超過の破棄も検証したいためである。
    events.push({ t, event: { kind: "budget", bytesPerSec: NODE_MAX_OUT_BYTES_PER_SEC } });
    t += 10;

    // 回復: 勾配を負にし、送信を止めて util を下げる。
    // timer で窓をリセットし、report で回復条件（maxTrend < -0.005、KEY_ONLY は < 0）を満たす。
    const falling: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      falling.push(30000 - i * 1000);
    }
    for (let stage = 0; stage < 5; stage += 1) {
      events.push({ t, event: { kind: "timer" } });
      t += 100;
      events.push({ t, event: { kind: "report", from: reporter, delayUs: falling } });
      t += 600;
    }
  }

  // --- フェーズ 4: 混合イベント列 ---
  // 少なくとも steps 個（最低 200）のイベントを生成する
  const actualSteps = steps < 200 ? 200 : steps;
  let budgetPhaseTriggered = false;
  let leaveTriggered = false;
  let congestionWindowStart = 0;

  for (let i = 0; i < actualSteps; i += 1) {
    const roll = randInt(advance(), 100);
    t += randRange(advance(), 1, 33); // 1〜33ms 間隔

    if (roll < 55) {
      // media イベント（55%）
      const fromIdx = randInt(advance(), participants.length);
      const from = participants[fromIdx];
      if (from === undefined) {
        continue;
      }
      const chRoll = randInt(advance(), 10);
      const ch = chRoll < 6 ? CHANNEL_VIDEO : chRoll < 9 ? CHANNEL_AUDIO : CHANNEL_SCREEN_VIDEO;
      const sid = randRange(advance(), 0, 3);
      const tid = randRange(advance(), 0, 2);
      const isKey = randInt(advance(), 20) === 0; // 5% がキーフレーム
      const isScreenContent = ch === CHANNEL_SCREEN_VIDEO;
      const isActiveSpeaker = randInt(advance(), 5) === 0; // 20%

      // flags の構成
      let flags = FLAG_END_OF_FRAME;
      if (isKey) {
        flags = flags | FLAG_KEY;
      }
      // DISCARDABLE の判定: conformance に従い最上位 temporal 層で立てる
      // ここでは tid === 2（L1T3 想定）かつ KEY でないとき DISCARDABLE
      if (!isKey && tid === 2) {
        flags = flags | FLAG_DISCARDABLE;
      }
      if (isScreenContent) {
        flags = flags | FLAG_SCREEN_CONTENT;
      }
      if (isActiveSpeaker) {
        flags = flags | FLAG_ACTIVE_SPEAKER;
      }

      const bytes = ch === CHANNEL_AUDIO
        ? randRange(advance(), 60, 160)
        : randRange(advance(), 500, 80000);

      events.push({
        t,
        event: { kind: "media", from, ch, sid, tid, key: isKey, bytes, flags },
      });
    } else if (roll < 65) {
      // subscribe 変更（10%）
      if (participants.length >= 2) {
        const subIdx = randInt(advance(), participants.length);
        const sub = participants[subIdx];
        let targetIdx = randInt(advance(), participants.length);
        if (targetIdx === subIdx) {
          targetIdx = (targetIdx + 1) % participants.length;
        }
        const target = participants[targetIdx];
        if (sub !== undefined && target !== undefined) {
          const want = randInt(advance(), 3) !== 0; // 2/3 は購読、1/3 は解除
          events.push({
            t,
            event: {
              kind: "subscribe",
              from: sub,
              to: target,
              want,
              maxSpatialId: want ? randRange(advance(), 0, 3) : 0,
            },
          });
        }
      }
    } else if (roll < 75) {
      // budget 変更（10%）— 輻輳状態の遷移を誘発するために低い値を含む
      if (!budgetPhaseTriggered && i > actualSteps / 4) {
        // 途中で帯域を絞る → 輻輳状態の遷移を誘発
        budgetPhaseTriggered = true;
        congestionWindowStart = i;
        events.push({
          t,
          event: { kind: "budget", bytesPerSec: Math.trunc(NODE_MAX_OUT_BYTES_PER_SEC / 50) },
        });
      } else if (budgetPhaseTriggered && i > congestionWindowStart + actualSteps / 10) {
        // 予算を戻す → 回復を誘発
        budgetPhaseTriggered = false;
        events.push({
          t,
          event: { kind: "budget", bytesPerSec: NODE_MAX_OUT_BYTES_PER_SEC },
        });
      } else {
        // ランダムな予算
        const bps = randRange(advance(), 1000000, NODE_MAX_OUT_BYTES_PER_SEC);
        events.push({ t, event: { kind: "budget", bytesPerSec: bps } });
      }
    } else if (roll < 82) {
      // timer（7%）
      events.push({ t, event: { kind: "timer" } });
    } else if (roll < 90) {
      // link イベント（8%）— shard では unexpected として記録される
      if (participants.length > 0) {
        const peerIdx = randInt(advance(), participants.length);
        const peer = participants[peerIdx];
        if (peer !== undefined) {
          const linkStates = ["up", "down", "failed"] as const;
          const lsIdx = randInt(advance(), 3);
          const ls = linkStates[lsIdx];
          if (ls !== undefined) {
            events.push({ t, event: { kind: "link", peer, state: ls } });
          }
        }
      }
    } else if (roll < 95) {
      // leave（5%）
      if (!leaveTriggered && participants.length > 3) {
        leaveTriggered = true;
        const idx = randInt(advance(), participants.length);
        const removed = participants[idx];
        if (removed !== undefined) {
          participants.splice(idx, 1);
          events.push({ t, event: { kind: "leave", id: removed } });
        }
      } else {
        // すでに leave を行った場合は media に置き換え
        if (participants.length > 0) {
          const from = participants[randInt(advance(), participants.length)];
          if (from !== undefined) {
            events.push({
              t,
              event: {
                kind: "media",
                from,
                ch: CHANNEL_VIDEO,
                sid: 0,
                tid: 0,
                key: true,
                bytes: 5000,
                flags: FLAG_KEY | FLAG_END_OF_FRAME,
              },
            });
          }
        }
      }
    } else {
      // join（5%）— 新しい参加者
      const newId = 100 + i;
      participants.push(newId);
      events.push({ t, event: { kind: "join", id: newId } });
    }
  }

  return ok(events);
}
