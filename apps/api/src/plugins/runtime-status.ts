/**
 * 插件运行时状态探测（2026-10-20，P0-2）。
 *
 * 目的只有一个：把「这个插件在这台机器上能不能用」与「这个项目是否允许它动手」分开。
 * 前者是安装级事实（装了没、配没配、登录没登录），后者是项目级授权，两者都不该靠
 * 用户去通用配置页猜。本文件只回答前者。
 *
 * 边界：
 * - 只做只读探测，不启动浏览器、不触发任何电脑动作、不改任何配置；
 * - `gh auth status` 用与适配器同一份显式环境白名单运行（含 `APPDATA`/`LOCALAPPDATA`，
 *   否则 Windows 上读不到 `%APPDATA%\GitHub CLI\hosts.yml`，会把已登录报成未登录），
 *   Relay 进程里的 token 不会被转发；
 * - 探测失败（未安装、超时、命令报错）都折成可说明的状态，不抛给路由。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

import { computerRuntimeExecutable, computerRuntimeMode, computerRuntimeUnavailableReason }
  from '../computer/config.js';
import { githubExecutable, githubExecutableHint } from '../github/gh-executable.js';
import { githubEnv } from '../github/gh-env.js';

export type PluginRuntimeState = 'READY' | 'NOT_INSTALLED' | 'NOT_PAIRED' | 'NOT_AUTHENTICATED'
  | 'UNAVAILABLE';

export interface PluginRuntimeStatus {
  readonly plugin: 'computer' | 'browser' | 'github';
  readonly state: PluginRuntimeState;
  readonly detail: string;
  readonly remediation: string | null;
}

/**
 * 电脑操控的运行时可用性。
 *
 * 打包版默认使用与 node.exe 同目录的随包运行时；`RELAY_COMPUTER_RUNTIME`（desktop.env
 * 或直接启动 API 的环境变量）可显式换路径。两者都找不到时，真实模式一定起不来。
 * mock 模式（仅测试）明确标注，避免把测试数据当成真机可用。
 */
export function computerRuntimeStatus(): PluginRuntimeStatus {
  if (computerRuntimeMode() === 'mock') {
    return { plugin: 'computer', state: 'READY',
      detail: '测试模式（mock）运行；返回的是测试数据，不是真机截图。', remediation: null };
  }
  const executable = computerRuntimeExecutable();
  if (process.platform !== 'win32') {
    return { plugin: 'computer', state: 'UNAVAILABLE', detail: computerRuntimeUnavailableReason(),
      remediation: '电脑操控只能在 Windows 桌面版使用。' };
  }
  if (!existsSync(executable)) {
    return { plugin: 'computer', state: 'NOT_PAIRED',
      detail: `没有找到电脑运行时：${executable}`,
      remediation: '通过桌面版打开应用会带上随包运行时；自行启动 API 时请设置 RELAY_COMPUTER_RUNTIME。' };
  }
  return { plugin: 'computer', state: 'READY', detail: '电脑运行时已就位，可执行截图与输入。',
    remediation: null };
}

/**
 * 探测 `gh` 时用的子进程环境。
 *
 * 与实际适配器共用同一份白名单（`github/gh-env.ts`）：Windows 上 `gh` 的登录凭据在
 * `%APPDATA%\GitHub CLI\hosts.yml`，探测少了 `APPDATA`/`LOCALAPPDATA` 就读不到自己的
 * 凭据，会把已登录的用户报成「未登录」。
 */
export function ghProbeEnvironment(): NodeJS.ProcessEnv {
  return githubEnv();
}

/** `gh` 的安装与登录状态：只跑两条只读命令，超时即如实报告未知。 */
async function runGh(args: readonly string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(githubExecutable(), [...args], {
      timeout: timeoutMs,
      windowsHide: true,
      env: ghProbeEnvironment(),
    }, (error, _stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number'
        ? (error as { code: number }).code : 1;
      resolve({ code, stderr: String(stderr ?? '') });
    });
  });
}

/**
 * `gh auth status` 失败时的归类。
 *
 * 「压根没找到登录凭据」与「找到了但这份凭据不可用」是两件事：前者要 `gh auth login`，
 * 后者多半是 token 失效或权限不足。不分两者的后果是——探测读不到自己的凭据文件时，
 * 用户看到的也是同一句「没有登录」，于是既误导人也无从排查。
 */
function classifyGhAuthFailure(stderr: string): { detail: string; remediation: string } {
  const text = stderr.toLowerCase();
  if (text.includes('not logged into any github hosts')) {
    return { detail: 'GitHub CLI 已安装，但当前没有登录。',
      remediation: '在终端执行 gh auth login 完成登录；凭据由 gh 自己保管，不经过 Relay。' };
  }
  if (text.includes('hosts.yml') || text.includes('token')) {
    return { detail: 'GitHub CLI 已找到登录凭据，但当前这份凭据不可用（已失效或权限不足）。',
      remediation: '在终端执行 gh auth status 查看详情；必要时执行 gh auth login 重新登录。' };
  }
  return { detail: 'GitHub CLI 已安装，但登录状态探测没有给出可用结论。',
    remediation: '在终端执行 gh auth status 查看详情；必要时执行 gh auth login 重新登录。' };
}

export async function githubRuntimeStatus(timeoutMs = 8000): Promise<PluginRuntimeStatus> {
  const version = await runGh(['--version'], timeoutMs);
  if (version.code !== 0) {
    return { plugin: 'github', state: 'NOT_INSTALLED',
      detail: '没有找到可执行的 GitHub CLI（gh）。', remediation: githubExecutableHint() };
  }
  const auth = await runGh(['auth', 'status'], timeoutMs);
  if (auth.code !== 0) {
    const classified = classifyGhAuthFailure(auth.stderr);
    return { plugin: 'github', state: 'NOT_AUTHENTICATED',
      detail: classified.detail, remediation: classified.remediation };
  }
  return { plugin: 'github', state: 'READY', detail: 'GitHub CLI 已安装并已登录。', remediation: null };
}
