import { createHash, randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { DecisionRow, InformationRootRow, RuleRow, RuleVersionRow }
  from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { canonicalizeJson, computePayloadHash } from '../receipt/payload-hash.js';
import { toDecimalString } from '../shared/decimal.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { resolveExistingReceipt, runIdempotentCommand, type CommandOutcome } from './command.js';
import { DomainError, invalidTransition, resourceNotFound, revisionConflict,
  validationFailed } from './domain-error.js';
import { requireRevision } from './revisions.js';
import type { Repositories } from './unit-of-work.js';
import { lockWritableProjectInWorkspace } from './guards.js';
import { prepareDecisionReviews } from './decision-reviews.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { recheckAssistSources } from './assist-source-content.js';
import { historicalReplyAvailable } from './assist-memory.js';

type ScopeInput = { workspaceId: string; commandId: string };
type Result = { readonly knowledge_id?: string; readonly memory_id?: string;
  readonly decision_id?: string; readonly replacement_decision_id?: string;
  readonly rule_id?: string; readonly revision: string; readonly version?: string;
  readonly decision_review_count?: string; readonly decision_review_candidates_ref?: string;
  readonly status: string };
const MAX_TEXT_BYTES = 262144;

function textValue(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > MAX_TEXT_BYTES) {
    throw validationFailed([{ field, message: 'must be nonempty UTF-8 text up to 256 KiB' }]);
  }
  return trimmed;
}

function contentValue(value: string, field: string): string {
  if (!value.trim() || Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) {
    throw validationFailed([{ field, message: 'must be nonempty UTF-8 text up to 256 KiB' }]);
  }
  return value;
}

async function projectScope(r: Repositories, workspaceId: string,
  projectId: string | null): Promise<void> {
  if (projectId === null) {
    if (await r.workspaces.readWorkspace(workspaceId) === undefined) throw resourceNotFound('Workspace');
    return;
  }
  await lockWritableProjectInWorkspace(r, workspaceId, projectId);
}

async function root<T extends InformationRootRow | RuleRow>(r: Repositories,
  kind: 'knowledge' | 'memory' | 'decision' | 'rule', workspaceId: string,
  id: string): Promise<T> {
  const found = await r.information.readRoot<T>(kind, id, true);
  if (found?.workspace_id !== workspaceId) throw resourceNotFound(kind);
  if (found.project_id !== null) {
    await lockWritableProjectInWorkspace(r, workspaceId, found.project_id);
  }
  return found;
}

function sameRevision(kind: string, actual: bigint, expected: bigint): void {
  if (actual !== expected) throw revisionConflict({ entityType: kind.toUpperCase(),
    expectedRevision: toDecimalString(expected), actualRevision: toDecimalString(actual) });
}

