/**
 * 参加の入口。
 *
 * 規範: sdk-api.md 1 節（最小の呼び出しと行数予算）、2 節（設定）、
 * client-architecture.md 2 節（5 個の部屋への接続）、wire-format.md 2.1〜2.4。
 *
 * ここは端である。時刻・接続・カメラの取得を扱い、判断は持たない。
 * 環境依存はすべて注入する。理由は 2 つある。第 1 に、判断コアと同じく
 * 試験で決定的に動かせること。第 2 に、カメラの無い CI で検証できること（Q-020）。
 *
 * 失敗は例外ではなく `Result` で返す（lint-policy.md 原則 1）。
 */

import { type Result, err, ok } from "@wheso/core/src/result.ts";
import {
  buildLadderAnnounce,
  deriveLadder,
  type SendRung,
  type SourceSpec,
} from "@wheso/core/src/ladder.ts";
import { dropOf, initialUplink, noteBufferedAmount, noteEncodeQueue } from "@wheso/core/src/uplink.ts";
import { createLink, type Link, type LinkSocket } from "./link.ts";
import {
  createPipeline,
  handleMedia,
  handleReportTimer,
  noteDecodeError,
  noteFramerate,
  noteRouteChange,
  qualitySnapshot,
  receivedSpatialId,
  releaseSenderState,
  type PipelineDeps,
} from "./receive-pipeline.ts";
import { readClaimsUnverified } from "@wheso/core/src/auth.ts";
import {
  CHANNEL_AUDIO,
  CHANNEL_SCREEN_AUDIO,
  CHANNEL_SCREEN_VIDEO,
  CHANNEL_VIDEO,
  MAX_TEMPORAL_ID,
  PROTOCOL_VERSION,
} from "@wheso/core/src/generated/wire-layout.ts";
import {
  HEARTBEAT_INTERVAL_MS,
  REPORT_INTERVAL_MS,
  V_1080P60,
  V_360P15,
  V_4K60,
  V_SHARD_MAX_PARTICIPANTS,
} from "@wheso/core/src/generated/constants.ts";

/**
 * 同時に持つ復号器の上限。
 *
 * 端末の能力で決めるのが本来である（`client-architecture.md` 4 節の規則 1）。
 * 能力の実測（Q-016）が済むまでは、単一シャードの収容人数から上限を取る。
 * 1 シャードに入る人数を超えて復号する状況は存在しない。
 */
const MAX_CONCURRENT_DECODERS = V_SHARD_MAX_PARTICIPANTS;

/** 購読の希望。段は受信ノードが決めるため、ここでは「誰を見たいか」だけを持つ。 */
interface SubscribeWish {
  readonly senderId: number;
  readonly channel: number;
  readonly maxSpatialId: number;
  readonly maxTemporalId: number;
}

import { createParticipantSink } from "../render/participant-sink.ts";
import { browserMediaDeps } from "../media/browser-media.ts";
import { browserCaptureDeps, type CaptureDeps } from "../media/browser-capture.ts";
import {
  createSendPipeline,
  flushAudio,
  handleEncodedAudio,
  handleEncodedVideo,
  uplinkBpsOf,
  type SendDeps,
} from "./send-pipeline.ts";

import { parseJoinUrl, planRooms, roomUrl, type PersonalRoomRole } from "./join-url.ts";
import {
  createMeeting,
  senderIdOf,
  type FrameSink,
  type MediaFrame,
  type Meeting,
  type ParticipantRole,
} from "./meeting.ts";
import type { DeviceCapability, ProfileId } from "../media/capability.ts";

export interface JoinError {
  readonly code: string;
  readonly detail: string;
}

/**
 * 接続 1 本の最小の形。実装は WebSocket でも試験の偽物でもよい。
 *
 * **`onBinary` / `onOpen` / `onClose` を省略可能にしてはならない。** 省略できると
 * 「バイナリを受け取る口を配線し忘れても型検査が通る」状態になる。段 F まで実際に
 * その状態であり、SDK はメディアを 1 バイトも受け取れなかった。
 */
export type JoinSocket = LinkSocket;

/**
 * 端から入口へ返ってくる出力の口。
 *
 * **省略可能にしてはならない。** 省略できると「復号したフレームの行き先を配線し忘れても
 * 型検査が通る」状態になる。段 F の F-6 まで実際にその状態であり、既定の注入は
 * `onFrame` に何もしない関数を入れていたため、復号できた映像は捨てられていた。
 */
export interface FrameOutput {
  /** 復号できた映像 1 枚。senderId から参加者を引いて受け皿へ渡す。 */
  readonly onFrame: (senderId: number, frame: MediaFrame) => void;
  /** 復号に失敗した。キーフレームを要求し直す。 */
  readonly onDecodeError: (senderId: number, channel: number) => void;
  /** 受け皿の寸法が変わった。受信部屋へ申告する。 */
  readonly onDisplaySize: (participantId: string, width: number, height: number) => void;
}

