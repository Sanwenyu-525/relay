import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage } from
  '../../src/application/assist-commands.js';
import { createAssistantProfile } from '../../src/application/assistant-profile-commands.js';
import { applyStateMaintenance, interpretStateMaintenance, replyStateDecision,
  withdrawStateMaintenance } from
  '../../src/application/conversation-state.js';
import { createGoal } from '../../src/application/create-goal.js';
import { linkProjectGoal } from '../../src/application/project-goal-links.js';
import { addTaskDependency, editTaskPresentation, markTaskReady, setTaskPlanningMetadata,
  startHumanTask } from
  '../../src/application/task-commands.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { ConversationStateRepository } from '../../src/assist/conversation-state-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import type { AssistModelPort, ConversationInterpretationRequest, ModelIdentity } from
  '../../src/workflow/fake-model-port.js';
import {
  createWorkspace, expectCommandAccepted, expectProblem, startTestApi, workspacePath,
  type TestApi,
} from './api-harness.js';
import {
  APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase,
} from './integration-support.js';

/**
 * 自然语言状态维护（迁移 0062）的真实 PG + 真实 HTTP 验收。
 *
 * 数据隔离说明：运行器为每个测试文件克隆独占数据库（run-integration.ps1 按
 * CREATE DATABASE ... TEMPLATE 逐文件发库）。本套件只走 runIdempotentCommand 短事务，
 * 不驱动 claimNextPendingMessage / Run 命令队列等整库领取语义，因此不需要额外的
 * 独占 fixture 约定，按 api-state 的模式启动真实 API 进程即可。
 *
 * 解释与应用/撤回的混合驱动：解释阶段必须注入可控 stub modelPort（HTTP 进程的模型端口
 * 由环境决定，无法从测试进程替换），所以解释用直连用例 interpretStateMaintenance 驱动；
 * 应用与整组撤回的幂等重放、状态推进、逐条结算走真实 HTTP 端点，验证完整契约。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-conversation-state');

let api: TestApi;

before(async () => {
  await runMigrations({
    connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY,
  });
  api = await startTestApi();
});

after(async () => {
  await api?.stop();
  await app.close();
});

const identity: ModelIdentity = { provider: 'fake', model: 'fake-model-v1',
  configFingerprint: 'conversation-state-test' };

/** 可控解释端口：只回给定的候选 JSON，不触网络。 */
function candidate(changes: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { decision: 'MAINTAIN', questions: [], decision_required: null, changes };
}

function port(body: unknown, requests?: ConversationInterpretationRequest[]): AssistModelPort {
  return { identity, assist: async () => { throw new Error('assist is not used in this suite'); },
    interpret: async (request) => {
      requests?.push(request);
      return { kind: 'CONTENT', content: JSON.stringify(body), providerRequestId: 'test',
        usage: { inputTokens: 1, outputTokens: 1 } };
    } };
}

async function createProject(ws: string): Promise<{ projectId: string; revision: string }> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(ws, '/projects'), {
    command_id: commandId,
    title: '状态维护项目',
    project_type: 'DEVELOPMENT',
  });
  const result = expectCommandAccepted(response, 201, commandId);
  return { projectId: result.project_id as string, revision: result.revision as string };
}

async function freshWorkspace(): Promise<string> {
  return createWorkspace(app.db);
}

async function sessionIn(ws: string, projectId: string, content: string): Promise<{
  sessionId: string; userMessageId: string;
}> {
  const session = await createAssistSession(app.db, { workspaceId: ws,
    commandId: randomUUID(), projectId, title: '状态维护会话' });
  const sent = await requestAssistMessage(app.db, { workspaceId: ws,
    sessionId: session.result.session_id, commandId: randomUUID(), content });
  return { sessionId: session.result.session_id, userMessageId: sent.result.user_message_id };
}

async function assistantSessionIn(ws: string, projectId: string, content: string): Promise<{
  sessionId: string; userMessageId: string;
}> {
  const profile = await createAssistantProfile(app.db, { workspaceId: ws,
    commandId: randomUUID(), name: '审读', roleDescription: '只读复核', tone: '简短' });
  const session = await createAssistSession(app.db, { workspaceId: ws,
    commandId: randomUUID(), projectId, title: '助手档会话',
    conversationMode: 'ASSISTANT', assistantProfileId: profile.result.assistant_profile_id as string });
  const sent = await requestAssistMessage(app.db, { workspaceId: ws,
    sessionId: session.result.session_id, commandId: randomUUID(), content });
  return { sessionId: session.result.session_id, userMessageId: sent.result.user_message_id };
}

async function httpTask(ws: string, projectId: string, title: string): Promise<string> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(ws, '/tasks'), {
    command_id: commandId,
    project_id: projectId,
    title,
    objective: '为状态维护提供既有事实',
    criteria: [{ statement: '人工核对' }],
  });
  return expectCommandAccepted(response, 201, commandId).task_id as string;
}

async function readState(ws: string, projectId: string): Promise<Record<string, unknown>> {
  const response = await api.get(workspacePath(ws, `/projects/${projectId}/state`));
  assert.equal(response.status, 200, response.text);
  return response.body as Record<string, unknown>;
}

/** 人工路径：按当前版本推进阶段（相当于用户在正式 state-commands 上的操作）。 */
async function setPhaseViaHttp(ws: string, projectId: string, phaseKey: string): Promise<void> {
  const current = await readState(ws, projectId);
  const commandId = randomUUID();
  const response = await api.post(workspacePath(ws, `/projects/${projectId}/state-commands`), {
    command_id: commandId, expected_revision: current.revision as string,
    action: 'SET_PHASE', phase_key: phaseKey,
  });
  assert.equal(response.status, 200, response.text);
}

/** 直接驱动解释用例（可控模型端口），返回完整请求行以核对阶段事实。 */
async function interpretRaw(ws: string,
  session: { sessionId: string; userMessageId: string }, candidateBody: unknown,
  input: { readonly commandId?: string; readonly timezone?: string;
    readonly modelPort?: AssistModelPort } = {}) {
  return interpretStateMaintenance(app.db, { workspaceId: ws, sessionId: session.sessionId,
    sourceMessageId: session.userMessageId, commandId: input.commandId ?? randomUUID(),
    timezone: input.timezone,
    modelPort: input.modelPort ?? port(candidateBody) });
}

async function interpret(ws: string, session: { sessionId: string; userMessageId: string },
  candidate: unknown, requests?: ConversationInterpretationRequest[]): Promise<{
    requestId: string; status: string; decision: string; replayed: boolean;
  }> {
  const commandId = randomUUID();
  const outcome = await interpretStateMaintenance(app.db, { workspaceId: ws,
    sessionId: session.sessionId, sourceMessageId: session.userMessageId, commandId,
    modelPort: port(candidate, requests) });
  return { requestId: outcome.result.request.id, status: outcome.result.request.status,
    decision: outcome.result.request.decision, replayed: outcome.replayed };
}

async function applyViaHttp(ws: string, requestId: string): Promise<Record<string, unknown>> {
  const response = await api.post(workspacePath(ws,
    `/conversation-state-requests/${requestId}/applications`), {});
  assert.equal(response.status, 200, response.text);
  return (response.body as { result: Record<string, unknown> }).result;
}

async function withdrawViaHttp(ws: string, requestId: string, commandId: string,
  extra: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await api.post(workspacePath(ws,
    `/conversation-state-requests/${requestId}/withdrawals`),
    { command_id: commandId, ...extra });
  return { status: response.status,
    body: response.status === 200
      ? (response.body as { result: Record<string, unknown> }).result
      : response.body as Record<string, unknown> };
}

interface UndoPlanView {
  readonly request_id: string; readonly undo_command_id: string;
  readonly plan_digest: string; readonly fully_withdrawable: boolean;
  readonly blocked_count: number; readonly state_revision: string;
  readonly items: readonly { readonly change_id: string; readonly ordinal: number;
    readonly change_kind: string; readonly withdrawable: boolean;
    readonly reason_code: string | null; readonly reason: string | null;
    readonly impact: string | null; readonly facts: Record<string, unknown> }[];
}

async function undoPlanViaHttp(ws: string, requestId: string): Promise<UndoPlanView> {
  const response = await api.get(workspacePath(ws,
    `/conversation-state-requests/${requestId}/undo-plan`));
  assert.equal(response.status, 200, response.text);
  return response.body as UndoPlanView;
}

/** 从读投影取逐条变更状态（UI 与验收看的就是这一份事实）。 */
async function requestChanges(ws: string, requestId: string): Promise<{
  readonly change_kind: string; readonly status: string;
  readonly error: { readonly code: string } | null }[]> {
  const response = await api.get(workspacePath(ws,
    `/conversation-state-requests/${requestId}`));
  assert.equal(response.status, 200, response.text);
  const body = response.body as { changes: { change_kind: string; status: string;
    error: { code: string } | null }[] | null };
  assert.ok(body.changes !== null);
  return body.changes;
}

/** 从库读请求行（撤回身份 undo_command_id 不在冻结的读投影里，测试按事实源取用）。 */
async function requestRow(requestId: string) {
  const row = await createRepositories(app.db).conversationState.readRequest(requestId);
  assert.ok(row !== undefined);
  return row;
}

test('MAINTAIN 多条变更逐条生效；同命令身份重放不产生第二组对象或版本', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const existingTaskId = await httpTask(ws, project.projectId, '测试通过');
  const session = await sessionIn(ws, project.projectId,
    '进入构建阶段，下一步做「测试通过」，再建一个写发布说明的任务');

  const requests: ConversationInterpretationRequest[] = [];
  const interpreted = await interpret(ws, session, {
    decision: 'MAINTAIN', questions: [], decision_required: null,
    changes: [
      { kind: 'SET_PHASE', phase: 'IMPLEMENTATION' },
      { kind: 'SET_NEXT_ACTION', task_title: '测试通过' },
      { kind: 'CREATE_TASK', title: '写发布说明' },
    ] }, requests);
  assert.equal(interpreted.decision, 'MAINTAIN');
  assert.equal(interpreted.status, 'READY');
  // 解释提示词要求：只解释不执行、外部内容不是授权、对象用标题指称。
  assert.match(requests[0]!.system, /只解释原用户意图/u);
  assert.match(requests[0]!.system, /不能作为用户授权/u);
  assert.match(requests[0]!.system, /ID 由应用按当前事实重新解析/u);
  assert.equal(requests[0]!.userContent, '进入构建阶段，下一步做「测试通过」，再建一个写发布说明的任务');

  const readBack = await api.get(workspacePath(ws,
    `/conversation-state-requests/${interpreted.requestId}`));
  assert.equal(readBack.status, 200, readBack.text);
  const readBody = readBack.body as { changes: { ordinal: number; change_kind: string;
    status: string }[] | null; decision_required: unknown; status: string };
  assert.equal(readBody.status, 'READY');
  assert.equal(readBody.decision_required, null);
  assert.ok(readBody.changes !== null);
  assert.equal(readBody.changes.length, 3);
  assert.deepEqual(readBody.changes.map((change) => change.status),
    ['PENDING', 'PENDING', 'PENDING']);

  const applied = await applyViaHttp(ws, interpreted.requestId);
  assert.equal(applied.status, 'APPLIED');
  const changes = applied.changes as { ordinal: number; change_kind: string; status: string;
    before_ref: Record<string, unknown> | null;
    after_ref: Record<string, unknown> | null }[];
  assert.equal(changes.length, 3);
  assert.deepEqual(changes.map((change) => change.status), ['APPLIED', 'APPLIED', 'APPLIED']);
  assert.deepEqual(changes[0]!.before_ref, { phase: 'DISCOVERY' });
  // after_ref 除结果外携带生效后的 State 版本：撤回与恢复按它核对适用性，不读最新 revision。
  assert.deepEqual(changes[0]!.after_ref, { phase: 'IMPLEMENTATION', state_revision: '1' });
  assert.deepEqual(changes[1]!.after_ref,
    { task_id: existingTaskId, state_revision: '2' });
  const createdTaskId = changes[2]!.after_ref?.task_id as string;
  assert.ok(typeof createdTaskId === 'string' && createdTaskId !== '');

  // 业务事实真实变化：State 推进、下一步指向既有任务、新 Task 停在 INBOX。
  const state = await readState(ws, project.projectId);
  assert.equal(state.phase_key, 'IMPLEMENTATION');
  assert.equal(state.next_action_task_id, existingTaskId);
  const createdTask = await api.get(workspacePath(ws, `/tasks/${createdTaskId}`));
  assert.equal((createdTask.body as { status: string }).status, 'INBOX');

  // 同 command_id 再解释：回执重放，不再调用模型，不产生第二个请求行。
  const rowBefore = await requestRow(interpreted.requestId);
  const sameCommand = await interpretStateMaintenance(app.db, { workspaceId: ws,
    sessionId: session.sessionId, sourceMessageId: session.userMessageId,
    commandId: rowBefore.command_id, modelPort: port({ decision: 'DISCUSS' }) });
  assert.equal(sameCommand.replayed, true);
  assert.equal(sameCommand.result.request.id, interpreted.requestId);
  assert.equal(sameCommand.result.request.decision, 'MAINTAIN');

  // 重发 applications：终态按已保存结算回读，事实不再变化。
  const reapplied = await applyViaHttp(ws, interpreted.requestId);
  assert.equal(reapplied.status, 'APPLIED');
  const stateAfterReplay = await readState(ws, project.projectId);
  assert.equal(stateAfterReplay.revision, state.revision);
  const tasks = await createRepositories(app.db).tasks
    .listProjectTasksByStatus(project.projectId,
      ['INBOX', 'READY', 'IN_PROGRESS', 'WAITING', 'BLOCKED', 'DONE', 'CANCELLED']);
  assert.equal(tasks.filter((task) => task.title === '写发布说明').length, 1);
});

