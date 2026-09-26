import { randomUUID } from 'node:crypto';

import type { AssistProposalRow, CriterionMethod } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { toDecimalString } from '../shared/decimal.js';
import { buildCheckPlan } from '../workflow/check-plan.js';
import { hasChecker } from '../workflow/checkers.js';
import { WORKFLOW_KEY, WORKFLOW_VERSION } from '../workflow/markdown-deliverable.js';
import { LOCAL_ACTOR_REF } from './actor.js';
import { requireDeclaredOutputs } from './declared-output-requirements.js';
import { executorConflict, invalidTransition, revisionConflict } from './domain-error.js';
import { lockTaskInWorkspace } from './guards.js';
import { loadRulePlanBasis } from './rule-plan-basis.js';
import type { Repositories } from './unit-of-work.js';

const METHODS: readonly string[] = ['HUMAN', 'MARKDOWN_STRUCTURE',
  'CITATION_EXISTS', 'SEMANTIC'];

function object(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject : null;
}

function outputChangeAllowed(kind: AssistProposalRow['kind'], prior: JsonObject,
  next: JsonObject): boolean {
  if (kind === 'VERIFICATION_PLAN_CHANGE') {
    return canonicalizeJson(prior) === canonicalizeJson(next);
  }
  const before = { ...prior };
  const after = { ...next };
  delete before.description;
  delete after.description;
  if (Object.keys(before).length === 0 && after.artifacts !== undefined) {
    if (canonicalizeJson(after.artifacts) !== canonicalizeJson(['MARKDOWN_DOCUMENT'])) {
      return false;
    }
    delete after.artifacts;
  }
  if (canonicalizeJson(before) !== canonicalizeJson(after)) return false;
  return next.description === undefined || typeof next.description === 'string' &&
    next.description.trim() !== '' && next.description.length <= 2_000;
}

export interface AcceptedTaskContractResult extends JsonObject {
  readonly task_id: string;
  readonly status: string;
  readonly revision: string;
  readonly previous_acceptance_revision: string;
  readonly acceptance_revision: string;
  readonly objective: string;
  readonly required_output_spec: JsonObject;
  readonly criteria: readonly JsonObject[];
  readonly added_criterion_ids: readonly string[];
  readonly proposal_id: string;
}

