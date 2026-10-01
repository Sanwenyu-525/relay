import { createHash } from 'node:crypto';
import type { JsonObject } from '../infrastructure/json.js';
import { readModelPortConfig } from './model-port-config.js';
import { classifyProviderError } from './model-error-classification.js';
import type { ModelIdentity, ModelUsage } from './fake-model-port.js';
import type { CheckResultValue } from '../infrastructure/database-schema.js';
import type { CheckPlanEntry } from './check-plan.js';
import { validateCandidate, REQUIRED_SECTIONS } from './markdown-deliverable.js';

/**
 * 内置 Checker registry 与实现（docs/architecture/runtime-context.md 第 4 节）。
 *
 * 边界：
 *   * registry 只注册内置 checker，不下载插件、不执行用户表达式；
 *   * 每个 checker 声明检测范围；存在性检查不等于论断被支持；
 *   * FakeSemanticChecker 是 P06 替身，真实语义接入属 P12，不声称验证绝对正确；
 *   * Worker 不能通过改计划绕过 registry——计划在 session 创建时已冻结。
 */

export interface CheckInput {
  readonly entry: CheckPlanEntry;
  readonly content: string;
  readonly artifactVersionId: string;
  readonly contentHashHex: string;
  /** 测试注入：驱动 FakeSemanticChecker / 检查器故障场景。 */
  readonly fakeScenario?: string | undefined;
  /** 取消语义：模型型检查器把信号传给 Provider 调用（对齐 DRAFT）。 */
  readonly signal?: AbortSignal | undefined;
}

export interface CheckOutcome {
  readonly result: CheckResultValue;
  readonly evidence: JsonObject;
}

export interface Checker {
  readonly id: string;
  readonly version: string;
  readonly modelIdentity?: ModelIdentity;
  check(input: CheckInput): CheckOutcome | Promise<CheckOutcome>;
}

/** 确定性 Markdown 结构：复用候选校验（标题、必需节、非空、最小长度）。 */
class MarkdownStructureChecker implements Checker {
  readonly id = 'markdown-structure-v1';
  readonly version = '1';

  check(input: CheckInput): CheckOutcome {
    const validation = validateCandidate(input.content);

    if (validation.ok) {
      return {
        result: 'PASS',
        evidence: {
          checker: this.id,
          checker_version: this.version,
          required_sections: [...REQUIRED_SECTIONS],
          artifact_version_id: input.artifactVersionId,
          content_sha256: input.contentHashHex,
        },
      };
    }

    return {
      result: 'FAIL',
      evidence: {
        checker: this.id,
        checker_version: this.version,
        issues: validation.issues.map((issue) => ({
          code: issue.code,
          detail: issue.detail,
        })),
        artifact_version_id: input.artifactVersionId,
        content_sha256: input.contentHashHex,
      },
    };
  }
}

/**
 * 引用标识存在性：只证明“文中出现了可识别的引用/链接标识”。
 * 不证明来源正文支持论断（contracts/03 第 7 节：元数据正确、引用存在、论断支持是不同 criterion）。
 */
class CitationExistsChecker implements Checker {
  readonly id = 'citation-exists-v1';
  readonly version = '1';

  check(input: CheckInput): CheckOutcome {
    const citations = collectCitationMarkers(input.content);

    if (citations.length === 0) {
      return {
        result: 'FAIL',
        evidence: {
          checker: this.id,
          checker_version: this.version,
          reason: 'NO_CITATION_MARKERS',
          artifact_version_id: input.artifactVersionId,
          content_sha256: input.contentHashHex,
        },
      };
    }

    return {
      result: 'PASS',
      evidence: {
        checker: this.id,
        checker_version: this.version,
        // 只记录命中数量与样例，不把“存在”写成“支持论断”。
        marker_count: citations.length,
        sample: citations.slice(0, 3),
        scope: 'EXISTENCE_ONLY',
        artifact_version_id: input.artifactVersionId,
        content_sha256: input.contentHashHex,
      },
    };
  }
}

