import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode, type RefObject } from "react";
import {
  ArrowUp, Bell, BookOpen, CalendarClock, Check, ChevronDown, Clock, FileText,
  FolderKanban, History, House, Inbox, LineChart, ListChecks, ListTree, Menu, Minus,
  NotebookPen, Paperclip, PanelLeftClose, Plus, RotateCcw, Search, Settings, Square,
  SquarePen, Terminal, Wrench, X
} from "lucide-react";
import { ScenarioShell, ScenarioStage } from "./scenarioHost";
import { ALL_SCENARIOS } from "./scenarios/index";
import { ScenarioRunner, type ScenarioConditions } from "./scenarioWorld";
import "./AuroraGlassLab.css";

/**
 * Aurora Glass 液态玻璃主题原型（UI-AURORA-01，仅开发构建）。
 *
 * 这是**隔离预览**，不是正式皮肤：
 *   * 主区内容走场景实验室那条路——`ScenarioRunner` + `ScenarioStage`，渲染的是产品自己的
 *     `AssistMessageRow` / `SessionRoundTrace` / `SafeMarkdown` / Diff 面板，因此「玻璃压在
 *     真实正文上长什么样」不是画出来的示意图，而是同一套组件的真实像素。
 *   * 外壳（标题带、图标导航、近期工作栏、顶栏、输入器）按 AppShell 的 DOM 契约**复刻**，
 *     因为真外壳已经包在路由外面，复刻件才能在这块定死的预览格里等比重现整窗口。
 *     凡不是产品组件的替身都挂 `data-aurora-local="true"`，验收时一眼可分。
 *   * 零副作用：不发消息、不调工具、不读磁盘、不改权限、不写任何 localStorage / sessionStorage。
 *     看起来能点的控件全部给出真实反馈——要么改本机状态（皮肤、宽窄、参数、选中项），
 *     要么把「这里不会执行」写进 `role="status"`。
 */

/** 用户钉住的三个默认值：控制器只覆盖预览元素上的这两个自定义属性，离开即消失。 */
const DEFAULT_BLUR_PX = 20;
const DEFAULT_ALPHA_PCT = 80;
const DEFAULT_TINT = "sage" as const;

const TINTS = {
  sage: "冷绿 Sage（默认）",
  mist: "薄雾 Mist",
  moss: "苔绿 Moss"
} as const;
type TintKey = keyof typeof TINTS;

type Skin = "classic" | "aurora";
type StageWidth = "wide" | "narrow";

/** 场景轴：只换主区内容。菜单/浮层、宽窄、透明度是独立控件，不占这一轴。 */
interface LabScene {
  readonly key: string;
  readonly label: string;
  /** 这条场景在本主题里要回答的问题，直接显示在预览下方，不藏在代码注释里。 */
  readonly why: string;
  readonly scenarioId?: string;
}

const SCENES: readonly LabScene[] = [
  { key: "welcome", label: "新会话欢迎", why: "空状态：主区没有正文，标题带、两栏、输入器同时在场" },
  { key: "processing", label: "Agent 正在处理", scenarioId: "A03", why: "在途两条未结算：状态靠文字与图标，不靠颜色" },
  { key: "streaming", label: "流式草稿", scenarioId: "A04", why: "草稿标注压在玻璃外的纸上" },
  { key: "long", label: "多段长文本", scenarioId: "A06", why: "长正文的可读性不靠透明度赌运气" },
  { key: "tool", label: "读取文件", scenarioId: "B01", why: "过程条目：细行不逐条变成玻璃卡" },
  { key: "completed", label: "回复完成", scenarioId: "A10", why: "终态正文完整，无横贯聊天区的阴影" },
  { key: "error", label: "失败与错误详情", scenarioId: "A14", why: "错误详情属于决策级内容，保持不透明" },
  { key: "table", label: "Markdown 表格", scenarioId: "A09", why: "表格是阅读面：底、线、字都不半透" },
  { key: "code", label: "代码块", scenarioId: "A08", why: "代码底保持实色，等宽字对比不降级" },
  { key: "diff", label: "文件差异", scenarioId: "C04", why: "Diff 与审批同级，不玻璃化" }
];

