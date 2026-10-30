import { randomUUID } from 'node:crypto';

import type { JsonObject } from '../infrastructure/json.js';
import type { ModelToolSpec } from '../workflow/fake-model-port.js';

/**
 * 会话级 Agent Todo List 的协议层（ADR-038，2026-10-30）。
 *
 * 三件事在这里一次定义清楚，避免三处各写一份：
 *   * 模型能写入什么（`todo_write` 的参数 schema 与全量快照语义）；
 *   * 服务端接受什么（长度、条数、重复项、状态值、并行条数上限）；
 *   * 模型在下一轮看到什么（`buildTodoContextBlock` 的注入正文）。
 *
 * 语义边界（不可让步）：
 *   · 全量复写：一次调用就是这一版清单的全部项目，没有增量补丁，也不做「按名字猜合并」；
 *   · 清单是**进度记录**，不是执行授权：写入它不创建 Run、不改变 Task/Run/Verification 的
 *     任何完成事实，也不重启已经停止的任务；
 *   · 项目内部稳定身份（`id`）由服务端维护：模型可以带回来，但不是必填——不带时按内容
 *     与上一版对齐，对齐不上才新建。这样列表在多次全量覆写之间不会整排换 key，
 *     前端的展开状态与「正在做第几步」也就不会跳。
 */

export const TODO_WRITE_TOOL_NAME = 'todo_write';

export const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const TODO_ITEMS_MIN = 1;
export const TODO_ITEMS_MAX = 50;
export const TODO_CONTENT_MAX_LENGTH = 200;
/** 普通会话默认只允许一项进行中：长任务最容易失败的方式是同时开五条线。 */
export const TODO_PARALLEL_LIMIT_DEFAULT = 1;
export const TODO_PARALLEL_LIMIT_MAX = 8;
/** 注入正文最多逐条列出这么多项；更长的清单只列摘要，避免每轮都重复喂一份长列表。 */
export const TODO_PROMPT_ITEM_LIMIT = 24;
/** 工具结果里回传给模型的条目上限（模型只需要看到自己刚写下的东西）。 */
export const TODO_RESULT_ITEM_LIMIT = 20;

export interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: TodoStatus;
}

export interface TodoSnapshot {
  readonly sessionId: string;
  readonly version: number;
  readonly items: readonly TodoItem[];
  readonly inProgressLimit: number;
  readonly updatedAt: string;
}

export interface TodoCounts {
  readonly total: number;
  readonly pending: number;
  readonly inProgress: number;
  readonly completed: number;
  readonly cancelled: number;
}

/** 类型化拒绝：原因进工具账本的 rejection_reason，说明进模型上下文，两者都不带正文快照。 */
export class TodoRequestRejected extends Error {
  constructor(readonly reason: string, detail: string) {
    super(detail);
    this.name = 'TodoRequestRejected';
  }
}

const STATUS_SET: ReadonlySet<string> = new Set(TODO_STATUSES);

export function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === 'string' && STATUS_SET.has(value);
}

/**
 * 并行条数上限：会话行上保存的值优先，其次进程配置，最后是默认 1。
 *
 * 配置入口刻意只做「读取」——写入路径在用户侧设置命令落地前不开放给模型，
 * 否则模型可以自己把闸门调宽。非法值一律回落默认，不放大。
 */
export function todoParallelLimit(raw: string | number | null | undefined): number {
  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== ''
    ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isInteger(numeric)) return TODO_PARALLEL_LIMIT_DEFAULT;
  return Math.min(Math.max(numeric, 1), TODO_PARALLEL_LIMIT_MAX);
}

export function todoParallelLimitFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return todoParallelLimit(env.RELAY_AGENT_TODO_PARALLEL_LIMIT);
}

/** 重复项判定口径：忽略大小写与多余空白，不做更激进的同义归并。 */
function duplicateKey(content: string): string {
  return content.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function todoCounts(items: readonly TodoItem[]): TodoCounts {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  let cancelled = 0;
  for (const item of items) {
    switch (item.status) {
      case 'pending': pending += 1; break;
      case 'in_progress': inProgress += 1; break;
      case 'completed': completed += 1; break;
      case 'cancelled': cancelled += 1; break;
    }
  }
  return { total: items.length, pending, inProgress, completed, cancelled };
}

/** 从 jsonb 里读回条目：脏数据不抛错，按不可读项丢弃——历史快照不该让整轮生成失败。 */
export function parseTodoItems(raw: unknown): readonly TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    const content = record.content;
    const status = record.status;
    if (typeof id !== 'string' || id === '' || typeof content !== 'string') continue;
    if (!isTodoStatus(status)) continue;
    items.push({ id, content, status });
  }
  return items;
}

