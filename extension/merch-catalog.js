// Copycat Hunt: signed-in Merch on Demand catalog recognition.
//
// Pipeline (from Djawed's trace of Snap 4.0.8, SNP0050/SNP0065/SNP0042/SNP0060,
// re-implemented with our own code):
//   authorized merch.amazon.com session (the browser's own cookies)
//   → verified account identity (GET /dashboard, embedded accountId/customerId)
//   → paginated catalog download (POST …/MerchSearchService/FindListings)
//   → account-bound normalized products (asin, marketplace, designId, …)
//   → tri-state lookup: catalog_matched | not_found | unknown
//
// What a match means: the ASIN is a listing in the SIGNED-IN Merch account's
// catalog. It does not prove who made the artwork. A failed or partial sync is
// never turned into a match or a "not yours"; it stays unknown.
//
// Endpoint shapes come from static inspection, not a published API, and need a
// live, active Merch account to confirm.
(function (root) {
  "use strict";

  const DASHBOARD_URL = "https://merch.amazon.com/dashboard";
  const FIND_LISTINGS_URL = "https://merch.amazon.com/api/ng-amazon/coral/com.amazon.merch.search.MerchSearchService/FindListings";
  const ALL_STATUSES = ["DRAFT", "TRANSLATING", "REVIEW", "UNDER_REVIEW", "UNDER_AUTO_REVIEW", "DECLINED", "REJECTED", "MANUALLY_REJECTED", "AMAZON_REJECTED", "PUBLISHING", "TIMED_OUT", "PROPAGATED", "PUBLISHED", "REMOVED", "DELETED", "DELETING", "LOCKED"];
  const PAGE_SIZE = 500;
  const MAX_PAGES = 400; // 200,000 listings; a safety stop, not an expected size
  const IDENTITY_FRESH_MS = 5 * 60 * 1000;
  const GONE_STATUSES = new Set(["DELETED", "REMOVED", "DELETING"]);

  // Retail marketplace ids and names → our codes. Anything else is kept as
  // "?<raw>" so a lookup can say "unknown" instead of a wrong "not found".
  const MARKETPLACE_IDS = {
    ATVPDKIKX0DER: "US", A1F83G8C2ARO7P: "UK", A1PA6795UKMFR9: "DE", A13V1IB3VIYZZH: "FR",
    APJ6JRA9NG5V4: "IT", A1RKKUPIHCS9HS: "ES", A1VC38T7YXB528: "JP",
  };
  const MARKETPLACE_NAMES = {
    US: "US", USA: "US", COM: "US", "AMAZON.COM": "US", "WWW.AMAZON.COM": "US",
    UK: "UK", GB: "UK", "AMAZON.CO.UK": "UK", DE: "DE", "AMAZON.DE": "DE", FR: "FR", "AMAZON.FR": "FR",
    IT: "IT", "AMAZON.IT": "IT", ES: "ES", "AMAZON.ES": "ES", JP: "JP", "AMAZON.CO.JP": "JP",
  };

  function normalizeMarketplace(value) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return "";
    const up = raw.toUpperCase();
    return MARKETPLACE_IDS[up] || MARKETPLACE_NAMES[up] || `?${up}`;
  }

  function normalizeAsin(value) {
    const v = String(value == null ? "" : value).trim().toUpperCase();
    return /^[A-Z0-9]{10}$/.test(v) ? v : "";
  }

  // ---------- identity ----------

  // Classify the /dashboard response. Never treats a sign-in page as a
  // catalog that happens to be empty.
  function isRateLimited(status, url) {
    let path = "";
    try {
      path = new URL(String(url || "")).pathname;
    } catch (e) {}
    return status === 429 || /(?:^|\/)429(?:[/?#]|$)/.test(path);
  }

  // Retry-After can be seconds or an HTTP date.
  function retryAfterMs(res) {
    const raw = res && res.headers && typeof res.headers.get === "function" ? res.headers.get("Retry-After") || res.headers.get("retry-after") : null;
    if (raw == null || raw === "") return 0;
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
    const at = Date.parse(raw);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
  }

  const LOGIN_PATH = /\/ap\/signin|\/ap\/register|signin\.amazon|sign[-_]?in|auth\/login|\/login/i;
  const LOGIN_HTML = /id=["']ap_email["']|name=["']signIn["']|id=["']signInSubmit["']|name=["']password["']|\/ap\/signin/i;

  // Classify the /dashboard response. Never treats a sign-in page as a
  // catalog that happens to be empty. Both ids are required, as in the trace.
  function parseIdentity({ status, url, html, redirected }) {
    const u = String(url || "");
    const text = String(html || "");
    let path = "";
    try {
      path = new URL(u).pathname;
    } catch (e) {}
    if (isRateLimited(status, u)) return { state: "rate_limited" };
    if (status === 401 || status === 403 || status === 404) return { state: "logged_out", reason: `http_${status}` };
    if (/\/ap\/(signin|register)|signin\.amazon/i.test(u) || (redirected && LOGIN_PATH.test(path))) return { state: "logged_out", reason: "redirect" };
    if (!(status >= 200 && status < 300)) return { state: "error", reason: `http_${status}` };
    if (LOGIN_HTML.test(text)) return { state: "logged_out", reason: "login_page" };
    const accountId = (text.match(/"accountId":"([^"]+)"/) || [])[1] || "";
    const customerId = (text.match(/"customerId":"([^"]+)"/) || [])[1] || "";
    if (!accountId || !customerId) return { state: "error", reason: "identity_not_found" };
    return { state: "verified", accountId, customerId };
  }

  function sameAccount(a, b) {
    if (!a || !b || !a.accountId || !b.accountId) return false;
    if (a.accountId !== b.accountId) return false;
    if (a.customerId && b.customerId && a.customerId !== b.customerId) return false;
    return true;
  }

  function maskId(id) {
    const s = String(id || "");
    return s.length > 4 ? `…${s.slice(-4)}` : s;
  }

  // ---------- listing records ----------

  function pick(obj, keys) {
    for (const k of keys) {
      if (obj && obj[k] != null && obj[k] !== "") return obj[k];
    }
    return "";
  }

  function normalizeListing(r) {
    if (!r || typeof r !== "object") return null;
    const asin = normalizeAsin(pick(r, ["asin", "ASIN", "retailAsin", "productAsin"]));
    const status = String(pick(r, ["status", "listingStatus", "state"]) || "").trim().toUpperCase();
    if (!asin || !status) return null; // drafts without a retail ASIN can't match retail pages
    return {
      asin,
      marketplace: normalizeMarketplace(pick(r, ["marketplace", "marketplaceId", "marketplaceName"])),
      status,
      designId: String(pick(r, ["designId", "design_id"]) || ""),
      listingId: String(pick(r, ["listingId", "listing_id", "id"]) || ""),
      parentAsin: normalizeAsin(pick(r, ["parentAsin", "parent_asin"])),
      adSafeAsin: normalizeAsin(pick(r, ["adSafeAsin", "ad_safe_asin"])),
      productType: String(pick(r, ["productType", "product_type"]) || ""),
    };
  }

  // ---------- sync ----------

  function findListingsBody(accountId, pageToken) {
    return {
      accountId,
      marketplaces: null,
      pageToken: pageToken == null ? [] : normalizeToken(pageToken),
      pageSize: PAGE_SIZE,
      sortField: "DateCreated",
      sortOrder: "Ascending",
      status: ALL_STATUSES,
      productTypes: null,
      searchableOnRetail: null,
      __type: "com.amazon.merch.search#FindListingsRequest",
    };
  }

  // Page tokens are opaque. The service returns an array of strings (two
  // entries mid-catalog, empty at the end); we pass back exactly what we got.
  function normalizeToken(t) {
    if (t == null) return [];
    if (Array.isArray(t)) return t.map((v) => String(v == null ? "" : v)).filter(Boolean);
    const s = String(t);
    return s ? s : [];
  }
  function isEndToken(t) {
    return Array.isArray(t) ? t.length === 0 : !t;
  }

  // One FindListings page, with retries. Returns
  //   { ok: true, results, next, hitCount }  or  { ok: false, reason, status }.
  // The deadline covers the whole response (headers AND body), so a body that
  // trickles in can't hang the sync. `deps.onWait(ms, why)` is told about
  // service-requested waits (429 Retry-After) before they happen.
  async function fetchListingsPage(identity, token, deps) {
    const fetchFn = deps.fetch;
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const timeoutMs = deps.timeoutMs || 60000;
    const pageSize = deps.pageSize || PAGE_SIZE;
    for (let attempt = 0; attempt < 4; attempt++) {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; if (ctrl) ctrl.abort(); }, timeoutMs);
      let res;
      let text;
      try {
        const body = findListingsBody(identity.accountId, token);
        body.pageSize = pageSize;
        res = await fetchFn(FIND_LISTINGS_URL, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
          ...(ctrl ? { signal: ctrl.signal } : {}),
        });
        if (isRateLimited(res.status, res.url)) {
          clearTimeout(timer);
          if (attempt === 3) return { ok: false, reason: "rate_limited", status: res.status };
          const wait = Math.min(Math.max(retryAfterMs(res), 3000 * (attempt + 1)), 5 * 60 * 1000);
          if (deps.onWait) await deps.onWait(wait, "rate_limited");
          await sleep(wait);
          continue;
        }
        if (res.status === 401 || res.status === 403 || res.redirected || /\/ap\/signin/i.test(res.url || "")) { clearTimeout(timer); return { ok: false, reason: "logged_out", status: res.status }; }
        if (!res.ok) {
          clearTimeout(timer);
          if (res.status >= 500 && attempt < 3) {
            await sleep(1500 * (attempt + 1));
            continue;
          }
          return { ok: false, reason: `http_${res.status}`, status: res.status };
        }
        const type = res.headers && typeof res.headers.get === "function" ? res.headers.get("content-type") || "" : "";
        if (type && !/json/i.test(type)) { clearTimeout(timer); return { ok: false, reason: "logged_out", status: res.status }; } // HTML instead of JSON = session problem
        text = await res.text();
        clearTimeout(timer);
      } catch (e) {
        clearTimeout(timer);
        if (attempt === 3) return { ok: false, reason: timedOut ? "timeout" : "network" };
        await sleep(1000 * (attempt + 1));
        continue;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return { ok: false, reason: "logged_out" };
      }
      if (!data || !Array.isArray(data.results)) return { ok: false, reason: "unexpected_response" };
      const reported = Number(data.hitCount);
      const hitCount = data.hitCount != null && data.hitCount !== "" && Number.isFinite(reported) && reported >= 0 ? reported : null;
      return { ok: true, results: data.results, next: normalizeToken(data.pageToken), hitCount };
    }
    return { ok: false, reason: "network" };
  }

  // Full download in one call (kept for small catalogs and the tests). The
  // service worker uses the resumable engine in merch-sync.js instead.
  //
  // Completion rules (from the sync coordinator's full refresh):
  //  - a page with results but no next token is the last page, and the count
  //    loaded must reach the reported total;
  //  - an empty page only ends the sync if the total is reached;
  //  - a page token we already sent means the paging is going in circles.
  async function downloadCatalog(identity, deps) {
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const shouldStop = deps.shouldStop || (() => false);
    const pauseMs = deps.pauseMs == null ? 500 : deps.pauseMs;
    const maxPages = deps.maxPages || MAX_PAGES;
    const products = [];
    const seenTokens = new Set();
    let token = [];
    let hitCount = null;
    let loaded = 0; // raw records, including drafts we don't keep
    for (let page = 0; page < maxPages; page++) {
      if (shouldStop()) return { ok: false, reason: "cancelled" };
      if (page > 0 && pauseMs) await sleep(pauseMs);
      const got = await fetchListingsPage(identity, token, { ...deps, sleep });
      if (!got.ok) return { ok: false, reason: got.reason };
      if (got.hitCount != null) hitCount = got.hitCount;
      const next = got.next;
      if (!got.results.length) {
        if (hitCount == null || loaded >= hitCount) return { ok: true, products, hitCount: hitCount == null ? loaded : hitCount, pages: page + 1 };
        return { ok: false, reason: "pagination_incomplete" };
      }
      loaded += got.results.length;
      for (const r of got.results) {
        const p = normalizeListing(r);
        if (p) products.push(p);
      }
      if (isEndToken(next)) {
        if (hitCount != null && loaded < hitCount) return { ok: false, reason: "pagination_incomplete" };
        return { ok: true, products, hitCount: hitCount == null ? loaded : hitCount, pages: page + 1 };
      }
      const key = JSON.stringify(next);
      if (seenTokens.has(key)) return { ok: false, reason: "repeated_page_token" };
      seenTokens.add(key);
      token = next;
    }
    return { ok: false, reason: "too_many_pages" };
  }

  // ---------- lookup ----------

  // Index once per catalog revision.
  function buildIndex(catalog) {
    const exact = new Map(); // "US|ASIN" -> product
    const alias = new Map(); // "US|ASIN" -> Set(canonical asin)
    let unrecognizedMarketplaces = 0;
    for (const p of catalog.products || []) {
      if (!p.marketplace || p.marketplace.startsWith("?")) unrecognizedMarketplaces++;
      const key = `${p.marketplace}|${p.asin}`;
      const prev = exact.get(key);
      if (!prev || (!prev.designId && p.designId)) exact.set(key, p);
      for (const a of [p.parentAsin, p.adSafeAsin]) {
        if (!a || a === p.asin) continue;
        const k = `${p.marketplace}|${a}`;
        if (!alias.has(k)) alias.set(k, new Set());
        alias.get(k).add(p.asin);
      }
    }
    return { exact, alias, unrecognizedMarketplaces, revision: catalog.revision };
  }

  function matchIn(index, mp, a) {
    const hit = index.exact.get(`${mp}|${a}`);
    if (hit) return { state: "catalog_matched", matchType: "exact", canonicalAsin: hit.asin, designId: hit.designId, status: hit.status };
    const via = index.alias.get(`${mp}|${a}`);
    if (via && via.size === 1) {
      const canonical = [...via][0];
      const p = index.exact.get(`${mp}|${canonical}`);
      return { state: "catalog_matched", matchType: "parent_or_ad_safe", canonicalAsin: canonical, designId: p ? p.designId : "", status: p ? p.status : "" };
    }
    if (via && via.size > 1) return { state: "unknown", reason: "ambiguous_alias" };
    return null;
  }

  // One identity: { state: "catalog_matched", matchType, canonicalAsin, designId }
  //             | { state: "not_found" } | { state: "unknown", reason }
  // `pageAsins` are extra ASINs read from the public product page (its
  // parent/variation ASIN). They are checked only after the ASIN itself.
  function lookupOne(index, catalog, asin, marketplace, pageAsins) {
    const a = normalizeAsin(asin);
    const mp = normalizeMarketplace(marketplace);
    if (!a || !mp || mp.startsWith("?")) return { state: "unknown", reason: "bad_identity" };
    const own = matchIn(index, mp, a);
    if (own) return own;
    for (const c of [...new Set((pageAsins || []).map(normalizeAsin).filter((x) => x && x !== a))].slice(0, 4)) {
      const viaPage = matchIn(index, mp, c);
      if (viaPage && viaPage.state === "catalog_matched") return { ...viaPage, matchType: "product_page", matchedVia: c };
      if (viaPage) return viaPage; // ambiguous stays unknown
    }
    if (index.unrecognizedMarketplaces) return { state: "unknown", reason: "unrecognized_marketplace_records" };
    return { state: "not_found" };
  }

  const api = {
    DASHBOARD_URL,
    FIND_LISTINGS_URL,
    ALL_STATUSES,
    PAGE_SIZE,
    IDENTITY_FRESH_MS,
    GONE_STATUSES,
    normalizeMarketplace,
    normalizeAsin,
    normalizeToken,
    retryAfterMs,
    parseIdentity,
    sameAccount,
    maskId,
    normalizeListing,
    findListingsBody,
    isEndToken,
    fetchListingsPage,
    downloadCatalog,
    buildIndex,
    lookupOne,
  };
  root.EifMerchCatalog = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : globalThis);
