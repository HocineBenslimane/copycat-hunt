from . import config, edges, features, hashes, meaning, pixels
from .decode import decode
from .original import prepare
from .timing import Timings

def prepare_bytes(data, cfg=None, timings=None, design=False):
    cfg = cfg or config.get()
    t = timings or Timings()
    with t.part("decodeMs"):
        d = decode(data, cfg)
    with t.part("prepareMs"):
        return prepare(d, cfg, design=design)

def keyed(prepared, cfg=None):
    if getattr(prepared, "_keyed", None) is None:
        prepared._keyed = features.keyed(prepared.orb_views, cfg)
    for part in (getattr(prepared, "parts", None) or {}).values():
        keyed(part, cfg)
    return prepared._keyed

PART_KEYS = ("Valid", "Inliers", "TilesMatched", "TilesCounted", "TileRecallMin")
DRAWING_ALIGNED = {"alignedSSIM": "drawingSSIM", "missingShare": "drawingMissingShare", "missingLargest": "drawingMissingLargest",
                   "extraShare": "drawingExtraShare", "extraLargest": "drawingExtraLargest", "detailKept": "drawingDetailKept"}

def _match(original, candidate, cfg, t, key):
    with t.part(key + "OrbMs"):
        geo = features.best_match(keyed(original, cfg), keyed(candidate, cfg), cfg)
    edge = None
    if geo.valid:
        dv = next(v for v in original.orb_views if v.name == geo.design_view)
        cv = next(v for v in candidate.orb_views if v.name == geo.candidate_view)
        with t.part(key + "EdgeMs"):
            edge = edges.compare(dv, cv, geo.H, original.ink_mask, cfg)
    return geo, edge or edges.EMPTY

def compare(original, candidate, cfg=None, detail=False):
    cfg = cfg or config.get()
    t = Timings()
    with t.part("hashMs"):
        signals = hashes.compare(original.views, candidate.views)
    geo, edge = _match(original, candidate, cfg, t, "whole")
    signals.update(geo.signals())
    signals.update(edge)
    for name in ("drawing", "text"):
        part = original.parts.get(name) if original.parts else None
        if part is None:
            signals.update({name + k: None for k in PART_KEYS})
            if name == "drawing":
                signals.update({v: None for v in DRAWING_ALIGNED.values()})
            continue
        pg, pe = _match(part, candidate, cfg, t, name)
        signals.update({name + "Valid": pg.valid, name + "Inliers": pg.inliers, name + "TilesMatched": pe["edgeTilesMatched"],
                        name + "TilesCounted": pe["edgeTilesCounted"], name + "TileRecallMin": pe["edgeTileRecallMin"]})
        if name == "drawing":
            signals.update({v: pe[k] for k, v in DRAWING_ALIGNED.items()})
    signals["artPixelDiff"] = signals["artColorDiff"] = None
    if original.kind == "png" and candidate.kind == "png" and original.art is not None and candidate.art is not None:
        with t.part("pixelMs"):
            signals["artPixelDiff"] = pixels.diff(original.art, candidate.art, cfg)
            signals["artColorDiff"] = pixels.color_diff(original.art, candidate.art, cfg)
    with t.part("meaningMs"):
        signals.update(meaning.compare(original, candidate, cfg))
    out = {"candidateKind": candidate.kind, "signals": signals, "timing": t.rounded()}
    if detail:
        out["geometry"] = geo
    return out
