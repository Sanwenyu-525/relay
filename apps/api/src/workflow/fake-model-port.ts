import { createHash } from 'node:crypto';

import type { JsonObject, JsonValue } from '../infrastructure/json.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import {
  DEFAULT_FAKE_SCENARIO,
  isFakeScenario,
  type FakeScenario,
} from './context-fixture.js';

/**
 * ModelPort 边界（docs/architecture/runtime-context.md 第 1、2 节）。
 *
 * 输入是实际 ContextManifest、输出 schema 名与取消信号；输出只能是结构化内容或 typed failure。
 * 模型输出先变成受约束结果，绝不直接修改 Task/Run 状态；第一实现是确定性、无网络的 FakeModelPort，
 * 真实 SDK 接入属 P12。
 */

export interface ModelUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Provider-reported prompt-cache tokens. null/absent = not reported, not zero. */
  readonly cacheReadTokens?: number | null;
  readonly cacheCreationTokens?: number | null;
}

export interface ModelIdentity {
  readonly provider: string;
  readonly model: string;
  readonly configFingerprint: string;
  readonly budget?: {
    readonly callReservationTokens: number;
    readonly scopeCallLimit: number;
    readonly scopeTokenLimit: number;
  };
}

export type ModelResult =
  | {
      readonly kind: 'CONTENT';
      readonly content: string;
      readonly providerRequestId: string;
      readonly usage: ModelUsage;
    }
  /** 一次完整、可解析的工具请求。断流或半截参数绝不产生这个结果。 */
  | {
      readonly kind: 'TOOL_CALLS';
      readonly calls: readonly ModelToolCall[];
      /**
       * 该轮伴随工具请求一起输出的正文，作为前置说明交给结算方处理。
       * 它不是候选正文：候选只能来自没有工具请求的那一轮。空串表示模型没有说话。
       */
      readonly preamble: string;
      /** Provider 原样返回的续轮字段；不作为正文发布，也不作为业务判断依据。 */
      readonly reasoningContent?: string | undefined;
      readonly providerRequestId: string;
      readonly usage: ModelUsage;
    }
  | { readonly kind: 'SCHEMA_INVALID'; readonly reason: string; readonly raw: string }
  | { readonly kind: 'MISSING_MATERIAL'; readonly missing: readonly string[] }
  | { readonly kind: 'CANCELLED'; readonly providerRequestId?: string;
      readonly usage?: ModelUsage };

/** 工具的对外声明。name 与 parameters 是冻结协议，不是模型可以自选的动作。 */
export interface ModelToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
}

