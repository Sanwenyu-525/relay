import type { DbExecutor } from '../infrastructure/database.js';
import { ActivityRecordRepository } from '../audit/activity-record-repository.js';
import { ArtifactRepository } from '../artifact/artifact-repository.js';
import { CompletionRepository } from '../completion/completion-repository.js';
import { ProjectRepository } from '../project/project-repository.js';
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

/** 同一连接上的模块写入口集合。用例只能通过这里跨模块协作，不直接拼 SQL。 */
export interface Repositories {
  readonly activities: ActivityRecordRepository;
  readonly artifacts: ArtifactRepository;
  readonly completions: CompletionRepository;
  readonly projects: ProjectRepository;
  readonly receipts: CommandReceiptRepository;
  readonly runs: RunRepository;
  readonly recovery: RecoveryRepository;
  readonly dispatch: RunDispatchRepository;
  readonly reviews: ReviewRepository;
  readonly tasks: TaskRepository;
  readonly verifications: VerificationRepository;
  readonly workspaces: WorkspaceRepository;
  readonly gateway: GatewayRepository;
  readonly information: InformationRepository;
}

export function createRepositories(db: DbExecutor): Repositories {
  return {
    activities: new ActivityRecordRepository(db),
    artifacts: new ArtifactRepository(db),
    completions: new CompletionRepository(db),
    projects: new ProjectRepository(db),
    receipts: new CommandReceiptRepository(db),
    runs: new RunRepository(db),
    recovery: new RecoveryRepository(db),
    dispatch: new RunDispatchRepository(db),
    reviews: new ReviewRepository(db),
    tasks: new TaskRepository(db),
    verifications: new VerificationRepository(db),
    workspaces: new WorkspaceRepository(db),
    gateway: new GatewayRepository(db),
    information: new InformationRepository(db),
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
