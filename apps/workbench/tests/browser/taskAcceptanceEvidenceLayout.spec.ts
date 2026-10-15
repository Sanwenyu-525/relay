import { expect, test, type Page, type Route } from "@playwright/test";

// 2026-10-08 任务详情页两项呈现缺陷的正式回归（真实 Chromium，页面内拦截伪造 API）。
// 缺陷 1：验收依据（<ul>）复用了有编号列表的 grid 行类，正文自动落进 32px 编号列，
//         长中文被挤成每行约两个字的竖条。既有 taskDetailVisual 只断言「整页无横向溢出」，
//         因此漏掉了本缺陷；这里改为读正文元素的实际宽度、行盒数量与行内可读宽度。
// 缺陷 2：页头把 36 字符任务 UUID 拼进普通 meta 长句，长项目名下「修订 vN」会被拆开；
//         这里核对元信息分组、修订单行、完整 ID 的可核对入口。
// 口径：验证用户可见行为与布局结果（宽度、行盒、可读行宽、单行完整性、完整值可取回），
//       不断言某个 class 存在，也不把某个元素钉死为具体 px 值。
// 不连数据库、不调 Provider；未被断言消费的端点如实 404。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";
const taskId = "33333333-3333-4333-8333-333333333333";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "44444444-4444-4444-8444-444444444444";

// 刻意写长的项目名：缺陷态里 36 字符 UUID 与它挤在同一句元信息里，元信息行被撑成多行，
// 「修订 v2」被顶到后面、且完全依赖字体度量决定会不会在「修订」与「v2」之间断开。
const longProjectTitle = "人机协作长期项目：核心文献综述、数据方法设计、验证协议与复现脚本的统一跟踪台账（2026 年度第二季度）";
const longTitle = "整理近五年核心文献并形成结构化综述以支撑后续数据分析方法设计";
// 刻意写长的中文条件：缺陷态下 32px 宽会折成几十行（单条高度上千像素）。
const longCriterionStatement = "系统梳理近五年本课题相关的核心研究进展，逐篇记录作者、年份、研究问题、方法、主要结论与局限性，"
  + "并按研究主题与方法族归类，明确指出各主题之间的承接关系、尚未解决的争议点以及本项目可以复用的方法前提；"
  + "综述正文需要能够独立阅读，不依赖对话上下文补全含义，引用格式与页码必须逐条可核对。";
const longPath = "checks/literature/segmentation/consistency-review/check-literature-coverage-and-classification-report-v2.py";

interface FixtureOptions {
  /** 任务当前是否有 AI Run：有则读 Run Trace，用于制造历史会话与版本不匹配。 */
  readonly runId?: string | null;
  /** 是否给出完整变体（所有条件都读到了检查对象），决定补充条件入口是否可用。 */
  readonly complete?: boolean;
}

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin, "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

function criteria(options: FixtureOptions): unknown[] {
  const base = [
    { criterion_id: "c1", statement: "覆盖近五年核心文献，数量不少于 30 篇，并按主题进行分类梳理。",
      required: true, method: "HUMAN", target_spec: { path: longPath } },
    { criterion_id: "c2", statement: longCriterionStatement, required: true, method: "SEMANTIC",
      target_spec: { path: longPath, mode: "strict", min_items: 30 } },
    { criterion_id: "c3", statement: "形成结构清晰、引用规范的文献综述文档，并保留原始检索式。",
      required: false, method: "HUMAN", target_spec: {} }
  ];
  if (options.complete === true) return base;
  // 默认变体：c3 的检查对象缺失，用于「字段缺失 ≠ 空对象」的既有栅栏用例。
  const rows = structuredClone(base) as Record<string, unknown>[];
  delete rows[2]!["target_spec"];
  return rows;
}

