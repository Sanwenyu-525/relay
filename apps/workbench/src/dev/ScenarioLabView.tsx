import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type ReactElement, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import {
  ArrowLeft, ChevronDown, ChevronRight, ChevronsRight, Download, Info,
  PanelLeft, Pause, Play, Repeat, RotateCcw, Search, SkipBack,
  SkipForward, SlidersHorizontal, X
} from "lucide-react";
import { useActivityDensity } from "../lib/activityDensity";
import { dialogCount } from "../lib/dialogStack";
import {
  applyMotionPreference, resolveMotionPreference, storeMotionPreference, storedMotionPreference
} from "../lib/motionPreference";
import { runChecks, type CheckResult } from "./scenarioChecks";
import { ScenarioShell, ScenarioStage } from "./scenarioHost";
import { buildScenarioManifest } from "./scenarioManifest";
import {
  ACCEPTANCE_LABEL, EMPTY_COUNTS, SCENARIO_LAB_IDENTITY, acceptanceOfScenario,
  countRun, judgeScenario, type LabAcceptance, type LabRunCounts, type LabRunMode,
  type LabRunRecord, type LabVerdict
} from "./scenarioLabRuns";
import { settleScenarioPreview, type PreviewReading, type SettleOutcome } from "./scenarioSettle";
import { ALL_SCENARIOS, SCENARIO_GROUPS } from "./scenarios";
import {
  CATEGORY_META, ScenarioRunner,
  type Scenario, type ScenarioCategory
} from "./scenarioWorld";
import "./ScenarioLab.css";

/**
 * AI 回复场景实验室（仅开发构建）。
 *
 * Preview-first 开发者工作区：左侧是可折叠的场景目录，中间是产品自己的回复组件预览，
 * 播放控制紧贴预览上方，技术检查（展示设置／事件时间线／验收结果）收进按需打开的检查面板。
 * 这一页自己不渲染任何回复内容，也不定义第二套状态词——中间那一列和会话页共用
 * `ScenarioStage` → `AssistMessageRow` / `ExecutionTrajectorySummary` / `RunToolTrajectoryPanel`，
 * 因此这里看到的与 `tests/scenarioLabMatrix.spec.tsx`、浏览器批次跑的是同一帧、同一份断言。
 *
 * 三条边界：
 *   * 数据只进不出：模拟世界由 `scenarioClient` 按真实签名喂给组件，不写库、不调模型、不执行命令。
 *   * 呈现条件走产品自己的偏好入口（阅读密度、动效），离开本页按进入前的值还原；
 *     只有「明/暗」是实验室的临时反相——产品没有主题系统，那条只验结构不垮，不宣称产品支持暗色。
 *   * 验收状态是**这一页跑出来的结果**，不写进业务验收账本，也不因为「场景能播」就报通过。
 */

type Speed = 0.5 | 1 | 2;
type Viewport = "wide" | "narrow" | "phone";
type LabMode = "single" | "gallery";
type LabFilter = "all" | "running" | "done" | "error" | "unverified";
type InspectorTab = "display" | "timeline" | "verification";

const SPEEDS: readonly Speed[] = [0.5, 1, 2];
const VIEWPORTS: readonly { readonly value: Viewport; readonly label: string }[] = [
  { value: "wide", label: "宽窗" }, { value: "narrow", label: "窄窗" }, { value: "phone", label: "手机宽" }
];
const DENSITY_LABEL = { concise: "简洁", standard: "标准", detailed: "详细" } as const;
const FILTERS: readonly { readonly value: LabFilter; readonly label: string }[] = [
  { value: "all", label: "全部" }, { value: "running", label: "运行中" },
  { value: "done", label: "完成" }, { value: "error", label: "异常" },
  { value: "unverified", label: "未验收" }
];
const INSPECTOR_TABS: readonly { readonly value: InspectorTab; readonly label: string }[] = [
  { value: "display", label: "展示设置" }, { value: "timeline", label: "事件时间线" },
  { value: "verification", label: "验收结果" }
];
/** 虚拟时钟每跳一次推进的真实毫秒；帧由 steps 的绝对时刻决定，不等真实网络。 */
const TICK_MS = 40;

/**
 * 场景筛选口径只来自两处真实事实：场景自身声明的 `stateKind`，或这一页跑出的验收结果。
 * 不把「看起来像跑完了」推断成业务成功——SETTLED 与「通过」仍由各自的事实决定。
 */
function matchesFilter(scenario: Scenario, acceptance: LabAcceptance, filter: LabFilter): boolean {
  switch (filter) {
    case "running": return scenario.stateKind === "在途" || scenario.stateKind === "流式";
    case "done": return scenario.stateKind === "终态";
    case "error": return ["失败", "未知", "取消"].includes(scenario.stateKind) || acceptance === "fail";
    case "unverified": return ["unchecked", "not-covered", "unverifiable", "stale"].includes(acceptance);
    default: return true;
  }
}

function matchesQuery(scenario: Scenario, query: string): boolean {
  if (query === "") return true;
  return [scenario.id, scenario.title, scenario.component, scenario.stateKind]
    .some((value) => value.toLocaleLowerCase().includes(query));
}

const lastIndex = (scenario: Scenario): number => scenario.steps.length - 1;
const categoryOf = (scenario: Scenario): ScenarioCategory => scenario.id.charAt(0) as ScenarioCategory;

/**
 * 场景清单（写进 DOM 的那一份 JSON）。
 *
 * 浏览器批次需要「有哪些条、每条几帧、哪几条断言只能在真实布局下量」，
 * 但我不想为测试另开一条只有 Playwright 认的私有接口：清单就是这一页已经知道的事实，
 * 原样落在 `script[type=application/json]` 里，人和机器读的都是同一份，不会有两套口径。
 *
 * 映射本身在 `scenarioManifest.ts`：Playwright 用同一个函数构造期望值，再和页面读回的
 * JSON 逐字段比对。清单过期时验收直接非零退出，而不是拿旧清单写一份看起来通过的报告。
 */
function manifest(): ReactElement {
  return <script id="scenario-lab-manifest" type="application/json">
    {JSON.stringify(buildScenarioManifest())}
  </script>;
}

const BACK_TARGET_KEY = "relay.scenario-lab.from";

/**
 * 「返回」只接受站内、可安全写进 `Link` 的路径。
 *
 * 拒绝协议相对地址（`//evil.example`）、带控制字符的值和实验室自身：
 * 前者会离开站点，后者会让「返回」原地打转。查询串与 hash 保留，语义仍由目标路由解释。
 */
function safeBackTarget(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return null;
  if (!value.startsWith("/") || value.startsWith("//") || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value, "http://relay.invalid");
    if (url.origin !== "http://relay.invalid") return null;
    const path = `${url.pathname}${url.search}${url.hash}`;
    // 已经在实验室里再点一次侧栏时，外壳会保留原来源；来源本身是实验室只可能是旧值，不能拿来回跳。
    if (url.pathname === "/__dev/assist-scenarios") return null;
    return path;
  } catch {
    return null;
  }
}

/**
 * 返回目标的解析顺序：
 *   1. 本次进入时外壳带来的 `location.state.from`（最可信；存在但无效时直接回默认页，不拿旧记录兜底）；
 *   2. 整页刷新时用 `sessionStorage` 里上一次进入记录恢复——覆盖宿主不保留 history state 的情况；
 *   3. 其余情况（直接打开、外链、无效来源）一律回 `/agent`，不读旧来源，避免把上次会话的页面当成这次的入口。
 *
 * 存储只在「有合法来源」时写入，在「直接打开」时清掉；
 * 这样「直接打开后再刷新」也不会把上一次的页面借回来。
 */
function useBackTarget(state: unknown): string {
  const hasState = state !== null && state !== undefined;
  const fromState = hasState ? safeBackTarget((state as { from?: unknown }).from) : null;
  // 这一次文档加载是不是刷新打开的：只在整页重新加载时才承认刷新回退。
  const reloaded = useRef<boolean | null>(null);
  if (reloaded.current === null) {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    reloaded.current = navigation?.type === "reload";
  }
  const target = useMemo(() => {
    if (hasState) return fromState ?? "/agent";
    if (reloaded.current === true) {
      try {
        return safeBackTarget(window.sessionStorage.getItem(BACK_TARGET_KEY)) ?? "/agent";
      } catch {
        return "/agent";
      }
    }
    return "/agent";
  }, [hasState, fromState]);
  useEffect(() => {
    try {
      if (fromState !== null) window.sessionStorage.setItem(BACK_TARGET_KEY, fromState);
      else if (!hasState && reloaded.current !== true) window.sessionStorage.removeItem(BACK_TARGET_KEY);
    } catch {
      // 隐私模式或配额满：只影响刷新后的回退，不阻断使用。
    }
  }, [hasState, fromState]);
  return target;
}

