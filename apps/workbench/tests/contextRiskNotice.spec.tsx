import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient, type RequiredContextAudit } from "../src/api/relayClient";
import ContextRiskNotice from "../src/components/ContextRiskNotice";
import { flush, mountReact } from "./mountApp";

/**
 * 必读文件体积预警（2026-10-30）。
 *
 * 断言用户能看见与能操作的事实：什么时候出现、这一行读什么、浮层里哪个文件在冒风险、
 * 预算未知时不给假百分比、忽略只在同一份必读文件集合上有效、「查看文件」走的是同一条
 * 受管读取通道。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const resourceId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const connectionId = "44444444-4444-4444-8444-444444444444";
const client = new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
let unmount: (() => void) | null = null;

afterEach(() => { release(); vi.unstubAllGlobals(); window.localStorage.clear(); });

/** 卸载当前挂载。写成函数而不是就地 `unmount?.()`：`let` 在就地收窄后会被判成恒为 null。 */
function release(): void {
  if (unmount !== null) { unmount(); unmount = null; }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function audit(overrides: Partial<RequiredContextAudit> = {}): RequiredContextAudit {
  const base: RequiredContextAudit = {
    state: "OK",
    detail: "1 份必读文件已计入预计加载量。",
    agent: { id: "relay", label: "Relay 内置 Agent" },
    root: "D:/Develop/Relay-Agent",
    scannedAt: "2026-10-30T04:00:00.000Z",
    fingerprint: "fp-1",
    severity: "SEVERE",
    files: [{ path: "AGENTS.md", category: "TASK_REQUIRED", scope: "ROOT",
      reason: "项目规则入口", bytes: 540_000, estimatedTokens: 180_000,
      modifiedAt: "2026-10-30T03:59:00.000Z", share: 0.78, severity: "SEVERE" }],
    budget: { providerWindowTokens: 256_000, providerWindowKnown: true,
      callBudgetTokens: 256_000, callBudgetSource: "WORKSPACE_TIER",
      effectiveInputTokens: 231_000, effectiveBasis: "PROVIDER_WINDOW",
      reserves: { outputTokens: 8_192, systemPromptTokens: 2_000,
        toolDefinitionTokens: 4_096, historyTokens: 0 },
      estimatedTotalInputTokens: 194_288, requiredTotalTokens: 180_000,
      requiredTotalShare: 0.78, confidence: "EXACT_WINDOW",
      estimate: { method: "ESTIMATED_UTF8_BYTES_DIV_3", bytesPerToken: 3,
        note: "按 UTF-8 字节数 ÷ 3 估算。" } },
    reasons: [{ code: "SINGLE_FILE_SEVERE", text: "AGENTS.md 预计占有效输入预算的 78%",
      ratio: 0.78, path: "AGENTS.md" }],
    suggestions: [{ code: "SPLIT_ENTRY", text: "把大型入口文件拆成两段：入口只留导航与硬约束。" }],
    skipped: [],
    access: { projectId, connectionId },
    thresholds: { singleFile: { notice: 0.15, high: 0.30, severe: 0.50 },
      totalFiles: { notice: 0.30, high: 0.50, severe: 0.75 } },
  };
  return { ...base, ...overrides };
}

async function mount(value: RequiredContextAudit | null) {
  const mounted = await mountReact(<ContextRiskNotice client={client} workspaceId={workspaceId}
    resourceId={resourceId} audit={value} loading={false} error={null} onRefresh={() => {}} />);
  unmount = mounted.unmount;
  await flush();
  return mounted.wrapper;
}

describe("必读文件预警的显示条件", () => {
  it("没有风险时整条不渲染：正常情况下不占输入区一行", async () => {
    const wrapper = await mount(audit({ severity: "NONE", files: [], reasons: [],
      suggestions: [] }));
    expect(wrapper.find('[data-testid="context-risk-notice"]').exists()).toBe(false);
  });

  it("没有目录或没有读取权限时不渲染", async () => {
    const wrapper = await mount(audit({ state: "NO_FILE_ACCESS", severity: "NONE", files: [] }));
    expect(wrapper.find('[data-testid="context-risk-notice"]').exists()).toBe(false);
  });

  it("严重风险显示单行提示，并给出发送前提醒而不是「查看详情」", async () => {
    const wrapper = await mount(audit());
    const line = wrapper.get('[data-testid="context-risk-line"]');
    expect(line.text()).toContain("发现 1 个大型必读文件");
    expect(line.text()).toContain("预计占用 78% 上下文");
    expect(line.text()).toContain("发送前请先确认");
    expect(line.attributes("data-severity")).toBe("SEVERE");
    // 单行：不是大面积彩色卡片，用普通文本按钮承载。
    expect(line.element?.tagName).toBe("BUTTON");
  });

  it("风险只是提醒档时不冒充严重", async () => {
    const wrapper = await mount(audit({ severity: "NOTICE",
      reasons: [{ code: "SINGLE_FILE_NOTICE", text: "AGENTS.md 预计占 18%", ratio: 0.18,
        path: "AGENTS.md" }],
      budget: { ...audit().budget, requiredTotalShare: 0.18 } }));
    const line = wrapper.get('[data-testid="context-risk-line"]');
    expect(line.text()).toContain("查看详情");
    expect(line.attributes("data-severity")).toBe("NOTICE");
  });
});

describe("浮层里的读数与操作", () => {
  it("展开后列出文件、有效预算、原因与优化建议", async () => {
    const wrapper = await mount(audit());
    await wrapper.get('[data-testid="context-risk-line"]').trigger("click");
    const panel = wrapper.get('[data-testid="context-risk-panel"]');
    expect(panel.text()).toContain("AGENTS.md");
    expect(panel.text()).toContain("78%");
    expect(wrapper.get('[data-testid="context-risk-effective-input"]').text()).toContain("231,000");
    expect(wrapper.get('[data-testid="context-risk-window"]').text()).toContain("256,000");
    expect(wrapper.get('[data-testid="context-risk-call-budget"]').text()).toContain("工作区默认档位");
    expect(panel.text()).toContain("预计加载量（发送前推算）");
    expect(wrapper.get('[data-testid="context-risk-suggestions"]').text()).toContain("拆成两段");
  });

  it("Esc 收起浮层并把焦点还给提示行", async () => {
    const wrapper = await mount(audit());
    const line = wrapper.get('[data-testid="context-risk-line"]');
    await line.trigger("click");
    expect(wrapper.find('[data-testid="context-risk-panel"]').exists()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(wrapper.find('[data-testid="context-risk-panel"]').exists()).toBe(false);
    expect(document.activeElement).toBe(line.element);
  });

  it("窗口未知时显示估算限制，不给假百分比", async () => {
    const wrapper = await mount(audit({ severity: "HIGH",
      files: [{ path: "AGENTS.md", category: "TASK_REQUIRED", scope: "ROOT",
        reason: "项目规则入口", bytes: 240_000, estimatedTokens: 80_000,
        modifiedAt: "2026-10-30T03:59:00.000Z", share: 0.35, severity: "HIGH" }],
      budget: { ...audit().budget, providerWindowTokens: null,
        providerWindowKnown: false, confidence: "WINDOW_UNKNOWN",
        effectiveBasis: "CALL_BUDGET", requiredTotalShare: 0.35 },
      reasons: [{ code: "WINDOW_UNKNOWN", text: "模型窗口未知：占比按已配置的调用预算估算",
        ratio: null, path: null }] }));
    await wrapper.get('[data-testid="context-risk-line"]').trigger("click");
    expect(wrapper.get('[data-testid="context-risk-window"]').text()).toContain("未知");
    expect(wrapper.get('[data-testid="context-risk-panel"]').text()).toContain("模型窗口未知");
  });

  it("忽略只在同一份必读文件集合上有效：指纹变了重新出现", async () => {
    const wrapper = await mount(audit());
    await wrapper.get('[data-testid="context-risk-line"]').trigger("click");
    await wrapper.get('[data-testid="context-risk-dismiss"]').trigger("click");
    await flush();
    expect(wrapper.find('[data-testid="context-risk-notice"]').exists()).toBe(false);
    release();
    // 同一份文件：仍然忽略。
    expect((await mount(audit())).find('[data-testid="context-risk-notice"]').exists()).toBe(false);
    release();
    // 文件被改过（指纹变化）：必须重新评估，不能沿用上一次的忽略。
    const changed = await mount(audit({ fingerprint: "fp-2" }));
    expect(changed.find('[data-testid="context-risk-notice"]').exists()).toBe(true);
  });

  it("查看文件走同一条受管读取通道，并显式标注只显示开头一段", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { command_id: string };
      bodies.push(body);
      // 回执身份必须与请求的 command_id 一致，否则客户端会判成「响应无法核对」。
      return json({ command_id: body.command_id, committed_at: "2026-10-30T04:01:00Z",
        result: { state: "SUCCEEDED", action_type: "READ_FILE", operation_id: "op-1",
          invocation_id: "inv-1", result: { target: "AGENTS.md", size: 540_000,
            sha256: "a".repeat(64), truncated: true, content: "# AGENTS.md\n规则正文" } } });
    }));
    const wrapper = await mount(audit());
    await wrapper.get('[data-testid="context-risk-line"]').trigger("click");
    await wrapper.get('[data-testid="context-risk-view-AGENTS.md"]').trigger("click");
    await flush();
    const preview = wrapper.get('[data-testid="context-risk-preview"]');
    expect(preview.text()).toContain("只显示开头一段");
    expect(bodies[0]).toMatchObject({ connection_id: connectionId, action_type: "READ_FILE",
      path: "AGENTS.md" });
  });

  it("读取还在等确认时如实说明，不假装已读到正文", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => json({
      command_id: (JSON.parse(String(init?.body)) as { command_id: string }).command_id,
      committed_at: "2026-10-30T04:01:00Z",
      result: { state: "WAITING_APPROVAL", action_type: "READ_FILE", operation_id: "op-2",
        review_id: null, reason: "需要人工确认" } })));
    const wrapper = await mount(audit());
    await wrapper.get('[data-testid="context-risk-line"]').trigger("click");
    await wrapper.get('[data-testid="context-risk-view-AGENTS.md"]').trigger("click");
    await flush();
    expect(wrapper.get('[data-testid="context-risk-preview-error"]').text())
      .toContain("还在等待确认");
  });
});
