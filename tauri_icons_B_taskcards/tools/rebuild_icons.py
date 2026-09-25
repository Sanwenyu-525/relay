#!/usr/bin/env python3
"""Export an existing RGBA image to a consistent Tauri desktop icon set.
No AI generation, tracing, recolouring or composition changes are performed.
Requires Python 3.10+ and Pillow. Uses only Pillow and the standard library.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import shutil
import struct
from pathlib import Path

try:
    from PIL import Image
except ImportError as exc:
    raise SystemExit('Pillow is required. Install it with: python -m pip install Pillow') from exc

PNG_SIZES = (16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512, 1024)
ICO_ORDER = (32, 16, 20, 24, 40, 48, 64, 96, 128, 256)
CONFIG = {'bundle': {'icon': [
    'icons/32x32.png', 'icons/128x128.png', 'icons/128x128@2x.png',
    'icons/icon.png', 'icons/icon.icns', 'icons/icon.ico'
]}}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def png_bytes(image: Image.Image) -> bytes:
    out = io.BytesIO()
    image.save(out, format='PNG', optimize=True)
    return out.getvalue()


def resize_rgba(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    # Alpha-premultiplied filtering avoids invisible RGB values leaking into edges.
    if image.size == size:
        return image.copy()
    return image.convert('RGBa').resize(size, Image.Resampling.LANCZOS).convert('RGBA')


def normalize(source: Path) -> tuple[Image.Image, dict]:
    with Image.open(source) as im:
        original = im.convert('RGBA')
    alpha = original.getchannel('A')
    clean = original.copy()
    # Remove virtually invisible alpha speckles, not visible glow or artwork.
    clean.putalpha(alpha.point(lambda v: 0 if v <= 3 else v))
    box = clean.getchannel('A').getbbox()
    if box is None:
        raise ValueError('The source image has no visible non-transparent pixels.')
    artwork = clean.crop(box)
    # Uniform 4% safety margin on the longer dimension; preserve aspect ratio.
    side = math.ceil(max(artwork.size) / 0.92)
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    position = ((side - artwork.width) // 2, (side - artwork.height) // 2)
    # Deliberately do not pass a mask here: that would multiply alpha twice.
    canvas.paste(artwork, position)
    master = resize_rgba(canvas, (1024, 1024))
    metadata = {
        'source_size': list(original.size),
        'source_mode': 'RGBA',
        'source_sha256': sha256(source),
        'source_alpha_range': list(alpha.getextrema()),
        'removed_alpha_values': [0, 1, 2, 3],
        'visible_crop_box': list(box),
        'normalized_native_canvas_size': side,
        'master_size': [1024, 1024],
        'long_axis_safety_margin_fraction': 0.04,
        'resampling': 'Lanczos on premultiplied RGBA, direct from master for each size',
        'redesigned': False,
        'sharpened': False,
        'background_added': False,
    }
    return master, metadata


def dib_payload(image: Image.Image) -> bytes:
    image = image.convert('RGBA')
    w, h = image.size
    rgba = image.tobytes()
    # Bottom-up 32-bit BGRA XOR bitmap.
    xor = bytearray()
    and_mask = bytearray()
    stride = ((w + 31) // 32) * 4
    for y in range(h - 1, -1, -1):
        mask_row = bytearray(stride)
        for x in range(w):
            i = (y * w + x) * 4
            r, g, b, a = rgba[i:i+4]
            xor.extend((b, g, r, a))
            if a == 0:
                mask_row[x // 8] |= 1 << (7 - x % 8)
        and_mask.extend(mask_row)
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0,
                         len(xor), 0, 0, 0, 0)
    return header + xor + and_mask


def write_ico(path: Path, images: dict[int, Image.Image]) -> list[dict]:
    offset = 6 + 16 * len(ICO_ORDER)
    entries, payloads, description = [], [], []
    for n in ICO_ORDER:
        payload = png_bytes(images[n]) if n == 256 else dib_payload(images[n])
        encoded = 0 if n == 256 else n
        entries.append(struct.pack('<BBBBHHII', encoded, encoded, 0, 0,
                                   1, 32, len(payload), offset))
        payloads.append(payload)
        description.append({'size': [n, n], 'bit_depth': 32,
                            'encoding': 'PNG' if n == 256 else 'BGRA DIB + AND mask'})
        offset += len(payload)
    path.write_bytes(struct.pack('<HHH', 0, 1, len(entries)) + b''.join(entries) + b''.join(payloads))
    return description


def write_icns(path: Path, images: dict[int, Image.Image]) -> list[dict]:
    # Exact desktop size/type family referenced by Tauri's App Icons guide.
    # Legacy 16/32 px use lossless raw RGB plus a separate 8-bit alpha mask.
    chunks: list[tuple[bytes, bytes]] = [
        (b'is32', images[16].convert('RGB').tobytes()),
        (b's8mk', images[16].getchannel('A').tobytes()),
        (b'ic11', png_bytes(images[32])),
        (b'il32', images[32].convert('RGB').tobytes()),
        (b'l8mk', images[32].getchannel('A').tobytes()),
        (b'ic12', png_bytes(images[64])),
        (b'ic07', png_bytes(images[128])),
        (b'ic13', png_bytes(images[256])),
        (b'ic08', png_bytes(images[256])),
        (b'ic14', png_bytes(images[512])),
        (b'ic09', png_bytes(images[512])),
        (b'ic10', png_bytes(images[1024])),
    ]
    toc = b''.join(tag + struct.pack('>I', len(data) + 8) for tag, data in chunks)
    body = b'TOC ' + struct.pack('>I', len(toc) + 8) + toc
    body += b''.join(tag + struct.pack('>I', len(data) + 8) + data for tag, data in chunks)
    path.write_bytes(b'icns' + struct.pack('>I', len(body) + 8) + body)
    return [{'type': t.decode('ascii'), 'bytes': len(d)} for t, d in chunks]


def verify(pack: Path, images: dict[int, Image.Image], meta: dict) -> dict:
    icons = pack / 'src-tauri' / 'icons'
    results = {
        'file_validation': 'PASS',
        'source_processing': meta,
        'png_files': [],
        'ico_layers_in_file_order': [],
        'icns_layers': [],
        'platform_validation': {
            'user_project_build': 'NOT_RUN: user repository is not present',
            'windows_desktop_and_taskbar': 'NOT_RUN: not a Windows desktop session',
            'macos_dock': 'NOT_RUN: not a macOS desktop session',
        },
    }
    for p in sorted(icons.glob('*.png')):
        raw = p.read_bytes()
        assert raw[:8] == b'\x89PNG\r\n\x1a\n'
        w, h, bit_depth, color_type = struct.unpack('>IIBB', raw[16:26])
        assert w == h and bit_depth == 8 and color_type == 6, (p, w, h, bit_depth, color_type)
        with Image.open(p) as im:
            im.load()
            assert im.mode == 'RGBA'
            assert im.getpixel((0, 0))[3] == 0
            results['png_files'].append({'file': str(p.relative_to(pack)), 'size': [w, h],
                                         'mode': 'RGBA', 'bit_depth_per_channel': 8,
                                         'alpha_range': list(im.getchannel('A').getextrema())})
    # Read the *actual* ICO directory (Pillow sorts its internal entries by size).
    ico_path = icons / 'icon.ico'
    data = ico_path.read_bytes()
    reserved, kind, count = struct.unpack_from('<HHH', data, 0)
    assert (reserved, kind, count) == (0, 1, len(ICO_ORDER))
    previous_end = 6 + count * 16
    with Image.open(ico_path) as ico:
        for i, expected in enumerate(ICO_ORDER):
            w, h, colors, reserved, planes, bpp, length, offset = struct.unpack_from('<BBBBHHII', data, 6 + i * 16)
            w, h = w or 256, h or 256
            assert (w, h, bpp, planes) == (expected, expected, 32, 1)
            assert offset == previous_end and offset + length <= len(data)
            previous_end = offset + length
            # Compare every decoded frame against the corresponding exported PNG.
            decoded = ico.ico.getimage((w, h)).convert('RGBA')
            assert decoded.tobytes() == images[expected].tobytes(), ('ICO pixels mismatch', expected)
            results['ico_layers_in_file_order'].append({'index': i, 'size': [w, h], 'bits': bpp,
                                                        'decoded_pixels_match_png': True,
                                                        'encoding': 'PNG' if data[offset:offset+8] == b'\x89PNG\r\n\x1a\n' else 'DIB'})
    assert previous_end == len(data)
    icns_path = icons / 'icon.icns'
    raw = icns_path.read_bytes()
    assert raw[:4] == b'icns' and struct.unpack_from('>I', raw, 4)[0] == len(raw)
    with Image.open(icns_path) as icns:
        for size in sorted(icns.info['sizes']):
            decoded = icns.icns.getimage(size).convert('RGBA')
            actual_size = size[0] * size[2]
            assert decoded.size == (actual_size, actual_size)
            assert decoded.tobytes() == images[actual_size].tobytes(), ('ICNS pixels mismatch', size)
            results['icns_layers'].append({'logical_size': [size[0], size[1]], 'scale': size[2],
                                           'pixel_size': actual_size, 'decoded_pixels_match_png': True})
    assert len(results['icns_layers']) == 10
    for ref in CONFIG['bundle']['icon']:
        assert (pack / 'src-tauri' / ref).is_file(), ref
    results['configuration_paths_exist'] = True
    results['ico_first_layer_is_32x32'] = True
    return results


def build(source: Path, pack: Path) -> dict:
    if not source.is_file():
        raise FileNotFoundError(source)
    for d in ('source', 'assets', 'src-tauri/icons', 'config', 'verification'):
        (pack / d).mkdir(parents=True, exist_ok=True)
    original_copy = pack / 'source' / 'original.png'
    if source.resolve() != original_copy.resolve():
        shutil.copy2(source, original_copy)
    master, meta = normalize(original_copy)
    master.save(pack / 'assets' / 'app-icon.png', optimize=True)
    images = {n: resize_rgba(master, (n, n)) for n in PNG_SIZES}
    icons = pack / 'src-tauri' / 'icons'
    for n, im in images.items():
        im.save(icons / f'{n}x{n}.png', optimize=True)
    images[256].save(icons / '128x128@2x.png', optimize=True)
    images[512].save(icons / 'icon.png', optimize=True)
    write_ico(icons / 'icon.ico', images)
    write_icns(icons / 'icon.icns', images)
    (pack / 'config' / 'tauri.bundle-icon.fragment.json').write_text(
        json.dumps(CONFIG, indent=2) + '\n', encoding='utf-8')
    optional = {'bundle': {'windows': {'nsis': {
        'installerIcon': 'icons/icon.ico', 'uninstallerIcon': 'icons/icon.ico'
    }}}}
    (pack / 'config' / 'tauri.nsis-icons.optional.fragment.json').write_text(
        json.dumps(optional, indent=2) + '\n', encoding='utf-8')
    report = verify(pack, images, meta)
    (pack / 'verification' / 'report.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return report


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=root / 'source' / 'original.png')
    parser.add_argument('--output', type=Path, default=root)
    args = parser.parse_args()
    report = build(args.source.resolve(), args.output.resolve())
    print(f"PASS: {len(report['png_files'])} RGBA PNG files; {len(report['ico_layers_in_file_order'])} ICO layers; {len(report['icns_layers'])} ICNS layers")
    print('ICO order:', ', '.join(str(x['size'][0]) for x in report['ico_layers_in_file_order']))
    print('No Tauri project build or operating-system icon display was executed.')


if __name__ == '__main__':
    main()
