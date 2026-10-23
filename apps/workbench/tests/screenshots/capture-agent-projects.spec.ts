import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = "D:/Develop/Relay-Agent/ui-screenshots-2026-10-11";
const ENV_PATH = "D:/Develop/Relay-Agent/apps/api/.env";
const SESSION_PATH = "D:/Develop/Relay-Agent/.relay-test/session.json";

const FIXTURE_PROJECTS = [
  "project-workflow-os",
  "project-knowledge",
  "project-thesis-topic"
] as const;

test.use({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });

function readLiveCreds(): { baseUrl: string; workspaceId: string; bearerToken: string } {
  const envText = fs.readFileSync(ENV_PATH, "utf8");
  const token = /RELAY_API_BEARER_TOKEN=(.+)/.exec(envText)?.[1]?.trim();
  if (!token) throw new Error("missing RELAY_API_BEARER_TOKEN in apps/api/.env");
  const sessionRaw = fs.readFileSync(SESSION_PATH, "utf8").replace(/^\uFEFF/, "");
  const session = JSON.parse(sessionRaw) as { workspace_id?: string };
  const workspaceId = session.workspace_id;
  if (!workspaceId) throw new Error("missing workspace_id in .relay-test/session.json");
  return { baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: token };
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
}

async function safeClick(_page: Page, locator: ReturnType<Page["locator"]>) {
  try {
    await locator.first().waitFor({ state: "visible", timeout: 4500 });
    await locator.first().click({ timeout: 4500 });
    return true;
  } catch {
    return false;
  }
}

async function gotoReady(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(300);
}

async function connectLive(page: Page) {
  const creds = readLiveCreds();
  await safeClick(page, page.getByTestId("relay-connection-open"));
  await page.waitForTimeout(300);
  await shot(page, "agent-connection-dialog-open");
  await page.locator('input[name="relay-base-url"]').fill(creds.baseUrl);
  await page.locator('input[name="relay-workspace-id"]').fill(creds.workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill(creds.bearerToken);
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: /已连接/ }).waitFor({ timeout: 15000 }).catch(() => {});
  await shot(page, "agent-connection-dialog-connected");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
}

