import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { resolve } from "node:path";

/**
 * 场景实验室的批量截图与验收报告（阶段 C 的第二段）。
 *
 * 跑法（与十条属性那一条同一次命令，顺序由文件名保证）：
 *   `npx playwright test tests/browser/assistScenarioLab.spec.ts tests/browser/assistScenarioLabShots.spec.ts --workers=1`
 *
 * 三条口径：
 *   * 每张都从第 0 帧起点「单步」推到目标帧再拍——截图拍的就是实验室里播出来的那一帧，
 *     不是另开一条只给截图用的渲染路径（深链直接落到某一帧会跳过「先见过上一帧」这件事，见下方注释）。
 *   * 只拍预览列（`.scenario-shell`）：产品组件、排版与阅读宽度都在这一列里，控制器不是被测对象。
 *   * 报告里「结果」这一列只写 `browser-verdicts.json` 实测出来的值；没跑到就写「未跑」，不补一个好看的数。
 */

const resultsDir = resolve(import.meta.dirname, "../../results/scenario-lab");
const shotDir = `${resultsDir}/screenshots`;

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
  readonly conditions: { readonly theme?: "light" | "dark"; readonly viewport?: string; readonly motion?: "off"; readonly density?: string } | null;
}

/** 上滚稳定性实测的落盘形状（由 `assistScenarioLab.spec.ts` 的 `scrollProbe` 写出）。 */
interface ScrollReading {
  readonly scrollTopShiftPx: number;
  readonly anchorShiftPx: number;
  readonly beforeLength: number;
  readonly afterLength: number;
  readonly metricSelector: string | null;
  readonly metricBeforePx: number;
  readonly metricAfterPx: number;
  /** 以下几条由探针写在同一个文件里。缺失就说明这次测量没有成立，不能当通过。 */
  readonly anchorFound?: boolean;
  readonly scrollablePx?: number;
  readonly startScrollTop?: number;
}

/** 报告只使用实测读数：缺失、损坏或测量前提不成立一律记 NOT_RUN，绝不当成 PASS。 */
type ReportVerdict = { readonly acceptance: "PASS" | "FAIL" | "NOT_RUN"; readonly detail: string };

function readReading(file: string): ScrollReading | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as ScrollReading;
  } catch {
    return null;
  }
}

/**
 * 上滚位置稳定性的判定。
 *
 * `mode` 决定「什么才算这一次的推力」：`above` 是锚点上方变长（Run 轨迹面板），因此必须先证明
 * 顶部状态行真的变了高度，滚动位置的补偿量就是这一次的增长量；`below` 是锚点下方续写（会话流），
 * 滚动位置本来就不该动。两种模式下，读数缺失、损坏或前提不成立一律记 NOT_RUN。
 */
function judgeReading(reading: ScrollReading | null, what: string, mode: "above" | "below"): ReportVerdict {
  if (reading === null) return { acceptance: "NOT_RUN", detail: `${what}：读数文件缺失或无法解析，不按通过计` };
  const core = [reading.scrollTopShiftPx, reading.anchorShiftPx];
  if (core.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    return { acceptance: "NOT_RUN", detail: `${what}：核心读数不是数字，不按通过计` };
  }
  if (reading.anchorFound !== true) {
    return { acceptance: "NOT_RUN", detail: `${what}：锚点行没找到，测量前提不成立` };
  }
  if (!(typeof reading.startScrollTop === "number" && reading.startScrollTop > 0)) {
    return { acceptance: "NOT_RUN", detail: `${what}：容器没有真的滚起来，测量前提不成立` };
  }
  if (mode === "above" && !(reading.metricAfterPx > reading.metricBeforePx)) {
    return { acceptance: "NOT_RUN", detail: `${what}：顶部状态行没变高，这一次没有可测的推力，不按通过计` };
  }
  if (mode === "below" && reading.scrollTopShiftPx !== 0) {
    return { acceptance: "FAIL", detail: `${what}：滚动位置被推移 ${reading.scrollTopShiftPx}px（限值 0px）` };
  }
  if (Math.abs(reading.anchorShiftPx) > 2) {
    return { acceptance: "FAIL", detail: `${what}：正在阅读的锚点行被顶走 ${reading.anchorShiftPx}px（限值 2px）` };
  }
  return { acceptance: "PASS",
    detail: `${what}：锚点行位移 ${reading.anchorShiftPx}px、滚动位置变化 ${reading.scrollTopShiftPx}px` };
}

