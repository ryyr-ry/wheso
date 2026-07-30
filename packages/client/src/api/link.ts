/**
 * 1 つの部屋への接続の管理（端）。
 *
 * 規範: state-machines.md 1 節（接続の 9 状態と 22 遷移）、ADR-0032（購読の再送）、
 *       client-architecture.md 2 節（予備接続は受信側のみ）、congestion.md 6 節。
 *
 * **判断は持たない。** 遷移は `transport/connection.ts`、予備接続の可否は
 * `transport/standby.ts` が決める。ここが行うのは次の 4 つだけである。
 *   1. 実際のソケットを開き、事象を入力イベントへ翻訳する
 *   2. 出力コマンドを実際の送信・切断・予約へ写す
 *   3. 時刻とタイマーを扱う
 *   4. 再接続のたびに `hello` と `streamAnnounce` と `subscribe` を送り直す
 *
 * **なぜ独立したモジュールにするか。** 入口（`join-meeting.ts`）に直接書くと、5 部屋ぶんの
 * 状態機械が 1 つの関数に混ざる。どの部屋のどの遷移で何を送ったのかが追えなくなる。
 */

import {
  FLAG_KEY,
  MESSAGE_HEADER_BYTES,
  UNIT_HEADER_OFFSET,
} from "@wheso/core/src/generated/wire-layout.ts";
import {
  connectionStep,
  initialConnectionState,
  type ConnectionCommand,
  type ConnectionEvent,
  type ConnectionState,
} from "../transport/connection.ts";
import {
  closeStandby,
  initialStandby,
  isStandbyReady,
  noteStandbyFrame,
  startStandby,
  swapToStandby,
  type StandbyDeps,
  type StandbySocket,
  type StandbyState,
} from "../transport/standby.ts";

/**
 * `ACTIVE` を待つ制御メッセージの上限。
 *
 * 報告は `REPORT_INTERVAL_MS` ごとに積まれる。`ACTIVE` へ入れない間も積み続けると
 * 記憶が無制限に伸びる。古い側を捨てる（新しい観測の方が有用である）。
 */
const MAX_QUEUED_CONTROL = 32;

/** 実際のソケット 1 本。実装は WebSocket でも試験の偽物でもよい。 */
export interface LinkSocket {
  readonly send: (text: string) => void;
  /**
   * 媒体を送る。
   *
   * **溜めない。** 接続が開いていなければ捨てる。古いフレームを後から送ると、
   * 受信側の再生クロックが期限切れとして捨てるだけであり、帯域を無駄にする。
   */
  readonly sendBinary: (bytes: Uint8Array) => void;
  readonly close: () => void;
  readonly onText: (handler: (text: string) => void) => void;
  /**
   * バイナリ（メディア）の受信を購読する。
   *
   * **これが無いと SDK はメディアを受け取れない。** 段 F の F-6 まで、この口は存在しなかった。
   */
  readonly onBinary: (handler: (bytes: Uint8Array) => void) => void;
  /** 接続が開いたことを知る。 */
  readonly onOpen: (handler: () => void) => void;
  /** 接続が閉じたことを知る。クローズコードを渡す。 */
  readonly onClose: (handler: (code: number) => void) => void;
  /**
   * 送出待ちのバイト数（`WebSocket.bufferedAmount` に相当）。
   *
   * 上り輻輳の唯一の観測可能な信号である（congestion.md 3 節、ADR-0014）。
   * ネイティブでは未完了の送信件数から換算する。取得できない実装は 0 を返す。
   */
  readonly bufferedBytes: () => number;
}

