import { expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { buildScenarioManifest, type ScenarioManifestEntry } from "../../src/dev/scenarioManifest";

/**
 * 场景实验室验收证据的共用口径。
 *
 * 这里只回答两个问题：**页面读回的清单是不是当前源码定义的那一份**，以及**这份证据是在
 * 哪个源码版本上生成的**。两个问题都不能靠“报告里看起来一致”来回答：
 * manifest、截图和判定必须由同一份源码指纹串起来，否则旧产物会被当成最新证据。
 */

export const EXPECTED_SCENARIO_COUNT = 145;
export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

export interface GitEvidence {
  readonly head: string;
  readonly branch: string;
  readonly dirty: boolean;
  /** 工作区状态的摘要：只证明“当时不干净”，不把他人未提交内容写进证据。 */
  readonly workspaceDigest: string;
  /**
   * 关键输入的**内容**摘要（2026-10-31 收口整改）。
   *
   * `workspaceDigest` 只能证明“当时有哪些路径被改过”：同一文件连续修改两次，路径列表
   * 完全相同、这份摘要却不变。`sourceDigest` 按**文件内容**逐个算 SHA-256 再折叠——
   * 内容变了它必然变，与 HEAD、分支、git 状态全部解耦。
   */
  readonly sourceDigest: string;
  readonly sourceFileCount: number;
  readonly capturedAt: string;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      ordered[key] = stable((value as Record<string, unknown>)[key]);
    }
    return ordered;
  }
  return value;
}

/** 与对象键顺序无关的 JSON 摘要：页面清单和源码清单只要字段值相同就得到同一个值。 */
export function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

export function fileSha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function git(args: readonly string[]): string {
  return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).trim();
}

/*
 * 关键输入的内容清单（2026-10-31 收口整改）。
 *
 * 场景实验室的证据链真正依赖两类文件：
 *   1. 实验室与它渲染的产品源码——从 `ScenarioLabView`/`scenarioHost` 出发的**相对导入闭包**
 *      覆盖它们（场景定义、外壳、AssistView 与它挂的三块面板、relayClient、dtos、css）。
 *      闭包外的东西（其他视图、后端、文档）不属于这份证据，改了不该让证据漂移；
 *   2. 验收代码与构建/隔离配置——显式列出，一个都不能缺，缺了宁可报错也不出指纹。
 */

const CLOSURE_ROOTS: readonly string[] = ["apps/workbench/src/dev/ScenarioLabView.tsx",
  "apps/workbench/src/dev/scenarioHost.tsx"];

const KEY_INPUT_FILES: readonly string[] = ["apps/workbench/tests/browser/assistScenarioLab.spec.ts",
  "apps/workbench/tests/browser/assistScenarioLabShots.spec.ts",
  "apps/workbench/tests/browser/scenarioLabEvidence.ts",
  "apps/workbench/tests/scenarioLabMatrix.spec.tsx",
  "apps/workbench/playwright.config.ts",
  "apps/workbench/vite.config.ts",
  "apps/workbench/package.json",
  "apps/workbench/scripts/check-scenario-lab-isolation.mjs"];

/** 相对导入的三种写法：`from "…"`（含 re-export）、动态 `import("…")`、副作用 `import "…"`。 */
const IMPORT_PATTERNS: readonly RegExp[] = [/\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g, /\bimport\s+["']([^"']+)["']/g];
const RESOLVE_SUFFIXES: readonly string[] = ["", ".tsx", ".ts", ".css", ".json", ".png", ".svg"];

function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* 未命中，试下一个 */ }
  }
  for (const index of ["index.tsx", "index.ts"] as readonly string[]) {
    const candidate = resolve(base, index);
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* 未命中 */ }
  }
  return null;
}

function importedFiles(file: string): readonly string[] {
  const source = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
      const resolved = resolveRelativeImport(file, match[1]!);
      if (resolved !== null) found.push(resolved);
    }
  }
  return found;
}

/** 从根出发的相对导入闭包（绝对路径、排序返回）；裸模块名与仓库外文件一律不追。 */
export function importClosure(roots: readonly string[], root: string): readonly string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...importedFiles(file).filter((next) => next.startsWith(root)));
  }
  return [...seen].sort();
}

/**
 * 关键输入文件清单（相对仓库根，排序、去重）。
 *
 * 任何关键文件缺失都直接抛错：缺文件时出一份“看似正常”的指纹，比没有指纹更危险。
 */
export function listKeyInputFiles(root: string = REPO_ROOT): readonly string[] {
  for (const rel of [...CLOSURE_ROOTS, ...KEY_INPUT_FILES]) {
    try { statSync(resolve(root, rel)); } catch {
      throw new Error(`关键输入文件缺失，拒绝生成源码指纹：${rel}`);
    }
  }
  // 清单一律用 "/" 分隔：摘要是跨平台核对的身份，不能随操作系统的路径分隔符漂移。
  const closure = importClosure(CLOSURE_ROOTS.map((rel) => resolve(root, rel)), root)
    .map((abs) => relative(root, abs).split(sep).join("/"));
  return [...new Set([...closure, ...KEY_INPUT_FILES])].sort();
}

