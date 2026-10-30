import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Archive, Ban, CircleAlert, CircleCheck, Clock, Folder, MessageSquare, Pin,
  SquareExclamationPoint, type LucideIcon } from "lucide-react";
import type { RelayApiClient, RelayAssistSession, RelayAssistSessionListState } from "../api/relayClient";
import { sessionStateTitle } from "../lib/sessionState";
import SessionRowMenu, { type SessionRowMenuHandle, type SessionRowPatch } from "./SessionRowMenu";

/**
 * 近期工作栏的一行（2026-10-16 第五轮，用户指认）。
 *
 * 四个形状不是随手选的：
 *
 * 1. **行只有一行文字。** 时间从行里移走（用户要求），标题、类型图标与置顶徽标同一行；
 *    时间与归属改由悬停摘要卡呈现。行内常驻信息少了，同一屏能多看几条。
 * 2. **行头单独一层，⋯ 相对行头定位。** 展开面板原先就地占行下方一条，`<li>` 被撑高，
 *    ⋯ 的 `inset-block-start: 50%` 于是下移到「行 + 面板」的中线——这就是用户说的
 *    「点击三个点位置会改变」。把行按钮与 ⋯ 收进 `.recent-work-row-head` 后，
 *    50% 只相对行本身，面板是浮层、不参与布局，触发器一动不动。
 * 3. **摘要卡与操作面板都是 `position: fixed` 浮层。** 这一列在滚动容器
 *    （`.recent-work-scroll`，`overflow-y: auto`）里，绝对定位会被裁掉；而祖先链上
 *    没有 `transform` / `filter` / `contain`，`fixed` 不会退化成相对某个祖先定位，
 *    因此不需要 portal，DOM 仍留在这一行内，坐标由 JS 按实测位置摆放。
 *    唯一的例外是抓握中的那一行：它整行吃一个 `translateY`（见 carryY），`fixed`
 *    因此会改成相对它定位。两层浮层在那之前就不在了——⋯ 的面板于 pointerdown 的捕获阶段
 *    关掉，摘要卡在整个拖拽期间 `display: none`，所以没有东西会被这个 transform 带偏。
 * 4. **整行右键与点 ⋯ 打开同一个面板（2026-10-18 用户指令）。** 面板仍锚在 ⋯、不跟指针落点走：
 *    这一行只有一套摆位几何，右键不必再养第二条坐标逻辑；任务行没有可改的会话事实，右键不接管。
 * 5. **复选框叠在类型图标那一格，不占第二列（2026-10-20 用户指令）。** 行按钮是 `<button>`，
 *    复选框只能做它的兄弟节点、按绝对定位压在 `.recent-work-kind` 上方：同一块 12px 图形位置，
 *    悬停/聚焦/已勾选时换成 14px 复选框，标题可用宽一像素都不减——这一列的下限只有 160px，
 *    常驻让出一列会直接吃掉两个汉字。显形规则与 ⋯ 完全一致（`display` 切换，静止态不占位），
 *    因此行高、行距与密度基线都不变（`recentWorkRailDensity.spec.ts` 仍在守）。
 * 6. **「未开始」只在还没有消息的会话上出现（2026-10-24）。** 服务端读时派生的
 *    `hasMessages` 为 false 就是这段讨论还没有落过一条消息；这类空会话与说过话的会话在左栏
 *    同形同标题，点开只有欢迎空态。标记用与置顶徽标同一形制的一枚 caption 文字，
 *    不新开颜色、不加第二行：它说的是「这一行还没有内容」，不是强调。
 */

/** 浮层与锚点之间的间距、以及离视口边缘的留边；都取 space.2（8px）。 */
const GAP_PX = 8;
const MARGIN_PX = 8;