/** 一个已通过 schema 校验的完整工具请求。arguments 始终是对象，不接受字符串原文。 */
export interface ModelToolCall {
  /** Provider 侧标签。只在本次响应内用于配对，不承担跨 Run/轮次唯一性。 */
  readonly providerToolCallId: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

/** FakeModelPort 逐轮发出的单个工具请求。仅测试注入，生产路径不包含它。 */
export interface FakeToolScriptCall {
  readonly name: string;
  readonly arguments: JsonObject;
}

/**
 * 一轮脚本：本次要发出的工具请求数组。
 *
 * Fake 脚本只覆盖「纯工具请求」的形态；边输出正文边调工具由真实端口单测覆盖。
 */
export type FakeToolScriptRound = readonly FakeToolScriptCall[];

/** FakeModelPort 的冻结工具脚本；轮次序号由已结算的历史轮次决定。 */
export type FakeToolScript = readonly FakeToolScriptRound[];

/** 已结算的一轮工具交互，用于把结果回传给模型和从持久化事实重建。 */
export interface ModelToolTurn {
  readonly calls: readonly ModelToolCall[];
  readonly results: readonly ModelToolTurnResult[];
  /** 老账本未保存前置说明时保持缺省，不能补造历史。 */
  readonly preamble?: string | undefined;
  readonly reasoningContent?: string | undefined;
}

export interface ModelToolTurnResult {
  readonly providerToolCallId: string;
  readonly name: string;
  readonly content: string;
  readonly isError: boolean;
}

export interface ModelRequest {
  readonly manifest: JsonObject;
  readonly outputSchema: string;
  readonly signal?: AbortSignal | undefined;
  /** Uncommitted Markdown text only; validation and business settlement stay separate. */
  readonly onTextDelta?: ((text: string) => Promise<void>) | undefined;
  /** 缺省表示本次不允许任何工具请求：既有 DRAFT/Assist/语义检查行为不变。 */
  readonly tools?: readonly ModelToolSpec[] | undefined;
  /** 已经结算的历史轮次，按顺序原样回传；恢复时由持久化的工具调用与结果重建。 */
  readonly toolTurns?: readonly ModelToolTurn[] | undefined;
}

export interface ModelPort {
  readonly identity: ModelIdentity;
  generate(request: ModelRequest): Promise<ModelResult>;
}

/**
 * Assist 对话端口（M04/P12）：与会话内已完成的轮次和显式选中资料一起构成输入。
 * Assist 不写业务状态：端口只返回内容或 typed failure，提案由应用层校验后另行落库。
 */
export interface AssistTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export type AssistIntent = 'DISCUSS' | 'PROPOSE_CANDIDATE' | 'PROPOSE_TASK' | 'IMPACT_CHECK' | 'IMPACT_CANDIDATE';

export interface AssistRequest {
  readonly intent: AssistIntent;
  readonly system: string;
  readonly turns: readonly AssistTurn[];
  /** Structured first-party test input; the real provider consumes the rendered user turn. */
  readonly skill?: { readonly id: string; readonly version: string;
    readonly facts: JsonObject; readonly input?: JsonObject } | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Only ordinary DISCUSS may expose these uncommitted text increments. */
  readonly onTextDelta?: ((text: string) => Promise<void>) | undefined;
  /**
   * 缺省表示本次不允许任何工具请求：既有 A 档 DISCUSS 与提案行为不变。
   * 只有 B 档人设会话会传入只读词表。
   */
  readonly tools?: readonly ModelToolSpec[] | undefined;
  /** 已经结算的历史工具轮次，按顺序原样回传。 */
  readonly toolTurns?: readonly ModelToolTurn[] | undefined;
  /**
   * 学习轮次（0072 / ADR-020 §4）：给出本轮**相关短状态**与获准来源身份，
   * 端口改用结构化信封返回正文与有限类型化候选增量。缺省时既有行为逐字不变。
   */
  readonly learning?: AssistLearningRequest | undefined;
}

/**
 * 学习轮次的输入。
 *
 * `state` 由应用选择与裁剪（模型不能自选知识点），`material` 只保留可核对的来源身份——
 * 正文仍由既有的只读材料读取能力提供，不在这里复制项目内容。
 */
export interface AssistLearningRequest {
  readonly state: JsonObject;
  readonly material: readonly JsonObject[];
}

/** 结构化教学信封的解析结果。`schemaError` 非空表示信封不合法：保留正文，不写增量。 */
export interface LearningEnvelope {
  readonly answer: string;
  readonly increments: readonly JsonObject[];
  readonly schemaError: string | null;
}

const LEARNING_ENVELOPE_KEYS: readonly string[] = ['answer', 'increments'];

/**
 * 解析教学信封：只接受 `{answer, increments}` 两个键。
 *
 * 多一个键就整封拒绝——这是「候选不能携带任意存储路径、项目命令或 SQL」的第一道闸：
 * 任何额外字段都不进入应用层，而不是被静默忽略。
 */
export function parseLearningEnvelope(text: string): LearningEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { answer: text.trim(), increments: [], schemaError: 'LEARNING_ENVELOPE_NOT_JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { answer: text.trim(), increments: [], schemaError: 'LEARNING_ENVELOPE_NOT_OBJECT' };
  }
  const record = parsed as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !LEARNING_ENVELOPE_KEYS.includes(key));
  if (extra.length > 0) {
    return { answer: text.trim(), increments: [],
      schemaError: `LEARNING_ENVELOPE_UNEXPECTED_FIELDS:${extra.sort().join(',')}` };
  }
  if (typeof record.answer !== 'string' || record.answer.trim() === '') {
    return { answer: text.trim(), increments: [], schemaError: 'LEARNING_ENVELOPE_ANSWER_MISSING' };
  }
  if (!Array.isArray(record.increments)) {
    return { answer: record.answer.trim(), increments: [],
      schemaError: 'LEARNING_ENVELOPE_INCREMENTS_MISSING' };
  }
  const increments: JsonObject[] = [];
  for (const entry of record.increments) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { answer: record.answer.trim(), increments: [],
        schemaError: 'LEARNING_ENVELOPE_INCREMENT_NOT_OBJECT' };
    }
    increments.push(entry as JsonObject);
  }
  return { answer: record.answer.trim(), increments, schemaError: null };
}

