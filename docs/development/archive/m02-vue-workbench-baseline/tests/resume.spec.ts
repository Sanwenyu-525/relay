import { describe, expect, it, afterEach } from "vitest";
import { fixtureAdapter } from "../src/fixtures/fixtureAdapter";
import type { TaskDefinitionDraft } from "../src/types";
import { dialogLabels, dialogText, flush, mountWorkbench, pressEscape } from "./mountApp";

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

const definitionDraft: TaskDefinitionDraft = {
  objective: "比较人工执行与 AI 辅助的协作效果。",
  expectedResult: "一份可复核的实验评价方案。",
  acceptanceCriteria: ["指标计算方式明确"],
  inputSource: "项目研究笔记 v2",
  suggestedMode: "人工执行，按需 AI 辅助"
};

describe("继续这个项目", () => {
  it("展示当前进展、需要留意与建议下一步，并声明无比较基线", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?skill=resume");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("从这里，接着往前。");
    expect(mounted.wrapper.text()).toContain("已完成");
    expect(mounted.wrapper.text()).toContain("待你判断");
    expect(mounted.wrapper.text()).toContain("文献综述 v3 的检查已通过，但尚未完成人工接受");
    expect(mounted.wrapper.text()).toContain("本次没有可用的上次查看基线，不展示变化对比。");
    expect(mounted.wrapper.text()).toContain("以上为建议，尚未执行");
  });

  it("完成依据、待审产物与来源列表打开的详情标题与内容一致", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?skill=resume");
    unmount = mounted.unmount;

    await mounted.wrapper.findAll("button").find((button) => button.text().includes("完成依据"))?.trigger("click");
    await flush();
    expect(dialogLabels()).toContain("完成依据 v1");
    expect(dialogText()).toContain("明确研究问题");
    pressEscape();
    await flush();

    await mounted.wrapper.findAll("button").find((button) => button.text().includes("查看待审产物"))?.trigger("click");
    await flush();
    expect(dialogLabels()).toContain("文献综述 v3");
    expect(dialogText()).toContain("尚未形成人工接受的完成依据");
    pressEscape();
    await flush();

    const railSource = mounted.wrapper.findAll("button").find((button) => button.text().includes("验收标准 v2"));
    await railSource?.trigger("click");
    await flush();
    expect(dialogLabels()).toContain("验收标准 v2");
    expect(dialogText()).toContain("必需检查包含语义核对");
  });

  it("刷新摘要产生加载状态并更新时间，不改变任务事实", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?skill=resume");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("更新于 2026-09-19 10:45");
    const refresh = mounted.wrapper.findAll("button").find((button) => button.text().includes("刷新摘要"));
    await refresh?.trigger("click");
    await flush();

    expect(mounted.wrapper.text()).toContain("更新于 2026-09-20 10:52");
    expect(mounted.wrapper.text()).toContain("确定实验评价指标");
    expect(fixtureAdapter.getCallCount("applyBlueprint")).toBe(0);
    expect(fixtureAdapter.getCallCount("acceptTaskDefinition")).toBe(0);
  });

  it("来源不可用时不补全正文", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?skill=resume&fixture=source-unavailable");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("来源不可用");
    const unavailable = mounted.wrapper.findAll("button").find((button) => button.text().includes("来源不可用"));
    await unavailable?.trigger("click");
    await flush();

    expect(dialogText()).toContain("来源当前不可读取");
    expect(dialogText()).toContain("不会据此补全内容");
  });

  it("跨页事实一致：接受任务定义后摘要与风险同步更新", async () => {
    await fixtureAdapter.acceptTaskDefinition("task-evaluation-metrics", definitionDraft, "normal");
    const mounted = await mountWorkbench("/projects/project-hci?skill=resume");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("任务定义已形成 v2 修订");
    expect(mounted.wrapper.text()).toContain("任务定义已更新为 v2，验收方案仍基于任务 v1，需要重新核对");
    expect(mounted.wrapper.text()).toContain("准备开始“确定实验评价指标”");
    expect(mounted.wrapper.text()).toContain("基于当前任务 v2");
  });
});
