import { type ReactNode } from "react";
import {
  ChevronRight, Circle, CircleCheck, CircleX, File, FileCode2, FileCog, FileImage,
  FileSpreadsheet, FileText, FolderOpen, Hourglass, LoaderCircle, TriangleAlert,
} from "lucide-react";
import type { ActivityItem } from "../lib/activityPresentation";
import { formatActivityDuration } from "../lib/activityPresentation";
import "./ActivityRow.css";

/**
 * 统一活动行（2026-10-29 V3 重构）。
 *
 * 参照效果图的行 anatomy 收敛为**五个固定位置**：
 *
 *   [状态图标] 动作 · 对象 ........................ 状态词 · 耗时  [展开]
 *
 * 与 V2 的关键差别：
 *   * 左端图标从「类别图标」换成**状态图标**（空心圆 / 旋转弧 / 对勾 / 叉 / 警示 / 沙漏）。
 *     效果图里同一列始终在回答「这一项现在怎么样」，而动作类型已经由动作词说清楚；
 *     两枚图标并排只会让 50 行列表变成一排彩色装饰。
 *   * 状态先由**文字**说清（`stateText`），图标与颜色只做第二层；灰度、关动效、
 *     屏幕阅读器读到的是同一件事。
 *   * 行与行之间用一条极浅的连接线串成纵向时间线，连接线挂在状态图标列上，
 *     因此它只表达「这些是同一条轨迹」，不承担分组。
 *   * `SETTLED` 只表示已结算：回执说失败时图标换成叉、颜色换红，绝不给对勾。
 *
 * 展开是受控的：组件不持有开合状态，谁渲染谁决定，避免「用户展开后被事件更新收回」。
 */

/** 状态 → 图标。这里是全站唯一一处把状态折成图形的地方。 */
function StatusIcon({ item, live }: { readonly item: ActivityItem; readonly live: boolean }) {
  if (item.detail.failed) return <CircleX aria-hidden="true" />;
  switch (item.state) {
    case "REJECTED":
    case "ABANDONED":
      return <CircleX aria-hidden="true" />;
    case "UNKNOWN":
      return <TriangleAlert aria-hidden="true" />;
    case "WAITING_APPROVAL":
      return <Hourglass aria-hidden="true" />;
    case "SETTLED":
      return <CircleCheck aria-hidden="true" />;
    default:
      // 在途：唯一允许转动的那一个。`live` 为 false 时是静止的空心圆，
      // 让「整份列表只有一个主进度动效」成为结构保证而不是样式巧合。
      return live ? <LoaderCircle className="activity-item-spin" aria-hidden="true" />
        : <Circle aria-hidden="true" />;
  }
}

/**
 * 路径拆成「目录 / 文件名」两段：文件名是主信息，目录退到次级色。
 * 没有分隔符或不是路径时整段按主信息显示，不做猜测性切分。
 */
function targetParts(target: string): { readonly dir: string; readonly name: string } {
  const cut = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
  if (cut <= 0 || cut === target.length - 1) return { dir: "", name: target };
  return { dir: target.slice(0, cut + 1), name: target.slice(cut + 1) };
}

/**
 * 文件类型（2026-11-10）。
 *
 * 只按**扩展名**分类：这是用户自己就认识的规则，不需要读取文件、也不猜内容。
 * 分类只影响对象前的 12px 图标与其颜色，文件名保持次级文字色——颜色是第二层，
 * 一行一行标成彩色正文会让 50 行过程变成调色盘，还会压过真正回答状态的左列图标。
 * 目录与 `list_directory` 的对象用文件夹图标；取不到扩展名时不画图标，不硬猜。
 */
type FileKind = "code" | "doc" | "config" | "data" | "image" | "folder" | "file";

const FILE_KINDS: readonly { readonly kind: FileKind; readonly extensions: readonly string[] }[] = [
  // 顺序有意义：同名扩展名只归第一类（例如 .sql 归代码，不归数据）。
  { kind: "code", extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs",
    "java", "kt", "c", "h", "cpp", "cc", "cs", "rb", "php", "sh", "ps1", "sql", "css",
    "scss", "less", "html", "vue", "svelte", "swift", "dart", "lua", "toml"] },
  { kind: "doc", extensions: ["md", "mdx", "txt", "rst", "adoc", "pdf", "doc", "docx", "rtf"] },
  { kind: "config", extensions: ["json", "jsonc", "json5", "yaml", "yml", "ini", "env",
    "conf", "config", "properties", "lock"] },
  { kind: "data", extensions: ["csv", "tsv", "xlsx", "xls", "parquet", "db", "sqlite", "ndjson"] },
  { kind: "image", extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "avif", "bmp"] },
];

