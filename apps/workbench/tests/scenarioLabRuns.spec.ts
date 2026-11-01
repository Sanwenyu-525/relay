import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_LABEL, acceptanceOfScenario, countRun, judgeScenario, scenarioLabIdentity
} from "../src/dev/scenarioLabRuns";
import type { CheckResult } from "../src/dev/scenarioChecks";
import type { Scenario } from "../src/dev/scenarioWorld";
import { ALL_SCENARIOS } from "../src/dev/scenarios";

const scenario = (overrides: Partial<Scenario> = {}): Scenario => ({
  id: "T01", title: "测试场景", host: "SESSION", stateKind: "终态",
  component: "test", steps: [{ at: 0, label: "初始", set: (world) => world }],
  checks: [], ...overrides
});
const pass = (label: string): CheckResult => ({ label, status: "pass", detail: "" });
const fail = (label: string): CheckResult => ({ label, status: "fail", detail: "错了" });
const browser = (label: string): CheckResult => ({ label, status: "browser-only", detail: "需要真实布局" });

describe("验收口径", () => {
  it("browser-only 不计入静态通过，只显示静态检查通过", () => {
    const verdict = judgeScenario({ scenario: scenario(), mode: "static",
      checks: [pass("正文在场"), browser("无横向溢出")], settled: true, interactionsRun: 0 });
    expect(verdict.acceptance).toBe("static");
    expect(verdict.passedChecks).toBe(1);
    expect(verdict.browserOnly).toBe(1);
    expect(verdict.totalChecks).toBe(2);
    expect(ACCEPTANCE_LABEL[verdict.acceptance]).toBe("静态检查通过");
  });

  it("没有待浏览器项、没有交互的定义才算完整通过", () => {
    const verdict = judgeScenario({ scenario: scenario(), mode: "static",
      checks: [pass("正文在场")], settled: true, interactionsRun: 0 });
    expect(verdict.acceptance).toBe("pass");
  });

  it("静态失败必须标记失败，不能因为通过数量多就算通过", () => {
    const verdict = judgeScenario({ scenario: scenario(), mode: "static",
      checks: [pass("A"), pass("B"), fail("C")], settled: true, interactionsRun: 0 });
    expect(verdict.acceptance).toBe("fail");
    expect(verdict.failedChecks).toBe(1);
    expect(verdict.failures).toContain("C：错了");
  });

  it("只跑静态批次但场景定义了交互，不升级成完整通过", () => {
    const withInteractions = scenario({ interactions: [{ kind: "inspect", label: "看一眼", then: [] }] });
    const verdict = judgeScenario({ scenario: withInteractions, mode: "static",
      checks: [pass("正文在场")], settled: true, interactionsRun: 0 });
    expect(verdict.acceptance).toBe("static");
    expect(verdict.detail).toContain("未执行");
  });

  it("完整批次执行了全部交互且无待浏览器项，才判全部通过", () => {
    const withInteractions = scenario({ interactions: [{ kind: "inspect", label: "看一眼", then: [] }] });
    const passFull = judgeScenario({ scenario: withInteractions, mode: "full",
      checks: [pass("正文在场")], settled: true, interactionsRun: 1 });
    expect(passFull.acceptance).toBe("pass");
    const partial = judgeScenario({ scenario: withInteractions, mode: "full",
      checks: [pass("正文在场")], settled: true, interactionsRun: 0 });
    expect(partial.acceptance).toBe("static");
  });

  it("预览超时是无法稳定验证，不是失败也不是通过", () => {
    const verdict = judgeScenario({ scenario: scenario(), mode: "static",
      checks: [pass("正文在场")], settled: false, settleDetail: "正文没有停稳", interactionsRun: 0 });
    expect(verdict.acceptance).toBe("unverifiable");
    expect(ACCEPTANCE_LABEL[verdict.acceptance]).toBe("无法稳定验证");
  });

  it("未覆盖与证据过期各自保留明确状态", () => {
    const uncovered = judgeScenario({ scenario: scenario({ uncovered: "确定性 harness 抓不到" }),
      mode: "static", checks: [], settled: true, interactionsRun: 0 });
    expect(uncovered.acceptance).toBe("not-covered");
    const stale = judgeScenario({ scenario: scenario(), mode: "static",
      checks: [pass("正文在场")], settled: true, interactionsRun: 0, stale: true });
    expect(stale.acceptance).toBe("stale");
    expect(ACCEPTANCE_LABEL.stale).toBe("证据已过期");
  });
});

describe("批次计数", () => {
  it("取消后只统计已处理场景，剩余保持未运行", () => {
    const verdicts = {
      T01: judgeScenario({ scenario: scenario({ id: "T01" }), mode: "static",
        checks: [pass("A"), browser("B")], settled: true, interactionsRun: 0 }),
      T02: judgeScenario({ scenario: scenario({ id: "T02" }), mode: "static",
        checks: [fail("C")], settled: true, interactionsRun: 0 })
    };
    const counts = countRun(verdicts, false, 145);
    expect(counts.checked).toBe(2);
    expect(counts.notRun).toBe(143);
    expect(counts.pass).toBe(0);
    expect(counts.staticPass).toBe(1);
    expect(counts.fail).toBe(1);
    expect(counts.pendingBrowser).toBe(1);
    expect(counts.checked).not.toBe(145);
  });

  it("证据过期后旧通过不再计入通过", () => {
    const verdicts = { T01: judgeScenario({ scenario: scenario({ id: "T01" }), mode: "static",
      checks: [pass("A")], settled: true, interactionsRun: 0 }) };
    const counts = countRun(verdicts, true, 145);
    expect(counts.pass).toBe(0);
    expect(counts.staticPass).toBe(0);
    expect(counts.stale).toBe(1);
    expect(counts.notRun).toBe(144);
  });

  it("目录读取未运行/未覆盖状态", () => {
    expect(acceptanceOfScenario(scenario({ uncovered: "无法验证" }), undefined)).toBe("not-covered");
    expect(acceptanceOfScenario(scenario(), undefined)).toBe("unchecked");
  });

  it("场景定义指纹稳定且覆盖全部场景", () => {
    expect(scenarioLabIdentity()).toBe(scenarioLabIdentity());
    expect(ALL_SCENARIOS.length).toBe(145);
  });
});