export type AssistResult =
  | {
      readonly kind: 'CONTENT';
      readonly content: string;
      readonly providerRequestId: string;
      readonly usage: ModelUsage;
      /** 仅学习轮次存在：与本轮正文一起返回的有限候选增量与信封校验结果。 */
      readonly learning?: { readonly increments: readonly JsonObject[];
        readonly schemaError: string | null } | undefined;
    }
  /**
   * 一次完整、可解析的工具请求。断流或半截参数绝不产生这个结果。
   * 边输出正文边调工具的形态由真实端口承载，`preamble` 是那一轮伴随的正文。
   */
  | {
      readonly kind: 'TOOL_CALLS';
      readonly calls: readonly ModelToolCall[];
      readonly preamble: string;
      readonly reasoningContent?: string | undefined;
      readonly providerRequestId: string;
      readonly usage: ModelUsage;
    }
  | { readonly kind: 'CANCELLED'; readonly providerRequestId?: string;
      readonly usage?: ModelUsage };

/**
 * 用户请求解释（工作台 §18.2）：端口只把原请求整理成候选 JSON，
 * 授权来源、准入与验收有效性仍由应用层的确定性规则判定。
 */
export interface ConversationInterpretationRequest {
  readonly system: string;
  readonly userContent: string;
  readonly signal?: AbortSignal | undefined;
}

export interface AssistModelPort {
  readonly identity: ModelIdentity;
  assist(request: AssistRequest): Promise<AssistResult>;
  /** 缺省实现视为「没有请求解释能力」，由应用层给出 typed failure，不静默降级为讨论。 */
  interpret?(request: ConversationInterpretationRequest): Promise<AssistResult>;
}

/** 缺资料时声明缺失的输入名（供 DRAFT 记录证据；P05 不尝试补齐）。 */
export const MISSING_MATERIAL_INPUT = 'material';

/**
 * 确定性 FakeModelPort：无网络、无随机、无时间依赖。
 *
 * 场景由 Manifest payload 的 `fake_scenario` 决定；同输入必得同输出（含 provider_request_id 与用量）。
 * 这样测试可以断言“去重/重放不重跑”，也可以断言各场景的稳定行为。
 *
 * P06 追加：合法候选带一个可识别的引用标记，使 `citation-exists-v1` 能 PASS；
 * `CITATION_MISSING_ONCE` 只在修正轮（manifest.correction.round ≥ 1）补上引用，让修正回路收敛。
 *
 * M04 Assist：按 intent 返回确定性回复或提案 JSON；触发串仅用于测试
 * （真实端口不解释这些标记），生产 Mock 路径不会包含它们。
 */
/**
 * Fake 的教学信封：从用户轮次里的 `LEARNING: op | topic | concept | scenario | detail`
 * 行式标记构造增量，其余文本作为讲解正文。仅测试使用——真实端口不解释这些标记。
 */
export function fakeLearningEnvelope(text: string): LearningEnvelope {
  const increments: JsonObject[] = [];
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('LEARNING:')) {
      if (trimmed !== '') kept.push(trimmed);
      continue;
    }
    const fields = trimmed.slice('LEARNING:'.length).split('|').map((part) => part.trim());
    if (fields.length !== 5 || fields.some((part) => part === '')) continue;
    increments.push({ op: fields[0]!, topic: fields[1]!, concept: fields[2]!,
      scenario: fields[3]!, detail: fields[4]! });
  }
  const answer = kept.length === 0
    ? '（Fake 学习搭档）本轮没有新的问题，先按当前状态继续。'
    : `（Fake 学习搭档）${kept.join(' ').slice(0, 400)}`;
  return { answer, increments, schemaError: null };
}

