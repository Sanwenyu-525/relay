import type { DbExecutor } from '../infrastructure/database.js';
import type { ExecutionContractRow, ModelCatalogEntryRow, RunRow } from
  '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { ModelFetchDependencies } from '../workflow/model-endpoint-policy.js';
import type { ModelIdentity, ModelPort, ModelUsage } from '../workflow/fake-model-port.js';
import { FakeModelPort } from '../workflow/fake-model-port.js';
import { OpenAiCompatibleModelPort } from '../workflow/openai-compatible-model-port.js';
import {
  computeModelConfigFingerprint,
  readModelPortConfig,
  readOpenRouterModelPortConfig,
  type ModelPortConfig,
} from '../workflow/model-port-config.js';
import { readModelCatalogConfig } from '../workflow/model-catalog-config.js';
import { buildFreePriceGuard } from '../workflow/free-call-guard.js';
import { compareCredentialIdentity, readCredentialFingerprint } from
  '../workflow/credential-identity.js';
import { createOpenRouterCatalogSource } from '../workflow/openrouter-catalog-source.js';
import { parseAssistModelSnapshot, planAssistModelBudget, snapshotIdentityBudget,
  type ParsedAssistModelSnapshot } from './assist-model-snapshot.js';
import { syncModelCatalog } from './model-catalog-sync.js';
import { createRepositories } from './unit-of-work.js';
import { connectionConfigFingerprint, connectionCredentials, modelPortConfigFromConnection,
  resolveConnectionApiKey } from './model-connection-runtime.js';
import type { CredentialStore } from '../credentials/credential-store.js';

/**
 * Run 执行端的模型准入（P0-1）。
 *
 * 冻结的模型计划写在 `execution_contracts.frozen_snapshot.model_selection_snapshot`，
 * 由 Delegate 在准入事务里冻结。此前执行端（`run-steps.prepareExternalWork`）仍直接读
 * `process.env` 建默认端口，于是「Run 冻结模型 A、真实外呼模型 B」成为可能。
 *
 * 本模块是执行端**唯一**的模型解析入口：
 *   1. 有冻结计划 → 只按计划里排第一的候选解析，身份/指纹/凭据/预算/免费资格任一不符即停止；
 *   2. 没有冻结计划（旧 Run、Fake Run）→ 保留原进程默认行为，并显式标注 basis=LEGACY_ENV，
 *      不伪造冻结身份。
 *
 * 停止就是停止：不静默回退默认模型、不回退 Fake、不切换候选、不换凭据。
 * 停止原因以 StepExecution.FAILED 的类型化 reason 落库，交给既有 Run 失败语义处理。
 */

export type RunModelStopReason =
  | 'MODEL_SNAPSHOT_INVALID'
  | 'MODEL_NOT_CONFIGURED'
  | 'MODEL_CONFIG_CHANGED'
  | 'MODEL_CREDENTIAL_CHANGED'
  | 'MODEL_FREE_NOT_ELIGIBLE'
  | 'MODEL_CATALOG_STALE'
  // 0144（ADR-036 阶段三）：契约冻结的是连接身份时，连接本身可能已停用或凭据已丢。
  | 'MODEL_CONNECTION_UNAVAILABLE'
  | 'MODEL_CONNECTION_DISABLED'
  | 'MODEL_CONNECTION_CREDENTIAL_MISSING';

export interface RunSemanticModel {
  readonly identity: ModelIdentity;
  readonly evaluate: (input: { readonly statement: string; readonly content: string },
    signal?: AbortSignal) => Promise<{
      readonly verdict: 'PASS' | 'FAIL' | 'UNCERTAIN'; readonly reason: string;
      readonly providerRequestId: string;
      readonly usage: ModelUsage;
    }>;
}

