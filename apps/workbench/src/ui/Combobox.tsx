import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import { isTopOverlay } from "../lib/overlayStack";
import { useMenuDismiss } from "../lib/popoverMenu";
import { cn } from "./cn";

/**
 * 可搜索单选（combobox）。
 *
 * 不用原生 `<datalist>`：它无法限制为已选项、无法显示副标题、也不能在开启时把列表
 * 变成可键盘导航的 listbox。这里按 WAI-ARIA 1.2 的 combobox + listbox 实现：
 * 焦点始终在输入框上，用 `aria-activedescendant` 指向当前高亮项，方向键移动、
 * Enter 选择、Esc 关闭并把文本还原成已选项。
 *
 * `value` 是受控的选中值；输入框里的文字是**筛选词**，不是新值 —— 用户不点选就不会改值。
 *
 * 输入法（2026-11-15 UI-UNIFY-03）：中文/日文/韩文输入法在候选词选择期间会用 Enter、
 * Escape 与方向键。组合期间这些键属于输入法，组件一律不消费；`compositionend` 之后
 * 同一轮事件里紧跟的 Enter 也不能当成选择（浏览器可能先发 compositionend 再发
 * keydown，此时 isComposing 已经是 false）。用 `justEnded` 把这段「同一轮」挡住，
 * 下一轮起的按键才是页面意图。
 *
 * 禁用项（同一轮修复）：高亮索引只在可用项之间移动；全部禁用时没有高亮项，
 * 方向键与 Enter 都不产生选择。筛选词变化后高亮重新落到第一个可用项，
 * 不会留下指向已过滤掉项的陈旧索引。
 */
export interface ComboboxOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export interface ComboboxProps {
  readonly options: readonly ComboboxOption[];
  readonly value: string | null;
  readonly onChange: (value: string) => void;
  /** 可访问名称（输入框没有可见 label 时必须有）。 */
  readonly label: string;
  readonly placeholder?: string;
  readonly emptyText?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly className?: string;
  readonly testId?: string;
}

function filterOptions(options: readonly ComboboxOption[], query: string): readonly ComboboxOption[] {
  const text = query.trim().toLowerCase();
  if (text === "") return options;
  return options.filter((option) => option.label.toLowerCase().includes(text)
    || (option.description ?? "").toLowerCase().includes(text));
}

function firstEnabledIndex(options: readonly ComboboxOption[]): number {
  return options.findIndex((option) => option.disabled !== true);
}

function lastEnabledIndex(options: readonly ComboboxOption[]): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (options[index]?.disabled !== true) return index;
  }
  return -1;
}

/** 从 `from` 起按 `delta` 找下一个可用项；没有可用项时返回 -1。 */
function stepEnabled(options: readonly ComboboxOption[], from: number, delta: number): number {
  if (options.length === 0) return -1;
  const start = from >= 0 && from < options.length ? from : (delta > 0 ? -1 : 0);
  for (let step = 1; step <= options.length; step += 1) {
    const index = (start + delta * step + options.length * 2) % options.length;
    if (options[index]?.disabled !== true) return index;
  }
  return -1;
}

