import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import { isPostgresError, POSTGRES_ERROR_CODES } from '../infrastructure/postgres-error.js';
import { toDecimalString } from '../shared/decimal.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import {
  capabilityDisabled,
  executorConflict,
  invalidTransition,
  resourceNotFound,
  revisionConflict,
} from './domain-error.js';
import { lockTaskInWorkspace } from './guards.js';
import { requireDeclaredOutputs } from './declared-output-requirements.js';
import { requireRevision } from './revisions.js';
import { loadTaskReadiness } from './task-readiness.js';
import type { Repositories } from './unit-of-work.js';
import {
  BUILT_IN_EXECUTION_CONFIG_VERSION_ID,
  BUILT_IN_WORKFLOW_VERSION_ID,
  WORKFLOW_KEY,
  WORKFLOW_VERSION,
  WORKFLOW_STEPS,
} from '../workflow/markdown-deliverable.js';
import { freezeExecutionContract, readContextSources } from '../workflow/execution-contract.js';
import type { ContextSourceRef } from '../workflow/execution-contract.js';
import { loadRulePlanBasis } from './rule-plan-basis.js';

/**
 * DelegateTask：把一个 READY 的人工 Task 原子地交给一个新建的 AI Run
 * （contracts/02-state-and-execution.md 第 3、4 节；docs/api/http-command-contract.md 第 4 节）。
 *
 * 关键不变量：
 *   * 一个 Task 至多一个未释放的 AI 执行权占有者（B01）：Task 行锁 + assignExecutionToRun 的
 *     CAS + uq_run_live_task 三重保护，并发 Delegate 恰好一个成功；
 *   * 创建 Run 时冻结执行契约，BUILD_CONTEXT 之后只装配、不重写快照；
 *   * 授予执行权即 HUMAN → AI(run_id) 且 ownership_epoch +1；
 *   * 终态不复活：手动再试创建新 Run 并引用原终态 Run（B06）。
 */

export type DelegateTaskResult = {
  readonly run_id: string;
  readonly task_id: string;
  readonly task_revision: string;
  readonly run_revision: string;
  readonly status: string;
  readonly retry_of_run_id: string | null;
};

export interface DelegateTaskInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly commandId: string;
  readonly expectedTaskRevision: string;
  readonly retryOfRunId?: string | null;
  readonly workflowVersionId?: string | null;
  readonly executionConfigVersionId?: string | null;
  readonly mockGatewayAction?: {
    readonly connection_id: string; readonly resource_id: string;
    readonly target: string; readonly content: string;
  } | undefined;
  /** 用户显式选中的长期信息来源；随 Run 冻结，版本不可变。 */
  readonly contextSources?: readonly ContextSourceRef[] | undefined;
  /** 可选固定 Mock 文件读意图；与 mockGatewayAction、webFetchAction 互斥。 */
  readonly fileReadAction?: {
    readonly connection_id: string; readonly resource_id: string; readonly relative_target: string;
  } | undefined;
  /** 可选固定 Mock 网页读意图；与 mockGatewayAction、fileReadAction 互斥。 */
  readonly webFetchAction?: {
    readonly connection_id: string; readonly url: string;
  } | undefined;
  /** 仅用于真实 PG barrier 测试；不属于 HTTP 请求或命令摘要。 */
  readonly hooks?: {
    readonly afterAuthorityLock?: () => Promise<void>;
    readonly afterDispatchInsert?: () => Promise<void>;
  };
}