async function ruleAuthority(r: Repositories, workspaceId: string): Promise<void> {
  if (await r.workspaces.lockAuthority(workspaceId, 'update') === undefined) {
    throw resourceNotFound('Workspace authority');
  }
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

export type KnowledgeSource = { sourceKind: 'NOTE' | 'MANAGED_TEXT'; text: string;
  mediaType?: string } | { sourceKind: 'ARTIFACT_VERSION'; artifactVersionId: string };

async function knowledgeSource(r: Repositories, workspaceId: string,
  projectId: string | null, source: KnowledgeSource) {
  if (source.sourceKind === 'ARTIFACT_VERSION') {
    const artifact = await r.information.readArtifactSource(workspaceId, source.artifactVersionId);
    if (artifact === undefined || projectId === null || artifact.project_id !== projectId) {
      throw resourceNotFound('ArtifactVersion');
    }
    if (artifact.media_type !== 'text/markdown') {
      throw validationFailed([{ field: 'artifact_version_id', message: 'only Markdown artifacts can be promoted' }]);
    }
    return { kind: source.sourceKind, mediaType: 'text/markdown', text: null,
      hash: artifact.content_hash, artifactId: artifact.artifact_id,
      artifactVersionId: source.artifactVersionId,
      refs: { artifact_version_id: source.artifactVersionId } as JsonObject };
  }
  const body = contentValue(source.text, 'text');
  const mediaType = source.mediaType ?? 'text/plain';
  if (source.sourceKind === 'NOTE' && mediaType !== 'text/plain' ||
      source.sourceKind === 'MANAGED_TEXT' && !['text/plain', 'text/markdown'].includes(mediaType)) {
    throw validationFailed([{ field: 'media_type', message: 'expected text/plain or text/markdown' }]);
  }
  return { kind: source.sourceKind, mediaType, text: body, hash: sha256(body),
    artifactId: null, artifactVersionId: null, refs: {} as JsonObject };
}

export async function createKnowledge(db: DbExecutor, input: ScopeInput & {
  projectId: string | null; title: string; source: KnowledgeSource;
}) {
  const title = textValue(input.title, 'title');
  return runIdempotentCommand<Result>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'CreateKnowledge', target: { project_id: input.projectId },
    body: { title, source: input.source }, execute: async (r) => {
      await ruleAuthority(r, input.workspaceId);
      await projectScope(r, input.workspaceId, input.projectId);
      const source = await knowledgeSource(r, input.workspaceId, input.projectId, input.source);
      if (source.artifactVersionId !== null) {
        const existing = await r.information.readPromotedArtifact(input.workspaceId, source.artifactVersionId);
        if (existing !== undefined) {
          if (existing.project_id !== input.projectId) throw resourceNotFound('ArtifactVersion');
          return { knowledge_id: existing.knowledge_id,
            revision: toDecimalString(existing.revision),
            version: toDecimalString(existing.version), status: existing.status };
        }
      }
      const id = randomUUID();
      await r.information.insertKnowledgeRoot(id, input.workspaceId, input.projectId, title);
      await r.information.insertKnowledgeVersion({ id: randomUUID(), workspaceId: input.workspaceId,
        knowledgeId: id, projectId: input.projectId, version: 1n,
        sourceKind: source.kind, mediaType: source.mediaType,
        text: source.text, hash: source.hash, artifactId: source.artifactId,
        artifactVersionId: source.artifactVersionId, sourceUri: null, sourceRefs: source.refs });
      await r.workspaces.bumpContextRevision(input.workspaceId);
      return { knowledge_id: id, revision: '0', version: '1', status: 'ACTIVE' };
    } });
}

export async function addKnowledgeVersion(db: DbExecutor, input: ScopeInput & {
  knowledgeId: string; expectedRevision: string; source: KnowledgeSource;
}) {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand<Result>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'AddKnowledgeVersion',
    target: { knowledge_id: input.knowledgeId }, body: { expected_revision: input.expectedRevision,
      source: input.source }, execute: async (r) => {
      await ruleAuthority(r, input.workspaceId);
      const item = await root<InformationRootRow>(r, 'knowledge', input.workspaceId, input.knowledgeId);
      sameRevision('knowledge', item.revision, expected);
      if (item.status !== 'ACTIVE') throw invalidTransition('Knowledge 已归档。');
      const source = await knowledgeSource(r, input.workspaceId, item.project_id, input.source);
      if (source.artifactVersionId !== null &&
          await r.information.readPromotedArtifact(input.workspaceId, source.artifactVersionId)) {
        throw invalidTransition('该 ArtifactVersion 已被提升为 Knowledge。');
      }
      const version = item.current_version + 1n;
      await r.information.insertKnowledgeVersion({ id: randomUUID(), workspaceId: input.workspaceId,
        knowledgeId: item.id, projectId: item.project_id, version,
        sourceKind: source.kind, mediaType: source.mediaType,
        text: source.text, hash: source.hash, artifactId: source.artifactId,
        artifactVersionId: source.artifactVersionId, sourceUri: null, sourceRefs: source.refs });
      await r.information.setRootVersion('knowledge', item.id, version);
      await r.workspaces.bumpContextRevision(input.workspaceId);
      const reviewCount = await prepareDecisionReviews(r, { workspaceId: input.workspaceId,
        commandId: input.commandId, knowledgeId: item.id });
      return { knowledge_id: item.id, revision: toDecimalString(item.revision + 1n),
        version: toDecimalString(version), status: 'ACTIVE',
        ...(reviewCount === '0' ? {} : { decision_review_count: reviewCount }),
        ...(reviewCount === '0' || item.project_id === null ? {} : { decision_review_candidates_ref: `projects/${item.project_id}/decision-reviews` }) };
    } });
}

