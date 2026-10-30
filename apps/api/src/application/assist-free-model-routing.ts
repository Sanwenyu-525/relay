import { createHash, randomUUID } from 'node:crypto';
import type { AssistMessageRow, AssistSessionRow, ModelCatalogEntryRow } from
  '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { ModelPortConfig } from '../workflow/model-port-config.js';
import { computeModelConfigFingerprint, readOpenRouterModelPortConfig } from
  '../workflow/model-port-config.js';
import { buildFreePriceGuard } from '../workflow/free-call-guard.js';
import { accountCooldownKey, compareCredentialIdentity, readCredentialFingerprint } from
  '../workflow/credential-identity.js';
import { readBoundedJson } from '../workflow/bounded-response.js';
import { OpenAiCompatibleModelPort } from '../workflow/openai-compatible-model-port.js';
import type { ModelFetchDependencies } from '../workflow/model-endpoint-policy.js';
import { readModelCatalogConfig } from '../workflow/model-catalog-config.js';
import type { AssistModelPort, AssistRequest, AssistResult, ModelIdentity, ModelToolTurn }
  from '../workflow/fake-model-port.js';
import { readProviderHttpStatus } from '../workflow/model-error-classification.js';
import { ModelCallRepository } from '../model/model-call-repository.js';
import { ModelProviderCooldownRepository } from '../model/model-provider-cooldown-repository.js';
import { syncModelCatalog } from './model-catalog-sync.js';
import { createOpenRouterCatalogSource } from '../workflow/openrouter-catalog-source.js';
import { contextUsageToJson, describeAssistRequestContext } from './assist-context-usage.js';
import { recordModelInvocation } from './model-call-recorder.js';
import { createRepositories } from './unit-of-work.js';
import { parseAssistModelSnapshot, snapshotIdentityBudget, type AssistModelCandidateSnapshot,
  type ParsedAssistModelSnapshot } from './assist-model-snapshot.js';
import type { JsonValue } from '../infrastructure/json.js';

/** 账户额度响应的字节上限：真实响应是几百字节的 JSON，64 KiB 足够且不给上游留放大空间。 */
const ACCOUNT_QUOTA_MAX_BYTES = 64 * 1024;

export interface AssistFreeModelRoutingContext {
  readonly db: DbExecutor;
  readonly message: AssistMessageRow;
  readonly session: AssistSessionRow;
  readonly workerId: string;
  readonly env: NodeJS.ProcessEnv;
  readonly defaultModelPort: AssistModelPort;
  readonly modelFetchDependencies?: ModelFetchDependencies;
}

/** True when this message was accepted under a concrete OpenRouter model plan. */
export function hasOpenRouterAssistSnapshot(message: AssistMessageRow): boolean {
  if (message.model_selection_snapshot === null) return false;
  const snapshot = parseAssistModelSnapshot(message.model_selection_snapshot);
  return snapshot.candidates[0]?.connection.provider === 'openrouter';
}

/**
 * Invoke one logical Assist turn using the message-frozen model plan. Each concrete model
 * request gets its own existing model_calls row. Only an explicit upstream 429 plus a
 * positive account free-daily balance advances the message's persistent candidate CAS.
 */
