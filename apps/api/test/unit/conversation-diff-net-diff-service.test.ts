import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  establishConversationDiffBaseline,
  readConversationDiff,
  type EstablishBaselineInput,
  type ReadDiffInput,
} from '../../src/conversation-diff/net-diff-service.js';
import {
  toStoredFiles,
  type ConversationDiffRepository,
  type SaveBaselineInput,
  type StoredBaseline,
} from '../../src/conversation-diff/conversation-diff-repository.js';
import type { Repositories } from '../../src/application/unit-of-work.js';

const exec = promisify(execFile);
const LF = String.fromCharCode(10);

async function withTempRepo(work: (root: string) => Promise<void>): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'relay-cd-svc-'));
  const root = join(base, 'repo');
  await mkdir(root);
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', HOME: base, USERPROFILE: base };
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const git = async (args: string[]) =>
    (await exec('git', ['-c', 'core.autocrlf=false', ...args], {
      cwd: root, env, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
    })).stdout;
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Relay Test']);
  await git(['config', 'user.email', 'fixture@local']);
  await git(['config', 'core.autocrlf', 'false']);
  await work(root);
  return root;
}

interface FakeState {
  sessions: Map<string, any>;
  resources: Map<string, any>;
  baselines: StoredBaseline[];
  /** 本会话写过的路径（真实实现来自会话写账本，这里直接给）。 */
  written: string[];
}

function buildRepositories(state: FakeState): Repositories {
  let revisionCounter = 0n;
  const conversationDiff: ConversationDiffRepository = {
    async saveBaseline(input: SaveBaselineInput): Promise<StoredBaseline> {
      const baseline: StoredBaseline = {
        id: `bl-${state.baselines.length}`,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        resourceId: input.resourceId,
        rootPath: input.rootPath,
        capturedAt: new Date('2026-01-01T00:00:00.000Z'),
        files: toStoredFiles(input.files),
        incomplete: input.incomplete,
        captureReason: input.captureReason,
        revision: ++revisionCounter,
      };
      state.baselines.push(baseline);
      return baseline;
    },
    async readLatestBaseline(workspaceId, sessionId, resourceId, rootPath) {
      const matches = state.baselines
        .filter((b) => b.workspaceId === workspaceId && b.sessionId === sessionId &&
          b.resourceId === resourceId && b.rootPath === rootPath)
        .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());
      return matches[0];
    },
    async listWrittenPaths() {
      return [...state.written];
    },
  };
  const repositories = {
    assist: {
      async readSession(id: string) {
        return state.sessions.get(id);
      },
    },
    gateway: {
      async readResource(id: string) {
        return state.resources.get(id);
      },
    },
    conversationDiff,
  } as unknown as Repositories;
  return repositories;
}

function makeSession(overrides: Partial<any> = {}): any {
  return {
    workspace_id: 'ws-1',
    status: 'ACTIVE',
    working_resource_id: 'res-1',
    project_id: null,
    ...overrides,
  };
}

function makeResource(overrides: Partial<any> = {}): any {
  return {
    workspace_id: 'ws-1',
    status: 'ACTIVE',
    canonical_root: '/repo',
    project_id: null,
    ...overrides,
  };
}

test('establish: session not found -> SESSION_NOT_FOUND', async () => {
  const state: FakeState = { sessions: new Map(), resources: new Map(), baselines: [], written: [] };
  state.sessions.set('s1', undefined);
  const repos = buildRepositories(state);
  const result = await establishConversationDiffBaseline(repos, { workspaceId: 'ws-1', sessionId: 's1' });
  assert.equal(result.established, false);
  assert.equal(result.reason, 'SESSION_NOT_FOUND');
});

