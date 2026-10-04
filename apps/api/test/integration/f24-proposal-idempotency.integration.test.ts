/**
 * F24 提案接受的并发幂等回归。
 *
 * 两处缺陷都来自同一个形状：同 command_id 的两个并发请求都在**加候选锁之前**查过
 * 回执，然后一起等 `select ... for update`；胜出者连同业务效果和回执提交后，
 * 输的一方没有重查回执，于是把「同一次操作的第二个视角」当成「一次新决定」：
 *   - Assist Task Skill 接受：读到的候选已是 ACCEPTED → 409 INVALID_TRANSITION；
 *   - 蓝图 Apply：走 ACCEPTED 分支再插一条同 command_id 回执 → 唯一约束冲突 → 500。
 *
 * 反例用受控行锁制造真正的竞争：测试自己先 `for update` 占住候选行，确认两个 HTTP
 * 请求都已经在 `pg_stat_activity` 里等这把锁（且 blocking pid 就是本测试的连接），
 * 才放行。不靠固定 sleep 猜时序，也不靠并发概率。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';
import { Client } from 'pg';

import type { JsonObject } from '../../src/infrastructure/json.js';

import { createAssistSession, requestAssistMessage }
  from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { createGoal } from '../../src/application/create-goal.js';
import { createProject } from '../../src/application/create-project.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';
import { createDataRoot, createWorkspace, delay, expectCommandAccepted, expectProblem,
  startTestApi, workspacePath } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY,
  MIGRATION_DATABASE_URL, openDatabase } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-f24-idempotency');
let dataRoot: string;
let storage: ManagedContentStore;
const modelPort = new FakeModelPort();

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
  storage = new ManagedContentStore(dataRoot);
});
after(async () => { await app.close(); await rm(dataRoot, { recursive: true, force: true }); });

/**
 * 受控锁：测试自己占住一把锁，让调用方的请求排队，最后显式放行。
 *
 * 两种用法对应两类竞争点：
 *   - 候选行锁（`holdCandidateRow`）：串行化**同一候选**的两个请求，用来验证
 *     「拿到候选锁之后必须重查回执」；
 *   - 回执表排他锁（`holdReceiptInsert`）：**不同候选**的两个请求互不串行，
 *     只能停在写同一条命令回执上。EXCLUSIVE 与 INSERT 所需的 ROW EXCLUSIVE 冲突，
 *     但与回执查询所需的 ACCESS SHARE 兼容，所以两个请求会完整跑完所有读取
 *     （含候选锁后的回执重查）才停在插入处——正是要复现的冲突点。
 */
class ControlledLock {
  private constructor(private readonly client: Client,
    private readonly backendPid: number, private readonly label: string) {}

  private static async session(connectionString: string, label: string,
    hold: (client: Client) => Promise<void>): Promise<ControlledLock> {
    const client = new Client({ connectionString,
      application_name: `relay-api-test-f24-${label}` });
    await client.connect();
    const pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid'))
      .rows[0]!.pid;
    await client.query('begin');
    await hold(client);
    return new ControlledLock(client, pid, label);
  }

  /** 迁移角色是表 owner，只有它能对 command_receipts 取表级排他锁。 */
  static holdReceiptInsert(): Promise<ControlledLock> {
    return ControlledLock.session(MIGRATION_DATABASE_URL, 'receipt-barrier',
      async (client) => { await client.query('lock table command_receipts in exclusive mode'); });
  }

  static holdCandidateRow(table: 'assist_proposals' | 'project_blueprint_proposals',
    id: string): Promise<ControlledLock> {
    return ControlledLock.session(APP_DATABASE_URL, 'candidate-barrier',
      async (client) => { await client.query(
        `select id from ${table} where id = $1 for update`, [id]); });
  }

