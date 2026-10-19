/**
 * 取回固定版本的浏览器后端（chrome-devtools-mcp）并解包到本地缓存。
 *
 * 为什么是脚本而不是 npm 依赖：
 *   * 上游发布物是自包含的（无 runtime dependencies），不需要 npm 解析依赖树；
 *   * 安装包必须可复现——版本与完整性摘要都写死在这里，不用 `@latest`；
 *   * 离线构建时直接复用缓存，不依赖构建机网络。
 *
 * 用法：
 *   node scripts/fetch-browser-mcp.mjs           # 缺失时下载并解包
 *   node scripts/fetch-browser-mcp.mjs --verify  # 只校验已有缓存
 *
 * 产物：.research/runtime-cache/browser-mcp/<version>/package/（含 build/src/bin 入口）
 * 打包装箱时由 apps/desktop/scripts/build-release.ps1 复制到 src-tauri/resources/browser-mcp/。
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.11.0';
/** npm registry 公布的 integrity（sha512-base64）。换版本必须同时改这里与 VERSION。 */
const INTEGRITY = 'CytJ/5tnzrS+J/74be2P5aCOsS/mmGRHys/Si+IYC4ucrbnWAmES/dYdxGJjeUCECRcoFUilZAysdjlwqUjXIA==';
const TARBALL_URL = `https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-${VERSION}.tgz`;
const ENTRY_RELATIVE = join('build', 'src', 'bin', 'chrome-devtools-mcp.js');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheRoot = join(repoRoot, '.research', 'runtime-cache', 'browser-mcp');
const tarball = join(cacheRoot, `chrome-devtools-mcp-${VERSION}.tgz`);
const packageDir = join(cacheRoot, VERSION, 'package');
const entry = join(packageDir, ENTRY_RELATIVE);

const verifyOnly = process.argv.includes('--verify');

async function sha512Base64(path) {
  const buffer = await readFile(path);
  return createHash('sha512').update(buffer).digest('base64');
}

async function download() {
  console.log(`fetch ${TARBALL_URL}`);
  const response = await fetch(TARBALL_URL);
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha512').update(buffer).digest('base64');
  if (digest !== INTEGRITY) {
    throw new Error(`integrity mismatch: expected ${INTEGRITY}, got ${digest}`);
  }
  await mkdir(cacheRoot, { recursive: true });
  await writeFile(tarball, buffer);
  console.log(`saved ${tarball} (${buffer.length} bytes)`);
}

function extract() {
  return new Promise((resolvePromise, rejectPromise) => {
    // Windows 10+ 自带 bsdtar；与 build-release.ps1 一样不引入额外解包依赖。
    const child = spawn('tar', ['-xzf', tarball, '-C', join(cacheRoot, VERSION)],
      { stdio: 'inherit' });
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`tar exited ${code}`));
    });
  });
}

async function main() {
  if (!existsSync(tarball)) {
    if (verifyOnly) throw new Error(`tarball missing: ${tarball}`);
    await download();
  }
  const digest = await sha512Base64(tarball);
  if (digest !== INTEGRITY) {
    throw new Error(`cached tarball integrity mismatch: ${digest}. Delete ${tarball} and retry.`);
  }
  if (!existsSync(entry)) {
    if (verifyOnly) throw new Error(`entry missing: ${entry}`);
    await mkdir(join(cacheRoot, VERSION), { recursive: true });
    await extract();
  }
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  if (manifest.version !== VERSION) {
    throw new Error(`unexpected package version ${manifest.version}, expected ${VERSION}`);
  }
  if (manifest.license !== 'Apache-2.0') {
    throw new Error(`unexpected license ${manifest.license}; the bundled LICENSE must be preserved`);
  }
  if (!existsSync(join(packageDir, 'LICENSE'))) {
    throw new Error('LICENSE missing from the unpacked package');
  }
  console.log(`browser backend ready: ${VERSION} (Apache-2.0)`);
  console.log(`entry: ${entry}`);
  console.log(`set RELAY_BROWSER_MCP_ENTRY to the entry path when running the API outside the desktop host.`);
}

await main();
