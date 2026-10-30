import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import { resolve } from "node:path";

/**
 * 场景实验室的浏览器验收（阶段 C）。
 *
 * jsdom 那一层（`tests/scenarioLabMatrix.spec.tsx`，145 条 × 逐条断言）证明「界面里写了什么」；
 * 这里量的是**只有真实布局与真实动画才答得了的问题**，也就是任务书第五节列的十条：
 *   ① 元素与状态对应　② 展开和折叠稳定　③ 不产生无效成功标记　④ 不出现重复工具行
 *   ⑤ 状态切换不导致整块组件卸载　⑥ 流式回复无空白交接帧　⑦ 动效开启时只有一个主进度
 *   ⑧ 动效关闭时受控动画停止　⑨ 长文本没有横向溢出　⑩ 用户上滚后位置稳定
 *
 * 三条口径：
 *   * 断言对象一律来自**产品自己的 DOM**（`.activity-item[data-state]`、`.trajectory-status[data-status]`、
 *     `html[data-motion]`、`.assist-reply[data-state]`），实验室外壳只提供 `data-scenario-preview` 与控制器入口。
 *   * 每条检查先确认节点在场，再量它的样式或动画：空集合永远不算通过（`⑦`/`⑧`/`⑨` 都带在场门槛）。
 *   * 场景清单从页面里的 `#scenario-lab-manifest` 读，与目录、批量运行、报告是同一份数据。
 *
 * 这一页不连数据库、不调 Provider、不起子进程：模拟出口在 `src/dev/scenarioClient.ts`，
 * 路由本身是构建期隔离的（生产产物没有这条路径，由 `scripts/check-scenario-lab-isolation.mjs` 复验）。
 */

const resultsDir = resolve(import.meta.dirname, "../../results/scenario-lab");
/** 矩阵每族要求的条数：与 `src/dev/scenarios/index.ts` 同一份口径，写在这里是为了让「缺哪条」由测试说，不是由实现说。 */
const REQUIRED_FAMILIES: readonly (readonly [string, number])[] =
  [["A", 16], ["B", 22], ["C", 17], ["D", 16], ["E", 17], ["F", 20], ["G", 6]];
/** 界面不允许出现的「宣布成功」措辞：失败、未知、被拒的场景里一条都不该出现。 */
const SUCCESS_CLAIMS = /全部完成|全部通过|均已通过|执行成功|成功写入|一切正常/;

interface ManifestEntry {
  readonly id: string;
  readonly title: string;
  readonly stateKind: string;
  readonly host: string;
  readonly component: string;
  readonly frames: readonly { readonly at: number; readonly label: string }[];
  readonly browserOnly: readonly string[];
  readonly interactions: number;
  readonly uncovered: string | null;
}

function labUrl(scenario: string, frame = 0): string {
  return `/__dev/assist-scenarios?scenario=${encodeURIComponent(scenario)}&frame=${frame}`;
}

/** 每条测试自己收控制台错误：真报错算失败，开发构建的无害提示按白名单排除并写清理由。 */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // 开发构建里 Vite/React 的两类噪声：源映射与 devtools 建议，不是界面故障。
    if (text.includes("[vite]") || text.includes("DevTools")) return;
    errors.push(`console: ${text}`);
  });
  return errors;
}

/** 打开一条场景并等到外壳挂的就是这一条：批量切下一条时上一条的 DOM 可能还在。 */
async function openLab(page: Page, scenario: string, frame = 0): Promise<Locator> {
  await page.goto(labUrl(scenario, frame));
  const preview = page.locator("[data-scenario-preview]");
  await expect(preview).toBeVisible();
  await expect(preview.locator(`[data-scenario-id="${scenario}"]`)).toBeAttached({ timeout: 10_000 });
  return preview;
}

async function manifest(page: Page): Promise<ManifestEntry[]> {
  await expect(page.locator("#scenario-lab-manifest")).toBeAttached();
  return JSON.parse(await page.locator("#scenario-lab-manifest").innerText()) as ManifestEntry[];
}

