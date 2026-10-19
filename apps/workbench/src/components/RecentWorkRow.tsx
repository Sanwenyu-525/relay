import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Folder, MessageSquare, Pin } from "lucide-react";
import type { RelayApiClient, RelayAssistSession } from "../api/relayClient";
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
  /** 未读标记（0104）：只画一枚圆点，状态同时写进行的可访问名称。 */
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
}

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
  timeValue, timeTitle, scopeName, rowKey, dragging, carryY, session, client, onOpen, onChanged, onStale }: RecentWorkRowProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<SessionRowMenuHandle>(null);
  const cardId = `recent-work-summary-${testId}`;
  const show = useCallback((element: HTMLElement) => setAnchor(element), []);
  const hide = useCallback(() => setAnchor(null), []);
  // 操作面板打开时不再压一张摘要卡：同一时刻这一行只出一个浮层。
  useEffect(() => { if (menuOpen) setAnchor(null); }, [menuOpen]);

  // 抓着走：整行按指针位移平移，抓握点始终落在同一处；布局不受影响（次序由落点那一拍改）。
  const carry: CSSProperties | undefined = carryY === null ? undefined
    : { transform: `translateY(${carryY}px)` };
  return <li className={`recent-work-row${dragging ? " recent-work-row--dragging" : ""}`}
    data-recent-row={rowKey} style={carry}>
    <div className="recent-work-row-head" onContextMenu={session === undefined ? undefined
      : (event) => { event.preventDefault(); menuRef.current?.open(); }}>
      <button type="button" className={`recent-work-item${active ? " recent-work-item--active" : ""}`}
        aria-label={label} data-testid={testId} aria-current={active ? "true" : undefined}
        aria-describedby={anchor !== null ? cardId : undefined}
        onPointerEnter={(event) => show(event.currentTarget)}
        onPointerLeave={hide}
        onFocus={(event) => show(event.currentTarget)}
        onBlur={hide}
        onClick={onOpen}>
        <span className="recent-work-copy">
          {/* 类型差异只用一枚图标：会话有、任务没有，不靠读文字区分。 */}
          {kind === "session" && <MessageSquare className="recent-work-kind" aria-hidden="true" />}
          {unread && <span className="recent-work-unread" data-testid="recent-work-unread-dot" aria-hidden="true" />}
          <span className="recent-work-title">{title}</span>
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
