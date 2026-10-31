import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  fileSha256, hashSourceFiles, importClosure, listKeyInputFiles, readSourceFingerprint,
  sourceDrift, sourceFileDigests, summarizeSourceDigest
} from "./browser/scenarioLabEvidence";

/**
 * 场景实验室证据指纹的反例（2026-10-31 收口整改的 P2 项）。
 *
 * 整改前 `workspaceDigest` 只对 `git status --porcelain` 的文本做哈希：同一文件连续修改两次，
 * 路径列表完全相同、摘要却不变——未提交工作树里「源码内容变过」这件事无法被证据机制识别。
 * 这一组用例把新的内容指纹钉在三件事上：
 *   1. 内容变化必然改变摘要（与 HEAD、分支、git 状态路径列表全部解耦）；
 *   2. 漂移能被逐文件抓出来并支撑 STALE 判定，而不是沿用旧 PASS；
 *   3. 明确无关的文件不在关键输入清单里，改它们不伪造产品回归失败。
 */

const scratchRoots: string[] = [];

function scratchRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-evidence-digest-"));
  scratchRoots.push(dir);
  return dir;
}

function scratchGitRoot(): string {
  const dir = scratchRoot();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "spec@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "spec"], { cwd: dir });
  return dir;
}

function gitStatus(root: string): string {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"],
    { cwd: root, encoding: "utf8" });
}

/** 旧式「只对路径列表做哈希」的摘要——用来演示它为什么发现不了内容变化。 */
function pathListDigest(files: readonly string[]): string {
  return createHash("sha256").update([...files].sort().join("\n"), "utf8").digest("hex");
}

