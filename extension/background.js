importScripts("amazon-report-core.js");
const AMAZON_HOSTS = Object.values(self.EifAmazonReport.MARKETPLACES).map((m) => m.host);
function amazonOrigin(marketplace) {
  const mp = self.EifAmazonReport.normalizeMarketplace(marketplace) || "US";
  return `https://${self.EifAmazonReport.MARKETPLACES[mp].host}`;
}
const mpOf = (marketplace) => self.EifAmazonReport.normalizeMarketplace(marketplace) || "US";

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

function simplify(json, origin = "https://www.amazon.com") {
  const groups = (json && json.searchResults) || [];
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
    if (!m) continue;
    items.push({
      asin,
      title: String(m.title || ""),
      brand: String(m.byLine || ""),
      price: String(m.price || ""),
      rating: typeof m.averageOverallRating === "number" ? m.averageOverallRating : null,
      reviews: String(m.totalReviewCount || ""),
      image: String(m.imageUrl || ""),
      score: scores.has(asin) ? scores.get(asin) : null,
      url: `${origin}/dp/${asin}`,
    });
  }
  return { items, totalAsins: order.length, rest: order.filter((a) => !meta.has(a)) };
}

async function amazonSearch(base64, type, marketplace) {
  if (typeof base64 !== "string" || base64.length > 12 * 1024 * 1024) return { error: "invalid-image" };
  const origin = amazonOrigin(marketplace);
  let page;
  try {
    page = await fetch(`${origin}/stylesnap`, { credentials: "include" });
  } catch (e) {
    return { error: "network" };
  }
  if (!page.ok) return { error: "blocked", status: page.status };
  const token = readToken(await page.text());
  if (!token) return { error: "blocked" };
  const form = new FormData();
  form.append("explore-looks.jpg", base64ToBlob(base64, type), "explore-looks.jpg");
  let res;
  try {
    res = await fetch(`${origin}/stylesnap/upload?stylesnapToken=${encodeURIComponent(token)}`, {
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
  return { ok: true, marketplace: mpOf(marketplace), ...simplify(json, origin) };
}

const EBAY_ORIGIN = "https://www.ebay.com";

function isEbayUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "www.ebay.com";
  } catch (e) {
    return false;
  }
}

importScripts("ebay-requests.js");
const ER = self.EifEbayRequests;
const oldEbayRulesRemoved = Promise.resolve();

async function licensedNow() {
  try { await requireLicense(); return true; } catch (e) { return false; }
}

const MAX_PAGE_TEXT = 8 * 1024 * 1024;
function ebayFinal(result) {
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

async function openEbayTabId() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://www.ebay.com/*" });
    const ok = tabs.filter((t) => t.id != null && !t.discarded && t.status === "complete" && isEbayUrl(t.url || "") && !isEbayCheckUrl(t.url || ""));
    ok.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return ok.length ? ok[0].id : null;
  } catch (e) {
    return null;
  }
}

async function performEbayRequestRaw(input, sender) {
  await oldEbayRulesRemoved;
  const fromEbayTab = sender?.tab?.id != null && isEbayUrl(sender.url || sender.tab.url || "");
  const tabId = fromEbayTab ? sender.tab.id : await openEbayTabId();
  if (tabId != null) {
    const out = await runEbayRequestInTab(tabId, input);
    if (fromEbayTab) return out || { ok: false, error: "timeout" };
    if (out && out.error !== "wrong-origin") return out;
  }
  const r = await performEbayWorkerFetch(input);
  if (r && r.status === 403 && ER.classify(r) !== "captcha") return { ok: false, error: "needs-ebay-tab", status: 0 };
  return r;
}

async function runEbayRequestInTab(tabId, input) {
  let capTimer;
  try {
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
    const sellerHub = /^https:\/\/www\.ebay\.com\/sh\//i.test(String(input.url || "")) && input.method !== "POST";
    const r = await fetch(input.url, { method: input.method, body, credentials: "include", signal: ctrl.signal, redirect: sellerHub ? "manual" : "follow" });
    if (r.type === "opaqueredirect") return { ok: false, error: "needs-ebay-tab", status: 0 };
    return { ok: r.ok, status: r.status, url: r.url, retryAfter: r.headers.get("retry-after"), text: input.method === "HEAD" ? "" : await r.text() };
  } finally { clearTimeout(timer); }
}

let ebayCheckTabAt = 0;
let ebayCheck = null;
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
  } catch (e) {  }
}

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
  } catch (e) {  }
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

const AZ = self.EifAmazonReport;

const listingCache = new Map();
const listingInFlight = new Map();
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
    else if (listingQueue.length >= 300) reject(new Error("busy"));
    else {
      run.asin = asin || "";
      if (high) listingQueue.unshift(run);
      else listingQueue.push(run);
    }
  });
}

