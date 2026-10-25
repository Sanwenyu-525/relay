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
import { createOpenRouterCatalogSource } from '../workflow/openrouter-catalog-source.js';
import { parseAssistModelSnapshot, type ParsedAssistModelSnapshot } from
  './assist-model-snapshot.js';
import { syncModelCatalog } from './model-catalog-sync.js';
import { createRepositories } from './unit-of-work.js';

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
  | 'MODEL_CATALOG_STALE';

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
  const budgetMismatch = budgetDiffers(plan.budget, config);
  if (budgetMismatch !== undefined) return budgetMismatch;
  const port = new OpenAiCompatibleModelPort(config, input.transport ?? {});
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
  const budgetMismatch = budgetDiffers(budget, config);
  if (budgetMismatch !== undefined) return budgetMismatch;

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
  if (!isEligibleFreeEntry(entry, plan)) {
    return stopped('MODEL_FREE_NOT_ELIGIBLE', { reason: 'MODEL_FREE_NOT_ELIGIBLE',
      provider: 'openrouter', model });
  }
  const port = new OpenAiCompatibleModelPort(config, input.transport ?? {},
    buildFreePriceGuard({ connection: { provider: 'openrouter', model,
      configFingerprint }, freeOnly: true,
      catalogBasis: { source: 'openrouter', snapshotSeq: sync.snapshot_seq.toString(),
        sourceModelId: model }, budget }));
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

/** 冻结预算与当前配置必须一致：不一致说明配置已变，不能拿新预算执行旧 Run。 */
function budgetDiffers(budget: ParsedAssistModelSnapshot['budget'],
  config: ModelPortConfig): RunModelAdmission | undefined {
  if (budget.callReservationTokens === config.maxCallTokens &&
      budget.scopeCallLimit === config.maxScopeCalls &&
      budget.scopeTokenLimit === config.maxScopeTokens) return undefined;
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
