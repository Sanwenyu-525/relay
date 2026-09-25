import type {
  BlueprintDraft,
  CreateProjectDraft,
  CreateTaskDraft,
  DemoReceipt,
  FixtureMode,
  InteractionMode,
  ProjectSnapshot,
  ProjectSummary,
  ResumeProgressItem,
  ResumeSummary,
  ResumeSuggestion,
  SourceReference,
  TaskDefinitionDraft,
  TaskDependencyNote,
  TaskStatus,
  TaskSummary,
  VerificationCheck
} from "../types";
import { FixtureError } from "../types";
import { createSeed, dependencyNotes, homeProjectId, type FixtureState } from "./seed";
import { compareDecimalRevisions, incrementDecimalRevision } from "../lib/decimalRevision";

type Operation =
  | "loadProject"
  | "loadTask"
  | "previewBlueprint"
  | "applyBlueprint"
  | "rejectBlueprint"
  | "acceptTaskDefinition"
  | "rejectTaskDefinition"
  | "saveVerificationSuggestion"
  | "refreshResume"
  | "lookupReceipt"
  | "listProjects"
  | "createProject"
  | "archiveProject"
  | "listTasks"
  | "loadTaskOptions"
  | "createTask"
  | "startTask"
  | "loadProjectTasks";

export interface TaskListQuery {
  /** "all" 全部项目；"inbox" 未归属项目；其他为具体项目 ID。 */
  projectId: string | "all" | "inbox";
  status: TaskStatus | "all";
  mode: InteractionMode | "all";
  query: string;
}

export interface ProjectTasksResult {
  project: ProjectSummary;
  tasks: TaskSummary[];
  dependencies: TaskDependencyNote[];
}

export interface TaskOptions {
  projects: ProjectSummary[];
  /** 可选为前置依赖的任务，来自同一项目范围。 */
  candidates: TaskSummary[];
}

export interface ReceiptLookup {
  status: "APPLIED" | "NOT_SUBMITTED" | "UNKNOWN";
  commandId: string;
  operation?: "project" | "task";
  receipt?: DemoReceipt;
  resourceId?: string;
  importStatus?: "none" | "SUCCEEDED" | "FAILED";
  taskStatus?: TaskStatus;
  readyBlockedReason?: string | null;
}

let latencyMs = 180;

function zeroCalls(): Record<Operation, number> {
  return {
    loadProject: 0,
    loadTask: 0,
    previewBlueprint: 0,
    applyBlueprint: 0,
    rejectBlueprint: 0,
    acceptTaskDefinition: 0,
    rejectTaskDefinition: 0,
    saveVerificationSuggestion: 0,
    refreshResume: 0,
    lookupReceipt: 0,
    listProjects: 0,
    createProject: 0,
    archiveProject: 0,
    listTasks: 0,
    loadTaskOptions: 0,
    createTask: 0,
    startTask: 0,
    loadProjectTasks: 0
  };
}

let calls = zeroCalls();
let state: FixtureState = createSeed();
let commandSequence = 0;
const receipts = new Map<string, ReceiptLookup>();

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function wait(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, latencyMs));
}

function throwForUnavailableMode(mode: FixtureMode): void {
  if (mode === "load-error") {
    throw new FixtureError("load", "示例数据暂时不可读取，请稍后重试。");
  }
  if (mode === "expired") {
    throw new FixtureError("expired", "此候选已过期，请重新核对并生成预览。");
  }
}

function sourceForMode(source: SourceReference, mode: FixtureMode): SourceReference {
  if (mode === "source-unavailable" && source.id === "literature-review-v3") {
    return {
      ...source,
      availability: "unavailable",
      excerpt: "该示例来源当前不可读取；摘要不会据此补全内容，也不展示已撤销的正文。"
    };
  }
  return source;
}

function checksForMode(checks: VerificationCheck[], mode: FixtureMode): VerificationCheck[] {
  if (mode !== "checkers-registered") {
    return checks;
  }
  return checks.map((check) =>
    check.id === "semantic" ? { ...check, status: "NOT_RUN", method: "语义核对" } : check
  );
}

function sourceById(id: string): SourceReference {
  const source = state.sources.find((candidate) => candidate.id === id);
  if (!source) {
    throw new FixtureError("source", `示例来源缺失：${id}`);
  }
  return source;
}

