/**
 * 提示の門。**提示予定時刻まで待ってから復号へ渡す**（ADR-0042）。
 *
 * **なぜ必要か。** 到着した順に直ちに復号して描くと、音声は束ね（`AUDIO_BUNDLE_MS`）で
 * 遅れるのに映像は遅れないため、映像が音声より先行する。実測では p99 88 ms 先行した
 * （F-063）。`playout.ts` は「映像を音声に合わせる」ために提示時刻を計算しているが、
 * 待つ実装が無かったため計算結果が捨てられていた。
 *
 * **順序を壊してはならない。** 復号器は前のフレームを参照するため、投入の順序が入れ替わると
 * 参照連鎖が壊れる。したがって送信者ごとに「前回より後」を保証する。予定時刻は取得時刻の
 * 1 次写像であるから本来単調だが、写像を作り直した直後（`AV_RESYNC_GAP_MS` 超の欠落）は
 * 前後する可能性がある。そこを吸収する。
 *
 * 時刻とタイマーはこの層が扱う（判断コアは触れない。`lint-policy.md` 9 節）。
 */

/** 待ちの上限（ミリ秒）。これを超える予定は異常とみなし直ちに渡す。 */
const MAX_WAIT_MS = 1000;

export interface PresentGateDeps {
  readonly now: () => number;
  /** 指定時刻に発火させる。戻り値は取り消しの手続き。 */
  readonly scheduleAt: (atMs: number, fire: () => void) => () => void;
}

export interface PresentGate {
  /**
   * 予定時刻まで待ってから `run` を呼ぶ。既に過ぎていれば直ちに呼ぶ。
   *
   * @param senderId 送信者。順序の保証は送信者ごとに行う。
   * @param presentAtMs 提示すべき時刻（局所の単調時計）。
   */
  readonly submit: (senderId: number, presentAtMs: number, run: () => void) => void;
  /** 送信者の記録を捨てる（退出・購読解除）。 */
  readonly release: (senderId: number) => void;
}

export function createPresentGate(deps: PresentGateDeps): PresentGate {
  /** 送信者ごとの、直前に渡した（または渡す予定の）時刻。 */
  const lastAtMs = new Map<number, number>();

  return {
    submit: (senderId, presentAtMs, run): void => {
      const now = deps.now();
      const previous = lastAtMs.get(senderId);
      // 前回より後にする。同時刻なら順序が保たれないため 1 ミリ秒だけ後ろへ置く。
      const ordered = previous === undefined || presentAtMs > previous ? presentAtMs : previous + 1;
      const waitMs = ordered - now;
      if (waitMs > MAX_WAIT_MS) {
        // 予定が遠すぎる。対応付けを作り直した直後は、まだ経路にある古い映像が未来へ
        // 写ることがある（実測: 予定が 2.5 秒先になった）。**待たずに出すが、順序は守る。**
        //
        // 以前はここで `lastAtMs` を現在時刻に落として直ちに渡していた。すると、先に
        // 予約済みの（より早い予定の）フレームより前に出てしまい、**復号器へ入る順序が
        // 入れ替わる**。実測では判定 A-3（frameIndex の逆行）と判定 C-1（描画の間隔が
        // 4.8 秒）が同時に出た。間隔が実際より長く見えたのは、順序が入れ替わった記録を
        // そのまま差で測ったためである。
        const immediate = previous === undefined || now > previous ? now : previous + 1;
        lastAtMs.set(senderId, immediate);
        if (immediate <= now) {
          run();
          return;
        }
        deps.scheduleAt(immediate, run);
        return;
      }
      lastAtMs.set(senderId, ordered);
      if (waitMs <= 0) {
        run();
        return;
      }
      deps.scheduleAt(ordered, run);
    },
    release: (senderId): void => {
      lastAtMs.delete(senderId);
    },
  };
}
