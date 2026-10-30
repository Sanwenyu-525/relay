import type { RelayHttp } from "../core/http";
import { RelayContractError } from "../core/errors";
import { isRecord } from "../core/primitives";

/**
 * 会话待办清单的读取投影（ADR-038，2026-10-30）。
 *
 * 只读：清单只有一个写入口，就是模型侧的 `todo_write` 工具。界面不提供「勾选完成」这类
 * 本地写入——那会让「谁改的进度」失去唯一来源，也会让服务端版本与用户看到的东西打架。
 *
 * 三类事实严格分开：
 *   * `items[].status` 来自服务端权威快照，不是模型在正文里的自述；
 *   * `version` / `updatedAt` 说明这份清单是哪一版、什么时候写的；
 *   * 「待办」本身不构成执行或验收事实——它只描述计划中的步骤。
 */

export type RelaySessionTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface RelaySessionTodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: RelaySessionTodoStatus;
}

export interface RelaySessionTodoSnapshot {
  readonly sessionId: string;
  readonly version: number;
  readonly items: readonly RelaySessionTodoItem[];
  readonly inProgressLimit: number;
  readonly updatedAt: string;
}

const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed", "cancelled"]);

function itemFrom(value: unknown): RelaySessionTodoItem | null {
  if (!isRecord(value)) return null;
  const { id, content, status } = value;
  if (typeof id !== "string" || id === "" || typeof content !== "string") return null;
  if (typeof status !== "string" || !STATUSES.has(status)) return null;
  return { id, content, status: status as RelaySessionTodoStatus };
}

export function sessionTodoSnapshotFrom(body: unknown): RelaySessionTodoSnapshot | null {
  if (!isRecord(body)) throw new RelayContractError("会话待办读取缺少响应体");
  const snapshot = body.snapshot;
  // `null` 是明确事实：这个会话还没有写过清单——与「读失败」「清单为空」都不同。
  if (snapshot === null || snapshot === undefined) return null;
  if (!isRecord(snapshot)) throw new RelayContractError("会话待办快照不是对象");
  const { sessionId, version, items, inProgressLimit, updatedAt } = snapshot;
  if (typeof sessionId !== "string" || typeof version !== "number" ||
      typeof inProgressLimit !== "number" || typeof updatedAt !== "string" ||
      !Array.isArray(items)) {
    throw new RelayContractError("会话待办快照字段不完整");
  }
  const parsed = items.map(itemFrom);
  if (parsed.some((item) => item === null)) throw new RelayContractError("会话待办条目不可读");
  return { sessionId, version, items: parsed as readonly RelaySessionTodoItem[],
    inProgressLimit, updatedAt };
}

export async function getAssistSessionTodos(http: RelayHttp,
  sessionId: string): Promise<RelaySessionTodoSnapshot | null> {
  const body = await http.request(http.workspacePath(`/assist-sessions/${sessionId}/todos`));
  return sessionTodoSnapshotFrom(body);
}