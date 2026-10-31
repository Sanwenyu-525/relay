/**
 * 验收收口的测试结果装配器（验收工具，不入库）。
 *
 * 从本轮真实执行的原始日志与产物 JSON 汇总 test-results.json：只搬运事实（命令、退出码、
 * 用例明细、判定计数），不生成任何"看起来通过"的数。运行：node build-test-results.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const base = "D:/Develop/Relay-Agent";
const logs = join(here, "../logs");
const resultsLab = join(here, "../results-scenario-lab");

const repoRoot = base;
const git = (args) => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

// —— Playwright 原始日志 → 用例明细（run3 = 源码冻结后的最终证据轮；run1/run2 留作执行历史） ——
const runLog = readFileSync(join(logs, "playwright-run-20261031-run3.log"), "utf8");
const caseLines = [...runLog.matchAll(/^\s*(ok|not ok|x)\s+(\d+)\s+(.+?)\s+\(([\d.]+(?:ms|s|m))\)$/gmu)]
  .map((match) => ({ status: match[1] === "ok" ? "PASS" : "FAIL", name: match[3].trim(), duration: match[4] }));
const summaryLine = /(\d+)\s+(passed|failed)/g;
let passed = null; let failed = null;
for (const match of runLog.matchAll(/(\d+)\s+passed/gu)) passed = Number(match[1]);
for (const match of runLog.matchAll(/(\d+)\s+failed/gu)) failed = Number(match[1]);
const pwExit = /PW_EXIT=(\d+)/u.exec(runLog)?.[1] ?? null;
const startedAt = /=== PLAYWRIGHT RUN START (.+?) ===/u.exec(runLog)?.[1] ?? null;
const finishedAt = /=== PLAYWRIGHT RUN END (.+?) ===/u.exec(runLog)?.[1] ?? null;

const verdicts = readJson(join(resultsLab, "browser-verdicts.json"));
const shotsMeta = readJson(join(resultsLab, "shots-meta.json"));
const summary = readJson(join(resultsLab, "summary.json"));

const doc = {
  generatedAt: new Date().toISOString(),
  playwright: {
    command: "RELAY_E2E_PORT=4176 RELAY_SCENARIO_LAB_RESULTS_DIR=<tmp>/results-scenario-lab pnpm exec playwright test tests/browser/assistScenarioLab.spec.ts tests/browser/assistScenarioLabShots.spec.ts --workers=1",
    startedAt, finishedAt, exitCode: pwExit === null ? null : Number(pwExit),
    reportedPassed: passed, reportedFailed: failed,
    cases: caseLines,
    rawLog: "logs/playwright-run-20261031-run3.log",
    history: ["logs/playwright-run-20261031.log（run1：F06 整页导航 30s 超时，dev server 连接复用抖动；批量判定 145/145 已过）",
      "logs/playwright-run-20261031-run2.log（run2：18/18 过，但随后证据模块清理未用参数，指纹更新为终态）",
      "logs/playwright-run-20261031-run3.log（run3：源码冻结后的最终证据轮，指纹 a9c17ad3… 与 source-snapshot-end.json 一致）"]
  },
  scenarioLabEvidence: {
    verdicts: verdicts === null ? null : {
      ranAt: verdicts.ranAt, total: verdicts.total, pass: verdicts.pass,
      fail: verdicts.fail, notCovered: verdicts.notCovered, unchecked: verdicts.unchecked,
      browserOnlyChecks: verdicts.browserOnlyChecks,
      consoleErrors: verdicts.consoleErrors, stale: verdicts.stale ?? false,
      driftFiles: verdicts.driftFiles ?? [],
      manifestSha256: verdicts.manifestSha256,
      source: verdicts.source
    },
    shotsMeta: shotsMeta === null ? null : {
      generatedAt: shotsMeta.generatedAt, frameShots: shotsMeta.frameShots,
      expectedFrameShots: shotsMeta.expectedFrameShots, lastFrameShots: shotsMeta.lastFrameShots,
      stale: shotsMeta.stale ?? false, driftFiles: shotsMeta.driftFiles ?? [],
      source: shotsMeta.source
    },
    summary,
    screenshotCount: shotsMeta === null ? null : shotsMeta.frameShots
  },
  gitAtAssembly: { head: git(["rev-parse", "HEAD"]), branch: git(["branch", "--show-current"]) }
};
writeFileSync(join(here, "test-results.json"), JSON.stringify(doc, null, 2), "utf8");
console.log(`written test-results.json: playwright ${passed} passed / ${failed ?? 0} failed, exit=${pwExit}, stale(verdicts=${verdicts?.stale ?? false}, shots=${shotsMeta?.stale ?? false})`);
