import { useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import FolderScope from "./FolderScope";
import type { RelayWorkingDirectory } from "../api/relayClient";
import type { RecentWorkingDirectory } from "../lib/recentWorkingDirectories";
import { useMenuDismiss } from "../lib/popoverMenu";
import { usePathTooltip } from "../lib/pathTooltip";
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
 * - 「更换目录」走锚在细条上的紧凑浮层，不新开路由，也不在细条内做第二套目录状态。
 *
 * 2026-10-18 用户指令「更换目录和未选择目录合并成一个按钮」：输入卡上方原先还有一行
 * 状态行（`ComposerStatusBar`）重复着同一件事，本轮两行合并——细条是唯一幸存的那一行，
 * 目录名本身就是入口（点它打开选择框），不再摆第二颗动作键。合并只动呈现与转发：
 * 颜色对比、省略与 title、告警语义、对话框行为一律照旧。
 *
 * 2026-10-18 第二轮：选择面从 `AppDialog`（40rem 居中大弹窗）换成锚在目录名上方的
 * 紧凑浮层。目录选择是「看一眼、点一行」的动作，不是需要占满注意力的一屏；弹窗把
 * 三行目录撑成半屏，用户每次换目录都要先扫一遍空白。浮层沿用「+」菜单那一套外壳
 * 语言（panel 圆角 + separator 细边 + floating 阴影 + popover 层级），宽度收到 18rem，
 * 内容与命令一概未动。
 */
export default function FolderScopeBar({ directory, recents, busy, error,
  associationLabel, warning, boundDirectoryPath = null,
  onOpen, onNewConversation }: {
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
  // 2026-10-18 用户指认「未选择目录的话用户不一定知道这是一个按钮」：这一枚键静止时没有任何
  // 可点线索（不描边不铺底，下划线只在悬停出现），而缺事实那一档写的「未选择目录」是个状态名词，
  // 读起来像提示不像入口。因此只有「还没有目录」这一档改成动作文案＋常驻虚线下划线（见 CSS）；
  // 已有目录名时它是事实主角，回到纯文本＋悬停下划线，不给真实目录名加装饰。
  const unnamed = directory === null && boundDirectoryPath === null;
  // 首帧还没有目录事实但打开命令在途：这一格必须说「正在打开」，不能把在途读成「未选择」。
  const opening = unnamed && busy;
  // 细条只写目录名，绝对路径在悬停/聚焦时浮出（2026-10-20 用户要求）。
  const currentPath = directory?.canonicalRoot ?? boundDirectoryPath;
  const { tooltipHandlers, tooltipNode } = usePathTooltip(() => currentPath);
  const stripRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // 浮层的关闭语义（点外面、Esc、打开别的浮层时独占）收口在 lib/popoverMenu，
  // 与「+」菜单、写入档位弹层同一套规矩；外壳包含触发键与浮层，点目录名自己不算「外面」。
  useMenuDismiss(changing, () => setChanging(false), stripRef);
  // 打开把焦点交给浮层，关闭再还给原来那颗键：Esc 关掉后光标停在目录名上，不落到 body。
  useEffect(() => {
    if (!changing) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus({ preventScroll: true });
    return () => { if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); };
  }, [changing]);
  /**
   * 选定即收：浮层留在屏上会挡住刚更新的细条，也会和协作页的草稿守卫弹层叠成两层。
   * 唯一例外是需要用户再选一次作用域（同一目录关联多个项目，或目录落在别人已受管的根之内）——
   * 候选按钮就在这个浮层里，收着它用户没法继续，所以那种结果要把浮层重新打开。
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

  return <section className="folder-strip" data-testid="folder-scope-strip" ref={stripRef}
    data-state={warning === null ? "normal" : notReady ? "warning" : "advisory"}>
    <p className="folder-strip-line">
      <FolderOpen aria-hidden="true" className="folder-strip-icon" />
      {/* 目录名过长时按本档省略，完整路径挂在 title 上：只有名字时无法核对是哪一个目录。
          目录名即入口（2026-10-18 合并）：点它打开更换目录浮层——这一行唯一的动作并进
          事实主角本身，静止时不描边不铺底，可点性由悬停下划线说出（见 CSS）。 */}
      <button className={`folder-strip-name${unnamed ? " folder-strip-name--action" : ""}`}
        type="button" data-testid="folder-scope-change"
        aria-haspopup="dialog" aria-expanded={changing} disabled={busy}
        {...tooltipHandlers}
        onClick={() => setChanging((open) => !open)}>{opening ? "正在打开目录…"
          : directory?.displayName ?? boundDirectoryPath?.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) ?? "选择工作目录"}</button>
      {tooltipNode}
      <span className="folder-strip-meta" data-testid="folder-scope-association">{associationLabel}</span>
      {/* 只有「Git 需要到仓库根才能授权」这一档在细条上露一个标记：它是可行动的信息，
          其余 Git 状态（已就绪／非仓库／停用／撤销）留在更换目录浮层里，不占这一行。 */}
      {directory !== null && directory.gitRead?.state === "REPO_ROOT_REQUIRED" &&
        <span className="folder-strip-git" data-testid="folder-strip-git"
          title={directory.gitRead.detail}>Git 只在仓库根授权</span>}
      {/* 完整告警给读屏与 title；可见区只留「这件事的后果」，不复述归属那一句，
          避免同一事实在一行里说两遍。
          2026-10-20 第五轮：未归入项目这一档降为 advisory——它是常态而非紧急故障，
          整条铺琥珀色、目录名跟着换色，会把普通状态长期读成高优先级告警（用户截图指认
          「信息拥挤、语义混杂」）。现在只有「目录未就绪」这一档（写操作真的被挡住）保留
          警示色；advisory 用中性前景，完整原因与去向仍在 visually-hidden 与 title 里。 */}
      {warning !== null && <span className="folder-strip-warning" role="status" title={warning}
        data-testid={notReady ? "folder-scope-not-ready" : "collab-unassigned-execution-hint"}>
        <span className="visually-hidden">{warning}</span>
        <span aria-hidden="true">{notReady ? "目录未就绪，暂不能执行写操作" : "执行前需归入项目"}</span>
      </span>}
    </p>
    {error !== null && <p className="action-error" role="alert" data-testid="folder-error">{error}</p>}

    {/* 紧凑浮层取代原来的 40rem 居中弹窗（2026-10-18 用户指令「弹窗太大了」）：
        没有标题栏、没有副标题，最近目录与动作行就是全部——面板自己不需要再解释一次
        「这是换目录」。可见标题省掉，身份挂在 aria-label 上，与触发键的 aria-haspopup 对上。 */}
    {changing && <div className="folder-scope-pop" ref={panelRef} role="dialog" tabIndex={-1}
      aria-label="更换工作目录">
      <FolderScope state={{ directory, recents, busy,
        currentPath: directory?.canonicalRoot ?? boundDirectoryPath }} onOpen={submit}
        onNewConversation={() => { setChanging(false); onNewConversation(); }} />
    </div>}
  </section>;
}
