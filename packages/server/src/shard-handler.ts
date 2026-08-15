/**
 * 中継ノード（shard）の伝送層アダプタ。
 *
 * 責務は 3 つに限る。
 *   1. 受信したバイト列とテキストを入力イベントへ翻訳する
 *   2. 判断コア（shard-core）へ渡す
 *   3. 返ってきた出力コマンドを実際の送信・切断へ写す
 *
 * 判断は一切行わない。判断を書くと 9 言語で一致しなくなる（conformance.md 2 節）。
 * 時刻は呼び出し側から受け取る。ここでも取得しない（lint-policy.md 9 節）。
 */

import {
  initialState,
  step,
  type LadderRung,
  type ShardCommand,
  type ShardEvent,
  type ShardState,
} from "@wheso/core/src/shard-core.ts";
import { decodeMediaMessage, wireErrorCloseCode } from "@wheso/core/src/wire.ts";
import { videoProfileForSpatialId } from "@wheso/core/src/profiles.ts";
import {
  CHANNEL_AUDIO,
  CHANNEL_SCREEN_AUDIO,
  CHANNEL_VIDEO,
  FLAG_KEY,
  MAX_TEMPORAL_ID,
} from "@wheso/core/src/generated/wire-layout.ts";
import { AUDIO_BUNDLE_MS, DELAY_TREND_WINDOW } from "@wheso/core/src/generated/constants.ts";
import { ERROR_DEFINITIONS } from "@wheso/core/src/generated/errors.ts";

function isAudioChannel(ch: number): boolean {
  return ch === CHANNEL_AUDIO || ch === CHANNEL_SCREEN_AUDIO;
}


 /**
 * 宛先の役割。
 *
 * **参加者 ID だけでは宛先が決まらない。** 1 人の参加者は送信ノード（`vs` / `as`）と
 * 受信ノード（`vr` / `ar`）の両方から同じ中継部屋へ繋ぐ。参加者 ID は利用者 ID から
 * 導くため両者で同じ値になる。役割を無視すると、送信者へ返すはずの `ack` が
 * その人の受信ノードへ届き、**送信窓が永久に開かない**（実測: 30 枚のうち 4 枚しか
 * 上流へ渡らなかった）。
 */
export type ShardTarget = "sender" | "receiver";

/** 送信と切断の口。実装は Durable Object 側が与える。試験では偽物を渡す。 */
export interface ShardTransport {
  /**
   * 破棄を記録する（観測のため。判断には使わない）。
   *
   * **なぜ必要か。** 「転送しなかった」ことの理由を外から区別できないと、原因の層を
   * 取り違える。層の選択で渡さなかったのか、輻輳で捨てたのか、送信窓が閉じていたのかを
   * 優先順位の内訳で見分ける。
   */
  noteDrop(priority: number, count: number): void;
  /** 参加者の**受信ノード**へバイナリを送る。接続が無い場合は何もしない。 */
  sendBinary(participantId: number, bytes: Uint8Array): void;
  /** 参加者の指定した役割のノードへテキスト（制御メッセージ）を送る。 */
  sendText(participantId: number, target: ShardTarget, text: string): void;
  /** 接続を閉じる。 */
  close(participantId: number, target: ShardTarget, code: number, reason: string): void;
  /** 制御系（ctl 部屋）へ通知する。 */
  notifyControl(code: number): void;
}

/** 参加者 1 人の接続。 */
export interface ShardPeer {
  readonly participantId: number;
  /** ノード間接続の場合は true。nodeHello の検証済みを意味する。 */
  readonly isNode: boolean;
}

/** 購読確立前に届いた音声メッセージの退避先。`"${from}:${ch}"` を鍵とする。 */
export type AudioRingBuffer = Map<string, Uint8Array[]>;

