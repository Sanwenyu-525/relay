import { createHash, randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import { ModelCallRepository } from '../model/model-call-repository.js';
import type { ModelUsage } from '../workflow/fake-model-port.js';
import { classifyProviderError } from '../workflow/model-error-classification.js';
import {
  COMPOSER_MAX_DRAFT_CODE_POINTS,
  ComposerOutlineRejected,
  ComposerPolishRejected,
  buildOutline,
  codePointLength,
  outlineEligible,
  parsePolishedText,
  type ComposerDraftOperation,
} from '../workflow/composer-draft.js';
import type { ComposerDraftPort, ComposerDraftResult } from '../workflow/fake-model-port.js';
import { OpenAiCompatibleModelPort } from '../workflow/openai-compatible-model-port.js';
import { readModelPortConfig, type ModelPortConfig } from '../workflow/model-port-config.js';
import { DomainError } from './domain-error.js';
import { readAdmission, requireNormalAdmission } from './maintenance-admission.js';
import { createRepositories } from './unit-of-work.js';

/**
 * 发送前草稿辅助用例（工作台 §30、HTTP §10.84）。
 *
 * 这个用例做四件事，且**只**做这四件事：
 *   1. 边界校验（长度、是否适用分点），不适用就直接返回，不发起调用；
 *   2. 复用既有维护准入闸门，与其它新工作同一把锁；
 *   3. 在既有 `model_calls` 账本里为这次真实调用写一行（kind=COMPOSER，无 Run/会话作用域），
 *      并用 Provider 返回的 usage 结算——**不**新建第二套账本、**不**建占位 Run/Task；
 *   4. 用 `workflow/composer-draft.ts` 的纯函数校验协议并按原文切片。
 *
 * 它**不**做这些事：不创建消息、Task、Run、提案或业务批准；不读会话历史、项目资料或目录
 * 文件；不执行草稿里的任何内容（草稿只是待处理文本）；不决定权限（Bearer 守卫在路由层）。
 */

/** 服务端保留的最低保护：同一实例内的最小调用间隔与并发上限。 */
const COMPOSER_MIN_INTERVAL_MS = 400;
const COMPOSER_MAX_CONCURRENT_CALLS = 4;

export type ComposerDraftErrorCode =
  | 'MODEL_PORT_NOT_CONFIGURED'
  | 'MODEL_CONFIG_INVALID'
  | 'COMPOSER_DRAFT_TOO_SHORT'
  | 'COMPOSER_DRAFT_TOO_LONG'
  | 'COMPOSER_RATE_LIMITED'
  | 'COMPOSER_RESPONSE_INVALID'
  | 'COMPOSER_CANCELLED';

/** 草稿辅助的错误都是可核对的领域错误：路由层按既有 Problem Details 映射，不新增错误词表。 */
export function composerDraftError(code: ComposerDraftErrorCode, detail: string): DomainError {
  switch (code) {
    case 'MODEL_PORT_NOT_CONFIGURED':
      return new DomainError({ code, status: 409,
        type: '/problems/model-port-not-configured', title: '模型端口未配置',
        detail, retryable: false, retryAction: 'NONE' });
    case 'MODEL_CONFIG_INVALID':
      return new DomainError({ code, status: 409,
        type: '/problems/model-config-invalid', title: '模型配置残缺',
        detail, retryable: false, retryAction: 'NONE' });
    case 'COMPOSER_DRAFT_TOO_SHORT':
    case 'COMPOSER_DRAFT_TOO_LONG':
      return new DomainError({ code, status: 400,
        type: '/problems/composer-draft-size', title: '草稿长度不适用',
        detail, retryable: false, retryAction: 'NONE',
        fieldErrors: [{ field: 'text', message: detail }] });
    case 'COMPOSER_RATE_LIMITED':
      return new DomainError({ code, status: 429,
        type: '/problems/composer-rate-limited', title: '草稿辅助请求过于频繁',
        detail, retryable: true, retryAction: 'NONE' });
    case 'COMPOSER_RESPONSE_INVALID':
      return new DomainError({ code, status: 502,
        type: '/problems/composer-response-invalid', title: '草稿辅助返回不可用',
        detail, retryable: true, retryAction: 'NONE' });
    case 'COMPOSER_CANCELLED':
      return new DomainError({ code, status: 499,
        type: '/problems/composer-cancelled', title: '草稿辅助已取消',
        detail, retryable: false, retryAction: 'NONE' });
  }
}

export type ComposerDraftOutcome =
  | { readonly status: 'OUTLINE'; readonly itemCount: number; readonly text: string }
  | { readonly status: 'POLISH'; readonly text: string }
  /** 分点边界为空或草稿不适用：如实报告「没有建议」，不是失败，也不产生文本。 */
  | { readonly status: 'NO_SUGGESTION' };

/**
 * 实例内的调用闸门：最小间隔 + 并发上限。
 *
 * 不用通用队列、不引新依赖、不落库：草稿辅助是发送前的辅助调用，丢了就丢了，
 * 正确性由来源校验保证，闸门只负责不让它变成放大器。与 `VerifyGate` 同一形态。
 */
export class ComposerDraftGate {
  #lastStartedAt = 0;
  #inFlight = 0;
  constructor(private readonly minIntervalMs = COMPOSER_MIN_INTERVAL_MS,
    private readonly maxConcurrent = COMPOSER_MAX_CONCURRENT_CALLS,
    private readonly clock: () => number = () => Date.now()) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#inFlight >= this.maxConcurrent) {
      throw composerDraftError('COMPOSER_RATE_LIMITED', '草稿辅助同时请求过多，请稍后重试。');
    }
    const now = this.clock();
    if (now - this.#lastStartedAt < this.minIntervalMs) {
      throw composerDraftError('COMPOSER_RATE_LIMITED', '草稿辅助请求过于频繁，请稍后重试。');
    }
    this.#lastStartedAt = now;
    this.#inFlight += 1;
    try { return await work(); }
    finally { this.#inFlight -= 1; }
  }
}

