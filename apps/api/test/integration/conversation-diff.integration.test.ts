import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { bindAssistSessionDirectory, createAssistSession }
  from '../../src/application/assist-commands.js';
import { openWorkingDirectory } from '../../src/application/open-working-directory.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import {
  establishConversationDiffBaseline,
  readConversationDiff,
  readConversationDiffFile,
} from '../../src/conversation-diff/net-diff-service.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';

/**
 * 会话局部与总 diff（工作台 §34、迁移 0097）的真实 PG + 真实临时 Git 仓库验证。
 *
 * 这里不替换任何 Fake：基线快照落真实 jsonb、目录绑定走真实受管资源、当前内容直接读
 * 临时工作树。要证明的语义是「本轮对话开始以来的净变化」这条口径本身——
 * 唯一有效起点、可统计的行数、展开正文与总数同源、不可用原因，以及换目录不跨段求和。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-conversation-diff');
const repositories = createRepositories(app.db);
/** 本文件创建的全部临时目录：根部即临时 Git 工作树，结束后一并删除。 */
const temporaryRoots: string[] = [];

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
});
after(async () => {
  for (const root of temporaryRoots) {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  await app.close();
});

const executeGit = promisify(execFile);
const LF = String.fromCharCode(10);

/** 失败信息里可能出现 baseline.revision（bigint），直接 JSON.stringify 会抛错掩盖真实断言。 */
function describe(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item);
}

/** 隔离用户全局 Git 配置，避免 core.autocrlf / filter 影响临时仓库的读写判定。 */
function gitEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: 'NUL',
    HOME: home,
    USERPROFILE: home,
  };
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

interface TemporaryRepo {
  readonly root: string;
  readonly git: (args: readonly string[]) => Promise<string>;
}

/** 真实临时 Git 仓库（无 commit 也可以：基线采集读的是索引与工作树）。 */
async function createGitRepo(): Promise<TemporaryRepo> {
  const root = await mkdtemp(join(tmpdir(), 'relay-cd-int-'));
  temporaryRoots.push(root);
  const environment = gitEnvironment(root);
  const git = async (args: readonly string[]): Promise<string> =>
    (await executeGit('git', ['-c', 'core.autocrlf=false', ...args], {
      cwd: root, env: environment, windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024,
    })).stdout;
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Relay Test']);
  await git(['config', 'user.email', 'fixture@local']);
  await git(['config', 'core.autocrlf', 'false']);
  return { root, git };
}

/** 一个工作空间 + 项目，够建 Assist 会话与受管资源即可（diff 不参与项目业务）。 */
async function workspaceFixture(): Promise<{ workspaceId: string; projectId: string }> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: `p97-${workspaceId}` });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId, title: 'P97 项目',
      projectType: 'GENERAL' });
    await r.projects.insertProjectState(projectId, 'PLANNING');
  });
  return { workspaceId, projectId };
}

async function newSession(workspaceId: string, projectId: string,
  title = '会话 diff 集成测试'): Promise<string> {
  const created = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId, taskId: null, title });
  return created.result.session_id;
}

interface OpenedDirectory {
  readonly projectId: string;
  readonly resourceId: string;
  readonly canonicalRoot: string;
}

/** 登记真实目录为受管资源；显式传项目，保证会话与资源同属一个项目。 */
async function openDirectory(workspaceId: string, projectId: string,
  rootPath: string): Promise<OpenedDirectory> {
  const opened = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(),
    rootPath, projectId });
  assert.equal(opened.result.status, 'READY', describe(opened.result));
  const association = opened.result.association;
  assert.ok(association !== null, '登记成功后必须给出受管资源关联');
  return { projectId: association.project_id, resourceId: association.resource_id,
    canonicalRoot: opened.result.canonical_root };
}

async function bindDirectory(workspaceId: string, sessionId: string,
  resourceId: string): Promise<void> {
  await bindAssistSessionDirectory(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), resourceId });
}

async function baselineRowCount(workspaceId: string, sessionId: string): Promise<number> {
  const result = await sql<{ count: string }>`select count(*)::text as count
    from conversation_diff_baselines
    where workspace_id = ${workspaceId} and session_id = ${sessionId}`.execute(app.db);
  return Number(result.rows[0]!.count);
}