afterAll(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

describe("关键输入内容指纹", () => {
  it("反例①：相同 HEAD、相同 git 状态路径列表，文件内容改变，摘要必须改变", () => {
    const root = scratchGitRoot();
    const file = join(root, "src.ts");
    writeFileSync(file, "export const v = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });

    // 第一次修改：工作区出现 " M src.ts"。
    writeFileSync(file, "export const v = 2;\n");
    const first = hashSourceFiles(root, ["src.ts"]);
    const statusFirst = gitStatus(root);

    // 第二次修改：porcelain 输出仍是同一行 " M src.ts"——路径列表摘要不变，
    // 内容摘要必须变（这正是整改前 workspaceDigest 的盲区）。
    writeFileSync(file, "export const v = 3;\n");
    const second = hashSourceFiles(root, ["src.ts"]);
    expect(gitStatus(root), "第二次修改后 git 状态路径列表应当一字不差").toBe(statusFirst);
    expect(pathListDigest(["src.ts"]), "路径列表摘要在两次修改间不变（旧口径的盲区）")
      .toBe(pathListDigest(["src.ts"]));
    expect(second, "同一路径清单、不同内容，内容摘要必须不同").not.toBe(first);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
  });

  it("反例②：已暂存与未跟踪文件的内容都在摘要里（读的是盘上内容）", () => {
    const root = scratchGitRoot();
    const file = join(root, "staged.ts");
    writeFileSync(file, "const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });

    const base = hashSourceFiles(root, ["staged.ts"]);
    // 已暂存：内容写进 index，也在盘上——跑的是盘上这份，摘要必须反映它。
    writeFileSync(file, "const a = 2;\n");
    execFileSync("git", ["add", "staged.ts"], { cwd: root });
    expect(hashSourceFiles(root, ["staged.ts"]), "已暂存的新内容必须进摘要").not.toBe(base);

    // 未跟踪：新文件进清单、内容再变，摘要都要跟着变。
    writeFileSync(join(root, "untracked-extra.ts"), "const b = 1;\n");
    const withUntracked = hashSourceFiles(root, ["staged.ts", "untracked-extra.ts"]);
    writeFileSync(join(root, "untracked-extra.ts"), "const b = 2;\n");
    expect(hashSourceFiles(root, ["staged.ts", "untracked-extra.ts"]),
      "未跟踪文件的内容变化必须反映在摘要里").not.toBe(withUntracked);
  });

  it("反例③：运行期间关键输入被改，逐文件漂移要抓出来并支撑 STALE 判定", () => {
    const root = scratchRoot();
    writeFileSync(join(root, "a.ts"), "a1\n");
    writeFileSync(join(root, "b.ts"), "b1\n");
    const digestOf = (rel: string): readonly [string, string] =>
      [rel, fileSha256(join(root, rel))];
    const before = new Map([digestOf("a.ts"), digestOf("b.ts")]);
    expect(summarizeSourceDigest(before)).toMatch(/^[0-9a-f]{64}$/);

    // 模拟批量运行期间另一个任务改了 a.ts、新增了 c.ts（改内容/新增都算漂移）。
    writeFileSync(join(root, "a.ts"), "a2\n");
    writeFileSync(join(root, "c.ts"), "c1\n");
    const after = new Map([digestOf("a.ts"), digestOf("b.ts"), digestOf("c.ts")]);
    expect(sourceDrift(before, after), "内容变化与新增都必须被抓出来").toEqual(["a.ts", "c.ts"]);
    expect(sourceDrift(before, before), "没有漂移时不得报告任何文件").toEqual([]);
  });

  it("反例④：只修改明确无关的文件，关键输入摘要不得变化", () => {
    const root = scratchRoot();
    mkdirSync(join(root, "unrelated"), { recursive: true });
    writeFileSync(join(root, "key.ts"), "key\n");
    const before = hashSourceFiles(root, ["key.ts"]);
    writeFileSync(join(root, "unrelated", "other.ts"), "noise\n");
    expect(hashSourceFiles(root, ["key.ts"]), "清单之外的文件不得影响关键输入摘要").toBe(before);
  });

  it("反例⑤：关键文件缺失、损坏时拒绝出指纹，不得静默通过", () => {
    const root = scratchRoot();
    writeFileSync(join(root, "present.ts"), "ok\n");
    // 清单里有一个不存在的文件：直接抛错，而不是给一份缺文件的指纹。
    expect(() => hashSourceFiles(root, ["present.ts", "missing.ts"])).toThrow();
    // 临时根上没有实验室闭包根：清单构造同样拒绝，绝不输出“看似正常”的指纹。
    expect(() => listKeyInputFiles(root)).toThrow(/关键输入文件缺失/);
    // 目录冒充文件同样读不出内容，等价于损坏。
    mkdirSync(join(root, "dir-as-file"), { recursive: true });
    expect(() => hashSourceFiles(root, ["dir-as-file"])).toThrow();
  });

  it("真实仓库：指纹两次读取一致，清单覆盖实验室挂载的产品源码与验收配置", () => {
    const files = listKeyInputFiles();
    // 关键输入的构成：实验室与它渲染的产品源码（导入闭包）+ 验收代码 + 构建/隔离配置。
    for (const required of ["apps/workbench/src/dev/scenarioManifest.ts",
      "apps/workbench/src/dev/scenarios/index.ts", "apps/workbench/src/dev/ScenarioLab.css",
      "apps/workbench/src/views/AssistView.tsx", "apps/workbench/src/components/SessionRoundTrace.tsx",
      "apps/workbench/src/components/RunToolTrajectoryPanel.tsx",
      "apps/workbench/src/components/ExecutionTrajectorySummary.tsx",
      "apps/workbench/src/components/FileWriteFrozenDiffPanel.tsx",
      "apps/workbench/src/api/relayClient.ts", "apps/workbench/playwright.config.ts",
      "apps/workbench/scripts/check-scenario-lab-isolation.mjs"]) {
      expect(files, `关键输入清单必须包含 ${required}`).toContain(required);
    }
    const first = readSourceFingerprint();
    const second = readSourceFingerprint();
    expect(first.digest, "同一份源码连续两次读取，指纹必须一致（确定性）").toBe(second.digest);
    expect(first.files).toBe(files.length);
    expect(first.files, "实验室证据链依赖的文件不可能只有几份").toBeGreaterThan(20);
  });

  it("真实仓库：闭包不收与实验室无关的模块，改它们不伪造这条证据链的漂移", () => {
    const files = listKeyInputFiles();
    expect(files.some((file) => file.includes("CollaborationView")),
      "CollaborationView 不被实验室闭包引用（若未来被引用，这条钉子会红，此时应重新审计清单边界）").toBe(false);
    expect(files.some((file) => file.startsWith("apps/api/")),
      "后端源码不是浏览器证据链的关键输入").toBe(false);
    expect(sourceDrift(sourceFileDigests(), sourceFileDigests()),
      "真实仓库静止状态下不得有漂移").toEqual([]);
  });

  it("导入闭包：相对导入（含目录索引与副作用 css）都追到，裸模块名不追", () => {
    const root = scratchRoot();
    mkdirSync(join(root, "pkg"), { recursive: true });
    writeFileSync(join(root, "entry.tsx"), "import \"./pkg/index\";\nimport \"./side.css\";\n");
    writeFileSync(join(root, "pkg", "index.tsx"), "export const x = 1;\n");
    writeFileSync(join(root, "side.css"), ".x {}\n");
    writeFileSync(join(root, "bare.ts"), "import react from \"react\";\n");
    const closure = importClosure([join(root, "entry.tsx"), join(root, "bare.ts")], root);
    const names = closure.map((file) => relative(root, file).split(sep).join("/"));
    expect(names, "目录索引与副作用 css 都要追到；裸模块名与清单里的根都要保留")
      .toEqual(["bare.ts", "entry.tsx", "pkg/index.tsx", "side.css"]);
  });

  it("摘要口径确定：同一批文件无论从哪个入口折叠，指纹一致", () => {
    const root = scratchRoot();
    writeFileSync(join(root, "m.ts"), "m\n");
    const viaDigests = summarizeSourceDigest(new Map([["m.ts", fileSha256(join(root, "m.ts"))]]));
    const viaExplicit = hashSourceFiles(root, ["m.ts"]);
    expect(viaDigests).toBe(viaExplicit);
  });
});
