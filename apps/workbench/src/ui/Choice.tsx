import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";

/**
 * 勾选类控件。
 *
 * 全部基于原生 `<input>`：键盘、`indeterminate`、表单序列化、读屏播报都由平台负责，
 * 这里只做外观统一（`accent-color` 走主色 token）与标签排版。此前全站 31 个 checkbox、
 * 14 个 radio 各自用 accent-color 内联写色值，主色改名就会漏改。
 */
interface ChoiceBaseProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "children"> {
  readonly label: ReactNode;
  readonly description?: ReactNode;
}

function Choice({ kind, label, description, className, id, ...rest }: ChoiceBaseProps & { readonly kind: "checkbox" | "radio" }) {
  const generated = useId();
  const inputId = id ?? generated;
  return <label className={cn("ui-choice", className)} htmlFor={inputId}>
    <input {...rest} id={inputId} type={kind} className="ui-choice__input" />
    <span className="ui-choice__body">
      <span className="ui-choice__label">{label}</span>
      {description === undefined ? null : <span className="ui-choice__description">{description}</span>}
    </span>
  </label>;
}

export function Checkbox(props: ChoiceBaseProps) {
  return <Choice {...props} kind="checkbox" />;
}

export function Radio(props: ChoiceBaseProps) {
  return <Choice {...props} kind="radio" />;
}

export interface SwitchProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  /** 可见标签，同时作为可访问名称（通过 aria-labelledby 关联，不重复朗读）。 */
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly className?: string;
  readonly testId?: string;
}

/**
 * 开关：语义是 `role="switch"` 的按钮，不是勾选框。
 *
 * 用按钮而不是 `<input type="checkbox" role="switch">`：原生按钮自带 Space/Enter 激活与
 * 焦点顺序，`aria-checked` 直接表达开/关；而复选框的 `checked` 在部分读屏里仍读作「已勾选」。
 * 轨道与滑块是装饰，对读屏隐藏。
 */
export function Switch({ checked, onChange, label, description, disabled = false, id, className, testId }: SwitchProps) {
  const generated = useId();
  const labelId = id ?? generated;
  return <div className={cn("ui-switch-row", className)} data-testid={testId}>
    <span className="ui-switch-row__text">
      <span className="ui-switch-row__label" id={labelId}>{label}</span>
      {description === undefined ? null : <span className="ui-switch-row__description">{description}</span>}
    </span>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      disabled={disabled}
      className="ui-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="ui-switch__track" aria-hidden="true"><span className="ui-switch__thumb" /></span>
    </button>
  </div>;
}
