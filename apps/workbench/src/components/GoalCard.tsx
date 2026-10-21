import type { RelayGoalStatus, RelayGoalView } from "../api/relayClient";
import "./GoalPlanCards.css";

/**
 * 会话内的固定目标卡（工作台 §44.2、0127）。
 *
 * 呈现口径：
 *   * 状态是**服务端**的状态，不是界面猜测。`PAUSING` 显示「正在安全停止在途行动」，
 *     因为此刻在途的那一轮还没结束——点了暂停不等于已经停下。
 *   * 只有一种「完成」：`AWAITING_ACCEPTANCE` 时出现「确认完成」。模型说完成不会让卡片
 *     变成已完成，卡片上写的是它给出的证据与还缺什么。
 *   * 额度耗尽与阻塞各自有具体原因和「继续」；原因来自服务端，不是一句「出错了」。
 *   * 内部身份（task_id/run_id/revision）不进日常界面。
 */
const STATUS_LABELS: Record<RelayGoalStatus, string> = {
  ACTIVE: "正在推进",
  PAUSING: "正在安全停止在途行动",
  PAUSED: "已暂停",
  CANCELLING: "正在取消，等待在途动作结束",
  CANCELLED: "已取消",
  WAITING_USER: "等你决定",
  BLOCKED: "已阻塞",
  BUDGET_EXHAUSTED: "额度耗尽，进度已保存",
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
  if (goal === null) return null;
  const done = goal.criteria.filter((item) => item.status === "MET").length;
  const reason = goal.stopReason;
  return <section className="goal-plan-card goal-card" data-testid="goal-card"
    data-status={goal.status} aria-live="polite">
    <header className="goal-plan-card-head">
      <p className="goal-plan-card-title" data-testid="goal-card-title">
        目标
        <span className={`goal-plan-badge goal-plan-badge--${STATUS_TONES[goal.status] ?? "neutral"}`}
          data-testid="goal-card-status">{STATUS_LABELS[goal.status]}</span>
        {goal.planVersion !== null && <span className="goal-plan-badge"
          data-testid="goal-card-plan-version">按第 {goal.planVersion} 版计划</span>}
      </p>
      <span className="helper-text" data-testid="goal-card-rounds">
        第 {goal.roundCount} 轮{goal.criteria.length > 0
          ? ` · 成功条件 ${done}/${goal.criteria.length}` : ""}</span>
    </header>
    <p className="goal-plan-objective" data-testid="goal-card-objective">{goal.objective}</p>
    {goal.currentStep !== null && <p className="goal-card-step" data-testid="goal-card-step">
      当前步骤：{goal.currentStep}</p>}
    {goal.progress !== null && <p className="helper-text" data-testid="goal-card-progress">
      {goal.progress}</p>}
    {reason !== null && <div className={`goal-card-reason goal-card-reason--${STATUS_TONES[goal.status] ?? "neutral"}`}
      data-testid="goal-card-reason" data-code={reason.code}>
      <p>{reason.detail}</p>
      {reason.questions.length > 0 && <ul>
        {reason.questions.map((item) => <li key={item}>{item}</li>)}
      </ul>}
    </div>}
    {goal.criteria.length > 0 && <div className="goal-plan-block">
      <p className="goal-plan-label">成功条件</p>
      <ul className="goal-plan-list" data-testid="goal-card-criteria">
        {goal.criteria.map((item) => <li key={item.key} data-status={item.status}
          data-testid={`goal-criterion-${item.key}`}>
          <span className="goal-card-criterion-status">{CRITERION_LABELS[item.status] ?? item.status}</span>
          {item.statement}
          {!item.required && <span className="goal-plan-detail"> · 非必需</span>}
          {item.evidence !== null && <span className="goal-plan-detail"> · 依据：{item.evidence}</span>}
        </li>)}
      </ul>
    </div>}
    {goal.steps.length > 0 && <details className="goal-card-details">
      <summary data-testid="goal-card-steps">步骤 {goal.steps.filter((step) => step.status === "DONE").length}
        /{goal.steps.length}</summary>
      <ol className="goal-plan-list">
        {goal.steps.map((step) => <li key={step.title} data-status={step.status}>
          {step.title}<span className="goal-plan-detail"> · {step.status === "DONE" ? "已完成"
            : step.status === "DOING" ? "进行中" : "待办"}</span>
        </li>)}
      </ol>
    </details>}
    {view !== null && view.rounds.length > 0 && <details className="goal-card-details">
      <summary data-testid="goal-card-history">最近 {view.rounds.length} 轮</summary>
      <ol className="goal-plan-list" data-testid="goal-card-round-list">
        {view.rounds.map((round) => <li key={round.roundIndex}>
          第 {round.roundIndex} 轮 · {ROUND_OUTCOMES[round.outcome] ?? round.outcome}
          {round.note !== null && <span className="goal-plan-detail"> · {round.note}</span>}
        </li>)}
      </ol>
    </details>}
    {error !== null && <p className="action-error" role="alert" data-testid="goal-card-error">{error}</p>}
    <div className="goal-plan-actions">
      {goal.actions.pause && <button className="secondary-button" type="button"
        data-testid="goal-card-pause" disabled={busy} onClick={onPause}>暂停</button>}
      {goal.actions.cancel && <button className="secondary-button" type="button"
        data-testid="goal-card-cancel" disabled={busy} onClick={onCancel}>取消目标</button>}
      {goal.actions.resume && <button className="primary-button" type="button"
        data-testid="goal-card-resume" data-busy={busy ? "true" : undefined}
        disabled={busy} onClick={onResume}>
        {goal.status === "BUDGET_EXHAUSTED" ? "继续（再给一个额度窗口）" : "继续"}</button>}
      {goal.actions.confirmCompletion && <button className="primary-button" type="button"
        data-testid="goal-card-confirm" disabled={busy} onClick={onConfirm}>确认完成</button>}
      <span className="helper-text" data-testid="goal-card-note">
        {goal.status === "CANCELLED"
          ? "取消只停止后续推进，已经发生的修改与外部操作不会回滚。"
          : goal.status === "AWAITING_ACCEPTANCE"
            ? "模型已按成功条件自检；是否完成由你确认。"
            : "关闭页面后目标仍由服务端推进。"}</span>
    </div>
  </section>;
}
