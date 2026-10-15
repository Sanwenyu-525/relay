import { createHash, randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  ConversationCandidateStatus, ConversationStateChangeRow, ConversationStateRequestRow,
  InformationRootRow, ProjectBlockerTargetKind, StateChangeKind, StateChangeStatus,
  StateMaintenanceDecision, StateMaintenanceStatus, TaskDependencyKind, TaskRow, TaskStatus,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { computePayloadHash } from '../receipt/payload-hash.js';
import { toDecimalString } from '../shared/decimal.js';
import { interpretationStateMaintenanceSystemPrompt }
  from '../workflow/prompts/interpretation-prompts.js';
import { FakeModelPort, type AssistModelPort, type AssistResult,
  type ConversationInterpretationRequest } from '../workflow/fake-model-port.js';
import { readModelPortConfig } from '../workflow/model-port-config.js';
import { OpenAiCompatibleModelPort } from '../workflow/openai-compatible-model-port.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { listTaskArtifacts } from './artifact-queries.js';
import { runIdempotentCommand, CommandIdReusedError, resolveExistingReceipt,
  type CommandOutcome, type CommandResult } from './command.js';
import { completeHumanTask, type CompleteHumanTaskResult } from './completion-commands.js';
import { applyTaskCreation, prepareTaskCreation } from './create-task.js';
import { createGoal } from './create-goal.js';
import { DomainError, invalidTransition, requiredInputMissing, resourceNotFound,
  validationFailed } from './domain-error.js';
import { addKnowledgeVersion, createDecision, createKnowledge, retireInformation }
  from './information-commands.js';
import { linkProjectGoal, unlinkProjectGoal } from './project-goal-links.js';
import {
  addTaskDependency, cancelTask, removeTaskDependency, setTaskPlanningMetadata,
  type TaskCommandResult,
} from './task-commands.js';
import { runStateCommand, type RunStateCommandResult } from './state-commands.js';
import { lockWritableProjectInWorkspace } from './guards.js';
import { createRepositories, withTransaction, type Repositories } from './unit-of-work.js';
import { recordTaskAcceptanceObservation } from './task-acceptance-trials.js';
import { readAcceptanceTimeStatement } from '../task/acceptance-time-statement.js';
import { createHypothesis } from './hypotheses.js';
import { startWorkSegment, type WorkSegmentTaskInput } from './work-segments.js';

/**
 * 自然语言状态维护（总纲 §0.8.1）：对话里一句明确的状态维护指令沿原有领域 Owner 真实生效。
 *
 * 与 conversation-execution 同一套纪律：授权来源永远是 source_message_id 指向的那条原用户
 * 消息；模型只解释候选，候选先落库；每个阶段（解释 / 应用 / 撤回）与每条变更的命令身份在
 * 结算时就固定，重放只回读原回执，不会产生第二组对象或版本。变更逐条经既有 Owner 短事务
 * 生效，整组撤回按逆序补偿；没有既有撤销入口的事实如实报 UNDO_ENTRY_MISSING，不假装撤销。
 */

const MAX_STATE_CHANGES = 12;
const MAX_QUESTIONS = 2;
const MAX_DECISION_AFFECTED = 20;
/** 知识/决策正文的候选上限：Owner 自身允许 256KiB，这里按对话场景收紧。 */
const MAX_CONTENT = 32768;
const DEFAULT_STATE_CLARIFICATION = '这次要维护哪一项状态？请说明对象与要做的改变。';

/**
 * 进程内在途的解释：同一请求行的模型调用最多一个 Owner。
 * 只用于挡掉重复的模型外呼，不承载任何业务状态——请求行与候选仍是唯一事实源；
 * 进程退出后集合自然清空，遗留的 PENDING 行可由下一次原关系重入恢复。
 */
const inFlightInterpretations = new Set<string>();

/**
 * 项目状态维护解释的 system 边界（单一来源）。
 *
 * 正文已迁到 `workflow/prompts/interpretation-prompts.ts` 的
 * `interpretationStateMaintenanceSystemPrompt()`，由统一路由入口组合公共核心与
 * 「只解释、不写业务事实」的专用规则。这里保留原有导出名，避免出现两份可分别
 * 修改的正文。
 *
 * 它与执行解释是**两套不同输出**（`DISCUSS/CLARIFY/MAINTAIN` 与有限 changes），
 * 不能互相串用；上下文与既有回执只帮助解析对象，不构成授权，也不替代实际写入。
 */
export const STATE_MAINTENANCE_SYSTEM_PROMPT = interpretationStateMaintenanceSystemPrompt();

/* -------------------------------------------------------------------------- */
/* 候选形状与确定性校验                                                        */
/* -------------------------------------------------------------------------- */

export type StateChangeCandidate =
  | { readonly kind: 'START_WORK_SEGMENT'; readonly title: string; readonly expectation: string; readonly task_titles: readonly string[] }
  | { readonly kind: 'CREATE_HYPOTHESIS'; readonly title: string; readonly claim: string; readonly method: string; readonly criterion: string }
  | { readonly kind: 'SET_PHASE'; readonly phase: string }
  | { readonly kind: 'SET_NEXT_ACTION'; readonly task_title: string | null }
  | { readonly kind: 'CREATE_TASK'; readonly title: string; readonly objective: string }
  | { readonly kind: 'ADD_TASK_DEPENDENCY'; readonly task_title: string;
      readonly depends_on_task_title: string; readonly dependency_kind: 'BLOCKS' | 'INFORMS' }
  | { readonly kind: 'ADD_BLOCKER'; readonly target_kind: 'PROJECT' | 'TASK' | 'GOAL';
      readonly task_title: string | null; readonly goal_title: string | null;
      readonly reason: string }
  | { readonly kind: 'RESOLVE_BLOCKER'; readonly target_kind: 'PROJECT' | 'TASK';
      readonly task_title: string | null; readonly reason: string }
  | { readonly kind: 'CREATE_GOAL'; readonly title: string; readonly description: string }
  | { readonly kind: 'LINK_GOAL'; readonly goal_title: string }
  | { readonly kind: 'CREATE_DECISION'; readonly title: string; readonly choice: string;
      readonly rationale: string }
  | { readonly kind: 'CREATE_KNOWLEDGE'; readonly title: string; readonly content: string }
  | { readonly kind: 'VERSION_KNOWLEDGE'; readonly knowledge_title: string;
      readonly content: string }
  | { readonly kind: 'SET_TASK_PLANNING'; readonly task_title: string;
      readonly priority?: 'LOW' | 'NORMAL' | 'HIGH' | null;
      readonly due_local_date?: string | null }
  /** Slice B：外部成果只读核对（不完成、不接受）。 */
  | { readonly kind: 'SYNC_EXTERNAL_RESULT'; readonly task_title: string }
  /** Slice B：明确的完成与接受指令，沿原完成 Owner 提交。 */
  | { readonly kind: 'COMPLETE_TASK'; readonly task_title: string }
  | { readonly kind: 'REPORT_ACCEPTANCE_TIME'; readonly task_title: string | null;
      readonly sample_label: string | null; readonly preparation_ms?: number; readonly total_acceptance_ms?: number }
  /** 第五节：自然语言撤回——解析同会话唯一已生效调整，复用按钮撤回用例。 */
  | { readonly kind: 'UNDO_STATE_CHANGE' };

export type StateDecisionRequired = {
  readonly summary: string;
  readonly question: string;
  readonly affected: readonly string[];
  /**
   * 因这项决定而**等待**的变更序号；null = 整组都等（缺省，最保守）。
   * 独立且明确的修改不因另一项必要决定被整组冻结（总纲 §0.8.1「连带影响」）。
   */
  readonly blocked_changes: readonly number[] | null;
};

export type StateMaintenanceCandidate =
  | { readonly decision: 'DISCUSS'; readonly questions: readonly string[] }
  | { readonly decision: 'CLARIFY'; readonly questions: readonly string[] }
  | { readonly decision: 'MAINTAIN'; readonly questions: readonly string[];
      readonly changes: readonly StateChangeCandidate[];
      readonly decision_required: StateDecisionRequired | null };

export type StateMaintenanceValidation =
  | { readonly ok: true; readonly candidate: StateMaintenanceCandidate }
  | { readonly ok: false; readonly reason: string };

const CHANGE_KINDS: readonly StateChangeKind[] = [
  'CREATE_GOAL', 'LINK_GOAL', 'CREATE_KNOWLEDGE', 'VERSION_KNOWLEDGE', 'CREATE_DECISION',
  'CREATE_TASK', 'ADD_TASK_DEPENDENCY', 'SET_NEXT_ACTION', 'SET_PHASE', 'ADD_BLOCKER',
  'RESOLVE_BLOCKER', 'SET_TASK_PLANNING', 'SYNC_EXTERNAL_RESULT', 'COMPLETE_TASK',
  'UNDO_STATE_CHANGE',
  'REPORT_ACCEPTANCE_TIME',
  'CREATE_HYPOTHESIS',
  'START_WORK_SEGMENT',
];

function candidateText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max
    ? value.trim() : undefined;
}

type ChangeParseResult =
  | { readonly ok: true; readonly change: StateChangeCandidate }
  | { readonly ok: false; readonly reason: string };

/**
 * 解析单个变更条目。任何形状或白名单问题都让整单退回聚焦澄清：
 * 静默丢弃非法条目会让「一部分生效」被显示成「整组生效」，这是不诚实的成功宣告。
 */
function parseChange(raw: unknown): ChangeParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: '变更条目必须是对象。' };
  }
  const body = raw as Record<string, unknown>;
  const kind = body.kind;
  if (typeof kind !== 'string' || !CHANGE_KINDS.includes(kind as StateChangeKind)) {
    return { ok: false, reason: `变更 kind ${String(kind)} 不在支持范围内。` };
  }
  const invalid = (reason: string): ChangeParseResult => ({ ok: false, reason });
  switch (kind as StateChangeKind) {
    case 'START_WORK_SEGMENT': {
      const title = candidateText(body.title, 200);
      const expectation = candidateText(body.expectation, 4000);
      const titles = body.task_titles;
      if (title === undefined || expectation === undefined || !Array.isArray(titles) || titles.length < 1 || titles.length > 64 ||
          titles.some((t) => candidateText(t, 200) === undefined)) return invalid('请说明本段既有任务范围和确认预期。');
      return { ok: true, change: { kind: 'START_WORK_SEGMENT', title, expectation, task_titles: titles.map((t) => String(t).trim()) } };
    }
    case 'CREATE_HYPOTHESIS': {
      const title = candidateText(body.title, 200);
      const claim = candidateText(body.claim, 4000);
      const method = candidateText(body.method, 4000);
      const criterion = candidateText(body.criterion, 4000);
      if (title === undefined || claim === undefined || method === undefined || criterion === undefined) {
        return invalid('建档假设需要明确主张、验证方法和判断标准，请补充缺少的内容。');
      }
      return { ok: true, change: { kind: 'CREATE_HYPOTHESIS', title, claim, method, criterion } };
    }
    case 'REPORT_ACCEPTANCE_TIME': {
      const taskTitle = body.task_title == null ? null : candidateText(body.task_title, 200);
      const sampleLabel = body.sample_label == null ? null : candidateText(body.sample_label, 1024);
      if (taskTitle === undefined || sampleLabel === undefined) return invalid('需要明确任务标题或试用标签。');
      const preparation = body.preparation_ms;
      const total = body.total_acceptance_ms;
      if ([preparation, total].some((value) => value !== undefined &&
          (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) ||
          (preparation === undefined && total === undefined)) {
        return invalid('请明确准备或整体验收的数字和时间单位。');
      }
      if (typeof preparation === 'number' && typeof total === 'number' && total < preparation) {
        return invalid('整体验收耗时应包含准备成本，请确认总耗时口径。');
      }
      return { ok: true, change: { kind: 'REPORT_ACCEPTANCE_TIME', task_title: taskTitle, sample_label: sampleLabel,
        ...(typeof preparation === 'number' ? { preparation_ms: preparation } : {}),
        ...(typeof total === 'number' ? { total_acceptance_ms: total } : {}) } };
    }
    case 'SET_PHASE': {
      const phase = candidateText(body.phase, 64);
      return phase === undefined ? invalid('SET_PHASE 需要不超过 64 字的阶段名。')
        : { ok: true, change: { kind: 'SET_PHASE', phase } };
    }
    case 'SET_NEXT_ACTION': {
      if (body.task_title === undefined || body.task_title === null) {
        return { ok: true, change: { kind: 'SET_NEXT_ACTION', task_title: null } };
      }
      const taskTitle = candidateText(body.task_title, 200);
      return taskTitle === undefined ? invalid('SET_NEXT_ACTION 的任务标题需不超过 200 字。')
        : { ok: true, change: { kind: 'SET_NEXT_ACTION', task_title: taskTitle } };
    }
    case 'CREATE_TASK': {
      const title = candidateText(body.title, 200);
      if (title === undefined) return invalid('CREATE_TASK 需要不超过 200 字的任务标题。');
      const objective = candidateText(body.objective, 2000) ?? title;
      return { ok: true, change: { kind: 'CREATE_TASK', title, objective } };
    }
    case 'ADD_TASK_DEPENDENCY': {
      const taskTitle = candidateText(body.task_title, 200);
      const dependsOn = candidateText(body.depends_on_task_title, 200);
      const dependencyKind = body.dependency_kind;
      if (taskTitle === undefined || dependsOn === undefined) {
        return invalid('ADD_TASK_DEPENDENCY 需要任务标题与前置任务标题。');
      }
      if (dependencyKind !== 'BLOCKS' && dependencyKind !== 'INFORMS') {
        return invalid('ADD_TASK_DEPENDENCY 的 dependency_kind 必须是 BLOCKS 或 INFORMS。');
      }
      return { ok: true, change: { kind: 'ADD_TASK_DEPENDENCY', task_title: taskTitle,
        depends_on_task_title: dependsOn, dependency_kind: dependencyKind } };
    }
    case 'ADD_BLOCKER': {
      const targetKind = body.target_kind;
      const reason = candidateText(body.reason, 500);
      if (reason === undefined) return invalid('ADD_BLOCKER 需要不超过 500 字的原因。');
      if (targetKind !== 'PROJECT' && targetKind !== 'TASK' && targetKind !== 'GOAL') {
        return invalid('ADD_BLOCKER 的 target_kind 必须是 PROJECT、TASK 或 GOAL。');
      }
      const taskTitle = candidateText(body.task_title, 200) ?? null;
      const goalTitle = candidateText(body.goal_title, 200) ?? null;
      if (targetKind === 'TASK' && taskTitle === null) {
        return invalid('给任务登记阻塞需要 task_title。');
      }
      if (targetKind === 'GOAL' && goalTitle === null) {
        return invalid('给目标登记阻塞需要 goal_title。');
      }
      return { ok: true, change: { kind: 'ADD_BLOCKER', target_kind: targetKind,
        task_title: taskTitle, goal_title: goalTitle, reason } };
    }
    case 'RESOLVE_BLOCKER': {
      const targetKind = body.target_kind;
      const reason = candidateText(body.reason, 500);
      if (reason === undefined) return invalid('RESOLVE_BLOCKER 需要不超过 500 字的原因片段。');
      if (targetKind !== 'PROJECT' && targetKind !== 'TASK') {
        return invalid('RESOLVE_BLOCKER 的 target_kind 必须是 PROJECT 或 TASK。');
      }
      const taskTitle = candidateText(body.task_title, 200) ?? null;
      if (targetKind === 'TASK' && taskTitle === null) {
        return invalid('解除任务阻塞需要 task_title。');
      }
      return { ok: true, change: { kind: 'RESOLVE_BLOCKER', target_kind: targetKind,
        task_title: taskTitle, reason } };
    }
    case 'CREATE_GOAL': {
      const title = candidateText(body.title, 200);
      if (title === undefined) return invalid('CREATE_GOAL 需要不超过 200 字的目标标题。');
      return { ok: true, change: { kind: 'CREATE_GOAL', title,
        description: candidateText(body.description, 2000) ?? '' } };
    }
    case 'LINK_GOAL': {
      const goalTitle = candidateText(body.goal_title, 200);
      return goalTitle === undefined ? invalid('LINK_GOAL 需要不超过 200 字的目标标题。')
        : { ok: true, change: { kind: 'LINK_GOAL', goal_title: goalTitle } };
    }
    case 'CREATE_DECISION': {
      const title = candidateText(body.title, 200);
      const choice = candidateText(body.choice, 2000);
      const rationale = candidateText(body.rationale, 2000);
      if (title === undefined || choice === undefined || rationale === undefined) {
        return invalid('CREATE_DECISION 需要标题、选择与理由。');
      }
      return { ok: true, change: { kind: 'CREATE_DECISION', title, choice, rationale } };
    }
    case 'CREATE_KNOWLEDGE': {
      const title = candidateText(body.title, 200);
      const content = candidateText(body.content, MAX_CONTENT);
      if (title === undefined || content === undefined) {
        return invalid('CREATE_KNOWLEDGE 需要标题与正文。');
      }
      return { ok: true, change: { kind: 'CREATE_KNOWLEDGE', title, content } };
    }
    case 'VERSION_KNOWLEDGE': {
      const knowledgeTitle = candidateText(body.knowledge_title, 200);
      const content = candidateText(body.content, MAX_CONTENT);
      if (knowledgeTitle === undefined || content === undefined) {
        return invalid('VERSION_KNOWLEDGE 需要已有知识标题与新正文。');
      }
      return { ok: true, change: { kind: 'VERSION_KNOWLEDGE', knowledge_title: knowledgeTitle,
        content } };
    }
    case 'SET_TASK_PLANNING': {
      const taskTitle = candidateText(body.task_title, 200);
      if (taskTitle === undefined) {
        return invalid('SET_TASK_PLANNING 需要不超过 200 字的任务标题。');
      }
      const rawPriority = body.priority;
      if (rawPriority !== undefined && rawPriority !== null && rawPriority !== 'LOW' &&
          rawPriority !== 'NORMAL' && rawPriority !== 'HIGH') {
        return invalid('SET_TASK_PLANNING 的 priority 只能是 LOW、NORMAL、HIGH 或 null。');
      }
      const rawDue = body.due_local_date;
      if (rawDue !== undefined && rawDue !== null &&
          (typeof rawDue !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(rawDue))) {
        return invalid('SET_TASK_PLANNING 的 due_local_date 必须是 YYYY-MM-DD 或 null。');
      }
      // 只有模型真正给出的字段才改：没提的一律保持原值，不用「缺省 null」把截止日期清掉。
      const change: { kind: 'SET_TASK_PLANNING'; task_title: string;
        priority?: 'LOW' | 'NORMAL' | 'HIGH' | null; due_local_date?: string | null } =
        { kind: 'SET_TASK_PLANNING', task_title: taskTitle };
      if (rawPriority !== undefined) change.priority = rawPriority;
      if (rawDue !== undefined) change.due_local_date = rawDue;
      if (rawPriority === undefined && rawDue === undefined) {
        return invalid('SET_TASK_PLANNING 至少要给出 priority 或 due_local_date 其中之一。');
      }
      if (rawPriority === null && rawDue === null) {
        return invalid('SET_TASK_PLANNING 不能同时把优先级和截止日期都清空。');
      }
      return { ok: true, change };
    }
    case 'SYNC_EXTERNAL_RESULT':
    case 'COMPLETE_TASK': {
      const taskTitle = candidateText(body.task_title, 200);
      if (taskTitle === undefined) {
        return invalid(`${kind} 需要不超过 200 字的任务标题。`);
      }
      const changeKind: 'SYNC_EXTERNAL_RESULT' | 'COMPLETE_TASK' =
        kind === 'COMPLETE_TASK' ? 'COMPLETE_TASK' : 'SYNC_EXTERNAL_RESULT';
      return { ok: true, change: { kind: changeKind, task_title: taskTitle } };
    }
    case 'UNDO_STATE_CHANGE':
      // 目标请求在结算时由应用按同会话事实解析，模型不携带任何 ID。
      return { ok: true, change: { kind: 'UNDO_STATE_CHANGE' } };
  }
}

