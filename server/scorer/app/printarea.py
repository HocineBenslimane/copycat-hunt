from dataclasses import dataclass

import cv2
import numpy as np

from . import config

@dataclass
class PrintArea:
    box: tuple
    color: tuple
    mode: str

def _dist(lab, ref, lw):
    d = lab - ref
    return np.sqrt((lw * d[..., 0]) ** 2 + d[..., 1] ** 2 + d[..., 2] ** 2)

def _rgb(lab_color):
    px = np.clip(np.round(lab_color), 0, 255).astype(np.uint8).reshape(1, 1, 3)
    return tuple(int(v) for v in cv2.cvtColor(px, cv2.COLOR_LAB2RGB)[0, 0])

def find(rgb, cfg=None):
    cfg = cfg or config.get()
    pc = cfg["printArea"]
    if not pc["enabled"]:
        return None
    h0, w0 = rgb.shape[:2]
    s = min(1.0, pc["workSize"] / max(h0, w0))
    small = cv2.resize(rgb, (max(1, round(w0 * s)), max(1, round(h0 * s))), interpolation=cv2.INTER_AREA) if s < 1 else rgb
    lab = cv2.cvtColor(np.ascontiguousarray(small), cv2.COLOR_RGB2LAB).astype(np.float32)
    h, w = lab.shape[:2]
    b = max(2, round(pc["edgeBand"] * min(h, w)))
    edge = np.concatenate([lab[:b].reshape(-1, 3), lab[-b:].reshape(-1, 3), lab[:, :b].reshape(-1, 3), lab[:, -b:].reshape(-1, 3)])
    bg = np.median(edge, axis=0)
    if np.mean(np.linalg.norm(edge - bg, axis=1) < pc["backdropTolerance"]) < pc["minPlainEdge"]:
        return None
    near = (np.linalg.norm(lab - bg, axis=2) < pc["backdropTolerance"]).astype(np.uint8)
    _, lbl = cv2.connectedComponents(near, connectivity=4)
    edge_lbls = set(np.unique(np.concatenate([lbl[0], lbl[-1], lbl[:, 0], lbl[:, -1]]))) - {0}
    backdrop = (np.isin(lbl, list(edge_lbls)) & (near > 0)).astype(np.uint8)
    product = cv2.morphologyEx(1 - backdrop, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    lw = pc["lightnessWeight"]
    found = None
    if product.mean() >= pc["minProduct"]:
        px = lab[product > 0]
        q = (px // 6).astype(np.int32)
        keys = q[:, 0] * 10000 + q[:, 1] * 100 + q[:, 2]
        vals, counts = np.unique(keys, return_counts=True)
        base = px[keys == vals[np.argmax(counts)]].mean(axis=0)
        nonfab = ((_dist(lab, base, lw) > pc["inkTolerance"]) | (backdrop > 0)).astype(np.uint8)
        _, lbl = cv2.connectedComponents(nonfab, connectivity=4)
        outside = set(np.unique(lbl[backdrop > 0])) - {0}
        ink = ((nonfab > 0) & ~np.isin(lbl, list(outside))).astype(np.uint8)
        e = max(3, round(pc["outlineBand"] * max(h, w)))
        near_edge = cv2.erode(product, np.ones((e, e), np.uint8)) == 0
        _, lbl = cv2.connectedComponents(ink, connectivity=8)
        ink[np.isin(lbl, list(set(np.unique(lbl[near_edge & (ink > 0)])) - {0}))] = 0
        box = _pick(ink, small, product, pc)
        if box is not None:
            found = (box, base, "enclosed")
    if found is None:
        ink = (_dist(lab, bg, lw) > pc["inkTolerance"]).astype(np.uint8)
        ink[:b] = 0
        ink[-b:] = 0
        ink[:, :b] = 0
        ink[:, -b:] = 0
        box = _pick(ink, small, np.ones_like(product), pc)
        if box is not None:
            found = (box, bg, "same_as_backdrop")
    if found is None:
        return None
    (x0, y0, x1, y1), base, mode = found
    p = round(max(x1 - x0, y1 - y0) * pc["padding"])
    x0, y0, x1, y1 = max(0, x0 - p), max(0, y0 - p), min(w, x1 + p), min(h, y1 + p)
    box = (round(x0 / s), round(y0 / s), min(w0, round(x1 / s)), min(h0, round(y1 / s)))
    return PrintArea(box, _rgb(base), mode)

def _pick(ink, small, product, pc):
    h, w = ink.shape
    ink = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    ycc = cv2.cvtColor(np.ascontiguousarray(small), cv2.COLOR_RGB2YCrCb)
    sk = pc["skin"]
    skin = ((ycc[..., 0] > sk["minY"]) & (ycc[..., 1] >= sk["cr"][0]) & (ycc[..., 1] <= sk["cr"][1])
            & (ycc[..., 2] >= sk["cb"][0]) & (ycc[..., 2] <= sk["cb"][1]))
    n, lbl, st, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    for i in range(1, n):
        m = lbl == i
        if st[i, cv2.CC_STAT_AREA] > sk["minPiece"] * h * w and skin[m].mean() > sk["maxShare"]:
            ink[m] = 0
    k = max(3, round(pc["joinGap"] * max(h, w)))
    joined = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    n, lbl, st, cent = cv2.connectedComponentsWithStats(joined, connectivity=8)
    if n <= 1:
        return None
    ys, xs = np.nonzero(product)
    pcx, pcy, pw = xs.mean(), ys.mean(), max(1, xs.max() - xs.min())
    score = st[1:, cv2.CC_STAT_AREA] / (1 + np.hypot(cent[1:, 0] - pcx, cent[1:, 1] - pcy) / pw * 4)
    seed = int(np.argmax(score)) + 1
    x0, y0, bw, bh = st[seed, :4]
    x1, y1 = x0 + bw, y0 + bh
    reach = pc["reach"] * pw
    used, grown = {seed}, True
    while grown:
        grown = False
        for i in range(1, n):
            if i in used or st[i, cv2.CC_STAT_AREA] < pc["minPiece"] * h * w:
                continue
            a0, b0, aw, ah = st[i, :4]
            if max(max(0, a0 - x1, x0 - (a0 + aw)), max(0, b0 - y1, y0 - (b0 + ah))) <= reach:
                x0, y0, x1, y1 = min(x0, a0), min(y0, b0), max(x1, a0 + aw), max(y1, b0 + ah)
                used.add(i)
                grown = True
    if (x1 - x0) * (y1 - y0) < pc["minArea"] * h * w:
        return None
    return int(x0), int(y0), int(x1), int(y1)
