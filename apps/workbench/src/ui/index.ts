/**
 * Relay UI —— 全站唯一的组件入口。
 *
 * 分层：
 * - `Button` / `IconButton` / `FormField` / `Input` / `Textarea` / `Select` / `Checkbox` /
 *   `Radio` / `Switch` / `Badge` / `Alert` / `Spinner` / `Skeleton`：本目录实现；
 * - `Dialog` / `EmptyState` / `PageHeader`：已在 `components/` 里成熟实现，这里只做统一出口，
 *   不复制第二份——新页面从 `src/ui` 取，避免出现两套对话框或两个空态。
 *
 * 样式：本目录的 `ui.css` 只补基础类缺的部分，其余复用 `styles.css`。
 * 因此从本模块导入任何组件都会带上 `ui.css`，不需要页面单独引样式。
 */
import "./ui.css";

export { default as Button, buttonClassName } from "./Button";
export type { ButtonProps, ButtonSize, ButtonVariant, ButtonClassNameOptions } from "./Button";

export { default as IconButton } from "./IconButton";
export type { IconButtonProps } from "./IconButton";

export { FormField, Input, Textarea, Select } from "./FormField";
export type { FormFieldProps, InputProps, TextareaProps, SelectProps } from "./FormField";

export { Checkbox, Radio, Switch } from "./Choice";
export type { SwitchProps } from "./Choice";

export { default as Badge } from "./Badge";
export type { BadgeProps, BadgeTone } from "./Badge";

export { default as Alert } from "./Alert";
export type { AlertProps, AlertTone } from "./Alert";

export { Spinner, Skeleton } from "./Loading";
export type { SpinnerProps, SkeletonProps } from "./Loading";

export { default as Dialog } from "../components/AppDialog";
export { default as EmptyState } from "../components/EmptyState";
export { default as PageHeader } from "../components/PageHeader";

export { cn } from "./cn";