type DecisionRequiredParse =
  | { readonly ok: true; readonly value: StateDecisionRequired | null }
  | { readonly ok: false; readonly reason: string };

/**
 * decision_required 只有 null / undefined 表示「没有待决定事项」。
 * 非空但形状非法的载荷是**不合法的待决定**，必须整单退回澄清——
 * 把它解析成 null 等于替用户宣布「无需决定」，会直接绕过待决定门。
 */
function parseDecisionRequired(raw: unknown): DecisionRequiredParse {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: '连带影响说明必须是对象，或用 null 表示没有待决定事项。' };
  }
  const body = raw as Record<string, unknown>;
  const summary = candidateText(body.summary, 500);
  const question = candidateText(body.question, 500);
  if (summary === undefined || question === undefined) {
    return { ok: false, reason: '连带影响说明需要 summary 与 question（各不超过 500 字）。' };
  }
  if (!Array.isArray(body.affected)) {
    return { ok: false, reason: '连带影响说明的 affected 必须是标题数组。' };
  }
  const affected: string[] = [];
  for (const item of body.affected) {
    if (typeof item !== 'string' || item.trim() === '') {
      return { ok: false, reason: '连带影响说明的 affected 只能包含非空标题。' };
    }
    affected.push(item.trim());
    if (affected.length >= MAX_DECISION_AFFECTED) break;
  }
  // blocked_changes 缺省 = 整组等待；给了就必须是不重复的整数序号（范围在拿到 changes 后核对）。
  let blockedChanges: readonly number[] | null = null;
  if (body.blocked_changes !== undefined && body.blocked_changes !== null) {
    if (!Array.isArray(body.blocked_changes)) {
      return { ok: false, reason: 'blocked_changes 必须是变更序号数组，或省略表示整组等待。' };
    }
    const ordinals: number[] = [];
    for (const item of body.blocked_changes) {
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 0) {
        return { ok: false, reason: 'blocked_changes 只能包含非负整数变更序号。' };
      }
      if (ordinals.length >= MAX_STATE_CHANGES) break;
      ordinals.push(item);
    }
    blockedChanges = ordinals;
  }
  return { ok: true, value: { summary, question, affected, blocked_changes: blockedChanges } };
}

function parseQuestions(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string =>
    typeof item === 'string' && item.trim() !== '').slice(0, MAX_QUESTIONS);
}

/**
 * 确定性校验：模型输出只是候选。
 * DISCUSS / CLARIFY 不携带任何业务变更；MAINTAIN 的每一条变更都必须能按 kind 白名单与
 * 字段形状完整解释——只要有一条非法，整单退回聚焦澄清（不静默丢弃条目后再宣称整组生效）。
 * decision_required 非空但形状非法同样是整单退回：把它当作「没有待决定」会绕过待决定门。
 */
export function validateStateMaintenanceCandidate(raw: JsonObject): StateMaintenanceValidation {
  const decision = raw.decision;
  if (decision !== 'DISCUSS' && decision !== 'CLARIFY' && decision !== 'MAINTAIN') {
    return { ok: false, reason: DEFAULT_STATE_CLARIFICATION };
  }
  const questions = parseQuestions(raw.questions);
  if (decision === 'DISCUSS') return { ok: true, candidate: { decision, questions } };
  if (decision === 'CLARIFY') return { ok: true, candidate: { decision, questions } };
  const decisionRequired = parseDecisionRequired(raw.decision_required);
  if (!decisionRequired.ok) return { ok: false, reason: decisionRequired.reason };
  if (!Array.isArray(raw.changes)) {
    return { ok: false, reason: '这次要维护的状态内容还不明确：请用 changes 列出 1 至 12 条变更。' };
  }
  if (raw.changes.length === 0) {
    return { ok: false, reason: '这次没有要维护的具体变更：请说明要改变什么。' };
  }
  if (raw.changes.length > MAX_STATE_CHANGES) {
    return { ok: false, reason: `一次最多维护 ${MAX_STATE_CHANGES} 条变更；请分次说明。` };
  }
  const changes: StateChangeCandidate[] = [];
  for (const entry of raw.changes) {
    const parsed = parseChange(entry);
    // 任何一条无法可靠解释 → 整单聚焦澄清，原请求关联保留，不替用户接受剩余部分。
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    changes.push(parsed.change);
  }
  const pendingDecision = decisionRequired.value;
  if (pendingDecision !== null && pendingDecision.blocked_changes !== null) {
    const outOfRange = pendingDecision.blocked_changes.some((ordinal) =>
      ordinal >= changes.length);
    if (outOfRange) {
      return { ok: false, reason: 'blocked_changes 引用了这次没有列出的变更序号。' };
    }
  }
  return { ok: true, candidate: { decision: 'MAINTAIN', questions, changes,
    decision_required: pendingDecision } };
}

/* -------------------------------------------------------------------------- */
/* 解释阶段                                                                    */
/* -------------------------------------------------------------------------- */

export type StateInterpretationOutcome = {
  readonly decision: StateMaintenanceDecision;
  readonly candidateStatus: ConversationCandidateStatus;
  readonly status: StateMaintenanceStatus;
  readonly candidate: JsonObject | null;
  readonly clarification: JsonObject | null;
  readonly decisionRequired: JsonObject | null;
  readonly changes: readonly {
    readonly ordinal: number; readonly changeKind: StateChangeKind;
    readonly commandId: string; readonly payload: JsonObject;
  }[];
};

function stateClarify(reason: string): StateInterpretationOutcome {
  return { decision: 'CLARIFY', candidateStatus: 'UNAVAILABLE', status: 'CLARIFY',
    candidate: null, clarification: { questions: [reason] }, decisionRequired: null, changes: [] };
}

function stateDiscuss(): StateInterpretationOutcome {
  return { decision: 'DISCUSS', candidateStatus: 'UNAVAILABLE', status: 'DISCUSSED',
    candidate: null, clarification: null, decisionRequired: null, changes: [] };
}

/** 模型输出 → 结构化判定。解析失败、非法 JSON 或非法字段都退回一个聚焦澄清。 */
export function readStateMaintenanceInterpretation(generated: AssistResult):
  StateInterpretationOutcome {
  if (generated.kind === 'CANCELLED') return stateDiscuss();
  // 解释入口不声明工具，收到工具请求是协议违例：退回聚焦澄清，不把 preamble 当解释结果。
  if (generated.kind === 'TOOL_CALLS') return stateClarify(DEFAULT_STATE_CLARIFICATION);
  let parsed: JsonObject | undefined;
  try {
    const value: unknown = JSON.parse(generated.content);
    parsed = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as JsonObject : undefined;
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) return stateClarify(DEFAULT_STATE_CLARIFICATION);
  const validated = validateStateMaintenanceCandidate(parsed);
  if (!validated.ok) return stateClarify(validated.reason);
  const candidate = validated.candidate;
  if (candidate.decision === 'DISCUSS') return stateDiscuss();
  if (candidate.decision === 'CLARIFY') {
    return { decision: 'CLARIFY', candidateStatus: 'UNAVAILABLE', status: 'CLARIFY',
      candidate: null,
      clarification: { questions: candidate.questions.length === 0
        ? [DEFAULT_STATE_CLARIFICATION] : candidate.questions },
      decisionRequired: null, changes: [] };
  }
  const changes = candidate.changes.map((change, ordinal) => ({
    ordinal, changeKind: change.kind, commandId: randomUUID(),
    payload: change as unknown as JsonObject }));
  const candidateJson = { changes: candidate.changes } as unknown as JsonObject;
  if (candidate.decision_required !== null) {
    return { decision: 'MAINTAIN', candidateStatus: 'READY', status: 'DECISION_REQUIRED',
      candidate: candidateJson, clarification: null,
      decisionRequired: candidate.decision_required as unknown as JsonObject, changes };
  }
  return { decision: 'MAINTAIN', candidateStatus: 'READY', status: 'READY',
    candidate: candidateJson, clarification: null, decisionRequired: null, changes };
}

/* -------------------------------------------------------------------------- */
/* 读投影                                                                      */
/* -------------------------------------------------------------------------- */

export type StateChangeProjection = {
  readonly ordinal: number;
  readonly change_kind: StateChangeKind;
  readonly command_id: string;
  readonly status: StateChangeStatus;
  readonly before_ref: JsonObject | null;
  readonly after_ref: JsonObject | null;
  readonly error: JsonObject | null;
};

export type ReadStateMaintenanceResult = {
  readonly request: ConversationStateRequestRow;
  readonly changes: readonly ConversationStateChangeRow[];
};

export async function readStateMaintenanceRequest(db: DbExecutor, workspaceId: string,
  requestId: string): Promise<ReadStateMaintenanceResult> {
  const repositories = createRepositories(db);
  const row = await repositories.conversationState.readRequest(requestId);
  if (row === undefined || row.workspace_id !== workspaceId) {
    throw resourceNotFound('State maintenance request');
  }
  return { request: row, changes: await repositories.conversationState.listChangeRows(row.id) };
}

export async function listStateMaintenanceRequests(db: DbExecutor, workspaceId: string,
  sessionId: string): Promise<readonly ReadStateMaintenanceResult[]> {
  const rows = await createRepositories(db).conversationState
    .listSessionRequests(workspaceId, sessionId);
  const repositories = createRepositories(db);
  const results: ReadStateMaintenanceResult[] = [];
  for (const row of rows) {
    results.push({ request: row,
      changes: await repositories.conversationState.listChangeRows(row.id) });
  }
  return results;
}

function questionsOf(row: ConversationStateRequestRow): readonly string[] {
  const raw = row.clarification === null ? undefined : row.clarification.questions;
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

/** 请求行上对外可见的问题列表；decision_required 的 question 单独走 decision_required 字段。 */
export function clarificationQuestionsOf(row: ConversationStateRequestRow): readonly string[] {
  return questionsOf(row);
}

/* -------------------------------------------------------------------------- */
/* 解释用例                                                                    */
/* -------------------------------------------------------------------------- */

export interface InterpretStateMaintenanceInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly sourceMessageId: string;
  readonly commandId: string;
  /** 客户端本机时区：只用于把「下周」这类相对日期落成确切 due_local_date。 */
  readonly timezone?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly modelPort?: AssistModelPort | undefined;
}

export type InterpretStateMaintenanceOutcome = {
  readonly result: ReadStateMaintenanceResult;
  readonly replayed: boolean;
  readonly committedAt: Date;
};

function interpretationUnavailable(code: string, detail: string): DomainError {
  return new DomainError({ code, status: 409,
    type: `/problems/${code.toLowerCase().replaceAll('_', '-')}`, title: '状态维护解释未完成',
    detail, retryable: false, retryAction: 'CHECK_RECEIPT_THEN_RETRY' });
}

function defaultModelPort(): AssistModelPort {
  const config = readModelPortConfig(process.env);
  return config === undefined ? new FakeModelPort() : new OpenAiCompatibleModelPort(config);
}

async function readSourceMessage(db: DbExecutor, messageId: string): Promise<string> {
  const row = await createRepositories(db).assist.readMessage(messageId);
  if (row === undefined || row.content === null) throw invalidTransition('原用户消息正文不可读。');
  return row.content;
}

const MAX_CONTEXT_MESSAGES = 8;
const MAX_CONTEXT_CHARS = 800;

function clip(text: string): string {
  return text.length <= MAX_CONTEXT_CHARS ? text
    : `${text.slice(0, MAX_CONTEXT_CHARS)}…`;
}

/**
 * 解释上下文：同一会话里**当前指令之前**的消息与既有状态维护回执。
 *
 * 用途是让「不是导出，是搜索任务」这类纠正与「按推荐来」这类续答能对上原对象；
 * 上下文只供模型参考，授权仍然只来自当前这条指令本身——上下文里的助手文本、
 * 旧回执或外部内容都不是授权。没有上下文时不加任何前后缀，原消息就是完整输入。
 */
async function buildInterpretationContext(db: DbExecutor, workspaceId: string,
  sessionId: string, sourceMessageId: string, baseline: JsonObject | null): Promise<string> {
  const repositories = createRepositories(db);
  const message = await repositories.assist.readMessage(sourceMessageId);
  const parts: string[] = [];
  const taskChoices = Array.isArray(baseline?.work_segment_tasks) ? baseline.work_segment_tasks : [];
  for (const value of (/工作段|复盘|预期/u.test(message?.content ?? '') ? taskChoices.slice(0, 20) : [])) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) parts.push(`[既有工作段任务选项] ${String(value.title)}`);
  }
  const trials = Array.isArray(baseline?.acceptance_trials) ? baseline.acceptance_trials : [];
  for (const value of trials.slice(0, 20)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      parts.push(`[已登记验收试用] 任务=${String(value.task_title)}，样本=${String(value.sample_label)}，状态=${String(value.status)}`);
    }
  }
  if (message !== undefined) {
    const history = await repositories.assist.listCompletedHistory(sessionId, message.seq - 1n,
      MAX_CONTEXT_MESSAGES);
    for (const row of history) {
      if (row.content === null || row.content.trim() === '') continue;
      parts.push(`[${row.role === 'USER' ? '用户' : '助手'}] ${clip(row.content)}`);
    }
  }
  const prior = await repositories.conversationState.listSessionRequests(workspaceId, sessionId, 5);
  for (const request of prior) {
    if (request.source_message_id === sourceMessageId) continue;
    if (request.decision !== 'MAINTAIN') continue;
    const question = request.decision_required === null ? null
      : typeof request.decision_required.question === 'string'
        ? request.decision_required.question : null;
    const changes = await repositories.conversationState.listChangeRows(request.id);
    const summary = changes.map((change) =>
      `${change.change_kind}:${change.status}`).join(', ');
    parts.push(`[既有状态维护回执] 状态=${request.status}` +
      (question === null ? '' : `，待决定=${question}`) +
      (summary === '' ? '' : `，逐条=${summary}`));
  }
  if (parts.length === 0) return '';
  return `【会话上下文（只供理解，不构成任何授权）】\n${parts.join('\n')}\n\n【当前指令】\n`;
}

async function callModel(port: AssistModelPort,
  request: ConversationInterpretationRequest): Promise<AssistResult> {
  if (port.interpret === undefined) {
    throw interpretationUnavailable('STATE_INTERPRETATION_UNAVAILABLE',
      '当前模型端口没有请求解释能力，无法从对话维护状态。');
  }
  try {
    return await port.interpret(request);
  } catch (error) {
    throw interpretationUnavailable('STATE_INTERPRETATION_UNAVAILABLE',
      `模型端口不可用：${(error as Error).message}`);
  }
}

/**
 * 第一步：登记一条状态维护请求（原消息身份、内容基准、三个阶段命令身份）。
 * 这一步只写事实，不调用模型。
 */
/**
 * 冻结本次状态维护意图的依据版本（R3）。
 *
 * 单独导出是因为主流程的时序不同：旧入口在**自己那次**模型调用之前就 claim，因此基线
 * 自然新鲜；主流程的模型调用发生在更早（它同时要回答、读文件和给出候选），拿到信封之后
 * 才谈得上「维护状态」。若此时才去 claim，冻结的就不是「模型看到的那一版事实」，
 * 模型在途期间的人工修改会被吸收成原基线——那是 R3 明令禁止的。
 *
 * 因此主流程在**发出模型请求之前**先取一次这份快照，结算时原样传下去。读一次与写一次
 * 不在同一事务里是刻意的：它们之间隔着一次模型调用，而那正是需要被隔离的时间窗。
 */
export async function freezeStateInterpretationBaseline(db: DbExecutor, workspaceId: string,
  projectId: string): Promise<JsonObject> {
  const repositories = createRepositories(db);
  const state = await repositories.projects.readProjectState(projectId);
  return { state_revision: state === undefined ? null : toDecimalString(state.revision),
    acceptance_trials: await repositories.acceptanceTrials
      .projectSnapshot(workspaceId, projectId),
    work_segment_tasks: (await repositories.tasks.listProjectTasksByStatus(projectId, ALL_TASK_STATUSES))
      .map((t) => ({ task_id: t.id, title: t.title, revision: t.revision.toString(),
        acceptance_revision: t.acceptance_revision.toString() })) };
}

async function claimStateMaintenanceRequest(db: DbExecutor,
  input: InterpretStateMaintenanceInput & { readonly frozenBaseline?: JsonObject | undefined }):
  Promise<{ readonly row: ConversationStateRequestRow; readonly created: boolean }> {
  return withTransaction(db, async (repositories) => {
    const existing = await repositories.conversationState.findByCommand(input.workspaceId,
      input.commandId, true) ??
      await repositories.conversationState.findBySourceMessage(input.sourceMessageId, true);
    if (existing !== undefined) return { row: existing, created: false };
    const session = await repositories.assist.readSession(input.sessionId);
    if (session === undefined || session.workspace_id !== input.workspaceId) {
      throw resourceNotFound('Assist session');
    }
    if (session.project_id === null) {
      throw invalidTransition('从对话维护项目状态要求会话绑定明确的 Project。');
    }
    if (session.status !== 'ACTIVE') throw invalidTransition('会话已归档。');
    if (session.conversation_mode !== 'AGENT') {
      throw invalidTransition(session.conversation_mode === 'LEARNING'
        ? '学习会话对项目只读，不维护业务状态；请在项目会话里发起状态维护。'
        : '助手档会话只读，不维护业务状态；请在项目会话里发起状态维护。');
    }
    await lockWritableProjectInWorkspace(repositories, input.workspaceId, session.project_id);
    const message = await repositories.assist.readMessage(input.sourceMessageId);
    if (message === undefined || message.session_id !== session.id || message.role !== 'USER' ||
        message.status !== 'COMPLETED' || message.content === null) {
      throw invalidTransition('状态维护请求只能来自该会话中一条已完成的用户消息。');
    }
    // R3：在调用模型**之前**（本 claim 事务内）持久冻结该意图依据的 Project State 版本。
    // 模型在途期间的人工修改不会在结算时被吸收成「原基线」；重启/UNKNOWN 恢复沿这一行继续。
    const state = await repositories.projects.readProjectState(session.project_id);
    const row = await repositories.conversationState.insertRequest({
      id: randomUUID(), workspaceId: input.workspaceId, projectId: session.project_id,
      sessionId: session.id, sourceMessageId: message.id, commandId: input.commandId,
      applyCommandId: randomUUID(), undoCommandId: randomUUID(),
      baseContentSha256: createHash('sha256').update(message.content, 'utf8').digest(),
      interpretationBaseline: input.frozenBaseline ?? { state_revision:
        state === undefined ? null : toDecimalString(state.revision),
        acceptance_trials: await repositories.acceptanceTrials.projectSnapshot(input.workspaceId, session.project_id),
        work_segment_tasks: (await repositories.tasks.listProjectTasksByStatus(session.project_id, ALL_TASK_STATUSES))
          .map((t) => ({ task_id: t.id, title: t.title, revision: t.revision.toString(), acceptance_revision: t.acceptance_revision.toString() })) } });
    await repositories.activities.insertActivityRecord({ id: randomUUID(),
      workspaceId: input.workspaceId, actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
      commandId: input.commandId, projectId: session.project_id, taskId: null,
      eventType: 'CONVERSATION_STATE_REQUESTED',
      factRefs: { request_id: row.id, session_id: session.id, source_message_id: message.id,
        project_id: session.project_id } });
    return { row, created: true };
  });
}

