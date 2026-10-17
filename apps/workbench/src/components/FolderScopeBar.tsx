import { useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import AppDialog from "./AppDialog";
import FolderScope from "./FolderScope";
import type { RelayWorkingDirectory } from "../api/relayClient";
import type { RecentWorkingDirectory } from "../lib/recentWorkingDirectories";
import "./FolderScopeBar.css";

/**
 * 文件夹作用域细条（协作页 §3.3）。
 *
 * 原先是消息区上方一块可折叠的 `details`：展开体量大，折叠后又只剩一行摘要，
 * 位置还压在首屏最显眼的地方。现在收成输入卡上方的常驻一行——目录是执行准入的前提，
 * 不是发送选项，因此它必须一直可见，但不能占掉首屏。
 *
 * 本组件只呈现事实与转发动作：
 * - 打开目录的写命令、错误呈现、草稿保护与归属命令仍由协作页统一持有（`onOpen`）。
 * - 告警文案由协作页传入，本组件不改写任何 `disabled-reason` 语义。
 * - 「更换目录」走 AppDialog，不新开路由，也不在细条内做第二套目录状态。
 */
export default function FolderScopeBar({ directory, recents, busy, error,
  associationLabel, warning, boundDirectoryPath = null, onOpen, onNewConversation }: {
  readonly directory: RelayWorkingDirectory | null;
  readonly boundDirectoryPath?: string | null;
  readonly recents: readonly RecentWorkingDirectory[];
  readonly busy: boolean;
  /** 目录打开失败的真实原因；不显示它，用户只会以为「点了没反应」。 */
  readonly error: string | null;
  /** 「已归入项目：X」或「未归属」——归属是服务端事实，这里只显示。 */
  readonly associationLabel: string;
  /** 未就绪或未归属时的整条告警；null 表示常态。文案原文由协作页给出。 */
  readonly warning: string | null;
  readonly onOpen: (rootPath: string, projectId?: string | null) => void;
  readonly onNewConversation: () => void;
}) {
  const [changing, setChanging] = useState(false);
  const notReady = directory !== null && directory.status === "NOT_READY";
  /**
   * 选定即关框：模态框留在屏上会挡住刚更新的细条，也会和协作页的草稿守卫弹层叠成两层。
   * 唯一例外是需要用户再选一次作用域（同一目录关联多个项目，或目录落在别人已受管的根之内）——
   * 候选按钮就在这个框里，关着它用户没法继续，所以那种结果要把框重新打开。
   */
  const submittedRoot = useRef<string | null>(null);
  function submit(rootPath: string, projectId?: string | null) {
    submittedRoot.current = rootPath;
    setChanging(false);
    onOpen(rootPath, projectId);
  }
  useEffect(() => {
    const root = submittedRoot.current;
    if (root === null || directory === null || directory.canonicalRoot !== root) return;
    submittedRoot.current = null;
    if (directory.candidates.length > 0) setChanging(true);
  }, [directory]);

  return <section className="folder-strip" data-testid="folder-scope-strip"
    data-state={warning === null ? "normal" : "warning"}>
    <p className="folder-strip-line">
      <FolderOpen aria-hidden="true" className="folder-strip-icon" />
      {/* 目录名过长时按本档省略，完整路径挂在 title 上：只有名字时无法核对是哪一个目录。 */}
      <span className="folder-strip-name" data-testid="folder-scope-options"
        title={directory?.canonicalRoot ?? boundDirectoryPath ?? undefined}>{directory?.displayName ?? boundDirectoryPath?.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) ?? "未选择目录"}</span>
      <span className="folder-strip-meta" data-testid="folder-scope-association">{associationLabel}</span>
      {/* 完整告警给读屏与 title；可见区只留「这件事的后果」，不复述归属那一句，
          避免同一事实在一行里说两遍。 */}
      {warning !== null && <span className="folder-strip-warning" role="status" title={warning}
        data-testid={notReady ? "folder-scope-not-ready" : "collab-unassigned-execution-hint"}>
        <span className="visually-hidden">{warning}</span>
        <span aria-hidden="true">{notReady ? "目录未就绪，暂不能执行写操作" : "执行前需归入项目"}</span>
      </span>}
      <button className="folder-strip-change" type="button" data-testid="folder-scope-change"
        aria-haspopup="dialog" disabled={busy} onClick={() => setChanging(true)}>更换目录</button>
    </p>
    {error !== null && <p className="action-error" role="alert" data-testid="folder-error">{error}</p>}

    <AppDialog open={changing} title="更换工作目录" size="lg"
      subtitle="选择一个本机文件夹作为当前工作目录" onClose={() => setChanging(false)}>
      <FolderScope state={{ directory, recents, busy }} onOpen={submit}
        onNewConversation={() => { setChanging(false); onNewConversation(); }} />
    </AppDialog>
  </section>;
}