async function installTaskDetail(page: Page, options: FixtureOptions = {}, posts?: unknown[]): Promise<void> {
  const activeRun = options.runId ?? null;
  const task = { id: taskId, project_id: projectId, title: longTitle, status: "READY", mode: "ME",
    revision: "2", executor: { kind: "HUMAN", run_id: activeRun }, current_completion_id: null,
    waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    dependencies: [], updated_at: "2026-10-08T02:28:00Z",
    acceptance: { acceptance_revision: "2", objective: "系统梳理本课题相关的核心研究进展，形成结构化的文献综述。",
      expected_outputs: { literature_review: "MARKDOWN" }, source: "HUMAN", criteria: criteria(options) } };
  const listed = criteria(options);
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (request.method() === "POST") { posts?.push({ path, body: request.postData() }); return fulfillJson(route, { code: "NOT_STUBBED" }, 404); }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/projects`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, task);
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId, title: longProjectTitle,
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/tasks/${taskId}/check-plan-preview`) return fulfillJson(route, { task_id: taskId,
      status: "AVAILABLE", admission_available: true, frozen_run_plan: false, executed: false, reason_codes: [],
      check_plan_sha256: "a".repeat(64),
      sources: { task_revision: "2", acceptance_revision: "2", rule_revision: null,
        workflow_key: "markdown-deliverable-v1", workflow_version: "1", rule_refs: [] },
      check_plan: { policy_version: "1", workflow_key: "markdown-deliverable-v1", workflow_version: "1",
        // 只关联 c2：c1/c3 的「计划关联」必须如实显示未关联。
        entries: [{ criterion_id: "c2", statement: (listed[1] as { statement: string }).statement, required: true,
          method: "SEMANTIC", severity: "MAJOR", target_spec: { path: longPath },
          checker_id: "script", checker_version: "1" }] } });
    if (path === `${prefix}/tasks/${taskId}/artifacts`) return fulfillJson(route, { items: [], next_cursor: null, current_accepted_version_ids: [] });
    if (activeRun !== null && path === `${prefix}/runs/${activeRun}/trace`) {
      // 唯一一次验证会话挂在旧验收版本上：当前验收版本不匹配，结论必须是「不匹配」。
      return fulfillJson(route, { run_id: activeRun, task_id: taskId, project_id: projectId, status: "RUNNING",
        steps: [], attempts: [], model_calls: [], manifests: [], reviews: [], operations: [], effects: [],
        verifications: [{ id: "55555555-5555-4555-8555-555555555555", status: "FINALIZED", verdict: "FAIL",
          acceptance_revision: "1", check_plan_hash: "a".repeat(64), parent_session_id: null,
          targets: [], checks: [{ id: "check-1", criterion_id: "c2", result: "FAIL", severity: "MAJOR",
            required: true, created_at: "2026-10-07T02:00:00Z" }],
          created_at: "2026-10-07T02:00:00Z", finalized_at: "2026-10-07T02:01:00Z" }] });
    }
    // 未被本用例覆盖的端点如实报错，不用空对象假装读取成功。
    return fulfillJson(route, { code: "NOT_STUBBED", detail: path }, 404);
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("task-evidence-layout-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openTaskDetail(page: Page, options: FixtureOptions = {}, posts?: unknown[]): Promise<void> {
  await installTaskDetail(page, options, posts);
  await page.goto(`/tasks/${taskId}`);
  await connect(page);
  await page.getByTestId("task-detail-page-head").waitFor({ timeout: 20_000 });
  // 等验收依据的条件行渲染出来。这里刻意用结构选择器而不是新加的 data-testid，
  // 这样同一批测量断言在修复前的旧实现上也能真正跑到，而不是停在「元素不存在」。
  await page.locator(".task-detail-evidence .task-detail-criterion").first().waitFor({ timeout: 20_000 });
}

/**
 * 一段文字占了几条视觉行：只按文本在根节点里定位，再数行盒顶的分组数。
 * markup 无关——不论事实写成一整句、还是拆成「项目 / 编号 / 修订」三个块，
 * 「修订 v2」被折成两行时都是 2。所以同一断言在修复前后都能真正执行。
 */