export async function invokeAssistWithFreeModelRouting(context: AssistFreeModelRoutingContext,
  request: AssistRequest,
  invoke?: (port: AssistModelPort, callId: string) => Promise<AssistResult>): Promise<AssistResult> {
  const { db, message, session, workerId } = context;
  const currentMessage = await createRepositories(db).assist.readMessage(message.id, 'share');
  if (currentMessage === undefined || currentMessage.status !== 'RUNNING' ||
      currentMessage.worker_id !== workerId || currentMessage.cancel_requested ||
      currentMessage.model_selection_snapshot === null || currentMessage.model_attempt_state === null) {
    throw new Error('ASSIST_MODEL_SNAPSHOT_MISSING');
  }
  const snapshot = parseAssistModelSnapshot(currentMessage.model_selection_snapshot);
  const initialState = parseAttemptState(currentMessage.model_attempt_state, snapshot);
  if (snapshot.candidates[0]?.connection.provider !== 'openrouter') {
    return context.defaultModelPort.assist(request);
  }

  const turnId = logicalTurnIdentity(request);
  let model = initialState.currentCandidateIndex;
  while (model < snapshot.candidates.length) {
    if (!await assistInvocationStillAllowed(context)) throw new Error('ASSIST_CANCELLED_BEFORE_MODEL_CALL');
    const current = await createRepositories(db).assist.readMessage(message.id, 'share');
    if (current?.status !== 'RUNNING' || current.worker_id !== workerId ||
        current.cancel_requested || current.model_attempt_state === null) {
      throw new Error('ASSIST_MODEL_CALL_NOT_ADMITTED');
    }
    const state = parseAttemptState(current.model_attempt_state, snapshot);
    if (state.status !== 'READY') throw new Error(`ASSIST_FREE_MODEL_ROUTING_${state.status}`);
    if (state.activeCallId !== null) {
      const previous = await new ModelCallRepository(db).read(state.activeCallId);
      throw new Error(previous?.status === 'STARTED'
        ? 'ASSIST_MODEL_CALL_OUTCOME_UNKNOWN' : 'ASSIST_MODEL_CALL_ALREADY_CLAIMED');
    }
    if (state.completedTurnId === turnId) throw new Error('ASSIST_MODEL_TURN_ALREADY_COMPLETED');
    model = state.currentCandidateIndex;
    const candidate = snapshot.candidates[model];
    if (candidate === undefined) break;
    const resolution = await resolveOpenRouterCandidate(context, snapshot, candidate);
    if (resolution.kind === 'INVALID') {
      // The preferred model cannot be silently replaced before it has an eligible
      // provider-level rejection. After an authorized switch, an expired, removed,
      // or capability-incompatible next candidate is skipped within the frozen plan.
      if (state.switchCount === 0 || state.lastFailure === null) {
        throw new Error('ASSIST_FREE_MODEL_NO_LONGER_ELIGIBLE');
      }
      const nextIndex = model + 1;
      if (!await advancePastCooldown(context, snapshot, state, nextIndex, state.lastFailure,
        'CANDIDATE_NO_LONGER_ELIGIBLE')) {
        throw new Error('ASSIST_MODEL_CANDIDATE_CAS_LOST');
      }
      if (nextIndex >= snapshot.candidates.length) {
        throw new Error('ASSIST_FREE_MODEL_CANDIDATES_EXHAUSTED');
      }
      model = nextIndex;
      continue;
    }
    if (resolution.kind === 'COOLDOWN') {
      const failure = cooldownFailure(candidate.connection.model, resolution.cooldown);
      if (resolution.cooldown.scope === 'ACCOUNT') {
        if (!await persistCooldownStop(context, state, failure)) {
          throw new Error('ASSIST_MODEL_CANDIDATE_CAS_LOST');
        }
        throw new Error('ASSIST_MODEL_ACCOUNT_COOLDOWN');
      }
      if (resolution.cooldown.reason === 'UPSTREAM_PROVIDER_RATE_LIMIT') {
        const config = readOpenRouterModelPortConfig(context.env, candidate.connection.model);
        const remaining = await readFreeDailyRemaining(config.apiKey,
          context.modelFetchDependencies?.fetch ?? fetch);
        const quotaFailure = cooldownFailure(candidate.connection.model, resolution.cooldown);
        const accountFailure = { ...quotaFailure,
          reason: remaining === undefined ? 'ACCOUNT_FREE_DAILY_UNKNOWN'
            : remaining === 0 ? 'ACCOUNT_FREE_DAILY_EXHAUSTED' : quotaFailure.reason,
          scope: remaining === undefined || remaining === 0 ? 'ACCOUNT' : quotaFailure.scope,
          observed_at: new Date().toISOString(), free_daily_remaining: remaining ?? null,
        } as import('../infrastructure/json.js').JsonObject;
        if (remaining === undefined || remaining === 0) {
          await persistKnownCooldown(context, config, { fallbackAllowed: false, state: accountFailure });
          if (!await persistCooldownStop(context, state, accountFailure)) {
            throw new Error('ASSIST_MODEL_CANDIDATE_CAS_LOST');
          }
          throw new Error(remaining === undefined
            ? 'ASSIST_MODEL_ACCOUNT_QUOTA_UNKNOWN' : 'ASSIST_MODEL_ACCOUNT_QUOTA_EXHAUSTED');
        }
      }
      const nextIndex = model + 1;
      if (!await advancePastCooldown(context, snapshot, state, nextIndex, failure)) {
        throw new Error('ASSIST_MODEL_CANDIDATE_CAS_LOST');
      }
      if (nextIndex >= snapshot.candidates.length) throw new Error('ASSIST_FREE_MODEL_COOLDOWN');
      model = nextIndex;
      continue;
    }
    const resolved = resolution.value;

    const callId = randomUUID();
    const reservedState = await reserveCandidateCall(context, snapshot, state, model, callId, turnId);
    if (reservedState === undefined) throw new Error('ASSIST_MODEL_CALL_CAS_LOST');
    let firstTextDeltaRecorded = false;
    const invocationRequest: AssistRequest = { ...request,
      onTextDelta: async (piece) => {
        if (piece !== '' && !firstTextDeltaRecorded) {
          firstTextDeltaRecorded = true;
          await new ModelCallRepository(db).recordFirstTextDelta(callId, new Date());
        }
        await request.onTextDelta?.(piece);
      },
      onStreamEvent: async () => {
        await new ModelCallRepository(db).recordFirstStreamEvent(callId, new Date());
        await request.onStreamEvent?.();
      } };
    try {
      const recorded = await recordModelInvocation<AssistResult>(db, {
        callId,
        origin: { workspaceId: session.workspace_id, kind: 'ASSIST', assistMessageId: message.id },
        contextUsage: contextUsageToJson(describeAssistRequestContext(request)),
        identity: resolved.port.identity,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        invoke: async (id) => {
          if (id !== callId) throw new Error('ASSIST_MODEL_CALL_ID_MISMATCH');
          return invoke === undefined ? resolved.port.assist(invocationRequest)
            : invoke(resolved.port, id);
        },
        settle: (result) => result.kind === 'CANCELLED'
          ? { status: 'CANCELLED', providerRequestId: result.providerRequestId ?? null,
            ...(result.usage === undefined ? {} : { usage: result.usage }) }
          : { status: 'COMPLETED', providerRequestId: result.providerRequestId,
            usage: result.usage },
      });
      const completed = { ...reservedState,
        revision: (BigInt(reservedState.revision) + 1n).toString(),
        activeCallId: null, activeCandidateIndex: null, activeTurnId: null,
        completedTurnId: turnId, completedCallId: callId };
      if (!await persistAttemptState(context, snapshot, reservedState, completed, callId)) {
        throw new Error('ASSIST_MODEL_CALL_SETTLEMENT_CAS_LOST');
      }
      return recorded.result;
    } catch (error) {
      if (!await assistInvocationStillAllowed(context)) throw error;
      const failure = await assessRateLimitFailure(context, resolved.config, error, callId,
        candidate.connection.model, isPortableToolHistory(request.toolTurns ?? []));
      if (failure === undefined) {
        const stopped = await nonFallbackFailure(context, callId, candidate.connection.model, error);
        if (!await persistStoppedCall(context, snapshot, reservedState, callId, stopped)) {
          throw new Error('ASSIST_MODEL_CALL_SETTLEMENT_CAS_LOST');
        }
        throw error;
      }
      await persistKnownCooldown(context, resolved.config, failure);
      if (!failure.fallbackAllowed) {
        if (!await persistStoppedCall(context, snapshot, reservedState, callId, failure.state)) {
          throw new Error('ASSIST_MODEL_CALL_SETTLEMENT_CAS_LOST');
        }
        throw error;
      }
      const nextIndex = model + 1;
      const advanced = await advanceCandidate(context, snapshot, reservedState, nextIndex,
        callId, turnId, failure.state);
      if (!advanced) throw new Error('ASSIST_MODEL_CANDIDATE_CAS_LOST');
      if (nextIndex === snapshot.candidates.length) {
        throw new Error('ASSIST_FREE_MODEL_CANDIDATES_EXHAUSTED');
      }
      model = nextIndex;
    }
  }
  throw new Error('ASSIST_FREE_MODEL_CANDIDATES_EXHAUSTED');
}

