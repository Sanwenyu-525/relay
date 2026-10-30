import { useEffect, useState } from "react";
import { Check, ChevronDown, Pause, Play, Target, Trash2 } from "lucide-react";

import type { RelayGoalStatus, RelayGoalView } from "../api/relayClient";
import AppDialog from "./AppDialog";
import "./GoalPlanCards.css";

/**
 * 输入框上方的目标单行状态条（工作台 §44.2、0127；2026-10-25 收成单行，参照 Codex）。
 *
 * 呈现口径：
 *   * 状态是**服务端**的状态，不是界面猜测。`PAUSING` 显示「正在暂停」，
 *     因为此刻在途的那一轮还没结束——点了暂停不等于已经停下。
 *   * 只有一种「完成」：`AWAITING_ACCEPTANCE` 时出现「确认完成」。模型说完成不会让条上
 *     变成已完成，条上写的是它给出的证据与还缺什么（展开后可见）。
 *   * 额度耗尽与阻塞各自有具体原因和「继续」；原因来自服务端，展开可见，不是一句「出错了」。
 *   * 「取消目标」是终止性操作（CANCELLED 属于服务端 TERMINAL，没有反向命令），按
 *     工作台 §危险操作的既有裁定走「不可逆族」：就地一个确认框、danger 确认键、无撤销条，
 *     不叠加二次拦截；后果说明在点击前给出，不再只在取消后才解释。
 *   * 内部身份（task_id/run_id/revision）不进日常界面。
 *   * 单行只保留「状态 + 目标 + 轮次/成功条件计数 + 动作」；当前步骤、进展、成功条件、
 *     停止原因、步骤与轮次历史收进展开区。展开是本地视图偏好，不发命令、不进服务端。
 */
const STATUS_LABELS: Record<RelayGoalStatus, string> = {
  ACTIVE: "正在推进",
  PAUSING: "正在暂停",
  PAUSED: "已暂停",
  CANCELLING: "正在取消",
  CANCELLED: "已取消",
  WAITING_USER: "等你决定",
  BLOCKED: "已阻塞",
  BUDGET_EXHAUSTED: "额度耗尽",
  AWAITING_ACCEPTANCE: "等你确认完成",
  COMPLETED: "已完成",
  FAILED: "失败",
};

const STATUS_TONES: Record<string, "neutral" | "busy" | "warning" | "danger" | "success"> = {
  ACTIVE: "busy", PAUSING: "busy", CANCELLING: "busy",
  PAUSED: "neutral", WAITING_USER: "warning", BLOCKED: "warning",
  BUDGET_EXHAUSTED: "warning", AWAITING_ACCEPTANCE: "warning",
  COMPLETED: "success", CANCELLED: "neutral", FAILED: "danger",
};

const CRITERION_LABELS: Record<string, string> = {
  MET: "已达成", UNMET: "未达成", PENDING: "待验证",
};

const ROUND_OUTCOMES: Record<string, string> = {
  CONTINUE: "继续推进", NEEDS_USER: "需要你决定", BLOCKED: "报告阻塞",
  AWAITING_ACCEPTANCE: "自检完成，等待验收", COMPLETE_UNVERIFIED: "声称完成但证据不足",
  NO_STRUCTURE: "没有结构化进展", CANCELLED_ROUND: "这一轮被停止",
  RETRY_SCHEDULED: "暂时失败，已安排重试", BUDGET_EXHAUSTED: "额度耗尽",
};

const LIVE: readonly RelayGoalStatus[] = ["ACTIVE", "PAUSING", "CANCELLING"];

const DETAILS_ID = "goal-card-details";

/** 目标是否还在推进中（决定界面是否继续轮询）。 */
export function goalIsLive(view: RelayGoalView | null): boolean {
  return view?.goal !== null && view?.goal !== undefined && LIVE.includes(view.goal.status);
}

