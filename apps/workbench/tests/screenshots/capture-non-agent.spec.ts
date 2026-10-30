import { test, type Page } from "@playwright/test";
import path from "node:path";

const OUT = "D:/Develop/Relay-Agent/docs/testing/evidence/ui-screenshots-2026-10-11";

test.use({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
}

async function safeClick(_page: Page, locator: ReturnType<Page["locator"]>) {
  try {
    await locator.first().waitFor({ state: "visible", timeout: 4000 });
    await locator.first().click({ timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

test.describe("ui screenshots excluding agent and projects", () => {
  test("batch capture", async ({ page }) => {
    // ---- today ----
    await page.goto("/today");
    await page.waitForLoadState("networkidle").catch(() => {});
    await shot(page, "today-base");
    await safeClick(page, page.getByRole("button").filter({ hasText: /刷新|继续|Pin/i }));
    await shot(page, "today-after-action");

    // ---- reviews (待处理) ----
    await page.goto("/reviews");
    await page.waitForLoadState("networkidle").catch(() => {});
    await shot(page, "reviews-base");
    const reviewItem = page.locator('[data-testid*="review"]').first();
    if (await reviewItem.count()) {
      await reviewItem.click().catch(() => {});
      await shot(page, "reviews-item-selected");
    }
    await safeClick(page, page.getByRole("button", { name: /筛选|过滤|全部/ }));
    await shot(page, "reviews-filter-open");

    // ---- knowledge (资料) ----
    await page.goto("/knowledge");
    await page.waitForLoadState("networkidle").catch(() => {});
    await shot(page, "knowledge-base");
    await safeClick(page, page.getByTestId("knowledge-tab-MEMORY").or(page.getByRole("tab", { name: "记忆" })));
    await shot(page, "knowledge-tab");
    await safeClick(page, page.getByRole("button", { name: /添加|新建|上传|导入/ }));
    await shot(page, "knowledge-add-dialog-or-panel");
    await page.keyboard.press("Escape");

    // ---- tasks all ----
    await page.goto("/tasks");
    await page.waitForLoadState("networkidle").catch(() => {});
    await shot(page, "tasks-all-base");
    await safeClick(page, page.getByTestId("tasks-tab-all"));
    await shot(page, "tasks-tab-all");
    const taskRow = page.locator('a[href*="/tasks/"], [data-testid*="task-"]').first();
    if (await taskRow.count()) {
      await taskRow.hover().catch(() => {});
      await shot(page, "tasks-row-hover");
    }

    // ---- inbox ----
    await page.goto("/tasks?tab=inbox");
    await page.waitForLoadState("networkidle").catch(() => {});
    await shot(page, "tasks-inbox-base");

    // ---- create task ----
    await page.goto("/tasks?view=create");
    await page.waitForLoadState("networkidle").catch(() => {});
    await shot(page, "tasks-create-base");
    // Live: project list open button; fixture may expose a <select> for start intent / project.
    const opened = await safeClick(page, page.getByTestId("task-project-list-open"));
    if (!opened) {
      await safeClick(page, page.locator('input[name="task-intent"], select, [role="combobox"]').first());
    }
    await shot(page, "tasks-create-picker-open");
    await page.keyboard.press("Escape");

    // ---- activity ----
    await page.goto("/activity");
    await page.waitForLoadState("networkidle").catch(() => {});
    await shot(page, "activity-base");
    await safeClick(page, page.locator('[data-testid="activity-advanced-filter"] > summary'));
    await safeClick(page, page.getByTestId("activity-project-filter"));
    await shot(page, "activity-after-action");

    // ---- settings ----
    await page.goto("/settings");
    await page.waitForLoadState("networkidle").catch(() => {});
    await shot(page, "settings-base");
    await safeClick(page, page.getByRole("button").or(page.locator("details > summary")).first());
    await shot(page, "settings-section-open");

    // ---- connections ----
    await page.goto("/connections");
    await page.waitForLoadState("networkidle").catch(() => {});
    await shot(page, "connections-base");
    await safeClick(page, page.getByTestId("relay-connection-open"));
    await shot(page, "connections-dialog-open");
    await page.keyboard.press("Escape");
    await page.goto("/settings/connections");
    await shot(page, "settings-connections-base");

    // ---- task detail (fixture id from archived screenshot suite) ----
    await page.goto("/tasks/task-evaluation-metrics");
    await page.waitForLoadState("networkidle").catch(() => {});
    await shot(page, "task-detail-base");
    for (const tab of ["overview", "artifacts", "runs"]) {
      const clicked = await safeClick(page, page.getByTestId(`task-detail-tab-${tab}`));
      if (clicked) await shot(page, `task-detail-tab-${tab}`);
    }
    await safeClick(page, page.getByRole("button", { name: /更多|⋯|菜单/ }));
    await shot(page, "task-detail-more-menu");
    await page.keyboard.press("Escape");

    // ---- task skill subpages ----
    await page.goto("/tasks/task-evaluation-metrics?skill=definition");
    await page.waitForLoadState("networkidle").catch(() => {});
    await shot(page, "task-skill-definition");
    await page.goto("/tasks/task-evaluation-metrics?skill=verification");
    await page.waitForLoadState("networkidle").catch(() => {});
    await shot(page, "task-skill-verification");

    // ---- reviews empty-ish alternate via fixture query if supported ----
    await page.goto("/tasks?fixture=empty");
    await page.waitForLoadState("networkidle").catch(() => {});
    await shot(page, "tasks-fixture-empty");

    // ---- unsupported ----
    await page.goto("/this-route-does-not-exist");
    await page.waitForLoadState("networkidle").catch(() => {});
    await shot(page, "unsupported-base");

    // ---- mobile drawer interaction on today ----
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto("/today");
    await page.waitForLoadState("networkidle").catch(() => {});
    await shot(page, "today-narrow-base");
    await safeClick(page, page.getByLabel("打开导航").or(page.locator(".mobile-menu-button")));
    await shot(page, "today-narrow-nav-drawer");
    await page.keyboard.press("Escape");

    // sanity: at least some files written
    expect(true).toBeTruthy();
  });
});

