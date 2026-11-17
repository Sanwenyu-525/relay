import type { RefObject } from "react";

import { handleTabListKeyDown } from "../lib/tabNavigation";

/** 知识类型页签的最小形状；只依赖视图层已有的枚举与文案。 */
export interface KnowledgeKindTab {
  readonly kind: string;
  readonly label: string;
}

/**
 * 知识类型页签。
 *
 * 从 KnowledgeView 抽出以保持原生的方向键/焦点行为：切换前先保护草稿，
 * 焦点由页面通过 tabListRef 统一恢复。这里不复制页面状态，也不发请求。
 */
export interface KnowledgeKindTabsProps {
  readonly kinds: readonly KnowledgeKindTab[];
  readonly kind: string;
  readonly pending: boolean;
  readonly tabId: string;
  readonly tabListRef: RefObject<HTMLElement | null>;
  readonly onSwitch: (kind: string) => void;
}

export default function KnowledgeKindTabs({ kinds, kind, pending, tabId, tabListRef, onSwitch }: KnowledgeKindTabsProps) {
  return <nav ref={tabListRef as RefObject<HTMLElement>} className="knowledge-tabs" role="tablist" aria-label="知识类型"
    onKeyDown={handleTabListKeyDown}>{kinds.map((item) =>
      <button key={item.kind} type="button" className={`subnav-item${kind === item.kind ? " subnav-item--active" : ""}`}
        role="tab" id={`${tabId}-tab-${item.kind}`} aria-controls={`${tabId}-panel`} aria-selected={kind === item.kind}
        tabIndex={kind === item.kind ? 0 : -1} disabled={pending}
        data-testid={`knowledge-tab-${item.kind}`} onClick={() => onSwitch(item.kind)}>{item.label}</button>)}</nav>;
}
