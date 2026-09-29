// 33 状态矩阵取证（桌面窗口 CDP 附着，浏览器等价验证层）。
// 用法：node .tmp-uidpi/capture-matrix.mjs 1280x800|960x640 [--with-interactive]
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const round = process.argv[2] ?? "1280x800";
const withInteractive = process.argv.includes("--with-interactive");
const [W, Hh] = round.split("x").map(Number);
const OUT = "D:/Develop/Relay-Agent/docs/testing/evidence/ui-dpi-2026-09-29/matrix";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().startsWith("http://tauri.localhost"));
if (!page) { console.error("no tauri page"); process.exit(1); }
const conn = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke("desktop_bootstrap"));
console.log("conn ok:", conn.baseUrl, "inner:", await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`));

const H_ = { Authorization: `Bearer ${conn.bearerToken}` };
const WA_ = `${conn.baseUrl}/api/v1/workspaces/${conn.workspaceId}`;
const A = "4254461d-c6e2-4b08-8ce9-679d3b8393f3"; // 项目A
const T2 = "21071df6-b10b-487a-b62b-1645e4e0df5f";
const T6 = rows0(); function rows0() { return "aff6549b-c158-4216-8c8e-305e8aefee4a"; }
const RUN = "8d19e398-b5f7-4a04-8735-4d2832ea17c6";
// 知识资料 id（项目A 第一条）
let K1 = null;
{
  const res = await fetch(`${WA_}/knowledge?project_id=${A}`, { headers: H_ });
  const body = await res.json();
  const rows = Array.isArray(body) ? body : (body.items ?? []);
  K1 = rows[0]?.id ?? rows[0]?.knowledge_id ?? null;
}
console.log("K1=", K1);

const results = [];
async function captureUnit(id, name, route, opts = {}) {
  const entry = { id, name, route: route ?? "", round, ok: false, pageErrors: [], consoleErrors: [], actionErrors: [], horizontalOverflow: false, keyChecks: {}, notes: opts.notes ?? "", screenshot: null };
  try {
    const pageErrors = [];
    const consoleErrors = [];
    const onPerr = (e) => pageErrors.push(String(e?.message ?? e).slice(0, 200));
    const onCon = (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); };
    page.on("pageerror", onPerr); page.on("console", onCon);
    await page.goto(`http://tauri.localhost${route}`, { waitUntil: "load", timeout: 30000 });
    // 等待应用就绪（bootstrap 完成，非 connecting/error 屏）
    await page.waitForFunction(() => !document.querySelector('[data-testid="desktop-service-connecting"]') && !document.querySelector('[data-testid="desktop-service-unavailable"]'), { timeout: 20000 });
    if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: 15000 }).catch(() => entry.notes += " waitFor超时");
    await page.waitForTimeout(opts.settle ?? 1200);
    if (opts.before) await opts.before(entry);
    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const errs = [...document.querySelectorAll(".action-error")].map((e) => e.textContent?.trim().slice(0, 160));
      const chips = [...document.querySelectorAll(".status-chip")].map((e) => e.textContent?.trim()).slice(0, 8);
      const disabledButtons = [...document.querySelectorAll("button:disabled")].map((e) => e.textContent?.trim().slice(0, 30)).slice(0, 6);
      const disabledReasons = [...document.querySelectorAll(".disabled-reason")].map((e) => e.textContent?.trim().slice(0, 120)).slice(0, 4);
      const h1 = document.querySelector("h1")?.textContent?.trim();
      return {
        inner: `${window.innerWidth}x${window.innerHeight}`,
        hOverflow: de.scrollWidth > de.clientWidth + 1,
        scrollW: de.scrollWidth, clientW: de.clientWidth,
        actionErrors: errs, chips, disabledButtons, disabledReasons, h1,
      };
    });
    entry.h1 = m.h1; entry.innerSize = m.inner;
    entry.actionErrors = m.actionErrors;
    entry.horizontalOverflow = m.hOverflow;
    entry.keyChecks = { chips: m.chips, disabledButtons: m.disabledButtons, disabledReasons: m.disabledReasons, scrollOverflow: `${m.scrollW}/${m.clientW}` };
    entry.pageErrors = pageErrors; entry.consoleErrors = consoleErrors;
    const shot = `${OUT}/${id}-${round}.png`;
    await page.screenshot({ path: shot });
    entry.screenshot = shot.replace(/\\/g, "/");
    entry.ok = true;
    page.off("pageerror", onPerr); page.off("console", onCon);
  } catch (e) {
    entry.notes += " ERR:" + String(e?.message ?? e).slice(0, 220);
    try { await page.screenshot({ path: `${OUT}/${id}-${round}.png` }); entry.screenshot = `${OUT}/${id}-${round}.png`; } catch {}
  }
  results.push(entry);
  console.log(`${entry.ok ? "OK " : "ERR"} ${id} ${name} hOverflow=${entry.horizontalOverflow} errs=${entry.actionErrors.length}/${entry.pageErrors.length}${entry.notes ? " | " + entry.notes : ""}`);
}

