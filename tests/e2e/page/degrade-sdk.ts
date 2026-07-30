/**
 * 段 D（劣化）の記録の器。**SDK 経由**である（F-10）。
 *
 * **なぜ作り直したか。** 旧い器（`degrade.ts`）は生の WebSocket で中継部屋へ直結し、
 * simulcast と輻輳制御を自前に持っていた（774 行）。したがって劣化下で緑になっても、
 * 緑だったのは器の自前実装であり、製品の判断は 1 度も通らなかった。さらに旧い器は
 * `ack` を返さないため、購読単位の送信窓（ADR-0025）を入れた後は
 * `ACK_TIMEOUT_MS`（5 秒）で中継ノードから切断される。**器が規範に追いつけない。**
 *
 * **この器が通る経路。** 公開 API（`joinMeeting`）→ 取得と符号化（実 `VideoEncoder`）→
 * 送信ノード → 中継ノード → 受信ノード → 受信経路（購読・報告・`ack`・提示の門）→
 * 実 `VideoDecoder` → 受け皿。判断はすべて製品側にある。器が持つのは**観測だけ**である。
 *
 * **観測の置き場所。** 注入の境界（`JoinDeps`）を包む。製品コードに試験用の口を作らない。
 *
 *   `capture.bindCapture` … 符号化できたユニット（送った物の真実）
 *   `media.decodeVideo`   … 復号へ渡した段（届いた物の段）
 *   `media.enqueueAudio`  … 音声を再生待ち行列へ入れた時刻（判定 D-1 の入力）
 *   `bindOutput.onFrame`  … 提示できたフレーム（判定 A-1 の画素ハッシュと D-1 の入力）
 *   `openSocket`          … ワイヤの到着（復号の成否に依らない `arrived`）と切断
 *
 * **偽のカメラを使う**（`--use-fake-device-for-media-stream`）。CI の実行機にカメラは
 * 無い（Q-020）。偽のデバイスは実際の `MediaStreamTrack` を返すため、取得と符号化の
 * 経路は本物である。
 */

import {
  browserDeps,
  joinMeeting,
  probeCapability,
  type FrameOutput,
  type JoinDeps,
} from "../../../packages/client/src/api/join-meeting.ts";
import type { CaptureOutput } from "../../../packages/client/src/media/browser-capture.ts";
import type { DecodeInput } from "../../../packages/client/src/api/receive-pipeline.ts";
import { issueToken } from "../../../packages/core/src/auth.ts";
import { decodeMediaMessage } from "../../../packages/core/src/wire.ts";
import { CHANNEL_AUDIO, CHANNEL_VIDEO, FLAG_KEY } from "../../../packages/core/src/generated/wire-layout.ts";
import { V_360P15 } from "../../../packages/core/src/generated/constants.ts";

/** 送った映像ユニット 1 件。`frameIndex` は送出の順に振る（器の中でのみ意味を持つ）。 */
interface SentVideo {
  readonly frameIndex: number;
  readonly spatialId: number;
  readonly temporalId: number;
  readonly isKey: boolean;
  readonly captureUs: number;
  readonly atMs: number;
  /** ワイヤへ出た本文の大きさ（バイト）。申告ビットレートとの比較に使う。 */
  readonly bytes: number;
}

/** 送った音声ユニット 1 件。映像との対応付けは取得時刻で行う（送信側の真実）。 */
interface SentAudio {
  readonly captureUs: number;
  readonly atMs: number;
  readonly silent: boolean;
}

/** 復号して提示できた映像 1 枚。 */
interface ReceivedVideo {
  readonly captureUs: number;
  readonly sha256: string;
  readonly atMs: number;
}

/** 復号へ渡した映像 1 件（段が分かる。提示できたかは別）。 */
interface DecodedVideo {
  readonly captureUs: number;
  readonly spatialId: number;
  readonly temporalId: number;
  readonly isKey: boolean;
  readonly atMs: number;
  /**
   * 提示の予定時刻（`DecodeInput.presentAtMs`）。
   *
   * **停止の原因を切り分けるために持つ。** `atMs − presentAtMs` は再生クロックから見た
   * ずれ（`skewMs`）であり、これが大きく跳べば対応付けを作り直した合図である。予定が
   * 未来なら提示の門が待つ（`sync/present-gate.ts`）。数が無いと、停止が経路のものか
   * 同期の判断のものか区別できない。
   */
  readonly presentAtMs: number;
}

/** 再生待ち行列へ入れた音声 1 件。 */
interface PlayedAudio {
  readonly captureUs: number;
  readonly atMs: number;
}

