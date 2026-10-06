import * as readinessApi from "./resources/readiness";
import * as projectsApi from "./resources/projects";
import * as tasksApi from "./resources/tasks";
import * as artifactsApi from "./resources/artifacts";
import * as informationApi from "./resources/information";
import * as assistApi from "./resources/assist";
import * as runApi from "./resources/run";
import * as gatewayApi from "./resources/gateway";
import type { DecimalRevision, InteractionMode } from "../types";
import type { RelayBlueprintDraft, RelayBlueprintProposal, RelayGoal, RelayProjectGoal } from "./blueprintDtos";
import type { RelayArtifact, RelayArtifactDirectUses, RelayArtifactImpactCandidate, RelayArtifactImpactCheck, RelayArtifactLineage, RelayArtifactTextLock, RelayArtifactVersionResult, RelayClosePartialFileWriteInput, RelayCombinationCheck, RelayFileWriteChangeSet, RelayFileWriteDispositionPreview, RelayFileWriteFrozenDiff, RelayImpactCandidateGroup, RelayTaskArtifacts } from "./dtos/artifacts";
import type { RelayAssistLivePreview, RelayAssistMessage, RelayAssistProposal, RelayAssistSession, RelayAssistSourceRef, RelayAssistantProfile, RelayConversationExecution, RelayConversationExecutionStage, RelayConversationMode, RelayPackDefinition, RelayRunToolCalls, RelaySkillDefinition, RelaySkillInput, RelayWorkingDirectory } from "./dtos/assist";
import type { RelayFileReadAction, RelayGatewayCapability, RelayGatewayConnection, RelayGatewayConnectionSettings, RelayGatewayDecision, RelayGatewayPolicy, RelayGatewayPolicyVersion, RelayManagedGitReadInput, RelayManagedGitReadResponse, RelayManagedResource, RelayMockGatewayAction, RelayMockGatewayConnection, RelayMockManagedResource, RelayWebFetchAction, RelayWebImportJob, RelayWebImportOperation, RelayWebImportSubmission } from "./dtos/gateway";
import type { RelayDecision, RelayInformationKind, RelayInterventionItem, RelayKnowledge, RelayKnowledgeCurationCandidate, RelayKnowledgeGuideEntryInput, RelayKnowledgeSource, RelayKnowledgeVersion, RelayKnowledgeVersionContent, RelayMemory, RelayMemoryRevision, RelayModelPortStatus, RelayModelVerificationState, RelayModelVerifyResult, RelayProjectKnowledgeGuide, RelayRule, RelayRuleEnforcement, RelayRuleStrength, RelayRuleVersion, RelaySearchPage } from "./dtos/information";
import type { RelayActivityFilter, RelayActivityPage, RelayCommandEnvelope, RelayCommandReceipt, RelayContinuationComparison, RelayContinuationPointSummary, RelayGoalCreation, RelayProject, RelayProjectCreation, RelayProjectGoalLink, RelayProjectPage, RelayProjectState, RelayStateMutation, RelayViewConfiguration, RelayViewKind } from "./dtos/projects";
import type { RelayReadiness } from "./dtos/readiness";
import type { RelayContextManifestDetail, RelayContextManifestList, RelayControlRequest, RelayControlSubmission, RelayControlType, RelayDelegateSubmission, RelayResumeSubmission, RelayReview, RelayReviewDecision, RelayRun, RelayRunDraftPreview, RelayRunGatewayOperation, RelayRunTrace } from "./dtos/run";
import type { RelayCompletion, RelayCompletionEvidence, RelayReopen, RelayTaskAcceptanceRevision, RelayTaskAcceptanceRevisionInput, RelayTaskCheckPlanPreview, RelayTaskCreation, RelayTaskDetail, RelayTaskMutation, RelayTaskPage, RelayTaskSummary, RelayToday, RelayTodayPriority } from "./dtos/tasks";
import { RelayHttp } from "./core/http";
import type { RelayApiConnection } from "./core/http";