async function resolveOpenRouterCandidate(context: AssistFreeModelRoutingContext,
  snapshot: ParsedAssistModelSnapshot, candidate: AssistModelCandidateSnapshot):
  Promise<CandidateResolution> {
  const config = readOpenRouterModelPortConfig(context.env, candidate.connection.model);
  if (computeModelConfigFingerprint(config) !== candidate.connection.configFingerprint) {
    throw new Error('ASSIST_MODEL_CONFIG_CHANGED');
  }
  // 0142：免费连接换 Key 后不能继续用旧冻结身份外呼——换账户会绕过账户级额度与冷却。
  if (compareCredentialIdentity(context.message.model_credential_fingerprint,
    readCredentialFingerprint(config)) === 'CHANGED') {
    throw new Error('ASSIST_MODEL_CREDENTIAL_CHANGED');
  }
  const cooldowns = new ModelProviderCooldownRepository(context.db);
  // 0142：账户级冷却按**真实凭据身份**取键。固定指纹会让 A 账户的限流挡住独立的
  // B 账户；按凭据取键后，同一账户重启仍命中同一行，不同账户互不影响。
  const accountCooldown = await cooldowns.readActive({ scope: 'ACCOUNT', modelId: '',
    configFingerprint: accountCooldownKey(readCredentialFingerprint(config)),
    now: new Date() });
  if (accountCooldown !== undefined) return { kind: 'COOLDOWN', cooldown: accountCooldown };
  const modelCooldown = await cooldowns.readActive({ scope: 'MODEL',
    modelId: candidate.connection.model,
    configFingerprint: candidate.connection.configFingerprint, now: new Date() });
  if (modelCooldown !== undefined) return { kind: 'COOLDOWN', cooldown: modelCooldown };
  const catalogConfig = readModelCatalogConfig(context.env);
  const repositories = createRepositories(context.db);
  if (catalogConfig === undefined) return { kind: 'INVALID' };
  let syncState = await repositories.modelCatalog.readSyncState();
  if (syncState.last_success_at === null ||
      Date.now() - syncState.last_success_at.getTime() >= catalogConfig.cacheTtlMs) {
    await syncModelCatalog({ db: context.db, env: context.env, trigger: 'open',
      source: createOpenRouterCatalogSource(catalogConfig, context.modelFetchDependencies) });
    syncState = await repositories.modelCatalog.readSyncState();
    if (syncState.last_success_at === null ||
        Date.now() - syncState.last_success_at.getTime() >= catalogConfig.cacheTtlMs) {
      return { kind: 'INVALID' };
    }
  }
  const entry = await repositories.modelCatalog.readEntryBySourceModelId(candidate.connection.model);
  if (!isCurrentlyEligible(entry, snapshot)) return { kind: 'INVALID' };
  const port = new OpenAiCompatibleModelPort(config, context.modelFetchDependencies,
    buildFreePriceGuard({ connection: candidate.connection, freeOnly: true,
      catalogBasis: candidate.catalogBasis, budget: snapshot.budget }),
    snapshotIdentityBudget(snapshot.budget));
  return { kind: 'READY', value: { port, config } };
}

