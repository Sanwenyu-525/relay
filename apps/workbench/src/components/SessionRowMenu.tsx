import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { Archive, Copy, Download, GitFork, Mail, MailOpen, MoreHorizontal, Pencil, Pin, PinOff, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { createCommandId, type RelayApiClient, type RelayAssistSession } from "../api/relayClient";
import { deleteBlockerAdvice, describeLiveError, describeLiveRead } from "../lib/liveErrors";
import { deleteSessionAndVerify, verifyDeleteReceipt } from "../lib/sessionDelete";
import { reserveSessionExportFileName, saveExportFile } from "../lib/sessionExportFile";
import { useMenuExclusive } from "../lib/popoverMenu";
import { closeUndoFeedback, escalateFeedback, openUndoFeedback, Toast } from "./Feedback";

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

/**
 * 删除之后浮层停在哪一档（2026-10-31）。
 *
 * `confirm` 是**唯一一次**确认；确认之后的结果只有三种终态，不再回到带「删除」按钮的确认态：
 *   * `blocked`    —— 服务端明确拒绝（被别的对象引用）：行还在，原因逐条可读，可执行动作按原因给。
 *   * `failed`     —— 服务端明确拒绝且不是阻断（修订冲突等）：行还在。
 *   * `unresolved` —— 是否生效未知：只能按原 command_id 核对回执，不能重发。
 */
type DeleteResult =
  | { readonly kind: "blocked"; readonly reasons: readonly string[]; readonly reasonCodes: readonly string[] }
  | { readonly kind: "failed"; readonly message: string; readonly requestId: string | null }
  | { readonly kind: "unresolved"; readonly message: string; readonly requestId: string | null;
      readonly commandId: string };

/** 行本体右键时调用方拿来展开同一个面板的命令式入口。 */
export interface SessionRowMenuHandle {
  open: () => void;
}

/** 服务端标题上限（shared/text.ts 的 title）；本地先挡一次，省一趟必然 422 的往返。 */
const TITLE_LIMIT = 200;

/**
 * 重新生成失败时给用户读的原因。只翻服务端已经落库的错误码，不猜模型内部原因；
 * 未知码统一收敛为「原标题保留」，不把技术码摊进主提示句。
 */
function titleGenerationFailureText(generation: RelayAssistSession["titleGeneration"]): string {
  switch (generation?.errorCode) {
    case "TITLE_MODEL_UNAVAILABLE":
      return "没有可用的模型配置，没能生成新标题；原标题保留。";
    case "TITLE_MODEL_OUTPUT_INVALID":
      return "模型没有给出可用的标题，原标题保留。";
    case "TITLE_SUPERSEDED":
      return "标题在生成期间被改动，这次结果没有写入；当前标题保留。";
    case "TITLE_INPUT_MISSING":
      return "这段讨论还没有可用于命名标题的内容。";
    case "TITLE_ATTEMPTS_EXHAUSTED":
      return "多次尝试仍未生成标题；原标题保留。";
    case "TITLE_SESSION_UNAVAILABLE":
      return "这段讨论当前不可用，没能生成新标题。";
    default:
      return "这次没有生成新标题，原标题保留。";
  }
}

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
 * 「导出会话」的悬停说明：这些后果要在点之前就读得到，而不是文件落盘之后再解释。
 *
 * 两条都不能省：一是**这份文件里到底有什么**（只读诊断证据，不上传任何平台），
 * 二是**它可能带着用户自己的资料**——凭据字段由服务端脱敏，消息正文按原文保留，
 * 所以「这份文件可以给谁看」这一步只有用户自己能判断。
 */
const EXPORT_HINT = "把这段讨论的诊断证据（消息原文、工具调用与状态、待办、上下文与模型用量、"
  + "执行请求与动作身份）导出为本机 JSON 文件：只读取，不改动这段讨论，也不上传任何平台。"
  + "可识别的凭据字段已脱敏，但消息正文按原文保留，文件里可能含你自己输入的个人或项目资料。";

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
 *    **还没有消息的会话同样不出现**（2026-10-24）：分叉的语义是「连历史复制一份」，历史为空时
 *    服务端按 `INVALID_TRANSITION` 拒绝；与其让人点一下再读一条拒绝，不如照归档态的先例不给这一项。
 *    判据是服务端读时派生的 `hasMessages`（直接数消息表），不在本地数消息，也不看活动键是否为空。
 * 9. **删除的确认改成就地浮层（2026-10-19 用户指令）。** 条目由「删除这段讨论」收成「删除」，
 *    确认不再是 `AppDialog` 那种带遮罩、长正文与关闭叉的对话框，而是贴着 ⋯ 的一张窄卡：
 *    标题 + 一句后果 + 取消／删除两键。两条理由：这一行刚在菜单里点过「删除」，再铺一层遮罩
 *    等于把同一件事问第二遍；而原正文里「被引用不能删、请改用归档」只在服务端真的拒绝时才成立，
 *    平时摆在那里只会稀释「这一下不可撤销」这唯一要紧的一句——现在它只在失败分支出现。
 *    摆位与动作面板共用同一个触发器与同一套「越界拉回视口」的规矩，但方向相反：这张卡比 176px 的
 *    左栏还宽，开在 ⋯ 左侧会被推到窗口左缘、尖角指不回触发器，所以它竖直居中地开在右侧，
 *    尖角落在卡片左缘；右边放不下才翻回左侧。两种方向都不推高这一行，⋯ 因此一动不动。
 * 10. **导出会话是一条只读出口，不是又一条命令（2026-11-01 用户任务书）。** 一次
 *    `GET /assist-sessions/:id/export` 换回服务端拼好的诊断文件：消息原文、工具轮次与状态、待办
 *    快照、上下文与模型用量、执行请求与动作身份都在同一份投影里，界面不自己攒证据，也不因为
 *    某一段读不到就补一份看起来完整的。它没有要写的服务端事实，所以不带 command_id、不推进修订、
 *    不参与冲突重读，归档态同样可导；位置留在「复制会话 ID」之后、归档与删除之前——取证据的动作
 *    不带不可逆读感，就不该排在危险项里。
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
  const [panel, setPanel] = useState<"none" | "actions" | "rename" | "confirm" | "result" | "regenerate">("none");
  const [draft, setDraft] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /**
   * 导出进行中，以及成功后落在本机的那个文件名（null 表示这一次还没导出成功）。
   *
   * `partial` 跟着文件名一起存：服务端在文档的 `completeness` 里自己声明了「这是部分导出」，
   * 成功提示必须把这句话一并说出来，不能把残缺报成完整。
   *
   * 与 `busy` 分开：`busy` 是「这一行有一条命令正在提交」，会把 ⋯ 触发器一起禁掉；
   * 导出是只读读取，不该锁住整行，也不参与 CAS 与冲突重读。
   */
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<{ fileName: string; partial: boolean } | null>(null);
  /** 删除之后停在哪一档：阻断、明确失败，还是「是否生效未知」。 */
  const [deleteResult, setDeleteResult] = useState<DeleteResult | null>(null);
  /**
   * 0157：重新生成标题已受理、仍在等待后台落定。
   *
   * 回执不是结果：标题可能因模型不可用、输出不合法或被并发改名而保持原样。
   * 这个状态只驱动「正在生成」文案与一次有界轮询，不把请求写成已成功。
   */
  const [titleRegenerating, setTitleRegenerating] = useState(false);
  /** 成功后的短暂反馈；失败走反馈栈的 Notice，面板收起后仍读得到。 */
  const [titleNotice, setTitleNotice] = useState<string | null>(null);
  /** 轮询期间读到的最新一行标题与回调：用 ref 避免父级重渲染不断重启计时。 */
  const titleWatch = useRef<{ title: string; onChanged: (patch: SessionRowPatch) => void }>({
    title: session.title, onChanged });
  titleWatch.current = { title: session.title, onChanged };
  const copyTimer = useRef<number | null>(null);
  /**
   * 摆位结果与「尖角朝哪边」一起存：确认浮层的卡片比左栏还宽，开在 ⋯ 左边会被推到窗口左缘，
   * 尖角就指不回触发器了，所以它优先开在右侧（参考弹窗的读法：尖角在卡片左缘），
   * 右边放不下才翻回左侧。
   */
  const [placed, setPlaced] = useState<{ style: CSSProperties; arrow: "top" | "start" } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 危险动作不从回车起手：确认浮层一出现，焦点就压在「取消」上。 */
  const cancelRef = useRef<HTMLButtonElement>(null);
  /** 结果态的「关闭」键：焦点落在这里，读完原因直接走。 */
  const resultCloseRef = useRef<HTMLButtonElement>(null);
  const archived = session.status === "ARCHIVED";
  const pinned = session.pinnedAt !== null;
  const unread = session.unreadAt !== null;
  const open = panel !== "none";

  /**
   * 每次重新打开面板都回到「还没导出过」的读法：条目名与成功反馈描述的都是这一次打开里发生过的事。
   *
   * `exported` 只在这里收，不在 `close()` 里收——那条成功提示挂在页壳的反馈栈上，面板收了它不该跟着消失。
   */
  function openPanel() {
    setDraft(session.title); setError(null); setCopied(false); setExported(null);
    // 成功提示只描述「这一次打开里发生过的事」；在途的标题生成状态不重置，
    // 面板收起再打开仍要如实显示它还在等后台落定。
    setTitleNotice(null); setPanel("actions");
  }
  useImperativeHandle(ref, () => ({ open: openPanel }));

  useEffect(() => { if (panel === "rename") inputRef.current?.focus(); }, [panel]);
  useEffect(() => {
    if (panel === "confirm" || panel === "regenerate") cancelRef.current?.focus();
  }, [panel]);
  // 结果态的焦点落在「关闭」上：这一档没有可点的删除键，读完原因只能走。
  useEffect(() => { if (panel === "result") resultCloseRef.current?.focus(); }, [panel]);
  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);
  // 行外面板是浮层：自身的外部按下/滚动/Esc 都在下方处理，这里只挂独占——
  // 打开输入器上的任何浮层（「+」、档位、模型）时都把它收掉，两列浮层不互相压。
  useMenuExclusive(open, () => setPanel("none"));
  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  // 面板按触发器的实测位置摆放：优先开在下方，放不下向上翻；横向与右缘对齐并拉回视口内。
  // 确认浮层是唯一例外：它比左栏宽，开在 ⋯ 左侧会被推到窗口左缘、尖角指不回触发器，
  // 因此改为与触发器竖直居中、优先开在右侧（尖角落在卡片左缘），右边放不下才翻回左侧。
  useLayoutEffect(() => {
    if (!open) { setPlaced(null); return; }
    const place = () => {
      const element = panelRef.current;
      const trigger = triggerRef.current;
      if (element === null || trigger === null) return;
      const box = trigger.getBoundingClientRect();
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const clampTop = (top: number) => Math.max(MARGIN_PX,
        Math.min(top, window.innerHeight - MARGIN_PX - height));
      if (panel === "confirm" || panel === "result" || panel === "regenerate") {
        const right = box.right + GAP_PX;
        const toRight = right + width <= window.innerWidth - MARGIN_PX;
        setPlaced({ arrow: toRight ? "start" : "top", style: {
          left: toRight ? right : Math.max(MARGIN_PX, box.left - GAP_PX - width),
          top: clampTop(box.top + box.height / 2 - height / 2) } });
        return;
      }
      const left = Math.max(MARGIN_PX, Math.min(box.right - width, window.innerWidth - MARGIN_PX - width));
      const below = box.bottom + GAP_PX;
      const above = below + height > window.innerHeight - MARGIN_PX;
      setPlaced({ arrow: "top", style: { left, top: above
        ? Math.max(MARGIN_PX, box.top - GAP_PX - height) : below } });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, panel, titleRegenerating]);

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

  /**
   * 重新生成标题的有界等待（0157）。
   *
   * 回执只说请求已入队；标题是否变化、是否失败或被他处改名取代，只能由服务端读回。
   * 每拍读一次这条会话，落定即收口并把这一行交给调用方重读；40 拍仍未落定就停止，
   * 之后由左栏既有的「有标题生成在途」轮询继续更新——界面等待不是生成完成的保证。
   */
  useEffect(() => {
    if (!titleRegenerating) return;
    let stopped = false;
    let timer: number | null = null;
    let ticks = 0;
    const settle = (text: string) => {
      setTitleRegenerating(false);
      escalateFeedback(`session-title:${session.id}`, {
        text, testId: `recent-work-title-generate-failed-${session.id}` });
    };
    const poll = async () => {
      timer = null;
      if (stopped) return;
      ticks += 1;
      try {
        const next = await client.getAssistSession(session.id, true);
        if (stopped) return;
        const status = next.titleGeneration?.status;
        if (status === "PENDING" || status === "CLAIMED") {
          if (ticks >= 40) {
            setTitleRegenerating(false);
            setError("重新生成仍在进行；标题完成后会自动出现在列表里。");
            return;
          }
          timer = window.setTimeout(() => { void poll(); }, 1000);
          return;
        }
        setTitleRegenerating(false);
        titleWatch.current.onChanged({ kind: "title" });
        /*
         * 成败只看请求的终态，不拿「标题是否变化」推断：别处的重读（左栏当前会话刷新）
         * 可能先把新标题显示出来，那时标题已经相等，但这一次生成明明是成功的。
         * COMPLETED 表示服务端已在同一事务里落了标题；FAILED/SKIPPED 才是没写成。
         */
        if (next.titleGeneration?.status === "COMPLETED") {
          // 上一条「没生成」的常驻说明就没有意义了，先收走它。
          closeUndoFeedback(`session-title:${session.id}`);
          setTitleNotice(`已重新生成标题「${next.title}」`);
          setPanel("none");
          return;
        }
        settle(titleGenerationFailureText(next.titleGeneration));
      } catch (caught) {
        if (stopped) return;
        setTitleRegenerating(false);
        settle(`没能核对标题生成结果：${describeLiveRead(caught)}`);
      }
    };
    timer = window.setTimeout(() => { void poll(); }, 1000);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [titleRegenerating, client, session.id]);

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
   * 发起重新生成标题（0157）。
   *
   * 只发一条受理命令并进入等待：不在这里调用模型、也不把回执当标题已更新。
   * 手动命名过的会话先经过确认浮层——用户必须先知道这会替换自己设置的名字。
   */
  async function startRegenerate() {
    if (busy || titleRegenerating) return;
    setBusy(true); setError(null); setTitleNotice(null);
    closeUndoFeedback(`session-title:${session.id}`);
    setPanel("actions");
    try {
      await client.regenerateAssistSessionTitle({ sessionId: session.id,
        commandId: createCommandId(), expectedRevision: session.revision });
      setTitleRegenerating(true);
    } catch (caught) {
      const described = describeLiveError(caught);
      if (described.kind === "conflict") {
        // 修订落后：重读这一条，让人对着新事实重新决定，不静默覆盖、也不换 ID 重试。
        onStale();
        setError("这条会话刚被改过，已重新读取最新内容，请核对后再试。");
      } else setError(described.message);
    } finally { setBusy(false); }
  }

  /**
   * 删除是唯一不可撤销的会话操作（ADR-027）：单击只打开确认浮层，确认后才发命令。
   *
   * 四种结果各走各的路，不混成一句「删除失败」（2026-10-31）：
   * - 已删——服务端确认（含按原 command_id 核对回执确认）：行当场消失，浮层收起。
   * - 被引用阻断——**终态**：原因逐条可读，每条配一句真正能做的动作；不再摆「删除」，
   *   摆着只会让人再点一次同一个必然被拒绝的动作。
   * - 明确失败（修订冲突等）——终态：行还在，说明该怎么再做。
   * - 结果未知（5xx、响应丢失）——**不能宣称失败，也不能宣称成功**：按原 command_id
   *   核对回执；核对不到就仍留这一档，绝不换 command_id 重发。
   */
  async function deleteSession() {
    setBusy(true);
    const commandId = createCommandId();
    try {
      const outcome = await deleteSessionAndVerify(client, session, commandId);
      if (outcome.state === "deleted") {
        setPanel("none");
        setDeleteResult(null);
        onChanged({ kind: "delete" });
        return;
      }
      if (outcome.state === "blocked") {
        setDeleteResult({ kind: "blocked", reasons: outcome.reasons,
          reasonCodes: outcome.reasonCodes });
      } else if (outcome.state === "failed") {
        setDeleteResult({ kind: "failed", message: outcome.message,
          requestId: outcome.requestId });
        if (outcome.conflict) onStale();
      } else {
        setDeleteResult({ kind: "unresolved", message: outcome.message,
          requestId: outcome.requestId, commandId });
      }
      setPanel("result");
    } finally { setBusy(false); }
  }

  /**
   * 按原 command_id 再核对一次回执（结果未知时的唯一出路）。
   *
   * 核对到 `DeleteAssistSession` 的回执 = 这次删除确实生效；核对不到就还是未知，
   * 不重发、不改口。服务端说过：回执不存在不能证明一个仍在事务中的请求永远未提交，
   * 所以这一档只能等，不能猜。
   */
  async function recheckDeleteReceipt() {
    if (deleteResult?.kind !== "unresolved") return;
    setBusy(true);
    try {
      const verdict = await verifyDeleteReceipt(client, deleteResult.commandId);
      if (verdict === "deleted") {
        setPanel("none");
        setDeleteResult(null);
        onChanged({ kind: "delete" });
        return;
      }
      setDeleteResult({ ...deleteResult,
        message: "还没查到这次删除的回执。它可能仍在提交中，请稍后再核对一次；不要重复删除。" });
    } finally { setBusy(false); }
  }

  function openDelete() {
    setError(null);
    setDeleteResult(null);
    setPanel("confirm");
  }

  function closeDelete() {
    setPanel("none");
    setDeleteResult(null);
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

  /**
   * 导出这段讨论：一次只读请求换回一份诊断文件，界面不参与拼证据（2026-11-01 用户任务书）。
   *
   * 三条规矩对应这次承诺的三件事：
   *   * **只读**——不发命令、不带 command_id、不推进修订，因此它不走 `run` 那套 CAS 与冲突重读；
   *     归档态同样可导，复盘往往就发生在归档之后。
   *   * **失败不落文件**——读取或校验一旦抛错，就把真实原因写进就地告警，连文件名都不占号，
   *     更不会写一个空 JSON 假装成功。
   *   * **说清落在哪**——成功提示直接报文件名；服务端在文档里自己声明了部分导出时，这句话跟着
   *     一起说，不把残缺当完整。
   */
  async function exportSession() {
    // 进行中重复激活直接忽略：这一条在请求期间是 `aria-disabled`（仍可聚焦，焦点不掉），
    // 挡住第二次导出靠这个守卫，而不是靠 `disabled` 把键盘焦点丢到 body。
    if (exporting) return;
    setError(null);
    setExported(null);
    setExporting(true);
    try {
      const payload = await client.exportAssistSessionDocument(session.id);
      // 名字到这一刻才占号：先占后失败会白白吃掉一个序号，下一次导出就得叫 `-2`。
      const fileName = reserveSessionExportFileName(payload.title, payload.exportedAt);
      saveExportFile(fileName, payload.text);
      setExported({ fileName, partial: payload.partial });
    } catch (caught) {
      // 只读说法（describeLiveRead）：导出没有命令、没有回执，命令提交那句「按同一枚 command ID
      // 查回执」在这里既读不到、也不该读——失败只说明没拿到内容、没生成文件。
      setError(describeLiveRead(caught));
    } finally {
      setExporting(false);
    }
  }

  /**
   * 「导出会话」条目：归档态与普通态共用同一个按钮，因此在这里建一次，两个分支各摆一处。
   *
   * 样式只复用 `.recent-work-row-action`（同一档 20px 图标、字号、内边距与焦点环），不新增类：
   * 菜单的尺寸与节奏是前九轮定下来的，多一个条目不该改这几项。
   */
  const exportItem = <button type="button" className="text-button recent-work-row-action"
    aria-disabled={exporting} title={EXPORT_HINT}
    data-testid={`recent-work-export-${session.id}`}
    onClick={() => void exportSession()}>
    <Download aria-hidden="true" />
    {exporting ? "导出中…" : exported === null ? "导出会话" : "已导出会话"}
  </button>;

  return <>
    <button type="button" className="recent-work-row-trigger" ref={triggerRef}
      aria-expanded={open} aria-controls={`recent-work-row-panel-${session.id}`}
      aria-label={`会话「${session.title}」的操作`} disabled={busy}
      data-testid={`recent-work-menu-${session.id}`} onKeyDown={onKeyDown}
      onClick={() => { if (open) { setPanel("none"); setError(null); setCopied(false); } else openPanel(); }}>
      <MoreHorizontal aria-hidden="true" />
    </button>
    {open && <div ref={panelRef} className={`recent-work-row-panel${panel === "rename" ? " recent-work-row-panel--rename" : ""}${(panel === "confirm" || panel === "result" || panel === "regenerate") ? " recent-work-row-panel--confirm" : ""}${(panel === "confirm" || panel === "result" || panel === "regenerate") && placed?.arrow === "start" ? " recent-work-row-panel--arrow-start" : ""}`}
      id={`recent-work-row-panel-${session.id}`} onKeyDown={onKeyDown}
      style={placed?.style ?? { visibility: "hidden" }}
      data-testid={`recent-work-panel-${session.id}`}>
      {panel === "actions" && (archived
        ? <>
          <button type="button" className="text-button recent-work-row-action" disabled={busy}
            onClick={() => void run((commandId) => client.reopenAssistSession({ sessionId: session.id,
              commandId, expectedRevision: session.revision }), () => ({ kind: "reopen" }))}>
            <RotateCcw aria-hidden="true" />重开这段讨论</button>
          {/* 归档态同样给导出：要拿去外部分析的往往是已经结束、需要复盘的那一段。
              它在「重开」与危险项之间——只读取，不动这一行任何事实。 */}
          {exportItem}
          {/* 归档态也能删：删除与归档是两条通道，归档不先拦住删除（ADR-027）。 */}
          <div role="separator" className="recent-work-row-separator" />
          <button type="button" className="text-button recent-work-row-action recent-work-row-action--danger"
            disabled={busy} data-testid={`recent-work-delete-${session.id}`} onClick={openDelete}>
            <Trash2 aria-hidden="true" />删除</button>
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
          {/*
            重新生成标题（0157）：紧挨重命名——它们是同一件事的两种写法（用户写 / 语义生成）。
            手动命名过的会话先弹一次确认，因为这一次会替换用户自己设置的名字；
            其他来源直接发起。归档态不提供：服务端与改名同一条「先重开」边界。
          */}
          <button type="button" className="text-button recent-work-row-action"
            disabled={busy || titleRegenerating}
            data-testid={`recent-work-regenerate-title-${session.id}`}
            onClick={() => { setError(null); setTitleNotice(null);
              if (session.titleSource === "USER_DEFINED") setPanel("regenerate");
              else void startRegenerate(); }}>
            <Sparkles aria-hidden="true" />
            {titleRegenerating ? "正在生成标题…" : "重新生成标题"}</button>
          <button type="button" className="text-button recent-work-row-action" disabled={busy}
            data-testid={`recent-work-unread-${session.id}`}
            onClick={() => void run((commandId) => client.setAssistSessionUnread({ sessionId: session.id,
              commandId, expectedRevision: session.revision, unread: !unread }), () => ({ kind: "unread" }))}>
            {unread ? <MailOpen aria-hidden="true" /> : <Mail aria-hidden="true" />}
            {unread ? "取消未读" : "标记为未读"}
          </button>
          {/* 分叉留在常用这一组：它新建一条讨论，不带归档那种不可逆读感。
              编号（1）（2）由服务端决定，界面不自己拼（2026-10-18 用户指令）。
              还没有消息的讨论不给这一项：没有可搬的历史，服务端只会拒绝（2026-10-24）。
              判据是服务端读时派生的 hasMessages，不从活动键的可空性推断。 */}
          {session.hasMessages && <button type="button"
            className="text-button recent-work-row-action" disabled={busy}
            data-testid={`recent-work-fork-${session.id}`}
            onClick={() => void run((commandId) => client.forkAssistSession({ sessionId: session.id,
              commandId, expectedRevision: session.revision }),
            (result) => ({ kind: "fork", forkedSessionId: result.sessionId }))}>
            <GitFork aria-hidden="true" />分叉这段讨论</button>}
          {/* 分组细线：常用改动（置顶/重命名/未读/分叉）与收尾动作（复制身份、归档）之间一刀切开，
              与参考菜单的两组读法一致；归档仍是唯一带不可逆读感的动作，单独收尾。 */}
          <div role="separator" className="recent-work-row-separator" />
          <button type="button" className="text-button recent-work-row-action"
            data-testid={`recent-work-copy-id-${session.id}`} onClick={copyId}>
            <Copy aria-hidden="true" />{copied ? "已复制会话 ID" : "复制会话 ID"}
          </button>
          {/* 导出与复制同属「取一份东西出去」这一组：都不写服务端事实，都排在带不可逆读感的
              归档与删除之前（2026-11-01 用户任务书 §二）。 */}
          {exportItem}
          <button type="button" className="text-button recent-work-row-action recent-work-row-action--danger" disabled={busy}
            onClick={() => void archiveSession()}>
            <Archive aria-hidden="true" />归档</button>
          {/* 归档可撤销（上面那条 Snackbar），删除不可撤销——两者不合并成一个「移除」。
              条目名只留「删除」：这一行本身就在左栏列着，「这段讨论」四个字由浮层标题接手。 */}
          <button type="button" className="text-button recent-work-row-action recent-work-row-action--danger" disabled={busy}
            data-testid={`recent-work-delete-${session.id}`} onClick={openDelete}>
            <Trash2 aria-hidden="true" />删除</button>
        </>)}
      {/* 标题生成在途：只说明「已受理、正在等后台落定」，不是「标题已经更新」。
          面板收起后这一行仍会在左栏的既有轮询里更新。 */}
      {titleRegenerating && <p className="recent-work-confirm-text" role="status"
        data-testid={`recent-work-title-generating-${session.id}`}>
        正在根据当前对话生成标题；完成后会自动更新这一行的标题。</p>}
      {/* 手动命名过才会走到这一档：明确告知会替换用户自己设置的标题，取消是初始焦点。 */}
      {panel === "regenerate" && <>
        <p className="recent-work-confirm-title">重新生成标题？</p>
        <p className="recent-work-confirm-text">
          你当前手动设置的标题会被替换；聊天内容、执行与各项状态不受影响。
          如果模型不可用，原标题会保留。</p>
        <div className="recent-work-confirm-actions">
          <button className="primary-button" type="button" disabled={busy}
            data-testid={`session-title-regenerate-confirm-${session.id}`}
            onClick={() => void startRegenerate()}>{busy ? "正在提交…" : "重新生成"}</button>
          <button ref={cancelRef} className="secondary-button" type="button"
            disabled={busy} data-testid={`session-title-regenerate-cancel-${session.id}`}
            onClick={close}>取消</button>
        </div>
      </>}
      {panel === "rename" && <form className="recent-work-rename" onSubmit={(event) => {
        event.preventDefault(); submitRename(); }}>
        <input ref={inputRef} type="text" value={draft} maxLength={TITLE_LIMIT} aria-label="会话标题"
          data-testid={`recent-work-rename-input-${session.id}`}
          onChange={(event) => { setDraft(event.target.value); setError(null); }} />
        <button type="submit" className="primary-button recent-work-rename-save" disabled={busy}>保存</button>
        <button type="button" className="text-button" disabled={busy} onClick={close}>取消</button>
      </form>}
      {/* 确认浮层（2026-10-19）：标题 + 一句后果 + 两键，与动作面板同一个容器、同一套摆位。
          长正文里那条「被引用不能删」不再常驻——它只在服务端真的拒绝时由结果态说出。 */}
      {panel === "confirm" && <>
        <p className="recent-work-confirm-title">删除这段讨论？</p>
        <p className="recent-work-confirm-text">
          删除后，消息、附件与工具调用记录将永久移除，无法恢复。</p>
        <div className="recent-work-confirm-actions">
          {/* 删除在左、取消在右（2026-10-19 用户指令）：两键各占一半，合计铺满卡片内容宽，
              与菜单条目同一条左右边界；初始焦点仍压在「取消」上，回车不会直接删。 */}
          <button className="danger-button" type="button" disabled={busy}
            data-testid={`session-delete-confirm-${session.id}`} onClick={() => void deleteSession()}>
            {busy ? "正在删除…" : "删除"}
          </button>
          <button ref={cancelRef} className="secondary-button" type="button"
            disabled={busy} data-testid={`session-delete-cancel-${session.id}`} onClick={closeDelete}>取消</button>
        </div>
      </>}
      {/* 结果态（2026-10-31）：确认之后只有终态，没有第二次确认。
          每类阻断配一句真正能做的动作；原始追溯号只在「技术详情」里，不进主提示句。 */}
      {panel === "result" && deleteResult !== null && <>
        <p className="recent-work-confirm-title">
          {deleteResult.kind === "blocked" ? "这段讨论还不能删除"
            : deleteResult.kind === "unresolved" ? "删除结果待核实" : "这次没有删除"}</p>
        <div className="recent-work-delete-result" role="alert">
          {deleteResult.kind === "blocked" && deleteResult.reasons.map((reason, index) => (
            <p key={reason} className="recent-work-confirm-text">
              {reason}。{deleteBlockerAdvice(deleteResult.reasonCodes[index] ?? "")}
            </p>
          ))}
          {(deleteResult.kind === "failed" || deleteResult.kind === "unresolved") &&
            <p className="recent-work-confirm-text">{deleteResult.message}</p>}
          {deleteResult.kind !== "blocked" && deleteResult.requestId !== null && (
            <details className="recent-work-delete-detail">
              <summary>技术详情</summary>
              <p>请求 ID：<code className="hash-code">{deleteResult.requestId}</code></p>
            </details>
          )}
        </div>
        <div className="recent-work-confirm-actions">
          {deleteResult.kind === "unresolved" && (
            <button className="secondary-button" type="button" disabled={busy}
              data-testid={`session-delete-recheck-${session.id}`}
              onClick={() => void recheckDeleteReceipt()}>{busy ? "核对中…" : "核对回执"}</button>
          )}
          <button ref={resultCloseRef} className="secondary-button" type="button"
            data-testid={`session-delete-close-${session.id}`} onClick={closeDelete}>关闭</button>
        </div>
      </>}
      {error !== null && <p className="recent-work-row-error" role="alert">{error}</p>}
    </div>}
    {/* 下载完成的确认挂在页壳的反馈栈里，不写进面板：面板会因为点到别处或滚一下立刻收起，
        而「文件确实落了、叫什么、是不是部分导出」这句话得活得比面板久一点。 */}
    {exported !== null && <Toast testId={`session-export-done-${session.id}`}>
      {`已导出「${exported.fileName}」${exported.partial
        ? "（部分导出：某一段超过单次上限，文件里的 completeness 写明了是哪一段）" : ""}`}
    </Toast>}
    {titleNotice !== null && <Toast testId={`session-title-regenerated-${session.id}`}>
      {titleNotice}
    </Toast>}
  </>;
}
