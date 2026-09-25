import { describe, expect, it, afterEach } from "vitest";
import { fixtureAdapter, setFixtureLatency } from "../src/fixtures/fixtureAdapter";
import { flush, mountWorkbench } from "./mountApp";

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("全部任务", () => {
  it("全局页使用工作空间上下文，不用项目面包屑或工作台切换", async () => {
    const mounted = await mountWorkbench("/tasks");
    unmount = mounted.unmount;

    expect(mounted.wrapper.get(".breadcrumbs").text()).toContain("工作空间");
    expect(mounted.wrapper.get(".breadcrumbs").text()).toContain("任务");
    expect(mounted.wrapper.find(".skill-tabs").exists()).toBe(false);
    expect(mounted.wrapper.text()).not.toContain("通用");
  });

  it("跨项目展示状态、执行模式与执行者三个独立事实", async () => {
    const mounted = await mountWorkbench("/tasks");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("修复任务恢复逻辑");
    expect(mounted.wrapper.text()).toContain("待人工验收");
    expect(mounted.wrapper.text()).toContain("AI 委托");
    expect(mounted.wrapper.text()).toContain("未归属项目");
    expect(mounted.wrapper.text()).toContain("任务修订 v5");
  });

  it("筛选按作用域生效，空结果可清除筛选", async () => {
    const mounted = await mountWorkbench("/tasks");
    unmount = mounted.unmount;

    await mounted.wrapper.get('select[name="task-filter-mode"]').setValue("DELEGATE_AI");
    await flush(60);
    expect(mounted.wrapper.text()).toContain("完善文献综述");
    expect(mounted.wrapper.find('[data-testid="task-row-task-reading-notes"]').exists()).toBe(false);

    await mounted.wrapper.get('select[name="task-filter-status"]').setValue("DONE");
    await flush(60);
    expect(mounted.wrapper.text()).toContain("当前筛选没有匹配的任务");

    await mounted.wrapper.get('[data-testid="task-clear-filters"]').trigger("click");
    await flush(60);
    expect(mounted.wrapper.find('[data-testid="task-row-task-reading-notes"]').exists()).toBe(true);
  });

  it("收件箱范围只包含未归属任务，切换范围会重置项目筛选", async () => {
    const mounted = await mountWorkbench("/tasks");
    unmount = mounted.unmount;

    await mounted.wrapper.get('select[name="task-filter-project"]').setValue("project-hci");
    await flush(60);
    await mounted.wrapper.get('[data-testid="tasks-tab-inbox"]').trigger("click");
    await flush(60);

    expect(mounted.wrapper.find('[data-testid="task-row-task-reading-notes"]').exists()).toBe(true);
    expect(mounted.wrapper.find('[data-testid="task-row-task-evaluation-metrics"]').exists()).toBe(false);
    expect((mounted.wrapper.get('select[name="task-filter-project"]').element as HTMLSelectElement).value).toBe("all");
  });

  it("读取失败可重试，空列表提供新建入口", async () => {
    const failed = await mountWorkbench("/tasks?fixture=load-error");
    unmount = failed.unmount;
    expect(failed.wrapper.text()).toContain("暂时无法显示任务");
    failed.unmount();

    const empty = await mountWorkbench("/tasks?fixture=empty");
    unmount = empty.unmount;
    expect(empty.wrapper.text()).toContain("还没有任务");
  });

  it("筛选刷新保留已知内容并标识更新，不整页锁死", async () => {
    const mounted = await mountWorkbench("/tasks");
    unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("修复任务恢复逻辑");

    setFixtureLatency(60);
    await mounted.wrapper.get('select[name="task-filter-status"]').setValue("WAITING");
    await flush(10);

    expect(mounted.wrapper.find('[data-testid="tasks-refreshing"]').exists()).toBe(true);
    expect(mounted.wrapper.text()).toContain("修复任务恢复逻辑");
    expect(mounted.wrapper.text()).not.toContain("正在读取任务列表");

    await flush(120);
    expect(mounted.wrapper.find('[data-testid="tasks-refreshing"]').exists()).toBe(false);
    expect(mounted.wrapper.text()).not.toContain("修复任务恢复逻辑");
    expect(mounted.wrapper.text()).toContain("完善文献综述");
  });
});