export default function ScenarioLabView(): ReactElement {
  // query 只作为打开时的深链入口（scenario/frame/labSettleMs）；切换场景不改 URL，
  // 因为 App 的 keyed Outlet 以 `pathname+search` 为 key，改 query 会整页重挂、清空批次状态。
  const [query] = useSearchParams();
  const location = useLocation();
  /**
   * 「返回工作台」回**进入本页之前**那一页（外壳把 path+search 放进 `location.state.from`）。
   * 刷新后 state 已丢，此时才读 `sessionStorage` 里的刷新回退；深链或直接打开仍回默认工作台 `/agent`。
   * 来源是实验室自身时不记，免得返回时原地打转（见 `safeBackTarget`）。
   */
  const backTo = useBackTarget(location.state);
  const backLabel = /^\/agent(?:[?#]|$)/u.test(backTo) ? "返回工作台" : "返回进入前的页面";
  const requestedScenario = ALL_SCENARIOS.find((item) => item.id === query.get("scenario"));
  const initial = requestedScenario ?? ALL_SCENARIOS[0] as Scenario;
  /** `?frame=` 是浏览器批次的深链入口：打开就停在那一帧，走的仍是回放器的 seek。 */
  const initialFrame = Math.max(0, Math.min(lastIndex(initial), Math.trunc(Number(query.get("frame") ?? 0)) || 0));
  const [scenario, setScenario] = useState<Scenario>(initial);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [loop, setLoop] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [viewport, setViewport] = useState<Viewport>("wide");
  const [motionOn, setMotionOn] = useState(() => resolveMotionPreference());
  const [mode, setMode] = useState<LabMode>("single");
  const [galleryFamily, setGalleryFamily] = useState<string>(() => categoryOf(scenario));
  /**
   * 两套验收结果分开保存：快速静态检查与完整场景验收各自有独立批次、独立计数，
   * 目录只展示「最近一次尝试」的状态，Inspector 同时列出两者，不把结果混成一份。
   */
  const [runs, setRuns] = useState<{ static: LabRunRecord | null; full: LabRunRecord | null }>(
    { static: null, full: null });
  const [latestRunMode, setLatestRunMode] = useState<LabRunMode | null>(null);
  const [activeRun, setActiveRun] = useState<{ readonly id: string; readonly mode: LabRunMode;
    readonly scope: "all" | "current"; readonly done: number; readonly total: number;
    readonly startedAt: number } | null>(null);
  /** 手动播到末帧的单场景结果：只进 Inspector 的「当前场景」，不冒充一次全量批次。 */
  const [standalone, setStandalone] = useState<{ readonly id: string; readonly verdict: LabVerdict;
    readonly results: readonly CheckResult[] } | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<LabFilter>("all");
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<ScenarioCategory>>(
    () => new Set<ScenarioCategory>([categoryOf(initial)]));
  const [directoryCollapsed, setDirectoryCollapsed] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("verification");
  // 目录在宽窗是常驻列、窄窗是抽屉；同一颗入口的行为与 aria-expanded 要按当前布局解释。
  const [compactLayout, setCompactLayout] = useState(() =>
    window.matchMedia("(max-width: 1100px)").matches);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const elapsedRef = useRef(0);
  const scenarioRef = useRef(scenario);
  scenarioRef.current = scenario;
  const runnersRef = useRef(new Map<string, ScenarioRunner>());
  const activeRunRef = useRef<{ readonly id: string; readonly mode: LabRunMode;
    readonly scope: "all" | "current"; readonly token: { cancelled: boolean } } | null>(null);
  const runCounterRef = useRef(0);
  /** `?labSettleMs=` 是验收测试的显式超时入口；默认 2500ms，范围 1–10000ms。 */
  const settleTimeoutMs = (() => {
    const raw = Number(query.get("labSettleMs") ?? "");
    if (!Number.isFinite(raw) || raw <= 0) return 2_500;
    return Math.max(1, Math.min(10_000, Math.trunc(raw)));
  })();

  /** 同一身份复用同一个回放器：控制器与舞台必须盯着同一份状态，不能各建一个。 */
  const runnerFor = useCallback((item: Scenario): ScenarioRunner => {
    const cached = runnersRef.current.get(item.id);
    if (cached !== undefined && cached.scenario === item) return cached;
    const created = new ScenarioRunner(item);
    runnersRef.current.set(item.id, created);
    return created;
  }, []);

  const runner = runnerFor(scenario);
  const subscribeRunner = useCallback((notify: () => void) => runner.subscribe(notify), [runner]);
  const seq = useSyncExternalStore(subscribeRunner, () => runner.seq, () => runner.seq);

  const density = useActivityDensity();
  const setDensity = density.setDensity;
  const enteredRef = useRef({ density: density.density, motion: storedMotionPreference() });

  /**
   * 施加一条场景声明的呈现条件。
   *
   * 三个入口共用它：目录点开、深链进来、批量跑到下一条。缺一个入口就会造成
   * 「点进去看到的是这一档，深链或批量看到的是另一档」——F20（暗色）、X09/X10（密度）
   * 在批次里就是这么读错的。动效按「没声明就回到进来之前的值」处理：场景没说话时不替用户改偏好。
   */
  const applyConditions = useCallback((item: Scenario) => {
    const declared = item.conditions ?? {};
    setTheme(declared.theme ?? "light");
    setViewport(declared.viewport ?? "wide");
    if (declared.density !== undefined) setDensity(declared.density);
    const motion = declared.motion ?? enteredRef.current.motion ?? "system";
    storeMotionPreference(motion);
    setMotionOn(applyMotionPreference(motion));
  }, [setDensity]);

  /**
   * 取消当前批次：只改批次身份与状态，不再让任何在途 await 写结果。
   * 新批次用新 run id，旧结果即使随后 resolve 也会因身份不匹配被丢弃。
   */
  const cancelActiveRun = useCallback((reason = "用户取消") => {
    const active = activeRunRef.current;
    if (active === null) return;
    active.token.cancelled = true;
    activeRunRef.current = null;
    setActiveRun(null);
    setRuns((current) => {
      const record = current[active.mode];
      if (record === null || record.id !== active.id) return current;
      return { ...current, [active.mode]: { ...record, status: "cancelled",
        durationMs: Math.max(0, Date.now() - record.startedAt),
        cancelledReason: reason } };
    });
  }, []);

  /** 打开一条场景时自动施加它声明的呈现条件；入口都是产品自己的，不是实验室私设。 */
  const openScenario = useCallback((next: Scenario, frameIndex = 0) => {
    cancelActiveRun("切换单场景时取消未完成批次");
    setStandalone(null);
    setPlaying(false);
    setMode("single");
    setScenario(next);
    scenarioRef.current = next;
    const instance = runnerFor(next);
    elapsedRef.current = next.steps[frameIndex]?.at ?? 0;
    instance.seek(frameIndex);
    applyConditions(next);
    setGalleryFamily(categoryOf(next));
    setSearch("");
    setFilter("all");
    setDirectoryOpen(false);
  }, [applyConditions, cancelActiveRun, runnerFor]);

  // 进入本页把 `?scenario=&frame=` 当成初始帧：浏览器批次按这一条深链逐帧截图，
  // 走的仍是回放器的 seek，不是另开一条渲染路径。呈现条件也在这里施加，深链才与点开同档。
  useEffect(() => {
    applyConditions(initial);
    const instance = runnerFor(initial);
    elapsedRef.current = initial.steps[initialFrame]?.at ?? 0;
    instance.seek(initialFrame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 离开本页把进来之前的偏好放回去：实验室改的是本设备视图偏好，不该悄悄留下。
  useEffect(() => () => {
    setDensity(enteredRef.current.density);
    const restore = enteredRef.current.motion ?? "system";
    storeMotionPreference(restore);
    applyMotionPreference(restore);
  }, [setDensity]);

  // 当前场景必须在自己所属的分类里可见：目录收起该组时切换场景，不能让选中项凭空消失。
  useEffect(() => {
    const category = categoryOf(scenario);
    setExpandedGroups((current) => {
      if (current.has(category)) return current;
      const next = new Set(current);
      next.add(category);
      return next;
    });
  }, [scenario]);

  // 新场景从预览顶部开始；同一场景逐帧推进时保持用户当前的滚动位置。
  useEffect(() => {
    previewScrollRef.current?.scrollTo({ top: 0 });
  }, [scenario.id, mode]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1100px)");
    const onChange = () => setCompactLayout(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // 窄窗目录／检查面板是非模态抽屉：Esc 只关最上面那一层，且不与工作台弹窗抢事件。
  useEffect(() => {
    if (!directoryOpen && !inspectorOpen) return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (dialogCount() > 0) return;
      event.preventDefault();
      if (directoryOpen) setDirectoryOpen(false);
      else setInspectorOpen(false);
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [directoryOpen, inspectorOpen]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const item = scenarioRef.current;
      elapsedRef.current += TICK_MS * speed;
      if (elapsedRef.current > runner.totalMs) {
        if (loop) { elapsedRef.current = 0; runner.reset(); return; }
        runner.seek(lastIndex(item));
        setPlaying(false);
        return;
      }
      const index = runner.indexAt(elapsedRef.current);
      if (index !== runner.index) runner.seek(index);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [playing, speed, loop, runner]);

  const previewRoot = (): HTMLElement | null =>
    stageRef.current?.querySelector<HTMLElement>("[data-scenario-preview]") ?? null;

  const readPreview = useCallback((): PreviewReading | null => {
    const root = previewRoot();
    if (root === null) return null;
    return {
      scenarioId: root.querySelector("[data-scenario-id]")?.getAttribute("data-scenario-id") ?? null,
      text: root.textContent ?? ""
    };
  }, []);

  /**
   * 等预览自己停稳，再跑断言。
   * 停稳算法在 `scenarioSettle.ts`：超时、身份不符与取消分别返回明确结果；
   * 只有 `ok` 才允许测量，超时不再把当前 DOM 当成可验证事实。
   */
  const settleCurrent = useCallback(async (token: { cancelled: boolean },
    expectedId: string): Promise<{ outcome: SettleOutcome; root: HTMLElement | null }> => {
    const outcome = await settleScenarioPreview({
      expectedId, token, read: readPreview, timeoutMs: settleTimeoutMs
    });
    if (outcome.status !== "ok") return { outcome, root: null };
    const root = previewRoot();
    const actualId = root?.querySelector("[data-scenario-id]")?.getAttribute("data-scenario-id") ?? null;
    if (root === null || actualId !== expectedId) {
      return { root: null, outcome: { status: "timeout",
        kind: root === null ? "unmounted" : "identity",
        detail: root === null
          ? "停稳后预览又被卸载，未执行断言"
          : `停稳后预览挂的是「${actualId ?? "未知场景"}」，不是 ${expectedId}` } };
    }
    return { outcome, root };
  }, [settleTimeoutMs, readPreview]);

  const recordStandalone = useCallback(async (token: { cancelled: boolean }, item: Scenario): Promise<void> => {
    const { outcome, root } = await settleCurrent(token, item.id);
    if (token.cancelled || outcome.status === "cancelled") return;
    if (outcome.status === "timeout" || root === null) {
      const reached = judgeScenario({ scenario: item, mode: "static", checks: [], settled: false,
        settleDetail: outcome.status === "timeout" ? outcome.detail : "预览不可用", interactionsRun: 0 });
      setStandalone({ id: item.id, verdict: reached, results: [] });
      return;
    }
    const found = runChecks(root, item.checks);
    setStandalone({ id: item.id, results: found,
      verdict: judgeScenario({ scenario: item, mode: "static", checks: found, settled: true, interactionsRun: 0 }) });
  }, [settleCurrent]);

  // 手动播到末帧时顺手跑一次单场景静态检查；只写 Inspector 的「当前场景」，不改批次结果。
  useEffect(() => {
    if (mode !== "single" || activeRun !== null) return;
    if (runner.index !== lastIndex(scenario)) return;
    const recorded = latestRunMode === null ? undefined : runs[latestRunMode]?.verdicts[scenario.id];
    if (recorded !== undefined) return;
    const token = { cancelled: false };
    void recordStandalone(token, scenario);
    return () => { token.cancelled = true; };
  }, [activeRun, latestRunMode, mode, recordStandalone, runner, runs, scenario, seq]);

  const updateRunRecord = useCallback((mode: LabRunMode, runId: string,
    update: (record: LabRunRecord) => LabRunRecord): void => {
    setRuns((current) => {
      const record = current[mode];
      if (record === null || record.id !== runId) return current;
      return { ...current, [mode]: update(record) };
    });
  }, []);

  const commitScenario = useCallback((token: { cancelled: boolean }, runId: string, mode: LabRunMode,
    item: Scenario, verdict: LabVerdict, checks: readonly CheckResult[], interactionsRun: number): void => {
    if (token.cancelled || activeRunRef.current?.id !== runId) return;
    updateRunRecord(mode, runId, (record) => ({
      ...record,
      done: record.done + 1,
      interactionsRun: record.interactionsRun + interactionsRun,
      verdicts: { ...record.verdicts, [item.id]: verdict },
      results: { ...record.results, [item.id]: checks }
    }));
    setActiveRun((current) => current === null || current.id !== runId
      ? current : { ...current, done: current.done + 1 });
  }, [updateRunRecord]);

  const finishRun = useCallback((token: { cancelled: boolean }, runId: string, mode: LabRunMode): void => {
    if (token.cancelled || activeRunRef.current?.id !== runId) return;
    updateRunRecord(mode, runId, (record) => ({ ...record, status: "completed",
      durationMs: Math.max(0, Date.now() - record.startedAt), done: record.total }));
    activeRunRef.current = null;
    setActiveRun(null);
  }, [updateRunRecord]);

  const activeRunIdentityRef = useRef(SCENARIO_LAB_IDENTITY);

  const executeScenario = useCallback(async (mode: LabRunMode,
    token: { cancelled: boolean }, runId: string, item: Scenario): Promise<boolean> => {
    setScenario(item);
    scenarioRef.current = item;
    applyConditions(item);
    const instance = runnerFor(item);
    const checks: CheckResult[] = [];
    let settled = true;
    let settleDetail: string | undefined;
    let interactionsRun = 0;

    // 完整验收按顺序重放每一帧；快速静态检查仍走「先见第 0 帧、再落末帧」。
    if (mode === "full") {
      for (let index = 0; index < item.steps.length; index += 1) {
        instance.seek(index);
        const reading = await settleCurrent(token, item.id);
        if (token.cancelled || reading.outcome.status === "cancelled") return false;
        if (reading.outcome.status === "timeout") {
          settled = false;
          settleDetail = `第 ${String(index + 1)} 帧停稳失败：${reading.outcome.detail}`;
          break;
        }
      }
    } else {
      instance.seek(0);
      const first = await settleCurrent(token, item.id);
      if (token.cancelled || first.outcome.status === "cancelled") return false;
      if (first.outcome.status === "timeout") {
        settled = false;
        settleDetail = `第 0 帧停稳失败：${first.outcome.detail}`;
      }
    }

    if (settled) {
      if (mode === "full") {
        instance.seek(0);
        const reset = await settleCurrent(token, item.id);
        if (token.cancelled || reset.outcome.status === "cancelled") return false;
        if (reset.outcome.status === "timeout") {
          settled = false;
          settleDetail = `交互重放前停稳失败：${reset.outcome.detail}`;
        }
        const actions = item.interactions ?? [];
        for (const action of actions) {
          if (token.cancelled) return false;
          if (action.kind === "scrollUp") {
            // 上滚稳定性依赖真实滚动容器与 Playwright 探针，本页不重复实现；
            // 这些检查明确标成「待浏览器验证」，不计入静态通过。
            checks.push(...action.then.map((check): CheckResult => ({ label: check.label,
              status: "browser-only", detail: "上滚位置稳定由 Playwright 浏览器批次判定，本页不重复实现" })));
            continue;
          }
          if (action.kind === "advance") instance.next();
          if (action.kind === "click") {
            const target = previewRoot()?.querySelector(action.selector);
            if (target == null) {
              checks.push({ label: action.label, status: "fail",
                detail: `动作目标不存在：${action.selector}` });
              continue;
            }
            target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          }
          const reading = await settleCurrent(token, item.id);
          if (token.cancelled || reading.outcome.status === "cancelled") return false;
          if (reading.outcome.status === "timeout") {
            settled = false;
            settleDetail = `交互「${action.label}」停稳失败：${reading.outcome.detail}`;
            break;
          }
          checks.push(...runChecks(reading.root ?? document.createElement("div"), action.then));
          interactionsRun += 1;
        }
      }

      if (settled) {
        instance.seek(lastIndex(item));
        const reading = await settleCurrent(token, item.id);
        if (token.cancelled || reading.outcome.status === "cancelled") return false;
        if (reading.outcome.status === "timeout") {
          settled = false;
          settleDetail = `末帧停稳失败：${reading.outcome.detail}`;
        } else {
          checks.push(...runChecks(reading.root ?? document.createElement("div"), item.checks));
        }
      }
    }

    const verdict = judgeScenario({ scenario: item, mode, checks, settled,
      settleDetail, interactionsRun, stale: SCENARIO_LAB_IDENTITY !== activeRunIdentityRef.current });
    commitScenario(token, runId, mode, item, verdict, checks, interactionsRun);
    return true;
  }, [applyConditions, commitScenario, runnerFor, settleCurrent]);

  const startRun = useCallback((mode: LabRunMode, scope: "all" | "current" = "all"): void => {
    if (activeRunRef.current !== null) return;
    const items = scope === "current" ? [scenarioRef.current] : ALL_SCENARIOS;
    const token = { cancelled: false };
    runCounterRef.current += 1;
    const runId = `${mode}-${String(runCounterRef.current)}-${String(Date.now())}`;
    const startedAt = Date.now();
    activeRunIdentityRef.current = SCENARIO_LAB_IDENTITY;
    activeRunRef.current = { id: runId, mode, scope, token };
    setPlaying(false);
    setMode("single");
    setStandalone(null);
    setLatestRunMode(mode);
    setRuns((current) => ({ ...current, [mode]: { id: runId, mode, scope, total: items.length,
      identity: SCENARIO_LAB_IDENTITY, startedAt, durationMs: 0, status: "running",
      done: 0, interactionsRun: 0, verdicts: {}, results: {} } }));
    setActiveRun({ id: runId, mode, scope, done: 0, total: items.length, startedAt });
    void (async () => {
      for (const item of items) {
        if (token.cancelled) return;
        const processed = await executeScenario(mode, token, runId, item as Scenario);
        if (!processed) return;
      }
      finishRun(token, runId, mode);
    })();
  }, [executeScenario, finishRun]);

  const runAll = useCallback((): void => startRun("static", "all"), [startRun]);
  const runFull = useCallback((): void => startRun("full", "all"), [startRun]);
  const runCurrentFull = useCallback((): void => startRun("full", "current"), [startRun]);

  // 离开页面时释放未完成批次：只置取消标记，不再让任何在途 await 写状态。
  useEffect(() => () => {
    const active = activeRunRef.current;
    if (active !== null) {
      active.token.cancelled = true;
      activeRunRef.current = null;
    }
  }, []);

  /**
   * 展开／收起所有过程：点每一处它自己的入口，不改 DOM 属性。
   *
   * 产品的展开态有两类机制——原生 `details`（会话过程、技术详情）和带
   * `aria-expanded` 的按钮（Run 轨迹、局部差异行）。直接写 `details.open` 不会被 React 记进状态，
   * 下一帧就被覆盖回去；只有点入口才走的是用户那条路径。
   */
  const toggleAll = useCallback((open: boolean) => {
    const root = previewRoot();
    if (root === null) return;
    for (const details of Array.from(root.querySelectorAll("details"))) {
      const summary = details.querySelector(":scope > summary");
      if (details.open !== open && summary !== null) {
        summary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }
    }
    for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"))) {
      if ((button.getAttribute("aria-expanded") === "true") !== open) button.click();
    }
  }, []);

  const exportReport = useCallback(() => {
    const runSummary = (mode: LabRunMode): { run: LabRunRecord | null; counts: LabRunCounts; stale: boolean } => {
      const run = runs[mode];
      const stale = run !== null && run.identity !== SCENARIO_LAB_IDENTITY;
      return { run, stale, counts: run === null ? EMPTY_COUNTS : countRun(run.verdicts, stale, run.total) };
    };
    const staticRun = runSummary("static");
    const fullRun = runSummary("full");
    const describe = (value: ReturnType<typeof runSummary>): string => {
      if (value.run === null) return "未运行";
      const counts = value.counts;
      const scope = value.run.scope === "current" ? "当前场景" : "全部场景";
      return `${value.run.status === "completed" ? "已完成" : value.run.status === "cancelled" ? "已取消" : "运行中"}`
        + `（${scope} ${String(value.run.done)}/${String(value.run.total)}，${String(value.run.durationMs)}ms）：`
        + `全部通过 ${String(counts.pass)}、静态通过 ${String(counts.staticPass)}、失败 ${String(counts.fail)}、`
        + `待浏览器 ${String(counts.pendingBrowser)}、无法验证 ${String(counts.unverifiable)}、`
        + `无法覆盖 ${String(counts.notCovered)}、未运行 ${String(counts.notRun)}`
        + (value.stale ? "；证据已过期" : "");
    };
    const lines = ["# AI 回复场景实验室 · 验收结果", "",
      `共 ${String(ALL_SCENARIOS.length)} 条。快速静态检查与完整场景验收分别记录，结果不混用。`, "",
      `- 快速静态检查：${describe(staticRun)}`,
      `- 完整场景验收：${describe(fullRun)}`,
      "", "> `browser-only` 检查不计入静态通过；只有完整场景验收执行完全部交互、且没有待浏览器项时才写「全部通过」。", "",
      "| 场景 | 名称 | 状态类型 | 组件位置 | 快速静态 | 完整验收 | 待浏览器 | 说明 |",
      "|---|---|---|---|---|---|---|---|"];
    for (const item of ALL_SCENARIOS) {
      const staticVerdict = staticRun.run?.verdicts[item.id];
      const fullVerdict = fullRun.run?.verdicts[item.id];
      const pending = (staticVerdict?.browserOnly ?? 0) + (fullVerdict?.browserOnly ?? 0);
      const detail = fullVerdict?.detail ?? staticVerdict?.detail ?? item.uncovered ?? "";
      lines.push(`| ${item.id} | ${item.title} | ${item.stateKind} | ${item.component} | `
        + `${staticVerdict === undefined ? "未运行" : ACCEPTANCE_LABEL[staticVerdict.acceptance]} | `
        + `${fullVerdict === undefined ? "未运行" : ACCEPTANCE_LABEL[fullVerdict.acceptance]} | `
        + `${String(pending)} | ${detail.replace(/\|/g, "/").replace(/\n/g, "；")} |`);
    }
    if (standalone !== null) {
      lines.push("", "## 当前场景手动检查", "",
        `- ${standalone.id}：${ACCEPTANCE_LABEL[standalone.verdict.acceptance]}（${standalone.verdict.detail}）`,
        `- 静态断言 ${String(standalone.verdict.passedChecks)}/${String(standalone.verdict.totalChecks)}，`
        + `待浏览器 ${String(standalone.verdict.browserOnly)}，交互执行 ${String(standalone.verdict.interactionsRun)}`);
    }
    lines.push("", "> 截图与浏览器十条性质由 Playwright 批次判定，本报告不把静态结果冒充完整验收。");
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "scenario-lab-report.md";
    link.click();
    URL.revokeObjectURL(url);
  }, [runs, standalone]);

  const seekTo = useCallback((index: number) => {
    setPlaying(false);
    const clamped = Math.max(0, Math.min(lastIndex(scenarioRef.current), Math.trunc(index)));
    elapsedRef.current = scenarioRef.current.steps[clamped]?.at ?? 0;
    runner.seek(clamped);
  }, [runner]);

  const togglePlay = useCallback(() => {
    if (!playing && runner.index >= lastIndex(scenarioRef.current)) {
      elapsedRef.current = 0;
      runner.reset();
    }
    setPlaying((value) => !value);
  }, [playing, runner]);

  const previousFrame = useCallback(() => {
    const next = Math.max(0, runner.index - 1);
    seekTo(next);
  }, [runner, seekTo]);

  const nextFrame = useCallback(() => {
    seekTo(runner.index + 1);
  }, [runner, seekTo]);

  const resetPlayback = useCallback(() => {
    setPlaying(false);
    elapsedRef.current = 0;
    runner.reset();
  }, [runner]);

  /** 单帧场景没有可推进的帧，「重新检查」只重新跑这一条静态断言。 */
  const recheckCurrent = useCallback(() => {
    setPlaying(false);
    elapsedRef.current = scenarioRef.current.steps[0]?.at ?? 0;
    runner.reset();
    setStandalone(null);
    const token = { cancelled: false };
    void recordStandalone(token, scenarioRef.current);
  }, [recordStandalone, runner]);

  const openInspector = useCallback((tab: InspectorTab = "verification") => {
    setDirectoryOpen(false);
    setInspectorTab(tab);
    setInspectorOpen(true);
  }, []);

  const toggleGroup = useCallback((category: ScenarioCategory) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }, []);

  const toggleDirectory = useCallback(() => {
    // 宽窗收列，窄窗开抽屉：两件事由同一颗入口承担，点击行为按当前布局分流。
    if (compactLayout) {
      setInspectorOpen(false);
      setDirectoryOpen((value) => !value);
    } else {
      setDirectoryCollapsed((value) => !value);
    }
  }, [compactLayout]);

  const switchMode = useCallback((next: LabMode) => {
    cancelActiveRun("切换实验室视图时取消未完成批次");
    if (next === "gallery") {
      setPlaying(false);
      setGalleryFamily(categoryOf(scenarioRef.current));
      setInspectorOpen(false);
    }
    setMode(next);
  }, [cancelActiveRun]);

  // 帧号直接从回放器读：它才是唯一事实，控制器不再存一份副本，两处不会走偏。
  const frame = runner.index;
  const currentStep = scenario.steps[frame] ?? scenario.steps[0];
  const nextScenario = ALL_SCENARIOS[(ALL_SCENARIOS.indexOf(scenario) + 1) % ALL_SCENARIOS.length] as Scenario;
  const latestRun = latestRunMode === null ? null : runs[latestRunMode];
  const latestStale = latestRun !== null && latestRun.identity !== SCENARIO_LAB_IDENTITY;
  const latestVerdicts = latestRun?.verdicts ?? {};
  const runVerdict = latestVerdicts[scenario.id];
  const manualVerdict = standalone !== null && standalone.id === scenario.id ? standalone.verdict : undefined;
  const currentVerdict = runVerdict ?? manualVerdict;
  const currentStale = runVerdict !== undefined ? latestStale : false;
  const currentAcceptance: LabAcceptance = currentVerdict === undefined
    ? (scenario.uncovered !== undefined ? "not-covered" : "unchecked")
    : currentStale ? "stale" : currentVerdict.acceptance;
  const currentResults = latestRun?.results[scenario.id]
    ?? (standalone !== null && standalone.id === scenario.id ? standalone.results : []);
  const runCounts = latestRun === null ? EMPTY_COUNTS : countRun(latestVerdicts, latestStale, latestRun.total);
  const staticCounts = runs.static === null ? EMPTY_COUNTS
    : countRun(runs.static.verdicts, runs.static.identity !== SCENARIO_LAB_IDENTITY, runs.static.total);
  const fullCounts = runs.full === null ? EMPTY_COUNTS
    : countRun(runs.full.verdicts, runs.full.identity !== SCENARIO_LAB_IDENTITY, runs.full.total);
  const runRunning = activeRun !== null;
  const isMultiFrame = scenario.steps.length > 1;
  const atLastFrame = frame >= lastIndex(scenario);
  const conditions = { theme, viewport, ...(motionOn ? {} : { motion: "off" as const }) };
  const counts = { pass: runCounts.pass, staticPass: runCounts.staticPass, fail: runCounts.fail,
    pendingBrowser: runCounts.pendingBrowser, unverifiable: runCounts.unverifiable,
    notCovered: runCounts.notCovered, stale: runCounts.stale, notRun: runCounts.notRun,
    checked: runCounts.checked };

  /** 目录状态优先读最近批次；没有批次结果时，当前场景的手动静态检查也可以显示。 */
  const acceptanceForItem = (item: Scenario): LabAcceptance => {
    const batchVerdict = latestVerdicts[item.id];
    if (batchVerdict !== undefined) return acceptanceOfScenario(item, batchVerdict, latestStale);
    if (standalone !== null && standalone.id === item.id) {
      return acceptanceOfScenario(item, standalone.verdict, false);
    }
    return acceptanceOfScenario(item, undefined, false);
  };

  const queryText = search.trim().toLocaleLowerCase();
  const filtering = filter !== "all" || queryText !== "";
  const visibleGroups = SCENARIO_GROUPS.map((group) => ({
    ...group,
    visible: group.scenarios.filter((item) => matchesFilter(item, acceptanceForItem(item), filter)
      && matchesQuery(item, queryText))
  })).filter((group) => group.visible.length > 0 || !filtering);
  const visibleTotal = visibleGroups.reduce((sum, group) => sum + group.visible.length, 0);
  const galleryGroup = SCENARIO_GROUPS.find((group) => group.category === galleryFamily) ?? SCENARIO_GROUPS[0];
  const galleryScenarios = galleryGroup?.scenarios ?? [];
  const overlayOpen = directoryOpen || inspectorOpen;
  const progressPercent = lastIndex(scenario) === 0 ? 100 : Math.round((frame / lastIndex(scenario)) * 100);
  const selectedVisible = visibleGroups.some((group) => group.visible.some((item) => item.id === scenario.id));

  /** 目录行只有一处写法：分组列表与「当前场景」置顶行都复用它，状态点读最近一次批次的结果。 */
  const directoryItem = (item: Scenario): ReactElement => {
    const batchVerdict = latestVerdicts[item.id];
    const verdict = batchVerdict
      ?? (standalone !== null && standalone.id === item.id ? standalone.verdict : undefined);
    const stale = batchVerdict !== undefined && latestStale;
    const acceptance = acceptanceOfScenario(item, verdict, stale);
    const active = item.id === scenario.id;
    const title = verdict === undefined
      ? `${item.id} ${item.title} · ${item.stateKind}`
      : `${ACCEPTANCE_LABEL[acceptance]}：${verdict.detail}`
        + (verdict.failures.length > 0 ? `\n${verdict.failures.join("\n")}` : "");
    return <li key={item.id}>
      <button type="button" data-testid={`scenario-pick-${item.id}`}
        className={`scenario-lab-item${active ? " scenario-lab-item--active" : ""}`}
        aria-current={active ? "page" : undefined} title={title}
        onClick={() => openScenario(item)}>
        <span className="scenario-lab-item-id">{item.id}</span>
        <span className="scenario-lab-item-title">{item.title}</span>
        <span className="scenario-lab-item-state" data-acceptance={acceptance}
          aria-label={`验收：${ACCEPTANCE_LABEL[acceptance]}`}
          title={verdict?.failures.join("\n") ?? item.note ?? ""} />
      </button>
    </li>;
  };

  return <section className="scenario-lab-page" data-scenario-lab="true">
    {manifest()}
    <header className="scenario-lab-head">
      <div className="scenario-lab-head-main">
        {/* 返回入口并进标题行：外壳已经有一条「工作空间 / 开发工具 / 实验室」面包屑，
            再单独占一行「返回工作台」就是同一件事说两遍，还把预览整体往下推一档。 */}
        <Link className="scenario-lab-back text-link" to={backTo} data-testid="scenario-back-to-workbench"
          title="回到进入实验室之前的页面">
          <ArrowLeft aria-hidden="true" />{backLabel}</Link>
        <span className="scenario-lab-head-divider" aria-hidden="true" />
        <button className="icon-button scenario-lab-directory-button" type="button"
          data-testid="scenario-directory-toggle" aria-label="场景目录" title="场景目录"
          aria-expanded={compactLayout ? directoryOpen : !directoryCollapsed} onClick={toggleDirectory}>
          <PanelLeft aria-hidden="true" />
        </button>
        <h1>AI 回复场景实验室</h1>
        <span className="scenario-lab-count">{ALL_SCENARIOS.length} 场景</span>
        <span className="scenario-lab-dev">仅开发构建</span>
        <span className="scenario-lab-info" role="note" aria-label="开发隔离说明"
          title="中间一列是产品自己的回复组件，读的是内存里的模拟世界：不写业务库、不调模型、不执行命令，也不产生真实审批。">
          <Info aria-hidden="true" />
        </span>
      </div>
      <div className="scenario-lab-head-actions">
        <Segmented group="实验室模式" options={([
          { value: "single", label: "逐条播放" }, { value: "gallery", label: "全部状态" }
        ] as const).map((option) => ({ value: option.value, label: option.label,
          selected: mode === option.value, testId: `scenario-mode-${option.value}`,
          onSelect: () => switchMode(option.value) }))} />
        <button className="secondary-button" type="button" data-testid="scenario-run-all" disabled={runRunning}
          onClick={runAll} title="只执行末帧静态断言，适合日常快速回归">
          <Play aria-hidden="true" />
          {activeRun?.mode === "static" ? `静态检查中 ${activeRun.done}/${activeRun.total}` : "快速静态检查"}
        </button>
        <button className="secondary-button" type="button" data-testid="scenario-run-full" disabled={runRunning}
          onClick={runFull} title="按顺序重放所有帧与交互，再执行末帧静态断言；浏览器专属检查转 Playwright">
          <SkipForward aria-hidden="true" />
          {activeRun?.mode === "full" ? `完整验收中 ${activeRun.done}/${activeRun.total}` : "完整场景验收"}
        </button>
        {activeRun !== null && <button className="secondary-button" type="button"
          data-testid="scenario-cancel-run" onClick={() => cancelActiveRun("用户点击取消")}>
          <X aria-hidden="true" />取消
        </button>}
        <button className="secondary-button" type="button" data-testid="scenario-export-report"
          onClick={exportReport} title="导出当前验收结果为 Markdown">
          <Download aria-hidden="true" /><span className="scenario-lab-action-label">导出报告</span>
        </button>
        {(activeRun !== null || latestRun !== null) && <span className="scenario-lab-run-status" role="status"
          data-testid="scenario-run-status"
          data-run-id={activeRun?.id ?? latestRun?.id ?? ""}
          data-run-mode={activeRun?.mode ?? latestRun?.mode ?? ""}
          data-run-scope={activeRun?.scope ?? latestRun?.scope ?? ""}
          data-run-status={activeRun !== null ? "running" : latestRun?.status ?? "none"}
          data-run-done={activeRun?.done ?? latestRun?.done ?? 0}
          data-run-total={activeRun?.total ?? latestRun?.total ?? 0}>
          {activeRun !== null
            ? `${activeRun.mode === "static" ? "静态" : "完整"}${activeRun.scope === "current" ? "·当前" : ""}`
              + ` ${String(activeRun.done)}/${String(activeRun.total)}`
            : latestRun === null ? ""
              : `${latestRun.mode === "static" ? "静态" : "完整"}${latestRun.scope === "current" ? "·当前" : ""}`
                + ` ${latestRun.status === "completed" ? "完成" : latestRun.status === "cancelled" ? "已取消" : "运行中"}`
                + ` ${String(latestRun.done)}/${String(latestRun.total)}`}
        </span>}
      </div>
    </header>

    <div className="scenario-lab-body">
      <nav id="scenario-lab-directory" className="scenario-lab-directory" aria-label="场景目录"
        data-open={directoryOpen ? "true" : "false"} data-collapsed={directoryCollapsed ? "true" : "false"}>
        <div className="scenario-lab-directory-head">
          <div className="scenario-lab-directory-title">
            <strong>场景目录</strong>
            <span>{filtering ? `${visibleTotal}/${ALL_SCENARIOS.length}` : ALL_SCENARIOS.length}</span>
          </div>
          <button className="icon-button scenario-lab-directory-close" type="button"
            data-testid="scenario-directory-close" aria-label="关闭场景目录" onClick={() => setDirectoryOpen(false)}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="scenario-lab-search">
          <Search aria-hidden="true" />
          <input type="search" value={search} data-testid="scenario-search" aria-label="搜索场景"
            placeholder="搜索 ID、标题或组件" autoComplete="off"
            onChange={(event) => setSearch(event.target.value)} />
          {search !== "" && <button className="icon-button" type="button" aria-label="清空搜索"
            onClick={() => setSearch("")}><X aria-hidden="true" /></button>}
        </div>
        <div className="scenario-lab-filters" role="group" aria-label="场景筛选">
          {FILTERS.map((item) => <button key={item.value} type="button"
            className={`scenario-lab-filter${filter === item.value ? " scenario-lab-filter--active" : ""}`}
            aria-pressed={filter === item.value} data-testid={`scenario-filter-${item.value}`}
            onClick={() => setFilter(item.value)}>{item.label}</button>)}
        </div>
        <p className="scenario-lab-directory-summary" data-testid="scenario-directory-summary">
          {latestRun !== null && latestRun.scope === "current"
            ? <>当前场景：{ACCEPTANCE_LABEL[currentAcceptance]}
              {currentVerdict !== undefined && currentVerdict.browserOnly > 0 &&
                <> · {String(currentVerdict.browserOnly)} 待浏览器</>}
              <br />其余 {ALL_SCENARIOS.length - 1} 条未运行（本次只验当前场景）</>
            : latestRun === null
              ? (standalone === null ? "尚未运行验收"
                : `当前场景：${ACCEPTANCE_LABEL[currentAcceptance]}`
                  + (standalone.verdict.browserOnly > 0 ? ` · ${String(standalone.verdict.browserOnly)} 待浏览器` : ""))
              : <>全部通过 {counts.pass} · 静态通过 {counts.staticPass} · 失败 {counts.fail}
                <br />待浏览器 {counts.pendingBrowser} · 未运行 {counts.notRun}
                {counts.unverifiable > 0 && <> · 无法验证 {counts.unverifiable}</>}
                {counts.stale > 0 && <> · 证据过期 {counts.stale}</>}</>}
          {filtering && <span className="scenario-lab-directory-filtering">筛选中</span>}
        </p>
        <div className="scenario-lab-directory-scroll">
          {filtering && !selectedVisible && <section className="scenario-lab-current-group">
            <p className="scenario-lab-current-title">当前场景</p>
            <ul>{directoryItem(scenario)}</ul>
          </section>}
          {visibleGroups.map((group) => {
            const category = group.category as ScenarioCategory;
            const expanded = queryText !== "" || expandedGroups.has(category);
            return <section key={category} className="scenario-lab-group">
              <button className="scenario-lab-group-toggle" type="button"
                data-testid={`scenario-group-${category}`} aria-expanded={expanded}
                onClick={() => toggleGroup(category)}>
                {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                <span className="scenario-lab-group-key">{category}</span>
                <span className="scenario-lab-group-title">{CATEGORY_META[category].title}</span>
                <span className="scenario-lab-group-count">
                  {filtering ? `${group.visible.length}/${group.scenarios.length}` : group.scenarios.length}
                </span>
              </button>
              <ul hidden={!expanded}>{group.visible.map(directoryItem)}</ul>
            </section>;
          })}
          {visibleTotal === 0 && <p className="scenario-lab-directory-empty">没有匹配的场景。调整搜索或筛选条件。</p>}
        </div>
      </nav>

      {overlayOpen && <button className="scenario-lab-scrim" type="button" aria-label="关闭面板"
        onClick={() => { setDirectoryOpen(false); setInspectorOpen(false); }} />}

      <div className="scenario-lab-stage" ref={stageRef}>
        <div className="scenario-lab-stage-head">
          {mode === "single"
            ? <div className="scenario-lab-stage-title">
              <span className="scenario-lab-stage-id">{scenario.id}</span>
              <h2>{scenario.title}</h2>
              <span className="scenario-lab-stage-kind">{scenario.stateKind}</span>
              <span className={`scenario-lab-stage-verdict scenario-lab-stage-verdict--${currentAcceptance}`}
                data-testid="scenario-current-verdict" data-acceptance={currentAcceptance}
                title={currentVerdict?.detail ?? ""}>
                {currentAcceptance === "static" && currentVerdict?.browserOnly
                  ? `静态通过 · ${String(currentVerdict.browserOnly)} 待浏览器`
                  : ACCEPTANCE_LABEL[currentAcceptance]}
              </span>
              {/* 窗口档是这一帧的呈现条件，属于「我在看什么」的一部分：收在检查面板里
                  意味着每次都要开一次面板才能确认。宽窗是默认档，不额外占位。 */}
              {viewport !== "wide" && <span className="scenario-lab-stage-window"
                data-testid="scenario-current-window"
                title="预览按这个窗口宽度渲染，阅读列仍走产品自己的规则">
                {VIEWPORTS.find((item) => item.value === viewport)?.label} {viewport === "narrow" ? "900" : "560"}px
              </span>}
            </div>
            : <div className="scenario-lab-stage-title">
              <span className="scenario-lab-stage-id">ALL</span>
              <h2>全部状态</h2>
              <span className="scenario-lab-stage-kind">{galleryGroup?.scenarios.length ?? 0} 条 · {CATEGORY_META[galleryFamily as ScenarioCategory]?.title}</span>
            </div>}
          <div className="scenario-lab-stage-actions">
            {mode === "single" && <button className="secondary-button" type="button" data-testid="scenario-next"
              aria-label="下一场景" title="下一场景" onClick={() => openScenario(nextScenario)}>
              <ChevronsRight aria-hidden="true" /><span className="scenario-lab-action-label">下一场景</span>
            </button>}
            <button className="secondary-button scenario-lab-inspector-toggle" type="button"
              data-testid="scenario-inspector-toggle" aria-expanded={inspectorOpen}
              aria-controls="scenario-lab-inspector" onClick={() => {
                setDirectoryOpen(false);
                setInspectorOpen((value) => !value);
              }}>
              <SlidersHorizontal aria-hidden="true" />
              <span className="scenario-lab-action-label">{inspectorOpen ? "收起检查" : "检查结果"}</span>
            </button>
          </div>
        </div>

        {mode === "single" && (isMultiFrame
          ? <aside className="scenario-lab-controls" aria-label="场景控制器">
            <div className="scenario-lab-transport">
              <button className="icon-button" type="button" data-testid="scenario-prev"
                aria-label="上一帧" title="上一帧" disabled={frame <= 0} onClick={previousFrame}>
                <SkipBack aria-hidden="true" />
              </button>
              <button className="primary-button scenario-lab-play" type="button" data-testid="scenario-play"
                aria-pressed={playing} aria-label={playing ? "暂停" : atLastFrame ? "重新播放" : "播放"}
                onClick={togglePlay}>
                {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                <span className="scenario-lab-play-label">
                  {playing ? "暂停" : atLastFrame ? "重新播放" : "播放"}
                </span>
              </button>
              <button className="icon-button" type="button" data-testid="scenario-step"
                aria-label="下一帧" title="下一帧" disabled={frame >= lastIndex(scenario)} onClick={nextFrame}>
                <SkipForward aria-hidden="true" />
              </button>
              <button className="icon-button" type="button" data-testid="scenario-reset"
                aria-label="重置" title="重置" onClick={resetPlayback}>
                <RotateCcw aria-hidden="true" />
              </button>
            </div>
            <div className="scenario-lab-progress">
              <input className="scenario-lab-seek" type="range" data-testid="scenario-seek"
                aria-label="事件进度，按帧跳转" min={0} max={lastIndex(scenario)} step={1} value={frame}
                style={{ "--scenario-progress": `${progressPercent}%` } as CSSProperties}
                onChange={(event) => seekTo(Number(event.target.value))} />
              <span className="scenario-lab-controls-head">
                第 {frame + 1}/{scenario.steps.length} 帧 · {currentStep?.at ?? 0}ms
              </span>
            </div>
            <div className="scenario-lab-playback-options">
              <Segmented group="播放速度" options={SPEEDS.map((value) => ({ value: String(value), label: `${value}×`,
                selected: speed === value, testId: `scenario-speed-${value}`, onSelect: () => setSpeed(value) }))} />
              <button className={`scenario-lab-loop${loop ? " scenario-lab-loop--active" : ""}`} type="button"
                data-testid="scenario-loop" aria-pressed={loop} aria-label="循环"
                title={loop ? "关闭循环" : "循环播放"} onClick={() => setLoop((value) => !value)}>
                <Repeat aria-hidden="true" />
              </button>
            </div>
          </aside>
          : <aside className="scenario-lab-controls scenario-lab-controls--static" aria-label="场景控制器">
            <div className="scenario-lab-static-mode">
              <span className="scenario-lab-static-badge" data-testid="scenario-static-preview">静态状态预览</span>
              <span className="scenario-lab-controls-head">第 1/1 帧 · {currentStep?.at ?? 0}ms</span>
              <button className="secondary-button" type="button" data-testid="scenario-check-again"
                onClick={recheckCurrent}>重新检查</button>
            </div>
          </aside>)}

        <div className="scenario-lab-preview-scroll" ref={previewScrollRef}>
          {mode === "single"
            // key 按场景身份走：预览里的组件有自己的读数状态（回过源没有、被人工开合过没有），
            // 不重挂就会把上一条场景的状态带进下一条，批次里读到的「不对」其实是「没换干净」。
            ? <div className={`scenario-lab-preview-canvas${isMultiFrame ? "" : " scenario-lab-preview-canvas--static"}`}
              data-static-preview={isMultiFrame ? undefined : "true"}>
              <ScenarioShell key={scenario.id} conditions={conditions}><ScenarioStage runner={runner} /></ScenarioShell>
              {!isMultiFrame && <div className="scenario-lab-static-strip" data-testid="scenario-static-strip">
                <div className="scenario-lab-static-copy">
                  {/* 「静态状态预览」这个标签上面那一条控制条已经写过一次了，这里只说这一条的说明。 */}
                  <strong>场景说明</strong>
                  <p>{scenario.note ?? "这一条只有单帧状态；没有可推进的后续帧，直接检查当前 UI。"}</p>
                </div>
                <button className="secondary-button" type="button" data-testid="scenario-static-open-inspector"
                  onClick={() => openInspector("verification")}>
                  <SlidersHorizontal aria-hidden="true" />查看检查结果
                </button>
              </div>}
            </div>
            : <div className="scenario-lab-gallery">
              <div className="scenario-lab-family-tabs" role="group" aria-label="按类别展示">
                {SCENARIO_GROUPS.map((group) => <button key={group.category} type="button"
                  className={`scenario-lab-family-tab${galleryFamily === group.category ? " scenario-lab-family-tab--active" : ""}`}
                  aria-pressed={galleryFamily === group.category} data-testid={`scenario-family-${group.category}`}
                  onClick={() => setGalleryFamily(group.category)}>
                  <span>{group.category}</span><small>{group.scenarios.length}</small>
                </button>)}
              </div>
              <div className="scenario-lab-gallery-grid">
                {galleryScenarios.map((item) => {
                  const acceptance = acceptanceOfScenario(item, latestVerdicts[item.id], latestStale);
                  return <article key={item.id} className="scenario-lab-card" data-scenario-card={item.id}
                    title={`${item.id} ${item.title}\n${item.stateKind} · ${item.component}`}>
                    <header className="scenario-lab-card-head">
                      <button className="scenario-lab-card-open" type="button" onClick={() => openScenario(item)}
                        title={`打开 ${item.id} 的单场景预览`}>
                        <span className="scenario-lab-card-id">{item.id}</span>
                        <span className="scenario-lab-card-title">{item.title}</span>
                        <ChevronRight aria-hidden="true" />
                      </button>
                      {/* 状态点跟标题同一行：它此前排在 meta 之后，被 flex-wrap 挤到第三行右侧，
                          看上去像浮在卡片中间的一颗孤立圆点。组件链是同一句话重复二十遍，
                          收进卡片的 title，需要时悬停可读。 */}
                      <span className="scenario-lab-card-state" data-acceptance={acceptance}
                        aria-label={`验收：${ACCEPTANCE_LABEL[acceptance]}`}
                        title={latestVerdicts[item.id]?.failures.join("\n") ?? item.note ?? ""} />
                      <span className="scenario-lab-card-meta">{item.stateKind}</span>
                    </header>
                    <div className="scenario-lab-card-preview">
                      <GalleryFrame scenario={item} conditions={conditions} />
                    </div>
                  </article>;
                })}
              </div>
            </div>}
        </div>
      </div>

      <aside id="scenario-lab-inspector" className="scenario-lab-inspector" aria-label="检查面板"
        data-open={inspectorOpen ? "true" : "false"}>
        <div className="scenario-lab-inspector-head">
          <div>
            <strong>检查面板</strong>
            <p>{mode === "single" ? `${scenario.id} ${scenario.title}` : "当前场景的展示设置与验收结果"}</p>
          </div>
          <button className="icon-button" type="button" data-testid="scenario-inspector-close"
            aria-label="关闭检查面板" onClick={() => setInspectorOpen(false)}><X aria-hidden="true" /></button>
        </div>
        <div className="scenario-lab-inspector-tabs" role="tablist" aria-label="检查内容">
          {INSPECTOR_TABS.map((tab) => <button key={tab.value} type="button" role="tab"
            data-testid={`scenario-inspector-tab-${tab.value}`} aria-selected={inspectorTab === tab.value}
            className={`scenario-lab-inspector-tab${inspectorTab === tab.value ? " scenario-lab-inspector-tab--active" : ""}`}
            onClick={() => setInspectorTab(tab.value)}>{tab.label}</button>)}
        </div>
        <div className="scenario-lab-inspector-body">
          {inspectorTab === "display" && <section className="scenario-lab-settings" aria-label="展示设置">
            <Field label="阅读密度">
              <Segmented group="阅读密度" options={(["concise", "standard", "detailed"] as const).map((value) => ({
                value, label: DENSITY_LABEL[value], selected: density.density === value,
                testId: `scenario-density-${value}`, onSelect: () => setDensity(value) }))} />
            </Field>
            <Field label="窗口宽度">
              <Segmented group="预览窗口宽度" options={VIEWPORTS.map((option) => ({
                value: option.value, label: option.label, selected: viewport === option.value,
                testId: `scenario-viewport-${option.value}`, onSelect: () => setViewport(option.value) }))} />
            </Field>
            <Field label="动效">
              <Segmented group="运行期动效" options={(["on", "off"] as const).map((value) => ({
                value, label: value === "on" ? "开启" : "关闭", selected: motionOn === (value === "on"),
                testId: `scenario-motion-${value}`,
                onSelect: () => { storeMotionPreference(value); setMotionOn(applyMotionPreference(value)); } }))} />
            </Field>
            <Field label="预览底色">
              <Segmented group="预览底色" options={[
                { value: "light", label: "浅色", selected: theme === "light", testId: "scenario-theme-light",
                  onSelect: () => setTheme("light") },
                { value: "dark", label: "暗色", selected: theme === "dark", testId: "scenario-theme-dark",
                  onSelect: () => setTheme("dark") }]} />
            </Field>
            <Field label="过程展开">
              <div className="scenario-lab-setting-actions">
                <button className="secondary-button" type="button" data-testid="scenario-expand-all"
                  onClick={() => toggleAll(true)}>展开所有</button>
                <button className="secondary-button" type="button" data-testid="scenario-collapse-all"
                  onClick={() => toggleAll(false)}>收起所有</button>
              </div>
            </Field>
            <p className="scenario-lab-setting-note">阅读密度与动效走产品自己的视图偏好，返回工作台时恢复为进入前的值。</p>
          </section>}

          {inspectorTab === "timeline" && <section aria-label="事件时间线">
            <ol className="scenario-lab-timeline">
              {scenario.steps.map((step, index) => <li key={`${step.at}-${index}`}>
                <button type="button" data-testid={`scenario-jump-${index}`}
                  className={index === frame ? "scenario-lab-timeline--now" : undefined}
                  aria-current={index === frame ? "step" : undefined}
                  onClick={() => seekTo(index)}>
                  <span className="scenario-lab-timeline-time">{step.at}ms</span>
                  <span className="scenario-lab-timeline-label">{step.label}</span>
                  <span className="scenario-lab-timeline-index">{index + 1}</span>
                </button>
              </li>)}
            </ol>
          </section>}

          {inspectorTab === "verification" && <section className="scenario-lab-verification" aria-label="验收结果">
            <div className="scenario-lab-run-summaries">
              <RunSummaryRow mode="static" run={runs.static} counts={staticCounts}
                stale={runs.static !== null && runs.static.identity !== SCENARIO_LAB_IDENTITY} />
              <RunSummaryRow mode="full" run={runs.full} counts={fullCounts}
                stale={runs.full !== null && runs.full.identity !== SCENARIO_LAB_IDENTITY} />
            </div>

            <div className="scenario-lab-current-result" data-testid="scenario-current-result">
              <div className="scenario-lab-verdict">
                <span className="scenario-lab-verdict-state" data-acceptance={currentAcceptance}>
                  {ACCEPTANCE_LABEL[currentAcceptance]}
                </span>
                {currentVerdict !== undefined && <span>
                  静态 {currentVerdict.passedChecks}/{currentVerdict.totalChecks}
                  {currentVerdict.failedChecks > 0 && ` · 失败 ${currentVerdict.failedChecks}`}
                  {currentVerdict.browserOnly > 0 && ` · 待浏览器 ${currentVerdict.browserOnly}`}
                  {currentVerdict.interactionsRun > 0 && ` · 交互 ${currentVerdict.interactionsRun}`}
                </span>}
                {currentVerdict === undefined && <span>当前场景还没有可信的检查结果</span>}
              </div>
              {currentVerdict !== undefined && <p className="scenario-lab-verdict-note">{currentVerdict.detail}</p>}
              {currentStale && <p className="scenario-lab-verdict-alert">这份结果来自旧场景定义，已过期；请重新运行。</p>}
              {currentVerdict?.mode === "full" && currentVerdict.interactionsRun > 0 &&
                <p className="scenario-lab-verdict-note">
                  已按顺序重放帧并执行 {currentVerdict.interactionsRun} 条交互；上滚稳定性等浏览器专属检查仍由 Playwright 判定。
                </p>}
              {scenario.uncovered !== undefined && <p className="scenario-lab-verdict-alert">无法覆盖：{scenario.uncovered}</p>}
              {scenario.note !== undefined && <p className="scenario-lab-verdict-note">{scenario.note}</p>}
              <button className="secondary-button scenario-lab-run-current" type="button"
                data-testid="scenario-run-current-full" disabled={runRunning}
                onClick={runCurrentFull}>
                <SkipForward aria-hidden="true" />完整验收当前场景
              </button>
            </div>

            <ul className="scenario-lab-results">
              {currentResults.map((item, index) => <li key={`${index}-${item.label}-${item.status}`} data-status={item.status}>
                <span>{item.label}</span>
                {item.status === "fail" && <small>{item.detail}</small>}
                {item.status === "browser-only" && <small>{item.detail}</small>}
              </li>)}
              {currentResults.length === 0 && <li><span>还没有跑过断言。</span></li>}
            </ul>
            <details className="scenario-lab-data-details">
              <summary>原始状态数据</summary>
              {/* 直接 dump 这一帧的模拟世界：画上那一行和这里读到那一条必须是同一份对象。 */}
              <pre className="scenario-lab-data">{JSON.stringify(runner.world, null, 2)}</pre>
            </details>
          </section>}
        </div>
      </aside>
    </div>
  </section>;
}

function RunSummaryRow({ mode, run, counts, stale }: {
  readonly mode: LabRunMode;
  readonly run: LabRunRecord | null;
  readonly counts: LabRunCounts;
  readonly stale: boolean;
}): ReactElement {
  const title = mode === "static" ? "快速静态检查" : "完整场景验收";
  const status = run === null ? "未运行"
    : stale ? "证据已过期"
      : run.status === "running" ? "运行中"
        : run.status === "cancelled" ? "已取消" : "已完成";
  const scope = run?.scope === "current" ? "当前场景" : "全部场景";
  const duration = run === null || run.status === "running" ? "—"
    : run.durationMs < 1_000 ? `${String(run.durationMs)}ms`
      : `${(run.durationMs / 1_000).toFixed(1)}s`;
  return <div className={`scenario-lab-run-summary${stale ? " scenario-lab-run-summary--stale" : ""}`}
    data-testid={`scenario-run-summary-${mode}`} data-status={run?.status ?? "none"}
    data-stale={stale ? "true" : "false"} data-pass={counts.pass}
    data-static-pass={counts.staticPass} data-fail={counts.fail}
    data-pending-browser={counts.pendingBrowser} data-unverifiable={counts.unverifiable}
    data-not-run={counts.notRun} data-done={run?.done ?? 0} data-total={run?.total ?? 0}
    data-interactions={run?.interactionsRun ?? 0}>
    <div className="scenario-lab-run-summary-head">
      <strong>{title}</strong>
      <span className="scenario-lab-run-summary-status">{status}</span>
    </div>
    <p className="scenario-lab-run-summary-meta">
      {run === null ? "还没有运行过这一类检查"
        : `${scope} · ${String(run.done)}/${String(run.total)} · 耗时 ${duration}`
          + (run.status === "cancelled" && run.cancelledReason ? ` · ${run.cancelledReason}` : "")}
    </p>
    <div className="scenario-lab-run-summary-counts">
      {/* 没跑过就只留一句「还没有运行过」：七项全零排成两行，读起来像结果，
          实际上什么都没测。data-* 计数属性照旧留在容器上，机器读的一直是那些。 */}
      {run === null ? <span className="scenario-lab-run-summary-empty">还没有结果</span> : <>
        <span>全部通过 <strong>{counts.pass}</strong></span>
        <span>静态通过 <strong>{counts.staticPass}</strong></span>
        <span>失败 <strong>{counts.fail}</strong></span>
        <span>待浏览器 <strong>{counts.pendingBrowser}</strong></span>
        <span>无法验证 <strong>{counts.unverifiable}</strong></span>
        <span>无法覆盖 <strong>{counts.notCovered}</strong></span>
        <span>未运行 <strong>{counts.notRun}</strong></span>
        {counts.stale > 0 && <span>证据过期 <strong>{counts.stale}</strong></span>}
      </>}
    </div>
    {stale && <p className="scenario-lab-verdict-alert">场景定义已变化，这组结果不再计入通过；请重新运行。</p>}
  </div>;
}

function Field({ label, children }: { readonly label: string;
  readonly children: ReactNode }): ReactElement {
  return <div className="scenario-lab-field"><span className="scenario-lab-field-label">{label}</span>{children}</div>;
}

interface Segment {
  readonly value: string;
  readonly label: string;
  readonly selected: boolean;
  readonly testId: string;
  readonly onSelect: () => void;
}

function Segmented({ group, options }: { readonly group: string;
  readonly options: readonly Segment[] }): ReactElement {
  return <div className="segmented" role="group" aria-label={group}>
    {options.map((option) => <button key={option.value} type="button" data-testid={option.testId}
      className={`segmented-option${option.selected ? " segmented-option--selected" : ""}`}
      aria-pressed={option.selected} onClick={option.onSelect}>{option.label}</button>)}
  </div>;
}

/**
 * 「展示全部状态」里的一张卡：独立回放器停在最后一帧。
 *
 * 卡片不接控制器——一次挂几十条，播放只有一条有意义；要交互就点卡片头回到单场景模式。
 */
function GalleryFrame({ scenario, conditions }: { readonly scenario: Scenario;
  readonly conditions: { readonly theme: "light" | "dark"; readonly viewport: Viewport; readonly motion?: "off" };
}): ReactElement {
  const runner = useMemo(() => {
    const instance = new ScenarioRunner(scenario);
    instance.seek(scenario.steps.length - 1);
    return instance;
  }, [scenario]);
  return <ScenarioShell conditions={conditions}><ScenarioStage runner={runner} /></ScenarioShell>;
}
