from dataclasses import dataclass

import cv2
import numpy as np

from . import config

@dataclass
class View:
    name: str
    gray: np.ndarray
    norm: np.ndarray
    edges: np.ndarray

def resize_long_side(img, long_side):
    h, w = img.shape[:2]
    if max(h, w) <= long_side:
        return img
    s = long_side / max(h, w)
    return cv2.resize(img, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)

def make_view(name, rgb, cfg=None):
    cfg = cfg or config.get()
    im = cfg["images"]
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    clahe = cv2.createCLAHE(clipLimit=im["claheClip"], tileGridSize=(im["claheTile"], im["claheTile"]))
    norm = clahe.apply(gray)
    edges = cv2.Canny(norm, im["cannyLow"], im["cannyHigh"])
    return View(name, gray, norm, edges)

def crop_box(width, height, spec):
    cx, cy, fw, fh = spec
    bw, bh = max(1, round(width * fw)), max(1, round(height * fh))
    x0 = min(max(0, round(width * cx - bw / 2)), width - bw)
    y0 = min(max(0, round(height * cy - bh / 2)), height - bh)
    return x0, y0, x0 + bw, y0 + bh

def print_crops(rgb, cfg=None):
    cfg = cfg or config.get()
    h, w = rgb.shape[:2]
    out = []
    for name, spec in cfg["crops"].items():
        x0, y0, x1, y1 = crop_box(w, h, spec)
        piece = resize_long_side(np.ascontiguousarray(rgb[y0:y1, x0:x1]), cfg["images"]["longSide"])
        out.append((make_view(name, piece, cfg), (x0, y0, x1, y1)))
    return out
