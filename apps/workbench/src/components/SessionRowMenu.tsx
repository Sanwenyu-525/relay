import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { Archive, Copy, GitFork, Mail, MailOpen, MoreHorizontal, Pencil, Pin, PinOff, RotateCcw, Trash2 } from "lucide-react";
import { createCommandId, type RelayApiClient, type RelayAssistSession } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { useMenuExclusive } from "../lib/popoverMenu";
import AppDialog from "./AppDialog";
import { escalateFeedback, openUndoFeedback } from "./Feedback";

/**
 * 会话改动只回这一行自身的事实（改名/置顶/未读/归档/重开），调用方据此收敛这一行。
 * 分叉是唯一例外：这一行没变，变的是「多了一条会话」，因此带上那次新建的会话身份（0113）。
 * 删除不带身份：这一行已经不存在，调用方要从两个分区同时摘掉它（ADR-027）。
 */
export type SessionRowPatch =
  | { readonly kind: "title" }
  | { readonly kind: "pin" }
  | { readonly kind: "unread" }
  | { readonly kind: "archive" }
  | { readonly kind: "reopen" }
  | { readonly kind: "delete" }
  | { readonly kind: "fork"; readonly forkedSessionId: string };

/** 行本体右键时调用方拿来展开同一个面板的命令式入口。 */
export interface SessionRowMenuHandle {
  open: () => void;
}

/** 服务端标题上限（shared/text.ts 的 title）；本地先挡一次，省一趟必然 422 的往返。 */
const TITLE_LIMIT = 200;

/** 浮层离视口边缘的留边取 space.2（8px）。 */
const MARGIN_PX = 8;
/**
 * 浮层与触发器之间的间距收到 space.1（4px），与上游 Radix 下拉的 sideOffset 同一档：
 * ⋯ 的图标只有 20px，压在 32px 的控件框里，原来那档 8px 再加面板 4px 内边距，
 * 从点字到第一条读起来隔了约 19px（2026-10-18 用户指认「竖直方向离三个点太远」）。
 */
const GAP_PX = 4;

/**
 * 剪贴板里带 scheme 而不是裸 ID（`relay://sessions/<id>`）：粘到别处仍读得出这是 Relay 的哪条会话。
 * 本机没有注册 `relay://` 协议入口，所以这只是文本身份，粘回来不会自动打开会话。
 */
const SESSION_URI_PREFIX = "relay://sessions/";

