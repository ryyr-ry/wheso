/**
 * 報告・予備接続・Meeting・参加入口の試験。
 *
 * 規範: wire-format.md 2.6（報告）、ADR-0021（標本列）、
 * client-architecture.md 2 節（5 接続）と 7 節（予備接続の完了条件）、
 * sdk-api.md 1 節・3 節・4 節（API 表面とイベント）。
 *
 * 環境依存は注入する。カメラも WebSocket も使わずに検査できる。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  initialReporter,
  recordArrivalDelay,
  recordAudioLoss,
  recordLinkEstimate,
  recordStall,
  recordVideoDrop,
  shouldReport,
  takeReport,
} from "../packages/client/src/quality/reporter.ts";
import {
  closeStandby,
  initialStandby,
  isStandbyReady,
  noteStandbyFrame,
  startStandby,
  swapToStandby,
  type StandbyDeps,
  type StandbySocket,
} from "../packages/client/src/transport/standby.ts";
import { createMeeting, type FrameSink } from "../packages/client/src/api/meeting.ts";
import {
  applyControlMessage,
  joinWith,
  senderIdFrom,
  type JoinSocket,
  type ControlHooks,
} from "../packages/client/src/api/join-meeting.ts";
import type { CaptureDeps } from "../packages/client/src/media/browser-capture.ts";
import { DELAY_TREND_WINDOW, REPORT_INTERVAL_MS } from "../packages/core/src/generated/constants.ts";

const T0 = 4_000_000;

/** 取得と符号化の偽物。WebCodecs は Node に無い。呼ばれたことだけを数える。 */
const NO_CAPTURE: CaptureDeps = {
  bindCapture: (): void => undefined,
  startCapture: async (): Promise<{ source: null; video: false; audio: false }> => ({
    source: null,
    video: false,
    audio: false,
  }),
  configureVideo: (): void => undefined,
  configureAudio: (): void => undefined,
  requestKeyframe: (): void => undefined,
  setVideoEnabled: (): void => undefined,
  setAudioEnabled: (): void => undefined,
  encodeQueueSize: (): number => 0,
  close: (): void => undefined,
};

/** 識別子は規範の形式に従う（room-naming.md 1 節）。ULID 小文字 26 文字と 16 進 32 文字である。 */
const MEETING_ID = "01jxy8kq2r3mz5v7h9abcderfa";
const USER_ID = "550e8400e29b41d4a716446655440000";

function sink(drawn: unknown[] = []): FrameSink {
  return {
    attach: (): void => undefined,
    detach: (): void => undefined,
    setDisplaySize: (): void => undefined,
    draw: (frame): void => {
      drawn.push(frame);
    },
  };
}

/** ctl の取っ手。既定では何も記録しない。 */
function hooks(overrides: Partial<ControlHooks> = {}): ControlHooks {
  return {
    onCatalog: (): void => undefined,
    onMediaState: (): void => undefined,
    ...overrides,
  };
}

test("標本列は上限を超えたら古い側から捨てる（ADR-0021）", () => {
  let state = initialReporter(T0);
  for (let index = 0; index < DELAY_TREND_WINDOW + 5; index += 1) {
    state = recordArrivalDelay(state, 10_000 + index);
  }
  assert.equal(state.samplesUs.length, DELAY_TREND_WINDOW);
  assert.equal(state.samplesUs[0], 10_005, "新しい側を残す");
});