  /**
   * 确认 `expected` 个 API 会话正在等锁，且等待链（可能经过彼此）最终指向本连接。
   *
   * 不能只数「直接被本连接挡住」的会话：先到的请求占住候选行后，后到的请求排在其后，
   * `pg_blocking_pids` 报的是先到者而不是本连接。所以这里沿阻塞链向上递归。
   *
   * 轮询上限压在 4 秒：产品的维护准入门会把事务内 `lock_timeout` 设成 5s，
   * 等锁超过就会变成 lock_timeout 错误而不是等待——测试必须比它先收手。
   */
  async waitForBlockedWaiters(expected: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await sql<{ count: number }>`
        with recursive queued(pid) as (
          select a.pid from pg_stat_activity a
            where a.datname = current_database() and a.wait_event_type = 'Lock'
              and ${this.backendPid} = any(pg_blocking_pids(a.pid))
          union
          select a.pid from pg_stat_activity a join queued q
            on q.pid = any(pg_blocking_pids(a.pid))
        )
        select count(*)::int as count from queued
          join pg_stat_activity a using (pid)
        where a.datname = current_database() and a.application_name = 'relay-api'
          and a.wait_event_type = 'Lock'`.execute(app.db);
      if ((waiting.rows[0]?.count ?? 0) >= expected) return;
      await delay(20);
    }
    // 失败时打印实际会话：只说“等不到”无法区分是没排队、排到了别处还是已超时。
    const observed = await sql<{ pid: number; state: string; wait_event_type: string | null;
      wait_event: string | null; blocking: number[] | null; query: string }>`
      select pid, state, wait_event_type, wait_event,
        pg_blocking_pids(pid) as blocking, left(query, 80) as query
      from pg_stat_activity where datname = current_database()
        and pid <> pg_backend_pid() order by pid`.execute(app.db);
    assert.fail(`expected ${expected} API sessions queued behind ${this.label} pid ` +
      `${this.backendPid}; observed ${JSON.stringify(observed.rows)}`);
  }

  async release(): Promise<void> {
    await this.client.query('commit');
    await this.client.end();
  }

  async discard(): Promise<void> {
    try { await this.client.query('rollback'); } catch { /* already closed */ }
    await this.client.end().catch(() => undefined);
  }
}

function newDraft(goalId: string) {
  return { intent: '把目标拆为可审查任务', goal_id: goalId, phase_key: 'LITERATURE',
    tasks: [{ local_key: 'survey', title: '整理文献', objective: '形成文献列表' },
      { local_key: 'outline', title: '论文提纲', objective: '形成人工审查提纲' }],
    next_action: { kind: 'NEW_TASK', local_key: 'survey' },
    view_kind: 'development', pack_ref: null };
}

async function taskFixture(status: 'READY' | 'IN_PROGRESS' = 'READY'):
  Promise<{ workspaceId: string; projectId: string; taskId: string }> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: `f24-${workspaceId}` });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId, title: 'F24 Project',
      projectType: 'GENERAL' });
    await r.projects.insertProjectState(projectId, 'PLANNING');
    await r.tasks.insertTask({ id: taskId, workspaceId, projectId, title: 'F24 任务',
      status, mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
      ownershipEpoch: 0n, currentCompletionId: null });
    await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: '形成可核对产物', requiredOutputSpec: {}, source: 'CREATE' });
    await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
      statement: '人工验收', required: true, method: 'HUMAN', targetSpec: {} });
  });
  return { workspaceId, projectId, taskId };
}

/** 同一工作空间下的第二个任务，用于制造同 command_id、不同目标的竞争。 */
async function secondTask(workspaceId: string, projectId: string, title: string):
  Promise<string> {
  const taskId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.tasks.insertTask({ id: taskId, workspaceId, projectId, title,
      status: 'READY', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
      ownershipEpoch: 0n, currentCompletionId: null });
    await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: `形成可核对产物 ${title}`, requiredOutputSpec: {}, source: 'CREATE' });
    await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
      statement: `人工验收 ${title}`, required: true, method: 'HUMAN', targetSpec: {} });
  });
  return taskId;
}

