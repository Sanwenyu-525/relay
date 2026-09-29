import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Info, Upload } from "lucide-react";
import { createCommandId, projectCreationFrom, RelayApiError,
  type RelayApiClient, type RelayCommandEnvelope } from "../api/relayClient";
import PackCatalogPanel from "../components/PackCatalogPanel";
import ResponsiveRail from "../components/ResponsiveRail";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { readInitialBlueprintIntent, saveInitialBlueprintIntent } from "../lib/initialBlueprintIntent";
import { projectTypeLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import type { ProjectType } from "../types";

const maxTextBytes = 262144;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const projectTypes: readonly ProjectType[] = ["GENERAL", "THESIS", "DEVELOPMENT"];
type ImportFile = { readonly name: string; readonly text: string;
  readonly mediaType: "text/plain" | "text/markdown"; readonly sha256: string };
type ProjectCommand = { readonly id: string; readonly title: string;
  readonly projectType: ProjectType };
type KnowledgeCommand = { readonly id: string; readonly projectId: string;
  readonly file: ImportFile };
interface Flow {
  readonly title: string;
  readonly goal: string;
  readonly projectType: ProjectType | "";
  readonly file: ImportFile | null;
  readonly projectCommand: ProjectCommand | null;
  readonly projectId: string | null;
  readonly knowledgeCommand: KnowledgeCommand | null;
  readonly knowledgeResult: { readonly id: string; readonly version: string;
    readonly fileName: string } | null;
}
function emptyFlow(): Flow {
  return { title: "", goal: "", projectType: "", file: null, projectCommand: null,
    projectId: null, knowledgeCommand: null, knowledgeResult: null };
}
function storageKey(client: RelayApiClient) {
  return `relay:create-project:${client.baseUrl}:${client.workspaceId}`;
}
function activeStorageKey(prefix: string) {
  const projectId = sessionStorage.getItem(`${prefix}:current`);
  return `${prefix}:${projectId && uuid.test(projectId) ? projectId : "new"}`;
}
function readFlow(key: string): Flow {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(activeStorageKey(key)) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return emptyFlow();
    const row = value as Record<string, unknown>;
    if (typeof row.title !== "string" || typeof row.goal !== "string" ||
      !["", ...projectTypes].includes(String(row.projectType)) ||
      row.file !== null && typeof row.file !== "object" ||
      row.projectCommand !== null && typeof row.projectCommand !== "object" ||
      row.projectId !== null && typeof row.projectId !== "string" ||
      row.knowledgeCommand !== null && typeof row.knowledgeCommand !== "object" ||
      row.knowledgeResult !== null && typeof row.knowledgeResult !== "object") return emptyFlow();
    return row as unknown as Flow;
  } catch { return emptyFlow(); }
}
async function readTextFile(file: File): Promise<ImportFile> {
  const extension = /\.md$/iu.test(file.name) ? "md" : /\.txt$/iu.test(file.name) ? "txt" : null;
  if (!extension) throw new Error("只支持 .md 与 .txt 文本资料。PDF/Office 不在此处导入。");
  if (file.size < 1 || file.size > maxTextBytes) throw new Error("资料需为非空 UTF-8 文本，大小不超过 256 KiB。");
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error("无法读取本地文件。"));
    reader.readAsArrayBuffer(file);
  });
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.trim() || new TextEncoder().encode(text).byteLength > maxTextBytes || text.includes("\0")) {
    throw new Error("资料需为非空 UTF-8 文本，大小不超过 256 KiB。");
  }
  return { name: file.name, text, mediaType: extension === "md" ? "text/markdown" : "text/plain",
    sha256: await hashText(text) };
}
async function hashText(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("当前环境无法计算资料 SHA-256，暂不提交导入。");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function knowledgeId(result: Readonly<Record<string, unknown>>): string {
  if (typeof result.knowledge_id !== "string" || !uuid.test(result.knowledge_id) ||
    typeof result.version !== "string" || !/^\d+$/u.test(result.version) ||
    result.status !== "ACTIVE") throw new Error("Knowledge 回执与本次文本导入不匹配。");
  return result.knowledge_id;
}

export default function LiveCreateProjectFlow({ client, onCancel }: {
  client: RelayApiClient; onCancel: () => void }) {
  const navigate = useNavigate();
  const key = storageKey(client);
  const [flow, setFlow] = useState<Flow>(() => readFlow(key));
  const [submitting, setSubmitting] = useState(false);
  const [readingFile, setReadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [mayRetryProject, setMayRetryProject] = useState(false);
  const [mayRetryKnowledge, setMayRetryKnowledge] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const flowRef = useRef(flow);
  const busyRef = useRef(false);
  const scope = useRef(0);
  const keyRef = useRef(key);
  flowRef.current = flow;
  keyRef.current = key;

  function save(next: Flow): boolean {
    try {
      const previous = activeStorageKey(key);
      const target = `${key}:${next.projectId ?? "new"}`;
      sessionStorage.setItem(target, JSON.stringify(next));
      if (next.projectId) sessionStorage.setItem(`${key}:current`, next.projectId);
      else sessionStorage.removeItem(`${key}:current`);
      if (previous !== target) sessionStorage.removeItem(previous);
    }
    catch {
      setStorageError("当前浏览器无法保存创建草稿；请释放会话存储后重试，以免刷新时丢失目标或导入内容。");
      return false;
    }
    flowRef.current = next; setFlow(next); setStorageError(null);
    return true;
  }
  function clearFlow(): boolean {
    try {
      const prefix = keyRef.current;
      sessionStorage.removeItem(activeStorageKey(prefix));
      sessionStorage.removeItem(`${prefix}:current`);
    } catch {
      setStorageError("当前浏览器无法清除创建草稿；请稍后重试。");
      return false;
    }
    const empty = emptyFlow();
    flowRef.current = empty; setFlow(empty); setStorageError(null);
    return true;
  }
  const guard = useRef<DraftGuard>({
    hasUnsavedChanges: () => flowRef.current.projectId === null && flowRef.current.projectCommand === null &&
      Boolean(flowRef.current.title || flowRef.current.goal || flowRef.current.file),
    discard: () => { clearFlow(); }
  });
  useEffect(() => {
    const currentScope = ++scope.current;
    const restored = readFlow(key);
    flowRef.current = restored; setFlow(restored); setError(null); setImportError(null);
    setDraftGuard(guard.current);
    return () => { if (scope.current === currentScope) scope.current++; clearDraftGuard(guard.current); };
  }, [key]);

  async function run(action: (request: number) => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setSubmitting(true);
    try { await action(scope.current); }
    finally { busyRef.current = false; setSubmitting(false); }
  }
  async function finishKnowledge(command: KnowledgeCommand, envelope: RelayCommandEnvelope,
    request: number) {
    if (envelope.commandId !== command.id) throw new Error("Knowledge 回执 command_id 不匹配。");
    const id = knowledgeId(envelope.result);
    const detail = await client.getKnowledgeDetail(id);
    if (detail.id !== id || detail.projectId !== command.projectId ||
      detail.title !== command.file.name) throw new Error("Knowledge 来源与新项目不匹配。");
    if (request !== scope.current) return;
    save({ ...flowRef.current, file: null, knowledgeCommand: null,
      knowledgeResult: { id, version: String(envelope.result.version), fileName: command.file.name } });
    setImportError(null); setMayRetryKnowledge(false);
  }
  async function knowledgeReceipt(command: KnowledgeCommand, request: number) {
    try {
      const receipt = await client.getCommandReceipt(command.id);
      if (request !== scope.current) return;
      if (receipt.commandType !== "CreateKnowledge") throw new Error("原回执不是 CreateKnowledge。");
      await finishKnowledge(command, receipt, request);
    } catch (caught) {
      if (request !== scope.current) return;
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetryKnowledge(true);
        setImportError("原资料命令未找到回执；可继续查询或以原 ID、原内容重试。项目已创建且不会重建。");
      } else setImportError("资料回执仍不可核对；请保留原 command_id 和文件内容继续查询。");
    }
  }
  async function importKnowledge(command: KnowledgeCommand, request: number) {
    setImportError(null); setMayRetryKnowledge(false);
    try {
      if (await hashText(command.file.text) !== command.file.sha256) throw new Error("hash mismatch");
    } catch {
      setImportError("暂存资料的 SHA-256 无法核对；已阻止重试，请保留原命令继续查询回执。");
      return;
    }
    let envelope: RelayCommandEnvelope;
    try {
      envelope = await client.createKnowledge({ commandId: command.id,
        projectId: command.projectId, title: command.file.name, sourceKind: "MANAGED_TEXT",
        text: command.file.text, mediaType: command.file.mediaType });
    } catch (caught) {
      if (request !== scope.current) return;
      if (caught instanceof RelayApiError && caught.problem.status < 500 &&
        caught.problem.status !== 409 && caught.problem.code !== "COMMAND_ID_REUSED") {
        save({ ...flowRef.current, file: command.file, knowledgeCommand: null });
        setImportError(`资料未导入：${describeLiveError(caught).message} 项目已创建，可重新选择资料。`);
      } else {
        setImportError("资料提交结果不明；正在查询原命令回执，项目不会重建。");
        await knowledgeReceipt(command, request);
      }
      return;
    }
    try { await finishKnowledge(command, envelope, request); }
    catch {
      if (request === scope.current) {
        setImportError("资料提交回执或来源仍不可核对；已保留原命令与内容，请继续查询回执。");
      }
    }
  }
  async function finishProject(projectId: string, request: number) {
    if (!uuid.test(projectId) || request !== scope.current) return;
    if (flowRef.current.projectId && flowRef.current.projectId !== projectId) {
      throw new Error("项目回执与已确认项目不匹配。");
    }
    const next = { ...flowRef.current, projectId };
    if (!save(next)) return;
    setError(null); setMayRetryProject(false);
    if (next.goal.trim() && !saveInitialBlueprintIntent(client, projectId, next.goal.trim())) {
      setStorageError("项目已创建，但目标无法暂存到蓝图草稿；请先保留当前页面并重试暂存。");
      return;
    }
    if (next.file && !next.knowledgeResult && !next.knowledgeCommand) {
      const knowledge: KnowledgeCommand = { id: createCommandId(), projectId, file: next.file };
      if (save({ ...flowRef.current, file: null, knowledgeCommand: knowledge })) {
        await importKnowledge(knowledge, request);
      }
    } else if (!next.goal.trim() && !next.file) {
      await navigate(`/projects/${encodeURIComponent(projectId)}/tasks`);
    }
  }
  async function projectReceipt(command: ProjectCommand, request: number) {
    try {
      const receipt = await client.getCommandReceipt(command.id);
      if (request !== scope.current) return;
      if (receipt.commandId !== command.id || receipt.commandType !== "CreateProject") {
        throw new Error("原回执不是本次 CreateProject。");
      }
      const creation = projectCreationFrom(receipt.result);
      await finishProject(creation.projectId, request);
    } catch (caught) {
      if (request !== scope.current) return;
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetryProject(true);
        setError("原项目命令未找到回执；可继续查询或用原 ID 和载荷重试。目标与资料已保留。");
      } else setError("项目回执仍不可核对；请保留原 command_id，不能创建第二个项目。");
    }
  }
  async function createProject(command: ProjectCommand, request: number) {
    setError(null); setMayRetryProject(false);
    try {
      const creation = await client.createProject({ commandId: command.id,
        title: command.title, projectType: command.projectType });
      await finishProject(creation.projectId, request);
    } catch (caught) {
      if (request !== scope.current) return;
      if (caught instanceof RelayApiError && caught.problem.status < 500 &&
        caught.problem.status !== 409 && caught.problem.code !== "COMMAND_ID_REUSED") {
        save({ ...flowRef.current, projectCommand: null });
        setError(describeLiveError(caught).message);
      } else {
        setError("项目提交结果不明；正在查询原 command_id 回执，不能换 ID 创建第二个项目。");
        await projectReceipt(command, request);
      }
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (flowRef.current.projectId || flowRef.current.projectCommand || busyRef.current || readingFile) return;
    const current = flowRef.current;
    const title = current.title.trim();
    if (!title || title.length > 200) { setError("请填写 1–200 字的项目名称。"); return; }
    if (!current.projectType) { setError("请选择项目类型。"); return; }
    if (current.goal.trim().length > 2000) { setError("待预览蓝图意图最多 2000 字。"); return; }
    const command: ProjectCommand = { id: createCommandId(), title,
      projectType: current.projectType };
    if (!save({ ...current, projectCommand: command })) return;
    await run((request) => createProject(command, request));
  }
  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || flowRef.current.projectCommand && !flowRef.current.projectId ||
      flowRef.current.knowledgeCommand || flowRef.current.knowledgeResult) return;
    setImportError(null);
    setReadingFile(true);
    try { save({ ...flowRef.current, file: await readTextFile(file), knowledgeResult: null }); }
    catch (caught) { setImportError(describeLiveError(caught).message); }
    finally { setReadingFile(false); event.target.value = ""; }
  }
  const locked = submitting || flow.projectCommand !== null || flow.projectId !== null;
  const fileLocked = submitting || readingFile || flow.knowledgeCommand !== null ||
    flow.knowledgeResult !== null || flow.projectCommand !== null && flow.projectId === null;
  const selectedFile = flow.file ?? flow.knowledgeCommand?.file ?? null;
  const goalReady = !flow.goal.trim() || Boolean(flow.projectId &&
    readInitialBlueprintIntent(client, flow.projectId) === flow.goal.trim());
  return <div className="page-layout"><div className="page-primary">
    <h1>开始一个长期项目</h1>
    <p className="page-lede">先创建项目，再单独登记初始资料并预览蓝图意图。</p>
    <div className="warning-callout" role="status">创建命令（CreateProject）只保存名称与类型。填写的目标会暂存为待预览的蓝图意图，不会自动创建 Goal、调用模型或应用蓝图；可选文本资料在项目创建成功后用独立的 Knowledge 命令登记。</div>
    <form className="create-form" noValidate onSubmit={(event) => void submit(event)}>
      <label className="field"><span className="field-label">项目名称<span className="field-required" aria-hidden="true">*</span></span>
        <input name="project-title" value={flow.title} disabled={locked} maxLength={200}
          placeholder="例如：人机协作工作流研究"
          onChange={(event) => save({ ...flowRef.current, title: event.target.value })} />
        <span className="field-hint">一个清晰的名称有助于你在长期工作中快速识别这个项目。</span></label>
      <label className="field"><span className="field-label">项目目标（可选）</span>
        <textarea name="project-goal" value={flow.goal} disabled={locked} maxLength={2000} rows={3}
          placeholder="例如：研究可追溯、可恢复的人与 AI 协作方法"
          onChange={(event) => save({ ...flowRef.current, goal: event.target.value })} />
        <span className="field-hint">会暂存为待预览的蓝图意图；到蓝图页生成候选并核对 Diff 后才可能生效，不会自动成为 Goal。</span></label>
      <fieldset className="field" disabled={locked}><legend className="field-label">项目类型<span className="field-required" aria-hidden="true">*</span></legend>
        <div className="segmented">{projectTypes.map((type) => <label key={type}
          className={`segmented-option${flow.projectType === type ? " segmented-option--selected" : ""}`}>
          <input className="visually-hidden" type="radio" name="project-type" value={type}
            checked={flow.projectType === type}
            onChange={() => save({ ...flowRef.current, projectType: type })} />{projectTypeLabels[type]}</label>)}</div>
        <span className="field-hint">项目类型决定阶段词汇；蓝图可另建议默认工作台。</span>
      </fieldset>
      <div className="field"><span className="field-label">导入初始资料（可选）</span>
        <label className={`file-drop${selectedFile ? " file-drop--filled" : ""}`}>
          <input className="visually-hidden" type="file" accept=".md,.txt" name="project-import"
            disabled={fileLocked} onChange={(event) => void selectFile(event)} />
          <Upload aria-hidden="true" /><strong>{selectedFile?.name ?? "点击选择 .md / .txt 文件"}</strong>
          <small>非空 UTF-8 文本，最多 256 KiB；不会自动发送给模型</small></label>
        {flow.file && !locked && <button className="text-button" type="button"
          onClick={() => save({ ...flowRef.current, file: null })}>取消导入</button>}
        {importError && <span className="field-error" role="alert"><Info aria-hidden="true" />{importError}</span>}
      </div>
      {!flow.projectId && <div className="form-actions"><button className="primary-button" type="submit"
        data-testid="project-create-submit" disabled={locked || readingFile || Boolean(storageError)}>
        {submitting ? "正在创建" : "创建项目"}</button>
        <button className="secondary-button" type="button" disabled={submitting || Boolean(flow.projectCommand)}
          onClick={() => { if (clearFlow()) onCancel(); }}>取消创建并返回列表</button></div>}
      {flow.projectCommand && !flow.projectId && <div className="warning-callout" data-testid="project-create-pending">
        <p>原 CreateProject command_id：{flow.projectCommand.id}。名称与类型载荷已冻结，目标和资料仍保留。</p>
        <button className="secondary-button" type="button" disabled={submitting}
          onClick={() => void run((request) => projectReceipt(flow.projectCommand!, request))}>查询项目回执</button>
        {mayRetryProject && <button className="secondary-button" type="button" disabled={submitting}
          onClick={() => void run((request) => createProject(flow.projectCommand!, request))}>以原 ID 重试创建</button>}
      </div>}
    </form>
    {storageError && <p className="action-error" role="alert">{storageError}</p>}
    {error && <p className="action-error" role="alert">{error}</p>}
    {flow.projectId && <section className="surface-panel" data-testid="project-created-result">
      <h2>项目已创建</h2><p>Project ID：{flow.projectId}。创建命令只保存名称与类型；后续资料导入失败不会撤销项目。</p>
      {flow.goal.trim() && goalReady ? <p>待预览蓝图意图已暂存；前往蓝图页后需明确生成候选并核对 Diff，尚未成为 Goal。</p> :
        flow.goal.trim() ? <p>目标暂存失败。请留在此页并重试暂存，避免离开后丢失待预览意图。
          <button className="text-button" type="button" onClick={() => {
            if (flow.projectId && saveInitialBlueprintIntent(client, flow.projectId, flow.goal.trim())) {
              setStorageError(null); setFlow({ ...flowRef.current });
            }
          }}>重试暂存目标</button></p> :
        <p>未填写蓝图意图，可直接开始任务。</p>}
      {flow.knowledgeResult ? <p>初始资料「{flow.knowledgeResult.fileName}」已登记为 Knowledge {flow.knowledgeResult.id} v{flow.knowledgeResult.version}。
        <Link className="inline-link" to={`/projects/${flow.projectId}/knowledge?item=${flow.knowledgeResult.id}`}>查看资料</Link></p> :
        flow.knowledgeCommand ? <div className="warning-callout" data-testid="project-knowledge-pending">
          <p>初始资料命令 {flow.knowledgeCommand.id} 待核对；SHA-256 {flow.knowledgeCommand.file.sha256}。项目不会重复创建。</p>
          <button className="secondary-button" type="button" disabled={submitting}
            onClick={() => void run((request) => knowledgeReceipt(flow.knowledgeCommand!, request))}>查询资料回执</button>
          {mayRetryKnowledge && <button className="secondary-button" type="button" disabled={submitting}
            onClick={() => void run((request) => importKnowledge(flow.knowledgeCommand!, request))}>以原 ID 重试导入</button>}
        </div> : flow.file ? <p>初始资料「{flow.file.name}」尚未登记。<button className="text-button" type="button"
          disabled={submitting} onClick={() => {
            const command: KnowledgeCommand = { id: createCommandId(), projectId: flow.projectId!, file: flow.file! };
            if (save({ ...flowRef.current, knowledgeCommand: command })) void run((request) => importKnowledge(command, request));
          }}>重新发起资料导入</button></p> : <p>本次没有选择初始资料。</p>}
      <div className="form-actions">{goalReady ? <Link className="primary-button" to={`/projects/${flow.projectId}?skill=blueprint`}>
        {flow.goal.trim() ? "预览蓝图意图" : "打开项目蓝图"}</Link> :
        <button className="primary-button" type="button" disabled>暂存目标后打开蓝图</button>}
        <Link className="secondary-button" to={`/projects/${flow.projectId}/tasks`}>打开项目任务</Link>
        {!flow.knowledgeCommand && goalReady && <button className="secondary-button" type="button" onClick={() => {
          if (clearFlow()) { setError(null); setImportError(null); }
        }}>结束本次引导并新建项目</button>}</div>
    </section>}
    <PackCatalogPanel />
  </div><ResponsiveRail label="查看创建说明" title="从最少的信息开始"><div className="rail-content">
    <h2>分步保存</h2><p className="rail-intro">项目、资料和蓝图候选有各自的保存结果。</p>
    <p>项目创建不需要模型。资料只作为本项目 Knowledge 登记，不能因此推断已验证或已供模型读取。</p>
    <p>蓝图页面会先给出候选与服务端 Diff；你确认应用后才修改项目状态、任务或默认视图。</p>
  </div></ResponsiveRail></div>;
}
