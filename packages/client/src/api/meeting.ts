/**
 * `Meeting` オブジェクト。利用者が触る唯一の層である。
 *
 * 規範: sdk-api.md 3 節（メンバ）、4 節（イベント）、5 節（参加者ごとの受け皿）、
 * state-machines.md 1 節（状態の対応）、ADR-0015（見た目を持たない）。
 *
 * ここは端である。判断は持たない。判断は次のモジュールにある。
 *   接続の遷移      transport/connection.ts
 *   購読と層        受信ノード（サーバ側。画質の判断主体は受信側ユーザー部屋である）
 *   復号の可否      media/decoder-pool.ts
 *   映像音声の同期  sync/av-sync.ts
 *   報告            quality/reporter.ts
 *
 * レイアウト・装飾・操作部品は提供しない（sdk-api.md 5.2）。
 */

import { ERROR_DEFINITIONS, WARNING_DEFINITIONS } from "@wheso/core/src/generated/errors.ts";

/** 会議の状態（sdk-api.md 3 節）。 */
export type MeetingPhase = "connecting" | "active" | "degraded" | "reconnecting" | "failed" | "closed";

export type ParticipantRole = "host" | "presenter" | "viewer";

/** 映像の受け皿（sdk-api.md 5 節）。描画先の型は環境ごとに異なるため未知の型で受ける。 */
export interface VideoSinkHandle {
  /** 指定した要素へ描画する。大きさ・位置・装飾には関与しない。 */
  readonly attach: (target: unknown) => void;
  /** 描画を止める。 */
  readonly detach: () => void;
  /** 表示している論理寸法を申告する（track / frames を直接使う場合は必須）。 */
  readonly setDisplaySize: (width: number, height: number) => void;
}

export interface Participant {
  readonly id: string;
  readonly displayName: string;
  readonly role: ParticipantRole;
  readonly speaking: boolean;
  readonly cameraEnabled: boolean;
  readonly microphoneEnabled: boolean;
  readonly screenSharing: boolean;
  /** 受信しているプロファイル識別子。未受信は null。 */
  readonly receivedProfile: string | null;
  readonly video: VideoSinkHandle;
}

export interface Quality {
  readonly downlinkBps: number;
  readonly uplinkBps: number;
  /** 勾配は分子と分母で持つ（ADR-0017・ADR-0021）。小数を公開しない。 */
  readonly delayTrendNumerator: number;
  readonly delayTrendDenominator: number;
  readonly stallRatioPerMille: number;
  readonly avSkewMs: number;
}

/** イベント名は全言語で同一とする（sdk-api.md 4 節）。 */
export interface MeetingEvents {
  readonly stateChanged: MeetingPhase;
  readonly participantJoined: Participant;
  readonly participantLeft: string;
  readonly participantUpdated: Participant;
  readonly activeSpeakerChanged: string | null;
  readonly qualityChanged: Quality;
  readonly chatReceived: { readonly from: string; readonly text: string; readonly atMs: number };
  readonly warning: keyof typeof WARNING_DEFINITIONS | string;
  readonly error: keyof typeof ERROR_DEFINITIONS | string;
  readonly frameReceived: { readonly participantId: string; readonly frame: unknown };
}

export type MeetingEventName = keyof MeetingEvents;

/** 送信の口。実際の WebSocket は入口が与える。試験では偽物を渡す。 */
export interface MeetingLinks {
  /** ctl 部屋へ制御メッセージを送る。 */
  readonly sendControl: (text: string) => void;
  /** 映像送信部屋へ制御メッセージを送る。 */
  readonly sendVideoControl: (text: string) => void;
  /** 音声送信部屋へ制御メッセージを送る。 */
  readonly sendAudioControl: (text: string) => void;
  /** 5 本の接続をすべて閉じる。 */
  readonly closeAll: () => void;
}

/** 受け皿の生成。環境依存であるため注入する。 */
export interface SinkFactory {
  readonly create: (participantId: string) => VideoSinkHandle;
}

export interface MeetingOptions {
  readonly meetingId: string;
  readonly selfId: string;
  readonly displayName: string;
  readonly links: MeetingLinks;
  readonly sinks: SinkFactory;
}

type Handler<T> = (value: T) => void;

/**
 * `Meeting` の実装。
 *
 * 状態の保持と、利用者の操作を制御メッセージへ写すことだけを行う。
 * イベントの購読は 1 事象に複数の受け手を許す。順序は登録順とする（決定的である）。
 */
export class Meeting {
  private phase: MeetingPhase = "connecting";

  private readonly members = new Map<string, Participant>();

  private speaker: string | null = null;

  private currentQuality: Quality = {
    downlinkBps: 0,
    uplinkBps: 0,
    delayTrendNumerator: 0,
    delayTrendDenominator: 1,
    stallRatioPerMille: 0,
    avSkewMs: 0,
  };

  /**
   * イベントごとの受け手。
   *
   * 1 個の連想配列に混ぜて持つと型が消え、取り出すときに型アサーションが必要になる
   * （禁止されている。lint-policy.md 1 節）。イベントごとに型付きの配列を持つ。
   */
  private readonly listeners: { [K in MeetingEventName]: Handler<MeetingEvents[K]>[] } = {
    stateChanged: [],
    participantJoined: [],
    participantLeft: [],
    participantUpdated: [],
    activeSpeakerChanged: [],
    qualityChanged: [],
    chatReceived: [],
    warning: [],
    error: [],
    frameReceived: [],
  };

  private framesEnabled = false;

  /** 設定。実行環境が型注釈の除去のみを行うため、引数プロパティを使わない。 */
  private readonly options: MeetingOptions;

