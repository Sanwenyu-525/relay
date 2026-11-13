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
export { default as Drawer } from "./Drawer";
export type { DrawerProps } from "./Drawer";
export { default as EmptyState } from "../components/EmptyState";
export { default as PageHeader } from "../components/PageHeader";

// DropdownMenu 是 Menu 的语义别名：同一个 details 实现，不复制第二套浮层。
// 调用方按「下拉菜单」语义取名时用 DropdownMenu，按「更多操作」取名时用 Menu。
export { Menu, Menu as DropdownMenu, MenuItem, MenuSeparator, Popover } from "./Disclosure";
export type { MenuItemProps, MenuProps, PopoverProps } from "./Disclosure";

export { default as ContextMenu } from "./ContextMenu";
export type { ContextMenuAction, ContextMenuEntry, ContextMenuProps } from "./ContextMenu";

export { default as Tooltip } from "./Tooltip";
export type { TooltipProps } from "./Tooltip";

export { default as ResizableHandle, useResizeDrag } from "./ResizableHandle";
export type { ResizableHandleProps, ResizeDrag, ResizeDragOptions } from "./ResizableHandle";

export { default as Tabs } from "./Tabs";
export type { TabItem, TabsProps } from "./Tabs";

export { Card, Density, Separator, ScrollArea } from "./Surface";
export type { CardProps, DensityProps, ScrollAreaProps, SeparatorProps } from "./Surface";

export { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeaderCell, TableRow } from "./Table";
export type { TableProps } from "./Table";

export { default as Combobox } from "./Combobox";
export type { ComboboxOption, ComboboxProps } from "./Combobox";

// 反馈队列是既有成熟实现（FeedbackHost 挂在 AppShell，槽位按 variant/tone 排队）：
// 再写一个 Toast 组件只会出现两套计时与两处堆叠位置。
export { FeedbackHost, Notice, Snackbar, Toast } from "../components/Feedback";

export { cn } from "./cn";
