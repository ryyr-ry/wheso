/**
 * 提示の門。**復号済みの出力を提示予定時刻まで保持してから渡す**（ADR-0058）。
 *
 * **なぜ必要か。** 到着した順に直ちに描くと、音声は束ね（`AUDIO_BUNDLE_MS`）で
 * 遅れるのに映像は遅れないため、映像が音声より先行する。実測では p99 88 ms 先行した
 * （F-063）。`playout.ts` は「映像を音声に合わせる」ために提示時刻を計算しているが、
 * 待つ実装が無かったため計算結果が捨てられていた。
 *
 * **提示の順序は入庫順（submit の順）である。** 復号器の出力は取得時刻順であり、
 * 提示はその順を壊してはならない（受入条件 A-3）。予定時刻は取得時刻の 1 次写像
 * であるから本来単調だが、対応付けを作り直した直後（`AV_RESYNC_GAP_MS` 超の欠落、
 * ADR-0057 の寄せ直し）は**前後の写像が混在**し、時刻で並べ替えると取得時刻順と
 * 逆転する（実測: 「325 の次に 323」）。したがって発火の実行は入庫順の連鎖で
 * 直列化し、時刻は「遅くともいつまでに先頭を出すか」の制御にだけ使う。
 *
 * 時刻とタイマーはこの層が扱う（判断コアは触れない。`lint-policy.md` 9 節）。
 */

export interface PresentGateDeps {
  readonly now: () => number;
  /** 指定時刻に発火させる。戻り値は取り消しの手続き。 */
  readonly scheduleAt: (atMs: number, fire: () => void) => () => void;
}

export interface PresentGate {
  /**
   * 提示予定時刻まで待ってから `run` を呼ぶ。既に過ぎていれば直ちに呼ぶ。
   *
   * @param senderId 送信者。順序の保証は送信者ごとに行う。
   * @param presentAtMs 提示すべき時刻（局所の単調時計）。
   */
  readonly submit: (senderId: number, presentAtMs: number, run: () => void) => void;
  /** 送信者の記録を捨てる（退出・購読解除）。保持中の枠は即座にすべて出す。 */
  readonly release: (senderId: number) => void;
}

interface Held {
  readonly presentAtMs: number;
  readonly run: () => void;
}

/** 待ちの上限（ミリ秒）。先頭の予定がこれを超えて遠い場合は、写像の混在の可能性が高いため、順序を守りつつ最短で出し始める。 */
const MAX_WAIT_MS = 1000;

/**
 * 送信者ごとの保持の上限（枠数）。`VIDEO_JITTER_MAX_FRAMES` と同じ値である。
 *
 * 保持は提示予定が未来の枠だけであるため通常はジッタ深度ぶん（2〜3 枚）しか
 * 溜まらない。写像の混在（対応付けの作り直しの直後）などで未来の予定が詰まった
 * 場合の防衛である。**先頭から順に出す**ため、順序（受入条件 A-3）は壊れない。
 */
const MAX_HELD = 10;

export function createPresentGate(deps: PresentGateDeps): PresentGate {
  /** 送信者ごとの保持中の枠（入庫順）。先頭から順に出す。 */
  const queues = new Map<number, Held[]>();
  /** 送信者ごとの予約中のタイマーの取り消し。 */
  const cancels = new Map<number, () => void>();

  function drain(senderId: number): void {
    const queue = queues.get(senderId);
    const cancel = cancels.get(senderId);
    if (cancel !== undefined) {
      cancel();
      cancels.delete(senderId);
    }
    if (queue === undefined) {
      return;
    }
    const now = deps.now();
    while (queue.length > 0) {
      const head = queue[0];
      if (head === undefined) {
        break;
      }
      // 先頭の予定が過去（または今）なら直ちに出す。
      if (head.presentAtMs <= now) {
        queue.shift();
        head.run();
        continue;
      }
      // 先頭の予定が「待ちの上限」より遠いなら、対応付けの混在の可能性が高い。
      // 順序を守りつつ、最短（現在）で先頭から順に出し始める（fps の低下として出る）。
      if (head.presentAtMs - now > MAX_WAIT_MS) {
        queue.shift();
        head.run();
        continue;
      }
      // 保持が上限を超えているなら、順序を守りつつ先頭から出す（資源の防衛）。
      if (queue.length > MAX_HELD) {
        queue.shift();
        head.run();
        continue;
      }
      // 先頭を予定時刻へ予約して待つ。後続は連鎖で続く（先頭が出た後に再評価）。
      cancels.set(
        senderId,
        deps.scheduleAt(head.presentAtMs, () => {
          cancels.delete(senderId);
          const next = queues.get(senderId)?.[0];
          if (next !== undefined) {
            drain(senderId);
          }
        }),
      );
      return;
    }
    if (queue.length === 0) {
      queues.delete(senderId);
    }
  }

  return {
    submit: (senderId, presentAtMs, run): void => {
      const queue = queues.get(senderId) ?? [];
      if (queue.length === 0) {
        queues.set(senderId, queue);
      }
      queue.push({ presentAtMs, run });
      drain(senderId);
    },
    release: (senderId): void => {
      // 保持中の枠は即座にすべて出す。資源（VideoFrame）を閉じる責務は
      // 呼び出し側の run にあるため、呼び出さずに捨ててはならない。
      const queue = queues.get(senderId);
      const cancel = cancels.get(senderId);
      if (cancel !== undefined) {
        cancel();
        cancels.delete(senderId);
      }
      if (queue !== undefined) {
        queues.delete(senderId);
        for (const held of queue) {
          held.run();
        }
      }
    },
  };
}
