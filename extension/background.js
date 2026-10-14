// Copycat Hunt background helper.
// The content script runs inside eBay pages, and Chrome won't let an eBay page
// call amazon.com. This worker does the Amazon look-alike search (the same one
// amazon.com/stylesnap uses) and hands the results back. It only talks to
// www.amazon.com, with the user's own Amazon cookies.

const STYLESNAP_PAGE = "https://www.amazon.com/stylesnap";
const STYLESNAP_UPLOAD = "https://www.amazon.com/stylesnap/upload";

// The upload needs a one-time token that the stylesnap page puts in
// <input type="hidden" name="stylesnap" value="...">. No DOMParser in a
// service worker, so read it with a regex (attribute order can vary).
function readToken(html) {
  const tags = html.match(/<input\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/\bname\s*=\s*["']stylesnap["']/i.test(tag)) continue;
    const v = tag.match(/\bvalue\s*=\s*["']([^"']+)["']/i);
    if (v) return v[1];
  }
  return null;
}

function base64ToBlob(base64, type) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || "image/jpeg" });
}

function simplify(json) {
  const groups = (json && json.searchResults) || [];
  // Amazon may split the photo into several detected items (top, bottoms…).
  // Merge them, keeping the best score per ASIN and Amazon's order.
  const scores = new Map();
  const meta = new Map();
  const order = [];
  for (const g of groups) {
    for (const s of g.subContent || []) {
      if (s.contentType !== "ASIN" || !s.content) continue;
      const score = parseFloat((s.properties || {}).score);
      if (!scores.has(s.content)) order.push(s.content);
      if (!isNaN(score) && !(scores.get(s.content) >= score)) scores.set(s.content, score);
    }
    for (const a of g.bbxAsinList || []) if (!order.includes(a)) order.push(a);
    for (const m of g.bbxAsinMetadataList || []) if (m && m.asin && !meta.has(m.asin)) meta.set(m.asin, m);
  }
  const items = [];
  for (const asin of order) {
    const m = meta.get(asin);
    if (!m) continue; // Amazon only sends details for the first ~30
    items.push({
      asin,
      title: String(m.title || ""),
      brand: String(m.byLine || ""),
      price: String(m.price || ""),
      rating: typeof m.averageOverallRating === "number" ? m.averageOverallRating : null,
      reviews: String(m.totalReviewCount || ""),
      image: String(m.imageUrl || ""),
      score: scores.has(asin) ? scores.get(asin) : null,
      url: `https://www.amazon.com/dp/${asin}`,
    });
  }
  return { items, totalAsins: order.length };
}

async function amazonSearch(base64, type) {
  if (typeof base64 !== "string" || base64.length > 12 * 1024 * 1024) return { error: "invalid-image" };
  let page;
  try {
    page = await fetch(STYLESNAP_PAGE, { credentials: "include" });
  } catch (e) {
    return { error: "network" };
  }
  if (!page.ok) return { error: "blocked", status: page.status };
  const token = readToken(await page.text());
  if (!token) return { error: "blocked" }; // usually: no Amazon cookies yet, or a robot check
  const form = new FormData();
  form.append("explore-looks.jpg", base64ToBlob(base64, type), "explore-looks.jpg");
  let res;
  try {
    res = await fetch(`${STYLESNAP_UPLOAD}?stylesnapToken=${encodeURIComponent(token)}`, {
      method: "POST",
      body: form,
      credentials: "include",
    });
  } catch (e) {
    return { error: "network" };
  }
  if (res.status === 403 || res.status === 401) return { error: "blocked", status: res.status };
  if (!res.ok) return { error: "failed", status: res.status };
  let json;
  try {
    json = await res.json();
  } catch (e) {
    return { error: "failed" };
  }
  return { ok: true, ...simplify(json) };
}

// ---------- eBay, for when the popup runs on an Amazon page ----------
// Chrome blocks an amazon.com page from reading ebay.com, so these do it.
// Only www.ebay.com is allowed, read-only, except the image-search POST.
const EBAY_ORIGIN = "https://www.ebay.com";

function isEbayUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "www.ebay.com";
  } catch (e) {
    return false;
  }
}

// All eBay reads share one queue across tabs. No header impersonation,
// hidden helper tabs, or alternate transport retries after a block.
importScripts("ebay-requests.js");
const ER = self.EifEbayRequests;
// (v3.5.2 removed the old header-rewrite rules; session rules are gone after
// any browser restart, so the declarativeNetRequest permission was dropped.)
const oldEbayRulesRemoved = Promise.resolve();

// A license that ends while requests wait in the queue stops them here.
async function licensedNow() {
  try { await requireLicense(); return true; } catch (e) { return false; }
}

const MAX_PAGE_TEXT = 8 * 1024 * 1024;
function ebayFinal(result) {
  // Redirects may only end on eBay; never hand another site's page back.
  if (result && result.url) {
    try {
      const h = new URL(result.url).hostname;
      if (!(h === "ebay.com" || h.endsWith(".ebay.com"))) return { ok: false, error: "redirected", status: 0 };
    } catch (e) { return { ok: false, error: "redirected", status: 0 }; }
  }
  if (result && typeof result.text === "string" && result.text.length > MAX_PAGE_TEXT) result.text = result.text.slice(0, MAX_PAGE_TEXT);
  return result;
}

async function performEbayRequest(input, sender) {
  if (!(await licensedNow())) return { ok: false, error: "license", status: 0 };
  return ebayFinal(await performEbayRequestRaw(input, sender));
}

// An eBay tab the customer already has open (most recently used first). Never
// opens one by itself here; a hunt you start opens one in the background when
// eBay asks for it (v3.18.8, eif-ebay-open-tab).
async function openEbayTabId() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://www.ebay.com/*" });
    // A tab sitting on eBay's robot check can't run requests (v3.18.6: it kept
    // pausing every search again, even after the check was done elsewhere).
    const ok = tabs.filter((t) => t.id != null && !t.discarded && t.status === "complete" && isEbayUrl(t.url || "") && !isEbayCheckUrl(t.url || ""));
    ok.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return ok.length ? ok[0].id : null;
  } catch (e) {
    return null;
  }
}

async function performEbayRequestRaw(input, sender) {
  await oldEbayRulesRemoved;
  // The request runs inside an eBay page: the tab that started it, or else an
  // eBay tab the customer has open. eBay turns away its search pages when
  // they're asked for from the extension itself (that's what showed up as
  // "eBay denied this request" on Amazon hunts). Chosen before the request;
  // a rejected response is never retried from another tab or origin.
  const fromEbayTab = sender?.tab?.id != null && isEbayUrl(sender.url || sender.tab.url || "");
  const tabId = fromEbayTab ? sender.tab.id : await openEbayTabId();
  if (tabId != null) {
    const out = await runEbayRequestInTab(tabId, input);
    if (fromEbayTab) return out || { ok: false, error: "timeout" };
    if (out && out.error !== "wrong-origin") return out;
    // The tab couldn't run it (closed, loading): fall through to the worker.
  }
  const r = await performEbayWorkerFetch(input);
  // A plain 403 here means "not from the extension", not a robot check: don't
  // pause eBay for every tab, ask for an eBay tab instead.
  if (r && r.status === 403 && ER.classify(r) !== "captcha") return { ok: false, error: "needs-ebay-tab", status: 0 };
  return r;
}

async function runEbayRequestInTab(tabId, input) {
  let capTimer;
  try {
    // A tab that never runs the script (frozen in the background, mid-load)
    // must not hold the request: give up after 20 s.
    const cap = new Promise((resolve) => { capTimer = setTimeout(() => resolve([{ result: { ok: false, error: "tab-timeout" } }]), 20000); });
    const [out] = await Promise.race([chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: async (request) => {
        if (location.origin !== "https://www.ebay.com") return { ok: false, error: "wrong-origin" };
        if (/\/(?:splashui|splashui_rc|challenge|captcha|ecaptcha)(?:\/|$)/i.test(location.pathname) ||
            /pardon our interruption|security measure|verify (?:that )?you(?:'re| are) human|robot check|access denied|checking your browser/i.test(document.title)) {
          return { ok: false, status: 403, url: location.href, text: `<title>${document.title}</title>` };
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        try {
          let body;
          if (request.method === "POST") {
            body = new FormData();
            body.append("isVisualSearch", "true");
            body.append("imageData", request.base64);
          }
          let r;
          try {
            r = await fetch(request.url, { method: request.method, body, credentials: "include", signal: ctrl.signal });
          } catch (e) {
            if (e.name === "AbortError" || request.method === "POST" || !/^https:\/\/www\.ebay\.com\/sh\//i.test(request.url)) throw e;
            // Seller Hub redirected off www.ebay.com (to sign-in), which this
            // page may not read. Ask again without following: a redirect here,
            // with your eBay cookies, means you're signed out.
            const m = await fetch(request.url, { method: "GET", credentials: "include", signal: ctrl.signal, redirect: "manual" });
            if (m.type === "opaqueredirect") return { ok: false, status: 401, url: "https://signin.ebay.com/ws/eBayISAPI.dll?SignIn", text: "" };
            throw e;
          }
          return { ok: r.ok, status: r.status, url: r.url, retryAfter: r.headers.get("retry-after"), text: request.method === "HEAD" ? "" : await r.text() };
        } catch (e) { return { ok: false, error: e.name === "AbortError" ? "timeout" : "network" }; }
        finally { clearTimeout(timer); }
      },
      args: [input],
    }), cap]);
    const r = out?.result || null;
    return r && r.error === "tab-timeout" ? null : r;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(capTimer);
  }
}

async function performEbayWorkerFetch(input) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    let body;
    if (input.method === "POST") {
      body = new FormData();
      body.append("isVisualSearch", "true");
      body.append("imageData", input.base64);
    }
    // v3.18.7: Seller Hub sends a signed-out visitor to signin.ebay.com, a
    // site this extension has no access to. Followed from here, that was a
    // CORS error in chrome://extensions and read as "no connection". Not
    // followed: the redirect means "ask from an eBay tab", where it's read
    // properly (signed out, or your listings).
    const sellerHub = /^https:\/\/www\.ebay\.com\/sh\//i.test(String(input.url || "")) && input.method !== "POST";
    const r = await fetch(input.url, { method: input.method, body, credentials: "include", signal: ctrl.signal, redirect: sellerHub ? "manual" : "follow" });
    if (r.type === "opaqueredirect") return { ok: false, error: "needs-ebay-tab", status: 0 };
    return { ok: r.ok, status: r.status, url: r.url, retryAfter: r.headers.get("retry-after"), text: input.method === "HEAD" ? "" : await r.text() };
  } finally { clearTimeout(timer); }
}