/** 環境依存の注入。 */
export interface JoinDeps {
  /** 部屋の URL へ接続する。失敗した場合は null を返す（例外を投げない）。 */
  readonly openSocket: (url: string, role: PersonalRoomRole) => JoinSocket | null;
  /** 参加者ごとの受け皿を作る。復号したフレームの宛先になる。 */
  readonly createSink: (participantId: string) => FrameSink;
  /**
   * 端からの出力を入口へ繋ぐ。**必須**である。
   *
   * 入口は接続を開く前にこれを呼び、フレーム・復号の失敗・寸法の申告の宛先を渡す。
   * 呼ばれる前に届いた出力は宛先が無いため捨てられる（接続前であり実際には届かない）。
   */
  readonly bindOutput: (output: FrameOutput) => void;
  /** 能力探査の結果。送信プロファイルの決定に使う（sdk-api.md 2 節）。 */
  readonly capability: DeviceCapability;
  /**
   * 送信源の実測値（`MediaStreamTrack.getSettings()` 由来）。
   *
   * **はしごは源から導出する**（ADR-0026）。源より大きい段を作ってはならないため、
   * 実測値が必要である。取得できない環境では最下段の代表点を渡す。
   */
  readonly source: SourceSpec;
  /** 論理時刻。 */
  readonly now: () => number;
  /** 指定した時刻に 1 度だけ起こす。取り消しの関数を返す。 */
  readonly scheduleAt: (atMs: number, fire: () => void) => () => void;
  /** 一定間隔で繰り返し起こす。取り消しの関数を返す。 */
  readonly setPeriodic: (intervalMs: number, fire: () => void) => () => void;
  /**
   * 復号と音声再生の口（`client-architecture.md` 4 節）。
   *
   * WebCodecs と AudioWorklet はブラウザにしか無い。判断を純関数に閉じたまま端だけを
   * 差し替えるため注入する。カメラの無い環境（CI）でも受信経路そのものを検証できる。
   */
  readonly media: MediaDeps;
  /**
   * 取得と符号化の口（`client-architecture.md` 3 節）。
   *
   * **省略可能にしてはならない。** 省略できると「送信経路を配線し忘れても型検査が通る」
   * 状態になる。段 F まで実際にその状態であり、SDK は 1 バイトも送れなかった。
   */
  readonly capture: CaptureDeps;
}

/** 復号と音声再生の口。`receive-pipeline` の副作用のうち環境依存のものである。 */
export type MediaDeps = Omit<PipelineDeps, "now" | "sendReceiveControl">;

/** 設定（sdk-api.md 2 節）。全項目が省略可能である。 */
export interface JoinOptions {
  readonly camera?: boolean;
  readonly microphone?: boolean;
  readonly videoProfile?: "auto" | ProfileId;
  readonly audioProfile?: "voice" | "music";
  readonly maxReceiveHighQuality?: "auto" | number;
  readonly lowLatencyMode?: boolean;
  readonly displayName?: string;
  /** トークンの取得。既定は URL のフラグメントから取る（有効期間 60 秒。auth.md 3.3）。 */
  readonly tokenProvider?: () => string;
  readonly onError?: (code: string) => void;
}

/** 参加した結果。接続の実体を返すのは、入口が閉じるためである。 */
export interface JoinedMeeting {
  readonly meeting: Meeting;
  /**
   * 役割ごとのリンク。利用者は触らない。
   *
   * リンクは接続状態機械（`state-machines.md` 1 節）を持ち、切れたら自分で再接続し、
   * そのたびに `hello` と `streamAnnounce` と `subscribe` を送り直す（ADR-0032）。
   */
  readonly links: ReadonlyMap<PersonalRoomRole, Link>;
}

/**
 * 参加 URL から senderId を導く。ワイヤの senderId は 32 bit の非 0 整数である。
 * 算出は `meeting.ts` の 1 箇所に置く（表示寸法の申告でも同じ値が必要である）。
 */
export const senderIdFrom = senderIdOf;

/**
 * ブラウザ既定の注入。
 *
 * 規範 1 節の最小例は `joinMeeting(location.href)` である。注入を必須にすると
 * 行数予算を満たせないため、既定を用意する。ブラウザ以外（試験・移植）では
 * 呼び出し側が注入を渡す。
 *
 * 能力探査は非同期であるため、ここでは結果を引数で受ける。探査の実行は
 * `probeCapability` が行う（判定そのものは `capability.ts` の純関数である）。
 *
 * **出力の宛先はモジュールの大域に置かない。** 以前は表示寸法の中継を大域変数に
 * 持っていたため、同じページで 2 つの会議に参加すると後から参加した方が前の方の
 * 中継を上書きした。宛先はこの関数の閉包に持ち、`bindOutput` で受け取る。
 */
