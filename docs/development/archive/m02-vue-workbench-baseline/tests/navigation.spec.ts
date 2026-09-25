import { describe, expect, it, afterEach } from "vitest";
import { setFixtureLatency } from "../src/fixtures/fixtureAdapter";
import { dialogLabels, dialogText, flush, mountWorkbench, pressEscape } from "./mountApp";

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("局部导航与浮层行为", () => {
  it("直接链接与浏览器返回都能到达四个状态", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?skill=resume");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("从这里，接着往前。");

    await mounted.router.push("/tasks/task-evaluation-metrics?skill=verification");
    await flush();
    expect(mounted.wrapper.text()).toContain("把完成标准，变成可核对的依据。");

    mounted.router.back();
    await flush();
    expect(mounted.wrapper.text()).toContain("从这里，接着往前。");
  });

  it("切换局部页签时保留未保存草稿", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?skill=blueprint");
    unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="blueprint-edit"]').trigger("click");
    await mounted.wrapper.get('input[name="blueprint-next-action"]').setValue("草稿不应静默丢失");
    const resumeTab = mounted.wrapper.findAll("a.skill-tab").find((tab) => tab.text().includes("继续项目"));
    await resumeTab?.trigger("click");
    await flush();

    expect(dialogLabels()).toContain("保留未保存的修改");

    const keep = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("保留并继续编辑")
    );
    keep?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    expect(mounted.router.currentRoute.value.query.skill).toBe("blueprint");
    expect((mounted.wrapper.get('input[name="blueprint-next-action"]').element as HTMLInputElement).value).toBe(
      "草稿不应静默丢失"
    );
  });

  it("丢弃草稿后完成页签切换", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?skill=blueprint");
    unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="blueprint-edit"]').trigger("click");
    await mounted.wrapper.get('input[name="blueprint-next-action"]').setValue("丢弃后不保留");
    const resumeTab = mounted.wrapper.findAll("a.skill-tab").find((tab) => tab.text().includes("继续项目"));
    await resumeTab?.trigger("click");
    await flush();

    const discard = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("丢弃草稿并离开")
    );
    discard?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush(80);

    expect(mounted.router.currentRoute.value.query.skill).toBe("resume");
    expect(mounted.wrapper.text()).toContain("从这里，接着往前。");
  });

  it("迟到响应不污染新的目标页面", async () => {
    setFixtureLatency(60);
    const mounted = await mountWorkbench("/projects/project-hci?skill=blueprint");
    unmount = mounted.unmount;

    await mounted.router.push("/projects/empty?skill=blueprint");
    await flush(200);

    expect(mounted.wrapper.text()).toContain("尚未提供项目蓝图示例");
    expect(mounted.wrapper.text()).not.toContain("让目标，有一条清晰的路径");
  });

  it("来源详情浮层支持 Esc 关闭并回落焦点", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?skill=resume");
    unmount = mounted.unmount;

    const trigger = mounted.wrapper.findAll("button").find((button) => button.text().includes("查看待审产物"));
    (trigger?.element as HTMLElement).focus();
    await trigger?.trigger("click");
    await flush();
    expect(dialogLabels()).toContain("文献综述 v3");

    pressEscape();
    await flush();

    expect(dialogLabels()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger?.element);
  });

  it("从右区抽屉打开来源详情时不会叠加两个对话框", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?skill=resume");
    unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="rail-trigger"]').trigger("click");
    await flush();
    expect(dialogLabels()).toContain("找回项目上下文");

    const dialog = document.querySelector('[role="dialog"]');
    const sourceButton = Array.from(dialog?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("项目状态 v4")
    );
    sourceButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    expect(dialogLabels()).toEqual(["项目状态 v4"]);
    expect(dialogText()).toContain("当前项目为人工可继续整理的研究工作");
  });

  it("范围外入口诚实提示未接入", async () => {
    const mounted = await mountWorkbench("/today");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("此入口尚未接入交互预览");
    expect(mounted.wrapper.text()).toContain("不会伪造空白页面");
  });
});
