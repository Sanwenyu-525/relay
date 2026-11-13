import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Folder, Plus, Search, SquarePen, Target } from "lucide-react";
import { createCommandId, RelayApiError, type RelayApiClient, type RelayAssistSession, type RelayProjectListItem, type RelayTaskSummary } from "../api/relayClient";
import { readActiveConversation, useActiveConversation } from "../lib/activeConversation";
import { deleteBlockerAdvice, describeLiveError } from "../lib/liveErrors";
import { deleteSessionAndVerify, verifyDeleteReceipt } from "../lib/sessionDelete";
import { resolveMotionPreference } from "../lib/motionPreference";
import { railGroupKey, readCollapsedRailGroups, writeCollapsedRailGroups } from "../lib/railGroupPreferences";
import { readRailSessionOrder, writeRailSessionOrder } from "../lib/railSessionOrder";
import { sessionDirectoryKey } from "../lib/sessionDirectory";
import { sessionStateNote } from "../lib/sessionState";
import { handleRosterKeyDown } from "../lib/tabNavigation";
import { resolvedTokenValue } from "../lib/tokens";
import EmptyState from "./EmptyState";
import { Notice, Toast } from "./Feedback";
import RecentWorkRow from "./RecentWorkRow";
import WorkspaceClearSessions from "./WorkspaceClearSessions";
import type { SessionRowPatch } from "./SessionRowMenu";
import { Button, IconButton } from "../ui";

/**
 * 批量删除的结果报告（2026-10-31）。
 *
 * 三类分开记，不再揉成一段红字：
 *   * `deleted`    —— 已删的标题（行当场消失，这里只是留个说法）。
 *   * `blocked`    —— 被别的对象引用而删不掉的：按**同一组原因**归并，原因只写一次。
 *   * `failed`     —— 明确失败（修订冲突等）：行还在，各自一条。
 *   * `unresolved` —— 是否生效未知：只能按原 command_id 核对回执。
 */
interface BatchDeleteReport {
  readonly deleted: readonly string[];
  readonly blocked: readonly {
    readonly titles: readonly string[];
    readonly reasons: readonly string[];
    readonly reasonCodes: readonly string[];
  }[];
  readonly failed: readonly { readonly title: string; readonly message: string }[];
  readonly unresolved: readonly {
    readonly sessionId: string;
    readonly title: string;
    readonly message: string;
    readonly requestId: string | null;
    readonly commandId: string;
  }[];
}

/**
 * 顶层结论：一行说清成功几段、没删掉几段、待核实几段。
 *
 * 计数而不是长句：这一列只有 160px 内容盒，一句话读不完还要滚动；被撑开的侧栏里
 * 读者也只会看到第一行（2026-10-31 用户指认）。
 */
function batchSummary(report: BatchDeleteReport): string {
  const notDeleted = report.blocked.reduce((sum, group) => sum + group.titles.length, 0)
    + report.failed.length;
  const parts = [`已删除 ${report.deleted.length} 段`];
  if (notDeleted > 0) parts.push(`${notDeleted} 段未删除`);
  if (report.unresolved.length > 0) parts.push(`${report.unresolved.length} 段待核实`);
  return parts.join("，");
}

/** 每一类阻断对应的可执行动作；同一组原因只写一次。 */
function blockedAdvice(codes: readonly string[]): string {
  const advices = [...new Set(codes.map((code) => deleteBlockerAdvice(code)))];
  return advices.length === 0 ? "改为归档，或在原对象解除引用后再删除" : `${advices.join("；")}。`;
}

/**
 * 批量删除失败/待核实的那一条非阻塞提示（2026-11-10）。
 *
 * 只写结论与去重后的原因，不点名会话标题：标题可能就是用户那一长段提示词，点名会把
 * 这张反馈卡重新撑成截图里那种滚不完的红字。逐条身份仍留在 `batchResult` 里，
 * 「核对回执」按原 command_id 核对时用得到。
 */
function batchNoticeText(report: BatchDeleteReport): string {
  const parts = [batchSummary(report)];
  const reasons = [...new Set(report.blocked.flatMap((group) => group.reasons))];
  if (reasons.length > 0) {
    const codes = [...new Set(report.blocked.flatMap((group) => group.reasonCodes))];
    parts.push(`未删除原因：${reasons.join("、")}。${blockedAdvice(codes)}`);
  }
  if (report.failed.length > 0) {
    const messages = [...new Set(report.failed.map((item) => item.message))];
    parts.push(`删除失败：${messages.join("；")}。`);
  }
  if (report.unresolved.length > 0) {
    parts.push("待核实的条目只按原命令核对回执，不要重复删除。");
  }
  return parts.join(" ");
}

interface Loaded {
  readonly tasks: readonly RelayTaskSummary[];
  /** 项目讨论与自由会话；挂在任务上的会话由任务行承担。 */
  readonly sessions: readonly RelayAssistSession[];
  readonly projectTitles: ReadonlyMap<string, string>;
  readonly nextCursor: string | null;
  readonly loadedAt: string;
}

interface Row {
  readonly key: string;
  readonly kind: "task" | "session";
  readonly id: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly updatedAt: string | null;
  /** 置顶只影响这一列的排序与副行标记，不参与分组，也不代表任何业务状态。 */
  readonly pinned: boolean;
  /** 未读只是导航标记（0104），不参与分组与排序。 */
  readonly unread: boolean;
  /**
   * 任务当前有 Run 持有执行权（服务端投影的 `executor.run_id` 非空）。
   * 只用于分组标题的运行指示，不参与分组、排序或行内容；会话行的运行态仍由
   * 状态图标承担（`listState`），这里恒为 false。
   */
  readonly running: boolean;
}

/**
 * 运行态轮询的节拍（2026-10-28）。只在「有讨论真的在跑」期间生效，平时零请求。
 *
 * `BASE` 取 3s：比服务端预览流的变化检测（约 200ms）粗得多，但左栏要的是「哪条在生成」
 * 这一档事实，秒级已经够；再密就是拿请求换一个看不出来的差别。
 * 连续 `SLOW_AFTER` 拍后降到 `SLOW`：一次长生成（可能十几分钟）不会让请求量线性堆起来。
 */
const RUN_POLL_BASE_MS = 3000;
const RUN_POLL_SLOW_MS = 10_000;
const RUN_POLL_SLOW_AFTER = 40;
/** 读失败时的退避上限：不无限翻倍，也不因为一次失败就把在跑的那条显示成静止。 */
const RUN_POLL_MAX_BACKOFF_MS = 30_000;
/**
 * 没有已知执行中的任务时的任务事实复查节拍（2026-11-10）。
 *
 * 运行指示只认服务端投影的 `executor.run_id`；执行可能由后台自动推进启动，
 * 不经过本页的任何命令回执，因此需要一条低频复查把它发现出来。30s 是
 * 「不用秒级、又不会让指示长期缺席」的一档：一次读取覆盖整页，可见时才打，
 * 页面在后台只保留计时、切回可见那一拍立刻补一次。
 */
const TASK_IDLE_POLL_MS = 30_000;

/** 拖拽期间的落位预览：横线画在 `listKey` 这一列的 `lineTop` 处，松手即落到 `targetKey` 的这侧。 */
interface Drag {
  readonly rowKey: string;
  readonly listKey: string;
  /** 起手点到现在走了多远：被抓着的那一行照这个量整行平移，指针始终按在同一处。 */
  readonly offsetY: number;
  readonly lineTop: number;
  readonly targetKey: string;
  readonly before: boolean;
}

/** 一次拖拽的现场：抓握点、这一列的行几何（拖拽期间布局不动，起手量一次就够）。 */
interface DragSource {
  readonly rowKey: string;
  readonly listKey: string;
  readonly startY: number;
  readonly ul: HTMLElement;
  readonly gap: number;
  readonly rows: readonly { key: string; top: number; height: number }[];
  moved: boolean;
}

/** 指针移动超过这一档才认定是拖拽：否则单击行也会先把整列拖乱，而单击的语义是打开会话。 */
const DRAG_START_PX = 4;

/** 改序落位的一次记录：元素本体（React 按 key 复用同一个节点）加上它改序前的顶边。 */
interface FlipRow {
  readonly key: string;
  readonly element: HTMLElement;
  readonly top: number;
}

/* 落位动效的三档数值全部取现有 motion token，不新立一档：
   位移时长／缓取面板过渡（一次布局变化，不是控件悬停），落位强调的停留取时间线跳转同一档。 */
const FLIP_MS = Number.parseFloat(resolvedTokenValue("motion.duration.panel"));
const FLIP_EASING = resolvedTokenValue("motion.easing.standard");
const DROPPED_MS = Number.parseFloat(resolvedTokenValue("motion.duration.emphasis")) * 1000;

/**
 * 一份服务端快照写进这一列之前的统一闸门：本机已经由服务端确认删除的那几条不再回来。
 *
 * 要挡的只有一类情况——删除**之前**发出、删除**之后**才落地的旧读数（整列读取、运行态轮询、
 * 当前会话定向重读都是这一类），它拿的是删除之前的那一份，落地时不能把已经确认没了的行、
 * 分组副本和勾选一起带回来（2026-11-01 UI-SESSION-DELETE-ACTIVE）。
 * 这一份集合只存在本次挂载里，既不持久化也不参与「删的是谁」的判断：刷新之后列表仍以服务端
 * 读数为准，不是第二套业务事实。
 */
function withoutConfirmedDeletes<T extends { readonly id: string }>(
  items: readonly T[], confirmed: ReadonlySet<string>): T[] {
  return confirmed.size === 0 ? [...items] : items.filter((item) => !confirmed.has(item.id));
}

