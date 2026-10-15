import { sql } from 'kysely';
/** Reads committed refresh hints; migration triggers own their writes. */
export class RunEventRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async latestVisibleSeq(workspaceId, runId) {
        const result = await sql `
      select coalesce(max(event.seq), 0)::bigint as seq
      from runs as run
      left join run_events as event on event.run_id = run.id
      where run.id = ${runId} and run.workspace_id = ${workspaceId}
      group by run.id
    `.execute(this.db);
        return result.rows[0]?.seq ?? null;
    }
    async listAfter(runId, after, limit) {
        const result = await sql `
      select run_id, seq, kind, created_at
      from run_events
      where run_id = ${runId} and seq > ${after}
      order by seq
      limit ${limit}
    `.execute(this.db);
        return result.rows;
    }
}
