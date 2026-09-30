// 协作工作区视觉取证用的服务端事实夹具：与效果图同构，但不冒充真实执行结果。
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const otherTaskId = "44444444-4444-4444-8444-444444444444";
const thirdTaskId = "55555555-5555-4555-8555-555555555555";
const runId = "66666666-6666-4666-8666-666666666666";
const sessionId = "77777777-7777-4777-8777-777777777777";
const versionId = "88888888-8888-4888-8888-888888888888";
const reviewId = "99999999-9999-4999-8999-999999999999";
const prefix = `/api/v1/workspaces/${workspaceId}`;

const task = (over = {}) => ({
  id: taskId, project_id: projectId, title: "确定实验评价指标", status: "IN_PROGRESS", mode: "ME",
  revision: "2", created_at: "2026-09-28T02:00:00Z", updated_at: "2026-09-29T03:42:00Z",
  executor: { kind: "AI", run_id: runId, ownership_epoch: "1" }, current_completion_id: null,
  waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
  acceptance: {
    acceptance_revision: "2", objective: "补齐基线、评价方法与可复核的验收依据。", source: "CREATE",
    created_at: "2026-09-28T02:00:00Z",
    criteria: [
      { criterion_id: "c1", statement: "指标定义明确", required: true, method: "HUMAN_REVIEW", target_spec: {} },
      { criterion_id: "c2", statement: "来源可追溯", required: false, method: "HUMAN_REVIEW", target_spec: {} }
    ]
  },
  dependencies: [], ...over
});

const run = {
  id: runId, task_id: taskId, status: "RUNNING", revision: "4", wait_reason: null,
  current_step_id: "step-2",
  steps: [
    { step_id: "step-1", step_index: 0, step_kind: "BUILD_CONTEXT", status: "SUCCEEDED", started_at: "2026-09-29T03:00:00Z", finished_at: "2026-09-29T03:01:00Z" },
    { step_id: "step-2", step_index: 1, step_kind: "DRAFT", status: "RUNNING", started_at: "2026-09-29T03:10:00Z", finished_at: null }
  ],
  recent_attempts: [], blocking_review_ids: [reviewId], pending_control_request: null, unresolved_operation_ids: []
};

