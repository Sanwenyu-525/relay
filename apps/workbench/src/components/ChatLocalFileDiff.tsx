import { useEffect, useRef, useState } from "react";
import { FilePen } from "lucide-react";
import FileWriteFrozenDiffPanel from "./FileWriteFrozenDiffPanel";
import type { RelayApiClient } from "../api/relayClient";
import type { RelayFileWriteChangeSet, RelayFileWriteFrozenDiff } from "../api/relayClient";
import type { LocalFileDiffPhase, LocalFileDiffRow } from "../lib/localFileDiffRows";

/**
 * 聊天里「具体文件编辑记录」旁的局部增删行（工作台 §34.2 / §34.4，CD-01、CD-11、CD-12、CD-18）。
 *
 * 一行＝该次编辑在该文件上的事实，按原工具调用身份逐条产生，所以同一个文件被改三次留下三条，
 * 后来的编辑不重写旧记录。数字只来自两个同源出口：
 *   * 已结算 → 逐文件账本 `fileChanges`（唯一可以写「已修改」的来源）；
 *   * 生成中 → 临时参数预览，文案带「预览」，绝不进入总数、也绝不写成已落盘。
 * 待核对、待应用、失败与不可统计都不画 `+0 −0`：没有可核对的数字就只说没有。
 *
 * 展开正文（CD-18）沿用既有只读入口——按原 operation_id 读冻结的前后文本与逐文件账本，
 * 不新造第二套历史；读不到（含失权）就只说读不到，正文一律不显示。
 */

const PHASE_TEXT: Record<LocalFileDiffPhase, string> = {
  generating: "正在生成",
  waitingApproval: "待应用",
  applied: "已修改",
  failed: "写入未成功",
  pendingVerify: "结果待核对",
};

const APPLIED_ACTION_TEXT: Record<LocalFileDiffRow["action"], string> = {
  CREATE: "已新增",
  MODIFY: "已修改",
  DELETE: "已删除",
  UNKNOWN: "已修改",
};

/** 不可统计原因的说明文案：原因码来自服务端，未知原样回显，不编造解释。 */
export function localDiffReasonText(reason: string | null): string {
  if (reason === null) return "";
  const labels: Record<string, string> = {
    BINARY: "二进制内容，不统计行数",
    TEXT_TOO_LARGE: "文本超过统计上限",
    UNREADABLE: "无法安全读取",
    BASELINE_TEXT_UNAVAILABLE: "缺少会话起点文本",
    CURRENT_TEXT_UNAVAILABLE: "当前内容不可读",
    MODIFY_BASELINE_UNAVAILABLE: "缺少可比对的原文，行数待核对",
    RESULT_UNVERIFIED: "结算结果待核对，不宣布已修改",
    DIFF_TOO_LARGE: "差异规模超出展开上限，正文不展开",
    CURRENT_SWEEP_INCOMPLETE: "本轮扫描没核对到这个文件，不能判定已删除",
    BASELINE_SWEEP_INCOMPLETE: "会话起点没覆盖到这个文件，无法确认是本会话新增",
  };
  return `不可统计：${labels[reason] ?? reason}`;
}

function stateText(row: LocalFileDiffRow): string {
  return row.phase === "applied" ? APPLIED_ACTION_TEXT[row.action] : PHASE_TEXT[row.phase];
}

/** 数字两侧都要有可访问名：只靠颜色或 `+ / −` 符号不足以传达含义（设计系统 §9.15）。 */
function metricsAriaName(row: LocalFileDiffRow): string {
  if (row.added === null && row.removed === null) {
    return row.preview ? "行数待核对：目标尚未收全或缺少可比对的基线" : "行数待核对";
  }
  return [row.added !== null ? `新增 ${row.added} 行` : "新增行数待核对",
    row.removed !== null ? `删除 ${row.removed} 行` : "删除行数待核对"].join("，");
}

