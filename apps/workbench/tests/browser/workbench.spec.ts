import { expect, test } from "@playwright/test";

const blueprint = "/projects/project-hci?skill=blueprint";
const resume = "/projects/project-hci?skill=resume";
const definition = "/tasks/task-evaluation-metrics?skill=definition";
const verification = "/tasks/task-evaluation-metrics?skill=verification";

test.describe("桌面视口", () => {
  test.use({ viewport: { width: 1487, height: 1058 } });

  test("浏览器预览不显示桌面窗口控制", async ({ page }) => {
    await page.goto(blueprint);
    // 工作台 §17.4：浏览器显示前进/后退/搜索/新建这些业务入口，窗口控制只由桌面宿主提供。
    // 因此断言的是「没有窗口控制」，而不是「整条标题栏都不渲染」。
    await expect(page.locator(".desktop-titlebar__controls")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "关闭窗口" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "最小化" })).toHaveCount(0);
  });

  test("四个状态都渲染真实中文 DOM 且无整页横向滚动", async ({ page }) => {
    for (const path of [blueprint, resume, definition, verification]) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(1);
    }
  });

  test("右判断区在宽视口常驻，来源详情标题与对象一致", async ({ page }) => {
    await page.goto(resume);
    await expect(page.locator(".desktop-rail")).toBeVisible();
    await expect(page.locator(".rail-trigger")).toBeHidden();

    await page.getByRole("button", { name: /查看待审产物/ }).click();
    await expect(page.locator('[role="dialog"]')).toHaveAttribute("aria-label", "文献综述 v3");
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /查看待审产物/ })).toBeFocused();
  });

  test("切换局部页签与浏览器返回都可用", async ({ page }) => {
    await page.goto(blueprint);
    await page.getByRole("link", { name: "继续项目" }).click();
    await expect(page).toHaveURL(/skill=resume/);
    await expect(page.locator("h1")).toHaveText("从这里，接着往前。");

    await page.goBack();
    await expect(page).toHaveURL(/skill=blueprint/);
    await expect(page.locator("h1")).toHaveText("让目标，有一条清晰的路径");
  });

  test("路由与 query 子页切换后恢复页面顶部", async ({ page }) => {
    await page.goto(blueprint);
    await page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.style.height = "2000px";
      document.body.append(spacer);
      window.scrollTo(0, 600);
    });
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await page.getByRole("link", { name: "继续项目" }).click();
    await expect(page).toHaveURL(/skill=resume/u);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.evaluate(() => window.scrollTo(0, 600));
    await page.goBack();
    await expect(page).toHaveURL(/skill=blueprint/u);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  });

  test("禁用状态的原因对用户可见", async ({ page }) => {
    await page.goto(verification);
    await expect(page.getByTestId("verification-apply")).toBeDisabled();
    await expect(page.getByTestId("verification-apply-reason")).toContainText("执行方式尚未明确");
  });
});

