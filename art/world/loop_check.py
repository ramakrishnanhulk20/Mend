"""Mean absolute pixel difference between pairs of rendered frames, out of 255. Plain Python with Pillow and numpy.

    python loop_check.py --dir out/preview 312:217 216:217
A pair is written first:second and each name is a frame number inside --dir, or a path to a PNG.
"""
import argparse
import os

import numpy as np
from PIL import Image


def load(directory, name):
    path = name if name.lower().endswith(".png") else os.path.join(directory, "f_%04d.png" % int(name))
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dir", required=True)
    p.add_argument("pairs", nargs="+")
    args = p.parse_args()
    for pair in args.pairs:
        a, b = pair.split(":")
        diff = np.abs(load(args.dir, a) - load(args.dir, b))
        print("MEAN_ABS_DIFF %s vs %s: %.4f of 255 (max pixel %.0f, share of pixels differing by more than 8: %.4f%%)" % (
            a, b, diff.mean(), diff.max(), 100.0 * float((diff.max(axis=2) > 8).mean())))


if __name__ == "__main__":
    main()