/**
 * 左栏只列**用户讨论**：任务执行会话不在这里（归任务行），子代理会话也不在这里
 * （它是主会话的委派执行史，入口在主会话的委派面板）。2026-11-10 用户删不掉那几条
 * 「子 Agent · 只读调查」就是因为子代理会话混进了左栏：服务端按委派账本拒绝单条删除，
 * 而整棵委派树只有从主会话才能安全清理。把它挡在读侧，左栏的删除语义才和 Owner 对齐。
 */
function onRail(session: RelayAssistSession): boolean {
  return session.taskId === null && (session.parentSessionId ?? null) === null;
}

/**
 * 左栏的「近期工作」分组（协作页 §3.1 重塑）。
 *
 * 范围仍是「当前工作空间已加载的任务与会话」，排序仍是服务端时间倒序：
 * 选中态由 URL（`/agent?work=`、`/agent?session=`）承担，因此深链接与刷新都能恢复同一处工作。
 * 这里不读 Assist 会话列表冒充全部工作，也不自动绑定最新 Run。
 *
 * 栏底「查找更多任务 / 会话」入口已于 2026-10-16 第四轮按用户决定删除：
 * 那个面板读的是与本列相同的两个端点（任务仅第一页、无搜索翻页），能显示的这里都能显示，
 * 翻页后这里更多，是更弱的重复入口；这一列（搜索＋「更早的任务」）是任务与会话的唯一导航入口。
 */
