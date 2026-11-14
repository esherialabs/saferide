"""Derive lossless animation layers from the official wordmarks (requires Pillow)."""
from pathlib import Path
import bisect
import json

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DESTINATION = ROOT / 'assets' / 'brand-wordmark'
# Boundaries between the eight highlight shapes in the 1200x263 source artwork.
LETTER_BOUNDARIES = [167, 327, 426, 596, 783, 857, 1030]


def split_wordmark(source_name, variant):
    source = Image.open(ROOT / 'assets' / source_name).convert('RGBA')
    colour_geometry = Image.open(ROOT / 'assets' / 'logo.png').convert('RGBA')
    assert source.size == (1200, 263), 'Review boundaries if official artwork changes.'
    lettering = Image.new('RGBA', source.size)
    highlights = [Image.new('RGBA', source.size) for _ in range(8)]
    for y in range(source.height):
        for x in range(source.width):
            pixel = source.getpixel((x, y))
            r, g, b, alpha = pixel
            if not alpha:
                continue
            reference = colour_geometry.getpixel((x, y))
            is_highlight = reference[3] and max(reference[:3]) - min(reference[:3]) > 12 and max(reference[:3]) > 20
            # The inverted lettering has a warm white fill, not a coloured highlight.
            is_light_letter = min(r, g, b) >= 230 and max(r, g, b) - min(r, g, b) <= 30
            if is_highlight and not is_light_letter:
                highlights[bisect.bisect_right(LETTER_BOUNDARIES, x)].putpixel((x, y), pixel)
            else:
                lettering.putpixel((x, y), pixel)

    recombined = Image.new('RGBA', source.size)
    boxes = []
    for index, layer in enumerate(highlights):
        box = layer.getbbox()
        assert box is not None
        left, top, right, bottom = box
        cropped = layer.crop(box)
        cropped.save(DESTINATION / f'{variant}-highlight-{index}.png', optimize=True)
        recombined.alpha_composite(cropped, (left, top))
        boxes.append({'left': left, 'top': top, 'width': right - left, 'height': bottom - top})
    recombined = Image.alpha_composite(recombined, lettering)
    # Ignore invisible RGB values; compositing must match on light and dark canvases.
    for canvas in ('white', 'black'):
        background = Image.new('RGBA', source.size, canvas)
        assert Image.alpha_composite(background, recombined).tobytes() == Image.alpha_composite(background, source).tobytes()
    lettering.save(DESTINATION / f'{variant}-letters.png', optimize=True)
    return boxes


if __name__ == '__main__':
    DESTINATION.mkdir(exist_ok=True)
    manifest = {
        'width': 1200,
        'height': 263,
        'light': split_wordmark('logo.png', 'light'),
        'dark': split_wordmark('logo-inverted.png', 'dark'),
    }
    (DESTINATION / 'layers.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print('Light and dark layers reconstruct the official logos exactly on both canvases.')
