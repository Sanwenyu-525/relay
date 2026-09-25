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
  readonly inputTokens: number;
  readonly outputTokens: number;
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
  | { readonly kind: 'CANCELLED' };

export interface ModelRequest {
  readonly manifest: JsonObject;
  readonly outputSchema: string;
  readonly signal?: AbortSignal | undefined;
}

export interface ModelPort {
  generate(request: ModelRequest): Promise<ModelResult>;
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
 */
export class FakeModelPort implements ModelPort {
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
}

function contentResult(request: ModelRequest, content: string): ModelResult {
  return {
    kind: 'CONTENT',
    content,
    providerRequestId: providerRequestIdOf(request),
    usage: usageOf(request.manifest, content),
  };
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