export function browserDeps(capability: DeviceCapability, source: SourceSpec): JoinDeps | null {
  if (typeof globalThis.WebSocket !== "function") {
    // WebSocket が無い環境では既定を作れない。呼び出し側が注入する。
    return null;
  }
  // 入口が `bindOutput` を呼ぶまでは宛先が無い。接続を開く前に呼ばれるため、
  // この間に出力が発生することはない。
  let bound: FrameOutput | null = null;
  return {
    bindOutput: (output): void => {
      bound = output;
    },
    openSocket: (url): LinkSocket | null => {
      const socket = new globalThis.WebSocket(url);
      // 二進で受け取る。既定は Blob であり、そのままでは同期に読めない。
      socket.binaryType = "arraybuffer";
      const textHandlers: ((text: string) => void)[] = [];
      const binaryHandlers: ((bytes: Uint8Array) => void)[] = [];
      const openHandlers: (() => void)[] = [];
      const closeHandlers: ((code: number) => void)[] = [];
      socket.addEventListener("open", () => {
        for (const handler of openHandlers) {
          handler();
        }
      });
      socket.addEventListener("close", (event: CloseEvent) => {
        for (const handler of closeHandlers) {
          handler(event.code);
        }
      });
      socket.addEventListener("error", () => {
        // `error` の直後に必ず `close` が来る。二重に伝えない。
      });
      socket.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data === "string") {
          for (const handler of textHandlers) {
            handler(event.data);
          }
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data);
          for (const handler of binaryHandlers) {
            handler(bytes);
          }
          return;
        }
        // `binaryType` を設定していても、実装差で Blob が来ることがある。捨てない。
        if (event.data instanceof Blob) {
          void event.data.arrayBuffer().then((buffer) => {
            const bytes = new Uint8Array(buffer);
            for (const handler of binaryHandlers) {
              handler(bytes);
            }
          });
        }
      });
      return {
        // **確立前に送らない。** 送ると «Still in CONNECTING state» の例外になる。
        // 溜めるのはリンク（`api/link.ts`）の責務であり、ここでは落とすだけにする。
        send: (text: string): void => {
          if (socket.readyState === socket.OPEN) {
            socket.send(text);
          }
        },
        sendBinary: (bytes: Uint8Array): void => {
          if (socket.readyState === socket.OPEN) {
            socket.send(bytes);
          }
        },
        close: (): void => socket.close(),
        onText: (handler): void => {
          textHandlers.push(handler);
        },
        onBinary: (handler): void => {
          binaryHandlers.push(handler);
        },
        onOpen: (handler): void => {
          openHandlers.push(handler);
        },
        onClose: (handler): void => {
          closeHandlers.push(handler);
        },
        bufferedBytes: (): number => socket.bufferedAmount,
      };
    },
    scheduleAt: (atMs, fire): (() => void) => {
      const delay = atMs - Date.now();
      const timer = globalThis.setTimeout(fire, delay > 0 ? delay : 0);
      return (): void => globalThis.clearTimeout(timer);
    },
    setPeriodic: (intervalMs, fire): (() => void) => {
      const timer = globalThis.setInterval(fire, intervalMs);
      return (): void => globalThis.clearInterval(timer);
    },
    media: browserMediaDeps({
      // 提示の門が使う時計とタイマー。**判断コアには時刻を持ち込まない**（AGENTS 5.4 の 9）。
      now: (): number => Date.now(),
      scheduleAt: (atMs, fire): (() => void) => {
        const timer = globalThis.setTimeout(fire, Math.max(0, atMs - Date.now()));
        return (): void => globalThis.clearTimeout(timer);
      },
      onFrame: (senderId, frame) => bound?.onFrame(senderId, frame),
      onDecodeError: (senderId, channel) => bound?.onDecodeError(senderId, channel),
    }),
    capture: browserCaptureDeps(),
    createSink: (participantId) =>
      createParticipantSink((width, height) => {
        bound?.onDisplaySize(participantId, width, height);
      }),
    capability,
    source,
    now: () => Date.now(),
  };
}

/**
 * ブラウザの符号化能力を探る（sdk-api.md 2 節の手順 1〜3）。
 *
 * 判定そのものは純関数（`selectProfiles`）が行う。ここは探査だけである。
 * 探査できない環境では「AV1 不可」として扱う。安全側に倒す。
 */
export async function probeCapability(): Promise<DeviceCapability> {
  const fallback: DeviceCapability = {
    hardwareAv1For4K60: false,
    encodeAv1: false,
    mobile: false,
    charging: true,
  };
  const encoder = Reflect.get(globalThis, "VideoEncoder");
  if (typeof encoder !== "function") {
    return fallback;
  }
  const isConfigSupported = Reflect.get(encoder, "isConfigSupported");
  if (typeof isConfigSupported !== "function") {
    return fallback;
  }
  const check = async (config: Record<string, unknown>): Promise<boolean> => {
    try {
      const result: unknown = await Reflect.apply(isConfigSupported, encoder, [config]);
      if (typeof result !== "object" || result === null) {
        return false;
      }
      return Reflect.get(result, "supported") === true;
    } catch {
      // 探査の失敗は「使えない」として扱う。例外を上へ投げない。
      return false;
    }
  };
  const hardware4K60 = await check({
    codec: "av01.0.08M.08",
    width: V_4K60.width,
    height: V_4K60.height,
    framerate: V_4K60.framerate,
    bitrate: V_4K60.targetBitrate,
    scalabilityMode: V_4K60.scalabilityMode,
    hardwareAcceleration: "prefer-hardware",
  });
  const av1 = await check({
    codec: "av01.0.08M.08",
    width: V_1080P60.width,
    height: V_1080P60.height,
    framerate: V_1080P60.framerate,
    bitrate: V_1080P60.targetBitrate,
    scalabilityMode: V_1080P60.scalabilityMode,
  });
  return { hardwareAv1For4K60: hardware4K60, encodeAv1: av1, mobile: false, charging: true };
}