export { createCommandId } from "./core/command-id";
export type { RelayFieldError, RelayProblem } from "./core/errors";
export { RelayApiError, RelayRunEventHttpError, RelayTransportError } from "./core/errors";
export type { RelayApiConnection } from "./core/http";
export type { RelayArtifact, RelayArtifactDirectUses, RelayArtifactImpactCandidate, RelayArtifactImpactCheck, RelayArtifactLineage, RelayArtifactTextLock, RelayArtifactVersionResult, RelayArtifactVersionSummary, RelayClosePartialFileWriteInput, RelayCombinationCheck, RelayFileWriteChangeSet, RelayFileWriteDispositionPreview, RelayFileWriteFrozenDiff, RelayFileWriteResidualCandidate, RelayImpactCandidateGroup, RelayImpactCandidateGroupItem, RelayLineageParentKind, RelayLineageRelation, RelayTaskArtifacts } from "./dtos/artifacts";
export type { RelayAssistLivePreview, RelayAssistMessage, RelayAssistProposal, RelayAssistSession, RelayAssistSkillOutput, RelayAssistSourceRef, RelayAssistantProfile, RelayConversationCheck, RelayConversationExecution, RelayConversationExecutionStage, RelayConversationMode, RelayPackDefinition, RelayRunToolCall, RelayRunToolCalls, RelaySkillDefinition, RelaySkillInput, RelayTaskSkillProposal, RelayToolCallStatus, RelayWorkingDirectory, RelayWorkingDirectoryCandidate } from "./dtos/assist";
export type { RelayFileReadAction, RelayGatewayCapability, RelayGatewayConnection, RelayGatewayConnectionSettings, RelayGatewayDecision, RelayGatewayPolicy, RelayGatewayPolicyVersion, RelayGitDiffResult, RelayGitReadAction, RelayGitStatusResult, RelayManagedGitReadInput, RelayManagedGitReadOutcome, RelayManagedGitReadResponse, RelayManagedResource, RelayMockGatewayAction, RelayMockGatewayConnection, RelayMockManagedResource, RelayWebFetchAction, RelayWebImportJob, RelayWebImportOperation, RelayWebImportSubmission } from "./dtos/gateway";
export type { RelayDecision, RelayInformationKind, RelayInterventionItem, RelayKnowledge, RelayKnowledgeCurationCandidate, RelayKnowledgeGuideEntry, RelayKnowledgeGuideEntryInput, RelayKnowledgeSource, RelayKnowledgeVersion, RelayKnowledgeVersionContent, RelayMemory, RelayMemoryRevision, RelayModelPortStatus, RelayModelVerificationState, RelayModelVerifyErrorCategory, RelayModelVerifyResult, RelayProjectKnowledgeGuide, RelayRule, RelayRuleEnforcement, RelayRuleStrength, RelayRuleVersion, RelaySearchItem, RelaySearchPage } from "./dtos/information";
export type { RelayActivityFilter, RelayActivityItem, RelayActivityPage, RelayActivityRefKind, RelayCommandEnvelope, RelayCommandReceipt, RelayContinuationComparison, RelayContinuationPointSummary, RelayContinuationRef, RelayContinuationRefChange, RelayContinuationRefKind, RelayGoalCreation, RelayProject, RelayProjectArchiveResult, RelayProjectCreation, RelayProjectGoalLink, RelayProjectListItem, RelayProjectPage, RelayProjectState, RelayStateArtifactRef, RelayStateMutation, RelayViewConfiguration, RelayViewKind } from "./dtos/projects";
export type { RelayReadiness } from "./dtos/readiness";
export type { RelayCommandOutput, RelayContextBuild, RelayContextManifestDetail, RelayContextManifestList, RelayContextManifestSummary, RelayControlRequest, RelayControlSubmission, RelayControlType, RelayDelegateSubmission, RelayGatewayInvocationResult, RelayResumeSubmission, RelayReview, RelayReviewDecision, RelayReviewKind, RelayRun, RelayRunDraftPreview, RelayRunGatewayOperation, RelayRunTrace } from "./dtos/run";
export type { RelayAcceptanceCriterion, RelayCompletion, RelayCompletionEvidence, RelayReopen, RelayTaskAcceptance, RelayTaskAcceptanceRevision, RelayTaskAcceptanceRevisionInput, RelayTaskCheckPlanPreview, RelayTaskCreation, RelayTaskDependency, RelayTaskDetail, RelayTaskMutation, RelayTaskPage, RelayTaskSummary, RelayToday, RelayTodayItem, RelayTodayPriority } from "./dtos/tasks";
export { artifactVersionResultFrom } from "./parse/artifacts";
export { managedGitReadOutcomeFrom } from "./parse/gateway";
export { continuationPointSummaryFrom, goalCreationFrom, projectArchiveResultFrom, projectCreationFrom, projectGoalLinkFrom, selectionRevisionFrom, stateMutationFrom, viewConfigurationFrom } from "./parse/projects";
export { delegateSubmissionFrom } from "./parse/run";
export { completionFrom, reopenFrom, taskAcceptanceRevisionFrom, taskCreationFrom, taskMutationFrom } from "./parse/tasks";


export class RelayApiClient {
  readonly #http: RelayHttp;

  constructor(connection: RelayApiConnection) {
    this.#http = new RelayHttp(connection);
  }

  get workspaceId(): string {
    return this.#http.workspaceId;
  }

