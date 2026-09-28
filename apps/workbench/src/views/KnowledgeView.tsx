import { useEffect, useRef, useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import ProjectNav from "../components/ProjectNav";
import KnowledgeReader from "../components/KnowledgeReader";
import ProjectKnowledgeGuide from "../components/ProjectKnowledgeGuide";
import WebImportPanel from "../components/WebImportPanel";
import {
  createCommandId, RelayApiError, RelayTransportError,
  type RelayApiClient, type RelayCommandEnvelope, type RelayDecision,
  type RelayInformationKind, type RelayKnowledge, type RelayKnowledgeSource, type RelayKnowledgeVersion,
  type RelayMemory, type RelayMemoryRevision, type RelayRule, type RelayRuleEnforcement,
  type RelayRuleStrength, type RelayRuleVersion, type RelaySearchItem
} from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import "./KnowledgeView.css";

type InformationRow = RelayKnowledge | RelayMemory | RelayDecision | RelayRule;
type Scope = "WORKSPACE" | "PROJECT" | "TASK";
type WriteTarget = { readonly kind: "PROJECT" | "TASK"; readonly id: string; readonly expectedProjectId?: string | null };
interface PendingCommand {
  readonly id: string;
  readonly commandType: string;
  readonly resultKey: string;
  readonly targetId: string | null;
  readonly replacementId: string | null;
}

const kinds: readonly { kind: RelayInformationKind; label: string }[] = [
  { kind: "KNOWLEDGE", label: "Knowledge 资料" },
  { kind: "MEMORY", label: "Memory 记忆" },
  { kind: "DECISION", label: "Decision 决定" },
  { kind: "RULE", label: "Rule 规则" }
];

function rowTitle(row: InformationRow): string {
  return "title" in row ? row.title : row.ruleKey;
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function validResult(result: Readonly<Record<string, unknown>>, pending: PendingCommand): string | null {
  const id = result[pending.resultKey];
  if (typeof id !== "string" || id.length === 0 ||
    (pending.targetId !== null && id !== pending.targetId) ||
    typeof result.revision !== "string" || !/^\d+$/u.test(result.revision) ||
    typeof result.status !== "string") return null;
  if (pending.replacementId !== null && result.replacement_decision_id !== pending.replacementId) return null;
  if (["CreateKnowledge", "AddKnowledgeVersion", "CreateMemory", "AddMemoryRevision", "CreateDecision", "CreateRule", "AddRuleVersion"].includes(pending.commandType) &&
    (typeof result.version !== "string" || !/^\d+$/u.test(result.version))) return null;
  return id;
}

export default function KnowledgeView() {
  const { id } = useParams();
  const [routeQuery, setRouteQuery] = useSearchParams();
  const routeKindValue = routeQuery.get("kind");
  const routeKind: RelayInformationKind = kinds.some((item) => item.kind === routeKindValue) ? routeKindValue as RelayInformationKind : "KNOWLEDGE";
  const routeItem = routeQuery.get("item");
  const routeVersion = routeQuery.get("version");
  const routeSearch = routeQuery.get("q") ?? "";
  const projectId = id ?? null;
  const connection = useRelayConnection();
  const client = connection.client;
  const live = connection.mode === "live";
  const [kind, setKind] = useState<RelayInformationKind>(routeKind);
  const [rows, setRows] = useState<readonly InformationRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(routeItem);
  const [selected, setSelected] = useState<InformationRow | null>(null);
  const [knowledgeVersions, setKnowledgeVersions] = useState<readonly RelayKnowledgeVersion[]>([]);
  const [memoryRevisions, setMemoryRevisions] = useState<readonly RelayMemoryRevision[]>([]);
  const [ruleVersions, setRuleVersions] = useState<readonly RelayRuleVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<PendingCommand | null>(null);
  const pendingRef = useRef<PendingCommand | null>(null);
  const readVersion = useRef(0);
  const contextVersion = useRef(0);
  const previewReadVersion = useRef(0);
  const [writeGate, setWriteGate] = useState<{ key: string; reason: string | null } | null>(null);
  const [gateReload, setGateReload] = useState(0);

  const [query, setQuery] = useState(routeSearch);
  const [searchItems, setSearchItems] = useState<readonly RelaySearchItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchVersion = useRef(0);

  const [formOpen, setFormOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [revisionMode, setRevisionMode] = useState(false);
  const [knowledgeDraftBase, setKnowledgeDraftBase] = useState<{ id: string; revision: string; projectId: string | null } | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [sourceKind, setSourceKind] = useState<Exclude<RelayKnowledgeSource, "WEB_PAGE">>("NOTE");
  const [artifactVersionId, setArtifactVersionId] = useState("");
  const [artifactPreview, setArtifactPreview] = useState<{ id: string; text: string } | null>(null);
  const [artifactPreviewError, setArtifactPreviewError] = useState<string | null>(null);
  const [captureConfirmed, setCaptureConfirmed] = useState(false);
  const [mediaType, setMediaType] = useState("text/plain");
  const [confirmed, setConfirmed] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");
  const [choice, setChoice] = useState("");
  const [rationale, setRationale] = useState("");
  const [alternatives, setAlternatives] = useState("");
  const [costs, setCosts] = useState("");
  const [replacementId, setReplacementId] = useState("");
  const [scope, setScope] = useState<Scope>(projectId === null ? "WORKSPACE" : "PROJECT");
  const [scopeId, setScopeId] = useState("");
  const [ruleKey, setRuleKey] = useState("");
  const [statement, setStatement] = useState("");
  const [strength, setStrength] = useState<RelayRuleStrength>("PREFERENCE");
  const [enforcement, setEnforcement] = useState<RelayRuleEnforcement>("HUMAN");
  const [method, setMethod] = useState("");
  const [targetSpec, setTargetSpec] = useState("");

  const selectedKnowledge = kind === "KNOWLEDGE" ? selected as RelayKnowledge | null : null;
  const selectedMemory = kind === "MEMORY" ? selected as RelayMemory | null : null;
  const selectedDecision = kind === "DECISION" ? selected as RelayDecision | null : null;
  const selectedRule = kind === "RULE" ? selected as RelayRule | null : null;

  function rowTarget(row: InformationRow): WriteTarget | null {
    if ("scope" in row) {
      if (row.scope === "TASK") return { kind: "TASK", id: row.scopeId, expectedProjectId: row.projectId };
      if (row.scope === "PROJECT") return { kind: "PROJECT", id: row.scopeId };
      return null;
    }
    return row.projectId ? { kind: "PROJECT", id: row.projectId } : null;
  }
  function newTarget(): WriteTarget | null {
    if (kind !== "RULE") return projectId ? { kind: "PROJECT", id: projectId } : null;
    if (scope === "TASK") return scopeId.trim() ? { kind: "TASK", id: scopeId.trim() } : null;
    if (scope === "PROJECT") return { kind: "PROJECT", id: projectId ?? scopeId.trim() };
    return null;
  }
  const activeWriteTarget = formOpen ? revisionMode && selected ? rowTarget(selected) : newTarget()
    : selected ? rowTarget(selected) : projectId ? { kind: "PROJECT" as const, id: projectId } : null;
  const writeTargetKey = activeWriteTarget ? `${activeWriteTarget.kind}:${activeWriteTarget.id}:${activeWriteTarget.expectedProjectId ?? ""}` : null;
  const writeBlockedReason = writeTargetKey === null ? null : writeGate?.key === writeTargetKey
    ? writeGate.reason : "正在核对关联 Project，不能提交新的资料命令。";

  async function confirmWritable(api: RelayApiClient, target: WriteTarget | null): Promise<void> {
    if (!target) return;
    let targetProjectId = target.id;
    if (target.kind === "TASK") {
      const task = await api.getTask(target.id);
      if (task.id !== target.id || (target.expectedProjectId !== undefined && task.projectId !== target.expectedProjectId))
        throw new Error("Task 与当前 Rule 的项目归属不匹配。");
      if (task.projectId === null) return;
      targetProjectId = task.projectId;
    }
    const project = await api.getProject(targetProjectId);
    if (project.id !== targetProjectId) throw new Error("Project 读取结果与命令目标不匹配。");
    if (project.archivedAt !== null) throw new Error("关联项目已归档，不能提交新的资料命令。");
  }
  useEffect(() => {
    if (!client || !writeTargetKey || !activeWriteTarget) { setWriteGate(null); return; }
    let active = true;
    const target = activeWriteTarget;
    setWriteGate({ key: writeTargetKey, reason: "正在核对关联 Project，不能提交新的资料命令。" });
    void confirmWritable(client, target).then(() => {
      if (active) setWriteGate({ key: writeTargetKey, reason: null });
    }).catch((caught: unknown) => {
      if (active) setWriteGate({ key: writeTargetKey, reason: `关联 Project 无法确认可写：${describeLiveError(caught).message}` });
    });
    return () => { active = false; };
  }, [client, writeTargetKey, gateReload]);

  function clearDraft() {
    previewReadVersion.current++;
    setKnowledgeDraftBase(null);
    setTitle(""); setText(""); setSourceKind("NOTE"); setArtifactVersionId("");
    setArtifactPreview(null); setArtifactPreviewError(null); setCaptureConfirmed(false);
    setMediaType("text/plain"); setConfirmed(false); setExpiresAt("");
    setChoice(""); setRationale(""); setAlternatives(""); setCosts("");
    setReplacementId(""); setScope(projectId === null ? "WORKSPACE" : "PROJECT");
    setScopeId(""); setRuleKey(""); setStatement(""); setStrength("PREFERENCE");
    setEnforcement("HUMAN"); setMethod(""); setTargetSpec("");
  }

  async function load(nextKind = kind, nextId = selectedId, activeClient = client, activeProject = projectId): Promise<void> {
    const version = ++readVersion.current;
    if (nextId === null) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      if (!live) {
        setRows([]); setSelected(null);
        return;
      }
      if (activeClient === null) throw new Error("本机 API 连接已失效，请重新连接。");
      const list = nextKind === "KNOWLEDGE" ? await activeClient.getKnowledge(activeProject)
        : nextKind === "MEMORY" ? await activeClient.getMemories(activeProject)
          : nextKind === "DECISION" ? await activeClient.getDecisions(activeProject)
            : await activeClient.getRules(activeProject);
      const detailId = nextId ?? list[0]?.id ?? null;
      let detail: InformationRow | null = null;
      let versions: readonly RelayKnowledgeVersion[] = [];
      let revisions: readonly RelayMemoryRevision[] = [];
      let rules: readonly RelayRuleVersion[] = [];
      if (detailId !== null) {
        if (nextKind === "KNOWLEDGE") {
          [detail, versions] = await Promise.all([activeClient.getKnowledgeDetail(detailId), activeClient.getKnowledgeVersions(detailId)]);
        } else if (nextKind === "MEMORY") {
          [detail, revisions] = await Promise.all([activeClient.getMemory(detailId), activeClient.getMemoryRevisions(detailId)]);
        } else if (nextKind === "DECISION") {
          detail = await activeClient.getDecision(detailId);
        } else {
          [detail, rules] = await Promise.all([activeClient.getRule(detailId), activeClient.getRuleVersions(detailId)]);
        }
      }
      if (version !== readVersion.current) return;
      setRows(list); setSelectedId(detailId); setSelected(detail);
      setKnowledgeVersions(versions); setMemoryRevisions(revisions); setRuleVersions(rules);
    } catch (caught) {
      if (version === readVersion.current) {
        setRows([]); setSelected(null); setKnowledgeVersions([]); setMemoryRevisions([]); setRuleVersions([]);
        setError(describeLiveError(caught).message);
      }
    } finally {
      if (version === readVersion.current) { setLoading(false); setRefreshing(false); }
    }
  }

  useEffect(() => {
    contextVersion.current++;
    readVersion.current++;
    pendingRef.current = null;
    setPendingCommand(null); setSubmitting(false); setKind(routeKind); setSelectedId(routeItem); setSelected(null); setRows([]);
    setActionError(null); setActionMessage(null); setFormOpen(false);
    setGuideOpen(false);
    setQuery(routeSearch);
    clearDraft();
    void load(routeKind, routeItem, client, projectId);
    return () => { contextVersion.current++; readVersion.current++; };
  }, [client, connection.mode, projectId, routeKind, routeItem, routeSearch]);

  async function runSearch(version: number, searchQuery: string, cursor?: string) {
    if (client === null || !live) return;
    setSearching(true);
    try {
      const page = await client.searchInformation({
        q: searchQuery, projectId, types: ["KNOWLEDGE", "MEMORY", "DECISION", "RULE"], limit: 20, cursor
      });
      if (version !== searchVersion.current) return;
      setSearchItems((current) => cursor === undefined ? page.items : [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (version === searchVersion.current) { setSearchItems([]); setNextCursor(null); setSearchError(describeLiveError(caught).message); }
    } finally {
      if (version === searchVersion.current) setSearching(false);
    }
  }

  useEffect(() => {
    const version = ++searchVersion.current;
    setSearchItems([]); setNextCursor(null); setSearchError(null);
    const trimmed = query.trim();
    if (!live || trimmed === "") { setSearching(false); return; }
    if (trimmed.length > 200) { setSearchError("搜索词不能超过 200 个字符。"); setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(() => { void runSearch(version, trimmed); }, 250);
    return () => { clearTimeout(timer); searchVersion.current++; };
  }, [query, client, connection.mode, projectId]);

  function switchKind(next: RelayInformationKind) {
    if (pendingRef.current !== null || kind === next) return;
    setKind(next); setSelectedId(null); setSelected(null); setRows([]); setFormOpen(false);
    setActionError(null); setActionMessage(null); clearDraft();
    void load(next, null);
  }

  function selectRow(idToSelect: string) {
    if (pendingRef.current !== null) return;
    setSelectedId(idToSelect); setFormOpen(false); setActionError(null);
    void load(kind, idToSelect);
  }

  function openSearchItem(item: RelaySearchItem) {
    if (pendingRef.current !== null) return;
    if (item.type === "KNOWLEDGE") {
      setRouteQuery((current) => {
        const next = new URLSearchParams(current);
        next.set("kind", "KNOWLEDGE"); next.set("item", item.id); next.set("version", item.version);
        return next;
      });
      return;
    }
    setKind(item.type); setSelected(null); setRows([]); setFormOpen(false); clearDraft();
    setSelectedId(item.id);
    void load(item.type, item.id);
  }

  function openForm(asRevision: boolean) {
    if (pendingRef.current !== null) return;
    clearDraft(); setRevisionMode(asRevision); setFormOpen(true); setActionError(null);
    if (asRevision && kind === "KNOWLEDGE" && selectedKnowledge !== null)
      setKnowledgeDraftBase({ id: selectedKnowledge.id, revision: selectedKnowledge.revision,
        projectId: selectedKnowledge.projectId });
    if (asRevision && selectedMemory !== null) { setTitle(selectedMemory.title); setText(selectedMemory.text); }
    if (asRevision && selectedRule !== null) {
      setRuleKey(selectedRule.ruleKey); setStatement(selectedRule.statement);
      setStrength(selectedRule.strength); setEnforcement(selectedRule.enforcement);
      setMethod(selectedRule.method ?? ""); setTargetSpec(JSON.stringify(selectedRule.targetSpec, null, 2));
    }
  }

  async function readArtifactPreview() {
    const sourceId = artifactVersionId.trim();
    if (client === null || !/^[0-9a-f-]{36}$/iu.test(sourceId)) {
      setArtifactPreviewError("请填写有效的产物版本 ID。"); return;
    }
    setArtifactPreview(null); setArtifactPreviewError(null); setCaptureConfirmed(false);
    const readVersion = ++previewReadVersion.current;
    const context = contextVersion.current;
    try {
      const body = await client.getArtifactVersionContent(sourceId);
      if (readVersion === previewReadVersion.current && context === contextVersion.current)
        setArtifactPreview({ id: sourceId, text: body });
    } catch (caught) {
      if (readVersion === previewReadVersion.current && context === contextVersion.current)
        setArtifactPreviewError(describeLiveError(caught).message);
    }
  }

  async function submit(
    commandType: string, resultKey: string, targetId: string | null,
    send: (api: RelayApiClient, commandId: string) => Promise<RelayCommandEnvelope>,
    replacement: string | null = null
  ) {
    if (client === null || submitting || pendingRef.current !== null) return;
    const target = targetId !== null
      ? selected?.id === targetId ? rowTarget(selected) : undefined
      : commandType === "CreateRule" ? newTarget() : projectId ? { kind: "PROJECT" as const, id: projectId } : null;
    if (target === undefined) { setActionError("资料目标已变化，请重新读取后再提交。"); return; }
    const command: PendingCommand = { id: createCommandId(), commandType, resultKey, targetId, replacementId: replacement };
    const context = contextVersion.current;
    pendingRef.current = command; setPendingCommand(command); setSubmitting(true);
    setActionError(null); setActionMessage(null);
    let sent = false;
    try {
      await confirmWritable(client, target);
      if (context !== contextVersion.current) return;
      sent = true;
      const envelope = await send(client, command.id);
      if (context !== contextVersion.current) return;
      const resultId = envelope.commandId === command.id ? validResult(envelope.result, command) : null;
      if (resultId === null) throw new RelayTransportError("命令回执无法核对。");
      pendingRef.current = null; setPendingCommand(null); setSelectedId(resultId);
      setActionMessage("命令已提交；正在读取服务端最新资料。"); setFormOpen(false);
      await load(kind, resultId);
    } catch (caught) {
      if (context !== contextVersion.current) return;
      if (!sent) {
        pendingRef.current = null; setPendingCommand(null);
        setActionError(`关联 Project 状态未确认，命令尚未提交：${describeLiveError(caught).message}`);
        setGateReload((value) => value + 1);
      } else if (caught instanceof RelayTransportError) {
        setActionError("响应丢失或无法核对。请只查询原 command_id 回执，不要换 ID 再提交。");
      } else {
        pendingRef.current = null; setPendingCommand(null);
        setActionError(describeLiveError(caught).message);
      }
    } finally {
      if (context === contextVersion.current) setSubmitting(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const itemId = selected?.id ?? null;
    const revision = selected?.revision;
    const titleValue = title.trim();
    const textValue = text.trim();
    setActionError(null);
    if (kind === "KNOWLEDGE") {
      if ((!revisionMode && !titleValue) || (sourceKind === "ARTIFACT_VERSION" ? !artifactVersionId.trim() : !textValue)) {
        setActionError("请填写标题及当前来源所需的正文或产物版本 ID。"); return;
      }
      if (sourceKind === "ARTIFACT_VERSION" &&
          (artifactPreview?.id !== artifactVersionId.trim() || !captureConfirmed)) {
        setActionError("请先读取确切产物版本并确认内容、来源和目标范围。"); return;
      }
      const source = sourceKind === "ARTIFACT_VERSION"
        ? { artifactVersionId: artifactVersionId.trim() }
        : { text: textValue, mediaType: mediaType.trim() || "text/plain" };
      if (revisionMode && knowledgeDraftBase === null) {
        setActionError("修订目标已失效，请保留草稿并重新打开目标版本。"); return;
      }
      if (revisionMode && knowledgeDraftBase !== null) {
        await submit("AddKnowledgeVersion", "knowledge_id", knowledgeDraftBase.id, (api, commandId) =>
          api.addKnowledgeVersion({ id: knowledgeDraftBase.id, commandId,
            expectedRevision: knowledgeDraftBase.revision, sourceKind, ...source }));
      } else {
        await submit("CreateKnowledge", "knowledge_id", null, (api, commandId) =>
          api.createKnowledge({ commandId, projectId, title: titleValue, sourceKind, ...source }));
      }
    } else if (kind === "MEMORY") {
      if (!titleValue || !textValue) { setActionError("请填写记忆标题与内容。"); return; }
      if (!confirmed) { setActionError("只有明确确认后才能保存 Memory。"); return; }
      const expiry = expiresAt.trim() || null;
      if (expiry !== null && Number.isNaN(Date.parse(expiry))) { setActionError("到期时间须为有效日期时间。"); return; }
      const expires = expiry === null ? null : new Date(expiry).toISOString();
      if (revisionMode && itemId !== null && revision !== undefined) {
        await submit("AddMemoryRevision", "memory_id", itemId, (api, commandId) =>
          api.addMemoryRevision({ id: itemId, commandId, expectedRevision: revision, title: titleValue,
            text: textValue, confirmed: true, expiresAt: expires }));
      } else {
        await submit("CreateMemory", "memory_id", null, (api, commandId) =>
          api.createMemory({ commandId, projectId, title: titleValue, text: textValue, confirmed: true, expiresAt: expires }));
      }
    } else if (kind === "DECISION") {
      if (!titleValue || !choice.trim() || !rationale.trim()) { setActionError("请填写决定标题、选择和依据。"); return; }
      await submit("CreateDecision", "decision_id", null, (api, commandId) =>
        api.createDecision({ commandId, projectId, title: titleValue, choice: choice.trim(),
          rationale: rationale.trim(), alternatives: splitLines(alternatives), costs: splitLines(costs) }));
    } else {
      if (!ruleKey.trim() || !statement.trim()) { setActionError("请填写规则键与陈述。"); return; }
      let spec: Record<string, unknown> | undefined;
      if (targetSpec.trim()) {
        try {
          const parsed: unknown = JSON.parse(targetSpec);
          if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
          spec = parsed as Record<string, unknown>;
        } catch { setActionError("目标约束须是 JSON 对象。"); return; }
      }
      const config = { ruleKey: ruleKey.trim(), statement: statement.trim(), strength, enforcement,
        ...(method.trim() ? { method: method.trim() } : {}), ...(spec === undefined ? {} : { targetSpec: spec }) };
      if (revisionMode && itemId !== null && revision !== undefined) {
        await submit("AddRuleVersion", "rule_id", itemId, (api, commandId) =>
          api.addRuleVersion({ id: itemId, commandId, expectedRevision: revision, ...config }));
      } else {
        if (client === null) return;
        const resolvedScopeId = scope === "WORKSPACE" ? client.workspaceId
          : scope === "PROJECT" && projectId !== null ? projectId : scopeId.trim();
        if (!resolvedScopeId) { setActionError("请填写规则作用域 ID。"); return; }
        await submit("CreateRule", "rule_id", null, (api, commandId) =>
          api.createRule({ commandId, scope, scopeId: resolvedScopeId, ...config }));
      }
    }
  }

  async function retire() {
    if (selected === null) return;
    const item = selected;
    if (kind === "KNOWLEDGE") {
      await submit("ArchiveKnowledge", "knowledge_id", item.id, (api, commandId) => api.archiveKnowledge(item.id, commandId, item.revision));
    } else if (kind === "MEMORY") {
      await submit("RetireMemory", "memory_id", item.id, (api, commandId) => api.retireMemory(item.id, commandId, item.revision));
    } else if (kind === "RULE") {
      await submit("RetireRule", "rule_id", item.id, (api, commandId) => api.retireRule(item.id, commandId, item.revision));
    }
  }

  async function supersede() {
    const item = selectedDecision;
    const replacement = replacementId.trim();
    if (item === null || replacement === "" || replacement === item.id) {
      setActionError("请填写另一个已有 Decision 的 ID。"); return;
    }
    await submit("SupersedeDecision", "decision_id", item.id, (api, commandId) =>
      api.supersedeDecision({ id: item.id, commandId, expectedRevision: item.revision,
        replacementDecisionId: replacement }), replacement);
  }

  async function checkReceipt() {
    const pending = pendingRef.current;
    if (pending === null || client === null || submitting) return;
    const context = contextVersion.current;
    setSubmitting(true);
    try {
      const receipt = await client.getCommandReceipt(pending.id);
      if (context !== contextVersion.current) return;
      const resultId = receipt.commandId === pending.id && receipt.commandType === pending.commandType
        ? validResult(receipt.result, pending) : null;
      if (resultId === null) {
        setActionError("原命令回执类型或目标不匹配，结果仍未确定。请保留 command_id 核对。"); return;
      }
      pendingRef.current = null; setPendingCommand(null); setSelectedId(resultId); setActionError(null);
      setActionMessage("已核对原命令回执；正在读取最新资料。"); setFormOpen(false);
      await load(kind, resultId);
    } catch (caught) {
      if (context !== contextVersion.current) return;
      setActionError(caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND"
        ? "暂未找到原命令回执。请稍后仍用同一个 command_id 核对。"
        : describeLiveError(caught).message);
    } finally {
      if (context === contextVersion.current) setSubmitting(false);
    }
  }

  return <section className="knowledge-page">
    <p className="eyebrow">{projectId ? "项目资料" : "工作空间资料"}</p>
    <h1>知识与长期信息</h1>
    <p className="page-lede">资料、已确认记忆、决定和规则分别保存版本；搜索只查真实服务端事实。</p>
    {projectId && <ProjectNav projectId={projectId} active="knowledge" />}
    {projectId && live && client && <div className="knowledge-guide-toggle"><button type="button"
      className="secondary-button" data-testid="knowledge-guide-toggle"
      onClick={() => setGuideOpen((value) => !value)}>{guideOpen ? "返回资料列表" : "打开项目导读"}</button></div>}
    {guideOpen && projectId && client && <ProjectKnowledgeGuide key={`${connection.epoch}:${projectId}`}
      client={client} projectId={projectId} onOpen={(nextKind, nextId) => {
        setGuideOpen(false); setKind(nextKind); setSelectedId(nextId); setSelected(null);
        void load(nextKind, nextId);
      }} />}

    {!live ? <section className="surface-panel" data-testid="knowledge-fixture-gap">
      <h2>示例模式未接入资料</h2>
      <p>此处不生成虚构的 Knowledge、Memory、Decision 或 Rule。连接本机 API 后可读取和管理真实资料。</p>
    </section> : <>
      <section className="surface-panel" aria-label="资料搜索">
        <h2>有界搜索</h2>
        <label className="field" htmlFor="knowledge-search"><span className="field-label">搜索词</span>
          <span className="field-hint">按当前范围搜索四类资料，支持中文短词；每页最多 20 条。</span>
          <input id="knowledge-search" value={query} onChange={(event) => setQuery(event.target.value)} data-testid="knowledge-search" type="search" maxLength={200} autoComplete="off" />
        </label>
        {searching && <p role="status">正在搜索…</p>}
        {searchError && <p className="action-error" role="alert">{searchError}</p>}
        {searchItems.length > 0 ? <ul className="knowledge-search-list">{searchItems.map((item) =>
          <li key={`${item.type}-${item.id}-${item.version}`}><button type="button" className="knowledge-result" disabled={pendingCommand !== null} onClick={() => openSearchItem(item)}>
            <strong>{item.title}</strong> · {item.type} v{item.version} · {item.status}
            <span>{item.snippet}</span><small>匹配：{item.matchedFields.join("、")} · 来源 {item.sourceRef}</small>
          </button></li>)}</ul> : query.trim() && !searching && !searchError && <p className="helper-text">没有匹配的当前有效资料。</p>}
        {nextCursor && <button type="button" className="secondary-button" data-testid="knowledge-more" disabled={searching}
          onClick={() => { void runSearch(searchVersion.current, query.trim(), nextCursor); }}>加载下一页</button>}
      </section>

      {projectId && client && kind === "KNOWLEDGE" && <WebImportPanel
        key={`${connection.epoch}:${projectId}`} client={client} projectId={projectId}
        onOpenKnowledge={(knowledgeId) => {
          setSelectedId(knowledgeId); setFormOpen(false); setActionError(null);
          void load("KNOWLEDGE", knowledgeId);
        }} />}

      <nav className="knowledge-tabs" aria-label="资料类型">{kinds.map((item) =>
        <button key={item.kind} type="button" className={`subnav-item${kind === item.kind ? " subnav-item--active" : ""}`}
          aria-current={kind === item.kind ? "page" : undefined} disabled={pendingCommand !== null}
          data-testid={`knowledge-tab-${item.kind}`} onClick={() => switchKind(item.kind)}>{item.label}</button>)}</nav>
      {error && <p className="action-error" role="alert">{error} <button type="button" className="text-button" onClick={() => { void load(); }}>重新读取</button></p>}
      {loading && <p role="status">正在读取资料…</p>}
      {refreshing && <p role="status">正在读取最新版本…</p>}
      {actionError && <p className="action-error" role="alert">{actionError}</p>}
      {actionMessage && <p className="receipt-message" role="status">{actionMessage}</p>}
      {writeBlockedReason && <p className="disabled-reason" data-testid="knowledge-project-write-blocked">{writeBlockedReason} <button type="button" className="text-button" onClick={() => setGateReload((value) => value + 1)}>重读项目状态</button></p>}
      {pendingCommand && <div className="surface-panel" data-testid="knowledge-pending-receipt">
        <h2>提交结果待核对</h2><p>原 command_id：{pendingCommand.id}。查询原命令回执前不再次提交。</p>
        <button type="button" className="secondary-button" data-testid="knowledge-check-receipt" disabled={submitting} onClick={() => { void checkReceipt(); }}>核对原命令回执</button>
      </div>}

      <div className="knowledge-columns">
        <section className="surface-panel knowledge-list">
          <div className="section-heading-row"><h2>{kinds.find((item) => item.kind === kind)?.label}</h2>
            <button type="button" className="secondary-button" data-testid="knowledge-create" disabled={pendingCommand !== null} onClick={() => openForm(false)}>新建</button></div>
          {!loading && rows.length === 0 && <p className="helper-text">当前范围还没有这类资料。</p>}
          {rows.map((row) => <button key={row.id} type="button" className={`knowledge-row${row.id === selectedId ? " knowledge-row--active" : ""}`}
            disabled={pendingCommand !== null} onClick={() => selectRow(row.id)}><strong>{rowTitle(row)}</strong><small>{row.status} · v{row.revision}</small></button>)}
        </section>

        <div className="knowledge-detail">
          {selected ? <section className="surface-panel">
            <div className="section-heading-row"><h2>{rowTitle(selected)}</h2><span>{selected.status} · 修订 v{selected.revision}</span></div>
            <p className="helper-text">ID：{selected.id} · 当前版本 v{selected.currentVersion}</p>
            {selectedKnowledge && <p className="helper-text">资料归属：{selectedKnowledge.projectId ?? "工作空间"}</p>}
            {selectedMemory && <><p className="knowledge-body">{selectedMemory.text}</p>
              <p className="helper-text">明确确认：{selectedMemory.confirmedBy} · {selectedMemory.confirmedAt}{selectedMemory.expiresAt && <> · 到期 {selectedMemory.expiresAt}</>}</p></>}
            {selectedDecision && <><p className="knowledge-body">选择：{selectedDecision.choice}</p>
              <p className="knowledge-body">依据：{selectedDecision.rationale}</p>
              <p>备选：{selectedDecision.alternatives.join("、") || "未记录"}</p><p>代价：{selectedDecision.costs.join("、") || "未记录"}</p>
              {selectedDecision.supersededById && <p data-testid="decision-supersession">已由 Decision {selectedDecision.supersededById} 替代；旧决定保留可查。</p>}</>}
            {selectedRule && <><p className="knowledge-body">{selectedRule.statement}</p>
              <p>{selectedRule.strength} · {selectedRule.scope} / {selectedRule.scopeId} · {selectedRule.applicability}</p>
              <p>执行检查：{selectedRule.enforcement}{selectedRule.method && <> · {selectedRule.method}</>}</p>
              <p className="helper-text">目标约束：{JSON.stringify(selectedRule.targetSpec)}</p></>}

            {selected.status === "ACTIVE" && pendingCommand === null && <div className="knowledge-actions">
              {kind !== "DECISION" && <button type="button" className="secondary-button" data-testid="knowledge-new-version" disabled={writeBlockedReason !== null} onClick={() => openForm(true)}>追加新版本</button>}
              {kind === "KNOWLEDGE" && <button type="button" className="danger-button" disabled={writeBlockedReason !== null} onClick={() => { void retire(); }}>归档资料</button>}
              {(kind === "MEMORY" || kind === "RULE") && <button type="button" className="danger-button" disabled={writeBlockedReason !== null} onClick={() => { void retire(); }}>停用{kind === "MEMORY" ? "记忆" : "规则"}</button>}
            </div>}
            {selectedDecision?.status === "ACTIVE" && pendingCommand === null && <>
              <label className="field" htmlFor="decision-replacement"><span className="field-label">替代它的 Decision ID</span>
                <input id="decision-replacement" value={replacementId} onChange={(event) => setReplacementId(event.target.value)} data-testid="decision-replacement" /></label>
              <button type="button" className="secondary-button" data-testid="decision-supersede" disabled={writeBlockedReason !== null} onClick={() => { void supersede(); }}>记录替代关系</button>
            </>}

            {selectedKnowledge && client && <KnowledgeReader key={`${selectedKnowledge.id}:${selectedKnowledge.currentVersion}:${routeItem === selectedKnowledge.id ? routeVersion ?? "" : ""}`}
              client={client} knowledge={selectedKnowledge} versions={knowledgeVersions}
              initialVersion={routeItem === selectedKnowledge.id ? routeVersion : null} />}
            {selectedMemory && <section className="knowledge-history"><h3>确认修订历史</h3><ol>{memoryRevisions.map((revision) =>
              <li key={revision.id}>v{revision.version} · {revision.title} · {revision.confirmedBy} 于 {revision.confirmedAt}<p>{revision.text}</p></li>)}</ol></section>}
            {selectedRule && <section className="knowledge-history"><h3>规则版本历史</h3><ol>{ruleVersions.map((version) =>
              <li key={`${version.ruleId}-${version.version}`}>v{version.version} · {version.strength} · {version.enforcement} · {version.ruleKey}<p>{version.statement}</p></li>)}</ol></section>}
          </section> : !loading && <section className="surface-panel"><p>选择一项资料查看详情与版本。</p></section>}

          {formOpen && <form className="surface-panel knowledge-form" data-testid="knowledge-form" onSubmit={(event) => { void save(event); }}>
            <h2>{revisionMode ? "追加新版本" : `新建 ${kind}`}</h2>
            {revisionMode && <p className="helper-text">基于起草时修订 v{kind === "KNOWLEDGE" ? knowledgeDraftBase?.revision : selected?.revision} 提交；冲突时保留草稿，旧版本不会被覆盖。</p>}
            {(kind === "MEMORY" || (kind !== "RULE" && !revisionMode)) && <label className="field"><span className="field-label">标题</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} data-testid="knowledge-title" required disabled={pendingCommand !== null} /></label>}
            {kind === "KNOWLEDGE" && <>
               <label className="field"><span className="field-label">来源类型</span><select value={sourceKind} onChange={(event) => { previewReadVersion.current++; setSourceKind(event.target.value as Exclude<RelayKnowledgeSource, "WEB_PAGE">); setArtifactPreview(null); setCaptureConfirmed(false); if (event.target.value === "NOTE") setMediaType("text/plain"); }} disabled={pendingCommand !== null}>
                <option value="NOTE">NOTE</option><option value="MANAGED_TEXT">MANAGED_TEXT</option><option value="ARTIFACT_VERSION">ARTIFACT_VERSION</option></select></label>
               {sourceKind === "ARTIFACT_VERSION" ? <><label className="field"><span className="field-label">产物版本 ID</span>
                 <input value={artifactVersionId} onChange={(event) => { previewReadVersion.current++; setArtifactVersionId(event.target.value); setArtifactPreview(null); setCaptureConfirmed(false); }} data-testid="knowledge-artifact-id" disabled={pendingCommand !== null} /></label>
                 <button type="button" className="secondary-button" disabled={pendingCommand !== null}
                   onClick={() => { void readArtifactPreview(); }}>核对确切产物版本</button>
                 {artifactPreviewError && <p className="action-error" role="alert">{artifactPreviewError}</p>}
                 {artifactPreview?.id === artifactVersionId.trim() && <><pre className="knowledge-capture-preview">{artifactPreview.text}</pre>
                   <label className="knowledge-check"><input type="checkbox" checked={captureConfirmed}
                     onChange={(event) => setCaptureConfirmed(event.target.checked)} data-testid="knowledge-capture-confirmed" />我已核对正文、来源版本和目标范围；收录不修改原产物，也不代表通过验收。</label></>}
               </>
                 : <><label className="field"><span className="field-label">受管文本</span><textarea value={text} onChange={(event) => setText(event.target.value)} data-testid="knowledge-text" rows={6} disabled={pendingCommand !== null} /></label>
                   <label className="field"><span className="field-label">媒体类型</span><select value={mediaType} onChange={(event) => setMediaType(event.target.value)} disabled={pendingCommand !== null}>
                     <option value="text/plain">text/plain</option>{sourceKind === "MANAGED_TEXT" && <option value="text/markdown">text/markdown</option>}</select></label></>}
               <section className="knowledge-capture-review" aria-label="保存前核对"><h3>保存前核对</h3>
                 <p>归类：Knowledge · {sourceKind}；目标范围：{(revisionMode ? knowledgeDraftBase?.projectId : projectId) ? `项目 ${revisionMode ? knowledgeDraftBase?.projectId : projectId}` : "工作空间"}。</p>
                 {sourceKind === "ARTIFACT_VERSION" ? <p>来源：确切产物版本 {artifactVersionId || "未填写"}。</p>
                   : <p className="knowledge-body">正文预览：{text || "尚未填写"}</p>}
                 <p className="helper-text">只有服务端命令成功并重读后才成为已收录版本；阅读和收录不授予 AI 使用权限。</p>
               </section>
            </>}
            {kind === "MEMORY" && <>
              <label className="field"><span className="field-label">需要长期保留的事实</span><textarea value={text} onChange={(event) => setText(event.target.value)} data-testid="memory-text" rows={6} disabled={pendingCommand !== null} /></label>
              <label className="field"><span className="field-label">到期时间（可选）</span><input value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} type="datetime-local" disabled={pendingCommand !== null} /></label>
              <label className="knowledge-check"><input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" data-testid="memory-confirmed" disabled={pendingCommand !== null} />我已核对并明确确认这条 Memory</label>
            </>}
            {kind === "DECISION" && <>
              <label className="field"><span className="field-label">做出的选择</span><textarea value={choice} onChange={(event) => setChoice(event.target.value)} rows={3} disabled={pendingCommand !== null} /></label>
              <label className="field"><span className="field-label">依据</span><textarea value={rationale} onChange={(event) => setRationale(event.target.value)} rows={3} disabled={pendingCommand !== null} /></label>
              <label className="field"><span className="field-label">备选方案（每行一项）</span><textarea value={alternatives} onChange={(event) => setAlternatives(event.target.value)} rows={3} disabled={pendingCommand !== null} /></label>
              <label className="field"><span className="field-label">代价（每行一项）</span><textarea value={costs} onChange={(event) => setCosts(event.target.value)} rows={3} disabled={pendingCommand !== null} /></label>
            </>}
            {kind === "RULE" && <>
              {!revisionMode && <><label className="field"><span className="field-label">作用域</span><select value={scope} onChange={(event) => setScope(event.target.value as Scope)} disabled={pendingCommand !== null}>
                <option value="WORKSPACE">WORKSPACE</option><option value="PROJECT">PROJECT</option><option value="TASK">TASK</option></select></label>
                {(scope === "TASK" || (scope === "PROJECT" && !projectId)) && <label className="field"><span className="field-label">作用域 ID</span><input value={scopeId} onChange={(event) => setScopeId(event.target.value)} data-testid="rule-scope-id" disabled={pendingCommand !== null} /></label>}</>}
              <label className="field"><span className="field-label">规则键</span><input value={ruleKey} onChange={(event) => setRuleKey(event.target.value)} disabled={pendingCommand !== null} /></label>
              <label className="field"><span className="field-label">规则陈述</span><textarea value={statement} onChange={(event) => setStatement(event.target.value)} rows={4} disabled={pendingCommand !== null} /></label>
              <label className="field"><span className="field-label">强度</span><select value={strength} onChange={(event) => setStrength(event.target.value as RelayRuleStrength)} data-testid="rule-strength" disabled={pendingCommand !== null}>
                <option value="PREFERENCE">PREFERENCE · 偏好</option><option value="HARD">HARD · 硬约束</option></select></label>
              <label className="field"><span className="field-label">执行检查路径</span><select value={enforcement} onChange={(event) => setEnforcement(event.target.value as RelayRuleEnforcement)} data-testid="rule-enforcement" disabled={pendingCommand !== null}>
                <option value="PRE_ACTION">PRE_ACTION</option><option value="POST_CHECK">POST_CHECK</option><option value="SEMANTIC">SEMANTIC</option><option value="HUMAN">HUMAN</option></select></label>
              <label className="field"><span className="field-label">检查方法</span><select value={method} onChange={(event) => setMethod(event.target.value)} disabled={pendingCommand !== null}>
                <option value="">未指定</option><option value="MARKDOWN_STRUCTURE">MARKDOWN_STRUCTURE</option><option value="CITATION_EXISTS">CITATION_EXISTS</option>
                <option value="SEMANTIC">SEMANTIC</option><option value="HUMAN">HUMAN</option></select></label>
              <label className="field"><span className="field-label">目标约束 JSON（可选）</span><textarea value={targetSpec} onChange={(event) => setTargetSpec(event.target.value)} rows={3} disabled={pendingCommand !== null} /></label>
              <p className="field-hint">HARD 冲突或必需检查路径不可用时，服务端拒绝写入；不会把未检查的规则当作生效。</p>
            </>}
            <div className="knowledge-actions"><button type="submit" className="primary-button" data-testid="knowledge-save" disabled={submitting || pendingCommand !== null || writeBlockedReason !== null || (kind === "MEMORY" && !confirmed)}>保存{revisionMode ? "新版本" : ""}</button>
              <button type="button" className="secondary-button" disabled={pendingCommand !== null} onClick={() => setFormOpen(false)}>取消</button></div>
          </form>}
        </div>
      </div>
    </>}
  </section>;
}
