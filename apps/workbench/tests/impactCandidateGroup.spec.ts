import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const scope = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const artifactId = "44444444-4444-4444-8444-444444444444";
const afterVersionId = "22222222-2222-4222-8222-222222222222";
const beforeVersionId = "55555555-5555-4555-8555-555555555555";
const targetOne = "66666666-6666-4666-8666-666666666666";
const targetTwo = "77777777-7777-4777-8777-777777777777";
const targetArtifactId = "11111111-aaaa-4aaa-8aaa-111111111111";
const checkId = "88888888-8888-4888-8888-888888888888";
const groupId = "99999999-9999-4999-8999-999999999999";
const nextGroupId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const selectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const combinationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const candidateOne = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const appliedVersionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status,
    json: async () => body } as Response;
}

function envelope(result: Record<string, unknown>, commandId = "11111111-2222-4333-8444-555555555555",
  status = 200): Response {
  return json({ command_id: commandId, committed_at: "2026-10-02T00:00:00Z",
    result, links: { resource: `${scope}/x` } }, status);
}

function artifact(): Record<string, unknown> {
  return { id: artifactId, task_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", project_id: null,
    artifact_kind: "MARKDOWN_DOCUMENT", title: "source", revision: "2",
    latest_version_id: afterVersionId, version_count: 2,
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z",
    versions: [{ artifact_version_id: afterVersionId, version_number: "2",
      media_type: "text/markdown", sha256: "a".repeat(64), size: "12",
      source_kind: "HUMAN_EDIT", created_at: "2026-10-02T00:00:00Z" },
    { artifact_version_id: beforeVersionId, version_number: "1", media_type: "text/markdown",
      sha256: "b".repeat(64), size: "10", source_kind: "HUMAN_EDIT",
      created_at: "2026-10-01T00:00:00Z" }] };
}

function check(): Record<string, unknown> {
  return { id: checkId, artifact_id: artifactId, source_before_version_id: beforeVersionId,
    source_after_version_id: afterVersionId, status: "COMPLETED", error_code: null,
    direct_targets: [
      { target_version_id: targetOne, target_artifact_id: "11111111-aaaa-4aaa-8aaa-111111111111",
        relation: "DERIVED_FROM", version_number: "1", availability: "AVAILABLE", analysed: true },
      { target_version_id: targetTwo, target_artifact_id: "22222222-bbbb-4bbb-8bbb-222222222222",
        relation: "DERIVED_FROM", version_number: "1", availability: "AVAILABLE", analysed: true }],
    possibly_related: [], has_more: false, input_truncated: false,
    unanalysed_scope: ["未登记引用", "间接下游"], stale: false };
}

