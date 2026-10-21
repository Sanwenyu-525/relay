import type { RelayActivityItem, RelayActivityRefKind, RelayAssistSourceRef, RelayInterventionItem, RelayReview } from "../api/relayClient";
import type { ExecutorKind, InteractionMode, ProjectType, TaskStatus } from "../types";

/**
 * 业务枚举的中文显示文案。枚举值本身以契约为准，展示文案只在这一处维护，
 * 避免同一状态在不同页面出现不同写法。
 */

/** 可被引用的资料类别（「+」菜单与资料选择器共用同一份文案）。 */
export const assistSourceKindLabels: Record<RelayAssistSourceRef["kind"], string> = {
  KNOWLEDGE: "知识",
  MEMORY: "记忆",
  DECISION: "决定"
};

/**
 * 网关连接能力族的中文显示名（「+」菜单的连接器二级、连接与同步页共用同一份）。
 * 清单本身来自服务端的连接登记，这里只维护「能力键 → 名称」映射；
 * 服务端开放扩展的新能力键回退显示原始键，不会被前端词表挡住。
 */
const gatewayCapabilityLabelsKnown: Readonly<Record<string, string>> = {
  FAKE_WRITE: "演示写入",
  FAKE_PUBLIC_READ: "演示公网读取",
  FILE_READ: "文件读取",
  FILE_QUERY: "文件检索",
  FILE_WRITE: "文件写入",
  WEB_FETCH: "网页抓取",
  GIT_READ: "Git 读取",
  GIT_WRITE: "Git 写入",
  CLI_RUN: "命令行执行",
  COMPUTER_READ: "电脑查看（截图/窗口）",
  COMPUTER_INPUT: "电脑操作（鼠标/键盘）",
  GITHUB_READ: "GitHub 只读（仓库/PR/Issue）",
  BROWSER_READ: "浏览器读取（页面/快照）",
  BROWSER_ACTION: "浏览器操作（点击/填写）",
  BROWSER_COMMIT: "浏览器提交（表单/上传）"
};

export function gatewayCapabilityLabel(capability: string): string {
  return gatewayCapabilityLabelsKnown[capability] ?? capability;
}

export const reviewKindLabels: Record<RelayReview["kind"], string> = {
  CRITERION: "人工验收",
  RETRY_BUDGET: "修正预算",
  CHECKER_RETRY: "检查器重试",
  ACTION_APPROVAL: "动作批准",
  STATE_PROPOSAL: "项目状态提案"
};

/**
 * Review 的「为什么」。服务端开放扩展原因键，认不出的键原样显示，不编一句中文盖过去。
 * 定义原先在 ReviewDecisionPanel 里，2026-10-21 第三轮 R3-03 移到这里：待处理队列与顶栏
 * 通知弹层也要同一份读法，展示文案继续只在一处维护。
 */
const reviewReasonLabels: Record<string, string> = {
  CORRECTION_BUDGET_EXHAUSTED: "修正预算已用尽，需要你决定是否增加上限。",
  CHECKER_UNAVAILABLE: "检查器持续不可用，需要你决定是否重新运行检查。",
  AWAITING_HUMAN_EVIDENCE: "必需验收条件需要你的判断。",
  UNCERTAIN_REQUIRES_HUMAN: "检查结果不确定，需要你判断这项验收条件。"
};

export function reviewReasonText(reason: string): string { return reviewReasonLabels[reason] ?? reason; }

/**
 * 「必须介入」事项的原因行。服务端对 Review 类事项把它拼成 `类型：原因` 两个枚举，
 * 直接显示等于让用户读代码。两端都认得才翻译；任一端认不出就原样保留，不猜一个说法。
 */
export function interventionReasonText(item: RelayInterventionItem): string {
  if (item.kind !== "REVIEW") return item.reason;
  const separator = item.reason.indexOf("：");
  if (separator < 0) return item.reason;
  const kind = item.reason.slice(0, separator);
  const reason = item.reason.slice(separator + 1);
  if (!Object.hasOwn(reviewKindLabels, kind) || !Object.hasOwn(reviewReasonLabels, reason)) return item.reason;
  return `${reviewKindLabels[kind as RelayReview["kind"]]} · ${reviewReasonLabels[reason]}`;
}