/** 端が与える副作用。 */
export interface LinkDeps {
  /** ソケットを開く。失敗した場合は null を返す（例外を投げない）。 */
  readonly openSocket: () => LinkSocket | null;
  /** 局所の単調時計（ミリ秒）。 */
  readonly now: () => number;
  /** 指定した時刻に `timeout` を起こす。取り消しの関数を返す。 */
  readonly scheduleAt: (atMs: number, fire: () => void) => () => void;
  /** `hello` の本文。再接続のたびに送り直す。 */
  readonly helloText: () => string;
  /**
   * `streamAnnounce` の本文。送信側の部屋のみ意味を持つ。
   * 受信側の部屋では空文字を返せば送らない。
   */
  readonly announceText: () => string;
  /**
   * `subscribe` の本文。**再接続のたびに送り直す**（ADR-0032）。
   * 購読が無い部屋では空文字を返せば送らない。
   */
  readonly subscribeText: () => string;
  /** メディアを受け取ったときに呼ぶ。 */
  readonly onMedia: (bytes: Uint8Array) => void;
  /** 制御メッセージを受け取ったときに呼ぶ。 */
  readonly onText: (text: string) => void;
  /** 警告と失敗を利用側へ伝える。 */
  readonly onWarn: (code: string) => void;
  readonly onFail: (code: number) => void;
  /**
   * 経路が変わったことを伝える。再生クロックの対応付けを作り直させる（ADR-0028）。
   * 再接続と予備接続への切替で呼ぶ。
   */
  readonly onRouteChange: () => void;
  /** 予備接続を持つか。受信側の部屋のみ true（client-architecture.md 2 節）。 */
  readonly usesStandby: boolean;
}

/** 1 本のリンクの状態。 */
export interface Link {
  /** 現在の接続状態。観測と試験のために公開する。 */
  readonly phase: () => ConnectionState["phase"];
  /** 接続を開く。利用者の明示操作でも使う（`FAILED` からの復帰）。 */
  readonly open: () => void;
  /** 接続を閉じる。 */
  readonly close: () => void;
  /** 現在の主接続へ制御メッセージを送る。開いていなければ溜める。 */
  readonly send: (text: string) => void;
  /** 現在の主接続へ媒体を送る。開いていなければ捨てる（溜めない）。 */
  readonly sendBinary: (bytes: Uint8Array) => void;
  /** 捨てた媒体の数。観測のために数える。 */
  readonly droppedMedia: () => number;
  /** 停滞を伝える。`VIDEO_STALL_RESET_MS` を超えると予備接続へ切り替える。 */
  readonly noteStall: (durationMs: number) => void;
  /** 報告の周期を伝える。 */
  readonly noteReportTimer: () => void;
  /** 遅延勾配の劣化と回復を伝える。 */
  readonly noteTrend: (degrading: boolean) => void;
  /** 再接続の回数。観測のために数える。 */
  readonly connects: () => number;
  /** 送出待ちのバイト数。上り輻輳の判定に使う（congestion.md 3 節）。 */
  readonly bufferedBytes: () => number;
}

/**
 * リンクを作る。
 *
 * 状態は閉包に持つ。**判断は `connectionStep` に閉じており、ここには条件分岐を置かない**
 * （表に無い遷移を実装してはならない）。
 */
