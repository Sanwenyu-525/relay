import type {
  BlueprintRecord,
  ProjectSummary,
  SourceReference,
  TaskDependencyNote,
  TaskRecord,
  TaskSummary,
  VerificationPlan
} from "../types";

/**
 * 示例事实的唯一来源。全部为演示数据，模块内存状态在刷新后重置，
 * 不使用 localStorage 保存业务事实。
 */
export interface FixtureState {
  projects: ProjectSummary[];
  tasks: TaskSummary[];
  /** 任务定义 Skill 的目标任务；其状态、模式与执行者与 tasks 中同 id 的记录保持一致。 */
  projectTask: TaskRecord;
  blueprint: BlueprintRecord;
  verification: VerificationPlan;
  sources: SourceReference[];
  resumeUpdatedAt: string;
  /** 由蓝图应用创建的收件箱任务，用于恢复摘要区分“新增”和项目原有任务。 */
  blueprintCreatedTaskIds: string[];
  workbench: "通用" | "论文";
}

export const homeProjectId = "project-hci";

export const initialSources: SourceReference[] = [
  {
    id: "project-state-v4",
    title: "项目状态",
    version: "v4",
    kind: "project-state",
    availability: "available",
    excerpt: "当前项目为人工可继续整理的研究工作，没有正在进行的执行，也没有等待执行的委托。"
  },
  {
    id: "task-list-v1",
    title: "当前任务列表",
    version: "v1",
    kind: "task-list",
    availability: "available",
    excerpt: "“确定实验评价指标”处于进行中，执行模式为人工执行，当前执行者是用户本人。"
  },
  {
    id: "literature-review-v3",
    title: "文献综述",
    version: "v3",
    kind: "artifact",
    availability: "available",
    excerpt: "该产物的检查记录已经存在，但尚未形成人工接受的完成依据，因此仍待你判断。"
  },
  {
    id: "acceptance-v2",
    title: "验收标准",
    version: "v2",
    kind: "verification",
    availability: "available",
    excerpt: "必需检查包含语义核对；当前注册表中没有可用的语义核对检查器。"
  },
  {
    id: "research-notes-v2",
    title: "项目研究笔记",
    version: "v2",
    kind: "note",
    availability: "available",
    excerpt: "记录了要比较的协作方式、已选研究资料与初步指标设想。"
  },
  {
    id: "goal-v1",
    title: "项目目标",
    version: "v1",
    kind: "goal",
    availability: "available",
    excerpt: "比较人工执行与 AI 辅助在协作研究中的效果，并形成可复核的评价方式。"
  },
  {
    id: "result-definition-v2",
    title: "结果定义",
    version: "v2",
    kind: "result-definition",
    availability: "available",
    excerpt: "预期结果是一份可复核的实验评价方案，包含指标计算方式与基线步骤。"
  },
  {
    id: "checker-registry-v1",
    title: "当前可用检查器",
    version: "v1",
    kind: "checker-registry",
    availability: "available",
    excerpt: "已登记结构检查与规则核对；语义核对尚无注册检查器，人工判断由你自行确认。"
  },
  {
    id: "review-record-v1",
    title: "待审记录",
    version: "v1",
    kind: "review-record",
    availability: "available",
    excerpt: "文献综述 v3 等待人工接受；待审不会自动批准，也不会改变任务执行权。"
  },
  {
    id: "completion-evidence-v1",
    title: "完成依据",
    version: "v1",
    kind: "evidence",
    availability: "available",
    excerpt: "“明确研究问题”的完成依据包含研究问题说明与其引用来源版本，未包含模型私有推理。"
  }
];

export const initialProjects: ProjectSummary[] = [
  {
    id: homeProjectId,
    title: "人机协作工作流研究",
    projectType: "THESIS",
    phase: "LITERATURE",
    goal: "研究可追溯、可恢复的人与 AI 协作方法",
    summary: "以长期、可持续的人机协作方式开展研究与写作，探索人机协作在复杂知识工作中的方法、实践与评估。",
    nextAction: null,
    stateRevision: "4",
    archived: false,
    pendingReviewCount: 1,
    archiveBlockedReason: null
  },
  {
    id: "project-workflow-os",
    title: "Workflow OS",
    projectType: "DEVELOPMENT",
    phase: "DESIGN",
    goal: "构建面向个人的长期项目工作流系统",
    summary: "构建面向个人的长期项目工作流系统，覆盖任务、产物、验证与恢复。",
    nextAction: "验证人工闭环",
    stateRevision: "7",
    archived: false,
    pendingReviewCount: 0,
    archiveBlockedReason: "该项目仍有正在进行的执行，且一项执行结果尚未确认；先处理这两项再归档。"
  },
  {
    id: "project-knowledge",
    title: "个人知识整理",
    projectType: "GENERAL",
    phase: "EXECUTING",
    goal: "建立可持续的个人知识体系",
    summary: "建立可持续的个人知识体系，让资料、笔记与决定可以长期复用。",
    nextAction: "整理研究笔记",
    stateRevision: "2",
    archived: false,
    pendingReviewCount: 0,
    archiveBlockedReason: null
  },
  {
    id: "project-thesis-topic",
    title: "论文选题调研",
    projectType: "THESIS",
    phase: "REVIEW",
    goal: "确定毕业论文的选题方向",
    summary: "早期选题调研记录，已归档保留历史，不再作为当前工作范围。",
    nextAction: null,
    stateRevision: "9",
    archived: true,
    pendingReviewCount: 0,
    archiveBlockedReason: null
  }
];

