from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[4]
evidence = Path(__file__).resolve().parent
reference = Image.open(root / 'docs/frontend/mockups/2026-09-29/collaboration-dialogue-window.png').convert('RGB')
reference = reference.crop((0, 48, 1487, 1058))
reference.save(evidence / 'reference-content-1487x1010.png')
before = Image.open(evidence / 'before-1487x1010.jpg').convert('RGB')
after = Image.open(evidence / 'after-1487x1010.jpg').convert('RGB')
images = [('Reference (native title bar cropped)', reference), ('Before', before), ('After', after)]
canvas = Image.new('RGB', (1487 * 3, 1050), 'white')
draw = ImageDraw.Draw(canvas)
for index, (label, im) in enumerate(images):
    draw.text((index * 1487 + 16, 12), label, fill='black')
    canvas.paste(im, (index * 1487, 40))
canvas.save(evidence / 'comparison-full.png')
regions = [('Header / facts', (208, 64, 878, 385)), ('Document', (880, 128, 1487, 568)), ('Decision', (880, 570, 1487, 1010))]
canvas = Image.new('RGB', (1400, 1390), 'white')
draw = ImageDraw.Draw(canvas)
y = 0
for label, box in regions:
    for index, (state, im) in enumerate([('Reference', reference), ('After', after)]):
        crop = im.crop(box)
        draw.text((index * 700 + 12, y + 10), label + ' - ' + state, fill='black')
        canvas.paste(crop, (index * 700, y + 40))
    y += box[3] - box[1] + 60
canvas.save(evidence / 'comparison-focused.png')
tool_reference = Image.open(root / 'docs/frontend/mockups/2026-09-29/collaboration-development-tools.png').convert('RGB').crop((0, 48, 1487, 1058))
tool_actual = Image.open(evidence / 'tools-1487x1010.jpg').convert('RGB')
canvas = Image.new('RGB', (2974, 1050), 'white')
draw = ImageDraw.Draw(canvas)
draw.text((16, 12), 'Tools reference (concept Git state)', fill='black')
draw.text((1503, 12), 'Actual (Git not connected; capability boundary retained)', fill='black')
canvas.paste(tool_reference, (0, 40))
canvas.paste(tool_actual, (1487, 40))
canvas.save(evidence / 'comparison-tools.png')
