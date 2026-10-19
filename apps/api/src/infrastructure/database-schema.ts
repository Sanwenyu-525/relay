import type { JsonObject } from './json.js';

/**
 * V001 的持久化词汇与行类型。
 *
 * 取值必须与 migrations/0001_v001_human_core.sql 的 CHECK 约束一致；扩展合法取值需要新的 migration，
 * 不在应用层放宽。业务 Owner 与字段语义见 docs/database/logical-model.md。
 */

export type ProjectType = 'GENERAL' | 'THESIS' | 'DEVELOPMENT';

export type GoalStatus = 'ACTIVE' | 'ARCHIVED';

export type TaskStatus = 'INBOX' | 'READY' | 'IN_PROGRESS' | 'WAITING' | 'BLOCKED' | 'DONE' | 'CANCELLED';

/** 0004：Delegate 开放 DELEGATE_AI，AI 执行权与 Run 一起建立。 */
export type TaskMode = 'ME' | 'AI_ASSIST' | 'DELEGATE_AI';

/** 0004：执行者可以是当前人工，也可以是某个明确的 Run。 */
export type TaskExecutorKind = 'HUMAN' | 'AI';

/** 0002：INHERIT 继承所属 Project 当前 Goals；EXPLICIT 使用显式集合（可为空集合）。 */
export type TaskGoalAlignmentMode = 'INHERIT' | 'EXPLICIT';

export type TaskAcceptanceSource = 'CREATE' | 'REOPEN' | 'CONTRACT_CHANGE';

/** 0005：开放自动检查方式；HUMAN 仍只表示需要人工证据。 */
export type CriterionMethod =
  | 'HUMAN'
  | 'MARKDOWN_STRUCTURE'
  | 'CITATION_EXISTS'
  | 'SEMANTIC';

export type TaskDependencyKind = 'BLOCKS' | 'INFORMS';

export type ArtifactKind = 'MARKDOWN_DOCUMENT';

/** 0004：Worker 的 PERSIST_CANDIDATE 也会登记候选版本，因此来源不再只有 HUMAN。 */
export type ArtifactVersionSourceKind = 'HUMAN' | 'AI';

export type ProjectBlockerTargetKind = 'PROJECT' | 'TASK' | 'GOAL';

/** 0004：Worker/AI 主体随 Run 引入（V001 只有 HUMAN/SYSTEM）。 */
export type ActivityActorKind = 'HUMAN' | 'SYSTEM' | 'AI';

/** 0004：Run 状态取值，与 migrations/0004_v002_runs.sql 的 ck_runs_status 一致。 */
export type RunStatus =
  | 'CREATED'
  | 'CONTEXT_BUILDING'
  | 'PLANNING'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'VERIFYING'
  | 'RETRYING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/** 固定 Workflow markdown-deliverable-v1 的步骤；RETRYING 通过新 Attempt 表达，不新建步骤。 */
export type RunStepKind = 'BUILD_CONTEXT' | 'DRAFT' | 'PERSIST_CANDIDATE' | 'VERIFY' | 'COMPLETE';

export type RunStepStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

export type StepAttemptStatus = 'PREPARED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'REJECTED_STALE';

export type RunControlType = 'PAUSE' | 'CANCEL' | 'HANDOFF' | 'CANCEL_TASK';
export type RunControlStatus = 'PENDING' | 'APPLIED' | 'REJECTED' | 'SUPERSEDED';
export type RunEffectStatus = 'PREPARED' | 'DISPATCHING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

/** 0005：自动完成绑定 Verification Session；人工完成仍走 HUMAN + human_acceptances。 */
export type CompletionBasisKind = 'HUMAN' | 'AUTO';

export type HumanAcceptanceActorKind = 'HUMAN';

/** 0005：Verification session 状态；OPEN 未决，其余为已决总决策。 */
export type VerificationSessionStatus = 'OPEN' | 'PASS' | 'RETRY' | 'HUMAN';

/** 单项检查结果（contracts/03 第 3 节）；ERROR/NOT_RUN 不得计入 PASS。 */
export type CheckResultValue =
  | 'PASS'
  | 'FAIL'
  | 'UNCERTAIN'
  | 'ERROR'
  | 'NOT_RUN'
  | 'NOT_APPLICABLE';

/** 职责分类：HARD 失败不可被语义赞同覆盖；PREFERENCE 不单独失败。 */
export type CheckSeverity = 'HARD' | 'RULE' | 'PREFERENCE' | 'SEMANTIC';

export interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly revision: bigint;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface WorkspaceExecutionAuthorityRow {
  readonly workspace_id: string;
  readonly revision: bigint;
  readonly rule_revision: bigint;
  readonly context_revision: bigint;
  readonly updated_at: Date;
}

export interface ProjectRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly title: string;
  readonly project_type: ProjectType;
  readonly archived_at: Date | null;
  readonly revision: bigint;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface ProjectViewConfigurationRow {
  readonly project_id: string;
  readonly workspace_id: string;
  readonly revision: bigint;
  readonly kind: 'general' | 'thesis' | 'development';
  readonly template_version: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface ProjectContinuationPointRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly name: string;
  readonly note: string | null;
  readonly state_phase_key: string;
  readonly state_revision: bigint;
  readonly next_action_task_id: string | null;
  readonly captured_at: Date;
}

export interface ProjectContinuationPointRefRow {
  readonly continuation_point_id: string;
  readonly ref_kind: 'TASK' | 'ARTIFACT_VERSION';
  readonly ref_id: string;
  readonly ref_revision: bigint;
  readonly ordinal: number;
  readonly task_id: string | null;
  readonly artifact_version_id: string | null;
}

export interface ProjectBlueprintProposalRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'SUPERSEDED';
  readonly origin: 'USER_DRAFT' | 'SKILL';
  readonly skill_message_id: string | null;
  readonly supersedes_proposal_id: string | null;
  readonly candidate: JsonObject;
  readonly baseline: JsonObject;
  readonly source: JsonObject;
  readonly candidate_sha256: string;
  readonly decision: JsonObject | null;
  readonly created_at: Date;
  readonly decided_at: Date | null;
  readonly updated_at: Date;
}

export interface GoalRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly title: string;
  readonly description: string;
  readonly status: GoalStatus;
  readonly revision: bigint;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface ProjectGoalRow {
  readonly workspace_id: string;
  readonly project_id: string;
  readonly goal_id: string;
  readonly created_at: Date;
}

export interface TaskRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string | null;
  readonly title: string;
  readonly status: TaskStatus;
  readonly mode: TaskMode;
  readonly acceptance_revision: bigint;
  readonly executor_kind: TaskExecutorKind;
  readonly ownership_epoch: bigint;
  /** 0004：AI 执行时的当前 Run；HUMAN 时必须为 NULL（复合外键与 CHECK 共同保证）。 */
  readonly executor_run_id: string | null;
  readonly current_completion_id: string | null;
  /** 0002 新增：Goal 对齐模式。 */
  readonly goal_alignment_mode: TaskGoalAlignmentMode;
  /** 0020：用户显式调度元数据，不属于验收版本。 */
  readonly priority: 'LOW' | 'NORMAL' | 'HIGH' | null;
  readonly due_local_date: string | null;
  readonly due_timezone: string | null;
  readonly revision: bigint;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface RunRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly status: RunStatus;
  readonly revision: bigint;
  /** Delegate 时 Task 的 ownership_epoch 快照。 */
  readonly ownership_epoch: bigint;
  readonly retry_of_run_id: string | null;
  readonly resume_phase: string | null;
  readonly wait_reason: string | null;
  readonly current_step_id: string | null;
  readonly worker_epoch: bigint;
  readonly worker_id: string | null;
  readonly worker_lease_until: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly terminal_at: Date | null;
}

/** Committed, per-Run refresh hint; seq is local to one Run and starts at one. */
export interface RunEventRow {
  readonly run_id: string;
  readonly seq: bigint;
  readonly kind: 'RUN_CHANGED' | 'STEP_CHANGED' | 'ATTEMPT_CHANGED' |
    'REVIEW_CHANGED' | 'CONTROL_CHANGED' | 'EFFECT_CHANGED';
  readonly created_at: Date;
}

