import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { CommandIdReusedError } from '../../src/application/command.js';
import { initializeWorkspace } from '../../src/application/initialize-workspace.js';
import { withTransaction, createRepositories } from '../../src/application/unit-of-work.js';
import type {
  TaskMode,
  TaskRow,
  TaskStatus,
} from '../../src/infrastructure/database-schema.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { POSTGRES_ERROR_CODES } from '../../src/infrastructure/postgres-error.js';
import {
  APP_DATABASE_URL,
  MIGRATIONS_DIRECTORY,
  MIGRATION_DATABASE_URL,
  expectSqlState,
  openDatabase,
} from './integration-support.js';

/**
 * V001 约束、权限、事务与命令回执的真实 PostgreSQL 验证。
 * 应用连接使用 relay_app，迁移连接使用 relay_migrator；两者都是真实非超级用户角色。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-app');
const migration = openDatabase(MIGRATION_DATABASE_URL, 'relay-api-test-migration');

/** 只读断言使用的仓储集合（写入口仍在 withTransaction 里按事务创建）。 */
const appRepositories = createRepositories(app.db);

before(async () => {
  await runMigrations({
    connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY,
  });
});

after(async () => {
  await app.close();
  await migration.close();
});

let fixtureCounter = 0;

function nextLabel(prefix: string): string {
  fixtureCounter += 1;

  return `${prefix}-${fixtureCounter}`;
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

async function countRows(table: string, column: string, value: string): Promise<bigint> {
  const result = await sql<{ count: bigint }>`
    select count(*) as count from ${sql.table(table)} where ${sql.ref(column)} = ${value}
  `.execute(app.db);

  return result.rows[0]?.count ?? 0n;
}

async function createWorkspaceWithProject(): Promise<{
  workspaceId: string;
  projectId: string;
}> {
  return withTransaction(app.db, async (repositories) => {
    const workspaceId = randomUUID();

    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: nextLabel('workspace') });
    await repositories.workspaces.insertAuthorityRow(workspaceId);

    const projectId = randomUUID();

    await repositories.projects.insertProject({
      id: projectId,
      workspaceId,
      title: nextLabel('project'),
      projectType: 'GENERAL',
    });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');

    return { workspaceId, projectId };
  });
}

interface TaskFixtureOptions {
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly status?: TaskStatus;
  readonly mode?: TaskMode;
  readonly acceptanceRevision?: bigint;
  readonly ownershipEpoch?: bigint;
  /** 需要多个验收版本时给出全部版本；第一个版本使用 CREATE 来源。 */
  readonly acceptanceRevisions?: readonly bigint[];
}

async function createTaskFixture(options: TaskFixtureOptions): Promise<TaskRow> {
  const acceptanceRevision = options.acceptanceRevision ?? 1n;
  const revisions = options.acceptanceRevisions ?? [acceptanceRevision];

  // 插入顺序：先插入 Task（当前验收指针由延迟外键在提交时校验），再插入验收版本与 criteria。
  return withTransaction(app.db, async (repositories) => {
    const taskId = randomUUID();

    const task = await repositories.tasks.insertTask({
      id: taskId,
      workspaceId: options.workspaceId,
      projectId: options.projectId,
      title: nextLabel('task'),
      status: options.status ?? 'READY',
      mode: options.mode ?? 'ME',
      acceptanceRevision,
      executorKind: 'HUMAN',
      ownershipEpoch: options.ownershipEpoch ?? 0n,
      currentCompletionId: null,
    });

    for (const revision of revisions) {
      await repositories.tasks.insertAcceptanceVersion({
        taskId,
        acceptanceRevision: revision,
        objective: nextLabel('objective'),
        requiredOutputSpec: {},
        source: revision === 1n ? 'CREATE' : 'REOPEN',
      });
      await repositories.tasks.insertCriterion({
        taskId,
        acceptanceRevision: revision,
        criterionId: 'c1',
        statement: '人工核对摘要与引用',
        required: true,
        method: 'HUMAN',
        targetSpec: {},
      });
    }

    return task;
  });
}