interface VerdictFile {  readonly total: number;
  readonly pass: number;
  readonly fail: readonly string[];
  readonly notCovered: readonly string[];
  readonly unchecked: readonly string[];
  readonly browserOnlyChecks: number;
  readonly verdicts: readonly { readonly id: string; readonly acceptance: string; readonly reason: string }[];
  readonly consoleErrors: readonly string[];
  readonly ranAt: string;
}

/** 等这一帧自己停稳（与 assistScenarioLab.spec.ts 同一套判稳口径）。 */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const scope = window as unknown as { __relayShot?: { text: string; stable: number } };
    const node = document.querySelector("[data-scenario-preview]");
    if (node === null) return false;
    const text = node.textContent ?? "";
    const previous = scope.__relayShot;
    scope.__relayShot = { text, stable: previous !== undefined && previous.text === text ? previous.stable + 1 : 0 };
    return scope.__relayShot.stable >= 2;
  }, undefined, { timeout: 6_000 }).catch(() => undefined);
}

async function openFrameZero(page: Page, id: string): Promise<void> {
  // `waitUntil` 停在 domcontentloaded，不等 `load`：这一条测试要对 145 个场景各做一遍整页导航，
  // 实测第 140 次导航等 `load` 一直没落地（同一条 URL 单开 0.6s 就渲染完，是 dev server 侧的连接复用问题，
  // 不是界面问题），把整条测试的 900s 预算吃光。「这一帧真的挂上了」由下面的挂载与停稳判据把关，`load` 不是判据；
  // 导航本身给 30s 上限，卡住要快速失败，不能让一条测试拖满十五分钟再报超时。
  await page.goto(`/__dev/assist-scenarios?scenario=${encodeURIComponent(id)}&frame=0`,
    { waitUntil: "domcontentloaded", timeout: 30_000 });
  await expect(page.locator(`[data-scenario-preview] [data-scenario-id="${id}"]`)).toBeAttached({ timeout: 10_000 });
  await settle(page);
}

/** 用控制器那颗「单步」推进（evaluate 点，避免点击为了可见性把页面滚走）。 */
async function stepOnce(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("[data-testid='scenario-step']")?.click());
  await settle(page);
}

async function shoot(page: Page, file: string): Promise<void> {
  const shell = page.locator(".scenario-shell").first();
  await expect(shell).toBeVisible();
  await shell.screenshot({ path: `${shotDir}/${file}.png` });
}

async function manifest(page: Page): Promise<ManifestEntry[]> {
  await expect(page.locator("#scenario-lab-manifest")).toBeAttached();
  return JSON.parse(await page.locator("#scenario-lab-manifest").innerText()) as ManifestEntry[];
}

const FLOWS = ["G01", "G02", "G03", "G04", "G05", "G06"];

test.beforeAll(() => {
  fs.mkdirSync(shotDir, { recursive: true });
});

