import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import {
  APP_DATABASE_URL,
  MIGRATIONS_DIRECTORY,
  MIGRATION_DATABASE_URL,
  openDatabase,
  type TestDatabase,
} from './integration-support.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';

/**
 * 人工完成指针写入的守卫强度（2026-10-21）。
 *
 * `applyCompletionPointer` 的 WHERE 只有 id + revision，没有比对 status 或当前验收周期，
 * 审计疑问是「人工完成若与并发推进竞争，可能把已变化的当前周期写成完成指针」。
 * 本文件用真实 PostgreSQL 固定事实：tasks 的每个写入面都递增 revision，因此 revision
 * CAS 足以兜住并发的周期/状态变化；应用层（`completion-commands.ts`）再补「周期相同
 * ＋人工进行中」的行锁内核对（`lockTaskInWorkspace` 的 FOR UPDATE）。
 *
 * 正向路径（完成确实能落库）由 `task-acceptance-command` 等既有用例覆盖；这里只钉住
 * 「旧周期/旧状态下的完成指针写不进去」这一侧。
 */

const app: TestDatabase = openDatabase(APP_DATABASE_URL, 'relay-api-test-completion-pointer');

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
});

after(async () => { await app.close(); });

async function fixture(): Promise<{ taskId: string }> {
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: `pointer-${workspaceId}` });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.tasks.insertTask({ id: taskId, workspaceId, projectId: null, title: '完成指针守卫',
      status: 'IN_PROGRESS', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
      ownershipEpoch: 0n, currentCompletionId: null });
    // 验收版本的复合外键指向 tasks，Task 侧的 acceptance_revision 指针是延迟外键：
    // 先建 Task 再补验收版本，同一事务内提交。
    await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: '完成指针守卫', requiredOutputSpec: {}, source: 'CREATE' });
  });
  return { taskId };
}

test('周期推进后，旧周期的完成指针写不进去：revision CAS 兜住并发的周期变化', async () => {
  const { taskId } = await fixture();
  const before = await withTransaction(app.db, async (r) => r.tasks.readTask(taskId));
  assert.equal(before?.revision, 0n);
  assert.equal(before?.acceptance_revision, 1n);

  // 并发推进周期（人工修订验收契约）：revision 与 acceptance_revision 一起变。
  const changed = await withTransaction(app.db, async (r) => {
    await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 2n,
      objective: '完成指针守卫（修订）', requiredOutputSpec: {}, source: 'CREATE' });
    return r.tasks.applyContractChangeRevision({ taskId, expectedRevision: 0n,
      expectedAcceptanceRevision: 1n, nextAcceptanceRevision: 2n });
  });
  assert.equal(changed?.revision, 1n, '周期推进必须递增 revision');
  assert.equal(changed?.acceptance_revision, 2n);

  // 旧完成（revision 0、周期 1）写不进去。
  const stale = await withTransaction(app.db, async (r) => r.tasks.applyCompletionPointer({
    taskId, expectedRevision: 0n, acceptanceRevision: 1n, completionId: randomUUID() }));
  assert.equal(stale, undefined, '旧周期的完成指针不得写入');

  const after = await withTransaction(app.db, async (r) => r.tasks.readTask(taskId));
  assert.equal(after?.current_completion_id, null, '完成指针必须仍为空');
  assert.equal(after?.acceptance_revision, 2n);
  assert.equal(after?.revision, 1n);
});

test('状态迁移后，旧完成指针同样写不进去：状态变化也递增 revision', async () => {
  const { taskId } = await fixture();
  const moved = await withTransaction(app.db, async (r) => r.tasks.applyTaskStatus({
    taskId, expectedRevision: 0n, fromStatus: 'IN_PROGRESS', toStatus: 'READY' }));
  assert.equal(moved?.revision, 1n, '状态迁移必须递增 revision');

  const stale = await withTransaction(app.db, async (r) => r.tasks.applyCompletionPointer({
    taskId, expectedRevision: 0n, acceptanceRevision: 1n, completionId: randomUUID() }));
  assert.equal(stale, undefined, '状态已变的 Task 不得再写完成指针');

  const after = await withTransaction(app.db, async (r) => r.tasks.readTask(taskId));
  assert.equal(after?.current_completion_id, null);
  assert.equal(after?.status, 'READY');
});
