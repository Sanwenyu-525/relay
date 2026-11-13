import type { CSSProperties, ReactNode } from "react";
import { cn } from "./cn";

/**
 * 容器类基础件：卡片、分隔线、滚动区。
 *
 * 卡片只有一种外观（1px 分隔线 + 容器圆角 + 纸面底色 + 无投影）；页面若需要更强的层级，
 * 用间距与标题层级，不再叠第二层边框或投影。`.pv-card` 是页面档的历史皮肤，
 * 两者的色与圆角都来自同一批 token，新代码直接用 `<Card>`。
 */
export interface CardProps {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  readonly children?: ReactNode;
  /** 紧凑内边距（列表行容器等）。 */
  readonly dense?: boolean;
  readonly className?: string;
  readonly testId?: string;
}

export function Card({ title, description, actions, footer, children, dense = false, className, testId }: CardProps) {
  const head = title !== undefined || description !== undefined || actions !== undefined;
  return <section className={cn("ui-card", dense && "ui-card--dense", className)} data-testid={testId}>
    {head ? <header className="ui-card__head">
      <div className="ui-card__heading">
        {title === undefined ? null : <h3 className="ui-card__title">{title}</h3>}
        {description === undefined ? null : <p className="ui-card__description">{description}</p>}
      </div>
      {actions === undefined ? null : <div className="ui-card__actions">{actions}</div>}
    </header> : null}
    {children === undefined ? null : <div className="ui-card__body">{children}</div>}
    {footer === undefined ? null : <footer className="ui-card__footer">{footer}</footer>}
  </section>;
}

export interface DensityProps {
  /** comfortable = 工作台档（40/48px）；compact = 页面档（34px + 13px 正文）。 */
  readonly mode: "comfortable" | "compact";
  readonly children: ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly testId?: string;
}

/**
 * 密度作用域。
 *
 * 只重绑四个尺寸变量（控件高、紧凑控件高、正文与元信息字号），不重写任何组件规则——
 * 这样「同一种密度下同一语义只有一种尺寸」可以靠构造保证，而不是靠逐页改 CSS。
 * 页面档的既有实现（`.pv-page`）不需要它；新页面要紧凑排版时用它，而不是自己写字号。
 */
export function Density({ mode, children, className, style, testId }: DensityProps) {
  return <div className={cn(mode === "compact" && "ui-density-compact", className)} style={style} data-density={mode} data-testid={testId}>
    {children}
  </div>;
}

export interface SeparatorProps {
  readonly orientation?: "horizontal" | "vertical";
  readonly className?: string;
}

export function Separator({ orientation = "horizontal", className }: SeparatorProps) {
  return <hr
    className={cn("ui-separator", orientation === "vertical" && "ui-separator--vertical", className)}
    aria-orientation={orientation}
  />;
}

export interface ScrollAreaProps {
  readonly children: ReactNode;
  /** 高度上限（如 `24rem`）；不传则按内容撑开，滚动条仅在需要时出现。 */
  readonly maxHeight?: string;
  /** 可访问名称。可滚动区域必须能键盘聚焦，否则键盘用户滚不动。 */
  readonly label: string;
  readonly className?: string;
  readonly testId?: string;
}

export function ScrollArea({ children, maxHeight, label, className, testId }: ScrollAreaProps) {
  return <div
    className={cn("ui-scroll", className)}
    style={maxHeight === undefined ? undefined : { maxHeight }}
    // 可滚动容器要能被 Tab 到，否则键盘用户无法滚动（内容仍可读，但滚动行为缺失）。
    tabIndex={0}
    role="region"
    aria-label={label}
    data-testid={testId}
  >
    {children}
  </div>;
}