/** M03 durable delivery identity. The business Run status remains in runs. */
export interface RunCommandRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly source_command_id: string;
  readonly kind: 'START' | 'RESUME' | 'RECOVER';
  readonly ordinal: bigint;
  readonly review_decision_id: string | null;
  readonly created_at: Date;
}

export interface RunCommandOutboxRow {
  readonly command_id: string;
  readonly status: 'PENDING' | 'CLAIMED' | 'DONE' | 'BLOCKED';
  readonly claim_epoch: bigint | null;
  readonly worker_id: string | null;
  readonly claimed_at: Date | null;
  readonly settled_at: Date | null;
  readonly updated_at: Date;
}

export interface RunInvocationRow {
  readonly run_id: string;
  readonly epoch: bigint;
  readonly status: 'IDLE' | 'ACTIVE' | 'STOP_REQUIRED';
  readonly worker_id: string | null;
  readonly command_id: string | null;
  readonly lease_until: Date | null;
  readonly stop_evidence: string | null;
  readonly updated_at: Date;
}

/** 创建 Run 时冻结的执行契约；run_id 即主键，因此一个 Run 恰有一份契约。 */
export interface ExecutionContractRow {
  readonly run_id: string;
  readonly task_id: string;
  readonly acceptance_revision: bigint;
  readonly workflow_key: string;
  readonly workflow_version: string;
  readonly execution_config_version: string;
  readonly contract_hash: Buffer;
  readonly frozen_snapshot: JsonObject;
  readonly created_at: Date;
}

export interface RunStepRow {
  readonly id: string;
  readonly run_id: string;
  readonly step_index: number;
  readonly step_kind: RunStepKind;
  readonly status: RunStepStatus;
  readonly revision: bigint;
  readonly result_ref: JsonObject | null;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
  readonly created_at: Date;
}

export interface StepAttemptRow {
  readonly id: string;
  readonly step_id: string;
  readonly attempt_number: bigint;
  readonly attempt_key: string;
  readonly status: StepAttemptStatus;
  readonly worker_id: string | null;
  readonly claim_epoch: bigint;
  readonly lease_until: Date | null;
  readonly result_ref: JsonObject | null;
  readonly evidence: JsonObject | null;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
  readonly created_at: Date;
}

export interface RunControlRequestRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly run_id: string;
  readonly type: RunControlType;
  readonly requested_by: string;
  readonly status: RunControlStatus;
  readonly revision: bigint;
  readonly result_ref: JsonObject | null;
  readonly supersedes_request_id: string | null;
  readonly requested_at: Date;
  readonly decided_at: Date | null;
}

export interface RunEffectActionRow {
  readonly operation_id: string;
  readonly run_id: string;
  readonly step_id: string;
  readonly attempt_id: string;
  readonly action_type: 'PUBLISH_CANDIDATE';
  readonly target_ref: string;
  readonly params_hash: Buffer;
  readonly status: RunEffectStatus;
  readonly result_ref: JsonObject | null;
  readonly revision: bigint;
  readonly dispatch_count: number;
  readonly created_at: Date;
  readonly dispatched_at: Date | null;
  readonly resolved_at: Date | null;
}

/** 0008: Gateway facts. Connection, capability and permission remain separate. */
export type GatewayDecision = 'AUTO' | 'ASK' | 'DENY';
export type GatewayCapability =
  | 'FAKE_WRITE'
  | 'FAKE_PUBLIC_READ'
  | 'FILE_READ'
  | 'FILE_QUERY'
  | 'WEB_FETCH'
  | 'FILE_WRITE'
  | 'GIT_READ'
  | 'GIT_WRITE'
  | 'CLI_RUN'
  /** 0092: Computer Plugin 桌面级只读（截图/窗口枚举）。 */
  | 'COMPUTER_READ'
  /** 0092: Computer Plugin 桌面级输入（窗口激活/鼠标/键盘）。 */
  | 'COMPUTER_INPUT'
  /** 0103: GitHub 只读查询（仓库身份、PR 与 Issue 状态）。 */
  | 'GITHUB_READ'
  /** 0105: 内置浏览器自动化的只读面（页面列表、快照、截图、等待）。 */
  | 'BROWSER_READ'
  /** 0105: 浏览器普通交互（导航、新建/关闭自有页、点击、填写、按键）。 */
  | 'BROWSER_ACTION'
  /** 0105: 有外部影响的浏览器动作（提交表单、上传文件），永不免批。 */
  | 'BROWSER_COMMIT';
export type GatewayOperationStatus = 'WAITING_APPROVAL' | 'PREPARED' | 'DISPATCHING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'DENIED' | 'MANUALLY_CLOSED';
export type InvocationStatus = 'PREPARED' | 'DISPATCHING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'NOT_EXECUTED';
export type ResourceClaimStatus = 'HELD' | 'QUARANTINED' | 'RELEASED';

export interface GatewayConnectionRow {
  readonly id: string; readonly workspace_id: string; readonly project_id: string;
  readonly adapter_kind: 'FAKE' | 'REAL'; readonly status: 'ACTIVE' | 'DISABLED';
  readonly version: bigint; readonly config: JsonObject;
  readonly created_at: Date; readonly updated_at: Date;
}
export interface GatewayPermissionPolicyRow {
  readonly id: string; readonly workspace_id: string; readonly project_id: string;
  readonly status: 'ACTIVE' | 'REVOKED'; readonly active_version: bigint | null;
  readonly revision: bigint; readonly created_at: Date; readonly updated_at: Date;
}
export interface GatewayPermissionVersionRow {
  readonly policy_id: string; readonly version: bigint;
  readonly capability_key: GatewayCapability; readonly action_type: string;
  readonly target_prefix: string; readonly decision: GatewayDecision;
  readonly max_payload_bytes: number; readonly created_at: Date;
}
export interface ManagedResourceRow {
  readonly id: string; readonly workspace_id: string; readonly project_id: string;
  readonly canonical_root: string; readonly identity_key: string;
  readonly file_write_root_id: string | null;
  readonly status: 'ACTIVE' | 'DISABLED'; readonly resource_epoch: bigint;
  readonly revision: bigint;
  readonly created_at: Date;
}
export type LocalDirectoryWriteTier = 'READ_ONLY' | 'ASK' | 'AUTO' | 'FULL';
/** Management pointers for the local directory flow; Gateway rows remain the permission truth. */
export interface LocalDirectoryAccessRow {
  readonly resource_id: string;
  readonly write_tier: LocalDirectoryWriteTier;
  readonly read_connection_id: string;
  readonly write_connection_id: string | null;
  readonly policy_ids: JsonObject;
  readonly revision: bigint;
  readonly updated_at: Date;
}
export interface ResourceClaimRow {
  readonly id: string; readonly workspace_id: string; readonly project_id: string;
  readonly resource_id: string; readonly task_id: string;
  readonly run_id: string; readonly worker_id: string; readonly worker_epoch: bigint;
  readonly claim_epoch: bigint; readonly claim_token: string; readonly status: ResourceClaimStatus;
  readonly created_at: Date; readonly released_at: Date | null;
}
export interface ImportJobRow {
  readonly id: string; readonly workspace_id: string; readonly project_id: string;
  readonly actor_ref: string; readonly config_version: string; readonly source_uri: string;
  readonly request_command_id: string;
  /** WEB_FETCH imports freeze their connection boundary here; Fake imports keep NULL. */
  readonly connection_id: string | null;
  readonly status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  readonly error: string | null; readonly knowledge_version_id: string | null;
  readonly revision: bigint; readonly created_at: Date;
}
/** 0058：人工在已登记受管资源上直接触发的受控动作来源。它没有 run/task/step/import_job，
 * 但必须绑定受管资源与能力；词表只放行 GIT_READ，写入与 CLI 仍只有 RUN。 */
/** 0060 追加 ASSISTANT_READ：人设会话的只读动作，与 RUN / USER_IMPORT / USER_ACTION 并列。
 *  0087 追加 AGENT_SESSION_READ：普通 Agent 主流程的只读动作。与 ASSISTANT_READ 同形但
 *  必须可分辨——运行架构 §2.6.3 要求两种执行身份不得互相冒充。 */
export type GatewayOriginKey = 'RUN' | 'USER_IMPORT' | 'USER_ACTION' | 'ASSISTANT_READ'
  | 'AGENT_SESSION_READ';