test('引用不存在的任务标题时该条 FAILED 类型化、其余生效、请求 PARTIAL', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const session = await sessionIn(ws, project.projectId, '进入实现阶段，下一步做「不存在的任务」');
  const interpreted = await interpret(ws, session, {
    decision: 'MAINTAIN', questions: [], decision_required: null,
    changes: [
      { kind: 'SET_PHASE', phase: 'IMPLEMENTATION' },
      { kind: 'SET_NEXT_ACTION', task_title: '不存在的任务' },
    ] });
  const applied = await applyViaHttp(ws, interpreted.requestId);
  assert.equal(applied.status, 'PARTIAL');
  const changes = applied.changes as { change_kind: string; status: string;
    error: { code: string } | null }[];
  assert.equal(changes[0]!.status, 'APPLIED');
  assert.equal(changes[1]!.status, 'FAILED');
  assert.equal(changes[1]!.error?.code, 'TASK_NOT_FOUND');
  const state = await readState(ws, project.projectId);
  assert.equal(state.phase_key, 'IMPLEMENTATION');
  assert.equal(state.next_action_task_id, null);
});

test('整组撤回按逆序补偿；重复撤回幂等；错误身份被类型化拒绝', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const existingTaskId = await httpTask(ws, project.projectId, '测试通过');
  const session = await sessionIn(ws, project.projectId, '进入构建并建一个发布任务');
  const interpreted = await interpret(ws, session, {
    decision: 'MAINTAIN', questions: [], decision_required: null,
    changes: [
      { kind: 'SET_PHASE', phase: 'IMPLEMENTATION' },
      { kind: 'SET_NEXT_ACTION', task_title: '测试通过' },
      { kind: 'CREATE_TASK', title: '写发布说明' },
    ] });
  const applied = await applyViaHttp(ws, interpreted.requestId);
  assert.equal(applied.status, 'APPLIED');
  const row = await requestRow(interpreted.requestId);

  // 错误身份先于任何补偿被拒：撤回不接受新造身份。
  const wrong = await withdrawViaHttp(ws, interpreted.requestId, row.command_id);
  assert.equal(wrong.status, 422);
  assert.equal((wrong.body as { code: string }).code, 'VALIDATION_FAILED');

  const withdrawn = await withdrawViaHttp(ws, interpreted.requestId, row.undo_command_id);
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.status, 'UNDONE');
  const changes = withdrawn.body.changes as { ordinal: number; status: string }[];
  assert.deepEqual(changes.map((change) => change.status),
    ['COMPENSATED', 'COMPENSATED', 'COMPENSATED']);
  // 逆序补偿的结算顺序：最后应用的 CREATE_TASK 最先被补偿。
  const createdTaskId = (applied.changes as { after_ref: Record<string, unknown> }[])[2]!
    .after_ref.task_id as string;
  const cancelledTask = await api.get(workspacePath(ws, `/tasks/${createdTaskId}`));
  assert.equal((cancelledTask.body as { status: string }).status, 'CANCELLED');
  const state = await readState(ws, project.projectId);
  assert.equal(state.phase_key, 'DISCOVERY');
  assert.equal(state.next_action_task_id, null);

  // 重复撤回（同 undo_command_id）幂等：状态不变，不再补偿第二次。
  const again = await withdrawViaHttp(ws, interpreted.requestId, row.undo_command_id);
  assert.equal(again.status, 200);
  assert.equal(again.body.status, 'UNDONE');
  const stateAfterReplay = await readState(ws, project.projectId);
  assert.equal(stateAfterReplay.phase_key, 'DISCOVERY');
});

test('DECISION_REQUIRED 请求不自动应用，applications 被 409 拒绝', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const session = await sessionIn(ws, project.projectId, '把阶段改了，但这会动既定的发布计划');
  const interpreted = await interpret(ws, session, {
    decision: 'MAINTAIN', questions: [],
    changes: [{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }],
    decision_required: { summary: '影响既定的发布计划', question: '是否调整发布时间？',
      affected: ['发布计划'] } });
  assert.equal(interpreted.status, 'DECISION_REQUIRED');
  assert.equal(interpreted.decision, 'MAINTAIN');

  const response = await api.post(workspacePath(ws,
    `/conversation-state-requests/${interpreted.requestId}/applications`), {});
  const problem = expectProblem(response, 409, 'INVALID_TRANSITION');
  assert.match(problem.detail, /连带承诺的决定/u);
  const state = await readState(ws, project.projectId);
  assert.equal(state.phase_key, 'DISCOVERY');
});

test('助手档会话发起状态维护被类型化拒绝', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const session = await assistantSessionIn(ws, project.projectId, '帮我改一下阶段');
  await assert.rejects(() => interpretStateMaintenance(app.db, { workspaceId: ws,
    sessionId: session.sessionId, sourceMessageId: session.userMessageId,
    commandId: randomUUID(), modelPort: port({ decision: 'MAINTAIN', changes: [
      { kind: 'SET_PHASE', phase: 'IMPLEMENTATION' } ] }) }),
    (error: Error) => {
      assert.match(error.message, /助手档会话只读/u);
      return true;
    });
});

test('CLARIFY / DISCUSS 不写任何业务事实；DISCUSS 不产生候选', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const stateBefore = await readState(ws, project.projectId);

  const clarifySession = await sessionIn(ws, project.projectId, '改一下状态');
  await interpret(ws, clarifySession, {
    decision: 'CLARIFY', questions: ['要改到哪个阶段？'], changes: [], decision_required: null });
  const discussSession = await sessionIn(ws, project.projectId, '先聊聊项目现在的进展吧');
  const discussed = await interpret(ws, discussSession, {
    decision: 'DISCUSS', questions: [], changes: [], decision_required: null });
  assert.equal(discussed.status, 'DISCUSSED');

  const stateAfter = await readState(ws, project.projectId);
  assert.equal(stateAfter.revision, stateBefore.revision);
  assert.equal(stateAfter.phase_key, stateBefore.phase_key);

  const list = await api.get(workspacePath(ws,
    `/conversation-state-requests?session_id=${discussSession.sessionId}`));
  const listBody = list.body as { items: { request_id: string; decision: string;
    changes: unknown }[] };
  const discussedRow = listBody.items.find((item) => item.request_id === discussed.requestId);
  assert.ok(discussedRow !== undefined);
  assert.equal(discussedRow.decision, 'DISCUSS');
  assert.equal(discussedRow.changes, null);

  const clarifyList = await api.get(workspacePath(ws,
    `/conversation-state-requests?session_id=${clarifySession.sessionId}`));
  const clarifyBody = clarifyList.body as { items: { decision: string; status: string;
    changes: unknown; questions: string[] }[] };
  assert.equal(clarifyBody.items.length, 1);
  assert.equal(clarifyBody.items[0]!.decision, 'CLARIFY');
  assert.equal(clarifyBody.items[0]!.changes, null);
  assert.deepEqual(clarifyBody.items[0]!.questions, ['要改到哪个阶段？']);
});

test('事前已知无法整组撤回：一项都不补偿，给出具体方案后按确认范围执行（NLS-11 / 4.3）', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const session = await sessionIn(ws, project.projectId, '登记一个长期目标并进入构建阶段');
  const interpreted = await interpret(ws, session, {
    decision: 'MAINTAIN', questions: [], decision_required: null,
    changes: [
      { kind: 'SET_PHASE', phase: 'IMPLEMENTATION' },
      { kind: 'CREATE_GOAL', title: '按期发布' },
    ] });
  const applied = await applyViaHttp(ws, interpreted.requestId);
  assert.equal(applied.status, 'APPLIED');
  const goalId = (applied.changes as { after_ref: Record<string, unknown> }[])[1]!
    .after_ref.goal_id as string;

  const row = await requestRow(interpreted.requestId);

  // 1) 未附带已确认方案直接撤回：整组里有不可撤回项 → 409，且一项都不补偿。
  const rejected = await withdrawViaHttp(ws, interpreted.requestId, row.undo_command_id);
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal((rejected.body as { code: string }).code, 'UNDO_SCOPE_REQUIRED');
  const stateAfterReject = await readState(ws, project.projectId);
  assert.equal(stateAfterReject.phase_key, 'IMPLEMENTATION', '阶段变更不得先被补偿');
  let changesNow = await requestChanges(ws, interpreted.requestId);
  assert.deepEqual(changesNow.map((change) => change.status), ['APPLIED', 'APPLIED'],
    '预检阶段不写任何补偿');

  // 2) 读取只读方案：不可撤回项、原因与影响都可见。
  const plan = await undoPlanViaHttp(ws, interpreted.requestId);
  assert.equal(plan.fully_withdrawable, false);
  assert.equal(plan.blocked_count, 1);
  const blockedItem = plan.items.find((item) => item.change_kind === 'CREATE_GOAL');
  assert.ok(blockedItem !== undefined);
  assert.equal(blockedItem.withdrawable, false);
  assert.equal(blockedItem.reason_code, 'UNDO_ENTRY_MISSING');
  assert.ok((blockedItem.impact ?? '').includes('保留'));
  const phaseItem = plan.items.find((item) => item.change_kind === 'SET_PHASE');
  assert.ok(phaseItem !== undefined);
  assert.equal(phaseItem.withdrawable, true);

  // 3) 通用「确认整组撤回」（仍不带具体范围）不能自动授权后来缩小的方案。
  const again = await withdrawViaHttp(ws, interpreted.requestId, row.undo_command_id);
  assert.equal(again.status, 409);
  changesNow = await requestChanges(ws, interpreted.requestId);
  assert.deepEqual(changesNow.map((change) => change.status), ['APPLIED', 'APPLIED']);

  // 4) 用户对具体范围作出决定后，只执行确认且仍适用的范围。
  const confirmed = await withdrawViaHttp(ws, interpreted.requestId, row.undo_command_id, {
    plan_digest: plan.plan_digest, confirmed_change_ids: [phaseItem.change_id] });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.status, 'UNDO_PARTIAL');
  const confirmedChanges = confirmed.body.changes as { change_kind: string; status: string }[];
  assert.equal(confirmedChanges.find((change) => change.change_kind === 'SET_PHASE')?.status,
    'COMPENSATED');
  assert.equal(confirmedChanges.find((change) => change.change_kind === 'CREATE_GOAL')?.status,
    'APPLIED', '未确认范围内的事实保持生效');

  // Goal 仍在：不造删除、不假装撤销。
  const goal = await api.get(workspacePath(ws, `/goals/${goalId}`));
  assert.equal(goal.status, 200, goal.text);
  assert.equal((goal.body as { status: string }).status, 'ACTIVE');
  const state = await readState(ws, project.projectId);
  assert.equal(state.phase_key, 'DISCOVERY');

  // 5) 重复提交不产生第二次效果。
  const replay = await withdrawViaHttp(ws, interpreted.requestId, row.undo_command_id, {
    plan_digest: plan.plan_digest, confirmed_change_ids: [phaseItem.change_id] });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.status, 'UNDO_PARTIAL');
  const stateAgain = await readState(ws, project.projectId);
  assert.equal(stateAgain.phase_key, 'DISCOVERY');
  const goalAgain = await api.get(workspacePath(ws, `/goals/${goalId}`));
  assert.equal((goalAgain.body as { status: string }).status, 'ACTIVE');
});

/* -------------------------------------------------------------------------- */
/* 整改反例的正式回归（本轮独立验收复现的 10 个失败场景）                        */
/* -------------------------------------------------------------------------- */