test.describe("ui screenshots agent + projects", () => {
  test("batch capture", async ({ page }) => {
    fs.mkdirSync(OUT, { recursive: true });

    // ========== FIXTURE: /agent gap ==========
    await gotoReady(page, "/agent");
    await shot(page, "agent-fixture-gap");

    // ========== FIXTURE: projects list + interactions ==========
    await gotoReady(page, "/projects");
    await shot(page, "projects-list-base");
    await safeClick(page, page.getByTestId("projects-tab-active"));
    await shot(page, "projects-tab-active");
    await safeClick(page, page.getByTestId("projects-tab-archived"));
    await shot(page, "projects-tab-archived");
    await safeClick(page, page.getByTestId("projects-tab-all"));
    await shot(page, "projects-tab-all");
    await safeClick(page, page.getByTestId("projects-view-list"));
    await shot(page, "projects-view-list");
    await safeClick(page, page.getByTestId("projects-view-grid"));
    await shot(page, "projects-view-grid");

    const firstCard = page.locator('[data-testid^="project-card-open-"]').first();
    if (await firstCard.count()) {
      await firstCard.hover().catch(() => {});
      await shot(page, "projects-card-hover");
      const more = page.locator('[data-testid^="project-card-more-"]').first();
      if (await more.count()) {
        await more.click().catch(() => {});
        await shot(page, "projects-card-more-menu");
        await page.keyboard.press("Escape");
      }
    }

    await safeClick(page, page.getByTestId("project-create-open"));
    await page.waitForURL(/view=create/).catch(() => {});
    await shot(page, "projects-create-base");
    // Project type is segmented radios, not a <select>.
    await safeClick(page, page.locator('input[name="project-type"][value="THESIS"]').or(page.getByText("论文", { exact: true })).first());
    await shot(page, "projects-create-picker-open");
    await page.keyboard.press("Escape");

    await gotoReady(page, "/projects?view=goal");
    await shot(page, "projects-goal-base");

    for (const id of FIXTURE_PROJECTS) {
      await gotoReady(page, `/projects/${id}`);
      await shot(page, `${id}-overview`);

      await gotoReady(page, `/projects/${id}/tasks`);
      await shot(page, `${id}-tasks`);

      await gotoReady(page, `/projects/${id}/knowledge`);
      await shot(page, `${id}-knowledge`);

      await gotoReady(page, `/projects/${id}/connections`);
      await shot(page, `${id}-connections`);

      await gotoReady(page, `/projects/${id}/workbench`);
      await shot(page, `${id}-workbench-entry`);

      for (const kind of ["general", "thesis", "development"] as const) {
        await gotoReady(page, `/projects/${id}/workbench/${kind}`);
        await shot(page, `${id}-workbench-${kind}`);
      }

      for (const skill of ["blueprint", "resume"] as const) {
        await gotoReady(page, `/projects/${id}?skill=${skill}`);
        await shot(page, `${id}-skill-${skill}`);
      }
    }

    await gotoReady(page, "/projects");
    const row = page.locator('[data-testid^="project-card-more-"]').first();
    if (await row.count()) {
      await row.click().catch(() => {});
      await page.waitForTimeout(400);
      await shot(page, "projects-selected-detail");
      // 归档已改为单击即发 + 撤销条（工作台 §13.2）：截图脚本不再点归档按钮，
      // 否则会在截图库里真的归档一个项目。
    }

    // ========== LIVE: connect for /agent interactions ==========
    await gotoReady(page, "/agent");
    await connectLive(page);

    await gotoReady(page, "/agent");
    await shot(page, "agent-live-base");

    await safeClick(page, page.getByTestId("context-new-conversation").or(page.getByTestId("collab-new-conversation")).or(page.getByRole("button", { name: /新对话/ })));
    await shot(page, "agent-new-chat");

    const search = page.getByTestId("recent-work-search");
    if (await search.count()) {
      await search.fill("你好");
      await shot(page, "agent-rail-search");
      await search.fill("");
    }

    const namedSession = page.locator('[data-testid^="recent-work-"]').filter({ hasText: "你好" }).first();
    if (await namedSession.count()) {
      await namedSession.click().catch(() => {});
      await shot(page, "agent-session-selected");
    } else {
      const anySession = page.locator('[data-testid^="recent-work-a"], [data-testid^="recent-work-"]').nth(1);
      if (await anySession.count()) {
        await anySession.click().catch(() => {});
        await shot(page, "agent-session-selected");
      }
    }

    // 顶栏左翼只显示会话名，切换讨论改由右翼那颗键的浮层承担（2026-10-17）。
    await safeClick(page, page.getByTestId("collab-session-switcher"));
    await shot(page, "agent-session-switcher-open");
    await page.keyboard.press("Escape");
    await safeClick(page, page.getByTestId("assist-new-session").or(page.getByRole("button", { name: /新建会话/ })));
    await shot(page, "agent-new-session");
    await safeClick(page, page.getByTestId("assist-refresh").or(page.getByRole("button", { name: /刷新会话/ })));
    await shot(page, "agent-refresh-session");

    // 三档合并为一个下拉框（2026-10-18），2026-10-22 DEV-0116 换成自绘浮层后改用「点芯片 → 点那一行」。
    const pickMode = async (mode: string): Promise<void> => {
      await page.getByTestId("conversation-mode-select").click();
      await page.getByTestId(`conversation-mode-option-${mode}`).click();
    };
    await pickMode("AGENT");
    await shot(page, "agent-mode-agent");
    await pickMode("ASSISTANT");
    await shot(page, "agent-mode-assistant");
    await pickMode("AGENT");

    const details = page.locator("details").filter({ hasText: /资料|普通讨论|讨论/ });
    const sourceDetails = details.filter({ hasText: /资料/ }).first();
    if (await sourceDetails.count()) {
      await sourceDetails.locator("summary").click().catch(() => {});
      await shot(page, "agent-source-dropdown-open");
      await sourceDetails.locator("summary").click().catch(() => {});
    }
    await safeClick(page, page.getByTestId("assist-open-sources"));
    await shot(page, "agent-sources-panel");
    await page.keyboard.press("Escape");

    const discussion = details.filter({ hasText: /讨论/ }).first();
    if (await discussion.count()) {
      await discussion.locator("summary").click().catch(() => {});
      await shot(page, "agent-discussion-dropdown-open");
      await discussion.locator("summary").click().catch(() => {});
    }

    await safeClick(page, page.getByTestId("folder-scope-change").or(page.getByRole("button", { name: /更换目录|选择目录/ })));
    await shot(page, "agent-folder-change");
    await page.keyboard.press("Escape");
    await safeClick(page, page.getByTestId("folder-scope-change"));
    await shot(page, "agent-folder-options");
    await page.keyboard.press("Escape");
    await safeClick(page, page.getByTestId("folder-scope-association").or(page.getByRole("button", { name: /归属|未归属/ })));
    await shot(page, "agent-folder-association");
    await page.keyboard.press("Escape");

    const composer = page.getByTestId("assist-composer").or(page.getByTestId("assist-draft")).or(page.getByTestId("assist-first-draft"));
    if (await composer.count()) {
      await composer.first().click().catch(() => {});
      await composer.first().fill("截图用测试输入，请勿发送到模型。").catch(() => {});
      await shot(page, "agent-composer-filled");
      const send = page.getByTestId("assist-send").or(page.getByTestId("assist-first-send"));
      if (await send.count()) {
        await send.first().hover().catch(() => {});
        await shot(page, "agent-send-hover");
      }
      const meter = page.getByTestId("assist-context-meter");
      if (await meter.count()) {
        await meter.first().hover().catch(() => {});
        await shot(page, "agent-context-meter-hover");
      }
    } else {
      await shot(page, "agent-composer-area");
    }

    // Layout modes need an associated task (?work=) and open "更多操作".
    const layoutTask = "a3e57735-932b-4b96-85a9-1ea90bb884f9";
    await gotoReady(page, `/agent?work=${layoutTask}`);
    await page.locator("details.page-head-more > summary").click().catch(() => {});
    for (const mode of ["split", "chat", "result"] as const) {
      if (await safeClick(page, page.getByTestId(`collab-layout-${mode}`))) {
        await shot(page, `agent-layout-${mode}`);
      }
    }

    // ========== LIVE: projects ==========
    await gotoReady(page, "/projects");
    await shot(page, "projects-live-list-base");
    await safeClick(page, page.getByTestId("projects-live-refresh"));
    await shot(page, "projects-live-refreshed");

    const liveOpen = page.getByTestId("project-open").or(page.locator('[data-testid^="project-card-open-"]')).first();
    if (await liveOpen.count()) {
      await liveOpen.click().catch(() => {});
      await page.waitForTimeout(600);
      await shot(page, "projects-live-opened");
      const url = page.url();
      const m = /\/projects\/([^/?#]+)/.exec(url);
      if (m) {
        const liveId = m[1];
        await gotoReady(page, `/projects/${liveId}/tasks`);
        await shot(page, "projects-live-tasks");
        await gotoReady(page, `/projects/${liveId}/knowledge`);
        await shot(page, "projects-live-knowledge");
        await gotoReady(page, `/projects/${liveId}/connections`);
        await shot(page, "projects-live-connections");
        await gotoReady(page, `/projects/${liveId}/workbench/general`);
        await shot(page, "projects-live-workbench-general");
      }
    }

    await gotoReady(page, "/projects?view=create");
    await shot(page, "projects-live-create");

    expect(true).toBeTruthy();
  });
});