export interface LogicalOperationRow {
  readonly id: string; readonly workspace_id: string; readonly project_id: string;
  readonly origin: GatewayOriginKey; readonly task_id: string | null;
  readonly run_id: string | null;
  readonly step_id: string | null; readonly import_job_id: string | null;
  readonly intent_key: string; readonly connection_id: string;
  readonly connection_version: bigint; readonly connection_config: JsonObject;
  readonly policy_id: string; readonly policy_version: bigint;
  readonly capability_key: GatewayCapability;
  readonly action_type: string; readonly normalized_target: string;
  readonly params_hash: Buffer; readonly params: JsonObject; readonly resource_id: string | null;
  readonly status: GatewayOperationStatus; readonly result_ref: JsonObject | null;
  readonly created_at: Date; readonly updated_at: Date;
}
export interface InvocationAttemptRow {
  readonly id: string; readonly operation_id: string; readonly attempt_number: bigint;
  readonly origin: GatewayOriginKey; readonly task_id: string | null;
  readonly run_id: string | null; readonly resource_id: string | null;
  readonly status: InvocationStatus; readonly authority_revision: bigint;
  readonly connection_version: bigint; readonly connection_config: JsonObject;
  readonly ownership_epoch: bigint | null;
  readonly worker_id: string | null; readonly worker_epoch: bigint | null;
  readonly resource_claim_id: string | null; readonly claim_token: string | null;
  readonly claim_epoch: bigint | null; readonly result_ref: JsonObject | null;
  readonly created_at: Date; readonly dispatched_at: Date | null; readonly resolved_at: Date | null;
}

/** 0033: append-only desktop Job stop evidence for one original FILE_WRITE Invocation. */
export interface FileWriteStopProofRow {
  readonly invocation_id: string;
  readonly operation_id: string;
  readonly run_id: string;
  readonly worker_id: string;
  readonly worker_epoch: bigint;
  readonly dispatch_epoch: bigint;
  readonly command_id: string;
  readonly launch_id: string;
  readonly stop_evidence: 'armed_job_terminated_and_active_count_zero' |
    'armed_job_absent_after_last_handle_closed';
  readonly capability_key: 'FILE_WRITE';
  readonly action_type: 'WRITE_FILE' | 'APPLY_CHANGESET';
  readonly recorded_at: Date;
}

/** 0034: one append-only human disposition for an original partial FILE_WRITE. */
export interface FileWriteDispositionRow {
  readonly id: string; readonly invocation_id: string; readonly operation_id: string;
  readonly change_set_id: string; readonly workspace_id: string; readonly project_id: string;
  readonly run_id: string; readonly resource_id: string; readonly command_id: string;
  readonly actor_ref: string; readonly decision: 'KEEP_CURRENT_AND_FAIL_RUN';
  readonly observation_sha256: string; readonly observation: JsonObject;
  readonly created_at: Date;
}

/** 0035: immutable, bounded baseline text captured when a FILE_WRITE intent is prepared. */
export interface FileWriteFrozenDiffRow {
  readonly operation_id: string; readonly workspace_id: string; readonly project_id: string;
  readonly run_id: string; readonly resource_id: string;
  readonly capability_key: 'FILE_WRITE';
  readonly action_type: 'WRITE_FILE' | 'APPLY_CHANGESET';
  readonly relative_path: string; readonly file_action: 'MODIFY' | 'DELETE';
  readonly baseline_sha256: string; readonly baseline_text: string | null;
  readonly unavailable_reason: string | null; readonly created_at: Date;
}

/** 0036: immutable physical-path evidence for a new Windows FILE_WRITE operation. */
export interface FileWritePathIdentityRow {
  readonly operation_id: string; readonly workspace_id: string; readonly project_id: string;
  readonly run_id: string; readonly resource_id: string;
  readonly capability_key: 'FILE_WRITE';
  readonly action_type: 'WRITE_FILE' | 'APPLY_CHANGESET';
  readonly root_path: string; readonly root_id: string;
  readonly captures: JsonObject[]; readonly created_at: Date;
}

/** 0054：一次模型工具请求与一个 Gateway 逻辑动作之间的持久对应。
 * 行 id 就是该动作的 logical_operations.id，因此重放沿用同一身份，
 * Provider 的 tool_call_id 只承担轮内配对。REJECTED 行未派发，不连 Operation。 */
export type RunToolCallStatus =
  | 'REQUESTED' | 'PREPARED' | 'WAITING_APPROVAL' | 'SETTLED' | 'REJECTED' | 'ABANDONED';
/** 0056：本次任务范围授权。边界列写入后不可改写，只有撤销可推进；
 * 删除与 Git 写入不在 allowed_actions 内，因此永远仍走单动作确认。 */
export interface RunScopeGrantRow {
  readonly id: string;
  readonly workspace_id: string; readonly project_id: string;
  readonly run_id: string; readonly task_id: string; readonly resource_id: string;
  readonly version: bigint;
  readonly root_identity: string;
  readonly allowed_actions: string[];
  readonly checks: JsonObject[];
  readonly boundary_digest: string;
  readonly issued_at: Date; readonly expires_at: Date | null;
  readonly revoked_at: Date | null; readonly revoked_reason: string | null;
  readonly survives_run_terminal: boolean;
  readonly revision: bigint;
  readonly updated_at: Date;
}

/** 0060：人设会话的工具事实。没有 Run、Step 或 Attempt，只有会话与消息身份。 */
export interface SessionToolCallRow {
  readonly id: string;
  readonly session_id: string;
  readonly message_id: string;
  readonly round: number;
  readonly ordinal: number;
  readonly tool_name: string;
  readonly arguments: JsonObject;
  readonly arguments_sha256: string;
  readonly provider_tool_call_id: string | null;
  readonly operation_id: string | null;
  readonly status: 'REQUESTED' | 'SETTLED' | 'REJECTED' | 'ABANDONED' | 'UNKNOWN';
  readonly rejection_reason: string | null;
  readonly rejection_detail: string | null;
  readonly result_digest: string | null;
  readonly requested_at: Date;
  readonly settled_at: Date | null;
}

export interface RunToolCallRow {
  readonly id: string;
  readonly workspace_id: string; readonly project_id: string; readonly run_id: string;
  readonly step_id: string; readonly step_attempt_id: string; readonly model_call_id: string;
  readonly round: number; readonly ordinal: number;
  readonly provider_tool_call_id: string; readonly tool_name: string;
  readonly arguments: JsonObject; readonly arguments_sha256: string;
  /** 0073：每轮 ordinal=0 的不可变 assistant 续轮字段；旧行 NULL。 */
  readonly assistant_message: JsonObject | null;
  readonly status: RunToolCallStatus;
  readonly operation_id: string | null;
  readonly result_ref: JsonObject | null;
  /** 0056：本行是对哪一次基线冲突的重新适配；只能适配原始请求，不能链式适配。 */
  readonly adaptation_of: string | null;
  readonly adapted_path: string | null;
  readonly revision: bigint;
  readonly created_at: Date; readonly updated_at: Date;
}

/** 0031：一次 FILE_WRITE 执行（APPLY_CHANGESET/WRITE_FILE）的逐文件证据账本头。
 * 与产生它的 invocation 一对一绑定；核对回到同一行收敛状态，不追加第二份历史。 */
export type ChangeSetStatus = 'SUCCEEDED' | 'PARTIAL' | 'UNKNOWN';
/** 整体状态的依据来源：适配器执行报告，或事后按真实内容回读核对。 */
export type ChangeSetEvidenceSource = 'EXECUTION' | 'RECONCILIATION';
export interface ChangeSetRow {
  readonly id: string; readonly invocation_id: string; readonly operation_id: string;
  readonly workspace_id: string; readonly project_id: string;
  readonly run_id: string; readonly resource_id: string;
  readonly action_type: 'APPLY_CHANGESET' | 'WRITE_FILE';
  readonly canonical_root: string;
  readonly status: ChangeSetStatus; readonly evidence_source: ChangeSetEvidenceSource;
  readonly file_count: number; readonly created_at: Date; readonly updated_at: Date;
}
/** 不可变逐文件账本行：路径、动作、冻结基线/期望目标/实际摘要与应用状态。
 * 应用角色只有 SELECT/INSERT，核对阶段只补记缺失路径，绝不改写已记录的状态与原因。
 * diff_ref 为逐文件 diff 存储预留，本增量不生成。 */
