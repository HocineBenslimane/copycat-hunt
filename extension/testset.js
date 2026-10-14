// v3.25.0: labeled test set export (builder tools in the toolbar menu).
// Pure functions, no DOM, no network. Turns what's already in
// chrome.storage.local into one row per (design, candidate):
//   reported  — the candidate is in a report for that design
//   tracked   — tracked under that design (and not reported)
//   skipped   — it came up in that design's search and you left it
// Your own listings (protected, marked as yours, or flagged as yours when the
// search was saved) are left out entirely.
(function (root) {
  const PREFIX = "eifTestSet:";
  const COLUMNS = ["design_id", "design_image_url", "candidate_id", "candidate_image_url", "title", "marketplace", "search_score", "position", "label", "label_date", "seen_date"];

  const day = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "");
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const https = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : "");

  // data: the raw chrome.storage.local values (see storageKeys()).
  function buildRows(data) {
    const sets = obj(data.sets);
    const hunts = obj(data.hunts);
    const own = new Set([...(Array.isArray(data.protectedItems) ? data.protectedItems : []), ...(Array.isArray(data.amazonMine) ? data.amazonMine : [])].map(String));
    const reported = new Map(); // "hunt|site|id" -> { date, image, title }
    const tracked = new Map();
    const key = (hunt, site, id) => `${hunt}|${site}|${id}`;

    (Array.isArray(data.history) ? data.history : []).forEach((r) => {
      if (!r || !Array.isArray(r.items)) return;
      const site = r.site === "amazon" ? "amazon" : "ebay";
      r.items.forEach((it) => it && it.n && reported.set(key(r.design || "", site, String(it.n)), { date: day(r.sentAt), image: it.image || "" }));
    });
    const addTracked = (list, site) =>
      Object.entries(obj(list)).forEach(([id, m]) => {
        m = obj(m);
        const k = key(m.hunt || "", site, id);
        const meta = { date: day(m.addedAt), image: m.image || "", title: m.title || "" };
        if (m.reportedAt && !reported.has(k)) reported.set(k, { ...meta, date: day(m.reportedAt) });
        tracked.set(k, meta);
      });
    addTracked(data.ebayTracked, "ebay");
    addTracked(data.amazonTracked, "amazon");

    const designImage = (hunt) => https((obj(sets[hunt]).design)) || https(obj(hunts[hunt]).image);
    const rows = [];
    const done = new Set();
    const labelFor = (k) => (reported.has(k) ? ["reported", reported.get(k).date] : tracked.has(k) ? ["tracked", tracked.get(k).date] : ["skipped", ""]);

    Object.entries(sets).forEach(([hunt, set]) => {
      (Array.isArray(obj(set).items) ? set.items : []).forEach((r) => {
        if (!r || !r.id || (r.m !== "ebay" && r.m !== "amazon")) return;
        if (r.own || own.has(String(r.id))) return;
        const k = key(hunt, r.m, String(r.id));
        if (done.has(k)) return;
        done.add(k);
        const [label, labelDate] = labelFor(k);
        rows.push({ design_id: hunt, design_image_url: designImage(hunt), candidate_id: String(r.id), candidate_image_url: https(r.img), title: r.t || "", marketplace: r.m, search_score: typeof r.s === "number" ? r.s : "", position: r.p || "", label, label_date: labelDate, seen_date: day(r.at) });
      });
    });

    // Tracked / reported copies whose search wasn't saved (older ones):
    // still positives, just without a position or score.
    let noDesign = 0;
    new Set([...reported.keys(), ...tracked.keys()]).forEach((k) => {
      if (done.has(k)) return;
      const [hunt, site, id] = k.split("|");
      if (own.has(id)) return;
      if (!hunt) return void noDesign++;
      done.add(k);
      const meta = { ...(tracked.get(k) || {}), ...(reported.get(k) || {}) };
      const [label, labelDate] = labelFor(k);
      rows.push({ design_id: hunt, design_image_url: designImage(hunt), candidate_id: id, candidate_image_url: https(meta.image), title: (tracked.get(k) || {}).title || "", marketplace: site, search_score: "", position: "", label, label_date: labelDate, seen_date: "" });
    });
    return { rows, noDesign };
  }

  // Titles come from listing pages, so a cell starting with = + - @ is
  // prefixed with ' to keep spreadsheets from running it as a formula.
  function cell(v) {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s) && typeof v !== "number") s = "'" + s;
    return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function toCsv(rows) {
    return [COLUMNS.join(","), ...rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
  }

  function counts(rows) {
    const c = { reported: 0, tracked: 0, skipped: 0 };
    rows.forEach((r) => c[r.label]++);
    return c;
  }

  root.EifTestSet = { PREFIX, COLUMNS, buildRows, toCsv, counts };
  if (typeof module === "object" && module.exports) module.exports = root.EifTestSet;
})(typeof self !== "undefined" ? self : globalThis);