export type RunModelAdmission =
  | {
    readonly kind: 'READY';
    readonly port: ModelPort;
    /** 真实 Provider 还是 Fake：BUILD_CONTEXT 的取材口径依赖它。 */
    readonly external: boolean;
    /** FROZEN = 按执行契约冻结计划解析；LEGACY_ENV = 旧 Run 的进程默认。 */
    readonly basis: 'FROZEN' | 'LEGACY_ENV';
    /** 冻结依据（非密钥），用于 DRAFT/检查证据与诊断。 */
    readonly evidence: JsonObject;
    readonly semantic?: RunSemanticModel | undefined;
  }
  | {
    readonly kind: 'STOPPED';
    readonly reason: RunModelStopReason;
    readonly evidence: JsonObject;
  };

export interface ResolveRunModelPortInput {
  readonly run: RunRow;
  readonly contract: ExecutionContractRow | undefined;
  readonly env: NodeJS.ProcessEnv;
  /** 仅测试注入：与 Assist 相同的受控 fetch/lookup 接缝。 */
  readonly transport?: ModelFetchDependencies | undefined;
  /** 凭据存储；缺省用进程默认（按存放根缓存的 DPAPI 存储）。测试可注入替代。 */
  readonly credentials?: CredentialStore | undefined;
}

export async function resolveRunModelPort(db: DbExecutor,
  input: ResolveRunModelPortInput): Promise<RunModelAdmission> {
  const frozenSnapshot = input.contract?.frozen_snapshot.model_selection_snapshot;
  if (frozenSnapshot === undefined) return legacyAdmission(input);

  let plan: ParsedAssistModelSnapshot;
  try {
    plan = parseAssistModelSnapshot(frozenSnapshot as JsonObject);
  } catch {
    return stopped('MODEL_SNAPSHOT_INVALID', { reason: 'MODEL_SNAPSHOT_INVALID' });
  }
  const candidate = plan.candidates[0];
  if (candidate === undefined) {
    return stopped('MODEL_SNAPSHOT_INVALID', { reason: 'MODEL_SNAPSHOT_INVALID' });
  }
  // 0144：契约冻结了连接身份 → 只按那条连接解析，绝不回读「当前默认连接」。
  // 这一步必须在进程默认分支之前：默认连接可能已被改指、停用或轮换凭据，
  // 任何一种都不该让在途 Run 悄悄换 Provider 或换 Key。
  if (input.contract?.connection_id !== undefined && input.contract?.connection_id !== null) {
    return resolveFrozenConnection(db, input, plan, candidate.connection);
  }
  // Run 内不换模型：候选队列是 Assist 的接续策略，Run 的身份必须唯一且稳定。
  if (candidate.connection.provider === 'openai-compatible') {
    return resolveDefaultConnection(input, plan, candidate.connection);
  }
  if (candidate.connection.provider === 'openrouter') {
    return resolveFreeConnection(db, input, plan, candidate.connection.model,
      candidate.connection.configFingerprint, plan.budget);
  }
  return stopped('MODEL_SNAPSHOT_INVALID', { reason: 'MODEL_SNAPSHOT_INVALID',
    provider: candidate.connection.provider });
}

/** 旧 Run / Fake Run：没有冻结计划时保留进程默认，但显式标注来源，不冒充冻结身份。 */
function legacyAdmission(input: ResolveRunModelPortInput): RunModelAdmission {
  const config = readModelPortConfig(input.env);
  if (config === undefined) {
    return { kind: 'READY', port: new FakeModelPort(), external: false, basis: 'LEGACY_ENV',
      evidence: { basis: 'LEGACY_ENV', provider: 'fake' } };
  }
  const port = new OpenAiCompatibleModelPort(config, input.transport ?? {});
  return { kind: 'READY', port, external: true, basis: 'LEGACY_ENV',
    evidence: { basis: 'LEGACY_ENV', provider: config.provider, model: config.model,
      config_fingerprint: computeModelConfigFingerprint(config) },
    semantic: semanticOf(port) };
}

