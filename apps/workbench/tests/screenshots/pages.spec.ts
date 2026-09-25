import { test } from "@playwright/test";

const pages = [
  {
    name: "ui-05-projects",
    path: "/projects",
    ready: '[data-testid="projects-tab-active"]'
  },
  {
    name: "ui-06-create-project",
    path: "/projects?view=create",
    ready: '[data-testid="project-create-submit"]'
  },
  {
    name: "ui-07-tasks",
    path: "/tasks",
    ready: '[data-testid="tasks-tab-all"]'
  },
  {
    name: "ui-09-project-tasks",
    path: "/projects/project-hci/tasks",
    ready: '[data-testid="project-task-start"]'
  },
  {
    name: "ui-29-create-task",
    path: "/tasks?view=create",
    ready: '[data-testid="task-create-save"]'
  },
  {
    name: "ui-30-project-blueprint",
    path: "/projects/project-hci?skill=blueprint",
    ready: '[data-testid="blueprint-apply"]'
  },
  {
    name: "ui-31-task-definition",
    path: "/tasks/task-evaluation-metrics?skill=definition",
    ready: '[data-testid="definition-accept"]'
  },
  {
    name: "ui-32-verification-plan",
    path: "/tasks/task-evaluation-metrics?skill=verification",
    ready: '[data-testid="verification-apply"]'
  },
  {
    name: "ui-33-project-resume",
    path: "/projects/project-hci?skill=resume",
    ready: 'button:has-text("刷新摘要")'
  }
];

test.use({ viewport: { width: 1487, height: 1058 }, deviceScaleFactor: 1 });

for (const item of pages) {
  test(`截图 ${item.name}`, async ({ page }) => {
    await page.goto(item.path);
    await page.locator(item.ready).first().waitFor();
    await page.screenshot({ path: `artifacts/screenshots/${item.name}.png` });
  });
}

for (const item of [
  { name: "ui-10-task-overview", tab: "overview" },
  { name: "ui-11-task-artifacts", tab: "artifacts" },
  { name: "ui-10-task-runs", tab: "runs" }
]) {
  test(`截图 ${item.name}`, async ({ page }) => {
    await page.goto("/tasks/task-evaluation-metrics");
    await page.getByTestId("task-detail").waitFor();
    await page.getByTestId(`task-detail-tab-${item.tab}`).click();
    await page.screenshot({ path: `artifacts/screenshots/${item.name}.png` });
  });
}

for (const item of [
  { name: "reviews-fixture", path: "/reviews", ready: "review-inbox" },
  { name: "knowledge-fixture", path: "/knowledge", ready: "knowledge-fixture-gap" },
  { name: "project-knowledge-fixture", path: "/projects/project-hci/knowledge", ready: "knowledge-fixture-gap" }
]) {
  test(`截图 ${item.name}`, async ({ page }) => {
    await page.goto(item.path);
    await page.getByTestId(item.ready).waitFor();
    await page.screenshot({ path: `artifacts/screenshots/${item.name}.png` });
  });
}
