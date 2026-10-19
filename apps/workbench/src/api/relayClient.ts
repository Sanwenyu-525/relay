import * as readinessApi from "./resources/readiness";
import * as projectsApi from "./resources/projects";
import * as tasksApi from "./resources/tasks";
import * as artifactsApi from "./resources/artifacts";
import * as impactGroupSelectionsApi from "./resources/impactGroupSelections";
import * as informationApi from "./resources/information";
import * as assistApi from "./resources/assist";
import * as conversationDiffApi from "./resources/conversationDiff";
import * as chatControlsApi from "./resources/chatControls";
import * as modelSelectionApi from "./resources/modelSelection";
import * as modelRuntimeApi from "./resources/modelRuntime";
export type { RelayAssistModelRuntime } from "./resources/modelRuntime";
export type { RelayModelCatalog, RelayCatalogModel, RelaySessionModelSelection } from "./resources/modelSelection";
import * as composerDraftAssistApi from "./resources/composerDraftAssist";
import type { ComposerDraftOperation, RelayComposerDraftAssist } from "./resources/composerDraftAssist";
import * as learningApi from "./resources/learning";
import * as acceptanceMaterialsApi from "./resources/taskAcceptanceMaterials";
import * as acceptanceTrialsApi from "./resources/taskAcceptanceTrials";
import * as acceptanceComparisonsApi from "./resources/taskAcceptanceComparisons";
import * as hypothesesApi from "./resources/hypotheses";
import * as decisionReviewsApi from "./resources/decisionReviews";
import * as workSegmentsApi from "./resources/workSegments";
import * as personalPlanningApi from "./resources/personalPlanning";
import * as scopeSimulationsApi from "./resources/scopeSimulations";
import * as projectRemindersApi from "./resources/projectReminders";
import * as taskChainsApi from "./resources/taskChains";
import * as scheduledTasksApi from "./resources/scheduledTasks";
import type { RelayScheduledTaskCreate, RelayScheduledTaskEdit, RelayScheduledTaskOccurrenceResolution, RelayScheduledTaskStatusInput } from "./dtos/scheduledTasks";
import type { RelayTaskChainCreate,RelayTaskChainAuthorization,RelayTaskChainControl } from "./dtos/taskChains";
export type { RelayTaskChain,RelayTaskChainCreate,RelayTaskChainAuthorization,RelayTaskChainControl,RelayTaskChainResult,RelayTaskChainExecution } from "./dtos/taskChains";
export type { RelayScheduledTask, RelayScheduledTaskCreate, RelayScheduledTaskDetail, RelayScheduledTaskEdit, RelayScheduledTaskOccurrence, RelayScheduledTaskOccurrenceResolution, RelayScheduledTaskOccurrenceStatus, RelayScheduledTaskRepeat, RelayScheduledTaskResult, RelayScheduledTaskStatus, RelayScheduledTaskStatusInput, RelayScheduledTaskTemplate } from "./dtos/scheduledTasks";
import type { RelayReminderCreate, RelayReminderEdit, RelayReminderStatusInput, RelayReminderResolution, RelayReminderNotification } from "./dtos/projectReminders";
export type { RelayReminderCreate, RelayReminderEdit, RelayReminderStatusInput, RelayReminderResolution, RelayReminderNotification, RelayReminderOccurrence, RelayProjectReminder, RelayReminderResult, RelayReminderStatus } from "./dtos/projectReminders";
import type { RelayScopeSimulationInput, RelayScopeSelection } from "./dtos/scopeSimulations";
export type { RelayScopeSimulationInput, RelayScopeSelection, RelayScopeSimulation, RelayScopeSimulationResult, RelayScopeOption, RelayScopeOptionKind } from "./dtos/scopeSimulations";
import type { RelayTimeEstimateInput, RelayPeriodPlanInput, RelayPeriodPlanResolution } from "./dtos/personalPlanning";
export type { RelayTimeEstimateInput, RelayTimeEstimate, RelayPeriodPlanInput, RelayPeriodPlanResolution, RelayPeriodPlan, RelayPeriodPlanItem, RelayPeriodPlanResult } from "./dtos/personalPlanning";
import type { RelayWorkSegmentStart, RelayWorkSegmentMutation, RelayWorkSegmentEventInput, RelayWorkSegmentEventResolution } from "./dtos/workSegments";
export type { RelayWorkSegment, RelayWorkSegmentEvent, RelayWorkSegmentStart, RelayWorkSegmentMutation,
  RelayWorkSegmentEventInput, RelayWorkSegmentEventResolution, RelayWorkSegmentResult, RelayWorkSegmentTaskInput } from "./dtos/workSegments";
import type { RelayDecisionPremiseInput, RelayDecisionReviewResolution } from "./dtos/decisionReviews";
export type { RelayDecisionPremise, RelayDecisionPremiseInput, RelayDecisionReview, RelayDecisionReviewResolution } from "./dtos/decisionReviews";
import type { RelayHypothesisCreate, RelayHypothesisDefinition, RelayHypothesisMutation, RelayHypothesisSuggestion } from "./dtos/hypotheses";
export type { RelayHypothesis, RelayHypothesisConclusion, RelayHypothesisCreate, RelayHypothesisDefinition,
  RelayHypothesisMutation, RelayHypothesisObservation, RelayHypothesisResult, RelayHypothesisSuggestion, RelayHypothesisVersion } from "./dtos/hypotheses";