test('基线幂等：同一会话同一根路径只发布一个有效起点', async () => {
  const f = await workspaceFixture();
  const sessionId = await newSession(f.workspaceId, f.projectId);
  const repo = await createGitRepo();
  await writeFile(join(repo.root, 'note.txt'), `alpha${LF}`);
  await repo.git(['add', '--', 'note.txt']);
  const directory = await openDirectory(f.workspaceId, f.projectId, repo.root);
  await bindDirectory(f.workspaceId, sessionId, directory.resourceId);

  const first = await establishConversationDiffBaseline(repositories,
    { workspaceId: f.workspaceId, sessionId });
  assert.equal(first.established, true, describe(first));
  assert.equal(first.reused, false);
  assert.equal(first.reason, 'CREATED');
  assert.ok(first.baseline !== null, '第一次建立必须返回落库后的基线');
  assert.equal(first.baseline.rootPath, directory.canonicalRoot);
  assert.equal(first.baseline.files.some((file) => file.path === 'note.txt'), true,
    '基线必须含真实工作树里的文件');

  const second = await establishConversationDiffBaseline(repositories,
    { workspaceId: f.workspaceId, sessionId });
  assert.equal(second.established, true, describe(second));
  assert.equal(second.reused, true);
  assert.equal(second.reason, 'REUSED');
  assert.equal(second.baseline?.id, first.baseline.id, '复用必须命中同一行，而不是再发一个起点');

  // 存储层事实：唯一约束与 on conflict do nothing 共同保证只有一条基线。
  assert.equal(await baselineRowCount(f.workspaceId, sessionId), 1);

  const readBack = await repositories.conversationDiff.readLatestBaseline(
    f.workspaceId, sessionId, directory.resourceId, directory.canonicalRoot);
  assert.equal(readBack?.id, first.baseline.id);
});

test('净变化：改已跟踪文件、建未跟踪文件、删文件后行数与动作都对得上', async () => {
  const f = await workspaceFixture();
  const sessionId = await newSession(f.workspaceId, f.projectId);
  const repo = await createGitRepo();
  await writeFile(join(repo.root, 'tracked.txt'), `one${LF}two${LF}`);
  await writeFile(join(repo.root, 'deleted.txt'), `gone-1${LF}gone-2${LF}`);
  await repo.git(['add', '--', 'tracked.txt', 'deleted.txt']);
  const directory = await openDirectory(f.workspaceId, f.projectId, repo.root);
  await bindDirectory(f.workspaceId, sessionId, directory.resourceId);

  const established = await establishConversationDiffBaseline(repositories,
    { workspaceId: f.workspaceId, sessionId });
  assert.equal(established.reason, 'CREATED', describe(established));

  // 已跟踪文件追加两行；未跟踪文件整文件新增三行；已跟踪文件从工作树删除。
  await writeFile(join(repo.root, 'tracked.txt'), `one${LF}two${LF}three${LF}four${LF}`);
  await writeFile(join(repo.root, 'created.txt'), `n1${LF}n2${LF}n3${LF}`);
  await rm(join(repo.root, 'deleted.txt'));
  // 会话口径：本会话没有落盘过任何路径（写账本为空），目录里的同期修改不得进这条统计。
  const sessionRead = await readConversationDiff(repositories,
    { workspaceId: f.workspaceId, sessionId });
  assert.equal(sessionRead.available, true, describe(sessionRead));
  if (sessionRead.available) {
    assert.equal(sessionRead.diff.scope, 'SESSION');
    assert.deepEqual(sessionRead.diff.files, [],
      '本会话一个路径都没写过时，别处改动的文件不能出现在「本次对话」里');
    assert.equal(sessionRead.diff.incomplete, false);
  }

  // 目录口径（工作详情「变更」页签）：同一份基线、同一套行规则，只是范围不同。
  const read = await readConversationDiff(repositories,
    { workspaceId: f.workspaceId, sessionId, scope: 'DIRECTORY' });
  assert.equal(read.available, true, describe(read));
  if (!read.available) return;
  const { diff } = read;

  assert.equal(diff.rootPath, directory.canonicalRoot);
  assert.equal(diff.scope, 'DIRECTORY');
  assert.equal(diff.incomplete, false);
  assert.equal(diff.coverage.uncheckedFiles, 0);
  assert.equal(diff.coverage.unverifiedFiles, 0);

  const byPath = new Map(diff.files.map((file) => [file.path, file]));
  const modified = byPath.get('tracked.txt');
  assert.equal(modified?.action, 'MODIFY');
  assert.equal(modified?.added, 2, '追加两行必须计为 +2');
  assert.equal(modified?.removed, 0);
  assert.equal(modified?.unavailableReason, null);

  const created = byPath.get('created.txt');
  assert.equal(created?.action, 'CREATE');
  assert.equal(created?.added, 3, '未跟踪新文件的真实行数必须整文件计入新增');
  assert.equal(created?.removed, 0);

  const deleted = byPath.get('deleted.txt');
  assert.equal(deleted?.action, 'DELETE');
  assert.equal(deleted?.added, 0);
  assert.equal(deleted?.removed, 2, '删除文件的真实行数必须整文件计入移除');

  assert.equal(diff.totalFiles, 3);
  // 总数等于各可统计项之和：不可统计项（unavailableReason 非 null）不参与合计。
  const countable = diff.files.filter((file) => file.unavailableReason === null);
  assert.equal(diff.totalAdded, countable.reduce((sum, file) => sum + file.added, 0));
  assert.equal(diff.totalRemoved, countable.reduce((sum, file) => sum + file.removed, 0));
  assert.equal(diff.totalAdded, 5);
  assert.equal(diff.totalRemoved, 2);
});

