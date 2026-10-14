"""Split a transparent design into its text and its drawing.

Many shirts are a drawing plus a phrase. A short phrase is rarely what makes
a copy (and many shirts share one), so the drawing and the text are matched
separately (pipeline.compare). Text is found without OCR, from the shapes of
the ink: letters are separate pieces of similar height whose bottoms line up
in a row. Small pieces surrounded by the drawing's own ink (shading,
hatching) are never text; text inside an empty frame or badge still is.
Everything that isn't text is the drawing.
"""
import cv2
import numpy as np

from . import config


def _components(mask):
    n, labels, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8), connectivity=8)
    return labels, [(i, *stats[i]) for i in range(1, n)]  # (label, x, y, w, h, area)


def _surrounded(piece, big_ink, reach):
    """Share of the area around a piece (its box grown by reach x its height)
    that is ink of the big pieces."""
    _, x, y, w, h, _ = piece
    r = int(reach * h) + 1
    H, W = big_ink.shape
    win = big_ink[max(0, y - r):min(H, y + h + r), max(0, x - r):min(W, x + w + r)]
    return float(win.mean()) if win.size else 0.0


def _same_line(a, b, p):
    _, ax, ay, aw, ah, _ = a
    _, bx, by, bw, bh, _ = b
    if max(ah, bh) > p["heightRatioMax"] * min(ah, bh):
        return False
    overlap = min(ay + ah, by + bh) - max(ay, by)
    if overlap < p["verticalOverlapMin"] * min(ah, bh):
        return False
    gap = max(ax, bx) - min(ax + aw, bx + bw)
    return gap <= p["gapFactor"] * max(ah, bh)


def split(mask, cfg=None):
    """mask: uint8 ink mask. Returns (text_mask, drawing_mask), uint8 0/255.
    text_mask is all zero when no text line is found."""
    cfg = cfg or config.get()
    p = cfg["parts"]
    labels, comps = _components(mask)
    h, w = mask.shape
    total = max(1, int((mask > 0).sum()))
    comps = [c for c in comps if c[5] >= p["minPieceFraction"] * total]
    if not comps:
        return np.zeros_like(mask), mask.copy()

    # Big pieces are drawing; small pieces surrounded by their ink are drawing too.
    big = [c for c in comps if c[5] >= p["bigPieceFraction"] * total or c[4] > p["maxLetterHeight"] * h]
    big_ink = np.isin(labels, [c[0] for c in big])
    cand = [c for c in comps if c not in big and _surrounded(c, big_ink, p["surroundReach"]) < p["surroundInk"]]

    # Group letter-like pieces into rows (union-find).
    parent = list(range(len(cand)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(cand)):
        for j in range(i + 1, len(cand)):
            if _same_line(cand[i], cand[j], p):
                parent[find(i)] = find(j)
    rows = {}
    for i, c in enumerate(cand):
        rows.setdefault(find(i), []).append(c)

    text_labels, letter_h = [], []
    for row in rows.values():
        if len(row) < p["minLetters"]:
            continue
        heights = np.array([c[4] for c in row], np.float32)
        bottoms = np.array([c[2] + c[4] for c in row], np.float32)
        med = float(np.median(heights))
        x0 = min(c[1] for c in row)
        x1 = max(c[1] + c[3] for c in row)
        # Letters: similar heights, bottoms on one line, a row wider than tall.
        if np.median(np.abs(bottoms - np.median(bottoms))) > p["baselineSpread"] * med:
            continue
        if (x1 - x0) < p["minRowAspect"] * med:
            continue
        text_labels += [c[0] for c in row]
        letter_h.append(med)

    if not text_labels:
        return np.zeros_like(mask), mask.copy()
    text = np.isin(labels, text_labels)
    # Dots, apostrophes and accents near a text row belong to it.
    r = max(2, int(p["attachReach"] * float(np.median(letter_h))))
    near = cv2.dilate(text.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))) > 0
    small = [c[0] for c in comps if c[0] not in text_labels and c[5] < p["bigPieceFraction"] * total and c not in big]
    text |= np.isin(labels, small) & near
    drawing = (mask > 0) & ~text
    return np.where(text, 255, 0).astype(np.uint8), np.where(drawing, 255, 0).astype(np.uint8)
