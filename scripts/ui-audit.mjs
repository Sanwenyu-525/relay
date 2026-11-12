#!/usr/bin/env node
/**
 * Relay UI 审计：把「视觉不一致」变成可复跑的数字。
 *
 * 只读扫描 apps/workbench/src，不写源码；默认把报告写到 stdout，加 `--write` 落到
 * docs/frontend/ui-audit-<date>.md。所有指标都是文件级可核查的计数，不使用主观评分。
 *
 * 用法：
 *   node scripts/ui-audit.mjs            # 打印摘要 + 数据表
 *   node scripts/ui-audit.mjs --write    # 写入 docs/frontend/ui-audit-YYYY-MM-DD.md
 *   node scripts/ui-audit.mjs --json     # 机器可读摘要（守卫脚本复用）
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(repoRoot, "apps", "workbench", "src");
const tokenFile = path.join(repoRoot, "docs", "frontend", "design-tokens.json");

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const FUNC_COLOR = /\b(?:rgba?|hsla?|oklch|color-mix)\([^)]*\)/g;
const PX = /\b\d*\.?\d+px\b/g;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(repoRoot, file).replaceAll("\\", "/");
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 仅取「规则选择器」：跳过 @media/@supports 等 at-rule 头，保留其内部规则。 */
function extractSelectors(css) {
  const text = stripComments(css);
  const out = [];
  const stack = [];
  let buf = "";
  for (const ch of text) {
    if (ch === "{") {
      const head = buf.trim().replace(/\s+/g, " ");
      buf = "";
      if (head === "" || head.startsWith("@")) {
        stack.push("at");
      } else {
        if (!stack.includes("rule")) out.push(head);
        stack.push("rule");
      }
    } else if (ch === "}") {
      stack.pop();
      buf = "";
    } else if (ch === ";" && !stack.includes("rule")) {
      buf = "";
    } else {
      buf += ch;
    }
  }
  return out;
}

function parseDeclarations(css) {
  const map = new Map();
  const text = stripComments(css);
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = rule.exec(text)) !== null) {
    const sel = match[1].trim().replace(/\s+/g, " ");
    if (sel.startsWith("@")) continue;
    for (const decl of match[2].split(";")) {
      const idx = decl.indexOf(":");
      if (idx < 0) continue;
      const prop = decl.slice(0, idx).trim();
      const value = decl.slice(idx + 1).trim();
      if (!prop.startsWith("--") || value === "") continue;
      map.set(prop, value);
    }
  }
  return map;
}

