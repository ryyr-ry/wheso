/**
 * 映像プロファイルの表引き。
 *
 * 規範: 定数規範 2 節の映像プロファイル表。値は `generated/constants.ts` から引く。
 * 判断は行わない。tier（= spatialId）に対応するプロファイルを返すだけである。
 */

import { V_360P15, V_1080P30, V_1080P60, V_4K60 } from "./generated/constants.ts";

/** カメラ映像のプロファイル。spatialId の昇順で並べる。 */
const CAMERA_PROFILES = [V_360P15, V_1080P30, V_1080P60, V_4K60] as const;

/** プロファイルのうち、層の指令に必要な部分。 */
export interface EncoderProfile {
  readonly spatialId: number;
  readonly targetBitrate: number;
  readonly temporalLayers: number;
}

/**
 * spatialId に対応するカメラ映像のプロファイルを返す。
 *
 * 範囲外の値は最低品質へ丸める。例外を投げない（パース関数と同じ規則）。
 * 丸めを許す理由は、層の指令が届かないより最低品質で届いた方が会議が成立するためである。
 */
export function videoProfileForSpatialId(spatialId: number): EncoderProfile {
  for (const profile of CAMERA_PROFILES) {
    if (profile.spatialId === spatialId) {
      return profile;
    }
  }
  return V_360P15;
}
