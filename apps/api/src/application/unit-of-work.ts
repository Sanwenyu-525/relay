import type { DbExecutor } from '../infrastructure/database.js';
import { ActivityRecordRepository } from '../audit/activity-record-repository.js';
import { AssistRepository } from '../assist/assist-repository.js';
import { ArtifactRepository } from '../artifact/artifact-repository.js';
import { ImpactRepository } from '../artifact/impact-repository.js';
import { LineageRepository } from '../artifact/lineage-repository.js';
import { CompletionRepository } from '../completion/completion-repository.js';
import { ProjectRepository } from '../project/project-repository.js';
import { ContinuationPointRepository } from '../project/continuation-point-repository.js';
import { CommandReceiptRepository } from '../receipt/command-receipt-repository.js';
import { RunRepository } from '../run/run-repository.js';
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

/** 同一连接上的模块写入口集合。用例只能通过这里跨模块协作，不直接拼 SQL。 */
export interface Repositories {
  readonly activities: ActivityRecordRepository;
  readonly assist: AssistRepository;
  readonly artifacts: ArtifactRepository;
  readonly impacts: ImpactRepository;
  readonly lineage: LineageRepository;
  readonly completions: CompletionRepository;
  readonly projects: ProjectRepository;
  readonly continuationPoints: ContinuationPointRepository;
  readonly receipts: CommandReceiptRepository;
  readonly runs: RunRepository;
  readonly recovery: RecoveryRepository;
  readonly dispatch: RunDispatchRepository;
  readonly reviews: ReviewRepository;
  readonly tasks: TaskRepository;
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
}

export function createRepositories(db: DbExecutor): Repositories {
  return {
    activities: new ActivityRecordRepository(db),
    assist: new AssistRepository(db),
    artifacts: new ArtifactRepository(db),
    impacts: new ImpactRepository(db),
    lineage: new LineageRepository(db),
    completions: new CompletionRepository(db),
    projects: new ProjectRepository(db),
    continuationPoints: new ContinuationPointRepository(db),
    receipts: new CommandReceiptRepository(db),
    runs: new RunRepository(db),
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
export async function withTransaction<TResult>(
  db: DbExecutor,
  work: (repositories: Repositories) => Promise<TResult>,
): Promise<TResult> {
  return db.transaction().execute(async (transaction) => work(createRepositories(transaction)));
}
