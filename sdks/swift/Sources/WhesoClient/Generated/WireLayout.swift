// このファイルは自動生成されている。手で編集してはならない。
//
// 生成元: プロトコルのスキーマ定義
// 再生成: 内部検証スクリプトを実行する

public enum WhesoWireLayout {
    public static let PROTOCOL_VERSION: UInt8 = 1
    public static let WIRE_MAGIC: UInt8 = 161
    public static let MESSAGE_HEADER_BYTES: Int = 8
    public static let UNIT_HEADER_BYTES: Int = 20
    public static let MAX_UNITS_PER_MESSAGE: Int = 255
    public static let MAX_MESSAGE_BYTES: Int = 16000000

    public static let CHANNEL_VIDEO: UInt8 = 1
    public static let CHANNEL_AUDIO: UInt8 = 2
    public static let CHANNEL_SCREEN_VIDEO: UInt8 = 3
    public static let CHANNEL_SCREEN_AUDIO: UInt8 = 4

    public static let FLAG_KEY: UInt8 = 1
    public static let FLAG_DISCARDABLE: UInt8 = 2
    public static let FLAG_DTX: UInt8 = 4
    public static let FLAG_END_OF_FRAME: UInt8 = 8
    public static let FLAG_SCREEN_CONTENT: UInt8 = 16
    public static let FLAG_ACTIVE_SPEAKER: UInt8 = 32
}