/**
 * FakeSemanticChecker：确定性语义替身，真实模型语义接入属 P12。
 *
 * 场景标记（进入正文或 fakeScenario）：
 *   * SEMANTIC_FAIL / EVIDENCE_UNSUPPORTED → FAIL（论断无支持）
 *   * SEMANTIC_UNCERTAIN → UNCERTAIN
 *   * 其余 → PASS（带 fake 边界说明，不声称事实绝对正确）
 */
class FakeSemanticChecker implements Checker {
  readonly id = 'fake-semantic-v1';
  readonly version = '1';
  readonly modelIdentity: ModelIdentity = {
    provider: 'fake', model: 'fake-semantic-v1',
    configFingerprint: createHash('sha256').update('fake-semantic-v1').digest('hex'),
  };

  check(input: CheckInput): CheckOutcome {
    const scenario = `${input.fakeScenario ?? ''} ${input.content}`;
    const base = {
      checker: this.id,
      checker_version: this.version,
      fake: true,
      note: 'P06 FakeSemanticChecker：不保证事实绝对正确；真实语义接入属 P12。',
      artifact_version_id: input.artifactVersionId,
      content_sha256: input.contentHashHex,
    };

    if (
      scenario.includes('EVIDENCE_UNSUPPORTED') ||
      scenario.includes('SEMANTIC_FAIL') ||
      scenario.includes('CLAIM_UNSUPPORTED')
    ) {
      return {
        result: 'FAIL',
        evidence: { ...base, reason: 'CLAIM_NOT_SUPPORTED' },
      };
    }

    if (scenario.includes('SEMANTIC_UNCERTAIN')) {
      return {
        result: 'UNCERTAIN',
        evidence: { ...base, reason: 'INSUFFICIENT_EVIDENCE' },
      };
    }

    return { result: 'PASS', evidence: base };
  }
}

/** 人工证据检查：P06 自动路径不替 Worker 自我验收，直接 NOT_RUN 等待 HUMAN。 */
class HumanEvidenceChecker implements Checker {
  readonly id = 'human-evidence-v1';
  readonly version = '1';

  check(input: CheckInput): CheckOutcome {
    return {
      result: 'NOT_RUN',
      evidence: {
        checker: this.id,
        checker_version: this.version,
        reason: 'AWAITING_HUMAN_EVIDENCE',
        artifact_version_id: input.artifactVersionId,
        content_sha256: input.contentHashHex,
      },
    };
  }
}

/** 检查器故障替身：驱动 C06 的 ERROR 路径（超时/不可用 ≠ FAIL，更 ≠ PASS）。 */
class ErrorChecker implements Checker {
  readonly id = 'markdown-structure-v1';
  readonly version = '1';

  check(input: CheckInput): CheckOutcome {
    return {
      result: 'ERROR',
      evidence: {
        checker: this.id,
        checker_version: this.version,
        reason: 'CHECKER_TIMEOUT',
        artifact_version_id: input.artifactVersionId,
        content_sha256: input.contentHashHex,
      },
    };
  }
}

/**
 * 真实语义检查器（P12/M04）：把规则 statement 与候选正文交给配置的模型端口判定。
 * 判定映射：模型输出 PASS/FAIL/UNCERTAIN；解析失败或调用异常按 ERROR 处理
 * （检查器故障 ≠ FAIL，更 ≠ PASS；C06 的有界重试覆盖它）。
 */
export class ModelSemanticChecker implements Checker {
  readonly id = 'semantic-model-v1';
  readonly version = '1';

  constructor(private readonly evaluate: SemanticEvaluate,
    readonly modelIdentity: ModelIdentity = {
      provider: 'test-double', model: 'semantic-model-v1',
      configFingerprint: createHash('sha256').update('semantic-model-v1-test').digest('hex'),
    }) {}