async function generateTaskSkillProposal(f: { workspaceId: string; taskId: string }):
  Promise<{ id: string; payloadHash: string; taskRevision: string;
    acceptanceRevision: string }> {
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), taskId: f.taskId, title: 'F24 任务定义' });
  const request = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(),
    content: '给出可审查的任务验收建议',
    skillRef: { id: 'task-to-execution-contract', version: '1.1.0' } });
  const tick = await runAssistGenerationTick(app.db, { workerId: `f24-${randomUUID()}`,
    storage, modelPort, leaseMs: 30_000 });
  assert.equal(tick?.messageId, request.result.assistant_message_id);
  assert.equal(tick.status, 'COMPLETED');
  assert.equal(tick.proposalIds.length, 1);
  const row = await sql<{ base_revision: bigint; base_acceptance_revision: bigint;
    payload_hash: string }>`select base_revision, base_acceptance_revision, payload_hash
    from assist_proposals where id = ${tick.proposalIds[0]!}`.execute(app.db);
  return { id: tick.proposalIds[0]!, payloadHash: row.rows[0]!.payload_hash,
    taskRevision: row.rows[0]!.base_revision.toString(),
    acceptanceRevision: row.rows[0]!.base_acceptance_revision.toString() };
}

async function receiptCount(scopeKey: string, commandId: string): Promise<number> {
  const row = await sql<{ count: number }>`select count(*)::int as count
    from command_receipts where scope_key = ${scopeKey} and command_id = ${commandId}`
    .execute(app.db);
  return row.rows[0]?.count ?? 0;
}

interface TaskAcceptanceFacts {
  readonly acceptances: number;
  readonly criteria: readonly { acceptance_revision: string; criterion_id: string;
    statement: string; required: boolean; method: string }[];
}

async function taskAcceptanceSnapshot(taskIds: readonly string[]):
  Promise<Map<string, TaskAcceptanceFacts>> {
  const rows = await sql<{ task_id: string; acceptance_revision: string;
    criterion_id: string | null; statement: string | null; required: boolean | null;
    method: string | null; acceptance_count: number }>`
    select a.task_id, a.acceptance_revision::text as acceptance_revision,
      c.criterion_id, c.statement, c.required, c.method,
      (select count(*)::int from task_acceptances x where x.task_id = a.task_id) as acceptance_count
    from task_acceptances a left join acceptance_criteria c
      on c.task_id = a.task_id and c.acceptance_revision = a.acceptance_revision
    where a.task_id in (${sql.join(taskIds.map((id) => sql`${id}`))})
    order by a.task_id, a.acceptance_revision, c.criterion_id`.execute(app.db);
  const grouped = new Map<string, TaskAcceptanceFacts>();
  for (const taskId of taskIds) {
    const own = rows.rows.filter((row) => row.task_id === taskId);
    grouped.set(taskId, { acceptances: own[0]?.acceptance_count ?? 0,
      criteria: own.filter((row) => row.criterion_id !== null)
        .map((row) => ({ acceptance_revision: row.acceptance_revision,
          criterion_id: row.criterion_id!, statement: row.statement!,
          required: row.required!, method: row.method! })) });
  }
  return grouped;
}

interface BlueprintFacts {
  readonly state_revision: string;
  readonly view_revision: string;
  readonly tasks: number;
}

async function blueprintSnapshot(projectIds: readonly string[]):
  Promise<Map<string, BlueprintFacts>> {
  const rows = await sql<{ project_id: string; state_revision: string;
    view_revision: string | null; tasks: number }>`
    select s.project_id, s.revision::text as state_revision,
      v.revision::text as view_revision,
      (select count(*)::int from tasks t where t.project_id = s.project_id) as tasks
    from project_states s left join project_view_configurations v on v.project_id = s.project_id
    where s.project_id in (${sql.join(projectIds.map((id) => sql`${id}`))})`.execute(app.db);
  return new Map(rows.rows.map((row) => [row.project_id,
    { state_revision: row.state_revision, view_revision: row.view_revision ?? '0',
      tasks: row.tasks }]));
}

