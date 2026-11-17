import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { AssistSkillInvocationRow, AssistSkillInvocationStatus }
  from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { redactLogText } from '../infrastructure/runtime-log.js';

/**
 * 0169：第一方 Skill 的执行事件账本。
 *
 * 只记录执行生命周期与脱敏摘要；完整输入/输出仍归消息行。普通工具调用没有这个入口。
 */
export interface BeginSkillInvocationInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly skillId: string;
  readonly skillVersion: string;
  readonly skillSha256: string;
  readonly ordinal?: number;
  readonly inputSummary: string | null;
}

export function skillInvocationKey(input: {
  readonly messageId: string; readonly skillId: string; readonly skillVersion: string;
  readonly skillSha256: string; readonly ordinal?: number | undefined;
}): string {
  const identity = [input.messageId, input.skillId, input.skillVersion,
    input.skillSha256, String(input.ordinal ?? 1)].join('\u0000');
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

/** 摘要脱敏：只保留可读文本，截断为有限长度；不是完整参数副本。 */
export function summarizeSkillText(value: unknown, limit = 400): string | null {
  if (value === null || value === undefined) return null;
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value); } catch { return null; }
  }
  const redacted = redactLogText(text, limit).trim();
  return redacted === '' ? null : redacted;
}

function pickSummary(value: JsonObject | null): string | null {
  if (value === null) return null;
  for (const key of ['summary', 'title', 'desired_result', 'goal', 'question',
    'focus', 'request', 'description']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return summarizeSkillText(candidate);
    }
  }
  return summarizeSkillText(value);
}

export function skillInputSummary(input: JsonObject | null): string | null {
  return pickSummary(input);
}

export function skillOutputSummary(output: JsonObject | null): string | null {
  if (output === null) return null;
  const payload = typeof output.payload === 'object' && output.payload !== null &&
    !Array.isArray(output.payload) ? output.payload as JsonObject : null;
  return pickSummary(payload) ?? pickSummary(output);
}

export class AssistSkillInvocationRepository {
  constructor(private readonly db: DbExecutor) {}

  /** 受理消息事务内写入 REQUESTED；同一 invocation_key 重放不产生第二行。 */
  async request(input: BeginSkillInvocationInput): Promise<AssistSkillInvocationRow | undefined> {
    const key = skillInvocationKey(input);
    return (await sql<AssistSkillInvocationRow>`insert into assist_skill_invocations
      (id, workspace_id, session_id, message_id, invocation_key, ordinal, skill_id,
        skill_version, skill_sha256, status, input_summary)
      values (${input.id}, ${input.workspaceId}, ${input.sessionId}, ${input.messageId}, ${key},
        ${input.ordinal ?? 1}, ${input.skillId}, ${input.skillVersion}, ${input.skillSha256},
        'REQUESTED', ${input.inputSummary})
      on conflict (invocation_key) do nothing
      returning *`.execute(this.db)).rows[0] ?? await this.readByKey(key);
  }

  /** 真正进入执行前标记 RUNNING；只允许从 REQUESTED 迁移。 */
  async markRunning(messageId: string, invocationKey: string): Promise<boolean> {
    const result = await sql`update assist_skill_invocations set status = 'RUNNING',
      started_at = coalesce(started_at, now()), updated_at = now()
      where message_id = ${messageId} and invocation_key = ${invocationKey}
        and status = 'REQUESTED'`.execute(this.db);
    return Number(result.numAffectedRows ?? 0n) > 0;
  }

  async finish(input: {
    readonly messageId: string; readonly invocationKey: string;
    readonly status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
    readonly outputSummary: string | null; readonly errorKind: string | null;
    readonly errorDetail: string | null;
  }): Promise<boolean> {
    const result = await sql`update assist_skill_invocations set status = ${input.status},
      output_summary = ${input.outputSummary}, error_kind = ${input.errorKind},
      error_detail = ${input.errorDetail}, settled_at = now(), updated_at = now()
      where message_id = ${input.messageId} and invocation_key = ${input.invocationKey}
        and status in ('REQUESTED', 'RUNNING')
      returning id`.execute(this.db);
    return Number(result.numAffectedRows ?? 0n) > 0;
  }

  async readByKey(key: string): Promise<AssistSkillInvocationRow | undefined> {
    return (await sql<AssistSkillInvocationRow>`select * from assist_skill_invocations
      where invocation_key = ${key}`.execute(this.db)).rows[0];
  }

  async readByMessage(messageId: string): Promise<AssistSkillInvocationRow | undefined> {
    return (await sql<AssistSkillInvocationRow>`select * from assist_skill_invocations
      where message_id = ${messageId} order by requested_at asc, ordinal asc limit 1`
      .execute(this.db)).rows[0];
  }

  async listByMessageIds(messageIds: readonly string[]):
    Promise<readonly AssistSkillInvocationRow[]> {
    if (messageIds.length === 0) return [];
    return (await sql<AssistSkillInvocationRow>`select * from assist_skill_invocations
      where message_id = any(${[...messageIds]}::uuid[])
      order by requested_at asc, ordinal asc, id asc`.execute(this.db)).rows;
  }
}

export function isSettledSkillInvocation(status: AssistSkillInvocationStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
}
