import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
 *
 * `arrow: true`（2026-10-25 起回退文件的提示）不再是「CSS 边框气泡 + 独立尾巴 SVG」：
 * 整枚气泡由一条闭合 path 画出（见 buildBubbleOutlinePath），填充与描边一次成形，没有拼接。
 */
export function usePathTooltip(getPath: () => string | null, testId = "path-tooltip",
  options: { readonly arrow?: boolean } = {}): {
  readonly tooltipHandlers: PathTooltipHandlers;
  readonly tooltipNode: React.ReactNode;
  /** 立即收起当前提示。悬浮提示与点击浮层共用同一锚点时（上下文圆环），打开浮层前
   *  调它一次，避免提示停在浮层底上叠成两层；取值函数返回 null 只挡住新开，收不掉已开的。 */
  readonly dismissTooltip: () => void;
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
    dismissTooltip: close,
    tooltipNode: shown === null ? null
      : <PathTooltipCard anchor={shown.anchor} text={shown.text} testId={testId}
        arrow={options.arrow === true} />
  };
}

const GAP_PX = 6;
const MARGIN_PX = 8;
/* —— 尾巴与轮廓几何（2026-10-25 重画为一体化轮廓）——
   此前的尾巴是独立 SVG：填充路径盖掉气泡底边框、描边路径靠 0.5px 对齐凑出连续，
   气泡贴视口边被夹住时尾巴还要单独挪去指着锚点——拼接感与偏移都来自这套结构。
   现在四角、四边、尾巴、圆尖由**同一条闭合 path**画出（buildBubbleOutlinePath），
   填充与描边一次成形；尾巴固定画在气泡水平正中（cx = width/2），气泡被视口夹住时
   整体平移、尾巴不单独补偿。
   形状规格（2026-10-25 任务书）：根部 18px 宽、外伸 9px、尖端 2px 圆角，左右完全对称。
   根部控制点与根结点同高——根部切线水平、与气泡边线共线，底边是「弯下去」不是「断开再接」；
   尖端前的控制点垂直——切线与尖端圆弧相切。整条轮廓一阶连续，没有折角与凹陷。
   调形状改 TAIL_ROOT_WIDTH / TAIL_HEIGHT / TAIL_TIP_RADIUS，调过渡快慢改两个 TANGENT_RUN。 */
const TAIL_ROOT_WIDTH = 18;
const TAIL_HEIGHT = 9;
const TAIL_TIP_RADIUS = 2;
const ROOT_TANGENT_RUN = 5;
const TIP_TANGENT_RUN = 2.5;
/** 尾巴尖与锚点之间的距离（可为负：负值表示尖略压过锚点上沿）。
 *  2026-10-24 用户连着收了两轮：先是「气泡离按钮太远」，这次「再减小 4px」，
 *  3 → -1，尖正好落到按钮上沿。tooltip 整棵子树 pointer-events: none，
 *  贴住甚至压过 1px 也不会挡住按钮的悬停与点击。 */
const TAIL_TIP_GAP_PX = -1;
/** SVG 盒子比气泡四周各外扩的余量：尾巴（9px）全部落在这圈里，SVG 完整包含自己的绘制，
 *  不依赖 overflow 行为（此前实测带 viewBox 的根 svg 会按 viewport 裁剪画出去的部分），
 *  投影的计算区域也足够。CSS 里 --path-tooltip-outline-pad 由组件按同一常量注入。 */
const OUTLINE_PAD_PX = 10;

export interface BubbleOutlineInput {
  /** 气泡外缘宽（= 卡片盒宽）。 */
  readonly width: number;
  /** 气泡外缘高（= 卡片盒高，不含尾巴）。 */
  readonly height: number;
  /** 描边宽（px）：路径整体向内缩一半，让 1px 描边的着墨范围与原 CSS border 重合。 */
  readonly strokeWidth: number;
  /** 气泡圆角（px，来自 --relay-radius-control）。 */
  readonly cornerRadius: number;
  /** false：尾巴在底边（气泡在锚点上方）；true：尾巴在顶边（气泡翻到锚点下方）。 */
  readonly flip: boolean;
}

