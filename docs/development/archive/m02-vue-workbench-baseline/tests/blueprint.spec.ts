import { describe, expect, it, afterEach } from "vitest";
import { fixtureAdapter, setFixtureLatency } from "../src/fixtures/fixtureAdapter";
import { flush, mountWorkbench } from "./mountApp";

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("项目蓝图预览", () => {
  it("默认显示当前与建议差异，应用按钮可用", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?skill=blueprint");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("本次蓝图变更");
    expect(mounted.wrapper.text()).toContain("整理核心研究问题");
    expect(mounted.wrapper.get('[data-testid="blueprint-apply"]').attributes("disabled")).toBeUndefined();
    expect(mounted.wrapper.text()).toContain("新任务进入收件箱，由我执行；不会自动开始。");
  });

  it("修改建议后重新预览只生成新候选，不应用到项目", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?skill=blueprint");
    unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="blueprint-edit"]').trigger("click");
    await mounted.wrapper.get('input[name="blueprint-next-action"]').setValue("重新整理研究问题清单");
    await mounted.wrapper.get('[data-testid="blueprint-edit-form"]').trigger("submit");
    await flush();

    expect(fixtureAdapter.getCallCount("previewBlueprint")).toBe(1);
    expect(fixtureAdapter.getCallCount("applyBlueprint")).toBe(0);
    expect(mounted.wrapper.text()).toContain("本轮新候选 v2");
    expect(mounted.wrapper.text()).toContain("本次演示已形成新候选 v2");
    expect(mounted.wrapper.text()).toContain("重新整理研究问题清单");
  });

  it("暂不采用后不能直接应用同一候选，重新预览后恢复", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?skill=blueprint");
    unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="blueprint-reject"]').trigger("click");
    await flush();

    expect(mounted.wrapper.get('[data-testid="blueprint-apply"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.get('[data-testid="blueprint-apply-reason"]').text()).toContain("暂不采用");
    expect(mounted.wrapper.text()).toContain("已创建的项目仍保留");

    await mounted.wrapper.get('[data-testid="blueprint-edit"]').trigger("click");
    await mounted.wrapper.get('[data-testid="blueprint-edit-form"]').trigger("submit");
    await flush();

    expect(mounted.wrapper.get('[data-testid="blueprint-apply"]').attributes("disabled")).toBeUndefined();
  });

  it("重复点击应用只提交一次", async () => {
    setFixtureLatency(40);
    const mounted = await mountWorkbench("/projects/project-hci?skill=blueprint");
    unmount = mounted.unmount;

    const button = mounted.wrapper.get('[data-testid="blueprint-apply"]');
    await button.trigger("click");
    await button.trigger("click");
    await flush(150);

    expect(fixtureAdapter.getCallCount("applyBlueprint")).toBe(1);
    expect(mounted.wrapper.text()).toContain("尚未开始执行");
  });

  it("提交冲突时保留草稿并可重新核对", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?skill=blueprint&fixture=conflict");
    unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="blueprint-apply"]').trigger("click");
    await flush();

    expect(mounted.wrapper.get(".action-error").text()).toContain("草稿已保留");
    expect(mounted.wrapper.text()).toContain("整理核心研究问题");
    expect(mounted.wrapper.text()).toContain("按当前草稿重新核对");
  });

  it("提交超时提示查询原回执而不是直接重试", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?skill=blueprint&fixture=timeout");
    unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="blueprint-apply"]').trigger("click");
    await flush();

    expect(mounted.wrapper.get(".action-error").text()).toContain("回执");
    const lookup = mounted.wrapper.findAll("button").find((button) => button.text().includes("查询本次回执"));
    expect(lookup).toBeTruthy();
    await lookup?.trigger("click");
    await flush();
    expect(mounted.wrapper.text()).toContain("本次提交仍未确认");
  });

  it("加载失败与空项目给出可恢复状态", async () => {
    const failing = await mountWorkbench("/projects/project-hci?skill=blueprint&fixture=load-error");
    unmount = failing.unmount;
    expect(failing.wrapper.text()).toContain("暂时无法显示蓝图");
    expect(failing.wrapper.text()).toContain("示例数据暂时不可读取");
    failing.unmount();

    const empty = await mountWorkbench("/projects/empty?skill=blueprint");
    unmount = empty.unmount;
    expect(empty.wrapper.text()).toContain("尚未提供项目蓝图示例");
  });

  it("后续配置建议单独确认，不随蓝图应用", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?skill=blueprint");
    unmount = mounted.unmount;

    const ruleButton = mounted.wrapper.findAll("button").find((button) => button.text().includes("单独确认"));
    await ruleButton?.trigger("click");
    await flush();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("引用核对规则需要在规则入口单独确认");
    expect(dialog?.textContent).toContain("本轮交互预览未接入规则写入");
  });
});