/**
 * 解释结算时冻结每条变更的适用基线（0064）。
 *
 * 确认时点能确定的对象身份与适用版本在这里固定：应用与补偿各自重查适用性，
 * 后续的人工修改不会被「按标题重新解析 + 读最新 revision」悄悄覆盖。
 * 确认时还不存在的对象（例如同组 CREATE_TASK 之后才被引用）记 resolved:false，
 * 应用时才首次解析——不把「当时还没有」误判成冲突。
 */
async function baselineForChange(repositories: Repositories, input: {
  readonly workspaceId: string; readonly projectId: string;
  readonly sessionId: string; readonly requestId: string;
  readonly stateRevision: string | null;
  readonly interpretationBaseline: JsonObject | null;
  readonly changeKind: StateChangeKind; readonly payload: Record<string, unknown>;
}): Promise<JsonObject | null> {
  const baseline: Record<string, unknown> = {};
  const stateDependent = input.changeKind === 'SET_PHASE' ||
    input.changeKind === 'SET_NEXT_ACTION' || input.changeKind === 'ADD_BLOCKER' ||
    input.changeKind === 'RESOLVE_BLOCKER';
  if (stateDependent && input.stateRevision !== null) {
    baseline.state_revision = input.stateRevision;
  }
  const capture = async (resolve: () => Promise<Record<string, unknown>>): Promise<void> => {
    try {
      Object.assign(baseline, await resolve());
      baseline.resolved = true;
    } catch {
      baseline.resolved = false;
    }
  };
  const payload = input.payload;
  switch (input.changeKind) {
    case 'START_WORK_SEGMENT': {
      const frozen = input.interpretationBaseline?.work_segment_tasks;
      const tasks = [];
      for (const title of input.payload.task_titles as string[]) {
        const matches = (Array.isArray(frozen) ? frozen : []).filter((t) => t !== null && typeof t === 'object' && !Array.isArray(t) &&
          String(t.title).trim().toLowerCase() === title.toLowerCase());
        if (matches.length !== 1) return { resolved: false, clarification: '工作段只能选择标题唯一的既有任务，请明确任务范围。' };
        tasks.push(matches[0]!);
      }
      return { resolved: true, tasks };
    }
    case 'REPORT_ACCEPTANCE_TIME': {
      const values = input.interpretationBaseline?.acceptance_trials;
      const candidates = (Array.isArray(values) ? values : []).filter((value) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
        const taskTitle = input.payload.task_title;
        const label = input.payload.sample_label;
        return (taskTitle == null || String(value.task_title).trim().toLowerCase() === String(taskTitle).trim().toLowerCase()) &&
          (label == null || String(value.sample_label).trim().toLowerCase() === String(label).trim().toLowerCase());
      });
      if (candidates.length !== 1) {
        return { resolved: false, clarification: candidates.length === 0
          ? '没有找到已登记的验收试用；请先开始试用，或说明确切任务与样本标签。'
          : '有多条验收试用，请说明要补录的任务标题与样本标签。' };
      }
      const target = candidates[0] as JsonObject;
      return { resolved: true, target_task_id: target.task_id!, trial_id: target.id!, trial_revision: target.revision! };
    }
    case 'SET_PHASE':
      break;
    case 'SET_NEXT_ACTION': {
      const title = payload.task_title;
      if (typeof title === 'string' && title.trim() !== '') {
        await capture(async () => ({ target_task_id:
          await resolveProjectTask(repositories, input.projectId, title) }));
      }
      break;
    }
    case 'SET_TASK_PLANNING': {
      const title = payload.task_title;
      if (typeof title === 'string' && title.trim() !== '') {
        await capture(async () => {
          const targetTaskId = await resolveProjectTask(repositories, input.projectId, title);
          const task = await repositories.tasks.readTask(targetTaskId);
          if (task === undefined) throw new Error('task missing');
          // R2：把确认时点的任务版本一并冻结，应用按它做 CAS，不读最新 revision 冒充基线。
          return { target_task_id: targetTaskId,
            task_revision: toDecimalString(task.revision) };
        });
      }
      break;
    }
    case 'SYNC_EXTERNAL_RESULT': {
      // 只读核对：冻结目标身份（确认时点的对象），版本与条件的变化由核对本身如实分类。
      const title = payload.task_title;
      if (typeof title === 'string' && title.trim() !== '') {
        await capture(async () => ({ target_task_id:
          await resolveProjectTask(repositories, input.projectId, title) }));
      }
      break;
    }
    case 'COMPLETE_TASK': {
      // Slice B：完成提交冻结任务版本与验收版本（条件）；产物在提交时由原完成 Owner
      // 逐个核对并写进不可变完成凭据——完成记录本身就是对确切产物的绑定。
      const title = payload.task_title;
      if (typeof title === 'string' && title.trim() !== '') {
        await capture(async () => {
          const targetTaskId = await resolveProjectTask(repositories, input.projectId, title);
          const task = await repositories.tasks.readTask(targetTaskId);
          if (task === undefined) throw new Error('task missing');
          return { target_task_id: targetTaskId,
            task_revision: toDecimalString(task.revision),
            acceptance_revision: toDecimalString(task.acceptance_revision) };
        });
      }
      break;
    }
    case 'UNDO_STATE_CHANGE': {
      // 第五节：结算时解析同会话唯一已生效调整并冻结其身份；
      // 0 条或多条都不猜——capture 失败记 resolved:false，应用时类型化说明问题。
      await capture(async () => {
        const candidates = (await repositories.conversationState
          .listSessionRequests(input.workspaceId, input.sessionId, 20))
          .filter((row) => row.id !== input.requestId &&
            (row.status === 'APPLIED' || row.status === 'PARTIAL' ||
              row.status === 'UNDOING'));
        if (candidates.length !== 1) {
          throw new Error(`undo candidates: ${candidates.length}`);
        }
        const target = candidates[0]!;
        return { target_request_id: target.id,
          target_undo_command_id: target.undo_command_id };
      });
      break;
    }
    case 'ADD_BLOCKER': {
      const targetKind = payload.target_kind;
      if (targetKind === 'TASK' && typeof payload.task_title === 'string') {
        await capture(async () => ({ target_task_id:
          await resolveProjectTask(repositories, input.projectId, payload.task_title as string) }));
      } else if (targetKind === 'GOAL' && typeof payload.goal_title === 'string') {
        await capture(async () => ({ target_goal_id:
          await resolveWorkspaceGoal(repositories, input.workspaceId,
            payload.goal_title as string) }));
      }
      break;
    }
    case 'RESOLVE_BLOCKER': {
      const reason = payload.reason;
      if (typeof reason === 'string') {
        await capture(async () => {
          const targetKind = payload.target_kind === 'TASK' ? 'TASK' : 'PROJECT';
          const targetId = targetKind === 'PROJECT' ? input.projectId
            : await resolveProjectTask(repositories, input.projectId,
                String(payload.task_title ?? ''));
          const candidates = (await repositories.projects
            .listProjectBlockers(input.projectId))
            .filter((row) => row.resolved_at === null && row.target_kind === targetKind &&
              row.target_id === targetId &&
              row.reason.toLowerCase().includes(reason.toLowerCase()));
          if (candidates.length !== 1) throw new Error('blocker not uniquely resolvable');
          const blocker = candidates[0]!;
          return { blocker_id: blocker.id, blocker_target_kind: blocker.target_kind,
            blocker_target_id: blocker.target_id, blocker_reason: blocker.reason };
        });
      }
      break;
    }
    case 'ADD_TASK_DEPENDENCY': {
      await capture(async () => {
        const taskTitle = String(payload.task_title ?? '');
        const dependsOn = String(payload.depends_on_task_title ?? '');
        return { target_task_id:
            await resolveProjectTask(repositories, input.projectId, taskTitle),
          depends_on_task_id:
            await resolveProjectTask(repositories, input.projectId, dependsOn) };
      });
      break;
    }
    case 'LINK_GOAL': {
      await capture(async () => ({ target_goal_id:
        await resolveWorkspaceGoal(repositories, input.workspaceId,
          String(payload.goal_title ?? '')) }));
      break;
    }
    case 'VERSION_KNOWLEDGE': {
      await capture(async () => {
        const knowledgeId = await resolveKnowledge(repositories, input.workspaceId,
          input.projectId, String(payload.knowledge_title ?? ''));
        const root = await repositories.information.readRoot<InformationRootRow>(
          'knowledge', knowledgeId);
        if (root === undefined) throw new Error('knowledge root missing');
        return { knowledge_id: knowledgeId, knowledge_revision: toDecimalString(root.revision) };
      });
      break;
    }
    case 'CREATE_TASK':
    case 'CREATE_GOAL':
    case 'CREATE_HYPOTHESIS':
    case 'CREATE_DECISION':
    case 'CREATE_KNOWLEDGE':
      break;
  }
  return Object.keys(baseline).length === 0 ? null : baseline as JsonObject;
}

async function settleStateInterpretation(db: DbExecutor, row: ConversationStateRequestRow,
  generated: AssistResult, timezone?: string,
  override?: StateInterpretationOutcome): Promise<ReadStateMaintenanceResult> {
  let outcome = override ?? readStateMaintenanceInterpretation(generated);
  if (outcome.changes.some((change) => change.changeKind === 'REPORT_ACCEPTANCE_TIME')) {
    const values = readAcceptanceTimeStatement(await readSourceMessage(db, row.source_message_id));
    if (values === null || outcome.changes.some((change) => change.changeKind === 'REPORT_ACCEPTANCE_TIME' &&
        (change.payload.preparation_ms !== values.preparation_ms || change.payload.total_acceptance_ms !== values.total_acceptance_ms))) {
      outcome = stateClarify('请明确准备和整体验收的数字及时间单位；整体验收总耗时包含准备成本。');
    }
  }
  const saved = await withTransaction(db, async (repositories) => {
    // R3：适用版本取 claim 时（调用模型之前）冻结在请求行上的基线；
    // 模型返回时间不重新读取最新版本，结算结果因此始终关联原基准。
    let stateRevision: string | null = null;
    if (outcome.changes.some((change) => change.changeKind === 'SET_PHASE' ||
        change.changeKind === 'SET_NEXT_ACTION' || change.changeKind === 'ADD_BLOCKER' ||
        change.changeKind === 'RESOLVE_BLOCKER')) {
      const frozen = row.interpretation_baseline === null ? undefined :
        (row.interpretation_baseline as unknown as Record<string, unknown>).state_revision;
      stateRevision = typeof frozen === 'string' && /^\d+$/u.test(frozen) ? frozen : null;
    }
    const changes = await Promise.all(outcome.changes.map(async (change) => {
        // 截止日期必须配时区：把本次解释收到的本机时区冻结进载荷，应用时不再猜。
        const payload = change.changeKind === 'SET_TASK_PLANNING' &&
          Object.prototype.hasOwnProperty.call(change.payload, 'due_local_date') &&
          typeof change.payload.due_local_date === 'string' && timezone !== undefined
          ? { ...change.payload, timezone } as JsonObject
          : change.payload;
        return { ordinal: change.ordinal, changeKind: change.changeKind,
          commandId: change.commandId, payload,
          baselineRef: await baselineForChange(repositories, {
            workspaceId: row.workspace_id, projectId: row.project_id,
            sessionId: row.session_id, requestId: row.id, stateRevision, interpretationBaseline: row.interpretation_baseline,
            changeKind: change.changeKind,
            payload: payload as unknown as Record<string, unknown> }) };
      }));
    const unresolved = changes.find((change) => (change.changeKind === 'REPORT_ACCEPTANCE_TIME' || change.changeKind === 'START_WORK_SEGMENT') && change.baselineRef?.resolved !== true);
    if (unresolved !== undefined) outcome = stateClarify(String(unresolved.baselineRef?.clarification));
    const updated = await repositories.conversationState.saveInterpretation(row.id, {
      decision: outcome.decision, candidateStatus: outcome.candidateStatus,
      status: outcome.status, candidate: outcome.candidate,
      clarification: outcome.clarification, decisionRequired: outcome.decisionRequired,
      changes: outcome.decision === 'CLARIFY' ? [] : changes });
    if (updated === undefined) return undefined;
    return { request: updated,
      changes: await repositories.conversationState.listChangeRows(updated.id) };
  });
  if (saved !== undefined) return saved;
  const current = await readStateMaintenanceRequest(db, row.workspace_id, row.id);
  if (current === undefined) {
    throw interpretationUnavailable('STATE_INTERPRETATION_UNSETTLED', '状态维护请求行在解释结算时消失。');
  }
  return current;
}

/**
 * 模型明确失败的持久结算：请求不再永远停在 INTERPRETING。
 * 只在模型端口**报告了错误**时写入；进程中途退出不写任何结论，行保持可核对的待处理状态
 * （UNKNOWN 不冒充失败，也不冒充成功）。
 */
async function settleInterpretationFailure(db: DbExecutor, row: ConversationStateRequestRow,
  error: unknown): Promise<void> {
  const detail = error instanceof DomainError ? error.detail
    : error instanceof Error ? error.message : String(error);
  try {
    await withTransaction(db, async (repositories) => {
      await repositories.conversationState.saveInterpretation(row.id, {
        decision: 'CLARIFY', candidateStatus: 'INVALID', status: 'FAILED',
        candidate: null, clarification: { questions: [
          `这次解释没能完成（${detail}）；可以重新发送指令重试。` ] },
        decisionRequired: null, changes: [] });
    });
  } catch {
    // 结算本身失败时不吞掉原始模型错误：原始失败仍是调用方要看到的事实。
  }
}

/**
 * 解释原消息并保存候选。
 *
 * 顺序是「先落事实、再调模型、最后落候选」：已提交的请求行是唯一重放依据。
 * 三道闸按顺序生效：
 *   1. 同 command_id 按原载荷摘要核对，改 source_message_id/session 属于复用，拒绝 COMMAND_ID_REUSED；
 *   2. 同一请求行已有整理结果（含已结算的明确失败）只回读，不再调用模型；
 *   3. 在途解释由持久请求行＋进程内 Owner 集合排除第二个模型调用。
 */
export async function interpretStateMaintenance(db: DbExecutor,
  input: InterpretStateMaintenanceInput): Promise<InterpretStateMaintenanceOutcome> {
  const scopeKey = httpCommandScopeKey(input.workspaceId);
  const payloadHash = computePayloadHash({
    commandType: 'InterpretStateMaintenance',
    target: { workspace_id: input.workspaceId },
    body: { session_id: input.sessionId, source_message_id: input.sourceMessageId } });
  const prior = await createRepositories(db).receipts.findReceipt({ scopeKey,
    commandId: input.commandId });
  if (prior !== undefined) {
    // 载荷不同 → CommandIdReusedError（HTTP 409 COMMAND_ID_REUSED），不返回别人的成功投影。
    resolveExistingReceipt(prior, payloadHash);
    const requestId = typeof prior.result_ref.request_id === 'string'
      ? prior.result_ref.request_id : '';
    const replayRow = requestId === '' ? undefined :
      await createRepositories(db).conversationState.readRequest(requestId);
    if (replayRow === undefined) {
      throw interpretationUnavailable('STATE_INTERPRETATION_UNSETTLED',
        '原命令已提交但状态维护请求行不可读；请按原 command_id 核对，不要新建第二个意图。');
    }
    return { result: await readStateMaintenanceRequest(db, input.workspaceId, replayRow.id),
      replayed: true, committedAt: prior.created_at };
  }
  const claimed = await claimStateMaintenanceRequest(db, input);
  // 命令回执只保存请求身份；重放按该身份读回已保存的阶段事实。
  const receipt = await runIdempotentCommand(db, {
    scopeKey, commandId: input.commandId, commandType: 'InterpretStateMaintenance',
    target: { workspace_id: input.workspaceId },
    body: { session_id: input.sessionId, source_message_id: input.sourceMessageId },
    execute: async () => ({ request_id: claimed.row.id }) });
  let row = claimed.row;

  // 明确失败已结算：本命令（新身份）是原请求的恢复出口，重开同一条请求行继续；
  // 其余已结算结果只回读，不重算候选。
  if (row.candidate_status === 'INVALID') {
    if (claimed.created || row.command_id === input.commandId) {
      return { result: await readStateMaintenanceRequest(db, input.workspaceId, row.id),
        replayed: true, committedAt: receipt.committedAt };
    }
    const reopened = await createRepositories(db).conversationState
      .reopenInterpretation(row.id);
    if (reopened === undefined) {
      // 另一个并发重入抢先重开：不发起第二次调用，回读当前事实。
      return { result: await readStateMaintenanceRequest(db, input.workspaceId, row.id),
        replayed: true, committedAt: receipt.committedAt };
    }
    row = reopened;
  } else if (row.candidate_status !== 'PENDING') {
    return { result: await readStateMaintenanceRequest(db, input.workspaceId, row.id),
      replayed: receipt.replayed, committedAt: receipt.committedAt };
  }

  // 在途 Owner 排除重复模型调用（check 与 add 之间没有 await，进程内是原子的）。
  if (inFlightInterpretations.has(row.id)) {
    return { result: await readStateMaintenanceRequest(db, input.workspaceId, row.id),
      replayed: true, committedAt: receipt.committedAt };
  }
  inFlightInterpretations.add(row.id);
  try {
    const message = await readSourceMessage(db, row.source_message_id);
    const context = await buildInterpretationContext(db, row.workspace_id, row.session_id,
      row.source_message_id, row.interpretation_baseline);
    let generated: AssistResult;
    try {
      generated = await callModel(input.modelPort ?? defaultModelPort(), {
        system: STATE_MAINTENANCE_SYSTEM_PROMPT,
        userContent: context === '' ? message : `${context}${message}`,
        ...(input.signal === undefined ? {} : { signal: input.signal }) });
    } catch (error) {
      await settleInterpretationFailure(db, row, error);
      throw error;
    }
    const settled = await settleStateInterpretation(db, row, generated, input.timezone);
    return { result: settled, replayed: receipt.replayed, committedAt: receipt.committedAt };
  } finally {
    inFlightInterpretations.delete(row.id);
  }
}

/* -------------------------------------------------------------------------- */
/* 主流程提交（阶段 C 其余）                                                     */
/* -------------------------------------------------------------------------- */

/** 主流程信封里的状态维护字段：形状与既有解释入口的输出**完全相同**，不多一个字段。 */
export type MainLoopStateCandidate =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'OUTCOME'; readonly outcome: StateInterpretationOutcome };

