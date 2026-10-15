import { useEffect, useId, useRef, useState, type Ref, type TextareaHTMLAttributes } from "react";
import type { RelayApiClient, RelayConversationMode } from "../api/relayClient";
import type { RelayChatCommand } from "../api/resources/chatControls";
import "./ChatCommandInput.css";

/** 菜单仅消费服务端登记并编辑草稿；发送、身份与动作准入由原会话 Owner 处理。 */
export default function ChatCommandInput({ client, mode, hasSession, value, onValueChange, onSelectCommand, ref,
  onKeyDown, onFocus, onBlur, disabled, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>,
    "value" | "onChange"> & {
    client: RelayApiClient | null;
    mode: RelayConversationMode;
    hasSession: boolean;
    value: string;
    onValueChange: (value: string) => void;
    onSelectCommand?: (entry: RelayChatCommand) => void;
    ref?: Ref<HTMLTextAreaElement>;
  }) {
  const menuId = useId();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [retry, setRetry] = useState(0);
  const [catalog, setCatalog] = useState<{ client: RelayApiClient;
    items: readonly RelayChatCommand[] | null; error: string | null } | null>(null);
  // 只在行首命令 token 中展开，参数、文件路径与正文里的 / 都不抢输入。
  const token = /^\s*\/([^\s/]*)$/u.exec(value)?.[1]?.toLowerCase() ?? null;
  const open = focused && !disabled && !composing && token !== null && dismissed !== value;
  const current = catalog?.client === client ? catalog : null;
  useEffect(() => {
    if (!open || !client || catalog?.client === client && catalog.items !== null) return;
    let live = true;
    setCatalog({ client, items: null, error: null });
    void client.getChatCommands().then((items) => {
      if (live) setCatalog({ client, items, error: null });
    }).catch(() => {
      if (live) setCatalog({ client, items: null, error: "命令清单读取失败，草稿已保留。" });
    });
    return () => { live = false; };
    // 清单只按连接/展开/重试读取，不随每个输入字符请求。
  }, [client, open, retry]);
  const entries = (current?.items ?? []).filter((entry) =>
    (entry.kind !== "METHOD" || mode === "AGENT") &&
    [entry.name, entry.title, ...entry.aliases].some((name) => name.toLowerCase().includes(token ?? "")));
  const selected = entries[Math.min(active, Math.max(0, entries.length - 1))];
  useEffect(() => {
    if (open && selected) document.getElementById(`${menuId}-${selected.name}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, menuId, selected]);
  function insert(entry: RelayChatCommand) {
    const next = `${value.match(/^\s*/u)?.[0] ?? ""}/${entry.name} `;
    setDismissed(next); onValueChange(next); onSelectCommand?.(entry);
    inputRef.current?.focus();
  }
  function scope(entry: RelayChatCommand): string {
    if (entry.kind === "METHOD") return entry.methodId === "fault-diagnosis" ? "当前任务" : "当前改动及相关影响";
    return entry.systemId === "undo" ? "具体业务调整" : "当前会话";
  }
  function status(entry: RelayChatCommand): string {
    if (entry.systemId === "model" || entry.systemId === "compact") return "待接入";
    if (entry.kind === "SYSTEM" && !hasSession) return "需已有会话";
    if (entry.systemId === "undo") return "查看具体调整的撤回入口";
    return "可用";
  }
  return <div className="chat-command-input" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  }}>
    {open && <div className="chat-command-menu" data-testid="chat-command-menu">
      <p className="chat-command-hint">选择只插入草稿，发送后运行 · ↑↓ 选择 · Enter 插入 · Esc 关闭</p>
      {!client ? <p role="status">请先连接 Relay，草稿已保留。</p>
        : current?.error ? <div role="alert">{current.error} <button type="button"
          onClick={() => { setRetry((count) => count + 1); inputRef.current?.focus(); }}>重试读取</button></div>
        : current?.items === null || current === null ? <p role="status">正在读取命令…</p>
        : <ul id={menuId} role="listbox" aria-label="聊天命令">
          {entries.map((entry) => <li key={entry.name} role="none"><button type="button" role="option"
            id={`${menuId}-${entry.name}`} aria-selected={selected === entry} tabIndex={-1}
            data-testid={`chat-command-${entry.name}`}
            onMouseDown={(event) => event.preventDefault()} onClick={() => insert(entry)}>
            <span><strong>/{entry.name} · {entry.title}</strong><small>{status(entry)}</small></span>
            <span>{entry.summary}</span>
            <small>范围：{scope(entry)} · 用法：{entry.usage}</small>
          </button></li>)}
          {entries.length === 0 && <li role="presentation">没有匹配的登记命令，请修改输入。</li>}
        </ul>}
    </div>}
    <textarea {...props} aria-label={props["aria-label"] ?? "本次消息"} disabled={disabled} value={value}
      ref={(element) => {
        inputRef.current = element;
        if (typeof ref === "function") ref(element);
        else if (ref) ref.current = element;
      }}
      aria-autocomplete="list" aria-controls={open && entries.length > 0 ? menuId : undefined}
      aria-activedescendant={open && selected ? `${menuId}-${selected.name}` : undefined}
      onChange={(event) => { setActive(0); setDismissed(null); onValueChange(event.target.value); }}
      onFocus={(event) => { setFocused(true); onFocus?.(event); }}
      onBlur={(event) => {
        if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) setFocused(false);
        onBlur?.(event);
      }}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
      onKeyDown={(event) => {
        if (composing || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (open && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDismissed(value); return; }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive(entries.length === 0 ? 0 : (entries.indexOf(selected!) + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (selected) insert(selected);
            return;
          }
        }
        onKeyDown?.(event);
      }} />
  </div>;
}