test.describe("批量截图", () => {
  /**
   * 截图走的是回放，不是「直接挂在这一帧」。
   *
   * 差别只在少数场景上：X28/X31 说的就是「先见过这些步骤，后一次返回空也不能抹掉」，
   * 深链落到最后一帧时组件从没读过前一帧，界面里没有那一行——图证会与判定各说各话。
   * 因此这里从第 0 帧起逐帧点「单步」，拍的正是实验室里播出来的那一帧；
   * 步数也对得上清单：推进到按钮变灰恰好用了 `last` 步，说明没有少走或多走。
   */
  test("每条场景停在最后一帧", async ({ page }) => {
    test.setTimeout(900_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__dev/assist-scenarios");
    const entries = await manifest(page);
    const written: { id: string; frame: number; file: string }[] = [];
    for (const entry of entries) {
      const last = entry.frames.length - 1;
      const file = `${entry.id}-f${last}`;
      await openFrameZero(page, entry.id);
      let steps = 0;
      while (await page.locator("[data-testid='scenario-step']").isEnabled() && steps < last) {
        await stepOnce(page);
        steps += 1;
      }
      expect(steps, `${entry.id} 只推进了 ${steps} 步，清单声明它有 ${last} 步`).toBe(last);
      await shoot(page, file);
      written.push({ id: entry.id, frame: last, file });
    }
    // 报告需要每条场景的名称、宿主与组件位置：把页面里那一份清单原样落盘，不另起一份口径。
    fs.writeFileSync(`${resultsDir}/shots-manifest.json`, JSON.stringify(entries, null, 2), "utf8");
    fs.writeFileSync(`${resultsDir}/screenshots-last-frame.json`, JSON.stringify(written, null, 2), "utf8");
    expect(written).toHaveLength(entries.length);
  });

  test("六条流程逐帧留影（关键事件序列）", async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/__dev/assist-scenarios");
    const entries = await manifest(page);
    const written: { id: string; frame: number; label: string; file: string }[] = [];
    for (const id of FLOWS) {
      const entry = entries.find((item) => item.id === id);
      expect(entry, `目录里没有 ${id}`).toBeDefined();
      await openFrameZero(page, id);
      for (let frame = 0; frame < (entry?.frames.length ?? 0); frame += 1) {
        if (frame > 0) await stepOnce(page);
        const file = `${id}-f${frame}`;
        await shoot(page, file);
        written.push({ id, frame, label: entry?.frames[frame]?.label ?? "", file });
      }
    }
    fs.writeFileSync(`${resultsDir}/screenshots-flows.json`, JSON.stringify(written, null, 2), "utf8");
    expect(written.length).toBeGreaterThanOrEqual(FLOWS.length * 2);
  });

  test("实验室外壳（目录、控制器、展示全部状态）", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto("/__dev/assist-scenarios?scenario=C13&frame=0");
    await expect(page.locator("[data-scenario-lab]")).toBeVisible();
    await page.locator("[data-testid='scenario-expand-all']").click();
    await page.screenshot({ path: `${shotDir}/lab-single-mode.png`, fullPage: false });

    // 展示模式默认落在深链那条场景的类别上（这里是 C），要拍 A 就得自己点过去；
    // 计数按矩阵那一族的条数写死，「卡片渲染出来了」不等于「这一族齐了」。
    await page.locator("[data-testid='scenario-mode-gallery']").click();
    await page.locator("[data-testid='scenario-family-A']").click();
    await expect(page.locator("[data-scenario-card]")).toHaveCount(16, { timeout: 20_000 });
    await page.screenshot({ path: `${shotDir}/lab-gallery-A.png`, fullPage: false });
    await page.locator("[data-testid='scenario-family-F']").click();
    await expect(page.locator("[data-scenario-card]")).toHaveCount(20, { timeout: 20_000 });
    await page.screenshot({ path: `${shotDir}/lab-gallery-F.png`, fullPage: false });
  });
});

