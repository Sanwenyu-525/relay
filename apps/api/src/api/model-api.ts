import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { describeModelPortStatus, hasOpenRouterChatConfig } from '../workflow/model-port-config.js';
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
import { syncModelCatalog, type SyncModelCatalogResult } from '../application/model-catalog-sync.js';
import { readModelCatalogConfig, isCacheStale } from '../workflow/model-catalog-config.js';
import { ModelCatalogRepository } from '../model/model-catalog-repository.js';
import type { ModelCatalogEntryRow } from '../infrastructure/database-schema.js';
import { ConfigError } from '../config/config.js';

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

// —— 免费模型目录（阶段 B）响应契约：快照摘要 + 严格判定条目 + 手动刷新结果。响应永不含密钥。 ——

const CatalogCapabilitiesSchema = Type.Object({
  tools: Type.Union([Type.Boolean(), Type.Null()]),
  text_input: Type.Union([Type.Boolean(), Type.Null()]),
  text_output: Type.Union([Type.Boolean(), Type.Null()]),
}, { additionalProperties: false });

const CatalogNotFreeReasonSchema = Type.Union([
  Type.Literal('MISSING_PRICE'), Type.Literal('INVALID_PRICE'),
  Type.Literal('NEGATIVE_PRICE'), Type.Literal('NONZERO_PRICE'),
  Type.Literal('UNKNOWN_BILLABLE_ITEM'),
]);

const CatalogFailureReasonSchema = Type.Union([
  Type.Literal('NETWORK'), Type.Literal('TIMEOUT'), Type.Literal('AUTH'),
  Type.Literal('RATE_LIMIT'), Type.Literal('PROTOCOL'), Type.Literal('INCOMPLETE'),
  Type.Literal('ENDPOINT_NOT_ALLOWED'), Type.Literal('NOT_CONFIGURED'),
]);

const CatalogEntrySchema = Type.Object({
  source_model_id: Type.String(),
  display_name: Type.String(),
  context_window: Type.Union([Type.Integer(), Type.Null()]),
  is_free: Type.Boolean(),
  not_free_reason: Type.Union([CatalogNotFreeReasonSchema, Type.Null()]),
  capabilities: CatalogCapabilitiesSchema,
  // 逐字保留来源计价项，供「目录收录≠免费」的可核实核对。
  pricing: Type.Record(Type.String(), Type.String()),
  fetched_at: Type.String(),
}, { additionalProperties: false });

const CatalogStatusSchema = Type.Object({
  // 目录功能是否启用（凭据可选，公开列表可读）；与聊天模型凭据相互独立。
  configured: Type.Boolean(),
  // 独立生成凭据与预算配置是否完整；只返回布尔值，不含凭据。
  chat_configured: Type.Boolean(),
  source: Type.Literal('openrouter'),
  directory_digest: Type.Union([Type.String(), Type.Null()]),
  snapshot_seq: Type.String(),
  last_success_at: Type.Union([Type.String(), Type.Null()]),
  last_attempt_at: Type.Union([Type.String(), Type.Null()]),
  last_failure_at: Type.Union([Type.String(), Type.Null()]),
  last_failure_reason: Type.Union([CatalogFailureReasonSchema, Type.Null()]),
  consecutive_failures: Type.Integer(),
  cache_stale: Type.Boolean(),
  total_count: Type.Integer(),
  free_count: Type.Integer(),
  entries: Type.Array(CatalogEntrySchema),
}, { additionalProperties: false });

const SyncStatusSchema = Type.Union([
  Type.Literal('NOT_CONFIGURED'), Type.Literal('SKIPPED'), Type.Literal('REJECTED'),
  Type.Literal('PUBLISHED'), Type.Literal('FAILED'),
]);

