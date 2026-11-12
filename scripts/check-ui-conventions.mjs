#!/usr/bin/env node
/**
 * UI 一致性守卫（UI-UNIFY-01）。
 *
 * 目标和做法：
 * - **不清零历史**：先记录存量基线（scripts/ui-conventions-baseline.json），只阻止**新增**违规。
 *   页面级 CSS 里还有 300 多个历史色值，一次性全改成 token 会同时改动 70 多页的视觉，
 *   属于需要单独验收的批次；守卫先保证「不再变多」。
 * - **组件层零容忍**：`src/ui/**` 是新代码，不允许出现十六进制色值、rgb()/hsl()，
 *   也不允许写 px 字号——它必须只消费 token。
 * - **不许再开第二套 token**：`--pv-*` 变量只允许出现在 protoPage.css 的兼容层里。
 * - **开发路由必须能摇掉**：若已存在生产构建产物，扫一遍是否还带 `__dev/` 路由串。
 *
 * 用法：
 *   node scripts/check-ui-conventions.mjs              # 检查（CI / 本地）
 *   node scripts/check-ui-conventions.mjs --update-baseline  # 存量下降后刷新基线
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(repoRoot, "apps", "workbench", "src");
const baselineFile = path.join(repoRoot, "scripts", "ui-conventions-baseline.json");
const distRoot = path.join(repoRoot, "apps", "workbench", "dist");

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const FUNC_COLOR = /\b(?:rgba?|hsla?|oklch)\([^)]*\)/g;
const PX_FONT = /font-size:\s*[\d.]+px/g;
const PV_DEFINITION = /(--pv-[a-z-]+)\s*:/g;

function walk(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

const rel = (file) => path.relative(repoRoot, file).replaceAll("\\", "/");
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const cssFiles = walk(srcRoot, (name) => name.endsWith(".css"));
const uiFiles = walk(path.join(srcRoot, "ui"), (name) => name.endsWith(".css") || name.endsWith(".ts") || name.endsWith(".tsx"));

const counts = {};
const violations = [];

for (const file of cssFiles) {
  const text = stripComments(fs.readFileSync(file, "utf8"));
  const count = (text.match(HEX) ?? []).length + (text.match(FUNC_COLOR) ?? []).length;
  counts[rel(file)] = count;
}

// 规则 1：组件层不得出现裸色值或 px 字号。
for (const file of uiFiles) {
  const raw = fs.readFileSync(file, "utf8");
  const text = stripComments(raw);
  const hexes = text.match(HEX) ?? [];
  const funcs = text.match(FUNC_COLOR) ?? [];
  const pxFonts = text.match(PX_FONT) ?? [];
  if (hexes.length > 0) violations.push(`${rel(file)} 使用了十六进制色值：${hexes.slice(0, 3).join(", ")}`);
  if (funcs.length > 0) violations.push(`${rel(file)} 使用了 rgb()/hsl()：${funcs.slice(0, 3).join(", ")}`);
  if (pxFonts.length > 0) violations.push(`${rel(file)} 写了 px 字号：${pxFonts.slice(0, 3).join(", ")}`);
}

// 规则 2：--pv-* 只允许在兼容层里定义（值必须是 var(--relay-*) 或 color-mix）。
const PV_ALLOWED = new Set(["apps/workbench/src/views/proto/protoPage.css"]);
for (const file of cssFiles) {
  const key = rel(file);
  if (PV_ALLOWED.has(key)) continue;
  const defs = stripComments(fs.readFileSync(file, "utf8")).match(PV_DEFINITION) ?? [];
  if (defs.length > 0) violations.push(`${key} 新定义了局部 token：${[...new Set(defs)].slice(0, 4).join(", ")}（请直接引用 --relay-*）`);
}

// 规则 3：随色值只剩 var() 时，protoPage.css 必须保持 0。
if ((counts["apps/workbench/src/views/proto/protoPage.css"] ?? 0) > 0) {
  violations.push("views/proto/protoPage.css 又出现了裸色值：页面档必须只引用 --relay-* token");
}

// 规则 4：开发路由不得进入生产构建。
// 产物比路由文件旧时不能作为证据（旧产物里可能还留着已修掉的字符串），此时只报告不判定。
const routerFile = path.join(srcRoot, "router.tsx");
const scanRoot = process.env.RELAY_UI_DIST ? path.resolve(repoRoot, process.env.RELAY_UI_DIST) : distRoot;
const routerMtime = fs.existsSync(routerFile) ? fs.statSync(routerFile).mtimeMs : 0;
const newestAssetMtime = fs.existsSync(scanRoot)
  ? Math.max(...walk(scanRoot, (name) => name.endsWith(".js")).map((file) => fs.statSync(file).mtimeMs), 0)
  : 0;
let distReport = `${rel(scanRoot)} 不存在，跳过产物扫描`;
if (newestAssetMtime > 0 && newestAssetMtime < routerMtime) {
  distReport = `${rel(scanRoot)} 早于 router.tsx 的修改，跳过（重新构建后复跑本检查）`;
} else if (newestAssetMtime > 0) {
  const assets = walk(scanRoot, (name) => name.endsWith(".js") || name.endsWith(".html"));
  const leaked = assets.filter((file) => {
    const text = fs.readFileSync(file, "utf8");
    return text.includes("__dev/ui") || text.includes("__dev/assist-scenarios") || text.includes("Relay UI Playground");
  });
  distReport = leaked.length === 0
    ? `已扫描 ${assets.length} 个产物文件，无 __dev 路由残留`
    : `生产产物残留开发路由：${leaked.map(rel).join("、")}`;
  if (leaked.length > 0) violations.push(distReport);
}

// 规则 5：与基线比对，只阻止新增。
let baseline = { files: {} };
if (fs.existsSync(baselineFile)) baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));

if (process.argv.includes("--update-baseline")) {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  fs.writeFileSync(baselineFile, JSON.stringify({
    note: "UI 一致性守卫的存量基线：每个 CSS 文件允许出现的裸色值个数。只允许下降；新增文件默认为 0。",
    updatedAt: new Date().toISOString().slice(0, 10),
    total,
    files: counts
  }, null, 2) + "\n", "utf8");
  console.log(`baseline 已刷新：${Object.keys(counts).length} 个文件，合计 ${total} 处裸色值`);
  process.exit(0);
}

const growth = [];
for (const [file, count] of Object.entries(counts)) {
  const allowed = baseline.files[file] ?? 0;
  if (count > allowed) growth.push(`${file}：${allowed} → ${count}`);
}
const removed = Object.entries(baseline.files).filter(([file, allowed]) => (counts[file] ?? 0) < allowed);

const totalNow = Object.values(counts).reduce((sum, value) => sum + value, 0);
console.log("UI 一致性检查");
console.log(`  裸色值合计：${totalNow}（基线 ${baseline.total ?? "未记录"}）`);
console.log(`  组件层文件：${uiFiles.length}`);
console.log(`  开发路由隔离：${distReport}`);
if (removed.length > 0) {
  console.log(`  存量下降：${removed.length} 个文件（可运行 --update-baseline 收紧基线）`);
}
if (growth.length > 0) {
  console.log("  新增违规：");
  for (const row of growth) console.log(`    - ${row}`);
}
if (violations.length > 0) {
  console.log("  规则违规：");
  for (const row of violations) console.log(`    - ${row}`);
}

if (growth.length > 0 || violations.length > 0) {
  console.error("\nUI 一致性检查未通过。修掉上面的新增项；确有业务例外时在对应文件里写明理由并刷新基线。");
  process.exit(1);
}
console.log("\nUI 一致性检查通过。");