/**
 * 等到预览连续两次读数一致。
 *
 * 真实 hook 在推进一帧后还要异步回填，DOM 因此滞后一次提交：立刻量会把「还没重画」读成「界面不对」。
 * 这里只等，不放宽断言、也不重试取最好看的一次；等不到就由后面的实测结果说话。
 */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const scope = window as unknown as { __relaySettle?: { text: string; stable: number } };
    const node = document.querySelector("[data-scenario-preview]");
    if (node === null) return false;
    const text = node.textContent ?? "";
    const previous = scope.__relaySettle;
    scope.__relaySettle = { text, stable: previous !== undefined && previous.text === text ? previous.stable + 1 : 0 };
    return scope.__relaySettle.stable >= 2;
  }, undefined, { timeout: 6_000 }).catch(() => undefined);
}

interface ScrollReading {
  readonly scenario: string;
  readonly anchorFound: boolean;
  readonly scrollablePx: number;
  readonly startScrollTop: number;
  readonly scrollTopShiftPx: number;
  readonly anchorShiftPx: number;
  readonly framesAdvanced: number;
  readonly nodeKept: boolean;
  readonly grew: boolean;
  readonly beforeLength: number;
  readonly afterLength: number;
  readonly metricSelector: string | null;
  readonly metricBeforePx: number;
  readonly metricAfterPx: number;
}

/**
 * 把「用户往上翻，然后下面继续长」量出来。
 *
 * 滚动主人不一定在 window 上（工作台布局自己带 overflow），所以从锚点向上找第一个真能滚的祖先，
 * 给它打标记、滚起来，再逐帧推进。推进用控制器那一列的按钮，但用 evaluate 点：
 * `locator.click()` 为了让按钮可见会先把页面滚回去，那一条测量就不成立了。
 */
async function scrollProbe(page: Page, scenario: string, anchorSelector: string,
  maxFrames: number, expandAll = false, metricSelector: string | null = null): Promise<ScrollReading> {
  await openLab(page, scenario);
  await settle(page);
  if (expandAll) {
    await page.locator("[data-testid='scenario-expand-all']").click();
    await settle(page);
  }
  const empty: ScrollReading = { scenario, anchorFound: false, scrollablePx: 0, startScrollTop: 0,
    scrollTopShiftPx: 0, anchorShiftPx: 0, framesAdvanced: 0, nodeKept: false, grew: false,
    beforeLength: 0, afterLength: 0, metricSelector, metricBeforePx: 0, metricAfterPx: 0 };
  const start = await page.evaluate(({ selector, metric }: { selector: string; metric: string | null }) => {
    const row = document.querySelector(selector) as HTMLElement | null;
    if (row === null) return null;
    let host: HTMLElement | null = row;
    while (host !== null) {
      const style = getComputedStyle(host);
      if (/(auto|scroll)/.test(style.overflowY) && host.scrollHeight - host.clientHeight > 40) break;
      host = host.parentElement;
    }
    if (host === null) return null;
    host.dataset.relayScrollProbe = "1";
    host.scrollTop = Math.max(0, row.offsetTop - host.offsetTop + 1);
    (row as HTMLElement & { __relayAnchor?: boolean }).__relayAnchor = true;
    // 附带量一个「锚点上方会不会自己变高」的读数：G05 用它抓到状态行换措辞造成的推移。
    const measured = metric === null ? null : document.querySelector(metric) as HTMLElement | null;
    return { top: row.getBoundingClientRect().top, scrollTop: host.scrollTop,
      room: host.scrollHeight - host.clientHeight,
      metricPx: measured === null ? 0 : Math.round(measured.getBoundingClientRect().height),
      length: (document.querySelector("[data-scenario-preview]")?.textContent ?? "").length };
  }, { selector: anchorSelector, metric: metricSelector });
  if (start === null) return empty;

  const step = page.locator("[data-testid='scenario-step']");
  let advanced = 0;
  while (await step.isEnabled() && advanced < maxFrames) {
    await page.evaluate(() => document.querySelector<HTMLButtonElement>("[data-testid='scenario-step']")?.click());
    await settle(page);
    advanced += 1;
  }
  const after = await page.evaluate(({ selector, metric }: { selector: string; metric: string | null }) => {
    const host = document.querySelector("[data-relay-scroll-probe='1']") as HTMLElement | null;
    const row = document.querySelector(selector) as (HTMLElement & { __relayAnchor?: boolean }) | null;
    const measured = metric === null ? null : document.querySelector(metric) as HTMLElement | null;
    return { kept: row?.__relayAnchor === true,
      top: row === null ? Number.NaN : row.getBoundingClientRect().top,
      scrollTop: host === null ? Number.NaN : host.scrollTop,
      metricPx: measured === null ? 0 : Math.round(measured.getBoundingClientRect().height),
      length: (document.querySelector("[data-scenario-preview]")?.textContent ?? "").length };
  }, { selector: anchorSelector, metric: metricSelector });

  return { scenario, anchorFound: true, scrollablePx: Math.round(start.room),
    startScrollTop: Math.round(start.scrollTop),
    scrollTopShiftPx: Math.round(after.scrollTop - start.scrollTop),
    anchorShiftPx: Math.round(after.top - start.top),
    framesAdvanced: advanced, nodeKept: after.kept, grew: after.length > start.length,
    beforeLength: start.length, afterLength: after.length, metricSelector,
    metricBeforePx: start.metricPx, metricAfterPx: after.metricPx };
}