/**
 * 一条闭合 path 画出「圆角矩形气泡 + 水平正中的尾巴」，填充与描边共用这一条轮廓。
 *
 * 坐标系：SVG 元素比气泡四周各外扩 OUTLINE_PAD_PX，气泡外缘落在
 * (pad, pad)–(pad+width, pad+height)，尾巴从气泡边线中点向外伸 TAIL_HEIGHT，
 * 全部画在 SVG 自己的盒子里。flip 时整幅绕 SVG 盒中心垂直镜像（y' = H − y，
 * 圆弧 sweep 反向），切线关系逐点保持。
 *
 * 尾巴中心恒等于气泡中心：cx = pad + width/2，与锚点在哪、气泡有没有被视口
 * 夹偏完全无关——夹住时整体偏移，不挪尾巴假装还指着锚点。
 */
export function buildBubbleOutlinePath(input: BubbleOutlineInput): string {
  const pad = OUTLINE_PAD_PX;
  const sw = Math.max(0.5, Math.min(Number.isFinite(input.strokeWidth) && input.strokeWidth > 0 ? input.strokeWidth : 1, 4));
  const boxHeight = input.height + 2 * pad;
  // flip：绕 SVG 盒中心垂直镜像，圆弧 sweep 随之反向。
  const y = (v: number) => (input.flip ? boxHeight - v : v);
  const sweep = input.flip ? 0 : 1;
  const x0 = pad + sw / 2;
  const x1 = pad + input.width - sw / 2;
  const yTop = pad + sw / 2;
  const yTailEdge = pad + input.height - sw / 2;
  const cx = pad + input.width / 2;
  const radius = Math.max(0, Math.min(input.cornerRadius, (x1 - x0) / 2, (yTailEdge - yTop) / 2));
  // 窄气泡下收着尾巴根，避免尾巴伸进圆角外面；tipR 至少留 0.5 保住圆尖。
  const rootHalf = Math.max(TAIL_TIP_RADIUS + 0.5,
    Math.min(TAIL_ROOT_WIDTH / 2, (x1 - x0) / 2 - radius - 1));
  const tipRadius = Math.min(TAIL_TIP_RADIUS, rootHalf - 0.5);
  const tipCenterY = pad + input.height + TAIL_HEIGHT - tipRadius;
  const n = (v: number): string => { const r = Math.round(v * 100) / 100; return Object.is(r, -0) ? "0" : String(r); };
  return [
    `M ${n(x0 + radius)} ${n(y(yTop))}`,
    `H ${n(x1 - radius)}`,
    `A ${n(radius)} ${n(radius)} 0 0 ${sweep} ${n(x1)} ${n(y(yTop + radius))}`,
    `V ${n(y(yTailEdge - radius))}`,
    `A ${n(radius)} ${n(radius)} 0 0 ${sweep} ${n(x1 - radius)} ${n(y(yTailEdge))}`,
    `H ${n(cx + rootHalf)}`,
    // 尾巴右侧：水平切出（与底边共线）→ 收拢到尖端右侧垂直进入圆弧。
    `C ${n(cx + rootHalf - ROOT_TANGENT_RUN)} ${n(y(yTailEdge))},`
      + ` ${n(cx + tipRadius)} ${n(y(tipCenterY - TIP_TANGENT_RUN))},`
      + ` ${n(cx + tipRadius)} ${n(y(tipCenterY))}`,
    `A ${n(tipRadius)} ${n(tipRadius)} 0 0 ${sweep} ${n(cx - tipRadius)} ${n(y(tipCenterY))}`,
    // 尾巴左侧镜像：离开圆弧垂直向上，水平切回底边。
    `C ${n(cx - tipRadius)} ${n(y(tipCenterY - TIP_TANGENT_RUN))},`
      + ` ${n(cx - rootHalf + ROOT_TANGENT_RUN)} ${n(y(yTailEdge))},`
      + ` ${n(cx - rootHalf)} ${n(y(yTailEdge))}`,
    `H ${n(x0 + radius)}`,
    `A ${n(radius)} ${n(radius)} 0 0 ${sweep} ${n(x0)} ${n(y(yTailEdge - radius))}`,
    `V ${n(y(yTop + radius))}`,
    `A ${n(radius)} ${n(radius)} 0 0 ${sweep} ${n(x0 + radius)} ${n(y(yTop))}`,
    "Z"
  ].join(" ");
}

/** 把 token 长度值解析成 px。token 是 rem（随根字号缩放）：标准属性的 computed value
 *  已折算成 px，自定义属性返回原始串，这里统一换算，解析不了时用回退值。 */
