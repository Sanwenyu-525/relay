import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type Ref, type TextareaHTMLAttributes } from "react";
import type { RelayApiClient, RelayConversationMode } from "../api/relayClient";
import type { RelayChatCommand } from "../api/resources/chatControls";
import "./ChatCommandInput.css";

/**
 * 命令的作用范围与当前可用状态。输入框内联菜单与「+」二级菜单共用同一条口径：
 * 两处各写一份会让命令可用性悄悄漂移，所以这里导出给二级菜单复用。
 */
export function chatCommandScope(entry: RelayChatCommand): string {
  if (entry.kind === "METHOD") return entry.methodId === "fault-diagnosis" ? "当前任务" : "当前改动及相关影响";
  return entry.systemId === "undo" ? "具体业务调整" : "当前会话";
}

export function chatCommandStatus(entry: RelayChatCommand, hasSession: boolean): string {
  if (entry.systemId === "compact") return "待接入";
  if (entry.kind === "SYSTEM" && !hasSession) return "需已有会话";
  if (entry.systemId === "undo") return "查看具体调整的撤回入口";
  return "可用";
}

/** 菜单仅消费服务端登记并编辑草稿；发送、身份与动作准入由原会话 Owner 处理。 */
export default function ChatCommandInput({ client, mode, hasSession, value, onValueChange, onSelectCommand, ref,
  onKeyDown, onFocus, onBlur, onCompositionChange, onAttachFiles, disabled, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>,
    "value" | "onChange"> & {
    client: RelayApiClient | null;
    mode: RelayConversationMode;
    hasSession: boolean;
    value: string;
    onValueChange: (value: string) => void;
    onSelectCommand?: (entry: RelayChatCommand) => void;
    /**
     * 中文组词状态。草稿辅助（工作台 §30）据此保证「组词期间零请求」；
     * 输入器自己已经用它挡斜杠菜单，这里只把同一事实报给调用方，不新建第二套判定。
     */
    onCompositionChange?: (composing: boolean) => void;
    /**
     * 粘贴/拖入的图片文件（工作台 §33）。不传时输入器保持纯文本行为；
     * 传了也只是把文件交出去——类型、上限与「要不要暂存」都由调用方的附件 Owner 裁决。
     */
    onAttachFiles?: (files: readonly File[]) => void;
    ref?: Ref<HTMLTextAreaElement>;
  }) {
  const menuId = useId();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [retry, setRetry] = useState(0);
  /* 拖拽高亮只认「真的拖了文件」：dragover 阶段拿不到文件内容，只能看 types，
     因此收起时同样按 types 判断，避免拖一段文字过来也点亮整块区域。 */
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [catalog, setCatalog] = useState<{ client: RelayApiClient;
    items: readonly RelayChatCommand[] | null; error: string | null } | null>(null);
  // 输入框随内容自增高：先归零再取 scrollHeight，交给 CSS max-height(40dvh) 封顶、超出后框内滚动。
  // jsdom 下 scrollHeight=0，加保护避免误设 0px 把框压没。
  const autoGrow = () => {
    const el = inputRef.current; if (!el) return;
    el.style.height = "auto";
    const next = el.scrollHeight;
    if (next > 0) el.style.height = `${next}px`;
  };
  useLayoutEffect(autoGrow, [value]);
  useEffect(() => {
    const el = inputRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastWidth = el.getBoundingClientRect().width;
    // 只在宽度变化时重算：内容重新折行会改变所需高度；忽略我们自身改高度触发的回调，避免抖动。
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width === lastWidth) return;
      lastWidth = width; autoGrow();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
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
  function scope(entry: RelayChatCommand): string { return chatCommandScope(entry); }
  function status(entry: RelayChatCommand): string { return chatCommandStatus(entry, hasSession); }
  /** 剪贴板里的文件项（截图/复制的图片）。文本项一律不管，纯文本粘贴逐字不变。 */
  function clipboardFiles(event: ClipboardEvent<HTMLTextAreaElement>): readonly File[] {
    const files: File[] = [];
    for (const item of Array.from(event.clipboardData?.items ?? [])) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file !== null) files.push(file);
    }
    return files;
  }
  const acceptsDrop = onAttachFiles !== undefined && !disabled;
  function hasFilePayload(data: DataTransfer | null): boolean {
    return data !== null && Array.from(data.types).includes("Files");
  }
  return <div className="chat-command-input" data-drop={dragging}
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
    }}
    onDragEnter={(event) => {
      if (!acceptsDrop || !hasFilePayload(event.dataTransfer)) return;
      event.preventDefault(); dragDepth.current += 1; setDragging(true);
    }}
    onDragOver={(event) => {
      if (!acceptsDrop || !hasFilePayload(event.dataTransfer)) return;
      // 不阻止默认行为，浏览器会把这个文件当成导航目标直接打开——等于把页面弄丢。
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }}
    onDragLeave={() => {
      // 子元素的 dragleave 也会冒泡到这里，所以用进入次数抵消：
      // 只在真的离开整块输入区时才收起高亮，否则掠过缩略图就闪一下。
      if (!acceptsDrop) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    }}
    onDrop={(event) => {
      if (!acceptsDrop) return;
      const files = Array.from(event.dataTransfer?.files ?? []);
      dragDepth.current = 0; setDragging(false);
      if (files.length === 0) return;
      event.preventDefault();
      onAttachFiles?.(files);
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
      onPaste={(event) => {
        // 只有「剪贴板里真有文件项」才接管：截图/复制的图片进附件暂存，
        // 其余粘贴（文字、表格、代码）保持原生行为，一个字符都不改。
        if (onAttachFiles === undefined) return;
        const files = clipboardFiles(event);
        if (files.length === 0) return;
        event.preventDefault();
        onAttachFiles(files);
      }}
      onFocus={(event) => { setFocused(true); onFocus?.(event); }}
      onBlur={(event) => {
        if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) setFocused(false);
        onBlur?.(event);
      }}
      onCompositionStart={() => { setComposing(true); onCompositionChange?.(true); }}
      onCompositionEnd={() => { setComposing(false); onCompositionChange?.(false); }}
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