/**
 * 按契约冻结的**连接身份**解析（0144）。四道闸门，任一不符即停：
 *
 *   1. 连接仍在本工作区可见（否则是数据不一致，不猜替代品）；
 *   2. 连接仍为 ACTIVE（停用后不得继续执行未获准的新调用）；
 *   3. 凭据代数与冻结值一致（轮换过就停，不悄悄换 Key）；
 *   4. 由连接行重算的配置指纹与冻结值一致（端点/预算被改过就停）。
 *
 * 四道都过才解析秘密。凭据缺失按「缺凭据」停，而不是当成「未配置」退回进程默认。
 */
async function resolveFrozenConnection(db: DbExecutor, input: ResolveRunModelPortInput,
  plan: ParsedAssistModelSnapshot,
  candidate: ParsedAssistModelSnapshot['candidates'][number]['connection']):
Promise<RunModelAdmission> {
  const connectionId = input.contract!.connection_id!;
  const frozenVersion = input.contract?.connection_credential_version ?? null;
  const repositories = createRepositories(db);
  const row = await repositories.modelConnections.read(input.run.workspace_id, connectionId);
  if (row === undefined) {
    return stopped('MODEL_CONNECTION_UNAVAILABLE', { reason: 'MODEL_CONNECTION_UNAVAILABLE',
      connection_id: connectionId });
  }
  if (row.status !== 'ACTIVE') {
    return stopped('MODEL_CONNECTION_DISABLED', { reason: 'MODEL_CONNECTION_DISABLED',
      connection_id: connectionId, connection_name: row.name });
  }
  if (frozenVersion !== null && row.credential_version !== frozenVersion) {
    return stopped('MODEL_CREDENTIAL_CHANGED', { reason: 'MODEL_CREDENTIAL_CHANGED',
      connection_id: connectionId, frozen_credential_version: frozenVersion,
      current_credential_version: row.credential_version });
  }
  if (connectionConfigFingerprint(row) !== candidate.configFingerprint) {
    return stopped('MODEL_CONFIG_CHANGED', { reason: 'MODEL_CONFIG_CHANGED',
      connection_id: connectionId, frozen_config_fingerprint: candidate.configFingerprint,
      current_config_fingerprint: connectionConfigFingerprint(row) });
  }
  const apiKey = await resolveConnectionApiKey(connectionCredentials(input.credentials), row);
  if (apiKey === undefined || apiKey.trim() === '') {
    return stopped('MODEL_CONNECTION_CREDENTIAL_MISSING',
      { reason: 'MODEL_CONNECTION_CREDENTIAL_MISSING', connection_id: connectionId,
        connection_name: row.name });
  }
  const config = modelPortConfigFromConnection(row, apiKey);
  const budgetMismatch = budgetDiffers(plan.budget, config, null);
  if (budgetMismatch !== undefined) return budgetMismatch;
  const credentialStop = credentialMismatch(input.contract, config);
  if (credentialStop !== undefined) return credentialStop;
  const port = new OpenAiCompatibleModelPort(config, input.transport ?? {}, undefined,
    snapshotIdentityBudget(plan.budget));
  return { kind: 'READY', port, external: true, basis: 'FROZEN',
    evidence: { ...frozenEvidence('openai-compatible', row.default_model,
      candidate.configFingerprint), connection_id: connectionId,
      connection_credential_version: row.credential_version },
    semantic: semanticOf(port) };
}