test.beforeAll(() => { fs.mkdirSync(resultsDir, { recursive: true }); });

test.describe("实验室入口与真实组件", () => {
  test("开发路由可访问，目录逐条列出矩阵要求的 ID", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/__dev/assist-scenarios");
    await expect(page.locator("[data-scenario-lab]")).toBeVisible();
    await expect(page.getByText("仅开发构建")).toBeVisible();

    const listed = await page.locator("[data-testid^='scenario-pick-']").evaluateAll(
      (nodes) => nodes.map((node) => node.getAttribute("data-testid")?.replace("scenario-pick-", "") ?? ""));
    const required = REQUIRED_FAMILIES.flatMap(([family, count]) =>
      Array.from({ length: count }, (_, index) => `${family}${String(index + 1).padStart(2, "0")}`));
    expect(required).toHaveLength(114);
    for (const id of required) expect(listed, `目录里没有矩阵要求的 ${id}`).toContain(id);
    // 反向也要成立：矩阵之外只允许实验室自己声明的 X 补充族（措辞与边界对照），不许凭空多造别的族。
    const outside = listed.filter((id) => !required.includes(id));
    expect(outside.every((id) => id.startsWith("X")),
      `目录里出现了矩阵与 X 补充族之外的 ID：${outside.filter((id) => !id.startsWith("X")).join(",")}`).toBe(true);

    await expect(page.locator(".app-navrail a[href='/__dev/assist-scenarios']")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("中间一列挂的是产品组件，不是演示替身", async ({ page }) => {
    const errors = watchErrors(page);
    const hosts: readonly (readonly [string, string])[] = [
      ["B01", ".activity-item"],
      ["F05", "[data-testid='run-tool-trajectory']"],
      ["C01", "[data-testid='execution-summary']"],
      ["C13", ".local-file-diff"],
      ["C04", "[data-testid='file-write-frozen-diff']"],
      ["A08", ".markdown-preview"]
    ];
    for (const [scenario, selector] of hosts) {
      await openLab(page, scenario);
      await settle(page);
      expect(await page.locator(selector).count(), `${scenario} 没挂上真实组件 ${selector}`).toBeGreaterThan(0);
      await expect(page.locator(selector).first(), `${scenario} 的 ${selector} 不可见`).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
});

test.describe("十条 DOM 属性", () => {
  test("① 元素与状态一一对应：状态标记与状态词同时在场且互相印证", async ({ page }) => {
    const errors = watchErrors(page);
    // 左：产品自己写的状态属性（不是实验室加的）；右：该状态对应的状态词片段。
    const cases: readonly { readonly id: string; readonly marker: string; readonly word: string }[] = [
      { id: "D04", marker: ".activity-item[data-state='REQUESTED']", word: "已请求，尚未结算" },
      { id: "D06", marker: ".trajectory-status[data-status='WAITING_APPROVAL']", word: "等待你批准" },
      { id: "D07", marker: ".activity-item[data-state='REJECTED']", word: "被拒绝" },
      { id: "D08", marker: ".activity-item[data-state='ABANDONED']", word: "已放弃" },
      { id: "D09", marker: ".activity-item[data-state='UNKNOWN']", word: "结果未知" },
      { id: "D05", marker: ".trajectory-status[data-status='PREPARED']", word: "尚无结算结果" },
      // D14 是「Run 已取消」：产品对终态 Run 的措辞是「已停止」，逐行才有「已放弃 / 已请求」的分别，
      // 因此这里钉的是被打断的那一行说什么，而不是把「已取消」这个词硬塞给面板。
      { id: "D14", marker: ".trajectory-status[data-status='ABANDONED']", word: "已放弃" }
    ];
    for (const item of cases) {
      await openLab(page, item.id);
      await settle(page);
      const marker = page.locator(item.marker);
      const count = await marker.count();
      expect(count, `${item.id} 找不到状态标记 ${item.marker}`).toBeGreaterThan(0);
      const text = await marker.first().innerText();
      expect(text, `${item.id} 的 ${item.marker} 写的是「${text}」，要求含「${item.word}」`).toContain(item.word);
    }
    expect(errors).toEqual([]);
  });

  test("② 展开与折叠稳定：入口不因展开而消失，收起后仍在原地", async ({ page }) => {
    const errors = watchErrors(page);
    await openLab(page, "B01");
    await settle(page);
    const toggle = page.locator("[data-testid='session-round-trace-toggle']").first();
    await expect(toggle).toBeVisible();
    // 初始态由产品自己定（在途自动展开、完成自动收起），这里只钉「点一次必须翻转」。
    const initial = await toggle.getAttribute("aria-expanded");
    await toggle.click();
    await expect(toggle, "点过程入口没有展开/收起")
      .toHaveAttribute("aria-expanded", initial === "true" ? "false" : "true", { timeout: 3_000 });

    await page.locator("[data-testid='scenario-expand-all']").click();
    await expect(toggle, "展开所有没有真的展开").toHaveAttribute("aria-expanded", "true", { timeout: 3_000 });
    await expect(page.locator(".activity-item").first()).toBeVisible();

    await page.locator("[data-testid='scenario-collapse-all']").click();
    await expect(toggle, "收起后过程入口必须还在原地").toBeVisible();
    await expect(toggle, "收起所有没有真的收起").toHaveAttribute("aria-expanded", "false", { timeout: 3_000 });

    await page.locator("[data-testid='scenario-expand-all']").click();
    await expect(toggle, "再展开没有回到展开态").toHaveAttribute("aria-expanded", "true", { timeout: 3_000 });
    await expect(page.locator(".activity-item").first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("③ 不产生无效成功标记：先确认失败标记在场，再要求界面不宣布成功", async ({ page }) => {
    const errors = watchErrors(page);
    const cases: readonly { readonly id: string; readonly marker: string; readonly word?: string }[] = [
      { id: "B14", marker: "[data-scenario-preview] [data-failed='true']" },
      // 写入失败落在逐文件行的相位上（不是活动行的 data-failed）：产品就是分这两层写的。
      { id: "C10", marker: ".local-file-diff[data-phase='failed']" },
      { id: "C17", marker: "[data-scenario-preview] [data-failed='true']" },
      { id: "D07", marker: ".activity-item[data-state='REJECTED']" },
      { id: "D09", marker: ".activity-item[data-state='UNKNOWN']" },
      { id: "D13", marker: "[data-testid^='trajectory-failure-']" },
      // 生成失败落在消息自己的错误说明上（不是草稿位、也不是正文位）。
      { id: "A14", marker: "[data-testid='assist-provider-error']" },
      { id: "A15", marker: ".agent-message-status", word: "已取消" }
    ];
    for (const item of cases) {
      await openLab(page, item.id);
      await settle(page);
      const marker = page.locator(item.marker);
      expect(await marker.count(), `${item.id} 没先给出失败/未知标记，这条测量没有意义`).toBeGreaterThan(0);
      if (item.word !== undefined) {
        const text = await marker.first().innerText();
        expect(text, `${item.id} 的状态标记写的是「${text}」，要求含「${item.word}」`).toContain(item.word);
      }
      // 被拒、放弃与未知的行必须是警示色，不能披成功样式：SETTLED 且非失败的「静音」样式也不许出现。
      const quiet = await page.locator(".activity-item[data-state='REJECTED'][data-tone='neutral'], "
        + ".activity-item[data-state='UNKNOWN'][data-tone='neutral'], "
        + ".activity-item[data-state='ABANDONED'][data-tone='neutral']").count();
      expect(quiet, `${item.id} 有未执行的行被涂成已结算色`).toBe(0);
      const preview = await page.locator("[data-scenario-preview]").innerText();
      expect(preview, `${item.id} 界面里出现了成功宣告`).not.toMatch(SUCCESS_CLAIMS);
    }
    // 终态失败不许挂「完成正文」那一档：失败就是失败，不补一份看起来已完成的回复。
    await openLab(page, "A14");
    await settle(page);
    expect(await page.locator("[data-testid^='assist-reply-final-']").count(), "生成失败却渲染了完成正文").toBe(0);
    expect(errors).toEqual([]);
  });

  test("④ 不出现重复工具行：同一身份只渲染一次", async ({ page }) => {
    const errors = watchErrors(page);
    const cases: readonly (readonly [string, string])[] = [
      ["E07", ".trajectory-call"],
      ["F01", ".activity-item"],
      ["C05", ".local-file-diff"]
    ];
    for (const [id, selector] of cases) {
      await openLab(page, id);
      await settle(page);
      const keys = await page.locator(`[data-scenario-preview] ${selector}`).evaluateAll(
        (nodes) => nodes.map((node) => node.getAttribute("data-testid") ?? (node.textContent ?? "").slice(0, 80)));
      expect(keys.length, `${id} 一行都没渲染，重复检查不能空过`).toBeGreaterThan(0);
      const dupes = keys.filter((key, index) => keys.indexOf(key) !== index);
      expect(dupes, `${id} 出现重复行：${[...new Set(dupes)].join(" / ")}`).toEqual([]);
    }
    // E07 的正面事实：服务端给了同一身份的两条不一致记录，界面只留一行并说明冲突。
    await openLab(page, "E07");
    await settle(page);
    expect(await page.locator("[data-testid^='trajectory-replay-conflict-']").count(),
      "重复事件应当由界面明说，而不是悄悄去重").toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test("⑤ 状态切换不卸载整块组件：逐帧推进时消息行始终是同一个节点", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/__dev/assist-scenarios");
    const flow = (await manifest(page)).find((item) => item.id === "G01");
    expect(flow, "目录里没有 G01 流程").toBeDefined();

    await openLab(page, "G01");
    await settle(page);
    await page.evaluate(() => {
      const node = document.querySelector(".agent-message");
      if (node !== null) (node as HTMLElement & { __relayMark?: boolean }).__relayMark = true;
    });
    const frames = (flow?.frames.length ?? 1) - 1;
    for (let frame = 0; frame < frames; frame += 1) {
      const step = page.locator("[data-testid='scenario-step']");
      if (await step.isDisabled()) break;
      await step.click();
      await settle(page);
    }
    const kept = await page.evaluate(() => {
      const node = document.querySelector(".agent-message") as (HTMLElement & { __relayMark?: boolean }) | null;
      return node?.__relayMark === true;
    });
    expect(kept, "整块消息行在状态推进中被卸载重挂过").toBe(true);
    expect(errors).toEqual([]);
  });

  test("⑥ 流式回复没有空白交接帧：每一帧都有草稿或正文", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/__dev/assist-scenarios");
    const flow = (await manifest(page)).find((item) => item.id === "A10");
    expect(flow, "目录里没有 A10").toBeDefined();
    const readings: { frame: number; label: string; state: string | null; draft: number; final: number }[] = [];
    for (let frame = 0; frame < (flow?.frames.length ?? 1); frame += 1) {
      await openLab(page, "A10", frame);
      await settle(page);
      // 三个档位互斥（final / verifying / draft），正文落在 `.assist-reply` 这一位里：
      // 逐帧量这一位，才能同时抓到「交接时整位消失」和「位在但里面空的」两种空白帧。
      const reading = await page.evaluate(() => {
        const reply = document.querySelector<HTMLElement>(".assist-reply");
        const draft = document.querySelector(".assist-reply-draft");
        const final = document.querySelector(".assist-message-markdown");
        return { state: reply?.dataset.state ?? null,
          length: (reply?.textContent ?? "").trim().length,
          draft: (draft?.textContent ?? "").trim().length,
          final: (final?.textContent ?? "").trim().length };
      });
      expect(reading.state, `第 ${frame + 1} 帧（${flow?.frames[frame]?.label}）连回复位都没挂载`).not.toBeNull();
      expect(reading.length, `第 ${frame + 1} 帧（${flow?.frames[frame]?.label}）回复位是空的`).toBeGreaterThan(0);
      expect(reading.draft + reading.final,
        `第 ${frame + 1} 帧（${flow?.frames[frame]?.label}）既没有草稿也没有正文`).toBeGreaterThan(0);
      readings.push({ frame, label: flow?.frames[frame]?.label ?? "", state: reading.state,
        draft: reading.draft, final: reading.final });
    }
    const states = readings.map((item) => item.state);
    for (const state of states) {
      expect(["draft", "verifying", "final"], `交接出现了第四档：${state}`).toContain(state as string);
    }
    const firstFinal = states.indexOf("final");
    if (firstFinal >= 0) {
      expect(states.slice(firstFinal).every((state) => state === "final"),
        `正文落位后又退回 ${states.slice(firstFinal).join(" → ")}`).toBe(true);
    }
    fs.writeFileSync(`${resultsDir}/stream-frames.json`, JSON.stringify(readings, null, 2), "utf8");
    expect(errors).toEqual([]);
  });

  test("⑦ 动效开启时只有一个主进度指示", async ({ page }) => {
    const errors = watchErrors(page);
    await openLab(page, "D04");
    await settle(page);
    await page.locator("[data-testid='scenario-motion-on']").click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.motion)).toBe("on");

    const rows = await page.locator("[data-scenario-preview] .activity-item").count();
    expect(rows, "这一条没有过程行，主进度测量没有意义").toBeGreaterThan(0);
    const current = await page.locator("[data-scenario-preview] .activity-item[data-current='true']").count();
    expect(current, "在途时应当恰好一个主进度").toBe(1);
    const spinning = await page.locator("[data-scenario-preview] .activity-item-spin, "
      + "[data-scenario-preview] .activity-header-spin").evaluateAll(
        (nodes) => nodes.filter((node) => getComputedStyle(node).animationName !== "none").length);
    expect(spinning, "转动的指示应当只有一个").toBe(1);
    expect(errors).toEqual([]);
  });

  test("⑧ 动效关闭时受控动画全部停止，信息一条不少", async ({ page }) => {
    const errors = watchErrors(page);
    await openLab(page, "D04");
    await settle(page);
    const spinningSelector = "[data-scenario-preview] .activity-item-spin, [data-scenario-preview] .activity-header-spin";
    await page.locator("[data-testid='scenario-motion-on']").click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.motion)).toBe("on");
    const before = await page.locator(spinningSelector).evaluateAll(
      (nodes) => nodes.filter((node) => getComputedStyle(node).animationName !== "none").length);
    expect(before, "开启动效时没有受控动画在跑，这条测量没有意义").toBeGreaterThan(0);
    const infoBefore = await page.locator("[data-scenario-preview]").innerText();

    await page.locator("[data-testid='scenario-motion-off']").click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.motion)).toBe("off");
    const after = await page.locator(spinningSelector).evaluateAll(
      (nodes) => nodes.filter((node) => getComputedStyle(node).animationName !== "none").length);
    expect(after, "关掉动效后仍在动画").toBe(0);
    expect(await page.locator("[data-scenario-preview]").innerText(),
      "关闭动效不能顺手少掉信息").toBe(infoBefore);
    expect(errors).toEqual([]);
  });

  test("⑨ 长内容不产生页面级横向溢出，宽内容在自己容器里滚动", async ({ page }) => {
    const errors = watchErrors(page);
    const cases: readonly (readonly [string, number])[] = [
      ["F03", 1280], ["F09", 1280], ["F10", 1280], ["F12", 1280], ["F07", 1280], ["F08", 720], ["F12", 390], ["F07", 390]
    ];
    for (const [id, width] of cases) {
      await page.setViewportSize({ width, height: 900 });
      await openLab(page, id);
      await settle(page);
      // 展开所有：长路径、长输出默认藏在折叠里，不展开就等于没测到。
      await page.locator("[data-testid='scenario-expand-all']").click();
      await settle(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${id} 在 ${width}px 下把页面撑出横向滚动（多出 ${overflow}px）`).toBeLessThanOrEqual(0);
      // 先确认这一条确实有超宽内容（长路径、长命令、表格、代码块都算），
      // 再看它是自己滚动 / 折行，还是把版面顶宽：真被裁切（scrollWidth > clientWidth）却没有横向滚动的，判失败。
      const wide = await page.locator("[data-scenario-preview]").evaluate((node) => {
        const cells = [...node.querySelectorAll<HTMLElement>(
          ".markdown-preview__table-scroll, [data-testid^='local-file-diff-body-'], pre, code, .hash-code, "
          + ".activity-item-dir, .activity-item-name, .local-file-diff-path")];
        const overflowing = cells.filter((element) => element.scrollWidth - element.clientWidth > 2);
        const unscrolled = overflowing.filter((element) => !["auto", "scroll"].includes(getComputedStyle(element).overflowX));
        return { measured: cells.length, overflowing: overflowing.length, unscrolled: unscrolled.length };
      });
      expect(wide.measured, `${id} 没有可测量的长内容块`).toBeGreaterThan(0);
      expect(wide.unscrolled, `${id} 有 ${wide.unscrolled} 块超宽内容没有在自己的容器里滚动`).toBe(0);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(errors).toEqual([]);
  });

  test("⑩ 用户上滚后位置稳定：草稿在下方变长，不把我正在看的那一行顶走", async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1280, height: 520 });
    const reading = await scrollProbe(page, "F13", "[data-scenario-preview] .agent-message-slot", 1);
    fs.writeFileSync(`${resultsDir}/scroll-stability.json`, JSON.stringify(reading, null, 2), "utf8");
    expect(reading.anchorFound, "F13 没有可锚定的消息行").toBe(true);
    expect(reading.scrollablePx, "容器没有可滚的高度，这条测量是空跑").toBeGreaterThan(80);
    expect(reading.startScrollTop, "容器没能真的滚起来，「用户上滚」这个前提没成立").toBeGreaterThan(0);
    expect(reading.framesAdvanced, "F13 没有可推进的后续帧").toBeGreaterThan(0);
    expect(reading.nodeKept, "消息行被整块卸载重挂").toBe(true);
    expect(reading.grew, "草稿没有变长，这条测量是空跑").toBe(true);
    expect(reading.scrollTopShiftPx, `站稳的滚动位置被推移 ${reading.scrollTopShiftPx}px`).toBe(0);
    expect(Math.abs(reading.anchorShiftPx), `下方续写把用户在看的行顶走了 ${reading.anchorShiftPx}px`)
      .toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);
  });

  /**
   * ⑩ 的另一半：Run 轨迹面板实测。
   *
   * 面板顶部那行「来源 Run · Run 状态」会随状态换措辞，字数一变就多一行，列表整体往下移。
   * 这条用例把推移钉死为**必须为 0**：上方变长时要补偿滚动位置，用户正在读的那一行不能动。
   * 注意不能套用 ⑩ 的 `scrollTopShiftPx === 0`——⑩ 是下方续写，这里是上方变长，
   * 补偿恰恰体现在 `scrollTopShiftPx` 上；这里要守的是锚点行本身的位移。
   */
  test("⑩-补 Run 轨迹面板：状态行换措辞不得推移正在读的轨迹行", async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.goto("/__dev/assist-scenarios");
    const flow = (await manifest(page)).find((item) => item.id === "G05");
    const reading = await scrollProbe(page, "G05", "[data-scenario-preview] .trajectory-call",
      (flow?.frames.length ?? 2) - 1, true, "[data-testid='trajectory-source-run']");
    fs.writeFileSync(`${resultsDir}/panel-shift.json`, JSON.stringify(reading, null, 2), "utf8");
    expect(reading.anchorFound, "G05 没有可锚定的轨迹行").toBe(true);
    expect(reading.scrollablePx, "容器没有可滚的高度，这条测量是空跑").toBeGreaterThan(80);
    expect(reading.nodeKept, "轨迹行被整块卸载重挂").toBe(true);
    expect(reading.grew, "内容没有变化，这条测量是空跑").toBe(true);
    expect(reading.framesAdvanced, "G05 没有可推进的后续帧").toBeGreaterThan(0);
    // 测量必须真的成立（滚得起来、确实变了），并且锚点行不能被推走。
    // 再由 `panel-shift.json` 里的 anchorShiftPx 决定报告里写不写这一条。
    expect(reading.metricSelector, "缺少状态行读数选择器").not.toBeNull();
    expect(reading.metricBeforePx, "状态行没量到高度").toBeGreaterThan(0);
    expect(reading.startScrollTop, "容器没能真的滚起来，「用户上滚」这个前提没成立").toBeGreaterThan(0);
    expect(Math.abs(reading.anchorShiftPx),
      `状态行换措辞把用户在看的轨迹行顶走了 ${reading.anchorShiftPx}px`).toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);
  });
});

test.describe("批量运行", () => {
  test("运行全部场景：静态断言在真实浏览器里逐条给出结果", async ({ page }) => {
    test.setTimeout(900_000);
    const errors = watchErrors(page);
    await page.goto("/__dev/assist-scenarios");
    const entries = await manifest(page);
    await page.locator("[data-testid='scenario-run-all']").click();
    await expect(page.locator("[data-testid='scenario-run-all']"), "批量没有在跑").toContainText("运行中", { timeout: 60_000 });
    await expect(page.locator("[data-testid='scenario-run-all']")).toContainText("运行全部场景", { timeout: 840_000 });

    const verdicts = await page.locator("[data-testid^='scenario-pick-'] [data-acceptance]").evaluateAll(
      (nodes) => nodes.map((node) => ({
        id: node.closest("[data-testid^='scenario-pick-']")?.getAttribute("data-testid")?.replace("scenario-pick-", "") ?? "",
        acceptance: node.getAttribute("data-acceptance") ?? "",
        reason: node.getAttribute("title") ?? ""
      })));
    const failed = verdicts.filter((item) => item.acceptance === "fail");
    const report = {
      ranAt: new Date().toISOString(),
      total: entries.length,
      pass: verdicts.filter((item) => item.acceptance === "pass").length,
      fail: failed.map((item) => `${item.id}：${item.reason}`),
      notCovered: verdicts.filter((item) => item.acceptance === "not-covered").map((item) => item.id),
      unchecked: verdicts.filter((item) => item.acceptance === "unchecked").map((item) => item.id),
      browserOnlyChecks: entries.reduce((sum, item) => sum + item.browserOnly.length, 0),
      verdicts,
      consoleErrors: errors
    };
    fs.writeFileSync(`${resultsDir}/browser-verdicts.json`, JSON.stringify(report, null, 2), "utf8");
    expect(failed, `有 ${failed.length} 条在真实浏览器里失败`).toEqual([]);
    expect(report.unchecked, "有场景没跑到").toEqual([]);
    expect(errors, "批量过程中出现控制台错误").toEqual([]);
  });
});
