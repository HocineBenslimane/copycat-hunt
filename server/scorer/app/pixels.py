"""Art against art: a pixel difference, only when both sides are transparent
PNGs (your design and a Merch candidate's own art layer). No fabric, light or
folds there, so pixels can be compared directly.

Same colour rule as mapbox/pixelmatch (ISC): two pixels differ when their
YIQ distance is above threshold² of the largest possible distance. Both arts
are already cut to their ink box; they are brought to one size, put on mid
gray (so transparency counts), and compared inside the union of their ink.
Anti-aliased edge pixels are softened by comparing at a smaller size instead
of pixelmatch's per-pixel neighbour test.
"""
import cv2
import numpy as np

from . import config

MAX_DELTA = 35215.0  # pixelmatch: largest possible YIQ distance (squared)


def _yiq(rgb):
    r, g, b = (rgb[..., i].astype(np.float32) for i in range(3))
    y = r * 0.29889531 + g * 0.58662247 + b * 0.11448223
    i = r * 0.59597799 - g * 0.27417610 - b * 0.32180189
    q = r * 0.21147017 - g * 0.52261711 + b * 0.31114694
    return y, i, q


def _on_gray(rgba):
    a = rgba[..., 3:4].astype(np.float32) / 255.0
    return rgba[..., :3].astype(np.float32) * a + 128.0 * (1.0 - a)


def _same_size(design_rgba, candidate_rgba, p):
    h, w = design_rgba.shape[:2]
    s = min(1.0, p["longSide"] / max(h, w))
    size = (max(1, round(w * s)), max(1, round(h * s)))
    a = cv2.resize(design_rgba, size, interpolation=cv2.INTER_AREA)
    b = cv2.resize(candidate_rgba, size, interpolation=cv2.INTER_AREA)
    return a, b, (a[..., 3] > p["alphaInk"]) | (b[..., 3] > p["alphaInk"])


def _lab(rgb):
    return cv2.cvtColor((rgb / 255.0).astype(np.float32), cv2.COLOR_RGB2Lab)


def delta_e2000(lab1, lab2):
    """CIEDE2000 colour difference per pixel (the rule looks-same and honeydiff use)."""
    L1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    L2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]
    C1, C2 = np.hypot(a1, b1), np.hypot(a2, b2)
    Cm = (C1 + C2) / 2
    G = 0.5 * (1 - np.sqrt(Cm ** 7 / (Cm ** 7 + 25.0 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360
    dLp, dCp = L2 - L1, C2p - C1p
    dh = h2p - h1p
    dh = np.where(dh > 180, dh - 360, np.where(dh < -180, dh + 360, dh))
    dh = np.where(C1p * C2p == 0, 0, dh)
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dh / 2))
    Lpm, Cpm = (L1 + L2) / 2, (C1p + C2p) / 2
    hs = h1p + h2p
    hpm = np.where(C1p * C2p == 0, hs, np.where(np.abs(h1p - h2p) <= 180, hs / 2, np.where(hs < 360, (hs + 360) / 2, (hs - 360) / 2)))
    T = (1 - 0.17 * np.cos(np.radians(hpm - 30)) + 0.24 * np.cos(np.radians(2 * hpm))
         + 0.32 * np.cos(np.radians(3 * hpm + 6)) - 0.20 * np.cos(np.radians(4 * hpm - 63)))
    dtheta = 30 * np.exp(-(((hpm - 275) / 25) ** 2))
    Rc = 2 * np.sqrt(Cpm ** 7 / (Cpm ** 7 + 25.0 ** 7))
    Sl = 1 + 0.015 * (Lpm - 50) ** 2 / np.sqrt(20 + (Lpm - 50) ** 2)
    Sc = 1 + 0.045 * Cpm
    Sh = 1 + 0.015 * Cpm * T
    Rt = -np.sin(np.radians(2 * dtheta)) * Rc
    return np.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))


def color_diff(design_rgba, candidate_rgba, cfg=None):
    """Share of the inked area whose colour differs as people see it (CIEDE2000 above
    deltaE). Recorded next to diff() until the measurement shows which is better."""
    cfg = cfg or config.get()
    p = cfg["pixels"]
    a, b, ink = _same_size(design_rgba, candidate_rgba, p)
    n = int(ink.sum())
    if n == 0:
        return None
    d = delta_e2000(_lab(_on_gray(a)), _lab(_on_gray(b)))
    return round(float(((d > p["deltaE"]) & ink).sum()) / n, 3)


def diff(design_rgba, candidate_rgba, cfg=None):
    """Share of the inked area (either side) that differs, 0..1. None if empty."""
    cfg = cfg or config.get()
    p = cfg["pixels"]
    a, b, ink = _same_size(design_rgba, candidate_rgba, p)
    n = int(ink.sum())
    if n == 0:
        return None
    ya, ia, qa = _yiq(_on_gray(a))
    yb, ib, qb = _yiq(_on_gray(b))
    delta = 0.5053 * (ya - yb) ** 2 + 0.299 * (ia - ib) ** 2 + 0.1957 * (qa - qb) ** 2
    differs = (delta > MAX_DELTA * p["threshold"] ** 2) & ink
    return round(float(differs.sum()) / n, 3)