import type { RelayAcceptanceComparisonInput } from "./dtos/taskAcceptanceComparisons";
export type { RelayAcceptanceComparisonInput, RelayAcceptanceComparison, RelayAcceptanceComparisonSample,
  RelayAcceptanceComparisons, RelayComparisonObservation } from "./dtos/taskAcceptanceComparisons";
import type { RelayAcceptanceObservationInput, RelayAcceptanceTrialStart, RelayAcceptanceTrialTransition } from "./dtos/taskAcceptanceTrials";
export type { RelayAcceptanceObservationInput, RelayAcceptanceObservation, RelayAcceptanceTrialStart,
  RelayAcceptanceTrialTransition, RelayAcceptanceTrial, RelayAcceptanceTrialResult, RelayAcceptanceTrials } from "./dtos/taskAcceptanceTrials";
import type { RelayAcceptanceMaterialInput, RelayAcceptanceMaterialImport } from "./dtos/taskAcceptanceMaterials";
export type { RelayAcceptanceMaterial, RelayAcceptanceMaterialResult, RelayAcceptanceMaterials,
  RelayAcceptanceMaterialInput, RelayAcceptanceMaterialImport } from "./dtos/taskAcceptanceMaterials";
import type { RelayLearningCommand } from "./resources/learning";
import * as stateMaintenanceApi from "./resources/stateMaintenance";
import * as projectDailyContinuationApi from "./resources/projectDailyContinuation";
import * as runApi from "./resources/run";
import * as previewStreamApi from "./resources/previewStream";
import * as gatewayApi from "./resources/gateway";
import type { RelayWriteReadiness, RelayWriteTier } from "./dtos/gateway";
import type { DecimalRevision, InteractionMode } from "../types";
import type { RelayBlueprintDraft, RelayBlueprintProposal, RelayGoal, RelayProjectGoal } from "./blueprintDtos";
import type { RelayArtifact, RelayArtifactDirectUses, RelayArtifactImpactCandidate, RelayArtifactImpactCheck, RelayArtifactLineage, RelayArtifactTextLock, RelayArtifactVersionResult, RelayClosePartialFileWriteInput, RelayCombinationCheck, RelayFileWriteChangeSet, RelayFileWriteDispositionPreview, RelayFileWriteFrozenDiff, RelayImpactCandidateGroup, RelayTaskArtifacts } from "./dtos/artifacts";
import type { RelayAssistLivePreview, RelayAssistMessage, RelayAssistProposal, RelayAssistSession, RelayAssistSourceRef, RelayAssistantProfile, RelayConversationDiff, RelayConversationDiffFile, RelayConversationExecution, RelayConversationExecutionStage, RelayConversationMode, RelayPackDefinition, RelayRunToolCallPreviews, RelayRunToolCalls, RelaySkillDefinition, RelaySkillInput, RelayWorkingDirectory } from "./dtos/assist";
import type { RelayStateMaintenanceApplyResult, RelayStateMaintenanceRequest,
  RelayUndoPlan } from "./dtos/stateMaintenance";
import type { RelayDailyContinuation, RelayDailyViewConfirmationInput, RelayReturnReview } from "./dtos/projectDailyContinuation";
import type { RelayFileReadAction, RelayGatewayCapability, RelayGatewayConnection, RelayGatewayConnectionSettings, RelayGatewayDecision, RelayGatewayPolicy, RelayGatewayPolicyVersion, RelayManagedGitReadInput, RelayManagedGitReadResponse, RelayManagedResource, RelayMockGatewayAction, RelayMockGatewayConnection, RelayMockManagedResource, RelayWebFetchAction, RelayWebImportJob, RelayWebImportOperation, RelayWebImportSubmission } from "./dtos/gateway";
import type { RelayDecision, RelayInformationKind, RelayInterventionItem, RelayKnowledge, RelayKnowledgeCurationCandidate, RelayKnowledgeGuideEntryInput, RelayKnowledgeSource, RelayKnowledgeVersion, RelayKnowledgeVersionContent, RelayMemory, RelayMemoryRevision, RelayModelPortStatus, RelayModelVerificationState, RelayModelVerifyResult, RelayProjectKnowledgeGuide, RelayRule, RelayRuleEnforcement, RelayRuleStrength, RelayRuleVersion, RelaySearchPage } from "./dtos/information";
import type { RelayActivityFilter, RelayActivityPage, RelayCommandEnvelope, RelayCommandReceipt, RelayContinuationComparison, RelayContinuationPointSummary, RelayGoalCreation, RelayProject, RelayProjectCreation, RelayProjectGoalLink, RelayProjectPage, RelayProjectState, RelayStateMutation, RelayViewConfiguration, RelayViewKind } from "./dtos/projects";
import type { RelayReadiness } from "./dtos/readiness";
import type { RelayContextManifestDetail, RelayContextManifestList, RelayControlRequest, RelayControlSubmission, RelayControlType, RelayDelegateSubmission, RelayResumeSubmission, RelayReview, RelayReviewDecision, RelayRun, RelayRunDraftPreview, RelayRunGatewayOperation, RelayRunTrace } from "./dtos/run";
import type { RelayCompletion, RelayCompletionEvidence, RelayReopen, RelayTaskAcceptanceRevision, RelayTaskAcceptanceRevisionInput, RelayTaskCheckPlanPreview, RelayTaskCreation, RelayTaskDetail, RelayTaskMutation, RelayTaskPage, RelayTaskSummary, RelayToday, RelayTodayPriority } from "./dtos/tasks";
import { RelayHttp } from "./core/http";
import type { RelayApiConnection } from "./core/http";

