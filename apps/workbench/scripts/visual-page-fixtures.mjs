// 只读视觉取证数据；不是实际项目状态、运行证据或数据库业务验收。
import { bodies as collaborationBodies, prefix, projectId, taskId, otherTaskId, thirdTaskId,
  artifacts, versionId, runId, workspaceId, sessionId } from "./collab-visual-fixtures.mjs";

export const knowledgeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const memoryId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01";
const decisionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02";
const ruleId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb03";
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
恢复工作时先查看原验收条件、已保存成果和未结清事项，再基于这些信息继续推进。本段为视觉示例，不是本项目已通过验收的结论。

# 4. 评价资料表格（视觉示例）
| 指标 | 计算口径 | 数据来源 | 检查方法 | 复核状态 |
| --- | --- | --- | --- | --- |
| 内容正确率 | 正确条目 / 总条目 | 人工评审 | 对照原始资料 | 未执行 |
| 结构完整率 | 存在小节 / 应有小节 | 自动检查 | 小节结构核对 | 未执行 |`;

const versions = ["3", "2"].map((version) => ({ id: `knowledge-version-${version}`, knowledge_id: knowledgeId,
  version, source_kind: "MANAGED_TEXT", media_type: "text/markdown", content_sha256: "a".repeat(64),
  availability: "AVAILABLE", excerpt: "明确协作边界、确切版本与验收依据。", source_refs: {}, created_at: savedAt }));
const memory = { ...knowledge, id: memoryId, title: "协作验收的确认约定（视觉示例）", revision: "1", current_version: "1",
  text: "对确切产物版本作出人工判断，保存后核对命令回执。", confirmed_by: "视觉示例用户", confirmed_at: savedAt, expires_at: null };
const decision = { ...knowledge, id: decisionId, title: "采用原始验收条件（视觉示例）", revision: "1", current_version: "1",
  choice: "评价方案沿用已确认的指标口径。", rationale: "保留不同版本之间可核对的依据。", alternatives: ["重新定义评价条件"],
  costs: ["每次修改都需重新核对绑定版本"], superseded_by_id: null };
const rule = { id: ruleId, project_id: projectId, task_id: null, scope: "PROJECT", scope_id: projectId, status: "ACTIVE",
  revision: "1", current_version: "1", rule_key: "visual-version-review", statement: "收录评价资料时注明确切来源版本（视觉示例）。",
  strength: "PREFERENCE", applicability: "资料收录", enforcement: "HUMAN", method: "HUMAN", target_spec: {}, created_at: savedAt, updated_at: savedAt };

export function searchBody(query) {
  const term = (query.get("q") ?? "").trim().toLocaleLowerCase();
  const types = (query.get("types") ?? "KNOWLEDGE,MEMORY,DECISION,RULE").split(",");
  const rows = [["KNOWLEDGE", knowledge, "明确协作边界、确切版本与评价依据。"], ["MEMORY", memory, memory.text],
    ["DECISION", decision, decision.choice], ["RULE", rule, rule.statement]];
  return { items: term ? rows.filter(([type, row, snippet]) => types.includes(type) &&
    (!query.get("project_id") || query.get("project_id") === row.project_id) && `${row.title ?? row.statement} ${snippet}`.toLocaleLowerCase().includes(term))
    .map(([type, row, snippet]) => ({ type, id: row.id, version: row.current_version, title: row.title ?? row.statement,
      snippet, matched_fields: ["title", "text"], source_ref: `${type.toLocaleLowerCase()}:${row.id}:v${row.current_version}`,
      status: row.status, project_id: row.project_id })) : [], next_cursor: null };
}

export function pageBodies() {
  const bodies = new Map(collaborationBodies);
  const taskPage = bodies.get(`${prefix}/tasks`);
  const tasks = { ...taskPage, items: taskPage.items.map((task) => task.id === thirdTaskId
    ? { ...task, executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" } } : task) };
  bodies.set(`${prefix}/tasks`, tasks);
  const inboxTask = { ...tasks.items[0], id: "ffffffff-ffff-4fff-8fff-ffffffffff05", title: "补充评价资料来源（视觉示例）",
    project_id: null, status: "INBOX", revision: "1", executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" }, allowed_actions: [],
    current_completion_id: null, updated_at: savedAt };
  bodies.set(`${prefix}/tasks/${inboxTask.id}`, inboxTask);
  bodies.set(`${prefix}/visual-inbox`, { items: [inboxTask], next_cursor: null });
  bodies.set(`${prefix}/packs`, { items: [] });
  bodies.set(`${prefix}/runs/${runId}/reviews`, bodies.get(`${prefix}/reviews`));
  bodies.set(`${prefix}/projects/${projectId}/tasks`, tasks);
  const view = (kind) => ({ kind, template_version: "1", template_sha256: "c".repeat(64),
    pages: ["state", "tasks", "artifacts", "reviews"].map((page_id, position) => ({ page_id, position, visible: true })) });
  const blueprintId = "cccccccc-cccc-4ccc-8ccc-cccccccccc01";
  const newTasks = [{ local_key: "task1", title: "梳理实验评价方法", objective: "形成可复核的指标与基线清单。",
    mode: "ME", status: "INBOX", executor_kind: "HUMAN", required_output_spec: {}, criteria: [] }];
  const nextAction = { kind: "NEW_TASK", local_key: "task1" };
  const followUp = [{ kind: "RULE", summary: "引用核对规则需单独确认。" }];
  const blueprint = { id: blueprintId, workspace_id: workspaceId, project_id: projectId,
    status: "PENDING", origin: "USER_DRAFT", content_availability: "AVAILABLE", skill_message_id: null,
    supersedes_proposal_id: null, candidate_sha256: "d".repeat(64), stale: false,
    candidate: { schema_version: "1", intent: "为研究目标形成清晰的交付路径（视觉示例）", goal_id: null,
      phase_key: "GENERAL", tasks: newTasks, next_action: nextAction, view_configuration: view("thesis"), follow_up_suggestions: followUp },
    baseline: { project_revision: "1", state_revision: "4", view_revision: "1", phase_key: "GENERAL",
      next_action_task_id: otherTaskId, goal_ids: [], goal_ref: null, next_action_task_ref: null, view_configuration: view("general") },
    source: { origin: "USER_DRAFT", pack: null },
    diff: { goal_link: { before_goal_ids: [], add_goal_id: null },
      state: { phase: { before: "GENERAL", after: "GENERAL" }, next_action: { before_task_id: otherTaskId, after: nextAction } },
      new_tasks: newTasks, view_configuration: { before: view("general"), after: view("thesis"), changed: true } },
    follow_up_suggestions: followUp, decision: null, created_at: savedAt, decided_at: null, updated_at: savedAt };
  bodies.set(`${prefix}/projects/${projectId}/blueprint-proposals`, { items: [blueprint] });
  bodies.set(`${prefix}/projects/${projectId}/blueprint-proposals/${blueprintId}`, blueprint);
  const point = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccc02", project_id: projectId,
    name: "开始评价方案前（视觉示例）", note: "只读合成的接续点，不是实际保存记录。", captured_at: savedAt,
    captured_state: { phase_key: "GENERAL", revision: "3", next_action_task_id: taskId }, ref_count: 3 };
  bodies.set(`${prefix}/projects/${projectId}/continuation-points`, { items: [point] });
  bodies.set(`${prefix}/projects/${projectId}/continuation-points/${point.id}/comparison`, {
    continuation_point: point, current_state: { phase_key: "GENERAL", revision: "4", next_action_task_id: otherTaskId },
    facts: { state_revision_changed: true, phase_changed: false, next_action_changed: true, task_added: [],
      artifact_version_added: [{ artifact_id: artifacts.items[0].id, artifact_version_id: versionId, version_number: "2" }] },
    ref_changes: [{ ref_kind: "TASK", ref_id: taskId, captured_revision: "1", current_revision: "2", change: "REVISED", note: "任务定义有修订（视觉示例）" }], interpretation: null });
  bodies.set(`${prefix}/projects/${projectId}/goals`, { items: [{ goal_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    title: "研究可追溯、可恢复的人与 AI 协作方法（视觉示例）", status: "ACTIVE", revision: "1" }] });
  bodies.set(`${prefix}/projects/${projectId}/state`, { project_id: projectId, revision: "4", phase_key: "GENERAL",
    next_action_task_id: otherTaskId,
    selected_artifact_version_refs: [{ artifact_id: artifacts.items[0].id, artifact_version_id: versionId,
      version_number: "2", source_ref: `artifact-version:${versionId}` }], completed_highlight_refs: [] });
  bodies.set(`${prefix}/artifacts/${artifacts.items[0].id}`, artifacts.items[0]);
  bodies.set(`${prefix}/tasks/${otherTaskId}/artifacts`, { items: [], current_accepted_version_ids: [], next_cursor: null });
  const artifactVersion = artifacts.items[0].versions.find((version) => version.artifact_version_id === versionId);
  bodies.set(`${prefix}/artifact-versions/${versionId}/lineage`, { artifact_version_id: versionId,
    artifact_id: artifacts.items[0].id, version_number: artifactVersion.version_number,
    sha256: artifactVersion.sha256, source_kind: artifactVersion.source_kind,
    content_availability: "AVAILABLE", direct_parents: [] });
  bodies.set(`${prefix}/tasks/${otherTaskId}`, tasks.items.find((item) => item.id === otherTaskId));
  const humanTask = { ...tasks.items.find((item) => item.id === thirdTaskId), allowed_actions: ["SAVE_ARTIFACT_VERSION", "COMPLETE"] };
  bodies.set(`${prefix}/tasks/${thirdTaskId}`, humanTask);
  const humanArtifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02";
  const humanVersionId = "88888888-8888-4888-8888-888888888802";
  const humanArtifact = { ...artifacts.items[0], id: humanArtifactId, task_id: thirdTaskId,
    latest_version_id: humanVersionId, version_count: 1,
    versions: [{ ...artifacts.items[0].versions[0], artifact_version_id: humanVersionId }] };
  bodies.set(`${prefix}/tasks/${thirdTaskId}/artifacts`, { items: [humanArtifact], current_accepted_version_ids: [] });
  bodies.set(`${prefix}/artifacts/${humanArtifactId}`, humanArtifact);
  bodies.set(`${prefix}/artifact-versions/${humanVersionId}/lineage`, { artifact_version_id: humanVersionId,
    artifact_id: humanArtifactId, version_number: "2", sha256: "a".repeat(64), source_kind: "HUMAN",
    content_availability: "AVAILABLE", direct_parents: [] });
  for (const path of [`${prefix}/knowledge`, `${prefix}/projects/${projectId}/knowledge`]) bodies.set(path, [knowledge]);
  bodies.set(`${prefix}/knowledge/${knowledgeId}`, knowledge);
  bodies.set(`${prefix}/knowledge/${knowledgeId}/versions`, versions);
  for (const version of versions) bodies.set(`${prefix}/knowledge/${knowledgeId}/versions/${version.version}/content`, {
    ...version, title: knowledge.title, project_id: projectId, current_version: "3", source_uri: null,
    content_status: "FULL", content: version.version === "3" ? knowledgeBody : `# 历史版本\n这是 v2 的确切已保存正文，不以当前 v3 替换。\n\n${knowledgeBody}` });
  for (const [kind, row] of [["memories", memory], ["decisions", decision], ["rules", rule]]) {
    bodies.set(`${prefix}/${kind}`, [row]); bodies.set(`${prefix}/projects/${projectId}/${kind}`, [row]);
    bodies.set(`${prefix}/${kind}/${row.id}`, row);
  }
  bodies.set(`${prefix}/memories/${memoryId}/revisions`, [{ ...memory, memory_id: memoryId, version: "1" }]);
  bodies.set(`${prefix}/rules/${ruleId}/versions`, [{ ...rule, rule_id: ruleId, version: "1" }]);
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
  for (const task of tasks.items) {
    bodies.set(`${prefix}/tasks/${task.id}/check-plan-preview`, { task_id: task.id, status: "AVAILABLE",
      admission_available: false, reason_codes: ["VISUAL_FIXTURE_NOT_EXECUTED"],
      sources: { task_revision: task.revision, acceptance_revision: task.acceptance.acceptance_revision,
        rule_revision: "1", workflow_key: "markdown-deliverable", workflow_version: "1", rule_refs: [] },
      check_plan: { policy_version: "visual-fixture", workflow_key: "markdown-deliverable", workflow_version: "1",
        entries: task.acceptance.criteria.map((criterion) => ({ ...criterion, checker_id: "human-evidence-v1",
          checker_version: "1", severity: "HARD" })) },
      check_plan_sha256: "e".repeat(64), frozen_run_plan: false, executed: false });
  }
  const trace = { run_id: runId, task_id: taskId, project_id: projectId, status: "RUNNING",
    steps: [], attempts: [], model_calls: [], manifests: [], reviews: [], operations: [], effects: [], verifications: [] };
  bodies.set(`${prefix}/runs/${runId}/trace`, trace);
  bodies.set(`${prefix}/runs/${runId}/context-manifests`, { items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
  const currentTask = tasks.items.find((task) => task.id === taskId);
  // 特殊页面的同构只读状态，不是业务完成或实际动作批准证据。
  const approvalId = "99999999-9999-4999-8999-999999999902";
  const approval = { id: approvalId, kind: "ACTION_APPROVAL", status: "OPEN", revision: "2",
    project_id: projectId, task_id: taskId, run_id: runId, reason: "本地 Git 提交需要你的批准（视觉示例）",
    target_hash: "f".repeat(64), target: { operation_id: "visual-commit-operation", action_type: "GIT_COMMIT",
      normalized_target: "D:\\visual-fixture\\repository", permission_version: "4", params_hash: "e".repeat(64), changeset_hash: "d".repeat(64) },
    evidence: { changeset_version: "3", diff_hash: "d".repeat(64), commit_message: "fix: preserve recovery state" },
    effect: { on_approve: "仅允许此次本地提交，不授权 push 或其他后续动作。" },
    allowed_decisions: ["APPROVE", "DENY"], expires_at: null, created_at: savedAt, decided_at: null };
  bodies.set(`${prefix}/reviews`, { items: [...bodies.get(`${prefix}/reviews`).items, approval] });
  bodies.set(`${prefix}/reviews/${approvalId}`, approval);
  const completionId = "77777777-7777-4777-8777-777777777701";
  const doneTaskId = "ffffffff-ffff-4fff-8fff-ffffffffff04";
  const doneVersionId = "88888888-8888-4888-8888-888888888801";
  const doneArtifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
  const doneTask = { ...currentTask, id: doneTaskId, title: "评价方案完成记录（视觉示例）", status: "DONE",
    executor: { kind: "HUMAN", run_id: null, ownership_epoch: "2" }, current_completion_id: completionId,
    allowed_actions: ["REOPEN"] };
  bodies.set(`${prefix}/tasks/${doneTaskId}`, doneTask);
  bodies.set(`${prefix}/tasks/${doneTaskId}/artifacts`, { current_accepted_version_ids: [doneVersionId], items: [{
    ...artifacts.items[0], id: doneArtifactId, task_id: doneTaskId, latest_version_id: doneVersionId,
    version_count: 1, versions: [{ ...artifacts.items[0].versions[0], artifact_version_id: doneVersionId }] }] });
  const completion = { completion_id: completionId, task_id: doneTaskId, basis_kind: "HUMAN", acceptance_revision: "2",
    is_current: true, committed_at: savedAt, acceptance: { availability: "AVAILABLE", objective: "形成可复核的评价方案（视觉示例）",
      expected_outputs: { kind: "MARKDOWN_DOCUMENT" }, source: "HUMAN", created_at: savedAt, criteria: doneTask.acceptance.criteria },
    human_acceptance: { availability: "AVAILABLE", id: "visual-human-acceptance", actor_kind: "HUMAN",
      statement: "按绑定版本与必需条件作出人工接受（视觉示例）", accepted_criterion_ids: ["c1"], reason: null, created_at: savedAt },
    verification_session: null, artifact_versions: [{ availability: "AVAILABLE", artifact_version_id: doneVersionId,
      artifact_id: doneArtifactId, version_number: "2", sha256: "a".repeat(64) }] };
  bodies.set(`${prefix}/completion-records/${completionId}`, completion);
  const historyId = "77777777-7777-4777-8777-777777777702";
  bodies.set(`${prefix}/completion-records/${historyId}`, { ...completion, completion_id: historyId, is_current: false });
  bodies.set(`${prefix}/artifact-versions/${doneVersionId}/lineage`, { artifact_version_id: doneVersionId,
    artifact_id: doneArtifactId, version_number: "2", sha256: "a".repeat(64), source_kind: "HUMAN",
    content_availability: "AVAILABLE", direct_parents: [] });
  const skill = (definition) => ({ id: definition ? "task-to-execution-contract" : "verification-plan",
    version: "1.1.0", sha256: definition ? "b".repeat(64) : "c".repeat(64), title: definition ? "完善任务定义" : "生成验收方案",
    target: "TASK", output_kind: definition ? "TASK_DEFINITION_SUGGESTION" : "VERIFICATION_PLAN_SUGGESTION",
    availability: "CALLABLE_SUGGESTION_ONLY", call_supported: true, accept_supported: true,
    required_capabilities: [], missing_capabilities: [], dependencies: [] });
  bodies.set(`${prefix}/skill-definitions`, { items: [skill(true), skill(false), {
    id: "goal-to-project-blueprint", version: "1.0.0", sha256: "d".repeat(64), title: "生成项目蓝图",
    target: "PROJECT", output_kind: "PROJECT_BLUEPRINT_SUGGESTION", availability: "CALLABLE_SUGGESTION_ONLY",
    call_supported: true, accept_supported: false, required_capabilities: [], missing_capabilities: [], dependencies: [] }] });
  const skillMessages = [true, false].map((definition, index) => ({ id: `visual-skill-${index}`, session_id: sessionId,
    seq: String(index + 4), role: "ASSISTANT", status: "COMPLETED", created_at: savedAt,
    intent: "DISCUSS", content: null, error_code: null, sources: [], usage: { input_tokens: null, output_tokens: null }, cancel_requested: false,
    skill: { ...skill(definition), definition_availability: "AVAILABLE", output_availability: "HISTORICAL_SNAPSHOT" }, skill_input: {},
    skill_output: { kind: skill(definition).output_kind, status: "SUGGESTED", target_kind: "TASK", target_id: taskId, as_of: savedAt,
      baseline: { task_id: taskId, project_id: projectId, task_revision: "2", acceptance_revision: "2" },
      basis_sha256: "b".repeat(64), payload_sha256: "c".repeat(64), payload: { summary: "视觉示例建议；并非真实模型生成。",
        objective: "形成可复核的实验评价方案。", expected_outputs: { kind: "MARKDOWN_DOCUMENT" },
        criteria: [{ statement: "各指标注明计算口径与数据来源", required: true, method: "HUMAN_REVIEW" }],
        additional_checks: [{ statement: "各指标注明计算口径与数据来源", required: true, method: "HUMAN_REVIEW" }], effective_check_plan: false } } }));
  bodies.set(`${prefix}/assist-sessions/${sessionId}/messages`, { items: skillMessages });
  bodies.set(`${prefix}/assist-proposals`, { items: skillMessages.map((message, index) => ({
    id: `visual-proposal-${index}`, workspace_id: workspaceId, session_id: sessionId, message_id: message.id,
    kind: index === 0 ? "TASK_CONTRACT_CHANGE" : "VERIFICATION_PLAN_CHANGE", project_id: projectId, task_id: taskId,
    target_type: "TASK", target_id: taskId, base_revision: "2", base_acceptance_revision: "2", payload_hash: "a".repeat(64),
    payload_available: true, skill_sha256: skill(index === 0).sha256, skill_output_sha256: "c".repeat(64),
    payload: { objective: message.skill_output.payload.objective, required_output_spec: { artifacts: ["MARKDOWN_DOCUMENT"] },
      criteria: [...currentTask.acceptance.criteria.map((criterion) => ({ ...criterion, source: "PRESERVED" })),
        { criterion_id: "c3", statement: "各指标注明计算口径与数据来源", required: true, method: "HUMAN_REVIEW", target_spec: {}, source: "SUGGESTED" }],
      preserved_criterion_ids: ["c1", "c2"], added_criterion_ids: ["c3"], suggested_mode: "ME" },
    status: "PENDING", decision: null, created_at: savedAt, decided_at: null, updated_at: savedAt })) });
  const originalRun = bodies.get(`${prefix}/runs/${runId}`);
  for (const [index, state] of ["pending", "paused", "unknown"].entries()) {
    const stateRunId = `eeeeeeee-eeee-4eee-8eee-eeeeeeeeee0${index + 1}`;
    const stateTaskId = `ffffffff-ffff-4fff-8fff-ffffffffff0${index + 1}`;
    const controlId = "dddddddd-dddd-4ddd-8ddd-dddddddddd01";
    const operationId = "dddddddd-dddd-4ddd-8ddd-dddddddddd02";
    const pending = { id: controlId, type: "PAUSE", status: "PENDING", requested_at: savedAt };
    bodies.set(`${prefix}/tasks/${stateTaskId}`, { ...currentTask, id: stateTaskId,
      title: `执行恢复 · ${state}（视觉示例）`, executor: { ...currentTask.executor, run_id: stateRunId } });
    bodies.set(`${prefix}/runs/${stateRunId}`, { ...originalRun, id: stateRunId, task_id: stateTaskId,
      status: state === "paused" ? "PAUSED" : "RUNNING", blocking_review_ids: [],
      pending_control_request: state === "pending" ? pending : null,
      unresolved_operation_ids: state === "unknown" ? [operationId] : [] });
    bodies.set(`${prefix}/runs/${stateRunId}/control-requests/${controlId}`, { ...pending, run_id: stateRunId,
      task_id: stateTaskId, revision: "1", decided_at: null, result_ref: null });
    bodies.set(`${prefix}/runs/${stateRunId}/reviews`, { items: [] });
    bodies.set(`${prefix}/runs/${stateRunId}/trace`, { ...trace, run_id: stateRunId, task_id: stateTaskId });
    bodies.set(`${prefix}/runs/${stateRunId}/context-manifests`, { items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
    bodies.set(`${prefix}/runs/${stateRunId}/operations`, state === "unknown" ? [{ id: operationId, status: "UNKNOWN",
      action_type: "WRITE_FILE", normalized_target: "D:\\visual-fixture\\result.md", invocations: [{ status: "UNKNOWN" }] }] : []);
  }
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