test('应用旧候选不覆盖确认之后的人工修改（4.1 反例 A）', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const session = await sessionIn(ws, project.projectId, '进入构建阶段');
  const interpreted = await interpretRaw(ws, session,
    candidate([{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }]));
  assert.equal(interpreted.result.request.status, 'READY');

  // 解释确认之后、应用之前：人工通过正式 state-commands 改成 RELEASE。
  await setPhaseViaHttp(ws, project.projectId, 'RELEASE');

  const applied = await applyViaHttp(ws, interpreted.result.request.id);
  assert.equal(applied.status, 'FAILED', JSON.stringify(applied));
  const changes = applied.changes as { status: string;
    error: { code: string } | null }[];
  assert.equal(changes[0]!.status, 'FAILED');
  assert.equal(changes[0]!.error?.code, 'STATE_VERSION_CONFLICT');

  const state = await readState(ws, project.projectId);
  assert.equal(state.phase_key, 'RELEASE', '旧候选不得覆盖确认之后的人工修改');
});

test('同值后续修订同样识别为冲突：不只比较字段值（4.1 补充）', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const session = await sessionIn(ws, project.projectId, '进入构建阶段');
  const interpreted = await interpretRaw(ws, session,
    candidate([{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }]));

  // DISCOVERY → RELEASE → DISCOVERY：值回到原样，但版本已经推进。
  await setPhaseViaHttp(ws, project.projectId, 'RELEASE');
  await setPhaseViaHttp(ws, project.projectId, 'DISCOVERY');

  const applied = await applyViaHttp(ws, interpreted.result.request.id);
  assert.equal(applied.status, 'FAILED');
  const changes = applied.changes as { status: string; error: { code: string } | null }[];
  assert.equal(changes[0]!.error?.code, 'STATE_VERSION_CONFLICT');
  const state = await readState(ws, project.projectId);
  assert.equal(state.phase_key, 'DISCOVERY');
  assert.equal(state.revision, '2');
});

test('确认时点的目标身份被替换时按冲突拒绝，不落到另一个对象（4.1 补充）', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const originalTaskId = await httpTask(ws, project.projectId, '导出报告');
  const session = await sessionIn(ws, project.projectId, '下一步做导出报告');
  const interpreted = await interpretRaw(ws, session,
    candidate([{ kind: 'SET_NEXT_ACTION', task_title: '导出报告' }]));

  // 确认之后：原任务被重命名，另一个任务顶上了这个标题（目标替换）。
  const repositories = createRepositories(app.db);
  const originalTask = await repositories.tasks.readTask(originalTaskId);
  assert.ok(originalTask !== undefined);
  await editTaskPresentation(app.db, { workspaceId: ws, taskId: originalTaskId,
    commandId: randomUUID(), expectedRevision: String(originalTask.revision),
    title: '导出报告（改名后）' });
  await httpTask(ws, project.projectId, '导出报告');

  const applied = await applyViaHttp(ws, interpreted.result.request.id);
  assert.equal(applied.status, 'FAILED');
  const changes = applied.changes as { status: string; error: { code: string } | null }[];
  assert.equal(changes[0]!.error?.code, 'TARGET_IDENTITY_CONFLICT');
  const state = await readState(ws, project.projectId);
  assert.equal(state.next_action_task_id, null, '不得把指令落到另一个同名对象上');
});

test('撤回不覆盖确认之后的人工修改（4.1 反例 B）', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const session = await sessionIn(ws, project.projectId, '进入构建阶段');
  const interpreted = await interpret(ws, session,
    candidate([{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }]));
  const applied = await applyViaHttp(ws, interpreted.requestId);
  assert.equal(applied.status, 'APPLIED');

  // 原维护指令生效后，人工又把阶段改成 RELEASE。
  await setPhaseViaHttp(ws, project.projectId, 'RELEASE');

  const row = await requestRow(interpreted.requestId);
  const rejected = await withdrawViaHttp(ws, interpreted.requestId, row.undo_command_id);
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal((rejected.body as { code: string }).code, 'UNDO_SCOPE_REQUIRED');

  const plan = await undoPlanViaHttp(ws, interpreted.requestId);
  const phaseItem = plan.items.find((item) => item.change_kind === 'SET_PHASE');
  assert.ok(phaseItem !== undefined);
  assert.equal(phaseItem.withdrawable, false);
  assert.equal(phaseItem.reason_code, 'STATE_VERSION_CONFLICT');
  assert.ok((phaseItem.impact ?? '').includes('RELEASE'));

  const state = await readState(ws, project.projectId);
  assert.equal(state.phase_key, 'RELEASE', '撤回不得把后续人工修改改回去');
  const changes = await requestChanges(ws, interpreted.requestId);
  assert.equal(changes[0]!.status, 'APPLIED', '冲突时一条补偿都不执行');
});

test('非空但非法的 decision_required 不得进入写入（4.2 反例 A）', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const session = await sessionIn(ws, project.projectId, '调整导出与发布安排');
  const interpreted = await interpretRaw(ws, session, { decision: 'MAINTAIN', questions: [],
    decision_required: { summary: '影响本周发布', question: '是否调整发布？', affected: '发布' },
    changes: [{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }] });
  const row = interpreted.result.request;
  assert.equal(row.decision, 'CLARIFY');
  assert.equal(row.status, 'CLARIFY');
  assert.equal(row.decision_required, null, '非法待决定载荷不得被当作「没有待决定」');
  assert.equal(interpreted.result.changes.length, 0, '澄清时不产生任何变更行');

  const applied = await api.post(workspacePath(ws,
    `/conversation-state-requests/${row.id}/applications`), {});
  const problem = expectProblem(applied, 409, 'INVALID_TRANSITION');
  assert.ok(problem.detail !== undefined);
  const state = await readState(ws, project.projectId);
  assert.equal(state.phase_key, 'DISCOVERY', '非法待决定载荷不能产生业务写入');
});

test('合法与非法条目混合时整单澄清，不丢条目后宣称整组生效（4.2 反例 B）', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const session = await sessionIn(ws, project.projectId, '进入构建阶段并建一个任务');
  const interpreted = await interpretRaw(ws, session, { decision: 'MAINTAIN', questions: [],
    decision_required: null,
    changes: [{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }, { kind: 'CREATE_TASK' }] });
  const row = interpreted.result.request;
  assert.equal(row.decision, 'CLARIFY');
  assert.equal(interpreted.result.changes.length, 0,
    '无法可靠解释完整候选时整单澄清，不保留部分条目');

  const stateBefore = await readState(ws, project.projectId);
  const applied = await api.post(workspacePath(ws,
    `/conversation-state-requests/${row.id}/applications`), {});
  expectProblem(applied, 409, 'INVALID_TRANSITION');
  const stateAfter = await readState(ws, project.projectId);
  assert.deepEqual(stateAfter, stateBefore, '澄清的候选不产生任何业务写入');
});

test('同 command_id 携带另一条来源消息按 COMMAND_ID_REUSED 拒绝（4.4 A）', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const first = await sessionIn(ws, project.projectId, '进入构建阶段');
  const second = await sessionIn(ws, project.projectId, '另一条明确指令');
  const commandId = randomUUID();
  await interpretRaw(ws, first, candidate([{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }]),
    { commandId });

  const response = await api.post(workspacePath(ws,
    `/assist-sessions/${second.sessionId}/state-maintenance-requests`),
    { command_id: commandId, source_message_id: second.userMessageId });
  expectProblem(response, 409, 'COMMAND_ID_REUSED');

  // 直接调用同样按原载荷摘要拒绝：同 command_id 换来源消息不算重放。
  await assert.rejects(
    interpretRaw(ws, second, candidate([{ kind: 'SET_PHASE', phase: 'RELEASE' }]),
      { commandId }),
    (error: unknown) => (error as { name?: string }).name === 'CommandIdReusedError');

  // 原命令按原载荷重放仍回到原请求，不返回别人的成功投影。
  const replay = await interpretRaw(ws, first,
    candidate([{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }]), { commandId });
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.request.source_message_id, first.userMessageId);
});

test('同一原消息的并发解释只调用一次模型（4.4 B）', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const session = await sessionIn(ws, project.projectId, '进入构建阶段');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let firstCalls = 0;
  const firstPort: AssistModelPort = { identity,
    assist: async () => { throw new Error('assist is not used in this suite'); },
    interpret: async () => {
      firstCalls += 1;
      entered();
      await gate;
      return { kind: 'CONTENT', usage: { inputTokens: 1, outputTokens: 1 },
        providerRequestId: 'first',
        content: JSON.stringify(candidate([{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }])) };
    } };

  const first = interpretRaw(ws, session, null, { modelPort: firstPort });
  await started;

  let secondCalls = 0;
  const secondPort = port(candidate([{ kind: 'SET_PHASE', phase: 'RELEASE' }]));
  const originalInterpret = secondPort.interpret!;
  secondPort.interpret = async (request) => { secondCalls += 1; return originalInterpret(request); };
  let second: Awaited<ReturnType<typeof interpretRaw>> | undefined;
  try {
    second = await interpretRaw(ws, session, null, { modelPort: secondPort });
  } finally {
    release();
  }
  const firstOutcome = await first;

  assert.equal(firstCalls, 1, '在途解释的持久 Owner 独占模型调用');
  assert.equal(secondCalls, 0, '第二个请求不得再次调用模型');
  assert.equal(second?.result.request.id, firstOutcome.result.request.id,
    '两个命令复用同一条请求行');
  assert.equal(firstOutcome.result.request.status, 'READY');
});

test('模型明确失败有持久结算；同命令只回读，新命令沿原请求恢复（4.4 C）', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const session = await sessionIn(ws, project.projectId, '进入构建阶段');
  let calls = 0;
  const broken: AssistModelPort = { identity,
    assist: async () => { throw new Error('assist is not used in this suite'); },
    interpret: async () => { calls += 1; throw new Error('INDEPENDENT_MODEL_FAILURE'); } };
  const commandId = randomUUID();

  await assert.rejects(interpretRaw(ws, session, null, { commandId, modelPort: broken }),
    /STATE_INTERPRETATION_UNAVAILABLE/u);

  const replay = await interpretRaw(ws, session, null,
    { commandId, modelPort: port(candidate([{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }])) });
  assert.equal(replay.replayed, true);
  assert.equal(calls, 1, '同 command_id 重入只回读，不再调用模型');
  assert.notEqual(replay.result.request.status, 'INTERPRETING',
    '明确失败不能永久停在 INTERPRETING');
  assert.equal(replay.result.request.status, 'FAILED');
  assert.equal(replay.result.request.candidate_status, 'INVALID');
  assert.equal(replay.result.request.clarification === null, false,
    '失败原因对用户可读');

  // 原恢复出口：新命令身份沿同一条请求行重新解释，不换 request、不换原消息。
  let recoveredCalls = 0;
  const recoveredPort = port(candidate([{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }]));
  const recoveredInterpret = recoveredPort.interpret!;
  recoveredPort.interpret = async (request) => {
    recoveredCalls += 1;
    return recoveredInterpret(request);
  };
  const recovered = await interpretRaw(ws, session, null, { modelPort: recoveredPort });
  assert.equal(recovered.result.request.id, replay.result.request.id);
  assert.equal(recovered.result.request.status, 'READY');
  assert.equal(calls, 1, '原失败命令本身不被重复调用');
  assert.equal(recoveredCalls, 1, '恢复出口只补一次模型调用');
});

test('UNDOING 提交后故障：按原 undo_command_id 恢复剩余补偿（4.4 D）', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const session = await sessionIn(ws, project.projectId, '进入构建阶段');
  const interpreted = await interpret(ws, session,
    candidate([{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }]));
  const applied = await applyViaHttp(ws, interpreted.requestId);
  assert.equal(applied.status, 'APPLIED');
  const row = await requestRow(interpreted.requestId);

  const originalStartUndo = ConversationStateRepository.prototype.startUndo;
  ConversationStateRepository.prototype.startUndo = async function (id, input) {
    const result = await originalStartUndo.call(this, id, input);
    throw new Error('INJECT_AFTER_UNDOING_COMMIT');
  };
  try {
    await assert.rejects(
      withdrawStateMaintenance(app.db, { workspaceId: ws, requestId: interpreted.requestId,
        commandId: row.undo_command_id }),
      /INJECT_AFTER_UNDOING_COMMIT/u);
  } finally {
    ConversationStateRepository.prototype.startUndo = originalStartUndo;
  }

  const afterFault = await requestRow(interpreted.requestId);
  assert.equal(afterFault.status, 'UNDOING', 'UNDOING 已真实提交');
  const pendingChanges = await requestChanges(ws, interpreted.requestId);
  assert.equal(pendingChanges[0]!.status, 'APPLIED', '第一条补偿尚未开始');

  const resumed = await withdrawStateMaintenance(app.db, { workspaceId: ws,
    requestId: interpreted.requestId, commandId: row.undo_command_id });
  assert.equal(resumed.status, 'UNDONE', '原身份重入继续剩余补偿，不停在 UNDOING');
  const state = await readState(ws, project.projectId);
  assert.equal(state.phase_key, 'DISCOVERY');
  const settledChanges = await requestChanges(ws, interpreted.requestId);
  assert.equal(settledChanges[0]!.status, 'COMPENSATED');
  assert.equal(settledChanges[0]!.error, null, '不重复已提交的效果、不记成失败');
});