export type ChangeSetFileStatus = 'APPLIED' | 'CONFLICT' | 'FAILED';
export interface ChangeSetFileRow {
  readonly change_set_id: string; readonly invocation_id: string;
  readonly relative_path: string; readonly action: 'CREATE' | 'MODIFY' | 'DELETE';
  readonly baseline_sha256: string | null; readonly observed_baseline_sha256: string | null;
  readonly target_sha256: string | null; readonly actual_sha256: string | null;
  readonly status: ChangeSetFileStatus; readonly error: string | null;
  readonly diff_ref: JsonObject | null; readonly created_at: Date;
}

/** BUILD_CONTEXT 的不可变快照；同一 Run 的同一摘要只写一次。 */
export interface ContextManifestRow {
  readonly id: string;
  readonly run_id: string;
  readonly step_id: string | null;
  readonly builder_version: string;
  readonly manifest_hash: Buffer;
  readonly payload: JsonObject;
  readonly created_at: Date;
}

/** project_goals 与 goals 的联表读取结果（Goal 根行仍由 Goal Owner 持有）。 */
export interface ProjectGoalLinkRow {
  readonly project_id: string;
  readonly goal_id: string;
  readonly goal_title: string;
  readonly goal_status: GoalStatus;
  readonly goal_revision: bigint;
  readonly created_at: Date;
}

/** 依赖行的读取投影：附带上游 Task 的当前状态，用于 ready/start 的前置判断。 */
export interface TaskDependencyViewRow {
  readonly task_id: string;
  readonly depends_on_task_id: string;
  readonly dependency_kind: TaskDependencyKind;
  readonly depends_on_status: TaskStatus;
  readonly depends_on_title: string;
}

export interface TaskAcceptanceRow {
  readonly task_id: string;
  readonly acceptance_revision: bigint;
  readonly objective: string;
  readonly required_output_spec: JsonObject;
  readonly source: TaskAcceptanceSource;
  readonly created_at: Date;
}

export interface AcceptanceCriterionRow {
  readonly task_id: string;
  readonly acceptance_revision: bigint;
  readonly criterion_id: string;
  readonly statement: string;
  readonly required: boolean;
  readonly method: CriterionMethod;
  readonly target_spec: JsonObject;
  readonly created_at: Date;
}

export interface TaskExplicitGoalRow {
  readonly task_id: string;
  readonly project_id: string;
  readonly goal_id: string;
  readonly created_at: Date;
}

export interface TaskDependencyRow {
  readonly workspace_id: string;
  readonly task_id: string;
  readonly depends_on_task_id: string;
  readonly dependency_kind: TaskDependencyKind;
  readonly created_at: Date;
}

export interface ProjectStateRow {
  readonly project_id: string;
  readonly phase_key: string;
  readonly next_action_task_id: string | null;
  readonly revision: bigint;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface ProjectBlockerRow {
  readonly id: string;
  readonly project_id: string;
  readonly target_kind: ProjectBlockerTargetKind;
  readonly target_id: string;
  readonly reason: string;
  readonly source_ref: string;
  readonly resolved_at: Date | null;
  readonly created_at: Date;
}

export interface ProjectRiskRow {
  readonly id: string;
  readonly project_id: string;
  readonly statement: string;
  readonly source_ref: string;
  readonly confirmation_ref: string;
  readonly resolved_at: Date | null;
  readonly created_at: Date;
}

export interface ArtifactRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string | null;
  readonly task_id: string;
  readonly artifact_kind: ArtifactKind;
  readonly title: string;
  readonly revision: bigint;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface ArtifactVersionRow {
  readonly id: string;
  readonly artifact_id: string;
  readonly version_number: bigint;
  readonly storage_ref: string;
  readonly content_hash: Buffer;
  readonly size: bigint;
  readonly media_type: string;
  readonly source_kind: ArtifactVersionSourceKind;
  readonly source_ref: string | null;
  readonly created_at: Date;
}

export interface HumanAcceptanceRow {
  readonly id: string;
  readonly task_id: string;
  readonly acceptance_revision: bigint;
  readonly actor_kind: HumanAcceptanceActorKind;
  readonly actor_ref: string;
  readonly statement: string;
  readonly accepted_criterion_ids: readonly string[];
  readonly accepted_version_refs: readonly string[];
  readonly reason: string | null;
  readonly created_at: Date;
}

export interface CompletionRecordRow {
  readonly id: string;
  readonly task_id: string;
  readonly acceptance_revision: bigint;
  readonly basis_kind: CompletionBasisKind;
  /** AUTO 完成时为 null；HUMAN 完成时非空。 */
  readonly human_acceptance_id: string | null;
  /** 0005：AUTO 依据绑定的验证会话与 Run。 */
  readonly verification_session_id: string | null;
  readonly run_id: string | null;
  readonly state_delta: JsonObject;
  readonly committed_at: Date;
}

/** 0005：单次验证会话；verdict 与 status 同步冻结，OPEN 时无决。 */
export interface VerificationSessionRow {
  readonly id: string;
  readonly task_id: string;
  readonly acceptance_revision: bigint;
  readonly run_id: string | null;
  readonly execution_contract_id: string | null;
  readonly verifier_policy_version: string;
  readonly check_plan_hash: Buffer;
  readonly check_plan: JsonObject;
  readonly status: VerificationSessionStatus;
  readonly verdict: VerificationSessionStatus | null;
  readonly revision: bigint;
  readonly correction_budget_used: bigint;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly finalized_at: Date | null;
  /** 0006：Review 派生新会话时保留上一份已决会话，不改写旧检查结果。 */
  readonly parent_session_id: string | null;
}

export type ReviewKind = 'CRITERION' | 'RETRY_BUDGET' | 'CHECKER_RETRY' | 'ACTION_APPROVAL' | 'STATE_PROPOSAL';
export type ReviewStatus = 'OPEN' | 'DECIDED' | 'EXPIRED';
export type ReviewDecision = 'ACCEPT' | 'REQUEST_CHANGES' | 'SET_RETRY_BUDGET' | 'RETRY_CHECKS' | 'APPROVE' | 'DENY';

export interface ReviewRequestRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string | null;
  readonly task_id: string | null;
  readonly run_id: string | null;
  readonly verification_session_id: string | null;
  readonly criterion_id: string | null;
  readonly operation_id: string | null;
  /** USER_IMPORT 动作审批指向的导入 job；Run/State Review 保持 NULL。 */
  readonly import_job_id: string | null;
  readonly kind: ReviewKind;
  readonly reason: string;
  readonly status: ReviewStatus;
  readonly revision: bigint;
  readonly target_hash: Buffer;
  readonly target: JsonObject;
  readonly evidence: JsonObject;
  readonly effect: JsonObject;
  readonly allowed_decisions: readonly ReviewDecision[];
  readonly expires_at: Date | null;
  readonly created_at: Date;
  readonly decided_at: Date | null;
}

export interface ReviewDecisionRow {
  readonly id: string;
  readonly review_id: string;
  readonly command_id: string;
  readonly decision: ReviewDecision;
  readonly feedback: string | null;
  readonly retry_budget: bigint | null;
  readonly target_hash: Buffer;
  readonly effect: JsonObject;
  readonly decided_at: Date;
}

export interface RunCorrectionBudgetRow {
  readonly run_id: string;
  readonly max_corrections: bigint;
  readonly revision: bigint;
  readonly updated_at: Date;
}

export interface VerificationTargetRow {
  readonly session_id: string;
  readonly artifact_version_id: string;
  readonly content_hash: Buffer;
  readonly created_at: Date;
}

export interface CheckResultRow {
  readonly id: string;
  readonly session_id: string;
  readonly criterion_id: string;
  readonly check_attempt: number;
  readonly checker_id: string;
  readonly checker_version: string;
  readonly result: CheckResultValue;
  readonly required: boolean;
  readonly severity: CheckSeverity;
  readonly evidence_refs: JsonObject;
  readonly created_at: Date;
}

export interface VerificationApplicabilityRow {
  readonly session_id: string;
  readonly revoked_at: Date;
  readonly reason: string;
  readonly source_ref: string;
}

export interface StateCompletionRefRow {
  readonly project_id: string;
  readonly completion_id: string;
  readonly source_ref: string;
  readonly created_at: Date;
}

export interface StateArtifactRefRow {
  readonly project_id: string;
  readonly artifact_version_id: string;
  readonly source_ref: string;
  readonly created_at: Date;
}