export interface ShardHandlerState {
  readonly core: ShardState;
  /** 直近に転送したバイト列。forward コマンドの実体である。 */
  readonly pendingPayload: Uint8Array | null;
  /**
   * 購読が確立する前に届いた音声メッセージの退避先。
   *
   * 音声は破棄禁止（wire-format.md 1.4）であり、購読がまだ無いからといって落としてはならない。
   * shard core は購読が無い音声に対して forward コマンドを出さない。そのため、購読が作られる
   * までの間に届いた音声が永久に失われる。ここに退避し、購読が作られた瞬間に送出する。
   *
   * 映像は退避しない（古い映像を後で送っても再生できない）。
   * 上限は1秒分（`Math.ceil(1000 / AUDIO_BUNDLE_MS)` 件）とし、超えた古い分から捨てる。
   */
  readonly audioRing: AudioRingBuffer;
}

/** 初期状態。 */
export function createShardHandlerState(nowMs: number): ShardHandlerState {
  return { core: initialState(nowMs), pendingPayload: null, audioRing: new Map() };
}

/**
 * バイナリメッセージ（メディア）を処理する。
 *
 * 1 メッセージに複数のユニットが入るため、ユニットごとに入力イベントを作る。
 * 転送はメッセージ単位で行う。ユニット単位に分解して送り直すと、
 * 受信側の順序保証とヘッダの整合が壊れる。
 */
export function handleBinary(
  state: ShardHandlerState,
  peer: ShardPeer,
  bytes: Uint8Array,
  nowMs: number,
  transport: ShardTransport,
): ShardHandlerState {
  const decoded = decodeMediaMessage(bytes);
  if (!decoded.ok) {
    // 形式違反は接続を閉じる（wire-format.md 0 節の規則 3・4）。
    transport.close(peer.participantId, "sender", wireErrorCloseCode(decoded.error.code), decoded.error.code);
    return state;
  }

  let core = state.core;
  let forwardedOnce = false;
  let audioRing = state.audioRing;
  for (const unit of decoded.value.units) {
    const event: ShardEvent = {
      kind: "media",
      from: decoded.value.senderId,
      ch: decoded.value.channel,
      sid: unit.spatialId,
      tid: unit.temporalId,
      key: (unit.flags & FLAG_KEY) !== 0,
      bytes: unit.payload.length,
      flags: unit.flags,
      // 送信窓（congestion.md 2 節）の計算に必要である。落としてはならない。
      seq: unit.sequenceNumber,
    };
    const result = step(core, event, nowMs);
    core = result.state;
    let hadForward = false;
    for (const command of result.commands) {
      if (command.kind === "forward" && !forwardedOnce) {
        // 同一メッセージを複数ユニット分だけ重複送信しないため、最初の forward でのみ送る。
        forwardedOnce = true;
        hadForward = true;
        for (const target of command.to) {
          transport.sendBinary(target, bytes);
        }
        continue;
      }
      applyNonForward(command, transport);
    }
    // **音声で forward が無かった場合、購読がまだ無い。リングバッファへ退避する。**
    //
    // shard core は購読が存在しない送信者の音声に forward コマンドを出さない。
    // そのまま見過ごすと、購読が作られるまでに届いた音声が永久に失われる。
    // 音声は破棄禁止（wire-format.md 1.4）であるため、ここで退避し、
    // 購読が作られた瞬間に `handleText` で送出する。
    //
    // 1 メッセージに複数ユニットが含まれることがある。最初のユニットで forward が
    // 無ければ退避し、以降のユニットで forward があれば退避せずに送る（1 メッセージは
    // 1 つの送信単位であるため、全体を送るか全体を退避するかのいずれか）。
    if (!hadForward && !forwardedOnce && isAudioChannel(decoded.value.channel)) {
      const key = `${String(decoded.value.senderId)}:${String(decoded.value.channel)}`;
      const max = Math.ceil(1000 / AUDIO_BUNDLE_MS);
      const buf = audioRing.get(key) ?? [];
      buf.push(bytes);
      while (buf.length > max) {
        buf.shift();
      }
      audioRing = new Map(audioRing);
      audioRing.set(key, buf);
    }
  }
  return { ...state, core, audioRing };
}

/**
 * テキストメッセージ（制御）を処理する。
 *
 * 未知の `t` は無視する（wire-format.md 2 節）。接続は閉じない。前方互換のためである。
 */