test("報告は周期に達したときだけ作られ、計数が 0 に戻る", () => {
  let state = initialReporter(T0);
  assert.equal(shouldReport(state, T0 + REPORT_INTERVAL_MS - 1), false);
  assert.equal(shouldReport(state, T0 + REPORT_INTERVAL_MS), true);

  state = recordStall(state);
  state = recordAudioLoss(state, 3);
  state = recordAudioLoss(state, 0);
  state = recordVideoDrop(state);
  state = recordArrivalDelay(state, 12_500);
  state = recordLinkEstimate(state, 4_200_000, 35, "growing");

  const output = takeReport(state, T0 + REPORT_INTERVAL_MS);
  const message: unknown = JSON.parse(output.text);
  assert.equal(typeof message, "object");
  const record: Record<string, unknown> = { ...(message as object) };
  assert.equal(record["t"], "report");
  assert.equal(record["downlinkBps"], 4_200_000);
  assert.equal(record["playoutStalls"], 1);
  assert.equal(record["audioPacketsLost"], 3);
  assert.equal(record["videoFramesDropped"], 1);
  assert.equal(record["jitterMs"], 35);
  assert.equal(record["bufferHealth"], "growing");
  assert.deepEqual(record["arrivalDelaySamplesUs"], [12_500]);
  assert.equal("arrivalDelayTrend" in record, false, "勾配は送らない");

  assert.equal(output.state.playoutStalls, 0, "窓の計数は戻る");
  assert.equal(output.state.samplesUs.length, 1, "標本列は残す");
  assert.equal(shouldReport(output.state, T0 + REPORT_INTERVAL_MS), false);
});

function fakeSocket(log: string[]): StandbySocket {
  return {
    send: (text): void => {
      log.push(text);
    },
    close: (): void => {
      log.push("close");
    },
  };
}

test("予備接続はキーフレームを受けるまで切り替えない（欠落 0）", () => {
  const log: string[] = [];
  const deps: StandbyDeps = {
    openSocket: () => fakeSocket(log),
    subscribeText: () => JSON.stringify({ t: "subscribe", entries: [] }),
  };
  let state = startStandby(initialStandby(), deps);
  assert.equal(state.phase, "WAITING_KEYFRAME");
  assert.equal(log.length, 1, "購読を予備へ送る");
  assert.equal(isStandbyReady(state), false);

  // delta では切替可能にならない。
  state = noteStandbyFrame(state, false);
  assert.equal(isStandbyReady(state), false);
  assert.equal(swapToStandby(state).promoted, null, "準備前は昇格しない");

  state = noteStandbyFrame(state, true);
  assert.equal(isStandbyReady(state), true);
  const swapped = swapToStandby(state);
  assert.notEqual(swapped.promoted, null, "キーフレーム後に昇格する");
  assert.equal(swapped.state.socket, null);
  assert.equal(swapped.state.phase, "IDLE");
});

test("予備接続は二重に開かず、閉じると解放される", () => {
  const log: string[] = [];
  let opened = 0;
  const deps: StandbyDeps = {
    openSocket: () => {
      opened += 1;
      return fakeSocket(log);
    },
    subscribeText: () => "{}",
  };
  let state = startStandby(initialStandby(), deps);
  state = startStandby(state, deps);
  assert.equal(opened, 1, "同時接続は 2 本までであるため二重に開かない");
  state = closeStandby(state);
  assert.equal(state.socket, null);
  assert.ok(log.includes("close"));
  assert.equal(closeStandby(state).socket, null, "閉じた後も安全である");
});

test("予備接続を開けない場合は待機のままにする", () => {
  const state = startStandby(initialStandby(), { openSocket: () => null, subscribeText: () => "{}" });
  assert.equal(state.phase, "IDLE");
  assert.equal(state.socket, null);
});

test("Meeting は状態と参加者の変化をイベントで通知する", () => {
  const sent: string[] = [];
  const meeting = createMeeting({
    meetingId: MEETING_ID,
    selfId: "u-self",
    displayName: "自分",
    links: {
      sendControl: (text) => sent.push(text),
      sendVideoReceiveControl: (text) => sent.push(text),
      closeAll: () => sent.push("closeAll"),
    },
    sinks: { create: () => sink() },
  });

  const states: string[] = [];
  const joined: string[] = [];
  const left: string[] = [];
  meeting.on("stateChanged", (phase) => states.push(phase));
  meeting.on("participantJoined", (participant) => joined.push(participant.id));
  const off = meeting.on("participantLeft", (id) => left.push(id));

  assert.equal(meeting.state, "connecting");
  meeting.setState("active");
  meeting.setState("active");
  assert.deepEqual(states, ["active"], "同じ状態では通知しない");

  meeting.addParticipant({ id: "u-b", displayName: "B", role: "viewer" });
  meeting.addParticipant({ id: "u-b", displayName: "B", role: "viewer" });
  assert.deepEqual(joined, ["u-b"], "重複した参加は通知しない");
  assert.deepEqual(
    meeting.participants.map((participant) => participant.id),
    ["u-b", "u-self"],
    "反復順序は決定的である",
  );

  // 購読を解除すると通知が届かない。
  off();
  meeting.removeParticipant("u-b");
  assert.deepEqual(left, []);
  assert.equal(meeting.participants.length, 1);
});