/** 一项已应用、一项没有候选：组读必须把这个部分状态如实显示出来。 */
function group(): Record<string, unknown> {
  return { id: groupId, impact_check_id: checkId, source_artifact_id: artifactId,
    source_before_version_id: beforeVersionId, source_after_version_id: afterVersionId,
    source_artifact_revision: "2", created_at: "2026-10-02T00:00:00Z", stale: false,
    items: [
      { ordinal: 0, target_artifact_id: "11111111-aaaa-4aaa-8aaa-111111111111",
        target_version_id: targetOne, relation: "DERIVED_FROM", speculative: false,
        availability: "AVAILABLE", analysed: true, target_artifact_revision: "3",
        target_is_current_version: false, candidate_id: candidateOne, candidate_status: "COMPLETED",
        candidate_error_code: null, candidate_stale: false,
        applied_version_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
      { ordinal: 1, target_artifact_id: "22222222-bbbb-4bbb-8bbb-222222222222",
        target_version_id: targetTwo, relation: "DERIVED_FROM", speculative: false,
        availability: "AVAILABLE", analysed: true, target_artifact_revision: "1",
        target_is_current_version: true, candidate_id: null, candidate_status: null,
        candidate_error_code: null, candidate_stale: false, applied_version_id: null }],
    summary: { total: 2, applied: 1, with_candidate: 1, without_candidate: 1,
      stale_candidates: 0, unavailable: 0 },
    unanalysed_scope: ["未登记引用", "间接下游"], combination_check_ids: [] };
}

function groupWithoutAppliedCandidate(): Record<string, unknown> {
  const value = group();
  const items = value.items as Record<string, unknown>[];
  return { ...value, items: items.map((item, index) => index === 0
    ? { ...item, applied_version_id: null } : item),
  summary: { ...(value.summary as Record<string, unknown>), applied: 0 } };
}

function groupSelection(applied: boolean): Record<string, unknown> {
  return { id: selectionId, group_id: groupId, created_at: "2026-10-02T00:00:00Z",
    applied_count: applied ? 1 : 0, overall_result: "NONE",
    items: [{ candidate_id: candidateOne, target_artifact_id: targetArtifactId,
      target_version_id: targetOne, expected_target_revision: "3", dependency_candidate_ids: [],
      candidate_status: "COMPLETED", applied_version_id: applied ? appliedVersionId : null,
      applied_is_current: applied, can_apply: !applied, reason: null }] };
}

function targetArtifact(revision: string): Record<string, unknown> {
  return { ...artifact(), id: targetArtifactId, revision, latest_version_id: targetOne,
    versions: [{ artifact_version_id: targetOne, version_number: "1", media_type: "text/markdown",
      sha256: "c".repeat(64), size: "12", source_kind: "HUMAN_EDIT",
      created_at: "2026-10-01T00:00:00Z" }] };
}

function combination(): Record<string, unknown> {
  return { id: combinationId, group_id: groupId,
    task_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", acceptance_revision: "0",
    created_at: "2026-10-02T00:00:00Z", overall_result: "NONE",
    overall_note: "这是确切版本集合的覆盖快照，不是整体验收结论；单项 PASS 不等于组合通过。",
    stale: false,
    gaps: [`${afterVersionId} 在验收修订 0 下没有单项验证会话。`],
    items: [{ ordinal: 0, artifact_id: artifactId, artifact_version_id: afterVersionId,
      is_current_version: true, readable: true, verification_session_id: null,
      verification_status: null }] };
}

/** 只有本测试关心的端点有业务响应；其余面板的读取返回 404，不伪造成功。 */
function stubFetch(overrides: Record<string, () => Response> = {},
  onGroupPost?: (body: Record<string, unknown>) => void, onCandidateApply?: () => void): void {
  const routes: Record<string, () => Response> = {
    [`${scope}/artifact-versions/${afterVersionId}/lineage`]: () => json({
      artifact_version_id: afterVersionId, artifact_id: artifactId, version_number: "2",
      sha256: "a".repeat(64), source_kind: "HUMAN_EDIT", content_availability: "AVAILABLE",
      direct_parents: [] }),
    [`${scope}/artifacts/${artifactId}`]: () => json(artifact()),
    [`${scope}/artifact-versions/${beforeVersionId}/direct-uses`]: () => json({
      source_artifact_version_id: beforeVersionId, source_content_availability: "AVAILABLE",
      scope: "RECORDED_DIRECT_ONLY", complete: false, has_more: false,
      direct_uses: [
        { relation: "DERIVED_FROM", child_artifact_version_id: targetOne,
          child_artifact_id: "11111111-aaaa-4aaa-8aaa-111111111111", child_version_number: "1",
          availability: "AVAILABLE", created_at: "2026-10-01T00:00:00Z" },
        { relation: "DERIVED_FROM", child_artifact_version_id: targetTwo,
          child_artifact_id: "22222222-bbbb-4bbb-8bbb-222222222222", child_version_number: "1",
          availability: "AVAILABLE", created_at: "2026-10-01T00:00:00Z" }] }),
    [`${scope}/impact-checks/${checkId}`]: () => json(check()),
    [`${scope}/impact-candidate-groups/${groupId}`]: () => json(group()),
    [`${scope}/combination-checks/${combinationId}`]: () => json(combination()),
    ...overrides };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const route = routes[url];
    if (route) return route();
    if (init?.method === "POST" && url === `${scope}/artifact-versions/${beforeVersionId}/impact-checks`)
      return envelope({ impact_check_id: checkId, assistant_message_id: candidateOne });
    if (init?.method === "POST" && url === `${scope}/impact-checks/${checkId}/candidate-groups`) {
      onGroupPost?.(JSON.parse(String(init.body)) as Record<string, unknown>);
      return envelope({ group_id: groupId, item_count: "2" });
    }
    if (init?.method === "POST" && url === `${scope}/impact-candidate-groups/${groupId}/selections`) {
      const commandId = (JSON.parse(String(init.body)) as { command_id: string }).command_id;
      return envelope({ group_id: groupId, selection_id: selectionId }, commandId, 201);
    }
    if (init?.method === "POST" && url === `${scope}/impact-candidates/${candidateOne}/apply`) {
      onCandidateApply?.();
      const commandId = (JSON.parse(String(init.body)) as { command_id: string }).command_id;
      return envelope({ version_id: appliedVersionId }, commandId);
    }
    if (init?.method === "POST" && url === `${scope}/impact-candidate-groups/${groupId}/combination-checks`)
      return envelope({ combination_check_id: combinationId, item_count: "1", gap_count: "1" });
    return json({ code: "RESOURCE_NOT_FOUND", detail: "not stubbed" }, 404);
  }));
}

