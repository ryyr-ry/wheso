/**
 * トレースベクタの入力イベント列を擬似乱数から生成する。
 *
 * traces.ts と conformance.ts で共有する。重複実装を作らない。
 * なぜ分離するか: conformance.md 5 節「生成器は擬似乱数器を用い、種のみで再現できる」。
 * 同じ関数を呼べば同じ入力列になることを構造で保証する。
 *
 * **段の構成が入力列の網羅を決める。** トレースに現れない入力は検証されない。
 * したがって次をすべて明示的な段として作る（偶然に頼らない）。
 *
 *   1. はしごの申告と、ちょうど 1 段を選ぶ転送（ADR-0027）
 *   2. 送信窓が閉じて破棄が起き、ack で再び開く（congestion.md 2 節）
 *   3. ack が途絶えて転送が止まる（`ACK_TIMEOUT_MS`）
 *   4. **購読者 1 人の劣化が他の購読者へ波及しない**（ADR-0025 の 3・4）
 *   5. 輻輳 5 状態の昇格と回復
 *   6. 音声の選別転送と保持時間の境界（ADR-0024）
 *   7. ノード全体の予算超過の通知（ADR-0025 の 5）
 */

import { createPrng, next } from "../packages/core/src/prng.ts";
import { type Result, ok, err } from "../packages/core/src/result.ts";
import type { LadderRung, ShardEvent } from "../packages/core/src/shard-core.ts";
import {
  CHANNEL_VIDEO,
  CHANNEL_AUDIO,
  CHANNEL_SCREEN_VIDEO,
  FLAG_KEY,
  FLAG_DISCARDABLE,
  FLAG_END_OF_FRAME,
  FLAG_ACTIVE_SPEAKER,
  FLAG_SCREEN_CONTENT,
  MAX_TEMPORAL_ID,
} from "../packages/core/src/generated/wire-layout.ts";
import {
  ACK_TIMEOUT_MS,
  AUDIO_SELECTIVE_FORWARD_COUNT,
  AUDIO_SPEAKER_HOLD_MS,
  NODE_MAX_OUT_BYTES_PER_SEC,
  V_1080P30,
  V_360P15,
  V_4K60,
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
 * ストリームごとの sequenceNumber を管理する。
 *
 * 送信窓の判断は `seq` に依存する（未確認フレーム数 = 送った seq − ack した seq）。
 * したがって同一 (from, ch, sid) 内で単調増加させなければならない。
 * 巻き戻る seq を与えると窓の計算が意味を失い、トレースが検証にならない。
 */
class SequenceBook {
  private readonly counters = new Map<string, number>();

  next(from: number, ch: number, sid: number): number {
    const key = `${String(from)}:${String(ch)}:${String(sid)}`;
    const current = this.counters.get(key) ?? 0;
    const value = current + 1;
    this.counters.set(key, value);
    return value;
  }

  current(from: number, ch: number, sid: number): number {
    const key = `${String(from)}:${String(ch)}:${String(sid)}`;
    return this.counters.get(key) ?? 0;
  }

  /** これまでに 1 個以上流したストリームの一覧。決定的な順序で返す。 */
  streams(): readonly { readonly from: number; readonly ch: number; readonly sid: number }[] {
    const out: { from: number; ch: number; sid: number }[] = [];
    for (const key of [...this.counters.keys()].sort()) {
      const parts = key.split(":");
      const from = Number(parts[0]);
      const ch = Number(parts[1]);
      const sid = Number(parts[2]);
      if (Number.isInteger(from) && Number.isInteger(ch) && Number.isInteger(sid)) {
        out.push({ from, ch, sid });
      }
    }
    return out;
  }
}

/** 代表点のはしご。段番号は密に詰める（0 が最下段。ADR-0026）。 */
function ladderOf(rungCount: number): readonly LadderRung[] {
  const rungs: LadderRung[] = [
    {
      sid: 0,
      width: V_360P15.width,
      height: V_360P15.height,
      framerate: V_360P15.framerate,
      temporalLayers: V_360P15.temporalLayers,
      targetBitrate: V_360P15.targetBitrate,
    },
    {
      sid: 1,
      width: V_1080P30.width,
      height: V_1080P30.height,
      framerate: V_1080P30.framerate,
      temporalLayers: V_1080P30.temporalLayers,
      targetBitrate: V_1080P30.targetBitrate,
    },
    {
      sid: 2,
      width: V_4K60.width,
      height: V_4K60.height,
      framerate: V_4K60.framerate,
      temporalLayers: V_4K60.temporalLayers,
      targetBitrate: V_4K60.targetBitrate,
    },
  ];
  return rungs.slice(0, rungCount < 1 ? 1 : rungCount);
}

/**
 * 種から入力イベント列を生成する。
 *
 * 生成規則は本ファイル冒頭の 7 項目である。最低 200 イベントを生成する。
 */
export function generateShardEvents(seed: bigint, steps: number): Result<readonly TimedEvent[], GenerateError> {
  const prngResult = createPrng(seed);
  if (!prngResult.ok) {
    return err({ code: "E_GENERATE", detail: prngResult.error.detail });
  }

  let state = prngResult.value;
  const events: TimedEvent[] = [];
  const seq = new SequenceBook();
  let t = 1000;

  function advance(): bigint {
    const r = next(state);
    state = r.state;
    return r.output;
  }

  /** メディアのイベントを 1 個積む。seq は自動で進める。 */
  function pushMedia(
    from: number,
    ch: number,
    sid: number,
    tid: number,
    key: boolean,
    bytes: number,
    flags: number,
  ): void {
    events.push({
      t,
      event: {
        kind: "media",
        from,
        ch,
        sid,
        tid,
        key,
        bytes,
        flags,
        seq: seq.next(from, ch, sid),
      },
    });
  }

  /**
   * その送信者のストリームに対する ack を、全購読者ぶん積む。
   *
   * なぜ必要か: 実際の受信ノードは `ACK_INTERVAL_MS`（50 ms）ごとに ack を返す。
   * ack を返さない列だけを記録すると、送信窓が閉じたまま何も転送されない状態しか
   * 検証されない。健全な運用（窓が開き続ける）と異常（窓が閉じる）の両方を記録する。
   */
  function pushAcks(from: number, ch: number, sid: number): void {
    const highestSeq = seq.current(from, ch, sid);
    for (const subscriber of participants) {
      if (subscriber === from) {
        continue;
      }
      events.push({ t, event: { kind: "ack", from: subscriber, to: from, ch, sid, highestSeq } });
    }
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

  // --- フェーズ 2: はしごの申告 ---
  // 段数を送信者ごとに変える（2 段と 3 段）。段数が可変であることを記録する（ADR-0026）。
  const rungCounts = new Map<number, number>();
  for (const id of participants) {
    const count = randInt(advance(), 2) === 0 ? 2 : 3;
    rungCounts.set(id, count);
    events.push({
      t,
      event: { kind: "streamAnnounce", from: id, ch: CHANNEL_VIDEO, rungs: ladderOf(count) },
    });
    t += 5;
  }

  // --- フェーズ 3: 購読設定（全員が全員の映像と音声を購読） ---
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
          ch: CHANNEL_VIDEO,
          want: true,
          // 最上段より高い段を要求する場合を含める（安全弁の記録。ADR-0027 の 5）。
          maxSpatialId: randRange(advance(), 0, 3),
          maxTemporalId: MAX_TEMPORAL_ID,
        },
      });
      t += 3;
      events.push({
        t,
        event: {
          kind: "subscribe",
          from: sub,
          to: target,
          ch: CHANNEL_AUDIO,
          want: true,
          maxSpatialId: 0,
          maxTemporalId: 0,
        },
      });
      t += 2;
    }
  }

  events.push({ t, event: { kind: "budget", bytesPerSec: NODE_MAX_OUT_BYTES_PER_SEC } });
  t += 100;

  // --- フェーズ 4: 段の選択（ADR-0027 の 3） ---
  //
  // 送信者が持つ全段を順に流す。購読者ごとに**ちょうど 1 段**だけが転送されることを記録する。
  // `spatialId <= tier` で転送する誤り（同じ内容が二重に届き、デコーダが reset を繰り返す）は
  // この段で検出される。
  const ladderSender = participants[0];
  if (ladderSender !== undefined) {
    const count = rungCounts.get(ladderSender) ?? 2;
    for (let round = 0; round < 3; round += 1) {
      for (let sid = 0; sid < count; sid += 1) {
        pushMedia(ladderSender, CHANNEL_VIDEO, sid, 0, round === 0, 20000, FLAG_END_OF_FRAME);
        t += 4;
        pushAcks(ladderSender, CHANNEL_VIDEO, sid);
        t += 1;
      }
    }
    // はしごが縮む場合（発熱で段を減らした、カメラを切り替えた）。
    // 古い段を要求している購読者にも、存在する段が渡ることを記録する（安全弁）。
    events.push({
      t,
      event: { kind: "streamAnnounce", from: ladderSender, ch: CHANNEL_VIDEO, rungs: ladderOf(1) },
    });
    t += 10;
    pushMedia(ladderSender, CHANNEL_VIDEO, 0, 0, true, 8000, FLAG_KEY | FLAG_END_OF_FRAME);
    t += 10;
    // 元のはしごへ戻す。
    events.push({
      t,
      event: { kind: "streamAnnounce", from: ladderSender, ch: CHANNEL_VIDEO, rungs: ladderOf(count) },
    });
    t += 10;
  }

  // --- フェーズ 5: 送信窓（congestion.md 2 節） ---
  //
  // ack を返さずに送り続けると、未確認の再生時間が SEND_WINDOW_MS を超えて窓が閉じる。
  // 閉じている間、破棄可能なユニットは渡されない。破棄禁止（KEY・音声）は渡る。
  // ack を返すと窓が開き、再び渡るようになる。
  const windowSender = participants[1];
  const windowSubscriber = participants[2];
  if (windowSender !== undefined && windowSubscriber !== undefined) {
    // この購読だけを最下段に固定する。段の選択と窓の判定を分離して記録するためである。
    events.push({
      t,
      event: {
        kind: "subscribe",
        from: windowSubscriber,
        to: windowSender,
        ch: CHANNEL_VIDEO,
        want: true,
        maxSpatialId: 0,
        maxTemporalId: MAX_TEMPORAL_ID,
      },
    });
    t += 10;
    // 最下段は 15 fps であるため、SEND_WINDOW_MS（200 ms）は 3 フレーム分に相当する。
    // 未確認が 4 フレームを超えると窓が閉じる。10 枚流して境界の前後を記録する。
    for (let i = 0; i < 10; i += 1) {
      pushMedia(windowSender, CHANNEL_VIDEO, 0, 1, false, 3000, FLAG_END_OF_FRAME | FLAG_DISCARDABLE);
      t += 5;
    }
    // 破棄禁止のユニットは窓が閉じていても渡る。
    pushMedia(windowSender, CHANNEL_VIDEO, 0, 0, true, 9000, FLAG_KEY | FLAG_END_OF_FRAME);
    t += 5;
    // ack を返して窓を開ける。
    events.push({
      t,
      event: {
        kind: "ack",
        from: windowSubscriber,
        to: windowSender,
        ch: CHANNEL_VIDEO,
        sid: 0,
        highestSeq: seq.current(windowSender, CHANNEL_VIDEO, 0),
      },
    });
    t += 10;
    for (let i = 0; i < 3; i += 1) {
      pushMedia(windowSender, CHANNEL_VIDEO, 0, 1, false, 3000, FLAG_END_OF_FRAME | FLAG_DISCARDABLE);
      t += 5;
    }
    // 後戻りする ack は無視される（重複した ack が届くことはある）。
    events.push({
      t,
      event: {
        kind: "ack",
        from: windowSubscriber,
        to: windowSender,
        ch: CHANNEL_VIDEO,
        sid: 0,
        highestSeq: 1,
      },
    });
    t += 10;
    // 存在しない購読への ack は表に無い入力である。記録して無視する。
    events.push({
      t,
      event: { kind: "ack", from: 9999, to: windowSender, ch: CHANNEL_VIDEO, sid: 0, highestSeq: 5 },
    });
    t += 10;
  }

  // --- フェーズ 6: 購読者 1 人の劣化が波及しない（ADR-0025 の 3・4） ---
  //
  // **これが SFU として成立していることの本質である。** 1 人の受信者の遅延勾配だけを
  // 悪化させ、他の購読者の輻輳状態が NORMAL のままであることを記録する。
  const badSubscriber = participants[3];
  const goodSubscriber = participants[4];
  const sharedSender = participants[0];
  if (badSubscriber !== undefined && goodSubscriber !== undefined && sharedSender !== undefined) {
    const rising: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      rising.push(10000 + i * 60000);
    }
    // 悪い購読者だけが報告する。
    events.push({ t, event: { kind: "report", from: badSubscriber, delayUs: rising } });
    t += 600;
    // 同じ送信者のメディアを流す。悪い購読者への転送だけが落ちる。
    for (let i = 0; i < 4; i += 1) {
      pushMedia(sharedSender, CHANNEL_VIDEO, 0, 2, false, 12000, FLAG_END_OF_FRAME | FLAG_DISCARDABLE);
      t += 8;
      pushAcks(sharedSender, CHANNEL_VIDEO, 0);
      t += 2;
    }
    // 良い購読者も報告するが、勾配は平坦である（劣化しない）。
    const flat: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      flat.push(20000);
    }
    events.push({ t, event: { kind: "report", from: goodSubscriber, delayUs: flat } });
    t += 3;
    // キーフレーム要求（ADR-0039）。購読している相手には通り、していない相手は無視される。
    events.push({
      t,
      event: { kind: "keyframeRequest", from: goodSubscriber, target: sharedSender, ch: CHANNEL_VIDEO, sid: 0 },
    });
    t += 3;
    events.push({
      t,
      event: { kind: "keyframeRequest", from: goodSubscriber, target: 999, ch: CHANNEL_VIDEO, sid: 0 },
    });
    t += 600;
    for (let i = 0; i < 4; i += 1) {
      pushMedia(sharedSender, CHANNEL_VIDEO, 0, 2, false, 12000, FLAG_END_OF_FRAME | FLAG_DISCARDABLE);
      t += 8;
      pushAcks(sharedSender, CHANNEL_VIDEO, 0);
      t += 2;
    }
  }

  // --- フェーズ 7: 輻輳 5 状態の昇格と回復 ---
  //
  // 昇格の条件は「窓の充填率が閾値を超える」または「その購読者の勾配が閾値を超える」である。
  // 勾配は report で直接与えられるため、5 状態すべてを短い列で網羅できる。
  const reporter = participants[3];
  const observed = participants[1];
  if (reporter !== undefined && observed !== undefined) {
    const rising: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      rising.push(10000 + i * 60000);
    }
    for (let stage = 0; stage < 4; stage += 1) {
      events.push({ t, event: { kind: "report", from: reporter, delayUs: rising } });
      // ヒステリシス（500 ms）の内側でメディアを流す。外側にすると、処理中にさらに昇格して
      // 「その状態の破棄条件」を分離して検証できない。
      t += 100;
      // 破棄優先順位 1（破棄可能・発話者でない・画面共有でない）。
      pushMedia(observed, CHANNEL_VIDEO, 0, 2, false, 40000, FLAG_END_OF_FRAME | FLAG_DISCARDABLE);
      t += 10;
      // 破棄優先順位 4（破棄不可・KEY でない・発話者でない）。
      pushMedia(observed, CHANNEL_VIDEO, 0, 0, false, 4000, FLAG_END_OF_FRAME);
      t += 10;
      // 破棄優先順位 2（破棄可能かつ発話者）。SHEDDING_T2 の閾値（priority <= 3）の検証に必要。
      pushMedia(
        observed,
        CHANNEL_VIDEO,
        0,
        2,
        false,
        30000,
        FLAG_END_OF_FRAME | FLAG_DISCARDABLE | FLAG_ACTIVE_SPEAKER,
      );
      t += 10;
      // 破棄優先順位 3（破棄可能かつ画面共有）。別チャネルであるため、チャネルごとの
      // はしごと購読の分離も同時に覆う。
      pushMedia(
        observed,
        CHANNEL_SCREEN_VIDEO,
        0,
        2,
        false,
        20000,
        FLAG_END_OF_FRAME | FLAG_DISCARDABLE | FLAG_SCREEN_CONTENT,
      );
      t += 10;
      // 破棄優先順位 5（破棄不可だが発話者）。輻輳の深い段で破棄される。
      pushMedia(observed, CHANNEL_VIDEO, 0, 0, false, 15000, FLAG_END_OF_FRAME | FLAG_ACTIVE_SPEAKER);
      t += 10;
      // KEY は輻輳のどの段でも破棄しない。
      pushMedia(observed, CHANNEL_VIDEO, 0, 0, true, 50000, FLAG_KEY | FLAG_END_OF_FRAME);
      t += 10;
      // 窓を開けたままにする。窓の閉塞と輻輳状態の破棄条件を分離して記録するためである。
      pushAcks(observed, CHANNEL_VIDEO, 0);
      pushAcks(observed, CHANNEL_SCREEN_VIDEO, 0);
      // 次の段へ進むためヒステリシスを跨ぐ。
      t += 600;
    }

    // 回復。勾配を負にして 5 回報告する（KEY_ONLY の回復条件は他より厳しい）。
    const falling: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      falling.push(1_200_000 - i * 60000);
    }
    for (let stage = 0; stage < 5; stage += 1) {
      events.push({ t, event: { kind: "timer" } });
      t += 100;
      events.push({ t, event: { kind: "report", from: reporter, delayUs: falling } });
      t += 600;
    }
  }

  // --- フェーズ 8: 音声の選別転送（ADR-0024） ---
  //
  // **音声にも ack を返す。** 実際の受信ノードは受信した全ストリーム（映像も音声も）
  // について ack を返す（`receiver-core` は `received` の全件を返す）。返さないと
  // `ACK_TIMEOUT_MS` で音声の購読が止まり、以後の音声が 1 通も転送されない。
  // これを忘れたため、音声の選別転送がトレースで検証されない状態になっていた（実測）。
  {
    const speakers = participants.slice(0, Math.min(participants.length, AUDIO_SELECTIVE_FORWARD_COUNT + 3));
    // 順に発話する（時刻が異なるため順位が一意に決まる）。
    for (const id of speakers) {
      pushMedia(id, CHANNEL_AUDIO, 0, 0, false, 160, FLAG_END_OF_FRAME | FLAG_ACTIVE_SPEAKER);
      t += 20;
      pushAcks(id, CHANNEL_AUDIO, 0);
      t += 1;
    }
    // 発話を止めた音声を全員ぶん流す。上限を超えた分（古い発話者）が破棄される。
    for (const id of speakers) {
      pushMedia(id, CHANNEL_AUDIO, 0, 0, false, 160, FLAG_END_OF_FRAME);
      t += 5;
      pushAcks(id, CHANNEL_AUDIO, 0);
      t += 1;
    }
    // 保持時間を跨ぐ。候補が消えるため、同じ音声が今度は通る（境界の記録）。
    t += AUDIO_SPEAKER_HOLD_MS + 50;
    for (const id of speakers) {
      pushMedia(id, CHANNEL_AUDIO, 0, 0, false, 160, FLAG_END_OF_FRAME);
      t += 5;
    }
    // 同時刻の発話（senderId の昇順で選ぶことの記録）。
    for (const id of speakers) {
      pushMedia(id, CHANNEL_AUDIO, 0, 0, false, 160, FLAG_END_OF_FRAME | FLAG_ACTIVE_SPEAKER);
    }
    t += 30;
    for (const id of speakers) {
      pushMedia(id, CHANNEL_AUDIO, 0, 0, false, 160, FLAG_END_OF_FRAME);
      t += 5;
    }
    // 次の段の判定に影響しないよう、保持時間を跨いで発話の記録を無効化する。
    t += AUDIO_SPEAKER_HOLD_MS + 50;
  }

  // --- フェーズ 8.5: 輻輳下では音声の本数が減る（ADR-0029 の 2） ---
  //
  // **これを段として作らないと検証されない。** 混合イベント列では「音声の購読が輻輳して
  // いる状態で、上限を超える人数が発話している」場面が偶然にしか起きない。実際に、この段を
  // 作る前は「音声の本数を輻輳で減らさない」変異がトレース照合を通り抜けた。
  {
    const listener = participants[participants.length - 1];
    const speakers = participants.slice(0, Math.min(participants.length, AUDIO_SELECTIVE_FORWARD_COUNT + 3));
    if (listener !== undefined && speakers.length > AUDIO_SELECTIVE_FORWARD_COUNT) {
      const rising: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        rising.push(10000 + i * 60000);
      }
      // この購読者だけを深い輻輳へ落とす。ヒステリシスを跨ぐごとに 1 段進む。
      events.push({ t, event: { kind: "report", from: listener, delayUs: rising } });
      for (let stage = 0; stage < 4; stage += 1) {
        t += 501;
        events.push({ t, event: { kind: "timer" } });
      }
      // 上限を超える人数が発話する。段が深いほど通る本数が減る。
      for (const id of speakers) {
        pushMedia(id, CHANNEL_AUDIO, 0, 0, false, 160, FLAG_END_OF_FRAME | FLAG_ACTIVE_SPEAKER);
        t += 2;
        pushAcks(id, CHANNEL_AUDIO, 0);
      }
      // 発話を止めた音声を流す。輻輳の段に応じた本数だけが通る。
      for (const id of speakers) {
        pushMedia(id, CHANNEL_AUDIO, 0, 0, false, 160, FLAG_END_OF_FRAME);
        t += 2;
        pushAcks(id, CHANNEL_AUDIO, 0);
      }
      // 勾配を戻して段を回復させる。回復の途中でも本数が増えることを記録する。
      const falling: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        falling.push(1_200_000 - i * 60000);
      }
      events.push({ t, event: { kind: "report", from: listener, delayUs: falling } });
      for (let stage = 0; stage < 3; stage += 1) {
        t += 501;
        events.push({ t, event: { kind: "timer" } });
        for (const id of speakers) {
          pushMedia(id, CHANNEL_AUDIO, 0, 0, false, 160, FLAG_END_OF_FRAME | FLAG_ACTIVE_SPEAKER);
          t += 1;
        }
      }
      // 次の段に影響しないよう保持時間を跨ぐ。
      t += AUDIO_SPEAKER_HOLD_MS + 50;
    }
  }

  // --- フェーズ 9: ノード全体の予算超過の通知（ADR-0025 の 5） ---
  //
  // 予算を絞って大きなメディアを密集させる。通知は**転送を止めない**ことを記録する
  // （超過はシャードの分割が必要な水準であり、個別の購読の問題ではない）。
  events.push({ t, event: { kind: "budget", bytesPerSec: 100000 } });
  t += 10;
  for (let burst = 0; burst < 20; burst += 1) {
    const fromIdx = randInt(advance(), participants.length);
    const from = participants[fromIdx];
    if (from === undefined) {
      continue;
    }
    pushMedia(from, CHANNEL_VIDEO, 0, 0, false, 50000, FLAG_END_OF_FRAME);
    t += 1;
    pushAcks(from, CHANNEL_VIDEO, 0);
  }
  events.push({ t, event: { kind: "budget", bytesPerSec: NODE_MAX_OUT_BYTES_PER_SEC } });
  t += 100;

  // --- フェーズ 10: ack の途絶（congestion.md 7 節） ---
  //
  // ここで確かめるのは 2 つである。
  //   1. ack を返さない購読だけが止まり、接続を閉じる指示が出る
  //   2. **他の購読は巻き込まれない**（1 人の異常が全体を落とさない）
  //
  // そのために、まず全ストリームの ack を全購読者から返して未確認を 0 にする。
  // 未確認が 0 の購読は対象にならない（返すべき ack が無い相手を切ってはならない）。
  for (const stream of seq.streams()) {
    const highestSeq = seq.current(stream.from, stream.ch, stream.sid);
    for (const subscriber of participants) {
      if (subscriber === stream.from) {
        continue;
      }
      events.push({
        t,
        event: {
          kind: "ack",
          from: subscriber,
          to: stream.from,
          ch: stream.ch,
          sid: stream.sid,
          highestSeq,
        },
      });
    }
    t += 1;
  }

  const stallSender = participants[0];
  const stallSubscriber = participants[participants.length - 1];
  if (stallSender !== undefined && stallSubscriber !== undefined && stallSender !== stallSubscriber) {
    // 1 枚渡す。全員が ack を返すが、1 人だけ返さない。
    pushMedia(stallSender, CHANNEL_VIDEO, 0, 0, true, 10000, FLAG_KEY | FLAG_END_OF_FRAME);
    t += 5;
    const highestSeq = seq.current(stallSender, CHANNEL_VIDEO, 0);
    for (const subscriber of participants) {
      if (subscriber === stallSender || subscriber === stallSubscriber) {
        continue;
      }
      events.push({
        t,
        event: {
          kind: "ack",
          from: subscriber,
          to: stallSender,
          ch: CHANNEL_VIDEO,
          sid: 0,
          highestSeq,
        },
      });
    }
    t += ACK_TIMEOUT_MS + 100;
    // ここで止まるのは ack を返さなかった 1 購読だけである。
    events.push({ t, event: { kind: "timer" } });
    t += 50;
    // 止まった購読へは渡らない。他の購読へは渡る。
    pushMedia(stallSender, CHANNEL_VIDEO, 0, 0, true, 10000, FLAG_KEY | FLAG_END_OF_FRAME);
    t += 10;
    // 購読を張り直すと復帰する（再接続の経路）。
    events.push({
      t,
      event: {
        kind: "subscribe",
        from: stallSubscriber,
        to: stallSender,
        ch: CHANNEL_VIDEO,
        want: true,
        maxSpatialId: 0,
        maxTemporalId: MAX_TEMPORAL_ID,
      },
    });
    t += 10;
    pushMedia(stallSender, CHANNEL_VIDEO, 0, 0, true, 10000, FLAG_KEY | FLAG_END_OF_FRAME);
    t += 10;
  }

  // --- フェーズ 11: 混合イベント列 ---
  const actualSteps = steps < 200 ? 200 : steps;
  let leaveTriggered = false;

  for (let i = 0; i < actualSteps; i += 1) {
    const roll = randInt(advance(), 100);
    t += randRange(advance(), 1, 33);

    if (roll < 50) {
      // media（50%）
      const fromIdx = randInt(advance(), participants.length);
      const from = participants[fromIdx];
      if (from === undefined) {
        continue;
      }
      const chRoll = randInt(advance(), 10);
      const ch = chRoll < 6 ? CHANNEL_VIDEO : chRoll < 9 ? CHANNEL_AUDIO : CHANNEL_SCREEN_VIDEO;
      const count = rungCounts.get(from) ?? 2;
      const sid = ch === CHANNEL_AUDIO ? 0 : randInt(advance(), count);
      const tid = randRange(advance(), 0, 2);
      const isKey = randInt(advance(), 20) === 0;
      const isScreenContent = ch === CHANNEL_SCREEN_VIDEO;
      const isActiveSpeaker = randInt(advance(), 5) === 0;

      let flags = FLAG_END_OF_FRAME;
      if (isKey) {
        flags = flags | FLAG_KEY;
      }
      // DISCARDABLE は最上位の時間層で立てる（wire-format.md 1.3）。
      if (!isKey && tid === 2) {
        flags = flags | FLAG_DISCARDABLE;
      }
      if (isScreenContent) {
        flags = flags | FLAG_SCREEN_CONTENT;
      }
      if (isActiveSpeaker) {
        flags = flags | FLAG_ACTIVE_SPEAKER;
      }

      const bytes =
        ch === CHANNEL_AUDIO ? randRange(advance(), 60, 160) : randRange(advance(), 500, 80000);
      pushMedia(from, ch, sid, tid, isKey, bytes, flags);
      // 全購読者から ack を返す。実際の受信ノードは ACK_INTERVAL_MS（50 ms）周期で
      // 受信中の全ストリームについて返す。間引くと窓が閉じたままの列しか記録されず、
      // 健全な運用が検証されない。
      t += 1;
      pushAcks(from, ch, sid);
    } else if (roll < 60) {
      // ack（10%）。窓が開き続けることを記録する。
      if (participants.length >= 2) {
        const subIdx = randInt(advance(), participants.length);
        const sub = participants[subIdx];
        let targetIdx = randInt(advance(), participants.length);
        if (targetIdx === subIdx) {
          targetIdx = (targetIdx + 1) % participants.length;
        }
        const target = participants[targetIdx];
        if (sub !== undefined && target !== undefined) {
          events.push({
            t,
            event: {
              kind: "ack",
              from: sub,
              to: target,
              ch: CHANNEL_VIDEO,
              sid: 0,
              highestSeq: seq.current(target, CHANNEL_VIDEO, 0),
            },
          });
        }
      }
    } else if (roll < 70) {
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
          const want = randInt(advance(), 3) !== 0;
          events.push({
            t,
            event: {
              kind: "subscribe",
              from: sub,
              to: target,
              ch: CHANNEL_VIDEO,
              want,
              maxSpatialId: want ? randRange(advance(), 0, 3) : 0,
              maxTemporalId: want ? MAX_TEMPORAL_ID : 0,
            },
          });
        }
      }
    } else if (roll < 76) {
      // budget 変更（6%）
      const bps = randRange(advance(), 1000000, NODE_MAX_OUT_BYTES_PER_SEC);
      events.push({ t, event: { kind: "budget", bytesPerSec: bps } });
    } else if (roll < 82) {
      // timer（6%）
      events.push({ t, event: { kind: "timer" } });
    } else if (roll < 86) {
      // streamAnnounce（4%）。はしごが実行中に変わる（発熱降格・カメラ切替）。
      const idx = randInt(advance(), participants.length);
      const id = participants[idx];
      if (id !== undefined) {
        const count = randInt(advance(), 2) === 0 ? 2 : 3;
        rungCounts.set(id, count);
        events.push({
          t,
          event: { kind: "streamAnnounce", from: id, ch: CHANNEL_VIDEO, rungs: ladderOf(count) },
        });
      }
    } else if (roll < 90) {
      // link（4%）— shard では表に無いイベントとして記録される
      if (participants.length > 0) {
        const peerIdx = randInt(advance(), participants.length);
        const peer = participants[peerIdx];
        if (peer !== undefined) {
          const linkStates = ["up", "down", "failed"] as const;
          const ls = linkStates[randInt(advance(), 3)];
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
      } else if (participants.length > 0) {
        const from = participants[randInt(advance(), participants.length)];
        if (from !== undefined) {
          pushMedia(from, CHANNEL_VIDEO, 0, 0, true, 5000, FLAG_KEY | FLAG_END_OF_FRAME);
        }
      }
    } else {
      // join（5%）— 新しい参加者。はしごを申告してから購読を張る。
      const newId = 100 + i;
      participants.push(newId);
      rungCounts.set(newId, 2);
      events.push({ t, event: { kind: "join", id: newId } });
      t += 2;
      events.push({
        t,
        event: { kind: "streamAnnounce", from: newId, ch: CHANNEL_VIDEO, rungs: ladderOf(2) },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 停止の検出（ADR-0041 の後も残る道）
  //
  // **未確認がある状態で ack が `ACK_TIMEOUT_MS` 途絶えたら停止と見なす。** 未確認が
  // 無い間は時計を進めるようになったため、この場面を明示的に作らないと停止の道が
  // 1 度も通らない（X-038: 通らない道は何も証明しない）。
  // ---------------------------------------------------------------------------
  {
    const stalled = 900;
    const target = participants[0];
    if (target !== undefined) {
      t += 10;
      events.push({ t, event: { kind: "join", id: stalled } });
      t += 2;
      events.push({
        t,
        event: {
          kind: "subscribe",
          from: stalled,
          to: target,
          ch: CHANNEL_VIDEO,
          want: true,
          maxSpatialId: 0,
          maxTemporalId: 7,
        },
      });
      // 音声の購読も張る。無いと音声は選別転送の段階で落ち、停止中の音声が
      // 「通る」のか「止まっている」のかを判別できなくなる。
      t += 2;
      events.push({
        t,
        event: {
          kind: "subscribe",
          from: stalled,
          to: target,
          ch: CHANNEL_AUDIO,
          want: true,
          maxSpatialId: 0,
          maxTemporalId: 0,
        },
      });
      // 媒体を渡して未確認を作る。ack は返さない。
      t += 5;
      pushMedia(target, CHANNEL_VIDEO, 0, 0, true, 4000, FLAG_KEY | FLAG_END_OF_FRAME);
      t += 5;
      pushMedia(target, CHANNEL_AUDIO, 0, 0, false, 160, FLAG_END_OF_FRAME);
      // 時限の手前では停止しない。
      t += 100;
      events.push({ t, event: { kind: "timer" } });
      // 時限を越えると停止する。ACK_TIMEOUT_MS（f30da4b で 10000 に延長）より長く進める。
      t += ACK_TIMEOUT_MS + 500;
      events.push({ t, event: { kind: "timer" } });
      // 停止した購読へは映像は渡らない。
      t += 5;
      pushMedia(target, CHANNEL_VIDEO, 0, 0, true, 4000, FLAG_KEY | FLAG_END_OF_FRAME);
      // 停止した購読へも音声は渡る（音声は破棄禁止。b440126）。
      // 音声をここで流さないと、stalled でも音声を通す道がトレースで覆われない。
      t += 5;
      pushMedia(target, CHANNEL_AUDIO, 0, 0, false, 160, FLAG_END_OF_FRAME);
      t += 5;
      pushMedia(target, CHANNEL_AUDIO, 0, 0, false, 160, FLAG_END_OF_FRAME | FLAG_ACTIVE_SPEAKER);
    }
  }

  return ok(events);
}
