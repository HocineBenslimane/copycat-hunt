"""After lining up, compare (build step 9).

Once a photo is warped into the design's own frame (edges.compare does that),
the two can be compared like screenshots. Ideas taken from screenshot-diff
tools (pixelmatch, honeydiff, looks-same), not their code:

  ssim           structure similarity (honeydiff's SSIM) of the two
                 local-contrast images, around the design's ink
  missing*       the design's outline with nothing in the photo near it
  extra*         lines in the photo that aren't in the design
                 (both grouped into connected regions, like looks-same's
                 clusters; *Largest = the biggest region's share of the
                 design's outline)
  detailKept     how much of the design's most detailed area (the cells with
                 the most outline, e.g. a character's face) is still found

The idea to measure: something added on top (a hat, glasses) adds lines but
keeps most of the detail; a replaced character loses the detail. These are
recorded, not used for ranking, until labeled data shows what they're worth.
"""
import cv2
import numpy as np

from . import config


def ssim(a, b, roi):
    """Mean SSIM of two uint8 images inside the boolean roi (Gaussian window)."""
    a = a.astype(np.float32)
    b = b.astype(np.float32)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    blur = lambda x: cv2.GaussianBlur(x, (11, 11), 1.5)
    ma, mb = blur(a), blur(b)
    va = blur(a * a) - ma * ma
    vb = blur(b * b) - mb * mb
    cov = blur(a * b) - ma * mb
    s = ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2))
    return float(s[roi].mean()) if roi.any() else None


def regions(mask, join_px):
    """Pixel counts of the connected regions of mask, after joining pieces closer than join_px."""
    if not mask.any():
        return []
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * join_px + 1, 2 * join_px + 1))
    n, labels = cv2.connectedComponents(cv2.dilate(mask.astype(np.uint8), k))
    return sorted((int(((labels == i) & mask).sum()) for i in range(1, n)), reverse=True)


def detail_kept(D, found, grid, top_share):
    """Share of the design's outline found, inside the cells holding the most outline."""
    h, w = D.shape
    cells = []
    for ty in range(grid):
        for tx in range(grid):
            ys, ye = ty * h // grid, (ty + 1) * h // grid
            xs, xe = tx * w // grid, (tx + 1) * w // grid
            cells.append((int(D[ys:ye, xs:xe].sum()), (ys, ye, xs, xe)))
    cells = [c for c in cells if c[0]]
    if not cells:
        return None
    cells.sort(key=lambda c: c[0], reverse=True)
    top = cells[:max(1, round(len(cells) * top_share))]
    total = sum(c[0] for c in top)
    kept = sum(int(found[ys:ye, xs:xe].sum()) for _, (ys, ye, xs, xe) in top)
    return kept / total


def compare(design_norm, warped, D, C, to_c, to_d, roi, cfg=None):
    """Signals for one design (or part) vs a photo already warped into its frame.
    D/C: design / photo edges inside roi; to_c/to_d: distance to them."""
    cfg = cfg or config.get()
    a = cfg["aligned"]
    t = cfg["edges"]["tolerancePx"]
    nd = int(D.sum())
    if not nd:
        return dict(EMPTY)
    found = D & (to_c <= t)
    missing = D & (to_c > t)
    extra = C & (to_d > t)
    miss_r = regions(missing, a["joinPx"])
    extra_r = regions(extra, a["joinPx"])
    kept = detail_kept(D, found, a["detailGrid"], a["detailTopShare"])
    s = ssim(design_norm, warped, roi)
    return {
        "alignedSSIM": None if s is None else round(s, 3),
        "missingShare": round(int(missing.sum()) / nd, 3),
        "missingLargest": round((miss_r[0] if miss_r else 0) / nd, 3),
        "extraShare": round(int(extra.sum()) / nd, 3),
        "extraLargest": round((extra_r[0] if extra_r else 0) / nd, 3),
        "detailKept": None if kept is None else round(kept, 3),
    }


EMPTY = {k: None for k in ("alignedSSIM", "missingShare", "missingLargest", "extraShare", "extraLargest", "detailKept")}
