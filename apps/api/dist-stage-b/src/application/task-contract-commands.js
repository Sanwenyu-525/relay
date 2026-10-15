import { randomUUID } from 'node:crypto';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { toDecimalString } from '../shared/decimal.js';
import { checkRequiredText, normalizeText, TEXT_LIMITS } from '../shared/text.js';
import { buildCheckPlan } from '../workflow/check-plan.js';
import { hasChecker } from '../workflow/checkers.js';
import { WORKFLOW_KEY, WORKFLOW_VERSION } from '../workflow/markdown-deliverable.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { checkJsonSpec } from './create-task.js';
import { requireDeclaredOutputs } from './declared-output-requirements.js';
import { executorConflict, invalidTransition, revisionConflict, validationFailed, } from './domain-error.js';
import { lockTaskInWorkspace } from './guards.js';
import { loadRulePlanBasis } from './rule-plan-basis.js';
import { requireRevision } from './revisions.js';
const METHODS = ['HUMAN', 'MARKDOWN_STRUCTURE',
    'CITATION_EXISTS', 'SEMANTIC'];
function object(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value : null;
}
function outputChangeAllowed(kind, prior, next) {
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
    if (canonicalizeJson(before) !== canonicalizeJson(after))
        return false;
    return next.description === undefined || typeof next.description === 'string' &&
        next.description.trim() !== '' && next.description.length <= 2_000;
}
/** Task Owner effect called only after Assist has locked its immutable proposal. */
export async function applyTaskSkillContractChange(r, input) {
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
        throw executorConflict('当前 Task 不在可编辑的人工执行周期；请先安全收敛执行权。', { taskId: task.id });
    }
    if (await r.runs.findLiveRunForTask(task.id) !== undefined) {
        throw executorConflict('该 Task 仍有活动 Run，不能变更验收契约。', { taskId: task.id });
    }
    for (const run of await r.runs.listRunsByTask(task.id)) {
        if ((await r.gateway.listUnresolvedRunOperations(run.id)).length > 0) {
            throw executorConflict('该 Task 仍有未结算或 UNKNOWN 动作，不能变更验收契约。', { taskId: task.id });
        }
    }
    const prior = await r.tasks.readAcceptanceVersion(task.id, task.acceptance_revision);
    if (prior === undefined)
        throw invalidTransition('当前验收版本缺失。', { taskId: task.id });
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
        throw invalidTransition('Task Skill 提案的验收效果不满足当前契约。', { proposalId: proposal.id });
    }
    const criteria = rawCriteria.map(object);
    if (criteria.some((criterion) => criterion === null)) {
        throw invalidTransition('Task Skill 提案包含无效验收条件。', { proposalId: proposal.id });
    }
    const ids = new Set();
    for (const criterion of criteria) {
        if (typeof criterion.criterion_id !== 'string' ||
            !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(criterion.criterion_id) ||
            ids.has(criterion.criterion_id) ||
            typeof criterion.statement !== 'string' || criterion.statement.trim() === '' ||
            criterion.statement.length > 500 ||
            typeof criterion.required !== 'boolean' ||
            typeof criterion.method !== 'string' || !METHODS.includes(criterion.method) ||
            object(criterion.target_spec) === null) {
            throw invalidTransition('Task Skill 提案包含无效验收条件。', { proposalId: proposal.id });
        }
        ids.add(criterion.criterion_id);
    }
    for (const old of oldCriteria) {
        const preserved = criteria.find((criterion) => criterion.criterion_id === old.criterion_id);
        if (preserved === undefined || preserved.statement !== old.statement ||
            preserved.required !== old.required || preserved.method !== old.method ||
            canonicalizeJson(preserved.target_spec) !==
                canonicalizeJson(old.target_spec)) {
            throw invalidTransition('Task Skill 提案不得删除或降级已确认的验收条件。', { proposalId: proposal.id });
        }
    }
    const actualAdded = criteria.filter((criterion) => !oldCriteria.some((old) => old.criterion_id === criterion.criterion_id))
        .map((criterion) => criterion.criterion_id);
    if (canonicalizeJson(actualAdded) !== canonicalizeJson(addedIds)) {
        throw invalidTransition('新增验收条件 ID 与提案不一致。', { proposalId: proposal.id });
    }
    const planned = buildCheckPlan({ workflowKey: WORKFLOW_KEY,
        workflowVersion: WORKFLOW_VERSION,
        criteria: criteria.map((criterion) => ({ criterionId: criterion.criterion_id,
            statement: criterion.statement, required: criterion.required,
            method: criterion.method,
            targetSpec: criterion.target_spec })) });
    if (!planned.entries.every((entry) => hasChecker(entry.checkerId, entry.checkerVersion))) {
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
            criterionId: criterion.criterion_id,
            statement: criterion.statement,
            required: criterion.required,
            method: criterion.method,
            targetSpec: criterion.target_spec });
    }
    const updated = await r.tasks.applyContractChangeRevision({ taskId: task.id,
        expectedRevision: task.revision,
        expectedAcceptanceRevision: task.acceptance_revision,
        nextAcceptanceRevision });
    if (updated === undefined)
        throw revisionConflict({ entityType: 'TASK',
            expectedRevision: toDecimalString(task.revision),
            actualRevision: toDecimalString(task.revision) });
    for (const session of await r.verifications.listSessionsByTaskCycle(task.id, task.acceptance_revision)) {
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
        criteria: criteria.map((criterion) => ({ criterion_id: criterion.criterion_id,
            statement: criterion.statement,
            required: criterion.required,
            method: criterion.method,
            target_spec: criterion.target_spec })),
        added_criterion_ids: actualAdded, proposal_id: proposal.id };
}
/* --------------------------------------------------------------------------- */
/* 人工补验收条件：ReviseTaskAcceptance                                            */
/* --------------------------------------------------------------------------- */
const CRITERION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
/** 上限与 Task Skill 提案一致；CreateTask 的 20 条上限属于创建入口的另一项产品限制。 */
const MAX_REVISED_CRITERIA = 30;
/** 只有人工执行周期可以修订验收契约：AI 占有执行权或终态 Task 都要先收敛执行权。 */
const EDITABLE_ACCEPTANCE_STATUSES = ['INBOX', 'READY', 'IN_PROGRESS'];
/**
 * 入口校验与规范化。回执摘要与入库内容都用这一份结果，
 * 因此同 command_id 的等价请求得到同一摘要（重放返回原结果），异载荷被拒绝。
 */
