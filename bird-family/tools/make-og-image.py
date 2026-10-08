#!/usr/bin/env python3
"""
Build assets/og-image.png — the 1200x630 preview card shown when the link is
shared on Facebook, iMessage, Slack, etc.  Re-run after changing the text below.

    python3 tools/make-og-image.py
"""
import pathlib
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
W, H = 1200, 630
PAPER, SLATE, GOLD, SOFT = "#faf7f2", "#22363f", "#b9933f", "#5c5955"

SERIF = "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


img = Image.new("RGB", (W, H), PAPER)
d = ImageDraw.Draw(img)

# soft gold wash at the top
for y in range(0, 260):
    a = int(40 * (1 - y / 260))
    d.line([(0, y), (W, y)], fill=(243 - a // 6, 230 - a // 4, 199 + a // 3))

d.rectangle([(0, H - 14), (W, H)], fill=SLATE)

def center(text, y, f, fill):
    w = d.textlength(text, font=f)
    d.text(((W - w) / 2, y), text, font=f, fill=fill)

center("RIVERDALE, UTAH", 118, font(SANS, 24), GOLD)
center("Support the Bird Family", 170, font(SERIF, 70), SLATE)
center("After the fire of October 1, 2026", 268, font(SERIF, 30), SOFT)
center("Help Lindsey and her sons rebuild.", 345, font(SANS, 28), SOFT)
center("supportthebirdfamily.org", 460, font(SANS, 32), SLATE)

out = ROOT / "assets" / "og-image.png"
img.save(out, optimize=True)
print("wrote", out)