export const initialTasks: TaskSummary[] = [
  {
    id: "task-evaluation-metrics",
    projectId: homeProjectId,
    title: "确定实验评价指标",
    status: "IN_PROGRESS",
    waitingReason: null,
    blockedReason: null,
    mode: "ME",
    executor: "HUMAN",
    revision: "1",
    dependencyIds: []
  },
  {
    id: "task-literature-review",
    projectId: homeProjectId,
    title: "完善文献综述",
    status: "WAITING",
    waitingReason: "等待人工接受产物 v3",
    blockedReason: null,
    mode: "DELEGATE_AI",
    executor: "AI",
    revision: "3",
    dependencyIds: []
  },
  {
    id: "task-organize-material",
    projectId: homeProjectId,
    title: "整理实验资料",
    status: "READY",
    waitingReason: null,
    blockedReason: null,
    mode: "AI_ASSIST",
    executor: "HUMAN",
    revision: "1",
    dependencyIds: []
  },
  {
    id: "task-compare-experiment",
    projectId: homeProjectId,
    title: "开始对照实验",
    status: "BLOCKED",
    waitingReason: null,
    blockedReason: "前置任务“确定实验评价指标”尚未完成。",
    mode: "ME",
    executor: "HUMAN",
    revision: "2",
    dependencyIds: ["task-evaluation-metrics"]
  },
  {
    id: "task-recovery-logic",
    projectId: "project-workflow-os",
    title: "修复任务恢复逻辑",
    status: "IN_PROGRESS",
    waitingReason: null,
    blockedReason: null,
    mode: "DELEGATE_AI",
    executor: "AI",
    revision: "5",
    dependencyIds: []
  },
  {
    id: "task-reading-notes",
    projectId: null,
    title: "整理阅读笔记",
    status: "INBOX",
    waitingReason: null,
    blockedReason: null,
    mode: "ME",
    executor: "HUMAN",
    revision: "1",
    dependencyIds: []
  }
];

export const dependencyNotes: Record<string, TaskDependencyNote[]> = {
  "task-compare-experiment": [
    {
      id: "task-evaluation-metrics",
      title: "确定实验评价指标",
      status: "IN_PROGRESS",
      executor: "HUMAN",
      reason: "该任务依赖的前置任务尚未完成。当前尚未确认实验的评价指标，无法确定对照实验的具体方案、数据收集口径与评估方法。",
      downstreamNote: "本任务完成后，将为论文的实验结果与分析提供关键数据支持。"
    }
  ]
};

export function createSeed(): FixtureState {
  return {
    projects: initialProjects.map((project) => ({ ...project })),
    tasks: initialTasks.map((task) => ({ ...task, dependencyIds: [...task.dependencyIds] })),
    projectTask: {
      id: "task-evaluation-metrics",
      title: "确定实验评价指标",
      description: "设计并明确评估协作方式效果的指标体系。",
      revision: "1",
      originalIntent: "想比较不同协作方式的效果。",
      status: "IN_PROGRESS",
      mode: "ME",
      executor: "HUMAN",
      proposalStatus: "PENDING",
      definition: {
        objective: "比较人工执行与 AI 辅助的协作效果。",
        expectedResult: "一份可复核的实验评价方案。",
        acceptanceCriteria: ["指标计算方式明确", "基线步骤可复现", "结果可追溯到原始记录"],
        inputSource: "项目研究笔记 v2",
        suggestedMode: "人工执行，按需 AI 辅助"
      }
    },
    blueprint: {
      id: "proposal-blueprint-v1",
      version: 1,
      baseRevision: "4",
      status: "PENDING",
      draft: {
        nextAction: "整理核心研究问题",
        taskTitles: ["梳理研究问题", "整理参考资料"],
        workbench: "论文"
      }
    },
    verification: {
      id: "verification-plan-v1",
      taskRevision: "1",
      acceptanceRevision: "2",
      proposalVersion: 1,
      savedNote: "",
      checks: [
        { id: "structure", title: "必需章节齐全", method: "结构检查", status: "NOT_RUN", required: true },
        { id: "rules", title: "遵守资料使用约束", method: "规则核对", status: "NOT_RUN", required: true },
        { id: "semantic", title: "论断与来源对应", method: "语义核对", status: "MISSING_CAPABILITY", required: true },
        { id: "human", title: "指标与基线可复现", method: "人工判断", status: "HUMAN_PENDING", required: true }
      ]
    },
    sources: initialSources.map((source) => ({ ...source })),
    resumeUpdatedAt: "2026-09-19 10:45",
    blueprintCreatedTaskIds: [],
    workbench: "通用"
  };
}