type CandidateResolution =
  | { readonly kind: 'READY'; readonly value: {
    readonly port: OpenAiCompatibleModelPort; readonly config: ModelPortConfig } }
  | { readonly kind: 'INVALID' }
  | { readonly kind: 'COOLDOWN'; readonly cooldown: import('../infrastructure/database-schema.js').ModelProviderCooldownRow };

function isCurrentlyEligible(entry: ModelCatalogEntryRow | undefined,
  snapshot: ParsedAssistModelSnapshot): boolean {
  if (entry === undefined || !entry.is_free || entry.source_model_id.toLowerCase() === 'openrouter/free' ||
      entry.capabilities.text_input !== true || entry.capabilities.text_output !== true ||
      entry.context_window === null || entry.context_window < snapshot.requirements.minimumContextWindow) {
    return false;
  }
  return (!snapshot.requirements.requiresTools || entry.capabilities.tools === true) &&
    (!snapshot.requirements.requiresJsonOutput || entry.capabilities.response_format === true);
}

interface RateLimitFailure {
  readonly fallbackAllowed: boolean;
  readonly state: import('../infrastructure/json.js').JsonObject;
}

async function assessRateLimitFailure(context: AssistFreeModelRoutingContext,
  config: ModelPortConfig, error: unknown, callId: string, model: string,
  portableToolHistory: boolean): Promise<RateLimitFailure | undefined> {
  if (readProviderHttpStatus(error) !== 429) return undefined;
  const call = await new ModelCallRepository(context.db).read(callId);
  if (call === undefined || call.status !== 'FAILED') return undefined;
  const observedAt = new Date();
  const retryAfterAt = readRetryAfterAt(error, observedAt);
  const platformLimited = hasPlatformRateLimitHeaders(error);
  const structuredUpstream = hasStructuredUpstreamRateLimit(error);
  let reason: string;
  let scope: string;
  let remaining: number | null = null;
  let fallbackAllowed = false;
  if (platformLimited) {
    reason = 'PLATFORM_RATE_LIMIT'; scope = 'ACCOUNT';
  } else if (!structuredUpstream) {
    reason = 'RATE_LIMIT_ORIGIN_UNKNOWN'; scope = 'UNKNOWN';
  } else if (call.first_stream_event_at !== null || call.first_text_delta_at !== null) {
    reason = 'PARTIAL_STREAM'; scope = 'UPSTREAM_PROVIDER';
  } else if (!portableToolHistory) {
    reason = 'NON_PORTABLE_TOOL_HISTORY'; scope = 'UPSTREAM_PROVIDER';
  } else {
    const accountRemaining = await readFreeDailyRemaining(config.apiKey,
      context.modelFetchDependencies?.fetch ?? fetch);
    remaining = accountRemaining ?? null;
    if (accountRemaining === undefined) {
      reason = 'ACCOUNT_FREE_DAILY_UNKNOWN'; scope = 'ACCOUNT';
    } else if (accountRemaining <= 0) {
      reason = 'ACCOUNT_FREE_DAILY_EXHAUSTED'; scope = 'ACCOUNT';
    } else {
      reason = 'UPSTREAM_PROVIDER_RATE_LIMIT'; scope = 'UPSTREAM_PROVIDER';
      fallbackAllowed = true;
    }
  }
  return { fallbackAllowed, state: { model, model_call_id: callId, reason, scope,
    observed_at: observedAt.toISOString(), retry_after_at: retryAfterAt?.toISOString() ?? null,
    free_daily_remaining: remaining } };
}