const TERMINAL_RUN_STATUSES: readonly string[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export async function delegateTask(
  db: DbExecutor,
  input: DelegateTaskInput,
): Promise<CommandOutcome<DelegateTaskResult>> {
  const expectedTaskRevision = requireRevision(
    input.expectedTaskRevision,
    'expected_task_revision',
  );
  const retryOfRunId = input.retryOfRunId ?? null;
  const workflowVersionId = input.workflowVersionId ?? null;
  const executionConfigVersionId = input.executionConfigVersionId ?? null;

  // 版本选择器与内置固定 Workflow 的比对在事务外完成：本阶段没有 ExecutionConfiguration 表。
  requireBuiltInWorkflowVersion(workflowVersionId);
  requireBuiltInExecutionConfigVersion(executionConfigVersionId);

  return runIdempotentCommand<DelegateTaskResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'DelegateTask',
    target: { task_id: input.taskId },
    body: {
      expected_task_revision: toDecimalString(expectedTaskRevision),
      retry_of_run_id: retryOfRunId,
      workflow_version_id: workflowVersionId,
      execution_config_version_id: executionConfigVersionId,
      mock_gateway_action: input.mockGatewayAction ?? null,
      context_sources: input.contextSources === undefined ? null :
        input.contextSources.map((source) => ({ kind: source.kind,
          root_id: source.root_id, version: source.version })),
      file_read_action: input.fileReadAction ?? null,
      web_fetch_action: input.webFetchAction ?? null,
    },
    execute: async (repositories) => {
      // Rule 更新持 authority UPDATE；Delegate 持 SHARE 后再锁 Task，两个提交顺序有唯一裁决。
      const authority = await repositories.workspaces.lockAuthority(input.workspaceId, 'share');
      if (authority === undefined) throw resourceNotFound('Workspace authority');
      await input.hooks?.afterAuthorityLock?.();
      const task = await lockTaskInWorkspace(repositories, input.workspaceId, input.taskId);

      requireRevisionMatch(task, expectedTaskRevision);

      if (task.status !== 'READY') {
        throw invalidTransition(
          `只有 READY 的 Task 可以被 Delegate（当前为 ${task.status}）。`,
          { taskId: task.id },
        );
      }

      if (task.executor_kind !== 'HUMAN') {
        throw executorConflict('该 Task 已被其他执行者占有，不能再次 Delegate。', {
          taskId: task.id,
        });
      }

      if (task.project_id === null) {
        throw invalidTransition(
          '无 Project 的 Me Inbox 事项只能由人工处理，不能被 Delegate（缺少执行作用域）。',
          { taskId: task.id },
        );
      }

      const criteria = await repositories.tasks.listCriteria(task.id, task.acceptance_revision);
      const readiness = await loadTaskReadiness(repositories, task, criteria);

      if (readiness.blockingTaskIds.length > 0 || readiness.unresolvedBlockerIds.length > 0) {
        throw invalidTransition('任务前置条件未满足：存在未完成的 BLOCKS 依赖或未解除的 blocker。', {
          taskId: task.id,
          ...(readiness.blockingTaskIds.length === 0
            ? {}
            : { blockingTaskIds: readiness.blockingTaskIds }),
          ...(readiness.unresolvedBlockerIds.length === 0
            ? {}
            : { blockerIds: readiness.unresolvedBlockerIds }),
        });
      }

      const liveRun = await repositories.runs.findLiveRunForTask(task.id);

      if (liveRun !== undefined) {
        throw executorConflict('该 Task 已有一个未释放的 AI Run，不能并发 Delegate。', {
          taskId: task.id,
        });
      }

      if (retryOfRunId !== null) {
        await requireRetryOfRun(repositories, task.id, retryOfRunId);
      }

      const acceptance = await repositories.tasks.readAcceptanceVersion(
        task.id,
        task.acceptance_revision,
      );

      if (acceptance === undefined) {
        throw invalidTransition('Task 当前验收版本不存在，无法冻结执行契约。', {
          taskId: task.id,
        });
      }

      // 固定 Workflow 只支持 Markdown；不能把未知或畸形要求冻结后留待完成时静默放行。
      requireDeclaredOutputs({
        task,
        acceptanceRevision: task.acceptance_revision,
        requiredOutputSpec: acceptance.required_output_spec,
      });

      const { allRules: allApplicableRules, criteria: ruleCriteria } =
        await loadRulePlanBasis(repositories, input.workspaceId, task.project_id, task.id);

      const frozenIntents = [input.mockGatewayAction, input.fileReadAction, input.webFetchAction]
        .filter((intent) => intent !== undefined);
      if (frozenIntents.length > 1) {
        throw invalidTransition('mock_gateway_action、file_read_action 与 web_fetch_action 只能冻结其一。',
          { taskId: task.id });
      }
      if (input.webFetchAction !== undefined) {
        // Freeze-time syntax only (same shape as Gateway prepare): host binding
        // and SSRF admission stay with the Gateway connection lookup.
        let url: URL;
        try { url = new URL(input.webFetchAction.url); } catch {
          throw invalidTransition('web_fetch_action.url 不是合法 URL。', { taskId: task.id });
        }
        if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username ||
            url.password || url.hash !== '' || url.hostname === '') {
          throw invalidTransition('web_fetch_action.url 仅接受无用户信息、无片段的 http(s) URL。',
            { taskId: task.id });
        }
      }
      const runId = randomUUID();
      const contextSources = await resolveExplicitContextSources(repositories, input.workspaceId,
        task, input.contextSources);
      const frozen = freezeExecutionContract({
        taskId: task.id,
        acceptanceRevision: task.acceptance_revision,
        objective: acceptance.objective,
        expectedOutputs: acceptance.required_output_spec,
        criteria: [...criteria.map((criterion) => ({
          criterionId: criterion.criterion_id,
          statement: criterion.statement,
          required: criterion.required,
          method: criterion.method,
          targetSpec: criterion.target_spec,
        })), ...ruleCriteria],
        ruleRevision: authority.rule_revision,
        ruleRefs: allApplicableRules.map((rule) => ({ rule_id: rule.id,
          version: toDecimalString(rule.version), scope: rule.scope,
          strength: rule.strength, enforcement: rule.enforcement })),
        ...(input.mockGatewayAction === undefined ? {} : { mockGatewayAction: {
          operation_id: randomUUID(), intent_key: 'mock-write-marker-v1' as const,
          connection_id: input.mockGatewayAction.connection_id,
          resource_id: input.mockGatewayAction.resource_id,
          target: input.mockGatewayAction.target,
          content: input.mockGatewayAction.content,
        } }),
        ...(input.fileReadAction === undefined ? {} : { fileReadAction: {
          operation_id: randomUUID(), intent_key: 'mock-file-read-v1' as const,
          connection_id: input.fileReadAction.connection_id,
          resource_id: input.fileReadAction.resource_id,
          relative_target: input.fileReadAction.relative_target,
        } }),
        ...(input.webFetchAction === undefined ? {} : { webFetchAction: {
          operation_id: randomUUID(), intent_key: 'mock-web-fetch-v1' as const,
          connection_id: input.webFetchAction.connection_id,
          url: input.webFetchAction.url,
        } }),
        ...(contextSources === undefined || contextSources.length === 0 ? {} :
          { contextSources }),
      });

      // Run 记录本次授予的执行权 epoch：assignExecutionToRun 会把 Task 的 ownership_epoch 递增 1，
      // 因此这里预写授予后的值，使 task.ownership_epoch === run.ownership_epoch（契约 02 第 2 节不变量 2，
      // 也是 run-steps 的写提交校验依据）。
      const grantedEpoch = task.ownership_epoch + 1n;

      try {
        await repositories.runs.insertRun({
          id: runId,
          workspaceId: input.workspaceId,
          taskId: task.id,
          ownershipEpoch: grantedEpoch,
          retryOfRunId,
        });

        await repositories.runs.insertExecutionContract({
          runId,
          taskId: task.id,
          acceptanceRevision: task.acceptance_revision,
          workflowKey: frozen.workflowKey,
          workflowVersion: frozen.workflowVersion,
          executionConfigVersion: frozen.executionConfigVersion,
          contractHash: frozen.contractHash,
          frozenSnapshot: frozen.snapshot,
        });

        await repositories.runs.insertRunSteps(
          WORKFLOW_STEPS.map((stepKind, stepIndex) => ({
            id: randomUUID(),
            runId,
            stepIndex,
            stepKind,
          })),
        );
      } catch (error) {
        // uq_run_live_task 兜底：并发 Delegate 竞争同一 Task 时唯一约束裁决，失败事务回滚后按业务冲突处理。
        if (isPostgresError(error, POSTGRES_ERROR_CODES.uniqueViolation)) {
          throw executorConflict('该 Task 已有一个未释放的 AI Run，不能并发 Delegate。', {
            taskId: task.id,
          });
        }

        throw error;
      }

      const assigned = await repositories.tasks.assignExecutionToRun({
        taskId: task.id,
        expectedRevision: task.revision,
        runId,
      });

      if (assigned === undefined) {
        throw executorConflict('该 Task 的执行权在 Delegate 期间被其他操作改变，请刷新后重试。', {
          taskId: task.id,
        });
      }

      // The receipt, Run, immutable START command and delivery row share this
      // transaction. A process notification is never the durable command source.
      await repositories.dispatch.insertInvocation(runId);
      await repositories.dispatch.insertCommand({
        id: randomUUID(), workspaceId: input.workspaceId, runId,
        sourceCommandId: input.commandId, kind: 'START',
      });
      await input.hooks?.afterDispatchInsert?.();

      await repositories.activities.insertActivityRecord({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        runId,
        actorKind: 'HUMAN',
        actorRef: LOCAL_ACTOR_REF,
        commandId: input.commandId,
        projectId: assigned.project_id,
        taskId: assigned.id,
        eventType: 'TASK_DELEGATED',
        factRefs: {
          run_id: runId,
          task_revision: toDecimalString(assigned.revision),
          ownership_epoch: toDecimalString(assigned.ownership_epoch),
          run_status: 'CREATED',
          retry_of_run_id: retryOfRunId,
          workflow_key: frozen.workflowKey,
          workflow_version: frozen.workflowVersion,
          execution_config_version: frozen.executionConfigVersion,
          contract_hash: frozen.contractHash.toString('hex'),
        },
      });

      return {
        run_id: runId,
        task_id: assigned.id,
        task_revision: toDecimalString(assigned.revision),
        run_revision: '0',
        status: 'CREATED',
        retry_of_run_id: retryOfRunId,
      };
    },
  });
}

