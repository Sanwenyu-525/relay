import { useCallback, useEffect, useId, useRef, useState } from "react";

import { createCommandId, RelayApiClient, RelayTransportError,
  type RequiredContextAudit, type RequiredContextFileRisk } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import "./ContextRiskNotice.css";

/**
 * 必读文件体积预警（2026-10-30）。
 *
 * 位置与形状的裁定沿用输入器这一列的既有规矩：**不占输入卡**。卡片里恒定只有正文、
 * 工具行与发送键；这条提示排在卡下方与档位说明同一列，出现或消失都不改变卡片的形状，
 * 光标与工具行不会跳。
 *
 * 三件事必须分清，混一起会给出错误读数：
 *   · 这里算的是**预计加载量**（还没发生）：按当前必读文件与预算推算；
 *   · 输入器右侧的圆环是**最近一次真实调用**的实测用量；
 *   · 「本次忽略」只影响这台机器上的提示，不改动任何文件；文件再变化（指纹不同）
 *     就必须重新评估——忽略不等于永久静音。
 *
 * 阈值、比例与原因文案全部来自服务端：界面不复制一份判定，因此调阈值不用改这里，
 * 也不会出现「界面比服务端晚知道风险」。
 */

interface Props {
  readonly client: RelayApiClient;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly audit: RequiredContextAudit | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRefresh: () => void;
}

const STORAGE_PREFIX = "relay.requiredContext.dismissed:";

/** 忽略只按「目录 + 必读文件指纹」记住：指纹变了（改过/加过/删过）自动失效。 */
function readDismissed(workspaceId: string, resourceId: string): string | null {
  try { return window.localStorage.getItem(`${STORAGE_PREFIX}${workspaceId}:${resourceId}`); }
  catch { return null; }
}

