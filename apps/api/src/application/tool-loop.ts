import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject, JsonValue } from '../infrastructure/json.js';
import type { RunToolCallRow } from '../infrastructure/database-schema.js';
import type { ModelToolCall, ModelToolSpec, ModelToolTurn } from '../workflow/fake-model-port.js';
import { readToolLoopAction, type ToolLoopActionIntent } from '../workflow/execution-contract.js';
import { declaredToolSpecs, readInternalTool, type InternalToolDefinition } from '../workflow/tool-catalog.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { RunToolCallRepository } from '../run/run-tool-call-repository.js';
import { createRepositories } from './unit-of-work.js';
import { invalidTransition } from './domain-error.js';

/**
 * 模型工具循环的应用层（docs/architecture/runtime-context.md §2.3）。
 *
 * 本模块只做三件事：把冻结信封解析成一次具体的工具计划、把模型返回的完整请求落成
 * 稳定身份的行、把已结算的事实重建成下一轮模型需要的消息。它不判定权限、不执行动作、
 * 不改Task/Run 状态——那些仍归 Gateway 与既有 Owner。
 */

/** 单条工具结果回传给模型的字节上限。截断在投影里显式标注，不冒充完整输出。 */
export const MAX_TOOL_RESULT_BYTES = 16 * 1024;

export interface ToolLoopPlan {
  readonly intent: ToolLoopActionIntent;
  readonly projectId: string;
  readonly resourceId: string;
  readonly canonicalRoot: string;
  readonly specs: readonly ModelToolSpec[];
  readonly allowed: ReadonlyMap<string, InternalToolDefinition>;
}

/** 读取本次 Run 冻结的工具循环信封。没有信封时返回 undefined：既有 DRAFT 行为不变。 */
export async function resolveToolLoopPlan(db: DbExecutor, runId: string,
  workspaceId: string): Promise<ToolLoopPlan | undefined> {
  const repositories = createRepositories(db);
  const contract = await repositories.runs.readContract(runId);
  if (contract === undefined) return undefined;
  const intent = readToolLoopAction(contract.frozen_snapshot);
  if (intent === undefined) return undefined;
  const run = await repositories.runs.readRun(runId);
  if (run?.workspace_id !== workspaceId) {
    throw invalidTransition('工具循环信封与当前 Run 的工作区不一致。');
  }
  const task = await repositories.tasks.readTask(run.task_id);
  if (task === undefined || task.workspace_id !== workspaceId || task.project_id === null) {
    throw invalidTransition('工具循环信封对应的 Task 不存在或不属于当前工作区。');
  }
  const resource = await repositories.gateway.readResource(intent.resource_id);
  // 信封不能跨 Project 借用受管资源：资源边界必须与本次 Task 的 Project 一致。
  if (resource === undefined || resource.workspace_id !== workspaceId ||
      resource.project_id !== task.project_id || resource.status !== 'ACTIVE') {
    throw invalidTransition('工具循环信封绑定的受管资源不存在、已停用或不属于当前 Project。');
  }
  const allowed = new Map<string, InternalToolDefinition>();
  for (const name of intent.allowed_tools) {
    const definition = readInternalTool(name);
    // 冻结快照里的未知工具名是确定性错误：不能等到模型真的请求它才发现。
    if (definition === undefined || !Object.hasOwn(intent.connections, definition.capability)) {
      throw invalidTransition(`工具循环信封声明了未知或未绑定连接的工具：${name}`);
    }
    allowed.set(name, definition);
  }
  return { intent, projectId: task.project_id, resourceId: intent.resource_id,
    canonicalRoot: resource.canonical_root, specs: declaredToolSpecs([...allowed.keys()]), allowed };
}

/**
 * 校验一次模型工具请求。
 *
 * 这不是通用 JSON Schema 校验器，只覆盖首批词表实际使用的子集：对象、字符串/整数/布尔
 * 属性、必填与禁止额外属性。半截参数、未知工具名与越界 limit 都在这里被拒，不落库。
 */