test('concurrent Accept of one Task Skill proposal with the same command_id replays the first receipt', async () => {
  const f = await taskFixture();
  const proposal = await generateTaskSkillProposal(f);
  const api = await startTestApi();
  const path = `${workspacePath(f.workspaceId)}/assist-proposals/${proposal.id}/accept`;
  const commandId = randomUUID();
  const body = { command_id: commandId, expected_task_revision: proposal.taskRevision,
    expected_acceptance_revision: proposal.acceptanceRevision,
    payload_hash: proposal.payloadHash };
  const blocker = await ControlledLock.holdCandidateRow('assist_proposals', proposal.id);
  try {
    const first = api.post(path, body);
    const second = api.post(path, body);
    await blocker.waitForBlockedWaiters(2);
    await blocker.release();
    const [winner, loser] = await Promise.all([first, second]);
    // 修复前这里会是 200 + 409 INVALID_TRANSITION；现在两个视角都必须沿原回执成功。
    assert.equal(winner.status, 200, `winner: ${winner.text}`);
    assert.equal(loser.status, 200, `loser must replay, not reject: ${loser.text}`);
    const winnerBody = winner.body as { command_id: string; result: { acceptance_revision: string; revision: string } };
    const loserBody = loser.body as unknown;
    assert.equal(winnerBody.command_id, commandId);
    assert.deepEqual(loserBody, winner.body);
    const replays = [winner, loser].map((response) => response.headers['command-replayed']);
    assert.equal(replays.filter((value) => value === 'true').length, 1,
      'exactly one response is the fresh commit; the other replays it');
    assert.equal(winnerBody.result.acceptance_revision, '2');
    // 业务效果只发生一次：验收只前进一版，Task 只被改一次。
    const acceptance = await sql<{ count: number }>`select count(*)::int as count
      from task_acceptances where task_id = ${f.taskId}`.execute(app.db);
    assert.equal(acceptance.rows[0]!.count, 2);
    assert.equal(await receiptCount(`workspace:${f.workspaceId}:user:local`, commandId), 1);
    const settled = await sql<{ status: string; decision: { command_id: string } }>`
      select status, decision from assist_proposals where id = ${proposal.id}`.execute(app.db);
    assert.equal(settled.rows[0]!.status, 'ACCEPTED');
    assert.equal(settled.rows[0]!.decision.command_id, commandId);
  } finally { await blocker.discard(); await api.stop(); }
});

