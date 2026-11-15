import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangle, Brain, Clock, Database, Download, Pin, PinOff, Plus, RefreshCw,
  Search, ShieldCheck, Trash2, Upload, Wrench
} from "lucide-react";
import { MemoryProvenancePanel } from "../components/MessageMemorySources";
import {
  createCommandId, RelayTransportError, type RelayApiClient, type RelayMemory,
  type RelayMemoryEffectiveStatus, type RelayMemoryOrigin, type RelayMemoryRevision,
  type RelayMemoryStats, type RelayMemoryType, type RelayMemoryVerification
} from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import { Alert, Badge, Button, Dialog, EmptyState, FormField, Input, PageHeader, Select, Textarea } from "../ui";
import "./MemoryView.css";

/**
 * 记忆管理页（0164）。
 *
 * 这里是长期记忆的唯一管理入口：列表、筛选、详情、修订、固定、人工验证、删除、
 * 统计、整理与导入导出都走服务端命令，不在浏览器里维护第二份状态。
 * 短期任务状态与 Checkpoint 不在这里展示——它们属于 Assist 会话，不是长期知识。
 */

type EffectiveFilter = RelayMemoryEffectiveStatus | "ALL";
type TypeFilter = RelayMemoryType | "ALL";
type OriginFilter = RelayMemoryOrigin | "ALL";

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
const scopeLabels: Record<string, string> = {
  WORKSPACE: "工作空间", PROJECT: "项目", TASK: "任务", AGENT: "Agent",
};

function effectiveStatus(memory: RelayMemory): string {
  return memory.effectiveStatus === null ? "状态待核对" : effectiveLabels[memory.effectiveStatus];
}

function typeTone(type: RelayMemoryType): "neutral" | "success" | "warning" | "danger" {
  return type === "EXPERIENCE" ? "success" : type === "USER_PREFERENCE" ? "warning"
    : type === "PROJECT_FACT" ? "neutral" : "neutral";
}