// v3.18.2: eBay showed a robot check (captcha). Copycat Hunt never touches
// it: it opens eBay in a normal tab, in front, so you complete the check
// yourself. At most once every 2 minutes; an open check tab is focused instead.
let ebayCheckTabAt = 0;
let ebayCheck = null; // { tabId, created, returnTabId, returnWindowId }
function isEbayCheckUrl(u) { return EBAY_CHECK_RE.test(String(u || "")); }
const EBAY_CHECK_RE = /^https:\/\/www\.ebay\.com\/(?:splashui|splashui_rc|challenge|captcha|ecaptcha)(?:[/?#]|$)/i;
async function openEbayCheckTab(result, input, context) {
  if (Date.now() - ebayCheckTabAt < 2 * 60 * 1000) return;
  ebayCheckTabAt = Date.now();
  const back = context && context.tab ? { returnTabId: context.tab.id, returnWindowId: context.tab.windowId } : {};
  try {
    const open = await chrome.tabs.query({ url: ["https://www.ebay.com/splashui/*", "https://www.ebay.com/captcha*"] });
    if (open && open[0]) {
      ebayCheck = { tabId: open[0].id, created: false, ...back };
      await chrome.tabs.update(open[0].id, { active: true });
      if (chrome.windows && open[0].windowId != null) chrome.windows.update(open[0].windowId, { focused: true }).catch(() => {});
      return;
    }
    const url = isEbayCheckUrl(result && result.url) ? result.url : input && input.method !== "POST" && isEbayUrl(input.url) ? input.url : `${EBAY_ORIGIN}/`;
    const tab = await chrome.tabs.create({ url, active: true });
    ebayCheck = { tabId: tab && tab.id, created: true, ...back };
  } catch (e) { /* tab APIs unavailable: the panel still explains what to do */ }
}

// v3.18.6: once that tab leaves the robot check (you completed it and eBay
// moved on to a normal page), eBay is resumed by itself, the tab we opened is
// closed and you're taken back to the tab you were hunting from.
async function ebayCheckPassed(tabId, url) {
  const check = ebayCheck;
  if (!check || check.tabId !== tabId || !isEbayUrl(url) || isEbayCheckUrl(url)) return;
  ebayCheck = null;
  try {
    const st = await ebayRequests.status();
    if (st.paused && st.reason === "captcha") await ebayRequests.resume({ url: `${EBAY_ORIGIN}/`, method: "GET" }, null);
    if (check.created) await chrome.tabs.remove(tabId).catch(() => {});
    if (check.returnTabId != null) {
      await chrome.tabs.update(check.returnTabId, { active: true }).catch(() => {});
      if (chrome.windows && check.returnWindowId != null) chrome.windows.update(check.returnWindowId, { focused: true }).catch(() => {});
    }
  } catch (e) { /* the page's own "check again when you return" still works */ }
}
if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (ebayCheck && tabId === ebayCheck.tabId && info.status === "complete") ebayCheckPassed(tabId, (tab && tab.url) || info.url || "");
  });
}
if (chrome.tabs && chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener((tabId) => { if (ebayCheck && ebayCheck.tabId === tabId) ebayCheck = null; });

const ebayRequests = ER.create({
  onBlock: (reason, result, input, context) => { if (reason === "captcha") openEbayCheckTab(result, input, context); },
  load: async () => (await chrome.storage.local.get(ER.STATE_KEY))[ER.STATE_KEY],
  save: (state) => chrome.storage.local.set({ [ER.STATE_KEY]: state }),
  perform: performEbayRequest,
});

function ebayFetchText(url, method, sender, priority) {
  if (!isEbayUrl(url) || ![undefined, "GET", "HEAD"].includes(method)) return Promise.resolve({ error: "not-allowed" });
  const u = new URL(url);
  if (u.username || u.password) return Promise.resolve({ error: "not-allowed" });
  u.hash = "";
  return ebayRequests.request({ url: u.href, method: method || "GET", ...(priority === "high" ? { priority: "high" } : {}) }, sender);
}

function ebayVisualSearch(base64, sender) {
  if (!base64 || base64.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(base64)) return Promise.resolve({ error: "invalid-image" });
  return ebayRequests.request({ url: `${EBAY_ORIGIN}/sch/ajax/post/image`, method: "POST", base64, priority: "high" }, sender);
}

// ---------- Amazon product pages ----------
// Shared parsing lives in amazon-report-core.js (also used by the tests).
importScripts("amazon-report-core.js");
const AZ = self.EifAmazonReport;

const listingCache = new Map(); // ASIN -> { at, value }
const listingInFlight = new Map(); // ASIN -> Promise
const LISTING_TTL_MS = 10 * 60 * 1000;
let listingActive = 0;
const listingQueue = [];

function withListingSlot(fn, high, asin) {
  return new Promise((resolve, reject) => {
    const run = () => {
      listingActive++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          listingActive--;
          const next = listingQueue.shift();
          if (next) next();
        });
    };
    if (listingActive < 3) run();
    else if (listingQueue.length >= 300) reject(new Error("busy")); // bounded: a runaway page can't queue forever
    else {
      run.asin = asin || "";
      if (high) listingQueue.unshift(run); // something you're looking at right now goes first (v3.18.5)
      else listingQueue.push(run);
    }
  });
}

async function fetchAmazonListing(asin) {
  if (!(await licensedNow())) return { state: "error", reason: "license", published: { state: "unknown", reason: "license" } };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`https://www.amazon.com/dp/${asin}`, {
      credentials: "include",
      signal: ctrl.signal,
      headers: { "Accept-Language": "en-US,en;q=0.9" },
    });
    if (res.status === 404) return { state: "missing", published: { state: "unknown", reason: "missing" } };
    if (res.status === 503 || res.status === 403) return { state: "blocked", reason: "captcha", published: { state: "unknown", reason: "blocked" } };
    const html = await res.text();
    const parsed = AZ.parseListingHtml(html, res.url);
    if (!res.ok && parsed.state === "ready") parsed.state = "error";
    return parsed;
  } catch (e) {
    return { state: "error", reason: e && e.name === "AbortError" ? "timeout" : "network", published: { state: "unknown", reason: "error" } };
  } finally {
    clearTimeout(timer);
  }
}

async function amazonListing(asin, refresh, high) {
  const a = AZ.normalizeAsin(asin);
  if (!a) return { state: "error", reason: "bad-asin", published: { state: "unknown", reason: "bad-asin" } };
  const cached = listingCache.get(a);
  if (!refresh && cached && Date.now() - cached.at < LISTING_TTL_MS) return cached.value;
  if (listingInFlight.has(a)) {
    // Already waiting in line: move it to the front when you're waiting on it.
    const i = high ? listingQueue.findIndex((r) => r.asin === a) : -1;
    if (i > 0) listingQueue.unshift(...listingQueue.splice(i, 1));
    return listingInFlight.get(a);
  }
  const p = withListingSlot(() => fetchAmazonListing(a), high, a)
    .then((value) => {
      value = { ...value, asin: a, fetchedAt: Date.now(), sourceUrl: `https://www.amazon.com/dp/${a}` };
      if (value.state === "ready" || value.state === "missing") listingCache.set(a, { at: Date.now(), value });
      return value;
    })
    .finally(() => listingInFlight.delete(a));
  listingInFlight.set(a, p);
  return p;
}

// ---------- Amazon keyword search (hijack check) ----------
// One search at a time, at least 3 s apart. Read only. A robot check stops it.
let kwLast = 0;
let kwChain = Promise.resolve();
let kwPending = 0;
function amazonKeywordSearch(query) {
  const q = String(query || "").trim().slice(0, 150);
  if (!q) return Promise.resolve({ error: "empty" });
  if (kwPending >= 20) return Promise.resolve({ error: "busy" });
  const run = async () => {
    if (!(await licensedNow())) return { error: "license" };
    const wait = kwLast + 3000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    kwLast = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(`https://www.amazon.com/s?k=${encodeURIComponent(q)}`, {
        credentials: "include",
        signal: ctrl.signal,
        headers: { "Accept-Language": "en-US,en;q=0.9" },
      });
      if (res.status === 503 || res.status === 403) return { error: "blocked" };
      const parsed = AZ.parseSearchHtml(await res.text());
      if (parsed.state === "blocked") return { error: "blocked" };
      return { ok: true, items: parsed.items };
    } catch (e) {
      return { error: e && e.name === "AbortError" ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  };
  kwPending++;
  const p = kwChain.then(run, run).finally(() => kwPending--);
  kwChain = p.catch(() => {});
  return p;
}

// Kept for the hover panel: just the first-available date.
async function amazonFirstAvailable(asin) {
  const L = await amazonListing(asin, false);
  if (L.state === "error" && L.reason === "bad-asin") return { error: "bad-asin" };
  if (L.state === "error" && (L.reason === "network" || L.reason === "timeout")) return { error: "network" };
  return { ok: true, firstAvailable: L.published && L.published.state === "known" ? L.published.isoDate : "", listing: L };
}

// ---------- Merch on Demand catalog (signed-in account) ----------
importScripts("merch-catalog.js", "connection-core.js", "merch-sync.js", "catalog-db.js", "catalog-migrate.js");
const MC = self.EifMerchCatalog;
const MERCH_CATALOG_KEY = "eifMerchCatalog"; // before v3.24.0 only: moved into the database, then removed
const MERCH_META_KEY = "eifMerchMeta"; // small summary for the popup (no product data)

// ---------- the local catalog database (v3.24.0) ----------
// Both catalogs (Merch and eBay) and the pages of an unfinished sync live in
// one SQLite database (catalog-store.js), owned by db-worker.js inside the
// offscreen page. The first time, the old chrome.storage copies are moved
// over (catalog-migrate.js). Everything here waits for that move.
const CATALOG_STORE_KEY = "eifCatalogStore"; // { state, code, at, sqlite }: for the setup page
const catalogDb = self.EifCatalogDb.createCatalogDb({ chrome });
let catalogMove = null; // { promise, ok, at }

function catalogReady() {
  if (catalogMove && (catalogMove.ok !== false || Date.now() - catalogMove.at < 60000)) return catalogMove.promise;
  const move = { at: Date.now(), ok: null };
  move.promise = (async () => {
    try {
      const engine = await catalogDb.call("status");
      if (engine.state !== "ready") throw Object.assign(new Error(engine.message || engine.code), { code: engine.code || "storage_unavailable" });
      await self.EifCatalogMigrate.createMigrator({ storage: chrome.storage.local, db: catalogDb }).migrate();
      move.ok = true;
      await chrome.storage.local.set({ [CATALOG_STORE_KEY]: { state: "ready", code: "", at: Date.now(), sqlite: engine.version || "" } });
      catalogCleanupSoon();
      return { ok: true };
    } catch (e) {
      move.ok = false;
      move.at = Date.now();
      const code = (e && e.code) || "storage_unavailable";
      try { await chrome.storage.local.set({ [CATALOG_STORE_KEY]: { state: "failed", code, at: Date.now() } }); } catch (e2) {}
      return { ok: false, code };
    }
  })();
  catalogMove = move;
  return move.promise;
}

// Every catalog request: after the move; a failed move is reported as its code.
async function dbCall(op, args, opts) {
  const ready = await catalogReady();
  if (!ready.ok) throw Object.assign(new Error(ready.code), { code: ready.code });
  return catalogDb.call(op, args, opts);
}

// Old generations and leftover pages are deleted a slice at a time.
let catalogCleaning = null;
function catalogCleanupSoon() {
  if (catalogCleaning) return;
  catalogCleaning = (async () => {
    for (let i = 0; i < 400; i++) {
      const r = await catalogDb.call("cleanup", { budget: 50000 }, { timeoutMs: 120000 });
      if (!r || !r.more) break;
      await new Promise((res) => setTimeout(res, 200));
    }
  })()
    .catch(() => {})
    .finally(() => { catalogCleaning = null; });
}

// The person chose "Rebuild the catalog" (database unreadable or from a newer
// version). Clears it, then moves anything still in chrome.storage in again.
async function catalogRebuild() {
  if (merchEngine.isRunning() || ebayEngine.isRunning()) return { ok: false, error: "syncing" };
  try {
    await catalogDb.call("rebuild");
  } catch (e) {
    return { ok: false, error: (e && e.code) || "storage_unavailable" };
  }
  catalogMove = null;
  catalogMetaCache.merch = null;
  catalogMetaCache.ebay = null;
  const ready = await catalogReady();
  return { ok: !!ready.ok, error: ready.code || "" };
}

// The sync engine's pages, for one catalog ("merch" or "ebay").
function catalogPages(kind) {
  return {
    savePage: (cursor, page, rows) => dbCall("savePage", { kind, cursor, page, rows }),
    getCursor: async () => (await dbCall("getCursor", { kind })).cursor,
    clear: (runId) => dbCall("clearRun", { kind, runId }),
    // Building a big catalog takes a while; the engine keeps the worker awake.
    finalize: (run, info) => dbCall("finalize", { kind, run: { runId: run.runId, pagesDone: run.pagesDone, accountId: run.accountId, customerId: run.customerId || "" }, info }, { timeoutMs: 15 * 60 * 1000 }),
  };
}

// The live catalog's summary (no listings), cached until the next publish.
const catalogMetaCache = { merch: null, ebay: null };
async function catalogMeta(kind) {
  const c = catalogMetaCache[kind];
  if (c && Date.now() - c.at < 60000) return c.value;
  const value = (await dbCall("active", { kind })).catalog;
  catalogMetaCache[kind] = { at: Date.now(), value };
  return value;
}

let merchIdentity = null; // { state, accountId, customerId, at }
let merchSessionRevision = 0; // bumps when the signed-in account changes
let merchSyncing = null;

async function merchSetMeta(patch) {
  const cur = (await chrome.storage.local.get({ [MERCH_META_KEY]: {} }))[MERCH_META_KEY] || {};
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [MERCH_META_KEY]: next });
  return next;
}

const MERCH_STALE_GRACE_MS = 24 * 60 * 60 * 1000; // a verified identity survives a rate limit this long
let merchIdentityInFlight = null;