export interface ComposerDraftAssistInput {
  readonly db: DbExecutor;
  readonly workspaceId: string;
  readonly env: NodeJS.ProcessEnv;
  readonly operation: ComposerDraftOperation;
  readonly text: string;
  readonly signal?: AbortSignal | undefined;
  /** 受控端口（协议与记账测试）。缺省按环境变量构造真实端口；未配置时如实报不可用。 */
  readonly port?: ComposerDraftPort | undefined;
  readonly gate?: ComposerDraftGate | undefined;
}

export async function runComposerDraftAssist(
  input: ComposerDraftAssistInput,
): Promise<ComposerDraftOutcome> {
  const points = codePointLength(input.text);
  if (input.text.trim() === '' || points < 2) {
    throw composerDraftError('COMPOSER_DRAFT_TOO_SHORT', '草稿过短，暂不整理。');
  }
  if (points > COMPOSER_MAX_DRAFT_CODE_POINTS) {
    throw composerDraftError('COMPOSER_DRAFT_TOO_LONG',
      `草稿超过 ${COMPOSER_MAX_DRAFT_CODE_POINTS} 个字符，暂不整理；原草稿保持不变。`);
  }
  // 已分行、斜杠命令与短输入不适用自动分点：如实报告没有建议，也不发起调用。
  if (input.operation === 'OUTLINE' && !outlineEligible(input.text)) {
    return { status: 'NO_SUGGESTION' };
  }

  // 端口解析在开事务之前：配置残缺是配置问题，不该留下一行「已开始」的调用证据。
  const port = input.port ?? resolveComposerPort(input.env);
  const gate = input.gate ?? defaultGate;
  return gate.run(() => invoke(input, port));
}

const defaultGate = new ComposerDraftGate();