/**
 * 读主流程信封里的 `maintenance`。
 *
 * 合法性完全交给既有 `readStateMaintenanceInterpretation()`——主流程**不**为状态维护
 * 另立一套更宽松的规则，判定、必要决定与变更序号都由它生成。`null` 表示这次不维护
 * 状态，因此不产生任何请求行（纯讨论与文件读取都必须走这一支：AM-05 明确要求它们零
 * 状态写入）。
 *
 * 这里**刻意不**再设一道「不合法就丢弃」的闸：旧解释入口从不丢弃判定结果，候选不完整
 * 也照样落成带澄清问题的请求行（`NEEDS_DECISION`），用户因此还能看到该决定什么。多加
 * 这道闸只会让需要人工决定的情况静默消失——那是信息损失，不是保护。
 */
export function readMainLoopStateCandidate(raw: unknown): MainLoopStateCandidate {
  if (raw === undefined || raw === null) return { kind: 'NONE' };
  // 复用既有读法：把这段字段当成一次解释输出读一遍，连不合法输入也走同一条收口路径。
  const outcome = readStateMaintenanceInterpretation({ kind: 'CONTENT',
    content: JSON.stringify(raw), providerRequestId: '',
    usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null,
      cacheCreationTokens: null } });
  return { kind: 'OUTCOME', outcome };
}

export interface RecordStateMaintenanceCandidateInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly sourceMessageId: string;
  readonly commandId: string;
  readonly timezone?: string | undefined;
  /** 调用模型之前冻结的依据版本；缺省时按旧入口在同一事务里现取。 */
  readonly frozenBaseline?: JsonObject | undefined;
  readonly outcome: StateInterpretationOutcome;
}

/**
 * 把主流程给出的状态维护判定落进**原**请求行。
 *
 * 与执行候选同一形状：claim、冻结基线、幂等回执、结算、基线解析、必要决定与变更行
 * 全部复用既有函数，因此「基线在建请求时就冻结」「同一原消息只有一个请求行」
 * 「部分成功与整组撤回仍可用」这些规则在本条目里**没有第二份实现**。
 */
export async function recordStateMaintenanceCandidate(db: DbExecutor,
  input: RecordStateMaintenanceCandidateInput): Promise<ReadStateMaintenanceResult> {
  const scopeKey = httpCommandScopeKey(input.workspaceId);
  const claimed = await claimStateMaintenanceRequest(db, { workspaceId: input.workspaceId,
    sessionId: input.sessionId, sourceMessageId: input.sourceMessageId,
    commandId: input.commandId, ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    ...(input.frozenBaseline === undefined ? {} : { frozenBaseline: input.frozenBaseline }) });
  await runIdempotentCommand(db, {
    scopeKey, commandId: input.commandId, commandType: 'InterpretStateMaintenance',
    target: { workspace_id: input.workspaceId },
    body: { session_id: input.sessionId, source_message_id: input.sourceMessageId,
      origin: 'AGENT_MAIN_LOOP' },
    execute: async () => ({ request_id: claimed.row.id }) });
  if (claimed.row.candidate_status !== 'PENDING') {
    return readStateMaintenanceRequest(db, input.workspaceId, claimed.row.id);
  }
  return settleStateInterpretation(db, claimed.row,
    { kind: 'CONTENT', content: '', providerRequestId: '',
      usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null,
        cacheCreationTokens: null } },
    input.timezone, input.outcome);
}

/* -------------------------------------------------------------------------- */
/* 应用阶段                                                                    */
/* -------------------------------------------------------------------------- */

export type ApplyStateMaintenanceResult = {
  readonly request_id: string;
  readonly status: StateMaintenanceStatus;
  readonly revision: string;
  readonly apply_command_id: string;
  readonly undo_command_id: string;
  readonly changes: readonly StateChangeProjection[];
};

function changeProjection(row: ConversationStateChangeRow): StateChangeProjection {
  return { ordinal: row.ordinal, change_kind: row.change_kind, command_id: row.command_id,
    status: row.status, before_ref: row.before_ref, after_ref: row.after_ref, error: row.error };
}

function settledResult(row: ConversationStateRequestRow,
  changes: readonly ConversationStateChangeRow[]): ApplyStateMaintenanceResult {
  return { request_id: row.id, status: row.status,
    revision: toDecimalString(row.revision), apply_command_id: row.apply_command_id,
    undo_command_id: row.undo_command_id, changes: changes.map(changeProjection) };
}

function changeFailure(code: string, message: string): DomainError {
  return new DomainError({ code, status: 422,
    type: `/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    title: '状态维护变更未生效', detail: message, retryable: false, retryAction: 'NONE' });
}

/** 变更失败的原因：领域错误按类型记录，未知错误原样上抛（不吞实现缺陷）。 */
function failureOf(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof DomainError) return { code: error.code, message: error.detail };
  if (error instanceof CommandIdReusedError) {
    return { code: 'COMMAND_ID_REUSED', message: error.message };
  }
  throw error;
}

/**
 * 回执先行重放：变更行的命令身份只属于这一行，命中回执即按原结果重放，
 * 不重算会随事实漂移的 body（expected_revision 等）。这是崩溃窗口（Owner 已提交、
 * 变更行未结算）下唯一安全的重入方式。
 */
async function replayOrRun<T extends CommandResult>(db: DbExecutor, scopeKey: string,
  commandId: string, run: () => Promise<CommandOutcome<T>>): Promise<CommandOutcome<T>> {
  const prior = await createRepositories(db).receipts.findReceipt({ scopeKey, commandId });
  if (prior !== undefined) {
    return { result: prior.result_ref as T, replayed: true, committedAt: prior.created_at };
  }
  return run();
}

function payloadRecord(change: ConversationStateChangeRow): Record<string, unknown> {
  return change.payload as unknown as Record<string, unknown>;
}

function refObject(value: JsonObject | null): Record<string, unknown> {
  return (value ?? {}) as unknown as Record<string, unknown>;
}

const ALL_TASK_STATUSES: readonly TaskStatus[] =
  ['INBOX', 'READY', 'IN_PROGRESS', 'WAITING', 'BLOCKED', 'DONE', 'CANCELLED'];

/** 标题精确匹配（trim、大小写不敏感）：0 条 NOT_FOUND，多于 1 条 AMBIGUOUS，唯一命中返回 id。 */
export function matchTitle(rows: readonly { readonly id: string; readonly title: string }[],
  title: string): { readonly ok: true; readonly id: string } |
  { readonly ok: false; readonly code: 'NOT_FOUND' | 'AMBIGUOUS' } {
  const key = title.trim().toLowerCase();
  const matches = rows.filter((row) => row.title.trim().toLowerCase() === key);
  if (matches.length === 0) return { ok: false, code: 'NOT_FOUND' };
  if (matches.length > 1) return { ok: false, code: 'AMBIGUOUS' };
  return { ok: true, id: matches[0]!.id };
}

function titleMismatch(label: string, code: 'NOT_FOUND' | 'AMBIGUOUS'): DomainError {
  return changeFailure(code === 'AMBIGUOUS' ? `${label}_TITLE_AMBIGUOUS` : `${label}_NOT_FOUND`,
    code === 'AMBIGUOUS' ? `有多个同名${label === 'TASK' ? '任务' : label === 'GOAL' ? '目标' : '知识'}，无法确定指哪一个。`
      : `没有找到标题完全一致的${label === 'TASK' ? '任务' : label === 'GOAL' ? '目标' : '知识'}。`);
}

async function resolveProjectTask(repositories: Repositories, projectId: string,
  title: string): Promise<string> {
  const tasks = await repositories.tasks.listProjectTasksByStatus(projectId, ALL_TASK_STATUSES);
  const matched = matchTitle(tasks.map((task) => ({ id: task.id, title: task.title })), title);
  if (!matched.ok) throw titleMismatch('TASK', matched.code);
  return matched.id;
}

async function listWorkspaceGoalTitles(repositories: Repositories,
  workspaceId: string): Promise<readonly { readonly id: string; readonly title: string }[]> {
  const goals: { id: string; title: string }[] = [];
  let before: { readonly createdAt: string; readonly id: string } | null = null;
  for (let page = 0; page < 100; page += 1) {
    const rows = await repositories.projects.listGoalsPage({ workspaceId,
      status: 'active', limit: 200, before });
    const bounded = rows.length > 200 ? rows.slice(0, 200) : rows;
    goals.push(...bounded.map((goal) => ({ id: goal.id, title: goal.title })));
    if (rows.length <= 200) return goals;
    const last = bounded.at(-1);
    if (last === undefined) return goals;
    before = { createdAt: last.cursor_created_at, id: last.id };
  }
  return goals;
}

async function resolveWorkspaceGoal(repositories: Repositories, workspaceId: string,
  title: string): Promise<string> {
  const goals = await listWorkspaceGoalTitles(repositories, workspaceId);
  const matched = matchTitle(goals, title);
  if (!matched.ok) throw titleMismatch('GOAL', matched.code);
  return matched.id;
}

async function resolveKnowledge(repositories: Repositories, workspaceId: string,
  projectId: string, title: string): Promise<string> {
  const roots = await repositories.information.listRoots<InformationRootRow>(
    'knowledge', workspaceId, projectId);
  const matched = matchTitle(roots.filter((root) => root.status === 'ACTIVE')
    .map((root) => ({ id: root.id, title: root.title })), title);
  if (!matched.ok) throw titleMismatch('KNOWLEDGE', matched.code);
  return matched.id;
}

async function requireProjectState(repositories: Repositories,
  projectId: string): Promise<{ readonly revision: bigint; readonly phase_key: string;
    readonly next_action_task_id: string | null }> {
  const state = await repositories.projects.readProjectState(projectId);
  if (state === undefined) throw resourceNotFound('Project State');
  return state;
}

type StateChangeOutcome = {
  readonly beforeRef: JsonObject | null;
  readonly afterRef: JsonObject | null;
  /** 请求的事实已经成立、原指令没有产生新效果：如实记为已存在，撤回不碰它。 */
  readonly skipped?: string;
};

/**
 * 应用上下文：状态类变更共用一条**链式期望版本**。
 * 第一条取解释结算时冻结的确认基线，之后每条取本组自己上一次写入后的版本——
 * 因此既不会用「读最新 revision」掩盖别人的修改，也不会被自己组内的推进误判成冲突。
 * SET_TASK_PLANNING 同理按目标任务维护一条链（R2/R4）。
 */
type ApplyContext = {
  stateRevision: bigint | null;
  taskRevisions: Map<string, bigint>;
};

function seedTaskRevisions(
  changes: readonly ConversationStateChangeRow[]): Map<string, bigint> {
  const chain = new Map<string, bigint>();
  // 按 ordinal 顺序推进：同任务多条已生效变更以最后一条的生效版本为准。
  for (const change of [...changes]
    .filter((row) => row.status === 'APPLIED' && row.change_kind === 'SET_TASK_PLANNING')
    .sort((left, right) => left.ordinal - right.ordinal)) {
    const after = refObject(change.after_ref);
    const taskId = typeof after.task_id === 'string' ? after.task_id : undefined;
    const revision = typeof after.task_revision === 'string' &&
      /^\d+$/u.test(after.task_revision) ? BigInt(after.task_revision) : undefined;
    if (taskId !== undefined && revision !== undefined) chain.set(taskId, revision);
  }
  return chain;
}

/** 确认时点的适用性被后续合法修改破坏：保留当前事实，交回用户重新决定。 */
function applicabilityConflict(code: string, detail: string): DomainError {
  return new DomainError({ code, status: 409,
    type: `/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    title: '与后续修改冲突', detail, retryable: false,
    retryAction: 'REFRESH_AND_REDECIDE' });
}

function stateConflictDetail(state: { readonly revision: bigint; readonly phase_key: string;
  readonly next_action_task_id: string | null }, change: ConversationStateChangeRow): string {
  const frozen = refObject(change.baseline_ref).state_revision;
  const frozenText = typeof frozen === 'string' ? frozen : '未知';
  return `确认时点的项目状态版本为 ${frozenText}，当前已是 ${toDecimalString(state.revision)}` +
    `（阶段 ${state.phase_key}，下一步 ${state.next_action_task_id ?? '无'}）；` +
    '本次保留当前事实、不覆盖这次修改；请基于最新状态重新确认。';
}

async function expectedStateRevisionFor(context: ApplyContext,
  change: ConversationStateChangeRow): Promise<bigint> {
  if (context.stateRevision !== null) return context.stateRevision;
  const frozen = refObject(change.baseline_ref).state_revision;
  if (typeof frozen === 'string' && /^\d+$/u.test(frozen)) return BigInt(frozen);
  // 0067：缺少可信的冻结基线（迁移前旧行）→ 保守冲突，绝不读最新版本冒充原基线。
  throw applicabilityConflict('STATE_BASELINE_MISSING',
    '这条状态变更缺少可信的解释基线（迁移前数据）；不能按最新版本冒充原基线生效，' +
    '请基于当前项目状态重新发起。');
}

async function peekReceipt<T extends CommandResult>(db: DbExecutor, scopeKey: string,
  commandId: string): Promise<CommandOutcome<T> | null> {
  const prior = await createRepositories(db).receipts.findReceipt({ scopeKey, commandId });
  return prior === undefined ? null
    : { result: prior.result_ref as T, replayed: true, committedAt: prior.created_at };
}

/**
 * 目标身份绑定（0064）：确认时点已解析的对象必须还是同一个对象。
 * 确认之后的重命名、重名新增、目标替换或归档都不会让命令落到另一个对象上；
 * 确认时点还不存在的对象（resolved !== true）才在应用时首次解析。
 */
async function boundTargetId(change: ConversationStateChangeRow, baselineKey: string,
  resolveNow: () => Promise<string>): Promise<string> {
  const baseline = refObject(change.baseline_ref);
  if (baseline.resolved !== true) return resolveNow();
  const frozen = baseline[baselineKey];
  if (typeof frozen !== 'string' || frozen === '') return resolveNow();
  let current: string;
  try {
    current = await resolveNow();
  } catch (error) {
    if (error instanceof DomainError && error.code.endsWith('_CONFLICT')) throw error;
    throw applicabilityConflict('TARGET_IDENTITY_CONFLICT',
      '确认时点的对象已被重命名、归档或不再唯一可解析；本次不落到其他对象上，请重新确认。');
  }
  if (current !== frozen) {
    throw applicabilityConflict('TARGET_IDENTITY_CONFLICT',
      '这个标题现在指向另一个对象；确认时点的目标身份已改变，本次不改到别的对象上，请重新确认。');
  }
  return current;
}

type StateCommandAction = 'SET_PHASE' | 'SET_NEXT_ACTION' | 'ADD_BLOCKER' | 'RESOLVE_BLOCKER';

/**
 * 状态类变更的统一执行：先按原命令身份查回执（已提交的绝不重算、也不误记为失败），
 * 没有回执才做适用性核对与写入；成功后把产生的新版本写回链式上下文。
 */
async function runStateDependentChange(input: {
  readonly db: DbExecutor; readonly request: ConversationStateRequestRow;
  readonly change: ConversationStateChangeRow; readonly context: ApplyContext;
  readonly action: StateCommandAction;
  readonly params: Readonly<Record<string, unknown>>;
  readonly beforeRef: (state: { readonly phase_key: string;
    readonly next_action_task_id: string | null }) => Promise<JsonObject | null>;
  readonly afterRef: Record<string, unknown>;
}): Promise<StateChangeOutcome> {
  const { db, request, change, context } = input;
  const repositories = createRepositories(db);
  const scopeKey = httpCommandScopeKey(request.workspace_id);
  const replayed = await peekReceipt<RunStateCommandResult>(db, scopeKey, change.command_id);
  if (replayed !== null) {
    context.stateRevision = BigInt(replayed.result.revision);
    return { beforeRef: change.before_ref,
      afterRef: { ...input.afterRef, state_revision: replayed.result.revision } as JsonObject };
  }
  const expected = await expectedStateRevisionFor(context, change);
  const state = await requireProjectState(repositories, request.project_id);
  if (state.revision !== expected) {
    throw applicabilityConflict('STATE_VERSION_CONFLICT', stateConflictDetail(state, change));
  }
  const beforeRef = change.before_ref ?? await input.beforeRef(state);
  if (change.before_ref === null && beforeRef !== null) {
    await repositories.conversationState.updateChangeStatus(change.id,
      { status: 'PENDING', beforeRef });
  }
  const outcome = await runStateCommand(db, { workspaceId: request.workspace_id,
    projectId: request.project_id, commandId: change.command_id,
    expectedRevision: toDecimalString(expected), action: input.action,
    params: input.params });
  context.stateRevision = BigInt(outcome.result.revision);
  return { beforeRef,
    afterRef: { ...input.afterRef, state_revision: outcome.result.revision } as JsonObject };
}

/** Slice B（NLS-04）：外部成果核对的只读分类。只读既有事实，不写任何业务状态。 */
export type ExternalSyncCheckResult = 'COMPLETED' | 'VERIFIED' | 'STALE_PASS' |
  'VERIFICATION_FAILED' | 'VERIFICATION_PENDING' | 'NEEDS_HUMAN_ACCEPTANCE' |
  'EVIDENCE_MISSING' | 'READY_FOR_COMPLETION';

async function evaluateExternalSync(db: DbExecutor, request: ConversationStateRequestRow,
  repositories: Repositories, task: TaskRow): Promise<JsonObject> {
  const acceptanceRevision = task.acceptance_revision;
  const criteria = await repositories.tasks.listCriteria(task.id, acceptanceRevision);
  const acceptance = await repositories.tasks.readAcceptanceVersion(task.id,
    acceptanceRevision);
  const artifacts = await listTaskArtifacts(db, request.workspace_id, task.id);
  const artifactVersionIds = artifacts.items
    .map((artifact) => artifact.latest_version_id)
    .filter((versionId): versionId is string => typeof versionId === 'string');
  const base = { task_id: task.id,
    acceptance_revision: toDecimalString(acceptanceRevision),
    criteria_total: criteria.length,
    criteria_required: criteria.filter((criterion) => criterion.required).length,
    artifact_version_ids: artifactVersionIds };
  const verdict = (result: ExternalSyncCheckResult, extra: Record<string, unknown> = {}) =>
    ({ ...base, check_result: result, ...extra }) as JsonObject;

  if (task.status === 'DONE' && task.current_completion_id !== null) {
    return verdict('COMPLETED', { completion_id: task.current_completion_id });
  }
  // 当前验收周期的验证会话：旧 PASS 只在适用时才算数，未通过/进行中如实报告。
  // 会话总决策词表为 OPEN/PASS/RETRY/HUMAN（FAIL/ERROR 属单项检查结果，会体现在总决策里）。
  const sessions = await repositories.verifications
    .listSessionsByTaskCycle(task.id, acceptanceRevision);
  const latest = sessions.at(-1);
  if (latest !== undefined) {
    const applicable = await repositories.verifications.isApplicable(latest.id);
    const session = { session_id: latest.id, status: latest.status,
      verdict: latest.verdict, applicable };
    if (latest.verdict === 'PASS') {
      return verdict(applicable ? 'VERIFIED' : 'STALE_PASS', { verification: session });
    }
    if (latest.verdict === 'HUMAN') {
      return verdict('NEEDS_HUMAN_ACCEPTANCE', { verification: session });
    }
    if (latest.verdict === 'RETRY') {
      return verdict('VERIFICATION_FAILED', { verification: session });
    }
    return verdict('VERIFICATION_PENDING', { verification: session });
  }
  const requiredOutputs = acceptance?.required_output_spec;
  const outputsDeclared = requiredOutputs !== undefined && requiredOutputs !== null &&
    Object.keys(requiredOutputs).length > 0;
  if (outputsDeclared && artifactVersionIds.length === 0) {
    return verdict('EVIDENCE_MISSING');
  }
  if (criteria.some((criterion) => criterion.required)) {
    return verdict('NEEDS_HUMAN_ACCEPTANCE');
  }
  return verdict('READY_FOR_COMPLETION');
}