async function createArtifactFixture(task: TaskRow): Promise<string> {
  return withTransaction(app.db, async (repositories) => {
    const artifactId = randomUUID();

    await repositories.artifacts.insertArtifact({
      id: artifactId,
      workspaceId: task.workspace_id,
      projectId: task.project_id,
      taskId: task.id,
      artifactKind: 'MARKDOWN_DOCUMENT',
      title: nextLabel('artifact'),
    });

    return artifactId;
  });
}

async function insertTaskDirectly(input: {
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly status: TaskStatus;
  readonly currentCompletionId: string | null;
  readonly acceptanceRevision?: bigint;
}): Promise<TaskRow> {
  return withTransaction(app.db, (repositories) =>
    repositories.tasks.insertTask({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      title: nextLabel('task'),
      status: input.status,
      mode: 'ME',
      acceptanceRevision: input.acceptanceRevision ?? 1n,
      executorKind: 'HUMAN',
      ownershipEpoch: 0n,
      currentCompletionId: input.currentCompletionId,
    }),
  );
}

test('commits a task whose acceptance version is inserted later in the same transaction', async () => {
  const { workspaceId, projectId } = await createWorkspaceWithProject();
  const taskId = randomUUID();

  const task = await withTransaction(app.db, async (repositories) => {
    const inserted = await repositories.tasks.insertTask({
      id: taskId,
      workspaceId,
      projectId,
      title: nextLabel('task'),
      status: 'INBOX',
      mode: 'ME',
      acceptanceRevision: 1n,
      executorKind: 'HUMAN',
      ownershipEpoch: 0n,
      currentCompletionId: null,
    });

    await repositories.tasks.insertAcceptanceVersion({
      taskId,
      acceptanceRevision: 1n,
      objective: nextLabel('objective'),
      requiredOutputSpec: {},
      source: 'CREATE',
    });

    return inserted;
  });

  assert.equal(task.id, taskId);
  assert.equal(task.acceptance_revision, 1n);
  assert.equal(task.status, 'INBOX');
});

test('fails the COMMIT when the task acceptance pointer has no matching version', async () => {
  const { workspaceId, projectId } = await createWorkspaceWithProject();
  const taskId = randomUUID();
  let insertResolved = false;

  await assert.rejects(
    withTransaction(app.db, async (repositories) => {
      await repositories.tasks.insertTask({
        id: taskId,
        workspaceId,
        projectId,
        title: nextLabel('task'),
        status: 'READY',
        mode: 'ME',
        acceptanceRevision: 1n,
        executorKind: 'HUMAN',
        ownershipEpoch: 0n,
        currentCompletionId: null,
      });

      insertResolved = true;
    }),
    (error: unknown) => (error as { code?: string }).code === POSTGRES_ERROR_CODES.foreignKeyViolation,
  );

  // 指针缺失只在提交时暴露：INSERT 本身成功，失败必须作为整个用例失败处理。
  assert.equal(insertResolved, true);
  assert.equal(await countRows('tasks', 'id', taskId), 0n);
});

test('fails the COMMIT when the completion pointer has no matching completion record', async () => {
  const { workspaceId, projectId } = await createWorkspaceWithProject();
  const task = await createTaskFixture({ workspaceId, projectId });
  let pointerApplied = false;

  await assert.rejects(
    withTransaction(app.db, async (repositories) => {
      const updated = await repositories.tasks.applyCompletionPointer({
        taskId: task.id,
        expectedRevision: task.revision,
        acceptanceRevision: task.acceptance_revision,
        completionId: randomUUID(),
      });

      assert.notEqual(updated, undefined);
      pointerApplied = true;
    }),
    (error: unknown) => (error as { code?: string }).code === POSTGRES_ERROR_CODES.foreignKeyViolation,
  );

  assert.equal(pointerApplied, true);

  const reloaded = await appRepositories.tasks.readTask(task.id);

  assert.equal(reloaded?.status, 'READY');
  assert.equal(reloaded?.revision, task.revision);
  assert.equal(reloaded?.current_completion_id, null);
});

