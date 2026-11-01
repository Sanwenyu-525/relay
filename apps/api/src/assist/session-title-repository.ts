import { sql } from 'kysely';

import type { AssistMessageRow, AssistSessionTitleSource, AssistTitleGenerationRow } from
  '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';

/**
 * 会话标题生成请求的持久身份（0157）。
 *
 * 为什么需要一张表而不是只靠内存任务：标题生成是一次真实模型外呼，可能跨进程重启、
 * 与用户手动改名并发，还可能被重复投递。请求身份、领取租约与「请求时标题是哪一份」
 * 必须落库，落标题才有可核对的 CAS 依据；只放 React state 或进程内 Map 都无法回答
 * 「这次迟到结果还能不能写」。
 *
 * 这里只管请求行本身；会话标题的写入在 `applyTitle` 的同一事务里做 CAS——
 * 模型输出永远不能绕过这条路径直接写 `assist_sessions`。
 */

/** 领取超过这个尝试次数就不再重试，保留原标题与失败原因。 */
export const MAX_TITLE_GENERATION_ATTEMPTS = 2;

/**
 * 绑定事务执行器的仓储形态：与其它 `Repositories` 成员一致，用例只通过它读写，
 * 不自行拼 SQL、也不另开事务。
 */
export class AssistTitleGenerationRepository {
  constructor(private readonly db: DbExecutor) {}

  enqueue(input: EnqueueTitleGenerationInput): Promise<AssistTitleGenerationRow | undefined> {
    return enqueueTitleGeneration(this.db, input);
  }

  claim(input: { readonly workerId: string; readonly leaseMs: number; readonly now: Date }):
  Promise<ClaimedTitleGeneration | undefined> {
    return claimTitleGeneration(this.db, input);
  }

  apply(input: ApplyTitleInput):
  Promise<{ readonly applied: boolean; readonly reason: 'APPLIED' | 'SUPERSEDED' | 'CLAIM_LOST' }> {
    return applyTitleGeneration(this.db, input);
  }

  fail(input: Parameters<typeof failTitleGeneration>[1]): Promise<'RETRIED' | 'FAILED'> {
    return failTitleGeneration(this.db, input);
  }

  readScope(sessionId: string) {
    return readTitleGenerationScope(this.db, sessionId);
  }

  readMessages(input: { readonly sessionId: string; readonly anchorMessageId: string | null;
    readonly recentLimit?: number }) {
    return readTitleGenerationMessages(this.db, input);
  }
}

export interface EnqueueTitleGenerationInput {
  readonly id: string;
  readonly sessionId: string;
  readonly requestKind: 'AUTO' | 'REGENERATE';
  readonly inputDigest: string;
  readonly anchorMessageId: string | null;
  /** AUTO 的防抖窗口：同一会话最近一次 AUTO 请求早于 `now - interval` 才允许再入队。 */
  readonly autoCooldownMs: number;
  readonly now: Date;
}

export interface TitleGenerationSession {
  readonly id: string;
  readonly status: 'ACTIVE' | 'ARCHIVED';
  readonly title: string;
  readonly titleSource: AssistSessionTitleSource;
}

/**
 * 入队（调用方必须已在事务中，仓储不自行开事务）。
 *
 * 返回 `undefined` 表示按规则不该生成：会话已归档、标题来源受保护（AUTO 不能改
 * USER_DEFINED/LEGACY），或同一会话刚请求过。返回一个**已存在**的在途请求时，
 * 调用方把它当成幂等重放，不再创建第二条。
 */
