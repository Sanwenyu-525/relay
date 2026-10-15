import { createHash, randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { DecisionRow, InformationRootRow, KnowledgeVersionRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { DecisionPremiseRow, DecisionReviewRow } from '../information/decision-review-repository.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { httpCommandScopeKey, LOCAL_ACTOR_REF } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { lockWritableProjectInWorkspace, readProjectInWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { withTransaction, type Repositories } from './unit-of-work.js';

const same = (a: JsonObject, b: JsonObject) => canonicalizeJson(a) === canonicalizeJson(b);
async function knowledgeSnapshot(r: Repositories, id: string): Promise<JsonObject> {
  const root = await r.information.readRoot<InformationRootRow>('knowledge', id);
  if (root === undefined) return { knowledge_id: id, status: 'UNAVAILABLE' };
  const version = await r.information.readVersion<KnowledgeVersionRow>('knowledge', id, root.current_version);
  return { knowledge_id: id, version: root.current_version.toString(), version_id: version?.id ?? null,
    status: root.status, availability: version?.availability ?? 'UNAVAILABLE' };
}
async function sourceSnapshot(r: Repositories, premise: Pick<DecisionPremiseRow, 'knowledge_id' | 'hypothesis_id'>): Promise<JsonObject> {
  if (premise.knowledge_id !== null) return { kind: 'KNOWLEDGE', ...await knowledgeSnapshot(r, premise.knowledge_id) };
  const root = await r.hypotheses.read(premise.hypothesis_id!);
  if (root === undefined) return { kind: 'HYPOTHESIS', hypothesis_id: premise.hypothesis_id, status: 'UNAVAILABLE' };
  const version = (await r.hypotheses.versions(root.id)).find((v) => v.version === root.current_version)!;
  const observations = (await r.hypotheses.observations(root.id)).filter((o) => o.hypothesis_version === root.current_version);
  const ids = [...new Set([version.source_knowledge_version_id, ...observations.map((o) => o.knowledge_version_id)]
    .filter((id): id is string => id !== null))].sort();
  const sources: JsonObject[] = [];
  for (const id of ids) {
    const v = await r.information.readKnowledgeVersionById(id);
    sources.push({ reference_version_id: id, ...(v === undefined ? { status: 'UNAVAILABLE' } : await knowledgeSnapshot(r, v.knowledge_id)) });
  }
  const conclusion = (await r.hypotheses.conclusions(root.id)).find((c) => c.id === root.current_conclusion_id);
  const observationIds = observations.map((o) => o.id).sort();
  const conclusionApplicable = conclusion !== undefined && conclusion.hypothesis_version === root.current_version &&
    JSON.stringify(conclusion.observation_ids) === JSON.stringify(observationIds) &&
    sources.every((s) => s.status === 'ACTIVE' && s.availability === 'AVAILABLE' && s.reference_version_id === s.version_id);
  return { kind: 'HYPOTHESIS', hypothesis_id: root.id, version: root.current_version.toString(),
    observation_ids: observationIds, user_conclusion_id: root.current_conclusion_id,
    user_outcome: conclusion?.outcome ?? null, user_conclusion_applicable: conclusionApplicable, sources };
}
async function authority(r: Repositories, workspaceId: string, projectId: string) {
  if (await r.workspaces.lockAuthority(workspaceId, 'update') === undefined) throw resourceNotFound('Workspace');
  await lockWritableProjectInWorkspace(r, workspaceId, projectId);
}

export async function registerDecisionPremise(db: DbExecutor, input: {
  workspaceId: string; commandId: string; decisionId: string; expectedDecisionRevision: string;
  statement: string; confirmed: true; knowledgeVersionId?: string; hypothesisId?: string; expectedHypothesisRevision?: string;
}) {
  const statement = input.statement.trim();
  if (!statement || statement.length > 4000 || input.confirmed !== true ||
      (input.knowledgeVersionId === undefined) === (input.hypothesisId === undefined)) {
    throw validationFailed([{ field: 'premise', message: '需要明确前提说明和单个资料版本或假设来源。' }]);
  }
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'RegisterDecisionPremise', target: { decision_id: input.decisionId }, body: {
      expected_decision_revision: input.expectedDecisionRevision, statement, confirmed: input.confirmed,
      knowledge_version_id: input.knowledgeVersionId ?? null, hypothesis_id: input.hypothesisId ?? null,
      expected_hypothesis_revision: input.expectedHypothesisRevision ?? null }, execute: async (r) => {
      const located = await r.information.readRoot<DecisionRow>('decision', input.decisionId);
      if (located?.workspace_id !== input.workspaceId || located.project_id === null) throw resourceNotFound('Project Decision');
      await authority(r, input.workspaceId, located.project_id);
      const decision = (await r.information.readRoot<DecisionRow>('decision', located.id, true))!;
      if (decision.revision !== requireRevision(input.expectedDecisionRevision, 'expected_decision_revision')) {
        throw revisionConflict({ entityType: 'DECISION', expectedRevision: input.expectedDecisionRevision, actualRevision: decision.revision.toString() });
      }
      if (decision.status !== 'ACTIVE') throw invalidTransition('只为当前有效的决定登记前提。');
      let knowledgeId: string | null = null;
      if (input.knowledgeVersionId !== undefined) {
        const version = await r.information.readKnowledgeVersionById(input.knowledgeVersionId);
        const root = version === undefined ? undefined : await r.information.readRoot<InformationRootRow>('knowledge', version.knowledge_id);
        if (root?.workspace_id !== input.workspaceId || root.project_id !== decision.project_id) throw resourceNotFound('KnowledgeVersion');
        if (root.status !== 'ACTIVE' || version?.availability !== 'AVAILABLE' || version.version !== root.current_version) {
          throw invalidTransition('登记前提需要当前可读的确切资料版本。');
        }
        knowledgeId = root.id;
      } else {
        const hypothesis = await r.hypotheses.read(input.hypothesisId!);
        if (hypothesis?.workspace_id !== input.workspaceId || hypothesis.project_id !== decision.project_id) throw resourceNotFound('Hypothesis');
        if (input.expectedHypothesisRevision === undefined) throw validationFailed([{ field: 'expected_hypothesis_revision', message: '需要假设版本基准。' }]);
        if (hypothesis.revision !== requireRevision(input.expectedHypothesisRevision, 'expected_hypothesis_revision')) {
          throw revisionConflict({ entityType: 'HYPOTHESIS', expectedRevision: input.expectedHypothesisRevision, actualRevision: hypothesis.revision.toString() });
        }
      }
      const source = { knowledge_id: knowledgeId, hypothesis_id: input.hypothesisId ?? null };
      const premise = await r.decisionReviews.register({ id: randomUUID(), workspace_id: input.workspaceId,
        project_id: decision.project_id!, decision_id: decision.id, decision_revision: decision.revision,
        statement, ...source, baseline_ref: await sourceSnapshot(r, source) });
      await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
        actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId, projectId: premise.project_id,
        taskId: null, eventType: 'DECISION_PREMISE_REGISTERED', factRefs: { premise_id: premise.id, decision_id: decision.id } });
      return { premise_id: premise.id, decision_id: decision.id, project_id: premise.project_id, revision: premise.revision.toString() };
    } });
}

