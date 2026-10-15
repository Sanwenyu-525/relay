import { CommandIdReusedError } from '../application/command.js';
import { DomainError } from '../application/domain-error.js';
import { ProblemError, internalError, problemBody } from './problem.js';
/** 除 Create* 之外，契约第 3 节显式要求 201 的命令（新版本是新建资源）。 */
const CREATED_COMMAND_TYPES = ['SubmitHumanArtifactVersion'];
export function successStatusOf(commandType) {
    // Delegate 已原子获得执行权，但工作尚未完成：按契约第 4 节返回 202（已接受）。
    // Assist 生成同为异步工作：202 表示消息已排队，回复以消息状态查询为准。
    if (commandType === 'StartArtifactImpactCheck' ||
        commandType === 'StartArtifactImpactCandidate' ||
        commandType === 'DelegateTask' || commandType === 'RequestRunControl' ||
        commandType === 'ResumeRun' || commandType === 'RequestAssistMessage' ||
        commandType === 'InterpretConversationMessage') {
        return 202;
    }
    return commandType.startsWith('Create') || CREATED_COMMAND_TYPES.includes(commandType)
        ? 201
        : 200;
}
/** 命令回执的资源链接目标（由 command_type 与结果推导，GET 回执与首次响应一致）。 */
export function resourcePathOf(commandType, result) {
    switch (commandType) {
        case 'CreateProject':
        case 'LinkProjectGoal':
        case 'UnlinkProjectGoal':
        case 'ArchiveProject':
            return typeof result.project_id === 'string' ? `projects/${result.project_id}` : undefined;
        case 'SetProjectState':
            return typeof result.project_id === 'string'
                ? `projects/${result.project_id}/state`
                : undefined;
        case 'CreateGoal':
            return typeof result.goal_id === 'string' ? `goals/${result.goal_id}` : undefined;
        case 'CreateArtifactWithVersion':
        case 'SubmitHumanArtifactVersion':
            return typeof result.artifact_id === 'string' ? `artifacts/${result.artifact_id}` : undefined;
        case 'DelegateTask':
        case 'RequestRunControl':
        case 'ResumeRun':
            return typeof result.run_id === 'string' ? `runs/${result.run_id}` : undefined;
        case 'ResolveReview':
            return typeof result.review_id === 'string' ? `reviews/${result.review_id}` : undefined;
        case 'CreateGatewayConnection':
        case 'DisableGatewayConnection':
            return typeof result.project_id === 'string' && typeof result.connection_id === 'string'
                ? `projects/${result.project_id}/connections/${result.connection_id}` : undefined;
        case 'CreateGatewayPolicy':
        case 'AddGatewayPolicyVersion':
        case 'RevokeGatewayPolicy':
            return typeof result.project_id === 'string' && typeof result.policy_id === 'string'
                ? `projects/${result.project_id}/permission-policies/${result.policy_id}` : undefined;
        case 'CreateManagedResource':
        case 'DisableManagedResource':
            return typeof result.project_id === 'string' && typeof result.resource_id === 'string'
                ? `projects/${result.project_id}/managed-resources/${result.resource_id}` : undefined;
        case 'CreateWebImportJob':
            return typeof result.project_id === 'string' && typeof result.import_job_id === 'string'
                ? `projects/${result.project_id}/import-jobs/${result.import_job_id}` : undefined;
        case 'CreateKnowledge':
        case 'AddKnowledgeVersion':
        case 'ArchiveKnowledge':
            return typeof result.knowledge_id === 'string' ? `knowledge/${result.knowledge_id}` : undefined;
        case 'CreateMemory':
        case 'AddMemoryRevision':
        case 'RetireMemory':
            return typeof result.memory_id === 'string' ? `memories/${result.memory_id}` : undefined;
        case 'CreateDecision':
        case 'SupersedeDecision':
            return typeof result.decision_id === 'string' ? `decisions/${result.decision_id}` : undefined;
        case 'CreateRule':
        case 'AddRuleVersion':
        case 'RetireRule':
            return typeof result.rule_id === 'string' ? `rules/${result.rule_id}` : undefined;
        case 'CreateTask':
        case 'EditTaskPresentation':
        case 'SetTaskPlanningMetadata':
        case 'MarkTaskReady':
        case 'StartHumanTask':
        case 'CancelTask':
        case 'SetTaskGoalAlignment':
        case 'ReviseTaskAcceptance':
        case 'AddTaskDependency':
        case 'RemoveTaskDependency':
        case 'CompleteHumanTask':
        case 'ReopenTask':
            return typeof result.task_id === 'string' ? `tasks/${result.task_id}` : undefined;
        case 'SetTaskSelection':
        case 'SetFocusSelection':
            return 'today';
        case 'CreateAssistSession':
            return typeof result.session_id === 'string' ? `assist-sessions/${result.session_id}` : undefined;
        case 'BindAssistSessionProject':
            return typeof result.session_id === 'string' ? `assist-sessions/${result.session_id}` : undefined;
        case 'CreateProjectBlueprintProposal':
        case 'ApplyProjectBlueprint':
        case 'RejectProjectBlueprint':
            return typeof result.project_id === 'string' &&
                typeof (result.id ?? result.proposal_id) === 'string'
                ? `projects/${result.project_id}/blueprint-proposals/${result.id ?? result.proposal_id}`
                : undefined;
        case 'CreateProjectContinuationPoint':
            return typeof result.project_id === 'string' && typeof result.id === 'string'
                ? `projects/${result.project_id}/continuation-points/${result.id}`
                : undefined;
        case 'SaveProjectKnowledgeGuide':
            return typeof result.project_id === 'string'
                ? `projects/${result.project_id}/knowledge-guide`
                : undefined;
        case 'CreateImpactCandidateGroup':
            return typeof result.group_id === 'string'
                ? `impact-candidate-groups/${result.group_id}`
                : undefined;
        case 'CreateArtifactCombinationCheck':
            return typeof result.combination_check_id === 'string'
                ? `combination-checks/${result.combination_check_id}`
                : undefined;
        case 'RequestAssistMessage':
            return typeof result.session_id === 'string' ? `assist-sessions/${result.session_id}` : undefined;
        case 'AcceptAssistProposal':
        case 'RejectAssistProposal':
            return typeof result.proposal_id === 'string' ? `assist-proposals/${result.proposal_id}` : undefined;
        case 'OpenWorkingDirectory': {
            const association = result.association;
            return typeof association === 'object' && association !== null &&
                typeof association.project_id === 'string' &&
                typeof association.resource_id === 'string'
                ? `projects/${association.project_id}/managed-resources/${association.resource_id}`
                : undefined;
        }
        case 'InterpretConversationMessage':
            return typeof result.request_id === 'string'
                ? `conversation-execution-requests/${result.request_id}` : undefined;
        default:
            return undefined;
    }
}
export function buildCommandEnvelope(input) {
    const resource = resourcePathOf(input.commandType, input.result);
    return {
        command_id: input.commandId,
        committed_at: input.committedAt.toISOString(),
        result: input.result,
        links: { resource: `/api/v1/workspaces/${input.workspaceId}/${resource ?? ''}` },
    };
}
/** 领域错误 → RFC 9457 Problem Details。未识别的错误统一为 INTERNAL_ERROR，不泄漏堆栈/SQL。 */
export function problemFromError(error, commandId) {
    if (error instanceof DomainError) {
        return {
            type: error.type,
            title: error.title,
            status: error.status,
            detail: error.detail,
            code: error.code,
            retryable: error.retryable,
            retryAction: error.retryAction,
            ...(error.fieldErrors.length === 0 ? {} : { fieldErrors: error.fieldErrors }),
            ...(commandId === undefined ? {} : { commandId }),
            ...(error.conflict === undefined ? {} : { conflict: error.conflict }),
        };
    }
    if (error instanceof CommandIdReusedError) {
        return {
            type: '/problems/command-id-reused',
            title: 'command_id 已被不同内容使用',
            status: 409,
            detail: '同一 command_id 在同一作用域下已提交过不同内容；修正内容必须换 command_id。',
            code: 'COMMAND_ID_REUSED',
            retryable: false,
            retryAction: 'NONE',
            fieldErrors: [{ field: 'command_id', message: '已被使用，必须为修正后的内容换新 ID' }],
            ...(commandId === undefined ? {} : { commandId }),
        };
    }
    return internalError();
}
export function sendProblem(reply, problem, requestId) {
    return reply
        .code(problem.status)
        .type('application/problem+json')
        .send(problemBody(problem, requestId));
}
/**
 * 所有写命令共用的处理流程：执行用例 → 成功回执（含重放头）或映射后的 Problem Details。
 * 幂等与回执由应用用例负责；这里只负责 HTTP 表达，不重复业务校验。
 */