/**
 * 会議に参加する。
 *
 * 手順:
 *   1. 参加 URL を解析する（`https://<host>/j/<meetingId>#<token>`）
 *   2. 5 個の部屋名を計算する（room-naming.md）
 *   3. 5 本の接続を開き、各接続へ `hello` を送る
 *   4. 送信プロファイルを決めて `streamAnnounce` を送る
 *   5. ctl 部屋の `participants` を `Meeting` へ反映する
 *
 * 描画は行わない（ADR-0015）。受け皿は参加者ごとに作る。
 * `deps` を省略した場合はブラウザ既定を使う。
 */
export async function joinMeeting(
  url: string,
  options: JoinOptions = {},
  deps?: JoinDeps,
): Promise<Result<JoinedMeeting, JoinError>> {
  const resolved = deps ?? (await defaultDeps());
  if (resolved === null) {
    return err({ code: "E_TRANSPORT", detail: "この環境には既定の注入が無い" });
  }
  return await joinWith(url, resolved, options);
}

/** 既定の注入を作る。出力の宛先は入口が `bindOutput` で渡す。 */
async function defaultDeps(): Promise<JoinDeps | null> {
  const capability = await probeCapability();
  // 源の実測は取得（`startCapture`）が返す。ここでは最低段を既定として渡す。
  // **寸法を測るためだけにカメラを開いてはならない**（開いたまま捨てる実装になっていた）。
  const source: SourceSpec = {
    width: V_360P15.width,
    height: V_360P15.height,
    framerate: V_360P15.framerate,
  };
  return browserDeps(capability, source);
}

