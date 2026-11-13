import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
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

export default function Combobox({ options, value, onChange, label, placeholder = "搜索…", emptyText = "没有匹配项", disabled = false, id, className, testId }: ComboboxProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const listId = `${inputId}-listbox`;
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const selected = options.find((option) => option.value === value) ?? null;
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (text === "") return options;
    return options.filter((option) => option.label.toLowerCase().includes(text)
      || (option.description ?? "").toLowerCase().includes(text));
  }, [options, query]);

  const close = () => { setOpen(false); setQuery(""); setActive(0); };
  useMenuDismiss(open, close, root);

  const pick = (option: ComboboxOption) => {
    if (option.disabled === true) return;
    onChange(option.value);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      if (filtered.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + delta + filtered.length) % filtered.length);
      return;
    }
    if (event.key === "Home" && open) { event.preventDefault(); setActive(0); return; }
    if (event.key === "End" && open) { event.preventDefault(); setActive(Math.max(0, filtered.length - 1)); return; }
    if (event.key === "Enter" && open) {
      const option = filtered[active];
      if (option !== undefined) { event.preventDefault(); pick(option); }
      return;
    }
    if (event.key === "Escape" && open) {
      // Esc 先关列表并还原文本；不冒泡去关外层对话框，避免一次按键关两层。
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  return <div className={cn("ui-combobox", className)} ref={root} data-testid={testId}>
    <div className="ui-combobox__field">
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={label}
        aria-activedescendant={open && filtered[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder}
        value={open ? query : (selected?.label ?? "")}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); setActive(0); }}
        onFocus={() => { if (!disabled) { setOpen(true); setQuery(""); } }}
        onKeyDown={onKeyDown}
      />
      <ChevronDown className="ui-combobox__chevron" aria-hidden="true" />
    </div>
    {open ? <ul className="ui-combobox__list" id={listId} role="listbox" aria-label={label}>
      {filtered.length === 0 ? <li className="ui-combobox__empty" role="presentation">{emptyText}</li> : null}
      {filtered.map((option, index) => <li
        key={option.value}
        id={`${listId}-${index}`}
        role="option"
        aria-selected={option.value === value}
        aria-disabled={option.disabled === true || undefined}
        className={cn("ui-combobox__option", index === active && "is-active")}
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
