import { isTauri } from "@tauri-apps/api/core";
import { Image } from "@tauri-apps/api/image";
import { getCurrentWindow } from "@tauri-apps/api/window";

// 任务栏把 overlay 缩到约 16px 显示，所以 32px 画布是 2× 素材：细节一律砍到「一层底 + 一组数字」。
const BADGE_SIZE = 32;
// 墨迹（圆盘/胶囊）的右下缘落在画布 30 处，留 1 设备像素空气。旧版把 28px 圆盘 + 2px 白圈铺满整块画布，
// Windows 按槽位整块缩放后红盘吃掉整个 overlay，读起来像贴在图标上的红贴纸；收进 30 才落回「角标」的体量。
const INK_RIGHT = 30;
const INK_BOTTOM = 30;
// 取红色相的暖侧（H≈11°）而不是正红：与前一轮的 #BE3E2C 相比彩度、明度都低一档，和图标里的橙色圆环同族；
// 白字对比 5.3:1，对 #1f1f1f / #e6e6e6 两种任务栏底色都在 3:1 以上，深浅底都不糊。
const FILL_COLOR = "#BC4630";
// 纸面偏暖的白，避免纯白在红底上炸出光晕。
const INK_COLOR = "#FFF7F3";
// 600 而不是 700：缩小后 700 的白字会在红底上糊成一坨。字体优先 Segoe UI Variable Text
// （小字号档，字形比 Display 更开阔），回落 Display 与经典 Segoe UI。
const FONT_WEIGHT = 600;
const FONT_FAMILY = '"Segoe UI Variable Text", "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
// measureText 拿不到墨迹包围盒时（非浏览器环境、字体未就绪）才用的估值：Segoe 数字高约 0.7em。
const CAP_HEIGHT_RATIO = 0.7;

/** null 表示没有需要人工介入的事项，角标撤掉；超过两位统一显示 99+。 */
export function badgeLabel(count: number): string | null {
  if (!Number.isFinite(count) || count < 1) return null;
  const value = Math.floor(count);
  return value > 99 ? "99+" : String(value);
}

type Shape = { width: number; height: number; font: number };

/** 位数决定外形：一位数小圆盘，两位数短胶囊（1.36 长宽比，不拉成药丸），三位数沿用同一胶囊只缩字号。 */
function shapeFor(label: string): Shape {
  if (label.length <= 1) return { width: 24, height: 24, font: 18.5 };
  if (label.length === 2) return { width: 30, height: 22, font: 14.5 };
  return { width: 30, height: 22, font: 11.5 };
}

/** 两端半圆加一段直边。宽度收到等于高度时 shoulder 为 0，两个圆心重合，正圆与胶囊共用这条路径。 */
function stadium(ctx: CanvasRenderingContext2D, cx: number, cy: number, width: number, height: number): void {
  const radius = height / 2;
  const shoulder = Math.max(0, width / 2 - radius);
  ctx.beginPath();
  ctx.arc(cx - shoulder, cy, radius, Math.PI / 2, Math.PI * 1.5);
  ctx.arc(cx + shoulder, cy, radius, -Math.PI / 2, Math.PI / 2);
  ctx.closePath();
}

/**
 * 数字按墨迹居中，不是按文本盒居中：textAlign 的 center 只对齐 advance 宽度，`1` 的字面比 advance 窄、
 * 上下也各有留白，几何居中会让它看着偏左偏上。actualBoundingBox* 给的是真实墨迹范围，直接拿它算偏移；
 * 取不到时退回 cap-height 估值，保证任何环境都有确定结果。
 */
function inkShift(ctx: CanvasRenderingContext2D, label: string, font: number): [number, number] {
  try {
    const metrics = ctx.measureText(label);
    const ascent = metrics.actualBoundingBoxAscent;
    const descent = metrics.actualBoundingBoxDescent;
    const left = metrics.actualBoundingBoxLeft;
    const right = metrics.actualBoundingBoxRight;
    if (Number.isFinite(ascent) && ascent > 0 && Number.isFinite(descent)
      && Number.isFinite(left) && Number.isFinite(right)) {
      return [-(right - left) / 2, (ascent - descent) / 2];
    }
  } catch { /* 度量不可用就走估值，不把绘制搞崩 */ }
  return [0, (font * CAP_HEIGHT_RATIO) / 2];
}

export function drawBadge(ctx: CanvasRenderingContext2D, label: string): void {
  const shape = shapeFor(label);
  const centerX = INK_RIGHT - shape.width / 2;
  const centerY = INK_BOTTOM - shape.height / 2;
  ctx.clearRect(0, 0, BADGE_SIZE, BADGE_SIZE);
  // 只画一层底：没有白圈、没有描边、没有渐变。深浅任务栏靠底色本身的对比撑住。
  ctx.fillStyle = FILL_COLOR;
  stadium(ctx, centerX, centerY, shape.width, shape.height);
  ctx.fill();
  ctx.fillStyle = INK_COLOR;
  ctx.font = `${FONT_WEIGHT} ${shape.font}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const [dx, dy] = inkShift(ctx, label, shape.font);
  ctx.fillText(label, centerX + dx, centerY + dy);
}

let lastLabel: string | null | undefined;

export async function syncTaskbarBadge(count: number): Promise<void> {
  if (!isTauri()) return;
  const label = badgeLabel(count);
  if (label === lastLabel) return;
  lastLabel = label;
  try {
    const window = getCurrentWindow();
    if (label === null) {
      await window.setOverlayIcon(undefined);
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = BADGE_SIZE;
    canvas.height = BADGE_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    drawBadge(ctx, label);
    const { data } = ctx.getImageData(0, 0, BADGE_SIZE, BADGE_SIZE);
    await window.setOverlayIcon(await Image.new(new Uint8Array(data), BADGE_SIZE, BADGE_SIZE));
  } catch (caught) {
    // 角标只是提醒的副本：宿主不支持或权限缺失时保留应用内铃铛计数，不打断轮询。
    console.warn("taskbar_badge_failed", caught);
  }
}
