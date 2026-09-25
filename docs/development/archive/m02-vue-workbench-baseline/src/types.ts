export type FixtureMode =
  | "normal"
  | "empty"
  | "load-error"
  | "conflict"
  | "expired"
  | "timeout"
  | "response-lost"
  | "source-unavailable"
  | "checkers-registered"
  | "import-failed";

export type SourceKind =
  | "project-state"
  | "task-list"
  | "artifact"
  | "verification"
  | "note"
  | "goal"
  | "checker-registry"
  | "review-record"
  | "evidence"
  | "result-definition";

export interface SourceReference {
  id: string;
  title: string;
  version: string;
  excerpt: string;
  availability: "available" | "unavailable";
  kind: SourceKind;
}

/** Project Type 决定 phase 词汇，取值见 docs/frontend/workbench-design.md 第 3 节。 */
export type ProjectType = "GENERAL" | "THESIS" | "DEVELOPMENT";

/** Task 工作状态，取值见 contracts/02-state-and-execution.md。 */
export type TaskStatus =
  | "INBOX"
  | "READY"
  | "IN_PROGRESS"
  | "WAITING"
  | "BLOCKED"
  | "DONE"
  | "CANCELLED";

/** API 中 bigint / revision 字段以十进制字符串传输，不能在前端转成 Number。 */
export type DecimalRevision = string;

/** 交互模式。DELEGATE_AI 只能由 Delegate 用例设置，UI 只表达意图。 */
export type InteractionMode = "ME" | "AI_ASSIST" | "DELEGATE_AI";

/** 当前执行者。工作状态、执行模式与执行者是三个独立事实。 */
export type ExecutorKind = "HUMAN" | "AI";

export interface ProjectSummary {
  id: string;
  title: string;
  projectType: ProjectType;
  phase: string;
  goal: string;
  summary: string;
  nextAction: string | null;
  stateRevision: DecimalRevision;
  archived: boolean;
  pendingReviewCount: number;
  /** 非空表示归档被拒绝，并给出可解释的业务阻塞依据。 */
  archiveBlockedReason: string | null;
}

export interface TaskSummary {
  id: string;
  /** null 表示未归属项目的人工任务，不能据此自动创建 Project。 */
  projectId: string | null;
  title: string;
  status: TaskStatus;
  /** 仅 WAITING 使用；说明在等谁、等什么。 */
  waitingReason: string | null;
  /** 仅 BLOCKED 使用；必须有可解释的业务阻塞依据。 */
  blockedReason: string | null;
  mode: InteractionMode;
  executor: ExecutorKind;
  revision: DecimalRevision;
  dependencyIds: string[];
}

export interface TaskDependencyNote {
  id: string;
  title: string;
  status: TaskStatus;
  executor: ExecutorKind;
  /** 说明为什么前置未完成会阻止开始。 */
  reason: string;
  /** 该任务完成后的后续影响。 */
  downstreamNote: string;
}

export interface CreateProjectDraft {
  title: string;
  goal: string;
  projectType: ProjectType;
  importFileName: string | null;
}

export interface CreateTaskDraft {
  title: string;
  projectId: string | null;
  expectedResult: string;
  /** 逐行一条验收条件；至少一条非空才视为具备可判断的完成标准。 */
  acceptanceCriteria: string;
  startIntent: InteractionMode;
  dependencyId: string | null;
}

export interface BlueprintDraft {
  nextAction: string;
  taskTitles: string[];
  workbench: "通用" | "论文";
}

export interface BlueprintRecord {
  id: string;
  version: number;
  baseRevision: DecimalRevision;
  status: "PENDING" | "APPLIED" | "REJECTED";
  draft: BlueprintDraft;
}

export interface TaskDefinitionDraft {
  objective: string;
  expectedResult: string;
  acceptanceCriteria: string[];
  inputSource: string;
  suggestedMode: "人工执行，按需 AI 辅助";
}

export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  revision: DecimalRevision;
  originalIntent: string;
  status: TaskStatus;
  mode: InteractionMode;
  executor: ExecutorKind;
  definition: TaskDefinitionDraft;
  proposalStatus: "PENDING" | "APPLIED" | "REJECTED";
}

export interface VerificationCheck {
  id: string;
  title: string;
  method: string;
  status: "NOT_RUN" | "MISSING_CAPABILITY" | "HUMAN_PENDING";
  required: true;
}

export interface VerificationPlan {
  id: string;
  taskRevision: DecimalRevision;
  acceptanceRevision: DecimalRevision;
  proposalVersion: number;
  savedNote: string;
  checks: VerificationCheck[];
}

export type ResumeTarget = { kind: "task"; taskId: string } | { kind: "source"; sourceId: string };

export interface ResumeProgressItem {
  id: string;
  state: "completed" | "review" | "available";
  label: string;
  action: "完成依据" | "查看验收" | "查看任务";
  target: ResumeTarget;
}

export interface ResumeSuggestion {
  id: string;
  text: string;
  basis: string;
  target: ResumeTarget;
}

export interface ResumeRiskNote {
  text: string;
  sourceId: string;
}

export interface ResumeSummary {
  updatedAt: string;
  hasBaseline: boolean;
  progress: ResumeProgressItem[];
  risks: ResumeRiskNote[];
  suggestions: ResumeSuggestion[];
}

export interface ProjectSnapshot {
  id: string;
  name: string;
  stateRevision: DecimalRevision;
  workbench: "通用" | "论文";
  nextAction: string | null;
  tasks: TaskSummary[];
  blueprint: BlueprintRecord;
  task: TaskRecord;
  verification: VerificationPlan;
  sources: SourceReference[];
  resume: ResumeSummary;
  pendingReviewCount: number;
}

export interface DemoReceipt {
  commandId: string;
  description: string;
  runStarted: false;
  revision: DecimalRevision;
}

export class FixtureError extends Error {
  constructor(
    public readonly kind: "load" | "conflict" | "expired" | "timeout" | "source",
    message: string
  ) {
    super(message);
    this.name = "FixtureError";
  }
}

const fixtureModes: FixtureMode[] = [
  "normal",
  "empty",
  "load-error",
  "conflict",
  "expired",
  "timeout",
  "response-lost",
  "source-unavailable",
  "checkers-registered",
  "import-failed"
];

export function isFixtureMode(value: unknown): value is FixtureMode {
  return typeof value === "string" && fixtureModes.includes(value as FixtureMode);
}
