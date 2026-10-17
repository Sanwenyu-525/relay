import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { AssistSessionRow, ConversationMode } from '../infrastructure/database-schema.js';
import { computePayloadHash } from '../receipt/payload-hash.js';
import { toDecimalString } from '../shared/decimal.js';
import { httpCommandScopeKey } from './actor.js';
import { requireActiveAssistantProfile } from './assistant-profile-commands.js';
import { resolveChatCommand } from './chat-commands.js';
import { resolveExistingReceipt, runIdempotentCommand, type CommandOutcome } from './command.js';
import { withdrawStateMaintenance } from './conversation-state.js';
import { DomainError, invalidTransition, resourceNotFound, validationFailed } from './domain-error.js';
import { lockWritableProjectInWorkspace } from './guards.js';
import { selectSessionModel } from './select-session-model.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

export type ExecuteChatCommandResult = {
  readonly kind: 'NEW_SESSION';
  readonly system: 'clear' | 'new';
  readonly source_session_id: string;
  readonly session_id: string;
  readonly project_id: string | null;
  readonly task_id: string | null;
  readonly conversation_mode: ConversationMode;
  readonly assistant_profile_id: string | null;
  readonly assistant_profile_revision: string | null;
  readonly revision: string;
} | {
  readonly kind: 'STATE_WITHDRAWAL';
  readonly system: 'undo';
  readonly session_id: string;
  readonly request_id: string;
  readonly status: string;
  readonly revision: string;
  readonly undo_command_id: string;
} | {
  /** /model 落到会话模型选择 Owner 的当前结果（沿用其幂等回执，不重复记账）。 */
  readonly kind: 'MODEL_SELECTION';
  readonly session_id: string;
  readonly connection: 'default' | 'openrouter';
  readonly model: string;
  readonly free_only: boolean;
  readonly config_fingerprint: string;
  readonly catalog_source: 'openrouter' | null;
  readonly catalog_snapshot_seq: string | null;
  readonly catalog_model_id: string | null;
  readonly revision: string;
};

async function requireSession(repositories: Repositories, workspaceId: string,
  sessionId: string, lock = false): Promise<AssistSessionRow> {
  const session = await repositories.assist.readSession(sessionId, lock);
  if (session === undefined || session.workspace_id !== workspaceId) {
    throw resourceNotFound('Assist session');
  }
  if (session.status !== 'ACTIVE') {
    throw invalidTransition('会话已归档，请打开历史或选择当前会话。', { sessionId });
  }
  if (await repositories.assist.hasInflightMessages(sessionId)) {
    throw invalidTransition('会话还有消息在途；请先通过现有取消入口停止，等结算后再试。',
      { sessionId });
  }
  return session;
}