export { createCommandId } from "./core/command-id";
export type { ComposerDraftOperation, RelayComposerDraftAssist } from "./resources/composerDraftAssist";
export type { RelayFieldError, RelayProblem } from "./core/errors";
export { RelayApiError, RelayRunEventHttpError, RelayTransportError } from "./core/errors";
export type { RelayApiConnection } from "./core/http";
export type { RelayArtifact, RelayArtifactDirectUses, RelayArtifactImpactCandidate, RelayArtifactImpactCheck, RelayArtifactLineage, RelayArtifactTextLock, RelayArtifactVersionResult, RelayArtifactVersionSummary, RelayClosePartialFileWriteInput, RelayCombinationCheck, RelayFileWriteChangeSet, RelayFileWriteDispositionPreview, RelayFileWriteFrozenDiff, RelayFileWriteResidualCandidate, RelayImpactCandidateGroup, RelayImpactCandidateGroupItem, RelayLineageParentKind, RelayLineageRelation, RelayTaskArtifacts } from "./dtos/artifacts";
export type { RelayAssistLivePreview, RelayAssistMessage, RelayAssistMessageAttachment, RelayAssistProposal, RelayAssistSession, RelayAssistSkillOutput, RelayAssistSourceRef, RelayAssistantProfile, RelayConversationCheck, RelayConversationDiff, RelayConversationDiffCoverage, RelayConversationDiffFile, RelayConversationDiffFileRow, RelayConversationDiffScanSide, RelayConversationExecution, RelayConversationExecutionStage, RelayConversationFileDiff, RelayConversationMode, RelayPackDefinition, RelayRunToolCall, RelayRunToolCallFileChange, RelayRunToolCallPreview, RelayRunToolCallPreviewFile, RelayRunToolCallPreviews, RelayRunToolCalls, RelaySkillDefinition, RelaySkillInput, RelayTaskSkillProposal, RelayToolCallStatus, RelayWorkingDirectory, RelayWorkingDirectoryCandidate } from "./dtos/assist";
export type { RelayStateMaintenanceApplyResult, RelayStateMaintenanceChange, RelayStateMaintenanceDecisionRequired, RelayStateMaintenanceRequest, RelayUndoPlan, RelayUndoPlanItem } from "./dtos/stateMaintenance";
export type { RelayDailyContinuation, RelayDailyContinuationBaseline, RelayDailyContinuationCurrent, RelayDailyContinuationDelta, RelayDailyViewConfirmationInput, RelayReturnReview } from "./dtos/projectDailyContinuation";
export type { RelayFileReadAction, RelayGatewayCapability, RelayGatewayConnection, RelayGatewayConnectionSettings, RelayGatewayDecision, RelayGatewayPolicy, RelayGatewayPolicyVersion, RelayGitDiffResult, RelayGitReadAction, RelayGitStatusResult, RelayManagedGitReadInput, RelayManagedGitReadOutcome, RelayManagedGitReadResponse, RelayManagedResource, RelayMockGatewayAction, RelayMockGatewayConnection, RelayMockManagedResource, RelayWebFetchAction, RelayWebImportJob, RelayWebImportOperation, RelayWebImportSubmission } from "./dtos/gateway";
export type { RelayDecision, RelayInformationKind, RelayInterventionItem, RelayKnowledge, RelayKnowledgeCurationCandidate, RelayKnowledgeGuideEntry, RelayKnowledgeGuideEntryInput, RelayKnowledgeSource, RelayKnowledgeVersion, RelayKnowledgeVersionContent, RelayMemory, RelayMemoryRevision, RelayModelPortStatus, RelayModelVerificationState, RelayModelVerifyErrorCategory, RelayModelVerifyResult, RelayProjectKnowledgeGuide, RelayRule, RelayRuleEnforcement, RelayRuleStrength, RelayRuleVersion, RelaySearchItem, RelaySearchPage } from "./dtos/information";
export type { RelayActivityFilter, RelayActivityItem, RelayActivityPage, RelayActivityRefKind, RelayCommandEnvelope, RelayCommandReceipt, RelayContinuationComparison, RelayContinuationPointSummary, RelayContinuationRef, RelayContinuationRefChange, RelayContinuationRefKind, RelayGoalCreation, RelayProject, RelayProjectArchiveResult, RelayProjectCreation, RelayProjectGoalLink, RelayProjectListItem, RelayProjectPage, RelayProjectState, RelayStateArtifactRef, RelayStateMutation, RelayViewConfiguration, RelayViewKind } from "./dtos/projects";
export type { RelayReadiness } from "./dtos/readiness";
export type { RelayCommandOutput, RelayContextBuild, RelayContextManifestDetail, RelayContextManifestList, RelayContextManifestSummary, RelayControlRequest, RelayControlSubmission, RelayControlType, RelayDelegateSubmission, RelayGatewayInvocationResult, RelayResumeSubmission, RelayReview, RelayReviewDecision, RelayReviewKind, RelayRun, RelayRunDraftPreview, RelayRunGatewayOperation, RelayRunTrace } from "./dtos/run";
export type { RelayAcceptanceCriterion, RelayCompletion, RelayCompletionEvidence, RelayReopen, RelayTaskAcceptance, RelayTaskAcceptanceRevision, RelayTaskAcceptanceRevisionInput, RelayTaskCheckPlanPreview, RelayTaskCreation, RelayTaskDependency, RelayTaskDetail, RelayTaskMutation, RelayTaskPage, RelayTaskSummary, RelayToday, RelayTodayItem, RelayTodayPriority } from "./dtos/tasks";
export { artifactVersionResultFrom } from "./parse/artifacts";
export { managedGitReadOutcomeFrom } from "./parse/gateway";
export type { RelayWriteReadiness, RelayWriteTier } from "./dtos/gateway";
export { continuationPointSummaryFrom, goalCreationFrom, projectArchiveResultFrom, projectCreationFrom, projectGoalLinkFrom, selectionRevisionFrom, stateMutationFrom, viewConfigurationFrom } from "./parse/projects";
export { delegateSubmissionFrom } from "./parse/run";
export { completionFrom, reopenFrom, taskAcceptanceRevisionFrom, taskCreationFrom, taskMutationFrom } from "./parse/tasks";


