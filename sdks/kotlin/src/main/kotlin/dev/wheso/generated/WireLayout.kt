// このファイルは自動生成されている。手で編集してはならない。
//
// 生成元: プロトコルのスキーマ定義
// 再生成: 内部検証スクリプトを実行する
package dev.wheso.generated

public const val PROTOCOL_VERSION: Int = 1
public const val WIRE_MAGIC: Int = 161
public const val MESSAGE_HEADER_BYTES: Int = 8
public const val UNIT_HEADER_BYTES: Int = 20
public const val MAX_UNITS_PER_MESSAGE: Int = 255
public const val MAX_MESSAGE_BYTES: Int = 16000000
public const val MAX_SPATIAL_ID: Int = 3
public const val MAX_TEMPORAL_ID: Int = 7

public const val CHANNEL_VIDEO: Int = 1
public const val CHANNEL_AUDIO: Int = 2
public const val CHANNEL_SCREEN_VIDEO: Int = 3
public const val CHANNEL_SCREEN_AUDIO: Int = 4

public const val FLAG_KEY: Int = 1
public const val FLAG_DISCARDABLE: Int = 2
public const val FLAG_DTX: Int = 4
public const val FLAG_END_OF_FRAME: Int = 8
public const val FLAG_SCREEN_CONTENT: Int = 16
public const val FLAG_ACTIVE_SPEAKER: Int = 32
