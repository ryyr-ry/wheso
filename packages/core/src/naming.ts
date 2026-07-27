/**
 * 部屋名の決定論的計算とシャード割当の参照実装。
 *
 * 規範は プロトコル規範 room-naming である。
 *
 * 本ファイルの制約（spec/lint-policy.md）:
 *   any / 型アサーション / 非 null 断定を使用しない。例外を投げない。
 */

import { err, ok, type Result } from "./wire.ts";

export type NamingErrorCode =
  | "E_NAME_MEETING_ID"
  | "E_NAME_USER_ID"
  | "E_NAME_REGION"
  | "E_NAME_EPOCH"
  | "E_NAME_SHARD_INDEX"
  | "E_NAME_SHARD_COUNT"
  | "E_NAME_TOO_LONG";

export interface NamingError {
  readonly code: NamingErrorCode;
  readonly detail: string;
}

/** 予約されたリージョン値。Q-002 の解決までこの値のみを使用する。 */
export const REGION_AUTO = "auto";

export const MAX_ROOM_NAME_LENGTH = 96;

const MEETING_ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{26}$/;
const USER_ID_PATTERN = /^[0-9a-f]{32}$/;
const REGION_PATTERN = /^(auto|[a-z]{3})$/;

export function validateMeetingId(meetingId: string): Result<string, NamingError> {
  if (!MEETING_ID_PATTERN.test(meetingId)) {
    return err({ code: "E_NAME_MEETING_ID", detail: meetingId });
  }
  return ok(meetingId);
}

export function validateUserId(userId: string): Result<string, NamingError> {
  if (!USER_ID_PATTERN.test(userId)) {
    return err({ code: "E_NAME_USER_ID", detail: userId });
  }
  return ok(userId);
}

export function validateRegion(region: string): Result<string, NamingError> {
  if (!REGION_PATTERN.test(region)) {
    return err({ code: "E_NAME_REGION", detail: region });
  }
  return ok(region);
}

function validateEpoch(epoch: number): Result<number, NamingError> {
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > 1_000_000_000) {
    return err({ code: "E_NAME_EPOCH", detail: String(epoch) });
  }
  return ok(epoch);
}

function validateIndex(index: number, code: NamingErrorCode): Result<number, NamingError> {
  if (!Number.isInteger(index) || index < 0 || index > 100_000) {
    return err({ code, detail: String(index) });
  }
  return ok(index);
}

function finish(name: string): Result<string, NamingError> {
  if (name.length > MAX_ROOM_NAME_LENGTH) {
    return err({ code: "E_NAME_TOO_LONG", detail: `${name.length} chars` });
  }
  return ok(name);
}

/* ------------------------------------------------------------------------- */
/* ハッシュ関数                                                              */
/* ------------------------------------------------------------------------- */

