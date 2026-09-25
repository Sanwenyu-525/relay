import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Check, FileText, Info, Upload } from "lucide-react";
import ResponsiveRail from "../components/ResponsiveRail";
import { createCommandId, projectCreationFrom, RelayApiError, type RelayProjectCreation } from "../api/relayClient";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { projectTypeLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { setCreationFlash } from "../lib/navigationFlash";
import { liveClient, useRelayConnection } from "../lib/relayConnection";
import type { CreateProjectDraft, FixtureError, ProjectType } from "../types";

const projectTypes: ProjectType[] = ["GENERAL", "THESIS", "DEVELOPMENT"];
type FieldErrors = Partial<Record<"title" | "goal" | "projectType", string>>;
type ActionError = { kind: string; message: string };

function describeCreation(creation: RelayProjectCreation): string {
  return `项目 ID ${creation.projectId}，revision v${creation.revision}，phase_key ${creation.phaseKey}，state_revision v${creation.stateRevision}`;
}

export default function CreateProjectView({ onCancel }: { onCancel: () => void }) {
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const mode = fixtureModeFromQuery(query);
  const live = useRelayConnection().mode === "live";
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [projectType, setProjectType] = useState<ProjectType | "">("");
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const commandId = useRef<string | null>(null);
  const created = useRef(false);
  const disposed = useRef(false);
  const draft = JSON.stringify({ title, goal, projectType, importFileName });
  const currentDraft = useRef(draft);
  const savedDraft = useRef(draft);
  currentDraft.current = draft;
  const guard = useRef<DraftGuard>({
    hasUnsavedChanges: () => !created.current && currentDraft.current !== savedDraft.current,
    discard: () => { currentDraft.current = savedDraft.current; }
  });

  useEffect(() => {
    disposed.current = false;
    setDraftGuard(guard.current);
    return () => { disposed.current = true; clearDraftGuard(guard.current); };
  }, []);

  function changed() { commandId.current = null; }
  function acceptFile(file: File | undefined) {
    if (live || !file) return;
    changed();
    if (!/\.(md|txt)$/i.test(file.name)) {
      setImportFileName(null);
      setImportError("只支持 .md 与 .txt 文本资料；PDF/Office 暂不支持全文提取，因此不会在这里接收。");
      return;
    }
    setImportError(null);
    setImportFileName(file.name);
  }
  function drop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDropActive(false);
    acceptFile(event.dataTransfer.files?.[0]);
  }
  function validate(): boolean {
    const errors: FieldErrors = {};
    if (!title.trim()) errors.title = "请填写项目名称，它用于在长期工作中快速定位这个项目。";
    if (!live && !goal.trim()) errors.goal = "请用一句话说明你希望通过这个项目达成的目标。";
    if (!projectType) errors.projectType = "请选择项目类型；它决定后续阶段词汇与默认工作台组合。";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }
  const typeHint = projectType === "THESIS" ? "论文项目按选题、文献研究、方法、实验、写作与评审组织阶段。" : projectType === "DEVELOPMENT" ? "开发项目按探索、设计、实现、验证与发布组织阶段。" : projectType === "GENERAL" ? "通用项目按规划、执行与评审组织阶段。" : "不同类型决定后续阶段词汇、任务模板与工作台默认组合，创建后仍可调整。";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || created.current) return;
    setActionError(null);
    if (!validate()) return;
    setSubmitting(true);
    try {
      if (live) {
        const client = liveClient();
        if (!client) { setActionError({ kind: "unknown", message: "连接已断开：请重新连接本机 API 后再创建项目。" }); return; }
        commandId.current ??= createCommandId();
        const creation = await client.createProject({ commandId: commandId.current, title: title.trim(), projectType: projectType as ProjectType });
        if (disposed.current) return;
        created.current = true;
        setReceipt(`已创建项目：${describeCreation(creation)}。CreateProject 只写入名称与类型，目标未提交、资料未导入。`);
        await navigate(`/projects/${encodeURIComponent(creation.projectId)}/tasks`);
        return;
      }
      const input: CreateProjectDraft = { title, goal, projectType: projectType as ProjectType, importFileName };
      commandId.current ??= fixtureAdapter.createCommandId("project");
      const result = await fixtureAdapter.createProject(input, mode, commandId.current);
      if (disposed.current) return;
      setReceipt(result.receipt.description);
      created.current = true;
      setCreationFlash({ projectId: result.projectId, receipt: result.receipt.description, importStatus: result.importStatus });
      await navigate("/projects");
    } catch (caught) {
      if (disposed.current) return;
      if (live) setActionError(describeLiveError(caught));
      else {
        const fixtureError = caught as FixtureError;
        setActionError({ kind: caught instanceof Error && "kind" in caught ? String(fixtureError.kind) : "unknown", message: caught instanceof Error ? caught.message.trim() : "创建示例项目时发生未知错误。" });
      }
    } finally { if (!disposed.current) setSubmitting(false); }
  }

  async function lookupReceipt() {
    const pendingId = commandId.current;
    if (!pendingId || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      if (live) {
        const client = liveClient();
        if (!client) return;
        const body = await client.getCommandReceipt(pendingId);
        if (disposed.current) return;
        if (body.commandType !== "CreateProject") { setActionError({ kind: "unknown", message: `回执的命令类型是 ${body.commandType}，不是本次创建项目的命令；请核对 command ID。` }); return; }
        const creation = projectCreationFrom(body.result);
        created.current = true;
        setReceipt(`回执确认已提交：${describeCreation(creation)}。CreateProject 只写入名称与类型，目标未提交、资料未导入。`);
        await navigate(`/projects/${encodeURIComponent(creation.projectId)}/tasks`);
        return;
      }
      const result = await fixtureAdapter.lookupReceipt(pendingId);
      if (disposed.current) return;
      if (result.status === "APPLIED" && result.operation === "project" && result.receipt && result.resourceId && result.importStatus) {
        created.current = true;
        setReceipt(result.receipt.description);
        setCreationFlash({ projectId: result.resourceId, receipt: result.receipt.description, importStatus: result.importStatus });
        await navigate("/projects");
        return;
      }
      setActionError({ kind: result.status === "UNKNOWN" ? "timeout" : "not-submitted", message: result.status === "UNKNOWN" ? "本次提交仍未确认；请继续使用同一 command ID 查询回执，不能直接创建第二个项目。" : "未找到这次提交的回执；尚未创建项目，可以使用同一 command ID 再次提交。" });
    } catch (caught) {
      if (disposed.current) return;
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") setActionError({ kind: "not-submitted", message: "没有找到这次提交的回执：该命令尚未提交，可以用同一个 command ID 重新提交。" });
      else setActionError(describeLiveError(caught));
    } finally { if (!disposed.current) setSubmitting(false); }
  }

  return <div className="page-layout"><div className="page-primary"><h1>开始一个长期项目</h1><p className="page-lede">定义项目的基本信息，稍后可逐步完善。创建后即可开始规划任务、整理资料与开展工作。</p>
    <form className="create-form" noValidate onSubmit={(event) => void submit(event)}>
      <label className={`field${fieldErrors.title ? " field--invalid" : ""}`}><span className="field-label">项目名称<span className="field-required" aria-hidden="true">*</span></span><input value={title} onChange={(event) => { changed(); setTitle(event.target.value); setFieldErrors((previous) => ({ ...previous, title: undefined })); }} name="project-title" required aria-invalid={fieldErrors.title ? "true" : undefined} aria-describedby={fieldErrors.title ? "project-title-error" : "project-title-hint"} />{fieldErrors.title ? <span id="project-title-error" className="field-error" role="alert"><Info aria-hidden="true" />{fieldErrors.title}</span> : <span id="project-title-hint" className="field-hint">一个清晰的名称有助于你在长期工作中快速识别和定位该项目。</span>}</label>
      <label className={`field${fieldErrors.goal ? " field--invalid" : ""}`}><span className="field-label">项目目标{!live && <span className="field-required" aria-hidden="true">*</span>}</span><textarea value={goal} onChange={(event) => { changed(); setGoal(event.target.value); setFieldErrors((previous) => ({ ...previous, goal: undefined })); }} name="project-goal" rows={3} required={!live} aria-invalid={fieldErrors.goal ? "true" : undefined} aria-describedby={fieldErrors.goal ? "project-goal-error" : "project-goal-hint"} />{fieldErrors.goal ? <span id="project-goal-error" className="field-error" role="alert"><Info aria-hidden="true" />{fieldErrors.goal}</span> : <span id="project-goal-hint" className="field-hint">{live ? "未接入：CreateProject 只接受名称与类型，目标不会写入服务端；这里输入的内容不会被保存。" : "简要描述你希望通过这个项目达成的目标、预期成果或解决的主要问题。"}</span>}</label>
      <fieldset className={`field${fieldErrors.projectType ? " field--invalid" : ""}`}><legend className="field-label">项目类型<span className="field-required" aria-hidden="true">*</span></legend><div className="segmented">{projectTypes.map((type) => <label key={type} className={`segmented-option${projectType === type ? " segmented-option--selected" : ""}`}><input className="visually-hidden" type="radio" name="project-type" value={type} checked={projectType === type} onChange={() => { changed(); setProjectType(type); setFieldErrors((previous) => ({ ...previous, projectType: undefined })); }} />{projectTypeLabels[type]}</label>)}</div>{fieldErrors.projectType ? <span className="field-error" role="alert"><Info aria-hidden="true" />{fieldErrors.projectType}</span> : <span className="field-hint">{typeHint}</span>}</fieldset>
      <div className="field"><span className="field-label">导入初始资料（可选）</span><label className={`file-drop${importFileName ? " file-drop--filled" : ""}${dropActive ? " file-drop--active" : ""}${importError ? " file-drop--invalid" : ""}`} onDragOver={(event) => { event.preventDefault(); if (!live) setDropActive(true); }} onDragLeave={() => setDropActive(false)} onDrop={drop}><input className="visually-hidden" type="file" accept=".md,.txt" name="project-import" disabled={live} onChange={(event: ChangeEvent<HTMLInputElement>) => acceptFile(event.target.files?.[0])} /><Upload aria-hidden="true" /><strong>{live ? "资料导入尚未接入" : importFileName ?? "点击选择文件或拖拽到此处"}</strong><small>{live ? "live 模式下不会上传任何文件" : "支持 .md / .txt 格式的文档"}</small></label>{live ? <span className="field-hint">资料导入端点尚未实现：CreateProject 只写入项目名称与类型，初始资料不会上传到服务端。</span> : importError ? <span className="field-error" role="alert"><Info aria-hidden="true" />{importError}</span> : importFileName ? <span className="field-hint">已选择「{importFileName}」。导入是独立的长任务：失败不会撤销已创建的项目。<button className="text-button" type="button" onClick={() => { changed(); setImportFileName(null); setImportError(null); }}>取消导入</button></span> : <span className="field-hint">上传与本项目相关的已有资料，例如研究笔记、文档大纲、参考文献等。</span>}</div>
      <div className="form-actions"><button className="primary-button" type="submit" data-testid="project-create-submit" disabled={submitting}>{submitting ? "正在创建" : "创建项目"}</button><button className="secondary-button" type="button" disabled={submitting} onClick={onCancel}>返回列表</button></div>
      {receipt && <p className="receipt-message" role="status">{receipt}</p>}{actionError && <p className="action-error" role="alert">{actionError.message}</p>}{(actionError?.kind === "timeout" || actionError?.kind === "transport") && <button className="secondary-button" type="button" data-testid="project-create-receipt" disabled={submitting} onClick={() => void lookupReceipt()}>查询本次回执</button>}{actionError?.kind === "timeout" && <p className="helper-text">提交结果暂不明确时先查回执，不要直接再点创建；重复点击不会创建两个项目。</p>}{actionError?.kind === "transport" && <p className="helper-text">提交结果不确定时先查回执，不要换 command ID 重新提交。</p>}
    </form></div>
    <ResponsiveRail label="查看创建说明" title="从最少的信息开始"><div className="rail-content"><h2>从最少的信息开始</h2><p className="rail-intro">你可以先填写基本信息，创建后再逐步完善项目的详细内容。</p>{[["创建后可人工维护项目状态", "项目创建后，你可以随时补充目标、调整范围、更新任务与资料。"], ["未连接模型也能开始", "不需要配置任何模型或服务，你可以在任何时候开始，专注于自己的思考与规划。"], ["AI 建议需你确认后应用", "后续在项目中，AI 可能提供分析与建议，但所有关键内容都需要你审查并确认后才会被应用。"]].map(([heading, copy]) => <div className="suggestion-row" key={heading}><Check aria-hidden="true" /><span className="suggestion-copy"><strong>{heading}</strong><small>{copy}</small></span></div>)}<p className="helper-text"><FileText aria-hidden="true" />本轮交互预览未连接模型：创建后不会自动生成初始状态或蓝图建议，也不会自动启动任何执行。</p></div></ResponsiveRail>
  </div>;
}