/**
 * 校验并规范化一次全量快照。
 *
 * `previous` 是当前这一版快照的条目，只用于两件事：复用稳定身份、让「同一条待办」在
 * 版本之间保持同一个 id。它**不参与**合并语义——模型给什么就是什么。
 */
export function normalizeTodoItems(input: {
  readonly raw: unknown;
  readonly previous: readonly TodoItem[];
  readonly parallelLimit: number;
  readonly nextId?: () => string;
}): readonly TodoItem[] {
  const nextId = input.nextId ?? (() => randomUUID());
  const raw = input.raw;
  if (!Array.isArray(raw)) {
    throw new TodoRequestRejected('TODO_ITEMS_INVALID', 'items 必须是数组，且表示这一版的完整清单。');
  }
  if (raw.length < TODO_ITEMS_MIN) {
    throw new TodoRequestRejected('TODO_ITEMS_EMPTY',
      '这一版清单没有任何项目。要清空清单请写入一条已取消或已完成的收尾项，不要提交空数组。');
  }
  if (raw.length > TODO_ITEMS_MAX) {
    throw new TodoRequestRejected('TODO_ITEMS_TOO_MANY',
      `清单最多 ${TODO_ITEMS_MAX} 项，当前 ${raw.length} 项；请合并或删除。`);
  }
  const previousById = new Map(input.previous.map((item) => [item.id, item]));
  const previousByContent = new Map(input.previous.map((item) => [duplicateKey(item.content), item]));
  const usedIds = new Set<string>();
  const seenContent = new Set<string>();
  const items: TodoItem[] = [];
  let inProgress = 0;
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TodoRequestRejected('TODO_ITEM_INVALID', `第 ${index + 1} 项不是对象。`);
    }
    const record = entry as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content.trim() : '';
    if (content === '') {
      throw new TodoRequestRejected('TODO_CONTENT_EMPTY', `第 ${index + 1} 项缺少 content。`);
    }
    if (content.length > TODO_CONTENT_MAX_LENGTH) {
      throw new TodoRequestRejected('TODO_CONTENT_TOO_LONG',
        `第 ${index + 1} 项的 content 有 ${content.length} 字，超过 ${TODO_CONTENT_MAX_LENGTH} 字上限。`);
    }
    const status = record.status;
    if (!isTodoStatus(status)) {
      throw new TodoRequestRejected('TODO_STATUS_INVALID',
        `第 ${index + 1} 项的 status 不是 ${TODO_STATUSES.join(' / ')} 之一。`);
    }
    const key = duplicateKey(content);
    if (seenContent.has(key)) {
      throw new TodoRequestRejected('TODO_DUPLICATE_CONTENT',
        `第 ${index + 1} 项与前面某一项内容重复：${content}`);
    }
    seenContent.add(key);
    if (status === 'in_progress') {
      inProgress += 1;
      if (inProgress > input.parallelLimit) {
        throw new TodoRequestRejected('TODO_IN_PROGRESS_LIMIT',
          `同时进行中的项目最多 ${input.parallelLimit} 项；请先把上一项标成 completed 或 cancelled。`);
      }
    }
    const declaredId = typeof record.id === 'string' && record.id.trim() !== '' ? record.id.trim() : null;
    let id = declaredId !== null && previousById.has(declaredId) && !usedIds.has(declaredId)
      ? declaredId : null;
    if (id === null) {
      const matched = previousByContent.get(key);
      if (matched !== undefined && !usedIds.has(matched.id)) id = matched.id;
    }
    if (id === null) id = nextId();
    usedIds.add(id);
    items.push({ id, content, status });
  }
  return items;
}

function statusLabel(status: TodoStatus): string {
  switch (status) {
    case 'pending': return '待办';
    case 'in_progress': return '进行中';
    case 'completed': return '已完成';
    case 'cancelled': return '已取消';
  }
}

