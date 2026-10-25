import type { DecimalRevision } from "../../types";
import type { InteractionMode } from "../../types";
import { RelayHttp } from "../core/http";
import { RelayTransportError } from "../core/errors";
import { array, nullableString, object } from "../core/primitives";
import { commandEnvelopeFrom } from "../parse/projects";
import { acceptanceFrom, completionEvidenceFrom, completionFrom, dependencyFrom, reopenFrom, taskAcceptanceRevisionFrom, taskCheckPlanPreviewFrom, taskCreationFrom, taskFrom, taskMutationFrom, todayFrom } from "../parse/tasks";
import { informationCommand } from "./information";
import type { RelayCommandEnvelope } from "../dtos/projects";
import type { RelayCompletion, RelayCompletionEvidence, RelayReopen, RelayTaskAcceptanceRevision, RelayTaskAcceptanceRevisionInput, RelayTaskCheckPlanPreview, RelayTaskCreation, RelayTaskDetail, RelayTaskMutation, RelayTaskPage, RelayTaskSummary, RelayToday, RelayTodayPriority } from "../dtos/tasks";

/** 仅返回首分页；需要完整项目任务集时应跟随 getProjectTasksPage 的 nextCursor。 */
export async function getProjectTasks(http: RelayHttp, projectId: string): Promise<readonly RelayTaskSummary[]> {
  return (await getProjectTasksPage(http, projectId)).items;
}

export async function getProjectTasksPage(http: RelayHttp, projectId: string, cursor: string | null = null,
  limit?: number): Promise<RelayTaskPage> {
  const query = new URLSearchParams({ project_id: projectId });
  if (cursor !== null) query.set("cursor", cursor);
  if (limit !== undefined) query.set("limit", String(limit));
  const body = await http.request(`${http.workspacePath("/tasks")}?${query.toString()}`);
  const record = object(body, "task list");
  return {
    items: array(record, "items", "task list").map((item) => taskFrom(item)),
    nextCursor: nullableString(record, "next_cursor", "task list")
  };
}

export async function getInboxTasksPage(http: RelayHttp, cursor: string | null = null): Promise<RelayTaskPage> {
  const query = new URLSearchParams({ inbox: "true" });
  if (cursor !== null) query.set("cursor", cursor);
  const record = object(await http.request(`${http.workspacePath("/tasks")}?${query.toString()}`), "inbox task list");
  return { items: array(record, "items", "inbox task list").map((item) => taskFrom(item)),
    nextCursor: nullableString(record, "next_cursor", "inbox task list") };
}

export async function getWorkspaceTasksPage(http: RelayHttp, cursor: string | null = null): Promise<RelayTaskPage> {
  const query = new URLSearchParams({ scope: "all" });
  if (cursor !== null) query.set("cursor", cursor);
  const record = object(await http.request(`${http.workspacePath("/tasks")}?${query.toString()}`), "workspace task list");
  return { items: array(record, "items", "workspace task list").map(taskFrom),
    nextCursor: nullableString(record, "next_cursor", "workspace task list") };
}

export async function getTask(http: RelayHttp, taskId: string): Promise<RelayTaskDetail> {
  const body = await http.request(http.workspacePath(`/tasks/${encodeURIComponent(taskId)}`));
  const task = taskFrom(body);
  const record = object(body, "task");
  return {
    ...task,
    acceptance: acceptanceFrom(object(record.acceptance, "task.acceptance")),
    dependencies: array(record, "dependencies", "task").map((item) => dependencyFrom(item))
  };
}

export async function getCompletionEvidence(http: RelayHttp, completionId: string): Promise<RelayCompletionEvidence> {
  return completionEvidenceFrom(await http.request(http.workspacePath(
    `/completion-records/${encodeURIComponent(completionId)}`)));
}

export async function getTaskCheckPlanPreview(http: RelayHttp, taskId: string): Promise<RelayTaskCheckPlanPreview> {
  return taskCheckPlanPreviewFrom(await http.request(http.workspacePath(
    `/tasks/${encodeURIComponent(taskId)}/check-plan-preview`)), taskId);
}

export async function getToday(http: RelayHttp, date: string, timezone: string): Promise<RelayToday> {
  const query = new URLSearchParams({ date, timezone });
  return todayFrom(await http.request(`${http.workspacePath("/today")}?${query.toString()}`));
}

export async function setTaskSelection(http: RelayHttp, input: { taskId: string; commandId: string; expectedRevision: DecimalRevision; pin: boolean; laterLocalDate: string | null; timezone: string | null }): Promise<RelayCommandEnvelope> {
  return commandEnvelopeFrom(await http.request(http.workspacePath(`/task-selections/${encodeURIComponent(input.taskId)}`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision,
      pin: input.pin, later_local_date: input.laterLocalDate, timezone: input.timezone })
  }, 200));
}

export async function setFocusSelection(http: RelayHttp, input: { commandId: string; expectedRevision: DecimalRevision; date: string; timezone: string; targetKind: "GOAL" | "PROJECT" | "TASK" | null; targetId: string | null }): Promise<RelayCommandEnvelope> {
  return commandEnvelopeFrom(await http.request(http.workspacePath("/focus-selections"), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision,
      date: input.date, timezone: input.timezone, target_kind: input.targetKind, target_id: input.targetId })
  }, 200));
}