/** 注入を明示して参加する。試験と移植で使う。 */
export async function joinWith(
  url: string,
  deps: JoinDeps,
  options: JoinOptions = {},
): Promise<Result<JoinedMeeting, JoinError>> {
  const target = parseJoinUrl(url);
  if (!target.ok) {
    return err({ code: target.error.code, detail: target.error.detail });
  }
  const token = options.tokenProvider === undefined ? target.value.token : options.tokenProvider();
  if (token.length === 0) {
    return err({ code: "E_AUTH", detail: "トークンが無い" });
  }

  // 部屋名の導出には利用者 ID が必要である。署名の検証はここでは行わない
  // （全ノードが検証する。auth.md 3.4）。
  const claims = readClaimsUnverified(token);
  if (!claims.ok) {
    return err({ code: claims.error.code, detail: claims.error.detail });
  }
  const userId = claims.value.sub;

  const plan = planRooms(target.value.meetingId, userId);
  if (!plan.ok) {
    return err({ code: plan.error.code, detail: plan.error.detail });
  }

  const senderId = senderIdFrom(userId);

  // 参加者ごとの表示寸法の申告を受信部屋へ写すための中継。参加後に配線する。
  let sendVideoReceive: (text: string) => void = () => undefined;

  const hello = JSON.stringify({
    t: "hello",
    protocolVersion: PROTOCOL_VERSION,
    token,
    senderId,
    capabilities: {
      decodeAv1: deps.capability.encodeAv1,
      encodeAv1: deps.capability.encodeAv1,
      platform: "browser",
    },
  });

  // はしごを源から導出する（ADR-0026）。**源より大きい段を作らない。**
  // 再接続のたびに送り直すため、本文を作る関数として持つ。
  let uplink = initialUplink();
  // 源は取得（`startCapture`）の実測で置き換わる。注入された値は取得できない環境の既定である。
  let source: SourceSpec = deps.source;
  const ladderFor = (drop: number): readonly SendRung[] =>
    deriveLadder(source, "camera", {
      hardwareAv1For4K60: deps.capability.hardwareAv1For4K60,
      encodeAv1: deps.capability.encodeAv1,
      mobile: deps.capability.mobile,
      charging: deps.capability.charging,
      // 上り輻輳と発熱で段を落とす（congestion.md 3 節、client-architecture.md 10 節）。
      thermalDrop: drop,
    });
  let ladder = ladderFor(0);
  const announceText = (): string => buildLadderAnnounce(CHANNEL_VIDEO, ladder);

  /**
   * 購読の一覧。**再接続のたびに送り直す**（ADR-0032）。
   *
   * 段は受信ノードが決める（画質の判断主体を移さない）。クライアントが送るのは
   * 「誰を見たいか」だけであり、初期値は最低段である（congestion.md 6 節）。
   */
  const wanted = new Map<string, SubscribeWish>();

  /**
   * 部屋ごとに扱うチャネル。
   *
   * **映像の購読を音声受信部屋へ送ってはならない。** 5 部屋に分けた設計の意味が消え、
   * 同じ媒体が 2 経路で二重に届く。購読は (購読者, 送信者, チャネル) で一意である
   * （wire-format.md 2.4）。
   */
  const channelsOf = (role: PersonalRoomRole): readonly number[] => {
    if (role === "vr") {
      return [CHANNEL_VIDEO, CHANNEL_SCREEN_VIDEO];
    }
    if (role === "ar") {
      return [CHANNEL_AUDIO, CHANNEL_SCREEN_AUDIO];
    }
    return [];
  };

  const subscribeTextFor = (role: PersonalRoomRole): string => {
    const channels = channelsOf(role);
    const entries = [...wanted.values()]
      .filter((entry) => channels.includes(entry.channel))
      .sort((a, b) => (a.senderId !== b.senderId ? a.senderId - b.senderId : a.channel - b.channel));
    if (entries.length === 0) {
      return "";
    }
    return JSON.stringify({
      t: "subscribe",
      entries: entries.map((entry) => ({
        senderId: entry.senderId,
        channel: entry.channel,
        maxSpatialId: entry.maxSpatialId,
        maxTemporalId: entry.maxTemporalId,
      })),
    });
  };

  const camera = options.camera ?? true;
  const microphone = options.microphone ?? true;

  const links = new Map<PersonalRoomRole, Link>();
  let pipeline = createPipeline(MAX_CONCURRENT_DECODERS, deps.now());
  let send = createSendPipeline(deps.now());

  const sendDeps: SendDeps = {
    sendVideo: (bytes): void => links.get("vs")?.sendBinary(bytes),
    sendAudio: (bytes): void => links.get("as")?.sendBinary(bytes),
    now: deps.now,
  };

  const pipelineDeps: PipelineDeps = {
    ...deps.media,
    now: deps.now,
    sendReceiveControl: (text): void => sendVideoReceive(text),
  };

  const roles: readonly PersonalRoomRole[] = ["ctl", "vs", "vr", "as", "ar"];
  for (const role of roles) {
    const room = plan.value[role];
    const address = roomUrl(target.value.host, room, target.value.secure);
    if (!address.ok) {
      closeAll(links);
      return err({ code: address.error.code, detail: address.error.detail });
    }
    const url_ = address.value;
    // 予備接続を持つのは受信側のみである（client-architecture.md 2 節）。
    // 送信側の停滞は自分のエンコーダを絞れば解消するため予備を持たない。
    const receiving = role === "vr" || role === "ar";
    const link = createLink({
      openSocket: (): LinkSocket | null => deps.openSocket(url_, role),
      now: deps.now,
      scheduleAt: deps.scheduleAt,
      helloText: (): string => hello,
      announceText: (): string => (role === "vs" ? announceText() : ""),
      subscribeText: (): string => subscribeTextFor(role),
      onMedia: (bytes): void => {
        if (!receiving) {
          return;
        }
        pipeline = handleMedia(pipeline, bytes, pipelineDeps);
      },
      onText: (text): void => {
        if (role === "ctl") {
          applyControlMessage(meeting, text, deps.now(), controlHooks);
          return;
        }
        if (role === "vs") {
          // 送信部屋からの要求に応える。応えないとキーフレームが永久に出ず、
          // 段を切り替えた購読者は黒画面のままになる（wire-format.md 2.5）。
          applySendControl(text, deps.capture);
        }
      },
      onWarn: (code): void => meeting.warn(code),
      onFail: (code): void => meeting.fail(String(code)),
      onRouteChange: (): void => {
        // 経路が変わった。再生クロックの対応付けを作り直させる（ADR-0028）。
        for (const clock of pipeline.playout.clocks) {
          pipeline = noteRouteChange(pipeline, clock.senderId);
        }
      },
      usesStandby: receiving,
    });
    links.set(role, link);
  }

  sendVideoReceive = (text): void => links.get("vr")?.send(text);

  const meeting = createMeeting({
    meetingId: target.value.meetingId,
    selfId: userId,
    displayName: options.displayName ?? "",
    links: {
      sendControl: (text) => links.get("ctl")?.send(text),
      sendVideoReceiveControl: (text) => links.get("vr")?.send(text),
      closeAll: () => {
        cancelHeartbeat();
        cancelReport();
        // **溜まっている音声を送り切る**（音声は決して捨てない。wire-format.md 1.4）。
        send = flushAudio(send, senderId, sendDeps);
        deps.capture.close();
        closeAll(links);
      },
    },
    sinks: { create: (participantId) => deps.createSink(participantId) },
  });

  /**
   * ワイヤの senderId から参加者 ID を引く表。
   *
   * 復号できたフレームは senderId で届く。受け皿は参加者 ID で引く。**この対応が無いと
   * 復号したフレームの宛先が分からず、捨てるしかない。** 参加と退出で保守する。
   */
  const participantBySender = new Map<number, string>();

  /** 送信者ごとの、現在受信している段の呼び名（`Participant.receivedProfile`）。 */
  const catalog = new Map<string, readonly CatalogRungView[]>();

  /** 購読を該当する部屋へ送る。空の本文は送らない。 */
  const sendSubscriptions = (): void => {
    for (const role of ["vr", "ar"] as const) {
      const text = subscribeTextFor(role);
      if (text.length > 0) {
        links.get(role)?.send(text);
      }
    }
  };

  const controlHooks: ControlHooks = {
    onError: options.onError,
    onCatalog: (entries): void => {
      for (const entry of entries) {
        catalog.set(`${String(entry.senderId)}:${String(entry.channel)}`, entry.rungs);
        // 停止の判定とバッファ深度の算出に fps が必要である（constants.md 7 節）。
        // 申告が無いと停止を 1 度も記録できない。
        const top = entry.rungs[entry.rungs.length - 1];
        if (top !== undefined) {
          pipeline = noteFramerate(pipeline, entry.senderId, top.framerate);
        }
      }
    },
    onMediaState: (participantId, kind, enabled): void => {
      meeting.updateParticipant(
        participantId,
        kind === "camera" ? { cameraEnabled: enabled } : { microphoneEnabled: enabled },
      );
    },
  };

  // 参加者が現れたら購読の希望に加える。段は最低から始める（ADR-0028 の原則）。
  meeting.on("participantJoined", (participant) => {
    if (participant.id === userId) {
      return;
    }
    const target_ = senderIdFrom(participant.id);
    participantBySender.set(target_, participant.id);
    for (const channel of [CHANNEL_VIDEO, CHANNEL_AUDIO]) {
      wanted.set(`${String(target_)}:${String(channel)}`, {
        senderId: target_,
        channel,
        maxSpatialId: 0,
        maxTemporalId: MAX_TEMPORAL_ID,
      });
    }
    sendSubscriptions();
  });

  meeting.on("participantLeft", (participantId) => {
    const target_ = senderIdFrom(participantId);
    participantBySender.delete(target_);
    for (const channel of [CHANNEL_VIDEO, CHANNEL_AUDIO, CHANNEL_SCREEN_VIDEO, CHANNEL_SCREEN_AUDIO]) {
      wanted.delete(`${String(target_)}:${String(channel)}`);
      catalog.delete(`${String(target_)}:${String(channel)}`);
    }
    pipeline = releaseSenderState(pipeline, target_, pipelineDeps);
    // 受信部屋へ退出を伝える。伝えないと受信ノードは居ない相手の受信位置を持ち続け、
    // ack を返し続ける（`receiver-core` の `leave`）。
    const leaveText = JSON.stringify({ t: "leave", senderId: target_ });
    links.get("vr")?.send(leaveText);
    links.get("ar")?.send(leaveText);
    // 購読を送り直す。送らないと受信ノードは退出した相手を購読し続ける。
    sendSubscriptions();
  });

  /**
   * 端からの出力を繋ぐ。**接続を開く前に行う。**
   *
   * ここが無いと、復号できた映像はどこへも行かない。段 F の F-6 まで実際にそうであった。
   */
  deps.bindOutput({
    onFrame: (senderId, frame): void => {
      const participantId = participantBySender.get(senderId);
      if (participantId === undefined) {
        // 参加者一覧に無い送信者のフレーム。捨てる（宛先が無い）。
        return;
      }
      meeting.sinkFor(participantId)?.draw(frame);
      // 生のフレームを使う利用者へも渡す（購読していなければ発火しない）。
      meeting.deliverFrame(participantId, frame);
      const profile = profileNameOf(catalog, senderId, CHANNEL_VIDEO, receivedSpatialId(pipeline, senderId));
      if (profile !== null) {
        meeting.updateParticipant(participantId, { receivedProfile: profile });
      }
    },
    onDecodeError: (senderId, channel): void => {
      // 復号が壊れた。キーフレームを要求し直す（wire-format.md 2.5）。
      pipeline = noteDecodeError(pipeline, senderId, channel, pipelineDeps);
    },
    onDisplaySize: (participantId, width): void => {
      meeting.reportDisplaySize(participantId, CHANNEL_VIDEO, width);
    },
  });

  /**
   * 符号化できたものを送る。
   *
   * **判断は持たない。** 連番と束ねは `send-pipeline` が決め、破棄可否は `wire.ts` が決める。
   */
  deps.capture.bindCapture({
    onVideo: (video): void => {
      send = handleEncodedVideo(send, senderId, video, sendDeps);
    },
    onAudio: (frame): void => {
      send = handleEncodedAudio(send, senderId, frame, sendDeps);
    },
  });

  // 取得を始める。源の実測が返るため、はしごを作り直して申告する（ADR-0026）。
  const started = await deps.capture.startCapture({ camera, microphone });
  if (started.source !== null) {
    source = started.source;
    ladder = ladderFor(dropOf(uplink));
  }
  deps.capture.configureVideo(ladder);
  if (started.audio) {
    deps.capture.configureAudio(options.audioProfile ?? "voice");
  }
  deps.capture.setVideoEnabled(camera);
  deps.capture.setAudioEnabled(microphone);

  // カメラとマイクの操作を取得へ写す。写さないと利用者が消音しても送り続ける。
  meeting.on("participantUpdated", (participant) => {
    if (participant.id !== userId) {
      return;
    }
    deps.capture.setVideoEnabled(participant.cameraEnabled);
    deps.capture.setAudioEnabled(participant.microphoneEnabled);
  });

  /**
   * 心拍。`HEARTBEAT_INTERVAL_MS` ごとに全部屋へ送る（timeouts の規範）。
   *
   * **これが無いとノードが起き続けない。** Durable Object は入力が無い間に停止し得る。
   * 停止すると、背後で進めているノード間接続の確立（`stub.socket()`）が完了せず、
   * 参加者名簿とはしごが配られない（実測: 制御ノードが `meta` へ登録できなかった）。
   * 規範の心拍は接続の死活監視のためだが、ノードの起動維持も兼ねる。
   */
  const cancelHeartbeat = deps.setPeriodic(HEARTBEAT_INTERVAL_MS, () => {
    const beat = JSON.stringify({ t: "heartbeat" });
    for (const link of links.values()) {
      link.send(beat);
    }
  });

  // 報告の周期。測定値は受信部屋へ送る（wire-format.md 2.6、ADR-0021）。
  const cancelReport = deps.setPeriodic(REPORT_INTERVAL_MS, () => {
    pipeline = handleReportTimer(pipeline, pipelineDeps);
    links.get("vr")?.noteReportTimer();
    links.get("ar")?.noteReportTimer();

    // 観測値を利用側へ渡す（sdk-api.md 3 節の `quality`）。
    const snapshot = qualitySnapshot(pipeline, deps.now());
    meeting.setQuality({
      downlinkBps: snapshot.downlinkBps,
      uplinkBps: uplinkBpsOf(send),
      delayTrendNumerator: snapshot.delayTrendNumerator,
      delayTrendDenominator: snapshot.delayTrendDenominator,
      stallRatioPerMille: snapshot.stallRatioPerMille,
      avSkewMs: snapshot.avSkewMs,
    });

    // 停止が続いたらリンクへ伝える。`VIDEO_STALL_RESET_MS` を超えると予備接続へ切り替わる
    // （state-machines.md 1 節）。伝えないと切替が一度も起きない。
    if (snapshot.stalledForMs > 0) {
      links.get("vr")?.noteStall(snapshot.stalledForMs);
    }
    // 遅延の趨勢もリンクへ伝える（`DEGRADED` への遷移と警告のため）。
    links.get("vr")?.noteTrend(snapshot.degrading);

    // 上り輻輳を観測する（congestion.md 3 節、ADR-0014）。
    // **下りの制御ではこれを直せない。** 原因が自分の送出側にあるためである。
    const sender = links.get("vs");
    if (sender === undefined) {
      return;
    }
    const observed = noteBufferedAmount(uplink, sender.bufferedBytes(), ladder.length, deps.now());
    uplink = observed.state;
    // 符号化の待ち行列も見る（CPU と発熱による降格。ADR-0014、client-architecture.md 10 節）。
    const queued = noteEncodeQueue(observed.state, deps.capture.encodeQueueSize(), ladder.length, deps.now());
    uplink = queued.state;
    if (!observed.changed && !queued.changed) {
      return;
    }
    // 段数が変わった。はしごを作り直し、符号化器と申告の両方を合わせる（ADR-0026 の 6）。
    ladder = ladderFor(dropOf(uplink));
    deps.capture.configureVideo(ladder);
    sender.send(announceText());
  });

  // 5 本の接続を開く。以後の再接続はリンクが自分で行う。
  for (const link of links.values()) {
    link.open();
  }

  return ok({ meeting, links });
}

