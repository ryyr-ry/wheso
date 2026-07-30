/**
 * 到達可能性の検査。
 *
 * **なぜこの検査が必要か。** これまでの検査はすべて「純関数が凍結ベクタと一致するか」を見て
 * いた。そのため「モジュールを書いたが入口から呼ばれていない」状態を誰も検出できなかった。
 * 実際に、接続の状態機械・復号器・再生クロック・報告・予備接続・符号化器のすべてが実装済み
 * のまま実行経路の外にあり、それを「完了」と記録していた。**実装したことと、機能が成立する
 * ことは別である。**
 *
 * 検査する 4 項目:
 *   1. 入口から到達しないファイル（製品コードでありながら誰も読み込まない）
 *   2. 到達可能なファイルの輸出のうち、誰も取り込まないもの
 *   3. 輸出された型のメンバ（クラスの公開メソッド・インタフェースの欄）で、参照が無いもの
 *   4. 事象の union で宣言された種別のうち、どこでも構築されないもの
 *
 * 4 は「表にある遷移が実行経路上に無い」を捕まえる。予備接続への切替は `stall` 事象で
 * 起きるが、その事象を作る呼び出しがどこにも無かった。状態機械の試験は通り、実物は動かない。
 *
 * 例外は `ALLOWED` に理由付きで書く。**理由を書けないものは例外にしてはならない。**
 * 例外の一覧が長くなること自体が、配線が終わっていないことの指標である。
 *
 * 実行: node tools/reachability.ts
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 入口。ここから静的に辿れないものは製品として動かない。
 *
 * サーバは `partykit.json` の `parties` に対応する 5 個と主入口である。
 * クライアントは参加の入口 1 個である（`joinMeeting` / `joinWith`）。
 */
const ENTRIES: readonly string[] = [
  "packages/server/src/index.ts",
  "packages/server/src/shard.ts",
  "packages/server/src/receiver.ts",
  "packages/server/src/sender.ts",
  "packages/server/src/control.ts",
  "packages/server/src/meta.ts",
  "packages/client/src/api/join-meeting.ts",
  // 適合ハーネスの入口。製品の入口ではないが、凍結トレースの照合という検証済みの
  // 経路であり、ここから辿れるもの（擬似乱数など）は死んだコードではない。
  "packages/core/src/conformance-harness.ts",
];

/** 検査対象の範囲。生成物は対象外（スキーマから作られるため未使用の輸出があってよい）。 */
const SCAN_ROOTS: readonly string[] = ["packages/core/src", "packages/client/src", "packages/server/src"];

interface Exemption {
  readonly name: string;
  readonly reason: string;
}

/**
 * 例外。**理由が書けないものを入れてはならない。**
 *
 * 「試験のために公開している」は理由になる。「まだ配線していない」は理由にならない
 * （その場合は配線するか、輸出をやめる）。
 */
