import { randomUUID } from 'node:crypto';
import { requireTaskChainAdmission, type TaskChainBinding } from './task-chain-admission.js';
import type { RunMethodBinding } from '../skills/builtin-methods.js';

import type { DbExecutor } from '../infrastructure/database.js';
import type { SessionModelSelectionRow } from '../infrastructure/database-schema.js';
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
import { freezeExecutionContract, readContextSources, TOOL_LOOP_MAX_ROUNDS, MAX_EXPLICIT_CONTEXT_SOURCES,
  TOOL_LOOP_MAX_TOOL_CALLS } from '../workflow/execution-contract.js';
import { readInternalTool } from '../workflow/tool-catalog.js';
import { freezeAssistModelSnapshot } from './assist-model-snapshot.js';

/** 首批工具循环只读三类能力；写入与检查在后续片按同一张表扩进来。 */
// 写入与受控命令也在信封允许的能力之内：信封是模型自主调用的上界，不是授权。
// 没有对应范围授权时，这些动作仍然退回落单动作审批（Gateway 的既有降级）。
// 0092: COMPUTER_READ/COMPUTER_INPUT 同理——桌面输入的实际放行由审批或范围授权决定。
const TOOL_LOOP_CAPABILITIES: readonly string[] =
  ['FILE_QUERY', 'FILE_READ', 'GIT_READ', 'FILE_WRITE', 'CLI_RUN', 'COMPUTER_READ', 'COMPUTER_INPUT'];
import type { ContextSourceRef } from '../workflow/execution-contract.js';
import { loadRulePlanBasis } from './rule-plan-basis.js';
import { canonicalRelativePath, requireFrozenBaseline,
  requireMatchingTarget } from '../files/file-changeset.js';
