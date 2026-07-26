/**
 * simulcast のエンコーダ群。
 *
 * 解像度ごとに独立した `VideoEncoder` を持つ（ADR-0004。AV1 の spatial SVC は
 * ブラウザで使えないため、解像度方向は simulcast で実現する）。
 *
 * 本ファイルはブラウザ API に触れる層である（コアではない）。判断は持たない。
 *   - どのプロファイルを使うかは capability.ts が決める
 *   - DISCARDABLE の判定は core の computeDiscardable のみを使う（独自判断を書かない）
 *   - ヘッダの組み立ては core の encodeMediaMessage を使う
 */

import { computeDiscardable, encodeMediaMessage, type Unit } from "@wheso/core/src/wire.ts";
import {
  V_1080P30,
  V_1080P60,
  V_360P15,
  V_4K60,
} from "@wheso/core/src/generated/constants.ts";
import { FLAG_END_OF_FRAME, FLAG_KEY } from "@wheso/core/src/generated/wire-layout.ts";
import { type Result, err, ok } from "@wheso/core/src/result.ts";
import type { ProfileId } from "./capability.ts";

export interface EncoderError {
  readonly code: string;
  readonly detail: string;
}

/** 1 本のエンコーダの設定。数値は定数から引く。 */
export interface EncoderSpec {
  readonly profile: ProfileId;
  readonly spatialId: number;
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
  readonly bitrate: number;
  readonly scalabilityMode: string;
  readonly temporalLayers: number;
}

/** プロファイル識別子から設定を引く。 */
export function specOf(profile: ProfileId): Result<EncoderSpec, EncoderError> {
  switch (profile) {
    case "V_4K60":
      return ok(fromConstant(profile, V_4K60, 3));
    case "V_1080P60":
      return ok(fromConstant(profile, V_1080P60, 3));
    case "V_1080P30":
      return ok(fromConstant(profile, V_1080P30, 3));
    case "V_360P15":
      return ok(fromConstant(profile, V_360P15, 2));
    case "H264_1080P30":
      return ok({ ...fromConstant(profile, V_1080P30, 1), scalabilityMode: "L1T1" });
    case "H264_360P15":
      return ok({ ...fromConstant(profile, V_360P15, 1), scalabilityMode: "L1T1" });
  }
}

interface ProfileConstant {
  readonly spatialId: number;
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
  readonly targetBitrate: number;
  readonly scalabilityMode: string;
}

function fromConstant(profile: ProfileId, constant: ProfileConstant, temporalLayers: number): EncoderSpec {
  return {
    profile,
    spatialId: constant.spatialId,
    width: constant.width,
    height: constant.height,
    framerate: constant.framerate,
    bitrate: constant.targetBitrate,
    scalabilityMode: constant.scalabilityMode,
    temporalLayers,
  };
}

/** コーデック文字列。AV1 と H.264 で異なる。 */
export function codecOf(profile: ProfileId): string {
  return profile.startsWith("H264") ? "avc1.42E01F" : "av01.0.08M.08";
}

/** 符号化されたチャンクから、ワイヤ形式の 1 メッセージを作るための入力。 */
export interface EncodedInput {
  readonly channel: number;
  readonly senderId: number;
  readonly sequenceNumber: number;
  readonly captureTimestampUs: bigint;
  readonly spatialId: number;
  readonly temporalId: number;
  readonly temporalLayers: number;
  readonly isKey: boolean;
  readonly payload: Uint8Array;
}

/**
 * 符号化結果をワイヤ形式のバイト列にする。
 *
 * DISCARDABLE は core の関数の結果のみを使う。独自の判断を書いてはならない。
 * 映像は常に `unitCount = 1` である（wire-format.md 1.5）。
 */
export function packEncoded(input: EncodedInput): Result<Uint8Array, EncoderError> {
  const discardable = computeDiscardable(input.channel, input.isKey, input.temporalId, input.temporalLayers);
  const flags =
    FLAG_END_OF_FRAME | (input.isKey ? FLAG_KEY : 0) | (discardable ? 0x02 : 0);
  const unit: Unit = {
    sequenceNumber: input.sequenceNumber,
    captureTimestampUs: input.captureTimestampUs,
    flags,
    spatialId: input.spatialId,
    temporalId: input.temporalId,
    payload: input.payload,
  };
  const encoded = encodeMediaMessage({
    channel: input.channel,
    senderId: input.senderId,
    units: [unit],
  });
  if (!encoded.ok) {
    return err({ code: encoded.error.code, detail: encoded.error.detail });
  }
  return ok(encoded.value);
}

/**
 * 符号化のメタデータから temporalId を取り出す。
 *
 * 実装によって位置が異なる（F-011、F-028）。順に見て最初に見つかった値を使う。
 * 見つからない場合は 0 とする（単層として扱う）。
 */
export function temporalIdFrom(metadata: unknown): number {
  if (typeof metadata !== "object" || metadata === null) {
    return 0;
  }
  const record: Record<string, unknown> = { ...metadata };
  const svc = record["svc"];
  if (typeof svc === "object" && svc !== null) {
    const svcRecord: Record<string, unknown> = { ...svc };
    const layer = svcRecord["temporalLayerId"];
    if (typeof layer === "number" && Number.isInteger(layer)) {
      return layer;
    }
  }
  const direct = record["temporalLayerId"];
  if (typeof direct === "number" && Number.isInteger(direct)) {
    return direct;
  }
  return 0;
}
