"""Aligned edge comparison (build step 4).

Only runs after a valid placement (homography) was found. The candidate photo
is warped into the design's own coordinates, edges are found on it, and the
two outlines are compared inside the area around the design's ink, with a
small tolerance:

  precision  how much of the photo's outline there belongs to the design
  recall     how much of the design's outline shows up in the photo
  chamfer    average distance (px) from design edges to the nearest photo edge
  tiles      the same recall per tile, so a partly copied design (or one with
             changed text) shows as some tiles matching and others not

Edges don't care about colour, so recolours and shirt colours matter little
once the two are lined up.
"""
import cv2
import numpy as np

from . import aligned, config


def _dist_to(mask):
    """Distance (px) from every pixel to the nearest True pixel of mask."""
    src = np.where(mask, 0, 255).astype(np.uint8)
    return cv2.distanceTransform(src, cv2.DIST_L2, 3)


def _disk(r):
    r = max(1, int(r))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def compare(design_view, candidate_view, H, ink_mask=None, cfg=None):
    """H maps design view -> candidate view. Returns the edge signals."""
    cfg = cfg or config.get()
    e, im = cfg["edges"], cfg["images"]
    h, w = design_view.gray.shape
    try:
        Hinv = np.linalg.inv(H)
    except np.linalg.LinAlgError:
        return None
    warped = cv2.warpPerspective(candidate_view.norm, Hinv, (w, h), flags=cv2.INTER_LINEAR, borderValue=0)
    inside = cv2.warpPerspective(np.full(candidate_view.norm.shape, 255, np.uint8), Hinv, (w, h), flags=cv2.INTER_NEAREST)
    inside = cv2.erode(inside, _disk(e["borderErodePx"])) > 0
    roi = inside
    if ink_mask is not None:
        roi = roi & (cv2.dilate(ink_mask, _disk(e["inkMaskDilatePx"])) > 0)

    cand_edges = cv2.Canny(warped, im["cannyLow"], im["cannyHigh"]) > 0
    D = (design_view.edges > 0) & roi
    C = cand_edges & roi
    nd, nc = int(D.sum()), int(C.sum())
    if nd == 0:
        return None
    to_d, to_c = _dist_to(D), _dist_to(C)
    t = e["tolerancePx"]
    recall = float((to_c[D] <= t).mean()) if nc else 0.0
    precision = float((to_d[C] <= t).mean()) if nc else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    chamfer = float(np.minimum(to_c[D], e["chamferCap"]).mean()) if nc else float(e["chamferCap"])

    g = e["tileGrid"]
    counted = matched = 0
    worst = None
    for ty in range(g):
        for tx in range(g):
            ys, ye = ty * h // g, (ty + 1) * h // g
            xs, xe = tx * w // g, (tx + 1) * w // g
            tile = D[ys:ye, xs:xe]
            if int(tile.sum()) < e["minTileEdges"]:
                continue
            counted += 1
            r = float((to_c[ys:ye, xs:xe][tile] <= t).mean()) if nc else 0.0
            matched += r >= e["tileRecallMin"]
            worst = r if worst is None else min(worst, r)

    return {
        "edgePrecision": round(precision, 3),
        "edgeRecall": round(recall, 3),
        "edgeF1": round(f1, 3),
        "chamferMean": round(chamfer, 2),
        "edgeTilesMatched": matched,
        "edgeTilesCounted": counted,
        "edgeTileRecallMin": None if worst is None else round(worst, 3),
        "edgePixelsDesign": nd,
        # Step 9: after lining up, compare (app/aligned.py).
        **(aligned.compare(design_view.norm, warped, D, C, to_c, to_d, roi, cfg) if cfg["aligned"]["enabled"] else aligned.EMPTY),
    }


EMPTY = {k: None for k in ("edgePrecision", "edgeRecall", "edgeF1", "chamferMean", "edgeTilesMatched",
                           "edgeTilesCounted", "edgeTileRecallMin", "edgePixelsDesign")}
EMPTY.update(aligned.EMPTY)