export class FakeModelPort implements AssistModelPort {
  readonly identity: ModelIdentity = {
    provider: 'fake', model: 'fake-model-v1',
    configFingerprint: createHash('sha256').update('fake-model-v1').digest('hex'),
  };
  constructor(private readonly delayMs = 0) {}

  async generate(request: ModelRequest): Promise<ModelResult> {
    if (this.delayMs > 0 && request.signal?.aborted !== true) {
      if (process.env.NODE_ENV === 'test') process.stdout.write('{"type":"mock_model_started"}\n');
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          request.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, this.delayMs);
        request.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (request.signal?.aborted === true) {
      if (this.delayMs > 0 && process.env.NODE_ENV === 'test') {
        process.stdout.write('{"type":"mock_model_cancelled"}\n');
      }
      return { kind: 'CANCELLED' };
    }

    const scenario = readScenario(request.manifest);
    const title = readNestedString(request.manifest, ['task', 'title']) ?? '候选交付';
    const objective =
      readNestedString(request.manifest, ['contract', 'objective']) ?? '未提供目标';
    const correctionRound = readCorrectionRound(request.manifest);

    // 冻结的工具脚本按轮次确定性推进：请求里已有的历史轮次决定这次发第几轮，
    // 脚本耗尽后回到普通生成。这样测试可以断言「模型真的按工具结果走完了序列」，
    // 而不是拿到一份预制答案。
    const scripted = await scriptedToolRound(request);
    if (scripted !== undefined) return scripted;

    switch (scenario) {
      case 'SCHEMA_INVALID':
        return {
          kind: 'SCHEMA_INVALID',
          reason: '候选正文缺少必需小节：## 结论。',
          raw: renderWithoutConclusion(title, objective),
        };
      case 'MISSING_MATERIAL':
        return { kind: 'MISSING_MATERIAL', missing: [MISSING_MATERIAL_INPUT] };
      case 'NO_CITATION':
        return contentResult(request, renderCandidate(title, objective, { citation: false }));
      case 'SEMANTIC_UNSUPPORTED':
        return contentResult(
          request,
          renderCandidate(title, objective, { marker: 'EVIDENCE_UNSUPPORTED' }),
        );
      case 'SEMANTIC_UNCERTAIN':
        return contentResult(
          request,
          renderCandidate(title, objective, { marker: 'SEMANTIC_UNCERTAIN' }),
        );
      case 'CITATION_MISSING_ONCE':
        return contentResult(
          request,
          renderCandidate(title, objective, { citation: correctionRound >= 1 }),
        );
      case 'CHECKER_ERROR':
      case 'LEGAL':
      default:
        return contentResult(request, renderCandidate(title, objective, { citation: true }));
    }
  }