/** カタログの 1 段（クライアントが `receivedProfile` の呼び名に使う分だけ）。 */
export interface CatalogRungView {
  readonly spatialId: number;
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
}

/** カタログの 1 件。 */
export interface CatalogEntryView {
  readonly senderId: number;
  readonly channel: number;
  readonly rungs: readonly CatalogRungView[];
}

/** ctl 部屋のメッセージを入口へ返す取っ手。 */
export interface ControlHooks {
  readonly onError?: ((code: string) => void) | undefined;
  /** はしごの一覧が届いた（`streamCatalog`。ADR-0027 の 1）。 */
  readonly onCatalog: (entries: readonly CatalogEntryView[]) => void;
  /** 参加者の媒体の状態が変わった。 */
  readonly onMediaState: (participantId: string, kind: "camera" | "microphone", enabled: boolean) => void;
}

/**
 * 段の呼び名を作る（`Participant.receivedProfile`）。
 *
 * カタログに無い、または段が未確定の場合は null を返す。**推測で名前を作らない。**
 */
function profileNameOf(
  catalog: ReadonlyMap<string, readonly CatalogRungView[]>,
  senderId: number,
  channel: number,
  spatialId: number,
): string | null {
  if (spatialId < 0) {
    return null;
  }
  const rungs = catalog.get(`${String(senderId)}:${String(channel)}`);
  if (rungs === undefined) {
    return null;
  }
  for (const rung of rungs) {
    if (rung.spatialId === spatialId) {
      return `${String(rung.width)}x${String(rung.height)}@${String(rung.framerate)}`;
    }
  }
  return null;
}