function merchInvalidate(reason) {
  if (merchIdentity && merchIdentity.state === "verified") merchSessionRevision++;
  merchIdentity = { state: "unverified", reason, at: Date.now() };
}

// Live check of who is signed in to Merch, through the browser's own session.
// A response that arrives after the session changed is thrown away. A
// temporary failure (rate limit, network) keeps a recent verified identity as
// "stale"; a sign-out never does.
async function merchGetIdentity(force) {
  if (!force && merchIdentity && merchIdentity.state === "verified" && Date.now() - merchIdentity.at < MC.IDENTITY_FRESH_MS) return merchIdentity;
  if (!force && merchIdentity && merchIdentity.state === "stale" && Date.now() - merchIdentity.at < 60 * 1000) return { ...merchIdentity, state: "verified", stale: true };
  if (merchIdentityInFlight) return merchIdentityInFlight;
  merchIdentityInFlight = (async () => {
    const revAtStart = merchSessionRevision;
    let parsed;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(MC.DASHBOARD_URL, { credentials: "include", signal: ctrl.signal });
      parsed = MC.parseIdentity({ status: res.status, url: res.url, redirected: res.redirected, html: res.ok ? await res.text() : "" });
    } catch (e) {
      parsed = { state: "error", reason: e && e.name === "AbortError" ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
    if (merchSessionRevision !== revAtStart) return { state: "unverified", reason: "session_changed" };
    const prev = merchIdentity;
    if (parsed.state === "verified") {
      if (prev && prev.accountId && !MC.sameAccount(prev, parsed)) merchSessionRevision++; // account switched
      merchIdentity = { ...parsed, at: Date.now(), verifiedAt: Date.now() };
      return merchIdentity;
    }
    if (parsed.state === "logged_out") {
      if (prev && prev.state !== "logged_out") merchSessionRevision++;
      merchIdentity = { ...parsed, at: Date.now() };
      return merchIdentity;
    }
    // rate_limited / error: keep a recent verified identity, marked stale
    if (prev && prev.accountId && (prev.state === "verified" || prev.state === "stale") && Date.now() - (prev.verifiedAt || 0) < MERCH_STALE_GRACE_MS) {
      merchIdentity = { ...prev, state: "stale", at: Date.now(), lastFailure: parsed.state === "rate_limited" ? "rate_limited" : parsed.reason || parsed.state };
      return { ...merchIdentity, state: "verified", stale: true };
    }
    merchIdentity = { ...parsed, at: Date.now() };
    return merchIdentity;
  })().finally(() => {
    merchIdentityInFlight = null;
  });
  return merchIdentityInFlight;
}

// Signing out of Amazon removes its session cookies: forget the identity at
// once instead of waiting for the next check.
try {
  chrome.cookies &&
    chrome.cookies.onChanged &&
    chrome.cookies.onChanged.addListener((info) => {
      const c = info && info.cookie;
      if (!c || info.removed !== true || String(info.cause || "").toLowerCase() === "overwrite") return;
      const domain = String(c.domain || "").replace(/^\./, "").toLowerCase();
      if (!(domain === "amazon.com" || domain.endsWith(".amazon.com"))) return;
      const name = String(c.name || "").toLowerCase();
      if (name === "session-id" || name === "session-token" || /^(at-|sess-at-|x-)/.test(name)) merchInvalidate(`cookie:${name}`);
    });
} catch (e) {}

// v3.24.0: the summary of the live catalog from the database ({ revision,
// catalog: { accountId, customerId, syncedAt, count, ... } }), never the list.
// null when there is none or the database can't be reached.
async function merchLoadCatalog() {
  let meta = null;
  try {
    meta = await catalogMeta("merch");
  } catch (e) {
    return null;
  }
  if (!meta || !meta.accountId) return null;
  return { revision: meta.revision, catalog: meta };
}

// ---------- resumable catalog download (v3.16.0, merch-sync.js) ----------
// Every sync (first setup, the automatic daily refresh, "Sync again") goes
// through one run that saves each page as it arrives. A closed setup tab, a
// restarted worker or browser continues from the saved page. The last
// complete catalog stays in use until the new one is validated.
const MS = self.EifMerchSync;
const SETUP_KEY = "eifSetup";
// { state: "pending" | "complete", merch: "done" | "skipped" | null,
//   ebay: "signed_in" | "skipped" | null, completedAt, account (masked), version }
//   ebayMode: "seller" | "account" | "none" | null (v3.18.4)
// v3.18.4: Merch is required (the tool is for Merch sellers). eBay is asked
// first: "I sell on eBay" (sign in + Seller Hub sync), "I have an account but
// don't sell" (sign in only, for reporting), or "No eBay account" (skipped).
// Nothing on eBay is checked before that answer. Setup is complete once Merch
// is synced and eBay is answered (signed in, or no account).
let setupLock = Promise.resolve();
function setupResolved(s) {
  return s.merch === "done" && (s.ebay === "signed_in" || s.ebay === "skipped");
}
function setupPatch(patch) {
  const run = setupLock.then(async () => {
    const d = await chrome.storage.local.get({ [SETUP_KEY]: null });
    const cur = d[SETUP_KEY] && typeof d[SETUP_KEY] === "object" ? d[SETUP_KEY] : { state: "pending" };
    const next = { ...cur, ...patch };
    // Older ledgers (v3.16.0) said "complete" once the catalog was saved.
    if (cur.state === "complete" && cur.merch === undefined && !("merch" in patch)) next.merch = "done";
    const wasComplete = cur.state === "complete";
    // Once complete it stays complete (daily syncs patch "merch" too).
    next.state = wasComplete || setupResolved(next) ? "complete" : "pending";
    if (next.state === "complete" && !wasComplete) {
      next.completedAt = Date.now();
      next.version = chrome.runtime.getManifest ? chrome.runtime.getManifest().version : "";
    }
    await chrome.storage.local.set({ [SETUP_KEY]: next });
    return next;
  });
  setupLock = run.catch(() => {});
  return run;
}
const MERCH_RESUME_ALARM = "eif-merch-resume";

function merchKeepAlive() {
  // A trivial extension call every 25 s keeps the worker from being stopped
  // during service-requested waits (429 Retry-After). Only while a run is active.
  const id = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) {} }, 25 * 1000);
  return () => clearInterval(id);
}

async function merchPublishRun(pub) {
  const st = pub.state;
  const progress = { runState: st, pagesDone: pub.pagesDone || 0, rawScanned: pub.rawScanned || 0, usable: pub.usable || 0, expectedTotal: pub.expectedTotal == null ? null : pub.expectedTotal, lastPageAt: pub.lastPageAt || 0, waitUntil: pub.waitUntil || 0 };
  if (st === "syncing" || st === "finalizing") await merchSetMeta({ state: "syncing", account: pub.account || "", startedAt: pub.startedAt || Date.now(), lastError: pub.error && pub.error !== "user_paused" ? pub.error : "", ...progress });
  else if (st === "complete") await merchSetMeta({ ...progress, runState: "complete" });
  else await merchSetMeta({ state: "failed", lastError: pub.error || st, ...progress });
  // Wake up again after a worker restart or a retry delay.
  if (chrome.alarms) {
    const wake = st === "syncing" || st === "finalizing" || (st === "paused" && pub.resumeAt && pub.error !== "user_paused");
    try {
      if (wake) chrome.alarms.create(MERCH_RESUME_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
      else chrome.alarms.clear(MERCH_RESUME_ALARM);
    } catch (e) {}
  }
}

const merchEngine = MS.createEngine({
  MC,
  storage: {
    get: (defs) => chrome.storage.local.get(defs),
    set: (obj) => chrome.storage.local.set(obj),
  },
  pages: catalogPages("merch"),
  fetch: (u, o) => fetch(u, o),
  identity: (force) => merchGetIdentity(force),
  revision: () => merchSessionRevision,
  keepAlive: merchKeepAlive,
  // The new catalog is live (switched inside the database).
  onPublished: async (catalog) => {
    catalogMetaCache.merch = null;
    await merchSetMeta({ state: "ready", account: MC.maskId(catalog.accountId), count: catalog.count, hitCount: catalog.hitCount, rawScanned: catalog.rawScanned, syncedAt: catalog.syncedAt, revision: catalog.revision, lastError: "" });
    catalogCleanupSoon();
  },
  onPublish: (pub) => merchPublishRun(pub),
  onComplete: async (run) => {
    await setupPatch({ merch: "done", account: MC.maskId(run.accountId) });
  },
});

// Same contract as before: { ok, count } or { ok: false, reason }.
async function merchSync(opts = {}) {
  const r = await merchEngine.start({ kind: opts.kind || "sync", auto: !!opts.auto, restart: !!opts.restart });
  return r && r.ok ? { ok: true, count: r.count } : { ok: false, reason: (r && r.reason) || "failed" };
}

function merchBegin(startFn, engine) {
  const eng = engine || merchEngine;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    startFn((pub) => finish(pub))
      .then(async (r) => finish((r && r.run) || (await eng.status())))
      .catch(async () => finish(await eng.status()));
  });
}

// A run the worker was doing when it stopped: pick it up again.
async function merchResumeIfInterrupted() {
  try {
    if (merchEngine.isRunning()) return;
    const run = await merchEngine.getRun();
    if (!run || !["syncing", "finalizing", "paused"].includes(run.state)) return;
    await licenseReady;
    const lic = await licenseService.authorize();
    if (!lic.ok) return; // no downloads without a valid license
    merchEngine.resume({ auto: true }).catch(() => {});
  } catch (e) {}
}

// ---------- your eBay listings (Seller Hub sync, v3.17.0) ----------
// Same resumable engine as Merch (merch-sync.js), its own keys. Pages come
// through the shared eBay request queue as "quiet" requests: a sign-in page
// or a block is the sync's own problem and doesn't pause the rest of eBay.
importScripts("ebay-catalog.js");
const EC = self.EifEbayCatalog;
// Before v3.24.0: eifEbayCatalog (all listings) and eifEbayOwnIds (all item
// numbers, read by every eBay page). Both are moved into the database and
// removed; pages now ask "which of these item numbers are mine?" (ebayOwnLookup).
const EBAY_META_KEY = "eifEbayMeta";
const EBAY_RESUME_ALARM = "eif-ebay-resume";
const EBAY_DAILY_ALARM = "eif-ebay-daily";
let ebayIdentityCache = null; // { at, value }
let ebayFirstPage = null; // { at, url, result }: the identity read doubles as page 1

function ebaySyncFetch(url) {
  // The identity check just read page 1: use it instead of asking again.
  if (ebayFirstPage && ebayFirstPage.url === url && Date.now() - ebayFirstPage.at < 60000) {
    const r = ebayFirstPage.result;
    ebayFirstPage = null;
    return Promise.resolve(r);
  }
  return ebayRequests.request({ url, method: "GET", refresh: true, quiet: true, nocache: true }, null);
}

// v3.27.0: Seller Hub read from the worker only says "redirected" (signed out,
// or a check). With no eBay tab open that stopped the sync as "needs_ebay_tab"
// and nothing else happened. Now an eBay tab is opened in the background (at
// most once a minute) and the read is asked again there, where a sign-out is
// recognised.
let ebayIdentityTabAt = 0;
async function ebayGetIdentity(force) {
  if (!force && ebayIdentityCache && Date.now() - ebayIdentityCache.at < 10 * 60 * 1000) return ebayIdentityCache.value;
  const url = EC.pageUrl(0);
  let r = await ebayRequests.request({ url, method: "GET", refresh: true, quiet: true, nocache: true }, null);
  if (r && r.error === "needs-ebay-tab" && Date.now() - ebayIdentityTabAt > 60000) {
    ebayIdentityTabAt = Date.now();
    const t = await openEbayTabForPage(null).catch(() => null);
    if (t && t.ok) r = await ebayRequests.request({ url, method: "GET", refresh: true, quiet: true, nocache: true }, null);
  }
  let value;
  if (!r || r.error) {
    value = r && r.error === "ebay-paused" && r.reason === "signin" ? { state: "logged_out" } : { state: "error", reason: r && r.error === "needs-ebay-tab" ? "needs_ebay_tab" : (r && r.error) || "network" };
  } else if (EC.isSignInUrl(r.url) || r.status === 401) {
    value = { state: "logged_out" };
  } else {
    const page = EC.parsePage(r.text, r.url);
    if (page.state === "signed_out") value = { state: "logged_out" };
    else if (page.state === "ok" && page.userId) {
      value = { state: "verified", accountId: page.userId, total: page.pagination.totalRecords };
      ebayFirstPage = { at: Date.now(), url, result: r };
    } else value = { state: "error", reason: "not_seller_hub" };
  }
  ebayIdentityCache = { at: Date.now(), value };
  return value;
}

