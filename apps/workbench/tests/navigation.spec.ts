import { describe, expect, it, afterEach } from "vitest";
import { setFixtureLatency } from "../src/fixtures/fixtureAdapter";
import { DomWrapper, dialogLabels, dialogText, flush, mountWorkbench, pressEscape } from "./mountApp";

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("局部导航与浮层行为", () => {
  it("默认项目首页可通过主导航进入协作并显示选中态", async () => {
    const mounted = await mountWorkbench("/");
    unmount = mounted.unmount;
    expect(mounted.router.currentRoute.value.path).toBe("/projects");

    const navigation = mounted.wrapper.get('nav[aria-label="主导航"]');
    const collaboration = navigation.get('a[href="/agent"]');
    expect(collaboration.text()).toBe("工作台");
    expect(collaboration.attributes("aria-current")).toBeUndefined();
    const link = collaboration.element as HTMLAnchorElement;
    expect(link.tabIndex).toBe(0);
    link.focus();
    expect(document.activeElement).toBe(link);

    await collaboration.trigger("click");
    await flush();
    expect(mounted.router.currentRoute.value.path).toBe("/agent");
    expect(mounted.wrapper.find('[data-testid="collab-fixture-gap"]').exists()).toBe(true);
    expect(collaboration.attributes("aria-current")).toBe("page");
    expect(link.classList.contains("navigation-item--active")).toBe(true);
    expect(navigation.get('a[href="/projects"]').attributes("aria-current")).toBeUndefined();
  });

  it("移动导航抽屉可进入协作，关闭后重开仍标记当前页", async () => {
    const mounted = await mountWorkbench("/projects");
    unmount = mounted.unmount;
    const trigger = mounted.wrapper.get('button[aria-label="打开导航"]');
    await trigger.trigger("click");
    await flush();

    const collaboration = new DomWrapper(document.querySelector('nav[aria-label="完整导航"]')).get('a[href="/agent"]');
    expect(collaboration.text()).toBe("工作台");
    expect(collaboration.attributes("aria-current")).toBeUndefined();
    const link = collaboration.element as HTMLAnchorElement;
    expect(link.tabIndex).toBe(0);
    link.focus();
    expect(document.activeElement).toBe(link);

    await collaboration.trigger("click");
    await flush();
    expect(mounted.router.currentRoute.value.path).toBe("/agent");
    expect(mounted.wrapper.find('[data-testid="collab-fixture-gap"]').exists()).toBe(true);
    expect(dialogLabels()).toHaveLength(0);

    await trigger.trigger("click");
    await flush();
    const navigation = new DomWrapper(document.querySelector('nav[aria-label="完整导航"]'));
    expect(navigation.get('a[href="/agent"]').attributes("aria-current")).toBe("page");
    expect(navigation.get('a[href="/projects"]').attributes("aria-current")).toBeUndefined();
  });

  it("直接链接与浏览器返回都能到达四个状态", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?skill=resume");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("从这里，接着往前。");

    await mounted.router.push("/tasks/task-evaluation-metrics?skill=verification");
    await flush();
    expect(mounted.wrapper.text()).toContain("把完成标准，变成可核对的依据。");

    await mounted.router.back();
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

  it("Today 示例入口明确标注非真实投影", async () => {
    const mounted = await mountWorkbench("/today");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("当前为示例数据预览，没有真实 Today 投影");
    expect(mounted.wrapper.text()).toContain("置顶、延后和今日焦点只表达你的安排");
  });

  it("/inbox 别名与顶栏快捷入口都进入原收件箱，主导航不增项", async () => {
    const mounted = await mountWorkbench("/inbox");
    unmount = mounted.unmount;
    await flush();
    expect(mounted.router.currentRoute.value.path).toBe("/tasks");
    expect(mounted.router.currentRoute.value.query.tab).toBe("inbox");
    expect(mounted.wrapper.get(".breadcrumbs").text()).toContain("收件箱");
    expect(mounted.wrapper.find('[data-testid="task-row-task-reading-notes"]').exists()).toBe(true);
    expect(mounted.wrapper.get('nav[aria-label="主导航"]').text()).not.toContain("收件箱");
    await mounted.router.push("/today");
    await mounted.wrapper.get('[data-testid="inbox-open"]').trigger("click");
    await flush();
    expect(mounted.router.currentRoute.value.path).toBe("/tasks");
    expect(mounted.router.currentRoute.value.query.tab).toBe("inbox");
  });
});
