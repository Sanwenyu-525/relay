import type { DbExecutor } from '../infrastructure/database.js';
import { ActivityRecordRepository } from '../audit/activity-record-repository.js';
import { AssistRepository } from '../assist/assist-repository.js';
import { AssistantProfileRepository } from '../assist/assistant-profile-repository.js';
import { ConversationExecutionRepository } from '../assist/conversation-execution-repository.js';
import { ConversationStateRepository } from '../assist/conversation-state-repository.js';
import { LearningRepository } from '../learning/learning-repository.js';
import { ArtifactRepository } from '../artifact/artifact-repository.js';
import { ImpactRepository } from '../artifact/impact-repository.js';
import { LineageRepository } from '../artifact/lineage-repository.js';
import { CompletionRepository } from '../completion/completion-repository.js';
import { ProjectRepository } from '../project/project-repository.js';
import { ContinuationPointRepository } from '../project/continuation-point-repository.js';
import { KnowledgeGuideRepository } from '../project/knowledge-guide-repository.js';
import { ProjectDailyViewRepository } from '../project/project-daily-view-repository.js';
import { ProjectReturnReviewRepository } from '../project/project-return-review-repository.js';
import { CommandReceiptRepository } from '../receipt/command-receipt-repository.js';
import { RunRepository } from '../run/run-repository.js';
import { RunToolCallRepository } from '../run/run-tool-call-repository.js';
import { RecoveryRepository } from '../run/recovery-repository.js';
import { RunDispatchRepository } from '../run/run-dispatch-repository.js';
import { ReviewRepository } from '../review/review-repository.js';
import { TaskRepository } from '../task/task-repository.js';
import { TaskAcceptanceMaterialRepository } from '../task/task-acceptance-material-repository.js';
import { TaskAcceptanceTrialRepository } from '../task/task-acceptance-trial-repository.js';
import { TaskAcceptanceComparisonRepository } from '../task/task-acceptance-comparison-repository.js';
import { HypothesisRepository } from '../hypothesis/hypothesis-repository.js';
import { DecisionReviewRepository } from '../information/decision-review-repository.js';
import { WorkSegmentRepository } from '../work-segment/work-segment-repository.js';
import { PersonalPlanningRepository } from '../planning/personal-planning-repository.js';
import { ProjectReminderRepository } from '../planning/project-reminder-repository.js';
import { TaskChainRepository } from '../planning/task-chain-repository.js';
import { VerificationRepository } from '../verification/verification-repository.js';
import { WorkspaceRepository } from '../workspace/workspace-repository.js';
import { GatewayRepository } from '../gateway/gateway-repository.js';
import { InformationRepository } from '../information/information-repository.js';
import { ChangeSetRepository } from '../files/change-set-repository.js';
import { FileWriteStopProofRepository } from '../files/file-write-stop-proof-repository.js';
import { FileWriteDispositionRepository } from '../files/file-write-disposition-repository.js';
import { FileWriteDiffRepository } from '../files/file-write-diff-repository.js';
import { FileWritePathRepository } from '../files/file-write-path-repository.js';
import { TodayRepository } from '../today/today-repository.js';
import { ViewRepository } from '../view/view-repository.js';
import { BlueprintRepository } from '../blueprint/blueprint-repository.js';
import { RuntimeAdmissionRepository } from '../runtime/runtime-admission-repository.js';
import { RunScopeGrantRepository } from './run-scope-grant.js';
import { ModelCatalogRepository } from '../model/model-catalog-repository.js';
import { ComputerControlStateRepository } from '../computer/control-state.js';
import { SessionModelSelectionRepository } from '../model/session-model-selection-repository.js';
import { KyselyConversationDiffRepository, type ConversationDiffRepository }
  from '../conversation-diff/conversation-diff-repository.js';
import { KyselyToolCallPreviewRepository, type ToolCallPreviewRepository }
  from '../conversation-diff/tool-call-preview-repository.js';