test('重复依赖与已关联目标无新增效果：记为已存在，撤回不删除原关系（4.3 补充）', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const taskId = await httpTask(ws, project.projectId, '发布');
  const dependsOnTaskId = await httpTask(ws, project.projectId, '测试通过');
  const repositories = createRepositories(app.db);
  const task = await repositories.tasks.readTask(taskId);
  assert.ok(task !== undefined);
  // 关系在本指令之前就已存在：原指令不会产生新效果。
  await addTaskDependency(app.db, { workspaceId: ws, taskId, commandId: randomUUID(),
    expectedRevision: String(task.revision), dependsOnTaskId, dependencyKind: 'BLOCKS' });

  const goalOutcome = await createGoal(app.db, { workspaceId: ws, commandId: randomUUID(),
    title: '按期发布', description: '' });
  const goalId = goalOutcome.result.goal_id as string;
  const projectRow = await repositories.projects.readProject(project.projectId);
  assert.ok(projectRow !== undefined);
  await linkProjectGoal(app.db, { workspaceId: ws, projectId: project.projectId,
    commandId: randomUUID(), expectedRevision: String(projectRow.revision), goalId });

  const session = await sessionIn(ws, project.projectId,
    '发布依赖测试通过，并关联按期发布目标，然后进入构建阶段');
  const interpreted = await interpret(ws, session, { decision: 'MAINTAIN', questions: [],
    decision_required: null, changes: [
      { kind: 'SET_PHASE', phase: 'IMPLEMENTATION' },
      { kind: 'ADD_TASK_DEPENDENCY', task_title: '发布', depends_on_task_title: '测试通过',
        dependency_kind: 'BLOCKS' },
      { kind: 'LINK_GOAL', goal_title: '按期发布' },
    ] });
  const applied = await applyViaHttp(ws, interpreted.requestId);
  assert.equal(applied.status, 'APPLIED');
  const appliedChanges = applied.changes as { change_kind: string; status: string;
    after_ref: Record<string, unknown> | null }[];
  assert.deepEqual(appliedChanges.map((change) => change.status),
    ['APPLIED', 'SKIPPED', 'SKIPPED']);
  assert.equal(appliedChanges[1]!.after_ref?.skip_reason, 'DEPENDENCY_ALREADY_EXISTS');
  assert.equal(appliedChanges[2]!.after_ref?.skip_reason, 'GOAL_ALREADY_LINKED');

  const row = await requestRow(interpreted.requestId);
  const withdrawn = await withdrawViaHttp(ws, interpreted.requestId, row.undo_command_id);
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  assert.equal(withdrawn.body.status, 'UNDONE');

  // 撤回只碰本指令真正产生的效果：既有依赖与既有关联都必须保留。
  const dependencies = await repositories.tasks.listDependencies(taskId);
  assert.equal(dependencies.some((dep) => dep.depends_on_task_id === dependsOnTaskId), true,
    '原指令没有新增的关系，撤回不能删除它');
  const link = await repositories.projects.findProjectGoalLink(project.projectId, goalId);
  assert.ok(link !== undefined, '已经关联的目标不能被这次撤回解掉');
  const state = await readState(ws, project.projectId);
  assert.equal(state.phase_key, 'DISCOVERY');
});

test('跨工作空间读取与应用同一请求被拒，不产生第二套状态（4.1 补充）', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const session = await sessionIn(ws, project.projectId, '进入构建阶段');
  const interpreted = await interpret(ws, session,
    candidate([{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }]));
  const otherWs = await freshWorkspace();

  const read = await api.get(workspacePath(otherWs,
    `/conversation-state-requests/${interpreted.requestId}`));
  expectProblem(read, 404, 'RESOURCE_NOT_FOUND');
  const applyOther = await api.post(workspacePath(otherWs,
    `/conversation-state-requests/${interpreted.requestId}/applications`), {});
  expectProblem(applyOther, 404, 'RESOURCE_NOT_FOUND');
  const planOther = await api.get(workspacePath(otherWs,
    `/conversation-state-requests/${interpreted.requestId}/undo-plan`));
  expectProblem(planOther, 404, 'RESOURCE_NOT_FOUND');

  const state = await readState(ws, project.projectId);
  assert.equal(state.phase_key, 'DISCOVERY');
});

/* -------------------------------------------------------------------------- */
/* 产品主线纵向场景（第五节）：既有对象调整、连带决定、续答与整组撤回           */
/* -------------------------------------------------------------------------- */

test('既有任务的优先级与截止日期沿原 Owner 调整，不重复创建任务（§5 场景 1）', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const exportTaskId = await httpTask(ws, project.projectId, '导出报告');
  const searchTaskId = await httpTask(ws, project.projectId, '搜索能力');
  const repositories = createRepositories(app.db);
  const beforeTasks = await repositories.tasks.listProjectTasksByStatus(project.projectId,
    ['INBOX', 'READY', 'IN_PROGRESS', 'WAITING', 'BLOCKED', 'DONE', 'CANCELLED']);

  const session = await sessionIn(ws, project.projectId, '导出下周再做，本周优先搜索');
  const interpreted = await interpretRaw(ws, session, { decision: 'MAINTAIN', questions: [],
    decision_required: null,
    changes: [
      { kind: 'SET_TASK_PLANNING', task_title: '导出报告', due_local_date: '2026-10-17' },
      { kind: 'SET_NEXT_ACTION', task_title: '搜索能力' },
    ] }, { timezone: 'Asia/Shanghai' });
  assert.equal(interpreted.result.request.status, 'READY');

  const applied = await applyViaHttp(ws, interpreted.result.request.id);
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
  const changes = applied.changes as { change_kind: string; status: string;
    after_ref: Record<string, unknown> | null }[];
  assert.deepEqual(changes.map((change) => change.status), ['APPLIED', 'APPLIED']);

  // 只调整已有任务：没有新建第三个任务，模型提到「任务」不等于重复创建。
  const afterTasks = await repositories.tasks.listProjectTasksByStatus(project.projectId,
    ['INBOX', 'READY', 'IN_PROGRESS', 'WAITING', 'BLOCKED', 'DONE', 'CANCELLED']);
  assert.equal(afterTasks.length, beforeTasks.length, '不因为提到任务就重复创建 Task');

  const exportTask = await repositories.tasks.readTask(exportTaskId);
  assert.ok(exportTask !== null && exportTask !== undefined);
  assert.equal(exportTask.due_local_date, '2026-10-17');
  assert.equal(exportTask.due_timezone, 'Asia/Shanghai', '截止日期冻结了本次解释收到的时区');
  const state = await readState(ws, project.projectId);
  assert.equal(state.next_action_task_id, searchTaskId);
});

test('连带承诺不冻结独立修改；一句话续答绑定展示版本后继续原请求（§5 场景 2/3）', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const exportTaskId = await httpTask(ws, project.projectId, '导出报告');
  const session = await sessionIn(ws, project.projectId, '导出改到下周，本周发布照常');
  const interpreted = await interpretRaw(ws, session, { decision: 'MAINTAIN', questions: [],
    decision_required: { summary: '本周发布依赖导出，导出改期会影响它',
      question: '本周发布是否先不包含导出？', affected: ['本周发布'], blocked_changes: [1] },
    changes: [
      { kind: 'SET_TASK_PLANNING', task_title: '导出报告', due_local_date: '2026-10-17' },
      { kind: 'SET_PHASE', phase: 'IMPLEMENTATION' },
    ] }, { timezone: 'Asia/Shanghai' });
  const requestId = interpreted.result.request.id;
  assert.equal(interpreted.result.request.status, 'DECISION_REQUIRED');

  // 独立且明确的修改照常生效，不因另一项必要决定被整组冻结。
  const firstApply = await applyViaHttp(ws, requestId);
  assert.equal(firstApply.status, 'DECISION_REQUIRED', JSON.stringify(firstApply));
  const afterFirst = await requestChanges(ws, requestId);
  assert.equal(afterFirst[0]!.status, 'APPLIED', '独立修改先生效');
  assert.equal(afterFirst[1]!.status, 'PENDING', '被决定挡住的那条仍在等');
  let state = await readState(ws, project.projectId);
  assert.equal(state.phase_key, 'DISCOVERY', '没决定前不推进阶段');

  // 还没决定就再应用：不产生第二次效果，也不解锁。
  const again = await api.post(workspacePath(ws,
    `/conversation-state-requests/${requestId}/applications`), {});
  assert.equal(again.status, 200);
  const stillPending = await requestChanges(ws, requestId);
  assert.equal(stillPending[1]!.status, 'PENDING');

  // 续答前事实发生变化：按展示版本拒绝，不把旧问题的答案当成新问题的确认。
  const rowBefore = await requestRow(requestId);
  const stale = await api.post(workspacePath(ws,
    `/conversation-state-requests/${requestId}/decision-replies`), {
    command_id: randomUUID(), resolution: 'ACCEPT', answer: '同意调整发布承诺',
    expected_revision: '999' });
  expectProblem(stale, 409, 'DECISION_STALE');

  // 绑定原请求与用户看到答案时的版本：续答落库并推进。
  const reply = await api.post(workspacePath(ws,
    `/conversation-state-requests/${requestId}/decision-replies`), {
    command_id: randomUUID(), resolution: 'ACCEPT', answer: '同意调整发布承诺',
    expected_revision: String(rowBefore.revision) });
  assert.equal(reply.status, 200, reply.text);
  const replied = (reply.body as { result: { status: string; revision: string } }).result;
  assert.equal(replied.status, 'READY');
  const afterReply = await requestChanges(ws, requestId);
  assert.equal(afterReply[1]!.status, 'PENDING', '续答本身不写业务事实');

  // 决定之后继续原请求：被挡住的变更由原 applications 入口生效。
  const secondApply = await applyViaHttp(ws, requestId);
  assert.equal(secondApply.status, 'APPLIED', JSON.stringify(secondApply));
  const finalChanges = await requestChanges(ws, requestId);
  assert.deepEqual(finalChanges.map((change) => change.status), ['APPLIED', 'APPLIED']);
  state = await readState(ws, project.projectId);
  assert.equal(state.phase_key, 'IMPLEMENTATION');
  const exportTask = await createRepositories(app.db).tasks.readTask(exportTaskId);
  assert.equal(exportTask?.due_local_date, '2026-10-17');
});

test('纠正与续答能对上原对象：解释输入带上原会话上下文与既有回执（§5 场景 4/5）', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  await httpTask(ws, project.projectId, '导出报告');
  await httpTask(ws, project.projectId, '搜索能力');
  const session = await sessionIn(ws, project.projectId, '导出下周再做，本周优先搜索');

  const firstRequests: ConversationInterpretationRequest[] = [];
  await interpret(ws, session, { decision: 'MAINTAIN', questions: [], decision_required: null,
    changes: [{ kind: 'SET_NEXT_ACTION', task_title: '导出报告' }] }, firstRequests);
  assert.ok(firstRequests[0] !== undefined);
  assert.equal(firstRequests[0].userContent, '导出下周再做，本周优先搜索',
    '没有上下文时不加任何前后缀：原消息就是完整输入');

  // 同一会话的第二条指令：模型必须能看到前一条指令与它的回执。
  const second = await requestAssistMessage(app.db, { workspaceId: ws,
    sessionId: session.sessionId, commandId: randomUUID(),
    content: '不是导出，是搜索任务，时间保持原样' });
  const secondSession = { sessionId: session.sessionId,
    userMessageId: second.result.user_message_id };
  const secondRequests: ConversationInterpretationRequest[] = [];
  const outcome = await interpretRaw(ws, secondSession,
    { decision: 'MAINTAIN', questions: [], decision_required: null,
      changes: [{ kind: 'SET_NEXT_ACTION', task_title: '搜索能力' }] },
    { modelPort: port({ decision: 'MAINTAIN', questions: [], decision_required: null,
      changes: [{ kind: 'SET_NEXT_ACTION', task_title: '搜索能力' }] }, secondRequests) });
  assert.equal(outcome.result.request.source_message_id, second.result.user_message_id);
  assert.ok(secondRequests[0] !== undefined);
  const content = secondRequests[0].userContent;
  assert.ok(content.includes('【会话上下文'), content);
  assert.ok(content.includes('导出下周再做，本周优先搜索'), '带上原指令作为上下文');
  assert.ok(content.includes('既有状态维护回执'), '带上既有回执，纠正才对得上原对象');
  assert.ok(content.includes('【当前指令】'), '当前指令单独成段');
  assert.ok(content.endsWith('不是导出，是搜索任务，时间保持原样'),
    '当前指令是最后一段，不被上下文淹没');
});

