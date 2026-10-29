import { expect, test, type Page, type Route } from "@playwright/test";

// 插件内联标识（输入器编辑态 + 消息只读态）的真实 Chromium 几何与视觉回归
// （2026-10-28 第二轮精修）。
//
// jsdom（tests/pluginIcons.spec.tsx）守结构与键盘语义，但 getBoundingClientRect 全零、
// 不执行按键默认行为，也排不出版。这里只守必须真浏览器才能证的判据：
//   ① 芯片 = mention 原文首片段的矩形。宽度取原文字宽而不是图标+名称的固有宽度，
//      容器右缘就是 `@标签` 的终点（= 光标落点），所以「芯片盖住后面的正文」
//      「光标落进名称里」这两个缺陷在结构上不可能再出现；误差目标 ≤1 CSS px。
//   ② 镜像层与 textarea 逐项同参数（字体、字号、行高、内边距、边框、折行规则、
//      内容宽）——这是光标位置对得上可见文字的唯一前提。
//   ③ 滚动、换行、行尾、窄宽、字号缩放、禁用/发送中、IME 组字下芯片仍停在原位。
//   ④ 只读态（消息）与编辑态同一套视觉 token，且不给气泡额外撑高行盒。
//   ⑤ 跨行降级（2026-10-29）：mention 被 textarea 原生折行拆成几段时，整枚芯片收起、
//      原文 `@标签` 恢复可见。任何位置都不许留下「透明原文 + 没画芯片」的不可见占位，
//      也不许留下「芯片只盖住一段」的半枚芯片；镜像层始终 pre-wrap（不用 nowrap 换
//      光标错位），降级本身不移动任何文字矩形。
//   ⑥ 三种状态分开证（⑯）：真实发送回显（真 POST 202 + 重读列表）、重新加载、
//      真正的消息撤回（真 recall POST → 已撤回 + 折叠历史）；整枚删除与 Ctrl+Z 撤销
//      恢复由 ⑮ 守，多行消息与 390px 窄窗口只读态由 ⑰ 守。
//
// 只连页面内夹具：不连数据库、不调 Provider、不写任何真实业务事实。⑯ 的 POST 由
// page.route 在测试进程内代答（见 liveApi），不落到任何真实存储。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const userMessageId = "c1111111-1111-4111-8111-111111111111";
const plainMessageId = "c2222222-2222-4222-8222-222222222222";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";
const shots = "output/plugin-chip-acceptance-20261028";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin, "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

const session = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
  title: "插件标识量测会话", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
  working_resource_id: null,
  context: { project_goals: [], working_directory: null },
  created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" };

function message(id: string, seq: string, role: "USER" | "ASSISTANT", content: string) {
  return { id, session_id: sessionId, seq, role, status: "COMPLETED", intent: "DISCUSS", content,
    error_code: null, provider_error_kind: null, sources: [], skill: null, skill_input: null,
    skill_output: null, cancel_requested: false, steer_requested: false, attachments: [],
    created_at: "2026-10-25T09:00:00Z", updated_at: "2026-10-25T09:00:00Z",
    usage: { input_tokens: 1200, output_tokens: 260, cache_read_tokens: null, cache_creation_tokens: null } };
}

/* 真实发送回显与真正的撤回必须走一次真的 POST：路由这边维护一个只在测试进程内的
   收件箱，POST 进去的行下一次 GET 读得到，撤回就按服务端那样在行上补 withdrawn_at /
   recall 摘要。不连数据库、不写任何真实业务事实。 */
type LiveApi = { items: unknown[]; posts: { path: string; body: Record<string, unknown> }[];
  recallPosts: { path: string; messageId: string; body: Record<string, unknown> }[] };

function liveApi(): LiveApi {
  return { items: [], posts: [], recallPosts: [] };
}

const recallId = "d1111111-1111-4111-8111-111111111111";
const recalledAssistantId = "55555555-5555-4555-8555-555555555555";

function recallSummary(messageId: string): Record<string, unknown> {
  return { id: recallId, message_id: messageId, assistant_message_id: recalledAssistantId,
    status: "COMPLETED", planned_files: 1, restored_files: 1, skipped_files: 0,
    completed_at: "2026-10-29T09:05:00Z" };
}

function recallReceipt(messageId: string): unknown {
  return { ...recallSummary(messageId), root_path: "D:/relay/chip-acceptance",
    requested_at: "2026-10-29T09:05:00Z", detail: { summary: "已回退 1 个文件" },
    files: [{ path: "notes/a.md", status: "RESTORED", reason: null, baseline: "PRESENT",
      baseline_sha256: "0".repeat(64) }] };
}