// ---------- 非交互单元 ----------
await captureUnit("UI-01", "今日工作台", "/today", { waitFor: '[data-testid="today-query"]' });
await captureUnit("UI-05", "项目列表", "/projects", {});
await captureUnit("UI-06", "创建项目", "/projects?view=create", {});
await captureUnit("UI-07", "全部任务", "/tasks", {});
await captureUnit("UI-07b", "人工待处理", "/tasks?tab=attention", { notes: "UI-07 的筛选状态变体" });
await captureUnit("UI-08", "任务收件箱", "/tasks?tab=inbox", {});
await captureUnit("UI-09", "项目任务", `/projects/${A}/tasks`, {});
await captureUnit("UI-02", "项目总览", `/projects/${A}`, { waitFor: '[data-testid="project-overview-live"]' });
await captureUnit("UI-12", "通用工作台", `/projects/${A}/workbench/general`, {});
await captureUnit("UI-13", "论文工作台", `/projects/${A}/workbench/thesis`, {});
await captureUnit("UI-14", "全局知识库", "/knowledge", {});
if (K1) await captureUnit("UI-15", "资料详情与来源版本", `/knowledge?item=${K1}`, {});
await captureUnit("UI-16", "项目资料-资料", `/projects/${A}/knowledge`, {});
await captureUnit("UI-16b", "项目资料-规则", `/projects/${A}/knowledge?kind=RULE`, { notes: "UI-16 四页签之一" });
await captureUnit("UI-17", "全局动态", "/activities", {});
await captureUnit("UI-18", "执行详情与暂停请求", `/runs/${RUN}`, { notes: "RUNNING + PENDING PAUSE 控制请求（真实 Run）" });
await captureUnit("UI-21", "待审中心", "/reviews", { waitFor: '[data-testid="review-inbox"]', notes: "OPEN 待审自然为空（无模型不产生待审）" });
await captureUnit("UI-23", "连接与执行权限", "/settings/connections", {});
await captureUnit("UI-24", "设置与工作偏好", "/settings", {});
await captureUnit("UI-29", "新建任务", "/tasks?view=create", {});
await captureUnit("UI-30", "项目蓝图预览", `/projects/${A}?skill=blueprint`, {});
await captureUnit("UI-33", "继续这个项目", `/projects/${A}?skill=resume`, {});
await captureUnit("UI-28", "委托与执行记录", `/tasks/${T6}?tab=runs`, { notes: "T6 已委托（mock）：执行记录面板" });
await captureUnit("UI-28b", "委托面板无Run", `/tasks/${T2}?tab=runs`, { notes: "UI-28 的无 Run 变体" });

// ---------- T2 任务内单元（顺序敏感：编辑→冲突→完成） ----------
await captureUnit("UI-10", "任务详情", `/tasks/${T2}`, {});
await captureUnit("UI-31", "完善任务定义", `/tasks/${T2}?skill=definition`, {});
await captureUnit("UI-32", "生成验收方案", `/tasks/${T2}?skill=verification`, {});
await captureUnit("UI-04", "产物验收状态", `/tasks/${T2}?tab=artifacts`, { waitFor: '[data-testid="artifact-versions"]' });

