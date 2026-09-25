import type { DecimalRevision, ExecutorKind, InteractionMode, TaskStatus } from "../types";

export interface RelayApiConnection {
  readonly baseUrl: string;
  readonly workspaceId: string;
  /** 仅在当前浏览器进程内存中保存，调用方不得记录或展示。 */
  readonly bearerToken: string;
}

export interface RelayFieldError {
  readonly field: string;
  readonly message: string;
}

export interface RelayProblem {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly retryable: boolean;
  readonly retryAction: string | null;
  /** 422 的字段定位；界面据此把错误放回对应输入项。 */
  readonly fieldErrors: readonly RelayFieldError[];
  /** 409 REVISION_CONFLICT 的版本差异；界面保留差异而不是直接覆盖。 */
  readonly expectedRevision: string | null;
  readonly actualRevision: string | null;
}

export class RelayApiError extends Error {
  constructor(readonly problem: RelayProblem) {
    super(problem.detail);
    this.name = "RelayApiError";
  }
}

/** 命令响应未能可靠核对时，提交是否已入库无法由浏览器判断。 */
export class RelayTransportError extends Error {
  constructor(message = "网络请求未获得服务端响应。") {
    super(message);
    this.name = "RelayTransportError";
  }
}

export interface RelayProject {
  readonly id: string;
  readonly title: string;
  readonly projectType: string;
  readonly revision: DecimalRevision;
  readonly stateRevision: DecimalRevision;
  readonly archivedAt: string | null;
}

export interface RelayTaskDependency {
  readonly taskId: string;
  readonly dependencyKind: string;
  readonly status: TaskStatus;
  readonly title: string;
}

export interface RelayTaskSummary {
  readonly id: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly status: TaskStatus;
  readonly mode: InteractionMode;
  readonly revision: DecimalRevision;
  readonly executor: ExecutorKind;
  readonly executorRunId: string | null;
  /** 当前完成周期的指针；重开后清空，历史凭据仍保留在服务端。 */
  readonly currentCompletionId: string | null;
  readonly waitingReason: string | null;
  readonly blockingTaskIds: readonly string[];
  readonly unresolvedBlockerIds: readonly string[];
  /** 服务端投影出的 UI 提示，不是客户端授权判断。 */
  readonly allowedActions: readonly string[];
}

export interface RelayTaskDetail extends RelayTaskSummary {
  readonly acceptance: RelayTaskAcceptance;
  readonly dependencies: readonly RelayTaskDependency[];
}

/** GET /tasks/{id} 的验收投影：完成命令要按这份 criteria 的 id 提交接受集合。 */
export interface RelayTaskAcceptance {
  readonly acceptanceRevision: DecimalRevision;
  readonly objective: string;
  readonly source: string;
  readonly criteria: readonly RelayAcceptanceCriterion[];
}

export interface RelayAcceptanceCriterion {
  readonly criterionId: string;
  readonly statement: string;
  readonly required: boolean;
  readonly method: string;
}

export interface RelayArtifactVersionSummary {
  readonly artifactVersionId: string;
  readonly versionNumber: DecimalRevision;
  readonly mediaType: string;
  readonly sha256: string;
  readonly size: DecimalRevision;
  readonly sourceKind: string;
  readonly createdAt: string;
}

export interface RelayArtifact {
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  readonly revision: DecimalRevision;
  readonly latestVersionId: string | null;
  readonly versionCount: number;
  readonly versions: readonly RelayArtifactVersionSummary[];
}

/** 两个保存入口的 201 结果形状相同。 */
export interface RelayArtifactVersionResult {
  readonly taskId: string;
  readonly artifactId: string;
  readonly artifactRevision: DecimalRevision;
  readonly versionId: string;
  readonly versionNumber: DecimalRevision;
  readonly mediaType: string;
  readonly sha256: string;
  readonly size: DecimalRevision;
  readonly taskRevision: DecimalRevision;
}

export interface RelayCompletion {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly revision: DecimalRevision;
  readonly acceptanceRevision: DecimalRevision;
  readonly completionId: string;
  readonly humanAcceptanceId: string;
  readonly artifactVersionIds: readonly string[];
  readonly stateRevision: DecimalRevision | null;
}

export interface RelayReopen {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly revision: DecimalRevision;
  readonly acceptanceRevision: DecimalRevision;
  readonly previousAcceptanceRevision: DecimalRevision;
  readonly previousCompletionId: string | null;
}

/** Project State 的只读投影中与本轮相关的部分（“当前选用”来自服务端，不来自本地记忆）。 */
export interface RelayProjectState {
  readonly projectId: string;
  readonly revision: DecimalRevision;
  readonly phaseKey: string;
  readonly selectedArtifactVersionRefs: readonly RelayStateArtifactRef[];
  readonly completedHighlightRefs: readonly {
    readonly completionId: string;
    readonly taskId: string;
    readonly acceptanceRevision: DecimalRevision;
  }[];
}

export interface RelayStateArtifactRef {
  readonly artifactVersionId: string;
  readonly artifactId: string;
  readonly versionNumber: DecimalRevision;
  readonly sourceRef: string;
}

export interface RelayStateMutation {
  readonly projectId: string;
  readonly action: string;
  readonly revision: DecimalRevision;
}

