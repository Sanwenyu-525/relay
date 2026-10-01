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
  | 'WEB_FETCH'
  | 'FILE_WRITE'
  | 'GIT_READ'
  | 'GIT_WRITE'
  | 'CLI_RUN';
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
export interface LogicalOperationRow {
  readonly id: string; readonly workspace_id: string; readonly project_id: string;
  readonly origin: 'RUN' | 'USER_IMPORT'; readonly task_id: string | null;
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
  readonly origin: 'RUN' | 'USER_IMPORT'; readonly task_id: string | null;
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

export interface AssistSessionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string | null;
  readonly task_id: string | null;
  readonly title: string;
  readonly status: AssistSessionStatus;
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
  readonly provider_request_id: string | null;
  readonly usage_input_tokens: number | null;
  readonly usage_output_tokens: number | null;
  readonly worker_id: string | null;
  readonly cancel_requested: boolean;
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
  readonly kind: 'DRAFT' | 'SEMANTIC_CHECK' | 'ASSIST' | 'VERIFY';
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
  readonly budget_reserved_tokens: number | null;
  readonly error_kind: string | null;
  readonly started_at: Date;
  readonly first_text_delta_at: Date | null;
  readonly first_preview_persisted_at: Date | null;
  readonly settled_at: Date | null;
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

export interface RelayDatabaseSchema {
  runtime_admission_gate: RuntimeAdmissionGateRow;
  model_calls: ModelCallRow;
  assist_sessions: AssistSessionRow;
  assist_messages: AssistMessageRow;
  assist_message_previews: AssistMessagePreviewRow;
  run_draft_previews: RunDraftPreviewRow;
  assist_proposals: AssistProposalRow;
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
  change_set_files: ChangeSetFileRow;
  workspaces: WorkspaceRow;
  workspace_execution_authority: WorkspaceExecutionAuthorityRow;
  projects: ProjectRow;
  project_view_configurations: ProjectViewConfigurationRow;
  project_continuation_points: ProjectContinuationPointRow;
  project_continuation_point_refs: ProjectContinuationPointRefRow;
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
}
