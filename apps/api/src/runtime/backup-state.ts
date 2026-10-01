import { createHash } from 'node:crypto';
import { Client, type QueryResultRow } from 'pg';

import type { JsonObject } from '../infrastructure/json.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { inspectFrozenSkillSnapshot, type FirstPartyRegistryArchive } from '../skills/first-party-registry.js';
import { managedContentRef } from '../storage/managed-content-store.js';
import type { BackupDataFile } from './backup-files.js';
import { postgresBackupEnvironment } from './backup-postgres.js';
import type { StoppedDesktopLaunch } from './desktop-maintenance-session.js';

const MAX_ROWS = 100_000;
const MAX_BYTES = 16 * 1024 * 1024;
export class BackupStateError extends Error {
  override readonly name = 'BackupStateError';
  constructor(readonly code = 'BACKUP_STATE_UNAVAILABLE') { super(code); }
}
type Fact = Record<string, string | null>;
export interface BackupArtifactReference {
  readonly id: string; readonly artifact_id: string; readonly storage_ref: string;
  readonly sha256: string; readonly size: string;
}
export interface BackupDatabaseState {
  readonly target: Fact;
  readonly admission: { readonly mode: 'DRAINING'; readonly revision: string };
  readonly migrations: readonly { readonly name: string; readonly sha256: string }[];
  readonly graph_versions: readonly number[];
  readonly artifacts: readonly BackupArtifactReference[];
  readonly workers: readonly Fact[];
  readonly unresolved_effects: readonly Fact[];
  readonly unresolved_operations: readonly Fact[];
  readonly unresolved_invocations: readonly Fact[];
  readonly unresolved_model_calls: readonly Fact[];
  readonly external_resources: readonly Fact[];
  readonly stored_skills: readonly { readonly message_id: string;
    readonly id: string; readonly version: string; readonly sha256: string }[];
  readonly stored_packs: readonly { readonly proposal_id: string;
    readonly id: string; readonly version: string; readonly sha256: string }[];
}

const hash = (value: unknown) => createHash('sha256')
  .update(canonicalizeJson(value as JsonObject)).digest('hex');
export const backupStateSha256 = hash;

