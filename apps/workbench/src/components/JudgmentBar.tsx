import { Scale } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

export interface JudgmentBarProps extends Omit<ComponentPropsWithoutRef<"section">, "title"> {
  title: ReactNode;
  description?: ReactNode;
  /** 与标题同行的次级事实，例如多请求切换或执行权边界；不另占一行。 */
  head?: ReactNode;
  actions?: ReactNode;
  details?: ReactNode;
  children?: ReactNode;
  tone?: "warning" | "neutral";
  label?: string;
}

/**
 * 判断条：待人工决定的入口。对象、条件与影响常驻，技术身份与完整依据按需展开。
 * 动作审批不能只留紧凑形态；UNKNOWN、结果待核对与执行权事实也不收进 details。
 * 这里不持有命令，写入仍由调用方的判断组件负责。
 */
export default function JudgmentBar({ title, description, actions, details, children, head,
  tone = "warning", label = "等待你的判断", className, ...rest }: JudgmentBarProps) {
  return <section className={`judgment-bar judgment-bar--${tone}${className ? ` ${className}` : ""}`}
    aria-label={label} {...rest}>
    <div className="judgment-bar-main">
      <div className="judgment-bar-head">
        <p className="judgment-bar-title"><Scale aria-hidden="true" />{title}</p>
        {head && <div className="judgment-bar-head-extra">{head}</div>}
      </div>
      {description && <p className="judgment-bar-description">{description}</p>}
      {children}
    </div>
    {actions && <div className="judgment-bar-actions">{actions}</div>}
    {details && <div className="judgment-bar-details">{details}</div>}
  </section>;
}