test('keeps exactly one completion per acceptance revision and records the human acceptance', async () => {
  const { workspaceId, projectId } = await createWorkspaceWithProject();
  const task = await createTaskFixture({ workspaceId, projectId });
  const humanAcceptanceId = randomUUID();
  const completionId = randomUUID();

  const completed = await withTransaction(app.db, async (repositories) => {
    await repositories.completions.insertHumanAcceptance({
      id: humanAcceptanceId,
      taskId: task.id,
      acceptanceRevision: task.acceptance_revision,
      actorKind: 'HUMAN',
      actorRef: 'user:local',
      statement: '已核对摘要与引用，同意完成本轮任务',
      acceptedCriterionIds: ['c1'],
      acceptedVersionRefs: [],
      reason: null,
    });

    await repositories.completions.insertCompletionRecord({
      id: completionId,
      taskId: task.id,
      acceptanceRevision: task.acceptance_revision,
      basisKind: 'HUMAN',
      humanAcceptanceId,
      stateDelta: {},
    });

    const updated = await repositories.tasks.applyCompletionPointer({
      taskId: task.id,
      expectedRevision: task.revision,
      acceptanceRevision: task.acceptance_revision,
      completionId,
    });

    assert.notEqual(updated, undefined);

    const stateRef = await repositories.projects.insertStateCompletionRef({
      projectId,
      completionId,
      sourceRef: 'completion_records',
    });

    return { updated, stateRef };
  });

  assert.equal(completed.updated?.status, 'DONE');
  assert.equal(completed.updated?.revision, task.revision + 1n);
  assert.equal(completed.updated?.current_completion_id, completionId);
  assert.equal(completed.stateRef.project_id, projectId);

  const records = await appRepositories.completions.listCompletionRecordsByCycle(task.id, 1n);

  assert.equal(records.length, 1);

  // 同一周期不能有第二条完整完成记录：两个不同 command_id 也裁决为唯一。
  await expectSqlState(
    POSTGRES_ERROR_CODES.uniqueViolation,
    'a second completion record for the same acceptance cycle',
    () =>
      withTransaction(app.db, (repositories) =>
        repositories.completions.insertCompletionRecord({
          id: randomUUID(),
          taskId: task.id,
          acceptanceRevision: 1n,
          basisKind: 'HUMAN',
          humanAcceptanceId,
          stateDelta: {},
        }),
      ),
  );
});

test('rejects a completion record whose human acceptance belongs to another acceptance revision', async () => {
  const { workspaceId, projectId } = await createWorkspaceWithProject();
  const task = await createTaskFixture({
    workspaceId,
    projectId,
    acceptanceRevisions: [1n, 2n],
  });
  const laterAcceptanceId = randomUUID();

  await withTransaction(app.db, (repositories) =>
    repositories.completions.insertHumanAcceptance({
      id: laterAcceptanceId,
      taskId: task.id,
      acceptanceRevision: 2n,
      actorKind: 'HUMAN',
      actorRef: 'user:local',
      statement: '第二轮接受',
      acceptedCriterionIds: ['c1'],
      acceptedVersionRefs: [],
      reason: null,
    }),
  );

  await expectSqlState(
    POSTGRES_ERROR_CODES.foreignKeyViolation,
    'a completion record borrowing another cycle human acceptance',
    () =>
      withTransaction(app.db, (repositories) =>
        repositories.completions.insertCompletionRecord({
          id: randomUUID(),
          taskId: task.id,
          acceptanceRevision: 1n,
          basisKind: 'HUMAN',
          humanAcceptanceId: laterAcceptanceId,
          stateDelta: {},
        }),
      ),
  );
});