test.describe("窄视口", () => {
  test.use({ viewport: { width: 960, height: 720 } });

  test("右区改为按钮打开，来源详情不叠加浮层", async ({ page }) => {
    await page.goto(resume);
    await expect(page.locator(".desktop-rail")).toBeHidden();

    await page.getByTestId("rail-trigger").click();
    await expect(page.locator('[role="dialog"]')).toHaveCount(1);

    await page.locator('[role="dialog"]').getByRole("button", { name: /项目状态 v4/ }).click();
    await expect(page.locator('[role="dialog"]')).toHaveCount(1);
    await expect(page.locator('[role="dialog"]')).toHaveAttribute("aria-label", "项目状态 v4");

    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  });

  test("主操作与导航不被裁切", async ({ page }) => {
    await page.goto(blueprint);
    await page.getByTestId("rail-trigger").click();
    const apply = page.locator('[role="dialog"]').getByTestId("blueprint-apply");
    await expect(apply).toBeVisible();
    const box = await apply.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(960);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe("小窗口", () => {
  test.use({ viewport: { width: 390, height: 720 } });

  test("左导航转为抽屉，主要内容单列可达", async ({ page }) => {
    await page.goto(blueprint);
    // 2026-10-02 共享壳拆成图标导航栏 + 近期工作栏两列，窄窗两列都收起，由抽屉承担。
    await expect(page.locator(".app-navrail")).toBeHidden();
    await expect(page.locator(".app-context-rail")).toBeHidden();
    await page.getByRole("button", { name: "打开导航" }).click();
    await expect(page.locator('[role="dialog"]')).toHaveAttribute("aria-label", "导航");
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test("未保存草稿切换页签会先询问，保留后仍可继续编辑", async ({ page }) => {
  await page.goto(blueprint);
  await page.getByTestId("blueprint-edit").click();
  await page.locator('input[name="blueprint-next-action"]').fill("浏览器里保留的草稿");
  await page.getByRole("link", { name: "继续项目" }).click();

  await expect(page.locator('[role="dialog"]')).toHaveAttribute("aria-label", "保留未保存的修改");
  await page.getByRole("button", { name: "保留并继续编辑" }).click();
  await expect(page).toHaveURL(/skill=blueprint/);
  await expect(page.locator('input[name="blueprint-next-action"]')).toHaveValue("浏览器里保留的草稿");
});

test("R02：创建页草稿会拦截侧栏和浏览器返回，明确放弃后才能离开", async ({ page }) => {
  await page.goto(tasks);
  await page.getByTestId("task-create-open").click();
  await page.locator('input[name="task-title"]').fill("浏览器草稿不能静默丢失");

  await page.getByRole("link", { name: "项目", exact: true }).click();
  await expect(page.locator('[role="dialog"]')).toHaveAttribute("aria-label", "保留未保存的修改");
  await page.getByRole("button", { name: "保留并继续编辑" }).click();
  await expect(page).toHaveURL(/\/tasks\?view=create/);
  await expect(page.locator('input[name="task-title"]')).toHaveValue("浏览器草稿不能静默丢失");

  await page.goBack();
  await expect(page.locator('[role="dialog"]')).toHaveAttribute("aria-label", "保留未保存的修改");
  await page.getByRole("button", { name: "丢弃草稿并离开" }).click();
  await expect(page).toHaveURL(/\/tasks$/);
});

for (const [name, zoom] of [["默认字号", "1"], ["放大字号与页面缩放", "1.5"]] as const) {
  test(`键盘可达：辅助链接在${name}下隐藏、显示并跳转焦点`, async ({ page }) => {
    await page.goto(definition);
    if (zoom !== "1") {
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "24px";
        document.body.style.zoom = "1.5";
      });
    }
    const link = page.locator(".skip-link");
    const hidden = await link.boundingBox();
    expect(hidden).not.toBeNull();
    expect((hidden?.y ?? 0) + (hidden?.height ?? 0)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => {
      const link = document.querySelector(".skip-link");
      const rect = link?.getBoundingClientRect();
      return link !== document.elementFromPoint((rect?.left ?? 0) + (rect?.width ?? 0) / 2, 1);
    })).toBe(true);

    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    const shown = await link.boundingBox();
    expect(shown).not.toBeNull();
    expect(shown?.y).toBeGreaterThanOrEqual(0);
    expect((shown?.y ?? 0) + (shown?.height ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.height ?? 0);

    const beforeSkipUrl = page.url();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();
    await expect(page).toHaveURL(beforeSkipUrl);
    const hiddenAgain = await link.boundingBox();
    expect((hiddenAgain?.y ?? 0) + (hiddenAgain?.height ?? 0)).toBeLessThanOrEqual(0);
  });
}

test("桌面标题栏偏移下的辅助链接不遮挡窗口控制", async ({ page }) => {
  await page.goto(definition);
  await page.evaluate(() => {
    const root = document.querySelector("#app > div");
    if (!root) throw new Error("App root missing");
    root.classList.add("desktop-window");
    const bar = document.createElement("div");
    bar.className = "desktop-titlebar";
    bar.innerHTML = '<div class="desktop-titlebar__drag"></div><div class="desktop-titlebar__controls"><span class="desktop-titlebar__button"></span><span class="desktop-titlebar__button"></span><span class="desktop-titlebar__button"></span></div>';
    root.prepend(bar);
  });
  await page.keyboard.press("Tab");
  const link = page.locator(".skip-link");
  await expect(link).toBeFocused();
  const linkBox = await link.boundingBox();
  // 本用例自己 prepend 了一条模拟标题栏，页面上因此有两条 .desktop-titlebar；量的是注入的那条。
  const barBox = await page.locator(".desktop-titlebar").first().boundingBox();
  const controlBox = await page.locator(".desktop-titlebar__controls").boundingBox();
  expect(linkBox).not.toBeNull();
  expect(barBox).not.toBeNull();
  expect(controlBox).not.toBeNull();
  expect(linkBox!.y).toBeGreaterThanOrEqual(barBox!.y + barBox!.height);
  expect(linkBox!.x + linkBox!.width).toBeLessThan(controlBox!.x);
});

const projects = "/projects";
const createProject = "/projects?view=create";
const tasks = "/tasks";
const createTask = "/tasks?view=create";
const projectTasks = "/projects/project-hci/tasks";

test.describe("项目与任务列表", () => {
  test.use({ viewport: { width: 1487, height: 1058 } });

  test("全局页使用工作空间面包屑，列表无整页横向滚动", async ({ page }) => {
    for (const path of [projects, createProject, tasks, createTask, projectTasks]) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(1);
    }

    await page.goto(tasks);
    await expect(page.locator(".breadcrumbs")).toContainText("工作空间");
    await expect(page.locator(".skill-tabs")).toHaveCount(0);
  });

  test("项目列表选择、归档与打开入口可用", async ({ page }) => {
    await page.goto(projects);
    // 2026-10-11 重设计：项目详情改为抽屉，宽屏不再有常驻右栏。
    await expect(page.locator(".projects-page .desktop-rail")).toHaveCount(0);

    await page.getByTestId("project-row-project-workflow-os").click();
    const drawer = page.getByRole("dialog", { name: "项目详情" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId("project-archive")).toBeDisabled();
    await expect(drawer.getByTestId("project-archive-reason")).toContainText("正在进行的执行");

    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await page.getByTestId("project-row-project-hci").click();
    await drawer.getByTestId("project-open").click();
    await expect(page).toHaveURL(/\/projects\/project-hci$/);
  });

  test("项目详情抽屉展示当前对象与状态，且不凭任务数量宣称完成", async ({ page }) => {
    await page.goto(projects);
    await page.getByTestId("project-row-project-knowledge").click();

    // 详情从常驻右栏改为「查看项目」打开的抽屉；对象、阶段与修订仍在同一决策区。
    const drawer = page.getByRole("dialog", { name: "项目详情" });
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".projects-detail__title")).toHaveText("个人知识整理");
    await expect(drawer).toContainText("建立可持续的个人知识体系");
    await expect(drawer).toContainText("状态修订 v2 · 待审 0 项");
    // 卡片本身已内联当前阶段与下一步，不打开抽屉也能定位当前工作。
    await expect(page.getByTestId("project-row-project-knowledge")).toContainText("当前阶段");
    await expect(page.getByTestId("project-row-project-knowledge")).toContainText("整理研究笔记");
  });

  test("创建项目：必填校验后就地报错，填写后进入列表", async ({ page }) => {
    await page.goto(createProject);
    await page.getByTestId("project-create-submit").click();
    await expect(page.locator('input[name="project-title"]')).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#project-title-error")).toBeVisible();

    await page.locator('input[name="project-title"]').fill("浏览器创建的项目");
    await page.locator('textarea[name="project-goal"]').fill("验证创建闭环。");
    await page.getByText("论文", { exact: true }).click();
    await page.getByTestId("project-create-submit").click();

    await expect(page).toHaveURL(/\/projects$/);
    // 创建回执自 2026-10-11 起就地显示在主列（原先在常驻右栏）。
    await expect(page.locator(".projects-page")).toContainText("本次演示已创建项目");
    await expect(page.getByText("浏览器创建的项目").first()).toBeVisible();
  });

  test("新建任务：ready 通过后不自动执行，依赖未完成时给出原因", async ({ page }) => {
    await page.goto(createTask);
    await page.locator('input[name="task-title"]').fill("浏览器创建的任务");
    await page.locator('input[name="task-expected-result"]').fill("一份结果。");
    await page.locator('textarea[name="task-acceptance"]').fill("标准一\n标准二");
    await page.getByTestId("task-create-save").click();
    await expect(page.getByText("已核对条件并标记为可开始")).toBeVisible();
    await expect(page.getByText("尚未开始执行；当前执行者未变")).toBeVisible();

    await page.goto(createTask);
    await page.locator('input[name="task-title"]').fill("依赖未完成的任务");
    await page.locator('input[name="task-expected-result"]').fill("一份结果。");
    await page.locator('textarea[name="task-acceptance"]').fill("标准一");
    await page.locator('select[name="task-project"]').selectOption("project-hci");
    await page.locator('select[name="task-dependency"]').selectOption("task-evaluation-metrics");
    await page.getByTestId("task-create-save").click();
    await expect(page.getByTestId("task-ready-blocked")).toContainText("尚未完成");
  });

  test("项目任务：项目内导航与依赖判断可用", async ({ page }) => {
    await page.goto(projectTasks);
    await expect(page.locator(".subnav-item--active")).toHaveText("任务");
    await expect(page.getByTestId("project-task-start")).toBeDisabled();
    await expect(page.getByTestId("project-task-start-reason")).toContainText("阻塞");

    await page.getByTestId("project-task-row-task-organize-material").click();
    await expect(page.getByTestId("project-task-start")).toBeEnabled();
    await page.getByTestId("project-task-start").click();
    await expect(page.getByText("开始不等于完成")).toBeVisible();
  });
});

test.describe("列表窄视口", () => {
  test.use({ viewport: { width: 960, height: 720 } });

  // 2026-10-15：本用例原先等一个 `.app-context-rail` 之外的项目页右栏触发键（`rail-trigger`），
  // 而 2026-10-11 项目页重设计已把常驻右栏整体移除、详情改为卡片自身打开的抽屉——
  // 那个键在 `/projects` 上根本不存在。断言随组件契约改为「卡片 → 抽屉」，并把
  // 「无 `rail-trigger`」写成显式事实，避免再次出现「元素不存在也算 hidden」的空断言。
  test("项目详情在窄视口由卡片打开抽屉且不超出窗口，任务列表无整页横向滚动", async ({ page }) => {
    await page.goto(projects);
    await expect(page.locator(".projects-page .desktop-rail")).toHaveCount(0);
    await expect(page.getByTestId("rail-trigger")).toHaveCount(0);

    await page.getByTestId("project-row-project-hci").click();
    const drawer = page.getByRole("dialog", { name: "项目详情" });
    await expect(drawer).toBeVisible();
    const open = drawer.getByTestId("project-open");
    await expect(open).toBeVisible();
    // 抽屉与它的主操作必须整体落在窄窗口内，不能被右缘切掉。
    const box = await open.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(960);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);

    await page.goto(tasks);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("task-create-open")).toBeVisible();
  });
});

test.describe("200% 内容缩放", () => {
  test.use({ viewport: { width: 960, height: 720 } });

  test("Chromium 内容缩放为 200% 时当前对象与主操作仍可达", async ({ page }) => {
    await page.goto(projects);

    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    await expect
      .poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1))
      .toBe(2);

    // 2026-10-11 起详情抽屉由卡片自身打开：缩放下仍要能用键盘聚焦卡片并进入确切对象。
    const card = page.getByTestId("project-row-project-knowledge");
    await card.scrollIntoViewIfNeeded();
    const cardOpen = card.getByTestId("project-card-open-project-knowledge");
    await cardOpen.focus();
    await expect(cardOpen).toBeFocused();
    await page.keyboard.press("Enter");

    const open = page.locator('[role="dialog"]').getByTestId("project-open");
    await open.scrollIntoViewIfNeeded();
    await open.focus();
    await expect(open).toBeFocused();
    await expect(open).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/projects\/project-knowledge$/);
  });
});

test.describe("200% 内容缩放等效视口", () => {
  test.use({ viewport: { width: 480, height: 360 } });

  test("项目详情在窄宽度下可打开、滚动到达并关闭", async ({ page }) => {
    await page.goto(projects);
    // 宽屏不再有常驻右栏，窄窗也不再需要单独的触发按钮：详情统一由卡片打开。
    await expect(page.locator(".projects-page .desktop-rail")).toHaveCount(0);
    await expect(page.locator(".projects-page .rail-trigger")).toHaveCount(0);

    const card = page.getByTestId("project-row-project-knowledge");
    await card.scrollIntoViewIfNeeded();
    await card.click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toHaveAttribute("aria-label", "项目详情");
    await expect(dialog.locator(".projects-detail__title")).toHaveText("个人知识整理");
    await expect(dialog).toContainText("状态修订 v2 · 待审 0 项");

    const open = dialog.getByTestId("project-open");
    await open.scrollIntoViewIfNeeded();
    await expect(open).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
});
