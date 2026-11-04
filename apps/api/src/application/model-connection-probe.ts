import { ConfigError } from '../config/config.js';
import { parseModelBaseUrl } from '../workflow/model-endpoint-policy.js';
import type { ModelPortConfig } from '../workflow/model-port-config.js';
import { classifyVerifyError, VERIFY_PROMPT, VERIFY_TIMEOUT_MS,
  type ModelVerifyResult, type VerifyCallPort } from '../workflow/model-port-verify.js';
import type { ModelConnectionProtocol } from './model-connections.js';
import { DEFAULT_MODEL_CONNECTION_BUDGET } from './model-connections.js';
import { DomainError } from './domain-error.js';

/**
 * 「测试连接」（MODEL-SETTINGS-03）：对**尚未保存**的草稿做一次真实短探针。
 *
 * 与已登记连接的验证刻意不同，且必须如实理解边界：
 *   * 凭据只从本次请求进入内存，用完即弃；不写系统凭据库、不落任何业务表；
 *   * **不写 `model_calls` VERIFY 账本**：这条草稿没有连接身份，写进账本会被读成
 *     「某条连接的验证结论」，也会污染工作区的最近验证。它是外呼前的一次连通性检查，
 *     不是某条连接的已确认事实。
 *   * 因此「测试通过」不能被当成「这条连接已通过验证」；保存后仍需按连接验证。
 *
 * 失败与成功都返回结构化结果（不发外呼以外的任何业务写入）；只有输入形状非法才抛
 * 类型化错误。协议由调用方显式声明，不按 URL 或型号推断。
 */
export interface ProbeModelConnectionInput {
  readonly protocol: ModelConnectionProtocol;
  readonly baseUrl: string | null;
  readonly defaultModel: string;
  readonly apiKey: string;
  readonly timeoutMs?: number | undefined;
  readonly call: VerifyCallPort;
}

export interface ProbeModelConnectionResult {
  readonly ok: boolean;
  readonly latency_ms: number;
  readonly protocol: ModelConnectionProtocol;
  readonly model: string;
  readonly error_category: ModelVerifyResult['error_category'];
  /** 失败时的可读摘要；不包含密钥、请求头或上游原始响应。 */
  readonly message: string | null;
}

export async function probeModelConnection(
  input: ProbeModelConnectionInput,
): Promise<ProbeModelConnectionResult> {
  const model = input.defaultModel.trim();
  if (model === '' || model.length > 200 || model.includes('*')) {
    throw new ProbeInputError('default_model', 'must be an exact model id of 1-200 characters');
  }
  const apiKey = input.apiKey.trim();
  if (apiKey === '') throw new ProbeInputError('api_key', 'must not be empty');
  let baseUrl: string | undefined;
  if (input.baseUrl !== null && input.baseUrl.trim() !== '') {
    try { baseUrl = parseModelBaseUrl(input.baseUrl.trim()); }
    catch (error) {
      if (error instanceof ConfigError) {
        throw new ProbeInputError('base_url',
          'must be an https URL with a public host and no credentials, query or fragment');
      }
      throw error;
    }
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_MODEL_CONNECTION_BUDGET.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new ProbeInputError('timeout_ms', 'must be an integer in [1000, 600000]');
  }
  const config: ModelPortConfig = { provider: input.protocol, protocol: input.protocol,
    model, apiKey, baseUrl, timeoutMs,
    maxOutputTokens: DEFAULT_MODEL_CONNECTION_BUDGET.maxOutputTokens,
    maxCallTokens: DEFAULT_MODEL_CONNECTION_BUDGET.maxCallTokens,
    maxScopeCalls: DEFAULT_MODEL_CONNECTION_BUDGET.maxScopeCalls,
    maxScopeTokens: DEFAULT_MODEL_CONNECTION_BUDGET.maxScopeTokens };
  const started = Date.now();
  try {
    await input.call.call({ config, prompt: VERIFY_PROMPT,
      timeoutMs: Math.min(timeoutMs, VERIFY_TIMEOUT_MS) });
    return { ok: true, latency_ms: Date.now() - started, protocol: input.protocol,
      model, error_category: null, message: null };
  } catch (error) {
    return { ok: false, latency_ms: Date.now() - started, protocol: input.protocol,
      model, error_category: classifyVerifyError(error),
      message: error instanceof Error ? error.message.slice(0, 300) : 'probe failed' };
  }
}

/** 草稿输入形状非法（未发起外呼）。 */
export class ProbeInputError extends DomainError {
  constructor(field: string, message: string) {
    super({
      code: 'MODEL_CONNECTION_INVALID', status: 422,
      type: '/problems/model-connection-invalid', title: '模型连接配置无效',
      detail: `${field}: ${message}`,
      retryable: false, retryAction: 'NONE',
      fieldErrors: [{ field, message }],
    });
  }
}