async function runStateChange(db: DbExecutor, request: ConversationStateRequestRow,
  change: ConversationStateChangeRow, context: ApplyContext,
  storage: ManagedContentStore | undefined): Promise<StateChangeOutcome> {
  const repositories = createRepositories(db);
  const scopeKey = httpCommandScopeKey(request.workspace_id);
  const payload = payloadRecord(change);

  switch (change.change_kind) {
    case 'START_WORK_SEGMENT': {
      const replayed = await peekReceipt(db, scopeKey, change.command_id);
      if (replayed !== null) return { beforeRef: change.before_ref, afterRef: replayed.result };
      const baseline = refObject(change.baseline_ref);
      if (baseline.resolved !== true || !Array.isArray(baseline.tasks)) throw applicabilityConflict('TARGET_BASELINE_MISSING', '缺少工作段任务基线，请重新确认范围。');
      const tasks = (baseline.tasks as Record<string, string>[]).map((t): WorkSegmentTaskInput => ({
        taskId: t.task_id!, expectedRevision: t.revision!, expectedAcceptanceRevision: t.acceptance_revision! }));
      const started = await startWorkSegment(db, { workspaceId: request.workspace_id, projectId: request.project_id,
        commandId: change.command_id, confirmed: true, title: String(payload.title), expectation: String(payload.expectation),
        tasks, sourceMessageId: request.source_message_id });
      return { beforeRef: null, afterRef: started.result };
    }
    case 'CREATE_HYPOTHESIS': {
      const created = await replayOrRun(db, scopeKey, change.command_id, () => createHypothesis(db, {
        workspaceId: request.workspace_id, projectId: request.project_id, commandId: change.command_id,
        confirmed: true, title: String(payload.title), claim: String(payload.claim), method: String(payload.method),
        criterion: String(payload.criterion), sourceMessageId: request.source_message_id }));
      return { beforeRef: null, afterRef: created.result };
    }
    case 'REPORT_ACCEPTANCE_TIME': {
      const replayed = await peekReceipt(db, scopeKey, change.command_id);
      if (replayed !== null) return { beforeRef: change.before_ref, afterRef: replayed.result };
      const baseline = refObject(change.baseline_ref);
      if (baseline.resolved !== true || typeof baseline.target_task_id !== 'string' ||
          typeof baseline.trial_id !== 'string' || typeof baseline.trial_revision !== 'string') {
        throw applicabilityConflict('TARGET_BASELINE_MISSING', '补录缺少确切试用基线，请明确任务与样本后重新发起。');
      }
      const prior = (await repositories.acceptanceTrials.observations(baseline.trial_id))[0];
      const outcome = await recordTaskAcceptanceObservation(db, { workspaceId: request.workspace_id,
        taskId: baseline.target_task_id, trialId: baseline.trial_id, expectedRevision: baseline.trial_revision,
        commandId: change.command_id,
        preparationMs: typeof payload.preparation_ms === 'number' ? payload.preparation_ms :
          prior?.preparation_ms == null ? null : Number(prior.preparation_ms),
        totalAcceptanceMs: typeof payload.total_acceptance_ms === 'number' ? payload.total_acceptance_ms :
          prior?.total_acceptance_ms == null ? null : Number(prior.total_acceptance_ms),
        sourceNote: '用户会话耗时补录，原文见来源消息。', sourceMessageId: request.source_message_id });
      return { beforeRef: { trial_id: baseline.trial_id, trial_revision: baseline.trial_revision,
        preparation_ms: prior?.preparation_ms?.toString() ?? null, total_acceptance_ms: prior?.total_acceptance_ms?.toString() ?? null },
      afterRef: { ...outcome.result, source_message_id: request.source_message_id } };
    }
    case 'SET_PHASE': {
      const phase = String(payload.phase);
      return runStateDependentChange({ db, request, change, context, action: 'SET_PHASE',
        params: { phase_key: phase },
        beforeRef: async (state) => ({ phase: state.phase_key }),
        afterRef: { phase } });
    }
    case 'SET_NEXT_ACTION': {
      const rawTitle = payload.task_title;
      const taskId = typeof rawTitle === 'string' && rawTitle.trim() !== ''
        ? await boundTargetId(change, 'target_task_id',
            () => resolveProjectTask(repositories, request.project_id, rawTitle))
        : null;
      return runStateDependentChange({ db, request, change, context,
        action: 'SET_NEXT_ACTION', params: { next_action_task_id: taskId },
        beforeRef: async (state) => ({ task_id: state.next_action_task_id }),
        afterRef: { task_id: taskId } });
    }
    case 'ADD_BLOCKER': {
      const targetKind = payload.target_kind as ProjectBlockerTargetKind;
      const reason = String(payload.reason);
      const sourceRef = `conversation-state-request:${request.id}`;
      const targetId = targetKind === 'PROJECT' ? request.project_id
        : targetKind === 'TASK'
          ? await boundTargetId(change, 'target_task_id',
              () => resolveProjectTask(repositories, request.project_id,
                String(payload.task_title)))
          : await boundTargetId(change, 'target_goal_id',
              () => resolveWorkspaceGoal(repositories, request.workspace_id,
                String(payload.goal_title)));
      const matchKey = (row: { target_kind: string; target_id: string; reason: string;
        resolved_at: Date | null }): boolean =>
        row.resolved_at === null && row.target_kind === targetKind &&
        row.target_id === targetId && row.reason === reason;
      const beforeRows = (await repositories.projects.listProjectBlockers(request.project_id))
        .filter(matchKey).map((row) => row.id);
      const outcome = await runStateDependentChange({ db, request, change, context,
        action: 'ADD_BLOCKER',
        params: { target_kind: targetKind, target_id: targetId, reason, source_ref: sourceRef },
        beforeRef: async () => null, afterRef: {} });
      const createdRows = (await repositories.projects.listProjectBlockers(request.project_id))
        .filter(matchKey).map((row) => row.id);
      const blockerId = createdRows.find((id) => !beforeRows.includes(id)) ?? createdRows[0];
      if (blockerId === undefined) {
        throw new Error('ADD_BLOCKER committed but no matching blocker row is readable');
      }
      const appliedStateRevision = refObject(outcome.afterRef).state_revision;
      return { beforeRef: null,
        afterRef: { blocker_id: blockerId,
          state_revision: typeof appliedStateRevision === 'string' ? appliedStateRevision
            : null } };
    }
    case 'RESOLVE_BLOCKER': {
      const reason = String(payload.reason);
      // 重入时 before 已落库、确认时点已解析时用冻结身份：都不重新按标题匹配，
      // 避免后来的重名或原因片段变化把命令落到另一条阻塞上。
      const priorBefore = refObject(change.before_ref);
      const frozenBlocker = refObject(change.baseline_ref).blocker_id;
      const blockerId = typeof priorBefore.blocker_id === 'string' ? priorBefore.blocker_id
        : typeof frozenBlocker === 'string'
          ? frozenBlocker
          : await (async () => {
              const targetKind = payload.target_kind as 'PROJECT' | 'TASK';
              const targetId = targetKind === 'PROJECT' ? request.project_id
                : await resolveProjectTask(repositories, request.project_id,
                    String(payload.task_title));
              const candidates = (await repositories.projects
                .listProjectBlockers(request.project_id))
                .filter((row) => row.resolved_at === null && row.target_kind === targetKind &&
                  row.target_id === targetId &&
                  row.reason.toLowerCase().includes(reason.toLowerCase()));
              if (candidates.length === 0) {
                throw changeFailure('BLOCKER_NOT_FOUND', '没有匹配该原因片段的未决阻塞。');
              }
              if (candidates.length > 1) {
                throw changeFailure('BLOCKER_AMBIGUOUS',
                  '该原因片段匹配到多条未决阻塞，请给出更精确的片段。');
              }
              return candidates[0]!.id;
            })();
      return runStateDependentChange({ db, request, change, context,
        action: 'RESOLVE_BLOCKER', params: { blocker_id: blockerId },
        beforeRef: async () => {
          const blocker = await repositories.projects.readBlocker(blockerId);
          if (blocker === undefined) throw resourceNotFound('Project blocker');
          return { blocker_id: blocker.id, target_kind: blocker.target_kind,
            target_id: blocker.target_id, reason: blocker.reason };
        },
        afterRef: { blocker_id: blockerId } });
    }
    case 'CREATE_TASK': {
      const prepared = prepareTaskCreation({ workspaceId: request.workspace_id,
        commandId: change.command_id, projectId: request.project_id,
        title: String(payload.title), objective: String(payload.objective),
        criteria: [], expectedOutputs: {}, mode: 'ME' });
      const outcome = await replayOrRun(db, scopeKey, change.command_id, () =>
        runIdempotentCommand(db, {
          scopeKey, commandId: change.command_id, commandType: 'CreateTask',
          target: { workspace_id: request.workspace_id },
          body: { project_id: request.project_id, title: prepared.title,
            objective: prepared.objective, expected_outputs: prepared.expectedOutputs,
            mode: prepared.mode },
          execute: async (repos) => applyTaskCreation(repos, prepared) }));
      return { beforeRef: null, afterRef: { task_id: outcome.result.task_id } };
    }
    case 'ADD_TASK_DEPENDENCY': {
      const taskId = await boundTargetId(change, 'target_task_id',
        () => resolveProjectTask(repositories, request.project_id, String(payload.task_title)));
      const dependsOnTaskId = await boundTargetId(change, 'depends_on_task_id',
        () => resolveProjectTask(repositories, request.project_id,
          String(payload.depends_on_task_title)));
      const kind = payload.dependency_kind as TaskDependencyKind;
      // 原指令没有新增的关系 → 无新增效果：如实记为「已存在」，撤回也不会删除它。
      const existing = (await repositories.tasks.listDependencies(taskId))
        .find((row) => row.depends_on_task_id === dependsOnTaskId && row.dependency_kind === kind);
      if (existing !== undefined) {
        return { beforeRef: null, skipped: 'DEPENDENCY_ALREADY_EXISTS',
          afterRef: { dependency: { task_id: taskId, depends_on_task_id: dependsOnTaskId },
            preexisting: true } };
      }
      await replayOrRun(db, scopeKey, change.command_id, async () => {
        const task = await repositories.tasks.readTask(taskId);
        if (task === undefined) throw resourceNotFound('Task');
        return addTaskDependency(db, { workspaceId: request.workspace_id, taskId,
          commandId: change.command_id, expectedRevision: toDecimalString(task.revision),
          dependsOnTaskId, dependencyKind: kind });
      });
      return { beforeRef: null,
        afterRef: { dependency: { task_id: taskId, depends_on_task_id: dependsOnTaskId } } };
    }
    case 'CREATE_GOAL': {
      const outcome = await replayOrRun(db, scopeKey, change.command_id, () =>
        createGoal(db, { workspaceId: request.workspace_id, commandId: change.command_id,
          title: String(payload.title), description: String(payload.description ?? '') }));
      return { beforeRef: null, afterRef: { goal_id: outcome.result.goal_id } };
    }
    case 'LINK_GOAL': {
      const goalId = await boundTargetId(change, 'target_goal_id',
        () => resolveWorkspaceGoal(repositories, request.workspace_id,
          String(payload.goal_title)));
      // 已经关联的目标：原指令没有新增关系，撤回时也不能把它解掉。
      const existingLink = await repositories.projects.findProjectGoalLink(request.project_id,
        goalId);
      if (existingLink !== undefined) {
        return { beforeRef: null, skipped: 'GOAL_ALREADY_LINKED',
          afterRef: { goal_id: goalId, preexisting: true } };
      }
      await replayOrRun(db, scopeKey, change.command_id, async () => {
        const project = await repositories.projects.readProject(request.project_id);
        if (project === undefined) throw resourceNotFound('Project');
        return linkProjectGoal(db, { workspaceId: request.workspace_id,
          projectId: request.project_id, commandId: change.command_id,
          expectedRevision: toDecimalString(project.revision), goalId });
      });
      return { beforeRef: null, afterRef: { goal_id: goalId } };
    }
    case 'CREATE_DECISION': {
      const outcome = await replayOrRun(db, scopeKey, change.command_id, () =>
        createDecision(db, { workspaceId: request.workspace_id, projectId: request.project_id,
          commandId: change.command_id, title: String(payload.title),
          choice: String(payload.choice), rationale: String(payload.rationale),
          alternatives: [], costs: [] }));
      return { beforeRef: null, afterRef: { decision_id: outcome.result.decision_id ?? '' } };
    }
    case 'CREATE_KNOWLEDGE': {
      const outcome = await replayOrRun(db, scopeKey, change.command_id, () =>
        createKnowledge(db, { workspaceId: request.workspace_id, projectId: request.project_id,
          commandId: change.command_id, title: String(payload.title),
          source: { sourceKind: 'NOTE', text: String(payload.content) } }));
      return { beforeRef: null,
        afterRef: { knowledge_id: outcome.result.knowledge_id ?? '',
          version: outcome.result.version ?? '1' } };
    }
    case 'VERSION_KNOWLEDGE': {
      const knowledgeId = await boundTargetId(change, 'knowledge_id',
        () => resolveKnowledge(repositories, request.workspace_id, request.project_id,
          String(payload.knowledge_title)));
      const frozenRevision = refObject(change.baseline_ref).knowledge_revision;
      const outcome = await replayOrRun(db, scopeKey, change.command_id, async () => {
        const root = await repositories.information.readRoot<InformationRootRow>(
          'knowledge', knowledgeId);
        if (root === undefined) throw resourceNotFound('Knowledge');
        // 确认之后知识已被他人修订：追加新版本会盖在他人的修订之上，先交回重新确认。
        if (typeof frozenRevision === 'string' &&
            frozenRevision !== toDecimalString(root.revision)) {
          throw applicabilityConflict('TARGET_VERSION_CONFLICT',
            `这份知识在确认之后已被修订（${frozenRevision} → ${toDecimalString(root.revision)}）；` +
            '本次保留他人的修订、不覆盖，请基于最新版本重新确认。');
        }
        return addKnowledgeVersion(db, { workspaceId: request.workspace_id,
          knowledgeId, commandId: change.command_id,
          expectedRevision: toDecimalString(root.revision),
          source: { sourceKind: 'NOTE', text: String(payload.content) } });
      });
      return { beforeRef: null,
        afterRef: { knowledge_id: knowledgeId,
          version: outcome.result.version ?? '1' } };
    }
    case 'SET_TASK_PLANNING': {
      // 回执先行（R4）：Owner 已提交、APPLIED 回执保存前中断时按原结果重放，
      // 不重新做适用性核对——否则冻结版本会被自己上一次的提交挡住。
      const replayed = await peekReceipt<TaskCommandResult>(db, scopeKey, change.command_id);
      if (replayed !== null) {
        const replayTaskId = replayed.result.task_id;
        context.taskRevisions.set(replayTaskId, BigInt(replayed.result.revision));
        const prior = refObject(change.before_ref);
        const payloadPriority = 'priority' in payload
          ? payload.priority : prior.priority ?? null;
        const payloadDue = 'due_local_date' in payload
          ? payload.due_local_date : prior.due_local_date ?? null;
        return { beforeRef: change.before_ref,
          afterRef: { task_id: replayTaskId, priority: payloadPriority,
            due_local_date: payloadDue,
            task_revision: replayed.result.revision } as JsonObject };
      }
      const taskId = await boundTargetId(change, 'target_task_id',
        () => resolveProjectTask(repositories, request.project_id,
          String(payload.task_title)));
      const task = await repositories.tasks.readTask(taskId);
      if (task === undefined) throw resourceNotFound('Task');
      // 期望版本（R2）：本组自己的链 > 解释时冻结的适用版本；
      // 结算时对象还不存在（本组新建/后建）才按当前事实首次解析；
      // 确认时点已解析却没有可信版本基线 → 保守冲突，不读最新 revision 冒充原基线。
      const baseline = refObject(change.baseline_ref);
      const chainRevision = context.taskRevisions.get(taskId);
      const frozenRevision = typeof baseline.task_revision === 'string' &&
        /^\d+$/u.test(baseline.task_revision) ? BigInt(baseline.task_revision) : undefined;
      let expectedRevision: bigint;
      if (chainRevision !== undefined) expectedRevision = chainRevision;
      else if (frozenRevision !== undefined) expectedRevision = frozenRevision;
      else if (baseline.resolved === true) {
        throw applicabilityConflict('TARGET_BASELINE_MISSING',
          '这条计划调整缺少可信的适用版本基线（迁移前数据）；不能读取最新版本冒充原基线，' +
          '请基于当前任务状态重新发起。');
      } else expectedRevision = task.revision;
      if (task.revision !== expectedRevision) {
        throw applicabilityConflict('TARGET_VERSION_CONFLICT',
          `任务在确认之后已被修改（确认时点版本 ${toDecimalString(expectedRevision)}、` +
          `当前 ${toDecimalString(task.revision)}）；本次保留当前事实、不覆盖这次修改，` +
          '请基于最新任务重新确认。');
      }
      const beforeRef = change.before_ref ?? { task_id: task.id, priority: task.priority,
        due_local_date: task.due_local_date, timezone: task.due_timezone,
        task_revision: toDecimalString(expectedRevision) };
      if (change.before_ref === null) {
        await repositories.conversationState.updateChangeStatus(change.id,
          { status: 'PENDING', beforeRef });
      }
      // 只改模型真正给出的字段；没提的保持原值，不用缺省把截止日期清掉。
      const nextPriority = 'priority' in payload
        ? (payload.priority as 'LOW' | 'NORMAL' | 'HIGH' | null) : task.priority;
      const nextDue = 'due_local_date' in payload
        ? (payload.due_local_date as string | null) : task.due_local_date;
      let nextTimezone = task.due_timezone;
      if ('due_local_date' in payload) {
        if (nextDue === null) nextTimezone = null;
        else {
          const timezone = typeof payload.timezone === 'string' && payload.timezone !== ''
            ? payload.timezone : task.due_timezone;
          if (timezone === null) {
            throw requiredInputMissing([{ field: 'timezone',
              message: '设置截止日期需要本机时区；请由客户端提供后重试' }]);
          }
          nextTimezone = timezone;
        }
      }
      // R4：after_ref 记 Owner 提交返回的确切新版本（重放则按原回执），撤回预检依赖它。
      const outcome = await replayOrRun(db, scopeKey, change.command_id, () =>
        setTaskPlanningMetadata(db, { workspaceId: request.workspace_id, taskId,
          commandId: change.command_id,
          expectedRevision: toDecimalString(expectedRevision),
          priority: nextPriority, dueLocalDate: nextDue, timezone: nextTimezone }));
      context.taskRevisions.set(taskId, BigInt(outcome.result.revision));
      return { beforeRef,
        afterRef: { task_id: task.id, priority: nextPriority, due_local_date: nextDue,
          task_revision: outcome.result.revision } };
    }
    case 'SYNC_EXTERNAL_RESULT': {
      // Slice B：只读核对。回执先行——同命令的重放按原核对结果回读，不重复核对。
      const syncRun = await replayOrRun(db, scopeKey, change.command_id, () =>
        runIdempotentCommand<JsonObject>(db, {
          scopeKey, commandId: change.command_id, commandType: 'SyncExternalResult',
          target: { workspace_id: request.workspace_id, change_id: change.id },
          body: { project_id: request.project_id,
            task_title: String(payload.task_title) },
          execute: async (repos) => {
            const taskId = await boundTargetId(change, 'target_task_id',
              () => resolveProjectTask(repos, request.project_id,
                String(payload.task_title)));
            const task = await repos.tasks.readTask(taskId);
            if (task === undefined) throw resourceNotFound('Task');
            const checked = await evaluateExternalSync(db, request, repos, task);
            // 核对本身是可追溯动作：写入审计账本，但不改任何业务状态。
            await repos.activities.insertActivityRecord({ id: randomUUID(),
              workspaceId: request.workspace_id, actorKind: 'HUMAN',
              actorRef: LOCAL_ACTOR_REF, commandId: change.command_id,
              projectId: request.project_id, taskId: task.id,
              eventType: 'CONVERSATION_EXTERNAL_CHECKED',
              factRefs: { request_id: request.id, ...checked } });
            return checked;
          },
        }));
      return { beforeRef: null, afterRef: syncRun.result };
    }
    case 'COMPLETE_TASK': {
      // Slice B：明确的完成与接受指令，沿原完成 Owner 提交。
      const replayedComplete = await peekReceipt(db, scopeKey, change.command_id);
      if (replayedComplete !== null) {
        return { beforeRef: change.before_ref,
          afterRef: replayedComplete.result };
      }
      const baseline = refObject(change.baseline_ref);
      const taskId = await boundTargetId(change, 'target_task_id',
        () => resolveProjectTask(repositories, request.project_id,
          String(payload.task_title)));
      const task = await repositories.tasks.readTask(taskId);
      if (task === undefined) throw resourceNotFound('Task');
      // 已满足原条件：请求的事实已经成立，不产生第二次完成。
      if (task.status === 'DONE' && task.current_completion_id !== null) {
        return { beforeRef: null, skipped: 'ALREADY_COMPLETED',
          afterRef: { task_id: task.id, completion_id: task.current_completion_id } };
      }
      const frozenTaskRevision = typeof baseline.task_revision === 'string'
        ? BigInt(baseline.task_revision) : undefined;
      const frozenAcceptance = typeof baseline.acceptance_revision === 'string'
        ? BigInt(baseline.acceptance_revision) : undefined;
      if (baseline.resolved !== true || frozenTaskRevision === undefined ||
          frozenAcceptance === undefined) {
        throw applicabilityConflict('TARGET_BASELINE_MISSING',
          '完成指令缺少可信的适用基线；不按最新版本冒充原指令，请重新发起。');
      }
      if (task.revision !== frozenTaskRevision) {
        throw applicabilityConflict('TARGET_VERSION_CONFLICT',
          `任务在确认之后已被修改（确认时点版本 ${toDecimalString(frozenTaskRevision)}、` +
          `当前 ${toDecimalString(task.revision)}）；完成绑定确切版本，本次不覆盖、不完成，` +
          '请基于最新任务重新确认。');
      }
      if (task.acceptance_revision !== frozenAcceptance) {
        throw applicabilityConflict('ACCEPTANCE_STALE',
          `验收条件在确认之后已改变（确认时点 v${toDecimalString(frozenAcceptance)}、` +
          `当前 v${toDecimalString(task.acceptance_revision)}）；旧条件的接受不能完成新周期。`);
      }
      if (storage === undefined) {
        throw changeFailure('STORAGE_UNAVAILABLE',
          '完成指令需要受管内容存储，但当前入口没有提供；请从工作台重新提交。');
      }
      const criteria = await repositories.tasks.listCriteria(task.id,
        task.acceptance_revision);
      const artifacts = await listTaskArtifacts(db, request.workspace_id, task.id);
      const artifactVersionIds = artifacts.items
        .map((artifact) => artifact.latest_version_id)
        .filter((versionId): versionId is string => typeof versionId === 'string');
      // 接受声明绑定原用户消息原文：不是模型编造的措辞。
      const statement = await readSourceMessage(db, request.source_message_id);
      const outcome = await completeHumanTask(db, storage, {
        workspaceId: request.workspace_id, taskId: task.id,
        commandId: change.command_id,
        expectedRevision: toDecimalString(task.revision),
        acceptanceRevision: toDecimalString(task.acceptance_revision),
        artifactVersionIds,
        acceptance: { statement,
          acceptedCriterionIds: criteria.map((criterion) => criterion.criterion_id),
          reason: undefined } });
      return { beforeRef: { task_id: task.id, status: task.status,
          task_revision: toDecimalString(task.revision),
          acceptance_revision: toDecimalString(task.acceptance_revision) },
        afterRef: outcome.result as unknown as JsonObject };
    }
    case 'UNDO_STATE_CHANGE': {
      // 第五节：自然语言撤回。冻结的目标优先；结算时目标不唯一 → 应用时按当前事实
      // 再解析一次（0 条 / 多条都类型化失败，不猜原对象）。
      const undoBaseline = refObject(change.baseline_ref);
      let targetRequestId = typeof undoBaseline.target_request_id === 'string'
        ? undoBaseline.target_request_id : undefined;
      if (targetRequestId === undefined) {
        const candidates = (await repositories.conversationState
          .listSessionRequests(request.workspace_id, request.session_id, 20))
          .filter((row) => row.id !== request.id &&
            (row.status === 'APPLIED' || row.status === 'PARTIAL' ||
              row.status === 'UNDOING'));
        if (candidates.length === 0) {
          throw changeFailure('UNDO_TARGET_NOT_FOUND',
            '同一会话里没有可撤回的状态调整：这次可能还没有生效的调整，或它已经撤回过。');
        }
        if (candidates.length > 1) {
          throw changeFailure('UNDO_TARGET_AMBIGUOUS',
            `同一会话里有 ${candidates.length} 条已生效调整，不能猜要撤回哪一条；` +
            '请到具体那条调整的回执上执行撤回。');
        }
        targetRequestId = candidates[0]!.id;
      }
      const targetRow = await repositories.conversationState.readRequest(targetRequestId);
      if (targetRow === undefined || targetRow.workspace_id !== request.workspace_id ||
          targetRow.session_id !== request.session_id) {
        throw changeFailure('UNDO_TARGET_NOT_FOUND',
          '要撤回的原调整不在这个会话里，本次不执行撤回。');
      }
      // 复用按钮撤回的同一应用用例：undo-plan、范围决定与持久 undo_command_id 全部不变；
      // 目标不可整组撤回时由原用例给出 UNDO_SCOPE_REQUIRED，本条如实记为失败，
      // 范围仍由原回执上的方案面板决定。
      const outcome = await withdrawStateMaintenance(db, {
        workspaceId: request.workspace_id, requestId: targetRow.id,
        commandId: targetRow.undo_command_id });
      return { beforeRef: null,
        afterRef: { undone_request_id: targetRow.id, undo_status: outcome.status,
          undo_command_id: targetRow.undo_command_id } };
    }
  }
}