export function createLink(deps: LinkDeps): Link {
  let state: ConnectionState = initialConnectionState(deps.now());
  let standby: StandbyState = initialStandby();
  let socket: LinkSocket | null = null;
  /**
   * 予備接続の実体。
   *
   * `standby.ts` が保持するのは `send` と `close` だけの最小の形である。昇格するときは
   * 主接続として使うため、`LinkSocket` の全部を別に持つ。持たないと昇格した接続を
   * 主として使えず、**切替の直後にリンクがソケットを失う**（段 F の実装がその状態だった）。
   */
  let standbySocket: LinkSocket | null = null;
  /** 昇格で退役する旧主。`closeSocket` はこちらを閉じる。 */
  let retiring: LinkSocket | null = null;
  let pending: string[] = [];
  let open = false;
  let cancelTimer: (() => void) | null = null;
  let connects = 0;
  let droppedMedia = 0;
  /** `ACTIVE` を待っている制御メッセージ。 */
  const queuedControl: string[] = [];
  /** コマンドの適用中に起こす事象。適用の途中で遷移させないため後で流す。 */
  const queued: ConnectionEvent[] = [];

  const standbyDeps: StandbyDeps = {
    openSocket: (): StandbySocket | null => {
      if (!deps.usesStandby) {
        return null;
      }
      const created = deps.openSocket();
      if (created === null) {
        return null;
      }
      standbySocket = created;
      // **確立の前に送ってはならない。** `startStandby` は購読を同期に送るため、
      // 生の口をそのまま渡すとブラウザで «Still in CONNECTING state» の例外になる
      // （実測。E2E がここで止まった）。開くまで溜める。
      let standbyOpen = false;
      const pendingStandbyText: string[] = [];
      created.onOpen(() => {
        standbyOpen = true;
        created.send(deps.helloText());
        for (const text of pendingStandbyText) {
          created.send(text);
        }
        pendingStandbyText.length = 0;
      });
      created.onBinary((bytes) => {
        if (socket === created) {
          // 昇格済みである。主接続として媒体を渡す。
          deps.onMedia(bytes);
          return;
        }
        standby = noteStandbyFrame(standby, isKeyFrame(bytes));
        queued.push({ kind: "standbyReady", ready: isStandbyReady(standby) });
      });
      created.onText((text) => {
        if (socket === created) {
          deps.onText(text);
        }
      });
      created.onClose(() => {
        if (socket === created) {
          open = false;
          socket = null;
          deps.onRouteChange();
          queued.push({ kind: "socketClose", code: 1006 });
          return;
        }
        // 予備が切れた。準備できていない状態へ戻す。
        standbySocket = null;
        standby = closeStandby(standby);
        queued.push({ kind: "standbyReady", ready: false });
      });
      return {
        send: (text): void => {
          if (standbyOpen) {
            created.send(text);
            return;
          }
          pendingStandbyText.push(text);
        },
        close: created.close,
      };
    },
    subscribeText: deps.subscribeText,
  };

  function dispatch(event: ConnectionEvent): void {
    let next: ConnectionEvent | undefined = event;
    while (next !== undefined) {
      const result = connectionStep(state, next, deps.now());
      state = result.state;
      for (const command of result.commands) {
        apply(command);
      }
      next = queued.shift();
    }
  }

  function apply(command: ConnectionCommand): void {
    switch (command.kind) {
      case "createSocket":
        createSocket();
        return;
      case "sendHello":
        sendNow(deps.helloText());
        return;
      case "sendStreamAnnounce": {
        const text = deps.announceText();
        if (text.length > 0) {
          sendNow(text);
        }
        return;
      }
      case "sendSubscribe": {
        // **購読は接続に紐づく。** 送り直さないと再接続後に無音の黒画面になる（ADR-0032）。
        const text = deps.subscribeText();
        if (text.length > 0) {
          sendNow(text);
        }
        // `ACTIVE` へ入った。溜めていた制御メッセージを送る。
        flushControl();
        return;
      }
      case "sendReport":
        // 報告の本文は受信経路が作る。ここでは契機だけを伝える。
        return;
      case "startStandby":
        standby = startStandby(standby, standbyDeps);
        queued.push({ kind: "standbyReady", ready: isStandbyReady(standby) });
        return;
      case "swapToStandby": {
        const swapped = swapToStandby(standby);
        standby = swapped.state;
        const promoted = standbySocket;
        if (swapped.promoted === null || promoted === null) {
          // 準備できていない。主接続を保持し続ける（切替しない）。
          return;
        }
        standbySocket = null;
        // 旧主は退役させる。`closeSocket` はこちらを閉じる。
        retiring = socket;
        socket = promoted;
        open = true;
        for (const text of pending) {
          promoted.send(text);
        }
        pending = [];
        // 経路が変わる。再生クロックの対応付けを作り直させる（ADR-0028）。
        deps.onRouteChange();
        // 切替が成立したことを状態機械へ伝える。予備は既にキーフレームを受けている
        // （`READY` の条件）ため、ここで完了として扱う（state-machines.md 1 節）。
        queued.push({ kind: "standbyKeyframe" });
        return;
      }
      case "closeSocket":
        closeSocket();
        return;
      case "closeStandby":
        standby = closeStandby(standby);
        return;
      case "tierDown":
      case "tierUp":
        // 段の決定は受信ノードが行う（画質の判断主体を移さない）。ここでは何もしない。
        return;
      case "warn":
        deps.onWarn(command.code);
        return;
      case "fail":
        deps.onFail(command.code);
        return;
      case "schedule":
        schedule(command.at);
        return;
    }
  }

  function createSocket(): void {
    connects += 1;
    open = false;
    const created = deps.openSocket();
    if (created === null) {
      // 開けない。状態機械へ失敗として渡す（表の `onerror` に相当する）。
      dispatch({ kind: "socketError" });
      return;
    }
    socket = created;
    created.onOpen(() => {
      open = true;
      for (const text of pending) {
        created.send(text);
      }
      pending = [];
      dispatch({ kind: "socketOpen" });
    });
    created.onClose((code) => {
      open = false;
      socket = null;
      // 経路が切れた。次に繋がったときは対応付けを作り直す。
      deps.onRouteChange();
      dispatch({ kind: "socketClose", code });
    });
    created.onText((text) => {
      deps.onText(text);
      if (isHelloAck(text)) {
        dispatch({ kind: "helloAck" });
      }
    });
    created.onBinary((bytes) => {
      deps.onMedia(bytes);
    });
  }

  function closeSocket(): void {
    // 昇格の直後は旧主を閉じる。主（昇格した予備）を閉じてはならない。
    if (retiring !== null) {
      const previous = retiring;
      retiring = null;
      previous.close();
      return;
    }
    const current = socket;
    socket = null;
    open = false;
    if (current !== null) {
      current.close();
    }
  }

  function sendNow(text: string): void {
    const current = socket;
    if (current === null) {
      pending.push(text);
      return;
    }
    if (!open) {
      // 接続確立前の送信は溜める。捨てると `hello` が失われて参加できない。
      pending.push(text);
      return;
    }
    current.send(text);
  }

  /**
   * 利用側からの制御メッセージを送る。
   *
   * **`ACTIVE` へ入るまで送らない。** `hello` の応答を待っている間に別のメッセージを
   * 送ると、受け取ったノードは「最初の 1 通は hello である」という前提で解析して失敗し、
   * 形式違反として接続を閉じる（実測: 受信部屋が `report` を hello と解釈して
   * クローズコード 4020 で切った）。溜めておき、`ACTIVE` へ入ったときに送る。
   *
   * 溜める量には上限を設ける。`ACTIVE` へ入れない間も報告は周期的に積まれるためである。
   */
  function sendWhenActive(text: string): void {
    if (state.phase === "ACTIVE" && socket !== null && open) {
      socket.send(text);
      return;
    }
    queuedControl.push(text);
    if (queuedControl.length > MAX_QUEUED_CONTROL) {
      queuedControl.shift();
    }
  }

  /** `ACTIVE` へ入ったときに溜めた制御メッセージを送る。 */
  function flushControl(): void {
    if (socket === null || !open) {
      return;
    }
    for (const text of queuedControl) {
      socket.send(text);
    }
    queuedControl.length = 0;
  }

  function schedule(atMs: number): void {
    cancelTimer?.();
    cancelTimer = deps.scheduleAt(atMs, () => {
      cancelTimer = null;
      dispatch({ kind: "timeout" });
    });
  }

  return {
    phase: (): ConnectionState["phase"] => state.phase,
    open: (): void => dispatch({ kind: "open" }),
    close: (): void => {
      cancelTimer?.();
      cancelTimer = null;
      dispatch({ kind: "close" });
    },
    send: sendWhenActive,
    sendBinary: (bytes): void => {
      const current = socket;
      if (current === null || !open) {
        droppedMedia += 1;
        return;
      }
      current.sendBinary(bytes);
    },
    droppedMedia: (): number => droppedMedia,
    noteStall: (durationMs): void => dispatch({ kind: "stall", durationMs }),
    noteReportTimer: (): void => dispatch({ kind: "reportTimer" }),
    noteTrend: (degrading): void =>
      dispatch(degrading ? { kind: "trendDegrade" } : { kind: "trendRecover" }),
    connects: (): number => connects,
    bufferedBytes: (): number => socket?.bufferedBytes() ?? 0,
  };
}

/** `helloAck` かどうか。未知の `t` は無視する（wire-format.md 2 節）。 */
function isHelloAck(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const record: Record<string, unknown> = { ...value };
    return record["t"] === "helloAck";
  } catch {
    return false;
  }
}

/**
 * バイナリがキーフレームを含むかを、ヘッダの位置から判定する。
 *
 * 予備接続の切替の可否に使う（キーフレームを受けるまで切り替えない。congestion.md 6 節）。
 * 完全な復号はしない。必要なのは最初のユニットの `KEY` ビットだけである。
 */
function isKeyFrame(bytes: Uint8Array): boolean {
  // メッセージヘッダ 8 バイト + ユニットヘッダの flags の位置 12 バイト。
  const flagsOffset = MESSAGE_HEADER_BYTES + UNIT_HEADER_OFFSET.flags;
  const flags = bytes[flagsOffset];
  if (flags === undefined) {
    return false;
  }
  return (flags & FLAG_KEY) !== 0;
}
