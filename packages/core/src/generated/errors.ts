/**
 * このファイルは自動生成されている。手で編集してはならない。
 *
 * 生成元: プロトコルのスキーマ定義
 * 再生成: 内部検証スクリプトを実行する
 */

export interface ErrorDefinition {
  readonly closeCode: number;
  readonly recoverable: boolean;
  readonly autoReconnect: boolean;
  readonly i18nKey: string;
}

export const ERROR_DEFINITIONS = {
  E_WIRE_MAGIC: { closeCode: 4001, recoverable: false, autoReconnect: false, i18nKey: "error.wire.magic" },
  E_WIRE_VERSION: { closeCode: 4002, recoverable: false, autoReconnect: false, i18nKey: "error.wire.version" },
  E_WIRE_LENGTH_MISMATCH: { closeCode: 4003, recoverable: false, autoReconnect: false, i18nKey: "error.wire.length" },
  E_WIRE_UNIT_COUNT: { closeCode: 4004, recoverable: false, autoReconnect: false, i18nKey: "error.wire.unitCount" },
  E_WIRE_SENDER_ID: { closeCode: 4005, recoverable: false, autoReconnect: false, i18nKey: "error.wire.senderId" },
  E_WIRE_PAYLOAD_EMPTY: { closeCode: 4006, recoverable: false, autoReconnect: false, i18nKey: "error.wire.payloadEmpty" },
  E_WIRE_UNIT_ORDER: { closeCode: 4007, recoverable: false, autoReconnect: false, i18nKey: "error.wire.unitOrder" },
  E_WIRE_TOO_LARGE: { closeCode: 4008, recoverable: true, autoReconnect: true, i18nKey: "error.wire.tooLarge" },
  E_WIRE_CHANNEL: { closeCode: 4003, recoverable: false, autoReconnect: false, i18nKey: "error.wire.channel" },
  E_WIRE_FIELD_RANGE: { closeCode: 4003, recoverable: false, autoReconnect: false, i18nKey: "error.wire.fieldRange" },
  E_CTRL_VERSION: { closeCode: 4010, recoverable: false, autoReconnect: false, i18nKey: "error.ctrl.version" },
  E_CTRL_NO_HELLO: { closeCode: 4011, recoverable: false, autoReconnect: false, i18nKey: "error.ctrl.noHello" },
  E_CTRL_DUPLICATE_HELLO: { closeCode: 4012, recoverable: false, autoReconnect: false, i18nKey: "error.ctrl.duplicateHello" },
  E_CTRL_SCHEMA: { closeCode: 4013, recoverable: false, autoReconnect: false, i18nKey: "error.ctrl.schema" },
  E_AUTH: { closeCode: 4020, recoverable: false, autoReconnect: false, i18nKey: "error.auth.invalid" },
  E_AUTH_EXPIRED: { closeCode: 4021, recoverable: true, autoReconnect: true, i18nKey: "error.auth.expired" },
  E_AUTH_AUDIENCE: { closeCode: 4022, recoverable: false, autoReconnect: false, i18nKey: "error.auth.audience" },
  E_NODE_AUTH: { closeCode: 4023, recoverable: true, autoReconnect: true, i18nKey: "error.auth.node" },
  E_FORBIDDEN: { closeCode: 4024, recoverable: false, autoReconnect: false, i18nKey: "error.auth.forbidden" },
  E_AUTH_ROOM: { closeCode: 4022, recoverable: false, autoReconnect: false, i18nKey: "error.auth.room" },
  E_AUTH_KIND: { closeCode: 4020, recoverable: false, autoReconnect: false, i18nKey: "error.auth.kind" },
  E_RATE_LIMIT_MESSAGES: { closeCode: 4030, recoverable: true, autoReconnect: true, i18nKey: "error.rate.messages" },
  E_RATE_LIMIT_CONNECT: { closeCode: 4031, recoverable: true, autoReconnect: true, i18nKey: "error.rate.connect" },
  E_NODE_OVERLOADED: { closeCode: 4032, recoverable: true, autoReconnect: true, i18nKey: "error.node.overloaded" },
  E_ROOM_FULL: { closeCode: 4033, recoverable: false, autoReconnect: false, i18nKey: "error.room.full" },
  E_ACK_TIMEOUT: { closeCode: 4034, recoverable: true, autoReconnect: true, i18nKey: "error.node.ackTimeout" },
  E_EPOCH_STALE: { closeCode: 4040, recoverable: true, autoReconnect: true, i18nKey: "error.epoch.stale" },
  E_MEETING_ENDED: { closeCode: 4041, recoverable: false, autoReconnect: false, i18nKey: "error.meeting.ended" },
  E_EVICTED: { closeCode: 4042, recoverable: false, autoReconnect: false, i18nKey: "error.meeting.evicted" },
  E_MEETING_LOCKED: { closeCode: 4043, recoverable: false, autoReconnect: false, i18nKey: "error.meeting.locked" },
  E_NAME_MEETING_ID: { closeCode: 4050, recoverable: false, autoReconnect: false, i18nKey: "error.name.meetingId" },
  E_NAME_USER_ID: { closeCode: 4051, recoverable: false, autoReconnect: false, i18nKey: "error.name.userId" },
  E_NAME_REGION: { closeCode: 4052, recoverable: false, autoReconnect: false, i18nKey: "error.name.region" },
  E_NAME_EPOCH: { closeCode: 4053, recoverable: false, autoReconnect: false, i18nKey: "error.name.epoch" },
  E_NAME_SHARD_INDEX: { closeCode: 4054, recoverable: false, autoReconnect: false, i18nKey: "error.name.shardIndex" },
  E_NAME_SHARD_COUNT: { closeCode: 4055, recoverable: false, autoReconnect: false, i18nKey: "error.name.shardCount" },
  E_NAME_TOO_LONG: { closeCode: 4056, recoverable: false, autoReconnect: false, i18nKey: "error.name.tooLong" },
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorName = keyof typeof ERROR_DEFINITIONS;

export interface WarningDefinition {
  readonly i18nKey: string;
  readonly notifyUser: boolean;
}

export const WARNING_DEFINITIONS = {
  W_DECODE_FAILED: { i18nKey: "warn.decodeFailed", notifyUser: false },
  W_ENCODER_UNSUPPORTED: { i18nKey: "warn.encoderUnsupported", notifyUser: false },
  W_NO_HARDWARE_ENCODER: { i18nKey: "warn.noHardwareEncoder", notifyUser: false },
  W_DEGRADED: { i18nKey: "warn.degraded", notifyUser: true },
  W_STANDBY_SWAP: { i18nKey: "warn.standbySwap", notifyUser: false },
  W_UNEXPECTED_EVENT: { i18nKey: "warn.unexpectedEvent", notifyUser: false },
} as const satisfies Record<string, WarningDefinition>;

export type WarningName = keyof typeof WARNING_DEFINITIONS;

/** 自動再接続を行ってよいエラーかを返す。resources を守るため既定は false である。 */
export function mayAutoReconnect(name: ErrorName): boolean {
  return ERROR_DEFINITIONS[name].autoReconnect;
}