/**
 * 事务内版本：供组合用例在同一事务里复用本模块的命令语义。
 * 与命令版共用同一 execute 主体，但不自己开事务、也不自己写回执——回执由调用方在
 * 同一事务里写它自己那一条。这保证「写事实 + 绑定归属」要么都提交、要么都回滚，
 * 不留无归属的孤立版本，也不会为同一 command_id 写两行回执。
 */
async function inTransaction<TResult extends Result>(
  repositories: Repositories, scopeKey: string,
  request: { readonly commandType: string; readonly commandId: string;
    readonly target: JsonObject; readonly body: JsonObject;
    readonly execute: (r: Repositories) => Promise<TResult> },
): Promise<TResult> {
  const payloadHash = computePayloadHash({ commandType: request.commandType,
    target: request.target, body: request.body });
  const existing = await repositories.receipts.findReceipt({ scopeKey,
    commandId: request.commandId });
  if (existing !== undefined) return resolveExistingReceipt<TResult>(existing, payloadHash).result;
  // 不在这里写回执：调用方在同一事务里写自己那一条，避免同一 command_id 写两行。
  return request.execute(repositories);
}

export async function createKnowledgeInTransaction(repositories: Repositories,
  input: ScopeInput & { projectId: string | null; title: string; source: KnowledgeSource;
    commandId: string }) {
  const title = textValue(input.title, 'title');
  return inTransaction<Result>(repositories, httpCommandScopeKey(input.workspaceId), {
    commandType: 'CreateKnowledge', commandId: input.commandId,
    target: { project_id: input.projectId },
    body: { title, source: input.source as unknown as JsonObject },
    execute: async (r) => {
      await ruleAuthority(r, input.workspaceId);
      await projectScope(r, input.workspaceId, input.projectId);
      const source = await knowledgeSource(r, input.workspaceId, input.projectId, input.source);
      if (source.artifactVersionId !== null) {
        const existing = await r.information.readPromotedArtifact(input.workspaceId,
          source.artifactVersionId);
        if (existing !== undefined) {
          if (existing.project_id !== input.projectId) throw resourceNotFound('ArtifactVersion');
          return { knowledge_id: existing.knowledge_id,
            revision: toDecimalString(existing.revision),
            version: toDecimalString(existing.version), status: existing.status };
        }
      }
      const id = randomUUID();
      await r.information.insertKnowledgeRoot(id, input.workspaceId, input.projectId, title);
      await r.information.insertKnowledgeVersion({ id: randomUUID(), workspaceId: input.workspaceId,
        knowledgeId: id, projectId: input.projectId, version: 1n,
        sourceKind: source.kind, mediaType: source.mediaType,
        text: source.text, hash: source.hash, artifactId: source.artifactId,
        artifactVersionId: source.artifactVersionId, sourceUri: null, sourceRefs: source.refs });
      await r.workspaces.bumpContextRevision(input.workspaceId);
      return { knowledge_id: id, revision: '0', version: '1', status: 'ACTIVE' };
    } });
}

export async function addKnowledgeVersionInTransaction(repositories: Repositories,
  input: ScopeInput & { knowledgeId: string; expectedRevision: string;
    source: KnowledgeSource; commandId: string }) {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  return inTransaction<Result>(repositories, httpCommandScopeKey(input.workspaceId), {
    commandType: 'AddKnowledgeVersion', commandId: input.commandId,
    target: { knowledge_id: input.knowledgeId },
    body: { expected_revision: input.expectedRevision,
      source: input.source as unknown as JsonObject },
    execute: async (r) => {
      await ruleAuthority(r, input.workspaceId);
      const item = await root<InformationRootRow>(r, 'knowledge', input.workspaceId,
        input.knowledgeId);
      sameRevision('knowledge', item.revision, expected);
      if (item.status !== 'ACTIVE') throw invalidTransition('Knowledge 已归档。');
      const source = await knowledgeSource(r, input.workspaceId, item.project_id, input.source);
      if (source.artifactVersionId !== null &&
          await r.information.readPromotedArtifact(input.workspaceId, source.artifactVersionId)) {
        throw invalidTransition('该 ArtifactVersion 已被提升为 Knowledge。');
      }
      const version = item.current_version + 1n;
      await r.information.insertKnowledgeVersion({ id: randomUUID(),
        workspaceId: input.workspaceId, knowledgeId: item.id, projectId: item.project_id, version,
        sourceKind: source.kind, mediaType: source.mediaType,
        text: source.text, hash: source.hash, artifactId: source.artifactId,
        artifactVersionId: source.artifactVersionId, sourceUri: null, sourceRefs: source.refs });
      await r.information.setRootVersion('knowledge', item.id, version);
      await r.workspaces.bumpContextRevision(input.workspaceId);
      const reviewCount = await prepareDecisionReviews(r, { workspaceId: input.workspaceId,
        commandId: input.commandId, knowledgeId: item.id });
      return { knowledge_id: item.id, revision: toDecimalString(item.revision + 1n),
        version: toDecimalString(version), status: 'ACTIVE',
        ...(reviewCount === '0' ? {} : { decision_review_count: reviewCount }),
        ...(reviewCount === '0' || item.project_id === null ? {} : { decision_review_candidates_ref: `projects/${item.project_id}/decision-reviews` }) };
    } });
}