export const projectTypeLabels: Record<ProjectType, string> = {
  GENERAL: "通用",
  THESIS: "论文",
  DEVELOPMENT: "开发"
};

export const taskStatusLabels: Record<TaskStatus, string> = {
  INBOX: "待整理",
  READY: "可开始",
  IN_PROGRESS: "进行中",
  WAITING: "待人工验收",
  BLOCKED: "阻塞",
  DONE: "已完成",
  CANCELLED: "已取消"
};

export const interactionModeLabels: Record<InteractionMode, string> = {
  ME: "人工执行",
  AI_ASSIST: "AI 辅助",
  DELEGATE_AI: "AI 委托"
};

export const executorLabels: Record<ExecutorKind, string> = {
  HUMAN: "我",
  AI: "AI"
};

/** 验收条件的验证方式。服务端枚举开放扩展，未知值回退为原枚举展示。 */
const criterionMethodRecords: Record<string, string> = {
  HUMAN: "人工核对",
  AUTO: "自动检查",
  MARKDOWN_STRUCTURE: "文档结构检查",
  CITATION_EXISTS: "引用存在检查",
  SEMANTIC: "语义检查"
};

export function criterionMethodLabel(method: string): string {
  return criterionMethodRecords[method] ?? method;
}

/** 验收方案来源；原枚举以 title/small 呈现供核对。 */
export const acceptanceSourceLabels: Record<string, string> = {
  CREATE: "创建时生成",
  CONTRACT_CHANGE: "契约变更",
  HUMAN: "人工制定"
};

/** 可用性枚举（检查计划预览、完成凭据各来源共用）。 */
export const availabilityLabels: Record<string, string> = {
  AVAILABLE: "可用",
  UNAVAILABLE: "不可用"
};

export function availabilityLabel(value: string | null | undefined): string {
  return value === null || value === undefined ? "不可用" : availabilityLabels[value] ?? value;
}

/** Run 逐条件检查结果；未知值回退为原枚举展示。 */
export const checkResultLabels: Record<string, string> = {
  PASS: "通过",
  FAIL: "未通过",
  ERROR: "执行出错"
};

export function checkResultLabel(value: string): string {
  return checkResultLabels[value] ?? value;
}

/** 阶段词汇按 Project Type 分组，用户显式设置，系统不按任务数量自动跳阶段。 */
export const phaseLabels: Record<string, string> = {
  GENERAL: "通用阶段",
  PLANNING: "规划",
  EXECUTING: "执行",
  REVIEW: "评审",
  TOPIC: "选题",
  LITERATURE: "文献研究",
  METHOD: "方法",
  EXPERIMENT: "实验",
  WRITING: "写作",
  DISCOVERY: "探索",
  DESIGN: "设计",
  IMPLEMENTATION: "实现",
  VALIDATION: "验证",
  RELEASE: "发布"
};

export function phaseLabel(phase: string): string {
  return phaseLabels[phase] ?? phase;
}

/* ── 自然语言状态维护（总纲 §0.8.1）────────────────────────────
   服务端枚举开放扩展：未知值一律回退原枚举展示，原值经 title 保留供核对。 */

/** 状态维护请求状态。 */
const stateMaintenanceStatusRecords: Record<string, string> = {
  INTERPRETING: "正在解释",
  DISCUSSED: "已整理",
  CLARIFY: "待澄清",
  READY: "已就绪",
  APPLYING: "正在生效",
  APPLIED: "已生效",
  PARTIAL: "部分生效",
  FAILED: "未生效",
  DECISION_REQUIRED: "需要决定",
  DECLINED: "按决定未执行",
  UNDOING: "正在撤回",
  UNDONE: "已撤回",
  UNDO_PARTIAL: "部分撤回",
  UNDO_BLOCKED: "撤回受阻"
};

export function stateMaintenanceStatusLabel(value: string): string {
  return stateMaintenanceStatusRecords[value] ?? value;
}