/** 只接三条已登记基础命令；解析、菜单浏览和模型调用仍各走自己的入口。 */
export async function executeChatCommand(db: DbExecutor, input: {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly text: string;
}): Promise<CommandOutcome<ExecuteChatCommandResult>> {
  const resolution = resolveChatCommand(input.text);
  if (resolution.kind !== 'SYSTEM') {
    throw validationFailed([{ field: 'text', message: '此入口只执行 /clear、/new、/undo 或 /model。' }]);
  }
  // /model 交给会话模型选择的独占 Owner：自带幂等回执与 CAS，不在此处再套一层命令事务。
  if (resolution.system === 'model') {
    const outcome = await selectSessionModel(db, {
      workspaceId: input.workspaceId, sessionId: input.sessionId,
      commandId: input.commandId, requestedModel: resolution.argument ?? '' });
    return { ...outcome, result: { kind: 'MODEL_SELECTION', ...outcome.result } };
  }
  if (resolution.system !== 'clear' && resolution.system !== 'new' && resolution.system !== 'undo') {
    throw new DomainError({ code: 'CHAT_COMMAND_UNAVAILABLE', status: 409,
      type: '/problems/chat-command-unavailable', title: '此命令尚未接通',
      detail: `/${resolution.system} 目前仅可解析，尚无可执行的应用入口。`,
      retryable: false, retryAction: 'NONE' });
  }
  if (resolution.system === 'undo') return executeUndo(db, input);
  const system = resolution.system;
  return runIdempotentCommand<ExecuteChatCommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'ExecuteChatCommand', target: { session_id: input.sessionId },
    body: { system },
    execute: async (repositories) => {
      const original = await repositories.assist.readSession(input.sessionId);
      if (original === undefined || original.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Assist session');
      }
      if (original.project_id !== null) {
        await lockWritableProjectInWorkspace(repositories, input.workspaceId, original.project_id);
      }
      const source = await requireSession(repositories, input.workspaceId, input.sessionId, true);
      if (source.project_id !== original.project_id) {
        throw invalidTransition('会话归属刚发生变化，请重新读取后再试。', { sessionId: source.id });
      }
      if (source.conversation_mode === 'ASSISTANT') {
        if (source.assistant_profile_id === null) throw resourceNotFound('Assistant profile');
        await requireActiveAssistantProfile(repositories.assistantProfiles,
          input.workspaceId, source.assistant_profile_id);
      }
      const sessionId = randomUUID();
      // 经 Assist Owner 建空会话，沿原冻结身份；不搬消息、不删除历史、不转移执行权。
      await repositories.assist.insertSession({ id: sessionId,
        workspaceId: source.workspace_id, projectId: source.project_id, taskId: source.task_id,
        title: source.title, conversationMode: source.conversation_mode,
        assistantProfileId: source.assistant_profile_id,
        assistantProfileRevision: source.assistant_profile_revision,
        assistantRoleSnapshot: source.assistant_role_snapshot });
      const created = await repositories.assist.readSession(sessionId);
      if (created === undefined) throw new Error('new chat session disappeared during creation');
      return { kind: 'NEW_SESSION', system, source_session_id: source.id,
        session_id: created.id, project_id: created.project_id, task_id: created.task_id,
        conversation_mode: created.conversation_mode,
        assistant_profile_id: created.assistant_profile_id,
        assistant_profile_revision: created.assistant_profile_revision === null ? null
          : toDecimalString(created.assistant_profile_revision),
        revision: toDecimalString(created.revision) };
    },
  });
}

async function executeUndo(db: DbExecutor, input: {
  readonly workspaceId: string; readonly sessionId: string; readonly commandId: string;
}): Promise<CommandOutcome<ExecuteChatCommandResult>> {
  const repositories = createRepositories(db);
  // 原撤回身份精确绑定目标：无参数命令不猜“最近一条”，也不为新 ID 创造关联协议。
  const target = await repositories.conversationState.findByUndoCommand(input.workspaceId,
    input.sessionId, input.commandId);
  if (target === undefined) {
    const session = await requireSession(repositories, input.workspaceId, input.sessionId);
    if (session.conversation_mode !== 'AGENT') {
      throw invalidTransition('此会话身份不执行业务状态撤回；请回到原普通会话的调整回执。');
    }
    throw new DomainError({ code: 'UNDO_TARGET_NOT_FOUND', status: 409,
      type: '/problems/undo-target-not-found', title: '尚未选定撤回目标',
      detail: '请从本会话具体调整的回执读取 undo_command_id，并用该原身份执行 /undo；本次未执行撤回。',
      retryable: false, retryAction: 'REFRESH_AND_REDECIDE' });
  }
  const command = { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'WithdrawStateMaintenance',
    target: { request_id: target.id }, body: {} };
  const existing = await repositories.receipts.findReceipt(command);
  if (existing !== undefined) {
    return resolveExistingReceipt<ExecuteChatCommandResult>(existing, computePayloadHash(command));
  }
  const session = await requireSession(repositories, input.workspaceId, input.sessionId);
  if (session.conversation_mode !== 'AGENT') {
    throw invalidTransition('此会话身份不执行业务状态撤回；请回到原普通会话的调整回执。');
  }
  // 原 Owner 自带持久范围、CAS 与逐项短事务。不能嵌套在新回执事务里。
  const withdrawn = await withdrawStateMaintenance(db, {
    workspaceId: input.workspaceId, requestId: target.id, commandId: target.undo_command_id });
  // 撤回与回执之间中断时，用同一原身份重入 Owner；不重新选目标或重复补偿。
  return runIdempotentCommand<ExecuteChatCommandResult>(db, {
    ...command,
    execute: async () => ({ kind: 'STATE_WITHDRAWAL', system: 'undo',
      session_id: input.sessionId, request_id: withdrawn.request_id,
      status: withdrawn.status, revision: withdrawn.revision,
      undo_command_id: withdrawn.undo_command_id }),
  });
}
