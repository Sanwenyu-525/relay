import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangle, Brain, Clock, Database, Download, Pin, PinOff, Plus, RefreshCw,
  Search, ShieldCheck, Trash2, Upload, Wrench
} from "lucide-react";
import { MemoryProvenancePanel } from "../components/MessageMemorySources";
import {
  createCommandId, RelayTransportError, type RelayApiClient, type RelayMemory,
  type RelayMemoryCaptureTask, type RelayMemoryEffectiveStatus, type RelayMemoryOrigin,
  type RelayMemoryRevision, type RelayMemorySourceKind, type RelayMemoryStats,
  type RelayMemoryType, type RelayMemoryVerification
} from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import { Alert, Badge, Button, Dialog, EmptyState, FormField, Input, PageHeader, Select, Textarea } from "../ui";
import "./MemoryView.css";

/**
 * 记忆管理页（0164 / 0167）。
 *
 * 唯一管理入口：列表、筛选、游标分页、详情、修订、固定、人工验证、有效期、
 * 停用/恢复、真实删除、整理与导入导出。所有事实来自服务端，不在浏览器里
 * 维护第二份状态，也不把单页结果当成完整记忆库。
 */

type EffectiveFilter = RelayMemoryEffectiveStatus | "ALL";
type TypeFilter = RelayMemoryType | "ALL";
type OriginFilter = RelayMemoryOrigin | "ALL";
type VerificationFilter = RelayMemoryVerification | "ALL";
type SourceKindFilter = RelayMemorySourceKind | "ALL";
type PinnedFilter = "ALL" | "PINNED" | "UNPINNED";
type SortFilter = "updated" | "created" | "importance";

const typeLabels: Record<RelayMemoryType, string> = {
  USER_PREFERENCE: "用户偏好", PROJECT_FACT: "项目事实", EXPERIENCE: "经验",
  EPISODIC: "事件", UNKNOWN: "未分类",
};
const verificationLabels: Record<RelayMemoryVerification, string> = {
  VERIFIED: "已验证", UNVERIFIED: "未验证", FAILED: "明确失败",
};
const effectiveLabels: Record<RelayMemoryEffectiveStatus, string> = {
  ACTIVE: "有效", EXPIRED: "已过期", RETIRED: "已停用", SUPERSEDED: "已被替代", STALE: "可能过时",
};
const originLabels: Record<RelayMemoryOrigin, string> = {
  HUMAN_CONFIRMED: "人工确认", AUTO_CAPTURE: "自动记住",
};
const sourceKindLabels: Record<RelayMemorySourceKind, string> = {
  MANUAL: "人工保存", USER_STATEMENT: "用户原话", MODEL_OBSERVATION: "模型观察", UNKNOWN: "来源未标注",
};
const scopeLabels: Record<string, string> = {
  WORKSPACE: "工作空间", PROJECT: "项目", TASK: "任务", AGENT: "Agent",
};
const captureStatusLabels: Record<RelayMemoryCaptureTask["status"], string> = {
  PENDING: "待捕获", RUNNING: "捕获中", SUCCEEDED: "已捕获", EMPTY: "无可提取内容",
  FAILED: "捕获失败", CANCELLED: "已取消",
};

function effectiveStatus(memory: RelayMemory): string {
  return memory.effectiveStatus === null ? "状态待核对" : effectiveLabels[memory.effectiveStatus];
}

function typeTone(type: RelayMemoryType): "neutral" | "success" | "warning" | "danger" {
  return type === "EXPERIENCE" ? "success" : type === "USER_PREFERENCE" ? "warning" : "neutral";
}

function verificationTone(verification: RelayMemoryVerification): "neutral" | "success" | "warning" | "danger" {
  return verification === "VERIFIED" ? "success" : verification === "FAILED" ? "danger" : "warning";
}

function effectiveTone(status: RelayMemoryEffectiveStatus | null): "neutral" | "success" | "warning" | "danger" {
  return status === "ACTIVE" ? "success" : status === "STALE" ? "warning"
    : status === "RETIRED" || status === "EXPIRED" ? "neutral" : "neutral";
}

function formatDate(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

function snippet(text: string, length = 120): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > length ? `${compact.slice(0, length)}…` : compact;
}

function shortId(value: string | null): string {
  return value === null ? "—" : `${value.slice(0, 8)}…`;
}

function expiryAfterDays(days: number, current: string | null): string {
  const base = current !== null && new Date(current).getTime() > Date.now()
    ? new Date(current) : new Date();
  base.setDate(base.getDate() + days);
  return base.toISOString();
}

interface Draft {
  readonly title: string;
  readonly text: string;
  readonly memoryType: RelayMemoryType;
  readonly memoryKey: string;
  readonly importance: number;
  readonly scope: "WORKSPACE" | "PROJECT" | "TASK";
  readonly projectId: string | null;
  readonly taskId: string;
}

const emptyDraft = (projectId: string | null): Draft => ({ title: "", text: "",
  memoryType: "PROJECT_FACT", memoryKey: "", importance: 3,
  scope: projectId === null ? "WORKSPACE" : "PROJECT", projectId, taskId: "" });

