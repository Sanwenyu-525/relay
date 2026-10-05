// 本地开发资料索引；不读取产品数据库，也不执行业务动作。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(SCRIPT_DIR, '..');
const CATALOG = 'docs/feature-map/catalog.json';
const ACCEPTANCE = 'docs/testing/overall-acceptance-2026-09-28.md';
const PROGRESS = 'CODEX_NEXT_STEP.md';
const TOKENS = 'docs/frontend/design-tokens.json';
const GROUPS = ['code', 'docs', 'prompts', 'tests'];
const SCAN_ROOTS = [
  ['apps/api/src', 'code'], ['apps/workbench/src', 'code'],
  ['apps/desktop/src-tauri/src', 'code'], ['apps/file-io-helper/src', 'code'],
  ['apps/api/migrations', 'code'], ['apps/api/test', 'tests'],
  ['apps/workbench/tests', 'tests'], ['apps/desktop/tests', 'tests'],
  ['docs', 'docs'], ['contracts', 'docs'], ['prompts', 'prompts'], ['scripts', 'code'],
];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', 'evidence', 'archive', 'mockups']);
const TEXT_FILE = /\.(?:md|json|mjs|js|jsx|ts|tsx|css|html|rs|sql|ps1|toml|py|yaml|yml)$/iu;
const slash = (value) => value.split(path.sep).join('/');
const plain = (value) => value.replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').replace(/[*`]/gu, '').trim();
const read = (root, name) => fs.readFileSync(sourceFile(root, name), 'utf8');

export function sourceFile(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || path.isAbsolute(name)
    || name.split('/').some((part) => !part || part === '.' || part === '..')
    || !TEXT_FILE.test(name) || /(?:^|\/)(?:\.env[^/]*|credentials?[^/]*|secrets?[^/]*)$/iu.test(name)) {
    throw new Error(`不允许的资料路径：${name}`);
  }
  const full = path.resolve(root, name);
  const real = fs.realpathSync(full);
  const relative = path.relative(fs.realpathSync(root), real);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)
    || !fs.statSync(real).isFile()) throw new Error(`资料不在工作区内：${name}`);
  return real;
}

// 当前文档使用的管道表格：保留转义管道及 inline code 中的管道。
export function tableCells(line) {
  if (!line.trim().startsWith('|')) return null;
  const cells = [];
  let cell = '', ticks = 0;
  for (let i = 1; i < line.length; i += 1) {
    const char = line[i];
    if (char === '\\' && line[i + 1] === '|') { cell += '|'; i += 1; }
    else if (char === '`') {
      const run = line.slice(i).match(/^`+/u)[0].length;
      if (!ticks) ticks = run; else if (ticks === run) ticks = 0;
      cell += '`'.repeat(run); i += run - 1;
    } else if (char === '|' && !ticks) { cells.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  if (cell.trim()) cells.push(cell.trim());
  return cells;
}

export function parseAcceptance(content) {
  const lines = content.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^##\s+当前功能验收表\s*$/u.test(line));
  if (start === -1) throw new Error('未找到「当前功能验收表」；停止猜测状态。');
  const rows = [];
  let header = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/u.test(lines[i])) break;
    const cells = tableCells(lines[i]);
    if (!cells) continue;
    if (cells.map(plain).join('|') === '功能|结论|已验证范围与依据|剩余项') { header = true; continue; }
    if (cells.every((cell) => /^:?-+:?$/u.test(cell))) continue;
    if (!header || cells.length < 4) throw new Error(`验收表第 ${i + 1} 行格式变化；请检查事实源。`);
    const [name, conclusion, evidence, ...tail] = cells.map(plain);
    rows.push({ name, conclusion, evidence, remaining: tail.join(' | '), kind: classifyConclusion(conclusion),
      source: ACCEPTANCE, line: i + 1, sourceWarning: cells.length !== 4 ? '源表列数不是四列；后续列合并展示，请核对原文。' : null });
  }
  if (!rows.length) throw new Error('当前功能验收表为空。');
  return rows;
}

export function classifyConclusion(value) {
  if (/^未通过/u.test(value)) return 'failed';
  if (/^未接入/u.test(value)) return 'unconnected';
  if (/^未验收/u.test(value)) return 'unverified';
  if (/部分通过|待|未验|未接入/u.test(value)) return 'partial';
  if (/^已通过|^已修复并复验/u.test(value)) return 'scoped-pass';
  return 'unverified';
}

export function parseStages(content) {
  const stages = [];
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const cells = tableCells(line);
    const id = cells?.[0].match(/^(M0[1-7]|N0[0-7])\b/u)?.[1];
    if (id && cells.length === 3) stages.push({ id, name: plain(cells[0]), status: plain(cells[1]), detail: plain(cells[2]), source: PROGRESS, line: index + 1 });
  }
  if (!stages.length) throw new Error('进度文档没有 M/N 阶段表；请检查事实源。');
  return stages;
}

