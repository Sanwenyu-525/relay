import type { ReactNode } from "react";

export interface FactBarCell {
  readonly label: string;
  readonly value?: ReactNode;
  readonly note?: ReactNode;
  readonly action?: ReactNode;
}

/**
 * 事实条：把「现在是什么 / 已经形成什么 / 证据在哪」并成一行等宽格。
 * 格数是布局参数，由调用方按页面语义给；这里不推导业务状态。
 */
export default function FactBar({ cells, label, testId }: {
  cells: readonly FactBarCell[];
  label: string;
  testId?: string;
}) {
  return <ul className="fact-bar" aria-label={label} data-testid={testId}>
    {cells.map((cell, index) => <li key={`${cell.label}:${index}`}>
      <span className="fact-bar-label">{cell.label}</span>
      {cell.value !== undefined && <span className="fact-bar-value">{cell.value}</span>}
      {cell.note !== undefined && <span className="fact-bar-note">{cell.note}</span>}
      {cell.action}
    </li>)}
  </ul>;
}