export function prepareTaskAcceptanceRevision(input) {
    const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
    const expectedAcceptanceRevision = requireRevision(input.expectedAcceptanceRevision, 'expected_acceptance_revision');
    const problems = [];
    let objective;
    if (input.objective !== undefined) {
        const objectiveProblem = checkRequiredText(input.objective, 'objective', 'objective');
        if (objectiveProblem !== undefined) {
            problems.push(objectiveProblem);
        }
        else {
            objective = normalizeText(input.objective);
        }
    }
    const criteria = normalizeRevisedCriteria(input.criteria, problems);
    if (problems.length > 0) {
        throw validationFailed(problems);
    }
    return {
        expectedRevision,
        expectedAcceptanceRevision,
        objective,
        criteria,
        body: {
            expected_revision: toDecimalString(expectedRevision),
            expected_acceptance_revision: toDecimalString(expectedAcceptanceRevision),
            ...(objective === undefined ? {} : { objective }),
            criteria: criteria.map((criterion) => ({
                criterion_id: criterion.criterionId,
                statement: criterion.statement,
                required: criterion.required,
                method: criterion.method,
                target_spec: criterion.targetSpec,
            })),
        },
    };
}
/**
 * 新验收版本的规划判定（纯函数，不读写存储）。
 *
 * 规则：
 *   * 目标与必需产物不是本入口的放宽对象——objective 可改写，required_output_spec 逐字节沿用；
 *   * 当前版本里的**必需** criterion 必须原样出现在新版本，不得删除、改写或降级为可选；
 *     当前版本的**可选** criterion 可以改写、加严或丢弃（它从来不是完成依据）；
 *   * 新版本至少保留一条必需 criterion：MarkTaskReady 也要求这一点，
 *     在写入时拒绝可以让补条件这个动作一次成功，而不是紧接着被 ready 的 409 顶回来；
 *   * 每条 criterion 的检查器当前可执行，否则这个版本注定无法完成。
 */
