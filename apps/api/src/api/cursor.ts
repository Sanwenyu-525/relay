import { invalidCursor } from '../application/domain-error.js';
import { isUuid } from '../application/revisions.js';

/**
 * 任务列表游标。
 *
 * 契约（docs/api/http-command-contract.md 第 1 节）：游标绑定过滤条件与稳定排序键，非法游标返回 400。
 * 这里把过滤条件写进游标，换过滤条件复用同一个游标会被拒绝，而不是静默返回另一段数据。
 * 排序键是 (created_at DESC, id DESC)，游标表示“严格早于该行”。
 */

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 512;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/u;

export interface TaskListFilter {
  /** null 表示没有 Project 的人工事项（inbox=true）。 */
  readonly projectId: string | null;
}

export interface TaskListCursor {
  readonly filter: TaskListFilter;
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeTaskListCursor(cursor: TaskListCursor): string {
  const payload = JSON.stringify({
    v: CURSOR_VERSION,
    filter: { project_id: cursor.filter.projectId, inbox: cursor.filter.projectId === null },
    created_at: cursor.createdAt.toISOString(),
    id: cursor.id,
  });

  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * 解码并校验游标；格式非法、版本不支持或与当前过滤条件不一致都按 INVALID_CURSOR 拒绝。
 */
export function decodeTaskListCursor(raw: string, filter: TaskListFilter): TaskListCursor {
  if (raw.length > MAX_CURSOR_LENGTH) {
    throw invalidCursor('cursor', '游标过长；请使用上一次列表响应返回的 next_cursor。');
  }

  const decoded = decodePayload(raw);

  if (decoded === undefined) {
    throw invalidCursor('cursor', '游标无法解析；请使用上一次列表响应返回的 next_cursor。');
  }

  if (decoded.filter.project_id !== filter.projectId) {
    throw invalidCursor(
      'cursor',
      '游标与当前过滤条件不一致；换过滤条件后必须从第一页重新查询。',
    );
  }

  return { filter, createdAt: decoded.created_at, id: decoded.id };
}

interface DecodedCursor {
  readonly filter: { readonly project_id: string | null };
  readonly created_at: Date;
  readonly id: string;
}

function decodePayload(raw: string): DecodedCursor | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const candidate = parsed as Record<string, unknown>;
  const filter = candidate.filter;
  const createdAt = candidate.created_at;
  const id = candidate.id;

  if (candidate.v !== CURSOR_VERSION || typeof filter !== 'object' || filter === null) {
    return undefined;
  }

  const projectId = (filter as Record<string, unknown>).project_id;

  if (typeof projectId !== 'string' && projectId !== null) {
    return undefined;
  }

  if (projectId !== null && !isUuid(projectId)) {
    return undefined;
  }

  if (typeof createdAt !== 'string' || !TIMESTAMP_PATTERN.test(createdAt)) {
    return undefined;
  }

  if (typeof id !== 'string' || !isUuid(id)) {
    return undefined;
  }

  const parsedDate = new Date(createdAt);

  if (Number.isNaN(parsedDate.getTime())) {
    return undefined;
  }

  return { filter: { project_id: projectId }, created_at: parsedDate, id: id.toLowerCase() };
}