function projectById(projectId: string): ProjectSummary {
  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new FixtureError("load", `示例项目缺失：${projectId}`);
  }
  return project;
}

function tasksOfProject(projectId: string): TaskSummary[] {
  return state.tasks.filter((task) => task.projectId === projectId);
}

function taskById(taskId: string): TaskSummary | undefined {
  return state.tasks.find((candidate) => candidate.id === taskId);
}

function deriveResume(): ResumeSummary {
  const progress: ResumeProgressItem[] = [
    {
      id: "research-question",
      state: "completed",
      label: "明确研究问题",
      action: "完成依据",
      target: { kind: "source", sourceId: "completion-evidence-v1" }
    },
    {
      id: "literature-review",
      state: "review",
      label: `文献综述 ${sourceById("literature-review-v3").version}`,
      action: "查看验收",
      target: { kind: "source", sourceId: "review-record-v1" }
    }
  ];

  if (state.projectTask.proposalStatus === "APPLIED") {
    progress.push({
      id: "task-definition",
      state: "available",
      label: `任务定义已形成 v${state.projectTask.revision} 修订`,
      action: "查看任务",
      target: { kind: "task", taskId: state.projectTask.id }
    });
  }

  progress.push({
    id: "metric-task",
    state: "available",
    label:
      compareDecimalRevisions(state.projectTask.revision, "1") > 0
        ? `${state.projectTask.title} v${state.projectTask.revision}`
        : state.projectTask.title,
    action: "查看任务",
    target: { kind: "task", taskId: state.projectTask.id }
  });

  const createdIds = state.blueprintCreatedTaskIds.filter((id) => taskById(id));
  if (createdIds.length > 0) {
    progress.push({
      id: "blueprint-inbox",
      state: "available",
      label: `蓝图新增 ${createdIds.length} 项收件箱任务`,
      action: "查看任务",
      target: { kind: "task", taskId: createdIds[0] }
    });
  }

  const risks: ResumeSummary["risks"] = [];
  if (state.projectTask.proposalStatus === "APPLIED") {
    risks.push({
      text: `任务定义已更新为 v${state.projectTask.revision}，验收方案仍基于任务 v${state.verification.taskRevision}，需要重新核对。`,
      sourceId: "acceptance-v2"
    });
  }
  if (state.verification.savedNote) {
    risks.push({
      text: "验收方案建议已保存为待确认，尚未应用为有效检查方案。",
      sourceId: "acceptance-v2"
    });
  }
  if (state.blueprint.status === "PENDING" && state.blueprint.draft.taskTitles.filter(Boolean).length > 0) {
    risks.push({
      text: "蓝图建议仍是待确认状态；暂不采用会保留已创建的项目，不会新增任务。",
      sourceId: "goal-v1"
    });
  }
  risks.push({
    text: "文献综述 v3 的检查已通过，但尚未完成人工接受，因此不能算作业务完成。",
    sourceId: "review-record-v1"
  });

  const suggestions: ResumeSuggestion[] = [
    {
      id: "verify-citations",
      text: "核对文献综述的引用与论断",
      basis: "基于待审记录",
      target: { kind: "source", sourceId: "review-record-v1" }
    },
    state.projectTask.proposalStatus === "APPLIED"
      ? {
          id: "prepare-start",
          text: `准备开始“${state.projectTask.title}”`,
          basis: `基于当前任务 v${state.projectTask.revision}`,
          target: { kind: "task", taskId: state.projectTask.id }
        }
      : {
          id: "refine-metric-task",
          text: "再完善实验评价指标",
          basis: "基于当前任务",
          target: { kind: "task", taskId: state.projectTask.id }
        }
  ];

  return {
    updatedAt: state.resumeUpdatedAt,
    hasBaseline: false,
    progress,
    risks,
    suggestions
  };
}