export function validateToolArguments(spec: ModelToolSpec, args: JsonObject): JsonObject {
  const schema = spec.parameters;
  const properties = asObject(schema.properties) ?? {};
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string =>
    typeof key === 'string') : [];
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.hasOwn(properties, key)) {
        throw new ToolRequestRejected('TOOL_ARGUMENT_UNKNOWN', `工具 ${spec.name} 不接受参数 ${key}。`);
      }
    }
  }
  const normalized: Record<string, JsonValue> = {};
  for (const [key, raw] of Object.entries(args)) {
    const property = asObject(properties[key]);
    if (property === undefined) continue;
    const declared = property.type;
    if (declared === 'string') {
      if (typeof raw !== 'string') {
        throw new ToolRequestRejected('TOOL_ARGUMENT_INVALID', `工具 ${spec.name} 的 ${key} 必须是字符串。`);
      }
      if (raw.length > 4096) {
        throw new ToolRequestRejected('TOOL_ARGUMENT_TOO_LARGE', `工具 ${spec.name} 的 ${key} 过长。`);
      }
      normalized[key] = raw;
      continue;
    }
    if (declared === 'boolean') {
      if (typeof raw !== 'boolean') {
        throw new ToolRequestRejected('TOOL_ARGUMENT_INVALID', `工具 ${spec.name} 的 ${key} 必须是布尔值。`);
      }
      normalized[key] = raw;
      continue;
    }
    if (declared === 'integer') {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) {
        throw new ToolRequestRejected('TOOL_ARGUMENT_INVALID', `工具 ${spec.name} 的 ${key} 必须是整数。`);
      }
      const minimum = typeof property.minimum === 'number' ? property.minimum : undefined;
      const maximum = typeof property.maximum === 'number' ? property.maximum : undefined;
      if ((minimum !== undefined && raw < minimum) || (maximum !== undefined && raw > maximum)) {
        throw new ToolRequestRejected('TOOL_ARGUMENT_OUT_OF_RANGE',
          `工具 ${spec.name} 的 ${key} 超出允许范围。`);
      }
      normalized[key] = raw;
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(normalized, key)) {
      throw new ToolRequestRejected('TOOL_ARGUMENT_MISSING', `工具 ${spec.name} 缺少必填参数 ${key}。`);
    }
  }
  return normalized;
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject : undefined;
}

export class ToolRequestRejected extends Error {
  override readonly name = 'ToolRequestRejected';
  constructor(readonly reason: string, message: string) { super(message); }
}

export interface PersistedToolRound {
  readonly round: number;
  readonly rows: readonly RunToolCallRow[];
  /** 本轮被拒的请求数；它们不连 Operation，只带类型化原因。 */
  readonly rejected: number;
}

/**
 * 把一次模型返回的工具请求整轮落库。
 *
 * 行 id 直接作为后续 Gateway 动作的 operation_id，因此重放同一请求永远得到同一身份。
 * 未声明工具、非法参数、循环预算耗尽与已取消的请求落成 REJECTED：它们不产生 Operation，
 * 但模型下一轮仍能看到类型化原因并自行收尾。
 */