if (withInteractive) {
  // UI-11：载入草稿进入编辑态
  await captureUnit("UI-11", "人工编辑与保存版本", `/tasks/${T2}?tab=artifacts`, {
    waitFor: '[data-testid="artifact-editor"]',
    before: async (entry) => {
      await page.getByTestId("artifact-load-latest-draft").click();
      await page.getByTestId("artifact-draft-base").waitFor({ timeout: 10000 });
      await page.locator('textarea[name="artifact-content"]').fill(`# UI取证-20260929 草稿修订\n\n人工编辑草稿内容（未保存）。`);
      await page.waitForTimeout(600);
      entry.notes += " 已载入草稿并输入未保存内容";
    },
  });
  // UI-26：制造真实 409 冲突（API 推进 task revision → UI 保存）
  await captureUnit("UI-26", "版本冲突与草稿保留", `/tasks/${T2}?tab=artifacts`, {
    waitFor: '[data-testid="artifact-editor"]',
    before: async (entry) => {
      await page.getByTestId("artifact-load-latest-draft").click();
      await page.getByTestId("artifact-draft-base").waitFor({ timeout: 10000 });
      await page.locator('textarea[name="artifact-content"]').fill(`# UI取证-20260929 冲突草稿\n\n该草稿将在基线推进后保存以产生真实 409。`);
      // 经真实领域入口推进 task revision（置 Pin 规划元数据）
      const t = await (await fetch(`${WA_}/tasks/${T2}`, { headers: H_ })).json();
      const pin = await fetch(`${WA_}/tasks/${T2}/planning-metadata`, { method: "POST", headers: { ...H_, "Content-Type": "application/json" }, body: JSON.stringify({ command_id: crypto.randomUUID(), expected_revision: t.revision, pin: true }) });
      console.log("planning-metadata:", pin.status);
      if (pin.status !== 200) { const t2 = await (await fetch(`${WA_}/tasks/${T2}`, { headers: H_ })).json(); await fetch(`${WA_}/tasks/${T2}/planning-metadata`, { method: "POST", headers: { ...H_, "Content-Type": "application/json" }, body: JSON.stringify({ command_id: crypto.randomUUID(), expected_revision: t2.revision, pin: false }) }); }
      await page.getByTestId("artifact-save").click();
      await page.locator('[data-testid="artifact-editor"] .action-error, [data-testid="artifact-draft-base-changed"]').first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(800);
      entry.notes += " 真实 409 REVISION_CONFLICT 已触发";
    },
  });
  // UI-25：Ctrl+K 搜索浮层
  await captureUnit("UI-25", "全局搜索浮层", "/projects", {
    before: async (entry) => {
      await page.keyboard.press("Control+KeyK");
      await page.waitForTimeout(900);
      entry.notes += " Ctrl+K 已触发";
    },
  });
  // UI-27：人工完成（勾选必需条件→完成）→ DONE + 完成凭据页
  await captureUnit("UI-27", "完成凭据", `/tasks/${T2}?tab=artifacts`, {
    waitFor: '[data-testid="task-completion"]',
    before: async (entry) => {
      const boxes = page.locator('[data-testid="task-completion"] input[type="checkbox"]');
      const n = await boxes.count();
      for (let i = 0; i < n; i++) await boxes.nth(i).check().catch(() => {});
      await page.locator('input[name="completion-statement"]').fill("UI取证-20260929 人工接受说明");
      await page.getByTestId("task-complete").click();
      await page.getByTestId("task-complete-receipt").waitFor({ timeout: 15000 }).catch(() => entry.notes += " 完成回执等待超时");
      await page.waitForTimeout(1200);
    },
  });
  await captureUnit("UI-27b", "完成后的任务详情", `/tasks/${T2}`, { notes: "DONE 态" });
  const complId = await (async () => {
    const t = await (await fetch(`${WA_}/tasks/${T2}`, { headers: H_ })).json();
    return t.current_completion_id ?? t.currentCompletionId ?? null;
  })();
  if (complId) await captureUnit("UI-27c", "完成凭据记录页", `/completion-records/${complId}`, { notes: `completion=${complId}` });
}

writeFileSync(`${OUT}/matrix-${round}.json`, JSON.stringify(results, null, 2));
console.log(`round ${round} done: ${results.filter((r) => r.ok).length}/${results.length} ok`);
await browser.close();
