import type { JsonObject, JsonValue } from '../infrastructure/json.js';

/**
 * 0127：`/plan` 与 `/goal` 的模型输出信封（工作台 §44）。
 *
 * 两种信封都沿用主流程已有的约定：**整段输出是一个 JSON 对象**（或前面只有一句简短前言），
 * 带非空 `reply`。解析只做「形状校验 + 归一化」，不做任何业务判定：
 *   * 计划信封里的 `plan` 缺省 = 这一轮只是讨论，不产生新版本；
 *   * 目标信封里的 `goal` 缺省 = 这一轮没有给出结构化进展，只按正文记录；
 *   * 越界/超长/类型不符的字段被**丢弃**而不是整段失败——模型输出不合规的代价应该是
 *     「这一版计划少了一条待定项」，不是「用户看到一次解析异常」。
 *
 * 与主流程信封分开维护：三者的输出协议不同（执行候选、状态维护、计划、目标进展），
 * 合成一个 schema 会重演已经被否掉的「通用 schema」。
 */

const MAX_REPLY = 8_000;
const MAX_TEXT = 1_000;
const MAX_ITEMS = 20;
const MAX_STEPS = 30;
const ENVELOPE_PREAMBLE_LIMIT = 400;

export interface PlanStep {
  readonly title: string;
  readonly detail: string | null;
}

export interface PlanVerification {
  readonly statement: string;
  readonly method: string;
}

export interface PlanBody {
  readonly goal: string;
  readonly scope: readonly string[];
  readonly steps: readonly PlanStep[];
  readonly verification: readonly PlanVerification[];
  readonly open_questions: readonly string[];
}

export type PlanEnvelope =
  | { readonly kind: 'DISCUSSION'; readonly reply: string }
  | { readonly kind: 'PLAN'; readonly reply: string; readonly plan: PlanBody };

function parseObject(raw: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as JsonObject : undefined;
  } catch { return undefined; }
}

/** 整段输出就是信封，或信封前只有一段简短前言；其余情况按普通正文处理。 */
function envelopeCandidate(content: string): string | undefined {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  if (start <= 0) return undefined;
  if (trimmed.slice(0, start).trim().length > ENVELOPE_PREAMBLE_LIMIT) return undefined;
  const end = trimmed.lastIndexOf('}');
  if (end <= start) return undefined;
  const suffix = trimmed.slice(end + 1).trim();
  if (suffix !== '' && suffix !== '```') return undefined;
  return trimmed.slice(start, end + 1);
}

/** 从残缺信封里救回 `reply`：用户该读到模型想说的话，而不是 JSON 转义。 */
function salvageReply(content: string): string | undefined {
  const match = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(content);
  if (match === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(`"${match[1]}"`);
    return typeof parsed === 'string' && parsed.trim() !== '' ? parsed.trim() : undefined;
  } catch { return undefined; }
}

const INVALID_ENVELOPE_REPLY = '模型这次的输出格式不完整，没有形成可读的计划或进展。请重试一次。';

/**
 * 这一段输出是不是一次失败的「信封尝试」。
 *
 * 只有这种输出才需要清洗；普通 Markdown 正文必须原样返回——把正常回答当成坏信封
 * 清洗掉，等于凭空丢掉一条可用回复。
 */
function looksLikeEnvelopeAttempt(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) return true;
  const start = trimmed.indexOf('{');
  if (start < 0 || start > ENVELOPE_PREAMBLE_LIMIT) return false;
  if (/^```(?:json)?\s*$/iu.test(trimmed.slice(0, start))) return true;
  return /^"(?:reply|plan|goal)"\s*:/u.test(trimmed.slice(start + 1).trimStart());
}

function readableReply(content: string): string {
  if (!looksLikeEnvelopeAttempt(content)) return content;
  const salvaged = salvageReply(content);
  if (salvaged !== undefined) return salvaged;
  const start = content.indexOf('{');
  const prose = start < 0 ? content.trim() : content.slice(0, start).trim();
  return prose === '' || prose.startsWith('```') ? INVALID_ENVELOPE_REPLY : prose;
}

function textOf(value: JsonValue | undefined, max = MAX_TEXT): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.trim().length <= max
    ? value.trim() : undefined;
}

