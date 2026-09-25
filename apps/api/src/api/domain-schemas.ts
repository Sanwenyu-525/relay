import { Type, type TSchema } from '@sinclair/typebox';

/**
 * P02 的 HTTP wire schema（请求与响应）。
 *
 * 契约来源：docs/api/http-command-contract.md 第 1–7 节与 docs/api/module-api.md 第 1 节。
 *   * JSON 使用 snake_case；ID 是 UUID 字符串；revision / acceptance_revision / epoch 是十进制字符串；
 *   * 时间点是带 Z 的 ISO 8601；请求拒绝未知字段（additionalProperties: false）；
 *   * 不接受客户端声明的 actor、权限结果、完成状态、服务器路径或数据库实体。
 */

const strict = { additionalProperties: false } as const;

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const DECIMAL_PATTERN = '^[0-9]{1,19}$';

export const UuidSchema = Type.String({ pattern: UUID_PATTERN });
export const DecimalSchema = Type.String({ pattern: DECIMAL_PATTERN });
export const TimestampSchema = Type.String({ minLength: 20 });
/** 受约束的参数/证据快照：结构由后续切片收紧，这里只要求是 JSON 对象。 */
export const OpenObjectSchema = Type.Object({}, { additionalProperties: true });

/* -------------------------------------------------------------------------- */
/* 命令回执                                                                    */
/* -------------------------------------------------------------------------- */

export function commandEnvelopeSchema(result: TSchema): TSchema {
  return Type.Object(
    {
      command_id: UuidSchema,
      committed_at: TimestampSchema,
      result,
      links: Type.Object({ resource: Type.String() }, strict),
    },
    strict,
  );
}

export const CommandReceiptSchema = Type.Object(
  {
    command_id: UuidSchema,
    command_type: Type.String(),
    committed_at: TimestampSchema,
    result: OpenObjectSchema,
    links: Type.Object({ resource: Type.String() }, strict),
  },
  strict,
);

/* -------------------------------------------------------------------------- */
/* 结果 schema                                                                 */
/* -------------------------------------------------------------------------- */

export const CreateProjectResultSchema = Type.Object(
  {
    project_id: UuidSchema,
    revision: DecimalSchema,
    phase_key: Type.String(),
    state_revision: DecimalSchema,
  },
  strict,
);

export const CreateGoalResultSchema = Type.Object(
  { goal_id: UuidSchema, status: Type.String(), revision: DecimalSchema },
  strict,
);

export const CreateTaskResultSchema = Type.Object(
  {
    task_id: UuidSchema,
    project_id: Type.Union([UuidSchema, Type.Null()]),
    status: Type.String(),
    mode: Type.String(),
    revision: DecimalSchema,
    acceptance_revision: DecimalSchema,
  },
  strict,
);

export const TaskCommandResultSchema = Type.Object(
  { task_id: UuidSchema, status: Type.String(), revision: DecimalSchema },
  strict,
);

export const CancelTaskPendingResultSchema = Type.Object({
  task_id: UuidSchema, status: Type.Literal('PENDING'), revision: DecimalSchema,
  control_request_id: UuidSchema, run_id: UuidSchema, type: Type.Literal('CANCEL_TASK'),
  run_revision: DecimalSchema,
}, strict);

export const TaskGoalAlignmentResultSchema = Type.Object(
  {
    task_id: UuidSchema,
    revision: DecimalSchema,
    goal_alignment_mode: Type.String(),
    goal_ids: Type.Array(UuidSchema),
  },
  strict,
);

export const ProjectGoalLinkResultSchema = Type.Object(
  { project_id: UuidSchema, revision: DecimalSchema, goal_ids: Type.Array(UuidSchema) },
  strict,
);

export const ProjectGoalUnlinkResultSchema = Type.Object(
  {
    project_id: UuidSchema,
    revision: DecimalSchema,
    impacted_tasks: Type.Array(
      Type.Object({ task_id: UuidSchema, revision: DecimalSchema }, strict),
    ),
  },
  strict,
);

