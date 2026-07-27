/**
 * コード生成。
 *
 * spec/schema/*.json から各言語の定義を生成する。
 * 6 言語で手書きすると必ず乖離するため、単一定義から生成する（spec/lint-policy.md 9 節）。
 *
 * 実行:
 *   node tools/codegen.ts generate  ... 生成物を書き出す
 *   node tools/codegen.ts check     ... 再生成して差分が無いことを確認する
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = join(root, "spec", "schema");
const tsOutDir = join(root, "packages", "core", "src", "generated");
const rustOutDir = join(root, "sdks", "rust", "src", "generated");
const cppOutDir = join(root, "sdks", "cpp", "include", "wheso", "generated");
const dartOutDir = join(root, "sdks", "dart", "lib", "src", "generated");
const kotlinOutDir = join(root, "sdks", "kotlin", "src", "main", "kotlin", "dev", "wheso", "generated");
const swiftOutDir = join(root, "sdks", "swift", "Sources", "WhesoClient", "Generated");

const BANNER = `/**
 * このファイルは自動生成されている。手で編集してはならない。
 *
 * 生成元: プロトコルのスキーマ定義
 * 再生成: 内部検証スクリプトを実行する
 */
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSchema(name: string): Promise<Record<string, unknown>> {
  const text = await readFile(join(schemaDir, name), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error(`${name} is not an object`);
  }
  return parsed;
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`missing number: ${key}`);
  }
  return value;
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string") {
    throw new Error(`missing string: ${key}`);
  }
  return value;
}

function readArray(source: Record<string, unknown>, key: string): readonly unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    throw new Error(`missing array: ${key}`);
  }
  return value;
}

function readObject(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  if (!isRecord(value)) {
    throw new Error(`missing object: ${key}`);
  }
  return value;
}

/* ------------------------------------------------------------------------- */
/* ワイヤ定義の生成                                                          */
/* ------------------------------------------------------------------------- */

