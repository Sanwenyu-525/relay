import { describe, expect, it, afterEach } from "vitest";
import { fixtureAdapter } from "../src/fixtures/fixtureAdapter";
import { flush, mountWorkbench } from "./mountApp";

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("项目任务", () => {
  it("固定在当前项目范围，并给出项目内导航", async () => {
    const mounted = await mountWorkbench("/projects/project-hci/tasks");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("人机协作工作流研究");
    expect(mounted.wrapper.text()).toContain("项目任务");
    const active = mounted.wrapper.get(".subnav-item--active");
    expect(active.text()).toBe("任务");
    expect(active.attributes("aria-current")).toBe("page");
    expect(mounted.wrapper.find('[data-testid="project-task-row-task-recovery-logic"]').exists()).toBe(false);
  });

  it("默认选中被阻塞的任务，并展示阻塞原因与前置依赖", async () => {
    const mounted = await mountWorkbench("/projects/project-hci/tasks");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("为什么暂不能开始");
    expect(mounted.wrapper.text()).toContain("前置任务“确定实验评价指标”尚未完成");
    expect(mounted.wrapper.text()).toContain("完成以下前置任务后，方可开始本任务。");
    expect(mounted.wrapper.text()).toContain("本任务完成后，将为论文的实验结果与分析提供关键数据支持。");
  });

  it("依赖不满足时禁用开始并说明原因，可开始任务才能开始", async () => {
    const mounted = await mountWorkbench("/projects/project-hci/tasks");
    unmount = mounted.unmount;

    expect(mounted.wrapper.get('[data-testid="project-task-start"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.get('[data-testid="project-task-start-reason"]').text()).toContain("阻塞");

    await mounted.wrapper.get('[data-testid="project-task-row-task-organize-material"]').trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="project-task-start"]').attributes("disabled")).toBeUndefined();

    await mounted.wrapper.get('[data-testid="project-task-start"]').trigger("click");
    await flush(80);

    expect(fixtureAdapter.getCallCount("startTask")).toBe(1);
    expect(mounted.wrapper.text()).toContain("本次演示已开始");
    expect(mounted.wrapper.text()).toContain("开始不等于完成");
    expect(mounted.wrapper.get('[data-testid="project-task-start-reason"]').text()).toContain("进行中");
  });

  it("搜索只在当前项目范围内过滤", async () => {
    const mounted = await mountWorkbench("/projects/project-hci/tasks");
    unmount = mounted.unmount;

    await mounted.wrapper.get('input[name="project-task-search"]').setValue("文献");
    await flush();

    expect(mounted.wrapper.find('[data-testid="project-task-row-task-literature-review"]').exists()).toBe(true);
    expect(mounted.wrapper.find('[data-testid="project-task-row-task-organize-material"]').exists()).toBe(false);
  });

  it("未知项目给出空状态，不据此创建项目", async () => {
    const mounted = await mountWorkbench("/projects/unknown-project/tasks");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("没有这个示例项目");
    expect(mounted.wrapper.text()).toContain("不会据此创建项目或任务");
  });
});
