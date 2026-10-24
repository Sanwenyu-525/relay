import { useEffect, useRef, useState } from "react";
import { useConversationDiff } from "../lib/useConversationDiff";
import { localDiffReasonText } from "./ChatLocalFileDiff";
import { RelayApiError, type RelayApiClient, type RelayConversationDiff, type RelayConversationDiffFile, type RelayConversationDiffScanSide, type RelayConversationDiffScope } from "../api/relayClient";

/**
 * 与目录细条同处输入卡**外**上方那一行的会话总 diff（工作台 §34.2 / §34.4，CD-01、CD-12、CD-17、CD-18）。
 *
 * 口径：**只统计本会话自己写过的文件**（2026-10-20 用户指令「这里就只统计当前会话的 git diff」）。
 * 服务端按会话的写账本圈定候选路径，再用「会话基线 → 当前已落盘内容」算净变化；同一目录里
 * 其他程序、其他会话的同期修改不计入这条入口（目录级总变化是另一件事，不在这里冒充）。
 * 生成中的预览不进这里。
 *
 * 状态必须彼此可辨（CD-17）：统计中 / 空净变化 / 非 Git 根 / 缺基线 / 目录不可读（失权）/
 * 部分不可统计 / 刷新失败。刷新失败保留上次可信值并标「截至…」，未知一律不显示成 `+0 −0`。
 * 「完整且空」与「读取中」不再占位：入口整行不出现（2026-10-24 用户指令「没有 git diff 的时候
 * 不显示这个红框部分」），其余状态照旧可见——不可用与失败本身就是要说的事，不能靠消失交代。
 * 「部分不可统计」必须当场说清是哪一类不完整（扫描覆盖不足 vs 已发现文件读不出行数）以及条数，
 * 入口行给成因短语、展开面板逐条解释，不靠隐藏提示交代（2026-10-18 用户指令）。
 * 展开的列表与正文都取自同一份可信读取（CD-15/CD-18）：统计每次成功刷新都让已展开
 * 正文按新读取代次重新核对（DTO 无当前侧快照字段，起点修订不变不代表当前文件未变），
 * 不把旧正文配新统计；拒读（401/403/404）撤下旧值，临时失败保留可信值标「截至…」。
 */

const UNAVAILABLE_TEXT: Record<string, string> = {
  NO_RESOURCE: "本次对话 · 未绑定工作目录，暂不统计",
  NO_BASELINE: "本次对话 · 缺少会话起点",
  ROOT_NOT_GIT: "本次对话 · 该目录不是 Git 根，首版不统计",
  RESOURCE_UNAVAILABLE: "本次对话 · 目录当前不可读（权限或位置变化）",
};

/** 扫描停下来的位置（baseline-capture.ts 的 ScanStopReason）。 */
const SCAN_STOP_TEXT: Record<string, string> = {
  FILE_COUNT_LIMIT: "文件数达到统计上限",
  TOTAL_BYTES_LIMIT: "累计体积达到统计上限",
  SCAN_ABORTED: "扫描被中止",
};

type AvailableDiff = Extract<RelayConversationDiff, { available: true }>;

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

/** 一侧扫描覆盖的可读细节：核对到多少、为什么停下来；`listed` 未知时不假称总数。 */
function sideDetail(side: RelayConversationDiffScanSide): string {
  const scope = side.listed === null ? `已核对 ${side.files} 个文件`
    : `已核对 ${side.files}/${side.listed} 个文件`;
  const stop = side.reason === null ? "" : `，原因：${SCAN_STOP_TEXT[side.reason] ?? side.reason}`;
  return `${scope}${stop}`;
}

/** 已发现但行数读不出行数的条数（二进制/超限/读不到），与「扫描没覆盖到」是两类事实。 */
function uncountableFiles(diff: AvailableDiff): number {
  return diff.files.filter((file) => file.unavailableReason !== null).length;
}

/**
 * 入口行上的可见成因：一句话说清这一轮为什么不是全部（CD-17）。
 * 覆盖信息由服务端给出；没有覆盖信息时直说「成因未提供」，不退回含糊的隐藏提示。
 */