/** 状态维护变更种类（migration 0062 词表；新增种类回退原枚举展示）。 */
const stateMaintenanceChangeKindRecords: Record<string, string> = {
  CREATE_GOAL: "新建目标",
  LINK_GOAL: "关联目标",
  CREATE_KNOWLEDGE: "新增知识",
  VERSION_KNOWLEDGE: "新增知识版本",
  CREATE_DECISION: "记录决策",
  CREATE_TASK: "新建任务",
  ADD_TASK_DEPENDENCY: "新增任务依赖",
  SET_NEXT_ACTION: "设置下一步",
  SET_PHASE: "设置阶段",
  ADD_BLOCKER: "登记阻塞",
  RESOLVE_BLOCKER: "解除阻塞",
  SET_TASK_PLANNING: "调整优先级/截止日期",
  SYNC_EXTERNAL_RESULT: "核对外部成果",
  COMPLETE_TASK: "完成并接受任务",
  UNDO_STATE_CHANGE: "撤回上次调整"
};

export function stateMaintenanceChangeKindLabel(value: string): string {
  return stateMaintenanceChangeKindRecords[value] ?? value;
}

/** 逐条变更的结算状态。 */
const stateMaintenanceChangeStatusRecords: Record<string, string> = {
  PENDING: "待生效",
  APPLIED: "已生效",
  FAILED: "失败",
  SKIPPED: "已跳过",
  DECLINED: "按你的决定未执行",
  COMPENSATED: "已撤回",
  COMPENSATION_FAILED: "撤回失败"
};

export function stateMaintenanceChangeStatusLabel(value: string): string {
  return stateMaintenanceChangeStatusRecords[value] ?? value;
}

/**
 * 状态语气只映射到 token 已有的成功/警告/危险/中性四类。
 * 工作状态不用成功色表达，只有 DONE 属于完成；可开始与进行中保持中性，
 * 由图标与文字区分，不靠颜色单独承载语义。
 */
export type StatusTone = "neutral" | "success" | "warning" | "danger";

export function taskStatusTone(status: TaskStatus): StatusTone {
  switch (status) {
    case "DONE":
      return "success";
    case "WAITING":
    case "BLOCKED":
      return "warning";
    case "CANCELLED":
      return "danger";
    default:
      return "neutral";
  }
}

/**
 * 活动流展示文案（协作页首屏「最近动态」与 ActivityView 共用，单一来源）。
 * 枚举值本身以契约为准，展示文案只在这一处维护。
 */

/** 单用户本机应用：人工动作以「我」呈现，与服务端 actor_kind=HUMAN 对应；不显示原始 actor_ref。 */
export const activityActorLabels: Record<RelayActivityItem["actorKind"], string> = { HUMAN: "我", AI: "AI", SYSTEM: "系统" };

/**
 * 事件类型 → 前端自己的读法。只在服务端摘要为哨兵「业务事件」时启用（见 activity-queries 的
 * SUMMARY：服务端没写过的类型才返回它）。
 *
 * 2026-10-20 第五轮：这张表和服务端 SUMMARY 各覆盖一半，重叠处还各写一套中文，任何一边没
 * 收的类型都会掉到「未识别的事件」——真实发生的动作读成界面错误，多条同类在「最近动态」里
 * 排成一模一样的占位行（用户截图指认）。现在按服务端同一份 literal 集补满，两边措辞一致；
 * 仍然不认识时不编造动作名，如实降级（见 activityEventLabel）。
 */
