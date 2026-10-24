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
export function usePathTooltip(getPath: () => string | null, testId = "path-tooltip",
  options: { readonly arrow?: boolean } = {}): {
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
      : <PathTooltipCard anchor={shown.anchor} text={shown.text} testId={testId}
        arrow={options.arrow === true} />
  };
}

const GAP_PX = 6;
const MARGIN_PX = 8;
/* 尾巴几何（2026-10-24 用户给的形状规格）：两条对称二次贝塞尔弧，向内收拢在底部中间
   交汇成一个尖。28×16 是规格值，路径里 W/2±2 决定「收得多急」，改这两个 2 调弧度。

   控制点 y 取 0，而不是规格示例里的 1：二次贝塞尔起点的切线方向 = 控制点 − 起点，
   y=1 时根部仍有约 4.8° 倾角，28px 跨度上积出 2px 落差，接缝处就是一个折角——
   用户说的「还是断开的」正是这个折角。y=0 时根部切线完全水平、与气泡底边共线，
   底边看起来是「弯下去」，不是「断掉再接一段」。 */
const ARROW_WIDTH = 22;
const ARROW_HEIGHT = 12;
/** 尾巴尖与锚点之间的距离（可为负：负值表示尖略压过锚点上沿）。
 *  2026-10-24 用户连着收了两轮：先是「气泡离按钮太远」，这次「再减小 4px」，
 *  3 → -1，尖正好落到按钮上沿。tooltip 整棵子树 pointer-events: none，
 *  贴住甚至压过 1px 也不会挡住按钮的悬停与点击。 */
const ARROW_TIP_GAP_PX = -1;
/** 描边中心线比填充顶边高 0.5px：气泡底边框 1px 宽，中心落在 border-box 底边内侧 0.5px，
   描边也对齐到这条中心线，两根线才是同一条，不会上下错半像素。 */
const ARROW_STROKE_Y = -0.5;
const ARROW_FILL_CURVES = `Q${ARROW_WIDTH / 2 - 2} 0 ${ARROW_WIDTH / 2} ${ARROW_HEIGHT}`
  + ` Q${ARROW_WIDTH / 2 + 2} 0 ${ARROW_WIDTH} 0`;
const ARROW_STROKE_CURVES = `Q${ARROW_WIDTH / 2 - 2} ${ARROW_STROKE_Y} ${ARROW_WIDTH / 2} ${ARROW_HEIGHT}`
  + ` Q${ARROW_WIDTH / 2 + 2} ${ARROW_STROKE_Y} ${ARROW_WIDTH} ${ARROW_STROKE_Y}`;
const ARROW_PATH = `M0 ${ARROW_STROKE_Y} ${ARROW_STROKE_CURVES}`;
/** 填充比描边多出上面 2px：那一段压在气泡底边（border-box 底边往上 2px）上，
 *  把底边框在尾巴宽度内整段盖掉，形成真正的开口。描边不含这条顶边，
 *  否则闭合路径的顶边会被再描一次，开口又封上了。 */
const ARROW_FILL_PATH = `M0 -2 L0 0 ${ARROW_FILL_CURVES} L${ARROW_WIDTH} -2 Z`;
/** viewBox 必须把上面那 2px 也框进来。靠 `overflow: visible` 画出去是不行的：
 *  有 viewBox 的根 svg 仍按 viewport 裁剪，实测那 2px 被切掉，气泡底边框照旧横穿尾巴根部
 *  ——看起来就是「尾巴贴上去」而不是「从气泡里长出来」。 */
const ARROW_VIEWBOX = `0 -2 ${ARROW_WIDTH} ${ARROW_HEIGHT + 2}`;
const ARROW_BOX_HEIGHT = ARROW_HEIGHT + 2;

interface Placement {
  readonly left: number; readonly top: number;
  /** 气泡在锚点上方还是下方：决定尾巴长在哪条边。 */
  readonly side: "above" | "below";
  /** 尾巴相对气泡左缘的水平偏移，指向**锚点中心**而不是气泡中心。 */
  readonly arrowLeft: number;
}

/** 浮层本体：优先放在锚点上方，上方放不下就翻到下方；水平居中于锚点并夹在视口内。
 *  纯展示，不接收指针。 */
function PathTooltipCard({ anchor, text, testId, arrow }: {
  readonly anchor: HTMLElement; readonly text: string; readonly testId: string; readonly arrow: boolean;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<Placement | null>(null);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (card === null) return;
    const box = anchor.getBoundingClientRect();
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    // 水平居中于锚点（2026-10-24 用户截图指令「tooltip 要居中」）：此前左缘贴锚点左缘，
    // 锚点是窄元素（目录名按钮、24px 圆环）时提示整块偏到右侧，读起来不指着谁。
    // 居中之后仍夹在视口内：路径比视口宽时限位规则优先，不会溢出左右边缘。
    const left = Math.max(MARGIN_PX,
      Math.min(box.left + box.width / 2 - width / 2,
        window.innerWidth - MARGIN_PX - width));
    const gap = arrow ? ARROW_HEIGHT + ARROW_TIP_GAP_PX : GAP_PX;
    const above = box.top - gap - height;
    const side = above >= MARGIN_PX ? "above" : "below";
    // 尾巴按锚点中心定位：气泡贴到视口边被夹住时，气泡中心与锚点中心不再重合，
    // 按气泡居中画出来的尖会指向别处。夹进气泡内，避免尖角顶到圆角外面。
    const arrowLeft = Math.max(ARROW_WIDTH / 2 + 2,
      Math.min(width - ARROW_WIDTH / 2 - 2, box.left + box.width / 2 - left));
    setPlaced({ left, top: side === "above" ? above : box.bottom + GAP_PX, side, arrowLeft });
  }, [anchor, text]);
  return createPortal(<div ref={cardRef} className="path-tooltip" role="tooltip"
    data-testid={testId}
    data-arrow={arrow ? "true" : undefined}
    data-side={arrow ? placed?.side ?? "above" : undefined}
    style={placed === null ? { visibility: "hidden" }
      : {
        left: placed.left,
        top: placed.top,
        "--path-tooltip-arrow-left": `${placed.arrowLeft}px`,
        "--path-tooltip-arrow-width": `${ARROW_WIDTH}px`,
        "--path-tooltip-arrow-height": `${ARROW_BOX_HEIGHT}px`
      } as CSSProperties}>
    {arrow && <svg className="path-tooltip-arrow" width={ARROW_WIDTH} height={ARROW_BOX_HEIGHT}
      viewBox={ARROW_VIEWBOX} aria-hidden="true" focusable="false">
      {/* 填充与描边拆成两条路径：填充的顶边要压住气泡底边那一小段、把尾巴和气泡连成一体，
          若与描边写在同一条闭合路径里，顶边会被再描一次，反而把开口重新封上。
          形状是两条对称的二次贝塞尔弧（Q）：根部控制点几乎贴底边，所以根部与气泡相切、
          两侧向内收拢，在底边中点交汇成一个尖。改 ARROW_WIDTH/HEIGHT 调大小，
          改下面两个 ±2 调收拢的弧度。 */}
      <path className="path-tooltip-arrow-fill" d={ARROW_FILL_PATH} />
      <path className="path-tooltip-arrow-line" d={ARROW_PATH} />
    </svg>}
    {text}</div>, document.body);
}