function visualLineCountOfText(page: Page, rootSelector: string, needle: string): Promise<number> {
  return page.locator(rootSelector).evaluate((root, text) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let full = "";
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      nodes.push(node as Text);
      full += (node as Text).data;
    }
    const start = full.indexOf(text);
    if (start < 0) return -1;
    const end = start + text.length;
    let cursor = 0;
    let from: Text | null = null;
    let fromOffset = 0;
    let to: Text | null = null;
    let toOffset = 0;
    for (const item of nodes) {
      const next = cursor + item.data.length;
      if (from === null && next > start) { from = item; fromOffset = start - cursor; }
      if (next >= end) { to = item; toOffset = end - cursor; break; }
      cursor = next;
    }
    if (from === null || to === null) return -1;
    const range = document.createRange();
    range.setStart(from, fromOffset);
    range.setEnd(to, toOffset);
    const tops = new Set<number>();
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width <= 0.5 || rect.height <= 0.5) continue;
      tops.add(Math.round(rect.top * 2) / 2);
    }
    return tops.size;
  }, needle);
}

test.describe("验收依据正文阅读宽度与页头技术信息降级（真实 Chromium）", () => {
  // 缺陷 1 主回归：正文实际占用宽度、没落进编号列、长中文横向换行。
  for (const [width, height] of [[768, 900], [843, 782], [960, 900], [1162, 782], [2048, 1104], [843, 600]] as const) {
    test(`${width}×${height}：验收依据正文占满阅读宽度，长中文条件横向换行不被压成竖条`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openTaskDetail(page);

      const firstRow = page.locator(".task-detail-evidence .task-detail-criterion").first();
      await firstRow.scrollIntoViewIfNeeded();

      const look = await page.evaluate(() => {
        const box = (node: Element) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0.5 && rect.height > 0.5);
          const tops = new Map<number, { left: number; right: number }>();
          for (const rect of rects) {
            const key = Math.round(rect.top * 2) / 2;
            const existing = tops.get(key);
            tops.set(key, existing === undefined
              ? { left: rect.left, right: rect.right }
              : { left: Math.min(existing.left, rect.left), right: Math.max(existing.right, rect.right) });
          }
          const widths = [...tops.values()].map((line) => line.right - line.left);
          return { count: widths.length, firstWidth: widths[0] ?? 0 };
        };
        const list = document.querySelector<HTMLElement>(".task-detail-evidence .task-detail-criteria-list")!;
        const rows = Array.from(list.querySelectorAll<HTMLElement>(":scope > li")).map((row) => {
          const body = row.querySelector<HTMLElement>(".task-detail-criterion-body")!;
          const statement = row.querySelector<HTMLElement>(".task-detail-criterion-statement")!;
          const rowBox = row.getBoundingClientRect();
          const bodyBox = body.getBoundingClientRect();
          const statementBox = statement.getBoundingClientRect();
          return { rowLeft: rowBox.left, rowRight: rowBox.right, rowWidth: rowBox.width,
            bodyLeft: bodyBox.left, bodyRight: bodyBox.right, bodyWidth: bodyBox.width,
            statementHeight: statementBox.height, ...box(statement),
            chars: (statement.textContent ?? "").length,
            criterionId: row.getAttribute("data-testid") ?? "" };
        });
        return { viewportWidth: document.documentElement.clientWidth,
          pageWidth: document.scrollingElement!.scrollWidth, rows };
      });

      expect(look.viewportWidth - look.pageWidth).toBeLessThanOrEqual(1);
      expect(look.rows.length).toBe(3);

      for (const row of look.rows) {
        // 正文宽度来自实测，不接受「容器很宽但正文在窄列里」。
        expect(row.bodyWidth, `${width}px 下 ${row.criterionId} 正文宽度`).toBeGreaterThan(100);
        // 验收依据没有编号列，正文占满整行阅读区：左边缘贴行左边缘、右边缘贴行右边缘。
        expect(Math.abs(row.bodyLeft - row.rowLeft)).toBeLessThanOrEqual(2);
        expect(row.bodyWidth).toBeGreaterThan(row.rowWidth - 4);
        expect(row.bodyRight).toBeGreaterThan(row.rowRight - 4);
        // 长中文按行横向阅读：高度不高、行数不多、行内字数合理。
        expect(row.statementHeight).toBeLessThan(200);
        expect(row.count).toBeGreaterThanOrEqual(1);
        expect(row.chars / row.count).toBeGreaterThanOrEqual(8);
      }

      const longRow = look.rows.find((row) => row.criterionId.includes("c2"))!;
      // 这条是刻意写长的条件：应该换行成几行，首行就是一段真实阅读宽度，而不是一条 32px 竖条。
      expect(longRow.count).toBeGreaterThanOrEqual(2);
      expect(longRow.count).toBeLessThanOrEqual(8);
      expect(longRow.firstWidth).toBeGreaterThan(300);
      await page.screenshot({ path: `test-results/evidence-body-${width}x${height}.png`, fullPage: true });
    });
  }

  test("有编号的原验收条件保留编号列：三条编号 x 一致，正文在编号右侧且宽度充足", async ({ page }) => {
    await page.setViewportSize({ width: 1162, height: 782 });
    await openTaskDetail(page);

    const rows = await page.evaluate(() => {
      const scope = document.querySelector<HTMLElement>('[data-testid="task-detail-criteria"]')!;
      return Array.from(scope.querySelectorAll<HTMLElement>(":scope > ol > li")).map((row) => {
        const index = row.querySelector<HTMLElement>(".task-detail-criterion-index")!;
        const body = row.querySelector<HTMLElement>(".task-detail-criterion-body")!;
        const indexBox = index.getBoundingClientRect();
        const bodyBox = body.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        return { indexLeft: indexBox.left, indexRight: indexBox.right, indexWidth: indexBox.width,
          bodyLeft: bodyBox.left, bodyWidth: bodyBox.width, rowLeft: rowBox.left, rowWidth: rowBox.width };
      });
    });

    expect(rows.length).toBe(3);
    // 编号列稳定对齐：三条的 x 与宽度一致（grid 固定列）。
    for (const row of rows.slice(1)) {
      expect(Math.abs(row.indexLeft - rows[0]!.indexLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(row.indexWidth - rows[0]!.indexWidth)).toBeLessThanOrEqual(1);
    }
    for (const row of rows) {
      // 正文起点落在正文列（编号右侧），不是与行左边缘齐平。
      expect(row.bodyLeft).toBeGreaterThan(row.indexRight + 4);
      expect(row.bodyLeft - row.rowLeft).toBeGreaterThan(row.indexWidth);
      // 正文列宽度显著大于编号列。
      expect(row.bodyWidth).toBeGreaterThan(100);
      expect(row.bodyWidth).toBeGreaterThan(row.indexWidth * 3);
      expect(row.bodyWidth).toBeGreaterThan(row.rowWidth - row.indexWidth - 16);
    }
  });

  test("验收依据完整布局：必需标记、验证方式、计划关联、实际证据、下一步、受验对象与展开 JSON 都在位且不横向撑破", async ({ page }) => {
    await page.setViewportSize({ width: 1162, height: 782 });
    await openTaskDetail(page);

    const c2 = page.getByTestId("acceptance-criterion-c2");
    await c2.scrollIntoViewIfNeeded();
    // 必需/可选标记与验证方式：中文主文案，原枚举降级为 small。
    await expect(c2.locator(".status-chip")).toHaveText("必需");
    await expect(c2).toContainText("验证方式：语义检查");
    await expect(c2.locator("small[title='SEMANTIC']")).toHaveCount(1);
    // 计划关联：c2 已关联，c1/c3 如实显示未关联。
    await expect(c2).toContainText("计划关联：script v1");
    await expect(page.getByTestId("acceptance-criterion-c1")).toContainText("计划关联：未关联当前 CheckPlan");
    // 人工证据、实际证据、下一步、受验对象都在同一行块的阅读流里。
    await expect(c2).toContainText("人工证据：无当前完成凭据关联");
    await expect(c2).toContainText("实际证据：");
    await expect(c2).toContainText("下一步：");
    await expect(c2).toContainText("受验对象：已提供，展开查看技术 JSON");

    // 技术 JSON 默认收起，展开后长路径也不把行撑破。
    const json = c2.locator("details.task-detail-tech").last();
    await expect(json.locator("code")).toBeHidden();
    await json.locator("summary").click();
    const code = json.locator("code");
    await expect(code).toBeVisible();
    await expect(code).toContainText(longPath);
    expect(await code.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);

    // 展开后的整行仍不产生横向溢出。
    const overflow = await page.evaluate(() =>
      document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("无 Run：未关联执行记录、部分计划关联、无完成凭据都如实呈现，不染绿也不指向 Run", async ({ page }) => {
    await page.setViewportSize({ width: 1162, height: 782 });
    await openTaskDetail(page);

    const facts = page.locator(".task-detail-evidence-facts");
    // 无 Run 分支只陈述「当前未关联执行记录」，不由空验证数组反推「尚未运行检查」。
    await expect(facts).toContainText("当前任务未关联执行记录（Run）");
    await expect(facts).toContainText("只有部分条件已关联检查计划");
    await expect(facts).toContainText("尚无可比对的验证会话");
    await expect(facts).toContainText("未确认：当前没有完成凭据可核对");

    const evidence = page.locator(".task-detail-evidence");
    // 无 Run 分支不得出现指向不存在执行记录的措辞，也不得引导创建 AI Run。
    await expect(evidence).not.toContainText("尚未运行检查");
    await expect(evidence).not.toContainText("当前 Run");
    await expect(evidence).not.toContainText("原 Run");
    // 逐项下一步：已关联计划项的指向任务工作区人工核对；未关联的指向验收方案。
    await expect(page.getByTestId("acceptance-criterion-c2"))
      .toContainText("下一步：人工核对本条件，并在任务工作区补充人工证据。");
    await expect(page.getByTestId("acceptance-criterion-c1")).toContainText("下一步：在验收方案核对检查关联。");

    await expect(evidence.locator(".status-chip--success")).toHaveCount(0);
    await expect(evidence.getByText("通过", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("acceptance-criterion-c2")).toContainText("检查未运行或未关联");
  });

  test("无 Run 人工任务：验收依据正文布局不回归，技术详情不出现指向 Run 的旧文案", async ({ page }) => {
    await page.setViewportSize({ width: 1162, height: 782 });
    await openTaskDetail(page);

    // 与缺陷 1 相同的测量口径：无 Run 时正文仍是单列、占满行宽，整页不横向溢出。
    const look = await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>(".task-detail-evidence .task-detail-criteria-list")!;
      const rows = Array.from(list.querySelectorAll<HTMLElement>(":scope > li")).map((row) => {
        const body = row.querySelector<HTMLElement>(".task-detail-criterion-body")!;
        const rowBox = row.getBoundingClientRect();
        const bodyBox = body.getBoundingClientRect();
        return { bodyLeft: bodyBox.left, bodyWidth: bodyBox.width, rowLeft: rowBox.left, rowWidth: rowBox.width };
      });
      return { rows, pageWidth: document.scrollingElement!.scrollWidth,
        viewportWidth: document.documentElement.clientWidth };
    });
    expect(look.rows.length).toBe(3);
    for (const row of look.rows) {
      expect(row.bodyWidth).toBeGreaterThan(100);
      expect(Math.abs(row.bodyLeft - row.rowLeft)).toBeLessThanOrEqual(2);
      expect(row.bodyWidth).toBeGreaterThan(row.rowWidth - 4);
    }
    expect(look.viewportWidth - look.pageWidth).toBeLessThanOrEqual(1);

    // 技术详情展开后：无 Run 分支陈述未关联执行记录，不出现「当前 Run 验证会话」旧句式。
    const tech = page.locator(".task-detail-evidence details.task-detail-tech").first();
    await tech.locator("summary").click();
    await expect(tech).toContainText("当前任务未关联执行记录（Run）");
    await expect(tech).not.toContainText("当前 Run");
    await expect(tech).not.toContainText("原 Run");
  });

  test("历史验证会话与当前验收版本不匹配时，结论是不匹配且旧结果不适用", async ({ page }) => {
    await page.setViewportSize({ width: 1162, height: 782 });
    await openTaskDetail(page, { runId });

    const facts = page.locator(".task-detail-evidence-facts");
    await expect(facts).toContainText("已出结果：共 1 项验证会话记录。");
    await expect(facts).toContainText("没有匹配当前验收版本与产物版本的历史会话。");
    await expect(facts).toContainText("未确认：当前没有完成凭据可核对。");
    await expect(page.locator(".task-detail-evidence")).toContainText("旧结果不适用于本次判定");

    const c2 = page.getByTestId("acceptance-criterion-c2");
    await expect(c2).toContainText("实际证据：旧结果不适用");
    await expect(c2).toContainText("计划关联：script v1");
    // 失效结果不得用成功色或完成措辞暗示通过。
    const evidence = page.locator(".task-detail-evidence");
    await expect(evidence.locator(".status-chip--success")).toHaveCount(0);
    await expect(evidence.getByText("通过", { exact: true })).toHaveCount(0);
  });

  // 缺陷 2 主回归：元信息分组换行 + 完整 ID 降级但可核对。
  // 第一条断言只读 .page-head-meta 的文本与几何，不依赖新加的 data-testid：
  // 「普通元信息行不得直出 36 字符 UUID」在修复前后都能真正执行（修复前实测命中整串 UUID）。
  test("页头：长项目名与长标题下修订不被拆开，普通元信息行不再直出完整 UUID", async ({ page }) => {
    await page.setViewportSize({ width: 1162, height: 782 });
    await openTaskDetail(page);

    const head = page.getByTestId("task-detail-page-head");
    // 用户先看到标题、项目、状态与主操作。
    await expect(head).toContainText(longTitle);
    await expect(page.getByTestId("task-open-collaboration")).toBeVisible();
    await expect(head).toContainText(longProjectTitle);

    const meta = page.locator(".page-head-meta");
    const metaText = ((await meta.textContent()) ?? "").replace(/\s+/gu, " ").trim();
    expect(metaText).toContain("修订 v2");
    // 完整 UUID 不再占用普通元信息长句。
    expect(metaText).not.toContain(taskId);

    // 「修订」与「v2」是同一个事实：视觉行数必须是 1，被折开时是 2。
    expect(await visualLineCountOfText(page, ".page-head-meta", "修订 v2")).toBe(1);

    // 元信息本身不横向溢出，整页也不溢出。
    expect(await meta.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    const overflow = await page.evaluate(() =>
      document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  // 「修订 vN」必须是一个不可拆的整体：它有自己的核对入口、文本恰好是「修订 v2」，
  // 并且在页头宽度下只占一条视觉行。实测缺陷报告里的「修订 / v2 被拆到两行」依赖具体
  // 字体度量与宽度，Chromium 本地夹具在 768–2048 复现不到那一档，因此这里锁的是可判定
  // 的保证：分组 + 单行几何，而不是碰运气复现某一次折行。
  test("页头：元信息分组各自成块，项目名折行也不把修订推到另一行拆开", async ({ page }) => {
    await page.setViewportSize({ width: 1162, height: 782 });
    await openTaskDetail(page);

    // 三块事实各有稳定的核对入口，且都是页头的元信息行内容。
    await expect(page.getByTestId("task-detail-head-project")).toHaveText(longProjectTitle);
    await expect(page.getByTestId("task-detail-head-revision")).toHaveText("修订 v2");
    const revision = page.getByTestId("task-detail-head-revision");
    // 「修订」与「v2」在同一个块里，渲染高度不超过一行行高（两行时约为两倍）。
    const box = await revision.evaluate((node) => {
      const style = getComputedStyle(node);
      return { height: node.getBoundingClientRect().height, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
        lineHeight: Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2 };
    });
    expect(box.height).toBeLessThanOrEqual(box.lineHeight * 1.5);
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
  });

  test("页头：完整任务 ID 保留可核对入口，展开后取到完整值且可选中", async ({ page }) => {
    await page.setViewportSize({ width: 1162, height: 782 });
    await openTaskDetail(page);

    const short = page.getByTestId("task-detail-head-id");
    await expect(short).toBeVisible();
    // 元信息行显示的是缩略：前缀可读，不是完整 36 字符。
    const shortText = ((await short.textContent()) ?? "").trim();
    expect(shortText).toContain("33333333");
    expect(shortText.length).toBeLessThan(taskId.length);

    const full = page.getByTestId("task-detail-head-id-full");
    await expect(full).toBeHidden();
    await page.getByTestId("task-detail-head-identity").locator("summary").click();
    await expect(full).toBeVisible();
    // 信息没有被隐藏：完整值原样可取回、可选中复制。
    expect(((await full.textContent()) ?? "").trim()).toBe(taskId);
    expect(await full.evaluate((node) => getComputedStyle(node).userSelect)).not.toBe("none");
  });

  test("补充条件就地展开：入口在验收条件区内、空值保存禁用、输入可达、取消有效且不发命令", async ({ page }) => {
    await page.setViewportSize({ width: 1162, height: 782 });
    const posts: unknown[] = [];
    await openTaskDetail(page, { complete: true }, posts);

    // 就地：补充入口在验收条件区块内部，不是页面别处的一块独立大卡片。
    const criteriaSection = page.getByTestId("task-detail-criteria");
    const open = criteriaSection.getByTestId("task-acceptance-edit-open");
    await expect(open).toBeVisible();
    await expect(page.getByTestId("task-detail-criteria").getByTestId("task-acceptance-edit")).toHaveCount(1);

    await open.click();
    // 输入可达：展开后焦点直接落在输入区。
    const textarea = page.getByTestId("task-acceptance-additions");
    await expect(textarea).toBeFocused();
    // 空值不能保存，并说明原因。
    await expect(page.getByTestId("task-acceptance-save")).toBeDisabled();
    await expect(criteriaSection).toContainText("请至少填写一条完成条件。");

    await textarea.fill("补充一条人工核对条件");
    await expect(page.getByTestId("task-acceptance-save")).toBeEnabled();

    // 取消有效：就地收起、输入丢弃、原条件不变、不发任何命令。
    await page.getByTestId("task-acceptance-cancel").click();
    await expect(page.getByTestId("task-acceptance-additions")).toHaveCount(0);
    expect(await criteriaSection.locator(":scope > ol > li").count()).toBe(3);
    expect(posts).toHaveLength(0);

    await open.click();
    await expect(page.getByTestId("task-acceptance-additions")).toHaveValue("");
  });
});

// 窄窗下 Run 控制收在「查看运行信息与控制」抽屉里。任务详情本轮只改了页头元信息与
// 验收依据行的列结构，不应让这个入口消失或点不开：用最小 Run 夹具覆盖它。
test.describe("窄窗 Run 控制抽屉入口（真实 Chromium）", () => {
  async function installRunPage(page: Page): Promise<void> {
    const task = { id: taskId, project_id: projectId, title: longTitle, status: "IN_PROGRESS", mode: "ME",
      revision: "2", executor: { kind: "HUMAN", run_id: runId }, current_completion_id: null,
      waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: ["PAUSE", "CANCEL"],
      dependencies: [], updated_at: "2026-10-08T02:28:00Z",
      acceptance: { acceptance_revision: "2", objective: "核对确切版本", source: "HUMAN", criteria: [] } };
    const run = { id: runId, task_id: taskId, status: "RUNNING", revision: "1", wait_reason: null,
      current_step_id: null, steps: [], recent_attempts: [], result_refs: [], blocking_review_ids: [],
      pending_control_request: null, unresolved_operation_ids: [] };
    await page.route(`${apiBase}/**`, async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
      if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
      if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, task);
      if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId, title: longProjectTitle,
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/runs/${runId}`) return fulfillJson(route, run);
      if (path === `${prefix}/runs/${runId}/reviews`) return fulfillJson(route, { items: [] });
      if (path === `${prefix}/runs/${runId}/context-manifests`) return fulfillJson(route,
        { items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
      return fulfillJson(route, { code: "NOT_STUBBED", detail: path }, 404);
    });
  }

  test("843×600：右栏收成抽屉，控制入口可见、可点开且内容与宽窗一致", async ({ page }) => {
    await page.setViewportSize({ width: 843, height: 600 });
    await installRunPage(page);
    await page.goto(`/runs/${runId}`);
    await connect(page);
    await page.getByTestId("run-detail").waitFor({ timeout: 20_000 });

    const trigger = page.getByTestId("rail-trigger");
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText("查看运行信息与控制");
    await trigger.click();

    const drawer = page.getByRole("dialog");
    await expect(drawer).toHaveAttribute("aria-label", "运行信息与控制");
    // 抽屉里必须真的有运行信息与控制面板，不是空壳浮层。
    await expect(drawer.locator('[data-testid="run-info"]')).toBeVisible();
    await expect(drawer.locator('[data-testid="run-control"]')).toBeVisible();
    await expect(drawer.locator('[data-testid="run-info"]')).toContainText(`Run ID：${runId}`);
  });
});