test('establish: session not ACTIVE -> SESSION_NOT_ACTIVE', async () => {
  const state: FakeState = { sessions: new Map(), resources: new Map(), baselines: [], written: [] };
  state.sessions.set('s1', makeSession({ status: 'PAUSED' }));
  const repos = buildRepositories(state);
  const result = await establishConversationDiffBaseline(repos, { workspaceId: 'ws-1', sessionId: 's1' });
  assert.equal(result.established, false);
  assert.equal(result.reason, 'SESSION_NOT_ACTIVE');
});

test('establish: no working resource -> NO_RESOURCE', async () => {
  const state: FakeState = { sessions: new Map(), resources: new Map(), baselines: [], written: [] };
  state.sessions.set('s1', makeSession({ working_resource_id: null }));
  const repos = buildRepositories(state);
  const result = await establishConversationDiffBaseline(repos, { workspaceId: 'ws-1', sessionId: 's1' });
  assert.equal(result.established, false);
  assert.equal(result.reason, 'NO_RESOURCE');
});

test('establish: resource unavailable (missing / wrong workspace / inactive) -> RESOURCE_UNAVAILABLE', async () => {
  const mk = async (resource: any) => {
    const state: FakeState = { sessions: new Map(), resources: new Map(), baselines: [], written: [] };
    state.sessions.set('s1', makeSession());
    state.resources.set('res-1', resource);
    return buildRepositories(state);
  };
  assert.equal((await establishConversationDiffBaseline(await mk(undefined), { workspaceId: 'ws-1', sessionId: 's1' })).reason, 'RESOURCE_UNAVAILABLE');
  assert.equal((await establishConversationDiffBaseline(await mk(makeResource({ workspace_id: 'ws-2' })), { workspaceId: 'ws-1', sessionId: 's1' })).reason, 'RESOURCE_UNAVAILABLE');
  assert.equal((await establishConversationDiffBaseline(await mk(makeResource({ status: 'ARCHIVED' })), { workspaceId: 'ws-1', sessionId: 's1' })).reason, 'RESOURCE_UNAVAILABLE');
});

test('establish: project mismatch -> RESOURCE_UNAVAILABLE (no git capture)', async () => {
  const state: FakeState = { sessions: new Map(), resources: new Map(), baselines: [], written: [] };
  state.sessions.set('s1', makeSession({ project_id: 'p1' }));
  state.resources.set('res-1', makeResource({ project_id: 'p2' }));
  const repos = buildRepositories(state);
  const result = await establishConversationDiffBaseline(repos, { workspaceId: 'ws-1', sessionId: 's1' });
  assert.equal(result.established, false);
  assert.equal(result.reason, 'RESOURCE_UNAVAILABLE');
});

test('establish: captures real baseline in a git repo -> CREATED, then REUSED', async () => {
  const root = await withTempRepo(async (r) => {
    await writeFile(join(r, 'a.txt'), `base${LF}`);
  });
  const state: FakeState = { sessions: new Map(), resources: new Map(), baselines: [], written: [] };
  state.sessions.set('s1', makeSession());
  state.resources.set('res-1', makeResource({ canonical_root: root }));
  const repos = buildRepositories(state);

  const first = await establishConversationDiffBaseline(repos, { workspaceId: 'ws-1', sessionId: 's1' });
  assert.equal(first.established, true);
  assert.equal(first.reason, 'CREATED');
  assert.equal(first.reused, false);
  assert.notEqual(first.baseline, null);
  assert.equal(first.baseline!.files.length >= 1, true);

  const second = await establishConversationDiffBaseline(repos, { workspaceId: 'ws-1', sessionId: 's1' });
  assert.equal(second.established, true);
  assert.equal(second.reason, 'REUSED');
  assert.equal(second.reused, true);
  assert.equal(state.baselines.length, 1); // 幂等：只发布一个有效起点。
  await rm(root, { recursive: true, force: true });
});