export interface RelayCommandEnvelope {
  readonly commandId: string;
  readonly committedAt: string;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface RelayCommandReceipt extends RelayCommandEnvelope {
  readonly commandType: string;
}

export type RelayInformationKind = "KNOWLEDGE" | "MEMORY" | "DECISION" | "RULE";
export type RelayKnowledgeSource = "NOTE" | "MANAGED_TEXT" | "ARTIFACT_VERSION";
export type RelayRuleStrength = "HARD" | "PREFERENCE";
export type RelayRuleEnforcement = "PRE_ACTION" | "POST_CHECK" | "SEMANTIC" | "HUMAN";

export interface RelayKnowledge {
  readonly id: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly currentVersion: DecimalRevision;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelayKnowledgeVersion {
  readonly id: string;
  readonly knowledgeId: string;
  readonly version: DecimalRevision;
  readonly sourceKind: RelayKnowledgeSource;
  readonly mediaType: string;
  readonly contentSha256: string;
  readonly availability: string;
  readonly excerpt: string | null;
  readonly sourceRefs: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface RelayMemory {
  readonly id: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly currentVersion: DecimalRevision;
  readonly text: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelayMemoryRevision {
  readonly id: string;
  readonly memoryId: string;
  readonly version: DecimalRevision;
  readonly title: string;
  readonly text: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface RelayDecision {
  readonly id: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly currentVersion: DecimalRevision;
  readonly choice: string;
  readonly rationale: string;
  readonly alternatives: readonly string[];
  readonly costs: readonly string[];
  readonly supersededById: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelayRule {
  readonly id: string;
  readonly scope: "WORKSPACE" | "PROJECT" | "TASK";
  readonly scopeId: string;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly currentVersion: DecimalRevision;
  readonly ruleKey: string;
  readonly statement: string;
  readonly strength: RelayRuleStrength;
  readonly applicability: string;
  readonly enforcement: RelayRuleEnforcement;
  readonly method: string | null;
  readonly targetSpec: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelayRuleVersion {
  readonly ruleId: string;
  readonly version: DecimalRevision;
  readonly ruleKey: string;
  readonly statement: string;
  readonly strength: RelayRuleStrength;
  readonly applicability: string;
  readonly enforcement: RelayRuleEnforcement;
  readonly method: string | null;
  readonly targetSpec: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface RelaySearchItem {
  readonly type: RelayInformationKind;
  readonly id: string;
  readonly version: DecimalRevision;
  readonly title: string;
  readonly snippet: string;
  readonly matchedFields: readonly string[];
  readonly sourceRef: string;
  readonly status: string;
  readonly projectId: string | null;
}

export interface RelaySearchPage {
  readonly items: readonly RelaySearchItem[];
  readonly nextCursor: string | null;
}

export interface RelayReadiness {
  readonly status: "ready";
}

export type RelayReviewKind = "CRITERION" | "RETRY_BUDGET" | "CHECKER_RETRY" | "ACTION_APPROVAL" | "STATE_PROPOSAL";
export type RelayReviewDecision = "ACCEPT" | "REQUEST_CHANGES" | "SET_RETRY_BUDGET" | "RETRY_CHECKS" | "APPROVE" | "DENY";

export interface RelayReview {
  readonly id: string;
  readonly kind: RelayReviewKind;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly reason: string;
  readonly targetHash: string;
  readonly target: Readonly<Record<string, unknown>>;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly effect: Readonly<Record<string, unknown>>;
  readonly allowedDecisions: readonly RelayReviewDecision[];
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export type RelayControlType = "PAUSE" | "CANCEL" | "HANDOFF" | "CANCEL_TASK";

export interface RelayControlRequest {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly type: RelayControlType;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly resultRef: Readonly<Record<string, unknown>> | null;
}

export interface RelayRun {
  readonly id: string;
  readonly taskId: string;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly waitReason: string | null;
  readonly currentStepId: string | null;
  readonly steps: readonly {
    readonly id: string;
    readonly index: number;
    readonly kind: string;
    readonly status: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
  }[];
  readonly recentAttempts: readonly {
    readonly id: string;
    readonly stepKind: string;
    readonly number: DecimalRevision;
    readonly status: string;
  }[];
  readonly blockingReviewIds: readonly string[];
  readonly pendingControlRequest: { readonly id: string; readonly type: RelayControlType; readonly status: string; readonly requestedAt: string } | null;
  readonly unresolvedOperationIds: readonly string[];
}

export interface RelayContextManifestSummary {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string | null;
  readonly createdAt: string;
  readonly builderVersion: string;
  readonly templateVersion: string;
  readonly manifestHash: string;
}

export interface RelayContextBuild {
  readonly status: "NOT_STARTED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  readonly reasonCode: string | null;
  readonly message: string | null;
}

export interface RelayContextManifestList {
  readonly items: readonly RelayContextManifestSummary[];
  readonly build: RelayContextBuild;
}

export interface RelayContextManifestDetail extends RelayContextManifestSummary {
  readonly budget: {
    readonly limitTokens: number;
    readonly reservedTokens: number;
    readonly requiredTokens: number | null;
    readonly selectedTokens: number | null;
    readonly estimation: string;
  } | null;
  readonly dependencies: {
    readonly contractHash: string | null;
    readonly workflowVersion: string | null;
    readonly executionConfigVersion: string | null;
    readonly profile: { readonly id: string; readonly version: string; readonly digest: string } | null;
    readonly skill: { readonly id: string; readonly version: string; readonly digest: string } | null;
  };
  readonly sources: readonly {
    readonly kind: string;
    readonly sourceRef: string;
    readonly version: string;
    readonly sha256: string;
    readonly sourceSha256: string;
    readonly range: { readonly start: number; readonly end: number; readonly unit: "UTF8_BYTE" };
    readonly content: string;
    readonly role: "MANDATORY" | "RELEVANT" | "STEP_SPECIFIC";
    readonly trust: "CANONICAL" | "UNTRUSTED_DATA";
    readonly selectionReason: "TITLE_MATCH" | "RECENT_SCOPE_FALLBACK" | null;
  }[];
  readonly exclusions: readonly { readonly sourceRef: string; readonly reason: "BUDGET_TRIMMED" | "SOURCE_UNAVAILABLE" }[];
}

export interface RelayControlSubmission {
  readonly controlRequestId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly type: RelayControlType;
  readonly status: "PENDING";
  readonly runRevision: DecimalRevision;
}

export interface RelayResumeSubmission {
  readonly runId: string;
  readonly status: string;
  readonly runRevision: DecimalRevision;
}

/** CreateProject 的 201 结果（docs/api/http-command-contract.md 第 3 节）。 */
export interface RelayProjectCreation {
  readonly projectId: string;
  readonly revision: DecimalRevision;
  readonly phaseKey: string;
  readonly stateRevision: DecimalRevision;
}

/** CreateTask 的 201 结果：新任务一律 INBOX + HUMAN，验收版本从 v1 开始。 */
export interface RelayTaskCreation {
  readonly taskId: string;
  readonly projectId: string | null;
  readonly status: TaskStatus;
  readonly mode: InteractionMode;
  readonly revision: DecimalRevision;
  readonly acceptanceRevision: DecimalRevision;
}

/** Task 状态迁移命令的 200 结果。 */
export interface RelayTaskMutation {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly revision: DecimalRevision;
}

/**
 * P04 的窄客户端：只覆盖工作台已经有服务端契约的读取、创建、状态迁移与回执查询。
 * 不与 fixtureAdapter 混用，也不缓存任何业务事实或凭据。
 * 未实现的端点不在这里建占位方法，调用方必须继续显示“未接入”。
 */
export class RelayApiClient {
  readonly #baseUrl: string;
  readonly #workspaceId: string;
  readonly #bearerToken: string;

  constructor(connection: RelayApiConnection) {
    this.#baseUrl = normalizeBaseUrl(connection.baseUrl);
    this.#workspaceId = requiredText(connection.workspaceId, "workspace ID");
    this.#bearerToken = requiredText(connection.bearerToken, "Bearer 令牌");
  }

  get workspaceId(): string {
    return this.#workspaceId;
  }

  async getHealthReady(): Promise<RelayReadiness> {
    const body = await this.request("/health/ready");
    const record = object(body, "readiness");
    if (string(record, "status", "readiness") !== "ready") {
      throw new Error("服务端返回了无法识别的 readiness 状态。");
    }
    return { status: "ready" };
  }

  async getProject(projectId: string): Promise<RelayProject> {
    return projectFrom(await this.request(this.workspacePath(`/projects/${encodeURIComponent(projectId)}`)));
  }

  /** 逻辑上的“项目任务读取”映射为当前契约的 GET /tasks?project_id=。 */
  async getProjectTasks(projectId: string): Promise<readonly RelayTaskSummary[]> {
    const query = new URLSearchParams({ project_id: projectId });
    const body = await this.request(`${this.workspacePath("/tasks")}?${query.toString()}`);
    const record = object(body, "task list");
    return array(record, "items", "task list").map((item) => taskFrom(item));
  }

  async getTask(taskId: string): Promise<RelayTaskDetail> {
    const body = await this.request(this.workspacePath(`/tasks/${encodeURIComponent(taskId)}`));
    const task = taskFrom(body);
    const record = object(body, "task");
    return {
      ...task,
      acceptance: acceptanceFrom(object(record.acceptance, "task.acceptance")),
      dependencies: array(record, "dependencies", "task").map((item) => dependencyFrom(item))
    };
  }

  async createProject(input: {
    readonly commandId: string;
    readonly title: string;
    readonly projectType: string;
  }): Promise<RelayProjectCreation> {
    const body = await this.request(this.workspacePath("/projects"), {
      method: "POST",
      body: JSON.stringify({
        command_id: input.commandId,
        title: input.title,
        project_type: input.projectType
      })
    });
    return projectCreationFrom(commandEnvelopeFrom(body).result);
  }

  async createTask(input: {
    readonly commandId: string;
    readonly projectId: string | null;
    readonly title: string;
    readonly objective: string;
    readonly mode: InteractionMode;
    /** 每行一条验收标准；criterion_id 与 method 由服务端补齐。 */
    readonly criteria: readonly string[];
  }): Promise<RelayTaskCreation> {
    const body = await this.request(this.workspacePath("/tasks"), {
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

  async markTaskReady(input: {
    readonly taskId: string;
    readonly commandId: string;
    readonly expectedRevision: DecimalRevision;
  }): Promise<RelayTaskMutation> {
    const body = await this.request(this.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/ready`), {
      method: "POST",
      body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision })
    });
    return taskMutationFrom(commandEnvelopeFrom(body).result);
  }

  /**
   * POST /tasks/{id}/dependency-links：新增一条任务依赖。
   * expected_revision 必须是上一步返回的 revision；BLOCKS 表示前置未完成会阻塞本任务。
   */
  async addTaskDependency(input: {
    readonly taskId: string;
    readonly commandId: string;
    readonly expectedRevision: DecimalRevision;
    readonly dependsOnTaskId: string;
    readonly dependencyKind: "BLOCKS" | "INFORMS";
  }): Promise<RelayTaskMutation> {
    const body = await this.request(
      this.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/dependency-links`),
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

  async startHumanTask(input: {
    readonly taskId: string;
    readonly commandId: string;
    readonly expectedRevision: DecimalRevision;
  }): Promise<RelayTaskMutation> {
    const body = await this.request(this.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/start`), {
      method: "POST",
      body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision })
    });
    return taskMutationFrom(commandEnvelopeFrom(body).result);
  }

  async getCommandReceipt(commandId: string): Promise<RelayCommandReceipt> {
    const body = await this.request(this.workspacePath(`/commands/${encodeURIComponent(commandId)}`));
    const envelope = commandEnvelopeFrom(body);
    const record = object(body, "command receipt");
    return { ...envelope, commandType: string(record, "command_type", "command receipt") };
  }

  async getKnowledge(projectId: string | null = null): Promise<readonly RelayKnowledge[]> {
    return directList(await this.request(this.informationListPath("knowledge", projectId)), "knowledge list", knowledgeFrom);
  }

  async getKnowledgeDetail(id: string): Promise<RelayKnowledge> {
    return knowledgeFrom(await this.request(this.workspacePath(`/knowledge/${encodeURIComponent(id)}`)));
  }

  async getKnowledgeVersions(id: string): Promise<readonly RelayKnowledgeVersion[]> {
    return directList(await this.request(this.workspacePath(`/knowledge/${encodeURIComponent(id)}/versions`)),
      "knowledge versions", knowledgeVersionFrom);
  }

  async createKnowledge(input: { commandId: string; projectId: string | null; title: string;
    sourceKind: RelayKnowledgeSource; text?: string; mediaType?: string; artifactVersionId?: string }): Promise<RelayCommandEnvelope> {
    return this.informationCommand("/knowledge", {
      command_id: input.commandId, project_id: input.projectId, title: input.title,
      source_kind: input.sourceKind,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.mediaType === undefined ? {} : { media_type: input.mediaType }),
      ...(input.artifactVersionId === undefined ? {} : { artifact_version_id: input.artifactVersionId })
    }, 201);
  }

  async addKnowledgeVersion(input: { id: string; commandId: string; expectedRevision: DecimalRevision;
    sourceKind: RelayKnowledgeSource; text?: string; mediaType?: string; artifactVersionId?: string }): Promise<RelayCommandEnvelope> {
    return this.informationCommand(`/knowledge/${encodeURIComponent(input.id)}/versions`, {
      command_id: input.commandId, expected_revision: input.expectedRevision, source_kind: input.sourceKind,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.mediaType === undefined ? {} : { media_type: input.mediaType }),
      ...(input.artifactVersionId === undefined ? {} : { artifact_version_id: input.artifactVersionId })
    }, 200);
  }

  async archiveKnowledge(id: string, commandId: string, expectedRevision: DecimalRevision): Promise<RelayCommandEnvelope> {
    return this.informationCommand(`/knowledge/${encodeURIComponent(id)}/archive`,
      { command_id: commandId, expected_revision: expectedRevision }, 200);
  }

  async getMemories(projectId: string | null = null): Promise<readonly RelayMemory[]> {
    return directList(await this.request(this.informationListPath("memories", projectId)), "memory list", memoryFrom);
  }

  async getMemory(id: string): Promise<RelayMemory> {
    return memoryFrom(await this.request(this.workspacePath(`/memories/${encodeURIComponent(id)}`)));
  }

  async getMemoryRevisions(id: string): Promise<readonly RelayMemoryRevision[]> {
    return directList(await this.request(this.workspacePath(`/memories/${encodeURIComponent(id)}/revisions`)),
      "memory revisions", memoryRevisionFrom);
  }

  async createMemory(input: { commandId: string; projectId: string | null; title: string; text: string;
    confirmed: true; expiresAt?: string | null }): Promise<RelayCommandEnvelope> {
    return this.informationCommand("/memories", {
      command_id: input.commandId, project_id: input.projectId, title: input.title,
      text: input.text, confirmed: input.confirmed,
      ...(input.expiresAt === undefined ? {} : { expires_at: input.expiresAt })
    }, 201);
  }

  async addMemoryRevision(input: { id: string; commandId: string; expectedRevision: DecimalRevision;
    title: string; text: string; confirmed: true; expiresAt?: string | null }): Promise<RelayCommandEnvelope> {
    return this.informationCommand(`/memories/${encodeURIComponent(input.id)}/revisions`, {
      command_id: input.commandId, expected_revision: input.expectedRevision, title: input.title,
      text: input.text, confirmed: input.confirmed,
      ...(input.expiresAt === undefined ? {} : { expires_at: input.expiresAt })
    }, 200);
  }

  async retireMemory(id: string, commandId: string, expectedRevision: DecimalRevision): Promise<RelayCommandEnvelope> {
    return this.informationCommand(`/memories/${encodeURIComponent(id)}/retire`,
      { command_id: commandId, expected_revision: expectedRevision }, 200);
  }

  async getDecisions(projectId: string | null = null): Promise<readonly RelayDecision[]> {
    return directList(await this.request(this.informationListPath("decisions", projectId)), "decision list", decisionFrom);
  }

  async getDecision(id: string): Promise<RelayDecision> {
    return decisionFrom(await this.request(this.workspacePath(`/decisions/${encodeURIComponent(id)}`)));
  }

  async createDecision(input: { commandId: string; projectId: string | null; title: string; choice: string;
    rationale: string; alternatives: readonly string[]; costs: readonly string[] }): Promise<RelayCommandEnvelope> {
    return this.informationCommand("/decisions", {
      command_id: input.commandId, project_id: input.projectId, title: input.title,
      choice: input.choice, rationale: input.rationale,
      alternatives: [...input.alternatives], costs: [...input.costs]
    }, 201);
  }

  async supersedeDecision(input: { id: string; commandId: string; expectedRevision: DecimalRevision;
    replacementDecisionId: string }): Promise<RelayCommandEnvelope> {
    return this.informationCommand(`/decisions/${encodeURIComponent(input.id)}/supersessions`, {
      command_id: input.commandId, expected_revision: input.expectedRevision,
      replacement_decision_id: input.replacementDecisionId
    }, 200);
  }

  async getRules(projectId: string | null = null): Promise<readonly RelayRule[]> {
    return directList(await this.request(this.informationListPath("rules", projectId)), "rule list", ruleFrom);
  }

  async getRule(id: string): Promise<RelayRule> {
    return ruleFrom(await this.request(this.workspacePath(`/rules/${encodeURIComponent(id)}`)));
  }

  async getRuleVersions(id: string): Promise<readonly RelayRuleVersion[]> {
    return directList(await this.request(this.workspacePath(`/rules/${encodeURIComponent(id)}/versions`)),
      "rule versions", ruleVersionFrom);
  }

  async createRule(input: { commandId: string; scope: "WORKSPACE" | "PROJECT" | "TASK"; scopeId: string;
    ruleKey: string; statement: string; strength: RelayRuleStrength; enforcement: RelayRuleEnforcement;
    method?: string; targetSpec?: Readonly<Record<string, unknown>> }): Promise<RelayCommandEnvelope> {
    return this.informationCommand("/rules", {
      command_id: input.commandId, scope: input.scope, scope_id: input.scopeId,
      rule_key: input.ruleKey, statement: input.statement, strength: input.strength,
      applicability: "AI_RUN", enforcement: input.enforcement,
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.targetSpec === undefined ? {} : { target_spec: input.targetSpec })
    }, 201);
  }

  async addRuleVersion(input: { id: string; commandId: string; expectedRevision: DecimalRevision;
    ruleKey: string; statement: string; strength: RelayRuleStrength; enforcement: RelayRuleEnforcement;
    method?: string; targetSpec?: Readonly<Record<string, unknown>> }): Promise<RelayCommandEnvelope> {
    return this.informationCommand(`/rules/${encodeURIComponent(input.id)}/versions`, {
      command_id: input.commandId, expected_revision: input.expectedRevision,
      rule_key: input.ruleKey, statement: input.statement, strength: input.strength,
      applicability: "AI_RUN", enforcement: input.enforcement,
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.targetSpec === undefined ? {} : { target_spec: input.targetSpec })
    }, 200);
  }

  async retireRule(id: string, commandId: string, expectedRevision: DecimalRevision): Promise<RelayCommandEnvelope> {
    return this.informationCommand(`/rules/${encodeURIComponent(id)}/retire`,
      { command_id: commandId, expected_revision: expectedRevision }, 200);
  }

  async searchInformation(input: { q: string; projectId: string | null; types: readonly RelayInformationKind[];
    limit?: number; cursor?: string }): Promise<RelaySearchPage> {
    const query = new URLSearchParams({ q: input.q, types: input.types.join(","), limit: String(input.limit ?? 20) });
    if (input.projectId !== null) query.set("project_id", input.projectId);
    if (input.cursor !== undefined) query.set("cursor", input.cursor);
    const record = object(await this.request(`${this.workspacePath("/search")}?${query.toString()}`), "search");
    return {
      items: array(record, "items", "search").map(searchItemFrom),
      nextCursor: nullableString(record, "next_cursor", "search")
    };
  }

  private informationListPath(resource: string, projectId: string | null): string {
    const path = this.workspacePath(`/${resource}`);
    return projectId === null ? path : `${path}?${new URLSearchParams({ project_id: projectId })}`;
  }

  private async informationCommand(path: string, payload: Record<string, unknown>, status: number): Promise<RelayCommandEnvelope> {
    const body = await this.request(this.workspacePath(path), { method: "POST", body: JSON.stringify(payload) }, status);
    try {
      const envelope = commandEnvelopeFrom(body);
      if (envelope.commandId !== payload.command_id) throw new Error("command ID mismatch");
      return envelope;
    } catch {
      throw new RelayTransportError("命令回执无法核对，请查询原 command_id。");
    }
  }

  async getReviews(): Promise<readonly RelayReview[]> {
    const body = await this.request(`${this.workspacePath("/reviews")}?status=OPEN`);
    const record = object(body, "review list");
    return array(record, "items", "review list").map(reviewFrom);
  }

  async getReview(reviewId: string): Promise<RelayReview> {
    return reviewFrom(await this.request(this.workspacePath(`/reviews/${encodeURIComponent(reviewId)}`)));
  }

  async getRun(runId: string): Promise<RelayRun> {
    return runFrom(await this.request(this.workspacePath(`/runs/${encodeURIComponent(runId)}`)));
  }

  async getRunContextManifests(runId: string): Promise<RelayContextManifestList> {
    const record = object(await this.request(this.workspacePath(`/runs/${encodeURIComponent(runId)}/context-manifests`)), "context manifest list");
    return {
      items: array(record, "items", "context manifest list").map((item) => contextManifestSummaryFrom(item, runId)),
      build: contextBuildFrom(record.build)
    };
  }

  async getRunContextManifest(runId: string, manifestId: string): Promise<RelayContextManifestDetail> {
    const body = await this.request(this.workspacePath(`/runs/${encodeURIComponent(runId)}/context-manifests/${encodeURIComponent(manifestId)}`));
    return contextManifestDetailFrom(body, runId, manifestId);
  }

  async getRunReviews(runId: string): Promise<readonly RelayReview[]> {
    const body = await this.request(this.workspacePath(`/runs/${encodeURIComponent(runId)}/reviews`));
    return array(object(body, "run reviews"), "items", "run reviews").map(reviewFrom);
  }

  async getControlRequest(runId: string, requestId: string): Promise<RelayControlRequest> {
    const body = await this.request(this.workspacePath(`/runs/${encodeURIComponent(runId)}/control-requests/${encodeURIComponent(requestId)}`));
    return controlRequestFrom(body);
  }

  async requestRunControl(input: {
    readonly runId: string;
    readonly commandId: string;
    readonly expectedTaskRevision: DecimalRevision;
    readonly expectedRunRevision: DecimalRevision;
    readonly type: RelayControlType;
  }): Promise<RelayControlSubmission> {
    const body = await this.request(this.workspacePath(`/runs/${encodeURIComponent(input.runId)}/control-requests`), {
      method: "POST",
      body: JSON.stringify({
        command_id: input.commandId,
        expected_task_revision: input.expectedTaskRevision,
        expected_run_revision: input.expectedRunRevision,
        type: input.type
      })
    }, 202);
    try {
      const envelope = commandEnvelopeFrom(body);
      const result = controlSubmissionFrom(envelope.result);
      if (envelope.commandId !== input.commandId || result.runId !== input.runId || result.type !== input.type) {
        throw new Error("控制回执与提交的命令不匹配。");
      }
      return result;
    } catch {
      throw new RelayTransportError("控制回执无法核对，请查询原 command_id。");
    }
  }

  async resumeRun(input: {
    readonly runId: string;
    readonly commandId: string;
    readonly expectedTaskRevision: DecimalRevision;
    readonly expectedRunRevision: DecimalRevision;
  }): Promise<RelayResumeSubmission> {
    const body = await this.request(this.workspacePath(`/runs/${encodeURIComponent(input.runId)}/resume`), {
      method: "POST",
      body: JSON.stringify({
        command_id: input.commandId,
        expected_task_revision: input.expectedTaskRevision,
        expected_run_revision: input.expectedRunRevision
      })
    }, 202);
    try {
      const envelope = commandEnvelopeFrom(body);
      const result = {
        runId: string(envelope.result, "run_id", "resume result"),
        status: string(envelope.result, "status", "resume result"),
        runRevision: decimal(envelope.result, "run_revision", "resume result")
      };
      if (envelope.commandId !== input.commandId || result.runId !== input.runId) {
        throw new Error("恢复回执与提交的命令不匹配。");
      }
      return result;
    } catch {
      throw new RelayTransportError("恢复回执无法核对，请查询原 command_id。");
    }
  }

  async decideReview(input: {
    readonly reviewId: string;
    readonly commandId: string;
    readonly expectedRevision: DecimalRevision;
    readonly targetHash: string;
    readonly decision: RelayReviewDecision;
    readonly feedback?: string;
    readonly retryBudget?: number;
  }): Promise<RelayCommandEnvelope> {
    const body = await this.request(this.workspacePath(`/reviews/${encodeURIComponent(input.reviewId)}/decisions`), {
      method: "POST",
      body: JSON.stringify({
        command_id: input.commandId,
        expected_revision: input.expectedRevision,
        target_hash: input.targetHash,
        decision: input.decision,
        ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
        ...(input.retryBudget === undefined ? {} : { retry_budget: input.retryBudget })
      })
    });
    return commandEnvelopeFrom(body);
  }

  async createArtifactWithVersion(input: {
    readonly taskId: string;
    readonly commandId: string;
    readonly expectedTaskRevision: DecimalRevision;
    readonly title: string;
    readonly mediaType: string;
    readonly content: string;
  }): Promise<RelayArtifactVersionResult> {
    const body = await this.request(this.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/artifacts`), {
      method: "POST",
      body: JSON.stringify({
        command_id: input.commandId,
        expected_task_revision: input.expectedTaskRevision,
        title: input.title,
        media_type: input.mediaType,
        content: input.content
      })
    });
    return artifactVersionResultFrom(commandEnvelopeFrom(body).result);
  }

  async submitArtifactVersion(input: {
    readonly artifactId: string;
    readonly commandId: string;
    readonly expectedArtifactRevision: DecimalRevision;
    readonly expectedTaskRevision: DecimalRevision;
    readonly mediaType: string;
    readonly content: string;
  }): Promise<RelayArtifactVersionResult> {
    const body = await this.request(
      this.workspacePath(`/artifacts/${encodeURIComponent(input.artifactId)}/versions`),
      {
        method: "POST",
        body: JSON.stringify({
          command_id: input.commandId,
          expected_artifact_revision: input.expectedArtifactRevision,
          expected_task_revision: input.expectedTaskRevision,
          media_type: input.mediaType,
          content: input.content
        })
      }
    );
    return artifactVersionResultFrom(commandEnvelopeFrom(body).result);
  }

  async getArtifact(artifactId: string): Promise<RelayArtifact> {
    return artifactFrom(await this.request(this.workspacePath(`/artifacts/${encodeURIComponent(artifactId)}`)));
  }

  /** 正文接口返回 text/markdown 本身而不是 JSON，因此单独走文本读取。 */
  async getArtifactVersionContent(artifactVersionId: string): Promise<string> {
    return this.requestText(
      this.workspacePath(`/artifact-versions/${encodeURIComponent(artifactVersionId)}/content`)
    );
  }

  async completeHumanTask(input: {
    readonly taskId: string;
    readonly commandId: string;
    readonly expectedRevision: DecimalRevision;
    readonly acceptanceRevision: DecimalRevision;
    readonly artifactVersionIds: readonly string[];
    readonly statement: string;
    readonly acceptedCriterionIds: readonly string[];
    readonly reason: string | null;
  }): Promise<RelayCompletion> {
    const body = await this.request(this.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/complete`), {
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
    return completionFrom(commandEnvelopeFrom(body).result);
  }

  async reopenTask(input: {
    readonly taskId: string;
    readonly commandId: string;
    readonly expectedRevision: DecimalRevision;
    readonly reason: string;
  }): Promise<RelayReopen> {
    const body = await this.request(this.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/reopen`), {
      method: "POST",
      body: JSON.stringify({
        command_id: input.commandId,
        expected_revision: input.expectedRevision,
        reason: input.reason
      })
    });
    return reopenFrom(commandEnvelopeFrom(body).result);
  }

  async getProjectState(projectId: string): Promise<RelayProjectState> {
    return projectStateFrom(
      await this.request(this.workspacePath(`/projects/${encodeURIComponent(projectId)}/state`))
    );
  }

  /**
   * “选择要接受的版本”是 Project State 的类型化命令，不是 Task 字段。
   * 该 action 要求 source_ref（选择依据的来源引用），不能省略：服务端按 REQUIRED_INPUT_MISSING 拒绝。
   */
  async selectArtifactVersion(input: {
    readonly projectId: string;
    readonly commandId: string;
    readonly expectedRevision: DecimalRevision;
    readonly artifactVersionId: string;
    readonly sourceRef: string;
  }): Promise<RelayStateMutation> {
    const body = await this.request(
      this.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/state-commands`),
      {
        method: "POST",
        body: JSON.stringify({
          command_id: input.commandId,
          expected_revision: input.expectedRevision,
          action: "SELECT_ARTIFACT_VERSION",
          artifact_version_id: input.artifactVersionId,
          source_ref: input.sourceRef
        })
      }
    );
    return stateMutationFrom(commandEnvelopeFrom(body).result);
  }

  private workspacePath(path: string): string {
    return `/api/v1/workspaces/${encodeURIComponent(this.#workspaceId)}${path}`;
  }

  private async request(path: string, init: RequestInit = {}, expectedStatus?: number): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#bearerToken}`,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...init.headers
        }
      });
    } catch (caught) {
      throw new RelayTransportError(caught instanceof Error ? caught.message : undefined);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (response.ok && init.method === "POST") {
        throw new RelayTransportError("命令响应内容未能读取，请查询原 command_id。");
      }
      body = null;
    }
    if (!response.ok) {
      const record = isRecord(body) ? body : {};
      const conflict = isRecord(record.conflict) ? record.conflict : {};
      throw new RelayApiError({
        status: response.status,
        code: optionalString(record, "code") ?? "HTTP_ERROR",
        detail: optionalString(record, "detail") ?? `服务端返回 HTTP ${response.status}。`,
        retryable: record.retryable === true,
        retryAction: optionalString(record, "retry_action"),
        fieldErrors: fieldErrorsFrom(record),
        expectedRevision: optionalString(conflict, "expected_revision"),
        actualRevision: optionalString(conflict, "actual_revision")
      });
    }
    if (expectedStatus !== undefined && response.status !== expectedStatus) {
      throw new RelayTransportError(`命令响应为 HTTP ${response.status}，无法按预期核对回执。`);
    }
    return body;
  }

  /** 受授权下载返回正文本身；错误仍然是 application/problem+json。 */
  private async requestText(path: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        headers: { Accept: "text/markdown, text/plain", Authorization: `Bearer ${this.#bearerToken}` }
      });
    } catch (caught) {
      throw new RelayTransportError(caught instanceof Error ? caught.message : undefined);
    }

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const record = isRecord(body) ? body : {};
      throw new RelayApiError({
        status: response.status,
        code: optionalString(record, "code") ?? "HTTP_ERROR",
        detail: optionalString(record, "detail") ?? `服务端返回 HTTP ${response.status}。`,
        retryable: record.retryable === true,
        retryAction: optionalString(record, "retry_action"),
        fieldErrors: fieldErrorsFrom(record),
        expectedRevision: null,
        actualRevision: null
      });
    }

    return response.text();
  }
}

function fieldErrorsFrom(record: Record<string, unknown>): readonly RelayFieldError[] {
  const value = record.field_errors;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.field !== "string" || typeof item.message !== "string") {
      return [];
    }
    return [{ field: item.field, message: item.message }];
  });
}

export function createCommandId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeBaseUrl(value: string): string {
  const raw = requiredText(value, "API base URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("API base URL 必须是完整的 http 或 https 地址。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API base URL 只允许 http 或 https。");
  }
  if (url.search || url.hash) {
    throw new Error("API base URL 不应包含查询参数或片段。");
  }
  return url.toString().replace(/\/$/u, "");
}

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized === "") {
    throw new Error(`${name} 不能为空。`);
  }
  return normalized;
}

