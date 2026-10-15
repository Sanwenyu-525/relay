import { toDecimalString } from '../shared/decimal.js';
import { buildCheckPlan } from '../workflow/check-plan.js';
import { hasChecker } from '../workflow/checkers.js';
import { readModelPortConfig } from '../workflow/model-port-config.js';
import { WORKFLOW_KEY, WORKFLOW_VERSION } from '../workflow/markdown-deliverable.js';
import { resolveApplicableRules, ruleEnforcementUnavailable } from './information-commands.js';
/** Shared Rule mapping for Delegate freeze and the read-time admission preview. */
export async function loadRulePlanBasis(r, workspaceId, projectId, taskId) {
    const allRules = projectId === null ? [] :
        await r.information.listApplicableRules(workspaceId, projectId, taskId);
    const applicable = resolveApplicableRules(allRules);
    const criteria = [];
    for (const rule of applicable) {
        if (rule.enforcement === 'PRE_ACTION') {
            if (rule.strength === 'HARD') {
                throw ruleEnforcementUnavailable(`Rule ${rule.id} 要求 PRE_ACTION，但固定 Workflow 尚无准入前检查器。`);
            }
            continue;
        }
        if (rule.enforcement === 'SEMANTIC' && rule.strength === 'HARD' &&
            readModelPortConfig(process.env) === undefined) {
            throw ruleEnforcementUnavailable(`Rule ${rule.id} 要求 HARD 语义检查；未配置真实模型端口。`);
        }
        const method = rule.enforcement === 'HUMAN' ? 'HUMAN' :
            rule.enforcement === 'SEMANTIC' ? 'SEMANTIC' : rule.method;
        if (method === null)
            throw ruleEnforcementUnavailable(`Rule ${rule.id} 缺少可用检查器。`);
        criteria.push({ criterionId: `rule:${rule.id}:v${rule.version}`,
            statement: rule.statement, required: rule.strength === 'HARD', method,
            targetSpec: { ...rule.target_spec, severity: rule.strength,
                rule_id: rule.id, rule_version: toDecimalString(rule.version) },
            ...(rule.enforcement === 'SEMANTIC' && rule.strength === 'HARD'
                ? { checkerId: 'semantic-model-v1' } : {}) });
    }
    const rulePlan = buildCheckPlan({ workflowKey: WORKFLOW_KEY,
        workflowVersion: WORKFLOW_VERSION, criteria });
    for (const entry of rulePlan.entries) {
        if (!hasChecker(entry.checkerId, entry.checkerVersion)) {
            throw ruleEnforcementUnavailable(`Rule 检查器 ${entry.checkerId} 未注册。`);
        }
    }
    return { allRules, criteria };
}
