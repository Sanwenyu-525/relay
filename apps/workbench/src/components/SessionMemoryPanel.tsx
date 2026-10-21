import { useCallback, useEffect, useRef, useState } from "react";
import type { DecimalRevision } from "../types";
import { createCommandId, type RelayApiClient, type RelayMemoryCompactionRequest,
  type RelaySessionMemory } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import "./SessionMemoryPanel.css";

/**
 * 会话短期记忆（工作台 §40 / HTTP §10.99）。
 *
 * 这个面板只回答三件事：模型下次能看到什么（摘要 + 原文窗口）、整理进行到哪一步、
 * 这次会话是否记住。它不改聊天正文，也不把摘要写成业务事实——摘要只是一段模型产出，
 * 不能代替 Project State、Task 完成或权限判断。
 */

const statusLabels: Record<RelayMemoryCompactionRequest["status"], string> = {
  PENDING: "排队中",
  RUNNING: "整理中",
  COMPLETED: "已完成",
  FAILED: "失败",
  CANCELLED: "已取消"
};

/** 整理失败的 typed error 翻成人话；未知码原样保留，不吞成「失败」两个字。 */
const errorLabels: Record<string, string> = {
  MEMORY_CONTEXT_TOO_LARGE: "历史超过工作输入上限；原文与旧摘要都保留，请先清除工作窗口或减少上下文",
  MEMORY_HISTORY_LIMIT: "历史条数超过上限；原文保留，未做整理",
  MEMORY_SUMMARY_INVALID: "模型返回的摘要不符合约定格式；旧摘要与原文保留",
  MEMORY_PUBLICATION_REJECTED: "结果提交时窗口已变化，这次整理作废；可重新整理",
  MEMORY_SOURCE_CHANGED: "来源、权限或范围在整理期间变化；旧摘要保留，需重新整理",
  MEMORY_UNRESOLVED_TOOL_STATE: "还有未结算的工具调用；等结算后再整理",
  MEMORY_WORKER_LOST: "执行整理的后台进程已退出；没有换模型重试，可重新发起"
};

function requestStateText(request: RelayMemoryCompactionRequest): string {
  const base = statusLabels[request.status];
  if (request.status === "RUNNING" && request.cancelRequested) return `${base} · 取消中（等待安全结束）`;
  if (request.status === "PENDING" && request.cancelRequested) return "已取消";
  return base;
}

