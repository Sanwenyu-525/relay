import { sql } from 'kysely';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
export interface TaskChainRow {
 id: string; workspace_id: string; project_id: string; title: string; baseline: JsonObject; status: string; revision: bigint;
 runtime_id: string | null; max_tasks: number; max_model_calls: number; task_reservations: number; calls_started: number;
 expires_at: Date | null; reason: string | null; stop_target: string | null; control_request_id: string | null;
 resume_command_id: string | null; authorization_history: JsonObject[]; created_at: Date;
}
export interface TaskChainItem {
 id: string; chain_id: string; ordinal: number; task_id: string; task_revision: bigint; acceptance_revision: bigint; baseline: JsonObject;
 status: string; ready_command_id: string; delegate_command_id: string; run_id: string | null; completion_id: string | null;
 execution_spec:JsonObject;
}
export class TaskChainRepository {
 constructor(private readonly db: DbExecutor) {}
 async now() { return (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(this.db)).rows[0]!.now; }
 async read(id: string, lock = false) { return (await sql<TaskChainRow>`select * from task_chains where id=${id} ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0]; }
 async items(id: string) { return (await sql<TaskChainItem>`select * from task_chain_items where chain_id=${id} order by ordinal`.execute(this.db)).rows; }
 async insert(id: string, workspaceId: string, projectId: string, title: string, baseline: JsonObject) {
  return (await sql<TaskChainRow>`insert into task_chains(id,workspace_id,project_id,title,baseline) values(${id},${workspaceId},${projectId},${title},${JSON.stringify(baseline)}::jsonb) returning *`.execute(this.db)).rows[0]!;
 }
 async insertItem(i: Omit<TaskChainItem,'status'|'run_id'|'completion_id'>) {
  await sql`insert into task_chain_items(id,chain_id,ordinal,task_id,task_revision,acceptance_revision,baseline,ready_command_id,delegate_command_id,execution_spec)
   values(${i.id},${i.chain_id},${i.ordinal},${i.task_id},${i.task_revision},${i.acceptance_revision},${JSON.stringify(i.baseline)}::jsonb,${i.ready_command_id},${i.delegate_command_id},${JSON.stringify(i.execution_spec)}::jsonb)`.execute(this.db);
 }
 async list(workspaceId: string, projectId: string) { return (await sql<TaskChainRow>`select * from task_chains where workspace_id=${workspaceId} and project_id=${projectId} order by created_at,id`.execute(this.db)).rows; }
 async active() { return (await sql<TaskChainRow>`select * from task_chains where status in ('ACTIVE','PAUSING') order by created_at,id`.execute(this.db)).rows; }
 async state(id: string, status: string, reason: string | null, target: string | null = null, controlId: string | null = null) {
  return (await sql<TaskChainRow>`update task_chains set status=${status},reason=${reason},stop_target=${target},control_request_id=${controlId},revision=revision+1 where id=${id} returning *`.execute(this.db)).rows[0]!;
 }
 async authorize(id: string, runtimeId: string, maxTasks: number, maxCalls: number, expires: Date, history: JsonObject, resumeId: string | null) {
  return (await sql<TaskChainRow>`update task_chains set status='ACTIVE',reason=null,runtime_id=${runtimeId},max_tasks=${maxTasks},max_model_calls=${maxCalls},expires_at=${expires},
   stop_target=null,control_request_id=null,resume_command_id=${resumeId},authorization_history=authorization_history || ${JSON.stringify([history])}::jsonb,revision=revision+1 where id=${id} returning *`.execute(this.db)).rows[0]!;
 }
 async ready(itemId: string, revision: bigint) { await sql`update task_chain_items set task_revision=${revision} where id=${itemId}`.execute(this.db); }
 async bind(chainId: string, itemId: string, runId: string) {
  await sql`update task_chain_items set run_id=${runId},status='RUNNING' where id=${itemId} and run_id is null`.execute(this.db);
  await sql`update task_chains set task_reservations=task_reservations+1,revision=revision+1 where id=${chainId}`.execute(this.db);
 }
 async complete(chainId: string, itemId: string, completionId: string) {
  await sql`update task_chain_items set status='COMPLETED',completion_id=${completionId} where id=${itemId}`.execute(this.db);
  await sql`update task_chains set revision=revision+1 where id=${chainId}`.execute(this.db);
 }
 async usage(chainId: string) {
  return (await sql<{ count: string; uncertain: string; known_input: string; known_output: string; input_known_count:string; output_known_count:string }>`select count(*)::text as count,
   count(*) filter(where c.status='STARTED' or c.usage_input_tokens is null or c.usage_output_tokens is null)::text as uncertain,
   coalesce(sum(c.usage_input_tokens),0)::text as known_input,coalesce(sum(c.usage_output_tokens),0)::text as known_output,
   count(c.usage_input_tokens)::text as input_known_count,count(c.usage_output_tokens)::text as output_known_count
   from model_calls c join step_attempts a on a.id=c.step_attempt_id join run_steps s on s.id=a.step_id join task_chain_items i on i.run_id=s.run_id
   where i.chain_id=${chainId}`.execute(this.db)).rows[0]!;
 }
 /** 与原 model_calls STARTED 同事务预留；未知计量不释放、不按零准入。 */
 async reserveCall(runId: string): Promise<boolean> {
  const chain = (await sql<TaskChainRow>`select c.* from task_chains c join task_chain_items i on i.chain_id=c.id where i.run_id=${runId} for update of c`.execute(this.db)).rows[0];
  if (chain === undefined) return true;
  if (chain.status!=='ACTIVE' || chain.expires_at===null || chain.expires_at<=await this.now() || chain.calls_started>=chain.max_model_calls || Number((await this.usage(chain.id)).uncertain)>0) return false;
  await sql`update task_chains set calls_started=calls_started+1,revision=revision+1 where id=${chain.id}`.execute(this.db); return true;
 }
 async requireResume(runtimeId: string) {
  await sql`update task_chains set status='WAITING_RESUME',reason='API_RESTART_REQUIRES_CONFIRMATION',revision=revision+1 where status='ACTIVE' and runtime_id is distinct from ${runtimeId}::uuid`.execute(this.db);
 }
 async clearResume(id: string,commandId: string) {await sql`update task_chains set resume_command_id=null,revision=revision+1 where id=${id} and resume_command_id=${commandId}`.execute(this.db);}
}
