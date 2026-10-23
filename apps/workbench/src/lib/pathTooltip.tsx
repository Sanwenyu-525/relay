import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import "./PathTooltip.css";

export interface PathTooltipHandlers {
  readonly onMouseEnter: (event: { currentTarget: HTMLElement }) => void;
  readonly onMouseLeave: () => void;
  readonly onFocus: (event: { currentTarget: HTMLElement }) => void;
  readonly onBlur: () => void;
  readonly onKeyDown: (event: { key: string }) => void;
}

/**
 * 应用内的悬停短提示（2026-10-20 为目录名的完整路径而建，2026-10-22 起上下文用量圆环共用同一套）。
 *
 * 为什么不用原生 `title`：WebView2 与 Chromium 的 title 提示延迟约 1 秒、样式不可控，
 * 而且只在指针停在**带 title 的那个元素**上才出现——细条里目录名是按钮、整行是命中区，
 * 用户扫过去时什么也看不到；圆环只有 24px，同一个问题。这里改成悬停/聚焦即浮出，与
 * `RecentWorkRow` 的摘要卡同一套定位口径（fixed + portal，避免被细条、输入卡与滚动容器裁掉）。
 *
 * 入参是**取值函数**而不是值：AssistView 里目录路径要到组件体中后段才算出，而 hooks 必须
 * 在任何提前 return 之前调用。函数在悬停那一刻才读，既保住 hooks 顺序，也不把文本冻结在
 * 首次渲染上。返回值分成 handlers 与 node：handlers 挂到**原本那个元素**上，不新增包裹层，
 * 因此不改动细条/顶栏/工具行的 flex 布局；node 由 portal 挂到 body，不参与任何祖先的 overflow。
 */
export function usePathTooltip(getPath: () => string | null, testId = "path-tooltip"): {
  readonly tooltipHandlers: PathTooltipHandlers;
  readonly tooltipNode: React.ReactNode;
} {
  const getPathRef = useRef(getPath);
  getPathRef.current = getPath;
  const [shown, setShown] = useState<{ readonly anchor: HTMLElement; readonly text: string } | null>(null);

  const open = useCallback((anchor: HTMLElement | null) => {
    const path = getPathRef.current();
    if (anchor === null || path === null || path === "") return;
    setShown({ anchor, text: path });
  }, []);
  const close = useCallback(() => setShown(null), []);

  // 滚动与改窗宽时收起：fixed 定位不跟随锚点，留着会停在旧坐标上指着别处。
  useEffect(() => {
    if (shown === null) return;
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [shown, close]);

  return {
    tooltipHandlers: {
      onMouseEnter: (event) => open(event.currentTarget),
      onMouseLeave: close,
      onFocus: (event) => open(event.currentTarget),
      onBlur: close,
      onKeyDown: (event) => { if (event.key === "Escape") close(); }
    },
    tooltipNode: shown === null ? null
      : <PathTooltipCard anchor={shown.anchor} text={shown.text} testId={testId} />
  };
}

const GAP_PX = 6;
const MARGIN_PX = 8;

/** 浮层本体：优先放在锚点上方，上方放不下就翻到下方；水平夹在视口内。纯展示，不接收指针。 */
function PathTooltipCard({ anchor, text, testId }: {
  readonly anchor: HTMLElement; readonly text: string; readonly testId: string;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (card === null) return;
    const box = anchor.getBoundingClientRect();
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const left = Math.max(MARGIN_PX,
      Math.min(box.left, window.innerWidth - MARGIN_PX - width));
    const above = box.top - GAP_PX - height;
    setPlaced({ left, top: above >= MARGIN_PX ? above : box.bottom + GAP_PX });
  }, [anchor, text]);
  return createPortal(<div ref={cardRef} className="path-tooltip" role="tooltip"
    data-testid={testId} style={placed ?? { visibility: "hidden" }}>{text}</div>, document.body);
}