const ALLOWED: readonly Exemption[] = [
  // 入口そのもの。外部（利用者）が呼ぶ。
  { name: "joinMeeting", reason: "公開 API の入口。利用者が呼ぶ" },
  { name: "joinWith", reason: "注入を明示する入口。試験と移植が呼ぶ" },
  { name: "browserDeps", reason: "公開 API。利用者が独自の注入を作るときの基点" },
  { name: "probeCapability", reason: "公開 API。参加前の能力探査" },
  { name: "probeSource", reason: "公開 API。参加前の送信源の探査" },
  { name: "senderIdFrom", reason: "公開 API。利用者が申告の宛先を作るために使う" },
  { name: "MainNode", reason: "PartyKit の既定輸出（partykit.json の main）" },
  { name: "ShardNode", reason: "PartyKit の既定輸出（partykit.json の parties）" },
  { name: "ReceiverNode", reason: "同上" },
  { name: "SenderNode", reason: "同上" },
  { name: "ControlNode", reason: "同上" },
  { name: "MetaNode", reason: "同上" },
  // 観測のために公開している純関数。判断には使わない。
  { name: "congestionOf", reason: "観測用。輻輳状態を外から確かめる（shard-core が明記）" },
  { name: "chosenRungOf", reason: "観測用。渡している段を外から確かめる（同上）" },
  { name: "highestRungOf", reason: "観測用。最上段を外から確かめる（receiver-core が明記）" },
  { name: "resyncCount", reason: "観測用。対応付けの作り直し回数（SLI）" },
  { name: "PIPELINE_REPORT_INTERVAL_MS", reason: "観測用。報告周期を外から確かめる" },
  { name: "OVERLOAD_CODE", reason: "観測用。過負荷のクローズコード" },
  { name: "SENDER_PEERS", reason: "観測用。次期 epoch の接続の識別子" },
  // 適合ハーネス。トレースの照合が入口である（製品の入口ではない）。
  { name: "runTrace", reason: "適合ハーネスの入口。tools/traces.ts が呼ぶ" },
  { name: "runFuzz", reason: "同上" },
  { name: "runReceiverTrace", reason: "同上。tools/traces-receiver.ts が呼ぶ" },
  { name: "ok", reason: "Result の構築子。全域で使う" },
  { name: "err", reason: "同上" },
  // 公開 API。利用側のサーバが呼ぶ（README の「Getting a meeting URL」）。
  { name: "issueToken", reason: "公開 API。会議を作る側のサーバがトークンを発行する" },
  // 適合の CLI（tools/conformance.ts）が呼ぶ入口。
  { name: "selftestPrng", reason: "適合 CLI の入口。擬似乱数の自己検査" },
  { name: "runTraceLines", reason: "適合 CLI の入口。トレースの再生" },
  // 部屋名規範の全文法を参照実装として持つ。tools/naming.ts が凍結ベクタで照合する。
  { name: "metaRoom", reason: "部屋名規範の参照実装。tools/naming.ts が照合する（段 5 で使う）" },
  { name: "fanoutRoom", reason: "同上（ファンアウト木。段 5）" },
  { name: "coordinatorRoom", reason: "同上（調停ノード。段 5）" },
  { name: "reassignmentRatio", reason: "再配置率の検証。tools/naming.ts が Rendezvous の性質を測る" },
  // 凍結資産の 16 進表現。tools/real-media.ts と 6 言語の試験が使う。
  { name: "toHex", reason: "凍結資産の 16 進表現。道具と 6 言語の試験が使う" },
  { name: "fromHex", reason: "同上" },
  // 事象の union ではなくトークンの種別の欄である（検査の誤検出）。
  { name: "client", reason: "トークンの種別の欄（`TokenClaims.kind`）。事象ではない" },
  // 段 5 のノード間ツリーの入力。表にあるイベントを無視して記録することをトレースが検証する。
  { name: "link", reason: "state-machines.md 4 節のノード間ツリーの入力（段 5）。無視の検証にトレースが使う" },
  {
    name: "budget",
    reason:
      "外から目標を与える入力（congestion.md 4.1）。生産者は再分割を決める制御面であり段 5 に属する。" +
      "観測した goodput は別の事象（`goodput`）として渡す（下限としてしか使えないため）。" +
      "判定は凍結トレースが検証している",
  },
];

/**
 * 型の持ち主ごとの例外。
 *
 * `Party.Server` のメソッドは PartyKit の実行環境が呼ぶ。`MeetingEvents` は
 * 対応表の鍵として参照される（`.name` の形では現れない）。いずれも「配線漏れ」ではない。
 */
const ALLOWED_OWNERS: readonly Exemption[] = [
  { name: "MainNode", reason: "PartyKit の実行環境がメソッドを呼ぶ" },
  { name: "ShardNode", reason: "同上" },
  { name: "ReceiverNode", reason: "同上" },
  { name: "SenderNode", reason: "同上" },
  { name: "ControlNode", reason: "同上" },
  { name: "MetaNode", reason: "同上" },
  { name: "MeetingEvents", reason: "対応表の鍵として参照する（`.name` の形にならない）" },
];

