import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { describeModelPortStatus, hasOpenRouterChatConfig, readDeclaredImageInput }
  from '../workflow/model-port-config.js';
import {
  MODEL_VERIFY_ERROR_CATEGORIES,
  ModelVerifyConfigError,
  createOpenAiCompatibleVerifyCall,
  readModelVerificationState,
  type ModelVerifyResult,
  type VerifyCallPort,
} from '../workflow/model-port-verify.js';
import { runModelPortVerification } from '../application/model-port-verification.js';
import { DEFAULT_VERIFY_TARGET, VERIFY_TARGET_STATES, type VerifyTarget } from
  '../workflow/model-verify-target.js';
import { ModelVerifyTargetError } from '../workflow/model-port-verify.js';
import { UuidSchema } from './domain-schemas.js';
import { ProblemError, type ProblemDetails } from './problem.js';
import { sendReadError, sendProblem, type RouteDependencies } from './envelope.js';
import { syncModelCatalog, type SyncModelCatalogResult } from '../application/model-catalog-sync.js';
import { readModelCatalogConfig, isCacheStale } from '../workflow/model-catalog-config.js';
import { ModelCatalogRepository } from '../model/model-catalog-repository.js';
import type { ModelCatalogEntryRow } from '../infrastructure/database-schema.js';
import { ConfigError } from '../config/config.js';
import { createRepositories } from '../application/unit-of-work.js';
import { decideChatImageInput, type ChatImageInputDecision }
  from '../application/chat-image-input.js';

/**
 * 图片输入能力的只读投影：与发送闸门同一份判定（`decideChatImageInput`），让输入框在
 * 粘贴图片时就能说明，而不是等上传完、点了发送才被 422 拒绝。
 *
 * 来源顺序：目录 → 声明表 → 环境变量 → 无。`image_input_source` 把「这次结论来自哪一层」
 * 一并告诉界面，用户才能区分「目录说可以」和「你自己声明的」。
 *
 * 这个端点描述的是进程环境，本身不依赖数据库；目录/声明读失败时返回 `UNKNOWN`，
 * 不整体失败、也不冒充「可以发」。
 */
async function describeImageInput(dependencies: RouteDependencies,
  status: { readonly configured: boolean; readonly model: string | null;
    readonly provider: 'fake' | 'openai-compatible' | 'invalid' },
  log: { warn: (payload: unknown, message: string) => void }):
  Promise<{ readonly state: ChatImageInputDecision['state'] | 'UNKNOWN';
    readonly source: ChatImageInputDecision['source'] }> {
  const model = status.model?.trim() ?? '';
  if (!status.configured || model === '') {
    const decision = decideChatImageInput({ configured: false, declared: false });
    return { state: decision.state, source: decision.source };
  }
  try {
    const repositories = createRepositories(dependencies.database.executor);
    const entry = await repositories.modelCatalog.readEntryBySourceModelId(model);
    // 目录有条目时不必读声明表：目录是准绳，声明不能覆盖它。
    const declaration = entry === undefined
      ? (await repositories.modelCapabilities.readDeclaration(status.provider, model))?.image_input
      : undefined;
    const decision = decideChatImageInput({ configured: true,
      catalogEntry: entry === undefined ? undefined : { imageInput: entry.capabilities.image_input },
      declaration, declared: readDeclaredImageInput(process.env) });
    return { state: decision.state, source: decision.source };
  } catch (error) {
    // 降级成 UNKNOWN 是给界面看的结论；真正的失败必须留痕，否则「权限没授」这类
    // 部署问题会伪装成「模型目录里没有这个模型」。
    log.warn({ err: error }, 'model_port_image_input_unavailable');
    return { state: 'UNKNOWN', source: 'NONE' };
  }
}

const ParamsSchema = Type.Object({ workspace_id: UuidSchema }, { additionalProperties: false });
/**
 * 当前聊天模型能否接受图片输入（2026-10-19）。与发送时的能力闸门同一份判定
 * （`application/chat-image-input.ts`）：输入框据此在粘贴图片时就给出说明，
 * 而不是等上传完、点了发送才被 422 拒绝。
 *
 * `UNKNOWN` 只表示这一次读不到目录（数据库不可用）：读端点本身不因数据库而失败，
 * 但也不冒充「可以发」。
 */