async function installRoutes(page: Page, messages: unknown[] = [], live: LiveApi | null = null): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, { id: taskId, project_id: projectId,
      title: "插件标识量测任务", status: "IN_PROGRESS", mode: "ME", revision: "2",
      created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" },
      current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [],
      allowed_actions: [],
      acceptance: { acceptance_revision: "2", objective: "量测。", source: "CREATE",
        created_at: "2026-10-16T00:00:00Z", criteria: [] },
      dependencies: [] });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "插件标识量测项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
      if (live !== null && request.method() === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        live.posts.push({ path, body });
        const userSeq = String(live.items.length + 1);
        const userRow = message(`echo-user-${userSeq}`, userSeq, "USER", String(body.content));
        const assistantRow = message(`echo-assistant-${userSeq}`, String(Number(userSeq) + 1),
          "ASSISTANT", "已按原文记录。");
        live.items.push(userRow, assistantRow);
        return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-29T09:00:00Z",
          result: { session_id: sessionId, user_message_id: userRow.id,
            assistant_message_id: assistantRow.id } }, 202);
      }
      return fulfillJson(route, { items: live === null ? messages : live.items });
    }
    const recallPath = /^\/api\/v1\/workspaces\/[^/]+\/assist-messages\/([^/]+)\/recall$/u.exec(path);
    if (recallPath !== null && live !== null) {
      const messageId = recallPath[1]!;
      if (request.method() === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        live.recallPosts.push({ path, messageId, body });
        const row = live.items.find((item) => (item as { id: string }).id === messageId) as Record<string, unknown>;
        Object.assign(row, { withdrawn_at: "2026-10-29T09:05:00Z", withdrawn_by_recall_id: recallId,
          recall: recallSummary(messageId) });
        return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-29T09:05:00Z",
          result: recallReceipt(messageId) }, 200);
      }
      return fulfillJson(route, recallReceipt(messageId));
    }
    if (path === `${prefix}/search`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/skill-definitions`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/assist-proposals`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/chat-commands`) return fulfillJson(route, { items: [] });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("chip-geometry-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

/** 进会话页：字体 ready 之后再量，避免 font-display:swap 的回退字宽混进断言。 */
async function openConversation(page: Page, messages: unknown[] = [], width = 1162,
  live: LiveApi | null = null): Promise<void> {
  await page.setViewportSize({ width, height: 782 });
  await installRoutes(page, messages, live);
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
}

/** 消息展示层一次量全套：只读态没有镜像层，标识就是正文里的 in-flow 元件。 */
function measureMessages(): Record<string, unknown> {
  const round = (value: number) => Math.round(value * 100) / 100;
  const box = (rect: DOMRect) => ({ l: round(rect.left), t: round(rect.top), r: round(rect.right),
    b: round(rect.bottom), w: round(rect.width), h: round(rect.height) });
  const blocks = Array.from(document.querySelectorAll<HTMLElement>(".assist-message-content"));
  return {
    blocks: blocks.map((block) => {
      const chips = Array.from(block.querySelectorAll<HTMLElement>("[data-plugin-mention]"));
      const rects = chips.map((chip) => box(chip.getBoundingClientRect()));
      return {
        text: block.textContent,
        lines: round(block.getBoundingClientRect().height
          / Number.parseFloat(getComputedStyle(block).lineHeight)),
        keys: chips.map((chip) => chip.getAttribute("data-plugin-mention")),
        rects,
        // 只读态是真实文字：任何一枚标识透明 = 不可见占位。
        transparent: chips.filter((chip) => getComputedStyle(chip).color === "rgba(0, 0, 0, 0)")
          .map((chip) => chip.textContent ?? ""),
        iconWidths: chips.map((chip) => round(chip.querySelector(".plugin-icon")!.getBoundingClientRect().width)),
        atSigns: (block.textContent ?? "").split("@").length - 1
      };
    }),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1
  };
}

type MessageLayer = { blocks: { text: string | null; lines: number; keys: string[];
  rects: { l: number; t: number; r: number; b: number; w: number; h: number }[];
  transparent: string[]; iconWidths: number[]; atSigns: number }[]; overflowX: boolean };

type Box = { l: number; t: number; r: number; b: number; w: number; h: number };
type Composer = {
  mention: Box[]; mentionFirst: Box[]; chip: Box[]; chipIcon: Box | null; chipLabel: Box | null;
  chipSplit: string[]; labelClipped: boolean[]; labelOverflow: number[];
  afterMention: ({ left: number; top: number; height: number } | null)[];
  band: { height: string; background: string; radius: string; left: string; right: string } | null;
  parity: Record<string, boolean | number | string>;
  overflowX: boolean; mirrorClip: Box;
  /** 跨行降级三件套（2026-10-29）：芯片是否真的画了、原文是否可见、有没有留下隐形占位。 */
  chipPainted: boolean[];
  mentionFragments: number[];
  mentionFragmentRects: Box[][];
  mentionVisible: boolean[];
  mentionColors: string[];
  invisiblePlaceholders: string[];
  halfChips: string[];
  mirrorWhiteSpace: string;
  mirrorScrollHeight: number;
  textareaScrollHeight: number;
  mirrorText: string;
};

/**
 * 输入器一次量全套。函数体会被序列化进浏览器执行，所以内部只允许自带定义
 * （round 写在里面：模块级的 round 在 page.evaluate 里不存在）。
 */
function measureComposer(): Record<string, unknown> {
  const round = (value: number) => Math.round(value * 100) / 100;
  const textarea = document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement;
  const mirror = document.querySelector(".chat-command-mirror") as HTMLElement;
  const box = (rect: DOMRect | undefined | null): Box | null => {
    if (!rect) return null;
    return { l: round(rect.left), t: round(rect.top), r: round(rect.right), b: round(rect.bottom),
      w: round(rect.width), h: round(rect.height) };
  };
  const spans = Array.from(mirror.querySelectorAll<HTMLElement>("[data-mention-start]"));
  const chips = Array.from(mirror.querySelectorAll<HTMLElement>(".chat-command-chip"));
  const same = (a: string, b: string) => a === b;
  const taStyle = getComputedStyle(textarea);
  const mStyle = getComputedStyle(mirror);
  // 镜像层里 mention 之后的第一个可见字形：它的左缘就是「下一个字形从哪里开始」
  // （跳过空格，且不下进芯片子树——芯片自己的文字不算正文）。
  const textNodesFrom = function* (start: Node | null): Generator<Text> {
    let node: Node | null = start;
    while (node !== null) {
      if (node.nodeType === 3) yield node as Text;
      else if (node.nodeType === 1 && !(node as Element).classList.contains("chat-command-chip")) {
        const first = (node as Element).firstChild;
        if (first !== null) yield* textNodesFrom(first);
      }
      node = node.nextSibling;
    }
  };
  const afterMention = spans.map((span) => {
    for (const text of textNodesFrom(span.nextSibling)) {
      const data = text.data;
      const spaces = data.length - data.replace(/^ +/u, "").length;
      if (spaces >= data.length) continue;
      const range = document.createRange();
      range.setStart(text, spaces);
      range.setEnd(text, spaces + 1);
      const rect = range.getBoundingClientRect();
      return { left: round(rect.left), top: round(rect.top), height: round(rect.height) };
    }
    return null;
  });
  const labels = chips.map((chip) => chip.querySelector(".plugin-chip-label") as HTMLElement);
  const labelOverflow = labels.map((label) => Math.round((label.scrollWidth - label.clientWidth) * 100) / 100);
  /* 跨行降级的取证（2026-10-29）：镜像层里只允许两种「mention 的画法」——
     ① 芯片画在原文片段上（原文透明由芯片代替），或 ② 原文自己可见（芯片收起）。
     既透明又没芯片 = 不可见字符占位；画了芯片却对应多段片段 = 半枚芯片盖住一段、
     另一段仍是隐形文字。两条都在这里当场判，不靠推断。 */
  const painted = chips.map((chip) => {
    const style = getComputedStyle(chip);
    const rect = chip.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
  });
  const fragmentRects = spans.map((span) => Array.from(span.getClientRects()).map((rect) => box(rect)));
  const colors = spans.map((span) => getComputedStyle(span).color);
  const invisiblePlaceholders = spans
    .map((span, index) => ({ text: span.textContent ?? "", color: colors[index]!, chip: painted[index] === true }))
    .filter((entry) => entry.color === "rgba(0, 0, 0, 0)" && !entry.chip)
    .map((entry) => `${entry.text}（color=${entry.color}，芯片未画）`);
  const halfChips = chips.map((chip, index) => ({ chip, index }))
    .filter(({ index }) => painted[index] === true && (fragmentRects[index]?.length ?? 0) !== 1)
    .map(({ index }) => `第 ${index + 1} 枚芯片画在 ${fragmentRects[index]?.length ?? 0} 段片段上`);
  const chip = chips[0];
  const band = chip ? getComputedStyle(chip, "::before") : null;
  const contentWidth = (style: CSSStyleDeclaration, client: number) => round(client
    - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
    - Number.parseFloat(style.borderLeftWidth) - Number.parseFloat(style.borderRightWidth));
  return {
    mention: spans.map((span) => box(span.getBoundingClientRect())),
    // 定位以「首片段」为准：mention 自己跨行时，span 的并集矩形比第一行宽。
    mentionFirst: spans.map((span) => box(span.getClientRects()[0])),
    chip: chips.map((el) => el.getBoundingClientRect()).map(box),
    chipIcon: chip ? box(chip.querySelector(".plugin-icon")!.getBoundingClientRect()) : null,
    chipLabel: chip ? box(labels[0]!.getBoundingClientRect()) : null,
    chipSplit: chips.map((el) => String(el.dataset.split)),
    labelClipped: labelOverflow.map((value) => value > 0.5),
    labelOverflow,
    afterMention,
    band: band === null ? null : { height: band.height, background: band.backgroundColor,
      radius: band.borderRadius, left: band.left, right: band.right },
    // 光标对得上文字的唯一前提：两侧逐项同参数。
    parity: {
      fontFamily: same(taStyle.fontFamily, mStyle.fontFamily),
      fontSize: same(taStyle.fontSize, mStyle.fontSize),
      lineHeight: same(taStyle.lineHeight, mStyle.lineHeight),
      paddingTop: same(taStyle.paddingTop, mStyle.paddingTop),
      paddingLeft: same(taStyle.paddingLeft, mStyle.paddingLeft),
      borderLeft: same(taStyle.borderLeftWidth, mStyle.borderLeftWidth),
      whiteSpace: same(taStyle.whiteSpace, mStyle.whiteSpace),
      overflowWrap: same(taStyle.overflowWrap, mStyle.overflowWrap),
      contentWidth: contentWidth(taStyle, textarea.clientWidth) === contentWidth(mStyle, mirror.clientWidth),
      textareaContentWidth: contentWidth(taStyle, textarea.clientWidth),
      mirrorContentWidth: contentWidth(mStyle, mirror.clientWidth)
    },
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    mirrorClip: box(mirror.getBoundingClientRect()),
    textColor: taStyle.color,
    chipPainted: painted,
    mentionFragments: fragmentRects.map((rects) => rects.length),
    mentionFragmentRects: fragmentRects,
    mentionVisible: colors.map((color) => color !== "rgba(0, 0, 0, 0)"),
    mentionColors: colors,
    invisiblePlaceholders,
    halfChips,
    mirrorWhiteSpace: mStyle.whiteSpace,
    mirrorScrollHeight: mirror.scrollHeight,
    // 两侧内容高度必须一致：镜像层显示原文（降级态）后仍与 textarea 排同一套行，
    // 这就是「光标落在看得见的位置」的唯一可证形式。
    textareaScrollHeight: textarea.scrollHeight,
    // 芯片是镜像层的子节点，它自己的名称文字不算正文：只拼非芯片子树。
    mirrorText: Array.from(mirror.childNodes)
      .filter((node) => !(node.nodeType === 1 && (node as Element).classList.contains("chat-command-chip")))
      .map((node) => node.textContent ?? "").join("")
  };
}

/**
 * 填草稿并等芯片挂上镜像层。
 * 这里只等 **attached** 不等 visible：跨行降级态下芯片按设计 `display:none`
 * （2026-10-29），可见性属于各条断言自己的判据（`chipPainted`），不能当成填完的
 * 前置条件，否则一降级就变成等待超时。
 */
async function fillDraft(page: Page, value: string, chipKeys: string[]): Promise<void> {
  const draft = page.getByTestId("assist-draft");
  await draft.click();
  await draft.fill(value);
  for (const key of chipKeys) {
    await expect(page.locator(`[data-plugin-chip="${key}"]`)).toBeAttached({ timeout: 5_000 });
  }
  await page.waitForTimeout(150);
}

/** 镜像层不变量：任何一枚 mention 要么由画出来的芯片代替、要么原文自己可见。 */
function expectNoInvisiblePlaceholder(m: Composer, where: string): void {
  expect(m.invisiblePlaceholders, `${where}：出现「透明原文 + 没画芯片」的不可见占位`)
    .toEqual([]);
  expect(m.halfChips, `${where}：芯片画在多段片段上（半枚芯片盖一段、其余隐形）`).toEqual([]);
  m.chipPainted.forEach((painted, index) => {
    if (!painted) {
      expect(m.mentionVisible[index], `${where}：芯片收起时原文必须自己可见`).toBe(true);
      expect(m.mentionFragments[index], `${where}：不画芯片的 mention 才是被折行拆开的`)
        .toBeGreaterThan(1);
      return;
    }
    expect(m.mentionFragments[index], `${where}：画芯片的 mention 只允许一段片段`).toBe(1);
    const fragment = m.mentionFragmentRects[index]![0]!, chip = m.chip[index]!;
    expect(Math.abs(chip.l - fragment.l), `${where}：芯片左缘贴片段左缘`).toBeLessThanOrEqual(1);
    expect(Math.abs(chip.w - fragment.w), `${where}：芯片宽度 = 片段字宽`).toBeLessThanOrEqual(1);
    expect(chip.r - fragment.r, `${where}：芯片右缘不越过片段`).toBeLessThanOrEqual(0.5);
  });
  expect(m.mirrorWhiteSpace, `${where}：镜像层不得用 nowrap 假装不折行（会让光标与文字分叉）`)
    .toBe("pre-wrap");
  expect(m.parity.whiteSpace, `${where}：两侧折行规则必须同源`).toBe(true);
  expect(m.parity.overflowWrap, `${where}：两侧断词规则必须同源`).toBe(true);
  expect(m.parity.textareaContentWidth, `${where}：两侧内容宽必须同值`).toBe(m.parity.mirrorContentWidth);
}

/**
 * 降级必须是**布局中性**的：把某枚 mention 的画法从「芯片盖住透明原文」切成
 * 「原文自己可见」，镜像层里每个文字片段的矩形都不许动一个像素。动了就说明显示方式
 * 参与了排版——那正是「只在镜像层禁止换行」会把光标与可见文字拉开的原因。
 * 现场只改 `data-chip`，量完立即还原，不留在 DOM 里。
 */
async function expectDegradationIsLayoutNeutral(page: Page, where: string): Promise<void> {
  const diff = await page.evaluate(() => {
    const result = { moved: 0, notRestored: 0, fragments: 0, reason: "" };
    const mirror = document.querySelector(".chat-command-mirror") as HTMLElement | null;
    if (mirror === null) { result.reason = "镜像层不在（没有 mention 可切）"; return result; }
    const snapshot = () => {
      const rects: string[] = [];
      const walker = document.createTreeWalker(mirror, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node as Text;
        if ((text.parentElement?.closest(".chat-command-chip") ?? null) !== null) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        for (const rect of Array.from(range.getClientRects())) {
          rects.push(`${Math.round(rect.left * 100) / 100},${Math.round(rect.top * 100) / 100},`
            + `${Math.round(rect.width * 100) / 100},${Math.round(rect.height * 100) / 100}`);
        }
      }
      return rects;
    };
    const spans = Array.from(mirror.querySelectorAll<HTMLElement>("[data-mention-start]"));
    const before = snapshot();
    const original = spans.map((span) => span.dataset.chip ?? null);
    spans.forEach((span) => { span.dataset.chip = "off"; });
    const degraded = snapshot();
    spans.forEach((span, index) => {
      if (original[index] === null) delete span.dataset.chip; else span.dataset.chip = original[index]!;
    });
    const restored = snapshot();
    result.fragments = before.length;
    if (before.length !== degraded.length) {
      result.reason = `片段数从 ${before.length} 变成 ${degraded.length}`;
      return result;
    }
    result.moved = before.filter((value, index) => value !== degraded[index]).length;
    result.notRestored = before.filter((value, index) => value !== restored[index]).length;
    return result;
  });
  expect(diff.reason, `${where}：降级切换前后的片段可比性`).toBe("");
  expect(diff.moved, `${where}：降级不得移动任何文字片段（移动即光标与可见文字分叉）`).toBe(0);
  expect(diff.notRestored, `${where}：现场必须能完整还原（不留强制态）`).toBe(0);
  expect(diff.fragments, `${where}：至少量到一段文字`).toBeGreaterThan(0);
}

test("① 单枚芯片＝原文矩形：位置误差 ≤1px，右缘不越过原文终点，容器按 token 画", async ({ page }) => {
  await openConversation(page);
  await fillDraft(page, "@电脑操控 打开记事本", ["computer"]);
  const m = await page.evaluate(measureComposer) as unknown as Composer;
  const mention = m.mentionFirst[0]!, chip = m.chip[0]!, after = m.afterMention[0];

  expect(m.parity, `镜像层与 textarea 必须逐项同参数：${JSON.stringify(m.parity)}`).toEqual(expect.objectContaining({
    fontFamily: true, fontSize: true, lineHeight: true, paddingTop: true, paddingLeft: true,
    borderLeft: true, whiteSpace: true, overflowWrap: true, contentWidth: true
  }));
  expect(m.parity.textareaContentWidth, "内容宽一致才算同参数").toBe(m.parity.mirrorContentWidth);
  expectNoInvisiblePlaceholder(m, "单枚芯片");
  expect(m.chipPainted, "这一档没有跨行，芯片照旧画出来").toEqual([true]);

  expect(Math.abs(chip.l - mention.l), "芯片左缘对齐原文左缘").toBeLessThanOrEqual(1);
  expect(Math.abs(chip.t - mention.t), "芯片顶对齐原文行盒").toBeLessThanOrEqual(1);
  // 这一条就是 P0 的核心：芯片宽度 = 原文 `@标签` 的字宽，不是图标+名称的固有宽度。
  expect(Math.abs(chip.w - mention.w), `芯片宽度应等于原文字宽（原文 ${mention.w}，芯片 ${chip.w}）`)
    .toBeLessThanOrEqual(1);
  expect(chip.r - mention.r, "芯片右缘不得越过原文终点（越过即盖住后面的正文）").toBeLessThanOrEqual(0.5);
  expect(chip.h, "芯片高度＝原文行盒高度").toBeCloseTo(mention.h, 0);
  if (after !== null) {
    expect(after.left - chip.r, "芯片与后续正文之间不得重叠").toBeGreaterThanOrEqual(0);
    expect(Math.abs(after.top - chip.t), "芯片与后续正文同一行").toBeLessThanOrEqual(1);
  }

  const icon = m.chipIcon!, label = m.chipLabel!;
  expect(icon.w, "编辑态图标 body 档 16px（2026-10-25 用户指认 14px 太小，与 @ 菜单行同档）").toBeCloseTo(16, 0);
  expect(label.w, "名称可读且没被图标挤掉（meta 档 4 字 ≈56px）").toBeGreaterThan(40);
  expect(label.r, "名称右缘在芯片之内").toBeLessThanOrEqual(chip.r + 0.5);
  expect(m.labelClipped, `名称不得被裁成省略号（溢出 ${m.labelOverflow[0]}px）`).toEqual([false]);
  expect(icon.t + icon.h / 2, "图标与名称垂直居中同一中线").toBeCloseTo(label.t + label.h / 2, 0);

  const band = m.band!;
  expect(Number.parseFloat(band.height), "容器高 = body × lineHeight.snug（21.6px 档）").toBeCloseTo(21.6, 1);
  expect(band.radius, "容器用 radius.badge").toBe("6px");
  expect(band.left, "容器贴芯片左缘").toBe("0px");
  expect(band.right, "容器贴芯片右缘").toBe("0px");
  expect(band.background, "容器底用 selection.bg token").toBe("rgb(237, 245, 239)");
  await page.screenshot({ path: `${shots}/editing-single-chip.png` });
  await page.locator(".agent-chat-composer").screenshot({ path: `${shots}/closeup-editing-single.png` });
});

test("② 相邻两枚芯片：各占自己的原文字宽，互不遮挡、间距自然", async ({ page }) => {
  await openConversation(page);
  await fillDraft(page, "@GitHub @浏览器操控 两个都要", ["github", "browser"]);
  const m = await page.evaluate(measureComposer) as unknown as Composer;
  const mentions = m.mentionFirst, chips = m.chip;
  expect(chips.length).toBe(2);
  chips.forEach((chip, index) => {
    expect(Math.abs(chip.l - mentions[index]!.l), `第 ${index + 1} 枚左缘`).toBeLessThanOrEqual(1);
    expect(Math.abs(chip.w - mentions[index]!.w), `第 ${index + 1} 枚宽度`).toBeLessThanOrEqual(1);
  });
  expect(chips[0]!.r, "第一枚不得盖到第二枚").toBeLessThan(chips[1]!.l);
  expect(chips[1]!.l - chips[0]!.r, "两枚之间的空隙就是原文里的那个空格").toBeGreaterThan(2);
  expect(m.chipSplit, "两枚都不跨行").toEqual(["false", "false"]);
  expect(m.labelClipped, "两枚的名称都完整").toEqual([false, false]);
  expectNoInvisiblePlaceholder(m, "相邻两枚");
  await page.screenshot({ path: `${shots}/editing-two-chips.png` });
});

test("③ 手动粘连两枚（无空格）：仍然各占各的字宽，不互相吞掉", async ({ page }) => {
  await openConversation(page);
  await fillDraft(page, "@GitHub@浏览器操控", ["github", "browser"]);
  const m = await page.evaluate(measureComposer) as unknown as Composer;
  const mentions = m.mentionFirst, chips = m.chip;
  expect(chips.length).toBe(2);
  chips.forEach((chip, index) => {
    expect(Math.abs(chip.w - mentions[index]!.w), `第 ${index + 1} 枚宽度贴着原文`).toBeLessThanOrEqual(1);
    expect(chip.r - chip.l).toBeGreaterThan(0);
  });
  expect(chips[0]!.r - chips[1]!.l, "粘连时第一枚不得越过第二枚起点").toBeLessThanOrEqual(0.5);
});

test("④ 芯片位于行尾与行首：不被容器裁切，不横向溢出", async ({ page }) => {
  for (const width of [390, 768, 1162]) {
    await openConversation(page, [], width);
    await fillDraft(page, "@电脑操控 把这行字写得足够长好让芯片正好落在行尾的位置上看看会不会被裁掉", ["computer"]);
    const m = await page.evaluate(measureComposer) as unknown as Composer;
    const chip = m.chip[0]!;
    expectNoInvisiblePlaceholder(m, `${width}px 行尾芯片`);
    expect(m.chipPainted, `${width}px 行首 mention 不被拆开，芯片照旧画`).toEqual([true]);
    expect(m.overflowX, `${width}px 视口不得横向溢出`).toBe(false);
    expect(chip.l, `${width}px 芯片左缘在镜像层内`).toBeGreaterThanOrEqual(m.mirrorClip.l - 0.5);
    expect(chip.r, `${width}px 芯片右缘在镜像层内`).toBeLessThanOrEqual(m.mirrorClip.r + 0.5);
    expect(chip.l, `${width}px 芯片不越过原文起点`).toBeGreaterThanOrEqual(m.mentionFirst[0]!.l - 1);
    if (width === 390) await page.screenshot({ path: `${shots}/editing-390px.png` });
    if (width === 768) await page.screenshot({ path: `${shots}/editing-768px.png` });
  }
});

test("⑤ 多行长文本与跨行 mention：不拆时芯片跟随片段，拆了整枚收起、原文可见", async ({ page }) => {
  await openConversation(page);
  const long = "请先核对这一段的验收条件与依赖关系，再决定要不要落到台账里，"
    + "然后继续下一段的优先级排列，最后把结论汇总成三条可以执行的下一步。";
  await fillDraft(page, `${long}@浏览器操控 继续`, ["browser"]);
  const m = await page.evaluate(measureComposer) as unknown as Composer;
  expectNoInvisiblePlaceholder(m, "1162px 长文本换行");
  await expectDegradationIsLayoutNeutral(page, "1162px 长文本换行");
  const mention = m.mentionFirst[0]!, chip = m.chip[0]!;
  expect(m.mentionFragments[0], "这一档宽度下 mention 自己没被折行拆开，芯片照旧画").toBe(1);
  expect(m.chipPainted, "芯片画出来了").toEqual([true]);
  expect(Math.abs(chip.l - mention.l), "换行后芯片仍贴在原文片段上").toBeLessThanOrEqual(1);
  expect(Math.abs(chip.t - mention.t), "换行后芯片仍贴在原文行盒上").toBeLessThanOrEqual(1);
  expect(Math.abs(chip.w - mention.w), "换行后芯片宽度仍是原文字宽").toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${shots}/editing-long-text-wrap.png` });

  // mention 自己跨过行首（窄容器 + 逐个加长前缀，直到 textarea 真的把它拆成两段）：
  // 芯片整枚收起、原文 `@浏览器操控` 恢复可见——不留半枚图标，也不留不可见占位。
  await page.setViewportSize({ width: 390, height: 782 });
  await page.waitForTimeout(250);
  let split = null as Composer | null;
  let splitValue = "";
  for (let length = 1; length <= 26 && split === null; length += 1) {
    const value = `核${"对".repeat(length)}@浏览器操控 继续`;
    await fillDraft(page, value, ["browser"]);
    const candidate = await page.evaluate(measureComposer) as unknown as Composer;
    if (candidate.chipSplit[0] === "true") { split = candidate; splitValue = value; }
  }
  expect(split, "窄容器里应能构造出跨行的 mention").not.toBeNull();
  const found = split!;
  expectNoInvisiblePlaceholder(found, `390px 跨行「${splitValue}」`);
  await expectDegradationIsLayoutNeutral(page, `390px 跨行「${splitValue}」`);
  const splitMention = found.mention[0]!, splitFirst = found.mentionFragmentRects[0]![0]!;
  expect(found.chipPainted, "跨行时芯片整枚不画（半枚图标比原文更难读）").toEqual([false]);
  expect(found.chip[0]!.w, "收起的芯片不占任何版面").toBe(0);
  expect(found.mentionVisible, "跨行时原文自己可见").toEqual([true]);
  expect(found.mentionColors[0], "原文用的是镜像层正文色，不是透明").not.toBe("rgba(0, 0, 0, 0)");
  expect(found.mirrorText, "降级不改一个字符：镜像层文字与草稿逐字相同").toBe(splitValue);
  expect(splitMention.h, "该 mention 确实跨了两行").toBeGreaterThan(splitFirst.h + 1);
  expect(splitMention.w, "两行片段的并集比首片段宽").toBeGreaterThan(splitFirst.w + 1);
  found.mentionFragmentRects[0]!.forEach((fragment, index) => {
    expect(fragment.w, `第 ${index + 1} 段片段有实际字宽（看得见，不是隐形占位）`).toBeGreaterThan(0);
    expect(fragment.h, `第 ${index + 1} 段片段是一个完整行盒`).toBeGreaterThan(10);
  });
  const second = found.mentionFragmentRects[0]![1]!;
  expect(second.t, "第二段片段落在下一行，与首段不重叠").toBeGreaterThanOrEqual(found.mentionFragmentRects[0]![0]!.b - 1);
  await page.screenshot({ path: `${shots}/editing-390px-long-text.png` });
  await page.locator(".agent-chat-composer").screenshot({ path: `${shots}/closeup-split-original.png` });
});

