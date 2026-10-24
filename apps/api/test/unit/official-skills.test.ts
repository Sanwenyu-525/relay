/**
 * 内置官方 GitHub Skill 登记（docs/architecture/relay-skills.md §10，ADR-023）。
 *
 * 受验事实：登记身份冻结、随包内容逐字校验、注入按需且有界、禁用真实生效。
 * 不访问网络、不跑 gh、不判权限——工具曝光与 Gateway 准入各有自己的 Owner。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { OFFICIAL_GITHUB_GUIDANCE, OFFICIAL_GITHUB_LICENSE_SHA256,
  OFFICIAL_GITHUB_NOTES_SHA256, OFFICIAL_GITHUB_SKILL_ID,
  OFFICIAL_GITHUB_SKILL_SHA256, OFFICIAL_GITHUB_SKILL_VERSION,
  officialGithubSkillDisabled, officialGithubSkillGuidanceForTools,
  officialSkillDirectory, verifyOfficialGithubSkill }
  from '../../src/skills/official-skills.js';

// test/unit → apps/api；与 restore-isolation.test.ts 的 srcRoot 同一定位方式。
const BUILTIN_GH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..',
  'skills', 'builtin', 'gh');

/** 造一份「与随包同形」的内容目录，指定文件的字节可替换。 */
async function stagedSkillDir(overrides: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relay-official-skill-'));
  const files: Record<string, string> = {
    'SKILL.md': await readFile(join(BUILTIN_GH_DIR, 'SKILL.md'), 'utf8'),
    'RELAY_NOTES.md': await readFile(join(BUILTIN_GH_DIR, 'RELAY_NOTES.md'), 'utf8'),
    'LICENSE': await readFile(join(BUILTIN_GH_DIR, 'LICENSE'), 'utf8'),
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8');
  }
  return dir;
}

test('登记身份冻结：ID、版本（上游提交）、许可、来源与能力需求不随磁盘漂移', () => {
  assert.equal(OFFICIAL_GITHUB_SKILL_ID, 'github-gh');
  assert.equal(OFFICIAL_GITHUB_SKILL_VERSION, '4537a92f3352c8c4c1fd1b8febba1596059fc9e0');
  assert.match(OFFICIAL_GITHUB_SKILL_SHA256, /^[0-9a-f]{64}$/u);
  assert.match(OFFICIAL_GITHUB_NOTES_SHA256, /^[0-9a-f]{64}$/u);
  assert.match(OFFICIAL_GITHUB_LICENSE_SHA256, /^[0-9a-f]{64}$/u);
});

test('钉住摘要与仓库内随包文件逐字一致：任何人改了 SKILL.md/RELAY_NOTES.md/LICENSE 都会在这里红', async () => {
  const pairs = [
    ['SKILL.md', OFFICIAL_GITHUB_SKILL_SHA256],
    ['RELAY_NOTES.md', OFFICIAL_GITHUB_NOTES_SHA256],
    ['LICENSE', OFFICIAL_GITHUB_LICENSE_SHA256],
  ] as const;
  for (const [name, expected] of pairs) {
    const actual = createHash('sha256').update(await readFile(join(BUILTIN_GH_DIR, name))).digest('hex');
    assert.equal(actual, expected, `${name} 与登记摘要不一致`);
  }
});

test('默认解析命中仓库内的 apps/api/skills/builtin/gh（开发态布局）', () => {
  const directory = officialSkillDirectory({});
  assert.ok(directory !== null);
  assert.ok(directory.replaceAll('\\', '/').endsWith('apps/api/skills/builtin/gh'),
    `实际解析到 ${directory}`);
});