export default function RecentWorkRail({ client, currentTaskId, onOpen }: {
  client: RelayApiClient;
  currentTaskId: string | null;
  onOpen?: () => void;
}) {
  const navigate = useNavigate();
  const active = useActiveConversation();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [pagingError, setPagingError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<readonly string[]>(readCollapsedRailGroups);
  /** 归档区按需读取：null 表示这一段还没打开过，不为了一个收起的分组先打一趟请求。 */
  const [archived, setArchived] = useState<readonly RelayAssistSession[] | null>(null);
  const [archivedError, setArchivedError] = useState<string | null>(null);
  const [archivedLoading, setArchivedLoading] = useState(false);
  /** 拖拽落位记下来的行序（本机偏好）；空数组表示还没拖过，完全按服务端顺序显示。 */
  const [ranked, setRanked] = useState<readonly string[]>(readRailSessionOrder);
  /** 正在拖的那一行与落位横线的位置；null 表示没有拖拽在进行。 */
  const [drag, setDrag] = useState<Drag | null>(null);
  /**
   * 批量删除的选择集（2026-10-20 用户指令「给会话 item 加一个复选框，方便删除记录」）。
   *
   * 存的是**会话 id** 而不是行 key：同一段讨论可能同时出现在「目标」与「会话（按目录）」
   * 两段里，勾一处两处一起勾上，删除也只发一条命令。任务行没有删除命令，不参与选择。
   */
  const [selected, setSelected] = useState<readonly string[]>([]);
  /**
   * `confirm` 是就地确认（与 ⋯ 面板里的删除确认同一读法），`busy` 是命令在途。
   * 结果不再占用左栏里的第三张卡片：失败/待核实写进页壳反馈栈的非阻塞 Notice，
   * 勾选同时清空，用户不必先关一张卡才能继续操作（2026-11-10 用户指认）。
   */
  const [batch, setBatch] = useState<"idle" | "confirm" | "busy">("idle");
  /**
   * 批量删除的失败/待核实结果（2026-10-31，2026-11-10 改由 Notice 呈现）。
   *
   * 只留一行结论与去重后的原因，不列会话标题：标题本身就是长提示词，会把左栏
   * 再次撑成一长段红字。逐条身份与原始 command_id 留在状态里，供「核对回执」使用。
   */
  const [batchResult, setBatchResult] = useState<BatchDeleteReport | null>(null);
  /** 核对回执在途：防止重复点同一枚 Notice 动作；核对只读，不重发删除。 */
  const [batchRechecking, setBatchRechecking] = useState(false);
  /** 「清空该工作区」整组成功后的全局回执：回执挂在左栏上，不会随空分组卸载。 */
  const [clearToast, setClearToast] = useState<{ readonly text: string; readonly seq: number } | null>(null);
  const clearToastSeq = useRef(0);
  const request = useRef(0);
  const archivedRequest = useRef(0);
  /** 本次挂载里已由服务端确认删除的会话身份，只用于挡住删除之前发出的旧读数（见 withoutConfirmedDeletes）。 */
  const confirmedDeleted = useRef(new Set<string>());
  /** 拖拽松手那一拍：浏览器补发的 click 不当作「打开会话」。 */
  const clickGuard = useRef(false);
  /** 整栏根节点：改序前按它量一遍所有行的当前顶边（FLIP 的 First）。 */
  const railRef = useRef<HTMLElement | null>(null);
  /** 待播放的一次改序快照；空表示这一拍没有布局变化。 */
  const flipRows = useRef(new Map<string, FlipRow>());
  /** 刚落位的那一行（可能同时出现在目标组与目录组里）与它的强调计时。 */
  const droppedRowKey = useRef<string | null>(null);
  const droppedElements = useRef<HTMLElement[]>([]);
  const droppedTimer = useRef<number | null>(null);

  const load = useCallback(async (cursor: string | null) => {
    const version = ++request.current;
    if (cursor === null) { setLoaded(null); setLoading(true); setError(null); } else setLoadingMore(true);
    setPagingError(null);
    if (cursor === null) setSessionsError(null);
    try {
      // 会话与任务同时发起（保持左栏「先任务、再项目、再会话」的固定读取顺序），
      // 但会话的失败被就地吸收：它读不到不能把已经读到的任务列表一起清掉，
      // 也不能假装「没有会话」——失败原因如实显示在列表下方，任务行照常可用。
      const [page, projects, sessionResult] = await Promise.all([
        client.getWorkspaceTasksPage(cursor), client.getProjectsPage("active", null),
        client.getAssistSessions({ includeContext: true }).then((items) => ({ items, error: null as string | null }),
          (caught: unknown) => ({ items: [], error: describeLiveError(caught).message }))
      ]);
      if (version !== request.current) return;
      const titles = new Map(projects.items.map((project: RelayProjectListItem) => [project.id, project.title]));
      const sorted = [...page.items].sort(compareTasks);
      const workspaceSessions = withoutConfirmedDeletes(
        sessionResult.items.filter(onRail),
        confirmedDeleted.current).sort(compareSessions);
      setLoaded((current) => ({
        tasks: cursor === null ? sorted : [...new Map([...(current?.tasks ?? []), ...sorted].map((task) => [task.id, task])).values()],
        // 续页时若会话这次没读到，保留上一次的结果，不用一次失败把已有行清掉。
        sessions: cursor === null || sessionResult.error === null ? workspaceSessions : current?.sessions ?? [],
        projectTitles: cursor === null ? titles : new Map([...(current?.projectTitles ?? []), ...titles]),
        nextCursor: page.nextCursor, loadedAt: new Date().toISOString()
      }));
      if (cursor === null) setSessionsError(sessionResult.error);
      // 选择集跟随这一列的事实收敛：整列重读之后，已不在活跃列表里的 id（被别处删掉、
      // 被归档出活跃区）不再计入「已选」。只按读成功的那一趟收敛——一次读取失败不能
      // 反过来把人的勾选清空。删掉的那几条在各自的命令回执里已即时摘除，这里只兜底。
      if (cursor === null && sessionResult.error === null) {
        setSelected((current) => current.length === 0 ? current
          : current.filter((sessionId) => workspaceSessions.some((item) => item.id === sessionId)));
      }
    } catch (caught) {
      if (version !== request.current) return;
      const described = describeLiveError(caught);
      const message = described.kind === "transport" ? "近期工作暂时无法读取，请刷新重试。" : described.message;
      if (cursor === null || caught instanceof RelayApiError && [401, 403, 404].includes(caught.problem.status)) {
        setLoaded(null); setError(message);
      } else setPagingError(message);
    } finally {
      if (version === request.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [client]);

  useEffect(() => {
    void load(null);
    return () => { request.current++; };
  }, [load]);

  /**
   * 任务事实的第一页复查（2026-11-10，运行指示的收敛路径）。
   *
   * 分组标题的运行指示读 `executor.run_id`：只有服务端知道 Run 是否还持有执行权，
   * 界面不按状态文字推断。这里只合并**第一页读回的行**，不重置分页、不清已加载的更早任务：
   * 运行状态变化、行内完成后释放执行权都由它收敛；旧读数不覆盖整列重读的结果
   * （发起时记下整列读取的版本，回包被后来的整列读取接管就整份丢弃）。
   * 失败返回 false：保留上一拍读数，不把在跑的显示成静止，也不把已完成的当成还在跑。
   */
  const refreshTaskFacts = useCallback(async (): Promise<boolean> => {
    const version = request.current;
    try {
      const page = await client.getWorkspaceTasksPage(null);
      if (version !== request.current) return true;
      setLoaded((previous) => {
        if (previous === null) return previous;
        const incoming = new Map(page.items.map((task) => [task.id, task]));
        const merged = previous.tasks.map((task) => incoming.get(task.id) ?? task);
        for (const task of page.items) {
          if (!merged.some((item) => item.id === task.id)) merged.push(task);
        }
        return { ...previous, tasks: [...merged].sort(compareTasks) };
      });
      return true;
    } catch {
      return false;
    }
  }, [client]);

  /**
   * 读取已归档那一段（0090）。归档的会话不在默认列表里，只有展开这一段时才读。
   * 失败只影响这一段自己的提示，不把上面已经读到的任务与会话一起清掉；
   * 失败也不把列表写成 []——空结果与读取失败是两个事实（禅道 #134）。
   */
  const loadArchived = useCallback(async () => {
    const version = ++archivedRequest.current;
    setArchivedLoading(true);
    setArchivedError(null);
    try {
      const items = await client.getAssistSessions({ status: "ARCHIVED" });
      if (version !== archivedRequest.current) return;
      setArchived(withoutConfirmedDeletes(items.filter(onRail),
        confirmedDeleted.current).sort(compareSessions));
    } catch (caught) {
      if (version !== archivedRequest.current) return;
      setArchivedError(describeLiveError(caught).message);
    } finally {
      // 只有仍是最新一次请求时才能动 loading：被更新的读取接管的旧回包不负责收尾。
      if (version === archivedRequest.current) setArchivedLoading(false);
    }
  }, [client]);

  /**
   * 行内命令之后按身份重读那一条：改名、置顶、归档、重开都重读这一条，分叉重读那次新建的
   * 子会话（0113）。左栏显示哪个版本必须由服务端说，不在本地拼一份看起来对的行。
   * 归档的那条从活跃列表挪进归档区，重开的反向；读不回来时保留当前行，交给整列读取收敛。
   */
  const refreshSession = useCallback(async (sessionId: string) => {
    if (confirmedDeleted.current.has(sessionId)) return;
    let session: RelayAssistSession;
    try { session = await client.getAssistSession(sessionId, true); }
    catch { return; }
    // 重读在途时这一条可能刚被确认删除（改名撞删除是同一拍）：落地前再认一次身份，
    // 不能让删除之前发出的那一发读数把已确认删除的行重新插回列表。
    if (confirmedDeleted.current.has(sessionId)) return;
    const movable = onRail(session);
    setLoaded((previous) => previous === null ? previous : { ...previous,
      sessions: movable && session.status === "ACTIVE"
        ? sortSessions([session, ...previous.sessions.filter((item) => item.id !== sessionId)])
        : previous.sessions.filter((item) => item.id !== sessionId) });
    setArchived((previous) => previous === null ? previous
      : movable && session.status === "ARCHIVED"
        ? sortSessions([session, ...previous.filter((item) => item.id !== sessionId)])
        : previous.filter((item) => item.id !== sessionId));
  }, [client]);

  /**
   * 服务端**确认删除**之后这一列唯一的收尾（单条、批量、按原 command_id 核对回执三条路径共用）。
   *
   * 三件事按确切 sessionId 一次做完：
   * 1. 记下这些身份，让删除之前发出的旧读数不能再把行带回列表（见 `withoutConfirmedDeletes`）；
   * 2. 从活跃投影、归档投影与勾选集同时摘掉——分组副本都是从这两份列表派生的，只改统计不算收干净；
   * 3. 只有「删的正是当前在看的那一条」才收尾，且收尾只做一件事：发出既有的「新对话」路由意图。
   *    会话身份与聊天区的 Owner 是协作页，它按 `?new=` 清掉 `sessionId`、重挂空白输入器；
   *    左栏既不登记第二份「已删除」状态，也不自己清高亮——跳转之后由协作页重新发布身份。
   *    删的是别的会话时这里一个字都不动：当前会话的 sessionId、路由与侧栏高亮必须原样保留。
   */
  function settleConfirmedDeletes(removedIds: readonly string[]) {
    const gone = new Set(removedIds.filter((sessionId) => sessionId !== ""));
    if (gone.size === 0) return;
    for (const sessionId of gone) confirmedDeleted.current.add(sessionId);
    setLoaded((previous) => previous === null ? previous : { ...previous,
      sessions: previous.sessions.filter((item) => !gone.has(item.id)) });
    setArchived((previous) => previous === null ? previous
      : previous.filter((item) => !gone.has(item.id)));
    setSelected((current) => current.length === 0 ? current
      : current.filter((sessionId) => !gone.has(sessionId)));
    // 批量要串行跑好几秒，渲染闭包里的 `active` 还停在起手那一拍；身份在这里现读，
    // 不能拿旧闭包判断「删的是不是当前在看的那一条」。读的是同一个 store 的同一份值。
    const activeId = readActiveConversation().sessionId;
    if (activeId === null || !gone.has(activeId)) return;
    // 刻意不带 `source_session`：左栏「新对话」用它是为了继承当前会话的上下文档位，而这一条
    // 此刻在服务端已经不存在——把已删身份当来源等于让协作页去读一条查不到的会话。
    void navigate(`/agent?new=${encodeURIComponent(createCommandId())}`);
    onOpen?.();
  }

  function onRowChanged(sessionId: string, patch: SessionRowPatch) {
    // 分叉不改这一行：源会话一行都没动，要读回来的是那次新建的子会话（0113）。
    if (patch.kind === "fork") { void refreshSession(patch.forkedSessionId); return; }
    // 删除后这条会话不再存在（ADR-027）：重读只会 404，走统一的确认删除收尾。
    if (patch.kind === "delete") { settleConfirmedDeletes([sessionId]); return; }
    void refreshSession(sessionId);
    // 归档/重开会让这一条换列表，其余只改这一行自身；都只重读这一条，不重置任务分页。
    if (patch.kind !== "archive" && patch.kind !== "reopen") return;
    if (archived === null) void loadArchived();
  }

  /** 勾选/取消一条会话。同一会话的两处副本共用这一个状态，因此两处永远同步。 */
  function toggleSelected(sessionId: string, next: boolean) {
    setBatch((current) => current === "busy" ? current : "idle");
    // 开始一轮新的勾选就收走上一轮的失败提示：那条提示说的是上一批条目，不是这一批。
    setBatchResult(null);
    setSelected((current) => next
      ? (current.includes(sessionId) ? current : [...current, sessionId])
      : current.filter((item) => item !== sessionId));
  }

  function clearSelection() {
    setSelected([]); setBatch("idle"); setBatchResult(null); setBatchRechecking(false);
  }

  /**
   * 批量删除：一段讨论一条命令，各自取新的 `command_id`、各自带**读回来的**修订。
   *
   * 五条口径：
   * 1. **不合并成一次请求。** 服务端只有逐条删除命令（ADR-027），客户端也不假装原子：
   *    每一条的结果单独核对，成功几条、失败几条分别如实报告。
   * 2. **串行发、逐条等回执。** 并发只会让「哪条成了、哪条没成」更难读；一条失败也不影响
   *    其余几条的判断。
   * 3. **结果未知不重发。** 5xx 或响应丢失意味着这一条是否已删尚未确定：先按**原 command_id**
   *    核对一次回执，核对到就算已删；核对不到就留在「待核实」，换 `command_id` 重试违反契约。
   * 4. **被引用阻止不是失败。** `SESSION_DELETE_BLOCKED` 是业务拒绝（行还在），说明里给出
   *    阻止项与**真正能做的动作**；结果写进非阻塞 Notice，勾选清空，用户可继续操作。
   * 5. **同一原因只说一次，且不点名长标题。** 被阻止的讨论按阻断原因聚合：原因写一次。
   *    标题本身就是用户的提示词，点名会把反馈卡撑成滚不完的红字（2026-11-10 用户指认）；
   *    逐条身份仍留在状态里供「核对回执」使用。
   */
  async function deleteSelected() {
    const targets = selectedSessions;
    if (targets.length === 0) { clearSelection(); return; }
    setBatch("busy"); setBatchResult(null); setBatchRechecking(false);
    const removed: string[] = [];
    /** 阻断原因 → 被它挡住的标题（按发送顺序累积）。 */
    const blockedByReason = new Map<string, { titles: string[]; reasons: readonly string[];
      reasonCodes: readonly string[] }>();
    /** 不属阻断的失败（冲突、校验等）：各有自己的说明，逐条列出。 */
    const failed: { title: string; message: string }[] = [];
    const unresolved: { sessionId: string; title: string; message: string;
      requestId: string | null; commandId: string }[] = [];
    for (const session of targets) {
      const commandId = createCommandId();
      const outcome = await deleteSessionAndVerify(client, session, commandId);
      if (outcome.state === "deleted") {
        removed.push(session.id);
        continue;
      }
      if (outcome.state === "blocked") {
        const key = outcome.reasons.join("、");
        const existing = blockedByReason.get(key);
        blockedByReason.set(key, existing === undefined
          ? { titles: [session.title], reasons: outcome.reasons, reasonCodes: outcome.reasonCodes }
          : { ...existing, titles: [...existing.titles, session.title] });
        continue;
      }
      if (outcome.state === "failed") {
        failed.push({ title: session.title, message: outcome.message });
        if (outcome.conflict) void refreshSession(session.id);
        continue;
      }
      unresolved.push({ sessionId: session.id, title: session.title, message: outcome.message,
        requestId: outcome.requestId, commandId });
    }
    // 确认删掉的那几条走同一个收尾：行、分组副本、勾选，以及「删的正是当前会话」时的路由意图。
    settleConfirmedDeletes(removed);
    const report: BatchDeleteReport = {
      deleted: removed.map((sessionId) => targets.find((session) => session.id === sessionId)?.title ?? ""),
      blocked: [...blockedByReason.values()],
      failed,
      unresolved
    };
    const hasProblem = report.blocked.length > 0 || report.failed.length > 0
      || report.unresolved.length > 0;
    // 全部成功时不留提示：行当场消失就是回执，删除不可撤销、也不需要撤销条。
    if (!hasProblem) {
      setBatch("idle");
      setBatchResult(null);
      return;
    }
    // 失败不留在左栏里做终态卡片：勾选清空、操作栏收起，结果写成页壳反馈栈里的
    // 非阻塞 Notice。用户不必先关掉一张卡才能继续勾选或打开别的讨论。
    setBatch("idle");
    setSelected([]);
    setBatchResult(report);
  }

  /**
   * 按原 command_id 核对那些「结果未知」的会话（2026-11-01 修正）。
   *
   * 核对到回执就算已删：行从列表消失、计数跟着变；核对不到仍是未知，措辞不变——
   * 不改成「删除失败」，也不换 command_id 再发一次。
   *
   * 移除必须按**确切 sessionId** 同时打在活跃投影与归档投影上：这一列的分组副本、勾选集
   * 都是从这两份列表派生的，只改结果统计会让刚确认已删的那段讨论继续留在行里（独立验收
   * 发现的 P1）。仍未知的那几条一行都不动——本次是否删掉还没确定，界面不替用户猜。
   */
  async function recheckUnresolved() {
    if (batchResult === null || batchResult.unresolved.length === 0 || batchRechecking) return;
    setBatchRechecking(true);
    const gone = new Set<string>();
    const stillUnknown: { sessionId: string; title: string; message: string;
      requestId: string | null; commandId: string }[] = [];
    const goneTitles: string[] = [];
    try {
      for (const item of batchResult.unresolved) {
        const verdict = await verifyDeleteReceipt(client, item.commandId);
        if (verdict === "deleted") { gone.add(item.sessionId); goneTitles.push(item.title); }
        else stillUnknown.push(item);
      }
      if (gone.size > 0) {
        setBatchResult((previous) => {
          if (previous === null) return previous;
          const next = { ...previous, deleted: [...previous.deleted, ...goneTitles],
            unresolved: stillUnknown };
          // 只剩「待核实」的这一轮若已全部核对到，整条提示自己收起：没有别的失败要留，
          // 再摆一句已经过期的结论只会占着反馈栈。仍有阻断/失败时保留并更新计数。
          return stillUnknown.length === 0 && next.blocked.length === 0 && next.failed.length === 0
            ? null : next;
        });
        // 已被服务端确认删除的那几条：走与单条/批量完全相同的收尾（行、勾选、旧读数闸门、
        // 以及删的正是当前会话时的路由意图），三条确认删除路径不留两套写法。
        settleConfirmedDeletes([...gone]);
      }
    } finally {
      setBatchRechecking(false);
    }
  }

  /**
   * 会话创建/切换由协作页发布确切身份；只读回这一条，不重置已经加载的任务分页。
   * `contextEpoch` 是同一会话换了目录或归属时的第二道触发：身份没变，只看身份就永远留在旧分组。
   * `activityEpoch` 是消息落地的触发（用户消息入库、生成结算各 +1）：左栏按最后消息时间
   * 排序，服务端在那两个时刻推进 `last_message_at`，递一次计数就让这一行当场收敛，
   * 不等整列重读——计数由会话视图观察到权威投影落地时发出，本地不猜时刻。
   *
   * 读回的这条**按同一档自动序插回，不插到列首**：目标/目录分组只是全局列序的子序列，
   * 列首一换分组就整体换位——切换会话于是变成「工作区分组乱跳」（2026-10-23 用户截图指认）。
   * 列序只由服务端口径（置顶优先、最后消息时间倒序）决定，当前选中项不参与排序；
   * 已在列里的会话原位替换，没读到的才追加后入序（深链接到更早的会话也落在它的时刻位上）。
   */
  useEffect(() => {
    if (active.taskId !== null || active.sessionId === null) return;
    const sessionId = active.sessionId;
    let current = true;
    void client.getAssistSession(sessionId, true).then((session) => {
      if (!current || session.id !== sessionId || !onRail(session)) return;
      // 这一发是在删除确认之前发出的：本地已认定这条不存在，旧读数不能再把它插回列里。
      if (confirmedDeleted.current.has(sessionId)) return;
      setLoaded((previous) => {
        if (previous === null) return previous;
        const replaced = previous.sessions.some((item) => item.id === session.id)
          ? previous.sessions.map((item) => item.id === session.id ? session : item)
          : [...previous.sessions, session];
        return { ...previous, sessions: sortSessions(replaced) };
      });
    }).catch(() => {
      if (current) setSessionsError("当前会话暂未能在近期工作中核对，请刷新重试。");
    });
    return () => { current = false; };
  }, [client, active.taskId, active.sessionId, active.contextEpoch, active.activityEpoch]);

  /**
   * 这一列有没有需要按拍重读的在途事实：回复生成（`run_state`），或标题生成（0157）。
   *
   * 两种都只读服务端读时派生的投影；只有真在途时才轮询，平时一个请求都不多打。
   * 标题生成是异步的辅助外呼，界面不靠它保证完成，只靠它把已确认的标题显示出来——
   * 没有这条判据，左栏会一直停在旧标题直到下一次整列重读。
   */
  const watchingWork = (loaded?.sessions ?? []).some((session) =>
    session.runState !== null ||
    session.titleGeneration?.status === "PENDING" ||
    session.titleGeneration?.status === "CLAIMED");

  /**
   * 运行态轮询（2026-10-28，用户要求「切到别的会话也能看出哪条在生成」）。
   *
   * 为什么必须轮询：`run_state` 只由服务端的消息状态派生，左栏除了整列重读没有第二条
   * 获知途径。已有机制里最贴近的两条都不够——`activityEpoch` 只对**正在看**的那条会话
   * 递计数（切走就不再递），归档区是显式读取。因此这里只补「在途期间按固定节拍重读一次
   * 会话列表」这一件事，其余一律复用既有入口。
   *
   * 有五条边界：
   * 1. **一次请求覆盖整列**：读的是 `GET /assist-sessions`（同一次读取里带上运行态），
   *    不为每个条目单独发请求，也不新增端点。
   * 2. **有界**：没有任何在跑的就根本不轮询；连续 40 拍（约 2 分钟）还在跑就降频到 10s，
   *    长任务不会把请求量顶上去；读取失败按 3→6→12→24→30s 退避，上限 30s。
   * 3. **不可见时不打请求**：页面在后台只保留计时，切回可见那一拍立刻补一次，
   *    回来时不会先看到一段旧状态。
   * 4. **失败不伪造任何状态**：读失败就保留上一次读到的运行态，既不把在跑的清成静止，
   *    也不假装「已经跑完」——宁可旧一拍，不编一条没有依据的结论。
   * 5. **不抢整列重读的结果**：整列重读（翻页、切连接）期间发起的那一拍按版本号丢弃，
   *    避免旧响应盖掉新列表。
   */
  useEffect(() => {
    if (!watchingWork) return;
    let stopped = false;
    let timer: number | null = null;
    let ticks = 0;
    let failures = 0;
    const schedule = (delay: number) => {
      timer = window.setTimeout(() => { void poll(); }, delay);
    };
    const poll = async (): Promise<void> => {
      timer = null;
      if (stopped) return;
      if (document.visibilityState === "hidden") { schedule(RUN_POLL_BASE_MS); return; }
      ticks += 1;
      const version = request.current;
      try {
        const items = await client.getAssistSessions({ includeContext: true });
        if (stopped) return;
        failures = 0;
        if (version !== request.current) { schedule(RUN_POLL_BASE_MS); return; }
        const next = withoutConfirmedDeletes(items.filter(onRail),
          confirmedDeleted.current).sort(compareSessions);
        setLoaded((previous) => previous === null ? previous : { ...previous, sessions: next });
      } catch {
        if (stopped) return;
        failures += 1;
      }
      schedule(failures > 0
        ? Math.min(RUN_POLL_MAX_BACKOFF_MS, RUN_POLL_BASE_MS * 2 ** Math.min(failures, 4))
        : ticks >= RUN_POLL_SLOW_AFTER ? RUN_POLL_SLOW_MS : RUN_POLL_BASE_MS);
    };
    const onVisibility = () => {
      if (stopped || document.visibilityState !== "visible") return;
      if (timer !== null) { window.clearTimeout(timer); timer = null; }
      void poll();
    };
    schedule(RUN_POLL_BASE_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [client, watchingWork]);

  /**
   * 任务运行态的复查节拍（2026-11-10，用户要求「有任务执行时分组处不停转动」）。
   *
   * 指示读的是任务投影的 `executor.run_id`，只有服务端说 Run 还持有执行权才算在跑。
   * 有已知在跑的任务时按会话轮询同一档节拍（3s，长跑降 10s）让指示在完成那一刻收敛；
   * 没有已知在跑的任务时降到 30s 一次——执行可能由后台自动推进启动，不经过本页的任何
   * 命令回执，没有这条低频复查指示就会长期缺席。两条都只在页面可见时打请求，
   * 读失败按 3→6→12→24→30s 退避，回包被整列读取接管时由 refreshTaskFacts 丢弃。
   */
  const watchingTaskRuns = (loaded?.tasks ?? []).some((task) => task.executorRunId !== null);
  const hasLoadedTasks = loaded !== null;
  useEffect(() => {
    if (!hasLoadedTasks) return;
    let stopped = false;
    let timer: number | null = null;
    let ticks = 0;
    let failures = 0;
    const baseDelay = () => watchingTaskRuns
      ? (ticks >= RUN_POLL_SLOW_AFTER ? RUN_POLL_SLOW_MS : RUN_POLL_BASE_MS)
      : TASK_IDLE_POLL_MS;
    const schedule = (delay: number) => { timer = window.setTimeout(() => { void poll(); }, delay); };
    const poll = async (): Promise<void> => {
      timer = null;
      if (stopped) return;
      if (document.visibilityState === "hidden") { schedule(baseDelay()); return; }
      ticks += 1;
      const ok = await refreshTaskFacts();
      if (stopped) return;
      failures = ok ? 0 : failures + 1;
      schedule(failures > 0
        ? Math.min(RUN_POLL_MAX_BACKOFF_MS, baseDelay() * 2 ** Math.min(failures, 4))
        : baseDelay());
    };
    const onVisibility = () => {
      if (stopped || document.visibilityState !== "visible") return;
      if (timer !== null) { window.clearTimeout(timer); timer = null; }
      void poll();
    };
    schedule(baseDelay());
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [hasLoadedTasks, refreshTaskFacts, watchingTaskRuns]);

  /**
   * 切进或离开某项任务的会话时复查一次任务事实：左栏在导航之间不重挂载，
   * 而运行指示要能反映刚在任务页启动/结束的执行。只按身份变化补一次，不重置分页；
   * 失败保留上一拍读数，由上面的节拍继续收敛。
   */
  const activeTaskIdentity = active.taskId ?? "";
  const lastActiveTask = useRef<string | null>(null);
  useEffect(() => {
    if (lastActiveTask.current === null) { lastActiveTask.current = activeTaskIdentity; return; }
    if (lastActiveTask.current === activeTaskIdentity) return;
    lastActiveTask.current = activeTaskIdentity;
    if (hasLoadedTasks) void refreshTaskFacts();
  }, [activeTaskIdentity, hasLoadedTasks, refreshTaskFacts]);

  const tasks = loaded?.tasks ?? [];
  const loadedSessions = loaded?.sessions ?? [];
  // 服务端读回来的次序保持原样（那是它的排序键），这一列显示成什么次序由本机偏好覆盖。
  const sessions = applyManualOrder(loadedSessions, ranked);
  // 未归入项目时组标题与副行用同一句话：同一列里出现两种说法会读成两个不同的状态。
  const projectName = useCallback((projectId: string | null) => projectId === null ? "未归入项目"
    : loaded?.projectTitles.get(projectId) ?? "项目标题暂不可读取", [loaded]);
  // 只在已加载范围内筛，不替服务端承诺全量搜索：命中数与已加载数必须同时可读。
  const needle = query.trim().toLowerCase();
  const hit = (text: string) => needle === "" || text.toLowerCase().includes(needle);
  const visibleTasks = tasks.filter((task) => hit(`${task.title} ${loaded?.projectTitles.get(task.projectId ?? "") ?? ""}`));
  const visibleSessions = sessions.filter((session) => hit(`${session.title} ${loaded?.projectTitles.get(session.projectId ?? "") ?? ""} ${session.context?.projectGoals.map((goal) => goal.title).join(" ") ?? ""} ${session.context?.workingDirectory?.canonicalRoot ?? ""}`));
  const loadedCount = tasks.length + sessions.length;

  const toRow = (session: RelayAssistSession): Row => ({ key: `session:${session.id}`, kind: "session",
    id: session.id, title: session.title, projectId: session.projectId, updatedAt: session.updatedAt,
    pinned: session.pinnedAt !== null, unread: session.unreadAt !== null, running: false });
  const rows: readonly Row[] = [
    ...visibleTasks.map((task): Row => ({ key: `task:${task.id}`, kind: "task", id: task.id,
      title: task.title, projectId: task.projectId, updatedAt: task.updatedAt, pinned: false,
      unread: false, running: task.executorRunId !== null })),
    ...visibleSessions.map(toRow)
  ];
  // 行只带展示字段，命令要的是会话本身（状态、修订、置顶时刻）；按 id 回查这一条，
  // 不在 Row 上复制第二套会话状态——修订一旦对不上，CAS 就会拿错期望值。
  const sessionById = new Map<string, RelayAssistSession>(
    [...sessions, ...(archived ?? [])].map((session) => [session.id, session]));
  // 选择集按 id 回查这一条：勾选后行被重读、被移段都不影响身份；已不在列表里的 id
  // （例如别处删掉了）直接不计入，不用一份可能过期的本地副本去发删除命令。
  const selectedSessions = selected.map((sessionId) => sessionById.get(sessionId))
    .filter((session): session is RelayAssistSession => session !== undefined);
  /** 是否存在有效勾选：批量操作栏与「不许收起会话（按目录）」都由它驱动。 */
  const selecting = selectedSessions.length > 0;
  /**
   * 批量操作栏（2026-10-20 第五轮重构，2026-11-10 结果移出操作栏）：从左栏外、主内容区
   * 上方居中的浮层挪回**这一列内部**，紧跟「会话（按目录）」标题下方。勾选框就在条目行里，
   * 操作入口与它同一列，视线不再横跨整个主工作区；靠 sticky 在这一列里滚动时停在列顶。
   * 无勾选时整块不渲染，这一列逐像素回到原样。
   *
   * 这里只保留「已选 / 确认」两档；删除后的失败与待核实写进页壳反馈栈的 Notice 并清空勾选。
   * 结果不再占第三张卡片——那张卡里的会话标题就是长提示词，会把左栏撑成滚不完的红字，
   * 且要人先关掉它才能继续操作（2026-11-10 用户指认）。
   */
  const batchBar = selecting ? <div className="recent-work-selection" role="group"
    aria-label="批量删除会话" data-testid="recent-work-selection">
    <p className="recent-work-selection-count" data-testid="recent-work-selection-count">
      {batch === "idle" ? `已选 ${selectedSessions.length} 段讨论`
        : `删除这 ${selectedSessions.length} 段讨论？`}</p>
    {(batch === "confirm" || batch === "busy") && <p className="recent-work-selection-note">
      消息、附件与工具调用记录将永久移除，无法恢复。</p>}
    <div className="recent-work-confirm-actions">
      {batch === "idle" ? <>
        <Button variant="text" className="recent-work-selection-danger"
          data-testid="recent-work-batch-delete"
          onClick={() => { setBatchResult(null); setBatch("confirm"); }}>删除</Button>
        <Button variant="text" data-testid="recent-work-selection-clear"
          onClick={clearSelection}>取消</Button>
      </> : <>
        <Button variant="danger" disabled={batch === "busy"}
          data-testid="recent-work-batch-delete-confirm"
          onClick={() => void deleteSelected()}>{batch === "busy" ? "正在删除…" : "删除"}</Button>
        <Button variant="secondary" disabled={batch === "busy"}
          data-testid="recent-work-batch-delete-cancel"
          onClick={() => setBatch("idle")}>取消</Button>
      </>}
    </div>
  </div> : null;
  // 归档区也吃同一个搜索词：一列里两套筛选规则会让人以为搜到的和看到的是两件事。
  const archivedRows = (archived ?? []).filter((session) => hit(`${session.title} ${loaded?.projectTitles.get(session.projectId ?? "") ?? ""}`));
  const groups = new Map<string | null, Row[]>();
  for (const row of rows.filter((row) => row.kind === "task")) {
    const group = groups.get(row.projectId) ?? [];
    group.push(row);
    groups.set(row.projectId, group);
  }
  const isActiveRow = (row: Row) => row.kind === "task"
    ? currentTaskId === row.id
    : active.taskId === null && active.sessionId === row.id;

  const goalGroups = new Map<string, { title: string; rows: Row[] }>();
  const directoryGroups = new Map<string, { title: string; path: string | null; rows: Row[] }>();
  for (const session of visibleSessions) {
    const row = rows.find((row) => row.kind === "session" && row.id === session.id)!;
    for (const goal of session.context?.projectGoals ?? []) {
      const group = goalGroups.get(goal.goalId) ?? { title: goal.title, rows: [] };
      group.rows.push(row); goalGroups.set(goal.goalId, group);
    }
    const directory = session.context?.workingDirectory;
    const key = sessionDirectoryKey(session);
    const group = directoryGroups.get(key) ?? { title: directoryLabel(session), path: directory?.canonicalRoot ?? null, rows: [] };
    group.rows.push(row); directoryGroups.set(key, group);
  }

  /**
   * 会话行拖拽改序（本机导航偏好，见 railSessionOrder）。
   *
   * 三条口径决定了这里的写法：
   * 1. **只有未归档的会话行可拖。** 任务行没有可改的位置事实，归档区也不参与手动排序，
   *    二者所在的那一列不带 `data-reorder-list`，起手直接落空。
   * 2. **⋯ 与它的浮层归菜单，复选框归选择。** 面板里的改名输入要能正常选字，
   *    复选框的点击不能变成「抓着这一行走」，起手必须让开这两块。
   * 3. **落点由这一列的实测几何算。** 拖拽期间布局不动（横线是绝对定位、不占网格轨道，被抓那一行
   *    只吃 `transform`），所以行高在起手时量一次就够，指针位置每个事件换算一次。
   */
  function beginDrag(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const origin = event.target as HTMLElement;
    if (origin.closest(".recent-work-row-trigger, .recent-work-row-panel, .recent-work-select") !== null) return;
    const row = origin.closest<HTMLElement>("[data-recent-row]");
    const ul = row?.closest<HTMLElement>("ul[data-reorder-list]") ?? null;
    if (row === null || ul === null) return;
    const source: DragSource = {
      rowKey: row.dataset.recentRow!, listKey: ul.dataset.recentList!, startY: event.clientY, ul,
      gap: Number.parseFloat(getComputedStyle(ul).rowGap) || 0,
      rows: [...ul.querySelectorAll<HTMLElement>("[data-recent-row]")].map((item) => ({
        key: item.dataset.recentRow!, top: item.offsetTop, height: item.offsetHeight })),
      moved: false
    };
    // 抓握交给「这一行的可点块」而不是整行：Chromium 会把兼容的 mouseup/click 一并重定向到抓握者，
    // 抓在 li 上会让补发的 click 落不到 .recent-work-item，普通单击就打不开会话了（浏览器实测踩过）。
    // 抓在按钮上则两全：指针滑出窗口也收得到 pointerup，落回原格时那一击仍照常打开。
    const grip = origin.closest<HTMLElement>(".recent-work-item") ?? row;
    try { grip.setPointerCapture(event.pointerId); } catch { /* 没有可用指针（键盘合成事件）时照常走窗口监听。 */ }
    // 拖起来的这一行自己不给落点：它已经不在落点候选里，横线因此永远画在别的行之间。
    const dropAt = (clientY: number) => {
      const rows = source.rows.filter((item) => item.key !== source.rowKey);
      if (rows.length === 0) return null;
      const y = clientY - source.ul.getBoundingClientRect().top + source.ul.scrollTop;
      const target = rows.find((item) => y <= item.top + item.height / 2) ?? rows[rows.length - 1];
      const before = y <= target.top + target.height / 2;
      return { targetKey: target.key, before,
        lineTop: before ? target.top - source.gap / 2 : target.top + target.height + source.gap / 2 };
    };
    const move = (pointer: PointerEvent) => {
      if (!source.moved && Math.abs(pointer.clientY - source.startY) < DRAG_START_PX) return;
      source.moved = true;
      const drop = dropAt(pointer.clientY);
      if (drop !== null) setDrag({ rowKey: source.rowKey, listKey: source.listKey,
        offsetY: pointer.clientY - source.startY, ...drop });
    };
    const end = (pointer: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      const drop = source.moved && pointer.type === "pointerup" ? dropAt(pointer.clientY) : null;
      // 先按「手里这一拍」的样子量一遍顶边，再撤掉抓握态：被抓着的那行此刻还偏在指针处，
      // 快照里带着它的平移量，松手后才是「从手里滑进缝里」；落回原格也照样滑回家，不硬跳。
      if (drop !== null) snapshotRows();
      setDrag(null);
      if (drop === null) return;
      moveSession(source.rowKey, drop.targetKey, drop.before);
      // 松手后浏览器会在同一个任务里补发一次 click。整行的 click 就是打开会话，
      // 那一击不是用户想点的「进入这条讨论」——行只是被搬走了。护栏只活到下一个宏任务，
      // 万一浏览器没有补发（指针在窗口外落下），它自己就失效，不会吞掉之后的正常点击。
      clickGuard.current = true;
      window.setTimeout(() => { clickGuard.current = false; }, 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  /** 把被拖的这条插到落点那一侧，并把整列当前次序快照成新的手动顺序。 */
  function moveSession(draggedKey: string, targetKey: string, before: boolean) {
    const dragged = draggedKey.slice("session:".length);
    const target = targetKey.slice("session:".length);
    const base = sessions.map((session) => session.id);
    const rest = base.filter((id) => id !== dragged);
    const at = rest.indexOf(target);
    if (at === -1) return;
    const cut = before ? at : at + 1;
    const next = [...rest.slice(0, cut), dragged, ...rest.slice(cut)];
    // 落回原来那一格：什么都没变，不写存储、也不把这一列重排一遍（滑回家由松手那一拍的快照负责）。
    if (next.length === base.length && next.every((id, index) => id === base[index])) return;
    droppedRowKey.current = draggedKey;
    setRanked(next);
    writeRailSessionOrder(next);
  }

  /** 记下栏内每张行（含同一会话在目标组与目录组里的两处）此刻的顶边。 */
  function snapshotRows() {
    const rail = railRef.current;
    const rows = new Map<string, FlipRow>();
    if (rail === null) { flipRows.current = rows; return; }
    for (const element of rail.querySelectorAll<HTMLElement>("[data-recent-row]")) {
      const listKey = element.closest("ul")?.dataset.recentList ?? "";
      rows.set(`${listKey}|${element.dataset.recentRow}`, {
        key: element.dataset.recentRow ?? "", element, top: element.getBoundingClientRect().top });
    }
    flipRows.current = rows;
  }

  /**
   * FLIP 的 Invert + Play：把快照里那些行从「拍下的样子」滑到「提交后的样子」。
   *
   * 只动 transform，不改布局属性，所以整列不会因动画再排一次。两种落法都走这里：
   * 真改了序的，同一会话在目标组与目录组里各按自己那列的实测位置滑，两处读起来是同一次交换；
   * 落回原格没改序的，只有手里那一行从指针处滑回家。减少动态效果时直接落位——
   * 动效只是解释「谁去了哪儿」，位置本身由顺序保证。
   */
  useLayoutEffect(() => {
    const rows = flipRows.current;
    flipRows.current = new Map();
    if (rows.size === 0) return;
    const animate = resolveMotionPreference()
      && typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.animate === "function";
    const droppedKey = droppedRowKey.current;
    const landed: HTMLElement[] = [];
    for (const row of rows.values()) {
      if (!row.element.isConnected) continue;
      if (animate) {
        const delta = row.top - row.element.getBoundingClientRect().top;
        if (Math.abs(delta) > 0.5) {
          row.element.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0px)" }],
            { duration: FLIP_MS, easing: FLIP_EASING });
        }
      }
      if (droppedKey !== null && row.key === droppedKey) landed.push(row.element);
    }
    droppedRowKey.current = null;
    if (landed.length === 0) return;
    // 落位强调：刚松手的这条短暂标记，替「交换是否成功」给出可读回执（与时间线跳转同一档时长）。
    clearDroppedMark();
    for (const element of landed) element.dataset.recentDropped = "true";
    droppedElements.current = landed;
    droppedTimer.current = window.setTimeout(clearDroppedMark, DROPPED_MS);
  }, [ranked, drag]);

  /** 收起落位强调。连拖两次时前一次的标记由这里清掉，不会留在旧行上。 */
  function clearDroppedMark() {
    if (droppedTimer.current !== null) {
      window.clearTimeout(droppedTimer.current);
      droppedTimer.current = null;
    }
    for (const element of droppedElements.current) delete element.dataset.recentDropped;
    droppedElements.current = [];
  }

  useEffect(() => () => {
    if (droppedTimer.current !== null) window.clearTimeout(droppedTimer.current);
  }, []);

  function renderRows(groupRows: readonly Row[], listKey: string, options: { goalId?: string; reorderable?: boolean } = {}) {
    const { goalId, reorderable = false } = options;
    const drop = drag !== null && drag.listKey === listKey ? drag : null;
    return <ul className="recent-work-list" data-recent-list={listKey}
      {...(reorderable ? { "data-reorder-list": "session" } : {})}
      onPointerDown={reorderable ? beginDrag : undefined}>
      {drop !== null && <li className="recent-work-drop-line" data-testid="recent-work-drop-line"
        style={{ insetBlockStart: `${drop.lineTop}px` }} aria-hidden="true" />}
      {groupRows.map((row) => {
        const session = row.kind === "session" ? sessionById.get(row.id) : undefined;
        // 「未开始」进可访问名称：标记是视觉上的，读屏与键盘用户同样要能分辨这条还没说过话。
        // 判据是服务端读时派生的 hasMessages（数消息表），不是活动键的可空性。
        const notStarted = session !== undefined && !session.hasMessages;
        // 状态也进可访问名称：图标是视觉信号，读屏与键盘用户要读到同一件事。
        // 文案与服务端的八态同源（`lib/sessionState`），不只覆盖运行与排队两档；
        // 旧服务端没有 list_state 时退回只有「未开始」这一条能从 hasMessages 确认的事实。
        const stateNote = sessionStateNote(session?.listState ?? null);
        // 运行态也进可访问名称：行右侧的圆环是视觉信号，读屏用户要读到同一件事。
        const label = `${row.kind === "session" ? "会话 · " : ""}${row.title} · ${projectName(row.projectId)}${stateNote || (notStarted ? " · 未开始" : "")}${row.unread ? " · 未读" : ""}${row.running ? " · 有任务正在执行" : ""}`;
        // 同一组里出现同名行时，时刻要带上时分才分得清是哪一条；完整时间留在摘要卡的 time 上。
        const sameTitle = groupRows.some((other) => other.key !== row.key && other.title === row.title);
        return <RecentWorkRow key={row.key} kind={row.kind} title={row.title}
          testId={goalId ? `recent-work-goal-${goalId}-${row.id}` : `recent-work-${row.id}`}
          label={label} active={isActiveRow(row)} pinned={row.pinned} unread={row.unread} running={row.running}
          // 拖拽要认得出「这是哪一行」：被抓着的那一行只出现在起手那一列，
          // 同一会话在另一列里的副本留在原地等落位动画。
          rowKey={row.key} dragging={drop !== null && drop.rowKey === row.key}
          carryY={drop !== null && drop.rowKey === row.key ? drop.offsetY : null}
          timeLabel={row.updatedAt === null ? null : formatRailTime(row.updatedAt, sameTitle)}
          timeValue={row.updatedAt}
          timeTitle={row.updatedAt === null ? null : new Date(row.updatedAt).toLocaleString("zh-CN")}
          // 归属：会话取目录末段，任务取项目名——与它们各自的分组依据同源。
          scopeName={session === undefined ? projectName(row.projectId) : directoryLabel(session)}
          session={session} client={client} onOpen={() => openRow(row, goalId)}
          onChanged={(patch) => onRowChanged(row.id, patch)}
          onStale={() => { void refreshSession(row.id); }}
          selected={session !== undefined && selected.includes(row.id)}
          selectionBusy={batch === "busy"}
          onSelectedChange={(next) => toggleSelected(row.id, next)} />;
      })}</ul>;
  }

  // 定位到当前会话/任务时展开它所在的区与组，但只在身份变化那一刻做一次。
  // 常驻的强制展开会让用户永远收不起这一列：活动会话必然落在「会话（按目录）」里，
  // 于是那一段的 summary 点了没反应。折叠偏好重新成为唯一依据，定位改由下面这条补偿。
  const activeIdentity = `${active.taskId ?? ""}|${active.sessionId ?? ""}`;
  const revealedFor = useRef("");
  useEffect(() => {
    if (loaded === null || activeIdentity === "|" || revealedFor.current === activeIdentity) return;
    revealedFor.current = activeIdentity;
    const keys: string[] = [];
    for (const [goalId, group] of goalGroups) if (group.rows.some(isActiveRow)) keys.push(`goal:${goalId}`, "goals");
    for (const [directoryId, group] of directoryGroups) if (group.rows.some(isActiveRow)) keys.push(`directory:${directoryId}`, "directories");
    for (const [projectId, groupRows] of groups) if (groupRows.some(isActiveRow)) keys.push(railGroupKey(projectId), "tasks");
    if (keys.length === 0) return;
    setCollapsed((current) => {
      const next = current.filter((key) => !keys.includes(key));
      if (next.length === current.length) return current;
      writeCollapsedRailGroups(next);
      return next;
    });
  // 只跟身份与数据到位走：分组映射每轮都是新对象，列进去会让这条在每次渲染后重跑。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdentity, loaded]);

  function groupToggle(element: HTMLDetailsElement, key: string) {
    toggleGroup(key, element.open);
  }

  function openRow(row: Row, goalId?: string) {
    // 拖拽松手那一拍里的 click 是浏览器补发的，不是「进入这条讨论」。
    if (clickGuard.current) return;
    void navigate(row.kind === "task"
      ? `/agent?work=${encodeURIComponent(row.id)}`
      : `/agent?session=${encodeURIComponent(row.id)}${goalId ? `&goal=${encodeURIComponent(goalId)}` : ""}`);
    onOpen?.();
  }
  /**
   * 目录行悬停的「＋」：带着这一行的目录绝对路径去协作页开一段空对话。
   *
   * 与栏头「新对话」同一条语义——`?new=` 只打开空白输入，不提前建空会话（会话仍在首条发送时
   * 建立）；差别是这里多带一个 `?dir=`，协作页在挂载那一拍按同一条 openFolder 打开它。
   * 目录事实、草稿与首条命令仍然只有协作页一个 Owner，左栏不自己登记第二套作用域。
   */
  function newSessionInDirectory(rootPath: string) {
    void navigate(`/agent?new=${encodeURIComponent(createCommandId())}&dir=${encodeURIComponent(rootPath)}`);
    onOpen?.();
  }
  function toggleGroup(key: string, open: boolean) {
    setCollapsed((current) => {
      const next = open ? current.filter((item) => item !== key) : current.includes(key) ? current : [...current, key];
      writeCollapsedRailGroups(next);
      return next;
    });
  }

  return <section className={`recent-work${drag !== null ? " recent-work--dragging" : ""}`}
    ref={railRef} aria-label="近期工作" data-testid="recent-work">
    <label className="search-field recent-work-search">
      <Search aria-hidden="true" />
      <span className="visually-hidden">在已加载的近期任务与会话中搜索</span>
      <input type="search" value={query} placeholder="搜索已加载项"
        data-testid="recent-work-search" onChange={(event) => setQuery(event.target.value)} />
    </label>
    <div className="recent-work-scroll" role="region" aria-label="近期工作列表" tabIndex={0}
      onKeyDown={(event) => handleRosterKeyDown(event, ".recent-work-item")}>
      {loading && <p className="helper-text" role="status">正在读取…</p>}
      {error && <p className="action-error" role="alert" data-testid="recent-work-error">{error}</p>}
      {/* 兜底：只有已归档会话可勾（上面三段都没渲染）时，操作栏仍要出现在能看见的地方。 */}
      {loadedCount === 0 && batchBar}
      {/* 首装与搜索无匹配是两件事：前者说明工作空间还没有任何未归档的任务或会话，后者只说明已加载范围内没有命中。
          这里用紧凑空态、不放主操作——侧栏只是定位入口，新建任务的主决策区在任务页。
          措辞必须限定「未归档」：把唯一一条讨论归档后这一段也会出现，说「还没有任何会话」就是假话。
          标题不带限定词，因此「已归档」那一句是这句标题成立的前提，删掉它标题就变成假话。 */}
      {!loading && !error && !sessionsError && loadedCount === 0 &&
        <EmptyState size="compact" title="还没有任务或会话"
          description="新建任务开始，或用上方「新对话」直接讨论。这里只显示本机内容，归档过的收在下方「已归档」里。"
          testId="recent-work-empty"
          actions={<Button variant="text"
            onClick={() => { void navigate("/tasks?view=create"); onOpen?.(); }}>新建任务</Button>} />}
      {!loading && !error && loadedCount > 0 && rows.length === 0 &&
        <EmptyState size="compact" title="没有匹配项"
          description={`已加载的 ${loadedCount} 项里没有匹配项；搜索只覆盖已加载范围，可继续读取更早任务。`}
          testId="recent-work-no-match" />}
      <div data-testid="recent-work-list">{loadedCount > 0 && <>
        <details className="recent-work-section" data-testid="recent-work-goals"
          open={!collapsed.includes("goals")}
          onToggle={(event) => groupToggle(event.currentTarget, "goals")}>
          <summary title="同一目标可以关联多个项目与目录；这里汇集关联项目的会话"><ChevronDown aria-hidden="true" /><span className="recent-work-group-title">目标</span></summary>
          {goalGroups.size === 0 && <p className="helper-text recent-work-scope-note" role="status"
            title="仅核对当前已加载会话的项目目标关联">
            {sessionsError || sessions.some((session) => session.context === undefined) ? "目标关联暂不可读取" : needle ? "未找到匹配目标" : "暂无关联目标"}
          </p>}
          {[...goalGroups].map(([goalId, group]) => <details className="recent-work-group" key={goalId}
            open={!collapsed.includes(`goal:${goalId}`)}
            onToggle={(event) => groupToggle(event.currentTarget, `goal:${goalId}`)}>
            <summary title={group.title}><ChevronDown aria-hidden="true" /><Target aria-hidden="true" /><span className="recent-work-group-title">{group.title}</span>
              <span className="recent-work-group-count">{group.rows.length}</span></summary>
            {renderRows(group.rows, `goal:${goalId}`, { goalId, reorderable: true })}
          </details>)}
        </details>
        <details className="recent-work-section recent-work-section--directories" data-testid="recent-work-directories"
          // 有勾选时这一段不许收起：勾选项与批量操作栏都在它内部，收起之后「选了什么、
          // 能对谁操作」一起消失，只剩一份看不见的选择状态（2026-10-20 用户指令）。
          open={!collapsed.includes("directories") || selecting}
          onToggle={(event) => { if (!selecting) groupToggle(event.currentTarget, "directories"); }}>
          {/* 清空键就贴在段标题「会话（按目录）」右侧（2026-11-10 用户第二次指认）：这一段指
              这一整段会话的集合区域，不是某个目录；键放在 summary 内，点击只开清空确认、
              不触发折叠（终止冒泡在按钮上）。折叠箭头用 auto 外边距留在行尾。
              段标题 2026-11-10 由「工作区（目录）」改为「会话（按目录）」：列的是按目录归集的
              自由会话，「工作区」与数据库 Workspace 隔离边界不是一回事，旧名易被读成同一对象。 */}
          <summary><ChevronDown aria-hidden="true" />
            <span className="recent-work-group-title recent-work-section-title">会话（按目录）</span>
            <WorkspaceClearSessions client={client}
              onCleared={(deletedSessionIds, allDeleted) => {
                settleConfirmedDeletes(deletedSessionIds);
                if (allDeleted && deletedSessionIds.length > 0) {
                  setClearToast({ text: `已清空 ${deletedSessionIds.length} 条会话`,
                    seq: ++clearToastSeq.current });
                }
              }} />
          </summary>
          {batchBar}
          {directoryGroups.size === 0 && <p className="helper-text recent-work-scope-note">{needle ? "已加载范围内没有匹配会话" : sessionsError ? "会话暂不可读取" : "暂无会话"}</p>}
          {[...directoryGroups].map(([directoryId, group]) => <details className="recent-work-group" key={directoryId}
            open={!collapsed.includes(`directory:${directoryId}`)}
            onToggle={(event) => groupToggle(event.currentTarget, `directory:${directoryId}`)}>
            <summary title={group.path ?? group.title}><ChevronDown aria-hidden="true" />
              {group.path !== null && <Folder aria-hidden="true" className="recent-work-group-folder" />}
              <span className="recent-work-group-title">{group.title}</span><span className="recent-work-group-count">{group.rows.length}</span></summary>
            {/* 「＋」只在悬停/键盘聚焦这一行时出现，且是 summary 的兄弟节点：summary 里不许放可交互
                内容（HTML 规定 summary 的后代不得是交互内容），套进去还会让点击与折叠互相吞。
                没有目录依据的两段（未绑定目录／目录待核对）不长这颗键——它没有可打开的路径。 */}
            {group.path !== null && <button type="button" className="recent-work-group-new"
              title="在这个目录新建会话" aria-label={`在目录「${group.title}」新建会话`}
              data-testid={`recent-work-new-in-${directoryId}`}
              onClick={() => newSessionInDirectory(group.path!)}><SquarePen aria-hidden="true" /></button>}
            {renderRows(group.rows, `directory:${directoryId}`, { reorderable: true })}
          </details>)}
        </details>
        {tasks.length > 0 && <details className="recent-work-section recent-work-section--tasks"
          data-testid="recent-work-tasks"
          open={!collapsed.includes("tasks")}
          onToggle={(event) => groupToggle(event.currentTarget, "tasks")}>
          {/* 段标题 2026-11-10 由「任务入口」改为「任务」：这一段列的就是 Task 本身，
              「入口」只是它在左栏的角色，留着会和「会话（按目录）」读成两类同质入口。
              同日用户指认「没有新建任务的新建按钮」：段标题右侧补一颗常显的「＋」，
              与「会话（按目录）」的清空键同一形态（同在 summary 内，click 必须同时
              preventDefault + stopPropagation，否则这一击会先被读成折叠这一段）。
              目标沿用左栏空态与标题栏既有的 `/tasks?view=create`，不新造创建流程。 */}
          <summary><ChevronDown aria-hidden="true" /><span className="recent-work-group-title">任务</span>
            <IconButton className="recent-work-section-new" icon={Plus} label="新建任务"
              data-testid="recent-work-new-task"
              onClick={(event) => {
                event.preventDefault(); event.stopPropagation();
                void navigate("/tasks?view=create");
                onOpen?.();
              }} />
          </summary>
          {[...groups].map(([projectId, groupRows]) => {
            const key = railGroupKey(projectId);
            return <details className="recent-work-group" key={key} open={!collapsed.includes(key)}
              onToggle={(event) => groupToggle(event.currentTarget, key)}>
              <summary><ChevronDown aria-hidden="true" />{projectId !== null && <Folder aria-hidden="true" className="recent-work-group-folder" />}
                <span className="recent-work-group-title">{projectName(projectId)}</span>
                <span className="recent-work-group-count">{groupRows.length}</span></summary>
              {renderRows(groupRows, `task:${key}`)}
            </details>;
          })}
        </details>}
      </>}
        {/* 归档的会话不在上面任何一段里：服务端默认只列 ACTIVE，「归档即隐藏」发生在读侧。
            这一段默认收起，并且仍挂在 loadedCount 之外——把唯一一条会话归档之后上面会整列空掉，
            若这一段也跟着消失，人就再也找不到重开的入口了。
            与三个根区同处一个父容器是结构要求：`.recent-work-section + .recent-work-section`
            只覆盖相邻兄弟，2026-10-16 第七轮实测，包装层曾隔断「任务 ↔ 已归档」的相邻关系，
            任务收起时间隙塌成 0px，四个根区读成三档。 */}
        {!loading && error === null && <details className="recent-work-section" data-testid="recent-work-archived"
          onToggle={(event) => {
            if (!event.currentTarget.open || archived !== null || archivedLoading) return;
            void loadArchived();
          }}>
          <summary title="归档只是不再接收新消息；历史、提案与命令回执都保留，重开后照旧可读">
            <ChevronDown aria-hidden="true" /><span className="recent-work-group-title">已归档</span>
            {archived !== null && <span className="recent-work-group-count">{archived.length}</span>}</summary>
          {/* 状态优先级（禅道 #134）：读取中 → 失败（不落回占位）→ 初始未读 → 成功的空／非空。
              失败必须盖过「还没展开」的占位：请求已经结束，界面不能装作还没发起。 */}
          {archivedLoading
            ? <p className="helper-text recent-work-scope-note" role="status">正在读取归档列表…</p>
            : archivedError !== null
              ? <p className="action-error recent-work-scope-note" role="alert"
                data-testid="recent-work-archived-error">{archivedError}
                {/* 失败后的只读重试：与收起再展开（archived 仍为 null，重开会重读）等效，都在本页内。 */}
                <Button variant="text" data-testid="recent-work-archived-retry"
                  onClick={() => void loadArchived()}>重试</Button></p>
              : archived === null
                ? <p className="helper-text recent-work-scope-note">展开时读取归档列表</p>
                : archivedRows.length === 0
                  ? <p className="helper-text recent-work-scope-note">{needle ? "已加载范围内没有匹配项" : "暂无归档会话"}</p>
                  : renderRows(archivedRows.map(toRow), "archived")}
        </details>}
      </div>
      {pagingError && <p className="action-error" role="alert">{pagingError}</p>}
      {loaded?.nextCursor && <Button variant="secondary" disabled={loadingMore}
        title={`已加载 ${tasks.length} 项任务，继续读取更早任务`} data-testid="recent-work-more"
        onClick={() => void load(loaded.nextCursor)}>{loadingMore ? "正在读取" : `更早的任务（已加载 ${tasks.length} 项）`}</Button>}
    </div>
    {sessionsError !== null && <p className="helper-text" role="status" data-testid="recent-work-sessions-error">
      会话列表暂时读不到：{sessionsError} 任务列表仍按已加载范围显示。</p>}
    {/* 批量删除的失败/待核实结果与目录清空的成功回执都走页壳反馈栈：不进左栏文档流，
        不会把这一列撑高，也不会因为某个目录组被清空而跟着卸载。 */}
    {batchResult !== null && (
      <Notice testId="recent-work-batch-notice"
        tone={batchResult.blocked.length + batchResult.failed.length > 0 ? "danger" : "warning"}
        action={batchResult.unresolved.length > 0 ? {
          label: batchRechecking ? "核对中…" : "核对回执",
          onSelect: () => { if (!batchRechecking) void recheckUnresolved(); }
        } : undefined}>
        {batchNoticeText(batchResult)}
      </Notice>
    )}
    {clearToast !== null && <Toast key={clearToast.seq} testId="workspace-clear-success">{clearToast.text}</Toast>}
  </section>;
}

/**
 * 置顶优先，其余按最后消息时间倒序（0090 / 0111）——与服务端列表同一个口径。
 *
 * 服务端列表本来就是这个顺序，这里再排一次是因为行内命令会把一条会话插回数组头部：
 * 不在客户端保持同一顺序，置顶点了之后行会先跳到底下、下一次整列读取才回来。
 * 活动键是 `lastMessageAt ?? createdAt`，对应服务端的 `coalesce(last_message_at, created_at)`：
 * 还没说过话的新会话按创建时间留在原位，不因为这个键为空而沉底。
 */
function compareSessions(a: RelayAssistSession, b: RelayAssistSession): number {
  if ((a.pinnedAt === null) !== (b.pinnedAt === null)) return a.pinnedAt === null ? 1 : -1;
  if (a.pinnedAt !== null && b.pinnedAt !== null && a.pinnedAt !== b.pinnedAt) {
    return b.pinnedAt.localeCompare(a.pinnedAt);
  }
  return (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt);
}

function sortSessions(sessions: readonly RelayAssistSession[]): RelayAssistSession[] {
  return [...sessions].sort(compareSessions);
}

/**
 * 任务列的排序键：服务端没给 `updated_at` 的排在有时间的之后，不用客户端时间补齐。
 * 整列读取、续页合并与第一页复查共用这一档，三处不能各排一套。
 */
function compareTasks(a: RelayTaskSummary, b: RelayTaskSummary): number {
  if (a.updatedAt === null && b.updatedAt === null) return 0;
  if (a.updatedAt === null) return 1;
  if (b.updatedAt === null) return -1;
  return b.updatedAt.localeCompare(a.updatedAt);
}

/**
 * 手动拖过的行按拖出来的次序排，其余仍按服务端顺序（置顶优先、时间倒序）。
 *
 * 两条口径写死在这里，别在调用方再补一套：
 * - **没排过的项排在已排过的之前。** 新建的会话照旧出现在这一列最前，不会因为你上次拖过
 *   就被压到列尾；一旦拖拽，整列当前次序会被快照成新的手动顺序（见 moveSession）。
 * - **排过序之后，位置不再跟随置顶。** 置顶仍写服务端的排序键、行上仍显示「置顶」标记，
 *   但这一列的次序已由人指定，不再自动跳位——拖拽和置顶抢同一条列时以人的那次改动为准。
 */
function applyManualOrder(sessions: readonly RelayAssistSession[], order: readonly string[]) {
  if (order.length === 0) return sessions;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...sessions].sort((a, b) => {
    const left = rank.get(a.id);
    const right = rank.get(b.id);
    if (left !== undefined && right !== undefined) return left - right;
    if (left !== undefined) return 1;
    if (right !== undefined) return -1;
    return compareSessions(a, b);
  });
}

/**
 * 会话的归属名：目录末段；没有目录依据时如实说明，不拿项目名或「无」冒充。
 *
 * 目录分组的组标题与行摘要卡的第二行共用这一个来源——同一列里两处说法不一致，
 * 会被读成两个不同的状态（2026-10-16 第五轮把这段从分组循环里提出来）。
 */
function directoryLabel(session: RelayAssistSession): string {
  const directory = session.context?.workingDirectory;
  const path = directory?.canonicalRoot ?? null;
  if (path !== null) return path.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) || path;
  const key = directory?.resourceId ?? (session.context === undefined ? "unknown" : "unbound");
  return key === "unbound" ? "未绑定目录" : "目录待核对";
}

/** 设备本地日期：今天只显示时分，同组同名项保留时分帮助区分；完整时间留在 time 上。 */
function formatRailTime(value: string, includeTime: boolean): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  const now = new Date();
  const clock = at.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (at.toDateString() === now.toDateString()) return clock;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const date = at.toDateString() === yesterday.toDateString() ? "昨天"
    : `${at.getFullYear() === now.getFullYear() ? "" : `${at.getFullYear()}年`}${at.getMonth() + 1}月${at.getDate()}日`;
  return includeTime ? `${date} ${clock}` : date;
}
