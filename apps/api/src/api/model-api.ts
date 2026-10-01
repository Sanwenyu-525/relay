import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { describeModelPortStatus } from '../workflow/model-port-config.js';
import {
  MODEL_VERIFY_ERROR_CATEGORIES,
  ModelVerifyConfigError,
  createOpenAiCompatibleVerifyCall,
  readModelVerificationState,
  type ModelVerifyResult,
  type VerifyCallPort,
} from '../workflow/model-port-verify.js';
import { runModelPortVerification } from '../application/model-port-verification.js';
import { UuidSchema } from './domain-schemas.js';
import { ProblemError, type ProblemDetails } from './problem.js';
import { sendReadError, sendProblem, type RouteDependencies } from './envelope.js';

const ParamsSchema = Type.Object({ workspace_id: UuidSchema }, { additionalProperties: false });
const StatusSchema = Type.Object({
  provider: Type.Union([Type.Literal('fake'), Type.Literal('openai-compatible'), Type.Literal('invalid')]),
  configured: Type.Boolean(),
  model: Type.Union([Type.String(), Type.Null()]),
  base_url: Type.Union([Type.String(), Type.Null()]),
  // 单次调用 token 上限，作为上下文占用的可核对分母；Fake 或配置残缺时为 null。
  max_call_tokens: Type.Union([Type.Integer(), Type.Null()]),
}, { additionalProperties: false });

const ErrorCategorySchema = Type.Union(
  MODEL_VERIFY_ERROR_CATEGORIES.map((category) => Type.Literal(category)),
);

const VerifyResultSchema = Type.Object({
  ok: Type.Boolean(),
  latency_ms: Type.Union([Type.Integer(), Type.Null()]),
  provider: Type.String(),
  model: Type.String(),
  config_fingerprint: Type.String(),
  error_category: Type.Union([ErrorCategorySchema, Type.Null()]),
  verified_at: Type.String(),
}, { additionalProperties: false });

const VerificationStateSchema = Type.Object({
  current_config_fingerprint: Type.Union([Type.String(), Type.Null()]),
  last: Type.Union([VerifyResultSchema, Type.Null()]),
  matches_current_config: Type.Boolean(),
  worker_startup_validation: Type.Union([
    Type.Literal('NOT_CONFIGURED'), Type.Literal('OK'), Type.Literal('FAILED'),
  ]),
}, { additionalProperties: false });

function configProblem(error: ModelVerifyConfigError): ProblemDetails {
  if (error.code === 'MODEL_PORT_NOT_CONFIGURED') {
    return {
      type: '/problems/model-port-not-configured',
      title: '模型端口未配置',
      status: 409,
      detail: '当前服务实例使用 Mock 模型端口，没有可验证的真实模型配置。',
      code: 'MODEL_PORT_NOT_CONFIGURED',
      retryable: false,
      retryAction: 'NONE',
    };
  }
  return {
    type: '/problems/model-config-invalid',
    title: '模型配置残缺',
    status: 409,
    detail: `真实模型配置无法通过校验：${error.message}`,
    code: 'MODEL_CONFIG_INVALID',
    retryable: false,
    retryAction: 'NONE',
  };
}

function verifyInFlightProblem(): ProblemDetails {
  return {
    type: '/problems/model-verify-in-progress',
    title: '验证进行中',
    status: 409,
    detail: '本实例已有一项模型验证在执行，请等待其结束后再试。',
    code: 'MODEL_VERIFY_IN_PROGRESS',
    retryable: true,
    retryAction: 'POLL_RESOURCE',
  };
}

/** 单实例内同时只允许一次验证外呼，避免放大调用。 */
class VerifyGate {
  #inFlight = false;
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#inFlight) throw new ProblemError(verifyInFlightProblem());
    this.#inFlight = true;
    try { return await work(); }
    finally { this.#inFlight = false; }
  }
}

/**
 * 当前服务实例的模型端口状态与验证（M04 只读面 + 验证入口）：
 * 来自进程环境变量与 model_calls 账本，不含密钥，不依赖 Workspace 事实；
 * 任何持本实例 Bearer 的客户端可见/可触发。响应永不包含密钥。
 */
export function registerModelRoutes(app: FastifyInstance, dependencies: RouteDependencies,
  verifyCall: VerifyCallPort = createOpenAiCompatibleVerifyCall()): void {
  const gate = new VerifyGate();
  app.get('/model-port', { schema: { params: ParamsSchema, response: { 200: StatusSchema } } },
    async (request, reply) => {
      try {
        const p = request.params as { workspace_id: string };
        void p;
        const status = describeModelPortStatus(process.env);
        return { provider: status.provider, configured: status.configured,
          model: status.model, base_url: status.baseUrl,
          max_call_tokens: status.maxCallTokens };
      } catch (error) { return sendReadError(reply, error, request.id); }
    });

  app.get('/model-port/verification', { schema: {
    params: ParamsSchema, response: { 200: VerificationStateSchema } } },
  async (request, reply) => {
    try {
      const state = await readModelVerificationState(
        dependencies.database.executor, process.env);
      return {
        current_config_fingerprint: state.current_config_fingerprint,
        last: state.last === null ? null : toVerifyResultBody(state.last),
        matches_current_config: state.matches_current_config,
        worker_startup_validation: state.worker_startup_validation,
      };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.post('/model-port/verify', { schema: {
    params: ParamsSchema, response: { 200: VerifyResultSchema } } },
  async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string };
      const result = await gate.run(() => runModelPortVerification({
        db: dependencies.database.executor,
        workspaceId: params.workspace_id,
        env: process.env,
        call: verifyCall,
      }));
      return toVerifyResultBody(result);
    } catch (error) {
      if (error instanceof ProblemError) {
        return sendProblem(reply, error.problem, request.id);
      }
      if (error instanceof ModelVerifyConfigError) {
        return sendProblem(reply, configProblem(error), request.id);
      }
      return sendReadError(reply, error, request.id);
    }
  });
}

function toVerifyResultBody(result: ModelVerifyResult): {
  ok: boolean; latency_ms: number | null; provider: string; model: string;
  config_fingerprint: string; error_category: ModelVerifyResult['error_category'];
  verified_at: string;
} {
  return {
    ok: result.ok,
    latency_ms: result.latency_ms === null ? null : Math.max(0, Math.round(result.latency_ms)),
    provider: result.provider,
    model: result.model,
    config_fingerprint: result.config_fingerprint,
    error_category: result.error_category,
    verified_at: result.verified_at,
  };
}