test('concurrent Accept with one command_id but different content is rejected as COMMAND_ID_REUSED', async () => {
  const f = await taskFixture();
  const proposal = await generateTaskSkillProposal(f);
  const api = await startTestApi();
  const path = `${workspacePath(f.workspaceId)}/assist-proposals/${proposal.id}/accept`;
  const commandId = randomUUID();
  const blocker = await ControlledLock.holdCandidateRow('assist_proposals', proposal.id);
  try {
    const same = { command_id: commandId, expected_task_revision: proposal.taskRevision,
      expected_acceptance_revision: proposal.acceptanceRevision,
      payload_hash: proposal.payloadHash };
    const different = { ...same, expected_task_revision: '99' };
    const first = api.post(path, same);
    const second = api.post(path, different);
    await blocker.waitForBlockedWaiters(2);
    await blocker.release();
    const [winner, loser] = await Promise.all([first, second]);
    const statuses = [winner.status, loser.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    expectProblem(winner.status === 409 ? winner : loser, 409, 'COMMAND_ID_REUSED');
    // 幂等重放不能放宽：异内容必须拒绝，且只留下胜出那一次业务效果。
    assert.equal(await receiptCount(`workspace:${f.workspaceId}:user:local`, commandId), 1);
    const acceptance = await sql<{ count: number }>`select count(*)::int as count
      from task_acceptances where task_id = ${f.taskId}`.execute(app.db);
    assert.equal(acceptance.rows[0]!.count, 2);
  } finally { await blocker.discard(); await api.stop(); }
});

test('concurrent Apply of one Blueprint with the same command_id replays the first receipt', async () => {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'F24 蓝图并发', projectType: 'THESIS' });
  const projectId = project.result.project_id;
  const goal = await createGoal(app.db, { workspaceId, commandId: randomUUID(),
    title: '完成研究', description: '' });
  const api = await startTestApi();
  const path = `${workspacePath(workspaceId)}/projects/${projectId}/blueprint-proposals`;
  try {
    const createCommandId = randomUUID();
    const created = expectCommandAccepted(await api.post(path, { command_id: createCommandId,
      expected_project_revision: '0', expected_state_revision: '0',
      expected_view_revision: '0', draft: newDraft(goal.result.goal_id) }), 201,
    createCommandId) as { id: string; candidate_sha256: string };
    const applyPath = `${path}/${created.id}/apply`;
    const commandId = randomUUID();
    const body = { command_id: commandId, candidate_sha256: created.candidate_sha256,
      expected_project_revision: '0', expected_state_revision: '0',
      expected_view_revision: '0' };
    const blocker = await ControlledLock.holdCandidateRow('project_blueprint_proposals', created.id);
    try {
      const first = api.post(applyPath, body);
      const second = api.post(applyPath, body);
      await blocker.waitForBlockedWaiters(2);
      await blocker.release();
      const [winner, loser] = await Promise.all([first, second]);
      // 修复前这里是 200 + 500 INTERNAL_ERROR（输的一方再插一条同 command_id 回执）。
      assert.equal(winner.status, 200, `winner: ${winner.text}`);
      assert.equal(loser.status, 200, `loser must replay, not fail: ${loser.text}`);
      assert.deepEqual(loser.body as unknown, winner.body);
      const replays = [winner, loser].map((response) => response.headers['command-replayed']);
      assert.equal(replays.filter((value) => value === 'true').length, 1);
      const result = winner.body as { result: { project_revision: string;
        state_revision: string; view_revision: string } };
      assert.equal(result.result.project_revision, '1');
      assert.equal(result.result.state_revision, '2');
      assert.equal(result.result.view_revision, '1');
      // 只提交一次业务效果：两条 Task、一次蓝图应用审计、一条回执。
      const tasks = await sql<{ count: number }>`select count(*)::int as count
        from tasks where project_id = ${projectId}`.execute(app.db);
      assert.equal(tasks.rows[0]!.count, 2);
      const audit = await sql<{ count: number }>`select count(*)::int as count
        from activity_records where command_id = ${commandId}
        and event_type = 'PROJECT_BLUEPRINT_APPLIED'`.execute(app.db);
      assert.equal(audit.rows[0]!.count, 1);
      assert.equal(await receiptCount(`workspace:${workspaceId}:user:local`, commandId), 1);
      const proposal = await sql<{ status: string }>`select status
        from project_blueprint_proposals where id = ${created.id}`.execute(app.db);
      assert.equal(proposal.rows[0]!.status, 'ACCEPTED');
    } finally { await blocker.discard(); }
  } finally { await api.stop(); }
});

test('concurrent Apply with one command_id but different baseline is rejected as COMMAND_ID_REUSED', async () => {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'F24 蓝图异内容', projectType: 'THESIS' });
  const projectId = project.result.project_id;
  const goal = await createGoal(app.db, { workspaceId, commandId: randomUUID(),
    title: '完成研究', description: '' });
  const api = await startTestApi();
  const path = `${workspacePath(workspaceId)}/projects/${projectId}/blueprint-proposals`;
  try {
    const createCommandId = randomUUID();
    const created = expectCommandAccepted(await api.post(path, { command_id: createCommandId,
      expected_project_revision: '0', expected_state_revision: '0',
      expected_view_revision: '0', draft: newDraft(goal.result.goal_id) }), 201,
    createCommandId) as { id: string; candidate_sha256: string };
    const applyPath = `${path}/${created.id}/apply`;
    const commandId = randomUUID();
    const body = { command_id: commandId, candidate_sha256: created.candidate_sha256,
      expected_project_revision: '0', expected_state_revision: '0',
      expected_view_revision: '0' };
    const blocker = await ControlledLock.holdCandidateRow('project_blueprint_proposals', created.id);
    try {
      const first = api.post(applyPath, body);
      const second = api.post(applyPath, { ...body, expected_state_revision: '7' });
      await blocker.waitForBlockedWaiters(2);
      await blocker.release();
      const [winner, loser] = await Promise.all([first, second]);
      const statuses = [winner.status, loser.status].sort();
      assert.deepEqual(statuses, [200, 409]);
      expectProblem(winner.status === 409 ? winner : loser, 409, 'COMMAND_ID_REUSED');
      assert.equal(await receiptCount(`workspace:${workspaceId}:user:local`, commandId), 1);
      const tasks = await sql<{ count: number }>`select count(*)::int as count
        from tasks where project_id = ${projectId}`.execute(app.db);
      assert.equal(tasks.rows[0]!.count, 2);
    } finally { await blocker.discard(); }
  } finally { await api.stop(); }
});

