import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "./cn";

/**
 * 行内状态条：警告、错误、成功、说明。
 *
 * 与 `.receipt-message` 同一套配方（状态底色 + 35% 状态色的 1px 边框 + 控件圆角），
 * 取代页面里各自的 `.pv-warning` / `.pv-error` / `.warning-callout` / `.action-error`：
 * 那四处是同一语义的四份实现，边框色还分别是四个近似值。
 */
export type AlertTone = "info" | "success" | "warning" | "danger";

export interface AlertProps {
  readonly tone?: AlertTone;
  readonly title?: ReactNode;
  readonly icon?: LucideIcon;
  readonly children?: ReactNode;
  /** 右侧动作（重试、查看详情等），按钮用 `<Button size="sm">`。 */
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly testId?: string;
}

export default function Alert({ tone = "info", title, icon: Icon, children, actions, className, testId }: AlertProps) {
  return <div className={cn("ui-alert", `ui-alert--${tone}`, className)} data-testid={testId} role={tone === "danger" ? "alert" : "status"}>
    {Icon ? <Icon className="ui-alert__icon" aria-hidden="true" /> : null}
    <div className="ui-alert__body">
      {title === undefined ? null : <p className="ui-alert__title">{title}</p>}
      {children === undefined ? null : <div className="ui-alert__text">{children}</div>}
    </div>
    {actions === undefined ? null : <div className="ui-alert__actions">{actions}</div>}
  </div>;
}