function writeDismissed(workspaceId: string, resourceId: string, fingerprint: string): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${workspaceId}:${resourceId}`, fingerprint);
  } catch { /* 存储不可用只是「忽略不记住」，不影响预警本身。 */ }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTokens(tokens: number): string {
  return tokens.toLocaleString("zh-CN");
}

/** 没有分母就不给百分比：`null` 与 0% 是两件事，不能互相顶替。 */
function formatShare(share: number | null): string {
  if (share === null) return "占比不可算";
  const percent = share * 100;
  return percent >= 10 ? `${Math.round(percent)}%` : `${percent.toFixed(1)}%`;
}

const SEVERITY_LABEL = { NONE: "正常", NOTICE: "提醒", HIGH: "高风险", SEVERE: "严重" } as const;

export default function ContextRiskNotice({ client, workspaceId, resourceId, audit, loading,
  error, onRefresh }: Props) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(() =>
    readDismissed(workspaceId, resourceId));
  const [preview, setPreview] = useState<{ readonly path: string; readonly text: string;
    readonly truncated: boolean } | null>(null);
  const [previewBusy, setPreviewBusy] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => { setDismissed(readDismissed(workspaceId, resourceId)); },
    [workspaceId, resourceId]);

  // 收起语义与输入器其它浮层一致：点浮层外一次即收；Esc 收起并把焦点还给触发键。
  useEffect(() => {
    if (!open) return;
    function close(): void { setOpen(false); triggerRef.current?.focus(); }
    function onPointerDown(event: PointerEvent): void {
      if (rootRef.current?.contains(event.target as Node) ?? false) return;
      close();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // 打开就把焦点移进浮层：键盘用户不必再找一遍入口。preventScroll 保证输入卡不被顶出视野。
  useEffect(() => { if (open) panelRef.current?.focus({ preventScroll: true }); }, [open]);

  const openFile = useCallback(async (file: RequiredContextFileRisk) => {
    const access = audit?.access ?? null;
    if (access === null) return;
    setPreviewBusy(file.path); setPreviewError(null); setPreview(null);
    try {
      const response = await client.readManagedFileState({ commandId: createCommandId(),
        projectId: access.projectId, resourceId,
        connectionId: access.connectionId, actionType: "READ_FILE",
        relativePath: file.path });
      const outcome = response.outcome;
      // 等待确认/在途未决的形态只有 reason、没有结果字段：不能拿它冒充「读到了」。
      if (!("result" in outcome)) {
        setPreviewError(`这次读取还在等待确认（${outcome.reason}），确认后才能看正文。`);
        return;
      }
      const result = outcome.result;
      if (outcome.state === "FAILED" || result.kind === "FAILURE") {
        setPreviewError(`读取失败：${result.kind === "FAILURE"
          ? result.reason : "服务端未给出原因"}`);
        return;
      }
      if (result.kind !== "CONTENT") {
        setPreviewError("返回的不是文件正文。");
        return;
      }
      // 预览只是「看一眼入口文件长什么样」，不改变文件本身，也不拿它替代完整读取。
      const limit = 4_000;
      setPreview({ path: file.path,
        text: result.content.slice(0, limit),
        truncated: result.truncated || result.content.length > limit });
    } catch (caught) {
      setPreviewError(caught instanceof RelayTransportError
        ? "读取结果无法核对，请重新读取。" : describeLiveError(caught).message);
    } finally { setPreviewBusy(null); }
  }, [audit, client, resourceId]);

  // 审计不可用 / 没有读取权限 / 没扫成：不能说成「没有风险」，也不能静默消失（P0-B 第 6 条）。
  // 仍然只是一行，不占输入卡，也不阻止发送。
  if (audit === null) {
    if (error === null) return null;
    return <div className="context-risk context-risk-unavailable" data-testid="context-risk-unavailable">
      <div role="status" aria-live="polite">
        <span className="context-risk-mark" aria-hidden="true">!</span>
        <span className="context-risk-text">{`无法完成风险检查：${error}`}</span>
        <span className="context-risk-action">仍可发送</span>
      </div>
    </div>;
  }
  if (audit.state !== "OK") {
    return <div className="context-risk context-risk-unavailable" data-testid="context-risk-unavailable"
      data-state={audit.state}>
      <div role="status" aria-live="polite">
        <span className="context-risk-mark" aria-hidden="true">!</span>
        <span className="context-risk-text">{audit.state === "NO_FILE_ACCESS"
          ? "未扫描必读文件：这个目录没有生效的读取权限（不等于没有风险）"
          : `无法完成风险检查：${audit.detail}`}</span>
        <span className="context-risk-action">仍可发送</span>
      </div>
    </div>;
  }
  if (audit.severity === "NONE") return null;
  if (dismissed !== null && dismissed === audit.fingerprint) return null;

  const severe = audit.severity === "SEVERE";
  const total = audit.budget.requiredTotalShare;
  const count = audit.files.length;
  // 严重时改成「发送前请先确认」：这是发送前提醒，但按钮仍然可用，不阻止发送。
  const actionText = severe ? "发送前请先确认" : "查看详情";
  const lineText = `发现 ${count} 个大型必读文件 · ` + (total === null
    ? "预计占用无法估算" : `预计占用 ${formatShare(total)} 上下文`);

  return <div className="context-risk" ref={rootRef} data-testid="context-risk-notice">
    <div role="status" aria-live="polite">
      <button type="button" ref={triggerRef} className="context-risk-line"
        data-testid="context-risk-line" data-severity={audit.severity}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId}
        onClick={() => setOpen((wasOpen) => !wasOpen)}>
        <span className="context-risk-mark" aria-hidden="true">⚠</span>
        <span className="context-risk-text">{lineText}</span>
        <span className="context-risk-action">{actionText}</span>
      </button>
    </div>
    {open && <div className="context-risk-panel" id={panelId} ref={panelRef} tabIndex={-1}
      role="dialog" aria-label="必读文件与上下文风险" data-testid="context-risk-panel"
      data-severity={audit.severity}>
      <div className="context-risk-header">
        <p className="context-risk-heading">必读文件</p>
        <span className="context-risk-badge">{SEVERITY_LABEL[audit.severity]}</span>
        <span className="context-risk-agent">{audit.agent.label}</span>
      </div>
      {/* 与圆环的分工只写一句：这里算预计，圆环是实测。 */}
      <p className="context-risk-note">预计加载量（发送前推算）；右侧圆环显示最近一次真实调用。</p>

      <ul className="context-risk-files">
        {audit.files.map((file) => <li className="context-risk-file" key={file.path}
          data-testid={`context-risk-file-${file.path}`} data-severity={file.severity}>
          <p className="context-risk-file-path" title={file.reason}>{file.path}</p>
          <p className="context-risk-file-meta">
            <span>{formatBytes(file.bytes)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatTokens(file.estimatedTokens)} tokens</span>
            <span aria-hidden="true">·</span>
            <span className="context-risk-share">{formatShare(file.share)}</span>
          </p>
          <button type="button" className="text-button context-risk-view"
            data-testid={`context-risk-view-${file.path}`}
            disabled={audit.access === null || previewBusy !== null}
            onClick={() => void openFile(file)}>
            {previewBusy === file.path ? "读取中" : "查看文件"}
          </button>
        </li>)}
      </ul>

      {previewError !== null && <p className="context-risk-error" role="alert"
        data-testid="context-risk-preview-error">{previewError}</p>}
      {preview !== null && <div className="context-risk-preview" data-testid="context-risk-preview">
        <div className="context-risk-preview-head">
          <span>{preview.path}</span>
          <button type="button" className="text-button" data-testid="context-risk-preview-close"
            onClick={() => setPreview(null)}>收起</button>
        </div>
        <pre>{preview.text}{preview.truncated ? "\n…（只显示开头一段，文件本身未改动）" : ""}</pre>
      </div>}

      <dl className="context-risk-budget">
        <div><dt>必读合计</dt><dd data-testid="context-risk-required-total">
          {formatTokens(audit.budget.requiredTotalTokens)} tokens</dd></div>
        <div><dt>有效输入预算</dt><dd data-testid="context-risk-effective-input">
          {audit.budget.effectiveInputTokens === null ? "无法计算"
            : `${formatTokens(audit.budget.effectiveInputTokens)} tokens`}</dd></div>
        <div><dt>Provider 窗口</dt><dd data-testid="context-risk-window">
          {audit.budget.providerWindowTokens === null
            ? "未知（按调用预算估算）" : `${formatTokens(audit.budget.providerWindowTokens)} tokens`}</dd></div>
        <div><dt>调用预算</dt><dd data-testid="context-risk-call-budget">
          {formatTokens(audit.budget.callBudgetTokens)} tokens
          {audit.budget.callBudgetSource === "SESSION" ? "（本会话档位）"
            : audit.budget.callBudgetSource === "WORKSPACE_TIER" ? "（工作区默认档位）"
              : "（应用默认）"}</dd></div>
        <div><dt>预留</dt><dd>输出 {formatTokens(audit.budget.reserves.outputTokens)} · 提示
          {" "}{formatTokens(audit.budget.reserves.systemPromptTokens)} · 工具
          {" "}{formatTokens(audit.budget.reserves.toolDefinitionTokens)}</dd></div>
      </dl>

      {audit.reasons.length > 0 && <ul className="context-risk-reasons">
        {audit.reasons.map((reason) => <li key={reason.code}>{reason.text}</li>)}
      </ul>}

      {audit.suggestions.length > 0 && <details className="context-risk-details"
        data-testid="context-risk-suggestions">
        <summary>优化建议</summary>
        <ul>{audit.suggestions.map((suggestion) =>
          <li key={suggestion.code}>{suggestion.text}</li>)}</ul>
      </details>}

      {audit.skipped.length > 0 && <details className="context-risk-details"
        data-testid="context-risk-skipped">
        <summary>未计入的条目（{audit.skipped.length}）</summary>
        <ul>{audit.skipped.map((entry) =>
          <li key={entry.path}>{entry.path}：{entry.reason}</li>)}</ul>
      </details>}

      <p className="context-risk-estimate-note">{audit.budget.estimate.note}</p>
      <div className="context-risk-actions">
        <button type="button" className="secondary-button" data-testid="context-risk-refresh"
          disabled={loading} onClick={() => onRefresh()}>{loading ? "正在读取" : "刷新读数"}</button>
        <button type="button" className="secondary-button" data-testid="context-risk-dismiss"
          onClick={() => {
            writeDismissed(workspaceId, resourceId, audit.fingerprint);
            setDismissed(audit.fingerprint); setOpen(false);
          }}>本次忽略</button>
      </div>
      {error !== null && <p className="context-risk-error" role="alert"
        data-testid="context-risk-error">{error}</p>}
    </div>}
  </div>;
}