function generateWireTs(schema: Record<string, unknown>): string {
  const lines: string[] = [BANNER];
  lines.push(`export const PROTOCOL_VERSION = ${readNumber(schema, "protocolVersion")};`);
  lines.push(`export const WIRE_MAGIC = ${readNumber(schema, "magic")};`);

  const messageHeader = readObject(schema, "messageHeader");
  const unitHeader = readObject(schema, "unitHeader");
  lines.push(`export const MESSAGE_HEADER_BYTES = ${readNumber(messageHeader, "bytes")};`);
  lines.push(`export const UNIT_HEADER_BYTES = ${readNumber(unitHeader, "bytes")};`);

  const limits = readObject(schema, "limits");
  lines.push(`export const MAX_UNITS_PER_MESSAGE = ${readNumber(limits, "maxUnitsPerMessage")};`);
  lines.push(`export const MAX_MESSAGE_BYTES = ${readNumber(limits, "maxMessageBytes")};`);
  lines.push(
    `export const DOCUMENTED_RECEIVE_LIMIT_BYTES = ${readNumber(limits, "documentedReceiveLimitBytes")};`,
  );
  lines.push("");

  lines.push("/** メッセージヘッダのフィールド位置。 */");
  lines.push("export const MESSAGE_HEADER_OFFSET = {");
  for (const field of readArray(messageHeader, "fields")) {
    if (!isRecord(field)) {
      continue;
    }
    lines.push(`  ${readString(field, "name")}: ${readNumber(field, "offset")},`);
  }
  lines.push("} as const;");
  lines.push("");

  lines.push("/** ユニットヘッダのフィールド位置。 */");
  lines.push("export const UNIT_HEADER_OFFSET = {");
  for (const field of readArray(unitHeader, "fields")) {
    if (!isRecord(field)) {
      continue;
    }
    lines.push(`  ${readString(field, "name")}: ${readNumber(field, "offset")},`);
  }
  lines.push("} as const;");
  lines.push("");

  const enums = readObject(schema, "enums");
  for (const [enumName, entries] of Object.entries(enums)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    lines.push(`/** ${enumName} */`);
    for (const entry of entries) {
      if (!isRecord(entry)) {
        continue;
      }
      const description = typeof entry["description"] === "string" ? ` // ${entry["description"]}` : "";
      lines.push(
        `export const ${enumName.toUpperCase()}_${readString(entry, "name")} = ${readNumber(entry, "value")};${description}`,
      );
    }
    lines.push("");
  }

  const bitsets = readObject(schema, "bitsets");
  for (const [bitsetName, entries] of Object.entries(bitsets)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    lines.push(`/** ${bitsetName} のビット定義。 */`);
    for (const entry of entries) {
      if (!isRecord(entry)) {
        continue;
      }
      const bit = readNumber(entry, "bit");
      const description = typeof entry["description"] === "string" ? ` // ${entry["description"]}` : "";
      lines.push(`export const FLAG_${readString(entry, "name")} = ${1 << bit};${description}`);
    }
    lines.push("");
  }

  lines.push(
    `export const VIDEO_CHANNEL_REQUIRES_SINGLE_UNIT = ${schema["videoChannelRequiresSingleUnit"] === true};`,
  );
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------------- */
/* エラー定義の生成                                                          */
/* ------------------------------------------------------------------------- */

function generateErrorsTs(schema: Record<string, unknown>): string {
  const lines: string[] = [BANNER];
  const codes = readArray(schema, "closeCodes");
  const names: string[] = [];
  lines.push("export interface ErrorDefinition {");
  lines.push("  readonly closeCode: number;");
  lines.push("  readonly recoverable: boolean;");
  lines.push("  readonly autoReconnect: boolean;");
  lines.push("  readonly i18nKey: string;");
  lines.push("}");
  lines.push("");
  lines.push("export const ERROR_DEFINITIONS = {");
  for (const entry of codes) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = readString(entry, "name");
    names.push(name);
    lines.push(
      `  ${name}: { closeCode: ${readNumber(entry, "closeCode")}, recoverable: ${entry["recoverable"] === true}, autoReconnect: ${entry["autoReconnect"] === true}, i18nKey: "${readString(entry, "i18nKey")}" },`,
    );
  }
  lines.push("} as const satisfies Record<string, ErrorDefinition>;");
  lines.push("");
  lines.push("export type ErrorName = keyof typeof ERROR_DEFINITIONS;");
  lines.push("");

  const warnings = readArray(schema, "warnings");
  lines.push("export interface WarningDefinition {");
  lines.push("  readonly i18nKey: string;");
  lines.push("  readonly notifyUser: boolean;");
  lines.push("}");
  lines.push("");
  lines.push("export const WARNING_DEFINITIONS = {");
  for (const entry of warnings) {
    if (!isRecord(entry)) {
      continue;
    }
    lines.push(
      `  ${readString(entry, "name")}: { i18nKey: "${readString(entry, "i18nKey")}", notifyUser: ${entry["notifyUser"] === true} },`,
    );
  }
  lines.push("} as const satisfies Record<string, WarningDefinition>;");
  lines.push("");
  lines.push("export type WarningName = keyof typeof WARNING_DEFINITIONS;");
  lines.push("");
  lines.push("/** 自動再接続を行ってよいエラーかを返す。resources を守るため既定は false である。 */");
  lines.push("export function mayAutoReconnect(name: ErrorName): boolean {");
  lines.push("  return ERROR_DEFINITIONS[name].autoReconnect;");
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------------- */
/* エラー定義の生成（TypeScript 以外）                                       */
/* ------------------------------------------------------------------------- */

/**
 * エラーとクローズコードを他言語へ生成する。
 *
 * なぜ必要か: クローズコードを各言語のコードに書き写した実装があった（Rust と Dart の
 * 判断コアが 4032 を直書きしていた）。数値は単一情報源から生成する（AGENTS 5.3）。
 */
function errorEntries(schema: Record<string, unknown>): readonly { readonly name: string; readonly closeCode: number }[] {
  const out: { readonly name: string; readonly closeCode: number }[] = [];
  for (const entry of readArray(schema, "closeCodes")) {
    if (!isRecord(entry)) {
      continue;
    }
    out.push({ name: readString(entry, "name"), closeCode: readNumber(entry, "closeCode") });
  }
  return out;
}

function warningNames(schema: Record<string, unknown>): readonly string[] {
  const out: string[] = [];
  for (const entry of readArray(schema, "warnings")) {
    if (!isRecord(entry)) {
      continue;
    }
    out.push(readString(entry, "name"));
  }
  return out;
}

/** Rust の生成物集約。手編集を避けるためこれも生成する。 */
function generateModRs(): string {
  return [
    "//! 生成物の集約。手で編集してはならない。",
    "pub mod constants;",
    "pub mod errors;",
    "pub mod wire_layout;",
    "",
  ].join("\n");
}

function generateErrorsRs(schema: Record<string, unknown>): string {
  const lines: string[] = [BANNER.split("\n").map((line) => line.replace(/^\/\*\*?|^ \*\/?| \*$/g, "//")).join("\n")];
  lines.length = 0;
  lines.push("//! このファイルは自動生成されている。手で編集してはならない。");
  lines.push("//!");
  lines.push("//! 生成元: エラーの機械可読定義");
  lines.push("");
  lines.push("/// クローズコード。名前は規範のエラー名と一致する。");
  for (const entry of errorEntries(schema)) {
    lines.push(`pub const ${entry.name}_CLOSE_CODE: i64 = ${entry.closeCode};`);
  }
  lines.push("");
  lines.push("/// 警告の名前。利用側が国際化キーへ写す。");
  for (const name of warningNames(schema)) {
    lines.push(`pub const ${name}: &str = "${name}";`);
  }
  return `${lines.join("\n")}\n`;
}

function generateErrorsHpp(schema: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("// このファイルは自動生成されている。手で編集してはならない。");
  lines.push("//");
  lines.push("// 生成元: エラーの機械可読定義");
  lines.push("#pragma once");
  lines.push("");
  lines.push("#include <cstdint>");
  lines.push("");
  lines.push("namespace wheso::errors {");
  for (const entry of errorEntries(schema)) {
    lines.push(`inline constexpr std::int64_t ${entry.name}_CLOSE_CODE = ${entry.closeCode};`);
  }
  lines.push("");
  for (const name of warningNames(schema)) {
    lines.push(`inline constexpr const char* ${name} = "${name}";`);
  }
  lines.push("}  // namespace wheso::errors");
  return `${lines.join("\n")}\n`;
}

function generateErrorsDart(schema: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("// このファイルは自動生成されている。手で編集してはならない。");
  lines.push("//");
  lines.push("// 生成元: エラーの機械可読定義");
  lines.push("// ignore_for_file: constant_identifier_names");
  lines.push("");
  for (const entry of errorEntries(schema)) {
    lines.push(`const int ${entry.name}_CLOSE_CODE = ${entry.closeCode};`);
  }
  lines.push("");
  for (const name of warningNames(schema)) {
    lines.push(`const String ${name} = '${name}';`);
  }
  return `${lines.join("\n")}\n`;
}

function generateErrorsKt(schema: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("// このファイルは自動生成されている。手で編集してはならない。");
  lines.push("//");
  lines.push("// 生成元: エラーの機械可読定義");
  lines.push("package dev.wheso.generated");
  lines.push("");
  lines.push("public object Errors {");
  for (const entry of errorEntries(schema)) {
    lines.push(`    public const val ${entry.name}_CLOSE_CODE: Long = ${entry.closeCode}L`);
  }
  lines.push("");
  for (const name of warningNames(schema)) {
    lines.push(`    public const val ${name}: String = "${name}"`);
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function generateErrorsSwift(schema: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("// このファイルは自動生成されている。手で編集してはならない。");
  lines.push("//");
  lines.push("// 生成元: エラーの機械可読定義");
  lines.push("");
  lines.push("public enum WhesoErrors {");
  for (const entry of errorEntries(schema)) {
    lines.push(`    public static let ${entry.name}_CLOSE_CODE: Int64 = ${entry.closeCode}`);
  }
  lines.push("");
  for (const name of warningNames(schema)) {
    lines.push(`    public static let ${name}: String = "${name}"`);
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------------- */
/* 定数定義の生成                                                            */
/* ------------------------------------------------------------------------- */

function formatConstantValue(value: unknown): string | null {
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const formatted = formatConstantValue(item);
      if (formatted === null) {
        return null;
      }
      parts.push(formatted);
    }
    return `[${parts.join(", ")}]`;
  }
  return null;
}

function generateConstantsTs(schema: Record<string, unknown>): string {
  const lines: string[] = [BANNER];
  for (const [groupName, group] of Object.entries(schema)) {
    if (groupName.startsWith("$") || !isRecord(group)) {
      continue;
    }
    lines.push(`/* ${groupName} */`);
    for (const [constantName, definition] of Object.entries(group)) {
      if (constantName.startsWith("$")) {
        continue;
      }
      if (!isRecord(definition)) {
        continue;
      }
      const hasValue = "value" in definition;
      if (hasValue) {
        const formatted = formatConstantValue(definition["value"]);
        if (formatted === null) {
          continue;
        }
        const notes: string[] = [];
        const derivation = definition["derivation"];
        if (typeof derivation === "string") {
          notes.push(derivation);
        }
        const fact = definition["fact"];
        if (typeof fact === "string") {
          notes.push(`根拠 ${fact}`);
        }
        const question = definition["question"];
        if (typeof question === "string") {
          notes.push(`未検証 ${question}`);
        }
        const adr = definition["adr"];
        if (typeof adr === "string") {
          notes.push(adr);
        }
        if (notes.length > 0) {
          lines.push(`/** ${notes.join("。")} */`);
        }
        lines.push(`export const ${constantName} = ${formatted}${Array.isArray(definition["value"]) ? " as const" : ""};`);
        continue;
      }
      // プロファイルなどの複合定義はオブジェクトとして出力する
      const entries: string[] = [];
      for (const [key, raw] of Object.entries(definition)) {
        if (key.startsWith("$") || key === "derivation" || key === "fact" || key === "question" || key === "adr") {
          continue;
        }
        const formatted = formatConstantValue(raw);
        if (formatted !== null) {
          entries.push(`  ${key}: ${formatted},`);
        }
      }
      lines.push(`export const ${constantName} = {`);
      lines.push(...entries);
      lines.push("} as const;");
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}


/* ------------------------------------------------------------------------- */
/* Rust 向けの生成                                                           */
/* ------------------------------------------------------------------------- */

const RUST_BANNER = `//! このファイルは自動生成されている。手で編集してはならない。
//!
//! 生成元: プロトコルのスキーマ定義
//! 再生成: 内部検証スクリプトを実行する
#![allow(dead_code)]
`;

/** Rust の値表現。整数は i64、小数は f64、真偽は bool、文字列は &str とする。 */
function formatRustValue(value: unknown): { readonly type: string; readonly literal: string } | null {
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { type: "i64", literal: String(value) }
      : { type: "f64", literal: String(value) };
  }
  if (typeof value === "boolean") {
    return { type: "bool", literal: String(value) };
  }
  if (typeof value === "string") {
    return { type: "&str", literal: JSON.stringify(value) };
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const formatted = formatRustValue(item);
      if (formatted === null || formatted.type !== "i64") {
        return null;
      }
      parts.push(formatted.literal);
    }
    return { type: `[i64; ${parts.length}]`, literal: `[${parts.join(", ")}]` };
  }
  return null;
}

function generateConstantsRs(schema: Record<string, unknown>): string {
  const lines: string[] = [RUST_BANNER];
  for (const [groupName, group] of Object.entries(schema)) {
    if (groupName.startsWith("$") || !isRecord(group)) {
      continue;
    }
    lines.push(`// ${groupName}`);
    for (const [constantName, definition] of Object.entries(group)) {
      if (constantName.startsWith("$") || !isRecord(definition)) {
        continue;
      }
      if (!("value" in definition)) {
        for (const [key, raw] of Object.entries(definition)) {
          if (key.startsWith("$") || key === "derivation" || key === "fact" || key === "question" || key === "adr") {
            continue;
          }
          const formatted = formatRustValue(raw);
          if (formatted === null) {
            continue;
          }
          const suffix = key.replace(/([A-Z])/g, "_$1").toUpperCase();
          lines.push(`pub const ${constantName}_${suffix}: ${formatted.type} = ${formatted.literal};`);
        }
        continue;
      }
      const formatted = formatRustValue(definition["value"]);
      if (formatted === null) {
        continue;
      }
      lines.push(`pub const ${constantName}: ${formatted.type} = ${formatted.literal};`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function generateWireRs(schema: Record<string, unknown>): string {
  const lines: string[] = [RUST_BANNER];
  const messageHeader = readObject(schema, "messageHeader");
  const unitHeader = readObject(schema, "unitHeader");
  const limits = readObject(schema, "limits");
  lines.push(`pub const PROTOCOL_VERSION: u8 = ${readNumber(schema, "protocolVersion")};`);
  lines.push(`pub const WIRE_MAGIC: u8 = ${readNumber(schema, "magic")};`);
  lines.push(`pub const MESSAGE_HEADER_BYTES: usize = ${readNumber(messageHeader, "bytes")};`);
  lines.push(`pub const UNIT_HEADER_BYTES: usize = ${readNumber(unitHeader, "bytes")};`);
  lines.push(`pub const MAX_UNITS_PER_MESSAGE: u32 = ${readNumber(limits, "maxUnitsPerMessage")};`);
  lines.push(`pub const MAX_MESSAGE_BYTES: usize = ${readNumber(limits, "maxMessageBytes")};`);
  lines.push("");
  for (const entries of Object.values(readObject(schema, "enums"))) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (isRecord(entry)) {
        lines.push(`pub const CHANNEL_${readString(entry, "name")}: u8 = ${readNumber(entry, "value")};`);
      }
    }
  }
  lines.push("");
  for (const entries of Object.values(readObject(schema, "bitsets"))) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (isRecord(entry)) {
        lines.push(`pub const FLAG_${readString(entry, "name")}: u8 = ${1 << readNumber(entry, "bit")};`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}


/* ------------------------------------------------------------------------- */
/* C++ 向けの生成                                                            */
/* ------------------------------------------------------------------------- */

const CPP_BANNER = `// このファイルは自動生成されている。手で編集してはならない。
//
// 生成元: プロトコルのスキーマ定義
// 再生成: 内部検証スクリプトを実行する
#pragma once
#include <cstdint>
#include <string_view>
`;

/** C++ の値表現。整数は int64_t、小数は double、真偽は bool、文字列は string_view。 */
function formatCppValue(value: unknown): { readonly type: string; readonly literal: string } | null {
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { type: "std::int64_t", literal: `${value}` }
      : { type: "double", literal: String(value) };
  }
  if (typeof value === "boolean") {
    return { type: "bool", literal: String(value) };
  }
  if (typeof value === "string") {
    return { type: "std::string_view", literal: JSON.stringify(value) };
  }
  return null;
}

function generateConstantsHpp(schema: Record<string, unknown>): string {
  const lines: string[] = [CPP_BANNER, "namespace wheso::constants {", ""];
  for (const [groupName, group] of Object.entries(schema)) {
    if (groupName.startsWith("$") || !isRecord(group)) {
      continue;
    }
    lines.push(`// ${groupName}`);
    for (const [constantName, definition] of Object.entries(group)) {
      if (constantName.startsWith("$") || !isRecord(definition)) {
        continue;
      }
      if (!("value" in definition)) {
        for (const [key, raw] of Object.entries(definition)) {
          if (key.startsWith("$") || key === "derivation" || key === "fact" || key === "question" || key === "adr") {
            continue;
          }
          const formatted = formatCppValue(raw);
          if (formatted === null) {
            continue;
          }
          const suffix = key.replace(/([A-Z])/g, "_$1").toUpperCase();
          lines.push(`inline constexpr ${formatted.type} ${constantName}_${suffix} = ${formatted.literal};`);
        }
        continue;
      }
      const formatted = formatCppValue(definition["value"]);
      if (formatted === null) {
        continue;
      }
      lines.push(`inline constexpr ${formatted.type} ${constantName} = ${formatted.literal};`);
    }
    lines.push("");
  }
  lines.push("}  // namespace wheso::constants");
  return `${lines.join("\n")}\n`;
}

function generateWireHpp(schema: Record<string, unknown>): string {
  const messageHeader = readObject(schema, "messageHeader");
  const unitHeader = readObject(schema, "unitHeader");
  const limits = readObject(schema, "limits");
  const lines: string[] = [CPP_BANNER, "namespace wheso::wire_layout {", ""];
  lines.push(`inline constexpr std::uint8_t PROTOCOL_VERSION = ${readNumber(schema, "protocolVersion")};`);
  lines.push(`inline constexpr std::uint8_t WIRE_MAGIC = ${readNumber(schema, "magic")};`);
  lines.push(`inline constexpr std::size_t MESSAGE_HEADER_BYTES = ${readNumber(messageHeader, "bytes")};`);
  lines.push(`inline constexpr std::size_t UNIT_HEADER_BYTES = ${readNumber(unitHeader, "bytes")};`);
  lines.push(`inline constexpr std::size_t MAX_UNITS_PER_MESSAGE = ${readNumber(limits, "maxUnitsPerMessage")};`);
  lines.push(`inline constexpr std::size_t MAX_MESSAGE_BYTES = ${readNumber(limits, "maxMessageBytes")};`);
  lines.push("");
  for (const entries of Object.values(readObject(schema, "enums"))) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (isRecord(entry)) {
        lines.push(
          `inline constexpr std::uint8_t CHANNEL_${readString(entry, "name")} = ${readNumber(entry, "value")};`,
        );
      }
    }
  }
  lines.push("");
  for (const entries of Object.values(readObject(schema, "bitsets"))) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (isRecord(entry)) {
        lines.push(
          `inline constexpr std::uint8_t FLAG_${readString(entry, "name")} = ${1 << readNumber(entry, "bit")};`,
        );
      }
    }
  }
  lines.push("");
  lines.push("}  // namespace wheso::wire_layout");
  return `${lines.join("\n")}\n`;
}


/* ------------------------------------------------------------------------- */
/* Dart 向けの生成                                                           */
/* ------------------------------------------------------------------------- */

const DART_BANNER = `// このファイルは自動生成されている。手で編集してはならない。
//
// 生成元: プロトコルのスキーマ定義
// 再生成: 内部検証スクリプトを実行する
`;

/** Dart の値表現。整数は int、小数は double、真偽は bool、文字列は String とする。 */
function formatDartValue(value: unknown): { readonly type: string; readonly literal: string } | null {
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { type: "int", literal: `${value}` }
      : { type: "double", literal: String(value) };
  }
  if (typeof value === "boolean") {
    return { type: "bool", literal: String(value) };
  }
  if (typeof value === "string") {
    return { type: "String", literal: JSON.stringify(value) };
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const formatted = formatDartValue(item);
      if (formatted === null || formatted.type !== "int") {
        return null;
      }
      parts.push(formatted.literal);
    }
    return { type: "List<int>", literal: `[${parts.join(", ")}]` };
  }
  return null;
}

