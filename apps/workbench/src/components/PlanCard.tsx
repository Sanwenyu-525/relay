import { Download, Play } from "lucide-react";

import type { RelayPlanView } from "../api/relayClient";
import "./GoalPlanCards.css";

/**
 * 会话内计划卡（工作台 §44.1、0127）。
 *
 * 三件事由服务端决定，卡片只呈现：
 *   * **哪一版**：版本号来自服务端按序分配，界面从不按标题或时间匹配；被新版本取代的
 *     旧版明确标注，不因为「看起来差不多」而当最新版。
 *   * **能不能执行**：`onExecute` 把这一版的 plan_id 原样交出去；服务端核对它是否仍是最新，
 *     不是最新时要求再确认一次——卡片不回退成「反正执行最新版」。
 *   * **导出是独立动作**：导出只在用户点它时发生（保存到本机），规划过程中没有任何写项目
 *     的路径。
 */
function planMarkdown(view: RelayPlanView, version: number): string {
  const plan = view.versions.find((item) => item.version === version);
  if (plan === undefined) return "";
  const lines = [`# 计划（第 ${plan.version} 版）`, "", `## 目标`, plan.goal, ""];
  if (plan.scope.length > 0) {
    lines.push("## 范围", ...plan.scope.map((item) => `- ${item}`), "");
  }
  if (plan.steps.length > 0) {
    lines.push("## 步骤", ...plan.steps.map((step, index) =>
      `${index + 1}. ${step.title}${step.detail === null ? "" : ` — ${step.detail}`}`), "");
  }
  if (plan.verification.length > 0) {
    lines.push("## 验证方式", ...plan.verification.map((item) =>
      `- ${item.statement}（${item.method}）`), "");
  }
  if (plan.openQuestions.length > 0) {
    lines.push("## 待定事项", ...plan.openQuestions.map((item) => `- ${item}`), "");
  }
  return `${lines.join("\n")}\n`;
}

export default function PlanCard({ view, busy, error, onExecute, onExport, onDismiss }: {
  view: RelayPlanView | null;
  busy: boolean;
  error: string | null;
  /** 执行某一版：传的是这一版的确切 id，不是「最新」。 */
  onExecute: (planId: string, version: number) => void;
  onExport: (markdown: string, version: number) => void;
  onDismiss: () => void;
}) {
  if (view === null || view.latest === null) return null;
  const plan = view.latest;
  return <section className="goal-plan-card" data-testid="plan-card"
    data-version={plan.version} data-status={plan.status} aria-live="polite">
    <header className="goal-plan-card-head">
      <p className="goal-plan-card-title" data-testid="plan-card-title">
        计划 · 第 {plan.version} 版
        {plan.status === "SUPERSEDED" &&
          <span className="goal-plan-badge" data-testid="plan-card-superseded">已被更新版取代</span>}
      </p>
      <button className="text-button" type="button" data-testid="plan-card-dismiss"
        onClick={onDismiss} title="收起这张卡片；计划本身仍保存在会话里">收起</button>
    </header>
    <p className="goal-plan-objective" data-testid="plan-card-goal">{plan.goal}</p>
    {plan.scope.length > 0 && <div className="goal-plan-block">
      <p className="goal-plan-label">范围</p>
      <ul className="goal-plan-list" data-testid="plan-card-scope">
        {plan.scope.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>}
    {plan.steps.length > 0 && <div className="goal-plan-block">
      <p className="goal-plan-label">步骤 · {plan.steps.length} 步</p>
      <ol className="goal-plan-list" data-testid="plan-card-steps">
        {plan.steps.map((step, index) => <li key={`${index}:${step.title}`}>
          {step.title}{step.detail !== null && <span className="goal-plan-detail"> · {step.detail}</span>}
        </li>)}
      </ol>
    </div>}
    {plan.verification.length > 0 && <div className="goal-plan-block">
      <p className="goal-plan-label">验证方式</p>
      <ul className="goal-plan-list" data-testid="plan-card-verification">
        {plan.verification.map((item) => <li key={item.statement}>
          {item.statement}<span className="goal-plan-detail"> · {item.method}</span>
        </li>)}
      </ul>
    </div>}
    {plan.openQuestions.length > 0 && <div className="goal-plan-block">
      <p className="goal-plan-label">待定事项</p>
      <ul className="goal-plan-list" data-testid="plan-card-questions">
        {plan.openQuestions.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>}
    {view.versions.length > 1 && <details className="goal-plan-history">
      <summary data-testid="plan-card-history">共 {view.versions.length} 版，查看旧版本</summary>
      <ol>
        {view.versions.map((item) => <li key={item.planId} data-testid={`plan-version-${item.version}`}>
          第 {item.version} 版 · {item.status === "CURRENT" ? "当前版本" : "已被取代"} · {item.goal}
        </li>)}
      </ol>
    </details>}
    {error !== null && <p className="action-error" role="alert" data-testid="plan-card-error">{error}</p>}
    <div className="goal-plan-actions">
      <button className="primary-button" type="button" data-testid="plan-card-execute"
        data-busy={busy ? "true" : undefined} disabled={busy}
        onClick={() => onExecute(plan.planId, plan.version)}>
        <Play aria-hidden="true" />按此计划执行</button>
      <button className="secondary-button" type="button" data-testid="plan-card-export"
        disabled={busy}
        onClick={() => onExport(planMarkdown(view, plan.version), plan.version)}>
        <Download aria-hidden="true" />导出为文件</button>
      <span className="helper-text">想改计划就直接说改哪一条；会形成新的一版，旧版仍然可查。</span>
    </div>
  </section>;
}
