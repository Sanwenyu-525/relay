import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import type { RelayApiClient, RelayViewKind } from "../api/relayClient";

/** 项目工作台入口只读取默认配置；浏览其他 kind 由显式路由完成。 */
export default function ProjectWorkbenchEntry() {
  const { id = "" } = useParams();
  const location = useLocation();
  const { client } = useRelayConnection();
  const [selection, setSelection] = useState<{
    readonly projectId: string; readonly client: RelayApiClient | null; readonly kind: RelayViewKind
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const scope = useRef(0);

  useEffect(() => {
    const request = ++scope.current;
    setSelection(null); setError(null);
    if (client) void client.getViewConfiguration(id).then((config) => {
      if (config.projectId !== id) throw new Error("视图配置查询返回了其他项目的数据。");
      if (request === scope.current) setSelection({ projectId: id, client, kind: config.kind });
    }).catch((caught: unknown) => {
      if (request === scope.current) setError(describeLiveError(caught).message);
    });
    else setSelection({ projectId: id, client: null, kind: "general" });
    return () => { scope.current++; };
  }, [client, id, reload]);

  if (selection?.projectId === id && selection.client === client) {
    return <Navigate to={`/projects/${id}/workbench/${selection.kind}${location.search}`} replace />;
  }
  return <section className="page-state" aria-live="polite">
    <h1>{error ? "暂时无法打开项目工作台" : "正在读取默认工作台"}</h1>
    {error ? <><p role="alert">{error}</p><button className="secondary-button" type="button"
      onClick={() => setReload((value) => value + 1)}>重新读取默认配置</button>
      <Link className="text-link" to={`/projects/${id}`}>返回项目页</Link></> :
      <p>{client ? "正在读取服务端保存的默认视图。" : "正在打开示例工作台。"}</p>}
  </section>;
}
