import { createHash, randomUUID } from 'node:crypto';

import type {
  CheckResultRow,
  ReviewDecision,
  ReviewKind,
  RunRow,
  TaskRow,
  VerificationSessionRow,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { toDecimalString } from '../shared/decimal.js';
import type { Repositories } from './unit-of-work.js';
import type { Verdict } from '../workflow/verdict.js';

/** Review 的 target_hash 只覆盖规范化的精确授权对象，展示文案不进入授权身份。 */
export function reviewTargetHash(target: JsonObject): Buffer {
  return createHash('sha256').update(canonicalizeJson(target), 'utf8').digest();
}

interface RequestSpec {
  readonly kind: ReviewKind;
  readonly criterionId?: string;
  readonly reason: string;
  readonly target: JsonObject;
  readonly evidence: JsonObject;
  readonly effect: JsonObject;
  readonly allowedDecisions: readonly ReviewDecision[];
}

/** P06 HUMAN finalize 后同事务创建阻塞请求；每项人工判断绑定固定版本和原始检查证据。 */
export async function createVerificationReviews(
  repositories: Repositories,
  input: {
    readonly run: RunRow;
    readonly task: TaskRow;
    readonly session: VerificationSessionRow;
    readonly verdict: Verdict;
    readonly correctionBudget: bigint;
  },
): Promise<void> {
  const targets = await repositories.verifications.listTargets(input.session.id);
  const targetVersion = targets[0];

  if (targetVersion === undefined) {
    throw new Error('HUMAN session has no bound artifact target');
  }

  const commonTarget: JsonObject = {
    task_id: input.task.id,
    run_id: input.run.id,
    session_id: input.session.id,
    acceptance_revision: toDecimalString(input.session.acceptance_revision),
    artifact_version_id: targetVersion.artifact_version_id,
    content_hash: targetVersion.content_hash.toString('hex'),
    selection_binding: 'CURRENT',
  };
  const latest = await repositories.verifications.listLatestCheckResults(input.session.id);
  const byCriterion = new Map(latest.map((row) => [row.criterion_id, row]));
  const specs: RequestSpec[] = [];

  if (input.verdict.reason === 'CORRECTION_BUDGET_EXHAUSTED') {
    specs.push({
      kind: 'RETRY_BUDGET',
      reason: input.verdict.reason,
      target: commonTarget,
      evidence: { failing_criterion_ids: [...input.verdict.failingCriterionIds], used: toDecimalString(input.session.correction_budget_used), limit: toDecimalString(input.correctionBudget) },
      effect: { summary: '增加本 Run 的修正上限，并为同一候选的失败项安排新修正轮。', max_budget: '6' },
      allowedDecisions: ['SET_RETRY_BUDGET'],
    });
  } else if (input.verdict.reason === 'CHECKER_UNAVAILABLE') {
    specs.push({
      kind: 'CHECKER_RETRY',
      reason: input.verdict.reason,
      target: commonTarget,
      evidence: { checker_error_criterion_ids: latest.filter((row) => row.required && row.result === 'ERROR').map((row) => row.criterion_id) },
      effect: { summary: '对同一候选重新运行检查器；不生成新产物。' },
      allowedDecisions: ['RETRY_CHECKS'],
    });
  } else {
    const pending = new Set([...input.verdict.pendingHumanCriterionIds, ...input.verdict.uncertainCriterionIds]);
    for (const criterionId of pending) {
      const result = byCriterion.get(criterionId);
      if (result === undefined || !result.required) continue;
      specs.push({
        kind: 'CRITERION',
        criterionId,
        reason: result.result === 'NOT_RUN' ? 'AWAITING_HUMAN_EVIDENCE' : 'UNCERTAIN_REQUIRES_HUMAN',
        target: { ...commonTarget, criterion_id: criterionId },
        evidence: checkEvidence(result),
        effect: { summary: '仅判断该验收条件与此产物版本；接受后仍需满足其他必需条件。', correction_budget_used: toDecimalString(input.session.correction_budget_used), correction_budget_limit: toDecimalString(input.correctionBudget) },
        allowedDecisions: ['ACCEPT', 'REQUEST_CHANGES'],
      });
    }
  }

  for (const spec of specs) {
    const review = await repositories.reviews.insertRequest({
      id: randomUUID(),
      workspaceId: input.run.workspace_id,
      projectId: input.task.project_id,
      taskId: input.task.id,
      runId: input.run.id,
      verificationSessionId: input.session.id,
      criterionId: spec.criterionId ?? null,
      operationId: null,
      importJobId: null,
      kind: spec.kind,
      reason: spec.reason,
      targetHash: reviewTargetHash(spec.target),
      target: spec.target,
      evidence: spec.evidence,
      effect: spec.effect,
      allowedDecisions: spec.allowedDecisions,
      expiresAt: null,
    });
    await repositories.activities.insertActivityRecord({ id: randomUUID(),
      workspaceId: input.run.workspace_id, runId: input.run.id,
      actorKind: 'AI', actorRef: `run:${input.run.id}`, commandId: null,
      projectId: input.task.project_id, taskId: input.task.id,
      eventType: 'REVIEW_REQUESTED', factRefs: { review_id: review.id,
        run_id: input.run.id, verification_session_id: input.session.id, kind: review.kind } });
  }
}

function checkEvidence(row: CheckResultRow): JsonObject {
  return {
    criterion_id: row.criterion_id,
    result: row.result,
    checker_id: row.checker_id,
    checker_version: row.checker_version,
    severity: row.severity,
    required: row.required,
    evidence_refs: row.evidence_refs,
  };
}