/* ⑭ 全位置扫描（2026-10-29 用户要求「任何位置都不出现不可见的字符占位或半枚芯片」）：
   同一句草稿在三档视口宽度下逐个加长前缀，把 mention 从「行首」一路推到「被折行拆成
   两段、三段」，每一档都跑一遍不变量。这里不预设哪个长度会跨行——跨行点由容器与字体
   决定，写死就会随环境漂移；扫描负责证明「无论落在哪种形态，都没有隐形占位」。 */
test("⑭ 扫描跨行点：每一档宽度/长度下，芯片与原文恰有其一可见", async ({ page }) => {
  const report: Record<string, { painted: number; degraded: number; fragments: number[] }> = {};
  for (const width of [390, 768, 1162]) {
    await openConversation(page, [], width);
    const buckets = { painted: 0, degraded: 0, fragments: [] as number[] };
    for (let length = 0; length <= 20; length += 1) {
      const value = `先${"核对".repeat(length)}@电脑操控 打开记事本`;
      await fillDraft(page, value, ["computer"]);
      const m = await page.evaluate(measureComposer) as unknown as Composer;
      expectNoInvisiblePlaceholder(m, `${width}px / 前缀 ${length}「${value}」`);
      expect(m.chipPainted.length, "一枚 mention 对应一枚芯片节点").toBe(1);
      if (m.chipPainted[0]) buckets.painted += 1; else buckets.degraded += 1;
      buckets.fragments.push(m.mentionFragments[0]!);
      if (width === 390 && length === 20) {
        await page.screenshot({ path: `${shots}/sweep-390px-degraded.png` });
      }
    }
    report[`${width}px`] = buckets;
    await expectDegradationIsLayoutNeutral(page, `${width}px 扫描末态`);
    expect(buckets.degraded + buckets.painted, "每档长度都被判过").toBe(21);
  }
  console.log("跨行扫描分档 " + JSON.stringify(report));
  expect(Object.values(report).every((buckets) => buckets.painted > 0 && buckets.degraded > 0),
    `每一档宽度都要同时扫出「画芯片」与「降级显示原文」两种形态：${JSON.stringify(report)}`).toBe(true);
});