function verificationTone(verification: RelayMemoryVerification): "neutral" | "success" | "warning" | "danger" {
  return verification === "VERIFIED" ? "success" : verification === "FAILED" ? "danger" : "warning";
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
  const [stats, setStats] = useState<RelayMemoryStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<readonly RelayMemoryRevision[]>([]);
  const [projects, setProjects] = useState<readonly { id: string; title: string }[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("ALL");
  const [statusFilter, setStatusFilter] = useState<EffectiveFilter>("ALL");
  const [originFilter, setOriginFilter] = useState<OriginFilter>("ALL");
  const [queryText, setQueryText] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<RelayMemory | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<{ readonly ids?: readonly string[];
    readonly label: string; readonly includeActive: boolean } | null>(null);
  const [purgeText, setPurgeText] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const requestVersion = useRef(0);
  const formId = useId();
  const searchId = useId();

  const selected = memories.find((memory) => memory.id === selectedId) ?? null;

  const load = useCallback(async (keepSelection = true) => {
    if (client === null) { setLoading(false); return; }
    const request = ++requestVersion.current;
    setLoading(true); setError(null); setStatsError(null);
    try {
      // 统计与列表互不阻塞：统计端点故障时仍允许管理已有记忆，不能用观测故障挡住管理。
      const [rowsResult, statsResult] = await Promise.allSettled([
        client.getMemories(projectId, statusFilter, {
          memoryType: typeFilter, origin: originFilter,
          ...(appliedQuery === "" ? {} : { query: appliedQuery }), limit: 200,
        }),
        client.getMemoryStats(projectId),
      ]);
      if (request !== requestVersion.current) return;
      if (rowsResult.status === 'rejected') throw rowsResult.reason;
      const rows = rowsResult.value;
      if (statsResult.status === 'fulfilled') setStats(statsResult.value);
      else {
        setStats(null);
        setStatsError(describeLiveError(statsResult.reason).message);
      }
      setMemories(rows);
      setSelectedId((current) => keepSelection && current !== null &&
        rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null);
    } catch (caught) {
      if (request !== requestVersion.current) return;
      setError(describeLiveError(caught).message);
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }, [client, projectId, statusFilter, typeFilter, originFilter, appliedQuery]);

  useEffect(() => { void load(); }, [load]);

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
    await load();
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
      await load();
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
        setNotice("已保存为新修订；旧版本仍可在历史中查看。");
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
        setNotice("已停用；停用项不再进入召回。");
      } else {
        await client!.reactivateMemory(memory.id, createCommandId(), memory.revision);
        setNotice("已恢复为有效；是否进入召回仍按有效期与作用域判断。");
      }
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
      setNotice("已导出当前范围的可导出记忆（正文与元数据，不含会话/消息凭据）。");
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

  const filtersActive = typeFilter !== "ALL" || statusFilter !== "ALL" || originFilter !== "ALL" ||
    appliedQuery !== "" || projectId !== null;

  return <div className="memory-page">
    <PageHeader title="记忆" overline="长期知识"
      lede="用户偏好、项目事实、已验证经验与历史事件。召回内容只是参考数据，不替代任务状态、验收结论或权限。"
      status={<Badge tone={live ? "success" : "warning"}>{live ? "实时数据" : "非实时连接"}</Badge>}
      actions={<>
        <Button variant="secondary" disabled={busy !== null || loading} onClick={() => void load()}>
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
      <Button variant="secondary" onClick={() => void load()}>重新读取</Button>
    </Alert>}
    {notice !== null && <p className="memory-notice" role="status" data-testid="memory-notice">{notice}</p>}

    {statsError !== null && <p className="helper-text memory-stats-error" role="status">
      统计暂不可用：{statsError}；记忆列表仍可查看和管理。</p>}
    <section className="memory-stats" aria-label="记忆统计">
      <Stat label="总数" value={stats?.total} />
      <Stat label="有效" value={stats?.active} />
      <Stat label="固定" value={stats?.pinned} />
      <Stat label="可能过时" value={stats?.stale} tone="warning" />
      <Stat label="存储" value={stats === null ? undefined : formatBytes(stats.storageBytes)} />
      <Stat label="24h 召回" value={stats?.recall.last24h} />
      <Stat label="平均检索耗时" value={stats === null ? undefined : `${stats.recall.avgLatencyMs} ms`} />
      <Stat label="索引待回填" value={stats?.indexHealth.unindexed} tone={stats?.indexHealth.unindexed ? "warning" : "neutral"} />
    </section>

    <div className="memory-columns">
      <section className="memory-list-panel" aria-label="记忆列表">
        <div className="memory-filters">
          <FormField label="搜索" htmlFor={searchId} layout="row">
            <div className="memory-search-row">
              <Input id={searchId} value={queryText} placeholder="标题、正文、键或来源标识"
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
            <FormField label="状态">
              <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as EffectiveFilter)}>
                <option value="ALL">全部状态</option>
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
            <FormField label="项目">
              <Select value={projectId ?? ""} onChange={(event) =>
                setProjectId(event.target.value === "" ? null : event.target.value)}>
                <option value="">全部工作空间</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
              </Select>
            </FormField>
          </div>
          {filtersActive && <p className="helper-text">当前为筛选结果；清除筛选后恢复全部记忆。</p>}
        </div>

        {loading && memories.length === 0 && <p className="loading-text" role="status">正在读取记忆…</p>}
        {!loading && memories.length === 0 && <EmptyState title={filtersActive ? "没有匹配的记忆" : "还没有长期记忆"}
          description={filtersActive ? "调整类型、状态、来源或搜索词后再试。"
            : "对话里明确要求记住的内容、经过验证的经验，或在这里手动新建的记忆会出现在这里。"} />}
        {memories.length > 0 && <ul className="memory-rows">
          {memories.map((memory) => <li key={memory.id}>
            <button type="button" className={`memory-row${memory.id === selectedId ? " memory-row--active" : ""}`}
              aria-current={memory.id === selectedId ? "true" : undefined} onClick={() => setSelectedId(memory.id)}>
              <span className="memory-row-icon"><Brain aria-hidden="true" /></span>
              <span className="memory-row-main">
                <strong>{memory.title}{memory.pinned && <Pin className="memory-pin" aria-label="已固定" />}</strong>
                <span className="memory-row-snippet">{snippet(memory.text)}</span>
                <span className="memory-row-meta">
                  <Badge tone={typeTone(memory.memoryType)}>{typeLabels[memory.memoryType]}</Badge>
                  <span>{memory.projectId === null ? "工作空间" : "项目"}</span>
                  <span>{scopeLabels[memory.scope] ?? memory.scope}</span>
                  <span>{effectiveStatus(memory)}</span>
                  <span>{formatDate(memory.updatedAt)}</span>
                </span>
              </span>
            </button>
          </li>)}
        </ul>}
      </section>

      <section className="memory-detail" aria-label="记忆详情">
        {selected === null ? <EmptyState title="选择一条记忆" description="左侧列表中的条目可以查看正文、来源、修订与替代关系。" />
          : <MemoryDetail memory={selected} revisions={revisions} busy={busy} client={client}
            onEdit={() => openEdit(selected)} onPin={() => void pin(selected)}
            onVerify={(verification) => void verify(selected, verification)}
            onRetire={() => void toggleRetired(selected)}
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
          <Textarea id={`${formId}-text`} rows={8} value={draft.text}
            onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
        </FormField>
        {formError !== null && <p className="field-error" role="alert">{formError}</p>}
        <div className="memory-form-actions">
          <Button variant="secondary" onClick={() => { setDraft(null); setEditing(null); }}>取消</Button>
          <Button variant="primary" disabled={busy !== null} onClick={() => void saveDraft()}>
            {busy === "create" || busy === "edit" ? "正在保存" : editing === null ? "创建" : "保存修订"}
          </Button>
        </div>
      </div>}
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

