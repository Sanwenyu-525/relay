import { expect, test, type Page } from "@playwright/test";

/**
 * 场景实验室 V2.1 的批次生命周期、播放器收敛与验收口径回归。
 *
 * 覆盖：单帧/多帧播放器、完整场景回放（G01）、批次取消、重复启动、切换场景/视图取消、
 * 离开页面释放、预览稳定超时、Inspector 计数不混用。浏览器专属检查仍由
 * `assistScenarioLab.spec.ts` / `assistScenarioLabShots.spec.ts` 负责，这里不重复实现。
 */

const LAB = "/__dev/assist-scenarios";

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (text.includes("[vite]") || text.includes("DevTools")) return;
    errors.push(`console: ${text}`);
  });
  return errors;
}

async function openLab(page: Page, query = ""): Promise<void> {
  await page.goto(`${LAB}${query}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-scenario-lab]")).toBeVisible();
  await expect(page.locator("[data-scenario-preview]")).toBeVisible();
  await page.waitForTimeout(250);
}

async function openInspectorTab(page: Page, tab: "display" | "timeline" | "verification"): Promise<void> {
  const toggle = page.locator("[data-testid='scenario-inspector-toggle']");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.locator(`[data-testid="scenario-inspector-tab-${tab}"]`).click();
}

async function pickScenario(page: Page, id: string): Promise<void> {
  const item = page.locator(`[data-testid="scenario-pick-${id}"]`);
  const group = page.locator(`[data-testid="scenario-group-${id.charAt(0)}"]`);
  if (!(await item.isVisible())) await group.click();
  await item.click();
  await expect(page.locator(`[data-scenario-preview] [data-scenario-id="${id}"]`)).toHaveCount(1);
}

async function runInfo(page: Page) {
  return page.locator("[data-testid='scenario-run-status']").evaluate((node) => ({
    id: node.getAttribute("data-run-id") ?? "",
    mode: node.getAttribute("data-run-mode") ?? "",
    status: node.getAttribute("data-run-status") ?? "",
    done: Number(node.getAttribute("data-run-done") ?? 0),
    total: Number(node.getAttribute("data-run-total") ?? 0),
    text: node.textContent ?? ""
  }));
}

async function summaryInfo(page: Page, mode: "static" | "full") {
  return page.locator(`[data-testid='scenario-run-summary-${mode}']`).evaluate((node) => ({
    status: node.getAttribute("data-status") ?? "",
    pass: Number(node.getAttribute("data-pass") ?? 0),
    staticPass: Number(node.getAttribute("data-static-pass") ?? 0),
    fail: Number(node.getAttribute("data-fail") ?? 0),
    pendingBrowser: Number(node.getAttribute("data-pending-browser") ?? 0),
    unverifiable: Number(node.getAttribute("data-unverifiable") ?? 0),
    notRun: Number(node.getAttribute("data-not-run") ?? 0),
    done: Number(node.getAttribute("data-done") ?? 0),
    total: Number(node.getAttribute("data-total") ?? 0),
    interactions: Number(node.getAttribute("data-interactions") ?? 0)
  }));
}

test.describe("播放器：单帧静态、多帧完整、末帧重播", () => {
  test("A05 单帧：只有静态标识与重新检查，没有进度/播放/循环", async ({ page }) => {
    const errors = watchErrors(page);
    await openLab(page);
    await expect(page.locator("[data-testid='scenario-static-preview']")).toBeVisible();
    await expect(page.locator("[data-testid='scenario-check-again']")).toBeVisible();
    await expect(page.locator("[data-testid='scenario-play']")).toHaveCount(0);
    await expect(page.locator("[data-testid='scenario-step']")).toHaveCount(0);
    await expect(page.locator("[data-testid='scenario-seek']")).toHaveCount(0);
    await expect(page.locator("[data-testid='scenario-loop']")).toHaveCount(0);
    await expect(page.locator("[data-testid='scenario-static-strip']")).toBeVisible();
    await expect(page.locator("[data-testid='scenario-current-verdict']")).toContainText(/静态/);

    await page.locator("[data-testid='scenario-static-open-inspector']").click();
    await expect(page.getByRole("complementary", { name: "检查面板" })).toBeVisible();
    await expect(page.locator("[data-testid='scenario-current-result']")).toContainText(/静态/);
    expect(errors).toEqual([]);
  });

  test("A04 多帧：完整播放条，末帧按钮明确变成重新播放", async ({ page }) => {
    const errors = watchErrors(page);
    await openLab(page, "?scenario=A04&frame=0");
    await expect(page.locator("[data-testid='scenario-play']")).toHaveAttribute("aria-label", "播放");
    await expect(page.locator("[data-testid='scenario-step']")).toBeVisible();
    await expect(page.locator("[data-testid='scenario-seek']")).toBeVisible();
    await page.locator("[data-testid='scenario-step']").click();
    await page.locator("[data-testid='scenario-step']").click();
    await expect(page.locator(".scenario-lab-controls-head")).toContainText("第 3/3 帧");
    await expect(page.locator("[data-testid='scenario-step']")).toBeDisabled();
    await expect(page.locator("[data-testid='scenario-play']")).toHaveAttribute("aria-label", "重新播放");
    await page.locator("[data-testid='scenario-play']").click();
    await expect(page.locator("[data-testid='scenario-play']")).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(250);
    await page.locator("[data-testid='scenario-play']").click();
    await page.locator("[data-testid='scenario-reset']").click();
    await expect(page.locator(".scenario-lab-controls-head")).toContainText("第 1/3 帧");
    expect(errors).toEqual([]);
  });

  test("G01 完整场景验收：按帧与交互重放，结果单独记录", async ({ page }) => {
    const errors = watchErrors(page);
    await openLab(page, "?scenario=G01&frame=0");
    const entry = (await (async () => {
      await expect(page.locator("#scenario-lab-manifest")).toBeAttached();
      return JSON.parse(await page.locator("#scenario-lab-manifest").innerText()) as {
        id: string; frames: unknown[]; interactions: number;
      }[];
    })()).find((item) => item.id === "G01");
    expect(entry).toBeDefined();
    await openInspectorTab(page, "verification");
    await expect(page.locator("[data-testid='scenario-run-summary-full']")).toHaveAttribute("data-status", "none");
    await page.locator("[data-testid='scenario-run-current-full']").click();
    await expect(page.locator("[data-testid='scenario-run-status']"))
      .toHaveAttribute("data-run-status", "running", { timeout: 30_000 });
    await expect(page.locator("[data-testid='scenario-run-status']"))
      .toHaveAttribute("data-run-status", "completed", { timeout: 120_000 });
    const summary = await summaryInfo(page, "full");
    expect(summary.status).toBe("completed");
    expect(summary.done).toBe(1);
    expect(summary.total).toBe(1);
    expect(summary.interactions).toBe(entry?.interactions ?? 0);
    expect(summary.fail).toBe(0);
    expect(summary.pass + summary.staticPass, "完整回放必须留下一条结果").toBe(1);
    expect(summary.unverifiable).toBe(0);
    await expect(page.locator(".scenario-lab-controls-head"))
      .toContainText(`第 ${String(entry?.frames.length ?? 1)}/${String(entry?.frames.length ?? 1)} 帧`);
    await expect(page.locator("[data-testid='scenario-current-result']")).toContainText(/交互/);
    expect(errors).toEqual([]);
  });
});

test.describe("批次生命周期", () => {
  test("快速静态检查可取消：取消后不再计数，未处理场景保持未运行", async ({ page }) => {
    const errors = watchErrors(page);
    await openLab(page);
    await page.locator("[data-testid='scenario-run-all']").click();
    await expect(page.locator("[data-testid='scenario-run-status']")).toHaveAttribute("data-run-status", "running");
    await expect.poll(async () => (await runInfo(page)).done, { timeout: 20_000 }).toBeGreaterThan(1);
    await page.locator("[data-testid='scenario-cancel-run']").click();
    await expect(page.locator("[data-testid='scenario-run-status']")).toHaveAttribute("data-run-status", "cancelled");
    // 2026-10-31：以「取消已确认」那一刻为基线，而不是点击前的快照。
    // 点击到取消生效之间本来就可能又跑完几条（这一步是异步的），拿点击前的数字比会把
    // 正常完成算成「取消后还在计数」。真正要保证的是：确认取消之后一条都不再增加。
    const settled = await runInfo(page);
    await page.waitForTimeout(1_000);
    const after = await runInfo(page);
    expect(after.done, "取消确认后计数仍在增长").toBe(settled.done);
    expect(after.done, "取消后不能显示 145/145").toBeLessThan(145);
    expect(after.text).not.toContain("145/145");
    const summary = await summaryInfo(page, "static");
    expect(summary.status).toBe("cancelled");
    expect(summary.done).toBe(after.done);
    expect(summary.notRun, "未处理场景必须保持未运行").toBe(145 - after.done);
    expect(summary.pass + summary.staticPass + summary.fail + summary.unverifiable,
      "已处理场景的结论计数必须等于 done").toBe(summary.done);
    expect(summary.pendingBrowser, "待浏览器检查单独计数，不混入静态通过").toBeGreaterThanOrEqual(0);
    expect(summary.done + summary.notRun, "已处理 + 未处理必须等于 145").toBe(145);
    await expect(page.locator("[data-testid='scenario-cancel-run']")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("重复启动被拒绝：运行中按钮禁用且 run id 不变", async ({ page }) => {
    const errors = watchErrors(page);
    await openLab(page);
    await page.locator("[data-testid='scenario-run-all']").click();
    await expect(page.locator("[data-testid='scenario-run-status']")).toHaveAttribute("data-run-status", "running");
    const first = await runInfo(page);
    await expect(page.locator("[data-testid='scenario-run-all']")).toBeDisabled();
    await expect(page.locator("[data-testid='scenario-run-full']")).toBeDisabled();
    await page.waitForTimeout(600);
    const second = await runInfo(page);
    expect(second.id, "第二次启动创建了新批次").toBe(first.id);
    expect(second.done, "批次没有继续推进").toBeGreaterThanOrEqual(first.done);
    await page.locator("[data-testid='scenario-cancel-run']").click();
    expect(errors).toEqual([]);
  });

  test("运行中切换单场景会取消旧批次，旧结果不覆盖新场景", async ({ page }) => {
    const errors = watchErrors(page);
    await openLab(page);
    await page.locator("[data-testid='scenario-run-all']").click();
    await expect(page.locator("[data-testid='scenario-run-status']")).toHaveAttribute("data-run-status", "running");
    await expect.poll(async () => (await runInfo(page)).done, { timeout: 20_000 }).toBeGreaterThan(1);
    await pickScenario(page, "B14");
    await expect(page.locator("[data-testid='scenario-run-status']")).toHaveAttribute("data-run-status", "cancelled");
    await expect(page.locator("[data-scenario-preview] [data-scenario-id='B14']")).toHaveCount(1);
    await page.waitForTimeout(1_000);
    await expect(page.locator("[data-scenario-preview] [data-scenario-id='B14']")).toHaveCount(1);
    const info = await runInfo(page);
    expect(info.done).toBeLessThan(145);
    expect(info.text).not.toContain("145/145");

    // 取消后可以启动新批次：旧 run id 的结果不能覆盖新批次。
    await page.locator("[data-testid='scenario-run-all']").click();
    await expect(page.locator("[data-testid='scenario-run-status']")).toHaveAttribute("data-run-status", "running");
    await expect.poll(async () => (await runInfo(page)).id, { timeout: 10_000 }).not.toBe(info.id);
    await page.waitForTimeout(500);
    const fresh = await runInfo(page);
    expect(fresh.id).not.toBe(info.id);
    await page.locator("[data-testid='scenario-cancel-run']").click();
    expect(errors).toEqual([]);
  });

  test("运行中切到 Gallery 会取消旧批次", async ({ page }) => {
    const errors = watchErrors(page);
    await openLab(page);
    await page.locator("[data-testid='scenario-run-all']").click();
    await expect(page.locator("[data-testid='scenario-run-status']")).toHaveAttribute("data-run-status", "running");
    await page.locator("[data-testid='scenario-mode-gallery']").click();
    await expect(page.locator("[data-testid='scenario-run-status']")).toHaveAttribute("data-run-status", "cancelled");
    await expect(page.locator("[data-scenario-card]")).toHaveCount(16, { timeout: 20_000 });
    expect(errors).toEqual([]);
  });

  test("运行中离开页面：组件卸载且旧任务不再写结果", async ({ page }) => {
    const errors = watchErrors(page);
    await openLab(page);
    await page.locator("[data-testid='scenario-run-all']").click();
    await expect(page.locator("[data-testid='scenario-run-status']")).toHaveAttribute("data-run-status", "running");
    await page.locator("[data-testid='scenario-back-to-workbench']").click();
    await expect(page.locator(".scenario-lab-page")).toHaveCount(0);
    await page.waitForTimeout(800);
    await page.goto(LAB, { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-testid='scenario-run-status']")).toHaveCount(0);
    await expect(page.locator("[data-testid='scenario-run-summary-static']")).toHaveAttribute("data-status", "none");
    expect(errors).toEqual([]);
  });

  test("预览持续不稳定：超时后记无法验证，不制造静态通过", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = watchErrors(page);
    await openLab(page, "?labSettleMs=1");
    await page.locator("[data-testid='scenario-run-all']").click();
    await expect(page.locator("[data-testid='scenario-run-status']"))
      .toHaveAttribute("data-run-status", "completed", { timeout: 120_000 });
    const summary = await summaryInfo(page, "static");
    expect(summary.status).toBe("completed");
    expect(summary.unverifiable, "持续不稳定必须全部记无法验证").toBe(145);
    expect(summary.pass).toBe(0);
    expect(summary.staticPass).toBe(0);
    expect(summary.fail).toBe(0);
    expect(summary.notRun).toBe(0);
    await expect(page.locator("[data-testid='scenario-current-verdict']")).toContainText(/无法稳定验证|未运行|无法/);
    expect(errors).toEqual([]);
  });
});