async function reachGroup(overrides?: Record<string, () => Response>,
  onCandidateApply?: () => void): Promise<ReturnType<typeof mountWorkbench> extends Promise<infer T> ? T : never> {
  if (overrides !== undefined || onCandidateApply !== undefined)
    stubFetch(overrides ?? {}, undefined, onCandidateApply);
  const mounted = await mountWorkbench(`/artifact-versions/${afterVersionId}/lineage`);
  unmount = mounted.unmount;
  const panel = () => mounted.wrapper.get('[data-testid="artifact-impact-check"]');
  await mounted.wrapper.find('select').setValue(beforeVersionId); await flush();
  await mounted.wrapper.find('button.primary-button').trigger("click"); await flush();
  expect(panel().text()).toContain("明确引用 · 2");
  const groupBoxes = panel().findAll('input[type="checkbox"]');
  await groupBoxes[groupBoxes.length - 2].setValue(true);
  await groupBoxes[groupBoxes.length - 1].setValue(true);
  const saveGroup = panel().findAll("button").filter((node) =>
    node.text().startsWith("保存候选组"));
  await saveGroup[0]!.trigger("click"); await flush();
  return mounted;
}

describe("N02 候选组与组合检查", () => {
  it("逐项部分成功如实显示，不承诺整组原子完成", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    stubFetch();
    const mounted = await reachGroup();
    const view = mounted.wrapper.get('[data-testid="impact-candidate-group"]');
    expect(view.text()).toContain("共 2 项：已应用 1、有候选 1、尚无候选 1");
    expect(view.text()).toContain("已应用为版本 eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    expect(view.text()).toContain("本项尚无候选；其它项的处理结果不改变这一点。");
    expect(view.text()).toContain("目标版本已更新");
  });

  it("组合检查单显示整体无结论与逐项缺口", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    stubFetch();
    const mounted = await reachGroup();
    const panel = mounted.wrapper.get('[data-testid="artifact-impact-check"]');
    await panel.findAll("button").filter((node) =>
      node.text().startsWith("保存组合检查单"))[0]!.trigger("click");
    await flush();
    const snapshot = mounted.wrapper.get('[data-testid="impact-combination-check"]');
    expect(snapshot.text()).toContain("整体结论：NONE");
    expect(snapshot.text()).toContain("不是整体验收结论");
    expect(snapshot.text()).toContain("没有单项验证会话");
    expect(snapshot.text()).toContain("单项验证：无会话");
  });

  it("拒绝服务端给出整体结论的组合检查响应", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    stubFetch({ [`${scope}/combination-checks/${combinationId}`]: () =>
      json({ ...combination(), overall_result: "PASS" }) });
    const mounted = await reachGroup();
    const panel = mounted.wrapper.get('[data-testid="artifact-impact-check"]');
    await panel.findAll("button").filter((node) =>
      node.text().startsWith("保存组合检查单"))[0]!.trigger("click");
    await flush();
    expect(panel.text()).toContain("组合检查不应给出整体结论");
    expect(mounted.wrapper.find('[data-testid="impact-combination-check"]').exists()).toBe(false);
  });

  it("刷新 stale 状态时保留未知影响命令的原 ID", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let posts = 0;
    stubFetch({ [`${scope}/artifact-versions/${beforeVersionId}/impact-checks`]: () => {
      posts += 1;
      throw new TypeError("lost response after submit");
    } });
    const mounted = await mountWorkbench(`/artifact-versions/${afterVersionId}/lineage`);
    unmount = mounted.unmount;
    const panel = mounted.wrapper.get('[data-testid="artifact-impact-check"]');
    await mounted.wrapper.find("select").setValue(beforeVersionId); await flush();
    await panel.find("button.primary-button").trigger("click"); await flush();
    const pending = panel.get('[data-testid="artifact-impact-pending"]').text();
    const refresh = panel.findAll("button").find((node) => node.text() === "刷新产物与影响状态");
    await refresh!.trigger("click"); await flush();
    expect(panel.get('[data-testid="artifact-impact-pending"]').text()).toBe(pending);
    expect(panel.text()).toContain("仍待核对");
    expect(posts).toBe(1);
  });

  it("服务端接受影响检查但首次读回失败后，刷新按原资源 ID 恢复且不重发", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let posts = 0;
    const readIds: string[] = [];
    stubFetch({
      [`${scope}/artifact-versions/${beforeVersionId}/impact-checks`]: () => {
        posts += 1;
        return envelope({ impact_check_id: checkId, assistant_message_id: candidateOne });
      },
      [`${scope}/impact-checks/${checkId}`]: () => {
        readIds.push(checkId);
        if (readIds.length === 1) throw new TypeError("first readback unavailable");
        return json(check());
      },
    });
    const mounted = await mountWorkbench(`/artifact-versions/${afterVersionId}/lineage`);
    unmount = mounted.unmount;
    const panel = mounted.wrapper.get('[data-testid="artifact-impact-check"]');
    await mounted.wrapper.find("select").setValue(beforeVersionId); await flush();
    await panel.find("button.primary-button").trigger("click"); await flush();
    expect(panel.find('[data-testid="artifact-impact-pending"]').exists()).toBe(true);
    expect((panel.find("button.primary-button").element as HTMLButtonElement).disabled).toBe(true);

    await panel.findAll("button").find((node) => node.text() === "刷新产物与影响状态")!.trigger("click"); await flush();
    expect(readIds).toEqual([checkId, checkId]);
    expect(posts).toBe(1);
    expect(panel.find('[data-testid="artifact-impact-pending"]').exists()).toBe(false);
    expect(panel.text()).toContain("已按服务端受理后保存的资源 ID 读回结果");
  });

  it("建组请求保存用户明确选择的候选前置关系", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const posted: Record<string, unknown>[] = [];
    stubFetch({}, (body) => { posted.push(body); });
    const mounted = await mountWorkbench(`/artifact-versions/${afterVersionId}/lineage`);
    unmount = mounted.unmount;
    const panel = mounted.wrapper.get('[data-testid="artifact-impact-check"]');
    await mounted.wrapper.find("select").setValue(beforeVersionId); await flush();
    await panel.find("button.primary-button").trigger("click"); await flush();
    const groupBoxes = panel.findAll('input[type="checkbox"]');
    await groupBoxes[groupBoxes.length - 2]!.setValue(true); await flush();
    await panel.findAll('input[type="checkbox"]')[panel.findAll('input[type="checkbox"]').length - 1]!.setValue(true); await flush();
    await panel.find('select[aria-label="77777777-7777-4777-8777-777777777777 的组内前置"]')
      .setValue(targetOne); await flush();
    await panel.findAll("button").filter((node) => node.text().startsWith("保存候选组"))[0]!.trigger("click"); await flush();
    expect(posted[0]?.dependencies).toEqual([{ target_version_id: targetTwo,
      depends_on_target_version_id: targetOne }]);
  });

  it("重新检查后不会把上一轮隐藏的组内依赖带入新组", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const posted: Record<string, unknown>[] = [];
    stubFetch({}, (body) => { posted.push(body); });
    const mounted = await mountWorkbench(`/artifact-versions/${afterVersionId}/lineage`);
    unmount = mounted.unmount;
    const panel = mounted.wrapper.get('[data-testid="artifact-impact-check"]');
    await mounted.wrapper.find("select").setValue(beforeVersionId); await flush();
    await panel.find("button.primary-button").trigger("click"); await flush();
    let groupBoxes = panel.findAll('input[type="checkbox"]');
    await groupBoxes[groupBoxes.length - 2]!.setValue(true);
    await groupBoxes[groupBoxes.length - 1]!.setValue(true); await flush();
    await panel.find(`select[aria-label="${targetTwo} 的组内前置"]`).setValue(targetOne); await flush();

    await panel.find("button.primary-button").trigger("click"); await flush();
    groupBoxes = panel.findAll('input[type="checkbox"]');
    await groupBoxes[groupBoxes.length - 2]!.setValue(true);
    await groupBoxes[groupBoxes.length - 1]!.setValue(true); await flush();
    await panel.findAll("button").filter((node) => node.text().startsWith("保存候选组"))[0]!.trigger("click"); await flush();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.dependencies).toEqual([]);
  });

  it("候选组收到明确业务拒绝后释放 pending，可修正后重试", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let posts = 0;
    stubFetch({ [`${scope}/impact-checks/${checkId}/candidate-groups`]: () => {
      posts += 1;
      return json({ code: "INVALID_TRANSITION", detail: "dependency rejected" }, 409);
    } });
    const mounted = await mountWorkbench(`/artifact-versions/${afterVersionId}/lineage`);
    unmount = mounted.unmount;
    const panel = mounted.wrapper.get('[data-testid="artifact-impact-check"]');
    await mounted.wrapper.find("select").setValue(beforeVersionId); await flush();
    await panel.find("button.primary-button").trigger("click"); await flush();
    const groupBoxes = panel.findAll('input[type="checkbox"]');
    await groupBoxes[groupBoxes.length - 2]!.setValue(true);
    await groupBoxes[groupBoxes.length - 1]!.setValue(true); await flush();
    const saveGroup = panel.findAll("button").find((node) => node.text().startsWith("保存候选组"))!;
    await saveGroup.trigger("click"); await flush();
    expect(panel.find('[data-testid="artifact-impact-pending"]').exists()).toBe(false);
    expect(panel.text()).toContain("dependency rejected");
    expect((saveGroup.element as HTMLButtonElement).disabled).toBe(false);
    await saveGroup.trigger("click"); await flush();
    expect(posts).toBe(2);
  });

  it("分项应用前的过期预检是确定未提交，不会留下 UNKNOWN pending", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let applyPosts = 0;
    const mounted = await reachGroup({
      [`${scope}/impact-candidate-groups/${groupId}`]: () => json(groupWithoutAppliedCandidate()),
      [`${scope}/impact-group-selections/${selectionId}`]: () => json(groupSelection(false)),
      [`${scope}/artifacts/${targetArtifactId}`]: () => json(targetArtifact("4")),
    }, () => { applyPosts += 1; });
    const panel = mounted.wrapper.get('[data-testid="artifact-impact-check"]');
    await panel.get(`[data-testid="group-candidate-${candidateOne}"]`).setValue(true); await flush();
    await panel.findAll("button").find((node) => node.text().startsWith("保存依赖选择与顺序"))!.trigger("click"); await flush();
    await panel.findAll("button").find((node) => node.text() === "应用此项")!.trigger("click"); await flush();
    expect(panel.text()).toContain("目标成果或确切版本已变化");
    expect(panel.find('[data-testid="artifact-impact-pending"]').exists()).toBe(false);
    expect(applyPosts).toBe(0);
  });

  it("分项应用后从可选候选与待提交选择中移除已应用项", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let applied = false;
    const groupRoute = () => json(applied ? { ...groupWithoutAppliedCandidate(),
      items: ((groupWithoutAppliedCandidate().items as Record<string, unknown>[]).map((item, index) =>
        index === 0 ? { ...item, applied_version_id: appliedVersionId } : item)),
      summary: { total: 2, applied: 1, with_candidate: 1, without_candidate: 1,
        stale_candidates: 0, unavailable: 0 } } : groupWithoutAppliedCandidate());
    const mounted = await reachGroup({
      [`${scope}/impact-candidate-groups/${groupId}`]: groupRoute,
      [`${scope}/impact-group-selections/${selectionId}`]: () => json(groupSelection(applied)),
      [`${scope}/artifacts/${targetArtifactId}`]: () => json(targetArtifact("3")),
    }, () => { applied = true; });
    const panel = mounted.wrapper.get('[data-testid="artifact-impact-check"]');
    await panel.get(`[data-testid="group-candidate-${candidateOne}"]`).setValue(true); await flush();
    await panel.findAll("button").find((node) => node.text().startsWith("保存依赖选择与顺序"))!.trigger("click"); await flush();
    await panel.findAll("button").find((node) => node.text() === "应用此项")!.trigger("click");
    await flush();
    expect(panel.find(`[data-testid="group-candidate-${candidateOne}"]`).exists()).toBe(false);
    const saveSelection = panel.findAll("button").find((node) => node.text().startsWith("保存依赖选择与顺序"));
    expect((saveSelection?.element as HTMLButtonElement).disabled).toBe(true);
  });

  it("刷新读回候选已在其他路径应用后裁剪选择并隐藏不可应用动作", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let applied = false;
    const refreshedGroup = () => {
      const value = groupWithoutAppliedCandidate();
      const items = value.items as Record<string, unknown>[];
      return json(applied ? { ...value, items: items.map((item, index) => index === 0
        ? { ...item, applied_version_id: appliedVersionId } : item),
      summary: { total: 2, applied: 1, with_candidate: 1, without_candidate: 1,
        stale_candidates: 0, unavailable: 0 } } : value);
    };
    const mounted = await reachGroup({
      [`${scope}/impact-candidate-groups/${groupId}`]: refreshedGroup,
      [`${scope}/impact-group-selections/${selectionId}`]: () => json(groupSelection(applied)),
    });
    const panel = mounted.wrapper.get('[data-testid="artifact-impact-check"]');
    await panel.get(`[data-testid="group-candidate-${candidateOne}"]`).setValue(true); await flush();
    await panel.findAll("button").find((node) => node.text().startsWith("保存依赖选择与顺序"))!.trigger("click"); await flush();
    expect(panel.findAll("button").some((node) => node.text() === "应用此项")).toBe(true);
    applied = true;
    await panel.findAll("button").find((node) => node.text() === "刷新产物与影响状态")!.trigger("click"); await flush();
    expect(panel.find(`[data-testid="group-candidate-${candidateOne}"]`).exists()).toBe(false);
    expect(panel.findAll("button").some((node) => node.text() === "应用此项")).toBe(false);
    const saveSelection = panel.findAll("button").find((node) => node.text().startsWith("保存依赖选择与顺序"));
    expect((saveSelection?.element as HTMLButtonElement).disabled).toBe(true);
  });

  it("组内应用已受理但首次读回失败后，刷新恢复原组与选择且不重发", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let applied = false;
    let applyPosts = 0;
    let selectionReads = 0;
    const groupRoute = () => {
      const value = groupWithoutAppliedCandidate();
      const items = value.items as Record<string, unknown>[];
      return json(applied ? { ...value, items: items.map((item, index) => index === 0
        ? { ...item, applied_version_id: appliedVersionId } : item),
      summary: { total: 2, applied: 1, with_candidate: 1, without_candidate: 1,
        stale_candidates: 0, unavailable: 0 } } : value);
    };
    const mounted = await reachGroup({
      [`${scope}/impact-candidate-groups/${groupId}`]: groupRoute,
      [`${scope}/impact-group-selections/${selectionId}`]: () => {
        selectionReads += 1;
        if (selectionReads === 2) throw new TypeError("first accepted readback unavailable");
        return json(groupSelection(applied));
      },
      [`${scope}/artifacts/${targetArtifactId}`]: () => json(targetArtifact("3")),
    }, () => { applied = true; applyPosts += 1; });
    const panel = mounted.wrapper.get('[data-testid="artifact-impact-check"]');
    await panel.get(`[data-testid="group-candidate-${candidateOne}"]`).setValue(true); await flush();
    await panel.findAll("button").find((node) => node.text().startsWith("保存依赖选择与顺序"))!.trigger("click"); await flush();
    await panel.findAll("button").find((node) => node.text() === "应用此项")!.trigger("click"); await flush();
    expect(panel.find('[data-testid="artifact-impact-pending"]').exists()).toBe(true);
    expect((panel.findAll("button").find((node) => node.text() === "应用此项")!.element as HTMLButtonElement).disabled).toBe(true);

    await panel.findAll("button").find((node) => node.text() === "刷新产物与影响状态")!.trigger("click"); await flush();
    expect(selectionReads).toBe(3);
    expect(applyPosts).toBe(1);
    expect(panel.find('[data-testid="artifact-impact-pending"]').exists()).toBe(false);
    expect(panel.text()).toContain("已按服务端受理后保存的资源 ID 读回结果");
  });

  it("新候选组已受理但首次读回失败时清除旧选择与组合单，再按新组 ID 恢复", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let newGroupReads = 0;
    let groupPosts = 0;
    stubFetch({
      [`${scope}/impact-candidate-groups/${groupId}`]: () => {
        return json(groupWithoutAppliedCandidate());
      },
      [`${scope}/impact-candidate-groups/${nextGroupId}`]: () => {
        newGroupReads += 1;
        if (newGroupReads === 1) throw new TypeError("new group first readback unavailable");
        return json({ ...groupWithoutAppliedCandidate(), id: nextGroupId });
      },
      [`${scope}/impact-group-selections/${selectionId}`]: () => json(groupSelection(false)),
      [`${scope}/impact-checks/${checkId}/candidate-groups`]: () => {
        groupPosts += 1;
        return envelope({ group_id: groupPosts === 1 ? groupId : nextGroupId, item_count: "2" });
      },
    });
    const mounted = await reachGroup();
    const panel = mounted.wrapper.get('[data-testid="artifact-impact-check"]');
    await panel.get(`[data-testid="group-candidate-${candidateOne}"]`).setValue(true); await flush();
    await panel.findAll("button").find((node) => node.text().startsWith("保存依赖选择与顺序"))!.trigger("click"); await flush();
    await panel.findAll("button").find((node) => node.text().startsWith("保存组合检查单"))!.trigger("click"); await flush();
    expect(panel.find('[data-testid="impact-group-selection"]').exists()).toBe(true);
    expect(panel.find('[data-testid="impact-combination-check"]').exists()).toBe(true);

    await panel.findAll("button").find((node) => node.text().startsWith("保存候选组"))!.trigger("click"); await flush();
    expect(groupPosts).toBe(2);
    expect(panel.find('[data-testid="artifact-impact-pending"]').exists()).toBe(true);
    expect(panel.find('[data-testid="impact-group-selection"]').exists()).toBe(false);
    expect(panel.find('[data-testid="impact-combination-check"]').exists()).toBe(false);

    await panel.findAll("button").find((node) => node.text() === "刷新产物与影响状态")!.trigger("click"); await flush();
    expect(newGroupReads).toBe(2);
    expect(panel.find('[data-testid="artifact-impact-pending"]').exists()).toBe(false);
    expect(panel.find('[data-testid="impact-group-selection"]').exists()).toBe(false);
    expect(panel.find('[data-testid="impact-combination-check"]').exists()).toBe(false);
  });
});
