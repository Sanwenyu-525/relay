import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject, JsonValue } from '../infrastructure/json.js';
import type { RunToolCallRow } from '../infrastructure/database-schema.js';
import type { ModelToolCall, ModelToolSpec, ModelToolTurn } from '../workflow/fake-model-port.js';
import { readToolLoopAction, type ToolLoopActionIntent } from '../workflow/execution-contract.js';
import { declaredToolSpecs, readInternalTool, type InternalToolDefinition } from '../workflow/tool-catalog.js';
import { COMPUTER_DESKTOP_TARGET } from '../computer/protocol.js';
import { BROWSER_UNKNOWN_TARGET } from '../browser/protocol.js';
import { browserTargetForTool } from '../browser/browser-adapter.js';
import type { GatewayOrigin } from './gateway-actions.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { RunToolCallRepository } from '../run/run-tool-call-repository.js';
import { createRepositories } from './unit-of-work.js';
import { invalidTransition } from './domain-error.js';
import { resolveFrozenCheck, RunScopeGrantRepository } from './run-scope-grant.js';

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
  const grant = allowed.has('run_check') ? await new RunScopeGrantRepository(db).readByRun(runId)
    : undefined;
  const checkIds = (Array.isArray(grant?.checks) ? grant.checks : []).flatMap((entry) => {
    const id = asObject(entry)?.id;
    return typeof id === 'string' && resolveFrozenCheck(grant, id) !== undefined ? [id] : [];
  });
  const specs = declaredToolSpecs([...allowed.keys()]).map((spec) =>
    spec.name !== 'run_check' || checkIds.length === 0 ? spec : { ...spec,
      description: `${spec.description} 本次可用检查：${checkIds.join('、')}。失败后依据实际输出修正，再运行同一检查。`,
      parameters: { ...spec.parameters, properties: {
        check_id: { type: 'string', enum: checkIds, description: '本次 Run 已冻结的检查标识。' },
      } } });
  return { intent, projectId: task.project_id, resourceId: intent.resource_id,
    canonicalRoot: resource.canonical_root, specs, allowed };
}