export interface CommandReceiptRow {
  readonly scope_key: string;
  readonly command_id: string;
  readonly command_type: string;
  readonly payload_hash: Buffer;
  readonly payload_hash_algorithm: string;
  readonly canonicalization_version: string;
  readonly result_ref: JsonObject;
  readonly created_at: Date;
}

export interface ActivityRecordRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly actor_kind: ActivityActorKind;
  readonly actor_ref: string;
  readonly command_id: string | null;
  readonly project_id: string | null;
  readonly task_id: string | null;
  readonly run_id: string | null;
  readonly event_type: string;
  readonly fact_refs: JsonObject;
  readonly created_at: Date;
}

export interface ArtifactLineageEdgeRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly child_version_id: string;
  readonly relation: 'DERIVED_FROM' | 'REVISED_FROM' | 'GENERATED_BY' | 'VERIFIED_BY' | 'ACCEPTED_BY';
  readonly parent_kind: 'ARTIFACT_VERSION' | 'KNOWLEDGE_VERSION' | 'RUN_STEP' |
    'VERIFICATION_SESSION' | 'COMPLETION_RECORD';
  readonly parent_id: string;
  readonly created_at: Date;
}

/** 0009：长期信息的根与不可变版本。 */
export interface InformationRootRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string | null;
  readonly title: string;
  readonly status: string;
  readonly current_version: bigint;
  readonly revision: bigint;
  readonly created_at: Date;
  readonly updated_at: Date;
}
export type KnowledgeItemRow = InformationRootRow;
export interface KnowledgeVersionRow {
  readonly id: string;
  readonly knowledge_id: string;
  readonly version: bigint;
  readonly source_kind: 'NOTE' | 'MANAGED_TEXT' | 'ARTIFACT_VERSION' | 'WEB_PAGE';
  readonly media_type: string;
  readonly content_text: string | null;
  readonly content_sha256: Buffer;
  readonly source_uri: string | null;
  readonly artifact_version_id: string | null;
  readonly availability: 'AVAILABLE' | 'UNAVAILABLE';
  readonly source_refs: JsonObject;
  readonly created_at: Date;
}
export type MemoryItemRow = InformationRootRow;
export interface MemoryVersionRow {
  readonly id: string;
  readonly memory_id: string;
  readonly version: bigint;
  readonly title: string;
  readonly body_text: string;
  readonly confirmed_by: string;
  readonly confirmed_at: Date;
  readonly expires_at: Date | null;
  readonly created_at: Date;
}
export interface DecisionRow extends InformationRootRow {
  readonly superseded_by_id: string | null;
}
export interface DecisionVersionRow {
  readonly id: string;
  readonly decision_id: string;
  readonly version: bigint;
  readonly choice: string;
  readonly rationale: string;
  readonly alternatives: readonly string[];
  readonly costs: readonly string[];
  readonly created_at: Date;
}
export interface RuleRow extends Omit<InformationRootRow, 'title'> {
  readonly scope: 'WORKSPACE' | 'PROJECT' | 'TASK';
  readonly task_id: string | null;
}
export interface RuleVersionRow {
  readonly id: string;
  readonly rule_id: string;
  readonly version: bigint;
  readonly rule_key: string;
  readonly statement: string;
  readonly strength: 'HARD' | 'PREFERENCE';
  readonly applicability: 'AI_RUN';
  readonly enforcement: 'PRE_ACTION' | 'POST_CHECK' | 'SEMANTIC' | 'HUMAN';
  readonly method: CriterionMethod | null;
  readonly target_spec: JsonObject;
  readonly created_at: Date;
}

/** 0015：Assist 会话；只服务对话与提案，不参与业务判定。 */
export type AssistSessionStatus = 'ACTIVE' | 'ARCHIVED';

/** 0015：消息生成意图；提案意图要求会话绑定对应作用域（命令层校验）。 */
export type AssistIntent = 'DISCUSS' | 'PROPOSE_CANDIDATE' | 'PROPOSE_TASK' | 'IMPACT_CHECK' | 'IMPACT_CANDIDATE';

/** 0015：ASSISTANT 消息生成生命周期；USER 消息恒为 COMPLETED。 */
export type AssistMessageStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/** 0015：类型化提案状态；接受复用既有业务命令，重复接受按命令回执幂等。 */
export type AssistProposalStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';

export type AssistProposalKind = 'CANDIDATE_MARKDOWN' | 'TASK_DEFINITION' |
  'TASK_CONTRACT_CHANGE' | 'VERIFICATION_PLAN_CHANGE';

export type ConversationDecision = 'DISCUSS' | 'CLARIFY' | 'PREPARE';
export type ConversationCandidateStatus = 'PENDING' | 'READY' | 'INVALID' | 'UNAVAILABLE';
export type ConversationExecutionStatus = 'INTERPRETING' | 'DISCUSSED' | 'CLARIFY' |
  'READY' | 'TASK_PREPARED' | 'DELEGATED' | 'FAILED';

/** 0050：一条原用户消息对应一条执行请求；模型整理出的候选先落库，再由确定性规则分发领域命令。 */
export interface ConversationExecutionRequestRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly session_id: string;
  readonly source_message_id: string;
  readonly resource_id: string;
  readonly command_id: string;
  readonly root_path: string;
  readonly base_content_sha256: Buffer;
  readonly decision: ConversationDecision;
  readonly candidate_status: ConversationCandidateStatus;
  readonly clarification: JsonObject | null;
  readonly candidate: JsonObject | null;
  readonly status: ConversationExecutionStatus;
  readonly task_id: string | null;
  readonly task_command_id: string | null;
  readonly ready_command_id: string | null;
  readonly delegate_command_id: string | null;
  readonly run_id: string | null;
  readonly revision: bigint;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export type StateMaintenanceDecision = 'DISCUSS' | 'CLARIFY' | 'MAINTAIN';
export type StateMaintenanceStatus = 'INTERPRETING' | 'DISCUSSED' | 'CLARIFY' | 'READY' |
  'APPLYING' | 'APPLIED' | 'PARTIAL' | 'FAILED' | 'DECISION_REQUIRED' | 'DECLINED' |
  'UNDOING' | 'UNDONE' | 'UNDO_PARTIAL' | 'UNDO_BLOCKED';
export type StateChangeKind = 'CREATE_GOAL' | 'LINK_GOAL' | 'CREATE_KNOWLEDGE' |
  'VERSION_KNOWLEDGE' | 'CREATE_DECISION' | 'CREATE_TASK' | 'ADD_TASK_DEPENDENCY' |
  'SET_NEXT_ACTION' | 'SET_PHASE' | 'ADD_BLOCKER' | 'RESOLVE_BLOCKER' | 'SET_TASK_PLANNING' |
  'SYNC_EXTERNAL_RESULT' | 'COMPLETE_TASK' | 'UNDO_STATE_CHANGE' | 'REPORT_ACCEPTANCE_TIME' | 'CREATE_HYPOTHESIS' | 'START_WORK_SEGMENT';
export type StateChangeStatus = 'PENDING' | 'APPLIED' | 'FAILED' | 'SKIPPED' | 'DECLINED' |
  'COMPENSATED' | 'COMPENSATION_FAILED';

/** 0062：一条原用户消息对应一次状态维护请求。模型只解释候选，授权来自原消息本身。 */
export interface ConversationStateRequestRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly session_id: string;
  readonly source_message_id: string;
  readonly command_id: string;
  readonly apply_command_id: string;
  readonly undo_command_id: string;
  readonly base_content_sha256: Buffer;
  readonly decision: StateMaintenanceDecision;
  readonly candidate_status: ConversationCandidateStatus;
  readonly clarification: JsonObject | null;
  readonly candidate: JsonObject | null;
  readonly decision_required: JsonObject | null;
  /** 0064：已确认的撤回方案（plan_digest + change_ids），中断恢复按它继续剩余补偿。 */
  readonly undo_scope: JsonObject | null;
  /** 0067（R3）：claim 事务里、调用模型之前冻结的解释基线；结算与恢复都沿它关联。 */
  readonly interpretation_baseline: JsonObject | null;
  readonly status: StateMaintenanceStatus;
  readonly revision: bigint;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** 0062：请求下的一条类型化领域变更。命令身份在请求创建时固定，撤回沿同一身份补偿。 */
