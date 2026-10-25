import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import ProjectNav from "../components/ProjectNav";
import PageHeader from "../components/PageHeader";
import AppDialog from "../components/AppDialog";
import EmptyState from "../components/EmptyState";
import KnowledgeReader from "../components/KnowledgeReader";
import SafeMarkdown from "../components/SafeMarkdown";
import ProjectKnowledgeGuide from "../components/ProjectKnowledgeGuide";
import WebImportPanel from "../components/WebImportPanel";
import { MemoryProvenancePanel } from "../components/MessageMemorySources";
import { escalateFeedback, openUndoFeedback } from "../components/Feedback";
import {
  createCommandId, RelayApiError, RelayTransportError,
  type RelayApiClient, type RelayCommandEnvelope, type RelayDecision,
  type RelayInformationKind, type RelayKnowledge, type RelayKnowledgeSource, type RelayKnowledgeVersion,
  type RelayMemory, type RelayMemoryEffectiveStatus, type RelayMemoryRevision, type RelayRule, type RelayRuleEnforcement,
  type RelayRuleStrength, type RelayRuleVersion, type RelaySearchItem
} from "../api/relayClient";
import { describeLiveError, needsReceiptCheck } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { handleTabListKeyDown } from "../lib/tabNavigation";
import { useProjectTaskPages } from "../lib/useProjectTaskPages";
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
  /**
   * 本次成功后的收尾语义（#109）：与直接成功完全一致，回执补查成功时不能另算一套。
   * 生命周期恢复命令为 false——只收口 pending 与对象状态，不碰未参与命令的新建草稿。
   */
  readonly resetComposer: boolean;
}

/**
 * `submit()` 的出口：调用方需要区分三种事实，不能都用「成功/失败」两分。
 * - `CONFIRMED`：回执已核对，带服务端推进后的修订（撤销要用它，不读列表里的旧行）；
 * - `REJECTED`：服务端明确拒绝或命令根本没发出，可以安全重来；
 * - `UNCERTAIN`：命令可能已入库但回执读不出，只能按原 command_id 核对。
 */
type SubmitOutcome =
  | { readonly kind: "CONFIRMED"; readonly id: string; readonly revision: string }
  | { readonly kind: "REJECTED"; readonly error: unknown }
  | { readonly kind: "UNCERTAIN" };

const kinds: readonly { kind: RelayInformationKind; label: string; noun: string }[] = [
  { kind: "KNOWLEDGE", label: "资料", noun: "资料" },
  { kind: "MEMORY", label: "记忆", noun: "记忆" },
  { kind: "DECISION", label: "决定", noun: "决定" },
  { kind: "RULE", label: "规则", noun: "规则" }
];

/**
 * 规则没有标题，但规则键是服务端身份（可能由服务端生成成 `rule-<uuid>`），
 * 摆在列表首位等于让用户读一串标识。列表用陈述首行作名字，键留在详情与版本历史里核对。
 */
function rowTitle(row: InformationRow): string {
  if ("title" in row) return row.title;
  const statement = row.statement.split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== "");
  if (statement === undefined || statement === "") return row.ruleKey;
  return statement.length > 60 ? `${statement.slice(0, 60)}…` : statement;
}

function rowScopeLabel(row: InformationRow): string {
  if ("scope" in row) return ruleScopeLabels[row.scope] ?? row.scope;
  return row.projectId ? "项目" : "工作空间";
}

/** 状态语气只分三种事实：有效、已被替代、停用或归档；未知值回退原枚举，不推测。 */
function statusLabel(status: string): string {
  return status === "ACTIVE" ? "有效" : status === "SUPERSEDED" ? "已被替代" : "已停用或归档";
}

/**
 * 记忆的筛选维度：只描述服务端算出的有效状态，不新增可写状态。
 *
 * 「有效」只表示未停用且未到期，不保证项目/权限可用，也不保证进入模型 Context。
 */
type MemoryEffectiveFilter = RelayMemoryEffectiveStatus | "ALL";

const memoryFilterOptions: readonly { readonly value: MemoryEffectiveFilter; readonly label: string }[] = [
  { value: "ALL", label: "全部" },
  { value: "ACTIVE", label: "有效" },
  { value: "EXPIRED", label: "已过期" },
  { value: "RETIRED", label: "已停用" }
];

const memoryEffectiveLabels: Record<RelayMemoryEffectiveStatus, string> = {
  ACTIVE: "有效", EXPIRED: "已过期", RETIRED: "已停用"
};

/**
 * 有效状态只读服务端快照：缺字段（旧服务端）说「状态待核对」，
 * 不回退 `status === "ACTIVE"`，也不按浏览器时钟推算是否到期。
 */
function memoryStatusText(memory: RelayMemory): string {
  return memory.effectiveStatus === null ? "状态待核对" : memoryEffectiveLabels[memory.effectiveStatus];
}

function memoryFilterLabel(filter: MemoryEffectiveFilter): string {
  return memoryFilterOptions.find((option) => option.value === filter)?.label ?? filter;
}

/** 记忆行同时给出有效状态与原确认事实（有效期），两者职责分开。 */
function memoryRowSummary(memory: RelayMemory): string {
  return `${memoryStatusText(memory)} · ${memory.origin === "AUTO_CAPTURE" ? `自动记住${memorySourceKindLabel(memory.sourceKind)} · ` : ""}当前 v${memory.currentVersion} · ${rowScopeLabel(memory)} · ${
    memory.expiresAt === null ? "无到期时间" : `到期 ${memory.expiresAt}`}`;
}

/**
 * DEV-0042：自动记住的条目要看出「这句话是谁说的」——
 * 用户原话可以说成用户的事实，模型观察（可能含工具结果或网页正文的转述）只是观察。
 */
export function memorySourceKindLabel(kind: RelayMemory["sourceKind"]): string {
  if (kind === "USER_STATEMENT") return "（用户原话）";
  if (kind === "MODEL_OBSERVATION") return "（模型观察）";
  if (kind === "MANUAL") return "（人工保存）";
  return "（来源未标注）";
}

/** 规则枚举的中文显示：中文承担阅读，未知值回退原枚举。 */
const ruleScopeLabels: Record<string, string> = { WORKSPACE: "工作空间", PROJECT: "项目", TASK: "任务" };
const ruleStrengthLabels: Record<string, string> = { HARD: "硬约束", PREFERENCE: "偏好" };
const ruleEnforcementLabels: Record<string, string> = {
  PRE_ACTION: "动作前检查", POST_CHECK: "动作后检查", SEMANTIC: "语义检查", HUMAN: "人工检查"
};
const ruleApplicabilityLabels: Record<string, string> = { AI_RUN: "AI 运行时" };

/**
 * 有反向命令的三类信息各自的「已停用」根状态：资料是 ARCHIVED，记忆与规则是 RETIRED。
 * Decision 只有 ACTIVE/SUPERSEDED，替代关系不可撤销，所以不在这张表里。
 */
function retiredStatusOf(kind: RelayInformationKind): string | null {
  return kind === "KNOWLEDGE" ? "ARCHIVED" : kind === "MEMORY" || kind === "RULE" ? "RETIRED" : null;
}

/**
 * 恢复文案必须写明「只恢复状态」（工作台 §13.2 第四条）：补偿命令只改状态列，
 * 归档产生的待核对候选、记忆有效期和规则修订都不会跟着回退，也不能承诺续跑旧 Run。
 */
const restoreCopy: Record<"KNOWLEDGE" | "MEMORY" | "RULE", {
  readonly button: string; readonly note: string; readonly done: string;
}> = {
  KNOWLEDGE: {
    button: "恢复这条资料",
    note: "恢复只把状态改回有效：正文版本、来源与归档时产生的待核对候选都保持原状，待核对项仍需在原入口判断。",
    done: "已恢复为有效资料；正文版本与待核对候选保持原状。"
  },
  MEMORY: {
    button: "恢复这条记忆",
    note: "恢复只把状态改回有效，不延长有效期：已过期的记忆仍按原规则排除，不能当作可供 Agent 使用。",
    // 回执只带持久状态 ACTIVE；是否到期由重读后的 effective_status 决定，回执不替它下结论。
    done: "已恢复记忆的持久状态；有效期与确认信息保持原状，若已到期仍显示「已过期」。"
  },
  RULE: {
    button: "恢复这条规则",
    note: "恢复只把状态改回有效：规则与上下文修订继续向前，不回退到旧修订，也不自动续跑此前的 Run。",
    done: "已恢复为有效规则；规则与上下文修订继续递增，不自动续跑旧 Run。"
  }
};

/** 已映射的枚举以 small（title 属性）保留原枚举供核对；未映射的值原样展示。 */
function enumText(labels: Record<string, string>, value: string) {
  const label = labels[value];
  return label === undefined ? value : <>{label}<small title={value}>（{value}）</small></>;
}

/** 目标约束不把原始 JSON 摆到阅读位：空对象、缺失与有内容三种事实分开说。 */
function ruleTargetSpecView(targetSpec: Readonly<Record<string, unknown>> | null): { text: string; json: string | null } {
  if (targetSpec === null) return { text: "当前响应未提供", json: null };
  return Object.keys(targetSpec).length === 0
    ? { text: "未提供具体检查对象", json: null }
    : { text: "已提供，展开查看技术 JSON", json: JSON.stringify(targetSpec) };
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

/**
 * 原到期时刻的 datetime-local 表示（本机墙钟；非零秒/毫秒按控件精度保留）。
 *
 * datetime-local 承载不了 UTC 偏移与完整精度，所以提交端约定：字段未被编辑时按原 ISO
 * 原样回传，编辑过才按本机时区重新换算（见 save 的 MEMORY 分支）。这里的格式与控件
 * 的规范化值一致（秒/毫秒仅在非零时出现），保证「未编辑」的判断不被控件静默改写。
 */
function memoryExpiryInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getSeconds() === 0 && date.getMilliseconds() === 0) return base;
  const withSeconds = `${base}:${pad(date.getSeconds())}`;
  return date.getMilliseconds() === 0 ? withSeconds : `${withSeconds}.${pad(date.getMilliseconds(), 3)}`;
}

function confirmedResult(result: Readonly<Record<string, unknown>>, pending: PendingCommand): { readonly id: string; readonly revision: string } | null {
  const id = result[pending.resultKey];
  if (typeof id !== "string" || id.length === 0 ||
    (pending.targetId !== null && id !== pending.targetId) ||
    typeof result.revision !== "string" || !/^\d+$/u.test(result.revision) ||
    typeof result.status !== "string") return null;
  if (pending.replacementId !== null && result.replacement_decision_id !== pending.replacementId) return null;
  if (["CreateKnowledge", "AddKnowledgeVersion", "CreateMemory", "AddMemoryRevision", "CreateDecision", "CreateRule", "AddRuleVersion"].includes(pending.commandType) &&
    (typeof result.version !== "string" || !/^\d+$/u.test(result.version))) return null;
  // 反向命令的回执必须自带 ACTIVE：只有 revision 递增而状态仍停用，不能当作恢复成功。
  if (["UnarchiveKnowledge", "ReactivateMemory", "ReactivateRule"].includes(pending.commandType) &&
    result.status !== "ACTIVE") return null;
  return { id, revision: result.revision };
}

