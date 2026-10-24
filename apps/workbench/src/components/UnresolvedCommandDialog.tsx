import AppDialog from "./AppDialog";

/**
 * 未决命令的承载：正文只留一行状态，完整原因、原 command_id 与两个恢复出口放进弹窗。
 *
 * 这不是把证据移出正文——状态行仍在主列、不随弹窗关闭消失（工作台 §13.1）；
 * 弹窗只是用户处理这一条未决命令时的操作面。明确失败不进这里：它没有可核对的结果，
 * 走停留到关闭的 Notice。
 */
export function UnresolvedCommandStrip({ testId, label, busy, onOpen, className = "unresolved-command-strip" }: {
  readonly testId: string;
  readonly label: string;
  readonly busy: boolean;
  readonly onOpen: () => void;
  readonly className?: string;
}) {
  return <div className={className} data-testid={testId} data-state="unresolved">
    <span className="helper-text">{label}</span>
    <button type="button" className="text-button" disabled={busy} onClick={onOpen}>查看核对</button>
  </div>;
}

export function UnresolvedCommandDialog({ open, title, summary, commandId, detail, reason,
  busy, checkLabel, retryLabel, testId, onCheck, onRetry, onClose }: {
  readonly open: boolean;
  readonly title: string;
  readonly summary: string;
  readonly commandId: string;
  readonly detail: string;
  readonly reason: string | null;
  readonly busy: boolean;
  readonly checkLabel: string;
  readonly retryLabel: string;
  readonly testId: string;
  readonly onCheck: () => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}) {
  return <AppDialog open={open} title={title}
    initialFocusSelector={`[data-testid="${testId}-receipt"]`} onClose={onClose}>
    <div data-testid={`${testId}-dialog`}>
      <p>{summary}</p>
      {reason !== null && <p className="action-error" role="alert"
        data-testid={`${testId}-reason`}>{reason}</p>}
      <div className="dialog-actions">
        <button className="secondary-button" type="button" onClick={onClose}>稍后处理</button>
        <button className="secondary-button" type="button" data-testid={`${testId}-retry`}
          disabled={busy} onClick={onRetry}>{busy ? "正在重试" : retryLabel}</button>
        <button className="primary-button" type="button" data-testid={`${testId}-receipt`}
          disabled={busy} onClick={onCheck}>{busy ? "正在查询" : checkLabel}</button>
      </div>
      <details className="unresolved-command-details">
        <summary>技术详情</summary>
        <p>原 command_id：{commandId}</p>
        <p>{detail}</p>
      </details>
    </div>
  </AppDialog>;
}