async function fetchAmazonListing(asin, marketplace) {
  if (!(await licensedNow())) return { state: "error", reason: "license", published: { state: "unknown", reason: "license" } };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${amazonOrigin(marketplace)}/dp/${asin}`, {
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

async function amazonListing(asin, refresh, high, marketplace) {
  const a = AZ.normalizeAsin(asin);
  if (!a) return { state: "error", reason: "bad-asin", published: { state: "unknown", reason: "bad-asin" } };
  const mp = mpOf(marketplace);
  const key = `${mp}|${a}`;
  const cached = listingCache.get(key);
  if (!refresh && cached && Date.now() - cached.at < LISTING_TTL_MS) return cached.value;
  if (listingInFlight.has(key)) {
    const i = high ? listingQueue.findIndex((r) => r.asin === key) : -1;
    if (i > 0) listingQueue.unshift(...listingQueue.splice(i, 1));
    return listingInFlight.get(key);
  }
  const p = withListingSlot(() => fetchAmazonListing(a, mp), high, key)
    .then((value) => {
      value = { ...value, asin: a, marketplace: mp, fetchedAt: Date.now(), sourceUrl: `${amazonOrigin(mp)}/dp/${a}` };
      if (value.state === "ready" || value.state === "missing") listingCache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => listingInFlight.delete(key));
  listingInFlight.set(key, p);
  return p;
}

const kwQueues = new Map();
function amazonKeywordSearch(query, maxLen = 150, marketplace) {
  const q = String(query || "").trim().slice(0, maxLen);
  if (!q) return Promise.resolve({ error: "empty" });
  const mp = mpOf(marketplace);
  if (!kwQueues.has(mp)) kwQueues.set(mp, { last: 0, chain: Promise.resolve(), pending: 0 });
  const Q = kwQueues.get(mp);
  if (Q.pending >= 20) return Promise.resolve({ error: "busy" });
  const run = async () => {
    if (!(await licensedNow())) return { error: "license" };
    const wait = Q.last + 3000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    Q.last = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(`${amazonOrigin(marketplace)}/s?k=${encodeURIComponent(q)}`, {
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
  Q.pending++;
  const p = Q.chain.then(run, run).finally(() => Q.pending--);
  Q.chain = p.catch(() => {});
  return p;
}

const ASIN_DETAILS_CHUNK = 25;
const ASIN_RETRY_MAX = 5;
async function amazonAsinDetails(asins, marketplace) {
  const want = [...new Set((Array.isArray(asins) ? asins : []).map((a) => AZ.normalizeAsin(a)).filter(Boolean))].slice(0, 200);
  const found = new Map();
  let blocked = false;
  for (let i = 0; i < want.length && !blocked; i += ASIN_DETAILS_CHUNK) {
    const chunk = want.slice(i, i + ASIN_DETAILS_CHUNK);
    const r = await amazonKeywordSearch(chunk.join(" | "), 400, marketplace);
    if (r.error === "blocked") blocked = true;
    else if (r.ok) (r.items || []).forEach((it) => { if (chunk.includes(it.asin) && !found.has(it.asin)) found.set(it.asin, it); });
    else if (r.error === "license") return { error: "license" };
  }
  const removed = [];
  for (const a of want.filter((x) => !found.has(x)).slice(0, ASIN_RETRY_MAX)) {
    if (blocked) break;
    const r = await amazonKeywordSearch(a, 150, marketplace);
    if (r.error === "blocked") { blocked = true; break; }
    const it = r.ok && (r.items || []).find((x) => x.asin === a);
    if (it) { found.set(a, it); continue; }
    const L = await amazonListing(a, false, false, marketplace);
    if (L.state === "missing") removed.push(a);
    else if (L.state === "blocked") blocked = true;
    else if (L.state === "ready" && L.title) found.set(a, { title: L.title, image: L.image || "", price: "" });
  }
  const items = want.filter((a) => found.has(a)).map((a) => {
    const it = found.get(a);
    return { asin: a, title: String(it.title || ""), brand: "", price: String(it.price || ""), rating: null, reviews: "", image: String(it.image || ""), score: null, url: `${amazonOrigin(marketplace)}/dp/${a}` };
  });
  return { ok: true, items, missing: want.filter((a) => !found.has(a) && !removed.includes(a)), removed, blocked };
}

async function amazonFirstAvailable(asin) {
  const L = await amazonListing(asin, false);
  if (L.state === "error" && L.reason === "bad-asin") return { error: "bad-asin" };
  if (L.state === "error" && (L.reason === "network" || L.reason === "timeout")) return { error: "network" };
  return { ok: true, firstAvailable: L.published && L.published.state === "known" ? L.published.isoDate : "", listing: L };
}

importScripts("merch-catalog.js", "connection-core.js", "merch-sync.js", "catalog-db.js", "catalog-migrate.js", "merch-sales.js");
const MC = self.EifMerchCatalog;
const MSALES = self.EifMerchSales;
const MERCH_CATALOG_KEY = "eifMerchCatalog";
const MERCH_META_KEY = "eifMerchMeta";

const CATALOG_STORE_KEY = "eifCatalogStore";
const catalogDb = self.EifCatalogDb.createCatalogDb({ chrome });
let catalogMove = null;

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

async function dbCall(op, args, opts) {
  const ready = await catalogReady();
  if (!ready.ok) throw Object.assign(new Error(ready.code), { code: ready.code });
  return catalogDb.call(op, args, opts);
}

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

function catalogPages(kind) {
  return {
    savePage: (cursor, page, rows) => dbCall("savePage", { kind, cursor, page, rows }),
    getCursor: async () => (await dbCall("getCursor", { kind })).cursor,
    clear: (runId) => dbCall("clearRun", { kind, runId }),
    finalize: (run, info) => dbCall("finalize", { kind, run: { runId: run.runId, pagesDone: run.pagesDone, accountId: run.accountId, customerId: run.customerId || "" }, info }, { timeoutMs: 15 * 60 * 1000 }),
  };
}

const catalogMetaCache = { merch: null, ebay: null };
async function catalogMeta(kind) {
  const c = catalogMetaCache[kind];
  if (c && Date.now() - c.at < 60000) return c.value;
  const value = (await dbCall("active", { kind })).catalog;
  catalogMetaCache[kind] = { at: Date.now(), value };
  return value;
}

let merchIdentity = null;
let merchSessionRevision = 0;
let merchSyncing = null;

async function merchSetMeta(patch) {
  const cur = (await chrome.storage.local.get({ [MERCH_META_KEY]: {} }))[MERCH_META_KEY] || {};
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [MERCH_META_KEY]: next });
  return next;
}

const MERCH_STALE_GRACE_MS = 24 * 60 * 60 * 1000;
let merchIdentityInFlight = null;

function merchInvalidate(reason) {
  if (merchIdentity && merchIdentity.state === "verified") merchSessionRevision++;
  merchIdentity = { state: "unverified", reason, at: Date.now() };
}

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
      if (parsed.reason === "network") {
        try {
          const probe = await fetch(MC.DASHBOARD_URL, { credentials: "include", redirect: "manual", signal: ctrl.signal });
          if (probe.type === "opaqueredirect") parsed = { state: "logged_out", reason: "redirect_offsite" };
        } catch (e2) {}
      }
    } finally {
      clearTimeout(timer);
    }
    if (merchSessionRevision !== revAtStart) return { state: "unverified", reason: "session_changed" };
    const prev = merchIdentity;
    if (parsed.state === "verified") {
      if (prev && prev.accountId && !MC.sameAccount(prev, parsed)) merchSessionRevision++;
      merchIdentity = { ...parsed, at: Date.now(), verifiedAt: Date.now() };
      return merchIdentity;
    }
    if (parsed.state === "logged_out") {
      if (prev && prev.state !== "logged_out") merchSessionRevision++;
      merchIdentity = { ...parsed, at: Date.now() };
      return merchIdentity;
    }
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

const MS = self.EifMerchSync;
const SETUP_KEY = "eifSetup";
let setupLock = Promise.resolve();
function setupResolved(s) {
  return s.merch === "done" && (s.ebay === "signed_in" || s.ebay === "skipped");
}
function setupPatch(patch) {
  const run = setupLock.then(async () => {
    const d = await chrome.storage.local.get({ [SETUP_KEY]: null });
    const cur = d[SETUP_KEY] && typeof d[SETUP_KEY] === "object" ? d[SETUP_KEY] : { state: "pending" };
    const next = { ...cur, ...patch };
    if (cur.state === "complete" && cur.merch === undefined && !("merch" in patch)) next.merch = "done";
    const wasComplete = cur.state === "complete";
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
  const id = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) {} }, 25 * 1000);
  return () => clearInterval(id);
}

async function merchPublishRun(pub) {
  const st = pub.state;
  const progress = { runState: st, pagesDone: pub.pagesDone || 0, rawScanned: pub.rawScanned || 0, usable: pub.usable || 0, expectedTotal: pub.expectedTotal == null ? null : pub.expectedTotal, lastPageAt: pub.lastPageAt || 0, waitUntil: pub.waitUntil || 0 };
  if (st === "syncing" || st === "finalizing") await merchSetMeta({ state: "syncing", account: pub.account || "", startedAt: pub.startedAt || Date.now(), lastError: pub.error && pub.error !== "user_paused" ? pub.error : "", ...progress });
  else if (st === "complete") await merchSetMeta({ ...progress, runState: "complete" });
  else await merchSetMeta({ state: "failed", lastError: pub.error || st, ...progress });
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
  onPublished: async (catalog) => {
    catalogMetaCache.merch = null;
    await merchSetMeta({ state: "ready", account: MC.maskId(catalog.accountId), count: catalog.count, hitCount: catalog.hitCount, rawScanned: catalog.rawScanned, syncedAt: catalog.syncedAt, revision: catalog.revision, lastError: "" });
    await merchSummarize();
    catalogCleanupSoon();
  },
  onPublish: (pub) => merchPublishRun(pub),
  onComplete: async (run) => {
    await salesSetMeta({ state: "loading", done: 0, total: 0, lastError: "" });
    await setupPatch({ merch: "done", account: MC.maskId(run.accountId) });
    salesSync().catch(() => {});
  },
});

async function merchSummarize(onlyIfMissing) {
  try {
    const meta = (await chrome.storage.local.get({ [MERCH_META_KEY]: {} }))[MERCH_META_KEY] || {};
    if (meta.state !== "ready") return;
    if (onlyIfMissing && meta.liveRevision && meta.liveRevision === meta.revision) return;
    const r = await dbCall("summary", { kind: "merch" });
    const s = r && r.summary;
    if (!s || (meta.revision && s.revision !== meta.revision)) return;
    await merchSetMeta({ designs: s.designs, liveProducts: s.products, liveRevision: s.revision });
  } catch (e) {}
}

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

async function merchResumeIfInterrupted() {
  try {
    if (merchEngine.isRunning()) return;
    const run = await merchEngine.getRun();
    if (!run || !["syncing", "finalizing", "paused"].includes(run.state)) return;
    await licenseReady;
    const lic = await licenseService.authorize();
    if (!lic.ok) return;
    merchEngine.resume({ auto: true }).catch(() => {});
  } catch (e) {}
}

importScripts("ebay-catalog.js");
const EC = self.EifEbayCatalog;
const EBAY_META_KEY = "eifEbayMeta";
const EBAY_RESUME_ALARM = "eif-ebay-resume";
const EBAY_DAILY_ALARM = "eif-ebay-daily";
let ebayIdentityCache = null;
let ebayFirstPage = null;

function ebaySyncFetch(url) {
  if (ebayFirstPage && ebayFirstPage.url === url && Date.now() - ebayFirstPage.at < 60000) {
    const r = ebayFirstPage.result;
    ebayFirstPage = null;
    return Promise.resolve(r);
  }
  return ebayRequests.request({ url, method: "GET", refresh: true, quiet: true, nocache: true }, null);
}

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
  pauseMs: 0,
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
    if (setupView(d[SETUP_KEY]).ebayMode !== "seller") return;
    await licenseReady;
    const lic = await licenseService.authorize();
    if (!lic.ok) return;
    ebayEngine.resume({ auto: true }).catch(() => {});
  } catch (e) {}
}

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

async function ebayOwnLookup(items) {
  const list = [...new Set((Array.isArray(items) ? items : []).map((x) => String(x || "")).filter((x) => /^\d{9,15}$/.test(x)))].slice(0, 500);
  try {
    const r = await dbCall("ebayOwn", { items: list });
    return { ok: true, own: r.own, revision: r.catalog ? r.catalog.revision : "", synced: !!r.catalog };
  } catch (e) {
    return { ok: false, error: (e && e.code) || "storage_unavailable", own: [] };
  }
}

function catalogStorageView(v) {
  if (!v) return { state: "unchecked", code: "" };
  return { state: v.state === "ready" ? "ready" : "failed", code: v.code || "" };
}

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
  const used = res.catalog || meta;
  if (!MC.sameAccount(used, identity)) return fail("other_account");
  list.forEach((it, i) => (out[keyOf(it)] = res.results[i] || { state: "unknown", reason: "no_answer" }));
  return { ok: true, connected: true, stale: !!identity.stale, account: MC.maskId(identity.accountId), syncedAt: used.syncedAt, revision: used.revision, results: out };
}

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

const SALES_META_KEY = "eifSalesMeta";
const SALES_EXTRA_SYNC_KEY = "eifSalesExtraSyncAt";
const SALES_STALE_MS = 24 * 60 * 60 * 1000;
let salesRunning = null;

async function salesSetMeta(patch) {
  const cur = (await chrome.storage.local.get({ [SALES_META_KEY]: {} }))[SALES_META_KEY] || {};
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [SALES_META_KEY]: next });
  return next;
}

function salesSync() {
  if (!salesRunning) salesRunning = salesSyncOnce().finally(() => { salesRunning = null; });
  return salesRunning;
}

async function salesSyncOnce() {
  const stopAwake = merchKeepAlive();
  try {
    const identity = await merchGetIdentity(false);
    if (identity.state !== "verified") return salesFailed(identity.state === "logged_out" ? "logged_out" : identity.state === "rate_limited" ? "rate_limited" : "network");
    const catalog = await catalogMeta("merch");
    if (!catalog || catalog.accountId !== identity.accountId) return salesFailed("no_catalog");
    const account = identity.accountId;
    const saved = (await dbCall("salesCoverage", {})).coverage;
    const p = MSALES.plan(saved, account, MSALES.ptDay(Date.now()));
    const periods = MSALES.chunks(p.from, p.to);
    await salesSetMeta({ state: "loading", done: 0, total: periods.length, lastError: "", startedAt: Date.now() });
    for (let i = 0; i < periods.length; i++) {
      if (i) await new Promise((r) => setTimeout(r, 800));
      const got = await MSALES.fetchPeriod(periods[i], { MC, fetch: (u, o) => fetch(u, o) });
      if (!got.ok) return salesFailed(got.reason);
      await dbCall("salesSave", { account, from: periods[i].from, to: periods[i].to, keepFrom: p.keepFrom, rows: got.rows }, { timeoutMs: 120000 });
      await salesSetMeta({ done: i + 1 });
    }
    await salesSetMeta({ state: "ready", syncedAt: Date.now(), lastError: "" });
    salesCheckUnmatched(p.keepFrom).catch(() => {});
    return { ok: true };
  } catch (e) {
    return salesFailed((e && e.code) || "internal_error");
  } finally {
    stopAwake();
  }
}

async function salesFailed(reason) {
  await salesSetMeta({ state: "failed", lastError: reason || "failed" });
  return { ok: false, reason };
}

async function salesCheckUnmatched(fromDay) {
  const r = await dbCall("bestSellers", { from: fromDay, marketplace: "", limit: 1 });
  if (!r || !r.unmatched || !r.unmatched.length) return;
  const last = (await chrome.storage.local.get({ [SALES_EXTRA_SYNC_KEY]: 0 }))[SALES_EXTRA_SYNC_KEY] || 0;
  if (Date.now() - last < SALES_STALE_MS || merchEngine.isRunning()) return;
  await chrome.storage.local.set({ [SALES_EXTRA_SYNC_KEY]: Date.now() });
  merchSync({ auto: true }).catch(() => {});
}

async function salesView() {
  const m = (await chrome.storage.local.get({ [SALES_META_KEY]: {} }))[SALES_META_KEY] || {};
  const stuck = m.state === "loading" && !salesRunning && Date.now() - (m.updatedAt || 0) > 2 * 60 * 1000;
  return { state: m.state || "idle", done: m.done || 0, total: m.total || 0, syncedAt: m.syncedAt || 0, error: m.state === "failed" ? m.lastError || "" : "", stuck };
}

async function salesEnsure(force) {
  if (salesRunning) return;
  const v = await salesView();
  if (v.stuck || force || (v.state !== "loading" && v.state !== "failed" && Date.now() - v.syncedAt > SALES_STALE_MS)) salesSync().catch(() => {});
}

const SALES_DAYS = new Set([7, 30, 90, 365]);
async function bestSellers(m) {
  const days = SALES_DAYS.has(m.days) ? m.days : 30;
  const marketplace = Object.prototype.hasOwnProperty.call(MSALES.MARKETPLACES, m.marketplace) ? m.marketplace : "";
  await salesEnsure(m.retry === true);
  let r;
  try {
    r = await dbCall("bestSellers", { from: MSALES.addDays(MSALES.ptDay(Date.now()), -(days - 1)), marketplace, limit: 200 });
  } catch (e) {
    return { ok: false, error: (e && e.code) || "storage_unavailable", sales: await salesView() };
  }
  return {
    ok: true,
    days,
    marketplace,
    catalog: !!r.catalog,
    covered: !!r.coverage,
    designs: (r.designs || []).map((d) => ({ key: d.key, units: d.units, asin: d.asin, marketplace: d.marketplace, marketplaces: d.marketplaces, listings: d.listings })),
    total: r.total || 0,
    sales: await salesView(),
  };
}

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
  } catch (e) {  }
  const tab = await chrome.tabs.create({ url: `${EBAY_ORIGIN}/`, active: false, ...(sender?.tab?.index != null ? { index: sender.tab.index + 1 } : {}), ...(sender?.tab?.windowId != null ? { windowId: sender.tab.windowId } : {}) });
  const loaded = await new Promise((resolve) => {
    const done = (v) => { chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(timer); resolve(v); };
    const onUpd = (id, info) => { if (id === tab.id && info.status === "complete") done(true); };
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
  void signedOut;
  if (signedIn) await ebayClearSignedOut();
  return { ok: true, session: signedIn ? "signed_in" : "unknown" };
}

const JOBS_KEY = "eifAmazonJobs";
const JOB_TTL_MS = 30 * 60 * 1000;
const KEEP_AFTER_MS = 2 * 60 * 60 * 1000;
const LEASE_MS = 2 * 60 * 1000;
const TERMINAL = new Set(["cancelled", "expired", "submitted_by_user"]);
let jobsLock = Promise.resolve();
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
  const { reporter, runner, ...rest } = job;
  return rest;
}

function reportSiteOf(url) {
  try {
    const u = new URL(url || "");
    const mp = AZ.marketplaceOfHost(u.hostname);
    return u.protocol === "https:" && mp && AZ.canReport(mp) && /^\/report\/infringement\/?$/.test(u.pathname) ? mp : null;
  } catch (e) {
    return null;
  }
}
function isReportTab(sender, job) {
  const mp = reportSiteOf(sender.tab.url || sender.url);
  return !!mp && (!job || mp === (AZ.normalizeMarketplace(job.marketplace) || "US"));
}

const jobOpenInFlight = new Map();
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
  })().finally(() => jobOpenInFlight.delete(rid));
  jobOpenInFlight.set(rid, p);
  return p;
}

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
  if (!marketplace || !AZ.canReport(marketplace) || !targets.length || targets.length > AZ.TARGET_LIMIT || !original || targets.includes(original)) return { error: "invalid-job" };
  if (!AZ.ISSUES[input.issue] || !String(input.description || "").trim() || AZ.validateReporter(input.reporter).length) return { error: "invalid-job" };
  const basis = input.ownershipBasis === "catalog_matched" ? "catalog_matched" : "self_declared";
  const check = await merchLookup([original, ...targets].map((asin) => ({ asin, marketplace })), true);
  const res = (a) => (check.results || {})[`${marketplace}|${a}`] || { state: "unknown" };
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
    if (!isReportTab(sender, job)) return { error: "wrong-page" };
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

importScripts("license-verify.js", "license-store.js", "license-service.js");
const LV = self.EifLicenseVerify;
const licenseService = self.EifLicenseService.create({
  verify: LV,
  publicKey: () => LV.reconstructPinnedKey(),
  subtle: self.crypto && self.crypto.subtle,
  fetch: (url, opts) => fetch(url, opts),
  store: self.EifLicenseStore.create(self.indexedDB),
  onChange: (st) => {
    licenseStatusRev++;
    chrome.storage.local.set({ eifLicenseStatus: { rev: licenseStatusRev, ok: st.ok === true } }).catch(() => {});
  },
});
let licenseStatusRev = 0;

const licenseReady = (async () => {
  let legacy = {};
  try {
    const d = await chrome.storage.local.get({ eifLicense: null, eifLicenseFp: "" });
    legacy = { key: d.eifLicense && typeof d.eifLicense.key === "string" ? d.eifLicense.key : "", fingerprint: typeof d.eifLicenseFp === "string" ? d.eifLicenseFp : "" };
  } catch (e) {}
  await licenseService.init(legacy);
  try { await chrome.storage.local.remove(["eifLicense", "eifLicenseFp"]); } catch (e) {}
})().catch(() => {});

const MESSAGES_ALARM = "eif-messages";
if (chrome.alarms) {
  chrome.alarms.get("eif-license", (a) => { if (!a) chrome.alarms.create("eif-license", { periodInMinutes: 30 }); });
  chrome.alarms.get(MESSAGES_ALARM, (a) => { if (!a) chrome.alarms.create(MESSAGES_ALARM, { delayInMinutes: 1, periodInMinutes: 60 }); });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === MESSAGES_ALARM) fetchMessages().catch(() => {});
    if (a.name === "eif-license") licenseReady.then(() => licenseService.authorize()).catch(() => {});
    if (a.name === MERCH_RESUME_ALARM) merchResumeIfInterrupted();
    if (a.name === EBAY_RESUME_ALARM) ebayResumeIfInterrupted();
    if (a.name === EBAY_DAILY_ALARM) ebayDailySync();
  });
  chrome.alarms.create(EBAY_DAILY_ALARM, { delayInMinutes: 5, periodInMinutes: 6 * 60 });
}
let gateShown = false;
const appGuard = (function () {
  const BUILT_FOR_STORE = false;
  const ref = "lpipaodhlgeakmanm" + "lmgjhicbhbnhklk";
  const genuine = (me) => chrome.runtime.id === ref && !!me && me.installType !== "development" && me.installType !== "sideload";
  const p = !BUILT_FOR_STORE ? Promise.resolve(true) : new Promise((resolve) => {
    try { chrome.management.getSelf((me) => resolve(chrome.runtime.lastError ? chrome.runtime.id === ref : genuine(me))); }
    catch (e) { resolve(chrome.runtime.id === ref); }
  });
  p.then(async (ok) => {
    if (ok) return;
    try { await licenseReady; await self.EifLicenseStore.create(self.indexedDB).deleteLicense(); } catch (e) {}
    chrome.storage.local.set({ eifLicenseStatus: { rev: Date.now(), ok: false } }).catch(() => {});
  });
  return p;
})();
const GATE_MSG = { ok: false, code: "NOT_STORE_COPY", message: "This copy of Copycat Hunt isn't the one from the Chrome Web Store. Install it from the Chrome Web Store to use it." };
async function showGate() {
  if (gateShown || (await appGuard)) return;
  gateShown = true;
  chrome.tabs.create({ url: chrome.runtime.getURL("info.html"), active: true }).catch(() => {});
}
chrome.runtime.onInstalled && chrome.runtime.onInstalled.addListener(showGate);
chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(showGate);

chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(() => {
  licenseReady.then(() => licenseService.authorize()).catch(() => {});
  merchResumeIfInterrupted();
  ebayResumeIfInterrupted();
});
setTimeout(() => { catalogReady().then(() => merchSummarize(true)); }, 1000);
setTimeout(() => { merchResumeIfInterrupted(); ebayResumeIfInterrupted(); }, 3000);
setTimeout(async () => { try { await licenseReady; if ((await salesView()).stuck && (await licenseService.authorize()).ok) salesSync().catch(() => {}); } catch (e) {} }, 5000);

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
  if (!(await appGuard)) { showGate(); return { ok: false, gate: true }; }
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
    let account = d[MERCH_CATALOG_KEY] && Array.isArray(d[MERCH_CATALOG_KEY].products) ? d[MERCH_CATALOG_KEY].accountId : "";
    if (!d[SETUP_KEY] && !account) {
      const loaded = await merchLoadCatalog();
      account = loaded ? loaded.catalog.accountId : "";
    }
    if (!d[SETUP_KEY] && account) {
      await chrome.storage.local.set({ [SETUP_KEY]: { state: "complete", merch: "done", ebay: null, completedAt: Date.now(), account: MC.maskId(account), version: chrome.runtime.getManifest ? chrome.runtime.getManifest().version : "", migrated: true } });
      return;
    }
    if (details.reason === "install" && !d[SETUP_KEY]) await openSetupTab({ active: true });
  } catch (e) {}
});

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
    license: { ok: !!license.ok, code: license.code, message: license.message, expiry: license.ok ? license.expiry || null : null },
    identity,
    storage,
    ebay: { run: eb.run, catalog: eb.catalog, session: ebayId ? (ebayId.state === "verified" ? "signed_in" : ebayId.state === "logged_out" ? "signed_out" : "unknown") : "unchecked", reason: (ebayId && ebayId.reason) || "", account: ebayId && ebayId.accountId ? EC.maskId(ebayId.accountId) : "" },
    run,
    sales: await salesView(),
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

let setupEbayCheckedAt = 0;
async function setupEbayCheck(force) {
  const d = await chrome.storage.local.get({ [SETUP_KEY]: null });
  const cur = setupView(d[SETUP_KEY]);
  if (cur.ebay === "signed_in") return { ok: true, session: "signed_in" };
  if (cur.ebayMode !== "seller" && cur.ebayMode !== "account") return { ok: true, session: "unchecked", reason: "not_asked" };
  if (!force && Date.now() - setupEbayCheckedAt < 60000) return { ok: true, session: "unknown", throttled: true };
  setupEbayCheckedAt = Date.now();
  let id;
  try { id = await ebayGetIdentity(true); } catch (e) { id = { state: "error", reason: "network" }; }
  const signedIn = id.state === "verified" || (cur.ebayMode === "account" && id.state === "error" && id.reason === "not_seller_hub");
  if (signedIn && cur.ebay !== "skipped") await setupPatch({ ebay: "signed_in" });
  return { ok: true, session: signedIn ? "signed_in" : id.state === "logged_out" ? "signed_out" : "unknown", reason: signedIn ? "" : id.reason || "" };
}

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
  if (step === "merch") return { ok: false, error: "merch-required" };
  return setupEbayMode({ mode: msg.undo === true ? null : "none" });
}

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

async function setupFinish(msg, sender) {
  const d = await chrome.storage.local.get({ [SETUP_KEY]: null });
  const done = d[SETUP_KEY] && d[SETUP_KEY].state === "complete";
  if (!done && msg.skip !== true) return { ok: false, error: "not-complete" };
  const setups = await setupTabs();
  let tool = null;
  try {
    const tabs = await chrome.tabs.query({ url: [...AMAZON_HOSTS.map((h) => `https://${h}/*`), "https://www.ebay.com/*"] });
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

const API_BASE = "https://api.copycathunt.com";
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
    if (res.status === 401 && j && j.reason === "stale" && attempt === 0) continue;
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

const SCORE_TIMEOUT_MS = 70000;
const SCORE_HOSTS = ["m.media-amazon.com", "i.ebayimg.com"];
const scoreUrlOk = (u) => {
  if (typeof u !== "string" || u.length > 2048) return false;
  try { const x = new URL(u); return x.protocol === "https:" && SCORE_HOSTS.includes(x.hostname); } catch (e) { return false; }
};
const SCORE_SIGNALS = ["validHomography", "edgeTilesMatched", "edgeTilesCounted", "edgeTileRecallMin", "edgeF1", "orbInliers", "coverageOriginal", "phashDistance", "drawingValid", "drawingTilesMatched", "drawingTilesCounted", "drawingTileRecallMin", "textValid", "textTilesMatched", "textTilesCounted", "artPixelDiff", "clipSim", "dinoSim", "sameIdea"];

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
      return ctrl.signal.aborted ? { error: "busy", retryAfter: 5 } : { error: "server-unreachable" };
    } finally {
      clearTimeout(timer);
    }
    if (text.length > API_MAX_REPLY) return { error: "server" };
    let j = null;
    try { j = JSON.parse(text); } catch (e) {}
    const retryAfter = j && Number.isFinite(j.retryAfter) ? Math.min(60, Math.max(1, Math.round(j.retryAfter))) : 10;
    if (res.status === 401 && j && j.reason === "stale" && attempt === 0) continue;
    if (res.status === 401) return { error: "license-server" };
    if (res.status === 403 && j && j.error === "scorer-not-approved") {
      await scorerOff();
      scorerAccess({}).catch(() => {});
      return { error: "not-approved" };
    }
    if (res.status === 429) return { error: "busy", retryAfter };
    if (res.status === 422) return { error: "design", reason: j && typeof j.reason === "string" ? j.reason.slice(0, 40) : "" };
    if (!res.ok || !j || j.ok !== true || !Array.isArray(j.results)) return j && j.error === "scorer-busy" ? { error: "busy", retryAfter } : { error: "server" };
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