test("⑥ 框内滚动：芯片跟随原文，滚动后仍然逐像素贴在原位", async ({ page }) => {
  await openConversation(page);
  const sentence = "帮我逐段核对这份安排的优先级、依赖与验收条件，";
  const scrollable = () => page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement;
    return textarea.offsetHeight < textarea.scrollHeight;
  });
  /* 折点由容器宽与字宽决定，写死的重复数可能恰好把 mention 拆在行首——那正是 ⑤/⑭ 的
     降级形态，芯片按设计不画，就不能再拿它量滚动跟随。这里先扫几档重复数，取一个
     「框内可滚动且 mention 完整成一段」的样本，再量跟随。 */
  let chosen = null as string | null;
  for (let repeat = 8; repeat <= 16 && chosen === null; repeat += 1) {
    const value = `${sentence.repeat(repeat)}@电脑操控 ${sentence.repeat(repeat + 4)}`;
    await fillDraft(page, value, ["computer"]);
    const candidate = await page.evaluate(measureComposer) as unknown as Composer;
    if (candidate.mentionFragments[0] === 1 && candidate.chipPainted[0] === true && await scrollable()) chosen = value;
  }
  expect(chosen, "应能构造出「框内滚动 + mention 不被折行拆开」的样本").not.toBeNull();
  await fillDraft(page, chosen!, ["computer"]);
  expect(await scrollable(), "夹具应产生框内滚动").toBe(true);

  const trace: { top: number; scrollTop: number }[] = [];
  for (let step = 0; step < 4; step += 1) {
    await page.evaluate(() => {
      const textarea = document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement;
      textarea.scrollTop = textarea.scrollTop + 40;
      textarea.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.waitForTimeout(80);
    const m = await page.evaluate(measureComposer) as unknown as Composer;
    const mention = m.mentionFirst[0]!, chip = m.chip[0]!;
    expectNoInvisiblePlaceholder(m, `第 ${step + 1} 次滚动后`);
    expect(m.chipPainted, `第 ${step + 1} 次滚动后芯片仍画着（滚动不改变折行）`).toEqual([true]);
    expect(Math.abs(chip.t - mention.t), `第 ${step + 1} 次滚动后顶缘跟随`).toBeLessThanOrEqual(1);
    expect(Math.abs(chip.l - mention.l), `第 ${step + 1} 次滚动后左缘跟随`).toBeLessThanOrEqual(1);
    expect(Math.abs(chip.w - mention.w), `第 ${step + 1} 次滚动后宽度不变`).toBeLessThanOrEqual(1);
    trace.push({ top: chip.t, scrollTop: await page.evaluate(() =>
      (document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement).scrollTop) });
  }
  for (let step = 1; step < trace.length; step += 1) {
    const moved = trace[step]!.scrollTop - trace[step - 1]!.scrollTop;
    expect(trace[step - 1]!.top - trace[step]!.top,
      `芯片上移的距离就是这一轮真正滚掉的 ${moved}px（不滞后、不超冲）`)
      .toBeCloseTo(moved, 0);
  }
  expect(trace[trace.length - 1]!.scrollTop, "夹具确实滚起来了").toBeGreaterThan(0);
  await page.screenshot({ path: `${shots}/editing-scrolled.png` });
});