export async function createMemory(db: DbExecutor, input: ScopeInput & {
  projectId: string | null; title: string; text: string; confirmed: boolean;
  expiresAt?: string | null;
}) {
  const title = textValue(input.title, 'title');
  const body = contentValue(input.text, 'text');
  if (input.confirmed !== true) throw validationFailed([{ field: 'confirmed', message: 'explicit true required' }]);
  const expiresAt = parseExpiry(input.expiresAt);
  return runIdempotentCommand<Result>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'CreateMemory', target: { project_id: input.projectId },
    body: { title, text: body, confirmed: true, expires_at: expiresAt?.toISOString() ?? null },
    execute: async (r) => {
      await ruleAuthority(r, input.workspaceId);
      await projectScope(r, input.workspaceId, input.projectId);
      const id = randomUUID();
      await r.information.insertMemoryRoot(id, input.workspaceId, input.projectId, title);
      await r.information.insertMemoryVersion({ id: randomUUID(), memoryId: id, version: 1n,
        title, text: body, confirmedBy: LOCAL_ACTOR_REF, expiresAt });
      await r.workspaces.bumpContextRevision(input.workspaceId);
      return { memory_id: id, revision: '0', version: '1', status: 'ACTIVE' };
    } });
}

export async function createMemoryFromMessage(db: DbExecutor, input: ScopeInput & {
  sessionId: string; messageId: string; expectedSessionRevision: string;
  expectedContentSha256: string; projectId: string | null; title: string;
  text: string; confirmed: boolean; expiresAt?: string | null;
}, storage: ManagedContentStore) {
  const title = textValue(input.title, 'title');
  const body = contentValue(input.text, 'text');
  const expected = requireRevision(input.expectedSessionRevision, 'expected_session_revision');
  if (input.confirmed !== true || !/^[0-9a-f]{64}$/u.test(input.expectedContentSha256)) {
    throw validationFailed([{ field: 'confirmed', message: 'explicit confirmation and exact source hash required' }]);
  }
  const expiresAt = parseExpiry(input.expiresAt);
  return runIdempotentCommand<Result>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'CreateMemoryFromMessage',
    target: { session_id: input.sessionId, message_id: input.messageId },
    body: { project_id: input.projectId, title, text: body, confirmed: true,
      expected_session_revision: expected.toString(), content_sha256: input.expectedContentSha256,
      expires_at: expiresAt?.toISOString() ?? null }, execute: async (r) => {
      await ruleAuthority(r, input.workspaceId);
      const prior = await r.receipts.findReceipt({ scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId });
      if (prior !== undefined) return prior.result_ref as Result;
      const session = await r.assist.readSession(input.sessionId, true);
      if (session?.workspace_id !== input.workspaceId) throw resourceNotFound('Assist session');
      sameRevision('assist_session', session.revision, expected);
      if (session.status !== 'ACTIVE') throw invalidTransition('归档会话不能创建新的长期记忆。');
      if (input.projectId !== null && input.projectId !== session.project_id) throw resourceNotFound('Memory scope');
      await projectScope(r, input.workspaceId, session.project_id);
      const source = await r.assist.readMessage(input.messageId);
      if (source?.session_id !== session.id) throw resourceNotFound('Assist message');
      if (source.status !== 'COMPLETED' || source.content === null || !source.content.trim()) {
        throw invalidTransition('只能从已完成且有正文的消息明确保存记忆。');
      }
      if (sha256(source.content).toString('hex') !== input.expectedContentSha256) {
        throw invalidTransition('消息正文与确认时的来源不一致，请重新读取。');
      }
      if (source.role === 'ASSISTANT' && (!(await recheckAssistSources(r, storage, session, source.sources)).available ||
          !await historicalReplyAvailable(r, storage, session, source.id))) {
        throw invalidTransition('来源已失效，不能沿旧答复建立长期记忆。');
      }
      const id = randomUUID();
      await r.information.insertMemoryRoot(id, input.workspaceId, input.projectId, title);
      await r.information.insertMemoryVersion({ id: randomUUID(), memoryId: id, version: 1n,
        title, text: body, confirmedBy: LOCAL_ACTOR_REF, expiresAt });
      await r.information.insertMemoryMessageSource({ memoryId: id, sessionId: session.id,
        messageId: source.id, contentSha256: input.expectedContentSha256 });
      await r.workspaces.bumpContextRevision(input.workspaceId);
      await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
        actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
        projectId: input.projectId, taskId: null, eventType: 'MEMORY_SAVED_FROM_MESSAGE',
        factRefs: { memory_id: id, session_id: session.id, message_id: source.id, version: '1' } });
      return { memory_id: id, revision: '0', version: '1', status: 'ACTIVE' };
    } });
}