async function nonFallbackFailure(context: AssistFreeModelRoutingContext, callId: string,
  model: string, error: unknown): Promise<import('../infrastructure/json.js').JsonObject> {
  const call = await new ModelCallRepository(context.db).read(callId);
  const status = readProviderHttpStatus(error);
  const reason = call !== undefined && (call.first_stream_event_at !== null ||
    call.first_text_delta_at !== null) ? 'PARTIAL_STREAM'
    : status === 429 ? 'RATE_LIMIT_ORIGIN_UNKNOWN'
      : status === 401 || status === 403 ? 'PROVIDER_AUTH_REJECTED'
        : error instanceof Error && error.name === 'ModelCallBudgetError'
          ? 'BUDGET_LIMIT' : 'MODEL_CALL_FAILED';
  const observedAt = new Date();
  return { model, model_call_id: callId, reason, scope: 'UNKNOWN',
    observed_at: observedAt.toISOString(),
    retry_after_at: readRetryAfterAt(error, observedAt)?.toISOString() ?? null,
    free_daily_remaining: null };
}

export function hasStructuredUpstreamRateLimit(error: unknown): boolean {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    chain.push(current);
    const cause = (current as { cause?: unknown }).cause;
    if (cause === undefined || cause === current) break;
    current = cause;
  }
  if (chain.some((item) => {
    if (typeof item !== 'object' || item === null) return false;
    return hasRateLimitHeaders((item as { headers?: unknown }).headers);
  })) return false;
  return chain.some((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const value = item as { error?: unknown };
    const body = asObject(value.error);
    const metadata = asObject(body?.metadata);
    const providerCode = metadata?.provider_code;
    const isProvider429 = providerCode === 429 ||
      typeof providerCode === 'string' && /^429$/u.test(providerCode.trim());
    return isProvider429 && metadata?.error_type === 'rate_limit_exceeded';
  });
}

function hasPlatformRateLimitHeaders(error: unknown): boolean {
  return errorChain(error).some((item) => {
    if (typeof item !== 'object' || item === null) return false;
    return hasRateLimitHeaders((item as { headers?: unknown }).headers);
  });
}

function hasRateLimitHeaders(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const headers = value as { forEach?: (callback: (value: string, name: string) => void) => void;
    get?: (name: string) => string | null };
  if (typeof headers.get === 'function') {
    for (const name of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
      if (headers.get(name) !== null) return true;
    }
  }
  if (typeof headers.forEach === 'function') {
    let found = false;
    headers.forEach((_entry, name) => { if (name.toLowerCase().startsWith('x-ratelimit-')) found = true; });
    return found;
  }
  if (Object.keys(value).some((key) => key.toLowerCase().startsWith('x-ratelimit-'))) return true;
  return false;
}

function readRetryAfterAt(error: unknown, now: Date): Date | null {
  const values: Date[] = [];
  for (const item of errorChain(error)) {
    if (typeof item !== 'object' || item === null) continue;
    const headers = (item as { headers?: unknown }).headers;
    const raw = readHeader(headers, 'retry-after');
    if (raw === null) continue;
    const seconds = /^\d{1,8}$/u.test(raw.trim()) ? Number(raw.trim()) : undefined;
    const time = seconds === undefined ? Date.parse(raw) : now.getTime() + seconds * 1_000;
    if (!Number.isFinite(time) || time <= now.getTime() || time - now.getTime() > 30 * 86_400_000) continue;
    values.push(new Date(time));
  }
  return values.sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
}

function readHeader(value: unknown, name: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const headers = value as { get?: (name: string) => string | null };
  if (typeof headers.get === 'function') return headers.get(name);
  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase() === name && typeof item === 'string') return item;
  }
  return null;
}