function fileKindOf(target: string, isDirectory: boolean): FileKind | null {
  if (target === "" || target.includes("://")) return null;
  if (isDirectory || /[\\/]$/u.test(target)) return "folder";
  const name = targetParts(target).name;
  const dot = name.lastIndexOf(".");
  // 点开头的是隐藏文件（.gitignore 这类），它没有可读的扩展名身份：按普通文件处理。
  if (dot <= 0 || dot === name.length - 1) return name.startsWith(".") ? "file" : null;
  const extension = name.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]{1,8}$/u.test(extension)) return null;
  for (const group of FILE_KINDS) {
    if (group.extensions.includes(extension)) return group.kind;
  }
  return "file";
}

/** 类型 → 图标。与状态图标分列：状态回答「怎么样了」，这里回答「动的是哪类文件」。 */
function FileKindIcon({ kind }: { readonly kind: FileKind }) {
  if (kind === "folder") return <FolderOpen className="activity-item-filetype" aria-hidden="true" />;
  if (kind === "code") return <FileCode2 className="activity-item-filetype" aria-hidden="true" />;
  if (kind === "doc") return <FileText className="activity-item-filetype" aria-hidden="true" />;
  if (kind === "config") return <FileCog className="activity-item-filetype" aria-hidden="true" />;
  if (kind === "data") return <FileSpreadsheet className="activity-item-filetype" aria-hidden="true" />;
  if (kind === "image") return <FileImage className="activity-item-filetype" aria-hidden="true" />;
  return <File className="activity-item-filetype" aria-hidden="true" />;
}

export interface ActivityRowProps {
  readonly item: ActivityItem;
  /** 第三层技术详情；不传就不渲染展开控件（没有内容可展开时不摆一个点开是空的按钮）。 */
  readonly detail?: ReactNode;
  readonly expanded?: boolean;
  readonly onToggle?: () => void;
  readonly detailLabel?: string;
  readonly testId?: string;
  /**
   * 是否是「此刻正在做的那一件」。整份列表只允许一行为 true：
   * 只有它会转动，也只有它有浅蓝焦点底。
   */
  readonly current?: boolean;
  /**
   * 行下方的常显次要信息（如服务端给的拒绝原因）。
   * 它与第三层详情不同：不需要展开就能读到，因为它本身就是风险信息。
   */
  readonly note?: ReactNode;
}

export default function ActivityRow({ item, detail, expanded = false, onToggle,
  detailLabel, testId, current = false, note }: ActivityRowProps) {
  const { dir, name } = targetParts(item.target);
  const fileKind = fileKindOf(item.target, item.category === "LIST");
  const elapsed = formatActivityDuration(item.elapsedMs);
  const label = detailLabel ?? `${item.verb}${item.target === "" ? "" : ` ${item.target}`}`;
  const expandable = detail !== undefined && onToggle !== undefined;
  // 工具名不进可见行（参考图的行 anatomy 只有「动作 · 对象 · 状态 · 耗时」）：
  // 它留在 title 与第三层详情里，核对「模型到底调了什么」时展开一次就能看到。
  return <li className="activity-item" data-category={item.category} data-tone={item.tone}
    data-filetype={fileKind ?? undefined}
    title={item.verb === item.toolName ? undefined : `工具 ${item.toolName}`}
    data-state={item.state} data-source={item.source}
    data-failed={item.detail.failed ? "true" : undefined}
    data-current={current ? "true" : undefined}
    data-testid={testId}>
    <p className="activity-item-head">
      <span className="activity-item-status" data-tone={item.tone}
        data-failed={item.detail.failed ? "true" : undefined}>
        <StatusIcon item={item} live={current} />
      </span>
      <span className="activity-item-verb">{item.verb}</span>
      {item.target !== "" && <span className="activity-item-target">
        {fileKind !== null && <FileKindIcon kind={fileKind} />}
        {dir !== "" && <span className="activity-item-dir">{dir}</span>}
        <span className="activity-item-name">{name}</span>
      </span>}
      <span className="activity-item-meta">
        <span className="activity-item-state" data-status={item.state}
          data-quiet={item.state === "SETTLED" && !item.detail.failed ? "true" : undefined}>
          {item.stateText}</span>
        {elapsed !== "" && <span className="activity-item-elapsed">{elapsed}</span>}
      </span>
      {expandable && <button className="activity-item-toggle" type="button"
        aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}${label}的详情`}
        data-testid={testId === undefined ? undefined : `${testId}-toggle`}
        onClick={onToggle}>
        <ChevronRight aria-hidden="true" />
      </button>}
    </p>
    {note !== undefined && note !== null && <p className="activity-item-note">{note}</p>}
    {expandable && expanded && <div className="activity-item-detail" data-testid={testId === undefined
      ? undefined : `${testId}-detail`}>{detail}</div>}
  </li>;
}
