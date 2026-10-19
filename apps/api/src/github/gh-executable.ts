/**
 * `gh` 可执行文件的解析（ADR-023 首片）。
 *
 * 为什么单独成文件：解析顺序是「用户机器上到底跑的是哪个 gh」的唯一事实，
 * 适配器、诊断文案与测试都要看同一份结论。与 `computer-runtime`、
 * `file-io-helper` 的先例一致，顺序是：
 *
 *   1. `RELAY_GH_PATH`——显式覆盖，开发态指到解包目录（`.research/runtime-cache/…`），
 *      也是将来桌面端注入随包 sidecar 的入口；
 *   2. Node 可执行文件同目录的 `gh.exe`（安装态：随包资源与 node.exe 放在一起）；
 *   3. `PATH` 里的 `gh`——用户自己用 winget/scoop/官方安装包装的那个。
 *
 * 不在这里做「装没装、登录没登录」的判断：那是适配器的失败归类（`GH_CLI_UNAVAILABLE`
 * / `GH_UNAUTHENTICATED`）。这里只回答「该执行哪个文件」。
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 随包 sidecar 的文件名：Windows 是 `gh.exe`，其它平台按无扩展名处理。 */
export function ghSidecarName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'gh.exe' : 'gh';
}

/** 随包 sidecar 的预期位置（与 node.exe 同目录）。 */
export function ghSidecarPath(): string {
  return join(dirname(process.execPath), ghSidecarName());
}

/**
 * 解析要执行的 `gh`。
 *
 * 返回值要么是绝对路径，要么是裸命令名（交给 PATH 解析）——两种情况都由
 * `execFile` 直接使用，调用方不需要再判断。
 */
export function githubExecutable(env: NodeJS.ProcessEnv = process.env,
  sidecar: string = ghSidecarPath()): string {
  const explicit = env.RELAY_GH_PATH;
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
  if (existsSync(sidecar)) return sidecar;
  return ghSidecarName();
}

/**
 * 给「找不到 gh」的失败文案用：把查找位置写出来。
 *
 * 只说「请安装 gh」是不够的——用户可能已经装了，只是不在 PATH 里；也可能
 * 桌面端没把 sidecar 放对位置。列出实际查过的位置，才能让人自己判断是哪一种。
 */
export function githubExecutableHint(env: NodeJS.ProcessEnv = process.env,
  sidecar: string = ghSidecarPath()): string {
  const explicit = env.RELAY_GH_PATH;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return `RELAY_GH_PATH 指向的 ${explicit.trim()} 无法执行 GitHub CLI（gh）；` +
      '请确认该路径存在且可运行，或清空该变量改用随包与 PATH 中的 gh。';
  }
  return `已查找随包的 ${sidecar} 与 PATH 中的 gh。可设置 RELAY_GH_PATH 指向 gh 的完整路径，` +
    '或安装 GitHub CLI 后执行 gh auth login。';
}