export class RelayApiClient {
  getAssistModelRuntime(messageId: string) { return modelRuntimeApi.getAssistModelRuntime(this.#http, messageId); }
  getModelCatalog() { return modelSelectionApi.getModelCatalog(this.#http); }
  refreshModelCatalog() { return modelSelectionApi.refreshModelCatalog(this.#http); }
  getSessionModelSelection(sessionId: string) { return modelSelectionApi.getSessionModelSelection(this.#http, sessionId); }
  selectSessionModel(input: { sessionId: string; commandId: string; model: string }) {
    return modelSelectionApi.selectSessionModel(this.#http, input);
  }
  createTaskChain(input:RelayTaskChainCreate){return taskChainsApi.createTaskChain(this.#http,input);}
  authorizeTaskChain(input:RelayTaskChainAuthorization){return taskChainsApi.authorizeTaskChain(this.#http,input);}
  stopTaskChain(input:RelayTaskChainControl){return taskChainsApi.stopTaskChain(this.#http,input);}
  getTaskChain(id:string){return taskChainsApi.getTaskChain(this.#http,id);}
  getProjectTaskChains(projectId:string){return taskChainsApi.getProjectTaskChains(this.#http,projectId);}
  createScheduledTask(input: RelayScheduledTaskCreate) { return scheduledTasksApi.createScheduledTask(this.#http, input); }
  editScheduledTask(input: RelayScheduledTaskEdit) { return scheduledTasksApi.editScheduledTask(this.#http, input); }
  setScheduledTaskStatus(input: RelayScheduledTaskStatusInput) { return scheduledTasksApi.setScheduledTaskStatus(this.#http, input); }
  resolveScheduledTaskOccurrence(input: RelayScheduledTaskOccurrenceResolution) { return scheduledTasksApi.resolveScheduledTaskOccurrence(this.#http, input); }
  getScheduledTasks(projectId?: string) { return scheduledTasksApi.getScheduledTasks(this.#http, projectId); }
  getScheduledTask(id: string) { return scheduledTasksApi.getScheduledTask(this.#http, id); }
  createProjectReminder(input: RelayReminderCreate) { return projectRemindersApi.createProjectReminder(this.#http, input); }
  editProjectReminder(input: RelayReminderEdit) { return projectRemindersApi.editProjectReminder(this.#http, input); }
  setProjectReminderStatus(input: RelayReminderStatusInput) { return projectRemindersApi.setProjectReminderStatus(this.#http, input); }
  getProjectReminder(id: string) { return projectRemindersApi.getProjectReminder(this.#http, id); }
  getProjectReminders(projectId: string) { return projectRemindersApi.getProjectReminders(this.#http, projectId); }
  getReminderOccurrences(projectId?: string) { return projectRemindersApi.getReminderOccurrences(this.#http, projectId); }
  getReminderOccurrence(id: string) { return projectRemindersApi.getReminderOccurrence(this.#http, id); }
  resolveReminderOccurrence(input: RelayReminderResolution) { return projectRemindersApi.resolveReminderOccurrence(this.#http, input); }
  claimReminderNotifications() { return projectRemindersApi.claimReminderNotifications(this.#http); }
  settleReminderNotification(item: RelayReminderNotification, status: 'DISPATCHED' | 'DENIED' | 'FAILED') { return projectRemindersApi.settleReminderNotification(this.#http, item, status); }
  proposeScopeSimulation(input: RelayScopeSimulationInput) { return scopeSimulationsApi.proposeScopeSimulation(this.#http, input); }
  selectScopeSimulation(input: RelayScopeSelection) { return scopeSimulationsApi.selectScopeSimulation(this.#http, input); }
  getScopeSimulation(id: string) { return scopeSimulationsApi.getScopeSimulation(this.#http, id); }
  getPlanScopeSimulations(planId: string) { return scopeSimulationsApi.getPlanScopeSimulations(this.#http, planId); }
  recordTaskTimeEstimate(input: RelayTimeEstimateInput) { return personalPlanningApi.recordTaskTimeEstimate(this.#http, input); }
  getTaskTimeEstimates(id: string) { return personalPlanningApi.getTaskTimeEstimates(this.#http, id); }
  proposePeriodPlan(input: RelayPeriodPlanInput) { return personalPlanningApi.proposePeriodPlan(this.#http, input); }
  resolvePeriodPlanItem(input: RelayPeriodPlanResolution) { return personalPlanningApi.resolvePeriodPlanItem(this.#http, input); }
  getPeriodPlan(id: string) { return personalPlanningApi.getPeriodPlan(this.#http, id); }
  getProjectPeriodPlans(projectId: string) { return personalPlanningApi.getProjectPeriodPlans(this.#http, projectId); }
  startWorkSegment(input: RelayWorkSegmentStart) { return workSegmentsApi.startWorkSegment(this.#http, input); }
  finishWorkSegment(input: RelayWorkSegmentMutation) { return workSegmentsApi.finishWorkSegment(this.#http, input); }
  proposeWorkSegmentEvent(input: RelayWorkSegmentEventInput) { return workSegmentsApi.proposeWorkSegmentEvent(this.#http, input); }
  resolveWorkSegmentEvent(input: RelayWorkSegmentEventResolution) { return workSegmentsApi.resolveWorkSegmentEvent(this.#http, input); }
  getWorkSegment(id: string) { return workSegmentsApi.getWorkSegment(this.#http, id); }
  getProjectWorkSegments(projectId: string) { return workSegmentsApi.getProjectWorkSegments(this.#http, projectId); }
  getTemporaryRetrospective(projectId: string, taskIds: readonly string[]) { return workSegmentsApi.getTemporaryRetrospective(this.#http, projectId, taskIds); }
  startWorkSegmentFromConversation(input: { sessionId: string; sourceMessageId: string; commandId: string; timezone?: string }) {
    return stateMaintenanceApi.startWorkSegmentFromConversation(this.#http, input);
  }
  registerDecisionPremise(input: RelayDecisionPremiseInput) { return decisionReviewsApi.registerDecisionPremise(this.#http, input); }
  getDecisionPremises(id: string) { return decisionReviewsApi.getDecisionPremises(this.#http, id); }
  getProjectDecisionReviews(projectId: string) { return decisionReviewsApi.getProjectDecisionReviews(this.#http, projectId); }
  resolveDecisionReview(input: RelayDecisionReviewResolution) { return decisionReviewsApi.resolveDecisionReview(this.#http, input); }
  createHypothesis(input: RelayHypothesisCreate) { return hypothesesApi.createHypothesis(this.#http, input); }
  versionHypothesis(input: RelayHypothesisMutation & RelayHypothesisDefinition) { return hypothesesApi.versionHypothesis(this.#http, input); }
  observeHypothesis(input: RelayHypothesisMutation & { summary: string; knowledgeVersionId?: string }) { return hypothesesApi.observeHypothesis(this.#http, input); }
  suggestHypothesisConclusion(input: RelayHypothesisSuggestion) { return hypothesesApi.suggestHypothesisConclusion(this.#http, input); }
  confirmHypothesisConclusion(input: RelayHypothesisMutation & { suggestionId: string; confirmed: true }) { return hypothesesApi.confirmHypothesisConclusion(this.#http, input); }
  getHypothesis(id: string) { return hypothesesApi.getHypothesis(this.#http, id); }
  getProjectHypotheses(projectId: string) { return hypothesesApi.getProjectHypotheses(this.#http, projectId); }
  createHypothesisFromConversation(input: { sessionId: string; sourceMessageId: string; commandId: string; timezone?: string }) {
    return stateMaintenanceApi.createHypothesisFromConversation(this.#http, input);
  }
  reportAcceptanceTimeFromConversation(input: { sessionId: string; sourceMessageId: string; commandId: string; timezone?: string }) {
    return stateMaintenanceApi.reportAcceptanceTimeFromConversation(this.#http, input);
  }
  freezeAcceptanceComparison(input: RelayAcceptanceComparisonInput) { return acceptanceComparisonsApi.freezeAcceptanceComparison(this.#http, input); }
  getAcceptanceComparisons(projectId: string) { return acceptanceComparisonsApi.getAcceptanceComparisons(this.#http, projectId); }
  getTaskAcceptanceTrials(taskId: string) { return acceptanceTrialsApi.getTaskAcceptanceTrials(this.#http, taskId); }
  startTaskAcceptanceTrial(input: RelayAcceptanceTrialStart) { return acceptanceTrialsApi.startTaskAcceptanceTrial(this.#http, input); }
  transitionTaskAcceptanceTrial(input: RelayAcceptanceTrialTransition) { return acceptanceTrialsApi.transitionTaskAcceptanceTrial(this.#http, input); }
  recordTaskAcceptanceObservation(input: RelayAcceptanceObservationInput) { return acceptanceTrialsApi.recordTaskAcceptanceObservation(this.#http, input); }
  async getTaskAcceptanceMaterials(taskId: string) {
    return acceptanceMaterialsApi.getTaskAcceptanceMaterials(this.#http, taskId);
  }

  async attachTaskAcceptanceMaterial(input: RelayAcceptanceMaterialInput) {
    return acceptanceMaterialsApi.attachTaskAcceptanceMaterial(this.#http, input);
  }

  async importTaskAcceptanceMaterial(input: RelayAcceptanceMaterialImport) {
    return acceptanceMaterialsApi.importTaskAcceptanceMaterial(this.#http, input);
  }

  async withdrawTaskAcceptanceMaterial(input: {
    taskId: string; materialId: string; commandId: string; expectedRevision: DecimalRevision;
  }) {
    return acceptanceMaterialsApi.withdrawTaskAcceptanceMaterial(this.#http, input);
  }
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
  getChatCommands() { return chatControlsApi.getChatCommands(this.#http); }
  /**
   * 发送前草稿辅助（工作台 §30）：只送当前草稿与操作类型。
   * 不创建消息/Task/Run；失败与「没有建议」都不是发送的前置条件。
   */
  requestComposerDraftAssist(input: { operation: ComposerDraftOperation; text: string;
    signal?: AbortSignal }): Promise<RelayComposerDraftAssist> {
    return composerDraftAssistApi.requestComposerDraftAssist(this.#http, input);
  }
  restartAssistSession(input: { sessionId: string; commandId: string; text: string; system: "clear" | "new" }) {
    return chatControlsApi.restartAssistSession(this.#http, input);
  }
  getLearningRecords() { return learningApi.getLearningRecords(this.#http); }
  getLearningState(sessionId: string) { return learningApi.getLearningState(this.#http, sessionId); }
  getLearningContinuation(sessionId: string) { return learningApi.getLearningContinuation(this.#http, sessionId); }
  submitLearningCommand(action: RelayLearningCommand) { return learningApi.submitLearningCommand(this.#http, action); }
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

  /** 撤销项目归档（ADR-027）：只把 archived_at 写回 NULL。 */
  async unarchiveProject(input: { readonly projectId: string; readonly commandId: string; readonly expectedRevision: DecimalRevision }): Promise<RelayCommandEnvelope> {
    return projectsApi.unarchiveProject(this.#http, input);
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

  async getAssistSessions(target: { projectId?: string; taskId?: string; includeContext?: boolean; status?: "ACTIVE" | "ARCHIVED" | "ALL" } = {}): Promise<readonly RelayAssistSession[]> {
    return assistApi.getAssistSessions(this.#http, target);
  }

  async getAssistSession(sessionId: string, includeContext = false): Promise<RelayAssistSession> {
    return assistApi.getAssistSession(this.#http, sessionId, includeContext);
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

  async bindAssistSessionProject(input: { readonly sessionId: string; readonly commandId: string; readonly projectId: string }): ReturnType<typeof assistApi.bindAssistSessionProject> {
    return assistApi.bindAssistSessionProject(this.#http, input);
  }

  /**
   * 绑定本会话的当前工作目录（0087）。
   *
   * 与归属同一条接续原则：作用域是服务端事实，按原 command_id 重放拿回原回执，
   * 迟到或无法核对的结果不换 ID 重试。
   */
  async bindAssistSessionDirectory(input: { readonly sessionId: string; readonly commandId: string; readonly resourceId: string }): ReturnType<typeof assistApi.bindAssistSessionDirectory> {
    return assistApi.bindAssistSessionDirectory(this.#http, input);
  }

  /**
   * 会话行内控制五条命令（0090 / 0104）。都只改这一行自身的标题/排序键/未读标记/归档态，
   * 带 expected_revision 的 CAS；冲突原样抛出，由界面重读后让人重新决定，不换 ID 重试。
   */
  async renameAssistSession(input: { readonly sessionId: string; readonly commandId: string;
    readonly expectedRevision: DecimalRevision; readonly title: string }): ReturnType<typeof assistApi.renameAssistSession> {
    return assistApi.renameAssistSession(this.#http, input);
  }

  async setAssistSessionPin(input: { readonly sessionId: string; readonly commandId: string;
    readonly expectedRevision: DecimalRevision; readonly pinned: boolean }): ReturnType<typeof assistApi.setAssistSessionPin> {
    return assistApi.setAssistSessionPin(this.#http, input);
  }

  async setAssistSessionUnread(input: { readonly sessionId: string; readonly commandId: string;
    readonly expectedRevision: DecimalRevision; readonly unread: boolean }): ReturnType<typeof assistApi.setAssistSessionUnread> {
    return assistApi.setAssistSessionUnread(this.#http, input);
  }

  async archiveAssistSession(input: { readonly sessionId: string; readonly commandId: string;
    readonly expectedRevision: DecimalRevision }): ReturnType<typeof assistApi.archiveAssistSession> {
    return assistApi.archiveAssistSession(this.#http, input);
  }

  async reopenAssistSession(input: { readonly sessionId: string; readonly commandId: string;
    readonly expectedRevision: DecimalRevision }): ReturnType<typeof assistApi.reopenAssistSession> {
    return assistApi.reopenAssistSession(this.#http, input);
  }

  /** 物理删除（ADR-027）：不可撤销，被引用时 409 `SESSION_DELETE_BLOCKED`。 */
  async deleteAssistSession(input: { readonly sessionId: string; readonly commandId: string;
    readonly expectedRevision: DecimalRevision }): ReturnType<typeof assistApi.deleteAssistSession> {
    return assistApi.deleteAssistSession(this.#http, input);
  }

  /** 分叉（0113）：回执里的会话身份是新子会话，不是这条目标会话。 */
  async forkAssistSession(input: { readonly sessionId: string; readonly commandId: string;
    readonly expectedRevision: DecimalRevision }): ReturnType<typeof assistApi.forkAssistSession> {
    return assistApi.forkAssistSession(this.#http, input);
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

  /** 0093：上传一张图片附件（暂存行，随消息命令的 attachment_ids 绑定）。 */
  async uploadAssistMessageAttachment(input: { readonly sessionId: string; readonly name: string;
    readonly mediaType: string; readonly dataBase64: string }): ReturnType<typeof assistApi.uploadAssistMessageAttachment> {
    return assistApi.uploadAssistMessageAttachment(this.#http, input);
  }

  /** 0093：读一张附件内容（历史消息缩略图）。 */
  async getAssistMessageAttachment(input: { readonly sessionId: string;
    readonly attachmentId: string }): ReturnType<typeof assistApi.getAssistMessageAttachment> {
    return assistApi.getAssistMessageAttachment(this.#http, input);
  }

  async requestAssistMessage(input: { sessionId: string; commandId: string; content: string; sourceRefs: readonly RelayAssistSourceRef[]; recordLearning?: boolean; expectedModelSelectionRevision?: string; attachmentIds?: readonly string[] } & ( { intent: "DISCUSS" | "PROPOSE_CANDIDATE" | "PROPOSE_TASK"; skillRef?: never; skillInput?: never } | { intent?: never; skillRef: { id: string; version: string }; skillInput: RelaySkillInput } | { intent?: never; skillRef?: never; skillInput?: never } )): Promise<{ userMessageId: string; assistantMessageId: string }> {
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

  /** 会话总 diff：基线到当前已落盘内容的净变化（工作台 §34）。 */
  async getConversationDiff(sessionId: string): Promise<RelayConversationDiff> {
    return conversationDiffApi.getConversationDiff(this.#http, sessionId);
  }

  /** 展开阅读单个文件的完整正文（CD-18）：与总数同一份基线修订与当前快照。 */
  async getConversationDiffFile(sessionId: string, path: string): Promise<RelayConversationDiffFile> {
    return conversationDiffApi.getConversationDiffFileDetail(this.#http, sessionId, path);
  }

  /** CD-05：主动「从现在开始统计」——为当前目录新建一段基线（幂等）。 */
  async establishConversationDiffBaseline(sessionId: string): Promise<{ established: boolean; reason: string }> {
    return conversationDiffApi.establishConversationDiffBaseline(this.#http, sessionId);
  }

  /** 对话状态维护解释：明确维护指令的 user 消息 → 状态维护请求投影。 */
  async createStateMaintenanceRequest(input: { sessionId: string; sourceMessageId: string;
    commandId: string; timezone?: string }): Promise<RelayStateMaintenanceRequest> {
    return stateMaintenanceApi.createStateMaintenanceRequest(this.#http, input);
  }

  /** 明确指令自动生效：applications 入口，服务端按请求行幂等。 */
  async applyConversationStateRequest(requestId: string): Promise<RelayStateMaintenanceApplyResult> {
    return stateMaintenanceApi.applyConversationStateRequest(this.#http, requestId);
  }

  /** 已生效整组的撤回：按发送时固定的命令身份重放；整组有不可撤回项时须先读方案。 */
  async withdrawConversationStateRequest(input: { requestId: string; commandId: string;
    planDigest?: string; confirmedChangeIds?: readonly string[] }): Promise<RelayStateMaintenanceApplyResult> {
    return stateMaintenanceApi.withdrawConversationStateRequest(this.#http, input);
  }

  /** 撤回事前预检方案（只读）：逐条可撤回性、原因与影响。 */
  async getConversationStateUndoPlan(requestId: string): Promise<RelayUndoPlan> {
    return stateMaintenanceApi.getConversationStateUndoPlan(this.#http, requestId);
  }

  /** 对既有待决定的一句话续答：绑定原请求与展示版本，决定本身不写业务事实。 */
  async answerConversationStateDecision(input: { requestId: string; commandId: string;
    resolution: "ACCEPT" | "DECLINE"; answer: string;
    expectedRevision: string }): Promise<RelayStateMaintenanceApplyResult> {
    return stateMaintenanceApi.answerConversationStateDecision(this.#http, input);
  }

  async getConversationStateRequests(sessionId: string): Promise<readonly RelayStateMaintenanceRequest[]> {
    return stateMaintenanceApi.getConversationStateRequests(this.#http, sessionId);
  }

  /** 返回项目时的顶部接续卡：当前事实、相对上次已确认查看的基线与变化。 */
  async getDailyContinuation(projectId: string): Promise<RelayDailyContinuation> {
    return projectDailyContinuationApi.getDailyContinuation(this.#http, projectId);
  }

  /** 「已查看」确认：只记录阅读进度（一次 presentation_id 一次），不是接受或完成。 */
  async confirmDailyView(projectId: string, input: RelayDailyViewConfirmationInput): Promise<RelayDailyContinuation> {
    return projectDailyContinuationApi.confirmDailyView(this.#http, projectId, input);
  }

  /** 返回轻量核对：同一份事实与证据由服务端复用同一核对记录，只读、不启动进程。 */
  async reviewProjectReturn(projectId: string, commandId: string): Promise<RelayReturnReview> {
    return projectDailyContinuationApi.reviewProjectReturn(this.#http, projectId, commandId);
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

  /** 目录写档位只读查询：档位来自服务端投影，界面只显示、不自行比较策略。 */
  async getWriteReadiness(projectId: string, resourceId: string): Promise<RelayWriteReadiness> {
    return gatewayApi.getWriteReadiness(this.#http, projectId, resourceId);
  }

  async setLocalDirectoryWriteTier(input: { projectId: string; resourceId: string; commandId: string;
    expectedRevision: DecimalRevision; tier: RelayWriteTier }): Promise<RelayCommandEnvelope> {
    return gatewayApi.setLocalDirectoryWriteTier(this.#http, input);
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

  /**
   * 生成中的工具参数预览（工作台 §34.4 / CD-09、CD-11）：只读、可丢弃、Run 终态即空。
   * 它不是结算账本，也不参与会话总数；局部行的「正在生成 · 预览 …」只由它驱动。
   */
  async getRunToolCallPreviews(runId: string): Promise<RelayRunToolCallPreviews> {
    return runApi.getRunToolCallPreviews(this.#http, runId);
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

  /** Streaming Run DRAFT generation preview (http-command-contract.md §10.59). The caller owns reconnects and degrades to GET on error. */
  async readRunDraftPreviewStream(runId: string, signal: AbortSignal, onPreview: (preview: RelayRunDraftPreview) => void, onOpen: () => void): Promise<void> {
    return previewStreamApi.readRunDraftPreviewStream(this.#http, runId, signal, onPreview, onOpen);
  }

  /** Streaming Assist DISCUSS generation preview (http-command-contract.md §10.59). One stream per message. */
  async readAssistLivePreviewStream(sessionId: string, messageId: string, signal: AbortSignal, onPreview: (preview: RelayAssistLivePreview) => void, onOpen: () => void): Promise<void> {
    return previewStreamApi.readAssistLivePreviewStream(this.#http, sessionId, messageId, signal, onPreview, onOpen);
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
  async createImpactCandidateGroup(input: { readonly checkId: string; readonly targetVersionIds: readonly string[]; readonly commandId: string; readonly dependencies?: readonly { readonly targetVersionId: string; readonly dependsOnTargetVersionId: string }[] }): Promise<string> {
    return artifactsApi.createImpactCandidateGroup(this.#http, input);
  }

  async getImpactCandidateGroup(id: string): Promise<RelayImpactCandidateGroup> {
    return artifactsApi.getImpactCandidateGroup(this.#http, id);
  }

  async createImpactGroupSelection(input: { groupId: string; commandId: string; candidateIds: readonly string[] }) {
    return impactGroupSelectionsApi.createImpactGroupSelection(this.#http, input);
  }

  async getImpactGroupSelection(id: string) {
    return impactGroupSelectionsApi.getImpactGroupSelection(this.#http, id);
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

  async applyArtifactImpactCandidate(input: { readonly candidateId: string; readonly expectedTargetRevision: DecimalRevision; readonly commandId: string; readonly groupSelectionId?: string }): Promise<string> {
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
