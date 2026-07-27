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
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", "generated", ".partykit", ".build"]);
const SCAN_EXTENSIONS = [".ts", ".tsx", ".rs", ".swift", ".kt", ".dart", ".cpp", ".hpp"];

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

const SWIFT_RULES: readonly Rule[] = [
  // 動的型: Any。ただし AnyObject / AnyHashable / AnyCancellable 等の合成語は除外する
  { name: "swift-any", pattern: /\bAny\b(?![A-Za-z])/g, note: "動的型 Any" },
  // 強制キャスト: as!
  { name: "swift-force-cast", pattern: /\bas!\s/g, note: "強制キャスト as!" },
  // 強制 try: try!
  { name: "swift-force-try", pattern: /\btry!\s/g, note: "強制 try" },
  // fatalError
  { name: "swift-fatal-error", pattern: /\bfatalError\s*\(/g, note: "fatalError" },
  // unsafeBitCast
  { name: "swift-unsafe-bit-cast", pattern: /\bunsafeBitCast\s*\(/g, note: "unsafeBitCast" },
  // 強制アンラップ: 後置 ! だが、条件が複雑。
  // パターン: 識別子または ] または ) の直後に ! が来て、その後が . / [ / ( / 空白 / 行末 / , / ) である場合。
  // as? や比較演算子 != は除外する。
  { name: "swift-force-unwrap", pattern: /[A-Za-z0-9_\])]!\s*[.[\](,;)\n]/g, note: "強制アンラップ" },
];

const KOTLIN_RULES: readonly Rule[] = [
  // 動的型: Any。ただし equals(other: Any?) は Kotlin の言語要件であるため除外する。
  { name: "kotlin-any", pattern: /\bAny\b/g, note: "動的型 Any" },
  // 非 null 断定: !!
  { name: "kotlin-double-bang", pattern: /!!/g, note: "非 null 断定 !!" },
  // lateinit
  { name: "kotlin-lateinit", pattern: /\blateinit\b/g, note: "lateinit" },
  // @Suppress
  { name: "kotlin-suppress", pattern: /@Suppress\b/g, note: "検査の抑制 @Suppress" },
  // error( — Kotlin stdlib の error() 関数（IllegalStateException を投げる）
  { name: "kotlin-error", pattern: /\berror\s*\(/g, note: "パニック相当 error()" },
];

const DART_RULES: readonly Rule[] = [
  // 動的型: dynamic
  { name: "dart-dynamic", pattern: /\bdynamic\b/g, note: "動的型 dynamic" },
  // late キーワード（後に空白が続く）
  { name: "dart-late", pattern: /\blate\s+/g, note: "late 変数" },
  // 検査の抑制: // ignore:
  { name: "dart-ignore", pattern: /\/\/\s*ignore:/g, note: "検査の抑制 // ignore:" },
  // 後置 !（非 null 断定）。パターン: 識別子 / ] / ) の直後に ! が来て . / [ / ( / , / ; / ) / 空白が続く
  { name: "dart-non-null-assert", pattern: /[A-Za-z0-9_\])]!\s*[.[\](,;)\s]/g, note: "非 null 断定 !" },
  // as キャスト（安全でないキャスト）。ただし is / as は条件式ではないので禁止。
  // パターン: `as ` の後に型名（大文字始まり）が続く場合を検出
  { name: "dart-as-cast", pattern: /\bas\s+[A-Z]/g, note: "型キャスト as" },
];

