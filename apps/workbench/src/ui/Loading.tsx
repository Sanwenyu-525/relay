import { cn } from "./cn";

/**
 * 加载态：转圈与骨架。
 *
 * 两者的动画都在 `prefers-reduced-motion: reduce` 下停住（见 ui.css），停住之后仍要有
 * 「这里在加载」的可见表达——转圈留一圈静环，骨架留一块灰面，都不靠动画传意。
 */
export interface SpinnerProps {
  readonly size?: "sm" | "md";
  /** 读屏播报的进行中文案；视觉上不显示，不要用它替代页面已有的加载文案。 */
  readonly label?: string;
  readonly className?: string;
}

export function Spinner({ size = "md", label = "正在载入", className }: SpinnerProps) {
  return <span className={cn("ui-spinner", size === "sm" && "ui-spinner--sm", className)} role="status" aria-label={label} />;
}

export interface SkeletonProps {
  readonly width?: string;
  readonly height?: string;
  readonly lines?: number;
  readonly className?: string;
}

/** 骨架：只用于「结构已知、内容未到」的占位；不确定结构时用 Spinner + 文字。 */
export function Skeleton({ width, height, lines = 1, className }: SkeletonProps) {
  if (lines > 1) {
    return <span className={cn("ui-skeleton-stack", className)} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => <span
        key={index}
        className="ui-skeleton"
        style={{ width: index === lines - 1 ? "60%" : width, height }}
      />)}
    </span>;
  }
  return <span className={cn("ui-skeleton", className)} aria-hidden="true" style={{ width, height }} />;
}
