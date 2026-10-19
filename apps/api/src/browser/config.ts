/**
 * 浏览器后端的进程与模式配置。
 *
 * 解析顺序与 `relay-computer-runtime` / `relay-file-io-helper` 的先例一致：显式环境变量
 * 优先，否则取 Node 可执行文件同目录的资源（桌面宿主通过 RELAY_BROWSER_MCP_ENTRY
 * 传入资源目录内的确切路径）。模式开关 BROWSER_MODE=mock 只用于 UI 与 Agent 流程测试：
 * mock 数据永远带 `mock: true` 标记，生产默认真实后端。
 */

import { dirname, join } from 'node:path';

export type BrowserMode = 'real' | 'mock';

/**
 * 浏览器后端选择（ADR-025）。
 *
 * `extension`（默认）= 用户现有 Chrome 里的桥接扩展；`cdp` = Relay 自有 Chrome +
 * chrome-devtools-mcp（保留给离线开发与对照测试，不复用用户登录态）。
 */
export type BrowserProviderKind = 'extension' | 'cdp';

export function browserProviderKind(): BrowserProviderKind {
  const value = process.env.RELAY_BROWSER_PROVIDER;
  return value !== undefined && value.toLowerCase() === 'cdp' ? 'cdp' : 'extension';
}

/** 读取运行模式。未设置或无法识别时按真实模式处理（失败关闭，不悄悄降级）。 */
export function browserMode(): BrowserMode {
  const value = process.env.BROWSER_MODE;
  return value !== undefined && value.toLowerCase() === 'mock' ? 'mock' : 'real';
}

/**
 * 上游后端的入口脚本（随包 node.exe 执行）。
 *
 * 缺省值与 `apps/desktop/src-tauri/resources/browser-mcp/` 的布局一致：桌面宿主把
 * 整个目录随包，并在启动 API 与 supervisor 时注入绝对路径。开发态由
 * `scripts/fetch-browser-mcp.mjs` 解包到 `.research/runtime-cache/browser-mcp/<version>/`，
 * 再通过环境变量指过去。
 */
export function browserMcpEntry(): string {
  const explicit = process.env.RELAY_BROWSER_MCP_ENTRY;
  if (explicit !== undefined && explicit !== '') return explicit;
  return join(dirname(process.execPath), 'browser-mcp', 'build', 'src', 'bin',
    'chrome-devtools-mcp.js');
}

/**
 * Chrome 可执行文件。
 *
 * 不随包 Chrome（体积与更新策略都不合适），使用用户已安装的稳定版。查找顺序：
 * 显式环境变量 → Windows 常见安装路径。都找不到时返回 null，由启动路径给出
 * BROWSER_CHROME_MISSING 与可操作建议，不尝试下载。
 */
export function chromeExecutable(): string | null {
  const explicit = process.env.RELAY_BROWSER_CHROME_PATH;
  if (explicit !== undefined && explicit !== '') return explicit;
  if (process.platform !== 'win32') return null;
  return CHROME_CANDIDATES.find((candidate) => candidate !== '') ?? null;
}

/**
 * Windows 上 Chrome 的默认安装位置。
 *
 * 这里只做「路径存在性」判断（`chrome-launcher` 负责），不读注册表：注册表读取会引入
 * 额外的权限与测试替身成本，而 Chrome 的安装位置在实践中只有这几种。
 */
const CHROME_CANDIDATES: readonly string[] = process.platform === 'win32'
  ? [
    join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google', 'Chrome',
      'Application', 'chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome',
      'Application', 'chrome.exe'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  : [];

/** Relay 自有 Chrome 的 profile 目录：放在数据根下，与用户日常 profile 完全分离。 */
export function browserProfileDir(dataRoot: string): string {
  return join(dataRoot, 'browser', 'profile');
}

/** 单次 MCP 请求超时。页面导航与等待可能较慢，但 60 秒已经远超正常交互。 */
export const BROWSER_REQUEST_TIMEOUT_MS = 60_000;

/** 启动 Chrome 并等待 `DevToolsActivePort` 的上限。 */
export const BROWSER_CHROME_START_TIMEOUT_MS = 30_000;

/** `tools/list` 自检与 MCP 握手的上限。 */
export const BROWSER_HANDSHAKE_TIMEOUT_MS = 20_000;
