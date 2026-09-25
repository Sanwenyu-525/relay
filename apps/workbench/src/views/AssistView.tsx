import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { RotateCcw } from "lucide-react";
import AssistSourcePicker from "../components/AssistSourcePicker";
import { describeLiveError } from "../lib/liveErrors";
import { liveClient, useRelayConnection } from "../lib/relayConnection";

type AssistTarget = { readonly kind: "PROJECT" | "TASK"; readonly id: string; readonly title: string; readonly revision: string; readonly projectId: string | null; readonly executor: string | null };

/** 保留旧独立组件；正式路由仍按 M02 的 11 条旧路由，不新增 Assist 路由。 */
export default function AssistView({ targetKind, targetId }: { targetKind?: "PROJECT" | "TASK"; targetId?: string } = {}) {
  const location = useLocation();
  const params = useParams();
  const kind = targetKind ?? (location.pathname.startsWith("/projects/") ? "PROJECT" : "TASK");
  const id = targetId ?? params.id ?? "";
  const live = useRelayConnection().mode === "live";
  const [target, setTarget] = useState<AssistTarget | null>(null);
  const [selectedRefs, setSelectedRefs] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  async function loadTarget() {
    const version = ++requestVersion.current;
    setTarget(null); setSelectedRefs([]); setError(null); setLoading(live);
    const client = liveClient(); if (!client) return;
    try {
      if (kind === "PROJECT") { const project = await client.getProject(id); if (version !== requestVersion.current) return; setTarget({ kind: "PROJECT", id: project.id, title: project.title, revision: project.revision, projectId: project.id, executor: null }); }
      else { const task = await client.getTask(id); if (version !== requestVersion.current) return; setTarget({ kind: "TASK", id: task.id, title: task.title, revision: task.revision, projectId: task.projectId, executor: task.executor }); }
    } catch (caught) { if (version === requestVersion.current) setError(describeLiveError(caught).message); }
    finally { if (version === requestVersion.current) setLoading(false); }
  }
  useEffect(() => { void loadTarget(); return () => { requestVersion.current++; }; }, [kind, id, live]);
  if (loading) return <section className="page-state" aria-live="polite"><p className="eyebrow">Assist</p><h1>正在核对对话目标</h1></section>;
  if (!live) return <section className="page-state" data-testid="assist-fixture-gap"><p className="eyebrow">Assist</p><h1>示例模式没有真实会话</h1><p>连接本机 API 后才能读取项目或任务目标。此处不生成示例模型回复或提案。</p></section>;
  if (error) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">Assist</p><h1>暂时无法核对对话目标</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void loadTarget()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  if (!target) return null;
  return <section className="skill-page" data-testid="assist-target"><p className="eyebrow">{target.kind === "PROJECT" ? "项目 Assist" : "任务 Assist"} · {target.id}</p><h1>{target.title}</h1><p className="page-lede">当前目标修订 v{target.revision}{target.executor && <> · 当前执行者 {target.executor}</>}</p><p className="helper-text">消息目标固定为当前{target.kind === "PROJECT" ? "项目" : "任务"}；切换目标后须重新读取会话与来源。Assist 建议不会自动修改业务事实。</p><Link className="text-link" to={target.kind === "PROJECT" ? `/projects/${target.id}/tasks` : `/tasks/${target.id}`}>返回{target.kind === "PROJECT" ? "项目" : "任务"}</Link>{target.projectId ? <AssistSourcePicker key={target.projectId} projectId={target.projectId} selectedRefs={selectedRefs} onChange={setSelectedRefs} /> : <p className="helper-text">无 Project 的任务不能从项目范围选择资料；来源入口须由服务端按范围单独确认。</p>}<section className="surface-panel"><h2>会话与提案</h2><p className="helper-text">真实 Assist 消息与类型化提案接口仍在接线；当前页面只核对目标与可见资料版本，不发起模型请求或业务写入。</p></section></section>;
}