function homeSnapshot(mode: FixtureMode): ProjectSnapshot {
  const next = copy(state);
  const home = next.projects.find((project) => project.id === homeProjectId)!;
  return {
    id: homeProjectId,
    name: home.title,
    stateRevision: home.stateRevision,
    workbench: next.workbench,
    nextAction: home.nextAction,
    tasks: tasksOfProject(homeProjectId),
    blueprint: next.blueprint,
    task: next.projectTask,
    verification: {
      ...next.verification,
      checks: checksForMode(next.verification.checks, mode)
    },
    sources: next.sources.map((source) => sourceForMode(source, mode)),
    resume: deriveResume(),
    pendingReviewCount: home.pendingReviewCount
  };
}

function nextCommandId(prefix: string): string {
  commandSequence += 1;
  return `${prefix}-demo-${commandSequence}`;
}

function requireHomeProjectSkill(projectId: string): void {
  if (projectId !== homeProjectId) {
    throw new FixtureError("load", "这个示例项目尚未提供对应的 Skill 数据，不能读取或写入其他项目的示例。");
  }
}

function requireHomeTaskSkill(taskId: string): void {
  if (taskId !== state.projectTask.id) {
    throw new FixtureError("load", "这个示例任务尚未提供对应的 Skill 数据，不能读取或写入其他任务的示例。");
  }
}

function receiptFor(commandId: string): ReceiptLookup {
  return copy(receipts.get(commandId) ?? { status: "NOT_SUBMITTED", commandId });
}

function unknownReceipt(commandId: string): never {
  receipts.set(commandId, { status: "UNKNOWN", commandId });
  throw new FixtureError("timeout", "提交结果暂不明确；请使用原 command ID 查询本次演示回执，不要直接重复创建。");
}