/** 閉鎖 1 件。**コードを数として持つ**（戻れる閉鎖と戻れない閉鎖を判定側が分ける）。 */
interface ClosureRecord {
  readonly label: string;
  readonly role: string;
  readonly code: number;
}

/** ワイヤで届いた映像ユニット 1 件（復号の成否に依らない）。 */
interface ArrivedVideo {
  readonly captureUs: number;
  readonly spatialId: number;
  /** 同一の (段) 内で一意な連番。**同じ通が二度数えられるのを防ぐ鍵である。** */
  readonly sequenceNumber: number;
}

/** 参加者 1 人ぶんの記録。判定は Node 側の純関数が行う。 */
export interface SdkDegradeParticipant {
  readonly label: string;
  /**
   * **ワイヤへ出した映像ユニット**（判定の入力）。
   *
   * 符号化器が出した数ではない。送信経路は上りの詰まりで段を落とし（`core/uplink.ts`）、
   * 送信窓が閉じている間は破棄可能なユニットを落とす。落としたものを「送った」と数えると、
   * 経路の欠落と送信側の判断が混ざり、判定 B-2 が送信側の正しい振る舞いを違反と読む。
   */
  readonly sentVideo: readonly SentVideo[];
  /** 符号化器が出したユニットの数（送信経路が落とした量を見るための観測）。 */
  readonly encodedVideoCount: number;
  /**
   * 符号化器が出した音声ユニットの数（観測）。
   *
   * **判定に使うのはワイヤへ出た音声である**（`sentAudio`）。送信経路は無音（DTX）を
   * 送らないため、符号化器の数と一致しない。符号化器の数で対を作ると、送っていない音声に
   * 対して「再生されていない」と読む（実測: 2,300 対 2,130 の差で D-1 が 23 件出た）。
   */
  readonly encodedAudioCount: number;
  /**
   * 復号器の出入り（観測）。**「届いたのに出ない」の原因はここで分かれる。**
   *
   * 初期化のやり直し（`reset`）が多ければキーフレーム待ちで止まっており、失敗（`error`）が
   * 多ければ参照連鎖が壊れている。この区別が付かないと原因の層を毎回取り違える（X-043）。
   */
  readonly decoderEvents: {
    readonly configure: number;
    readonly reset: number;
    readonly close: number;
    readonly error: number;
  };
  readonly sentAudio: readonly SentAudio[];
  readonly received: readonly ReceivedVideo[];
  readonly decoded: readonly DecodedVideo[];
  readonly playedAudio: readonly PlayedAudio[];
  readonly arrived: readonly ArrivedVideo[];
  /**
   * キーフレームを要求した時刻の一覧（ミリ秒）。
   *
   * **数ではなく時刻で持つ。** 暖機の切り落としは Node 側が内容で行うため、切る位置より
   * 前の要求を除くには時刻が必要である。購読を張った直後の要求は規範どおりであり
   * （`wire-format.md` 2.5）、違反に数えてはならない。
   */
  readonly keyframeRequestAtMs: readonly number[];
  readonly closures: readonly ClosureRecord[];
  readonly lastSentAtMs: number;
  /**
   * 測定の窓を閉じた時刻（ミリ秒）。
   *
   * **これより後に送ったものは判定しない。** 窓を閉じた後も送出は続く（止めると
   * 「止めたこと」自体が経路に影響する）。閉じた後の数枚は、記録を取る時点でまだ経路に
   * あるため「届かなかった」と読まれる（実測: 末尾 4 件が B-2 の違反になった）。
   * 排水の待ちは、窓の中で送ったものが届くための時間である。
   */
  readonly windowClosedAtMs: number;
  /** SDK 自身が観測した A/V のずれ（ミリ秒）。 */
  readonly avSkewMs: number;
  readonly uplinkBps: number;
  readonly downlinkBps: number;
  readonly participantCount: number;
  /** 部屋の種別ごとの接続の開閉（`vr` / `ar` / `ctl` / `vs` / `as`）。 */
  readonly socketStats: readonly { readonly kind: string; readonly opened: number; readonly closed: number; readonly lastCode: number }[];
  /** 実際の復号器の出入り（生成・設定・投入・出力・失敗）。 */
  /** 音声の出入り（渡した数と鳴った数）。 */
  readonly audioIo: { readonly submitted: number; readonly played: number };
  readonly decoderIo: {
    readonly created: number;
    readonly configured: number;
    readonly submitted: number;
    readonly output: number;
    readonly failed: number;
    readonly messages: readonly string[];
  };
  /** この参加者のページで観測した閉鎖の理由。 */
  readonly closeNotes: readonly CloseNote[];
  /** この参加者のページの記録（誤りの通知など）。 */
  readonly logs: readonly string[];
}

