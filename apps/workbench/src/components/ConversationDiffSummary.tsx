import { useEffect, useRef, useState } from "react";
import { useConversationDiff } from "../lib/useConversationDiff";
import { localDiffReasonText } from "./ChatLocalFileDiff";
import type { RelayApiClient, RelayConversationDiffFile } from "../api/relayClient";

/**
 * 输入卡外上方居中的会话总 diff（工作台 §34.2 / §34.4，CD-01、CD-12、CD-17、CD-18）。
 *
 * 口径是 B「本轮对话开始以来的净变化」：会话基线 → 当前**已落盘**内容，生成中的预览不进这里。
 * 一行文字按钮就是展开入口，不加厚卡片、不撑高输入卡；路径变长或数字位数变化都收在这一行内，
 * 与发送/停止键不在同一块，因此不会挤掉它们。
 *
 * 状态必须彼此可辨（CD-17）：统计中 / 空净变化 / 非 Git 根 / 缺基线 / 目录不可读（失权）/
 * 部分不可统计 / 刷新失败。刷新失败保留上次可信值并标「截至…」，未知一律不显示成 `+0 −0`。
 * 展开的列表与正文都取自同一份修订（CD-15/CD-18）：基线修订变了就重读，不把旧正文配新统计。
 */

const UNAVAILABLE_TEXT: Record<string, string> = {
  NO_RESOURCE: "本次对话 · 未绑定工作目录，暂不统计",
  NO_BASELINE: "本次对话 · 缺少会话起点",
  ROOT_NOT_GIT: "本次对话 · 该目录不是 Git 根，首版不统计",
  RESOURCE_UNAVAILABLE: "本次对话 · 目录当前不可读（权限或位置变化）",
};

const ESTABLISH_TEXT: Record<string, string> = {
  CREATED: "统计起点已从现在开始建立。",
  REUSED: "这个目录已有统计起点，本次沿用原起点，不新建第二段。",
  SESSION_NOT_FOUND: "会话不存在，无法建立统计起点。",
  SESSION_NOT_ACTIVE: "会话不是活动状态，不能建立统计起点。",
  NO_RESOURCE: "还没有绑定工作目录，不能建立统计起点。",
  NOT_GIT_ROOT: "该目录不是 Git 根，首版不能建立统计起点。",
  RESOURCE_UNAVAILABLE: "目录当前不可读，未能建立统计起点。",
};

function timeText(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN");
}

/** 逐文件正文：只在展开且修订一致时读取；失权或不可读时不显示正文。 */
function ConversationDiffFileBody({ client, sessionId, path, revisionKey }: {
  client: RelayApiClient; sessionId: string; path: string; revisionKey: string;
}) {
  const [detail, setDetail] = useState<RelayConversationDiffFile | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const request = useRef(0);

  useEffect(() => {
    const current = ++request.current;
    setDetail(null); setFailure(null);
    void client.getConversationDiffFile(sessionId, path).then((next) => {
      if (current !== request.current) return; // 迟到响应不覆盖新修订（CD-13/CD-15）。
      setDetail(next);
    }).catch(() => {
      if (current !== request.current) return;
      setFailure("该文件的正文当前读不到；总数与磁盘实际改动不受影响。权限变化时不显示正文。");
    });
    return () => { request.current++; };
  }, [client, sessionId, path, revisionKey]);

  if (failure !== null) return <p className="action-error" role="alert">{failure}</p>;
  if (detail === null) return <p className="helper-text" role="status">正在读取正文…</p>;
  if (detail.available === false) {
    return <p className="helper-text">正文不可用：{UNAVAILABLE_TEXT[detail.reason] ??
      (detail.reason === "PATH_NOT_FOUND" ? "该路径已不在本次统计范围内" : detail.reason)}。</p>;
  }
  if (detail.rows === null) {
    return <p className="helper-text">行数不可统计：{localDiffReasonText(detail.rowsUnavailableReason ??
      detail.unavailableReason ?? "TEXT_UNAVAILABLE")}。保留摘要证据，不从当前磁盘补造原文。</p>;
  }
  return <>
    <div className="conversation-diff-body" role="table" aria-label={`${path} 的完整差异`}>
      {detail.rows.map((row, index) => <div className={`conversation-diff-row conversation-diff-row--${row.kind.toLowerCase()}`}
        role="row" key={`${index}-${row.kind}`}>
        <span role="cell" aria-label="基线行号">{row.oldLine ?? ""}</span>
        <span role="cell" aria-label="新内容行号">{row.newLine ?? ""}</span>
        <span role="cell" aria-label="差异标记">{row.kind === "ADD" ? "+" : row.kind === "REMOVE" ? "−" : " "}</span>
        <span role="cell" className="conversation-diff-text">{row.text}</span>
      </div>)}
    </div>
    {detail.rowsTruncated && <p className="helper-text">正文已达返回上限并被截断；这里的行数只是已返回部分，不冒充完整差异。</p>}
  </>;
}

