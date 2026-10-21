import type { JsonObject } from '../infrastructure/json.js';
import type { ModelCatalogEntryRow, SessionModelSelectionRow } from
  '../infrastructure/database-schema.js';
import type { Repositories } from './unit-of-work.js';
import { computeModelConfigFingerprint, readModelPortConfig,
  readOpenRouterModelPortConfig } from '../workflow/model-port-config.js';
import { readModelCatalogConfig } from '../workflow/model-catalog-config.js';

const MAX_FREE_MODEL_ATTEMPTS = 3;
const FREE_MODEL_POLICY_VERSION = 'openrouter-free-fallback-v1';

/** Immutable non-secret model identity frozen in the RequestAssistMessage transaction. */
export async function freezeAssistModelSnapshot(repositories: Repositories,
  selection: SessionModelSelectionRow | undefined, env: NodeJS.ProcessEnv,
  requirements: { readonly requiresTools: boolean; readonly requiresJsonOutput: boolean }):
  Promise<{ readonly snapshot: JsonObject; readonly attemptState: JsonObject } | undefined> {
  if (selection === undefined) {
    const config = readModelPortConfig(env);
    if (config === undefined) return undefined;
    return frozen([candidateSnapshot({ provider: 'openai-compatible', model: config.model,
      configFingerprint: computeModelConfigFingerprint(config) }, false, null)], config, 1,
    requirements);
  }
  if (selection.connection === 'default') {
    const config = readModelPortConfig(env);
    if (config === undefined || config.model !== selection.model ||
        computeModelConfigFingerprint(config) !== selection.config_fingerprint) {
      throw new Error('ASSIST_MODEL_CONFIG_CHANGED');
    }
    const candidate = candidateSnapshot({ provider: 'openai-compatible', model: config.model,
      configFingerprint: selection.config_fingerprint }, false, null);
    return frozen([candidate], config, 1, requirements);
  }

  const sync = await repositories.modelCatalog.readSyncState();
  const catalogConfig = readModelCatalogConfig(env);
  if (catalogConfig === undefined || sync.last_success_at === null ||
      Date.now() - sync.last_success_at.getTime() > catalogConfig.cacheTtlMs) {
    throw new Error('ASSIST_MODEL_CATALOG_STALE');
  }
  const rows = await repositories.modelCatalog.readEntries(true);
  const selected = rows.find((row) => row.source_model_id === selection.model);
  if (selection.free_only !== true || selected === undefined ||
      selected.source_model_id.toLowerCase() === 'openrouter/free') {
    throw new Error('ASSIST_FREE_MODEL_NO_LONGER_ELIGIBLE');
  }
  const selectedConfig = readOpenRouterModelPortConfig(env, selection.model);
  if (!isTextCandidate(selected, requirements, selectedConfig.maxCallTokens)) {
    throw new Error('ASSIST_FREE_MODEL_NO_LONGER_ELIGIBLE');
  }
  if (computeModelConfigFingerprint(selectedConfig) !== selection.config_fingerprint) {
    throw new Error('ASSIST_MODEL_CONFIG_CHANGED');
  }
  const entries = [selected, ...rows.filter((row) => row.source_model_id !== selection.model)
    .filter((entry) => isTextCandidate(entry, requirements, selectedConfig.maxCallTokens))
    .sort(byModelId)].slice(0, MAX_FREE_MODEL_ATTEMPTS);
  const candidates = entries.map((entry, index) => {
    const config = readOpenRouterModelPortConfig(env, entry.source_model_id);
    return candidateSnapshot({ provider: 'openrouter', model: entry.source_model_id,
      configFingerprint: index === 0 ? selection.config_fingerprint
        : computeModelConfigFingerprint(config) }, true, {
      source: 'openrouter', snapshotSeq: sync.snapshot_seq.toString(),
      sourceModelId: entry.source_model_id });
  });
  return frozen(candidates, selectedConfig, Math.min(MAX_FREE_MODEL_ATTEMPTS, candidates.length),
    requirements);
}

export interface AssistModelCandidateSnapshot {
  readonly connection: { readonly provider: string; readonly model: string;
    readonly configFingerprint: string };
  readonly freeOnly: boolean;
  readonly catalogBasis: { readonly source: 'openrouter'; readonly snapshotSeq: string;
    readonly sourceModelId: string } | null;
}