import type { FileWriteChangeIntent } from '../workflow/execution-contract.js';
import { SCOPE_GRANT_ACTIONS, SCOPE_GRANT_ACTION_CAPABILITIES, freezeScopeChecks,
  type FrozenCheck } from './run-scope-grant.js';

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
  readonly taskChainBinding?: TaskChainBinding;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly commandId: string;
  readonly expectedTaskRevision: string;
  readonly retryOfRunId?: string | null;
  readonly workflowVersionId?: string | null;
  readonly executionConfigVersionId?: string | null;
  /** Internal conversation origin; not an endpoint or credential supplied by the client. */
  readonly modelSessionId?: string | undefined;
  readonly mockGatewayAction?: {
    readonly connection_id: string; readonly resource_id: string;
    readonly target: string; readonly content: string;
  } | undefined;
  /** 用户显式选中的长期信息来源；随 Run 冻结，版本不可变。 */
  readonly contextSources?: readonly ContextSourceRef[] | undefined;
  /** 由会话应用入口取得的已冻结方法；不构成额外执行权限。 */
  readonly executionMethod?: RunMethodBinding | undefined;
  /** 可选固定 Mock 文件读意图；与 mockGatewayAction、webFetchAction 互斥。 */
  readonly fileReadAction?: {
    readonly connection_id: string; readonly resource_id: string; readonly relative_target: string;
  } | undefined;
  /** 可选固定 Mock 网页读意图；与 mockGatewayAction、fileReadAction 互斥。 */
  readonly webFetchAction?: {
    readonly connection_id: string; readonly url: string;
  } | undefined;
  /** 可选固定文件写意图；可与 cliRunAction 组成「先改文件、再跑一次检查」链。 */
  readonly fileWriteAction?: {
    readonly connection_id: string; readonly resource_id: string;
    readonly changes: readonly FileWriteChangeIntent[];
  } | undefined;
  /** 可选固定受控命令意图；与 fileWriteAction 组合时在文件落盘之后执行。 */
  readonly cliRunAction?: {
    readonly connection_id: string; readonly resource_id: string;
    readonly executable: string; readonly args: readonly string[];
    readonly max_output_bytes?: number;
  } | undefined;
  /** 可选工具循环信封：模型在本 Run 内可自主请求的工具上界。与固定读取意图互斥。 */
  readonly toolLoopAction?: {
    readonly resource_id: string;
    readonly connections: Readonly<Record<string, string>>;
    readonly allowed_tools: readonly string[];
    readonly max_rounds: number;
    readonly max_tool_calls: number;
  } | undefined;
  /**
   * 本次任务范围授权（用户显式授予；随 Run 同批落库）。
   *
   * 与单动作 ACTION_APPROVAL 是两个对象：授权只回答「本次 Run 内这类动作是否可 AUTO」，
   * 删除与 Git 写入永远不在其中。一次授权不能跨 Run 继承，也不能超出 tool_loop_action
   * 已冻结的受管资源与连接范围。
   */
  readonly scopeGrant?: {
    readonly resource_id: string;
    readonly allowed_actions: readonly string[];
    readonly checks: readonly FrozenCheck[];
    readonly expires_at?: string | undefined;
    readonly survives_run_terminal?: boolean | undefined;
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
  modelEnv: NodeJS.ProcessEnv = process.env,
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
      ...(input.taskChainBinding === undefined ? {} : { task_chain: { chain_id: input.taskChainBinding.chainId, item_id: input.taskChainBinding.itemId,...(input.taskChainBinding.executionSignature===undefined?{}:{execution_signature:input.taskChainBinding.executionSignature}) } }),
      retry_of_run_id: retryOfRunId,
      workflow_version_id: workflowVersionId,
      execution_config_version_id: executionConfigVersionId,
      ...(input.modelSessionId === undefined ? {} : { model_session_id: input.modelSessionId }),
      mock_gateway_action: input.mockGatewayAction ?? null,
      ...(input.executionMethod === undefined ? {} : { execution_method: input.executionMethod }),
      context_sources: input.contextSources === undefined ? null :
        input.contextSources.map((source) => ({ kind: source.kind,
          root_id: source.root_id, version: source.version })),
      file_read_action: input.fileReadAction ?? null,
      web_fetch_action: input.webFetchAction ?? null,
      file_write_action: input.fileWriteAction === undefined ? null : {
        connection_id: input.fileWriteAction.connection_id,
        resource_id: input.fileWriteAction.resource_id,
        changes: input.fileWriteAction.changes.map((change) => ({ path: change.path,
          action: change.action,
          ...(change.content === undefined ? {} : { content: change.content }),
          ...(change.baselineSha256 === undefined ? {} : { baselineSha256: change.baselineSha256 }),
          ...(change.targetSha256 === undefined ? {} : { targetSha256: change.targetSha256 }) })),
      },
    },
    execute: async (repositories) => {
      // Rule 更新持 authority UPDATE；Delegate 持 SHARE 后再锁 Task，两个提交顺序有唯一裁决。
      const authority = await repositories.workspaces.lockAuthority(input.workspaceId, 'share');
      if (authority === undefined) throw resourceNotFound('Workspace authority');
      await input.hooks?.afterAuthorityLock?.();
      if (input.taskChainBinding !== undefined) await requireTaskChainAdmission(repositories,input.taskChainBinding,input.workspaceId,input.taskId);
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

      // 授权只能依附工具循环信封：没有信封就没有模型自主调用的动作，授权无处生效。
      if (input.scopeGrant !== undefined && input.toolLoopAction === undefined) {
        throw invalidTransition('scope_grant 必须与 tool_loop_action 同时提供。', { taskId: task.id });
      }

      // 一个 Run 最多冻结一个读取动作，以及一个写入链：Fake 标记、受控文件变更、
      // 受控命令检查三选一，或「文件变更 + 一次检查命令」。Fake 标记不能与真实写入并存。
      const readIntents = [input.fileReadAction, input.webFetchAction]
        .filter((intent) => intent !== undefined);
      if (readIntents.length > 1) {
        throw invalidTransition('读取类 Gateway action 只能冻结其一。', { taskId: task.id });
      }
      const writeIntents = [input.mockGatewayAction, input.fileWriteAction, input.cliRunAction]
        .filter((intent) => intent !== undefined);
      const marker = input.mockGatewayAction !== undefined;
      const chain = (input.fileWriteAction !== undefined ? 1 : 0) + (input.cliRunAction !== undefined ? 1 : 0);
      if (writeIntents.length > 2 || (marker && chain > 0) || (!marker && chain !== writeIntents.length) ||
          (readIntents.length > 0 && writeIntents.length > 0)) {
        throw invalidTransition('Gateway action 只能冻结「一个读取动作」，或「标记 / 文件变更 / 检查命令」其一，或「文件变更 + 检查命令」。',
          { taskId: task.id });
      }
      // 冻结期算出的信任依据，随授权一起落库（Run 与授权同批提交）。
      let frozenScopeChecks: readonly FrozenCheck[] = [];
      if (input.toolLoopAction !== undefined) {
        // 信封是模型自主调用的上界，不是授权：工具名、连接与受管资源都在冻结期核对。
        if (readIntents.length > 0) {
          throw invalidTransition('tool_loop_action 不能与固定读取动作同时冻结。', { taskId: task.id });
        }
        const loop = input.toolLoopAction;
        const resource = await repositories.gateway.readResource(loop.resource_id);
        if (resource?.workspace_id !== input.workspaceId || resource.project_id !== task.project_id ||
            resource.status !== 'ACTIVE') {
          throw invalidTransition('tool_loop_action.resource_id 不属于当前 Task 的 Project 或已停用。',
            { taskId: task.id });
        }
        const capabilities = new Set<string>();
        for (const [capability, connectionId] of Object.entries(loop.connections)) {
          if (!TOOL_LOOP_CAPABILITIES.includes(capability) || typeof connectionId !== 'string' ||
              connectionId === '') {
            throw invalidTransition(`tool_loop_action.connections 含未知能力：${capability}`,
              { taskId: task.id });
          }
          capabilities.add(capability);
          const connection = await repositories.gateway.readConnection(connectionId);
          if (connection?.workspace_id !== input.workspaceId || connection.project_id !== task.project_id ||
              connection.status !== 'ACTIVE' ||
              !(await repositories.gateway.hasConnectionCapability(connectionId, capability as never))) {
            throw invalidTransition(`tool_loop_action 的 ${capability} 连接不可用或不属于当前 Project。`,
              { taskId: task.id });
          }
        }
        const definitions = loop.allowed_tools.map((name) => readInternalTool(name));
        if (definitions.some((entry) => entry === undefined) ||
            definitions.some((entry) => !capabilities.has(entry!.capability))) {
          throw invalidTransition('tool_loop_action.allowed_tools 含未知工具或缺少对应连接。',
            { taskId: task.id });
        }
        if (loop.max_rounds < 1 || loop.max_rounds > TOOL_LOOP_MAX_ROUNDS ||
            loop.max_tool_calls < 1 || loop.max_tool_calls > TOOL_LOOP_MAX_TOOL_CALLS) {
          throw invalidTransition('tool_loop_action 的循环预算超出允许上限。', { taskId: task.id });
        }
        if (input.scopeGrant !== undefined) {
          // 授权只能收窄信封，不能扩大：资源必须与信封同一个，能力连接也必须已冻结。
          if (input.scopeGrant.resource_id !== loop.resource_id) {
            throw invalidTransition('scope_grant.resource_id 必须与 tool_loop_action 同一个受管资源。',
              { taskId: task.id });
          }
          const requested = new Set<string>(input.scopeGrant.allowed_actions);
          if (requested.size === 0 || [...requested].some((action) => !SCOPE_GRANT_ACTIONS.includes(action))) {
            throw invalidTransition(
              `scope_grant.allowed_actions 只能取 ${SCOPE_GRANT_ACTIONS.join(' / ')} 的非空子集。`,
              { taskId: task.id });
          }
          for (const action of requested) {
            const capability = SCOPE_GRANT_ACTION_CAPABILITIES[action];
            if (capability === undefined || !capabilities.has(capability)) {
              throw invalidTransition(`scope_grant 放行 ${action} 需要信封里同时冻结 ${capability} 连接。`,
                { taskId: task.id });
            }
          }
          frozenScopeChecks = await freezeScopeChecks(resource.canonical_root, input.scopeGrant.checks, task.id);
          if (requested.has('CLI_RUN')) {
            if (!capabilities.has('CLI_RUN')) throw invalidTransition(
              'scope_grant 放行检查命令需要信封里同时冻结 CLI_RUN 连接。', { taskId: task.id });
            if (frozenScopeChecks.length === 0) {
              throw invalidTransition('scope_grant 放行检查命令时必须至少配置一个检查。', { taskId: task.id });
            }
          }
        }
      }
      if (input.fileWriteAction !== undefined) {
        const resource = await repositories.gateway.readResource(input.fileWriteAction.resource_id);
        if (resource?.workspace_id !== input.workspaceId || resource.project_id !== task.project_id) {
          throw invalidTransition('file_write_action.resource_id 不属于当前 Task 的 Project。',
            { taskId: task.id });
        }
        const changes = input.fileWriteAction.changes;
        if (!Array.isArray(changes) || changes.length === 0 || changes.length > 16) {
          throw invalidTransition('file_write_action.changes 必须包含 1 至 16 项。',
            { taskId: task.id });
        }
        const seen = new Set<string>();
        for (const change of changes) {
          if (typeof change.path !== 'string' || change.path === '' || [...change.path].length > 1024 ||
              !['CREATE', 'MODIFY', 'DELETE'].includes(change.action)) {
            throw invalidTransition('file_write_action.changes 含无效路径或动作。', { taskId: task.id });
          }
          let path: string;
          try { path = canonicalRelativePath(resource.canonical_root, change.path); }
          catch { throw invalidTransition('file_write_action.changes 含不安全的相对路径。', { taskId: task.id }); }
          if (Buffer.byteLength(path, 'utf8') > 1024) {
            throw invalidTransition('file_write_action.changes 路径超过账本 1024 UTF-8 字节上限。',
              { taskId: task.id });
          }
          const key = process.platform === 'win32' ? path.toLowerCase() : path;
          if (seen.has(key)) throw invalidTransition('file_write_action.changes 含重复目标路径。',
            { taskId: task.id });
          seen.add(key);
          if (change.action === 'DELETE'
            ? change.content !== undefined || change.targetSha256 !== undefined
            : typeof change.content !== 'string' || [...change.content].length > 8192) {
            throw invalidTransition('file_write_action.changes 内容与动作不符。', { taskId: task.id });
          }
          if (change.action === 'CREATE' && change.baselineSha256 !== undefined) {
            throw invalidTransition('CREATE 不接受基线摘要。', { taskId: task.id });
          }
          try { requireFrozenBaseline(change); requireMatchingTarget(change); }
          catch { throw invalidTransition('file_write_action.changes 的冻结摘要无效。', { taskId: task.id }); }
        }
      }
      if (input.cliRunAction !== undefined) {
        const resource = await repositories.gateway.readResource(input.cliRunAction.resource_id);
        if (resource?.workspace_id !== input.workspaceId || resource.project_id !== task.project_id) {
          throw invalidTransition('cli_run_action.resource_id 不属于当前 Task 的 Project。',
            { taskId: task.id });
        }
        const cli = input.cliRunAction;
        if (typeof cli.executable !== 'string' || cli.executable.trim() === '' ||
            cli.executable.includes('\u0000') || !Array.isArray(cli.args) || cli.args.length === 0 ||
            cli.args.some((arg) => typeof arg !== 'string' || arg.includes('\u0000')) ||
            (cli.max_output_bytes !== undefined &&
              (!Number.isInteger(cli.max_output_bytes) || cli.max_output_bytes < 0 ||
                cli.max_output_bytes > 1048576))) {
          throw invalidTransition('cli_run_action 只接受一个可执行文件与参数数组。', { taskId: task.id });
        }
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
      let modelSelection: SessionModelSelectionRow | undefined;
      if (input.modelSessionId !== undefined) {
        const session = await repositories.assist.readSession(input.modelSessionId, true);
        if (session === undefined || session.workspace_id !== input.workspaceId) {
          throw resourceNotFound('Assist session');
        }
        if (session.status !== 'ACTIVE') throw invalidTransition('模型来源会话已归档，不能创建新的执行。');
        modelSelection = await repositories.modelSelection.readForSession(session.id);
      }
      const modelPlan = await freezeAssistModelSnapshot(repositories, modelSelection, modelEnv, {
        requiresTools: input.toolLoopAction !== undefined,
        requiresJsonOutput: [...criteria, ...ruleCriteria].some((criterion) => criterion.method === 'SEMANTIC'),
      });
      const frozen = freezeExecutionContract({
        taskId: task.id,
        ...(modelPlan === undefined ? {} : { modelSelectionSnapshot: modelPlan.snapshot }),
        ...(input.executionMethod === undefined ? {} : { executionMethod: input.executionMethod }),
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
        ...(input.fileWriteAction === undefined ? {} : { fileWriteAction: {
          operation_id: randomUUID(), intent_key: 'file-write-v1' as const,
          connection_id: input.fileWriteAction.connection_id,
          resource_id: input.fileWriteAction.resource_id,
          changes: input.fileWriteAction.changes,
        } }),
        ...(input.cliRunAction === undefined ? {} : { cliRunAction: {
          operation_id: randomUUID(), intent_key: 'cli-run-v1' as const,
          connection_id: input.cliRunAction.connection_id,
          resource_id: input.cliRunAction.resource_id,
          executable: input.cliRunAction.executable,
          args: [...input.cliRunAction.args],
          ...(input.cliRunAction.max_output_bytes === undefined ? {} :
            { max_output_bytes: input.cliRunAction.max_output_bytes }),
        } }),
        ...(input.toolLoopAction === undefined ? {} : { toolLoopAction: {
          intent_key: 'tool-loop-v1' as const,
          resource_id: input.toolLoopAction.resource_id,
          connections: { ...input.toolLoopAction.connections },
          allowed_tools: [...input.toolLoopAction.allowed_tools],
          max_rounds: input.toolLoopAction.max_rounds,
          max_tool_calls: input.toolLoopAction.max_tool_calls,
        } }),
        // 授权边界进入命令摘要：同一个 commandId 不能换一个更宽的授权重放。
        ...(input.scopeGrant === undefined ? {} : { scopeGrant: {
          intent_key: 'scope-grant-v1' as const,
          resource_id: input.scopeGrant.resource_id,
          allowed_actions: [...input.scopeGrant.allowed_actions],
          checks: frozenScopeChecks.map((check) => ({
            id: check.id, executable: check.executable, args: [...check.args],
            executable_sha256: check.executable_sha256,
            ...(check.trust_basis === undefined ? {} : { trust_basis: check.trust_basis }),
            ...(check.max_output_bytes === undefined ? {} :
              { max_output_bytes: check.max_output_bytes }) })),
          expires_at: input.scopeGrant.expires_at ?? null,
          survives_run_terminal: input.scopeGrant.survives_run_terminal ?? false,
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

        // 授权与 Run 同批提交：不会出现「Run 已存在但授权漏写」的中间态，
        // 也不会留下没有 Run 的孤儿授权。
        if (input.scopeGrant !== undefined) {
          const granted = await repositories.gateway.readResource(input.scopeGrant.resource_id);
          await repositories.scopeGrants.insert({
            workspaceId: input.workspaceId, projectId: task.project_id, runId, taskId: task.id,
            resourceId: input.scopeGrant.resource_id,
            canonicalRoot: granted?.canonical_root ?? '',
            allowedActions: input.scopeGrant.allowed_actions,
            checks: frozenScopeChecks,
            ...(input.scopeGrant.expires_at === undefined ? {} :
              { expiresAt: new Date(input.scopeGrant.expires_at) }),
            ...(input.scopeGrant.survives_run_terminal === undefined ? {} :
              { survivesRunTerminal: input.scopeGrant.survives_run_terminal }),
          });
        }
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
      if (input.taskChainBinding !== undefined) await repositories.taskChains.bind(input.taskChainBinding.chainId,input.taskChainBinding.itemId,runId);

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
