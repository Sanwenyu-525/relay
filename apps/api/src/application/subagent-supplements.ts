import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { AssistSessionRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { checkAssistContent, normalizeText } from '../shared/text.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound, validationFailed } from './domain-error.js';
import { createRepositories } from './unit-of-work.js';
import { lockWritableProjectInWorkspace } from './guards.js';

export async function supplementSubagent(db: DbExecutor, input: {
  workspaceId: string; childSessionId: string; commandId: string; content: string;
}): Promise<CommandOutcome<JsonObject & { supplement_id: string; source_message_id: string;
  child_session_id: string; parent_session_id: string; delegation_id: string }>> {
  const problem = checkAssistContent(input.content, 'content');
  if (problem !== undefined) throw validationFailed([problem]);
  const content = normalizeText(input.content);
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'SupplementSubagent',
    target: { child_session_id: input.childSessionId }, body: { content },
    execute: async (r) => {
      const initial = await r.assist.readSession(input.childSessionId);
      if (initial === undefined || initial.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Assist subagent session');
      }
      if (initial.parent_session_id === null) {
        throw invalidTransition('补充入口只接受临时委派的子会话。');
      }
      if (initial.project_id !== null) {
        await lockWritableProjectInWorkspace(r, input.workspaceId, initial.project_id);
      }
      // Parent then delegation then child: retry creation also locks delegation before inserting a message.
      const parent = await r.assist.readSession(initial.parent_session_id, true);
      const child = await r.assist.readSession(initial.id);
      if (parent === undefined || child === undefined || parent.workspace_id !== input.workspaceId
          || parent.project_id !== child.project_id || child.parent_session_id !== parent.id) {
        throw resourceNotFound('Assist subagent session');
      }
      if (parent.status !== 'ACTIVE' || child.status !== 'ACTIVE') {
        throw invalidTransition('主会话或子会话已归档，不能追加补充。');
      }
      const candidates = await r.subagents.listByChildSession(child.id);
      const candidate = candidates[0];
      if (candidates.length !== 1 || candidate === undefined ||
          candidate.parent_session_id !== parent.id || candidate.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Assist delegation');
      }
      const delegation = await r.subagents.readDelegation(candidate.id, true);
      if (delegation === undefined) throw resourceNotFound('Assist delegation');
      const lockedChild = await r.assist.readSession(child.id, true);
      if (lockedChild === undefined || lockedChild.status !== 'ACTIVE' ||
          lockedChild.parent_session_id !== parent.id || lockedChild.project_id !== initial.project_id) {
        throw invalidTransition('子会话范围已变化或已归档，请重新读取。');
      }
      const sourceMessageId = randomUUID();
      await r.assist.insertMessage({ id: sourceMessageId, sessionId: child.id,
        seq: await r.assist.nextMessageSeq(child.id), role: 'USER', status: 'COMPLETED',
        intent: 'DISCUSS', content, sources: [] });
      const supplementId = randomUUID();
      await r.subagents.insertSupplement({ id: supplementId, delegationId: delegation.id,
        sourceMessageId });
      await r.assist.touchLastMessage(child.id);
      return { supplement_id: supplementId, source_message_id: sourceMessageId,
        child_session_id: child.id, parent_session_id: parent.id, delegation_id: delegation.id };
    } });
}

export async function listSubagentSupplements(db: DbExecutor, input: {
  workspaceId: string; sessionId: string;
}) {
  const r = createRepositories(db);
  const session = await r.assist.readSession(input.sessionId);
  if (session === undefined || session.workspace_id !== input.workspaceId) {
    throw resourceNotFound('Assist session');
  }
  return (await r.subagents.listSupplements(session.id)).map((row) => ({
    id: row.id, delegation_id: row.delegation_id, source_message_id: row.source_message_id,
    source_session_id: row.source_session_id, parent_session_id: row.parent_session_id,
    content: row.content, delegation_status: row.delegation_status,
    parent_seen_at: row.parent_seen_at?.toISOString() ?? null,
    child_seen_at: row.child_seen_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  }));
}

/** Included only between model calls; the in-flight request is immutable. */
export async function readSubagentSupplementContext(db: DbExecutor, session: AssistSessionRow,
  messageId: string, retained: Map<string, JsonObject>) {
  if (session.conversation_mode !== 'AGENT') return { ids: [], block: '' };
  const rows = await createRepositories(db).subagents.listSupplements(session.id, 20,
    { messageId, child: session.parent_session_id !== null });
  for (const row of rows) retained.set(row.id, { supplement_id: row.id,
    delegation_id: row.delegation_id, source_session_id: row.source_session_id,
    source_message_id: row.source_message_id, content: row.content });
  if (retained.size === 0) return { ids: [], block: '' };
  return { ids: [...retained.keys()], block: [
    'SUBAGENT_USER_SUPPLEMENTS_V1',
    '以下为用户直接补充子任务的持久来源记录。同一 id 只代表一条补充，不是新的一次任务授权。',
    '仅在原委派范围内处理；超出范围交主 Agent 决定，不扩大只读权限，不复活已结束的执行。',
    '补充晚于原结论时不能声称原结论已覆盖新要求；必要时说明需要重新委派。',
    JSON.stringify([...retained.values()]),
  ].join('\n') };
}