test('展开正文同源：单文件行数与总数一致，未知路径按 PATH_NOT_FOUND 返回', async () => {
  const f = await workspaceFixture();
  const sessionId = await newSession(f.workspaceId, f.projectId);
  const repo = await createGitRepo();
  await writeFile(join(repo.root, 'tracked.txt'), `a${LF}b${LF}`);
  await repo.git(['add', '--', 'tracked.txt']);
  const directory = await openDirectory(f.workspaceId, f.projectId, repo.root);
  await bindDirectory(f.workspaceId, sessionId, directory.resourceId);
  await establishConversationDiffBaseline(repositories, { workspaceId: f.workspaceId, sessionId });

  await writeFile(join(repo.root, 'tracked.txt'), `a${LF}b${LF}c${LF}d${LF}`);

  const read = await readConversationDiff(repositories,
    { workspaceId: f.workspaceId, sessionId, scope: 'DIRECTORY' });
  assert.equal(read.available, true, describe(read));
  if (!read.available) return;
  const listed = read.diff.files.find((file) => file.path === 'tracked.txt');
  assert.ok(listed !== undefined, '列表里必须出现被修改的路径');

  const detail = await readConversationDiffFile(repositories,
    { workspaceId: f.workspaceId, sessionId, path: 'tracked.txt', scope: 'DIRECTORY' });
  assert.equal(detail.available, true, describe(detail));
  if (!detail.available) return;

  assert.equal(detail.file.path, 'tracked.txt');
  assert.equal(detail.file.action, listed.action);
  assert.equal(detail.file.added, listed.added, '展开正文的新增行必须与总数同源');
  assert.equal(detail.file.removed, listed.removed, '展开正文的移除行必须与总数同源');
  assert.equal(detail.file.rowsTruncated, false);

  const rows = detail.file.rows;
  assert.ok(rows !== null, '可统计的小文件必须给出对齐正文');
  assert.ok(rows.length > 0, '有变化就必须有正文行');
  assert.equal(rows.filter((row) => row.kind === 'ADD').length, detail.file.added);
  assert.equal(rows.filter((row) => row.kind === 'REMOVE').length, detail.file.removed);
  assert.ok(rows.some((row) => row.kind === 'ADD' && row.text === 'c'));

  // 不存在的路径是「不可用」而不是抛错，既有的读取越权边界仍由 canonical path 校验兜住。
  const missing = await readConversationDiffFile(repositories,
    { workspaceId: f.workspaceId, sessionId, path: 'not-there.txt', scope: 'DIRECTORY' });
  assert.deepEqual(missing, { available: false, reason: 'PATH_NOT_FOUND' });

  // 会话口径：这条路径不是本会话写过的，正文不给读——展开面板不能成为读别人改动的旁路。
  const sessionDetail = await readConversationDiffFile(repositories,
    { workspaceId: f.workspaceId, sessionId, path: 'tracked.txt' });
  assert.deepEqual(sessionDetail, { available: false, reason: 'PATH_NOT_FOUND' });
});

