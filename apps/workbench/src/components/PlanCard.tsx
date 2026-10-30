import { useEffect, useId, useState } from "react";
import { ChevronDown, Copy, Play } from "lucide-react";

import type { RelayAssistPlan, RelayPlanView } from "../api/relayClient";
import "./GoalPlanCards.css";

/**
 * 会话内计划卡（工作台 §44.1、0127）。
 *
 * 三件事由服务端决定，卡片只呈现：
 *   * **哪一版**：版本号来自服务端按序分配，界面从不按标题或时间匹配；被新版本取代的
 *     旧版明确标注，不因为「看起来差不多」而当最新版。
 *   * **能不能执行**：`onExecute` 把这一版的 plan_id 原样交出去；服务端核对它是否仍是最新，
 *     不是最新时要求再确认一次——卡片不回退成「反正执行最新版」。
 *   * **复制是独立动作**：复制只在用户点它时把这一版 Markdown 放进剪贴板；规划过程中
 *     没有任何写项目的路径，也不假装已经导出文件。
 *
 * 默认先给一份紧凑摘要：标题与确切版本、计划目标、前三个步骤、验证标准，以及
 * 「展开详情」「按此计划执行」。步骤超过三个时用「查看全部 N 步」展开；
 * 没有结构化步骤时明确说「尚未形成」，不生成虚假清单。
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

const PREVIEW_STEPS = 3;

function PlanSteps({ plan, testId }: { plan: RelayAssistPlan; testId: string }) {
  if (plan.steps.length === 0) {
    return <p className="helper-text goal-plan-empty" data-testid={`${testId}-empty`}>
      计划里还没有结构化步骤，先继续讨论要让 Agent 做哪几步。</p>;
  }
  return <ol className="goal-plan-steps" data-testid={testId}>
    {plan.steps.map((step, index) => <li key={`${index}:${step.title}`}>
      <span className="goal-plan-step-index">{index + 1}</span>
      <span className="goal-plan-step-text">
        <span className="goal-plan-step-title">{step.title}</span>
        {step.detail !== null && <span className="goal-plan-step-detail">{step.detail}</span>}
      </span>
    </li>)}
  </ol>;
}

export default function PlanCard({ view, busy, error, onExecute, onCopy, onDismiss }: {
  view: RelayPlanView | null;
  busy: boolean;
  error: string | null;
  /** 执行某一版：传的是这一版的确切 id，不是「最新」。 */
  onExecute: (planId: string, version: number) => void;
  /** 复制这一版的 Markdown；不写文件、不替代导出。 */
  onCopy: (markdown: string, version: number) => void;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const planId = view?.latest?.planId ?? null;
  useEffect(() => {
    // 新版本到来时回到摘要：展开状态属于上一版，不跨版本沿用。
    setExpanded(false);
  }, [planId]);
  if (view === null || view.latest === null) return null;
  const plan = view.latest;
  const hiddenSteps = plan.steps.length - PREVIEW_STEPS;
  const preview = plan.steps.slice(0, PREVIEW_STEPS);
  return <section className="goal-plan-card" data-testid="plan-card"
    data-version={plan.version} data-status={plan.status}
    data-expanded={expanded ? "true" : undefined} aria-live="polite">
    <header className="goal-plan-card-head">
      <p className="goal-plan-card-title" data-testid="plan-card-title">
        计划 · 第 {plan.version} 版
        <span className="goal-plan-badge goal-plan-badge--neutral" data-testid="plan-card-version-status">
          {plan.status === "CURRENT" ? "当前版本" : "已被更新版取代"}</span>
      </p>
      <button className="text-button goal-plan-card-dismiss" type="button" data-testid="plan-card-dismiss"
        onClick={onDismiss} title="收起这张卡片；计划本身仍保存在会话里">收起卡片</button>
    </header>
    <p className="goal-plan-objective" data-testid="plan-card-goal" title={plan.goal}>{plan.goal}</p>
    {preview.length > 0
      ? <ol className="goal-plan-steps" data-testid="plan-card-steps">
          {preview.map((step, index) => <li key={`${index}:${step.title}`}>
            <span className="goal-plan-step-index">{index + 1}</span>
            <span className="goal-plan-step-text">
              <span className="goal-plan-step-title">{step.title}</span>
              {step.detail !== null && <span className="goal-plan-step-detail">{step.detail}</span>}
            </span>
          </li>)}
        </ol>
      : <p className="helper-text goal-plan-empty" data-testid="plan-card-no-steps">
          计划里还没有结构化步骤，先继续讨论要让 Agent 做哪几步。</p>}
    <p className="goal-plan-verify" data-testid="plan-card-verification">
      <span className="goal-plan-label">验证</span>
      {plan.verification.length > 0
        ? <span>{plan.verification[0].statement}{plan.verification.length > 1
            ? ` 等 ${plan.verification.length} 项` : ""}</span>
        : <span className="goal-plan-detail">尚未指定验证标准</span>}
    </p>
    {hiddenSteps > 0 && !expanded && <button className="text-button goal-plan-more" type="button"
      data-testid="plan-card-more-steps" aria-expanded="false" aria-controls={detailsId}
      onClick={() => setExpanded(true)}>查看全部 {plan.steps.length} 步</button>}
    {error !== null && <p className="action-error" role="alert" data-testid="plan-card-error">{error}</p>}
    <div className="goal-plan-actions">
      <button className="primary-button" type="button" data-testid="plan-card-execute"
        data-busy={busy ? "true" : undefined} disabled={busy}
        onClick={() => onExecute(plan.planId, plan.version)}>
        <Play aria-hidden="true" />按此计划执行</button>
      <button className="secondary-button" type="button" data-testid="plan-card-toggle"
        aria-expanded={expanded ? "true" : "false"} aria-controls={detailsId}
        onClick={() => setExpanded((value) => !value)}>
        <ChevronDown aria-hidden="true" data-expanded={expanded ? "true" : undefined} />
        {expanded ? "收起详情" : "展开详情"}</button>
      <button className="secondary-button" type="button" data-testid="plan-card-copy"
        disabled={busy} title="复制这一版的 Markdown 到剪贴板"
        onClick={() => onCopy(planMarkdown(view, plan.version), plan.version)}>
        <Copy aria-hidden="true" />复制计划</button>
    </div>
    {expanded && <div className="goal-plan-detail-panel" id={detailsId} data-testid="plan-card-details">
      <div className="goal-plan-group">
        <p className="goal-plan-label">全部步骤 · {plan.steps.length} 步</p>
        <PlanSteps plan={plan} testId="plan-card-all-steps" />
      </div>
      <div className="goal-plan-group">
        <p className="goal-plan-label">工作范围</p>
        {plan.scope.length > 0
          ? <ul className="goal-plan-list goal-plan-list--rows" data-testid="plan-card-scope">
              {plan.scope.map((item) => <li key={item}>{item}</li>)}
            </ul>
          : <p className="helper-text goal-plan-empty">未指定工作范围。</p>}
      </div>
      <div className="goal-plan-group">
        <p className="goal-plan-label">验证方式</p>
        {plan.verification.length > 0
          ? <ul className="goal-plan-list goal-plan-list--rows" data-testid="plan-card-verification-list">
              {plan.verification.map((item) => <li key={item.statement}>
                <span>{item.statement}</span><span className="goal-plan-detail"> · {item.method}</span>
              </li>)}
            </ul>
          : <p className="helper-text goal-plan-empty">未指定验证方式。</p>}
      </div>
      <div className="goal-plan-group">
        <p className="goal-plan-label">待定事项</p>
        {plan.openQuestions.length > 0
          ? <ul className="goal-plan-list goal-plan-list--rows" data-testid="plan-card-questions">
              {plan.openQuestions.map((item) => <li key={item}>{item}</li>)}
            </ul>
          : <p className="helper-text goal-plan-empty">没有待定事项。</p>}
      </div>
      <div className="goal-plan-group">
        <p className="goal-plan-label">版本历史 · 共 {view.versions.length} 版</p>
        <ol className="goal-plan-version-list" data-testid="plan-card-history">
          {view.versions.map((item) => <li key={item.planId} data-version={item.version}
            data-current={item.version === plan.version ? "true" : undefined}
            data-testid={`plan-version-${item.version}`}>
            <span className="goal-plan-version-number">第 {item.version} 版</span>
            <span className="goal-plan-version-state">
              {item.status === "CURRENT" ? "当前有效" : "已被取代"}</span>
            <span className="goal-plan-version-goal">{item.goal}</span>
          </li>)}
        </ol>
      </div>
      <p className="helper-text goal-plan-note">
        想改计划就直接说改哪一条；会形成新的一版，旧版仍然可查。</p>
    </div>}
  </section>;
}