async function scorerOff() {
  const d = await chrome.storage.local.get({ eifPrefs: {} });
  if (d.eifPrefs && d.eifPrefs.scorer) await chrome.storage.local.set({ eifPrefs: { ...d.eifPrefs, scorer: false } });
}

const SCORER_STATES = ["none", "requested", "approved", "revoked"];
async function scorerAccess(msg) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const evidence = await licenseService.serverEvidence({ force: !!msg.force || attempt === 1 });
    if (!evidence) return { error: "license" };
    let res, j = null;
    try {
      res = await fetch(`${API_BASE}/v1/scorer/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evidence, ask: msg.ask === true }),
        credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      const text = await res.text();
      if (text.length <= API_MAX_REPLY) j = JSON.parse(text);
    } catch (e) {
      if (!res) return { error: "server-unreachable" };
    }
    if (res.status === 401 && j && j.reason === "stale" && attempt === 0) continue;
    if (res.status === 401) return { error: "license-server" };
    if (!res.ok || !j || !SCORER_STATES.includes(j.status)) return { error: "server" };
    await chrome.storage.local.set({ eifScorerAccess: { status: j.status, at: Date.now() } });
    if (j.status !== "approved") await scorerOff();
    return { status: j.status };
  }
  return { error: "license-server" };
}

const MESSAGE_KINDS = ["info", "maintenance", "price"];
function versionAtMost(v, max) {
  const a = String(v).split(".").map(Number), b = String(max).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  return true;
}
function cleanMessage(m, version) {
  const s = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  if (!m || typeof m !== "object" || !s(m.id, 64) || !MESSAGE_KINDS.includes(m.kind) || !s(m.title, 80) || !Number.isFinite(m.startsAt)) return null;
  const maxVersion = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(m.maxVersion || "") ? m.maxVersion : "";
  if (maxVersion && !versionAtMost(version, maxVersion)) return null;
  const link = /^https:\/\/[^\s"<>]{1,300}$/.test(m.link || "") ? m.link : "";
  return {
    id: m.id, kind: m.kind, title: s(m.title, 80), body: s(m.body, 300), link, linkText: link ? s(m.linkText, 30) || "Read more" : "",
    startsAt: m.startsAt, endsAt: Number.isFinite(m.endsAt) ? m.endsAt : null, live: m.live === true,
  };
}
async function paintMessagesBadge() {
  const d = await chrome.storage.local.get({ eifMessages: null, eifMessagesRead: [] });
  const read = new Set(Array.isArray(d.eifMessagesRead) ? d.eifMessagesRead : []);
  const n = (d.eifMessages && Array.isArray(d.eifMessages.items) ? d.eifMessages.items : []).filter((m) => m && !read.has(m.id)).length;
  await chrome.action.setBadgeText({ text: n > 9 ? "9+" : n ? String(n) : "" });
  if (!n) return;
  await chrome.action.setBadgeBackgroundColor({ color: "#2ee6a6" });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: "#08251a" });
}
if (chrome.storage.onChanged) chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && (ch.eifMessages || ch.eifMessagesRead)) paintMessagesBadge().catch(() => {}); });
paintMessagesBadge().catch(() => {});

let messagesTried = 0;
async function fetchMessages(msg) {
  const maxAge = (msg && msg.maxAge) || 0;
  if (maxAge) {
    const { eifMessages } = await chrome.storage.local.get({ eifMessages: null });
    if (Date.now() - Math.max(messagesTried, (eifMessages && eifMessages.at) || 0) < maxAge) return { ok: true, cached: true };
  }
  messagesTried = Date.now();
  try {
    const res = await fetch(`${API_BASE}/v1/announcements?history=1`, { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok || text.length > API_MAX_REPLY) return { error: "server" };
    const j = JSON.parse(text);
    if (!j || !Array.isArray(j.items)) return { error: "server" };
    const version = chrome.runtime.getManifest().version;
    const items = j.items.slice(0, 50).map((m) => cleanMessage(m, version)).filter(Boolean).sort((a, b) => b.startsAt - a.startsAt);
    const { eifMessagesRead } = await chrome.storage.local.get({ eifMessagesRead: null });
    await chrome.storage.local.set({ eifMessages: { items, at: Date.now() }, ...(Array.isArray(eifMessagesRead) ? {} : { eifMessagesRead: items.filter((m) => !m.live).map((m) => m.id) }) });
    return { ok: true };
  } catch (e) {
    return { error: "server-unreachable" };
  }
}

const REPAIR_STUCK_MS = 10 * 60 * 1000;
async function repairExtension() {
  const lines = [];
  const add = (ok, text) => lines.push({ ok, text });
  const setupNow = setupView((await chrome.storage.local.get({ [SETUP_KEY]: null }))[SETUP_KEY]);

  ebayIdentityCache = null;
  ebayIdentityTabAt = 0;
  merchIdentity = null;
  catalogMetaCache.merch = null;
  catalogMetaCache.ebay = null;
  const signedOut = {};
  try {
    const m = await merchGetIdentity(true);
    const connected = setupNow.merch === "done";
    if (m && m.state === "verified") add(true, "Merch: signed in.");
    else if (!connected) add("info", "Merch: not connected yet (step 2 of setup).");
    else if (m && m.state === "logged_out") { signedOut.merch = true; add(false, "Merch: signed out. Open merch.amazon.com and sign in, then sync."); }
    else add(false, "Merch: couldn't check the sign-in right now.");
  } catch (e) {
    add(setupNow.merch === "done" ? false : "info", setupNow.merch === "done" ? "Merch: couldn't check the sign-in right now." : "Merch: not connected yet (step 2 of setup).");
  }
  try {
    const mode = setupNow.ebayMode;
    if (!mode) add("info", "eBay: not set up yet (last step of setup).");
    else if (mode === "account") add(true, "eBay: no listings to sync (you said you don't sell on eBay).");
    else if (mode === "none") add(true, "eBay: not connected (you said you don't have an eBay account).");
    else {
      const e = await ebayGetIdentity(true);
      if (e && e.state === "verified") { add(true, "eBay: signed in."); await ebayClearSignedOut(); }
      else if (e && e.state === "logged_out") { signedOut.ebay = true; await ebaySetMeta({ lastError: "signed_out" }); add(false, "eBay: signed out. Sign in to eBay, then sync your listings."); }
      else add(false, "eBay: couldn't check the sign-in. Open an eBay tab and try again.");
    }
  } catch (e) {
    add(false, "eBay: couldn't check the sign-in right now.");
  }

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

  try {
    await withJobs(() => {});
    add(true, "Old Amazon report jobs cleared.");
  } catch (e) {
    add(false, "Amazon report jobs couldn't be checked.");
  }

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

function senderContext(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return null;
  let u;
  try { u = new URL(sender.url || ""); } catch (e) { return null; }
  if (u.protocol === "chrome-extension:" && u.host === chrome.runtime.id) {
    if (u.pathname === "/popup.html") return "popup";
    if (u.pathname === "/setup.html" && sender.tab && sender.frameId === 0) return "setup";
    return null;
  }
  if (!sender.tab || sender.frameId !== 0 || u.protocol !== "https:") return null;
  if (sender.origin && sender.origin !== u.origin) return null;
  if (reportSiteOf(u.href)) return "report";
  if (u.hostname === "www.ebay.com" || AMAZON_HOSTS.includes(u.hostname)) return "page";
  if (u.hostname === "merch.amazon.com") return "merch";
  return null;
}

const MAX_IMAGE_B64 = 12 * 1024 * 1024;
const isStr = (v, max) => typeof v === "string" && v.length <= max;
const isB64Image = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_IMAGE_B64 && /^[A-Za-z0-9+/=]+$/.test(v);

async function openMenuPopup(tab) {
  try {
    if (tab && tab.id != null) await chrome.action.setPopup({ tabId: tab.id, popup: "popup.html" });
    await chrome.action.openPopup(tab && tab.windowId != null ? { windowId: tab.windowId } : undefined);
    return true;
  } catch (e) { return false; }
}
chrome.action && chrome.action.onClicked && chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  const r = await new Promise((resolve) => chrome.tabs.sendMessage(tab.id, { type: "eif-menu-toggle" }, (res) => resolve(chrome.runtime.lastError ? null : res)));
  if (!r || !r.ok) await openMenuPopup(tab);
});
chrome.action && chrome.tabs.onUpdated && chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") chrome.action.setPopup({ tabId, popup: "" }).catch(() => {});
});

const ROUTES = {
  "eif-license-status": { from: ["popup", "page", "report", "setup"], license: false, run: async (msg, sender, ctx) => { await licenseReady; return licenseService.status(ctx === "popup"); } },
  "eif-license-activate": { from: ["popup", "setup"], license: false, run: async (msg) => {
    if (!isStr(msg.key, 1024)) return { ok: false, error: "bad-key", message: "That doesn't look like a license key." };
    await licenseReady;
    return licenseService.activate(msg.key);
  } },
  "eif-license-recheck": { from: ["popup"], license: false, run: async () => { await licenseReady; return licenseService.recheck({ force: true }); } },
  "eif-repair": { from: ["popup"], license: false, run: () => repairExtension() },
  "eif-restart": { from: ["popup"], license: false, run: () => { setTimeout(() => chrome.runtime.reload(), 150); return { ok: true }; } },
  "eif-license-open-menu": { from: ["page", "setup"], license: false, run: async (msg, sender) => ({ ok: await openMenuPopup(sender.tab) }) },
  "eif-amazon-asins": { from: ["page"], license: true, run: (m) => amazonAsinDetails(m.asins, mpOf(m.marketplace)) },
  "eif-amazon-search": { from: ["page"], license: true, run: (m) => (isB64Image(m.base64) ? amazonSearch(m.base64, ["image/jpeg", "image/png", "image/webp"].includes(m.mime) ? m.mime : "image/jpeg", mpOf(m.marketplace)) : { error: "invalid-image" }) },
  "eif-amazon-dfa": { from: ["page"], license: true, run: (m) => amazonFirstAvailable(m.asin) },
  "eif-amazon-listing": { from: ["page"], license: true, run: (m) => amazonListing(m.asin, m.refresh === true, m.priority === "high", mpOf(m.marketplace)) },
  "eif-amazon-keywords": { from: ["page"], license: true, run: (m) => (isStr(m.query, 2000) ? amazonKeywordSearch(m.query, 150, mpOf(m.marketplace)) : { error: "empty" }) },
  "eif-amazon-job-open": { from: ["page"], license: true, run: (m) => openAmazonJobOnce(m.job) },
  "eif-amazon-job-list": { from: ["page"], license: true, run: () => listAmazonJobs() },
  "eif-amazon-job-claim": { from: ["report"], license: true, run: (m, s) => claimAmazonJob(isStr(m.jobId, 64) ? m.jobId : "", s) },
  "eif-amazon-job-update": { from: ["report"], license: true, run: (m, s) => updateAmazonJob(m, s) },
  "eif-amazon-job-finish": { from: ["report", "page"], license: false, run: (m, s, ctx) => finishAmazonJob(isStr(m.jobId, 64) ? m.jobId : "", m.how === "submitted" ? "submitted" : "cancel", s, ctx) },
  "eif-text-compare": { from: ["page"], license: true, run: (m) => apiCompare(m) },
  "eif-image-score": { from: ["page"], license: true, run: (m) => apiImageScore(m) },
  "eif-scorer-access": { from: ["popup"], license: false, run: async (m) => { await licenseReady; return scorerAccess({ ask: m.ask === true, force: m.force === true }); } },
  "eif-messages": { from: ["popup", "page", "merch"], license: false, run: (m, s, ctx) => fetchMessages({ maxAge: ctx === "popup" ? 60e3 : 15 * 60e3 }) },
  "eif-merch-status": { from: ["page"], license: true, run: () => merchStatus() },
  "eif-merch-sync": { from: ["page"], license: true, run: () => merchCoordinator.ensure(true) },
  "eif-merch-ensure": { from: ["page"], license: true, run: () => merchCoordinator.ensure() },
  "eif-setup-status": { from: ["setup"], license: false, run: () => setupStatus() },
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
  "eif-setup-rebuild-db": { from: ["setup"], license: false, run: async () => { const r = await catalogRebuild(); return { ...(await setupStatus()), rebuild: r }; } },
  "eif-setup-recheck": { from: ["setup"], license: true, run: async () => { await merchGetIdentity(true); return setupStatus(); } },
  "eif-setup-sales-retry": { from: ["setup"], license: true, run: async () => { await salesEnsure(true); return setupStatus(); } },
  "eif-setup-finish": { from: ["setup"], license: false, run: (m, s) => setupFinish(m, s) },
  "eif-setup-ebay-start": { from: ["setup"], license: true, run: async (m) => {
    const d = await chrome.storage.local.get({ [SETUP_KEY]: null });
    if (setupView(d[SETUP_KEY]).ebayMode !== "seller") return { ok: false, error: "not_seller" };
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
  "eif-ebay-own-lookup": { from: ["page", "popup"], license: false, run: (m) => (Array.isArray(m.items) && m.items.length <= 500 ? ebayOwnLookup(m.items) : { error: "invalid" }) },
  "eif-ebay-sync": { from: ["page"], license: true, run: async () => {
    const d = await chrome.storage.local.get({ [SETUP_KEY]: null });
    if (setupView(d[SETUP_KEY]).ebayMode !== "seller") return { ok: false, error: "not_seller" };
    const r = await merchBegin((onBegin) => ebayEngine.start({ kind: "sync", onBegin }), ebayEngine);
    if (r && (r.state === "syncing" || r.state === "finalizing" || r.state === "complete")) return r;
    const m = (await chrome.storage.local.get({ [EBAY_META_KEY]: {} }))[EBAY_META_KEY] || {};
    const why = m.lastError || (r && r.error) || "";
    return { ...(r || {}), ok: false, error: r && r.state === "needs_login" ? "signed_out" : why || "failed" };
  } },
  "eif-setup-ebay-check": { from: ["setup"], license: true, run: async (m) => { await setupEbayCheck(m.force === true); return setupStatus(); } },
  "eif-setup-skip": { from: ["setup"], license: false, run: async (m) => { const r = await setupSkip(m); const st = await setupStatus(); return { ...st, skip: r }; } },
  "eif-setup-ebay-mode": { from: ["setup"], license: false, run: async (m) => { const r = await setupEbayMode(m); const st = await setupStatus(); return { ...st, mode: r }; } },
  "eif-setup-ebay-seen": { from: ["page"], license: false, run: (m, s) => (s && isEbayUrl(s.url || (s.tab && s.tab.url) || "") ? setupEbaySeen() : { ok: false, error: "not-allowed" }) },
  "eif-merch-open-setup": { from: ["page", "popup"], license: false, run: (m, s) => openSetupTab({ active: true, from: s }) },
  "eif-best-sellers": { from: ["page"], license: true, run: (m) => bestSellers({ days: Number(m.days), marketplace: String(m.marketplace || ""), retry: m.retry === true }) },
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
    if (!(await appGuard)) {
      const g = { ...GATE_MSG, gate: true };
      if (msg.type === "eif-license-status" || msg.type === "eif-setup-status") return { ...g, hasKey: false, name: "", expiry: null, checkFailed: false, canRecheck: false };
      if (msg.type === "eif-license-activate" || msg.type === "eif-license-recheck") return { ...g, error: "locked" };
      return { error: "license", code: GATE_MSG.code, message: GATE_MSG.message, gate: true };
    }
    if (route.license) await requireLicense();
    return route.run(msg, sender, ctx);
  })()
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse(e && e.license ? { error: "license", code: e.license.code, message: e.license.message } : { error: "failed" }));
  return true;
});
