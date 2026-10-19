/**
 * 浏览器后端健康投影（migration 0106）。
 *
 * 写方只有一个：Worker 里的 `browserExecute`（在每次 ensureStarted 之后）。读方是
 * API 的 `GET /browser/status` 与桌面壳。三个进程只共享 PostgreSQL，因此这里既不是
 * 缓存也不是第二份事实——它就是跨进程唯一可见的那份展示事实。
 *
 * 上报失败**不阻断**真实执行：状态条缺失属于可感知的展示降级，不能让浏览器动作
 * 因为一行投影写不进去而失败（与 0096 的上报纪律一致）。
 */

import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { BrowserHealth, BrowserHealthStatus } from './provider.js';

export type BrowserBackendStatus = BrowserHealthStatus | 'NOT_STARTED';

export interface BrowserBackendStateDto {
  readonly status: BrowserBackendStatus;
  readonly backend_version: string | null;
  readonly chrome_version: string | null;
  readonly detail: string;
  readonly remediation: string | null;
  readonly tool_count: number;
  /** 这个结论是什么时候测出来的；NOT_STARTED 时为 null。 */
  readonly updated_at: string | null;
}

const NOT_STARTED: BrowserBackendStateDto = {
  status: 'NOT_STARTED', backend_version: null, chrome_version: null,
  detail: '浏览器后端尚未启动；首次使用浏览器能力时会自动启动。',
  remediation: null, tool_count: 0, updated_at: null,
};

interface StateRow {
  readonly status: BrowserHealthStatus;
  readonly backend_version: string;
  readonly chrome_version: string;
  readonly detail: string;
  readonly remediation: string;
  readonly tool_count: number;
  readonly updated_at: Date;
}

/** 写入一次健康结论（单行 upsert）。调用方负责吞掉异常——展示事实不拖住执行。 */
export async function reportBrowserHealth(db: DbExecutor,
  health: BrowserHealth): Promise<void> {
  await sql`
    insert into browser_backend_state (
      id, status, backend_version, chrome_version, detail, remediation, tool_count, updated_at)
    values (1, ${health.status}, ${health.backendVersion ?? ''}, ${health.chromeVersion ?? ''},
      ${health.detail}, ${health.remediation ?? ''}, ${health.tools.length}, now())
    on conflict (id) do update set
      status = excluded.status,
      backend_version = excluded.backend_version,
      chrome_version = excluded.chrome_version,
      detail = excluded.detail,
      remediation = excluded.remediation,
      tool_count = excluded.tool_count,
      updated_at = now()
  `.execute(db);
}

export async function readBrowserBackendState(db: DbExecutor): Promise<BrowserBackendStateDto> {
  const result = await sql<StateRow>`
    select status, backend_version, chrome_version, detail, remediation, tool_count, updated_at
    from browser_backend_state where id = 1
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) return NOT_STARTED;
  return {
    status: row.status,
    backend_version: row.backend_version === '' ? null : row.backend_version,
    chrome_version: row.chrome_version === '' ? null : row.chrome_version,
    detail: row.detail,
    remediation: row.remediation === '' ? null : row.remediation,
    tool_count: row.tool_count,
    updated_at: row.updated_at.toISOString(),
  };
}

/** 纯投影：把内存里的健康结论变成与 DTO 同形的对象（单测用，不碰数据库）。 */
export function projectBrowserHealth(health: BrowserHealth): BrowserBackendStateDto {
  return {
    status: health.status,
    backend_version: health.backendVersion,
    chrome_version: health.chromeVersion,
    detail: health.detail,
    remediation: health.remediation,
    tool_count: health.tools.length,
    updated_at: new Date().toISOString(),
  };
}