  /** Assist 确定性回复：DISCUSS 回显最后一条用户消息；提案意图返回可通过
   * 应用层 schema 校验的 JSON。`FAKE_ASSIST_*` 触发串只服务测试断言。 */
  async assist(request: AssistRequest): Promise<AssistResult> {
    const lastUser = [...request.turns].reverse().find((turn) => turn.role === 'user');
    // B 档只读轮次：声明了工具时按冻结脚本逐轮发出请求，脚本耗尽后回到普通回复。
    // 触发串只服务测试断言，真实端口不解释它。
    if (request.tools !== undefined && request.tools.length > 0) {
      const scripted = scriptedAssistToolRound(request);
      if (scripted !== undefined) return scripted;
    }
    // Skill 在原始用户轮次后另附一段权威事实；测试触发串仍取原始用户轮次。
    const trigger = request.skill === undefined ? lastUser?.content ?? '' :
      request.turns.filter((turn) => turn.role === 'user').at(-2)?.content ?? '';
    if (trigger.includes('FAKE_ASSIST_ABORT')) {
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted === true) { resolve(); return; }
        request.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      if (request.signal?.aborted === true) return { kind: 'CANCELLED' };
    }
    if (trigger.includes('FAKE_ASSIST_THROW')) {
      throw new Error('fake assist model failure');
    }
    const seed = seedOf(lastUser?.content ?? request.system);
    const providerRequestId = `fake-assist-${seed}`;
    // Fake 无真实 Provider，不伪造缓存用量：显式 null 让 UI 显示"未采集"而非 0%。
    const usage: ModelUsage = {
      inputTokens: Math.max(1, Math.ceil((request.system.length +
        request.turns.reduce((sum, turn) => sum + turn.content.length, 0)) / 4)),
      outputTokens: 0,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    };
    if (request.learning !== undefined) {
      // 学习轮次：一次调用同时产出正文与有限增量（不额外发起评分调用）。
      // 触发串只服务测试断言，真实端口不解释它。
      const text = lastUser?.content ?? '';
      if (text.includes('FAKE_LEARNING_BAD_ENVELOPE')) {
        const broken = '（Fake 学习搭档）本轮讲解正文；增量信封不合法。';
        return { kind: 'CONTENT', content: broken, providerRequestId,
          usage: { ...usage, outputTokens: Math.max(1, Math.ceil(broken.length / 4)) },
          learning: { increments: [], schemaError: 'LEARNING_ENVELOPE_NOT_JSON' } };
      }
      const envelope = fakeLearningEnvelope(text);
      return { kind: 'CONTENT', content: envelope.answer, providerRequestId,
        usage: { ...usage, outputTokens: Math.max(1, Math.ceil(envelope.answer.length / 4)) },
        learning: { increments: envelope.increments, schemaError: null } };
    }
    if (request.skill !== undefined) {
      const facts = request.skill.facts;
      let proposal: JsonObject;
      if (request.skill.id === 'task-to-execution-contract') {
        const acceptance = facts.acceptance as JsonObject;
        const existing = Array.isArray(acceptance.criteria) ? acceptance.criteria : [];
        proposal = { objective: String(acceptance.objective ?? '明确任务结果'),
           expected_outputs: { kind: 'MARKDOWN_DOCUMENT',
             ...(request.skill.version === '1.1.0'
               ? { description: '交付一份可核对的 Markdown 结果说明。' } : {}) },
          criteria: [...(existing.length === 0
            ? [{ statement: '存在可核对的交付说明。', required: true, method: 'HUMAN' }]
            : existing.map((entry) => { const criterion = entry as JsonObject;
              return { statement: String(criterion.statement),
                required: criterion.required === true, method: String(criterion.method) }; })),
            { statement: '交付内容包含可核对的新增摘要。', required: true,
              method: 'MARKDOWN_STRUCTURE' }],
          suggested_mode: 'ME' };
      } else if (request.skill.id === 'verification-plan') {
        const checks = Array.isArray(facts.registered_checks) ? facts.registered_checks : [];
        proposal = request.skill.version === '1.1.0'
          ? { additional_checks: [{ statement: '交付内容包含可核对的结论摘要。',
            required: true, method: 'MARKDOWN_STRUCTURE' }] }
          : { checks: checks.map((entry) => { const check = entry as JsonObject;
            return { criterion_id: String(check.criterion_id),
              checker_id: String(check.checker_id), required: check.required === true }; }) };
      } else if (request.skill.id === 'goal-to-project-blueprint') {
        const view = facts.view_configuration as JsonObject;
        const state = facts.state as JsonObject;
        proposal = { intent: String(request.skill.input?.desired_outcome ??
            '将当前项目目标拆分为可审查的下一步'),
          goal_id: request.skill.input?.goal_id ?? null,
          phase_key: String(state.phase_key),
          tasks: [{ local_key: 'next', title: '整理项目下一步',
            objective: '形成可供人工审查的项目下一步清单' }],
          next_action: { kind: 'NEW_TASK', local_key: 'next' },
          view_kind: String(view.kind) };
      } else {
        const project = facts.project as JsonObject;
        proposal = { highlights: [{ statement: '当前项目状态已读取。',
          ref_kind: 'PROJECT', ref_id: String(project.id) }], next_steps: [] };
      }
      const raw = trigger.includes('FAKE_ASSIST_BAD_JSON') ? '{bad' :
        JSON.stringify({ summary: '（Fake Assist）已依据当前事实生成建议。', proposal });
      return { kind: 'CONTENT', content: raw, providerRequestId,
        usage: { ...usage, outputTokens: Math.max(1, Math.ceil(raw.length / 4)) } };
    }
    if (request.intent === 'DISCUSS') {
      const reply = `（Fake Assist）已收到：${(lastUser?.content ?? '').slice(0, 200)}`;
      if (request.skill === undefined) await request.onTextDelta?.(reply);
      return { kind: 'CONTENT', content: reply, providerRequestId,
        usage: { ...usage, outputTokens: Math.max(1, Math.ceil(reply.length / 4)) } };
    }
    if (request.intent === 'IMPACT_CHECK') {
      let firstTarget: string | null = null;
      try {
        const input = JSON.parse(lastUser?.content ?? '') as { direct_targets?: { version_id?: string }[] };
        firstTarget = input.direct_targets?.[0]?.version_id ?? null;
      } catch { /* invalid input is rejected by the caller's output validation */ }
      const raw = JSON.stringify({ possibly_related: firstTarget === null ? [] : [{
        target_version_id: firstTarget, reason: 'Fake 模型建议人工核对该直接引用的语义影响。' }] });
      return { kind: 'CONTENT', content: raw, providerRequestId,
        usage: { ...usage, outputTokens: Math.max(1, Math.ceil(raw.length / 4)) } };
    }
    if (request.intent === 'IMPACT_CANDIDATE') {
      let targetText = '';
      try { targetText = (JSON.parse(lastUser?.content ?? '') as { target_text?: string }).target_text ?? ''; }
      catch { /* invalid input remains an invalid candidate */ }
      const raw = JSON.stringify({ markdown: `${targetText}\n\n> Fake 候选：请核对新来源后决定是否应用。\n` });
      return { kind: 'CONTENT', content: raw, providerRequestId,
        usage: { ...usage, outputTokens: Math.max(1, Math.ceil(raw.length / 4)) } };
    }
    const body = request.intent === 'PROPOSE_CANDIDATE'
      ? { summary: `（Fake Assist）已生成候选 Markdown（${seed.slice(0, 8)}）。`,
          proposal: { title: `候选 ${seed.slice(0, 8)}`,
            markdown: `# 候选 ${seed.slice(0, 8)}\n\n由 Fake Assist 确定性生成。\n` } }
      : { summary: `（Fake Assist）已生成任务定义提案（${seed.slice(0, 8)}）。`,
          proposal: { title: `新任务 ${seed.slice(0, 8)}`,
            objective: `按会话讨论推进：${(lastUser?.content ?? '').slice(0, 120)}`,
            criteria: [{ statement: '存在可核对的交付说明。', required: true, method: 'HUMAN' }],
            expected_outputs: { kind: 'MARKDOWN_DOCUMENT' } } };
    const raw = trigger.includes('FAKE_ASSIST_BAD_JSON')
      ? '{"summary":"broken" "proposal":'
      : JSON.stringify(body);
    return { kind: 'CONTENT', content: raw, providerRequestId,
      usage: { ...usage, outputTokens: Math.max(1, Math.ceil(raw.length / 4)) } };
  }

  /** 确定性请求解释：只回候选 JSON。触发串 `FAKE_INTERPRET_DISCUSS` /
   * `FAKE_INTERPRET_CLARIFY` / `FAKE_INTERPRET_BAD_JSON` 只服务测试断言。 */
  async interpret(request: ConversationInterpretationRequest): Promise<AssistResult> {
    const content = request.userContent;
    const providerRequestId = `fake-interpret-${seedOf(content).slice(0, 16)}`;
    const usage: ModelUsage = { inputTokens: Math.max(1,
      Math.ceil((request.system.length + content.length) / 4)), outputTokens: 0,
    cacheReadTokens: null, cacheCreationTokens: null };
    if (request.signal?.aborted === true) return { kind: 'CANCELLED' };
    let body: JsonObject;
    if (content.includes('FAKE_INTERPRET_DISCUSS')) {
      body = { decision: 'DISCUSS' };
    } else if (content.includes('FAKE_INTERPRET_CLARIFY')) {
      body = { decision: 'CLARIFY', questions: ['这次要改的是哪个文件或哪段功能？'] };
    } else {
      body = { decision: 'PREPARE', task: { title: content.slice(0, 60),
        objective: content.slice(0, 400),
        criteria: [{ statement: '存在可核对的交付说明。', required: true, method: 'HUMAN' }],
        expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
        file_changes: [] } };
    }
    const raw = content.includes('FAKE_INTERPRET_BAD_JSON') ? '{"decision":' : JSON.stringify(body);
    return { kind: 'CONTENT', content: raw, providerRequestId,
      usage: { ...usage, outputTokens: Math.max(1, Math.ceil(raw.length / 4)) } };
  }
}

