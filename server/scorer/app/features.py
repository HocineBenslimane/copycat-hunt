from dataclasses import dataclass, field

import cv2
import numpy as np

from . import config

@dataclass
class Keyed:
    name: str
    shape: tuple
    kps: list
    desc: np.ndarray

@dataclass
class Geometry:
    design_view: str = None
    candidate_view: str = None
    tentative: int = 0
    inliers: int = 0
    inlier_ratio: float = 0.0
    coverage_original: float = 0.0
    coverage_candidate: float = 0.0
    reproj_error_median: float = None
    scale: float = None
    valid: bool = False
    rejected: list = field(default_factory=list)
    H: np.ndarray = None

    def signals(self):
        return {
            "orbTentative": self.tentative,
            "orbInliers": self.inliers,
            "orbInlierRatio": round(self.inlier_ratio, 3),
            "coverageOriginal": round(self.coverage_original, 3),
            "coverageCandidate": round(self.coverage_candidate, 3),
            "reprojErrorMedian": None if self.reproj_error_median is None else round(self.reproj_error_median, 2),
            "geometryScale": None if self.scale is None else round(self.scale, 3),
            "validHomography": self.valid,
            "geometryRejected": list(self.rejected),
            "geometryPair": f"{self.design_view}/{self.candidate_view}" if self.design_view else None,
        }

def _orb(cfg):
    o = cfg["orb"]
    return cv2.ORB_create(nfeatures=o["nFeatures"], fastThreshold=o["fastThreshold"])

def keyed(views, cfg=None):
    cfg = cfg or config.get()
    orb = _orb(cfg)
    out = []
    for v in views:
        kps, desc = orb.detectAndCompute(v.norm, None)
        out.append(Keyed(v.name, v.norm.shape, kps or [], desc))
    return out

def _hull_fraction(pts, shape):
    if len(pts) < 3:
        return 0.0
    area = cv2.contourArea(cv2.convexHull(pts.astype(np.float32)))
    return float(area) / float(shape[0] * shape[1])

def _plausible(H, shape, o):
    h, w = shape[:2]
    corners = np.float32([[0, 0], [w, 0], [w, h], [0, h]]).reshape(-1, 1, 2)
    try:
        q = cv2.perspectiveTransform(corners, H).reshape(-1, 2)
    except cv2.error:
        return ["degenerate"], None
    if not np.all(np.isfinite(q)):
        return ["degenerate"], None
    reasons = []
    if not cv2.isContourConvex(q.astype(np.float32).reshape(-1, 1, 2)):
        reasons.append("not_convex")
    if np.linalg.det(H[:2, :2]) <= 0:
        reasons.append("mirrored")
    area = abs(cv2.contourArea(q.astype(np.float32)))
    scale = float(np.sqrt(area / (w * h))) if area > 0 else 0.0
    lo, hi = o["scaleRange"]
    if not lo <= scale <= hi:
        reasons.append("scale")
    side = lambda a, b: float(np.linalg.norm(q[a] - q[b]))
    top, right, bottom, left = side(0, 1), side(1, 2), side(2, 3), side(3, 0)
    if min(top, right, bottom, left) <= 1e-6:
        return reasons + ["degenerate"], scale
    aspect = ((top + bottom) / (left + right)) / (w / h)
    if not 1 / o["maxAspectDistortion"] <= aspect <= o["maxAspectDistortion"]:
        reasons.append("stretched")
    if min(top / bottom, bottom / top, left / right, right / left) < 1 - o["maxPerspective"]:
        reasons.append("tilted")
    return reasons, scale

def match_pair(a, b, cfg=None):
    cfg = cfg or config.get()
    o = cfg["orb"]
    g = Geometry(a.name, b.name)
    if a.desc is None or b.desc is None or len(a.kps) < 2 or len(b.kps) < 2:
        g.rejected = ["no_keypoints"]
        return g
    pairs = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(a.desc, b.desc, k=2)
    good = [m for m, *rest in pairs if rest and m.distance < o["ratioTest"] * rest[0].distance]
    g.tentative = len(good)
    if len(good) < 4:
        g.rejected = ["too_few_matches"]
        return g
    src = np.float32([a.kps[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([b.kps[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    cv2.setRNGSeed(0)
    H, mask = cv2.findHomography(src, dst, cv2.RANSAC, o["ransacReprojThreshold"],
                                 maxIters=o["ransacMaxIters"], confidence=o["ransacConfidence"])
    if H is None or mask is None:
        g.rejected = ["no_homography"]
        return g
    inl = mask.ravel().astype(bool)
    g.inliers = int(inl.sum())
    g.inlier_ratio = g.inliers / g.tentative
    s, d = src[inl].reshape(-1, 2), dst[inl].reshape(-1, 2)
    g.coverage_original = _hull_fraction(s, a.shape)
    g.coverage_candidate = _hull_fraction(d, b.shape)
    if g.inliers:
        proj = cv2.perspectiveTransform(s.reshape(-1, 1, 2), H).reshape(-1, 2)
        g.reproj_error_median = float(np.median(np.linalg.norm(proj - d, axis=1)))
    reasons, g.scale = _plausible(H, a.shape, o)
    if g.inliers < o["minInliers"]:
        reasons.insert(0, "too_few_inliers")
    if g.coverage_original < o["minHullFraction"]:
        reasons.append("bunched")
        if reasons == ["bunched"] and g.inliers >= o.get("bunchedRescueInliers", 10 ** 9):
            reasons = []
    g.rejected = reasons
    g.valid = not reasons
    g.H = H
    return g

def best_match(design_keyed, candidate_keyed, cfg=None):
    best = None
    for a in design_keyed:
        for b in candidate_keyed:
            g = match_pair(a, b, cfg)
            if best is None or (g.valid, g.inliers, g.coverage_original) > (best.valid, best.inliers, best.coverage_original):
                best = g
    return best or Geometry(rejected=["no_views"])