export async function persistToolRound(db: DbExecutor, input: {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly stepAttemptId: string;
  readonly modelCallId: string;
  readonly round: number;
  readonly calls: readonly ModelToolCall[];
  readonly plan: ToolLoopPlan;
  readonly remainingCalls: number;
  readonly cancelled: boolean;
}): Promise<PersistedToolRound> {
  const repository = new RunToolCallRepository(db);
  const rows: RunToolCallRow[] = [];
  let rejected = 0;
  for (const [ordinal, call] of input.calls.entries()) {
    const definition = input.plan.allowed.get(call.name);
    let argumentsValue: JsonObject | null = null;
    let rejection: ToolRequestRejected | null = null;
    if (input.cancelled) {
      rejection = new ToolRequestRejected('TOOL_LOOP_CANCELLED', '本次执行已被取消，请求未派发。');
    } else if (definition === undefined) {
      rejection = new ToolRequestRejected('TOOL_UNKNOWN', `工具 ${call.name} 不在本次允许的工具词表内。`);
    } else if (input.remainingCalls - rejected <= 0) {
      rejection = new ToolRequestRejected('TOOL_LOOP_BUDGET_EXHAUSTED',
        '本次工具调用预算已用尽；请用已有结果收尾，不要继续请求工具。');
    } else {
      try { argumentsValue = validateToolArguments(definition.spec, call.arguments); }
      catch (error) {
        rejection = error instanceof ToolRequestRejected ? error
          : new ToolRequestRejected('TOOL_ARGUMENT_INVALID', '工具参数校验失败。');
      }
    }
    const id = randomUUID();
    const argumentsSha = createHash('sha256')
      .update(canonicalizeJson(argumentsValue ?? call.arguments), 'utf8').digest('hex');
    const row = await repository.insert({ id, workspace_id: input.workspaceId,
      project_id: input.projectId, run_id: input.runId, step_id: input.stepId,
      step_attempt_id: input.stepAttemptId, model_call_id: input.modelCallId,
      round: input.round, ordinal, provider_tool_call_id: call.providerToolCallId,
      tool_name: call.name, arguments: argumentsValue ?? {}, arguments_sha256: argumentsSha });
    if (rejection !== null) {
      await repository.reject(id, rejection.reason, rejection.message);
      rejected += 1;
      rows.push({ ...row, status: 'REJECTED' });
      continue;
    }
    rows.push(row);
  }
  return { round: input.round, rows, rejected };
}

/**
 * 工具执行时使用的绝对目标。
 *
 * FILE_READ 与 GIT_* 的 Gateway target 是根内绝对路径，LIST_DIRECTORY/FIND_PATHS/SEARCH_TEXT
 * 冻结的是目录本身；根内相对子目录通过 params.relative_path 传，不参与 target 计算，
 * 与 Gateway prepare 的规范化保持同一形状。
 */
export function toolTargetFor(plan: ToolLoopPlan, definition: InternalToolDefinition,
  args: JsonObject): string {
  if (definition.capability === 'GIT_READ') return plan.canonicalRoot;
  const relative = typeof args.relative_path === 'string' && args.relative_path !== ''
    ? args.relative_path : undefined;
  if (definition.actionType === 'LIST_DIRECTORY' && relative !== undefined) {
    return join(plan.canonicalRoot, relative);
  }
  return join(plan.canonicalRoot, relative ?? '');
}

/** 只把该工具词表允许的参数交给 Gateway；模型多带的字段不会变成动作参数。 */
export function gatewayParamsFor(definition: InternalToolDefinition,
  args: JsonObject): JsonObject {
  if (definition.actionType === 'FIND_PATHS') {
    return { ...(typeof args.pattern === 'string' ? { pattern: args.pattern } : {}),
      ...(typeof args.relative_path === 'string' ? { relative_path: args.relative_path } : {}),
      ...(typeof args.limit === 'number' ? { limit: args.limit } : {}) };
  }
  if (definition.actionType === 'SEARCH_TEXT') {
    const query = args.query;
    return { query: typeof query === 'string' ? query : '',
      ...(typeof args.relative_path === 'string' ? { relative_path: args.relative_path } : {}),
      ...(typeof args.limit === 'number' ? { limit: args.limit } : {}) };
  }
  if (definition.actionType === 'LIST_DIRECTORY') {
    return { ...(typeof args.relative_path === 'string' ? { relative_path: args.relative_path } : {}),
      ...(typeof args.limit === 'number' ? { limit: args.limit } : {}) };
  }
  if (definition.actionType === 'READ_FILE') return {};
  if (definition.actionType === 'GIT_DIFF') {
    return { ...(typeof args.path === 'string' ? { path: args.path } : {}),
      ...(args.staged === true ? { cached: true } : {}) };
  }
  if (definition.actionType === 'GIT_LOG') {
    return { max_count: typeof args.max_count === 'number' ? args.max_count : 10 };
  }
  return {};
}