const NAV_PRIMARY = [
  { key: "agent", label: "工作台", icon: House },
  { key: "projects", label: "项目", icon: FolderKanban },
  { key: "reviews", label: "待处理", icon: Bell },
  { key: "knowledge", label: "资料", icon: BookOpen }
];
const NAV_SECONDARY = [
  { key: "today", label: "今日", icon: History },
  { key: "tasks", label: "任务", icon: ListChecks },
  { key: "activity", label: "动态", icon: LineChart },
  { key: "inbox", label: "收件箱", icon: Inbox },
  { key: "scheduled", label: "定时任务", icon: CalendarClock }
];
const NAV_TERTIARY = [
  { key: "settings", label: "设置", icon: Settings },
  { key: "connections", label: "连接与同步", icon: Paperclip }
];

/** 复刻近期工作栏的条目。产品里这一行是单行制（状态替换同一格图标），这里沿用同一形制：
    标题 + 一枚 caption 状态标签。状态同时有文字，不只靠颜色（本主题的硬要求）。 */
const RECENT_GROUPS = [
  { title: "Relay-Agent", rows: [
    { id: "r1", title: "Aurora Glass 液态玻璃原型", tag: "正在处理" },
    { id: "r2", title: "会话待办结算对账", tag: "已完成" },
    { id: "r3", title: "上下文用量面板档位保存", tag: "已完成" }] },
  { title: "毕业论文项目", rows: [
    { id: "r4", title: "第三章证据表核对", tag: "待你处理" },
    { id: "r5", title: "参考文献格式统一", tag: "失败" }] }
] as const;

const SUGGESTIONS = [
  { key: "plan", icon: ListTree, tone: "plan", label: "拆解目标", text: "帮我把目标拆成可执行的小任务，并说明每条的完成条件。" },
  { key: "read", icon: FileText, tone: "build", label: "读代码讲清楚", text: "读取相关文件，讲清当前实现与依赖方向，指出不一致的地方。" },
  { key: "fix", icon: Wrench, tone: "build", label: "排查问题", text: "先确认现象、预期与复现条件，再定位原因并做最小修复。" },
  { key: "docs", icon: NotebookPen, tone: "build", label: "写技术文档", text: "只记录有依据的内容，标明限制与待确认项，不创建重复文档。" }
] as const;

const MODEL_OPTIONS = [
  { id: "free-a", name: "免费档 · 通用型号 A" },
  { id: "free-b", name: "免费档 · 长上下文 B" },
  { id: "local", name: "本机型号（离线）" }
] as const;

const TOOL_ITEMS = [
  { id: "attach", icon: Paperclip, name: "添加附件", note: "原型不上传，只演示菜单" },
  { id: "command", icon: Terminal, name: "斜杠命令", note: "打开命令面板" },
  { id: "skill", icon: ListTree, name: "选择 Skill", note: "需要任务或项目上下文" },
  { id: "source", icon: FileText, name: "引用资料", note: "随本条消息冻结" }
] as const;

/** 材质档位说明：直接摆在预览下面，评审不用翻代码就知道哪一块是第几档玻璃。 */
const LEGEND = [
  ["bar 标题带", "最实的一档：常驻窗口边缘，透明度比标准档再高一点"],
  ["rail 两栏", "20px / 80% 标准档，图标导航与近期工作栏共用"],
  ["sheet 输入器", "标准档外框，卡内编辑面保持实色底"],
  ["float 菜单浮层", "最透也模糊最强，因为它盖住的是别人的内容"],
  ["paper 正文/表格/代码/Diff/错误", "不透明：可读性优先，不给它加玻璃"]
] as const;

function Chip({ selected, label, testId, onClick }: {
  readonly selected: boolean; readonly label: string; readonly testId?: string; readonly onClick: () => void;
}): ReactElement {
  return <button className="aurora-lab__chip" type="button" aria-pressed={selected} data-testid={testId} onClick={onClick}>{label}</button>;
}

