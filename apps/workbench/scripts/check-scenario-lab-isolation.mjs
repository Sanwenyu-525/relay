import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 场景实验室的生产隔离复验。
 *
 * 「隔离」是构建期的事，那就只能用产物说话：源码里写着 `import.meta.env.DEV` 不等于
 * 打包后真的没有这条路——摇不掉就是仍然可访问。反过来，只在产物里搜不到也不算证明：
 * 可能只是搜错了目录或搜错了串。所以这里跑两次构建，一正一反互相咬住：
 *   开发构建必须搜得到（否则搜的都是不存在的东西），生产构建必须一个字都搜不到。
 * 另加一条产品自身的串，确认我们扫的是一份真装了工作台代码的产物，不是空目录。
 *
 * 用法：`node scripts/check-scenario-lab-isolation.mjs`（会自己起两次 vite 构建，几分钟）。
 * 退出码非 0 表示隔离不成立；证据落在 `results/scenario-lab/isolation.json`。
 */

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = join(appDir, "node_modules", "vite", "bin", "vite.js");
const outRoot = join(appDir, "node_modules", ".tmp", "scenario-lab-isolation");
const evidenceDir = join(appDir, "results", "scenario-lab");

/** 只允许出现在开发产物里的串：路径、组件、外壳类名、控制器入口、预览挂载点。 */
const LAB_MARKERS = ["assist-scenarios", "ScenarioLabView", "scenario-lab", "scenario-run-all",
  "data-scenario-preview", "AI 回复场景实验室", "ScenarioRunner"];

/** 产品自己的串：两次构建都必须有，用来确认扫到的不是空产物。 */
const PRODUCT_MARKER = "relay.workbench.activityDensity";

const scannedExtensions = new Set([".js", ".mjs", ".css", ".html"]);

function collectFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectFiles(path));
    else if (scannedExtensions.has(extname(entry.name).toLowerCase())) found.push(path);
  }
  return found;
}

function scan(dir) {
  const files = collectFiles(dir);
  const hits = [];
  let productFound = false;
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const marker of LAB_MARKERS) {
      if (text.includes(marker)) hits.push({ marker, file: relative(appDir, file) });
    }
    if (text.includes(PRODUCT_MARKER)) productFound = true;
  }
  return { fileCount: files.length, hits, productFound };
}

function build(mode, outDir) {
  // `--mode development` 不够：Vite 折 `import.meta.env.DEV` 看的是 NODE_ENV，
  // 不设置的话「开发构建」和生产构建产出逐字节相同，反向对照就成了自证。
  const env = { ...process.env, NODE_ENV: mode === "development" ? "development" : "production" };
  const result = spawnSync(process.execPath, [viteBin, "build", "--mode", mode,
    "--outDir", outDir, "--emptyOutDir", "--logLevel", "warn"], { cwd: appDir, stdio: "inherit", env });
  if (result.status !== 0) {
    console.error(`[isolation] ${mode} 构建失败（退出码 ${String(result.status)}），隔离结论无从谈起。`);
    process.exit(2);
  }
}

fs.rmSync(outRoot, { recursive: true, force: true });

const builds = {};
for (const [key, mode] of [["dev", "development"], ["prod", "production"]]) {
  const outDir = join(outRoot, key);
  console.log(`[isolation] 构建 ${key}（vite --mode ${mode}）…`);
  build(mode, outDir);
  builds[key] = { mode, outDir: relative(appDir, outDir), ...scan(outDir) };
}

fs.rmSync(outRoot, { recursive: true, force: true });

const dev = builds.dev;
const prod = builds.prod;
const problems = [];
if (!dev.productFound) problems.push("开发产物里连产品自己的串都没有，说明扫的不是装了工作台代码的产物");
// 反向对照要的是「这条路真的被注册进开发产物」，只搜到实验室自己的类名不算：
// chunk 泄漏时开发产物里也有那些串，但路由根本没注册，正负两边就都成了巧合。
if (!dev.hits.some((hit) => hit.marker === "assist-scenarios")) {
  problems.push("开发产物里搜不到 `assist-scenarios` 这条路由：开发构建没真的带上实验室，反向对照是空的，生产「搜不到」不能算结论");
}
if (!prod.productFound) problems.push("生产产物里找不到产品自己的串，说明这份产物本身不完整");
for (const hit of prod.hits) problems.push(`生产产物仍然带着实验室入口：${hit.marker} ← ${hit.file}`);

const evidence = { checkedAt: new Date().toISOString(), productMarker: PRODUCT_MARKER,
  labMarkers: LAB_MARKERS, dev, prod, problems };
fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(join(evidenceDir, "isolation.json"), JSON.stringify(evidence, null, 2), "utf8");

console.log(`[isolation] 开发构建 ${dev.fileCount} 个文件，命中实验室串 ${dev.hits.length} 处`);
console.log(`[isolation] 生产构建 ${prod.fileCount} 个文件，命中实验室串 ${prod.hits.length} 处`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`[isolation] ${problem}`);
  console.error(`[isolation] 隔离不成立。证据：${join(evidenceDir, "isolation.json")}`);
  process.exit(1);
}
console.log(`[isolation] 隔离成立：实验室只存在于开发构建。证据：${join(evidenceDir, "isolation.json")}`);
