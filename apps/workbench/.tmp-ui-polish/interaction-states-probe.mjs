// 一次性交互状态取证：对照 mockups/2026-09-29/component-states.png 截取真实控件状态。
// 悬停 / 按下 / 键盘焦点 / 禁用原因 / 字段错误，全部为真实指针与键盘输入。
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const out = "D:/Develop/Relay-Agent/docs/testing/evidence/interaction-states-2026-09-29/";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await page.goto("http://127.0.0.1:5173/tasks?view=create", { waitUntil: "networkidle" });
await page.waitForTimeout(600);

async function shotAround(locator, name, pad = 24) {
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(120);
  const box = await locator.evaluate((el) => { const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  if (box.width === 0) throw new Error(`${name}: element not visible`);
  await page.screenshot({ path: `${out}${name}.png`,
    clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad),
      width: Math.min(1280, box.width + pad * 2), height: Math.min(800, box.height + pad * 2) } });
}

const save = page.getByTestId("task-create-save");
await shotAround(save, "primary-default");
await save.hover(); await page.waitForTimeout(180);
await shotAround(save, "primary-hover");
await page.mouse.down(); await page.waitForTimeout(120);
await shotAround(save, "primary-pressed");
await page.mouse.up();

// 键盘焦点：Tab 到「暂存待整理」次级按钮
let focused = "";
for (let i = 0; i < 15 && focused !== "task-create-inbox"; i++) {
  await page.keyboard.press("Tab");
  focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");
}
if (focused !== "task-create-inbox") throw new Error("keyboard focus did not reach secondary button");
const inbox = page.getByTestId("task-create-inbox");
await shotAround(inbox, "secondary-focus-ring");

// 字段错误：空表单直接保存（noValidate + 自定义校验）
await save.click(); await page.waitForTimeout(300);
const titleField = page.locator('input[name="task-title"]');
await shotAround(titleField, "field-error", 40);

// 提交中（等宽动词替换）：填合法内容提交，抢拍保存中状态
await page.locator('input[name="task-title"]').fill("交互状态取证任务");
await page.locator('input[name="task-expected-result"]').fill("状态截图验证用");
await page.locator('textarea[name="task-acceptance"]').fill("每行一条：截图可见");
const submitPromise = save.click().catch(() => {});
await page.getByText("正在保存").waitFor({ timeout: 3000 });
await shotAround(save, "primary-submitting");
await submitPromise;
await page.waitForTimeout(500);

// 禁用原因：fixture 待审页的决定按钮被禁用且原因就地可见
await page.goto("http://127.0.0.1:5173/reviews", { waitUntil: "networkidle" });
await page.waitForTimeout(600);
const decision = page.locator('[data-testid^="review-decision-"]').first();
await decision.scrollIntoViewIfNeeded();
await shotAround(decision, "disabled-with-reason", 40);
const reasonVisible = await page.getByText("示例数据不提交决定").isVisible();
console.log(`captured states; disabled reason visible=${reasonVisible}`);
await page.close();
await browser.close();