export async function enqueueTitleGeneration(db: DbExecutor,
  input: EnqueueTitleGenerationInput): Promise<AssistTitleGenerationRow | undefined> {
  const session = await lockTitleSession(db, input.sessionId);
  if (session === undefined || session.status !== 'ACTIVE') return undefined;
  if (input.requestKind === 'AUTO' && session.titleSource !== 'PROVISIONAL' &&
      session.titleSource !== 'AI_GENERATED') return undefined;

  if (input.requestKind === 'AUTO') {
    const recent = await sql<AssistTitleGenerationRow>`select * from assist_title_generations
      where session_id = ${input.sessionId} and request_kind = 'AUTO'
        and requested_at > ${new Date(input.now.getTime() - input.autoCooldownMs)}
      order by requested_at desc limit 1`.execute(db);
    if (recent.rows[0] !== undefined) return recent.rows[0];
  } else {
    // 显式重新生成：后来的请求取代在途请求。旧请求被标 SKIPPED 后，即使模型结果迟到，
    // 也拿不到 CLAIMED 身份，不能再写标题。
    await sql`update assist_title_generations
      set status = 'SKIPPED', error_code = 'TITLE_SUPERSEDED', settled_at = ${input.now},
        claimed_by = null, lease_until = null
      where session_id = ${input.sessionId} and status in ('PENDING', 'CLAIMED')`
      .execute(db);
  }

  const inserted = await sql<AssistTitleGenerationRow>`insert into assist_title_generations (
      id, session_id, request_kind, status, base_title, base_title_source,
      input_digest, anchor_message_id, requested_at)
    values (${input.id}, ${input.sessionId}, ${input.requestKind}, 'PENDING',
      ${session.title}, ${session.titleSource}, ${input.inputDigest},
      ${input.anchorMessageId}, ${input.now})
    on conflict (session_id) where status in ('PENDING', 'CLAIMED') do nothing
    returning *`.execute(db);
  if (inserted.rows[0] !== undefined) return inserted.rows[0];
  // 并发入队撞上了唯一索引：读回那一条，按同一请求幂等处理。
  return (await sql<AssistTitleGenerationRow>`select * from assist_title_generations
    where session_id = ${input.sessionId} and status in ('PENDING', 'CLAIMED')
    order by requested_at desc limit 1`.execute(db)).rows[0];
}

async function lockTitleSession(db: DbExecutor, sessionId: string): Promise<TitleGenerationSession | undefined> {
  const row = (await sql<{ id: string; status: 'ACTIVE' | 'ARCHIVED'; title: string;
    title_source: AssistSessionTitleSource }>`select id, status, title, title_source
    from assist_sessions where id = ${sessionId} for update`.execute(db)).rows[0];
  if (row === undefined) return undefined;
  return { id: row.id, status: row.status, title: row.title, titleSource: row.title_source };
}

export interface ClaimedTitleGeneration {
  readonly job: AssistTitleGenerationRow;
  readonly attemptsAtClaim: number;
}

/**
 * 领取一个可执行的请求（调用方事务内）。
 *
 * `for update skip locked` + 短租约：同一时刻只有一个执行者持有请求；进程崩溃后租约过期，
 * 下一个 tick 可以接续，尝试次数推进。已超过尝试上限的行直接收口为 FAILED，
 * 不把「模型一直失败」拖成无限重试。
 */
export async function claimTitleGeneration(db: DbExecutor, input: {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly now: Date;
}): Promise<ClaimedTitleGeneration | undefined> {
  for (let scanned = 0; scanned < 8; scanned += 1) {
    const row = (await sql<AssistTitleGenerationRow>`select * from assist_title_generations
      where (status = 'PENDING' and (lease_until is null or lease_until < ${input.now}))
        or (status = 'CLAIMED' and lease_until is not null and lease_until < ${input.now})
      order by requested_at limit 1 for update skip locked`.execute(db)).rows[0];
    if (row === undefined) return undefined;
    if (row.attempts >= MAX_TITLE_GENERATION_ATTEMPTS) {
      await sql`update assist_title_generations
        set status = 'FAILED', error_code = 'TITLE_ATTEMPTS_EXHAUSTED', settled_at = ${input.now}
        where id = ${row.id} and status in ('PENDING', 'CLAIMED')`.execute(db);
      continue;
    }
    const attempts = row.attempts + 1;
    const claimed = (await sql<AssistTitleGenerationRow>`update assist_title_generations
      set status = 'CLAIMED', claimed_by = ${input.workerId}, claimed_at = ${input.now},
        lease_until = ${new Date(input.now.getTime() + input.leaseMs)}, attempts = ${attempts}
      where id = ${row.id} returning *`.execute(db)).rows[0];
    if (claimed !== undefined) return { job: claimed, attemptsAtClaim: attempts };
  }
  return undefined;
}