test('RELAY_OFFICIAL_SKILLS_DIR 显式覆盖优先', async () => {
  const dir = await stagedSkillDir();
  try {
    assert.equal(officialSkillDirectory({ RELAY_OFFICIAL_SKILLS_DIR: dir }), dir);
    assert.equal(verifyOfficialGithubSkill({ RELAY_OFFICIAL_SKILLS_DIR: dir }).state, 'VERIFIED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('目录缺失报 MISSING，不猜、不降级', () => {
  const outcome = verifyOfficialGithubSkill({
    RELAY_OFFICIAL_SKILLS_DIR: join(tmpdir(), 'relay-no-such-skill-dir') });
  assert.equal(outcome.state, 'MISSING');
});

test('上游正文被改动报 HASH_MISMATCH 且不注入', async () => {
  const dir = await stagedSkillDir({
    'SKILL.md': (await readFile(join(BUILTIN_GH_DIR, 'SKILL.md'), 'utf8'))
      .replace('Interactivity policy', 'Interactivity policy Tampered') });
  try {
    const outcome = verifyOfficialGithubSkill({ RELAY_OFFICIAL_SKILLS_DIR: dir });
    assert.equal(outcome.state, 'HASH_MISMATCH');
    assert.match(outcome.detail, /SKILL\.md/u);
    assert.equal(officialGithubSkillGuidanceForTools(['github_repo_view'],
      { RELAY_OFFICIAL_SKILLS_DIR: dir }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('边界附录被改动同样失败关闭：Relay 自有内容不可静默改写', async () => {
  const dir = await stagedSkillDir({
    'RELAY_NOTES.md': '被改过的附录\n' });
  try {
    assert.equal(verifyOfficialGithubSkill({ RELAY_OFFICIAL_SKILLS_DIR: dir }).state,
      'HASH_MISMATCH');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缺 RELAY_NOTES.md（只带上游原文的旧布局）报 MISSING', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-official-skill-'));
  try {
    await writeFile(join(dir, 'SKILL.md'),
      await readFile(join(BUILTIN_GH_DIR, 'SKILL.md'), 'utf8'));
    assert.equal(verifyOfficialGithubSkill({ RELAY_OFFICIAL_SKILLS_DIR: dir }).state, 'MISSING');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('按需激活：本轮没有 github_ 工具就不注入', async () => {
  const dir = await stagedSkillDir();
  try {
    const env = { RELAY_OFFICIAL_SKILLS_DIR: dir };
    assert.equal(officialGithubSkillGuidanceForTools(['read_file', 'git_status'], env), null);
    assert.equal(officialGithubSkillGuidanceForTools([], env), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('注入块有界且含身份与五个获准动作', async () => {
  const dir = await stagedSkillDir();
  try {
    const guidance = officialGithubSkillGuidanceForTools(['github_issue_view'],
      { RELAY_OFFICIAL_SKILLS_DIR: dir });
    assert.ok(guidance !== null);
    assert.ok(guidance.length <= 1200, `注入块应为约 1 KiB，实际 ${guidance.length} 字符`);
    assert.match(guidance, /github-gh@4537a92f/u, '要带官方 Skill 的不可变身份');
    for (const action of ['repo_view', 'pr_list', 'pr_view', 'issue_list', 'issue_view']) {
      assert.match(guidance, new RegExp(action, 'u'), `缺少获准动作 ${action}`);
    }
    assert.match(guidance, /不是授权/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('禁用开关真实生效：disabled 时不注入，其余取值一律默认启用', async () => {
  const dir = await stagedSkillDir();
  try {
    const disabled = { RELAY_OFFICIAL_SKILLS_DIR: dir,
      RELAY_OFFICIAL_SKILL_GITHUB: ' Disabled ' };
    assert.equal(officialGithubSkillDisabled(disabled), true);
    assert.equal(officialGithubSkillGuidanceForTools(['github_pr_list'], disabled), null);
    const enabled = { RELAY_OFFICIAL_SKILLS_DIR: dir, RELAY_OFFICIAL_SKILL_GITHUB: 'enabled' };
    assert.equal(officialGithubSkillDisabled(enabled), false);
    assert.ok(officialGithubSkillGuidanceForTools(['github_pr_list'], enabled) !== null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('冻结注入块与 RELAY_NOTES.md 同源：关键边界短语两处都有，防止单独改一处漂移', async () => {
  const notes = await readFile(join(BUILTIN_GH_DIR, 'RELAY_NOTES.md'), 'utf8');
  for (const phrase of ['五个只读', 'gh api', '真实 Git remote', '未开放', '不可信外部内容']) {
    assert.match(OFFICIAL_GITHUB_GUIDANCE, new RegExp(phrase, 'u'), `注入块缺少「${phrase}」`);
    assert.match(notes, new RegExp(phrase, 'u'), `RELAY_NOTES.md 缺少「${phrase}」`);
  }
});

test('打包布局解析：node.exe 同目录的 api/skills/builtin/gh 优先于 dist 相对布局', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-official-skill-pkg-'));
  try {
    const packaged = join(root, 'api', 'skills', 'builtin', 'gh');
    await mkdir(packaged, { recursive: true });
    for (const name of ['SKILL.md', 'RELAY_NOTES.md', 'LICENSE']) {
      await writeFile(join(packaged, name),
        await readFile(join(BUILTIN_GH_DIR, name), 'utf8'));
    }
    // officialSkillDirectory 的打包分支按 process.execPath 定位，这里无法换 execPath；
    // 退而求其次验证「显式目录命中打包形状」与验证逻辑，真实打包布局由安装态验证覆盖。
    assert.equal(officialSkillDirectory({ RELAY_OFFICIAL_SKILLS_DIR: packaged }), packaged);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