/**
 * 搜索结果的唯一键：类型 + ID + 版本。
 *
 * 续页重试与服务端重叠返回都不能把同一条结果排两次；首屏已有的项也按这把键去重。
 */
function searchItemKey(item: RelaySearchItem): string {
  return `${item.type}-${item.id}-${item.version}`;
}

/** 按唯一键去重后追加：同一条结果在已加载项里或在同一页里都只排一次。 */
function appendSearchItems(current: readonly RelaySearchItem[], incoming: readonly RelaySearchItem[]): readonly RelaySearchItem[] {
  const seen = new Set(current.map(searchItemKey));
  const fresh = incoming.filter((item) => {
    const key = searchItemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...current, ...fresh];
}

/**
 * 失权（401/403）与暂时不可用（5xx）是两种事实。
 *
 * 暂时失败保留已核实的结果与游标；失权不能保留——继续把无权查看的资料摆在界面上，
 * 等于用缓存冒充当前仍然成立的读取结果。
 */
function isAccessRevoked(caught: unknown): boolean {
  return caught instanceof RelayApiError && (caught.problem.status === 401 || caught.problem.status === 403);
}

/** 搜索失败的说法：失权说清「已清空」，其它失败按可操作原因说明，不写成「没有匹配」。 */
function searchFailureMessage(caught: unknown): string {
  return isAccessRevoked(caught)
    ? "当前范围的资料已无权读取；已清空搜索结果，请核对权限后重新搜索。"
    : describeLiveError(caught).message;
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
  const tabId = useId();
  const tabListRef = useRef<HTMLElement>(null);
  const libraryRef = useRef<HTMLDetailsElement>(null);
  const focusKindAfterRead = useRef<RelayInformationKind | null>(null);
  const [rows, setRows] = useState<readonly InformationRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(routeItem);
  const [selected, setSelected] = useState<InformationRow | null>(null);
  /** 记忆页签的有效状态筛选：只影响 Memory 的 GET，不改其他类型请求。 */
  const [memoryFilter, setMemoryFilter] = useState<MemoryEffectiveFilter>("ALL");
  const [knowledgeVersions, setKnowledgeVersions] = useState<readonly RelayKnowledgeVersion[]>([]);
  const [memoryRevisions, setMemoryRevisions] = useState<readonly RelayMemoryRevision[]>([]);
  const [ruleVersions, setRuleVersions] = useState<readonly RelayRuleVersion[]>([]);
  const [loading, setLoading] = useState(true);
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
  const [restoring, setRestoring] = useState(false);

  const [query, setQuery] = useState(routeSearch);
  const [searchItems, setSearchItems] = useState<readonly RelaySearchItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  /** 首屏失败：整页错误态，不冒充「没有匹配」。 */
  const [searchError, setSearchError] = useState<string | null>(null);
  /**
   * 续页失败：只降级为局部错误。
   *
   * 已核实的第一页与原游标必须留着，用户才能按同一游标原地重试；
   * 只有失权才清空（那时保留的是无权查看的资料）。
   */
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const searchVersion = useRef(0);
  /** 续页在途标记：用 ref 挡住连点，state 只负责渲染「正在加载下一页」。 */
  const moreBusy = useRef(false);
  /** 续页必须用与首屏相同的搜索词：游标只对那一次搜索有效。 */
  const searchTerm = useRef("");

  const [formOpen, setFormOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [revisionMode, setRevisionMode] = useState(false);
  const [knowledgeDraftBase, setKnowledgeDraftBase] = useState<{ id: string; revision: string; projectId: string | null } | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [sourceKind, setSourceKind] = useState<Exclude<RelayKnowledgeSource, "WEB_PAGE">>("NOTE");
  const [artifactVersionId, setArtifactVersionId] = useState("");
  const [artifactPreview, setArtifactPreview] = useState<{ id: string; text: string } | null>(null);
  const [artifactPreviewError, setArtifactPreviewError] = useState<string | null>(null);
  /**
   * 产物版本候选：只读当前项目内真实存在的 Markdown 版本。
   *
   * 以前这里只有一个必填的 UUID 输入框，用户得先从别处复制版本 ID——那是最典型的
   * 「手工搬运底层标识」。候选列表按任务聚合读取，选中的就是确切版本，不用再核对一次。
   */
  const [artifactCandidates, setArtifactCandidates] = useState<{
    readonly status: "IDLE" | "LOADING" | "READY" | "ERROR";
    readonly items: readonly { readonly versionId: string; readonly title: string;
      readonly versionNumber: string; readonly createdAt: string; readonly taskTitle: string }[];
    readonly error: string | null;
  }>({ status: "IDLE", items: [], error: null });
  const artifactSourceActive = formOpen && kind === "KNOWLEDGE" && sourceKind === "ARTIFACT_VERSION";
  const artifactTaskPages = useProjectTaskPages(client, projectId ?? "", artifactSourceActive,
    connection.epoch, 12);
  const attemptedArtifactTasks = useRef(new Set<string>());
  const pendingArtifactTasks = useRef(new Set<string>());
  const failedArtifactTasks = useRef(new Set<string>());
  const [captureConfirmed, setCaptureConfirmed] = useState(false);
  const [mediaType, setMediaType] = useState("text/plain");
  const [confirmed, setConfirmed] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");
  /**
   * 修订草稿打开时的原到期时刻（确切 ISO）；新建表单与无期限记忆为 null（#33）。
   * 提交时若到期输入仍是打开表单时的回填值，就按这个原 ISO 原样提交，
   * 只改正文不会顺带撤销或取整有效期；显式编辑或清空才改变。
   */
  const [memoryExpiryOriginal, setMemoryExpiryOriginal] = useState<string | null>(null);
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
  const [draftTransition, setDraftTransition] = useState<(() => void) | null>(null);
  const draftBaseline = useRef<string | null>(null);
  const captureDraftBaseline = useRef(false);
  const draftSignature = JSON.stringify([title, text, sourceKind, artifactVersionId, captureConfirmed,
    mediaType, confirmed, expiresAt, choice, rationale, alternatives, costs, replacementId,
    scope, scopeId, ruleKey, statement, strength, enforcement, method, targetSpec]);
  const navigationState = useRef({ dirty: false, submitting });
  navigationState.current = { dirty: live && draftBaseline.current !== null && draftBaseline.current !== draftSignature, submitting };
  /**
   * 迟到的撤销回执只认这一刻的视图：同一 API + 同一类型 + 同一范围才刷新。
   * 视图已经切走时结果仍然属于原对象，但不写进新范围——那会把别人的列表改成这次的结果。
   */
  const liveContext = useRef({ client, kind, projectId });
  liveContext.current = { client, kind, projectId };
  /** 撤销条比触发它的渲染活得久：重读要用按下去那一刻的筛选，而不是创建回调时的旧值。 */
  const memoryFilterRef = useRef<MemoryEffectiveFilter>(memoryFilter);
  memoryFilterRef.current = memoryFilter;
  const draftGuard = useRef<DraftGuard>({
    hasUnsavedChanges: () => navigationState.current.dirty || navigationState.current.submitting || pendingRef.current !== null,
    pendingCommandId: () => pendingRef.current?.id ?? null,
    discard: () => {
      if (pendingRef.current !== null || navigationState.current.submitting) return;
      navigationState.current.dirty = false; clearDraft(); setFormOpen(false);
    }
  });
  useEffect(() => { setDraftGuard(draftGuard.current); return () => clearDraftGuard(draftGuard.current); }, []);
  useEffect(() => {
    if (captureDraftBaseline.current) { draftBaseline.current = draftSignature; captureDraftBaseline.current = false; }
  }, [draftSignature, formOpen]);

  function requestDraftTransition(proceed: () => void) {
    if (pendingRef.current !== null || submitting) return;
    if (navigationState.current.dirty) setDraftTransition(() => proceed);
    else proceed();
  }

  const selectedKnowledge = kind === "KNOWLEDGE" ? selected as RelayKnowledge | null : null;
  const selectedMemory = kind === "MEMORY" ? selected as RelayMemory | null : null;
  const selectedDecision = kind === "DECISION" ? selected as RelayDecision | null : null;
  const selectedRule = kind === "RULE" ? selected as RelayRule | null : null;
  const currentNoun = kinds.find((item) => item.kind === kind)?.noun ?? "资料";

  useEffect(() => {
    if (formOpen) formRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [formOpen]);

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
    draftBaseline.current = null; captureDraftBaseline.current = false;
    previewReadVersion.current++;
    setKnowledgeDraftBase(null);
    setTitle(""); setText(""); setSourceKind("NOTE"); setArtifactVersionId("");
    setArtifactPreview(null); setArtifactPreviewError(null); setCaptureConfirmed(false);
    setArtifactCandidates({ status: "IDLE", items: [], error: null });
    attemptedArtifactTasks.current.clear(); pendingArtifactTasks.current.clear(); failedArtifactTasks.current.clear();
    setMediaType("text/plain"); setConfirmed(false); setExpiresAt(""); setMemoryExpiryOriginal(null);
    setChoice(""); setRationale(""); setAlternatives(""); setCosts("");
    setReplacementId(""); setScope(projectId === null ? "WORKSPACE" : "PROJECT");
    setScopeId(""); setRuleKey(""); setStatement(""); setStrength("PREFERENCE");
    setEnforcement("HUMAN"); setMethod(""); setTargetSpec("");
  }

  /**
   * 统一读取：列表 + 详情 + 版本。
   *
   * `nextFilter` 只对 MEMORY 生效并原样交给服务端；`dropUnmatchedSelection` 用于命令成功后的
   * 定向重读——对象可能已不符合当前筛选（例如停用后不再属于「有效」），此时按列表事实把
   * 选中项落到剩余项，而不是继续展示一条已经不在当前列表里的详情。
   */
  async function load(nextKind = kind, nextId = selectedId, activeClient = client, activeProject = projectId,
    nextFilter: MemoryEffectiveFilter = memoryFilter, dropUnmatchedSelection = false): Promise<void> {
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
        : nextKind === "MEMORY" ? await activeClient.getMemories(activeProject, nextFilter)
          : nextKind === "DECISION" ? await activeClient.getDecisions(activeProject)
            : await activeClient.getRules(activeProject);
      const detailId = nextId !== null && (!dropUnmatchedSelection || list.some((row) => row.id === nextId))
        ? nextId : list[0]?.id ?? null;
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
    focusKindAfterRead.current = null;
    pendingRef.current = null;
    setPendingCommand(null); setSubmitting(false); setKind(routeKind); setSelectedId(routeItem); setSelected(null); setRows([]);
    setMemoryFilter("ALL");
    setActionError(null); setActionMessage(null); setFormOpen(false);
    setGuideOpen(false);
    setQuery(routeSearch);
    clearDraft();
    // 显式传 ALL：上面的 setState 尚未生效，这里不能读到上一个范围的筛选。
    void load(routeKind, routeItem, client, projectId, "ALL");
    return () => { contextVersion.current++; readVersion.current++; };
  }, [client, connection.mode, projectId, routeKind, routeItem, routeSearch]);

  /**
   * 首屏搜索：失败就是首屏失败，走整页错误态。
   *
   * 首屏读不出来与「没有匹配」是两种事实：前者不能渲染成空态，后者才可以。
   */
  async function runSearch(version: number, searchQuery: string) {
    if (client === null || !live) return;
    setSearching(true);
    try {
      const page = await client.searchInformation({
        q: searchQuery, projectId, types: ["KNOWLEDGE", "MEMORY", "DECISION", "RULE"], limit: 20
      });
      if (version !== searchVersion.current) return;
      setSearchItems(appendSearchItems([], page.items));
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (version === searchVersion.current) {
        setSearchItems([]); setNextCursor(null); setSearchError(searchFailureMessage(caught));
      }
    } finally {
      if (version === searchVersion.current) setSearching(false);
    }
  }

  /**
   * 续页：按当前游标单独发一次请求。
   *
   * 失败只降级为局部错误——已核实的第一页与原游标留着，用户按同一游标重试即可；
   * 失权才清空全部结果。迟到的响应按版本隔离丢弃，不写回当前查询。
   */
  async function loadMore() {
    if (client === null || !live || nextCursor === null || searching || moreBusy.current) return;
    const version = searchVersion.current;
    const cursor = nextCursor;
    moreBusy.current = true;
    setLoadingMore(true); setMoreError(null);
    try {
      const page = await client.searchInformation({
        q: searchTerm.current, projectId, types: ["KNOWLEDGE", "MEMORY", "DECISION", "RULE"], limit: 20, cursor
      });
      if (version !== searchVersion.current) return;
      setSearchItems((current) => appendSearchItems(current, page.items));
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (version !== searchVersion.current) return;
      if (isAccessRevoked(caught)) {
        setSearchItems([]); setNextCursor(null); setMoreError(null); setSearchError(searchFailureMessage(caught));
        return;
      }
      setMoreError(describeLiveError(caught).message);
    } finally {
      if (version === searchVersion.current) { moreBusy.current = false; setLoadingMore(false); }
    }
  }

  useEffect(() => {
    const version = ++searchVersion.current;
    // 换关键词 / 换项目 / 换连接都从这里重置：旧结果不留、旧游标不留，旧请求的迟到响应也不写回。
    setSearchItems([]); setNextCursor(null); setSearchError(null); setMoreError(null);
    moreBusy.current = false; setLoadingMore(false);
    const trimmed = query.trim();
    searchTerm.current = trimmed;
    if (!live || trimmed === "") { setSearching(false); return; }
    if (trimmed.length > 200) { setSearchError("搜索词不能超过 200 个字符。"); setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(() => { void runSearch(version, trimmed); }, 250);
    return () => { clearTimeout(timer); searchVersion.current++; };
  }, [query, client, connection.mode, projectId]);

  function switchKind(next: RelayInformationKind) {
    if (pendingRef.current !== null || kind === next) return;
    const focusedTab = tabListRef.current?.contains(document.activeElement) ?? false;
    if (focusedTab && navigationState.current.dirty)
      tabListRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    requestDraftTransition(() => {
      if (focusedTab) focusKindAfterRead.current = next;
      setKind(next); setSelectedId(null); setSelected(null); setRows([]); setFormOpen(false);
      setActionError(null); setActionMessage(null); clearDraft();
      void load(next, null);
    });
  }

  function selectRow(idToSelect: string) {
    if (pendingRef.current !== null) return;
    requestDraftTransition(() => {
      setSelectedId(idToSelect); setFormOpen(false); setActionError(null);
      clearDraft();
      void load(kind, idToSelect);
    });
  }

  /**
   * 切换记忆的有效状态筛选：先清掉旧列表与选中项，再发一次真实查询。
   *
   * 旧结果由 `readVersion` 守卫丢弃；筛选不是本地过滤，也不改变任何命令状态。
   */
  function changeMemoryFilter(next: MemoryEffectiveFilter) {
    if (pendingRef.current !== null || kind !== "MEMORY" || next === memoryFilter) return;
    requestDraftTransition(() => {
      setMemoryFilter(next);
      setSelectedId(null); setSelected(null); setRows([]); setFormOpen(false);
      setKnowledgeVersions([]); setMemoryRevisions([]); setRuleVersions([]);
      setActionError(null); setActionMessage(null);
      clearDraft();
      void load(kind, null, client, projectId, next);
    });
  }

  function openSearchItem(item: RelaySearchItem) {
    if (pendingRef.current !== null) return;
    requestDraftTransition(() => {
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
    });
  }

  function openForm(asRevision: boolean) {
    if (pendingRef.current !== null) return;
    if (draftBaseline.current !== null && revisionMode === asRevision) { setFormOpen(true); return; }
    requestDraftTransition(() => {
      clearDraft(); setRevisionMode(asRevision); setFormOpen(true); setActionError(null);
      captureDraftBaseline.current = true;
      if (asRevision && kind === "KNOWLEDGE" && selectedKnowledge !== null)
        setKnowledgeDraftBase({ id: selectedKnowledge.id, revision: selectedKnowledge.revision,
          projectId: selectedKnowledge.projectId });
      if (asRevision && selectedMemory !== null) {
        setTitle(selectedMemory.title); setText(selectedMemory.text);
        // 原期限随修订回填（#33）：正文修订不得顺手撤销有效期；清空/续期必须是显式编辑。
        setMemoryExpiryOriginal(selectedMemory.expiresAt);
        setExpiresAt(selectedMemory.expiresAt === null ? "" : memoryExpiryInputValue(selectedMemory.expiresAt));
      }
      if (asRevision && selectedRule !== null) {
        setRuleKey(selectedRule.ruleKey); setStatement(selectedRule.statement);
        setStrength(selectedRule.strength); setEnforcement(selectedRule.enforcement);
        setMethod(selectedRule.method ?? ""); setTargetSpec(JSON.stringify(selectedRule.targetSpec, null, 2));
      }
    });
  }

  async function readArtifactVersion(sourceId: string) {
    if (client === null || !/^[0-9a-f-]{36}$/iu.test(sourceId)) {
      setArtifactPreviewError("请选择或填写有效的产物版本 ID。"); return;
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

  async function readArtifactPreview() {
    await readArtifactVersion(artifactVersionId.trim());
  }

  /** 选中候选即读正文：选择本身就是「这一次的确切版本」，不需要再点一次核对。 */
  function chooseArtifactVersion(versionId: string) {
    previewReadVersion.current++;
    setArtifactVersionId(versionId); setArtifactPreview(null);
    setArtifactPreviewError(null); setCaptureConfirmed(false);
    void readArtifactVersion(versionId);
  }

  /**
   * 候选只来自当前项目：服务端只允许把同项目产物提升为资料，列出别项目的版本等于先给一个必然失败的选项。
   *
   * 读取是分层的（项目 → 本项目任务 → 任务产物 → 版本），失败就如实说明并保留「按版本 ID 指定」，
   * 不把空结果写成「没有产物」。
   */
  async function loadArtifactsForTasks(tasks: readonly { readonly id: string; readonly title: string }[]) {
    if (client === null || tasks.length === 0) return;
    const context = contextVersion.current;
    const pending = tasks.filter((task) => !attemptedArtifactTasks.current.has(task.id));
    if (pending.length === 0) return;
    for (const task of pending) {
      attemptedArtifactTasks.current.add(task.id); pendingArtifactTasks.current.add(task.id);
    }
    setArtifactCandidates((current) => ({ ...current, status: "LOADING", error: null }));
    const results = await Promise.all(pending.map(async (task) => {
      try {
        return { task, artifacts: (await client.getTaskArtifacts(task.id)).items, error: null };
      } catch (caught) { return { task, artifacts: [], error: describeLiveError(caught).message }; }
    }));
    for (const task of pending) pendingArtifactTasks.current.delete(task.id);
    if (context !== contextVersion.current || liveContext.current.client !== client ||
      liveContext.current.projectId !== projectId) return;
    const additions = results.flatMap(({ task, artifacts, error: taskError }) => {
      if (taskError !== null) { failedArtifactTasks.current.add(task.id); return []; }
      return artifacts.filter((artifact) => artifact.latestVersionId !== null).flatMap((artifact) =>
        artifact.versions.filter((version) => version.mediaType === "text/markdown").map((version) => ({
          versionId: version.artifactVersionId, title: artifact.title,
          versionNumber: version.versionNumber, createdAt: version.createdAt, taskTitle: task.title
        })));
    });
    setArtifactCandidates((current) => {
      const byId = new Map(current.items.map((item) => [item.versionId, item]));
      for (const item of additions) byId.set(item.versionId, item);
      const items = [...byId.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return { status: "READY", items,
        error: failedArtifactTasks.current.size > 0 ? "部分任务的产物暂时无法读取。" : null };
    });
  }

  useEffect(() => {
    if (!artifactSourceActive || artifactCandidates.status !== "IDLE") return;
    if (projectId === null) setArtifactCandidates({ status: "ERROR", items: [],
      error: "产物版本只在项目资料范围内可收录；当前是工作空间资料，请到所属项目的资料页收录，或改用笔记/受管文本。" });
    else setArtifactCandidates({ status: "LOADING", items: [], error: null });
  }, [artifactSourceActive, artifactCandidates.status, projectId]);

  useEffect(() => {
    if (!artifactSourceActive || artifactCandidates.status === "IDLE") return;
    if (artifactTaskPages.scopeLost) {
      attemptedArtifactTasks.current.clear(); pendingArtifactTasks.current.clear(); failedArtifactTasks.current.clear();
      if (artifactCandidates.status !== "ERROR" || artifactCandidates.items.length > 0) {
        setArtifactCandidates({ status: "ERROR", items: [], error: "项目任务读取权限已失效；已清除受限产物候选。" });
      }
      return;
    }
    if (artifactTaskPages.error !== null && artifactTaskPages.items.length === 0) {
      if (artifactCandidates.status !== "ERROR" || artifactCandidates.error !== artifactTaskPages.error) {
        setArtifactCandidates({ status: "ERROR", items: [], error: artifactTaskPages.error });
      }
      return;
    }
    const pending = artifactTaskPages.items.filter((task) => !attemptedArtifactTasks.current.has(task.id));
    if (pending.length > 0) void loadArtifactsForTasks(pending);
    else if (pendingArtifactTasks.current.size === 0 &&
      artifactCandidates.status === "LOADING" && artifactTaskPages.loading === false) {
      setArtifactCandidates((current) => ({ ...current, status: "READY" }));
    }
  }, [artifactSourceActive, artifactCandidates.status, artifactTaskPages.items,
    artifactTaskPages.error, artifactTaskPages.scopeLost, artifactTaskPages.loading, client]);

  function retryArtifactReads() {
    for (const taskId of failedArtifactTasks.current) attemptedArtifactTasks.current.delete(taskId);
    failedArtifactTasks.current.clear();
    setArtifactCandidates((current) => ({ ...current, status: "LOADING", error: null }));
    void loadArtifactsForTasks(artifactTaskPages.items.filter((task) => !attemptedArtifactTasks.current.has(task.id)));
  }

  function retryArtifactTaskPage() {
    setArtifactCandidates((current) => ({ ...current, status: "LOADING", error: null }));
    artifactTaskPages.retry();
  }

  /**
   * 从产物入口直接带进来的确切版本（`?artifact_version=`）只预填来源并读一次正文，
   * 不替用户勾选「已核对」——确认仍然是人的动作。
   */
  useEffect(() => {
    const incoming = routeQuery.get("artifact_version");
    if (incoming === null || !/^[0-9a-f-]{36}$/iu.test(incoming) || kind !== "KNOWLEDGE") return;
    setRouteQuery((current) => { const next = new URLSearchParams(current); next.delete("artifact_version"); return next; });
    setSourceKind("ARTIFACT_VERSION"); setArtifactVersionId(incoming); setFormOpen(true);
    void readArtifactVersion(incoming);
    // 只在路由带入时执行一次：参数随后被清掉，不会因重渲染重复读取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeQuery, kind]);

  /**
   * 统一提交入口：守卫 → 项目可写核对 → 发命令 → 核对回执 → 定向重读。
   *
   * 返回值只为本片（撤销条 / 永久恢复）增补：其余调用者照旧忽略它，副作用与失败文案不变。
   * 回执里的修订是本片唯一可用的事实——它比列表里那一行新，撤销必须拿它当基线。
   */
  async function submit(
    commandType: string, resultKey: string, targetId: string | null,
    send: (api: RelayApiClient, commandId: string) => Promise<RelayCommandEnvelope>,
    replacement: string | null = null,
    /** 表单类命令成功后收起输入区；生命周期按钮不碰用户的草稿。 */
    resetComposer = true
  ): Promise<SubmitOutcome | null> {
    if (client === null || submitting || pendingRef.current !== null) return null;
    const target = targetId !== null
      ? selected?.id === targetId ? rowTarget(selected) : undefined
      : commandType === "CreateRule" ? newTarget() : projectId ? { kind: "PROJECT" as const, id: projectId } : null;
    if (target === undefined) { setActionError("资料目标已变化，请重新读取后再提交。"); return null; }
    const command: PendingCommand = { id: createCommandId(), commandType, resultKey, targetId,
      replacementId: replacement, resetComposer };
    const context = contextVersion.current;
    pendingRef.current = command; setPendingCommand(command); setSubmitting(true);
    setActionError(null); setActionMessage(null);
    let sent = false;
    try {
      await confirmWritable(client, target);
      if (context !== contextVersion.current) return null;
      sent = true;
      const envelope = await send(client, command.id);
      const confirmed = envelope.commandId === command.id ? confirmedResult(envelope.result, command) : null;
      if (confirmed === null) throw new RelayTransportError("命令回执无法核对。");
      pendingRef.current = null;
      if (context !== contextVersion.current) {
        // 结果已核对但视图已切走：不改当前范围，只把回执交回调用方（撤销仍绑定原对象）。
        setPendingCommand(null);
        return { kind: "CONFIRMED", ...confirmed };
      }
      setPendingCommand(null); setSelectedId(confirmed.id);
      if (command.resetComposer) {
        setActionMessage("命令已提交；正在读取服务端最新资料。"); setFormOpen(false); clearDraft();
      }
      await load(kind, confirmed.id, client, projectId, memoryFilter, true);
      return { kind: "CONFIRMED", ...confirmed };
    } catch (caught) {
      if (context !== contextVersion.current) return null;
      if (!sent) {
        pendingRef.current = null; setPendingCommand(null);
        setActionError(`关联 Project 状态未确认，命令尚未提交：${describeLiveError(caught).message}`);
        setGateReload((value) => value + 1);
        return { kind: "REJECTED", error: caught };
      }
      // 结果不能由浏览器判定时（传输失败、5xx、retry_action 要求核对回执，契约 §7 错误表）
      // 保留原命令与草稿，只按原 command_id 核对回执；服务端明确业务拒绝（422、409 等）才释放，
      // 允许修正后换新命令。503 被当成拒绝换新 ID 是禅道 #32（DEV-0128）的根因。
      if (needsReceiptCheck(caught)) {
        setActionError(caught instanceof RelayTransportError
          ? "响应丢失或无法核对。请只查询原 command_id 回执，不要换 ID 再提交。"
          : `服务端暂时无法确认本次提交结果：${describeLiveError(caught).message}原命令与草稿已保留；请查询原 command_id 回执，不要换 ID 再提交。`);
        return { kind: "UNCERTAIN" };
      }
      pendingRef.current = null; setPendingCommand(null);
      setActionError(describeLiveError(caught).message);
      return { kind: "REJECTED", error: caught };
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
      // 未编辑的期限按原 ISO 原样提交（#33）：datetime-local 只有本机墙钟精度，
      // 重新换算会无声截秒或换时刻；清空与改值都是显式编辑，才允许改变有效期。
      const expiryPrefill = memoryExpiryOriginal === null ? "" : memoryExpiryInputValue(memoryExpiryOriginal);
      const expiryInput = expiresAt.trim();
      if (expiryInput !== expiryPrefill && expiryInput !== "" && Number.isNaN(Date.parse(expiryInput))) {
        setActionError("到期时间须为有效日期时间。"); return;
      }
      const expires = expiryInput === expiryPrefill ? memoryExpiryOriginal
        : expiryInput === "" ? null : new Date(expiryInput).toISOString();
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
      // 规则键是服务端身份而不是用户输入项：留空时由服务端按 command_id 生成稳定唯一键。
      if (!statement.trim()) { setActionError("请写下这条规则的内容。"); return; }
      let spec: Record<string, unknown> | undefined;
      if (targetSpec.trim()) {
        try {
          const parsed: unknown = JSON.parse(targetSpec);
          if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
          spec = parsed as Record<string, unknown>;
        } catch { setActionError("目标约束须是 JSON 对象。"); return; }
      }
      const config = { statement: statement.trim(), strength, enforcement,
        ...(method.trim() ? { method: method.trim() } : {}), ...(spec === undefined ? {} : { targetSpec: spec }) };
      if (revisionMode && itemId !== null && revision !== undefined) {
        await submit("AddRuleVersion", "rule_id", itemId, (api, commandId) =>
          api.addRuleVersion({ id: itemId, commandId, expectedRevision: revision,
            ruleKey: ruleKey.trim(), ...config }));
      } else {
        if (client === null) return;
        const resolvedScopeId = scope === "WORKSPACE" ? client.workspaceId
          : scope === "PROJECT" && projectId !== null ? projectId : scopeId.trim();
        if (!resolvedScopeId) { setActionError("请填写规则作用域 ID。"); return; }
        const submittedKey = ruleKey.trim();
        await submit("CreateRule", "rule_id", null, (api, commandId) => submittedKey === ""
          ? api.createRule({ commandId, scope, scopeId: resolvedScopeId, ...config })
          : api.createRule({ commandId, scope, scopeId: resolvedScopeId, ruleKey: submittedKey, ...config }));
      }
    }
  }

  /**
   * 归档资料 / 停用记忆 / 停用规则：单击即发，成功后才给撤销条（工作台 §13.2）。
   *
   * 撤销条要绑定的不是「之后可能变化的 selected」，而是这一刻的 API、类型、对象与回执修订；
   * 回调把它们全部捕获，所以切类型、切范围甚至切 Workspace 之后按撤销仍落到原对象上。
   * 正向回执不明（`UNCERTAIN`）时什么都不给，就地保留「无法核对」与原 command_id 入口。
   */
  async function retire() {
    if (selected === null || client === null) return;
    const item = selected;
    const activeClient = client;
    const activeKind = kind;
    const activeProject = projectId;
    const commandType = activeKind === "KNOWLEDGE" ? "ArchiveKnowledge" : activeKind === "MEMORY" ? "RetireMemory" : "RetireRule";
    const resultKey = activeKind === "KNOWLEDGE" ? "knowledge_id" : activeKind === "MEMORY" ? "memory_id" : "rule_id";
    const label = activeKind === "KNOWLEDGE" ? "已归档资料" : activeKind === "MEMORY" ? "已停用记忆" : "已停用规则";
    const outcome = await submit(commandType, resultKey, item.id, (api, commandId) =>
      activeKind === "KNOWLEDGE" ? api.archiveKnowledge(item.id, commandId, item.revision)
        : activeKind === "MEMORY" ? api.retireMemory(item.id, commandId, item.revision)
          : api.retireRule(item.id, commandId, item.revision));
    if (outcome === null || outcome.kind !== "CONFIRMED") return;
    const key = `information-lifecycle:${activeKind}:${item.id}`;
    const testId = `information-undo-${item.id}`;
    openUndoFeedback(key, {
      text: `${label}「${rowTitle(item)}」`, actionLabel: "撤销", testId,
      // 撤销是**新的**命令，修订取正向回执推进后的那一版，不读列表里可能还没刷新的行。
      onUndo: () => { void undoLifecycle(activeClient, activeKind, item.id, outcome.revision, activeProject, key, testId); }
    });
  }

  /**
   * 撤销归档/停用：再发一条前向补偿命令（新 command_id + 正向回执修订）。
   *
   * 撤销失败不悄悄消失：同一条浮层升级为停留到关闭的 Notice，并指向仍然可用的永久入口
   * ——列表本来就保留非活动项，详情里的「恢复」按钮不依赖这条浮层。
   */
  async function undoLifecycle(
    api: RelayApiClient, targetKind: RelayInformationKind, id: string, revision: string,
    targetProject: string | null, key: string, testId: string
  ) {
    const noun = targetKind === "KNOWLEDGE" ? "资料" : targetKind === "MEMORY" ? "记忆" : "规则";
    try {
      if (targetKind === "KNOWLEDGE") await api.unarchiveKnowledge(id, createCommandId(), revision);
      else if (targetKind === "MEMORY") await api.reactivateMemory(id, createCommandId(), revision);
      else await api.reactivateRule(id, createCommandId(), revision);
      // 迟到的成功只刷新原 API、原类型、原范围；视图已切走时不动当前列表。
      const current = liveContext.current;
      if (current.client === api && current.kind === targetKind && current.projectId === targetProject)
        await load(targetKind, id, api, targetProject, memoryFilterRef.current, true);
    } catch (caught) {
      const described = describeLiveError(caught);
      escalateFeedback(key, { testId, text: described.kind === "conflict"
        ? `撤销没成功：这条${noun}刚被别处改过。列表里仍能找到它，打开详情可以再次恢复。`
        : `撤销没成功：${described.message}列表里仍能找到它，打开详情可以再次恢复。` });
    }
  }

  /**
   * 永久恢复入口：撤销条过期后仍可用（已归档/已停用的对象本来就在列表里）。
   *
   * 修订**当次读回**——撤销条消失时列表那一行可能已经放了几分钟；冲突时不自动覆盖，
   * 先重读事实并要求用户对着新修订重新决定。归档 Project 等限制仍走既有写入守卫。
   */
  async function restoreRetired() {
    if (client === null || selected === null || restoring || submitting || pendingRef.current !== null) return;
    if (loading || refreshing || writeBlockedReason !== null) return;
    const item = selected;
    const activeClient = client;
    const activeKind = kind;
    const retiredStatus = retiredStatusOf(activeKind);
    if (retiredStatus === null || item.status !== retiredStatus) return;
    const copy = restoreCopy[activeKind as "KNOWLEDGE" | "MEMORY" | "RULE"];
    const context = contextVersion.current;
    const commandType = activeKind === "KNOWLEDGE" ? "UnarchiveKnowledge" : activeKind === "MEMORY" ? "ReactivateMemory" : "ReactivateRule";
    const resultKey = activeKind === "KNOWLEDGE" ? "knowledge_id" : activeKind === "MEMORY" ? "memory_id" : "rule_id";
    setActionError(null); setActionMessage(null); setRestoring(true);
    try {
      const fresh = activeKind === "KNOWLEDGE" ? await activeClient.getKnowledgeDetail(item.id)
        : activeKind === "MEMORY" ? await activeClient.getMemory(item.id) : await activeClient.getRule(item.id);
      if (context !== contextVersion.current) return;
      if (fresh.id !== item.id) { setActionError("恢复目标与当前详情不一致，请重新读取后再试。"); return; }
      if (fresh.status === "ACTIVE") {
        setActionMessage("服务端显示这条内容已经是有效状态；已重新读取最新事实。");
        await load(activeKind, item.id, activeClient, projectId, memoryFilter, true);
        return;
      }
      if (fresh.status !== retiredStatus) {
        setActionError(`当前状态（${fresh.status}）不能通过恢复入口改回有效；已重新读取事实，请核对后再决定。`);
        await load(activeKind, item.id, activeClient, projectId, memoryFilter, true);
        return;
      }
      const outcome = await submit(commandType, resultKey, item.id, (api, commandId) =>
        activeKind === "KNOWLEDGE" ? api.unarchiveKnowledge(item.id, commandId, fresh.revision)
          : activeKind === "MEMORY" ? api.reactivateMemory(item.id, commandId, fresh.revision)
            : api.reactivateRule(item.id, commandId, fresh.revision), null, false);
      if (outcome === null || context !== contextVersion.current) return;
      if (outcome.kind === "CONFIRMED") { setActionMessage(copy.done); return; }
      if (outcome.kind === "REJECTED" && describeLiveError(outcome.error).kind === "conflict") {
        // 冲突：刷新事实、保留用户的判断权，不自动改用新修订重发。
        setActionError("这条内容刚被别处改过；已重新读取最新修订，请核对后决定是否再次恢复。");
        await load(activeKind, item.id, activeClient, projectId, memoryFilter, true);
      }
    } catch (caught) {
      if (context === contextVersion.current) setActionError(describeLiveError(caught).message);
    } finally {
      if (context === contextVersion.current) setRestoring(false);
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
      const confirmed = receipt.commandId === pending.id && receipt.commandType === pending.commandType
        ? confirmedResult(receipt.result, pending) : null;
      if (confirmed === null) {
        setActionError("原命令回执类型或目标不匹配，结果仍未确定。请保留 command_id 核对。"); return;
      }
      pendingRef.current = null; setPendingCommand(null); setSelectedId(confirmed.id); setActionError(null);
      setActionMessage("已核对原命令回执；正在读取最新资料。");
      // 收尾语义与直接成功一致（#109）：生命周期恢复只收口 pending 与对象状态，
      // 不清未参与本次命令的新建草稿；表单类命令的确认成功仍按原语义收起草稿。
      if (pending.resetComposer) { setFormOpen(false); clearDraft(); }
      await load(kind, confirmed.id, client, projectId, memoryFilter, true);
    } catch (caught) {
      if (context !== contextVersion.current) return;
      setActionError(caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND"
        ? "暂未找到原命令回执。请稍后仍用同一个 command_id 核对。"
        : describeLiveError(caught).message);
    } finally {
      if (context === contextVersion.current) setSubmitting(false);
    }
  }

  const reading = selectedKnowledge !== null && client !== null;
  useEffect(() => {
    if (focusKindAfterRead.current !== kind) return;
    if (document.activeElement !== document.body && !tabListRef.current?.contains(document.activeElement)) {
      focusKindAfterRead.current = null; return;
    }
    if (reading && libraryRef.current) libraryRef.current.open = true;
    tabListRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    if (!loading && !refreshing) focusKindAfterRead.current = null;
  }, [kind, reading, loading, refreshing]);
  const capturing = formOpen && kind === "KNOWLEDGE";
  /**
   * 收录仪式只属于「把确切产物版本提升为资料」（工作台 §42.1）。
   *
   * 普通笔记与追加正文没有来源可对照：把它们也套上「人工收录草稿／本次收录内容／
   * 对照来源／收录设置／保存前核对」，等于让用户先学会一套收录术语才能写一句话。
   * 因此这里按来源分叉，NOTE／MANAGED_TEXT 走普通表单，ARTIFACT_VERSION 才展开全套核对。
   */
  const captureCeremony = capturing && sourceKind === "ARTIFACT_VERSION";
  const captureProjectId = revisionMode ? knowledgeDraftBase?.projectId : projectId;
  const captureTargetLabel = revisionMode && knowledgeDraftBase === null ? "修订目标待重新核对"
    : captureProjectId ? `项目 ${captureProjectId}` : "工作空间";
  const artifactPreviewMatches = artifactPreview !== null && artifactPreview.id === artifactVersionId.trim();
  const selectedRuleSpec = selectedRule ? ruleTargetSpecView(selectedRule.targetSpec) : null;
  /**
   * 永久恢复入口的显示条件：只有资料归档、记忆/规则停用这三种状态有反向命令。
   * 列表本来就保留非活动项，所以撤销条过期后这条路径仍然可达，不需要另建管理页。
   */
  const retiredStatus = retiredStatusOf(kind);
  const restoreEntry = selected !== null && retiredStatus !== null && selected.status === retiredStatus
    ? restoreCopy[kind as "KNOWLEDGE" | "MEMORY" | "RULE"] : null;
  const writeGateFeedback = writeBlockedReason && <p className="disabled-reason" data-testid="knowledge-project-write-blocked">{writeBlockedReason} <button type="button" className="text-button" onClick={() => setGateReload((value) => value + 1)}>重读项目状态</button></p>;
  const pendingReceipt = pendingCommand && <div className="surface-panel" data-testid="knowledge-pending-receipt">
    <h2>提交结果待核对</h2><p>原 command_id：{pendingCommand.id}。查询原命令回执前不再次提交。</p>
    <button type="button" className="secondary-button" data-testid="knowledge-check-receipt" disabled={submitting} onClick={() => { void checkReceipt(); }}>核对原命令回执</button>
  </div>;
  const saveLabel = submitting ? "正在提交"
    : captureCeremony ? (revisionMode ? "确认收录新版本" : "确认收录")
      : capturing ? (revisionMode ? "保存新版本" : "保存资料")
        : `保存${revisionMode ? "新版本" : ""}`;
  /**
   * 来源控件只有一份：普通表单把它收进「来源与收录设置」，产物收录把它摊在「对照来源」里。
   * 两处共用同一批状态与 testid，避免出现两套来源语义。
   */
  const artifactCandidatesBlock = <>
    {artifactCandidates.status === "LOADING" && artifactCandidates.items.length === 0 &&
      <p className="helper-text" role="status" data-testid="knowledge-artifact-loading">正在读取已加载任务的 Markdown 产物版本…</p>}
    {artifactCandidates.status === "ERROR" && <div className="helper-text" data-testid="knowledge-artifact-candidates-error" role="alert">
      {artifactCandidates.error}仍可在下面按版本 ID 指定。
      {artifactTaskPages.error !== null && <button type="button" className="text-button"
        onClick={retryArtifactTaskPage}>重试读取任务</button>}
    </div>}
    {artifactCandidates.items.length === 0 && artifactCandidates.status === "READY" &&
      <p className="helper-text" data-testid="knowledge-artifact-candidates-empty">
        {artifactTaskPages.nextCursor !== null ? `已读取 ${artifactTaskPages.items.length} 项任务，当前页没有可收录的 Markdown 产物；后续任务尚未读取。`
          : "已读取的项目任务中暂时没有可收录的 Markdown 产物版本。"}下面仍可按确切版本 ID 核对，也可以改用笔记。
      </p>}
    {artifactCandidates.items.length > 0 && <ul className="knowledge-artifact-candidates" data-testid="knowledge-artifact-candidates" aria-label="已加载任务的可收录产物版本">
      {artifactCandidates.items.map((candidate) => <li key={candidate.versionId}>
        <button type="button" className={`knowledge-artifact-candidate${candidate.versionId === artifactVersionId.trim() ? " knowledge-artifact-candidate--selected" : ""}`}
          aria-pressed={candidate.versionId === artifactVersionId.trim()} disabled={pendingCommand !== null}
          data-testid={`knowledge-artifact-candidate-${candidate.versionId}`}
          onClick={() => chooseArtifactVersion(candidate.versionId)}>
          <strong>{candidate.title}</strong>
          <small>v{candidate.versionNumber} · {candidate.taskTitle}</small>
          <small>{candidate.createdAt}</small>
        </button></li>)}
    </ul>}
    {artifactCandidates.error !== null && artifactCandidates.status !== "ERROR" && <div className="action-error" role="alert">
      {artifactCandidates.error}已保留已读取候选。
      <button type="button" className="text-button" onClick={retryArtifactReads}>重试读取失败任务</button>
    </div>}
    {artifactTaskPages.error !== null && artifactCandidates.status !== "ERROR" && <div className="action-error" role="alert">
      已保留已加载产物候选与原任务游标。{artifactTaskPages.error}
      <button type="button" className="text-button" disabled={artifactTaskPages.loading || artifactTaskPages.loadingMore}
        onClick={retryArtifactTaskPage}>重试读取任务页</button>
    </div>}
    {artifactTaskPages.loadingMore && <p className="helper-text" role="status">正在读取下一批项目任务及其产物…</p>}
    {artifactTaskPages.nextCursor !== null && <p className="helper-text">
      已读取 {artifactTaskPages.items.length} 项项目任务；当前候选只覆盖这些已加载任务。
      <button type="button" className="text-button" disabled={artifactTaskPages.loadingMore}
        onClick={artifactTaskPages.loadMore}>加载更多任务</button>
    </p>}
    {artifactCandidates.status === "LOADING" && artifactCandidates.items.length > 0 &&
      <p className="helper-text" role="status">正在补充已加载任务的产物；已读候选仍可选。</p>}
  </>;
  const sourceControls = <>
    <label className="field"><span className="field-label">来源类型</span><select value={sourceKind} data-testid="knowledge-source-kind" onChange={(event) => { previewReadVersion.current++; setSourceKind(event.target.value as Exclude<RelayKnowledgeSource, "WEB_PAGE">); setArtifactPreview(null); setCaptureConfirmed(false); if (event.target.value === "NOTE") setMediaType("text/plain"); }} disabled={pendingCommand !== null}>
      <option value="NOTE">笔记（NOTE）</option><option value="MANAGED_TEXT">受管文本（MANAGED_TEXT）</option><option value="ARTIFACT_VERSION">产物版本（ARTIFACT_VERSION）</option></select></label>
    {sourceKind === "ARTIFACT_VERSION" ? <>
      {artifactCandidatesBlock}
      <details className="knowledge-artifact-manual">
        <summary>按版本 ID 指定</summary>
        <label className="field"><span className="field-label">产物版本 ID</span>
          <input value={artifactVersionId} onChange={(event) => { previewReadVersion.current++; setArtifactVersionId(event.target.value); setArtifactPreview(null); setCaptureConfirmed(false); }} data-testid="knowledge-artifact-id" disabled={pendingCommand !== null} /></label>
        <button type="button" className="secondary-button" data-testid="knowledge-read-artifact" disabled={pendingCommand !== null}
          onClick={() => { void readArtifactPreview(); }}>核对确切产物版本</button>
      </details>
      {artifactPreviewError && <p className="action-error" role="alert">{artifactPreviewError}</p>}
      <p className="helper-text" data-testid="knowledge-artifact-status">{artifactPreviewMatches ? "已读取此确切版本正文，请在本页核对。" : "当前来源正文尚未核对；选中或输入版本 ID 不代表已读取。"}</p>
    </> : <><p className="helper-text">{sourceKind === "NOTE" ? "本次手动输入的笔记，未关联外部原件。" : "本次手动输入的受管文本，按所选媒体类型保存。"}</p>
      <label className="field"><span className="field-label">媒体类型</span><select value={mediaType} onChange={(event) => setMediaType(event.target.value)} data-testid="knowledge-media-type" disabled={pendingCommand !== null}>
        <option value="text/plain">text/plain</option>{sourceKind === "MANAGED_TEXT" && <option value="text/markdown">text/markdown</option>}</select></label></>}
  </>;
  const saveActions = <div className="knowledge-actions"><button type="submit" className="primary-button" data-testid="knowledge-save" disabled={submitting || pendingCommand !== null || writeBlockedReason !== null || (kind === "MEMORY" && !confirmed) || (captureCeremony && (!artifactPreviewMatches || !captureConfirmed))}>{saveLabel}</button>
    <button type="button" className="secondary-button" data-testid="knowledge-capture-cancel" disabled={pendingCommand !== null} onClick={() => setFormOpen(false)}>{captureCeremony ? "暂不收录" : "取消"}</button></div>;
  const library = <section className="surface-panel knowledge-list">
    {reading && projectId && <ProjectNav projectId={projectId} active="knowledge" />}
    <nav ref={tabListRef} className="knowledge-tabs" role="tablist" aria-label="资料类型" onKeyDown={handleTabListKeyDown}>{kinds.map((item) =>
      <button key={item.kind} type="button" className={`subnav-item${kind === item.kind ? " subnav-item--active" : ""}`}
        role="tab" id={`${tabId}-tab-${item.kind}`} aria-controls={`${tabId}-panel`} aria-selected={kind === item.kind}
        tabIndex={kind === item.kind ? 0 : -1} disabled={pendingCommand !== null}
        data-testid={`knowledge-tab-${item.kind}`} onClick={() => switchKind(item.kind)}>{item.label}</button>)}</nav>
    <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-tab-${kind}`} tabIndex={0}>
    <div className="section-heading-row"><h2>{currentNoun}</h2>
      <button type="button" className="secondary-button" data-testid="knowledge-create" disabled={pendingCommand !== null} onClick={() => openForm(false)}>新建</button></div>
    {/* 有效状态筛选只作用于记忆，由服务端按数据库时间裁决；不新增一级导航，也不本地过滤。 */}
    {kind === "MEMORY" && <div className="knowledge-memory-filter">
      <div className="segmented" role="group" aria-label="按有效状态筛选记忆">{memoryFilterOptions.map((option) =>
        <button key={option.value} type="button"
          className={`segmented-option${memoryFilter === option.value ? " segmented-option--selected" : ""}`}
          aria-pressed={memoryFilter === option.value} disabled={pendingCommand !== null}
          data-testid={`knowledge-memory-filter-${option.value}`}
          onClick={() => changeMemoryFilter(option.value)}>{option.label}</button>)}</div>
      <p className="helper-text">状态由服务端按数据库时间判定；「有效」只表示未停用且未到期，不保证进入模型 Context。</p>
    </div>}
    {/* 读取失败不能呈现为「还没有」：同一文件的详情空态已有正确的 error 分支（见下方
        data-testid="knowledge-detail-empty-state"），列表这里此前缺失，会把失败说成没有数据。 */}
    {/* 列表空态按共享规格区分三种事实：首装无资料、项目范围为空、筛选无匹配、读取失败（见下方 error 分支）不互相冒充。 */}
    {!loading && error === null && rows.length === 0 && (kind === "MEMORY" && memoryFilter !== "ALL"
      ? <EmptyState size="compact" testId="knowledge-memory-filter-empty"
        title={`当前筛选没有${memoryFilterLabel(memoryFilter)}的记忆`}
        description={`筛选由服务端按数据库时间判定，「${memoryFilterLabel(memoryFilter)}」下没有命中不代表工作空间没有记忆。切换「全部」可查看所有记忆。`}
        actions={<button type="button" className="secondary-button" data-testid="knowledge-memory-filter-clear"
          onClick={() => changeMemoryFilter("ALL")}>查看全部记忆</button>} />
      : projectId
        ? <EmptyState size="compact" testId="knowledge-list-empty" title={`当前项目还没有${currentNoun}`}
          description={`项目范围只显示归属当前项目的${currentNoun}，工作空间范围的${currentNoun}不会出现在这里。可以点「新建」添加第一条，或到工作空间资料查看已有内容。`} />
        : <EmptyState size="compact" testId="knowledge-list-empty" title={`还没有${currentNoun}`}
          description={`当前工作空间还没有收录${currentNoun}。${currentNoun}用来沉淀跨任务长期有效的事实与约定；点击「新建」添加第一条，保存后才会出现在这里。`} />)}
    {!loading && error !== null && rows.length === 0 && <p className="helper-text" role="status">当前范围的{currentNoun}没有读到，请查看上方错误并重试；这不代表当前范围确实没有{currentNoun}。</p>}
    {rows.map((row) => <button key={row.id} type="button" className={`knowledge-row${row.id === selectedId ? " knowledge-row--active" : ""}`}
      disabled={pendingCommand !== null} onClick={() => selectRow(row.id)}><strong>{rowTitle(row)}</strong><small>{kind === "MEMORY"
        ? memoryRowSummary(row as RelayMemory)
        : `${statusLabel(row.status)} · 当前 v${row.currentVersion} · ${rowScopeLabel(row)}`}</small></button>)}
    </div>
  </section>;

  return <section className={`knowledge-page pv-page${reading ? " knowledge-page--reading" : ""}${capturing ? " knowledge-page--capture" : ""}`}>
    {!reading && !capturing && <><PageHeader testId="knowledge-page-head" title="资料" overline="Knowledge"
      meta={projectId ? "项目资料" : "工作空间资料"} lede="按资料、记忆、决定、规则组织内容，并保留项目归属和来源范围。" />
    {projectId && <ProjectNav projectId={projectId} active="knowledge" />}</>}

    {!live ? <section className="surface-panel" data-testid="knowledge-fixture-gap">
      <h2>示例模式未接入资料</h2>
      <p>此处不生成虚构的资料、记忆、决定或规则。连接本机 API 后可读取和管理真实内容。</p>
    </section> : <>
      <div className="knowledge-tools" hidden={capturing}>
      <details className="knowledge-search" open={query.trim() !== ""}>
        <summary>搜索资料</summary>
      <section className="surface-panel" aria-label="资料搜索">
        <label className="field" htmlFor="knowledge-search"><span className="field-label">搜索词</span>
          <span className="field-hint">按当前范围搜索四类资料，支持中文短词；每页最多 20 条。</span>
          <input id="knowledge-search" value={query} onChange={(event) => setQuery(event.target.value)} data-testid="knowledge-search" type="search" maxLength={200} autoComplete="off" />
        </label>
        {searching && <p role="status">正在搜索…</p>}
        {searchError && <p className="action-error" role="alert" data-testid="knowledge-search-error">{searchError}</p>}
        {/* 续页失败与「没有匹配」是两种状态：局部错误贴着已有结果说，不改写已核实的第一页。 */}
        {moreError && <p className="action-error" role="alert" data-testid="knowledge-search-more-error">续页失败：{moreError}；已保留前面加载的结果，可按同一游标重试。</p>}
        {searchItems.length > 0 ? <ul className="knowledge-search-list">{searchItems.map((item) =>
          <li key={`${item.type}-${item.id}-${item.version}`}><button type="button" className="knowledge-result" disabled={pendingCommand !== null} onClick={() => openSearchItem(item)}>
            <strong>{item.title}</strong> · {kinds.find((k) => k.kind === item.type)?.noun ?? item.type} v{item.version} · {statusLabel(item.status)}
            <span>{item.snippet}</span><small>匹配：{item.matchedFields.join("、")} · 来源 <code className="hash-code">{item.sourceRef}</code></small>
          </button></li>)}</ul> : query.trim() && !searching && !searchError && <p className="helper-text" data-testid="knowledge-search-empty">没有匹配「{query.trim()}」的当前有效资料。试试更短的关键词或切换资料类型；这只说明搜索没有结果，不代表当前范围没有{currentNoun}。</p>}
        {nextCursor && <button type="button" className="secondary-button" data-testid="knowledge-more" disabled={searching || loadingMore}
          onClick={() => { void loadMore(); }}>{loadingMore ? "正在加载下一页" : moreError ? "重试加载下一页" : "加载下一页"}</button>}
      </section>
      </details>

      {reading && <details ref={libraryRef} className="knowledge-library" data-testid="knowledge-library">
        <summary>资料列表 · {rows.length}</summary>{library}
      </details>}

      {projectId && client && kind === "KNOWLEDGE" && <details className="knowledge-web-import"><summary>导入网页</summary><WebImportPanel
        key={`${connection.epoch}:${projectId}`} client={client} projectId={projectId}
        onOpenKnowledge={(knowledgeId) => {
          requestDraftTransition(() => {
              setSelectedId(knowledgeId); setFormOpen(false); setActionError(null);
              clearDraft();
              void load("KNOWLEDGE", knowledgeId);
          });
        }} /></details>}

      {projectId && client && <button type="button" className="text-button" data-testid="knowledge-guide-toggle"
        onClick={() => setGuideOpen((value) => !value)}>{guideOpen ? "关闭项目导读" : "打开项目导读"}</button>}
      </div>
      {guideOpen && projectId && client && <ProjectKnowledgeGuide key={`${connection.epoch}:${projectId}`}
        client={client} projectId={projectId} onOpen={(nextKind, nextId) => {
          requestDraftTransition(() => {
              setGuideOpen(false); setKind(nextKind); setSelectedId(nextId); setSelected(null);
              setFormOpen(false); clearDraft();
              void load(nextKind, nextId);
          });
        }} />}

      {error && <p className="action-error" role="alert" data-testid="knowledge-read-error">{error} <button type="button" className="text-button" onClick={() => { void load(); }}>重新读取</button></p>}
      {loading && <p role="status">正在读取资料…</p>}
      {refreshing && <p role="status">正在读取最新版本…</p>}
      {actionError && !capturing && <p className="action-error" role="alert" data-testid="knowledge-action-error">{actionError}</p>}
      {actionMessage && <p className="receipt-message" role="status">{actionMessage}</p>}
      {!capturing && writeGateFeedback}
      {!capturing && pendingReceipt}

      <div className="knowledge-columns">
        {!reading && library}

        <div className="knowledge-detail">
          {selected ? <section className={`surface-panel${reading ? " knowledge-reading-detail" : ""}`} hidden={capturing}>
            {selectedKnowledge && client && <KnowledgeReader key={`${selectedKnowledge.id}:${selectedKnowledge.currentVersion}:${routeItem === selectedKnowledge.id ? routeVersion ?? "" : ""}`}
              client={client} knowledge={selectedKnowledge} versions={knowledgeVersions}
              initialVersion={routeItem === selectedKnowledge.id ? routeVersion : null}
              onNewVersion={selected.status === "ACTIVE" && pendingCommand === null ? () => openForm(true) : undefined}
              newVersionDisabled={writeBlockedReason !== null} />}
            {!reading && <header className="knowledge-item-heading"><div><h2>{rowTitle(selected)}</h2><p className="helper-text">当前版本 v{selected.currentVersion} · {selectedMemory ? memoryStatusText(selectedMemory) : statusLabel(selected.status)}</p></div>
              {selected.status === "ACTIVE" && pendingCommand === null && kind !== "DECISION" && <button type="button" className="secondary-button" data-testid="knowledge-new-version" disabled={writeBlockedReason !== null} onClick={() => openForm(true)}>追加新版本</button>}</header>}
            {selectedMemory && <article className="knowledge-fact-paper"><p className="knowledge-body">{selectedMemory.text}</p><p className="helper-text">明确确认：{selectedMemory.confirmedBy} · {selectedMemory.confirmedAt} · {selectedMemory.expiresAt === null ? "无到期时间" : `到期 ${selectedMemory.expiresAt}`}</p></article>}
            {/* ADR-030：自动记住的记忆不能显示成人工确认。撤销就用既有的「停用记忆」。 */}
            {selectedMemory?.origin === "AUTO_CAPTURE" && <p className="helper-text" data-testid="memory-auto-capture-note">
              这条是对话结算后自动提取的（确认方：auto-capture），不是你手动确认的事实。来源类别：
              {memorySourceKindLabel(selectedMemory.sourceKind)}
              {selectedMemory.sourceKind === "MODEL_OBSERVATION"
                ? "——模型叙述的观察，可能含工具结果或网页正文的转述，不能当成你的偏好或授权。"
                : selectedMemory.sourceKind === "USER_STATEMENT"
                  ? "——引用的是你自己说过的话。"
                  : ""}它照常参与召回，
              但不代表正确；发现不对就停用，停用后同一内容不会再被自动写入。</p>}
            {/* 保存来源（HTTP §10.99）：只在展开时读；手工创建的记忆来源为空是事实，不是读取失败。 */}
            {selectedMemory && client && <MemoryProvenancePanel client={client} memoryId={selectedMemory.id} />}
            {/* 过期是投影不是新状态：续期/取消到期只能走既有修订并明确确认，不静默延长。 */}
            {selectedMemory && selectedMemory.effectiveStatus === "EXPIRED" && <section className="knowledge-expired" data-testid="memory-expired-hint">
              <p className="helper-text">这条记忆已过有效期。恢复状态不会延长有效期；要续期或取消到期，请追加新版本并明确确认，产生新的确认版本。</p>
              {selectedMemory.status === "ACTIVE" && pendingCommand === null && <div className="knowledge-actions">
                <button type="button" className="secondary-button" data-testid="memory-renew" disabled={writeBlockedReason !== null}
                  onClick={() => openForm(true)}>去追加新版本</button></div>}
            </section>}
            {selectedDecision && <article className="knowledge-fact-paper"><h3>做出的选择</h3><p className="knowledge-body">{selectedDecision.choice}</p><h3>依据</h3><p className="knowledge-body">{selectedDecision.rationale}</p><h3>备选与代价</h3><p>备选：{selectedDecision.alternatives.join("、") || "未记录"}</p><p>代价：{selectedDecision.costs.join("、") || "未记录"}</p>{selectedDecision.supersededById && <p data-testid="decision-supersession">已由决定 {selectedDecision.supersededById} 替代；旧决定保留可查。</p>}</article>}
            {selectedRule && <article className="knowledge-fact-paper"><p className="knowledge-body">{selectedRule.statement}</p><p>{selectedRule.strength === "HARD" ? "硬约束" : "偏好"} · 执行检查：{selectedRule.enforcement}{selectedRule.method && <> · {selectedRule.method}</>}</p></article>}
            {restoreEntry && <section className="knowledge-restore" data-testid="knowledge-restore-entry" aria-label="恢复状态">
              <p className="helper-text" data-testid="knowledge-restore-note">{restoreEntry.note}</p>
              <div className="knowledge-actions"><button type="button" className="secondary-button" data-testid="knowledge-restore"
                disabled={restoring || submitting || pendingCommand !== null || loading || refreshing || writeBlockedReason !== null}
                onClick={() => { void restoreRetired(); }}>{restoring ? "正在恢复" : restoreEntry.button}</button></div>
            </section>}
            <details className="knowledge-management">
            <summary>资料管理与范围</summary>
            <div className="section-heading-row"><h2>{rowTitle(selected)}</h2><span>{selectedMemory ? memoryStatusText(selectedMemory) : statusLabel(selected.status)} · 修订 v{selected.revision}</span></div>
            <p className="helper-text">ID：{selected.id} · 当前版本 v{selected.currentVersion}</p>
            {/* 持久状态与有效状态各用其职责：停用/恢复看 status，展示与筛选看 effective_status。 */}
            {selectedMemory && <p className="helper-text" data-testid="memory-effective-status">持久状态 {selectedMemory.status} · 有效状态 {memoryStatusText(selectedMemory)} · {selectedMemory.expiresAt === null ? "无到期时间" : `到期 ${selectedMemory.expiresAt}`}</p>}
            <p className="helper-text" data-testid="knowledge-detail-scope">范围：{"scope" in selected
              ? (selected.scope === "WORKSPACE" ? "工作空间" : `${selected.scope === "PROJECT" ? "项目" : "任务"} ${selected.scopeId}`)
              : selected.projectId ? `项目 ${selected.projectId}` : "工作空间"}</p>
            {selectedRule && selectedRuleSpec && <><p className="knowledge-rule-facts" data-testid="knowledge-rule-facts">{enumText(ruleStrengthLabels, selectedRule.strength)} · {enumText(ruleScopeLabels, selectedRule.scope)} / {selectedRule.scopeId} · {enumText(ruleApplicabilityLabels, selectedRule.applicability)}</p>
              <p className="helper-text" data-testid="knowledge-rule-target-spec">目标约束：{selectedRuleSpec.text}</p>
              {selectedRuleSpec.json !== null && <details className="knowledge-tech-details" data-testid="knowledge-rule-target-spec-json"><summary>目标约束 JSON</summary><code>{selectedRuleSpec.json}</code></details>}</>}

            {selected.status === "ACTIVE" && pendingCommand === null && <div className="knowledge-actions">
              {kind === "KNOWLEDGE" && <button type="button" className="danger-button" disabled={writeBlockedReason !== null} onClick={() => { void retire(); }}>归档资料</button>}
              {(kind === "MEMORY" || kind === "RULE") && <button type="button" className="danger-button" disabled={writeBlockedReason !== null} onClick={() => { void retire(); }}>停用{kind === "MEMORY" ? "记忆" : "规则"}</button>}
            </div>}
            {selectedDecision?.status === "ACTIVE" && pendingCommand === null && <>
              <label className="field" htmlFor="decision-replacement"><span className="field-label">替代它的决定 ID</span>
                <input id="decision-replacement" value={replacementId} onChange={(event) => setReplacementId(event.target.value)} data-testid="decision-replacement" /></label>
              <button type="button" className="secondary-button" data-testid="decision-supersede" disabled={writeBlockedReason !== null} onClick={() => { void supersede(); }}>记录替代关系</button>
            </>}

            {selectedMemory && <section className="knowledge-history"><h3>确认修订历史</h3><ol>{memoryRevisions.map((revision) =>
              <li key={revision.id}>v{revision.version} · {revision.title} · {revision.confirmedBy} 于 {revision.confirmedAt}<p>{revision.text}</p></li>)}</ol></section>}
            {selectedRule && <section className="knowledge-history"><h3>规则版本历史</h3><ol>{ruleVersions.map((version) =>
              <li key={`${version.ruleId}-${version.version}`}>v{version.version} · {enumText(ruleStrengthLabels, version.strength)} · {enumText(ruleEnforcementLabels, version.enforcement)} · {version.ruleKey}<p>{version.statement}</p></li>)}</ol></section>}
            </details>
          </section> : !capturing && <section className="surface-panel" data-testid="knowledge-detail-empty-state">
            <p className="helper-text" role={loading || refreshing ? "status" : undefined}>
              {loading || refreshing ? `正在读取当前范围的${currentNoun}…`
                : error !== null ? `当前范围的${currentNoun}读取失败，请查看上方错误并重试。`
                  : rows.length === 0 ? (kind === "MEMORY" && memoryFilter !== "ALL"
                    ? `当前筛选没有匹配的记忆；「${memoryFilterLabel(memoryFilter)}」只代表当前筛选下没有命中，切换「全部」可查看所有记忆。`
                    : `当前范围没有${currentNoun}。可使用左侧列表中的「新建」入口添加。`)
                    : `当前列表有 ${rows.length} 项${currentNoun}，请选择一项查看详情与版本。`}
            </p>
          </section>}

          {formOpen && <form ref={formRef} className={`surface-panel knowledge-form${captureCeremony ? " knowledge-form--capture" : ""}`} data-testid="knowledge-form" onSubmit={(event) => { void save(event); }}>
            <div className="knowledge-form-main"><header className={captureCeremony ? "knowledge-capture-heading" : undefined}>
            {captureCeremony && <><PageHeader testId="knowledge-capture-page-head" title="把这次经验留下来"
    lede="先核对内容与来源，再决定是否收录。" /></>}
            <h2>{revisionMode ? "追加新版本" : captureCeremony ? "从产物版本收录" : `新建${currentNoun}`}</h2>
            {revisionMode && <p className="helper-text">基于起草时修订 v{kind === "KNOWLEDGE" ? knowledgeDraftBase?.revision : selected?.revision} 提交；冲突时保留草稿，旧版本不会被覆盖。</p>}
            {captureCeremony && <p className="knowledge-capture-draft-status">人工收录草稿 · 尚未保存</p>}
            </header><div className={captureCeremony ? "knowledge-capture-paper" : undefined}><div className={captureCeremony ? "knowledge-capture-content" : undefined}>
            {captureCeremony && <h3>本次收录内容</h3>}
            {(kind === "MEMORY" || (kind !== "RULE" && !revisionMode)) && <label className="field"><span className="field-label">标题</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} data-testid="knowledge-title" required disabled={pendingCommand !== null} /></label>}
            {kind === "KNOWLEDGE" && <>
              {revisionMode && <p className="knowledge-capture-title">{selectedKnowledge?.title ?? "当前资料"}</p>}
              {captureCeremony ? <><h4>确切产物正文</h4>
                {artifactPreviewMatches ? <div data-testid="knowledge-capture-body"><p className="helper-text">Markdown 阅读预览，可展开核对原文。</p><SafeMarkdown source={artifactPreview?.text ?? ""} />
                  <details className="knowledge-capture-text-preview"><summary>查看原始正文</summary><pre className="knowledge-capture-preview">{artifactPreview?.text}</pre></details></div>
                  : <p className="helper-text">先在“来源与收录设置”中选择产物版本并读取正文，再核对本次收录内容。</p>}
              </> : <label className="field"><span className="field-label">正文</span><textarea value={text} onChange={(event) => setText(event.target.value)} data-testid="knowledge-text" rows={10} disabled={pendingCommand !== null} /></label>}
            </>}
            {kind === "MEMORY" && <>
              <label className="field"><span className="field-label">需要长期保留的事实</span><textarea value={text} onChange={(event) => setText(event.target.value)} data-testid="memory-text" rows={6} disabled={pendingCommand !== null} /></label>
              <label className="field"><span className="field-label">到期时间（可选）</span><input value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} type="datetime-local" data-testid="memory-expires-at" disabled={pendingCommand !== null} /></label>
              <label className="knowledge-check"><input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" data-testid="memory-confirmed" disabled={pendingCommand !== null} />我已核对并明确确认这条 Memory</label>
            </>}
            {kind === "DECISION" && <>
              <label className="field"><span className="field-label">做出的选择</span><textarea value={choice} onChange={(event) => setChoice(event.target.value)} rows={3} disabled={pendingCommand !== null} /></label>
              <label className="field"><span className="field-label">依据</span><textarea value={rationale} onChange={(event) => setRationale(event.target.value)} rows={3} disabled={pendingCommand !== null} /></label>
              <label className="field"><span className="field-label">备选方案（每行一项）</span><textarea value={alternatives} onChange={(event) => setAlternatives(event.target.value)} rows={3} disabled={pendingCommand !== null} /></label>
              <label className="field"><span className="field-label">代价（每行一项）</span><textarea value={costs} onChange={(event) => setCosts(event.target.value)} rows={3} disabled={pendingCommand !== null} /></label>
            </>}
            {kind === "RULE" && <>
              <label className="field"><span className="field-label">规则内容</span><textarea value={statement} onChange={(event) => setStatement(event.target.value)} rows={4} data-testid="rule-statement" disabled={pendingCommand !== null} /></label>
              <label className="field"><span className="field-label">强度</span><select value={strength} onChange={(event) => setStrength(event.target.value as RelayRuleStrength)} data-testid="rule-strength" disabled={pendingCommand !== null}>
                <option value="PREFERENCE">偏好 · PREFERENCE</option><option value="HARD">硬约束 · HARD</option></select>
              <span className="field-hint">偏好是默认口径；选硬约束后，服务端在冲突或必需检查路径不可用时拒绝写入。</span></label>
              <details className="knowledge-rule-advanced" data-testid="rule-advanced">
                <summary>范围与执行检查（高级）</summary>
                {!revisionMode && <><label className="field"><span className="field-label">作用域</span><select value={scope} onChange={(event) => setScope(event.target.value as Scope)} disabled={pendingCommand !== null}>
                <option value="WORKSPACE">工作空间 · WORKSPACE</option><option value="PROJECT">项目 · PROJECT</option><option value="TASK">任务 · TASK</option></select>
                <span className="field-hint">{projectId ? "默认作用于当前项目；跨范围时在这里改。" : "默认作用于整个工作空间。"}</span></label>
                {(scope === "TASK" || (scope === "PROJECT" && !projectId)) && <label className="field"><span className="field-label">作用域 ID</span><input value={scopeId} onChange={(event) => setScopeId(event.target.value)} data-testid="rule-scope-id" disabled={pendingCommand !== null} /></label>}</>}
              <label className="field"><span className="field-label">规则键</span><input value={ruleKey} onChange={(event) => setRuleKey(event.target.value)} data-testid="rule-key" disabled={pendingCommand !== null || revisionMode} placeholder="留空由服务端生成" />
                <span className="field-hint">同一规则键在不同范围视为同一条规则的上下位；留空时由服务端生成稳定唯一键。</span></label>
              <label className="field"><span className="field-label">执行检查路径</span><select value={enforcement} onChange={(event) => setEnforcement(event.target.value as RelayRuleEnforcement)} data-testid="rule-enforcement" disabled={pendingCommand !== null}>
                <option value="PRE_ACTION">动作前检查 · PRE_ACTION</option><option value="POST_CHECK">动作后检查 · POST_CHECK</option><option value="SEMANTIC">语义检查 · SEMANTIC</option><option value="HUMAN">人工检查 · HUMAN</option></select></label>
              <label className="field"><span className="field-label">检查方法</span><select value={method} onChange={(event) => setMethod(event.target.value)} disabled={pendingCommand !== null}>
                <option value="">未指定</option><option value="MARKDOWN_STRUCTURE">文档结构 · MARKDOWN_STRUCTURE</option><option value="CITATION_EXISTS">引用存在 · CITATION_EXISTS</option>
                <option value="SEMANTIC">语义检查 · SEMANTIC</option><option value="HUMAN">人工检查 · HUMAN</option></select></label>
              <label className="field"><span className="field-label">目标约束 JSON（可选）</span><textarea value={targetSpec} onChange={(event) => setTargetSpec(event.target.value)} rows={3} disabled={pendingCommand !== null} /></label>
              <p className="field-hint">没有接上自动检查的规则仍按「人工检查」生效；不会把未检查的规则当作已自动执行。</p>
              </details>
            </>}
            </div>{captureCeremony ? <section className="knowledge-capture-source" data-testid="knowledge-capture-source"><h3>对照来源</h3>
              {sourceControls}
              <p className="helper-text">来源与正文按本次保存命令收录；不会从标题猜测来源或替换不可读的版本。</p>
            </section> : <details className="knowledge-source-settings" data-testid="knowledge-source-settings">
              <summary>来源与收录设置</summary>
              <p className="helper-text">默认作为笔记保存到{captureTargetLabel}；需要绑定确切产物版本或改媒体类型时再展开。</p>
              {sourceControls}
            </details>}</div></div>
            {captureCeremony ? <aside className="knowledge-capture-confirmation" data-testid="knowledge-capture-confirmation" aria-label="收录设置与确认">
              <h2>收录设置</h2>
              <section className="knowledge-capture-review" aria-label="保存前核对"><h3>保存前核对</h3>
                <dl><div><dt>内容类型</dt><dd>资料 · Knowledge</dd></div>
                  <div><dt>收录到</dt><dd>{captureTargetLabel}</dd></div>
                  <div><dt>来源</dt><dd>确切产物版本 {artifactVersionId.trim() || "未选择"}</dd></div></dl>
                <p className="helper-text">目标范围：{captureTargetLabel}。{revisionMode ? `追加到资料 ${knowledgeDraftBase?.id ?? "待核对"}；基于起草修订 v${knowledgeDraftBase?.revision ?? "待核对"}。` : "范围由当前入口确定。"}</p>
              </section>
              <p className="warning-callout">收录只保存这份资料，不修改原产物，也不代表任务验收通过。</p>
              {artifactPreviewMatches && <label className="knowledge-check"><input type="checkbox" checked={captureConfirmed}
                disabled={pendingCommand !== null} onChange={(event) => setCaptureConfirmed(event.target.checked)} data-testid="knowledge-capture-confirmed" />我已核对正文、来源版本和目标范围；收录不修改原产物，也不代表通过验收。</label>}
              {!artifactPreviewMatches && <p className="helper-text">读取并核对确切产物正文后，才能确认收录。</p>}
              {actionError && <p className="action-error" role="alert">{actionError}</p>}
              {writeGateFeedback}{saveActions}{pendingReceipt}
              <p className="knowledge-capture-permission-note">只有服务端命令成功并重读后才成为已收录版本；阅读和收录不授予 AI 使用权限。</p>
            </aside> : <div className="knowledge-simple-actions">
              {actionError && <p className="action-error" role="alert">{actionError}</p>}
              {writeGateFeedback}{saveActions}{pendingReceipt}
            </div>}
          </form>}
        </div>
      </div>
    </>}
    <AppDialog open={draftTransition !== null} title="保留未保存的资料" onClose={() => setDraftTransition(null)}>
      <p>当前资料还有未保存的修改。继续编辑会保留正文；丢弃后再切换阅读对象。</p>
      <div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setDraftTransition(null)}>保留并继续编辑</button>
        <button type="button" className="danger-button" data-testid="knowledge-discard-and-switch" onClick={() => {
          const proceed = draftTransition; draftGuard.current.discard(); setDraftTransition(null); proceed?.();
        }}>丢弃草稿并切换</button></div>
    </AppDialog>
  </section>;
}