test("Meeting の操作は制御メッセージになり、フレーム通知は既定で無効である", () => {
  const sent: string[] = [];
  const meeting = createMeeting({
    meetingId: MEETING_ID,
    selfId: "u-self",
    displayName: "自分",
    links: {
      sendControl: (text) => sent.push(text),
      sendVideoReceiveControl: (text) => sent.push(text),
      closeAll: () => sent.push("closeAll"),
    },
    sinks: { create: () => sink() },
  });

  meeting.setCamera(false);
  meeting.setMicrophone(false);
  meeting.startScreenShare();
  meeting.setPinned("u-b");
  meeting.sendChat("こんにちは");
  assert.equal(meeting.localParticipant?.cameraEnabled, false);
  assert.equal(meeting.localParticipant?.screenSharing, true);
  assert.equal(sent.length, 5);

  const frames: string[] = [];
  meeting.on("frameReceived", (event) => frames.push(event.participantId));
  meeting.deliverFrame("u-b", null);
  assert.deepEqual(frames, [], "既定では発火しない");
  meeting.subscribeFrames();
  meeting.deliverFrame("u-b", null);
  assert.deepEqual(frames, ["u-b"]);

  meeting.leave();
  assert.equal(meeting.state, "closed");
  assert.ok(sent.includes("closeAll"));
});

test("ctl 部屋のメッセージが Meeting へ反映される", () => {
  const errors: string[] = [];
  const meeting = createMeeting({
    meetingId: MEETING_ID,
    selfId: "u-self",
    displayName: "自分",
    links: {
      sendControl: (): void => undefined,
      sendVideoReceiveControl: (): void => undefined,
      closeAll: (): void => undefined,
    },
    sinks: { create: () => sink() },
  });

  applyControlMessage(meeting, JSON.stringify({ t: "helloAck" }), T0, hooks());
  assert.equal(meeting.state, "active");

  applyControlMessage(
    meeting,
    JSON.stringify({
      t: "participants",
      entries: [
        { userId: "u-self", senderId: 1, role: "host" },
        { userId: "u-b", senderId: 2, role: "viewer" },
      ],
    }),
    T0,
    hooks(),
  );
  assert.equal(meeting.participants.length, 2);

  // 一覧から消えた参加者は退出として扱う。
  applyControlMessage(
    meeting,
    JSON.stringify({ t: "participants", entries: [{ userId: "u-self", senderId: 1, role: "host" }] }),
    T0,
    hooks(),
  );
  assert.equal(meeting.participants.length, 1);

  const chats: string[] = [];
  meeting.on("chatReceived", (event) => chats.push(`${event.from}:${event.text}`));
  applyControlMessage(meeting, JSON.stringify({ t: "chat", from: "u-b", text: "やあ" }), T0, hooks());
  assert.deepEqual(chats, ["u-b:やあ"]);

  applyControlMessage(meeting, JSON.stringify({ t: "activeSpeaker", participantId: "u-b" }), T0, hooks());
  assert.equal(meeting.activeSpeakerId, "u-b");

  const warnings: string[] = [];
  meeting.on("warning", (code) => warnings.push(code));
  applyControlMessage(meeting, JSON.stringify({ t: "warning", code: "W_DEGRADED" }), T0, hooks());
  assert.deepEqual(warnings, ["W_DEGRADED"]);

  applyControlMessage(meeting, JSON.stringify({ t: "error", code: "E_AUTH" }), T0, hooks({ onError: (code) => errors.push(code) }));
  assert.deepEqual(errors, ["E_AUTH"], "文言ではなくコードを渡す");

  // 未知の t と壊れた JSON は無視する。
  applyControlMessage(meeting, JSON.stringify({ t: "未知" }), T0, hooks());
  applyControlMessage(meeting, "{壊れている", T0, hooks());
  assert.equal(meeting.state, "active");
});

