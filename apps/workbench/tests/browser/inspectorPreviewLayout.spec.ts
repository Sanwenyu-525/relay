import { expect, test, type Page, type Route } from "@playwright/test";

// 2026-10-17 点击后界面定向验收（2026-10-16）整改 CT-01 的容器几何核对与回归矩阵。
// 缺陷现场（步骤 02 / 19）：任务会话打开工作详情或文件预览后，右侧面板把中栏挤窄，
// 会话工具栏的「新建会话 / 任务视图 / 工作详情」互相重叠或被面板盖住，
// 发送键落进被遮挡的内容里而界面仍写着「不影响协作」。
// 修复后的规则：容器够宽时面板是常驻分栏（无遮罩、不抢焦点、Esc 不关），
// 容器放不下时是覆盖抽屉（可见遮罩 + 关闭键 + Esc + 点按遮罩；焦点进抽屉、关后回触发键）。
// 判断依据是主区容器宽度而不是视口宽度：1162×782 的窗口里主区只有约 900px。
// 覆盖：1162×782 / 1000×800 / 860×800 × 近期工作栏展开/收起 × 无详情 / 工作详情 / 文件预览。
// 只连页面内夹具：不连数据库、不调 Provider、不写任何真实业务事实。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const artifactId = "88888888-8888-4888-8888-888888888888";
const artifactVersionV1 = "v1";
const artifactVersionV2 = "v2";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

/** 任务作用域的一条空会话：与 2026-10-16 验收现场一致（欢迎页 + 工具栏并存）。 */
const emptySession = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
  title: "关于确定实验评价指标（很长很长的会话标题，用来核对截断与完整值）", status: "ACTIVE", revision: "1",
  working_resource_id: "99999999-9999-4999-8999-999999999999",
  context: { project_goals: [], working_directory: {
    resource_id: "99999999-9999-4999-8999-999999999999", canonical_root: "D:\\Work\\Research" } },
  created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" };