export function handleText(
  state: ShardHandlerState,
  peer: ShardPeer,
  text: string,
  nowMs: number,
  transport: ShardTransport,
): ShardHandlerState {
  const parsed = parseJson(text);
  if (parsed === null) {
    return state;
  }
  const events = toEvents(parsed, peer.participantId, state.core);
  let core = state.core;
  let audioRing = state.audioRing;
  for (const event of events) {
    const result = step(core, event, nowMs);
    core = result.state;
    for (const command of result.commands) {
      applyNonForward(command, transport);
    }
    // **購読が作られた瞬間に、退避した音声を送出する。**
    //
    // `subscribe` イベントが `want: true` で処理されると、shard core に購読が作られる。
    // それまでの間に届いた音声は `audioRing` に退避されている。これを即座に送出しないと、
    // 購読者は古い音声を聞けない（音声は破棄禁止。wire-format.md 1.4）。
    //
    // `subscribe` イベント自体は `forward` コマンドを出さない。メディアの `forward` は
    // 次の `handleBinary` で出される。しかし、退避した音声を次の `handleBinary` まで
    // 待たせると、その間に新しい音声が届いたときに古い音声より後に送られてしまう。
    // そのため、ここで即座に送出する。
    if (event.kind === "subscribe" && event.want && isAudioChannel(event.ch)) {
      const key = `${String(event.to)}:${String(event.ch)}`;
      const buf = audioRing.get(key);
      if (buf !== undefined && buf.length > 0) {
        for (const bytes of buf) {
          transport.sendBinary(peer.participantId, bytes);
        }
        audioRing = new Map(audioRing);
        audioRing.delete(key);
      }
    }
  }
  return { ...state, core, audioRing };
}

/** 接続の確立と切断を入力イベントへ翻訳する。 */
export function handleLifecycle(
  state: ShardHandlerState,
  peer: ShardPeer,
  kind: "open" | "close",
  nowMs: number,
  transport: ShardTransport,
): ShardHandlerState {
  const event: ShardEvent =
    kind === "open" ? { kind: "join", id: peer.participantId } : { kind: "leave", id: peer.participantId };
  const result = step(state.core, event, nowMs);
  for (const command of result.commands) {
    applyNonForward(command, transport);
  }
  return { ...state, core: result.state };
}

/** タイマー満了を入力イベントへ翻訳する。回復方向の遷移はこれで起きる。 */
export function handleTimer(
  state: ShardHandlerState,
  nowMs: number,
  transport: ShardTransport,
): ShardHandlerState {
  const result = step(state.core, { kind: "timer" }, nowMs);
  for (const command of result.commands) {
    applyNonForward(command, transport);
  }
  return { ...state, core: result.state };
}

/** forward 以外の出力コマンドを実行する。 */
function applyNonForward(command: ShardCommand, transport: ShardTransport): void {
  switch (command.kind) {
    case "forward":
      // forward は呼び出し側が扱う。ここでは何もしない。
      return;
    case "drop":
      // 破棄は送らないことで表現される。記録は観測系の責務である。
      transport.noteDrop(command.priority, command.count);
      return;
    case "notify":
      transport.notifyControl(command.code);
      return;
    case "close":
      // close の対象は接続ではなく相手のノードである。code のみを制御系へ伝える。
      transport.notifyControl(command.code);
      return;
    case "keyframeRequest":
      // **規範の欄をすべて入れる**（wire-format.md 2.5）。`channel` と `spatialId` を
      // 落とすと、受け取った送信ノードが必須検査で捨てるため要求が 1 度も通らない。
      // 宛先は**送信者**である（その段を作る符号化器を持つのは送信側である）。
      transport.sendText(
        command.for,
        "sender",
        JSON.stringify({
          t: "keyframeRequest",
          senderId: command.for,
          channel: command.channel,
          spatialId: command.spatialId,
        }),
      );
      return;
    case "setTier": {
      // エンコーダ指令は規範（ワイヤ形式 2.7）の 5 フィールドをすべて満たす。
      // 値は tier に対応するプロファイルの定数から引く。数値を書かない。
      const profile = videoProfileForSpatialId(command.tier);
      // エンコーダ指令の宛先は**送信者**である（ADR-0022、ADR-0033）。
      transport.sendText(
        command.for,
        "sender",
        JSON.stringify({
          t: "encoderDirective",
          channel: CHANNEL_VIDEO,
          maxSpatialLayers: command.tier + 1,
          maxTemporalLayers: profile.temporalLayers,
          targetBitrate: profile.targetBitrate,
          // キーフレームは keyframeRequest で個別に要求する（ワイヤ形式 2.5）。
          forceKeyframe: false,
        }),
      );
      return;
    }
    case "connect":
    case "schedule":
      // 上位のノード間接続とタイマーは Durable Object 側が扱う。
      return;
    case "ackUpstream":
      // 受信位置を送信ノードへ返す（congestion.md 2 節）。宛先はその送信者のノードである。
      // 宛先は**送信者**である。受信ノードへ送ると送信窓が永久に開かない。
      transport.sendText(
        command.to,
        "sender",
        JSON.stringify({
          t: "ack",
          senderId: command.to,
          channel: command.channel,
          spatialId: command.spatialId,
          highestSeq: command.highestSeq,
        }),
      );
      return;
    case "disconnect":
      // ack が途絶えた購読者の接続を閉じる（congestion.md 7 節）。
      // 閉じないと、既に居ない相手へ送り続けてノードの予算を食う。
      // ack が途絶えたのは**購読者**（受信ノード）である。
      transport.close(command.peer, "receiver", ERROR_DEFINITIONS.E_ACK_TIMEOUT.closeCode, "E_ACK_TIMEOUT");
      return;
  }
}