test('不可用原因：未绑定为 NO_RESOURCE、未建基线为 NO_BASELINE、非 Git 根两侧各有其名', async () => {
  const f = await workspaceFixture();

  // 1) 会话还没有工作目录：读取不抛错，返回 NO_RESOURCE。
  const unboundSession = await newSession(f.workspaceId, f.projectId, '未绑定目录');
  const noResource = await readConversationDiff(repositories,
    { workspaceId: f.workspaceId, sessionId: unboundSession });
  assert.deepEqual(noResource, { available: false, reason: 'NO_RESOURCE' });
  const establishNoResource = await establishConversationDiffBaseline(repositories,
    { workspaceId: f.workspaceId, sessionId: unboundSession });
  assert.equal(establishNoResource.reason, 'NO_RESOURCE');

  // 2) 已绑定目录但还没建立基线：读取返回 NO_BASELINE（不拿当前内容当起点）。
  const unbaselinedSession = await newSession(f.workspaceId, f.projectId, '未建基线');
  const gitRepo = await createGitRepo();
  await writeFile(join(gitRepo.root, 'note.txt'), `alpha${LF}`);
  await gitRepo.git(['add', '--', 'note.txt']);
  const gitDirectory = await openDirectory(f.workspaceId, f.projectId, gitRepo.root);
  await bindDirectory(f.workspaceId, unbaselinedSession, gitDirectory.resourceId);
  const noBaseline = await readConversationDiff(repositories,
    { workspaceId: f.workspaceId, sessionId: unbaselinedSession });
  assert.deepEqual(noBaseline, { available: false, reason: 'NO_BASELINE' });
  const noBaselineDetail = await readConversationDiffFile(repositories,
    { workspaceId: f.workspaceId, sessionId: unbaselinedSession, path: 'note.txt' });
  assert.deepEqual(noBaselineDetail, { available: false, reason: 'NO_BASELINE' });

  // 3) 根不是 Git 仓库：建立侧明确 NOT_GIT_ROOT，且不落库。
  const plainRoot = await mkdtemp(join(tmpdir(), 'relay-cd-int-plain-'));
  temporaryRoots.push(plainRoot);
  await writeFile(join(plainRoot, 'plain.txt'), `plain${LF}`);
  const plainSession = await newSession(f.workspaceId, f.projectId, '非 Git 根');
  const plainDirectory = await openDirectory(f.workspaceId, f.projectId, plainRoot);
  await bindDirectory(f.workspaceId, plainSession, plainDirectory.resourceId);
  const notGit = await establishConversationDiffBaseline(repositories,
    { workspaceId: f.workspaceId, sessionId: plainSession });
  assert.equal(notGit.established, false);
  assert.equal(notGit.reason, 'NOT_GIT_ROOT');
  assert.equal(notGit.baseline, null);
  assert.equal(await baselineRowCount(f.workspaceId, plainSession), 0,
    '采集失败不得发布一个没有真实起点的基线');

  // 4) 基线建立后根不再是 Git 仓库：读取侧返回 ROOT_NOT_GIT，而不是假装「零变化」。
  const lostGitSession = await newSession(f.workspaceId, f.projectId, '基线后失去 Git');
  const lostRepo = await createGitRepo();
  await writeFile(join(lostRepo.root, 'note.txt'), `alpha${LF}`);
  await lostRepo.git(['add', '--', 'note.txt']);
  const lostDirectory = await openDirectory(f.workspaceId, f.projectId, lostRepo.root);
  await bindDirectory(f.workspaceId, lostGitSession, lostDirectory.resourceId);
  const created = await establishConversationDiffBaseline(repositories,
    { workspaceId: f.workspaceId, sessionId: lostGitSession });
  assert.equal(created.reason, 'CREATED', describe(created));
  await rm(join(lostRepo.root, '.git'), { recursive: true, force: true });
  const rootNotGit = await readConversationDiff(repositories,
    { workspaceId: f.workspaceId, sessionId: lostGitSession });
  assert.deepEqual(rootNotGit, { available: false, reason: 'ROOT_NOT_GIT' });
});