export async function addMemoryRevision(db: DbExecutor, input: ScopeInput & {
  memoryId: string; expectedRevision: string; title: string; text: string;
  confirmed: boolean; expiresAt?: string | null;
}) {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  const title = textValue(input.title, 'title');
  const body = contentValue(input.text, 'text');
  if (input.confirmed !== true) throw validationFailed([{ field: 'confirmed', message: 'explicit true required' }]);
  const expiresAt = parseExpiry(input.expiresAt);
  return runIdempotentCommand<Result>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'AddMemoryRevision', target: { memory_id: input.memoryId },
    body: { expected_revision: input.expectedRevision, title, text: body, confirmed: true,
      expires_at: expiresAt?.toISOString() ?? null }, execute: async (r) => {
      await ruleAuthority(r, input.workspaceId);
      const item = await root<InformationRootRow>(r, 'memory', input.workspaceId, input.memoryId);
      sameRevision('memory', item.revision, expected);
      if (item.status !== 'ACTIVE') throw invalidTransition('Memory 已退役。');
      const version = item.current_version + 1n;
      await r.information.insertMemoryVersion({ id: randomUUID(), memoryId: item.id, version,
        title, text: body, confirmedBy: LOCAL_ACTOR_REF, expiresAt });
      await r.information.setRootVersion('memory', item.id, version, title);
      await r.workspaces.bumpContextRevision(input.workspaceId);
      return { memory_id: item.id, revision: toDecimalString(item.revision + 1n),
        version: toDecimalString(version), status: 'ACTIVE' };
    } });
}

function parseExpiry(value?: string | null): Date | null {
  if (value === undefined || value === null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
    throw validationFailed([{ field: 'expires_at', message: 'must be a future ISO timestamp' }]);
  }
  return date;
}

export async function createDecision(db: DbExecutor, input: ScopeInput & {
  projectId: string | null; title: string; choice: string; rationale: string;
  alternatives: readonly string[]; costs: readonly string[];
}) {
  const title = textValue(input.title, 'title');
  const choice = textValue(input.choice, 'choice');
  const rationale = textValue(input.rationale, 'rationale');
  return runIdempotentCommand<Result>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'CreateDecision', target: { project_id: input.projectId },
    body: { title, choice, rationale, alternatives: input.alternatives, costs: input.costs },
    execute: async (r) => {
      await ruleAuthority(r, input.workspaceId);
      await projectScope(r, input.workspaceId, input.projectId);
      const id = randomUUID();
      await r.information.insertDecisionRoot(id, input.workspaceId, input.projectId, title);
      await r.information.insertDecisionVersion({ id: randomUUID(), decisionId: id, version: 1n,
        choice, rationale, alternatives: input.alternatives, costs: input.costs });
      await r.workspaces.bumpContextRevision(input.workspaceId);
      return { decision_id: id, revision: '0', version: '1', status: 'ACTIVE' };
    } });
}