export interface RecentWorkRowProps {
  readonly kind: "task" | "session";
  readonly title: string;
  /** 行按钮的 testid；目标区副本带 goal 前缀，由调用方决定。 */
  readonly testId: string;
  /** 可访问名称，含类型与归属；行内不再重复写一遍。 */
  readonly label: string;
  readonly active: boolean;
  readonly pinned: boolean;
  /**
   * 未读标记（0104）：圆点 + 标题加粗两处同时成立（2026-10-19 用户指认「不够明显」）。
   * 状态同时写进行的可访问名称，不只靠颜色。
   */
  readonly unread: boolean;
  /** 已按本地日期简写的更新时刻；没有更新时间时为 null，不编一个。 */
  readonly timeLabel: string | null;
  readonly timeValue: string | null;
  /** 完整时间，留在摘要卡的 `time[title]` 上，精确值不丢。 */
  readonly timeTitle: string | null;
  /** 归属名：会话取目录末段，任务取项目名；没有依据时如实说明。 */
  readonly scopeName: string;
  /** 行的身份键，挂在 li 上：拖拽靠它在同一列里认出行序（`session:<id>` / `task:<id>`）。 */
  readonly rowKey: string;
  /** 这一行正被抓着：画抓握态的浮起与指针形状；行的次序仍由落点那一拍决定。 */
  readonly dragging: boolean;
  /** 抓握期间整行的位移量，等于指针相对起手点走了多远；没被抓着时为 null。 */
  readonly carryY: number | null;
  /** 只有会话行带行内操作；任务行没有可改的会话事实。 */
  readonly session: RelayAssistSession | undefined;
  readonly client: RelayApiClient;
  readonly onOpen: () => void;
  readonly onChanged: (patch: SessionRowPatch) => void;
  readonly onStale: () => void;
  /**
   * 批量选择的勾选状态（2026-10-20 用户指令「给会话 item 加一个复选框，方便删除记录」）。
   * 只有会话行有：任务行没有删除命令，勾了也无事可做。
   */
  readonly selected: boolean;
  readonly onSelectedChange: (selected: boolean) => void;
  /** 批量删除在途：勾选禁用，选择集在命令跑完之前不再变化。 */
  readonly selectionBusy: boolean;
}

/**
 * 会话行的状态图标（2026-10-30）：**同一格、同一尺寸、同一 class 基座**画出八种状态。
 *
 * 五件事刻意如此：
 *
 * 1. **几何不变。** 仍复用 `.recent-work-kind`（12px、`flex: none`），只加状态修饰类。
 *    标题可用宽、行高、行距、置顶徽标与未读圆点的位置一像素不动——这一列的下限只有
 *    160px，换一枚图形不能换来一次重排。
 * 2. **形状先于颜色，颜色先于动效。** 八个状态各有自己的轮廓（三点、钟、圆勾、方框叹号、
 *    圆叹号、斜线圆、消息框、归档盒），关掉动效或灰度打印时仍逐一分得开；颜色只在
 *    失败与待确认两档离开中性色——它们真的需要被看见。
 * 3. **只有运行态动。** 三个圆点按 0/140/280ms 错峰上下、约 1.1s 一轮；旋转、发光、
 *    整行呼吸一概没有。完成态只允许 120ms 的一次性收敛（挂载即播、不循环），
 *    其余状态完全静止。
 * 4. **`state` 为 null 时退回类型图标。** 旧服务端不给 `list_state`、或有消息却读不出
 *    最后一轮回复行时，「不知道」就画成不知道——不把 null 解释成完成。
 * 5. **文案只有一份。** 悬停提示与行可访问名称都读 `sessionStateTitle/Note`，
 *    不在这一层另写一套说法。
 */
const STATE_CLASS: Readonly<Record<RelayAssistSessionListState, string>> = {
  RUNNING: "running",
  PENDING: "pending",
  WAITING_APPROVAL: "waiting-approval",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  NOT_STARTED: "not-started",
  ARCHIVED: "archived"
};

/** 三个圆点的横坐标：等距落在 12px 盒里，左右各留一个点的余量。 */
const RUNNING_DOTS = [5.5, 12, 18.5] as const;