function gitFacts(root) {
  const head = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--',
    'apps/api/src', 'apps/api/test', 'apps/api/migrations', 'apps/workbench/src', 'apps/workbench/tests',
    'apps/desktop/src-tauri/src', 'apps/desktop/tests', 'apps/file-io-helper/src', 'scripts', 'docs', 'contracts', 'prompts', 'README.md', PROGRESS, 'package.json'],
  { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  const changes = new Map();
  if (result.status === 0) {
    const entries = result.stdout.split('\0');
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (!entry) continue;
      changes.set(entry.slice(3), entry.slice(0, 2));
      if (/[RC]/u.test(entry.slice(0, 2))) i += 1;
    }
  }
  return { head: head.status === 0 ? head.stdout.trim() : null, changes, available: result.status === 0 };
}

function inventory(root) {
  const found = new Map();
  function walk(directory, kind) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) walk(full, kind);
      else if (entry.isFile() && TEXT_FILE.test(entry.name)) found.set(slash(path.relative(root, full)), kind);
    }
  }
  for (const [directory, kind] of SCAN_ROOTS) walk(path.join(root, directory), kind);
  for (const name of ['README.md', PROGRESS, CATALOG, TOKENS, 'package.json']) if (fs.existsSync(path.join(root, name))) found.set(name, 'docs');
  return found;
}

function tokenCss(document) {
  function resolve(name, seen = new Set()) {
    if (seen.has(name) || !document.tokens[name]) throw new Error(`无法解析 token：${name}`);
    const raw = document.tokens[name].$value;
    const alias = typeof raw === 'string' && raw.match(/^\{([^}]+)\}$/u);
    return alias ? resolve(alias[1], new Set([...seen, name])) : Array.isArray(raw) ? raw.join(', ') : String(raw);
  }
  return ':root{' + Object.keys(document.tokens).map((name) => `--relay-${name.replaceAll('.', '-')}:${resolve(name)};`).join('') + '}';
}

export function collectMap(root = ROOT) {
  const catalog = JSON.parse(read(root, CATALOG));
  if (catalog.version !== 1 || !Array.isArray(catalog.modules)) throw new Error('功能目录版本或 modules 无效。');
  const acceptance = parseAcceptance(read(root, ACCEPTANCE));
  const stages = parseStages(read(root, PROGRESS));
  const errors = [], ids = new Set(), referenced = new Map();
  const git = gitFacts(root);
  const candidates = inventory(root);
  const files = new Map();
  function fact(name, kind) {
    if (files.has(name)) return files.get(name);
    let value;
    try {
      const stat = fs.statSync(sourceFile(root, name));
      value = { path: name, kind, exists: true, modifiedAt: stat.mtime.toISOString(), size: stat.size, change: git.changes.get(name) ?? '' };
    } catch (error) { value = { path: name, kind, exists: false, error: error.message, change: git.changes.get(name) ?? '' }; }
    files.set(name, value);
    return value;
  }
  function register(id, label) {
    if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) || ids.has(id)) errors.push(`重复或无效 ID：${label} / ${id}`);
    ids.add(id);
  }
  const modules = catalog.modules.map((module) => {
    register(module.id, module.name);
    if (!Array.isArray(module.features) || !Array.isArray(module.stageIds)) throw new Error(`模块结构无效：${module.name}`);
    for (const id of module.stageIds) if (!stages.some((stage) => stage.id === id)) errors.push(`未知阶段：${module.name} / ${id}`);
    const features = module.features.map((feature) => {
      register(feature.id, feature.name);
      if (!['current', 'planned', 'research'].includes(feature.intent)) errors.push(`无效范围：${feature.name}`);
      const refs = {};
      for (const group of GROUPS) {
        if (!Array.isArray(feature[group])) throw new Error(`功能 ${feature.name} 缺 ${group} 数组。`);
        refs[group] = feature[group].map((name) => {
          if (typeof name !== 'string') throw new Error(`资料路径必须是字符串：${feature.name}`);
          const owners = referenced.get(name) ?? [];
          owners.push({ moduleId: module.id, featureId: feature.id, module: module.name, feature: feature.name, group });
          referenced.set(name, owners);
          const file = fact(name, group);
          if (!file.exists) errors.push(`资料缺失/不可读：${feature.name} → ${name}`);
          return file;
        });
      }
      if (!Array.isArray(feature.acceptance)) throw new Error(`功能 ${feature.name} 缺 acceptance 数组。`);
      const records = feature.acceptance.map((name) => {
        const row = acceptance.find((item) => item.name === name);
        if (!row) errors.push(`验收关联失效：${feature.name} → ${name}`);
        return row ?? { name, conclusion: '关联失效，待核对', kind: 'unverified', evidence: '', remaining: '', source: ACCEPTANCE, line: 7 };
      });
      return { ...feature, ...refs, acceptance: records };
    });
    return { ...module, features };
  });
  for (const [name, kind] of candidates) fact(name, kind);
  // 所有 HTTP 资料入口仅接受这个白名单；目录扫描不能将越界链接变成资料。
  const resources = [...files.values()].map((file) => ({ ...file, owners: referenced.get(file.path) ?? [] })).sort((a, b) => a.path.localeCompare(b.path));
  const features = modules.flatMap((module) => module.features);
  const result = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), root: slash(path.resolve(root)),
    git: { head: git.head, available: git.available }, modules, stages, acceptance, resources,
    diagnostics: [...new Set(errors)],
    summary: { modules: modules.length, features: features.length, relatedFiles: referenced.size,
      unlinkedFiles: resources.filter((file) => !file.owners.length).length,
      changedFiles: resources.filter((file) => file.change).length, acceptanceRecords: acceptance.length },
    cssTokens: tokenCss(JSON.parse(read(root, TOKENS))),
  };
  result.revision = createHash('sha256').update(JSON.stringify({ ...result, generatedAt: undefined })).digest('hex').slice(0, 16);
  return result;
}

