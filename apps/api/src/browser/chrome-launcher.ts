/**
 * Relay 自有的 Chrome 实例（F26）。
 *
 * 为什么由 Relay 拉 Chrome 而不是让上游 MCP 自己拉（docs/architecture/browser-automation-v1.md §3.2）：
 * 上游默认模式下 chrome.exe 是 MCP 的子进程，MCP 崩溃后浏览器成孤儿，取消与退出都无法
 * 确定性清理。这里由 Relay 持有 PID、端口与 profile 目录，MCP 只作为客户端经
 * `--browserUrl` 附着。
 *
 * 安全边界：
 *   * profile 固定落在数据根下（`<data-root>/browser/profile`），**不读写用户默认 Chrome 配置**；
 *   * 调试端口用 `--remote-debugging-port=0` 由系统分配，只监听 loopback；
 *   * 端口从 profile 目录里的 `DevToolsActivePort` 读取，不做端口猜测、不写死 9222；
 *   * 不安装扩展、不改注册表、不改 PATH。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { BROWSER_CHROME_START_TIMEOUT_MS } from './config.js';
import { BrowserBackendError } from './mcp-client.js';

export interface ChromeProcessLike {
  readonly pid?: number | undefined;
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  on(event: 'exit' | 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(): boolean;
}

export type SpawnChrome = (executable: string, args: readonly string[]) => ChromeProcessLike;

export interface ChromeInstance {
  /** 真实调试端口（由 `DevToolsActivePort` 读出）。 */
  readonly port: number;
  readonly pid: number | null;
  readonly profileDir: string;
  readonly executable: string;
  isAlive(): boolean;
  /** 关闭浏览器；先礼貌 kill，超时后强杀进程树。幂等。 */
  close(): Promise<void>;
}

export interface LaunchChromeInput {
  readonly executable: string;
  readonly profileDir: string;
  readonly headless?: boolean;
  readonly timeoutMs?: number;
  /** 测试接缝。 */
  readonly spawnProcess?: SpawnChrome;
  /** 诊断：进程 stderr 的行回调。 */
  readonly onStderr?: (line: string) => void;
}

const DEVTOOLS_PORT_FILE = 'DevToolsActivePort';

/**
 * 启动 Chrome 并等到调试端口可用。
 *
 * 失败一律抛 `BrowserBackendError`：`BROWSER_CHROME_MISSING`（文件不存在）或
 * `BROWSER_CHROME_START_FAILED`（进程退出、端口文件未写出）。调用方据此给用户
 * 可操作的诊断，而不是抛原始栈。
 */
export async function launchChrome(input: LaunchChromeInput): Promise<ChromeInstance> {
  if (!existsSync(input.executable)) {
    throw new BrowserBackendError('BROWSER_CHROME_MISSING',
      `未找到 Chrome：${input.executable}`);
  }
  await mkdir(input.profileDir, { recursive: true });
  const portFile = join(input.profileDir, DEVTOOLS_PORT_FILE);
  // 上一次异常退出可能留下旧端口：先删掉，避免读到过期值连到别的实例。
  await rm(portFile, { force: true });

  const args = [
    `--user-data-dir=${input.profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-features=Translate,MediaRouter',
    ...(input.headless === true ? ['--headless=new', '--disable-gpu'] : []),
    'about:blank',
  ];
  const spawnProcess: SpawnChrome = input.spawnProcess ?? defaultSpawnChrome;
  let child: ChromeProcessLike;
  try {
    child = spawnProcess(input.executable, args);
  } catch (error) {
    throw new BrowserBackendError('BROWSER_CHROME_START_FAILED',
      `无法启动 Chrome：${error instanceof Error ? error.message : String(error)}`);
  }

  let exited = false;
  let exitCode: number | null = null;
  child.on('exit', (code) => { exited = true; exitCode = code; });
  child.on('error', (error) => {
    exited = true;
    input.onStderr?.(`chrome spawn error: ${error.message}`);
  });
  // stderr 必须被消费：管道写满会阻塞 Chrome，且失败时的原因就写在这里。
  const stderrTail: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      const text = line.trim();
      if (text === '') continue;
      stderrTail.push(text);
      if (stderrTail.length > 20) stderrTail.shift();
      input.onStderr?.(text.slice(0, 300));
    }
  });

  const timeoutMs = input.timeoutMs ?? BROWSER_CHROME_START_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      throw new BrowserBackendError('BROWSER_CHROME_START_FAILED',
        `Chrome 启动后立即退出（exit=${exitCode ?? 'unknown'}）。` +
        (stderrTail.length === 0 ? ''
          : ` 最后输出：${stderrTail.slice(-3).join(' / ')}`) +
        ' 常见原因：profile 目录被另一个 Relay 实例占用，或 Chrome 安装损坏。');
    }
    if (existsSync(portFile)) {
      const port = await readDevToolsPort(portFile);
      if (port !== null) {
        return makeInstance({ child, port, profileDir: input.profileDir,
          executable: input.executable });
      }
    }
    await delay(150);
  }
  try { child.kill(); } catch { /* 已退出 */ }
  throw new BrowserBackendError('BROWSER_CHROME_START_FAILED',
    `Chrome 在 ${timeoutMs} ms 内没有写出调试端口（${DEVTOOLS_PORT_FILE}）。` +
    (stderrTail.length === 0 ? '' : ` 最后输出：${stderrTail.slice(-3).join(' / ')}`));
}

async function readDevToolsPort(path: string): Promise<number | null> {
  try {
    const text = await readFile(path, 'utf8');
    const first = text.split('\n')[0]?.trim() ?? '';
    const port = Number(first);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

function makeInstance(input: { child: ChromeProcessLike; port: number; profileDir: string;
  executable: string }): ChromeInstance {
  let alive = true;
  input.child.on('exit', () => { alive = false; });
  return {
    port: input.port,
    pid: input.child.pid ?? null,
    profileDir: input.profileDir,
    executable: input.executable,
    isAlive: () => alive,
    close: async () => {
      if (!alive) return;
      alive = false;
      try { input.child.kill(); } catch { /* 已退出 */ }
      // Chrome 的子进程（渲染器/GPU）通常随主进程退出；主进程不退时强杀进程树。
      await delay(1500);
      if (input.child.pid !== undefined && process.platform === 'win32') {
        await killTree(input.child.pid);
      }
    },
  };
}

/** Windows 上强杀进程树：只用 taskkill，不引入额外依赖。 */
async function killTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      const killer: ChildProcess = spawn('taskkill', ['/PID', String(pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true });
      killer.on('exit', () => resolve());
      killer.on('error', () => resolve());
    } catch {
      resolve();
    }
  });
}

function defaultSpawnChrome(executable: string, args: readonly string[]): ChromeProcessLike {
  return spawn(executable, [...args], { stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true, detached: false });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