/** 同一连接上的模块写入口集合。用例只能通过这里跨模块协作，不直接拼 SQL。 */
export interface Repositories {
  readonly admission: RuntimeAdmissionRepository;
  readonly activities: ActivityRecordRepository;
  readonly assist: AssistRepository;
  /** 人设 助手配置的独占写入口。配置文本在这里，能力不在这里。 */
  readonly assistantProfiles: AssistantProfileRepository;
  readonly conversationExecutions: ConversationExecutionRepository;
  /** 自然语言状态维护（0062）：请求与类型化变更行的独占写入口。 */
  readonly conversationState: ConversationStateRepository;
  /** 学习模式（0072）：知识点、证据、清除代次、会话控制与轮次依据的独占写入口。 */
  readonly learning: LearningRepository;
  readonly artifacts: ArtifactRepository;
  readonly impacts: ImpactRepository;
  readonly lineage: LineageRepository;
  readonly completions: CompletionRepository;
  readonly projects: ProjectRepository;
  readonly continuationPoints: ContinuationPointRepository;
  /** 日常查看基线（0063）：「实际查看确认」的独占写入口。 */
  readonly dailyViews: ProjectDailyViewRepository;
  /** 返回轻量核对（0069）：有持久身份的核对记录的独占写入口。 */
  readonly returnReviews: ProjectReturnReviewRepository;
  readonly knowledgeGuides: KnowledgeGuideRepository;
  readonly receipts: CommandReceiptRepository;
  readonly runs: RunRepository;
  readonly toolCalls: RunToolCallRepository;
  /** 本次任务范围授权。与其他仓库一样绑定到调用方的事务执行器。 */
  readonly scopeGrants: RunScopeGrantRepository;
  readonly recovery: RecoveryRepository;
  readonly dispatch: RunDispatchRepository;
  readonly reviews: ReviewRepository;
  readonly tasks: TaskRepository;
  readonly acceptanceMaterials: TaskAcceptanceMaterialRepository;
  readonly acceptanceTrials: TaskAcceptanceTrialRepository;
  readonly acceptanceComparisons: TaskAcceptanceComparisonRepository;
  readonly hypotheses: HypothesisRepository;
  readonly decisionReviews: DecisionReviewRepository;
  readonly workSegments: WorkSegmentRepository;
  readonly personalPlanning: PersonalPlanningRepository;
  readonly projectReminders: ProjectReminderRepository;
  readonly taskChains: TaskChainRepository;
  readonly verifications: VerificationRepository;
  readonly workspaces: WorkspaceRepository;
  readonly gateway: GatewayRepository;
  readonly changeSets: ChangeSetRepository;
  readonly fileWriteStopProofs: FileWriteStopProofRepository;
  readonly fileWriteDispositions: FileWriteDispositionRepository;
  readonly fileWriteDiffs: FileWriteDiffRepository;
  readonly fileWritePaths: FileWritePathRepository;
  readonly information: InformationRepository;
  readonly today: TodayRepository;
  readonly views: ViewRepository;
  readonly blueprints: BlueprintRepository;
  /** 免费模型目录快照与同步租约/退避的独占写入口（迁移 0088，专项阶段 B）。 */
  readonly modelCatalog: ModelCatalogRepository;
  /** 会话模型选择的独占写入口（迁移 0089，阶段 C）：会话作用域选择记录，从不写回进程默认。 */
  readonly modelSelection: SessionModelSelectionRepository;
  /** 电脑操控展示状态（迁移 0096）：「Relay 是否正在操控电脑」的唯一持久事实。 */
  readonly computerControl: ComputerControlStateRepository;
  /** 会话基线（迁移 0097）：「本轮对话以来」受管根内容快照的独占写入口（工作台 §34）。 */
  readonly conversationDiff: ConversationDiffRepository;
  /** 工具调用生成中预览（迁移 0102）：可丢弃的展示证据，不进总数、不授予权限。 */
  readonly toolCallPreview: ToolCallPreviewRepository;
}

export function createRepositories(db: DbExecutor): Repositories {
  return {
    admission: new RuntimeAdmissionRepository(db),
    activities: new ActivityRecordRepository(db),
    assist: new AssistRepository(db),
    assistantProfiles: new AssistantProfileRepository(db),
    conversationExecutions: new ConversationExecutionRepository(db),
    conversationState: new ConversationStateRepository(db),
    learning: new LearningRepository(db),
    artifacts: new ArtifactRepository(db),
    impacts: new ImpactRepository(db),
    lineage: new LineageRepository(db),
    completions: new CompletionRepository(db),
    projects: new ProjectRepository(db),
    continuationPoints: new ContinuationPointRepository(db),
    dailyViews: new ProjectDailyViewRepository(db),
    returnReviews: new ProjectReturnReviewRepository(db),
    knowledgeGuides: new KnowledgeGuideRepository(db),
    receipts: new CommandReceiptRepository(db),
    runs: new RunRepository(db),
    toolCalls: new RunToolCallRepository(db),
    scopeGrants: new RunScopeGrantRepository(db),
    recovery: new RecoveryRepository(db),
    dispatch: new RunDispatchRepository(db),
    reviews: new ReviewRepository(db),
    tasks: new TaskRepository(db),
    acceptanceMaterials: new TaskAcceptanceMaterialRepository(db),
    acceptanceTrials: new TaskAcceptanceTrialRepository(db),
    acceptanceComparisons: new TaskAcceptanceComparisonRepository(db),
    hypotheses: new HypothesisRepository(db),
    decisionReviews: new DecisionReviewRepository(db),
    workSegments: new WorkSegmentRepository(db),
    personalPlanning: new PersonalPlanningRepository(db),
    projectReminders: new ProjectReminderRepository(db),
    taskChains: new TaskChainRepository(db),
    verifications: new VerificationRepository(db),
    workspaces: new WorkspaceRepository(db),
    gateway: new GatewayRepository(db),
    changeSets: new ChangeSetRepository(db),
    fileWriteStopProofs: new FileWriteStopProofRepository(db),
    fileWriteDispositions: new FileWriteDispositionRepository(db),
    fileWriteDiffs: new FileWriteDiffRepository(db),
    fileWritePaths: new FileWritePathRepository(db),
    information: new InformationRepository(db),
    today: new TodayRepository(db),
    views: new ViewRepository(db),
    blueprints: new BlueprintRepository(db),
    modelCatalog: new ModelCatalogRepository(db),
    modelSelection: new SessionModelSelectionRepository(db),
    computerControl: new ComputerControlStateRepository(db),
    conversationDiff: new KyselyConversationDiffRepository(db),
    toolCallPreview: new KyselyToolCallPreviewRepository(db),
  };
}

/**
 * 在应用事务中执行用例：所有 Repository 都绑定同一个事务连接，
 * 由这里决定提交或回滚，Repository 不得自行 transaction()/commit。
 * 提交失败（含延迟外键在 COMMIT 时才报错）会作为整个用例失败抛出，调用方不能在此之前报告成功。
 */
export async function withTransaction<TResult>(
  db: DbExecutor,
  work: (repositories: Repositories) => Promise<TResult>,
): Promise<TResult> {
  return db.transaction().execute(async (transaction) => work(createRepositories(transaction)));
}