function generateConstantsDart(schema: Record<string, unknown>): string {
  const lines: string[] = [DART_BANNER];
  for (const [groupName, group] of Object.entries(schema)) {
    if (groupName.startsWith("$") || !isRecord(group)) {
      continue;
    }
    lines.push(`// ${groupName}`);
    for (const [constantName, definition] of Object.entries(group)) {
      if (constantName.startsWith("$") || !isRecord(definition)) {
        continue;
      }
      if (!("value" in definition)) {
        for (const [key, raw] of Object.entries(definition)) {
          if (key.startsWith("$") || key === "derivation" || key === "fact" || key === "question" || key === "adr") {
            continue;
          }
          const formatted = formatDartValue(raw);
          if (formatted === null) {
            continue;
          }
          const suffix = key.replace(/([A-Z])/g, "_$1").toUpperCase();
          lines.push(`const ${formatted.type} ${constantName}_${suffix} = ${formatted.literal};`);
        }
        continue;
      }
      const formatted = formatDartValue(definition["value"]);
      if (formatted === null) {
        continue;
      }
      lines.push(`const ${formatted.type} ${constantName} = ${formatted.literal};`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function generateWireDart(schema: Record<string, unknown>): string {
  const messageHeader = readObject(schema, "messageHeader");
  const unitHeader = readObject(schema, "unitHeader");
  const limits = readObject(schema, "limits");
  const lines: string[] = [DART_BANNER];
  lines.push(`const int PROTOCOL_VERSION = ${readNumber(schema, "protocolVersion")};`);
  lines.push(`const int WIRE_MAGIC = ${readNumber(schema, "magic")};`);
  lines.push(`const int MESSAGE_HEADER_BYTES = ${readNumber(messageHeader, "bytes")};`);
  lines.push(`const int UNIT_HEADER_BYTES = ${readNumber(unitHeader, "bytes")};`);
  lines.push(`const int MAX_UNITS_PER_MESSAGE = ${readNumber(limits, "maxUnitsPerMessage")};`);
  lines.push(`const int MAX_MESSAGE_BYTES = ${readNumber(limits, "maxMessageBytes")};`);
  lines.push("");
  for (const entries of Object.values(readObject(schema, "enums"))) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (isRecord(entry)) {
        lines.push(`const int CHANNEL_${readString(entry, "name")} = ${readNumber(entry, "value")};`);
      }
    }
  }
  lines.push("");
  for (const entries of Object.values(readObject(schema, "bitsets"))) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (isRecord(entry)) {
        lines.push(`const int FLAG_${readString(entry, "name")} = ${1 << readNumber(entry, "bit")};`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}


/* ------------------------------------------------------------------------- */
/* Kotlin 向けの生成                                                         */
/* ------------------------------------------------------------------------- */

const KOTLIN_BANNER = `// このファイルは自動生成されている。手で編集してはならない。
//
// 生成元: プロトコルのスキーマ定義
// 再生成: 内部検証スクリプトを実行する
package dev.wheso.generated
`;

/** Kotlin の値表現。整数は Long、小数は Double、真偽は Boolean、文字列は String とする。 */
function formatKotlinValue(value: unknown): { readonly type: string; readonly literal: string } | null {
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { type: "Long", literal: `${value}L` }
      : { type: "Double", literal: String(value) };
  }
  if (typeof value === "boolean") {
    return { type: "Boolean", literal: String(value) };
  }
  if (typeof value === "string") {
    return { type: "String", literal: JSON.stringify(value) };
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const formatted = formatKotlinValue(item);
      if (formatted === null || formatted.type !== "Long") {
        return null;
      }
      parts.push(formatted.literal);
    }
    return { type: "List<Long>", literal: `listOf(${parts.join(", ")})` };
  }
  return null;
}

function generateConstantsKt(schema: Record<string, unknown>): string {
  const lines: string[] = [KOTLIN_BANNER];
  for (const [groupName, group] of Object.entries(schema)) {
    if (groupName.startsWith("$") || !isRecord(group)) {
      continue;
    }
    lines.push(`// ${groupName}`);
    for (const [constantName, definition] of Object.entries(group)) {
      if (constantName.startsWith("$") || !isRecord(definition)) {
        continue;
      }
      if (!("value" in definition)) {
        for (const [key, raw] of Object.entries(definition)) {
          if (key.startsWith("$") || key === "derivation" || key === "fact" || key === "question" || key === "adr") {
            continue;
          }
          const formatted = formatKotlinValue(raw);
          if (formatted === null) {
            continue;
          }
          const suffix = key.replace(/([A-Z])/g, "_$1").toUpperCase();
          lines.push(`public val ${constantName}_${suffix}: ${formatted.type} = ${formatted.literal}`);
        }
        continue;
      }
      const formatted = formatKotlinValue(definition["value"]);
      if (formatted === null) {
        continue;
      }
      lines.push(`public val ${constantName}: ${formatted.type} = ${formatted.literal}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function generateWireKt(schema: Record<string, unknown>): string {
  const messageHeader = readObject(schema, "messageHeader");
  const unitHeader = readObject(schema, "unitHeader");
  const limits = readObject(schema, "limits");
  const lines: string[] = [KOTLIN_BANNER];
  lines.push(`public const val PROTOCOL_VERSION: Int = ${readNumber(schema, "protocolVersion")}`);
  lines.push(`public const val WIRE_MAGIC: Int = ${readNumber(schema, "magic")}`);
  lines.push(`public const val MESSAGE_HEADER_BYTES: Int = ${readNumber(messageHeader, "bytes")}`);
  lines.push(`public const val UNIT_HEADER_BYTES: Int = ${readNumber(unitHeader, "bytes")}`);
  lines.push(`public const val MAX_UNITS_PER_MESSAGE: Int = ${readNumber(limits, "maxUnitsPerMessage")}`);
  lines.push(`public const val MAX_MESSAGE_BYTES: Int = ${readNumber(limits, "maxMessageBytes")}`);
  lines.push("");
  for (const entries of Object.values(readObject(schema, "enums"))) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (isRecord(entry)) {
        lines.push(`public const val CHANNEL_${readString(entry, "name")}: Int = ${readNumber(entry, "value")}`);
      }
    }
  }
  lines.push("");
  for (const entries of Object.values(readObject(schema, "bitsets"))) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (isRecord(entry)) {
        lines.push(`public const val FLAG_${readString(entry, "name")}: Int = ${1 << readNumber(entry, "bit")}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}


/* ------------------------------------------------------------------------- */
/* Swift 向けの生成                                                          */
/* ------------------------------------------------------------------------- */

const SWIFT_BANNER = `// このファイルは自動生成されている。手で編集してはならない。
//
// 生成元: プロトコルのスキーマ定義
// 再生成: 内部検証スクリプトを実行する
`;

/** Swift の値表現。整数は Int64、小数は Double、真偽は Bool、文字列は String とする。 */
function formatSwiftValue(value: unknown): { readonly type: string; readonly literal: string } | null {
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { type: "Int64", literal: `${value}` }
      : { type: "Double", literal: String(value) };
  }
  if (typeof value === "boolean") {
    return { type: "Bool", literal: String(value) };
  }
  if (typeof value === "string") {
    return { type: "String", literal: JSON.stringify(value) };
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const formatted = formatSwiftValue(item);
      if (formatted === null || formatted.type !== "Int64") {
        return null;
      }
      parts.push(formatted.literal);
    }
    return { type: "[Int64]", literal: `[${parts.join(", ")}]` };
  }
  return null;
}

function generateConstantsSwift(schema: Record<string, unknown>): string {
  const lines: string[] = [SWIFT_BANNER, "public enum WhesoConstants {"];
  for (const [groupName, group] of Object.entries(schema)) {
    if (groupName.startsWith("$") || !isRecord(group)) {
      continue;
    }
    lines.push(`    // ${groupName}`);
    for (const [constantName, definition] of Object.entries(group)) {
      if (constantName.startsWith("$") || !isRecord(definition)) {
        continue;
      }
      if (!("value" in definition)) {
        for (const [key, raw] of Object.entries(definition)) {
          if (key.startsWith("$") || key === "derivation" || key === "fact" || key === "question" || key === "adr") {
            continue;
          }
          const formatted = formatSwiftValue(raw);
          if (formatted === null) {
            continue;
          }
          const suffix = key.replace(/([A-Z])/g, "_$1").toUpperCase();
          lines.push(`    public static let ${constantName}_${suffix}: ${formatted.type} = ${formatted.literal}`);
        }
        continue;
      }
      const formatted = formatSwiftValue(definition["value"]);
      if (formatted === null) {
        continue;
      }
      lines.push(`    public static let ${constantName}: ${formatted.type} = ${formatted.literal}`);
    }
    lines.push("");
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function generateWireSwift(schema: Record<string, unknown>): string {
  const messageHeader = readObject(schema, "messageHeader");
  const unitHeader = readObject(schema, "unitHeader");
  const limits = readObject(schema, "limits");
  const lines: string[] = [SWIFT_BANNER, "public enum WhesoWireLayout {"];
  lines.push(`    public static let PROTOCOL_VERSION: UInt8 = ${readNumber(schema, "protocolVersion")}`);
  lines.push(`    public static let WIRE_MAGIC: UInt8 = ${readNumber(schema, "magic")}`);
  lines.push(`    public static let MESSAGE_HEADER_BYTES: Int = ${readNumber(messageHeader, "bytes")}`);
  lines.push(`    public static let UNIT_HEADER_BYTES: Int = ${readNumber(unitHeader, "bytes")}`);
  lines.push(`    public static let MAX_UNITS_PER_MESSAGE: Int = ${readNumber(limits, "maxUnitsPerMessage")}`);
  lines.push(`    public static let MAX_MESSAGE_BYTES: Int = ${readNumber(limits, "maxMessageBytes")}`);
  lines.push("");
  for (const entries of Object.values(readObject(schema, "enums"))) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (isRecord(entry)) {
        lines.push(
          `    public static let CHANNEL_${readString(entry, "name")}: UInt8 = ${readNumber(entry, "value")}`,
        );
      }
    }
  }
  lines.push("");
  for (const entries of Object.values(readObject(schema, "bitsets"))) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (isRecord(entry)) {
        lines.push(
          `    public static let FLAG_${readString(entry, "name")}: UInt8 = ${1 << readNumber(entry, "bit")}`,
        );
      }
    }
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------------- */
/* 実行                                                                      */
/* ------------------------------------------------------------------------- */

interface Artifact {
  readonly path: string;
  readonly content: string;
}

async function buildArtifacts(): Promise<readonly Artifact[]> {
  const wire = await readSchema("wire.json");
  const errors = await readSchema("errors.json");
  const constants = await readSchema("constants.json");
  return [
    { path: join(tsOutDir, "wire-layout.ts"), content: generateWireTs(wire) },
    { path: join(tsOutDir, "errors.ts"), content: generateErrorsTs(errors) },
    { path: join(tsOutDir, "constants.ts"), content: generateConstantsTs(constants) },
    { path: join(rustOutDir, "constants.rs"), content: generateConstantsRs(constants) },
    { path: join(rustOutDir, "wire_layout.rs"), content: generateWireRs(wire) },
    { path: join(rustOutDir, "errors.rs"), content: generateErrorsRs(errors) },
    { path: join(rustOutDir, "mod.rs"), content: generateModRs() },
    { path: join(cppOutDir, "constants.hpp"), content: generateConstantsHpp(constants) },
    { path: join(cppOutDir, "wire_layout.hpp"), content: generateWireHpp(wire) },
    { path: join(cppOutDir, "errors.hpp"), content: generateErrorsHpp(errors) },
    { path: join(dartOutDir, "constants.dart"), content: generateConstantsDart(constants) },
    { path: join(dartOutDir, "wire_layout.dart"), content: generateWireDart(wire) },
    { path: join(dartOutDir, "errors.dart"), content: generateErrorsDart(errors) },
    { path: join(kotlinOutDir, "Constants.kt"), content: generateConstantsKt(constants) },
    { path: join(kotlinOutDir, "WireLayout.kt"), content: generateWireKt(wire) },
    { path: join(kotlinOutDir, "Errors.kt"), content: generateErrorsKt(errors) },
    { path: join(swiftOutDir, "Constants.swift"), content: generateConstantsSwift(constants) },
    { path: join(swiftOutDir, "WireLayout.swift"), content: generateWireSwift(wire) },
    { path: join(swiftOutDir, "Errors.swift"), content: generateErrorsSwift(errors) },
  ];
}

async function generate(): Promise<void> {
  await mkdir(tsOutDir, { recursive: true });
  await mkdir(rustOutDir, { recursive: true });
  await mkdir(cppOutDir, { recursive: true });
  await mkdir(dartOutDir, { recursive: true });
  await mkdir(kotlinOutDir, { recursive: true });
  await mkdir(swiftOutDir, { recursive: true });
  const artifacts = await buildArtifacts();
  for (const artifact of artifacts) {
    await writeFile(artifact.path, artifact.content, "utf8");
    process.stdout.write(`generated ${relative(root, artifact.path)}\n`);
  }
}

async function check(): Promise<void> {
  const artifacts = await buildArtifacts();
  let mismatches = 0;
  for (const artifact of artifacts) {
    let existing = "";
    try {
      existing = await readFile(artifact.path, "utf8");
    } catch {
      process.stdout.write(`FAIL ${relative(root, artifact.path)} が存在しない\n`);
      mismatches += 1;
      continue;
    }
    if (existing !== artifact.content) {
      process.stdout.write(`FAIL ${relative(root, artifact.path)} がスキーマと乖離している\n`);
      mismatches += 1;
    }
  }
  if (mismatches === 0) {
    process.stdout.write(`OK: 生成物 ${artifacts.length} 件がスキーマと一致\n`);
    return;
  }
  process.stdout.write(`${mismatches} 件の乖離。node tools/codegen.ts generate を実行する\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "check";
  if (mode === "generate") {
    await generate();
    return;
  }
  if (mode === "check") {
    await check();
    return;
  }
  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exitCode = 1;
}

main().catch((error: unknown): void => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
  process.stderr.write(`FAILED: ${detail}\n`);
  process.exitCode = 1;
});