export function planTaskAcceptanceRevision(input) {
    const downgraded = [];
    for (const prior of input.currentCriteria) {
        if (!prior.required)
            continue;
        const next = input.criteria.find((criterion) => criterion.criterionId === prior.criterion_id);
        if (next === undefined || !next.required || next.statement !== prior.statement ||
            next.method !== prior.method ||
            canonicalizeJson(next.targetSpec) !== canonicalizeJson(prior.target_spec)) {
            downgraded.push(prior.criterion_id);
        }
    }
    if (downgraded.length > 0) {
        throw invalidTransition('当前验收版本的必需验收条件不能被删除、改写或降级；需要先重开 Task 再修订新周期。', {
            taskId: input.taskId,
            acceptanceRevision: toDecimalString(input.currentAcceptanceRevision),
            criterionIds: downgraded.sort(),
        });
    }
    if (!input.criteria.some((criterion) => criterion.required)) {
        throw validationFailed([
            { field: 'criteria', message: 'must contain one or more required criteria' },
        ]);
    }
    const plan = buildCheckPlan({
        workflowKey: WORKFLOW_KEY,
        workflowVersion: WORKFLOW_VERSION,
        criteria: input.criteria.map((criterion) => ({
            criterionId: criterion.criterionId,
            statement: criterion.statement,
            required: criterion.required,
            method: criterion.method,
            targetSpec: criterion.targetSpec,
        })),
    });
    if (!plan.entries.every((entry) => hasChecker(entry.checkerId, entry.checkerVersion))) {
        throw invalidTransition('人工提交的验收条件引用了当前不可执行的检查器。', { taskId: input.taskId, acceptanceRevision: toDecimalString(input.currentAcceptanceRevision) });
    }
    const currentIds = new Set(input.currentCriteria.map((criterion) => criterion.criterion_id));
    const addedCriterionIds = input.criteria
        .filter((criterion) => !currentIds.has(criterion.criterionId))
        .map((criterion) => criterion.criterionId);
    return {
        nextAcceptanceRevision: input.currentAcceptanceRevision + 1n,
        objective: input.objective ?? input.currentObjective,
        requiredOutputSpec: input.requiredOutputSpec,
        criteria: input.criteria,
        addedCriterionIds,
        requiredCriterionCount: input.criteria.filter((criterion) => criterion.required).length,
    };
}
/** 审计事实：两个验收版本号都要留痕，否则事后无法判断旧结论绑定的是哪一份契约。 */
export function acceptanceRevisionFactRefs(input) {
    return {
        change_source: 'HUMAN_COMMAND',
        previous_acceptance_revision: toDecimalString(input.previousAcceptanceRevision),
        acceptance_revision: toDecimalString(input.acceptanceRevision),
        added_criterion_ids: [...input.addedCriterionIds],
        criteria_count: input.criteriaCount,
        required_criteria_count: input.requiredCriterionCount,
    };
}
/**
 * ReviseTaskAcceptance：人工在 Task 创建之后补写或收紧验收条件。
 *
 * 这是补验收条件的公开入口（轻量起步的零 criterion Task 只能靠它进入 READY）。
 * 写入面与 Task Skill 的验收变更同一条路径：新增不可变验收版本 + criteria，
 * 再用 Task revision 与 acceptance_revision 双 CAS 推进当前指针；历史版本不原地改写。
 *
 * 与 Task Skill 路径的差别（有意为之）：
 *   * 不调用 loadRulePlanBasis。Rule 的准入在 Delegate 冻结时判定，
 *     让人工补条件被无关的 Rule/模型端口配置挡住没有收益；
 *   * 只拒绝削弱必需 criterion，不禁止任何改写——人工是验收契约的责任人。
 */
