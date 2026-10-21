import { isTauri } from "@tauri-apps/api/core";
import { Image } from "@tauri-apps/api/image";
import { getCurrentWindow } from "@tauri-apps/api/window";

// 任务栏把 overlay 缩到约 16px 显示，1 个逻辑像素只剩半个实际像素：细节一律砍到「一层底 + 一条边 + 一组数字」。
const BADGE_SIZE = 32;
const EDGE_WIDTH = 2;
const FILL_COLOR = "#BE3E2C";
// 任务栏底色由系统主题决定，纯白在浅底上会糊成一块，改用纸面色收一条细边。
const EDGE_COLOR = "#FBFCFA";
const TEXT_COLOR = "#FBFCFA";
// Segoe 的 lining 数字高约 0.7em，按它把基线推到视觉中心；textBaseline: middle 对齐的是整行盒，数字会偏下。
const CAP_HEIGHT_RATIO = 0.7;

/** null 表示没有需要人工介入的事项，角标撤掉；超过两位统一显示 99+。 */
export function badgeLabel(count: number): string | null {
  if (!Number.isFinite(count) || count < 1) return null;
  const value = Math.floor(count);
  return value > 99 ? "99+" : String(value);
}

type Glyph = { width: number; height: number; font: number };

/** 位数决定外形：一位数留圆盘，多位数换成胶囊，数字不必挤进圆里才被读出来。数值为底色外形，描边再向外一圈。 */
function glyphFor(label: string): Glyph {
  if (label.length <= 1) return { width: 28, height: 28, font: 22 };
  if (label.length === 2) return { width: 30, height: 26, font: 20 };
  return { width: 30, height: 22, font: 13 };
}

/** 两端半圆加一段直边。宽度收到等于高度时就是正圆，所以一位与多位共用这条路径。 */
function fillStadium(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const radius = height / 2;
  const shoulder = width / 2 - radius;
  const center = BADGE_SIZE / 2;
  ctx.beginPath();
  ctx.arc(center - shoulder, center, radius, Math.PI / 2, Math.PI * 1.5);
  ctx.arc(center + shoulder, center, radius, -Math.PI / 2, Math.PI / 2);
  ctx.closePath();
  ctx.fill();
}

export function drawBadge(ctx: CanvasRenderingContext2D, label: string): void {
  const glyph = glyphFor(label);
  ctx.clearRect(0, 0, BADGE_SIZE, BADGE_SIZE);
  ctx.fillStyle = EDGE_COLOR;
  fillStadium(ctx, glyph.width + EDGE_WIDTH, glyph.height + EDGE_WIDTH);
  ctx.fillStyle = FILL_COLOR;
  fillStadium(ctx, glyph.width, glyph.height);
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = `700 ${glyph.font}px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(label, BADGE_SIZE / 2, BADGE_SIZE / 2 + (glyph.font * CAP_HEIGHT_RATIO) / 2);
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
