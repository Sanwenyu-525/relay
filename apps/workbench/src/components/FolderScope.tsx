import { useState } from "react";
import { FolderOpen, MessageSquarePlus } from "lucide-react";
import type { RelayWorkingDirectory } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { nativeFolderPickerAvailable, selectWorkingDirectory } from "../lib/desktopHost";
import type { RecentWorkingDirectory } from "../lib/recentWorkingDirectories";
import "./FolderScope.css";

/**
 * 工作台 §18.1 的文件夹入口。
 *
 * 本组件只负责「让用户选一个目录」和如实显示服务端返回的关联状态；
 * 打开目录的写命令、错误呈现与草稿保护由协作页统一持有。
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

  return <div className="folder-scope" data-testid="folder-scope">
    <div className="folder-scope-actions">
      <button className="primary-button" type="button" data-testid="collab-open-folder"
        disabled={busy || !pickerAvailable} onClick={() => void pick()}>
        <FolderOpen aria-hidden="true" />打开文件夹</button>
      <button className="secondary-button" type="button" data-testid="collab-new-conversation"
        disabled={busy} onClick={onNewConversation}>
        <MessageSquarePlus aria-hidden="true" />新对话</button>
    </div>
    {!pickerAvailable && <label className="field"><span className="field-label">本机已有绝对目录</span>
      <input data-testid="folder-manual-root" value={manualPath} disabled={busy} required
        onChange={(event) => setManualPath(event.target.value)} placeholder="D:\\Develop\\MyProject" /></label>}
    {!pickerAvailable && <button className="secondary-button" type="button" data-testid="folder-open-manual"
      disabled={busy || manualPath.trim() === ""} onClick={() => onOpen(manualPath.trim())}>打开这个目录</button>}
    {pickerError && <p className="action-error" role="alert" data-testid="folder-picker-error">{pickerError}</p>}

    {recents.length > 0 && <section className="folder-scope-recents" aria-label="近期文件夹">
      <h3>近期文件夹</h3>
      <ul>{recents.map((item) => <li key={item.canonicalRoot}>
        <button className="text-link" type="button" data-testid="collab-recent-folder"
          disabled={busy} onClick={() => onOpen(item.canonicalRoot)}>{item.displayName}</button>
        <span className="helper-text">{item.canonicalRoot}</span>
      </li>)}</ul>
    </section>}

    {directory?.status === "AMBIGUOUS" && <section className="folder-scope-ambiguous"
      data-testid="folder-ambiguous" role="group" aria-label="同一目录关联的项目">
      <p>这个实际目录已经关联了多个项目。先选定一个作用域再继续，不会另建第二个写 Owner。</p>
      <ul>{directory.candidates.map((candidate) => <li key={candidate.projectId}>
        <button className="secondary-button" type="button" disabled={busy}
          data-testid={`collab-folder-candidate-${candidate.projectId}`}
          onClick={() => onOpen(directory.canonicalRoot, candidate.projectId)}>{candidate.projectTitle}</button>
        <span className="helper-text">{candidate.projectArchived ? "项目已归档" : "项目可用"} · 目录 {candidate.resourceStatus}</span>
      </li>)}</ul>
    </section>}

    {directory !== null && directory.status === "NOT_READY" && <p className="disabled-reason" role="status"
      data-testid="folder-not-ready">{notReadyReason(directory)}</p>}

    {directory !== null && directory.status === "READY" && <p className="helper-text"
      data-testid="folder-write-readiness">{directory.writeReadiness.detail}</p>}
    <p className="helper-text">目录只是当前工作目录，不会自动读取整棵树、外发内容或开启任何权限。</p>
  </div>;
}

function notReadyReason(directory: RelayWorkingDirectory): string {
  switch (directory.reason) {
    case "PROJECT_ARCHIVED": return "这个目录关联的项目已归档。归档项目不会自动解档，也不能靠新建关联绕过。";
    case "RESOURCE_DISABLED": return "这个实际目录的受管资源已停用。需要先在受管资源中恢复，执行准入才会重新开放。";
    case "MULTIPLE_PROJECTS": return "同一实际目录关联了多个项目，请先选定作用域。";
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