test("senderId は利用者 ID から決定的に決まり 0 にならない", () => {
  assert.equal(senderIdFrom("u-abc"), senderIdFrom("u-abc"), "同じ入力で同じ値");
  assert.notEqual(senderIdFrom("u-abc"), senderIdFrom("u-abd"));
  assert.ok(senderIdFrom("u-abc") > 0);
  assert.ok(senderIdFrom("") > 0, "空でも 0 にしない");
});

/** 署名を検証しない主張の読み取りを使うため、形だけのトークンを組む。 */
function fakeToken(meetingId: string, userId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "wheso",
      sub: userId,
      aud: meetingId,
      iat: 1,
      exp: 61,
      jti: "j1",
      kind: "client",
      role: "host",
    }),
  ).toString("base64url");
  return `${header}.${payload}.c2ln`;
}


/** 何もしない復号と音声再生の口。受信経路そのものは別の試験が検証する。 */
const NO_MEDIA = {
  configureDecoder: (): void => undefined,
  resetDecoder: (): void => undefined,
  closeDecoder: (): void => undefined,
  decodeVideo: (): void => undefined,
  enqueueAudio: (): void => undefined,
};

/** タイマーを起こさない注入。参加の手順だけを見る試験で使う。 */
const NO_TIMERS = {
  scheduleAt: (): (() => void) => (): void => undefined,
  setPeriodic: (): (() => void) => (): void => undefined,
};

test("参加は 5 個の部屋へ接続し hello と streamAnnounce を送る", async () => {
  const opened: string[] = [];
  const sentByRole = new Map<string, string[]>();
  const textHandlers = new Map<string, (text: string) => void>();
  const deps = {
    openSocket: (url: string, role: string): JoinSocket => {
      opened.push(role);
      const log: string[] = [];
      sentByRole.set(role, log);
      assert.ok(url.startsWith("wss://"), "既定は暗号化する");
      return {
        send: (text: string): void => {
          log.push(text);
        },
        sendBinary: (): void => undefined,
        close: (): void => undefined,
        onText: (handler: (text: string) => void): void => {
          textHandlers.set(role, handler);
        },
        onBinary: (): void => undefined,
        // 開いたことを直ちに伝える。リンクはこれを受けて hello を送る。
        onOpen: (handler: () => void): void => handler(),
        onClose: (): void => undefined,
        bufferedBytes: (): number => 0,
      };
    },
    createSink: (): FrameSink => sink(),
    bindOutput: (): void => undefined,
    capability: { hardwareAv1For4K60: false, encodeAv1: true, mobile: false, charging: true },
    // はしごは源から導出する（ADR-0026）。試験では 1080p30 の源を与える。
    source: { width: 1920, height: 1080, framerate: 30 },
    now: (): number => T0,
    ...NO_TIMERS,
    media: NO_MEDIA,
    capture: NO_CAPTURE,
  };

  const url = `https://example.test/j/${MEETING_ID}#${fakeToken(MEETING_ID, USER_ID)}`;
  const joined = await joinWith(url, deps);
  assert.equal(joined.ok, true);
  if (!joined.ok) {
    return;
  }
  assert.deepEqual(opened, ["ctl", "vs", "vr", "as", "ar"], "5 個の部屋へ接続する");

  // `streamAnnounce` と `subscribe` は `ACTIVE` へ入ってから送る（ADR-0032）。
  // `helloAck` を返さない限り送られない。これは仕様どおりである。
  for (const [, handler] of textHandlers) {
    handler(JSON.stringify({ t: "helloAck" }));
  }

  for (const role of opened) {
    const log = sentByRole.get(role) ?? [];
    assert.ok(
      log.some((text) => text.includes('"t":"hello"')),
      `${role} へ hello を送る`,
    );
  }
  const videoSend = sentByRole.get("vs") ?? [];
  assert.ok(
    videoSend.some((text) => text.includes('"t":"streamAnnounce"')),
    "送信部屋へ構成を申告する",
  );
  assert.equal(joined.value.meeting.state, "active", "ctl の helloAck で active になる");
  assert.equal(joined.value.links.get("ctl")?.phase(), "ACTIVE");
});

