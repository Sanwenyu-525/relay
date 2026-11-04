import { afterEach, expect, it, vi } from "vitest";
import { RelayApiClient } from "../src/api/relayClient";
import type { RelayDecision } from "../src/api/dtos/information";
import DecisionReviewPanel from "../src/components/DecisionReviewPanel";
import { currentDraftGuard, hasUnsavedDraft } from "../src/lib/draftGuard";
import { flush, mountReact } from "./mountApp";

afterEach(() => vi.unstubAllGlobals());

const decision: RelayDecision = {
  id: "d1", projectId: "p1", title: "原方案", status: "ACTIVE", revision: "1", currentVersion: "1",
  choice: "先做 P1", rationale: "样本仍支持原方案", alternatives: [], costs: [],
  supersededById: null, createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z"
};

const premise = {
  id: "premise1", workspace_id: "w1", project_id: "p1", decision_id: "d1", decision_revision: "1",
  statement: "样本仍支持原方案", knowledge_id: "k1", hypothesis_id: null,
  baseline_ref: { kind: "KNOWLEDGE", version: "1", version_id: "kv1", status: "ACTIVE", availability: "AVAILABLE" },
  revision: "1", created_at: "2026-10-14T00:00:00Z"
};

function review(id: string, applicable: boolean, status = "PENDING") {
  return {
    id, premise_id: "premise1", decision_id: "d1", decision_title: "原方案", statement: "样本仍支持原方案",
    decision_revision: "1", premise_revision: "1", fingerprint: "a".repeat(64), cause_command_id: "source1",
    before_ref: { kind: "KNOWLEDGE", version: "1", version_id: "kv1", status: "ACTIVE", availability: "AVAILABLE" },
    after_ref: { kind: "KNOWLEDGE", version: "2", version_id: "kv2", status: "ACTIVE", availability: "AVAILABLE" },
    status, revision: status === "PENDING" ? "1" : "2", reason: status === "PENDING" ? null : "用户核对后保留",
    applicable, question: "请重新判断原决定是否仍成立。",
    created_at: "2026-10-14T00:00:01Z", resolved_at: status === "PENDING" ? null : "2026-10-14T00:00:02Z"
  };
}

function knowledge(id: string, title: string) {
  return { id, project_id: "p1", title, status: "ACTIVE", revision: "2", current_version: "2",
    created_at: "2026-10-14T00:00:00Z", updated_at: "2026-10-14T00:00:00Z" };
}

function version() {
  return { id: "kv2", knowledge_id: "k1", version: "2", source_kind: "NOTE", media_type: "text/markdown",
    content_sha256: "b".repeat(64), availability: "AVAILABLE", excerpt: "新样本", source_refs: {},
    created_at: "2026-10-14T00:00:00Z" };
}

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const envelope = (commandId: string, result: unknown) =>
  json({ command_id: commandId, committed_at: "2026-10-14T00:00:03Z", result });

function client() {
  return new RelayApiClient({ baseUrl: "http://127.0.0.1:8787", workspaceId: "w1", bearerToken: "test" });
}

