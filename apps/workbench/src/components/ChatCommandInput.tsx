import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactNode, type Ref, type TextareaHTMLAttributes } from "react";
import type { RelayApiClient, RelayConversationMode } from "../api/relayClient";
import type { RelayChatCommand } from "../api/resources/chatControls";
import PluginIcon from "./PluginIcon";
import PluginChip from "./PluginChip";
import { PLUGIN_MENTIONS, findPluginMentions } from "../lib/pluginMentions";
import "./ChatCommandInput.css";

/**
 * 命令的作用范围与当前可用状态。输入框内联菜单与「+」二级菜单共用同一条口径：
 * 两处各写一份会让命令可用性悄悄漂移，所以这里导出给二级菜单复用。
 */
export function chatCommandScope(entry: RelayChatCommand): string {
  if (entry.kind === "METHOD") return entry.methodId === "fault-diagnosis" ? "当前任务" : "当前改动及相关影响";
  return entry.systemId === "undo" ? "具体业务调整" : "当前会话";
}

/**
 * 只在「现在点了没用」时给一句状态：可用的命令不写标签。
 * 上游同类菜单不逐行标注「可用」——每行都挂一句同样的话只是噪音，真正需要读的是例外
 * （会话还没有、能力还没接）。2026-10-19 用户指认「这个文字很影响体验」。
 */
export function chatCommandStatus(entry: RelayChatCommand, hasSession: boolean): string | null {
  // `/compact` 已在 2026-10-20 接通（走 chat-commands 的 MEMORY_COMPACTION 分支），
  // 它和 `/clear`、`/new` 一样需要已有会话；不再有「待接入」的例外。
  if (entry.kind === "SYSTEM" && !hasSession) return "需已有会话";
  return null;
}

