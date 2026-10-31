import type { RelayHttp } from "../core/http";
import { RelayApiError, RelayContractError } from "../core/errors";
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
 *   * `scopeKey` 说明它属于哪个工作轮次：轮次一变，版本从 1 重新开始，不是回退。
 */

export type RelaySessionTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface RelaySessionTodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: RelaySessionTodoStatus;
}

export interface RelaySessionTodoSnapshot {
  readonly sessionId: string;
  /** 工作轮次归属键；旧服务端没有这个字段时为空串，退化为按版本比较。 */
  readonly scopeKey: string;
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
  // `null` 是明确事实：这一轮还没有写过清单——与「读失败」「清单为空」都不同。
  if (snapshot === null || snapshot === undefined) return null;
  if (!isRecord(snapshot)) throw new RelayContractError("会话待办快照不是对象");
  const { sessionId, scopeKey, version, items, inProgressLimit, updatedAt } = snapshot;
  if (typeof sessionId !== "string" || typeof version !== "number" ||
      typeof inProgressLimit !== "number" || typeof updatedAt !== "string" ||
      !Array.isArray(items)) {
    throw new RelayContractError("会话待办快照字段不完整");
  }
  const parsed = items.map(itemFrom);
  if (parsed.some((item) => item === null)) throw new RelayContractError("会话待办条目不可读");
  return { sessionId, scopeKey: typeof scopeKey === "string" ? scopeKey : "",
    version, items: parsed as readonly RelaySessionTodoItem[], inProgressLimit, updatedAt };
}

export async function getAssistSessionTodos(http: RelayHttp,
  sessionId: string): Promise<RelaySessionTodoSnapshot | null> {
  try {
    const body = await http.request(http.workspacePath(`/assist-sessions/${sessionId}/todos`));
    return sessionTodoSnapshotFrom(body);
  } catch (caught) {
    throw await sessionTodoReadError(http, sessionId, caught);
  }
}

/**
 * 待办读取失败的定位（2026-10-30）。
 *
 * 同一个 404 有两种含义：桌面端连的 API 构建早于本路由（Fastify 默认 404，没有 Relay
 * 的 code，客户端只能拿到 HTTP_ERROR），或这条会话在当前 Workspace 下不可见
 * （RESOURCE_NOT_FOUND）。都说成「读取失败」，用户会以为会话内容被删了。
 */
async function sessionTodoReadError(http: RelayHttp, sessionId: string,
  caught: unknown): Promise<unknown> {
  if (!(caught instanceof RelayApiError) || caught.problem.status !== 404) return caught;
  // 已经带 Relay code 的 404 是服务端的明确语义（会话不可见），原样上抛。
  if (caught.problem.code !== "HTTP_ERROR") return caught;
  /*
   * 无 Relay code 的 404（2026-10-30 二修）：只能说明「这个 URL 没有匹配到已注册路由」，
   * 不能直接断言服务端版本旧——base URL/前缀写错、反代改写路径都会得到同一个结果。
   * 用同一会话的既有读取接口做对照探测，把两种可能分开，并把探测事实写进文案。
   */
  try {
    await http.request(http.workspacePath(`/assist-sessions/${sessionId}`));
    return new RelayContractError("待办接口未注册（对照探测：同一会话的既有接口可用）。"
      + "GET /assist-sessions/:id/todos 在服务端没有匹配路由，说明服务端构建早于该路由。"
      + "请把桌面端连接的 API 升级到与本仓库同版本后重试。");
  } catch (probe) {
    if (probe instanceof RelayApiError && probe.problem.status === 404
        && probe.problem.code === "HTTP_ERROR") {
      return new RelayContractError("会话接口与待办接口都返回未注册的 404。"
        + "这更像 API 基础地址或路径前缀不对，而不是版本问题；请核对桌面端配置的 API 地址。");
    }
    return new RelayContractError("待办接口返回未注册的 404，对照探测也未能确认服务端版本（"
      + (probe instanceof Error ? probe.message : String(probe)) + "）。");
  }
}