async function contentResult(request: ModelRequest, content: string): Promise<ModelResult> {
  await request.onTextDelta?.(content);
  return {
    kind: 'CONTENT',
    content,
    providerRequestId: providerRequestIdOf(request),
    usage: usageOf(request.manifest, content),
  };
}

interface ScriptedToolRound {
  readonly name: string;
  readonly arguments: JsonObject;
}

/**
 * Manifest 上的 `tool_script` 是测试专用的冻结脚本：`[{ name, arguments }, ...]`，
 * 每个元素是一轮里要发出的一个工具请求。返回本轮应发出的请求；脚本已耗尽返回 undefined。
 * 真实端口不解释这个字段，生产 Mock 路径不会包含它。
 */
async function scriptedToolRound(request: ModelRequest): Promise<ModelResult | undefined> {
  const script = readNestedValue(request.manifest, ['tool_script']);
  if (!Array.isArray(script)) return undefined;
  const consumed = request.toolTurns?.length ?? 0;
  const round = script[consumed];
  if (!Array.isArray(round) || round.length === 0) return undefined;
  const calls: ModelToolCall[] = [];
  for (const [ordinal, item] of round.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
    const entry = item as JsonObject;
    if (typeof entry.name !== 'string' || typeof entry.arguments !== 'object' ||
        entry.arguments === null || Array.isArray(entry.arguments)) return undefined;
    calls.push({ providerToolCallId: `fake-tool-${consumed}-${ordinal}`,
      name: entry.name, arguments: entry.arguments as JsonObject });
  }
  // Fake 脚本不模拟边说话边调工具；真实形态由 OpenAiCompatibleModelPort 的单测覆盖。
  return { kind: 'TOOL_CALLS', calls, preamble: '',
    providerRequestId: `fake-tools-${consumed}`,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null } };
}

function seedOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Assist 侧的冻结工具脚本：从首条用户消息里的 `FAKE_ASSIST_TOOLS <json>` 读出
 * `[[{name,arguments}], ...]`，按已结算的历史轮次推进。
 *
 * 与 generate 侧的 manifest 脚本同形，刻意放在消息里而不是给端口另加一个参数：
 * Assist 端口的请求形状由应用层冻结，测试注入不改变它。脚本里的工具名必须在
 * 本次声明的词表内——不声明的工具不会被 Fake 发出来冒充模型越权。
 */
function scriptedAssistToolRound(request: AssistRequest): AssistResult | undefined {
  const lastUser = [...request.turns].reverse().find((turn) => turn.role === 'user');
  const trigger = lastUser?.content ?? '';
  const marker = 'FAKE_ASSIST_TOOLS ';
  const start = trigger.indexOf(marker);
  if (start < 0) return undefined;
  const raw = (trigger.slice(start + marker.length).split('\n')[0] ?? '').trim();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!Array.isArray(parsed)) return undefined;
  const consumed = request.toolTurns?.length ?? 0;
  const round = parsed[consumed];
  if (!Array.isArray(round) || round.length === 0) return undefined;
  const declared = new Map((request.tools ?? []).map((spec) => [spec.name, spec]));
  const calls: ModelToolCall[] = [];
  for (const [ordinal, item] of round.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
    const entry = item as JsonObject;
    if (typeof entry.name !== 'string' || !declared.has(entry.name)) return undefined;
    const args = entry.arguments;
    calls.push({ providerToolCallId: `fake-assist-tool-${consumed}-${ordinal}`,
      name: entry.name,
      arguments: typeof args === 'object' && args !== null && !Array.isArray(args)
        ? args as JsonObject : {} });
  }
  return { kind: 'TOOL_CALLS', calls, preamble: '',
    providerRequestId: `fake-assist-tools-${consumed}`,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null } };
}

