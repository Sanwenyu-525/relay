import { useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import type { RelayAssistantProfile, RelayConversationMode } from "../api/relayClient";
import { useDetailsMenu } from "../lib/popoverMenu";
import AppDialog from "./AppDialog";

/**
 * 会话模式单选框与人设助手（工作台 §25、ADR-018）。
 *
 * 三条不能省的规则：
 * - 普通档的标签**不得**写「可派发子 Agent」：ADR-017 的子 Agent 至今零代码。
 * - 切档是导航到另一条会话，不是改当前会话的权限；身份在建立时已冻结。
 * - 在途时两档都禁用：切档不是停止，不允许用它隐式取消正在生成的那条。
 *
 * 助手配置收在弹窗里，不内联展开：清单提示、不记住与新建表单一起摊在底栏会把输入框
 * 从一行撑到六行，正文反而被挤走。只读边界说明是例外——它常驻，不收进弹窗。
 * 还有一个例外：一个可用助手都没有时，「新建助手」就地摆在 chip 旁边。那是这条档唯一的
 * 出路，收进弹窗等于把首次路径堵在「发不出去又不知道下一步点哪」。点开仍是同一个弹窗。
 * 弹窗只由 chip 或该入口的点击打开，不在切档时自动弹：协作页给 AssistView 的 key 里带 sessionId，
 * 从「还没有会话」切到助手档会让整棵子树重挂载，组件内的「刚点过」标记活不到那一刻。
 *
 * 2026-10-16（两轮）：模式盒里**只放选择控件**，所有说明与原因行都不进去。模式盒是
 * `display: inline-flex; flex-wrap: wrap` 的自动宽度容器，长文本会让它按可用宽度撑开
 * （真实 Chromium 实测 241px → 483px、两行），把资料/润色/计量 chip 挤到别的行上——
 * 这是「执行中底栏散架」的成因。第二轮按用户「这些都导致输入框变化了」再收一步：
 * 锁定原因、学习档说明、助手档只读说明**都不留在输入卡内**，交由下面的
 * `ConversationModeHints` 渲染在卡片下方的这一列里。理由是输入卡（`.agent-chat-composer`）
 * 是用户在打字的那个框：它一随状态长高、变矮或换内容，光标位置与工具行就跟着跳。
 * 卡内因此恒定只有三样东西——正文、工具行、发送键；回执与原因都在卡外。
 *
 * 2026-10-22（DEV-0116，用户截图「优化一下下拉框ui」并选定「换成应用自绘浮层」）：三档
 * 选择从原生 `<select>` 换成 `details` + 浮层。原生浮层锚在 select 的**内容盒**上，芯片的
 * 内边距与箭头先吃掉左缘，实测那条浮层既不与芯片对齐又比芯片宽——就是用户截图里悬在
 * 芯片右上方、压住上面那行字的那块白卡；`appearance: base-select` 能改颜色与圆角，改不了
 * 锚定与宽度。换成自绘后浮层左缘贴芯片左缘、宽度不小于芯片，档位说明仍不进芯片（见上）。
 * 代价是键盘与读屏语义要自己实现，因此本文件明确承担三件事：方向键从芯片进浮层并直接落在
 * 目标档（与原生 select 同语义：一次按键换一档）、浮层内上下与 Home/End 移动焦点、
 * Enter/Space 由按钮本身完成。Esc、点外面与「同时只留一个浮层」仍归 popoverMenu，不重写。
 */

export interface AssistantDraft {
  readonly name: string;
  readonly roleDescription: string;
  readonly tone: string;
  readonly readRoots: string;
}

const emptyDraft: AssistantDraft = { name: "", roleDescription: "", tone: "", readRoots: "" };

/** 三档的标签与顺序：只有这一份，浮层与用例都读它。普通档不承诺子 Agent 派发（ADR-017 零代码）。 */
const MODE_OPTIONS: readonly { readonly value: RelayConversationMode; readonly label: string }[] = [
  { value: "AGENT", label: "普通 Agent" },
  { value: "ASSISTANT", label: "人设助手" },
  { value: "LEARNING", label: "学习" },
];

/**
 * 档位说明行：渲染在**输入卡之外**（卡下方这一列），由调用方摆位。
 *
 * 为什么不在卡里：见文件头。为什么单独一个组件：文案与「哪一档有什么说明」属于模式契约，
 * 与控件放在同一个模块里，调用方只负责摆在卡外，不重复一份文案。
 * 什么都没有时返回 null——不留空盒子，否则卡下方会凭空多出一档列间距。
 *
 * 2026-10-17（用户截图指认「执行时不要弹出这个东西，整个布局都被他打乱了」）：在途锁定原因
 * 不再占一行可见文字——它会随生成开始/结束在输入卡下方凭空出现又消失，卡下方的列随之跳动。
 * 现在它保持视觉隐藏（AT 仍按文档序读到，`data-testid` 用例仍可定位），并把同一句话放到
 * 禁用的模式盒 `title` 上（悬停可读）；模式盒本身在在途时整组禁用，禁用态已经表达了「此刻不能切」。
 * 学习档 / 助手档的说明是**选择该档时的常驻说明**，不随在途出现消失，维持可见。
 */
export function ConversationModeHints({ mode, lockedReason }: {
  mode: RelayConversationMode;
  /** 在途禁用原因；文案要说清下一步（先停止，再切档）。 */
  lockedReason: string | null;
}) {
  const learning = mode === "LEARNING";
  const assistant = mode === "ASSISTANT";
  if (lockedReason === null && !learning && !assistant) return null;
  return <div className="agent-chat-mode-hints">
    {lockedReason !== null && <p className="disabled-reason visually-hidden"
      data-testid="conversation-mode-locked">{lockedReason}</p>}
    {learning && <p className="helper-text" data-testid="learning-readonly-note">
      学习：可保存个人学习记录，对项目只读；明确转入普通会话后才进入执行流程。</p>}
    {assistant && <p className="helper-text" data-testid="assist-readonly-note">
      只读：不改文件、不建任务、不派子 Agent，也不能申请任何写操作审批。</p>}
  </div>;
}

export function ConversationModeSwitch({ mode, assistantProfileId, profiles, profilesError, profilesLoading,
  onReloadProfiles, remember, disabled, lockedReason = null, onChangeMode, onChangeAssistant, onChangeRemember,
  onCreateAssistant, recordLearning = true, onChangeRecordLearning }: {
  mode: RelayConversationMode;
  assistantProfileId: string | null;
  profiles: readonly RelayAssistantProfile[];
  /** 清单读不到的真实原因；不显示它，空下拉会看起来像「你没有助手」。 */
  profilesError: string | null;
  profilesLoading: boolean;
  onReloadProfiles: () => void;
  /** 「一次性问答」：不记住就不作为可续读历史。 */
  remember: boolean;
  /** 在途时整组禁用。禁用原因不在这里渲染，见 ConversationModeHints。 */
  disabled: boolean;
  /** 在途禁用的原因原文：放在禁用模式盒的 title 上（2026-10-17，可见行已转视觉隐藏）。 */
  lockedReason?: string | null;
  onChangeMode: (next: RelayConversationMode) => void;
  onChangeAssistant: (profileId: string) => void;
  onChangeRemember: (next: boolean) => void;
  onCreateAssistant: (draft: AssistantDraft) => Promise<void>;
  recordLearning?: boolean;
  onChangeRecordLearning?: (next: boolean) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<AssistantDraft>(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  /** 弹窗内「新建助手」表单是否展开：入口按钮与 summary 都能改，所以受控。 */
  const [createOpen, setCreateOpen] = useState(false);
  /**
   * 这次打开是不是为了新建。只由两个触发按钮写、弹窗开着时不再变化——
   * AppDialog 把 initialFocusSelector 放在 effect 依赖里，中途换它会让焦点弹回触发器。
   */
  const [openToCreate, setOpenToCreate] = useState(false);
  const active = profiles.filter((profile) => profile.status === "ACTIVE");
  const selected = active.find((profile) => profile.id === assistantProfileId) ?? null;
  /** 一个可用助手都没有（或清单读不到）时，新建是这条档唯一的出路，就别藏进弹窗。 */
  const createIsWayOut = !profilesLoading && active.length === 0;
  // 模式浮层：开合走原生 `details`（不用 React state——useDetailsMenu 的「点外面／Esc／独占」
  // 是直接改 DOM 的 `open`，state 会与之漂移），这里只补键盘与选择动作。
  const modeRef = useRef<HTMLDetailsElement>(null);
  useDetailsMenu(modeRef);

  /** 先开浮层再聚焦：闭合的 `details` 里的按钮不可聚焦，先 focus 再 open 会落空。 */
  function openMenuAt(target: number) {
    const node = modeRef.current;
    if (node === null) return;
    node.open = true;
    const rows = Array.from(node.querySelectorAll<HTMLButtonElement>("[data-mode-row]"));
    if (rows.length === 0) return;
    rows[Math.max(0, Math.min(rows.length - 1, target))]?.focus({ preventScroll: true });
  }

  function focusRow(from: number, step: (index: number, count: number) => number) {
    const rows = Array.from(modeRef.current?.querySelectorAll<HTMLButtonElement>("[data-mode-row]") ?? []);
    if (rows.length === 0) return;
    rows[(step(from, rows.length) + rows.length) % rows.length]?.focus({ preventScroll: true });
  }

  /** 芯片上的方向键＝原生 select 的「一次按键换一档」：按下即打开浮层并把焦点落在目标档。 */
  function onTriggerKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (disabled) return;
    const current = MODE_OPTIONS.findIndex((option) => option.value === mode);
    if (event.key === "ArrowDown") { event.preventDefault(); openMenuAt(current + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); openMenuAt(current - 1); }
    else if (event.key === "Home") { event.preventDefault(); openMenuAt(0); }
    else if (event.key === "End") { event.preventDefault(); openMenuAt(MODE_OPTIONS.length - 1); }
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    const rows = Array.from(modeRef.current?.querySelectorAll("[data-mode-row]") ?? []);
    const from = rows.indexOf(document.activeElement as Element);
    if (from < 0) return;
    if (event.key === "ArrowDown") { event.preventDefault(); focusRow(from, (index) => index + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); focusRow(from, (index) => index - 1); }
    else if (event.key === "Home") { event.preventDefault(); focusRow(from, () => 0); }
    else if (event.key === "End") { event.preventDefault(); focusRow(from, (_index, count) => count - 1); }
  }

  /** 选定即收起浮层并把焦点还给芯片：与原生 select 选完回到控件同一读法，Tab 序不落在死掉的行上。 */
  function chooseMode(next: RelayConversationMode) {
    if (disabled) return;
    if (modeRef.current !== null) modeRef.current.open = false;
    modeRef.current?.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
    if (next !== mode) onChangeMode(next);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;
    const name = draft.name.trim();
    const roleDescription = draft.roleDescription.trim();
    if (name === "" || roleDescription === "") { setError("名字与角色描述都要填。"); return; }
    setCreating(true); setError(null);
    try {
      await onCreateAssistant({ ...draft, name, roleDescription });
      // 成功才清空：失败时清掉会把用户刚填的东西一起丢掉。
      setDraft(emptyDraft); setConfigOpen(false); setCreateOpen(false); setOpenToCreate(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "新建助手失败，请重试。");
    } finally { setCreating(false); }
  }

  const configLabel = profilesLoading ? "正在读取助手清单"
    : profilesError !== null ? "助手清单读取失败"
      : selected !== null ? `助手 · ${selected.optionLabel}` : "选择助手";

  return <>
  <div className="agent-chat-mode" data-testid="conversation-mode" title={lockedReason ?? undefined}>
    {/* 2026-10-22（DEV-0116）：三档从原生 select 换成自绘浮层，锚定与宽度见文件头。
        仍是「一个事实一枚控件」：芯片只显示当前档，三档候选打开才看得见；说明一律不进芯片
        （`.agent-chat-mode` 是自动宽容器，长文本会把同排 chip 挤到别的行上）。 */}
    <details className="agent-chat-mode-select-field agent-chat-mode-menu" ref={modeRef}
      data-testid="conversation-mode-menu" data-mode={mode}>
      <summary className="agent-chat-mode-chip" data-testid="conversation-mode-select" data-mode={mode}
        aria-disabled={disabled || undefined}
        title={lockedReason ?? "切换会话模式（切档是导航到另一条会话，身份在建会话时冻结）"}
        onKeyDown={onTriggerKeyDown}
        onClick={(event) => { if (disabled) event.preventDefault(); }}>
        <span className="visually-hidden">会话模式</span>
        <span className="agent-chat-mode-chip-value">{MODE_OPTIONS
          .find((option) => option.value === mode)?.label ?? mode}</span>
        <ChevronDown aria-hidden="true" className="agent-chat-chip-chevron" />
      </summary>
      <div className="agent-chat-mode-options" role="group" aria-label="会话模式" onKeyDown={onMenuKeyDown}>
        {MODE_OPTIONS.map((option) => <button key={option.value} type="button"
          className="agent-chat-mode-menu-row" data-mode-row data-testid={`conversation-mode-option-${option.value}`}
          data-current={option.value === mode ? "true" : "false"}
          aria-current={option.value === mode ? "true" : undefined}
          aria-disabled={disabled || undefined} onClick={() => chooseMode(option.value)}>
          <span className="agent-chat-mode-menu-mark" aria-hidden="true">
            {option.value === mode && <Check />}</span>
          <span className="agent-chat-mode-menu-label">{option.label}</span>
        </button>)}
      </div>
    </details>
    {mode === "LEARNING" && onChangeRecordLearning && <label className="agent-chat-mode-option">
      <input type="checkbox" disabled={disabled} checked={!recordLearning} data-testid="learning-message-no-record"
        onChange={(event) => onChangeRecordLearning(!event.target.checked)} /><span>本条消息不记录</span></label>}
    {mode === "ASSISTANT" && <>
      <button className="agent-chat-tool agent-chat-assistant-config" type="button"
        data-testid="assist-assistant-config-toggle" aria-haspopup="dialog" aria-expanded={configOpen}
        disabled={disabled}
        onClick={() => { setOpenToCreate(false); setCreateOpen(false); setConfigOpen(true); }}>
        <span className="agent-chat-assistant-config-label">{configLabel}</span>
        <ChevronDown aria-hidden="true" className="agent-chat-chip-chevron" /></button>
      {/* 一个可用助手都没有时，新建是这条档唯一的出路：入口就地摆在 chip 旁边，
          点开仍是同一个弹窗，只是表单已经展开、焦点落在名字上。 */}
      {createIsWayOut && <button className="text-button agent-chat-assistant-create-entry" type="button"
        data-testid="assist-assistant-create-entry" disabled={disabled}
        onClick={() => { setOpenToCreate(true); setCreateOpen(true); setConfigOpen(true); }}>新建助手</button>}
      <AppDialog open={configOpen} title="人设助手" subtitle="选择或新建这次对话使用的人设身份"
        initialFocusSelector={openToCreate ? '[data-testid="assist-assistant-name"]'
          : '[data-testid="assist-assistant-picker"]'} onClose={() => setConfigOpen(false)}>
        <div className="agent-chat-assistant">
          <label className="field agent-chat-assistant-picker"><span className="visually-hidden">助手</span>
            <select data-testid="assist-assistant-picker" value={assistantProfileId ?? ""}
              disabled={disabled || profilesLoading || profilesError !== null || active.length === 0}
              onChange={(event) => { onChangeAssistant(event.target.value);
                if (event.target.value !== "") setConfigOpen(false); }}>
              <option value="">{profilesLoading ? "正在读取助手清单…"
                : active.length === 0 ? "还没有可用助手，先新建一个" : "选择助手"}</option>
              {profiles.map((profile) => <option key={profile.id} value={profile.id}
                disabled={profile.status === "ARCHIVED"}>{profile.optionLabel}</option>)}
            </select></label>
          {profilesLoading && <p className="helper-text" role="status"
            data-testid="assist-assistant-list-loading">正在读取助手清单，读取完成后才能发送。</p>}
          {profilesError !== null && <p className="action-error" role="alert"
            data-testid="assist-assistant-list-error">助手清单暂不可读：{profilesError}。可以先新建助手，或
            <button className="text-button" type="button" data-testid="assist-assistant-list-reload"
              disabled={profilesLoading} onClick={onReloadProfiles}>重新读取助手清单</button>。</p>}
          {profilesError === null && !profilesLoading && active.length === 0 && <p className="helper-text"
            data-testid="assist-assistant-list-empty">当前没有可用助手。新建助手后即可继续，或
            <button className="text-button" type="button" data-testid="assist-assistant-list-reload"
              onClick={onReloadProfiles}>重新读取助手清单</button>。</p>}
          <label className="agent-chat-mode-option">
            <input type="checkbox" checked={!remember} data-testid="assist-remember-toggle"
              disabled={disabled} onChange={(event) => onChangeRemember(!event.target.checked)} />
            <span>不记住</span></label>
          <details className="agent-chat-assistant-create" open={createOpen}
            onToggle={(event) => setCreateOpen(event.currentTarget.open)}>
            <summary data-testid="assist-assistant-create-toggle">新建助手</summary>
            <form className="create-form" onSubmit={submit}>
              <label className="field"><span className="field-label">名字</span>
                <input data-testid="assist-assistant-name" value={draft.name} maxLength={60}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
              <label className="field"><span className="field-label">角色描述</span>
                <textarea data-testid="assist-assistant-role" value={draft.roleDescription} rows={2} maxLength={2000}
                  onChange={(event) => setDraft({ ...draft, roleDescription: event.target.value })} /></label>
              <label className="field"><span className="field-label">口吻（可选）</span>
                <input data-testid="assist-assistant-tone" value={draft.tone} maxLength={400}
                  onChange={(event) => setDraft({ ...draft, tone: event.target.value })} /></label>
              <label className="field"><span className="field-label">只读目录范围（可选）</span>
                <input data-testid="assist-assistant-scope" value={draft.readRoots}
                  placeholder="受管根内的相对路径，用分号分隔"
                  onChange={(event) => setDraft({ ...draft, readRoots: event.target.value })} />
                <span className="helper-text">留空即整个受管根。只能缩小范围，不能靠这里扩大授权。</span></label>
              <div className="form-actions">
                <button className="secondary-button" type="submit" data-testid="assist-assistant-save"
                  disabled={creating}>{creating ? "正在新建" : "保存助手"}</button></div>
              {error !== null && <p className="action-error" role="alert" data-testid="assist-assistant-error">{error}</p>}
            </form>
          </details>
        </div>
      </AppDialog>
    </>}
  </div>
  </>;
}