it("显示待判断复核，只有填理由后才能提交，并把依据前后版本与用户理由送给服务端", async () => {
  const posts: Record<string, unknown>[] = [];
  let resolved = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      resolved = true;
      return envelope(String(body.command_id),
        { candidate_id: "c1", project_id: "p1", status: "KEPT", revision: "2" });
    }
    if (target.endsWith("/premises")) return json({ decision_id: "d1", items: [premise] });
    const items = resolved ? [review("c1", false, "KEPT")] : [review("c1", true), review("old1", false)];
    return json({ project_id: "p1", pending_count: resolved ? 0 : 1, items });
  }));

  const { wrapper, unmount } = await mountReact(
    <DecisionReviewPanel client={client()} projectId="p1" decision={decision} />);
  await flush();

  expect(wrapper.get('[data-testid="decision-review-pending-count"]').text()).toBe("1 项待判断");
  const c1 = wrapper.get('[data-testid="decision-review-c1"]').text();
  expect(c1).toContain("登记时：资料 v1");
  expect(c1).toContain("当前：资料 v2");
  expect(c1).toContain("请重新判断原决定是否仍成立");
  // 依据已再次变化的候选不提供处理入口，避免把过期快照当当前依据。
  expect(wrapper.find('[data-testid="decision-review-stale-old1"]').exists()).toBe(true);
  expect(wrapper.find('[data-testid="decision-review-keep-old1"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="decision-review-keep-c1"]').attributes("disabled")).toBe("");

  await wrapper.get('[data-testid="decision-review-reason-c1"]').setValue("重新核对了新样本，仍支持原方案");
  await flush();
  expect(wrapper.get('[data-testid="decision-review-keep-c1"]').attributes("disabled")).toBeUndefined();
  await wrapper.get('[data-testid="decision-review-keep-c1"]').trigger("click");
  await flush();

  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ expected_revision: "1", action: "KEEP_DECISION",
    reason: "重新核对了新样本，仍支持原方案" });
  expect(wrapper.get('[data-testid="decision-review-notice"]').text()).toContain("核对基线推进到本次来源");
  expect(wrapper.get('[data-testid="decision-review-pending-count"]').text()).toBe("0 项待判断");
  unmount();
});

it("登记前提时先读取确切资料版本，提交的知识版本与决定修订来自当前事实", async () => {
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      return envelope(String(body.command_id),
        { premise_id: "premise2", decision_id: "d1", project_id: "p1", revision: "1" });
    }
    const path = new URL(target, "http://127.0.0.1").pathname;
    if (path.endsWith("/knowledge/k1/versions")) return json([version()]);
    if (path.endsWith("/knowledge")) return json([knowledge("k1", "访谈样本")]);
    if (path.endsWith("/hypotheses")) return json({ project_id: "p1", items: [] });
    if (target.endsWith("/premises")) return json({ decision_id: "d1", items: [] });
    if (target.endsWith("/decision-reviews")) return json({ project_id: "p1", pending_count: 0, items: [] });
    const row = { id: "d1", project_id: "p1", title: "原方案", status: "ACTIVE", revision: "1",
      current_version: "1", choice: "先做 P1", rationale: "样本仍支持原方案", alternatives: [], costs: [],
      superseded_by_id: null, created_at: "2026-10-14T00:00:00Z", updated_at: "2026-10-14T00:00:00Z" };
    return json(row);
  }));

  const { wrapper, unmount } = await mountReact(
    <DecisionReviewPanel client={client()} projectId="p1" decision={decision} />);
  await flush();
  await wrapper.get('[data-testid="decision-premise-open"]').trigger("click");
  await flush(80);
  expect(wrapper.get('[data-testid="decision-premise-source-state"]').text()).toContain("1 份当前资料");

  await wrapper.get('[data-testid="decision-premise-knowledge"]').setValue("k1");
  await flush();
  expect(wrapper.get('[data-testid="decision-premise-version"]').text()).toContain("v2");
  await wrapper.get('[data-testid="decision-premise-statement"]').setValue("新样本支持继续先做 P1");
  await wrapper.get('[data-testid="decision-premise-confirmed"]').setValue(true);
  await flush();
  await wrapper.get('[data-testid="decision-premise-submit"]').trigger("click");
  await flush();

  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ expected_decision_revision: "1", confirmed: true,
    statement: "新样本支持继续先做 P1", knowledge_version_id: "kv2" });
  expect(wrapper.get('[data-testid="decision-review-notice"]').text()).toContain("已登记依据");
  unmount();
});

function knowledgeVersion(id: string, knowledgeId: string, versionNumber: string) {
  return { id, knowledge_id: knowledgeId, version: versionNumber, source_kind: "NOTE", media_type: "text/markdown",
    content_sha256: "b".repeat(64), availability: "AVAILABLE", excerpt: "样本", source_refs: {},
    created_at: "2026-10-14T00:00:00Z" };
}