test("⑦ 字号 100% / 125% / 150%：芯片始终等于原文字宽，容器不越界", async ({ page }) => {
  await openConversation(page);
  for (const percent of [100, 125, 150]) {
    await page.evaluate((scale) => { document.documentElement.style.fontSize = `${16 * scale / 100}px`; }, percent);
    await page.waitForTimeout(200);
    await fillDraft(page, `@浏览器操控 @GitHub 缩放 ${percent}%`, ["browser", "github"]);
    const m = await page.evaluate(measureComposer) as unknown as Composer;
    expectNoInvisiblePlaceholder(m, `${percent}% 字号缩放`);
    expect(m.chipPainted, `${percent}% 两枚都画出来（短草稿不该被折行拆开）`).toEqual([true, true]);
    m.chip.forEach((chip, index) => {
      expect(Math.abs(chip.w - m.mentionFirst[index]!.w), `${percent}% 第 ${index + 1} 枚宽度`)
        .toBeLessThanOrEqual(1);
      expect(chip.r - m.mentionFirst[index]!.r, `${percent}% 第 ${index + 1} 枚右缘`).toBeLessThanOrEqual(0.5);
    });
    expect(m.labelClipped, `${percent}% 名称都完整（溢出 ${JSON.stringify(m.labelOverflow)}）`)
      .toEqual([false, false]);
    expect(m.chipLabel!.w, `${percent}% 名称按字号等比放大`).toBeGreaterThan(40);
    await page.screenshot({ path: `${shots}/editing-zoom-${percent}.png` });
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
});

test("⑧ 芯片后面接着输入中文：文本衔接、光标落在原文终点，不出现覆盖", async ({ page }) => {
  await openConversation(page);
  const draft = page.getByTestId("assist-draft");
  await fillDraft(page, "@电脑操控", ["computer"]);
  const before = await page.evaluate(measureComposer) as unknown as Composer;
  expect(before.afterMention, "芯片后面暂时没有正文").toEqual([null]);

  await page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
  // 真实插入（走 beforeinput/input，与中文组词提交后的落字同一条路径）。
  await page.keyboard.insertText(" 打开记事本");
  await expect(draft).toHaveValue("@电脑操控 打开记事本", { timeout: 5_000 });
  await page.waitForTimeout(150);
  const m = await page.evaluate(measureComposer) as unknown as Composer;
  const chip = m.chip[0]!, after = m.afterMention[0]!;
  expect(after.left - chip.r, "中文正文从芯片右缘之后开始，不被压住").toBeGreaterThanOrEqual(0);
  expect(Math.abs(after.left - chip.r), "原文字宽与芯片宽同步（间距就是一个空格）").toBeLessThanOrEqual(9);
  expect(chip.w, "芯片宽度 = 原文字宽").toBe(m.mentionFirst[0]!.w);
  expect(m.chipSplit, "不跨行").toEqual(["false"]);

  // 光标紧贴芯片右缘后继续退格：删的是正文，芯片与 mention 原文都保持完整。
  await page.keyboard.press("Backspace");
  await expect(draft).toHaveValue("@电脑操控 打开记事", { timeout: 5_000 });
  await expect(page.locator('[data-plugin-chip="computer"]')).toBeVisible();
  const back = await page.evaluate(measureComposer) as unknown as Composer;
  expect(back.chip[0]!.w, "退格不改芯片宽度").toBe(chip.w);
});

test("⑨ 中文输入法组词：期间不弹插件菜单、不预置选区、不拆芯片", async ({ page }) => {
  await openConversation(page);
  const draft = page.getByTestId("assist-draft");
  await fillDraft(page, "@电脑操控 ", ["computer"]);
  const cdp = await page.context().newCDPSession(page);
  await draft.click();
  await page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
  // 真 IME 路径：组词串进 textarea，候选尚未提交。
  await cdp.send("Input.imeSetComposition", { text: "da", selectionStart: 2, selectionEnd: 2 });
  await page.waitForTimeout(150);
  expect(await page.locator('[data-testid="chat-mention-menu"]').count(), "组词期间不弹插件菜单").toBe(0);
  const during = await page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement;
    return { value: textarea.value, chip: document.querySelectorAll(".chat-command-mirror .chat-command-chip").length,
      selection: [textarea.selectionStart, textarea.selectionEnd] };
  });
  expect(during.chip, "组词不动芯片").toBe(1);
  expect(during.selection[0], "组词期间不预置整枚选区").not.toBe(0);
  await cdp.send("Input.insertText", { text: "打开" });
  await expect(draft).toHaveValue("@电脑操控 打开", { timeout: 5_000 });
  const after = await page.evaluate(measureComposer) as unknown as Composer;
  expect(Math.abs(after.chip[0]!.w - after.mentionFirst[0]!.w), "提交后芯片仍贴原文").toBeLessThanOrEqual(1);
  expect(after.chipSplit, "提交后不跨行").toEqual(["false"]);
  await cdp.detach();
});

test("⑩ 聚焦态与发送中（禁用态）：一层可见文字，无重影、灰度一致", async ({ page }) => {
  await openConversation(page);
  const draft = page.getByTestId("assist-draft");
  await fillDraft(page, "@电脑操控 帮我截图", ["computer"]);
  await page.screenshot({ path: `${shots}/editing-focused.png` });
  await page.locator(".agent-chat-composer").screenshot({ path: `${shots}/closeup-editing-focused.png` });

  const layers = () => page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement;
    const mirror = document.querySelector(".chat-command-mirror") as HTMLElement;
    const chip = document.querySelector(".chat-command-chip") as HTMLElement;
    const style = getComputedStyle(textarea);
    return { textareaColor: style.color,
      fill: (style as CSSStyleDeclaration & { webkitTextFillColor: string }).webkitTextFillColor,
      caret: style.caretColor,
      mirrorColor: getComputedStyle(mirror).color,
      chipColor: getComputedStyle(chip).color,
      chipLabelColor: getComputedStyle(chip.querySelector(".plugin-chip-label")!).color,
      disabled: textarea.disabled };
  });
  const focused = await layers();
  expect(focused.textareaColor, "芯片态：原文透明，只有镜像层一层字").toBe("rgba(0, 0, 0, 0)");
  expect(focused.caret, "光标仍用主题前景色，不能跟着透明").toBe("rgb(32, 51, 41)");

  await page.route(`${prefix}/assist-sessions/${sessionId}/messages`, () => new Promise(() => {}));
  await page.getByTestId("assist-send").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement).disabled,
    undefined, { timeout: 10_000 });
  await page.waitForTimeout(200);
  const pending = await layers();
  expect(pending.disabled).toBe(true);
  expect(pending.textareaColor, "发送中仍只有一层字（无原文重影）").toBe("rgba(0, 0, 0, 0)");
  expect(pending.fill, "发送中不得用 -webkit-text-fill-color 把原文画回来").toBe("rgba(0, 0, 0, 0)");
  expect(pending.mirrorColor, "禁用/发送中的灰由镜像层承担").toBe("rgb(85, 103, 93)");
  expect(pending.chipColor, "芯片名称同步转禁用灰").toBe("rgb(85, 103, 93)");
  expect(pending.chipLabelColor, "名称继承芯片色，不留原色").toBe("rgb(85, 103, 93)");
  await page.screenshot({ path: `${shots}/editing-disabled.png` });
  await page.locator(".agent-chat-composer").screenshot({ path: `${shots}/closeup-editing-disabled.png` });
  expect(await draft.inputValue(), "发送中草稿与芯片都留在输入框里（不是清空后重画）").toBe("@电脑操控 帮我截图");
  expect(await page.locator(".chat-command-mirror .chat-command-chip").count(), "发送中芯片数量不变").toBe(1);
});

