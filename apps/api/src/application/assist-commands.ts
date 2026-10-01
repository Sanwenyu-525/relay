import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import type { AssistProposalRow, AssistSessionRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { canonicalizeJson, computePayloadHash } from '../receipt/payload-hash.js';
import { toDecimalString } from '../shared/decimal.js';
import { availableFrozenSkill, FIRST_PARTY_REGISTRY, frozenSkillSnapshot, isCallableSkill,
  normalizeSkillInput } from '../skills/first-party-registry.js';
import { checkAssistContent, checkRequiredText, normalizeText } from '../shared/text.js';
import type { ContextSourceRef } from '../workflow/execution-contract.js';
import { httpCommandScopeKey } from './actor.js';
import { applyArtifactCreation, prepareArtifactCreation } from './artifact-commands.js';
import { runIdempotentCommand, CommandIdReusedError, resolveExistingReceipt, type CommandOutcome } from './command.js';
import { applyTaskCreation, prepareTaskCreation, type CreateTaskCriterionInput } from './create-task.js';
import {
  invalidTransition,
  resourceNotFound,
  validationFailed,
} from './domain-error.js';
import { lockWritableProjectInWorkspace, readTaskInWorkspace } from './guards.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { createRepositories, type Repositories } from './unit-of-work.js';
import { applyTaskSkillContractChange } from './task-contract-commands.js';
import { skillOutputHash } from '../skills/skill-proposal.js';
import { requireRevision } from './revisions.js';
import { readAdmission, requireNormalAdmission } from './maintenance-admission.js';

/**
 * Assist 命令（M04/P12，runtime-context.md 第 5 节）：
 *   * Assist 不生成 Run、不持有 Task owner；会话/消息/提案只服务对话；
 *   * 消息固定写入其会话（固定消息目标），切换页面不会把旧回复落到新目标；
 *   * 类型化提案的接受调用与用户手动相同的业务命令，在同一事务内重新校验当前版本；
 *     重复接受按同一 command_id 的命令回执幂等，不同 command_id 的再次接受被拒绝。
 */

const ACCEPT_COMMAND_TYPE = 'AcceptAssistProposal';

export type CreateAssistSessionResult = {
  readonly session_id: string;
  readonly workspace_id: string;
  readonly project_id: string | null;
  readonly task_id: string | null;
  readonly title: string;
  readonly status: string;
  readonly revision: string;
  readonly created_at: string;
  readonly updated_at: string;
};

export interface CreateAssistSessionInput {
  readonly workspaceId: string;
  readonly commandId: string;
  readonly projectId?: string | null;
  readonly taskId?: string | null;
  readonly title: string;
}

export async function createAssistSession(
  db: DbExecutor,
  input: CreateAssistSessionInput,
): Promise<CommandOutcome<CreateAssistSessionResult>> {
  const titleProblem = checkRequiredText(input.title, 'title', 'title');
  if (titleProblem !== undefined) throw validationFailed([titleProblem]);
  const title = normalizeText(input.title);

  return runIdempotentCommand<CreateAssistSessionResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'CreateAssistSession',
    target: { workspace_id: input.workspaceId },
    body: { project_id: input.projectId ?? null, task_id: input.taskId ?? null, title },
    execute: async (repositories) => {
      let projectId = input.projectId ?? null;
      const taskId = input.taskId ?? null;
      if (taskId !== null) {
        const task = await readTaskInWorkspace(repositories, input.workspaceId, taskId);
        if (task === undefined) throw resourceNotFound('Task');
        // 会话绑定 Task 时作用域跟随 Task，避免出现 Task 与 Project 不一致的会话。
        if (projectId !== null && task.project_id !== projectId) {
          throw validationFailed([{ field: 'task_id', message: 'task 与 project 不属于同一作用域' }]);
        }
        projectId = task.project_id;
      }
      if (projectId !== null) {
        await lockWritableProjectInWorkspace(repositories, input.workspaceId, projectId);
      }
      const sessionId = randomUUID();
      await repositories.assist.insertSession({
        id: sessionId, workspaceId: input.workspaceId, projectId, taskId, title,
      });
      const created = await repositories.assist.readSession(sessionId);
      if (created === undefined) {
        throw new Error('assist session row vanished within its creating transaction');
      }
      return { session_id: created.id, workspace_id: created.workspace_id,
        project_id: created.project_id, task_id: created.task_id, title: created.title,
        status: created.status, revision: toDecimalString(created.revision),
        created_at: created.created_at.toISOString(),
        updated_at: created.updated_at.toISOString() };
    },
  });
}

