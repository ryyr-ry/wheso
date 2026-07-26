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
  ];
}

async function generate(): Promise<void> {
  await mkdir(tsOutDir, { recursive: true });
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
