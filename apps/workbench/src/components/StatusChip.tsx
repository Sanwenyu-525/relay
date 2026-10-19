import { Ban, CheckCircle2, Circle, CircleDashed, CircleSlash, Clock, Timer } from "lucide-react";
import { taskStatusLabels, taskStatusTone } from "../lib/labels";
import type { TaskStatus } from "../types";

/** 状态图标与语气同 Chip 共用一份：卡片行首的色块图标与 Chip 不能各画一套。 */
export const taskStatusIcons = { INBOX: CircleDashed, READY: Circle, IN_PROGRESS: Timer, WAITING: Clock, BLOCKED: Ban, DONE: CheckCircle2, CANCELLED: CircleSlash };

export default function StatusChip({ status }: { status: TaskStatus }) {
  const Icon = taskStatusIcons[status];
  return <span className={`status-chip status-chip--${taskStatusTone(status)}`}><Icon aria-hidden="true" />{taskStatusLabels[status]}</span>;
}
