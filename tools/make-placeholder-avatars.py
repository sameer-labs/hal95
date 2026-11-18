#!/usr/bin/env python3
"""Generate the placeholder HAL95 avatar states.

These are deliberately crude stand-ins for real renders. 512x512, palette
quantised so each PNG stays well under 40 KB.

Usage: python3 tools/make-placeholder-avatars.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 512
OUT = Path(__file__).resolve().parent.parent / "assets" / "avatar-states"

BG = (8, 10, 8)
HEAD = (168, 168, 160)
HEAD_DARK = (126, 126, 120)
HEAD_HI = (198, 198, 188)
BLACK = (8, 8, 8)
LENS = (44, 54, 46)
GREEN = (70, 214, 122)
RED = (196, 48, 48)


def base():
    img = Image.new("RGB", (SIZE, SIZE), BG)
    d = ImageDraw.Draw(img)

    # Faint scanlines keep the placeholder in the same world as the CRT UI.
    for y in range(0, SIZE, 6):
        d.line((0, y, SIZE, y), fill=(12, 15, 12))

    # Shoulders and neck.
    d.ellipse((60, 420, 452, 660), fill=HEAD_DARK, outline=BLACK, width=6)
    d.rectangle((218, 344, 294, 438), fill=HEAD_DARK, outline=BLACK, width=6)

    # Bald head.
    d.ellipse((106, 56, 406, 382), fill=HEAD, outline=BLACK, width=7)
    # Ear bumps.
    d.ellipse((84, 190, 126, 272), fill=HEAD_DARK, outline=BLACK, width=5)
    d.ellipse((386, 190, 428, 272), fill=HEAD_DARK, outline=BLACK, width=5)
    # Cranium highlight, a single flat shape: no gradients in 1998.
    d.arc((140, 78, 372, 250), 200, 340, fill=HEAD_HI, width=9)

    # Glasses.
    d.rectangle((148, 192, 242, 258), fill=LENS, outline=BLACK, width=8)
    d.rectangle((270, 192, 364, 258), fill=LENS, outline=BLACK, width=8)
    d.line((242, 218, 270, 218), fill=BLACK, width=8)
    d.line((148, 212, 118, 204), fill=BLACK, width=6)
    d.line((364, 212, 394, 204), fill=BLACK, width=6)

    # Nose.
    d.line((256, 258, 244, 306), fill=BLACK, width=5)
    d.line((244, 306, 268, 306), fill=BLACK, width=5)

    return img, d


def eyes_neutral(d, colour=BLACK):
    d.ellipse((184, 214, 206, 236), fill=colour)
    d.ellipse((306, 214, 328, 236), fill=colour)


def mouth_neutral(d):
    d.line((216, 338, 296, 338), fill=BLACK, width=7)


def make_neutral():
    img, d = base()
    eyes_neutral(d)
    mouth_neutral(d)
    return img


def make_smiling():
    img, d = base()
    eyes_neutral(d)
    # Wide unsettling grin.
    d.arc((176, 282, 336, 392), 15, 165, fill=BLACK, width=10)
    d.line((184, 340, 328, 340), fill=BLACK, width=6)
    for x in range(202, 320, 26):
        d.line((x, 340, x + 6, 360), fill=BLACK, width=4)
    return img


def make_confused():
    img, d = base()
    # Uneven eyes and a raised brow.
    d.ellipse((182, 212, 204, 240), fill=BLACK)
    d.ellipse((304, 220, 330, 238), fill=BLACK)
    d.line((170, 184, 228, 198), fill=BLACK, width=7)
    d.line((292, 194, 344, 178), fill=BLACK, width=7)
    # Squiggly mouth.
    d.line(
        ((208, 342), (228, 330), (248, 348), (268, 330), (288, 348), (306, 338)),
        fill=BLACK,
        width=7,
        joint="curve",
    )
    return img


def make_processing():
    img, d = base()
    # Loading bars for eyes.
    d.rectangle((168, 216, 232, 236), fill=GREEN, outline=BLACK, width=4)
    d.rectangle((280, 216, 344, 236), fill=GREEN, outline=BLACK, width=4)
    d.rectangle((168, 216, 206, 236), fill=BLACK)
    d.rectangle((280, 216, 330, 236), fill=BLACK)
    mouth_neutral(d)
    # Little activity lights.
    for i, x in enumerate((206, 242, 278)):
        d.rectangle((x, 402, x + 20, 416), fill=GREEN if i < 2 else (30, 80, 46))
    return img


def make_creepy():
    img, d = base()
    # Narrowed eyes with red pinprick pupils.
    d.rectangle((168, 218, 238, 230), fill=BLACK)
    d.rectangle((274, 218, 344, 230), fill=BLACK)
    d.rectangle((196, 218, 212, 230), fill=RED)
    d.rectangle((302, 218, 318, 230), fill=RED)
    # Thin too-wide smile with a few uneven teeth.
    d.arc((176, 300, 336, 396), 20, 160, fill=BLACK, width=6)
    for x in range(208, 312, 24):
        d.line((x, 352, x + 4, 372), fill=BLACK, width=4)
    return img


def save(name, image):
    OUT.mkdir(parents=True, exist_ok=True)
    # Quantise hard: flat 90s colours compress beautifully and stay tiny.
    out = image.convert("P", palette=Image.Palette.ADAPTIVE, colors=48)
    path = OUT / f"{name}.png"
    out.save(path, "PNG", optimize=True)
    print(f"{path.relative_to(OUT.parent.parent)}: {path.stat().st_size} bytes")


def main():
    save("neutral", make_neutral())
    save("smiling", make_smiling())
    save("confused", make_confused())
    save("processing", make_processing())
    save("creepy", make_creepy())


if __name__ == "__main__":
    main()
