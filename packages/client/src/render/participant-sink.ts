/**
 * 参加者ごとの受け皿。
 *
 * 規範: sdk-api.md 5 節。`attach(target)` を使う場合、SDK は要素の寸法変化を観測して
 * 自動的に申告する。申告が無い相手は最低品質に留まる（5.1 の規則 3）。
 *
 * `render/sink.ts` は「描画先が決まっている受け皿」を作る。ここでは描画先が
 * 後から与えられる形（`attach` / `detach`）へ適合させる。分けている理由は、
 * 描画先が決まっている場合の実装を利用側からも使えるようにするためである。
 */

import { createSink, type Sink, type SinkTarget } from "./sink.ts";
import type { VideoSinkHandle } from "../api/meeting.ts";

/** 描画も行う受け皿。復号したフレームは端が渡す。 */
export interface ParticipantSink extends VideoSinkHandle {
  /** フレームを 1 枚描く。描画先が無い場合は何もしない。 */
  readonly draw: (frame: VideoFrame) => void;
}

/**
 * 受け皿を作る。
 *
 * `onDisplaySize` は寸法が変わったときに呼ばれる。呼び出し側はこれを
 * 受信ノードへの申告（`displaySize`）に写す。
 */
export function createParticipantSink(onDisplaySize: (width: number, height: number) => void): ParticipantSink {
  let inner: Sink | null = null;

  return {
    attach: (target: unknown): void => {
      if (typeof target !== "object" || target === null) {
        return;
      }
      // 描画先の形は環境ごとに異なる。必要な口だけを見る（DOM の型に依存しない）。
      const candidate: SinkTarget = target;
      inner?.detach();
      inner = createSink(candidate, { onDisplaySize });
    },
    detach: (): void => {
      inner?.detach();
      inner = null;
    },
    setDisplaySize: (width: number, height: number): void => {
      if (inner === null) {
        // 描画先が無くても申告は必要である（生のトラックを使う場合。5.1 の規則 2）。
        onDisplaySize(width, height);
        return;
      }
      inner.setDisplaySize(width, height);
    },
    draw: (frame: VideoFrame): void => {
      inner?.draw(frame);
    },
  };
}