function reviewFrom(value: unknown): RelayReview {
  const record = object(value, "review");
  const kind = string(record, "kind", "review");
  const kinds: readonly RelayReviewKind[] = ["CRITERION", "RETRY_BUDGET", "CHECKER_RETRY", "ACTION_APPROVAL", "STATE_PROPOSAL"];
  if (!kinds.includes(kind as RelayReviewKind)) {
    throw new Error("review.kind 包含未知类型。");
  }
  const decisions: readonly RelayReviewDecision[] = ["ACCEPT", "REQUEST_CHANGES", "SET_RETRY_BUDGET", "RETRY_CHECKS", "APPROVE", "DENY"];
  const allowedDecisions = stringArray(record, "allowed_decisions", "review");
  if (allowedDecisions.some((decision) => !decisions.includes(decision as RelayReviewDecision))) {
    throw new Error("review.allowed_decisions 包含未知决定。");
  }
  return {
    id: string(record, "id", "review"),
    kind: kind as RelayReviewKind,
    status: string(record, "status", "review"),
    revision: decimal(record, "revision", "review"),
    projectId: nullableString(record, "project_id", "review"),
    taskId: nullableString(record, "task_id", "review"),
    runId: nullableString(record, "run_id", "review"),
    reason: string(record, "reason", "review"),
    targetHash: string(record, "target_hash", "review"),
    target: object(record.target, "review.target"),
    evidence: object(record.evidence, "review.evidence"),
    effect: object(record.effect, "review.effect"),
    allowedDecisions: allowedDecisions as readonly RelayReviewDecision[],
    expiresAt: nullableString(record, "expires_at", "review"),
    createdAt: string(record, "created_at", "review"),
    decidedAt: nullableString(record, "decided_at", "review")
  };
}

