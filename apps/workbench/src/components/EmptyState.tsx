import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * 共享空态：一次说清「没有什么」「为什么」和「下一步」。
 *
 * 只消费既有 token（暖白画布、墨绿主操作、细分隔线、无阴影），不新增色值、圆角或第二套尺寸。
 * 内容按实际高度靠上排列，不套卡片、不铺满整列，与协作页未选择任务时的规则一致。
 * 图标是装饰，含义由标题文字承担，因此对读屏隐藏；标题保留真实 heading 以维持文档大纲，
 * 只有不承担层级的紧凑场合才用 `as="p"`。
 */
export default function EmptyState({ icon: Icon, title, description, actions,
  size = "regular", as: Heading = "p", testId }: {
  readonly icon?: LucideIcon;
  readonly title: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly size?: "regular" | "compact";
  readonly as?: "h2" | "h3" | "p";
  readonly testId?: string;
}) {
  return <div className={`empty-state empty-state--${size}`} data-testid={testId}>
    {Icon && <span className="empty-state__icon" aria-hidden="true"><Icon /></span>}
    <Heading className="empty-state__title">{title}</Heading>
    {description && <p className="empty-state__description">{description}</p>}
    {actions && <div className="empty-state__actions">{actions}</div>}
  </div>;
}