function requireRevisionMatch(task: { readonly revision: bigint; readonly id: string }, expectedRevision: bigint): void {
  if (task.revision !== expectedRevision) {
    throw revisionConflict({
      entityType: 'TASK',
      expectedRevision: toDecimalString(expectedRevision),
      actualRevision: toDecimalString(task.revision),
    });
  }
}

const MAX_EXPLICIT_CONTEXT_SOURCES = 10;

/**
 * Delegate 时校验显式选中的长期信息来源：根必须在同一 Workspace、处于 ACTIVE、
 * Project 作用域匹配，且引用的具体不可变版本存在；去重后随执行契约冻结。
 * 构建期来源再被停用或缺失时按 SOURCE_UNAVAILABLE 排除，不在准入处静默改写。
 */
async function resolveExplicitContextSources(repositories: Repositories,
  workspaceId: string, task: { readonly id: string; readonly project_id: string | null },
  sources: readonly ContextSourceRef[] | undefined,
): Promise<readonly ContextSourceRef[] | undefined> {
  if (sources === undefined || sources.length === 0) return undefined;
  if (sources.length > MAX_EXPLICIT_CONTEXT_SOURCES) {
    throw invalidTransition(`显式来源选择最多 ${MAX_EXPLICIT_CONTEXT_SOURCES} 条。`, { taskId: task.id });
  }
  const frozen: ContextSourceRef[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const key = `${source.kind}:${source.root_id}:${source.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = source.kind.toLowerCase() as 'knowledge' | 'memory' | 'decision';
    const root = await repositories.information.readRoot(kind, source.root_id);
    if (root === undefined || root.workspace_id !== workspaceId) {
      throw resourceNotFound('Context source');
    }
    if (root.status !== 'ACTIVE') {
      throw invalidTransition(`显式来源 ${source.root_id} 已停用，不能随 Run 冻结。`, { taskId: task.id });
    }
    if (root.project_id !== null && root.project_id !== task.project_id) {
      throw resourceNotFound('Context source');
    }
    const version = await repositories.information.readVersion(kind, source.root_id,
      BigInt(source.version));
    if (version === undefined) {
      throw resourceNotFound('Context source version');
    }
    frozen.push({ kind: source.kind, root_id: source.root_id, version: source.version });
  }
  return frozen;
}

/**
 * 手动再试必须引用一个属于同一 Task 的终态 Run；不存在或跨 Task 按不可见处理（404），
 * 非终态返回 409，避免把仍在运行的历史 Run 当作重试来源。
 */
async function requireRetryOfRun(
  repositories: Repositories,
  taskId: string,
  retryOfRunId: string,
): Promise<void> {
  const run = await repositories.runs.readRun(retryOfRunId);

  if (run === undefined || run.task_id !== taskId) {
    throw resourceNotFound('Run');
  }

  if (!TERMINAL_RUN_STATUSES.includes(run.status)) {
    throw invalidTransition('retry_of_run_id 必须指向一个已进入终态的历史 Run。', {
      taskId,
    });
  }
}

function requireBuiltInWorkflowVersion(value: string | null): void {
  if (value !== null && value !== BUILT_IN_WORKFLOW_VERSION_ID) {
    throw capabilityDisabled(
      'workflow_version_id',
      'P05 只有内置固定 Workflow markdown-deliverable-v1，没有其他可选择的 Workflow 版本。',
    );
  }
}

function requireBuiltInExecutionConfigVersion(value: string | null): void {
  if (value !== null && value !== BUILT_IN_EXECUTION_CONFIG_VERSION_ID) {
    throw capabilityDisabled(
      'execution_config_version_id',
      'P05 没有 ExecutionConfiguration 表，只接受内置默认执行配置。',
    );
  }
}
