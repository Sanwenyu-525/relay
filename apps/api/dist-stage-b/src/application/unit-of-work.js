import { ActivityRecordRepository } from '../audit/activity-record-repository.js';
import { AssistRepository } from '../assist/assist-repository.js';
import { AssistantProfileRepository } from '../assist/assistant-profile-repository.js';
import { ConversationExecutionRepository } from '../assist/conversation-execution-repository.js';
import { ArtifactRepository } from '../artifact/artifact-repository.js';
import { ImpactRepository } from '../artifact/impact-repository.js';
import { LineageRepository } from '../artifact/lineage-repository.js';
import { CompletionRepository } from '../completion/completion-repository.js';
import { ProjectRepository } from '../project/project-repository.js';
import { ContinuationPointRepository } from '../project/continuation-point-repository.js';
import { KnowledgeGuideRepository } from '../project/knowledge-guide-repository.js';
import { CommandReceiptRepository } from '../receipt/command-receipt-repository.js';
import { RunRepository } from '../run/run-repository.js';
import { RunToolCallRepository } from '../run/run-tool-call-repository.js';
import { RecoveryRepository } from '../run/recovery-repository.js';
import { RunDispatchRepository } from '../run/run-dispatch-repository.js';
import { ReviewRepository } from '../review/review-repository.js';
import { TaskRepository } from '../task/task-repository.js';
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
export function createRepositories(db) {
    return {
        admission: new RuntimeAdmissionRepository(db),
        activities: new ActivityRecordRepository(db),
        assist: new AssistRepository(db),
        assistantProfiles: new AssistantProfileRepository(db),
        conversationExecutions: new ConversationExecutionRepository(db),
        artifacts: new ArtifactRepository(db),
        impacts: new ImpactRepository(db),
        lineage: new LineageRepository(db),
        completions: new CompletionRepository(db),
        projects: new ProjectRepository(db),
        continuationPoints: new ContinuationPointRepository(db),
        knowledgeGuides: new KnowledgeGuideRepository(db),
        receipts: new CommandReceiptRepository(db),
        runs: new RunRepository(db),
        toolCalls: new RunToolCallRepository(db),
        scopeGrants: new RunScopeGrantRepository(db),
        recovery: new RecoveryRepository(db),
        dispatch: new RunDispatchRepository(db),
        reviews: new ReviewRepository(db),
        tasks: new TaskRepository(db),
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
    };
}
/**
 * 在应用事务中执行用例：所有 Repository 都绑定同一个事务连接，
 * 由这里决定提交或回滚，Repository 不得自行 transaction()/commit。
 * 提交失败（含延迟外键在 COMMIT 时才报错）会作为整个用例失败抛出，调用方不能在此之前报告成功。
 */
export async function withTransaction(db, work) {
    return db.transaction().execute(async (transaction) => work(createRepositories(transaction)));
}
