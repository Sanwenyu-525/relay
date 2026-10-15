import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { InformationRootRow } from '../infrastructure/database-schema.js';
import type { HypothesisConclusionRow, HypothesisObservationRow, HypothesisRow } from '../hypothesis/hypothesis-repository.js';
import { httpCommandScopeKey, LOCAL_ACTOR_REF } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { lockWritableProjectInWorkspace, readProjectInWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { withTransaction, type Repositories } from './unit-of-work.js';
import { prepareDecisionReviews } from './decision-reviews.js';

type Scope = { workspaceId: string; commandId: string };
type Mutation = Scope & { hypothesisId: string; expectedRevision: string };
export interface HypothesisDefinition { claim: string; method: string; criterion: string; sourceKnowledgeVersionId?: string }
function text(value: string, field: string, max = 4000) {
  if (!value.trim() || value.length > max) throw validationFailed([{ field, message: `需要 1–${max} 字。` }]);
  return value.trim();
}
function result(row: HypothesisRow) {
  return { hypothesis_id: row.id, project_id: row.project_id, revision: row.revision.toString(), version: row.current_version.toString() };
}
async function authority(r: Repositories, workspaceId: string, projectId: string) {
  if (await r.workspaces.lockAuthority(workspaceId, 'update') === undefined) throw resourceNotFound('Workspace');
  await lockWritableProjectInWorkspace(r, workspaceId, projectId);
}
async function locked(r: Repositories, input: Mutation) {
  const located = await r.hypotheses.read(input.hypothesisId);
  if (located?.workspace_id !== input.workspaceId) throw resourceNotFound('Hypothesis');
  await authority(r, input.workspaceId, located.project_id);
  const row = (await r.hypotheses.read(located.id, true))!;
  if (row.revision !== requireRevision(input.expectedRevision, 'expected_revision')) {
    throw revisionConflict({ entityType: 'HYPOTHESIS', expectedRevision: input.expectedRevision, actualRevision: row.revision.toString() });
  }
  return row;
}
async function sourceStatus(r: Repositories, workspaceId: string, projectId: string, id: string | null) {
  if (id === null) return 'NONE' as const;
  const version = await r.information.readKnowledgeVersionById(id);
  const root = version === undefined ? undefined : await r.information.readRoot<InformationRootRow>('knowledge', version.knowledge_id);
  if (root?.workspace_id !== workspaceId || root.project_id !== projectId || root.status !== 'ACTIVE' ||
      version?.availability !== 'AVAILABLE') return 'UNAVAILABLE' as const;
  return version.version === root.current_version ? 'CURRENT' as const : 'STALE' as const;
}
async function requireSource(r: Repositories, workspaceId: string, projectId: string, id: string | null) {
  if (await sourceStatus(r, workspaceId, projectId, id) === 'UNAVAILABLE') throw resourceNotFound('KnowledgeVersion');
}
async function audit(r: Repositories, input: Scope, row: HypothesisRow, event: string) {
  await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
    actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId, projectId: row.project_id,
    taskId: null, eventType: event, factRefs: result(row) });
}

