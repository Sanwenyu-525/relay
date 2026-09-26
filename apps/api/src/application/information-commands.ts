import { createHash, randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { DecisionRow, InformationRootRow, RuleRow, RuleVersionRow }
  from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { toDecimalString } from '../shared/decimal.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { DomainError, invalidTransition, resourceNotFound, revisionConflict,
  validationFailed } from './domain-error.js';
import { requireRevision } from './revisions.js';
import type { Repositories } from './unit-of-work.js';
import { lockWritableProjectInWorkspace } from './guards.js';

type ScopeInput = { workspaceId: string; commandId: string };
type Result = { readonly knowledge_id?: string; readonly memory_id?: string;
  readonly decision_id?: string; readonly replacement_decision_id?: string;
  readonly rule_id?: string; readonly revision: string; readonly version?: string;
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
      return { knowledge_id: item.id, revision: toDecimalString(item.revision + 1n),
        version: toDecimalString(version), status: 'ACTIVE' };
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

export async function createRule(db: DbExecutor, input: ScopeInput & RuleBody & {
  scope: RuleRow['scope']; scopeId: string;
  /** 仅用于真实 PG barrier 测试。 */
  hooks?: { readonly afterAuthorityLock?: () => Promise<void> };
}) {
  const body = normalizedRule(input);
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
      return { [`${input.kind}_id`]: item.id, revision: toDecimalString(item.revision + 1n), status };
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