  get baseUrl(): string {
    return this.#http.baseUrl;
  }
  async getHealthReady(): Promise<RelayReadiness> {
    return readinessApi.getHealthReady(this.#http);
  }

  async getProject(projectId: string): Promise<RelayProject> {
    return projectsApi.getProject(this.#http, projectId);
  }

  async getProjectsPage(status: "active" | "archived" | "all", cursor: string | null = null): Promise<RelayProjectPage> {
    return projectsApi.getProjectsPage(this.#http, status, cursor);
  }

  async archiveProject(input: { readonly projectId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision }): Promise<RelayCommandEnvelope> {
    return projectsApi.archiveProject(this.#http, input);
  }

  async getViewConfiguration(projectId: string): Promise<RelayViewConfiguration> {
    return projectsApi.getViewConfiguration(this.#http, projectId);
  }

  async setViewConfiguration(input: { readonly projectId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision; readonly kind: RelayViewKind }): Promise<RelayCommandEnvelope> {
    return projectsApi.setViewConfiguration(this.#http, input);
  }

  async getContinuationPoints(projectId: string): Promise<readonly RelayContinuationPointSummary[]> {
    return projectsApi.getContinuationPoints(this.#http, projectId);
  }

  async captureContinuationPoint(input: { readonly projectId: string; readonly commandId: string; readonly name: string; readonly note: string | null }): Promise<RelayCommandEnvelope> {
    return projectsApi.captureContinuationPoint(this.#http, input);
  }

  async compareContinuationPoint(projectId: string, pointId: string): Promise<RelayContinuationComparison> {
    return projectsApi.compareContinuationPoint(this.#http, projectId, pointId);
  }

  async getProjectGoals(projectId: string): Promise<readonly RelayProjectGoal[]> {
    return projectsApi.getProjectGoals(this.#http, projectId);
  }

  async getGoal(goalId: string): Promise<RelayGoal> {
    return projectsApi.getGoal(this.#http, goalId);
  }

  async getBlueprintProposals(projectId: string): Promise<readonly RelayBlueprintProposal[]> {
    return projectsApi.getBlueprintProposals(this.#http, projectId);
  }

  async getBlueprintProposal(projectId: string, proposalId: string): Promise<RelayBlueprintProposal> {
    return projectsApi.getBlueprintProposal(this.#http, projectId, proposalId);
  }

  async createBlueprintProposal(input: { readonly projectId: string; readonly commandId: string; readonly expectedProjectRevision: DecimalRevision; readonly expectedStateRevision: DecimalRevision; readonly expectedViewRevision: DecimalRevision; readonly draft: RelayBlueprintDraft; readonly supersedesProposalId: string | null }): Promise<RelayCommandEnvelope> {
    return projectsApi.createBlueprintProposal(this.#http, input);
  }

  async applyBlueprintProposal(input: { readonly projectId: string; readonly proposalId: string; readonly commandId: string; readonly candidateSha256: string; readonly expectedProjectRevision: DecimalRevision; readonly expectedStateRevision: DecimalRevision; readonly expectedViewRevision: DecimalRevision }): Promise<RelayCommandEnvelope> {
    return projectsApi.applyBlueprintProposal(this.#http, input);
  }

  async rejectBlueprintProposal(input: { readonly projectId: string; readonly proposalId: string; readonly commandId: string; readonly candidateSha256: string }): Promise<RelayCommandEnvelope> {
    return projectsApi.rejectBlueprintProposal(this.#http, input);
  }

  /** 逻辑上的“项目任务读取”映射为当前契约的 GET /tasks?project_id=。 */
  async getProjectTasks(projectId: string): Promise<readonly RelayTaskSummary[]> {
    return tasksApi.getProjectTasks(this.#http, projectId);
  }

  async getProjectTasksPage(projectId: string, cursor: string | null = null): Promise<RelayTaskPage> {
    return tasksApi.getProjectTasksPage(this.#http, projectId, cursor);
  }

  async getInboxTasksPage(cursor: string | null = null): Promise<RelayTaskPage> {
    return tasksApi.getInboxTasksPage(this.#http, cursor);
  }

  async getWorkspaceTasksPage(cursor: string | null = null): Promise<RelayTaskPage> {
    return tasksApi.getWorkspaceTasksPage(this.#http, cursor);
  }

  async getTask(taskId: string): Promise<RelayTaskDetail> {
    return tasksApi.getTask(this.#http, taskId);
  }

  async getCompletionEvidence(completionId: string): Promise<RelayCompletionEvidence> {
    return tasksApi.getCompletionEvidence(this.#http, completionId);
  }

  async getTaskCheckPlanPreview(taskId: string): Promise<RelayTaskCheckPlanPreview> {
    return tasksApi.getTaskCheckPlanPreview(this.#http, taskId);
  }

  async getToday(date: string, timezone: string): Promise<RelayToday> {
    return tasksApi.getToday(this.#http, date, timezone);
  }

  async getActivities(filter: RelayActivityFilter = {}): Promise<RelayActivityPage> {
    return projectsApi.getActivities(this.#http, filter);
  }

  async setTaskSelection(input: { taskId: string; commandId: string; expectedRevision: DecimalRevision; pin: boolean; laterLocalDate: string | null; timezone: string | null }): Promise<RelayCommandEnvelope> {
    return tasksApi.setTaskSelection(this.#http, input);
  }

  async setFocusSelection(input: { commandId: string; expectedRevision: DecimalRevision; date: string; timezone: string; targetKind: "GOAL" | "PROJECT" | "TASK" | null; targetId: string | null }): Promise<RelayCommandEnvelope> {
    return tasksApi.setFocusSelection(this.#http, input);
  }

  async setTaskPlanningMetadata(input: { taskId: string; commandId: string; expectedRevision: DecimalRevision; priority: RelayTodayPriority | null; dueLocalDate: string | null; timezone: string | null }): Promise<RelayCommandEnvelope> {
    return tasksApi.setTaskPlanningMetadata(this.#http, input);
  }

  async createProject(input: { readonly commandId: string; readonly title: string; readonly projectType: string; }): Promise<RelayProjectCreation> {
    return projectsApi.createProject(this.#http, input);
  }

  /**
  * CreateGoal：Goal 是 Workspace 级事实，只保存标题与说明。
  * 与 Project 的关联是独立命令（LinkProjectGoal），这里刻意不隐式关联任何 Project，
  * 也不由前端代填项目——作用域与关联仍归各自 Owner。
  */
  async createGoal(input: { readonly commandId: string; readonly title: string; readonly description: string; }): Promise<RelayGoalCreation> {
    return projectsApi.createGoal(this.#http, input);
  }

  /**
  * LinkProjectGoal：把 Goal 关联到 Project。与 CreateGoal 是两个命令——
  * 创建 Goal 不隐式关联任何 Project，关联必须由用户明确发起。
  * expectedRevision 是 Project 当前修订：服务端按它做 CAS，修订变化时返回冲突而不是覆盖。
  */
  async linkProjectGoal(input: { readonly projectId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision; readonly goalId: string; }): Promise<RelayProjectGoalLink> {
    return projectsApi.linkProjectGoal(this.#http, input);
  }

  async createTask(input: { readonly commandId: string; readonly projectId: string | null; readonly title: string; readonly objective: string; readonly mode: InteractionMode; /** 每行一条验收标准；criterion_id 与 method 由服务端补齐。 */ readonly criteria: readonly string[]; }): Promise<RelayTaskCreation> {
    return tasksApi.createTask(this.#http, input);
  }

  async reviseTaskAcceptance(input: RelayTaskAcceptanceRevisionInput): Promise<RelayTaskAcceptanceRevision> {
    return tasksApi.reviseTaskAcceptance(this.#http, input);
  }

  async markTaskReady(input: { readonly taskId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision; }): Promise<RelayTaskMutation> {
    return tasksApi.markTaskReady(this.#http, input);
  }

  /**
  * POST /tasks/{id}/dependency-links：新增一条任务依赖。
  * expected_revision 必须是上一步返回的 revision；BLOCKS 表示前置未完成会阻塞本任务。
  */
  async addTaskDependency(input: { readonly taskId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision; readonly dependsOnTaskId: string; readonly dependencyKind: "BLOCKS" | "INFORMS"; }): Promise<RelayTaskMutation> {
    return tasksApi.addTaskDependency(this.#http, input);
  }

  async startHumanTask(input: { readonly taskId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision; }): Promise<RelayTaskMutation> {
    return tasksApi.startHumanTask(this.#http, input);
  }

  async getCommandReceipt(commandId: string): Promise<RelayCommandReceipt> {
    return runApi.getCommandReceipt(this.#http, commandId);
  }

  async getKnowledge(projectId: string | null = null): Promise<readonly RelayKnowledge[]> {
    return informationApi.getKnowledge(this.#http, projectId);
  }

  async getKnowledgeDetail(id: string): Promise<RelayKnowledge> {
    return informationApi.getKnowledgeDetail(this.#http, id);
  }

  async getKnowledgeVersions(id: string): Promise<readonly RelayKnowledgeVersion[]> {
    return informationApi.getKnowledgeVersions(this.#http, id);
  }

  async getKnowledgeVersionContent(id: string, version: DecimalRevision): Promise<RelayKnowledgeVersionContent> {
    return informationApi.getKnowledgeVersionContent(this.#http, id, version);
  }

  async createKnowledge(input: { commandId: string; projectId: string | null; title: string; sourceKind: Exclude<RelayKnowledgeSource, "WEB_PAGE">; text?: string; mediaType?: string; artifactVersionId?: string }): Promise<RelayCommandEnvelope> {
    return informationApi.createKnowledge(this.#http, input);
  }

  async addKnowledgeVersion(input: { id: string; commandId: string; expectedRevision: DecimalRevision; sourceKind: Exclude<RelayKnowledgeSource, "WEB_PAGE">; text?: string; mediaType?: string; artifactVersionId?: string }): Promise<RelayCommandEnvelope> {
    return informationApi.addKnowledgeVersion(this.#http, input);
  }

  async archiveKnowledge(id: string, commandId: string, expectedRevision: DecimalRevision): Promise<RelayCommandEnvelope> {
    return informationApi.archiveKnowledge(this.#http, id, commandId, expectedRevision);
  }

  async getMemories(projectId: string | null = null): Promise<readonly RelayMemory[]> {
    return informationApi.getMemories(this.#http, projectId);
  }

  async getMemory(id: string): Promise<RelayMemory> {
    return informationApi.getMemory(this.#http, id);
  }

  async getMemoryRevisions(id: string): Promise<readonly RelayMemoryRevision[]> {
    return informationApi.getMemoryRevisions(this.#http, id);
  }

  async createMemory(input: { commandId: string; projectId: string | null; title: string; text: string; confirmed: true; expiresAt?: string | null }): Promise<RelayCommandEnvelope> {
    return informationApi.createMemory(this.#http, input);
  }

  async addMemoryRevision(input: { id: string; commandId: string; expectedRevision: DecimalRevision; title: string; text: string; confirmed: true; expiresAt?: string | null }): Promise<RelayCommandEnvelope> {
    return informationApi.addMemoryRevision(this.#http, input);
  }

  async retireMemory(id: string, commandId: string, expectedRevision: DecimalRevision): Promise<RelayCommandEnvelope> {
    return informationApi.retireMemory(this.#http, id, commandId, expectedRevision);
  }

  async getDecisions(projectId: string | null = null): Promise<readonly RelayDecision[]> {
    return informationApi.getDecisions(this.#http, projectId);
  }

  async getDecision(id: string): Promise<RelayDecision> {
    return informationApi.getDecision(this.#http, id);
  }

  async createDecision(input: { commandId: string; projectId: string | null; title: string; choice: string; rationale: string; alternatives: readonly string[]; costs: readonly string[] }): Promise<RelayCommandEnvelope> {
    return informationApi.createDecision(this.#http, input);
  }

  async supersedeDecision(input: { id: string; commandId: string; expectedRevision: DecimalRevision; replacementDecisionId: string }): Promise<RelayCommandEnvelope> {
    return informationApi.supersedeDecision(this.#http, input);
  }

  async getRules(projectId: string | null = null): Promise<readonly RelayRule[]> {
    return informationApi.getRules(this.#http, projectId);
  }

  async getRule(id: string): Promise<RelayRule> {
    return informationApi.getRule(this.#http, id);
  }

  async getRuleVersions(id: string): Promise<readonly RelayRuleVersion[]> {
    return informationApi.getRuleVersions(this.#http, id);
  }

  async createRule(input: { commandId: string; scope: "WORKSPACE" | "PROJECT" | "TASK"; scopeId: string; ruleKey: string; statement: string; strength: RelayRuleStrength; enforcement: RelayRuleEnforcement; method?: string; targetSpec?: Readonly<Record<string, unknown>> }): Promise<RelayCommandEnvelope> {
    return informationApi.createRule(this.#http, input);
  }

  async addRuleVersion(input: { id: string; commandId: string; expectedRevision: DecimalRevision; ruleKey: string; statement: string; strength: RelayRuleStrength; enforcement: RelayRuleEnforcement; method?: string; targetSpec?: Readonly<Record<string, unknown>> }): Promise<RelayCommandEnvelope> {
    return informationApi.addRuleVersion(this.#http, input);
  }

  async retireRule(id: string, commandId: string, expectedRevision: DecimalRevision): Promise<RelayCommandEnvelope> {
    return informationApi.retireRule(this.#http, id, commandId, expectedRevision);
  }

  async searchInformation(input: { q: string; projectId: string | null; types: readonly RelayInformationKind[]; limit?: number; cursor?: string }): Promise<RelaySearchPage> {
    return informationApi.searchInformation(this.#http, input);
  }

  async getAssistSessions(target: { projectId?: string; taskId?: string } = {}): Promise<readonly RelayAssistSession[]> {
    return assistApi.getAssistSessions(this.#http, target);
  }

  async getAssistSession(sessionId: string): Promise<RelayAssistSession> {
    return assistApi.getAssistSession(this.#http, sessionId);
  }

  async getFirstPartySkills(): Promise<readonly RelaySkillDefinition[]> {
    return assistApi.getFirstPartySkills(this.#http);
  }

  async getFirstPartyPacks(): Promise<readonly RelayPackDefinition[]> {
    return assistApi.getFirstPartyPacks(this.#http);
  }

  async createAssistSession(input: { commandId: string; projectId: string | null; taskId: string | null; title: string; conversationMode?: RelayConversationMode; assistantProfileId?: string | null }): Promise<RelayAssistSession> {
    return assistApi.createAssistSession(this.#http, input);
  }

  async getAssistantProfiles(options: { includeArchived?: boolean } = {}): Promise<readonly RelayAssistantProfile[]> {
    return assistApi.getAssistantProfiles(this.#http, options);
  }

  async createAssistantProfile(input: { commandId: string; name: string; roleDescription: string; tone?: string; readScope?: { roots: readonly string[] } }): Promise<RelayAssistantProfile> {
    return assistApi.createAssistantProfile(this.#http, input);
  }

  async archiveAssistantProfile(profileId: string, commandId: string, expectedRevision: DecimalRevision): Promise<RelayAssistantProfile> {
    return assistApi.archiveAssistantProfile(this.#http, profileId, commandId, expectedRevision);
  }

  async getAssistMessages(sessionId: string): Promise<readonly RelayAssistMessage[]> {
    return assistApi.getAssistMessages(this.#http, sessionId);
  }

  async getAssistLivePreview(sessionId: string, messageId: string): Promise<RelayAssistLivePreview> {
    return assistApi.getAssistLivePreview(this.#http, sessionId, messageId);
  }

  async requestAssistMessage(input: { sessionId: string; commandId: string; content: string; sourceRefs: readonly RelayAssistSourceRef[] } & ( { intent: "DISCUSS" | "PROPOSE_CANDIDATE" | "PROPOSE_TASK"; skillRef?: never; skillInput?: never } | { intent?: never; skillRef: { id: string; version: string }; skillInput: RelaySkillInput } | { intent?: never; skillRef?: never; skillInput?: never } )): Promise<{ userMessageId: string; assistantMessageId: string }> {
    return assistApi.requestAssistMessage(this.#http, input);
  }

  async cancelAssistMessage(messageId: string, commandId: string): Promise<string> {
    return assistApi.cancelAssistMessage(this.#http, messageId, commandId);
  }

  async getAssistProposals(sessionId: string): Promise<readonly RelayAssistProposal[]> {
    return assistApi.getAssistProposals(this.#http, sessionId);
  }

  /** 文件夹入口：可能建立最小 Project 与受管资源，因此是写命令；页面读取不得调用它。 */
  async openWorkingDirectory(input: { commandId: string; rootPath: string; projectId?: string | null }): Promise<RelayWorkingDirectory> {
    return assistApi.openWorkingDirectory(this.#http, input);
  }

  /** 明确执行请求：原消息 → 已保存候选。模型调用在服务端事务外，命令本身可安全重放。 */
  async interpretConversationMessage(input: { sessionId: string; sourceMessageId: string; resourceId: string; commandId: string }): Promise<RelayConversationExecution> {
    return assistApi.interpretConversationMessage(this.#http, input);
  }

  /** 候选 → Task/READY/Delegate。按请求行上固定的命令身份重放，不会产生第二个 Task/Run。 */
  async applyConversationExecution(requestId: string): Promise<RelayConversationExecutionStage> {
    return assistApi.applyConversationExecution(this.#http, requestId);
  }

  async getConversationExecutionRequests(sessionId: string): Promise<readonly RelayConversationExecution[]> {
    return assistApi.getConversationExecutionRequests(this.#http, sessionId);
  }

  async acceptAssistProposal(proposalId: string, commandId: string, taskContract?: { expectedTaskRevision: DecimalRevision; expectedAcceptanceRevision: DecimalRevision; payloadHash: string }): Promise<RelayCommandEnvelope> {
    return assistApi.acceptAssistProposal(this.#http, proposalId, commandId, taskContract);
  }

  async getReviews(): Promise<readonly RelayReview[]> {
    return runApi.getReviews(this.#http);
  }

  async getReview(reviewId: string): Promise<RelayReview> {
    return runApi.getReview(this.#http, reviewId);
  }

  async delegateTask(input: { readonly taskId: string; readonly commandId: string; readonly expectedTaskRevision: DecimalRevision; readonly mockGatewayAction?: RelayMockGatewayAction; readonly fileReadAction?: RelayFileReadAction; readonly webFetchAction?: RelayWebFetchAction; readonly contextSources?: readonly RelayAssistSourceRef[]; }): Promise<RelayDelegateSubmission> {
    return runApi.delegateTask(this.#http, input);
  }

  async getGatewayConnections(projectId: string): Promise<readonly RelayGatewayConnection[]> {
    return gatewayApi.getGatewayConnections(this.#http, projectId);
  }

  async getGatewayConnectionSettings(projectId: string): Promise<readonly RelayGatewayConnectionSettings[]> {
    return gatewayApi.getGatewayConnectionSettings(this.#http, projectId);
  }

  async getGatewayConnectionSetting(projectId: string, connectionId: string): Promise<RelayGatewayConnectionSettings> {
    return gatewayApi.getGatewayConnectionSetting(this.#http, projectId, connectionId);
  }

  async createGatewayConnection(input: { projectId: string; commandId: string; capability: RelayGatewayCapability; rootPath?: string; allowedHost?: string; allowedExecutables?: readonly string[] }): Promise<RelayCommandEnvelope> {
    return gatewayApi.createGatewayConnection(this.#http, input);
  }

  async disableGatewayConnection(input: { projectId: string; connectionId: string; commandId: string; expectedVersion: DecimalRevision }): Promise<RelayCommandEnvelope> {
    return gatewayApi.disableGatewayConnection(this.#http, input);
  }

  async getGatewayPolicies(projectId: string): Promise<readonly RelayGatewayPolicy[]> {
    return gatewayApi.getGatewayPolicies(this.#http, projectId);
  }

  async getGatewayPolicyVersions(projectId: string, policyId: string): Promise<readonly RelayGatewayPolicyVersion[]> {
    return gatewayApi.getGatewayPolicyVersions(this.#http, projectId, policyId);
  }

  async createGatewayPolicy(input: { projectId: string; commandId: string; capability: RelayGatewayCapability; resourceId: string | null; decision: RelayGatewayDecision; maxPayloadBytes: number; host?: string; actionType?: string }): Promise<RelayCommandEnvelope> {
    return gatewayApi.createGatewayPolicy(this.#http, input);
  }

  async addGatewayPolicyVersion(input: { projectId: string; policyId: string; commandId: string; expectedRevision: DecimalRevision; capability: RelayGatewayCapability; resourceId: string | null; decision: RelayGatewayDecision; maxPayloadBytes: number; host?: string; actionType?: string }): Promise<RelayCommandEnvelope> {
    return gatewayApi.addGatewayPolicyVersion(this.#http, input);
  }

  async revokeGatewayPolicy(input: { projectId: string; policyId: string; commandId: string; expectedRevision: DecimalRevision }): Promise<RelayCommandEnvelope> {
    return gatewayApi.revokeGatewayPolicy(this.#http, input);
  }

  async getManagedResources(projectId: string): Promise<readonly RelayManagedResource[]> {
    return gatewayApi.getManagedResources(this.#http, projectId);
  }

  async getManagedResource(projectId: string, resourceId: string): Promise<RelayManagedResource> {
    return gatewayApi.getManagedResource(this.#http, projectId, resourceId);
  }

  async readManagedGitState(input: RelayManagedGitReadInput): Promise<RelayManagedGitReadResponse> {
    return gatewayApi.readManagedGitState(this.#http, input);
  }

  async createManagedResource(input: { projectId: string; commandId: string; rootPath: string }): Promise<RelayCommandEnvelope> {
    return gatewayApi.createManagedResource(this.#http, input);
  }

  async disableManagedResource(input: { projectId: string; resourceId: string; commandId: string; expectedRevision: DecimalRevision }): Promise<RelayCommandEnvelope> {
    return gatewayApi.disableManagedResource(this.#http, input);
  }

  async getMockGatewayConnections(projectId: string): Promise<readonly RelayMockGatewayConnection[]> {
    return gatewayApi.getMockGatewayConnections(this.#http, projectId);
  }

  async createWebImportJob(input: { readonly projectId: string; readonly commandId: string; readonly url: string; readonly connectionId: string }): Promise<RelayWebImportSubmission> {
    return gatewayApi.createWebImportJob(this.#http, input);
  }

  async getWebImportJob(importJobId: string): Promise<RelayWebImportJob> {
    return gatewayApi.getWebImportJob(this.#http, importJobId);
  }

  async getWebImportOperations(importJobId: string): Promise<readonly RelayWebImportOperation[]> {
    return gatewayApi.getWebImportOperations(this.#http, importJobId);
  }

  async getMockManagedResources(projectId: string): Promise<readonly RelayMockManagedResource[]> {
    return gatewayApi.getMockManagedResources(this.#http, projectId);
  }

  async getRun(runId: string): Promise<RelayRun> {
    return runApi.getRun(this.#http, runId);
  }

  async getRunDraftPreview(runId: string): Promise<RelayRunDraftPreview> {
    return runApi.getRunDraftPreview(this.#http, runId);
  }

  async getRunTrace(runId: string): Promise<RelayRunTrace> {
    return runApi.getRunTrace(this.#http, runId);
  }

  async getRunToolCalls(runId: string): Promise<RelayRunToolCalls> {
    return runApi.getRunToolCalls(this.#http, runId);
  }

  async getRunGatewayOperations(runId: string): Promise<readonly RelayRunGatewayOperation[]> {
    return runApi.getRunGatewayOperations(this.#http, runId);
  }

  async getFileWriteChangeSets(operationId: string): Promise<readonly RelayFileWriteChangeSet[]> {
    return artifactsApi.getFileWriteChangeSets(this.#http, operationId);
  }

  async getFileWriteFrozenDiff(operationId: string): Promise<RelayFileWriteFrozenDiff> {
    return artifactsApi.getFileWriteFrozenDiff(this.#http, operationId);
  }

  async getFileWriteDispositionPreview(operationId: string): Promise<RelayFileWriteDispositionPreview> {
    return artifactsApi.getFileWriteDispositionPreview(this.#http, operationId);
  }

  async closePartialFileWrite(input: RelayClosePartialFileWriteInput): Promise<void> {
    return artifactsApi.closePartialFileWrite(this.#http, input);
  }

  /** One authenticated SSE connection. The caller owns reconnects and authoritative GET refreshes. */
  async readRunEvents(runId: string, after: string, signal: AbortSignal, onEvent: (seq: string) => void, onOpen: () => void): Promise<void> {
    return runApi.readRunEvents(this.#http, runId, after, signal, onEvent, onOpen);
  }

  async getRunContextManifests(runId: string): Promise<RelayContextManifestList> {
    return runApi.getRunContextManifests(this.#http, runId);
  }

  async getRunContextManifest(runId: string, manifestId: string): Promise<RelayContextManifestDetail> {
    return runApi.getRunContextManifest(this.#http, runId, manifestId);
  }

  async getRunReviews(runId: string): Promise<readonly RelayReview[]> {
    return runApi.getRunReviews(this.#http, runId);
  }

  async getControlRequest(runId: string, requestId: string): Promise<RelayControlRequest> {
    return runApi.getControlRequest(this.#http, runId, requestId);
  }

  async requestRunControl(input: { readonly runId: string; readonly commandId: string; readonly expectedTaskRevision: DecimalRevision; readonly expectedRunRevision: DecimalRevision; readonly type: RelayControlType; }): Promise<RelayControlSubmission> {
    return runApi.requestRunControl(this.#http, input);
  }

  async resumeRun(input: { readonly runId: string; readonly commandId: string; readonly expectedTaskRevision: DecimalRevision; readonly expectedRunRevision: DecimalRevision; }): Promise<RelayResumeSubmission> {
    return runApi.resumeRun(this.#http, input);
  }

  async decideReview(input: { readonly reviewId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision; readonly targetHash: string; readonly decision: RelayReviewDecision; readonly feedback?: string; readonly retryBudget?: number; }): Promise<RelayCommandEnvelope> {
    return runApi.decideReview(this.#http, input);
  }

  async createArtifactWithVersion(input: { readonly taskId: string; readonly commandId: string; readonly expectedTaskRevision: DecimalRevision; readonly title: string; readonly mediaType: string; readonly content: string; }): Promise<RelayArtifactVersionResult> {
    return artifactsApi.createArtifactWithVersion(this.#http, input);
  }

  async submitArtifactVersion(input: { readonly artifactId: string; readonly commandId: string; readonly expectedArtifactRevision: DecimalRevision; readonly expectedTaskRevision: DecimalRevision; readonly mediaType: string; readonly content: string; }): Promise<RelayArtifactVersionResult> {
    return artifactsApi.submitArtifactVersion(this.#http, input);
  }

  async getArtifact(artifactId: string): Promise<RelayArtifact> {
    return artifactsApi.getArtifact(this.#http, artifactId);
  }

  async getTaskArtifacts(taskId: string): Promise<RelayTaskArtifacts> {
    return artifactsApi.getTaskArtifacts(this.#http, taskId);
  }

  /** 正文接口返回 text/markdown 本身而不是 JSON，因此单独走文本读取。 */
  async getArtifactVersionContent(artifactVersionId: string): Promise<string> {
    return artifactsApi.getArtifactVersionContent(this.#http, artifactVersionId);
  }

  async getArtifactLineage(artifactVersionId: string): Promise<RelayArtifactLineage> {
    return artifactsApi.getArtifactLineage(this.#http, artifactVersionId);
  }

  async getArtifactDirectUses(artifactVersionId: string): Promise<RelayArtifactDirectUses> {
    return artifactsApi.getArtifactDirectUses(this.#http, artifactVersionId);
  }

  async getArtifactTextLocks(artifactId: string): Promise<readonly RelayArtifactTextLock[]> {
    return artifactsApi.getArtifactTextLocks(this.#http, artifactId);
  }

  async lockArtifactText(input: { readonly artifactId: string; readonly commandId: string; readonly expectedArtifactRevision: DecimalRevision; readonly expectedVersionId: string; readonly blockKind: "PARAGRAPH" | "SECTION"; readonly blockIndex: number }): Promise<{ readonly artifactRevision: DecimalRevision; readonly lock: RelayArtifactTextLock }> {
    return artifactsApi.lockArtifactText(this.#http, input);
  }

  async unlockArtifactText(input: { readonly artifactId: string; readonly lockId: string; readonly commandId: string; readonly expectedArtifactRevision: DecimalRevision }): Promise<DecimalRevision> {
    return artifactsApi.unlockArtifactText(this.#http, input);
  }

  async startArtifactImpactCheck(input: { readonly beforeVersionId: string; readonly afterVersionId: string; readonly expectedArtifactRevision: DecimalRevision; readonly analysisTargetVersionIds: readonly string[]; readonly commandId: string }): Promise<string> {
    return artifactsApi.startArtifactImpactCheck(this.#http, input);
  }

  async getArtifactImpactCheck(id: string): Promise<RelayArtifactImpactCheck> {
    return artifactsApi.getArtifactImpactCheck(this.#http, id);
  }

  async startArtifactImpactCandidate(input: { readonly checkId: string; readonly targetVersionId: string; readonly expectedTargetRevision: DecimalRevision; readonly confirmedPossible: boolean; readonly commandId: string }): Promise<string> {
    return artifactsApi.startArtifactImpactCandidate(this.#http, input);
  }

  async getArtifactImpactCandidate(id: string): Promise<RelayArtifactImpactCandidate> {
    return artifactsApi.getArtifactImpactCandidate(this.#http, id);
  }

  /** N02：组只关联已登记目标，不调用模型；响应不明按原 command_id 核对。 */
  async createImpactCandidateGroup(input: { readonly checkId: string; readonly targetVersionIds: readonly string[]; readonly commandId: string }): Promise<string> {
    return artifactsApi.createImpactCandidateGroup(this.#http, input);
  }

  async getImpactCandidateGroup(id: string): Promise<RelayImpactCandidateGroup> {
    return artifactsApi.getImpactCandidateGroup(this.#http, id);
  }

  async createCombinationCheck(input: { readonly groupId: string; readonly artifactVersionIds: readonly string[]; readonly commandId: string }): Promise<string> {
    return artifactsApi.createCombinationCheck(this.#http, input);
  }

  async getCombinationCheck(id: string): Promise<RelayCombinationCheck> {
    return artifactsApi.getCombinationCheck(this.#http, id);
  }

  /** N03 导读是 Project 拥有的编排，不属于 Context 自动注入范围。 */
  async getProjectKnowledgeGuide(projectId: string): Promise<RelayProjectKnowledgeGuide> {
    return informationApi.getProjectKnowledgeGuide(this.#http, projectId);
  }

  /** 整份替换式保存：编辑导读就是替换清单，条目可删但被引用对象不可变。 */
  async saveProjectKnowledgeGuide(input: { readonly projectId: string; readonly expectedRevision: DecimalRevision; readonly entries: readonly RelayKnowledgeGuideEntryInput[]; readonly commandId: string }): Promise<{ readonly revision: DecimalRevision; readonly entryCount: number }> {
    return informationApi.saveProjectKnowledgeGuide(this.#http, input);
  }

  /** 只由用户主动请求产生；不接受任何自动或后台触发。回执只有候选 ID，正文由列表读取提供。 */
  async createKnowledgeCurationCandidates(input: { readonly projectId: string; readonly sources: readonly { readonly artifactVersionId: string; readonly suggestedTitle?: string }[]; readonly commandId: string }): Promise<readonly string[]> {
    return informationApi.createKnowledgeCurationCandidates(this.#http, input);
  }

  async listKnowledgeCurationCandidates(projectId: string): Promise<readonly RelayKnowledgeCurationCandidate[]> {
    return informationApi.listKnowledgeCurationCandidates(this.#http, projectId);
  }

  /** 接受不是独立命令，但满足契约幂等语义：同 command_id 重放或并发都返回原回执。 */
  async acceptKnowledgeCurationCandidate(input: { readonly projectId: string; readonly candidateId: string; readonly commandId: string }): Promise<{ readonly candidateId: string; readonly knowledgeId: string; readonly knowledgeVersionId: string; readonly knowledgeRevision: DecimalRevision; readonly mode: "CREATED" | "NEW_VERSION" }> {
    return informationApi.acceptKnowledgeCurationCandidate(this.#http, input);
  }

  async rejectKnowledgeCurationCandidate(input: { readonly projectId: string; readonly candidateId: string; readonly commandId: string }): Promise<{ readonly candidateId: string; readonly status: "REJECTED" }> {
    return informationApi.rejectKnowledgeCurationCandidate(this.#http, input);
  }

  async getInterventions(): Promise<readonly RelayInterventionItem[]> {
    return informationApi.getInterventions(this.#http);
  }

  /** 模型端口只读状态：服务端保证不含密钥。 */
  async getModelPortStatus(): Promise<RelayModelPortStatus> {
    return informationApi.getModelPortStatus(this.#http);
  }

  /** 最近一次模型验证与当前配置指纹匹配情况。 */
  async getModelPortVerification(): Promise<RelayModelVerificationState> {
    return informationApi.getModelPortVerification(this.#http);
  }

  /** 触发一次连接/模型验证；结果由服务端写入 model_calls，不含密钥。 */
  async verifyModelPort(): Promise<RelayModelVerifyResult> {
    return informationApi.verifyModelPort(this.#http);
  }

  async claimInterventionNotifications(): Promise<readonly RelayInterventionItem[]> {
    return informationApi.claimInterventionNotifications(this.#http);
  }

  async settleInterventionNotification(item: RelayInterventionItem, status: "DISPATCHED" | "DENIED" | "FAILED"): Promise<void> {
    return informationApi.settleInterventionNotification(this.#http, item, status);
  }

  async applyArtifactImpactCandidate(input: { readonly candidateId: string; readonly expectedTargetRevision: DecimalRevision; readonly commandId: string }): Promise<string> {
    return artifactsApi.applyArtifactImpactCandidate(this.#http, input);
  }

  async completeHumanTask(input: { readonly taskId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision; readonly acceptanceRevision: DecimalRevision; readonly artifactVersionIds: readonly string[]; readonly statement: string; readonly acceptedCriterionIds: readonly string[]; readonly reason: string | null; }): Promise<RelayCompletion> {
    return tasksApi.completeHumanTask(this.#http, input);
  }

  async reopenTask(input: { readonly taskId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision; readonly reason: string; }): Promise<RelayReopen> {
    return tasksApi.reopenTask(this.#http, input);
  }

  async getProjectState(projectId: string): Promise<RelayProjectState> {
    return projectsApi.getProjectState(this.#http, projectId);
  }

  /**
  * “选择要接受的版本”是 Project State 的类型化命令，不是 Task 字段。
  * 该 action 要求 source_ref（选择依据的来源引用），不能省略：服务端按 REQUIRED_INPUT_MISSING 拒绝。
  */
  async selectArtifactVersion(input: { readonly projectId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision; readonly artifactVersionId: string; readonly sourceRef: string; }): Promise<RelayStateMutation> {
    return artifactsApi.selectArtifactVersion(this.#http, input);
  }

}
