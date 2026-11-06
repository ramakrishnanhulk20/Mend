"""Makes a labelled contact sheet from rendered film frames. Plain Python with Pillow, not Blender.

    python contact_sheet.py --dir out/preview --out out/preview-sheet.png --frames 1 28 60 92 112 130 150 180 196 204 216 264
"""
import argparse
import os

from PIL import Image, ImageDraw, ImageFont


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dir", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--frames", type=int, nargs="+", required=True)
    p.add_argument("--across", type=int, default=4)
    args = p.parse_args()

    images = [Image.open(os.path.join(args.dir, "f_%04d.png" % f)).convert("RGB") for f in args.frames]
    w, h = images[0].size
    rows = (len(images) + args.across - 1) // args.across
    gap = 6
    sheet = Image.new("RGB", (args.across * w + (args.across + 1) * gap, rows * h + (rows + 1) * gap), (20, 20, 20))
    font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", max(14, h // 16))
    for k, (f, img) in enumerate(zip(args.frames, images)):
        x = gap + (k % args.across) * (w + gap)
        y = gap + (k // args.across) * (h + gap)
        sheet.paste(img, (x, y))
        draw = ImageDraw.Draw(sheet)
        label = "frame %d" % f
        box = draw.textbbox((x + 8, y + 6), label, font=font)
        draw.rectangle((box[0] - 6, box[1] - 4, box[2] + 6, box[3] + 4), fill=(0, 0, 0))
        draw.text((x + 8, y + 6), label, font=font, fill=(255, 255, 255))
    sheet.save(args.out)
    print("WROTE %s %dx%d" % (args.out, sheet.width, sheet.height))


if __name__ == "__main__":
    main()
