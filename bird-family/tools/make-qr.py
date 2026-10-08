#!/usr/bin/env python3
"""
Generate QR codes that point at the site.

    python3 tools/make-qr.py                      # uses the siteUrl in config.js
    python3 tools/make-qr.py https://example.com  # or any URL you like

Requires:  pip install "qrcode[pil]"

Writes:
    qr/supportthebirdfamily-qr.png   (2000 px, for print)
    qr/supportthebirdfamily-qr.svg   (vector, scales to any size)
    assets/site-qr.png               (600 px, used by the Share section)
"""
import pathlib
import re
import sys

import qrcode
import qrcode.image.svg

ROOT = pathlib.Path(__file__).resolve().parent.parent


def site_url_from_config():
    text = (ROOT / "config.js").read_text(encoding="utf-8")
    m = re.search(r"siteUrl:\s*['\"]([^'\"]+)['\"]", text)
    return m.group(1) if m else "https://supportthebirdfamily.org/"


def build(url):
    # Error correction "H" survives dirt, folds and a logo in the middle.
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, border=4)
    qr.add_data(url)
    qr.make(fit=True)

    out = ROOT / "qr"
    out.mkdir(exist_ok=True)

    png = qr.make_image(fill_color="#22363f", back_color="white").convert("RGB")
    png_big = png.resize((2000, 2000), resample=0)  # nearest neighbour keeps edges crisp
    png_big.save(out / "supportthebirdfamily-qr.png")

    (ROOT / "assets").mkdir(exist_ok=True)
    png.resize((600, 600), resample=0).convert("RGB").save(ROOT / "assets" / "site-qr.png")

    svg_factory = qrcode.image.svg.SvgPathImage
    svg = qrcode.make(url, error_correction=qrcode.constants.ERROR_CORRECT_H,
                      border=4, image_factory=svg_factory)
    svg.save(out / "supportthebirdfamily-qr.svg")

    print("QR code for", url)
    print(" ->", out / "supportthebirdfamily-qr.png")
    print(" ->", out / "supportthebirdfamily-qr.svg")
    print(" ->", ROOT / "assets" / "site-qr.png")


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else site_url_from_config())
