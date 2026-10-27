import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Folder, Search, SquarePen, Target } from "lucide-react";
import { createCommandId, RelayApiError, type RelayApiClient, type RelayAssistSession, type RelayProjectListItem, type RelayTaskSummary } from "../api/relayClient";
import { useActiveConversation } from "../lib/activeConversation";
import { describeLiveError } from "../lib/liveErrors";
import { resolveMotionPreference } from "../lib/motionPreference";
import { railGroupKey, readCollapsedRailGroups, writeCollapsedRailGroups } from "../lib/railGroupPreferences";
import { readRailSessionOrder, writeRailSessionOrder } from "../lib/railSessionOrder";
import { handleRosterKeyDown } from "../lib/tabNavigation";
import { resolvedTokenValue } from "../lib/tokens";
import EmptyState from "./EmptyState";
import RecentWorkRow from "./RecentWorkRow";
import type { SessionRowPatch } from "./SessionRowMenu";

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
}

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
   * 存的是**会话 id** 而不是行 key：同一段讨论可能同时出现在「目标」与「工作区（目录）」
   * 两段里，勾一处两处一起勾上，删除也只发一条命令。任务行没有删除命令，不参与选择。
   */
  const [selected, setSelected] = useState<readonly string[]>([]);
  /**
   * `confirm` 是就地确认（与 ⋯ 面板里的删除确认同一读法），`busy` 是命令在途，
   * `result` 是**终态**：确认之后在同一张卡片里给出结果，只留「关闭」。
   *
   * 失败后不再退回 `idle` —— 退回会让同一张卡片第三次变成「已选 N 段讨论 + 删除」，
   * 像在要求用户再确认一遍一件刚被拒绝的事（DEV-0098，2026-10-21 用户截图指认）。
   */
  const [batch, setBatch] = useState<"idle" | "confirm" | "busy" | "result">("idle");
  /** 批量删除的结果说明：部分成功、被引用阻止、结果不明都写在这里，不吞成一句「删除失败」。 */
  const [batchError, setBatchError] = useState<string | null>(null);
  /** 有哪一条的删除回执对不上：结果未定，确认键锁死，只能由「取消」退出。 */
  const [batchUncertain, setBatchUncertain] = useState(false);
  const request = useRef(0);
  const archivedRequest = useRef(0);
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
      const sorted = [...page.items].sort((a, b) => {
        // 服务端没给 updated_at 的排在有时间的之后，不用客户端时间补齐。
        if (a.updatedAt === null && b.updatedAt === null) return 0;
        if (a.updatedAt === null) return 1;
        if (b.updatedAt === null) return -1;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
      const workspaceSessions = sessionResult.items.filter((session) => session.taskId === null)
        .sort(compareSessions);
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
      setArchived(items.filter((session) => session.taskId === null).sort(compareSessions));
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
    let session: RelayAssistSession;
    try { session = await client.getAssistSession(sessionId, true); }
    catch { return; }
    const movable = session.taskId === null;
    setLoaded((previous) => previous === null ? previous : { ...previous,
      sessions: movable && session.status === "ACTIVE"
        ? sortSessions([session, ...previous.sessions.filter((item) => item.id !== sessionId)])
        : previous.sessions.filter((item) => item.id !== sessionId) });
    setArchived((previous) => previous === null ? previous
      : movable && session.status === "ARCHIVED"
        ? sortSessions([session, ...previous.filter((item) => item.id !== sessionId)])
        : previous.filter((item) => item.id !== sessionId));
  }, [client]);

  function onRowChanged(sessionId: string, patch: SessionRowPatch) {
    // 分叉不改这一行：源会话一行都没动，要读回来的是那次新建的子会话（0113）。
    if (patch.kind === "fork") { void refreshSession(patch.forkedSessionId); return; }
    // 删除后这条会话不再存在（ADR-027）：重读只会 404，直接从两个分区同时摘掉。
    if (patch.kind === "delete") {
      setLoaded((previous) => previous === null ? previous : { ...previous,
        sessions: previous.sessions.filter((item) => item.id !== sessionId) });
      setArchived((previous) => previous === null ? previous
        : previous.filter((item) => item.id !== sessionId));
      return;
    }
    void refreshSession(sessionId);
    // 归档/重开会让这一条换列表，其余只改这一行自身；都只重读这一条，不重置任务分页。
    if (patch.kind !== "archive" && patch.kind !== "reopen") return;
    if (archived === null) void loadArchived();
  }

  /** 勾选/取消一条会话。同一会话的两处副本共用这一个状态，因此两处永远同步。 */
  function toggleSelected(sessionId: string, next: boolean) {
    setBatch((current) => current === "busy" ? current : "idle");
    setSelected((current) => next
      ? (current.includes(sessionId) ? current : [...current, sessionId])
      : current.filter((item) => item !== sessionId));
  }

  function clearSelection() {
    setSelected([]); setBatch("idle"); setBatchError(null); setBatchUncertain(false);
  }

  /**
   * 批量删除：一段讨论一条命令，各自取新的 `command_id`、各自带**读回来的**修订。
   *
   * 四条口径：
   * 1. **不合并成一次请求。** 服务端只有逐条删除命令（ADR-027），客户端也不假装原子：
   *    每一条的结果单独核对，成功几条、失败几条分别如实报告。
   * 2. **串行发、逐条等回执。** 并发只会让「哪条成了、哪条没成」更难读；一条失败也不影响
   *    其余几条的判断。
   * 3. **结果不明不重发。** 响应丢失（`RelayTransportError`）意味着这一条是否已删尚未确定，
   *    按契约不得换 `command_id` 重试：勾选保留、确认键锁死，说明未定并让人自己核对列表
   *    （与 ⋯ 面板里那条单条删除同一读法：不替用户猜，也不替他重发）。
   * 4. **被引用阻止不是失败。** `SESSION_DELETE_BLOCKED` 是业务拒绝（行还在），说明里给出
   *    阻止项并指向归档；结果停在结果态，读完原因点「关闭」即结束这一轮。要再试时重新勾选，
   *    不在同一张卡片里反复 offer 同一个必然被拒绝的删除（DEV-0098）。
   * 5. **同一原因只说一次。** 被阻止的讨论按阻断原因聚合：原因写一次、标题并列（同名去重后
   *    仍读得出几条），「先改为归档…」那句建议也只出现一次——三行同因各写一遍整句，会把
   *    这块窄卡片铺满红字（2026-10-20 用户截图指认）。
   */
  async function deleteSelected() {
    const targets = selectedSessions;
    if (targets.length === 0) { clearSelection(); return; }
    setBatch("busy"); setBatchError(null); setBatchUncertain(false);
    const removed: string[] = [];
    /** 阻断原因 → 被它挡住的标题（按发送顺序累积）。 */
    const blockedByReason = new Map<string, string[]>();
    /** 不属阻断的失败（冲突、校验等）：各有自己的说明，逐条列出。 */
    const failed: string[] = [];
    const uncertain: string[] = [];
    for (const session of targets) {
      try {
        await client.deleteAssistSession({ sessionId: session.id, commandId: createCommandId(),
          expectedRevision: session.revision });
        removed.push(session.id);
      } catch (caught) {
        const described = describeLiveError(caught);
        if (described.kind === "transport") { uncertain.push(`「${session.title}」`); continue; }
        if (described.blockedReasons !== undefined && described.blockedReasons.length > 0) {
          const key = described.blockedReasons.join("、");
          blockedByReason.set(key, [...(blockedByReason.get(key) ?? []), session.title]);
          continue;
        }
        failed.push(`「${session.title}」${described.kind === "conflict"
          ? "刚被别处改过，已重新读取，请核对后再删。" : described.message}`);
        if (described.kind === "conflict") void refreshSession(session.id);
      }
    }
    if (removed.length > 0) {
      const gone = new Set(removed);
      setLoaded((previous) => previous === null ? previous : { ...previous,
        sessions: previous.sessions.filter((item) => !gone.has(item.id)) });
      setArchived((previous) => previous === null ? previous
        : previous.filter((item) => !gone.has(item.id)));
      setSelected((current) => current.filter((sessionId) => !gone.has(sessionId)));
    }
    const sentences: string[] = [...failed];
    if (blockedByReason.size > 0) {
      const blockedNotes = [...blockedByReason].map(([reason, titles]) => {
        // 同名会话不重复念标题：三条「关于Relay-Agent」写成「「关于Relay-Agent」等 3 段」。
        const unique = [...new Set(titles)];
        const who = unique.length === 1
          ? `「${unique[0]}」${titles.length > 1 ? `等 ${titles.length} 段` : "这条讨论"}`
          : `${unique.map((title) => `「${title}」`).join("")}这 ${titles.length} 段`;
        return `${who}还不能删除（${reason}）。`;
      });
      sentences.push(`${blockedNotes.join("")}先改为归档，或在原对象解除引用后再删除。`);
    }
    if (uncertain.length > 0) {
      sentences.push(`${uncertain.join("、")}的删除结果不明（响应丢失），本次是否已删除尚未确定；请核对列表后再决定，不要重复删除。`);
    }
    // 全部成功时不留提示：行当场消失就是回执，删除不可撤销、也不需要撤销条。
    setBatchUncertain(uncertain.length > 0);
    if (sentences.length === 0) {
      setBatch("idle");
      setBatchError(null);
      return;
    }
    // 有失败就停在结果态（DEV-0098）：同一张确认卡片里读完原因后「关闭」，
    // 不退回带「删除」按钮的第三次确认。
    setBatch("result");
    setBatchError(`已删除 ${removed.length} 段讨论；${sentences.join(" ")}`);
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
      if (!current || session.id !== sessionId || session.taskId !== null) return;
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
    pinned: session.pinnedAt !== null, unread: session.unreadAt !== null });
  const rows: readonly Row[] = [
    ...visibleTasks.map((task): Row => ({ key: `task:${task.id}`, kind: "task", id: task.id,
      title: task.title, projectId: task.projectId, updatedAt: task.updatedAt, pinned: false,
      unread: false })),
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
  /** 是否存在有效勾选：批量操作栏与「不许收起工作区（目录）」都由它驱动。 */
  const selecting = selectedSessions.length > 0;
  /**
   * 批量操作栏（2026-10-20 第五轮重构）：从左栏外、主内容区上方居中的浮层挪回**这一列内部**，
   * 紧跟「工作区（目录）」标题下方。勾选框就在条目行里，操作入口与它同一列，视线不再横跨
   * 整个主工作区；靠 sticky 在这一段里滚动时停在列顶，不跟着滚走。无勾选时整块不渲染，
   * 这一列逐像素回到原样——不无条件占高度，也不遮挡目录条目。
   *
   * 内容与状态机和旧浮层一致（就地确认、逐段发命令、部分成功如实报），结果停在终态：
   * 失败后只留「关闭」，不再退回带「删除」按钮的第三次确认（DEV-0098）。
   * 落点仍是原处。只有「已归档」里还有会话可勾、而上面三段都没渲染时（loadedCount === 0），
   * 才落到列表上方那个兜底位置——否则勾了东西却看不到操作栏。
   */
  const batchBar = selecting ? <div className="recent-work-selection" role="group"
    aria-label="批量删除会话" data-testid="recent-work-selection">
    <p className="recent-work-selection-count" data-testid="recent-work-selection-count">
      {batch === "idle" ? `已选 ${selectedSessions.length} 段讨论`
        : batch === "result" ? "删除结果" : `删除这 ${selectedSessions.length} 段讨论？`}</p>
    {(batch === "confirm" || batch === "busy") && <p className="recent-work-selection-note">
      消息、附件与工具调用记录将永久移除，无法恢复。</p>}
    {batchError !== null && <p className="recent-work-row-error" role="alert"
      data-testid="recent-work-batch-error">{batchError}</p>}
    <div className="recent-work-confirm-actions">
      {batch === "idle" ? <>
        <button type="button" className="text-button recent-work-selection-danger"
          data-testid="recent-work-batch-delete"
          onClick={() => { setBatchError(null); setBatch("confirm"); }}>删除</button>
        <button type="button" className="text-button" data-testid="recent-work-selection-clear"
          onClick={clearSelection}>取消</button>
      </> : batch === "result" ? <>
        {/* 结果态只留关闭：业务拒绝（被引用/有执行请求）不让删除，再摆一颗「删除」只会重演同一次拒绝。 */}
        <button type="button" className="secondary-button" data-testid="recent-work-batch-result-close"
          onClick={clearSelection}>关闭</button>
      </> : <>
        <button type="button" className="danger-button" disabled={batch === "busy" || batchUncertain}
          data-testid="recent-work-batch-delete-confirm"
          onClick={() => void deleteSelected()}>{batch === "busy" ? "正在删除…" : "删除"}</button>
        <button type="button" className="secondary-button" disabled={batch === "busy"}
          data-testid="recent-work-batch-delete-cancel"
          onClick={() => setBatch("idle")}>取消</button>
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
    const key = directory?.resourceId ?? (session.context === undefined ? "unknown" : "unbound");
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
        const label = `${row.kind === "session" ? "会话 · " : ""}${row.title} · ${projectName(row.projectId)}${notStarted ? " · 未开始" : ""}${row.unread ? " · 未读" : ""}`;
        // 同一组里出现同名行时，时刻要带上时分才分得清是哪一条；完整时间留在摘要卡的 time 上。
        const sameTitle = groupRows.some((other) => other.key !== row.key && other.title === row.title);
        return <RecentWorkRow key={row.key} kind={row.kind} title={row.title}
          testId={goalId ? `recent-work-goal-${goalId}-${row.id}` : `recent-work-${row.id}`}
          label={label} active={isActiveRow(row)} pinned={row.pinned} unread={row.unread}
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
  // 常驻的强制展开会让用户永远收不起这一列：活动会话必然落在「工作区（目录）」里，
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
          actions={<button className="text-button" type="button"
            onClick={() => { void navigate("/tasks?view=create"); onOpen?.(); }}>新建任务</button>} />}
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
        <details className="recent-work-section" data-testid="recent-work-directories"
          // 有勾选时这一段不许收起：勾选项与批量操作栏都在它内部，收起之后「选了什么、
          // 能对谁操作」一起消失，只剩一份看不见的选择状态（2026-10-20 用户指令）。
          open={!collapsed.includes("directories") || selecting}
          onToggle={(event) => { if (!selecting) groupToggle(event.currentTarget, "directories"); }}>
          <summary><ChevronDown aria-hidden="true" /><span className="recent-work-group-title">工作区（目录）</span></summary>
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
        {tasks.length > 0 && <details className="recent-work-section" data-testid="recent-work-tasks"
          open={!collapsed.includes("tasks")}
          onToggle={(event) => groupToggle(event.currentTarget, "tasks")}>
          <summary><ChevronDown aria-hidden="true" /><span className="recent-work-group-title">任务入口</span></summary>
          {[...groups].map(([projectId, groupRows]) => {
            const key = railGroupKey(projectId);
            return <details className="recent-work-group" key={key} open={!collapsed.includes(key)}
              onToggle={(event) => groupToggle(event.currentTarget, key)}>
              <summary><ChevronDown aria-hidden="true" />{projectId !== null && <Folder aria-hidden="true" className="recent-work-group-folder" />}
                <span className="recent-work-group-title">{projectName(projectId)}</span><span className="recent-work-group-count">{groupRows.length}</span></summary>
              {renderRows(groupRows, `task:${key}`)}
            </details>;
          })}
        </details>}
      </>}
        {/* 归档的会话不在上面任何一段里：服务端默认只列 ACTIVE，「归档即隐藏」发生在读侧。
            这一段默认收起，并且仍挂在 loadedCount 之外——把唯一一条会话归档之后上面会整列空掉，
            若这一段也跟着消失，人就再也找不到重开的入口了。
            与三个根区同处一个父容器是结构要求：`.recent-work-section + .recent-work-section`
            只覆盖相邻兄弟，2026-10-16 第七轮实测，包装层曾隔断「任务入口 ↔ 已归档」的相邻关系，
            任务入口收起时间隙塌成 0px，四个根区读成三档。 */}
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
                <button type="button" className="text-button" data-testid="recent-work-archived-retry"
                  onClick={() => void loadArchived()}>重试</button></p>
              : archived === null
                ? <p className="helper-text recent-work-scope-note">展开时读取归档列表</p>
                : archivedRows.length === 0
                  ? <p className="helper-text recent-work-scope-note">{needle ? "已加载范围内没有匹配项" : "暂无归档会话"}</p>
                  : renderRows(archivedRows.map(toRow), "archived")}
        </details>}
      </div>
      {pagingError && <p className="action-error" role="alert">{pagingError}</p>}
      {loaded?.nextCursor && <button className="secondary-button" type="button" disabled={loadingMore}
        title={`已加载 ${tasks.length} 项任务，继续读取更早任务`} data-testid="recent-work-more"
        onClick={() => void load(loaded.nextCursor)}>{loadingMore ? "正在读取" : `更早的任务（已加载 ${tasks.length} 项）`}</button>}
    </div>
    {sessionsError !== null && <p className="helper-text" role="status" data-testid="recent-work-sessions-error">
      会话列表暂时读不到：{sessionsError} 任务列表仍按已加载范围显示。</p>}
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
