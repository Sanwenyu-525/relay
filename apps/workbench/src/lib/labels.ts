import type { RelayReview } from "../api/relayClient";
import type { ExecutorKind, InteractionMode, ProjectType, TaskStatus } from "../types";

/**
 * 业务枚举的中文显示文案。枚举值本身以契约为准，展示文案只在这一处维护，
 * 避免同一状态在不同页面出现不同写法。
 */

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

/** 阶段词汇按 Project Type 分组，用户显式设置，系统不按任务数量自动跳阶段。 */
export const phaseLabels: Record<string, string> = {
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