export async function setTaskPlanningMetadata(http: RelayHttp, input: { taskId: string; commandId: string; expectedRevision: DecimalRevision; priority: RelayTodayPriority | null; dueLocalDate: string | null; timezone: string | null }): Promise<RelayCommandEnvelope> {
  return commandEnvelopeFrom(await http.request(http.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/planning-metadata`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision,
      priority: input.priority, due_local_date: input.dueLocalDate, timezone: input.timezone })
  }, 200));
}

export async function createTask(http: RelayHttp, input: { readonly commandId: string; readonly projectId: string | null; readonly title: string; readonly objective: string; readonly mode: InteractionMode; /** 每行一条验收标准；criterion_id 与 method 由服务端补齐。 */ readonly criteria: readonly string[]; }): Promise<RelayTaskCreation> {
  const body = await http.request(http.workspacePath("/tasks"), {
    method: "POST",
    body: JSON.stringify({
      command_id: input.commandId,
      ...(input.projectId === null ? {} : { project_id: input.projectId }),
      title: input.title,
      objective: input.objective,
      mode: input.mode,
      criteria: input.criteria.map((statement) => ({ statement }))
    })
  });
  return taskCreationFrom(commandEnvelopeFrom(body).result);
}

export async function reviseTaskAcceptance(http: RelayHttp, input: RelayTaskAcceptanceRevisionInput): Promise<RelayTaskAcceptanceRevision> {
  const body = await informationCommand(http, `/tasks/${encodeURIComponent(input.taskId)}/acceptance`, {
    command_id: input.commandId, expected_revision: input.expectedRevision,
    expected_acceptance_revision: input.expectedAcceptanceRevision,
    criteria: input.criteria.map(criterion => ({
      ...(criterion.criterionId === undefined ? {} : { criterion_id: criterion.criterionId }),
      statement: criterion.statement, required: criterion.required, method: criterion.method,
      target_spec: criterion.targetSpec
    }))
  }, 200);
  return taskAcceptanceRevisionFrom(body.result);
}

export async function markTaskReady(http: RelayHttp, input: { readonly taskId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision; }): Promise<RelayTaskMutation> {
  const body = await http.request(http.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/ready`), {
    method: "POST",
    body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision })
  });
  return taskMutationFrom(commandEnvelopeFrom(body).result);
}

/**
   * POST /tasks/{id}/dependency-links：新增一条任务依赖。
   * expected_revision 必须是上一步返回的 revision；BLOCKS 表示前置未完成会阻塞本任务。
   */
export async function addTaskDependency(http: RelayHttp, input: { readonly taskId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision; readonly dependsOnTaskId: string; readonly dependencyKind: "BLOCKS" | "INFORMS"; }): Promise<RelayTaskMutation> {
  const body = await http.request(
    http.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/dependency-links`),
    {
      method: "POST",
      body: JSON.stringify({
        command_id: input.commandId,
        expected_revision: input.expectedRevision,
        depends_on_task_id: input.dependsOnTaskId,
        dependency_kind: input.dependencyKind
      })
    }
  );
  return taskMutationFrom(commandEnvelopeFrom(body).result);
}

export async function startHumanTask(http: RelayHttp, input: { readonly taskId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision; }): Promise<RelayTaskMutation> {
  const body = await http.request(http.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/start`), {
    method: "POST",
    body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision })
  });
  return taskMutationFrom(commandEnvelopeFrom(body).result);
}

export async function completeHumanTask(http: RelayHttp, input: { readonly taskId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision; readonly acceptanceRevision: DecimalRevision; readonly artifactVersionIds: readonly string[]; readonly statement: string; readonly acceptedCriterionIds: readonly string[]; readonly reason: string | null; }): Promise<RelayCompletion> {
  const body = await http.request(http.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/complete`), {
    method: "POST",
    body: JSON.stringify({
      command_id: input.commandId,
      expected_revision: input.expectedRevision,
      acceptance_revision: input.acceptanceRevision,
      ...(input.artifactVersionIds.length === 0 ? {} : { artifact_version_ids: [...input.artifactVersionIds] }),
      acceptance: {
        statement: input.statement,
        accepted_criterion_ids: [...input.acceptedCriterionIds],
        ...(input.reason === null ? {} : { reason: input.reason })
      }
    })
  });
  // 禅道 #28（DEV-0132）：解析成功不等于关联正确。回包只核对原 command_id 与确切 Task；
  // 身份对不上时不能把结果当作本次提交的完成事实（原始命令是否落库仍未知，恢复凭据由
  // 调用方 PendingCompletion 保留）。验收版本、完成状态与产物集合由组件按原请求核对。
  const envelope = commandEnvelopeFrom(body);
  if (envelope.commandId !== input.commandId) {
    throw new Error(`完成响应的 command_id（${envelope.commandId}）与本次提交的 ${input.commandId} 不符；请按原 command ID 查询回执，不能据此宣告完成。`);
  }
  const result = completionFrom(envelope.result);
  if (result.taskId !== input.taskId) {
    throw new Error(`完成响应的结果属于任务 ${result.taskId}，不是本次任务 ${input.taskId}；请按原 command ID 查询回执，不能据此宣告完成。`);
  }
  return result;
}

export async function reopenTask(http: RelayHttp, input: { readonly taskId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision; readonly reason: string; }): Promise<RelayReopen> {
  const body = await http.request(http.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/reopen`), {
    method: "POST",
    body: JSON.stringify({
      command_id: input.commandId,
      expected_revision: input.expectedRevision,
      reason: input.reason
    })
  });
  const envelope = commandEnvelopeFrom(body);
  if (envelope.commandId !== input.commandId) {
    throw new RelayTransportError("重开响应与原 command_id 不匹配；请查询原命令回执。");
  }
  return reopenFrom(envelope.result);
}
