/**
 * 浏览器任务的展示状态（migration 0107，F26 M3）。
 *
 * 与 `browser/state.ts`（0106，后端健康）分工：那一行回答"后端本身好不好"，
 * 本表回答"现在有哪个任务在操作哪个页面"。写方是 Worker 派发路径，读方是 API 与
 * 桌面壳——三个进程只共享 PostgreSQL，与 0060/0087/0092/0096 同一理由。
 *
 * 状态语义与真实执行对齐，不新增虚拟状态：
 *   * RUNNING        刚刚发生一次浏览器动作（动作之间的模型推理时间会话保持）
 *   * STOP_REQUESTED 用户请求退出：既有 run_control_requests 已入队，Worker 尚未确认
 *   * STOPPED        无活跃操作；读取方按空闲阈值惰性落库（Worker 不留后台定时器）
 *
 * 本表只承载展示事实：不参与准入、不参与审批、不属于账本。
 */

import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import { DomainError, invalidTransition } from '../application/domain-error.js';
import { requestComputerControlStop } from '../application/control-requests.js';
import type { BrowserSessionOwnerKind } from './owner.js';

/** 浏览器任务空闲阈值：超过该时长没有新动作即视为已停止。 */
export const BROWSER_SESSION_IDLE_MS = 30_000;

export interface BrowserSessionRow {
  readonly owner_kind: BrowserSessionOwnerKind;
  readonly owner_id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly page_id: number;
  readonly url: string;
  readonly title: string;
  readonly action_type: string;
  readonly action_label: string;
  readonly state: string;
  readonly started_at: Date;
  readonly updated_at: Date;
}

const COLUMNS = sql.raw(`owner_kind, owner_id, workspace_id, project_id, page_id, url, title,
  action_type, action_label, state, started_at, updated_at`);

export interface BrowserActivityInput {
  readonly ownerKind: BrowserSessionOwnerKind;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly actionType: string;
  readonly actionLabel: string;
  readonly pageId: number;
  readonly url: string | null;
  readonly title: string | null;
}

/**
 * 记录一次浏览器动作后的任务状态。
 *
 * 单行 upsert（PK = owner）；同一 owner 的新动作只刷新页面与文案，`started_at` 在
 * owner 未变时保留——它是"这个任务从什么时候开始用浏览器"的事实，不是"最后一次动作"。
 */
export async function markBrowserSessionActive(db: DbExecutor,
  input: BrowserActivityInput): Promise<void> {
  await sql`
    insert into browser_sessions (
      owner_kind, owner_id, workspace_id, project_id, page_id, url, title,
      action_type, action_label, state, started_at, updated_at)
    values (${input.ownerKind}, ${input.ownerId}, ${input.workspaceId}, ${input.projectId},
      ${input.pageId}, ${input.url ?? ''}, ${input.title ?? ''},
      ${input.actionType}, ${input.actionLabel}, 'RUNNING', now(), now())
    on conflict (owner_kind, owner_id) do update set
      workspace_id = excluded.workspace_id,
      project_id = excluded.project_id,
      page_id = excluded.page_id,
      url = excluded.url,
      title = excluded.title,
      action_type = excluded.action_type,
      action_label = excluded.action_label,
      state = 'RUNNING',
      updated_at = now()
  `.execute(db);
}

export interface BrowserSessionDto {
  readonly owner_kind: BrowserSessionOwnerKind;
  readonly owner_id: string;
  readonly page_id: number;
  readonly url: string;
  readonly title: string;
  readonly action_type: string | null;
  readonly action_label: string | null;
  readonly state: string;
  readonly started_at: string | null;
  readonly updated_at: string | null;
}

/** 列出一个工作区内的浏览器任务；过期行惰性落 STOPPED（幂等）。 */
export async function readBrowserSessions(db: DbExecutor,
  workspaceId: string): Promise<readonly BrowserSessionDto[]> {
  await expireIdleSessions(db);
  const result = await sql<BrowserSessionRow>`
    select ${COLUMNS} from browser_sessions
    where workspace_id = ${workspaceId} and state <> 'STOPPED'
    order by updated_at desc
  `.execute(db);
  return result.rows.map(toDto);
}