export const StateCommandResultSchema = Type.Object(
  { project_id: UuidSchema, action: Type.String(), revision: DecimalSchema },
  strict,
);

/* -------------------------------------------------------------------------- */
/* P03：Artifact 版本与人工完成/重开                                            */
/* -------------------------------------------------------------------------- */

export const ArtifactVersionResultSchema = Type.Object(
  {
    task_id: UuidSchema,
    artifact_id: UuidSchema,
    artifact_revision: DecimalSchema,
    version_id: UuidSchema,
    version_number: DecimalSchema,
    media_type: Type.String(),
    sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    size: DecimalSchema,
    task_revision: DecimalSchema,
  },
  strict,
);

export const ArtifactVersionSummarySchema = Type.Object(
  {
    artifact_version_id: UuidSchema,
    version_number: DecimalSchema,
    media_type: Type.String(),
    sha256: Type.String(),
    size: DecimalSchema,
    source_kind: Type.String(),
    created_at: TimestampSchema,
  },
  strict,
);

export const ArtifactSchema = Type.Object(
  {
    id: UuidSchema,
    task_id: UuidSchema,
    project_id: Type.Union([UuidSchema, Type.Null()]),
    artifact_kind: Type.String(),
    title: Type.String(),
    revision: DecimalSchema,
    latest_version_id: Type.Union([UuidSchema, Type.Null()]),
    version_count: Type.Integer({ minimum: 0 }),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    versions: Type.Array(ArtifactVersionSummarySchema),
  },
  strict,
);

export const CompleteHumanTaskResultSchema = Type.Object(
  {
    task_id: UuidSchema,
    status: Type.String(),
    revision: DecimalSchema,
    acceptance_revision: DecimalSchema,
    completion_id: UuidSchema,
    human_acceptance_id: UuidSchema,
    artifact_version_ids: Type.Array(UuidSchema),
    state_revision: Type.Union([DecimalSchema, Type.Null()]),
  },
  strict,
);

export const ReopenTaskResultSchema = Type.Object(
  {
    task_id: UuidSchema,
    status: Type.String(),
    revision: DecimalSchema,
    acceptance_revision: DecimalSchema,
    previous_acceptance_revision: DecimalSchema,
    previous_completion_id: Type.Union([UuidSchema, Type.Null()]),
  },
  strict,
);

/* -------------------------------------------------------------------------- */
/* 请求 body                                                                   */
/* -------------------------------------------------------------------------- */

const CommandIdField = UuidSchema;

export const CreateProjectBodySchema = Type.Object(
  {
    command_id: CommandIdField,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    project_type: Type.Union([
      Type.Literal('GENERAL'),
      Type.Literal('THESIS'),
      Type.Literal('DEVELOPMENT'),
    ]),
  },
  strict,
);

