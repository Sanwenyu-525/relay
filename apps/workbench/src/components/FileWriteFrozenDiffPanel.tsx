import type { RelayFileWriteChangeSet, RelayFileWriteFrozenDiff } from "../api/relayClient";

type DiffLine = { kind: "context" | "remove" | "add"; before: number | null;
  after: number | null; text: string };

function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}

function displayLine(line: string): string {
  if (line.endsWith("\r\n")) return `${line.slice(0, -2)} ␍␊`;
  if (line.endsWith("\n")) return `${line.slice(0, -1)} ␊`;
  return `${line} ∅`;
}

/** Bounded line alignment; larger texts retain an exact side-by-side view. */
function alignedLines(beforeText: string, afterText: string): DiffLine[] | null {
  const before = linesOf(beforeText);
  const after = linesOf(afterText);
  if (before.length * after.length > 100_000 || before.length + after.length > 800) return null;
  const scores = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      scores[i][j] = before[i] === after[j] ? 1 + scores[i + 1][j + 1]
        : Math.max(scores[i + 1][j], scores[i][j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0; let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      result.push({ kind: "context", before: ++i, after: ++j, text: displayLine(before[i - 1]) });
    } else if (i < before.length && (j === after.length || scores[i + 1][j] >= scores[i][j + 1])) {
      result.push({ kind: "remove", before: ++i, after: null, text: displayLine(before[i - 1]) });
    } else {
      result.push({ kind: "add", before: null, after: ++j, text: displayLine(after[j - 1]) });
    }
  }
  return result;
}

const unavailableLabels: Record<string, string> = {
  BASELINE_UNAVAILABLE: "历史动作没有保存冻结基线原文",
  BASELINE_EVIDENCE_MISMATCH: "冻结基线证据与摘要不一致",
  TARGET_TEXT_UNAVAILABLE: "冻结目标原文缺失、过大或摘要不一致",
  TEXT_TOO_LARGE: "冻结基线原文超过文本证据上限",
  BINARY_OR_INVALID_UTF8: "冻结基线不是可展示的 UTF-8 文本",
  BASELINE_SHA_MISMATCH: "文件内容与冻结基线摘要不一致",
  ROOT_CHANGED: "受管根已改变，无法取得可信基线",
  PARENT_CHANGED: "目标父目录已改变，无法取得可信基线",
  TARGET_NOT_REGULAR: "目标不是普通文件，无法取得可信基线",
  UNSAFE_OR_UNREADABLE: "冻结基线无法安全读取"
};

export default function FileWriteFrozenDiffPanel({ diff, ledgers }: {
  diff: RelayFileWriteFrozenDiff; ledgers: readonly RelayFileWriteChangeSet[];
}) {
  const latestLedger = ledgers.at(-1);
  const ledgerStatus = new Map(latestLedger?.files.map((file) => [file.relativePath, file.status]));
  return <section className="file-write-frozen-diff" data-testid="file-write-frozen-diff">
    <h3>冻结计划文本差异</h3>
    <p className="helper-text">左侧来自准备动作时核验的冻结基线，右侧来自冻结目标；仅描述计划，不代表文件已应用。账本与当前磁盘状态仍以上方证据为准。</p>
    {diff.files.map((file) => {
      const rows = file.beforeText !== null && file.afterText !== null && file.availability === "AVAILABLE"
        ? alignedLines(file.beforeText, file.afterText) : null;
      return <section className="file-write-frozen-diff__file" key={file.relativePath}>
        <h4>{file.relativePath} · {file.action} · 账本 {ledgerStatus.get(file.relativePath) ?? "尚无记录"}</h4>
        {file.availability === "UNAVAILABLE" || file.beforeText === null || file.afterText === null
          ? <p className="disabled-reason">文本差异不可用：{unavailableLabels[file.unavailableReason ?? ""] ?? file.unavailableReason ?? "缺少可信原文"}。保留摘要证据，不从当前磁盘补造旧基线。</p>
          : rows === null
            ? <div className="file-write-frozen-diff__compare"><div><strong>冻结基线</strong><pre>{file.beforeText}</pre></div>
              <div><strong>冻结目标</strong><pre>{file.afterText}</pre></div>
              <p className="helper-text">文本较长，按原文对照展示，未逐行标注。</p></div>
            : <div className="file-write-frozen-diff__lines" role="table" aria-label={`${file.relativePath} 冻结计划文本差异`}>
              {rows.map((row, index) => <div className={`file-write-frozen-diff__line file-write-frozen-diff__line--${row.kind}`}
                role="row" key={`${index}-${row.kind}`}>
                <span role="cell" aria-label="基线行号">{row.before ?? ""}</span>
                <span role="cell" aria-label="目标行号">{row.after ?? ""}</span>
                <span role="cell" aria-label="差异标记">{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}</span>
                <span role="cell">{row.text}</span>
              </div>)}
            </div>}
      </section>;
    })}
  </section>;
}