export type RequestAssistMessageResult = {
  readonly session_id: string;
  readonly user_message_id: string;
  readonly assistant_message_id: string;
};

export interface AssistSourceRefInput {
  readonly kind: string;
  readonly root_id: string;
  readonly version: string;
}

export interface RequestAssistMessageInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly content: string;
  readonly intent?: string | undefined;
  readonly sourceRefs?: readonly AssistSourceRefInput[] | undefined;
  readonly skillRef?: { readonly id: string; readonly version: string } | undefined;
  readonly skillInput?: JsonObject | undefined;
}

const ASSIST_INTENTS: readonly string[] = ['DISCUSS', 'PROPOSE_CANDIDATE', 'PROPOSE_TASK'];
const MAX_ASSIST_SOURCES = 10;

export async function requestAssistMessage(
  db: DbExecutor,
  input: RequestAssistMessageInput,
): Promise<CommandOutcome<RequestAssistMessageResult>> {
  const contentProblem = checkAssistContent(input.content, 'content');
  if (contentProblem !== undefined) throw validationFailed([contentProblem]);
  const content = normalizeText(input.content);
  const intent = input.intent ?? 'DISCUSS';
  if (!ASSIST_INTENTS.includes(intent)) {
    throw validationFailed([{ field: 'intent', message: `intent 必须是 ${ASSIST_INTENTS.join('/')}` }]);
  }
  if (input.skillRef !== undefined && input.intent !== undefined ||
      input.skillRef === undefined && input.skillInput !== undefined) {
    throw validationFailed([{ field: 'skill_ref',
      message: 'Skill 调用由 skill_ref 决定意图，不能混用 intent；skill_input 需要 skill_ref' }]);
  }

  return runIdempotentCommand<RequestAssistMessageResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'RequestAssistMessage',
    target: { session_id: input.sessionId },
    body: { content, intent,
      ...(input.skillRef === undefined ? {} : {
        skill_ref: input.skillRef, skill_input: input.skillInput ?? {},
      }),
      sources: input.sourceRefs === undefined ? null :
        input.sourceRefs.map((source): JsonObject => ({
          kind: source.kind, root_id: source.root_id, version: source.version })),
    },
    execute: async (repositories) => {
      const session = await repositories.assist.readSession(input.sessionId, true);
      if (session === undefined || session.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Assist session');
      }
      if (session.project_id !== null) {
        await lockWritableProjectInWorkspace(repositories, input.workspaceId, session.project_id);
      }
      if (session.status !== 'ACTIVE') {
        throw invalidTransition('会话已归档，不能再发送消息。', { sessionId: session.id });
      }
      // 提案意图绑定对应作用域：候选 Markdown 需要明确目标 Task；任务定义需要明确 Project。
      if (intent === 'PROPOSE_CANDIDATE' && session.task_id === null) {
        throw invalidTransition('生成候选 Markdown 提案要求会话绑定一个 Task。', { sessionId: session.id });
      }
      if (intent === 'PROPOSE_TASK' && session.project_id === null) {
        throw invalidTransition('生成任务定义提案要求会话绑定一个 Project。', { sessionId: session.id });
      }
      const skill = input.skillRef === undefined ? null :
        FIRST_PARTY_REGISTRY.skill(input.skillRef.id, input.skillRef.version);
      if (input.skillRef !== undefined && skill === undefined) {
        throw validationFailed([{ field: 'skill_ref', message: '未知或不可用的第一方 Skill 版本' }]);
      }
      if (skill !== null && skill !== undefined && !isCallableSkill(skill)) {
        throw validationFailed([{ field: 'skill_ref', message: '该 Skill 版本仅保留历史读取' }]);
      }
      if (skill !== null && skill !== undefined &&
          (skill.definition.target === 'TASK' && session.task_id === null ||
           skill.definition.target === 'PROJECT' && session.project_id === null)) {
        throw invalidTransition('Skill 与 Assist 会话目标作用域不匹配。', { sessionId: session.id });
      }
      const skillInput = skill === null || skill === undefined ? null :
        normalizeSkillInput(skill, input.skillInput ?? {});
      if (skill !== null && skill !== undefined && skillInput === null) {
        throw validationFailed([{ field: 'skill_input', message: '输入不符合该 Skill 的固定契约' }]);
      }
      const sources = await resolveAssistSources(repositories, session, input.sourceRefs);

      const userSeq = await repositories.assist.nextMessageSeq(session.id);
      const userMessageId = randomUUID();
      const assistantMessageId = randomUUID();
      await repositories.assist.insertMessage({
        id: userMessageId, sessionId: session.id, seq: userSeq, role: 'USER',
        status: 'COMPLETED', intent: 'DISCUSS', content, sources: [],
      });
      await repositories.assist.insertMessage({
        id: assistantMessageId, sessionId: session.id, seq: userSeq + 1n, role: 'ASSISTANT',
        status: 'PENDING', intent: intent as 'DISCUSS', content: null, sources,
        ...(skill === null || skill === undefined ? {} : {
          skillSnapshot: frozenSkillSnapshot(skill), skillInput: skillInput!,
        }),
      });
      return { session_id: session.id, user_message_id: userMessageId,
        assistant_message_id: assistantMessageId };
    },
  });
}