  async check(input: CheckInput): Promise<CheckOutcome> {
    const base = {
      checker: this.id,
      checker_version: this.version,
      fake: false,
      artifact_version_id: input.artifactVersionId,
      content_sha256: input.contentHashHex,
    };
    try {
      const verdict = await this.evaluate({ statement: input.entry.statement, content: input.content },
        input.signal);
      return {
        result: verdict.verdict,
        evidence: { ...base, reason: verdict.reason,
          usage: { input_tokens: verdict.usage.inputTokens,
            output_tokens: verdict.usage.outputTokens,
            cache_read_tokens: verdict.usage.cacheReadTokens ?? null,
            cache_creation_tokens: verdict.usage.cacheCreationTokens ?? null },
          provider_request_id: verdict.providerRequestId },
      };
    } catch (error) {
      const response = typeof error === 'object' && error !== null
        ? error as { usage?: ModelUsage; providerRequestId?: string }
        : {};
      return {
        result: 'ERROR',
        evidence: { ...base, reason: 'SEMANTIC_EVALUATION_FAILED',
          error_kind: (input.signal?.aborted === true ? undefined : classifyProviderError(error))
            ?? (error instanceof Error ? error.name : 'UNKNOWN'),
          ...(response.usage === undefined ? {} : { usage: {
            input_tokens: response.usage.inputTokens,
            output_tokens: response.usage.outputTokens,
            cache_read_tokens: response.usage.cacheReadTokens ?? null,
            cache_creation_tokens: response.usage.cacheCreationTokens ?? null } }),
          ...(response.providerRequestId === undefined ? {}
            : { provider_request_id: response.providerRequestId }) },
      };
    }
  }
}

export interface SemanticVerdict {
  readonly verdict: 'PASS' | 'FAIL' | 'UNCERTAIN';
  readonly reason: string;
  readonly providerRequestId: string;
  readonly usage: ModelUsage;
}

export type SemanticEvaluate = (input: { readonly statement: string;
  readonly content: string }, signal?: AbortSignal) => Promise<SemanticVerdict>;

const REGISTRY = new Map<string, Checker>();

function register(checker: Checker): void {
  REGISTRY.set(`${checker.id}@${checker.version}`, checker);
}

register(new MarkdownStructureChecker());
register(new CitationExistsChecker());
register(new FakeSemanticChecker());
register(new HumanEvidenceChecker());

// The real semantic checker registers only when the model port is configured;
// otherwise HARD SEMANTIC rules stay blocked at delegate time (no silent downgrade).
const semanticModelConfig = readModelPortConfig(process.env);
if (semanticModelConfig !== undefined) {
  const { OpenAiCompatibleModelPort } = await import('./openai-compatible-model-port.js');
  const modelPort = new OpenAiCompatibleModelPort(semanticModelConfig);
  register(new ModelSemanticChecker(async ({ statement, content }, signal) =>
    modelPort.evaluate({ statement, content }, signal), modelPort.identity));
}
// ErrorChecker 不进入 registry：它只由 resolveCheckerForScenario 按故障场景替换出来，
// 若注册就会覆盖同 id/version 的真实检查器，把确定性检查永久变成 ERROR。

export function resolveChecker(checkerId: string, checkerVersion: string): Checker | undefined {
  return REGISTRY.get(`${checkerId}@${checkerVersion}`);
}

/** 是否存在对应版本的注册 checker；缺失时不 ready/delegate，不静默降级。 */
export function hasChecker(checkerId: string, checkerVersion: string): boolean {
  return REGISTRY.has(`${checkerId}@${checkerVersion}`);
}

/** 仅测试/故障注入：按场景把结构检查替换为 ERROR 检查器。 */
export function resolveCheckerForScenario(
  entry: CheckPlanEntry,
  fakeScenario: string | undefined,
): Checker {
  if (
    fakeScenario === 'CHECKER_ERROR' &&
    (entry.checkerId === 'markdown-structure-v1' || entry.checkerId === 'citation-exists-v1')
  ) {
    return new ErrorChecker();
  }

  const checker = resolveChecker(entry.checkerId, entry.checkerVersion);

  if (checker === undefined) {
    throw new Error(`checker not registered: ${entry.checkerId}@${entry.checkerVersion}`);
  }

  return checker;
}

function collectCitationMarkers(content: string): readonly string[] {
  const markers: string[] = [];
  const patterns: readonly RegExp[] = [
    /https?:\/\/\S+/gu,
    /\b10\.\d{4,9}\/\S+/gu,
    /\[[^\]\n]{1,80}\]/gu,
    /doi:\s*\S+/giu,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const value = match[0].trim();

      if (value !== '') {
        markers.push(value);
      }
    }
  }

  return [...new Set(markers)];
}