/**
 * 校验一次模型工具请求。
 *
 * 这不是通用 JSON Schema 校验器，只覆盖首批词表实际使用的子集：对象、字符串/整数/布尔
 * 属性、枚举、嵌套对象（坐标点）、必填与禁止额外属性。半截参数、未知工具名与越界 limit
 * 都在这里被拒，不落库。
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
      const allowed = Array.isArray(property.enum)
        ? property.enum.filter((value): value is string => typeof value === 'string')
        : undefined;
      if (allowed !== undefined && !allowed.includes(raw)) {
        throw new ToolRequestRejected('TOOL_ARGUMENT_INVALID',
          `工具 ${spec.name} 的 ${key} 只接受 ${allowed.join(' / ')}。`);
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
      continue;
    }
    if (declared === 'object') {
      // 嵌套对象（如坐标点）：按声明的 properties 与 required 递归校验一层，
      // 不引入完整 JSON Schema 求值器。
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new ToolRequestRejected('TOOL_ARGUMENT_INVALID', `工具 ${spec.name} 的 ${key} 必须是对象。`);
      }
      const nested = raw as JsonObject;
      const nestedProperties = asObject(property.properties) ?? {};
      const nestedRequired = Array.isArray(property.required)
        ? property.required.filter((name): name is string => typeof name === 'string') : [];
      if (property.additionalProperties === false) {
        for (const name of Object.keys(nested)) {
          if (!Object.hasOwn(nestedProperties, name)) {
            throw new ToolRequestRejected('TOOL_ARGUMENT_UNKNOWN',
              `工具 ${spec.name} 的 ${key} 不接受字段 ${name}。`);
          }
        }
      }
      const normalizedNested: Record<string, JsonValue> = {};
      for (const [name, value] of Object.entries(nested)) {
        const nestedProperty = asObject(nestedProperties[name]);
        if (nestedProperty?.type === 'integer') {
          if (typeof value !== 'number' || !Number.isInteger(value)) {
            throw new ToolRequestRejected('TOOL_ARGUMENT_INVALID',
              `工具 ${spec.name} 的 ${key}.${name} 必须是整数。`);
          }
          normalizedNested[name] = value;
          continue;
        }
        if (nestedProperty?.type === 'string') {
          if (typeof value !== 'string') {
            throw new ToolRequestRejected('TOOL_ARGUMENT_INVALID',
              `工具 ${spec.name} 的 ${key}.${name} 必须是字符串。`);
          }
          normalizedNested[name] = value;
          continue;
        }
      }
      for (const name of nestedRequired) {
        if (!Object.hasOwn(normalizedNested, name)) {
          throw new ToolRequestRejected('TOOL_ARGUMENT_MISSING',
            `工具 ${spec.name} 的 ${key} 缺少必填字段 ${name}。`);
        }
      }
      normalized[key] = normalizedNested;
      continue;
    }
    if (declared === 'array') {
      // 数组本身只做形状检查：逐项语义由该工具自己的规范化函数判定（写入类工具的
      // 每项字段各不相同，塞进通用校验器只会让合法请求被当成缺失参数拒掉）。
      if (!Array.isArray(raw)) {
        throw new ToolRequestRejected('TOOL_ARGUMENT_INVALID', `工具 ${spec.name} 的 ${key} 必须是数组。`);
      }
      const items = asObject(property.items);
      if (items?.type === 'object') {
        for (const item of raw) {
          if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            throw new ToolRequestRejected('TOOL_ARGUMENT_INVALID',
              `工具 ${spec.name} 的 ${key} 每一项都必须是对象。`);
          }
        }
      }
      if (items?.type === 'string') {
        for (const item of raw) {
          if (typeof item !== 'string') {
            throw new ToolRequestRejected('TOOL_ARGUMENT_INVALID',
              `工具 ${spec.name} 的 ${key} 每一项都必须是字符串。`);
          }
        }
      }
      normalized[key] = raw as readonly JsonValue[];
      continue;
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

/**
 * 一次冲突适配的判定。
 *
 * 产品规则（prompts/agent-native-tools.md 二.5/二.6）：基线变化时保留用户的新修改，
 * 重新读取并生成新的变化集，能明确区分且互不冲突的允许自动适配一次；再次冲突、
 * 影响不能判断或需要用户确认时停止。因此这里只回答「这一次请求是不是对某个已结算
 * 冲突的合法重新适配」，不执行任何写入，也不猜测模型意图。
 */
export type ToolAdaptationDecision =
  | { readonly kind: 'PLAIN' }
  | { readonly kind: 'ADAPT'; readonly of: string; readonly path: string }
  | { readonly kind: 'STOP'; readonly reason: string; readonly detail: string };

interface ConflictFact {
  readonly rowId: string;
  readonly path: string;
  readonly actualBaselineSha256: string | null;
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** 从已结算行的真实回执里取冲突事实；回执形状不对就当作没有冲突，不凭空推断。 */
function conflictsOf(row: RunToolCallRow): readonly ConflictFact[] {
  if (row.tool_name !== 'apply_changeset' || row.status !== 'SETTLED') return [];
  const changes = row.result_ref?.changes;
  if (!Array.isArray(changes)) return [];
  const facts: ConflictFact[] = [];
  for (const entry of changes) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const file = entry as JsonObject;
    if (file.status !== 'CONFLICT' || typeof file.path !== 'string') continue;
    facts.push({ rowId: row.id, path: file.path,
      actualBaselineSha256: typeof file.actualBaselineSha256 === 'string'
        ? file.actualBaselineSha256.toLowerCase() : null });
  }
  return facts;
}

