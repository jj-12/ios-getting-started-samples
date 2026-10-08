#!/usr/bin/env python3
"""
Draw the muted botanical artwork used on the page (assets/floral-sprig.svg
and assets/floral-divider.svg).  Pure line art in sage and soft gold so it
sits quietly behind the text.  Re-run after tweaking colours or shapes.
"""
import math, pathlib, random

ROOT = pathlib.Path(__file__).resolve().parent.parent / "assets"
SAGE, SAGE_FILL = "#7f8f6a", "#dbe2cc"
GOLD, BLUSH, CREAM = "#b8954f", "#e9c9c6", "#f6ecd9"
ROSE, ROSE_DEEP, WINE = "#d9a6a6", "#c47f84", "#8f4e55"
DENIM, DENIM_FILL = "#7d91a8", "#c9d4df"
random.seed(7)


def bez(p0, p1, p2, p3, t):
    u = 1 - t
    return (u**3*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t**3*p3[0],
            u**3*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t**3*p3[1])


def tangent(p0, p1, p2, p3, t):
    u = 1 - t
    dx = 3*u*u*(p1[0]-p0[0]) + 6*u*t*(p2[0]-p1[0]) + 3*t*t*(p3[0]-p2[0])
    dy = 3*u*u*(p1[1]-p0[1]) + 6*u*t*(p2[1]-p1[1]) + 3*t*t*(p3[1]-p2[1])
    return math.degrees(math.atan2(dy, dx))


def leaf(x, y, angle, length, width, flip):
    """A pointed leaf with a mid-vein, drawn pointing along +x then rotated."""
    side = -1 if flip else 1
    d = (f"M0,0 C{length*0.35},{-width*side} {length*0.75},{-width*side} {length},0 "
         f"C{length*0.75},{width*0.45*side} {length*0.35},{width*0.45*side} 0,0 Z")
    vein = f"M{length*0.12},0 Q{length*0.55},{-width*0.15*side} {length*0.92},{-width*0.05*side}"
    return (f'<g transform="translate({x:.1f},{y:.1f}) rotate({angle:.1f})">'
            f'<path d="{d}" fill="{SAGE_FILL}" stroke="{SAGE}" stroke-width="1.4"/>'
            f'<path d="{vein}" fill="none" stroke="{SAGE}" stroke-width="0.9" opacity="0.8"/></g>')


def blossom(x, y, r, petals=5, rot=0, fill=None, stroke=None):
    fill = fill or BLUSH; stroke = stroke or GOLD
    out = [f'<g transform="translate({x:.1f},{y:.1f}) rotate({rot})">']
    for i in range(petals):
        a = 360 / petals * i
        out.append(f'<ellipse cx="{r*0.95:.1f}" cy="0" rx="{r*0.75:.1f}" ry="{r*0.48:.1f}" '
                   f'transform="rotate({a})" fill="{fill}" stroke="{stroke}" stroke-width="1.2"/>')
    out.append(f'<circle r="{r*0.33:.1f}" fill="{CREAM}" stroke="{GOLD}" stroke-width="1.2"/>')
    for i in range(6):
        a = math.radians(60 * i + 15)
        out.append(f'<circle cx="{math.cos(a)*r*0.2:.1f}" cy="{math.sin(a)*r*0.2:.1f}" r="0.9" fill="{GOLD}"/>')
    out.append('</g>')
    return "".join(out)


def bud(x, y, angle):
    return (f'<g transform="translate({x:.1f},{y:.1f}) rotate({angle:.1f})">'
            f'<path d="M0,0 C4,-7 9,-7 13,0 C9,4 4,4 0,0 Z" fill="{BLUSH}" stroke="{GOLD}" stroke-width="1.1"/>'
            f'<path d="M0,0 C3,-3 5,-3 8,0" fill="none" stroke="{GOLD}" stroke-width="0.8"/></g>')