/**
 * 把已结算的动作结果投影成回传模型的文本。
 *
 * 上限是硬字节数：超出就按完整字符截断并显式标注 truncated=true，因此模型能区分
 * 「读到了全部」与「只读到一段」。REJECTED 行只回传类型化原因。
 */
export function projectToolResult(status: RunToolCallRow['status'],
  operationResult: JsonObject | null, rejection: JsonObject | null): string {
  if (status === 'REJECTED') {
    const reason = typeof rejection?.reason === 'string' ? rejection.reason : 'TOOL_REQUEST_REJECTED';
    const detail = typeof rejection?.detail === 'string' ? rejection.detail : '';
    return JSON.stringify({ ok: false, reason, detail });
  }
  if (operationResult === null) return JSON.stringify({ ok: false, reason: 'TOOL_RESULT_MISSING' });
  const ok = !('reason' in operationResult) ||
    typeof operationResult.reason !== 'string';
  const body = JSON.stringify(operationResult);
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes <= MAX_TOOL_RESULT_BYTES) return body;
  let truncated = body;
  while (Buffer.byteLength(truncated, 'utf8') > MAX_TOOL_RESULT_BYTES - 64) {
    truncated = truncated.slice(0, Math.floor(truncated.length / 2));
  }
  return `${truncated}${JSON.stringify({ truncated: true, omitted_bytes: bytes -
    Buffer.byteLength(truncated, 'utf8') })}`;
}

/**
 * 从持久化行重建已结算的历史轮次。
 *
 * 只有全部落定的轮次才回传：仍在 REQUESTED/PREPARED/WAITING_APPROVAL 的轮次尚未有结果，
 * 重建它等于凭空编造工具输出。恢复与正常推进走同一条路径。
 */
export function buildToolTurns(rows: readonly RunToolCallRow[],
  results: ReadonlyMap<string, JsonObject>): readonly ModelToolTurn[] {
  const byRound = new Map<number, RunToolCallRow[]>();
  for (const row of rows) {
    if (row.status !== 'SETTLED' && row.status !== 'REJECTED') continue;
    const bucket = byRound.get(row.round);
    if (bucket === undefined) byRound.set(row.round, [row]);
    else bucket.push(row);
  }
  const turns: ModelToolTurn[] = [];
  for (const round of [...byRound.keys()].sort((left, right) => left - right)) {
    const bucket = (byRound.get(round) ?? []).sort((left, right) => left.ordinal - right.ordinal);
    const calls: ModelToolCall[] = [];
    const turnResults: ModelToolTurn['results'][number][] = [];
    for (const row of bucket) {
      calls.push({ providerToolCallId: row.provider_tool_call_id,
        name: row.tool_name, arguments: row.arguments });
      const operationResult = row.operation_id === null ? null
        : results.get(row.operation_id) ?? null;
      turnResults.push({ providerToolCallId: row.provider_tool_call_id, name: row.tool_name,
        content: projectToolResult(row.status, operationResult, row.result_ref),
        isError: row.status === 'REJECTED' || operationResult === null ||
          typeof operationResult.reason === 'string' });
    }
    turns.push({ calls, results: turnResults });
  }
  return turns;
}

/** 便于调用方在事务外读取 Operation 结果：一次 Attempt 的 SETTLED 行按 operation 取结果。 */
export function operationIdsOf(rows: readonly RunToolCallRow[]): readonly string[] {
  return rows.filter((row) => row.operation_id !== null).map((row) => row.operation_id!);
}