/**
 * 显式来源选择（外发边界前置）：与 Delegate 的 context_sources 同一规则——
 * 同一 Workspace、ACTIVE、Project 作用域匹配、具体不可变版本存在、去重后 ≤10 条。
 * 版本引用随消息冻结；构建期缺失按 UNAVAILABLE 排除并留痕，不静默替换。
 */
async function resolveAssistSources(repositories: Repositories, session: AssistSessionRow,
  sourceRefs: readonly AssistSourceRefInput[] | undefined): Promise<readonly JsonObject[]> {
  if (sourceRefs === undefined || sourceRefs.length === 0) return [];
  if (sourceRefs.length > MAX_ASSIST_SOURCES) {
    throw invalidTransition(`显式来源选择最多 ${MAX_ASSIST_SOURCES} 条。`, { sessionId: session.id });
  }
  const resolved: JsonObject[] = [];
  const seen = new Set<string>();
  for (const source of sourceRefs) {
    const key = `${source.kind}:${source.root_id}:${source.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isContextSourceKind(source.kind) || !/^[1-9][0-9]*$/u.test(source.version)) {
      throw validationFailed([{ field: 'source_refs', message: '来源引用格式无效' }]);
    }
    const kind = source.kind.toLowerCase() as 'knowledge' | 'memory' | 'decision';
    const root = await repositories.information.readRoot(kind, source.root_id);
    if (root === undefined || root.workspace_id !== session.workspace_id) {
      throw resourceNotFound('Assist source');
    }
    if (root.status !== 'ACTIVE') {
      throw invalidTransition(`显式来源 ${source.root_id} 已停用，不能随会话冻结。`,
        { sessionId: session.id });
    }
    if (root.project_id !== null && root.project_id !== session.project_id) {
      throw resourceNotFound('Assist source');
    }
    const version = await repositories.information.readVersion(kind, source.root_id,
      BigInt(source.version));
    if (version === undefined) throw resourceNotFound('Assist source version');
    resolved.push({ kind: source.kind, root_id: source.root_id, version: source.version,
      status: 'FROZEN' });
  }
  return resolved;
}

function isContextSourceKind(kind: string): kind is ContextSourceRef['kind'] {
  return kind === 'KNOWLEDGE' || kind === 'MEMORY' || kind === 'DECISION';
}

export type CancelAssistMessageResult = {
  readonly message_id: string;
  readonly status: string;
};

export interface CancelAssistMessageInput {
  readonly workspaceId: string;
  readonly messageId: string;
  readonly commandId: string;
}

export async function cancelAssistMessage(
  db: DbExecutor,
  input: CancelAssistMessageInput,
): Promise<CommandOutcome<CancelAssistMessageResult>> {
  return runIdempotentCommand<CancelAssistMessageResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'CancelAssistMessage',
    target: { message_id: input.messageId },
    body: {},
    execute: async (repositories) => {
      const message = await repositories.assist.readMessage(input.messageId, true);
      if (message === undefined) throw resourceNotFound('Assist message');
      const session = await repositories.assist.readSession(message.session_id);
      if (session === undefined || session.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Assist message');
      }
      if (session.project_id !== null) {
        await lockWritableProjectInWorkspace(repositories, input.workspaceId, session.project_id);
      }
      if (message.status === 'PENDING' || message.status === 'RUNNING') {
        // 取消意图先持久化（红线 7）：PENDING 直接收敛；RUNNING 由生成方在结算前观察。
        const outcome = await repositories.assist.setCancelRequested(input.messageId);
        if (outcome === 'UNSETTLED') {
          throw invalidTransition('消息状态已变化，取消未生效。', { messageId: input.messageId });
        }
        return { message_id: input.messageId,
          status: outcome === 'CANCELLED' ? 'CANCELLED' : 'RUNNING' };
      }
      if (message.status === 'CANCELLED') {
        return { message_id: input.messageId, status: 'CANCELLED' };
      }
      throw invalidTransition(`消息已${message.status === 'COMPLETED' ? '完成' : '失败'}，不能取消。`,
        { messageId: input.messageId });
    },
  });
}

export type AcceptAssistProposalResult = JsonObject;

export interface AcceptAssistProposalInput {
  readonly workspaceId: string;
  readonly proposalId: string;
  readonly commandId: string;
  readonly storage: ManagedContentStore;
  readonly expectedTaskRevision?: string;
  readonly expectedAcceptanceRevision?: string;
  readonly payloadHash?: string;
}

/**
 * 接受提案：回执、业务效果与提案状态在同一事务提交。
 * 提案行以 FOR UPDATE 持锁贯穿整个效果，保证并发接受恰好一次生效；
 * 业务效果通过底层命令的 prepare/apply 组合完成，校验路径与用户手动调用完全一致。
 * base_revision 已前进时业务校验以 409 拒绝，提案按 EXPIRED 收敛后整体提交，
 * 不留下「效果已发生而提案仍 PENDING」的中间态。
 */
export async function acceptAssistProposal(
  db: DbExecutor,
  input: AcceptAssistProposalInput,
): Promise<CommandOutcome<AcceptAssistProposalResult>> {
  const scopeKey = httpCommandScopeKey(input.workspaceId);
  const hasTaskCas = input.expectedTaskRevision !== undefined ||
    input.expectedAcceptanceRevision !== undefined || input.payloadHash !== undefined;
  const expectedTaskRevision = input.expectedTaskRevision === undefined ? null :
    requireRevision(input.expectedTaskRevision, 'expected_task_revision');
  const expectedAcceptanceRevision = input.expectedAcceptanceRevision === undefined ? null :
    requireRevision(input.expectedAcceptanceRevision, 'expected_acceptance_revision');
  const payloadHash = computePayloadHash({
    commandType: ACCEPT_COMMAND_TYPE,
    target: { proposal_id: input.proposalId },
    body: hasTaskCas ? {
      expected_task_revision: expectedTaskRevision?.toString() ?? null,
      expected_acceptance_revision: expectedAcceptanceRevision?.toString() ?? null,
      payload_hash: input.payloadHash ?? null,
    } : {},
  });

  let expiredWith: unknown;
  const committed = await db.transaction().execute(async (trx) => {
    const repositories = createRepositories(trx);
    const existing = await repositories.receipts.findReceipt({ scopeKey,
      commandId: input.commandId });
    if (existing !== undefined) {
      if (!Buffer.from(existing.payload_hash).equals(payloadHash)) {
        throw new CommandIdReusedError(scopeKey, input.commandId);
      }
      return { result: existing.result_ref as AcceptAssistProposalResult, replayed: true,
        committedAt: existing.created_at };
    }

    const gate = await readAdmission(repositories, 'share');
    const committedWhileWaiting = await repositories.receipts.findReceipt({ scopeKey,
      commandId: input.commandId });
    if (committedWhileWaiting !== undefined) {
      return resolveExistingReceipt<AcceptAssistProposalResult>(committedWhileWaiting, payloadHash);
    }
    requireNormalAdmission(gate);
    const proposal = await repositories.assist.readProposal(input.proposalId, true);
    if (proposal === undefined || proposal.workspace_id !== input.workspaceId) {
      throw resourceNotFound('Assist proposal');
    }
    if (proposal.project_id !== null) {
      await lockWritableProjectInWorkspace(repositories, input.workspaceId, proposal.project_id);
    }
    if (proposal.status === 'ACCEPTED') {
      throw invalidTransition('提案已被接受，不能再次接受。', { proposalId: proposal.id });
    }
    if (proposal.status !== 'PENDING') {
      throw invalidTransition(`提案已${proposal.status === 'REJECTED' ? '被拒绝' : '过期'}。`,
        { proposalId: proposal.id });
    }
    const isTaskSkill = proposal.kind === 'TASK_CONTRACT_CHANGE' ||
      proposal.kind === 'VERIFICATION_PLAN_CHANGE';
    if (isTaskSkill) {
      if (expectedTaskRevision === null || expectedAcceptanceRevision === null ||
          input.payloadHash === undefined || !/^[0-9a-f]{64}$/u.test(input.payloadHash)) {
        throw validationFailed([{ field: 'expected_task_revision',
          message: 'Task Skill 接受要求双版本与提案 payload_hash' }]);
      }
      if (input.payloadHash !== proposal.payload_hash ||
          assistPayloadHash(proposal.payload) !== proposal.payload_hash) {
        throw invalidTransition('提案内容摘要与用户确认的不一致。',
          { proposalId: proposal.id });
      }
      const authority = await repositories.workspaces.lockAuthority(input.workspaceId, 'share');
      if (authority === undefined) throw resourceNotFound('Workspace authority');
      await requireCurrentSkillProposal(repositories, proposal);
    } else if (hasTaskCas) {
      throw validationFailed([{ field: 'expected_task_revision',
        message: '旧提案接受不使用 Task Skill CAS 字段' }]);
    }

    let result: JsonObject;
    try {
      result = await runProposalEffect(repositories, input, proposal,
        expectedTaskRevision, expectedAcceptanceRevision);
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
      // base_revision 落后：先在同一事务里把提案收敛为 EXPIRED 并提交，再把原始
      // 409 抛给调用方（在事务内直接抛出会连同 EXPIRED 一起回滚）。
      await repositories.assist.settleProposal(proposal.id, 'EXPIRED',
        { reason: 'BASE_REVISION_CONFLICT' });
      expiredWith = error;
      return null;
    }

    const settled = await repositories.assist.settleProposal(proposal.id, 'ACCEPTED',
      { command_id: input.commandId, result });
    if (!settled) {
      throw invalidTransition('提案状态已变化，接受未生效。', { proposalId: proposal.id });
    }
    const receipt = await repositories.receipts.insertReceipt({
      scopeKey, commandId: input.commandId, commandType: ACCEPT_COMMAND_TYPE,
      payloadHash, result,
    });
    return { result, replayed: false, committedAt: receipt.created_at };
  });
  if (expiredWith !== undefined) throw expiredWith;
  if (committed === null) {
    throw new Error('assist proposal accept ended without an outcome');
  }
  return committed;
}

/** 按提案种类驱动既有公开命令的事务内效果；校验与用户手动调用一致。 */
async function runProposalEffect(repositories: Repositories,
  input: AcceptAssistProposalInput, proposal: AssistProposalRow,
  expectedTaskRevision: bigint | null,
  expectedAcceptanceRevision: bigint | null): Promise<JsonObject> {
  const payload = proposal.payload as JsonObject;
  if (proposal.kind === 'TASK_CONTRACT_CHANGE' ||
      proposal.kind === 'VERIFICATION_PLAN_CHANGE') {
    if (expectedTaskRevision === null || expectedAcceptanceRevision === null) {
      throw new Error('Task Skill CAS was not validated');
    }
    return applyTaskSkillContractChange(repositories, { workspaceId: input.workspaceId,
      commandId: input.commandId, proposal,
      expectedRevision: expectedTaskRevision,
      expectedAcceptanceRevision });
  }
  if (proposal.kind === 'CANDIDATE_MARKDOWN') {
    const prepared = prepareArtifactCreation({
      workspaceId: input.workspaceId,
      taskId: proposal.target_id,
      commandId: input.commandId,
      expectedTaskRevision: toDecimalString(proposal.base_revision),
      title: typeof payload.title === 'string' ? payload.title : '',
      mediaType: typeof payload.media_type === 'string' ? payload.media_type : 'text/markdown',
      content: typeof payload.markdown === 'string' ? payload.markdown : '',
    });
    return applyArtifactCreation(repositories, input.storage, prepared);
  }
  if (proposal.kind !== 'TASK_DEFINITION') {
    throw invalidTransition('未知 Assist 提案类型，不能接受。', { proposalId: proposal.id });
  }
  const criteria = (Array.isArray(payload.criteria) ? payload.criteria : [])
    .filter(isJsonObject)
    .map((criterion): CreateTaskCriterionInput => ({
      ...(typeof criterion.criterion_id === 'string'
        ? { criterionId: criterion.criterion_id } : {}),
      statement: typeof criterion.statement === 'string' ? criterion.statement : '',
      required: criterion.required === true,
      ...(typeof criterion.method === 'string' ? { method: criterion.method } : {}),
      ...(isJsonObject(criterion.target_spec) ? { targetSpec: criterion.target_spec } : {}),
    }));
  const prepared = prepareTaskCreation({
    workspaceId: input.workspaceId,
    commandId: input.commandId,
    projectId: proposal.target_id,
    title: typeof payload.title === 'string' ? payload.title : '',
    objective: typeof payload.objective === 'string' ? payload.objective : '',
    criteria,
    expectedOutputs: isJsonObject(payload.expected_outputs) ? payload.expected_outputs : {},
    mode: 'ME',
  });
  return applyTaskCreation(repositories, prepared);
}

/** Recheck frozen generation identity and current source permission at acceptance. */
async function requireCurrentSkillProposal(r: Repositories,
  proposal: AssistProposalRow): Promise<void> {
  const message = await r.assist.readMessage(proposal.message_id);
  const session = await r.assist.readSession(proposal.session_id);
  if (message?.status !== 'COMPLETED' || message.skill_snapshot === null ||
      message.skill_output === null || session === undefined ||
      session.workspace_id !== proposal.workspace_id ||
      session.task_id !== proposal.target_id ||
      message.session_id !== session.id ||
      message.skill_snapshot.sha256 !== proposal.skill_sha256 ||
      skillOutputHash(message.skill_output) !== proposal.skill_output_sha256) {
    throw invalidTransition('Skill 提案来源已不可核对。', { proposalId: proposal.id });
  }
  const sourceOutput = message.skill_output;
  const baseline = sourceOutput.baseline;
  const kind = sourceOutput.kind;
  if (!isJsonObject(baseline) ||
      !isJsonObject(sourceOutput.payload) ||
      typeof sourceOutput.payload_sha256 !== 'string' ||
      createHash('sha256').update(canonicalizeJson(sourceOutput.payload))
        .digest('hex') !== sourceOutput.payload_sha256 ||
      baseline.task_id !== proposal.target_id ||
      baseline.task_revision !== proposal.base_revision.toString() ||
      baseline.acceptance_revision !== proposal.base_acceptance_revision?.toString() ||
      kind !== (proposal.kind === 'TASK_CONTRACT_CHANGE'
        ? 'TASK_DEFINITION_SUGGESTION' : 'VERIFICATION_PLAN_SUGGESTION')) {
    throw invalidTransition('Skill 提案基线与来源不一致。', { proposalId: proposal.id });
  }
  const frozen = availableFrozenSkill(message.skill_snapshot);
  if (frozen === null || !isCallableSkill(frozen) ||
      frozen.sha256 !== proposal.skill_sha256 ||
      proposal.kind === 'TASK_CONTRACT_CHANGE' &&
        frozen.id !== 'task-to-execution-contract' ||
      proposal.kind === 'VERIFICATION_PLAN_CHANGE' &&
        (frozen.id !== 'verification-plan' || frozen.version !== '1.1.0')) {
    throw invalidTransition('冻结 Skill 版本不再可应用。', { proposalId: proposal.id });
  }
  for (const raw of Array.isArray(message.sources) ? message.sources : []) {
    if (!isJsonObject(raw) ||
        (raw.kind !== 'KNOWLEDGE' && raw.kind !== 'MEMORY' &&
          raw.kind !== 'DECISION') ||
        typeof raw.root_id !== 'string' ||
        typeof raw.version !== 'string' || !/^[1-9][0-9]*$/u.test(raw.version)) {
      throw invalidTransition('Skill 来源已不可用。', { proposalId: proposal.id });
    }
    const sourceKind = raw.kind.toLowerCase() as 'knowledge' | 'memory' | 'decision';
    const root = await r.information.readRoot(sourceKind, raw.root_id);
    const version = await r.information.readVersion(sourceKind, raw.root_id,
      BigInt(raw.version));
    if (root?.workspace_id !== proposal.workspace_id || root.status !== 'ACTIVE' ||
        root.project_id !== null && root.project_id !== session.project_id ||
        version === undefined ||
        sourceKind === 'knowledge' && typeof version === 'object' &&
          version !== null && 'availability' in version &&
          version.availability !== 'AVAILABLE' ||
        sourceKind === 'memory' && typeof version === 'object' &&
          version !== null && 'expires_at' in version &&
          version.expires_at instanceof Date && version.expires_at <= new Date()) {
      throw invalidTransition('Skill 来源已不可用。', { proposalId: proposal.id });
    }
  }
}

export type RejectAssistProposalResult = {
  readonly proposal_id: string;
  readonly status: string;
};

export interface RejectAssistProposalInput {
  readonly workspaceId: string;
  readonly proposalId: string;
  readonly commandId: string;
}

export async function rejectAssistProposal(
  db: DbExecutor,
  input: RejectAssistProposalInput,
): Promise<CommandOutcome<RejectAssistProposalResult>> {
  return runIdempotentCommand<RejectAssistProposalResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'RejectAssistProposal',
    target: { proposal_id: input.proposalId },
    body: {},
    execute: async (repositories) => {
      const proposal = await repositories.assist.readProposal(input.proposalId, true);
      if (proposal === undefined || proposal.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Assist proposal');
      }
      if (proposal.project_id !== null) {
        await lockWritableProjectInWorkspace(repositories, input.workspaceId, proposal.project_id);
      }
      if (proposal.status === 'REJECTED') {
        return { proposal_id: proposal.id, status: 'REJECTED' };
      }
      const settled = await repositories.assist.settleProposal(proposal.id, 'REJECTED',
        { command_id: input.commandId });
      if (!settled) {
        throw invalidTransition('提案已决断，不能拒绝。', { proposalId: proposal.id });
      }
      return { proposal_id: proposal.id, status: 'REJECTED' };
    },
  });
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof Error && error.name === 'DomainError' &&
    (error as { code?: string }).code === 'REVISION_CONFLICT';
}

/** 提案 payload 的规范摘要；生成时与接受时一致，用于审计与失效检测。 */
export function assistPayloadHash(payload: JsonObject): string {
  return createHash('sha256').update(canonicalizeJson(payload), 'utf8').digest('hex');
}