/** JSON を解析する。失敗しても例外を投げない。 */
function parseJson(text: string): Record<string, unknown> | null {
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

/**
 * 制御メッセージを入力イベント列へ翻訳する。
 *
 * `subscribe` は entries ごとに 1 個のイベントになる。
 * `ack` は送信窓（congestion.md 2 節）の入力である。**落としてはならない。**
 * `streamAnnounce` ははしごと fps の情報であり、段の選択と送信窓の両方に必要である。
 * `report` は標本列を整数として渡す（ADR-0021）。
 */
function toEvents(
  message: Record<string, unknown>,
  from: number,
  core: ShardState,
): readonly ShardEvent[] {
  const t = message["t"];
  if (t === "subscribe") {
    const entries = message["entries"];
    if (!Array.isArray(entries)) {
      return [];
    }
    const events: ShardEvent[] = [];
    // **`entries` は「望む集合」である**（wire-format.md 2.4:「entries に含まれない
    // (senderId, channel) の転送は停止する」）。含まれない購読は解除する。
    //
    // 以前は追加しか作らなかったため、購読解除が中継へ伝わらなかった。解除の意味を
    // 実装しないと、要らなくなった映像が流れ続ける（F-056）。
    for (const sub of core.subscriptions) {
      if (sub.subscriberId !== from) {
        continue;
      }
      const stillWanted = entries.some((entry) => {
        if (typeof entry !== "object" || entry === null) {
          return false;
        }
        const record: Record<string, unknown> = { ...entry };
        const senderId = record["senderId"];
        const channel = record["channel"];
        const ch = isFiniteInteger(channel) ? channel : CHANNEL_VIDEO;
        return isFiniteInteger(senderId) && senderId === sub.targetId && ch === sub.channel;
      });
      if (!stillWanted) {
        events.push({
          kind: "subscribe",
          from,
          to: sub.targetId,
          ch: sub.channel,
          want: false,
          maxSpatialId: 0,
          maxTemporalId: 0,
        });
      }
    }
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const record: Record<string, unknown> = { ...entry };
      const senderId = record["senderId"];
      const maxSpatialId = record["maxSpatialId"];
      const channel = record["channel"];
      const maxTemporalId = record["maxTemporalId"];
      if (!isFiniteInteger(senderId) || !isFiniteInteger(maxSpatialId)) {
        continue;
      }
      events.push({
        kind: "subscribe",
        from,
        to: senderId,
        // チャネルの指定が無い購読は映像とみなす。指定を落とすと映像の購読が
        // 音声まで転送してしまう（購読は (subscriberId, targetId, channel) で一意）。
        ch: isFiniteInteger(channel) ? channel : CHANNEL_VIDEO,
        want: true,
        maxSpatialId,
        maxTemporalId: isFiniteInteger(maxTemporalId) ? maxTemporalId : MAX_TEMPORAL_ID,
      });
    }
    return events;
  }
  if (t === "ack") {
    const senderId = message["senderId"];
    const channel = message["channel"];
    const spatialId = message["spatialId"];
    const highestSeq = message["highestSeq"];
    if (!isFiniteInteger(senderId) || !isFiniteInteger(highestSeq)) {
      return [];
    }
    return [
      {
        kind: "ack",
        from,
        to: senderId,
        ch: isFiniteInteger(channel) ? channel : CHANNEL_VIDEO,
        // 段の指定が無い ack は最下段に対するものとみなす。段ごとに seq の空間が
        // 独立しているため、取り違えると未確認量の計算が壊れる。
        sid: isFiniteInteger(spatialId) ? spatialId : 0,
        highestSeq,
      },
    ];
  }
  if (t === "streamAnnounce") {
    const streams = message["streams"];
    if (!Array.isArray(streams)) {
      return [];
    }
    // 同一チャネルの段をまとめて 1 個のイベントにする。チャネルごとに 1 個である。
    const byChannel = new Map<number, LadderRung[]>();
    for (const stream of streams) {
      if (typeof stream !== "object" || stream === null) {
        continue;
      }
      const record: Record<string, unknown> = { ...stream };
      const channel = record["channel"];
      const spatialId = record["spatialId"];
      const framerate = record["framerate"];
      if (!isFiniteInteger(channel) || !isFiniteInteger(spatialId) || !isFiniteInteger(framerate)) {
        continue;
      }
      const rung: LadderRung = {
        sid: spatialId,
        width: isFiniteInteger(record["width"]) ? record["width"] : 0,
        height: isFiniteInteger(record["height"]) ? record["height"] : 0,
        framerate,
        temporalLayers: isFiniteInteger(record["temporalLayers"]) ? record["temporalLayers"] : 0,
        targetBitrate: isFiniteInteger(record["targetBitrate"]) ? record["targetBitrate"] : 0,
      };
      const existing = byChannel.get(channel);
      if (existing === undefined) {
        byChannel.set(channel, [rung]);
        continue;
      }
      existing.push(rung);
    }
    const events: ShardEvent[] = [];
    // チャネルの昇順で出す（決定性のため）。
    for (const channel of [...byChannel.keys()].sort((a, b) => a - b)) {
      const rungs = byChannel.get(channel);
      if (rungs === undefined) {
        continue;
      }
      events.push({ kind: "streamAnnounce", from, ch: channel, rungs });
    }
    return events;
  }
  if (t === "keyframeRequest") {
    // 購読者（受信ノード）からの要求（ADR-0039）。全欄を実行時に検査する。
    const senderId = message["senderId"];
    const channel = message["channel"];
    const spatialId = message["spatialId"];
    if (!isFiniteInteger(senderId) || !isFiniteInteger(channel) || !isFiniteInteger(spatialId)) {
      return [];
    }
    return [{ kind: "keyframeRequest", from, target: senderId, ch: channel, sid: spatialId }];
  }
  if (t === "report") {
    const samples = message["arrivalDelaySamplesUs"];
    if (!Array.isArray(samples)) {
      return [];
    }
    const delayUs: number[] = [];
    for (const sample of samples) {
      if (isFiniteInteger(sample)) {
        delayUs.push(sample);
      }
    }
    // 上限を超える標本は先頭から切り捨てる（wire-format.md 2.6）。
    const trimmed = delayUs.length > DELAY_TREND_WINDOW ? delayUs.slice(delayUs.length - DELAY_TREND_WINDOW) : delayUs;
    return [{ kind: "report", from, delayUs: trimmed }];
  }
  // 未知の t は無視する。接続は閉じない。
  return [];
}

/** 有限の整数であることを実行時に検査する。NaN と Infinity を除く（wire-format.md 2 節）。 */
function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

/** 過負荷の通知に使うクローズコード。制御系がファンアウト追加を判断する。 */
export const OVERLOAD_CODE = ERROR_DEFINITIONS.E_NODE_OVERLOADED.closeCode;