function resolveDefaultConnection(input: ResolveRunModelPortInput,
  plan: ParsedAssistModelSnapshot,
  connection: ParsedAssistModelSnapshot['candidates'][number]['connection']): RunModelAdmission {
  let config: ModelPortConfig | undefined;
  try { config = readModelPortConfig(input.env); }
  catch { return stopped('MODEL_CONFIG_CHANGED', { reason: 'MODEL_CONFIG_CHANGED',
    provider: connection.provider, model: connection.model }); }
  if (config === undefined) {
    return stopped('MODEL_NOT_CONFIGURED', { reason: 'MODEL_NOT_CONFIGURED',
      provider: connection.provider, model: connection.model });
  }
  if (config.model !== connection.model ||
      computeModelConfigFingerprint(config) !== connection.configFingerprint) {
    return stopped('MODEL_CONFIG_CHANGED', { reason: 'MODEL_CONFIG_CHANGED',
      provider: connection.provider, model: connection.model,
      frozen_config_fingerprint: connection.configFingerprint,
      current_config_fingerprint: computeModelConfigFingerprint(config) });
  }
  const budgetMismatch = budgetDiffers(plan.budget, config, null);
  if (budgetMismatch !== undefined) return budgetMismatch;
  const credentialStop = credentialMismatch(input.contract, config);
  if (credentialStop !== undefined) return credentialStop;
  // 0135：Run 的外呼闸门也按冻结档位执行，不能回落到进程默认预算。
  const port = new OpenAiCompatibleModelPort(config, input.transport ?? {}, undefined,
    snapshotIdentityBudget(plan.budget));
  return { kind: 'READY', port, external: true, basis: 'FROZEN',
    evidence: frozenEvidence(connection.provider, connection.model, connection.configFingerprint),
    semantic: semanticOf(port) };
}

async function resolveFreeConnection(db: DbExecutor, input: ResolveRunModelPortInput,
  plan: ParsedAssistModelSnapshot, model: string, configFingerprint: string,
  budget: ParsedAssistModelSnapshot['budget']): Promise<RunModelAdmission> {
  if (model.toLowerCase() === 'openrouter/free') {
    return stopped('MODEL_FREE_NOT_ELIGIBLE', { reason: 'MODEL_FREE_NOT_ELIGIBLE',
      provider: 'openrouter', model });
  }
  let config: ModelPortConfig;
  try { config = readOpenRouterModelPortConfig(input.env, model); }
  catch {
    return stopped('MODEL_NOT_CONFIGURED', { reason: 'MODEL_NOT_CONFIGURED',
      provider: 'openrouter', model });
  }
  if (computeModelConfigFingerprint(config) !== configFingerprint) {
    return stopped('MODEL_CONFIG_CHANGED', { reason: 'MODEL_CONFIG_CHANGED',
      provider: 'openrouter', model, frozen_config_fingerprint: configFingerprint,
      current_config_fingerprint: computeModelConfigFingerprint(config) });
  }
  const credentialStop = credentialMismatch(input.contract, config);
  if (credentialStop !== undefined) return credentialStop;

  const catalogConfig = readModelCatalogConfig(input.env);
  if (catalogConfig === undefined) {
    return stopped('MODEL_CATALOG_STALE', { reason: 'MODEL_CATALOG_STALE',
      provider: 'openrouter', model });
  }
  const repositories = createRepositories(db);
  let sync = await repositories.modelCatalog.readSyncState();
  if (sync.last_success_at === null ||
      Date.now() - sync.last_success_at.getTime() >= catalogConfig.cacheTtlMs) {
    await syncModelCatalog({ db, env: input.env, trigger: 'open',
      source: createOpenRouterCatalogSource(catalogConfig, input.transport) });
    sync = await repositories.modelCatalog.readSyncState();
    if (sync.last_success_at === null ||
        Date.now() - sync.last_success_at.getTime() >= catalogConfig.cacheTtlMs) {
      return stopped('MODEL_CATALOG_STALE', { reason: 'MODEL_CATALOG_STALE',
        provider: 'openrouter', model });
    }
  }
  const entry = await repositories.modelCatalog.readEntryBySourceModelId(model);
  if (entry === undefined || !isEligibleFreeEntry(entry, plan)) {
    return stopped('MODEL_FREE_NOT_ELIGIBLE', { reason: 'MODEL_FREE_NOT_ELIGIBLE',
      provider: 'openrouter', model });
  }
  // 免费路由的单次预留还会被 Provider 窗口截断，所以预期预算必须带上 entry 的
  // `context_window` 才能和冻结值比较；只在读不到条目时才判为不合格，不拿猜测的窗口重算。
  const budgetMismatch = budgetDiffers(budget, config, entry.context_window);
  if (budgetMismatch !== undefined) return budgetMismatch;
  const port = new OpenAiCompatibleModelPort(config, input.transport ?? {},
    buildFreePriceGuard({ connection: { provider: 'openrouter', model,
      configFingerprint }, freeOnly: true,
      catalogBasis: { source: 'openrouter', snapshotSeq: sync.snapshot_seq.toString(),
        sourceModelId: model }, budget }), snapshotIdentityBudget(budget));
  return { kind: 'READY', port, external: true, basis: 'FROZEN',
    evidence: { ...frozenEvidence('openrouter', model, configFingerprint),
      free_only: true, catalog_snapshot_seq: sync.snapshot_seq.toString() },
    semantic: semanticOf(port) };
}