/**
 * 注入给模型的当前清单。
 *
 * 每次真实模型调用前重新从数据库读一遍，所以上下文压缩、checkpoint 恢复、进程重启之后
 * 拿到的都是同一份权威快照——不需要从历史消息里找「上一版清单」，也不会两份并存。
 * 空清单返回空字符串：没写过清单的会话一字不加，不花一分 token。
 */
export function buildTodoContextBlock(snapshot: TodoSnapshot): string {
  if (snapshot.items.length === 0) return '';
  const counts = todoCounts(snapshot.items);
  const lines: string[] = [
    `【本会话待办清单｜服务端权威快照 v${snapshot.version}】`,
    `已完成 ${counts.completed}/${counts.total}，进行中 ${counts.inProgress} 项，` +
      `待办 ${counts.pending} 项，已取消 ${counts.cancelled} 项。`,
  ];
  const shown = snapshot.items.slice(0, TODO_PROMPT_ITEM_LIMIT);
  for (const item of shown) lines.push(`- [${statusLabel(item.status)}] ${item.content}`);
  if (snapshot.items.length > shown.length) {
    lines.push(`- …另有 ${snapshot.items.length - shown.length} 项未逐条列出。`);
  }
  lines.push('清单只记录进度，不授予执行权，也不改变任何 Task / Run / 验收结论。');
  lines.push(`仅在进度真实变化时调用 ${TODO_WRITE_TOOL_NAME} 全量复写（一次给出完整清单），` +
    `同时进行中最多 ${snapshot.inProgressLimit} 项；不要用正文复述整份清单。`);
  return lines.join('\n');
}

/** 工具结果：模型只需要看到它刚写下的这一版，以及版本号用于后续 CAS。 */
export function buildTodoToolResult(snapshot: TodoSnapshot): string {
  const counts = todoCounts(snapshot.items);
  const items = snapshot.items.slice(0, TODO_RESULT_ITEM_LIMIT);
  return JSON.stringify({
    status: 'OK',
    version: snapshot.version,
    counts,
    in_progress_limit: snapshot.inProgressLimit,
    items: items.map((item) => ({ id: item.id, content: item.content, status: item.status })),
    ...(snapshot.items.length > items.length
      ? { truncated_items: snapshot.items.length - items.length } : {}),
  });
}

export function todoWriteToolSpec(): ModelToolSpec {
  const parameters: JsonObject = {
    type: 'object',
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        minItems: TODO_ITEMS_MIN,
        maxItems: TODO_ITEMS_MAX,
        description: '这一版的**完整**清单（全量复写，不是增量补丁）。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', minLength: 1, maxLength: TODO_CONTENT_MAX_LENGTH,
              description: '一步可核对的动作，不写「继续推进」这类无法验收的说法。' },
            status: { type: 'string', enum: [...TODO_STATUSES] },
            id: { type: 'string',
              description: '可选：上一版里同一项的 id；省略时服务端按内容对齐。' },
          },
          required: ['content', 'status'],
        },
      },
      expected_version: {
        type: 'integer',
        minimum: 1,
        description: '可选：你读到的那一版版本号。与当前版本不一致时整次写入被拒，避免覆盖别人的新快照。',
      },
    },
    required: ['items'],
  };
  return {
    name: TODO_WRITE_TOOL_NAME,
    description: '维护本会话的待办清单：用一份完整清单全量复写当前进度。用来让长任务的方向可见、' +
      '可恢复；它只记录进度，不创建执行、不改变任务或验收状态。开始一项时标 in_progress，' +
      '做完标 completed，放弃标 cancelled。',
    parameters,
  };
}

/** 读回行 → 对外投影。bigint 列由 pg 以字符串返回，这里显式转成 number。 */
export function projectTodoSnapshot(row: {
  readonly session_id: string;
  readonly version: string | number;
  readonly items: unknown;
  readonly in_progress_limit: number | string;
  readonly updated_at: Date | string;
}): TodoSnapshot {
  const updatedAt = row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at;
  return {
    sessionId: row.session_id,
    version: Number(row.version),
    items: parseTodoItems(row.items),
    inProgressLimit: todoParallelLimit(row.in_progress_limit),
    updatedAt,
  };
}