export const CreateGoalBodySchema = Type.Object(
  {
    command_id: CommandIdField,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  strict,
);

export const CreateTaskBodySchema = Type.Object(
  {
    command_id: CommandIdField,
    project_id: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    objective: Type.String({ minLength: 1, maxLength: 2000 }),
    mode: Type.Optional(
      Type.Union([
        Type.Literal('ME'),
        Type.Literal('AI_ASSIST'),
        // DELEGATE_AI 是域内取值但本阶段未开放：交给用例返回 CAPABILITY_DISABLED，而不是“字段非法”。
        Type.Literal('DELEGATE_AI'),
      ]),
    ),
    expected_outputs: Type.Optional(OpenObjectSchema),
    criteria: Type.Optional(
      Type.Array(
        Type.Object(
          {
            criterion_id: Type.Optional(Type.String({ maxLength: 64 })),
            statement: Type.String({ minLength: 1, maxLength: 500 }),
            required: Type.Optional(Type.Boolean()),
            method: Type.Optional(Type.String({ maxLength: 32 })),
            target_spec: Type.Optional(OpenObjectSchema),
          },
          strict,
        ),
        { maxItems: 20 },
      ),
    ),
  },
  strict,
);

export const EditTaskPresentationBodySchema = Type.Object(
  {
    command_id: CommandIdField,
    expected_revision: DecimalSchema,
    title: Type.String({ minLength: 1, maxLength: 200 }),
  },
  strict,
);

export const TaskRevisionBodySchema = Type.Object(
  { command_id: CommandIdField, expected_revision: DecimalSchema },
  strict,
);

export const CancelTaskBodySchema = Type.Object(
  { command_id: CommandIdField, expected_task_revision: DecimalSchema,
    expected_run_revision: Type.Optional(DecimalSchema) },
  strict,
);

export const TaskGoalAlignmentBodySchema = Type.Object(
  {
    command_id: CommandIdField,
    expected_revision: DecimalSchema,
    mode: Type.Union([Type.Literal('INHERIT'), Type.Literal('EXPLICIT')]),
    goal_ids: Type.Optional(Type.Array(UuidSchema, { maxItems: 100 })),
  },
  strict,
);

export const TaskDependencyBodySchema = Type.Object(
  {
    command_id: CommandIdField,
    expected_revision: DecimalSchema,
    depends_on_task_id: UuidSchema,
  },
  strict,
);

export const AddTaskDependencyBodySchema = Type.Object(
  {
    command_id: CommandIdField,
    expected_revision: DecimalSchema,
    depends_on_task_id: UuidSchema,
    dependency_kind: Type.Union([Type.Literal('BLOCKS'), Type.Literal('INFORMS')]),
  },
  strict,
);

export const LinkProjectGoalBodySchema = Type.Object(
  {
    command_id: CommandIdField,
    expected_revision: DecimalSchema,
    goal_id: UuidSchema,
  },
  strict,
);

export const UnlinkProjectGoalBodySchema = Type.Object(
  {
    command_id: CommandIdField,
    expected_revision: DecimalSchema,
    goal_id: UuidSchema,
    expected_impacted_task_ids: Type.Array(UuidSchema, { maxItems: 500 }),
  },
  strict,
);

/**
 * 类型化 State 命令：单一 body 结构 + action 判别。
 * 每个 action 的允许参数集合由应用层（state-action.ts）校验，超集字段会被拒绝为 VALIDATION_FAILED。
 */
export const StateCommandBodySchema = Type.Object(
  {
    command_id: CommandIdField,
    expected_revision: DecimalSchema,
    action: Type.Union([
      Type.Literal('SET_PHASE'),
      Type.Literal('SET_NEXT_ACTION'),
      Type.Literal('SELECT_ARTIFACT_VERSION'),
      Type.Literal('ADD_CONFIRMED_RISK'),
      Type.Literal('RESOLVE_BLOCKER'),
    ]),
    phase_key: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    next_action_task_id: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    artifact_version_id: Type.Optional(UuidSchema),
    source_ref: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    statement: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    confirmation_ref: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    blocker_id: Type.Optional(UuidSchema),
  },
  strict,
);

/* -------------------------------------------------------------------------- */
/* P03：Artifact 与完成/重开的命令 body                                         */
/* -------------------------------------------------------------------------- */

/**
 * 正文是 UTF-8 文本，不设 maxLength：JSON 的字符数与 UTF-8 字节数不等价，
 * 256 KiB 上限由用例按字节判定并返回 413（契约第 3 节）。media_type 也不收窄成字面量，
 * 否则不受支持的类型会变成 422 而不是契约要求的 415。
 */
const ContentField = Type.String();
const MediaTypeField = Type.String({ minLength: 1, maxLength: 128 });

export const CreateArtifactBodySchema = Type.Object(
  {
    command_id: CommandIdField,
    expected_task_revision: DecimalSchema,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    media_type: MediaTypeField,
    content: ContentField,
  },
  strict,
);

export const SubmitArtifactVersionBodySchema = Type.Object(
  {
    command_id: CommandIdField,
    expected_artifact_revision: DecimalSchema,
    expected_task_revision: DecimalSchema,
    media_type: MediaTypeField,
    content: ContentField,
  },
  strict,
);

export const CompleteHumanTaskBodySchema = Type.Object(
  {
    command_id: CommandIdField,
    expected_revision: DecimalSchema,
    acceptance_revision: DecimalSchema,
    // 无产物要求的事项允许省略或给出空集合。
    artifact_version_ids: Type.Optional(Type.Array(UuidSchema, { maxItems: 100 })),
    acceptance: Type.Object(
      {
        statement: Type.String({ minLength: 1, maxLength: 500 }),
        accepted_criterion_ids: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
          maxItems: 50,
        }),
        reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      },
      strict,
    ),
  },
  strict,
);

