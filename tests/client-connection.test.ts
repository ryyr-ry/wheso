/**
 * クライアントのメディア接続の状態機械の試験。
 *
 * state-machines.md 1 節の表を一行ずつ検証する。表から書き、実装をなぞらない。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  backoffFor,
  connectionStep,
  initialConnectionState,
  isFatal,
  type ConnectionCommand,
  type ConnectionEvent,
  type ConnectionState,
} from "../packages/client/src/transport/connection.ts";
import {
  HEARTBEAT_TIMEOUT_MS,
  RECONNECT_BACKOFF_MS,
  STANDBY_SWAP_TIMEOUT_MS,
  VIDEO_STALL_RESET_MS,
} from "../packages/core/src/generated/constants.ts";
import { ERROR_DEFINITIONS } from "../packages/core/src/generated/errors.ts";

/** イベント列を順に流し、最後の状態と全コマンドを返す。 */
function drive(
  events: readonly { readonly event: ConnectionEvent; readonly t: number }[],
  start: ConnectionState = initialConnectionState(0),
): { state: ConnectionState; commands: ConnectionCommand[] } {
  let state = start;
  const commands: ConnectionCommand[] = [];
  for (const entry of events) {
    const result = connectionStep(state, entry.event, entry.t);
    state = result.state;
    commands.push(...result.commands);
  }
  return { state, commands };
}

const kinds = (commands: readonly ConnectionCommand[]): readonly string[] => commands.map((c) => c.kind);

test("表 1 行目: IDLE で open() を呼ぶと CONNECTING になり WebSocket を生成する", () => {
  const result = connectionStep(initialConnectionState(0), { kind: "open" }, 10);
  assert.equal(result.state.phase, "CONNECTING");
  assert.deepEqual(kinds(result.commands), ["createSocket"]);
});

test("表 2 行目: CONNECTING で onopen なら hello を送りタイマーを開始する", () => {
  const result = drive([
    { event: { kind: "open" }, t: 0 },
    { event: { kind: "socketOpen" }, t: 100 },
  ]);
  assert.equal(result.state.phase, "HELLO_SENT");
  assert.deepEqual(kinds(result.commands), ["createSocket", "sendHello", "schedule"]);
  const schedule = result.commands.find((c) => c.kind === "schedule");
  assert.equal(schedule?.kind === "schedule" ? schedule.at : 0, 100 + HEARTBEAT_TIMEOUT_MS);
});

test("表 3 行目と 4 行目: 接続失敗はバックオフして再試行する", () => {
  let state = connectionStep(initialConnectionState(0), { kind: "open" }, 0).state;
  const expected: number[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const failed = connectionStep(state, { kind: "socketError" }, 1000 * attempt);
    assert.equal(failed.state.phase, "RECONNECT_WAIT");
    const schedule = failed.commands.find((c) => c.kind === "schedule");
    const at = schedule?.kind === "schedule" ? schedule.at : -1;
    expected.push(at - 1000 * attempt);
    // 待機満了で再度 CONNECTING に戻る（表 20 行目）
    state = connectionStep(failed.state, { kind: "timeout" }, 1000 * attempt + 1).state;
    assert.equal(state.phase, "CONNECTING");
  }
  const last = RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1] ?? 0;
  assert.deepEqual(expected, [...RECONNECT_BACKOFF_MS, last, last], "表の値を順に使い、以後は最後の値");
});

test("表 5 行目: helloAck で ACTIVE になり streamAnnounce と予備接続を開始する", () => {
  const result = drive([
    { event: { kind: "open" }, t: 0 },
    { event: { kind: "socketOpen" }, t: 10 },
    { event: { kind: "helloAck" }, t: 20 },
  ]);
  assert.equal(result.state.phase, "ACTIVE");
  assert.ok(kinds(result.commands).includes("sendStreamAnnounce"));
  assert.ok(kinds(result.commands).includes("startStandby"));
  assert.equal(result.state.attempts, 0, "成功で試行回数が戻る");
});

test("表 6 行目: 回復不可のコードでは FAILED になり再接続しない", () => {
  const fatalCode = ERROR_DEFINITIONS.E_WIRE_MAGIC.closeCode;
  assert.equal(isFatal(fatalCode), true, "自動再接続しないコードである");
  const result = drive([
    { event: { kind: "open" }, t: 0 },
    { event: { kind: "socketOpen" }, t: 10 },
    { event: { kind: "socketClose", code: fatalCode }, t: 20 },
  ]);
  assert.equal(result.state.phase, "FAILED");
  assert.ok(kinds(result.commands).includes("fail"));
});