const artifacts = {
  items: [{
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", task_id: taskId, title: "评价方案.md", revision: "3",
    latest_version_id: versionId, version_count: 2,
    versions: [
      { artifact_version_id: versionId, version_number: "2", media_type: "text/markdown", sha256: "a".repeat(64), size: "2140", source_kind: "HUMAN", created_at: "2026-09-29T03:42:00Z" },
      { artifact_version_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", version_number: "1", media_type: "text/markdown", sha256: "c".repeat(64), size: "1500", source_kind: "AGENT", created_at: "2026-09-28T06:00:00Z" }
    ]
  }],
  current_accepted_version_ids: []
};

const docBody = `# 评价方案

## 1. 评价目标

本研究旨在构建一套可操作、可复核的实验评价体系，用于系统评估人机协作方式在研究与写作任务中的效果。通过与人类独立执行和 AI 独立生成的基线进行对比，验证人机协作在任务完成质量、效率与一致性等方面的优势，并为后续推广与应用提供可靠依据。

## 2. 可复核指标

本研究从任务完成质量、效率、一致性和可复现性四个维度设定评价指标。所有指标均给出明确的计算口径、数据来源与检查方法，以支持结果的复核与复现。

### 2.1 任务完成质量

采用人工评审与自动化检查相结合的方式，从内容正确性、完整性、逻辑性和可读性四个方面进行评估。具体计算口径与示例见下表。

| 指标 | 计算口径 | 数据来源 |
| --- | --- | --- |
| 内容正确率 | 正确条目 / 总条目 | 人工评审 |
| 结构完整率 | 存在小节 / 应有小节 | 自动检查 |
`;

const messages = {
  items: [
    { id: "m1", session_id: sessionId, seq: "1", role: "USER", status: "COMPLETED", created_at: "2026-09-29T02:15:00Z",
      intent: "DISCUSS", content: "请根据我们已有的研究问题与数据条件，补充实验评价指标。\n需要同时包含基线设置、评价方法和可复用的验收依据。",
      error_code: null, sources: [], usage: { input_tokens: null, output_tokens: null }, cancel_requested: false, skill: null, skill_input: null, skill_output: null },
    { id: "m2", session_id: sessionId, seq: "2", role: "ASSISTANT", status: "COMPLETED", created_at: "2026-09-29T03:42:00Z",
      intent: "DISCUSS",
      content: "我已完成《评价方案.md》的 v2 版本，补充了基线方法、评价指标定义与计算方式，并给出可复核的验收依据。重点更新：\n1. 明确了人类独立执行、AI 独立生成与人机协作三类对照基线；\n2. 补充了任务完成质量、效率与一致性等核心指标的定义；\n3. 增加了数据来源、抽样方法与检查清单，便于复核与复现。",
      error_code: null, sources: [], usage: { input_tokens: 1840, output_tokens: 620 }, cancel_requested: false, skill: null, skill_input: null, skill_output: null },
    { id: "m3", session_id: sessionId, seq: "3", role: "USER", status: "COMPLETED", created_at: "2026-09-29T03:58:00Z",
      intent: "DISCUSS", content: "整体结构清晰。请在“可复核指标”下补充每个指标的具体计算口径和示例，并保持与数据来源的一致性。",
      error_code: null, sources: [], usage: { input_tokens: null, output_tokens: null }, cancel_requested: false, skill: null, skill_input: null, skill_output: null }
  ]
};

const review = {
  id: reviewId, kind: "CRITERION", status: "OPEN", revision: "3", project_id: projectId, task_id: taskId,
  run_id: runId, reason: "AWAITING_HUMAN_EVIDENCE", target_hash: "b".repeat(64),
  target: { artifact_version_id: versionId, acceptance_revision: "2", criterion_id: "c1" },
  evidence: { check_result: "自动检查不能代替人工判断" }, effect: { on_accept: "重新核对完成条件" },
  allowed_decisions: ["ACCEPT", "REQUEST_CHANGES"], expires_at: null, created_at: "2026-09-29T03:41:00Z", decided_at: null
};

const bodies = new Map([
  [`${prefix}/tasks`, { items: [
    { ...task(), updated_at: "2026-09-29T03:42:00Z" },
    task({ id: otherTaskId, title: "完善文献综述", status: "READY", updated_at: "2026-09-29T02:20:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" }, allowed_actions: ["START"] }),
    task({ id: thirdTaskId, title: "搭建实验框架", status: "IN_PROGRESS", updated_at: "2026-09-28T09:10:00Z",
      executor: { kind: "AI", run_id: runId, ownership_epoch: "1" } })
  ], next_cursor: null }],
  [`${prefix}/projects`, { items: [{ id: projectId, title: "人机协作工作流研究", project_type: "GENERAL", revision: "1",
    state_revision: "1", archived_at: null, archive_status: "ACTIVE", phase_key: "GENERAL",
    next_action_task_id: null, created_at: "2026-09-28T01:00:00Z", updated_at: "2026-09-29T03:42:00Z" }], next_cursor: null }],
  [`${prefix}/tasks/${taskId}`, task()],
  [`${prefix}/tasks/${taskId}/artifacts`, artifacts],
  [`${prefix}/projects/${projectId}`, { id: projectId, title: "人机协作工作流研究", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null }],
  [`${prefix}/projects/${projectId}/state`, { project_id: projectId, revision: "1", phase_key: "GENERAL",
    next_action_task_id: null, selected_artifact_version_refs: [], completed_highlight_refs: [] }],
  [`${prefix}/runs/${runId}`, run],
  [`${prefix}/runs/${runId}/draft-preview`, { run_id: runId, run_status: "RUNNING", preview_available: false,
    preview_text: null, preview_revision: "0", preview_truncated: false, step_attempt_id: null, attempt_claim_epoch: null, model_call_id: null }],
  [`${prefix}/runs/${runId}/operations`, []],
  [`${prefix}/reviews`, { items: [review] }],
  [`${prefix}/reviews/${reviewId}`, review],
  [`${prefix}/assist-sessions`, { items: [{ id: sessionId, workspace_id: workspaceId, project_id: projectId,
    task_id: taskId, title: "关于确定实验评价指标", status: "ACTIVE", revision: "1", updated_at: "2026-09-29T03:40:00Z" }] }],
  [`${prefix}/assist-sessions/${sessionId}/messages`, messages],
  [`${prefix}/assist-proposals`, { items: [] }],
  [`${prefix}/skill-definitions`, { items: [] }],
  [`${prefix}/model-port`, { provider: "openai-compatible", configured: true, model: "gpt-4.1-mini", base_url: null }],
  [`${prefix}/model-port/verification`, { current_config_fingerprint: null, last: null,
    matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" }],
  [`${prefix}/projects/${projectId}/managed-resources`, [{ id: "res-1", project_id: projectId,
    canonical_root: "D:\\Develop\\Relay-Agent", status: "ACTIVE", revision: "1", resource_epoch: "0", file_write_identity_bound: true }]],
  [`${prefix}/projects/${projectId}/connections`, []],
  [`${prefix}/attention/interventions`, { items: [] }]
]);


export { workspaceId, projectId, taskId, otherTaskId, thirdTaskId, runId, sessionId, versionId, reviewId, prefix, bodies, docBody, artifacts };
