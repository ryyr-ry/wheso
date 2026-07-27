/**
 * 禁止構文の文字列検査。
 *
 * spec/lint-policy.md の禁止構文を、lint の抜け穴（コメント内の抑制指示、
 * 設定ファイル、生成コード）まで含めて検出する。
 *
 * 実行: node tools/forbidden.ts
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 既定は公開ディレクトリのみ。追加の対象はコマンド引数で渡す。 */
const SCAN_DIRS: readonly string[] =
  process.argv.length > 2 ? process.argv.slice(2) : ["packages", "tools"];
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", "generated", ".partykit"]);
const SCAN_EXTENSIONS = [".ts", ".tsx", ".rs"];

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly note: string;
}

/** 言語ごとに適用する規則を分ける。拡張子で判定する。 */
/**
 * コア（判断を行う層）でのみ適用する規則。
 * lint-policy.md 9 節: コアで浮動小数点・時刻・乱数・入出力を使わない。
 * 対象は packages/core/src と packages/client/src の sync / transport / quality である。
 */
const CORE_RULES: readonly Rule[] = [
  { name: "core-float-type", pattern: /:\s*(number)\s*=\s*[0-9]+\.[0-9]/g, note: "小数リテラルの代入" },
  { name: "core-clock", pattern: /\b(Date\.now|performance\.now)\b/g, note: "時刻の取得" },
  { name: "core-random", pattern: /\bMath\.random\b/g, note: "言語標準の乱数" },
  { name: "core-timer", pattern: /\b(setTimeout|setInterval)\b/g, note: "待機（出力コマンドで表す）" },
  { name: "core-float-div", pattern: /Math\.(ceil|floor)\s*\(\s*[A-Za-z_$][A-Za-z0-9_$.]*\s*\//g, note: "浮動小数点除算の切り上げ・切り捨て" },
];

const RUST_RULES: readonly Rule[] = [
  { name: "rust-unwrap", pattern: /\.unwrap\(/g, note: "unwrap（パニックする）" },
  { name: "rust-expect", pattern: /\.expect\(/g, note: "expect（パニックする）" },
  { name: "rust-panic", pattern: /\bpanic!\(/g, note: "panic!" },
  { name: "rust-unsafe", pattern: /\bunsafe\b/g, note: "未検査メモリ" },
  { name: "rust-allow", pattern: /#\[allow\(/g, note: "検査の抑制" },
];

const RULES: readonly Rule[] = [
  { name: "explicit-any", pattern: /(:|<)\s*any\b/g, note: "型注釈での any" },
  { name: "any-array", pattern: /\bany\[\]/g, note: "any の配列" },
  { name: "type-assertion-as", pattern: /\bas\s+(?!const\b)[A-Z_$][A-Za-z0-9_$<>\[\]|.]*/g, note: "型アサーション as T" },
  { name: "angle-assertion", pattern: /=\s*<[A-Z][A-Za-z0-9_$]*>\s*[A-Za-z_$]/g, note: "山括弧の型アサーション" },
  { name: "ts-ignore", pattern: /@ts-(ignore|expect-error|nocheck)/g, note: "型検査の抑制" },
  { name: "eslint-disable", pattern: /eslint-disable/g, note: "lint の抑制" },
  { name: "non-null-assertion", pattern: /[A-Za-z0-9_$\])]![.[(]/g, note: "非 null 断定" },
];

interface DirEntryInfo {
  readonly name: string;
  isDirectory(): boolean;
}

async function readDirNames(dir: string): Promise<readonly DirEntryInfo[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    const out: DirEntryInfo[] = [];
    for (const entry of entries) {
      const name: unknown = entry.name;
      if (typeof name !== "string") {
        continue;
      }
      const isDir = entry.isDirectory();
      out.push({ name, isDirectory: (): boolean => isDir });
    }
    return out;
  } catch {
    return [];
  }
}

async function collectFiles(dir: string, out: string[]): Promise<void> {
  const names = await readDirNames(dir);
  for (const entry of names) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) {
        continue;
      }
      await collectFiles(join(dir, entry.name), out);
      continue;
    }
    for (const extension of SCAN_EXTENSIONS) {
      if (entry.name.endsWith(extension)) {
        out.push(join(dir, entry.name));
        break;
      }
    }
  }
}

async function main(): Promise<void> {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    await collectFiles(join(root, dir), files);
  }
  files.sort();

  let violations = 0;
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined) {
        continue;
      }
      const trimmed = line.trim();
      // 行コメントと本ファイル自身のルール定義は対象外とする
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("import ")) {
        continue;
      }
      if (file.endsWith("forbidden.ts")) {
        continue;
      }
      // 拡張子で規則を切り替える。TypeScript の規則を Rust に当てても意味がない。
      // 試験ファイルは対象外とする。試験の失敗は停止として表すのが自然であり、
      // 規範（lint-policy.md 9 節）はコアと製品コードを対象とする。
      const isRust = file.endsWith(".rs");
      const isTest = file.includes("/tests/") || file.endsWith(".test.ts");
      const isCore =
        !isTest &&
        (file.includes("/packages/core/src/") ||
          file.includes("/packages/client/src/sync/") ||
          file.includes("/packages/client/src/transport/") ||
          file.includes("/packages/client/src/quality/"));
      const activeRules = isRust
        ? isTest
          ? []
          : RUST_RULES
        : isCore
          ? [...RULES, ...CORE_RULES]
          : RULES;
      for (const rule of activeRules) {
        rule.pattern.lastIndex = 0;
        const match = rule.pattern.exec(line);
        if (match !== null) {
          violations += 1;
          process.stdout.write(
            `VIOLATION ${relative(root, file)}:${index + 1} [${rule.name}] ${rule.note}\n    ${trimmed}\n`,
          );
        }
      }
    }
  }

  process.stdout.write(`検査対象 ${files.length} ファイル\n`);
  if (violations === 0) {
    process.stdout.write("OK: 禁止構文なし\n");
    return;
  }
  process.stdout.write(`${violations} 件の違反\n`);
  process.exitCode = 1;
}

main().catch((error: unknown): void => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
  process.stderr.write(`FAILED: ${detail}\n`);
  process.exitCode = 1;
});