/** 单条变更独立结算：Owner 命令自带短事务，失败写类型化原因，不阻断其余变更。 */
async function applyChange(db: DbExecutor, request: ConversationStateRequestRow,
  change: ConversationStateChangeRow, context: ApplyContext,
  storage: ManagedContentStore | undefined): Promise<void> {
  const repositories = createRepositories(db);
  try {
    const outcome = await runStateChange(db, request, change, context, storage);
    if (outcome.skipped !== undefined) {
      await repositories.conversationState.updateChangeStatus(change.id,
        { status: 'SKIPPED', beforeRef: outcome.beforeRef,
          afterRef: { ...((outcome.afterRef ?? {}) as Record<string, unknown>),
            skip_reason: outcome.skipped } as JsonObject });
      return;
    }
    await repositories.conversationState.updateChangeStatus(change.id,
      { status: 'APPLIED', beforeRef: outcome.beforeRef, afterRef: outcome.afterRef });
  } catch (error) {
    const failure = failureOf(error);
    await repositories.conversationState.updateChangeStatus(change.id,
      { status: 'FAILED', error: { code: failure.code, message: failure.message } });
  }
}

function appliedStatusOf(changes: readonly { readonly status: StateChangeStatus }[],
  decisionPending: boolean): StateMaintenanceStatus {
  // SKIPPED = 请求的事实本来就已经成立（没有新效果），与 APPLIED 一样属于「已结算成功」。
  const satisfied = (status: StateChangeStatus): boolean =>
    status === 'APPLIED' || status === 'SKIPPED';
  // DECLINED = 按用户的决定不执行：已结算、但没有生效，绝不能并进「已生效」。
  const settled = (status: StateChangeStatus): boolean =>
    satisfied(status) || status === 'DECLINED';
  const statuses = changes.map((change) => change.status);
  if (statuses.every(satisfied)) return 'APPLIED';
  if (statuses.some((status) => status === 'FAILED')) {
    return statuses.some(settled) ? 'PARTIAL' : 'FAILED';
  }
  // 剩下的都是仍在等待的变更：有待决定就是「等决定」，不是失败。
  if (statuses.some((status) => status === 'PENDING')) {
    if (decisionPending) return 'DECISION_REQUIRED';
    return statuses.some(settled) ? 'PARTIAL' : 'FAILED';
  }
  if (statuses.some((status) => status === 'DECLINED')) {
    return statuses.some(satisfied) ? 'PARTIAL' : 'DECLINED';
  }
  return statuses.some(satisfied) ? 'PARTIAL' : 'FAILED';
}

type DecisionGate = {
  readonly pending: boolean;
  /** decision_required 没给 blocked_changes：整组都等（最保守缺省）。 */
  readonly blockAll: boolean;
  readonly blocked: ReadonlySet<number>;
};

function decisionGate(row: ConversationStateRequestRow): DecisionGate {
  if (row.decision_required === null) {
    return { pending: false, blockAll: false, blocked: new Set() };
  }
  const raw = row.decision_required.blocked_changes;
  if (!Array.isArray(raw)) return { pending: true, blockAll: true, blocked: new Set() };
  return { pending: true, blockAll: false,
    blocked: new Set(raw.filter((item): item is number => typeof item === 'number')) };
}

const STATE_DEPENDENT_KINDS: readonly StateChangeKind[] =
  ['SET_PHASE', 'SET_NEXT_ACTION', 'ADD_BLOCKER', 'RESOLVE_BLOCKER'];

/**
 * 链式期望版本的起点：本组上一次已生效的状态变更所产生的版本。
 * 没有历史推进时由每条变更自己取确认基线（0064）。
 */
function seedStateContext(changes: readonly ConversationStateChangeRow[]): ApplyContext {
  const applied = changes.filter((change) =>
    change.status === 'APPLIED' && STATE_DEPENDENT_KINDS.includes(change.change_kind));
  const last = applied.at(-1);
  const revision = last === undefined ? undefined
    : refObject(last.after_ref).state_revision;
  return { stateRevision: typeof revision === 'string' && /^\d+$/u.test(revision)
    ? BigInt(revision) : null,
    taskRevisions: seedTaskRevisions(changes) };
}

/**
 * 把已保存的候选逐条经既有领域 Owner 生效。
 *
 * 每条变更用自己的固定 command_id 走 Owner 的幂等命令；中断后重入时 APPLIED/SKIPPED 跳过、
 * PENDING 继续（回执重放保证不重复生效）。逐条独立短事务，部分成功如实显示为 PARTIAL；
 * 确认基线与后续修改冲突的条目保持 FAILED + 类型化冲突原因，绝不覆盖当前事实。
 */
export async function applyStateMaintenance(db: DbExecutor, input: {
  readonly workspaceId: string; readonly requestId: string;
  /** Slice B：COMPLETE_TASK 需要受管内容存储（HTTP 入口由依赖注入；直连用例自行提供）。 */
  readonly storage?: ManagedContentStore | undefined;
}): Promise<ApplyStateMaintenanceResult> {
  const repositories = createRepositories(db);
  let row = await readRequestRow(db, input.workspaceId, input.requestId);
  const gate = decisionGate(row);
  // 有待决定且整组都在等：先取得决定，一条都不应用。
  if (gate.pending && gate.blockAll) {
    throw invalidTransition('需先取得连带承诺的决定，再应用这组状态维护。');
  }
  if (row.decision !== 'MAINTAIN' || row.candidate_status !== 'READY') {
    throw invalidTransition('这条请求还没有可用的状态维护候选。');
  }
  if (row.status === 'APPLIED' || row.status === 'PARTIAL' || row.status === 'FAILED' ||
      row.status === 'DECLINED') {
    // 终态重入：按已保存的结算结果回读，不产生第二组对象或版本。
    return settledResult(row, await repositories.conversationState.listChangeRows(row.id));
  }
  if (row.status === 'UNDOING' || row.status === 'UNDONE' || row.status === 'UNDO_PARTIAL' ||
      row.status === 'UNDO_BLOCKED') {
    throw invalidTransition('这组状态维护已进入撤回流程，不能再次应用。');
  }
  if (row.status !== 'READY' && row.status !== 'APPLYING' &&
      row.status !== 'DECISION_REQUIRED') {
    throw invalidTransition(`状态维护请求当前状态 ${row.status} 不能应用。`);
  }
  const entered = await repositories.conversationState.setRequestStatus(row.id,
    { from: ['READY', 'DECISION_REQUIRED'], status: 'APPLYING' });
  if (entered === undefined) {
    // 另一个调用者已推进：回读它的事实；APPLYING 是可恢复的在途态，允许原身份续跑。
    const current = await repositories.conversationState.readRequest(row.id);
    if (current === undefined) throw resourceNotFound('State maintenance request');
    if (current.status !== 'APPLYING') {
      return settledResult(current,
        await repositories.conversationState.listChangeRows(current.id));
    }
    row = current;
  }
  row = (await repositories.conversationState.readRequest(row.id)) ?? row;

  const changes = await repositories.conversationState.listChangeRows(row.id);
  const context = seedStateContext(changes);
  for (const change of changes) {
    if (change.status !== 'PENDING') continue;
    // 被连带决定挡住的变更保持 PENDING：独立且明确的修改照常生效。
    if (gate.pending && (gate.blockAll || gate.blocked.has(change.ordinal))) continue;
    await applyChange(db, row, change, context, input.storage);
  }
  const finalChanges = await repositories.conversationState.listChangeRows(row.id);
  const finalStatus = appliedStatusOf(finalChanges, gate.pending);
  if (finalStatus === 'DECISION_REQUIRED' && row.status === 'DECISION_REQUIRED') {
    // 一条都没有解锁：状态不变，不产生第二次「已生效」记录。
    return settledResult(row, finalChanges);
  }
  const advanced = await withTransaction(db, async (repos) => {
    const moved = await repos.conversationState.setRequestStatus(row.id,
      { from: ['READY', 'APPLYING', 'DECISION_REQUIRED'], status: finalStatus });
    if (moved === undefined) return undefined;
    await repos.activities.insertActivityRecord({ id: randomUUID(),
      workspaceId: row.workspace_id, actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
      commandId: moved.apply_command_id, projectId: row.project_id, taskId: null,
      eventType: 'CONVERSATION_STATE_APPLIED',
      factRefs: { request_id: row.id, status: finalStatus,
        applied: finalChanges.filter((change) => change.status === 'APPLIED').length,
        skipped: finalChanges.filter((change) => change.status === 'SKIPPED').length,
        failed: finalChanges.filter((change) => change.status === 'FAILED').length } });
    return moved;
  });
  const settledRow = advanced ?? (await repositories.conversationState.readRequest(row.id)) ?? row;
  return settledResult(settledRow, finalChanges);
}

/**
 * 对既有 DECISION_REQUIRED 的一句话续答（总纲 §0.8.1「连带影响」/ 测试计划 NLS-11）。
 *
 * 绑定原请求与**用户看到答案时的版本**：expected_revision 在写事务 CAS 内核对，
 * 不重算一份新方案冒充已确认；决定落库、被拒绝变更的结算与状态推进在同一短事务提交。
 * 三种语义分开：ACCEPT 解锁被挡变更后由原 applications 继续；DECLINE 只把受这项决定
 * 约束的变更结算为 DECLINED（按决定不执行），独立且已生效的修改保留；同命令重放先于
 * 一切可变状态前置，响应丢失后按原回执回读（异载荷严格 COMMAND_ID_REUSED）。
 */
export async function replyStateDecision(db: DbExecutor, input: {
  readonly workspaceId: string; readonly requestId: string; readonly commandId: string;
  readonly resolution: 'ACCEPT' | 'DECLINE';
  readonly answer: string;
  readonly expectedRevision: string;
}): Promise<ApplyStateMaintenanceResult> {
  const repositories = createRepositories(db);
  const answer = input.answer.trim();
  if (answer === '') {
    throw validationFailed([{ field: 'answer', message: '回答不能为空' }]);
  }
  const scopeKey = httpCommandScopeKey(input.workspaceId);
  const row = await readRequestRow(db, input.workspaceId, input.requestId);

  // R5：原命令回执与载荷核对先于「当前还在等决定」这类可变状态前置。
  const payloadHash = computePayloadHash({
    commandType: 'AnswerStateDecision',
    target: { request_id: row.id },
    body: { resolution: input.resolution, answer,
      expected_revision: input.expectedRevision } });
  const prior = await repositories.receipts.findReceipt({ scopeKey,
    commandId: input.commandId });
  if (prior !== undefined) {
    // 同命令不同载荷（换答案/版本/决定）→ CommandIdReusedError（409），不返回别人的成功。
    resolveExistingReceipt(prior, payloadHash);
    const current = await readRequestRow(db, input.workspaceId, input.requestId);
    return settledResult(current,
      await repositories.conversationState.listChangeRows(current.id));
  }

  if (row.decision_required === null) {
    throw invalidTransition('这条请求没有等待决定的连带承诺。');
  }
  if (toDecimalString(row.revision) !== input.expectedRevision) {
    throw applicabilityConflict('DECISION_STALE',
      `这个待决定在你看到之后已经变化（当前修订 v${toDecimalString(row.revision)}、` +
      `你看到的是 v${input.expectedRevision}）；请重新读取后再回答，` +
      '避免把旧问题的答案当成新问题的确认。');
  }
  const question = typeof row.decision_required.question === 'string'
    ? row.decision_required.question : '';
  const changes = await repositories.conversationState.listChangeRows(row.id);
  const gate = decisionGate(row);
  await runIdempotentCommand<{ request_id: string }>(db, {
    scopeKey, commandId: input.commandId,
    commandType: 'AnswerStateDecision', target: { request_id: row.id },
    body: { resolution: input.resolution, answer,
      expected_revision: input.expectedRevision },
    execute: async (repos) => {
      // 拒绝只结算受这项决定约束、仍在等待的变更；独立且已生效的修改不被补偿或撤销。
      const declinedChanges = input.resolution === 'DECLINE'
        ? changes.filter((change) => change.status === 'PENDING' &&
            (gate.blockAll || gate.blocked.has(change.ordinal)))
            .map((change) => ({ ordinal: change.ordinal, resolution: input.resolution,
              answer, question }))
        : [];
      const declinedOrdinals = new Set(declinedChanges.map((item) => item.ordinal));
      const settledStatuses = changes.map((change): StateChangeStatus =>
        declinedOrdinals.has(change.ordinal) && change.status === 'PENDING'
          ? 'DECLINED' : change.status);
      // 还有变更在等 → READY 由原 applications 继续（ACCEPT 解锁 / DECLINE 只剩独立项）；
      // 全部已结算 → 按各条事实取终态（含 DECLINED），不回到可被自动应用的 READY。
      const nextStatus: StateMaintenanceStatus = settledStatuses.includes('PENDING')
        ? 'READY'
        : appliedStatusOf(settledStatuses.map((status) => ({ status })), false);
      const updated = await repos.conversationState.resolveDecision(row.id, {
        from: ['DECISION_REQUIRED'], status: nextStatus,
        expectedRevision: input.expectedRevision, declinedChanges, changes: [] });
      if (updated === undefined) {
        // 并发同命令：胜者与回执在同一事务提交——CAS 输了先核对它的原回执，
        // 同载荷时按原结果收敛（本事务随后的回执插入由唯一约束裁决）。
        const raced = await repos.receipts.findReceipt({ scopeKey,
          commandId: input.commandId });
        if (raced !== undefined) {
          return resolveExistingReceipt<{ request_id: string }>(raced, payloadHash).result;
        }
        // 写事务 CAS 输了：区分「决定仍在等但版本被并发推进」与「已经答过」。
        const current = await repos.conversationState.readRequest(row.id);
        if (current !== undefined && current.decision_required !== null) {
          throw applicabilityConflict('DECISION_STALE',
            `这个待决定在你看到之后已经变化（当前修订 v${toDecimalString(current.revision)}、` +
            `你看到的是 v${input.expectedRevision}）；请重新读取后再回答。`);
        }
        throw invalidTransition('这条待决定已经不在等你回答；请按原回执核对当前事实。');
      }
      await repos.activities.insertActivityRecord({ id: randomUUID(),
        workspaceId: row.workspace_id, actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
        commandId: input.commandId, projectId: row.project_id, taskId: null,
        eventType: 'CONVERSATION_STATE_DECISION_ANSWERED',
        factRefs: { request_id: row.id, resolution: input.resolution, answer,
          expected_revision: input.expectedRevision, question,
          declined: declinedChanges.length } });
      return { request_id: row.id };
    },
  });
  const updated = await readRequestRow(db, input.workspaceId, input.requestId);
  return settledResult(updated,
    await repositories.conversationState.listChangeRows(updated.id));
}