function decisionRow() {
  return { id: "d1", project_id: "p1", title: "原方案", status: "ACTIVE", revision: "1",
    current_version: "1", choice: "先做 P1", rationale: "样本仍支持原方案", alternatives: [], costs: [],
    superseded_by_id: null, created_at: "2026-10-14T00:00:00Z", updated_at: "2026-10-14T00:00:00Z" };
}

function problem(status: number, code: string, detail: string) {
  return new Response(JSON.stringify({ code, detail }), { status });
}

it("前提登记结果未知时冻结原载荷：改表单后重试仍发送原 command_id 与原始参数", async () => {
  const posts: Record<string, unknown>[] = [];
  let premiseAttempts = 0;
  let receiptReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    const path = new URL(target, "http://127.0.0.1").pathname;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      premiseAttempts += 1;
      if (premiseAttempts === 1) throw new TypeError("fetch failed");
      return envelope(String(body.command_id),
        { premise_id: "premise2", decision_id: "d1", project_id: "p1", revision: "1" });
    }
    if (target.includes("/commands/")) { receiptReads += 1; return problem(404, "COMMAND_NOT_FOUND", "命令回执不存在。"); }
    if (path.endsWith("/knowledge/k1/versions")) return json([knowledgeVersion("kv2", "k1", "2")]);
    if (path.endsWith("/knowledge")) return json([knowledge("k1", "访谈样本")]);
    if (path.endsWith("/hypotheses")) return json({ project_id: "p1", items: [] });
    if (path.endsWith("/premises")) return json({ decision_id: "d1", items: [] });
    if (path.endsWith("/decision-reviews")) return json({ project_id: "p1", pending_count: 0, items: [] });
    return json(decisionRow());
  }));

  const { wrapper, unmount } = await mountReact(
    <DecisionReviewPanel client={client()} projectId="p1" decision={decision} />);
  await flush();
  await wrapper.get('[data-testid="decision-premise-open"]').trigger("click");
  await flush(80);
  await wrapper.get('[data-testid="decision-premise-knowledge"]').setValue("k1");
  await flush();
  await wrapper.get('[data-testid="decision-premise-statement"]').setValue("原始冻结说明");
  await wrapper.get('[data-testid="decision-premise-confirmed"]').setValue(true);
  await flush();
  await wrapper.get('[data-testid="decision-premise-submit"]').trigger("click");
  await flush(80);

  expect(wrapper.get('[data-testid="decision-review-pending"]').text()).toContain("已冻结提交载荷");
  expect(wrapper.get('[data-testid="decision-review-receipt-note"]').text()).toContain("尚查不到");
  expect(receiptReads).toBe(1);
  const original = posts[0]!;
  expect(original).toMatchObject({ statement: "原始冻结说明", knowledge_version_id: "kv2",
    expected_decision_revision: "1" });

  // 等待期间修改表单：只影响之后的新请求，不改变已冻结载荷。
  await wrapper.get('[data-testid="decision-premise-statement"]').setValue("修改后的另一条依据");
  await flush();
  await wrapper.get('[data-testid="decision-review-retry"]').trigger("click");
  await flush(80);

  expect(posts).toHaveLength(2);
  expect(posts[1]).toMatchObject({ command_id: original.command_id, statement: "原始冻结说明",
    knowledge_version_id: "kv2", expected_decision_revision: "1" });
  expect(wrapper.get('[data-testid="decision-review-notice"]').text()).toContain("已登记依据");
  expect(wrapper.find('[data-testid="decision-review-pending"]').exists()).toBe(false);
  unmount();
});

