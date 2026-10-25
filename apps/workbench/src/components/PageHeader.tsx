import { useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useDetailsMenu } from "../lib/popoverMenu";

export interface PageHeaderProps {
  title: string;
  /** 状态、执行者与版本等并列事实，由调用方决定用哪种芯片表达。 */
  status?: ReactNode;
  meta?: ReactNode;
  /** 页眉小字（overline）：原型 V5.28 页头的第一层。仅在加 `.pv-page` 皮肤的页面显示。 */
  overline?: string;
  lede?: ReactNode;
  /** 首屏常驻动作。一个决策区只在这里放一个主操作。 */
  actions?: ReactNode;
  /** 次级与诊断动作收进「更多操作」；不在首屏常驻，不代表可以隐藏。 */
  more?: ReactNode;
  /**
   * 标题指向确切对象页。省略号截断的标题因此有一个键盘可达的完整名称入口：
   * `title` 属性只能悬停读取，辅助技术与键盘都拿不到完整名称。
   */
  titleHref?: string;
  headingLevel?: 1 | 2;
  testId?: string;
  children?: ReactNode;
}

/**
 * 页面页头：名称、状态、元信息、目标句与常驻动作各占固定层级。
 * 这里只负责结构与键盘行为，不持有业务状态，也不决定哪些动作可以折叠。
 */
export default function PageHeader({ title, status, meta, overline, lede, actions, more, titleHref, headingLevel = 1, testId, children }: PageHeaderProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const moreRef = useRef<HTMLDetailsElement>(null);
  // 「更多操作」是浮层：点到外面、按 Esc、或打开别的浮层时收起（焦点还给 ⋯）。
  // 组词期间的 Esc 属于输入法，不关浮层；其余关闭只收起面板，不丢弃草稿或未决命令。
  // 语义收口在 popoverMenu，与其余浮层同一套规矩。
  useDetailsMenu(moreRef);

  return <header className="page-head" data-testid={testId}>
    <div className="page-head-main">
      {overline !== undefined && <p className="page-head-overline" aria-hidden="true">{overline}</p>}
      <div className="page-head-title">
        <Heading title={title}>{titleHref === undefined ? title : <Link className="page-head-title-link" to={titleHref}
          title={title} data-testid={testId === undefined ? undefined : `${testId}-title-link`}>{title}</Link>}</Heading>
        {status}
      </div>
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