export function createCommandHandler(dependencies, options) {
    return async (request, reply) => {
        const body = request.body;
        const params = (request.params ?? {});
        try {
            const { outcome, result } = await options.execute({
                dependencies,
                executor: dependencies.database.executor,
                request,
                body,
                params,
            });
            if (outcome.replayed) {
                reply.header('command-replayed', 'true');
            }
            return reply.code(options.commandType === 'CancelTask' && 'control_request_id' in result ? 202 : successStatusOf(options.commandType)).send(buildCommandEnvelope({
                workspaceId: params.workspace_id ?? '',
                commandId: body.command_id,
                commandType: options.commandType,
                committedAt: outcome.committedAt,
                result,
            }));
        }
        catch (error) {
            if (error instanceof ProblemError) {
                return sendProblem(reply, error.problem, request.id);
            }
            if (!(error instanceof DomainError) && !(error instanceof CommandIdReusedError)) {
                request.log.error({ err: error }, 'command_failed');
            }
            return sendProblem(reply, problemFromError(error, body.command_id), request.id);
        }
    };
}
/** 读取端点的错误映射：同样是 Problem Details，不带 command_id。 */
export function sendReadError(reply, error, requestId) {
    if (error instanceof ProblemError) {
        return sendProblem(reply, error.problem, requestId);
    }
    return sendProblem(reply, problemFromError(error), requestId);
}
