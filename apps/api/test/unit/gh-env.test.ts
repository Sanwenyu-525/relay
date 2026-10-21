import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { githubEnv } from '../../src/github/gh-env.js';
import { ghProbeEnvironment, githubRuntimeStatus } from '../../src/plugins/runtime-status.js';

// 2026-10-21：Windows 上 `gh` 的登录凭据在 %APPDATA%\GitHub CLI\hosts.yml。
// 插件状态探测若少给 APPDATA/LOCALAPPDATA，gh 连自己的凭据文件都看不到
// （实测：带 APPDATA 时 gh 读出账号，去掉后说「没有登录到任何 GitHub 主机」），
// 于是已 `gh auth login` 的用户在界面被误报成未登录。

test('gh 子进程环境带齐 Windows 上定位凭据存储所需的键', () => {
  const env = githubEnv();
  assert.equal(env.APPDATA, process.env.APPDATA ?? '');
  assert.equal(env.LOCALAPPDATA, process.env.LOCALAPPDATA ?? '');
  assert.equal(env.USERPROFILE, process.env.USERPROFILE ?? '');
  assert.equal(env.HOME, process.env.USERPROFILE ?? process.env.HOME ?? '');
  assert.equal(env.GH_PROMPT_DISABLED, '1', '缺凭据时 gh 必须直接失败，不能挂在交互提示上');
});

test('白名单不转发未知环境变量，也不转发 token', () => {
  process.env.RELAY_TEST_UNKNOWN_ENV = 'marker';
  process.env.GH_TOKEN = 'should-not-be-forwarded';
  try {
    const env = githubEnv();
    assert.equal('RELAY_TEST_UNKNOWN_ENV' in env, false, '未知环境变量不得进入会访问网络的子进程');
    assert.equal(env.GH_TOKEN, undefined);
  } finally {
    delete process.env.RELAY_TEST_UNKNOWN_ENV;
    delete process.env.GH_TOKEN;
  }
});

test('插件状态探测与实际适配器用同一份子进程环境', () => {
  assert.deepEqual(ghProbeEnvironment(), githubEnv());
});

/** 本机 runtime-cache 里的 gh；没有就跳过这条（不伪造 gh 的行为）。 */
function localGhExecutable(): string | null {
  const root = join(process.cwd(), '..', '..', '.research', 'runtime-cache');
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith('gh-')) continue;
    const candidate = join(root, entry, 'bin', process.platform === 'win32' ? 'gh.exe' : 'gh');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

test('探测能分清「没有登录」与「凭据存在但不可用」：APPDATA 决定 gh 能否看到自己的凭据', async () => {
  if (process.platform !== 'win32') return;
  const gh = localGhExecutable();
  if (gh === null) return; // 本机没有 gh：跳过，不伪造服务商行为。
  const tempRoot = await mkdtemp(join(tmpdir(), 'relay-gh-env-'));
  const previous = {
    path: process.env.RELAY_GH_PATH, appdata: process.env.APPDATA, local: process.env.LOCALAPPDATA,
  };
  try {
    mkdirSync(join(tempRoot, 'GitHub CLI'), { recursive: true });
    writeFileSync(join(tempRoot, 'GitHub CLI', 'hosts.yml'),
      'version: 1\ngithub.com:\n    oauth_token: gho_fake_token\n    user: probe-user\n'
      + '    git_protocol: https\n');
    process.env.RELAY_GH_PATH = gh;
    // APPDATA 到位：gh 读得到自己的凭据文件，于是报「凭据存在但不可用」而不是「没登录」。
    process.env.APPDATA = tempRoot;
    process.env.LOCALAPPDATA = tempRoot;
    const withStore = await githubRuntimeStatus(20_000);
    assert.match(withStore.detail, /凭据/u,
      'APPDATA 到位时 gh 必须能读出自己的凭据文件，探测不能报成「没有登录」');
    // APPDATA 缺失：gh 看不到凭据文件，探测如实报「没有登录」。
    process.env.APPDATA = '';
    process.env.LOCALAPPDATA = '';
    const withoutStore = await githubRuntimeStatus(20_000);
    assert.match(withoutStore.detail, /没有登录/u);
  } finally {
    if (previous.path === undefined) delete process.env.RELAY_GH_PATH;
    else process.env.RELAY_GH_PATH = previous.path;
    if (previous.appdata === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previous.appdata;
    if (previous.local === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous.local;
    await rm(tempRoot, { recursive: true, force: true });
  }
});
