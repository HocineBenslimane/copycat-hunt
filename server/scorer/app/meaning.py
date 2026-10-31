import logging
import os
import threading

import numpy as np
from PIL import Image

from . import config
from .crops import crop_box

log = logging.getLogger("copycat-vision")

CLIP_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], np.float32)
CLIP_STD = np.array([0.26862954, 0.26130258, 0.27577711], np.float32)
DINO_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
DINO_STD = np.array([0.229, 0.224, 0.225], np.float32)
EMPTY = {"clipSim": None, "dinoSim": None, "sameIdea": None}

_lock = threading.Lock()
_models = {}

def models_dir(cfg=None):
    cfg = cfg or config.get()
    return os.environ.get("COPYCAT_MEANING_MODELS") or cfg["meaning"]["modelsDir"]

def _sessions(cfg):
    mc = cfg.get("meaning") or {}
    if not mc.get("enabled"):
        return None
    d = models_dir(cfg)
    if d in _models:
        return _models[d]
    with _lock:
        if d not in _models:
            paths = [os.path.join(d, mc["clip"]), os.path.join(d, mc["dino"])]
            if not all(os.path.isfile(p) for p in paths):
                log.warning("same-idea models not found in %s: signal off", d)
                _models[d] = None
            else:
                import onnxruntime as ort
                so = ort.SessionOptions()
                so.intra_op_num_threads = int(mc.get("threads", 1))
                so.inter_op_num_threads = 1
                _models[d] = tuple(ort.InferenceSession(p, so, providers=["CPUExecutionProvider"]) for p in paths)
    return _models[d]

def available(cfg=None):
    return _sessions(cfg or config.get()) is not None

def warm_up(cfg=None):
    import time
    cfg = cfg or config.get()
    t = time.perf_counter()
    if available(cfg):
        embed([np.full((256, 256, 3), 128, np.uint8)], cfg)
    return time.perf_counter() - t

def _square(rgb, size):
    im = Image.fromarray(rgb)
    s = size / min(im.size)
    im = im.resize((max(size, round(im.width * s)), max(size, round(im.height * s))), Image.BICUBIC)
    left, top = (im.width - size) // 2, (im.height - size) // 2
    return np.asarray(im.crop((left, top, left + size, top + size)), np.float32) / 255.0

def _norm(x, mean, std):
    return ((x - mean) / std).transpose(2, 0, 1)

def _canvas(im, bg, mc):
    k = float(mc["artCanvas"])
    w, h = int(im.width * k), int(im.height * k)
    if mc.get("squareCanvas"):
        w = h = max(w, h)
    c = Image.new("RGB", (w, h), tuple(int(v) for v in bg))
    c.paste(im, ((w - im.width) // 2, (h - im.height) // 2), im if im.mode == "RGBA" else None)
    return np.asarray(c)

def _art_views(art, mc, backgrounds=None):
    alpha = art[..., 3]
    ys, xs = np.nonzero(alpha > 16)
    if xs.size == 0:
        return []
    ink = Image.fromarray(np.ascontiguousarray(art[ys.min():ys.max() + 1, xs.min():xs.max() + 1]), "RGBA")
    return [_canvas(ink, bg, mc) for bg in backgrounds or mc["artBackgrounds"].values()]

def views(prepared, role, cfg=None):
    cfg = cfg or config.get()
    mc = cfg["meaning"]
    if prepared.kind == "png" and prepared.art is not None:
        return _art_views(prepared.art, mc)
    rgb = getattr(prepared, "rgb", None)
    if rgb is None:
        return []
    art = getattr(prepared, "print_rgb", None)
    out = []
    use = mc.get("artCut", "both")
    if art is not None and (use == "both" or (use == "design" and role == "design")):
        out.append(_canvas(Image.fromarray(art), prepared.print_area.color, mc))
        if role == "design" or not mc.get("candidateCropsToo"):
            return out
    h, w = rgb.shape[:2]
    for spec in mc["designCrops" if role == "design" else "candidateCrops"].values():
        x0, y0, x1, y1 = crop_box(w, h, spec)
        out.append(np.ascontiguousarray(rgb[y0:y1, x0:x1]))
    return out

def embed(pictures, cfg=None):
    cfg = cfg or config.get()
    s = _sessions(cfg)
    if s is None or not pictures:
        return None
    size = int(cfg["meaning"]["inputSize"])
    sq = [_square(p, size) for p in pictures]
    a = np.stack([_norm(x, CLIP_MEAN, CLIP_STD) for x in sq])
    b = np.stack([_norm(x, DINO_MEAN, DINO_STD) for x in sq])
    e1 = s[0].run(None, {"pixel_values": a})[0]
    e2 = s[1].run(None, {"pixel_values": b})[0][:, 0, :]
    unit = lambda e: e / np.maximum(np.linalg.norm(e, axis=1, keepdims=True), 1e-12)
    return unit(e1), unit(e2)

def design_vectors(original, cfg=None):
    if getattr(original, "_meaning", None) is None:
        e = embed(views(original, "design", cfg), cfg)
        original._meaning = e if e is not None else False
    return original._meaning or None

def compare(original, candidate, cfg=None):
    d = design_vectors(original, cfg)
    if d is None:
        return dict(EMPTY)
    cv = views(candidate, "candidate", cfg)
    pa = getattr(candidate, "print_area", None)
    own = []
    if original.kind == "png" and original.art is not None and pa is not None and cfg["meaning"].get("artOnCandidateColor"):
        own = _art_views(original.art, cfg["meaning"], [pa.color])
    e = embed(cv + own, cfg)
    if e is None or not cv:
        return dict(EMPTY)
    n = len(cv)
    c = (e[0][:n], e[1][:n])
    d0, d1 = d
    if own:
        d0, d1 = np.vstack([d0, e[0][n:]]), np.vstack([d1, e[1][n:]])
    clip = float((d0 @ c[0].T).max())
    dino = float((d1 @ c[1].T).max())
    return {"clipSim": round(clip, 4), "dinoSim": round(dino, 4), "sameIdea": round(clip + dino, 4)}