function controlType(record: Record<string, unknown>, name: string): RelayControlType {
  const value = string(record, "type", name);
  if (value !== "PAUSE" && value !== "CANCEL" && value !== "HANDOFF" && value !== "CANCEL_TASK") {
    throw new Error(`${name}.type 包含未知控制类型。`);
  }
  return value;
}

function controlSubmissionFrom(result: Readonly<Record<string, unknown>>): RelayControlSubmission {
  const status = string(result, "status", "control result");
  if (status !== "PENDING") {
    throw new Error("控制请求的提交回执不是 PENDING，请重新读取 Run 核对。");
  }
  return {
    controlRequestId: string(result, "control_request_id", "control result"),
    runId: string(result, "run_id", "control result"),
    taskId: string(result, "task_id", "control result"),
    type: controlType(result, "control result"),
    status,
    runRevision: decimal(result, "run_revision", "control result")
  };
}

function controlRequestFrom(value: unknown): RelayControlRequest {
  const record = object(value, "control request");
  return {
    id: string(record, "id", "control request"),
    runId: string(record, "run_id", "control request"),
    taskId: string(record, "task_id", "control request"),
    type: controlType(record, "control request"),
    status: string(record, "status", "control request"),
    revision: decimal(record, "revision", "control request"),
    requestedAt: string(record, "requested_at", "control request"),
    decidedAt: nullableString(record, "decided_at", "control request"),
    resultRef: record.result_ref === null ? null : object(record.result_ref, "control request.result_ref")
  };
}