/* -------------------------------------------------------------------------- */
/* 独立复验反例（nls-reacceptance-20261010 确认的 R1–R6）                       */
/* -------------------------------------------------------------------------- */

async function replyDecisionViaHttp(ws: string, requestId: string,
  input: { readonly commandId: string; readonly resolution: 'ACCEPT' | 'DECLINE';
    readonly answer: string; readonly expectedRevision: string }):
  Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await api.post(workspacePath(ws,
    `/conversation-state-requests/${requestId}/decision-replies`), {
    command_id: input.commandId, resolution: input.resolution,
    answer: input.answer, expected_revision: input.expectedRevision });
  return { status: response.status, body: response.body as Record<string, unknown>,
    text: response.text };
}

async function decisionAnswerAudits(requestId: string): Promise<readonly {
  readonly command_id: string; readonly fact_refs: Record<string, unknown> }[]> {
  const rows = await sql<{ command_id: string; fact_refs: Record<string, unknown> }>`
    select command_id, fact_refs from activity_records
    where event_type = 'CONVERSATION_STATE_DECISION_ANSWERED'
      and fact_refs->>'request_id' = ${requestId}`.execute(app.db);
  return rows.rows;
}

test('复验R1：全部受阻时 DECLINE 按决定不执行，自动应用与重复 applications 都不再生效', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const session = await sessionIn(ws, project.projectId, '进入实现阶段，但要先决定发布承诺');
  const interpreted = await interpret(ws, session, {
    decision: 'MAINTAIN', questions: [],
    changes: [{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }],
    decision_required: { summary: '改变发布承诺', question: '是否调整发布承诺？',
      affected: ['发布'], blocked_changes: [0] } });
  assert.equal(interpreted.status, 'DECISION_REQUIRED');

  const row = await requestRow(interpreted.requestId);
  const commandId = randomUUID();
  const declined = await replyDecisionViaHttp(ws, interpreted.requestId, {
    commandId, resolution: 'DECLINE', answer: '不调整，保持现在的状态',
    expectedRevision: String(row.revision) });
  assert.equal(declined.status, 200, declined.text);
  const result = declined.body.result as { status: string; revision: string };
  assert.equal(result.status, 'DECLINED',
    '拒绝后的终态是「按决定未执行」，不能是 READY（会触发自动应用）或 APPLIED（谎报生效）');

  // 读投影：受决定约束的变更标为按决定不执行，问题、答案与审计都在。
  const changes = await requestChanges(ws, interpreted.requestId);
  assert.equal(changes[0]!.status, 'DECLINED');
  const audits = await decisionAnswerAudits(interpreted.requestId);
  assert.equal(audits.length, 1, '决定提交恰一次审计');
  assert.equal(audits[0]!.fact_refs.resolution, 'DECLINE');

  // 自动应用入口重入：终态回读，不产生任何业务写入。
  const apply = await api.post(workspacePath(ws,
    `/conversation-state-requests/${interpreted.requestId}/applications`), {});
  assert.equal(apply.status, 200, apply.text);
  const state = await readState(ws, project.projectId);
  assert.equal(state.phase_key, 'DISCOVERY', '用户选择不调整后，原待决定变更不能自动生效');
  assert.equal(state.revision, '0', '拒绝不产生任何项目状态写入');

  // 刷新（重新读投影）后仍是同一事实。
  const refreshed = await requestChanges(ws, interpreted.requestId);
  assert.equal(refreshed[0]!.status, 'DECLINED');
  const auditsAfter = await decisionAnswerAudits(interpreted.requestId);
  assert.equal(auditsAfter.length, 1, '重复读取与重入不产生第二条决定审计');
});

test('复验R1：部分独立修改已生效时，DECLINE 只阻止受决定约束的剩余项', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const exportTaskId = await httpTask(ws, project.projectId, '导出报告');
  const session = await sessionIn(ws, project.projectId, '导出改到下周，本周发布是否照常');
  const interpreted = await interpret(ws, session, {
    decision: 'MAINTAIN', questions: [],
    decision_required: { summary: '导出改期影响本周发布', question: '本周发布是否先不包含导出？',
      affected: ['本周发布'], blocked_changes: [1] },
    changes: [
      { kind: 'SET_TASK_PLANNING', task_title: '导出报告', priority: 'HIGH' },
      { kind: 'SET_PHASE', phase: 'IMPLEMENTATION' },
    ] });
  const requestId = interpreted.requestId;

  // 独立且明确的修改先生效。
  const firstApply = await applyViaHttp(ws, requestId);
  assert.equal(firstApply.status, 'DECISION_REQUIRED', JSON.stringify(firstApply));
  let changes = await requestChanges(ws, requestId);
  assert.deepEqual(changes.map((change) => change.status), ['APPLIED', 'PENDING']);

  const row = await requestRow(requestId);
  const declined = await replyDecisionViaHttp(ws, requestId, {
    commandId: randomUUID(), resolution: 'DECLINE', answer: '不调整，保持原发布承诺',
    expectedRevision: String(row.revision) });
  assert.equal(declined.status, 200, declined.text);
  const result = declined.body.result as { status: string };
  assert.equal(result.status, 'PARTIAL', '已生效的独立修改保留，被拒绝项单独结算');

  changes = await requestChanges(ws, requestId);
  assert.deepEqual(changes.map((change) => change.status), ['APPLIED', 'DECLINED'],
    '只阻止受这项决定约束的变更；此前独立生效的修改不被撤销');

  // 拒绝之后自动应用入口重入：阶段不推进，导出任务的日期改动保留。
  const apply = await api.post(workspacePath(ws,
    `/conversation-state-requests/${requestId}/applications`), {});
  assert.equal(apply.status, 200, apply.text);
  const state = await readState(ws, project.projectId);
  assert.equal(state.phase_key, 'DISCOVERY', '被拒绝的变更不因重复 applications 生效');
  const exportTask = await createRepositories(app.db).tasks.readTask(exportTaskId);
  assert.equal(exportTask?.priority, 'HIGH', '独立生效的修改不被补偿或撤销');
  changes = await requestChanges(ws, requestId);
  assert.deepEqual(changes.map((change) => change.status), ['APPLIED', 'DECLINED']);
});

test('复验R1：expected_revision 在写事务 CAS 内核对，事务前读取之后的版本推进被 409 拒绝', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const session = await sessionIn(ws, project.projectId, '进入实现阶段，但要先决定发布承诺');
  const interpreted = await interpret(ws, session, {
    decision: 'MAINTAIN', questions: [],
    changes: [{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }],
    decision_required: { summary: '改变发布承诺', question: '是否调整发布承诺？',
      affected: ['发布'] } });
  const requestId = interpreted.requestId;
  const row = await requestRow(requestId);

  // 注入并发：本命令事务前读取请求行之后、写事务提交之前，请求版本被并发推进
  // （等价于状态在应用往返中又动过一次，决定内容仍未决）。
  const originalRead = ConversationStateRepository.prototype.readRequest;
  let injected = false;
  ConversationStateRepository.prototype.readRequest = async function (id, lock) {
    const read = await originalRead.call(this, id, lock);
    if (!injected && read !== undefined && read.id === requestId) {
      injected = true;
      await sql`update conversation_state_requests set revision = revision + 1
        where id = ${requestId}`.execute(app.db);
      const bumped = await originalRead.call(this, id, lock);
      assert.equal(String(bumped?.revision), String(BigInt(read.revision) + 1n),
        '注入的并发版本推进必须先提交');
    }
    return read;
  };
  try {
    // 败者用直连用例驱动：注入与被测代码必须同一进程（HTTP 进程看不到本进程的原型补丁）。
    await assert.rejects(() => replyStateDecision(app.db, {
      workspaceId: ws, requestId, commandId: randomUUID(), resolution: 'ACCEPT',
      answer: '同意调整发布承诺', expectedRevision: String(row.revision) }),
      (error: Error & { code?: string; status?: number }) => {
        assert.equal(error.status, 409,
          `expected_revision 只在事务前读取比较不够：写事务 CAS 必须核对（实际 ${error.status}）`);
        assert.equal(error.code, 'DECISION_STALE');
        return true;
      });
  } finally {
    ConversationStateRepository.prototype.readRequest = originalRead;
  }
  assert.equal(injected, true);

  // 败者不产生决定事实：没有审计、决定仍在等、版本保持并发推进后的值。
  const afterLose = await requestRow(requestId);
  assert.notEqual(afterLose.decision_required, null, '败者不得清掉仍在等待的决定');
  assert.equal(String(afterLose.revision), String(BigInt(row.revision) + 1n));
  assert.equal((await decisionAnswerAudits(requestId)).length, 0, '败者不写决定审计');

  // 按当前版本重新回答：只有一个合法提交被接受。
  const retry = await replyDecisionViaHttp(ws, requestId, {
    commandId: randomUUID(), resolution: 'ACCEPT', answer: '同意调整发布承诺',
    expectedRevision: String(afterLose.revision) });
  assert.equal(retry.status, 200, retry.text);
  assert.equal((await decisionAnswerAudits(requestId)).length, 1,
    '重新提交恰一次决定审计');
});

test('复验R2：旧 priority 候选与后续人工修改冲突时保留当前值，不覆盖、不新建、重放无第二次更新', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const taskId = await httpTask(ws, project.projectId, '现有导出任务');
  const repositories = createRepositories(app.db);
  const session = await sessionIn(ws, project.projectId, '把现有导出任务提到高优先级');
  const interpreted = await interpretRaw(ws, session,
    candidate([{ kind: 'SET_TASK_PLANNING', task_title: '现有导出任务', priority: 'HIGH' }]));
  assert.equal(interpreted.result.request.status, 'READY');
  const requestId = interpreted.result.request.id;

  // 确认之后、应用之前：人工经原 Owner 把同一任务改为 LOW。
  const before = await repositories.tasks.readTask(taskId);
  assert.ok(before !== null && before !== undefined);
  await setTaskPlanningMetadata(app.db, { workspaceId: ws, taskId,
    commandId: randomUUID(), expectedRevision: String(before.revision),
    priority: 'LOW', dueLocalDate: before.due_local_date, timezone: before.due_timezone });

  const applied = await applyViaHttp(ws, requestId);
  assert.equal(applied.status, 'FAILED', JSON.stringify(applied));
  const changes = applied.changes as { status: string;
    error: { code: string } | null }[];
  assert.equal(changes[0]!.status, 'FAILED');
  assert.equal(changes[0]!.error?.code, 'TARGET_VERSION_CONFLICT',
    '旧候选必须按冻结的适用版本识别冲突，不能读最新 revision 冒充确认基线');

  const after = await repositories.tasks.readTask(taskId);
  assert.equal(after?.priority, 'LOW', '确认后的人工修改不能被旧候选覆盖');
  const tasks = await repositories.tasks.listProjectTasksByStatus(project.projectId,
    ['INBOX', 'READY', 'IN_PROGRESS', 'WAITING', 'BLOCKED', 'DONE', 'CANCELLED']);
  assert.equal(tasks.length, 1, '只调整已有任务，不因为冲突或重放重复创建 Task');

  // 同请求重放：回读原结算，不产生第二次更新。
  const revisionAfterConflict = String(after?.revision);
  const replay = await applyViaHttp(ws, requestId);
  assert.equal(replay.status, 'FAILED', JSON.stringify(replay));
  const replayed = await repositories.tasks.readTask(taskId);
  assert.equal(String(replayed?.revision), revisionAfterConflict,
    '重复 applications 不产生第二次任务更新');
});

