import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type ReactElement, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { ArrowLeft, ListChecks, Pause, Play } from "lucide-react";
import { useActivityDensity } from "../lib/activityDensity";
import {
  applyMotionPreference, resolveMotionPreference, storeMotionPreference, storedMotionPreference
} from "../lib/motionPreference";
import { BROWSER_ONLY_KINDS, browserOnlyCount, failedResults, runChecks, type CheckResult } from "./scenarioChecks";
import { ScenarioShell, ScenarioStage } from "./scenarioHost";
import { ALL_SCENARIOS, SCENARIO_GROUPS } from "./scenarios";
import { CATEGORY_META, ScenarioRunner, type Scenario, type ScenarioAcceptance } from "./scenarioWorld";
import "./ScenarioLab.css";

/**
 * AI 回复场景实验室（仅开发构建）。
 *
 * 三栏：左边目录（点一条切一条），中间是**真实产品组件**的预览列，右边是控制器与检查结果。
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

const SPEEDS: readonly Speed[] = [0.5, 1, 2];
const VIEWPORTS: readonly { readonly value: Viewport; readonly label: string }[] = [
  { value: "wide", label: "宽窗" }, { value: "narrow", label: "窄窗" }, { value: "phone", label: "手机宽" }
];
const DENSITY_LABEL = { concise: "简洁", standard: "标准", detailed: "详细" } as const;
/** 虚拟时钟每跳一次推进的真实毫秒；帧由 steps 的绝对时刻决定，不等真实网络。 */
const TICK_MS = 40;
/** 一帧落地后最多等多久算「界面停稳」；超时就照实测结果报告，不再等。 */
const SETTLE_TIMEOUT_MS = 2_500;

interface Verdict {
  readonly acceptance: ScenarioAcceptance;
  readonly passed: number;
  readonly failures: readonly string[];
  readonly browserOnly: number;
}

const ACCEPTANCE_LABEL: Readonly<Record<ScenarioAcceptance, string>> = {
  unchecked: "未跑", pass: "通过", fail: "失败", "not-covered": "未覆盖"
};

function verdictOf(scenario: Scenario, results: readonly CheckResult[], hasRoot: boolean): Verdict {
  if (scenario.uncovered !== undefined) {
    return { acceptance: "not-covered", passed: 0, failures: [scenario.uncovered], browserOnly: 0 };
  }
  // 选不到预览根等于「什么都没验」：绝不能让空集合把没渲染读成断言通过。
  if (!hasRoot) return { acceptance: "fail", passed: 0, failures: ["预览区没挂到这一条场景（或等停稳超时），断言无处可跑"], browserOnly: 0 };
  const failures = failedResults(results).map((item) => `${item.label}：${item.detail}`);
  return { acceptance: failures.length > 0 ? "fail" : "pass",
    passed: results.length - failures.length, failures, browserOnly: browserOnlyCount(results) };
}

const lastIndex = (scenario: Scenario): number => scenario.steps.length - 1;

/**
 * 让出若干个宏任务：React 提交与组件的异步回填各占一次。
 *
 * 不用 `requestAnimationFrame`：窗口不可见时（后台标签、被遮住的桌面窗口）rAF 根本不回调，
 * 实验室会停在「等一帧」上永远不报结果。宏任务计时在两种情况下都能往前走。
 */
async function yieldFrames(count = 3): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
  }
}

/**
 * 场景清单（写进 DOM 的那一份 JSON）。
 *
 * 浏览器批次需要「有哪些条、每条几帧、哪几条断言只能在真实布局下量」，
 * 但我不想为测试另开一条只有 Playwright 认的私有接口：清单就是这一页已经知道的事实，
 * 原样落在 `script[type=application/json]` 里，人和机器读的都是同一份，不会有两套口径。
 */
function manifest(): ReactElement {
  return <script id="scenario-lab-manifest" type="application/json">{JSON.stringify(
    ALL_SCENARIOS.map((item) => ({
      id: item.id,
      title: item.title,
      stateKind: item.stateKind,
      host: item.host,
      component: item.component,
      frames: item.steps.map((step) => ({ at: step.at, label: step.label })),
      browserOnly: item.checks.filter((check) => BROWSER_ONLY_KINDS.includes(check.kind)).map((check) => check.label),
      interactions: (item.interactions ?? []).length,
      uncovered: item.uncovered ?? null,
      conditions: item.conditions ?? null
    })))}</script>;
}