export const ReopenTaskBodySchema = Type.Object(
  {
    command_id: CommandIdField,
    expected_revision: DecimalSchema,
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  },
  strict,
);

/* -------------------------------------------------------------------------- */
/* P05：Delegate 与 Run 查询                                                    */
/* -------------------------------------------------------------------------- */

/**
 * DelegateTask 的 body（docs/api/http-command-contract.md 第 4 节）。
 * `workflow_version_id` / `execution_config_version_id` 是可选版本选择器；P05 只接受内置默认值，
 * 给出其他值由用例返回 409 CAPABILITY_DISABLED（而不是“字段非法”）。
 */
export const DelegateTaskBodySchema = Type.Object(
  {
    command_id: CommandIdField,
    expected_task_revision: DecimalSchema,
    retry_of_run_id: Type.Optional(UuidSchema),
    workflow_version_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    execution_config_version_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    mock_gateway_action: Type.Optional(Type.Object({
      connection_id: UuidSchema,
      resource_id: UuidSchema,
      target: Type.String({ minLength: 1, maxLength: 4096 }),
      content: Type.String({ minLength: 1, maxLength: 1024 }),
    }, strict)),
  },
  strict,
);

export const DelegateTaskResultSchema = Type.Object(
  {
    run_id: UuidSchema,
    task_id: UuidSchema,
    task_revision: DecimalSchema,
    run_revision: DecimalSchema,
    status: Type.String(),
    retry_of_run_id: Type.Union([UuidSchema, Type.Null()]),
  },
  strict,
);

export const RunContractSchema = Type.Object(
  {
    workflow_key: Type.String(),
    workflow_version: Type.String(),
    execution_config_version: Type.String(),
    acceptance_revision: DecimalSchema,
    contract_hash: Type.String(),
  },
  strict,
);

export const RunStepSchema = Type.Object(
  {
    step_id: UuidSchema,
    step_index: Type.Integer({ minimum: 0 }),
    step_kind: Type.String(),
    status: Type.String(),
    started_at: Type.Union([TimestampSchema, Type.Null()]),
    finished_at: Type.Union([TimestampSchema, Type.Null()]),
  },
  strict,
);

export const RunAttemptSchema = Type.Object(
  {
    attempt_id: UuidSchema,
    step_id: UuidSchema,
    step_kind: Type.String(),
    attempt_number: DecimalSchema,
    status: Type.String(),
    claim_epoch: DecimalSchema,
    started_at: Type.Union([TimestampSchema, Type.Null()]),
    finished_at: Type.Union([TimestampSchema, Type.Null()]),
  },
  strict,
);

export const RunResultRefSchema = Type.Object(
  {
    step_kind: Type.String(),
    result_ref: OpenObjectSchema,
  },
  strict,
);

export const RunControlTypeSchema = Type.Union([
  Type.Literal('PAUSE'), Type.Literal('CANCEL'), Type.Literal('HANDOFF'), Type.Literal('CANCEL_TASK'),
]);

export const RunControlRequestBodySchema = Type.Object({
  command_id: CommandIdField,
  expected_task_revision: DecimalSchema,
  expected_run_revision: DecimalSchema,
  type: RunControlTypeSchema,
  supersedes_request_id: Type.Optional(UuidSchema),
}, strict);

export const RunResumeBodySchema = Type.Object({
  command_id: CommandIdField,
  expected_task_revision: DecimalSchema,
  expected_run_revision: DecimalSchema,
}, strict);