const ChatImageInputSchema = Type.Union([
  Type.Literal('NOT_CONFIGURED'), Type.Literal('SUPPORTED'), Type.Literal('DECLARED'),
  Type.Literal('MODEL_LACKS_IMAGE_INPUT'), Type.Literal('MODEL_NOT_IN_CATALOG'),
  Type.Literal('UNKNOWN'),
]);
/** 这次结论来自哪一层（2026-10-19，迁移 0121）：目录 / 声明表 / 环境变量 / 都没有。 */
const ChatImageInputSourceSchema = Type.Union([
  Type.Literal('CATALOG'), Type.Literal('DECLARED'), Type.Literal('ENV'), Type.Literal('NONE'),
]);
const StatusSchema = Type.Object({
  provider: Type.Union([Type.Literal('fake'), Type.Literal('openai-compatible'), Type.Literal('invalid')]),
  configured: Type.Boolean(),
  model: Type.Union([Type.String(), Type.Null()]),
  base_url: Type.Union([Type.String(), Type.Null()]),
  // 单次调用 token 上限，作为上下文占用的可核对分母；Fake 或配置残缺时为 null。
  max_call_tokens: Type.Union([Type.Integer(), Type.Null()]),
  image_input: ChatImageInputSchema,
  image_input_source: ChatImageInputSourceSchema,
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

const VerifyTargetStateSchema = Type.Union(VERIFY_TARGET_STATES.map((state) =>
  Type.Literal(state)));

const VerificationStateSchema = Type.Object({
  /** P1-4：本次查询的验证目标（`default` 或 `openrouter:<确切型号>`）。 */
  target: Type.String(),
  connection: Type.Union([Type.Literal('default'), Type.Literal('openrouter')]),
  model: Type.Union([Type.String(), Type.Null()]),
  current_config_fingerprint: Type.Union([Type.String(), Type.Null()]),
  last: Type.Union([VerifyResultSchema, Type.Null()]),
  /** P1-4：**本目标**最近一次验证（另一个型号的成功不会出现在这里）。 */
  target_last: Type.Union([VerifyResultSchema, Type.Null()]),
  matches_current_config: Type.Boolean(),
  /** 0142：最近一次验证所用凭据与当前凭据的关系；CHANGED 表示换过 Key、需重新验证。 */
  credential_identity: Type.Union([
    Type.Literal('MATCH'), Type.Literal('CHANGED'), Type.Literal('UNKNOWN'),
  ]),
  /** P1-4：目标此刻的互斥状态（13 态）；VERIFIED 只代表这个确切目标探测通过。 */
  state: VerifyTargetStateSchema,
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

/**
 * 读取验证目标（P1-4）。缺省＝默认连接；`openrouter` 必须带确切型号。
 * 不猜型号、不把「目录里有某个免费模型」当成用户选了它。
 */
function readVerifyTargetFrom(raw: unknown): VerifyTarget {
  if (raw === undefined || raw === null) return DEFAULT_VERIFY_TARGET;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw verifyTargetInvalid();
  const value = raw as Record<string, unknown>;
  const connection = value.connection;
  if (connection === undefined || connection === null || connection === 'default') {
    return DEFAULT_VERIFY_TARGET;
  }
  if (connection !== 'openrouter') throw verifyTargetInvalid();
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (model === '' || model.length > 200) throw verifyTargetInvalid();
  return { connection: 'openrouter', model };
}

function verifyTargetInvalid(): ProblemError {
  return new ProblemError({
    type: '/problems/model-verify-target-invalid', title: '验证目标无效', status: 400,
    detail: '验证目标只接受 default，或 connection=openrouter 加 1–200 字符的确切型号。',
    code: 'MODEL_VERIFY_TARGET_INVALID', retryable: false, retryAction: 'NONE',
  });
}

function verifyTargetProblem(error: ModelVerifyTargetError): ProblemDetails {
  if (error.code === 'MODEL_VERIFY_CATALOG_STALE') {
    return { type: '/problems/model-verify-catalog-stale', title: '模型目录已过期', status: 409,
      detail: '目录快照已过期，无法确认该型号的免费资格；请先刷新目录再验证。',
      code: 'MODEL_VERIFY_CATALOG_STALE', retryable: true,
      retryAction: 'REFRESH_AND_REDECIDE' };
  }
  return { type: '/problems/model-verify-target-not-eligible', title: '目标型号不可验证',
    status: 409,
    detail: '该型号不是当前目录快照里的免费文本模型，不能作为验证目标。',
    code: 'MODEL_VERIFY_TARGET_NOT_ELIGIBLE', retryable: false, retryAction: 'NONE' };
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
 * 模型能力声明（2026-10-19，迁移 0121）。
 *
 * 这是**实例级配置**，不是业务命令：一次声明没有状态机、没有修订、也没有「待确认」，
 * 同 `(provider, model)` 再写一次就是改口（last-writer-wins），GET 是权威读取。
 * 因此沿用 `/model-catalog/refresh` 的实例级先例，不建 command_receipt——回执要保护的是
 * 「同一命令是否已生效」的歧义，而这里重发同体必然得到同一状态。
 */
const CapabilityParamsSchema = Type.Object({
  workspace_id: UuidSchema,
  // 只有真实连接才谈得上「这个模型能不能读图」；fake/invalid 不接受声明。
  provider: Type.Literal('openai-compatible'),
  source_model_id: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
const CapabilityBodySchema = Type.Object({
  image_input: Type.Boolean(),
  note: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
}, { additionalProperties: false });
const CapabilityRowSchema = Type.Object({
  provider: Type.String(), source_model_id: Type.String(), image_input: Type.Boolean(),
  note: Type.Union([Type.String(), Type.Null()]),
  declared_at: Type.String(), updated_at: Type.String(),
}, { additionalProperties: false });

function capabilityJson(row: { readonly provider: string; readonly source_model_id: string;
  readonly image_input: boolean; readonly note: string | null;
  readonly declared_at: Date; readonly updated_at: Date }) {
  return { provider: row.provider, source_model_id: row.source_model_id,
    image_input: row.image_input, note: row.note,
    declared_at: row.declared_at.toISOString(), updated_at: row.updated_at.toISOString() };
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
        const imageInput = await describeImageInput(dependencies, status, request.log);
        return { provider: status.provider, configured: status.configured,
          model: status.model, base_url: status.baseUrl,
          max_call_tokens: status.maxCallTokens,
          image_input: imageInput.state, image_input_source: imageInput.source };
      } catch (error) { return sendReadError(reply, error, request.id); }
    });

  // —— 模型能力声明（实例级配置，非业务命令；见上方注释） ——
  app.get('/model-capabilities', { schema: { params: ParamsSchema,
    response: { 200: Type.Object({ items: Type.Array(CapabilityRowSchema) }, { additionalProperties: false }) } } },
  async (request, reply) => {
    try {
      const rows = await createRepositories(dependencies.database.executor)
        .modelCapabilities.listDeclarations();
      return { items: rows.map(capabilityJson) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.put('/model-capabilities/:provider/:source_model_id', {
    schema: { params: CapabilityParamsSchema, body: CapabilityBodySchema,
      response: { 200: CapabilityRowSchema } },
  }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; provider: string; source_model_id: string };
      const body = request.body as { image_input: boolean; note?: string | null };
      const row = await createRepositories(dependencies.database.executor).modelCapabilities
        .writeDeclaration({ provider: p.provider, sourceModelId: p.source_model_id,
          imageInput: body.image_input, note: body.note ?? null });
      return capabilityJson(row);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.delete('/model-capabilities/:provider/:source_model_id', {
    schema: { params: CapabilityParamsSchema,
      response: { 200: Type.Object({ removed: Type.Boolean() }, { additionalProperties: false }) } },
  }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; provider: string; source_model_id: string };
      const removed = await createRepositories(dependencies.database.executor).modelCapabilities
        .deleteDeclaration(p.provider, p.source_model_id);
      return { removed };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/model-port/verification', { schema: {
    params: ParamsSchema, response: { 200: VerificationStateSchema } } },  async (request, reply) => {
    try {
      // P1-4：可选 `?connection=openrouter&model=<id>` 查询「所选型号」的状态；
      // 缺省仍是进程默认连接，旧客户端行为不变。
      const target = readVerifyTargetFrom(request.query);
      const state = await readModelVerificationState(
        dependencies.database.executor, process.env, target);
      return {
        target: state.target,
        connection: state.connection,
        model: state.model,
        current_config_fingerprint: state.current_config_fingerprint,
        last: state.last === null ? null : toVerifyResultBody(state.last),
        target_last: state.target_last === null ? null : toVerifyResultBody(state.target_last),
        matches_current_config: state.matches_current_config,
        credential_identity: state.credential_identity,
        state: state.state,
        worker_startup_validation: state.worker_startup_validation,
      };
    } catch (error) {
      if (error instanceof ProblemError) return sendProblem(reply, error.problem, request.id);
      return sendReadError(reply, error, request.id);
    }
  });

  app.post('/model-port/verify', { schema: {
    params: ParamsSchema, response: { 200: VerifyResultSchema } } },
  async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string };
      const target = readVerifyTargetFrom(request.body);
      const result = await gate.run(() => runModelPortVerification({
        db: dependencies.database.executor,
        workspaceId: params.workspace_id,
        env: process.env,
        call: verifyCall,
        target,
      }));
      return toVerifyResultBody(result);
    } catch (error) {
      if (error instanceof ProblemError) {
        return sendProblem(reply, error.problem, request.id);
      }
      if (error instanceof ModelVerifyConfigError) {
        return sendProblem(reply, configProblem(error), request.id);
      }
      if (error instanceof ModelVerifyTargetError) {
        return sendProblem(reply, verifyTargetProblem(error), request.id);
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