async function readFreeDailyRemaining(apiKey: string, fetchImpl: typeof fetch): Promise<number | undefined> {
  try {
    const response = await fetchImpl('https://openrouter.ai/api/v1/key', {
      method: 'GET', headers: { authorization: `Bearer ${apiKey}` },
      redirect: 'error', signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    // P1-2：流式读取过程中就执行字节上限，超限立即取消；不再先 text() 再判长度。
    const root = asObject(await readBoundedJson(response, ACCOUNT_QUOTA_MAX_BYTES));
    const data = asObject(root?.data);
    const free = asObject(data?.free_model_daily_requests);
    const remaining = free?.remaining;
    return typeof remaining === 'number' && Number.isSafeInteger(remaining) && remaining >= 0
      ? remaining : undefined;
  } catch {
    return undefined;
  }
}

async function persistKnownCooldown(context: AssistFreeModelRoutingContext,
  config: ModelPortConfig, failure: RateLimitFailure): Promise<void> {
  const retryValue = failure.state.retry_after_at;
  const callId = failure.state.model_call_id;
  const model = failure.state.model;
  const reason = failure.state.reason;
  const scope = failure.state.scope;
  if (typeof retryValue !== 'string' || typeof callId !== 'string' ||
      typeof model !== 'string' || typeof reason !== 'string' || typeof scope !== 'string') return;
  const retryAfterAt = new Date(retryValue);
  if (!Number.isFinite(retryAfterAt.getTime()) || retryAfterAt <= new Date()) return;
  if (scope === 'UPSTREAM_PROVIDER' && reason === 'UPSTREAM_PROVIDER_RATE_LIMIT') {
    await new ModelProviderCooldownRepository(context.db).record({ scope: 'MODEL', modelId: model,
      configFingerprint: computeModelConfigFingerprint(config), retryAfterAt, reason,
      modelCallId: callId, observedAt: new Date(String(failure.state.observed_at)) });
  } else if (scope === 'ACCOUNT' && (reason === 'PLATFORM_RATE_LIMIT' ||
      reason === 'ACCOUNT_FREE_DAILY_EXHAUSTED')) {
    await new ModelProviderCooldownRepository(context.db).record({ scope: 'ACCOUNT', modelId: '',
      configFingerprint: accountCooldownKey(readCredentialFingerprint(config)),
      retryAfterAt, reason, modelCallId: callId,
      observedAt: new Date(String(failure.state.observed_at)) });
  }
}

function cooldownFailure(model: string,
  cooldown: import('../infrastructure/database-schema.js').ModelProviderCooldownRow):
  import('../infrastructure/json.js').JsonObject {
  return { model, model_call_id: cooldown.model_call_id, reason: cooldown.reason,
    scope: cooldown.scope === 'ACCOUNT' ? 'ACCOUNT' : 'UPSTREAM_PROVIDER',
    observed_at: cooldown.observed_at.toISOString(), retry_after_at: cooldown.retry_after_at.toISOString(),
    free_daily_remaining: null };
}

/**
 * 0142：账户级冷却键由 `credential-identity.accountCooldownKey` 派生（按真实凭据身份），
 * 不再使用「全实例同一个固定指纹」——那会让一个账户的限流挡住另一个独立账户。
 */

async function advanceCandidate(context: AssistFreeModelRoutingContext,
  snapshot: ParsedAssistModelSnapshot, reservedState: ParsedAttemptState, nextIndex: number,
  callId: string, turnId: string, failure: import('../infrastructure/json.js').JsonObject): Promise<boolean> {
  const expectedIndex = reservedState.currentCandidateIndex;
  if (nextIndex < expectedIndex + 1 || nextIndex > snapshot.candidates.length) return false;
  const current = await createRepositories(context.db).assist.readMessage(context.message.id, 'share');
  if (current === undefined || current.status !== 'RUNNING' || current.worker_id !== context.workerId ||
      current.cancel_requested || current.model_attempt_state === null) return false;
  const state = parseAttemptState(current.model_attempt_state, snapshot);
  if (state.currentCandidateIndex !== expectedIndex || state.revision !== reservedState.revision ||
      state.activeCallId !== callId || state.activeTurnId !== turnId) return false;
  const changedModel = nextIndex < snapshot.candidates.length;
  const nextState = {
    revision: (BigInt(state.revision) + 1n).toString(),
    current_candidate_index: changedModel ? nextIndex : expectedIndex,
    switch_count: state.switchCount + (changedModel ? 1 : 0),
    switches: changedModel ? [...state.switches, { from_index: expectedIndex, to_index: nextIndex,
      reason: failure.reason, scope: failure.scope, retry_after_at: failure.retry_after_at,
      model_call_id: callId,
      switched_at: new Date().toISOString() }] : state.switches,
    active_call_id: null, active_candidate_index: null, active_turn_id: null,
    completed_turn_id: state.completedTurnId, completed_call_id: state.completedCallId,
    last_failure: failure, status: changedModel ? 'READY' : 'EXHAUSTED',
  } as unknown as import('../infrastructure/json.js').JsonObject;
  return createRepositories(context.db).assist.advanceModelCandidate({ messageId: context.message.id,
    workerId: context.workerId, expectedRevision: state.revision, expectedIndex,
    activeCallId: callId, nextState });
}

async function advancePastCooldown(context: AssistFreeModelRoutingContext,
  snapshot: ParsedAssistModelSnapshot, state: ParsedAttemptState, nextIndex: number,
  failure: import('../infrastructure/json.js').JsonObject,
  switchReason: string = typeof failure.reason === 'string' ? failure.reason : 'COOLDOWN'):
  Promise<boolean> {
  if (state.activeCallId !== null || nextIndex !== state.currentCandidateIndex + 1 ||
      nextIndex > snapshot.candidates.length) return false;
  const current = await createRepositories(context.db).assist.readMessage(context.message.id, 'share');
  if (current === undefined || current.status !== 'RUNNING' || current.worker_id !== context.workerId ||
      current.cancel_requested || current.model_attempt_state === null) return false;
  const latest = parseAttemptState(current.model_attempt_state, snapshot);
  if (latest.status !== 'READY' || latest.revision !== state.revision ||
      latest.currentCandidateIndex !== state.currentCandidateIndex || latest.activeCallId !== null) return false;
  const changedModel = nextIndex < snapshot.candidates.length;
  const nextState = {
    revision: (BigInt(latest.revision) + 1n).toString(),
    current_candidate_index: changedModel ? nextIndex : latest.currentCandidateIndex,
    switch_count: latest.switchCount + (changedModel ? 1 : 0),
    switches: changedModel ? [...latest.switches, { from_index: latest.currentCandidateIndex,
      to_index: nextIndex, reason: switchReason, scope: failure.scope,
      retry_after_at: failure.retry_after_at, model_call_id: failure.model_call_id,
      switched_at: new Date().toISOString() }] : latest.switches,
    active_call_id: null, active_candidate_index: null, active_turn_id: null,
    completed_turn_id: latest.completedTurnId, completed_call_id: latest.completedCallId,
    last_failure: failure, status: changedModel ? 'READY' : 'COOLDOWN',
  } as unknown as import('../infrastructure/json.js').JsonObject;
  return createRepositories(context.db).assist.advanceModelCandidate({
    messageId: context.message.id, workerId: context.workerId,
    expectedRevision: latest.revision, expectedIndex: latest.currentCandidateIndex,
    activeCallId: null, nextState,
  });
}

async function persistCooldownStop(context: AssistFreeModelRoutingContext,
  state: ParsedAttemptState,
  failure: import('../infrastructure/json.js').JsonObject): Promise<boolean> {
  if (state.activeCallId !== null) return false;
  const nextState = {
    revision: (BigInt(state.revision) + 1n).toString(),
    current_candidate_index: state.currentCandidateIndex, switch_count: state.switchCount,
    switches: state.switches, active_call_id: null, active_candidate_index: null,
    active_turn_id: null, completed_turn_id: state.completedTurnId,
    completed_call_id: state.completedCallId, last_failure: failure, status: 'COOLDOWN',
  } as unknown as import('../infrastructure/json.js').JsonObject;
  return createRepositories(context.db).assist.advanceModelCandidate({
    messageId: context.message.id, workerId: context.workerId,
    expectedRevision: state.revision, expectedIndex: state.currentCandidateIndex,
    activeCallId: null, nextState,
  });
}

async function reserveCandidateCall(context: AssistFreeModelRoutingContext,
  snapshot: ParsedAssistModelSnapshot, state: ParsedAttemptState, model: number,
  callId: string, turnId: string): Promise<ParsedAttemptState | undefined> {
  if (state.currentCandidateIndex !== model || state.status !== 'READY' ||
      state.activeCallId !== null || state.completedTurnId === turnId) return undefined;
  const next = {
    revision: (BigInt(state.revision) + 1n).toString(),
    current_candidate_index: model, switch_count: state.switchCount,
    switches: state.switches, active_call_id: callId, active_candidate_index: model,
    active_turn_id: turnId, completed_turn_id: state.completedTurnId,
    completed_call_id: state.completedCallId, last_failure: state.lastFailure, status: 'READY',
  } as unknown as import('../infrastructure/json.js').JsonObject;
  if (!await createRepositories(context.db).assist.reserveModelCall({
    messageId: context.message.id, workerId: context.workerId,
    expectedRevision: state.revision, expectedIndex: model, callId, turnId, nextState: next,
  })) return undefined;
  return parseAttemptState(next, snapshot);
}

async function persistAttemptState(context: AssistFreeModelRoutingContext,
  snapshot: ParsedAssistModelSnapshot, current: ParsedAttemptState, next: ParsedAttemptState,
  activeCallId: string): Promise<boolean> {
  if (current.activeCallId !== activeCallId || current.activeTurnId === null) return false;
  const json = toAttemptStateJson(next);
  return createRepositories(context.db).assist.finishModelCall({
    messageId: context.message.id, workerId: context.workerId,
    expectedRevision: current.revision, expectedIndex: current.currentCandidateIndex,
    callId: activeCallId, nextState: json,
  });
}

async function persistStoppedCall(context: AssistFreeModelRoutingContext,
  snapshot: ParsedAssistModelSnapshot, reservedState: ParsedAttemptState, callId: string,
  failure: import('../infrastructure/json.js').JsonObject): Promise<boolean> {
  const stopped: ParsedAttemptState = { ...reservedState,
    revision: (BigInt(reservedState.revision) + 1n).toString(),
    activeCallId: null, activeCandidateIndex: null, activeTurnId: null,
    lastFailure: failure, status: 'STOPPED' };
  return persistAttemptState(context, snapshot, reservedState, stopped, callId);
}

function toAttemptStateJson(state: ParsedAttemptState): import('../infrastructure/json.js').JsonObject {
  return { revision: state.revision, current_candidate_index: state.currentCandidateIndex,
    switch_count: state.switchCount, switches: [...state.switches],
    active_call_id: state.activeCallId, active_candidate_index: state.activeCandidateIndex,
    active_turn_id: state.activeTurnId, completed_turn_id: state.completedTurnId,
    completed_call_id: state.completedCallId, last_failure: state.lastFailure,
    status: state.status };
}

async function assistInvocationStillAllowed(context: AssistFreeModelRoutingContext): Promise<boolean> {
  const message = await createRepositories(context.db).assist.readMessage(context.message.id, 'share');
  return message?.status === 'RUNNING' && message.worker_id === context.workerId &&
    message.cancel_requested === false;
}

interface ParsedAttemptState {
  readonly revision: string;
  readonly currentCandidateIndex: number;
  readonly switchCount: number;
  readonly switches: readonly JsonValue[];
  readonly activeCallId: string | null;
  readonly activeCandidateIndex: number | null;
  readonly activeTurnId: string | null;
  readonly completedTurnId: string | null;
  readonly completedCallId: string | null;
  readonly lastFailure: import('../infrastructure/json.js').JsonObject | null;
  readonly status: 'READY' | 'EXHAUSTED' | 'STOPPED' | 'COOLDOWN';
}

function parseAttemptState(value: import('../infrastructure/json.js').JsonObject,
  snapshot: ParsedAssistModelSnapshot): ParsedAttemptState {
  const revision = value.revision;
  const index = value.current_candidate_index;
  const switchCount = value.switch_count;
  const switches = value.switches;
  const activeCallId = value.active_call_id;
  const activeCandidateIndex = value.active_candidate_index;
  const activeTurnId = value.active_turn_id;
  const completedTurnId = value.completed_turn_id;
  const completedCallId = value.completed_call_id;
  const lastFailureValue = value.last_failure;
  const lastFailureObject = lastFailureValue === undefined || lastFailureValue === null
    ? null : asObject(lastFailureValue);
  const status = value.status;
  if (typeof revision !== 'string' || !/^[1-9][0-9]*$/u.test(revision) ||
      typeof index !== 'number' || !Number.isInteger(index) || index < 0 ||
      index > snapshot.candidates.length || typeof switchCount !== 'number' ||
      !Number.isInteger(switchCount) || switchCount < 0 || switchCount > snapshot.candidates.length - 1 ||
      !Array.isArray(switches) || switches.length !== switchCount ||
      (status !== 'READY' && status !== 'EXHAUSTED' && status !== 'STOPPED' && status !== 'COOLDOWN') ||
      lastFailureValue !== undefined && lastFailureValue !== null && lastFailureObject === undefined ||
      activeCallId !== null && (typeof activeCallId !== 'string' || activeCallId.length > 64) ||
      activeCandidateIndex !== null && (typeof activeCandidateIndex !== 'number' ||
        !Number.isInteger(activeCandidateIndex) || activeCandidateIndex !== index) ||
      activeTurnId !== null && (typeof activeTurnId !== 'string' || !/^[a-f0-9]{64}$/u.test(activeTurnId)) ||
      completedTurnId !== null && (typeof completedTurnId !== 'string' || !/^[a-f0-9]{64}$/u.test(completedTurnId)) ||
      completedCallId !== null && (typeof completedCallId !== 'string' || completedCallId.length > 64) ||
      (activeCallId === null) !== (activeCandidateIndex === null) ||
      (activeCallId === null) !== (activeTurnId === null)) {
    throw new Error('ASSIST_MODEL_ATTEMPT_STATE_INVALID');
  }
  return { revision, currentCandidateIndex: index, switchCount, switches: switches as JsonValue[],
    activeCallId: activeCallId as string | null,
    activeCandidateIndex: activeCandidateIndex as number | null,
    activeTurnId: activeTurnId as string | null,
    completedTurnId: completedTurnId as string | null,
    completedCallId: completedCallId as string | null,
    lastFailure: lastFailureObject as import('../infrastructure/json.js').JsonObject | null,
    status: status as ParsedAttemptState['status'] };
}

function logicalTurnIdentity(request: AssistRequest): string {
  return createHash('sha256').update(JSON.stringify({ intent: request.intent,
    system: request.system, turns: request.turns, tools: request.tools ?? [],
    tool_turns: request.toolTurns ?? [], skill: request.skill ?? null,
    learning: request.learning ?? null }), 'utf8').digest('hex');
}

function isPortableToolHistory(turns: readonly ModelToolTurn[]): boolean {
  return turns.every((turn) => turn.reasoningContent === undefined &&
    turn.calls.length > 0 && turn.calls.length === turn.results.length &&
    turn.calls.every((call, index) => call.providerToolCallId === turn.results[index]?.providerToolCallId));
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current) && chain.length < 8) {
    seen.add(current);
    chain.push(current);
    if (typeof current !== 'object') break;
    const cause = (current as { cause?: unknown }).cause;
    current = Array.isArray(cause) ? cause[0] : cause;
  }
  return chain;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