test('换目录不跨段求和：重建基线只反映新根，旧根的改动不再出现', async () => {
  const f = await workspaceFixture();
  const sessionId = await newSession(f.workspaceId, f.projectId, '换目录会话');

  const repoA = await createGitRepo();
  await writeFile(join(repoA.root, 'only-a.txt'), `a1${LF}`);
  await repoA.git(['add', '--', 'only-a.txt']);
  const directoryA = await openDirectory(f.workspaceId, f.projectId, repoA.root);
  await bindDirectory(f.workspaceId, sessionId, directoryA.resourceId);
  const baselineA = await establishConversationDiffBaseline(repositories,
    { workspaceId: f.workspaceId, sessionId });
  assert.equal(baselineA.reason, 'CREATED');
  assert.equal(baselineA.baseline?.rootPath, directoryA.canonicalRoot);

  // A 上确实有可见变化：如果实现跨段求和，下面的结果会把它算进来。
  await writeFile(join(repoA.root, 'only-a.txt'), `a1${LF}a2${LF}a3${LF}a4${LF}`);
  const onA = await readConversationDiff(repositories,
    { workspaceId: f.workspaceId, sessionId, scope: 'DIRECTORY' });
  assert.equal(onA.available, true, describe(onA));
  if (!onA.available) return;
  assert.equal(onA.diff.totalAdded, 3);

  const repoB = await createGitRepo();
  await writeFile(join(repoB.root, 'only-b.txt'), `b1${LF}`);
  await repoB.git(['add', '--', 'only-b.txt']);
  const directoryB = await openDirectory(f.workspaceId, f.projectId, repoB.root);
  await bindDirectory(f.workspaceId, sessionId, directoryB.resourceId);

  const baselineB = await establishConversationDiffBaseline(repositories,
    { workspaceId: f.workspaceId, sessionId });
  assert.equal(baselineB.established, true, describe(baselineB));
  assert.equal(baselineB.reason, 'CREATED', '新根是新的统计段，必须重新建立起点');
  assert.equal(baselineB.baseline?.rootPath, directoryB.canonicalRoot,
    '当前基线的 rootPath 必须指向换绑后的根');
  assert.notEqual(baselineB.baseline?.id, baselineA.baseline?.id);
  assert.equal(await baselineRowCount(f.workspaceId, sessionId), 2,
    '两个根各自一段，不共享同一条基线');

  await writeFile(join(repoB.root, 'only-b.txt'), `b1${LF}b2${LF}`);

  // 会话口径：换段后本会话在新根上还没落盘过任何路径。
  const onBSession = await readConversationDiff(repositories,
    { workspaceId: f.workspaceId, sessionId });
  assert.equal(onBSession.available, true, describe(onBSession));
  if (onBSession.available) assert.deepEqual(onBSession.diff.files, []);

  const onB = await readConversationDiff(repositories,
    { workspaceId: f.workspaceId, sessionId, scope: 'DIRECTORY' });
  assert.equal(onB.available, true, describe(onB));
  if (!onB.available) return;
  assert.equal(onB.diff.rootPath, directoryB.canonicalRoot);
  assert.deepEqual(onB.diff.files.map((file) => [file.path, file.action, file.added, file.removed]),
    [['only-b.txt', 'MODIFY', 1, 0]]);
  assert.equal(onB.diff.totalAdded, 1, 'A 的改动不得叠加进 B 段的总数');
  assert.equal(onB.diff.totalRemoved, 0);
  assert.equal(onB.diff.files.some((file) => file.path === 'only-a.txt'), false,
    '旧根的文件不得出现在新根的净 diff 中');
});