function runFrom(value: unknown): RelayRun {
  const record = object(value, "run");
  const pending = record.pending_control_request === null
    ? null
    : object(record.pending_control_request, "run.pending_control_request");
  return {
    id: string(record, "id", "run"),
    taskId: string(record, "task_id", "run"),
    status: string(record, "status", "run"),
    revision: decimal(record, "revision", "run"),
    waitReason: nullableString(record, "wait_reason", "run"),
    currentStepId: nullableString(record, "current_step_id", "run"),
    steps: array(record, "steps", "run").map((item) => {
      const step = object(item, "run.steps item");
      return {
        id: string(step, "step_id", "run.steps item"),
        index: integer(step, "step_index", "run.steps item"),
        kind: string(step, "step_kind", "run.steps item"),
        status: string(step, "status", "run.steps item"),
        startedAt: nullableString(step, "started_at", "run.steps item"),
        finishedAt: nullableString(step, "finished_at", "run.steps item")
      };
    }),
    recentAttempts: array(record, "recent_attempts", "run").map((item) => {
      const attempt = object(item, "run.recent_attempts item");
      return {
        id: string(attempt, "attempt_id", "run.recent_attempts item"),
        stepKind: string(attempt, "step_kind", "run.recent_attempts item"),
        number: decimal(attempt, "attempt_number", "run.recent_attempts item"),
        status: string(attempt, "status", "run.recent_attempts item")
      };
    }),
    blockingReviewIds: stringArray(record, "blocking_review_ids", "run"),
    pendingControlRequest: pending === null ? null : {
      id: string(pending, "id", "run.pending_control_request"),
      type: controlType(pending, "run.pending_control_request"),
      status: string(pending, "status", "run.pending_control_request"),
      requestedAt: string(pending, "requested_at", "run.pending_control_request")
    },
    unresolvedOperationIds: stringArray(record, "unresolved_operation_ids", "run")
  };
}

