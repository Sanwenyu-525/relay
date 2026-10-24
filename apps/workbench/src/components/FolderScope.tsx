import { useState } from "react";
import { FolderOpen, MessageSquarePlus } from "lucide-react";
import type { RelayWorkingDirectory } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { nativeFolderPickerAvailable, selectWorkingDirectory } from "../lib/desktopHost";
import { usePathTooltip } from "../lib/pathTooltip";
import type { RecentWorkingDirectory } from "../lib/recentWorkingDirectories";
import "./FolderScope.css";

/**
 * 工作台 §18.1 的文件夹入口。
 *
 * 本组件只负责「让用户选一个目录」和如实显示服务端返回的关联状态；
 * 打开目录的写命令、错误呈现与草稿保护由协作页统一持有。
 *
 * 2026-10-18 随宿主从 40rem 弹窗改成锚在目录名上方的紧凑浮层，这里按「一行一项」重排：
 * 上半是最近使用（点一行直接切换），下半是动作行（打开文件夹／新对话），中间一条分隔线。
 * 原先的两枚并排按钮、分区右侧的「点击直接切换」提示与候选行的第二行说明都收掉了，
 * 但每项的实际内容与可达性未减：完整路径挂 title，候选状态并进同一行的次要事实。
 * 2026-10-23 用户截图指令再删底部权限脚注（「新目录打开后可读取本目录文件…」）：
 * 就绪状态、写档位与 Git 只读在各目录自己那一行已经说清，底部不再常驻一段告知。
 * 2026-10-24 用户截图指令把最近使用行上的常驻路径也收掉：行内只留目录名，
 * 完整路径退回悬停／聚焦 tooltip——复用 usePathTooltip，与目录细条同一套浮出行为，
 * 不用原生 title（约 1 秒延迟、样式不可控，见 pathTooltip.tsx 头注）。
 * 同日第二轮指令删掉浮层顶部的完整路径行（悬停 tooltip 已可核对，不再两处重复），
 * 并收掉两段纯就绪宣告：写档位复述（芯片已显示档位名）与 Git 就绪（status · diff · log）；
 * 受阻与受限说明（缺连接、被占用、非仓库、需复核、要在仓库根打开）不是用户能推断的，保留。
 */
export default function FolderScope({ state, onOpen, onNewConversation }: {
  state: { readonly directory: RelayWorkingDirectory | null;
    readonly recents: readonly RecentWorkingDirectory[]; readonly busy: boolean };
  onOpen: (rootPath: string, projectId?: string | null) => void;
  onNewConversation: () => void;
}) {
  const [manualPath, setManualPath] = useState("");
  const [pickerError, setPickerError] = useState<string | null>(null);
  const pickerAvailable = nativeFolderPickerAvailable();
  const { directory, recents, busy } = state;

  async function pick() {
    setPickerError(null);
    try {
      const picked = await selectWorkingDirectory();
      // 取消选择返回 null：保留草稿，不当作失败，也不发任何命令。
      if (picked !== null) onOpen(picked);
    } catch (caught) { setPickerError(describeLiveError(caught).message); }
  }

  // 候选作用域在两种状态下都必须可选：AMBIGUOUS（同一目录多个项目）与
  // OVERLAPPING_OTHER_PROJECT（目录落在别的已受管根之内）。后者原先被漏掉：
  // 服务端返回了 candidates，界面却只显示一句「不就绪」，用户就此卡死。
  // 括号不可省：&& 的优先级高于 ||，漏掉就会让右半支在没有 null 保护时读 directory.status。
const needsScopeChoice = directory !== null && directory.candidates.length > 0 &&
    (directory.status === "AMBIGUOUS" ||
      (directory.status === "NOT_READY" && directory.reason === "OVERLAPPING_OTHER_PROJECT"));

  return <div className="folder-scope" data-testid="folder-scope">
    {recents.length > 0 && <section className="folder-scope-recents" aria-label="最近使用">
      <h3 className="folder-scope-label">最近使用</h3>
      <ul>{recents.map((item) => <li key={item.canonicalRoot}>
        <RecentFolderRow item={item} busy={busy} onOpen={onOpen} />
      </li>)}</ul>
    </section>}

    <div className="folder-scope-actions">
      {/* 没有原生选择器的宿主（浏览器／示例模式）不给一颗点了没反应的键：键如实禁用，
          原因与替代入口写在 title 与下方手动路径区里。 */}
      <button className="folder-scope-row" type="button" data-testid="collab-open-folder"
        disabled={busy || !pickerAvailable} onClick={() => void pick()}
        title={pickerAvailable ? "选择本机文件夹作为当前工作目录"
          : "这个宿主没有原生目录选择器，请在下方填写本机绝对路径"}>
        <FolderOpen aria-hidden="true" className="folder-scope-row-icon" />
        <span className="folder-scope-row-label">打开文件夹</span></button>
      <button className="folder-scope-row" type="button" data-testid="collab-new-conversation"
        disabled={busy} onClick={onNewConversation}>
        <MessageSquarePlus aria-hidden="true" className="folder-scope-row-icon" />
        <span className="folder-scope-row-label">新对话</span></button>
    </div>

    {!pickerAvailable && <label className="field folder-scope-manual">
      <span className="field-label">本机已有绝对目录</span>
      <input data-testid="folder-manual-root" value={manualPath} disabled={busy} required
        onChange={(event) => setManualPath(event.target.value)} placeholder="D:\\Develop\\MyProject" /></label>}
    {!pickerAvailable && <button className="secondary-button secondary-button--compact" type="button"
      data-testid="folder-open-manual"
      disabled={busy || manualPath.trim() === ""} onClick={() => onOpen(manualPath.trim())}>打开这个目录</button>}
    {pickerError && <p className="action-error" role="alert" data-testid="folder-picker-error">{pickerError}</p>}

    {needsScopeChoice && directory !== null && <section className="folder-scope-ambiguous"
      data-testid="folder-ambiguous" role="group" aria-label="同一目录关联的项目">
      <p className="folder-scope-reason">{directory.status === "AMBIGUOUS"
        ? "这个实际目录已经关联了多个项目。先选定一个作用域再继续，不会另建第二个写 Owner。"
        : "这个目录已经落在另一个项目的受管根之内。先选定作用域再继续，不会另建第二个写 Owner。"}</p>
      <ul>{directory.candidates.map((candidate) => <li key={candidate.projectId}>
        <button className="folder-scope-row" type="button" disabled={busy}
          data-testid={`collab-folder-candidate-${candidate.projectId}`}
          onClick={() => onOpen(directory.canonicalRoot, candidate.projectId)}>
          <span className="folder-scope-row-label">{candidate.projectTitle}</span>
          <span className="folder-scope-row-hint">{candidate.projectArchived ? "项目已归档" : "项目可用"} · 目录 {candidate.resourceStatus}</span>
        </button>
      </li>)}</ul>
    </section>}

    {directory !== null && directory.status === "NOT_READY" && <p className="disabled-reason" role="status"
      data-testid="folder-not-ready">{notReadyReason(directory)}</p>}

    {/* 写就绪只报受阻与受限（缺连接、被占用、无权限、只读…）；档位本身芯片已显示，
        2026-10-24 用户指令不再复述「已具备/已开放」这类正常状态。 */}
    {directory !== null && directory.status === "READY" &&
      directory.writeReadiness.status !== "READY" && <p className="helper-text"
      data-testid="folder-write-readiness">{directory.writeReadiness.detail}</p>}
    {/* Git 只读随目录成立（2026-10-20，P1-3）。2026-10-24 用户指令收掉纯就绪宣告：
        只有受限与例外（非仓库、停用、撤销、需复核、子目录要在仓库根打开）才值得占一行，
        其中「在仓库根打开」是唯一可行动入口，保留原地。 */}
    {directory !== null && directory.status === "READY" && directory.gitRead !== null &&
      directory.gitRead.state !== "READY" &&
      <p className="helper-text folder-scope-git" data-testid="folder-git-read"
        data-git-state={directory.gitRead.state}>
        {directory.gitRead.state === "REPO_ROOT_REQUIRED" && directory.gitRead.repoRoot !== null
          ? <>{directory.gitRead.detail}{" "}
            <button className="text-link" type="button" disabled={busy}
              data-testid="folder-git-open-root"
              onClick={() => onOpen(directory.gitRead!.repoRoot!, directory.association?.projectId ?? null)}>
              在仓库根打开</button></>
          : directory.gitRead.detail}
      </p>}
  </div>;
}

