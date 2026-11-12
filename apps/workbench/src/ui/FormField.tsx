import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "./cn";

/**
 * 表单字段与三个文本控件。
 *
 * 样式不在这里重复：styles.css 已经用 `:where(input, select, textarea)` 统一了控件几何与
 * 各状态（hover / readonly / disabled / invalid），`.field` 系列统一了标签、提示与错误。
 * 这一层只负责**结构与无障碍接线**：label 关联、必填标记、错误用 role="alert" 播报、
 * `invalid` 同时落到 `aria-invalid` 与 `.field--invalid`（后者只管边框颜色）。
 */
export interface FormFieldProps {
  readonly label?: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly required?: boolean;
  /** 输入控件的 id；同一字段内的 label 与控件靠它关联。 */
  readonly htmlFor?: string;
  /** stack（默认）/ row（筛选条）/ grid（参数表）。 */
  readonly layout?: "stack" | "row" | "grid";
  readonly children: ReactNode;
  readonly className?: string;
  readonly testId?: string;
}

export function FormField({ label, hint, error, required = false, htmlFor, layout = "stack", children, className, testId }: FormFieldProps) {
  const invalid = error !== undefined && error !== null && error !== "";
  return <div
    className={cn("field", layout === "row" && "field--row", layout === "grid" && "field--grid", invalid && "field--invalid", className)}
    data-testid={testId}
  >
    {label === undefined ? null : <label className="field-label" htmlFor={htmlFor}>
      {label}
      {required ? <span className="field-required" aria-hidden="true">*</span> : null}
      {required ? <span className="visually-hidden">（必填）</span> : null}
    </label>}
    {children}
    {hint !== undefined && !invalid ? <p className="field-hint">{hint}</p> : null}
    {invalid ? <p className="field-error" role="alert">{error}</p> : null}
  </div>;
}

export type InputProps = ComponentPropsWithRef<"input"> & { readonly invalid?: boolean };

export function Input({ invalid, ...rest }: InputProps) {
  return <input {...rest} aria-invalid={invalid === true ? true : rest["aria-invalid"]} />;
}

export type TextareaProps = ComponentPropsWithRef<"textarea"> & { readonly invalid?: boolean };

export function Textarea({ invalid, ...rest }: TextareaProps) {
  return <textarea {...rest} aria-invalid={invalid === true ? true : rest["aria-invalid"]} />;
}

export type SelectProps = ComponentPropsWithRef<"select"> & { readonly invalid?: boolean };

export function Select({ invalid, ...rest }: SelectProps) {
  return <select {...rest} aria-invalid={invalid === true ? true : rest["aria-invalid"]} />;
}
