import { sql } from 'kysely';

import type { AssistantProfileRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';

/**
 * assistant_profiles 的独占写入口（红线 1：每类事实只有一个逻辑写入 Owner）。
 *
 * 配置文本在这里落库；能力不在这里——能力来自连接与 Gateway 准入。
 * 一次签发后边界不再改写，revise 只在 revision CAS 命中时改内容，
 * archive 只推进 status 与 revision。
 */
export class AssistantProfileRepository {
  constructor(private readonly db: DbExecutor) {}

  async insert(input: { id: string; workspaceId: string; name: string;
    roleDescription: string; tone: string | null; readScope: JsonObject }): Promise<void> {
    await sql`insert into assistant_profiles (id, workspace_id, name, role_description, tone, read_scope)
      values (${input.id}, ${input.workspaceId}, ${input.name}, ${input.roleDescription},
      ${input.tone}, ${JSON.stringify(input.readScope)}::jsonb)`.execute(this.db);
  }

  async read(id: string, lock = false): Promise<AssistantProfileRow | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    return (await sql<AssistantProfileRow>`select * from assistant_profiles where id = ${id} ${suffix}`
      .execute(this.db)).rows[0];
  }

  /** 只列活跃 助手。归档的 助手 不出现在新建会话的候选里。 */
  async listActive(workspaceId: string): Promise<readonly AssistantProfileRow[]> {
    return (await sql<AssistantProfileRow>`select * from assistant_profiles
      where workspace_id = ${workspaceId} and status = 'ACTIVE'
      order by lower(name), id`.execute(this.db)).rows;
  }

  /** 读归档 助手 也读得到：既有会话要能显示「这个助手已归档」。 */
  async listAll(workspaceId: string): Promise<readonly AssistantProfileRow[]> {
    return (await sql<AssistantProfileRow>`select * from assistant_profiles
      where workspace_id = ${workspaceId} order by status, lower(name), id`.execute(this.db)).rows;
  }

  async revise(input: { id: string; expectedRevision: bigint; name: string;
    roleDescription: string; tone: string | null; readScope: JsonObject }): Promise<boolean> {
    return (await sql<{ id: string }>`update assistant_profiles set name = ${input.name},
      role_description = ${input.roleDescription}, tone = ${input.tone},
      read_scope = ${JSON.stringify(input.readScope)}::jsonb,
      revision = revision + 1, updated_at = now()
      where id = ${input.id} and revision = ${input.expectedRevision} and status = 'ACTIVE'
      returning id`.execute(this.db)).rows.length === 1;
  }

  async archive(id: string, expectedRevision: bigint): Promise<boolean> {
    return (await sql<{ id: string }>`update assistant_profiles set status = 'ARCHIVED',
      revision = revision + 1, updated_at = now()
      where id = ${id} and revision = ${expectedRevision} and status = 'ACTIVE'
      returning id`.execute(this.db)).rows.length === 1;
  }

  /** 归档 助手 之前必须先看清有多少会话正挂着它：这些会话会随归档一起冻结。 */
  async listSessionIds(assistantProfileId: string): Promise<readonly string[]> {
    return (await sql<{ id: string }>`select id from assist_sessions
      where assistant_profile_id = ${assistantProfileId} order by created_at desc, id`
      .execute(this.db)).rows.map((row) => row.id);
  }
}