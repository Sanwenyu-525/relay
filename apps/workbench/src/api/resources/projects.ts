import { blueprintProposalFrom } from "../blueprintDtos";
import { goalFrom } from "../blueprintDtos";
import { projectGoalListFrom } from "../blueprintDtos";
import type { DecimalRevision } from "../../types";
import type { RelayBlueprintDraft } from "../blueprintDtos";
import type { RelayBlueprintProposal } from "../blueprintDtos";
import type { RelayGoal } from "../blueprintDtos";
import type { RelayProjectGoal } from "../blueprintDtos";
import { RelayTransportError } from "../core/errors";
import { RelayHttp } from "../core/http";
import { array, nullableString, object } from "../core/primitives";
import { activityPageFrom, commandEnvelopeFrom, continuationComparisonFrom, continuationPointSummaryFrom, goalCreationFrom, projectCreationFrom, projectFrom, projectGoalLinkFrom, projectListItemFrom, projectStateFrom, viewConfigurationFrom } from "../parse/projects";
import type { RelayActivityFilter, RelayActivityPage, RelayCommandEnvelope, RelayContinuationComparison, RelayContinuationPointSummary, RelayGoalCreation, RelayProject, RelayProjectCreation, RelayProjectGoalLink, RelayProjectPage, RelayProjectState, RelayViewConfiguration, RelayViewKind } from "../dtos/projects";

export async function getProject(http: RelayHttp, projectId: string): Promise<RelayProject> {
  return projectFrom(await http.request(http.workspacePath(`/projects/${encodeURIComponent(projectId)}`)));
}

export async function getProjectsPage(http: RelayHttp, status: "active" | "archived" | "all", cursor: string | null = null): Promise<RelayProjectPage> {
  const query = new URLSearchParams({ status });
  if (cursor !== null) query.set("cursor", cursor);
  const record = object(await http.request(`${http.workspacePath("/projects")}?${query.toString()}`), "project list");
  return { items: array(record, "items", "project list").map(projectListItemFrom),
    nextCursor: nullableString(record, "next_cursor", "project list") };
}

export async function archiveProject(http: RelayHttp, input: { readonly projectId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision }): Promise<RelayCommandEnvelope> {
  const body = await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(input.projectId)}/archive`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId,
      expected_revision: input.expectedRevision })
  }, 200);
  try { return commandEnvelopeFrom(body); }
  catch { throw new RelayTransportError("归档命令响应内容无法核对，请查询原 command ID 回执。"); }
}

/** 撤销归档（ADR-027 的反向命令）：只把 archived_at 写回 NULL，不恢复任何下游事实。 */
export async function unarchiveProject(http: RelayHttp, input: { readonly projectId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision }): Promise<RelayCommandEnvelope> {
  const body = await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(input.projectId)}/unarchive`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId,
      expected_revision: input.expectedRevision })
  }, 200);
  try { return commandEnvelopeFrom(body); }
  catch { throw new RelayTransportError("撤销归档的命令响应无法核对，请查询原 command ID 回执。"); }
}

export async function getViewConfiguration(http: RelayHttp, projectId: string): Promise<RelayViewConfiguration> {
  return viewConfigurationFrom(await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(projectId)}/view-configuration`)));
}

export async function setViewConfiguration(http: RelayHttp, input: { readonly projectId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision; readonly kind: RelayViewKind }): Promise<RelayCommandEnvelope> {
  return commandEnvelopeFrom(await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(input.projectId)}/view-configuration`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId,
      expected_revision: input.expectedRevision, kind: input.kind })
  }, 200));
}

export async function getContinuationPoints(http: RelayHttp, projectId: string): Promise<readonly RelayContinuationPointSummary[]> {
  return array(object(await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(projectId)}/continuation-points`)),
  "continuation points"), "items", "continuation points").map(continuationPointSummaryFrom);
}

export async function captureContinuationPoint(http: RelayHttp, input: { readonly projectId: string; readonly commandId: string; readonly name: string; readonly note: string | null }): Promise<RelayCommandEnvelope> {
  return commandEnvelopeFrom(await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(input.projectId)}/continuation-points`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId,
      name: input.name, note: input.note })
  }, 201));
}

export async function compareContinuationPoint(http: RelayHttp, projectId: string, pointId: string): Promise<RelayContinuationComparison> {
  return continuationComparisonFrom(await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(projectId)}/continuation-points/${encodeURIComponent(pointId)}` +
    "/comparison")));
}

export async function getProjectGoals(http: RelayHttp, projectId: string): Promise<readonly RelayProjectGoal[]> {
  return projectGoalListFrom(await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(projectId)}/goals`)));
}

export async function getGoal(http: RelayHttp, goalId: string): Promise<RelayGoal> {
  return goalFrom(await http.request(http.workspacePath(`/goals/${encodeURIComponent(goalId)}`)));
}

export async function getBlueprintProposals(http: RelayHttp, projectId: string): Promise<readonly RelayBlueprintProposal[]> {
  const body = object(await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(projectId)}/blueprint-proposals`)), "blueprint proposals");
  return array(body, "items", "blueprint proposals").map(blueprintProposalFrom);
}

export async function getBlueprintProposal(http: RelayHttp, projectId: string, proposalId: string): Promise<RelayBlueprintProposal> {
  return blueprintProposalFrom(await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(projectId)}/blueprint-proposals/${encodeURIComponent(proposalId)}`)));
}