describe("新建任务与执行准备", () => {
  it("必填与验收错误按字段定位，不发起创建", async () => {
    const mounted = await mountWorkbench("/tasks?view=create");
    unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="task-create-save"]').trigger("click");
    await flush();

    expect(mounted.wrapper.get('input[name="task-title"]').attributes("aria-describedby")).toBe("task-title-error");
    expect(mounted.wrapper.text()).toContain("请至少写一条可判断的验收标准");
    expect(fixtureAdapter.getCallCount("createTask")).toBe(0);
  });

  it("保存任务先为待整理，满足条件时转为可开始且不自动执行", async () => {
    const mounted = await mountWorkbench("/tasks?view=create");
    unmount = mounted.unmount;

    await mounted.wrapper.get('input[name="task-title"]').setValue("整理实验结果");
    await mounted.wrapper.get('input[name="task-expected-result"]').setValue("一份实验记录。");
    await mounted.wrapper.get('textarea[name="task-acceptance"]').setValue("步骤可复现\n结果可追溯");
    await mounted.wrapper.get('[data-testid="task-create-save"]').trigger("click");
    await flush(80);

    expect(fixtureAdapter.getCallCount("createTask")).toBe(1);
    expect(mounted.wrapper.text()).toContain("初始状态为待整理，由我执行");
    expect(mounted.wrapper.text()).toContain("已核对条件并标记为可开始");
    expect(mounted.wrapper.text()).toContain("不会自动开始执行");
    expect(mounted.wrapper.text()).toContain("尚未开始执行；当前执行者未变");
  });

  it("暂存待整理不尝试转为可开始", async () => {
    const mounted = await mountWorkbench("/tasks?view=create");
    unmount = mounted.unmount;

    await mounted.wrapper.get('input[name="task-title"]').setValue("随手记下的想法");
    await mounted.wrapper.get('[data-testid="task-create-inbox"]').trigger("click");
    await flush(80);

    expect(mounted.wrapper.text()).toContain("暂存为待整理");
    expect(mounted.wrapper.text()).not.toContain("已核对条件并标记为可开始");
  });

  it("前置依赖未完成时 ready 不通过，并说明原因", async () => {
    const mounted = await mountWorkbench("/tasks?view=create");
    unmount = mounted.unmount;

    await mounted.wrapper.get('input[name="task-title"]').setValue("依赖任务的新任务");
    await mounted.wrapper.get('input[name="task-expected-result"]').setValue("一份结果。");
    await mounted.wrapper.get('textarea[name="task-acceptance"]').setValue("可判断的标准");
    await mounted.wrapper.get('select[name="task-project"]').setValue("project-hci");
    await flush();
    await mounted.wrapper.get('select[name="task-dependency"]').setValue("task-evaluation-metrics");
    await mounted.wrapper.get('[data-testid="task-create-save"]').trigger("click");
    await flush(80);

    expect(mounted.wrapper.get('[data-testid="task-ready-blocked"]').text()).toContain("尚未完成");
    expect(mounted.wrapper.text()).toContain("任务保持待整理");
  });

  it("验收标准为空时 ready 不通过，不能把空标准当作完成依据", async () => {
    const mounted = await mountWorkbench("/tasks?view=create");
    unmount = mounted.unmount;

    await mounted.wrapper.get('input[name="task-title"]').setValue("只有标题的任务");
    await mounted.wrapper.get('input[name="task-expected-result"]').setValue("一份结果。");
    await mounted.wrapper.get('[data-testid="task-create-save"]').trigger("click");
    await flush(80);

    expect(fixtureAdapter.getCallCount("createTask")).toBe(0);
    expect(mounted.wrapper.text()).toContain("请至少写一条可判断的验收标准");
  });

  it("委托意图只作记录，不直接设置 DELEGATE_AI", async () => {
    const mounted = await mountWorkbench("/tasks?view=create");
    unmount = mounted.unmount;

    await mounted.wrapper.get('input[name="task-title"]').setValue("想委托出去的任务");
    await mounted.wrapper.get('input[name="task-expected-result"]').setValue("一份结果。");
    await mounted.wrapper.get('textarea[name="task-acceptance"]').setValue("可判断的标准");
    const delegateRadio = mounted.wrapper.findAll('input[name="task-intent"]')[2];
    await delegateRadio.setValue();
    await mounted.wrapper.get('[data-testid="task-create-save"]').trigger("click");
    await flush(80);

    expect(mounted.wrapper.text()).toContain("已记录 AI 委托意图");
    expect(mounted.wrapper.text()).toContain("本次没有变更执行者");
  });

  it("提交超时时先查回执，不重复创建", async () => {
    const mounted = await mountWorkbench("/tasks?view=create&fixture=timeout");
    unmount = mounted.unmount;

    await mounted.wrapper.get('input[name="task-title"]').setValue("超时任务");
    await mounted.wrapper.get('input[name="task-expected-result"]').setValue("一份结果。");
    await mounted.wrapper.get('textarea[name="task-acceptance"]').setValue("可判断的标准");
    await mounted.wrapper.get('[data-testid="task-create-save"]').trigger("click");
    await flush(80);

    expect(fixtureAdapter.getCallCount("createTask")).toBe(1);
    expect(mounted.wrapper.text()).toContain("提交结果暂不明确");
    expect(mounted.wrapper.text()).toContain("不要直接重复创建");
  });
});
