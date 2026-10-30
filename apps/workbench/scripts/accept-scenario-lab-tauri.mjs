import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

/**
 * Windows Tauri 开发版实机验收（真实 WebView2 窗口，不是浏览器里另开一页）。
 *
 * 前提：`relay-desktop.exe` 已带 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`
 * 启动，且 5173 上是本仓库的 workbench 开发服务器。脚本只通过 CDP 驱动**宿主自己打开的**
 * 那个页面；窗口尺寸用 Win32 `SetWindowPos` 改的是真窗口，不是 Playwright 的视口模拟。
 *
 * 用法：`node scripts/accept-scenario-lab-tauri.mjs`
 * 证据（截图 + JSON）写到 `results/scenario-lab/tauri/`；任一条失败以非 0 退出。
 */

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(appDir, "results", "scenario-lab", "tauri");
const CDP = process.env.TAURI_CDP ?? "http://127.0.0.1:9333";
const BASE = "http://127.0.0.1:5173";
const LAB = "/__dev/assist-scenarios";
const ENTRY = `a[href="${LAB}"]`;

fs.mkdirSync(evidenceDir, { recursive: true });

const POWERSHELL_WINDOW_HELPERS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class RelayWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
function Get-RelayWindow {
  $proc = Get-Process relay-desktop -ErrorAction Stop | Select-Object -First 1
  $handle = if ($proc.MainWindowHandle -ne 0) { $proc.MainWindowHandle } else { [RelayWin]::Find([uint32]$proc.Id) }
  if ($handle -eq [IntPtr]::Zero) { throw 'relay-desktop 窗口句柄未找到' }
  return $handle
}
`;

function windowInfo() {
  const script = `${POWERSHELL_WINDOW_HELPERS}
$h = Get-RelayWindow
$rect = New-Object RelayWin+RECT
[RelayWin]::GetWindowRect($h, [ref]$rect) | Out-Null
@{ left = $rect.Left; top = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top } | ConvertTo-Json -Compress
`;
  const output = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  return JSON.parse(output.trim());
}

function resizeWindow(width, height) {
  const script = `${POWERSHELL_WINDOW_HELPERS}
