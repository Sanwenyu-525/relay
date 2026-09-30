"""Compose labelled evidence thumbnails; never alter the original screenshots."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

here = Path(__file__).resolve().parent
root = here.parents[3]
font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 22)
small = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 16)
pages = [
    ("collaboration", "协作工作区"), ("today", "今日"), ("tasks", "全部任务"),
    ("projects", "项目列表"), ("project-overview", "项目总览"), ("task-detail", "任务详情"),
    ("workbench-general", "通用工作台"), ("workbench-thesis", "论文工作台"), ("workbench-development", "开发工作台"),
    ("knowledge-reading", "知识阅读"), ("activity", "动态"), ("run", "运行记录"),
    ("reviews", "待审"), ("connections", "连接"), ("settings", "设置"),
]
tile_w, tile_h, label_h, gap = 496, 337, 34, 18
sheet = Image.new("RGB", (3 * tile_w + 4 * gap, 78 + 5 * (tile_h + label_h + gap)), "#f5f2ec")
draw = ImageDraw.Draw(sheet)
draw.text((gap, 12), "2026-09-30 · 主要页面实装截图总览", font=font, fill="#234d40")
draw.text((gap, 45), "只读同构夹具 · CSS 视口 1487×1010 · 以下为等比例缩略图；不代表 Windows / 特殊状态验收", font=small, fill="#565d56")
for i, (name, label) in enumerate(pages):
    x = gap + (i % 3) * (tile_w + gap)
    y = 78 + (i // 3) * (tile_h + label_h + gap)
    screenshot = Image.open(here / f"{name}-1487x1010.jpg").convert("RGB")
    draw.text((x, y), label, font=font, fill="#234d40")
    screenshot.thumbnail((tile_w, tile_h), Image.Resampling.LANCZOS)
    sheet.paste(screenshot, (x, y + label_h))
sheet.save(here / "page-overview.png")

reference = Image.open(root / "docs/frontend/mockups/2026-09-29/collaboration-dialogue-window.png").convert("RGB")
assert reference.size == (1487, 1058)
reference = reference.crop((0, 48, 1487, 1058))
actual = Image.open(here / "collaboration-1487x1010.jpg").convert("RGB")
assert actual.size == (1487, 1010)
comparison = Image.new("RGB", (2974, 1074), "#f5f2ec")
draw = ImageDraw.Draw(comparison)
draw.text((18, 12), "选定参考 · 仅裁去 48px 宿主标题栏", font=font, fill="#234d40")
draw.text((1505, 12), "本轮实现 · 浏览器客户区 1487×1010 · 只读夹具", font=font, fill="#234d40")
draw.text((18, 39), "两侧均原始内容像素，未缩放；业务绑定与未接入能力以实现真实状态为准", font=small, fill="#565d56")
comparison.paste(reference, (0, 64))
comparison.paste(actual, (1487, 64))
comparison.save(here / "collaboration-reference-final.png")
print("Created page-overview.png and collaboration-reference-final.png")
