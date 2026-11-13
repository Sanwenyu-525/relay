import AppDialog, { type AppDialogProps } from "../components/AppDialog";

/**
 * 抽屉：AppDialog 的 `variant="drawer"` 命名出口。
 *
 * 抽屉与对话框共用焦点陷阱、Esc、焦点归还与遮罩点击关闭（都在 AppDialog 里），
 * 这里不复制第二套行为，只让调用方按语义选择 `<Drawer>` 而不是记 variant 字符串。
 */
export type DrawerProps = Omit<AppDialogProps, "variant">;

export default function Drawer(props: DrawerProps) {
  return <AppDialog {...props} variant="drawer" />;
}