export interface ApplyTitleInput {
  readonly job: AssistTitleGenerationRow;
  readonly attemptsAtClaim: number;
  readonly workerId: string;
  readonly title: string;
  readonly titleSource: Extract<AssistSessionTitleSource, 'AI_GENERATED' | 'PROVISIONAL'>;
  readonly generator: 'MODEL' | 'RULES';
  readonly now: Date;
}

/**
 * 落标题的唯一写入口。
 *
 * 四项都必须在同一事务内核对：请求仍由本次领取持有、会话仍 ACTIVE、
 * **标题仍等于请求时的那一份、来源也仍未变**。用户在这次外呼期间手动改名后，
 * 两个条件同时失效，结果只能停在 SKIPPED——迟到的模型结果不能覆盖用户的选择。
 */
export async function applyTitleGeneration(db: DbExecutor, input: ApplyTitleInput):
Promise<{ readonly applied: boolean; readonly reason: 'APPLIED' | 'SUPERSEDED' | 'CLAIM_LOST' }> {
  const job = (await sql<AssistTitleGenerationRow>`select * from assist_title_generations
    where id = ${input.job.id} for update`.execute(db)).rows[0];
  if (job === undefined || job.status !== 'CLAIMED' ||
      job.claimed_by !== input.workerId || job.attempts !== input.attemptsAtClaim) {
    return { applied: false, reason: 'CLAIM_LOST' };
  }
  const session = (await sql<{ id: string; title: string; title_source: AssistSessionTitleSource;
    status: 'ACTIVE' | 'ARCHIVED' }>`select id, title, title_source, status
    from assist_sessions where id = ${job.session_id} for update`.execute(db)).rows[0];
  const stillOurs = session !== undefined && session.status === 'ACTIVE' &&
    session.title === job.base_title && session.title_source === job.base_title_source;
  if (!stillOurs) {
    await settleJob(db, job.id, input.workerId, input.attemptsAtClaim, {
      status: 'SKIPPED', errorCode: 'TITLE_SUPERSEDED', now: input.now });
    return { applied: false, reason: 'SUPERSEDED' };
  }
  const titleChanged = session.title !== input.title;
  await sql`update assist_sessions
    set title = ${input.title}, title_source = ${input.titleSource},
      title_generated_at = ${input.now},
      revision = revision + ${titleChanged ? 1 : 0}, updated_at = ${input.now}
    where id = ${session.id}`.execute(db);
  await settleJob(db, job.id, input.workerId, input.attemptsAtClaim, {
    status: 'COMPLETED', resultTitle: input.title, generator: input.generator, now: input.now });
  return { applied: true, reason: 'APPLIED' };
}

/** 失败收口：还有尝试次数就退避后重新入队，否则落 FAILED（标题保持原样）。 */
export async function failTitleGeneration(db: DbExecutor, input: {
  readonly job: AssistTitleGenerationRow;
  readonly attemptsAtClaim: number;
  readonly workerId: string;
  readonly errorCode: string;
  readonly now: Date;
  readonly retryDelayMs: number;
}): Promise<'RETRIED' | 'FAILED'> {
  if (input.attemptsAtClaim < MAX_TITLE_GENERATION_ATTEMPTS) {
    await sql`update assist_title_generations
      set status = 'PENDING', claimed_by = null, claimed_at = null,
        lease_until = ${new Date(input.now.getTime() + input.retryDelayMs)},
        error_code = ${input.errorCode}
      where id = ${input.job.id} and status = 'CLAIMED'
        and claimed_by = ${input.workerId} and attempts = ${input.attemptsAtClaim}`.execute(db);
    return 'RETRIED';
  }
  await settleJob(db, input.job.id, input.workerId, input.attemptsAtClaim, {
    status: 'FAILED', errorCode: input.errorCode, now: input.now });
  return 'FAILED';
}

