/**
 * 验收收口的源码快照装配器（验收工具，不入库）。
 *
 * 直接 import 被验收 spec 自己用的证据模块（tests/browser/scenarioLabEvidence.ts），
 * 保证这里的指纹与 browser-verdicts.json / shots-meta.json 里记录的是**同一份算法同一份口径**。
 * 用法：cd apps/workbench && pnpm exec vitest run --config <evidence>/vitest.snapshot.config.mts [--end]
 * （环境变量 RELAY_SNAPSHOT_PHASE=end 装配收尾快照）
 */
import { test } from "vitest";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  listKeyInputFiles, readGitEvidence, readSourceFingerprint, REPO_ROOT, sourceFileDigests
} from "../../../../apps/workbench/tests/browser/scenarioLabEvidence";

const phase = process.env.RELAY_SNAPSHOT_PHASE === "end" ? "end" : "start";
const outDir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function git(args: string[]): string {
  return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).trim();
}

test(`装配 ${phase} 相位的源码快照`, () => {
  const gitEvidence = readGitEvidence();
  const fingerprint = readSourceFingerprint();
  const files = listKeyInputFiles();
  const snapshot = {
    phase,
    capturedAt: new Date().toISOString(),
    git: {
      head: gitEvidence.head,
      headShort: git(["log", "-1", "--format=%h %s"]),
      branch: gitEvidence.branch,
      dirty: gitEvidence.dirty,
      workspaceDigest: gitEvidence.workspaceDigest,
      uncommittedPathCount: git(["status", "--porcelain", "--untracked-files=normal"])
        .split("\n").filter((line) => line.trim() !== "").length
    },
    sourceFingerprint: {
      digest: fingerprint.digest,
      algorithm: "每文件 SHA-256(盘上字节) → 按 path\\0hash 排序折叠进整体 SHA-256",
      fileCount: fingerprint.files,
      coverage: "实验室挂载的产品源码导入闭包（ScenarioLabView/scenarioHost 出发）+ 验收代码 + 构建/隔离配置",
      files
    },
    note: "workspaceDigest 只证明「当时不干净」；sourceDigest 按内容识别未提交改动——同一文件连续修改两次路径列表不变而摘要必变。"
  };
  writeFileSync(`${outDir}/source-snapshot-${phase}.json`, JSON.stringify(snapshot, null, 2), "utf8");
  console.log(`written: source-snapshot-${phase}.json digest=${fingerprint.digest} files=${fingerprint.files} dirtyPaths=${snapshot.git.uncommittedPathCount}`);
  // 逐文件摘要单独落一份：漂移归因时可以直接 diff 两份 phase 快照。
  writeFileSync(`${outDir}/source-file-digests-${phase}.json`,
    JSON.stringify(Object.fromEntries(sourceFileDigests()), null, 2), "utf8");
});