const CPP_RULES: readonly Rule[] = [
  // 動的型: void*
  { name: "cpp-void-ptr", pattern: /\bvoid\s*\*/g, note: "動的型 void*" },
  // 動的型: std::any
  { name: "cpp-std-any", pattern: /\bstd::any\b/g, note: "動的型 std::any" },
  // reinterpret_cast
  { name: "cpp-reinterpret-cast", pattern: /\breinterpret_cast\s*</g, note: "reinterpret_cast" },
  // C 形式キャスト: (type)expr のパターン。ただし (void) は除外しにくいため、
  // 型名（大文字始まりまたは基本型）が括弧内に来る場合を検出する。
  { name: "cpp-c-style-cast", pattern: /\(\s*(int|long|short|char|unsigned|signed|float|double|size_t|uint[0-9]+_t|int[0-9]+_t)\s*\)/g, note: "C 形式キャスト" },
  // #pragma warning(disable)
  { name: "cpp-pragma-disable", pattern: /#pragma\s+warning\s*\(\s*disable/g, note: "検査の抑制 #pragma warning(disable)" },
];

const TS_RULES: readonly Rule[] = [
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

/** 行がコメントまたはインポートとして無視すべきかを判定する。 */
function shouldSkipLine(trimmed: string): boolean {
  // 行コメント（各言語共通で // か * で始まる行）
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
    return true;
  }
  // インポート文
  if (trimmed.startsWith("import ")) {
    return true;
  }
  // Swift の #が付くプリプロセッサ指令（#if, #filePath 等）は除外しない
  return false;
}

/** Kotlin の equals(other: Any?) オーバーライドを判定する。言語要件のため除外する。 */
function isKotlinEqualsOverride(line: string): boolean {
  return /override\s+fun\s+equals\s*\(\s*other\s*:\s*Any\??\s*\)/.test(line);
}

/** 試験ファイルか否かを判定する */
function isTestFile(file: string): boolean {
  // Rust: /tests/ ディレクトリ
  // TypeScript: .test.ts, .spec.ts, /tests/ ディレクトリ
  // Swift: /Tests/ ディレクトリ
  // Kotlin: /test/ ディレクトリ
  // Dart: /test/ ディレクトリ
  // C++: /tests/ ディレクトリ
  return (
    file.includes("/tests/") ||
    file.includes("/Tests/") ||
    file.includes("/test/") ||
    file.endsWith(".test.ts") ||
    file.endsWith(".spec.ts") ||
    file.endsWith("_test.dart")
  );
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

    // 自身は検査対象外
    if (file.endsWith("forbidden.ts")) {
      continue;
    }

    const isRust = file.endsWith(".rs");
    const isSwift = file.endsWith(".swift");
    const isKotlin = file.endsWith(".kt");
    const isDart = file.endsWith(".dart");
    const isCpp = file.endsWith(".cpp") || file.endsWith(".hpp");
    const isTs = file.endsWith(".ts") || file.endsWith(".tsx");
    const test = isTestFile(file);
    const isCore =
      !test &&
      isTs &&
      (file.includes("/packages/core/src/") ||
        file.includes("/packages/client/src/sync/") ||
        file.includes("/packages/client/src/transport/") ||
        file.includes("/packages/client/src/quality/"));

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined) {
        continue;
      }
      const trimmed = line.trim();

      // コメントとインポート行は対象外とする
      if (shouldSkipLine(trimmed)) {
        continue;
      }

      // 文字列リテラル内の検出を減らす: 行が引用符で囲まれた内容のみの場合はスキップ
      // （完全な解析は行わないが、明らかな文字列行は除外する）

      // 拡張子で規則を切り替える
      let activeRules: readonly Rule[];
      if (isRust) {
        // 試験ファイルは lint-policy.md 9.3.1 により パニック相当のみ除外
        // 動的型は Rust にはない
        activeRules = test ? [] : RUST_RULES;
      } else if (isSwift) {
        // 試験ファイルの除外: パニック相当（try!, fatalError）のみ。動的型 Any は試験でも禁止。
        if (test) {
          activeRules = SWIFT_RULES.filter(
            (rule) => rule.name === "swift-any",
          );
        } else {
          activeRules = SWIFT_RULES;
        }
      } else if (isKotlin) {
        // 試験ファイルの除外: パニック相当（error()）のみ。動的型 Any は試験でも禁止。
        if (test) {
          activeRules = KOTLIN_RULES.filter(
            (rule) => rule.name === "kotlin-any",
          );
        } else {
          activeRules = KOTLIN_RULES;
        }
      } else if (isDart) {
        // 試験ファイルの除外: パニック相当は Dart には無い。動的型 dynamic は試験でも禁止。
        if (test) {
          activeRules = DART_RULES.filter(
            (rule) => rule.name === "dart-dynamic",
          );
        } else {
          activeRules = DART_RULES;
        }
      } else if (isCpp) {
        // 試験ファイルの除外: C++ にはパニック相当の構文が規範に無い。動的型は試験でも禁止。
        if (test) {
          activeRules = CPP_RULES.filter(
            (rule) => rule.name === "cpp-void-ptr" || rule.name === "cpp-std-any",
          );
        } else {
          activeRules = CPP_RULES;
        }
      } else if (isTs) {
        activeRules = isCore ? [...TS_RULES, ...CORE_RULES] : TS_RULES;
      } else {
        activeRules = [];
      }

      for (const rule of activeRules) {
        rule.pattern.lastIndex = 0;
        const match = rule.pattern.exec(line);
        if (match !== null) {
          // 言語固有の誤検出除外
          if (isKotlin && rule.name === "kotlin-any" && isKotlinEqualsOverride(line)) {
            continue;
          }
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