function incompleteFlag(diff: AvailableDiff): string {
  const coverage = diff.coverage;
  if (coverage === null) return "部分不可统计（服务端未给出成因）";
  const sessionScope = diff.scope === "SESSION";
  const parts: string[] = [];
  // 会话口径的统计范围只有本会话写过的路径，「整个目录没扫全」不是它的缺口，不能拿来说事。
  if (!sessionScope && (!coverage.baseline.complete || !coverage.current.complete)) {
    parts.push("目录只扫描了部分文件");
  }
  if (coverage.uncheckedFiles > 0 || coverage.unverifiedFiles > 0) {
    parts.push(sessionScope ? "部分写入路径未核对" : "部分文件未核对");
  }
  if (coverage.unscannedFiles > 0) parts.push(`${coverage.unscannedFiles} 个写入路径不在扫描范围`);
  if (coverage.unverifiableFiles > 0) parts.push(`${coverage.unverifiableFiles} 个文件内容未核对`);
  const uncountable = uncountableFiles(diff);
  if (uncountable > 0) parts.push(`${uncountable} 个文件行数不可统计`);
  return parts.length === 0 ? "部分不可统计（成因未提供）" : `统计不完整：${parts.join("、")}`;
}

/** 展开面板逐条解释不完整的具体范围与条数；只在数据可确定时给出数量，不做推测。 */
function incompleteLines(diff: AvailableDiff): readonly string[] {
  const coverage = diff.coverage;
  if (coverage === null) {
    return ["本次响应没有携带覆盖信息，服务端未说明不完整的具体成因。"];
  }
  const sessionScope = diff.scope === "SESSION";
  const lines: string[] = [];
  if (!sessionScope && !coverage.baseline.complete) {
    lines.push(`会话起点扫描不完整：${sideDetail(coverage.baseline)}。`);
  }
  if (!sessionScope && !coverage.current.complete) {
    lines.push(`本轮当前扫描不完整：${sideDetail(coverage.current)}。`);
  }
  if (coverage.uncheckedFiles > 0) {
    lines.push(sessionScope
      ? `${coverage.uncheckedFiles} 个本会话写入的路径本轮没核对到：不计删除，也不计零变化。`
      : `${coverage.uncheckedFiles} 个文件在起点里有、本轮扫描没核对到：不计删除，也不计零变化。`);
  }
  if (coverage.unverifiedFiles > 0) {
    lines.push(sessionScope
      ? `${coverage.unverifiedFiles} 个本会话写入的路径起点没覆盖、又已被 Git 跟踪：无法确认它原本是否已存在，不计新增。`
      : `${coverage.unverifiedFiles} 个文件本轮有、起点没覆盖且已被 Git 跟踪：无法确认是本会话新增，不计新增。`);
  }
  if (coverage.unscannedFiles > 0) {
    lines.push(`${coverage.unscannedFiles} 个本会话写过的路径在起点与本轮扫描里都没出现（目录扫描到上限就停了）：无法统计。`);
  }
  if (coverage.unverifiableFiles > 0) {
    lines.push(`${coverage.unverifiableFiles} 个文件起点与本轮都在、但内容读不到（超过单文件读取上限或采集时读失败），` +
      "字节数也没变：既不算修改，也不算没变，因此不出现在下面的列表里。");
  }
  const uncountable = uncountableFiles(diff);
  if (uncountable > 0) {
    lines.push(`${uncountable} 个已发现文件的行数不可统计（二进制、超限或读不到），在下面的列表里逐条标出。`);
  }
  if (lines.length === 0) lines.push("服务端标记本次统计不完整，但没有给出具体成因与条数。");
  return lines;
}