async function ebaySetMeta(patch) {
  const d = await chrome.storage.local.get({ [EBAY_META_KEY]: {} });
  const meta = { ...(d[EBAY_META_KEY] || {}), ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [EBAY_META_KEY]: meta });
  return meta;
}

async function ebayPublishRun(pub) {
  const st = pub.state;
  const progress = { runState: st, pagesDone: pub.pagesDone || 0, rawScanned: pub.rawScanned || 0, usable: pub.usable || 0, expectedTotal: pub.expectedTotal == null ? null : pub.expectedTotal, lastPageAt: pub.lastPageAt || 0 };
  if (st === "syncing" || st === "finalizing") await ebaySetMeta({ state: "syncing", lastError: "", ...progress });
  else if (st === "complete") await ebaySetMeta({ ...progress });
  else await ebaySetMeta({ state: "failed", lastError: pub.error || st, ...progress });
  if (chrome.alarms) {
    const wake = st === "syncing" || st === "finalizing" || (st === "paused" && pub.resumeAt && pub.error !== "user_paused");
    try {
      if (wake) chrome.alarms.create(EBAY_RESUME_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
      else chrome.alarms.clear(EBAY_RESUME_ALARM);
    } catch (e) {}
  }
}

const ebayEngine = MS.createEngine({
  MC: EC,
  runKey: "eifEbayRun",
  stagePrefix: "eifEbayStage:",
  pauseMs: 0, // the eBay queue already keeps 2 s between requests
  // v3.24.0: 2,200,000 listings at 200 per Seller Hub page (measured at 2M).
  limits: { maxPages: 11000 },
  storage: {
    get: (defs) => chrome.storage.local.get(defs),
    set: (obj) => chrome.storage.local.set(obj),
  },
  pages: catalogPages("ebay"),
  fetch: (url) => ebaySyncFetch(url),
  identity: (force) => ebayGetIdentity(force),
  keepAlive: merchKeepAlive,
  onPublished: async (catalog) => {
    catalogMetaCache.ebay = null;
    // revision: pages drop their cached "is this mine?" answers when it changes.
    await ebaySetMeta({ state: "ready", account: EC.maskId(catalog.accountId), count: catalog.count, syncedAt: catalog.syncedAt, revision: catalog.revision, lastError: "" });
    catalogCleanupSoon();
  },
  onPublish: (pub) => ebayPublishRun(pub),
  onComplete: async () => {
    const d = await chrome.storage.local.get({ [SETUP_KEY]: null });
    if (!setupView(d[SETUP_KEY]).ebay) await setupPatch({ ebay: "signed_in" });
  },
});

async function ebayResumeIfInterrupted() {
  try {
    if (ebayEngine.isRunning()) return;
    const run = await ebayEngine.getRun();
    if (!run || !["syncing", "finalizing", "paused"].includes(run.state)) return;
    const d = await chrome.storage.local.get({ [SETUP_KEY]: null });
    if (setupView(d[SETUP_KEY]).ebayMode !== "seller") return; // v3.18.8
    await licenseReady;
    const lic = await licenseService.authorize();
    if (!lic.ok) return;
    ebayEngine.resume({ auto: true }).catch(() => {});
  } catch (e) {}
}

// Once a day: re-read your listings if eBay is connected and the list is
// older than 23 h. Never over a pause you made, never when eBay was skipped.
async function ebayDailySync() {
  try {
    if (ebayEngine.isRunning()) return;
    const d = await chrome.storage.local.get({ [SETUP_KEY]: null });
    const setup = setupView(d[SETUP_KEY]);
    if (setup.ebay === "skipped" || setup.ebayMode !== "seller") return;
    const c = await catalogMeta("ebay");
    if (!c) return;
    if (Date.now() - (c.syncedAt || 0) < 23 * 3600 * 1000) return;
    await licenseReady;
    if (!(await licenseService.authorize()).ok) return;
    ebayEngine.start({ kind: "sync", auto: true }).catch(() => {});
  } catch (e) {}
}

async function ebayCatalogStatus() {
  const d = await chrome.storage.local.get({ [EBAY_META_KEY]: {}, [SETUP_KEY]: null, [CATALOG_STORE_KEY]: null });
  let c = null;
  try { c = await catalogMeta("ebay"); } catch (e) {}
  return { ok: true, ebayMode: setupView(d[SETUP_KEY]).ebayMode, run: await ebayEngine.status(), meta: d[EBAY_META_KEY] || {}, storage: catalogStorageView(d[CATALOG_STORE_KEY]), catalog: c ? { account: EC.maskId(c.accountId), count: c.count, syncedAt: c.syncedAt, revision: c.revision } : null };
}

// Which of these item numbers are your synced eBay listings (v3.24.0). The
// pages ask for the ones they show instead of keeping the whole list.
async function ebayOwnLookup(items) {
  const list = [...new Set((Array.isArray(items) ? items : []).map((x) => String(x || "")).filter((x) => /^\d{9,15}$/.test(x)))].slice(0, 500);
  try {
    const r = await dbCall("ebayOwn", { items: list });
    return { ok: true, own: r.own, revision: r.catalog ? r.catalog.revision : "", synced: !!r.catalog };
  } catch (e) {
    return { ok: false, error: (e && e.code) || "storage_unavailable", own: [] };
  }
}

// What the setup page and the menus may show about the database.
function catalogStorageView(v) {
  if (!v) return { state: "unchecked", code: "" };
  return { state: v.state === "ready" ? "ready" : "failed", code: v.code || "" };
}

// items: [{ asin, marketplace }] → { "US|ASIN": result }. Every item gets its
// own answer; one unknown never changes another item's result.
async function merchLookup(items, fresh) {
  const list = (Array.isArray(items) ? items : []).slice(0, 500);
  const out = {};
  const keyOf = (it) => `${MC.normalizeMarketplace(it.marketplace) || "?"}|${String(it.asin || "").toUpperCase()}`;
  const fail = (reason) => {
    list.forEach((it) => (out[keyOf(it)] = { state: "unknown", reason }));
    return { ok: true, connected: reason !== "not_synced", results: out };
  };
  let meta;
  try {
    meta = await catalogMeta("merch");
  } catch (e) {
    // The database can't be read: say so, item by item, never "not yours".
    const reason = (e && e.code) || "storage_unavailable";
    list.forEach((it) => (out[keyOf(it)] = { state: "unknown", reason }));
    return { ok: true, connected: true, storage: reason, results: out };
  }
  if (!meta || !meta.accountId) return fail("not_synced");
  const identity = await merchGetIdentity(!!fresh);
  if (identity.state !== "verified") return fail(identity.state === "logged_out" ? "signed_out" : identity.reason || identity.state);
  if (!MC.sameAccount(meta, identity)) return fail("other_account");
  let res;
  try {
    res = await dbCall("merchLookup", { items: list.map((it) => ({ asin: String(it.asin || ""), marketplace: String(it.marketplace || ""), pageAsins: merchPageAsins(it) })) });
  } catch (e) {
    const reason = (e && e.code) || "storage_unavailable";
    list.forEach((it) => (out[keyOf(it)] = { state: "unknown", reason }));
    return { ok: true, connected: true, storage: reason, results: out };
  }
  // A catalog published between the two calls: answer from the one that was read.
  const used = res.catalog || meta;
  if (!MC.sameAccount(used, identity)) return fail("other_account");
  list.forEach((it, i) => (out[keyOf(it)] = res.results[i] || { state: "unknown", reason: "no_answer" }));
  return { ok: true, connected: true, stale: !!identity.stale, account: MC.maskId(identity.accountId), syncedAt: used.syncedAt, revision: used.revision, results: out };
}

// Parent/variation ASINs read from the public product page, when we already
// have that page (sent by the popup or in our own cache). Never fetched here.
function merchPageAsins(it) {
  const fromItem = Array.isArray(it.pageAsins) ? it.pageAsins : [];
  const cached = listingCache.get(String(it.asin || "").toUpperCase());
  const fromCache = cached && cached.value && Array.isArray(cached.value.pageAsins) ? cached.value.pageAsins : [];
  return [...fromItem, ...fromCache].slice(0, 6);
}

async function merchStatus() {
  const meta = (await chrome.storage.local.get({ [MERCH_META_KEY]: {} }))[MERCH_META_KEY] || {};
  const identity = await merchGetIdentity(false);
  const loaded = await merchLoadCatalog();
  return {
    ok: true,
    identity: { state: identity.state, stale: !!identity.stale, account: identity.accountId ? MC.maskId(identity.accountId) : "", reason: identity.reason || "" },
    catalog: loaded ? { account: MC.maskId(loaded.catalog.accountId), count: loaded.catalog.count, syncedAt: loaded.catalog.syncedAt, sameAccount: identity.state === "verified" && MC.sameAccount(loaded.catalog, identity) } : null,
    storage: catalogStorageView((await chrome.storage.local.get({ [CATALOG_STORE_KEY]: null }))[CATALOG_STORE_KEY]),
    meta,
    run: await merchEngine.status(),
  };
}

const merchCoordinator = self.EifConnection.createMerchCoordinator({
  identity: merchGetIdentity, catalog: merchLoadCatalog, sameAccount: MC.sameAccount,
  sync: (manual) => merchSync({ auto: !manual }), status: merchStatus,
  failure: async () => (await chrome.storage.local.get("eifMerchAutoFailure")).eifMerchAutoFailure,
  saveFailure: (value) => chrome.storage.local.set({ eifMerchAutoFailure: value }),
});

async function ebayRecover(input, sender) {
  const state = await ebayRequests.status();
  if (!state.paused) return { ok: true, ...state };
  const probe = input || (state.recoveryUrl ? { url: state.recoveryUrl, method: "GET" } : null);
  if (!probe || !isEbayUrl(probe.url)) return { ok: false, error: "recovery-needed", ...state };
  const url = new URL(probe.url);
  if (url.username || url.password) return { ok: false, error: "not-allowed" };
  if (probe.method === "POST") {
    if (url.href !== `${EBAY_ORIGIN}/sch/ajax/post/image` || !probe.base64 || probe.base64.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(probe.base64)) return { ok: false, error: "not-allowed" };
  } else if (![undefined, "GET", "HEAD"].includes(probe.method)) return { ok: false, error: "not-allowed" };
  return ebayRequests.resume(probe, sender);
}

// The customer pressed "Open eBay in a tab" on an Amazon hunt: open
// www.ebay.com next to their tab (not focused) and wait until it has loaded.
// v3.20.3: one at a time. Two requests from the same hunt (or two pages)
// asking together opened two eBay tabs; a tab that is still loading counts too.
let ebayTabOpening = null;
function openEbayTabForPage(sender) {
  if (!ebayTabOpening) ebayTabOpening = openEbayTabForPageOnce(sender).finally(() => { ebayTabOpening = null; });
  return ebayTabOpening;
}
function waitTabLoaded(tabId, ms) {
  return new Promise((resolve) => {
    const done = (v) => { chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(timer); resolve(v); };
    const onUpd = (id, info) => { if (id === tabId && info.status === "complete") done(true); };
    const timer = setTimeout(() => done(true), ms);
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}
async function openEbayTabForPageOnce(sender) {
  const existing = await openEbayTabId();
  if (existing != null) return { ok: true, tabId: existing };
  try {
    const loading = (await chrome.tabs.query({ url: "https://www.ebay.com/*" })).find((t) => t.id != null && !t.discarded && t.status !== "complete" && !isEbayCheckUrl(t.url || t.pendingUrl || ""));
    if (loading) { await waitTabLoaded(loading.id, 10000); return { ok: true, tabId: loading.id }; }
  } catch (e) { /* fall through and open one */ }
  const tab = await chrome.tabs.create({ url: `${EBAY_ORIGIN}/`, active: false, ...(sender?.tab?.index != null ? { index: sender.tab.index + 1 } : {}), ...(sender?.tab?.windowId != null ? { windowId: sender.tab.windowId } : {}) });
  const loaded = await new Promise((resolve) => {
    const done = (v) => { chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(timer); resolve(v); };
    const onUpd = (id, info) => { if (id === tab.id && info.status === "complete") done(true); };
    // eBay's homepage is heavy; after 10 s try anyway (the page can usually run the request by then).
    const timer = setTimeout(() => done(true), 10000);
    chrome.tabs.onUpdated.addListener(onUpd);
  });
  return loaded ? { ok: true, tabId: tab.id } : { ok: false, error: "timeout" };
}

async function ebaySession(sender) {
  const result = await ebayRequests.request({ url: `${EBAY_ORIGIN}/`, method: "GET", refresh: true }, sender);
  if (!result.ok) return { ok: false, session: "unknown", reason: result.reason || result.error };
  const html = result.text || "";
  const greeting = html.match(/class=["'][^"']*gh-identity__greeting[^"']*["'][^>]*>([\s\S]{0,500}?)<\/span>\s*<\/span>/i);
  const name = greeting ? greeting[1].replace(/<[^>]+>/g, "").replace(/^\s*Hi\s*/i, "").replace(/!\s*$/, "").trim() : "";
  const signedIn = (name && !/sign\s*in|guest/i.test(name)) || /href=["'][^"']*(?:SignOut|\/signout)(?:[?&#/"']|$)/i.test(html);
  const signedOut = /href=["'][^"']*signin\.ebay[^"']*["'][^>]*>\s*Sign in\s*</i.test(html);
  // Only a positive answer is trusted: eBay's raw homepage always has a "Sign
  // in" link and an empty greeting (filled in by script), so "signed out" can't
  // be read from it. The content script reads the live header instead.
  void signedOut;
  if (signedIn) await ebayClearSignedOut();
  return { ok: true, session: signedIn ? "signed_in" : "unknown" };
}

// ---------- Amazon report jobs ----------
// One job = one frozen, validated report for one marketplace, bound to the tab
// it was opened in, with an expiry. The form filler in that tab must hold the
// current lease to change it. Contact details are dropped once the job ends.
const JOBS_KEY = "eifAmazonJobs";
const JOB_TTL_MS = 30 * 60 * 1000;
const KEEP_AFTER_MS = 2 * 60 * 60 * 1000;
const LEASE_MS = 2 * 60 * 1000;
const TERMINAL = new Set(["cancelled", "expired", "submitted_by_user"]);
let jobsLock = Promise.resolve();
// Jobs hold contact details and lease tokens, so they live in session
// storage, which content scripts can't read. Pages get a change counter only.
const JOBS_AREA = chrome.storage.session || chrome.storage.local;
let jobsRev = 0;
if (chrome.storage.session) chrome.storage.local.remove(JOBS_KEY).catch(() => {});

function withJobs(mutator) {
  const run = jobsLock.then(async () => {
    const data = await JOBS_AREA.get({ [JOBS_KEY]: {} });
    const jobs = data[JOBS_KEY] && typeof data[JOBS_KEY] === "object" ? data[JOBS_KEY] : {};
    const before = JSON.stringify(jobs);
    const now = Date.now();
    for (const [id, job] of Object.entries(jobs)) {
      if (!TERMINAL.has(job.status) && job.status !== "review_ready" && now > job.expiresAt) {
        job.status = "expired";
        job.reporter = null;
      }
      if (now > job.expiresAt + KEEP_AFTER_MS) delete jobs[id];
      else if (TERMINAL.has(job.status)) job.reporter = null;
    }
    const result = await mutator(jobs, now);
    if (JSON.stringify(jobs) !== before) {
      await JOBS_AREA.set({ [JOBS_KEY]: jobs });
      if (JOBS_AREA !== chrome.storage.local) chrome.storage.local.set({ eifAmazonJobsRev: { rev: ++jobsRev, at: now } }).catch(() => {});
    }
    return result;
  });
  jobsLock = run.catch(() => {});
  return run;
}

function randomId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function publicJob(job) {
  if (!job) return null;
  const { reporter, runner, ...rest } = job; // never hand contact details or lease tokens to other pages
  return rest;
}

function isReportTab(sender) {
  try {
    const u = new URL(sender.tab.url || sender.url || "");
    return u.protocol === "https:" && u.hostname === "www.amazon.com" && /^\/report\/infringement\/?$/.test(u.pathname);
  } catch (e) {
    return false;
  }
}

// One Start click = one request id. If the popup didn't get the answer (worker
// was asleep, reply lost) and asks again with the same id, it gets the same
// job back instead of a second Amazon tab.
const jobOpenInFlight = new Map(); // requestId -> Promise
function openAmazonJobOnce(input) {
  const rid = /^[a-f0-9]{16,64}$/.test(String((input && input.requestId) || "")) ? input.requestId : "";
  if (!rid) return openAmazonJob(input);
  if (jobOpenInFlight.has(rid)) return jobOpenInFlight.get(rid);
  const p = (async () => {
    const existing = await withJobs((jobs) => Object.values(jobs).find((j) => j.requestId === rid) || null);
    if (existing) {
      if (existing.runner && existing.runner.tabId >= 0) chrome.tabs.update(existing.runner.tabId, { active: true }).catch(() => {});
      return { ok: true, jobId: existing.id, reused: true };
    }
    return openAmazonJob(input);
  })().finally(() => jobOpenInFlight.delete(rid)); // later repeats find the saved job by requestId
  jobOpenInFlight.set(rid, p);
  return p;
}

// Only https images from Amazon's image hosts, one per target ASIN.
function cleanTargetImages(raw, targets) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const a of targets) {
    const v = raw[a];
    if (typeof v !== "string" || v.length > 1000) continue;
    try {
      const u = new URL(v);
      if (u.protocol === "https:" && /(^|\.)(media-amazon\.com|ssl-images-amazon\.com)$/.test(u.hostname)) out[a] = u.href;
    } catch (e) {}
  }
  return out;
}

async function openAmazonJob(input) {
  const marketplace = AZ.normalizeMarketplace(input && input.marketplace);
  const targets = (input && Array.isArray(input.targets) ? input.targets : []).map(AZ.normalizeAsin).filter(Boolean);
  const original = AZ.normalizeAsin(input && input.original);
  if (!marketplace || !targets.length || targets.length > AZ.TARGET_LIMIT || !original || targets.includes(original)) return { error: "invalid-job" };
  if (!AZ.ISSUES[input.issue] || !String(input.description || "").trim() || AZ.validateReporter(input.reporter).length) return { error: "invalid-job" };
  // Ownership, checked again here (the popup's answer is only a hint):
  // - a target that's in the signed-in Merch catalog is never reported;
  // - the original must be catalog-matched now, or marked "This is mine".
  const basis = input.ownershipBasis === "catalog_matched" ? "catalog_matched" : "self_declared";
  const check = await merchLookup([original, ...targets].map((asin) => ({ asin, marketplace })), true);
  const res = (a) => (check.results || {})[`${marketplace}|${a}`] || { state: "unknown" };
  // Reported in the last 5 days and still waiting on Amazon: never twice.
  const history = (await chrome.storage.local.get({ eifReportHistory: [] })).eifReportHistory;
  const locks = AZ.reportLocks(history);
  const recent = targets.filter((a) => locks.has(a));
  if (recent.length) return { error: "target-recently-reported", asins: recent };
  const ownTargets = targets.filter((a) => res(a).state === "catalog_matched");
  if (ownTargets.length) return { error: "target-in-catalog", asins: ownTargets };
  if (basis === "catalog_matched" && res(original).state === "unknown") return { error: "catalog-unavailable", reason: res(original).reason || "" };
  if (basis === "catalog_matched" && res(original).state !== "catalog_matched") return { error: "ownership-changed" };
  if (basis === "self_declared") {
    const mine = (await chrome.storage.local.get({ eifAmazonMine: [] })).eifAmazonMine || [];
    if (!mine.includes(original)) return { error: "ownership-changed" };
  }
  const id = randomId();
  const host = AZ.MARKETPLACES[marketplace].host;
  const tab = await chrome.tabs.create({ url: `https://${host}/report/infringement#eif-job=${id}`, active: true });
  await withJobs((jobs, now) => {
    jobs[id] = {
      id,
      requestId: /^[a-f0-9]{16,64}$/.test(String(input.requestId || "")) ? input.requestId : "",
      revision: 1,
      marketplace,
      name: String(input.name || "").slice(0, 80),
      original,
      originalDate: AZ.isValidIso(input.originalDate) ? input.originalDate : "",
      targets: [...new Set(targets)],
      targetImages: cleanTargetImages(input.targetImages, targets),
      issue: input.issue,
      ownershipBasis: basis,
      brand: String(input.brand || "").slice(0, 120),
      description: String(input.description).slice(0, AZ.DESCRIPTION_MAX),
      reporter: input.reporter,
      status: "prepared",
      createdAt: now,
      expiresAt: now + JOB_TTL_MS,
      runner: { tabId: tab.id, leaseToken: "", leaseExpiresAt: 0 },
      completedSteps: [],
      failedStep: "",
      reason: "",
      notes: [],
    };
  });
  return { ok: true, jobId: id };
}

async function claimAmazonJob(jobId, sender) {
  if (!isReportTab(sender)) return { error: "wrong-page" };
  return withJobs((jobs, now) => {
    const job = jobs[jobId];
    if (!job) return { error: "missing" };
    if (job.status === "expired" || now > job.expiresAt) return { error: "expired" };
    if (TERMINAL.has(job.status)) return { error: job.status };
    if (!job.runner || job.runner.tabId !== sender.tab.id) return { error: "other-tab" };
    if (job.runner.leaseToken && job.runner.leaseExpiresAt > now && job.status === "filling") return { error: "busy" };
    job.runner.leaseToken = randomId();
    job.runner.leaseExpiresAt = now + LEASE_MS;
    job.status = "filling";
    job.revision++;
    return { ok: true, job: { ...job, runner: undefined }, leaseToken: job.runner.leaseToken };
  });
}

const RUNNER_STATUSES = new Set(["filling", "review_ready", "blocked", "failed"]);

async function updateAmazonJob(msg, sender) {
  if (!isReportTab(sender)) return { error: "wrong-page" };
  return withJobs((jobs, now) => {
    const job = jobs[msg.jobId];
    if (!job) return { error: "missing" };
    if (TERMINAL.has(job.status) || job.status === "expired") return { error: job.status };
    if (!job.runner || job.runner.tabId !== sender.tab.id || !job.runner.leaseToken || job.runner.leaseToken !== msg.leaseToken) return { error: "not-owner" };
    const patch = msg.patch || {};
    if (patch.status && RUNNER_STATUSES.has(patch.status)) job.status = patch.status;
    if (Array.isArray(patch.completedSteps)) job.completedSteps = patch.completedSteps.slice(0, 50).map(String);
    if (typeof patch.failedStep === "string") job.failedStep = patch.failedStep.slice(0, 60);
    if (typeof patch.reason === "string") job.reason = patch.reason.slice(0, 400);
    if (Array.isArray(patch.notes)) job.notes = patch.notes.slice(0, 20).map((n) => String(n).slice(0, 200));
    job.runner.leaseExpiresAt = now + LEASE_MS;
    if (job.status !== "filling") job.runner.leaseToken = "";
    job.revision++;
    return { ok: true, revision: job.revision };
  });
}

// Cancel, or record that the user submitted it on Amazon. Allowed from the
// report tab the job is bound to, or from our panel on an eBay/Amazon page
// (which lists the open reports). Works without a license on purpose.
async function finishAmazonJob(jobId, how, sender, ctx) {
  return withJobs((jobs) => {
    const job = jobs[jobId];
    if (!job) return { error: "missing" };
    if (ctx === "report" && (!job.runner || !sender || !sender.tab || job.runner.tabId !== sender.tab.id)) return { error: "other-tab" };
    if (ctx !== "report" && ctx !== "page") return { error: "not-allowed" };
    if (how === "submitted" && job.status !== "review_ready") return { error: "not-ready" };
    if (how === "cancel" && TERMINAL.has(job.status)) return { error: job.status };
    job.status = how === "submitted" ? "submitted_by_user" : "cancelled";
    job.reporter = null;
    job.runner = { tabId: job.runner ? job.runner.tabId : -1, leaseToken: "", leaseExpiresAt: 0 };
    job.revision++;
    return { ok: true, job: publicJob(job) };
  });
}

async function listAmazonJobs() {
  return withJobs((jobs) => ({ ok: true, jobs: Object.values(jobs).map(publicJob) }));
}


// ---------------------------------------------------------------------------
// License (Keygen). One license = one computer (Chrome profile). Unlocking
// needs a Keygen answer signed with our pinned Ed25519 key that echoes our
// nonce and names our license, product and installation (license-verify.js,
// license-service.js). Keys and evidence live in IndexedDB on the extension
// origin (license-store.js), not in chrome.storage, which content scripts
// can read. Pages and the toolbar menu only ever get a sanitized status.
importScripts("license-verify.js", "license-store.js", "license-service.js");
const LV = self.EifLicenseVerify;
const licenseService = self.EifLicenseService.create({
  verify: LV,
  publicKey: () => LV.reconstructPinnedKey(),
  subtle: self.crypto && self.crypto.subtle,
  fetch: (url, opts) => fetch(url, opts),
  store: self.EifLicenseStore.create(self.indexedDB),
  onChange: (st) => {
    // A change notice only. Pages ask this worker for the real status.
    licenseStatusRev++;
    chrome.storage.local.set({ eifLicenseStatus: { rev: licenseStatusRev, ok: st.ok === true } }).catch(() => {});
  },
});
let licenseStatusRev = 0;

// Older versions kept the key and an unsigned "valid" flag in
// chrome.storage.local. Move the key and installation id out, trust nothing
// else (the next online check decides), then delete the old copies.
const licenseReady = (async () => {
  let legacy = {};
  try {
    const d = await chrome.storage.local.get({ eifLicense: null, eifLicenseFp: "" });
    legacy = { key: d.eifLicense && typeof d.eifLicense.key === "string" ? d.eifLicense.key : "", fingerprint: typeof d.eifLicenseFp === "string" ? d.eifLicenseFp : "" };
  } catch (e) {}
  await licenseService.init(legacy);
  try { await chrome.storage.local.remove(["eifLicense", "eifLicenseFp"]); } catch (e) {}
})().catch(() => {});

if (chrome.alarms) {
  chrome.alarms.create("eif-license", { periodInMinutes: 30 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === "eif-license") licenseReady.then(() => licenseService.authorize()).catch(() => {});
    if (a.name === MERCH_RESUME_ALARM) merchResumeIfInterrupted();
    if (a.name === EBAY_RESUME_ALARM) ebayResumeIfInterrupted();
    if (a.name === EBAY_DAILY_ALARM) ebayDailySync();
  });
  chrome.alarms.create(EBAY_DAILY_ALARM, { delayInMinutes: 5, periodInMinutes: 6 * 60 });
}
chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(() => {
  licenseReady.then(() => licenseService.authorize()).catch(() => {});
  merchResumeIfInterrupted();
  ebayResumeIfInterrupted();
});
// The worker itself may have been restarted mid-run (it has no memory of it).
// v3.24.0: open the catalog database (and move old catalogs in) soon after start.
setTimeout(() => { catalogReady(); }, 1000);
setTimeout(() => { merchResumeIfInterrupted(); ebayResumeIfInterrupted(); }, 3000);

// ---------- first setup (v3.16.0) ----------
// A fresh install opens our setup page (setup.html) once. It is reused, never
// duplicated, and also opened later on an explicit request ("Set up" in the
// tool). Nothing the user already has (tracked listings, drafts, contact
// details, settings, the last complete catalog) is reset.
const setupUrl = () => (chrome.runtime.getURL ? chrome.runtime.getURL("setup.html") : `chrome-extension://${chrome.runtime.id}/setup.html`);

async function setupTabs() {
  const ids = new Set();
  try {
    if (chrome.runtime.getContexts) {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
      ctx.forEach((c) => { if (c.tabId >= 0 && String(c.documentUrl || "").startsWith(setupUrl())) ids.add(c.tabId); });
    }
  } catch (e) {}
  try {
    (await chrome.tabs.query({ url: `${setupUrl()}*` })).forEach((t) => ids.add(t.id));
  } catch (e) {}
  return [...ids];
}

async function openSetupTab({ active = true, from } = {}) {
  const existing = await setupTabs();
  if (existing.length) {
    const [keep, ...extra] = existing;
    try {
      const tab = await chrome.tabs.update(keep, { active });
      if (active && tab && tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) {}
    if (extra.length) { try { await chrome.tabs.remove(extra); } catch (e) {} }
    return { ok: true, tabId: keep, reused: true };
  }
  const create = { url: setupUrl(), active };
  if (from && from.tab && from.tab.windowId != null) { create.windowId = from.tab.windowId; create.index = from.tab.index + 1; }
  const tab = await chrome.tabs.create(create);
  return { ok: true, tabId: tab.id, reused: false };
}

chrome.runtime.onInstalled && chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    const d = await chrome.storage.local.get({ [SETUP_KEY]: null, [MERCH_CATALOG_KEY]: null });
    // The old array (before it is moved), or the database (after).
    let account = d[MERCH_CATALOG_KEY] && Array.isArray(d[MERCH_CATALOG_KEY].products) ? d[MERCH_CATALOG_KEY].accountId : "";
    if (!d[SETUP_KEY] && !account) {
      const loaded = await merchLoadCatalog();
      account = loaded ? loaded.catalog.accountId : "";
    }
    if (!d[SETUP_KEY] && account) {
      // Existing users who already have a complete catalog: setup is done.
      // eBay is left as it was: the eBay pages check the sign-in themselves.
      await chrome.storage.local.set({ [SETUP_KEY]: { state: "complete", merch: "done", ebay: null, completedAt: Date.now(), account: MC.maskId(account), version: chrome.runtime.getManifest ? chrome.runtime.getManifest().version : "", migrated: true } });
      return;
    }
    if (details.reason === "install" && !d[SETUP_KEY]) await openSetupTab({ active: true });
  } catch (e) {}
});