it("结果未知时先核对原命令回执，回执对上后不再重发命令", async () => {
  const posts: Record<string, unknown>[] = [];
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    const path = new URL(target, "http://127.0.0.1").pathname;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      attempts += 1;
      if (attempts === 1) throw new TypeError("connection reset");
      return envelope(String(body.command_id), {});
    }
    if (target.includes("/commands/")) {
      const commandId = decodeURIComponent(target.split("/commands/")[1]!);
      return json({ command_id: commandId, command_type: "RegisterDecisionPremise",
        committed_at: "2026-10-14T00:00:03Z",
        result: { premise_id: "premise2", decision_id: "d1", project_id: "p1", revision: "1" } });
    }
    if (path.endsWith("/knowledge/k1/versions")) return json([knowledgeVersion("kv2", "k1", "2")]);
    if (path.endsWith("/knowledge")) return json([knowledge("k1", "访谈样本")]);
    if (path.endsWith("/hypotheses")) return json({ project_id: "p1", items: [] });
    if (path.endsWith("/premises")) return json({ decision_id: "d1", items: [] });
    if (path.endsWith("/decision-reviews")) return json({ project_id: "p1", pending_count: 0, items: [] });
    return json(decisionRow());
  }));

  const { wrapper, unmount } = await mountReact(
    <DecisionReviewPanel client={client()} projectId="p1" decision={decision} />);
  await flush();
  await wrapper.get('[data-testid="decision-premise-open"]').trigger("click");
  await flush(80);
  await wrapper.get('[data-testid="decision-premise-knowledge"]').setValue("k1");
  await flush();
  await wrapper.get('[data-testid="decision-premise-statement"]').setValue("回执可核对的前提");
  await wrapper.get('[data-testid="decision-premise-confirmed"]').setValue(true);
  await flush();
  await wrapper.get('[data-testid="decision-premise-submit"]').trigger("click");
  await flush(80);

  expect(posts).toHaveLength(1);
  expect(wrapper.get('[data-testid="decision-review-notice"]').text()).toContain("原命令回执已核对");
  expect(wrapper.find('[data-testid="decision-review-pending"]').exists()).toBe(false);
  unmount();
});

it("明确失败不会伪装成未知：不查回执、清除待核对状态，修改后可生成新命令提交", async () => {
  const posts: Record<string, unknown>[] = [];
  let receiptReads = 0;
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    const path = new URL(target, "http://127.0.0.1").pathname;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      attempts += 1;
      if (attempts === 1) return problem(422, "INVALID_PREMISE", "来源版本已不可用。");
      return envelope(String(body.command_id),
        { premise_id: "premise2", decision_id: "d1", project_id: "p1", revision: "1" });
    }
    if (target.includes("/commands/")) { receiptReads += 1; return problem(404, "COMMAND_NOT_FOUND", "不存在。"); }
    if (path.endsWith("/knowledge/k1/versions")) return json([knowledgeVersion("kv2", "k1", "2")]);
    if (path.endsWith("/knowledge")) return json([knowledge("k1", "访谈样本")]);
    if (path.endsWith("/hypotheses")) return json({ project_id: "p1", items: [] });
    if (path.endsWith("/premises")) return json({ decision_id: "d1", items: [] });
    if (path.endsWith("/decision-reviews")) return json({ project_id: "p1", pending_count: 0, items: [] });
    return json(decisionRow());
  }));

  const { wrapper, unmount } = await mountReact(
    <DecisionReviewPanel client={client()} projectId="p1" decision={decision} />);
  await flush();
  await wrapper.get('[data-testid="decision-premise-open"]').trigger("click");
  await flush(80);
  await wrapper.get('[data-testid="decision-premise-knowledge"]').setValue("k1");
  await flush();
  await wrapper.get('[data-testid="decision-premise-statement"]').setValue("会被明确拒绝的前提");
  await wrapper.get('[data-testid="decision-premise-confirmed"]').setValue(true);
  await flush();
  await wrapper.get('[data-testid="decision-premise-submit"]').trigger("click");
  await flush(80);

  expect(wrapper.get('[data-testid="decision-review-action-error"]').text()).toContain("来源版本已不可用");
  expect(wrapper.find('[data-testid="decision-review-pending"]').exists()).toBe(false);
  expect(receiptReads).toBe(0);

  await wrapper.get('[data-testid="decision-premise-statement"]').setValue("修正后的新请求");
  await flush();
  await wrapper.get('[data-testid="decision-premise-submit"]').trigger("click");
  await flush(80);
  expect(posts).toHaveLength(2);
  expect(posts[1]!.command_id).not.toBe(posts[0]!.command_id);
  expect(posts[1]!.statement).toBe("修正后的新请求");
  unmount();
});

