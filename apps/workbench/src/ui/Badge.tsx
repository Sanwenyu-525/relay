import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "./cn";

/**
 * 状态标签。
 *
 * 直接复用 `.status-chip` 与四档语气类，不另起一套 `.badge`：任务状态芯片
 * （StatusChip）与页面上的计数、范围、权限标签本来就是同一种东西，此前因为它们
 * 分属两个组件，同一个「警告」在两处用了不同底色。
 */
export type BadgeTone = "neutral" | "success" | "warning" | "danger";

export interface BadgeProps {
  readonly tone?: BadgeTone;
  readonly icon?: LucideIcon;
  readonly children: ReactNode;
  readonly className?: string;
  /** 补充说明走原生 title：浮层提示不在这里实现，见 design-system 的约定。 */
  readonly title?: string;
  readonly testId?: string;
}

export default function Badge({ tone = "neutral", icon: Icon, children, className, title, testId }: BadgeProps) {
  return <span className={cn("status-chip", `status-chip--${tone}`, className)} title={title} data-testid={testId}>
    {Icon ? <Icon aria-hidden="true" /> : null}
    {children}
  </span>;
}