test('复验R2：同值修订（版本推进）仍识别冲突；目标被替换时拒绝落到新对象', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const taskId = await httpTask(ws, project.projectId, '现有导出任务');
  const repositories = createRepositories(app.db);
  const session = await sessionIn(ws, project.projectId, '把现有导出任务提到高优先级');
  const interpreted = await interpretRaw(ws, session,
    candidate([{ kind: 'SET_TASK_PLANNING', task_title: '现有导出任务', priority: 'HIGH' }]));
  const requestId = interpreted.result.request.id;

  // 同值写入也推进版本：冲突识别必须看版本，不能只比较字段值。
  const before = await repositories.tasks.readTask(taskId);
  assert.ok(before !== null && before !== undefined);
  await setTaskPlanningMetadata(app.db, { workspaceId: ws, taskId,
    commandId: randomUUID(), expectedRevision: String(before.revision),
    priority: 'HIGH', dueLocalDate: before.due_local_date, timezone: before.due_timezone });
  const applied = await applyViaHttp(ws, requestId);
  assert.equal(applied.status, 'FAILED', JSON.stringify(applied));
  const changes = applied.changes as { status: string;
    error: { code: string } | null }[];
  assert.equal(changes[0]!.error?.code, 'TARGET_VERSION_CONFLICT',
    '同值修订同样推进版本，必须识别为冲突');
  const afterHuman = await repositories.tasks.readTask(taskId);
  assert.equal(String(afterHuman?.revision), String(BigInt(before.revision) + 1n),
    '冲突时不产生第二次任务更新');

  // 目标被替换：旧任务改名 + 同名新任务出现，候选不能落到新对象上。
  const secondSession = await sessionIn(ws, project.projectId, '还是把现有导出任务提到高优先级');
  const second = await interpretRaw(ws, secondSession,
    candidate([{ kind: 'SET_TASK_PLANNING', task_title: '现有导出任务', priority: 'HIGH' }]));
  const renamed = await editTaskPresentation(app.db, { workspaceId: ws, taskId,
    commandId: randomUUID(), expectedRevision: String(afterHuman?.revision),
    title: '旧的导出任务' });
  assert.ok(renamed !== undefined);
  const replacementId = await httpTask(ws, project.projectId, '现有导出任务');
  const replaced = await applyViaHttp(ws, second.result.request.id);
  assert.equal(replaced.status, 'FAILED', JSON.stringify(replaced));
  const replacedChanges = replaced.changes as { status: string;
    error: { code: string } | null }[];
  assert.equal(replacedChanges[0]!.error?.code, 'TARGET_IDENTITY_CONFLICT',
    '确认时点的目标身份已改变，不落到另一个对象上');
  const replacement = await repositories.tasks.readTask(replacementId);
  assert.notEqual(replacement?.priority, 'HIGH', '新任务不能被旧候选修改');
});

test('复验R2：同组多条同对象合法变更按自己的已提交回执推进版本，不误报冲突', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const taskId = await httpTask(ws, project.projectId, '现有导出任务');
  const repositories = createRepositories(app.db);
  const session = await sessionIn(ws, project.projectId, '导出任务提到高优先级并改到下周');
  const interpreted = await interpretRaw(ws, session, { decision: 'MAINTAIN', questions: [],
    decision_required: null,
    changes: [
      { kind: 'SET_TASK_PLANNING', task_title: '现有导出任务', priority: 'HIGH' },
      { kind: 'SET_TASK_PLANNING', task_title: '现有导出任务', due_local_date: '2026-10-17' },
    ] }, { timezone: 'Asia/Shanghai' });
  const applied = await applyViaHttp(ws, interpreted.result.request.id);
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
  const changes = applied.changes as { status: string;
    after_ref: { task_revision?: string } | null }[];
  assert.deepEqual(changes.map((change) => change.status), ['APPLIED', 'APPLIED'],
    '本组自己的连续写入按回执推进版本，不互相误判为外部冲突');

  const task = await repositories.tasks.readTask(taskId);
  assert.equal(task?.priority, 'HIGH');
  assert.equal(task?.due_local_date, '2026-10-17');
  assert.equal(task?.due_timezone, 'Asia/Shanghai');
  assert.equal(changes[0]!.after_ref?.task_revision !== undefined, true,
    'after_ref 必须保存 Owner 提交返回的新版本（撤回预检依赖它）');
  assert.notEqual(changes[0]!.after_ref?.task_revision, changes[1]!.after_ref?.task_revision,
    '两条变更各自记录自己生效后的版本');
  const tasks = await repositories.tasks.listProjectTasksByStatus(project.projectId,
    ['INBOX', 'READY', 'IN_PROGRESS', 'WAITING', 'BLOCKED', 'DONE', 'CANCELLED']);
  assert.equal(tasks.length, 1, '不因为多条计划调整重复创建 Task');
});

test('复验R3：模型在途时的人工修改不被解释结算吸收，原候选按调用前冻结的基线识别冲突', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const session = await sessionIn(ws, project.projectId, '进入实现阶段');

  // 可控门：模型调用挂起，模拟「解释在途」窗口。
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const calls: ConversationInterpretationRequest[] = [];
  const base = port(candidate([{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }]), calls);
  const model: AssistModelPort = { ...base, interpret: async (request) => {
    entered?.();
    await gate;
    return base.interpret?.(request) as ReturnType<NonNullable<typeof base.interpret>>;
  } };

  const pending = interpretStateMaintenance(app.db, { workspaceId: ws,
    sessionId: session.sessionId, sourceMessageId: session.userMessageId,
    commandId: randomUUID(), modelPort: model });
  await started;
  try {
    // 模型在途：用户经正式 state-command 把项目推进到 RELEASE。
    await setPhaseViaHttp(ws, project.projectId, 'RELEASE');
  } finally {
    release?.();
  }
  const outcome = await pending;
  assert.equal(calls.length, 1, '同原消息只调用一次模型');
  const settledChanges = outcome.result.changes;
  const baseline = settledChanges[0]!.baseline_ref as { state_revision?: string } | null;
  assert.equal(baseline?.state_revision, '0',
    '适用基线必须在调用模型之前冻结；不能把结算时的最新版本冒充原基线');

  const applied = await applyViaHttp(ws, outcome.result.request.id);
  const appliedChanges = applied.changes as { status: string;
    error: { code: string } | null }[];
  assert.equal(appliedChanges[0]!.status, 'FAILED', JSON.stringify(applied));
  assert.equal(appliedChanges[0]!.error?.code, 'STATE_VERSION_CONFLICT',
    '模型返回时间不是用户再次确认：并发新修改必须挡住原候选');
  const state = await readState(ws, project.projectId);
  assert.equal(state.phase_key, 'RELEASE',
    '模型在途时的合法新修改被保留，不被原候选覆盖成 IMPLEMENTATION');
});

/* -------------------------------------------------------------------------- */
/* R4：Task 计划撤回（after_ref 版本、逆序链、预检与提交之间的 CAS）              */
/* -------------------------------------------------------------------------- */

async function changeRows(requestId: string) {
  return createRepositories(app.db).conversationState.listChangeRows(requestId);
}

async function applyPlanning(ws: string, projectId: string, taskId: string,
  changes: readonly Record<string, unknown>[]): Promise<string> {
  const session = await sessionIn(ws, projectId, '调整现有任务的计划');
  const interpreted = await interpretRaw(ws, session,
    { decision: 'MAINTAIN', questions: [], decision_required: null, changes },
    { timezone: 'Asia/Shanghai' });
  const applied = await applyViaHttp(ws, interpreted.result.request.id);
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
  assert.ok(taskId !== '');
  return interpreted.result.request.id;
}

test('复验R4：无后续修改时撤回不误报冲突，after_ref 保存 Owner 提交返回的新版本', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const taskId = await httpTask(ws, project.projectId, '现有导出任务');
  const repositories = createRepositories(app.db);
  const initial = await repositories.tasks.readTask(taskId);
  assert.ok(initial !== null && initial !== undefined);

  const requestId = await applyPlanning(ws, project.projectId, taskId,
    [{ kind: 'SET_TASK_PLANNING', task_title: '现有导出任务', priority: 'HIGH' }]);
  const rows = await changeRows(requestId);
  const after = rows[0]!.after_ref as Record<string, unknown> | null;
  assert.equal(typeof after?.task_revision, 'string',
    'APPLIED 的 after_ref 必须携带任务版本');
  assert.equal(after?.task_revision, String(BigInt(initial.revision) + 1n),
    'after_ref 必须是 Owner 提交返回的新版本，不是生效前版本');

  const plan = await undoPlanViaHttp(ws, requestId);
  assert.equal(plan.fully_withdrawable, true,
    `没有任何后续修改时不能误报版本冲突：${JSON.stringify(plan)}`);
  assert.equal(plan.blocked_count, 0);
  const item = plan.items[0]!;
  assert.equal(item.facts.applied_task_revision, String(BigInt(initial.revision) + 1n));

  const withdrawn = await withdrawViaHttp(ws, requestId, plan.undo_command_id);
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  assert.equal((withdrawn.body as { status: string }).status, 'UNDONE');
  const restored = await repositories.tasks.readTask(taskId);
  assert.equal(restored?.priority, initial.priority, '撤回恢复生效前的优先级');

  // 重复撤回：幂等回读，不产生第二次任务更新。
  const revisionAfterUndo = String(restored?.revision);
  const again = await withdrawViaHttp(ws, requestId, plan.undo_command_id);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const untouched = await repositories.tasks.readTask(taskId);
  assert.equal(String(untouched?.revision), revisionAfterUndo, '重复撤回不产生第二次更新');
});

test('复验R4：后续人工修改阻止撤回：先给具体冲突，一个补偿都不执行', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const taskId = await httpTask(ws, project.projectId, '现有导出任务');
  const repositories = createRepositories(app.db);
  const requestId = await applyPlanning(ws, project.projectId, taskId,
    [{ kind: 'SET_TASK_PLANNING', task_title: '现有导出任务', priority: 'HIGH' }]);

  // 生效之后的人工修改：撤回按原范围会覆盖它。
  const applied = (await repositories.tasks.readTask(taskId))!;
  await setTaskPlanningMetadata(app.db, { workspaceId: ws, taskId,
    commandId: randomUUID(), expectedRevision: String(applied.revision),
    priority: 'LOW', dueLocalDate: applied.due_local_date, timezone: applied.due_timezone });

  const plan = await undoPlanViaHttp(ws, requestId);
  assert.equal(plan.fully_withdrawable, false, JSON.stringify(plan));
  const item = plan.items[0]!;
  assert.equal(item.reason_code, 'TARGET_VERSION_CONFLICT');
  assert.equal(item.facts.priority, 'LOW', '冲突展示必须给出当前事实');

  const blocked = await withdrawViaHttp(ws, requestId, plan.undo_command_id);
  assert.equal(blocked.status, 409);
  assert.equal((blocked.body as { code: string }).code, 'UNDO_SCOPE_REQUIRED');
  const scoped = await withdrawViaHttp(ws, requestId, plan.undo_command_id,
    { plan_digest: plan.plan_digest, confirmed_change_ids: [item.change_id] });
  assert.equal(scoped.status, 422, JSON.stringify(scoped.body));

  const after = await repositories.tasks.readTask(taskId);
  assert.equal(after?.priority, 'LOW', '不可撤回项不会被偷偷补偿，人工修改保留');
  const rows = await changeRows(requestId);
  assert.equal(rows[0]!.status, 'APPLIED');
});

test('复验R4：预检之后事实变化按 plan_digest 拒绝，旧方案不执行任何补偿', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const taskId = await httpTask(ws, project.projectId, '现有导出任务');
  const repositories = createRepositories(app.db);
  const requestId = await applyPlanning(ws, project.projectId, taskId,
    [{ kind: 'SET_TASK_PLANNING', task_title: '现有导出任务', priority: 'HIGH' }]);

  const plan = await undoPlanViaHttp(ws, requestId);
  assert.equal(plan.fully_withdrawable, true, JSON.stringify(plan));

  const applied = (await repositories.tasks.readTask(taskId))!;
  await setTaskPlanningMetadata(app.db, { workspaceId: ws, taskId,
    commandId: randomUUID(), expectedRevision: String(applied.revision),
    priority: 'LOW', dueLocalDate: applied.due_local_date, timezone: applied.due_timezone });

  const stale = await withdrawViaHttp(ws, requestId, plan.undo_command_id,
    { plan_digest: plan.plan_digest,
      confirmed_change_ids: plan.items.map((entry) => entry.change_id) });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal((stale.body as { code: string }).code, 'UNDO_PLAN_STALE');
  const after = await repositories.tasks.readTask(taskId);
  assert.equal(after?.priority, 'LOW', '过期方案一个补偿都不执行');
  const rows = await changeRows(requestId);
  assert.equal(rows[0]!.status, 'APPLIED');
});

test('复验R4：同组多条 Task 变更按原逆序补偿恢复，不把自己的补偿误判为外部冲突', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const taskId = await httpTask(ws, project.projectId, '现有导出任务');
  const repositories = createRepositories(app.db);
  const initial = await repositories.tasks.readTask(taskId);
  assert.ok(initial !== null && initial !== undefined);

  const requestId = await applyPlanning(ws, project.projectId, taskId, [
    { kind: 'SET_TASK_PLANNING', task_title: '现有导出任务', priority: 'HIGH' },
    { kind: 'SET_TASK_PLANNING', task_title: '现有导出任务', due_local_date: '2026-10-17' },
  ]);
  const rows = await changeRows(requestId);
  assert.deepEqual(rows.map((row) => row.status), ['APPLIED', 'APPLIED']);

  const plan = await undoPlanViaHttp(ws, requestId);
  assert.equal(plan.fully_withdrawable, true,
    `同组自己的连续版本推进不是外部冲突：${JSON.stringify(plan)}`);
  const withdrawn = await withdrawViaHttp(ws, requestId, plan.undo_command_id);
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  assert.equal((withdrawn.body as { status: string }).status, 'UNDONE');

  const restored = await repositories.tasks.readTask(taskId);
  assert.equal(restored?.priority, initial.priority, '逆序恢复第一条生效前的优先级');
  assert.equal(restored?.due_local_date, initial.due_local_date, '逆序恢复第二条生效前的截止日期');
  const settled = await changeRows(requestId);
  assert.deepEqual(settled.map((row) => row.status), ['COMPENSATED', 'COMPENSATED']);
});