export default function SessionMemoryPanel({ client, sessionId, sessionRevision, inflight,
  writeBlocked, writeBlockedReason, onSessionRevisionChanged, refreshToken,
  pollIntervalMs = 2000 }: {
  readonly client: RelayApiClient;
  readonly sessionId: string;
  readonly sessionRevision: DecimalRevision;
  /** 有在途消息时服务端会拒绝整理与清除；这里如实提示，不代替服务端裁决。 */
  readonly inflight: boolean;
  readonly writeBlocked: boolean;
  readonly writeBlockedReason: string | null;
  /** 一次性开关会推进会话修订：成功后面板必须让上层重读会话，不能只改本地开关。 */
  readonly onSessionRevisionChanged?: () => void;
  /** 外部动作（`/compact` 发送、回执核对）受理后推动本面板立刻按 request_id 读回。 */
  readonly refreshToken?: number;
  /** 轮询间隔；只为测试可缩短，产品默认 2 秒（状态查询是只读 GET，不产生模型调用）。 */
  readonly pollIntervalMs?: number;
}) {
  const [memory, setMemory] = useState<RelaySessionMemory | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const requestVersion = useRef(0);
  const disposed = useRef(false);

  useEffect(() => {
    disposed.current = false;
    return () => { disposed.current = true; requestVersion.current += 1; };
  }, []);

  const read = useCallback(async (silent = false) => {
    const request = ++requestVersion.current;
    if (!silent) { setLoading(true); setReadError(null); }
    try {
      const next = await client.getSessionMemory(sessionId);
      if (disposed.current || request !== requestVersion.current) return;
      setMemory(next); setReadError(null);
    } catch (caught) {
      if (disposed.current || request !== requestVersion.current) return;
      // 读取失败保留上一次成功读到的窗口：它仍是「上次核对过的事实」，
      // 只是必须显式标成过期读取，不能让失败静默变成「没有摘要」。
      setReadError(describeLiveError(caught).message);
    } finally {
      if (!disposed.current && request === requestVersion.current) setLoading(false);
    }
  }, [client, sessionId]);

  // 切会话即重读并清空旧状态：迟到响应由 requestVersion 丢弃，不污染新会话。
  useEffect(() => {
    setMemory(null); setNotice(null); setActionError(null); setConfirmingClear(false); setPollTick(0);
    void read();
    return () => { requestVersion.current += 1; };
  }, [read]);

  const activeRequests = (memory?.requests ?? []).filter((request) =>
    request.status === "PENDING" || request.status === "RUNNING");
  const polling = activeRequests.length > 0;

  /* 外部受理（`/compact` 或回执核对）后立刻读回一次，并重置轮询计数。
     用 ref 记住上次令牌：挂载时那次读取已经由上面的 effect 做过，不重复发一次。 */
  const seenToken = useRef(refreshToken);
  useEffect(() => {
    if (refreshToken === undefined || refreshToken === seenToken.current) return;
    seenToken.current = refreshToken;
    setPollTick(0);
    void read(true);
  }, [refreshToken, read]);

  /* 202 之后按 request_id 读回：每 2 秒读一次，最多 60 次（约两分钟）。
     到上限就停下并说明，不无限轮询；终态自动停（activeRequests 变空）。 */
  useEffect(() => {
    if (!polling || pollTick >= 60) return;
    const timer = window.setTimeout(() => {
      setPollTick((value) => value + 1);
      void read(true);
    }, pollIntervalMs);
    return () => window.clearTimeout(timer);
  }, [polling, pollTick, read, pollIntervalMs]);

  const currentSessionRevision = memory?.sessionRevision ?? sessionRevision;
  const disabled = busy || writeBlocked;

  /**
   * 传输失败时保留原命令身份。
   *
   * 「请求没拿到响应」不等于「命令没生效」：这里不换新 ID 重发，而是把原 command_id、
   * 原载荷和核对方式一起留住，界面只给「查回执」与「按原命令重试」两个出口。
   */
  type Unresolved = { readonly commandId: string; readonly commandType: string;
    readonly label: string; readonly retry: () => void };
  const [unresolved, setUnresolved] = useState<Unresolved | null>(null);
  const [checking, setChecking] = useState(false);

  function fail(caught: unknown, fallback: Unresolved) {
    const described = describeLiveError(caught);
    if (described.kind === "transport") setUnresolved(fallback);
    else setActionError(described.message);
  }

  async function runCompact(commandId = createCommandId()) {
    if (memory === null || disabled) return;
    setBusy(true); setActionError(null); setNotice(null); setUnresolved(null);
    try {
      const accepted = await client.requestSessionMemoryCompaction({ sessionId,
        commandId, expectedRevision: currentSessionRevision });
      if (disposed.current) return;
      setNotice(`已受理整理请求（${accepted.status}），完成与否以读回的状态为准。`);
      setPollTick(0);
      await read(true);
    } catch (caught) {
      if (!disposed.current) fail(caught, { commandId, commandType: "RequestMemoryCompaction",
        label: "整理记忆", retry: () => void runCompact(commandId) });
    } finally { if (!disposed.current) setBusy(false); }
  }

  async function cancel(request: RelayMemoryCompactionRequest, commandId = createCommandId()) {
    if (disabled) return;
    setBusy(true); setActionError(null); setNotice(null); setUnresolved(null);
    try {
      const result = await client.cancelMemoryCompaction({ sessionId, requestId: request.id,
        commandId });
      if (disposed.current) return;
      // 取消意图与终态分开说：RUNNING 时服务端只落意图，安全结算前仍在运行。
      setNotice(result.status === "CANCELLED"
        ? "整理已取消。"
        : result.cancelRequested ? "已请求停止；整理仍在运行，等安全结算后才算取消。"
          : "取消请求已提交。");
      setPollTick(0);
      await read(true);
    } catch (caught) {
      if (!disposed.current) fail(caught, { commandId, commandType: "CancelMemoryCompaction",
        label: "取消整理", retry: () => void cancel(request, commandId) });
    } finally { if (!disposed.current) setBusy(false); }
  }

  async function clearWindow(commandId = createCommandId()) {
    if (memory === null || disabled) return;
    setBusy(true); setActionError(null); setNotice(null); setUnresolved(null);
    try {
      await client.clearSessionMemory({ sessionId, commandId,
        expectedRevision: memory.revision, expectedSessionRevision: memory.sessionRevision });
      if (disposed.current) return;
      setConfirmingClear(false);
      setNotice("已清除工作窗口：后续发送只从新边界开始。聊天与工具历史、长期记忆都没有删除。");
      await read(true);
      onSessionRevisionChanged?.();
    } catch (caught) {
      if (!disposed.current) fail(caught, { commandId, commandType: "ClearSessionMemory",
        label: "清除工作记忆", retry: () => void clearWindow(commandId) });
    } finally { if (!disposed.current) setBusy(false); }
  }

  async function toggleRemember(next: boolean, commandId = createCommandId()) {
    if (memory === null || disabled) return;
    setBusy(true); setActionError(null); setNotice(null); setUnresolved(null);
    try {
      await client.setSessionMemoryRemember({ sessionId, commandId,
        expectedRevision: memory.revision, expectedSessionRevision: memory.sessionRevision, remember: next });
      if (disposed.current) return;
      setNotice(next
        ? "已重新记住本会话：从新的边界开始累积，关闭期间的轮次不会并回工作窗口。"
        : "已切换为一次性模式：只发送当轮消息，不召回长期记忆，也不建立摘要。");
      await read(true);
      onSessionRevisionChanged?.();
    } catch (caught) {
      if (!disposed.current) fail(caught, { commandId, commandType: "SetSessionMemory",
        label: next ? "重新记住本会话" : "切换一次性模式",
        retry: () => void toggleRemember(next, commandId) });
    } finally { if (!disposed.current) setBusy(false); }
  }

  /** 按原 command_id 查回执：类型与会话都对得上才算这次控制已生效，然后重读窗口。 */
  async function checkReceipt() {
    if (unresolved === null) return;
    setChecking(true); setActionError(null);
    try {
      const receipt = await client.getCommandReceipt(unresolved.commandId);
      if (disposed.current) return;
      if (receipt.commandType !== unresolved.commandType) {
        setActionError(`原命令回执的类型是 ${receipt.commandType}，不是${unresolved.label}；不能当作已生效。`);
        return;
      }
      if (receipt.result.session_id !== sessionId) {
        setActionError("原命令回执属于另一个会话，不能当作本会话的控制已生效。");
        return;
      }
      setUnresolved(null);
      setNotice(`原命令回执已核对：${unresolved.label}已提交，正在读回服务端状态。`);
      setPollTick(0);
      await read(true);
      if (unresolved.commandType === "SetSessionMemory" || unresolved.commandType === "ClearSessionMemory") {
        onSessionRevisionChanged?.();
      }
    } catch (caught) {
      if (!disposed.current) setActionError(`回执尚未核对到：${describeLiveError(caught).message}`);
    } finally { if (!disposed.current) setChecking(false); }
  }

  const checkpoint = memory?.checkpoint ?? null;
  const remember = memory?.remember ?? true;
  const summaryState = checkpoint === null ? (remember ? "NONE" : "ONE_SHOT")
    : checkpoint.available ? "AVAILABLE" : "UNAVAILABLE";

  return <details className="session-memory" data-testid="session-memory"
    data-state={summaryState} data-remember={remember ? "on" : "off"}>
    <summary data-testid="session-memory-summary">
      <span className="session-memory-title">会话记忆</span>
      <span className="session-memory-state" data-state={summaryState}>
        {readError !== null ? "读取失败" : loading && memory === null ? "读取中"
          : summaryState === "ONE_SHOT" ? "一次性模式"
            : summaryState === "AVAILABLE" ? "有摘要" : summaryState === "UNAVAILABLE" ? "摘要已失效" : "无摘要"}
      </span>
      {activeRequests.length > 0 && <span className="session-memory-pending" data-testid="session-memory-active">
        {activeRequests.some((request) => request.status === "RUNNING") ? "整理中" : "整理排队中"}</span>}
    </summary>
    <div className="session-memory-body">
      {loading && memory === null && <p className="helper-text" role="status">正在读取会话记忆…</p>}
      {readError !== null && <div className="action-error" role="alert" data-testid="session-memory-read-error">
        <p>会话记忆读取失败：{readError}</p>
        <p className="helper-text">{memory === null ? "没有可展示的窗口状态。" : "下面显示的是上一次成功读到的状态，可能已经变化。"}</p>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => void read()}>重新读取</button>
      </div>}

      {memory !== null && <>
        <p className="helper-text session-memory-scope" data-testid="session-memory-mode">
          {remember
            ? "本会话会累积原文窗口，并按设置自动整理历史。"
            : "一次性模式：只发送当轮用户消息，不召回长期记忆，也不建立新摘要。"}
          {" "}{checkpoint === null ? "当前没有摘要。" : `摘要覆盖到第 ${checkpoint.throughSeq} 条。`}
        </p>
        {/* 双修订、清除序号这些是核对协议用的技术事实：放进诊断，不再占普通视图的阅读位。 */}
        <details className="session-memory-diagnostics" data-testid="session-memory-diagnostics">
          <summary>诊断信息</summary>
          <p className="helper-text">窗口修订 v{memory.revision} · 会话修订 v{memory.sessionRevision} ·
            已清除至第 {memory.clearedThroughSeq} 条 · 保留原文窗口的边界由服务端裁决。</p>
        </details>

        <section className="session-memory-summary-block" data-testid="session-memory-checkpoint">
          <h4>模型下次能看到的历史</h4>
          {summaryState === "ONE_SHOT" && <p className="helper-text" data-testid="session-memory-one-shot">
            一次性模式下没有摘要，也不沿用旧摘要：重新开启后从新边界开始。</p>}
          {summaryState === "NONE" && <p className="helper-text" data-testid="session-memory-no-summary">
            还没有摘要：当前窗口使用原文历史（保留最近若干条完整轮次）。</p>}
          {summaryState === "UNAVAILABLE" && <p className="helper-text" data-testid="session-memory-unavailable">
            摘要已失效（来源、权限、范围或配置在整理后发生变化）。失效摘要不会被使用，也不会在这里回显旧正文；原文历史仍然保留。</p>}
          {summaryState === "AVAILABLE" && checkpoint !== null && <>
            <p className="session-memory-summary-text" data-testid="session-memory-summary-text">{checkpoint.summary}</p>
            <p className="helper-text">整理覆盖到第 {checkpoint.throughSeq} 条 · 生成于 {checkpoint.createdAt}
              {checkpoint.sources.length > 0 && ` · 引用 ${checkpoint.sources.length} 个来源`}。</p>
            <p className="helper-text">摘要是一段模型产出，只用于后续生成的上下文；它不是已确认事实，不能替代任务完成、验收或权限判断。</p>
          </>}
        </section>

        <section className="session-memory-requests" data-testid="session-memory-requests">
          <h4>整理记录</h4>
          {memory.requests.length === 0
            ? <p className="helper-text">还没有整理记录。</p>
            : <ol className="session-memory-request-list">{memory.requests.slice(0, 5).map((request) => {
              const terminal = request.status === "COMPLETED" || request.status === "FAILED" || request.status === "CANCELLED";
              return <li key={request.id} data-testid={`session-memory-request-${request.id}`}
                data-status={request.status}>
                <span className="session-memory-request-state">{request.reason === "AUTO" ? "自动整理" : "手动整理"} · {requestStateText(request)}</span>
                <span className="helper-text">覆盖至第 {request.throughSeq} 条 · {request.updatedAt}</span>
                {request.errorCode !== null && <span className="action-error" data-testid={`session-memory-request-error-${request.id}`}>
                  {errorLabels[request.errorCode] ?? `整理失败（${request.errorCode}）；原文与旧摘要保留。`}</span>}
                {!terminal && !request.cancelRequested && <button className="secondary-button" type="button"
                  data-testid={`session-memory-cancel-${request.id}`} disabled={disabled}
                  onClick={() => void cancel(request)}>取消整理</button>}
                {!terminal && request.cancelRequested && <span className="helper-text">已请求停止，等待安全结束</span>}
              </li>;
            })}</ol>}
          {polling && pollTick >= 60 && <p className="helper-text" data-testid="session-memory-poll-stopped">
            状态读取已暂停（超过两分钟仍在进行）。整理可能仍在后台运行，可点「刷新状态」继续读取。</p>}
        </section>

        <div className="session-memory-actions">
          <button className="secondary-button" type="button" data-testid="session-memory-compact"
            disabled={disabled} onClick={() => void runCompact()}>整理记忆</button>
          <button className="secondary-button" type="button" data-testid="session-memory-remember"
            disabled={disabled} onClick={() => void toggleRemember(!remember)}>
            {remember ? "改为一次性模式" : "重新记住本会话"}</button>
          <button className="secondary-button" type="button" data-testid="session-memory-clear"
            disabled={disabled} onClick={() => setConfirmingClear(true)}>清除工作记忆…</button>
          <button className="text-link" type="button" data-testid="session-memory-refresh"
            disabled={busy} onClick={() => { setPollTick(0); void read(); }}>刷新状态</button>
        </div>
        <p className="helper-text">「整理记忆」把较早的已完成轮次压成摘要，保留最近原文；关闭自动整理后仍可手动整理。
          整理与清除只改变后续模型窗口，不删除聊天记录、工具历史或长期记忆。</p>

        {confirmingClear && <div className="session-memory-confirm" role="group" aria-label="确认清除工作记忆"
          data-testid="session-memory-clear-confirm">
          <p>清除工作记忆后，模型下次只看到这次清除之后的内容。聊天记录、工具历史与长期记忆都保留，也不会新建会话。</p>
          {inflight && <p className="helper-text" data-testid="session-memory-clear-inflight">
            当前仍有在途消息：服务端会拒绝这次清除。请先等待或停止生成，再清除。</p>}
          <div className="session-memory-actions">
            <button className="danger-button" type="button" data-testid="session-memory-clear-confirm-button"
              disabled={disabled} onClick={() => void clearWindow()}>确认清除工作记忆</button>
            <button className="secondary-button" type="button" data-testid="session-memory-clear-cancel"
              disabled={busy} onClick={() => setConfirmingClear(false)}>取消</button>
          </div>
        </div>}
      </>}

      {notice !== null && <p className="receipt-message" role="status" data-testid="session-memory-notice">{notice}</p>}
      {actionError !== null && <p className="action-error" role="alert" data-testid="session-memory-error">{actionError}</p>}
      {unresolved !== null && <div className="action-error" role="alert" data-testid="session-memory-unresolved">
        <p>「{unresolved.label}」的结果未核对：请求响应丢失，这条命令是否已生效尚未确定。</p>
        <p className="helper-text">原 command_id：{unresolved.commandId}。先查回执；查不到时只能用同一命令与同一载荷重试，不换新 ID。</p>
        <div className="session-memory-actions">
          <button className="secondary-button" type="button" data-testid="session-memory-receipt"
            disabled={checking || busy} onClick={() => void checkReceipt()}>{checking ? "正在查询" : "查询原命令回执"}</button>
          <button className="secondary-button" type="button" data-testid="session-memory-retry"
            disabled={checking || busy} onClick={unresolved.retry}>按原命令重试</button>
        </div>
      </div>}
      {writeBlocked && writeBlockedReason !== null &&
        <p className="helper-text" data-testid="session-memory-write-blocked">{writeBlockedReason}</p>}
    </div>
  </details>;
}