test('different command_ids competing on one Blueprint keep the existing protocol and apply once', async () => {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'F24 蓝图双命令', projectType: 'THESIS' });
  const projectId = project.result.project_id;
  const goal = await createGoal(app.db, { workspaceId, commandId: randomUUID(),
    title: '完成研究', description: '' });
  const api = await startTestApi();
  const path = `${workspacePath(workspaceId)}/projects/${projectId}/blueprint-proposals`;
  try {
    const createCommandId = randomUUID();
    const created = expectCommandAccepted(await api.post(path, { command_id: createCommandId,
      expected_project_revision: '0', expected_state_revision: '0',
      expected_view_revision: '0', draft: newDraft(goal.result.goal_id) }), 201,
    createCommandId) as { id: string; candidate_sha256: string };
    const applyPath = `${path}/${created.id}/apply`;
    const first = randomUUID();
    const second = randomUUID();
    const base = { candidate_sha256: created.candidate_sha256,
      expected_project_revision: '0', expected_state_revision: '0',
      expected_view_revision: '0' };
    const blocker = await ControlledLock.holdCandidateRow('project_blueprint_proposals', created.id);
    try {
      const one = api.post(applyPath, { ...base, command_id: first });
      const two = api.post(applyPath, { ...base, command_id: second });
      await blocker.waitForBlockedWaiters(2);
      await blocker.release();
      const [winner, loser] = await Promise.all([one, two]);
      assert.equal(winner.status, 200, `winner: ${winner.text}`);
      // 既有协议：不同命令各自留回执，后到者按已接受候选重放同一业务结果，
      // 不产生第二组效果，也不返回 409。
      assert.equal(loser.status, 200, `loser: ${loser.text}`);
      assert.deepEqual((loser.body as { result: unknown }).result,
        (winner.body as { result: unknown }).result);
      assert.equal(loser.headers['command-replayed'], 'true');
      assert.equal(await receiptCount(`workspace:${workspaceId}:user:local`, first), 1);
      assert.equal(await receiptCount(`workspace:${workspaceId}:user:local`, second), 1);
      const tasks = await sql<{ count: number }>`select count(*)::int as count
        from tasks where project_id = ${projectId}`.execute(app.db);
      assert.equal(tasks.rows[0]!.count, 2);
      const applied = await sql<{ count: number }>`select count(*)::int as count
        from activity_records where event_type = 'PROJECT_BLUEPRINT_APPLIED'
        and project_id = ${projectId}`.execute(app.db);
      assert.equal(applied.rows[0]!.count, 1);
    } finally { await blocker.discard(); }
  } finally { await api.stop(); }
});