export default function ScenarioLabView(): ReactElement {
  const [query, setQuery] = useSearchParams();
  const location = useLocation();
  /**
   * 「返回工作台」回**进入本页之前**那一页（外壳把 path+search 放进 `location.state.from`）。
   * 深链或刷新后 state 已丢，回默认工作台 `/agent`；若来源本身就是实验室（在页内再点一次侧栏），不记来源，
   * 免得返回时原地打转。
   */
  const backTo = (location.state as { from?: string } | null)?.from ?? "/agent";
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
  const [mode, setMode] = useState<"single" | "gallery">("single");
  const [galleryFamily, setGalleryFamily] = useState<string>(() => scenario.id.charAt(0));
  const [verdicts, setVerdicts] = useState<Readonly<Record<string, Verdict>>>({});
  const [results, setResults] = useState<readonly CheckResult[]>([]);
  const [batch, setBatch] = useState<{ readonly running: boolean; readonly done: number }>({ running: false, done: 0 });

  const stageRef = useRef<HTMLDivElement | null>(null);
  const elapsedRef = useRef(0);
  const scenarioRef = useRef(scenario);
  scenarioRef.current = scenario;
  const runnersRef = useRef(new Map<string, ScenarioRunner>());

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

  /** 打开一条场景时自动施加它声明的呈现条件；入口都是产品自己的，不是实验室私设。 */
  const openScenario = useCallback((next: Scenario, frameIndex = 0) => {
    setPlaying(false);
    setMode("single");
    setScenario(next);
    scenarioRef.current = next;
    const instance = runnerFor(next);
    elapsedRef.current = next.steps[frameIndex]?.at ?? 0;
    instance.seek(frameIndex);
    setResults([]);
    applyConditions(next);
    setGalleryFamily(next.id.charAt(0));
    const merged = new URLSearchParams(query);
    merged.set("scenario", next.id);
    setQuery(merged, { replace: true });
  }, [applyConditions, query, runnerFor, setQuery]);

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

  /**
   * 等预览自己停稳，再跑断言。
   *
   * 推进一帧后组件还要走一次异步读取（真实 hook 的那一条），DOM 因此可能滞后一帧：
   * 立刻测量会把「还没重画」读成「界面不对」。批量切到下一条时还可能先读到上一条的残留，
   * 所以这里同时等两件事：外壳挂的是**这一条**场景，且正文连续两次读数一致。
   * 只等，不改断言、不重试取最好看的一次——等不到就照「无处可测」报告。
   */
  const settlePreview = useCallback(async (token: { cancelled: boolean },
    expectedId: string): Promise<HTMLElement | null> => {
    await yieldFrames();
    let previous = "";
    let stable = 0;
    const started = Date.now();
    while (!token.cancelled && Date.now() - started < SETTLE_TIMEOUT_MS) {
      await new Promise((resolve) => window.setTimeout(resolve, 80));
      const root = previewRoot();
      if (root === null) continue;
      if (root.querySelector("[data-scenario-id]")?.getAttribute("data-scenario-id") !== expectedId) {
        stable = 0; previous = "";
        continue;
      }
      const text = root.textContent ?? "";
      stable = text === previous ? stable + 1 : 0;
      previous = text;
      if (stable >= 2) break;
    }
    const root = previewRoot();
    return root !== null && root.querySelector("[data-scenario-id]")?.getAttribute("data-scenario-id") === expectedId
      ? root : null;
  }, []);

  const record = useCallback((item: Scenario, root: HTMLElement | null): void => {
    const found = runChecks(root ?? document.createElement("div"), item.checks);
    setResults(found);
    setVerdicts((current) => ({ ...current, [item.id]: verdictOf(item, found, root !== null) }));
  }, []);

  // 静态断言的定义位置就是最后一帧：播到最后一帧顺手跑一次，目录里的验收状态才是真跑出来的。
  useEffect(() => {
    if (mode !== "single" || batch.running) return;
    if (runner.index !== lastIndex(scenario)) return;
    const token = { cancelled: false };
    void (async () => {
      const root = await settlePreview(token, scenario.id);
      if (!token.cancelled) record(scenario, root);
    })();
    return () => { token.cancelled = true; };
  }, [batch.running, mode, runner, scenario, seq, record, settlePreview]);

  const runAll = useCallback(async () => {
    setPlaying(false);
    setMode("single");
    setBatch({ running: true, done: 0 });
    const collected: Record<string, Verdict> = {};
    const token = { cancelled: false };
    for (let index = 0; index < ALL_SCENARIOS.length; index += 1) {
      if (token.cancelled) return;
      const item = ALL_SCENARIOS[index] as Scenario;
      setScenario(item);
      scenarioRef.current = item;
      applyConditions(item);
      const instance = runnerFor(item);
      // 先在第 0 帧挂稳，再跳到最后一帧：X28/X31 这一类不变量说的是「先见过，后一次返回空也不能抹掉」，
      // 直接落在最后一帧，组件从没拿到过前一次的读回，界面「没有那一行」就成了测量的假阴性。
      instance.seek(0);
      await settlePreview(token, item.id);
      instance.seek(lastIndex(item));
      const root = await settlePreview(token, item.id);
      collected[item.id] = verdictOf(item, runChecks(root ?? document.createElement("div"), item.checks), root !== null);
      setVerdicts({ ...collected });
      setBatch({ running: true, done: index + 1 });
    }
    setBatch({ running: false, done: ALL_SCENARIOS.length });
  }, [applyConditions, runnerFor, settlePreview]);

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
    const values = Object.values(verdicts);
    const lines = ["# AI 回复场景实验室 · 验收结果", "",
      `共 ${ALL_SCENARIOS.length} 条：通过 ${values.filter((v) => v.acceptance === "pass").length}、`
      + `失败 ${values.filter((v) => v.acceptance === "fail").length}、`
      + `未覆盖 ${values.filter((v) => v.acceptance === "not-covered").length}、`
      + `未跑 ${ALL_SCENARIOS.length - Object.keys(verdicts).length}`, "",
      "| 场景 | 名称 | 状态类型 | 组件位置 | 结果 | 失败原因 |", "|---|---|---|---|---|---|"];
    for (const item of ALL_SCENARIOS) {
      const verdict = verdicts[item.id];
      lines.push(`| ${item.id} | ${item.title} | ${item.stateKind} | ${item.component} | `
        + `${verdict === undefined ? "未跑" : ACCEPTANCE_LABEL[verdict.acceptance]} | `
        + `${verdict?.failures.join("；") ?? ""} |`);
    }
    lines.push("", "> 静态断言在第 0 帧挂稳后跳到最后一帧执行；需要真实布局或动画读数的检查由浏览器批次判定，不在此处冒充通过。",
      "> 截图与浏览器判定结果见 `results/scenario-lab/`（Playwright 批次）。");
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "scenario-lab-report.md";
    link.click();
    URL.revokeObjectURL(url);
  }, [verdicts]);

  // 帧号直接从回放器读：它才是唯一事实，控制器不再存一份副本，两处不会走偏。
  const frame = runner.index;
  const currentStep = scenario.steps[frame] ?? scenario.steps[0];
  const nextScenario = ALL_SCENARIOS[(ALL_SCENARIOS.indexOf(scenario) + 1) % ALL_SCENARIOS.length] as Scenario;
  const currentVerdict = verdicts[scenario.id];
  const conditions = { theme, viewport, ...(motionOn ? {} : { motion: "off" as const }) };
  const counts = { pass: Object.values(verdicts).filter((v) => v.acceptance === "pass").length,
    fail: Object.values(verdicts).filter((v) => v.acceptance === "fail").length };

  return <section className="scenario-lab-page pv-page" data-scenario-lab="true">
    {manifest()}
    <header className="scenario-lab-head">
      <div>
        <Link className="scenario-lab-back text-link" to={backTo} data-testid="scenario-back-to-workbench"
          title="回到进入实验室之前的页面">
          <ArrowLeft aria-hidden="true" />{backLabel}</Link>
        <h1>AI 回复场景实验室</h1>
        <p className="helper-text">仅开发构建。中间一列是产品自己的回复组件，读的是内存里的模拟世界：
          不写业务库、不调模型、不执行命令，也不产生真实审批。</p>
      </div>
      <div className="scenario-lab-head-actions">
        <div className="segmented" role="group" aria-label="实验室模式">
          {(["single", "gallery"] as const).map((option) => <button key={option} type="button"
            className={`segmented-option${mode === option ? " segmented-option--selected" : ""}`}
            aria-pressed={mode === option} data-testid={`scenario-mode-${option}`}
            onClick={() => setMode(option)}>{option === "single" ? "逐条播放" : "展示全部状态"}</button>)}
        </div>
        <button className="primary-button" type="button" data-testid="scenario-run-all" disabled={batch.running}
          onClick={() => { void runAll(); }}>
          {batch.running ? `运行中 ${batch.done}/${ALL_SCENARIOS.length}` : "运行全部场景"}</button>
        <button className="secondary-button" type="button" data-testid="scenario-export-report"
          onClick={exportReport}>导出验收报告</button>
      </div>
    </header>

    <div className="scenario-lab-body">
      <nav className="scenario-lab-directory" aria-label="场景目录">
        <p className="scenario-lab-directory-summary">共 {ALL_SCENARIOS.length} 条 ·
          通过 {counts.pass} · 失败 {counts.fail}</p>
        {SCENARIO_GROUPS.map((group) => <section key={group.category} className="scenario-lab-group">
          <h2>{group.category} · {CATEGORY_META[group.category].title}
            <span className="scenario-lab-group-count">{group.scenarios.length}</span></h2>
          <ul>
            {group.scenarios.map((item) => {
              const verdict = verdicts[item.id];
              const acceptance: ScenarioAcceptance = item.uncovered !== undefined && verdict === undefined
                ? "not-covered" : verdict?.acceptance ?? "unchecked";
              return <li key={item.id}>
                <button type="button" data-testid={`scenario-pick-${item.id}`}
                  className={`scenario-lab-item${item.id === scenario.id ? " scenario-lab-item--active" : ""}`}
                  aria-current={item.id === scenario.id ? "page" : undefined} onClick={() => openScenario(item)}>
                  <span className="scenario-lab-item-id">{item.id}</span>
                  <span className="scenario-lab-item-title">{item.title}</span>
                  <span className="scenario-lab-item-kind">{item.stateKind}</span>
                  <span className="scenario-lab-item-state" data-acceptance={acceptance}
                    title={verdict?.failures.join("\n") ?? item.note ?? ""}>{ACCEPTANCE_LABEL[acceptance]}</span>
                </button>
              </li>;
            })}
          </ul>
        </section>)}
      </nav>

      <div className="scenario-lab-stage" ref={stageRef}>
        {mode === "single"
          // key 按场景身份走：预览里的组件有自己的读数状态（回过源没有、被人工开合过没有），
          // 不重挂就会把上一条场景的状态带进下一条，批次里读到的「不对」其实是「没换干净」。
          ? <ScenarioShell key={scenario.id} conditions={conditions}><ScenarioStage runner={runner} /></ScenarioShell>
          : <div className="scenario-lab-gallery">
            <div className="segmented" role="group" aria-label="按类别展示">
              {SCENARIO_GROUPS.map((group) => <button key={group.category} type="button"
                className={`segmented-option${galleryFamily === group.category ? " segmented-option--selected" : ""}`}
                aria-pressed={galleryFamily === group.category} data-testid={`scenario-family-${group.category}`}
                onClick={() => setGalleryFamily(group.category)}>{group.category}</button>)}
            </div>
            {SCENARIO_GROUPS.filter((group) => group.category === galleryFamily)
              .flatMap((group) => group.scenarios).map((item) => <article key={item.id}
                className="scenario-lab-card" data-scenario-card={item.id}>
                <header>
                  <strong>{item.id} {item.title}</strong>
                  <span className="helper-text">{item.stateKind} · {item.component}</span>
                  <button className="text-link" type="button" onClick={() => openScenario(item)}>单独播放</button>
                </header>
                <GalleryFrame scenario={item} conditions={conditions} />
              </article>)}
          </div>}
      </div>

      <aside className="scenario-lab-controls" aria-label="场景控制器">
        <div className="scenario-lab-controls-head">
          <strong>{scenario.id} {scenario.title}</strong>
          <p className="helper-text">第 {frame + 1}/{scenario.steps.length} 帧 · 虚拟时刻 {currentStep?.at ?? 0}ms</p>
        </div>

        <div className="scenario-lab-transport">
          <button className="primary-button" type="button" data-testid="scenario-play" aria-pressed={playing}
            onClick={() => setPlaying((value) => !value)}>
            {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{playing ? "暂停" : "播放"}</button>
          <button className="secondary-button" type="button" data-testid="scenario-step"
            disabled={frame >= lastIndex(scenario)} onClick={() => { setPlaying(false); runner.next(); }}>单步</button>
          <button className="secondary-button" type="button" data-testid="scenario-reset"
            onClick={() => { setPlaying(false); elapsedRef.current = 0; runner.reset(); }}>重置</button>
          <button className="secondary-button" type="button" data-testid="scenario-next"
            onClick={() => openScenario(nextScenario)}>下一场景</button>
          <label className="scenario-lab-check"><input type="checkbox" checked={loop} data-testid="scenario-loop"
            onChange={(event) => setLoop(event.target.checked)} />循环播放</label>
        </div>

        <Field label="速度">
          <Segmented group="播放速度" options={SPEEDS.map((value) => ({ value: String(value), label: `${value}×`,
            selected: speed === value, testId: `scenario-speed-${value}`, onSelect: () => setSpeed(value) }))} />
        </Field>
        <Field label="过程展开">
          <button className="secondary-button" type="button" data-testid="scenario-expand-all"
            onClick={() => toggleAll(true)}>展开所有</button>
          <button className="secondary-button" type="button" data-testid="scenario-collapse-all"
            onClick={() => toggleAll(false)}>收起所有</button>
        </Field>
        <Field label="阅读密度">
          <Segmented group="阅读密度" options={(["concise", "standard", "detailed"] as const).map((value) => ({
            value, label: DENSITY_LABEL[value], selected: density.density === value,
            testId: `scenario-density-${value}`, onSelect: () => setDensity(value) }))} />
        </Field>
        <Field label="动效">
          <Segmented group="运行期动效" options={(["on", "off"] as const).map((value) => ({
            value, label: value === "on" ? "开启" : "关闭", selected: motionOn === (value === "on"),
            testId: `scenario-motion-${value}`,
            onSelect: () => { storeMotionPreference(value); setMotionOn(applyMotionPreference(value)); } }))} />
        </Field>
        <Field label="窗口宽度">
          <Segmented group="预览窗口宽度" options={VIEWPORTS.map((option) => ({
            value: option.value, label: option.label, selected: viewport === option.value,
            testId: `scenario-viewport-${option.value}`, onSelect: () => setViewport(option.value) }))} />
        </Field>
        <Field label="预览底色">
          <Segmented group="预览底色" options={[
            { value: "light", label: "浅色", selected: theme === "light", testId: "scenario-theme-light",
              onSelect: () => setTheme("light") },
            { value: "dark", label: "暗色", selected: theme === "dark", testId: "scenario-theme-dark",
              onSelect: () => setTheme("dark") }]} />
        </Field>

        {scenario.note !== undefined && <p className="scenario-lab-note">{scenario.note}</p>}
        {scenario.uncovered !== undefined && <p className="action-error" role="alert">未覆盖：{scenario.uncovered}</p>}

        <section className="scenario-lab-panel" aria-label="事件序列">
          <h2><ListChecks aria-hidden="true" /> 事件序列</h2>
          <ol className="scenario-lab-steps">
            {scenario.steps.map((step, index) => <li key={`${step.at}-${index}`}>
              <button type="button" data-testid={`scenario-jump-${index}`}
                className={index === frame ? "scenario-lab-steps--now" : undefined}
                onClick={() => { setPlaying(false); elapsedRef.current = step.at; runner.seek(index); }}>
                <span>{step.at}ms</span>{step.label}</button>
            </li>)}
          </ol>
        </section>

        <details className="scenario-lab-panel">
          <summary>实际状态数据</summary>
          {/* 直接 dump 这一帧的模拟世界：画上那一行和这里读到那一条必须是同一份对象。 */}
          <pre className="scenario-lab-data">{JSON.stringify(runner.world, null, 2)}</pre>
        </details>

        <section className="scenario-lab-panel" aria-label="断言结果">
          <h2>断言结果 {currentVerdict !== undefined && ACCEPTANCE_LABEL[currentVerdict.acceptance]}</h2>
          {currentVerdict !== undefined && currentVerdict.browserOnly > 0 &&
            <p className="helper-text">另有 {currentVerdict.browserOnly} 条需要真实布局或动画读数，由浏览器批次判定。</p>}
          <ul className="scenario-lab-results">
            {results.map((item) => <li key={`${item.label}-${item.status}`} data-status={item.status}>
              <span>{item.label}</span>
              {item.status === "fail" && <small>{item.detail}</small>}
            </li>)}
            {results.length === 0 && <li><span>播到最后一帧后自动跑一次静态断言。</span></li>}
          </ul>
        </section>
      </aside>
    </div>
  </section>;
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
 * 卡片不接控制器——一次挂几十条，播放只有一条有意义；要交互就点「单独播放」回到单帧模式。
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
