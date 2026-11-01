import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Aurora Glass 液态玻璃隔离原型的浏览器验收（UI-AURORA-01）。
 *
 * 这一支只验三件事，而且都用真实渲染说话：
 *   1. **参数就是钉住的那三个值**：默认模糊 20px、表面不透明度 80%、底色冷绿——读的是
 *      `getComputedStyle`，不是代码里的常量。
 *   2. **玻璃确实在改像素**：`backdrop-filter` 开着与关掉（blur 0 / 经典档）在同一块
 *      高对比条纹底上必须产出不同的字节。半透明但没模糊的界面也能骗过「看着像玻璃」的眼睛，
 *      过不了这条。
 *   3. **隔离是真的**：整轮交互下来 localStorage / sessionStorage 一个键都不许多写或改值，
 *      真实外壳的 `backdrop-filter` 必须始终是 `none`，`:root` / `body` 上不许出现材质变量。
 *
 * 生产侧的隔离不在这里——那份由 `tests/browser-prod/auroraGlassProdIsolation.spec.ts`
 * 打真产物复验，加上 `scripts/check-scenario-lab-isolation.mjs` 的逐串搜产物。
 *
 * 截图落在 `tmp/UI-AURORA-01-prototype/screenshots/`：全部来自这里真实渲染的 Chromium，
 * 不是生成的示意图。
 */

const LAB = "/__dev/aurora-glass";
const PREVIEW = "[data-aurora-preview]";
const SHOT_DIR = "D:/Develop/Relay-Agent/tmp/UI-AURORA-01-prototype/screenshots";

/** 场景轴要覆盖的状态：每条都点一次、都拍一张。testid 不依赖中文文案与顺序。 */
const SCENE_SHOTS: readonly { readonly key: string; readonly shot: string }[] = [
  { key: "welcome", shot: "aurora-welcome" },
  { key: "processing", shot: "aurora-agent-running" },
  { key: "long", shot: "aurora-long-reply" },
  { key: "completed", shot: "aurora-completed" },
  { key: "error", shot: "aurora-error" },
  { key: "table", shot: "aurora-table" },
  { key: "code", shot: "aurora-code" },
  { key: "diff", shot: "aurora-diff" },
  { key: "tool", shot: "aurora-tool-call" },
  { key: "streaming", shot: "aurora-streaming" }
];

test.use({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
test.beforeAll(() => { fs.mkdirSync(SHOT_DIR, { recursive: true }); });

async function openLab(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(String(error.message ?? error)); });
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(LAB, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PREVIEW)).toBeVisible();
  // 懒加载 chunk + 场景首帧：等外壳真的有尺寸了再往下量，不然量到的是 0×0。
  await expect.poll(async () => page.evaluate(() => {
    const frame = document.querySelector(".aurora-frame");
    return frame === null ? 0 : Math.round(frame.getBoundingClientRect().width);
  }), { timeout: 15_000 }).toBeGreaterThan(600);
  return errors;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.locator(".aurora-frame").screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

async function pickScene(page: Page, key: string): Promise<void> {
  await page.getByTestId(`aurora-scene-${key}`).click();
  await expect(page.getByTestId(`aurora-scene-${key}`)).toHaveAttribute("aria-pressed", "true");
}

/** 等到这一颗元素的底色不再变化（过渡走完），再把截图或断言交给它。用于目标值不确定的一档。 */
async function alphaAtRest(page: Page, selector: string): Promise<void> {
  let previous = await alphaAt(page, selector);
  await expect.poll(async () => {
    const next = await alphaAt(page, selector);
    const stable = next === previous;
    previous = next;
    return stable;
  }, { message: `${selector} 的底色还在过渡`, timeout: 4_000 }).toBe(true);
}