export async function createHypothesis(db: DbExecutor, input: Scope & HypothesisDefinition & {
  projectId: string; title: string; confirmed: true; sourceMessageId?: string;
}) {
  const fields = { title: text(input.title, 'title', 200), claim: text(input.claim, 'claim'), method: text(input.method, 'method'),
    criterion: text(input.criterion, 'criterion'), source_knowledge_version_id: input.sourceKnowledgeVersionId ?? null };
  if (input.confirmed !== true) throw invalidTransition('假设建档需要明确用户请求。');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'CreateHypothesis', target: { project_id: input.projectId }, body: { ...fields, confirmed: true,
      ...(input.sourceMessageId === undefined ? {} : { source_message_id: input.sourceMessageId }) }, execute: async (r) => {
      await authority(r, input.workspaceId, input.projectId);
      await requireSource(r, input.workspaceId, input.projectId, fields.source_knowledge_version_id);
      if (input.sourceMessageId !== undefined) {
        const message = await r.assist.readMessage(input.sourceMessageId);
        const session = message === undefined ? undefined : await r.assist.readSession(message.session_id);
        if (message?.role !== 'USER' || message.status !== 'COMPLETED' || session?.workspace_id !== input.workspaceId ||
            session.project_id !== input.projectId || session.conversation_mode !== 'AGENT') {
          throw invalidTransition('假设建档来源必须是同项目普通会话的原用户消息。');
        }
      }
      const row = await r.hypotheses.create(randomUUID(), input.workspaceId, input.projectId, fields.title);
      await r.hypotheses.addVersion({ id: randomUUID(), hypothesis_id: row.id, version: 1n,
        claim: fields.claim, method: fields.method, criterion: fields.criterion,
        source_knowledge_version_id: fields.source_knowledge_version_id, source_message_id: input.sourceMessageId ?? null });
      await audit(r, input, row, 'HYPOTHESIS_CREATED');
      return result(row);
    } });
}
export async function versionHypothesis(db: DbExecutor, input: Mutation & HypothesisDefinition) {
  const fields = { claim: text(input.claim, 'claim'), method: text(input.method, 'method'), criterion: text(input.criterion, 'criterion'),
    source_knowledge_version_id: input.sourceKnowledgeVersionId ?? null };
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'VersionHypothesis', target: { hypothesis_id: input.hypothesisId },
    body: { expected_revision: input.expectedRevision, ...fields }, execute: async (r) => {
      const row = await locked(r, input);
      await requireSource(r, input.workspaceId, row.project_id, fields.source_knowledge_version_id);
      await r.hypotheses.addVersion({ id: randomUUID(), hypothesis_id: row.id, version: row.current_version + 1n,
        ...fields, source_message_id: null });
      const updated = await r.hypotheses.advance({ ...row, current_version: row.current_version + 1n });
      await audit(r, input, updated, 'HYPOTHESIS_VERSIONED');
      const count = await prepareDecisionReviews(r, { workspaceId: input.workspaceId, commandId: input.commandId, hypothesisId: row.id });
      return { ...result(updated), ...(count === '0' ? {} : { decision_review_count: count,
        decision_review_candidates_ref: `projects/${row.project_id}/decision-reviews` }) };
    } });
}
export async function observeHypothesis(db: DbExecutor, input: Mutation & { summary: string; knowledgeVersionId?: string }) {
  const summary = text(input.summary, 'summary');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'ObserveHypothesis', target: { hypothesis_id: input.hypothesisId },
    body: { expected_revision: input.expectedRevision, summary, knowledge_version_id: input.knowledgeVersionId ?? null }, execute: async (r) => {
      const row = await locked(r, input);
      await requireSource(r, input.workspaceId, row.project_id, input.knowledgeVersionId ?? null);
      await r.hypotheses.observe({ id: randomUUID(), hypothesis_id: row.id, hypothesis_version: row.current_version,
        summary, knowledge_version_id: input.knowledgeVersionId ?? null });
      const updated = await r.hypotheses.advance(row);
      await audit(r, input, updated, 'HYPOTHESIS_OBSERVED');
      const count = await prepareDecisionReviews(r, { workspaceId: input.workspaceId, commandId: input.commandId, hypothesisId: row.id });
      return { ...result(updated), ...(count === '0' ? {} : { decision_review_count: count,
        decision_review_candidates_ref: `projects/${row.project_id}/decision-reviews` }) };
    } });
}
export function hypothesisSuggestion(outcome: HypothesisConclusionRow['outcome'], sufficient: boolean, reliable: boolean, count: number) {
  if (!sufficient || !reliable || count === 0) return { outcome: 'INCONCLUSIVE' as const, recommendation: 'COLLECT_MORE_EVIDENCE' as const };
  return { outcome, recommendation: outcome === 'NOT_SUPPORTED' ? 'STOP_NEXT_STAGE' as const :
    outcome === 'INCONCLUSIVE' ? 'COLLECT_MORE_EVIDENCE' as const : 'CONTINUE_DISCUSSION' as const };
}
const idsOf = (observations: readonly HypothesisObservationRow[], version: bigint) =>
  observations.filter((o) => o.hypothesis_version === version).map((o) => o.id).sort();
const sameIds = (a: readonly string[], b: readonly string[]) => JSON.stringify(a) === JSON.stringify(b);

