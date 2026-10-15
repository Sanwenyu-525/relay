import { createHash } from 'node:crypto';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { toDecimalString } from '../shared/decimal.js';
/**
 * CheckPlan 的派生与冻结（docs/architecture/runtime-context.md 第 4 节、
 * contracts/03-verification-and-approval.md 第 3、7 节）。
 *
 * CheckPlan 由验收契约与注册 checker 映射确定，Worker 无写权：
 *   * 必需条件、严重度与 checker 身份全部来自冻结契约 + 内置 registry；
 *   * session 创建时冻结计划与摘要，之后改计划只能新建 session；
 *   * registry 只注册内置 checker，不下载插件、不执行用户表达式。
 */
export const VERIFIER_POLICY_VERSION = 'verifier-policy-v1';
/** method → 内置 checker；未注册的 method 不得静默降级为建议。 */
const METHOD_CHECKER = {
    HUMAN: { id: 'human-evidence-v1', version: '1' },
    MARKDOWN_STRUCTURE: { id: 'markdown-structure-v1', version: '1' },
    CITATION_EXISTS: { id: 'citation-exists-v1', version: '1' },
    SEMANTIC: { id: 'fake-semantic-v1', version: '1' },
};
/**
 * 从冻结契约的 criteria 构建 CheckPlan。
 *
 * severity 读取 target_spec.severity（HARD/RULE/PREFERENCE/SEMANTIC）；
 * 缺省：required → HARD，否则 PREFERENCE。PREFERENCE 不单独导致 FAIL。
 */
export function buildCheckPlan(input) {
    const entries = input.criteria.map((criterion) => {
        const checker = METHOD_CHECKER[criterion.method];
        if (checker === undefined) {
            throw new Error(`unregistered criterion method: ${criterion.method}`);
        }
        // Only an explicit override (e.g. a HARD SEMANTIC rule whose delegate path
        // verified the real checker is configured) may replace the method mapping.
        const checkerId = criterion.checkerId !== undefined &&
            isPlannedCheckerId(criterion.checkerId) ? criterion.checkerId : checker.id;
        return {
            criterionId: criterion.criterionId,
            statement: criterion.statement,
            required: criterion.required,
            method: criterion.method,
            severity: resolveSeverity(criterion),
            checkerId,
            checkerVersion: criterion.checkerId === undefined ? checker.version : '1',
            targetSpec: criterion.targetSpec,
        };
    });
    return {
        policyVersion: VERIFIER_POLICY_VERSION,
        workflowKey: input.workflowKey,
        workflowVersion: input.workflowVersion,
        entries,
    };
}
const PLANNED_CHECKER_IDS = ['markdown-structure-v1',
    'citation-exists-v1', 'fake-semantic-v1', 'semantic-model-v1', 'human-evidence-v1'];
function isPlannedCheckerId(value) {
    return PLANNED_CHECKER_IDS.includes(value);
}
function resolveSeverity(criterion) {
    const raw = criterion.targetSpec.severity;
    if (typeof raw === 'string') {
        if (raw === 'HARD' || raw === 'RULE' || raw === 'PREFERENCE' || raw === 'SEMANTIC') {
            return raw;
        }
        throw new Error(`invalid target_spec.severity "${raw}" for criterion ${criterion.criterionId}`);
    }
    return criterion.required ? 'HARD' : 'PREFERENCE';
}
/** 规范 JSON 编码后的 SHA-256；与契约/回执摘要算法一致。 */
export function checkPlanHash(plan) {
    return createHash('sha256').update(canonicalizeJson(planToJson(plan)), 'utf8').digest();
}
export function planToJson(plan) {
    const entries = plan.entries.map((entry) => ({
        criterion_id: entry.criterionId,
        statement: entry.statement,
        required: entry.required,
        method: entry.method,
        severity: entry.severity,
        checker_id: entry.checkerId,
        checker_version: entry.checkerVersion,
        target_spec: entry.targetSpec,
    }));
    return {
        policy_version: plan.policyVersion,
        workflow_key: plan.workflowKey,
        workflow_version: plan.workflowVersion,
        entries,
    };
}
export function planFromFrozenSnapshot(snapshot) {
    const workflow = asObject(snapshot.workflow);
    const workflowKey = typeof workflow?.key === 'string' ? workflow.key : '';
    const workflowVersion = typeof workflow?.version === 'string' ? workflow.version : '';
    if (workflowKey === '' || workflowVersion === '') {
        throw new Error('frozen contract snapshot is missing workflow identity');
    }
    const rawCriteria = snapshot.criteria;
    if (!Array.isArray(rawCriteria)) {
        throw new Error('frozen contract snapshot is missing criteria array');
    }
    const criteria = rawCriteria.map((item) => {
        const criterion = asObject(item);
        if (criterion === undefined) {
            throw new Error('frozen contract criterion is not an object');
        }
        const criterionId = criterion.criterion_id;
        const statement = criterion.statement;
        const method = criterion.method;
        if (typeof criterionId !== 'string' ||
            typeof statement !== 'string' ||
            typeof method !== 'string') {
            throw new Error('frozen contract criterion is missing required fields');
        }
        if (method !== 'HUMAN' &&
            method !== 'MARKDOWN_STRUCTURE' &&
            method !== 'CITATION_EXISTS' &&
            method !== 'SEMANTIC') {
            throw new Error(`frozen contract criterion has unsupported method: ${method}`);
        }
        const targetSpec = criterion.target_spec !== undefined && asObject(criterion.target_spec) !== undefined
            ? asObject(criterion.target_spec)
            : {};
        return {
            criterionId,
            statement,
            required: criterion.required === true,
            method,
            targetSpec,
            ...(typeof criterion.checker_id === 'string' ? { checkerId: criterion.checker_id } : {}),
        };
    });
    return { criteria, workflowKey, workflowVersion };
}
/** 完成绑定集合中的 acceptance_revision 展示口径（十进制字符串）。 */
export function acceptanceRevisionString(value) {
    return toDecimalString(value);
}
function asObject(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }
    return value;
}
