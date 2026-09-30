import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image


here = Path(__file__).resolve().parent
pages = json.loads((here / "pages.json").read_text(encoding="utf-8"))
latest = {page["name"]: page for page in pages}
images = []
for path in sorted(here.glob("*.jpg")):
    name = path.stem
    observation = latest.get(name, {})
    with Image.open(path) as image:
        size = list(image.size)
    images.append({
        **observation,
        "dom_observation_available": name in latest,
        "file": path.name,
        "image_pixels": size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "file_modified_at": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
    })

result = {
    "recorded_at": datetime.now(timezone.utc).isoformat(),
    "capture_method": "IAB tab.screenshot({fullPage:false}); original JPEG bytes",
    "note": "viewport, when present, is an observed CSS size; image_pixels records every original JPEG output without resizing. Some earlier DOM observations are archived rather than copied here. File modification time is not an asserted browser capture timestamp.",
    "images": images,
    "composites": [
        {"file": name, "sha256": hashlib.sha256((here / name).read_bytes()).hexdigest()}
        for name in ["page-overview.png", "collaboration-reference-final.png"]
    ],
}
(here / "final-page-metadata.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"images": len(images), "dom_observations": len(latest), "overflow_observations": [image["name"] for image in images if image.get("overflow")]}, ensure_ascii=False))