test('cross-candidate Accept: one command_id on two different Task Skill proposals reuses the winning receipt', async () => {
  const f = await taskFixture();
  const otherTaskId = await secondTask(f.workspaceId, f.projectId, 'F24 任务 B');
  const first = await generateTaskSkillProposal(f);
  const second = await generateTaskSkillProposal({ workspaceId: f.workspaceId, taskId: otherTaskId });
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.payloadHash, second.payloadHash,
    'two candidates must differ in request digest for this to be a real conflict');
  const before = await taskAcceptanceSnapshot([f.taskId, otherTaskId]);
  const api = await startTestApi();
  const commandId = randomUUID();
  const bodyFor = (proposal: { id: string; taskRevision: string;
    acceptanceRevision: string; payloadHash: string }) => ({
    command_id: commandId, expected_task_revision: proposal.taskRevision,
    expected_acceptance_revision: proposal.acceptanceRevision,
    payload_hash: proposal.payloadHash });
  try {
    const barrier = await ControlledLock.holdReceiptInsert();
    try {
      const one = api.post(`${workspacePath(f.workspaceId)}/assist-proposals/${first.id}/accept`,
        bodyFor(first));
      const two = api.post(`${workspacePath(f.workspaceId)}/assist-proposals/${second.id}/accept`,
        bodyFor(second));
      // 两个候选互不串行，都会跑完所有读取（含候选锁后的回执重查），只停在写同一条回执上。
      await barrier.waitForBlockedWaiters(2);
      await barrier.release();
      const responses = await Promise.all([one, two]);
      const winner = responses.find((response) => response.status === 200);
      const loser = responses.find((response) => response.status !== 200);
      // 修复前这里是 200 + 500 INTERNAL_ERROR（唯一约束冲突未被翻译成命令冲突）。
      assert.ok(winner, `expected one 200, got ${responses.map((r) => r.status).join('/')}`);
      assert.ok(loser, `expected one failure, got ${responses.map((r) => r.status).join('/')}`);
      expectProblem(loser!, 409, 'COMMAND_ID_REUSED');
      const winnerBody = winner.body as { command_id: string; result: JsonObject };
      assert.equal(winnerBody.command_id, commandId);
      assert.equal(await receiptCount(`workspace:${f.workspaceId}:user:local`, commandId), 1);

      // 以胜出回执判断谁赢了，不假定请求到达顺序。
      const decided = await sql<{ id: string; status: string; task_id: string | null;
        decision: { command_id: string } | null }>`
        select id, status, target_id as task_id, decision from assist_proposals
        where id in (${sql.join([first.id, second.id].map((id) => sql`${id}`))})
        order by id`.execute(app.db);
      const accepted = decided.rows.filter((row) => row.status === 'ACCEPTED');
      const pending = decided.rows.filter((row) => row.status === 'PENDING');
      assert.equal(accepted.length, 1, 'exactly one candidate is accepted');
      assert.equal(pending.length, 1, 'the losing candidate stays PENDING');
      assert.equal(accepted[0]!.decision?.command_id, commandId);
      assert.equal(pending[0]!.id, accepted[0]!.id === first.id ? second.id : first.id);
      const winnerTaskId = accepted[0]!.task_id!;
      assert.equal(winnerTaskId, winnerBody.result.proposal_id === first.id ? f.taskId : otherTaskId);

      // 失败方的验收/条件一个字节都不能变。
      const after = await taskAcceptanceSnapshot([f.taskId, otherTaskId]);
      const loserTaskId = winnerTaskId === f.taskId ? otherTaskId : f.taskId;
      assert.equal(after.get(winnerTaskId)!.acceptances, 2,
        'the winning task advances acceptance exactly once');
      assert.deepEqual(after.get(loserTaskId), before.get(loserTaskId),
        'the losing task keeps its original acceptance and criteria');
      const audits = await sql<{ count: number }>`select count(*)::int as count
        from activity_records where command_id = ${commandId}
        and event_type = 'TASK_ACCEPTANCE_CHANGED'`.execute(app.db);
      assert.equal(audits.rows[0]!.count, 1, 'one acceptance audit for the winning command');
    } finally { await barrier.discard(); }
  } finally { await api.stop(); }
});