/** 逐文件正文：按原 operation_id 读冻结前后文本；迟到响应与失权都不落正文。 */
function LocalDiffBody({ client, row }: { client: RelayApiClient; row: LocalFileDiffRow }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [diff, setDiff] = useState<RelayFileWriteFrozenDiff | null>(null);
  const [ledgers, setLedgers] = useState<readonly RelayFileWriteChangeSet[]>([]);
  const requestId = useRef(0);

  useEffect(() => {
    // 收起、换行或卸载都要让在途读取作废：迟到的正文不能复活到别的编辑行上（CD-13）。
    if (!open) { setDiff(null); setLedgers([]); setFailure(null); setLoading(false); }
    requestId.current++;
  }, [open, row.key]);

  useEffect(() => {
    if (!open || row.operationId === null || diff !== null) return;
    const current = ++requestId.current;
    setLoading(true); setFailure(null);
    void Promise.all([client.getFileWriteFrozenDiff(row.operationId),
      client.getFileWriteChangeSets(row.operationId)]).then(([frozen, sets]) => {
      if (current !== requestId.current) return;
      setDiff(frozen); setLedgers(sets);
    }).catch(() => {
      if (current !== requestId.current) return;
      // 只说明读不到，不复述服务端消息细节：失权与目录变化都以「正文不可用」呈现。
      setFailure("这次编辑的前后正文当前读不到（权限或目录变化时不会显示正文）。");
    }).finally(() => { if (current === requestId.current) setLoading(false); });
  }, [open, row.key, row.operationId, client, diff]);

  if (row.operationId === null || row.phase === "generating") return null;
  const bodyId = `local-file-diff-body-${row.key.replace(/[^\w.-]/gu, "_")}`;
  return <>
    <button className="text-link local-file-diff-toggle" type="button" aria-expanded={open}
      aria-controls={bodyId} data-testid={`local-file-diff-toggle-${row.key}`}
      onClick={() => setOpen((previous) => !previous)}>{open ? "收起这次编辑前后" : "查看这次编辑前后"}</button>
    {open && <div id={bodyId} data-testid={`local-file-diff-body-${row.key}`}>
      {loading && <p className="helper-text" role="status">正在读取这次编辑的前后文本…</p>}
      {failure !== null && <p className="action-error" role="alert">{failure}</p>}
      {!loading && diff !== null &&
        <FileWriteFrozenDiffPanel diff={diff} ledgers={ledgers} />}
    </div>}
  </>;
}

/** 超过这个行数后列表限高、框内滚动（页面原型 V5.26「文件列表限高滚动」）：
    逐文件行是一条条一行的紧凑记录，长任务几十条时不再把消息列撑成几屏长。 */
const CAP_ROWS = 10;

export default function ChatLocalFileDiff({ client, rows }: {
  client: RelayApiClient;
  rows: readonly LocalFileDiffRow[];
}) {
  if (rows.length === 0) return null;
  const capped = rows.length > CAP_ROWS;
  return <>
    {capped && <p className="helper-text" data-testid="local-file-diff-capped-note">
      共 {rows.length} 条编辑记录；列表在框内滚动查看。</p>}
    <ul className="local-file-diff-list" data-testid="local-file-diff-list"
      aria-label="本次编辑的逐文件增删行" data-capped={capped ? "true" : undefined}
      tabIndex={capped ? 0 : undefined}>
    {rows.map((row) => <li key={row.key} className="local-file-diff" data-phase={row.phase}
      data-preview={row.preview} data-testid={`local-file-diff-${row.key}`}>
      {/* 图标与状态词都不靠颜色单独表意：形状（笔）+ 文字（已修改/正在生成/…）同时在场，
          metrics 另有 visually-hidden 可访问名（§9.15）。 */}
      <span className="local-file-diff-glyph" aria-hidden="true"><FilePen /></span>
      <span className="local-file-diff-state">{stateText(row)}</span>
      {/* 路径可截断，数字不跟着被截断（设计系统 §9.15）：省略只作用在文件名这一项。 */}
      <span className="local-file-diff-path" title={row.path}>{row.fileName}</span>
      {row.preview && <span className="local-file-diff-tag">预览</span>}
      <span className="local-file-diff-metrics">
        {row.added !== null && <span className="local-file-diff-add" data-metric="added">+{row.added}</span>}
        {row.removed !== null &&
          <span className="local-file-diff-remove" data-metric="removed">−{row.removed}</span>}
        <span className="visually-hidden">{metricsAriaName(row)}</span>
      </span>
      {!row.targetComplete && row.phase === "generating" &&
        <span className="local-file-diff-note">目标未收全</span>}
      {row.truncated && <span className="local-file-diff-note">预览已截断</span>}
      {row.unavailableReason !== null && row.phase !== "applied" &&
        <span className="local-file-diff-note" data-testid={`local-file-diff-reason-${row.key}`}>
          {localDiffReasonText(row.unavailableReason)}</span>}
      <LocalDiffBody client={client} row={row} />
    </li>)}
    </ul>
  </>;
}