/** 只由已有来源写用例在原事务内调用，不读取外部来源或发模型请求。 */
export async function prepareDecisionReviews(r: Repositories, input: {
  workspaceId: string; commandId: string; knowledgeId?: string; hypothesisId?: string;
}) {
  let count = 0;
  for (const premise of await r.decisionReviews.related(input.workspaceId, input)) {
    const decision = await r.information.readRoot<DecisionRow>('decision', premise.decision_id);
    if (decision?.status !== 'ACTIVE' || decision.revision !== premise.decision_revision) continue;
    const after = await sourceSnapshot(r, premise);
    if (same(premise.baseline_ref, after)) continue;
    const fingerprint = createHash('sha256').update(canonicalizeJson({ decision_revision: decision.revision.toString(),
      premise_revision: premise.revision.toString(), after })).digest('hex');
    const candidate = await r.decisionReviews.prepare({ id: randomUUID(), premise_id: premise.id,
      decision_revision: decision.revision, premise_revision: premise.revision, fingerprint,
      before_ref: premise.baseline_ref, after_ref: after, cause_command_id: input.commandId });
    if (candidate === undefined) continue;
    count++;
    await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
      actorKind: 'SYSTEM', actorRef: 'decision-review', commandId: input.commandId, projectId: premise.project_id,
      taskId: null, eventType: 'DECISION_REVIEW_PREPARED', factRefs: { candidate_id: candidate.id, decision_id: premise.decision_id } });
  }
  return count.toString();
}
async function applicable(r: Repositories, candidate: DecisionReviewRow, premise: DecisionPremiseRow) {
  const decision = await r.information.readRoot<DecisionRow>('decision', premise.decision_id);
  return candidate.status === 'PENDING' && decision?.status === 'ACTIVE' && decision.revision === candidate.decision_revision &&
    premise.revision === candidate.premise_revision && same(premise.baseline_ref, candidate.before_ref) &&
    same(await sourceSnapshot(r, premise), candidate.after_ref);
}
export async function resolveDecisionReview(db: DbExecutor, input: {
  workspaceId: string; commandId: string; candidateId: string; expectedRevision: string;
  action: 'KEEP_DECISION' | 'DISMISS'; reason: string;
}) {
  const reason = input.reason.trim();
  if (!reason || reason.length > 4000) throw validationFailed([{ field: 'reason', message: '需要 1–4000 字的用户处理理由。' }]);
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'ResolveDecisionReview', target: { candidate_id: input.candidateId },
    body: { expected_revision: input.expectedRevision, action: input.action, reason }, execute: async (r) => {
      const located = await r.decisionReviews.read(input.candidateId);
      const p = located === undefined ? undefined : await r.decisionReviews.premise(located.premise_id);
      if (p?.workspace_id !== input.workspaceId) throw resourceNotFound('DecisionReview');
      await authority(r, input.workspaceId, p.project_id);
      const premise = (await r.decisionReviews.premise(p.id, true))!;
      const candidate = (await r.decisionReviews.read(input.candidateId, true))!;
      if (candidate.revision !== requireRevision(input.expectedRevision, 'expected_revision')) {
        throw revisionConflict({ entityType: 'DECISION_REVIEW', expectedRevision: input.expectedRevision, actualRevision: candidate.revision.toString() });
      }
      if (!(await applicable(r, candidate, premise))) throw invalidTransition('复审候选或其决定/前提/来源已变化，请按当前依据重新判断。');
      const updated = await r.decisionReviews.resolve(candidate.id, input.action === 'KEEP_DECISION' ? 'KEPT' : 'DISMISSED', reason);
      if (input.action === 'KEEP_DECISION') await r.decisionReviews.acceptBaseline(premise.id, candidate.after_ref);
      await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId, actorKind: 'HUMAN',
        actorRef: LOCAL_ACTOR_REF, commandId: input.commandId, projectId: premise.project_id, taskId: null,
        eventType: 'DECISION_REVIEW_RESOLVED', factRefs: { candidate_id: candidate.id, decision_id: premise.decision_id, status: updated.status } });
      return { candidate_id: updated.id, project_id: premise.project_id, status: updated.status, revision: updated.revision.toString() };
    } });
}
export async function listDecisionPremises(db: DbExecutor, workspaceId: string, decisionId: string) {
  return withTransaction(db, async (r) => {
    const decision = await r.information.readRoot<DecisionRow>('decision', decisionId);
    if (decision?.workspace_id !== workspaceId) throw resourceNotFound('Decision');
    return { decision_id: decisionId, items: (await r.decisionReviews.premises(workspaceId, decisionId)).map((p) => ({ ...p,
      revision: p.revision.toString(), decision_revision: p.decision_revision.toString(), created_at: p.created_at.toISOString() })) };
  });
}
export async function listDecisionReviews(db: DbExecutor, workspaceId: string, projectId: string) {
  return withTransaction(db, async (r) => {
    await readProjectInWorkspace(r, workspaceId, projectId);
    const items = [];
    for (const c of await r.decisionReviews.list(workspaceId, projectId)) {
      const premise = (await r.decisionReviews.premise(c.premise_id))!;
      const decision = await r.information.readRoot<DecisionRow>('decision', premise.decision_id);
      items.push({ ...c, revision: c.revision.toString(), decision_revision: c.decision_revision.toString(), premise_revision: c.premise_revision.toString(),
        decision_id: premise.decision_id, decision_title: decision?.title ?? null, statement: premise.statement,
        applicable: await applicable(r, c, premise), question: '请重新判断原决定是否仍成立。',
        created_at: c.created_at.toISOString(), resolved_at: c.resolved_at?.toISOString() ?? null });
    }
    return { project_id: projectId, pending_count: items.filter((item) => item.applicable).length, items };
  });
}