function Stat({ label, value, tone = "neutral" }: { readonly label: string;
  readonly value: number | string | undefined; readonly tone?: "neutral" | "warning" }) {
  return <div className={`memory-stat${tone === "warning" ? " memory-stat--warning" : ""}`}>
    <span>{label}</span>
    <strong>{value ?? "—"}</strong>
  </div>;
}

function MemoryDetail({ memory, revisions, busy, client, onEdit, onPin, onVerify, onRetire, onDelete }: {
  readonly memory: RelayMemory; readonly revisions: readonly RelayMemoryRevision[];
  readonly busy: string | null; readonly client: RelayApiClient;
  readonly onEdit: () => void; readonly onPin: () => void;
  readonly onVerify: (verification: RelayMemoryVerification) => void;
  readonly onRetire: () => void; readonly onDelete: () => void;
}) {
  return <>
    <div className="memory-detail-head">
      <div>
        <h2>{memory.title}</h2>
        <p className="memory-detail-badges">
          <Badge tone={typeTone(memory.memoryType)}>{typeLabels[memory.memoryType]}</Badge>
          <Badge tone={verificationTone(memory.verification)} icon={memory.verification === "VERIFIED" ? ShieldCheck : undefined}>
            {verificationLabels[memory.verification]}
          </Badge>
          <Badge tone={memory.effectiveStatus === "ACTIVE" ? "success" : memory.effectiveStatus === "STALE" ? "warning" : "neutral"}>
            {effectiveStatus(memory)}
          </Badge>
          {memory.pinned && <Badge tone="warning" icon={Pin}>已固定</Badge>}
          {memory.origin === "AUTO_CAPTURE" && <Badge tone="neutral">自动记住</Badge>}
        </p>
      </div>
      <div className="memory-detail-actions">
        <Button variant="secondary" onClick={onEdit}>编辑</Button>
        <Button variant="secondary" onClick={onPin}><span aria-hidden="true">{memory.pinned ? <PinOff /> : <Pin />}</span>
          {memory.pinned ? "取消固定" : "固定"}</Button>
        {memory.status === "ACTIVE" && memory.verification !== "VERIFIED" &&
          <Button variant="secondary" onClick={() => onVerify("VERIFIED")}>标记已验证</Button>}
        {memory.status === "ACTIVE" && memory.verification !== "UNVERIFIED" &&
          <Button variant="secondary" onClick={() => onVerify("UNVERIFIED")}>改为未验证</Button>}
        {memory.memoryType === "EXPERIENCE" && memory.verification !== "FAILED" &&
          <Button variant="secondary" onClick={() => onVerify("FAILED")}>标记失败</Button>}
        <Button variant="secondary" onClick={onRetire}>{memory.status === "ACTIVE" ? "停用" : "恢复"}</Button>
        <Button variant="danger" disabled={busy !== null} onClick={onDelete}><Trash2 aria-hidden="true" />删除</Button>
      </div>
    </div>

    <dl className="memory-meta">
      <Meta icon={Database} label="作用域" value={`${scopeLabels[memory.scope] ?? memory.scope}${memory.projectId === null ? "" : " · 项目"}`} />
      <Meta icon={Clock} label="重要性" value={`${memory.importance} / 5`} />
      <Meta icon={ShieldCheck} label="置信度" value={`${memory.confidence} / 100`} />
      <Meta label="来源" value={`${originLabels[memory.origin]} · ${memory.sourceKind === "USER_STATEMENT" ? "用户原话"
        : memory.sourceKind === "MODEL_OBSERVATION" ? "模型观察" : memory.sourceKind === "MANUAL" ? "人工保存" : "来源未标注"}`} />
      <Meta label="结构化键" value={memory.memoryKey ?? "—"} />
      <Meta label="修订" value={`v${memory.currentVersion} · 根 r${memory.revision}`} />
      <Meta label="创建 / 更新" value={`${formatDate(memory.createdAt)} / ${formatDate(memory.updatedAt)}`} />
      <Meta label="最近验证" value={formatDate(memory.verifiedAt)} />
      <Meta label="最近访问" value={formatDate(memory.lastAccessedAt)} />
      <Meta label="有效期" value={memory.expiresAt === null ? "长期（可手动停用）" : formatDate(memory.expiresAt)} />
      {memory.staleAt !== null && <Meta icon={AlertTriangle} label="可能过时" value={formatDate(memory.staleAt)} />}
      {memory.supersedesId !== null && <Meta label="替代了" value={memory.supersedesId} />}
      {memory.supersededById !== null && <Meta label="被替代为" value={memory.supersededById} />}
      {memory.retiredReason !== null && <Meta label="停用原因" value={memory.retiredReason} />}
    </dl>

    {memory.effectiveStatus === "SUPERSEDED" && <Alert tone="warning" title="这条记忆已被替代">
      <p>它以历史形式保留，不应继续作为现行规则注入。当前有效事实请查看替代它的条目。</p>
    </Alert>}
    {memory.effectiveStatus === "STALE" && <Alert tone="warning" title="可能过时">
      <p>项目事实与经验会随时间被标记为可能过时；使用前应重新核对文件、命令或测试，而不是直接当作当前事实。</p>
    </Alert>}
    {memory.verification === "FAILED" && <Alert tone="danger" title="明确失败的经验">
      <p>该经验不会被注入上下文当作有效解决方法；它只保留为历史教训。</p>
    </Alert>}

    <article className="memory-body">{memory.text}</article>

    <MemoryProvenancePanel client={client} memoryId={memory.id} />

    <section className="memory-history" aria-label="修订历史">
      <h3>修订历史</h3>
      {revisions.length === 0 ? <p className="helper-text">没有可显示的历史修订，或历史仍在读取。</p>
        : <ul>{revisions.map((revision) => <li key={revision.id}>
          <span>v{revision.version}</span>
          <strong>{revision.title}</strong>
          <small>{formatDate(revision.createdAt)} · {revision.confirmedBy}</small>
        </li>)}</ul>}
    </section>
  </>;
}

function Meta({ icon: Icon, label, value }: { readonly icon?: typeof Database;
  readonly label: string; readonly value: string }) {
  return <div className="memory-meta-item">
    {Icon !== undefined && <Icon aria-hidden="true" />}
    <dt>{label}</dt><dd>{value}</dd>
  </div>;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