/** CSS 长度取值：jsdom 没有样式表时读回空串，按 0 处理而不是 NaN 污染补偿。 */
function cssLength(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 菜单仅消费服务端登记并编辑草稿；发送、身份与动作准入由原会话 Owner 处理。 */
export default function ChatCommandInput({ client, mode, hasSession, value, onValueChange, onSelectCommand, ref,
  onKeyDown, onFocus, onBlur, onCompositionChange, onAttachFiles, pluginChips = false, disabled, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>,
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
    /**
     * 输入内联插件芯片（2026-10-25）：草稿里的已知插件 mention 在正文原位显示
     * 「小图标 + 短名」芯片（参考 Codex 输入器工具标识）。textarea 仍是唯一文本
     * Owner——芯片只是镜像层上的视觉件，光标/选区/IME/撤销/粘贴/发送载荷全不走它。
     */
    pluginChips?: boolean;
    ref?: Ref<HTMLTextAreaElement>;
  }) {
  const menuId = useId();
  const mentionMenuId = useId();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [mentionActive, setMentionActive] = useState(0);
  /** 光标/选区变化计数：`@` 菜单的开合取决于光标位置，纯方向键移动也要重算。 */
  const [caretTick, setCaretTick] = useState(0);
  const [retry, setRetry] = useState(0);
  /** `@` 菜单插入后的光标落点：React 写回 value 会把选区冲到末尾，提交后按这里恢复。 */
  const pendingCaret = useRef<number | null>(null);
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
  /* —— 输入内联插件芯片（2026-10-25）——
     textarea 保持唯一文本 Owner：原生光标/选区/IME/撤销/粘贴/发送载荷一律不动。
     镜像层用与 textarea 同源继承的字体和逐项相同的盒模型排版同一段草稿，
     mention 文字在镜像层里透明（占位保证折行与光标对齐），芯片叠在它的矩形上。
     草稿里没有已知 mention 时镜像层整体不渲染，输入器与此前逐像素一致。 */
  const mentions = useMemo(() => (pluginChips ? findPluginMentions(value) : []), [pluginChips, value]);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const chipRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const placeChips = useCallback(() => {
    const mirror = mirrorRef.current;
    const textarea = inputRef.current;
    if (mirror === null || textarea === null || mentions.length === 0) return;
    /* textarea 弹出纵向滚动条时内容区变窄：镜像层右侧让出同宽 gutter，
       两侧折行点才一致（镜像层 overflow:hidden，gutter 只影响排版不影响显示）。
       gutter = 滚动条本身：offsetWidth - clientWidth 还含两侧边框，而边框在镜像层
       上同源存在、已经扣过，嵌入态（有边框）不扣就会把折行宽度多补 2×边框。
       补偿是「基础值 + 当前 gutter」的**绝对值**：先把上一轮的行内补偿清掉再读
       基础 padding——否则 base 已含上次补偿，滚动、缩放、ResizeObserver 反复触发
       会越叠越宽（2026-10-26 独立验收指认）。 */
    const textareaStyle = getComputedStyle(textarea);
    const inlineBorder = cssLength(textareaStyle.borderLeftWidth) + cssLength(textareaStyle.borderRightWidth);
    const gutter = Math.max(0, textarea.offsetWidth - textarea.clientWidth - inlineBorder);
    if (gutter > 0) {
      if (mirror.style.paddingRight !== "") mirror.style.paddingRight = "";
      mirror.style.paddingRight = `${cssLength(getComputedStyle(mirror).paddingRight) + gutter}px`;
    } else if (mirror.style.paddingRight !== "") {
      mirror.style.paddingRight = "";
    }
    /* 芯片是镜像层的绝对定位后代，包含块是它的 **padding 盒**（边框盒左缘 + 左边框），
       不是文字起点：原点只加回左边框。过去直接减边框盒左上角，等于把左 padding 和
       边框各多算一次——聊天输入器无边框无左 padding 所以看不出来，换进任何有边框或
       左内边距的表面就整体右移（2026-10-28 量测）。 */
    const box = mirror.getBoundingClientRect();
    const originLeft = box.left + cssLength(textareaStyle.borderLeftWidth);
    const originTop = box.top + cssLength(textareaStyle.borderTopWidth);
    mentions.forEach((mention, index) => {
      const chip = chipRefs.current[index];
      const span = mirror.querySelector<HTMLElement>(`[data-mention-start="${mention.start}"]`);
      if (chip === null || span === null) return;
      /* 宽度取原文片段的字宽、不取芯片的固有宽度：容器右缘就是 `@标签` 的终点，也正是
         光标落点——芯片盖不到后面的正文，光标也不会落进名称里；名称放不下时由 label
         自己省略号收口，不靠 margin 或负定位找补（2026-10-28 用户指认「贴在文字表面」
         的根因）。 */
      const fragments = span.getClientRects();
      /* 原文被 textarea 原生折行拆成两段以上时，一枚芯片只能盖住首片段，其余原文仍按
         `color: transparent` 排版——那就是「看不见的字符占位」（2026-10-29 用户指认）。
         安全的降级是整枚芯片收起、原文 `@标签` 恢复可见：折行规则与 textarea 保持同一
         套，光标仍落在原位置。禁止靠镜像层 `white-space: nowrap` 强行不折行——那会让
         两侧排版分叉，光标与可见文字错位，比不可见占位更糟。 */
      const split = fragments.length > 1;
      chip.dataset.split = split ? "true" : "false";
      span.dataset.chip = split ? "off" : "on";
      if (split) return;
      const rect = fragments.length > 0 ? fragments[0] : span.getBoundingClientRect();
      chip.style.setProperty("--chip-left", `${rect.left - originLeft}px`);
      chip.style.setProperty("--chip-top", `${rect.top - originTop + mirror.scrollTop}px`);
      chip.style.setProperty("--chip-width", `${rect.width}px`);
      chip.style.setProperty("--chip-height", `${rect.height}px`);
    });
  }, [mentions]);
  useLayoutEffect(placeChips, [placeChips, value]);
  /* 应用字体是 font-display:swap 的可变字体：先按系统字回退排版、加载完再换成真字体，
     两次的字宽不一样。不在换字体后重量一次，芯片就停在回退字宽上——用户看到的是
     「文字动了、图标没动」的偏移（首屏与字体缩放后的漂移）。 */
  useEffect(() => {
    const fonts = document.fonts;
    if (fonts === undefined || fonts.ready === undefined) return;
    let live = true;
    void fonts.ready.then(() => { if (live) placeChips(); });
    return () => { live = false; };
  }, [placeChips]);
  /* `@` 菜单插入后把光标放回插入内容之后：React 写回受控 value 会把选区冲到末尾，
     不恢复的话继续打字会插到错位置（mention 插入协议要求落在原光标处）。 */
  useLayoutEffect(() => {
    const position = pendingCaret.current;
    const element = inputRef.current;
    pendingCaret.current = null;
    if (position === null || element === null) return;
    element.setSelectionRange(position, position);
  }, [value]);
  useEffect(() => {
    const el = inputRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastWidth = el.getBoundingClientRect().width;
    // 只在宽度变化时重算：内容重新折行会改变所需高度；忽略我们自身改高度触发的回调，避免抖动。
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width === lastWidth) return;
      lastWidth = width; autoGrow(); placeChips();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [placeChips]);
  // 只在行首命令 token 中展开，参数、文件路径与正文里的 / 都不抢输入。
  const token = /^\s*\/([^\s/]*)$/u.exec(value)?.[1]?.toLowerCase() ?? null;
  /* —— `@` 插件菜单（2026-10-25）——
     光标前恰好有一个「边界合法的 @query」时展开三个内置插件，选中即把
     `@query` 换成 `@标签 `（与「+ → 连接器与插件」同一条插入语义，只编辑草稿）。
     边界与 mention 识别同源：`@` 在开头或前字符不是单词/路径字符——输入邮箱
     `user@` 不弹菜单，中文前导无空格（`先用@`）照弹。斜杠菜单已展开时让位给它。
     查询依赖光标位置，因此监听选区变化（方向键/点击移光标也要重算开合）。 */
  const mentionQuery = useMemo((): { query: string; start: number; end: number } | null => {
    if (!pluginChips || !focused || disabled || composing) return null;
    const caret = inputRef.current?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const match = /@([^\s@]{0,12})$/u.exec(before);
    if (match === null) return null;
    const at = caret - match[0].length;
    const preceding = at === 0 ? "" : before[at - 1]!;
    if (preceding !== "" && /[A-Za-z0-9_./\\-]/u.test(preceding)) return null;
    return { query: match[1]!.toLowerCase(), start: at, end: caret };
  }, [value, caretTick, focused, composing, disabled, pluginChips]);
  const mentionOpen = mentionQuery !== null && dismissed !== value;
  const mentionEntries = PLUGIN_MENTIONS.filter((item) =>
    mentionQuery === null || mentionQuery.query === ""
    || item.label.toLowerCase().includes(mentionQuery.query) || item.key.includes(mentionQuery.query));
  const mentionSelected = mentionEntries[Math.min(mentionActive, Math.max(0, mentionEntries.length - 1))];
  const open = focused && !disabled && !composing && token !== null && dismissed !== value
    && mentionQuery === null;
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
  useEffect(() => {
    if (mentionOpen && mentionSelected) {
      document.getElementById(`${mentionMenuId}-${mentionSelected.key}`)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [mentionOpen, mentionMenuId, mentionSelected]);
  function insert(entry: RelayChatCommand) {
    const next = `${value.match(/^\s*/u)?.[0] ?? ""}/${entry.name} `;
    setDismissed(next); onValueChange(next); onSelectCommand?.(entry);
    inputRef.current?.focus();
  }
  /** `@` 菜单选中：把光标前的 `@query` 换成 `@标签 `，光标落在插入内容之后。 */
  function insertPluginMentionLabel(label: string): void {
    if (mentionQuery === null) return;
    /* query 后紧跟的空格一并吃掉：句子里改 mention 时不留下两个空格。 */
    const end = value[mentionQuery.end] === " " ? mentionQuery.end + 1 : mentionQuery.end;
    const next = `${value.slice(0, mentionQuery.start)}@${label} ${value.slice(end)}`;
    pendingCaret.current = mentionQuery.start + label.length + 2;
    setMentionActive(0);
    setDismissed(next);
    onValueChange(next);
    inputRef.current?.focus();
  }
  function scope(entry: RelayChatCommand): string { return chatCommandScope(entry); }
  function status(entry: RelayChatCommand): string | null { return chatCommandStatus(entry, hasSession); }
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
  /* 镜像层分段：普通原样渲染，mention 包一层透明 span（占位 + 测量锚点）。
     文本节点用 span 包裹只是给 React 稳定 key，不改变任何排版。 */
  const mirrorSegments: ReactNode[] = [];
  if (mentions.length > 0) {
    let cursor = 0;
    for (const mention of mentions) {
      if (mention.start > cursor) mirrorSegments.push(<span key={`t-${cursor}`}>{value.slice(cursor, mention.start)}</span>);
      mirrorSegments.push(<span key={`m-${mention.start}`} className="chat-command-mention"
        data-mention-start={mention.start}>{value.slice(mention.start, mention.end)}</span>);
      cursor = mention.end;
    }
    if (cursor < value.length) mirrorSegments.push(<span key={`t-${cursor}`}>{value.slice(cursor)}</span>);
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
            <span><strong>/{entry.name} · {entry.title}</strong>{status(entry) !== null && <small>{status(entry)}</small>}</span>
            <span>{entry.summary}</span>
            <small>范围：{scope(entry)} · 用法：{entry.usage}</small>
          </button></li>)}
          {entries.length === 0 && <li role="presentation">没有匹配的登记命令，请修改输入。</li>}
        </ul>}
    </div>}
    {mentionOpen && <div className="chat-command-menu chat-mention-menu" data-testid="chat-mention-menu">
      <p className="chat-command-hint">选择插入插件提示（只改草稿，不发送）· ↑↓ 选择 · Enter 插入 · Esc 关闭</p>
      {mentionEntries.length === 0
        ? <p role="status">没有匹配的内置插件，请修改输入。</p>
        : <ul id={mentionMenuId} role="listbox" aria-label="内置插件">
          {mentionEntries.map((entry) => <li key={entry.key} role="none">
            <button type="button" role="option" id={`${mentionMenuId}-${entry.key}`}
              aria-selected={mentionSelected === entry} tabIndex={-1}
              data-testid={`chat-mention-${entry.key}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertPluginMentionLabel(entry.label)}>
              <span className="chat-mention-option">
                <PluginIcon plugin={entry.key} className="chat-mention-option-icon" />
                <strong>{entry.label}</strong>
              </span>
            </button></li>)}
        </ul>}
    </div>}
    <div className="chat-command-surface" ref={surfaceRef}
      data-chips={mentions.length > 0 ? "on" : undefined}>
      {mentions.length > 0 && <div className="chat-command-mirror" ref={mirrorRef} aria-hidden="true">
        {mirrorSegments}
        {mentions.map((mention, index) => <PluginChip key={`chip-${mention.start}`} variant="editing"
          plugin={mention.key} label={mention.label} className="chat-command-chip"
          ref={(element) => { chipRefs.current[index] = element; }} />)}
      </div>}
    <textarea {...props} aria-label={props["aria-label"] ?? "本次消息"} disabled={disabled} value={value}
      onScroll={(event) => {
        // 镜像层跟随 textarea 滚动：芯片与正文才会一起待在可视区里。
        const mirror = mirrorRef.current;
        if (mirror !== null) {
          mirror.scrollTop = event.currentTarget.scrollTop;
          mirror.scrollLeft = event.currentTarget.scrollLeft;
        }
        placeChips();
      }}
      ref={(element) => {
        inputRef.current = element;
        if (typeof ref === "function") ref(element);
        else if (ref) ref.current = element;
      }}
      aria-autocomplete="list"
      aria-controls={mentionOpen && mentionEntries.length > 0 ? mentionMenuId
        : open && entries.length > 0 ? menuId : undefined}
      aria-activedescendant={mentionOpen && mentionSelected !== undefined
        ? `${mentionMenuId}-${mentionSelected.key}`
        : open && selected ? `${menuId}-${selected.name}` : undefined}
      onChange={(event) => { setActive(0); setMentionActive(0); setDismissed(null); onValueChange(event.target.value); }}
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
      onSelect={() => setCaretTick((tick) => tick + 1)}
      onBlur={(event) => {
        if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) setFocused(false);
        onBlur?.(event);
      }}
      onCompositionStart={() => { setComposing(true); onCompositionChange?.(true); }}
      onCompositionEnd={() => { setComposing(false); onCompositionChange?.(false); }}
      onKeyDown={(event) => {
        if (composing || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        const plain = !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
        /* `@` 插件菜单与斜杠菜单同构：Esc 关、方向键选、Enter 插入。
           两者互斥展开（斜杠菜单要求 mentionQuery 为空），分支顺序只是防御。 */
        if (mentionOpen && plain) {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDismissed(value); return; }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setMentionActive(mentionEntries.length === 0 ? 0
              : (mentionEntries.indexOf(mentionSelected!) + (event.key === "ArrowDown" ? 1 : -1) + mentionEntries.length) % mentionEntries.length);
            return;
          }
          if (event.key === "Enter") {
            // 没有匹配项时不拦截：Enter 仍归发送/换行的原语义。
            if (mentionSelected === undefined) return;
            event.preventDefault();
            insertPluginMentionLabel(mentionSelected.label);
            return;
          }
        }
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
        /* —— 芯片整体删除（2026-10-25 用户指认「作为一个整体」；同日第二轮按
           「为什么有这个状态、要按两次」改为一次删除）——
           mention 在草稿里是纯文本，原生退格会把 `@标签` 逐字拆碎——第一个字没了
           芯片就退化成裸 `@`。做法是把选区预置到整段 mention 再放行按键：删除仍由
           原生执行（一次按键、Ctrl+Z 可撤销、光标自然落位），只是作用范围从
           「一个字/半段」扩成整枚芯片。修饰键不排除：Ctrl+Backspace 删词同样不许
           拆碎芯片；选区本就完整覆盖时预置到恰好整段，行为等价。
           选区并集（2026-10-26 独立验收指认）：触及的**每一枚** mention 都扩进预置
           选区，且只在边界外扩展、绝不缩小用户已选的范围——全选「前文 @GitHub 后文」
           删除应得到空串，而不是只删 mention 留下前后文；只碰普通文字时不预置，
           删除完全走原生。 */
        if ((event.key === "Backspace" || event.key === "Delete") && mentions.length > 0) {
          const element = inputRef.current;
          if (element !== null) {
            const from = element.selectionStart ?? value.length;
            const to = element.selectionEnd ?? from;
            // 无选区时原生会吃掉的区间：Backspace 吃 [c-1,c)、Delete 吃 [c,c+1)。
            const rangeFrom = from === to ? (event.key === "Backspace" ? from - 1 : from) : from;
            const rangeTo = from === to ? (event.key === "Backspace" ? from : from + 1) : to;
            const hits = mentions.filter((m) => rangeFrom < m.end && rangeTo > m.start);
            if (hits.length > 0) {
              element.setSelectionRange(
                Math.min(rangeFrom, ...hits.map((m) => m.start)),
                Math.max(rangeTo, ...hits.map((m) => m.end)));
            }
          }
        }
        onKeyDown?.(event);
      }} /></div>
  </div>;
}