// The setup page's view of everything it needs, in one answer.
async function setupStatus() {
  await licenseReady;
  const license = await licenseService.status(true);
  const d = await chrome.storage.local.get({ [SETUP_KEY]: null });
  const loaded = await merchLoadCatalog();
  const run = await merchEngine.status();
  let identity = { state: "unchecked" };
  if (license.ok) {
    const id = await merchGetIdentity(false);
    identity = { state: id.state, stale: !!id.stale, account: id.accountId ? MC.maskId(id.accountId) : "", reason: id.reason || "" };
  }
  const eb = await ebayCatalogStatus();
  const ebayId = ebayIdentityCache ? ebayIdentityCache.value : null;
  const storage = catalogStorageView((await chrome.storage.local.get({ [CATALOG_STORE_KEY]: null }))[CATALOG_STORE_KEY]);
  return {
    ok: true,
    license: { ok: !!license.ok, code: license.code, message: license.message, expiry: license.ok ? license.expiry || null : null }, // v3.23.2: expiry for the Active pill (no name, no key)
    identity,
    storage, // v3.24.0: { state, code } of the catalog database
    ebay: { run: eb.run, catalog: eb.catalog, session: ebayId ? (ebayId.state === "verified" ? "signed_in" : ebayId.state === "logged_out" ? "signed_out" : "unknown") : "unchecked", reason: (ebayId && ebayId.reason) || "", account: ebayId && ebayId.accountId ? EC.maskId(ebayId.accountId) : "" },
    run,
    setup: setupView(d[SETUP_KEY]),
    catalog: loaded ? { account: MC.maskId(loaded.catalog.accountId), count: loaded.catalog.count, syncedAt: loaded.catalog.syncedAt, sameAccount: identity.state === "verified" && MC.sameAccount(loaded.catalog, merchIdentity || {}) } : null,
  };
}

