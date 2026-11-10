import type { RelayHttp } from "../core/http";
import { RelayContractError } from "../core/errors";
import { array, decimal, nullableString, object, string } from "../core/primitives";

export interface RelayTaskRunSummary {
  readonly id: string; readonly taskId: string; readonly status: string; readonly revision: string;
  readonly retryOfRunId: string | null; readonly createdAt: string; readonly terminalAt: string | null;
}
export interface RelayTaskRunPage {
  readonly items: readonly RelayTaskRunSummary[]; readonly nextCursor: string | null;
}
export async function getTaskRunsPage(http: RelayHttp, taskId: string, cursor: string | null): Promise<RelayTaskRunPage> {
  const query = new URLSearchParams({ limit: "20" });
  if (cursor !== null) query.set("cursor", cursor);
  const body = object(await http.request(http.workspacePath(`/tasks/${encodeURIComponent(taskId)}/runs?${query}`)), "task runs");
  const items = array(body, "items", "task runs").map((value) => {
    const row = object(value, "task run");
    const item = { id: string(row, "id", "task run"), taskId: string(row, "task_id", "task run"),
      status: string(row, "status", "task run"), revision: decimal(row, "revision", "task run"),
      retryOfRunId: nullableString(row, "retry_of_run_id", "task run"),
      createdAt: string(row, "created_at", "task run"), terminalAt: nullableString(row, "terminal_at", "task run") };
    if (item.taskId !== taskId) throw new RelayContractError("执行历史的任务归属不匹配。");
    return item;
  });
  return { items, nextCursor: nullableString(body, "next_cursor", "task runs") };
}