export async function suggestHypothesisConclusion(db: DbExecutor, input: Mutation & {
  outcome: HypothesisConclusionRow['outcome']; rationale: string; evidenceSufficient: boolean; methodReliable: boolean;
}) {
  const rationale = text(input.rationale, 'rationale');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'SuggestHypothesisConclusion', target: { hypothesis_id: input.hypothesisId }, body: {
      expected_revision: input.expectedRevision, outcome: input.outcome, rationale,
      evidence_sufficient: input.evidenceSufficient, method_reliable: input.methodReliable }, execute: async (r) => {
      const row = await locked(r, input);
      const observations = await r.hypotheses.observations(row.id);
      const ids = idsOf(observations, row.current_version);
      const suggestion = hypothesisSuggestion(input.outcome, input.evidenceSufficient &&
        await currentSources(r, row, observations), input.methodReliable, ids.length);
      const suggestionId = randomUUID();
      await r.hypotheses.conclude({ id: suggestionId, hypothesis_id: row.id, hypothesis_version: row.current_version,
        kind: 'SUGGESTION', outcome: suggestion.outcome, rationale, evidence_sufficient: input.evidenceSufficient,
        method_reliable: input.methodReliable, observation_ids: ids, suggestion_id: null });
      const updated = await r.hypotheses.advance(row);
      await audit(r, input, updated, 'HYPOTHESIS_CONCLUSION_SUGGESTED');
      return { ...result(updated), suggestion_id: suggestionId, ...suggestion };
    } });
}
async function currentSources(r: Repositories, row: HypothesisRow, observations: readonly HypothesisObservationRow[]) {
  const version = (await r.hypotheses.versions(row.id)).find((v) => v.version === row.current_version)!;
  const sources = [version.source_knowledge_version_id, ...observations.filter((o) => o.hypothesis_version === row.current_version)
    .map((o) => o.knowledge_version_id)];
  for (const id of sources) {
    const status = await sourceStatus(r, row.workspace_id, row.project_id, id);
    if (status === 'STALE' || status === 'UNAVAILABLE') return false;
  }
  return true;
}
export async function confirmHypothesisConclusion(db: DbExecutor, input: Mutation & { suggestionId: string; confirmed: true }) {
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'ConfirmHypothesisConclusion', target: { hypothesis_id: input.hypothesisId }, body: {
      expected_revision: input.expectedRevision, suggestion_id: input.suggestionId, confirmed: input.confirmed }, execute: async (r) => {
      const row = await locked(r, input);
      const suggestion = (await r.hypotheses.conclusions(row.id)).find((c) => c.id === input.suggestionId && c.kind === 'SUGGESTION');
      if (suggestion === undefined) throw resourceNotFound('HypothesisSuggestion');
      const observations = await r.hypotheses.observations(row.id);
      if (input.confirmed !== true || suggestion.hypothesis_version !== row.current_version ||
          !sameIds(suggestion.observation_ids, idsOf(observations, row.current_version)) || !(await currentSources(r, row, observations))) {
        throw invalidTransition('建议依据已变化或未明确确认，请按当前定义和观察重新判断。');
      }
      const conclusionId = randomUUID();
      await r.hypotheses.conclude({ ...suggestion, id: conclusionId, kind: 'USER_CONFIRMED', suggestion_id: suggestion.id });
      const updated = await r.hypotheses.advance({ ...row, current_conclusion_id: conclusionId });
      await audit(r, input, updated, 'HYPOTHESIS_CONCLUSION_CONFIRMED');
      const count = await prepareDecisionReviews(r, { workspaceId: input.workspaceId, commandId: input.commandId, hypothesisId: row.id });
      return { ...result(updated), conclusion_id: conclusionId, outcome: suggestion.outcome,
        ...(count === '0' ? {} : { decision_review_count: count, decision_review_candidates_ref: `projects/${row.project_id}/decision-reviews` }) };
    } });
}

async function projection(r: Repositories, row: HypothesisRow) {
  const versions = [];
  for (const v of await r.hypotheses.versions(row.id)) versions.push({ ...v, version: v.version.toString(),
    created_at: v.created_at.toISOString(), source_status: await sourceStatus(r, row.workspace_id, row.project_id, v.source_knowledge_version_id) });
  const observations = await r.hypotheses.observations(row.id);
  const currentIds = idsOf(observations, row.current_version);
  const sourcesCurrent = await currentSources(r, row, observations);
  const observed = [];
  for (const o of observations) observed.push({ ...o, hypothesis_version: o.hypothesis_version.toString(), created_at: o.created_at.toISOString(),
    evidence_kind: o.knowledge_version_id === null ? 'USER_REPORTED' : 'UNVERIFIED_REFERENCE',
    source_status: await sourceStatus(r, row.workspace_id, row.project_id, o.knowledge_version_id) });
  const conclusions = (await r.hypotheses.conclusions(row.id)).map((c) => ({ ...c,
    hypothesis_version: c.hypothesis_version.toString(), created_at: c.created_at.toISOString(),
    applicable: c.hypothesis_version === row.current_version && sameIds(c.observation_ids, currentIds) && sourcesCurrent,
    recommendation: hypothesisSuggestion(c.outcome, c.evidence_sufficient, c.method_reliable, c.observation_ids.length).recommendation }));
  return { ...result(row), title: row.title, created_at: row.created_at.toISOString(), versions, observations: observed, conclusions,
    current_user_conclusion: conclusions.find((c) => c.id === row.current_conclusion_id) ?? null };
}
export async function readHypothesis(db: DbExecutor, workspaceId: string, id: string) {
  return withTransaction(db, async (r) => {
    const row = await r.hypotheses.read(id);
    if (row?.workspace_id !== workspaceId) throw resourceNotFound('Hypothesis');
    return projection(r, row);
  });
}
export async function listHypotheses(db: DbExecutor, workspaceId: string, projectId: string) {
  return withTransaction(db, async (r) => {
    await readProjectInWorkspace(r, workspaceId, projectId);
    const items = [];
    for (const row of await r.hypotheses.list(workspaceId, projectId)) items.push(await projection(r, row));
    return { project_id: projectId, items };
  });
}