/**
 * 利用者（SDK の呼び出し側）が呼ぶ公開メソッド。
 *
 * 製品コードの内部から呼ばれないことは正しい。**ただし公開 API であることを
 * ここに明記しなければ例外にならない。** 「まだ配線していない」を隠す場所ではない。
 */
const PUBLIC_SURFACE: readonly Exemption[] = [
  { name: "Meeting.localParticipant", reason: "公開 API（sdk-api.md 3 節）" },
  { name: "Meeting.quality", reason: "公開 API（同）" },
  { name: "Meeting.subscribeFrames", reason: "公開 API（sdk-api.md 4 節）" },
  { name: "Meeting.framesSubscribed", reason: "端がフレーム通知の前に確認する。入口が使う" },
  { name: "Meeting.startScreenShare", reason: "公開 API（sdk-api.md 3 節）" },
  { name: "Meeting.stopScreenShare", reason: "公開 API（同）" },
  { name: "Meeting.setPinned", reason: "公開 API（同）" },
  { name: "Meeting.sendChat", reason: "公開 API（同）" },
  { name: "Meeting.leave", reason: "公開 API（同）" },
  { name: "Sink.displayHeight", reason: "観測用。試験が高さの申告を確かめる" },
  { name: "VideoSinkHandle.attach", reason: "公開 API（sdk-api.md 5 節）。利用者が描画先を渡す" },
  { name: "Meeting.setCamera", reason: "公開 API（sdk-api.md 3 節）" },
  { name: "Meeting.setMicrophone", reason: "公開 API（同）" },
  { name: "Link.connects", reason: "観測用。再接続の回数（SLI）" },
  { name: "Link.droppedMedia", reason: "観測用。接続が開く前に捨てた媒体の数" },
  { name: "NodeLink.isReady", reason: "観測用。送出の可否は sendBinary が内部で見る" },
  { name: "NodeLink.droppedBeforeReady", reason: "観測用。認証前に捨てた媒体の数" },
];

const ALLOWED_NAMES = new Set(ALLOWED.map((entry) => entry.name));
const ALLOWED_OWNER_NAMES = new Set(ALLOWED_OWNERS.map((entry) => entry.name));
const PUBLIC_SURFACE_NAMES = new Set(PUBLIC_SURFACE.map((entry) => entry.name));

interface SourceFile {
  readonly path: string;
  readonly text: string;
  /** 取り込み先の絶対パス。 */
  readonly imports: readonly string[];
  /** 取り込んだ名前（`import type` は除く）。 */
  readonly importedNames: readonly string[];
}

async function listFiles(dir: string): Promise<readonly string[]> {
  const out: string[] = [];
  const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated") {
        continue;
      }
      out.push(...(await listFiles(child)));
      continue;
    }
    if (entry.name.endsWith(".ts")) {
      out.push(child);
    }
  }
  return out;
}

/** 取り込み指定を絶対パスへ直す。解決できないものは null（外部依存）。 */
function resolveImport(fromPath: string, specifier: string): string | null {
  if (specifier.startsWith("@wheso/core/")) {
    return resolve(root, specifier.replace("@wheso/core/", "packages/core/"));
  }
  if (specifier.startsWith("@wheso/client/")) {
    return resolve(root, specifier.replace("@wheso/client/", "packages/client/"));
  }
  if (specifier.startsWith(".")) {
    return resolve(dirname(resolve(root, fromPath)), specifier);
  }
  return null;
}

