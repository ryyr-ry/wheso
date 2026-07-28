// このファイルは spec/schema/impairment.json から生成される。手で編集してはならない。
// 生成: node tools/codegen.ts generate

export interface ImpairmentStep {
  readonly atSec: number;
  /** 0 は帯域制限なしを表す。 */
  readonly rateKbit: number;
  readonly delayMs: number;
  readonly jitterMs: number;
  readonly reorderPercent: number;
  readonly duplicatePercent: number;
}

export interface ImpairmentOutage {
  readonly everySec: number;
  readonly durationMs: number;
}

export interface ImpairmentProfile {
  readonly id: string;
  readonly note: string;
  readonly steps: readonly ImpairmentStep[];
  readonly outage?: ImpairmentOutage;
  readonly egressOnly?: boolean;
}

export const IMPAIRMENT_DURATION_SEC = 60;

export const IMPAIRMENT_PROFILES: readonly ImpairmentProfile[] =
  [
    {
      "id": "N-0",
      "note": "劣化なし（基準）。全フレームが同一に再生されることを確かめる",
      "steps": [
        {
          "atSec": 0,
          "rateKbit": 0,
          "delayMs": 0,
          "jitterMs": 0,
          "reorderPercent": 0,
          "duplicatePercent": 0
        }
      ]
    },
    {
      "id": "N-1",
      "note": "帯域 8 Mbps 固定。tier が下がるが再生は継続する",
      "steps": [
        {
          "atSec": 0,
          "rateKbit": 8000,
          "delayMs": 0,
          "jitterMs": 0,
          "reorderPercent": 0,
          "duplicatePercent": 0
        }
      ]
    },
    {
      "id": "N-2",
      "note": "50 Mbps から 2 Mbps へ 10 秒で段階降下、20 秒維持、10 秒で復帰",
      "steps": [
        {
          "atSec": 0,
          "rateKbit": 50000,
          "delayMs": 0,
          "jitterMs": 0,
          "reorderPercent": 0,
          "duplicatePercent": 0
        },
        {
          "atSec": 10,
          "rateKbit": 26000,
          "delayMs": 0,
          "jitterMs": 0,
          "reorderPercent": 0,
          "duplicatePercent": 0
        },
        {
          "atSec": 15,
          "rateKbit": 2000,
          "delayMs": 0,
          "jitterMs": 0,
          "reorderPercent": 0,
          "duplicatePercent": 0
        },
        {
          "atSec": 35,
          "rateKbit": 26000,
          "delayMs": 0,
          "jitterMs": 0,
          "reorderPercent": 0,
          "duplicatePercent": 0
        },
        {
          "atSec": 45,
          "rateKbit": 50000,
          "delayMs": 0,
          "jitterMs": 0,
          "reorderPercent": 0,
          "duplicatePercent": 0
        }
      ]
    },
    {
      "id": "N-3",
      "note": "遅延 100 ms、ジッタ 50 ms。ジッタバッファが吸収する",
      "steps": [
        {
          "atSec": 0,
          "rateKbit": 0,
          "delayMs": 100,
          "jitterMs": 50,
          "reorderPercent": 0,
          "duplicatePercent": 0
        }
      ]
    },
    {
      "id": "N-4",
      "note": "再順序 2%、重複 0.5%。順序復元が働く（TCP のため欠落はしない）",
      "steps": [
        {
          "atSec": 0,
          "rateKbit": 0,
          "delayMs": 10,
          "jitterMs": 0,
          "reorderPercent": 2,
          "duplicatePercent": 0.5
        }
      ]
    },
    {
      "id": "N-5",
      "note": "20 秒ごとに 500 ms の完全遮断。予備接続への切替が働く",
      "steps": [
        {
          "atSec": 0,
          "rateKbit": 0,
          "delayMs": 0,
          "jitterMs": 0,
          "reorderPercent": 0,
          "duplicatePercent": 0
        }
      ],
      "outage": {
        "everySec": 20,
        "durationMs": 500
      }
    },
    {
      "id": "N-6",
      "note": "60 秒かけて 50 Mbps から 1 Mbps へ連続降下。遅延勾配による段階的な劣化が働く",
      "steps": [
        {
          "atSec": 0,
          "rateKbit": 50000,
          "delayMs": 0,
          "jitterMs": 0,
          "reorderPercent": 0,
          "duplicatePercent": 0
        },
        {
          "atSec": 10,
          "rateKbit": 33000,
          "delayMs": 0,
          "jitterMs": 0,
          "reorderPercent": 0,
          "duplicatePercent": 0
        },
        {
          "atSec": 20,
          "rateKbit": 20000,
          "delayMs": 0,
          "jitterMs": 0,
          "reorderPercent": 0,
          "duplicatePercent": 0
        },
        {
          "atSec": 30,
          "rateKbit": 12000,
          "delayMs": 0,
          "jitterMs": 0,
          "reorderPercent": 0,
          "duplicatePercent": 0
        },
        {
          "atSec": 40,
          "rateKbit": 6000,
          "delayMs": 0,
          "jitterMs": 0,
          "reorderPercent": 0,
          "duplicatePercent": 0
        },
        {
          "atSec": 50,
          "rateKbit": 1000,
          "delayMs": 0,
          "jitterMs": 0,
          "reorderPercent": 0,
          "duplicatePercent": 0
        }
      ]
    },
    {
      "id": "N-7",
      "note": "上り 2 Mbps に制限（送信側のみ劣化）。送信側のエンコーダ調整が働く",
      "steps": [
        {
          "atSec": 0,
          "rateKbit": 2000,
          "delayMs": 0,
          "jitterMs": 0,
          "reorderPercent": 0,
          "duplicatePercent": 0
        }
      ],
      "egressOnly": true
    }
  ];

export const IMPAIRMENT_BURST_KBIT = 32;
export const IMPAIRMENT_BURST_DIVISOR = 250;
export const IMPAIRMENT_LATENCY_MS = 50;
export const IMPAIRMENT_DEVICE_MTU = 1500;

/** 受入条件 4.3 の連続性の閾値。 */
export const IMPAIRMENT_MAX_GAP_MS = 1000;
export const IMPAIRMENT_MAX_GAP_WITH_OUTAGE_MS = 1500;

/** 劣化が実際に効いていることを確かめるための判定値。 */
export const IMPAIRMENT_PROBE_RATE_KBIT = 1000;
export const IMPAIRMENT_PROBE_BYTES = 262144;
export const IMPAIRMENT_MIN_SECONDS_AT_PROBE_RATE = 1.5;
export const IMPAIRMENT_PROBE_DELAY_MS = 100;
export const IMPAIRMENT_MIN_DELAY_INCREASE_MS = 150;