export interface ParsedAssistModelSnapshot {
  readonly version: 1;
  readonly policyVersion: string;
  readonly requirements: { readonly requiresTools: boolean;
    readonly requiresJsonOutput: boolean; readonly minimumContextWindow: number };
  readonly candidates: readonly AssistModelCandidateSnapshot[];
  readonly budget: { readonly callReservationTokens: number;
    readonly scopeCallLimit: number; readonly scopeTokenLimit: number };
  readonly maxAttempts: number;
}

export function parseAssistModelSnapshot(value: JsonObject): ParsedAssistModelSnapshot {
  const version = value.version;
  const policyVersion = value.policy_version;
  const candidates = value.candidates;
  const budget = value.budget;
  const requirements = value.requirements;
  const maxAttempts = value.max_attempts;
  if (version !== 1 || typeof policyVersion !== 'string' || !Array.isArray(candidates) ||
      candidates.length < 1 || candidates.length > MAX_FREE_MODEL_ATTEMPTS ||
      typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) ||
      maxAttempts < 1 || maxAttempts > candidates.length ||
      typeof budget !== 'object' || budget === null || Array.isArray(budget) ||
      typeof requirements !== 'object' || requirements === null || Array.isArray(requirements)) {
    throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
  }
  const normalized = candidates.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
    }
    const object = entry as Record<string, unknown>;
    const connection = object.connection;
    const basis = object.catalog_basis;
    if (typeof connection !== 'object' || connection === null || Array.isArray(connection)) {
      throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
    }
    const candidateConnection = connection as Record<string, unknown>;
    if (candidateConnection.provider === 'openrouter' &&
        typeof candidateConnection.model === 'string' &&
        candidateConnection.model.toLowerCase() === 'openrouter/free') {
      throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
    }
    if ((candidateConnection.provider !== 'openrouter' &&
         candidateConnection.provider !== 'openai-compatible') ||
        typeof candidateConnection.model !== 'string' ||
        candidateConnection.model.trim() === '' || candidateConnection.model.length > 200 ||
        typeof candidateConnection.config_fingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(candidateConnection.config_fingerprint) ||
        typeof object.free_only !== 'boolean' ||
        (basis !== null && (typeof basis !== 'object' || Array.isArray(basis))) ||
        object.free_only !== (candidateConnection.provider === 'openrouter')) {
      throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
    }
    let catalogBasis: AssistModelCandidateSnapshot['catalogBasis'];
    if (basis === null && candidateConnection.provider === 'openrouter' ||
        basis !== null && candidateConnection.provider !== 'openrouter') {
      throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
    }
    if (basis === null) catalogBasis = null;
    else {
      const basisObject = basis as Record<string, unknown>;
      if (basisObject.source !== 'openrouter' ||
          typeof basisObject.snapshot_seq !== 'string' ||
          !/^[1-9][0-9]*$/u.test(basisObject.snapshot_seq) ||
          basisObject.source_model_id !== candidateConnection.model) {
        throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
      }
      catalogBasis = { source: 'openrouter', snapshotSeq: basisObject.snapshot_seq,
        sourceModelId: basisObject.source_model_id as string };
    }
    return {
      connection: { provider: candidateConnection.provider, model: candidateConnection.model,
        configFingerprint: candidateConnection.config_fingerprint },
      freeOnly: object.free_only,
      catalogBasis,
    };
  });
  const budgetObject = budget as Record<string, unknown>;
  const requirementObject = requirements as Record<string, unknown>;
  if (!positiveSafeInteger(budgetObject.call_reservation_tokens) ||
      !positiveSafeInteger(budgetObject.scope_call_limit) ||
      !positiveSafeInteger(budgetObject.scope_token_limit) ||
      typeof requirementObject.tools !== 'boolean' ||
      typeof requirementObject.response_format !== 'boolean' ||
      !positiveSafeInteger(requirementObject.minimum_context_window) ||
      normalized.some((candidate) => candidate.connection.provider !==
        normalized[0]!.connection.provider) ||
      new Set(normalized.map((candidate) => candidate.connection.model)).size !== normalized.length ||
      normalized[0]!.connection.provider === 'openai-compatible' &&
        (normalized.length !== 1 || maxAttempts !== 1) ||
      normalized[0]!.connection.provider === 'openrouter' &&
        normalized.some((candidate) => candidate.catalogBasis?.snapshotSeq !==
          normalized[0]!.catalogBasis?.snapshotSeq)) {
    throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
  }
  return { version: 1, policyVersion,
    requirements: { requiresTools: requirementObject.tools as boolean,
      requiresJsonOutput: requirementObject.response_format as boolean,
      minimumContextWindow: requirementObject.minimum_context_window as number },
    candidates: normalized as readonly AssistModelCandidateSnapshot[],
    budget: { callReservationTokens: budgetObject.call_reservation_tokens as number,
      scopeCallLimit: budgetObject.scope_call_limit as number,
      scopeTokenLimit: budgetObject.scope_token_limit as number }, maxAttempts };
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}

