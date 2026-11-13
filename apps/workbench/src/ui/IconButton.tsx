import type { ButtonHTMLAttributes, Ref } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "./cn";

/**
 * 图标按钮。
 *
 * `label` 是必填项而不是可选项：图标按钮的可访问名称只能来自 aria-label/title，
 * 而 `title` 只对指针可见，键盘与读屏都拿不到。必填让「忘了写名称」变成类型错误。
 */
export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "type" | "children"> {
  /** 可访问名称，同时作为原生 tooltip。 */
  readonly label: string;
  readonly icon: LucideIcon;
  readonly size?: "md" | "sm";
  readonly tone?: "default" | "danger";
  readonly type?: "button" | "submit";
  readonly ref?: Ref<HTMLButtonElement>;
}

export default function IconButton({ label, icon: Icon, size = "md", tone = "default", className, type = "button", title, ref, ...rest }: IconButtonProps) {
  return <button
    {...rest}
    ref={ref}
    type={type}
    className={cn("icon-button", size === "sm" && "ui-icon-button--sm", tone === "danger" && "ui-icon-button--danger", className)}
    aria-label={label}
    title={title ?? label}
  >
    <Icon aria-hidden="true" />
  </button>;
}