function setupView(raw) {
  const s = raw && typeof raw === "object" ? raw : { state: "pending" };
  const merch = s.merch === undefined && s.state === "complete" ? "done" : s.merch === "skipped" ? null : s.merch || null;
  const ebayMode = ["seller", "account", "none"].includes(s.ebayMode) ? s.ebayMode : s.ebay === "skipped" ? "none" : s.ebay === "signed_in" ? "seller" : null;
  const view = { state: s.state === "complete" ? "complete" : "pending", merch, ebay: s.ebay || null, ebayMode, migrated: !!s.migrated };
  view.resolved = setupResolved(view);
  return view;
}

// eBay step of the setup page. Reuses the homepage check the eBay tool uses.
// It can only confirm a sign-in (eBay fills the greeting in with script), so
// "not confirmed" shows a Sign in button, never an error.
let setupEbayCheckedAt = 0;
async function setupEbayCheck(force) {
  const d = await chrome.storage.local.get({ [SETUP_KEY]: null });
  const cur = setupView(d[SETUP_KEY]);
  if (cur.ebay === "signed_in") return { ok: true, session: "signed_in" };
  // Not asked before you said you have an eBay account.
  if (cur.ebayMode !== "seller" && cur.ebayMode !== "account") return { ok: true, session: "unchecked", reason: "not_asked" };
  // It goes through the shared eBay queue: never more than once a minute.
  if (!force && Date.now() - setupEbayCheckedAt < 60000) return { ok: true, session: "unknown", throttled: true };
  setupEbayCheckedAt = Date.now();
  // Seller Hub answers both ways: your listings page, or eBay's sign-in page.
  let id;
  try { id = await ebayGetIdentity(true); } catch (e) { id = { state: "error", reason: "network" }; }
  // A buyer account has no Seller Hub listings page, but eBay still shows it
  // instead of the sign-in page, which is enough to know you're signed in.
  const signedIn = id.state === "verified" || (cur.ebayMode === "account" && id.state === "error" && id.reason === "not_seller_hub");
  if (signedIn && cur.ebay !== "skipped") await setupPatch({ ebay: "signed_in" });
  return { ok: true, session: signedIn ? "signed_in" : id.state === "logged_out" ? "signed_out" : "unknown", reason: signedIn ? "" : id.reason || "" };
}

// An eBay page saw its own header greet a signed-in user. Only a yes/no is
// kept, never the name.
// v3.27.1: you're signed in to eBay again (an eBay page greets you, or the
// homepage shows a sign-out link): the "eBay signed you out" note goes away.
async function ebayClearSignedOut() {
  const m = (await chrome.storage.local.get({ [EBAY_META_KEY]: {} }))[EBAY_META_KEY] || {};
  if (!["signed_out", "logged_out", "needs_ebay_tab"].includes(m.lastError)) return false;
  await ebaySetMeta({ lastError: "", state: m.syncedAt ? "ready" : "idle" });
  ebayIdentityCache = null;
  return true;
}

async function setupEbaySeen() {
  await ebayClearSignedOut();
  const d = await chrome.storage.local.get({ [SETUP_KEY]: null });
  const cur = setupView(d[SETUP_KEY]);
  if (cur.ebay) return { ok: true, changed: false };
  await setupPatch({ ebay: "signed_in" });
  return { ok: true, changed: true };
}

async function setupSkip(msg) {
  const step = msg.step === "merch" || msg.step === "ebay" ? msg.step : "";
  if (!step) return { ok: false, error: "bad-step" };
  if (step === "merch") return { ok: false, error: "merch-required" }; // v3.18.4
  return setupEbayMode({ mode: msg.undo === true ? null : "none" });
}

// v3.18.4: your answer to "Do you have an eBay account?".
async function setupEbayMode(msg) {
  const mode = ["seller", "account", "none"].includes(msg.mode) ? msg.mode : null;
  const d = await chrome.storage.local.get({ [SETUP_KEY]: null });
  const cur = setupView(d[SETUP_KEY]);
  const patch = { ebayMode: mode };
  if (mode === "none") patch.ebay = "skipped";
  else if (cur.ebay === "skipped") patch.ebay = null;
  if (mode !== "seller" && cur.ebayMode === "seller") {
    const run = await ebayEngine.status();
    if (run && (run.state === "syncing" || run.state === "finalizing")) return { ok: false, error: "syncing" };
  }
  await setupPatch(patch);
  if (mode === "seller" || mode === "account") setupEbayCheckedAt = 0;
  return { ok: true };
}