/**
 * 免费资格必须逐条成立：目录条目存在、确为免费、确切型号（非随机路由）、文本能力、
 * 上下文窗口够用，并覆盖冻结时声明需要的工具/JSON 能力。未知不等于可用。
 */
function isEligibleFreeEntry(entry: ModelCatalogEntryRow | undefined,
  plan: ParsedAssistModelSnapshot): boolean {
  if (entry === undefined || !entry.is_free ||
      entry.source_model_id.toLowerCase() === 'openrouter/free' ||
      entry.capabilities.text_input !== true || entry.capabilities.text_output !== true ||
      entry.context_window === null ||
      entry.context_window < plan.requirements.minimumContextWindow) return false;
  return (!plan.requirements.requiresTools || entry.capabilities.tools === true) &&
    (!plan.requirements.requiresJsonOutput || entry.capabilities.response_format === true);
}

/**
 * 冻结凭据与当前凭据必须一致（P0-2）。
 *
 * 换 Key 之后旧 Run 不能悄悄用新凭据继续外呼：那是「同一次冻结身份」下换了一个账户，
 * 配额、限流与计费归属都会变。冻结值为空（0142 之前的旧 Run）按未知处理，保留兼容行为，
 * 不伪造匹配也不据此拒绝。
 */
function credentialMismatch(contract: ExecutionContractRow | undefined,
  config: ModelPortConfig): RunModelAdmission | undefined {
  const frozen = contract?.credential_fingerprint ?? null;
  const state = compareCredentialIdentity(frozen, readCredentialFingerprint(config));
  if (state !== 'CHANGED') return undefined;
  return stopped('MODEL_CREDENTIAL_CHANGED', { reason: 'MODEL_CREDENTIAL_CHANGED',
    provider: config.provider, model: config.model });
}

/**
 * 冻结预算必须与「当前配置 + 冻结档位 + Provider 窗口」重算出的预期一致。
 *
 * 不能直接拿冻结值和进程默认值比较：选了 256K/512K/1M 之后，冻结值本来就不再
 * 等于 `RELAY_MODEL_MAX_CALL_TOKENS`，那样会把一次合法的档位选择误判成配置变化。
 * 反过来，进程配置真的改了（限额、调用数）时重算值仍会对不上，照常停止。
 */
function budgetDiffers(budget: ParsedAssistModelSnapshot['budget'],
  config: ModelPortConfig, providerWindow: number | null): RunModelAdmission | undefined {
  const expected = planAssistModelBudget(config, budget.contextBudgetTokens, providerWindow);
  if (budget.callReservationTokens === expected.callReservationTokens &&
      budget.scopeCallLimit === expected.scopeCallLimit &&
      budget.scopeTokenLimit === expected.scopeTokenLimit) return undefined;
  return stopped('MODEL_CONFIG_CHANGED', { reason: 'MODEL_CONFIG_CHANGED',
    provider: config.provider, model: config.model, scope: 'BUDGET' });
}

function frozenEvidence(provider: string, model: string, configFingerprint: string): JsonObject {
  return { basis: 'FROZEN', provider, model, config_fingerprint: configFingerprint };
}

function semanticOf(port: OpenAiCompatibleModelPort): RunSemanticModel {
  return { identity: port.identity, evaluate: (input, signal) => port.evaluate(input, signal) };
}

function stopped(reason: RunModelStopReason, evidence: JsonObject): RunModelAdmission {
  return { kind: 'STOPPED', reason, evidence };
}