test("参加は不正な URL とトークンで失敗を返す（例外を投げない）", async () => {
  const deps = {
    openSocket: (): JoinSocket => ({
      send: (): void => undefined,
      sendBinary: (): void => undefined,
      close: (): void => undefined,
      onText: (): void => undefined,
      onBinary: (): void => undefined,
      onOpen: (): void => undefined,
      onClose: (): void => undefined,
      bufferedBytes: (): number => 0,
    }),
    createSink: (): FrameSink => sink(),
    bindOutput: (): void => undefined,
    capability: { hardwareAv1For4K60: false, encodeAv1: true, mobile: false, charging: true },
    // はしごは源から導出する（ADR-0026）。試験では 1080p30 の源を与える。
    source: { width: 1920, height: 1080, framerate: 30 },
    now: (): number => T0,
    ...NO_TIMERS,
    media: NO_MEDIA,
    capture: NO_CAPTURE,
  };
  const noToken = await joinWith(`https://example.test/j/${MEETING_ID}`, deps);
  assert.equal(noToken.ok, false);
  const badPath = await joinWith(`https://example.test/x/${MEETING_ID}#t`, deps);
  assert.equal(badPath.ok, false);
  const badToken = await joinWith(`https://example.test/j/${MEETING_ID}#not-a-token`, deps);
  assert.equal(badToken.ok, false);
});

test("**接続を開けなくても参加は失敗しない。リンクが再接続を待つ**", () => {
  // 一時的に開けないことは頻繁に起きる（回線の瞬断、ノードの起動待ち）。
  // ここで参加そのものを失敗させると、利用者は入り直すことになる。
  // 接続の失敗は状態機械が扱う（`RECONNECT_WAIT` へ入り、バックオフ後に再試行する）。
  const scheduled: number[] = [];
  const deps = {
    openSocket: (_url: string, role: string): JoinSocket | null => {
      if (role === "vr") {
        return null;
      }
      return {
        send: (): void => undefined,
        sendBinary: (): void => undefined,
        close: (): void => undefined,
        onText: (): void => undefined,
        onBinary: (): void => undefined,
        onOpen: (handler: () => void): void => handler(),
        onClose: (): void => undefined,
        bufferedBytes: (): number => 0,
      };
    },
    createSink: (): FrameSink => sink(),
    bindOutput: (): void => undefined,
    capability: { hardwareAv1For4K60: false, encodeAv1: true, mobile: false, charging: true },
    source: { width: 1920, height: 1080, framerate: 30 },
    now: (): number => T0,
    scheduleAt: (atMs: number): (() => void) => {
      scheduled.push(atMs);
      return (): void => undefined;
    },
    setPeriodic: (): (() => void) => (): void => undefined,
    media: NO_MEDIA,
    capture: NO_CAPTURE,
  };
  const url = `https://example.test/j/${MEETING_ID}#${fakeToken(MEETING_ID, USER_ID)}`;
  return joinWith(url, deps).then((result) => {
    assert.equal(result.ok, true, "参加は成立する");
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.links.get("vr")?.phase(), "RECONNECT_WAIT", "開けない部屋は再接続を待つ");
    assert.equal(result.value.links.get("ctl")?.phase(), "HELLO_SENT", "開けた部屋は進む");
    assert.ok(scheduled.length > 0, "バックオフを予約する");
  });
});
