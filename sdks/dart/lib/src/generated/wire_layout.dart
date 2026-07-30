// このファイルは自動生成されている。手で編集してはならない。
//
// 生成元: プロトコルのスキーマ定義
// 再生成: 内部検証スクリプトを実行する

const int PROTOCOL_VERSION = 1;
const int WIRE_MAGIC = 161;
const int MESSAGE_HEADER_BYTES = 8;
const int UNIT_HEADER_BYTES = 20;
const int MAX_UNITS_PER_MESSAGE = 255;
const int MAX_MESSAGE_BYTES = 16000000;
const int MAX_SPATIAL_ID = 3;
const int MAX_TEMPORAL_ID = 7;

const int CHANNEL_VIDEO = 1;
const int CHANNEL_AUDIO = 2;
const int CHANNEL_SCREEN_VIDEO = 3;
const int CHANNEL_SCREEN_AUDIO = 4;

const int FLAG_KEY = 1;
const int FLAG_DISCARDABLE = 2;
const int FLAG_DTX = 4;
const int FLAG_END_OF_FRAME = 8;
const int FLAG_SCREEN_CONTENT = 16;
const int FLAG_ACTIVE_SPEAKER = 32;
