(function (root) {
  "use strict";
  const HIGH = 1.65;
  const MEDIUM = 1.45;

  function lineKey(r) {
    const s = (r && r.status === "ok" && r.signals) || null;
    if (!s) return [0, 0, 0, 0, 0, 0, 0, 0, 0];
    return [1, s.drawingValid ? 1 : 0, s.drawingTilesMatched || 0, s.drawingTileRecallMin || 0, s.validHomography ? 1 : 0, s.edgeTilesMatched || 0, s.edgeF1 || 0, s.orbInliers || 0, -(typeof s.phashDistance === "number" ? s.phashDistance : 64)];
  }
  function cmpKey(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (b[i] || 0) - (a[i] || 0);
    return 0;
  }

  const usable = (r) => r && r.status === "ok" && r.signals;
  const usesMeaning = (entries) => {
    const ok = entries.filter(([, r]) => usable(r));
    return ok.length > 0 && ok.every(([, r]) => typeof r.signals.sameIdea === "number");
  };

  function sortKeys(entries, amazonPos) {
    const keys = new Map();
    if (!usesMeaning(entries)) {
      entries.forEach(([id, r]) => keys.set(id, lineKey(r)));
      return keys;
    }
    const ok = entries.filter(([, r]) => usable(r));
    const distinct = [];
    ok.forEach(([, r]) => {
      const k = lineKey(r);
      if (!distinct.some((d) => cmpKey(d, k) === 0)) distinct.push(k);
    });
    distinct.sort((a, b) => cmpKey(b, a));
    const pos = (k) => distinct.findIndex((d) => cmpKey(d, k) === 0) / Math.max(1, distinct.length - 1);
    const sel = amazonPos ? select(entries) : null;
    entries.forEach(([id, r]) => {
      const line = lineKey(r);
      if (!usable(r)) return keys.set(id, [0, 0, ...line]);
      const s = r.signals;
      const placed = s.drawingValid || s.validHomography ? 1 : 0;
      const v = String(id).startsWith("ebay:") ? s.sameIdea : 2 * placed + s.sameIdea + 0.5 * pos(line);
      if (amazonPos && String(id).startsWith("amazon:") && amazonPos.has(id)) {
        const tier = placed ? 2 : sel ? (sel.similar.has(id) ? 1 : 0) : s.sameIdea >= HIGH ? 1 : 0;
        return keys.set(id, [1, tier, tier ? v : -amazonPos.get(id), ...line]);
      }
      keys.set(id, [1, v, ...line]);
    });
    return keys;
  }

  const NEAR = 0.05;
  const CHANGED = 0.15;
  function select(entries) {
    const amz = entries.filter(([id]) => String(id).startsWith("amazon:"));
    const placed = (r) => usable(r) && !!(r.signals.drawingValid || r.signals.validHomography);
    const clip = (r) => (usable(r) && typeof r.signals.clipSim === "number" ? r.signals.clipSim : null);
    const anchors = amz.filter(([, r]) => placed(r) && clip(r) !== null).map(([, r]) => clip(r)).sort((a, b) => a - b);
    if (!anchors.length) return null;
    const mid = anchors.length >> 1;
    const ref = anchors.length % 2 ? anchors[mid] : (anchors[mid - 1] + anchors[mid]) / 2;
    const similar = new Set();
    const changed = new Set();
    const hidden = new Set();
    amz.forEach(([id, r]) => {
      const c = clip(r);
      if (c === null) return;
      if (placed(r)) {
        if (anchors.length >= 2 && c <= ref - CHANGED) changed.add(id);
      } else if (c >= ref - NEAR) similar.add(id);
      else hidden.add(id);
    });
    return { ref, similar, changed, hidden };
  }

  function order(entries, amazonPos) {
    const keys = sortKeys(entries, amazonPos);
    return entries.map(([id]) => id).sort((a, b) => cmpKey(keys.get(a), keys.get(b)));
  }

  function sameIdeaLevel(id, r) {
    const s = usable(r) ? r.signals : null;
    if (!s || !String(id).startsWith("ebay:") || typeof s.sameIdea !== "number") return null;
    return s.sameIdea >= HIGH ? "high" : s.sameIdea >= MEDIUM ? "medium" : "low";
  }

  root.EifScoreRules = { HIGH, MEDIUM, NEAR, CHANGED, lineKey, cmpKey, sortKeys, order, sameIdeaLevel, select };
  if (typeof module !== "undefined" && module.exports) module.exports = root.EifScoreRules;
})(typeof self !== "undefined" ? self : globalThis);