function contextManifestSummaryFrom(value: unknown, runId: string): RelayContextManifestSummary {
  const row = object(value, "context manifest");
  const actualRunId = string(row, "run_id", "context manifest");
  if (actualRunId !== runId) throw new Error("Context Manifest 与当前 Run 不匹配。");
  return {
    id: string(row, "id", "context manifest"), runId: actualRunId,
    stepId: nullableString(row, "step_id", "context manifest"),
    createdAt: string(row, "created_at", "context manifest"),
    builderVersion: string(row, "builder_version", "context manifest"),
    templateVersion: string(row, "template_version", "context manifest"),
    manifestHash: string(row, "manifest_hash", "context manifest")
  };
}

function contextBuildFrom(value: unknown): RelayContextBuild {
  const row = object(value, "context build");
  const status = string(row, "status", "context build");
  if (!["NOT_STARTED", "RUNNING", "SUCCEEDED", "FAILED"].includes(status)) {
    throw new Error("context build.status 响应格式无效。");
  }
  return {
    status: status as RelayContextBuild["status"],
    reasonCode: nullableString(row, "reason_code", "context build"),
    message: nullableString(row, "message", "context build")
  };
}

function contextManifestDetailFrom(value: unknown, runId: string, manifestId: string): RelayContextManifestDetail {
  const row = object(value, "context manifest detail");
  const summary = contextManifestSummaryFrom(row, runId);
  if (summary.id !== manifestId) throw new Error("Context Manifest 详情与所选记录不匹配。");
  const rawBudget = row.budget === null ? null : object(row.budget, "context manifest budget");
  const dependencies = object(row.dependencies, "context manifest dependencies");
  const parseDefinition = (value: unknown, name: string) => {
    if (value === undefined || value === null) return null;
    const definition = object(value, name);
    return { id: string(definition, "id", name), version: string(definition, "version", name),
      digest: string(definition, "digest", name) };
  };
  return {
    ...summary,
    budget: rawBudget === null ? null : {
      limitTokens: integer(rawBudget, "limit_tokens", "context manifest budget"),
      reservedTokens: integer(rawBudget, "reserved_tokens", "context manifest budget"),
      requiredTokens: nullableInteger(rawBudget, "required_tokens", "context manifest budget"),
      selectedTokens: nullableInteger(rawBudget, "selected_tokens", "context manifest budget"),
      estimation: string(rawBudget, "estimation", "context manifest budget")
    },
    dependencies: {
      contractHash: optionalString(dependencies, "contract_hash"),
      workflowVersion: optionalString(dependencies, "workflow_version"),
      executionConfigVersion: optionalString(dependencies, "execution_config_version"),
      profile: parseDefinition(dependencies.profile, "context manifest profile"),
      skill: parseDefinition(dependencies.skill, "context manifest skill")
    },
    sources: array(row, "sources", "context manifest detail").map((item) => {
      const source = object(item, "context source");
      const range = object(source.range, "context source range");
      const role = string(source, "role", "context source");
      const trust = string(source, "trust", "context source");
      const selectionReason = optionalString(source, "selection_reason");
      if (!["MANDATORY", "RELEVANT", "STEP_SPECIFIC"].includes(role) ||
        !["CANONICAL", "UNTRUSTED_DATA"].includes(trust) || range.unit !== "UTF8_BYTE" ||
        (selectionReason !== null && !["TITLE_MATCH", "RECENT_SCOPE_FALLBACK"].includes(selectionReason))) {
        throw new Error("Context 来源类别或范围单位无效。");
      }
      return {
        kind: string(source, "kind", "context source"),
        sourceRef: string(source, "source_ref", "context source"),
        version: string(source, "version", "context source"),
        sha256: string(source, "sha256", "context source"),
        sourceSha256: string(source, "source_sha256", "context source"),
        range: { start: integer(range, "start", "context source range"),
          end: integer(range, "end", "context source range"), unit: "UTF8_BYTE" as const },
        content: string(source, "content", "context source"),
        role: role as RelayContextManifestDetail["sources"][number]["role"],
        trust: trust as RelayContextManifestDetail["sources"][number]["trust"],
        selectionReason: selectionReason as RelayContextManifestDetail["sources"][number]["selectionReason"]
      };
    }),
    exclusions: array(row, "exclusions", "context manifest detail").map((item) => {
      const exclusion = object(item, "context exclusion");
      const reason = string(exclusion, "reason", "context exclusion");
      if (reason !== "BUDGET_TRIMMED" && reason !== "SOURCE_UNAVAILABLE") {
        throw new Error("Context 排除原因无效。");
      }
      return { sourceRef: string(exclusion, "source_ref", "context exclusion"), reason };
    })
  };
}

function projectFrom(value: unknown): RelayProject {
  const record = object(value, "project");
  return {
    id: string(record, "id", "project"),
    title: string(record, "title", "project"),
    projectType: string(record, "project_type", "project"),
    revision: decimal(record, "revision", "project"),
    stateRevision: decimal(record, "state_revision", "project"),
    archivedAt: nullableString(record, "archived_at", "project")
  };
}

