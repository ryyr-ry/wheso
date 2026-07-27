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
import { createMeeting, type VideoSinkHandle } from "../packages/client/src/api/meeting.ts";
import {
  applyControlMessage,
  joinMeeting,
  resolveProfiles,
  senderIdFrom,
  type JoinSocket,
} from "../packages/client/src/api/join-meeting.ts";
import { DELAY_TREND_WINDOW, REPORT_INTERVAL_MS } from "../packages/core/src/generated/constants.ts";

const T0 = 4_000_000;

/** 識別子は規範の形式に従う（room-naming.md 1 節）。ULID 小文字 26 文字と 16 進 32 文字である。 */
const MEETING_ID = "01jxy8kq2r3mz5v7h9abcderfa";
const USER_ID = "550e8400e29b41d4a716446655440000";

function sink(): VideoSinkHandle {
  return {
    attach: (): void => undefined,
    detach: (): void => undefined,
    setDisplaySize: (): void => undefined,
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
      sendVideoControl: (text) => sent.push(text),
      sendAudioControl: (text) => sent.push(text),
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
      sendVideoControl: (text) => sent.push(text),
      sendAudioControl: (text) => sent.push(text),
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
      sendVideoControl: (): void => undefined,
      sendAudioControl: (): void => undefined,
      closeAll: (): void => undefined,
    },
    sinks: { create: () => sink() },
  });

  applyControlMessage(meeting, JSON.stringify({ t: "helloAck" }), T0);
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
  );
  assert.equal(meeting.participants.length, 2);

  // 一覧から消えた参加者は退出として扱う。
  applyControlMessage(
    meeting,
    JSON.stringify({ t: "participants", entries: [{ userId: "u-self", senderId: 1, role: "host" }] }),
    T0,
  );
  assert.equal(meeting.participants.length, 1);

  const chats: string[] = [];
  meeting.on("chatReceived", (event) => chats.push(`${event.from}:${event.text}`));
  applyControlMessage(meeting, JSON.stringify({ t: "chat", from: "u-b", text: "やあ" }), T0);
  assert.deepEqual(chats, ["u-b:やあ"]);

  applyControlMessage(meeting, JSON.stringify({ t: "activeSpeaker", participantId: "u-b" }), T0);
  assert.equal(meeting.activeSpeakerId, "u-b");

  const warnings: string[] = [];
  meeting.on("warning", (code) => warnings.push(code));
  applyControlMessage(meeting, JSON.stringify({ t: "warning", code: "W_DEGRADED" }), T0);
  assert.deepEqual(warnings, ["W_DEGRADED"]);

  applyControlMessage(meeting, JSON.stringify({ t: "error", code: "E_AUTH" }), T0, (code) => errors.push(code));
  assert.deepEqual(errors, ["E_AUTH"], "文言ではなくコードを渡す");

  // 未知の t と壊れた JSON は無視する。
  applyControlMessage(meeting, JSON.stringify({ t: "未知" }), T0);
  applyControlMessage(meeting, "{壊れている", T0);
  assert.equal(meeting.state, "active");
});

test("送信プロファイルは能力から決まり、明示した場合は最低品質と組む", () => {
  const capable = { hardwareAv1For4K60: true, encodeAv1: true, mobile: false, charging: true };
  assert.deepEqual(resolveProfiles(capable), ["V_4K60", "V_360P15"]);
  assert.deepEqual(resolveProfiles(capable, "V_1080P30"), ["V_1080P30", "V_360P15"]);
  assert.deepEqual(resolveProfiles(capable, "V_360P15"), ["V_360P15"], "最低品質のみは重ねない");
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

test("参加は 5 個の部屋へ接続し hello と streamAnnounce を送る", async () => {
  const opened: string[] = [];
  const sentByRole = new Map<string, string[]>();
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
        close: (): void => undefined,
        onText: (): void => undefined,
      };
    },
    createSink: (): VideoSinkHandle => sink(),
    capability: { hardwareAv1For4K60: false, encodeAv1: true, mobile: false, charging: true },
    now: (): number => T0,
  };

  const url = `https://example.partykit.dev/j/${MEETING_ID}#${fakeToken(MEETING_ID, USER_ID)}`;
  const joined = await joinMeeting(url, deps);
  assert.equal(joined.ok, true);
  if (!joined.ok) {
    return;
  }
  assert.deepEqual(opened, ["ctl", "vs", "vr", "as", "ar"], "5 個の部屋へ接続する");

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
  assert.equal(joined.value.meeting.state, "connecting", "helloAck を待つ");
});

test("参加は不正な URL とトークンで失敗を返す（例外を投げない）", async () => {
  const deps = {
    openSocket: (): JoinSocket => ({
      send: (): void => undefined,
      close: (): void => undefined,
      onText: (): void => undefined,
    }),
    createSink: (): VideoSinkHandle => sink(),
    capability: { hardwareAv1For4K60: false, encodeAv1: true, mobile: false, charging: true },
    now: (): number => T0,
  };
  const noToken = await joinMeeting(`https://example.partykit.dev/j/${MEETING_ID}`, deps);
  assert.equal(noToken.ok, false);
  const badPath = await joinMeeting(`https://example.partykit.dev/x/${MEETING_ID}#t`, deps);
  assert.equal(badPath.ok, false);
  const badToken = await joinMeeting(`https://example.partykit.dev/j/${MEETING_ID}#not-a-token`, deps);
  assert.equal(badToken.ok, false);
});

test("接続を開けない場合は開いた分を閉じて失敗を返す", async () => {
  const closed: string[] = [];
  const deps = {
    openSocket: (_url: string, role: string): JoinSocket | null => {
      if (role === "vr") {
        return null;
      }
      return {
        send: (): void => undefined,
        close: (): void => {
          closed.push(role);
        },
        onText: (): void => undefined,
      };
    },
    createSink: (): VideoSinkHandle => sink(),
    capability: { hardwareAv1For4K60: false, encodeAv1: true, mobile: false, charging: true },
    now: (): number => T0,
  };
  const url = `https://example.partykit.dev/j/${MEETING_ID}#${fakeToken(MEETING_ID, USER_ID)}`;
  const result = await joinMeeting(url, deps);
  assert.equal(result.ok, false);
  assert.deepEqual(closed, ["ctl", "vs"], "開いた接続を残さない");
});