test("⑪ 消息只读态：图标+名称与正文同流，不显示 @，不给气泡撑高", async ({ page }) => {
  await openConversation(page, [
    message(userMessageId, "1", "USER", "@电脑操控 打开记事本"),
    message(plainMessageId, "2", "USER", "电脑操控 打开记事本")
  ]);
  await page.locator("[data-plugin-mention=\"computer\"]").waitFor({ timeout: 20_000 });
  const m = await page.evaluate(() => {
    const round = (value: number) => Math.round(value * 100) / 100;
    const box = (el: Element) => { const r = el.getBoundingClientRect();
      return { l: round(r.left), t: round(r.top), r: round(r.right), b: round(r.bottom),
        w: round(r.width), h: round(r.height) }; };
    const chip = document.querySelector("[data-plugin-mention=\"computer\"]") as HTMLElement;
    const rich = chip.closest(".assist-message-content") as HTMLElement;
    const all = Array.from(document.querySelectorAll<HTMLElement>(".assist-message-content"));
    const plain = all.find((el) => el.textContent === "电脑操控 打开记事本" && !el.querySelector("[data-plugin-mention]"))!;
    const icon = chip.querySelector(".plugin-icon") as HTMLElement;
    const label = chip.querySelector(".plugin-chip-label") as HTMLElement;
    const band = getComputedStyle(chip, "::before");
    // 同一条消息里 mention 之后的正文（真实文本节点）行盒。
    const tail = Array.from(rich.childNodes).find((node) => node.nodeType === 3
      && (node as Text).data.includes("打开")) as Text;
    const range = document.createRange();
    range.setStart(tail, 1);
    range.setEnd(tail, 2);
    const tailRect = range.getBoundingClientRect();
    const chipBox = box(chip), richBox = box(rich);
    return {
      chip: chipBox, icon: box(icon), label: box(label),
      tail: { l: round(tailRect.left), t: round(tailRect.top), h: round(tailRect.height) },
      rich: richBox, plain: box(plain),
      lineHeight: getComputedStyle(rich).lineHeight,
      // 标识左缘 = 气泡内容盒左缘（padding + border 之后），也就是文字本该开始的地方。
      inset: round(chipBox.l - richBox.l),
      contentInset: round(Number.parseFloat(getComputedStyle(rich).paddingLeft)
        + Number.parseFloat(getComputedStyle(rich).borderLeftWidth)),
      text: rich.textContent,
      style: { fontSize: getComputedStyle(chip).fontSize, display: getComputedStyle(chip).display,
        color: getComputedStyle(chip).color, band: band.backgroundColor, radius: band.borderRadius,
        bandHeight: band.height, gap: getComputedStyle(chip).gap },
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1
    };
  });
  expect(m.text, "展示态不显示 @，正文原样跟在标识之后").toBe("电脑操控 打开记事本");
  expect(m.rich.h, "带标识的单行消息与同样文字的纯文本消息等高（标识不撑高气泡）").toBe(m.plain.h);
  expect(m.chip.h, "标识行盒 = 正文行盒（16px × 1.5），不给气泡多出一行").toBe(Number(m.lineHeight.replace("px", "")));
  expect(m.icon.w, "只读态图标与正文同档（body 16px）").toBe(16);
  expect(m.style.fontSize, "只读态名称 = body 字号").toBe("16px");
  expect(Number.parseFloat(m.style.bandHeight), "容器底比行盒略矮（snug 档 21.6px）").toBeCloseTo(21.6, 1);
  expect(m.style.radius, "同一套容器圆角").toBe("6px");
  expect(m.style.color, "同一套标识色").toBe("rgb(32, 93, 71)");
  expect(m.label.t + m.label.h / 2, "名称与正文同一垂直中线（基线不跳）")
    .toBeCloseTo(m.tail.t + m.tail.h / 2, 0);
  expect(m.tail.l - m.chip.r, "标识与后续正文同流、不重叠").toBeGreaterThanOrEqual(0);
  expect(m.inset, "标识起点就是气泡内容起点（padding + border 之后，不额外缩进）")
    .toBe(m.contentInset);
  expect(m.overflowX).toBe(false);
  await page.screenshot({ path: `${shots}/message-static-chip.png` });
  await page.locator('.agent-message[data-role="USER"]').first()
    .screenshot({ path: `${shots}/closeup-message-static.png` });
});

test("⑫ 重新加载：同一份历史再读一次仍按原文显示，展示层不含 @", async ({ page }) => {
  const content = "先用 @电脑操控 截图，再 @GitHub 看仓库，最后 @浏览器操控 打开页面";
  await openConversation(page, [message(userMessageId, "1", "USER", content)]);
  await page.locator("[data-plugin-mention]").first().waitFor({ timeout: 20_000 });
  const shown = await page.evaluate(() => document.querySelector(".assist-message-content")!.textContent);
  expect(shown, "展示层只去掉 @，其余文字一字不改").toBe(content.replace(/@(电脑操控|GitHub|浏览器操控)/gu, "$1"));
  expect(shown).not.toContain("@");
  const chips = await page.evaluate(() => Array.from(document.querySelectorAll("[data-plugin-mention]"))
    .map((el) => el.getAttribute("data-plugin-mention")));
  expect(chips, "三枚标识按出现顺序识别").toEqual(["computer", "github", "browser"]);
  // 重新进入会话（再次加载同一夹具）得到同一显示，不因为插件改变历史读取。
  // 这里只证「重新加载后仍是同一显示」；真实发送回显与真正的撤回是 ⑯ 的两种状态。
  await page.reload({ waitUntil: "domcontentloaded" });
  await connect(page);
  await page.locator("[data-plugin-mention]").first().waitFor({ timeout: 20_000 });
  expect(await page.evaluate(() => document.querySelectorAll("[data-plugin-mention]").length)).toBe(3);
  expect(await page.evaluate(() => document.querySelector(".assist-message-content")!.textContent)).toBe(shown);
});

