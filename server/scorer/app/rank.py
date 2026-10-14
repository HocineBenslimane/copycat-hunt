"""MVP ranking: a plain, readable order. Not a probability.

Order, best first:
  1. the design's drawing was found on its own (design PNGs with text; the
     text is matched separately because many shirts share a phrase)
  2. more tiles of the drawing's outline found, then its worst tile
  3. a valid placement of the whole design
  4. more tiles of the whole design's outline found
  5. higher edge F1, more feature-matching inliers, lower pHash distance
For a design without text (or a photo) the drawing keys are empty and the
order is the whole-design one. Failed downloads/decodes go last.
copyProbability and band stay None until calibrated on labeled data.
"""

RULE = ("heuristic: drawingValid > drawingTilesMatched > drawingTileRecallMin > validHomography"
        " > edgeTilesMatched > edgeF1 > orbInliers > -phashDistance")


def key(r):
    s = r.get("signals") or {}
    if r.get("status") != "ok":
        return (0,) * 9
    return (
        1,
        1 if s.get("drawingValid") else 0,
        s.get("drawingTilesMatched") or 0,
        s.get("drawingTileRecallMin") or 0.0,
        1 if s.get("validHomography") else 0,
        s.get("edgeTilesMatched") or 0,
        s.get("edgeF1") or 0.0,
        s.get("orbInliers") or 0,
        -(s.get("phashDistance") if s.get("phashDistance") is not None else 64),
    )


def rank(results):
    """Sort in place, best first, and number them from 1."""
    results.sort(key=key, reverse=True)
    for i, r in enumerate(results, 1):
        r["rank"] = i
    return results