// Setup finished (or skipped): go to the tool. An open Amazon/eBay tab is
// focused and the setup tab closed; otherwise the setup tab becomes Amazon.
async function setupFinish(msg, sender) {
  const d = await chrome.storage.local.get({ [SETUP_KEY]: null });
  const done = d[SETUP_KEY] && d[SETUP_KEY].state === "complete";
  if (!done && msg.skip !== true) return { ok: false, error: "not-complete" };
  const setups = await setupTabs();
  let tool = null;
  try {
    const tabs = await chrome.tabs.query({ url: ["https://www.amazon.com/*", "https://www.ebay.com/*"] });
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    tool = tabs.find((t) => !/\/report\/infringement/.test(t.url || "")) || null;
  } catch (e) {}
  const self = sender && sender.tab ? sender.tab.id : null;
  if (tool) {
    try { await chrome.tabs.update(tool.id, { active: true }); await chrome.windows.update(tool.windowId, { focused: true }); } catch (e) {}
    const close = setups.filter((id) => id !== tool.id);
    if (self != null && !close.includes(self)) close.push(self);
    try { if (close.length) await chrome.tabs.remove(close); } catch (e) {}
    return { ok: true, to: "existing" };
  }
  // v3.19.1: no Amazon/eBay tab open: just close the setup page (it used to
  // turn into amazon.com, which nobody asked for).
  const close = [...setups];
  if (self != null && !close.includes(self)) close.push(self);
  try { if (close.length) await chrome.tabs.remove(close); } catch (e) {}
  return { ok: true, to: "closed" };
}

async function requireLicense() {
  await licenseReady;
  const a = await licenseService.authorize();
  if (!a.ok) {
    const err = new Error("license");
    err.license = a;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Copycat Hunt API (our Cloudflare Worker). The listing-text hijack
// comparison runs there, so a copy with the license checks removed doesn't
// get it. The Worker accepts only a fresh signed Keygen answer. That answer
// is Keygen's own JSON, which includes the license key; the Worker checks it
// and doesn't store or log it. No secrets live in this file.
const API_BASE = "https://copycat-hunt-api.djawedbns.workers.dev";
const API_TIMEOUT_MS = 20000;
const API_MAX_REPLY = 1024 * 1024;

function cleanListingForApi(L) {
  if (!L || typeof L !== "object") return null;
  const s = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  return {
    title: s(L.title, 400),
    brand: s(L.brand, 120),
    bullets: Array.isArray(L.bullets) ? L.bullets.slice(0, 10).map((b) => s(b, 600)) : [],
    description: s(L.description, 2000),
  };
}

async function apiCompare(msg) {
  const mine = cleanListingForApi(msg.mine);
  if (!mine || !Array.isArray(msg.others) || msg.others.length > 60 || (msg.titles && (!Array.isArray(msg.titles) || msg.titles.length > 200))) return { error: "invalid" };
  const others = [];
  for (const o of msg.others) {
    if (!o || typeof o.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(o.id)) return { error: "invalid" };
    others.push({ id: o.id, ...cleanListingForApi(o) });
  }
  const titles = (msg.titles || []).map((t) => (typeof t === "string" ? t.slice(0, 400) : ""));
  for (let attempt = 0; attempt < 2; attempt++) {
    const evidence = await licenseService.serverEvidence({ force: attempt === 1 });
    if (!evidence) return { error: "license" };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
    let res, text;
    try {
      res = await fetch(`${API_BASE}/v1/compare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evidence, mine, others, titles }),
        credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: ctrl.signal,
      });
      text = await res.text();
    } catch (e) {
      return { error: "server-unreachable" };
    } finally {
      clearTimeout(timer);
    }
    if (text.length > API_MAX_REPLY) return { error: "server" };
    let j = null;
    try { j = JSON.parse(text); } catch (e) {}
    if (res.status === 401 && j && j.reason === "stale" && attempt === 0) continue; // refresh the signed answer once
    if (res.status === 401) return { error: "license-server", reason: j && typeof j.reason === "string" ? j.reason.slice(0, 40) : "" };
    if (res.status === 429) return { error: "busy" };
    if (!res.ok || !j || j.ok !== true || !j.results || typeof j.results !== "object" || !Array.isArray(j.common)) return { error: "server" };
    const results = {};
    for (const o of others) {
      const r = j.results[o.id];
      if (r && typeof r === "object" && ["full", "title", "part", ""].includes(r.category) && Array.isArray(r.copied)) results[o.id] = r;
    }
    return { ok: true, common: j.common.filter((g) => typeof g === "string").slice(0, 100), results };
  }
  return { error: "license-server", reason: "stale" };
}

// v3.26.0: image scores (builder tools test switch). The design and the result
// photo links go to the API with the signed license answer; the API asks the
// copycat-vision scorer. Only Amazon/eBay photo links, at most 70.
const SCORE_TIMEOUT_MS = 70000;
const SCORE_HOSTS = ["m.media-amazon.com", "i.ebayimg.com"];
const scoreUrlOk = (u) => {
  if (typeof u !== "string" || u.length > 2048) return false;
  try { const x = new URL(u); return x.protocol === "https:" && SCORE_HOSTS.includes(x.hostname); } catch (e) { return false; }
};
const SCORE_SIGNALS = ["validHomography", "edgeTilesMatched", "edgeTilesCounted", "edgeTileRecallMin", "edgeF1", "orbInliers", "coverageOriginal", "phashDistance", "drawingValid", "drawingTilesMatched", "drawingTilesCounted", "drawingTileRecallMin", "textValid", "textTilesMatched", "textTilesCounted", "artPixelDiff"]; // v3.26.1: drawing / text / art pixel signals

async function apiImageScore(msg) {
  const o = msg.original;
  let original = null;
  if (o && o.kind === "url" && scoreUrlOk(o.url)) original = { kind: "url", url: o.url };
  else if (o && o.kind === "png" && typeof o.dataBase64 === "string" && o.dataBase64.length <= 2_900_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(o.dataBase64)) original = { kind: "png", dataBase64: o.dataBase64 };
  if (!original || !Array.isArray(msg.candidates) || !msg.candidates.length || msg.candidates.length > 70) return { error: "invalid" };
  const candidates = [];
  for (const c of msg.candidates) {
    if (!c || typeof c.id !== "string" || !/^(amazon|ebay):[A-Za-z0-9]{1,20}$/.test(c.id) || !scoreUrlOk(c.url)) return { error: "invalid" };
    candidates.push({ id: c.id, url: c.url });
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const evidence = await licenseService.serverEvidence({ force: attempt === 1 });
    if (!evidence) return { error: "license" };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SCORE_TIMEOUT_MS);
    let res, text;
    try {
      res = await fetch(`${API_BASE}/v1/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evidence, original, candidates }),
        credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: ctrl.signal,
      });
      text = await res.text();
    } catch (e) {
      return { error: "server-unreachable" };
    } finally {
      clearTimeout(timer);
    }
    if (text.length > API_MAX_REPLY) return { error: "server" };
    let j = null;
    try { j = JSON.parse(text); } catch (e) {}
    if (res.status === 401 && j && j.reason === "stale" && attempt === 0) continue;
    if (res.status === 401) return { error: "license-server" };
    if (res.status === 429) return { error: "busy" };
    if (res.status === 422) return { error: "design", reason: j && typeof j.reason === "string" ? j.reason.slice(0, 40) : "" };
    if (!res.ok || !j || j.ok !== true || !Array.isArray(j.results)) return { error: j && j.error === "scorer-busy" ? "busy" : "server" };
    const want = new Set(candidates.map((c) => c.id));
    const results = {};
    for (const r of j.results) {
      if (!r || typeof r.id !== "string" || !want.has(r.id)) continue;
      const s = r.signals && typeof r.signals === "object" ? r.signals : null;
      results[r.id] = {
        status: typeof r.status === "string" ? r.status.slice(0, 30) : "",
        rank: Number.isInteger(r.rank) ? r.rank : null,
        signals: s ? Object.fromEntries(SCORE_SIGNALS.filter((k) => typeof s[k] === "number" || typeof s[k] === "boolean").map((k) => [k, s[k]])) : null,
      };
    }
    const og = j.original && typeof j.original === "object" ? j.original : {};
    return { ok: true, results, design: { kind: String(og.kind || "").slice(0, 10), source: String(og.source || "").slice(0, 20) }, ms: j.timing && Number(j.timing.totalMs) || 0 };
  }
  return { error: "license-server" };
}

// ---------------------------------------------------------------------------
// v3.27.0: "Fix problems" (toolbar menu). Puts back in order what can make the
// tool hang or lose a feature, and says what it did. Never deletes tracked
// copies, reports, the catalog, the license or settings; never solves a robot
// check (it says to open eBay instead).
const REPAIR_STUCK_MS = 10 * 60 * 1000;
async function repairExtension() {
  const lines = [];
  const add = (ok, text) => lines.push({ ok, text });

  // 0. v3.27.1: are you signed in? (asked fresh, not from memory)
  ebayIdentityCache = null;
  ebayIdentityTabAt = 0;
  merchIdentity = null;
  catalogMetaCache.merch = null;
  catalogMetaCache.ebay = null;
  const signedOut = {};
  try {
    const m = await merchGetIdentity(true);
    if (m && m.state === "verified") add(true, "Merch: signed in.");
    else if (m && m.state === "logged_out") { signedOut.merch = true; add(false, "Merch: signed out. Open merch.amazon.com and sign in, then sync."); }
    else add(false, "Merch: couldn't check the sign-in right now.");
  } catch (e) {
    add(false, "Merch: couldn't check the sign-in right now.");
  }
  try {
    const d = await chrome.storage.local.get({ [SETUP_KEY]: null });
    if (setupView(d[SETUP_KEY]).ebayMode !== "seller") add(true, "eBay: not synced (you said you don't sell on eBay).");
    else {
      const e = await ebayGetIdentity(true);
      if (e && e.state === "verified") { add(true, "eBay: signed in."); await ebayClearSignedOut(); }
      else if (e && e.state === "logged_out") { signedOut.ebay = true; await ebaySetMeta({ lastError: "signed_out" }); add(false, "eBay: signed out. Sign in to eBay, then sync your listings."); }
      else add(false, "eBay: couldn't check the sign-in. Open an eBay tab and try again.");
    }
  } catch (e) {
    add(false, "eBay: couldn't check the sign-in right now.");
  }

  // 1. A sync that shows "syncing" but hasn't read a page for 10 minutes.
  for (const [eng, label, key] of [[merchEngine, "Merch catalog sync", "merch"], [ebayEngine, "eBay listings sync", "ebay"]]) {
    try {
      const run = await eng.getRun();
      const last = Number(run && (run.lastPageAt || run.startedAt)) || 0;
      const active = run && (run.state === "syncing" || run.state === "finalizing");
      if (active && Date.now() - last > REPAIR_STUCK_MS) {
        const r = await eng.cancel();
        add(r && r.ok, r && r.ok ? `${label} was stuck: stopped. Press Sync now to start it again.` : `${label} is still finishing. Give it a few minutes.`);
      } else if (active) add(true, `${label} is running.`);
      else if (signedOut[key]) add(false, `${label}: waits until you sign in again.`);
      else add(true, `${label}: nothing stuck.`);
    } catch (e) {
      add(false, `${label} couldn't be checked.`);
    }
  }

  // 2. eBay requests paused (asked to slow down, or a robot check).
  try {
    const st = await ebayRequests.status();
    if (!st.paused) add(true, "eBay requests: not paused.");
    else {
      const r = await ebayRecover({ url: `${EBAY_ORIGIN}/`, method: "GET" }, null);
      if (r && r.ok) add(true, "eBay requests were paused: started again.");
      else if (r && r.until && r.until > Date.now()) add(false, `eBay asked to wait. It starts again by itself in about ${Math.max(1, Math.ceil((r.until - Date.now()) / 60000))} min.`);
      else add(false, "eBay still wants a check. Open ebay.com and finish it yourself, then hunt again.");
    }
  } catch (e) {
    add(false, "eBay requests couldn't be checked.");
  }

  // 4. The local database (Merch and eBay listings).
  if (merchEngine.isRunning() || ebayEngine.isRunning()) add(true, "Database: in use by a sync, left as it is.");
  else {
    try {
      await catalogDb.restart();
      const q = await dbCall("quickCheck", {});
      add(!!(q && q.ok), q && q.ok ? "Database: restarted and checked, all fine." : "Database: damaged. Sync your Merch and eBay listings again to rebuild it.");
    } catch (e) {
      add(false, "Database: couldn't be opened. Restart the extension below, then sync again.");
    }
  }

  // 5. Amazon report jobs past their time are closed (never sent, never ticked).
  try {
    await withJobs(() => {});
    add(true, "Old Amazon report jobs cleared.");
  } catch (e) {
    add(false, "Amazon report jobs couldn't be checked.");
  }

  // 6. License: checked again now.
  try {
    await licenseReady;
    await licenseService.recheck({ force: true });
    const lic = await licenseService.status(true);
    add(!!(lic && lic.ok && lic.code === "VALID"), lic && lic.ok && lic.code === "VALID" ? "License: active." : `License: ${(lic && lic.message) || "not active"}.`);
  } catch (e) {
    add(false, "License couldn't be checked (no connection?).");
  }
  return { ok: true, lines, at: Date.now() };
}