function readScenario(manifest: JsonObject): FakeScenario {
  const value = manifest.fake_scenario;

  return typeof value === 'string' && isFakeScenario(value) ? value : DEFAULT_FAKE_SCENARIO;
}

/** 修正轮次来自 Manifest 的 `correction.round`；缺省与 round 0 等价。 */
function readCorrectionRound(manifest: JsonObject): number {
  const value = readNestedValue(manifest, ['correction', 'round']);

  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

interface RenderOptions {
  /** 是否写入引用标记；缺省写入。`citation-exists-v1` 只证明“文中出现了可识别的引用标识”。 */
  readonly citation?: boolean;
  /** 语义检查器的确定性场景标记（进入正文，使语义判定可复现）。 */
  readonly marker?: string;
}

/**
 * 合法候选：含一级标题与全部必需二级节，且每节非空。
 * 引用标记形如 `参考资料：[Relay 设计系统](https://example.invalid/relay)`，域名不可解析，不声称论断被支持。
 */
function renderCandidate(title: string, objective: string, options: RenderOptions = {}): string {
  const citation = options.citation === false ? [] : CITATION_LINE;
  const marker = options.marker === undefined ? [] : ['', `语义标记：${options.marker}`];

  return [
    `# ${title}`,
    '',
    '## 摘要',
    '',
    `本候选依据目标“${objective}”生成，覆盖固定必需结构。`,
    ...marker,
    '',
    '## 结论',
    '',
    `结论：已按目标“${objective}”给出候选交付，等待验证。`,
    ...citation,
    '',
  ].join('\n');
}

const CITATION_LINE: readonly string[] = [
  '',
  '参考资料：[Relay 设计系统](https://example.invalid/relay)',
];

/** 结构错误候选：缺少 `## 结论` 必需节。 */
function renderWithoutConclusion(title: string, objective: string): string {
  return [
    `# ${title}`,
    '',
    '## 摘要',
    '',
    `本候选依据目标“${objective}”生成，但缺少必需小节。`,
    '',
  ].join('\n');
}

/** provider 请求身份由输入摘要确定性派生，便于测试断言“同输入同输出”。 */
function providerRequestIdOf(request: ModelRequest): string {
  const digest = createHash('sha256')
    .update(
      canonicalizeJson({
        manifest: request.manifest,
        output_schema: request.outputSchema,
      }),
      'utf8',
    )
    .digest('hex');

  return `fake-${digest.slice(0, 32)}`;
}

/** 用量按规范编码长度估算，保持确定性；P05 不承诺真实计费口径。 */
function usageOf(manifest: JsonObject, content: string): ModelUsage {
  const inputLength = canonicalizeJson(manifest).length;
  const outputLength = content.length;

  return {
    inputTokens: Math.max(1, Math.ceil(inputLength / 4)),
    outputTokens: Math.max(1, Math.ceil(outputLength / 4)),
    cacheReadTokens: null,
    cacheCreationTokens: null,
  };
}

function readNestedString(manifest: JsonObject, path: readonly string[]): string | undefined {
  const value = readNestedValue(manifest, path);

  return typeof value === 'string' ? value : undefined;
}

function readNestedValue(manifest: JsonObject, path: readonly string[]): JsonValue | undefined {
  let current: JsonValue | undefined = manifest;

  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }

    current = (current as JsonObject)[key];
  }

  return current;
}