test("表 7 行目: HELLO_SENT でタイムアウトすると接続を閉じて再接続を待つ", () => {
  const started = drive([
    { event: { kind: "open" }, t: 0 },
    { event: { kind: "socketOpen" }, t: 10 },
  ]);
  const result = connectionStep(started.state, { kind: "timeout" }, 10 + HEARTBEAT_TIMEOUT_MS);
  assert.equal(result.state.phase, "RECONNECT_WAIT");
  assert.ok(kinds(result.commands).includes("closeSocket"));
});

function activeState(): ConnectionState {
  return drive([
    { event: { kind: "open" }, t: 0 },
    { event: { kind: "socketOpen" }, t: 10 },
    { event: { kind: "helloAck" }, t: 20 },
  ]).state;
}

test("表 8 行目: ACTIVE で報告タイマーが鳴ると report を送る（状態は変わらない）", () => {
  const result = connectionStep(activeState(), { kind: "reportTimer" }, 100);
  assert.equal(result.state.phase, "ACTIVE");
  assert.deepEqual(kinds(result.commands), ["sendReport"]);
});

test("表 9 行目: 勾配が劣化閾値を超えると DEGRADED になり tier を下げて警告する", () => {
  const result = connectionStep(activeState(), { kind: "trendDegrade" }, 100);
  assert.equal(result.state.phase, "DEGRADED");
  assert.deepEqual(kinds(result.commands), ["tierDown", "warn"]);
});

test("表 10 行目: 停滞が閾値を超え予備接続があれば SWAPPING へ移る", () => {
  const withStandby = connectionStep(activeState(), { kind: "standbyReady", ready: true }, 50).state;
  const result = connectionStep(withStandby, { kind: "stall", durationMs: VIDEO_STALL_RESET_MS + 1 }, 100);
  assert.equal(result.state.phase, "SWAPPING");
  assert.ok(kinds(result.commands).includes("swapToStandby"));
});

test("表 11 行目: 予備接続が無ければ再接続を待つ", () => {
  const result = connectionStep(activeState(), { kind: "stall", durationMs: VIDEO_STALL_RESET_MS + 1 }, 100);
  assert.equal(result.state.phase, "RECONNECT_WAIT");
  assert.ok(kinds(result.commands).includes("closeSocket"));
});

test("停滞が閾値以下では遷移しない（境界の検査）", () => {
  const result = connectionStep(activeState(), { kind: "stall", durationMs: VIDEO_STALL_RESET_MS }, 100);
  assert.equal(result.state.phase, "ACTIVE");
});

test("表 14 行目: close() で CLOSED になる", () => {
  const result = connectionStep(activeState(), { kind: "close" }, 100);
  assert.equal(result.state.phase, "CLOSED");
  assert.deepEqual(kinds(result.commands), ["closeSocket"]);
});

test("表 15 行目: DEGRADED で回復すると ACTIVE に戻り tier を上げる", () => {
  const degraded = connectionStep(activeState(), { kind: "trendDegrade" }, 100).state;
  const result = connectionStep(degraded, { kind: "trendRecover" }, 200);
  assert.equal(result.state.phase, "ACTIVE");
  assert.deepEqual(kinds(result.commands), ["tierUp"]);
});

test("表 16 行目: DEGRADED でさらに劣化しても何も起きない", () => {
  const degraded = connectionStep(activeState(), { kind: "trendDegrade" }, 100).state;
  const result = connectionStep(degraded, { kind: "trendDegrade" }, 200);
  assert.equal(result.state.phase, "DEGRADED");
  assert.equal(result.commands.length, 0);
});

test("表 17 行目: SWAPPING でキーフレームを受けると ACTIVE へ戻り旧接続を閉じる", () => {
  const withStandby = connectionStep(activeState(), { kind: "standbyReady", ready: true }, 50).state;
  const swapping = connectionStep(withStandby, { kind: "stall", durationMs: VIDEO_STALL_RESET_MS + 1 }, 100).state;
  const result = connectionStep(swapping, { kind: "standbyKeyframe" }, 150);
  assert.equal(result.state.phase, "ACTIVE");
  assert.deepEqual(kinds(result.commands), ["closeSocket", "sendSubscribe", "startStandby", "warn"]);
  assert.equal(result.state.standbyReady, false, "新しい予備接続を確立するまでは使えない");
});