const artifacts = { current_accepted_version_ids: [], items: [{ id: artifactId, task_id: taskId,
  project_id: projectId, title: "截图种子产物.md", revision: "2", latest_version_id: artifactVersionV2,
  version_count: 2,
  versions: [artifactVersionV1, artifactVersionV2].map((id) => ({ artifact_version_id: id,
    version_number: id === artifactVersionV1 ? "1" : "2", media_type: "text/markdown",
    sha256: id.repeat(64), size: "77", source_kind: "HUMAN", created_at: "2026-10-16T11:14:58Z" })) }] };

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, { id: taskId, project_id: projectId,
      title: "桌面端验收 · 中文详情与条件编辑", status: "IN_PROGRESS", mode: "ME",
      revision: "2", created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" },
      current_completion_id: null, waiting_reason: null, blocking_task_ids: [],
      unresolved_blocker_ids: [], allowed_actions: [],
      acceptance: { acceptance_revision: "2", objective: "补齐基线与验收依据。", source: "CREATE",
        created_at: "2026-10-16T00:00:00Z", criteria: [] },
      dependencies: [] });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "Windows 桌面验收（测试）", project_type: "GENERAL", revision: "1", state_revision: "1",
      archived_at: null });
    if (path === `${prefix}/tasks/${taskId}/artifacts`) return fulfillJson(route, artifacts);
    if (path === `${prefix}/artifact-versions/${artifactVersionV1}/content`
      || path === `${prefix}/artifact-versions/${artifactVersionV2}/content`) {
      const version = path.includes(artifactVersionV1) ? "1" : "2";
      return route.fulfill({ status: 200, contentType: "text/markdown; charset=utf-8", headers: cors(),
        body: `# 截图种子产物 v${version}\n\n这是第 ${version} 版的正文。` });
    }
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [emptySession] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, emptySession);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, { items: [] });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("ct01-geometry-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }

/** 几何采样：按钮矩形、容器宽、覆盖关系、可点性与横向溢出。 */
async function measure(page: Page, state: string) {
  return page.evaluate((stateName: string) => {
    const box = (node: Element | null): Box | null => {
      if (node === null) return null;
      const rect = node.getBoundingClientRect();
      return { left: Math.round(rect.left * 10) / 10, top: Math.round(rect.top * 10) / 10,
        right: Math.round(rect.right * 10) / 10, bottom: Math.round(rect.bottom * 10) / 10,
        width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 };
    };
    const overlap = (a: Box | null, b: Box | null): number => {
      if (a === null || b === null) return 0;
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return width > 0 && height > 0 ? Math.round(width * height) : 0;
    };
    const label = (node: Element | null): string => {
      if (node === null) return "none";
      const testId = node.getAttribute("data-testid");
      if (testId !== null && testId !== "") return testId;
      if (typeof node.className === "string" && node.className !== "") return node.className.split(/\s+/u)[0] ?? node.tagName;
      return node.tagName.toLowerCase();
    };
    const hitAt = (x: number, y: number): string => {
      const point = document.elementFromPoint(x, y);
      return point === null ? "no-element" : label(point);
    };
    const hitTest = (node: Element | null): string => {
      if (node === null) return "missing";
      const rect = node.getBoundingClientRect();
      const point = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (point === null) return "no-element";
      return node.contains(point) ? "self" : `covered-by:${label(point)}`;
    };
    const query = (selector: string) => document.querySelector(selector);
    const main = query(".collab-main");
    const columns = query(".collab-columns");
    const center = query('[data-testid="collab-center"]');
    const toolbar = query('[data-testid="collab-conversation-toolbar"]');
    const rightWing = query(".collab-toolbar-right");
    const taskView = query('[data-testid="collab-open-task-view"]');
    const inspectorToggle = query('[data-testid="collab-conversation-inspector-toggle"]');
    const inspector = query('[data-testid="collab-inspector"]');
    const inspectorClose = query('[data-testid="collab-inspector-close"]');
    const scrim = query('[data-testid="collab-inspector-scrim"]');
    const sessionName = query('[data-testid="collab-session-title"]');
    const send = query('[data-testid="assist-send"]');
    const draft = query('[data-testid="assist-draft"]');
    const root = document.scrollingElement as HTMLElement;
    const inspectorStyle = inspector === null ? null : getComputedStyle(inspector);
    const columnsStyle = columns === null ? null : getComputedStyle(columns);
    const columnsBox = box(columns);
    // 主区左下角：抽屉态必须被遮罩盖住，分栏态不该出现遮罩（面板贴右缘，够不到这一点）。
    // 取样避开左缘 28px：会话栏拖拽手柄宽 control-target-minimum(24px) 且居中对齐列边界，
    // 有 12px 命中区伸进主区，它按设计留在遮罩之上（与顶栏同理，抽屉不该吃掉唯一的改宽入口）。
    const chatCorner = columnsBox === null
      ? "no-columns" : hitAt(columnsBox.left + 28, columnsBox.bottom - 8);
    return {
      state: stateName,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      mainWidth: main === null ? null : Math.round(main.getBoundingClientRect().width),
      columns: { layoutMode: columns?.getAttribute("data-layout-mode") ?? null,
        display: columnsStyle?.display ?? null,
        gridTemplateColumns: columnsStyle?.gridTemplateColumns ?? null,
        box: columnsBox },
      center: box(center),
      toolbar: box(toolbar),
      rightWing: box(rightWing),
      taskView: box(taskView),
      inspectorToggle: box(inspectorToggle),
      sessionName: box(sessionName),
      send: box(send),
      draft: box(draft),
      overlaps: {
        taskViewInspectorToggle: overlap(box(taskView), box(inspectorToggle)),
        sessionNameRightWing: overlap(box(sessionName), box(rightWing)),
        inspectorTaskView: overlap(box(inspector), box(taskView)),
        inspectorInspectorToggle: overlap(box(inspector), box(inspectorToggle))
      },
      inspector: inspector === null ? null : { box: box(inspector), position: inspectorStyle?.position ?? null,
        width: box(inspector)?.width ?? null, className: inspector.className, zIndex: inspectorStyle?.zIndex ?? null },
      inspectorClose: box(inspectorClose),
      scrim: { display: scrim === null ? "none" : getComputedStyle(scrim).display,
        box: box(scrim), zIndex: scrim === null ? null : getComputedStyle(scrim).zIndex },
      hitTests: { taskView: hitTest(taskView),
        inspectorToggle: hitTest(inspectorToggle), send: hitTest(send),
        inspectorClose: hitTest(inspectorClose), chatCorner },
      horizontalOverflow: { page: root.scrollWidth - root.clientWidth,
        columns: columns === null ? null : columns.scrollWidth - columns.clientWidth }
    };
  }, state);
}

type Snapshot = Awaited<ReturnType<typeof measure>>;

/** 打开任务会话（可选收起近期工作栏）→ 工作详情 → 成果 → 文件预览。 */
async function openTaskWorkspace(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
  await installRoutes(page);
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
  await expect(page.getByTestId("assist-empty-welcome")).toBeVisible({ timeout: 20_000 });
}

/** 收起近期工作栏：视口不变、容器变宽，用来核对阈值确实跟容器走。 */
async function collapseSidebar(page: Page): Promise<void> {
  const frame = page.locator(".app-frame");
  await expect(frame).toHaveAttribute("data-context-collapsed", "false");
  await page.getByTestId("context-rail-collapse").click();
  await expect(frame).toHaveAttribute("data-context-collapsed", "true");
}

async function openWorkDetails(page: Page): Promise<void> {
  await page.getByTestId("collab-conversation-inspector-toggle").click();
  await expect(page.getByTestId("collab-inspector")).toBeVisible();
}

async function openFilePreview(page: Page): Promise<void> {
  await page.getByTestId("collab-inspector-tab-RESULTS").click();
  await page.getByTestId(`collab-inspector-asset-${artifactId}`).click();
  await expect(page.locator(".task-inspector--preview")).toBeVisible();
  await expect(page.getByTestId("collab-inspector-close")).toBeVisible();
}

function bounds(snapshot: Snapshot, where: string, name: string, box: Box | null): Box {
  if (box === null) throw new Error(`${where} · ${name} 不存在`);
  expect(box.left, `${where} · ${name} 左缘越出主区`).toBeGreaterThanOrEqual(-0.5);
  expect(box.top, `${where} · ${name} 上缘越出视口`).toBeGreaterThanOrEqual(-0.5);
  expect(box.right, `${where} · ${name} 右缘越出视口`).toBeLessThanOrEqual(snapshot.viewport.width + 0.5);
  expect(box.bottom, `${where} · ${name} 下缘越出视口`).toBeLessThanOrEqual(snapshot.viewport.height + 0.5);
  return box;
}

/** 三种状态共用的契约：不交叠、主要操作在视口内、无横向溢出、遮罩与面板形态一致。 */
function expectLayoutContract(snapshot: Snapshot, label: string): void {
  const where = `${label} · ${snapshot.state}`;
  const columns = snapshot.columns.box;
  if (columns === null) throw new Error(`${where} · 缺少 .collab-columns`);
  // 1. 右翼图标键两两不交叠，左翼会话名不压到右翼之下。
  for (const [name, area] of Object.entries(snapshot.overlaps)) {
    if (name.startsWith("inspector")) continue;
    expect(area, `${where} · ${name} 交叠 ${area}px²`).toBeLessThanOrEqual(0.5);
  }
  // 2. 工具栏按钮落在主区内、不掉到视口外。「工作详情」开关在面板弹出后整颗不渲染
  //    （2026-10-23 用户截图指令：收起入口只剩面板头部那颗同图标键），因此只有关闭态核对它。
  for (const [name, box] of [["任务视图", snapshot.taskView],
    ["工作详情", snapshot.inspectorToggle]] as const) {
    if (name === "工作详情" && box === null) {
      expect(snapshot.inspector, `${where} · 开关缺席但面板也未打开`).not.toBeNull();
      continue;
    }
    const placed = bounds(snapshot, where, name, box);
    expect(placed.left, `${where} · ${name} 越出主区右缘`).toBeLessThanOrEqual(columns.right + 0.5);
  }
  // 3. 发送键与草稿输入框不能被推出窗口；抽屉遮罩之外必须可命中。
  const send = bounds(snapshot, where, "发送键", snapshot.send);
  expect(send.right, `${where} · 发送键越出主区右缘`).toBeLessThanOrEqual(columns.right + 0.5);
  bounds(snapshot, where, "草稿输入框", snapshot.draft);
  // 4. 无横向溢出。
  expect(snapshot.horizontalOverflow.page, `${where} · 页面横向溢出`).toBe(0);
  expect(snapshot.horizontalOverflow.columns ?? 0, `${where} · 主区横向溢出`).toBe(0);
  // 5. 抽屉态：遮罩可见并盖住主区，关闭键在遮罩之上；分栏态：不得有遮罩，发送键可直接命中。
  if (snapshot.inspector === null) {
    expect(snapshot.scrim.display, `${where} · 无面板时不该有遮罩`).toBe("none");
    expect(snapshot.hitTests.chatCorner, `${where} · 无面板时主区不该被遮挡`).not.toBe("collab-inspector-scrim");
    expect(snapshot.hitTests.send, `${where} · 无面板时发送键`).toBe("self");
    return;
  }
  const drawer = snapshot.inspector.position === "absolute";
  const panel = bounds(snapshot, where, "详情面板", snapshot.inspector.box);
  expect(panel.right, `${where} · 面板越出主区右缘`).toBeLessThanOrEqual(columns.right + 0.5);
  if (drawer) {
    expect(snapshot.scrim.display, `${where} · 抽屉态缺少遮罩`).toBe("block");
    expect(snapshot.hitTests.chatCorner, `${where} · 遮罩没有盖住主区`).toBe("collab-inspector-scrim");
    // 抽屉态发送键必须不可命中（界面不能一边盖住一边仍写「不影响协作」）。
    // 覆盖它的可能是遮罩，也可能是抽屉面板自己：面板画在自己的遮罩之上，而窄容器里正文
    // 测量列的右缘会落进面板矩形（实测主区 748px 时发送键 [939..971] ⊂ 面板 [712..1000]）。
    expect(snapshot.hitTests.send, `${where} · 抽屉态发送键仍可命中`).not.toBe("self");
    expect(Number(snapshot.scrim.zIndex), `${where} · 遮罩在面板之上`).toBeLessThan(Number(snapshot.inspector.zIndex));
  } else {
    expect(snapshot.scrim.display, `${where} · 分栏态不该有遮罩`).toBe("none");
    expect(snapshot.hitTests.send, `${where} · 分栏态发送键被遮挡`).toBe("self");
    expect(snapshot.overlaps.inspectorTaskView, `${where} · 分栏面板压住任务视图`).toBeLessThanOrEqual(0.5);
    expect(snapshot.overlaps.inspectorInspectorToggle, `${where} · 分栏面板压住工作详情`).toBeLessThanOrEqual(0.5);
  }
  // 6. 面板的关闭键始终可命中（抽屉里在遮罩之上，分栏里在正文之上）。
  expect(snapshot.hitTests.inspectorClose, `${where} · 关闭键不可达`).toBe("self");
}

/** 面板是分栏还是抽屉，只由容器宽度决定：详情 52rem、深预览 56.5rem。 */
function expectModeBoundary(snapshot: Snapshot, label: string, mode: "details" | "preview"): void {
  const mainWidth = snapshot.mainWidth;
  if (mainWidth === null) throw new Error(`${label} · 缺少主区宽度`);
  const threshold = (mode === "details" ? 52 : 56.5) * snapshot.rootFontSize;
  const expected = mainWidth > threshold ? "static" : "absolute";
  expect(snapshot.inspector?.position, `${label} · 容器 ${mainWidth}px 时面板形态`).toBe(expected);
}

const viewports = [
  { width: 1162, height: 782 },
  { width: 1000, height: 800 },
  { width: 860, height: 800 }
] as const;

test.describe("CT-01 详情与预览的容器布局", () => {
  for (const viewport of viewports) {
    for (const rail of ["expanded", "collapsed"] as const) {
      test(`${viewport.width}×${viewport.height} · 近期工作栏${rail === "expanded" ? "展开" : "收起"}：三种状态无交叠、主操作可达、遮罩与面板形态一致`, async ({ page }) => {
        const label = `${viewport.width}×${viewport.height}/${rail}`;
        await openTaskWorkspace(page, viewport);
        if (rail === "collapsed") await collapseSidebar(page);
        const noDetails = await measure(page, "no-details");
        await openWorkDetails(page);
        const details = await measure(page, "work-details");
        await openFilePreview(page);
        const preview = await measure(page, "file-preview");
        // 原始几何留在日志里，作为这份矩阵的证据（不连真实 API，数值只反映夹具布局）。
        console.log(JSON.stringify({ label, noDetails, details, preview }));
        for (const snapshot of [noDetails, details, preview]) expectLayoutContract(snapshot, label);
        expectModeBoundary(details, `${label} · 工作详情`, "details");
        expectModeBoundary(preview, `${label} · 文件预览`, "preview");
        // 长会话标题在顶栏纯文字上截断，完整值挂在 title 上仍可核对；面板展开不夺走它的可读性。
        const sessionTitle = page.getByTestId("collab-session-title");
        await expect(sessionTitle).toHaveAttribute("title", /关于确定实验评价指标/u);
        await expect(sessionTitle).toBeVisible();
      });
    }
  }

  test("1162×782：视口不变，收起近期工作栏后预览从抽屉回到真分栏", async ({ page }) => {
    // 边界只跟容器宽度走：预览阈值 56.5rem = 904px。1162 窗口里收起会话栏前后主区 900 → 1042，
    // 正好跨过它。1000 窗口收起后只有 880px，仍在阈值内（就该还是抽屉），拿它证明
    // 「收起就变分栏」是假证据，所以这条用例固定在 1162×782 并显式核对阈值两侧。
    await openTaskWorkspace(page, { width: 1162, height: 782 });
    await openWorkDetails(page);
    await openFilePreview(page);
    const before = await measure(page, "file-preview/rail-expanded");
    expect(before.inspector?.position).toBe("absolute");
    await page.getByTestId("collab-inspector-close").click();
    await expect(page.locator(".task-inspector--preview")).toHaveCount(0);
    await collapseSidebar(page);
    await openWorkDetails(page);
    await openFilePreview(page);
    const after = await measure(page, "file-preview/rail-collapsed");
    const threshold = 56.5 * after.rootFontSize;
    expect(before.mainWidth ?? 0, "收起前：容器仍在抽屉阈值内").toBeLessThanOrEqual(threshold);
    expect(after.mainWidth ?? 0, "收起后：容器越过抽屉阈值").toBeGreaterThan(threshold);
    expect(after.inspector?.position).toBe("static");
    expect(after.scrim.display).toBe("none");
    expect(after.hitTests.send).toBe("self");
  });

  test("860×800 覆盖抽屉：焦点进抽屉、Esc 与点按遮罩都能收起并回触发键", async ({ page }) => {
    await openTaskWorkspace(page, { width: 860, height: 800 });
    const toggle = page.getByTestId("collab-conversation-inspector-toggle");
    await toggle.click();
    const panel = page.getByTestId("collab-inspector");
    await expect(panel).toBeVisible();
    // 抽屉遮住了正文：焦点必须已经在抽屉里，关闭键可命中。
    await expect(page.getByTestId("collab-inspector-close")).toBeFocused();
    await expect(page.getByTestId("collab-inspector-scrim")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(toggle).toBeFocused();
    // 收起后发送键重新可命中：遮罩不是长期占位。
    const restored = await measure(page, "closed-after-escape");
    expect(restored.hitTests.send).toBe("self");
    // 点按遮罩与 Esc 同一条路径。
    await toggle.click();
    await expect(panel).toBeVisible();
    await page.getByTestId("collab-inspector-scrim").click({ position: { x: 12, y: 12 } });
    await expect(panel).toHaveCount(0);
    await expect(toggle).toBeFocused();
  });

  test("1162×782 真分栏：无遮罩、不抢焦点、Esc 不关；预览抽屉里 Esc 先退回工作详情", async ({ page }) => {
    await openTaskWorkspace(page, { width: 1162, height: 782 });
    const toggle = page.getByTestId("collab-conversation-inspector-toggle");
    await toggle.click();
    await expect(page.getByTestId("collab-inspector")).toBeVisible();
    await expect(page.getByTestId("collab-inspector-scrim")).toBeHidden();
    // 打开即收走触发键（2026-10-23 用户截图指令）：非模态分栏仍不抢焦点——焦点落回文档，
    // 不被面板里的任何控件接走。
    await expect(toggle).toHaveCount(0);
    const focusStolen = await page.evaluate(() => {
      const panelNode = document.querySelector('[data-testid="collab-inspector"]');
      return panelNode?.contains(document.activeElement) ?? false;
    });
    expect(focusStolen, "分栏打开时焦点被面板抢走").toBe(false);
    const split = await measure(page, "work-details/split");
    expect(split.inspector?.position).toBe("static");
    await page.keyboard.press("Escape");
    // 分栏是常驻内容：Esc 不是它的关闭路径，面板保持原样。
    await expect(page.getByTestId("collab-inspector")).toBeVisible();
    // 深预览在 900px 容器里收成抽屉（56.5rem 阈值），Esc 第一下退回工作详情。
    await openFilePreview(page);
    await expect(page.getByTestId("collab-inspector-scrim")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".task-inspector--preview")).toHaveCount(0);
    await expect(page.getByTestId("collab-inspector-tab-RESULTS")).toBeVisible();
    const backToDetails = await measure(page, "preview-escape/work-details");
    expect(backToDetails.inspector?.position).toBe("static");
    // 再按一次才收起整个抽屉。分栏没有遮罩，Esc 仍不关它——先在抽屉态验证一次。
    await expect(page.getByTestId("collab-inspector")).toBeVisible();
  });
});