export async function supersedeDecision(db: DbExecutor, input: ScopeInput & {
  decisionId: string; expectedRevision: string; replacementDecisionId: string;
}) {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand<Result>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'SupersedeDecision',
    target: { decision_id: input.decisionId }, body: { expected_revision: input.expectedRevision,
      replacement_decision_id: input.replacementDecisionId }, execute: async (r) => {
      await ruleAuthority(r, input.workspaceId);
      const old = await root<DecisionRow>(r, 'decision', input.workspaceId, input.decisionId);
      sameRevision('decision', old.revision, expected);
      const replacement = await r.information.readRoot<DecisionRow>('decision', input.replacementDecisionId);
      if (replacement?.workspace_id !== input.workspaceId || replacement.project_id !== old.project_id) {
        throw resourceNotFound('Replacement Decision');
      }
      if (old.status !== 'ACTIVE' || replacement.status !== 'ACTIVE') {
        throw invalidTransition('替代只允许两个当前有效且同作用域的 Decision。');
      }
      if (old.id === replacement.id ||
          (await r.information.decisionChain(replacement.id)).some((row) => row.id === old.id)) {
        throw invalidTransition('Decision 替代关系会形成环。');
      }
      await r.information.supersedeDecision(old.id, replacement.id);
      await r.workspaces.bumpContextRevision(input.workspaceId);
      return { decision_id: old.id, replacement_decision_id: replacement.id,
        revision: toDecimalString(old.revision + 1n), status: 'SUPERSEDED' };
    } });
}

export type RuleBody = { ruleKey: string; statement: string; strength: RuleVersionRow['strength'];
  applicability: 'AI_RUN'; enforcement: RuleVersionRow['enforcement'];
  method?: RuleVersionRow['method']; targetSpec?: JsonObject };

function normalizedRule(body: RuleBody) {
  const ruleKey = textValue(body.ruleKey, 'rule_key');
  const statement = textValue(body.statement, 'statement');
  const method = body.method ?? null;
  const targetSpec = body.targetSpec ?? {};
  if (body.applicability !== 'AI_RUN') throw validationFailed([{ field: 'applicability', message: 'AI_RUN required' }]);
  if (body.enforcement === 'POST_CHECK' &&
      method !== 'MARKDOWN_STRUCTURE' && method !== 'CITATION_EXISTS') {
    throw ruleEnforcementUnavailable('POST_CHECK 需要已注册的确定性检查 method。');
  }
  if (body.enforcement === 'HUMAN' && method !== null && method !== 'HUMAN' ||
      body.enforcement === 'SEMANTIC' && method !== null && method !== 'SEMANTIC') {
    throw validationFailed([{ field: 'method', message: 'method must match enforcement' }]);
  }
  return { ruleKey, statement, strength: body.strength, enforcement: body.enforcement,
    method, targetSpec };
}

export function ruleEnforcementUnavailable(detail: string): DomainError {
  return new DomainError({ code: 'RULE_ENFORCEMENT_UNAVAILABLE', status: 409,
    type: '/problems/rule-enforcement-unavailable', title: '规则检查路径不可用', detail,
    retryable: false, retryAction: 'REFRESH_AND_REDECIDE' });
}

export function ruleConflict(detail: string): DomainError {
  return new DomainError({ code: 'RULE_CONFLICT', status: 409,
    type: '/problems/rule-conflict', title: '适用规则冲突', detail,
    retryable: false, retryAction: 'REFRESH_AND_REDECIDE' });
}

export async function createRule(db: DbExecutor, input: ScopeInput & Omit<RuleBody, 'ruleKey'> & {
  ruleKey?: string; scope: RuleRow['scope']; scopeId: string;
  /** 仅用于真实 PG barrier 测试。 */
  hooks?: { readonly afterAuthorityLock?: () => Promise<void> };
}) {
  const body = normalizedRule({ ...input, ruleKey: ruleKeyFor(input.commandId, input.ruleKey) });
  return runIdempotentCommand<Result>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'CreateRule',
    target: { scope: input.scope, scope_id: input.scopeId }, body: { ...body, applicability: 'AI_RUN' },
    execute: async (r) => {
      await ruleAuthority(r, input.workspaceId);
      await input.hooks?.afterAuthorityLock?.();
      const { projectId, taskId } = await ruleScope(r, input.workspaceId, input.scope, input.scopeId);
      const id = randomUUID();
      await r.information.insertRuleRoot({ id, workspaceId: input.workspaceId,
        scope: input.scope, projectId, taskId });
      await r.information.insertRuleVersion({ id: randomUUID(), ruleId: id, version: 1n, ...body });
      await r.workspaces.bumpRuleRevision(input.workspaceId);
      return { rule_id: id, revision: '0', version: '1', status: 'ACTIVE' };
    } });
}