test('read: no resource -> NO_RESOURCE', async () => {
  const state: FakeState = { sessions: new Map(), resources: new Map(), baselines: [], written: [] };
  state.sessions.set('s1', makeSession({ working_resource_id: null }));
  const repos = buildRepositories(state);
  const result = await readConversationDiff(repos, { workspaceId: 'ws-1', sessionId: 's1' });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'NO_RESOURCE');
});

test('read: no baseline -> NO_BASELINE', async () => {
  const root = await withTempRepo(async () => {});
  const state: FakeState = { sessions: new Map(), resources: new Map(), baselines: [], written: [] };
  state.sessions.set('s1', makeSession());
  state.resources.set('res-1', makeResource({ canonical_root: root }));
  const repos = buildRepositories(state);
  const result = await readConversationDiff(repos, { workspaceId: 'ws-1', sessionId: 's1' });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'NO_BASELINE');
  await rm(root, { recursive: true, force: true });
});

test('read: baseline exists but current root not a git repo -> ROOT_NOT_GIT', async () => {
  // 用一个真实存在但不是 git 仓库的临时目录作为根路径。
  const nonGitDir = await mkdtemp(join(tmpdir(), 'relay-cd-nongit-'));
  try {
    const state: FakeState = { sessions: new Map(), resources: new Map(), baselines: [], written: [] };
    state.sessions.set('s1', makeSession());
    state.resources.set('res-1', makeResource({ canonical_root: nonGitDir }));
    // 直接预置一条基线（根路径指向非 git 目录），使 readLatestBaseline 命中、随后 captureCurrentState 失败。
    state.baselines.push({
      id: 'seeded',
      workspaceId: 'ws-1',
      sessionId: 's1',
      resourceId: 'res-1',
      rootPath: nonGitDir,
      capturedAt: new Date('2026-01-01T00:00:00.000Z'),
      files: [],
      incomplete: false,
      captureReason: '',
      revision: 1n,
    });
    const repos = buildRepositories(state);
    const result = await readConversationDiff(repos, { workspaceId: 'ws-1', sessionId: 's1' });
    assert.equal(result.available, false);
    assert.equal(result.reason, 'ROOT_NOT_GIT');
  } finally {
    await rm(nonGitDir, { recursive: true, force: true });
  }
});

test('read: 会话口径只报本会话写过的路径，同目录其他改动不计入', async () => {
  const root = await withTempRepo(async (r) => {
    await writeFile(join(r, 'a.txt'), `base${LF}`);
    await writeFile(join(r, 'other.txt'), `x${LF}`);
  });
  const state: FakeState = { sessions: new Map(), resources: new Map(), baselines: [], written: ['a.txt'] };
  state.sessions.set('s1', makeSession());
  state.resources.set('res-1', makeResource({ canonical_root: root }));
  const repos = buildRepositories(state);

  await establishConversationDiffBaseline(repos, { workspaceId: 'ws-1', sessionId: 's1' });
  // 本会话写过的 a.txt 与别的会话写的 other.txt 都变了，只有 a.txt 属于这条入口。
  await writeFile(join(root, 'a.txt'), `base${LF}extra${LF}`);
  await writeFile(join(root, 'other.txt'), `x${LF}y${LF}z${LF}`);

  const result = await readConversationDiff(repos, { workspaceId: 'ws-1', sessionId: 's1' });
  assert.equal(result.available, true);
  if (result.available) {
    assert.equal(result.diff.scope, 'SESSION');
    assert.deepEqual(result.diff.files.map((file) => file.path), ['a.txt']);
    assert.equal(result.diff.totalAdded, 1);
    assert.equal(result.diff.totalRemoved, 0);
  }
  await rm(root, { recursive: true, force: true });
});