test('rejects cross-workspace references with composite foreign keys', async () => {
  const first = await createWorkspaceWithProject();
  const second = await createWorkspaceWithProject();

  // Task 的 Project 指针必须属于同一 Workspace。
  await expectSqlState(
    POSTGRES_ERROR_CODES.foreignKeyViolation,
    'a task pointing at a project in another workspace',
    () =>
      insertTaskDirectly({
        workspaceId: second.workspaceId,
        projectId: first.projectId,
        status: 'INBOX',
        currentCompletionId: null,
      }),
  );

  // Project–Goal 关联的两个端点必须同 Workspace。
  const goalId = randomUUID();

  await withTransaction(app.db, (repositories) =>
    repositories.projects.insertGoal({
      id: goalId,
      workspaceId: second.workspaceId,
      title: nextLabel('goal'),
      description: '',
      status: 'ACTIVE',
    }),
  );

  await expectSqlState(
    POSTGRES_ERROR_CODES.foreignKeyViolation,
    'linking a goal to a project in another workspace',
    () =>
      withTransaction(app.db, (repositories) =>
        repositories.projects.linkGoalToProject({
          workspaceId: second.workspaceId,
          projectId: first.projectId,
          goalId,
        }),
      ),
  );

  // 依赖关系的两个端点必须同 Workspace。
  const firstTask = await createTaskFixture({
    workspaceId: first.workspaceId,
    projectId: first.projectId,
  });
  const secondTask = await createTaskFixture({
    workspaceId: second.workspaceId,
    projectId: second.projectId,
  });

  await expectSqlState(
    POSTGRES_ERROR_CODES.foreignKeyViolation,
    'a dependency across workspaces',
    () =>
      withTransaction(app.db, (repositories) =>
        repositories.tasks.insertDependency({
          workspaceId: second.workspaceId,
          taskId: secondTask.id,
          dependsOnTaskId: firstTask.id,
          dependencyKind: 'BLOCKS',
        }),
      ),
  );

  // Artifact 的 Task 与 Project 指针必须一致。
  await expectSqlState(
    POSTGRES_ERROR_CODES.foreignKeyViolation,
    'an artifact mixing tasks and projects from different workspaces',
    () =>
      withTransaction(app.db, (repositories) =>
        repositories.artifacts.insertArtifact({
          id: randomUUID(),
          workspaceId: second.workspaceId,
          projectId: second.projectId,
          taskId: firstTask.id,
          artifactKind: 'MARKDOWN_DOCUMENT',
          title: nextLabel('artifact'),
        }),
      ),
  );
});

test('rejects NULL or invalid values that would otherwise bypass CHECK constraints', async () => {
  const { workspaceId, projectId } = await createWorkspaceWithProject();

  await expectSqlState(
    POSTGRES_ERROR_CODES.checkViolation,
    'a DONE task without a completion pointer',
    () =>
      insertTaskDirectly({
        workspaceId,
        projectId,
        status: 'DONE',
        currentCompletionId: null,
      }),
  );

  await expectSqlState(
    POSTGRES_ERROR_CODES.checkViolation,
    'a non-DONE task carrying a completion pointer',
    () =>
      insertTaskDirectly({
        workspaceId,
        projectId,
        status: 'INBOX',
        currentCompletionId: randomUUID(),
      }),
  );

  const task = await createTaskFixture({ workspaceId, projectId });
  const artifactId = await createArtifactFixture(task);
  const versionId = randomUUID();

  async function insertVersion(storageRef: string, contentHash: Buffer): Promise<void> {
    await withTransaction(app.db, (repositories) =>
      repositories.artifacts.insertArtifactVersion({
        id: randomUUID(),
        artifactId,
        versionNumber: 1n,
        storageRef,
        contentHash,
        size: 4n,
        mediaType: 'text/markdown',
        sourceKind: 'HUMAN',
        sourceRef: null,
      }),
    );
  }

  await expectSqlState(
    POSTGRES_ERROR_CODES.checkViolation,
    'a content hash that is not 32 bytes',
    () => insertVersion(`artifacts/${artifactId}/short/content.md`, sha256('body').subarray(0, 31)),
  );

  for (const storageRef of [
    '',
    '/absolute/content.md',
    '\\server\\share\\content.md',
    'C:/content.md',
    '../content.md',
    `artifacts/${artifactId}:alt/content.md`,
  ]) {
    await expectSqlState(
      POSTGRES_ERROR_CODES.checkViolation,
      `a storage reference that is not a managed relative path (${storageRef})`,
      () => insertVersion(storageRef, sha256('body')),
    );
  }

  // 受管相对路径必须能正常写入，约束不能把设计路径也挡掉。
  await insertVersion(
    `artifacts/${artifactId}/${versionId}/content.md`,
    sha256('body'),
  );

  assert.equal(await countRows('artifact_versions', 'artifact_id', artifactId), 1n);
});