const RefreshResultSchema = Type.Object({
  status: SyncStatusSchema,
  reason: Type.Union([Type.String(), Type.Null()]),
  snapshot_seq: Type.Union([Type.String(), Type.Null()]),
  total_count: Type.Union([Type.Integer(), Type.Null()]),
  free_count: Type.Union([Type.Integer(), Type.Null()]),
  fetched_at: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function catalogEntryBody(entry: ModelCatalogEntryRow) {
  return {
    source_model_id: entry.source_model_id,
    display_name: entry.display_name,
    context_window: entry.context_window,
    is_free: entry.is_free,
    not_free_reason: entry.not_free_reason,
    capabilities: entry.capabilities,
    pricing: entry.pricing,
    fetched_at: entry.fetched_at.toISOString(),
  };
}

function mapRefreshResult(result: SyncModelCatalogResult) {
  switch (result.status) {
    case 'NOT_CONFIGURED':
      return { status: 'NOT_CONFIGURED', reason: null, snapshot_seq: null,
        total_count: null, free_count: null, fetched_at: null };
    case 'SKIPPED':
      return { status: 'SKIPPED', reason: result.reason, snapshot_seq: null,
        total_count: null, free_count: null, fetched_at: null };
    case 'REJECTED':
      return { status: 'REJECTED', reason: result.reason, snapshot_seq: null,
        total_count: null, free_count: null, fetched_at: null };
    case 'FAILED':
      return { status: 'FAILED', reason: result.reason, snapshot_seq: null,
        total_count: null, free_count: null, fetched_at: null };
    case 'PUBLISHED':
      return { status: 'PUBLISHED', reason: null, snapshot_seq: result.snapshotSeq,
        total_count: result.totalCount, free_count: result.freeCount, fetched_at: result.fetchedAt };
  }
}

function catalogConfigProblem(error: ConfigError): ProblemDetails {
  return {
    type: '/problems/model-catalog-config-invalid',
    title: '模型目录配置残缺',
    status: 409,
    detail: `免费模型目录配置无法通过校验：${error.message}`,
    code: 'MODEL_CATALOG_CONFIG_INVALID',
    retryable: false,
    retryAction: 'NONE',
  };
}

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

  // 免费模型目录快照（进程级全局事实，不隶属 Workspace）：只读当前已发布内容，不发外呼、不建 Task/Run。
  app.get('/model-catalog', { schema: { params: ParamsSchema, response: { 200: CatalogStatusSchema } } },
    async (request, reply) => {
      try {
        const config = readModelCatalogConfig(process.env);
        await syncModelCatalog({ db: dependencies.database.executor, env: process.env,
          trigger: 'open' });
        const repo = new ModelCatalogRepository(dependencies.database.executor);
        const state = await repo.readSyncState();
        const all = await repo.readEntries(false);
        const query = request.query as { free_only?: string; all?: string };
        const includeAll = query.free_only === 'false' || query.all === 'true';
        const entries = includeAll ? all : all.filter((entry) => entry.is_free);
        const freeCount = all.reduce((count, entry) => entry.is_free ? count + 1 : count, 0);
        return {
          configured: config !== undefined,
          chat_configured: hasOpenRouterChatConfig(process.env),
          source: state.source,
          directory_digest: state.directory_digest,
          snapshot_seq: String(state.snapshot_seq),
          last_success_at: iso(state.last_success_at),
          last_attempt_at: iso(state.last_attempt_at),
          last_failure_at: iso(state.last_failure_at),
          last_failure_reason: state.last_failure_reason,
          consecutive_failures: state.consecutive_failures,
          cache_stale: config === undefined ? false
            : isCacheStale(new Date(), state.last_success_at, config.cacheTtlMs),
          total_count: all.length,
          free_count: freeCount,
          entries: entries.map(catalogEntryBody),
        };
      } catch (error) {
        if (error instanceof ConfigError) {
          return sendProblem(reply, catalogConfigProblem(error), request.id);
        }
        return sendReadError(reply, error, request.id);
      }
    });

  // 手动刷新目录：一次有界外呼 + 原子发布，触发方式 manual（受最小间隔限速，尊重维护准入）。
  // 结果以结构化 status 返回（含 SKIPPED/REJECTED/FAILED），不以此处 HTTP 码表达同步成败。
  app.post('/model-catalog/refresh', { schema: {
    params: ParamsSchema, response: { 200: RefreshResultSchema } } },
  async (request, reply) => {
    try {
      const result = await syncModelCatalog({
        db: dependencies.database.executor, env: process.env, trigger: 'manual',
      });
      return mapRefreshResult(result);
    } catch (error) {
      if (error instanceof ConfigError) {
        return sendProblem(reply, catalogConfigProblem(error), request.id);
      }
      if (error instanceof ProblemError) {
        return sendProblem(reply, error.problem, request.id);
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