export default function GoalCard({ view, busy, error, onPause, onCancel, onResume, onConfirm }: {
  view: RelayGoalView | null;
  busy: boolean;
  error: string | null;
  onPause: () => void;
  onCancel: () => void;
  onResume: () => void;
  onConfirm: () => void;
}) {
  const goal = view?.goal ?? null;
  /** 取消是终止性的：先 AppDialog 确认（§13.2 无反向命令那一列），确认键才发原命令。 */
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  /** 展开只影响本条事实的可见性，是视图偏好；不发命令，目标切换后不跨目标沿用。 */
  const [expanded, setExpanded] = useState(false);
  const cancelAvailable = goal?.actions.cancel === true;
  const goalId = goal?.goalId ?? null;
  useEffect(() => {
    // 展开属于当前目标的视图偏好：换成另一个目标时回到单行，不沿用上一个目标的展开态。
    setExpanded(false);
  }, [goalId]);
  useEffect(() => {
    // 取消意图已被服务端接受（actions.cancel 收回）或目标换了状态时收起确认框，避免留下悬空弹窗。
    if (!cancelAvailable && confirmingCancel) setConfirmingCancel(false);
  }, [cancelAvailable, confirmingCancel]);
  if (goal === null) return null;
  const done = goal.criteria.filter((item) => item.status === "MET").length;
  const reason = goal.stopReason;
  return <section className="goal-strip" data-testid="goal-card"
    data-status={goal.status} data-expanded={expanded ? "true" : undefined}
    aria-label="目标状态" aria-live="polite">
    <div className="goal-strip-line">
      <button className="goal-strip-toggle" type="button" data-testid="goal-card-toggle"
        aria-expanded={expanded ? "true" : "false"} aria-controls={DETAILS_ID}
        title={expanded ? "收起目标详情" : "展开目标详情"}
        onClick={() => setExpanded((value) => !value)}>
        <Target className="goal-strip-target" aria-hidden="true" />
        <span className={`goal-plan-badge goal-plan-badge--${STATUS_TONES[goal.status] ?? "neutral"} goal-card-status-badge`}
          data-testid="goal-card-status">{STATUS_LABELS[goal.status]}</span>
        <span className="goal-strip-objective" data-testid="goal-card-objective"
          title={goal.objective}>{goal.objective}</span>
        <span className="goal-strip-meta helper-text" data-testid="goal-card-rounds">
          第 {goal.roundCount} 轮{goal.criteria.length > 0 ? ` · 成功条件 ${done}/${goal.criteria.length}` : ""}</span>
        <ChevronDown className="goal-strip-chevron" aria-hidden="true"
          data-expanded={expanded ? "true" : undefined} />
      </button>
      <div className="goal-strip-actions">
        {goal.actions.pause && <button className="goal-strip-action goal-strip-action--icon" type="button"
          data-testid="goal-card-pause" disabled={busy} aria-label="暂停" title="暂停（可随时继续）"
          onClick={onPause}><Pause aria-hidden="true" /></button>}
        {goal.actions.cancel && <button className="goal-strip-action goal-strip-action--icon" type="button"
          data-testid="goal-card-cancel" disabled={busy} aria-label="取消目标" title="取消目标…（终止性操作，先确认）"
          onClick={() => setConfirmingCancel(true)}><Trash2 aria-hidden="true" /></button>}
        {goal.actions.resume && <button className="goal-strip-action goal-strip-action--primary" type="button"
          data-testid="goal-card-resume" data-busy={busy ? "true" : undefined}
          disabled={busy} title={goal.status === "BUDGET_EXHAUSTED" ? "继续（再给一个额度窗口）" : "继续推进"}
          onClick={onResume}><Play aria-hidden="true" />继续</button>}
        {goal.actions.confirmCompletion && <button className="goal-strip-action goal-strip-action--primary" type="button"
          data-testid="goal-card-confirm" disabled={busy} title="确认完成"
          onClick={onConfirm}><Check aria-hidden="true" />确认完成</button>}
      </div>
    </div>
    {error !== null && <p className="action-error" role="alert" data-testid="goal-card-error">{error}</p>}
    {expanded && <div className="goal-strip-details" id={DETAILS_ID} data-testid="goal-card-details">
      <div className="goal-card-row" data-testid="goal-card-objective-full">
        <p className="goal-plan-objective">{goal.objective}</p>
        {goal.planVersion !== null && <p className="goal-plan-detail" data-testid="goal-card-plan-version">
          按第 {goal.planVersion} 版计划</p>}
      </div>
      {(goal.currentStep !== null || goal.progress !== null) && <div className="goal-card-row">
        {goal.currentStep !== null && <p className="goal-card-step" data-testid="goal-card-step">
          <span className="goal-card-step-label">当前步骤</span>{goal.currentStep}</p>}
        {goal.progress !== null && <p className="goal-card-progress" data-testid="goal-card-progress">
          <span className="goal-card-step-label">进展</span>{goal.progress}</p>}
      </div>}
      {reason !== null && <div className="goal-card-row" data-testid="goal-card-reason"
        data-code={reason.code} data-tone={STATUS_TONES[goal.status] ?? "neutral"}>
        <p className="goal-plan-label">停止原因</p>
        <p className={`goal-card-reason-text goal-card-reason-text--${STATUS_TONES[goal.status] ?? "neutral"}`}>
          {reason.detail}</p>
        {reason.questions.length > 0 && <ul className="goal-plan-list">
          {reason.questions.map((item) => <li key={item}>{item}</li>)}
        </ul>}
      </div>}
      {goal.criteria.length > 0 && <div className="goal-card-row" data-testid="goal-card-criteria-group">
        <p className="goal-plan-label">成功条件 · {done}/{goal.criteria.length}</p>
        <ul className="goal-plan-list goal-plan-list--rows" data-testid="goal-card-criteria">
          {goal.criteria.map((item) => <li key={item.key} data-status={item.status}
            data-testid={`goal-criterion-${item.key}`}>
            <span className="goal-card-criterion-status">{CRITERION_LABELS[item.status] ?? item.status}</span>
            <span>{item.statement}</span>
            {(!item.required || item.evidence !== null) && <span className="goal-plan-detail">
              {!item.required ? " · 非必需" : ""}{item.evidence !== null ? ` · 依据：${item.evidence}` : ""}</span>}
          </li>)}
        </ul>
      </div>}
      {goal.steps.length > 0 && <details className="goal-card-disclosure">
        <summary data-testid="goal-card-steps">步骤 {goal.steps.filter((step) => step.status === "DONE").length}
          /{goal.steps.length}</summary>
        <ol className="goal-plan-list goal-plan-list--rows">
          {goal.steps.map((step) => <li key={step.title} data-status={step.status}>
            <span>{step.title}</span><span className="goal-plan-detail"> ·
              {step.status === "DONE" ? "已完成" : step.status === "DOING" ? "进行中" : "待办"}</span>
          </li>)}
        </ol>
      </details>}
      {view !== null && view.rounds.length > 0 && <details className="goal-card-disclosure">
        <summary data-testid="goal-card-history">最近 {view.rounds.length} 轮</summary>
        <ol className="goal-plan-list goal-plan-list--rows" data-testid="goal-card-round-list">
          {view.rounds.map((round) => <li key={round.roundIndex}>
            第 {round.roundIndex} 轮 · {ROUND_OUTCOMES[round.outcome] ?? round.outcome}
            {round.note !== null && <span className="goal-plan-detail"> · {round.note}</span>}
          </li>)}
        </ol>
      </details>}
      <p className="helper-text goal-card-note" data-testid="goal-card-note">
        {goal.status === "CANCELLED"
          ? "取消只停止后续推进，已经发生的修改与外部操作不会回滚。"
          : goal.status === "AWAITING_ACCEPTANCE"
            ? "模型已按成功条件自检；是否完成由你确认。"
            : "关闭页面后目标仍由服务端推进。"}</p>
    </div>}
    <AppDialog open={goal.actions.cancel && confirmingCancel} title="取消这个目标？"
      initialFocusSelector='[data-testid="goal-card-cancel-dismiss"]'
      onClose={() => { if (!busy) setConfirmingCancel(false); }}>
      <p>取消后这个目标不再继续推进，已经发生的修改与外部操作不会回滚，也无法恢复。
        想暂时停下、之后接着推进，请先选「暂停」。</p>
      <div className="dialog-actions">
        <button className="secondary-button" type="button" data-testid="goal-card-cancel-dismiss"
          disabled={busy} onClick={() => setConfirmingCancel(false)}>再想想</button>
        <button className="danger-button" type="button" data-testid="goal-card-cancel-confirm-button"
          disabled={busy} onClick={() => { setConfirmingCancel(false); onCancel(); }}>确认取消目标</button>
      </div>
    </AppDialog>
  </section>;
}