test('round-trips bigint revisions and epochs above 2^53 without precision loss', async () => {
  const { workspaceId, projectId } = await createWorkspaceWithProject();
  const acceptanceRevision = 9007199254740993n;
  const ownershipEpoch = 9007199254740995n;

  const task = await createTaskFixture({
    workspaceId,
    projectId,
    acceptanceRevision,
    ownershipEpoch,
  });

  assert.equal(typeof task.acceptance_revision, 'bigint');
  assert.equal(task.acceptance_revision, 9007199254740993n);
  assert.equal(task.ownership_epoch, 9007199254740995n);
  // 任何一次 number 往返都会丢精度，因此应用层保持 bigint、对外只输出十进制字符串。
  assert.equal(Number(task.acceptance_revision), 9007199254740992);
  assert.notEqual(BigInt(Number(task.acceptance_revision)), 9007199254740993n);

  const reloaded = await appRepositories.tasks.readTask(task.id);

  assert.equal(reloaded?.acceptance_revision, 9007199254740993n);
  assert.equal(reloaded?.ownership_epoch, 9007199254740995n);

  const acceptances = await appRepositories.tasks.listAcceptanceVersions(task.id);

  assert.deepEqual(
    acceptances.map((acceptance) => acceptance.acceptance_revision),
    [9007199254740993n],
  );
});

test('enforces the 0002 task goal alignment column and its constraints', async () => {
  const { workspaceId, projectId } = await createWorkspaceWithProject();
  const defaultsToInherit = await createTaskFixture({ workspaceId, projectId });

  assert.equal(defaultsToInherit.goal_alignment_mode, 'INHERIT');

  // 无 Project 的 Me Inbox 事项只能是 INHERIT：EXPLICIT 无法表达任何显式集合。
  const inboxTask = await createTaskFixture({ workspaceId, projectId: null });

  assert.equal(inboxTask.goal_alignment_mode, 'INHERIT');

  await expectSqlState(
    POSTGRES_ERROR_CODES.checkViolation,
    'an inbox task marked EXPLICIT without a project',
    () =>
      sql`
        update tasks set goal_alignment_mode = 'EXPLICIT' where id = ${inboxTask.id}
      `.execute(app.db),
  );

  await expectSqlState(
    POSTGRES_ERROR_CODES.checkViolation,
    'an unknown goal alignment mode',
    () =>
      sql`
        update tasks set goal_alignment_mode = 'INHERITED' where id = ${defaultsToInherit.id}
      `.execute(app.db),
  );

  // 应用角色对新增列有写权限（表级授权覆盖新增列），不存在 42501。
  const switched = await sql<TaskRow>`
    update tasks set goal_alignment_mode = 'EXPLICIT'
    where id = ${defaultsToInherit.id}
    returning id, goal_alignment_mode
  `.execute(app.db);

  assert.equal(switched.rows[0]?.goal_alignment_mode, 'EXPLICIT');

  // 0002 只追加：既有列与 CHECK 取值集不变。DELEGATE_AI 由 0004 开放，因此这里用真正的域外取值。
  await expectSqlState(
    POSTGRES_ERROR_CODES.checkViolation,
    'a task mode outside the supported value set',
    () =>
      sql`
        update tasks set mode = 'AUTONOMOUS' where id = ${defaultsToInherit.id}
      `.execute(app.db),
  );
});

test('gives the application role only the intended privileges', async () => {
  await expectSqlState(
    POSTGRES_ERROR_CODES.insufficientPrivilege,
    'application role DDL',
    () => sql`create table app_role_probe (id uuid not null)`.execute(app.db),
  );

  for (const statement of [
    sql`update artifact_versions set storage_ref = 'x' where false`,
    sql`update task_acceptances set objective = 'x' where false`,
    sql`update completion_records set state_delta = '{}'::jsonb where false`,
    sql`update human_acceptances set statement = 'x' where false`,
    // 0004 的两张冻结表同样只允许读与首次写入。
    sql`update execution_contracts set workflow_version = 'x' where false`,
    sql`update context_manifests set builder_version = 'x' where false`,
    sql`delete from artifact_versions where false`,
    sql`delete from completion_records where false`,
    sql`delete from execution_contracts where false`,
  ]) {
    await expectSqlState(
      POSTGRES_ERROR_CODES.insufficientPrivilege,
      'application role writing to an immutable history table',
      () => statement.execute(app.db),
    );
  }

  await expectSqlState(
    POSTGRES_ERROR_CODES.insufficientPrivilege,
    'application role reading the migration ledger',
    () => sql`select name from relay_schema_migrations`.execute(app.db),
  );

  // 应用角色仍可读取可变事实与写入新事实，说明上面的拒绝来自授权而不是整库不可用。
  const workspaces = await sql<{ count: bigint }>`
    select count(*) as count from workspaces
  `.execute(app.db);

  assert.equal(typeof workspaces.rows[0]?.count, 'bigint');

  // 迁移角色是表所有者，因此同一语句在迁移连接上不被拒绝。
  const ownerCheck = await sql`
    update artifact_versions set storage_ref = storage_ref where false
  `.execute(migration.db);

  assert.equal(ownerCheck.numAffectedRows, 0n);
});

