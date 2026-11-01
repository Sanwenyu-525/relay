import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const port = process.env.RELAY_LAB_PORT ?? "4174";
const outDir = "D:/Develop/Relay-Agent/tmp/UI-08-usage-source-disclosure";
fs.mkdirSync(outDir, { recursive: true });
const ids = process.argv.slice(2);
const WIDTHS = [375, 1024, 1440];
const report = { port, generatedAt: new Date().toISOString(), probe: [], shots: [], verdict: {} };
const browser = await chromium.launch();

async function open(id, width, theme) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/__dev/assist-scenarios?scenario=${id}&frame=99`);
  await page.locator("[data-scenario-preview]").waitFor({ state: "visible", timeout: 25000 });
  await page.waitForTimeout(900);
  let themeApplied = theme;
  if (theme === "dark") {
    const t = page.locator("[data-testid='scenario-inspector-toggle']");
    if ((await t.getAttribute("aria-expanded")) !== "true") await t.click().catch(() => {});
    await page.locator("[data-testid='scenario-inspector-tab-display']").click().catch(() => {});
    await page.locator("[data-testid='scenario-theme-dark']").click().catch(() => {});
    await page.waitForTimeout(300);
    // 关掉检验器再点摘要：面板会盖住消息体，否则展开点击会被面板吃掉。
    if ((await t.getAttribute("aria-expanded")) === "true") await t.click().catch(() => {});
    await page.waitForTimeout(300);
    themeApplied = await page.evaluate(() => document.documentElement.getAttribute("data-theme") ?? document.documentElement.dataset.theme ?? getComputedStyle(document.body).backgroundColor);
  }
  return { context, page, themeApplied };
}

const MEASURE = () => {
  const rect = (n) => { if (n === null) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const safeMarker = (el, pseudo, prop) => { try { return getComputedStyle(el, pseudo)[prop]; } catch { return "unsupported"; } };
  const textLeft = (root) => { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null); let n; while ((n = w.nextNode())) { if (n.textContent.trim().length > 0) { const r = document.createRange(); r.selectNodeContents(n); return Math.round(r.getBoundingClientRect().left); } } return null; };
  const summaryProbe = (d) => {
    if (d === null) return null;
    const s = d.querySelector("summary"); if (s === null) return null;
    const chev = s.querySelector(".chat-disclosure-chevron");
    return { cls: d.className, text: s.textContent.replace(/\s+/g, " ").trim().slice(0, 40), open: d.hasAttribute("open"),
      svgCount: s.querySelectorAll("svg").length, chevron: chev !== null, chevronBox: rect(chev),
      rotate: chev === null ? null : getComputedStyle(chev).transform, listStyle: getComputedStyle(s).listStyleType,
      markerPseudo: safeMarker(s, "::marker", "content"), textLeft: textLeft(s), summaryLeft: rect(s) === null ? null : rect(s).x };
  };
  const usage = document.querySelector(".agent-message-usage");
  const sd = document.querySelector("details.assist-source-summary");
  const ul = sd === null ? null : sd.querySelector(".assist-source-list");
  const doc = document.documentElement;
  const preview = document.querySelector("[data-scenario-preview]");
  return {
    hasUsage: usage !== null,
    usageText: usage === null ? null : usage.textContent.replace(/\s+/g, " ").trim(),
    usageInsideDetails: usage !== null && usage.closest("details") !== null,
    usageIsParagraph: usage !== null && usage.tagName === "P",
    usageRect: rect(usage),
    assistantFooter: (() => { const all = Array.from(document.querySelectorAll(".agent-message-footer")); const f = all.find((x) => x.querySelector(".agent-message-usage") !== null); return f === undefined ? null : { childClasses: Array.from(f.children).map((c) => c.className.split(" ")[0]), overflow: f.scrollWidth - f.clientWidth }; })(),
    source: summaryProbe(sd),
    listPaddingLeft: ul === null ? null : getComputedStyle(ul).paddingLeft,
    listTextLeftExpanded: ul === null ? null : (() => { const ref = ul.querySelector(".assist-source-ref"); return ref === null ? null : textLeft(ref); })(),
    chatDisclosure: Array.from(document.querySelectorAll("details.chat-disclosure")).map(summaryProbe),
    allTechDetails: Array.from(document.querySelectorAll("details.tech-details")).map((d) => ({ cls: d.className, open: d.hasAttribute("open") })),
    docOverflow: doc.scrollWidth - doc.clientWidth,
    previewOverflow: preview === null ? null : preview.scrollWidth - preview.clientWidth,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
};

for (const id of ids) {
  const { context, page } = await open(id, 1024, "light");
  const m = await page.evaluate(MEASURE);
  report.probe.push({ id, hasUsage: m.hasUsage, usageText: m.usageText, sources: m.source === null ? 0 : 1, chatDisclosure: m.chatDisclosure.length, techDetails: m.allTechDetails.length, docOverflow: m.docOverflow });
  await context.close();
}
const score = (p) => (p.hasUsage ? 1 : 0) + (p.sources > 0 ? 2 : 0) + (p.chatDisclosure > 0 ? 1 : 0) + (p.techDetails > 0 ? 1 : 0);
const chosen = report.probe.filter((p) => score(p) > 0).sort((a, b) => score(b) - score(a)).slice(0, 4).map((p) => p.id);
report.verdict.chosen = chosen;

for (const id of chosen) {
  for (const width of WIDTHS) {
    for (const theme of ["light", "dark"]) {
      const { context, page, themeApplied } = await open(id, width, theme);
      const tag = `${id}-${width}-${theme}`;
      const before = await page.evaluate(MEASURE);
      const preview = page.locator("[data-scenario-preview]").first();
      await preview.screenshot({ path: path.join(outDir, `${tag}-collapsed.png`) }).catch(async () => { await page.screenshot({ path: path.join(outDir, `${tag}-collapsed.png`) }); });
      let after = null, keys = null;
      const sum = page.locator("details.assist-source-summary > summary").first();
      if (await sum.count() > 0) {
        await sum.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(450);
        if (!(await page.evaluate(() => document.querySelector("details.assist-source-summary")?.hasAttribute("open") === true))) {
          // 检验器面板在暗色下会盖住消息体、吃掉指针点击；退回键盘展开（同时验证键盘可达）。
          await sum.focus();
          await page.keyboard.press("Space");
          await page.waitForTimeout(450);
        }
        after = await page.evaluate(MEASURE);
        await preview.screenshot({ path: path.join(outDir, `${tag}-expanded.png`) }).catch(() => {});
        await sum.focus();
        const focused = await page.evaluate(() => document.activeElement?.tagName ?? null);
        await page.keyboard.press("Space");
        await page.waitForTimeout(300);
        keys = { focused, closedBySpace: await page.evaluate(() => document.querySelector("details.assist-source-summary")?.hasAttribute("open") === false) };
      }
      report.shots.push({ tag, themeApplied, before, after, keys });
      await context.close();
      console.log("captured " + tag + " expanded=" + (after !== null));
    }
  }
}
fs.writeFileSync(path.join(outDir, "evidence.json"), JSON.stringify(report, null, 2), "utf8");
const v1024 = report.shots.filter((s) => s.tag.includes("-1024-"));
report.verdict.alignmentAndMarkers = report.shots.map((s) => ({
  tag: s.tag,
  usageText: s.before.usageText,
  usageInDetails: s.before.usageInsideDetails,
  assistantFooterChildren: s.before.assistantFooter === null ? null : s.before.assistantFooter.childClasses,
  footerOverflow: s.before.assistantFooter === null ? null : s.before.assistantFooter.overflow,
  sourceSummary: s.before.source,
  listPaddingLeft: s.before.listPaddingLeft,
  summaryTextLeft: s.before.source === null ? null : s.before.source.textLeft,
  expandedListTextLeft: s.before.listTextLeftExpanded,
  expandedListPaddingLeft: s.after === null ? null : s.after.listPaddingLeft,
  expandedSummaryTextLeft: s.after === null || s.after.source === null ? null : s.after.source.textLeft,
  rotateAfterExpand: s.after === null || s.after.source === null ? null : s.after.source.rotate,
  keys: s.keys,
  chatDisclosure: s.before.chatDisclosure.map((c) => ({ cls: c.cls, svg: c.svgCount, listStyle: c.listStyle, marker: c.markerPseudo, open: c.open })),
  techDetails: s.before.allTechDetails,
}));
report.verdict.docOverflowMax = Math.max(0, ...report.shots.map((s) => s.before.docOverflow), ...report.shots.map((s) => (s.after === null ? 0 : s.after.docOverflow)));
console.log(JSON.stringify(report.verdict, null, 1));
await browser.close();