export interface ConversationStateChangeRow {
  readonly id: string;
  readonly request_id: string;
  readonly ordinal: number;
  readonly change_kind: StateChangeKind;
  readonly command_id: string;
  readonly payload: JsonObject;
  readonly status: StateChangeStatus;
  readonly before_ref: JsonObject | null;
  readonly after_ref: JsonObject | null;
  /** 0064：解释结算时冻结的适用基线（state_revision 与实际目标身份）。 */
  readonly baseline_ref: JsonObject | null;
  readonly error: JsonObject | null;
  readonly applied_at: Date | null;
  readonly compensation_command_id: string | null;
  readonly compensated_at: Date | null;
}

/**
 * 0063：一次「实际查看确认」留下的日常查看基线（每 Project 至多一行，单调推进）。
 * 只保存查看时点的版本引用（viewed_state_revision 与 viewed_fact_refs），不复制业务正文；
 * 「已查看」不是接受或接手，本表不参与验收、批准或执行权转移。
 */
export interface ProjectDailyViewBaselineRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly viewed_state_revision: bigint;
  readonly viewed_fact_refs: JsonObject;
  readonly presentation_id: string;
  /** 0065：确认时点的服务端展示序号；推进要求它严格增大。 */
  readonly viewed_presentation_seq: bigint;
  readonly confirmed_at: Date;
}

/**
 * 0065：按 Project 签发的展示序号计数器。
 * 读取时递增签发，确认只接受不超过已签发上限的序号——顺序由服务端给出，不用客户端时钟。
 */
export interface ProjectDailyViewPresentationCounterRow {
  readonly workspace_id: string;
  readonly project_id: string;
  readonly issued_seq: bigint;
  readonly last_presentation_id: string | null;
  readonly updated_at: Date;
}

/**
 * 0067（R6）：一次真实读取签发的展示身份与当次事实摘要。
 * 确认必须逐项对上签发记录（身份 + 序号 + State 版本 + 已展示事实），
 * 序号在已签发上限内不再足以证明「这份身份/内容展示过」。
 */
export interface ProjectDailyViewPresentationRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly presentation_id: string;
  readonly issued_seq: bigint;
  readonly state_revision: bigint;
  readonly fact_refs: JsonObject;
  readonly issued_at: Date;
}

/**
 * 0069（Slice C / NLS-05、NLS-08、NLS-09）：返回时的轻量核对记录。
 * 一个 (project, fingerprint) 一条：事实与证据没变就复用，变了就重新核对；
 * 核对本身是同步只读动作，不伪造 Run、不启动进程。
 */
export interface ProjectReturnReviewRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly fingerprint: string;
  readonly status: 'APPLICABLE' | 'CHANGED';
  readonly result: JsonObject;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * 0072（ADR-020 / 领域模型 §13）：学习模式的知识点身份。
 * 解析只按 slug / 别名精确匹配；generation 是概念代次，单项删除或纠正替换时递增，
 * 使冻结在旧代次上的在途轮次失去写入资格。
 */
export interface LearningConceptRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly topic: string;
  readonly slug: string;
  readonly display_name: string;
  readonly aliases: JsonObject;
  readonly generation: bigint;
  readonly revision: bigint;
  readonly status: 'ACTIVE' | 'ARCHIVED';
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** 0072：单条学习证据。四类性质不同，各自保留依据与时间。 */
export type LearningEvidenceKind = 'EXPOSURE' | 'SELF_REPORT' | 'OBSERVED' | 'GAP';
export type LearningEvidenceDisposition = 'ACTIVE' | 'PENDING_REVIEW' | 'SUPERSEDED' | 'WITHDRAWN';
export type LearningEvidenceSourceKind = 'LEARNING_MESSAGE' | 'USER_CONTROL';

export interface LearningEvidenceRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly concept_id: string;
  readonly kind: LearningEvidenceKind;
  readonly scenario: string;
  readonly detail: string;
  readonly disposition: LearningEvidenceDisposition;
  readonly source_kind: LearningEvidenceSourceKind;
  readonly source_message_id: string | null;
  readonly session_id: string | null;
  readonly observed_at: Date;
  readonly epoch: bigint;
  readonly revision: bigint;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** 0072：清除边界，每 workspace 一行（惰性建立；缺行等价于 epoch 0）。 */
export interface LearningRecordEpochRow {
  readonly workspace_id: string;
  readonly epoch: bigint;
  readonly cleared_at: Date | null;
  readonly clear_command_id: string | null;
  readonly updated_at: Date;
}

/** 0072：会话级「后续不记录」。与消息级开关分开，作用范围与生效时间都可核对。 */
export interface LearningSessionControlRow {
  readonly session_id: string;
  readonly workspace_id: string;
  readonly records_enabled: boolean;
  readonly revision: bigint;
  readonly updated_by_message_id: string | null;
  readonly updated_at: Date;
}

export type LearningRoundStatus = 'PENDING' | 'SETTLED' | 'REJECTED' | 'CANCELLED';

/** 0072：一次教学轮次的结算依据，在调用模型**之前**写入。 */
export interface LearningRoundRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly session_id: string;
  readonly message_id: string;
  readonly epoch: bigint;
  readonly concept_generations: JsonObject;
  readonly record_enabled: boolean;
  readonly status: LearningRoundStatus;
  readonly rejection_reason: string | null;
  readonly settled_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** 0059：会话建立时冻结的一种身份。既有会话按 'AGENT' 读出，不虚构 助手 关系。 */
export type ConversationMode = 'AGENT' | 'ASSISTANT' | 'LEARNING';