export default function ConversationDiffSummary({ client, sessionId, enabled, directoryBound }: {
  client: RelayApiClient;
  sessionId: string;
  /** 外部读取是否被挡（连接/权限失效）：为 false 时整块不出现，不显示任何数字。 */
  enabled: boolean;
  /** 会话是否已绑定工作目录。未绑定＝这一行不存在（该事实归目录细条），也不发统计请求（§34.3 纯聊天不做全盘扫描）。 */
  directoryBound: boolean;
}) {
  const reading = enabled && directoryBound;
  const { diff, loading, error, stale, readAt, refresh } = useConversationDiff(client, sessionId, reading);
  const [open, setOpen] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [establishing, setEstablishing] = useState(false);
  const [establishNotice, setEstablishNotice] = useState<string | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  // 收起时同时收起文件正文：下次展开重新按当前修订读取，不拿旧正文配新统计。
  useEffect(() => { if (!open) setOpenFile(null); }, [open]);
  // 切换会话（enabled 关闭 → 打开）后旧正文一律不可取用。
  useEffect(() => { setOpenFile(null); setEstablishNotice(null); }, [sessionId]);

  if (!enabled) return null;
  /* 未绑定工作目录时这一行整块不出现（2026-10-17 用户指令「不要有这个提示」）：目录事实已经由
     输入区上方那条目录细条常驻说出，同一屏再复述一遍「暂不统计」等于把同一件事讲两次。 */
  if (!directoryBound) return null;

  // 只在联合类型上直接判 `available`，让 TS 收窄到「可用」分支；别名不会带着收窄走。
  const changed = diff !== null && diff.available === true ? diff : null;
  const files = changed?.files ?? [];
  const incomplete = changed?.incomplete ?? false;
  const revisionKey = changed !== null
    ? `${changed.resourceId}:${changed.baselineRevision}:${changed.rootPath}` : "none";

  let line: string;
  if (diff === null) {
    line = error !== null ? "本次对话 · 文件变化统计不可用"
      : loading ? "本次对话 · 正在统计文件变化…" : "本次对话 · 文件变化待读取";
  } else if (!diff.available) {
    line = UNAVAILABLE_TEXT[diff.reason] ?? "本次对话 · 文件变化不可统计";
  } else if (diff.totalFiles === 0 && !incomplete) {
    line = "本次对话 · 暂无文件变化";
  } else {
    line = `本次对话 · ${diff.totalFiles} 个文件 +${diff.totalAdded} −${diff.totalRemoved}`;
  }

  async function establishBaseline() {
    setEstablishing(true);
    try {
      const outcome = await client.establishConversationDiffBaseline(sessionId);
      setEstablishNotice(ESTABLISH_TEXT[outcome.reason] ??
        `统计起点结果：${outcome.reason}`);
      refresh();
    } catch {
      setEstablishNotice("建立统计起点失败：本次不改变原有消息与执行，可稍后再试。");
    } finally { setEstablishing(false); }
  }

  const panelId = `conversation-diff-panel-${sessionId}`;
  return <div className="conversation-diff" data-region="conversation-diff"
    onKeyDown={(event) => {
      if (event.key === "Escape" && open) {
        event.stopPropagation();
        setOpen(false);
        toggleRef.current?.focus(); // 键盘收起后回焦到入口（CD-19）。
      }
    }}>
    <button ref={toggleRef} className="conversation-diff-toggle text-link" type="button"
      aria-expanded={open} aria-controls={panelId} aria-busy={loading}
      data-testid="conversation-diff-toggle" data-state={diff === null ? "unknown"
        : diff.available ? (diff.totalFiles === 0 ? "empty" : "changed") : diff.reason}
      onClick={() => setOpen((previous) => !previous)}>
      <span className="conversation-diff-line">{line}</span>
      {changed !== null && incomplete && <span className="conversation-diff-flag">部分不可统计</span>}
      {stale && <span className="conversation-diff-stale" data-testid="conversation-diff-stale">
        更新失败 · 截至 {readAt === null ? "未知时刻" : timeText(readAt)}</span>}
      {!open && <span className="conversation-diff-hint" aria-hidden="true">展开</span>}
    </button>
    {open && <div id={panelId} className="conversation-diff-panel" data-testid="conversation-diff-panel">
      <p className="conversation-diff-panel-title" data-testid="conversation-diff-panel-title">本次对话的文件变化</p>
      {changed !== null ? <>
        <p className="helper-text">统计起点 <time dateTime={changed.baselineCapturedAt}>{timeText(changed.baselineCapturedAt)}</time>
          {" "}· 目录 <span className="conversation-diff-root" title={changed.rootPath}>{changed.rootPath}</span></p>
        <p className="helper-text">包含该目录自基线起的同期修改，不代表全部由 Agent 产生。</p>
        {changed.totalFiles === 0
          ? <p className="helper-text" data-testid="conversation-diff-empty">本次对话暂无文件变化。</p>
          : <ul className="conversation-diff-files" data-testid="conversation-diff-files">
            {files.map((file) => {
              const statable = file.unavailableReason === null && file.added >= 0 && file.removed >= 0;
              return <li key={file.path} className="conversation-diff-file" data-path={file.path}
                data-testid={`conversation-diff-file-${file.path}`}>
                <button className="conversation-diff-file-toggle text-link" type="button"
                  aria-expanded={openFile === file.path}
                  data-testid={`conversation-diff-file-toggle-${file.path}`}
                  onClick={() => setOpenFile((previous) => previous === file.path ? null : file.path)}>
                  <span className="conversation-diff-file-path" title={file.path}>{file.path}</span>
                  {statable
                    ? <span className="conversation-diff-metrics">
                      <span className="conversation-diff-add">+{file.added}</span>
                      <span className="conversation-diff-remove">−{file.removed}</span>
                      <span className="visually-hidden">新增 {file.added} 行，删除 {file.removed} 行</span>
                    </span>
                    : <span className="conversation-diff-note">{localDiffReasonText(file.unavailableReason)}</span>}
                  <span className="conversation-diff-hint" aria-hidden="true">
                    {openFile === file.path ? "收起正文" : "查看完整差异"}</span>
                </button>
                {openFile === file.path && <ConversationDiffFileBody client={client} sessionId={sessionId}
                  path={file.path} revisionKey={`${revisionKey}:${file.action}`} />}
              </li>;
            })}
          </ul>}
        {incomplete && <p className="helper-text" data-testid="conversation-diff-incomplete">
          覆盖范围内有条目未能统计（超限、二进制或读不到）；上面的总数只包含可核对的文件，不冒充完整差异。</p>}
      </> : <>
        {diff !== null && !diff.available && diff.reason === "NO_BASELINE" && <>
          <p className="helper-text">这个会话还没有可核对的统计起点，因此不给行数。可以从现在重新开始统计，
            {" "}新起点之后的变化才会计入；会话开始前的改动不会倒推。</p>
          <button className="secondary-button" type="button" data-testid="conversation-diff-establish"
            disabled={establishing} onClick={() => void establishBaseline()}>
            {establishing ? "正在建立统计起点…" : "从现在开始统计"}</button>
        </>}
        {diff !== null && !diff.available && diff.reason === "RESOURCE_UNAVAILABLE" &&
          <p className="helper-text" data-testid="conversation-diff-hidden-by-permission">
            目录不可读或权限已变化：正文与历史内容一并隐藏，不通过统计入口继续读取内容。</p>}
        {error !== null && <p className="action-error" role="alert" data-testid="conversation-diff-error">
          {error}</p>}
        {diff === null && loading && <p className="helper-text" role="status">正在读取会话文件变化…</p>}
      </>}
      {establishNotice !== null && <p className="helper-text" data-testid="conversation-diff-establish-notice">
        {establishNotice}{changed !== null
          ? ` 现起点：${timeText(changed.baselineCapturedAt)}` : ""}</p>}
      <button className="text-link" type="button" data-testid="conversation-diff-refresh"
        onClick={() => refresh()}>重新读取</button>
    </div>}
  </div>;
}
