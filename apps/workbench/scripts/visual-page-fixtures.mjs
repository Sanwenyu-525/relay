// 只读视觉取证数据；不是实际项目状态、运行证据或数据库业务验收。
import { bodies as collaborationBodies, prefix, projectId, taskId, otherTaskId, thirdTaskId,
  artifacts, versionId, runId } from "./collab-visual-fixtures.mjs";

export const knowledgeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const savedAt = "2026-09-27T02:20:00Z";
const knowledge = { id: knowledgeId, project_id: projectId, title: "协作与验收指南",
  status: "ACTIVE", revision: "3", current_version: "3", created_at: savedAt, updated_at: savedAt };
const knowledgeBody = `# 1. 协作边界
在人机协作的工作流中，AI 主要负责基于已有信息生成候选方案，包括思路整理、内容草稿、方案比较与初步分析。这些内容能够提供多样化的视角，帮助人类拓展思路、提高工作效率。

然而，AI 生成的内容可能存在事实性偏差、逻辑不完整或不适合特定场景的问题，因此不能直接视为最终结论或正式输出。人类需要结合项目的原始验收条件和实际情境，对候选内容进行核验、判断与取舍，决定是否采纳以及如何修改。

只有通过明确的判断与把关，候选内容才能成为可靠的工作成果。阅读知识，不等于授权 AI 使用。

# 2. 验收依据
在判断任务是否完成时，应始终依据项目最初设定的验收条件，对产出的结果进行逐项核验。验收条件描述了任务的目标、范围和质量标准，是判断成果是否符合预期的依据。

同时，需要结合实际证据进行核实，例如最终文件、运行结果、测试记录和其他可验证材料。只有当产出的内容能够与验收条件逐条对应，并有充分的证据支持时，才能确认任务已经完成。

# 3. 中断后如何恢复
恢复工作时先查看原验收条件、已保存成果和未结清事项，再基于这些信息继续推进。本段为视觉示例，不是本项目已通过验收的结论。`;

const versions = ["3", "2"].map((version) => ({ id: `knowledge-version-${version}`, knowledge_id: knowledgeId,
  version, source_kind: "MANAGED_TEXT", media_type: "text/markdown", content_sha256: "a".repeat(64),
  availability: "AVAILABLE", excerpt: "明确协作边界、确切版本与验收依据。", source_refs: {}, created_at: savedAt }));

export function pageBodies() {
  const bodies = new Map(collaborationBodies);
  const taskPage = bodies.get(`${prefix}/tasks`);
  const tasks = { ...taskPage, items: taskPage.items.map((task) => task.id === thirdTaskId
    ? { ...task, executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" } } : task) };
  bodies.set(`${prefix}/tasks`, tasks);
  bodies.set(`${prefix}/packs`, { items: [] });
  bodies.set(`${prefix}/runs/${runId}/reviews`, bodies.get(`${prefix}/reviews`));
  bodies.set(`${prefix}/projects/${projectId}/tasks`, tasks);
  bodies.set(`${prefix}/projects/${projectId}/blueprint-proposals`, { items: [] });
  bodies.set(`${prefix}/projects/${projectId}/continuation-points`, { items: [] });
  bodies.set(`${prefix}/projects/${projectId}/goals`, { items: [{ goal_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    title: "研究可追溯、可恢复的人与 AI 协作方法（视觉示例）", status: "ACTIVE", revision: "1" }] });
  bodies.set(`${prefix}/projects/${projectId}/state`, { project_id: projectId, revision: "4", phase_key: "GENERAL",
    next_action_task_id: otherTaskId,
    selected_artifact_version_refs: [{ artifact_id: artifacts.items[0].id, artifact_version_id: versionId,
      version_number: "2", source_ref: `artifact-version:${versionId}` }], completed_highlight_refs: [] });
  bodies.set(`${prefix}/artifacts/${artifacts.items[0].id}`, artifacts.items[0]);
  const artifactVersion = artifacts.items[0].versions.find((version) => version.artifact_version_id === versionId);
  bodies.set(`${prefix}/artifact-versions/${versionId}/lineage`, { artifact_version_id: versionId,
    artifact_id: artifacts.items[0].id, version_number: artifactVersion.version_number,
    sha256: artifactVersion.sha256, source_kind: artifactVersion.source_kind,
    content_availability: "AVAILABLE", direct_parents: [] });
  bodies.set(`${prefix}/tasks/${otherTaskId}`, tasks.items.find((item) => item.id === otherTaskId));
  bodies.set(`${prefix}/tasks/${thirdTaskId}`, tasks.items.find((item) => item.id === thirdTaskId));
  for (const path of [`${prefix}/knowledge`, `${prefix}/projects/${projectId}/knowledge`]) bodies.set(path, [knowledge]);
  bodies.set(`${prefix}/knowledge/${knowledgeId}`, knowledge);
  bodies.set(`${prefix}/knowledge/${knowledgeId}/versions`, versions);
  for (const version of versions) bodies.set(`${prefix}/knowledge/${knowledgeId}/versions/${version.version}/content`, {
    ...version, title: knowledge.title, project_id: projectId, current_version: "3", source_uri: null,
    content_status: "FULL", content: version.version === "3" ? knowledgeBody : `# 历史版本\n这是 v2 的确切已保存正文，不以当前 v3 替换。\n\n${knowledgeBody}` });
  for (const kind of ["memories", "decisions", "rules"]) {
    bodies.set(`${prefix}/${kind}`, []); bodies.set(`${prefix}/projects/${projectId}/${kind}`, []);
  }
  bodies.set(`${prefix}/connections`, []);
  bodies.set(`${prefix}/projects/${projectId}/connections`, []);
  bodies.set(`${prefix}/projects/${projectId}/permission-policies`, []);
  bodies.set(`${prefix}/projects/${projectId}/managed-resources`, []);
  bodies.set(`${prefix}/projects/${projectId}/view-configuration`, { project_id: projectId, revision: "1",
    kind: "general", template_version: "1", template_sha256: "c".repeat(64), updated_at: savedAt,
    pages: ["state", "tasks", "artifacts", "reviews", "knowledge", "runs", "connections"].map((page_id, position) => ({ page_id, position, visible: true })) });
  bodies.set(`${prefix}/activities`, { items: [{ id: "visual-activity-1", created_at: savedAt, actor_kind: "HUMAN",
    command_id: null, event_type: "ARTIFACT_VERSION_SAVED", summary: "保存评价方案 v2（视觉示例）",
    project_id: projectId, task_id: taskId, run_id: null,
    entity_refs: [{ kind: "TASK", id: taskId }, { kind: "ARTIFACT_VERSION", id: versionId }] }], next_cursor: null });
  return bodies;
}

export function todayBody(query) {
  const date = query.get("date") ?? "2026-09-30", timezone = query.get("timezone") ?? "Asia/Shanghai";
  return { date, timezone, selection_revision: "2", focus: { date, timezone, target_kind: "TASK",
    target_id: otherTaskId, selection_revision: "2", active_in_query: true }, focus_has_eligible_candidate: true,
    eligible_items: [{ task_id: otherTaskId, task_revision: "2", project_id: projectId, title: "完善文献综述",
      status: "READY", priority: "NORMAL", due_local_date: null, timezone: null, pin: true,
      later_local_date: null, later_timezone: null, reason_codes: ["READY_TO_START", "PINNED"],
      evidence_refs: [`task:${otherTaskId}/revision:2`], allowed_actions: ["START", "UNPIN", "SET_LATER", "SET_FOCUS"] }],
    waiting_items: [], blocked_pinned_items: [] };
}