function contentOf(row: RunToolCallRow, path: string): string | undefined {
  const changes = row.arguments?.changes;
  if (!Array.isArray(changes)) return undefined;
  for (const entry of changes) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const change = entry as JsonObject;
    if (typeof change.path === 'string' && samePath(change.path, path) &&
        typeof change.content === 'string') return change.content;
  }
  return undefined;
}

/**
 * 判定一次 `apply_changeset` 是否是对已结算冲突的合法重新适配。
 *
 * 「合法」在这里是可核对的三件事，而不是模型自称：它针对的确实是一个已结算的真实冲突；
 * 它的基线是冲突回执里实测到的当前摘要（证明真的重读过）；它的目标内容与被拒那次不同
 * （挡住「新基线 hash + 旧目标全文」这种冒充适配）。一次只适配一个路径，且只适配原始
 * 请求——适配过的行自己不能再成为新的适配来源。
 */
export function decideToolAdaptation(input: {
  readonly prior: readonly RunToolCallRow[];
  readonly changes: readonly { readonly path: string; readonly action: string;
    readonly content?: string; readonly baselineSha256?: string }[];
}): ToolAdaptationDecision {
  const facts = input.prior.flatMap(conflictsOf);
  if (facts.length === 0) return { kind: 'PLAIN' };
  const matched = input.changes
    .map((change) => ({ change, fact: facts.find((fact) => samePath(fact.path, change.path)) }))
    .filter((entry) => entry.fact !== undefined);
  if (matched.length === 0) return { kind: 'PLAIN' };
  if (matched.length > 1) {
    return { kind: 'STOP', reason: 'TOOL_ADAPTATION_AMBIGUOUS',
      detail: `一次自动适配只能针对一个明确冲突的路径，本次请求同时涉及 ${matched.length} 个冲突路径。` };
  }
  const only = matched[0]!;
  const fact = only.fact!;
  const origin = input.prior.find((row) => row.id === fact.rowId)!;
  // 深度限制：适配过的行不再是新的适配来源；原始请求被适配过一次也不再允许第二次。
  if (origin.adaptation_of !== null ||
      input.prior.some((row) => row.adaptation_of === fact.rowId)) {
    return { kind: 'STOP', reason: 'TOOL_ADAPTATION_REQUIRES_HUMAN',
      detail: `路径 ${fact.path} 的冲突已经自动适配过一次；再次冲突需要用户确认，不得继续自动改写。` };
  }
  if (fact.actualBaselineSha256 === null) {
    return { kind: 'STOP', reason: 'TOOL_ADAPTATION_TARGET_MISSING',
      detail: `路径 ${fact.path} 在冲突后已不存在；是否继续需要用户确认。` };
  }
  const baseline = only.change.baselineSha256?.toLowerCase();
  if (baseline !== fact.actualBaselineSha256) {
    // 把「冲突回执实测到的当前摘要」原样带给模型：否则它只能盲猜哪个摘要才对，
    // 而反复猜同一个值只会把一次可修正的冲突拖成终止。
    return { kind: 'STOP', reason: 'TOOL_ADAPTATION_STALE_BASELINE',
      detail: `路径 ${fact.path} 的基线不是冲突回执实测到的当前摘要 `
        + `(回执 ${fact.actualBaselineSha256 ?? 'null'}，本次 ${baseline ?? '缺失'})；`
        + '请按该摘要重新读取后再提交。' };
  }
  if (only.change.content !== undefined && only.change.content === contentOf(origin, fact.path)) {
    return { kind: 'STOP', reason: 'TOOL_ADAPTATION_CONTENT_UNCHANGED',
      detail: `路径 ${fact.path} 的目标内容与被拒那次完全相同；新的基线配旧目标不构成适配。` };
  }
  return { kind: 'ADAPT', of: fact.rowId, path: fact.path };
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
  readonly preamble?: string;
  readonly reasoningContent?: string | undefined;
  readonly plan: ToolLoopPlan;
  readonly usedCalls: number;
  readonly cancelled: boolean;
}): Promise<PersistedToolRound> {
  const repository = new RunToolCallRepository(db);
  const rows: RunToolCallRow[] = [];
  let rejected = 0;
  // 额度按本轮内已接受的请求递减。只数被拒的请求会让同一轮的多个调用全部越过上限。
  let remaining = input.plan.intent.max_tool_calls - input.usedCalls;
  // 冲突适配要对着已结算的真实回执判定，因此读本 Run 全部历史行（含本轮刚插入的）。
  const prior = await repository.listByRun(input.runId);
  for (const [ordinal, call] of input.calls.entries()) {
    const definition = input.plan.allowed.get(call.name);
    let argumentsValue: JsonObject | null = null;
    let rejection: ToolRequestRejected | null = null;
    let adaptation: { readonly of: string; readonly path: string } | null = null;
    if (input.cancelled) {
      rejection = new ToolRequestRejected('TOOL_LOOP_CANCELLED', '本次执行已被取消，请求未派发。');
    } else if (input.round >= input.plan.intent.max_rounds) {
      rejection = new ToolRequestRejected('TOOL_LOOP_ROUNDS_EXHAUSTED',
        '本次工具轮次预算已用尽；请用已有结果收尾，不要继续请求工具。');
    } else if (definition === undefined) {
      rejection = new ToolRequestRejected('TOOL_UNKNOWN', `工具 ${call.name} 不在本次允许的工具词表内。`);
    } else if (remaining <= 0) {
      rejection = new ToolRequestRejected('TOOL_LOOP_BUDGET_EXHAUSTED',
        '本次工具调用预算已用尽；请用已有结果收尾，不要继续请求工具。');
    } else {
      try {
        argumentsValue = definition.actionType === 'APPLY_CHANGESET'
          // 变更声明比通用 schema 更严格：基线与内容必须成套且自洽。
          ? normalizeToolChanges(call.arguments.changes)
          : validateToolArguments(definition.spec, call.arguments);
        if (definition.actionType === 'APPLY_CHANGESET') {
          const decision = decideToolAdaptation({ prior,
            changes: changesOf(argumentsValue) });
          if (decision.kind === 'STOP') {
            argumentsValue = null;
            rejection = new ToolRequestRejected(decision.reason, decision.detail);
          } else if (decision.kind === 'ADAPT') {
            adaptation = { of: decision.of, path: decision.path };
          }
        }
      }
      catch (error) {
        argumentsValue = null;
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
      tool_name: call.name, arguments: argumentsValue ?? {}, arguments_sha256: argumentsSha,
      assistant_message: ordinal === 0 ? { content: input.preamble ?? '',
        ...(input.reasoningContent === undefined ? {}
          : { reasoning_content: input.reasoningContent }) } : null,
      adaptation_of: adaptation?.of ?? null, adapted_path: adaptation?.path ?? null });
    if (rejection !== null) {
      await repository.reject(id, rejection.reason, rejection.message);
      rejected += 1;
      rows.push({ ...row, status: 'REJECTED' });
      continue;
    }
    remaining -= 1;
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
/**
 * 执行时使用的绝对目标。
 *
 * 根内相对子目录直接拼到受管根上；Gateway prepare 仍会按 canonicalRelativePath
 * 重新归一并做根内与保护路径判定，因此这里的拼接只是候选值，不是最终裁决。
 */
export function toolTargetFor(plan: ToolLoopPlan, definition: InternalToolDefinition,
  args: JsonObject, origin?: GatewayOrigin): string {
  if (definition.capability === 'COMPUTER_READ' || definition.capability === 'COMPUTER_INPUT') {
    // Computer 动作没有受管根：目标是整台电脑的合成值，prepare 按同一常量归一切。
    return COMPUTER_DESKTOP_TARGET;
  }
  if (definition.capability === 'BROWSER_READ' || definition.capability === 'BROWSER_ACTION' ||
      definition.capability === 'BROWSER_COMMIT') {
    // 0105: 浏览器目标按站点收窄：origin 来自本次导航目标或该页最近一次已知 origin，
    // 同步只读内存，不在这里启动浏览器。拿不到就退到 browser://unknown。
    return origin === undefined
      ? BROWSER_UNKNOWN_TARGET : browserTargetForTool(origin, args);
  }
  if (definition.capability === 'GIT_READ' || definition.capability === 'FILE_WRITE' ||
      definition.capability === 'CLI_RUN' || definition.capability === 'GITHUB_READ') {
    // 0103: GitHub 查询与 Git 只读同形——目标就是受管根本身，仓库身份由适配器在该目录
    // 本地解析 remote 得到，不接受调用方指定的仓库名。
    return plan.canonicalRoot;
  }
  const relative = typeof args.relative_path === 'string' && args.relative_path !== ''
    ? args.relative_path : undefined;
  return join(plan.canonicalRoot, relative ?? '');
}

/** 一次变化集最多 8 项：超出时模型应当分批，避免一次性制造难以核对的大片改动。 */
export const MAX_TOOL_CHANGES = 8;

/**
 * 校验模型给出的一次变更声明。
 *
 * 基线摘要由模型从实际读取结果带回来，但**不能因此信任它**：Gateway prepare 会按同一
 * 声明重新校验格式，落盘前还会实测比对。这里只挡明显不合法的东西，让失败在派发前
 * 就以类型化原因回到模型，而不是留下一条半可信的动作。
 */
export function normalizeToolChanges(raw: unknown): JsonObject {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TOOL_CHANGES) {
    throw new ToolRequestRejected('TOOL_CHANGESET_INVALID',
      `apply_changeset 需要 1 到 ${MAX_TOOL_CHANGES} 项变更。`);
  }
  const normalized: JsonValue[] = [];
  for (const [index, item] of raw.entries()) {
    const change = asObject(item as JsonValue);
    const action = change?.action;
    const path = change?.path;
    if (change === undefined || typeof path !== 'string' || path === '' ||
        (action !== 'CREATE' && action !== 'MODIFY' && action !== 'DELETE')) {
      throw new ToolRequestRejected('TOOL_CHANGESET_INVALID', `第 ${index + 1} 项变更缺少合法 path 或 action。`);
    }
    // 基线与目标摘要必须是真正的 SHA-256，避免把「看起来像 hash」的垃圾值当证据。
    const baseline = change.baselineSha256;
    if (action !== 'CREATE' &&
        (typeof baseline !== 'string' || !/^[0-9a-f]{64}$/.test(baseline))) {
      throw new ToolRequestRejected('TOOL_CHANGESET_BASELINE_REQUIRED',
        '修改或删除必须带实际读取到的 64 位基线摘要。');
    }
    if (action === 'CREATE' && baseline !== undefined) {
      throw new ToolRequestRejected('TOOL_CHANGESET_BASELINE_FORBIDDEN', '新建不接受基线摘要。');
    }
    const content = change.content;
    if (action !== 'DELETE' && typeof content !== 'string') {
      throw new ToolRequestRejected('TOOL_CHANGESET_CONTENT_REQUIRED',
        '新建或修改必须提供新的完整内容。');
    }
    if (action === 'DELETE' && content !== undefined) {
      throw new ToolRequestRejected('TOOL_CHANGESET_CONTENT_FORBIDDEN', '删除不接受内容。');
    }
    if (typeof content === 'string' && Buffer.byteLength(content, 'utf8') > 64 * 1024) {
      throw new ToolRequestRejected('TOOL_CHANGESET_CONTENT_TOO_LARGE',
        '单文件内容超过 64 KiB，请分批修改。');
    }
    normalized.push({ path, action, ...(typeof content === 'string' ? { content } : {}),
      ...(typeof baseline === 'string' ? { baselineSha256: baseline } : {}) });
  }
  return { changes: normalized as unknown as JsonValue };
}

/** 已通过校验的变更声明；normalizeToolChanges 保证形状，这里只做一次窄化读取。 */
function changesOf(argumentsValue: JsonObject): readonly {
  readonly path: string; readonly action: string;
  readonly content?: string; readonly baselineSha256?: string;
}[] {
  const changes = argumentsValue.changes;
  if (!Array.isArray(changes)) return [];
  return changes.map((entry) => {
    const change = typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? entry as JsonObject : {};
    return {
      path: typeof change.path === 'string' ? change.path : '',
      action: typeof change.action === 'string' ? change.action : '',
      ...(typeof change.content === 'string' ? { content: change.content } : {}),
      ...(typeof change.baselineSha256 === 'string'
        ? { baselineSha256: change.baselineSha256 } : {}),
    };
  });
}

/** 只把该工具词表允许的参数交给 Gateway；模型多带的字段不会变成动作参数。 */
export function gatewayParamsFor(definition: InternalToolDefinition,
  args: JsonObject): JsonObject {
  if (definition.actionType === 'APPLY_CHANGESET') {
    return { changes: Array.isArray(args.changes) ? args.changes : [] };
  }
  if (definition.actionType === 'READ_CHANGE_SET') {
    return { operation_id: args.operation_id ?? '' };
  }
  if (definition.actionType === 'CLI_RUN') {
    // 模型只提供 check_id；真实程序与参数由冻结检查决定，这里不展开任何命令内容。
    return { check_id: args.check_id ?? '' };
  }
  if (definition.actionType === 'COMPUTER_MOVE') {
    return { x: args.x ?? 0, y: args.y ?? 0 };
  }
  if (definition.actionType === 'COMPUTER_CLICK') {
    return { x: args.x ?? 0, y: args.y ?? 0,
      ...(typeof args.button === 'string' ? { button: args.button } : {}) };
  }
  if (definition.actionType === 'COMPUTER_DOUBLE_CLICK') {
    return { x: args.x ?? 0, y: args.y ?? 0 };
  }
  if (definition.actionType === 'COMPUTER_SCROLL') {
    return { ...(typeof args.delta_x === 'number' ? { delta_x: args.delta_x } : {}),
      ...(typeof args.delta_y === 'number' ? { delta_y: args.delta_y } : {}) };
  }
  if (definition.actionType === 'COMPUTER_DRAG') {
    return { start: args.start ?? {}, end: args.end ?? {},
      ...(typeof args.duration_ms === 'number' ? { duration_ms: args.duration_ms } : {}) };
  }
  if (definition.actionType === 'COMPUTER_ACTIVATE_WINDOW') {
    return { window_id: args.window_id ?? '' };
  }
  if (definition.actionType === 'COMPUTER_TYPE') {
    return { text: args.text ?? '',
      ...(typeof args.delay_ms === 'number' ? { delay_ms: args.delay_ms } : {}) };
  }
  if (definition.actionType === 'COMPUTER_KEYPRESS') {
    return { key: args.key ?? '' };
  }
  if (definition.actionType === 'COMPUTER_HOTKEY') {
    return { keys: Array.isArray(args.keys) ? args.keys : [] };
  }
  if (definition.actionType === 'COMPUTER_SCREENSHOT') {
    return { ...(typeof args.target === 'string' ? { target: args.target } : {}),
      ...(typeof args.window_id === 'string' ? { window_id: args.window_id } : {}) };
  }
  if (definition.actionType === 'COMPUTER_GET_WINDOWS') {
    return {};
  }
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
  // 0103: GitHub 只读。逐动作白名单转发，与 Computer 同一纪律——模型多带的字段不会
  // 变成 Gateway 参数，缺必填参数交给 prepare 以类型化校验拒掉。
  if (definition.actionType === 'GITHUB_REPO_VIEW') return {};
  if (definition.actionType === 'GITHUB_PR_VIEW') {
    return Number.isInteger(args.number) ? { number: args.number as number } : {};
  }
  if (definition.actionType === 'GITHUB_PR_LIST' || definition.actionType === 'GITHUB_ISSUE_LIST') {
    return { ...(typeof args.state === 'string' ? { state: args.state } : {}),
      ...(typeof args.limit === 'number' ? { limit: args.limit } : {}) };
  }
  // 0105: 浏览器。逐动作白名单转发；page_id 保持字符串（适配层负责解析成上游的数字 id），
  // 缺必填参数交给 prepare 以类型化校验拒掉。
  if (definition.capability === 'BROWSER_READ' || definition.capability === 'BROWSER_ACTION' ||
      definition.capability === 'BROWSER_COMMIT') {
    const page = typeof args.page_id === 'string' && args.page_id !== ''
      ? { page_id: args.page_id } : {};
    switch (definition.actionType) {
      case 'BROWSER_LIST_PAGES':
      case 'BROWSER_READ_PAGE':
      case 'BROWSER_SCREENSHOT':
        return { ...page };
      case 'BROWSER_NEW_PAGE':
        return { ...(typeof args.url === 'string' ? { url: args.url } : {}) };
      case 'BROWSER_WAIT_FOR':
        return { ...page, text: typeof args.text === 'string' ? args.text : '',
          ...(typeof args.timeout_ms === 'number' ? { timeout_ms: args.timeout_ms } : {}) };
      case 'BROWSER_NAVIGATE':
        return { ...page,
          ...(typeof args.url === 'string' ? { url: args.url } : {}),
          ...(typeof args.history === 'string' ? { history: args.history } : {}) };
      case 'BROWSER_CLICK':
        return { ...page, uid: typeof args.uid === 'string' ? args.uid : '',
          ...(args.double === true ? { double: true } : {}) };
      case 'BROWSER_SUBMIT_FORM':
        return { ...page, uid: typeof args.uid === 'string' ? args.uid : '' };
      case 'BROWSER_FILL':
        return { ...page, uid: typeof args.uid === 'string' ? args.uid : '',
          text: typeof args.text === 'string' ? args.text : '' };
      case 'BROWSER_PRESS_KEY':
        return { ...page, key: typeof args.key === 'string' ? args.key : '' };
      case 'BROWSER_CLOSE_PAGE':
        return { ...page };
      case 'BROWSER_UPLOAD_FILE':
        return { ...page, uid: typeof args.uid === 'string' ? args.uid : '',
          relative_path: typeof args.relative_path === 'string' ? args.relative_path : '' };
      default:
        return {};
    }
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
          operationResult.outcome === 'FAILED' ||
          typeof operationResult.reason === 'string' });
    }
    const assistant = bucket.find((row) => row.ordinal === 0)?.assistant_message;
    turns.push({ calls, results: turnResults,
      preamble: typeof assistant?.content === 'string' ? assistant.content : '',
      ...(typeof assistant?.reasoning_content === 'string'
        ? { reasoningContent: assistant.reasoning_content } : {}) });
  }
  return turns;
}

/** 便于调用方在事务外读取 Operation 结果：一次 Attempt 的 SETTLED 行按 operation 取结果。 */
export function operationIdsOf(rows: readonly RunToolCallRow[]): readonly string[] {
  return rows.filter((row) => row.operation_id !== null).map((row) => row.operation_id!);
}

/**
 * 该 Operation 是否是本次 Run 的模型工具请求。
 *
 * 工具动作身份不是 Delegate 冻结的，因此凡是「按冻结清单判断这个动作是否合法」的地方
 * ——批准后是否排 RESUME、图检查点能否被唤醒——都必须同时认这两种来源。判定收敛到
 * 这一个谓词，避免两处各写一份而漂移。
 */
export async function isToolLoopOperation(db: DbExecutor, runId: string,
  operationId: string | null): Promise<boolean> {
  if (operationId === null) return false;
  return (await new RunToolCallRepository(db).countByOperation(runId, operationId)) > 0;
}