async function settleJob(db: DbExecutor, jobId: string, workerId: string, attempts: number, input: {
  readonly status: 'COMPLETED' | 'FAILED' | 'SKIPPED';
  readonly errorCode?: string;
  readonly resultTitle?: string;
  readonly generator?: 'MODEL' | 'RULES';
  readonly now: Date;
}): Promise<void> {
  await sql`update assist_title_generations
    set status = ${input.status}, settled_at = ${input.now},
      result_title = ${input.resultTitle ?? null},
      generator = ${input.generator ?? null},
      error_code = ${input.errorCode ?? null},
      claimed_by = null, lease_until = null
    where id = ${jobId} and status = 'CLAIMED'
      and claimed_by = ${workerId} and attempts = ${attempts}`.execute(db);
}

/**
 * 标题生成的**输入证据**：首条有效用户消息、最近几条已完成消息、触发本次生成的回复/消息。
 *
 * 只取已完成、未撤回、有正文的消息；工具日志、文件正文、附件内容一律不读——
 * 标题只需要「用户在做什么」，不需要执行细节，也不该把敏感内容送进辅助外呼。
 * 条数与每条长度在装配提示词时再按预算截断（见 `buildTitleModelInput`）。
 */
export async function readTitleGenerationMessages(db: DbExecutor, input: {
  readonly sessionId: string;
  readonly anchorMessageId: string | null;
  readonly recentLimit?: number;
}): Promise<{
  readonly firstUserMessage: AssistMessageRow | undefined;
  readonly recentMessages: readonly AssistMessageRow[];
  readonly anchorMessage: AssistMessageRow | undefined;
}> {
  const firstUser = (await sql<AssistMessageRow>`select * from assist_messages
    where session_id = ${input.sessionId} and role = 'USER' and status = 'COMPLETED'
      and withdrawn_at is null and content is not null and content <> ''
    order by seq asc limit 1`.execute(db)).rows[0];
  const recent = (await sql<AssistMessageRow>`select * from assist_messages
    where session_id = ${input.sessionId} and status = 'COMPLETED'
      and withdrawn_at is null and content is not null and content <> ''
    order by seq desc limit ${Math.max(1, Math.min(12, input.recentLimit ?? 6))}`
    .execute(db)).rows;
  const anchor = input.anchorMessageId === null ? undefined
    : (await sql<AssistMessageRow>`select * from assist_messages
      where id = ${input.anchorMessageId} and session_id = ${input.sessionId}`
      .execute(db)).rows[0];
  return { firstUserMessage: firstUser, anchorMessage: anchor,
    recentMessages: [...recent].reverse() };
}

/**
 * 会话作用域标题：模型只看这一条讨论属哪个项目/任务，不读项目正文。
 * 读不到（跨作用域、已删除）时如实返回 null，由提示词层说明「未知」。
 */
export async function readTitleGenerationScope(db: DbExecutor, sessionId: string):
Promise<{ readonly projectTitle: string | null; readonly taskTitle: string | null }> {
  const row = (await sql<{ project_title: string | null; task_title: string | null }>`
    select p.title as project_title, t.title as task_title
    from assist_sessions s
    left join projects p on p.id = s.project_id
    left join tasks t on t.id = s.task_id
    where s.id = ${sessionId}`.execute(db)).rows[0];
  return { projectTitle: row?.project_title ?? null, taskTitle: row?.task_title ?? null };
}
