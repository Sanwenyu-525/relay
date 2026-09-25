import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { RunEventRow } from '../infrastructure/database-schema.js';

/** Reads committed refresh hints; migration triggers own their writes. */
export class RunEventRepository {
  constructor(private readonly db: DbExecutor) {}

  async latestVisibleSeq(workspaceId: string, runId: string): Promise<bigint | null> {
    const result = await sql<{ seq: bigint }>`
      select coalesce(max(event.seq), 0)::bigint as seq
      from runs as run
      left join run_events as event on event.run_id = run.id
      where run.id = ${runId} and run.workspace_id = ${workspaceId}
      group by run.id
    `.execute(this.db);
    return result.rows[0]?.seq ?? null;
  }

  async listAfter(runId: string, after: bigint, limit: number): Promise<readonly RunEventRow[]> {
    const result = await sql<RunEventRow>`
      select run_id, seq, kind, created_at
      from run_events
      where run_id = ${runId} and seq > ${after}
      order by seq
      limit ${limit}
    `.execute(this.db);
    return result.rows;
  }
}