export default function Combobox({ options, value, onChange, label, placeholder = "搜索…", emptyText = "没有匹配项", disabled = false, id, className, testId }: ComboboxProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const listId = `${inputId}-listbox`;
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const composition = useRef(false);
  const justEnded = useRef(false);
  const compositionTimer = useRef<number | null>(null);

  const selected = options.find((option) => option.value === value) ?? null;
  const filtered = useMemo(() => filterOptions(options, query), [options, query]);
  // 渲染时再校验一次索引：options 变化（例如业务刷新列表）也可能让旧索引指向 disabled。
  // 索引失效时回退到第一个可用项；全部禁用才真正没有高亮项。
  const activeIndex = active >= 0 && active < filtered.length && filtered[active]?.disabled !== true
    ? active
    : firstEnabledIndex(filtered);

  const close = () => { setOpen(false); setQuery(""); setActive(-1); };
  const layer = useMenuDismiss(open, close, root);

  useEffect(() => {
    if (!disabled) return;
    // 外部把组件切到禁用时，已经展开的列表不能继续留在屏幕上。
    setOpen(false); setQuery(""); setActive(-1);
  }, [disabled]);

  useEffect(() => () => {
    if (compositionTimer.current !== null) window.clearTimeout(compositionTimer.current);
  }, []);

  // 高亮项可能滚出列表可视区（列表 max-height 16rem）；键盘移动后把它带回视野。
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const option = list.current?.querySelectorAll<HTMLElement>('[role="option"]')[activeIndex];
    if (option !== undefined && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  }, [open, activeIndex]);

  const pick = (option: ComboboxOption) => {
    if (option.disabled === true) return;
    onChange(option.value);
    close();
  };

  /** 组合输入期间（含 compositionend 与紧随其后的同一轮按键）不执行任何列表命令。 */
  const imeActive = (event: KeyboardEvent<HTMLInputElement>): boolean =>
    event.nativeEvent.isComposing === true
    || event.nativeEvent.keyCode === 229
    || composition.current
    || justEnded.current;

  const onCompositionEnd = () => {
    composition.current = false;
    // 同一轮里浏览器还可能补发一个 keydown Enter；用 0ms 定时器只挡这一轮，
    // 用户随后正常按 Enter 仍然可以选择。
    justEnded.current = true;
    if (compositionTimer.current !== null) window.clearTimeout(compositionTimer.current);
    compositionTimer.current = window.setTimeout(() => { justEnded.current = false; compositionTimer.current = null; }, 0);
  };

  const openWithSelection = () => {
    setOpen(true);
    setQuery("");
    const selectedIndex = selected === null ? -1 : options.findIndex((option) => option.value === selected.value);
    setActive(selectedIndex >= 0 && options[selectedIndex]?.disabled !== true ? selectedIndex : firstEnabledIndex(options));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (imeActive(event)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) { openWithSelection(); return; }
      if (filtered.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = stepEnabled(filtered, activeIndex, delta);
      if (next >= 0) setActive(next);
      return;
    }
    if (event.key === "Home" && open) {
      event.preventDefault();
      const first = firstEnabledIndex(filtered);
      if (first >= 0) setActive(first);
      return;
    }
    if (event.key === "End" && open) {
      event.preventDefault();
      const last = lastEnabledIndex(filtered);
      if (last >= 0) setActive(last);
      return;
    }
    if (event.key === "Enter" && open) {
      // 列表开着时 Enter 归列表：即使全部禁用也不让表单把这次按键当成提交。
      event.preventDefault();
      const option = activeIndex >= 0 ? filtered[activeIndex] : undefined;
      if (option !== undefined) pick(option);
      return;
    }
    if (event.key === "Escape" && open) {
      // Esc 先关列表并还原文本；不冒泡去关外层对话框，避免一次按键关两层。
      // 若上层还有 Tooltip 等更新的浮层，这次 Esc 归它，列表保持打开。
      if (!isTopOverlay(layer)) return;
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab" && open) {
      // Tab 是离开，不是选择：关掉列表，焦点按浏览器默认顺序继续前进。
      close();
    }
  };

  return <div
    className={cn("ui-combobox", className)}
    ref={root}
    data-testid={testId}
    onBlur={(event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      close();
    }}
  >
    <div className="ui-combobox__field">
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={label}
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder}
        value={open ? query : (selected?.label ?? "")}
        onChange={(event) => {
          const nextQuery = event.target.value;
          const nextOptions = filterOptions(options, nextQuery);
          setQuery(nextQuery);
          setOpen(true);
          setActive(firstEnabledIndex(nextOptions));
        }}
        onFocus={() => { if (!disabled) openWithSelection(); }}
        onKeyDown={onKeyDown}
        onCompositionStart={() => { composition.current = true; }}
        onCompositionEnd={onCompositionEnd}
      />
      <ChevronDown className="ui-combobox__chevron" aria-hidden="true" />
    </div>
    {open ? <ul className="ui-combobox__list" id={listId} role="listbox" aria-label={label} ref={list}>
      {filtered.length === 0 ? <li className="ui-combobox__empty" role="presentation">{emptyText}</li> : null}
      {filtered.map((option, index) => <li
        key={option.value}
        id={`${listId}-${index}`}
        role="option"
        aria-selected={option.value === value}
        aria-disabled={option.disabled === true || undefined}
        className={cn("ui-combobox__option", index === activeIndex && "is-active")}
        // 用 mousedown 而不是 click：blur 会先发生，click 时列表已经被收起。
        onMouseDown={(event) => { event.preventDefault(); pick(option); }}
      >
        <span className="ui-combobox__option-body">
          <span className="ui-combobox__option-label">{option.label}</span>
          {option.description === undefined ? null : <span className="ui-combobox__option-description">{option.description}</span>}
        </span>
        {option.value === value ? <Check className="ui-combobox__check" aria-hidden="true" /> : null}
      </li>)}
    </ul> : null}
  </div>;
}
