import { ALL_SCENARIOS } from "./scenarios";
import { browserOnlyCount, failedResults, type CheckResult } from "./scenarioChecks";
import type { Scenario } from "./scenarioWorld";

/**
 * 场景实验室 V2.1 的验收口径。
 *
 * 一条场景的结论只来自它自己声明的检查与实际执行到的帧/交互：
 *   * `browser-only` 检查需要真实布局或动画读数，静态批次**不得**把它算成通过；
 *   * 只跑静态断言的场景最多显示「静态检查通过」，不能概括成全部验收通过；
 *   * 完整 PASS 需要该场景的静态检查、交互脚本与全部必要检查都完成，且没有待浏览器项；
 *   * 预览超时、身份不符是「无法稳定验证」，不是失败，也不是通过；
 *   * 场景定义变化后旧结果标为「证据已过期」，不继续计入通过。
 */

export type LabRunMode = "static" | "full";
export type LabRunStatus = "running" | "completed" | "cancelled";

export type LabAcceptance =
  | "unchecked"
  | "pass"
  | "static"
  | "fail"
  | "not-covered"
  | "unverifiable"
  | "stale";

export interface LabVerdict {
  readonly acceptance: LabAcceptance;
  readonly mode: LabRunMode;
  /** 静态断言里通过的数量（不含 browser-only）。 */
  readonly passedChecks: number;
  readonly failedChecks: number;
  readonly totalChecks: number;
  readonly browserOnly: number;
  readonly interactionsRun: number;
  readonly failures: readonly string[];
  readonly detail: string;
}

export const ACCEPTANCE_LABEL: Readonly<Record<LabAcceptance, string>> = {
  unchecked: "未运行",
  pass: "全部通过",
  static: "静态检查通过",
  fail: "静态失败",
  "not-covered": "无法覆盖",
  unverifiable: "无法稳定验证",
  stale: "证据已过期"
};

export interface JudgeInput {
  readonly scenario: Scenario;
  readonly mode: LabRunMode;
  readonly checks: readonly CheckResult[];
  /** 预览是否稳定可用；超时/身份不符时传 false。 */
  readonly settled: boolean;
  readonly settleDetail?: string;
  readonly interactionsRun: number;
  readonly stale?: boolean;
}

export function judgeScenario(input: JudgeInput): LabVerdict {
  const { scenario, mode, checks, interactionsRun } = input;
  const browserOnly = browserOnlyCount(checks);
  const passedChecks = checks.filter((check) => check.status === "pass").length;
  const failures = failedResults(checks).map((item) => `${item.label}：${item.detail}`);
  const base = { mode, passedChecks, failedChecks: failures.length, totalChecks: checks.length,
    browserOnly, interactionsRun, failures };

  if (input.stale === true) {
    return { ...base, acceptance: "stale",
      detail: "场景定义或验收代码已变化，这份结果不再代表当前源码" };
  }
  if (scenario.uncovered !== undefined) {
    return { ...base, acceptance: "not-covered", detail: scenario.uncovered };
  }
  if (!input.settled) {
    return { ...base, acceptance: "unverifiable",
      detail: input.settleDetail ?? "预览在超时内没有停稳，未执行断言" };
  }
  if (failures.length > 0) {
    return { ...base, acceptance: "fail", detail: `${String(failures.length)} 条静态断言失败` };
  }
  const requiredInteractions = scenario.interactions?.length ?? 0;
  const pendingInteractions = mode === "static"
    ? requiredInteractions
    : Math.max(0, requiredInteractions - interactionsRun);
  if (browserOnly > 0) {
    return { ...base, acceptance: "static",
      detail: `静态检查通过；另有 ${String(browserOnly)} 条需要浏览器布局/动画验证`
        + (pendingInteractions > 0
          ? `；${String(pendingInteractions)} 条定义交互未执行` : "") };
  }
  if (pendingInteractions > 0) {
    return { ...base, acceptance: "static",
      detail: mode === "static"
        ? `静态检查通过；${String(pendingInteractions)} 条定义交互未执行，需完整场景验收`
        : `静态检查通过；只执行了 ${String(interactionsRun)}/${String(requiredInteractions)} 条交互` };
  }
  return { ...base, acceptance: "pass",
    detail: mode === "full" ? "静态检查、交互脚本与必要检查全部完成" : "静态检查全部完成，这条场景没有额外待验项" };
}