function parseCriteria(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function matchesQuery(title: string, query: string): boolean {
  const needle = query.trim();
  return needle.length === 0 || title.toLowerCase().includes(needle.toLowerCase());
}

export const fixtureAdapter = {
  createCommandId(prefix: "project" | "task"): string {
    return nextCommandId(prefix);
  },

  async loadProject(projectId: string, mode: FixtureMode): Promise<ProjectSnapshot | null> {
    calls.loadProject += 1;
    await wait();
    throwForUnavailableMode(mode);
    if (mode === "empty" || projectId === "empty") {
      return null;
    }
    if (projectId !== homeProjectId) {
      return null;
    }
    return homeSnapshot(mode);
  },

  async loadTask(taskId: string, mode: FixtureMode): Promise<ProjectSnapshot | null> {
    calls.loadTask += 1;
    await wait();
    throwForUnavailableMode(mode);
    if (mode === "empty" || taskId === "empty") {
      return null;
    }
    if (taskId !== state.projectTask.id) {
      return null;
    }
    return homeSnapshot(mode);
  },

  async previewBlueprint(
    projectId: string,
    draft: BlueprintDraft,
    mode: FixtureMode
  ): Promise<{ version: number; draft: BlueprintDraft }> {
    calls.previewBlueprint += 1;
    await wait();
    requireHomeProjectSkill(projectId);
    if (mode === "expired") {
      throw new FixtureError("expired", "原候选已过期；输入保留，请重新核对后生成预览。");
    }
    state.blueprint = {
      ...state.blueprint,
      version: state.blueprint.version + 1,
      baseRevision: projectById(homeProjectId).stateRevision,
      status: "PENDING",
      draft: copy(draft)
    };
    return { version: state.blueprint.version, draft: copy(draft) };
  },

  async applyBlueprint(
    projectId: string,
    draft: BlueprintDraft,
    mode: FixtureMode,
    commandId = nextCommandId("project")
  ): Promise<DemoReceipt> {
    calls.applyBlueprint += 1;
    await wait();
    requireHomeProjectSkill(projectId);
    if (mode === "conflict") {
      throw new FixtureError("conflict", "当前项目事实已更新，草稿已保留；请重新核对预览。");
    }
    if (mode === "timeout") {
      return unknownReceipt(commandId);
    }
    if (mode === "expired") {
      throw new FixtureError("expired", "候选已过期，不能应用旧预览。");
    }
    const titles = draft.taskTitles.map((title) => title.trim()).filter(Boolean);
    const home = projectById(homeProjectId);
    state.blueprint = {
      ...state.blueprint,
      version: state.blueprint.version + 1,
      baseRevision: home.stateRevision,
      status: "APPLIED",
      draft: copy({ ...draft, taskTitles: titles })
    };
    home.nextAction = draft.nextAction;
    state.workbench = draft.workbench;
    state.blueprintCreatedTaskIds = titles.map((title, index) => {
      const id = `task-blueprint-${index + 1}`;
      const existing = taskById(id);
      if (existing) {
        existing.title = title;
        return id;
      }
      state.tasks.push({
        id,
        projectId: homeProjectId,
        title,
        status: "INBOX",
        waitingReason: null,
        blockedReason: null,
        mode: "ME",
        executor: "HUMAN",
        revision: "0",
        dependencyIds: []
      });
      return id;
    });
    state.resumeUpdatedAt = "2026-09-20 10:50";
    const receipt: DemoReceipt = {
      commandId,
      description: `本次演示已应用蓝图：新增 ${titles.length} 项待整理任务；尚未开始执行，后续配置建议未随本次应用生效。`,
      runStarted: false,
      revision: home.stateRevision
    };
    receipts.set(commandId, {
      status: "APPLIED",
      commandId,
      operation: "project",
      resourceId: projectId,
      receipt: copy(receipt)
    });
    return receipt;
  },

  async rejectBlueprint(projectId: string): Promise<void> {
    calls.rejectBlueprint += 1;
    await wait();
    requireHomeProjectSkill(projectId);
    state.blueprint = { ...state.blueprint, status: "REJECTED" };
  },

  async acceptTaskDefinition(taskId: string, draft: TaskDefinitionDraft, mode: FixtureMode): Promise<DemoReceipt> {
    calls.acceptTaskDefinition += 1;
    await wait();
    requireHomeTaskSkill(taskId);
    if (mode === "conflict") {
      throw new FixtureError("conflict", "任务版本已变化；你的定义草稿仍保留，请重新核对。");
    }
    state.projectTask = {
      ...state.projectTask,
      definition: copy(draft),
      revision: incrementDecimalRevision(state.projectTask.revision),
      proposalStatus: "APPLIED"
    };
    const summary = taskById(state.projectTask.id);
    if (summary) {
      summary.revision = state.projectTask.revision;
    }
    return {
      commandId: nextCommandId("task-definition"),
      description: `本次演示已接受任务定义并形成 v${state.projectTask.revision} 修订；任务尚未开始，未委托 AI，当前执行者未变。`,
      runStarted: false,
      revision: state.projectTask.revision
    };
  },

  async rejectTaskDefinition(taskId: string): Promise<void> {
    calls.rejectTaskDefinition += 1;
    await wait();
    requireHomeTaskSkill(taskId);
    state.projectTask = { ...state.projectTask, proposalStatus: "REJECTED" };
  },

  async saveVerificationSuggestion(taskId: string, note: string): Promise<DemoReceipt> {
    calls.saveVerificationSuggestion += 1;
    await wait();
    requireHomeTaskSkill(taskId);
    state.verification = {
      ...state.verification,
      savedNote: note,
      proposalVersion: state.verification.proposalVersion + 1
    };
    return {
      commandId: nextCommandId("verification"),
      description: `本次演示已保存为待确认的检查建议 v${state.verification.proposalVersion}；未应用检查计划，未运行任何检查。`,
      runStarted: false,
      revision: String(state.verification.proposalVersion)
    };
  },

  async refreshResume(projectId: string, mode: FixtureMode): Promise<ProjectSnapshot | null> {
    calls.refreshResume += 1;
    await wait();
    throwForUnavailableMode(mode);
    if (mode === "empty" || projectId === "empty") {
      return null;
    }
    state.resumeUpdatedAt = "2026-09-20 10:52";
    if (projectId !== homeProjectId) {
      return null;
    }
    return homeSnapshot(mode);
  },

  async lookupReceipt(commandId: string): Promise<ReceiptLookup> {
    calls.lookupReceipt += 1;
    await wait();
    return receiptFor(commandId);
  },

  /**
   * 返回全部项目（含已归档）。项目页需要同时给出“进行中/已归档”计数，
   * 因此筛选与搜索在页面上按同一份结果进行，避免两个列表不同步。
   */
  async listProjects(mode: FixtureMode): Promise<ProjectSummary[]> {
    calls.listProjects += 1;
    await wait();
    throwForUnavailableMode(mode);
    if (mode === "empty") {
      return [];
    }
    return copy(state.projects);
  },

  async createProject(
    draft: CreateProjectDraft,
    mode: FixtureMode,
    commandId: string
  ): Promise<{ receipt: DemoReceipt; projectId: string; importStatus: "none" | "SUCCEEDED" | "FAILED" }> {
    calls.createProject += 1;
    await wait();
    const existing = receiptFor(commandId);
    if (existing.status === "APPLIED" && existing.operation === "project" && existing.receipt && existing.resourceId && existing.importStatus) {
      return {
        receipt: existing.receipt,
        projectId: existing.resourceId,
        importStatus: existing.importStatus
      };
    }
    if (existing.status === "UNKNOWN") {
      throw new FixtureError("timeout", "本次创建仍在等待回执，请继续使用原 command ID 核对，不要创建第二个项目。");
    }
    if (mode === "conflict") {
      throw new FixtureError("conflict", "同名项目已经存在，草稿已保留；请修改名称后重新提交。");
    }
    if (mode === "timeout") {
      return unknownReceipt(commandId);
    }
    const projectId = `project-demo-${state.projects.filter((item) => item.id.startsWith("project-demo-")).length + 1}`;
    state.projects.push({
      id: projectId,
      title: draft.title.trim(),
      projectType: draft.projectType,
      phase: draft.projectType === "THESIS" ? "TOPIC" : draft.projectType === "DEVELOPMENT" ? "DISCOVERY" : "PLANNING",
      goal: draft.goal.trim(),
      summary: "新建项目，尚未形成当前状态摘要；可先人工补充目标与范围。",
      nextAction: null,
      stateRevision: "1",
      archived: false,
      pendingReviewCount: 0,
      archiveBlockedReason: null
    });
    // 导入是独立的长任务：失败不回滚已创建的项目，只单独呈现导入状态。
    const importStatus = draft.importFileName ? (mode === "import-failed" ? "FAILED" : "SUCCEEDED") : "none";
    const result: { receipt: DemoReceipt; projectId: string; importStatus: "none" | "SUCCEEDED" | "FAILED" } = {
      projectId,
      importStatus,
      receipt: {
        commandId,
        description:
          importStatus === "FAILED"
            ? "本次演示已创建项目（状态 revision 1）；初始资料导入失败，项目仍然保留，可稍后重新导入。"
            : importStatus === "SUCCEEDED"
              ? "本次演示已创建项目（状态 revision 1），并登记一份初始资料；资料导入成功不等于内容已经验证。"
              : "本次演示已创建项目（状态 revision 1）；未导入资料，也未连接模型，可继续人工整理。",
        runStarted: false,
        revision: "1"
      }
    };
    receipts.set(commandId, {
      status: "APPLIED",
      commandId,
      operation: "project",
      resourceId: projectId,
      importStatus,
      receipt: copy(result.receipt)
    });
    if (mode === "response-lost") {
      throw new FixtureError("timeout", "项目已接收，但响应在本次演示中丢失；请使用原 command ID 查询回执。");
    }
    return result;
  },

  async archiveProject(projectId: string, mode: FixtureMode): Promise<DemoReceipt> {
    calls.archiveProject += 1;
    await wait();
    const project = projectById(projectId);
    if (project.archiveBlockedReason) {
      throw new FixtureError("conflict", project.archiveBlockedReason);
    }
    if (mode === "conflict") {
      throw new FixtureError("conflict", "该项目当前仍被引用，归档请求被拒绝；原列表事实保持不变。");
    }
    project.archived = true;
    return {
      commandId: nextCommandId("archive"),
      description: `本次演示已归档“${project.title}”；历史事实保留，可在“已归档”中继续查看。`,
      runStarted: false,
      revision: project.stateRevision
    };
  },

  async listTasks(query: TaskListQuery, mode: FixtureMode): Promise<TaskSummary[]> {
    calls.listTasks += 1;
    await wait();
    throwForUnavailableMode(mode);
    if (mode === "empty") {
      return [];
    }
    return copy(
      state.tasks.filter((task) => {
        if (query.projectId === "inbox" && task.projectId !== null) {
          return false;
        }
        if (query.projectId !== "all" && query.projectId !== "inbox" && task.projectId !== query.projectId) {
          return false;
        }
        if (query.status !== "all" && task.status !== query.status) {
          return false;
        }
        if (query.mode !== "all" && task.mode !== query.mode) {
          return false;
        }
        return matchesQuery(task.title, query.query);
      })
    );
  },

  async loadTaskOptions(mode: FixtureMode): Promise<TaskOptions> {
    calls.loadTaskOptions += 1;
    await wait();
    throwForUnavailableMode(mode);
    return {
      projects: copy(state.projects.filter((project) => !project.archived)),
      candidates: copy(state.tasks.filter((task) => task.projectId !== null))
    };
  },

  async createTask(
    draft: CreateTaskDraft,
    mode: FixtureMode,
    intent: "ready" | "inbox",
    commandId: string
  ): Promise<{ receipt: DemoReceipt; taskId: string; status: TaskStatus; readyBlockedReason: string | null }> {
    calls.createTask += 1;
    await wait();
    const existing = receiptFor(commandId);
    if (existing.status === "APPLIED" && existing.operation === "task" && existing.receipt && existing.resourceId && existing.taskStatus) {
      return {
        receipt: existing.receipt,
        taskId: existing.resourceId,
        status: existing.taskStatus,
        readyBlockedReason: existing.readyBlockedReason ?? null
      };
    }
    if (existing.status === "UNKNOWN") {
      throw new FixtureError("timeout", "本次创建仍在等待回执，请继续使用原 command ID 核对，不要创建第二个任务。");
    }
    if (mode === "conflict") {
      throw new FixtureError("conflict", "任务版本已变化，草稿已保留；请重新核对后提交。");
    }
    if (mode === "timeout") {
      return unknownReceipt(commandId);
    }
    if (draft.title.trim() === "") {
      throw new FixtureError("conflict", "任务名称不能为空，任务未创建。");
    }
    if (draft.projectId !== null) {
      const project = state.projects.find((candidate) => candidate.id === draft.projectId && !candidate.archived);
      if (!project) {
        throw new FixtureError("conflict", "所属项目不存在或已归档，任务未创建。");
      }
    }
    if (draft.dependencyId !== null) {
      const dependency = taskById(draft.dependencyId);
      if (!dependency) {
        throw new FixtureError("conflict", "前置任务不存在，任务未创建。");
      }
      if (dependency.projectId !== draft.projectId) {
        throw new FixtureError("conflict", "前置任务必须与新任务属于同一项目，任务未创建。");
      }
    }

    // CreateTask 固定产生待整理、由我执行的任务；模式与依赖由各自命令单独应用。
    const taskId = `task-demo-${state.tasks.filter((item) => item.id.startsWith("task-demo-")).length + 1}`;
    const dependencyId = draft.dependencyId;
    const task: TaskSummary = {
      id: taskId,
      projectId: draft.projectId,
      title: draft.title.trim(),
      status: "INBOX",
      waitingReason: null,
      blockedReason: null,
      mode: draft.startIntent === "AI_ASSIST" ? "AI_ASSIST" : "ME",
      executor: "HUMAN",
      revision: "0",
      dependencyIds: dependencyId ? [dependencyId] : []
    };
    state.tasks.push(task);

    const notes: string[] = ["本次演示已保存任务，初始状态为待整理，由我执行"];

    if (draft.startIntent === "AI_ASSIST") {
      notes.push("已记录为使用 AI 辅助，当前仍由我执行");
    }
    if (draft.startIntent === "DELEGATE_AI") {
      notes.push("已记录 AI 委托意图；任务尚未达到可委托条件，本次没有变更执行者");
    }
    if (dependencyId) {
      notes.push(`已登记前置任务“${taskById(dependencyId)?.title ?? dependencyId}”`);
    }

    let readyBlockedReason: string | null = null;
    if (intent === "ready") {
      const criteria = parseCriteria(draft.acceptanceCriteria);
      if (draft.projectId === null && draft.startIntent !== "ME") {
        readyBlockedReason = "未归属项目的任务只允许人工事项，不能转为可开始。";
      } else if (criteria.length === 0) {
        readyBlockedReason = "验收标准为空，缺少可判断的完成标准，不能标记为可开始。";
      } else {
        const blocking = task.dependencyIds
          .map((id) => taskById(id))
          .find((candidate): candidate is TaskSummary => candidate !== undefined && candidate.status !== "DONE");
        if (blocking) {
          readyBlockedReason = `前置任务“${blocking.title}”尚未完成，不能转为可开始。`;
        }
      }
      if (readyBlockedReason === null) {
        task.status = "READY";
        task.revision = incrementDecimalRevision(task.revision);
        notes.push("已核对条件并标记为可开始；不会自动开始执行");
      } else {
        notes.push(`条件核对未通过：${readyBlockedReason}任务保持待整理`);
      }
    } else {
      notes.push("按你的选择暂存为待整理，未尝试转为可开始");
    }

    const result: { receipt: DemoReceipt; taskId: string; status: TaskStatus; readyBlockedReason: string | null } = {
      taskId,
      status: task.status,
      readyBlockedReason,
      receipt: {
        commandId,
        description: `${notes.join("；")}。尚未开始执行；当前执行者未变。`,
        runStarted: false,
        revision: task.revision
      }
    };
    receipts.set(commandId, {
      status: "APPLIED",
      commandId,
      operation: "task",
      resourceId: taskId,
      taskStatus: task.status,
      readyBlockedReason,
      receipt: copy(result.receipt)
    });
    if (mode === "response-lost") {
      throw new FixtureError("timeout", "任务已接收，但响应在本次演示中丢失；请使用原 command ID 查询回执。");
    }
    return result;
  },

  /** POST /tasks/{id}/start：仅可开始且无 AI 占有者的任务进入进行中。 */
  async startTask(taskId: string, mode: FixtureMode): Promise<DemoReceipt> {
    calls.startTask += 1;
    await wait();
    const task = taskById(taskId);
    if (!task) {
      throw new FixtureError("load", `示例任务缺失：${taskId}`);
    }
    if (task.status !== "READY" || task.executor === "AI") {
      throw new FixtureError("conflict", "仅“可开始”且没有 AI 占有者的任务可以开始；当前状态不允许。");
    }
    if (mode === "conflict") {
      throw new FixtureError("conflict", "任务事实已更新，草稿与选择保留；请重新核对后再开始。");
    }
    task.status = "IN_PROGRESS";
    task.executor = "HUMAN";
    task.revision = incrementDecimalRevision(task.revision);
    return {
      commandId: nextCommandId("start"),
      description: `本次演示已开始“${task.title}”；开始不等于完成，产物与验收仍需人工提交。`,
      runStarted: false,
      revision: task.revision
    };
  },

  async loadProjectTasks(projectId: string, mode: FixtureMode): Promise<ProjectTasksResult | null> {
    calls.loadProjectTasks += 1;
    await wait();
    throwForUnavailableMode(mode);
    if (mode === "empty" || projectId === "empty") {
      return null;
    }
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      return null;
    }
    const tasks = tasksOfProject(projectId);
    return {
      project: copy(project),
      tasks: copy(tasks),
      dependencies: copy(
        tasks.flatMap((task) => dependencyNotes[task.id] ?? [])
      )
    };
  },

  getCallCount(operation: Operation): number {
    return calls[operation];
  },

  /** 供页壳解析当前路由对应的真实项目/任务名称，找不到时返回 null。 */
  getProjectTitle(projectId: string): string | null {
    return state.projects.find((project) => project.id === projectId)?.title ?? null;
  },

  getTaskTitle(taskId: string): string | null {
    return taskById(taskId)?.title ?? (state.projectTask.id === taskId ? state.projectTask.title : null);
  },

  getNavigationLabels(): { projectName: string; taskTitle: string; pendingReviewCount: number } {
    return {
      projectName: projectById(homeProjectId).title,
      taskTitle: state.projectTask.title,
      pendingReviewCount: projectById(homeProjectId).pendingReviewCount
    };
  }
};

export type FixtureOperation = Operation;

export function resetFixture(): void {
  state = createSeed();
  calls = zeroCalls();
  commandSequence = 0;
  receipts.clear();
}

export function setFixtureLatency(milliseconds: number): void {
  latencyMs = milliseconds;
}
