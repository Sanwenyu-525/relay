import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { clampCollaborationChatRatio, COLLABORATION_CHAT_RATIO_MAX, COLLABORATION_CHAT_RATIO_MIN,
  DEFAULT_COLLABORATION_LAYOUT } from "../lib/collaborationLayoutPreferences";

export default function CollaborationSplitter({ ratio, hidden, onRatioChange }: {
  ratio: number;
  hidden: boolean;
  onRatioChange: (ratio: number, commit: boolean) => void;
}) {
  const drag = useRef<{ pointerId: number; startX: number; startRatio: number; width: number; ratio: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    const width = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
    if (event.button !== 0 || drag.current !== null || width <= 0) return;
    event.preventDefault();
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startRatio: ratio, width, ratio };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current;
    if (state === null || state.pointerId !== event.pointerId) return;
    state.ratio = clampCollaborationChatRatio(state.startRatio + (event.clientX - state.startX) / state.width);
    onRatioChange(state.ratio, false);
  }
  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current;
    if (state === null || state.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* 捕获已释放 */ }
    onRatioChange(state.ratio, true);
  }
  function pressKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    onRatioChange(clampCollaborationChatRatio(ratio + (event.key === "ArrowLeft" ? -0.02 : 0.02)), true);
  }

  return <button type="button" role="separator" className={`collab-splitter${dragging ? " collab-splitter--dragging" : ""}`}
    hidden={hidden} data-testid="collab-splitter" aria-label="调整对话与成果比例" aria-orientation="vertical"
    aria-valuemin={COLLABORATION_CHAT_RATIO_MIN * 100} aria-valuemax={COLLABORATION_CHAT_RATIO_MAX * 100}
    aria-valuenow={Math.round(ratio * 100)} aria-valuetext={`对话 ${Math.round(ratio * 100)}%，成果 ${Math.round((1 - ratio) * 100)}%`}
    title="拖动或左右方向键调整比例；双击恢复默认"
    onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
    onKeyDown={pressKey} onDoubleClick={() => onRatioChange(DEFAULT_COLLABORATION_LAYOUT.chatRatio, true)} />;
}
