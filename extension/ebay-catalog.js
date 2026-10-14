// Copycat Hunt: your eBay listings from Seller Hub (v3.17.0).
//
// Reads Seller Hub → Active listings (https://www.ebay.com/sh/lst/active),
// the same page you see signed in, 200 listings per page. Used by the
// resumable sync engine (merch-sync.js) through the same adapter shape as
// merch-catalog.js, so eBay gets the same save-every-page / resume rules.
//
// Paging follows eBay's own pagination block on each page ("limit",
// "offset", "totalRecords", "returnedSize", "currentPage"): the next page is
// asked for only after the page in hand says where it is, and a page that
// isn't the one asked for stops the run.
//
// Works without a DOM (service worker): plain text matching on the page.
// Kept per listing: item number, title, photo id. Nothing else.
(function (root) {
  "use strict";

  const ORIGIN = "https://www.ebay.com";
  const PAGE_SIZE = 200; // the most Seller Hub shows per page

  function pageUrl(offset, limit = PAGE_SIZE) {
    return `${ORIGIN}/sh/lst/active?offset=${Math.max(0, Number(offset) || 0)}&limit=${limit}`;
  }

  const isEndToken = (t) => !Array.isArray(t) || t.length === 0;
  const maskId = (id) => {
    const s = String(id || "");
    return s ? `${s.slice(0, 2)}…` : "";
  };
  const sameAccount = (a, b) => !!(a && b && a.accountId && b.accountId && String(a.accountId).toLowerCase() === String(b.accountId).toLowerCase());

  const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
  function decode(s) {
    return String(s || "")
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e) => {
        if (ENTITIES[e.toLowerCase()] != null) return ENTITIES[e.toLowerCase()];
        if (e[0] === "#") {
          const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return Number.isFinite(n) ? String.fromCodePoint(n) : m;
        }
        return m;
      })
      .replace(/\s+/g, " ")
      .trim();
  }
  const stripTags = (s) => String(s || "").replace(/<[^>]*>/g, " ");

  function num(block, key) {
    const m = block.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
  }

  function isSignInUrl(url) {
    return /^https:\/\/signin\.ebay\.com\//i.test(String(url || "")) || /\/(?:signin|ap\/signin)(?:[/?#]|$)/i.test(String(url || ""));
  }

  // → { state: "ok" | "signed_out" | "unexpected", userId, rows, pagination }
  function parsePage(html, url) {
    const text = String(html || "");
    if (isSignInUrl(url) || (/<form\b[^>]*(?:id|name)=["']?signin/i.test(text) && !/shui-dt/.test(text))) return { state: "signed_out", rows: [] };
    const at = text.indexOf('"pagination":{"summary"');
    const block = at >= 0 ? text.slice(at, at + 4000) : "";
    const pagination = block
      ? { limit: num(block, "limit"), offset: num(block, "offset"), totalRecords: num(block, "totalRecords"), returnedSize: num(block, "returnedSize"), totalPages: num(block, "totalPages"), currentPage: num(block, "currentPage") }
      : null;
    const okPaging = pagination && [pagination.limit, pagination.offset, pagination.totalRecords, pagination.returnedSize].every((v) => v != null);
    if (!okPaging) return { state: "unexpected", rows: [] };
    const userId = ((text.match(/"userId"\s*:\s*"([^"]{1,64})"/) || [])[1] || (text.match(/"userName"\s*:\s*"([^"]{1,64})"/) || [])[1] || "").trim();

    // Listing rows: <tr data-id="<item number>" … class="grid-row">. eBay adds
    // sub-rows with the same data-id; the parts of one listing are joined.
    const chunks = new Map();
    const re = /<tr\b([^>]*)>/gi;
    const opens = [];
    let m;
    while ((m = re.exec(text))) opens.push({ at: m.index, end: re.lastIndex, attrs: m[1] });
    for (let i = 0; i < opens.length; i++) {
      const o = opens[i];
      // eBay serves this page minified: attribute values may have no quotes.
      const id = (o.attrs.match(/\bdata-id=["']?(\d{9,15})(?=["'\s>]|$)/) || [])[1];
      if (!id) continue;
      const stop = i + 1 < opens.length ? opens[i + 1].at : Math.min(text.length, o.end + 60000);
      const body = text.slice(o.end, stop);
      chunks.set(id, (chunks.get(id) || "") + body);
      if (/class=["']?[^"'>]*\bgrid-row(?![-\w])/.test(o.attrs) && !chunks.has(`main:${id}`)) chunks.set(`main:${id}`, true);
    }
    const rows = [];
    for (const [id, body] of chunks) {
      if (id.startsWith("main:") || !chunks.has(`main:${id}`)) continue;
      let title = "";
      const cell = body.indexOf("shui-dt-column__title");
      const zone = cell >= 0 ? body.slice(cell, cell + 20000) : body;
      const anchors = zone.match(/<a\b[^>]*href=["']?[^"'\s>]*\/itm\/\d+[^>]*>[\s\S]*?<\/a>/gi) || [];
      for (const a of anchors) {
        const t = decode(stripTags(a.replace(/^<a\b[^>]*>/i, "").replace(/<\/a>$/i, "")));
        if (t) { title = t.slice(0, 200); break; }
      }
      const imageId = (body.match(/i\.ebayimg\.com\/images\/g\/([A-Za-z0-9~_-]{6,40})\//) || [])[1] || "";
      rows.push({ itemNumber: id, title, imageId });
    }
    return { state: "ok", userId, rows, pagination };
  }

  function normalizeListing(row) {
    if (!row || !/^\d{9,15}$/.test(String(row.itemNumber || ""))) return null;
    return { marketplace: "EBAY_US", asin: row.itemNumber, listingId: row.itemNumber, itemNumber: row.itemNumber, title: String(row.title || "").slice(0, 200), imageId: String(row.imageId || "") };
  }
  const productKey = (p) => `EBAY|${p.itemNumber || p.asin}`;

  // One Seller Hub page through `deps.fetch(url)` → { ok, status, url, text }
  // or { error } (the shared eBay request queue). token: [] = first page,
  // ["o", "<offset>"] = later pages.
  async function fetchListingsPage(identity, token, deps = {}) {
    const offset = isEndToken(token) ? 0 : Math.max(0, Number(token[1]) || 0);
    let r;
    try { r = await deps.fetch(pageUrl(offset, deps.pageSize || PAGE_SIZE)); } catch (e) { r = { error: "network" }; }
    if (!r) return { ok: false, reason: "network" };
    if (r.error) {
      if (r.error === "needs-ebay-tab") return { ok: false, reason: "needs_ebay_tab" };
      if (r.error === "timeout") return { ok: false, reason: "timeout" };
      if (r.error === "ebay-paused") return { ok: false, reason: r.reason === "signin" ? "logged_out" : "rate_limited" };
      if (r.error === "license") return { ok: false, reason: "license" };
      return { ok: false, reason: "network" };
    }
    if (r.quietReason === "captcha") return { ok: false, reason: "captcha" };
    if (isSignInUrl(r.url)) return { ok: false, reason: "logged_out" };
    if (r.status === 429) return { ok: false, reason: "rate_limited", status: 429 };
    if (r.status >= 500) return { ok: false, reason: "http_5xx", status: r.status };
    if (r.status === 401) return { ok: false, reason: "logged_out", status: 401 };
    const page = parsePage(r.text, r.url);
    if (page.state === "signed_out") return { ok: false, reason: "logged_out" };
    if (page.state !== "ok") return { ok: false, reason: "unexpected_response", status: r.status };
    if (identity && identity.accountId && page.userId && page.userId.toLowerCase() !== String(identity.accountId).toLowerCase()) return { ok: false, reason: "account_changed" };
    const pg = page.pagination;
    // eBay must say this is the page we asked for.
    if (pg.offset !== offset) return { ok: false, reason: "unexpected_response" };
    if (pg.currentPage != null && pg.limit && pg.currentPage !== Math.floor(offset / pg.limit) + 1 && pg.returnedSize > 0) return { ok: false, reason: "unexpected_response" };
    const more = pg.returnedSize > 0 && pg.offset + pg.returnedSize < pg.totalRecords;
    return { ok: true, results: page.rows, next: more ? ["o", String(pg.offset + (pg.limit || PAGE_SIZE))] : [], hitCount: pg.totalRecords, userId: page.userId };
  }

  const api = { ORIGIN, PAGE_SIZE, pageUrl, parsePage, fetchListingsPage, normalizeListing, productKey, isEndToken, maskId, sameAccount, isSignInUrl };
  root.EifEbayCatalog = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