/** 读取单条（按 owner），供 stop 端点做幂等判断。 */
export async function readBrowserSession(db: DbExecutor,
  ownerKind: BrowserSessionOwnerKind, ownerId: string): Promise<BrowserSessionRow | undefined> {
  const result = await sql<BrowserSessionRow>`
    select ${COLUMNS} from browser_sessions
    where owner_kind = ${ownerKind} and owner_id = ${ownerId}
  `.execute(db);
  return result.rows[0];
}

/** 只允许从 RUNNING 推进到 STOP_REQUESTED：重复请求幂等，返回是否真的改写了状态。 */
export async function markBrowserSessionStopRequested(db: DbExecutor,
  ownerKind: BrowserSessionOwnerKind, ownerId: string): Promise<boolean> {
  const result = await sql`
    update browser_sessions set state = 'STOP_REQUESTED', updated_at = now()
    where owner_kind = ${ownerKind} and owner_id = ${ownerId} and state = 'RUNNING'
  `.execute(db);
  return Number(result.numAffectedRows ?? 0) > 0;
}

/** 空闲过期：Worker 不留后台定时器，过期判定由读取路径完成（与 0096 同构）。 */
async function expireIdleSessions(db: DbExecutor): Promise<void> {
  await sql`
    update browser_sessions set state = 'STOPPED', updated_at = now()
    where state = 'RUNNING'
      and updated_at < now() - ${sql.raw(`interval '${Math.floor(BROWSER_SESSION_IDLE_MS / 1000)} seconds'`)}
  `.execute(db);
}

function toDto(row: BrowserSessionRow): BrowserSessionDto {
  return {
    owner_kind: row.owner_kind,
    owner_id: row.owner_id,
    page_id: row.page_id,
    url: row.url,
    title: row.title,
    action_type: row.action_type === '' ? null : row.action_type,
    action_label: row.action_label === '' ? null : row.action_label,
    state: row.state,
    started_at: row.started_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}


/**
 * 用户请求停止一个浏览器任务（Esc / 界面上的「停止」）。
 *
 * 只支持 `RUN` 归属：会话只读轮次没有 Run 可取消，它由消息取消通道自行终止
 * （`assist_messages.cancel_requested`），本端点对它返回 409 而不是静默成功。
 */
export async function requestBrowserSessionStop(db: DbExecutor, input: {
  readonly workspaceId: string;
  readonly ownerKind: BrowserSessionOwnerKind;
  readonly ownerId: string;
}): Promise<{ readonly state: 'STOP_REQUESTED' | 'STOPPED';
  readonly control_request_id: string | null }> {
  const row = await readBrowserSession(db, input.ownerKind, input.ownerId);
  if (row === undefined || row.workspace_id !== input.workspaceId) {
    // 未知任务 / 别的工作区：按"没有可停的浏览器任务"幂等返回，不泄露其它工作区存在性。
    return { state: 'STOPPED', control_request_id: null };
  }
  if (row.state === 'STOPPED') return { state: 'STOPPED', control_request_id: null };
  if (input.ownerKind === 'SESSION') {
    throw new DomainError({ code: 'BROWSER_SESSION_NOT_STOPPABLE', status: 409,
      type: '/problems/browser-session-not-stoppable', title: '无法停止该浏览器任务',
      detail: '会话只读轮次没有可取消的 Run；请改用「停止本次回答」。',
      retryable: false, retryAction: 'NONE' });
  }
  if (!(await markBrowserSessionStopRequested(db, input.ownerKind, input.ownerId))) {
    // 并发下别人先停了：意图一致，幂等成功。
    return { state: 'STOP_REQUESTED', control_request_id: null };
  }
  try {
    const control = await requestComputerControlStop(db, {
      workspaceId: input.workspaceId, runId: input.ownerId });
    return { state: 'STOP_REQUESTED', control_request_id: control.id };
  } catch (error) {
    // Run 已终止 / 语义上无法入队：状态位已写入，用户看到的仍是「停止已请求」。
    if (error instanceof DomainError && error.status === 409) {
      return { state: 'STOP_REQUESTED', control_request_id: null };
    }
    throw invalidTransition(error instanceof Error ? error.message : '停止浏览器任务失败。');
  }
}