/**
 * 规则键是服务端身份，不是用户输入项（工作台 §42.3）。
 *
 * 缺省时按 `command_id` 派生，而不是取随机值：同一个 command_id 的重试必须算出同一个键，
 * 否则回执的载荷哈希对不上，幂等重放会被误判成「command_id 被复用于不同载荷」。
 * 键仍然稳定唯一（command_id 全局唯一），创建后不再改变。
 */
function ruleKeyFor(commandId: string, submitted?: string): string {
  const trimmed = submitted?.trim() ?? '';
  return trimmed === '' ? `rule-${commandId}` : trimmed;
}

async function ruleScope(r: Repositories, workspaceId: string, scope: RuleRow['scope'], scopeId: string) {
  if (scope === 'WORKSPACE') {
    if (scopeId !== workspaceId) throw resourceNotFound('Workspace');
    return { projectId: null, taskId: null };
  }
  if (scope === 'PROJECT') {
    await projectScope(r, workspaceId, scopeId);
    return { projectId: scopeId, taskId: null };
  }
  const task = await r.tasks.readTask(scopeId);
  if (task?.workspace_id !== workspaceId || task.project_id === null) throw resourceNotFound('Task');
  await lockWritableProjectInWorkspace(r, workspaceId, task.project_id);
  return { projectId: task.project_id, taskId: task.id };
}

export async function addRuleVersion(db: DbExecutor, input: ScopeInput & RuleBody & {
  ruleId: string; expectedRevision: string;
}) {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  const body = normalizedRule(input);
  return runIdempotentCommand<Result>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'AddRuleVersion', target: { rule_id: input.ruleId },
    body: { expected_revision: input.expectedRevision, ...body, applicability: 'AI_RUN' },
    execute: async (r) => {
      await ruleAuthority(r, input.workspaceId);
      const item = await root<RuleRow>(r, 'rule', input.workspaceId, input.ruleId);
      sameRevision('rule', item.revision, expected);
      if (item.status !== 'ACTIVE') throw invalidTransition('Rule 已退役。');
      const version = item.current_version + 1n;
      await r.information.insertRuleVersion({ id: randomUUID(), ruleId: item.id, version, ...body });
      await r.information.setRootVersion('rule', item.id, version);
      await r.workspaces.bumpRuleRevision(input.workspaceId);
      return { rule_id: item.id, revision: toDecimalString(item.revision + 1n),
        version: toDecimalString(version), status: 'ACTIVE' };
    } });
}

export async function retireInformation(db: DbExecutor, input: ScopeInput & {
  kind: 'knowledge' | 'memory' | 'rule'; id: string; expectedRevision: string;
}) {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  const commandType = input.kind === 'knowledge' ? 'ArchiveKnowledge' :
    input.kind === 'memory' ? 'RetireMemory' : 'RetireRule';
  const status = input.kind === 'knowledge' ? 'ARCHIVED' : 'RETIRED';
  return runIdempotentCommand<Result>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType, target: { [`${input.kind}_id`]: input.id },
    body: { expected_revision: input.expectedRevision }, execute: async (r) => {
      await ruleAuthority(r, input.workspaceId);
      const item = await root<InformationRootRow | RuleRow>(r, input.kind, input.workspaceId, input.id);
      sameRevision(input.kind, item.revision, expected);
      if (item.status !== 'ACTIVE') throw invalidTransition(`${input.kind} 已非有效状态。`);
      await r.information.setRootStatus(input.kind, item.id, status);
      if (input.kind === 'rule') await r.workspaces.bumpRuleRevision(input.workspaceId);
      else await r.workspaces.bumpContextRevision(input.workspaceId);
      const reviewCount = input.kind === 'knowledge' ? await prepareDecisionReviews(r, {
        workspaceId: input.workspaceId, commandId: input.commandId, knowledgeId: item.id }) : undefined;
      return { [`${input.kind}_id`]: item.id, revision: toDecimalString(item.revision + 1n), status,
        ...(reviewCount === undefined || reviewCount === '0' ? {} : { decision_review_count: reviewCount }),
        ...(reviewCount === undefined || reviewCount === '0' || item.project_id === null ? {} : { decision_review_candidates_ref: `projects/${item.project_id}/decision-reviews` }) };
    } });
}

