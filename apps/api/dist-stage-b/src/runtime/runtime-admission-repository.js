import { sql } from 'kysely';
export class RuntimeAdmissionUnavailableError extends Error {
    name = 'RuntimeAdmissionUnavailableError';
    constructor() { super('Runtime admission state is unavailable'); }
}
/** The migrator owns creation; application code can only read or CAS the singleton. */
export class RuntimeAdmissionRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async read(lock) {
        try {
            let originalTimeout;
            if (lock !== undefined) {
                const timeout = await sql `
          select current_setting('lock_timeout') as value,
            (extract(epoch from current_setting('lock_timeout')::interval) * 1000)::double precision as milliseconds
        `.execute(this.db);
                const current = timeout.rows[0];
                if (current.milliseconds === 0 || current.milliseconds > 5000) {
                    originalTimeout = current.value;
                    await sql `select set_config('lock_timeout', '5s', true)`.execute(this.db);
                }
            }
            const locking = lock === 'share' ? sql `for share` :
                lock === 'update' ? sql `for update` : sql ``;
            const result = await sql `
        select singleton, mode, revision from runtime_admission_gate
        where singleton = true ${locking}
      `.execute(this.db);
            const row = result.rows[0];
            if (row === undefined || !['NORMAL', 'DRAINING'].includes(row.mode)) {
                throw new RuntimeAdmissionUnavailableError();
            }
            if (originalTimeout !== undefined) {
                // Successful gate admission leaves subsequent business lock semantics
                // untouched. A failed query aborts the transaction and rolls back LOCAL.
                await sql `select set_config('lock_timeout', ${originalTimeout}, true)`.execute(this.db);
            }
            return row;
        }
        catch {
            // Never surface connection details or treat a missing gate as NORMAL.
            throw new RuntimeAdmissionUnavailableError();
        }
    }
    async compareAndSet(expectedRevision, mode) {
        const result = await sql `
      update runtime_admission_gate set mode = ${mode}, revision = revision + 1
      where singleton = true and revision = ${expectedRevision}
      returning singleton, mode, revision
    `.execute(this.db);
        return result.rows[0];
    }
}