it("复核处理结果未知时冻结理由：等待期间改理由，重试仍发送原始载荷", async () => {
  const posts: Record<string, unknown>[] = [];
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    const path = new URL(target, "http://127.0.0.1").pathname;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      attempts += 1;
      if (attempts === 1) throw new TypeError("network down");
      return envelope(String(body.command_id),
        { candidate_id: "c1", project_id: "p1", status: "KEPT", revision: "2" });
    }
    if (target.includes("/commands/")) return problem(404, "COMMAND_NOT_FOUND", "命令回执不存在。");
    if (path.endsWith("/premises")) return json({ decision_id: "d1", items: [premise] });
    return json({ project_id: "p1", pending_count: 1, items: [review("c1", true)] });
  }));

  const { wrapper, unmount } = await mountReact(
    <DecisionReviewPanel client={client()} projectId="p1" decision={decision} />);
  await flush();
  await wrapper.get('[data-testid="decision-review-reason-c1"]').setValue("原始处理理由");
  await flush();
  await wrapper.get('[data-testid="decision-review-keep-c1"]').trigger("click");
  await flush(80);

  expect(wrapper.get('[data-testid="decision-review-pending"]').text()).toContain("已冻结提交载荷");
  const original = posts[0]!;
  expect(original).toMatchObject({ expected_revision: "1", action: "KEEP_DECISION", reason: "原始处理理由" });

  await wrapper.get('[data-testid="decision-review-reason-c1"]').setValue("等待期间修改的理由");
  await flush();
  await wrapper.get('[data-testid="decision-review-retry"]').trigger("click");
  await flush(80);

  expect(posts).toHaveLength(2);
  expect(posts[1]).toMatchObject({ command_id: original.command_id, expected_revision: "1",
    action: "KEEP_DECISION", reason: "原始处理理由" });
  expect(wrapper.get('[data-testid="decision-review-notice"]').text()).toContain("核对基线推进");
  unmount();
});

it("在途或结果未知的命令注册导航守卫：离页会拦，回执收口或明确放弃后才解除", async () => {
  let rejectPost!: (reason: unknown) => void;
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    const path = new URL(target, "http://127.0.0.1").pathname;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      return await new Promise<Response>((_, reject) => { rejectPost = reject; });
    }
    if (target.includes("/commands/")) return problem(404, "COMMAND_NOT_FOUND", "命令回执不存在。");
    if (path.endsWith("/knowledge/k1/versions")) return json([knowledgeVersion("kv2", "k1", "2")]);
    if (path.endsWith("/knowledge")) return json([knowledge("k1", "访谈样本")]);
    if (path.endsWith("/hypotheses")) return json({ project_id: "p1", items: [] });
    if (path.endsWith("/premises")) return json({ decision_id: "d1", items: [] });
    if (path.endsWith("/decision-reviews")) return json({ project_id: "p1", pending_count: 0, items: [] });
    return json(decisionRow());
  }));

  const { wrapper, unmount } = await mountReact(
    <DecisionReviewPanel client={client()} projectId="p1" decision={decision} />);
  await flush();
  await wrapper.get('[data-testid="decision-premise-open"]').trigger("click");
  await flush(80);
  await wrapper.get('[data-testid="decision-premise-knowledge"]').setValue("k1");
  await flush();
  await wrapper.get('[data-testid="decision-premise-statement"]').setValue("命令发出后等待结果");
  await wrapper.get('[data-testid="decision-premise-confirmed"]').setValue(true);
  await flush();
  await wrapper.get('[data-testid="decision-premise-submit"]').trigger("click");
  await flush(80);

  // 在途：命令身份已注册，导航守卫必须拦住离页，避免丢掉 command_id 与冻结载荷。
  expect(posts).toHaveLength(1);
  const commandId = String(posts[0]!["command_id"]);
  expect(hasUnsavedDraft()).toBe(true);
  expect(currentDraftGuard()?.pendingCommandId?.()).toBe(commandId);
  expect(currentDraftGuard()?.pendingCommandState?.()).toBe("IN_FLIGHT");

  rejectPost(new TypeError("fetch failed"));
  await flush(80);
  expect(wrapper.get('[data-testid="decision-review-pending"]').text()).toContain("已冻结提交载荷");
  expect(currentDraftGuard()?.pendingCommandId?.()).toBe(commandId);
  expect(currentDraftGuard()?.pendingCommandState?.()).toBe("UNRESOLVED");

  await wrapper.get('[data-testid="decision-review-abandon"]').trigger("click");
  await flush();
  expect(currentDraftGuard()?.pendingCommandId?.()).toBeNull();
  expect(hasUnsavedDraft()).toBe(false);
  unmount();
  expect(currentDraftGuard()).toBeNull();
});

