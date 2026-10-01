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
  | { readonly kind: 'SCHEMA_INVALID'; readonly reason: string; readonly raw: string }
  | { readonly kind: 'MISSING_MATERIAL'; readonly missing: readonly string[] }
  | { readonly kind: 'CANCELLED'; readonly providerRequestId?: string;
      readonly usage?: ModelUsage };

export interface ModelRequest {
  readonly manifest: JsonObject;
  readonly outputSchema: string;
  readonly signal?: AbortSignal | undefined;
  /** Uncommitted Markdown text only; validation and business settlement stay separate. */
  readonly onTextDelta?: ((text: string) => Promise<void>) | undefined;
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
}

export type AssistResult =
  | {
      readonly kind: 'CONTENT';
      readonly content: string;
      readonly providerRequestId: string;
      readonly usage: ModelUsage;
    }
  | { readonly kind: 'CANCELLED'; readonly providerRequestId?: string;
      readonly usage?: ModelUsage };

export interface AssistModelPort {
  readonly identity: ModelIdentity;
  assist(request: AssistRequest): Promise<AssistResult>;
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

function seedOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
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