/** 最近使用行：每行一个 usePathTooltip 实例——hook 的取值函数是单值的，
 *  多行共享一个实例无法区分悬停的是哪一行。busy 禁用的瞬间不出提示，与原生 title 一致。 */
function RecentFolderRow({ item, busy, onOpen }: {
  item: RecentWorkingDirectory; busy: boolean;
  onOpen: (rootPath: string, projectId?: string | null) => void;
}) {
  const { tooltipHandlers, tooltipNode } = usePathTooltip(() => item.canonicalRoot);
  return <>
    <button className="folder-scope-row" type="button" data-testid="collab-recent-folder"
      disabled={busy} onClick={() => onOpen(item.canonicalRoot)} {...tooltipHandlers}>
      <FolderOpen aria-hidden="true" className="folder-scope-row-icon" />
      <span className="folder-scope-row-label">{item.displayName}</span>
    </button>
    {tooltipNode}
  </>;
}

function notReadyReason(directory: RelayWorkingDirectory): string {
  switch (directory.reason) {
    case "PROJECT_ARCHIVED": return "这个目录关联的项目已归档。归档项目不会自动解档，也不能靠新建关联绕过。";
    case "RESOURCE_DISABLED": return "这个实际目录的受管资源已停用。需要先在受管资源中恢复，执行准入才会重新开放。";
    case "MULTIPLE_PROJECTS": return "同一实际目录关联了多个项目，请先选定作用域。";
    case "OVERLAPPING_OTHER_PROJECT":
      // 这个原因码最容易被当成故障：目录本身有效，只是落在别人已经受管的根之内。
      // 不解释清楚，用户只会看到「不就绪」然后不知道该选哪个项目。
      return "这个目录落在另一个已受管根之内或包含它。先选定作用域，不会另建第二个写 Owner。";
    default: return "目录尚未就绪；当前可以继续普通讨论，但不能对项目文件执行写操作。";
  }
}

/** 目录关联成功后才进本机近期列表；它是展示偏好，不是资源身份或授权事实。 */
export function rememberOpened(directory: RelayWorkingDirectory,
  current: readonly RecentWorkingDirectory[]): readonly RecentWorkingDirectory[] {
  if (directory.status !== "READY") return current;
  const next = [{ canonicalRoot: directory.canonicalRoot, displayName: directory.displayName,
    openedAt: new Date().toISOString() },
  ...current.filter((item) => item.canonicalRoot !== directory.canonicalRoot)];
  try { window.localStorage.setItem("relay.workbench.recentWorkingDirectories",
    JSON.stringify({ version: 1, entries: next.slice(0, 8) })); }
  catch { /* 偏好写不进去不影响服务端关联。 */ }
  return next;
}