/** 0059：助手配置。配置文本存在这里，能力不在这里——能力来自连接与 Gateway 准入。 */
export interface AssistantProfileRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly role_description: string;
  readonly tone: string | null;
  readonly read_scope: JsonObject;
  readonly revision: bigint;
  readonly status: 'ACTIVE' | 'ARCHIVED';
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface AssistSessionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string | null;
  readonly task_id: string | null;
  readonly title: string;
  readonly status: AssistSessionStatus;
  /** 冻结：会话建立后不改写。切模式等于换会话。 */
  readonly conversation_mode: ConversationMode;
  readonly assistant_profile_id: string | null;
  /** 建会话时 助手的修订。助手之后被改写不影响既有会话的冻结快照。 */
  readonly assistant_profile_revision: bigint | null;
  readonly assistant_role_snapshot: JsonObject | null;
  /** 「一次性问答」开关：false 时该轮不作为可续读历史。 */
  readonly remember: boolean;
  /**
   * 0087：本会话当前绑定的受管工作目录。
   *
   * 这是普通 Agent 主流程**唯一**的目录判定来源（此前只存在于浏览器组件状态，
   * 导致刷新即丢、且服务端只能「取第一个受管资源」）。为 NULL 表示未绑定目录：
   * 主流程按类型化原因拒掉本次读取，不回落到任意资源。资源是否 ACTIVE、是否属于本会话的
   * Project 仍由应用层按调用时的当前状态判定，不写进数据库 CHECK。
   */
  readonly working_resource_id: string | null;
  /**
   * 0090：置顶时刻。NULL = 未置顶；有值即这条会话排在列表最前，取消置顶写回 NULL。
   *
   * 它是**导航排序键**，不是业务事实：归档与否、能不能发消息、绑哪个目录都仍由既有列决定。
   * 取消不保留「曾经置顶」的历史——那一次改动留在命令回执里，不在这张表里另存一套。
   */
  readonly pinned_at: Date | null;
  /**
   * 0104：未读标记。NULL = 已读；有值即这条会话在近期工作栏里带未读点。
   *
   * 与 pinned_at 同一性质——**导航偏好，不是业务事实**：不参与排序、不改变任何准入判定，
   * 归档与否、能不能发消息、绑哪个目录都仍由既有列与既有 Owner 决定。
   * 上游对照里只有 ZCode 把它落库（Codex 会话列表没有未读，DSH 只在内存里、重启即丢），
   * 我们采纳它「NULL=已读」的读法；「点开自动清除」需要 expected_unread_at 那类单调版本，本轮不做。
   */
  readonly unread_at: Date | null;
  /**
   * 0111：最后一条消息落库或生成结算的时刻。NULL = 这段会话还没有消息。
   *
   * 与 pinned_at、unread_at 同一性质——**导航排序键，不是业务事实**：不参与准入判定，
   * 也不由 `revision` 裁决。写入口只有消息落库与生成结算两处；改名、置顶、未读、绑定
   * 都不推进它，它自己也不推进 `updated_at` 与 `revision`（否则在途生成会把人工控制
   * 命令的 CAS 基线打翻）。列表按 `coalesce(last_message_at, created_at)` 倒序排。
   */
  readonly last_message_at: Date | null;
  /**
   * 0113：分叉来源。NULL = 这条会话不是任何会话的分叉；有值即它由那一条分出来。
   *
   * 是**来源元数据**，不是状态也不是业务事实：分叉不改变父会话（不推进它的修订与标题），
   * 子会话此后独立生长。写入口只有分叉命令，且只在插入时写一次。
   */
  readonly forked_from_session_id: string | null;
  readonly revision: bigint;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface AssistMessageRow {
  readonly id: string;
  readonly session_id: string;
  readonly seq: bigint;
  readonly role: 'USER' | 'ASSISTANT';
  readonly status: AssistMessageStatus;
  readonly intent: AssistIntent;
  readonly content: string | null;
  readonly error_code: string | null;
  readonly provider_error_kind: import('../workflow/model-error-classification.js').ModelErrorCategory | null;
  readonly sources: JsonObject;
  readonly skill_snapshot: JsonObject | null;
  readonly skill_input: JsonObject | null;
  readonly skill_output: JsonObject | null;
  /** 0071：内置工作方法身份（冻结定义 + 摘要）；与 skill_snapshot 互斥。 */
  readonly method_snapshot: JsonObject | null;
  readonly method_action: 'INSPECT' | 'MODIFY' | null;
  readonly method_argument: string | null;
  /** 0098: non-secret model/provider candidate plan captured when this message was accepted. */
  readonly model_selection_snapshot: JsonObject | null;
  /** 0098: per-message candidate progress, CAS-updated independently of session selection. */
  readonly model_attempt_state: JsonObject | null;
  readonly provider_request_id: string | null;
  readonly usage_input_tokens: number | null;
  readonly usage_output_tokens: number | null;
  readonly usage_cache_read_tokens: number | null;
  readonly usage_cache_creation_tokens: number | null;
  readonly worker_id: string | null;
  readonly cancel_requested: boolean;
  /** 0072：本轮不记录学习状态。随发送命令持久，不由模型提示决定。 */
  readonly learning_record_disabled: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Disposable, bounded DISCUSS prefix. Removed in the same transaction as settlement. */
export interface AssistMessagePreviewRow {
  readonly message_id: string;
  readonly revision: bigint;
  readonly preview_text: string;
  readonly truncated: boolean;
  readonly updated_at: Date;
}

/**
 * 0093：Assist 消息图片附件（输入框粘贴/拖拽）。
 *
 * 会话输入快照，不是资料也不受管存储：媒体类型与字节在插入后不可变，
 * `message_id` 只允许从 NULL 绑定为非 NULL（由仓库层 UPDATE 守住，应用角色无 DELETE）。
 * 「每消息 ≤4 张、总量 ≤6 MiB」由消息命令在事务内裁决，不写数据库触发器。
 */
export interface AssistMessageAttachmentRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly session_id: string;
  readonly message_id: string | null;
  readonly name: string;
  readonly media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  readonly byte_length: number;
  readonly content_hash: Buffer;
  readonly content: Buffer;
  readonly created_at: Date;
}

/** 0093：消息列表投影用的附件元数据（不读 `content` 字节）。 */
export interface AssistMessageAttachmentMetaRow {
  readonly id: string;
  readonly message_id: string | null;
  readonly name: string;
  readonly media_type: AssistMessageAttachmentRow['media_type'];
  readonly byte_length: number;
}

/** Disposable prefix for one current DRAFT claim and one actual model call. */
export interface RunDraftPreviewRow {
  readonly run_id: string;
  readonly step_attempt_id: string;
  readonly attempt_claim_epoch: bigint;
  readonly run_worker_epoch: bigint;
  readonly worker_id: string;
  readonly invocation_epoch: bigint | null;
  readonly model_call_id: string;
  readonly revision: bigint;
  readonly preview_text: string;
  readonly truncated: boolean;
  readonly updated_at: Date;
}

/** One actual invocation; STARTED is an unknown outcome after process loss. */
export interface ModelCallRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly kind: 'DRAFT' | 'SEMANTIC_CHECK' | 'ASSIST' | 'VERIFY' | 'COMPOSER';
  readonly step_attempt_id: string | null;
  readonly assist_message_id: string | null;
  readonly manifest_id: string | null;
  readonly criterion_id: string | null;
  readonly check_attempt: number | null;
  readonly provider: string;
  readonly model: string;
  readonly config_fingerprint: string;
  readonly input_sha256: string | null;
  readonly read_operation_id: string | null;
  readonly read_invocation_id: string | null;
  readonly provider_request_id: string | null;
  readonly status: 'STARTED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  readonly usage_input_tokens: number | null;
  readonly usage_output_tokens: number | null;
  readonly usage_cache_read_tokens: number | null;
  readonly usage_cache_creation_tokens: number | null;
  readonly budget_reserved_tokens: number | null;
  readonly error_kind: string | null;
  readonly started_at: Date;
  readonly first_stream_event_at: Date | null;
  readonly first_text_delta_at: Date | null;
  readonly first_preview_persisted_at: Date | null;
  readonly settled_at: Date | null;
}

/** 0100: known provider Retry-After evidence, scoped to one model or account config. */
export interface ModelProviderCooldownRow {
  readonly provider: 'openrouter';
  readonly scope: 'ACCOUNT' | 'MODEL';
  readonly model_id: string;
  readonly config_fingerprint: string;
  readonly retry_after_at: Date;
  readonly reason: 'UPSTREAM_PROVIDER_RATE_LIMIT' | 'PLATFORM_RATE_LIMIT' |
    'ACCOUNT_FREE_DAILY_EXHAUSTED';
  readonly model_call_id: string;
  readonly observed_at: Date;
}

export interface AssistProposalRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly session_id: string;
  readonly message_id: string;
  readonly kind: AssistProposalKind;
  readonly project_id: string | null;
  readonly task_id: string | null;
  readonly target_type: 'TASK' | 'PROJECT';
  readonly target_id: string;
  readonly base_revision: bigint;
  readonly base_acceptance_revision: bigint | null;
  readonly payload: JsonObject;
  readonly payload_hash: string;
  readonly skill_sha256: string | null;
  readonly skill_output_sha256: string | null;
  readonly status: AssistProposalStatus;
  readonly decision: JsonObject | null;
  readonly created_at: Date;
  readonly decided_at: Date | null;
  readonly updated_at: Date;
}

/** Kysely 的表名映射；Repository 使用显式 SQL，因此这里主要用于结果类型与后续查询构建。 */
export interface RuntimeAdmissionGateRow {
  readonly singleton: boolean;
  readonly mode: 'NORMAL' | 'DRAINING';
  readonly revision: bigint;
}

/**
 * 模型目录发布头 + 跨进程同步租约 + 失败退避（迁移 0088）。单例行，快照事实只此一处。
 * directory_digest/snapshot_seq 为「已成功发布」的指针；无成功快照时 digest 与时间为 NULL，不伪造。
 */
export interface ModelCatalogSyncStateRow {
  readonly singleton: boolean;
  readonly source: 'openrouter';
  readonly directory_digest: string | null;
  readonly snapshot_seq: bigint;
  readonly last_success_at: Date | null;
  readonly last_attempt_at: Date | null;
  readonly last_failure_at: Date | null;
  readonly last_failure_reason:
    | 'NETWORK' | 'TIMEOUT' | 'AUTH' | 'RATE_LIMIT' | 'PROTOCOL'
    | 'INCOMPLETE' | 'ENDPOINT_NOT_ALLOWED' | 'NOT_CONFIGURED' | null;
  readonly consecutive_failures: number;
  readonly sync_lease_token: string | null;
  readonly sync_lease_expires_at: Date | null;
  readonly revision: bigint;
}

