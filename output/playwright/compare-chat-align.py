from pathlib import Path
from PIL import Image

out = Path(__file__).parent
source = Image.open(r'C:/Users/ASUS/AppData/Local/Temp/codex-clipboard-cb164abe-4588-49d4-8b1f-87deebd6ae08.png').convert('RGB')
source = source.resize((2048, 1159), Image.Resampling.LANCZOS).crop((0, 0, 2048, 1112))
implementation = Image.open(out / 'new-conversation-aligned-2048.png').convert('RGB')
comparison = Image.new('RGB', (4096, 1112), 'white')
comparison.paste(source, (0, 0))
comparison.paste(implementation, (2048, 0))
comparison.save(out / 'new-conversation-reference-comparison.png')
focused = Image.new('RGB', (2320, 120), 'white')
focused.paste(source.crop((638, 986, 1798, 1106)), (0, 0))
focused.paste(implementation.crop((632, 986, 1792, 1106)), (1160, 0))
focused.save(out / 'new-conversation-composer-comparison.png')