function stringList(value: JsonValue | undefined, max: number, maxChars = MAX_TEXT): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const item of value) {
    const text = textOf(item, maxChars);
    if (text !== undefined && !items.includes(text)) items.push(text);
    if (items.length >= max) break;
  }
  return items;
}

function objectList(value: JsonValue | undefined, max: number): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is JsonObject =>
    typeof item === 'object' && item !== null && !Array.isArray(item)).slice(0, max);
}

function envelopeOf(content: string): { readonly object: JsonObject; readonly reply: string } | undefined {
  const candidate = envelopeCandidate(content);
  if (candidate === undefined) return undefined;
  const object = parseObject(candidate);
  if (object === undefined) return undefined;
  const reply = textOf(object.reply, MAX_REPLY);
  return reply === undefined ? undefined : { object, reply };
}

/**
 * 读一次计划模式输出。
 *
 * `plan` 缺省或形状不合法时**不是**失败：这一轮按普通讨论呈现，计划卡保持上一版。
 * 这条容错是刻意的——「讨论两句也会被写成新版本计划」会让版本号失去意义，
 * 而用户要的是「形成计划后才有计划卡」。
 */
export function readPlanEnvelope(content: string): PlanEnvelope {
  const envelope = envelopeOf(content);
  if (envelope === undefined) return { kind: 'DISCUSSION', reply: readableReply(content) };
  const raw = envelope.object.plan;
  if (raw === undefined || raw === null) {
    return { kind: 'DISCUSSION', reply: envelope.reply };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'DISCUSSION', reply: envelope.reply };
  }
  const body = raw as JsonObject;
  const goal = textOf(body.goal, 2_000);
  if (goal === undefined) return { kind: 'DISCUSSION', reply: envelope.reply };
  const steps: PlanStep[] = [];
  for (const item of objectList(body.steps, MAX_STEPS)) {
    const title = textOf(item.title);
    if (title === undefined) continue;
    steps.push({ title, detail: textOf(item.detail, 2_000) ?? null });
  }
  const verification: PlanVerification[] = [];
  for (const item of objectList(body.verification, MAX_ITEMS)) {
    const statement = textOf(item.statement ?? item.check);
    if (statement === undefined) continue;
    verification.push({ statement, method: textOf(item.method, 40) ?? 'HUMAN' });
  }
  return { kind: 'PLAN', reply: envelope.reply, plan: {
    goal, scope: stringList(body.scope, MAX_ITEMS), steps, verification,
    open_questions: stringList(body.open_questions, MAX_ITEMS),
  } };
}

export type GoalState = 'CONTINUE' | 'NEEDS_USER' | 'BLOCKED' | 'COMPLETE';

export interface GoalCriterionReport {
  readonly key: string;
  readonly statement: string | null;
  readonly status: 'MET' | 'UNMET' | 'PENDING';
  readonly evidence: string | null;
  readonly required: boolean;
}

export interface GoalEnvelope {
  readonly reply: string;
  /** 缺省表示这一轮没有结构化进展；目标状态保持，只记录正文。 */
  readonly goal: {
    readonly state: GoalState;
    /** 本轮给出的成功条件（只在目标还没有条件时采用；之后的变化不覆盖已冻结的）。 */
    readonly criteria: readonly { readonly key: string; readonly statement: string;
      readonly required: boolean }[];
    readonly criteria_status: readonly GoalCriterionReport[];
    readonly steps: readonly { readonly title: string;
      readonly status: 'PENDING' | 'DOING' | 'DONE' }[];
    readonly current_step: string | null;
    readonly progress: string | null;
    readonly questions: readonly string[];
    readonly blocked_reason: string | null;
    readonly adjustment: string | null;
  } | null;
}

const GOAL_STATES: readonly GoalState[] = ['CONTINUE', 'NEEDS_USER', 'BLOCKED', 'COMPLETE'];
const CRITERION_STATUSES: readonly GoalCriterionReport['status'][] = ['MET', 'UNMET', 'PENDING'];
const STEP_STATUSES: readonly { readonly title: string;
  readonly status: 'PENDING' | 'DOING' | 'DONE' }['status'][] = ['PENDING', 'DOING', 'DONE'];