export const RunControlRequestResultSchema = Type.Object({
  control_request_id: UuidSchema,
  run_id: UuidSchema,
  task_id: UuidSchema,
  type: RunControlTypeSchema,
  status: Type.Literal('PENDING'),
  run_revision: DecimalSchema,
}, strict);

export const RunResumeResultSchema = Type.Object({
  run_id: UuidSchema,
  status: Type.String(),
  run_revision: DecimalSchema,
}, strict);

export const RunPendingControlSchema = Type.Object({
  id: UuidSchema,
  type: RunControlTypeSchema,
  status: Type.Literal('PENDING'),
  requested_at: TimestampSchema,
}, strict);

export const RunControlRequestSchema = Type.Object({
  id: UuidSchema,
  run_id: UuidSchema,
  task_id: UuidSchema,
  type: RunControlTypeSchema,
  status: Type.Union([Type.Literal('PENDING'), Type.Literal('APPLIED'), Type.Literal('REJECTED'), Type.Literal('SUPERSEDED')]),
  revision: DecimalSchema,
  requested_at: TimestampSchema,
  decided_at: Type.Union([TimestampSchema, Type.Null()]),
  result_ref: Type.Union([OpenObjectSchema, Type.Null()]),
}, strict);

export const RunSchema = Type.Object(
  {
    id: UuidSchema,
    task_id: UuidSchema,
    status: Type.String(),
    revision: DecimalSchema,
    ownership_epoch: DecimalSchema,
    retry_of_run_id: Type.Union([UuidSchema, Type.Null()]),
    current_step_id: Type.Union([UuidSchema, Type.Null()]),
    wait_reason: Type.Union([Type.String(), Type.Null()]),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    terminal_at: Type.Union([TimestampSchema, Type.Null()]),
    contract: RunContractSchema,
    current_step: Type.Union([RunStepSchema, Type.Null()]),
    steps: Type.Array(RunStepSchema),
    recent_attempts: Type.Array(RunAttemptSchema),
    result_refs: Type.Array(RunResultRefSchema),
    blocking_review_ids: Type.Array(UuidSchema),
    pending_control_request: Type.Union([RunPendingControlSchema, Type.Null()]),
    unresolved_operation_ids: Type.Array(UuidSchema),
  },
  strict,
);

/* -------------------------------------------------------------------------- */
/* 查询 schema                                                                 */
/* -------------------------------------------------------------------------- */

export const TasksListQuerySchema = Type.Object(
  {
    project_id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    inbox: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])),
    limit: Type.Optional(Type.String({ pattern: '^[0-9]{1,3}$' })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  strict,
);

export const WorkspaceParamsSchema = Type.Object(
  { workspace_id: UuidSchema },
  strict,
);

export const WorkspaceProjectParamsSchema = Type.Object(
  { workspace_id: UuidSchema, project_id: UuidSchema },
  strict,
);

export const WorkspaceTaskParamsSchema = Type.Object(
  { workspace_id: UuidSchema, task_id: UuidSchema },
  strict,
);

export const WorkspaceGoalParamsSchema = Type.Object(
  { workspace_id: UuidSchema, goal_id: UuidSchema },
  strict,
);

export const WorkspaceCommandParamsSchema = Type.Object(
  { workspace_id: UuidSchema, command_id: UuidSchema },
  strict,
);

export const WorkspaceArtifactParamsSchema = Type.Object(
  { workspace_id: UuidSchema, artifact_id: UuidSchema },
  strict,
);

/**
 * 版本内容下载的路径参数必须是 UUID：任何路径片段（含 `..`、盘符或分隔符）都在 schema 阶段被拒，
 * 服务端不会把它们当作路径使用。
 */
export const WorkspaceArtifactVersionParamsSchema = Type.Object(
  { workspace_id: UuidSchema, artifact_version_id: UuidSchema },
  strict,
);

export const WorkspaceRunParamsSchema = Type.Object(
  { workspace_id: UuidSchema, run_id: UuidSchema },
  strict,
);

export const WorkspaceRunControlParamsSchema = Type.Object(
  { workspace_id: UuidSchema, run_id: UuidSchema, request_id: UuidSchema },
  strict,
);

