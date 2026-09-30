from pathlib import Path
from PIL import Image, ImageDraw

evidence = Path(__file__).resolve().parent
reference = Image.open(evidence / 'reference-content-1487x1010.png').convert('RGB')
final = Image.open(evidence / 'final-dialogue-1487x1010.jpg').convert('RGB')
assert reference.size == final.size == (1487, 1010)
canvas = Image.new('RGB', (2974, 1050), 'white')
draw = ImageDraw.Draw(canvas)
for index, (label, im) in enumerate([('Reference (48px title bar cropped)', reference), ('Final browser capture', final)]):
    draw.text((index * 1487 + 16, 12), label, fill='black')
    canvas.paste(im, (index * 1487, 40))
canvas.save(evidence / 'comparison-final-full.png')

regions = [('Header / facts', (208, 64, 878, 385)), ('Document', (880, 128, 1487, 568)), ('Decision', (880, 570, 1487, 1010))]
canvas = Image.new('RGB', (1400, 1390), 'white')
draw = ImageDraw.Draw(canvas)
y = 0
for label, box in regions:
    for index, (state, im) in enumerate([('Reference', reference), ('Final', final)]):
        draw.text((index * 700 + 12, y + 10), label + ' - ' + state, fill='black')
        canvas.paste(im.crop(box), (index * 700, y + 40))
    y += box[3] - box[1] + 60
canvas.save(evidence / 'comparison-final-focused.png')

tool_reference = Image.open(evidence.parents[3] / 'docs/frontend/mockups/2026-09-29/collaboration-development-tools.png').convert('RGB').crop((0, 48, 1487, 1058))
tool_final = Image.open(evidence / 'final-tools-1487x1010.jpg').convert('RGB')
canvas = Image.new('RGB', (2974, 1050), 'white')
draw = ImageDraw.Draw(canvas)
for index, (label, im) in enumerate([('Tools reference (concept Git state)', tool_reference), ('Final (Git capability boundary retained)', tool_final)]):
    draw.text((index * 1487 + 16, 12), label, fill='black')
    canvas.paste(im, (index * 1487, 40))
canvas.save(evidence / 'comparison-final-tools.png')