test("表 18 行目: SWAPPING が時限を超えると両接続を閉じて再接続を待つ", () => {
  const withStandby = connectionStep(activeState(), { kind: "standbyReady", ready: true }, 50).state;
  const swapping = connectionStep(withStandby, { kind: "stall", durationMs: VIDEO_STALL_RESET_MS + 1 }, 100).state;
  const early = connectionStep(swapping, { kind: "timeout" }, 100 + STANDBY_SWAP_TIMEOUT_MS - 1);
  assert.equal(early.state.phase, "SWAPPING", "時限前は待つ");
  const result = connectionStep(swapping, { kind: "timeout" }, 100 + STANDBY_SWAP_TIMEOUT_MS);
  assert.equal(result.state.phase, "RECONNECT_WAIT");
  assert.deepEqual(kinds(result.commands), ["closeSocket", "closeStandby", "schedule"]);
});

test("表 21 行目: RECONNECT_WAIT で close() すると CLOSED になる", () => {
  const waiting = connectionStep(activeState(), { kind: "stall", durationMs: VIDEO_STALL_RESET_MS + 1 }, 100).state;
  const result = connectionStep(waiting, { kind: "close" }, 200);
  assert.equal(result.state.phase, "CLOSED");
});

test("表 22 行目: FAILED からは open() のみで復帰し試行回数が 0 に戻る", () => {
  const fatalCode = ERROR_DEFINITIONS.E_WIRE_MAGIC.closeCode;
  const failed = drive([
    { event: { kind: "open" }, t: 0 },
    { event: { kind: "socketOpen" }, t: 10 },
    { event: { kind: "socketClose", code: fatalCode }, t: 20 },
  ]).state;
  const ignored = connectionStep(failed, { kind: "reportTimer" }, 30);
  assert.equal(ignored.state.phase, "FAILED", "他のイベントでは復帰しない");
  const reopened = connectionStep(failed, { kind: "open" }, 40);
  assert.equal(reopened.state.phase, "CONNECTING");
  assert.equal(reopened.state.attempts, 0);
});

test("**応答が途絶えたら自分から閉じて張り直す**（規範 1 節の HEARTBEAT_TIMEOUT_MS）", () => {
  // `close` の事象が来ない切れ方が実際にある。実測（段 E）: 経路を落としたとき `vr` だけが
  // `close` を受け取り、`ctl` / `vs` / `as` / `ar` は `CLOSING` のまま `close` が来ず、
  // **音声が二度と戻らなかった**。心拍の応答の途絶を自分で見て張り直す。
  const active = drive([
    { event: { kind: "open" }, t: 0 },
    { event: { kind: "socketOpen" }, t: 10 },
    { event: { kind: "inbound" }, t: 20 },
    { event: { kind: "helloAck" }, t: 20 },
  ]);
  assert.equal(active.state.phase, "ACTIVE");

  // 応答があるうちは何もしない。
  const alive = drive(
    [
      { event: { kind: "inbound" }, t: 1000 },
      { event: { kind: "timeout" }, t: 1000 + HEARTBEAT_TIMEOUT_MS - 1 },
    ],
    active.state,
  );
  assert.equal(alive.state.phase, "ACTIVE", "途絶えていなければ ACTIVE のままである");
  assert.deepEqual(kinds(alive.commands), [], "何も起こさない");

  // 途絶えたら閉じて再接続を待つ。
  const dead = drive(
    [
      { event: { kind: "inbound" }, t: 1000 },
      { event: { kind: "timeout" }, t: 1000 + HEARTBEAT_TIMEOUT_MS },
    ],
    active.state,
  );
  assert.equal(dead.state.phase, "RECONNECT_WAIT");
  assert.ok(kinds(dead.commands).includes("closeSocket"), "こちらから閉じる");
  assert.ok(kinds(dead.commands).includes("schedule"), "バックオフを予約する");
});