/**
 * 读一次目标轮次输出。
 *
 * 状态只有四个，且**不与完成判定混同**：`COMPLETE` 只表示「模型认为做完了」，
 * 是否真的完成由应用层按成功条件的证据核对（缺证据不完成、需要人工验收则等待）。
 */
export function readGoalEnvelope(content: string): GoalEnvelope {
  const envelope = envelopeOf(content);
  if (envelope === undefined) return { reply: readableReply(content), goal: null };
  const raw = envelope.object.goal;
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { reply: envelope.reply, goal: null };
  }
  const body = raw as JsonObject;
  const stateText = textOf(body.state, 40)?.toUpperCase();
  const state = GOAL_STATES.find((candidate) => candidate === stateText) ?? 'CONTINUE';
  const criteria: { key: string; statement: string; required: boolean }[] = [];
  for (const item of objectList(body.success_criteria, MAX_ITEMS)) {
    const statement = textOf(item.statement);
    if (statement === undefined) continue;
    criteria.push({ key: textOf(item.key, 60) ?? `c${criteria.length + 1}`, statement,
      required: item.required !== false });
  }
  const statuses: GoalCriterionReport[] = [];
  for (const item of objectList(body.criteria_status, MAX_ITEMS)) {
    const key = textOf(item.key, 60);
    const statusText = textOf(item.status, 20)?.toUpperCase();
    const status = CRITERION_STATUSES.find((candidate) => candidate === statusText);
    if (key === undefined || status === undefined) continue;
    statuses.push({ key, statement: textOf(item.statement, 2_000) ?? null, status,
      evidence: textOf(item.evidence, 2_000) ?? null, required: item.required !== false });
  }
  const steps: { title: string; status: 'PENDING' | 'DOING' | 'DONE' }[] = [];
  for (const item of objectList(body.steps, MAX_STEPS)) {
    const title = textOf(item.title);
    if (title === undefined) continue;
    const statusText = textOf(item.status, 20)?.toUpperCase();
    const status = STEP_STATUSES.find((candidate) => candidate === statusText) ?? 'PENDING';
    steps.push({ title, status });
  }
  return { reply: envelope.reply, goal: {
    state, criteria, criteria_status: statuses, steps,
    current_step: textOf(body.current_step, 500) ?? null,
    progress: textOf(body.progress, 2_000) ?? null,
    questions: stringList(body.questions, MAX_ITEMS),
    blocked_reason: textOf(body.blocked_reason, 2_000) ?? null,
    adjustment: textOf(body.adjustment, 2_000) ?? null,
  } };
}

/**
 * 目标结论的持久形状（`assist_messages.goal_outcome`）。
 *
 * 写这一列而不是让推进器重新解析正文，有两个理由：
 *   * 正文里给用户看的是 `reply`；把整段 JSON 当正文显示是已经修过一次的缺陷；
 *   * 结算顺序是「模型正文先落库、推进器随后结算」，中间可能重启。存下归一化后的结论，
 *     推进器读到的永远是模型当时说的那一份，而不是重新解析一段可能已被压缩的正文。
 */
export function goalEnvelopeToJson(envelope: GoalEnvelope): JsonObject {
  const goal = envelope.goal;
  return {
    reply: envelope.reply,
    goal: goal === null ? null : {
      state: goal.state,
      success_criteria: goal.criteria.map((item): JsonObject => ({
        key: item.key, statement: item.statement, required: item.required })),
      criteria_status: goal.criteria_status.map((item): JsonObject => ({
        key: item.key, status: item.status, evidence: item.evidence })),
      steps: goal.steps.map((item): JsonObject => ({ title: item.title, status: item.status })),
      current_step: goal.current_step,
      progress: goal.progress,
      questions: [...goal.questions],
      blocked_reason: goal.blocked_reason,
      adjustment: goal.adjustment,
    },
  };
}

/** 读回持久结论；缺失或形状不可识别时按「没有结构化进展」处理。 */
export function goalEnvelopeFromJson(raw: JsonObject | null): GoalEnvelope {
  if (raw === null) return { reply: '', goal: null };
  return readGoalEnvelope(JSON.stringify(raw));
}