test('rolls back every module write in one transaction', async () => {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const artifactId = randomUUID();
  const versionId = randomUUID();
  const commandId = randomUUID();

  await assert.rejects(
    withTransaction(app.db, async (repositories) => {
      await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'rollback-workspace' });
      await repositories.workspaces.insertAuthorityRow(workspaceId);
      await repositories.projects.insertProject({
        id: projectId,
        workspaceId,
        title: 'rollback-project',
        projectType: 'GENERAL',
      });
      await repositories.projects.insertProjectState(projectId, 'PLANNING');
      await repositories.tasks.insertTask({
        id: taskId,
        workspaceId,
        projectId,
        title: 'rollback-task',
        status: 'READY',
        mode: 'ME',
        acceptanceRevision: 1n,
        executorKind: 'HUMAN',
        ownershipEpoch: 0n,
        currentCompletionId: null,
      });
      await repositories.tasks.insertAcceptanceVersion({
        taskId,
        acceptanceRevision: 1n,
        objective: 'objective',
        requiredOutputSpec: {},
        source: 'CREATE',
      });
      await repositories.tasks.insertCriterion({
        taskId,
        acceptanceRevision: 1n,
        criterionId: 'c1',
        statement: 'statement',
        required: true,
        method: 'HUMAN',
        targetSpec: {},
      });
      await repositories.artifacts.insertArtifact({
        id: artifactId,
        workspaceId,
        projectId,
        taskId,
        artifactKind: 'MARKDOWN_DOCUMENT',
        title: 'rollback-artifact',
      });
      await repositories.artifacts.insertArtifactVersion({
        id: versionId,
        artifactId,
        versionNumber: 1n,
        storageRef: `artifacts/${artifactId}/${versionId}/content.md`,
        contentHash: sha256('body'),
        size: 4n,
        mediaType: 'text/markdown',
        sourceKind: 'HUMAN',
        sourceRef: null,
      });
      await repositories.receipts.insertReceipt({
        scopeKey: `workspace:${workspaceId}`,
        commandId,
        commandType: 'TestRollbackCommand',
        payloadHash: sha256('payload'),
        result: {},
      });
      await repositories.activities.insertActivityRecord({
        id: randomUUID(),
        workspaceId,
        actorKind: 'HUMAN',
        actorRef: 'test',
        commandId,
        projectId,
        taskId,
        eventType: 'TEST_ROLLBACK',
        factRefs: {},
      });

      throw new Error('intentional failure inside the transaction');
    }),
    /intentional failure/u,
  );

  for (const [table, column, value] of [
    ['workspaces', 'id', workspaceId],
    ['workspace_execution_authority', 'workspace_id', workspaceId],
    ['projects', 'id', projectId],
    ['project_states', 'project_id', projectId],
    ['tasks', 'id', taskId],
    ['task_acceptances', 'task_id', taskId],
    ['acceptance_criteria', 'task_id', taskId],
    ['artifacts', 'id', artifactId],
    ['artifact_versions', 'id', versionId],
    ['command_receipts', 'command_id', commandId],
    ['activity_records', 'command_id', commandId],
  ] as const) {
    assert.equal(
      await countRows(table, column, value),
      0n,
      `${table} must not keep a partial write`,
    );
  }
});

