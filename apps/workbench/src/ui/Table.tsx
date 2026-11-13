import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";
import { cn } from "./cn";

/**
 * 表格：表头、行、单元格、空态与滚动容器。
 *
 * 页面此前各写一套 `.data-table` / `.pv-table` / `.ui-lab-table`，三者的表头底色、
 * 行分隔线、单元格内边距各不相同。这里给一套组合件，外观统一走 token；
 * 列宽与换行仍由调用方的 `className` 决定——那是布局，不是视觉规范。
 */
export interface TableProps {
  readonly children: ReactNode;
  readonly caption?: string;
  readonly dense?: boolean;
  /** 表头在滚动容器内吸附。 */
  readonly stickyHead?: boolean;
  readonly className?: string;
  readonly testId?: string;
}

export function Table({ children, caption, dense = false, stickyHead = false, className, testId }: TableProps) {
  return <div className="ui-table-wrap">
    <table
      className={cn("ui-table", dense && "ui-table--dense", stickyHead && "ui-table--sticky", className)}
      data-testid={testId}
    >
      {caption === undefined ? null : <caption className="ui-table__caption">{caption}</caption>}
      {children}
    </table>
  </div>;
}

export function TableHead({ children }: { readonly children: ReactNode }) {
  return <thead className="ui-table__head">{children}</thead>;
}

export function TableBody({ children }: { readonly children: ReactNode }) {
  return <tbody className="ui-table__body">{children}</tbody>;
}

export function TableRow({ children, selected = false, className }: {
  readonly children: ReactNode;
  readonly selected?: boolean;
  readonly className?: string;
}) {
  return <tr className={cn("ui-table__row", selected && "is-selected", className)} aria-selected={selected || undefined}>{children}</tr>;
}

export function TableHeaderCell({ children, align, className, ...rest }: Omit<ThHTMLAttributes<HTMLTableCellElement>, "align"> & { readonly align?: "start" | "end" | "center" }) {
  return <th {...rest} scope="col" className={cn("ui-table__th", align === "end" && "is-end", align === "center" && "is-center", className)}>{children}</th>;
}

export function TableCell({ children, align, className, ...rest }: Omit<TdHTMLAttributes<HTMLTableCellElement>, "align"> & { readonly align?: "start" | "end" | "center" }) {
  return <td {...rest} className={cn("ui-table__td", align === "end" && "is-end", align === "center" && "is-center", className)}>{children}</td>;
}

/** 表格空态：占满整行、与表头同宽，文案说清「为什么空」而不是只说「没有数据」。 */
export function TableEmpty({ colSpan, children }: { readonly colSpan: number; readonly children: ReactNode }) {
  return <tr className="ui-table__empty-row"><td className="ui-table__empty" colSpan={colSpan}>{children}</td></tr>;
}
