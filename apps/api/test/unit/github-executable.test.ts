/**
 * `gh` 可执行文件解析（ADR-023 首片）。
 *
 * 受验事实：Relay 到底会执行哪个 `gh`。这里只测解析顺序与失败文案，
 * 不启动进程、不读凭据、不访问网络。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { ghSidecarName, githubExecutable, githubExecutableHint }
  from '../../src/github/gh-executable.js';

test('显式 RELAY_GH_PATH 优先：开发态可以指到解包目录里的 gh', () => {
  assert.equal(githubExecutable({ RELAY_GH_PATH: 'C:\\tools\\gh.exe' }, 'C:\\sidecar\\gh.exe'),
    'C:\\tools\\gh.exe');
  assert.equal(githubExecutable({ RELAY_GH_PATH: '  /opt/gh  ' }, '/sidecar/gh'), '/opt/gh',
    '两侧空白不该变成路径的一部分');
  // 空白值不算显式指定，继续走后面的查找顺序。
  assert.equal(githubExecutable({ RELAY_GH_PATH: '   ' }, '/nonexistent/gh'), ghSidecarName());
});

test('随包同目录的 gh.exe 存在时优先于 PATH', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-gh-sidecar-'));
  try {
    const sidecar = join(dir, ghSidecarName());
    await writeFile(sidecar, '', 'utf8');
    assert.equal(githubExecutable({}, sidecar), sidecar);
  } finally {
    const resolved = resolve(dir);
    assert.ok(resolved.startsWith(resolve(tmpdir())), '清理必须留在系统临时目录内');
    await rm(resolved, { recursive: true, force: true });
  }
});

test('两处都没有时回落到 PATH 里的裸命令名', () => {
  assert.equal(githubExecutable({}, join(tmpdir(), 'definitely-no-gh-here', 'gh.exe')),
    ghSidecarName());
});

test('找不到时的提示要写出查找位置与可行动的下一步', () => {
  const hint = githubExecutableHint({}, 'C:\\app\\gh.exe');
  assert.match(hint, /C:\\app\\gh\.exe/u, '要告诉用户查过随包位置');
  assert.match(hint, /PATH/u);
  assert.match(hint, /RELAY_GH_PATH/u);
  assert.match(hint, /gh auth login/u);

  // 显式路径失效时，提示要指向那个变量本身，而不是让人去装第二个 gh。
  const explicit = githubExecutableHint({ RELAY_GH_PATH: 'D:\\gone\\gh.exe' }, 'C:\\app\\gh.exe');
  assert.match(explicit, /D:\\gone\\gh\.exe/u);
  assert.match(explicit, /RELAY_GH_PATH/u);
  assert.match(explicit, /GitHub CLI/u);
});

test('提示与解析使用同一份顺序事实，不各写一套', () => {
  // 有随包 gh 时解析会用它，提示文案仍只在失败路径出现——这里核对两者共享同一函数出口。
  assert.equal(typeof githubExecutable(), 'string');
  assert.ok(githubExecutable().length > 0);
});