// ---------------------------------------------------------------------------
// Who may send what. Ordinary websites can't message this worker at all
// (no externally_connectable); the checks below separate our own contexts:
// the toolbar menu (extension page), our panel's content script on eBay /
// Amazon pages (top frame only), and the form filler on Amazon's report page.
function senderContext(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return null;
  let u;
  try { u = new URL(sender.url || ""); } catch (e) { return null; }
  // Our toolbar menu (also when opened in a tab as an extension page).
  if (u.protocol === "chrome-extension:" && u.host === chrome.runtime.id) {
    if (u.pathname === "/popup.html") return "popup";
    // Our first-setup page, only as a top-level tab.
    if (u.pathname === "/setup.html" && sender.tab && sender.frameId === 0) return "setup";
    return null;
  }
  if (!sender.tab || sender.frameId !== 0 || u.protocol !== "https:") return null;
  if (sender.origin && sender.origin !== u.origin) return null;
  if (u.hostname === "www.amazon.com" && /^\/report\/infringement\/?$/.test(u.pathname)) return "report";
  if (u.hostname === "www.ebay.com" || u.hostname === "www.amazon.com") return "page";
  return null;
}

const MAX_IMAGE_B64 = 12 * 1024 * 1024;
const isStr = (v, max) => typeof v === "string" && v.length <= max;
const isB64Image = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_IMAGE_B64 && /^[A-Za-z0-9+/=]+$/.test(v);

// type -> { from: allowed contexts, license: needed?, run(msg, sender) }
const ROUTES = {
  "eif-license-status": { from: ["popup", "page", "report", "setup"], license: false, run: async (msg, sender, ctx) => { await licenseReady; return licenseService.status(ctx === "popup"); } },
  "eif-license-activate": { from: ["popup", "setup"], license: false, run: async (msg) => {
    if (!isStr(msg.key, 1024)) return { ok: false, error: "bad-key", message: "That doesn't look like a license key." };
    await licenseReady;
    return licenseService.activate(msg.key);
  } },
  "eif-license-recheck": { from: ["popup"], license: false, run: async () => { await licenseReady; return licenseService.recheck({ force: true }); } },
  // v3.27.0: "Fix problems" and its last resort.
  "eif-repair": { from: ["popup"], license: false, run: () => repairExtension() },
  "eif-restart": { from: ["popup"], license: false, run: () => { setTimeout(() => chrome.runtime.reload(), 150); return { ok: true }; } },
  "eif-license-open-menu": { from: ["page", "setup"], license: false, run: async () => {
    try { if (chrome.action && chrome.action.openPopup) { await chrome.action.openPopup(); return { ok: true }; } } catch (e) {}
    return { ok: false };
  } },
  "eif-amazon-search": { from: ["page"], license: true, run: (m) => (isB64Image(m.base64) ? amazonSearch(m.base64, ["image/jpeg", "image/png", "image/webp"].includes(m.mime) ? m.mime : "image/jpeg") : { error: "invalid-image" }) },
  "eif-amazon-dfa": { from: ["page"], license: true, run: (m) => amazonFirstAvailable(m.asin) },
  "eif-amazon-listing": { from: ["page"], license: true, run: (m) => amazonListing(m.asin, m.refresh === true, m.priority === "high") },
  "eif-amazon-keywords": { from: ["page"], license: true, run: (m) => (isStr(m.query, 2000) ? amazonKeywordSearch(m.query) : { error: "empty" }) },
  "eif-amazon-job-open": { from: ["page"], license: true, run: (m) => openAmazonJobOnce(m.job) },
  "eif-amazon-job-list": { from: ["page"], license: true, run: () => listAmazonJobs() },
  "eif-amazon-job-claim": { from: ["report"], license: true, run: (m, s) => claimAmazonJob(isStr(m.jobId, 64) ? m.jobId : "", s) },
  "eif-amazon-job-update": { from: ["report"], license: true, run: (m, s) => updateAmazonJob(m, s) },
  // Finishing (submitted / cancel) works without a license so a report that
  // is already open can still be recorded or cancelled.
  "eif-amazon-job-finish": { from: ["report", "page"], license: false, run: (m, s, ctx) => finishAmazonJob(isStr(m.jobId, 64) ? m.jobId : "", m.how === "submitted" ? "submitted" : "cancel", s, ctx) },
  "eif-text-compare": { from: ["page"], license: true, run: (m) => apiCompare(m) },
  "eif-image-score": { from: ["page"], license: true, run: (m) => apiImageScore(m) }, // v3.26.0
  "eif-merch-status": { from: ["page"], license: true, run: () => merchStatus() },
  "eif-merch-sync": { from: ["page"], license: true, run: () => merchCoordinator.ensure(true) },
  "eif-merch-ensure": { from: ["page"], license: true, run: () => merchCoordinator.ensure() },
  // First setup (setup.html only), plus "open setup" from the tool.
  "eif-setup-status": { from: ["setup"], license: false, run: () => setupStatus() },
  // Both answer as soon as the run is saved (the download continues in the worker).
  "eif-setup-start": { from: ["setup"], license: true, run: (m) => merchBegin((onBegin) => merchEngine.start({ kind: "setup", restart: m.restart === true, onBegin })) },
  "eif-setup-resume": { from: ["setup"], license: true, run: () => merchBegin((onBegin) => merchEngine.resume({ onBegin })) },
  "eif-setup-pause": { from: ["setup"], license: false, run: () => merchEngine.pause() },
  "eif-setup-cancel": { from: ["setup"], license: false, run: () => merchEngine.cancel() },
  "eif-setup-signin": { from: ["setup"], license: false, run: async (m, s) => {
    const url = m.site === "ebay" ? `https://signin.ebay.com/ws/eBayISAPI.dll?SignIn&ru=${encodeURIComponent(EBAY_ORIGIN + "/")}` : MC.DASHBOARD_URL;
    const create = { url, active: true };
    if (s && s.tab && s.tab.windowId != null) { create.windowId = s.tab.windowId; create.index = s.tab.index + 1; }
    await chrome.tabs.create(create);
    return { ok: true };
  } },
  // v3.24.0: only after you confirm, and only when the database can't be used.
  "eif-setup-rebuild-db": { from: ["setup"], license: false, run: async () => { const r = await catalogRebuild(); return { ...(await setupStatus()), rebuild: r }; } },
  "eif-setup-recheck": { from: ["setup"], license: true, run: async () => { await merchGetIdentity(true); return setupStatus(); } },
  "eif-setup-finish": { from: ["setup"], license: false, run: (m, s) => setupFinish(m, s) },
  "eif-setup-ebay-start": { from: ["setup"], license: true, run: async (m) => {
    const d = await chrome.storage.local.get({ [SETUP_KEY]: null });
    if (setupView(d[SETUP_KEY]).ebayMode !== "seller") return { ok: false, error: "not_seller" }; // v3.18.8
    return merchBegin((onBegin) => ebayEngine.start({ kind: "setup", restart: m.restart === true, onBegin }), ebayEngine);
  } },
  "eif-setup-ebay-resume": { from: ["setup"], license: true, run: () => merchBegin((onBegin) => ebayEngine.resume({ onBegin }), ebayEngine) },
  "eif-setup-ebay-pause": { from: ["setup"], license: false, run: () => ebayEngine.pause() },
  "eif-setup-ebay-cancel": { from: ["setup"], license: false, run: () => ebayEngine.cancel() },
  "eif-setup-ebay-open-tab": { from: ["setup"], license: true, run: async (m, s) => {
    const create = { url: `${EBAY_ORIGIN}/`, active: false };
    if (s && s.tab && s.tab.windowId != null) { create.windowId = s.tab.windowId; create.index = s.tab.index + 1; }
    await chrome.tabs.create(create);
    return { ok: true };
  } },
  "eif-ebay-catalog-status": { from: ["page", "popup"], license: true, run: () => ebayCatalogStatus() },
  // v3.24.0: no license check, like the old eifEbayOwnIds list it replaces:
  // it only keeps your own listings out of copycat lists.
  "eif-ebay-own-lookup": { from: ["page", "popup"], license: false, run: (m) => (Array.isArray(m.items) && m.items.length <= 500 ? ebayOwnLookup(m.items) : { error: "invalid" }) },
  "eif-ebay-sync": { from: ["page"], license: true, run: async () => {
    // v3.18.8: only for "I sell on eBay". Without that answer nothing is asked from Seller Hub.
    const d = await chrome.storage.local.get({ [SETUP_KEY]: null });
    if (setupView(d[SETUP_KEY]).ebayMode !== "seller") return { ok: false, error: "not_seller" };
    const r = await merchBegin((onBegin) => ebayEngine.start({ kind: "sync", onBegin }), ebayEngine);
    // v3.27.0: say why it didn't start (signed out, no eBay tab), so the page can.
    if (r && (r.state === "syncing" || r.state === "finalizing" || r.state === "complete")) return r;
    const m = (await chrome.storage.local.get({ [EBAY_META_KEY]: {} }))[EBAY_META_KEY] || {};
    // The attempt just made writes its reason to the meta; r can be an older run.
    const why = m.lastError || (r && r.error) || "";
    return { ...(r || {}), ok: false, error: r && r.state === "needs_login" ? "signed_out" : why || "failed" };
  } },
  "eif-setup-ebay-check": { from: ["setup"], license: true, run: async (m) => { await setupEbayCheck(m.force === true); return setupStatus(); } },
  "eif-setup-skip": { from: ["setup"], license: false, run: async (m) => { const r = await setupSkip(m); const st = await setupStatus(); return { ...st, skip: r }; } },
  "eif-setup-ebay-mode": { from: ["setup"], license: false, run: async (m) => { const r = await setupEbayMode(m); const st = await setupStatus(); return { ...st, mode: r }; } },
  "eif-setup-ebay-seen": { from: ["page"], license: false, run: (m, s) => (s && isEbayUrl(s.url || (s.tab && s.tab.url) || "") ? setupEbaySeen() : { ok: false, error: "not-allowed" }) },
  "eif-merch-open-setup": { from: ["page", "popup"], license: false, run: (m, s) => openSetupTab({ active: true, from: s }) },
  "eif-merch-lookup": { from: ["page"], license: true, run: (m) => (Array.isArray(m.items) && m.items.length <= 500 ? merchLookup(m.items, m.fresh === true) : { error: "invalid" }) },
  "eif-ebay-status": { from: ["page"], license: true, run: () => ebayRequests.status() },
  "eif-ebay-session": { from: ["page"], license: true, run: (m, s) => ebaySession(s) },
  "eif-ebay-resume": { from: ["page"], license: true, run: (m, s) => ebayRecover(m.probe && typeof m.probe === "object" ? m.probe : undefined, s) },
  "eif-ebay-open-tab": { from: ["page"], license: true, run: (m, s) => openEbayTabForPage(s) },
  "eif-ebay-fetch": { from: ["page"], license: true, run: (m, s) => (isStr(m.url, 4096) ? ebayFetchText(m.url, m.method, s, m.priority) : { error: "not-allowed" }) },
  "eif-ebay-visual": { from: ["page"], license: true, run: (m, s) => (isB64Image(m.base64) ? ebayVisualSearch(m.base64, s) : { error: "invalid-image" }) },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return false;
  const route = Object.prototype.hasOwnProperty.call(ROUTES, msg.type) ? ROUTES[msg.type] : null;
  if (!route) return false;
  const ctx = senderContext(sender);
  if (!ctx || !route.from.includes(ctx)) {
    sendResponse({ error: "not-allowed" });
    return false;
  }
  (async () => {
    if (route.license) await requireLicense();
    return route.run(msg, sender, ctx);
  })()
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse(e && e.license ? { error: "license", code: e.license.code, message: e.license.message } : { error: "failed" }));
  return true;
});