/** A controlled read-only connection. Caller checks the fence before and after this connection. */
export async function readBackupDatabaseState(input: {
  migrationUrl: string; registry: FirstPartyRegistryArchive;
  resourceHashes: Readonly<Record<string, string>>;
  signal: AbortSignal; assertHeld: () => Promise<void>;
}): Promise<BackupDatabaseState> {
  let environment: NodeJS.ProcessEnv;
  try { environment = postgresBackupEnvironment(input.migrationUrl); }
  catch { throw new BackupStateError('BACKUP_STATE_TARGET_INVALID'); }
  const client = new Client({ host: environment.PGHOST!, port: Number(environment.PGPORT), user: environment.PGUSER!,
    database: environment.PGDATABASE!, password: async () => environment.PGPASSWORD ?? '',
    ssl: false, options: '-c default_transaction_read_only=on', client_encoding: 'UTF8',
    application_name: 'relay-backup-state', connectionTimeoutMillis: 5000,
    query_timeout: 6000, statement_timeout: 5000, lock_timeout: 5000 });
  let lost = false;
  client.on('error', () => { lost = true; });
  async function rows<T extends QueryResultRow>(sql: string): Promise<T[]> {
    input.signal.throwIfAborted();
    await input.assertHeld();
    if (lost) throw new Error();
    const result = await client.query<T>(sql);
    if (result.rows.length > MAX_ROWS) throw new BackupStateError('BACKUP_STATE_LIMIT');
    input.signal.throwIfAborted();
    return result.rows;
  }
  try {
    input.signal.throwIfAborted();
    await client.connect();
    await client.query('begin isolation level repeatable read read only');
    const target = (await rows<Fact>(`select current_database() as database,
      d.oid::text as database_oid, d.datdba::text as owner_oid,
      inet_server_addr()::text as server_address, inet_server_port()::text as server_port,
      current_setting('server_version_num') as server_version_num
      from pg_database d where d.datname=current_database()
      and session_user='relay_migrator' and current_user='relay_migrator'`))[0];
    if (target === undefined || target.server_address === null ||
        !/^18\d{4}$/u.test(target.server_version_num ?? '')) throw new BackupStateError('BACKUP_STATE_TARGET_INVALID');
    const admission = (await rows<{ mode: string; revision: string }>(
      'select mode,revision::text from public.runtime_admission_gate where singleton=true'))[0];
    if (admission?.mode !== 'DRAINING') throw new BackupStateError('BACKUP_STATE_DRAIN_REQUIRED');
    const migrations = await rows<{ name: string; sha256: string }>(
      "select name,encode(content_sha256,'hex') as sha256 from public.relay_schema_migrations order by name limit 100001");
    const packaged = Object.keys(input.resourceHashes).filter(ref => /^api\/migrations\/\d{4}_[a-z0-9_]+\.sql$/u.test(ref)).sort();
    if (migrations.length === 0 || migrations.length !== packaged.length || migrations.some((entry, index) =>
      packaged[index] !== `api/migrations/${entry.name}.sql` || input.resourceHashes[packaged[index]!] !== entry.sha256)) {
      throw new BackupStateError('BACKUP_STATE_SCHEMA_MISMATCH');
    }
    const graphVersions = (await rows<{ v: number }>(
      'select v from relay_graph_v1.checkpoint_migrations order by v')).map(row => row.v);
    if (graphVersions.join(',') !== '0,1,2,3,4') throw new BackupStateError('BACKUP_STATE_GRAPH_MISMATCH');
    const artifacts = await rows<BackupArtifactReference>(`select id,artifact_id,storage_ref,
      encode(content_hash,'hex') as sha256,size::text from public.artifact_versions order by id limit 100001`);
    for (const ref of artifacts) {
      if (ref.storage_ref !== managedContentRef(ref.artifact_id, ref.id) ||
          !/^[0-9a-f]{64}$/u.test(ref.sha256) || !/^(0|[1-9]\d*)$/u.test(ref.size) ||
          BigInt(ref.size) > 256n * 1024n) throw new BackupStateError('BACKUP_STATE_CONTENT_INVALID');
    }
    const workers = await rows<Fact>(`select 'RUN_CLAIM' as kind,run_id as id,worker_id,status,
        epoch::text as epoch from public.run_invocations where status in ('ACTIVE','STOP_REQUIRED')
      union all select 'RUN',id,worker_id,status,worker_epoch::text from public.runs where worker_id is not null
      union all select 'ASSIST',id,worker_id,status,null from public.assist_messages where status='RUNNING'
      union all select 'RESOURCE',id,worker_id,status,worker_epoch::text from public.resource_claims
        where status in ('HELD','QUARANTINED')
      union all select 'WRITE_INVOCATION',i.id,i.worker_id,i.status,i.worker_epoch::text
        from public.invocation_attempts i join public.logical_operations o on o.id=i.operation_id
        where o.capability_key in ('FILE_WRITE','GIT_WRITE','CLI_RUN')
          and i.status in ('PREPARED','DISPATCHING','UNKNOWN')
          and not (o.status='MANUALLY_CLOSED' and o.capability_key='FILE_WRITE' and exists (
            select 1 from public.file_write_manual_dispositions d
            join public.file_write_stop_proofs p on p.invocation_id=d.invocation_id
            join public.resource_claims c on c.id=i.resource_claim_id
            where d.invocation_id=i.id and d.operation_id=o.id and d.run_id=i.run_id
              and p.operation_id=o.id and p.run_id=i.run_id and p.worker_id=i.worker_id
              and p.worker_epoch=i.worker_epoch and p.action_type=o.action_type
              and c.status='RELEASED' and c.run_id=i.run_id and c.resource_id=d.resource_id
              and c.worker_id=p.worker_id and c.worker_epoch=p.worker_epoch))
      order by kind,id limit 100001`);
    const unresolvedEffects = await rows<Fact>(`select operation_id,run_id,step_id,attempt_id,action_type,
      target_ref,status,encode(params_hash,'hex') as params_sha256 from public.run_effect_actions
      where status in ('PREPARED','DISPATCHING','UNKNOWN') order by operation_id limit 100001`);
    const unresolvedOperations = await rows<Fact>(`select id,run_id,task_id,step_id,import_job_id,
      capability_key,action_type,normalized_target,status,resource_id,connection_id,connection_version::text,
      encode(params_hash,'hex') as params_sha256 from public.logical_operations
      where status in ('WAITING_APPROVAL','PREPARED','DISPATCHING','UNKNOWN') order by id limit 100001`);
    const unresolvedInvocations = await rows<Fact>(`select id,operation_id,run_id,task_id,worker_id,
      worker_epoch::text,status,resource_id,resource_claim_id from public.invocation_attempts
      where status in ('PREPARED','DISPATCHING','UNKNOWN') order by id limit 100001`);
    const unresolvedModelCalls = await rows<Fact>(`select id,kind,step_attempt_id,assist_message_id,
      manifest_id,status,config_fingerprint,provider_request_id from public.model_calls
      where status='STARTED' order by id limit 100001`);
    const externalResources = await rows<Fact>(`select id,workspace_id,project_id,canonical_root,
      identity_key,file_write_root_id,status,resource_epoch::text,revision::text
      from public.managed_resources order by id limit 100001`);
    const skillBudget = (await rows<{ count: string; bytes: string }>(`select count(*)::text as count,
      coalesce(sum(octet_length(skill_snapshot::text)),0)::text as bytes
      from public.assist_messages where skill_snapshot is not null`))[0]!;
    if (BigInt(skillBudget.count) > BigInt(MAX_ROWS) || BigInt(skillBudget.bytes) > BigInt(MAX_BYTES)) {
      throw new BackupStateError('BACKUP_STATE_LIMIT');
    }
    const storedSkills = (await rows<{ id: string; skill_snapshot: JsonObject }>(`select id,skill_snapshot
      from public.assist_messages where skill_snapshot is not null order by id limit 100001`)).map(row => {
      const identity = inspectFrozenSkillSnapshot(row.skill_snapshot);
      if (identity === null) throw new BackupStateError('BACKUP_STATE_SKILL_INVALID');
      return { message_id: row.id, id: identity.id, version: identity.version, sha256: identity.sha256 };
    });
    const packBudget = (await rows<{ count: string; bytes: string }>(`select count(*)::text as count,
      coalesce(sum(octet_length((source->'pack')::text)),0)::text as bytes
      from public.project_blueprint_proposals where source ? 'pack' and source->'pack' <> 'null'::jsonb`))[0]!;
    if (BigInt(packBudget.count) > BigInt(MAX_ROWS) || BigInt(packBudget.bytes) > BigInt(MAX_BYTES)) {
      throw new BackupStateError('BACKUP_STATE_LIMIT');
    }
    const storedPacks = (await rows<{ id: string; pack: JsonObject }>(`select id,source->'pack' as pack
      from public.project_blueprint_proposals where source ? 'pack' and source->'pack' <> 'null'::jsonb
      order by id limit 100001`)).map(row => {
      const pack = input.registry.packs.find(entry => entry.definition.id === row.pack.id &&
        entry.definition.version === row.pack.version && entry.sha256 === row.pack.sha256);
      if (pack === undefined || canonicalizeJson(row.pack) !== canonicalizeJson({
        id: pack.definition.id, version: pack.definition.version, sha256: pack.sha256,
        members: pack.members.map(skill => ({ kind: 'SKILL', id: skill.id, version: skill.version, sha256: skill.sha256 })) })) {
        throw new BackupStateError('BACKUP_STATE_PACK_MISSING');
      }
      return { proposal_id: row.id, id: pack.definition.id, version: pack.definition.version, sha256: pack.sha256 };
    });
    const state: BackupDatabaseState = { target,
      admission: { mode: 'DRAINING', revision: admission.revision }, migrations, graph_versions: graphVersions,
      artifacts, workers, unresolved_effects: unresolvedEffects, unresolved_operations: unresolvedOperations,
      unresolved_invocations: unresolvedInvocations, unresolved_model_calls: unresolvedModelCalls,
      external_resources: externalResources, stored_skills: storedSkills, stored_packs: storedPacks };
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_BYTES) throw new BackupStateError('BACKUP_STATE_LIMIT');
    await input.assertHeld();
    input.signal.throwIfAborted();
    await client.query('commit');
    return state;
  } catch (error) {
    if (error instanceof BackupStateError) throw error;
    throw new BackupStateError();
  } finally { await client.end().catch(() => {}); }
}

/** Lease expiry is deliberately irrelevant: every retained writer needs the original native stop proof. */
export function assertBackupWritersStopped(state: BackupDatabaseState,
  stopped: readonly StoppedDesktopLaunch[]): void {
  const launches = new Set(stopped.map(launch => launch.launchId));
  for (const row of state.workers) {
    const match = /^worker:desktop:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.exec(row.worker_id ?? '');
    if (match === null || !launches.has(match[1]!)) throw new BackupStateError('BACKUP_WRITER_NOT_STOPPED');
  }
}

export function assertBackupContentReferences(state: BackupDatabaseState,
  files: readonly BackupDataFile[]): void {
  const mapped = new Map(files.filter(file => file.kind === 'CONTENT').map(file => [file.source_ref, file]));
  for (const ref of state.artifacts) {
    const file = mapped.get(ref.storage_ref);
    if (file === undefined || file.backup_ref !== `data/${ref.storage_ref}` ||
        file.sha256 !== ref.sha256 || file.size !== ref.size) throw new BackupStateError('BACKUP_CONTENT_MISMATCH');
  }
}
