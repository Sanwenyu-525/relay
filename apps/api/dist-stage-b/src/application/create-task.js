import { randomUUID } from 'node:crypto';
import { toDecimalString } from '../shared/decimal.js';
import { MAX_JSON_SPEC_CHARS, TEXT_LIMITS, checkRequiredText, normalizeText, } from '../shared/text.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { capabilityDisabled, validationFailed } from './domain-error.js';
import { lockWritableProjectInWorkspace, requireWorkspace } from './guards.js';
const CRITERION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const MAX_CRITERIA = 20;
/** 命令入口校验与规范化；与回执摘要使用同一结果。 */
export function prepareTaskCreation(input) {
    const problems = [];
    const titleProblem = checkRequiredText(input.title, 'title', 'title');
    const objectiveProblem = checkRequiredText(input.objective, 'objective', 'objective');
    if (titleProblem !== undefined) {
        problems.push(titleProblem);
    }
    if (objectiveProblem !== undefined) {
        problems.push(objectiveProblem);
    }
    const mode = requireTaskMode(input.mode);
    const specProblem = checkJsonSpec(input.expectedOutputs, 'expected_outputs');
    if (specProblem !== undefined) {
        problems.push(specProblem);
    }
    const criteria = normalizeCriteria(input.criteria, problems);
    if (problems.length > 0) {
        throw validationFailed(problems);
    }
    return {
        workspaceId: input.workspaceId,
        commandId: input.commandId,
        projectId: input.projectId,
        title: normalizeText(input.title),
        objective: normalizeText(input.objective),
        criteria,
        expectedOutputs: input.expectedOutputs,
        mode,
        acceptanceRevision: 1n,
    };
}
/** 事务内的业务效果；提案接受等协调方在已持有锁的事务里直接复用。 */
export async function applyTaskCreation(repositories, prepared) {
    await requireWorkspace(repositories, prepared.workspaceId);
    if (prepared.projectId !== null) {
        await lockWritableProjectInWorkspace(repositories, prepared.workspaceId, prepared.projectId);
    }
    const taskId = randomUUID();
    const goalAlignmentMode = 'INHERIT';
    // 插入顺序：先 Task（当前验收指针由延迟外键在提交时校验），再验收版本与 criteria。
    const task = await repositories.tasks.insertTask({
        id: taskId,
        workspaceId: prepared.workspaceId,
        projectId: prepared.projectId,
        title: prepared.title,
        status: 'INBOX',
        mode: prepared.mode,
        acceptanceRevision: prepared.acceptanceRevision,
        executorKind: 'HUMAN',
        ownershipEpoch: 0n,
        currentCompletionId: null,
    });
    await repositories.tasks.insertAcceptanceVersion({
        taskId: task.id,
        acceptanceRevision: prepared.acceptanceRevision,
        objective: prepared.objective,
        requiredOutputSpec: prepared.expectedOutputs,
        source: 'CREATE',
    });
    for (const criterion of prepared.criteria) {
        await repositories.tasks.insertCriterion({
            taskId: task.id,
            acceptanceRevision: prepared.acceptanceRevision,
            criterionId: criterion.criterionId,
            statement: criterion.statement,
            required: criterion.required,
            method: criterion.method,
            targetSpec: criterion.targetSpec,
        });
    }
    await repositories.activities.insertActivityRecord({
        id: randomUUID(),
        workspaceId: task.workspace_id,
        actorKind: 'HUMAN',
        actorRef: LOCAL_ACTOR_REF,
        commandId: prepared.commandId,
        projectId: prepared.projectId,
        taskId: task.id,
        eventType: 'TASK_CREATED',
        factRefs: {
            task_id: task.id,
            status: task.status,
            mode: task.mode,
            acceptance_revision: toDecimalString(prepared.acceptanceRevision),
            goal_alignment_mode: goalAlignmentMode,
        },
    });
    return {
        task_id: task.id,
        project_id: task.project_id,
        status: task.status,
        mode: task.mode,
        revision: toDecimalString(task.revision),
        acceptance_revision: toDecimalString(task.acceptance_revision),
    };
}
export async function createTask(db, input) {
    const prepared = prepareTaskCreation(input);
    const goalAlignmentMode = 'INHERIT';
    return runIdempotentCommand(db, {
        scopeKey: httpCommandScopeKey(input.workspaceId),
        commandId: input.commandId,
        commandType: 'CreateTask',
        target: { workspace_id: input.workspaceId },
        body: {
            project_id: input.projectId,
            title: prepared.title,
            objective: prepared.objective,
            mode: prepared.mode,
            expected_outputs: input.expectedOutputs,
            criteria: prepared.criteria.map((criterion) => ({
                criterion_id: criterion.criterionId,
                statement: criterion.statement,
                required: criterion.required,
                method: criterion.method,
                target_spec: criterion.targetSpec,
            })),
        },
        execute: async (repositories) => applyTaskCreation(repositories, prepared),
    });
}
function requireTaskMode(value) {
    if (value === 'DELEGATE_AI') {
        throw capabilityDisabled('mode', 'Delegate 能力在本阶段未开放：DELEGATE_AI 只能由 Delegate 用例设置。');
    }
    if (value !== 'ME' && value !== 'AI_ASSIST') {
        throw validationFailed([{ field: 'mode', message: 'must be ME or AI_ASSIST' }]);
    }
    return value;
}
function normalizeCriteria(criteria, problems) {
    if (criteria.length > MAX_CRITERIA) {
        problems.push({
            field: 'criteria',
            message: `must contain at most ${MAX_CRITERIA} items`,
        });
        return [];
    }
    const normalized = [];
    const seen = new Set();
    criteria.forEach((criterion, index) => {
        const field = `criteria[${index}]`;
        const statementProblem = checkRequiredText(criterion.statement, `${field}.statement`, 'criterionStatement');
        const method = criterion.method ?? 'HUMAN';
        if (statementProblem !== undefined) {
            problems.push(statementProblem);
        }
        if (method !== 'HUMAN' &&
            method !== 'MARKDOWN_STRUCTURE' &&
            method !== 'CITATION_EXISTS' &&
            method !== 'SEMANTIC') {
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
            method: method === 'MARKDOWN_STRUCTURE' || method === 'CITATION_EXISTS' || method === 'SEMANTIC'
                ? method
                : 'HUMAN',
            targetSpec,
        });
    });
    return normalized;
}
/** 受约束参数快照必须有界：不接受把大对象塞进命令体（物理设计第 1 节：限制由入口验证）。 */
export function checkJsonSpec(value, field) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { field, message: 'must be a JSON object' };
    }
    if (JSON.stringify(value).length > MAX_JSON_SPEC_CHARS) {
        return { field, message: `must be at most ${MAX_JSON_SPEC_CHARS} characters when serialized` };
    }
    return undefined;
}