/** 逐文件正文：只在展开且修订一致时读取；失权或不可读时不显示正文。 */
function ConversationDiffFileBody({ client, sessionId, path, revisionKey, scope }: {
  client: RelayApiClient; sessionId: string; path: string; revisionKey: string;
  scope: RelayConversationDiffScope;
}) {
  const [detail, setDetail] = useState<RelayConversationDiffFile | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const request = useRef(0);

  useEffect(() => {
    const current = ++request.current;
    setDetail(null); setFailure(null);
    void client.getConversationDiffFile(sessionId, path, scope).then((next) => {
      if (current !== request.current) return; // 迟到响应不覆盖新修订（CD-13/CD-15）。
      setDetail(next);
    }).catch((caught) => {
      if (current !== request.current) return;
      // 明确拒读（无权/对象不存在/凭据失效）与临时读不到分开说：拒读时旧正文已撤下，
      // 恢复后重新展开才重新读取，不把权限拒绝说成普通网络抖动（禅道 #118）。
      setFailure(caught instanceof RelayApiError && [401, 403, 404].includes(caught.problem.status)
        ? `该文件的正文读取被拒绝（HTTP ${caught.problem.status} ${caught.problem.code}）：旧正文已撤下，权限或对象恢复后重新展开读取。`
        : "该文件的正文当前读不到；总数与磁盘实际改动不受影响。权限变化时不显示正文。");
    });
    return () => { request.current++; };
  }, [client, sessionId, path, revisionKey, scope]);

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

export default function ConversationDiffSummary({ client, sessionId, enabled, directoryBound,
  scope = "SESSION", inline = false }: {
  client: RelayApiClient;
  sessionId: string;
  /** 外部读取是否被挡（连接/权限失效）：为 false 时整块不出现，不显示任何数字。 */
  enabled: boolean;
  /** 会话是否已绑定工作目录。未绑定＝这一行不存在（该事实归目录细条），也不发统计请求（§34.3 纯聊天不做全盘扫描）。 */
  directoryBound: boolean;
  /**
   * 统计范围：对话输入框上方那一行用 `SESSION`（只算本会话落盘的路径）；
   * 工作详情的「变更」页签用 `DIRECTORY`（整段目录净变化，含同期外部修改）。
   */
  scope?: RelayConversationDiffScope;
  /** 内联形态（工作详情页签内）：直接摊开清单，不渲染「展开／收起」入口。 */
  inline?: boolean;
}) {
  // 内联形态是「变更」页签自己发起的一次读取：目录未绑定时由服务端回答 NO_RESOURCE，
  // 这里不能像输入卡上方那一行那样整块隐藏（那样页签会永远是空的）。
  const reading = enabled && (directoryBound || inline);
  /* 目录口径每次读取都要重扫受管根（本机 2000 条约 3 秒），页签里没必要 4 秒一次：
     拉到 20 秒，配合面板底部的「重新读取」仍能手动取最新。会话口径零写入时服务端直接短路。 */
  const { diff, loading, error, stale, readAt, successSeq, refresh } = useConversationDiff(
    client, sessionId, reading, inline ? 20000 : 4000, scope);
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
     输入区上方那条目录细条常驻说出，同一屏再复述一遍「暂不统计」等于把同一件事讲两次。
     内联形态（工作详情「变更」页签）不适用：那里就是专门来看统计的。 */
  if (!directoryBound && !inline) return null;

  // 只在联合类型上直接判 `available`，让 TS 收窄到「可用」分支；别名不会带着收窄走。
  const changed = diff !== null && diff.available === true ? diff : null;
  const files = changed?.files ?? [];
  const incomplete = changed?.incomplete ?? false;
  // 正文身份 = 资源/起点/目录 + 当前侧可信读取代次（禅道 #117）：DTO 没有当前侧快照
  // 代次字段，起点修订不变不代表当前文件未变（同样行数的内容替换也不改统计对象），
  // 所以每次统计成功刷新都让已展开正文重新核对；失败读取不递增，正文身份不漂移。
  const revisionKey = changed !== null
    ? `${changed.resourceId}:${changed.baselineRevision}:${changed.rootPath}:${successSeq}` : "none";

  /* 没有 git diff 时这一行整块不出现（2026-10-24 用户指令「没有 git diff 的时候不显示这个红框部分」）：
     完整且空的净变化没有内容可说，展开也只有一句「暂无文件变化」，留着只是输入卡上方的占位噪声。
     读取中也先不占位——否则每打开一次会话都会先闪一句「正在统计…」再消失，输入卡跟着上下跳一次。
     有变化、有不可用成因（缺起点／非 Git 根／失权）、读取失败仍然出现：那些状态本身就是信息，
     不能靠「消失」交代（CD-17）。内联形态（工作详情「变更」页签）是专门来看统计的地方，不适用。 */
  const nothingToReport = !inline && (diff === null
    ? error === null
    : changed !== null && changed.totalFiles === 0 && !incomplete);
  if (nothingToReport) return null;

  let line: string;
  let totals: { readonly added: number; readonly removed: number } | null = null;
  if (diff === null) {
    // 只有读取失败会走到这里：读取中与「完整且空」都在上面早退了。
    line = "本次对话 · 文件变化统计不可用";
  } else if (!diff.available) {
    line = UNAVAILABLE_TEXT[diff.reason] ?? "本次对话 · 文件变化不可统计";
  } else {
    line = `本次对话 · ${diff.totalFiles} 个文件`;
    totals = { added: diff.totalAdded, removed: diff.totalRemoved };
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
  const entryLine = <>
    <span className="conversation-diff-line">{line}</span>
    {/* 数字各自成节点：新增用 diff 绿、删除用 diff 红（设计系统 §9.15），
        同时保留 `+ / −` 符号与「新增 N 行，删除 M 行」的可访问名，不只靠颜色。 */}
    {totals !== null && <>
      <span className="conversation-diff-add" data-metric="added">+{totals.added}</span>
      <span className="conversation-diff-remove" data-metric="removed">−{totals.removed}</span>
      <span className="visually-hidden">新增 {totals.added} 行，删除 {totals.removed} 行</span>
    </>}
    {changed !== null && incomplete && <span className="conversation-diff-flag"
      data-testid="conversation-diff-flag">{incompleteFlag(changed)}</span>}
    {stale && <span className="conversation-diff-stale" data-testid="conversation-diff-stale">
      更新失败 · 截至 {readAt === null ? "未知时刻" : timeText(readAt)}</span>}
  </>;

  const panel = <div id={panelId} className="conversation-diff-panel" data-testid="conversation-diff-panel">
      <p className="conversation-diff-panel-title" data-testid="conversation-diff-panel-title">
        {scope === "DIRECTORY" ? "本次对话期间该目录的变化" : "本次对话的文件变化"}</p>
      {changed !== null ? <>
        <p className="helper-text">统计起点 <time dateTime={changed.baselineCapturedAt}>{timeText(changed.baselineCapturedAt)}</time>
          {" "}· 目录 <span className="conversation-diff-root" title={changed.rootPath}>{changed.rootPath}</span></p>
        <p className="helper-text">{changed.scope === "SESSION"
          ? "只统计本会话写入的文件；同一目录里其他程序或其他会话的同期修改不计入。"
          : "包含该目录自基线起的同期修改，不代表全部由 Agent 产生。"}</p>
        {changed.totalFiles === 0
          ? <p className="helper-text" data-testid="conversation-diff-empty">
            {incomplete ? "没有可统计的文件变化；本次统计不完整，具体缺口见下。" : "本次对话暂无文件变化。"}</p>
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
                  path={file.path} revisionKey={`${revisionKey}:${file.action}`} scope={scope} />}
              </li>;
            })}
          </ul>}
        {incomplete && <div className="conversation-diff-incomplete" data-testid="conversation-diff-incomplete">
          <p className="conversation-diff-incomplete-title">本次统计不完整，具体是：</p>
          <ul className="conversation-diff-incomplete-list">
            {incompleteLines(changed).map((text) => <li key={text}>{text}</li>)}
          </ul>
          <p className="helper-text">上面的总数只包含可核对的部分，不冒充完整差异；总数口径仍是
            {" "}「会话起点 → 当前已落盘内容」。</p>
        </div>}
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
  </div>;

  /* 内联形态（工作详情页签内）：没有「展开／收起」入口，清单直接摊开；
     数据来源、范围与缺口措辞与对话入口完全一致，不另建一套统计。 */
  if (inline) {
    return <div className="conversation-diff conversation-diff--inline" data-region="conversation-diff"
      data-scope={scope}>{panel}</div>;
  }

  return <div className="conversation-diff" data-region="conversation-diff" data-scope={scope}
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
      {entryLine}
      {!open && <span className="conversation-diff-hint" aria-hidden="true">展开</span>}
    </button>
    {open && panel}
  </div>;
}
