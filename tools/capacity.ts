/**
 * 容量式の検証。
 *
 * プロトコル規範 constants 4 節の表が、定数と式から実際に導かれることを検証する。
 * 定数は スキーマ定義 constants から生成された定義を参照する。
 * 表を手で書き換えて式と乖離させることを防ぐ。
 *
 * 実行: node tools/capacity.ts
 */
import {
  A_SHARD_MAX_PARTICIPANTS,
  AUDIO_BUNDLE_MS,
  AUDIO_SELECTIVE_FORWARD_COUNT,
  A_VOICE,
  NODE_MAX_OUT_BYTES_PER_SEC,
  NODE_MAX_OUT_MESSAGES_PER_SEC,
  OPUS_FRAME_MS,
  V_1080P30,
  V_1080P60,
  V_360P15,
  V_4K60,
  V_FULL_MESH_MAX_1080P30,
  V_FULL_MESH_MAX_1080P60,
  V_FULL_MESH_MAX_360P15,
  V_FULL_MESH_MAX_4K60,
  V_SHARD_MAX_PARTICIPANTS,
} from "../packages/core/src/generated/constants.ts";
import { MESSAGE_HEADER_BYTES, UNIT_HEADER_BYTES } from "../packages/core/src/generated/wire-layout.ts";

interface VideoProfile {
  readonly id: string;
  readonly framerate: number;
  readonly targetBitrate: number;
}

/** 生成された定数からプロファイルを組み立てる。 */
function profile(id: string, source: { readonly framerate: number; readonly targetBitrate: number }): VideoProfile {
  return { id, framerate: source.framerate, targetBitrate: source.targetBitrate };
}

function audioBytesPerPacket(bitrate: number): number {
  return bitrate / (1000 / OPUS_FRAME_MS) / 8;
}

/** 全対全構成での収容人数を返す。 */
function fullMeshCapacity(profile: VideoProfile): {
  readonly byMessages: number;
  readonly byBytes: number;
  readonly limit: number;
} {
  let byMessages = 1;
  while ((byMessages + 1) * byMessages * profile.framerate <= NODE_MAX_OUT_MESSAGES_PER_SEC) {
    byMessages += 1;
  }
  let byBytes = 1;
  while (((byBytes + 1) * byBytes * profile.targetBitrate) / 8 <= NODE_MAX_OUT_BYTES_PER_SEC) {
    byBytes += 1;
  }
  return { byMessages, byBytes, limit: Math.min(byMessages, byBytes) };
}

/** 標準構成（高品質 1 本 + サムネイル N-2 本）での収容人数を返す。 */
function standardCapacity(
  hq: VideoProfile,
  lq: VideoProfile,
): { readonly limit: number; readonly rows: readonly { n: number; messages: number; bytes: number }[] } {
  const rows: { n: number; messages: number; bytes: number }[] = [];
  let limit = 0;
  for (let n = 2; n <= 200; n += 1) {
    const messages = n * (hq.framerate + (n - 2) * lq.framerate);
    const bytes = (n * (hq.targetBitrate + (n - 2) * lq.targetBitrate)) / 8;
    if (messages <= NODE_MAX_OUT_MESSAGES_PER_SEC && bytes <= NODE_MAX_OUT_BYTES_PER_SEC) {
      limit = n;
    }
    if (n === 10 || n === 20 || n === 30 || n === 35 || n === 36) {
      rows.push({ n, messages, bytes });
    }
  }
  return { limit, rows };
}

