import { Ban, CheckCircle2, Circle, CircleDashed, CircleSlash, Clock, Timer } from "lucide-react";
import { taskStatusLabels, taskStatusTone } from "../lib/labels";
import type { TaskStatus } from "../types";
import { Badge } from "../ui";

/** 状态图标与语气同 Chip 共用一份：卡片行首的色块图标与 Chip 不能各画一套。 */
export const taskStatusIcons = { INBOX: CircleDashed, READY: Circle, IN_PROGRESS: Timer, WAITING: Clock, BLOCKED: Ban, DONE: CheckCircle2, CANCELLED: CircleSlash };

/**
 * 任务状态芯片。
 *
 * 2026-11-12（UI-UNIFY-01）改为 Badge 的薄封装：此前它是全站唯一手写 `.status-chip` 的地方，
 * 而页面上的计数、范围、权限标签各自拼同样的类名，同一个「警告」在两处用了不同底色。
 * DOM 与类名保持不变（`status-chip status-chip--<tone>`），因此不影响既有断言与样式。
 */
export default function StatusChip({ status }: { status: TaskStatus }) {
  return <Badge tone={taskStatusTone(status)} icon={taskStatusIcons[status]}>{taskStatusLabels[status]}</Badge>;
}
