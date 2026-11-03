import { activityReasonLabel, type ActivityItem } from "../lib/activityPresentation";

/**
 * 工具详情的统一渲染器（2026-10-30 验收整改）。
 *
 * 会话侧与 Run 侧的工具行现在共用同一套 anatomy（`ActivityRow`），详情也必须共用同一套
 * 结构，否则「展开之后长得不一样」会把统一行白做。两侧的**数据**不同，但字段语义相同：
 *
 *   参数 → 结果正文 → 执行元数据（退出码 / 截断 / 超时 / 取消）→ 时间 → 未执行原因
 *
 * 两条硬约束：
 *   * 没有结果正文就不摆「结果」区块。会话账本没有 `result_ref`，空着比编一段诚实。
 *   * 结果正文逐字来自服务端的 `result_ref`，不加工、不摘要；截断与省略量按服务端落到的
 *     键显示，不把截断后的内容呈现为完整。
 */
export default function ActivityDetail({ item }: { readonly item: ActivityItem }) {
  const detail = item.detail;
  const meta: string[] = [];
  if (detail.exitCode !== null) meta.push(`退出码 ${detail.exitCode}`);
  else if (detail.resultText !== null) meta.push("退出码未记录");
  if (detail.resultTruncated) {
    meta.push(detail.omittedBytes === null
      ? "结果被服务端截断，省略量未记录" : `结果被服务端截断，省略 ${detail.omittedBytes} 字节`);
  }
  if (detail.timedOut) meta.push("服务端记录为超时");
  if (detail.cancelled) meta.push("服务端记录为已取消");
  const reason = detail.rejectionReason;
  const reasonLabel = reason === null ? "" : activityReasonLabel(reason);

  return <div className="activity-detail">
    <p className="activity-detail-meta">工具 <code className="hash-code">{item.toolName}</code></p>
    <p className="activity-detail-label">参数</p>
    <pre data-testid={`activity-detail-args-${item.id}`}>
      {JSON.stringify(detail.args ?? {}, null, 2)}</pre>
    {detail.resultText !== null && <>
      <p className="activity-detail-label">结果</p>
      <pre data-testid={`activity-detail-result-${item.id}`}>{detail.resultText}</pre>
    </>}
    {meta.length > 0 && <p className="activity-detail-meta"
      data-testid={`activity-detail-meta-${item.id}`}>{meta.join(" · ")}</p>}
    <p className="activity-detail-meta">
      请求时间 {item.startedAt ?? "未记录"}
      {item.endedAt === null ? " · 尚无结算时刻" : ` · 结算时间 ${item.endedAt}`}
    </p>
    {detail.operationId !== null && <p className="activity-detail-meta">
      动作身份 <code className="hash-code">{detail.operationId}</code></p>}
    {reason !== null && <p className="activity-detail-meta">
      未执行原因 {reasonLabel}
      {detail.rejectionDetail === null ? "" : `：${detail.rejectionDetail}`}
      {/* 机器码只在展开层出现（2026-11-01 P1-1）：常显那一行说的是人话，而「服务端记的到底是
          哪个码」是核对时才需要的身份，跟工具名、时间戳同一档。标签本身就等于码时不再重复一遍。 */}
      {reasonLabel === reason ? "" : `（码 ${reason}）`}</p>}
    {/* 会话账本没有结果正文时，明确说清缺的是什么——不是「没有输出」，而是「这个账本不存」。 */}
    {detail.resultText === null && item.source === "SESSION_TOOL_CALL" && <p className="activity-detail-meta">
      会话账本只记录请求与结算，不保存工具结果正文；实际结果在该 Run 的工具轨迹里核对。
    </p>}
  </div>;
}