test("受け取ったことが無い接続では死活監視が働かない（誤検知しない）", () => {
  // 確立の直後は受信が無い。ここで閉じると、遅い握手を切ってしまう。
  // `HELLO_SENT` の時限は表の別の行が扱う。
  const active = drive([
    { event: { kind: "open" }, t: 0 },
    { event: { kind: "socketOpen" }, t: 10 },
    { event: { kind: "helloAck" }, t: 20 },
  ]);
  assert.equal(active.state.phase, "ACTIVE");
  const later = drive([{ event: { kind: "timeout" }, t: 100_000 }], active.state);
  assert.equal(later.state.phase, "ACTIVE", "受信の記録が無ければ判定しない");
});

test("表に無いイベントは無視して記録する", () => {
  const result = connectionStep(initialConnectionState(0), { kind: "helloAck" }, 10);
  assert.equal(result.state.phase, "IDLE");
  assert.deepEqual(result.state.unexpectedEvents, ["helloAck"]);
});

test("バックオフの表を超える試行では最後の値を使う", () => {
  assert.equal(backoffFor(0), RECONNECT_BACKOFF_MS[0]);
  assert.equal(backoffFor(RECONNECT_BACKOFF_MS.length + 5), RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1]);
});

test("同じ入力列を 2 回流すと同じ出力になる（決定性）", () => {
  const events: readonly { readonly event: ConnectionEvent; readonly t: number }[] = [
    { event: { kind: "open" }, t: 0 },
    { event: { kind: "socketOpen" }, t: 10 },
    { event: { kind: "helloAck" }, t: 20 },
    { event: { kind: "standbyReady", ready: true }, t: 30 },
    { event: { kind: "trendDegrade" }, t: 40 },
    { event: { kind: "trendRecover" }, t: 50 },
    { event: { kind: "stall", durationMs: VIDEO_STALL_RESET_MS + 1 }, t: 60 },
    { event: { kind: "standbyKeyframe" }, t: 70 },
  ];
  assert.deepEqual(drive(events).commands, drive(events).commands);
});

test("FAILED では open() 以外のいかなるイベントでも復帰しない", () => {
  // 監査で「FAILED に timeout を送ると復帰する実装」が試験を通り抜けた。
  // 表 22 行目は open() のみを認めているため、全イベント種を網羅して確かめる。
  const fatalCode = ERROR_DEFINITIONS.E_WIRE_MAGIC.closeCode;
  const failed = drive([
    { event: { kind: "open" }, t: 0 },
    { event: { kind: "socketOpen" }, t: 10 },
    { event: { kind: "socketClose", code: fatalCode }, t: 20 },
  ]).state;
  assert.equal(failed.phase, "FAILED");

  const others: readonly ConnectionEvent[] = [
    { kind: "timeout" },
    { kind: "socketOpen" },
    { kind: "socketError" },
    { kind: "socketClose", code: 1000 },
    { kind: "helloAck" },
    { kind: "reportTimer" },
    { kind: "trendDegrade" },
    { kind: "trendRecover" },
    { kind: "stall", durationMs: 100_000 },
    { kind: "standbyKeyframe" },
    { kind: "close" },
  ];
  for (const event of others) {
    const result = connectionStep(failed, event, 1000);
    assert.equal(result.state.phase, "FAILED", `${event.kind} では復帰しない`);
    assert.equal(result.commands.length, 0, `${event.kind} では副作用を出さない`);
  }
});

test("**ACTIVE へ入るすべての遷移で購読を送り直す**（ADR-0032）", () => {
  // 購読は接続に紐づく。送り直さないと再接続後に無音の黒画面になる。
  const helloAck = connectionStep(
    connectionStep(connectionStep(initialConnectionState(0), { kind: "open" }, 0).state, { kind: "socketOpen" }, 10)
      .state,
    { kind: "helloAck" },
    20,
  );
  assert.equal(helloAck.state.phase, "ACTIVE");
  assert.ok(kinds(helloAck.commands).includes("sendSubscribe"), "helloAck の直後に送り直す");

  const withStandby = connectionStep(activeState(), { kind: "standbyReady", ready: true }, 50).state;
  const swapping = connectionStep(withStandby, { kind: "stall", durationMs: VIDEO_STALL_RESET_MS + 1 }, 100).state;
  const swapped = connectionStep(swapping, { kind: "standbyKeyframe" }, 150);
  assert.ok(kinds(swapped.commands).includes("sendSubscribe"), "予備接続への切替でも送り直す");
});