async function readRequestRow(db: DbExecutor, workspaceId: string,
  requestId: string): Promise<ConversationStateRequestRow> {
  const row = await createRepositories(db).conversationState.readRequest(requestId);
  if (row === undefined || row.workspace_id !== workspaceId) {
    throw resourceNotFound('State maintenance request');
  }
  return row;
}
/* -------------------------------------------------------------------------- */
/* 撤回阶段（整组逆序补偿）                                                    */
/* -------------------------------------------------------------------------- */

export type CompensationAction =
  | { readonly type: 'SET_PHASE'; readonly phase: string }
  | { readonly type: 'SET_NEXT_ACTION'; readonly taskId: string | null }
  | { readonly type: 'RESOLVE_BLOCKER'; readonly blockerId: string }
  | { readonly type: 'ADD_BLOCKER'; readonly targetKind: 'PROJECT' | 'TASK';
      readonly targetId: string; readonly reason: string; readonly sourceRef: string }
  | { readonly type: 'REMOVE_DEPENDENCY'; readonly taskId: string;
      readonly dependsOnTaskId: string; readonly dependencyKind: 'BLOCKS' | 'INFORMS' }
  | { readonly type: 'CANCEL_TASK'; readonly taskId: string }
  | { readonly type: 'SET_TASK_PLANNING'; readonly taskId: string;
      readonly priority: 'LOW' | 'NORMAL' | 'HIGH' | null;
      readonly dueLocalDate: string | null; readonly timezone: string | null }
  | { readonly type: 'UNLINK_GOAL'; readonly goalId: string }
  | { readonly type: 'RETIRE_KNOWLEDGE'; readonly knowledgeId: string }
  | { readonly type: 'UNDO_ENTRY_MISSING'; readonly missingKind: StateChangeKind };

export interface PlannedCompensation {
  readonly changeId: string;
  readonly ordinal: number;
  readonly commandId: string;
  readonly action: CompensationAction;
}

/**
 * 撤回补偿身份由 undo_command_id 与变更命令身份确定性派生：
 * 同一变更的多次补偿尝试共享同一身份，重试命中原回执，不换身份绕过。
 */