/**
 * ctl 部屋からのメッセージを `Meeting` へ反映する。
 *
 * 未知の `t` は無視する（wire-format.md 2 節）。前方互換のためである。
 */
export function applyControlMessage(
  meeting: Meeting,
  text: string,
  nowMs: number,
  hooks: ControlHooks,
): void {
  const message = parseObject(text);
  if (message === null) {
    return;
  }
  const kind = message["t"];
  if (kind === "helloAck") {
    meeting.setState("active");
    return;
  }
  if (kind === "streamCatalog") {
    const entries = message["entries"];
    if (!Array.isArray(entries)) {
      return;
    }
    hooks.onCatalog(parseCatalog(entries));
    return;
  }
  if (kind === "mediaState") {
    const participantId = message["userId"];
    const which = message["kind"];
    const enabled = message["enabled"];
    if (
      typeof participantId !== "string" ||
      (which !== "camera" && which !== "microphone") ||
      typeof enabled !== "boolean"
    ) {
      return;
    }
    hooks.onMediaState(participantId, which, enabled);
    return;
  }
  if (kind === "participants") {
    const entries = message["entries"];
    if (!Array.isArray(entries)) {
      return;
    }
    const seen: string[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const record: Record<string, unknown> = { ...entry };
      const userId = record["userId"];
      const role = record["role"];
      if (typeof userId !== "string" || !isRole(role)) {
        continue;
      }
      seen.push(userId);
      meeting.addParticipant({ id: userId, displayName: userId, role });
    }
    for (const existing of meeting.participants) {
      if (!seen.includes(existing.id)) {
        meeting.removeParticipant(existing.id);
      }
    }
    return;
  }
  if (kind === "activeSpeaker") {
    const id = message["participantId"];
    meeting.setActiveSpeaker(typeof id === "string" ? id : null);
    return;
  }
  if (kind === "chat") {
    const from = message["from"];
    const body = message["text"];
    if (typeof from !== "string" || typeof body !== "string") {
      return;
    }
    meeting.receiveChat(from, body, nowMs);
    return;
  }
  if (kind === "warning") {
    const code = message["code"];
    if (typeof code === "string") {
      meeting.warn(code);
    }
    return;
  }
  if (kind === "error") {
    const code = message["code"];
    if (typeof code === "string") {
      meeting.fail(code);
      // 文言は SDK が持たない。利用側へコードを渡す（sdk-api.md 2 節の onError）。
      hooks.onError?.(code);
    }
    return;
  }
  // 未知の t は無視する。
}

