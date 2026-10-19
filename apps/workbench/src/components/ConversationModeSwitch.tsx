import { useState } from "react";
import { ChevronDown } from "lucide-react";

import type { RelayAssistantProfile, RelayConversationMode } from "../api/relayClient";
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
 */

export interface AssistantDraft {
  readonly name: string;
  readonly roleDescription: string;
  readonly tone: string;
  readonly readRoots: string;
}

const emptyDraft: AssistantDraft = { name: "", roleDescription: "", tone: "", readRoots: "" };

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
    {/* 2026-10-18 用户指令「普通 agent，人设助手，学习合并到一个下拉框中」：
        三档从三枚 radio 收成**一个原生 select**。理由不只是省宽度——三枚 radio 在窄卡
        里会换行把工具行撑成两行（「执行中底栏散架」同源问题），而模式只有「当前是哪一档」
        这一个事实，本来就不需要把三个候选一直摊在脸上。
        仍是原生控件：方向键、读屏、禁用语义都用平台实现，不另写一套。 */}
    <label className="agent-chat-mode-select-field">
      <span className="visually-hidden">会话模式</span>
      <select className="agent-chat-mode-select" data-testid="conversation-mode-select"
        value={mode} disabled={disabled}
        title={lockedReason ?? "切换会话模式（切档是导航到另一条会话，身份在建会话时冻结）"}
        onChange={(event) => onChangeMode(event.target.value as RelayConversationMode)}>
        <option value="AGENT">普通 Agent</option>
        <option value="ASSISTANT">人设助手</option>
        <option value="LEARNING">学习</option>
      </select>
      <ChevronDown aria-hidden="true" className="agent-chat-chip-chevron" />
    </label>
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