function taskFrom(value: unknown): RelayTaskSummary {
  const record = object(value, "task");
  const executor = object(record.executor, "task.executor");
  return {
    id: string(record, "id", "task"),
    projectId: nullableString(record, "project_id", "task"),
    title: string(record, "title", "task"),
    status: taskStatus(record, "status", "task"),
    mode: interactionMode(record, "mode", "task"),
    revision: decimal(record, "revision", "task"),
    executor: executorKind(executor, "kind", "task.executor"),
    executorRunId: nullableString(executor, "run_id", "task.executor"),
    currentCompletionId: nullableString(record, "current_completion_id", "task"),
    waitingReason: nullableString(record, "waiting_reason", "task"),
    blockingTaskIds: stringArray(record, "blocking_task_ids", "task"),
    unresolvedBlockerIds: stringArray(record, "unresolved_blocker_ids", "task"),
    allowedActions: stringArray(record, "allowed_actions", "task")
  };
}

function acceptanceFrom(record: Record<string, unknown>): RelayTaskAcceptance {
  return {
    acceptanceRevision: decimal(record, "acceptance_revision", "task.acceptance"),
    objective: string(record, "objective", "task.acceptance"),
    source: string(record, "source", "task.acceptance"),
    criteria: array(record, "criteria", "task.acceptance").map((item) => {
      const criterion = object(item, "task.acceptance.criteria");
      return {
        criterionId: string(criterion, "criterion_id", "criterion"),
        statement: string(criterion, "statement", "criterion"),
        required: criterion.required === true,
        method: string(criterion, "method", "criterion")
      };
    })
  };
}

function dependencyFrom(value: unknown): RelayTaskDependency {
  const record = object(value, "task dependency");
  return {
    taskId: string(record, "task_id", "task dependency"),
    dependencyKind: string(record, "dependency_kind", "task dependency"),
    status: taskStatus(record, "status", "task dependency"),
    title: string(record, "title", "task dependency")
  };
}

function commandEnvelopeFrom(value: unknown): RelayCommandEnvelope {
  const record = object(value, "command response");
  return {
    commandId: string(record, "command_id", "command response"),
    committedAt: string(record, "committed_at", "command response"),
    result: object(record.result, "command response.result")
  };
}

/**
 * 回执里的 result 与首次响应的 result 是同一份事实，因此共用解析函数：
 * 传输错误后按同一 command_id 查询回执，才能判断命令是否已提交。
 */
export function projectCreationFrom(result: Readonly<Record<string, unknown>>): RelayProjectCreation {
  return {
    projectId: string(result, "project_id", "command result"),
    revision: decimal(result, "revision", "command result"),
    phaseKey: string(result, "phase_key", "command result"),
    stateRevision: decimal(result, "state_revision", "command result")
  };
}

export function taskCreationFrom(result: Readonly<Record<string, unknown>>): RelayTaskCreation {
  return {
    taskId: string(result, "task_id", "command result"),
    projectId: nullableString(result, "project_id", "command result"),
    status: taskStatus(result, "status", "command result"),
    mode: interactionMode(result, "mode", "command result"),
    revision: decimal(result, "revision", "command result"),
    acceptanceRevision: decimal(result, "acceptance_revision", "command result")
  };
}

export function taskMutationFrom(result: Readonly<Record<string, unknown>>): RelayTaskMutation {
  return {
    taskId: string(result, "task_id", "command result"),
    status: taskStatus(result, "status", "command result"),
    revision: decimal(result, "revision", "command result")
  };
}

export function artifactVersionResultFrom(
  result: Readonly<Record<string, unknown>>
): RelayArtifactVersionResult {
  return {
    taskId: string(result, "task_id", "command result"),
    artifactId: string(result, "artifact_id", "command result"),
    artifactRevision: decimal(result, "artifact_revision", "command result"),
    versionId: string(result, "version_id", "command result"),
    versionNumber: decimal(result, "version_number", "command result"),
    mediaType: string(result, "media_type", "command result"),
    sha256: string(result, "sha256", "command result"),
    size: decimal(result, "size", "command result"),
    taskRevision: decimal(result, "task_revision", "command result")
  };
}

export function completionFrom(result: Readonly<Record<string, unknown>>): RelayCompletion {
  return {
    taskId: string(result, "task_id", "command result"),
    status: taskStatus(result, "status", "command result"),
    revision: decimal(result, "revision", "command result"),
    acceptanceRevision: decimal(result, "acceptance_revision", "command result"),
    completionId: string(result, "completion_id", "command result"),
    humanAcceptanceId: string(result, "human_acceptance_id", "command result"),
    artifactVersionIds: stringArray(result, "artifact_version_ids", "command result"),
    stateRevision: optionalString(result, "state_revision")
  };
}

export function reopenFrom(result: Readonly<Record<string, unknown>>): RelayReopen {
  return {
    taskId: string(result, "task_id", "command result"),
    status: taskStatus(result, "status", "command result"),
    revision: decimal(result, "revision", "command result"),
    acceptanceRevision: decimal(result, "acceptance_revision", "command result"),
    previousAcceptanceRevision: decimal(result, "previous_acceptance_revision", "command result"),
    previousCompletionId: nullableString(result, "previous_completion_id", "command result")
  };
}

export function stateMutationFrom(result: Readonly<Record<string, unknown>>): RelayStateMutation {
  return {
    projectId: string(result, "project_id", "command result"),
    action: string(result, "action", "command result"),
    revision: decimal(result, "revision", "command result")
  };
}

function artifactFrom(value: unknown): RelayArtifact {
  const record = object(value, "artifact");
  return {
    id: string(record, "id", "artifact"),
    taskId: string(record, "task_id", "artifact"),
    title: string(record, "title", "artifact"),
    revision: decimal(record, "revision", "artifact"),
    latestVersionId: nullableString(record, "latest_version_id", "artifact"),
    versionCount: integer(record, "version_count", "artifact"),
    versions: array(record, "versions", "artifact").map((item) => {
      const version = object(item, "artifact version");
      return {
        artifactVersionId: string(version, "artifact_version_id", "artifact version"),
        versionNumber: decimal(version, "version_number", "artifact version"),
        mediaType: string(version, "media_type", "artifact version"),
        sha256: string(version, "sha256", "artifact version"),
        size: decimal(version, "size", "artifact version"),
        sourceKind: string(version, "source_kind", "artifact version"),
        createdAt: string(version, "created_at", "artifact version")
      };
    })
  };
}

function projectStateFrom(value: unknown): RelayProjectState {
  const record = object(value, "project state");
  return {
    projectId: string(record, "project_id", "project state"),
    revision: decimal(record, "revision", "project state"),
    phaseKey: string(record, "phase_key", "project state"),
    selectedArtifactVersionRefs: array(record, "selected_artifact_version_refs", "project state").map(
      (item) => {
        const ref = object(item, "project state.selected_artifact_version_refs");
        return {
          artifactVersionId: string(ref, "artifact_version_id", "artifact version ref"),
          artifactId: string(ref, "artifact_id", "artifact version ref"),
          versionNumber: decimal(ref, "version_number", "artifact version ref"),
          sourceRef: string(ref, "source_ref", "artifact version ref")
        };
      }
    ),
    completedHighlightRefs: array(record, "completed_highlight_refs", "project state").map((item) => {
      const ref = object(item, "project state.completed_highlight_refs");
      return {
        completionId: string(ref, "completion_id", "completion ref"),
        taskId: string(ref, "task_id", "completion ref"),
        acceptanceRevision: decimal(ref, "acceptance_revision", "completion ref")
      };
    })
  };
}

function directList<T>(value: unknown, name: string, parse: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(value)) throw new Error(`${name} 响应格式无效。`);
  return value.map(parse);
}

function knowledgeFrom(value: unknown): RelayKnowledge {
  const row = object(value, "knowledge");
  return {
    id: string(row, "id", "knowledge"), projectId: nullableString(row, "project_id", "knowledge"),
    title: string(row, "title", "knowledge"), status: string(row, "status", "knowledge"),
    revision: decimal(row, "revision", "knowledge"), currentVersion: decimal(row, "current_version", "knowledge"),
    createdAt: string(row, "created_at", "knowledge"), updatedAt: string(row, "updated_at", "knowledge")
  };
}