export async function reviseTaskAcceptance(db, input) {
    const prepared = prepareTaskAcceptanceRevision(input);
    return runIdempotentCommand(db, {
        scopeKey: httpCommandScopeKey(input.workspaceId),
        commandId: input.commandId,
        commandType: 'ReviseTaskAcceptance',
        target: { task_id: input.taskId },
        body: prepared.body,
        execute: async (repositories) => {
            const task = await lockTaskInWorkspace(repositories, input.workspaceId, input.taskId);
            if (task.revision !== prepared.expectedRevision) {
                throw revisionConflict({
                    entityType: 'TASK',
                    expectedRevision: toDecimalString(prepared.expectedRevision),
                    actualRevision: toDecimalString(task.revision),
                });
            }
            if (task.acceptance_revision !== prepared.expectedAcceptanceRevision) {
                throw revisionConflict({
                    entityType: 'TASK_ACCEPTANCE',
                    expectedRevision: toDecimalString(prepared.expectedAcceptanceRevision),
                    actualRevision: toDecimalString(task.acceptance_revision),
                });
            }
            if (task.executor_kind !== 'HUMAN' || task.executor_run_id !== null ||
                !EDITABLE_ACCEPTANCE_STATUSES.includes(task.status)) {
                throw executorConflict('当前 Task 不在可编辑的人工执行周期；请先安全收敛执行权或重开。', { taskId: task.id });
            }
            if (await repositories.runs.findLiveRunForTask(task.id) !== undefined) {
                throw executorConflict('该 Task 仍有活动 Run，不能变更验收契约。', { taskId: task.id });
            }
            for (const run of await repositories.runs.listRunsByTask(task.id)) {
                if ((await repositories.gateway.listUnresolvedRunOperations(run.id)).length > 0) {
                    throw executorConflict('该 Task 仍有未结算或 UNKNOWN 动作，不能变更验收契约。', { taskId: task.id });
                }
            }
            const current = await repositories.tasks.readAcceptanceVersion(task.id, task.acceptance_revision);
            if (current === undefined) {
                throw invalidTransition('当前验收版本缺失。', { taskId: task.id });
            }
            const plan = planTaskAcceptanceRevision({
                taskId: task.id,
                currentAcceptanceRevision: task.acceptance_revision,
                currentObjective: current.objective,
                requiredOutputSpec: current.required_output_spec,
                currentCriteria: await repositories.tasks.listCriteria(task.id, task.acceptance_revision),
                objective: prepared.objective,
                criteria: prepared.criteria,
            });
            await repositories.tasks.insertAcceptanceVersion({
                taskId: task.id,
                acceptanceRevision: plan.nextAcceptanceRevision,
                objective: plan.objective,
                requiredOutputSpec: plan.requiredOutputSpec,
                // CONTRACT_CHANGE：本入口与 Task Skill 走同一条「契约变更」来源，
                // 来源差异由审计事实 change_source 区分，不需要新的 source 枚举值。
                source: 'CONTRACT_CHANGE',
            });
            for (const criterion of plan.criteria) {
                await repositories.tasks.insertCriterion({
                    taskId: task.id,
                    acceptanceRevision: plan.nextAcceptanceRevision,
                    criterionId: criterion.criterionId,
                    statement: criterion.statement,
                    required: criterion.required,
                    method: criterion.method,
                    targetSpec: criterion.targetSpec,
                });
            }
            const updated = await repositories.tasks.applyContractChangeRevision({
                taskId: task.id,
                expectedRevision: task.revision,
                expectedAcceptanceRevision: task.acceptance_revision,
                nextAcceptanceRevision: plan.nextAcceptanceRevision,
            });
            if (updated === undefined) {
                // 持锁后仍不匹配，只可能是 SQL 侧的执行权/状态条件（executor_kind、executor_run_id、
                // status）在本事务内不再成立——那是执行权冲突，不是版本冲突：如实按执行权报告，
                // 并带上当前验收版本供调用方刷新。
                throw executorConflict('验收契约的原子写入未生效：Task 的执行权或状态已不在可修订的人工周期。', { taskId: task.id, acceptanceRevision: toDecimalString(task.acceptance_revision) });
            }
            // 旧验收周期上的验证结论与待处理 Review 不得被静默沿用（契约 03 第 5 节）：
            // 撤销适用性并让 Review 过期，历史结论本身保留。
            for (const session of await repositories.verifications.listSessionsByTaskCycle(task.id, task.acceptance_revision)) {
                await repositories.verifications.insertApplicabilityRevocation({
                    sessionId: session.id,
                    reason: 'ACCEPTANCE_CONTRACT_CHANGED',
                    sourceRef: `task_acceptance_revision:${toDecimalString(plan.nextAcceptanceRevision)}`,
                });
            }
            for (const review of await repositories.reviews.listByWorkspace(input.workspaceId, 'OPEN')) {
                if (review.task_id === task.id) {
                    await repositories.reviews.expireRequest(review.id, review.revision);
                }
            }
            await repositories.activities.insertActivityRecord({
                id: randomUUID(),
                workspaceId: task.workspace_id,
                actorKind: 'HUMAN',
                actorRef: LOCAL_ACTOR_REF,
                commandId: input.commandId,
                projectId: task.project_id,
                taskId: task.id,
                eventType: 'TASK_ACCEPTANCE_CHANGED',
                factRefs: acceptanceRevisionFactRefs({
                    previousAcceptanceRevision: task.acceptance_revision,
                    acceptanceRevision: plan.nextAcceptanceRevision,
                    addedCriterionIds: plan.addedCriterionIds,
                    criteriaCount: plan.criteria.length,
                    requiredCriterionCount: plan.requiredCriterionCount,
                }),
            });
            return {
                task_id: updated.id,
                status: updated.status,
                revision: toDecimalString(updated.revision),
                previous_acceptance_revision: toDecimalString(task.acceptance_revision),
                acceptance_revision: toDecimalString(plan.nextAcceptanceRevision),
                objective: plan.objective,
                required_output_spec: plan.requiredOutputSpec,
                criteria: plan.criteria.map((criterion) => ({
                    criterion_id: criterion.criterionId,
                    statement: criterion.statement,
                    required: criterion.required,
                    method: criterion.method,
                    target_spec: criterion.targetSpec,
                })),
                added_criterion_ids: plan.addedCriterionIds,
            };
        },
    });
}
function normalizeRevisedCriteria(criteria, problems) {
    if (criteria.length < 1 || criteria.length > MAX_REVISED_CRITERIA) {
        problems.push({
            field: 'criteria',
            message: `must contain between 1 and ${MAX_REVISED_CRITERIA} items`,
        });
        return [];
    }
    const normalized = [];
    const seen = new Set();
    criteria.forEach((criterion, index) => {
        const field = `criteria[${index}]`;
        const statementProblem = checkRequiredText(criterion.statement, `${field}.statement`, 'criterionStatement');
        if (statementProblem !== undefined) {
            problems.push(statementProblem);
        }
        const method = criterion.method ?? 'HUMAN';
        if (!METHODS.includes(method)) {
            problems.push({
                field: `${field}.method`,
                message: 'must be one of HUMAN, MARKDOWN_STRUCTURE, CITATION_EXISTS, SEMANTIC',
            });
        }
        const criterionId = criterion.criterionId ?? `c${index + 1}`;
        if (!CRITERION_ID_PATTERN.test(criterionId)) {
            problems.push({
                field: `${field}.criterion_id`,
                message: `must match ${CRITERION_ID_PATTERN.source} and be at most ${TEXT_LIMITS.criterionId} characters`,
            });
        }
        else if (seen.has(criterionId)) {
            problems.push({
                field: `${field}.criterion_id`,
                message: 'must be unique within the acceptance revision',
            });
        }
        else {
            seen.add(criterionId);
        }
        const targetSpec = criterion.targetSpec ?? {};
        const specProblem = checkJsonSpec(targetSpec, `${field}.target_spec`);
        if (specProblem !== undefined) {
            problems.push(specProblem);
        }
        normalized.push({
            criterionId,
            statement: normalizeText(criterion.statement),
            required: criterion.required ?? true,
            // 上面的校验已把取值限定为四个合法值；这里显式收窄类型，非法取值会随 problems 在上层被丢弃。
            method: method === 'MARKDOWN_STRUCTURE' || method === 'CITATION_EXISTS' ||
                method === 'SEMANTIC' ? method : 'HUMAN',
            targetSpec,
        });
    });
    return normalized;
}
