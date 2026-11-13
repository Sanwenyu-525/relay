import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "./cn";

/**
 * 按钮：全站唯一的按钮入口。
 *
 * 它不重新定义视觉——类名仍是 styles.css 里那套 `.primary-button` / `.secondary-button` /
 * `.danger-button` / `.text-button`，所以已有页面把 `<button className="primary-button">`
 * 换成 `<Button variant="primary">` 时 DOM 与像素完全不变。这一层的价值是三件：
 *
 * 1. 变体只有四档，语义固定（danger 只给不可逆或终止性操作，见 styles.css 的注释）；
 * 2. `busy` 同时置 `disabled` 与 `aria-busy`，不需要每个页面各写一次；
 * 3. `buttonClassName()` 供 `<Link>` 这类不能是 `<button>` 的入口复用同一套类名。
 */
export type ButtonVariant = "primary" | "secondary" | "danger" | "text";
/** md = 工作台档（control.height.prominent），sm = 控件档（control.height）。页面档由 .pv-page 覆写，不在这里判断。 */
export type ButtonSize = "md" | "sm";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "primary-button",
  secondary: "secondary-button",
  danger: "danger-button",
  text: "text-button"
};

export interface ButtonClassNameOptions {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly block?: boolean;
  readonly className?: string;
}

export function buttonClassName({ variant = "secondary", size = "md", block = false, className }: ButtonClassNameOptions = {}): string {
  return cn(VARIANT_CLASS[variant], size === "sm" && "ui-button--sm", block && "ui-button--block", className);
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  /** React 19 把 ref 当普通 prop 传给函数组件；调用方要用它聚焦按钮时直接传即可。 */
  readonly ref?: Ref<HTMLButtonElement>;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** 占满父容器宽度；等价于旧的 `primary-button--wide`，但对四档变体都成立。 */
  readonly block?: boolean;
  /** 进行中：视觉降饱和（基座的 `[aria-busy]` 规则），同时禁用重复触发。 */
  readonly busy?: boolean;
  readonly icon?: LucideIcon;
  readonly children?: ReactNode;
  readonly type?: "button" | "submit" | "reset";
}

// 调用方写在 aria-busy 上的进行中语义不能被抹掉：`busy` 只负责置 true，其余情况原样透传
// （RelayConnectionDialog 的 readiness 检查就靠这个属性表达「正在检查」）。
export default function Button({ variant, size, block, busy, icon: Icon, className, children, type = "button", disabled, ref, ...rest }: ButtonProps) {
  return <button
    {...rest}
    ref={ref}
    type={type}
    className={buttonClassName({ variant, size, block, className })}
    disabled={disabled === true || busy === true}
    aria-busy={busy === true ? true : rest["aria-busy"]}
  >
    {Icon ? <Icon aria-hidden="true" /> : null}
    {children}
  </button>;
}