export default function MemoryView() {
  const connection = useRelayConnection();
  const client = connection.client;
  const live = connection.mode === "live";
  const [memories, setMemories] = useState<readonly RelayMemory[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageSort, setPageSort] = useState<SortFilter>("updated");
  const [stats, setStats] = useState<RelayMemoryStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [captureTasks, setCaptureTasks] = useState<readonly RelayMemoryCaptureTask[]>([]);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<readonly RelayMemoryRevision[]>([]);
  const [projects, setProjects] = useState<readonly { id: string; title: string }[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("ALL");
  const [statusFilter, setStatusFilter] = useState<EffectiveFilter>("ALL");
  const [originFilter, setOriginFilter] = useState<OriginFilter>("ALL");
  const [verificationFilter, setVerificationFilter] = useState<VerificationFilter>("ALL");
  const [sourceKindFilter, setSourceKindFilter] = useState<SourceKindFilter>("ALL");
  const [pinnedFilter, setPinnedFilter] = useState<PinnedFilter>("ALL");
  const [sortFilter, setSortFilter] = useState<SortFilter>("updated");
  const [queryText, setQueryText] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<RelayMemory | null>(null);
  const [retireTarget, setRetireTarget] = useState<RelayMemory | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<{ readonly ids?: readonly string[];
    readonly label: string; readonly includeActive: boolean } | null>(null);
  const [purgeText, setPurgeText] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const requestVersion = useRef(0);
  const formId = useId();
  const searchId = useId();
  const capturePanelId = useId();

  const selected = memories.find((memory) => memory.id === selectedId) ?? null;

  const loadCapture = useCallback(async (syncStats = false) => {
    if (client === null) return;
    const [rowsResult, statsResult] = await Promise.allSettled([
      client.getMemoryCaptureTasks({ limit: 10 }),
      syncStats ? client.getMemoryStats(projectId) : Promise.resolve(null),
    ]);
    if (rowsResult.status === "rejected") {
      setCaptureTasks([]);
      setCaptureError(describeLiveError(rowsResult.reason).message);
      return;
    }
    setCaptureTasks(rowsResult.value);
    setCaptureError(null);
    if (!syncStats) return;
    if (statsResult.status === "fulfilled" && statsResult.value !== null) {
      setStats(statsResult.value);
      setStatsError(null);
    } else if (statsResult.status === "rejected") {
      // 捕获任务已结算时，统计也必须与列表同拍；读不到就显示未知，不保留旧数字。
      setStats(null);
      setStatsError(describeLiveError(statsResult.reason).message);
    }
  }, [client, projectId]);

  const loadFirst = useCallback(async (keepSelection = true) => {
    if (client === null) { setLoading(false); return; }
    const request = ++requestVersion.current;
    setLoading(true); setError(null); setStatsError(null);
    try {
      // 统计与列表互不阻塞：统计端点故障时仍允许管理已有记忆。
      const [pageResult, statsResult] = await Promise.allSettled([
        client.getMemoryPage(projectId, statusFilter, {
          memoryType: typeFilter, origin: originFilter,
          verification: verificationFilter, sourceKind: sourceKindFilter,
          ...(pinnedFilter === "ALL" ? {} : { pinned: pinnedFilter === "PINNED" }),
          sort: sortFilter,
          ...(appliedQuery === "" ? {} : { query: appliedQuery }), pageSize: 50,
        }),
        client.getMemoryStats(projectId),
      ]);
      if (request !== requestVersion.current) return;
      if (pageResult.status === "rejected") throw pageResult.reason;
      const page = pageResult.value;
      if (statsResult.status === "fulfilled") setStats(statsResult.value);
      else {
        setStats(null);
        setStatsError(describeLiveError(statsResult.reason).message);
      }
      setMemories(page.items);
      setNextCursor(page.nextCursor);
      setPageSort(page.sort);
      setSelectedId((current) => keepSelection && current !== null &&
        page.items.some((row) => row.id === current) ? current : page.items[0]?.id ?? null);
    } catch (caught) {
      if (request !== requestVersion.current) return;
      // 列表请求失败时统计也无法确认；清空为“未知”，绝不沿用旧值伪装成最新统计。
      setStats(null);
      setStatsError(describeLiveError(caught).message);
      setError(describeLiveError(caught).message);
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }, [client, projectId, statusFilter, typeFilter, originFilter, verificationFilter,
    sourceKindFilter, pinnedFilter, sortFilter, appliedQuery]);

  useEffect(() => { void loadFirst(); }, [loadFirst]);
  useEffect(() => { void loadCapture(); }, [loadCapture]);
  /*
   * 2026-11-15：捕获面板展开且仍有 PENDING/RUNNING 时，每 6 秒读一次真实任务状态。
   * 全部终态立即停止；页面隐藏不轮询；卸载清计时器。失败由 loadCapture 清空旧数字并
   * 显示 captureError，绝不把上次成功读取的数据继续当作“最新”。
   */
  useEffect(() => {
    if (!captureOpen) return;
    if (!captureTasks.some((task) => task.status === "PENDING" || task.status === "RUNNING")) return;
    let timer: number | null = null;
    let disposed = false;
    const tick = (): void => {
      if (disposed) return;
      if (!document.hidden) void loadCapture(true);
      timer = window.setTimeout(tick, 6000);
    };
    const onVisibility = (): void => {
      if (!document.hidden) void loadCapture(true);
    };
    timer = window.setTimeout(tick, 6000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { disposed = true; if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility); };
  }, [captureOpen, captureTasks, loadCapture]);

  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    void client.getProjectsPage("active").then((page) => {
      if (!cancelled) setProjects(page.items.map((item) => ({ id: item.id, title: item.title })));
    }).catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => {
    if (selectedId === null) { setRevisions([]); return; }
    let cancelled = false;
    void client?.getMemoryRevisions(selectedId).then((rows) => {
      if (!cancelled) setRevisions(rows);
    }).catch(() => { if (!cancelled) setRevisions([]); });
    return () => { cancelled = true; };
  }, [client, selectedId]);

  if (client === null) {
    return <div className="memory-page">
      <PageHeader title="记忆" lede="长期记忆管理：用户偏好、项目事实、已验证经验与历史事件。" />
      <EmptyState title="没有可用的 Relay 连接"
        description="记忆管理需要真实工作空间连接；示例数据预览下不提供可读写的记忆。" />
    </div>;
  }

  async function refreshAfterCommand(): Promise<void> {
    await loadFirst();
    void loadCapture();
    if (selectedId !== null) {
      try { setRevisions(await client!.getMemoryRevisions(selectedId)); } catch { /* 列表已刷新，历史失败单独表现 */ }
    }
  }

  async function run(label: string, action: () => Promise<void>): Promise<void> {
    setBusy(label); setError(null); setNotice(null); setFormError(null);
    try { await action(); }
    catch (caught) {
      if (caught instanceof RelayTransportError) {
        setError(`${describeLiveError(caught).message} 命令可能已提交，请刷新核对后再决定是否重试。`);
      } else setError(describeLiveError(caught).message);
      await loadFirst();
    } finally { setBusy(null); }
  }

  function openCreate(): void {
    setEditing(null); setFormError(null);
    setDraft(emptyDraft(projectId));
  }

  function openEdit(memory: RelayMemory): void {
    setEditing(memory); setFormError(null);
    const scope = memory.scope === "TASK" ? "TASK" : memory.scope === "PROJECT" ? "PROJECT" : "WORKSPACE";
    setDraft({ title: memory.title, text: memory.text, memoryType: memory.memoryType,
      memoryKey: memory.memoryKey ?? "", importance: memory.importance, scope,
      projectId: memory.projectId, taskId: memory.taskId ?? "" });
  }

  async function saveDraft(): Promise<void> {
    if (draft === null) return;
    if (draft.title.trim() === "" || draft.text.trim() === "") {
      setFormError("标题与正文都不能为空。"); return;
    }
    if (draft.scope !== "WORKSPACE" && draft.projectId === null) {
      setFormError("项目/任务作用域必须先选择所属项目。"); return;
    }
    if (draft.scope === "TASK" && draft.taskId.trim() === "") {
      setFormError("任务作用域必须填写真实的任务 ID。"); return;
    }
    await run(editing === null ? "create" : "edit", async () => {
      const metadata = { memoryType: draft.memoryType, importance: draft.importance,
        memoryKey: draft.memoryKey.trim() === "" ? null : draft.memoryKey.trim(),
        taskId: draft.scope === "TASK" ? draft.taskId.trim() : null };
      if (editing === null) {
        await client!.createMemory({ commandId: createCommandId(),
          projectId: draft.scope === "WORKSPACE" ? null : draft.projectId,
          title: draft.title.trim(), text: draft.text.trim(), confirmed: true, ...metadata });
        setNotice("已创建记忆并写入检索索引。");
      } else {
        await client!.addMemoryRevision({ id: editing.id, commandId: createCommandId(),
          expectedRevision: editing.revision, title: draft.title.trim(),
          text: draft.text.trim(), confirmed: true, memoryType: metadata.memoryType,
          memoryKey: metadata.memoryKey, importance: metadata.importance });
        setNotice("已保存为新修订；旧版本仍可在历史中查看，旧验证状态不会被自动继承。");
      }
      setDraft(null); setEditing(null);
      await refreshAfterCommand();
    });
  }

  async function pin(memory: RelayMemory): Promise<void> {
    await run("pin", async () => {
      await client!.pinMemory(memory.id, createCommandId(), memory.revision, !memory.pinned);
      setNotice(memory.pinned ? "已取消固定。" : "已固定；该记忆会优先进入每轮常驻预算。");
      await refreshAfterCommand();
    });
  }

  async function verify(memory: RelayMemory, verification: RelayMemoryVerification): Promise<void> {
    await run("verify", async () => {
      await client!.verifyMemory(memory.id, { commandId: createCommandId(),
        expectedRevision: memory.revision, verification,
        clearStale: verification === "VERIFIED" });
      setNotice(`已标记为「${verificationLabels[verification]}」。`);
      await refreshAfterCommand();
    });
  }

  async function toggleRetired(memory: RelayMemory): Promise<void> {
    await run("retire", async () => {
      if (memory.status === "ACTIVE") {
        await client!.retireMemory(memory.id, createCommandId(), memory.revision);
        setNotice("已停用；停用项不再进入召回，但仍保留正文、版本与来源，可在原处恢复。");
      } else {
        await client!.reactivateMemory(memory.id, createCommandId(), memory.revision);
        setNotice("已恢复为有效；是否进入召回仍按有效期与作用域判断。");
      }
      setRetireTarget(null);
      await refreshAfterCommand();
    });
  }

  async function extendExpiry(memory: RelayMemory, expiresAt: string | null): Promise<void> {
    await run("expiry", async () => {
      await client!.extendMemoryExpiry(memory.id, { commandId: createCommandId(),
        expectedRevision: memory.revision, expiresAt });
      setNotice(expiresAt === null ? "已取消自动过期，改为长期有效。"
        : `有效期已调整为 ${formatDate(expiresAt)}。`);
      await refreshAfterCommand();
    });
  }

  async function confirmPurge(): Promise<void> {
    if (purgeTarget === null || purgeText !== "DELETE_MEMORIES") return;
    await run("purge", async () => {
      const result = await client!.purgeMemories({ commandId: createCommandId(),
        projectId, ...(purgeTarget.ids === undefined ? {} : { memoryIds: purgeTarget.ids }),
        includeActive: purgeTarget.includeActive });
      setPurgeTarget(null); setPurgeText("");
      setNotice(`已真实删除 ${String(result.result.deleted ?? "0")} 条记忆及其派生索引。`);
      await refreshAfterCommand();
    });
  }

  async function consolidate(): Promise<void> {
    await run("consolidate", async () => {
      const result = await client!.runMemoryConsolidation(createCommandId());
      setNotice(`整理完成：${String(result.result.status ?? "")}，重复组 `
        + `${String(result.result.duplicate_groups ?? 0)}，替代 `
        + `${Number(result.result.superseded_duplicates ?? 0) + Number(result.result.superseded_key ?? 0)} 条，`
        + `标记陈旧 ${String(result.result.stale_marked ?? 0)} 条，索引回填 `
        + `${String(result.result.index_backfilled ?? 0)} 条。`);
      await refreshAfterCommand();
    });
  }

  async function exportAll(): Promise<void> {
    await run("export", async () => {
      const payload = await client!.exportMemories(projectId);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = "relay-memories.json"; anchor.click();
      URL.revokeObjectURL(url);
      setNotice("已导出当前范围的可导出记忆（正文、版本与元数据，不含会话/消息凭据）。");
    });
  }

  async function importFile(file: File): Promise<void> {
    await run("import", async () => {
      const text = await file.text();
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(text) as Record<string, unknown>; }
      catch { throw new Error("导入文件不是合法 JSON。"); }
      const result = await client!.importMemories({ commandId: createCommandId(),
        projectId, payload });
      setNotice(`导入完成：新增 ${String(result.result.created ?? 0)} 条，替代 `
        + `${String(result.result.superseded ?? 0)} 条，重复跳过 ${String(result.result.duplicate ?? 0)} 条，`
        + `冲突跳过 ${String(result.result.conflict ?? 0)} 条，敏感拒绝 ${String(result.result.sensitive ?? 0)} 条。`);
      await refreshAfterCommand();
    });
  }

  async function loadMore(): Promise<void> {
    if (client === null || nextCursor === null || loadingMore) return;
    const request = requestVersion.current;
    setLoadingMore(true);
    try {
      const page = await client.getMemoryPage(projectId, statusFilter, {
        memoryType: typeFilter, origin: originFilter,
        verification: verificationFilter, sourceKind: sourceKindFilter,
        ...(pinnedFilter === "ALL" ? {} : { pinned: pinnedFilter === "PINNED" }),
        sort: sortFilter, cursor: nextCursor,
        ...(appliedQuery === "" ? {} : { query: appliedQuery }), pageSize: 50,
      });
      if (request !== requestVersion.current) return;
      setMemories((current) => {
        const seen = new Set(current.map((row) => row.id));
        return [...current, ...page.items.filter((row) => !seen.has(row.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (request === requestVersion.current) setError(describeLiveError(caught).message);
    } finally {
      if (request === requestVersion.current) setLoadingMore(false);
    }
  }

  async function captureAction(task: RelayMemoryCaptureTask, action: "retry" | "cancel"): Promise<void> {
    await run(`capture-${action}`, async () => {
      const receipt = action === "retry"
        ? await client!.retryMemoryCaptureTask(task.id, createCommandId())
        : await client!.cancelMemoryCaptureTask(task.id, createCommandId());
      if (String(receipt.result.executed) !== "true") {
        setNotice("任务已进入终态，本次操作未生效；请核对最新状态。");
      } else {
        setNotice(action === "retry" ? "已重新排队捕获任务。" : "已取消捕获任务。");
      }
      await loadCapture();
    });
  }

  const filtersActive = typeFilter !== "ALL" || statusFilter !== "ALL" || originFilter !== "ALL" ||
    verificationFilter !== "ALL" || sourceKindFilter !== "ALL" || pinnedFilter !== "ALL" ||
    appliedQuery !== "" || projectId !== null;

  function resetFilters(): void {
    setTypeFilter("ALL"); setStatusFilter("ALL"); setOriginFilter("ALL");
    setVerificationFilter("ALL"); setSourceKindFilter("ALL"); setPinnedFilter("ALL");
    setProjectId(null); setQueryText(""); setAppliedQuery(""); setSortFilter("updated");
  }

  return <div className="memory-page">
    <PageHeader title="记忆" overline="长期知识"
      lede="用户偏好、项目事实、已验证经验与历史事件。召回内容只是参考数据，不替代任务状态、验收结论或权限。"
      status={<Badge tone={live ? "success" : "warning"}>{live ? "实时数据" : "非实时连接"}</Badge>}
      actions={<>
        <Button variant="secondary" disabled={busy !== null || loading} onClick={() => void loadFirst()}>
          <RefreshCw aria-hidden="true" />刷新
        </Button>
        <Button variant="primary" onClick={openCreate}><Plus aria-hidden="true" />新建记忆</Button>
      </>}
      more={<>
        <Button variant="secondary" disabled={busy !== null} onClick={() => void consolidate()}>
          <Wrench aria-hidden="true" />立即整理
        </Button>
        <Button variant="secondary" disabled={busy !== null} onClick={() => void exportAll()}>
          <Download aria-hidden="true" />导出
        </Button>
        <Button variant="secondary" disabled={busy !== null} onClick={() => importRef.current?.click()}>
          <Upload aria-hidden="true" />导入
        </Button>
        <Button variant="secondary" disabled={busy !== null}
          onClick={() => { setPurgeText(""); setPurgeTarget({ label: "已停用、已过期、已被替代或可能过时的记忆", includeActive: false }); }}>
          <Trash2 aria-hidden="true" />清理失效项
        </Button>
      </>}>
      <input ref={importRef} type="file" accept="application/json,.json" hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file !== undefined) void importFile(file);
        }} />
    </PageHeader>

    {error !== null && <Alert tone="danger" title="记忆操作未完成">
      <p>{error}</p>
      <Button variant="secondary" onClick={() => void loadFirst()}>重新读取</Button>
    </Alert>}
    {notice !== null && <p className="memory-notice" role="status" data-testid="memory-notice">{notice}</p>}

    <MemoryStatsPanel stats={stats} error={statsError} />
    <CapturePanel tasks={captureTasks} error={captureError} busy={busy}
      onRetry={(task) => void captureAction(task, "retry")}
      onCancel={(task) => void captureAction(task, "cancel")} panelId={capturePanelId}
      onToggle={(open) => { setCaptureOpen(open); if (open) void loadCapture(true); }} />

    <div className="memory-columns">
      <section className="memory-list-panel" aria-label="记忆列表">
        <div className="memory-filters">
          <FormField label="搜索记忆" htmlFor={searchId}>
            <div className="memory-search-row">
              <Input id={searchId} value={queryText} placeholder="搜索标题、正文、结构化键"
                onChange={(event) => setQueryText(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") setAppliedQuery(queryText.trim()); }} />
              <Button variant="secondary" aria-label="搜索记忆" onClick={() => setAppliedQuery(queryText.trim())}>
                <Search aria-hidden="true" />
              </Button>
            </div>
          </FormField>
          <div className="memory-filter-grid">
            <FormField label="类型">
              <Select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}>
                <option value="ALL">全部类型</option>
                {(Object.keys(typeLabels) as RelayMemoryType[]).map((type) =>
                  <option key={type} value={type}>{typeLabels[type]}</option>)}
              </Select>
            </FormField>
            <FormField label="验证状态">
              <Select value={verificationFilter}
                onChange={(event) => setVerificationFilter(event.target.value as VerificationFilter)}>
                <option value="ALL">全部验证状态</option>
                <option value="UNVERIFIED">未验证</option>
                <option value="VERIFIED">已验证</option>
                <option value="FAILED">明确失败</option>
              </Select>
            </FormField>
            <FormField label="有效状态">
              <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as EffectiveFilter)}>
                <option value="ALL">全部有效状态</option>
                <option value="ACTIVE">有效</option>
                <option value="STALE">可能过时</option>
                <option value="SUPERSEDED">已被替代</option>
                <option value="EXPIRED">已过期</option>
                <option value="RETIRED">已停用</option>
              </Select>
            </FormField>
            <FormField label="来源">
              <Select value={originFilter} onChange={(event) => setOriginFilter(event.target.value as OriginFilter)}>
                <option value="ALL">全部来源</option>
                <option value="HUMAN_CONFIRMED">人工确认</option>
                <option value="AUTO_CAPTURE">自动记住</option>
              </Select>
            </FormField>
            <FormField label="来源类型">
              <Select value={sourceKindFilter}
                onChange={(event) => setSourceKindFilter(event.target.value as SourceKindFilter)}>
                <option value="ALL">全部来源类型</option>
                <option value="MANUAL">人工保存</option>
                <option value="USER_STATEMENT">用户原话</option>
                <option value="MODEL_OBSERVATION">模型观察</option>
                <option value="UNKNOWN">来源未标注</option>
              </Select>
            </FormField>
            <FormField label="固定状态">
              <Select value={pinnedFilter} onChange={(event) => setPinnedFilter(event.target.value as PinnedFilter)}>
                <option value="ALL">全部</option>
                <option value="PINNED">仅固定</option>
                <option value="UNPINNED">仅未固定</option>
              </Select>
            </FormField>
            <FormField label="项目">
              <Select value={projectId ?? ""} onChange={(event) =>
                setProjectId(event.target.value === "" ? null : event.target.value)}>
                <option value="">全部工作空间</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
              </Select>
            </FormField>
            <FormField label="排序">
              <Select value={sortFilter} onChange={(event) => setSortFilter(event.target.value as SortFilter)}>
                <option value="updated">最近更新</option>
                <option value="created">最近创建</option>
                <option value="importance">重要性</option>
              </Select>
            </FormField>
          </div>
          {filtersActive && <div className="memory-filter-note">
            <p className="helper-text">当前为筛选结果。</p>
            <Button variant="text" onClick={resetFilters}>重置筛选</Button>
          </div>}
        </div>

        {loading && memories.length === 0 && <p className="loading-text" role="status">正在读取记忆…</p>}
        {!loading && memories.length === 0 && <EmptyState title={filtersActive ? "没有匹配的记忆" : "还没有长期记忆"}
          description={filtersActive ? "调整类型、验证状态、来源或搜索词后再试。"
            : "对话里明确要求记住的内容、经过验证的经验，或在这里手动新建的记忆会出现在这里。"} />}
        {memories.length > 0 && <ul className="memory-rows">
          {memories.map((memory) => <li key={memory.id}>
            <button type="button" className={`memory-row${memory.id === selectedId ? " memory-row--active" : ""}`}
              data-testid="memory-row"
              aria-current={memory.id === selectedId ? "true" : undefined} onClick={() => setSelectedId(memory.id)}>
              <span className="memory-row-icon"><Brain aria-hidden="true" /></span>
              <span className="memory-row-main">
                <strong>{memory.title}{memory.pinned && <Pin className="memory-pin" aria-label="已固定" />}</strong>
                <span className="memory-row-snippet">{snippet(memory.text)}</span>
                <span className="memory-row-meta">
                  <Badge tone={typeTone(memory.memoryType)}>{typeLabels[memory.memoryType]}</Badge>
                  <span className="memory-verification" data-tone={verificationTone(memory.verification)}>
                    验证：{verificationLabels[memory.verification]}
                  </span>
                  <span className="memory-effective" data-tone={effectiveTone(memory.effectiveStatus)}>
                    状态：{effectiveStatus(memory)}
                  </span>
                  <span>{sourceKindLabels[memory.sourceKind]}</span>
                  <span>{scopeLabels[memory.scope] ?? memory.scope}</span>
                  <span>{formatDate(memory.updatedAt)}</span>
                  {memory.instructionRisk && <span className="memory-risk">含指令风险</span>}
                </span>
              </span>
            </button>
          </li>)}
        </ul>}
        {memories.length > 0 && <div className="memory-pagination">
          <span className="helper-text">已加载 {memories.length} 条{nextCursor === null ? "，已到当前查询末尾" : ""}</span>
          {nextCursor !== null && <Button variant="secondary" disabled={loadingMore}
            data-testid="memory-load-more" onClick={() => void loadMore()}>
            {loadingMore ? "正在加载…" : "加载更多"}</Button>}
        </div>}
      </section>

      <section className="memory-detail" aria-label="记忆详情">
        {selected === null ? <EmptyState title="选择一条记忆" description="左侧列表中的条目可以查看正文、来源、修订与替代关系。" />
          : <MemoryDetail memory={selected} pageSort={pageSort} revisions={revisions} busy={busy} client={client}
            onEdit={() => openEdit(selected)} onPin={() => void pin(selected)}
            onVerify={(verification) => void verify(selected, verification)}
            onRetire={() => setRetireTarget(selected)}
            onExpiry={(value) => void extendExpiry(selected, value)}
            onDelete={() => { setPurgeText(""); setPurgeTarget({ ids: [selected.id],
              label: `「${selected.title}」这一条记忆`, includeActive: true }); }} />}
      </section>
    </div>

    <Dialog open={draft !== null} title={editing === null ? "新建记忆" : "编辑记忆"} size="lg"
      onClose={() => { setDraft(null); setEditing(null); setFormError(null); }}>
      {draft !== null && <div className="memory-form">
        <FormField label="标题" required htmlFor={`${formId}-title`}>
          <Input id={`${formId}-title`} value={draft.title} maxLength={200}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        </FormField>
        <div className="memory-form-grid">
          <FormField label="类型">
            <Select value={draft.memoryType} onChange={(event) =>
              setDraft({ ...draft, memoryType: event.target.value as RelayMemoryType })}>
              {(Object.keys(typeLabels) as RelayMemoryType[]).filter((type) => type !== "UNKNOWN").map((type) =>
                <option key={type} value={type}>{typeLabels[type]}</option>)}
            </Select>
          </FormField>
          <FormField label="作用域">
            <Select value={draft.scope} disabled={editing !== null}
              onChange={(event) => {
                const scope = event.target.value as "WORKSPACE" | "PROJECT" | "TASK";
                setDraft({ ...draft, scope,
                  projectId: scope === "WORKSPACE" ? null : draft.projectId ?? projects[0]?.id ?? null,
                  taskId: scope === "TASK" ? draft.taskId : "" });
              }}>
              <option value="WORKSPACE">工作空间</option>
              <option value="PROJECT">项目</option>
              <option value="TASK">任务</option>
            </Select>
          </FormField>
          <FormField label="所属项目">
            <Select value={draft.projectId ?? ""} disabled={editing !== null || draft.scope === "WORKSPACE"}
              onChange={(event) => setDraft({ ...draft, projectId: event.target.value === "" ? null : event.target.value })}>
              <option value="">请选择项目</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
            </Select>
          </FormField>
          {draft.scope === "TASK" && <FormField label="任务 ID" hint="必须属于上面选择的项目；服务端会校验真实任务。">
            <Input value={draft.taskId} placeholder="任务的 UUID" onChange={(event) =>
              setDraft({ ...draft, taskId: event.target.value })} />
          </FormField>}
          <FormField label="结构化键" hint="同一作用域、同一类型的同键新事实会替代旧事实。">
            <Input value={draft.memoryKey} maxLength={80} placeholder="如 package-manager"
              onChange={(event) => setDraft({ ...draft, memoryKey: event.target.value })} />
          </FormField>
          <FormField label="重要性" hint="1–5，影响召回排序与常驻预算。">
            <Select value={String(draft.importance)} onChange={(event) =>
              setDraft({ ...draft, importance: Number(event.target.value) })}>
              {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
            </Select>
          </FormField>
        </div>
        <FormField label="正文" required htmlFor={`${formId}-text`}
          hint="保存后立即进入检索索引；自动提取的条目仍标为未验证。">
          <Textarea id={`${formId}-text`} rows={8} value={draft.text} data-testid="memory-form-text"
            onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
        </FormField>
        {formError !== null && <p className="field-error" role="alert">{formError}</p>}
        <div className="memory-form-actions">
          <Button variant="secondary" onClick={() => { setDraft(null); setEditing(null); }}>取消</Button>
          <Button variant="primary" disabled={busy !== null} onClick={() => void saveDraft()} data-testid="memory-form-save">
            {busy === "create" || busy === "edit" ? "正在保存" : editing === null ? "创建" : "保存修订"}
          </Button>
        </div>
      </div>}
    </Dialog>

    <Dialog open={retireTarget !== null}
      title={retireTarget?.status === "ACTIVE" ? "停用记忆" : "恢复记忆"}
      onClose={() => setRetireTarget(null)}>
      <div className="memory-form">
        <p>{retireTarget?.status === "ACTIVE"
          ? "停用后这条记忆不再进入召回，但正文、历史版本和来源都会保留；之后可以在详情里恢复。"
          : "恢复后这条记忆重新参与有效性判断；是否进入召回仍按有效期、作用域与验证状态决定。"}</p>
        <p className="helper-text">{retireTarget?.status === "ACTIVE"
          ? "停用不等于删除。若要彻底移除，请使用「删除」并完成二次确认。"
          : "恢复不是重新验证，也不会改变正文、版本或来源。"}</p>
        <div className="memory-form-actions">
          <Button variant="secondary" onClick={() => setRetireTarget(null)}>取消</Button>
          <Button variant={retireTarget?.status === "ACTIVE" ? "danger" : "primary"}
            disabled={busy !== null}
            onClick={() => { if (retireTarget !== null) void toggleRetired(retireTarget); }}>
            {busy === "retire" ? (retireTarget?.status === "ACTIVE" ? "正在停用" : "正在恢复")
              : (retireTarget?.status === "ACTIVE" ? "确认停用" : "确认恢复")}</Button>
        </div>
      </div>
    </Dialog>

    <Dialog open={purgeTarget !== null} title="真实删除记忆" onClose={() => setPurgeTarget(null)}>
      <div className="memory-form">
        <Alert tone="danger" title="删除不可撤销">
          <p>将真实删除{purgeTarget?.label}，同时移除全文索引、版本、来源引用与派生缓存；
            以后的自动整理也不会从旧摘要恢复它。</p>
          <p className="helper-text">需要区分「停用」时请使用停用操作：停用只退出召回，仍保留历史。</p>
        </Alert>
        <FormField label="输入 DELETE_MEMORIES 确认">
          <Input value={purgeText} autoComplete="off" onChange={(event) => setPurgeText(event.target.value)} />
        </FormField>
        <div className="memory-form-actions">
          <Button variant="secondary" onClick={() => setPurgeTarget(null)}>取消</Button>
          <Button variant="danger" disabled={purgeText !== "DELETE_MEMORIES" || busy !== null}
            onClick={() => void confirmPurge()}>{busy === "purge" ? "正在删除" : "真实删除"}</Button>
        </div>
      </div>
    </Dialog>
  </div>;
}

function MemoryStatsPanel({ stats, error }: { readonly stats: RelayMemoryStats | null;
  readonly error: string | null }) {
  const unknown = stats === null;
  return <section className="memory-stats" aria-label="记忆统计">
    {error !== null && <p className="helper-text memory-stats-error" role="status">
      统计暂不可用：{error}；下面的“—”表示未知，不是 0。记忆列表仍可查看和管理。</p>}
    <div className="memory-stats-core">
      <Stat label="记忆总数" value={stats?.total} hero />
      <Stat label="有效记忆" value={stats?.active} hero tone="success" />
      <Stat label="未验证记忆" value={stats?.unverified} hero tone="warning" />
      <Stat label="可能过时" value={stats?.stale} hero tone="warning" />
    </div>
    <div className="memory-stats-diagnostics" aria-label="诊断指标">
      <Diag label="固定记忆" value={unknown ? undefined : String(stats.pinned)} />
      <Diag label="存储占用" value={unknown ? undefined : formatBytes(stats.storageBytes)} />
      <Diag label="24h 召回" value={unknown ? undefined : String(stats.recall.last24h)} />
      <Diag label="平均召回耗时" value={unknown ? undefined
        : stats.recall.avgLatencyMs === null ? "暂无召回" : `${stats.recall.avgLatencyMs} ms`} />
      <Diag label="索引健康" value={unknown ? undefined
        : stats.indexHealth.ftsIndexPresent ? `正常 · 待回填 ${stats.indexHealth.unindexed}` : "全文索引缺失"} />
      <Diag label="含指令风险" value={unknown ? undefined : String(stats.instructionRisk)} />
      <Diag label="捕获待处理" value={unknown ? undefined : String(stats.capture.pending)} />
      <Diag label="捕获失败" value={unknown ? undefined : String(stats.capture.failed)} />
    </div>
  </section>;
}

function CapturePanel({ tasks, error, busy, onRetry, onCancel, panelId, onToggle }: {
  readonly tasks: readonly RelayMemoryCaptureTask[]; readonly error: string | null;
  readonly busy: string | null; readonly onRetry: (task: RelayMemoryCaptureTask) => void;
  readonly onCancel: (task: RelayMemoryCaptureTask) => void; readonly panelId: string;
  readonly onToggle: (open: boolean) => void;
}) {
  return <details className="memory-capture" aria-labelledby={panelId}
    onToggle={(event) => onToggle(event.currentTarget.open)}>
    <summary id={panelId}>自动捕获任务（最近 {tasks.length} 条）</summary>
    <div className="memory-capture-body">
      {error !== null && <p className="helper-text">捕获任务读取失败：{error}。这不代表没有待处理任务。</p>}
      {error === null && tasks.length === 0 && <p className="helper-text">暂无捕获任务记录。</p>}
      {tasks.length > 0 && <ul className="memory-capture-list">
        {tasks.map((task) => <li key={task.id}>
          <span className={`memory-capture-status memory-capture-status--${task.status.toLowerCase()}`}>
            {captureStatusLabels[task.status]}</span>
          <span>{task.kind === "EXPLICIT" ? "明确记住" : "自动捕获"} · 尝试 {task.attempts}/{task.maxAttempts}</span>
          <span className="helper-text">{formatDate(task.createdAt)}</span>
          {task.lastError !== null && <span className="helper-text">原因：{task.errorKind ?? "未知"} · {task.lastError}</span>}
          {(task.status === "FAILED") && <Button variant="secondary" disabled={busy !== null}
            onClick={() => onRetry(task)}>重试</Button>}
          {(task.status === "PENDING" || task.status === "FAILED") && <Button variant="secondary"
            disabled={busy !== null} onClick={() => onCancel(task)}>取消</Button>}
        </li>)}
      </ul>}
      <p className="helper-text">捕获任务持久化后才算“待捕获”；失败会按退避重试，不会因为一次辅助模型调用失败就假装记忆已保存。</p>
    </div>
  </details>;
}

function Stat({ label, value, hero = false, tone = "neutral" }: { readonly label: string;
  readonly value: number | string | undefined; readonly hero?: boolean;
  readonly tone?: "neutral" | "success" | "warning" }) {
  return <div className={`memory-stat${hero ? " memory-stat--hero" : ""}${tone === "warning" ? " memory-stat--warning" : tone === "success" ? " memory-stat--success" : ""}`}>
    <span>{label}</span>
    <strong>{value ?? "—"}</strong>
  </div>;
}

function Diag({ label, value }: { readonly label: string; readonly value: string | undefined }) {
  return <div className="memory-diag">
    <span>{label}</span><strong>{value ?? "—"}</strong>
  </div>;
}

function MemoryDetail({ memory, pageSort, revisions, busy, client, onEdit, onPin, onVerify, onRetire, onExpiry, onDelete }: {
  readonly memory: RelayMemory; readonly pageSort: SortFilter;
  readonly revisions: readonly RelayMemoryRevision[];
  readonly busy: string | null; readonly client: RelayApiClient;
  readonly onEdit: () => void; readonly onPin: () => void;
  readonly onVerify: (verification: RelayMemoryVerification) => void;
  readonly onRetire: () => void; readonly onExpiry: (expiresAt: string | null) => void;
  readonly onDelete: () => void;
}) {
  const canMutate = memory.status === "ACTIVE";
  return <>
    <header className="memory-detail-head">
      <div className="memory-detail-title">
        <p className="memory-detail-kicker">
          {typeLabels[memory.memoryType]} · {scopeLabels[memory.scope] ?? memory.scope}
          {memory.projectId !== null && <span> · 项目</span>}
        </p>
        <h2>{memory.title}</h2>
        <div className="memory-detail-badges">
          <span className="memory-status-label">验证：</span>
          <Badge tone={verificationTone(memory.verification)}
            icon={memory.verification === "VERIFIED" ? ShieldCheck : undefined}>
            {verificationLabels[memory.verification]}
          </Badge>
          <span className="memory-status-label">状态：</span>
          <Badge tone={effectiveTone(memory.effectiveStatus)}>{effectiveStatus(memory)}</Badge>
          {memory.pinned && <Badge tone="warning" icon={Pin}>已固定</Badge>}
          {memory.instructionRisk && <Badge tone="danger" icon={AlertTriangle}>含指令覆盖风险</Badge>}
        </div>
      </div>
      <div className="memory-detail-actions">
        <Button variant="secondary" disabled={busy !== null} onClick={onEdit} data-testid="memory-edit">编辑</Button>
        <Button variant="secondary" disabled={busy !== null} onClick={onPin}>
          <span aria-hidden="true">{memory.pinned ? <PinOff /> : <Pin />}</span>
          {memory.pinned ? "取消固定" : "固定"}
        </Button>
        {memory.status === "ACTIVE" && memory.effectiveStatus !== "SUPERSEDED" &&
          <Button variant="secondary" disabled={busy !== null} onClick={onRetire}>停用</Button>}
        {memory.status !== "ACTIVE" && memory.effectiveStatus !== "SUPERSEDED" &&
          <Button variant="secondary" disabled={busy !== null} onClick={onRetire}>恢复</Button>}
        <Button variant="danger" disabled={busy !== null} onClick={onDelete}><Trash2 aria-hidden="true" />删除</Button>
      </div>
    </header>

    {memory.effectiveStatus === "SUPERSEDED" && <p className="memory-warning" role="status">
      这条记忆已被替代。它以历史形式保留，不应继续作为现行事实注入；当前有效事实见下方替代关系。</p>}
    {memory.effectiveStatus === "STALE" && <p className="memory-warning" role="status">
      可能过时：使用前重新核对文件、命令或测试，不要直接当作当前事实。</p>}
    {memory.effectiveStatus === "EXPIRED" && <p className="memory-warning" role="status">
      已过期：默认不进入召回，可手动延长有效期或改为长期有效。</p>}
    {memory.verification === "FAILED" && <p className="memory-warning memory-warning--danger" role="status">
      明确失败的经验不会被注入上下文当作有效解决方法，只保留为历史教训。</p>}
    {memory.instructionRisk && <p className="memory-warning memory-warning--danger" role="status">
      正文包含指令覆盖或越权意图。验证状态只代表事实可信程度，不代表这条记忆可以改变系统指令或权限。</p>}

    <section className="memory-detail-section">
      <div className="memory-section-head"><h3>正文</h3></div>
      <article className="memory-body">{memory.text}</article>
    </section>

    <section className="memory-detail-section">
      <div className="memory-section-head"><h3>验证与置信度</h3>
        <span className="helper-text">验证状态与有效状态是两件事：验证说明事实可信程度，有效说明是否仍可被召回。</span>
      </div>
      <dl className="memory-facts">
        <Fact label="验证状态" value={verificationLabels[memory.verification]} />
        <Fact label="置信度" value={`${memory.confidence} / 100`} />
        <Fact label="来源" value={`${originLabels[memory.origin]} · ${sourceKindLabels[memory.sourceKind]}`} />
        <Fact label="来源未标注" value={memory.sourceKind === "UNKNOWN" ? "是（不能当作人工确认）" : "否"} />
        <Fact label="最近验证" value={formatDate(memory.verifiedAt)} />
        <Fact label="修订" value={`v${memory.currentVersion} · 根 r${memory.revision}`} />
      </dl>
      {canMutate && <div className="memory-detail-actions">
        {memory.verification !== "VERIFIED" &&
          <Button variant="secondary" disabled={busy !== null} onClick={() => onVerify("VERIFIED")}>标记已验证</Button>}
        {memory.verification !== "UNVERIFIED" &&
          <Button variant="secondary" disabled={busy !== null} onClick={() => onVerify("UNVERIFIED")}>改为未验证</Button>}
        {memory.verification !== "FAILED" &&
          <Button variant="secondary" disabled={busy !== null} onClick={() => onVerify("FAILED")}>标记失败</Button>}
      </div>}
    </section>

    <section className="memory-detail-section">
      <div className="memory-section-head"><h3>固定与生命周期</h3>
        <span className="helper-text">固定只提升召回优先级，不能绕过 Token 预算；停用保留历史，删除才真正移除。</span>
      </div>
      <dl className="memory-facts">
        <Fact label="固定" value={memory.pinned ? "已固定" : "未固定"} />
        <Fact label="有效期" value={memory.expiresAt === null ? "长期有效" : formatDate(memory.expiresAt)} />
        <Fact label="可能过时" value={formatDate(memory.staleAt)} />
        <Fact label="停用原因" value={memory.retiredReason ?? "—"} />
        <Fact label="最近更新" value={formatDate(memory.updatedAt)} />
        <Fact label="排序依据" value={pageSort === "updated" ? "最近更新" : pageSort === "created" ? "最近创建" : "重要性"} />
      </dl>
      <div className="memory-detail-actions">
        <Button variant="secondary" disabled={busy !== null}
          onClick={() => onExpiry(expiryAfterDays(30, memory.expiresAt))}>延长 30 天</Button>
        <Button variant="secondary" disabled={busy !== null}
          onClick={() => onExpiry(expiryAfterDays(365, memory.expiresAt))}>延长 1 年</Button>
        <Button variant="secondary" disabled={busy !== null || memory.expiresAt === null}
          onClick={() => onExpiry(null)}>改为长期</Button>
      </div>
    </section>

    <section className="memory-detail-section">
      <div className="memory-section-head"><h3>作用域与元数据</h3></div>
      <dl className="memory-facts">
        <Fact icon={Database} label="作用域" value={scopeLabels[memory.scope] ?? memory.scope} />
        <Fact label="所属项目" value={memory.projectId === null ? "工作空间级" : shortId(memory.projectId)} />
        <Fact label="任务" value={memory.taskId === null ? "—" : shortId(memory.taskId)} />
        <Fact label="结构化键" value={memory.memoryKey ?? "—"} />
        <Fact label="重要性" value={`${memory.importance} / 5`} />
        <Fact icon={Clock} label="创建" value={formatDate(memory.createdAt)} />
        <Fact label="最近访问" value={formatDate(memory.lastAccessedAt)} />
      </dl>
    </section>

    <section className="memory-detail-section">
      <div className="memory-section-head"><h3>来源证据</h3>
        <span className="helper-text">来源只记录保存那一刻的原始会话与消息；读取不到时如实显示缺失。</span>
      </div>
      <MemoryProvenancePanel client={client} memoryId={memory.id} />
    </section>

    <section className="memory-detail-section">
      <div className="memory-section-head"><h3>替代关系</h3></div>
      <dl className="memory-facts">
        <Fact label="替代了" value={memory.supersedesId === null ? "—" : shortId(memory.supersedesId)} />
        <Fact label="被替代为" value={memory.supersededById === null ? "—" : shortId(memory.supersededById)} />
      </dl>
      {memory.supersedesId === null && memory.supersededById === null &&
        <p className="helper-text">没有替代关系。同键新事实写入时，旧条目会保留历史并标记为已被替代。</p>}
    </section>

    <section className="memory-detail-section">
      <div className="memory-section-head"><h3>修订历史</h3></div>
      {revisions.length === 0 ? <p className="helper-text">没有可显示的历史修订，或历史仍在读取。</p>
        : <ul className="memory-history">{revisions.map((revision) => <li key={revision.id}>
          <span>v{revision.version}</span>
          <strong>{revision.title}</strong>
          <small>{formatDate(revision.createdAt)} · {revision.confirmedBy}</small>
        </li>)}</ul>}
    </section>
  </>;
}

function Fact({ icon: Icon, label, value }: { readonly icon?: typeof Database;
  readonly label: string; readonly value: string }) {
  return <div className="memory-fact">
    {Icon !== undefined && <Icon aria-hidden="true" />}
    <dt>{label}</dt><dd>{value}</dd>
  </div>;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
