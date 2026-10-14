"""Perceptual hashes: cheap, early signals only.

pHash: 32x32 grayscale -> DCT -> top-left 8x8 low frequencies, each bit = above
the median (DC term left out of the median). dHash: 9x8 grayscale, each bit =
left pixel brighter than its right neighbour. Both 64 bits; distance = number
of differing bits (0 = same picture at this scale, 64 = opposite).

Hashes see the whole view, so a crop that holds a lot of shirt around the
print scores worse than the same print cut tight. That's expected; the
geometry and edge steps handle it.
"""
import cv2
import numpy as np


def _bits_to_int(bits):
    v = 0
    for b in bits.ravel():
        v = (v << 1) | int(b)
    return v


def phash(gray):
    small = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    low = cv2.dct(small)[:8, :8]
    med = np.median(low.ravel()[1:])
    return _bits_to_int(low > med)


def dhash(gray):
    small = cv2.resize(gray, (9, 8), interpolation=cv2.INTER_AREA).astype(np.int16)
    return _bits_to_int(small[:, :-1] > small[:, 1:])


def distance(a, b):
    return int(bin(a ^ b).count("1"))


def hex64(h):
    return f"{h:016x}"


def view_hashes(view):
    return {"phash": phash(view.gray), "dhash": dhash(view.gray)}


def compare(original_views, candidate_views):
    """Best (lowest) distance per hash over every original view x candidate view.
    Returns the distances and which pair gave them."""
    oh = [(v.name, view_hashes(v)) for v in original_views]
    ch = [(v.name, view_hashes(v)) for v in candidate_views]
    out = {}
    for algo in ("phash", "dhash"):
        best = None
        for on, o in oh:
            for cn, c in ch:
                d = distance(o[algo], c[algo])
                if best is None or d < best[0]:
                    best = (d, on, cn)
        out[f"{algo}Distance"] = best[0] if best else None
        out[f"{algo}Pair"] = f"{best[1]}/{best[2]}" if best else None
    return out