/** 参加者 1 人の設定。劣化を分けるため接続先の口を個別に与える（N-8）。 */
interface Spec {
  readonly label: string;
  /** `http://127.0.0.1:<port>`。**http にすると SDK は ws で繋ぐ**（join-url.ts）。 */
  readonly base: string;
  readonly userId: string;
  /** 送信するか。受信専用の参加者はカメラとマイクを開かない。 */
  readonly send: boolean;
}

declare global {
  interface Window {
    /** **1 ページに 1 人**。参加者ごとに別のページで回す（`runOne` の注記）。 */
    __whesoDegradeOne?: (
      spec: Spec,
      meetingId: string,
      tokenKey: string,
      participantCount: number,
      durationMs: number,
    ) => Promise<SdkDegradeParticipant>;
    /** 走行中の計数（段 E で経過を刻む）。 */
    __whesoCounts?: () => Record<string, number>;
    /** 開いている接続を全部落とす（段 E。戻り値は「部屋:前の状態→後の状態」の一覧）。 */
    __whesoDropLinks?: () => string;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 閉鎖の**理由**を拾うために `WebSocket` を包む。
 *
 * 注入の口（`LinkSocket.onClose`）はコードだけを渡す。コードだけでは `E_AUTH`（4020）の
 * 原因が「hello が来なかった」のか「署名が違う」のかを切り分けられない。実測でこの区別が
 * 付かず 2 度回り道をした（X-043 と同じ性質）。器の側で理由を控える。
 */
interface CloseNote {
  readonly kind: string;
  readonly code: number;
  readonly reason: string;
}

const closeNotes: CloseNote[] = [];

/**
 * 実際の復号器の出入り（観測）。
 *
 * 注入の口では「投入した数」しか分からない。**復号器が何枚出したか**は本物を包まないと
 * 分からず、「届いたのに出ない」の原因を投入・出力・失敗のどこにも切り分けられない
 * （`tests/e2e/page/sdk.ts` と同じ技法）。
 */
const decoderIo = { created: 0, configured: 0, submitted: 0, output: 0, failed: 0 };

/**
 * 開いている WebSocket の実体。**段 E（耐久）で経路を故意に落とすために持つ。**
 *
 * 再デプロイでは既存の接続が切れない（実行環境が古い実体を動かし続ける）。切断が起きないと
 * 再接続の経路が 1 度も通らないため、段 E は切断を試験側から起こす（実測に基づく）。
 */
const liveSockets = new Map<WebSocket, string>();

/**
 * 部屋の種別ごとの接続の開閉（観測）。
 *
 * **どの部屋が戻らなかったかを見るために要る。** 段 E で経路を落としたとき、映像は戻ったが
 * 音声が戻らなかった（実測: 音声の再生が 5,890 件で止まったまま 40 秒）。種別ごとに数えないと、
 * 「再接続しなかった」のか「再接続したが購読が戻らなかった」のかを区別できない。
 */
const socketStats = new Map<string, { opened: number; closed: number; lastCode: number }>();
const decoderMessages: string[] = [];

function installDecoderWatch(): void {
  const original = globalThis.VideoDecoder;
  if (typeof original !== "function") {
    return;
  }
  class WatchedDecoder extends original {
    constructor(init: VideoDecoderInit) {
      super({
        output: (frame: VideoFrame): void => {
          decoderIo.output += 1;
          init.output(frame);
        },
        error: (error: DOMException): void => {
          decoderIo.failed += 1;
          if (decoderMessages.length < 5) {
            decoderMessages.push(String(error.message));
          }
          init.error(error);
        },
      });
      decoderIo.created += 1;
    }

    override configure(config: VideoDecoderConfig): void {
      decoderIo.configured += 1;
      super.configure(config);
    }

    override decode(chunk: EncodedVideoChunk): void {
      decoderIo.submitted += 1;
      super.decode(chunk);
    }
  }
  globalThis.VideoDecoder = WatchedDecoder;
}

function installSocketWatch(): void {
  const original = globalThis.WebSocket;
  class WatchedSocket extends original {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const text = String(url);
      const match = /\/parties\/[a-z]+\/([a-z]+)-/.exec(text);
      const kind = match?.[1] ?? "other";
      liveSockets.set(this, kind);
      const stat = socketStats.get(kind) ?? { opened: 0, closed: 0, lastCode: 0 };
      stat.opened += 1;
      socketStats.set(kind, stat);
      this.addEventListener("close", (event: CloseEvent) => {
        liveSockets.delete(this);
        const seen = socketStats.get(kind) ?? { opened: 0, closed: 0, lastCode: 0 };
        seen.closed += 1;
        seen.lastCode = event.code;
        socketStats.set(kind, seen);
        if (event.code !== 1000 && event.code !== 1001 && closeNotes.length < 60) {
          closeNotes.push({ kind, code: event.code, reason: event.reason });
        }
      });
    }
  }
  globalThis.WebSocket = WatchedSocket;
}

async function tokenFor(tokenKey: string, meetingId: string, userId: string): Promise<string> {
  const nowSec = Math.trunc(Date.now() / 1000);
  const issued = await issueToken(new TextEncoder().encode(tokenKey), {
    iss: "wheso-degrade",
    sub: userId,
    aud: meetingId,
    iat: nowSec,
    exp: nowSec + 60,
    jti: `deg-${String(nowSec)}-${userId.slice(-4)}`,
    kind: "client",
    role: "host",
  });
  return issued.ok ? issued.value : "";
}

/**
 * 復号したフレームの画素を SHA-256 で刻む（判定 A-1）。
 *
 * **縮小してから刻む。** 640x480 を等倍で読むと 1 枚 1.2 MB になり、`getImageData` と
 * ハッシュだけで主筋を埋める。器は符号化器と復号器と同じ筋の上に居るため、器の重さが
 * そのまま復号の停滞になる（実測: 等倍で刻んだ回は復号 617 件に対し提示 5 枚だった）。
 * 64x64 に縮めても「画素が来ていること」と「内容が変わっていること」は判る。
 */
const HASH_SIDE = 64;

/**
 * 画素を読むための画布。**1 個を使い回す。**
 *
 * 毎フレーム作ると割り当てと GPU からの読み戻しが積み上がり、頁の主筋が詰まる。実測:
 * N-0（劣化なし）で音声の再生が 875 ms 途切れ、連鎖切れが 55 件出た。器が主筋を止めると
 * 復号も送出も遅れ、**製品の欠陥と見分けが付かない**。
 */
let hashCanvas: OffscreenCanvas | null = null;
let hashContext: OffscreenCanvasRenderingContext2D | null = null;

/**
 * この取得時刻の枠を照合の対象にするか。
 *
 * **購読者どうしで同じ枠を選ばなければならない**（判定 A-1 は購読者間の一致を見る）。
 * 取得時刻は源のものであり全員に共通であるから、取得時刻から決める。4 枚に 1 枚で足りる
 * （1 枚でも違えば転送か復号が壊れている）。
 */
function shouldHash(captureUs: number): boolean {
  return Math.trunc(captureUs / 1000) % 4 === 0;
}

async function hashFrame(frame: unknown): Promise<string> {
  const width = Reflect.get(Object(frame), "displayWidth");
  const height = Reflect.get(Object(frame), "displayHeight");
  if (typeof width !== "number" || typeof height !== "number" || width === 0 || height === 0) {
    return "";
  }
  if (hashCanvas === null) {
    hashCanvas = new OffscreenCanvas(HASH_SIDE, HASH_SIDE);
    hashContext = hashCanvas.getContext("2d");
  }
  const context = hashContext;
  if (context === null) {
    return "";
  }
  // `drawImage` は `VideoFrame` を受ける。型はブラウザにしか無いため実行時に確かめる。
  const draw = Reflect.get(context, "drawImage");
  if (typeof draw !== "function") {
    return "";
  }
  Reflect.apply(draw, context, [frame, 0, 0, HASH_SIDE, HASH_SIDE]);
  const image = context.getImageData(0, 0, HASH_SIDE, HASH_SIDE);
  const digest = await crypto.subtle.digest("SHA-256", image.data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 記録の入れ物。参加者ごとに 1 個持つ。 */
interface Recorder {
  readonly label: string;
  readonly sentVideo: SentVideo[];
  encodedVideoCount: number;
  encodedAudioCount: number;
  readonly decoderEvents: { configure: number; reset: number; close: number; error: number };
  /** 音声の出入り。**渡した数と鳴った数の差が「落とした量」である**（音声は破棄禁止）。 */
  readonly audioIo: { submitted: number; played: number };
  readonly sentAudio: SentAudio[];
  readonly received: ReceivedVideo[];
  readonly decoded: DecodedVideo[];
  readonly playedAudio: PlayedAudio[];
  readonly arrived: ArrivedVideo[];
  /** 二度数えを防ぐ鍵の集合（`段:連番`）。注入の口は複数回 `onBinary` を登録する。 */
  readonly arrivedKeys: Set<string>;
  readonly keyframeRequestAtMs: number[];
  readonly closures: ClosureRecord[];
  lastSentAtMs: number;
  windowClosedAtMs: number;
  frameCounter: number;
}

/** 走行中の記録。`__whesoCounts` が読む（1 ページに 1 人であるため 1 個で足りる）。 */
let activeRecorder: Recorder | null = null;

function newRecorder(label: string): Recorder {
  return {
    label,
    sentVideo: [],
    encodedVideoCount: 0,
    encodedAudioCount: 0,
    decoderEvents: { configure: 0, reset: 0, close: 0, error: 0 },
    audioIo: { submitted: 0, played: 0 },
    sentAudio: [],
    received: [],
    decoded: [],
    playedAudio: [],
    arrived: [],
    arrivedKeys: new Set<string>(),
    keyframeRequestAtMs: [],
    closures: [],
    lastSentAtMs: 0,
    windowClosedAtMs: 0,
    frameCounter: 0,
  };
}

/**
 * 注入を包んで観測する。**製品の判断には触らない。**
 *
 * 包む位置を注入の境界に限る理由: 製品コードに試験用の分岐を置くと、その分岐が
 * 本番で死んでいても試験は緑になる。境界を包めば、通っているのは本番と同じ経路である。
 */
function observe(base: JoinDeps, recorder: Recorder): JoinDeps {
  return {
    ...base,
    bindOutput: (output: FrameOutput): void => {
      base.bindOutput({
        // **実際に鳴る時刻を記録する。** 予定時刻で代用すると写像の値を測ってしまう
        // （実測: 偽のずれ p99 1,976 ms。SDK 自身の観測は 129 ms であった）。
        onAudioScheduled: (senderId, captureUs, atMs): void => {
          void senderId;
          recorder.audioIo.played += 1;
          recorder.playedAudio.push({ captureUs, atMs });
        },
        onFrame: (senderId, frame): void => {
          const timestamp = Reflect.get(Object(frame), "timestamp");
          const captureUs = typeof timestamp === "number" ? timestamp : -1;
          const atMs = Date.now();
          // **時刻はここで取る。** ハッシュの完了を待って取ると、計算時間が
          // 「描画の間隔」に混ざる（旧い器で実際に 2049 ms の偽の間隔が出た）。
          const slot = recorder.received.length;
          recorder.received.push({ captureUs, sha256: "", atMs });
          // **4 枚に 1 枚だけ照合する。** 画素の読み戻しは高価であり、毎枚行うと頁の主筋が
          // 詰まる（実測: 音声の再生が 875 ms 途切れた）。選ぶ基準は取得時刻であるから、
          // 購読者どうしで同じ枠が選ばれる（判定 A-1 は購読者間の一致を見る）。
          if (shouldHash(captureUs)) {
            void hashFrame(frame).then((sha256) => {
              const entry = recorder.received[slot];
              if (entry !== undefined) {
                recorder.received[slot] = { ...entry, sha256 };
              }
            });
          }
          output.onFrame(senderId, frame);
        },
        onDecodeError: (senderId, channel): void => {
          recorder.decoderEvents.error += 1;
          output.onDecodeError(senderId, channel);
        },
        onDisplaySize: (participantId, width, height): void =>
          output.onDisplaySize(participantId, width, height),
      });
    },
    capture: {
      ...base.capture,
      bindCapture: (output: CaptureOutput): void => {
        base.capture.bindCapture({
          onVideo: (video): void => {
            // 符号化器が出した数だけを数える。**ワイヤへ出た物は送信の口で数える。**
            recorder.encodedVideoCount += 1;
            output.onVideo(video);
          },
          onAudio: (audio): void => {
            // 符号化器が出した数だけを数える。**ワイヤへ出た音声は送信の口で数える。**
            recorder.encodedAudioCount += 1;
            output.onAudio(audio);
          },
        });
      },
    },
    media: {
      ...base.media,
      configureDecoder: (senderId: number, channel: number, spatialId: number): void => {
        recorder.decoderEvents.configure += 1;
        base.media.configureDecoder(senderId, channel, spatialId);
      },
      resetDecoder: (senderId: number, channel: number, spatialId: number): void => {
        recorder.decoderEvents.reset += 1;
        base.media.resetDecoder(senderId, channel, spatialId);
      },
      closeDecoder: (senderId: number, channel: number): void => {
        recorder.decoderEvents.close += 1;
        base.media.closeDecoder(senderId, channel);
      },
      decodeVideo: (input: DecodeInput): void => {
        recorder.decoded.push({
          captureUs: input.captureTimestampUs,
          spatialId: input.spatialId,
          temporalId: input.temporalId,
          isKey: input.key,
          atMs: Date.now(),
          presentAtMs: input.presentAtMs,
        });
        base.media.decodeVideo(input);
      },
      enqueueAudio: (input: DecodeInput): void => {
        // **時刻はここでは記録しない**（`onAudioScheduled` が実際に鳴る時刻を出す）。
        // 数だけ数える。鳴った数との差が「音声を落とした量」である（音声は破棄禁止）。
        recorder.audioIo.submitted += 1;
        base.media.enqueueAudio(input);
      },
    },
    openSocket: (url, role) => {
      const socket = base.openSocket(url, role);
      if (socket === null) {
        return null;
      }
      return {
        ...socket,
        send: (text: string): void => {
          if (text.includes("keyframeRequest")) {
            recorder.keyframeRequestAtMs.push(Date.now());
          }
          socket.send(text);
        },
        sendBinary: (bytes: Uint8Array): void => {
          // **ワイヤへ出た媒体を数える**（送信経路の判断の後）。
          const message = decodeMediaMessage(bytes);
          if (message.ok && message.value.channel === CHANNEL_VIDEO) {
            for (const unit of message.value.units) {
              recorder.frameCounter += 1;
              recorder.lastSentAtMs = Date.now();
              recorder.sentVideo.push({
                frameIndex: recorder.frameCounter,
                spatialId: unit.spatialId,
                temporalId: unit.temporalId,
                isKey: (unit.flags & FLAG_KEY) !== 0,
                captureUs: Number(unit.captureTimestampUs),
                atMs: recorder.lastSentAtMs,
                bytes: unit.payload.length,
              });
            }
          }
          if (message.ok && message.value.channel === CHANNEL_AUDIO) {
            // ワイヤへ出た音声は対の相手になれる。無音（DTX）はここまで来ない。
            const atMs = Date.now();
            for (const unit of message.value.units) {
              recorder.sentAudio.push({ captureUs: Number(unit.captureTimestampUs), atMs, silent: false });
            }
          }
          socket.sendBinary(bytes);
        },
        onBinary: (handler: (bytes: Uint8Array) => void): void => {
          socket.onBinary((bytes) => {
            // **ワイヤの到着を数える。** 復号の成否と分けないと、「届かなかった」と
            // 「届いたが捨てられた」を区別できない（X-043）。
            //
            // 注入の口は `onBinary` を複数回登録する（主接続と予備接続の配線）。
            // 連番で重複を除かないと同じ通が二度数えられる（実測: 到着が送信の 2 倍）。
            const message = decodeMediaMessage(bytes);
            if (message.ok && message.value.channel === CHANNEL_VIDEO) {
              for (const unit of message.value.units) {
                const key = `${String(unit.spatialId)}:${String(unit.sequenceNumber)}`;
                if (!recorder.arrivedKeys.has(key)) {
                  recorder.arrivedKeys.add(key);
                  recorder.arrived.push({
                    captureUs: Number(unit.captureTimestampUs),
                    spatialId: unit.spatialId,
                    sequenceNumber: unit.sequenceNumber,
                  });
                }
              }
            }
            handler(bytes);
          });
        },
        onClose: (handler: (code: number) => void): void => {
          socket.onClose((code) => {
            // 正常な終了（1000 / 1001）は記録しない。判定は異常な切断だけを見る。
            if (code !== 1000 && code !== 1001) {
              recorder.closures.push({ label: recorder.label, role, code });
            }
            handler(code);
          });
        },
      };
    },
  };
}

interface Joined {
  readonly recorder: Recorder;
  readonly participants: () => number;
  readonly avSkewMs: () => number;
  readonly uplinkBps: () => number;
  readonly downlinkBps: () => number;
  readonly leave: () => void;
}

async function joinOne(spec: Spec, meetingId: string, tokenKey: string, logs: string[]): Promise<Joined | null> {
  const token = await tokenFor(tokenKey, meetingId, spec.userId);
  if (token === "") {
    logs.push(`${spec.label}: トークンを発行できない`);
    return null;
  }
  /**
   * **トークンを更新し続ける。**
   *
   * 参加トークンの有効期間は 60 秒である（auth.md 3.3）。既定の取得は参加 URL の
   * 断片から読むため、**60 秒を過ぎた後に再接続すると `hello` が `E_AUTH`（4020）で
   * 拒否され、その経路は二度と戻らない**（`autoReconnect: false`）。段 D は 1 本 60 秒
   * であり、劣化や遮断で再接続が起きるため、器が更新の役を負う。実際の応用でも
   * 自分の伺い所が短命のトークンを発行し続ける（`tokenProvider`）。
   *
   * 実測: 更新しない器では 25 秒の試行でも `受信 vr code=4020` で経路が死んだ。
   */
  let latest = token;
  const refresh = globalThis.setInterval(() => {
    void tokenFor(tokenKey, meetingId, spec.userId).then((next) => {
      if (next !== "") {
        latest = next;
      }
    });
  }, 20_000);
  const capability = await probeCapability();
  const base = browserDeps(capability, {
    width: V_360P15.width,
    height: V_360P15.height,
    framerate: V_360P15.framerate,
  });
  if (base === null) {
    globalThis.clearInterval(refresh);
    logs.push(`${spec.label}: 既定の注入が無い`);
    return null;
  }
  const recorder = newRecorder(spec.label);
  activeRecorder = recorder;
  const joined = await joinMeeting(
    `${spec.base}/j/${meetingId}#${token}`,
    // 受信専用の参加者はカメラとマイクを開かない。**開くと劣化の原因が 2 つになり**、
    // 「悪い回線の 1 人が他人を壊さない」の検証で原因を切り分けられない。
    { camera: spec.send, microphone: spec.send, tokenProvider: (): string => latest },
    observe(base, recorder),
  );
  if (!joined.ok) {
    globalThis.clearInterval(refresh);
    logs.push(`${spec.label}: 参加できない ${joined.error.code} ${joined.error.detail}`);
    return null;
  }
  const meeting = joined.value.meeting;
  meeting.subscribeFrames();
  meeting.on("error", (code) => logs.push(`${spec.label} error ${String(code)}`));
  meeting.on("warning", (code) => logs.push(`${spec.label} warn ${String(code)}`));
  return {
    recorder,
    participants: (): number => meeting.participants.length,
    // SDK 自身が思っているずれ。器の対応付けと食い違えば、どちらが狂っているか分かる。
    avSkewMs: (): number => meeting.quality.avSkewMs,
    uplinkBps: (): number => meeting.quality.uplinkBps,
    downlinkBps: (): number => meeting.quality.downlinkBps,
    leave: (): void => {
      globalThis.clearInterval(refresh);
      meeting.leave();
    },
  };
}

function snapshot(joined: Joined): SdkDegradeParticipant {
  const recorder = joined.recorder;
  return {
    label: recorder.label,
    sentVideo: [...recorder.sentVideo],
    encodedVideoCount: recorder.encodedVideoCount,
    encodedAudioCount: recorder.encodedAudioCount,
    decoderEvents: { ...recorder.decoderEvents },
    decoderIo: { ...decoderIo, messages: [...decoderMessages] },
    audioIo: { ...joined.recorder.audioIo },
    socketStats: [...socketStats.entries()].map(([kind, value]) => ({ kind, ...value })),
    sentAudio: [...recorder.sentAudio],
    received: [...recorder.received],
    decoded: [...recorder.decoded],
    playedAudio: [...recorder.playedAudio],
    arrived: [...recorder.arrived],
    keyframeRequestAtMs: [...recorder.keyframeRequestAtMs],
    closures: [...recorder.closures],
    lastSentAtMs: recorder.lastSentAtMs,
    windowClosedAtMs: recorder.windowClosedAtMs,
    avSkewMs: joined.avSkewMs(),
    uplinkBps: joined.uplinkBps(),
    downlinkBps: joined.downlinkBps(),
    participantCount: joined.participants(),
    closeNotes: [],
    logs: [],
  };
}

const EMPTY: SdkDegradeParticipant = {
  label: "",
  avSkewMs: 0,
  sentVideo: [],
  encodedVideoCount: 0,
  encodedAudioCount: 0,
  decoderEvents: { configure: 0, reset: 0, close: 0, error: 0 },
  decoderIo: { created: 0, configured: 0, submitted: 0, output: 0, failed: 0, messages: [] },
  audioIo: { submitted: 0, played: 0 },
  socketStats: [],
  sentAudio: [],
  received: [],
  decoded: [],
  playedAudio: [],
  arrived: [],
  keyframeRequestAtMs: [],
  closures: [],
  lastSentAtMs: 0,
  windowClosedAtMs: 0,
  uplinkBps: 0,
  downlinkBps: 0,
  participantCount: 0,
  closeNotes: [],
  logs: [],
};

/**
 * **1 つのページで 1 人だけを回す。**
 *
 * なぜ 1 人ずつにするか: 1 つのタブで 2 人ぶん（実符号化器 + 実復号器 + 画素のハッシュ）を
 * 回すと主筋が競合し、**到着は安定しているのに提示だけが揺れる**（実測: 到着 643/644 で
 * 一定なのに、提示は回ごとに 99〜728 枚、描画の間隔は最悪 5.5 秒）。実際の会議は端末が
 * 別であるから、ページを分ける方が現実に近く、器の重さを測定に混ぜない。
 *
 * 記録は**切らずに全部返す**。暖機の切り落としは Node 側の純関数が内容（取得時刻）で行う
 * （`tests/support/sdk-degrade-record.ts`）。ページごとに切ると、送信側と受信側で切る位置が
 * 揃わない。
 */
async function runOne(
  spec: Spec,
  meetingId: string,
  tokenKey: string,
  participantCount: number,
  durationMs: number,
): Promise<SdkDegradeParticipant> {
  installSocketWatch();
  installDecoderWatch();
  const logs: string[] = [];
  const joined = await joinOne(spec, meetingId, tokenKey, logs);
  if (joined === null) {
    return { ...EMPTY, label: spec.label, logs, closeNotes: [...closeNotes] };
  }

  // 名簿が行き渡るまで待つ。**互いを認識する前に測り始めると、購読が張られる前の
  // 期間を「欠落」と読む。**
  const deadlineForRoster = Date.now() + 30_000;
  while (Date.now() < deadlineForRoster) {
    if (joined.participants() >= participantCount) {
      break;
    }
    await sleep(500);
  }

  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    await sleep(500);
  }
  // **窓を閉じた時刻を控える。** これより後に送ったものは判定しない（`windowClosedAtMs`）。
  joined.recorder.windowClosedAtMs = Date.now();
  // 経路に残っているものを数え切る。窓の中で送ったものが届くのを待つ。
  await sleep(3000);

  const result = snapshot(joined);
  joined.leave();
  return { ...result, logs, closeNotes: [...closeNotes] };
}

/**
 * 走行中の観測（段 E で経過を刻むために使う）。
 * 記録そのものは終わりに返すため、ここでは数だけを返す。
 */
function currentCounts(): Record<string, number> {
  const recorder = activeRecorder;
  if (recorder === null) {
    return {};
  }
  return {
    sentVideo: recorder.sentVideo.length,
    sentAudio: recorder.sentAudio.length,
    arrived: recorder.arrived.length,
    decoded: recorder.decoded.length,
    presented: recorder.received.length,
    playedAudio: recorder.playedAudio.length,
    keyframeRequests: recorder.keyframeRequestAtMs.length,
    closures: recorder.closures.length,
    socketsOpened: [...socketStats.values()].reduce((total, entry) => total + entry.opened, 0),
    decoderCreated: decoderIo.created,
    decoderFailed: decoderIo.failed,
    decoderOutput: decoderIo.output,
  };
}

window.__whesoCounts = (): Record<string, number> => currentCounts();

/**
 * 開いている接続を全部落とす（段 E）。
 *
 * **コードなしで落とす。** 実行環境や回線が落ちたときと同じ形にするためである。規範の
 * 閉鎖コードで閉じると、そのコードに応じた振る舞い（自動再接続の可否）が選ばれてしまい、
 * 「経路が切れた」ことの試験にならない。
 */
window.__whesoDropLinks = (): string => {
  const detail: string[] = [];
  for (const [socket, kind] of [...liveSockets.entries()]) {
    const before = socket.readyState;
    socket.close();
    detail.push(`${kind}:${String(before)}→${String(socket.readyState)}`);
  }
  return detail.join(",");
};

window.__whesoDegradeOne = async (spec, meetingId, tokenKey, participantCount, durationMs) => {
  try {
    return await runOne(spec, meetingId, tokenKey, participantCount, durationMs);
  } catch (error) {
    return {
      ...EMPTY,
      label: spec.label,
      logs: [error instanceof Error ? `${error.name}: ${error.message}` : "不明な失敗"],
      closeNotes: [...closeNotes],
    };
  }
};

// 破棄可否の判定に使う旗を器でも参照する（数値を書かないため生成物から引く）。
void FLAG_KEY;