test('replays a command with the same payload and rejects a different payload', async () => {
  const workspaceId = randomUUID();
  const commandId = randomUUID();

  const first = await initializeWorkspace(app.db, {
    workspaceId,
    name: 'replay-workspace',
    commandId,
    actorRef: 'cli:init-workspace',
  });

  assert.equal(first.replayed, false);
  assert.equal(first.result.workspace_id, workspaceId);
  assert.equal(first.result.workspace_revision, '0');
  assert.equal(first.result.authority_revision, '0');

  const authority = await appRepositories.workspaces.readAuthority(workspaceId);

  assert.equal(authority?.revision, 0n, 'the workspace authority row must exist with revision 0');

  const replayed = await initializeWorkspace(app.db, {
    workspaceId,
    name: 'replay-workspace',
    commandId,
    actorRef: 'cli:init-workspace',
  });

  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.result, first.result);

  await assert.rejects(
    initializeWorkspace(app.db, {
      workspaceId,
      name: 'different-name',
      commandId,
      actorRef: 'cli:init-workspace',
    }),
    CommandIdReusedError,
  );

  assert.equal(await countRows('workspaces', 'id', workspaceId), 1n);
  assert.equal(await countRows('command_receipts', 'command_id', commandId), 1n);
  assert.equal(await countRows('activity_records', 'command_id', commandId), 1n);
});

test('is idempotent when two commands with the same command_id arrive concurrently', async () => {
  const workspaceId = randomUUID();
  const commandId = randomUUID();
  const input = {
    workspaceId,
    name: 'concurrent-workspace',
    commandId,
    actorRef: 'cli:init-workspace',
  };

  const [first, second] = await Promise.all([
    initializeWorkspace(app.db, input),
    initializeWorkspace(app.db, input),
  ]);

  assert.deepEqual(first.result, second.result);
  assert.equal([first.replayed, second.replayed].filter((value) => value).length, 1);
  assert.equal(await countRows('workspaces', 'id', workspaceId), 1n);
  assert.equal(await countRows('command_receipts', 'command_id', commandId), 1n);
  assert.equal(await countRows('activity_records', 'command_id', commandId), 1n);
});

test('treats a concurrent command_id reuse with a different payload as a conflict', async () => {
  const workspaceId = randomUUID();
  const commandId = randomUUID();

  const outcomes = await Promise.allSettled([
    initializeWorkspace(app.db, {
      workspaceId,
      name: 'first-payload',
      commandId,
      actorRef: 'cli:init-workspace',
    }),
    initializeWorkspace(app.db, {
      workspaceId,
      name: 'second-payload',
      commandId,
      actorRef: 'cli:init-workspace',
    }),
  ]);

  const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);

  const failure = rejected[0];

  if (failure?.status !== 'rejected') {
    throw new Error('one concurrent command was expected to be rejected');
  }

  assert.ok(failure.reason instanceof CommandIdReusedError);
  assert.match(String(failure.reason), /already used with a different payload/u);

  const stored = await appRepositories.workspaces.readWorkspace(workspaceId);

  assert.notEqual(stored, undefined);
  assert.equal(await countRows('command_receipts', 'command_id', commandId), 1n);
  assert.equal(await countRows('activity_records', 'command_id', commandId), 1n);
});

test('records the canonical payload hash and version with every receipt', async () => {
  const workspaceId = randomUUID();
  const commandId = randomUUID();

  await initializeWorkspace(app.db, {
    workspaceId,
    name: 'digest-workspace',
    commandId,
    actorRef: 'cli:init-workspace',
  });

  const receipts = await sql<{
    payload_hash_algorithm: string;
    canonicalization_version: string;
    content_sha256: Buffer;
    result_ref: unknown;
  }>`
    select payload_hash_algorithm,
           canonicalization_version,
           payload_hash as content_sha256,
           result_ref
    from command_receipts
    where scope_key = ${`workspace:${workspaceId}`} and command_id = ${commandId}
  `.execute(app.db);

  const receipt = receipts.rows[0];

  assert.equal(receipt?.payload_hash_algorithm, 'sha256');
  assert.equal(receipt?.canonicalization_version, 'relay-canonical-json-v1');
  assert.equal(Buffer.from(receipt?.content_sha256 ?? Buffer.alloc(0)).length, 32);
  assert.deepEqual(receipt?.result_ref, {
    workspace_id: workspaceId,
    workspace_revision: '0',
    authority_revision: '0',
  });
});