def berries(x, y, n=3):
    out = []
    for i in range(n):
        a = math.radians(-60 + 60*i)
        bx, by = x + math.cos(a)*9, y + math.sin(a)*9
        out.append(f'<line x1="{x:.1f}" y1="{y:.1f}" x2="{bx:.1f}" y2="{by:.1f}" stroke="{SAGE}" stroke-width="1"/>')
        out.append(f'<circle cx="{bx:.1f}" cy="{by:.1f}" r="3" fill="{CREAM}" stroke="{GOLD}" stroke-width="1"/>')
    return "".join(out)


def stem(p0, p1, p2, p3, leaves, width=1.6, leaf_len=(26, 40), leaf_w=(9, 13), blooms=(), buds=(), berry_at=()):
    parts = [f'<path d="M{p0[0]},{p0[1]} C{p1[0]},{p1[1]} {p2[0]},{p2[1]} {p3[0]},{p3[1]}" '
             f'fill="none" stroke="{SAGE}" stroke-width="{width}" stroke-linecap="round"/>']
    for i, t in enumerate(leaves):
        x, y = bez(p0, p1, p2, p3, t)
        ang = tangent(p0, p1, p2, p3, t)
        side = 1 if i % 2 == 0 else -1
        L = random.uniform(*leaf_len); W = random.uniform(*leaf_w)
        parts.append(leaf(x, y, ang + side * random.uniform(38, 55), L, W, side < 0))
    for bl in blooms:
        t, r = bl[0], bl[1]
        fill = bl[2] if len(bl) > 2 else None; stroke = bl[3] if len(bl) > 3 else None
        x, y = bez(p0, p1, p2, p3, t)
        parts.append(blossom(x, y, r, rot=random.uniform(0, 72), fill=fill, stroke=stroke))
    for t in buds:
        x, y = bez(p0, p1, p2, p3, t)
        parts.append(bud(x, y, tangent(p0, p1, p2, p3, t) - 20))
    for t in berry_at:
        x, y = bez(p0, p1, p2, p3, t)
        parts.append(berries(x, y))
    return "".join(parts)


# ---------- Sprig: rises from bottom-left, arcs to the upper right ----------
sprig = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420" width="420" height="420">']
sprig.append(stem((30, 410), (60, 280), (150, 200), (250, 60),
                  leaves=[0.14, 0.24, 0.36, 0.47, 0.6, 0.7, 0.82],
                  blooms=[(0.995, 15)], buds=[0.9], berry_at=[0.55]))
sprig.append(stem((38, 402), (120, 350), (230, 300), (330, 230),
                  leaves=[0.3, 0.45, 0.62, 0.78], width=1.3, leaf_len=(20, 30), leaf_w=(7, 10),
                  blooms=[(0.99, 11)], buds=[0.88]))
sprig.append(stem((44, 408), (190, 400), (300, 390), (380, 330),
                  leaves=[0.25, 0.42, 0.6, 0.75, 0.9], width=1.2, leaf_len=(16, 26), leaf_w=(6, 9),
                  berry_at=[0.98]))
sprig.append('</svg>')
(ROOT / "floral-sprig.svg").write_text("\n".join(sprig))

# ---------- Divider: small symmetric ornament under headings ----------
div = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 28" width="160" height="28">']
div.append(f'<path d="M4,15 C30,15 50,14 76,14" fill="none" stroke="{SAGE}" stroke-width="1.3" stroke-linecap="round"/>')
div.append(f'<path d="M156,15 C130,15 110,14 84,14" fill="none" stroke="{SAGE}" stroke-width="1.3" stroke-linecap="round"/>')
for x, flip in [(22, False), (40, True), (56, False)]:
    div.append(leaf(x, 14, -28 if not flip else 28, 14, 5, flip))
for x, flip in [(138, True), (120, False), (104, True)]:
    div.append(leaf(x, 14, 180 + (28 if not flip else -28), 14, 5, flip))
div.append(blossom(80, 14, 6.5))
div.append('</svg>')
(ROOT / "floral-divider.svg").write_text("\n".join(div))
print("wrote", ROOT / "floral-sprig.svg", "and", ROOT / "floral-divider.svg")


