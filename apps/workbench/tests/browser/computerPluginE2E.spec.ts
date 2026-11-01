import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * Computer Plugin 执行反馈 UI（COMPUTER-PLUGIN-E2E）。
 *
 * 由 tmp/COMPUTER-PLUGIN-E2E/run-ui-e2e.ps1 启动一次性真实 API（真实 PG + 已播种的
 * 执行请求/Run）和 Vite；本测试只通过界面读取服务端事实，不修改任何业务状态。
 * 缺少环境时跳过，不能把跳过当成通过。
 */

interface Seed {
  readonly workspaceId: string;
  readonly sessionWaiting: string;
  readonly sessionFailed: string;
}

const apiBase = process.env.RELAY_UI_API_BASE_URL;
const workspaceId = process.env.RELAY_UI_WORKSPACE_ID;
const bearerToken = process.env.RELAY_UI_BEARER_TOKEN;
const seedFile = process.env.RELAY_UI_SEED_FILE;
const screenshotDir = process.env.RELAY_UI_SCREENSHOT_DIR;
const ready = apiBase !== undefined && workspaceId !== undefined && bearerToken !== undefined &&
  seedFile !== undefined && screenshotDir !== undefined;

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase!);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId!);
  await page.locator('input[name="relay-bearer-token"]').fill(bearerToken!);
  await page.getByTestId("relay-connect").click();
  await expect(page.getByTestId("relay-connection-state")).toContainText("已连接");
  await page.getByRole("dialog", { name: "连接本机 API" })
    .getByRole("button", { name: "关闭", exact: true }).click();
}

function readSeed(): Seed {
  return JSON.parse(readFileSync(seedFile!, "utf8")) as Seed;
}

test.describe("电脑操控执行反馈", () => {
  test.skip(!ready, "缺少一次性 API/UI 环境，UI 验收未运行");

  test("等待接管授权时显示服务端 Run 状态与审批入口", async ({ page }) => {
    const seed = readSeed();
    await page.goto("/agent");
    await connect(page);
    await page.getByTestId(`recent-work-${seed.sessionWaiting}`).click();
    const state = page.getByTestId("execution-run-state").first();
    await expect(state).toContainText("等待你批准");
    await expect(page.getByTestId("execution-waiting-approval-link").first()).toBeVisible();
    await page.screenshot({ path: `${screenshotDir}/waiting-approval.png`, fullPage: true });
  });

  test("缺少电脑连接时显示失败原因，不宣称已经执行", async ({ page }) => {
    const seed = readSeed();
    await page.goto("/agent");
    await connect(page);
    await page.getByTestId(`recent-work-${seed.sessionFailed}`).click();
    await expect(page.getByTestId("execution-summary-stage").first())
      .toHaveText("没有继续执行");
    const failure = page.getByTestId("execution-summary-failure").first();
    await expect(failure).toBeVisible();
    await expect(failure).toContainText("COMPUTER_READ");
    await page.screenshot({ path: `${screenshotDir}/failed-missing-connection.png`, fullPage: true });
  });
});