/** 取某颗元素的实际计算值：玻璃这一档只有算过的数才算事实。
 *  `-webkit-backdrop-filter` 不在这里读：Chromium 的 CSSOM 把它当别名，`getPropertyValue`
 *  恒返回空串，断言不了任何东西；那一行前缀只服务旧 WebKit/WebView2，属源码事实而非渲染事实。 */
function stylesOf(page: Page, selector: string): Promise<Record<string, string>> {
  return page.evaluate((target) => {
    const el = document.querySelector(target);
    if (el === null) throw new Error(`找不到 ${target}`);
    const style = getComputedStyle(el);
    return {
      backgroundColor: style.backgroundColor,
      backdropFilter: style.backdropFilter,
      boxShadow: style.boxShadow,
      color: style.color
    };
  }, selector);
}

/** `rgb()` / `rgba()` 一律读成 [r,g,b,a]；没有第四个分量就是完全不透明。 */
function parseRgba(value: string): readonly [number, number, number, number] {
  const parts = value.match(/[\d.]+/g)?.map(Number) ?? [];
  const [r = 0, g = 0, b = 0, a = 1] = parts;
  return [r, g, b, a];
}

const alphaOf = (color: string): number => parseRgba(color)[3];

/** 等这一档材质过渡走完再取底色的不透明度分量。
 *
 * 皮肤切换与参数拖动改的是 `background-color`，而本主题给它挂了 0.18s 的过渡
 * （`--relay-motion-duration-panel`）。刚点完就读 `getComputedStyle` 会拿到过渡中间值：
 * 0.83 这种数既不是钉住的默认值、也不是降级档的 1，断言就成了跟时序较劲而不是跟材质较劲。 */
function alphaAt(page: Page, selector: string): Promise<number> {
  return page.evaluate((target) => {
    const el = document.querySelector(target);
    if (el === null) throw new Error(`找不到 ${target}`);
    const parts = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
    return parts[3] ?? 1;
  }, selector);
}

async function expectAlpha(page: Page, selector: string, expected: number): Promise<void> {
  await expect.poll(() => alphaAt(page, selector), {
    message: `${selector} 的底色不透明度`, timeout: 4_000
  }).toBe(expected);
}