# ---------- Bouquet: a fuller arrangement for the hero ----------
random.seed(11)
R = (ROSE, WINE); RD = (ROSE_DEEP, WINE); D = (DENIM_FILL, DENIM); C = (CREAM, GOLD)
bq = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 620" width="560" height="620">']
# back layer: tall stems
bq.append(stem((290, 600), (280, 470), (300, 300), (270, 80),
               leaves=[0.18, 0.27, 0.37, 0.46, 0.56, 0.66, 0.76, 0.86], width=1.9, leaf_len=(28, 42), leaf_w=(10, 14),
               blooms=[(0.995, 24) + R], buds=[0.93], berry_at=[0.62]))
bq.append(stem((282, 600), (220, 470), (120, 350), (70, 200),
               leaves=[0.22, 0.34, 0.46, 0.58, 0.7, 0.82], width=1.7, blooms=[(0.99, 19) + RD], buds=[0.91]))
bq.append(stem((298, 600), (360, 470), (430, 350), (490, 190),
               leaves=[0.2, 0.32, 0.44, 0.56, 0.68, 0.8], width=1.7, blooms=[(0.99, 20) + R], buds=[0.9]))
# middle layer
bq.append(stem((286, 600), (250, 520), (190, 450), (150, 400),
               leaves=[0.3, 0.45, 0.6, 0.75, 0.9], width=1.4, leaf_len=(20, 30), leaf_w=(8, 11), blooms=[(0.99, 14) + D]))
bq.append(stem((294, 600), (340, 525), (420, 470), (460, 420),
               leaves=[0.3, 0.45, 0.6, 0.75, 0.9], width=1.4, leaf_len=(20, 30), leaf_w=(8, 11), blooms=[(0.99, 15) + RD]))
bq.append(stem((288, 598), (300, 500), (335, 400), (360, 300),
               leaves=[0.3, 0.45, 0.6, 0.75], width=1.3, leaf_len=(18, 26), leaf_w=(7, 10), blooms=[(0.98, 16) + C], buds=[0.85]))
bq.append(stem((290, 598), (270, 500), (230, 400), (210, 300),
               leaves=[0.3, 0.45, 0.6, 0.75], width=1.3, leaf_len=(18, 26), leaf_w=(7, 10), blooms=[(0.98, 13) + D]))
# front layer: short, full sprigs
bq.append(stem((288, 600), (280, 540), (265, 500), (240, 470),
               leaves=[0.35, 0.6, 0.85], width=1.2, leaf_len=(16, 22), leaf_w=(7, 9), blooms=[(0.99, 12) + R], berry_at=[0.5]))
bq.append(stem((292, 600), (305, 540), (325, 500), (345, 468),
               leaves=[0.35, 0.6, 0.85], width=1.2, leaf_len=(16, 22), leaf_w=(7, 9), blooms=[(0.99, 11) + RD]))
bq.append(stem((290, 600), (292, 555), (300, 520), (300, 490),
               leaves=[0.4, 0.75], width=1.1, leaf_len=(14, 20), leaf_w=(6, 8), berry_at=[0.98]))
bq.append(stem((284, 600), (240, 560), (200, 540), (170, 530),
               leaves=[0.3, 0.55, 0.8], width=1.2, leaf_len=(16, 24), leaf_w=(7, 9), blooms=[(0.99, 10) + C]))
bq.append(stem((296, 600), (345, 560), (385, 545), (415, 535),
               leaves=[0.3, 0.55, 0.8], width=1.2, leaf_len=(16, 24), leaf_w=(7, 9), blooms=[(0.99, 10) + D]))
# ribbon tie at the base, in wine
bq.append(f'<path d="M258,586 C280,574 300,574 322,586 C300,598 280,598 258,586 Z" fill="{ROSE}" stroke="{WINE}" stroke-width="1.3"/>')
bq.append(f'<path d="M258,586 C244,602 240,614 248,620 M322,586 C336,602 340,614 332,620" fill="none" stroke="{WINE}" stroke-width="1.3" stroke-linecap="round"/>')
bq.append('</svg>')
(ROOT / "floral-bouquet.svg").write_text("\n".join(bq))
print("wrote", ROOT / "floral-bouquet.svg")