function knowledgeVersionFrom(value: unknown): RelayKnowledgeVersion {
  const row = object(value, "knowledge version");
  const sourceKind = string(row, "source_kind", "knowledge version");
  if (sourceKind !== "NOTE" && sourceKind !== "MANAGED_TEXT" && sourceKind !== "ARTIFACT_VERSION") {
    throw new Error("knowledge version.source_kind 响应格式无效。");
  }
  return {
    id: string(row, "id", "knowledge version"), knowledgeId: string(row, "knowledge_id", "knowledge version"),
    version: decimal(row, "version", "knowledge version"), sourceKind,
    mediaType: string(row, "media_type", "knowledge version"),
    contentSha256: string(row, "content_sha256", "knowledge version"),
    availability: string(row, "availability", "knowledge version"),
    excerpt: nullableString(row, "excerpt", "knowledge version"),
    sourceRefs: object(row.source_refs, "knowledge version.source_refs"),
    createdAt: string(row, "created_at", "knowledge version")
  };
}

function memoryFrom(value: unknown): RelayMemory {
  const row = object(value, "memory");
  return {
    id: string(row, "id", "memory"), projectId: nullableString(row, "project_id", "memory"),
    title: string(row, "title", "memory"), status: string(row, "status", "memory"),
    revision: decimal(row, "revision", "memory"), currentVersion: decimal(row, "current_version", "memory"),
    text: string(row, "text", "memory"), confirmedBy: string(row, "confirmed_by", "memory"),
    confirmedAt: string(row, "confirmed_at", "memory"), expiresAt: nullableString(row, "expires_at", "memory"),
    createdAt: string(row, "created_at", "memory"), updatedAt: string(row, "updated_at", "memory")
  };
}

function memoryRevisionFrom(value: unknown): RelayMemoryRevision {
  const row = object(value, "memory revision");
  return {
    id: string(row, "id", "memory revision"), memoryId: string(row, "memory_id", "memory revision"),
    version: decimal(row, "version", "memory revision"), title: string(row, "title", "memory revision"),
    text: string(row, "text", "memory revision"), confirmedBy: string(row, "confirmed_by", "memory revision"),
    confirmedAt: string(row, "confirmed_at", "memory revision"),
    expiresAt: nullableString(row, "expires_at", "memory revision"),
    createdAt: string(row, "created_at", "memory revision")
  };
}

function decisionFrom(value: unknown): RelayDecision {
  const row = object(value, "decision");
  return {
    id: string(row, "id", "decision"), projectId: nullableString(row, "project_id", "decision"),
    title: string(row, "title", "decision"), status: string(row, "status", "decision"),
    revision: decimal(row, "revision", "decision"), currentVersion: decimal(row, "current_version", "decision"),
    choice: string(row, "choice", "decision"), rationale: string(row, "rationale", "decision"),
    alternatives: stringArray(row, "alternatives", "decision"), costs: stringArray(row, "costs", "decision"),
    supersededById: nullableString(row, "superseded_by_id", "decision"),
    createdAt: string(row, "created_at", "decision"), updatedAt: string(row, "updated_at", "decision")
  };
}

function ruleFields(row: Record<string, unknown>, name: string) {
  const strength = string(row, "strength", name);
  const enforcement = string(row, "enforcement", name);
  if (strength !== "HARD" && strength !== "PREFERENCE") throw new Error(`${name}.strength 响应格式无效。`);
  if (!["PRE_ACTION", "POST_CHECK", "SEMANTIC", "HUMAN"].includes(enforcement)) {
    throw new Error(`${name}.enforcement 响应格式无效。`);
  }
  return {
    ruleKey: string(row, "rule_key", name), statement: string(row, "statement", name), strength: strength as RelayRuleStrength,
    applicability: string(row, "applicability", name), enforcement: enforcement as RelayRuleEnforcement,
    method: nullableString(row, "method", name), targetSpec: object(row.target_spec, `${name}.target_spec`)
  };
}

function ruleFrom(value: unknown): RelayRule {
  const row = object(value, "rule");
  const scope = string(row, "scope", "rule");
  if (scope !== "WORKSPACE" && scope !== "PROJECT" && scope !== "TASK") throw new Error("rule.scope 响应格式无效。");
  return {
    id: string(row, "id", "rule"), scope, scopeId: string(row, "scope_id", "rule"),
    projectId: nullableString(row, "project_id", "rule"), taskId: nullableString(row, "task_id", "rule"),
    status: string(row, "status", "rule"), revision: decimal(row, "revision", "rule"),
    currentVersion: decimal(row, "current_version", "rule"), ...ruleFields(row, "rule"),
    createdAt: string(row, "created_at", "rule"), updatedAt: string(row, "updated_at", "rule")
  };
}

function ruleVersionFrom(value: unknown): RelayRuleVersion {
  const row = object(value, "rule version");
  return {
    ruleId: string(row, "rule_id", "rule version"), version: decimal(row, "version", "rule version"),
    ...ruleFields(row, "rule version"), createdAt: string(row, "created_at", "rule version")
  };
}

function searchItemFrom(value: unknown): RelaySearchItem {
  const row = object(value, "search item");
  const type = string(row, "type", "search item");
  if (!["KNOWLEDGE", "MEMORY", "DECISION", "RULE"].includes(type)) throw new Error("search item.type 响应格式无效。");
  return {
    type: type as RelayInformationKind, id: string(row, "id", "search item"),
    version: decimal(row, "version", "search item"), title: string(row, "title", "search item"),
    snippet: string(row, "snippet", "search item"), matchedFields: stringArray(row, "matched_fields", "search item"),
    sourceRef: string(row, "source_ref", "search item"), status: string(row, "status", "search item"),
    projectId: nullableString(row, "project_id", "search item")
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} 响应格式无效。`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(record: Record<string, unknown>, key: string, name: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${name}.${key} 响应格式无效。`);
  }
  return value;
}

function string(record: Record<string, unknown>, key: string, name: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${name}.${key} 响应格式无效。`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function nullableString(record: Record<string, unknown>, key: string, name: string): string | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${name}.${key} 响应格式无效。`);
  }
  return value;
}

function decimal(record: Record<string, unknown>, key: string, name: string): DecimalRevision {
  const value = string(record, key, name);
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name}.${key} 必须是十进制字符串。`);
  }
  return value;
}

function integer(record: Record<string, unknown>, key: string, name: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${name}.${key} 响应格式无效。`);
  }
  return value;
}

function nullableInteger(record: Record<string, unknown>, key: string, name: string): number | null {
  return record[key] === null ? null : integer(record, key, name);
}

function stringArray(record: Record<string, unknown>, key: string, name: string): readonly string[] {
  return array(record, key, name).map((value) => {
    if (typeof value !== "string") {
      throw new Error(`${name}.${key} 响应格式无效。`);
    }
    return value;
  });
}

function taskStatus(record: Record<string, unknown>, key: string, name: string): TaskStatus {
  const value = string(record, key, name);
  const values: readonly TaskStatus[] = ["INBOX", "READY", "IN_PROGRESS", "WAITING", "BLOCKED", "DONE", "CANCELLED"];
  if (!values.includes(value as TaskStatus)) {
    throw new Error(`${name}.${key} 包含未知任务状态。`);
  }
  return value as TaskStatus;
}

function interactionMode(record: Record<string, unknown>, key: string, name: string): InteractionMode {
  const value = string(record, key, name);
  const values: readonly InteractionMode[] = ["ME", "AI_ASSIST", "DELEGATE_AI"];
  if (!values.includes(value as InteractionMode)) {
    throw new Error(`${name}.${key} 包含未知执行模式。`);
  }
  return value as InteractionMode;
}

function executorKind(record: Record<string, unknown>, key: string, name: string): ExecutorKind {
  const value = string(record, key, name);
  if (value !== "HUMAN" && value !== "AI") {
    throw new Error(`${name}.${key} 包含未知执行者。`);
  }
  return value;
}