/** UTF-8 バイト列へ変換する。 */
function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * FNV-1a 32bit。
 * h = 0x811c9dc5、各バイトについて h ^= b; h = h * 0x01000193 (mod 2^32)。
 */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of utf8Bytes(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * MurmurHash3 の 32bit ファイナライザ。
 * FNV-1a の下位ビットの偏りを解消するために適用する。
 */
export function fmix32(input: number): number {
  let hash = input >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash >>>= 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash >>>= 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * Rendezvous hashing のスコア。
 * key と候補番号の組に対して一意のスコアを返す。
 */
export function rendezvousScore(key: string, candidateIndex: number): number {
  return fmix32(fnv1a32(`${key}:${candidateIndex}`));
}

/**
 * Rendezvous hashing (Highest Random Weight) による割当。
 *
 * modulo による割当（`hash % count`）を使ってはならない。理由は
 * count が変化した際にほぼ全ての要素が再配置されるためである。
 * Rendezvous hashing では移動するのは期待値で 1/newCount のみである。
 *
 * 同スコアの場合は候補番号の小さい方を選ぶ（決定論性のため）。
 */
export function assignByRendezvous(key: string, candidateCount: number): Result<number, NamingError> {
  if (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > 100_000) {
    return err({ code: "E_NAME_SHARD_COUNT", detail: String(candidateCount) });
  }
  let bestIndex = 0;
  let bestScore = rendezvousScore(key, 0);
  for (let index = 1; index < candidateCount; index += 1) {
    const score = rendezvousScore(key, index);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return ok(bestIndex);
}

/* ------------------------------------------------------------------------- */
/* シャード数の算出                                                          */
/* ------------------------------------------------------------------------- */

/**
 * シャード数を参加者数から算出する。
 * 単調非減少を保証するため、直前のシャード数より小さい値は返さない。
 */
export function shardCount(
  participantCount: number,
  maxPerShard: number,
  previousCount: number,
): Result<number, NamingError> {
  if (!Number.isInteger(participantCount) || participantCount < 0) {
    return err({ code: "E_NAME_SHARD_COUNT", detail: `participantCount=${participantCount}` });
  }
  if (!Number.isInteger(maxPerShard) || maxPerShard < 1) {
    return err({ code: "E_NAME_SHARD_COUNT", detail: `maxPerShard=${maxPerShard}` });
  }
  if (!Number.isInteger(previousCount) || previousCount < 0) {
    return err({ code: "E_NAME_SHARD_COUNT", detail: `previousCount=${previousCount}` });
  }
  // 切り上げ除算を整数で行う。浮動小数点除算は言語ごとに丸めが異なるため使わない
  // （conformance.md 3.3、ADR-0017）。ceil(a / b) = floor((a + b - 1) / b)。
  const ceiled = Math.trunc((participantCount + maxPerShard - 1) / maxPerShard);
  const required = ceiled < 1 ? 1 : ceiled;
  return ok(Math.max(required, previousCount));
}

/* ------------------------------------------------------------------------- */
/* 部屋名                                                                    */
/* ------------------------------------------------------------------------- */

export type PersonalRole = "ctl" | "vs" | "vr" | "as" | "ar";
export type SharedRole = "vsh" | "ash" | "vco" | "aco" | "vag" | "aag";

/** 会議全体の制御部屋。 */
export function metaRoom(meetingId: string): Result<string, NamingError> {
  const validated = validateMeetingId(meetingId);
  if (!validated.ok) {
    return validated;
  }
  return finish(`meta-${validated.value}`);
}

/** 個人部屋。epoch を含めない（参加者数に依存しないため）。 */
export function personalRoom(role: PersonalRole, meetingId: string, userId: string): Result<string, NamingError> {
  const meeting = validateMeetingId(meetingId);
  if (!meeting.ok) {
    return meeting;
  }
  const user = validateUserId(userId);
  if (!user.ok) {
    return user;
  }
  return finish(`${role}-${meeting.value}-${user.value}`);
}

/** シャード部屋。epoch と shardIndex を含める。 */
export function shardRoom(
  role: "vsh" | "ash",
  meetingId: string,
  region: string,
  epoch: number,
  shardIndex: number,
): Result<string, NamingError> {
  const meeting = validateMeetingId(meetingId);
  if (!meeting.ok) {
    return meeting;
  }
  const validRegion = validateRegion(region);
  if (!validRegion.ok) {
    return validRegion;
  }
  const validEpoch = validateEpoch(epoch);
  if (!validEpoch.ok) {
    return validEpoch;
  }
  const validIndex = validateIndex(shardIndex, "E_NAME_SHARD_INDEX");
  if (!validIndex.ok) {
    return validIndex;
  }
  return finish(`${role}-${meeting.value}-${validRegion.value}-${validEpoch.value}-${validIndex.value}`);
}

/** ファンアウト部屋。シャードの下に付く転送専用ノード。 */
export function fanoutRoom(
  role: "vfo" | "afo",
  meetingId: string,
  region: string,
  epoch: number,
  shardIndex: number,
  fanoutIndex: number,
): Result<string, NamingError> {
  const base = shardRoom(role === "vfo" ? "vsh" : "ash", meetingId, region, epoch, shardIndex);
  if (!base.ok) {
    return base;
  }
  const validFanout = validateIndex(fanoutIndex, "E_NAME_SHARD_INDEX");
  if (!validFanout.ok) {
    return validFanout;
  }
  const meeting = validateMeetingId(meetingId);
  if (!meeting.ok) {
    return meeting;
  }
  return finish(`${role}-${meeting.value}-${region}-${epoch}-${shardIndex}-${validFanout.value}`);
}

/** 上位調整部屋。shardIndex を持たない。 */
export function coordinatorRoom(
  role: "vco" | "aco" | "vag" | "aag",
  meetingId: string,
  region: string,
  epoch: number,
): Result<string, NamingError> {
  const meeting = validateMeetingId(meetingId);
  if (!meeting.ok) {
    return meeting;
  }
  const validRegion = validateRegion(region);
  if (!validRegion.ok) {
    return validRegion;
  }
  const validEpoch = validateEpoch(epoch);
  if (!validEpoch.ok) {
    return validEpoch;
  }
  return finish(`${role}-${meeting.value}-${validRegion.value}-${validEpoch.value}`);
}

/* ------------------------------------------------------------------------- */
/* 割当の解決                                                                */
/* ------------------------------------------------------------------------- */

export interface ShardAssignmentInput {
  readonly userId: string;
  readonly meetingId: string;
  readonly region: string;
  readonly epoch: number;
  readonly shardCount: number;
  /** MetaRoom が公開する上書き表。容量均衡のために用いる。省略時は Rendezvous の結果を使う */
  readonly overrides: ReadonlyMap<string, number>;
}

export interface ShardAssignment {
  readonly shardIndex: number;
  readonly source: "override" | "rendezvous";
  readonly roomName: string;
}

/**
 * 映像シャードの割当を解決する。
 * 上書き表に該当があればそれを使い、無ければ Rendezvous hashing で決める。
 */
export function resolveVideoShard(input: ShardAssignmentInput): Result<ShardAssignment, NamingError> {
  return resolveShard("vsh", "video", input);
}

/** 音声シャードの割当を解決する。映像とハッシュ空間を分離する。 */
export function resolveAudioShard(input: ShardAssignmentInput): Result<ShardAssignment, NamingError> {
  return resolveShard("ash", "audio", input);
}

function resolveShard(
  role: "vsh" | "ash",
  namespace: string,
  input: ShardAssignmentInput,
): Result<ShardAssignment, NamingError> {
  const user = validateUserId(input.userId);
  if (!user.ok) {
    return user;
  }
  const override = input.overrides.get(input.userId);
  let shardIndex: number;
  let source: "override" | "rendezvous";
  if (override !== undefined) {
    if (!Number.isInteger(override) || override < 0 || override >= input.shardCount) {
      return err({ code: "E_NAME_SHARD_INDEX", detail: `override=${override}` });
    }
    shardIndex = override;
    source = "override";
  } else {
    const assigned = assignByRendezvous(`${namespace}:${input.userId}`, input.shardCount);
    if (!assigned.ok) {
      return assigned;
    }
    shardIndex = assigned.value;
    source = "rendezvous";
  }
  const roomName = shardRoom(role, input.meetingId, input.region, input.epoch, shardIndex);
  if (!roomName.ok) {
    return roomName;
  }
  return ok({ shardIndex, source, roomName: roomName.value });
}

/**
 * シャード数の変化により再配置される要素の割合を求める（検証用）。
 * Rendezvous hashing では 1/newCount に漸近する。
 */
export function reassignmentRatio(keys: readonly string[], oldCount: number, newCount: number): number {
  if (keys.length === 0) {
    return 0;
  }
  let moved = 0;
  for (const key of keys) {
    const before = assignByRendezvous(key, oldCount);
    const after = assignByRendezvous(key, newCount);
    if (!before.ok || !after.ok) {
      continue;
    }
    if (before.value !== after.value) {
      moved += 1;
    }
  }
  return moved / keys.length;
}