/** 逐文件内容摘要：路径 → SHA-256(盘上字节)。已暂存、未暂存、未跟踪一视同仁——跑的就是盘上这份。 */
export function sourceFileDigests(root: string = REPO_ROOT): ReadonlyMap<string, string> {
  const files = listKeyInputFiles(root);
  return new Map(files.map((rel) => [rel, fileSha256(resolve(root, rel))]));
}

/** 对显式给出的文件清单（相对 root）算同一条内容摘要；清单里有读不到的文件直接抛错。 */
export function hashSourceFiles(root: string, files: readonly string[]): string {
  const digests = new Map<string, string>();
  for (const rel of files) digests.set(rel, fileSha256(resolve(root, rel)));
  return summarizeSourceDigest(digests);
}

/** 把逐文件摘要折叠成一个整体摘要：排序后按 `path\0hash` 串进 SHA-256。 */
export function summarizeSourceDigest(digests: Iterable<readonly [string, string]>): string {
  const hash = createHash("sha256");
  for (const [path, digest] of [...digests].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(`${path}\0${digest}\n`);
  }
  return hash.digest("hex");
}

export interface SourceFingerprint {
  readonly digest: string;
  readonly files: number;
  readonly capturedAt: string;
}

/** 当前关键输入的内容指纹。 */
export function readSourceFingerprint(root: string = REPO_ROOT): SourceFingerprint {
  const digests = sourceFileDigests(root);
  return { digest: summarizeSourceDigest(digests), files: digests.size, capturedAt: new Date().toISOString() };
}

/** 前后两份逐文件摘要的差异：新增、删除、内容变化都算漂移，返回排序后的相对路径。 */
export function sourceDrift(before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>): readonly string[] {
  const changed: string[] = [];
  for (const [path, digest] of after) if (before.get(path) !== digest) changed.push(path);
  for (const path of before.keys()) if (!after.has(path)) changed.push(path);
  return changed.sort();
}

export function readGitEvidence(): GitEvidence {
  const status = git(["status", "--porcelain", "--untracked-files=normal"]);
  const fingerprint = readSourceFingerprint();
  return {
    head: git(["rev-parse", "HEAD"]),
    branch: git(["branch", "--show-current"]) || "(detached)",
    dirty: status !== "",
    workspaceDigest: createHash("sha256").update(status, "utf8").digest("hex"),
    sourceDigest: fingerprint.digest,
    sourceFileCount: fingerprint.files,
    capturedAt: new Date().toISOString()
  };
}

/**
 * 页面里的清单必须与当前 `src/dev/scenarios` 的导出逐字段一致。
 *
 * 这条断言放在写盘之前：不一致时该 Playwright 用例失败、命令非零退出，
 * 不会先把旧清单覆盖成“新文件”再让报告看起来通过。
 */
export function expectManifestMatchesSource(entries: readonly ScenarioManifestEntry[]): void {
  const expected = buildScenarioManifest();
  expect(entries.length, `场景清单应有 ${EXPECTED_SCENARIO_COUNT} 条，实际 ${entries.length} 条`)
    .toBe(EXPECTED_SCENARIO_COUNT);
  expect(expected.length, `源码场景目录应有 ${EXPECTED_SCENARIO_COUNT} 条，实际 ${expected.length} 条`)
    .toBe(EXPECTED_SCENARIO_COUNT);
  expect(entries, "页面清单与 src/dev/scenarios 当前定义不一致：请重新生成 shots-manifest 与报告")
    .toEqual(expected);
}

/** 报告/截图侧要落盘的源码版本信息。 */
export function sourceEvidence(entries: readonly ScenarioManifestEntry[], gitEvidence: GitEvidence): {
  readonly gitHead: string;
  readonly gitBranch: string;
  readonly gitDirty: boolean;
  readonly workspaceDigest: string;
  readonly sourceDigest: string;
  readonly sourceFileCount: number;
  readonly manifestSha256: string;
  readonly scenarioCount: number;
  readonly capturedAt: string;
} {
  return {
    gitHead: gitEvidence.head,
    gitBranch: gitEvidence.branch,
    gitDirty: gitEvidence.dirty,
    workspaceDigest: gitEvidence.workspaceDigest,
    sourceDigest: gitEvidence.sourceDigest,
    sourceFileCount: gitEvidence.sourceFileCount,
    manifestSha256: hashJson(entries),
    scenarioCount: entries.length,
    capturedAt: gitEvidence.capturedAt
  };
}