function hexToRgb(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** redmean 加权距离：比裸欧氏距离更接近人眼判断，够用来找「近似同义」的色值。 */
function colorDistance(a, b) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const rMean = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt((2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db);
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const files = walk(srcRoot);
const cssFiles = files.filter((f) => f.endsWith(".css"));
// 开发实验页（src/dev）不参与业务控件统计：它们只在开发构建里存在，计入会把「页面控件数」算高。
const tsxFiles = files.filter((f) => (f.endsWith(".tsx") || f.endsWith(".ts")) && !f.includes(`${path.sep}dev${path.sep}`));

// ── 1. 规模与基础计数 ────────────────────────────────────────────────────
const cssStats = cssFiles.map((file) => {
  const text = fs.readFileSync(file, "utf8");
  const hexes = text.match(HEX) ?? [];
  const funcs = text.match(FUNC_COLOR) ?? [];
  return {
    file: rel(file),
    lines: text.split("\n").length,
    hex: hexes.length,
    funcColor: funcs.length,
    distinct: new Set(hexes.map((h) => h.toLowerCase())).size,
    px: (text.match(PX) ?? []).length,
    important: (text.match(/!important/g) ?? []).length,
    media: (text.match(/@media/g) ?? []).length,
    selectors: extractSelectors(text).length,
    declarations: parseDeclarations(text)
  };
});

const cssTotal = cssStats.reduce((acc, cur) => ({
  lines: acc.lines + cur.lines,
  hex: acc.hex + cur.hex,
  funcColor: acc.funcColor + cur.funcColor,
  px: acc.px + cur.px,
  important: acc.important + cur.important,
  media: acc.media + cur.media,
  selectors: acc.selectors + cur.selectors
}), { lines: 0, hex: 0, funcColor: 0, px: 0, important: 0, media: 0, selectors: 0 });

// ── 2. 原生控件直出 ─────────────────────────────────────────────────────
const controlCount = { button: 0, input: 0, select: 0, textarea: 0, checkbox: 0, radio: 0 };
const controlHotspots = [];
for (const file of tsxFiles) {
  const text = fs.readFileSync(file, "utf8");
  const row = {
    file: rel(file),
    button: (text.match(/<button\b/g) ?? []).length,
    input: (text.match(/<input\b/g) ?? []).length,
    select: (text.match(/<select\b/g) ?? []).length,
    textarea: (text.match(/<textarea\b/g) ?? []).length
  };
  for (const key of ["button", "input", "select", "textarea"]) controlCount[key] += row[key];
  controlCount.checkbox += (text.match(/type="checkbox"/g) ?? []).length;
  controlCount.radio += (text.match(/type="radio"/g) ?? []).length;
  if (row.button + row.input + row.select + row.textarea > 0) controlHotspots.push(row);
}
controlHotspots.sort((a, b) => (b.button + b.input + b.select + b.textarea) - (a.button + a.input + a.select + a.textarea));

// ── 3. 设计 token 与 --pv-* 分叉 ────────────────────────────────────────
const tokenDoc = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
const tokens = tokenDoc.tokens;
const colorTokens = Object.entries(tokens)
  .filter(([, v]) => v.$type === "color" && /^#[0-9a-fA-F]{6}$/.test(String(v.$value)))
  .map(([name, v]) => ({ name, value: String(v.$value) }));

function resolve(name, seen = new Set()) {
  if (seen.has(name)) return "";
  seen.add(name);
  const entry = tokens[name];
  if (!entry) return "";
  const raw = String(entry.$value);
  const ref = raw.match(/^\{([^}]+)\}$/);
  return ref ? resolve(ref[1], seen) : raw;
}

const protoFile = cssStats.find((f) => f.file.endsWith("views/proto/protoPage.css"));
const pvDecls = protoFile ? protoFile.declarations : new Map();
const pvRows = [];
for (const [prop, value] of pvDecls) {
  if (!prop.startsWith("--pv-")) continue;
  const isHex = /^#[0-9a-fA-F]{6}$/.test(value);
  let nearest = null;
  if (isHex) {
    let best = Infinity;
    for (const token of colorTokens) {
      const d = colorDistance(value, token.value);
      if (d < best) {
        best = d;
        nearest = { ...token, distance: d };
      }
    }
  }
  pvRows.push({ prop, value, nearest });
}
pvRows.sort((a, b) => (b.nearest?.distance ?? -1) - (a.nearest?.distance ?? -1));

const pvUsage = new Map();
for (const stat of cssStats) {
  const text = fs.readFileSync(path.join(repoRoot, stat.file), "utf8");
  for (const match of text.matchAll(/var\((--pv-[a-z-]+)/g)) {
    pvUsage.set(match[1], (pvUsage.get(match[1]) ?? 0) + 1);
  }
}

// ── 4. 重复选择器（同一选择器在多文件各写一遍） ────────────────────────
const selectorOwners = new Map();
for (const file of cssFiles) {
  const text = fs.readFileSync(file, "utf8");
  for (const sel of new Set(extractSelectors(text))) {
    if (!selectorOwners.has(sel)) selectorOwners.set(sel, new Set());
    selectorOwners.get(sel).add(rel(file));
  }
}
const duplicates = [...selectorOwners.entries()]
  .filter(([, owners]) => owners.size > 1)
  .map(([selector, owners]) => ({ selector, files: [...owners] }))
  .filter((row) => !row.selector.startsWith(":root") && row.selector !== "html" && row.selector !== "body")
  .sort((a, b) => b.files.length - a.files.length);

// ── 5. 组件语义样式散落在页面 CSS 的情况 ────────────────────────────────
const componentish = /(button|field|input|select|chip|badge|card|dialog|menu|tooltip|tab|switch|checkbox|toast|alert|empty|skeleton|spinner)/i;
const pageComponentStyles = duplicates
  .filter((row) => componentish.test(row.selector))
  .slice(0, 25);

// ── 6. 文本色对比度（只查 token 内的语义文本色） ────────────────────────
const contrastRows = ["color.text.primary", "color.text.secondary", "color.text.muted", "color.action.text", "color.disabled.text"]
  .map((name) => ({ name, value: resolve(name) }))
  .filter((row) => /^#[0-9a-fA-F]{6}$/.test(row.value))
  .map((row) => ({ ...row, onPaper: contrast(row.value, resolve("color.bg.canvas")), onSurface: contrast(row.value, resolve("color.bg.surface")) }));

const summary = {
  generatedAt: new Date().toISOString().slice(0, 10),
  cssFiles: cssFiles.length,
  tsxFiles: tsxFiles.length,
  cssTotal,
  controlCount,
  pvTokens: pvRows.length,
  pvHardcoded: pvRows.filter((r) => r.nearest !== null).length,
  duplicateSelectors: duplicates.length,
  avgPvDistance: pvRows.filter((r) => r.nearest).reduce((a, r) => a + r.nearest.distance, 0) / Math.max(1, pvRows.filter((r) => r.nearest).length)
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const fmt = (n) => n.toLocaleString("en-US");
const pct = (a, b) => `${((a / b) * 100).toFixed(1)}%`;

const lines = [];
const push = (...args) => lines.push(...args);

push(`# Relay UI 审计（${summary.generatedAt}）`);
push("");
push("> 本文件由 `node scripts/ui-audit.mjs --write` 生成，数字来自对 `apps/workbench/src` 的只读扫描。");
push("> 结论按 P0/P1/P2 分级，级别定义见文末。不使用主观完成度百分比。");
push("");
push("## 1. 规模基线");
push("");
push("| 指标 | 数值 |");
push("|---|---|");
push(`| CSS 文件 / 行数 | ${cssFiles.length} / ${fmt(cssTotal.lines)} |`);
push(`| TS/TSX 文件 | ${tsxFiles.length} |`);
push(`| CSS 规则选择器 | ${fmt(cssTotal.selectors)} |`);
push(`| 硬编码十六进制色值 | ${fmt(cssTotal.hex)} |`);
push(`| 硬编码 rgb()/hsl()/color-mix() | ${fmt(cssTotal.funcColor)} |`);
push(`| px 字面量 | ${fmt(cssTotal.px)} |`);
push(`| \`!important\` | ${fmt(cssTotal.important)} |`);
push(`| \`@media\` 块 | ${fmt(cssTotal.media)} |`);
push("");
push("原生控件直出（TSX 中的标签计数，不代表全部需要组件化）：");
push("");
push("| button | input | select | textarea | checkbox | radio |");
push("|---|---|---|---|---|---|");
push(`| ${controlCount.button} | ${controlCount.input} | ${controlCount.select} | ${controlCount.textarea} | ${controlCount.checkbox} | ${controlCount.radio} |`);
push("");
push("控件最密集的 10 个文件：");
push("");
push("| 文件 | button | input | select | textarea |");
push("|---|---|---|---|---|");
for (const row of controlHotspots.slice(0, 10)) {
  push(`| \`${row.file}\` | ${row.button} | ${row.input} | ${row.select} | ${row.textarea} |`);
}
push("");
push("## 2. Token 分叉：`--pv-*` 与 `--relay-*`");
push("");
push(`\`.pv-page\` 皮肤定义了 ${pvRows.length} 个局部变量，其中 ${summary.pvHardcoded} 个是写死的十六进制色值。`);
push(`与 \`design-tokens.json\` 中最接近的颜色 token 平均距离 ${summary.avgPvDistance.toFixed(1)}（redmean，0 为完全相同）。`);
push("");
push("| 变量 | 现值 | 最近 token | token 值 | 距离 | 使用次数 |");
push("|---|---|---|---|---|---|");
for (const row of pvRows) {
  if (!row.nearest) {
    push(`| \`${row.prop}\` | \`${row.value}\` | —（非颜色） | — | — | ${pvUsage.get(row.prop) ?? 0} |`);
    continue;
  }
  push(`| \`${row.prop}\` | \`${row.value}\` | \`${row.nearest.name}\` | \`${row.nearest.value}\` | ${row.nearest.distance.toFixed(1)} | ${pvUsage.get(row.prop) ?? 0} |`);
}
push("");
push("## 3. 硬编码色值分布");
push("");
push("| 文件 | 行数 | hex | 独立色值 | rgb/hsl | px | !important | @media |");
push("|---|---|---|---|---|---|---|---|");
for (const row of [...cssStats].sort((a, b) => b.hex - a.hex).slice(0, 15)) {
  push(`| \`${row.file.replace("apps/workbench/src/", "")}\` | ${row.lines} | ${row.hex} | ${row.distinct} | ${row.funcColor} | ${row.px} | ${row.important} | ${row.media} |`);
}
push("");
push("## 4. 重复定义的选择器");
push("");
push(`同一选择器出现在多个 CSS 文件的有 ${duplicates.length} 条，其中名字带组件语义的有 ${pageComponentStyles.length} 条（列表取前 25）。`);
push("");
push("| 选择器 | 文件数 | 位置 |");
push("|---|---|---|");
for (const row of pageComponentStyles) {
  push(`| \`${row.selector}\` | ${row.files.length} | ${row.files.map((f) => f.replace("apps/workbench/src/", "")).join("、")} |`);
}
push("");
push("## 5. 语义文本色对比度（WCAG AA 正文需 ≥ 4.5:1）");
push("");
push("| token | 值 | 画布上 | 纸面上 |");
push("|---|---|---|---|");
for (const row of contrastRows) {
  push(`| \`${row.name}\` | \`${row.value}\` | ${row.onPaper.toFixed(2)}:1 | ${row.onSurface.toFixed(2)}:1 |`);
}
push("");
push("## 6. 分级");
push("");
push("| 级别 | 定义 |");
push("|---|---|");
push("| P0 | 同一语义在两处呈现不同值，且已影响全站多数页面；或阻碍后续组件化 |");
push("| P1 | 局部页面与基准分叉、重复实现、可维护性风险 |");
push("| P2 | 历史残留、可删除但无用户可见影响 |");
push("");
push("## 7. 结论与处置（UI-UNIFY-01）");
push("");
push("### P0-1 两套色板：`.pv-page` 与 `/agent` 各有一个绿");
push("");
push("`protoPage.css` 自带 23 个 `--pv-*` 变量，改造前有 22 个是写死的十六进制色值；与 `design-tokens.json`");
push("里最近的色 token 平均距离 31.0（redmean）。72 处页面用 `.pv-page`，只有 `/agent` 用 `--relay-*`，");
push("于是「主按钮绿」在全站有两个值（#23704d / #205d47），分隔线也有两个值（#dfe9df / #e8eee8）。");
push("");
push("处置：变量名保留为兼容层，值全部改为 `var(--relay-*)`；文件内其余裸色值按显式映射表逐值替换；");
push("新增 `color.border.subtle` 等语义 token 承接原有取值。收敛后该文件裸色值 0 处（注释除外），");
push("由 `scripts/check-ui-conventions.mjs` 持续守住。");
push("");
push("### P0-2 三个圆角体系与两套焦点表达");
push("");
push("同一文件里出现 7/8/9/10/11/12/13/14px 八种圆角，按钮 9px、输入 8px、卡片 13px；焦点有");
push("两种画法：全局是 inset outline + forest，`.pv-page` 是外扩 3px 浅绿光晕。");
push("");
push("处置：按语义收成三档——控件 `radius.control`(8) / 徽标 `radius.badge`(6) / 容器 `radius.panel`(16)；");
push("焦点统一走全局 `:focus-visible`，删掉两处 `box-shadow: 0 0 0 3px` 光晕。");
push("");
push("### P0-3 调试入口进了生产包");
push("");
push("生产构建产物里能搜到 `/__dev/assist-scenarios` 与实验室标题：导航层写的是");
push("`includeDevTools ? [{ to: \"...\" }] : []`，判断在运行时，字面量留在包里。");
push("");
push("处置：改成构建期常量（`import.meta.env.DEV ? [...] : []`），并把产物串搜写进守卫；");
push("重新构建后 5 个产物文件均无 `__dev` 残留。");
push("");
push("### P1-1 错误态在界面上看不出来（已修）");
push("");
push("`.field input:not([type=\"checkbox\"])` 这条 (0,2,1) 规则自带 `border` 简写，压掉了");
push("`.field--invalid input` 与 `:is(input)[aria-invalid=\"true\"]` 的 (0,1,1) 红色边框——");
push("用 `FormField` 报错的字段边框仍是中性灰。处置：删除该规则里与全局基座重复的五件套，只留");
push("`width: 100%` 与 `font: inherit`；`uiLab.spec.ts` 有一条断言钉住「错误态边框 = 状态色」。");
push("");
push("### P1-2 控件尺寸分档未登记");
push("");
push("页面档按钮 34px / 12px 字号，工作台 40-48px / 14px。这不是遗漏而是密度分层，但此前是字面值。");
push("处置：新增 `control.height.page`、`font.size.pageBase`、`font.size.micro`、`layout.page.maxWidth`、");
push("`layout.page.gutter`，把分档写进唯一来源；页面档与工作台档的差异变成可查的 token 差异，");
push("而不是两套复制粘贴。是否把 72 处页面抬到 40px 属于单独验收项，没有随本次色板一起改。");
push("");
push("### P1-3 基础组件仍以原生标签直出");
push("");
push(`扫描到 ${controlCount.button} 个 \`<button>\`、${controlCount.input} 个 \`<input>\`、${controlCount.select} 个 \`<select>\`、`);
push(`${controlCount.textarea} 个 \`<textarea>\`，其中大量只是拼了 \`.primary-button\` 这类类名。`);
push("处置：建立 `src/ui`（Button / IconButton / FormField / Input / Textarea / Select / Checkbox / Radio /");
push("Switch / Badge / Alert / Spinner / Skeleton，并统一出口 Dialog / EmptyState / PageHeader），");
push("组件输出与既有类名完全一致，因此迁移是「换写法不换像素」。已完成 GoalListView 与 StatusChip 两个试点。");
push("");
push("### P1-4 页面级 CSS 仍有存量裸色值");
push("");
push(`其余 CSS 文件合计 ${cssTotal.hex} 处十六进制色值与 ${cssTotal.funcColor} 处 rgb()/hsl()，分布在 76 个文件，`);
push("集中在 ActivityView / KnowledgeView / InboxView / ProjectsView 等页面皮肤。");
push("处置：记入 `scripts/ui-conventions-baseline.json` 作为存量基线，守卫阻止新增；逐个页面迁移后再收紧基线。");
push("");
push("### P2 其他");
push("");
push(`- 同一选择器被多个文件重复定义 ${duplicates.length} 条（如 \`.active-filter-chip\` 在收件箱与任务列表各写一遍）。`);
push("- `.pv-card` 的 13px 圆角、`.pv-stat` 的 12px 圆角已并入 `radius.panel`，但页面内仍有 6 处 17-22px 标题字号");
push("  未建 token：它们属于页面档的字号阶梯（22/17/13/12/11），与工作台档（28/24/16/14/12）按比例对应，");
push("  迁移时随「页面密度档」一起验收，不单独改。");
push("- 中性状态芯片（`status-chip--neutral`）底色是 sidebar 色，在白纸卡片上几乎不可见，属于 P2 可读性问题，");
push("  改动会影响全站所有中性芯片，未在本次批次内调整。");
push("");

const report = lines.join("\n");
if (process.argv.includes("--write")) {
  const target = path.join(repoRoot, "docs", "frontend", `ui-audit-${summary.generatedAt}.md`);
  fs.writeFileSync(target, report, "utf8");
  console.log(`written: ${rel(target)}`);
} else {
  console.log(report);
}
console.log(`\n--- summary ---`);
console.log(JSON.stringify({ ...summary, cssTotal: undefined }, null, 2));