/** Forward compensation only: versions, review candidates and prior receipts remain historical facts. */
export async function restoreInformation(db: DbExecutor, input: ScopeInput & {
  kind: 'knowledge' | 'memory' | 'rule'; id: string; expectedRevision: string;
}) {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  const commandType = input.kind === 'knowledge' ? 'UnarchiveKnowledge'
    : input.kind === 'memory' ? 'ReactivateMemory' : 'ReactivateRule';
  return runIdempotentCommand<Result>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType, target: { [`${input.kind}_id`]: input.id },
    body: { expected_revision: input.expectedRevision }, execute: async (r) => {
      await ruleAuthority(r, input.workspaceId);
      // A concurrent first request can commit while authority is locked. Returning its
      // result lets receipt uniqueness resolve the replay and compare the original payload.
      const prior = await r.receipts.findReceipt({ scopeKey: httpCommandScopeKey(input.workspaceId),
        commandId: input.commandId });
      if (prior !== undefined) return prior.result_ref as Result;
      const item = await root<InformationRootRow | RuleRow>(r, input.kind, input.workspaceId, input.id);
      sameRevision(input.kind, item.revision, expected);
      if (item.status === 'ACTIVE') return { [`${input.kind}_id`]: item.id,
        revision: toDecimalString(item.revision), status: 'ACTIVE' };
      const retiredStatus = input.kind === 'knowledge' ? 'ARCHIVED' : 'RETIRED';
      if (item.status !== retiredStatus) throw invalidTransition(`${input.kind} 当前状态不能恢复。`);
      await r.information.setRootStatus(input.kind, item.id, 'ACTIVE');
      if (input.kind === 'rule') await r.workspaces.bumpRuleRevision(input.workspaceId);
      else await r.workspaces.bumpContextRevision(input.workspaceId);
      const revision = toDecimalString(item.revision + 1n);
      await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
        actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
        projectId: item.project_id, taskId: input.kind === 'rule' ? (item as RuleRow).task_id : null,
        eventType: input.kind === 'knowledge' ? 'KNOWLEDGE_UNARCHIVED'
          : input.kind === 'memory' ? 'MEMORY_REACTIVATED' : 'RULE_REACTIVATED',
        factRefs: { [`${input.kind}_id`]: item.id, previous_status: item.status, status: 'ACTIVE',
          previous_revision: toDecimalString(item.revision), revision,
          current_version: toDecimalString(item.current_version) } });
      return { [`${input.kind}_id`]: item.id, revision, status: 'ACTIVE' };
    } });
}

/** 相同 rule_key 的上层 HARD 不可被下层覆盖；PREFERENCE 在最具体作用域覆盖。 */
export function resolveApplicableRules(rows: readonly (RuleRow & RuleVersionRow)[]):
  readonly (RuleRow & RuleVersionRow)[] {
  const result = new Map<string, RuleRow & RuleVersionRow>();
  for (const row of rows) {
    const prior = result.get(row.rule_key);
    if (prior === undefined) { result.set(row.rule_key, row); continue; }
    const priorMeaning = canonicalizeJson({ statement: prior.statement,
      enforcement: prior.enforcement, method: prior.method, target_spec: prior.target_spec });
    const newMeaning = canonicalizeJson({ statement: row.statement,
      enforcement: row.enforcement, method: row.method, target_spec: row.target_spec });
    if ((prior.scope === row.scope || prior.strength === 'HARD' || row.strength === 'HARD') &&
        priorMeaning !== newMeaning) {
      throw ruleConflict(`rule_key ${row.rule_key} 的适用版本冲突：${prior.id} 与 ${row.id}。`);
    }
    if (prior.strength !== 'HARD') result.set(row.rule_key, row);
  }
  return [...result.values()];
}