$h = Get-RelayWindow
[RelayWin]::SetWindowPos($h, [IntPtr]::Zero, 40, 40, ${Math.round(width)}, ${Math.round(height)}, 0x0040) | Out-Null
`;
  execFileSync("powershell", ["-NoProfile", "-Command", script], { stdio: "pipe" });
}

/**
 * 按 CSS 像素目标改**真窗口**。
 *
 * 两个坑都是实测出来的：
 *   * 最大化态下程序化 resize 不生效（WebView 视口不动，还会塌成 146×20），先让应用自己还原窗口；
 *   * PowerShell 未声明 DPI 感知，`SetWindowPos` 收的是虚拟化坐标，所以按「当前窗口尺寸 ÷ 当前 CSS 视口」
 *     换算比例，并用实测差值迭代两次收敛，而不是一次算死。
 */
async function setWindowSize(page, cssWidth, cssHeight) {
  const restore = page.getByRole("button", { name: "还原窗口" });
  if (await restore.count() > 0) {
    await restore.click();
    await page.waitForTimeout(800);
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const css = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const errorWidth = cssWidth - css.width;
    const errorHeight = cssHeight - css.height;
    if (Math.abs(errorWidth) <= 6 && Math.abs(errorHeight) <= 6) break;
    const outer = windowInfo();
    const scaleWidth = outer.width / Math.max(css.width, 1);
    const scaleHeight = outer.height / Math.max(css.height, 1);
    resizeWindow(outer.width + errorWidth * scaleWidth, outer.height + errorHeight * scaleHeight);
    // 等视口真的跟上真窗口：Win32 改完尺寸，WebView 视口要过一会儿才更新，
    // 早一步读到的还是旧尺寸，据此算下一轮的换算比例会越算越偏。
    for (let wait = 0; wait < 10; wait += 1) {
      await page.waitForTimeout(200);
      const now = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      if (Math.abs(cssWidth - now.width) <= 6 && Math.abs(cssHeight - now.height) <= 6) break;
    }
  }
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
}

const results = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    (detail) => results.push({ name, ok: true, detail: detail ?? "" }),
    (error) => {
      results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
      throw error;
    });
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0];
  assert.ok(context, "CDP 里没有浏览器上下文");
  const page = context.pages().find((item) => item.url().startsWith(BASE)) ?? context.pages()[0];
  assert.ok(page, "CDP 里没有页面");

  const consoleErrors = [];
  const failedResponses = [];
  const requestOrigins = new Set();
  const requestsByPhase = [];
  // 按阶段归因：工作台页自己就有的失败（例如会话待办接口 404）与实验室造成的失败不是一回事，
  // 混在一起既会掩盖实验室的问题，也会把别人的问题算到实验室头上。
  let phase = "workbench";
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push({ phase, text: message.text() });
  });
  page.on("pageerror", (error) => consoleErrors.push({ phase, text: String(error) }));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedResponses.push({ phase, status: response.status(), url: response.url() });
    }
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    requestOrigins.add(url.origin);
    requestsByPhase.push({ phase, method: request.method(), url: url.origin + url.pathname });
  });

  // 先把真窗口摆到常规尺寸：上一次运行可能把它留在窄窗或塌缩态，图标栏在那档是隐藏的。
  await setWindowSize(page, 1160, 780);

  // 从工作台里的一次真实会话页进入：返回时要回的正是这一页。
  await page.goto(`${BASE}/agent`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  try {
    await page.waitForSelector(".app-navrail", { timeout: 20_000 });
  } catch (error) {
    // 图标栏在窄窗档是隐藏的，等不到它说明视口没跟上真窗口：把两边尺寸都打出来再判。
    const css = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const nav = await page.evaluate(() => {
      const node = document.querySelector(".app-navrail");
      if (!node) return "navrail 不存在";
      const style = getComputedStyle(node);
      return `display=${style.display} visibility=${style.visibility}`;
    });
    throw new Error(`等不到可见的 .app-navrail（视口 ${JSON.stringify(css)}，${nav}）：${error instanceof Error ? error.message : String(error)}`);
  }
  const origin = await page.evaluate(() => ({
    url: window.location.pathname + window.location.search,
    storage: Object.fromEntries(Array.from({ length: window.localStorage.length }, (_, index) => {
      const key = window.localStorage.key(index) ?? "";
      return [key, window.localStorage.getItem(key) ?? ""];
    }))
  }));
  const wevviewVersion = await page.evaluate(() => navigator.userAgent);

  await check("开发版导航里有「开发工具」入口，悬停提示是实验室全名", async () => {
    const aux = page.getByRole("navigation", { name: "辅助导航" });
    const entry = aux.locator(ENTRY);
    assert.equal(await entry.count(), 1, "辅助导航里应恰好一处入口");
    assert.equal((await entry.getAttribute("title")), "AI 回复场景实验室");
    assert.match((await entry.innerText()), /开发工具/u);
    assert.equal(await page.getByRole("navigation", { name: "主导航" }).locator(ENTRY).count(), 0);
    await page.screenshot({ path: join(evidenceDir, "tauri-entry.png") });
    return "1 处，title=AI 回复场景实验室";
  });

  await check("点击入口打开实验室：145 条场景、三栏、面包屑", async () => {
    await page.getByRole("navigation", { name: "辅助导航" }).locator(ENTRY).click();
    await page.waitForSelector(".scenario-lab-page", { timeout: 15_000 });
    phase = "lab";
    assert.match(page.url(), /__dev\/assist-scenarios$/u);
    const picks = await page.locator('[data-testid^="scenario-pick-"]').count();
    assert.equal(picks, 145, `场景目录应有 145 条，实际 ${String(picks)}`);
    const manifest = JSON.parse(await page.locator("#scenario-lab-manifest").innerText());
    assert.equal(manifest.length, 145);
    const breadcrumb = page.getByRole("navigation", { name: "面包屑" });
    assert.match(await breadcrumb.innerText(), /AI 回复场景实验室/u);
    assert.equal(await page.locator("[data-scenario-preview] [data-scenario-id]").count(), 1);
    return `目录 ${String(picks)} 条，manifest ${String(manifest.length)} 条`;
  });

  await check("工具展开正常：F05 多轮工具轨迹能逐行展开/收起", async () => {
    await page.locator('[data-testid="scenario-pick-F05"]').click();
    await page.waitForSelector('[data-scenario-preview] [data-scenario-id="F05"]');
    await page.locator('[data-testid="scenario-expand-all"]').click();
    await page.waitForTimeout(300);
    const expanded = await page.evaluate(() => {
      const root = document.querySelector("[data-scenario-preview]");
      const buttons = Array.from(document.querySelectorAll('[data-scenario-preview] button[aria-expanded="true"]'));
      const details = Array.from(document.querySelectorAll("[data-scenario-preview] details")).filter((node) => node.open);
      return { buttons: buttons.length, details: details.length, hasRoot: root !== null };
    });
    assert.ok(expanded.hasRoot, "预览根不在场");
    assert.ok(expanded.buttons + expanded.details > 0,
      `展开后没有任何展开态（buttons=${String(expanded.buttons)}, details=${String(expanded.details)}）`);
    await page.locator('[data-testid="scenario-collapse-all"]').click();
    await page.waitForTimeout(300);
    const collapsed = await page.evaluate(() => document
      .querySelectorAll('[data-scenario-preview] button[aria-expanded="true"]').length);
    assert.equal(collapsed, 0, "收起后仍有展开着的按钮");
    return `展开 ${String(expanded.buttons)} 个工具行 + ${String(expanded.details)} 个原生 details，收起后归零`;
  });

  await check("动画播放正常：A04 播放推进虚拟帧，预览里有在跑的动画", async () => {
    await page.locator('[data-testid="scenario-pick-A04"]').click();
    await page.waitForSelector('[data-scenario-preview] [data-scenario-id="A04"]');
    const head = page.locator(".scenario-lab-controls-head");
    assert.match(await head.innerText(), /第 1\/3 帧/u);
    await page.locator('[data-testid="scenario-play"]').click();
    await page.waitForTimeout(1_800);
    const playing = await page.evaluate(() => {
      const root = document.querySelector("[data-scenario-preview]");
      const running = document.getAnimations().filter((animation) => {
        if (animation.playState !== "running") return false;
        const target = animation.effect?.target ?? null;
        return root !== null && target !== null && root.contains(target);
      });
      return { frameText: document.querySelector(".scenario-lab-controls-head")?.textContent ?? "", running: running.length };
    });
    assert.match(playing.frameText, /第 [23]\/3 帧/u, `播放 1.8s 后应推进到第 2/3 帧，实际「${playing.frameText}」`);
    assert.ok(playing.running > 0, "播放中预览区没有在跑的动画");
    await page.screenshot({ path: join(evidenceDir, "tauri-lab-full.png"), fullPage: true });
    await page.locator('[data-testid="scenario-play"]').click();
    return `推进到「${playing.frameText.match(/第 \d+\/\d+ 帧/u)?.[0] ?? "?"}」，运行中动画 ${String(playing.running)} 条`;
  });

  await check("返回工作台：回到进入前那一页，实验室组件卸掉", async () => {
    const back = page.locator('[data-testid="scenario-back-to-workbench"]');
    assert.match(await back.innerText(), /返回工作台/u);
    await back.click();
    await page.waitForURL(/\/agent$/u, { timeout: 10_000 });
    phase = "return";
    // URL 先变、React 后卸载：等组件真的从 DOM 上消失，而不是在 URL 一变就立刻数。
    await page.waitForFunction(() => document.querySelectorAll(".scenario-lab-page").length === 0,
      null, { timeout: 10_000 });
    assert.equal(await page.locator(".scenario-lab-page").count(), 0);
    const now = await page.evaluate(() => ({
      url: window.location.pathname + window.location.search,
      storage: Object.fromEntries(Array.from({ length: window.localStorage.length }, (_, index) => {
        const key = window.localStorage.key(index) ?? "";
        return [key, window.localStorage.getItem(key) ?? ""];
      }))
    }));
    assert.equal(now.url, origin.url, "返回后的页面不是进入前那一页");
    const changed = Object.keys({ ...origin.storage, ...now.storage })
      .filter((key) => origin.storage[key] !== now.storage[key])
      .filter((key) => key !== "relay.motion" && key !== "relay.workbench.activityDensity");
    assert.deepEqual(changed, [], `实验室改动过会话存储：${changed.join(" / ")}`);
    await page.screenshot({ path: join(evidenceDir, "tauri-returned.png") });
    return `${origin.url} 原样恢复，存储只动了视图偏好`;
  });

  await check("窄窗：真窗口缩到 560 宽后入口在导航抽屉里，实验室无页面级横向溢出", async () => {
    const size = await setWindowSize(page, 560, 760);
    assert.ok(size.width <= 640, `真窗口没缩到窄窗档：innerWidth=${String(size.width)}`);
    assert.ok(size.width < 1100, `窄窗判定阈值未达到：innerWidth=${String(size.width)}`);
    assert.equal(await page.locator(".app-navrail").isHidden(), true, "窄窗下图标栏应让位");
    await page.getByRole("button", { name: "打开导航" }).click();
    const drawer = page.getByRole("navigation", { name: "完整导航" });
    const entry = drawer.locator(ENTRY);
    assert.equal(await entry.count(), 1);
    await entry.click();
    await page.waitForSelector(".scenario-lab-page", { timeout: 15_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth
      - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `窄窗下出现 ${String(overflow)}px 页面级横向溢出`);
    const order = await page.evaluate(() => [".scenario-lab-directory", ".scenario-lab-stage", ".scenario-lab-controls"]
      .map((selector) => Math.round(document.querySelector(selector)?.getBoundingClientRect().top ?? -1)));
    assert.ok(order[0] < order[1] && order[1] < order[2], `窄窗三栏没有纵向重排：${order.join(" < ")}`);
    await page.screenshot({ path: join(evidenceDir, "tauri-lab-narrow.png") });
    await page.locator('[data-testid="scenario-back-to-workbench"]').click();
    await page.waitForURL(/\/agent$/u, { timeout: 10_000 });
    phase = "return";
    return `innerWidth=${String(size.width)}，三栏 top ${order.join(" < ")}，溢出 ${String(overflow)}px`;
  });

  await check("实验室自身没有资源/路由错误，也没有连真实执行系统", async () => {
    await setWindowSize(page, 1160, 780);
    const labConsole = consoleErrors.filter((item) => item.phase === "lab");
    const labResponses = failedResponses.filter((item) => item.phase === "lab");
    assert.deepEqual(labConsole, [], `实验室阶段有控制台错误：${labConsole.map((item) => item.text).join(" | ")}`);
    assert.deepEqual(labResponses, [],
      `实验室阶段有失败响应：${labResponses.map((item) => `${String(item.status)} ${item.url}`).join(" | ")}`);
    // Tauri v2 在 Windows 上的 IPC 走 http://ipc.localhost（自定义协议主机，不是网络地址），
    // 宿主与前端之间的命令都从这里过，把它当“外部请求”会误判。
    const foreign = [...requestOrigins].filter((origin) =>
      origin !== BASE && !/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin)
      && origin !== "tauri://localhost" && origin !== "http://ipc.localhost");
    assert.deepEqual(foreign, [], `出现非本机请求：${foreign.join(" | ")}`);
    // 工作台页自己就有的失败单独记下来：那是应用层的问题，不算到实验室头上，也不该被它掩盖。
    const appLevel = [...consoleErrors, ...failedResponses]
      .filter((item) => item.phase !== "lab")
      .map((item) => `${item.phase}: ${item.text ?? `${String(item.status)} ${item.url}`}`);
    if (appLevel.length > 0) {
      fs.writeFileSync(join(evidenceDir, "tauri-app-level-failures.json"),
        JSON.stringify({ checkedAt: new Date().toISOString(), failures: appLevel }, null, 2), "utf8");
    }
    // 实验室是纯前端模拟：它打开期间不该打到真实 API、执行通道或外部 Provider。
    const labRequests = [...new Set(requestsByPhase
      .filter((item) => item.phase === "lab")
      .map((item) => `${item.method} ${item.url}`))];
    const labToBackend = labRequests.filter((item) => /\/api\/v1\//u.test(item));
    assert.deepEqual(labToBackend, [], `实验室期间打了真实后端接口：${labToBackend.join(" | ")}`);
    fs.writeFileSync(join(evidenceDir, "tauri-requests.json"),
      JSON.stringify({ checkedAt: new Date().toISOString(), requestsByPhase }, null, 2), "utf8");
    return `请求来源 ${[...requestOrigins].join(", ")}；实验室阶段 0 错误、0 次后端调用，应用层既有问题 ${String(appLevel.length)} 条另记`;
  });

  const evidence = { checkedAt: new Date().toISOString(), cdp: CDP, base: BASE,
    userAgent: wevviewVersion, results };
  fs.writeFileSync(join(evidenceDir, "tauri-acceptance.json"), JSON.stringify(evidence, null, 2), "utf8");

  for (const item of results) console.log(`${item.ok ? "ok" : "xx"} ${item.name} — ${item.detail}`);
  await browser.close();
}

main().catch((error) => {
  console.error("Tauri 实机验收失败：", error);
  const evidence = { checkedAt: new Date().toISOString(), cdp: CDP, base: BASE, results };
  fs.writeFileSync(join(evidenceDir, "tauri-acceptance.json"), JSON.stringify(evidence, null, 2), "utf8");
  process.exitCode = 1;
});
