import { describe, expect, it, afterEach } from "vitest";
import { fixtureAdapter } from "../src/fixtures/fixtureAdapter";
import { flush, mountWorkbench } from "./mountApp";

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("完善任务定义", () => {
  it("显示原始想法、建议定义与来源依据", async () => {
    const mounted = await mountWorkbench("/tasks/task-evaluation-metrics?skill=definition");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("你的原始想法");
    expect(mounted.wrapper.text()).toContain("想比较不同协作方式的效果。");
    expect(mounted.wrapper.text()).toContain("比较人工执行与 AI 辅助的协作效果。");
    expect(mounted.wrapper.text()).toContain("指标计算方式明确");
    expect(mounted.wrapper.text()).toContain("基于任务 v1，接受后形成新修订。");
  });

  it("接受定义形成新修订，但不开始任务也不委托", async () => {
    const mounted = await mountWorkbench("/tasks/task-evaluation-metrics?skill=definition");
    unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="definition-accept"]').trigger("click");
    await flush();

    expect(fixtureAdapter.getCallCount("acceptTaskDefinition")).toBe(1);
    const receipt = mounted.wrapper.get(".receipt-message").text();
    expect(receipt).toContain("v2 修订");
    expect(receipt).toContain("任务尚未开始");
    expect(receipt).toContain("未委托 AI");
    expect(mounted.wrapper.text()).toContain("已形成 v2 修订");
    expect(mounted.wrapper.get('[data-testid="definition-accept"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.get('[data-testid="definition-accept-reason"]').text()).toContain("如需调整");
  });

  it("暂不采用保持当前事实，并可继续修改建议", async () => {
    const mounted = await mountWorkbench("/tasks/task-evaluation-metrics?skill=definition");
    unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="definition-reject"]').trigger("click");
    await flush();

    expect(mounted.wrapper.text()).toContain("当前任务事实与验收标准保持不变");
    expect(mounted.wrapper.get('[data-testid="definition-accept"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.get('[data-testid="definition-accept-reason"]').text()).toContain("暂不采用");
    expect(mounted.wrapper.text()).toContain("比较人工执行与 AI 辅助的协作效果。");

    await mounted.wrapper.get('[data-testid="definition-edit"]').trigger("click");
    await mounted.wrapper.get('textarea[name="task-objective"]').setValue("把协作效果拆成可比指标");
    await mounted.wrapper.get('[data-testid="definition-edit-form"]').trigger("submit");
    await flush();

    expect(mounted.wrapper.text()).toContain("把协作效果拆成可比指标");
    expect(mounted.wrapper.text()).toContain("已形成 v2 修订");
  });

  it("版本冲突时保留草稿与编辑入口", async () => {
    const mounted = await mountWorkbench("/tasks/task-evaluation-metrics?skill=definition&fixture=conflict");
    unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="definition-accept"]').trigger("click");
    await flush();

    expect(mounted.wrapper.get(".action-error").text()).toContain("草稿仍保留");
    expect(mounted.wrapper.text()).toContain("比较人工执行与 AI 辅助的协作效果。");
    expect(mounted.wrapper.get('[data-testid="definition-accept"]').attributes("disabled")).toBeUndefined();
  });

  it("输入资料打开对应来源详情", async () => {
    const mounted = await mountWorkbench("/tasks/task-evaluation-metrics?skill=definition");
    unmount = mounted.unmount;

    await mounted.wrapper.get(".inline-link").trigger("click");
    await flush();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-label")).toBe("项目研究笔记 v2");
    expect(dialog?.textContent).toContain("记录了要比较的协作方式");
  });
});
