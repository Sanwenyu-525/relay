import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { buildCheckPlan, checkPlanHash, planToJson } from '../workflow/check-plan.js';
import { hasChecker } from '../workflow/checkers.js';
import { WORKFLOW_KEY, WORKFLOW_VERSION } from '../workflow/markdown-deliverable.js';
import { DomainError } from './domain-error.js';
import { checkDeclaredOutputs } from './declared-output-requirements.js';
import { readTaskInWorkspace } from './guards.js';
import { loadRulePlanBasis } from './rule-plan-basis.js';
import { createRepositories } from './unit-of-work.js';

/** Read-time admission preview. A Run's frozen plan and verification remain authoritative. */
export async function readTaskCheckPlanPreview(db: DbExecutor, input: {
  readonly workspaceId: string; readonly taskId: string;
}): Promise<JsonObject> {
  return db.transaction().setIsolationLevel('repeatable read').execute(async (snapshot) => {
    const r = createRepositories(snapshot);
    const task = await readTaskInWorkspace(r, input.workspaceId, input.taskId);
    const authority = await r.workspaces.readAuthority(input.workspaceId);
    const acceptance = await r.tasks.readAcceptanceVersion(task.id, task.acceptance_revision);
    if (authority === undefined || acceptance === undefined) {
      return unavailable(task.id, task.revision, task.acceptance_revision,
        authority?.rule_revision ?? null, ['CURRENT_CONTRACT_UNAVAILABLE']);
    }
    const reasons: string[] = [];
    if (task.project_id === null) reasons.push('PROJECT_SCOPE_REQUIRED_FOR_DELEGATE');
    if (task.status !== 'READY') reasons.push('TASK_NOT_READY_FOR_DELEGATE');
    if (task.executor_kind !== 'HUMAN' || task.executor_run_id !== null) {
      reasons.push('TASK_NOT_HUMAN_OWNED');
    }
    if (await r.runs.findLiveRunForTask(task.id) !== undefined) {
      reasons.push('ACTIVE_RUN');
    }
    const criteria = await r.tasks.listCriteria(task.id, task.acceptance_revision);
    try {
      const ruleBasis = await loadRulePlanBasis(r, input.workspaceId,
        task.project_id, task.id);
      const plan = buildCheckPlan({ workflowKey: WORKFLOW_KEY,
        workflowVersion: WORKFLOW_VERSION,
        criteria: [...criteria.map((criterion) => ({
          criterionId: criterion.criterion_id, statement: criterion.statement,
          required: criterion.required, method: criterion.method,
          targetSpec: criterion.target_spec })), ...ruleBasis.criteria] });
      if (!plan.entries.every((entry) => hasChecker(entry.checkerId,
        entry.checkerVersion))) reasons.push('CHECKER_UNAVAILABLE');
      if (checkDeclaredOutputs({ requiredOutputSpec: acceptance.required_output_spec })
        .status !== 'SATISFIED') {
        reasons.push('OUTPUT_CONTRACT_UNSUPPORTED');
      }
      if (reasons.includes('CHECKER_UNAVAILABLE')) {
        return unavailable(task.id, task.revision, task.acceptance_revision,
          authority.rule_revision, reasons);
      }
      return { task_id: task.id, status: 'AVAILABLE',
        admission_available: reasons.length === 0, reason_codes: reasons,
        sources: { task_revision: toDecimalString(task.revision),
          acceptance_revision: toDecimalString(task.acceptance_revision),
          rule_revision: toDecimalString(authority.rule_revision),
          workflow_key: WORKFLOW_KEY, workflow_version: WORKFLOW_VERSION,
          rule_refs: ruleBasis.allRules.map((rule) => ({ rule_id: rule.id,
            version: toDecimalString(rule.version) })) },
        check_plan: planToJson(plan),
        check_plan_sha256: checkPlanHash(plan).toString('hex'),
        frozen_run_plan: false, executed: false };
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return unavailable(task.id, task.revision, task.acceptance_revision,
        authority.rule_revision, [error.code]);
    }
  });
}

function unavailable(taskId: string, taskRevision: bigint,
  acceptanceRevision: bigint, ruleRevision: bigint | null,
  reasonCodes: readonly string[]): JsonObject {
  return { task_id: taskId, status: 'UNAVAILABLE', admission_available: false,
    reason_codes: reasonCodes,
    sources: { task_revision: toDecimalString(taskRevision),
      acceptance_revision: toDecimalString(acceptanceRevision),
      rule_revision: ruleRevision === null ? null : toDecimalString(ruleRevision),
      workflow_key: WORKFLOW_KEY, workflow_version: WORKFLOW_VERSION,
      rule_refs: [] },
    check_plan: null, check_plan_sha256: null,
    frozen_run_plan: false, executed: false };
}
