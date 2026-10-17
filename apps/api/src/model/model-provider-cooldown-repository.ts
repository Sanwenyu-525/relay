import { sql } from 'kysely';
import type { DbExecutor } from '../infrastructure/database.js';
import type { ModelProviderCooldownRow } from '../infrastructure/database-schema.js';

/** Persists only explicit, bounded Retry-After evidence; it owns no model-call facts. */
export class ModelProviderCooldownRepository {
  constructor(private readonly db: DbExecutor) {}

  async readActive(input: { scope: 'ACCOUNT' | 'MODEL'; modelId: string;
    configFingerprint: string; now: Date }): Promise<ModelProviderCooldownRow | undefined> {
    return (await sql<ModelProviderCooldownRow>`select * from model_provider_cooldowns
      where provider = 'openrouter' and scope = ${input.scope} and model_id = ${input.modelId}
        and config_fingerprint = ${input.configFingerprint} and retry_after_at > ${input.now}`
      .execute(this.db)).rows[0];
  }

  async record(input: { scope: 'ACCOUNT' | 'MODEL'; modelId: string;
    configFingerprint: string; retryAfterAt: Date;
    reason: ModelProviderCooldownRow['reason']; modelCallId: string; observedAt: Date }): Promise<void> {
    await sql`insert into model_provider_cooldowns
      (provider, scope, model_id, config_fingerprint, retry_after_at, reason, model_call_id, observed_at)
      values ('openrouter', ${input.scope}, ${input.modelId}, ${input.configFingerprint},
        ${input.retryAfterAt}, ${input.reason}, ${input.modelCallId}, ${input.observedAt})
      on conflict (provider, scope, model_id, config_fingerprint) do update set
        retry_after_at = excluded.retry_after_at,
        reason = excluded.reason,
        model_call_id = excluded.model_call_id,
        observed_at = excluded.observed_at
      where excluded.retry_after_at > model_provider_cooldowns.retry_after_at`.execute(this.db);
  }
}