  constructor(options: MeetingOptions) {
    this.options = options;
    this.members.set(options.selfId, {
      id: options.selfId,
      displayName: options.displayName,
      role: "host",
      speaking: false,
      cameraEnabled: true,
      microphoneEnabled: true,
      screenSharing: false,
      receivedProfile: null,
      video: options.sinks.create(options.selfId),
    });
  }

  get state(): MeetingPhase {
    return this.phase;
  }

  get localParticipant(): Participant | undefined {
    return this.members.get(this.options.selfId);
  }

  get participants(): readonly Participant[] {
    // 反復順序を決定的にする。挿入順に依存させない。
    return [...this.members.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  get activeSpeakerId(): string | null {
    return this.speaker;
  }

  get quality(): Quality {
    return this.currentQuality;
  }

  /** イベントを購読する。解除する関数を返す。 */
  on<K extends MeetingEventName>(event: K, handler: Handler<MeetingEvents[K]>): () => void {
    const list = this.listeners[event];
    list.push(handler);
    return () => {
      const index = list.indexOf(handler);
      if (index >= 0) {
        list.splice(index, 1);
      }
    };
  }

  /** フレームごとの通知を有効にする。既定では発火しない（sdk-api.md 4 節）。 */
  subscribeFrames(): void {
    this.framesEnabled = true;
  }

  /** フレームの通知が有効か。端が発火の前に確認する。 */
  get framesSubscribed(): boolean {
    return this.framesEnabled;
  }

  setCamera(enabled: boolean): void {
    this.updateSelf((self) => ({ ...self, cameraEnabled: enabled }));
    this.options.links.sendVideoControl(JSON.stringify({ t: "mediaState", kind: "camera", enabled }));
  }

  setMicrophone(enabled: boolean): void {
    this.updateSelf((self) => ({ ...self, microphoneEnabled: enabled }));
    this.options.links.sendAudioControl(JSON.stringify({ t: "mediaState", kind: "microphone", enabled }));
  }

  startScreenShare(): void {
    this.updateSelf((self) => ({ ...self, screenSharing: true }));
    this.options.links.sendControl(JSON.stringify({ t: "screenShare", active: true }));
  }

  stopScreenShare(): void {
    this.updateSelf((self) => ({ ...self, screenSharing: false }));
    this.options.links.sendControl(JSON.stringify({ t: "screenShare", active: false }));
  }

  /** 高品質で受信する相手を固定する。実際の層は受信ノードが決める。 */
  setPinned(participantId: string | null): void {
    this.options.links.sendControl(JSON.stringify({ t: "pin", participantId }));
  }

  sendChat(text: string): void {
    this.options.links.sendControl(JSON.stringify({ t: "chat", text }));
  }

  leave(): void {
    this.options.links.closeAll();
    this.setState("closed");
  }

  // --- 端が呼ぶ更新の入口。判断は含まない ---

  setState(phase: MeetingPhase): void {
    if (this.phase === phase) {
      return;
    }
    this.phase = phase;
    this.emit("stateChanged", phase);
  }

  addParticipant(input: {
    readonly id: string;
    readonly displayName: string;
    readonly role: ParticipantRole;
  }): void {
    if (this.members.has(input.id)) {
      return;
    }
    const participant: Participant = {
      id: input.id,
      displayName: input.displayName,
      role: input.role,
      speaking: false,
      cameraEnabled: true,
      microphoneEnabled: true,
      screenSharing: false,
      receivedProfile: null,
      video: this.options.sinks.create(input.id),
    };
    this.members.set(input.id, participant);
    this.emit("participantJoined", participant);
  }

  removeParticipant(participantId: string): void {
    if (!this.members.delete(participantId)) {
      return;
    }
    if (this.speaker === participantId) {
      this.speaker = null;
      this.emit("activeSpeakerChanged", null);
    }
    this.emit("participantLeft", participantId);
  }

  updateParticipant(participantId: string, patch: Partial<Omit<Participant, "id" | "video">>): void {
    const existing = this.members.get(participantId);
    if (existing === undefined) {
      return;
    }
    const updated: Participant = { ...existing, ...patch };
    this.members.set(participantId, updated);
    this.emit("participantUpdated", updated);
  }

  setActiveSpeaker(participantId: string | null): void {
    if (this.speaker === participantId) {
      return;
    }
    this.speaker = participantId;
    this.emit("activeSpeakerChanged", participantId);
  }

  setQuality(quality: Quality): void {
    this.currentQuality = quality;
    this.emit("qualityChanged", quality);
  }

  receiveChat(from: string, text: string, atMs: number): void {
    this.emit("chatReceived", { from, text, atMs });
  }

  /** 警告と誤りは文言を持たず、コードのみを渡す（sdk-api.md 6 節）。 */
  warn(code: string): void {
    this.emit("warning", code);
  }

  fail(code: string): void {
    this.emit("error", code);
  }

  /** フレームの通知。購読が無効なら何もしない。 */
  deliverFrame(participantId: string, frame: unknown): void {
    if (!this.framesEnabled) {
      return;
    }
    this.emit("frameReceived", { participantId, frame });
  }

  private updateSelf(change: (self: Participant) => Participant): void {
    const self = this.members.get(this.options.selfId);
    if (self === undefined) {
      return;
    }
    const updated = change(self);
    this.members.set(self.id, updated);
    this.emit("participantUpdated", updated);
  }

  private emit<K extends MeetingEventName>(event: K, value: MeetingEvents[K]): void {
    // 登録順に呼ぶ。購読の解除が反復中に起きても崩れないよう複製してから配る。
    for (const handler of [...this.listeners[event]]) {
      handler(value);
    }
  }
}

/** `Meeting` を作る。入口（join-meeting.ts）から使う。 */
export function createMeeting(options: MeetingOptions): Meeting {
  return new Meeting(options);
}