export type LabRunScope = "all" | "current";

export interface LabRunRecord {
  readonly id: string;
  readonly mode: LabRunMode;
  readonly scope: LabRunScope;
  readonly total: number;
  readonly identity: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly status: LabRunStatus;
  readonly done: number;
  readonly interactionsRun: number;
  readonly verdicts: Readonly<Record<string, LabVerdict>>;
  readonly results: Readonly<Record<string, readonly CheckResult[]>>;
  readonly cancelledReason?: string;
}

export interface LabRunCounts {
  readonly total: number;
  readonly checked: number;
  readonly pass: number;
  readonly staticPass: number;
  readonly fail: number;
  readonly pendingBrowser: number;
  readonly unverifiable: number;
  readonly notCovered: number;
  readonly stale: number;
  readonly notRun: number;
}

export const EMPTY_COUNTS: LabRunCounts = {
  total: ALL_SCENARIOS.length, checked: 0, pass: 0, staticPass: 0, fail: 0,
  pendingBrowser: 0, unverifiable: 0, notCovered: 0, stale: 0, notRun: ALL_SCENARIOS.length
};

export function countRun(verdicts: Readonly<Record<string, LabVerdict>>,
  stale = false, total = ALL_SCENARIOS.length): LabRunCounts {
  const values = Object.values(verdicts);
  const checked = values.length;
  if (stale) {
    return { total, checked, pass: 0, staticPass: 0, fail: 0,
      pendingBrowser: values.reduce((sum, item) => sum + item.browserOnly, 0),
      unverifiable: 0, notCovered: 0, stale: checked, notRun: total - checked };
  }
  return {
    total,
    checked,
    pass: values.filter((item) => item.acceptance === "pass").length,
    staticPass: values.filter((item) => item.acceptance === "static").length,
    fail: values.filter((item) => item.acceptance === "fail").length,
    pendingBrowser: values.reduce((sum, item) => sum + item.browserOnly, 0),
    unverifiable: values.filter((item) => item.acceptance === "unverifiable").length,
    notCovered: values.filter((item) => item.acceptance === "not-covered").length,
    stale: 0,
    notRun: total - checked
  };
}

export function acceptanceOfScenario(scenario: Scenario, verdict: LabVerdict | undefined,
  evidenceStale = false): LabAcceptance {
  if (verdict === undefined) return scenario.uncovered !== undefined ? "not-covered" : "unchecked";
  return evidenceStale ? "stale" : verdict.acceptance;
}

/** 场景定义指纹：只覆盖会影响验收结论的字段；源码更新后旧记录据此标为过期。 */
export function scenarioLabIdentity(): string {
  const raw = JSON.stringify(ALL_SCENARIOS.map((scenario) => ({
    id: scenario.id, title: scenario.title, host: scenario.host, stateKind: scenario.stateKind,
    steps: scenario.steps.map((step) => ({ at: step.at, label: step.label })),
    checks: scenario.checks,
    interactions: scenario.interactions ?? [],
    conditions: scenario.conditions ?? null,
    uncovered: scenario.uncovered ?? null,
    note: scenario.note ?? null
  })));
  return hashText(raw);
}

/** FNV-1a 32 位 × 2 个不同种子，足够给本机验收记录一个稳定的身份。 */
function hashText(value: string): string {
  const fnv = (seed: number): number => {
    let hash = seed;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  };
  return `${fnv(0x811c9dc5).toString(16)}-${fnv(0x9e3779b9).toString(16)}-${String(value.length)}`;
}

export const SCENARIO_LAB_IDENTITY = scenarioLabIdentity();