/** 当前快照的免费判定条目（迁移 0088）。随成功发布整体替换，只保留最新一份。 */
export interface ModelCatalogEntryRow {
  readonly source_model_id: string;
  readonly display_name: string;
  readonly context_window: number | null;
  readonly pricing: Record<string, string>;
  readonly capabilities: {
    readonly tools: boolean | null;
    readonly structured_outputs: boolean | null;
    readonly response_format: boolean | null;
    readonly text_input: boolean | null;
    readonly text_output: boolean | null;
    readonly image_input: boolean | null;
  };
  readonly is_free: boolean;
  readonly not_free_reason:
    | 'MISSING_PRICE' | 'INVALID_PRICE' | 'NEGATIVE_PRICE' | 'NONZERO_PRICE'
    | 'UNKNOWN_BILLABLE_ITEM' | null;
  readonly fetched_at: Date;
}

/**
 * 会话作用域的模型选择（迁移 0089，专项阶段 C）。是「该会话后续新请求用哪个模型」的事实记录，
 * 随会话留存、可核对失效原因；从不写回进程默认，也不写 model_calls / runs。revision 供 CAS 幂等。
 */
export interface SessionModelSelectionRow {
  readonly session_id: string;
  readonly connection: 'default' | 'openrouter';
  readonly model: string;
  readonly config_fingerprint: string;
  readonly free_only: boolean;
  readonly catalog_source: 'openrouter' | null;
  readonly catalog_snapshot_seq: bigint | null;
  readonly catalog_model_id: string | null;
  readonly revision: bigint;
  readonly selected_by_command_id: string;
  readonly updated_at: Date;
}

export interface RelayDatabaseSchema {
  runtime_admission_gate: RuntimeAdmissionGateRow;
  model_calls: ModelCallRow;
  model_provider_cooldowns: ModelProviderCooldownRow;
  model_catalog_sync_state: ModelCatalogSyncStateRow;
  model_catalog_entries: ModelCatalogEntryRow;
  session_model_selection: SessionModelSelectionRow;
  assist_sessions: AssistSessionRow;
  assist_messages: AssistMessageRow;
  assist_message_attachments: AssistMessageAttachmentRow;
  assist_message_previews: AssistMessagePreviewRow;
  run_draft_previews: RunDraftPreviewRow;
  assist_proposals: AssistProposalRow;
  conversation_execution_requests: ConversationExecutionRequestRow;
  knowledge_items: KnowledgeItemRow;
  knowledge_versions: KnowledgeVersionRow;
  memory_items: MemoryItemRow;
  memory_versions: MemoryVersionRow;
  decisions: DecisionRow;
  decision_versions: DecisionVersionRow;
  rules: RuleRow;
  rule_versions: RuleVersionRow;
  gateway_capabilities: { readonly capability_key: GatewayCapability; readonly adapter_kind: 'FAKE' | 'REAL'; readonly effect_kind: 'READ' | 'WRITE' };
  gateway_connections: GatewayConnectionRow;
  gateway_connection_capabilities: { readonly connection_id: string; readonly capability_key: GatewayCapability };
  gateway_permission_policies: GatewayPermissionPolicyRow;
  gateway_permission_versions: GatewayPermissionVersionRow;
  managed_resources: ManagedResourceRow;
  local_directory_access: LocalDirectoryAccessRow;
  resource_claims: ResourceClaimRow;
  import_jobs: ImportJobRow;
  logical_operations: LogicalOperationRow;
  invocation_attempts: InvocationAttemptRow;
  file_write_stop_proofs: FileWriteStopProofRow;
  file_write_manual_dispositions: FileWriteDispositionRow;
  file_write_frozen_diffs: FileWriteFrozenDiffRow;
  file_write_path_identity: FileWritePathIdentityRow;
  approval_reservations: { readonly review_id: string; readonly operation_id: string; readonly reserved_at: Date };
  invocation_approval_bindings: { readonly invocation_id: string; readonly review_id: string; readonly operation_id: string };
  change_sets: ChangeSetRow;
  run_tool_calls: RunToolCallRow;
  run_scope_grants: RunScopeGrantRow;
  change_set_files: ChangeSetFileRow;
  workspaces: WorkspaceRow;
  workspace_execution_authority: WorkspaceExecutionAuthorityRow;
  projects: ProjectRow;
  project_view_configurations: ProjectViewConfigurationRow;
  project_continuation_points: ProjectContinuationPointRow;
  project_continuation_point_refs: ProjectContinuationPointRefRow;
  conversation_state_requests: ConversationStateRequestRow;
  conversation_state_changes: ConversationStateChangeRow;
  project_daily_view_baselines: ProjectDailyViewBaselineRow;
  project_daily_view_presentation_counters: ProjectDailyViewPresentationCounterRow;
  project_daily_view_presentations: ProjectDailyViewPresentationRow;
  project_return_reviews: ProjectReturnReviewRow;
  project_blueprint_proposals: ProjectBlueprintProposalRow;
  goals: GoalRow;
  project_goals: ProjectGoalRow;
  tasks: TaskRow;
  task_acceptances: TaskAcceptanceRow;
  acceptance_criteria: AcceptanceCriterionRow;
  task_explicit_goals: TaskExplicitGoalRow;
  task_dependencies: TaskDependencyRow;
  project_states: ProjectStateRow;
  project_blockers: ProjectBlockerRow;
  project_risks: ProjectRiskRow;
  artifacts: ArtifactRow;
  artifact_versions: ArtifactVersionRow;
  human_acceptances: HumanAcceptanceRow;
  completion_records: CompletionRecordRow;
  state_completion_refs: StateCompletionRefRow;
  state_artifact_refs: StateArtifactRefRow;
  command_receipts: CommandReceiptRow;
  activity_records: ActivityRecordRow;
  artifact_lineage_edges: ArtifactLineageEdgeRow;
  runs: RunRow;
  run_events: RunEventRow;
  run_commands: RunCommandRow;
  run_command_outbox: RunCommandOutboxRow;
  run_invocations: RunInvocationRow;
  run_effect_actions: RunEffectActionRow;
  execution_contracts: ExecutionContractRow;
  run_steps: RunStepRow;
  step_attempts: StepAttemptRow;
  context_manifests: ContextManifestRow;
  verification_sessions: VerificationSessionRow;
  verification_targets: VerificationTargetRow;
  check_results: CheckResultRow;
  verification_applicability: VerificationApplicabilityRow;
  review_requests: ReviewRequestRow;
  review_decisions: ReviewDecisionRow;
  run_correction_budgets: RunCorrectionBudgetRow;
  conversation_diff_baselines: ConversationDiffBaselineRow;
  run_tool_call_previews: RunToolCallPreviewRow;
}

/** 一次原子发布的会话基线快照（工作台 §34）。详见迁移 0097。 */
export interface ConversationDiffBaselineRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly session_id: string;
  readonly resource_id: string;
  /** 受管根的绝对路径；目录切换（不同根）产生新统计段，不跨段求和。 */
  readonly root_path: string;
  readonly captured_at: Date;
  /** 基线文件清单与允许统计文本的真实内容（含 unavailable_reason 的不可统计项）。 */
  readonly files: JsonObject;
  /** 扫描因文件数/总量/时间超限而只覆盖部分范围时为 true；不把部分数据冒充完整。 */
  readonly incomplete: boolean;
  readonly capture_reason: string;
  /** 全局单调：总数/列表/正文在同一 revision 下一致（CD-15）。 */
  readonly revision: bigint;
}

/**
 * 一次模型调用里某个工具 ordinal 的「生成中」临时预览（工作台 §34.4 / 迁移 0102）。
 *
 * 可丢弃的展示证据：不属于发起写动作的授权，不进入会话总数；工具轮次落库或调用结束
 * 后由应用层删除，重启后允许读空，不要求恢复半截预览。
 */
export interface RunToolCallPreviewRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  /** 模型调用 id：参数流期间就已存在，因此预览先于工具调用行（run_tool_calls）可用。 */
  readonly model_call_id: string;
  /** 同一次模型调用内工具请求的序号，与 run_tool_calls.ordinal 对齐。 */
  readonly ordinal: number;
  readonly tool_name: string;
  /** 逐文件预览数组：[{ path, action, added, removed, target_complete }]；-1 表示待核对。 */
  readonly files: JsonObject;
  readonly truncated: boolean;
  /** 全局单调：同一预览的更新只增不减，旧响应不能覆盖新值（CD-15）。 */
  readonly revision: bigint;
  readonly created_at: Date;
  readonly updated_at: Date;
}