/** Task Owner effect called only after Assist has locked its immutable proposal. */
export async function applyTaskSkillContractChange(r: Repositories, input: {
  readonly workspaceId: string; readonly commandId: string;
  readonly proposal: AssistProposalRow;
  readonly expectedRevision: bigint; readonly expectedAcceptanceRevision: bigint;
}): Promise<AcceptedTaskContractResult> {
  const { proposal } = input;
  const task = await lockTaskInWorkspace(r, input.workspaceId, proposal.target_id);
  if (task.revision !== input.expectedRevision ||
      task.revision !== proposal.base_revision) {
    throw revisionConflict({ entityType: 'TASK',
      expectedRevision: toDecimalString(input.expectedRevision),
      actualRevision: toDecimalString(task.revision) });
  }
  if (task.acceptance_revision !== input.expectedAcceptanceRevision ||
      task.acceptance_revision !== proposal.base_acceptance_revision) {
    throw revisionConflict({ entityType: 'TASK_ACCEPTANCE',
      expectedRevision: toDecimalString(input.expectedAcceptanceRevision),
      actualRevision: toDecimalString(task.acceptance_revision) });
  }
  if (task.executor_kind !== 'HUMAN' || task.executor_run_id !== null ||
      !['INBOX', 'READY', 'IN_PROGRESS'].includes(task.status)) {
    throw executorConflict('当前 Task 不在可编辑的人工执行周期；请先安全收敛执行权。',
      { taskId: task.id });
  }
  if (await r.runs.findLiveRunForTask(task.id) !== undefined) {
    throw executorConflict('该 Task 仍有活动 Run，不能变更验收契约。', { taskId: task.id });
  }
  for (const run of await r.runs.listRunsByTask(task.id)) {
    if ((await r.gateway.listUnresolvedRunOperations(run.id)).length > 0) {
      throw executorConflict('该 Task 仍有未结算或 UNKNOWN 动作，不能变更验收契约。',
        { taskId: task.id });
    }
  }
  const prior = await r.tasks.readAcceptanceVersion(task.id, task.acceptance_revision);
  if (prior === undefined) throw invalidTransition('当前验收版本缺失。', { taskId: task.id });
  const oldCriteria = await r.tasks.listCriteria(task.id, task.acceptance_revision);
  const payload = proposal.payload;
  const objective = payload.objective;
  const outputs = object(payload.required_output_spec);
  const rawCriteria = payload.criteria;
  const addedIds = payload.added_criterion_ids;
  if (typeof objective !== 'string' || objective.trim() === '' ||
      objective.length > 2_000 || outputs === null ||
      !Array.isArray(rawCriteria) || rawCriteria.length < oldCriteria.length ||
      rawCriteria.length > 30 || !Array.isArray(addedIds) ||
      (proposal.kind === 'VERIFICATION_PLAN_CHANGE' && addedIds.length < 1) ||
      addedIds.length > 20 ||
      !outputChangeAllowed(proposal.kind, prior.required_output_spec, outputs)) {
    throw invalidTransition('Task Skill 提案的验收效果不满足当前契约。',
      { proposalId: proposal.id });
  }
  const criteria = rawCriteria.map(object);
  if (criteria.some((criterion) => criterion === null)) {
    throw invalidTransition('Task Skill 提案包含无效验收条件。', { proposalId: proposal.id });
  }
  const ids = new Set<string>();
  for (const criterion of criteria) {
    if (typeof criterion!.criterion_id !== 'string' ||
        !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(criterion!.criterion_id) ||
        ids.has(criterion!.criterion_id) ||
        typeof criterion!.statement !== 'string' || criterion!.statement.trim() === '' ||
        criterion!.statement.length > 500 ||
        typeof criterion!.required !== 'boolean' ||
        typeof criterion!.method !== 'string' || !METHODS.includes(criterion!.method) ||
        object(criterion!.target_spec) === null) {
      throw invalidTransition('Task Skill 提案包含无效验收条件。', { proposalId: proposal.id });
    }
    ids.add(criterion!.criterion_id);
  }
  for (const old of oldCriteria) {
    const preserved = criteria.find((criterion) => criterion!.criterion_id === old.criterion_id);
    if (preserved === undefined || preserved!.statement !== old.statement ||
        preserved!.required !== old.required || preserved!.method !== old.method ||
        canonicalizeJson(preserved!.target_spec as JsonObject) !==
          canonicalizeJson(old.target_spec)) {
      throw invalidTransition('Task Skill 提案不得删除或降级已确认的验收条件。',
        { proposalId: proposal.id });
    }
  }
  const actualAdded = criteria.filter((criterion) =>
    !oldCriteria.some((old) => old.criterion_id === criterion!.criterion_id))
    .map((criterion) => criterion!.criterion_id as string);
  if (canonicalizeJson(actualAdded) !== canonicalizeJson(addedIds as string[])) {
    throw invalidTransition('新增验收条件 ID 与提案不一致。', { proposalId: proposal.id });
  }
  const planned = buildCheckPlan({ workflowKey: WORKFLOW_KEY,
    workflowVersion: WORKFLOW_VERSION,
    criteria: criteria.map((criterion) => ({ criterionId: criterion!.criterion_id as string,
      statement: criterion!.statement as string, required: criterion!.required as boolean,
      method: criterion!.method as CriterionMethod,
      targetSpec: criterion!.target_spec as JsonObject })) });
  if (!planned.entries.every((entry) => hasChecker(entry.checkerId,
    entry.checkerVersion))) {
    throw invalidTransition('提案引用的检查器当前不可执行。', { proposalId: proposal.id });
  }
  requireDeclaredOutputs({ task, acceptanceRevision: task.acceptance_revision,
    requiredOutputSpec: outputs });
  // Rule admission is the same mapping used by Delegate; the caller holds
  // WorkspaceAuthority SHARE before the Task lock.
  await loadRulePlanBasis(r, input.workspaceId, task.project_id, task.id);

  const nextAcceptanceRevision = task.acceptance_revision + 1n;
  await r.tasks.insertAcceptanceVersion({ taskId: task.id,
    acceptanceRevision: nextAcceptanceRevision, objective: objective.trim(),
    requiredOutputSpec: outputs, source: 'CONTRACT_CHANGE' });
  for (const criterion of criteria) {
    await r.tasks.insertCriterion({ taskId: task.id,
      acceptanceRevision: nextAcceptanceRevision,
      criterionId: criterion!.criterion_id as string,
      statement: criterion!.statement as string,
      required: criterion!.required as boolean,
      method: criterion!.method as CriterionMethod,
      targetSpec: criterion!.target_spec as JsonObject });
  }
  const updated = await r.tasks.applyContractChangeRevision({ taskId: task.id,
    expectedRevision: task.revision,
    expectedAcceptanceRevision: task.acceptance_revision,
    nextAcceptanceRevision });
  if (updated === undefined) throw revisionConflict({ entityType: 'TASK',
    expectedRevision: toDecimalString(task.revision),
    actualRevision: toDecimalString(task.revision) });

  for (const session of await r.verifications.listSessionsByTaskCycle(task.id,
    task.acceptance_revision)) {
    await r.verifications.insertApplicabilityRevocation({ sessionId: session.id,
      reason: 'ACCEPTANCE_CONTRACT_CHANGED', sourceRef: `assist_proposal:${proposal.id}` });
  }
  for (const review of await r.reviews.listByWorkspace(input.workspaceId, 'OPEN')) {
    if (review.task_id === task.id) {
      await r.reviews.expireRequest(review.id, review.revision);
    }
  }
  await r.activities.insertActivityRecord({ id: randomUUID(),
    workspaceId: input.workspaceId, actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
    commandId: input.commandId, projectId: task.project_id, taskId: task.id,
    eventType: 'TASK_ACCEPTANCE_CHANGED', factRefs: {
      proposal_id: proposal.id, proposal_kind: proposal.kind,
      proposal_payload_sha256: proposal.payload_hash,
      skill_sha256: proposal.skill_sha256,
      previous_acceptance_revision: toDecimalString(task.acceptance_revision),
      acceptance_revision: toDecimalString(nextAcceptanceRevision),
      added_criterion_ids: actualAdded,
    } });
  return { task_id: updated.id, status: updated.status,
    revision: toDecimalString(updated.revision),
    previous_acceptance_revision: toDecimalString(task.acceptance_revision),
    acceptance_revision: toDecimalString(nextAcceptanceRevision),
    objective: objective.trim(), required_output_spec: outputs,
    criteria: criteria.map((criterion) => ({ criterion_id: criterion!.criterion_id as string,
      statement: criterion!.statement as string,
      required: criterion!.required as boolean,
      method: criterion!.method as string,
      target_spec: criterion!.target_spec as JsonObject })),
    added_criterion_ids: actualAdded, proposal_id: proposal.id };
}