const activityEventTypeLabels: Record<string, string> = {
  WORKSPACE_INITIALIZED: "创建工作区", GOAL_CREATED: "创建目标", GOAL_UPDATED: "修改目标", GOAL_ARCHIVED: "归档目标",
  PROJECT_CREATED: "创建项目", PROJECT_STATE_UPDATED: "更新项目状态", PROJECT_ARCHIVED: "归档项目",
  PROJECT_UNARCHIVED: "取消归档项目", PROJECT_PRESENTATION_UPDATED: "修改项目名称",
  PROJECT_GOAL_LINKED: "项目关联目标", PROJECT_GOAL_UNLINKED: "项目解除目标关联",
  PROJECT_RETURN_REVIEWED: "查看项目接续变化", PROJECT_DAILY_VIEW_CONFIRMED: "确认项目当日进展",
  PROJECT_DAILY_VIEW_BASELINE_REPAIRED: "重算项目当日基线", PROJECT_CONTINUATION_POINT_CAPTURED: "记录项目接续点",
  PROJECT_REMINDER_TRIGGERED: "触发项目提醒", PROJECT_REMINDER_RESOLVED: "处理项目提醒",
  PROJECT_BLUEPRINT_PROPOSED: "提出项目蓝图", PROJECT_BLUEPRINT_APPLIED: "应用项目蓝图", PROJECT_BLUEPRINT_REJECTED: "拒绝项目蓝图",
  TASK_CREATED: "创建任务", TASK_UPDATED: "更新任务", TASK_PRESENTATION_UPDATED: "修改任务", TASK_PROJECT_ASSIGNED: "归入项目",
  TASK_ACCEPTANCE_CHANGED: "修改验收条件", TASK_PLANNING_UPDATED: "修改任务计划",
  TASK_ACCEPTANCE_MATERIAL_ATTACHED: "附上验收材料", TASK_ACCEPTANCE_MATERIAL_WITHDRAWN: "撤回验收材料",
  TASK_GOAL_ALIGNMENT_CHANGED: "修改任务目标对齐", TASK_DEPENDENCY_ADDED: "添加任务依赖", TASK_DEPENDENCY_REMOVED: "移除任务依赖",
  TASK_STARTED: "开始任务", TASK_DELEGATED: "委托任务", TASK_READY: "任务进入可执行", TASK_READIED: "任务进入可执行",
  TASK_CANCELLED: "取消任务", TASK_COMPLETED: "完成任务", TASK_REOPENED: "重开任务",
  SCHEDULED_TASK_OCCURRENCE_RESOLVED: "处理定时任务这一次执行",
  DELEGATION_CREATED: "委托 AI 执行", RUN_CREATED: "创建 Run", RUN_FINISHED: "Run 结束", RUN_FAILED: "运行失败",
  RUN_WAITING_TOOL_LOOP: "Run 等待工具结果", RUN_WORKER_FENCED: "Run 被 fencing 拦下", RUN_OWNERSHIP_MISMATCH: "Run 归属不符",
  RUN_GRAPH_LAYOUT_REBUILT: "重排 Run 图", STEP_ATTEMPT_RESULT_REJECTED_STALE: "丢弃过期的步骤结果",
  ARTIFACT_VERSION_SAVED: "保存产物版本", ARTIFACT_VERSION_SELECTED: "选用产物版本",
  ACCEPTANCE_COMPARISON_FROZEN: "冻结验收比对", FILE_WRITE_MANUALLY_CLOSED: "手动结束文件写入",
  REVIEW_REQUESTED: "请求人工判断", REVIEW_DECIDED: "作出审批决定",
  VERIFICATION_COMPLETED: "验证完成", VERIFICATION_FINALIZED: "检查已结算",
  DECISION_REVIEW_PREPARED: "准备决策审阅", DECISION_PREMISE_REGISTERED: "登记决策前提", DECISION_REVIEW_RESOLVED: "了结决策审阅",
  RUN_CONTROL_REQUESTED: "请求运行控制", RUN_CONTROL_APPLIED: "运行控制已应用",
  CONVERSATION_STATE_REQUESTED: "提交状态维护请求", CONVERSATION_STATE_APPLIED: "应用状态维护",
  CONVERSATION_STATE_DECISION_ANSWERED: "回答状态维护提问", CONVERSATION_STATE_WITHDRAWN: "撤回状态维护请求",
  CONVERSATION_EXECUTION_REQUESTED: "提交执行请求", CONVERSATION_EXTERNAL_CHECKED: "核对讨论依赖的外部事实",
  ASSIST_SESSION_DELETED: "删除讨论", MEMORY_SAVED_FROM_MESSAGE: "从消息保存记忆",
  MEMORY_AUTO_CAPTURED: "自动记下记忆", MEMORY_AUTO_CAPTURE_ROUND: "自动记忆这一轮", MEMORY_AUTO_CAPTURE_RETIRED: "停用自动记忆",
  TODAY_TASK_SELECTION_CHANGED: "修改任务选择", TODAY_FOCUS_CHANGED: "修改当日焦点", VIEW_CONFIGURATION_CHANGED: "修改视图配置"
};

/**
 * 不认识的事件类型：不编造一个动作名。带上原始类型（display: 数据本身就是依据），
 * 让人知道「这一条服务端记过、只是界面对不上」，而不是读成一次界面错误（2026-10-20
 * 第五轮：上一版写「未识别的事件」，四条同类排成一模一样的占位行）。
 */
export function activityEventLabel(eventType: string): string {
  return Object.hasOwn(activityEventTypeLabels, eventType) ? activityEventTypeLabels[eventType]!
    : `其他事件（${eventType}）`;
}