/**
 * `streamCatalog` の中身を解析する。
 *
 * **欠けた欄を既定値で埋めない。** 埋めると実体と違う寸法の呼び名を作る。
 * 欄が揃わない段は捨てる。
 */
function parseCatalog(entries: readonly unknown[]): readonly CatalogEntryView[] {
  const out: CatalogEntryView[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record: Record<string, unknown> = { ...entry };
    const senderId = record["senderId"];
    const channel = record["channel"];
    const rungs = record["rungs"];
    if (!isInteger(senderId) || !isInteger(channel) || !Array.isArray(rungs)) {
      continue;
    }
    const parsed: CatalogRungView[] = [];
    for (const rung of rungs) {
      if (typeof rung !== "object" || rung === null) {
        continue;
      }
      const item: Record<string, unknown> = { ...rung };
      const spatialId = item["spatialId"];
      const width = item["width"];
      const height = item["height"];
      const framerate = item["framerate"];
      if (!isInteger(spatialId) || !isInteger(width) || !isInteger(height) || !isInteger(framerate)) {
        continue;
      }
      parsed.push({ spatialId, width, height, framerate });
    }
    if (parsed.length === 0) {
      continue;
    }
    out.push({
      senderId,
      channel,
      rungs: [...parsed].sort((a, b) => a.spatialId - b.spatialId),
    });
  }
  return out;
}

/** 有限の整数であることを実行時に検査する（wire-format.md 2 節）。 */
function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isRole(value: unknown): value is ParticipantRole {
  return value === "host" || value === "presenter" || value === "viewer";
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    return { ...value };
  } catch {
    return null;
  }
}

function closeAll(links: ReadonlyMap<PersonalRoomRole, Link>): void {
  for (const link of links.values()) {
    link.close();
  }
}

/**
 * 送信部屋からの要求を取得の端へ写す（wire-format.md 2.5・2.7）。
 *
 * `keyframeRequest` … 指定した段で次のフレームをキーフレームにする
 * `encoderDirective` … 段の上限が下がった。作る段を絞る（ADR-0022）
 *
 * 未知の `t` は無視する。判断は持たない（写すだけである）。
 */
export function applySendControl(text: string, capture: CaptureDeps): void {
  const message = parseObject(text);
  if (message === null) {
    return;
  }
  const kind = message["t"];
  if (kind === "keyframeRequest") {
    const spatialId = message["spatialId"];
    capture.requestKeyframe(isInteger(spatialId) ? spatialId : 0);
    return;
  }
  // `encoderDirective` の段数はここでは扱わない。はしごの段数は上りの輻輳と発熱で決まり
  // （ADR-0026 の 6）、中継ノードの指令はその上限を超えないためである。
}