export function deriveCompensationCommandId(undoCommandId: string,
  changeCommandId: string): string {
  const hex = createHash('sha256').update(`${undoCommandId}:${changeCommandId}`, 'utf8')
    .digest().subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function refText(ref: JsonObject | null, key: string): string | undefined {
  const value = refObject(ref)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function missingUndo(changeKind: StateChangeKind): CompensationAction {
  return { type: 'UNDO_ENTRY_MISSING', missingKind: changeKind };
}

function compensationActionFor(requestId: string,
  change: ConversationStateChangeRow): CompensationAction {
  const before = change.before_ref;
  const after = change.after_ref;
  switch (change.change_kind) {
    case 'SET_PHASE': {
      const phase = refText(before, 'phase');
      return phase === undefined ? missingUndo(change.change_kind) : { type: 'SET_PHASE', phase };
    }
    case 'SET_NEXT_ACTION': {
      const taskId = refObject(before).task_id;
      return { type: 'SET_NEXT_ACTION',
        taskId: typeof taskId === 'string' && taskId !== '' ? taskId : null };
    }
    case 'ADD_BLOCKER': {
      const blockerId = refText(after, 'blocker_id');
      return blockerId === undefined ? missingUndo(change.change_kind)
        : { type: 'RESOLVE_BLOCKER', blockerId };
    }
    case 'RESOLVE_BLOCKER': {
      const targetKind = before?.target_kind;
      const targetId = refText(before, 'target_id');
      const reason = refText(before, 'reason');
      if ((targetKind !== 'PROJECT' && targetKind !== 'TASK') ||
          targetId === undefined || reason === undefined) {
        return missingUndo(change.change_kind);
      }
      return { type: 'ADD_BLOCKER', targetKind, targetId, reason,
        sourceRef: `undo:${requestId}` };
    }
    case 'ADD_TASK_DEPENDENCY': {
      const dependency = refObject(after).dependency;
      const taskId = typeof (dependency as Record<string, unknown> | undefined)?.task_id === 'string'
        ? (dependency as Record<string, string>).task_id : undefined;
      const dependsOnTaskId =
        typeof (dependency as Record<string, unknown> | undefined)?.depends_on_task_id === 'string'
          ? (dependency as Record<string, string>).depends_on_task_id : undefined;
      const dependencyKind = payloadRecord(change).dependency_kind === 'INFORMS'
        ? 'INFORMS' as const : 'BLOCKS' as const;
      if (taskId === undefined || dependsOnTaskId === undefined) {
        return missingUndo(change.change_kind);
      }
      return { type: 'REMOVE_DEPENDENCY', taskId, dependsOnTaskId, dependencyKind };
    }
    case 'CREATE_TASK': {
      const taskId = refText(after, 'task_id');
      return taskId === undefined ? missingUndo(change.change_kind)
        : { type: 'CANCEL_TASK', taskId };
    }
    case 'SET_TASK_PLANNING': {
      const taskId = refText(before, 'task_id');
      const priority = before?.priority;
      if (taskId === undefined) return missingUndo(change.change_kind);
      return { type: 'SET_TASK_PLANNING', taskId,
        priority: priority === 'LOW' || priority === 'NORMAL' || priority === 'HIGH'
          ? priority : null,
        dueLocalDate: typeof before?.due_local_date === 'string'
          ? before.due_local_date : null,
        timezone: typeof before?.timezone === 'string' ? before.timezone : null };
    }
    case 'LINK_GOAL': {
      const goalId = refText(after, 'goal_id');
      return goalId === undefined ? missingUndo(change.change_kind)
        : { type: 'UNLINK_GOAL', goalId };
    }
    case 'CREATE_KNOWLEDGE': {
      const knowledgeId = refText(after, 'knowledge_id');
      return knowledgeId === undefined ? missingUndo(change.change_kind)
        : { type: 'RETIRE_KNOWLEDGE', knowledgeId };
    }
    case 'CREATE_GOAL':
    case 'CREATE_DECISION':
    case 'VERSION_KNOWLEDGE':
      return missingUndo(change.change_kind);
    // 核对是只读动作，不进补偿计划（buildCompensationPlan 过滤）；完成记录不随整组撤回自动重开。
    case 'SYNC_EXTERNAL_RESULT':
    case 'COMPLETE_TASK':
    // 自然语言撤回的结果不随本组撤回自动恢复：要恢复被撤回的调整需重新发起原调整。
    case 'UNDO_STATE_CHANGE':
      return missingUndo(change.change_kind);
    case 'REPORT_ACCEPTANCE_TIME':
      return missingUndo(change.change_kind);
    case 'CREATE_HYPOTHESIS':
      return missingUndo(change.change_kind);
    case 'START_WORK_SEGMENT':
      return missingUndo(change.change_kind);
  }
}

/**
 * 撤回补偿计划：只覆盖已生效（APPLIED）的变更，按 ordinal 逆序补偿。
 * CREATE_GOAL / CREATE_DECISION / VERSION_KNOWLEDGE 没有既有撤销入口，归为
 * UNDO_ENTRY_MISSING——不造删除入口，也不假装撤销。
 * SYNC_EXTERNAL_RESULT 是只读核对（审计历史），不构成可补偿的业务效果，直接排除；
 * COMPLETE_TASK 保留在计划里并归为 UNDO_ENTRY_MISSING：完成记录不随整组撤回自动重开（NLS-12）。
 */
export function buildCompensationPlan(requestId: string, undoCommandId: string,
  changes: readonly ConversationStateChangeRow[]): readonly PlannedCompensation[] {
  return [...changes]
    .filter((change) => change.status === 'APPLIED' &&
      change.change_kind !== 'SYNC_EXTERNAL_RESULT')
    .sort((left, right) => right.ordinal - left.ordinal)
    .map((change) => ({ changeId: change.id, ordinal: change.ordinal,
      commandId: deriveCompensationCommandId(undoCommandId, change.command_id),
      action: compensationActionFor(requestId, change) }));
}

async function compensateChange(db: DbExecutor, request: ConversationStateRequestRow,
  change: ConversationStateChangeRow, entry: PlannedCompensation,
  context: ApplyContext): Promise<void> {
  const repositories = createRepositories(db);
  const scopeKey = httpCommandScopeKey(request.workspace_id);
  const markCompensated = async (): Promise<void> => {
    await repositories.conversationState.updateChangeStatus(change.id,
      { status: 'COMPENSATED', compensationCommandId: entry.commandId });
  };
  const markFailed = async (code: string, message: string): Promise<void> => {
    await repositories.conversationState.updateChangeStatus(change.id,
      { status: 'COMPENSATION_FAILED', error: { code, message },
        compensationCommandId: entry.commandId });
  };
  try {
    // 局部 const 绑定让每个分支的动作类型在闭包内保持收窄。
    const action = entry.action;
    switch (action.type) {
      case 'UNDO_ENTRY_MISSING':
        await markFailed('UNDO_ENTRY_MISSING',
          `${action.missingKind} 没有既有撤销入口：不自动删除已创建的事实。`);
        return;
      case 'SET_PHASE':
      case 'SET_NEXT_ACTION':
      case 'RESOLVE_BLOCKER':
      case 'ADD_BLOCKER': {
        // 撤回同样按链式期望版本写：本组生效之后的合法人工修改会被预检/这里挡住，
        // 不用「读最新 revision」把别人的修改覆盖回去。
        const replayedState = await peekReceipt<RunStateCommandResult>(db, scopeKey,
          entry.commandId);
        if (replayedState !== null) {
          context.stateRevision = BigInt(replayedState.result.revision);
          await markCompensated();
          return;
        }
        const expected = context.stateRevision ?? (await requireProjectState(repositories,
          request.project_id)).revision;
        const current = await requireProjectState(repositories, request.project_id);
        if (current.revision !== expected) {
          await markFailed('STATE_VERSION_CONFLICT',
            `项目状态在本组生效之后又被修改（当前阶段 ${current.phase_key}、版本 ` +
            `${toDecimalString(current.revision)}）；撤回会覆盖这次修改，` +
            '因此本次保留当前事实，请先决定撤回范围。');
          return;
        }
        const params: Record<string, unknown> = action.type === 'SET_PHASE'
          ? { phase_key: action.phase }
          : action.type === 'SET_NEXT_ACTION'
            ? { next_action_task_id: action.taskId }
            : action.type === 'RESOLVE_BLOCKER'
              ? { blocker_id: action.blockerId }
              : { target_kind: action.targetKind, target_id: action.targetId,
                reason: action.reason, source_ref: action.sourceRef };
        const outcome = await runStateCommand(db, { workspaceId: request.workspace_id,
          projectId: request.project_id, commandId: entry.commandId,
          expectedRevision: toDecimalString(expected),
          action: action.type === 'SET_PHASE' ? 'SET_PHASE'
            : action.type === 'SET_NEXT_ACTION' ? 'SET_NEXT_ACTION'
              : action.type === 'RESOLVE_BLOCKER' ? 'RESOLVE_BLOCKER' : 'ADD_BLOCKER',
          params });
        context.stateRevision = BigInt(outcome.result.revision);
        await markCompensated();
        return;
      }
      case 'REMOVE_DEPENDENCY': {
        const stillExists = (await repositories.tasks.listDependencies(action.taskId))
          .some((row) => row.depends_on_task_id === action.dependsOnTaskId &&
            row.dependency_kind === action.dependencyKind);
        // 关系已经不在了：撤回想要的终态已经成立，不再发第二次删除命令。
        if (!stillExists) {
          await markCompensated();
          return;
        }
        await replayOrRun(db, scopeKey, entry.commandId, async () => {
          const task = await repositories.tasks.readTask(action.taskId);
          if (task === undefined) throw resourceNotFound('Task');
          return removeTaskDependency(db, { workspaceId: request.workspace_id,
            taskId: action.taskId, commandId: entry.commandId,
            expectedRevision: toDecimalString(task.revision),
            dependsOnTaskId: action.dependsOnTaskId,
            dependencyKind: action.dependencyKind });
        });
        await markCompensated();
        return;
      }
      case 'SET_TASK_PLANNING': {
        // 回执先行：补偿已提交、COMPENSATED 回执保存前中断时按原结果恢复。
        const replayedPlanning = await peekReceipt<TaskCommandResult>(db, scopeKey,
          entry.commandId);
        if (replayedPlanning !== null) {
          context.taskRevisions.set(action.taskId, BigInt(replayedPlanning.result.revision));
          await markCompensated();
          return;
        }
        const task = await repositories.tasks.readTask(action.taskId);
        if (task === undefined) throw resourceNotFound('Task');
        // R4：期望版本沿本组补偿链（种子 = 最后一条已生效变更的 after 版本），
        // 预检到提交之间的人工修改由 Owner CAS 挡住，不读最新 revision 强行恢复。
        const chainRevision = context.taskRevisions.get(action.taskId);
        const appliedRevision = refText(change.after_ref, 'task_revision');
        const expected = chainRevision
          ?? (appliedRevision === undefined ? undefined : BigInt(appliedRevision))
          // 0064 之前落库的历史行没有 after 版本：只能按当前事实继续（保守限于旧行）。
          ?? task.revision;
        const outcome = await setTaskPlanningMetadata(db, {
          workspaceId: request.workspace_id, taskId: action.taskId,
          commandId: entry.commandId, expectedRevision: toDecimalString(expected),
          priority: action.priority, dueLocalDate: action.dueLocalDate,
          timezone: action.timezone });
        context.taskRevisions.set(action.taskId, BigInt(outcome.result.revision));
        await markCompensated();
        return;
      }
      case 'CANCEL_TASK': {
        const task = await repositories.tasks.readTask(action.taskId);
        if (task === undefined) throw resourceNotFound('Task');
        if (task.status !== 'INBOX') {
          await markFailed('TASK_NO_LONGER_INBOX',
            `任务已离开 INBOX（当前 ${task.status}），不能自动取消。`);
          return;
        }
        await replayOrRun(db, scopeKey, entry.commandId, () =>
          cancelTask(db, { workspaceId: request.workspace_id, taskId: task.id,
            commandId: entry.commandId, expectedRevision: toDecimalString(task.revision) }));
        await markCompensated();
        return;
      }
      case 'UNLINK_GOAL': {
        // 关联已不在：撤回想要的终态已成立，不再发第二次解除命令。
        const link = await repositories.projects.findProjectGoalLink(request.project_id,
          action.goalId);
        if (link === undefined) {
          await markCompensated();
          return;
        }
        await replayOrRun(db, scopeKey, entry.commandId, async () => {
          const project = await repositories.projects.readProject(request.project_id);
          if (project === undefined) throw resourceNotFound('Project');
          const impacted = await repositories.projects
            .listExplicitGoalTasksForGoal(request.project_id, action.goalId);
          return unlinkProjectGoal(db, { workspaceId: request.workspace_id,
            projectId: request.project_id, commandId: entry.commandId,
            expectedRevision: toDecimalString(project.revision), goalId: action.goalId,
            expectedImpactedTaskIds: impacted.map((row) => row.task_id) });
        });
        await markCompensated();
        return;
      }
      case 'RETIRE_KNOWLEDGE': {
        const root = await repositories.information.readRoot<InformationRootRow>(
          'knowledge', action.knowledgeId);
        // 已经不是有效知识（人工已归档）：终态已成立，不重复退休命令。
        if (root === undefined || root.status !== 'ACTIVE') {
          await markCompensated();
          return;
        }
        await replayOrRun(db, scopeKey, entry.commandId, async () =>
          retireInformation(db, { workspaceId: request.workspace_id,
            kind: 'knowledge', id: root.id, commandId: entry.commandId,
            expectedRevision: toDecimalString(root.revision) }));
        await markCompensated();
        return;
      }
    }
  } catch (error) {
    const failure = failureOf(error);
    await markFailed(failure.code, failure.message);
  }
}

function undoStatusOf(compensated: number, failed: number,
  remaining: number): StateMaintenanceStatus {
  // remaining = 仍在生效、未被（用户确认范围内）补偿的变更：整组没撤干净就不能报 UNDONE。
  if (failed === 0 && remaining === 0) return 'UNDONE';
  if (compensated === 0) return 'UNDO_BLOCKED';
  return 'UNDO_PARTIAL';
}

/* -------------------------------------------------------------------------- */
/* 撤回事前预检与方案                                                          */
/* -------------------------------------------------------------------------- */

export type UndoPlanItem = {
  readonly change_id: string;
  readonly ordinal: number;
  readonly change_kind: StateChangeKind;
  /** 补偿命令身份：确认范围后按同一身份执行，不换 ID。 */
  readonly command_id: string;
  readonly action: CompensationAction;
  readonly withdrawable: boolean;
  readonly reason_code: string | null;
  readonly reason: string | null;
  readonly impact: string | null;
  readonly facts: JsonObject;
};

export type UndoPlan = {
  readonly request_id: string;
  readonly undo_command_id: string;
  /** 绑定原变更、当前依赖与具体方案的摘要：确认范围时回传，事实变化即失效。 */
  readonly plan_digest: string;
  readonly fully_withdrawable: boolean;
  readonly blocked_count: number;
  readonly state_revision: string;
  readonly items: readonly UndoPlanItem[];
};

type CompensationEvaluation = {
  readonly withdrawable: boolean;
  readonly reason_code: string | null;
  readonly reason: string | null;
  readonly impact: string | null;
  readonly facts: JsonObject;
};

function evalOk(facts: JsonObject): CompensationEvaluation {
  return { withdrawable: true, reason_code: null, reason: null, impact: null, facts };
}

function evalBlocked(reasonCode: string, reason: string, impact: string,
  facts: JsonObject): CompensationEvaluation {
  return { withdrawable: false, reason_code: reasonCode, reason, impact, facts };
}

/**
 * 整组生效后的期望状态版本：取 ordinal 最大的**已生效**状态变更的 after 版本，
 * 再加已补偿的条数（每次状态补偿恰好 +1）。因此既识别「本组生效之后的人工修改」，
 * 也能在部分补偿后继续按同一链恢复，不靠读最新 revision 猜。
 */
function undoExpectedStateRevision(changes: readonly ConversationStateChangeRow[],
  currentRevision: bigint): { readonly expected: string; readonly original: string;
    readonly compensatedCount: number } {
  const settledStates = changes.filter((change) =>
    STATE_DEPENDENT_KINDS.includes(change.change_kind) &&
    (change.status === 'APPLIED' || change.status === 'COMPENSATED' ||
      change.status === 'COMPENSATION_FAILED'));
  const last = [...settledStates].sort((left, right) => right.ordinal - left.ordinal)[0];
  const raw = last === undefined ? undefined : refObject(last.after_ref).state_revision;
  const original = typeof raw === 'string' && /^\d+$/u.test(raw) ? raw
    : toDecimalString(currentRevision);
  const compensatedCount = changes.filter((change) =>
    STATE_DEPENDENT_KINDS.includes(change.change_kind) &&
    change.status === 'COMPENSATED').length;
  return { expected: toDecimalString(BigInt(original) + BigInt(compensatedCount)),
    original, compensatedCount };
}

async function evaluateCompensation(repositories: Repositories,
  request: ConversationStateRequestRow, change: ConversationStateChangeRow,
  action: CompensationAction,
  state: { readonly revision: bigint; readonly phase_key: string;
    readonly next_action_task_id: string | null },
  expectedRevision: string,
  planningChain: { readonly firstWithdrawable: boolean } | null,
): Promise<CompensationEvaluation> {
  switch (action.type) {
    case 'UNDO_ENTRY_MISSING':
      if (action.missingKind === 'COMPLETE_TASK') {
        return evalBlocked('UNDO_ENTRY_MISSING', '完成记录不随整组撤回自动重开',
          '完成与人工接受由原 Owner 的重开入口单独处理；整组撤回不自动重开、不恢复旧接受凭据，' +
          '也不假装这次完成没有发生过（NLS-12）。',
          { missing_kind: action.missingKind });
      }
      if (action.missingKind === 'UNDO_STATE_CHANGE') {
        return evalBlocked('UNDO_ENTRY_MISSING', '撤回结果不随本组撤回自动恢复',
          '这次撤回已经生效；要恢复被撤回的调整，请重新发起原调整指令，本组撤回不会自动反撤回。',
          { missing_kind: action.missingKind });
      }
      return evalBlocked('UNDO_ENTRY_MISSING',
        `${action.missingKind} 没有既有撤销入口`,
        `${action.missingKind} 创建的事实会保留在项目中；不造删除入口，也不假装已撤销。`,
        { missing_kind: action.missingKind });
    case 'SET_PHASE':
    case 'SET_NEXT_ACTION':
    case 'RESOLVE_BLOCKER':
    case 'ADD_BLOCKER': {
      const facts = { state_revision: toDecimalString(state.revision),
        expected_state_revision: expectedRevision, phase_key: state.phase_key };
      if (state.revision !== BigInt(expectedRevision)) {
        return evalBlocked('STATE_VERSION_CONFLICT',
          `项目状态已被后续修改（当前阶段 ${state.phase_key}、版本 ` +
          `${toDecimalString(state.revision)}，本组生效后应为 ${expectedRevision}）`,
          `按原范围撤回会把状态改回本组生效前的值，覆盖「${state.phase_key}」这次后续修改；` +
          '需要你决定保留哪一部分。', facts);
      }
      return evalOk(facts);
    }
    case 'CANCEL_TASK': {
      const task = await repositories.tasks.readTask(action.taskId);
      if (task === undefined) {
        return evalBlocked('TASK_NOT_FOUND', '这条指令创建的任务已不在项目中',
          '该任务已不存在，无需也无法再取消。', { task_id: action.taskId });
      }
      if (task.status !== 'INBOX') {
        return evalBlocked('TASK_NO_LONGER_INBOX',
          `任务已离开 INBOX（当前 ${task.status}）`,
          `撤回会取消一项当前为「${task.status}」的任务；已开始的工作不能被自动撤销。`,
          { task_id: task.id, task_status: task.status,
            task_revision: toDecimalString(task.revision) });
      }
      return evalOk({ task_id: task.id, task_revision: toDecimalString(task.revision) });
    }
    case 'SET_TASK_PLANNING': {
      const task = await repositories.tasks.readTask(action.taskId);
      if (task === undefined) {
        return evalBlocked('TASK_NOT_FOUND', '这条指令调整的任务已不在项目中',
          '该任务已不存在，无需再恢复它的优先级与截止日期。',
          { task_id: action.taskId });
      }
      const appliedRevision = refText(change.after_ref, 'task_revision');
      const facts = { task_id: task.id, task_revision: toDecimalString(task.revision),
        applied_task_revision: appliedRevision ?? null,
        priority: task.priority, due_local_date: task.due_local_date };
      if (planningChain !== null) {
        // R4：同任务链的后续补偿（逆序中更早的变更）不做逐条版本比较——
        // 它的期望版本由执行期的链式 CAS 给出（前一条补偿提交后的新版本）；
        // 可撤回性跟随链首，单独撤这一条会破坏本组的逆序链。
        if (!planningChain.firstWithdrawable) {
          return evalBlocked('TARGET_VERSION_CONFLICT',
            '同任务的后续变更不能单独撤回（本组的撤回链被挡住）',
            '这一条要等它之后、同一任务上的变更先撤回；当前存在挡住整条链的后续修改，' +
            '需要你先决定保留哪一部分。', facts);
        }
        return evalOk({ ...facts, chained: true });
      }
      if (appliedRevision !== undefined && appliedRevision !== toDecimalString(task.revision)) {
        return evalBlocked('TARGET_VERSION_CONFLICT',
          `任务在本组生效之后又被修改（当前修订 ${toDecimalString(task.revision)}，` +
          `生效后应为 ${appliedRevision}）`,
          '按原范围撤回会把优先级/截止日期改回生效前的值，覆盖这次后续修改；' +
          '需要你决定保留哪一部分。', facts);
      }
      return evalOk(facts);
    }
    case 'REMOVE_DEPENDENCY': {
      const exists = (await repositories.tasks.listDependencies(action.taskId))
        .some((row) => row.depends_on_task_id === action.dependsOnTaskId &&
          row.dependency_kind === action.dependencyKind);
      return evalOk({ dependency_exists: exists, task_id: action.taskId,
        depends_on_task_id: action.dependsOnTaskId });
    }
    case 'UNLINK_GOAL': {
      const link = await repositories.projects.findProjectGoalLink(request.project_id,
        action.goalId);
      return evalOk({ linked: link !== undefined, goal_id: action.goalId });
    }
    case 'RETIRE_KNOWLEDGE': {
      const root = await repositories.information.readRoot<InformationRootRow>('knowledge',
        action.knowledgeId);
      return evalOk({ knowledge_id: action.knowledgeId, status: root?.status ?? 'MISSING' });
    }
  }
}

function planDigestOf(requestId: string, undoCommandId: string,
  items: readonly UndoPlanItem[]): string {
  const canonical = JSON.stringify({ request_id: requestId, undo_command_id: undoCommandId,
    items: items.map((item) => ({ id: item.change_id, ord: item.ordinal, action: item.action,
      ok: item.withdrawable, why: item.reason_code, facts: item.facts })) });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * 撤回事前预检：对整组实际生效项先核对后续修改、依赖与不可撤回项，产出**只读方案**。
 * 任何不可撤回项都会让方案整体「需要决定范围」——预检阶段不写任何业务事实。
 */
export async function buildUndoPlan(db: DbExecutor, request:
  ConversationStateRequestRow): Promise<UndoPlan> {
  const repositories = createRepositories(db);
  const changes = await repositories.conversationState.listChangeRows(request.id);
  const entries = buildCompensationPlan(request.id, request.undo_command_id, changes);
  const state = await requireProjectState(repositories, request.project_id);
  const { expected } = undoExpectedStateRevision(changes, state.revision);
  const items: UndoPlanItem[] = [];
  // R4：同一任务的多条计划变更构成补偿链（执行顺序为 ordinal 逆序）：
  // 链首与当前版本核对，链上后续条目的可撤回性跟随链首。
  const seenTaskIds = new Set<string>();
  const chainFirstWithdrawable = new Map<string, boolean>();
  for (const entry of entries) {
    const change = changes.find((candidate) => candidate.id === entry.changeId);
    if (change === undefined) continue;
    let planningChain: { readonly firstWithdrawable: boolean } | null = null;
    if (entry.action.type === 'SET_TASK_PLANNING') {
      const taskId = entry.action.taskId;
      if (seenTaskIds.has(taskId)) {
        planningChain = { firstWithdrawable: chainFirstWithdrawable.get(taskId) ?? false };
      } else {
        seenTaskIds.add(taskId);
      }
    }
    const evaluation = await evaluateCompensation(repositories, request, change,
      entry.action, state, expected, planningChain);
    if (entry.action.type === 'SET_TASK_PLANNING' && planningChain === null) {
      chainFirstWithdrawable.set(entry.action.taskId, evaluation.withdrawable);
    }
    items.push({ change_id: change.id, ordinal: change.ordinal,
      change_kind: change.change_kind, command_id: entry.commandId, action: entry.action,
      ...evaluation });
  }
  const blockedCount = items.filter((item) => !item.withdrawable).length;
  return { request_id: request.id, undo_command_id: request.undo_command_id,
    plan_digest: planDigestOf(request.id, request.undo_command_id, items),
    fully_withdrawable: items.length > 0 && blockedCount === 0, blocked_count: blockedCount,
    state_revision: toDecimalString(state.revision), items };
}

function undoScopeRequired(plan: UndoPlan): DomainError {
  const blocked = plan.items.filter((item) => !item.withdrawable);
  const summary = blocked.map((item) =>
    `${item.change_kind}：${item.reason ?? '不可撤回'}`).join('；');
  return new DomainError({ code: 'UNDO_SCOPE_REQUIRED', status: 409,
    type: '/problems/undo-scope-required', title: '这组调整无法整组撤回',
    detail: `原范围中有 ${blocked.length} 项不能按原样撤回（${summary}）。` +
      '没有执行任何补偿；请先读取撤回方案，决定要撤回的具体范围后再提交。',
    retryable: false, retryAction: 'REFRESH_AND_REDECIDE' });
}

/** 读取撤回方案（只读，不写任何业务事实）。 */
export async function readUndoPlan(db: DbExecutor, workspaceId: string,
  requestId: string): Promise<UndoPlan> {
  return buildUndoPlan(db, await readRequestRow(db, workspaceId, requestId));
}

async function runCompensations(db: DbExecutor, row: ConversationStateRequestRow,
  scopeChangeIds: readonly string[], commandId: string): Promise<ApplyStateMaintenanceResult> {
  const repositories = createRepositories(db);
  const changes = await repositories.conversationState.listChangeRows(row.id);
  const state = await requireProjectState(repositories, row.project_id);
  const { expected } = undoExpectedStateRevision(changes, state.revision);
  const context: ApplyContext = { stateRevision: BigInt(expected),
    taskRevisions: seedTaskRevisions(changes) };
  const entries = buildCompensationPlan(row.id, row.undo_command_id, changes)
    .filter((entry) => scopeChangeIds.includes(entry.changeId));
  for (const entry of entries) {
    const change = changes.find((candidate) => candidate.id === entry.changeId);
    if (change === undefined || change.status !== 'APPLIED') continue;
    await compensateChange(db, row, change, entry, context);
  }
  const finalChanges = await repositories.conversationState.listChangeRows(row.id);
  const compensated = finalChanges.filter((change) => change.status === 'COMPENSATED').length;
  const failed = finalChanges.filter((change) => change.status === 'COMPENSATION_FAILED').length;
  // 只读核对（SYNC_EXTERNAL_RESULT）不构成待补偿效果：撤回后的「剩余」不含它。
  const remaining = finalChanges.filter((change) => change.status === 'APPLIED' &&
    change.change_kind !== 'SYNC_EXTERNAL_RESULT').length;
  const finalStatus = undoStatusOf(compensated, failed, remaining);
  const advanced = await withTransaction(db, async (repos) => {
    const moved = await repos.conversationState.setRequestStatus(row.id,
      { from: ['UNDOING'], status: finalStatus });
    if (moved === undefined) return undefined;
    await repos.activities.insertActivityRecord({ id: randomUUID(),
      workspaceId: row.workspace_id, actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
      commandId, projectId: row.project_id, taskId: null,
      eventType: 'CONVERSATION_STATE_WITHDRAWN',
      factRefs: { request_id: row.id, status: finalStatus, compensated,
        compensation_failed: failed, remaining,
        scope: [...scopeChangeIds] } });
    return moved;
  });
  const settledRow = advanced ?? (await repositories.conversationState.readRequest(row.id)) ?? row;
  return settledResult(settledRow, finalChanges);
}

function scopeFromRow(row: ConversationStateRequestRow): readonly string[] {
  const raw = row.undo_scope === null ? undefined : row.undo_scope.change_ids;
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * 整组撤回：只接受请求行上固化的 undo_command_id，不接受新造身份。
 *
 * 顺序是「事前预检 → （必要时）由用户决定范围 → CAS 抢占唯一 Owner → 按逆序补偿」：
 * 事前已知无法整组撤回时一个补偿都不执行，先把具体方案和影响交回用户；
 * 预检之后事实变化由 plan_digest 不匹配拒绝（UNDO_PLAN_STALE）；
 * 已提交的 UNDOING 由原 undo_command_id 重入，继续未完成的剩余补偿，不重复已提交的效果。
 */
export async function withdrawStateMaintenance(db: DbExecutor, input: {
  readonly workspaceId: string; readonly requestId: string; readonly commandId: string;
  readonly planDigest?: string | undefined;
  readonly confirmedChangeIds?: readonly string[] | undefined;
}): Promise<ApplyStateMaintenanceResult> {
  const repositories = createRepositories(db);
  const row = await readRequestRow(db, input.workspaceId, input.requestId);
  if (row.undo_command_id !== input.commandId) {
    throw validationFailed([{ field: 'command_id',
      message: 'withdraw must use the undo_command_id assigned to this request' }]);
  }

  // UNDOING 是已提交的在途撤回：按原身份恢复剩余补偿（不重来、不换身份）。
  if (row.status === 'UNDOING') {
    const scope = scopeFromRow(row);
    if (scope.length === 0) {
      throw invalidTransition('撤回方案缺失，无法确定要继续的范围；请按原请求核对后再试。');
    }
    return runCompensations(db, row, scope, input.commandId);
  }
  if (row.status === 'UNDONE' || row.status === 'UNDO_PARTIAL' || row.status === 'UNDO_BLOCKED') {
    // 幂等重入：已结算的撤回按当前事实回读，不重复补偿。
    return settledResult(row, await repositories.conversationState.listChangeRows(row.id));
  }
  if (row.status !== 'APPLIED' && row.status !== 'PARTIAL') {
    throw invalidTransition('只有已应用（APPLIED/PARTIAL）的状态维护可以整组撤回。');
  }

  const changes = await repositories.conversationState.listChangeRows(row.id);
  if (!changes.some((change) => change.status === 'APPLIED')) {
    throw invalidTransition('没有已生效的变更可撤回。');
  }
  const plan = await buildUndoPlan(db, row);
  if (plan.items.length === 0) throw invalidTransition('没有已生效的变更可撤回。');

  let scopeChangeIds: readonly string[];
  if (input.planDigest === undefined) {
    // 未附带已确认方案：只有整组都能撤回时才直接执行；否则一个都不动，交回决定范围。
    if (!plan.fully_withdrawable) throw undoScopeRequired(plan);
    scopeChangeIds = plan.items.map((item) => item.change_id);
  } else {
    if (input.planDigest !== plan.plan_digest) {
      throw applicabilityConflict('UNDO_PLAN_STALE',
        '预检之后这组事实已经变化，撤回方案已过期；请重新读取方案并按新的具体范围确认。');
    }
    const confirmed = [...new Set(input.confirmedChangeIds ?? [])];
    if (confirmed.length === 0) {
      throw validationFailed([{ field: 'confirmed_change_ids',
        message: '至少要确认一项要补偿的变更' }]);
    }
    const withdrawableIds = new Set(plan.items.filter((item) => item.withdrawable)
      .map((item) => item.change_id));
    const invalid = confirmed.filter((changeId) => !withdrawableIds.has(changeId));
    if (invalid.length > 0) {
      throw validationFailed([{ field: 'confirmed_change_ids',
        message: `确认范围包含当前不可撤回或不存在的变更：${invalid.join(', ')}` }]);
    }
    scopeChangeIds = confirmed;
  }

  // R4：撤回范围的链完整性——确认了某条 Task 计划变更时，同一任务上更晚的已生效变更
  // 必须一并确认，否则补偿跳过链的后段会破坏逆序恢复。
  const planByChange = new Map(plan.items.map((item) => [item.change_id, item]));
  for (const changeId of scopeChangeIds) {
    const item = planByChange.get(changeId);
    if (item === undefined || item.change_kind !== 'SET_TASK_PLANNING') continue;
    const taskId = (item.action as { readonly taskId?: string }).taskId;
    const missingTail = plan.items.filter((other) =>
      other.change_kind === 'SET_TASK_PLANNING' &&
      (other.action as { readonly taskId?: string }).taskId === taskId &&
      other.ordinal > item.ordinal && !scopeChangeIds.includes(other.change_id));
    if (missingTail.length > 0) {
      throw validationFailed([{ field: 'confirmed_change_ids',
        message: '同一任务上更晚的已生效变更必须一并确认（撤回按逆序补偿）：缺 ' +
          missingTail.map((other) => `#${other.ordinal + 1}`).join(', ') }]);
    }
  }

  // 只有持久 Owner 能推进：CAS 输方不执行任何计划，直接回读胜出事实。
  const started = await repositories.conversationState.startUndo(row.id,
    { from: ['APPLIED', 'PARTIAL'],
      scope: { plan_digest: plan.plan_digest, change_ids: [...scopeChangeIds] } });
  if (started === undefined) {
    const current = await repositories.conversationState.readRequest(row.id);
    if (current === undefined) throw resourceNotFound('State maintenance request');
    return settledResult(current,
      await repositories.conversationState.listChangeRows(current.id));
  }
  return runCompensations(db, started, scopeChangeIds, input.commandId);
}