function SessionStateMark({ state }: { state: RelayAssistSessionListState | null }) {
  const title = sessionStateTitle(state);
  // 图标属性按「已声明形状」下发：Lucide 组件只透传 SVG 属性，data-* 走同一份对象，
  // 不必为八种图标各写一遍。
  const attributes: Record<string, string> = {
    className: `recent-work-kind${state === null ? "" : ` recent-work-kind--${STATE_CLASS[state]}`}`,
    "data-testid": "recent-work-state",
    "aria-hidden": "true",
    focusable: "false",
    ...(state === null ? {} : { "data-state": state })
  };
  // 可访问名称由行按钮承担（左栏把状态写进那一句），这里 aria-hidden，只留原生 tooltip。
  if (state === "RUNNING") {
    return <svg {...attributes} viewBox="0 0 24 24" fill="none" role="presentation">
      <title>{title}</title>
      {RUNNING_DOTS.map((cx) => <circle key={cx} className="recent-work-state-dot" cx={cx} cy="12"
        r="2.4" fill="currentColor" />)}
    </svg>;
  }
  if (state === null) return <MessageSquare {...attributes} />;
  const Icon = STATE_ICONS[state];
  return <Icon {...attributes}><title>{title}</title></Icon>;
}

/** 状态 → 图形。全部取自项目既有的 Lucide 体系，不引图片资源。 */
const STATE_ICONS: Readonly<Record<Exclude<RelayAssistSessionListState, "RUNNING">, LucideIcon>> = {
  PENDING: Clock,
  WAITING_APPROVAL: SquareExclamationPoint,
  COMPLETED: CircleCheck,
  FAILED: CircleAlert,
  CANCELLED: Ban,
  NOT_STARTED: MessageSquare,
  ARCHIVED: Archive
};

/** 悬停/聚焦摘要卡：标题 + 更新时刻 + 归属。纯展示，不接收指针。 */
function RowSummary({ anchor, cardId, title, timeLabel, timeValue, timeTitle, scopeName, onClose }: {
  anchor: HTMLElement;
  cardId: string;
  title: string;
  timeLabel: string | null;
  timeValue: string | null;
  timeTitle: string | null;
  scopeName: string;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const card = cardRef.current;
      if (card === null) return;
      const box = anchor.getBoundingClientRect();
      const height = card.offsetHeight;
      // 竖直居中对齐这一行，越界时拉回视口内；横向固定贴在这一列的右缘外。
      const top = Math.max(MARGIN_PX, Math.min(box.top + box.height / 2 - height / 2,
        window.innerHeight - MARGIN_PX - height));
      setPlaced({ left: box.right + GAP_PX, top });
    };
    place();
    window.addEventListener("resize", place);
    // 固定定位不跟随滚动：一滚就收起，避免卡片停在旧坐标上指着别的行。
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [anchor, onClose]);
  return <div ref={cardRef} id={cardId} className="recent-work-summary" role="tooltip"
    data-testid="recent-work-summary" style={placed ?? { visibility: "hidden" }}>
    <p className="recent-work-summary-head">
      <span className="recent-work-summary-title" data-testid="recent-work-summary-title">{title}</span>
      {timeLabel !== null && <time className="recent-work-summary-time" dateTime={timeValue ?? undefined}
        title={timeTitle ?? undefined} data-testid="recent-work-summary-time">{timeLabel}</time>}
    </p>
    <p className="recent-work-summary-scope" data-testid="recent-work-summary-scope">
      <Folder aria-hidden="true" />{scopeName}
    </p>
  </div>;
}

