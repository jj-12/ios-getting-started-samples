#!/usr/bin/env python3
"""
Build assets/og-image.jpg — the 1200x630 preview card shown when the link is
shared on Facebook, iMessage, Slack, etc.  It is the family photo with a
soft band at the bottom carrying the site name.  Re-run after changing the
photo (assets/family.jpg) or the text below.

    python3 tools/make-og-image.py
"""
import pathlib
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
W, H = 1200, 630
PAPER, INK, GOLD = (248, 244, 236), (39, 49, 47), (176, 138, 74)
SERIF = "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


photo = Image.open(ROOT / "assets" / "family.jpg").convert("RGB")
# cover-fit the photo into the card
scale = max(W / photo.width, H / photo.height)
photo = photo.resize((round(photo.width * scale), round(photo.height * scale)), Image.LANCZOS)
left = (photo.width - W) // 2
top = 0  # keep the bottom of the photo: the youngest is there
card = photo.crop((left, top, left + W, top + H))

# soft paper band at the bottom
band_h = 112
band = Image.new("RGBA", (W, band_h), PAPER + (235,))
card = card.convert("RGBA")
card.alpha_composite(band, (0, H - band_h))
d = ImageDraw.Draw(card)
d.rectangle([(0, H - band_h), (W, H - band_h)], fill=GOLD + (255,))

def center(text, y, f, fill):
    w = d.textlength(text, font=f)
    d.text(((W - w) / 2, y), text, font=f, fill=fill)

center("SUPPORT THE BIRD FAMILY  ·  supportthebirdfamily.org", H - band_h + 18, font(SANS, 20), GOLD + (255,))
center("Help Lindsey and her sons rebuild after the fire", H - band_h + 50, font(SERIF, 34), INK + (255,))

out = ROOT / "assets" / "og-image.jpg"
card.convert("RGB").save(out, quality=88, optimize=True)
print("wrote", out)
