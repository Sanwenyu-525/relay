import { useEffect, useRef, type ReactNode } from "react";

export interface PageHeaderProps {
  title: string;
  /** 状态、执行者与版本等并列事实，由调用方决定用哪种芯片表达。 */
  status?: ReactNode;
  meta?: ReactNode;
  lede?: ReactNode;
  /** 首屏常驻动作。一个决策区只在这里放一个主操作。 */
  actions?: ReactNode;
  /** 次级与诊断动作收进「更多操作」；不在首屏常驻，不代表可以隐藏。 */
  more?: ReactNode;
  headingLevel?: 1 | 2;
  testId?: string;
  children?: ReactNode;
}

/**
 * 页面页头：名称、状态、元信息、目标句与常驻动作各占固定层级。
 * 这里只负责结构与键盘行为，不持有业务状态，也不决定哪些动作可以折叠。
 */
export default function PageHeader({ title, status, meta, lede, actions, more, headingLevel = 1, testId, children }: PageHeaderProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const moreRef = useRef<HTMLDetailsElement>(null);

  // 组词期间的 Esc 属于输入法，不关浮层；其余关闭只收起面板，不丢弃草稿或未决命令。
  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      const node = moreRef.current;
      if (!node?.open || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      node.open = false;
      node.querySelector("summary")?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, []);

  return <header className="page-head" data-testid={testId}>
    <div className="page-head-main">
      <div className="page-head-title"><Heading>{title}</Heading>{status}</div>
      {meta && <p className="page-head-meta">{meta}</p>}
      {lede && <p className="page-head-lede">{lede}</p>}
      {children}
    </div>
    {(actions || more) && <div className="page-head-actions">
      {actions}
      {more && <details className="page-head-more" ref={moreRef}>
        <summary className="icon-button" aria-label="更多操作" title="更多操作"><span aria-hidden="true">…</span></summary>
        <div className="page-head-more-panel">{more}</div>
      </details>}
    </div>}
  </header>;
}