/**
 * 浮层：真正的展开/收起、点外部关闭、Escape 关闭，并把焦点交还触发键。
 *
 * 它只负责开合与可达性；里面列的是本目录里的假数据，选中项写进本机状态——
 * 这是「菜单/悬停/选中/聚焦态」这一条验收要求的载体，而不是一个装饰。
 *
 * 面板**常驻 DOM**，用 `data-open` 切换可见性：条件渲染会让开合两侧都没有过渡
 * （元素在开的那一刻才存在、在关的那一刻就没了），而浮层开合正是本主题唯一一处动效。
 * 关闭档走 `visibility: hidden`，面板里的键因此同时退出 Tab 顺序，不需要额外 inert。
 */
function Popover({ label, title, items, onPick, children }: {
  readonly label: string;
  readonly title: string;
  readonly items: readonly { readonly id: string; readonly name: string; readonly note?: string; readonly icon?: typeof Check }[];
  readonly onPick: (name: string) => void;
  /** 触发键的图标与文案由调用方给，面板几何由 CSS 决定锚点方向。 */
  readonly children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onDown = (event: MouseEvent) => {
      if (rootRef.current === null || rootRef.current.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);
  return <div className="aurora-popover" ref={rootRef} data-aurora-local="true"
    data-open={open ? "true" : "false"}>
    <button className="aurora-chip" type="button" aria-haspopup="true" aria-expanded={open}
      title={title} onClick={() => { setOpen((value) => !value); }} ref={triggerRef}>{children}</button>
    <div className="aurora-popover-panel" role="menu" aria-label={label}>
      <p className="helper-text">{label}</p>
      <ul className="aurora-popover-list">
        {items.map((item) => <li key={item.id}>
          <button className="aurora-popover-item" type="button" role="menuitem" title={item.note}
            onClick={() => { setOpen(false); onPick(item.name); triggerRef.current?.focus(); }}>
            {item.icon === undefined ? null : <item.icon aria-hidden="true" />}
            <span>{item.name}</span>
            {item.note === undefined ? null : <span className="visually-hidden">{item.note}</span>}
          </button></li>)}
      </ul>
    </div>
  </div>;
}

/** 复刻产品输入器的一颗导航键：点击只移动「当前项」，不导航、不改路由。 */
function NavButton({ active, label, icon: Icon, onSelect }: {
  readonly active: boolean; readonly label: string; readonly icon: typeof House;
  readonly onSelect: () => void;
}): ReactElement {
  return <button type="button"
    className={`navigation-item${active ? " navigation-item--active" : ""}`}
    aria-current={active ? "page" : undefined}
    onClick={onSelect}>
    {active && <span className="visually-hidden">当前项</span>}
    <Icon aria-hidden="true" /><span className="navigation-label">{label}</span>
  </button>;
}

function TitleBar({ onAction }: { readonly onAction: (message: string) => void }): ReactElement {
  const stamp = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(2026, 10, 1)).replaceAll("/", "-");
  return <div className="desktop-titlebar" data-aurora-local="true" data-source-mode="fixture" data-testid="aurora-titlebar">
    <div className="desktop-titlebar__cluster">
      <p className="aurora-titlebar-brand">Relay<span className="context-rail-brand-tag">工作空间</span></p>
      <button className="icon-button" type="button" title="搜索（原型不执行）" aria-label="搜索"
        onClick={() => onAction("原型不打开全局搜索：那会进入真实命令面板与业务数据。")}><Search aria-hidden="true" /></button>
    </div>
    <div className="desktop-titlebar__drag" />
    <div className="desktop-titlebar__cluster">
      <time className="desktop-titlebar__date" dateTime={stamp}>{stamp}　星期六</time>
      <button className="icon-button" type="button" title="任务收件箱（原型不执行）" aria-label="任务收件箱"
        onClick={() => onAction("原型不进入收件箱：这里只重绘标题带材质，不切换真实视图。")}><Inbox aria-hidden="true" /></button>
    </div>
    {/* 窗口控制是材质演示的一部分（悬停/聚焦态都在这一条带上），但真的最小化与关窗不属于本原型。 */}
    <div className="desktop-titlebar__controls" aria-label="窗口控制" data-testid="aurora-window-controls">
      <button className="desktop-titlebar__button" type="button" aria-label="最小化" title="最小化（原型不执行）"
        onClick={() => onAction("原型不控制真实窗口：Tauri 主窗口的透明性、装饰与控制行为本轮不动。")}><Minus aria-hidden="true" /></button>
      <button className="desktop-titlebar__button" type="button" aria-label="最大化" title="最大化（原型不执行）"
        onClick={() => onAction("原型不控制真实窗口：Tauri 主窗口的透明性、装饰与控制行为本轮不动。")}><Square aria-hidden="true" /></button>
      <button className="desktop-titlebar__button desktop-titlebar__button--close" type="button" aria-label="关闭窗口"
        title="关闭（原型不执行）" onClick={() => onAction("原型不关闭窗口。")}><X aria-hidden="true" /></button>
    </div>
  </div>;
}

function ContextRail({ active, onSelect, onAction }: {
  readonly active: string; readonly onSelect: (id: string, title: string) => void;
  readonly onAction: (message: string) => void;
}): ReactElement {
  return <aside className="app-context-rail" aria-label="近期工作上下文（原型复刻）" data-aurora-local="true">
    <div className="context-rail-head">
      <p className="context-rail-brand">Relay<span className="context-rail-brand-tag">工作空间</span></p>
      <button className="icon-button context-rail-collapse" type="button" aria-expanded="true"
        aria-label="收起近期工作栏（原型不持久化）" title="收起（原型不写入展示偏好）"
        onClick={() => onAction("原型不收起真实侧栏，也不写任何展示偏好：这个键只属于外壳。")}><PanelLeftClose aria-hidden="true" /></button>
    </div>
    <button className="primary-button context-rail-new" type="button" title="新对话（原型不创建会话）"
      onClick={() => onAction("原型不创建会话：会话草稿与首条发送仍只由协作页持有，这里不碰。")}>
      <SquarePen aria-hidden="true" /><span>新对话</span></button>
    <div className="recent-work-scroll">
      {RECENT_GROUPS.map((group) => <section className="recent-work-section" key={group.title}>
        <p className="recent-work-group-title">{group.title}<span className="recent-work-group-count">{group.rows.length}</span></p>
        <ul className="recent-work-list">{group.rows.map((row) => <li className="recent-work-row" key={row.id}>
          <div className="recent-work-row-head">
            <button type="button" data-row={row.id} aria-label={`${row.title}（原型条目，不会打开真实会话）`}
              className={`recent-work-item${active === row.id ? " recent-work-item--active" : ""}`}
              aria-current={active === row.id ? "true" : undefined}
              onClick={() => { onSelect(row.id, row.title); }}>
              <span className="recent-work-copy">
                <span className="recent-work-title">{row.title}</span>
                <span className="recent-work-not-started">{row.tag}</span>
              </span>
            </button>
          </div></li>)}</ul>
      </section>)}
    </div>
  </aside>;
}

function Composer({ draft, onDraftChange, draftRef, model, onModelPick, onAction }: {
  readonly draft: string; readonly onDraftChange: (value: string) => void;
  readonly draftRef: RefObject<HTMLTextAreaElement | null>;
  readonly model: string; readonly onModelPick: (name: string) => void;
  readonly onAction: (message: string) => void;
}): ReactElement {
  const fieldId = "aurora-composer-draft";
  return <div className="agent-chat-composer" data-aurora-local="true" data-inflight={false} data-testid="aurora-composer">
    <span className="agent-chat-composer-spark-clip" aria-hidden="true"><span className="agent-chat-composer-spark" aria-hidden="true" /></span>
    <div className="aurora-composer-field">
      <div className="field">
        <label className="visually-hidden" htmlFor={fieldId}>本次消息</label>
        <textarea id={fieldId} rows={2} value={draft} ref={draftRef} placeholder="输入你的想法、修改意见或新的要求"
          onChange={(event) => { onDraftChange(event.currentTarget.value); }}
          onKeyDown={(event) => {
            // 产品里 Enter 会发送；原型不能把这条变成真实发送，所以如实说明而不是静默吞键。
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            onAction("原型不发送消息：本轮不执行发送、工具调用或任何外部操作。文字已经留在输入框里。");
          }} />
      </div>
    </div>
    <div className="agent-chat-composer-actions">
      <div className="agent-chat-composer-tools">
        <Popover label="工具" title="添加附件、命令、Skill 与资料" items={TOOL_ITEMS.map((item) =>
          ({ id: item.id, name: item.name, note: item.note, icon: item.icon }))}
          onPick={(name) => { onAction(`原型只演示菜单开合：「${name}」不会真的执行。`); }}>
          <Plus aria-hidden="true" /><span>工具</span>
        </Popover>
        <details className="agent-chat-options">
          <summary>普通讨论<ChevronDown aria-hidden="true" className="agent-chat-chip-chevron" /></summary>
          <div className="agent-chat-options-panel">
            <p className="helper-text">直接发送即可开始讨论。需要读取项目文件时，先选择文件夹。</p>
            <p className="helper-text">Enter 发送 · Shift + Enter 换行（原型不发送，会如实说明）</p>
          </div>
        </details>
      </div>
      <div className="agent-chat-composer-tail">
        <Popover label="上下文档位" title="上下文用量与档位（原型替身，不读取真实用量）"
          items={[{ id: "t1", name: "128K", note: "原型不写入正式显示偏好" },
            { id: "t2", name: "256K", note: "原型不写入正式显示偏好" }]}
          onPick={(name) => { onAction(`原型只演示浮层与选中态：档位「${name}」不会保存，也不会写进设置。`); }}>
          <Clock aria-hidden="true" /><span>上下文</span>
        </Popover>
        <Popover label="模型" title="模型选择（原型替身，不读取模型目录）"
          items={MODEL_OPTIONS.map((option) => ({ id: option.id, name: option.name, note: "原型不发起请求" }))}
          onPick={onModelPick}>
          <ChevronDown aria-hidden="true" /><span>{model}</span>
        </Popover>
        <button className="primary-button agent-chat-send" type="button" aria-label="发送消息（原型不执行）"
          title="原型不发送消息" data-testid="aurora-send"
          onClick={() => { onAction("原型不发送消息：本轮不执行发送、工具调用或任何外部操作。"); }}><ArrowUp aria-hidden="true" /></button>
      </div>
    </div>
  </div>;
}

function Welcome({ onPick }: { readonly onPick: (text: string) => void }): ReactElement {
  return <div className="agent-chat-empty-work" data-aurora-local="true">
    <div className="agent-chat-empty-symbol" aria-hidden="true"><img src="/logo.png" alt="" /></div>
    <h1>有什么想一起完成的？</h1>
    <p className="agent-chat-empty-lede">可以直接讨论或描述目标，不需要先创建项目、任务；要读取文件时再选择工作目录。</p>
    <div className="agent-chat-suggestions">
      {SUGGESTIONS.map((item) => <button key={item.key} type="button" className="agent-chat-suggestion"
        data-tone={item.tone} onClick={() => { onPick(item.text); }}>
        <item.icon aria-hidden="true" />{item.label}</button>)}
    </div>
  </div>;
}

export default function AuroraGlassLabView(): ReactElement {
  const [skin, setSkin] = useState<Skin>("aurora");
  const [width, setWidth] = useState<StageWidth>("wide");
  const [sceneKey, setSceneKey] = useState<LabScene>(SCENES[0]);
  const [blurPx, setBlurPx] = useState(DEFAULT_BLUR_PX);
  const [alphaPct, setAlphaPct] = useState(DEFAULT_ALPHA_PCT);
  const [tint, setTint] = useState<TintKey>(DEFAULT_TINT);
  // 降级档默认跟随系统：`prefers-reduced-transparency` 只是初值，不是不可见的强制。
  const [reducedTransparency, setReducedTransparency] = useState(false);
  const [motionOff, setMotionOff] = useState(false);
  const [probe, setProbe] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeRow, setActiveRow] = useState("r1");
  const [model, setModel] = useState("模型");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-transparency: reduce)");
    setReducedTransparency(query.matches);
    // 有些 WebView 不实现这条查询：`addEventListener` 缺失时就不预设降级，不做假设。
    const onChange = (event: MediaQueryListEvent) => { setReducedTransparency(event.matches); };
    try {
      query.addEventListener("change", onChange);
      return () => { query.removeEventListener("change", onChange); };
    } catch { return undefined; }
  }, []);

  // 场景只跑到最后一帧：这一轴要的是「稳定帧长什么样」，播放控制器留给场景实验室。
  const runner = useMemo(() => {
    if (sceneKey.scenarioId === undefined) return null;
    const scenario = ALL_SCENARIOS.find((item) => item.id === sceneKey.scenarioId);
    if (scenario === undefined) return null;
    const instance = new ScenarioRunner(scenario);
    instance.seek(scenario.steps.length - 1);
    return instance;
  }, [sceneKey]);

  const conditions = useMemo<ScenarioConditions>(() =>
    ({ theme: "light", motion: motionOff ? "off" : "on", viewport: width === "narrow" ? "narrow" : "wide" }),
    [motionOff, width]);

  const resetParams = useCallback(() => {
    setBlurPx(DEFAULT_BLUR_PX);
    setAlphaPct(DEFAULT_ALPHA_PCT);
    setTint(DEFAULT_TINT);
    setProbe(false);
    setNotice(`材质参数已回到钉住的默认值：模糊 ${DEFAULT_BLUR_PX}px、不透明度 ${DEFAULT_ALPHA_PCT}%、色调冷绿 Sage。`);
  }, []);

  const openSuggestion = useCallback((text: string) => {
    setDraft(text);
    setNotice("建议文本已填进输入框：这是本机状态变化，不是发送，也不是工具调用。");
    draftRef.current?.focus();
  }, []);

  // 参数落在预览元素自己身上：只覆盖这一颗元素的自定义属性，不进 :root，也不进存储。
  const materialVars = {
    "--aurora-blur": `${blurPx}px`,
    ...(reducedTransparency ? {} : { "--aurora-alpha": (alphaPct / 100).toFixed(2) })
  } as CSSProperties;

  const scene = sceneKey;
  return <div className="aurora-lab" data-testid="aurora-lab">
    <div className="aurora-lab__head">
      <h1>Aurora Glass 液态玻璃主题原型</h1>
      <p>开发隔离预览 · UI-AURORA-01 · 未接入正式主题</p>
    </div>

    <div className="aurora-lab__controls" role="group" aria-label="原型控制">
      <div className="aurora-lab__group"><span>皮肤 A/B</span><div className="aurora-lab__row">
        <Chip selected={skin === "classic"} label="经典" onClick={() => { setSkin("classic"); }} />
        <Chip selected={skin === "aurora"} label="Aurora 玻璃" onClick={() => { setSkin("aurora"); }} />
      </div></div>
      <div className="aurora-lab__group"><span>预览宽度</span><div className="aurora-lab__row">
        <Chip selected={width === "wide"} label="宽窗" onClick={() => { setWidth("wide"); }} />
        <Chip selected={width === "narrow"} label="窄窗" onClick={() => { setWidth("narrow"); setDrawerOpen(false); }} />
      </div></div>
      <div className="aurora-lab__group"><span>场景</span><div className="aurora-lab__row" data-testid="aurora-scenes">
        {SCENES.map((item) => <Chip key={item.key} testId={`aurora-scene-${item.key}`}
          selected={item.key === scene.key} label={item.label}
          onClick={() => { setSceneKey(item); setDrawerOpen(false); }} />)}
      </div></div>
      <div className="aurora-lab__group"><span>材质参数</span><div className="aurora-lab__row">
        <label className="aurora-lab__param">模糊
          <input type="range" min={0} max={40} step={1} value={blurPx} data-testid="aurora-blur"
            onChange={(event) => { setBlurPx(Number(event.currentTarget.value)); }} aria-label="背景模糊（像素）" />
          <output>{blurPx}px</output></label>
        <label className="aurora-lab__param">不透明度
          <input type="range" min={50} max={100} step={1} value={alphaPct} disabled={reducedTransparency}
            data-testid="aurora-alpha" onChange={(event) => { setAlphaPct(Number(event.currentTarget.value)); }}
            aria-label="玻璃表面不透明度（百分比）" />
          <output>{reducedTransparency ? "降级档固定 100%" : `${alphaPct}%`}</output></label>
      </div></div>
      <div className="aurora-lab__group"><span>底色色调</span><div className="aurora-lab__row" data-testid="aurora-tints">
        {(Object.keys(TINTS) as TintKey[]).map((key) => <Chip key={key} selected={tint === key}
          label={TINTS[key]} onClick={() => { setTint(key); }} />)}
      </div></div>
      <div className="aurora-lab__group"><span>可读性与动效</span><div className="aurora-lab__row">
        <Chip selected={reducedTransparency} label="透明度降级" onClick={() => { setReducedTransparency((value) => !value); }} />
        <Chip selected={motionOff} label="关闭动效" onClick={() => { setMotionOff((value) => !value); }} />
        <Chip selected={probe} label="诊断：条纹底" onClick={() => { setProbe((value) => !value); }} />
      </div></div>
      <div className="aurora-lab__group"><span>&nbsp;</span><div className="aurora-lab__row">
        <button className="secondary-button" type="button" data-testid="aurora-reset"
          onClick={resetParams}><RotateCcw aria-hidden="true" /><span>恢复默认 20px / 80%</span></button>
      </div></div>
    </div>

    <p className="aurora-lab__note" data-testid="aurora-scene-why">当前场景：{scene.label}——{scene.why}</p>
    {notice !== null && <p className="aurora-lab__note" role="status" data-testid="aurora-notice">{notice}
      <button className="text-link" type="button" onClick={() => { setNotice(null); }}>知道了</button></p>}

    <div className="aurora-lab__stage" data-aurora-width={width}>
      <div data-aurora-preview="true" data-testid="aurora-preview"
        data-aurora-skin={skin} data-aurora-tint={tint}
        data-aurora-transparency={reducedTransparency ? "reduced" : "full"}
        data-aurora-motion={motionOff ? "off" : "on"}
        data-aurora-probe={probe ? "on" : "off"}
        data-aurora-blur={blurPx} data-aurora-alpha={alphaPct} style={materialVars}>
        <div className="aurora-ambient" aria-hidden="true" />
        <div className="aurora-frame desktop-window">
          <TitleBar onAction={setNotice} />
          <div className="app-frame app-frame--collaboration" data-context-collapsed="false">
            <aside className="app-navrail" aria-label="应用导航（原型复刻）" data-aurora-local="true">
              <nav className="navigation-list" aria-label="主导航">
                {NAV_PRIMARY.map((item) => <NavButton key={item.key} active={activeRow === item.key}
                  label={item.label} icon={item.icon}
                  onSelect={() => { setActiveRow(item.key); setNotice(`原型只移动导航选中态：不切换路由，也不进入「${item.label}」。`); }} />)}
              </nav>
              <nav className="navigation-list navigation-list--secondary" aria-label="次级导航">
                {NAV_SECONDARY.map((item) => <NavButton key={item.key} active={activeRow === item.key}
                  label={item.label} icon={item.icon}
                  onSelect={() => { setActiveRow(item.key); setNotice(`原型只移动导航选中态：不切换路由，也不进入「${item.label}」。`); }} />)}
              </nav>
              <nav className="navigation-list navigation-list--bottom" aria-label="辅助导航">
                {NAV_TERTIARY.map((item) => <NavButton key={item.key} active={activeRow === item.key}
                  label={item.label} icon={item.icon}
                  onSelect={() => { setActiveRow(item.key); setNotice(`原型只移动导航选中态：不切换路由，也不进入「${item.label}」。`); }} />)}
              </nav>
            </aside>
            <ContextRail active={activeRow}
              onSelect={(id, title) => { setActiveRow(id); setNotice(`原型只切换选中条目：不打开真实会话「${title}」。`); }}
              onAction={setNotice} />
            <div className="app-content">
              <header className="app-topbar">
                <button className="mobile-menu-button icon-button" type="button" aria-label="打开导航"
                  aria-haspopup="dialog" aria-expanded={drawerOpen}
                  onClick={() => { setDrawerOpen((value) => !value); }}><Menu aria-hidden="true" /></button>
                <nav className="breadcrumbs" aria-label="面包屑">
                  <span className="breadcrumb-item"><span>工作空间</span></span>
                  <span className="breadcrumb-item"><span className="breadcrumb-separator" aria-hidden="true">/</span><span>{scene.label}</span></span>
                </nav>
                <span className="helper-text aurora-topbar-hint" data-testid="aurora-skin-readout">
                  {skin === "aurora" ? `Aurora 玻璃 · 模糊 ${blurPx}px · 不透明度 ${reducedTransparency ? "100%（降级）" : `${alphaPct}%`}` : "经典（产品当前皮肤）"}
                </span>
              </header>
              {/* 用 div 而不是 main：真实外壳已经有一个 `<main id="main-content">`，
                  复刻件再挂一个就成了一份文档两个主区域。`.app-main` 的几何由类名承担。 */}
              <div className="app-main" data-testid="aurora-main">
                <div className="aurora-paper-host">
                  <ScenarioShell conditions={conditions}>
                    <section className={`surface-panel agent-chat-conversation${scene.key === "welcome" ? " agent-chat-start" : ""}`}>
                      {runner === null
                        ? <Welcome onPick={openSuggestion} />
                        : <div className="agent-chat-transcript-shell"><div className="agent-chat-transcript">
                          <ScenarioStage runner={runner} />
                        </div></div>}
                      <Composer draft={draft} onDraftChange={setDraft} draftRef={draftRef} model={model}
                        onModelPick={(name) => { setModel(name); setNotice(`模型芯片改为本机选项「${name}」：没有读取模型目录，也没有发起请求。`); }}
                        onAction={setNotice} />
                    </section>
                  </ScenarioShell>
                </div>
              </div>
            </div>
          </div>
          {drawerOpen && <>
            <button className="aurora-drawer-scrim" type="button" aria-label="关闭导航" data-testid="aurora-drawer-scrim"
              onClick={() => { setDrawerOpen(false); }} />
            <div className="aurora-drawer" role="dialog" aria-label="导航" aria-modal="true" data-testid="aurora-drawer"
              data-aurora-local="true">
              <div className="mobile-navigation-actions">
                <button className="mobile-navigation-action" type="button"
                  onClick={() => { setDrawerOpen(false); setNotice("原型不创建会话：会话草稿仍只由协作页持有。"); }}>
                  <SquarePen aria-hidden="true" /><span>新对话</span></button>
              </div>
              <nav className="mobile-navigation-list" aria-label="完整导航">
                {[...NAV_PRIMARY, ...NAV_SECONDARY, ...NAV_TERTIARY].map((item) =>
                  <button key={item.key} type="button"
                    className={`mobile-navigation-item${activeRow === item.key ? " mobile-navigation-item--active" : ""}`}
                    onClick={() => { setActiveRow(item.key); setDrawerOpen(false); setNotice(`原型只移动导航选中态：不切换路由。`); }}>
                    <item.icon aria-hidden="true" /><span>{item.label}</span></button>)}
              </nav>
            </div>
          </>}
        </div>
      </div>
    </div>

    <dl className="aurora-lab__legend">
      {LEGEND.map(([term, detail]) => <div key={term}>
        <dt>{term}</dt><dd>{detail}</dd></div>)}
    </dl>
    <p className="aurora-lab__note">
      标注为原型替身的控件（<code>data-aurora-local</code>）不读取模型目录、会话账本或磁盘，也不写入展示偏好；
      主区正文是场景实验室的同一批产品组件与同一帧模拟世界。「诊断：条纹底」把背景换成高对比条纹，
      只用于验证 20px 模糊确实在改像素，正常视觉验收与截图不使用它。
    </p>
  </div>;
}
