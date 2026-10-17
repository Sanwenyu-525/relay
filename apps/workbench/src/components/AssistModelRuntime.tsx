import { useEffect, useState } from "react";
import type { RelayApiClient, RelayAssistModelRuntime } from "../api/relayClient";
import { Snackbar } from "./Feedback";
import { describeLiveError } from "../lib/liveErrors";

function failureText(runtime: RelayAssistModelRuntime): string | null {
  if (runtime.failureReason === "ACCOUNT_FREE_DAILY_EXHAUSTED") return "账户共享免费日额度已耗尽，停止接续。";
  if (runtime.failureScope === "PLATFORM" || runtime.failureReason === "PLATFORM_RATE_LIMIT") return "平台限流，停止切换并等待恢复。";
  if (runtime.failureScope === "UNKNOWN" || runtime.failureReason === "ACCOUNT_FREE_DAILY_UNKNOWN")
    return "限流来源或账户额度尚未核实，停止自动接续。";
  if (runtime.routingStatus === "COOLDOWN") return "候选型号仍在限流冷却期，等待服务商提供的恢复时间。";
  if (runtime.routingStatus === "EXHAUSTED") return "免费候选已不可用，停止接续。";
  return null;
}

export default function AssistModelRuntime({ client, messageId, messageStatus }: {
  client: RelayApiClient; messageId: string; messageStatus: string;
}) {
  const [runtime, setRuntime] = useState<RelayAssistModelRuntime | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const result = await client.getAssistModelRuntime(messageId);
        if (!active) return;
        setRuntime(result); setError(null);
        if (result.messageStatus === "PENDING" || result.messageStatus === "RUNNING")
          timer = setTimeout(() => { void read(); }, 1_000);
      } catch (caught) { if (active) setError(describeLiveError(caught).message); }
    }
    void read();
    return () => { active = false; if (timer !== undefined) clearTimeout(timer); };
  }, [client, messageId, messageStatus, retry]);
  if (runtime !== null && !runtime.snapshotAvailable) return null;
  const failure = runtime === null ? null : failureText(runtime);
  // 读取失败是「这条辅助信息暂时读不到」，不是本条消息的业务事实，因此不留在正文里把输入卡顶走，
  // 改走浮层 Snackbar：停留到计时结束，动作「重新读取」在原处等价于原先那个按钮。
  return <>
    {/* 重读前先清掉旧错误：浮层条目随 error 一起收走，避免在途期间仍挂着「读取失败」。 */}
    {error && <Snackbar tone="danger" testId="assist-model-runtime-error"
      action={{ label: "重新读取", onSelect: () => { setError(null); setRetry((value) => value + 1); } }}>
      {`模型调用状态读取失败：${error}`}
    </Snackbar>}
    {/* 读失败且从没读到过内容时整块不渲染：正文里不留空 section，这条信息全在浮层里。 */}
    {(runtime !== null || !error) && <section className="helper-text" data-testid="assist-model-runtime" aria-label="本条消息的模型调用" style={{ overflowWrap: "anywhere" }}>
      {runtime === null ? <p role="status">正在读取模型调用状态…</p> : <>
      <p>本条首选：{runtime.preferredModel ?? "未知"} · 最近实际调用：{runtime.actualModel ?? "尚未调用"} · 调用记录 {runtime.calls.length} 次</p>
      {runtime.switches.map((change, index) => <p key={index} role="status">已从 {change.fromModel ?? "未知型号"} 切换到 {change.toModel ?? "无可用候选"}；
        {change.reason === "UPSTREAM_PROVIDER_RATE_LIMIT" || change.reason === "UPSTREAM_RATE_LIMIT" ? "原模型上游限流。" : "依据已记录的接续策略。"}</p>)}
      {failure && <p role="status">{failure}</p>}
      {runtime.retryAfterAt && <p>服务商提供的恢复时间：{runtime.retryAfterAt}</p>}
      <details><summary>模型尝试与用量</summary>
        <p>当前候选：{runtime.currentCandidateModel ?? "未知"}；上限 {runtime.maxCandidates ?? "未知"} 个型号。限流核对时的账户共享日剩余请求：{runtime.freeDailyRemaining ?? "未知"}。</p>
        <ol aria-label="冻结候选顺序">{runtime.candidateModels.map((model) => <li key={model}>{model}</li>)}</ol>
        <ol aria-label="模型调用记录">{runtime.calls.map((call) => <li key={call.id}>{call.model} · {
          call.status === "COMPLETED" ? "调用已返回" : call.status === "FAILED" ? "调用失败" : call.status === "CANCELLED" ? "已取消"
            : runtime.messageStatus === "RUNNING" ? "调用中" : "结果待核对"} · 输入 {call.inputTokens ?? "未知"} / 输出 {call.outputTokens ?? "未知"} token</li>)}</ol>
        <p>用量来自服务商回传；缺失保持未知。目录免费标记不代替费用结算或任务验收。</p>
        </details>
      </>}
    </section>}
  </>;
}