it("资料版本请求乱序返回时只采用当前选中资料的版本，提交也引用该版本", async () => {
  const posts: Record<string, unknown>[] = [];
  let resolveK1: ((value: Response) => void) | null = null;
  let resolveK2: ((value: Response) => void) | null = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    const path = new URL(target, "http://127.0.0.1").pathname;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      return envelope(String(body.command_id),
        { premise_id: "premise2", decision_id: "d1", project_id: "p1", revision: "1" });
    }
    if (path.endsWith("/knowledge/k1/versions")) {
      return await new Promise<Response>((resolve) => { resolveK1 = resolve; });
    }
    if (path.endsWith("/knowledge/k2/versions")) {
      return await new Promise<Response>((resolve) => { resolveK2 = resolve; });
    }
    if (path.endsWith("/knowledge")) return json([knowledge("k1", "资料一"), knowledge("k2", "资料二")]);
    if (path.endsWith("/hypotheses")) return json({ project_id: "p1", items: [] });
    if (path.endsWith("/premises")) return json({ decision_id: "d1", items: [] });
    if (path.endsWith("/decision-reviews")) return json({ project_id: "p1", pending_count: 0, items: [] });
    return json(decisionRow());
  }));

  const { wrapper, unmount } = await mountReact(
    <DecisionReviewPanel client={client()} projectId="p1" decision={decision} />);
  await flush();
  await wrapper.get('[data-testid="decision-premise-open"]').trigger("click");
  await flush(80);

  await wrapper.get('[data-testid="decision-premise-knowledge"]').setValue("k1");
  await flush();
  await wrapper.get('[data-testid="decision-premise-knowledge"]').setValue("k2");
  await flush();
  expect(resolveK1).not.toBeNull();
  expect(resolveK2).not.toBeNull();

  // 先让后发的 k2 完成，再让先发的 k1 完成：旧响应不得覆盖当前选中资料。
  resolveK2!(json([knowledgeVersion("kv2b", "k2", "3")]));
  await flush(40);
  expect(wrapper.get('[data-testid="decision-premise-version"]').text()).toContain("v3");
  resolveK1!(json([knowledgeVersion("kv1a", "k1", "1")]));
  await flush(40);
  expect(wrapper.get('[data-testid="decision-premise-knowledge"]').element).toHaveProperty("value", "k2");
  expect(wrapper.get('[data-testid="decision-premise-version"]').text()).toContain("v3");
  expect(wrapper.get('[data-testid="decision-premise-version"]').text()).not.toContain("v1");

  await wrapper.get('[data-testid="decision-premise-statement"]').setValue("竞态后的提交");
  await wrapper.get('[data-testid="decision-premise-confirmed"]').setValue(true);
  await flush();
  await wrapper.get('[data-testid="decision-premise-submit"]').trigger("click");
  await flush(80);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ knowledge_version_id: "kv2b", statement: "竞态后的提交" });
  unmount();
});