test('cross-candidate Apply: one command_id on two Blueprint proposals returns 200 and 409 COMMAND_ID_REUSED', async () => {
  const workspaceId = await createWorkspace(app.db);
  const goal = await createGoal(app.db, { workspaceId, commandId: randomUUID(),
    title: '完成研究', description: '' });
  const first = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'F24 蓝图甲', projectType: 'THESIS' });
  const second = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'F24 蓝图乙', projectType: 'THESIS' });
  const api = await startTestApi();
  const commandId = randomUUID();
  try {
    const candidates = await Promise.all([first, second].map(async (project) => {
      const path = `${workspacePath(workspaceId)}/projects/${project.result.project_id}/blueprint-proposals`;
      const createCommandId = randomUUID();
      const created = expectCommandAccepted(await api.post(path, { command_id: createCommandId,
        expected_project_revision: '0', expected_state_revision: '0',
        expected_view_revision: '0', draft: newDraft(goal.result.goal_id) }), 201,
      createCommandId) as { id: string; candidate_sha256: string };
      return { projectId: project.result.project_id, path, ...created };
    }));
    assert.notEqual(candidates[0]!.id, candidates[1]!.id);
    // 两个候选的 draft 可以相同（candidate_sha256 只覆盖候选本身），真正决定命令摘要
    //不同的是 target 里的 project_id 与 proposal_id——所以冲突来自目标不同，不是内容不同。
    const before = await blueprintSnapshot(candidates.map((entry) => entry.projectId));
    const barrier = await ControlledLock.holdReceiptInsert();
    try {
      const requests = candidates.map((candidate) => api.post(`${candidate.path}/${candidate.id}/apply`, {
        command_id: commandId, candidate_sha256: candidate.candidate_sha256,
        expected_project_revision: '0', expected_state_revision: '0',
        expected_view_revision: '0' }));
      await barrier.waitForBlockedWaiters(2);
      await barrier.release();
      const responses = await Promise.all(requests);
      const winner = responses.find((response) => response.status === 200);
      const loser = responses.find((response) => response.status !== 200);
      assert.ok(winner, `expected one 200, got ${responses.map((r) => r.status).join('/')}`);
      assert.ok(loser, `expected one failure, got ${responses.map((r) => r.status).join('/')}`);
      expectProblem(loser!, 409, 'COMMAND_ID_REUSED');
      assert.equal(await receiptCount(`workspace:${workspaceId}:user:local`, commandId), 1);
      const statuses = await sql<{ id: string; status: string }>`
        select id, status from project_blueprint_proposals
        where id in (${sql.join(candidates.map((candidate) => sql`${candidate.id}`))})
        order by id`.execute(app.db);
      const accepted = statuses.rows.filter((row) => row.status === 'ACCEPTED');
      assert.equal(accepted.length, 1, 'exactly one candidate is applied');
      assert.equal(statuses.rows.filter((row) => row.status === 'PENDING').length, 1,
        'the losing candidate stays PENDING');
      // 以数据库里的胜出候选判断哪个项目赢了，不假定请求到达顺序。
      const winnerProjectId = candidates.find((candidate) =>
        candidate.id === accepted[0]!.id)!.projectId;
      const loserProjectId = candidates.find((candidate) =>
        candidate.projectId !== winnerProjectId)!.projectId;
      const winnerResult = (winner.body as { result: { task_id_map: unknown[] } }).result;
      assert.equal(winnerResult.task_id_map.length, 2);

      // 胜出项目前进一版，失败项目 State/View/Task 数量全部不变。
      const after = await blueprintSnapshot(candidates.map((entry) => entry.projectId));
      assert.equal(after.get(winnerProjectId)!.state_revision, '2');
      assert.equal(after.get(winnerProjectId)!.view_revision, '1');
      assert.equal(after.get(winnerProjectId)!.tasks, 2);
      assert.deepEqual(after.get(loserProjectId), before.get(loserProjectId),
        'the losing blueprint leaves State, View and Task count untouched');
      const audits = await sql<{ count: number }>`select count(*)::int as count
        from activity_records where command_id = ${commandId}
        and event_type = 'PROJECT_BLUEPRINT_APPLIED'`.execute(app.db);
      assert.equal(audits.rows[0]!.count, 1, 'one blueprint audit for the winning command');
    } finally { await barrier.discard(); }
  } finally { await api.stop(); }
});