test('复验R4：计划变更 Owner 提交后、APPLIED 回执保存前中断，按原命令恢复且恰一次', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const taskId = await httpTask(ws, project.projectId, '现有导出任务');
  const repositories = createRepositories(app.db);
  const session = await sessionIn(ws, project.projectId, '把现有导出任务提到高优先级');
  const interpreted = await interpretRaw(ws, session,
    candidate([{ kind: 'SET_TASK_PLANNING', task_title: '现有导出任务', priority: 'HIGH' }]));
  const requestId = interpreted.result.request.id;

  const original = ConversationStateRepository.prototype.updateChangeStatus;
  let injected = false;
  ConversationStateRepository.prototype.updateChangeStatus = async function (id, input) {
    if (input.status === 'APPLIED' && !injected) {
      injected = true;
      throw new Error('INJECT_BEFORE_APPLIED_RECEIPT_SAVE');
    }
    return original.call(this, id, input);
  };
  try {
    await assert.rejects(() => applyStateMaintenance(app.db, { workspaceId: ws, requestId }),
      /INJECT_BEFORE_APPLIED_RECEIPT_SAVE/u);
  } finally {
    ConversationStateRepository.prototype.updateChangeStatus = original;
  }
  assert.equal(injected, true);
  const mid = await repositories.tasks.readTask(taskId);
  assert.equal(mid?.priority, 'HIGH', 'Owner 已提交，效果已经存在');

  const replay = await applyStateMaintenance(app.db, { workspaceId: ws, requestId });
  assert.equal(replay.status, 'APPLIED', JSON.stringify(replay));
  const after = await repositories.tasks.readTask(taskId);
  assert.equal(String(after?.revision), String(mid?.revision),
    '回执恢复不产生第二次任务更新');
  assert.equal(after?.priority, 'HIGH');
});

test('复验R4：补偿提交后、COMPENSATED 回执保存前中断可恢复；预检与提交间的修改被 CAS 挡住', async () => {
  // 恢复出口：补偿领域提交后、回执保存前中断。
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const taskId = await httpTask(ws, project.projectId, '现有导出任务');
  const repositories = createRepositories(app.db);
  const initial = await repositories.tasks.readTask(taskId);
  const requestId = await applyPlanning(ws, project.projectId, taskId,
    [{ kind: 'SET_TASK_PLANNING', task_title: '现有导出任务', priority: 'HIGH' }]);
  const plan = await undoPlanViaHttp(ws, requestId);
  assert.equal(plan.fully_withdrawable, true, JSON.stringify(plan));

  const original = ConversationStateRepository.prototype.updateChangeStatus;
  let injected = false;
  ConversationStateRepository.prototype.updateChangeStatus = async function (id, input) {
    if (input.status === 'COMPENSATED' && !injected) {
      injected = true;
      throw new Error('INJECT_BEFORE_COMPENSATION_RECEIPT_SAVE');
    }
    return original.call(this, id, input);
  };
  try {
    await assert.rejects(() => withdrawStateMaintenance(app.db, { workspaceId: ws,
      requestId, commandId: plan.undo_command_id }),
    /INJECT_BEFORE_COMPENSATION_RECEIPT_SAVE/u);
  } finally {
    ConversationStateRepository.prototype.updateChangeStatus = original;
  }
  assert.equal(injected, true);
  const mid = await repositories.tasks.readTask(taskId);
  assert.equal(mid?.priority, initial?.priority ?? null, '补偿已提交，值已恢复');

  const replay = await withdrawStateMaintenance(app.db, { workspaceId: ws, requestId,
    commandId: plan.undo_command_id });
  assert.equal(replay.status, 'UNDONE', JSON.stringify(replay));
  const settled = await changeRows(requestId);
  assert.equal(settled[0]!.status, 'COMPENSATED');
  const after = await repositories.tasks.readTask(taskId);
  assert.equal(String(after?.revision), String(mid?.revision),
    '回执恢复不产生第二次补偿更新');

  // 预检（含 startUndo 提交）之后、补偿提交之前的人工修改：被 Owner CAS 挡住。
  const fresh = await applyPlanning(ws, project.projectId, taskId,
    [{ kind: 'SET_TASK_PLANNING', task_title: '现有导出任务', priority: 'HIGH' }]);
  const freshPlan = await undoPlanViaHttp(ws, fresh);
  assert.equal(freshPlan.fully_withdrawable, true, JSON.stringify(freshPlan));
  const originalStartUndo = ConversationStateRepository.prototype.startUndo;
  let edited = false;
  ConversationStateRepository.prototype.startUndo = async function (id, input) {
    const started = await originalStartUndo.call(this, id, input);
    if (!edited && started !== undefined) {
      edited = true;
      const current = (await repositories.tasks.readTask(taskId))!;
      await setTaskPlanningMetadata(app.db, { workspaceId: ws, taskId,
        commandId: randomUUID(), expectedRevision: String(current.revision),
        priority: 'LOW', dueLocalDate: current.due_local_date,
        timezone: current.due_timezone });
    }
    return started;
  };
  try {
    const blocked = await withdrawStateMaintenance(app.db, { workspaceId: ws,
      requestId: fresh, commandId: freshPlan.undo_command_id });
    assert.equal(blocked.status, 'UNDO_BLOCKED', JSON.stringify(blocked));
  } finally {
    ConversationStateRepository.prototype.startUndo = originalStartUndo;
  }
  assert.equal(edited, true);
  const preserved = await repositories.tasks.readTask(taskId);
  assert.equal(preserved?.priority, 'LOW',
    '补偿不能读取最新 revision 强行恢复：预检与提交之间的人工修改必须保留');
  const blockedRows = await changeRows(fresh);
  assert.equal(blockedRows[0]!.status, 'COMPENSATION_FAILED');
});

/* -------------------------------------------------------------------------- */
/* R5：决定回执重放先于可变状态前置                                             */
/* -------------------------------------------------------------------------- */

/** 建一条整组等决定的 SET_PHASE 请求（R5 场景的标准起点）。 */
async function decidedRequest(ws: string, projectId: string): Promise<string> {
  const session = await sessionIn(ws, projectId, '进入实现阶段，但要先决定发布承诺');
  const interpreted = await interpret(ws, session, {
    decision: 'MAINTAIN', questions: [],
    changes: [{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }],
    decision_required: { summary: '改变发布承诺', question: '是否调整发布承诺？',
      affected: ['发布'] } });
  assert.equal(interpreted.status, 'DECISION_REQUIRED');
  return interpreted.requestId;
}

test('复验R5：原命令响应丢失后同命令重放 200，异载荷严格 COMMAND_ID_REUSED，审计与业务写入恰一次', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const requestId = await decidedRequest(ws, project.projectId);
  const row = await requestRow(requestId);
  const commandId = randomUUID();
  const body = { command_id: commandId, resolution: 'ACCEPT',
    answer: '同意调整发布承诺', expected_revision: String(row.revision) };

  const first = await api.post(workspacePath(ws,
    `/conversation-state-requests/${requestId}/decision-replies`), body);
  assert.equal(first.status, 200, first.text);

  // 响应丢失后的同命令重放：完全相同载荷按原提交结果回读，不先撞状态前置。
  const replay = await api.post(workspacePath(ws,
    `/conversation-state-requests/${requestId}/decision-replies`), body);
  assert.equal(replay.status, 200,
    `决定已提交，同命令重放必须返回原成功（实际 ${replay.status}）：${replay.text}`);

  // 同命令换答案 / 换 resolution：严格 COMMAND_ID_REUSED，不返回别人的成功。
  const otherAnswer = await api.post(workspacePath(ws,
    `/conversation-state-requests/${requestId}/decision-replies`),
    { ...body, answer: '不调整' });
  assert.equal(otherAnswer.status, 409, otherAnswer.text);
  assert.equal((otherAnswer.body as { code: string }).code, 'COMMAND_ID_REUSED');
  const otherResolution = await api.post(workspacePath(ws,
    `/conversation-state-requests/${requestId}/decision-replies`),
    { ...body, resolution: 'DECLINE' });
  assert.equal(otherResolution.status, 409, otherResolution.text);
  assert.equal((otherResolution.body as { code: string }).code, 'COMMAND_ID_REUSED');

  // 决定之后、应用之前：沿原请求继续，重放不重造决定。
  const applied = await applyViaHttp(ws, requestId);
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
  const afterApply = await readState(ws, project.projectId);
  assert.equal(afterApply.phase_key, 'IMPLEMENTATION');
  const revisionAfterApply = String(afterApply.revision);

  // 应用之后再次重放：仍是 200 终态回读，业务写入不重复。
  const after = await api.post(workspacePath(ws,
    `/conversation-state-requests/${requestId}/decision-replies`), body);
  assert.equal(after.status, 200, after.text);
  assert.equal((after.body as { result: { status: string } }).result.status, 'APPLIED');
  const stateAgain = await readState(ws, project.projectId);
  assert.equal(String(stateAgain.revision), revisionAfterApply,
    '重放不产生第二次业务写入');
  assert.equal((await decisionAnswerAudits(requestId)).length, 1,
    '决定审计与业务写入均恰一次');

  // 决定已提交后，旧版本的新命令被拒绝（不是「已经不等决定」的模糊成功）。
  const staleNew = await api.post(workspacePath(ws,
    `/conversation-state-requests/${requestId}/decision-replies`), {
    command_id: randomUUID(), resolution: 'ACCEPT', answer: '同意调整发布承诺',
    expected_revision: String(row.revision) });
  assert.equal(staleNew.status, 409, staleNew.text);
  assert.equal((staleNew.body as { code: string }).code, 'INVALID_TRANSITION');
  assert.equal((await decisionAnswerAudits(requestId)).length, 1);
});

test('复验R5：并发重复提交同一命令收敛到原回执，决定与审计只提交一次', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const requestId = await decidedRequest(ws, project.projectId);
  const row = await requestRow(requestId);
  const commandId = randomUUID();
  const input = { workspaceId: ws, requestId, commandId, resolution: 'ACCEPT' as const,
    answer: '同意调整发布承诺', expectedRevision: String(row.revision) };

  const outcomes = await Promise.allSettled([
    replyStateDecision(app.db, input), replyStateDecision(app.db, input) ]);
  const fulfilled = outcomes.filter((entry) => entry.status === 'fulfilled');
  assert.equal(fulfilled.length, 2,
    `同一命令的并发重复必须都收敛到原回执（实际 ${JSON.stringify(outcomes.map((entry) => entry.status))}）`);
  for (const entry of fulfilled) {
    assert.equal((entry as PromiseFulfilledResult<{ status: string }>).value.status, 'READY');
  }
  const after = await requestRow(requestId);
  assert.equal(after.decision_required, null);
  assert.equal(String(after.revision), String(BigInt(row.revision) + 1n),
    '并发重复只推进一次版本');
  assert.equal((await decisionAnswerAudits(requestId)).length, 1,
    '决定审计只提交一次');
});

test('复验R5：跨 Workspace 的决定回复被拒绝，不产生任何写入', async () => {
  const ws = await freshWorkspace();
  const otherWs = await freshWorkspace();
  const project = await createProject(ws);
  const requestId = await decidedRequest(ws, project.projectId);
  const row = await requestRow(requestId);

  const response = await api.post(workspacePath(otherWs,
    `/conversation-state-requests/${requestId}/decision-replies`), {
    command_id: randomUUID(), resolution: 'ACCEPT', answer: '同意调整发布承诺',
    expected_revision: String(row.revision) });
  assert.equal(response.status, 404, response.text);
  const after = await requestRow(requestId);
  assert.notEqual(after.decision_required, null, '跨 Workspace 不清掉决定');
  assert.equal(String(after.revision), String(row.revision), '跨 Workspace 不推进版本');
  assert.equal((await decisionAnswerAudits(requestId)).length, 0);
});

/* -------------------------------------------------------------------------- */
/* Slice B：外部成果核对与完成（NLS-04 / 任务书第五节第 3 项）                  */
/* -------------------------------------------------------------------------- */