export const WorkspaceReviewParamsSchema = Type.Object(
  { workspace_id: UuidSchema, review_id: UuidSchema },
  strict,
);

export const ReviewListQuerySchema = Type.Object(
  { status: Type.Optional(Type.Union([Type.Literal('OPEN'), Type.Literal('DECIDED'), Type.Literal('EXPIRED')])) },
  strict,
);

export const ReviewDecisionBodySchema = Type.Object(
  {
    command_id: UuidSchema,
    expected_revision: DecimalSchema,
    target_hash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    decision: Type.Union([
      Type.Literal('ACCEPT'), Type.Literal('REQUEST_CHANGES'),
      Type.Literal('SET_RETRY_BUDGET'), Type.Literal('RETRY_CHECKS'),
      Type.Literal('APPROVE'), Type.Literal('DENY'),
    ]),
    feedback: Type.Optional(Type.String({ maxLength: 4096 })),
    retry_budget: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })),
  },
  strict,
);

export const ReviewDecisionResultSchema = Type.Object(
  {
    review_id: UuidSchema,
    decision_id: UuidSchema,
    decision: Type.String(),
    effect: OpenObjectSchema,
    revision: DecimalSchema,
  },
  strict,
);

export const ReviewSchema = Type.Object(
  {
    id: UuidSchema,
    kind: Type.String(),
    status: Type.String(),
    revision: DecimalSchema,
    project_id: Type.Union([UuidSchema, Type.Null()]),
    task_id: Type.Union([UuidSchema, Type.Null()]),
    run_id: Type.Union([UuidSchema, Type.Null()]),
    reason: Type.String(),
    target_hash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    target: OpenObjectSchema,
    evidence: OpenObjectSchema,
    effect: OpenObjectSchema,
    allowed_decisions: Type.Array(Type.String()),
    expires_at: Type.Union([TimestampSchema, Type.Null()]),
    created_at: TimestampSchema,
    decided_at: Type.Union([TimestampSchema, Type.Null()]),
  },
  strict,
);

export const ReviewListSchema = Type.Object({ items: Type.Array(ReviewSchema) }, strict);

/* -------------------------------------------------------------------------- */
/* 读取投影                                                                    */
/* -------------------------------------------------------------------------- */

export const TaskExecutorSchema = Type.Object(
  {
    kind: Type.String(),
    run_id: Type.Union([UuidSchema, Type.Null()]),
    ownership_epoch: DecimalSchema,
  },
  strict,
);

export const TaskCriterionSchema = Type.Object(
  {
    criterion_id: Type.String(),
    statement: Type.String(),
    required: Type.Boolean(),
    method: Type.String(),
    target_spec: OpenObjectSchema,
  },
  strict,
);

export const TaskAcceptanceSchema = Type.Object(
  {
    acceptance_revision: DecimalSchema,
    objective: Type.String(),
    expected_outputs: OpenObjectSchema,
    source: Type.String(),
    created_at: TimestampSchema,
    criteria: Type.Array(TaskCriterionSchema),
  },
  strict,
);

export const TaskGoalAlignmentSchema = Type.Object(
  {
    mode: Type.String(),
    goal_ids: Type.Array(UuidSchema),
    effective_goal_ids: Type.Array(UuidSchema),
  },
  strict,
);

export const TaskDependencySchema = Type.Object(
  {
    task_id: UuidSchema,
    dependency_kind: Type.String(),
    status: Type.String(),
    title: Type.String(),
  },
  strict,
);

const taskSummaryFields = {
  id: UuidSchema,
  project_id: Type.Union([UuidSchema, Type.Null()]),
  title: Type.String(),
  status: Type.String(),
  mode: Type.String(),
  revision: DecimalSchema,
  acceptance_revision: DecimalSchema,
  executor: TaskExecutorSchema,
  current_completion_id: Type.Union([UuidSchema, Type.Null()]),
  waiting_reason: Type.Union([Type.String(), Type.Null()]),
  blocking_task_ids: Type.Array(UuidSchema),
  unresolved_blocker_ids: Type.Array(UuidSchema),
  allowed_actions: Type.Array(Type.String()),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
} as const;