test.describe("验收报告", () => {
  test("汇总判定、截图与实测发现，写成一份可执行的报告", async () => {
    const verdictPath = `${resultsDir}/browser-verdicts.json`;
    expect(fs.existsSync(verdictPath), "先跑 assistScenarioLab.spec.ts 的批量运行，再汇总报告").toBe(true);
    const verdicts = JSON.parse(fs.readFileSync(verdictPath, "utf8")) as VerdictFile;
    const entries = JSON.parse(fs.readFileSync(`${resultsDir}/shots-manifest.json`, "utf8")) as ManifestEntry[];
    const lastShots = JSON.parse(fs.readFileSync(`${resultsDir}/screenshots-last-frame.json`, "utf8")) as
      { id: string; frame: number; file: string }[];
    const flowShots = JSON.parse(fs.readFileSync(`${resultsDir}/screenshots-flows.json`, "utf8")) as
      { id: string; frame: number; label: string; file: string }[];
    const stream = JSON.parse(fs.readFileSync(`${resultsDir}/stream-frames.json`, "utf8")) as
      { frame: number; label: string; state: string | null; draft: number; final: number }[];
    const chat = readReading(`${resultsDir}/scroll-stability.json`);
    const panel = readReading(`${resultsDir}/panel-shift.json`);
    const chatGeometry = judgeReading(chat, "会话流（F13）", "below");
    const panelGeometry = judgeReading(panel, "Run 轨迹面板（G05）", "above");

    const verdictOf = (id: string): { acceptance: string; reason: string } =>
      verdicts.verdicts.find((item) => item.id === id) ?? { acceptance: "unchecked", reason: "批量没有覆盖到这一条" };
    const shotOf = (id: string): string => {
      const last = lastShots.find((item) => item.id === id);
      return last === undefined ? "" : `results/scenario-lab/screenshots/${last.file}.png`;
    };

    const counts = { pass: 0, fail: 0, notCovered: 0, unchecked: 0 };
    const lines: string[] = [
      "# AI 回复场景实验室 · UI 验收结果", "",
      `判定时间：${verdicts.ranAt}（静态断言在真实浏览器里逐条跑出，非人工判读）`,
      `场景总数：${entries.length}　通过(PASS) ${verdicts.pass}　失败(FAIL) ${verdicts.fail.length}`
      + `　未覆盖(NOT_COVERED) ${verdicts.notCovered.length}　未跑(NOT_RUN) ${verdicts.unchecked.length}`,
      `仅真实布局/动画才能量的检查：${verdicts.browserOnlyChecks} 条（由本文件的十条覆盖，jsdom 层不冒充通过）`,
      `控制台错误：${verdicts.consoleErrors.length === 0 ? "无" : verdicts.consoleErrors.join(" / ")}`,
      "",
      "> 这些结果只描述 UI 呈现与交互，不写入业务验收账本，也不代表任何真实任务通过。",
      "",
      "| 场景 | 名称 | 状态类型 | 挂载宿主 | 组件位置 | 结果 | 失败原因 | 截图 |",
      "|---|---|---|---|---|---|---|---|"
    ];
    for (const entry of entries) {
      const verdict = verdictOf(entry.id);
      if (verdict.acceptance === "pass") counts.pass += 1;
      else if (verdict.acceptance === "fail") counts.fail += 1;
      else if (verdict.acceptance === "not-covered") counts.notCovered += 1;
      else counts.unchecked += 1;
      const label = verdict.acceptance === "pass" ? "通过" : verdict.acceptance === "fail" ? "失败"
        : verdict.acceptance === "not-covered" ? "未覆盖" : "未跑";
      const reason = (verdict.reason || (entry.uncovered ?? "")).replace(/\|/g, "/").replace(/\n/g, "；");
      lines.push(`| ${entry.id} | ${entry.title} | ${entry.stateKind} | ${entry.host} | ${entry.component} | `
        + `${label} | ${reason} | ${shotOf(entry.id)} |`);
    }

    lines.push("", "## 十条只能由真实浏览器判定的性质", "",
      "| 性质 | 判定入口 | 实测 |", "|---|---|---|",
      "| ① 元素与状态一一对应 | `assistScenarioLab.spec.ts` ① | D04/D05/D06/D07/D08/D09/D14 的状态属性与状态词逐条对上 |",
      "| ② 展开与折叠稳定 | ② | 点入口翻转、展开所有/收起所有回到同一入口 |",
      "| ③ 不产生无效成功标记 | ③ | 失败/未知/被拒先确认标记在场，再要求界面不宣布成功；A14 不渲染完成正文 |",
      "| ④ 不出现重复工具行 | ④ | E07/F01/C05 按行身份去重；E07 仍明说服务端给了重复记录 |",
      "| ⑤ 状态切换不卸载整块组件 | ⑤ | G01 逐帧推进后消息行仍是同一 DOM 节点 |",
      `| ⑥ 流式回复无空白交接帧 | ⑥ | A10 共 ${stream.length} 帧，回复位为空的帧 ${stream.filter((item) => item.draft + item.final === 0).length} 个、`
      + `未挂载的帧 ${stream.filter((item) => item.state === null).length} 个；`
      + `档位序列 ${[...new Set(stream.map((item) => item.state))].join(" → ")}（无第四档、落位后不回退） |`,
      "| ⑦ 动效开启只有一个主进度 | ⑦ | D04 在途时 `data-current` 恰一、转动指示恰一 |",
      "| ⑧ 动效关闭受控动画停止 | ⑧ | 关闭后转动指示为 0，且正文一条不少 |",
      "| ⑨ 长内容无页面级横向溢出 | ⑨ | F03/F07/F08/F09/F10/F12 在 1280 / 720 / 390 三档下页面横向溢出为 0 |",
      `| ⑩ 用户上滚后位置稳定 | ⑩ | 会话流（F13，判定 ${chatGeometry.acceptance}）：${chatGeometry.detail}`
      + `（正文 ${chat?.beforeLength ?? "?"}→${chat?.afterLength ?? "?"} 字）；`
      + `Run 轨迹面板（G05，判定 ${panelGeometry.acceptance}）：${panelGeometry.detail}`
      + `（顶部状态行 ${panel?.metricBeforePx ?? "?"}→${panel?.metricAfterPx ?? "?"}px） |`,
      "",
      "## 六条可播放流程的逐帧留影", ""
    );
    for (const id of FLOWS) {
      const shots = flowShots.filter((item) => item.id === id);
      lines.push(`- **${id}**（${entries.find((item) => item.id === id)?.title ?? ""}）：${shots.length} 帧 → `
        + shots.map((item) => `${item.frame + 1}. ${item.label}`).join(" / "));
    }

    const x03 = verdictOf("X03");
    const a03 = verdictOf("A03");
    lines.push("", "## 实测发现（与「场景是否生成」无关）", "",
      "1. **Run 轨迹面板的阅读位置**（判定 " + panelGeometry.acceptance + "，数字来自 panel-shift.json，不是推断）："
      + "G05 逐帧推进时，面板顶部那一行 " + (panel?.metricSelector ?? "trajectory-source-run") + " 由 "
      + (panel?.metricBeforePx ?? "?") + "px 长到 " + (panel?.metricAfterPx ?? "?") + "px（Run 状态换措辞后多占一行），"
      + panelGeometry.detail + "。会话流一侧：" + chatGeometry.detail + "。"
      + (panelGeometry.acceptance === "PASS"
        ? "顶部状态行变高不再推移正在阅读的轨迹行。"
        : "判定不是 PASS 时，请按这一句里的实测数字定位，不要沿用历史结论。"),
      "2. **产品没有深色主题**：实验室的暗档只是外壳反相颜色变量（见 ScenarioLab.css 的注释），"
      + "F20 用它验证「暗底上结构一个不少」，不能当作产品支持主题切换的证据。",
      "3. **X03 摘要与行事实**（场景判定 " + x03.acceptance + "）："
      + (x03.acceptance === "pass"
        ? "正文 COMPLETED 而工具仍 REQUESTED 时，摘要必须写出仍有未结算项，且不得宣布「已结束 / 全部完成 / 成功」——这条由 X03 场景自身的断言守住。"
        : "场景判定不是通过：" + (x03.reason || "无原因") + "。"),
      "4. **A03 的加载分支**（场景判定 " + a03.acceptance + "）："
      + (a03.acceptance === "pass"
        ? "已由受控读层的挂起/释放能力在真实浏览器里覆盖。"
        : (a03.reason || "未覆盖") + "。"),
      "5. **状态口径**：通过 " + counts.pass + "、失败 " + counts.fail + "、未覆盖 " + counts.notCovered
      + "、未跑 " + counts.unchecked + "（报告只写实测判定：未跑不补数字，读数不可判一律记 NOT_RUN）。",
      "",
      "## 修复前历史证据（不属于当前问题，仅留档）", "",
      "- G05：修复前 panel-shift.json 记录 anchorShiftPx = 19、scrollTopShiftPx = 0，顶部状态行 58→76px，"
      + "即状态行变长时滚动位置当时完全没有补偿。该现象已由 RunToolTrajectoryPanel 的滚动锚点补偿修掉，"
      + "并由 assistScenarioLab.spec.ts「⑩-补」的位移断言钗住（撤销修复会失败）。",
      "- X03：修复前摘要头部对「正文已结束 + 工具 REQUESTED」写「N 项操作 · 已结束」，读起来像全部结清。"
      + "该口径已由 activityPresentation.ts 的 UNSETTLED 相位修掉（改报「仍有 N 项未结算」）。",
      "- 以上两条只出现在本留档区，不得再作为当前问题出现在「实测发现」里。",
      "",
      "## 日志与证据引用", "",
      `- 批量判定原始数据：\`${resultsDir.replace(/\\/g, "/")}/browser-verdicts.json\``,
      "- 逐条静态断言（jsdom，145 条）：`apps/workbench/tests/scenarioLabMatrix.spec.tsx`",
      "- 十条浏览器性质：`apps/workbench/tests/browser/assistScenarioLab.spec.ts`",
      "- 截图批量：`apps/workbench/tests/browser/assistScenarioLabShots.spec.ts`",
      "- 流式逐帧读数：`results/scenario-lab/stream-frames.json`；上滚位置实测：`scroll-stability.json` / `panel-shift.json`",
      "- 生产隔离：`node apps/workbench/scripts/check-scenario-lab-isolation.mjs`"
      + "（开发/生产各构建一次：开发构建必须搜得到实验室串，生产构建必须一个字都搜不到；证据 `results/scenario-lab/isolation.json`）"
    );
    fs.writeFileSync(`${resultsDir}/scenario-lab-acceptance.md`, lines.join("\n"), "utf8");
    fs.writeFileSync(`${resultsDir}/summary.json`, JSON.stringify({ ...counts,
      consoleErrors: verdicts.consoleErrors.length }, null, 2), "utf8");
    expect(counts.fail, "报告里有失败的条目").toBe(0);
    expect(counts.unchecked, "报告里有未跑的条目").toBe(0);
    // 报告的正确性不只看计数：几何判定必须真的 PASS，否则报告不许写成通过；
    // 读数缺失/损坏/前提不成立时判成 NOT_RUN，下面的断言会把这一次跑红。
    expect(panelGeometry.acceptance, `G05 报告判定：${panelGeometry.detail}`).toBe("PASS");
    expect(chatGeometry.acceptance, `F13 报告判定：${chatGeometry.detail}`).toBe("PASS");
    expect(verdictOf("X03").acceptance, "X03 必须真的有判定，不能靠预设文字").toBe("pass");
    const written = fs.readFileSync(`${resultsDir}/scenario-lab-acceptance.md`, "utf8");
    expect(written, "报告必须按实测写出 G05 判定").toContain("1. **Run 轨迹面板的阅读位置**（判定 PASS");
    expect(written, "报告不得把已修复的 G05 当作当前问题").not.toContain("会被顶部状态行推移");
    expect(written, "报告不得把已修复的 X03 当作当前问题").not.toContain("X03 表头文案与行事实不一致");
  });
});