test('read: 本会话一个路径都没写过 -> 空 diff，且不因整目录扫描不全而报不完整', async () => {
  const root = await withTempRepo(async (r) => {
    await writeFile(join(r, 'a.txt'), `base${LF}`);
  });
  const state: FakeState = { sessions: new Map(), resources: new Map(), baselines: [], written: [] };
  state.sessions.set('s1', makeSession());
  state.resources.set('res-1', makeResource({ canonical_root: root }));
  const repos = buildRepositories(state);

  await establishConversationDiffBaseline(repos, { workspaceId: 'ws-1', sessionId: 's1' });
  await writeFile(join(root, 'a.txt'), `base${LF}changed-by-someone-else${LF}`);

  const result = await readConversationDiff(repos, { workspaceId: 'ws-1', sessionId: 's1' });
  assert.equal(result.available, true);
  if (result.available) {
    assert.deepEqual(result.diff.files, []);
    assert.equal(result.diff.totalFiles, 0);
    assert.equal(result.diff.incomplete, false);
    assert.equal(result.diff.scope, 'SESSION');
  }
  await rm(root, { recursive: true, force: true });
});

test('read: 目录口径（工作详情「变更」页签）不看写账本，整段目录净变化都算', async () => {
  const root = await withTempRepo(async (r) => {
    await writeFile(join(r, 'a.txt'), `base${LF}`);
    await writeFile(join(r, 'other.txt'), `x${LF}`);
  });
  const state: FakeState = { sessions: new Map(), resources: new Map(), baselines: [], written: [] };
  state.sessions.set('s1', makeSession());
  state.resources.set('res-1', makeResource({ canonical_root: root }));
  const repos = buildRepositories(state);

  await establishConversationDiffBaseline(repos, { workspaceId: 'ws-1', sessionId: 's1' });
  await writeFile(join(root, 'a.txt'), `base${LF}extra${LF}`);
  await writeFile(join(root, 'other.txt'), `x${LF}y${LF}z${LF}`);

  // 写账本为空，会话口径是「暂无变化」；目录口径仍要如实给出两条。
  const sessionRead = await readConversationDiff(repos, { workspaceId: 'ws-1', sessionId: 's1' });
  assert.equal(sessionRead.available, true);
  if (sessionRead.available) assert.deepEqual(sessionRead.diff.files, []);

  const directoryRead = await readConversationDiff(repos,
    { workspaceId: 'ws-1', sessionId: 's1', scope: 'DIRECTORY' });
  assert.equal(directoryRead.available, true);
  if (directoryRead.available) {
    assert.equal(directoryRead.diff.scope, 'DIRECTORY');
    assert.deepEqual(directoryRead.diff.files.map((file) => file.path), ['a.txt', 'other.txt']);
    // a.txt +1、other.txt +2，合计 3；会话口径那两个 0 不能混进来。
    assert.equal(directoryRead.diff.totalAdded, 3);
  }
  await rm(root, { recursive: true, force: true });
});

test('read: available diff reflects on-disk net changes since baseline', async () => {
  const root = await withTempRepo(async (r) => {
    await writeFile(join(r, 'a.txt'), `base${LF}`);
  });
  const state: FakeState = { sessions: new Map(), resources: new Map(), baselines: [], written: ['a.txt'] };
  state.sessions.set('s1', makeSession());
  state.resources.set('res-1', makeResource({ canonical_root: root }));
  const repos = buildRepositories(state);

  const established = await establishConversationDiffBaseline(repos, { workspaceId: 'ws-1', sessionId: 's1' });
  assert.equal(established.reason, 'CREATED');

  // 修改磁盘内容后读取净 diff。
  await writeFile(join(root, 'a.txt'), `base${LF}extra${LF}`);
  const result = await readConversationDiff(repos, { workspaceId: 'ws-1', sessionId: 's1' });
  assert.equal(result.available, true);
  if (result.available) {
    const byPath = new Map(result.diff.files.map((f) => [f.path, f]));
    assert.equal(byPath.get('a.txt')?.action, 'MODIFY');
    assert.equal(result.diff.totalAdded, 1);
    assert.equal(result.diff.totalRemoved, 0);
  }
  await rm(root, { recursive: true, force: true });
});
