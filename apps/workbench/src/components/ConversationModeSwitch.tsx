import { useState } from "react";

import type { RelayAssistantProfile, RelayConversationMode } from "../api/relayClient";

/**
 * 会话模式单选框与人设助手（工作台 §25、ADR-018）。
 *
 * 三条不能省的规则：
 * - 普通档的标签**不得**写「可派发子 Agent」：ADR-017 的子 Agent 至今零代码。
 * - 切档是导航到另一条会话，不是改当前会话的权限；身份在建立时已冻结。
 * - 在途时两档都禁用：切档不是停止，不允许用它隐式取消正在生成的那条。
 */

export interface AssistantDraft {
  readonly name: string;
  readonly roleDescription: string;
  readonly tone: string;
  readonly readRoots: string;
}

const emptyDraft: AssistantDraft = { name: "", roleDescription: "", tone: "", readRoots: "" };

export function ConversationModeSwitch({ mode, assistantProfileId, profiles, profilesError, profilesLoading,
  onReloadProfiles, remember, disabled, lockedReason, onChangeMode, onChangeAssistant, onChangeRemember,
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
  /** 在途时整组禁用；lockedReason 是禁用原因，文案要说清下一步。 */
  disabled: boolean;
  lockedReason: string | null;
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
  const active = profiles.filter((profile) => profile.status === "ACTIVE");

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
      setDraft(emptyDraft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "新建助手失败，请重试。");
    } finally { setCreating(false); }
  }

  return <div className="agent-chat-mode" data-testid="conversation-mode">
    <fieldset className="agent-chat-mode-picker" disabled={disabled} aria-label="会话模式">
      <legend className="visually-hidden">会话模式</legend>
      <label className="agent-chat-mode-option">
        <input type="radio" name="conversation-mode" value="AGENT" checked={mode === "AGENT"}
          data-testid="assist-conversation-mode-agent"
          onChange={() => onChangeMode("AGENT")} />
        <span>普通 Agent</span></label>
      <label className="agent-chat-mode-option">
        <input type="radio" name="conversation-mode" value="ASSISTANT" checked={mode === "ASSISTANT"}
          data-testid="assist-conversation-mode-assistant"
          onChange={() => onChangeMode("ASSISTANT")} />
        <span>人设助手</span></label>
      <label className="agent-chat-mode-option">
        <input type="radio" name="conversation-mode" value="LEARNING" checked={mode === "LEARNING"}
          data-testid="assist-conversation-mode-learning" onChange={() => onChangeMode("LEARNING")} />
        <span>学习</span></label>
    </fieldset>
    {lockedReason !== null && <p className="disabled-reason" data-testid="conversation-mode-locked">{lockedReason}</p>}
    {mode === "LEARNING" && <p className="helper-text" data-testid="learning-readonly-note">
      学习：可保存个人学习记录，对项目只读；明确转入普通会话后才进入执行流程。</p>}
    {mode === "LEARNING" && onChangeRecordLearning && <label className="agent-chat-mode-option">
      <input type="checkbox" disabled={disabled} checked={!recordLearning} data-testid="learning-message-no-record"
        onChange={(event) => onChangeRecordLearning(!event.target.checked)} /><span>本条消息不记录</span></label>}
    {mode === "ASSISTANT" && <div className="agent-chat-assistant">
      <label className="field agent-chat-assistant-picker"><span className="visually-hidden">助手</span>
        <select data-testid="assist-assistant-picker" value={assistantProfileId ?? ""}
          disabled={disabled || profilesLoading || profilesError !== null || active.length === 0}
          onChange={(event) => onChangeAssistant(event.target.value)}>
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
      {/* 固定边界说明常驻，不做成可折叠：这档最容易被误当成「什么都能干的另一个聊天窗口」。 */}
      <p className="helper-text" data-testid="assist-readonly-note">
        只读：不改文件、不建任务、不派子 Agent，也不能申请任何写操作审批。</p>
      <details className="agent-chat-assistant-create">
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
    </div>}
  </div>;
}