export default function RecentWorkRow({ kind, title, testId, label, active, pinned, unread, timeLabel,
  timeValue, timeTitle, scopeName, rowKey, dragging, carryY, session, client, onOpen, onChanged, onStale,
  selected, onSelectedChange, selectionBusy }: RecentWorkRowProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<SessionRowMenuHandle>(null);
  const cardId = `recent-work-summary-${testId}`;
  /**
   * 还没有消息的会话（2026-10-24 用户截图指认「已有会话打开是新建会话欢迎页」）。
   * 判据只认服务端读时派生的 `hasMessages`：它直接看消息表有没有行，不拿活动键
   * `lastMessageAt` 的可空性推断——活动键漏推进时，空会话标记就会对正文说谎。
   * 标记必须在这一行就看得见，而不是等点开才发现。
   */
  const notStarted = session !== undefined && !session.hasMessages;
  /**
   * 状态只读服务端的读时派生事实（`list_state`）。本地一律不猜：不看发送按钮的忙态、
   * 不看 `hasMessages`、不看缓存的最后消息时刻——任一都比真实生成状态晚一拍或停在旧值。
   * 缺字段的旧服务端读成 `null`，这一行就照常显示类型图标。
   */
  const listState = session?.listState ?? null;
  const show = useCallback((element: HTMLElement) => setAnchor(element), []);
  const hide = useCallback(() => setAnchor(null), []);
  // 操作面板打开时不再压一张摘要卡：同一时刻这一行只出一个浮层。
  useEffect(() => { if (menuOpen) setAnchor(null); }, [menuOpen]);

  // 抓着走：整行按指针位移平移，抓握点始终落在同一处；布局不受影响（次序由落点那一拍改）。
  const carry: CSSProperties | undefined = carryY === null ? undefined
    : { transform: `translateY(${carryY}px)` };
  return <li className={`recent-work-row${dragging ? " recent-work-row--dragging" : ""}`}
    data-recent-row={rowKey} data-selected={selected ? "true" : undefined} style={carry}>
    <div className="recent-work-row-head" onContextMenu={session === undefined ? undefined
      : (event) => { event.preventDefault(); menuRef.current?.open(); }}>
      {/* 复选框压在类型图标那一格（见文件头第 5 条）：与行按钮平级，不嵌进 <button>；
          悬停/聚焦/已勾选时才显形，静止态与改造前逐像素相同。 */}
      {session !== undefined && <input type="checkbox" className="recent-work-select"
        checked={selected} disabled={selectionBusy}
        aria-label={`选择「${title}」${scopeName === "" ? "" : ` · ${scopeName}`}`}
        data-testid={`recent-work-select-${session.id}`}
        onChange={(event) => onSelectedChange(event.target.checked)} />}
      <button type="button" className={`recent-work-item${active ? " recent-work-item--active" : ""}${unread ? " recent-work-item--unread" : ""}`}
        aria-label={label} data-testid={testId} aria-current={active ? "true" : undefined}
        aria-describedby={anchor !== null ? cardId : undefined}
        onPointerEnter={(event) => show(event.currentTarget)}
        onPointerLeave={hide}
        onFocus={(event) => show(event.currentTarget)}
        onBlur={hide}
        onClick={onOpen}>
        <span className="recent-work-copy">
          {/* 类型差异只用一枚图标：会话有、任务没有，不靠读文字区分。
              会话的状态（运行 / 排队 / 终态 / 未开始 / 归档）也在这一格替换，
              同一格、同一 12px，布局不动。 */}
          {kind === "session" && <SessionStateMark state={listState} />}
          {unread && <span className="recent-work-unread" data-testid="recent-work-unread-dot" aria-hidden="true" />}
          <span className="recent-work-title">{title}</span>
          {/* 未开始：与置顶徽标同一形制（caption 文字 + 同一格间距），不占第二行。
              顺序上先事实（还没说过话）后状态（置顶），两者同时成立时读起来是
              「这条还没开始 · 已置顶」。 */}
          {notStarted && <span className="recent-work-not-started" title="这条讨论还没有消息"
            data-testid="recent-work-not-started">未开始</span>}
          {/* 置顶只画一枚图标 + 无障碍文本：行只有一档高，加字会把标题挤短。 */}
          {pinned && <span className="recent-work-pin" title="已置顶" aria-label="已置顶">
            <Pin aria-hidden="true" />置顶</span>}
        </span>
      </button>
      {session !== undefined && <SessionRowMenu ref={menuRef} client={client} session={session}
        onChanged={onChanged} onStale={onStale} onOpenChange={setMenuOpen} />}
    </div>
    {anchor !== null && <RowSummary anchor={anchor} cardId={cardId} title={title}
      timeLabel={timeLabel} timeValue={timeValue} timeTitle={timeTitle} scopeName={scopeName}
      onClose={hide} />}
  </li>;
}