export const TaskSummarySchema = Type.Object(taskSummaryFields, strict);

export const TaskSchema = Type.Object(
  {
    ...taskSummaryFields,
    acceptance: TaskAcceptanceSchema,
    goal_alignment: TaskGoalAlignmentSchema,
    dependencies: Type.Array(TaskDependencySchema),
  },
  strict,
);

export const TaskListSchema = Type.Object(
  {
    items: Type.Array(TaskSummarySchema),
    next_cursor: Type.Union([Type.String(), Type.Null()]),
  },
  strict,
);

export const ProjectSchema = Type.Object(
  {
    id: UuidSchema,
    title: Type.String(),
    project_type: Type.String(),
    archived_at: Type.Union([TimestampSchema, Type.Null()]),
    revision: DecimalSchema,
    state_revision: DecimalSchema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  },
  strict,
);

export const GoalSchema = Type.Object(
  {
    id: UuidSchema,
    title: Type.String(),
    description: Type.String(),
    status: Type.String(),
    revision: DecimalSchema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  },
  strict,
);

export const ProjectGoalSchema = Type.Object(
  {
    goal_id: UuidSchema,
    title: Type.String(),
    status: Type.String(),
    revision: DecimalSchema,
    explicit_task_ids: Type.Array(UuidSchema),
  },
  strict,
);

export const ProjectGoalListSchema = Type.Object(
  { items: Type.Array(ProjectGoalSchema) },
  strict,
);

export const ProjectStateSchema = Type.Object(
  {
    project_id: UuidSchema,
    phase_key: Type.String(),
    next_action_task_id: Type.Union([UuidSchema, Type.Null()]),
    revision: DecimalSchema,
    updated_at: TimestampSchema,
    in_progress: Type.Array(
      Type.Object(
        {
          task_id: UuidSchema,
          title: Type.String(),
          status: Type.String(),
          mode: Type.String(),
          revision: DecimalSchema,
        },
        strict,
      ),
    ),
    blockers: Type.Array(
      Type.Object(
        {
          blocker_id: UuidSchema,
          target_kind: Type.String(),
          target_id: UuidSchema,
          reason: Type.String(),
          source_ref: Type.String(),
          resolved_at: Type.Union([TimestampSchema, Type.Null()]),
          created_at: TimestampSchema,
        },
        strict,
      ),
    ),
    risks: Type.Array(
      Type.Object(
        {
          risk_id: UuidSchema,
          statement: Type.String(),
          source_ref: Type.String(),
          confirmation_ref: Type.String(),
          resolved_at: Type.Union([TimestampSchema, Type.Null()]),
          created_at: TimestampSchema,
        },
        strict,
      ),
    ),
    completed_highlight_refs: Type.Array(
      Type.Object(
        {
          completion_id: UuidSchema,
          task_id: UuidSchema,
          acceptance_revision: DecimalSchema,
          committed_at: TimestampSchema,
        },
        strict,
      ),
    ),
    selected_artifact_version_refs: Type.Array(
      Type.Object(
        {
          artifact_version_id: UuidSchema,
          artifact_id: UuidSchema,
          version_number: DecimalSchema,
          source_ref: Type.String(),
        },
        strict,
      ),
    ),
    key_decision_refs: Type.Array(UuidSchema),
    dependency_versions: Type.Object(
      {
        project: DecimalSchema,
        state: DecimalSchema,
        workspace_authority: DecimalSchema,
        project_goals: Type.Array(
          Type.Object(
            { goal_id: UuidSchema, revision: DecimalSchema, status: Type.String() },
            strict,
          ),
        ),
        tasks: Type.Array(
          Type.Object({ task_id: UuidSchema, revision: DecimalSchema }, strict),
        ),
        completion_refs: Type.Array(UuidSchema),
        artifact_version_refs: Type.Array(UuidSchema),
      },
      strict,
    ),
    allowed_actions: Type.Array(Type.String()),
  },
  strict,
);
