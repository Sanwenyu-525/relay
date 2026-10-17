import type { RelayAssistSourceRef, RelayReview } from "../api/relayClient";
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

export const reviewKindLabels: Record<RelayReview["kind"], string> = {
  CRITERION: "人工验收",
  RETRY_BUDGET: "修正预算",
  CHECKER_RETRY: "检查器重试",
  ACTION_APPROVAL: "动作批准",
  STATE_PROPOSAL: "项目状态提案"
};

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