/** 1 ファイルを読み、取り込みを抽出する。 */
async function readSource(path: string): Promise<SourceFile> {
  const text = await readFile(join(root, path), "utf8");
  const imports: string[] = [];
  const importedNames: string[] = [];
  // `import ... from "..."` と `import("...")` の両方を拾う。
  const pattern = /import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    const specifier = match[3] ?? match[4];
    if (specifier === undefined) {
      continue;
    }
    const resolved = resolveImport(path, specifier);
    if (resolved !== null) {
      imports.push(resolved);
    }
    if (match[1] !== undefined) {
      // `import type` は実行経路に寄与しない。名前の参照として数えない。
      continue;
    }
    const clause = match[2];
    if (clause === undefined) {
      continue;
    }
    const braces = /\{([\s\S]*)\}/.exec(clause);
    if (braces === null) {
      continue;
    }
    const inner = braces[1];
    if (inner === undefined) {
      continue;
    }
    for (const piece of inner.split(",")) {
      const trimmed = piece.trim();
      if (trimmed.length === 0) {
        continue;
      }
      if (trimmed.startsWith("type ")) {
        continue;
      }
      const parts = trimmed.split(/\s+as\s+/);
      const name = parts[0];
      if (name !== undefined && name.length > 0) {
        importedNames.push(name);
      }
    }
  }
  return { path, text, imports, importedNames };
}

interface Finding {
  readonly kind: string;
  readonly where: string;
  readonly detail: string;
}