export function activityEventSummary(item: RelayActivityItem): string {
  return item.summary === "业务事件" ? activityEventLabel(item.eventType) : item.summary;
}

export const activityRefLabels: Record<RelayActivityRefKind, string> = {
  PROJECT: "项目", TASK: "任务", RUN: "Run", GOAL: "目标", ARTIFACT_VERSION: "产物版本",
  REVIEW: "Review", COMPLETION: "完成凭据", VERIFICATION_SESSION: "验证会话"
};

export const activityRefLinkLabels: Partial<Record<RelayActivityRefKind, string>> = {
  PROJECT: "打开项目", TASK: "打开关联任务", RUN: "查看执行记录", ARTIFACT_VERSION: "查看产物来源链",
  REVIEW: "查看审批请求", COMPLETION: "查看完成凭据"
};

export function activityRefTarget(kind: RelayActivityRefKind, id: string): string | null {
  if (kind === "PROJECT") return `/projects/${id}`;
  if (kind === "TASK") return `/tasks/${id}`;
  if (kind === "RUN") return `/runs/${id}`;
  if (kind === "REVIEW") return `/reviews?id=${id}`;
  if (kind === "ARTIFACT_VERSION") return `/artifact-versions/${id}/lineage`;
  if (kind === "COMPLETION") return `/completion-records/${id}`;
  return null;
}

// 类别只依据已知的确切 event_type，不从名称前缀或模型输出推断成功。
export type ActivityEventCategory = "approval" | "verification" | "execution" | "artifact" | "completion" | "state" | "unknown";

const activityCategoryByEvent: Record<string, ActivityEventCategory> = {
  REVIEW_DECIDED: "approval", REVIEW_REQUESTED: "approval",
  VERIFICATION_COMPLETED: "verification", VERIFICATION_FINALIZED: "verification",
  ARTIFACT_VERSION_SAVED: "artifact", ARTIFACT_VERSION_SELECTED: "artifact", TASK_COMPLETED: "completion",
  DELEGATION_CREATED: "execution", TASK_DELEGATED: "execution", RUN_CREATED: "execution", RUN_FINISHED: "execution",
  RUN_FAILED: "execution", RUN_CONTROL_REQUESTED: "execution", RUN_CONTROL_APPLIED: "execution",
  CONVERSATION_EXECUTION_REQUESTED: "execution", TASK_STARTED: "execution"
};

export const activityCategoryMeta: Record<ActivityEventCategory, { chip: string; chipShort: string; tone: "neutral" | "warning" | "success"; note: string }> = {
  approval: { chip: "人工判断", chipShort: "决策", tone: "neutral", note: "这是人工判断的请求或决定记录，请以确切事件为准。批准只针对当时的具体动作或版本，不代表相关动作已经执行成功，也不等于任务完成。" },
  verification: { chip: "检查", chipShort: "检查", tone: "neutral", note: "检查结算不表示通过；判定须核对相应版本与条件。检查通过不等于任务完成，仍需核对其他必需条件。" },
  execution: { chip: "执行", chipShort: "执行", tone: "neutral", note: "这是执行请求、委托或运行控制记录，请以确切事件为准。请求或运行结束不表示执行成功，也不等于任务完成。" },
  artifact: { chip: "产物", chipShort: "产物", tone: "neutral", note: "这是服务端记录的一次产物变化，与人工批准、验证判定是分开的独立事实。" },
  completion: { chip: "完成", chipShort: "完成", tone: "success", note: "这是当时提交的任务完成事实，确切产物与条件以完成凭据为准；当前状态仍需打开任务核对。" },
  state: { chip: "项目与任务", chipShort: "项目", tone: "neutral", note: "这是项目、任务或工作空间的操作记录，不据此推断执行结果或验收状态。" },
  unknown: { chip: "未分类", chipShort: "其他", tone: "neutral", note: "当前界面尚未识别此事件类型，不能据此判断成功或完成。原始类型与服务端摘要保留在依据中。" }
};

export function activityEventCategory(eventType: string): ActivityEventCategory {
  return Object.hasOwn(activityCategoryByEvent, eventType) ? activityCategoryByEvent[eventType]!
    : Object.hasOwn(activityEventTypeLabels, eventType) ? "state" : "unknown";
}