async function invoke(input: ComposerDraftAssistInput,
  port: ComposerDraftPort): Promise<ComposerDraftOutcome> {
  const identity = port.identity;
  const inputHash = createHash('sha256')
    .update(`${input.operation}\n${input.text}`, 'utf8').digest('hex');
  const calls = new ModelCallRepository(input.db);
  const callId = randomUUID();
  // 准入与 STARTED 行同一短事务提交，之后才发网络请求：崩溃留下的 STARTED 表示
  // 「结果未知、可能已计费」，不会被读成零用量。
  await input.db.transaction().execute(async (trx) => {
    requireNormalAdmission(await readAdmission(createRepositories(trx), 'share'));
    await new ModelCallRepository(trx).beginComposerInTransaction(callId,
      { workspaceId: input.workspaceId, inputHash }, identity);
  });

  let response: ComposerDraftResult;
  try {
    response = await port.draftAssist({ operation: input.operation, text: input.text,
      signal: input.signal });
  } catch (error) {
    await calls.settle(callId, failureSettlement(error, input.signal));
    throw error;
  }
  if (response.kind === 'CANCELLED') {
    await calls.settle(callId, { status: 'CANCELLED',
      providerRequestId: response.providerRequestId ?? null,
      ...(response.usage === undefined ? {} : { usage: response.usage }) });
    throw composerDraftError('COMPOSER_CANCELLED', '草稿辅助请求已取消，草稿保持不变。');
  }
  // Provider 已经返回：这一行按 COMPLETED 结算（可能计费）。协议是否成立是**产品**结论，
  // 不是 Provider 失败——因此畸形协议仍然记 COMPLETED，然后如实报「返回不可用」。
  await calls.settle(callId, { status: 'COMPLETED',
    providerRequestId: response.providerRequestId, usage: response.usage });

  if (input.operation === 'OUTLINE') {
    try {
      const outline = buildOutline(input.text, response.content);
      return outline === null ? { status: 'NO_SUGGESTION' }
        : { status: 'OUTLINE', itemCount: outline.itemCount, text: outline.text };
    } catch (error) {
      if (error instanceof ComposerOutlineRejected) {
        throw composerDraftError('COMPOSER_RESPONSE_INVALID',
          `模型返回的分点边界不可用（${error.code}），原草稿保持不变。`);
      }
      throw error;
    }
  }
  try {
    return { status: 'POLISH', text: parsePolishedText(response.content) };
  } catch (error) {
    if (error instanceof ComposerPolishRejected) {
      throw composerDraftError('COMPOSER_RESPONSE_INVALID',
        `模型返回的润色结果不可用（${error.code}），原草稿保持不变。`);
    }
    throw error;
  }
}

/** Provider 传输层失败记统一分类；取消记 CANCELLED，不冒充零用量。 */
function failureSettlement(error: unknown, signal: AbortSignal | undefined) {
  const evidence = typeof error === 'object' && error !== null
    ? error as { providerRequestId?: unknown; usage?: unknown } : {};
  const usage = evidence.usage;
  const knownUsage = typeof usage === 'object' && usage !== null &&
    'inputTokens' in usage && 'outputTokens' in usage
    ? { inputTokens: (usage as ModelUsage).inputTokens,
      outputTokens: (usage as ModelUsage).outputTokens,
      cacheReadTokens: (usage as ModelUsage).cacheReadTokens ?? null,
      cacheCreationTokens: (usage as ModelUsage).cacheCreationTokens ?? null }
    : undefined;
  const aborted = signal?.aborted === true;
  return {
    status: aborted ? 'CANCELLED' as const : 'FAILED' as const,
    errorKind: aborted ? null
      : classifyProviderError(error) ?? (error instanceof Error ? error.name : 'UNKNOWN'),
    ...(typeof evidence.providerRequestId === 'string' && evidence.providerRequestId !== ''
      ? { providerRequestId: evidence.providerRequestId } : {}),
    ...(knownUsage === undefined ? {} : { usage: knownUsage }),
  };
}

function resolveComposerPort(env: NodeJS.ProcessEnv): ComposerDraftPort {
  let config: ModelPortConfig | undefined;
  try {
    config = readModelPortConfig(env);
  } catch (error) {
    throw composerDraftError('MODEL_CONFIG_INVALID',
      `真实模型配置无法通过校验：${error instanceof Error ? error.message : '未知原因'}`);
  }
  if (config === undefined) {
    throw composerDraftError('MODEL_PORT_NOT_CONFIGURED',
      '当前服务实例使用 Mock 模型端口，没有可用的真实模型配置；草稿与发送不受影响。');
  }
  return new OpenAiCompatibleModelPort(config);
}