/**
 * 近期工作栏里一条会话的行内操作（工作台 §28.9、迁移 0090）。
 *
 * 四个形状不是随手选的：
 *
 * 1. **触发器与行按钮平级，但不是行按钮的子节点。** 行本体是 `<button>`，按钮里不能套按钮，
 *    套进去点击会落到行上；两者同属 `.recent-work-row-head`，⋯ 才能贴着行右缘悬浮，
 *    而 `inset-block-start: 50%` 相对的是行本身——展开浮层不再把 50% 拉到「行 + 面板」的中线。
 * 2. **面板是 `position: fixed` 的浮层，不在行下方就地展开。** 2026-10-16 第五轮按用户指认
 *    改掉了首版「就地展开」：就地展开会把这一行以下整列推下去，菜单本身也读不成一个下拉。
 *    这一列在滚动容器里，绝对定位会被裁掉；祖先链上没有 `transform` / `filter` / `contain`，
 *    所以 `fixed` 不会退化成相对某个祖先定位，不需要 portal。坐标由 JS 按触发器实测位置摆放，
 *    放不下时向上翻，横向拉回视口内；滚动或点到别处即收起，固定坐标不会停在旧位置。
 * 3. **改名用面板里的一行输入，不开对话框。** 改的就是这一行正在显示的那个名字，
 *    换一层窗口会让人分不清在改哪一条。
 * 4. **冲突就重读、结果不明就不重发。** `REVISION_CONFLICT` 说明服务端已有更新的事实：
 *    只把这条会话重新读回来，交给人对着新值重新决定；`RelayTransportError` 代表
 *    **本次是否生效尚未确定**，绝不换一枚 command_id 再发一次，只能按原命令查回执。
 *    成功后也不本地拼结果：让调用方重读这一条，行显示的始终是服务端事实。
 * 5. **动作按图标 + 分组排布（2026-10-16，用户提供参考菜单截图）。** 置顶／取消置顶与重命名
 *    各带一枚图标归为一组，中间一根分组细线，归档收尾并保持状态色——与参考菜单
 *    「置顶／重命名 → 分隔 → 归档／删除」同一读法：常用改动在上，带不可逆读感的收尾。
 *    图标尺寸取 `font.size.body` 而不是 `control.icon.size`：与输入器「+」弹层、悬停摘要卡
 *    同一档，20px 图标压在 14px 选项名旁会比文字还重。上游可对照 ZCode 的
 *    `TaskActionMenuContent`（Item／Separator 原语注入、禁用带原因）与 opencode 侧栏行内
 *    归档；本机已落地的浮层条目语言是 `.agent-chat-attach-item`。参考图里的分享任务、
 *    独立窗口、批量操作与删除任务在本项目没有对应命令，不占位。
 * 6. **复制会话 ID 不走命令，未读走同一条 CAS（2026-10-17）。** 复制是纯客户端动作：
 *    它没有服务端事实，因而不参与 `run` 的冲突重读，也不推进修订。标记未读与置顶同形，
 *    两个方向共用一个端点；它只改导航标记，不改变能不能发消息、绑哪个目录。
 * 7. **右键整行开的是这一个面板（2026-10-18）。** 调用方经 `ref.open()` 进来，锚点仍是 ⋯，
 *    不跟指针落点走——同一行只维护一套摆位几何。
 * 8. **分叉给的是另一条会话（0113，2026-10-18 用户指令）。** 服务端把这段讨论连历史复制成
 *    一条新会话，标题编号（1）（2）由服务端决定，界面不自己拼；回执里的会话身份是**新建的子会话**，
 *    源会话一行都没改，所以成功后不重读源行，而把子会话读回这一列。归档态的会话只有「重开」一项，
 *    分叉同改名/置顶一样被服务端拒掉，这里就不出现。
 */