function audioCapacity(): { readonly limit: number; readonly rows: readonly { n: number; messages: number; bytes: number }[] } {
  const messagesPerSecPerStream = 1000 / AUDIO_BUNDLE_MS;
  const unitsPerMessage = AUDIO_BUNDLE_MS / OPUS_FRAME_MS;
  const bytesPerMessage =
    MESSAGE_HEADER_BYTES + unitsPerMessage * (UNIT_HEADER_BYTES + audioBytesPerPacket(A_VOICE.bitrate));
  const rows: { n: number; messages: number; bytes: number }[] = [];
  let limit = 0;
  for (let n = 2; n <= 1000; n += 1) {
    const messages = n * AUDIO_SELECTIVE_FORWARD_COUNT * messagesPerSecPerStream;
    const bytes = messages * bytesPerMessage;
    if (messages <= NODE_MAX_OUT_MESSAGES_PER_SEC && bytes <= NODE_MAX_OUT_BYTES_PER_SEC) {
      limit = n;
    }
    if (n === 32 || n === 100 || n === 160) {
      rows.push({ n, messages, bytes });
    }
  }
  return { limit, rows };
}

let failures = 0;

function expect(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    failures += 1;
    process.stdout.write(`FAIL ${label}: 期待 ${expected} 実際 ${actual}\n`);
  }
}

function main(): void {
  // constants.md 4.1 の表
  const cases: readonly { profile: VideoProfile; byMessages: number; byBytes: number; limit: number }[] = [
    { profile: profile("V_4K60", V_4K60), byMessages: 18, byBytes: 9, limit: V_FULL_MESH_MAX_4K60 },
    { profile: profile("V_1080P60", V_1080P60), byMessages: 18, byBytes: 19, limit: V_FULL_MESH_MAX_1080P60 },
    { profile: profile("V_1080P30", V_1080P30), byMessages: 26, byBytes: 27, limit: V_FULL_MESH_MAX_1080P30 },
    { profile: profile("V_360P15", V_360P15), byMessages: 37, byBytes: 106, limit: V_FULL_MESH_MAX_360P15 },
  ];
  for (const entry of cases) {
    const result = fullMeshCapacity(entry.profile);
    expect(result.byMessages, entry.byMessages, `${entry.profile.id} メッセージ制約`);
    expect(result.byBytes, entry.byBytes, `${entry.profile.id} バイト制約`);
    expect(result.limit, entry.limit, `${entry.profile.id} 収容人数`);
  }

  // constants.md 4.2 の表
  const standard = standardCapacity(profile("V_4K60", V_4K60), profile("V_360P15", V_360P15));
  expect(standard.limit, V_SHARD_MAX_PARTICIPANTS, "標準構成 V_SHARD_MAX_PARTICIPANTS");
  for (const row of standard.rows) {
    process.stdout.write(
      `  標準構成 N=${row.n}: ${row.messages} msg/s, ${(row.bytes / 1_000_000).toFixed(1)} MB/s\n`,
    );
  }

  // constants.md 4.3 の表
  const audio = audioCapacity();
  expect(audio.limit, A_SHARD_MAX_PARTICIPANTS, "音声 A_SHARD_MAX_PARTICIPANTS");
  for (const row of audio.rows) {
    process.stdout.write(`  音声 N=${row.n}: ${row.messages} msg/s, ${(row.bytes / 1_000_000).toFixed(2)} MB/s\n`);
  }

  // 実測との整合（F-024）: 8 送信 8 受信 50KB 60fps は予算内、16x16 は超過
  const outMessages8 = 8 * 8 * 60;
  const outBytes8 = ((8 * 8 * 25_000_000) / 8) * (1 / 1);
  process.stdout.write(`  実測条件 8x8: ${outMessages8} msg/s（予算 ${NODE_MAX_OUT_MESSAGES_PER_SEC}）\n`);
  if (outBytes8 > NODE_MAX_OUT_BYTES_PER_SEC) {
    process.stdout.write(
      `  注意: 8x8 の 25Mbps 全対全はバイト予算を超える（${(outBytes8 / 1_000_000).toFixed(0)} MB/s）。` +
        `実測で追従できたのは 50KB/frame = 24Mbps 相当かつ受信者 8 人の条件である\n`,
    );
  }

  if (failures === 0) {
    process.stdout.write("OK: 容量式と規範の表が一致\n");
    return;
  }
  process.stdout.write(`${failures} 件の不一致\n`);
  process.exitCode = 1;
}

main();
