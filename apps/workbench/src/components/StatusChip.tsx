import { Ban, CheckCircle2, Circle, CircleDashed, CircleSlash, Clock, Timer } from "lucide-react";
import { taskStatusLabels, taskStatusTone } from "../lib/labels";
import type { TaskStatus } from "../types";

const icons = { INBOX: CircleDashed, READY: Circle, IN_PROGRESS: Timer, WAITING: Clock, BLOCKED: Ban, DONE: CheckCircle2, CANCELLED: CircleSlash };

export default function StatusChip({ status }: { status: TaskStatus }) {
  const Icon = icons[status];
  return <span className={`status-chip status-chip--${taskStatusTone(status)}`}><Icon aria-hidden="true" />{taskStatusLabels[status]}</span>;
}