export default function SessionRowMenu({ client, session, onChanged, onStale, onOpenChange, ref }: {
  client: RelayApiClient;
  session: RelayAssistSession;
  onChanged: (patch: SessionRowPatch) => void;
  onStale: () => void;
  /** 开合变化时通知调用方：同一时刻这一行只出一个浮层（摘要卡让位给操作面板）。 */
  onOpenChange?: (open: boolean) => void;
  /** 行本体右键时由调用方（RecentWorkRow）拿来展开同一个面板。 */
  ref?: Ref<SessionRowMenuHandle>;
}) {
  const [panel, setPanel] = useState<"none" | "actions" | "rename">("none");
  const [draft, setDraft] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** 删除回执不明时不再给「再删一次」：换 command_id 重发违反契约，必须按原 ID 查回执。 */
  const [deleteUncertain, setDeleteUncertain] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const [placed, setPlaced] = useState<CSSProperties | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const archived = session.status === "ARCHIVED";
  const pinned = session.pinnedAt !== null;
  const unread = session.unreadAt !== null;
  const open = panel !== "none";

  function openPanel() { setDraft(session.title); setError(null); setCopied(false); setPanel("actions"); }
  useImperativeHandle(ref, () => ({ open: openPanel }));

  useEffect(() => { if (panel === "rename") inputRef.current?.focus(); }, [panel]);
  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);
  // 行外面板是浮层：自身的外部按下/滚动/Esc 都在下方处理，这里只挂独占——
  // 打开输入器上的任何浮层（「+」、档位、模型）时都把它收掉，两列浮层不互相压。
  useMenuExclusive(open, () => setPanel("none"));
  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  // 面板按触发器的实测位置摆放：优先开在下方，放不下向上翻；横向与右缘对齐并拉回视口内。
  useLayoutEffect(() => {
    if (!open) { setPlaced(null); return; }
    const place = () => {
      const element = panelRef.current;
      const trigger = triggerRef.current;
      if (element === null || trigger === null) return;
      const box = trigger.getBoundingClientRect();
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const left = Math.max(MARGIN_PX, Math.min(box.right - width, window.innerWidth - MARGIN_PX - width));
      const below = box.bottom + GAP_PX;
      setPlaced({ left, top: below + height <= window.innerHeight - MARGIN_PX ? below
        : Math.max(MARGIN_PX, box.top - GAP_PX - height) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, panel]);

  // 固定坐标不跟随滚动：滚一下或点到别处就收起，不把面板留在旧位置上。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (panelRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true) return;
      setPanel("none");
    };
    const onScroll = () => setPanel("none");
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // Esc 收起并把焦点还给 ⋯：展开是用户主动动作，收起必须回到同一个位置。
  function close() { setPanel("none"); setError(null); setCopied(false); triggerRef.current?.focus(); }
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation(); close();
  }

  /**
   * 每条命令都在提交点取一枚新的 command_id；失败后不在这下面复用。
   *
   * 补丁由**回执**决定而不是在提交前写死：分叉的回执给的是新建子会话的身份，
   * 提交前无人知道它是谁，其余几条只是忽略这个入参。
   * 回执同时返回给调用方（失败返回 null）：归档要在命令生效后拿它推进后的修订去发撤销。
   */
  async function run<TResult>(submit: (commandId: string) => Promise<TResult>,
    patchOf: (result: TResult) => SessionRowPatch): Promise<TResult | null> {
    setBusy(true); setError(null);
    try { const result = await submit(createCommandId()); setPanel("none"); onChanged(patchOf(result)); return result; }
    catch (caught) {
      const described = describeLiveError(caught);
      if (described.kind === "conflict") {
        // 版本落后：重读这一条，让人对着新事实重新决定，不静默覆盖、也不自动重试。
        // 面板保持打开：这句说明只有留在浮层里才读得到，收起就等于把失败藏起来。
        onStale();
        setError("这条会话刚被改过，已重新读取最新内容，请核对后再操作。");
      } else {
        setError(described.message);
      }
      return null;
    } finally { setBusy(false); }
  }

  /**
   * 归档之后给 8 秒反悔窗口（可撤销的危险操作，工作台 §13.1）。
   *
   * 撤销不是数据库回滚，而是再发一条已有的「重开这段讨论」命令：它带**新的** command_id，
   * `expected_revision` 用归档回执里推进后的那个修订——刚归档成功，服务端事实就是这个值，
   * 不读左栏那份可能还没刷新的行。归档回执不明时 `run` 返回 null：那一刻改动是否生效都没
   * 确定，按契约第 4 节不能承诺撤回已产生的副作用，所以那种情况下不给撤销条。
   */
  async function archiveSession() {
    const receipt = await run((commandId) => client.archiveAssistSession({ sessionId: session.id,
      commandId, expectedRevision: session.revision }), () => ({ kind: "archive" }));
    if (receipt === null) return;
    // 取成独立常量：撤销要用的正是归档回执推进后的修订，这一刻服务端就是这一版，
    // 左栏那一行可能还没刷回来。
    const archivedRevision = receipt.revision;
    const key = `archive-session:${session.id}`;
    const testId = `session-archive-undo-${session.id}`;
    async function undoArchive() {
      try {
        await client.reopenAssistSession({ sessionId: session.id, commandId: createCommandId(),
          expectedRevision: archivedRevision });
        onChanged({ kind: "reopen" });
      } catch (caught) {
        const described = describeLiveError(caught);
        escalateFeedback(key, { testId, text: described.kind === "conflict"
          ? "撤销没成功：这段讨论刚被别处改过。展开「已归档」仍能重开它。"
          : `撤销没成功：${described.message}` });
      }
    }
    openUndoFeedback(key, { text: `已归档「${session.title}」`, actionLabel: "撤销", testId,
      onUndo: () => { void undoArchive(); } });
  }

  /**
   * 删除是唯一不可撤销的会话操作（ADR-027）：单击只打开确认框，确认后才发命令。
   *
   * 三种失败各走各的路，不混成一句「删除失败」：
   * - 回执不明（`RelayTransportError`）——动作是否生效未定，按契约不得换 command_id 重发，
   *   因此对话框保留、确认键锁死，只能按原 command_id 查回执；
   * - 修订落后——让调用方重读这一条，对话框留着，人对着新事实重新决定；
   * - 被其它对象引用（`SESSION_DELETE_BLOCKED`）——阻止项写进对话框，并指向归档。
   */
  async function deleteSession() {
    setBusy(true); setDeleteError(null); setDeleteUncertain(false);
    try {
      await client.deleteAssistSession({ sessionId: session.id, commandId: createCommandId(),
        expectedRevision: session.revision });
      setConfirmDelete(false);
      setPanel("none");
      onChanged({ kind: "delete" });
    } catch (caught) {
      const described = describeLiveError(caught);
      if (described.kind === "transport") {
        setDeleteUncertain(true);
        setDeleteError(described.message);
      } else if (described.kind === "conflict") {
        onStale();
        setDeleteError("这条会话刚被改过，已重新读取最新内容，请核对后再删除。");
      } else {
        setDeleteError(described.message);
      }
    } finally { setBusy(false); }
  }

  function openDelete() {
    setPanel("none");
    setDeleteError(null);
    setDeleteUncertain(false);
    setConfirmDelete(true);
  }

  function closeDelete() {
    setConfirmDelete(false);
    setDeleteError(null);
    triggerRef.current?.focus();
  }

  function submitRename() {
    const title = draft.trim();
    if (title === "") { setError("标题不能为空。"); return; }
    if (title.length > TITLE_LIMIT) { setError(`标题不能超过 ${TITLE_LIMIT} 个字符。`); return; }
    if (title === session.title) { close(); return; }
    void run((commandId) => client.renameAssistSession({ sessionId: session.id, commandId,
      expectedRevision: session.revision, title }), () => ({ kind: "title" }));
  }

  /**
   * 复制会话 ID 是纯客户端动作：不发命令、不落库、也不碰修订。
   *
   * 因此它不参与 `run` 的 CAS 与重读：复制没有「服务端事实」，失败也只可能来自剪贴板。
   * 复制的是 `relay://sessions/<ID>` 而不是裸 ID：粘到别处仍读得出这是 Relay 的哪条会话。
   * 复制后面板保持打开并短暂显示「已复制」，让人看得见反馈；直到点到别处才收起。
   */
  function copyId() {
    setError(null);
    const clipboard: Clipboard | undefined = navigator.clipboard;
    const pending = clipboard?.writeText(`${SESSION_URI_PREFIX}${session.id}`);
    if (pending === undefined) {
      setError("当前环境不能访问剪贴板，请手动复制会话 ID。");
      return;
    }
    void pending.then(() => {
      setCopied(true);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    }, () => setError("复制失败，请手动复制会话 ID。"));
  }

  return <>
    <button type="button" className="recent-work-row-trigger" ref={triggerRef}
      aria-expanded={open} aria-controls={`recent-work-row-panel-${session.id}`}
      aria-label={`会话「${session.title}」的操作`} disabled={busy}
      data-testid={`recent-work-menu-${session.id}`} onKeyDown={onKeyDown}
      onClick={() => { if (open) { setPanel("none"); setError(null); setCopied(false); } else openPanel(); }}>
      <MoreHorizontal aria-hidden="true" />
    </button>
    {open && <div ref={panelRef} className={`recent-work-row-panel${panel === "rename" ? " recent-work-row-panel--rename" : ""}`}
      id={`recent-work-row-panel-${session.id}`} onKeyDown={onKeyDown}
      style={placed ?? { visibility: "hidden" }}
      data-testid={`recent-work-panel-${session.id}`}>
      {panel === "actions" && (archived
        ? <>
          <button type="button" className="text-button recent-work-row-action" disabled={busy}
            onClick={() => void run((commandId) => client.reopenAssistSession({ sessionId: session.id,
              commandId, expectedRevision: session.revision }), () => ({ kind: "reopen" }))}>
            <RotateCcw aria-hidden="true" />重开这段讨论</button>
          {/* 归档态也能删：删除与归档是两条通道，归档不先拦住删除（ADR-027）。 */}
          <div role="separator" className="recent-work-row-separator" />
          <button type="button" className="text-button recent-work-row-action recent-work-row-action--danger"
            disabled={busy} data-testid={`recent-work-delete-${session.id}`} onClick={openDelete}>
            <Trash2 aria-hidden="true" />删除这段讨论</button>
        </>
        : <>
          <button type="button" className="text-button recent-work-row-action" disabled={busy}
            onClick={() => void run((commandId) => client.setAssistSessionPin({ sessionId: session.id,
              commandId, expectedRevision: session.revision, pinned: !pinned }), () => ({ kind: "pin" }))}>
            {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
            {pinned ? "取消置顶" : "置顶"}
          </button>
          <button type="button" className="text-button recent-work-row-action" disabled={busy}
            onClick={() => { setDraft(session.title); setPanel("rename"); }}>
            <Pencil aria-hidden="true" />重命名</button>
          <button type="button" className="text-button recent-work-row-action" disabled={busy}
            data-testid={`recent-work-unread-${session.id}`}
            onClick={() => void run((commandId) => client.setAssistSessionUnread({ sessionId: session.id,
              commandId, expectedRevision: session.revision, unread: !unread }), () => ({ kind: "unread" }))}>
            {unread ? <MailOpen aria-hidden="true" /> : <Mail aria-hidden="true" />}
            {unread ? "取消未读" : "标记为未读"}
          </button>
          {/* 分叉留在常用这一组：它新建一条讨论，不带归档那种不可逆读感。
              编号（1）（2）由服务端决定，界面不自己拼（2026-10-18 用户指令）。 */}
          <button type="button" className="text-button recent-work-row-action" disabled={busy}
            data-testid={`recent-work-fork-${session.id}`}
            onClick={() => void run((commandId) => client.forkAssistSession({ sessionId: session.id,
              commandId, expectedRevision: session.revision }),
            (result) => ({ kind: "fork", forkedSessionId: result.sessionId }))}>
            <GitFork aria-hidden="true" />分叉这段讨论</button>
          {/* 分组细线：常用改动（置顶/重命名/未读/分叉）与收尾动作（复制身份、归档）之间一刀切开，
              与参考菜单的两组读法一致；归档仍是唯一带不可逆读感的动作，单独收尾。 */}
          <div role="separator" className="recent-work-row-separator" />
          <button type="button" className="text-button recent-work-row-action"
            data-testid={`recent-work-copy-id-${session.id}`} onClick={copyId}>
            <Copy aria-hidden="true" />{copied ? "已复制会话 ID" : "复制会话 ID"}
          </button>
          <button type="button" className="text-button recent-work-row-action recent-work-row-action--danger" disabled={busy}
            onClick={() => void archiveSession()}>
            <Archive aria-hidden="true" />归档</button>
          {/* 归档可撤销（上面那条 Snackbar），删除不可撤销——两者不合并成一个「移除」。 */}
          <button type="button" className="text-button recent-work-row-action recent-work-row-action--danger" disabled={busy}
            data-testid={`recent-work-delete-${session.id}`} onClick={openDelete}>
            <Trash2 aria-hidden="true" />删除这段讨论</button>
        </>)}
      {panel === "rename" && <form className="recent-work-rename" onSubmit={(event) => {
        event.preventDefault(); submitRename(); }}>
        <input ref={inputRef} type="text" value={draft} maxLength={TITLE_LIMIT} aria-label="会话标题"
          data-testid={`recent-work-rename-input-${session.id}`}
          onChange={(event) => { setDraft(event.target.value); setError(null); }} />
        <button type="submit" className="primary-button recent-work-rename-save" disabled={busy}>保存</button>
        <button type="button" className="text-button" disabled={busy} onClick={close}>取消</button>
      </form>}
      {error !== null && <p className="recent-work-row-error" role="alert">{error}</p>}
    </div>}
    <AppDialog open={confirmDelete} title="删除这段讨论？"
      initialFocusSelector={`[data-testid="session-delete-cancel-${session.id}"]`}
      onClose={() => { if (!busy) closeDelete(); }}>
      <p>将永久删除「{session.title}」的全部消息、图片附件、工具调用记录与相关账本。删除后不可撤销，也没有回收站。</p>
      <p className="disabled-reason">被任务验收、项目假设、工作片段、学习记录等其它对象引用的讨论不能删除；那种情况请改用归档。</p>
      {deleteError !== null && <p className="recent-work-row-error" role="alert">{deleteError}</p>}
      <div className="run-actions">
        <button className="secondary-button" type="button" disabled={busy}
          data-testid={`session-delete-cancel-${session.id}`} onClick={closeDelete}>取消</button>
        <button className="danger-button" type="button" disabled={busy || deleteUncertain}
          data-testid={`session-delete-confirm-${session.id}`} onClick={() => void deleteSession()}>
          {busy ? "正在删除…" : "删除，且不保留"}
        </button>
      </div>
    </AppDialog>
  </>;
}
