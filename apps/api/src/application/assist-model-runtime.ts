import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { ModelCallRepository } from '../model/model-call-repository.js';
import { parseAssistModelSnapshot } from './assist-model-snapshot.js';
import { resourceNotFound } from './domain-error.js';
import { createRepositories } from './unit-of-work.js';

/** Read projection only: message, frozen policy and existing ledger own every fact. */
export async function readAssistModelRuntime(db: DbExecutor, input: {
  readonly workspaceId: string; readonly messageId: string;
}) {
  return db.transaction().setIsolationLevel('repeatable read').execute((trx) => readProjection(trx, input));
}

async function readProjection(db: DbExecutor, input: { readonly workspaceId: string; readonly messageId: string }) {
  const repositories = createRepositories(db);
  const message = await repositories.assist.readMessage(input.messageId);
  const session = message === undefined ? undefined : await repositories.assist.readSession(message.session_id);
  if (message === undefined || session?.workspace_id !== input.workspaceId) throw resourceNotFound('Assist message');
  const snapshot = message.model_selection_snapshot === null ? undefined
    : parseAssistModelSnapshot(message.model_selection_snapshot);
  const state = message.model_attempt_state;
  const candidates = snapshot?.candidates.map((candidate) => candidate.connection.model) ?? [];
  const index = state?.current_candidate_index;
  const currentModel = typeof index === 'number' && Number.isInteger(index) ? candidates[index] ?? null : null;
  const calls = await new ModelCallRepository(db).listForAssistMessage(message.id);
  const failure = asObject(state?.last_failure);
  return {
    message_id: message.id, session_id: message.session_id, message_status: message.status,
    snapshot_available: snapshot !== undefined, preferred_model: candidates[0] ?? null,
    candidate_models: candidates, current_candidate_model: currentModel,
    actual_model: calls.at(-1)?.model ?? null, max_candidates: snapshot?.maxAttempts ?? null,
    routing_status: text(state, 'status'), revision: text(state, 'revision'),
    failure_scope: text(failure, 'scope'), failure_reason: text(failure, 'reason'),
    retry_after_at: text(failure, 'retry_after_at'),
    free_daily_remaining: typeof failure?.free_daily_remaining === 'number' ? failure.free_daily_remaining : null,
    switches: (Array.isArray(state?.switches) ? state.switches : []).map((value) => {
      const row = asObject(value);
      return { from_model: typeof row?.from_index === 'number' ? candidates[row.from_index] ?? null : null,
        to_model: typeof row?.to_index === 'number' ? candidates[row.to_index] ?? null : null,
        reason: text(row, 'reason'), scope: text(row, 'scope'), retry_after_at: text(row, 'retry_after_at'),
        switched_at: text(row, 'switched_at') };
    }),
    calls: calls.map((call) => ({ id: call.id, provider: call.provider, model: call.model,
      status: call.status, error_kind: call.error_kind, provider_request_id: call.provider_request_id,
      input_tokens: call.usage_input_tokens, output_tokens: call.usage_output_tokens,
      started_at: call.started_at.toISOString(), settled_at: call.settled_at?.toISOString() ?? null })),
  };
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function text(row: JsonObject | null, key: string): string | null {
  return typeof row?.[key] === 'string' ? row[key] as string : null;
}
