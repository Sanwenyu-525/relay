import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { RelayApiError, type RelayApiClient, type RelayRunTrace } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import "./RunTracePanel.css";

function resultRef(value: boolean): string { return value ? "有结果引用（不代表成功）" : "无结果引用"; }

export default function RunTracePanel({ client, runId, taskId, runRevision }: {
  client: RelayApiClient; runId: string; taskId: string; runRevision: string;
}) {
  const [trace, setTrace] = useState<RelayRunTrace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const requestVersion = useRef(0);
  useEffect(() => {
    const request = ++requestVersion.current;
    setTrace(null); setLoading(true); setError(null);
    void client.getRunTrace(runId).then((next) => {
      if (next.runId !== runId || next.taskId !== taskId) throw new Error("Trace 与当前 Run/Task 不匹配。");
      if (request === requestVersion.current) setTrace(next);
    }).catch((caught: unknown) => {
      if (request === requestVersion.current) setError(caught instanceof RelayApiError && [403, 404].includes(caught.problem.status)
        ? "Trace 当前不可读取或无权查看；旧证据已清除。" : describeLiveError(caught).message);
    }).finally(() => { if (request === requestVersion.current) setLoading(false); });
    return () => { requestVersion.current++; };
  }, [client, runId, taskId, runRevision, reload]);

  return <section className="surface-panel run-trace" data-testid="run-trace"><div className="run-trace-heading"><div><h2>Run Trace</h2>
    <p className="helper-text">从实际 Step、Attempt、模型调用、Manifest、验证、Review、Gateway 和 Run Effect 读取；批准、调用与效果分别核对。</p></div>
    <button className="secondary-button" type="button" disabled={loading} onClick={() => setReload((value) => value + 1)}>刷新证据</button></div>
    {loading && <p role="status">正在读取 Run Trace…</p>}
    {error && <p className="action-error" role="alert">{error}</p>}
    {trace && <div className="run-trace-groups"><p className="helper-text">Run {trace.runId} · 状态 {trace.status}。下列“有结果引用”只说明证据指针存在，不代表结果成功。</p>
      <section><h3>步骤与尝试 · {trace.steps.length} / {trace.attempts.length}</h3>
        {trace.steps.length ? <ol>{trace.steps.map((step) => <li key={step.id}><strong>{step.index + 1}. {step.kind} · {step.status}</strong>
          <small>Step {step.id} · revision v{step.revision} · {resultRef(step.resultAvailable)} · {step.startedAt ?? "未开始"} → {step.finishedAt ?? "未结束"}</small>
          {trace.attempts.filter((attempt) => attempt.stepId === step.id).map((attempt) => <p key={attempt.id}>Attempt {attempt.id} · 第 {attempt.number} 次 · {attempt.status} · claim epoch {attempt.claimEpoch} · {resultRef(attempt.resultAvailable)}</p>)}</li>)}</ol>
          : <p className="helper-text">尚无 Step 记录。</p>}</section>
      <section><h3>模型调用元数据 · {trace.modelCalls.length}</h3>
        {trace.modelCalls.length ? <ul>{trace.modelCalls.map((call) => <li key={call.id}><strong>{call.provider} / {call.model} · {call.status}</strong>
          <small>Call {call.id} · Attempt {call.stepAttemptId ?? "未关联"} · Manifest {call.manifestId ?? "未关联"}</small>
          <small>输入 sha256 {call.inputSha256 ?? "无"} · 读取 Operation {call.readOperationId ?? "无"} / Invocation {call.readInvocationId ?? "无"}</small>
          <small>Token 输入 {call.inputTokens ?? "未知"} / 输出 {call.outputTokens ?? "未知"} · {call.startedAt} → {call.settledAt ?? "未结清"}</small></li>)}</ul>
          : <p className="helper-text">本次 Run 没有模型调用记录。</p>}</section>
      <section><h3>Context Manifest 与来源 · {trace.manifests.length}</h3>
        {trace.manifests.length ? <ul>{trace.manifests.map((manifest) => <li key={manifest.id}><strong>Manifest {manifest.id}</strong>
          <small>Step {manifest.stepId ?? "无"} · Builder {manifest.builderVersion} · sha256 {manifest.sha256} · {manifest.createdAt}</small>
          {manifest.sources.length ? <ul>{manifest.sources.map((source, index) => <li key={`${manifest.id}:${index}`}>
            {source.kind} · {source.role} · {source.trust} · {source.availability === "AVAILABLE"
              ? <>来源 {source.sourceRef} · 版本 {source.version ?? "无"} · sha256 {source.sha256 ?? "无"} · 源 sha256 {source.sourceSha256 ?? "无"}</>
              : "来源当前不可用或无权读取；历史正文不以当前版本替代"}</li>)}</ul>
            : <p>此 Manifest 未返回来源。</p>}</li>)}</ul>
          : <p className="helper-text">本次 Run 没有 Manifest 记录。</p>}</section>
      <section><h3>验证会话与检查 · {trace.verifications.length}</h3>
        {trace.verifications.length ? <ul>{trace.verifications.map((session) => <li key={session.id}><strong>{session.status} · verdict {session.verdict ?? "尚无"}</strong>
          <small>Session {session.id} · 验收 v{session.acceptanceRevision} · check plan {session.checkPlanHash} · 父 Session {session.parentSessionId ?? "无"}</small>
          {session.targets.map((target) => <p key={target.artifactVersionId}>目标版本 <Link className="inline-link" to={`/artifact-versions/${target.artifactVersionId}/lineage`}>{target.artifactVersionId}</Link> · 内容 sha256 {target.contentSha256}</p>)}
          {session.checks.length ? <ul>{session.checks.map((check) => <li key={check.id}>条件 {check.criterionId} · {check.result} · {check.severity} · {check.required ? "必需" : "可选"} · {check.createdAt}</li>)}</ul>
            : <p>没有检查结果。</p>}</li>)}</ul>
          : <p className="helper-text">本次 Run 没有验证会话。</p>}</section>
      <section><h3>Review 判断 · {trace.reviews.length}</h3><p className="helper-text">Review 决定只证明批准或拒绝等判断；动作效果见下面的 Gateway 和 Run Effect。</p>
        {trace.reviews.length ? <ul>{trace.reviews.map((review) => <li key={review.id}><Link className="inline-link" to={`/reviews?id=${review.id}`}>{review.kind} · {review.status}</Link>
          <small>Review {review.id} · Operation {review.operationId ?? "无"} · Verification {review.verificationSessionId ?? "无"} · target hash {review.targetHash}</small>
          <p>{review.decision ? `决定 ${review.decision.value} · ${review.decision.decidedAt}（不代表动作已执行）` : "尚无决定"}</p></li>)}</ul>
          : <p className="helper-text">本次 Run 没有 Review 记录。</p>}</section>
      <section><h3>Gateway Operation 与 Invocation · {trace.operations.length}</h3>
        {trace.operations.length ? <ul>{trace.operations.map((operation) => <li key={operation.id}><strong>{operation.capability} / {operation.actionType} · {operation.status}</strong>
          <small>Operation {operation.id} · Step {operation.stepId ?? "无"} · 参数 sha256 {operation.paramsSha256} · {resultRef(operation.resultAvailable)}</small>
          {operation.invocations.length ? <ul>{operation.invocations.map((invocation) => <li key={invocation.id}>Invocation {invocation.id} · 第 {invocation.number} 次 · {invocation.status} · {resultRef(invocation.resultAvailable)}</li>)}</ul>
            : <p>尚无 Invocation。</p>}</li>)}</ul>
          : <p className="helper-text">本次 Run 没有 Gateway Operation。</p>}</section>
      <section><h3>Run Effect · {trace.effects.length}</h3><p className="helper-text">实际效果状态独立于 Review 决定与 Gateway Invocation；UNKNOWN 仍须核对原动作。</p>
        {trace.effects.length ? <ul>{trace.effects.map((effect) => <li key={effect.id}><strong>{effect.status}</strong>
          <small>Effect operation {effect.id} · Step {effect.stepId} · 参数 sha256 {effect.paramsSha256} · {resultRef(effect.resultAvailable)} · {effect.createdAt} → {effect.resolvedAt ?? "未结清"}</small></li>)}</ul>
          : <p className="helper-text">本次 Run 没有 Run Effect 记录。</p>}</section>
    </div>}
  </section>;
}