/** 輸出された値（型ではない）の名前を取る。 */
function exportedValues(text: string): readonly string[] {
  const names: string[] = [];
  const pattern = /^export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

/**
 * 輸出されたクラスとインタフェースの**関数メンバ**の名前を取る。
 *
 * 完全な構文解析は行わない。`export interface X {` / `export class X {` の直後の塊から
 * 関数の形（`name(` または `name: (…) =>`）を拾う。データの欄は対象にしない
 * （直列化や分配で参照されるため、名前の出現では判定できない）。
 *
 * 判断に使うのではなく「呼び出しが 1 つも無い」ことの検出に使う。
 */
function exportedMembers(text: string): readonly { readonly owner: string; readonly member: string }[] {
  const out: { readonly owner: string; readonly member: string }[] = [];
  const pattern = /^export\s+(?:abstract\s+)?(interface|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)[^{]*\{/gm;
  for (const match of text.matchAll(pattern)) {
    const owner = match[2];
    const start = match.index;
    if (owner === undefined || start === undefined) {
      continue;
    }
    // 対応する閉じ括弧まで（入れ子を数える）。
    let depth = 0;
    let end = start;
    for (let index = start; index < text.length; index += 1) {
      const ch = text.charAt(index);
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    const body = text.slice(start, end);
    const memberPattern =
      /^\s{2}(?:readonly\s+|private\s+|public\s+|get\s+|set\s+)*([A-Za-z_$][A-Za-z0-9_$]*)(\??\s*[(:][^\n]*)$/gm;
    for (const member of body.matchAll(memberPattern)) {
      const name = member[1];
      const rest = member[2];
      if (name === undefined || rest === undefined || name === "constructor") {
        continue;
      }
      const isMethod = rest.startsWith("(") || rest.startsWith("?(") || rest.includes("=>");
      if (!isMethod) {
        continue;
      }
      out.push({ owner, member: name });
    }
  }
  return out;
}

/** 事象の union で宣言された種別。`kind: "x"` の形を拾う。 */
function declaredKinds(text: string): readonly string[] {
  const names: string[] = [];
  const pattern = /readonly\s+kind\s*:\s*"([a-zA-Z]+)"/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

async function main(): Promise<void> {
  const paths: string[] = [];
  for (const dir of SCAN_ROOTS) {
    paths.push(...(await listFiles(dir)));
  }
  const sources = new Map<string, SourceFile>();
  for (const path of paths) {
    const source = await readSource(path);
    sources.set(resolve(root, path), source);
  }

  // --- 1. 入口から到達するファイルの集合 ---
  const reachable = new Set<string>();
  const queue: string[] = ENTRIES.map((entry) => resolve(root, entry));
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || reachable.has(current)) {
      continue;
    }
    const source = sources.get(current);
    if (source === undefined) {
      continue;
    }
    reachable.add(current);
    for (const next of source.imports) {
      if (!reachable.has(next)) {
        queue.push(next);
      }
    }
  }

  const findings: Finding[] = [];

  for (const [absolute, source] of sources) {
    if (!reachable.has(absolute)) {
      findings.push({
        kind: "到達しないファイル",
        where: relative(root, absolute),
        detail: "入口から静的に辿れない。配線するか、製品コードから外す",
      });
      void source;
    }
  }

  // --- 2. 取り込まれない輸出 ---
  const importedEverywhere = new Set<string>();
  for (const [absolute, source] of sources) {
    if (!reachable.has(absolute)) {
      continue;
    }
    for (const name of source.importedNames) {
      importedEverywhere.add(name);
    }
  }
  for (const [absolute, source] of sources) {
    if (!reachable.has(absolute)) {
      continue;
    }
    for (const name of exportedValues(source.text)) {
      if (importedEverywhere.has(name) || ALLOWED_NAMES.has(name)) {
        continue;
      }
      // 同一ファイル内で使われているなら配線漏れではない（輸出が不要なだけである）。
      // 宣言の 1 回に加えて出現があるかを数える。
      const occurrences = source.text.split(new RegExp(`\\b${name}\\b`)).length - 1;
      if (occurrences > 1) {
        continue;
      }
      findings.push({
        kind: "誰も取り込まない輸出",
        where: `${relative(root, absolute)}: ${name}`,
        detail: "実行経路から呼ばれない。配線するか、輸出をやめる",
      });
    }
  }

  // --- 3. 参照が無いメンバ ---
  const reachableText = [...sources.entries()]
    .filter(([absolute]) => reachable.has(absolute))
    .map(([, source]) => source.text)
    .join("\n");
  for (const [absolute, source] of sources) {
    if (!reachable.has(absolute)) {
      continue;
    }
    for (const { owner, member } of exportedMembers(source.text)) {
      if (ALLOWED_OWNER_NAMES.has(owner) || PUBLIC_SURFACE_NAMES.has(`${owner}.${member}`)) {
        continue;
      }
      if (reachableText.includes(`.${member}`)) {
        continue;
      }
      findings.push({
        kind: "参照が無いメンバ",
        where: `${relative(root, absolute)}: ${owner}.${member}`,
        detail: "実行経路のどこからも参照されない",
      });
    }
  }

  // --- 4. 構築されない事象の種別 ---
  for (const [absolute, source] of sources) {
    if (!reachable.has(absolute)) {
      continue;
    }
    for (const kind of declaredKinds(source.text)) {
      if (ALLOWED_NAMES.has(kind)) {
        continue;
      }
      // 宣言（`readonly kind: "x"`）以外の場所で `kind: "x"` が現れることを要求する。
      const constructed = new RegExp(`(?<!readonly\\s)kind:\\s*"${kind}"`).test(reachableText);
      if (constructed) {
        continue;
      }
      findings.push({
        kind: "構築されない事象",
        where: `${relative(root, absolute)}: kind "${kind}"`,
        detail: "表にあるが実行経路で作られない。作る側を配線する",
      });
    }
  }

  const total = sources.size;
  process.stdout.write(`検査対象 ${String(total)} ファイル / 到達 ${String(reachable.size)} ファイル\n`);
  if (findings.length === 0) {
    process.stdout.write(`OK: 入口から到達しない製品コードは無い（例外 ${String(ALLOWED.length)} 件）\n`);
    return;
  }
  const byKind = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = byKind.get(finding.kind) ?? [];
    list.push(finding);
    byKind.set(finding.kind, list);
  }
  for (const [kind, list] of byKind) {
    process.stdout.write(`\n${kind}（${String(list.length)} 件）\n`);
    for (const finding of list) {
      process.stdout.write(`  ${finding.where}\n    → ${finding.detail}\n`);
    }
  }
  process.stdout.write(`\nNG: ${String(findings.length)} 件\n`);
  process.exitCode = 1;
}

await main();