test("⑬ 可读性与高对比：标识文字对容器底达到 AA，forced-colors 下补系统描边", async ({ page }) => {
  await openConversation(page, [message(userMessageId, "1", "USER", "@电脑操控 打开记事本")]);
  await page.locator("[data-plugin-mention=\"computer\"]").waitFor({ timeout: 20_000 });
  const ratio = await page.evaluate(() => {
    const parse = (value: string) => (value.match(/\d+(\.\d+)?/gu) ?? []).slice(0, 3).map(Number);
    const channel = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const luminance = (rgb: number[]) => 0.2126 * channel(rgb[0]!) + 0.7152 * channel(rgb[1]!) + 0.0722 * channel(rgb[2]!);
    const contrast = (a: string, b: string) => {
      const l1 = luminance(parse(a)), l2 = luminance(parse(b));
      return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
    };
    const chip = document.querySelector("[data-plugin-mention=\"computer\"]") as HTMLElement;
    const content = chip.closest(".assist-message-content") as HTMLElement;
    const band = getComputedStyle(chip, "::before");
    const bubble = getComputedStyle(content).backgroundColor;
    return {
      labelOnBand: contrast(getComputedStyle(chip.querySelector(".plugin-chip-label")!).color, band.backgroundColor),
      labelOnBubble: contrast(getComputedStyle(chip.querySelector(".plugin-chip-label")!).color, bubble),
      bodyOnBubble: contrast(getComputedStyle(content).color, bubble),
      bandColor: band.backgroundColor, bubbleColor: bubble,
      bandDiffersFromBubble: band.backgroundColor !== bubble
    };
  });
  expect(ratio.labelOnBand, `标识文字对容器底：${JSON.stringify(ratio)}`).toBeGreaterThanOrEqual(4.5);
  expect(ratio.labelOnBubble, "标识文字即使落在气泡底上也读得出（容器底不是靠对比承担信息）")
    .toBeGreaterThanOrEqual(4.5);
  expect(ratio.bodyOnBubble, "正文对比度不受影响").toBeGreaterThanOrEqual(4.5);
  expect(ratio.bandDiffersFromBubble, "容器底确实画出来了（比气泡略起的色层）").toBe(true);

  // forced-colors（高对比模式）：容器只剩系统描边，标识仍成立。
  await page.emulateMedia({ forcedColors: "active" });
  await page.waitForTimeout(120);
  const forced = await page.evaluate(() => {
    const chip = document.querySelector("[data-plugin-mention=\"computer\"]") as HTMLElement;
    const band = getComputedStyle(chip, "::before");
    return { border: `${band.borderTopWidth} ${band.borderTopStyle}`, visible: chip.getBoundingClientRect().width > 0,
      label: getComputedStyle(chip.querySelector(".plugin-chip-label")!).color };
  });
  expect(forced.border, "高对比下补系统描边").toBe("1px solid");
  expect(forced.visible, "高对比下标识仍在版面上").toBe(true);
  await page.emulateMedia({ forcedColors: null });
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${shots}/message-forced-colors.png` });
});

/* ⑮ 撤销恢复（真实按键链）：芯片态的整枚删除走的是「预置选区 + 放行原生删除」，
   删除与撤销都由浏览器自己的撤销栈承担，jsdom 只能守预置那一半。这里补上后半：
   全选删除后镜像层整体消失、不留隐形文字；Ctrl+Z 回来后芯片与原文矩形重新对上。 */
test("⑮ 全选删除与 Ctrl+Z 恢复：删除后无残留，撤销后芯片重新贴回原文", async ({ page }) => {
  await openConversation(page);
  const draft = page.getByTestId("assist-draft");
  await draft.click();
  await page.keyboard.insertText("@电脑操控 打开记事本");
  await expect(draft).toHaveValue("@电脑操控 打开记事本", { timeout: 5_000 });
  const typed = await page.evaluate(measureComposer) as unknown as Composer;
  expectNoInvisiblePlaceholder(typed, "键入后的芯片态");
  expect(typed.chipPainted, "键入后芯片画着").toEqual([true]);

  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await expect(draft).toHaveValue("", { timeout: 5_000 });
  const cleared = await page.evaluate(() => ({
    mirror: document.querySelectorAll(".chat-command-mirror").length,
    chipsInDocument: document.querySelectorAll("[data-plugin-chip]").length,
    textareaColor: getComputedStyle(
      document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement).color
  }));
  expect(cleared.mirror, "删除干净后镜像层整体不渲染（不留隐形文字层）").toBe(0);
  expect(cleared.chipsInDocument, "文档里不再有任何芯片节点").toBe(0);
  expect(cleared.textareaColor, "无芯片态时 textarea 回到正常前景色（不残留透明）")
    .not.toBe("rgba(0, 0, 0, 0)");

  await page.keyboard.press("ControlOrMeta+z");
  await expect(draft).toHaveValue("@电脑操控 打开记事本", { timeout: 5_000 });
  await page.waitForTimeout(200);
  const restored = await page.evaluate(measureComposer) as unknown as Composer;
  expectNoInvisiblePlaceholder(restored, "撤销恢复后");
  expect(restored.chipPainted, "撤销后芯片重新画出来").toEqual([true]);
  expect(Math.abs(restored.chip[0]!.w - restored.mentionFirst[0]!.w), "撤销后宽度仍等于原文字宽")
    .toBeLessThanOrEqual(1);
  expect(restored.mirrorText, "撤销后的镜像层文字与草稿逐字一致").toBe("@电脑操控 打开记事本");
  await page.screenshot({ path: `${shots}/editing-after-undo.png` });

  // 跨行降级态同样能被整行删除并撤销回来：降级只是视觉，文本仍是同一条撤销栈上的原文。
  await page.setViewportSize({ width: 390, height: 782 });
  await page.waitForTimeout(250);
  let splitValue = "";
  for (let length = 1; length <= 26 && splitValue === ""; length += 1) {
    const value = `核${"对".repeat(length)}@浏览器操控 继续`;
    await fillDraft(page, value, ["browser"]);
    const candidate = await page.evaluate(measureComposer) as unknown as Composer;
    if (candidate.chipPainted[0] === false) splitValue = value;
  }
  expect(splitValue, "应能构造出跨行降级样本").not.toBe("");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await expect(draft).toHaveValue("", { timeout: 5_000 });
  expect(await page.evaluate(() => document.querySelectorAll(".chat-command-mirror").length),
    "降级态删除后也没有残留层").toBe(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(draft).toHaveValue(splitValue, { timeout: 5_000 });
  await page.waitForTimeout(200);
  const splitRestored = await page.evaluate(measureComposer) as unknown as Composer;
  expectNoInvisiblePlaceholder(splitRestored, `跨行撤销恢复「${splitValue}」`);
  expect(splitRestored.chipPainted, "撤销回来后仍是同一种降级形态（不闪出半枚芯片）").toEqual([false]);
  expect(splitRestored.mentionVisible, "原文仍可见").toEqual([true]);
});

/* ⑯ 三种状态必须分开证：
     真实发送回显 —— 走一次真 POST（202 回执）+ 重新读取消息列表，气泡里的标识由消息
                      展示层画，草稿清空、编辑态镜像层整体消失；
     重新加载     —— 同一份历史再读一次，显示逐字不变；
     真正的撤回   —— 走 recall POST（200 回执），行进入「已撤回」，原文收进折叠历史，
                      当前版面不再出现任何标识；展开历史才按同一展示层重新显示。
   前一轮的 ⑫ 只覆盖了「重新加载」这一种，容易被误读成三种都验过。 */
test("⑯ 真实发送回显 / 重新加载 / 真正撤回：三种状态分别可核对", async ({ page }) => {
  const live = liveApi();
  await openConversation(page, [], 1162, live);
  const content = "先用 @电脑操控 截图，再 @GitHub 看仓库";
  await fillDraft(page, content, ["computer", "github"]);
  const editing = await page.evaluate(measureComposer) as unknown as Composer;
  expectNoInvisiblePlaceholder(editing, "发送前的编辑态");
  expect(editing.chipPainted, "编辑态两枚芯片都画着").toEqual([true, true]);

  await page.getByTestId("assist-send").click();
  await page.locator('[data-testid="assist-recall-action-echo-user-1"]')
    .waitFor({ state: "attached", timeout: 20_000 });
  expect(live.posts.length, "发送真的提交了一次 POST /messages").toBe(1);
  expect(live.posts[0]!.body.content, "发送载荷仍是带 @ 的原文：展示层不改存储与契约")
    .toBe(content);
  const echo = await page.evaluate(measureMessages) as unknown as MessageLayer;
  const echoBlock = echo.blocks.find((block) => block.keys.length === 2)!;
  expect(echoBlock, "回显里认得出两枚标识").toBeDefined();
  expect(echoBlock.text, "回显只去掉 @，其余一字不改").toBe(content.replace(/@(电脑操控|GitHub)/gu, "$1"));
  expect(echoBlock.atSigns, "展示层不显示 @").toBe(0);
  expect(echoBlock.keys, "标识按出现顺序").toEqual(["computer", "github"]);
  expect(echoBlock.transparent, "只读态没有透明占位").toEqual([]);
  expect(echoBlock.iconWidths, "两枚图标同档 16px").toEqual([16, 16]);
  expect(await page.locator(".chat-command-mirror").count(), "草稿清空后编辑态镜像层整体不渲染").toBe(0);
  await page.screenshot({ path: `${shots}/echo-after-real-send.png` });

  await page.reload({ waitUntil: "domcontentloaded" });
  await connect(page);
  await page.locator("[data-plugin-mention]").first().waitFor({ timeout: 20_000 });
  const reloaded = await page.evaluate(measureMessages) as unknown as MessageLayer;
  expect(reloaded.blocks.find((block) => block.keys.length === 2),
    "重新加载后的显示与回显逐字同形（不是本地缓存的把戏）").toEqual(echoBlock);

  const recallButton = page.getByTestId("assist-recall-action-echo-user-1");
  await expect(recallButton, "回退键可用（撤回不是禁用态的摆设）").toBeEnabled({ timeout: 20_000 });
  await recallButton.click();
  await page.locator('[data-testid="assist-withdrawn-original-echo-user-1"]')
    .waitFor({ state: "attached", timeout: 20_000 });
  expect(live.recallPosts.length, "撤回真的提交了一次 POST /recall").toBe(1);
  expect(live.recallPosts[0]!.messageId, "撤回命令打在被撤回的那条用户消息上").toBe("echo-user-1");
  const withdrawn = await page.evaluate(() => ({
    status: document.querySelector('.agent-message[data-role="USER"] .agent-message-status')?.textContent ?? "",
    // 折叠历史默认收起：其中不得有可见标识（可见 = 有非零盒）。
    /* 「当前版面不留标识」要按平台判定，而不是按矩形：折叠历史里的元件仍有盒子
       （Chromium 对 closed details 保留 layout box），但 checkVisibility() 为 false。
       只按矩形宽度判就会把「收进历史」误报成「画在界面上」。 */
    visibleChips: Array.from(document.querySelectorAll<HTMLElement>(".agent-message [data-plugin-mention]"))
      .filter((el) => el.checkVisibility()).length,
    chipNodesInDom: document.querySelectorAll(".agent-message [data-plugin-mention]").length,
    note: document.querySelector("[data-testid^=\"assist-recall-\"]")?.textContent ?? "",
    detailsOpen: (document.querySelector('[data-testid="assist-withdrawn-original-echo-user-1"]') as HTMLDetailsElement).open,
    mirror: document.querySelectorAll(".chat-command-mirror").length
  }));
  expect(withdrawn.status, "行状态改说「已撤回」").toContain("已撤回");
  expect(withdrawn.detailsOpen, "原文收进默认折叠的历史").toBe(false);
  expect(withdrawn.visibleChips, "撤回后当前版面不留任何标识（也没有隐形占位）").toBe(0);
  expect(withdrawn.chipNodesInDom, "撤回不删原文：两枚标识仍留在折叠历史里，只是当前不可见").toBe(2);
  expect(withdrawn.mirror, "撤回不涉及输入器镜像层").toBe(0);
  expect(withdrawn.note, "回执按服务端事实说明回退了哪个文件").toContain("notes/a.md");
  await page.screenshot({ path: `${shots}/after-real-recall.png` });

  await page.getByTestId("assist-withdrawn-original-echo-user-1").locator("summary").click();
  const historical = await page.evaluate(measureMessages) as unknown as MessageLayer;
  const historyBlock = historical.blocks.find((block) => block.keys.length === 2)!;
  expect(historyBlock.text, "展开历史后仍按同一展示层显示（去 @，一字不改）")
    .toBe(content.replace(/@(电脑操控|GitHub)/gu, "$1"));
  expect(historyBlock.transparent, "历史里的标识也是真实可见文字").toEqual([]);
  expect(historyBlock.rects.length, "两枚标识都排得出盒子").toBe(2);
  await page.screenshot({ path: `${shots}/recalled-history-expanded.png` });
});

/* ⑰ 多行消息与窄窗口只读态：消息层是纯 in-flow 文字（没有镜像层），折行由浏览器自己
   决定。输入器里的降级规则不适用于这里，但要证「换行与窄宽都不会让标识叠字或隐形」。 */
test("⑰ 多行消息与 390px 窄窗口只读态：标识随文走，不叠字、不隐形、不横溢", async ({ page }) => {
  const multiline = "@电脑操控 打开记事本并记录第一段\n然后 @GitHub 拉取仓库状态，这一行故意写得足够长好让它在窄窗口里被折行拆开\n最后 @浏览器操控 收工";
  for (const width of [1162, 390]) {
    await openConversation(page, [message(userMessageId, "1", "USER", multiline)], width);
    await page.locator("[data-plugin-mention]").first().waitFor({ timeout: 20_000 });
    const m = await page.evaluate(measureMessages) as unknown as MessageLayer;
    const block = m.blocks.find((item) => item.keys.length === 3)!;
    expect(block, "三枚标识都认出来").toBeDefined();
    expect(block.atSigns, "换行消息同样只去掉 @").toBe(0);
    expect(block.text, "换行符与其余文字一字不改").toBe(multiline.replace(/@(电脑操控|GitHub|浏览器操控)/gu, "$1"));
    expect(block.transparent, "任何一枚都不是隐形占位").toEqual([]);
    expect(block.lines, "三条换行至少排成三行").toBeGreaterThanOrEqual(3);
    block.rects.forEach((rect, index) => {
      expect(rect.w, `${width}px 第 ${index + 1} 枚标识有实际宽度`).toBeGreaterThan(10);
      expect(rect.h, `${width}px 第 ${index + 1} 枚标识占一个行盒`).toBeGreaterThan(10);
    });
    for (let index = 1; index < block.rects.length; index += 1) {
      const left = block.rects[index - 1]!, right = block.rects[index]!;
      const overlapX = left.r - right.l, overlapY = Math.min(left.b, right.b) - Math.max(left.t, right.t);
      expect(overlapX > 0.5 && overlapY > 0.5,
        `${width}px 第 ${index + 1} 枚不与前一枚重叠（同层文字不叠字）`).toBe(false);
    }
    expect(m.overflowX, `${width}px 视口不横向溢出`).toBe(false);
    await page.screenshot({ path: `${shots}/message-multiline-${width}.png` });
  }
});

/* ⑱ 跨行降级 × 发送中禁用态：降级把原文交回镜像层显示，禁用灰必须跟着走，同时
   textarea 自己的原文仍要透明——否则就是「灰原文 + 镜像原文」两层重影（2026-10-26
   独立验收指认过的那一类，在降级态下必须重验）。 */
test("⑱ 跨行降级 + 发送中禁用态：只有一层原文可见，且用禁用灰", async ({ page }) => {
  await openConversation(page, [], 390);
  const draft = page.getByTestId("assist-draft");
  let splitValue = "";
  for (let length = 1; length <= 26 && splitValue === ""; length += 1) {
    const value = `核${"对".repeat(length)}@浏览器操控 继续`;
    await fillDraft(page, value, ["browser"]);
    const candidate = await page.evaluate(measureComposer) as unknown as Composer;
    if (candidate.chipPainted[0] === false) splitValue = value;
  }
  expect(splitValue, "390px 下应能构造出跨行降级样本").not.toBe("");

  await page.route(`${apiBase}${prefix}/assist-sessions/${sessionId}/messages`, () => new Promise(() => {}));
  await draft.click();
  await page.getByTestId("assist-send").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement).disabled,
    undefined, { timeout: 10_000 });
  await page.waitForTimeout(250);

  const state = await page.evaluate(measureComposer) as unknown as Composer;
  expectNoInvisiblePlaceholder(state, "跨行降级 + 发送中");
  expect(state.chipPainted, "降级态在发送中仍是降级（不闪出半枚芯片）").toEqual([false]);
  expect(state.mentionVisible, "原文可见").toEqual([true]);
  const colors = await page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement;
    const style = getComputedStyle(textarea);
    const mirror = document.querySelector(".chat-command-mirror") as HTMLElement;
    const span = document.querySelector('.chat-command-mention[data-chip="off"]') as HTMLElement;
    return { textareaColor: style.color,
      fill: (style as CSSStyleDeclaration & { webkitTextFillColor: string }).webkitTextFillColor,
      mirrorColor: getComputedStyle(mirror).color, originalColor: getComputedStyle(span).color };
  });
  expect(colors.textareaColor, "textarea 自己的原文仍透明（不出现两层文字）").toBe("rgba(0, 0, 0, 0)");
  expect(colors.fill, "-webkit-text-fill-color 也不得把原文画回来").toBe("rgba(0, 0, 0, 0)");
  expect(colors.originalColor, "降级显示的原文继承镜像层的禁用灰").toBe(colors.mirrorColor);
  expect(colors.originalColor, "发送中原文不是正文黑").toBe("rgb(85, 103, 93)");
  expect(state.mirrorText, "发送中草稿文本不变").toBe(splitValue);
  await page.screenshot({ path: `${shots}/split-disabled-pending.png` });
  await page.locator(".agent-chat-composer").screenshot({ path: `${shots}/closeup-split-disabled.png` });
});

/* ⓪ 修复前后对照（同一套 DOM 与产品代码，只把宽度算法退回上一轮的写法）。
   上一轮（commit 0af62cc 的 `.chat-command-chip`）不写 `width`，芯片画的是
   「图标 + gap + 名称」的固有宽度，且 `overflow: visible`；本轮改为
   「宽度 = 原文片段字宽 + overflow:hidden」，右缘由原文决定，名称放不下由 label
   自己省略号收口。三档内置 mention 在旧写法下**恰好**放得下（余量 1.7~5.1px），
   所以缺陷不在今天这几个名字上，而在「任何一次字体度量变化都会让它压住正文」。
   这里用一段压力样式（把名称放大一档，等价于换到更宽的字形/更长的插件名）
   把两种写法的结构性差别量出来。只注入样式，不改 DOM、不改产品代码。 */
test("⓪ 前后对照：旧写法右缘由固有宽度决定（加压即压住正文），新写法恒等于原文右缘", async ({ page }) => {
  const legacyRules = ".chat-command-mirror .plugin-chip.chat-command-chip{width:auto!important;"
    + "overflow:visible!important;line-height:1!important;padding-inline:0!important;gap:4px!important}";
  const stressRules = ".chat-command-mirror .plugin-chip-label{font-size:20px!important}";
  const removeStyles = (needle: string) => page.evaluate((text) => {
    document.querySelectorAll("style").forEach((el) => { if (el.textContent?.includes(text)) el.remove(); });
  }, needle);

  await openConversation(page);
  await fillDraft(page, "@电脑操控 打开记事本", ["computer"]);
  const probe = () => page.evaluate(measureComposer) as unknown as Composer;
  const gap = (m: Composer) => (m.afterMention[0] === null ? Number.NaN : m.afterMention[0]!.left - m.chip[0]!.r);
  const overrun = (m: Composer) => m.chip[0]!.r - m.mentionFirst[0]!.r;

  const shipped = await probe();
  const shippedW = shipped.chip[0]!.w, mentionW = shipped.mentionFirst[0]!.w;

  // 旧写法（未加压）：固有宽度与原文右缘相差几 px——今天放得下，但纯属巧合。
  await page.addStyleTag({ content: legacyRules });
  await page.waitForTimeout(150);
  const legacyPlain = await probe();
  await page.screenshot({ path: `${shots}/compare-before-legacy.png` });
  await page.locator(".agent-chat-composer").screenshot({ path: `${shots}/closeup-before-legacy.png` });
  // 旧写法 + 加压：固有宽度越过原文右缘，后面的正文被盖住（这就是缺陷形态）。
  await page.addStyleTag({ content: stressRules });
  await page.waitForTimeout(150);
  const legacy = await probe();
  const legacyOverrun = overrun(legacy), legacyGap = gap(legacy);
  await page.locator(".agent-chat-composer").screenshot({ path: `${shots}/closeup-legacy-stressed.png` });

  // 新写法 + 同样的加压：右缘仍停在原文终点，超出部分由名称省略号收口，正文不被盖住。
  await removeStyles("width:auto!important");
  await page.waitForTimeout(150);
  const stressed = await probe();
  await page.locator(".agent-chat-composer").screenshot({ path: `${shots}/closeup-fixed-stressed.png` });
  await removeStyles("font-size:20px!important");
  await page.waitForTimeout(150);
  const restored = await probe();
  await page.screenshot({ path: `${shots}/compare-after-fixed.png` });
  await page.locator(".agent-chat-composer").screenshot({ path: `${shots}/closeup-after-fixed.png` });

  const report = { mentionW, shippedW,
    legacyPlain: { chipW: legacyPlain.chip[0]!.w, overrun: overrun(legacyPlain), gap: gap(legacyPlain) },
    legacy: { chipW: legacy.chip[0]!.w, overrun: legacyOverrun, gap: legacyGap },
    stressed: { chipW: stressed.chip[0]!.w, overrun: overrun(stressed), gap: gap(stressed),
      clipped: stressed.labelClipped[0] }, restored: { chipW: restored.chip[0]!.w } };
  console.log("插件标识前后对照 " + JSON.stringify(report));

  // 旧写法未加压：右缘与原文右缘只剩几 px 关系，靠的是名字短、字体窄，不是结构。
  expect(Math.abs(overrun(legacyPlain)), `旧写法未加压的右缘差：${JSON.stringify(report.legacyPlain)}`)
    .toBeLessThan(6);
  // 旧写法：宽度与原文无关，加压就侵入正文（缺陷复现，记录用）。
  expect(legacyOverrun, `旧写法加压后越过原文右缘：${JSON.stringify(report.legacy)}`).toBeGreaterThan(1);
  expect(legacyGap, "旧写法加压后盖住后面的正文（可见字形落在芯片之下）").toBeLessThan(0);
  // 新写法：同一压力下右缘不动，正文起点仍在芯片之外。
  expect(Math.abs(overrun(stressed)), "新写法加压后右缘仍等于原文右缘").toBeLessThanOrEqual(0.5);
  expect(stressed.chip[0]!.w, "新写法宽度就是原文字宽，不随内容变化").toBeCloseTo(mentionW, 0);
  expect(stressed.labelClipped[0], "名称放不下时由省略号收口（而不是把容器撑宽）").toBe(true);
  expect(gap(stressed), "新写法加压后仍不盖住正文").toBeGreaterThanOrEqual(0);
  // 撤掉压力，回到未加压时的同一宽度（对照没有留下残留）。
  expect(restored.chip[0]!.w, "撤掉压力后宽度回到原文字宽").toBeCloseTo(shippedW, 0);
  expect(Math.abs(overrun(restored)), "撤掉压力后右缘误差仍 ≤0.5").toBeLessThanOrEqual(0.5);
});
