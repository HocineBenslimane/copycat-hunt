from dataclasses import dataclass, field

import numpy as np

import cv2

from . import config, parts as parts_mod, printarea
from .crops import make_view, print_crops, resize_long_side

class OriginalError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code

@dataclass
class Original:
    kind: str
    views: list = field(default_factory=list)
    ink_box: tuple = None
    orb_views: list = field(default_factory=list)
    ink_mask: object = None
    transparent_fraction: float = 0.0
    warnings: list = field(default_factory=list)
    art: object = None
    parts: dict = field(default_factory=dict)
    rgb: object = None
    print_area: object = None

    @property
    def print_rgb(self):
        if self.rgb is None or self.print_area is None:
            return None
        x0, y0, x1, y1 = self.print_area.box
        return np.ascontiguousarray(self.rgb[y0:y1, x0:x1])

def ink_box(alpha, threshold, padding_fraction):
    ys, xs = np.nonzero(alpha > threshold)
    if xs.size == 0:
        return None
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    pad = round(max(x1 - x0, y1 - y0) * padding_fraction)
    h, w = alpha.shape
    return max(0, x0 - pad), max(0, y0 - pad), min(w, x1 + pad), min(h, y1 + pad)

def composite(rgba, background):
    a = rgba[..., 3:4].astype(np.float32) / 255.0
    bg = np.asarray(background, dtype=np.float32).reshape(1, 1, 3)
    out = rgba[..., :3].astype(np.float32) * a + bg * (1.0 - a)
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)

def _png(px, box, transparent, cfg):
    oc = cfg["original"]
    x0, y0, x1, y1 = box
    art = resize_long_side(np.ascontiguousarray(px[y0:y1, x0:x1]), cfg["images"]["longSide"])
    views = [make_view(name, composite(art, rgb), cfg) for name, rgb in oc["backgrounds"].items()]
    orb_views = [v for v in views if v.name in cfg["orb"]["designViews"]]
    mask = np.where(art[..., 3] > oc["alphaThreshold"], 255, 0).astype(np.uint8)
    return Original("png", views, box, orb_views, mask, transparent, art=art)

def _parts(px, whole, cfg):
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
    o = Original("photo", views, None, [], None, 0.0, warn, rgb=rgb, print_area=printarea.find(rgb, cfg))
    art = o.print_rgb
    if art is not None:
        o.views.insert(0, make_view("print", resize_long_side(art, cfg["images"]["longSide"]), cfg))
    if design and art is not None:
        o.views = o.views[:1]
        cut = resize_long_side(art, cfg["orb"]["candidateLongSide"])
        lo = cfg["printArea"]["minOrbSide"]
        if max(cut.shape[:2]) < lo:
            k = lo / max(cut.shape[:2])
            cut = cv2.resize(cut, (round(cut.shape[1] * k), round(cut.shape[0] * k)), interpolation=cv2.INTER_CUBIC)
        m = cfg["printArea"]["orbMargin"]
        cut = cv2.copyMakeBorder(cut, m, m, m, m, cv2.BORDER_CONSTANT, value=o.print_area.color)
        o.orb_views = [make_view("print", cut, cfg)]
    else:
        o.orb_views = [make_view("full", resize_long_side(np.ascontiguousarray(rgb), cfg["orb"]["candidateLongSide"]), cfg)]
    return o