/** 建一条人工进行中的任务：INBOX → READY → IN_PROGRESS（完成 Owner 的前置）。 */
async function humanInProgressTask(ws: string, projectId: string,
  title: string): Promise<string> {
  const taskId = await httpTask(ws, projectId, title);
  const repositories = createRepositories(app.db);
  const initial = await repositories.tasks.readTask(taskId);
  assert.ok(initial !== undefined && initial !== null);
  await markTaskReady(app.db, { workspaceId: ws, taskId, commandId: randomUUID(),
    expectedRevision: String(initial.revision) });
  const ready = await repositories.tasks.readTask(taskId);
  assert.ok(ready !== undefined && ready !== null);
  await startHumanTask(app.db, { workspaceId: ws, taskId, commandId: randomUUID(),
    expectedRevision: String(ready.revision) });
  const started = await repositories.tasks.readTask(taskId);
  assert.equal(started?.status, 'IN_PROGRESS');
  return taskId;
}

async function externalCheckedAudits(requestId: string): Promise<string> {
  const rows = await sql<{ count: string }>`select count(*)::text as count
    from activity_records where event_type = 'CONVERSATION_EXTERNAL_CHECKED'
      and fact_refs->>'request_id' = ${requestId}`.execute(app.db);
  return rows.rows[0]?.count ?? '0';
}

test('复验B1：外部成果核对只读分类：写审计、不完成、不改业务状态，重复应用不重复核对', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const taskId = await httpTask(ws, project.projectId, '外部交付的任务');
  const session = await sessionIn(ws, project.projectId,
    '其他工具已经做好了，请核对并同步外部交付的任务');
  const interpreted = await interpretRaw(ws, session,
    candidate([{ kind: 'SYNC_EXTERNAL_RESULT', task_title: '外部交付的任务' }]));
  const requestId = interpreted.result.request.id;

  const applied = await applyViaHttp(ws, requestId);
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
  const rows = await changeRows(requestId);
  assert.equal(rows[0]!.status, 'APPLIED');
  const after = rows[0]!.after_ref as Record<string, unknown> | null;
  assert.equal(after?.task_id, taskId);
  assert.equal(after?.check_result, 'NEEDS_HUMAN_ACCEPTANCE',
    '核对如实报告：仍需人工验收，外部自报不判定完成');

  // 不完成、不改业务状态：任务原样，完成指针为空，Task 数量不增加。
  const repositories = createRepositories(app.db);
  const task = await repositories.tasks.readTask(taskId);
  assert.notEqual(task?.status, 'DONE', '核对不是完成');
  assert.equal(task?.current_completion_id, null, '核对不产生完成记录');
  const tasks = await repositories.tasks.listProjectTasksByStatus(project.projectId,
    ['INBOX', 'READY', 'IN_PROGRESS', 'WAITING', 'BLOCKED', 'DONE', 'CANCELLED']);
  assert.equal(tasks.length, 1, '核对不新建 Task');

  // 审计账本：核对动作恰一次。
  assert.equal(await externalCheckedAudits(requestId), '1');

  // 重复应用：终态回读，不重复核对、不产生第二条审计。
  const replay = await applyViaHttp(ws, requestId);
  assert.equal(replay.status, 'APPLIED', JSON.stringify(replay));
  assert.equal(await externalCheckedAudits(requestId), '1', '重复 applications 不重复核对');
});

test('复验B2：完成指令沿原完成 Owner 提交并绑定原消息；已满足原条件时记为已存在', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const taskId = await humanInProgressTask(ws, project.projectId, '可完成的任务');
  const message = '这几条验收标准我都确认过了，完成并接受这个任务';
  const session = await sessionIn(ws, project.projectId, message);
  const interpreted = await interpretRaw(ws, session,
    candidate([{ kind: 'COMPLETE_TASK', task_title: '可完成的任务' }]));
  const requestId = interpreted.result.request.id;

  const applied = await applyViaHttp(ws, requestId);
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
  const repositories = createRepositories(app.db);
  const task = await repositories.tasks.readTask(taskId);
  assert.equal(task?.status, 'DONE', '明确完成指令经原完成 Owner 生效');
  assert.ok(task?.current_completion_id !== null);

  // 接受声明绑定原用户消息原文；完成绑定确切验收版本。
  const completion = await repositories.completions
    .readCompletionRecord(task.current_completion_id!);
  assert.ok(completion !== undefined);
  const human = await repositories.completions
    .readHumanAcceptance(completion.human_acceptance_id!);
  assert.equal(human?.statement, message, '完成接受声明必须是原用户消息原文');
  assert.equal(completion.acceptance_revision, task?.acceptance_revision,
    '完成绑定当前验收版本');

  // 完成记录不随整组撤回自动重开：方案明确给出原因，不假装可以撤销。
  const plan = await undoPlanViaHttp(ws, requestId);
  assert.equal(plan.fully_withdrawable, false, JSON.stringify(plan));
  assert.equal(plan.items[0]!.reason_code, 'UNDO_ENTRY_MISSING');
  assert.match(String(plan.items[0]!.reason), /不随整组撤回自动重开/u);

  // 已满足原条件：第二条完成指令记为已存在，不产生第二个完成记录。
  const secondSession = await sessionIn(ws, project.projectId, '再确认一次，这个任务已经完成了');
  const second = await interpretRaw(ws, secondSession,
    candidate([{ kind: 'COMPLETE_TASK', task_title: '可完成的任务' }]));
  const secondApplied = await applyViaHttp(ws, second.result.request.id);
  assert.equal(secondApplied.status, 'APPLIED', JSON.stringify(secondApplied));
  const secondRows = await changeRows(second.result.request.id);
  assert.equal(secondRows[0]!.status, 'SKIPPED');
  const secondAfter = secondRows[0]!.after_ref as Record<string, unknown> | null;
  assert.equal(secondAfter?.skip_reason, 'ALREADY_COMPLETED');
  const taskAfter = await repositories.tasks.readTask(taskId);
  assert.equal(taskAfter?.current_completion_id, task.current_completion_id,
    '不产生第二个完成记录');

  // 完成之后的核对如实报「已按原完成记录完成」。
  const syncSession = await sessionIn(ws, project.projectId,
    '其他工具又说做好了，请核对并同步可完成的任务');
  const sync = await interpretRaw(ws, syncSession,
    candidate([{ kind: 'SYNC_EXTERNAL_RESULT', task_title: '可完成的任务' }]));
  const syncApplied = await applyViaHttp(ws, sync.result.request.id);
  assert.equal(syncApplied.status, 'APPLIED', JSON.stringify(syncApplied));
  const syncRows = await changeRows(sync.result.request.id);
  const syncAfter = syncRows[0]!.after_ref as Record<string, unknown> | null;
  assert.equal(syncAfter?.check_result, 'COMPLETED');
});

test('复验B3：确认之后任务被修改：完成指令按冻结版本拒绝，不产生完成', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const taskId = await humanInProgressTask(ws, project.projectId, '待修改的任务');
  const session = await sessionIn(ws, project.projectId, '确认完成并接受待修改的任务');
  const interpreted = await interpretRaw(ws, session,
    candidate([{ kind: 'COMPLETE_TASK', task_title: '待修改的任务' }]));
  const requestId = interpreted.result.request.id;

  // 确认之后、应用之前：人工经原 Owner 修改任务（版本推进，标题不变）。
  const repositories = createRepositories(app.db);
  const before = await repositories.tasks.readTask(taskId);
  assert.ok(before !== undefined && before !== null);
  await setTaskPlanningMetadata(app.db, { workspaceId: ws, taskId,
    commandId: randomUUID(), expectedRevision: String(before.revision),
    priority: 'NORMAL', dueLocalDate: before.due_local_date,
    timezone: before.due_timezone });

  const applied = await applyViaHttp(ws, requestId);
  assert.equal(applied.status, 'FAILED', JSON.stringify(applied));
  const rows = await changeRows(requestId);
  assert.equal(rows[0]!.status, 'FAILED');
  assert.equal((rows[0]!.error as { code: string } | null)?.code,
    'TARGET_VERSION_CONFLICT', '完成绑定冻结版本，不吸收后续人工修改');
  const after = await repositories.tasks.readTask(taskId);
  assert.notEqual(after?.status, 'DONE', '冲突时不能产生完成');
  assert.equal(after?.current_completion_id, null);
});

/* -------------------------------------------------------------------------- */
/* 第五节第 1 项：自然语言撤回（NLS-11）                                       */
/* -------------------------------------------------------------------------- */

test('复验5-1：自然语言撤回绑定同会话唯一已生效调整，复用按钮撤回用例', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const session = await sessionIn(ws, project.projectId, '进入实现阶段');
  const first = await interpretRaw(ws, session,
    candidate([{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }]));
  const applied = await applyViaHttp(ws, first.result.request.id);
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
  assert.equal((await readState(ws, project.projectId)).phase_key, 'IMPLEMENTATION');

  // 同一会话的第二条指令：明确的撤回。
  const second = await requestAssistMessage(app.db, { workspaceId: ws,
    sessionId: session.sessionId, commandId: randomUUID(),
    content: '撤回刚才那次调整' });
  const undo = await interpretRaw(ws, { sessionId: session.sessionId,
    userMessageId: second.result.user_message_id },
    candidate([{ kind: 'UNDO_STATE_CHANGE' }]));
  const undoApplied = await applyViaHttp(ws, undo.result.request.id);
  assert.equal(undoApplied.status, 'APPLIED', JSON.stringify(undoApplied));
  const undoRows = await changeRows(undo.result.request.id);
  assert.equal(undoRows[0]!.status, 'APPLIED');
  const undoAfter = undoRows[0]!.after_ref as Record<string, unknown> | null;
  assert.equal(undoAfter?.undone_request_id, first.result.request.id,
    '撤回绑定同会话原调整的请求身份');
  assert.equal(undoAfter?.undo_status, 'UNDONE',
    '复用按钮撤回的同一应用用例，目标状态是它的真实结算');

  // 原调整与项目状态都按原用例恢复。
  const target = await requestRow(first.result.request.id);
  assert.equal(target.status, 'UNDONE');
  assert.equal((await readState(ws, project.projectId)).phase_key, 'DISCOVERY');
});

test('复验5-1b：多条已生效调整按类型化歧义失败；没有可撤回调整时如实说明', async () => {
  const ws = await freshWorkspace();
  const project = await createProject(ws);
  const session = await sessionIn(ws, project.projectId, '进入实现阶段');
  const first = await interpretRaw(ws, session,
    candidate([{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }]));
  assert.equal((await applyViaHttp(ws, first.result.request.id)).status, 'APPLIED');
  const second = await requestAssistMessage(app.db, { workspaceId: ws,
    sessionId: session.sessionId, commandId: randomUUID(),
    content: '把下一步设为导出报告' });
  const secondTask = await httpTask(ws, project.projectId, '导出报告');
  const secondApply = await interpretRaw(ws, { sessionId: session.sessionId,
    userMessageId: second.result.user_message_id },
    candidate([{ kind: 'SET_NEXT_ACTION', task_title: '导出报告' }]));
  assert.equal((await applyViaHttp(ws, secondApply.result.request.id)).status, 'APPLIED');
  assert.ok(secondTask !== '');

  // 第三条：同会话已有两条已生效调整 → 类型化歧义，不猜原对象。
  const third = await requestAssistMessage(app.db, { workspaceId: ws,
    sessionId: session.sessionId, commandId: randomUUID(),
    content: '撤回刚才那次调整' });
  const undoAttempt = await interpretRaw(ws, { sessionId: session.sessionId,
    userMessageId: third.result.user_message_id },
    candidate([{ kind: 'UNDO_STATE_CHANGE' }]));
  const failed = await applyViaHttp(ws, undoAttempt.result.request.id);
  assert.equal(failed.status, 'FAILED', JSON.stringify(failed));
  const failedRows = await changeRows(undoAttempt.result.request.id);
  assert.equal((failedRows[0]!.error as { code: string } | null)?.code,
    'UNDO_TARGET_AMBIGUOUS', '多个候选时展示具体问题，不猜原对象');
  assert.equal((await requestRow(first.result.request.id)).status, 'APPLIED',
    '歧义失败不撤回任何一条');
  assert.equal((await requestRow(secondApply.result.request.id)).status, 'APPLIED');

  // 没有已生效调整的会话：如实说明找不到撤回对象。
  const emptySession = await sessionIn(ws, project.projectId, '撤回刚才那次调整');
  const none = await interpretRaw(ws, emptySession,
    candidate([{ kind: 'UNDO_STATE_CHANGE' }]));
  const noneApplied = await applyViaHttp(ws, none.result.request.id);
  assert.equal(noneApplied.status, 'FAILED', JSON.stringify(noneApplied));
  const noneRows = await changeRows(none.result.request.id);
  assert.equal((noneRows[0]!.error as { code: string } | null)?.code,
    'UNDO_TARGET_NOT_FOUND');
});