export async function createBlueprintProposal(http: RelayHttp, input: { readonly projectId: string; readonly commandId: string; readonly expectedProjectRevision: DecimalRevision; readonly expectedStateRevision: DecimalRevision; readonly expectedViewRevision: DecimalRevision; readonly draft: RelayBlueprintDraft; readonly supersedesProposalId: string | null }): Promise<RelayCommandEnvelope> {
  return commandEnvelopeFrom(await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(input.projectId)}/blueprint-proposals`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId,
      expected_project_revision: input.expectedProjectRevision,
      expected_state_revision: input.expectedStateRevision,
      expected_view_revision: input.expectedViewRevision, draft: input.draft,
      ...(input.supersedesProposalId ? { supersedes_proposal_id: input.supersedesProposalId } : {}) })
  }, 201));
}

export async function applyBlueprintProposal(http: RelayHttp, input: { readonly projectId: string; readonly proposalId: string; readonly commandId: string; readonly candidateSha256: string; readonly expectedProjectRevision: DecimalRevision; readonly expectedStateRevision: DecimalRevision; readonly expectedViewRevision: DecimalRevision }): Promise<RelayCommandEnvelope> {
  return commandEnvelopeFrom(await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(input.projectId)}/blueprint-proposals/${encodeURIComponent(input.proposalId)}/apply`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId,
      candidate_sha256: input.candidateSha256,
      expected_project_revision: input.expectedProjectRevision,
      expected_state_revision: input.expectedStateRevision,
      expected_view_revision: input.expectedViewRevision })
  }, 200));
}

export async function rejectBlueprintProposal(http: RelayHttp, input: { readonly projectId: string; readonly proposalId: string; readonly commandId: string; readonly candidateSha256: string }): Promise<RelayCommandEnvelope> {
  return commandEnvelopeFrom(await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(input.projectId)}/blueprint-proposals/${encodeURIComponent(input.proposalId)}/reject`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId,
      candidate_sha256: input.candidateSha256 })
  }, 200));
}

export async function getActivities(http: RelayHttp, filter: RelayActivityFilter = {}): Promise<RelayActivityPage> {
  const query = new URLSearchParams();
  if (filter.projectId) query.set("project_id", filter.projectId);
  if (filter.taskId) query.set("task_id", filter.taskId);
  if (filter.runId) query.set("run_id", filter.runId);
  if (filter.from) query.set("from", filter.from);
  if (filter.to) query.set("to", filter.to);
  if (filter.cursor) query.set("cursor", filter.cursor);
  if (filter.limit) query.set("limit", String(filter.limit));
  const suffix = query.size ? `?${query.toString()}` : "";
  return activityPageFrom(await http.request(`${http.workspacePath("/activities")}${suffix}`));
}

export async function createProject(http: RelayHttp, input: { readonly commandId: string; readonly title: string; readonly projectType: string; }): Promise<RelayProjectCreation> {
  const body = await http.request(http.workspacePath("/projects"), {
    method: "POST",
    body: JSON.stringify({
      command_id: input.commandId,
      title: input.title,
      project_type: input.projectType
    })
  });
  return projectCreationFrom(commandEnvelopeFrom(body).result);
}

/**
   * CreateGoal：Goal 是 Workspace 级事实，只保存标题与说明。
   * 与 Project 的关联是独立命令（LinkProjectGoal），这里刻意不隐式关联任何 Project，
   * 也不由前端代填项目——作用域与关联仍归各自 Owner。
   */
export async function createGoal(http: RelayHttp, input: { readonly commandId: string; readonly title: string; readonly description: string; }): Promise<RelayGoalCreation> {
  const body = await http.request(http.workspacePath("/goals"), {
    method: "POST",
    body: JSON.stringify({
      command_id: input.commandId,
      title: input.title,
      description: input.description
    })
  });
  return goalCreationFrom(commandEnvelopeFrom(body).result);
}

/**
   * LinkProjectGoal：把 Goal 关联到 Project。与 CreateGoal 是两个命令——
   * 创建 Goal 不隐式关联任何 Project，关联必须由用户明确发起。
   * expectedRevision 是 Project 当前修订：服务端按它做 CAS，修订变化时返回冲突而不是覆盖。
   */
export async function linkProjectGoal(http: RelayHttp, input: { readonly projectId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision; readonly goalId: string; }): Promise<RelayProjectGoalLink> {
  const body = await http.request(
    http.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/goal-links`), {
      method: "POST",
      body: JSON.stringify({
        command_id: input.commandId,
        expected_revision: input.expectedRevision,
        goal_id: input.goalId
      })
    });
  return projectGoalLinkFrom(commandEnvelopeFrom(body).result);
}

export async function getProjectState(http: RelayHttp, projectId: string): Promise<RelayProjectState> {
  return projectStateFrom(
    await http.request(http.workspacePath(`/projects/${encodeURIComponent(projectId)}/state`))
  );
}
