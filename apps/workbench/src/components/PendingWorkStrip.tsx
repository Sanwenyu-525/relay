import { Link } from "react-router-dom";
import type { RelayApiClient } from "../api/relayClient";
import { usePendingWork, type PendingContext } from "../lib/usePendingWork";
import "./PendingWorkStrip.css";

/**
 * 「待你处理」：按当前工作区给一条只读入口（目标 / 待判断 / 未读讨论 / 未归属任务）。
 * 与输入卡上方的目录细条同一行、紧跟其内容右端，不占欢迎区、也不推到行的最右边。
 * 只计数与标题、只跳转，审批与完成仍回各自页面做；空或读取失败时整条不出现。
 */
export function PendingWorkStrip({ client, context }: { client: RelayApiClient; context: PendingContext }) {
  const { items } = usePendingWork(client, context);
  if (items.length === 0) return null;

  return (
    <section className="pending-work" data-testid="pending-work" data-scope={context.scope}>
      <span className="pending-work-label">待你处理</span>
      <span className="pending-work-items">
        {items.map((item) => (
          <Link key={item.key} className="pending-work-item" to={item.href}>{item.label}</Link>
        ))}
      </span>
    </section>
  );
}
