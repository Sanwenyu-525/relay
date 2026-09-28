import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { RelayApiClient, RelayDecision, RelayKnowledge, RelayProject,
  RelayRule } from "../api/relayClient";
import type { RelayProjectGoal } from "../api/blueprintDtos";
import { describeLiveError } from "../lib/liveErrors";

interface Props {
  readonly client: RelayApiClient;
  readonly projectId: string;
  readonly onOpen: (kind: "KNOWLEDGE" | "DECISION" | "RULE", id: string) => void;
}

interface GuideData {
  readonly project: RelayProject;
  readonly goals: readonly RelayProjectGoal[];
  readonly decisions: readonly RelayDecision[];
  readonly rules: readonly RelayRule[];
  readonly knowledge: readonly RelayKnowledge[];
}

export default function ProjectKnowledgeGuide({ client, projectId, onOpen }: Props) {
  const [data, setData] = useState<GuideData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setData(null); setError(null);
    void Promise.all([client.getProject(projectId), client.getProjectGoals(projectId),
      client.getDecisions(projectId), client.getRules(projectId), client.getKnowledge(projectId)])
      .then(([project, goals, decisions, rules, knowledge]) => {
        if (active) setData({ project, goals: goals.filter((goal) => goal.status === "ACTIVE"),
          decisions: decisions.filter((item) => item.projectId === projectId),
          rules: rules.filter((item) => item.projectId === projectId),
          knowledge: knowledge.filter((item) => item.projectId === projectId) });
      }).catch((caught: unknown) => { if (active) setError(describeLiveError(caught).message); });
    return () => { active = false; };
  }, [client, projectId]);

  return <section className="surface-panel knowledge-guide" aria-label="项目导读" data-testid="project-knowledge-guide">
    <p className="eyebrow">项目导读</p><h2>从这里重新理解项目</h2>
    <p className="page-lede">沿着已有目标、决定、规则和资料阅读；缺失的关系保留为待补充。</p>
    {!data && !error && <p role="status">正在读取项目事实…</p>}
    {error && <p className="action-error" role="alert">项目导读读取失败：{error}</p>}
    {data && <>
      <p className="helper-text">所属项目：{data.project.title}{data.project.archivedAt && " · 已归档"}</p>
      <ol className="knowledge-guide__steps">
        <li><h3>项目目标</h3>{data.goals.length > 0 ? <ul>{data.goals.map((goal) =>
          <li key={goal.goalId}>{goal.title} · v{goal.revision}<small>来源 Goal {goal.goalId}</small></li>)}</ul>
          : <p>尚无已关联的有效目标；目标说明待补充。</p>}</li>
        <li><h3>核心流程说明</h3><p>尚无项目流程与资料之间的明确引用；可从下方已有资料继续查找。</p></li>
        <li><h3>项目决定</h3>{data.decisions.length > 0 ? <ul>{data.decisions.map((decision) =>
          <li key={decision.id}><button type="button" className="text-button"
            onClick={() => onOpen("DECISION", decision.id)}>{decision.title} · v{decision.currentVersion}
              {decision.status !== "ACTIVE" ? ` · ${decision.status}` : ""}</button></li>)}</ul>
          : <p>尚无项目决定；关键决定引用待补充。</p>}</li>
        <li><h3>规则与验收依据</h3>{data.rules.length > 0 ? <ul>{data.rules.map((rule) =>
          <li key={rule.id}><button type="button" className="text-button"
            onClick={() => onOpen("RULE", rule.id)}>{rule.ruleKey} · v{rule.currentVersion}
              {rule.status !== "ACTIVE" ? ` · ${rule.status}` : ""}</button></li>)}</ul>
          : <p>尚无项目规则。</p>}
          <p><Link to={`/projects/${encodeURIComponent(projectId)}/tasks`}>按任务查看实际验收条件与证据</Link>；导读不代替验收。</p></li>
        <li><h3>可阅读的项目资料与经验</h3>{data.knowledge.length > 0 ? <ul>{data.knowledge.map((item) =>
          <li key={item.id}><button type="button" className="text-button"
            onClick={() => onOpen("KNOWLEDGE", item.id)}>{item.title} · v{item.currentVersion}</button></li>)}</ul>
          : <p>尚无项目资料；经验记录待补充。</p>}</li>
      </ol>
      <p className="helper-text">本导读只导航已有事实；“关键”关系、人工排序和项目流程正文尚无编排契约。</p>
    </>}
  </section>;
}
