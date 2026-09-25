import { expect, test, type Page } from "@playwright/test";

const apiBase = process.env.RELAY_M02_API_BASE_URL;
const workspaceId = process.env.RELAY_M02_WORKSPACE_ID;
const bearerToken = process.env.RELAY_M02_BEARER_TOKEN;

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase!);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId!);
  await page.locator('input[name="relay-bearer-token"]').fill(bearerToken!);
  await page.getByTestId("relay-connect").click();
  await expect(page.getByTestId("relay-connection-state")).toContainText("已连接");
  await page.getByRole("dialog", { name: "连接本机 API" }).getByRole("button", { name: "关闭", exact: true }).click();
}

test("真实 API 人工闭环：创建项目与任务、启动、版本、当前选用、完成、重开", async ({ page }) => {
  if (!apiBase || !workspaceId || !bearerToken) throw new Error("Run with scripts/run-real-api-browser.ps1");
  await page.goto("/projects");
  await connect(page);

  await page.getByTestId("project-create-open").click();
  await page.locator('input[name="project-title"]').fill("M02 浏览器人工闭环项目");
  await page.locator('input[name="project-type"][value="GENERAL"]').check({ force: true });
  await page.getByTestId("project-create-submit").click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/tasks$/u);
  const projectId = /\/projects\/([0-9a-f-]{36})\/tasks$/u.exec(new URL(page.url()).pathname)?.[1];
  expect(projectId).toBeTruthy();

  await page.getByRole("link", { name: "新建任务" }).click();
  await page.locator('input[name="task-title"]').fill("M02 真实人工任务");
  await page.locator('input[name="task-expected-result"]').fill("可核对的 Markdown 产物");
  await page.locator('textarea[name="task-acceptance"]').fill("产物包含自检结论");
  await page.getByTestId("task-create-save").click();
  await expect(page.getByTestId("task-created-result")).toContainText("任务已创建");
  const taskId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u.exec(await page.getByTestId("task-created-result").innerText())?.[0];
  expect(taskId).toBeTruthy();

  await page.getByRole("button", { name: "返回任务入口" }).click();
  await page.locator(".app-sidebar").getByRole("link", { name: "项目" }).click();
  await page.locator('input[name="live-project-id"]').fill(projectId!);
  await page.getByTestId("projects-live-open").click();
  await expect(page.getByTestId("project-task-start")).toBeEnabled();
  await page.getByTestId("project-task-start").click();
  await expect(page.getByText("已开始：", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: "打开任务详情" }).click();
  await expect(page.getByTestId("task-detail")).toContainText("M02 真实人工任务");

  await page.getByTestId("task-detail-tab-artifacts").click();
  await page.locator('textarea[name="artifact-content"]').fill("# 真实自检\n\n产物包含自检结论。");
  await page.getByTestId("artifact-save").click();
  await expect(page.getByTestId("artifact-save-receipt")).toContainText("v1");
  await page.reload();
  await connect(page);
  await page.getByTestId("task-detail-tab-artifacts").click();
  await expect(page.locator('input[name="artifact-version"]')).toHaveCount(1);
  await page.locator('textarea[name="artifact-content"]').fill("# 第二版\n\n刷新后仍续写同一个产物。");
  await page.getByTestId("artifact-save").click();
  await expect(page.getByTestId("artifact-save-receipt")).toContainText("v2");
  const artifactResponse = await page.request.get(`${apiBase}/api/v1/workspaces/${workspaceId}/tasks/${taskId}/artifacts`, {
    headers: { authorization: `Bearer ${bearerToken}` }
  });
  expect(artifactResponse.ok()).toBe(true);
  const artifactHistory = await artifactResponse.json() as {
    items: { version_count: number; versions: { artifact_version_id: string }[] }[];
    current_accepted_version_ids: string[];
  };
  expect(artifactHistory.items).toHaveLength(1);
  expect(artifactHistory.items[0]?.version_count).toBe(2);
  expect(artifactHistory.current_accepted_version_ids).toEqual([]);
  const firstVersionId = artifactHistory.items[0]!.versions[0]!.artifact_version_id;
  const secondVersionId = artifactHistory.items[0]!.versions[1]!.artifact_version_id;
  await page.reload();
  await connect(page);
  await page.getByTestId("task-detail-tab-artifacts").click();
  await expect(page.getByTestId(`artifact-version-${firstVersionId}`)).toBeVisible();
  await expect(page.getByTestId(`artifact-version-${secondVersionId}`)).toBeVisible();
  await expect(page.locator('input[name="artifact-version"]:checked')).toHaveCount(0);
  await page.getByTestId(`artifact-version-${secondVersionId}`).check();
  await page.getByTestId("artifact-select-version").click();
  await expect(page.getByText("项目 State 已选用", { exact: false })).toBeVisible();
  await page.getByTestId(`artifact-version-${firstVersionId}`).check();
  await page.locator('[data-testid^="criterion-"]').first().check();
  await page.getByTestId("task-complete").click();
  await expect(page.getByTestId("task-complete-receipt")).toContainText("已完成本轮");
  await page.reload();
  await connect(page);
  await page.getByTestId("task-detail-tab-artifacts").click();
  await expect(page.getByTestId(`artifact-version-${firstVersionId}`).locator("xpath=ancestor::li")).toContainText("本轮接受");
  await expect(page.getByTestId(`artifact-version-${secondVersionId}`).locator("xpath=ancestor::li")).toContainText("当前选用");
  await expect(page.getByTestId(`artifact-version-${secondVersionId}`).locator("xpath=ancestor::li")).not.toContainText("本轮接受");
  await page.locator('input[name="reopen-reason"]').fill("核对新一轮验收");
  await page.getByTestId("task-reopen-submit").click();
  await expect(page.getByTestId("task-reopen-receipt")).toContainText("已重开");
  await page.reload();
  await connect(page);
  await page.getByTestId("task-detail-tab-artifacts").click();
  await expect(page.getByTestId(`artifact-version-${firstVersionId}`).locator("xpath=ancestor::li")).not.toContainText("本轮接受");
  console.log("real API browser human path: refresh preserves artifact history and separates selected/accepted pointers PASSED");
});