function lengthPx(raw: string, rootFontSize: number, fallback: number): number {
  const match = raw.trim().match(/^(-?\d+(?:\.\d+)?)(px|rem|em)?$/);
  if (match === null) return fallback;
  const value = Number.parseFloat(match[1]);
  if (match[2] === "rem" || match[2] === "em") return value * rootFontSize;
  return value;
}

interface Placement {
  readonly left: number; readonly top: number;
  /** 气泡在锚点上方还是下方：决定尾巴长在哪条边。 */
  readonly side: "above" | "below";
  /** 卡片盒尺寸（= 气泡外缘尺寸）与描边/圆角的 px 值：轮廓 path 按它们生成。 */
  readonly width: number; readonly height: number;
  readonly strokeWidth: number; readonly cornerRadius: number;
}

function samePlacement(a: Placement, b: Placement): boolean {
  return a.left === b.left && a.top === b.top && a.side === b.side
    && a.width === b.width && a.height === b.height
    && a.strokeWidth === b.strokeWidth && a.cornerRadius === b.cornerRadius;
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
    const measure = () => {
      const box = anchor.getBoundingClientRect();
      const width = card.offsetWidth;
      const height = card.offsetHeight;
      // 水平居中于锚点（2026-10-24 用户截图指令「tooltip 要居中」），仍夹在视口内：
      // 路径比视口宽时限位规则优先。夹住后气泡中心不再对着锚点，尾巴按气泡自身
      // 正中画（见 buildBubbleOutlinePath），不做单独补偿。
      const left = Math.max(MARGIN_PX,
        Math.min(box.left + box.width / 2 - width / 2,
          window.innerWidth - MARGIN_PX - width));
      // 带尾巴时按尾巴外伸高度留距，尖正好落到锚点边缘（TAIL_TIP_GAP_PX 微调）；
      // 翻到下方同一套距离，尾巴同样指着锚点边缘。
      const gap = arrow ? TAIL_HEIGHT + TAIL_TIP_GAP_PX : GAP_PX;
      const above = box.top - gap - height;
      const side = above >= MARGIN_PX ? "above" : "below";
      // 描边宽与圆角按当前 token 解析成 px（rem 值随根字号换算），
      // 轮廓描边的着墨范围与原 CSS border 逐像素重合。
      const style = window.getComputedStyle(card);
      const fontSize = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
      const strokeWidth = arrow ? lengthPx(style.getPropertyValue("--relay-border-width"), fontSize, 1) : 0;
      const cornerRadius = arrow
        ? lengthPx(style.borderTopLeftRadius || style.getPropertyValue("--relay-radius-control"), fontSize, 8)
        : 0;
      const next: Placement = {
        left, top: side === "above" ? above : box.bottom + gap, side, width, height, strokeWidth, cornerRadius
      };
      setPlaced((prev) => prev !== null && samePlacement(prev, next) ? prev : next);
    };
    measure();
    // 文本折行或字体就绪改变卡片尺寸时重算定位与轮廓。jsdom 没有 ResizeObserver，直接跳过。
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(measure);
      observer.observe(card);
      return () => observer.disconnect();
    }
  }, [anchor, text, arrow]);
  const outlinePath = useMemo(() => {
    if (!arrow || placed === null || placed.width <= 0 || placed.height <= 0) return null;
    return buildBubbleOutlinePath({
      width: placed.width, height: placed.height,
      strokeWidth: placed.strokeWidth, cornerRadius: placed.cornerRadius,
      flip: placed.side === "below"
    });
  }, [arrow, placed]);
  const outlinePadStyle = { "--path-tooltip-outline-pad": `${OUTLINE_PAD_PX}px` } as CSSProperties;
  const style = placed === null
    ? { visibility: "hidden" as const, ...outlinePadStyle }
    : { left: placed.left, top: placed.top, ...outlinePadStyle };
  return createPortal(<div ref={cardRef} className="path-tooltip" role="tooltip"
    data-testid={testId}
    data-arrow={arrow ? "true" : undefined}
    data-side={arrow ? placed?.side ?? "above" : undefined}
    style={style}>
    {arrow && <svg className="path-tooltip-outline" aria-hidden="true" focusable="false">
      {/* 单条闭合 path = 整枚气泡（含尾巴），填充与描边一次成形。z-index:-1 压到文字下层，
          投影挂在 SVG 上，沿整条轮廓（含尾巴）连续绘制——没有独立尾巴，没有底边遮挡补丁。 */}
      {outlinePath !== null && <path className="path-tooltip-outline-path" d={outlinePath} />}
    </svg>}
    {text}</div>, document.body);
}
