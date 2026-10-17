import type { AssistMessageRow, AssistSessionRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { recordModelInvocation } from './model-call-recorder.js';
import { createRepositories } from './unit-of-work.js';
import { SessionToolCallRepository } from '../assist/session-tool-call-repository.js';
import {
  assistantReadOrigin, assistantToolNames, settleSessionReadonlyToolCall,
} from './assistant-readonly-round.js';
import { declaredToolSpecs, type InternalToolName } from '../workflow/tool-catalog.js';
import { selectRuntimeSystemPrompt } from '../workflow/prompts/index.js';
import type { AssistModelPort, AssistResult, ModelToolTurn, ModelToolTurnResult,
  ModelUsage, AssistRequest } from '../workflow/fake-model-port.js';
import { recheckAssistSources, loadAssistSourceContent, type FrozenSourceRef }
  from './assist-runner.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { readLearningRoundState } from './learning-records.js';

/**
 * 学习轮次（0072 / ADR-020 §4、§6）。
 *
 * 与助手档的两处**实质差别**，其余（领取、心跳、取消轮询、CAS 结算）完全共用：
 *   1. 每次模型调用都进 `recordModelInvocation` 账本。助手只读轮次直接调用端口、只把
 *      usage 汇总到消息行——学习模式**明确不照抄**这个缺口（提示词 §10）。
 *   2. 结构化信封：一次调用同时产出正文与有限类型化候选增量，不额外发起评分调用。
 *
 * 读路径本身与助手档共用 `settleSessionReadonlyToolCall`：同一个 Gateway 来源
 * （`ASSISTANT_READ`）、同一张 `session_tool_calls` 账本，不新开第二条准入路径。
 */

const DEFAULT_MAX_ROUNDS = 6;
const DEFAULT_MAX_TOOL_CALLS = 8;
const HISTORY_LIMIT = 20;

const EMPTY_USAGE: ModelUsage = { inputTokens: null, outputTokens: null,
  cacheReadTokens: null, cacheCreationTokens: null };

function addUsage(a: ModelUsage, b: ModelUsage | undefined): ModelUsage {
  if (b === undefined) return a;
  const sum = (left: number | null | undefined, right: number | null | undefined): number | null => {
    const l = left ?? null;
    const r = right ?? null;
    return l === null && r === null ? null : (l ?? 0) + (r ?? 0);
  };
  return { inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    cacheReadTokens: sum(a.cacheReadTokens, b.cacheReadTokens),
    cacheCreationTokens: sum(a.cacheCreationTokens, b.cacheCreationTokens) };
}

/**
 * 学习搭档的系统边界（单一来源的兼容再导出）。
 *
 * 正文已迁到 `workflow/prompts/conversation-prompts.ts` 的 `learningPartnerSystemPrompt()`：
 * 学习状态与项目材料是**数据**不是指令；教学回答不是验收结论；输出必须是
 * `{answer, increments}` 两个键的信封，增量只写本轮有依据的变化。
 */
export { learningPartnerSystemPrompt as learningSystemPrompt }
  from '../workflow/prompts/conversation-prompts.js';

export interface LearningRoundInput {
  readonly session: AssistSessionRow;
  readonly message: AssistMessageRow;
  /** 当前连接可用的工具名；每轮重新计算，不从任何快照读。 */
  readonly availableTools: readonly InternalToolName[];
  readonly modelPort: AssistModelPort;
  /** Optional per-message model router; owns a separate ledger row for every candidate call. */
  readonly invokeAssist?: (request: AssistRequest) => Promise<AssistResult>;
  readonly signal: AbortSignal;
  readonly storage: ManagedContentStore;
  readonly learningState: JsonObject;
  readonly material: readonly JsonObject[];
  readonly maxRounds?: number | undefined;
  readonly maxToolCalls?: number | undefined;
}

export type LearningRoundOutcome =
  | { readonly kind: 'CONTENT'; readonly content: string; readonly usage: ModelUsage;
      readonly providerRequestIds: readonly string[]; readonly rounds: number;
      readonly increments: readonly JsonObject[]; readonly schemaError: string | null }
  | { readonly kind: 'CANCELLED'; readonly providerRequestId: string | null;
      readonly usage: ModelUsage; readonly providerRequestIds: readonly string[] }
  | { readonly kind: 'FAILED'; readonly errorCode: string; readonly usage: ModelUsage;
      readonly providerRequestIds: readonly string[] };

/**
 * 跑完一次学习轮次。
 *
 * 循环形态与助手档一致：模型给工具请求 → 逐个校验并派发 → 结果回传 → 直到模型给出正文。
 * 差别是**每一次** `modelPort.assist` 都被 `recordModelInvocation` 包住，包括工具续轮与重试。
 */
export async function runLearningRounds(db: DbExecutor, input: LearningRoundInput):
Promise<LearningRoundOutcome> {
  const { session, message } = input;
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxToolCalls = input.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const declared = declaredToolSpecs(assistantToolNames(input.availableTools));
  const { system } = selectRuntimeSystemPrompt({ kind: 'LEARNING_PARTNER',
    state: input.learningState, material: input.material });
  const turns = await learningTurns(db, input.storage, session, message);
  const repository = new SessionToolCallRepository(db);
  const toolTurns: ModelToolTurn[] = [];
  const providerRequestIds: string[] = [];
  let usage: ModelUsage = EMPTY_USAGE;
  let usedCalls = 0;

  for (let round = 0; round <= maxRounds; round += 1) {
    if (input.signal.aborted || await isCancelRequested(db, message.id)) {
      return { kind: 'CANCELLED', providerRequestId: providerRequestIds.at(-1) ?? null,
        usage, providerRequestIds };
    }
    let response: AssistResult;
    // 逐次计量：begin 行在调用 Provider 之前提交，进程丢失留下 STARTED 而不是伪造零用量。
    try {
      const request: AssistRequest = { intent: 'DISCUSS', system, turns,
          tools: declared, toolTurns, signal: input.signal,
          learning: { state: input.learningState, material: input.material } };
      if (input.invokeAssist !== undefined) response = await input.invokeAssist(request);
      else {
        const recorded = await recordModelInvocation(db, {
          origin: { workspaceId: session.workspace_id, kind: 'ASSIST',
            assistMessageId: message.id },
          identity: input.modelPort.identity,
          signal: input.signal,
          invoke: async () => input.modelPort.assist(request),
          settle: (result) => result.kind === 'CANCELLED'
            ? { status: 'CANCELLED', providerRequestId: result.providerRequestId ?? null,
              ...(result.usage === undefined ? {} : { usage: result.usage }) }
            : { status: 'COMPLETED', providerRequestId: result.providerRequestId,
              usage: result.usage },
        });
        response = recorded.result;
      }
    } catch {
      return { kind: 'FAILED', errorCode: 'MODEL_FAILED', usage, providerRequestIds };
    }
    if (response.kind === 'CANCELLED') {
      return { kind: 'CANCELLED', providerRequestId: response.providerRequestId ?? null,
        usage, providerRequestIds };
    }
    providerRequestIds.push(response.providerRequestId);
    usage = addUsage(usage, response.usage);

    if (response.kind === 'CONTENT') {
      return { kind: 'CONTENT', content: response.content, usage, providerRequestIds,
        rounds: round, increments: response.learning?.increments ?? [],
        schemaError: response.learning?.schemaError ?? null };
    }

    const results: ModelToolTurnResult[] = [];
    for (const [ordinal, call] of response.calls.entries()) {
      const settled = await settleSessionReadonlyToolCall(db, { session, message,
        availableTools: input.availableTools, repository, round, ordinal, call,
        usedCalls, maxToolCalls, maxRounds,
        // 学习搭档与人设助手共用同一条只读来源解析（ADR-020 §5：学习不获得额外写能力）。
        resolveOrigin: () => assistantReadOrigin(db, session, message.id) });
      usedCalls += 1;
      results.push(settled);
      if (input.signal.aborted || await isCancelRequested(db, message.id)) {
        return { kind: 'CANCELLED', providerRequestId: response.providerRequestId,
          usage, providerRequestIds };
      }
    }
    toolTurns.push({ calls: response.calls, results, preamble: response.preamble,
      reasoningContent: response.reasoningContent });
  }
  return { kind: 'FAILED', errorCode: 'LEARNING_TOOL_ROUNDS_EXHAUSTED', usage, providerRequestIds };
}

/**
 * 本轮的教学轮次输入：会话上下文 + 显式选中资料正文 + 近期已完成历史。
 *
 * 只取近期正文（有界），不重放全部聊天；历史里引用的来源按当前权限与版本重新核对，
 * 失权/不可用的历史轮次直接拒绝装配，而不是静默换成相似资料。
 */
async function learningTurns(db: DbExecutor, storage: ManagedContentStore,
  session: AssistSessionRow, message: AssistMessageRow):
Promise<readonly { role: 'user' | 'assistant'; content: string }[]> {
  const r = createRepositories(db);
  const history = await r.assist.listCompletedHistory(session.id, message.seq, HISTORY_LIMIT);
  for (const entry of history) {
    if (entry.role === 'ASSISTANT' &&
        !(await recheckAssistSources(r, storage, session, entry.sources)).available) {
      throw new Error('LEARNING_HISTORY_SOURCE_UNAVAILABLE');
    }
  }

  const frozenSources = Array.isArray(message.sources) ? message.sources : [];
  const sourceSections: string[] = [];
  for (const raw of frozenSources) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const candidate = raw as JsonObject;
    const kind = candidate.kind;
    const rootId = candidate.root_id;
    const version = candidate.version;
    if (typeof kind !== 'string' || typeof rootId !== 'string' || typeof version !== 'string') continue;
    if (kind !== 'KNOWLEDGE' && kind !== 'MEMORY' && kind !== 'DECISION') continue;
    const ref: FrozenSourceRef = { kind, root_id: rootId, version };
    const loaded = await loadAssistSourceContent(r, storage, session, ref);
    if (loaded.content !== null) sourceSections.push(loaded.section);
  }

  const scopeLines: string[] = ['会话上下文：'];
  if (session.project_id !== null) {
    const project = await r.projects.readProject(session.project_id);
    if (project !== undefined) scopeLines.push(`- Project：${project.title}`);
  }
  if (session.task_id !== null) {
    const task = await r.tasks.readTask(session.task_id);
    if (task !== undefined) scopeLines.push(`- Task：${task.title}（状态 ${task.status}）`);
  }
  scopeLines.push(sourceSections.length === 0
    ? '- 显式选中资料：无。'
    : `- 显式选中资料：${sourceSections.length} 条（正文见下方数据块）。`);

  return [
    { role: 'user' as const, content: [...scopeLines, '', ...sourceSections].join('\n') },
    ...history.filter((entry) => entry.content !== null).map((entry) => ({
      role: entry.role === 'USER' ? 'user' as const : 'assistant' as const,
      content: entry.content ?? '',
    })),
  ];
}

async function isCancelRequested(db: DbExecutor, messageId: string): Promise<boolean> {
  return createRepositories(db).assist.isCancelRequested(messageId);
}

/** 供 runner 复用：本轮相关短状态（有界、可测试的应用规则，不额外调用模型选择）。 */
export { readLearningRoundState };
