"""Get the seller's design ready for comparison, once per search.

A transparent PNG (upload or Merch art layer): cut to the box around the ink,
add a little padding, put it on white, black and gray (a copy can sit on any
shirt colour), bring each to working size, make the Views.

Anything else (a product photo): treated like a candidate, with print-area
crops, and marked kind="photo" so results from the two cases stay apart.

Since the drawing/text split, a design PNG also gets parts: "drawing" and
"text" (app/parts.py), each prepared like a design of its own, so each can be
matched on its own (a copy may move or resize the text around the drawing).
"""
from dataclasses import dataclass, field

import numpy as np

import cv2

from . import config, parts as parts_mod
from .crops import make_view, print_crops, resize_long_side


class OriginalError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code  # empty_design


@dataclass
class Original:
    kind: str                       # "png" | "photo"
    views: list = field(default_factory=list)  # [View]
    ink_box: tuple = None           # (x0, y0, x1, y1) in the decoded PNG, png only
    orb_views: list = field(default_factory=list)  # [View] used for feature matching
    ink_mask: object = None         # uint8 mask of the ink at working size, png only
    transparent_fraction: float = 0.0
    warnings: list = field(default_factory=list)
    art: object = None              # RGBA at working size, png only (art vs art pixel check)
    parts: dict = field(default_factory=dict)  # {"drawing": Original, "text": Original}, design PNGs with text


def ink_box(alpha, threshold, padding_fraction):
    """Box around pixels with alpha > threshold, padded, kept inside the image. None if empty."""
    ys, xs = np.nonzero(alpha > threshold)
    if xs.size == 0:
        return None
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    pad = round(max(x1 - x0, y1 - y0) * padding_fraction)
    h, w = alpha.shape
    return max(0, x0 - pad), max(0, y0 - pad), min(w, x1 + pad), min(h, y1 + pad)


def composite(rgba, background):
    """Put an RGBA image on a solid background colour. Returns RGB uint8."""
    a = rgba[..., 3:4].astype(np.float32) / 255.0
    bg = np.asarray(background, dtype=np.float32).reshape(1, 1, 3)
    out = rgba[..., :3].astype(np.float32) * a + bg * (1.0 - a)
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


def _png(px, box, transparent, cfg):
    """Original for the RGBA pixels px cut to box."""
    oc = cfg["original"]
    x0, y0, x1, y1 = box
    art = resize_long_side(np.ascontiguousarray(px[y0:y1, x0:x1]), cfg["images"]["longSide"])
    views = [make_view(name, composite(art, rgb), cfg) for name, rgb in oc["backgrounds"].items()]
    orb_views = [v for v in views if v.name in cfg["orb"]["designViews"]]
    mask = np.where(art[..., 3] > oc["alphaThreshold"], 255, 0).astype(np.uint8)
    return Original("png", views, box, orb_views, mask, transparent, art=art)


def _parts(px, whole, cfg):
    """Drawing and text of a design PNG, each its own Original. {} if no text."""
    oc = cfg["original"]
    text, drawing = parts_mod.split(whole.ink_mask, cfg)
    if not text.any() or not drawing.any():
        return {}
    x0, y0, x1, y1 = whole.ink_box
    out = {}
    for name, m in (("drawing", drawing), ("text", text)):
        full = cv2.resize(m, (x1 - x0, y1 - y0), interpolation=cv2.INTER_NEAREST)
        piece = np.zeros_like(px)
        piece[y0:y1, x0:x1] = px[y0:y1, x0:x1]
        piece[y0:y1, x0:x1, 3] = np.where(full > 0, piece[y0:y1, x0:x1, 3], 0)
        box = ink_box(piece[..., 3], oc["alphaThreshold"], oc["paddingFraction"])
        if box is not None:
            out[name] = _png(piece, box, whole.transparent_fraction, cfg)
    return out if len(out) == 2 else {}


def prepare(decoded, cfg=None, design=False):
    """design=True: this is the seller's design, so a PNG also gets its parts."""
    cfg = cfg or config.get()
    oc = cfg["original"]
    px = decoded.pixels
    if decoded.has_alpha:
        alpha = px[..., 3]
        transparent = float((alpha <= oc["alphaThreshold"]).mean())
        if transparent >= oc["minTransparentFraction"]:
            box = ink_box(alpha, oc["alphaThreshold"], oc["paddingFraction"])
            if box is None:
                raise OriginalError("empty_design")
            whole = _png(px, box, transparent, cfg)
            if design:
                whole.parts = _parts(px, whole, cfg)
            return whole
        rgb = composite(px, oc["backgrounds"]["white"])
        warn = ["little transparency: treated as a photo"]
    else:
        rgb, warn = px, []
    views = [v for v, _ in print_crops(rgb, cfg)]
    full = make_view("full", resize_long_side(np.ascontiguousarray(rgb), cfg["orb"]["candidateLongSide"]), cfg)
    return Original("photo", views, None, [full], None, 0.0, warn)