function frozen(candidates: readonly AssistModelCandidateSnapshot[],
  config: { readonly maxCallTokens: number; readonly maxScopeCalls: number;
    readonly maxScopeTokens: number }, maxAttempts: number,
  requirements: { readonly requiresTools: boolean; readonly requiresJsonOutput: boolean }) {
  const snapshot: JsonObject = {
    version: 1, policy_version: FREE_MODEL_POLICY_VERSION,
    requirements: { tools: requirements.requiresTools,
      response_format: requirements.requiresJsonOutput,
      minimum_context_window: config.maxCallTokens },
    candidates: candidates.map((candidate) => ({
      connection: { provider: candidate.connection.provider, model: candidate.connection.model,
        config_fingerprint: candidate.connection.configFingerprint },
      free_only: candidate.freeOnly,
      catalog_basis: candidate.catalogBasis === null ? null : {
        source: candidate.catalogBasis.source, snapshot_seq: candidate.catalogBasis.snapshotSeq,
        source_model_id: candidate.catalogBasis.sourceModelId },
    })),
    budget: { call_reservation_tokens: config.maxCallTokens,
      scope_call_limit: config.maxScopeCalls, scope_token_limit: config.maxScopeTokens },
    max_attempts: maxAttempts,
  };
  return { snapshot, attemptState: { revision: '1', current_candidate_index: 0,
    switch_count: 0, switches: [], active_call_id: null, active_candidate_index: null,
    active_turn_id: null, completed_turn_id: null, completed_call_id: null,
    last_failure: null, status: 'READY' } };
}

/**
 * 0128：一份「还没开始」的模型尝试状态。
 *
 * 子会话消息沿用主会话冻结的模型选择快照（同一个模型、同一份预算事实），但尝试状态
 * 必须从头开始——把主消息在途的 `active_call_id` 带过去，会让子执行的第一轮就撞上
 * 「这一轮已有调用在进行中」而永远无法开始。
 */
export function freshAssistModelAttemptState(): JsonObject {
  return { revision: '1', current_candidate_index: 0,
    switch_count: 0, switches: [], active_call_id: null, active_candidate_index: null,
    active_turn_id: null, completed_turn_id: null, completed_call_id: null,
    last_failure: null, status: 'READY' };
}

function candidateSnapshot(connection: AssistModelCandidateSnapshot['connection'], freeOnly: boolean,
  catalogBasis: AssistModelCandidateSnapshot['catalogBasis']): AssistModelCandidateSnapshot {
  return { connection, freeOnly, catalogBasis };
}

function isTextCandidate(entry: ModelCatalogEntryRow,
  requirements: { readonly requiresTools: boolean; readonly requiresJsonOutput: boolean },
  minimumContextWindow: number): boolean {
  return entry.is_free && entry.source_model_id.toLowerCase() !== 'openrouter/free' &&
    entry.capabilities.text_input === true && entry.capabilities.text_output === true &&
    entry.context_window !== null && entry.context_window >= minimumContextWindow &&
    (!requirements.requiresTools || entry.capabilities.tools === true) &&
    (!requirements.requiresJsonOutput || entry.capabilities.response_format === true);
}

function byModelId(a: ModelCatalogEntryRow, b: ModelCatalogEntryRow): number {
  return a.source_model_id < b.source_model_id ? -1 : a.source_model_id > b.source_model_id ? 1 : 0;
}