export function renderPage(snapshot) {
  const safeJson = JSON.stringify(snapshot).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return fs.readFileSync(path.join(SCRIPT_DIR, 'feature-map/index.html'), 'utf8')
    .replace('/* DESIGN_TOKENS */', () => snapshot.cssTokens)
    .replace('/* MAP_CSS */', () => fs.readFileSync(path.join(SCRIPT_DIR, 'feature-map/styles.css'), 'utf8'))
    .replace('/* MAP_DATA */', () => `window.FEATURE_MAP = ${safeJson};`)
    .replace('/* MAP_CLIENT */', () => fs.readFileSync(path.join(SCRIPT_DIR, 'feature-map/client.js'), 'utf8'));
}

export function writeSnapshot(snapshot, root = ROOT) {
  const directory = path.join(root, 'output/feature-map');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'index.html'), renderPage(snapshot));
  fs.writeFileSync(path.join(directory, 'data.json'), JSON.stringify(snapshot, null, 2) + '\n');
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// 快照按请求重扫：页面选择检查间隔，无人访问时服务端不做任何后台工作。
export async function startServer({ root = ROOT, port = 4318 } = {}) {
  let snapshot = collectMap(root), scanError = null;
  writeSnapshot(snapshot, root);
  function refresh() {
    try {
      const next = collectMap(root);
      if (next.revision !== snapshot.revision) { writeSnapshot(next, root); snapshot = next; }
      scanError = null;
    } catch (error) { scanError = error.message; }
  }
  const server = http.createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.headers.host !== origin.slice(7) || (request.headers.origin && request.headers.origin !== origin)) {
      response.writeHead(403).end('仅允许本机同源读取。'); return;
    }
    if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }).end(); return; }
    const url = new URL(request.url, origin);
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'" };
    try {
      if (url.pathname === '/') {
        response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }).end(renderPage(snapshot));
      } else if (url.pathname === '/api/map') {
        refresh();
        response.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ...snapshot, live: true, scanError }));
      } else if (url.pathname === '/source') {
        const name = url.searchParams.get('path');
        if (!snapshot.resources.some((file) => file.path === name && file.exists)) { response.writeHead(404).end('资料不在索引内。'); return; }
        const source = read(root, name);
        const lines = source.split(/\r?\n/u).map((line, i) => `<span id="L${i + 1}"><a href="#L${i + 1}">${i + 1}</a> ${escapeHtml(line)}</span>`).join('\n');
        response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' })
          .end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(name)}</title><style>${snapshot.cssTokens}body{background:var(--relay-color-bg-canvas);color:var(--relay-color-text-primary);font-family:var(--relay-font-family-ui);margin:24px}pre{font:14px/1.7 var(--relay-font-family-code);white-space:pre-wrap;overflow-wrap:anywhere}pre span:target{background:var(--relay-color-selection-bg)}a{color:var(--relay-color-action-text)}pre a{display:inline-block;min-width:4ch;text-align:right;margin-right:16px}</style><a href="/">← 功能地图</a><h2>${escapeHtml(name)}</h2><p>工作区原文 · 只读 · 修改后刷新可查看最新内容</p><pre>${lines}</pre></html>`);
      } else { response.writeHead(404).end('Not found'); }
    } catch (error) { response.writeHead(500, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }).end(`读取失败：${error.message}`); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, refresh, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => !['--serve', '--check'].includes(arg) && !/^--port=\d+$/u.test(arg))) throw new Error('用法：node scripts/feature-map.mjs [--serve [--port=4318] | --check]');
    if (args.includes('--serve') && args.includes('--check')) throw new Error('--serve 与 --check 不能同时使用。');
    if (args.includes('--serve')) {
      const port = Number(args.find((arg) => arg.startsWith('--port='))?.slice(7) ?? 4318);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口应在 1–65535 之间。');
      const live = await startServer({ port });
      console.log(`功能地图：${live.url} · 检查间隔在页面右上角选择 · Ctrl+C 停止`);
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => live.server.close(() => process.exit(0)));
    } else {
      const snapshot = collectMap();
      if (!args.includes('--check')) writeSnapshot(snapshot);
      console.log(`功能地图：${snapshot.summary.modules} 个模块 / ${snapshot.summary.features} 项功能 / ${snapshot.summary.relatedFiles} 个关联文件`);
      if (snapshot.diagnostics.length) { console.error(snapshot.diagnostics.join('\n')); process.exitCode = 1; }
      else console.log(args.includes('--check') ? '目录关系检查通过。' : '已生成 output/feature-map/index.html 与 data.json。');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
