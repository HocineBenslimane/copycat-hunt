LINES_RULE = ("drawingValid > drawingTilesMatched > drawingTileRecallMin > validHomography"
              " > edgeTilesMatched > edgeF1 > orbInliers > -phashDistance")
RULE = "heuristic: " + LINES_RULE
MEANING_RULE = ("same idea: eBay = sameIdea; Amazon = 2*placed + sameIdea + 0.5*line order; "
                "placed = drawingValid or validHomography; line order: " + LINES_RULE)

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

def _same_idea(r):
    return (r.get("signals") or {}).get("sameIdea")

def meaning_score(r, line_pos):
    s = r.get("signals") or {}
    if str(r.get("id", "")).startswith("ebay:"):
        return s["sameIdea"]
    placed = 1.0 if (s.get("drawingValid") or s.get("validHomography")) else 0.0
    return 2.0 * placed + s["sameIdea"] + 0.5 * line_pos

def uses_meaning(results):
    ok = [r for r in results if r.get("status") == "ok"]
    return bool(ok) and all(_same_idea(r) is not None for r in ok)

def rule(results):
    return MEANING_RULE if uses_meaning(results) else RULE

def rank(results, design_kind=None):
    ok = [r for r in results if r.get("status") == "ok"]
    if uses_meaning(results):
        order = sorted({key(r) for r in ok})
        pos = {k: i / max(1, len(order) - 1) for i, k in enumerate(order)}
        score = {id(r): meaning_score(r, pos[key(r)]) for r in ok}
        results.sort(key=lambda r: (r.get("status") == "ok", score.get(id(r), 0.0), key(r)), reverse=True)
    else:
        results.sort(key=key, reverse=True)
    for i, r in enumerate(results, 1):
        r["rank"] = i
    return results
