// 生成 preview.html 追加用的原型图清单。运行：node scripts/preview-gallery.mjs
// 只收录 preview.html 里还没手写登记的图片，按文件所在目录分组追加，不改动手写分组。
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CODEX = process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? "", ".codex");

const ROOTS = [
  "docs/frontend/mockups",
  "output/acceptance-raw",
  "tauri_icons_B_taskcards/preview"
];
const SKIP_DIR = /^(?:node_modules|\.git|\.research|dist|coverage|test-results|playwright-report|__pycache__|icons?|src-tauri)$|-(?:frozen|build)(?:-|$)|^build(?:-|$)|playwright/iu;
const IMAGE = /\.(?:png|jpe?g|webp)$/iu;
const SESSION = /\.jsonl$/u;
const DATE_DIR = /\d{4}-\d{2}-\d{2}/u;

const known = new Set(
  [...readFileSync(join(ROOT, "preview.html"), "utf8").matchAll(/f: "([^"]+)"/gu)].map((match) => "docs/frontend/mockups/" + match[1])
);

function walk(dir, pattern, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR.test(entry.name)) walk(full, pattern, found);
    } else if (pattern.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

// Codex 生成图按会话分目录，只有 cwd 为本项目的会话才算本项目产物。
function firstLine(file) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 8192 });
    stream.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end !== -1) { stream.destroy(); resolve(buffer.slice(0, end)); }
    });
    stream.on("end", () => resolve(buffer));
    stream.on("error", reject);
  });
}

const slash = (value) => value.split(sep).join("/").toLowerCase();

async function codexShots() {
  const sessions = join(CODEX, "sessions");
  const images = join(CODEX, "generated_images");
  if (!existsSync(sessions) || !existsSync(images)) return [];
  const mine = new Set();
  for (const file of walk(sessions, SESSION)) {
    try {
      const meta = JSON.parse(await firstLine(file)).payload;
      if (meta?.session_id && slash(String(meta.cwd ?? "")) === slash(ROOT)) mine.add(meta.session_id);
    } catch { /* 会话文件损坏或格式变化，跳过 */ }
  }
  const found = [];
  for (const entry of readdirSync(images, { withFileTypes: true })) {
    if (entry.isDirectory() && mine.has(entry.name)) found.push(...walk(join(images, entry.name), IMAGE));
  }
  return found;
}

const pad = (n) => String(n).padStart(2, "0");
const byDir = new Map();

function add(rel, mtime, label, src) {
  if (known.has(rel)) return;
  const dir = rel.slice(0, rel.lastIndexOf("/") + 1);
  const day = (dir.match(DATE_DIR) ?? [""])[0] || `${mtime.getFullYear()}-${pad(mtime.getMonth() + 1)}-${pad(mtime.getDate())}`;
  if (!byDir.has(dir)) byDir.set(dir, []);
  byDir.get(dir).push({
    f: rel,
    ...(src ? { src } : {}),
    day,
    t: `${pad(mtime.getHours())}:${pad(mtime.getMinutes())}`,
    n: rel.slice(rel.lastIndexOf("/") + 1, rel.lastIndexOf(".")),
    d: label
  });
}

for (const root of ROOTS) {
  const abs = join(ROOT, root);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs, IMAGE)) {
    add(relative(ROOT, file).split(sep).join("/"), statSync(file).mtime, "脚本自动收录，时间为文件写入时间");
  }
}

// Codex 生成图在仓库外，src 只能用 file:// 绝对地址；按生成日期分组。
for (const file of await codexShots()) {
  const mtime = statSync(file);
  const day = `${mtime.mtime.getFullYear()}-${pad(mtime.mtime.getMonth() + 1)}-${pad(mtime.mtime.getDate())}`;
  add(`codex/${day}/${file.split(sep).pop()}`, mtime.mtime, "Codex 本项目会话生成图，原图在仓库外", "file:///" + slash(file));
}

const groups = [...byDir].map(([dir, shots]) => ({
  title: `自动收录 · ${dir}`,
  prefix: true,
  hint: "scripts/preview-gallery.mjs 扫描到的未登记图片，标题取文件名，时间为文件写入时间；路径已是仓库根起算。",
  shots: shots.sort((a, b) => (a.day + a.t).localeCompare(b.day + b.t))
}));

writeFileSync(join(ROOT, "preview-manifest.js"), "window.PREVIEW_EXTRA_GROUPS = " + JSON.stringify(groups, null, 2) + ";\n");
console.log(`preview-manifest.js：新增分组 ${groups.length} 个，新增图片 ${groups.reduce((n, g) => n + g.shots.length, 0)} 张（已登记 ${known.size} 张保持不变）`);