test.describe("Aurora Glass 原型：材质与参数", () => {
  test("默认值就是钉住的 20px / 80% / 冷绿，且分档确实分层", async ({ page }) => {
    const errors = await openLab(page);
    const preview = page.locator(PREVIEW);
    await expect(preview).toHaveAttribute("data-aurora-blur", "20");
    await expect(preview).toHaveAttribute("data-aurora-alpha", "80");
    await expect(preview).toHaveAttribute("data-aurora-tint", "sage");
    await expect(preview).toHaveAttribute("data-aurora-skin", "aurora");

    const rail = await stylesOf(page, `${PREVIEW} .app-navrail`);
    expect(rail.backdropFilter).toBe("blur(20px) saturate(1.08)");
    expect(rail.backgroundColor).toBe("rgba(245, 251, 247, 0.8)");

    // bar 档比 rail 档更实：五档材质必须分得开，不能全场一种玻璃。
    const titlebar = await stylesOf(page, `${PREVIEW} .desktop-titlebar`);
    expect(alphaOf(titlebar.backgroundColor)).toBeGreaterThan(alphaOf(rail.backgroundColor));

    // float 档最透、模糊最强：菜单浮层盖住的是别人的内容。
    const tool = page.locator(`${PREVIEW} .aurora-popover`).filter({ hasText: "工具" }).first();
    await tool.locator("button.aurora-chip").click();
    const float = await stylesOf(page, `${PREVIEW} .aurora-popover-panel`);
    expect(alphaOf(float.backgroundColor)).toBeLessThan(alphaOf(rail.backgroundColor));
    expect(float.backdropFilter).toBe("blur(30px) saturate(1.12)");

    // paper 档不是玻璃：阅读面必须完全不透明，且自己不参与模糊。
    const paper = await stylesOf(page, `${PREVIEW} .aurora-paper-host`);
    expect(alphaOf(paper.backgroundColor)).toBe(1);
    expect(paper.backdropFilter).toBe("none");

    expect(errors).toEqual([]);
    await shot(page, "aurora-welcome");
  });

  test("经典与 Aurora 同一场景同状态对照：只差材质，不差版式", async ({ page }) => {
    await openLab(page);
    await pickScene(page, "long");
    await expect(page.locator(`${PREVIEW} .agent-message-list`)).toBeVisible();
    await shot(page, "ab-aurora-long-reply");
    const aurora = await page.evaluate(() => {
      const rail = document.querySelector("[data-aurora-preview] .app-navrail") as HTMLElement;
      const column = document.querySelector("[data-aurora-preview] .agent-chat-transcript") as HTMLElement;
      return { backdrop: getComputedStyle(rail).backdropFilter, railWidth: rail.getBoundingClientRect().width,
        columnWidth: Math.round(column.getBoundingClientRect().width) };
    });

    await page.getByRole("button", { name: "经典", exact: true }).click();
    await expect(page.locator(PREVIEW)).toHaveAttribute("data-aurora-skin", "classic");
    const classic = await page.evaluate(() => {
      const rail = document.querySelector("[data-aurora-preview] .app-navrail") as HTMLElement;
      const column = document.querySelector("[data-aurora-preview] .agent-chat-transcript") as HTMLElement;
      return { backdrop: getComputedStyle(rail).backdropFilter, railWidth: rail.getBoundingClientRect().width,
        columnWidth: Math.round(column.getBoundingClientRect().width) };
    });
    // 经典档里本原型一条材质都不产生（A/B 靠「经典档下没有命中规则」实现，不是另写一份经典皮肤）。
    expect(classic.backdrop).toBe("none");
    // 版式两档逐像素相同：几何属于皮肤无关的骨架，只有材质归 Aurora。
    expect(classic.railWidth).toBe(aurora.railWidth);
    expect(classic.columnWidth).toBe(aurora.columnWidth);
    // 切皮肤不换场景：这一条是「A/B 可比较」的前提。
    await expect(page.getByTestId("aurora-scene-why")).toContainText("多段长文本");
    // 截图要等交叉淡入走完：不然 A/B 两张图的差异里混着一帧过渡中间态。
    await alphaAtRest(page, `${PREVIEW} .app-navrail`);
    await shot(page, "ab-classic-long-reply");
  });

  test("模糊确实在改像素：同一块玻璃在条纹底上，开与不开必须不同", async ({ page }) => {
    await openLab(page);
    // 条纹底是诊断档：软渐变模糊前后看着几乎一样，只有高对比条纹能把「在改像素」变成可测事实。
    await page.getByRole("button", { name: "诊断：条纹底" }).click();
    await expect(page.locator(PREVIEW)).toHaveAttribute("data-aurora-probe", "on");

    const region = page.locator(`${PREVIEW} .app-context-rail`);
    const slider = page.getByTestId("aurora-blur");

    await slider.fill("0");
    await expect(page.locator(PREVIEW)).toHaveAttribute("data-aurora-blur", "0");
    const flat = await region.screenshot();
    await slider.fill("20");
    const blurred = await region.screenshot();
    expect(blurred.equals(flat), "blur 0 与 blur 20 出同一张图，说明模糊根本没生效").toBe(false);

    // 反向对照：同样的 20px 参数换成经典档（无玻璃），也必须与 Aurora 档不同，
    // 否则上面那点差异就不是来自材质。
    await page.getByRole("button", { name: "经典", exact: true }).click();
    const classic = await region.screenshot();
    expect(classic.equals(blurred)).toBe(false);
  });

  test("参数可微调且恢复默认回到 20px / 80% / 冷绿，参数只落在预览元素上", async ({ page }) => {
    await openLab(page);
    await page.getByTestId("aurora-blur").fill("36");
    await page.getByTestId("aurora-alpha").fill("62");
    await expect(page.locator(PREVIEW)).toHaveAttribute("data-aurora-blur", "36");
    await expect(page.locator(PREVIEW)).toHaveAttribute("data-aurora-alpha", "62");
    const rail = `${PREVIEW} .app-navrail`;
    // backdrop-filter 不在过渡属性表里，拖动后立即读；底色那一项要走 expectAlpha（有 0.18s 交叉淡入）。
    expect((await stylesOf(page, rail)).backdropFilter).toBe("blur(36px) saturate(1.08)");
    await expectAlpha(page, rail, 0.62);
    await page.getByTestId("aurora-tints").getByRole("button", { name: /薄雾/ }).click();

    await page.getByTestId("aurora-reset").click();
    await expect(page.locator(PREVIEW)).toHaveAttribute("data-aurora-blur", "20");
    await expect(page.locator(PREVIEW)).toHaveAttribute("data-aurora-alpha", "80");
    await expect(page.locator(PREVIEW)).toHaveAttribute("data-aurora-tint", "sage");
    await expectAlpha(page, rail, 0.8);
    await expect(page.getByTestId("aurora-notice")).toContainText("默认值");

    // 材质变量只写在这一颗预览元素上：:root 与 body 拿不到，正式界面因此不受影响。
    const leaked = await page.evaluate(() => {
      const probe = (el: Element): string[] => [...el.attributes]
        .map((attr) => attr.name)
        .filter((name) => name.startsWith("--aurora") || name.startsWith("data-aurora"));
      return [...probe(document.documentElement), ...probe(document.body)];
    });
    expect(leaked).toEqual([]);
  });

  test("正文与说明文字在最坏情况的玻璃合成底上仍达到正文对比度", async ({ page }) => {
    await openLab(page);
    const readings = await page.evaluate(() => {
      const numbers = (value: string): number[] => value.match(/[\d.]+/g)?.map(Number) ?? [];
      const parse = (value: string): [number, number, number, number] => {
        const p = numbers(value);
        return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
      };
      /** 把半透明的面前色合成到声明的最深场色上：按最坏情况算，不按某一次随机像素。 */
      const over = (front: string, back: readonly number[]): number[] => {
        const [r, g, b, a] = parse(front);
        return [r * a + back[0] * (1 - a), g * a + back[1] * (1 - a), b * a + back[2] * (1 - a)];
      };
      const hex = (value: string): number[] => {
        const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu.exec(value.trim());
        if (m !== null) return [1, 2, 3].map((i) => Number(`0x${m[i]}`));
        const p = parse(value);
        return [p[0], p[1], p[2]];
      };
      const tone = (c: readonly number[]): number => {
        const [r, g, b] = c.map((channel) => {
          const s = channel / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (fg: readonly number[], bg: readonly number[]): number => {
        const [a, b] = [tone(fg), tone(bg)];
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      const preview = document.querySelector("[data-aurora-preview]") as HTMLElement;
      const ambientDeep = hex(getComputedStyle(preview).getPropertyValue("--aurora-ambient-deep"));
      const measure = (selector: string): { ratio: number; color: string } | null => {
        const el = document.querySelector(selector) as HTMLElement | null;
        if (el === null) return null;
        const style = getComputedStyle(el);
        return { ratio: ratio(parse(style.color), over(style.backgroundColor, ambientDeep)), color: style.color };
      };
      return {
        text: {
          navLabel: measure("[data-aurora-preview] .navigation-label"),
          recentTitle: measure("[data-aurora-preview] .recent-work-title"),
          // caption 级说明文字（产品里就是 text-muted）：这一档单独看，别和正文混为一谈。
          mutedCaption: measure("[data-aurora-preview] .recent-work-not-started")
        } as Record<string, { ratio: number; color: string } | null>,
        ambientRatioToPaper: ratio(ambientDeep, [255, 255, 255])
      };
    });
    for (const [name, entry] of Object.entries(readings.text)) {
      // 元素没渲染出来 = 这一档根本没法测，按不通过处理并把原因写进断言消息。
      const reading = entry ?? { ratio: -1, color: "该元素没渲染出来，对比度无从可测" };
      expect(reading.ratio, `${name}（${reading.color}）对比 ${reading.ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
    // 环境场本身必须「非常低对比」：最深场色与纸面色之间的差压在一档以内，
    // 否则玻璃再好看也是在跟正文抢注意力。
    expect(readings.ambientRatioToPaper).toBeLessThan(1.25);
  });
});

test.describe("Aurora Glass 原型：场景覆盖与不玻璃化的区域", () => {
  for (const { key, shot: name } of SCENE_SHOTS) {
    test(`场景 ${key}：渲染真实产品组件、阅读面不透明、没有未捕获错误`, async ({ page }) => {
      const errors = await openLab(page);
      await pickScene(page, key);
      await expect(page.locator(`${PREVIEW} .aurora-composer`)).toBeVisible();
      await expect(page.locator(`${PREVIEW} .scenario-preview`)).toBeVisible();
      if (key === "welcome") {
        await expect(page.locator(`${PREVIEW} .agent-chat-empty-work`)).toBeVisible();
      } else if (key === "diff") {
        // DIFF 档没有消息列表，挂的是产品自己的冻结差异面板。
        await expect(page.locator(`${PREVIEW} .scenario-preview > *`).first()).toBeVisible();
      } else {
        await expect(page.locator(`${PREVIEW} .agent-message-list`)).toBeVisible();
      }

      // 阅读面上的东西一律不透明：底是实色、自己不模糊。
      const opaque = await page.evaluate(() => {
        const selectors = [".aurora-paper-host", ".agent-message-list", ".markdown-body", "table", "pre", "code", ".action-error"];
        const out: { selector: string; alpha: number; backdrop: string }[] = [];
        for (const selector of selectors) {
          for (const el of document.querySelectorAll(`[data-aurora-preview] ${selector}`)) {
            const style = getComputedStyle(el);
            const parts = style.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
            out.push({ selector, alpha: parts[3] ?? 1, backdrop: style.backdropFilter });
          }
        }
        return out;
      });
      for (const item of opaque) {
        expect(item.alpha, `${item.selector} 的底色不透明度`).toBe(1);
        expect(item.backdrop, `${item.selector} 不该自己再模糊`).toBe("none");
      }
      expect(errors, `未捕获错误：${errors.join(" | ")}`).toEqual([]);
      await shot(page, name);
    });
  }

  test("聊天区没有横贯页面的装饰阴影，列表项不逐条变成玻璃卡", async ({ page }) => {
    await openLab(page);
    await pickScene(page, "long");
    const shadows = await page.evaluate(() => {
      const selectors = [".agent-message-slot", ".agent-message-list > *", ".agent-message-list"];
      return selectors.flatMap((target) => [...document.querySelectorAll(`[data-aurora-preview] ${target}`)]
        .map((el) => ({ target, shadow: getComputedStyle(el).boxShadow })));
    });
    expect(shadows.length).toBeGreaterThan(0);
    for (const item of shadows) expect(item.shadow, `${item.target} 带阴影`).toBe("none");

    // 玻璃化的只是外壳，列表项不逐条变成独立玻璃卡；选中那一条仍保留产品原有的色块。
    const rails = await page.evaluate(() => [...document.querySelectorAll("[data-aurora-preview] .recent-work-item")]
      .map((el) => ({
        active: el.classList.contains("recent-work-item--active"),
        background: getComputedStyle(el).backgroundColor,
        backdrop: getComputedStyle(el).backdropFilter
      })));
    expect(rails.length).toBeGreaterThan(0);
    for (const item of rails) expect(item.backdrop).toBe("none");
    for (const item of rails.filter((row) => !row.active)) expect(item.background).toBe("rgba(0, 0, 0, 0)");
    expect(rails.some((item) => item.active), "选中态被抹平就读不出「哪条是当前会话」").toBe(true);
  });
});

test.describe("Aurora Glass 原型：交互、窄窗与可达性", () => {
  test("错误场景 + 菜单浮层：可开可关，Escape 关闭并把焦点还给触发键", async ({ page }) => {
    await openLab(page);
    await pickScene(page, "error");
    await expect(page.locator(`${PREVIEW} .agent-message-list`)).toBeVisible();

    const tool = page.locator(`${PREVIEW} .aurora-popover`).filter({ hasText: "工具" }).first();
    const trigger = tool.locator("button.aurora-chip");
    await trigger.click();
    await expect(tool).toHaveAttribute("data-open", "true");
    await expect(tool.locator(".aurora-popover-panel")).toBeVisible();
    await shot(page, "aurora-error-and-menu");

    await page.keyboard.press("Escape");
    await expect(tool).toHaveAttribute("data-open", "false");
    await expect(trigger).toBeFocused();

    // 点浮层外面也关：这是菜单类控件最常坏的一半。
    await trigger.click();
    await expect(tool).toHaveAttribute("data-open", "true");
    await page.locator(`${PREVIEW} .aurora-titlebar-brand`).click();
    await expect(tool).toHaveAttribute("data-open", "false");

    // `aria-expanded` 只留在触发键上（视觉开合由 `data-open` 承担），两者必须同步。
    expect(await trigger.getAttribute("aria-expanded")).toBe("false");

    // 选中项要真的改界面：模型浮层点一条进去，触发键文案跟着换。
    const model = page.locator(`${PREVIEW} .aurora-popover`).filter({ hasText: "模型" }).first();
    await model.locator("button.aurora-chip").click();
    await model.getByRole("menuitem", { name: /长上下文/ }).click();
    await expect(model.locator("button.aurora-chip")).toContainText("长上下文");
    await expect(model).toHaveAttribute("data-open", "false");
  });

  test("看起来能点的控件都给真实反馈，且不发真实动作", async ({ page }) => {
    await openLab(page);
    await page.getByTestId("aurora-send").click();
    await expect(page.getByTestId("aurora-notice")).toContainText("不发送");

    await page.locator(`${PREVIEW} .recent-work-item`).first().click();
    await expect(page.getByTestId("aurora-notice")).toContainText("不打开真实会话");

    await page.locator(`${PREVIEW} .desktop-titlebar__button`).first().click();
    await expect(page.getByTestId("aurora-notice")).toContainText("不控制真实窗口");

    // 输入仍然可用：这是本机状态，不是副作用。
    const box = page.locator(`${PREVIEW} textarea`);
    await box.fill("只是打在原型里的一行字");
    await expect(box).toHaveValue("只是打在原型里的一行字");
    await box.press("Enter");
    await expect(page.getByTestId("aurora-notice")).toContainText("文字已经留在输入框里");
    await expect(box).toHaveValue("只是打在原型里的一行字");

    await page.getByTestId("aurora-notice").getByRole("button", { name: "知道了" }).click();
    await expect(page.getByTestId("aurora-notice")).toHaveCount(0);
    await shot(page, "aurora-control-feedback");
  });

  test("窄窗预览：容器断点生效、抽屉可开、没有横向溢出", async ({ page }) => {
    await openLab(page);
    await page.getByRole("button", { name: "窄窗" }).click();
    await expect(page.locator(".aurora-lab__stage")).toHaveAttribute("data-aurora-width", "narrow");
    const state = await page.evaluate(() => {
      const hidden = (selector: string): boolean =>
        getComputedStyle(document.querySelector(`[data-aurora-preview] ${selector}`) as Element).display === "none";
      const frame = document.querySelector(".aurora-frame") as HTMLElement;
      return {
        navrailHidden: hidden(".app-navrail"),
        contextRailHidden: hidden(".app-context-rail"),
        menuVisible: !hidden(".app-topbar .mobile-menu-button"),
        overflowX: frame.scrollWidth - frame.clientWidth
      };
    });
    expect(state.navrailHidden).toBe(true);
    expect(state.contextRailHidden).toBe(true);
    expect(state.menuVisible).toBe(true);
    expect(state.overflowX).toBeLessThanOrEqual(0);
    await shot(page, "aurora-narrow");

    await page.locator(`${PREVIEW} .mobile-menu-button`).click();
    await expect(page.getByTestId("aurora-drawer")).toBeVisible();
    await expect(page.locator(`${PREVIEW} .mobile-menu-button`)).toHaveAttribute("aria-expanded", "true");
    await shot(page, "aurora-narrow-drawer");
    // 点抽屉右侧的遮罩空白处关闭（位置相对遮罩元素，避开抽屉本体）。
    await page.getByTestId("aurora-drawer-scrim").click({ position: { x: 520, y: 240 } });
    await expect(page.getByTestId("aurora-drawer")).toHaveCount(0);
  });

  test("透明度降级档：收回复色、不再模糊，但版式与可读性都还在", async ({ page }) => {
    await openLab(page);
    await page.getByRole("button", { name: "透明度降级" }).click();
    await expect(page.locator(PREVIEW)).toHaveAttribute("data-aurora-transparency", "reduced");
    // 降级档不给人拖一个不生效的滑块：这一档固定完全不透明。
    await expect(page.getByTestId("aurora-alpha")).toBeDisabled();

    for (const selector of [".desktop-titlebar", ".app-navrail", ".app-context-rail", ".app-topbar", ".agent-chat-composer"]) {
      // 底色这一档有 0.18s 交叉淡入，用轮询等到目标值；模糊不在过渡属性表里，立即读。
      await expectAlpha(page, `${PREVIEW} ${selector}`, 1);
      expect((await stylesOf(page, `${PREVIEW} ${selector}`)).backdropFilter,
        `${selector} 降级后不该还在模糊`).toBe("none");
    }
    // 浮层同样收回复色：降级不是关掉主题，但信息优先。
    const tool = page.locator(`${PREVIEW} .aurora-popover`).filter({ hasText: "工具" }).first();
    await tool.locator("button.aurora-chip").click();
    await expectAlpha(page, `${PREVIEW} .aurora-popover-panel`, 1);
    expect((await stylesOf(page, `${PREVIEW} .aurora-popover-panel`)).backdropFilter).toBe("none");

    // 降级后仍然读得到：控件、层级与文字都在，环境场也不再抢注意力。
    await expect(page.locator(`${PREVIEW} .aurora-composer`)).toBeVisible();
    await expect(page.locator(`${PREVIEW} .navigation-label`).first()).toBeVisible();
    const ambient = await page.evaluate(() => getComputedStyle(document.querySelector("[data-aurora-preview] .aurora-ambient") as Element).backgroundImage);
    expect(ambient).toBe("none");
    await shot(page, "aurora-reduced-transparency");
  });

  test("键盘可达主要控件", async ({ page }) => {
    await openLab(page);
    await page.getByTestId("aurora-scene-welcome").focus();
    const landed: string[] = [];
    for (let index = 0; index < 70; index += 1) {
      await page.keyboard.press("Tab");
      landed.push(await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (el === null || el === document.body) return "body";
        const firstClass = (el.className ?? "").toString().trim().split(/\s+/)[0] ?? "";
        const testId = el.dataset.testid ?? "";
        return `${el.tagName.toLowerCase()}${firstClass ? `.${firstClass}` : ""}${testId ? `#${testId}` : ""}`;
      }));
    }
    const joined = landed.join(" ");
    for (const expected of ["button.aurora-lab__chip", "input#aurora-blur", "input#aurora-alpha",
      "button.navigation-item", "button.aurora-chip", "#aurora-send"]) {
      expect(joined, `Tab 顺序里应出现 ${expected}`).toContain(expected);
    }
  });
});

test.describe("Aurora Glass 原型：隔离", () => {
  test("整轮交互不写存储、不改正式主题、真实外壳不受影响", async ({ page }) => {
    await page.goto("/projects", { waitUntil: "domcontentloaded" });
    const read = (): Promise<Record<string, unknown>> => page.evaluate(() => ({
      local: Object.entries(window.localStorage).sort(),
      session: Object.entries(window.sessionStorage).sort(),
      htmlAttrs: [...document.documentElement.attributes].map((a) => `${a.name}=${a.value}`).sort(),
      railBackdrop: getComputedStyle(document.querySelector(".app-navrail") as Element).backdropFilter,
      railBackground: getComputedStyle(document.querySelector(".app-navrail") as Element).backgroundColor
    }));
    const baseline = await read();

    const errors = await openLab(page);
    // 把界面按一遍：换皮肤、换场景、拉参数、开浮层、开抽屉。
    await page.getByRole("button", { name: "经典", exact: true }).click();
    await page.getByRole("button", { name: "Aurora 玻璃" }).click();
    await page.getByRole("button", { name: "窄窗" }).click();
    await pickScene(page, "error");
    await page.getByTestId("aurora-blur").fill("30");
    await page.getByTestId("aurora-alpha").fill("70");
    await page.locator(`${PREVIEW} .aurora-popover button.aurora-chip`).first().click();
    await page.locator(`${PREVIEW} .mobile-menu-button`).click();
    await page.getByTestId("aurora-drawer").getByRole("button", { name: /设置/ }).click();
    await page.getByRole("button", { name: "宽窗" }).click();
    await page.getByTestId("aurora-reset").click();

    const after = await read();
    expect(after).toEqual(baseline);

    // 离开原型再回来：正式界面不受影响，原型也不留残值。
    await page.goto("/projects", { waitUntil: "domcontentloaded" });
    const outside = await page.evaluate(() => ({
      previews: document.querySelectorAll("[data-aurora-preview]").length,
      ambient: document.querySelectorAll(".aurora-ambient").length,
      railBackdrop: getComputedStyle(document.querySelector(".app-navrail") as Element).backdropFilter,
      railBackground: getComputedStyle(document.querySelector(".app-navrail") as Element).backgroundColor
    }));
    expect(outside.previews).toBe(0);
    expect(outside.ambient).toBe(0);
    expect(outside.railBackdrop).toBe("none");
    expect(errors).toEqual([]);
  });

  test("真实窄视口下外壳按产品自己的断点折叠，原型不横向溢出", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 900 });
    const errors = await openLab(page);
    const state = await page.evaluate(() => {
      const preview = document.querySelector("[data-aurora-preview]") as HTMLElement;
      const frame = document.querySelector(".aurora-frame") as HTMLElement;
      return {
        outerNavrail: getComputedStyle(document.querySelector(".app-navrail") as Element).display,
        previewNavrail: getComputedStyle(preview.querySelector(".app-navrail") as Element).display,
        previewWidth: Math.round(preview.getBoundingClientRect().width),
        pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        frameOverflow: frame.scrollWidth - frame.clientWidth
      };
    });
    // 700px < 48rem：真实外壳自己收成一列（display:none），复刻件走的是同一条口径。
    expect(state.outerNavrail).toBe("none");
    expect(state.previewWidth).toBeGreaterThan(0);
    expect(state.pageOverflowX).toBeLessThanOrEqual(0);
    expect(state.frameOverflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
    await shot(page, "aurora-narrow-viewport");
    await page.setViewportSize({ width: 1440, height: 960 });
  });
});
