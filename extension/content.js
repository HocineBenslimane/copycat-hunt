(function () {
  "use strict";

  if (window.top !== window) return;

  const discovered = new Map();
  const hunts = new Map();
  const trackedItems = new Map();
  const amazonTracked = new Map();
  let amzBase = {};
  let amzMineBase = [];
  let amzSaveChain = Promise.resolve();
  const amazonMine = new Set();
  const protectedItems = new Set();
  const ebayOwnItems = new Set();
  const ebayOwnAsked = new Set();
  const ebayOwnQueue = new Set();
  let ebayOwnTimer = 0;
  let ebayOwnRevision = null;
  let ebaySyncedCount = 0;
  const isMineEbay = (n) => {
    if (!n) return false;
    if (protectedItems.has(n) || ebayOwnItems.has(n)) return true;
    ebayOwnAsk(n);
    return false;
  };
  const mineEbayCount = () => { let n = protectedItems.size + ebaySyncedCount; protectedItems.forEach((x) => { if (ebayOwnItems.has(x)) n--; }); return Math.max(n, protectedItems.size); };
  const priceAnchors = new WeakSet();
  const badgedInfo = new Map();

  const hasStorage =
    typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

  function normalizeItemNumber(value) {
    const text = String(value || "").trim();
    return /^[0-9]{6,15}$/.test(text) ? text : null;
  }

  const SITE = /(^|\.)amazon\.(com|co\.uk|de|fr|it|es)$/i.test(location.hostname) ? "amazon" : "ebay";
  const EBAY = SITE === "ebay" ? location.origin : "https://www.ebay.com";
  const PAGE_MP = (window.EifAmazonReport && window.EifAmazonReport.marketplaceOfHost(location.hostname)) || "US";
  const asinMarket = new Map();
  function mpOfAsin(asin) {
    const m = amazonTracked.get(asin);
    return (m && m.marketplace) || asinMarket.get(asin) || PAGE_MP;
  }
  const dkey = (asin) => `${mpOfAsin(asin)}|${asin}`;
  const amzUrl = (asin) => window.EifAmazonReport.productUrl(mpOfAsin(asin), asin) || `https://www.amazon.com/dp/${asin}`;

  function currentPageItemNumber() {
    if (SITE !== "ebay") return null;
    const match = location.pathname.match(/\/itm\/(?:[^/]+\/)?([0-9]{6,15})(?:[/?#]|$)/);
    return match ? match[1] : null;
  }

  function currentPageAsin() {
    if (SITE !== "amazon") return null;
    const m = location.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?#]|$)/i);
    return m ? m[1].toUpperCase() : null;
  }

  function bgSend(msg) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage || !chrome.runtime.id) return resolve(null);
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return resolve(null);
          if (res && res.error === "license" && msg.type !== "eif-license-status") setTimeout(refreshLicense, 0);
          resolve(res || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  let ebayRequestState = null;
  let ebaySessionState = null;
  let ebayRecoveryRequest = null;
  let ebayRecovering = false;
  let ebayLastRecoveryAt = 0;
  const ebayRetries = new Map();

  function retryAfterEbayPause(error, key, run, valid = () => true) {
    if (error?.code === "EBAY_PAUSED") ebayRetries.set(key, { run, valid });
  }

  async function recoverEbay(manual = false) {
    if (ebayRecovering || navigator.onLine === false) return;
    if (!manual && Date.now() - ebayLastRecoveryAt < 10000) return;
    ebayRecovering = true;
    ebayLastRecoveryAt = Date.now();
    try {
      const status = await bgSend({ type: "eif-ebay-status" });
      if (!status) return;
      ebayRequestState = status;
      renderEbayPause();
      if (status.paused && status.until > Date.now()) return;
      const result = status.paused ? await bgSend({ type: "eif-ebay-resume", probe: ebayRecoveryRequest }) : { ok: true, ...status };
      if (!result?.ok) {
        if (result?.paused) ebayRequestState = result;
        renderEbayPause();
        if (manual) showToast(result?.error === "recovery-needed" ? "Run the interrupted search again to check its connection." : result?.paused ? ebayPauseMessage(result) : "Could not check eBay. Try again.");
        return;
      }
      ebayRequestState = result;
      ebayRecoveryRequest = null;
      renderEbayPause();
      if (SITE === "ebay") {
        const session = await bgSend({ type: "eif-ebay-session" });
        ebaySessionState = session?.session === "signed_in" ? true : session?.session === "signed_out" ? false : null;
      }
      const retries = [...ebayRetries.values()];
      ebayRetries.clear();
      for (let index = 0; index < retries.length; index++) {
        const retry = retries[index];
        if (!retry.valid()) continue;
        await retry.run();
        if (ebayRequestState?.paused) {
          retries.slice(index + 1).forEach((pending, offset) => ebayRetries.set(`pending-${offset}`, pending));
          break;
        }
      }
      refreshWidgetSub();
      if (SITE === "ebay" && popup) switchTab(popup.tab);
      if (manual && !ebayRequestState?.paused) showToast("eBay connection restored.");
    } finally { ebayRecovering = false; }
  }

  const EBAY_QUIET_RETRY_MS = 15000;
  function ebayLog(what, msg, reply, ms) {
    try {
      const where = msg.type === "eif-ebay-visual" ? "image upload" : String(msg.url || "").replace(/^https:\/\/www\.ebay\.com/, "").slice(0, 80);
      console.info(`[Copycat Hunt] eBay ${what}: ${where} → ${reply ? reply.error || reply.status || "ok" : "no reply"}${reply && reply.cached ? " (cached)" : ""} · ${ms} ms`);
    } catch (e) {}
  }
  let setupEbayMode = null;
  let setupEbayConnected = false;
  const readSetupEbay = (v) => {
    v = v && typeof v === "object" ? v : {};
    setupEbayMode = v.ebayMode || (v.ebay === "skipped" ? "none" : null);
    setupEbayConnected = v.ebay === "signed_in";
  };
  if (hasStorage) {
    chrome.storage.local.get({ eifSetup: null }, (d) => readSetupEbay(d && d.eifSetup));
    chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.eifSetup) readSetupEbay(ch.eifSetup.newValue); });
  }
  function ebayBlockedForAmazonHunt() {
    if (SITE !== "amazon") return "";
    if (setupEbayMode === "none") return "no-account";
    if ((setupEbayMode === "seller" || setupEbayMode === "account") && !setupEbayConnected) return "not-connected";
    return "";
  }
  function noteOpeningEbay() {
    const s = lastSearch;
    if (s && s.state === "loading") { s.message = "Opening eBay in the background…"; updateProgressUI(); }
  }

  let ebayTabOpening = null;
  async function ebayRequest(msg, probe) {
    const t0 = Date.now();
    let reply = await bgSend(msg);
    if (!reply || reply.error) ebayLog("request", msg, reply, Date.now() - t0);
    const userHunt = msg.type === "eif-ebay-visual" || msg.priority === "high";
    if (reply?.error === "needs-ebay-tab" && huntStoppedAt > t0) return readEbayReply(reply);
    if (reply?.error === "needs-ebay-tab" && userHunt && setupEbayMode !== "none") {
      noteOpeningEbay();
      if (!ebayTabOpening) ebayTabOpening = bgSend({ type: "eif-ebay-open-tab" }).finally(() => { ebayTabOpening = null; });
      const opened = await ebayTabOpening;
      if (huntStoppedAt > t0) return readEbayReply(reply);
      if (opened && opened.ok) {
        const t1 = Date.now();
        reply = await bgSend(msg);
        ebayLog("from an eBay tab", msg, reply, Date.now() - t1);
      }
    }
    if (reply?.error === "needs-ebay-tab") {
      await new Promise((r) => setTimeout(r, EBAY_QUIET_RETRY_MS));
      const t1 = Date.now();
      reply = await bgSend(msg);
      ebayLog("second try", msg, reply, Date.now() - t1);
    }
    if (reply?.error === "ebay-paused" && (reply.status || !ebayRecoveryRequest)) ebayRecoveryRequest = probe;
    return readEbayReply(reply);
  }

  function ebayPauseMessage(state) {
    if (state.reason === "rate_limited" || state.reason === "service_unavailable") {
      const seconds = Math.max(0, Math.ceil((state.until - Date.now()) / 1000));
      return `${state.reason === "rate_limited" ? "eBay is limiting requests." : "eBay's service is temporarily unavailable."} ${seconds ? `Wait at least ${seconds} seconds. ` : ""}The tool checks again when you return; Resume also retries.`;
    }
    if (state.reason === "signin") return "Sign in to eBay in this browser. The tool checks again when you return; Resume also retries.";
    if (state.reason === "captcha") return "eBay wants to check that you're a person. Copycat Hunt opened eBay in a tab: complete the check there yourself, then come back. The tool checks again when you return; Resume also retries.";
    if (state.reason === "access_denied") return "eBay denied this request. A working homepage may not mean this search is available. Return from eBay or press Resume to check again.";
    if (state.reason === "network" || state.reason === "timeout") return "Couldn't reach eBay. Return or press Resume to check the connection again.";
    return "This eBay request couldn't be completed. Return or press Resume to check again.";
  }

  function renderEbayPause() {
    const notice = popup?.overlay.querySelector("#eif-ebay-pause");
    if (!notice) return;
    notice.hidden = !ebayRequestState?.paused;
    if (notice.hidden) return;
    notice.querySelector("[data-ebay-pause-message]").textContent = ebayPauseMessage(ebayRequestState);
  }

  function readEbayReply(r) {
    if (r?.error === "ebay-paused") {
      ebayRequestState = r;
      renderEbayPause();
      const error = new Error(ebayPauseMessage(r));
      error.code = "EBAY_PAUSED";
      throw error;
    }
    if (r?.error === "needs-ebay-tab") {
      const error = new Error("eBay didn't answer this search from here, even on a second try. Press Try again in a minute, or open eBay in a tab and the search runs there.");
      error.code = "EBAY_NEEDS_TAB";
      throw error;
    }
    if (!r || r.error === "network" || r.error === "timeout") throw new TypeError(r?.error === "timeout" ? "eBay request timed out." : "Failed to fetch");
    if (r.error) throw new Error(r.error === "queue-full" ? "Too many eBay checks are queued. Wait for them to finish." : "That eBay page couldn't be read from here.");
    return { ok: r.ok, status: r.status, url: r.url, text: async () => r.text, json: async () => JSON.parse(r.text) };
  }

  async function ebayFetch(url, opts = {}) {
    const probe = { url: new URL(url, EBAY).href, method: opts.method || "GET" };
    return ebayRequest({ type: "eif-ebay-fetch", ...probe, ...(opts.priority === "high" ? { priority: "high" } : {}) }, probe);
  }

  function withDeadline(promise, ms, message) {
    let timer;
    const cap = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
    return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
  }
  const HUNT_STEP_MS = 90000;
  const HUNT_SLOW_MSG = "eBay took too long to answer. Press Try again.";

  if (hasStorage && chrome.storage.onChanged) chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.eifEbayRequestStateV1) {
      const was = ebayRequestState && ebayRequestState.paused;
      ebayRequestState = changes.eifEbayRequestStateV1.newValue || null;
      renderEbayPause();
      if (was && ebayRequestState && !ebayRequestState.paused && ebayRetries.size) recoverEbay(true);
    }
  });

  function ebayOwnAsk(n) {
    if (!n || ebayOwnAsked.has(n) || ebayOwnQueue.has(n) || !hasStorage) return;
    ebayOwnQueue.add(n);
    if (!ebayOwnTimer) ebayOwnTimer = setTimeout(ebayOwnFlush, 30);
  }
  async function ebayOwnRequest(list) {
    const res = await bgSend({ type: "eif-ebay-own-lookup", items: list });
    if (!res || !res.ok) {
      setTimeout(() => list.forEach((n) => ebayOwnAsked.delete(n)), 30000);
      return false;
    }
    if (ebayOwnRevision == null) ebayOwnRevision = res.revision || "";
    const own = new Set(res.own || []);
    let changed = false;
    list.forEach((n) => {
      if (own.has(n) && !ebayOwnItems.has(n)) { ebayOwnItems.add(n); changed = true; }
      else if (!own.has(n) && ebayOwnItems.has(n)) { ebayOwnItems.delete(n); changed = true; }
    });
    if (changed) {
      try { refreshAllBadges(); updatePanel(); } catch (e) {}
      if (popup && popup.tab === "mine") try { renderMineView(); } catch (e) {}
    }
    return true;
  }
  function ebayOwnFlush() {
    ebayOwnTimer = 0;
    const list = [...ebayOwnQueue].slice(0, 500);
    list.forEach((n) => { ebayOwnQueue.delete(n); ebayOwnAsked.add(n); });
    if (ebayOwnQueue.size) ebayOwnTimer = setTimeout(ebayOwnFlush, 0);
    if (list.length) ebayOwnRequest(list);
  }
  async function ebayOwnEnsure(items, timeoutMs = 4000) {
    const list = [...new Set(items.filter((n) => n && !ebayOwnAsked.has(n)))];
    if (!list.length || !hasStorage) return;
    list.forEach((n) => { ebayOwnQueue.delete(n); ebayOwnAsked.add(n); });
    const all = [];
    for (let i = 0; i < list.length; i += 500) all.push(ebayOwnRequest(list.slice(i, i + 500)));
    await Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, timeoutMs))]);
  }
  function applyEbayMeta(meta) {
    meta = meta && typeof meta === "object" ? meta : {};
    ebaySyncedCount = Number(meta.count) || 0;
    const rev = meta.revision || "";
    if (ebayOwnRevision != null && rev && rev !== ebayOwnRevision) {
      ebayOwnRevision = rev;
      const again = new Set([...ebayOwnAsked, ...ebayOwnItems]);
      ebayOwnAsked.clear();
      again.forEach((n) => ebayOwnAsk(n));
    }
  }
  function ebayOwnPrefetch() {
    trackedItems.forEach((meta, n) => { ebayOwnAsk(n); if (meta.source) ebayOwnAsk(meta.source); });
    badgedInfo.forEach((info) => ebayOwnAsk(info.itemNumber));
  }

  function applyStoredProtected(values) {
    protectedItems.clear();
    (Array.isArray(values) ? values : []).forEach((value) => {
      const itemNumber = normalizeItemNumber(value);
      if (itemNumber) protectedItems.add(itemNumber);
    });
  }

  function applyStoredTracked(obj) {
    trackedItems.clear();
    if (obj && typeof obj === "object") {
      Object.keys(obj).forEach((key) => {
        const itemNumber = normalizeItemNumber(key);
        if (!itemNumber) return;
        const meta = obj[key] || {};
        trackedItems.set(itemNumber, {
          title: String(meta.title || "Untitled listing"),
          url: String(meta.url || `https://www.ebay.com/itm/${itemNumber}`),
          image: String(meta.image || ""),
          price: String(meta.price || ""),
          seller: String(meta.seller || ""),
          kind: meta.kind === "hijack" ? "hijack" : "copycat",
          source: normalizeItemNumber(meta.source) || "",
          hunt: String(meta.hunt || ""),
          reportedAt: String(meta.reportedAt || ""),
          listedAt: String(meta.listedAt || ""),
        });
      });
    }
  }

  function loadState(done) {
    if (!hasStorage) {
      done();
      return;
    }
    chrome.storage.local.get({ eifProtectedItems: [], eifTrackedItems: {}, eifAmazonTracked: {}, eifAmazonMine: [], eifHunts: {}, eifEbayMeta: {}, eifMineNotes: {} }, (data) => {
      applyMineNotes(data.eifMineNotes);
      applyEbayMeta(data.eifEbayMeta);
      hunts.clear();
      Object.entries(data.eifHunts && typeof data.eifHunts === "object" ? data.eifHunts : {}).forEach(([k, v]) => v && hunts.set(k, v));
      applyStoredProtected(data.eifProtectedItems);
      applyStoredTracked(data.eifTrackedItems);
      applyStoredAmazon(data.eifAmazonTracked, data.eifAmazonMine);
      ebayOwnPrefetch();
      done();
    });
  }

  function huntKeyFor(search) {
    if (!search) return "";
    if (search.asin) return `amz:${search.asin}`;
    if (search.itemNumber) return `ebay:${search.itemNumber}`;
    return `img:${String(search.id || Date.now()).replace(/\D/g, "").slice(-12)}`;
  }

  function registerHunt(key, info) {
    if (!key) return;
    const prev = hunts.get(key) || {};
    const now = new Date().toISOString();
    hunts.set(key, { label: info.label || prev.label || "", image: prev.image || info.image || "", at: prev.at || now, last: now });
    saveHunts();
  }

  function saveHunts() {
    if (!hasStorage) return;
    const entries = [...hunts.entries()].sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, 300);
    chrome.storage.local.set({ eifHunts: Object.fromEntries(entries) });
  }

  function huntLabel(key) {
    const h = hunts.get(key) || {};
    if (h.label) return h.label;
    if (key.startsWith("amz:")) return `Amazon ${key.slice(4)}`;
    if (key.startsWith("ebay:")) return `eBay #${key.slice(5)}`;
    if (key.startsWith("img:")) return "Image search";
    return "Not sorted yet";
  }

  function huntImageFrom(key, image) {
    const h = key && hunts.get(key);
    if (h && !h.image && image && /^https:/.test(image)) {
      h.image = image;
      saveHunts();
    }
  }

  function isAsin(value) {
    return /^[A-Z0-9]{10}$/.test(String(value || ""));
  }

  function applyStoredAmazon(tracked, mine) {
    amzBase = tracked && typeof tracked === "object" ? JSON.parse(JSON.stringify(tracked)) : {};
    amzMineBase = Array.isArray(mine) ? mine.slice() : [];
    amazonTracked.clear();
    if (tracked && typeof tracked === "object") {
      Object.keys(tracked).forEach((asin) => {
        if (!isAsin(asin)) return;
        const m = tracked[asin] || {};
        amazonTracked.set(asin, {
          title: String(m.title || ""),
          brand: String(m.brand || ""),
          price: String(m.price || ""),
          image: String(m.image || ""),
          addedAt: String(m.addedAt || ""),
          reportedAt: String(m.reportedAt || ""),
          hunt: String(m.hunt || ""),
          marketplace: (window.EifAmazonReport && window.EifAmazonReport.normalizeMarketplace(m.marketplace)) || "US",
          copied: Array.isArray(m.copied) ? m.copied.filter((f) => ["title", "brand", "bullets", "description"].includes(f)) : [],
          reason: window.EifAmazonReport && Object.prototype.hasOwnProperty.call(window.EifAmazonReport.ISSUES, m.reason) ? m.reason : "",
        });
      });
    }
    amazonMine.clear();
    (Array.isArray(mine) ? mine : []).forEach((a) => isAsin(a) && amazonMine.add(a));
  }

  const amzRecent = new Map();
  function saveAmazon() {
    if (!hasStorage) return;
    const local = {};
    amazonTracked.forEach((m, asin) => (local[asin] = { title: m.title || "", brand: m.brand || "", price: m.price || "", image: m.image || "", addedAt: m.addedAt || "", reportedAt: m.reportedAt || "", hunt: m.hunt || "", copied: m.copied || [], reason: m.reason || "", marketplace: m.marketplace || "US" }));
    const base = amzBase;
    const ops = {};
    Object.keys(local).forEach((a) => { if (JSON.stringify(local[a]) !== JSON.stringify(base[a])) ops[a] = local[a]; });
    Object.keys(base).forEach((a) => { if (!(a in local)) ops[a] = null; });
    const now = Date.now();
    Object.entries(ops).forEach(([a, v]) => amzRecent.set(a, { value: v, was: base[a], at: now, tries: 0 }));
    const localMine = [...amazonMine];
    amzWrite(ops, localMine.filter((a) => !amzMineBase.includes(a)), amzMineBase.filter((a) => !localMine.includes(a)));
  }
  function amzWrite(ops, mineAdd, mineDel) {
    const write = () => new Promise((resolve) => {
      chrome.storage.local.get({ eifAmazonTracked: {}, eifAmazonMine: [] }, (d) => {
        const out = { ...(d && d.eifAmazonTracked && typeof d.eifAmazonTracked === "object" ? d.eifAmazonTracked : {}) };
        Object.entries(ops).forEach(([a, v]) => { if (v === null) delete out[a]; else out[a] = v; });
        const mine = new Set(Array.isArray(d && d.eifAmazonMine) ? d.eifAmazonMine : []);
        (mineAdd || []).forEach((a) => mine.add(a));
        (mineDel || []).forEach((a) => mine.delete(a));
        amzBase = out;
        amzMineBase = [...mine];
        chrome.storage.local.set({ eifAmazonTracked: out, eifAmazonMine: [...mine] }, () => resolve());
      });
    });
    amzSaveChain = amzSaveChain.then(write, write);
  }
  function amzRestoreLost(stored) {
    if (!hasStorage || !stored || typeof stored !== "object") return;
    const now = Date.now();
    const ops = {};
    amzRecent.forEach((op, a) => {
      if (now - op.at > 15000 || op.tries >= 2) return amzRecent.delete(a);
      const has = Object.prototype.hasOwnProperty.call(stored, a);
      const lost = op.value !== null ? !has : has && JSON.stringify(stored[a]) === JSON.stringify(op.was);
      if (lost) { ops[a] = op.value; op.tries++; }
    });
    if (Object.keys(ops).length) amzWrite(ops);
  }

  const mineNotes = new Map();
  function applyMineNotes(obj) {
    mineNotes.clear();
    if (obj && typeof obj === "object") Object.entries(obj).forEach(([k, v]) => { if (v && typeof v === "object") mineNotes.set(k, { reason: String(v.reason || ""), label: String(v.label || "").slice(0, 40), at: String(v.at || "") }); });
  }
  function setMineNote(key, note) {
    if (note) mineNotes.set(key, note);
    else mineNotes.delete(key);
    if (hasStorage) chrome.storage.local.set({ eifMineNotes: Object.fromEntries(mineNotes) });
  }
  function mineNoteText(key) {
    const n = mineNotes.get(key);
    if (!n) return "Marked by you";
    const when = n.at ? ` · ${niceDate(n.at)}` : "";
    if (n.reason === "other") return `From another account you own${n.label ? ` (${escapeHtml(n.label)})` : ""}${when}`;
    if (n.reason === "missed") return `On your account, not found by the sync${when}`;
    if (n.reason === "ebay_said") return `eBay showed "Your item is for sale"${when}`;
    return `Marked by you${when}`;
  }

  function saveProtectedItems() {
    if (hasStorage) chrome.storage.local.set({ eifProtectedItems: [...protectedItems] });
  }

  function saveTrackedItems() {
    if (!hasStorage) return;
    const obj = {};
    trackedItems.forEach((meta, itemNumber) => {
      obj[itemNumber] = {
        title: meta.title,
        url: meta.url,
        image: meta.image || "",
        price: meta.price || "",
        seller: meta.seller || "",
        kind: meta.kind || "copycat",
        source: meta.source || "",
        hunt: meta.hunt || "",
        reportedAt: meta.reportedAt || "",
        listedAt: meta.listedAt || "",
      };
    });
    chrome.storage.local.set({ eifTrackedItems: obj });
  }

  function watchStorage() {
    if (!hasStorage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      let changed = false;
      if (changes.eifReportHistory && Array.isArray(changes.eifReportHistory.newValue)) {
        const known = new Set(reportHistory.map((r) => r.id));
        reportHistory = changes.eifReportHistory.newValue;
        const added = reportHistory.filter((r) => !known.has(r.id));
        if (added.length) {
          chrome.storage.local.get({ eifAmazonTracked: {}, eifAmazonMine: [] }, (d) => {
            applyStoredAmazon(d.eifAmazonTracked, d.eifAmazonMine);
            afterReportSaved(added);
          });
        } else if (popup && popup.tab === "reported") renderReportedView();
      }
      if (changes.eifMerchMeta) onMerchMetaChange(changes.eifMerchMeta.newValue);
      if ((changes.eifAmazonJobs || changes.eifAmazonJobsRev) && popup && popup.tab === "report" && reportSite === "amazon") {
        azRefreshJobs().then(() => azUpdateLive());
      }
      if (changes.eifMineNotes) applyMineNotes(changes.eifMineNotes.newValue);
      if (changes.eifProtectedItems) {
        applyStoredProtected(changes.eifProtectedItems.newValue);
        changed = true;
      }
      if (changes.eifEbayMeta) {
        applyEbayMeta(changes.eifEbayMeta.newValue);
        if (popup && popup.tab === "mine") renderMineView();
      }
      if (changes.eifTrackedItems) {
        applyStoredTracked(changes.eifTrackedItems.newValue);
        changed = true;
      }
      if (changes.eifAmazonTracked || changes.eifAmazonMine) {
        if (changes.eifAmazonTracked) amzRestoreLost(changes.eifAmazonTracked.newValue);
        chrome.storage.local.get({ eifAmazonTracked: {}, eifAmazonMine: [] }, (d) => {
          applyStoredAmazon(d.eifAmazonTracked, d.eifAmazonMine);
          refreshHuntCards();
          updatePanel();
          updateTabCounts();
          if (popup && popup.tab === "tracked") renderTrackedView();
        });
      }
      if (changed) {
        refreshAllBadges();
        updatePanel();
        refreshHuntCards();
      }
    });
  }

  function decodeRepeatedly(value) {
    let current = String(value || "");
    for (let i = 0; i < 3; i++) {
      try {
        const decoded = decodeURIComponent(current);
        if (decoded === current) break;
        current = decoded;
      } catch (e) {
        break;
      }
    }
    return current;
  }

  function extractItemNumbers(value, attrName = "") {
    if (!value) return [];

    const source = String(value);
    const decoded = decodeRepeatedly(source);
    const texts = source === decoded ? [source] : [source, decoded];
    const found = new Set();

    for (const text of texts) {
      const urlRe = new RegExp('/itm/(?:[^/?#"]+/)?([0-9]{6,15})(?=[/?#"]|$)', "gi");
      let match;
      while ((match = urlRe.exec(text))) found.add(match[1]);

      const keyRe = /(?:iid|itemid|itemnumber|listingid|listingnumber|item[-_ ]id|listing[-_ ]id)[^0-9]{0,20}([0-9]{6,15})/gi;
      while ((match = keyRe.exec(text))) found.add(match[1]);
    }

    if (/(?:item|listing|iid)/i.test(attrName) && !/track/i.test(attrName)) {
      const bare = source.match(/^[^0-9]*([0-9]{6,15})[^0-9]*$/);
      if (bare) found.add(bare[1]);
    }

    return [...found];
  }

  function guessTitleFromElement(element) {
    const aria = element.getAttribute("aria-label");
    if (aria && aria.trim().length > 2) return aria.trim();

    const titleAttr = element.getAttribute("title");
    if (titleAttr && titleAttr.trim().length > 2) return titleAttr.trim();

    const img = element.querySelector && element.querySelector("img[alt]");
    if (img && img.alt && img.alt.trim().length > 2) return img.alt.trim();

    let current = element;
    for (let depth = 0; depth < 8 && current; depth++) {
      const heading =
        current.querySelector &&
        current.querySelector("h2, h3, [role='heading'], [class*='title']");
      if (heading && heading.textContent.trim().length > 2) {
        return heading.textContent.trim();
      }
      const text = (current.textContent || "").trim();
      if (text.length > 2 && text.length < 500 && depth > 0) return text;
      current =
        current.parentElement ||
        (current.getRootNode && current.getRootNode().host) ||
        null;
    }

    return "Untitled listing";
  }

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    });
  }

  function showToast(msg) {
    let toast = document.getElementById("eif-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "eif-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add("eif-show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove("eif-show"), 1600);
  }

  function waitFor(getter, timeoutMs = 10000, intervalMs = 150) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        let value = null;
        try {
          value = getter();
        } catch (e) {
          value = null;
        }
        if (value) return resolve(value);
        if (Date.now() - started >= timeoutMs) return resolve(null);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  function toggleTracked(itemNumber) {
    if (isMineEbay(itemNumber)) {
      showToast(`#${itemNumber} is ${protectedItems.has(itemNumber) ? "protected as your listing" : "one of your eBay listings"}`);
      return;
    }
    if (trackedItems.has(itemNumber)) {
      trackedItems.delete(itemNumber);
      showToast(`Removed #${itemNumber}`);
    } else {
      const meta = discovered.get(itemNumber) || {
        title: "Untitled listing",
        url: `https://www.ebay.com/itm/${itemNumber}`,
      };
      trackedItems.set(itemNumber, { ...meta, reportedAt: "" });
      huntImageFrom(meta.hunt, meta.image);
      showToast(`Added #${itemNumber}`);
    }
    saveTrackedItems();
    syncBadgeProtection(itemNumber);
    updatePanel();
    refreshHuntCards();
  }

  function bindClickIntercept(el, handler) {
    ["pointerdown", "mousedown", "click"].forEach((evtName) => {
      el.addEventListener(evtName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (evtName === "click") handler(e);
      });
    });
  }

  function updateBadgeProtection(badge, itemNumber) {
    if (!badge) return;
    const isProtected = isMineEbay(itemNumber);
    const isTracked = !isProtected && trackedItems.has(itemNumber);
    badge.classList.toggle("eif-badge-protected", isProtected);
    badge.classList.toggle("eif-badge-tracked", isTracked);
    const numEl = badge.querySelector(".eif-badge-num");
    if (numEl) {
      numEl.textContent = isProtected || isTracked ? "✓" : "+";
      numEl.title = isProtected
        ? (protectedItems.has(itemNumber) ? "Protected: your listing is excluded from copycat reports" : "Your eBay listing (from Seller Hub): never marked as a copycat or reported")
        : isTracked
          ? "Copycat. Click to take it off your copycats"
          : "Mark this listing as a copycat";
    }
  }

  function syncBadgeProtection(itemNumber) {
    badgedInfo.forEach((info) => {
      if (info.itemNumber === itemNumber) updateBadgeProtection(info.badgeEl, itemNumber);
    });
  }

  function refreshAllBadges() {
    badgedInfo.forEach((info) => updateBadgeProtection(info.badgeEl, info.itemNumber));
  }

  function makeBadge(itemNumber) {
    const badge = document.createElement("span");
    badge.className = "eif-badge";
    badge.dataset.itemNumber = itemNumber;

    const numEl = document.createElement("span");
    numEl.className = "eif-badge-num eif-plus-only";
    bindClickIntercept(numEl, () => {
      if (isMineEbay(itemNumber)) {
        showToast(`Your own listing, not added`);
        return;
      }
      toggleTracked(itemNumber);
    });

    badge.appendChild(numEl);
    updateBadgeProtection(badge, itemNumber);
    return badge;
  }

  const clipAncestorCache = new WeakMap();

  function getClipAncestors(anchor) {
    let list = clipAncestorCache.get(anchor);
    if (list) return list;
    list = [];
    let el = anchor.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const cs = getComputedStyle(el);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") list.push(el);
      el = el.parentElement;
    }
    clipAncestorCache.set(anchor, list);
    return list;
  }

  function isInsideClips(anchor, left, top, width, height) {
    const tolerance = 2;
    for (const clip of getClipAncestors(anchor)) {
      if (!clip.isConnected) continue;
      const r = clip.getBoundingClientRect();
      if (
        left < r.left - tolerance ||
        top < r.top - tolerance ||
        left + width > r.right + tolerance ||
        top + height > r.bottom + tolerance
      ) {
        return false;
      }
    }
    return true;
  }

  function positionBadge(badge, anchor) {
    if (!badge || !anchor || !anchor.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.max(badge.offsetWidth, 24);
    const height = Math.max(badge.offsetHeight, 24);
    let left;
    let top;
    if (priceAnchors.has(anchor)) {
      left = rect.right - width - 6;
      top = rect.top + Math.max(0, (rect.height - height) / 2);
    } else {
      left = rect.left + 6;
      top = rect.top + 6;
    }
    badge.style.left = `${Math.round(left + window.scrollX)}px`;
    badge.style.top = `${Math.round(top + window.scrollY)}px`;

    const visible =
      rect.width > 0 && rect.height > 0 && isInsideClips(anchor, left, top, width, height);
    badge.classList.toggle("eif-badge-clipped", !visible);
  }

  function positionAllBadges() {
    badgedInfo.forEach(({ badgeEl, anchor }) => positionBadge(badgeEl, anchor));
  }

  let positionFrame = 0;
  function schedulePositionAllBadges() {
    if (positionFrame) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = 0;
      positionAllBadges();
    });
  }

  function insertBadge(anchor, itemNumber) {
    const badge = makeBadge(itemNumber);
    badge.classList.add("eif-badge-floating");
    document.body.appendChild(badge);
    positionBadge(badge, anchor);
    return badge;
  }

  function isDecorativeAnchor(element) {
    const isLinkLike =
      element.tagName === "A" || element.getAttribute("role") === "link";
    return (
      isLinkLike &&
      (element.getAttribute("aria-hidden") === "true" ||
        element.getAttribute("tabindex") === "-1")
    );
  }

  function findPriceReference(element) {
    const card =
      element.closest &&
      element.closest("li.s-card, .s-card[data-listingid], [data-listingid], .JMS8");
    if (!card) return null;

    const price = card.querySelector && card.querySelector(
      ".s-card__price, .su-card-container__attributes > div > div:nth-child(1) .su-styled-text, .KAtc"
    );
    if (!price) return null;

    const row =
      price.closest(".s-card__attribute-row") ||
      price.closest(".su-card-container__attributes > div > div:nth-child(1)") ||
      price.parentElement ||
      price;
    const rect = row.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 10) return null;
    priceAnchors.add(row);
    return row;
  }

  function findMediaReference(element) {
    let current = element;
    for (let depth = 0; depth < 8 && current; depth++) {
      const image =
        current.tagName === "IMG"
          ? current
          : current.querySelector && current.querySelector("img");
      if (image) {
        const rect = image.getBoundingClientRect();
        if (rect.width >= 12 && rect.height >= 12) return image;
      }
      current =
        current.parentElement ||
        (current.getRootNode && current.getRootNode().host) ||
        null;
    }
    return null;
  }

  function findVisibleListingAnchor(element, itemNumber) {
    let container = element.closest && element.closest("section");
    for (let depth = 0; depth < 3 && container; depth++) {
      const candidates = [...container.querySelectorAll("a[href]")].filter((candidate) => {
        if (isDecorativeAnchor(candidate)) return false;
        return extractItemNumbers(candidate.getAttribute("href")).includes(itemNumber);
      });
      if (candidates.length) {
        candidates.sort((a, b) => scoreAnchor(b) - scoreAnchor(a));
        return candidates[0];
      }
      container = container.parentElement;
    }
    return null;
  }

  function findReferenceElement(element, itemNumber = null) {
    const price = findPriceReference(element);
    if (price) return price;

    const card =
      element.closest &&
      element.closest(".s-card[data-listingid], [data-listingid], [data-iid], [iid]");
    if (card) return findMediaReference(card) || card;

    if (itemNumber) {
      const visibleAnchor = findVisibleListingAnchor(element, itemNumber);
      if (visibleAnchor) return findMediaReference(visibleAnchor) || visibleAnchor;
    }

    let current = element;
    let firstBox = null;
    for (let i = 0; i < 8 && current; i++) {
      const rect = current.getBoundingClientRect();
      if (rect.width >= 12 && rect.height >= 12 && !firstBox) firstBox = current;

      const hasCardContent =
        current.querySelector &&
        (current.querySelector("img") ||
          current.querySelector("h2, h3, [role='heading'], [class*='title']"));
      if (rect.width >= 12 && rect.height >= 12 && hasCardContent) return current;
      current =
        current.parentElement ||
        (current.getRootNode && current.getRootNode().host) ||
        null;
    }
    return firstBox || element;
  }

  function collectSearchElements(root) {
    const result = [];
    const visit = (node) => {
      for (const element of node.querySelectorAll("*")) {
        if (element.closest && element.closest("#eif-widget, #eif-hunt-overlay, .eif-badge")) continue;
        result.push(element);
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(root);
    return result;
  }

  function scoreAnchor(element) {
    let score = 0;
    if (!isDecorativeAnchor(element)) score += 10;
    if (
      element.matches &&
      element.matches(".s-card[data-listingid], [data-listingid], [data-iid], [iid]")
    ) {
      score += 20;
    }
    if (element.querySelector && element.querySelector("img")) score += 5;
    if ((element.textContent || "").trim().length > 2) score += 3;
    const rect = element.getBoundingClientRect();
    if (rect.width >= 12 && rect.height >= 12) score += 4;
    if (element.hasAttribute("href")) score += 2;
    return score;
  }

  function isSellerPage() {
    return SITE === "ebay" && /^\/(?:sh|mys|myb|mye|sl|lstng|sell|ws)(?:\/|$)/i.test(location.pathname);
  }

  function holdsSeveralListings(element) {
    if (!element.querySelectorAll || element.tagName === "A") return false;
    const ids = new Set();
    for (const a of element.querySelectorAll('a[href*="/itm/"]')) {
      const id = extractItemNumbers(a.getAttribute("href"))[0];
      if (id) ids.add(id);
      if (ids.size > 1) return true;
    }
    return false;
  }

  function scan() {
    if (!prefs.pageBadges) return;
    if (isSellerPage()) {
      badgedInfo.forEach((info) => info.badgeEl && info.badgeEl.remove());
      badgedInfo.clear();
      return;
    }
    const pageItem = currentPageItemNumber();
    const elements = collectSearchElements(document);
    const candidates = new Map();

    elements.forEach((element) => {
      try {
        const values = [];
        for (const attr of element.attributes) {
          const name = attr.name;
          const value = attr.value || "";
          const isHref = name === "href";
          const isMetadataName = /(?:iid|item|listing|track|rover|itm|entity|testid|uid|url|href|analytics|data-id)/i.test(name);
          const hasUsefulValue = /[0-9]{6,15}|itm|rover|mpre|listing|item/i.test(value);
          if ((isHref || isMetadataName) && hasUsefulValue) {
            const priority = /listingid|itemid|iid|data-item-number|data-listing-number/i.test(name) ? 2 : 1;
            values.push({ name, value, priority });
          }
        }

        if (!values.length) return;
        values.sort((a, b) => b.priority - a.priority);
        let chosen = null;

        for (const { name, value, priority } of values) {
          const ids = extractItemNumbers(value, name).filter((id) => id !== pageItem);
          if (!ids.length) continue;
          if (name !== "href" && holdsSeveralListings(element)) continue;
          chosen = { itemNumber: ids[0], name, value, priority };
          break;
        }
        if (!chosen) return;

        const { itemNumber } = chosen;
        const reference = findReferenceElement(element, itemNumber);
        const currentMeta = discovered.get(itemNumber);
        const rawUrl =
          element.getAttribute("href") ||
          element.getAttribute("data-url") ||
          element.getAttribute("data-href") ||
          "";
        if (!currentMeta || currentMeta.title === "Untitled listing" || !currentMeta.url) {
          discovered.set(itemNumber, {
            title: guessTitleFromElement(reference),
            url: rawUrl
              ? decodeRepeatedly(rawUrl).split("?")[0]
              : `https://www.ebay.com/itm/${itemNumber}`,
          });
        }

        const score = scoreAnchor(reference) + (chosen.priority === 2 ? 3 : 0);
        const existing = candidates.get(reference);
        if (!existing || score > existing.score) {
          candidates.set(reference, { itemNumber, score });
        }
      } catch (err) {
        console.warn("[eBay Item Finder] skipped one listing while scanning:", err, element);
      }
    });

    candidates.forEach(({ itemNumber, score }, reference) => {
      try {
        const current = badgedInfo.get(reference);
        if (
          current &&
          current.badgeEl &&
          current.badgeEl.isConnected &&
          current.itemNumber === itemNumber &&
          current.score >= score
        ) {
          positionBadge(current.badgeEl, reference);
          return;
        }

        if (current && current.badgeEl && current.badgeEl.isConnected) {
          current.badgeEl.remove();
        }

        const badgeEl = insertBadge(reference, itemNumber);
        badgedInfo.set(reference, { itemNumber, badgeEl, score, anchor: reference });
      } catch (err) {
        console.warn("[eBay Item Finder] failed to insert badge:", err, reference);
      }
    });

    badgedInfo.forEach((info, reference) => {
      if (!candidates.has(reference) || !reference.isConnected) {
        if (info.badgeEl && info.badgeEl.isConnected) info.badgeEl.remove();
        badgedInfo.delete(reference);
      }
    });

    positionAllBadges();
  }

  const M = self.EifMotion || { enabled: () => false, enter() {}, spiders: () => () => {}, swap(el, t) { if (el) el.textContent = t; }, count(el, v) { if (el) el.textContent = String(v); }, claws: () => () => {}, enterMany() {}, mark() {}, logoSvg: () => "" };
  const LOADER = () => (M.logoSvg() ? `<span class="eif-loader" aria-hidden="true">${M.logoSvg()}</span>` : "");
  const LOGO = `<svg class="eif-logo" viewBox="0 0 125.83 125.67" width="22" height="22" aria-hidden="true" focusable="false"><rect fill="#2ee6a6" width="125.83" height="125.67" rx="28.22" ry="28.22"/><path fill="#121214" d="M92.82,85.07v22.15h-59.81v-55.32l-5.43,3.62-13.21-17.5,22.33-19.57c4.1,2.69,8.35,5.57,12.44,8.28,1.38,1.17,3.37,4.16,4.94,5.1,5.33,3.17,10.8,3.4,16.42.7,2.49-1.2,4.27-3.88,6.27-5.87l12.34-8.21,22.33,19.56-13.16,17.54-5.48-3.66v25.7c-6.36,9.09-11.98,18.42-16.85,27.98,6.52-3.7,13.17-14.33,16.85-20.5ZM69.72,63.57l-22.56,35.98c-.05.08-.03.18.05.23,0,0,0,0,0,0l.05.04c1.65,1.01,8.02-6.19,14.24-16.1l.22-.35c6.22-9.91,9.92-18.78,8.29-19.82l-.05-.04c-.08-.05-.18-.03-.23.05,0,0,0,0,0,0ZM72.51,84.02c-3.63,5.78-7.09,11.86-10.37,18.26-.04.12.02.26.14.3.07.03.15.02.21-.03,4.83-4.12,9.36-9.55,13.6-16.29,4.23-6.74,7.16-13.18,8.77-19.32.02-.13-.07-.25-.2-.27-.08-.01-.16.02-.21.07-4.33,5.73-8.31,11.49-11.95,17.28Z"/></svg>`;

  const ICON = `
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/>
      <line x1="16" y1="16" x2="21" y2="21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
      <line x1="11" y1="2" x2="11" y2="5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      <line x1="2" y1="11" x2="5.5" y2="11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      <circle cx="11" cy="11" r="1.6" fill="currentColor"/>
    </svg>`;

  const HTML_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
  function escapeHtml(str) {
    return (str == null ? "" : String(str)).replace(/[&<>"'`]/g, (c) => HTML_ESC[c]);
  }
  function safeHref(url) {
    try {
      const u = new URL(String(url || ""), location.href);
      return u.protocol === "https:" || u.protocol === "http:" ? escapeHtml(u.href) : "#";
    } catch (e) {
      return "#";
    }
  }
  function safeSrc(url) {
    const v = String(url || "");
    if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(v) || /^blob:/i.test(v)) return escapeHtml(v);
    try {
      const u = new URL(v, location.href);
      return u.protocol === "https:" || u.protocol === "http:" ? escapeHtml(u.href) : "";
    } catch (e) {
      return "";
    }
  }

  function copyList(list) {
    const safeList = [...new Set(list)].filter((itemNumber) => !isMineEbay(itemNumber));
    if (!safeList.length) {
      showToast("No unprotected listings to copy");
      return;
    }
    copyToClipboard(safeList.join("\n"));
    showToast(`Copied ${safeList.length} item number${safeList.length > 1 ? "s" : ""}`);
  }

  function searchIsMine(search) {
    return !!(search && search.itemNumber && isMineEbay(search.itemNumber));
  }

  function protectItem(itemNumber) {
    itemNumber = normalizeItemNumber(itemNumber);
    if (!itemNumber) {
      showToast("Enter a valid eBay item number");
      return false;
    }
    protectedItems.add(itemNumber);
    const wasTracked = trackedItems.delete(itemNumber);
    saveProtectedItems();
    if (wasTracked) saveTrackedItems();
    syncBadgeProtection(itemNumber);
    updatePanel();
    refreshHuntCards();
    showToast(`#${itemNumber} protected as your listing`);
    return true;
  }

  function unprotectItem(itemNumber) {
    protectedItems.delete(itemNumber);
    setMineNote(`ebay:${itemNumber}`, null);
    saveProtectedItems();
    syncBadgeProtection(itemNumber);
    updatePanel();
    refreshHuntCards();
    showToast(`#${itemNumber} protection removed`);
  }

  let widget = null;

  function buildWidget() {
    if (document.getElementById("eif-widget")) return;
    widget = document.createElement("div");
    widget.id = "eif-widget";
    widget.setAttribute("role", "button");
    widget.tabIndex = 0;
    widget.title = "Drop your listing's photo here to find copies. Click to open.";
    widget.setAttribute("aria-label", "Hunt copycats");
    widget.innerHTML = `
      <div class="eif-hunt-inner">
        <div class="eif-hunt-icon">${LOGO}</div>
        <div class="eif-hunt-text">
          <div class="eif-hunt-title">Hunt copycats</div>
          <div class="eif-hunt-sub">${signedInState() === false ? (SITE === "amazon" ? "Connect Merch to start" : "Sign in to start") : "Drop your listing image"}</div>
        </div>
        <span id="eif-widget-count" title="Copycats" hidden></span>
      </div>`;
    document.body.appendChild(widget);

    makeWidgetMovable(widget);
    makeDropTarget(widget, () => widget.classList.add("eif-drag-over"), () => widget.classList.remove("eif-drag-over"));

    widget.addEventListener("click", () => {
      if (widget._eifMoved) return;
      toggleMini();
    });
    widget.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleMini();
      }
    });
  }

  let mini = null;

  function toggleMini() {
    if (mini) closeMini();
    else openMini();
  }

  function openMini() {
    if (mini || !widget) return;
    const el = document.createElement("div");
    el.id = "eif-mini";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Hunt copycats");
    const signedOut = signedInState() === false;
    const head = `
      <div class="eif-mini-head">
        <span class="eif-mini-title">${LOGO}<span>Hunt copycats</span></span>
        <button class="eif-mini-x" type="button" data-mini="close" title="Close (Esc)">&times;</button>
      </div>`;
    if (signedOut && SITE === "amazon" && merchGate.state === "idle") setTimeout(merchGateCheck, 0);
    el.innerHTML = signedOut && SITE === "amazon"
      ? `${head}
      <div class="eif-mini-gate">
        <div class="eif-mini-gate-title">Connect your Merch account</div>
        <div class="eif-mini-lead">On Amazon, Copycat Hunt needs your Merch on Demand catalog once, so it can tell your designs apart from copies. Your password stays with Amazon.</div>
        <div class="eif-merch-gate" data-merch-gate>${merchGateInner()}</div>
      </div>`
      : signedOut
      ? `${head}
      <div class="eif-mini-gate">
        <div class="eif-mini-gate-title">Sign in to use Copycat Hunt</div>
        <div class="eif-mini-lead">Sign in to your eBay account to get started.</div>
        <a class="eif-hunt-btn eif-hunt-btn-primary eif-mini-upload" href="${safeHref(signInUrl())}">Sign in to eBay</a>
      </div>`
      : `${head}
      <button class="eif-mini-drop" type="button" data-mini="upload" title="Upload an image from your computer">
        <span class="eif-mini-drop-icon">${ICON}</span>
        <span class="eif-mini-drop-main">Drop your listing photo here</span>
        <span class="eif-mini-drop-sub">or <u>upload an image</u> · paste with <kbd>Ctrl</kbd>+<kbd>V</kbd></span>
      </button>
      <div class="eif-mini-actions">
        <button class="eif-hunt-btn eif-mini-upload" type="button" data-mini="${currentPageItemNumber() ? "hijack-page" : currentPageAsin() ? "az-hijack-page" : "hijacks"}" title="Find listings that copy your title wording or reuse your photos">${currentPageItemNumber() ? `Check this listing for hijacks` : currentPageAsin() ? "Check this product for hijacks" : "Check a listing for hijacks"}</button>
        ${currentPageAsin() && !amazonMine.has(currentPageAsin()) && !amazonActiveTracked(currentPageAsin()) && !amazonLock(currentPageAsin()) ? `<button class="eif-hunt-btn eif-mini-upload" type="button" data-mini="az-add-page">Add this product to the Amazon report list</button>` : ""}
      </div>
      <div class="eif-mini-links">
        ${lastSearch ? `<button type="button" data-mini="results">Look-alikes${resultsCount(lastSearch) ? ` <span>${resultsCount(lastSearch)}</span>` : ""}</button>` : ""}
        ${lastHijack ? `<button type="button" data-mini="hijacks">Hijacks${lastHijack.matches.filter((m) => m.level >= 2).length ? ` <span>${lastHijack.matches.filter((m) => m.level >= 2).length}</span>` : ""}</button>` : ""}
        <button type="button" data-mini="tracked">Copycats${activeTracked().length + azTracked().length ? ` <span>${activeTracked().length + azTracked().length}</span>` : ""}</button>
        ${activeTracked().length || azTargets().length ? `<button type="button" data-mini="report">Report</button>` : ""}
        ${reportHistory.length ? `<button type="button" data-mini="reported">Reported</button>` : ""}
        <button type="button" data-mini="bestsellers">Best sellers</button>
        <button type="button" data-mini="mine">My listings${mineEbayCount() ? ` <span>${mineEbayCount()}</span>` : ""}</button>
      </div>
      <input type="file" accept="image/*" hidden data-mini="file" />`;
    if (signedOut) el.insertAdjacentHTML("beforeend", '<input type="file" accept="image/*" hidden data-mini="file" />');
    document.body.appendChild(el);
    placeMini(el);
    if (M.enabled() && self.gsap) self.gsap.fromTo(el, { autoAlpha: 0, y: 14, scale: 0.94, transformOrigin: "100% 100%" }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.32, ease: "back.out(1.6)", clearProps: "transform,opacity,visibility" });

    const fileInput = el.querySelector('input[data-mini="file"]');
    el.addEventListener("click", (e) => {
      const target = e.target.closest("[data-mini]");
      if (!target) return;
      const action = target.dataset.mini;
      if (action === "close") closeMini();
      else if (action === "upload") fileInput.click();
      else if (action === "hijack-page") startHijackCheck(currentPageItemNumber());
      else if (action === "az-hijack-page") startAmazonHijackCheck(currentPageAsin());
      else if (action === "az-add-page") {
        const a = currentPageAsin();
        if (a && !amazonActiveTracked(a) && !amazonMine.has(a) && !amazonLock(a)) {
          if (azTargets().length >= AZ.TARGET_LIMIT) return showToast(`The Amazon list is full (${AZ.TARGET_LIMIT})`);
          const title = ((document.getElementById("productTitle") || {}).textContent || "").replace(/\s+/g, " ").trim();
          const img = (document.getElementById("landingImage") || {}).src || "";
          amazonTracked.set(a, { title, brand: "", price: "", image: img, url: AZ.productUrl(PAGE_MP, a), addedAt: today(), reportedAt: "", marketplace: PAGE_MP });
          saveAmazon();
          updatePanel();
          showToast(`Added ${a} to the Amazon report list`);
        }
        closeMini();
      }
      else if (action === "results" || action === "tracked" || action === "mine" || action === "bestsellers" || action === "hijacks" || action === "report" || action === "reported") {
        if (action === "report" && !activeTracked().length && azTargets().length) reportSite = "amazon";
        closeMini();
        openPopup(action);
      }
    });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (file) startSearch({ file, imageUrl: null, itemNumber: null });
    });
    makeDropTarget(el, () => el.classList.add("eif-drag-over"), () => el.classList.remove("eif-drag-over"));

    const onDocDown = (e) => {
      if (!el.contains(e.target) && !widget.contains(e.target)) closeMini();
    };
    const onKey = (e) => {
      if (e.key === "Escape") closeMini();
    };
    const onResize = () => placeMini(el);
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    widget.classList.add("eif-mini-open");
    mini = { el, onDocDown, onKey, onResize };
  }

  function closeMini() {
    if (!mini) return;
    document.removeEventListener("mousedown", mini.onDocDown, true);
    document.removeEventListener("keydown", mini.onKey, true);
    window.removeEventListener("resize", mini.onResize);
    mini.el.remove();
    if (widget) widget.classList.remove("eif-mini-open");
    mini = null;
  }

  function placeMini(el) {
    const w = widget.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let left = w.right - width;
    left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
    let top = w.top - height - 10;
    if (top < 8) top = Math.min(w.bottom + 10, window.innerHeight - height - 8);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(Math.max(8, top))}px`;
  }

  function setupPaste() {
    document.addEventListener("paste", (e) => {
      if (!mini && !popup) return;
      const target = e.target;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const data = e.clipboardData;
      if (!data) return;
      const file = [...(data.files || [])].find((f) => /^image\//.test(f.type));
      const text = (data.getData("text/plain") || "").trim();
      const html = data.getData("text/html") || "";
      if (!file && !text && !html) return;
      e.preventDefault();
      if (file) {
        startSearch({ file, imageUrl: null, itemNumber: null });
        return;
      }
      handleHuntDrop(
        {
          files: [],
          getData: (type) => (type === "text/html" ? html : type === "text/plain" ? text : type === "text/uri-list" ? text : ""),
        },
        null
      );
    });
  }

  function makeWidgetMovable(el) {
    let start = null;
    if (hasStorage) {
      chrome.storage.local.get({ eifWidgetPos: null }, (data) => {
        const pos = data.eifWidgetPos;
        if (pos && typeof pos.left === "number" && typeof pos.top === "number") placeWidget(el, pos.left, pos.top);
      });
    }
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const rect = el.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false };
      el._eifMoved = false;
    });
    document.addEventListener("mousemove", (e) => {
      if (!start) return;
      if (!start.moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
      start.moved = true;
      el._eifMoved = true;
      el.classList.add("eif-moving");
      placeWidget(el, e.clientX - start.dx, e.clientY - start.dy);
    });
    document.addEventListener("mouseup", () => {
      if (!start) return;
      if (start.moved && hasStorage) {
        const rect = el.getBoundingClientRect();
        chrome.storage.local.set({ eifWidgetPos: { left: Math.round(rect.left), top: Math.round(rect.top) } });
      }
      el.classList.remove("eif-moving");
      start = null;
      setTimeout(() => (el._eifMoved = false), 0);
    });
    window.addEventListener("resize", () => {
      const rect = el.getBoundingClientRect();
      if (el.style.left) placeWidget(el, rect.left, rect.top);
    });
  }

  function placeWidget(el, left, top) {
    const maxLeft = Math.max(0, window.innerWidth - el.offsetWidth - 4);
    const maxTop = Math.max(0, window.innerHeight - el.offsetHeight - 4);
    el.style.left = `${Math.min(Math.max(4, left), maxLeft)}px`;
    el.style.top = `${Math.min(Math.max(4, top), maxTop)}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
    if (mini) placeMini(mini.el);
  }

  function updatePanel() {
    const count = document.getElementById("eif-widget-count");
    if (count) {
      count.textContent = String(activeTracked().length);
      count.hidden = activeTracked().length === 0;
    }
    if (popup) {
      updateTabCounts();
      if (popup.tab === "tracked") renderTrackedView();
      if (popup.tab === "mine") renderMineView();
      if (popup.tab === "report") renderReportView();
      if (popup.tab === "reported") renderReportedView();
    }
  }

  let lastDragSource = null;
  const dropTargets = new Set();

  function setupGlobalDragTracking() {
    document.addEventListener(
      "dragstart",
      (e) => {
        const t = e.target;
        lastDragSource = t && t.nodeType === 1 ? t : t && t.parentElement;
        document.documentElement.classList.add("eif-dragging");
      },
      true
    );
    const end = () => {
      document.documentElement.classList.remove("eif-dragging");
      dropTargets.forEach((leave) => leave());
    };
    document.addEventListener("dragend", end, true);
    document.addEventListener("drop", () => setTimeout(end, 0), true);
    window.addEventListener("dragenter", (e) => {
      if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files")) {
        document.documentElement.classList.add("eif-dragging");
      }
    });
    window.addEventListener("dragleave", (e) => {
      if (!e.relatedTarget && (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight)) end();
    });
  }

  function makeDropTarget(el, onEnter, onLeave) {
    let depth = 0;
    const leave = () => {
      depth = 0;
      onLeave();
    };
    dropTargets.add(leave);
    el.addEventListener("dragenter", (e) => {
      e.preventDefault();
      depth++;
      onEnter();
    });
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    el.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (!depth) onLeave();
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const source = lastDragSource;
      lastDragSource = null;
      leave();
      document.documentElement.classList.remove("eif-dragging");
      handleHuntDrop(e.dataTransfer, source);
    });
  }

  function normalizeImageUrl(url) {
    let u = String(url || "").trim();
    if (!u || u.startsWith("data:") || u.startsWith("blob:")) return null;
    if (u.startsWith("//")) u = "https:" + u;
    if (!/^https?:\/\//i.test(u)) return null;
    const gallery = u.match(/^https?:\/\/i\.ebayimg\.com\/images\/g\/([^/]+)\/s-l\d+\.(?:webp|jpe?g|png|gif|avif)/i);
    if (gallery) return `https://i.ebayimg.com/images/g/${gallery[1]}/s-l1600.jpg`;
    return amazonFullSize(u);
  }

  function amazonFullSize(url) {
    const u = String(url || "");
    const m = u.match(/^https?:\/\/(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com|images-eu\.ssl-images-amazon\.com|images-amazon\.com)\/images\/I\/([A-Za-z0-9+-]+)\.([^/]+)$/);
    if (!m || /_CL|\||%7C/i.test(m[2])) return u;
    const ext = m[2].match(/(?:^|\.)(jpe?g|png)$/i);
    if (!ext) return u;
    return `https://m.media-amazon.com/images/I/${m[1]}.${/png/i.test(ext[1]) ? "png" : "jpg"}`;
  }

  function imageUrlFromImg(img) {
    if (!img) return null;
    const candidates = [
      img.getAttribute("data-zoom-src"),
      img.currentSrc,
      img.getAttribute("src"),
      img.getAttribute("data-src"),
    ];
    const srcset = img.getAttribute("srcset") || img.getAttribute("data-srcset");
    if (srcset) candidates.push(srcset.split(",").pop().trim().split(/\s+/)[0]);
    return candidates.find((value) => value && !/^data:|^blob:/i.test(value)) || null;
  }

  function listingInfoFromElement(el) {
    if (!el || !el.closest) return { imageUrl: null, itemNumber: null };
    const img = el.tagName === "IMG" ? el : el.querySelector && el.querySelector("img");
    const imageUrl = imageUrlFromImg(img);

    let itemNumber = null;
    const card = el.closest("[data-listingid], [data-iid], [iid], [data-item-number]");
    if (card) {
      itemNumber = normalizeItemNumber(
        card.getAttribute("data-listingid") ||
          card.getAttribute("data-iid") ||
          card.getAttribute("iid") ||
          card.getAttribute("data-item-number")
      );
    }
    if (!itemNumber) {
      const link = el.closest("a[href]");
      if (link) itemNumber = extractItemNumbers(link.getAttribute("href"))[0] || null;
    }
    if (!itemNumber && !card && !el.closest("a[href]")) itemNumber = currentPageItemNumber();
    return { imageUrl, itemNumber, designAsin: amazonImage(imageUrl) ? cardAsin(el) : null };
  }

  const amazonImage = (url) => /^https?:\/\/(?:m\.media-amazon\.com|images-[a-z]+\.ssl-images-amazon\.com|images-amazon\.com)\/images\/I\//i.test(String(url || ""));

  function cardAsin(el) {
    const ok = (v) => (/^[A-Z0-9]{10}$/.test(String(v || "").toUpperCase()) ? String(v).toUpperCase() : null);
    const card = el && el.closest && el.closest("[data-asin]");
    const fromCard = card && ok(card.getAttribute("data-asin"));
    if (fromCard) return fromCard;
    const link = el && el.closest && (el.closest("a[href]") || (card && card.querySelector("a[href*='/dp/']")));
    const m = link && String(link.getAttribute("href") || "").match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/i);
    return m ? ok(m[1]) : null;
  }

  async function fetchListingImage(itemNumber) {
    try {
      const res = await ebayFetch(`${EBAY}/itm/${itemNumber}`, { credentials: "include" });
      if (!res.ok) return null;
      const html = await res.text();
      const match =
        html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      return match ? match[1].replace(/&amp;/g, "&") : null;
    } catch (e) {
      return null;
    }
  }

  async function handleHuntDrop(dt, source) {
    let imageUrl = null;
    let itemNumber = null;
    let designAsin = null;

    if (source && source.isConnected) ({ imageUrl, itemNumber, designAsin } = listingInfoFromElement(source));

    if (dt) {
      const html = dt.getData("text/html");
      if (html) {
        const doc = new DOMParser().parseFromString(html, "text/html");
        if (!imageUrl) imageUrl = imageUrlFromImg(doc.querySelector("img"));
        if (!itemNumber) {
          const link = doc.querySelector("a[href]");
          if (link) itemNumber = extractItemNumbers(link.getAttribute("href"))[0] || null;
        }
        if (!designAsin && amazonImage(imageUrl)) designAsin = cardAsin(doc.querySelector("img") || doc.body);
      }
      const lines = `${dt.getData("text/uri-list")}\n${dt.getData("text/plain")}`
        .split(/\s+/)
        .filter((line) => line && !line.startsWith("#"));
      for (const line of lines) {
        if (!imageUrl && (/ebayimg\.com/i.test(line) || /\.(?:jpe?g|png|webp|gif|avif)(?:$|\?)/i.test(line))) {
          imageUrl = line;
        } else if (!itemNumber) {
          itemNumber = extractItemNumbers(line)[0] || normalizeItemNumber(line);
        }
      }
    }

    const file = dt && dt.files ? [...dt.files].find((f) => /^image\//.test(f.type)) : null;

    let normalized = normalizeImageUrl(imageUrl);
    if (!normalized && !file && itemNumber) {
      showToast(`Getting the image for #${itemNumber}…`);
      normalized = normalizeImageUrl(await fetchListingImage(itemNumber));
    }

    const isEbayImage = normalized && /i\.ebayimg\.com/i.test(normalized);
    if (file && !isEbayImage) {
      startSearch({ file, imageUrl: null, itemNumber });
      return;
    }
    if (!normalized) {
      showToast("Couldn't find an image there. Try a photo of the listing.");
      return;
    }
    startSearch({ imageUrl: normalized, file: null, itemNumber, designAsin: amazonImage(normalized) ? designAsin : null });
  }

  async function blobToSearchBase64(blob) {
    let source;
    try {
      source = await createImageBitmap(blob);
    } catch (e) {
      source = await new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(blob);
        img.onload = () => {
          URL.revokeObjectURL(url);
          resolve(img);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error("unreadable image"));
        };
        img.src = url;
      });
    }
    const width = source.width || source.naturalWidth;
    const height = source.height || source.naturalHeight;
    const scale = Math.min(1, 1000 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.88).split(",")[1];
  }

  async function postVisualSearch(base64) {
    const res = await ebayRequest({ type: "eif-ebay-visual", base64 }, { url: `${EBAY}/sch/ajax/post/image`, method: "POST", base64 });
    if (!res.ok) throw new Error(`The image search failed (${res.status}).`);
    const data = await res.json();
    if (!data || !data.zoom_guid) throw new Error("This image couldn't be searched. Try a clearer photo of the design.");
    return data.zoom_guid;
  }

  function resultsUrl(guid, page = 1) {
    return `${EBAY}/sch/i.html?visualSearchGuid=${encodeURIComponent(guid)}${page > 1 ? `&_pgn=${page}` : ""}`;
  }

  function cleanCardText(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll(".clipped, [class*='clipped']").forEach((n) => n.remove());
    return clone.textContent.replace(/Opens in a new window or tab/gi, "").replace(/\s+/g, " ").trim();
  }

  function extractResultItems(doc) {
    return [...doc.querySelectorAll("li.s-card[data-listingid], li.s-item")]
      .map((card) => {
        let itemNumber = normalizeItemNumber(card.getAttribute("data-listingid"));
        if (!itemNumber) {
          const link = card.querySelector("a[href*='/itm/']");
          itemNumber = link ? extractItemNumbers(link.getAttribute("href"))[0] || null : null;
        }
        if (!itemNumber) return null;
        const title = cleanCardText(card.querySelector(".s-card__title, .s-item__title"));
        if (itemNumber === "123456" || /^shop on ebay$/i.test(title)) return null;
        const rows = [...card.querySelectorAll(".s-card__attribute-row")].map((r) => cleanCardText(r));
        const priceRow = [...card.querySelectorAll(".s-card__attribute-row")].find((r) => r.querySelector(".s-card__price"));
        const priceText = priceRow ? [...priceRow.querySelectorAll(".s-card__price")].map((e) => e.textContent).join("").replace(/\s+/g, " ").trim() : "";
        const wasEl = priceRow && priceRow.querySelector(".strikethrough, s, del");
        return {
          itemNumber,
          url: `https://www.ebay.com/itm/${itemNumber}`,
          title: title || "Untitled listing",
          price:
            priceText ||
            rows.find((r) => /[$£€]\s?\d/.test(r)) ||
            cleanCardText(card.querySelector(".s-card__price, .s-item__price")),
          wasPrice: wasEl ? wasEl.textContent.replace(/\s+/g, " ").trim() : "",
          shipping: rows.find((r) => /delivery|shipping/i.test(r)) || "",
          seller: rows.find((r) => /positive/i.test(r)) || "",
          image: sharpThumb(imageUrlFromImg(card.querySelector("img")) || ""),
        };
      })
      .filter(Boolean);
  }

  function sharpThumb(url) {
    const m = String(url || "").match(/^https?:\/\/i\.ebayimg\.com\/images\/g\/([^/]+)\/s-l\d+\.(?:webp|jpe?g|png|gif|avif)/i);
    if (!m) return url;
    const size = (window.devicePixelRatio || 1) > 1.25 ? 960 : 500;
    return `https://i.ebayimg.com/images/g/${m[1]}/s-l${size}.webp`;
  }

  async function fetchResultsPage(guid, page) {
    const res = await ebayFetch(resultsUrl(guid, page), { credentials: "include", priority: "high" });
    if (!res.ok) throw new Error(`The results didn't load (${res.status}). Try again.`);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const items = extractResultItems(doc);
    const next = doc.querySelector("a.pagination__next, .pagination__next a, a[aria-label*='next page' i]");
    const hasMore = !!(next && next.getAttribute("href") && next.getAttribute("aria-disabled") !== "true");
    return { items, hasMore };
  }

  let lastSearch = null;

  let pageDesign = null;

  function amazonImageKey(url) {
    const u = String(url || "");
    let s = u;
    try { s = decodeURIComponent(u); } catch (e) {}
    const art = s.match(/\._CLa\|[^|]*\|([A-Za-z0-9+-]+)\.png\|/);
    if (art) return art[1];
    const m = u.match(/\/images\/I\/([A-Za-z0-9+%-]+?)\./);
    return m ? m[1] : u;
  }

  function searchFingerprint(imageUrl, file) {
    if (file) return `f:${file.name || ""}|${file.size || 0}|${file.lastModified || 0}`;
    return imageUrl ? `u:${amazonImageKey(imageUrl)}` : "";
  }

  function isPageProductImage(imageUrl) {
    if (!imageUrl || SITE !== "amazon") return false;
    const key = amazonImageKey(imageUrl);
    const urls = [];
    const main = document.getElementById("landingImage");
    if (main) {
      urls.push(main.getAttribute("src"), main.getAttribute("data-old-hires"));
      try { urls.push(...Object.keys(JSON.parse(main.getAttribute("data-a-dynamic-image") || "{}"))); } catch (e) {}
    }
    document.querySelectorAll("#altImages img").forEach((img) => urls.push(img.getAttribute("src")));
    return urls.some((u) => u && /\/images\/I\//.test(u) && amazonImageKey(u) === key);
  }

  function searchPageAsin(imageUrl, file) {
    const asin = currentPageAsin();
    if (!asin) return null;
    const fp = searchFingerprint(imageUrl, file);
    if (!pageDesign || pageDesign.asin !== asin) pageDesign = { asin, fp };
    return isPageProductImage(imageUrl) || pageDesign.fp === fp ? asin : null;
  }

  async function startSearch({ imageUrl, file, itemNumber, designAsin, huntTitle }) {
    if (!requireSignIn()) return;
    if (lastSearch && lastSearch.objectUrl) URL.revokeObjectURL(lastSearch.objectUrl);
    const objectUrl = file ? URL.createObjectURL(file) : null;
    const search = {
      id: `${Date.now()}${Math.random()}`,
      itemNumber: itemNumber || null,
      thumb: objectUrl || imageUrl,
      objectUrl,
      state: "loading",
      message: "Preparing your image…",
      items: [],
      seen: new Set(),
      guid: null,
      page: 1,
      hasMore: false,
      loadingMore: false,
      view: !prefs.searchEbay ? "amazon" : !prefs.searchAmazon ? "ebay" : SITE === "amazon" ? "amazon" : "ebay",
      asin: huntTitle ? null : searchPageAsin(imageUrl, file),
      amazon: { state: "idle", items: [], totalAsins: 0 },
      marketplace: PAGE_MP,
    };
    if (search.asin) asinMarket.set(search.asin, PAGE_MP);
    if (designAsin) asinMarket.set(designAsin, PAGE_MP);
    search.startedAt = Date.now();
    search.hunt = huntKeyFor(search);
    if (!search.asin && !search.itemNumber && huntTitle && isAsin(designAsin)) search.hunt = `amz:${designAsin}`;
    search.again = { imageUrl, file, itemNumber, designAsin: designAsin || null, huntTitle: huntTitle || null };
    {
      const pageTitle = ((document.getElementById("productTitle") || document.querySelector("h1.x-item-title__mainTitle") || {}).textContent || "").replace(/\s+/g, " ").trim().slice(0, 70);
      const when = new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      registerHunt(search.hunt, {
        label: search.asin ? `${pageTitle || "Amazon product"} (${search.asin})` : huntTitle && search.hunt === `amz:${designAsin}` ? `${String(huntTitle).slice(0, 70)} (${designAsin})` : search.itemNumber ? `${pageTitle || "eBay listing"} (#${search.itemNumber})` : `Image search · ${when}`,
        image: /^https:/.test(imageUrl || "") ? imageUrl : "",
      });
    }
    lastSearch = search;
    closeMini();
    openPopup("results");

    const stage = (index, message, from, ceiling) => {
      if (lastSearch !== search) return false;
      search.stage = index;
      search.message = message;
      search.progress = Math.max(search.progress || 0, from);
      search.ceiling = ceiling;
      updateProgressUI();
      return true;
    };
    clearInterval(search.creep);
    search.creep = setInterval(() => {
      if (lastSearch !== search || search.state !== "loading") {
        clearInterval(search.creep);
        return;
      }
      search.progress += Math.max(0.15, (search.ceiling - search.progress) * 0.05);
      search.progress = Math.min(search.progress, search.ceiling);
      updateProgressUI();
    }, 120);

    try {
      if (navigator.onLine === false) throw new TypeError("Failed to fetch");
      stage(0, "Preparing your image…", 4, 22);
      let blob = file;
      if (!blob) {
        const res = await fetch(imageUrl);
        if (!res.ok) throw new Error("Couldn't load that image. Save it and use Upload instead.");
        blob = await res.blob();
      }
      const base64 = await blobToSearchBase64(blob);
      if (prefs.searchAmazon) startAmazonSearch(search, base64);
      else search.amazon = { state: "off", items: [], totalAsins: 0, base64 };
      const blocked = prefs.searchAmazon ? ebayBlockedForAmazonHunt() : "";
      if (!prefs.searchEbay || blocked) {
        search.ebayOff = blocked || true;
        search.message = blocked === "no-account" ? "Searched Amazon only (no eBay account in setup)." : blocked ? "Searched Amazon only (eBay isn't connected yet)." : "Searched Amazon only (eBay is off in the menu).";
        clearInterval(search.creep);
        search.state = "done";
        search.view = "amazon";
        if (popup && popup.tab === "results") renderResultsView();
        updateTabCounts();
        return;
      }
      if (!stage(1, "Scanning your design…", 24, 64)) return;
      const slow = setTimeout(() => {
        if (lastSearch === search && search.state === "loading") { search.message = "Still waiting for eBay…"; updateProgressUI(); }
      }, 20000);
      let guid;
      try { guid = await withDeadline(postVisualSearch(base64), HUNT_STEP_MS, HUNT_SLOW_MSG); }
      finally { clearTimeout(slow); }
      search.guid = guid;
      if (!stage(2, "Finding look-alike listings…", 66, 94)) return;
      const { items, hasMore } = await withDeadline(fetchResultsPage(guid, 1), HUNT_STEP_MS, HUNT_SLOW_MSG);
      if (lastSearch !== search) return;
      addSearchItems(search, items);
      search.hasMore = hasMore;
      stage(3, `Found ${search.items.length} matches`, 100, 100);
      await new Promise((r) => setTimeout(r, 350));
      if (lastSearch !== search) return;
      clearInterval(search.creep);
      search.state = "done";
      if (popup && popup.tab === "results") {
        renderResultsView();
        setTimeout(jumpToMine, 200);
      }
      updateTabCounts();
    } catch (err) {
      clearInterval(search.creep);
      if (lastSearch !== search) return;
      retryAfterEbayPause(err, "search", () => search.amazon?.base64 ? retryEbay() : startSearch({ imageUrl, file, itemNumber, designAsin, huntTitle }), () => lastSearch === search);
      if (await isConnectionProblem(err)) {
        search.state = "offline";
        search.message = "No internet connection";
        retryWhenOnline("search", () => {
          if (lastSearch === search) startSearch({ imageUrl, file, itemNumber, designAsin, huntTitle });
        });
      } else {
        search.state = "error";
        search.message =
          err && /Failed to fetch|NetworkError|CORS/i.test(String(err.message))
            ? "Couldn't read that image. Save it to your computer and use Upload instead."
            : (err && err.message) || "Something went wrong with the image search. Try again.";
        if (search.amazon && search.amazon.state !== "idle" && search.amazon.state !== "unavailable") {
          search.needsEbayTab = err?.code === "EBAY_NEEDS_TAB";
          search.ebayError = search.needsEbayTab ? search.message : SITE === "amazon" && /Failed to fetch|couldn't be read|\(403\)|\(429\)/i.test(search.message)
            ? "eBay didn't let the search through from this page. Press Try again, or search from an eBay page."
            : search.message;
          search.state = "done";
          search.view = search.amazon.state === "off" ? "ebay" : "amazon";
          search.retry = !!(search.amazon && search.amazon.base64);
        }
      }
      if (popup && popup.tab === "results") renderResultsView();
    }
  }

  function amazonAvailable() {
    return typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function" && !!chrome.runtime.id;
  }

  function startAmazonSearch(search, base64) {
    if (!amazonAvailable()) {
      search.amazon = { state: "unavailable", items: [], totalAsins: 0 };
      return;
    }
    const run = {};
    search.amazon = { state: "loading", items: [], totalAsins: 0, base64, run };
    refreshAmazonView();
    let answered = false;
    const timer = setTimeout(() => {
      if (answered || lastSearch !== search || search.amazon.run !== run) return;
      answered = true;
      search.amazon = { ...search.amazon, state: "error", message: "Amazon took too long to answer." };
      refreshAmazonView();
    }, 45000);
    try {
      chrome.runtime.sendMessage({ type: "eif-amazon-search", base64, mime: "image/jpeg", marketplace: search.marketplace || "US" }, (res) => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (lastSearch !== search || search.amazon.run !== run) return;
        if (err || !res) search.amazon = { ...search.amazon, state: "error", message: "Couldn't reach the Amazon search. Reload the extension and try again." };
        else if (res.ok) {
          (res.items || []).forEach((i) => asinMarket.set(i.asin, search.marketplace || "US"));
          search.amazon = { ...search.amazon, state: "done", items: res.items || [], totalAsins: res.totalAsins || 0 };
          search.amazonText = null;
          queueTestSet(search);
          queueScore(search);
          maybeStartTextCheck(search);
          loadAmazonRest(search, run, res.rest);
        }
        else if (res.error === "blocked") search.amazon = { ...search.amazon, state: "blocked" };
        else if (res.error === "network") search.amazon = { ...search.amazon, state: "error", message: "No internet connection." };
        else search.amazon = { ...search.amazon, state: "error", message: "Amazon's look-alike search didn't work this time." };
        refreshAmazonView();
      });
    } catch (e) {
      answered = true;
      clearTimeout(timer);
      search.amazon = { ...search.amazon, state: "error", message: "Couldn't reach the Amazon search. Reload the extension and try again." };
    }
  }

  async function loadAmazonRest(search, run, rest) {
    const asins = (Array.isArray(rest) ? rest : []).filter((a) => !(search.amazon.items || []).some((i) => i.asin === a));
    if (!asins.length) return;
    search.amazon.more = { state: "loading" };
    refreshAmazonView();
    const res = await Promise.race([bgSend({ type: "eif-amazon-asins", asins, marketplace: search.marketplace || "US" }), new Promise((r) => setTimeout(() => r(null), 90000))]);
    if (lastSearch !== search || search.amazon.run !== run) return;
    const have = new Set((search.amazon.items || []).map((i) => i.asin));
    const add = res && res.ok ? (res.items || []).filter((i) => !have.has(i.asin)) : [];
    add.forEach((i) => asinMarket.set(i.asin, search.marketplace || "US"));
    const removed = res && res.ok ? (res.removed || []).length : 0;
    search.amazon = { ...search.amazon, items: [...search.amazon.items, ...add], more: { state: res && res.ok && !res.blocked ? "done" : "partial", removed, failed: asins.length - add.length - removed } };
    refreshAmazonView();
    if (add.length) queueTestSet(search);
    queueScore(search);
  }

  let huntStoppedAt = 0;
  function stopHunt() {
    const search = lastSearch;
    if (!search) return;
    huntStoppedAt = Date.now();
    clearInterval(search.creep);
    search.state = "stopped";
    if (search.amazon) search.amazon.run = null;
    search.ebayRun = null;
    if (search.objectUrl) URL.revokeObjectURL(search.objectUrl);
    lastSearch = null;
    if (popup && popup.tab === "results") renderResultsView();
    updateTabCounts();
    showToast("Search stopped");
  }
  function stopAmazonSearch() {
    const search = lastSearch;
    if (!search || !search.amazon) return;
    if (search.ebayOff || search.state !== "done") return stopHunt();
    search.amazon = { state: "stopped", items: [], totalAsins: 0, base64: search.amazon.base64 };
    refreshAmazonView();
    if (lastSearch.view === "amazon") renderAmazonGrid();
  }
  function stopEbayRetry() {
    const search = lastSearch;
    if (!search || !search.ebayRetrying) return;
    huntStoppedAt = Date.now();
    search.ebayRun = null;
    search.ebayRetrying = false;
    Object.assign(search, search.ebayBefore || {});
    if (!search.ebayOff && !search.ebayError) { search.ebayError = "You stopped the eBay search."; search.retry = true; }
    if (popup && popup.tab === "results") renderResultsView();
  }

  async function retryEbay() {
    const search = lastSearch;
    if (!search || !search.amazon || !search.amazon.base64 || search.ebayRetrying) return;
    search.ebayRetrying = true;
    const run = (search.ebayRun = {});
    const before = { ebayOff: search.ebayOff, ebayError: search.ebayError, needsEbayTab: search.needsEbayTab, retry: search.retry };
    search.ebayBefore = before;
    search.ebayOff = false;
    const grid = popup && popup.overlay.querySelector("#eif-hunt-grid");
    if (grid && search.view !== "amazon") grid.innerHTML = `<div class="eif-center eif-amz-card eif-ebay-wait"><div class="eif-progress-card">
          <div class="eif-progress-top">${LOADER() || '<div class="eif-spinner eif-spinner-sm"></div>'}<span id="eif-amz-text">Searching eBay again…</span>${STOP_BTN("ebay-stop")}</div>
          <div class="eif-progress eif-progress-indet"><div class="eif-progress-fill"></div></div>
        </div></div>`;
    const sw = popup && popup.overlay.querySelector("#eif-src-switch");
    if (sw) sw.outerHTML = sourceSwitchHtml(search);
    try {
      const guid = await withDeadline(postVisualSearch(search.amazon.base64), HUNT_STEP_MS, HUNT_SLOW_MSG);
      if (search.ebayRun !== run) return;
      const { items, hasMore } = await withDeadline(fetchResultsPage(guid, 1), HUNT_STEP_MS, HUNT_SLOW_MSG);
      if (lastSearch !== search || search.ebayRun !== run) return;
      search.guid = guid;
      addSearchItems(search, items);
      search.hasMore = hasMore;
      search.ebayError = null;
      search.needsEbayTab = false;
    } catch (err) {
      if (lastSearch !== search || search.ebayRun !== run) return;
      retryAfterEbayPause(err, "search", retryEbay, () => lastSearch === search);
      const msg = (err && err.message) || "";
      search.needsEbayTab = err?.code === "EBAY_NEEDS_TAB";
      search.ebayError = search.needsEbayTab ? msg : /Failed to fetch|\(403\)|\(429\)/i.test(msg)
        ? "eBay still didn't let the search through from this page. Try again in a minute, or search from an eBay page."
        : msg || "The eBay search failed. Try again.";
    } finally {
      if (search.ebayRun === run) search.ebayRetrying = false;
    }
    if (search.ebayRun !== run) return;
    if (popup && popup.tab === "results") renderResultsView();
    updateTabCounts();
  }

  function retryAmazon() {
    const search = lastSearch;
    if (!search || !search.amazon || !search.amazon.base64) return;
    startAmazonSearch(search, search.amazon.base64);
  }

  function refreshAmazonView() {
    if (!popup || popup.tab !== "results" || !lastSearch) return;
    updateTabCounts();
    const sw = popup.overlay.querySelector("#eif-src-switch");
    if (sw) sw.outerHTML = sourceSwitchHtml(lastSearch);
    if (lastSearch.view === "amazon" && lastSearch.state === "done") renderAmazonGrid();
  }

  function amazonCount(search) {
    return search && search.amazon && search.amazon.state === "done" && !amazonWaiting(search.amazon) ? search.amazon.items.length : 0;
  }

  function amazonWaiting(a) {
    return !!a && (a.state === "loading" || a.state === "idle" || (a.state === "done" && !!a.more && a.more.state === "loading"));
  }

  function sourceSwitchHtml(search) {
    const a = search.amazon || { state: "idle" };
    const amzLabel =
      amazonWaiting(a) ? '<span class="eif-src-spin"></span>' :
      a.state === "done" ? `<span class="eif-src-n">${a.items.length}</span>` :
      a.state === "blocked" || a.state === "error" ? '<span class="eif-src-n eif-src-warn">!</span>' :
      a.state === "unavailable" || a.state === "stopped" ? '<span class="eif-src-n">–</span>' :
      a.state === "off" ? '<span class="eif-src-n eif-src-off">off</span>' : "";
    const ebayBtn = `<button type="button" role="tab" data-action="src" data-src="ebay" class="${search.view !== "amazon" ? "eif-src-on" : ""}"><i class="eif-site-dot" aria-hidden="true"></i>eBay ${search.ebayRetrying ? '<span class="eif-src-spin"></span>' : search.ebayOff ? '<span class="eif-src-n eif-src-off">off</span>' : search.ebayError ? '<span class="eif-src-n eif-src-warn">!</span>' : `<span class="eif-src-n">${search.state === "done" ? search.items.length : "…"}</span>`}</button>`;
    const amzBtn = `<button type="button" role="tab" data-action="src" data-src="amazon" class="${search.view === "amazon" ? "eif-src-on" : ""}"><i class="eif-site-dot" aria-hidden="true"></i>Amazon ${amzLabel}</button>`;
    return `
      <div id="eif-src-switch" role="tablist" aria-label="Marketplace">
        ${SITE === "amazon" ? amzBtn + ebayBtn : ebayBtn + amzBtn}
        <div id="eif-hj-pill" class="eif-hj-pill" aria-live="polite">${search.view === "amazon" ? textPillHtml(search) : ""}</div>
      </div>`;
  }

  function amazonCardHtml(item, index) {
    return `
      <div class="eif-hc eif-hc-amz" data-asin="${escapeHtml(item.asin)}">
        <a class="eif-hc-img" href="${safeHref(item.url)}" target="_blank" rel="noopener" aria-label="Open Amazon product ${escapeHtml(item.asin)}">
          ${item.image ? `<img src="${safeSrc(amazonSharp(item.image))}" alt="" loading="lazy" />` : ""}
        </a>
        <span class="eif-hc-rank">${index + 1}</span>
        <span class="eif-hc-tag" hidden></span>
        <span class="eif-hc-hj" hidden></span>
        <span class="eif-hc-num">${escapeHtml(item.asin)}</span>
        <button class="eif-hc-track" type="button" data-action="amz-track"></button>
        <button class="eif-hc-mine-btn" type="button" data-action="amz-mine"></button>
      </div>`;
  }

  function amazonSharp(url) {
    const big = (window.devicePixelRatio || 1) > 1.25 ? 800 : 500;
    const m = String(url || "").match(/^https:\/\/m\.media-amazon\.com\/images\/I\/([^./]+)\.[^/]*$/);
    return m ? `https://m.media-amazon.com/images/I/${m[1]}._AC_SL${big}_.jpg` : url;
  }

  function renderAmazonGrid() {
    const grid = popup && popup.overlay.querySelector("#eif-hunt-grid");
    const more = popup && popup.overlay.querySelector("#eif-more");
    if (!grid || !lastSearch) return;
    merchLookupAsins([lastSearch.asin]);
    const a = lastSearch.amazon || { state: "idle" };
    if (more) more.innerHTML = "";
    if (amazonWaiting(a)) {
      const step = a.state === "done" ? 2 : 1;
      const card = grid.querySelector(".eif-amz-progress");
      if (!card) grid.innerHTML = amazonProgressHtml("Searching Amazon for look-alikes…", step, lastSearch.startedAt, 22, 95, 9000, "amz-stop");
      else card.querySelectorAll(".eif-progress-steps li").forEach((li) => {
        const i = Number(li.dataset.step);
        li.className = i < step ? "eif-step-done" : i === step ? "eif-step-active" : "";
      });
    } else if (a.state === "blocked") {
      const mp = lastSearch.marketplace || "US";
      const site = escapeHtml(AZ.marketplaceLabel(mp));
      grid.innerHTML = `<div class="eif-hunt-empty eif-amz-msg">
          <b>Amazon didn't let the search through.</b>
          <div>This usually means your browser hasn't visited ${site} yet, or Amazon wants a quick robot check. Open ${site} once (signing in helps), then press Try again.</div>
          <div class="eif-amz-btns"><a class="eif-hunt-btn eif-hunt-btn-primary" href="https://${escapeHtml(AZ.MARKETPLACES[mp].host)}/" target="_blank" rel="noopener">Open ${site}</a> <button class="eif-hunt-btn" type="button" data-action="amz-retry">Try again</button></div>
        </div>`;
    } else if (a.state === "error") {
      grid.innerHTML = `<div class="eif-hunt-empty eif-amz-msg"><b>${escapeHtml(a.message || "Amazon search failed.")}</b><div class="eif-amz-btns"><button class="eif-hunt-btn" type="button" data-action="amz-retry">Try again</button></div></div>`;
    } else if (a.state === "off") {
      grid.innerHTML = `<div class="eif-hunt-empty eif-amz-msg"><b>Amazon isn't searched automatically.</b><div>You turned it off in the Copycat Hunt menu (toolbar icon).</div><div class="eif-amz-btns"><button class="eif-hunt-btn eif-hunt-btn-primary" type="button" data-action="amz-retry">Search Amazon for this image</button></div></div>`;
    } else if (a.state === "stopped") {
      grid.innerHTML = `<div class="eif-hunt-empty eif-amz-msg"><b>You stopped the Amazon search.</b><div class="eif-amz-btns"><button class="eif-hunt-btn eif-hunt-btn-primary" type="button" data-action="amz-retry">Search Amazon again</button></div></div>`;
    } else if (a.state === "unavailable") {
      grid.innerHTML = '<div class="eif-hunt-empty eif-amz-msg">Amazon search isn\u2019t available in this build. Reload the extension from chrome://extensions.</div>';
    } else if (!a.items.length) {
      grid.innerHTML = '<div class="eif-hunt-empty">Amazon found no look-alike products for this image.</div>';
    } else {
      grid.innerHTML = a.items.map(amazonCardHtml).join("");
      merchLookupAsins([lastSearch.asin, ...a.items.map((i) => i.asin)]);
      refreshAmazonCards();
    }
    renderResultsStatus();
    updateTabCounts();
  }

  function refreshAmazonCards() {
    updatePickBar();
    if (!popup || !lastSearch || lastSearch.view !== "amazon") return;
    if (lastSearch.hjFilter && !textFlagged(lastSearch, lastSearch.hjFilter).length) lastSearch.hjFilter = "";
    popup.overlay.querySelectorAll(".eif-hc-amz").forEach((card) => {
      const asin = card.dataset.asin;
      const inCatalog = merchIsOwn(asin);
      const mine = amazonMine.has(asin) || inCatalog;
      const searched = !mine && lastSearch.asin === asin;
      const tracked = !mine && amazonActiveTracked(asin);
      const lock = !mine && !tracked ? amazonLock(asin) : null;
      card.classList.toggle("eif-hc-mine", mine);
      card.classList.toggle("eif-hc-searched", searched);
      card.classList.toggle("eif-hc-tracked", tracked);
      const tag = card.querySelector(".eif-hc-tag");
      tag.textContent = inCatalog ? "In your Merch catalog" : mine ? "Your product" : searched ? "Searched product" : "";
      tag.hidden = !(mine || searched);
      const t = card.querySelector(".eif-hc-track");
      t.disabled = mine || !!lock;
      t.textContent = mine ? "Yours" : tracked ? "✓ Copycat" : lock ? "Reported · waiting" : "Copycat";
      t.dataset.ic = mine || tracked || lock ? "" : "bookmark";
      t.title = mine ? "Your own product can't be a copycat" : tracked ? "Not a copy? Take it off your copycats" : lock ? `${lockText(lock)}. Amazon asks not to report the same listing twice.` : "Mark this look-alike as a copycat";
      const hj = card.querySelector(".eif-hc-hj");
      const T = lastSearch.amazonText;
      const r = !mine && T && T.results && T.results.get(asin);
      const waiting = !mine && T && (T.state === "reading" || T.state === "loading") && T.pending && T.pending.has(asin);
      const filter = lastSearch.hjFilter;
      card.hidden = !!filter && !(r && r.category === filter);
      if (hj) {
        hj.hidden = !r && !waiting;
        hj.className = `eif-hc-hj${r ? ` eif-hj-${r.category}` : waiting ? " eif-hj-wait" : ""}`;
        hj.textContent = r ? hijackBadgeText(r) : "";
        hj.removeAttribute("title");
      }
      const m = card.querySelector(".eif-hc-mine-btn");
      m.textContent = mine ? "Not mine" : "This is mine";
      m.title = mine ? "Unmark this product" : "Mark this as your own product. It becomes your Amazon original in the Report tab.";
    });
    maybeStartTextCheck(lastSearch);
    updateTextPill();
    const head = popup.overlay.querySelector(".eif-results-title");
    if (head && lastSearch.asin && !lastSearch.itemNumber) {
      head.innerHTML = `${amazonSourceTitle(lastSearch.asin)} <span class="eif-hunt-source">${escapeHtml(lastSearch.asin)}</span>`;
    }
    renderResultsStatus();
    paintScores();
  }

  const HJ_TEXT_MAX = 60;
  const HJ_LABELS = { full: "Full hijack", title: "Title copied", part: "Part copied" };
  const FIELD_NAMES = { title: "title", brand: "brand", bullets: "bullets", description: "description" };

  function amazonIsMine(asin) {
    return !!asin && (amazonMine.has(asin) || merchIsOwn(asin));
  }

  function maybeStartTextCheck(search) {
    if (!search || !AZ) return;
    const a = search.amazon;
    if (!a || a.state !== "done" || !a.items.length || !search.asin) return;
    const s = search.amazonText && search.amazonText.state;
    if (s && s !== "not-yours" && s !== "manual" && s !== "owner-check") return;
    if (s === "manual" && !search.textCheckAsked) return;
    if (!amazonIsMine(search.asin) && !search.textCheckAsked) {
      setTextState(search, sourceOwnerPending(search) ? "owner-check" : "not-yours");
      return;
    }
    if (!prefs.autoTextCheck && !search.textCheckAsked) {
      setTextState(search, "manual");
      return;
    }
    runTextCheck(search);
  }

  function setTextState(search, state) {
    const prev = search.amazonText && search.amazonText.state;
    search.amazonText = { state };
    if (prev !== state && search === lastSearch) updateTextPill();
  }

  function sourceOwnerPending(search) {
    if (!merchConnected()) return false;
    const asin = search.asin;
    if (search.ownerRechecking) return true;
    if (merchPending.has(asin) || merchQueue.has(asin)) return true;
    const r = merchResult(asin);
    if (!r) {
      merchLookupAsins([asin]);
      return merchPending.has(asin) || merchQueue.has(asin);
    }
    if (r.state === "catalog_matched" || search.ownerRechecked) return false;
    search.ownerRechecked = true;
    search.ownerRechecking = true;
    recheckSourceOwner(search);
    return true;
  }

  async function recheckSourceOwner(search) {
    const asin = search.asin;
    const key = `${mpOfAsin(asin)}|${asin}`;
    try {
      const prev = merchResult(asin);
      const d = await loadAmazonDetails(asin);
      const L = d && d.listing;
      const revision = merchRevisionSeen;
      const res = await bgSend({ type: "eif-merch-lookup", items: [{ asin, marketplace: mpOfAsin(asin), pageAsins: (L && L.pageAsins) || [] }], fresh: !!prev && prev.state === "unknown" });
      if (revision === merchRevisionSeen && res && res.ok && res.results && res.results[key]) merchResults.set(key, res.results[key]);
    } finally {
      search.ownerRechecking = false;
      if (search.amazonText && search.amazonText.state === "owner-check") search.amazonText = null;
      if (lastSearch === search && popup && popup.tab === "results" && search.view === "amazon") refreshAmazonCards();
      else maybeStartTextCheck(search);
      if (lastSearch === search) updateTextPill();
    }
  }

  async function runTextCheck(search) {
    const asins = search.amazon.items.map((i) => i.asin).filter((x) => x && x !== search.asin && !amazonIsMine(x)).slice(0, HJ_TEXT_MAX);
    const T = (search.amazonText = { state: "reading", done: 0, total: asins.length, results: new Map(), listings: new Map(), read: new Set(), pending: new Set(asins) });
    const redraw = () => {
      if (lastSearch !== search || !popup || popup.tab !== "results") return;
      updateTextPill();
      if (search.view === "amazon") refreshAmazonCards();
    };
    redraw();
    const me = await loadAmazonDetails(search.asin, true);
    const mine = me && me.listing;
    if (lastSearch !== search) return;
    if (!mine || mine.state !== "ready") {
      T.state = mine && mine.state === "blocked" ? "blocked" : "error";
      return redraw();
    }
    T.mineTitle = String(mine.title || "");
    T.state = "loading";
    redraw();
    let blocked = false;
    await mapLimit(asins, 2, async (asin) => {
      if (blocked || lastSearch !== search) return;
      const d = await loadAmazonDetails(asin);
      const L = d && d.listing;
      if (L && L.state === "blocked") blocked = true;
      if (L && L.state === "ready") T.listings.set(asin, L);
      T.read.add(asin);
      T.done++;
      redraw();
    });
    if (lastSearch !== search) return;
    const cmp = await compareRemote(mine, [...T.listings.entries()].map(([id, L]) => ({ id, L })), [...T.listings.values()].map((L) => L.title));
    if (lastSearch !== search) return;
    if (!cmp.ok) {
      T.state = "compare-error";
      T.message = cmp.message;
      return redraw();
    }
    T.listings.forEach((L, asin) => {
      const r = cmp.results[asin];
      if (r && r.category) T.results.set(asin, r);
    });
    T.state = blocked ? "partial" : "done";
    let changed = false;
    T.results.forEach((r, asin) => {
      const m = amazonTracked.get(asin);
      if (m && r.category && String(m.copied) !== String(r.copied)) { m.copied = r.copied.slice(); changed = true; }
    });
    if (changed) saveAmazon();
    redraw();
  }

  async function compareRemote(mine, items, titles) {
    const slim = (L) => ({ title: L.title || "", brand: L.brand || "", bullets: Array.isArray(L.bullets) ? L.bullets : [], description: L.description || "" });
    const r = await bgSend({ type: "eif-text-compare", mine: slim(mine), others: items.slice(0, 60).map(({ id, L }) => ({ id, ...slim(L) })), titles: (titles || []).slice(0, 200) });
    if (r && r.ok) return r;
    const why = !r
      ? "Copycat Hunt didn't answer. Reload the page."
      : r.error === "license"
        ? "your license needs checking. Open the Copycat Hunt menu."
        : r.error === "license-server"
          ? r.reason === "stale" ? "connect to the internet so your license can be checked." : "the server didn't accept this license."
          : r.error === "busy"
            ? "too many checks in a short time. Try again in a few minutes."
            : "couldn't reach the Copycat Hunt server. Try again in a moment.";
    return { ok: false, message: `Listing text not compared: ${why}` };
  }

  function hijackBadgeText(r) {
    if (r.category === "part") return `${r.copied.map((x) => FIELD_NAMES[x]).join(" + ")} copied`.replace(/^./, (c) => c.toUpperCase());
    if (r.category === "title" && r.copied.length > 1) return `Title + ${r.copied.filter((x) => x !== "title").map((x) => FIELD_NAMES[x]).join(" + ")}`;
    return HJ_LABELS[r.category];
  }

  function textPillHtml(search) {
    const T = search && search.amazonText;
    if (!T) return "";
    if (T.state === "owner-check") return '<span class="eif-hj-spin" aria-hidden="true"></span><span>Checking if this product is yours…</span>';
    if (T.state === "not-yours") {
      const why = merchConnected() ? "Not in your Merch catalog" : "Not marked as yours";
      return `<span class="eif-hj-muted" title="The listing text is checked automatically only for your own products. Mark it with \u201cThis is mine\u201d on its card, or compare now.">${why}</span><button type="button" class="eif-hj-link" data-action="hj-text-run" title="Compare these look-alikes' title, brand and bullets with this listing">Check listing text</button>`;
    }
    if (T.state === "manual") return `<button type="button" class="eif-hj-link" data-action="hj-text-run" title="Compare these look-alikes' title, brand and bullets with yours">Check listing text</button>`;
    const spin = LOADER() || '<span class="eif-hj-spin" aria-hidden="true"></span>';
    if (T.state === "reading") return `${spin}<span>Reading ${amazonIsMine(search.asin) ? "your" : "this"} listing…</span>`;
    if (T.state === "loading") {
      const pct = T.total ? Math.round((T.done / T.total) * 100) : 0;
      return `${spin}<span>Checking listing text <b><span data-hj-done>${T.done}</span> / ${T.total}</b></span><i class="eif-hj-bar" style="width:${pct}%"></i>`;
    }
    if (T.state === "compare-error") {
      return `<span class="eif-hj-warn">!</span><span>${escapeHtml(T.message || "Listing text not compared.")}</span><button type="button" class="eif-hj-link" data-action="hj-retry">Retry</button>`;
    }
    if (T.state === "blocked" || T.state === "error") {
      return `<span class="eif-hj-warn">!</span><span>${T.state === "blocked" ? "Amazon robot check: listing text not compared" : `Couldn't read ${amazonIsMine(search.asin) ? "your" : "this"} listing`}</span><button type="button" class="eif-hj-link" data-action="hj-retry">Retry</button>`;
    }
    const c = (k) => textFlagged(search, k).length;
    const f = search.hjFilter;
    const counts = [["full", "full"], ["title", "title"], ["part", "part"]]
      .filter(([k]) => c(k))
      .map(([k, label]) => `<button type="button" class="eif-hj-count eif-hj-c-${k} ${f === k ? "eif-on" : ""}" data-action="hj-filter" data-cat="${k}" title="${f === k ? "Show all look-alikes" : `Show only: ${HJ_LABELS[k]}`}"><i></i>${c(k)} ${label}</button>`)
      .join("");
    const stopped = T.state === "partial" ? `<span class="eif-hj-warn" title="Amazon asked for a robot check, so some weren't read">!</span><span>Stopped at ${T.done} / ${T.total}</span><button type="button" class="eif-hj-link" data-action="hj-retry">Retry</button>` : "";
    if (!counts) return stopped || `<span class="eif-hj-ok">✓</span><span>No copied text in ${T.listings.size} listings</span>`;
    return `<span class="eif-hj-ok">✓</span><span>Text checked</span>${counts}${stopped}${trackAllHtml(search)}${f ? '<button type="button" class="eif-hj-link" data-action="hj-filter" data-cat="">Show all</button>' : ""}`;
  }

  function textFlagged(search, cat) {
    const T = search && search.amazonText;
    if (!T || !T.results) return [];
    const onPage = new Set(((search.amazon && search.amazon.items) || []).map((i) => i.asin));
    return [...T.results.entries()].filter(([asin, r]) => r && r.category && (!cat || r.category === cat) && onPage.has(asin) && !amazonIsMine(asin)).map(([asin]) => asin);
  }
  function textTrackable(search, cat) {
    return textFlagged(search, cat).filter((asin) => !amazonActiveTracked(asin) && !amazonLock(asin));
  }
  function trackAllHtml(search) {
    const f = search.hjFilter || "";
    const flagged = textFlagged(search, f);
    if (!flagged.length) return "";
    const n = textTrackable(search, f).length;
    const undo = search.hjUndo && search.hjUndo.until > Date.now() ? '<button type="button" class="eif-hj-link" data-action="hj-track-undo">Undo</button>' : "";
    if (!n) return `<span class="eif-hj-alltracked">${flagged.length === 1 ? "Copycat" : `All ${flagged.length} are copycats`} ✓</span>${undo}`;
    return `<button type="button" class="eif-hj-trackall" data-action="hj-track-all" title="Mark ${n === 1 ? "this look-alike" : `these ${n} look-alikes`} as copycats">${n === 1 ? (f ? "Mark as copycat" : "Mark the flagged one") : f ? `Mark all ${n} as copycats` : `Mark all flagged (${n})`}</button>`;
  }
  function trackAllFlagged() {
    const search = lastSearch;
    if (!search) return;
    const list = textTrackable(search, search.hjFilter || "");
    if (!list.length) return;
    const added = [];
    for (const asin of list) {
      const before = amazonTracked.get(asin);
      addAmazonTracked(asin);
      if (amazonActiveTracked(asin)) added.push({ asin, before });
    }
    saveAmazon();
    search.hjUndo = { added, until: Date.now() + 8000 };
    setTimeout(() => { if (lastSearch === search && search.hjUndo && search.hjUndo.until <= Date.now()) updateTextPill(); }, 8100);
    updatePanel();
    updateTabCounts();
    refreshAmazonCards();
    updateTextPill();
    showToast(`${added.length} look-alike${added.length === 1 ? "" : "s"} marked as copycat${added.length === 1 ? "" : "s"}`);
  }
  function undoTrackAll() {
    const search = lastSearch;
    const u = search && search.hjUndo;
    if (!u) return;
    for (const { asin, before } of u.added) {
      if (before) amazonTracked.set(asin, before);
      else amazonTracked.delete(asin);
    }
    search.hjUndo = null;
    saveAmazon();
    updatePanel();
    updateTabCounts();
    refreshAmazonCards();
    updateTextPill();
    showToast(`Removed ${u.added.length} from the copycat list`);
  }

  function updateTextPill() {
    const el = popup && popup.overlay.querySelector("#eif-hj-pill");
    const T = lastSearch && lastSearch.amazonText;
    const doneEl = el && el.querySelector("[data-hj-done]");
    if (doneEl && T && T.state === "loading" && lastSearch.view === "amazon") {
      M.count(doneEl, T.done);
      const bar = el.querySelector(".eif-hj-bar");
      if (bar) bar.style.width = `${T.total ? Math.round((T.done / T.total) * 100) : 0}%`;
    } else if (el && lastSearch) {
      const html = lastSearch.view === "amazon" ? textPillHtml(lastSearch) : "";
      if (el._eifHtml !== html) { el.innerHTML = html; el._eifHtml = html; }
      if (T && (T.state === "done" || T.state === "partial") && !T._shown && lastSearch.view === "amazon") {
        T._shown = true;
        M.enterMany(el.querySelectorAll(".eif-hj-count"));
        requestAnimationFrame(() => M.enterMany(popup.overlay.querySelectorAll(".eif-hc-amz:not([hidden]) .eif-hc-hj:not([hidden])")));
      }
    }
    const btn = popup && popup.overlay.querySelector("#eif-azhj-head-btn");
    if (btn && lastSearch) btn.hidden = azHijackAlreadyRun(lastSearch);
  }

  function azHijackAlreadyRun(search) {
    if (!search || !search.asin) return false;
    const T = search.amazonText;
    if (T && (T.state === "done" || T.state === "partial")) return true;
    return !!(lastAzHijack && lastAzHijack.asin === search.asin && lastAzHijack.state === "done");
  }

  const AZHJ_PAGES = 40;
  const AZHJ_STEPS = ["Read your listing", "Search Amazon", "Read listings", "Compare"];
  let hijackSite = SITE === "amazon" ? "amazon" : "ebay";
  let lastAzHijack = null;

  async function merchCheckNow(asins) {
    if (!merchConnected() || !asins.length) return;
    const res = await bgSend({ type: "eif-merch-lookup", items: asins.map((asin) => ({ asin, marketplace: mpOfAsin(asin), pageAsins: [] })) });
    if (res && res.ok) Object.entries(res.results || {}).forEach(([k, v]) => merchResults.set(k, v));
  }

  async function startAmazonHijackCheck(asin) {
    asin = AZ.normalizeAsin(asin);
    if (!asin) return showToast("Enter a valid ASIN");
    asinMarket.set(asin, "US");
    const check = { id: `${Date.now()}`, asin, state: "loading", stage: 0, progress: 4, message: "Reading your listing…", mine: null, matches: [], common: [], searched: 0, read: 0, found: 0, notes: [] };
    lastAzHijack = check;
    hijackSite = "amazon";
    closeMini();
    openPopup("hijacks");
    const alive = () => lastAzHijack === check;
    const stage = (i, msg, pct) => {
      if (!alive()) return false;
      check.stage = i;
      check.message = msg;
      check.progress = Math.max(check.progress, pct);
      updateAzHijackProgress();
      return true;
    };
    try {
      const me = await loadAmazonDetails(asin, true);
      const mine = me && me.listing;
      if (!alive()) return;
      if (!mine || mine.state !== "ready") {
        check.state = "error";
        check.message = mine && mine.state === "blocked" ? "Amazon asked for a robot check. Open amazon.com, then press Re-check." : mine && mine.state === "missing" ? "That product page doesn't exist." : "Couldn't read your product page. Try again.";
        return renderHijackView();
      }
      check.mine = mine;
      registerHunt(`amz:${asin}`, { label: `${mine.title.slice(0, 70)} (${asin})`, image: mine.image || "" });

      const queries = AZ.hijackQueries(mine);
      const pool = new Map();
      let blocked = false;
      for (let i = 0; i < queries.length; i++) {
        if (!stage(1, `Searching Amazon (${i + 1} of ${queries.length}): ${queries[i].kind === "brand" ? "your brand" : queries[i].kind === "bullets" ? "your bullet text" : "your title"}…`, 12 + i * 12)) return;
        const res = await bgSend({ type: "eif-amazon-keywords", query: queries[i].q });
        if (!alive()) return;
        if (!res || res.error) {
          if (res && res.error === "blocked") { blocked = true; break; }
          check.notes.push(`One search didn't answer (${(res && res.error) || "no reply"}).`);
          continue;
        }
        check.searched++;
        res.items.forEach((it) => {
          const cur = pool.get(it.asin) || { ...it, foundBy: [] };
          if (!cur.foundBy.includes(queries[i].kind)) cur.foundBy.push(queries[i].kind);
          pool.set(it.asin, cur);
        });
      }
      if (!pool.size) {
        check.state = blocked ? "blocked" : "error";
        check.message = blocked ? "Amazon asked for a robot check before the search finished." : "Amazon's search didn't return anything.";
        return renderHijackView();
      }

      pool.delete(asin);
      await merchCheckNow([...pool.keys()]);
      if (!alive()) return;
      [...pool.keys()].forEach((a) => amazonIsMine(a) && pool.delete(a));
      const all = [...pool.values()];
      const titlesForCommon = all.map((i) => i.title).slice(0, 200);
      check.common = [];
      all.forEach((it) => (it.quick = AZ.quickTitleScore(mine.title, it.title)));
      const shortlist = all
        .filter((it) => it.quick >= 0.45 || it.foundBy.includes("brand") || it.foundBy.includes("bullets"))
        .sort((a, b) => b.quick - a.quick)
        .slice(0, AZHJ_PAGES);
      check.found = all.length;

      if (!stage(2, `Reading listings: 0 of ${shortlist.length}`, 50)) return;
      let pageBlocked = false;
      await mapLimit(shortlist, 2, async (it) => {
        if (pageBlocked || !alive()) return;
        if (!amazonTracked.has(it.asin)) asinMarket.set(it.asin, "US");
        const d = await loadAmazonDetails(it.asin);
        const L = d && d.listing;
        if (L && L.state === "blocked") pageBlocked = true;
        if (L && L.state === "ready") it.listing = L;
        check.read++;
        if (alive()) {
          check.message = `Reading listings: ${check.read} of ${shortlist.length}`;
          check.progress = Math.max(check.progress, 50 + (check.read / Math.max(1, shortlist.length)) * 42);
          updateAzHijackProgress();
        }
      });
      if (!alive()) return;

      stage(3, "Comparing…", 96);
      const withListing = shortlist.filter((it) => it.listing);
      const cmp = await compareRemote(mine, withListing.map((it) => ({ id: it.asin, L: it.listing })), titlesForCommon);
      if (!alive()) return;
      if (!cmp.ok) {
        check.state = "error";
        check.message = cmp.message;
        return renderHijackView();
      }
      check.common = cmp.common;
      const matches = [];
      withListing.forEach((it) => {
        const r = cmp.results[it.asin];
        if (!r) return;
        it.result = r;
        it.brand = it.listing.brand || "";
        if (!it.image && it.listing.image) it.image = it.listing.image;
        matches.push(it);
      });
      const rank = { full: 3, title: 2, part: 1, "": 0 };
      matches.sort((a, b) => rank[b.result.category] - rank[a.result.category] || b.result.title.score - a.result.title.score);
      check.matches = matches;
      if (pageBlocked || blocked) check.notes.push("Amazon asked for a robot check, so some listings weren't read. Press Re-check later for the rest.");
      check.state = "done";
      check.progress = 100;
      renderHijackView();
      updateTabCounts();
    } catch (e) {
      if (!alive()) return;
      check.state = "error";
      check.message = "Something went wrong. Try again.";
      renderHijackView();
    }
  }

  function azHijackTracked(check) {
    if (!check || check.state !== "done") return [];
    return check.matches.filter((m) => m.result.category && amazonActiveTracked(m.asin)).map((m) => m.asin);
  }

  function reportAzHijacks() {
    const check = lastAzHijack;
    const asins = azHijackTracked(check);
    if (!asins.length) return;
    reportSite = "amazon";
    azSwitchGroup(`amz:${check.asin}`, false);
    if (amazonIsMine(check.asin)) {
      if (AZ.normalizeAsin(azDraft.original) !== check.asin) azDraft.brand = "";
      azDraft.original = check.asin;
    }
    azDraft.issue = "copied_listing";
    azSetReason(asins, "copied_listing");
    azFocus = new Set(asins);
    azSelection = new Set(asins.filter((a) => azGroupTargets().includes(a)));
    saveAzDraft();
    azBump();
    switchTab("report");
    showToast(`${azSelection.size} hijack${azSelection.size === 1 ? "" : "s"} ticked · reason: Copied listing`);
  }

  function updateAzHijackProgress() {
    const check = lastAzHijack;
    if (!popup || popup.tab !== "hijacks" || hijackSite !== "amazon" || !check || check.state !== "loading") return;
    const fill = popup.overlay.querySelector("#eif-hj-fill");
    if (!fill) return renderHijackView();
    const pct = Math.round(check.progress);
    fill.style.width = `${pct}%`;
    popup.overlay.querySelector("#eif-hj-pct").textContent = `${pct}%`;
    M.swap(popup.overlay.querySelector("#eif-hj-text"), check.message);
    popup.overlay.querySelectorAll(".eif-progress-steps li").forEach((li) => {
      const i = Number(li.dataset.step);
      li.classList.toggle("eif-step-done", i < check.stage);
      li.classList.toggle("eif-step-active", i === check.stage);
    });
  }

  function hijackSiteSwitch(view) {
    const n = (c) => (c && c.state === "done" ? c : null);
    const eb = n(lastHijack) ? lastHijack.matches.filter((m) => m.level >= 2).length : "";
    const az = n(lastAzHijack) ? lastAzHijack.matches.filter((m) => m.result.category).length : "";
    const btn = (site, label, count) => `<button type="button" role="tab" data-action="hj-site" data-site="${site}" class="${hijackSite === site ? "eif-src-on" : ""}"><i class="eif-site-dot" aria-hidden="true"></i>${label}${count !== "" ? ` <span class="eif-src-n">${count}</span>` : ""}</button>`;
    const b1 = btn("ebay", "eBay", eb), b2 = btn("amazon", "Amazon", az);
    view.insertAdjacentHTML("afterbegin", `<div id="eif-src-switch" class="eif-rp-switch" role="tablist" aria-label="Hijacks on">${SITE === "amazon" ? b2 + b1 : b1 + b2}</div>`);
  }

  function highlightMyWords(title, mineTitle, common) {
    const mineWords = new Set(AZ.keyWords(mineTitle).filter((w) => w.length > 2));
    const commonWords = new Set((common || []).join(" ").split(" "));
    return escapeHtml(title).replace(/[A-Za-z0-9’'`]+/g, (w) => {
      const k = w.toLowerCase().replace(/[’'`]/g, "");
      return mineWords.has(k) && !commonWords.has(k) ? `<mark>${w}</mark>` : w;
    });
  }

  function azHijackRowHtml(it, check) {
    const r = it.result;
    const tracked = amazonActiveTracked(it.asin);
    const lock = !tracked ? amazonLock(it.asin) : null;
    const chip = (label, on, detail) => `<span class="eif-azhj-f ${on ? "eif-on" : ""}" title="${escapeHtml(detail)}">${on ? "✕" : "✓"} ${label}</span>`;
    return `
      <div class="eif-tr-row eif-hj-row eif-azhj-row" data-asin="${escapeHtml(it.asin)}">
        <a class="eif-hj-thumb" href="https://www.amazon.com/dp/${escapeHtml(it.asin)}" target="_blank" rel="noopener">${it.image ? `<img src="${safeSrc(it.image)}" alt="" loading="lazy" />` : ""}</a>
        <div class="eif-tr-main">
          <a class="eif-hj-title" href="https://www.amazon.com/dp/${escapeHtml(it.asin)}" target="_blank" rel="noopener">${highlightMyWords(it.title, check.mine.title, check.common)}</a>
          <div class="eif-hj-tags">
            ${r.category ? `<span class="eif-azhj-cat eif-hj-${r.category}">${escapeHtml(hijackBadgeText(r))}</span>` : ""}
            ${chip(`Title ${Math.round(r.title.score * 100)}%`, r.title.copied, "How much of your title wording they use")}
            ${r.brand.present ? chip(r.brand.copied ? "Brand same" : "Brand theirs", r.brand.copied, `Their brand: ${it.brand || "—"}`) : ""}
            ${r.bullets.present ? chip(`Bullets ${r.bullets.copiedCount}/${r.bullets.total}`, r.bullets.copied, "Your bullets found in theirs") : ""}
            ${r.description.present ? chip("Description", r.description.copied, "Your description wording") : ""}
            <span class="eif-tr-num">${escapeHtml(it.asin)}</span>
            ${it.price ? `<span class="eif-tr-num">${escapeHtml(it.price)}</span>` : ""}
          </div>
        </div>
        <div class="eif-tr-actions">
          <button class="eif-hunt-btn ${tracked ? "eif-hunt-btn-green" : ""}" type="button" data-action="azhj-track" data-ic="${tracked || lock ? "" : "bookmark"}" ${lock ? "disabled" : ""} title="${lock ? escapeHtml(lockText(lock)) : tracked ? "Not a copy? Take it off your copycats" : "Mark as a copycat, under this product"}">${tracked ? "✓ Copycat" : lock ? "Reported · waiting" : "Copycat"}</button>
        </div>
      </div>`;
  }

  function azHijackStartHtml() {
    const page = currentPageAsin();
    const mine = [...new Set([...(page && amazonIsMine(page) ? [page] : []), ...amazonMine])].slice(0, 12);
    return `
      <div class="eif-center eif-empty-plain">
        <div class="eif-empty-icon"><span class="eif-ic-hero"></span></div>
        <div class="eif-empty-title">Check for Amazon hijacks</div>
        <div class="eif-empty-sub">Finds listings that copy your <b>title</b>, <b>brand</b>, <b>bullets</b> or <b>description</b>, even with a different design. Searches Amazon with your own wording, then compares each listing with yours.</div>
        ${page ? `<button class="eif-hunt-btn eif-hunt-btn-primary" type="button" data-action="azhj-check" data-asin="${page}">Check this product (${page})</button>` : ""}
        <div class="eif-hj-form">
          <input id="eif-azhj-input" maxlength="60" placeholder="ASIN or amazon.com link" />
          <button class="eif-hunt-btn" type="button" data-action="azhj-check-input">Check</button>
        </div>
        ${mine.length ? `<div class="eif-hj-mine"><div class="eif-hj-mine-label">Your products</div>${mine.map((a) => `<button class="eif-hj-chip" type="button" data-action="azhj-check" data-asin="${a}">${a}</button>`).join("")}</div>` : ""}
      </div>`;
  }

  function renderAmazonHijackView() {
    const view = viewEl();
    if (!view) return;
    const check = lastAzHijack;
    if (!check) {
      view.innerHTML = azHijackStartHtml();
      return;
    }
    const mine = check.mine;
    const got = check.state === "done" ? check.matches.filter((m) => m.result.category) : [];
    const c = (k) => got.filter((m) => m.result.category === k).length;
    let status = escapeHtml(check.message);
    let tone = check.state === "error" || check.state === "blocked" ? "err" : "";
    if (check.state === "done") {
      status = got.length
        ? `${got.length} listing${got.length > 1 ? "s" : ""} use your text: ${[c("full") && `${c("full")} full hijack`, c("title") && `${c("title")} with your title`, c("part") && `${c("part")} partly copied`].filter(Boolean).join(", ")}. ${check.found} search results, ${check.read} opened.`
        : `No copied text found. ${check.found} search results, ${check.read} opened.`;
      tone = got.length ? "warn" : "ok";
    }
    const rest = check.state === "done" ? check.matches.filter((m) => !m.result.category && m.result.title.score >= 0.45) : [];
    const groups = [["full", "Full hijack", "Your title and everything else you wrote"], ["title", "Title copied", "Your title wording"], ["part", "Part copied", "Your brand, bullets or description"]];
    view.innerHTML = `
      <div class="eif-results-head">
        ${mine && mine.image ? `<img class="eif-src-thumb" alt="" src="${safeSrc(mine.image)}" />` : '<span class="eif-src-thumb"></span>'}
        <div class="eif-results-meta">
          <div class="eif-results-title eif-hj-source-title">${mine ? escapeHtml(mine.title) : "Your product"} <span class="eif-hunt-source">${escapeHtml(check.asin)}</span></div>
          <div id="eif-hunt-status" class="${tone ? `eif-${tone}` : ""}">${status}</div>
        </div>
        ${check.state !== "loading" ? `<button class="eif-hunt-btn" type="button" data-action="azhj-new">Check another</button><button class="eif-hunt-btn" type="button" data-action="azhj-check" data-asin="${escapeHtml(check.asin)}">Re-check</button>` : ""}
        ${azHijackTracked(check).length ? `<button class="eif-hunt-btn eif-hunt-btn-green" type="button" data-action="azhj-report" title="Open the Amazon report with these listings ticked and 'Copied listing' chosen">Report (${azHijackTracked(check).length})</button>` : ""}
      </div>
      <div class="eif-scroll">
        ${
          check.state === "loading"
            ? `<div class="eif-center"><div class="eif-progress-card">
                 <div class="eif-progress-top">${LOADER()}<span id="eif-hj-text">${escapeHtml(check.message)}</span><span id="eif-hj-pct">0%</span></div>
                 <div class="eif-progress"><div class="eif-progress-fill" id="eif-hj-fill"></div></div>
                 <ol class="eif-progress-steps">${AZHJ_STEPS.map((l, i) => `<li data-step="${i}">${l}</li>`).join("")}</ol>
               </div></div>`
            : check.state !== "done"
              ? `<div class="eif-center eif-error"><div>${escapeHtml(check.message)}</div></div>`
              : `${check.notes.map((n) => `<div class="eif-hj-note">${escapeHtml(n)}</div>`).join("")}
                 ${got.length ? groups.filter(([k]) => c(k)).map(([k, label, sub]) => `
                   <div class="eif-azhj-group"><div class="eif-azhj-head"><span class="eif-azhj-cat eif-hj-${k}">${label}</span> <b>${c(k)}</b> <span class="eif-rp-muted">${sub}</span></div>
                   <div class="eif-list">${got.filter((m) => m.result.category === k).map((m) => azHijackRowHtml(m, check)).join("")}</div></div>`).join("")
                 : `<div class="eif-center eif-hj-clean"><div class="eif-empty-title">No hijacks found</div><div class="eif-empty-sub">None of the listings Amazon showed for your wording copy your title, brand, bullets or description.</div></div>`}
                 ${rest.length ? `<details class="eif-hj-common"><summary>${rest.length} listing${rest.length > 1 ? "s" : ""} only share common wording <span>(the slogan or phrases most sellers use)</span></summary><div class="eif-list">${rest.map((m) => azHijackRowHtml(m, check)).join("")}</div></details>` : ""}`
        }
      </div>`;
    if (check.state === "loading") updateAzHijackProgress();
  }

  function azReportLocks(history) {
    return AZ && AZ.reportLocks ? AZ.reportLocks(history) : new Map();
  }
  function amazonLock(asin) {
    return AZ && AZ.reportLocks ? azReportLocks(reportHistory).get(asin) || null : null;
  }
  function lockDate(ms) {
    return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  function lockText(lock) {
    return `Reported ${lockDate(Date.parse(lock.sentAt))} · waiting on Amazon until ${lockDate(lock.until)}`;
  }
  function amazonActiveTracked(asin) {
    const m = amazonTracked.get(asin);
    return !!(m && !m.reportedAt);
  }

  function toggleAmazonTracked(asin, ctx) {
    if (amazonMine.has(asin)) return showToast("That's marked as your product");
    if (merchIsOwn(asin)) return showToast("That's in your Merch catalog");
    const lock = amazonLock(asin);
    if (lock && !amazonActiveTracked(asin)) return showToast(`${lockText(lock)}. Amazon asks not to report it twice.`);
    if (amazonTracked.has(asin) && amazonTracked.get(asin).reportedAt) {
      amazonTracked.get(asin).reportedAt = "";
      showToast(`Tracking ${asin} again`);
    } else if (amazonTracked.has(asin)) {
      amazonTracked.delete(asin);
      showToast(`Removed ${asin}`);
    } else {
      addAmazonTracked(asin, ctx);
      showToast(`Added ${asin}`);
    }
    saveAmazon();
    updatePanel();
    updateTabCounts();
    refreshAmazonCards();
    updateTextPill();
  }

  function addAmazonTracked(asin, ctx) {
    if (amazonMine.has(asin) || merchIsOwn(asin)) return;
    if (amazonTracked.has(asin)) {
      if (amazonTracked.get(asin).reportedAt && !amazonLock(asin)) amazonTracked.set(asin, { ...amazonTracked.get(asin), reportedAt: "" });
      return;
    }
    const item = (ctx && ctx.item) || ((lastSearch && lastSearch.amazon && lastSearch.amazon.items) || []).find((i) => i.asin === asin) || {};
    const hunt = ctx ? ctx.hunt || "" : item.asin && lastSearch ? lastSearch.hunt || "" : "";
    const tr = (ctx && ctx.result) || (lastSearch && lastSearch.amazonText && lastSearch.amazonText.results && lastSearch.amazonText.results.get(asin));
    amazonTracked.set(asin, { title: item.title || "", brand: item.brand || "", price: item.price || "", image: item.image || "", url: amzUrl(asin), marketplace: mpOfAsin(asin), addedAt: today(), hunt, copied: tr && tr.category ? tr.copied.slice() : [] });
    huntImageFrom(hunt, item.image);
  }

  function toggleAmazonMine(asin) {
    if (amazonMine.has(asin)) {
      amazonMine.delete(asin);
      setMineNote(`amazon:${asin}`, null);
      saveAmazon();
      refreshAmazonCards();
      return showToast(`${asin} is no longer marked as yours`);
    }
    amazonMine.add(asin);
    amazonTracked.delete(asin);
    const o = originals._unlinked || {};
    if (!o.link || linkProblem(o.platform || "Amazon", o.link)) {
      originals._unlinked = { ...o, platform: "Amazon", link: amzUrl(asin) };
      saveOriginals();
      showToast(`${asin} marked as yours and set as your Amazon original`);
      loadAmazonDetails(asin).then((d) => {
        const cur = originals._unlinked || {};
        if (d.firstAvailable && cur.link === amzUrl(asin) && (!cur.published || dateProblem(cur.published))) {
          originals._unlinked = { ...cur, published: d.firstAvailable, dateFromAmazon: true };
          saveOriginals();
          if (popup && popup.tab === "report") renderReportView();
        }
      });
    } else showToast(`${asin} marked as yours`);
    saveAmazon();
    updatePanel();
    updateTabCounts();
    refreshAmazonCards();
  }

  const amazonDetails = new Map();

  const amazonDetailsPending = new Map();
  async function loadAmazonDetails(asin, refresh, priority) {
    const key = dkey(asin);
    const marketplace = mpOfAsin(asin);
    const known = amazonDetails.get(key);
    if (!refresh && known && known.state === "done") return known;
    if (!refresh && amazonDetailsPending.has(key)) {
      if (priority === "high") bgSend({ type: "eif-amazon-listing", asin, marketplace, priority: "high" });
      return amazonDetailsPending.get(key);
    }
    const entry = { state: "loading", firstAvailable: "", listing: { state: "loading" } };
    amazonDetails.set(key, entry);
    const p = bgSend({ type: "eif-amazon-listing", asin, marketplace, refresh: !!refresh, ...(priority === "high" ? { priority: "high" } : {}) }).then((L) => {
      if (L && (L.state === "ready" || L.state === "missing" || L.state === "blocked")) {
        Object.assign(entry, { state: "done", listing: L, firstAvailable: L.published && L.published.state === "known" ? L.published.isoDate : "" });
        const m = amazonTracked.get(asin);
        if (m && L.state === "ready") {
          if (!m.title) m.title = L.title || "";
          if (!m.image && L.image) m.image = L.image;
        }
        const prevMerch = merchResults.get(`${marketplace}|${asin}`);
        if (L.pageAsins && L.pageAsins.length && prevMerch && prevMerch.state === "not_found") {
          merchResults.delete(`${marketplace}|${asin}`);
          merchLookupAsins([asin]);
        }
      } else {
        Object.assign(entry, { state: "error", at: Date.now(), offline: !L || L.reason === "network", listing: L || { state: "error", reason: "network" } });
      }
      amazonDetailsPending.delete(key);
      if (amazonDetails.get(key) === entry && popup && popup.tab === "report" && reportSite === "amazon") azScheduleRender();
      return entry;
    });
    amazonDetailsPending.set(key, p);
    return p;
  }

  function firstAvailableHtml(asin) {
    const d = amazonDetails.get(dkey(asin));
    if (!d || d.state === "loading") return '<span class="eif-sk" style="width:130px"></span>';
    if (d.state === "error") return `<span class="eif-pk-dim">${d.offline ? "Offline" : "Couldn't load"}</span>`;
    if (!d.firstAvailable) return '<span class="eif-pk-dim">Not shown by Amazon</span>';
    return `${escapeHtml(niceDate(d.firstAvailable))} <span class="eif-pk-dim">· ${escapeHtml(daysAgo(d.firstAvailable))}</span>`;
  }

  function amazonPeekHtml(item, index) {
    const mine = amazonMine.has(item.asin);
    const match = typeof item.score === "number" ? Math.round(item.score * 100) : null;
    const stars = item.rating ? `${item.rating.toFixed(1)} ★${item.reviews ? ` <span class="eif-pk-dim">· ${escapeHtml(item.reviews)} review${item.reviews === "1" ? "" : "s"}</span>` : ""}` : '<span class="eif-pk-dim">No ratings yet</span>';
    return `
      <div class="eif-pk-head">
        <span class="eif-pk-label">${mine ? "Your product" : "Amazon product"}</span>
        <span class="eif-pk-num">${escapeHtml(item.asin)}</span>
      </div>
      ${amazonPeekTitle(item)}
      <div class="eif-pk-stats">
        <div><span>Price</span><b>${escapeHtml(item.price || "—")}</b></div>
        <div class="eif-pk-textstat" title="${escapeHtml(item.brand || "")}"><span>Brand</span><b>${escapeHtml(item.brand || "—")}</b></div>
        <div title="Beta: an estimate, not a final verdict."><span>Match <i class="eif-pk-demo">beta</i></span><b class="eif-pk-match${match === null ? " eif-pk-match-none" : ""}">${match === null ? "—" : `${match}%`}</b></div>${scorePeekRow(`amazon:${item.asin}`)}
      </div>
      <div class="eif-pk-rows">
        <div><span>First available</span><b>${firstAvailableHtml(item.asin)}</b></div>
        <div><span>Rating</span><b>${stars}</b></div>
      </div>${hijackPeekHtml(item.asin)}`;
  }

  const wordKey = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
  function amazonPeekTitle(item) {
    const T = lastSearch && lastSearch.amazonText;
    const read = T && T.listings && T.listings.get(item.asin);
    const raw = item.title || (read && read.title) || "";
    const title = raw || "Untitled product";
    const r = T && T.results && !amazonIsMine(item.asin) && T.results.get(item.asin);
    if (!r || !r.title || !r.title.copied || !T.mineTitle || !raw) return `<div class="eif-pk-title">${escapeHtml(title)}</div>`;
    const mineWords = new Set(T.mineTitle.split(/\s+/).map(wordKey).filter((k) => k.length > 1));
    const html = title.split(/(\s+)/).map((part) => (/^\s+$/.test(part) || !mineWords.has(wordKey(part)) ? escapeHtml(part) : `<mark class="eif-pk-w">${escapeHtml(part)}</mark>`)).join("");
    return `<div class="eif-pk-title eif-pk-title-hj" title="Highlighted: words that are also in your title">${html}</div>`;
  }

  function hijackPeekHtml(asin) {
    const T = lastSearch && lastSearch.amazonText;
    if (!T || amazonIsMine(asin)) return "";
    const r = T.results && T.results.get(asin);
    if (!r) return "";
    const row = (label, copied, detail) => `<div class="${copied ? "eif-pk-hj-yes" : ""}"><span>${copied ? "✕" : "✓"} ${label}</span><b>${detail}</b></div>`;
    return `
      <div class="eif-pk-hj eif-pk-hj-${r.category}">
        <div class="eif-pk-hj-head"><span class="eif-pk-hj-chip">${escapeHtml(hijackBadgeText(r))}</span><span>Compared with your listing</span></div>
        <div class="eif-pk-hj-rows">
          ${row("Title", r.title.copied, `${r.title.copied ? "copied" : "their own"} · ${Math.round(r.title.score * 100)}% match`)}
          ${r.brand.present ? row("Brand", r.brand.copied, r.brand.copied ? "same as yours" : "their own") : ""}
          ${r.bullets.present ? row("Bullets", r.bullets.copied, `${r.bullets.copiedCount} of your ${r.bullets.total} copied`) : ""}
          ${r.description.present ? row("Description", r.description.copied, r.description.copied ? "copied" : "their own") : ""}
        </div>
      </div>`;
  }

  const PROGRESS_STEPS = ["Prepare image", "Scan design", "Find look-alikes"];

  const STOP_BTN = (what) => `<button class="eif-stop" type="button" data-action="${what}" title="Stop this search"><svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1.5" fill="currentColor"/></svg>Stop</button>`;

  const AMZ_STEPS = ["Prepare image", "Search Amazon", "Load all look-alikes"];
  function amazonProgressHtml(text, step, since, from, to, tau, stop) {
    const t0 = Number(since) || Date.now();
    return `<div class="eif-center eif-amz-card"><div class="eif-progress-card eif-amz-progress" data-since="${t0}" data-from="${from}" data-to="${to}" data-tau="${tau}">
          <div class="eif-progress-top">${LOADER()}<span id="eif-amz-text">${escapeHtml(text)}</span><span class="eif-amz-pct">${amazonPct(t0, from, to, tau)}%</span>${STOP_BTN(stop)}</div>
          <div class="eif-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="eif-progress-fill" style="width:${amazonPct(t0, from, to, tau)}%"></div></div>
          <ol class="eif-progress-steps">${AMZ_STEPS.map((label, i) => `<li data-step="${i}" class="${i < step ? "eif-step-done" : i === step ? "eif-step-active" : ""}">${label}</li>`).join("")}</ol>
        </div></div>`;
  }
  function amazonPct(since, from, to, tau) {
    return Math.round(from + (to - from) * (1 - Math.exp(-Math.max(0, Date.now() - since) / tau)));
  }
  setInterval(() => {
    if (!popup || !popup.overlay.isConnected) return;
    popup.overlay.querySelectorAll(".eif-amz-progress").forEach((card) => {
      const d = card.dataset;
      const pct = amazonPct(Number(d.since), Number(d.from), Number(d.to), Number(d.tau));
      const fill = card.querySelector(".eif-progress-fill");
      if (fill) fill.style.width = `${pct}%`;
      const label = card.querySelector(".eif-amz-pct");
      if (label) label.textContent = `${pct}%`;
      const bar = card.querySelector(".eif-progress");
      if (bar) bar.setAttribute("aria-valuenow", String(pct));
    });
  }, 200);

  function progressHtml(search) {
    const pct = Math.round(search.progress || 0);
    return `
      <div class="eif-center">
        <div class="eif-progress-card">
          <div class="eif-progress-top">
            ${LOADER()}
            <span id="eif-progress-text">${escapeHtml(search.message)}</span>
            <span id="eif-progress-pct">${pct}%</span>
            ${STOP_BTN("hunt-stop")}
          </div>
          <div class="eif-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
            <div class="eif-progress-fill" style="width:${pct}%"></div>
          </div>
          <ol class="eif-progress-steps">
            ${PROGRESS_STEPS.map((label, i) => `<li data-step="${i}">${label}</li>`).join("")}
          </ol>
        </div>
      </div>`;
  }

  function updateProgressUI() {
    const search = lastSearch;
    if (!popup || popup.tab !== "results" || !search || search.state !== "loading") return;
    const fill = popup.overlay.querySelector(".eif-progress-fill");
    if (!fill) {
      renderResultsView();
      return;
    }
    const pct = Math.round(search.progress || 0);
    fill.style.width = `${pct}%`;
    popup.overlay.querySelector(".eif-progress").setAttribute("aria-valuenow", String(pct));
    popup.overlay.querySelector("#eif-progress-pct").textContent = `${pct}%`;
    M.swap(popup.overlay.querySelector("#eif-progress-text"), search.message);
    const status = popup.overlay.querySelector("#eif-hunt-status");
    if (status) status.textContent = search.message;
    popup.overlay.querySelectorAll(".eif-progress-steps li").forEach((li) => {
      const i = Number(li.dataset.step);
      li.classList.toggle("eif-step-done", i < (search.stage || 0) || search.stage === 3);
      li.classList.toggle("eif-step-active", i === search.stage);
    });
  }

  function addSearchItems(search, items) {
    items.forEach((item) => {
      if (search.seen.has(item.itemNumber)) return;
      search.seen.add(item.itemNumber);
      search.items.push(item);
      const known = discovered.get(item.itemNumber);
      discovered.set(item.itemNumber, {
        title: item.title,
        url: item.url,
        image: item.image,
        price: item.price,
        seller: item.seller,
        kind: "copycat",
        source: searchIsMine(search) && item.itemNumber !== search.itemNumber ? search.itemNumber : "",
        hunt: search.hunt || "",
        ...(known && known.title !== "Untitled listing" ? { title: known.title } : {}),
      });
    });
    queueTestSet(search);
    queueScore(search);
  }

  const SCORE_MAX = 200;
  const SCORE_PER_CALL = 70;
  const SCORE_HOSTS = /^https:\/\/(m\.media-amazon\.com|i\.ebayimg\.com)\//;
  const scoreUrl = (u) => amazonFullSize(u).replace(/^https?:\/\/(?:images-na\.ssl-images-amazon\.com|images-eu\.ssl-images-amazon\.com|images-amazon\.com)\/images\/I\//, "https://m.media-amazon.com/images/I/");
  const scoreTimers = new Map();
  const SCORE_WAIT_MAX_MS = 3 * 60 * 1000;

  function queueScore(search) {
    if (!prefs.scorer || !search || !search.hunt) return;
    if (search.score && search.score.state === "waiting") return;
    clearTimeout(scoreTimers.get(search.hunt));
    scoreTimers.set(search.hunt, setTimeout(() => runScore(search), 1500));
  }

  function scoreCandidates(search) {
    const out = [];
    ((search.amazon && search.amazon.items) || []).forEach((it) => {
      const img = scoreUrl(it.image);
      if (it.asin && it.asin !== search.asin && !amazonIsMine(it.asin) && SCORE_HOSTS.test(img)) out.push({ id: `amazon:${it.asin}`, url: img });
    });
    (search.items || []).forEach((it) => {
      const url = normalizeImageUrl(it.image);
      if (it.itemNumber && it.itemNumber !== search.itemNumber && !isMineEbay(it.itemNumber) && SCORE_HOSTS.test(url || "")) out.push({ id: `ebay:${it.itemNumber}`, url });
    });
    return out;
  }

  function fileBase64(file) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || "").replace(/^data:[^,]*,/, ""));
      r.onerror = () => resolve("");
      r.readAsDataURL(file);
    });
  }

  async function scoreOriginal(search) {
    const again = search.again || {};
    if (search.asin) {
      const main = document.getElementById("landingImage");
      const u = scoreUrl(main && (main.getAttribute("data-old-hires") || main.getAttribute("src")));
      if (SCORE_HOSTS.test(u)) return { kind: "url", url: u };
    }
    if (again.designAsin) {
      if (search.designArt === undefined) {
        const L = await bgSend({ type: "eif-amazon-listing", asin: again.designAsin, marketplace: search.marketplace || "US", priority: "high" });
        const img = L && L.state === "ready" ? scoreUrl(L.image) : "";
        search.designArt = SCORE_HOSTS.test(img) && /_CLa(?:\||%7C)/i.test(img) ? img : null;
      }
      if (search.designArt) return { kind: "url", url: search.designArt };
    }
    if (SCORE_HOSTS.test(scoreUrl(again.imageUrl))) return { kind: "url", url: scoreUrl(again.imageUrl) };
    if (again.file && again.file.size <= 2_100_000) {
      const b64 = await fileBase64(again.file);
      if (b64) return { kind: "png", dataBase64: b64 };
    }
    return null;
  }

  async function runScore(search) {
    scoreTimers.delete(search.hunt);
    if (!prefs.scorer) return;
    const S = (search.score = search.score || { state: "idle", results: new Map(), sent: new Set() });
    if (S.state === "scoring") return queueScore(search);
    if (search.amazon && search.amazon.more && search.amazon.more.state === "loading") return;
    if (S.state === "error") { S.waitStart = 0; S.tries = 0; }
    const todo = scoreCandidates(search).filter((c) => !S.sent.has(c.id)).slice(0, Math.min(SCORE_PER_CALL, Math.max(0, SCORE_MAX - S.sent.size)));
    if (!todo.length) return;
    const original = await scoreOriginal(search);
    if (!original) {
      S.state = "error";
      S.message = search.again && search.again.file ? "The design file is too big for the scorer (2 MB max)." : "This image can't be sent to the scorer (only Amazon/eBay photos or a file).";
      return paintScores();
    }
    todo.forEach((c) => S.sent.add(c.id));
    S.state = "scoring";
    S.count = todo.length;
    paintScores();
    const res = await bgSend({ type: "eif-image-score", original, candidates: todo });
    if (res && res.ok) {
      Object.entries(res.results || {}).forEach(([id, r]) => S.results.set(id, r));
      S.state = "done";
      S.ms = res.ms;
      S.design = res.design;
      S.waitStart = 0;
      S.tries = 0;
      if (scoreCandidates(search).some((c) => !S.sent.has(c.id)) && S.sent.size < SCORE_MAX) queueScore(search);
    } else {
      todo.forEach((c) => S.sent.delete(c.id));
      const e = res && res.error;
      if (e === "not-approved") {
        S.state = "off";
        S.message = "The image scorer isn't on for your license. Open the Copycat Hunt menu to request access.";
        return paintScores();
      }
      if (e === "busy" && prefs.scorer && lastSearch === search) {
        S.waitStart = S.waitStart || Date.now();
        S.tries = (S.tries || 0) + 1;
        const left = SCORE_WAIT_MAX_MS - (Date.now() - S.waitStart);
        if (left > 0) {
          const pause = Math.min(30000, Math.max((Number(res.retryAfter) || 0) * 1000, 5000 * S.tries), left);
          S.state = "waiting";
          paintScores();
          scoreTimers.set(search.hunt, setTimeout(() => {
            scoreTimers.delete(search.hunt);
            if (lastSearch !== search || !prefs.scorer) { S.state = "idle"; return; }
            S.state = "idle";
            runScore(search);
          }, pause));
          return;
        }
      }
      S.state = "error";
      S.waitStart = 0;
      S.tries = 0;
      S.message = !res ? "The scorer couldn't be reached." : e === "busy" ? "The scorer is still busy after 3 minutes. Try again in a few minutes." : e === "design" ? "The scorer couldn't use this design image." : e === "license" || e === "license-server" ? "The scorer needs an active license." : "The scorer didn't answer this time.";
    }
    paintScores();
  }

  function scoreKey(r) {
    const s = (r && r.status === "ok" && r.signals) || null;
    if (!s) return [0, 0, 0, 0, 0, 0, 0, 0, 0];
    return [1, s.drawingValid ? 1 : 0, s.drawingTilesMatched || 0, s.drawingTileRecallMin || 0, s.validHomography ? 1 : 0, s.edgeTilesMatched || 0, s.edgeF1 || 0, s.orbInliers || 0, -(typeof s.phashDistance === "number" ? s.phashDistance : 64)];
  }
  const cmpKey = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i]; return 0; };

  const tiles = (m, c) => `${m || 0}/${c || 16}`;
  function scoreLabel(r) {
    if (!r) return null;
    const s = r.status === "ok" && r.signals;
    if (!s) return { text: "—", title: `Not scored (${r.status || "error"})`, cls: "none" };
    if (typeof s.drawingValid === "boolean") {
      const text = s.textValid ? ` · Text ${tiles(s.textTilesMatched, s.textTilesCounted)}` : "";
      if (s.drawingValid) return { text: `Art ${tiles(s.drawingTilesMatched, s.drawingTilesCounted)}${text}`, title: "Parts of your drawing's outline found in this photo (and of your text)", cls: "on" };
      if (s.textValid) return { text: `Art: no${text}`, title: "Your text is there but your drawing wasn't found", cls: "text" };
      return { text: "No match", title: "Neither your drawing nor your text was found in this photo", cls: "none" };
    }
    if (!s.validHomography) return { text: "No match", title: "The design wasn't found in this photo", cls: "none" };
    return { text: `Shape ${tiles(s.edgeTilesMatched, s.edgeTilesCounted)}`, title: "Parts of the design's outline found in this photo", cls: "on" };
  }

  const SR = self.EifScoreRules || null;
  const IDEA_TITLE = { high: "Same idea as your design (on eBay this level was a copy about 98% of the time)", medium: "Similar idea (on eBay this level was a copy about 88% of the time)", low: "Different idea" };
  function cardLabel(id, r) {
    const L = scoreLabel(r);
    const level = SR && L && SR.sameIdeaLevel(id, r);
    if (!level) return L;
    return { text: `Same idea: ${level}${L.text && L.text !== "No match" ? ` · ${L.text}` : ""}`, title: IDEA_TITLE[level], cls: level === "high" ? "on" : level === "medium" ? "text" : "none" };
  }

  function paintScores() {
    if (!popup || !lastSearch) return;
    const S = (prefs.scorer || (lastSearch.score && lastSearch.score.state === "off")) && lastSearch.score;
    const bar = popup.overlay.querySelector("#eif-score-bar");
    if (bar) {
      bar.hidden = !S || (lastSearch.view === "amazon" && amazonWaiting(lastSearch.amazon));
      if (S) {
        const n = S.results.size;
        const cut = S.sorted ? (scoreSelection() || { hidden: new Set() }).hidden.size : 0;
        bar.innerHTML = `<span class="eif-score-text">${
          S.state === "scoring" ? `${LOADER()}Scoring ${S.count} photo${S.count === 1 ? "" : "s"}…` : S.state === "waiting" ? `${LOADER()}The scorer is busy. Waiting for a free slot…` : S.state === "error" || S.state === "off" ? escapeHtml(S.message || "Scoring didn't work.") : `Scores (beta) for ${n} photo${n === 1 ? "" : "s"}${S.ms ? ` · ${(S.ms / 1000).toFixed(1)} s` : ""}${cut ? ` · ${cut} not like yours hidden` : ""}`
        }</span>${n ? `<button class="eif-hunt-btn eif-score-sort${S.sorted ? " is-on" : ""}" type="button" data-action="score-sort">${S.sorted ? "Original order" : "Sort by score"}</button>` : ""}${S.state === "error" ? '<button class="eif-hunt-btn" type="button" data-action="score-retry">Try again</button>' : ""}`;
      }
    }
    const keyed = [];
    popup.overlay.querySelectorAll("#eif-hunt-grid .eif-hc").forEach((card) => {
      const id = card.dataset.asin ? `amazon:${card.dataset.asin}` : card.dataset.itemNumber ? `ebay:${card.dataset.itemNumber}` : "";
      let el = card.querySelector(".eif-hc-score");
      const L = S && cardLabel(id, S.results.get(id));
      if (!L) {
        if (el) el.remove();
        card.style.order = "";
        card.classList.remove("eif-hc-cut");
        return;
      }
      if (!el) {
        el = document.createElement("span");
        el.className = "eif-hc-score";
        card.appendChild(el);
      }
      el.textContent = L.text;
      el.title = L.title;
      el.classList.toggle("eif-hc-score-on", L.cls === "on");
      el.classList.toggle("eif-hc-score-text", L.cls === "text");
      keyed.push([card, id]);
    });
    const sel = S && S.sorted ? scoreSelection() : null;
    keyed.forEach(([card, id]) => card.classList.toggle("eif-hc-cut", !!sel && sel.hidden.has(id)));
    if (S && S.sorted) {
      const amazonPos = new Map(((lastSearch.amazon && lastSearch.amazon.items) || []).map((it, i) => [`amazon:${it.asin}`, i]));
      const keys = SR ? SR.sortKeys([...S.results.entries()], amazonPos) : null;
      const k = (id) => (keys && keys.get(id)) || scoreKey(S.results.get(id));
      keyed.sort((a, b) => cmpKey(k(a[1]), k(b[1]))).forEach(([card], i) => (card.style.order = String(i)));
    }
    else keyed.forEach(([card]) => (card.style.order = ""));
  }

  function scoreSelection() {
    const S = prefs.scorer && lastSearch && lastSearch.score;
    const sel = S && S.results.size && SR && SR.select ? SR.select([...S.results.entries()]) : null;
    if (!sel) return null;
    const T = lastSearch.amazonText;
    sel.hidden.forEach((id) => {
      const a = id.slice("amazon:".length);
      const text = T && T.results && T.results.get(a);
      if ((text && text.category) || amazonActiveTracked(a) || amazonIsMine(a)) sel.hidden.delete(id);
    });
    return sel;
  }

  function scorePeekRow(id) {
    const S = prefs.scorer && lastSearch && lastSearch.score;
    const r = S && S.results.get(id);
    if (!r) return "";
    const s = r.status === "ok" && r.signals;
    const pct = (v) => `${Math.round(v * 100)}%`;
    const bits = !s ? [`Not scored (${escapeHtml(r.status || "error")})`] : [
      typeof s.drawingValid === "boolean" ? (s.drawingValid ? `Art ${tiles(s.drawingTilesMatched, s.drawingTilesCounted)}${typeof s.drawingTileRecallMin === "number" ? ` (weakest part ${pct(s.drawingTileRecallMin)})` : ""}` : "Art not found") : s.validHomography ? `Shape ${tiles(s.edgeTilesMatched, s.edgeTilesCounted)}` : "No match",
      typeof s.textValid === "boolean" ? (s.textValid ? `Text ${tiles(s.textTilesMatched, s.textTilesCounted)}` : "Text not found") : "",
      typeof s.artPixelDiff === "number" ? `Art layer ${pct(s.artPixelDiff)} different` : "",
      typeof s.sameIdea === "number" ? `Same idea ${s.sameIdea.toFixed(2)} (CLIP ${typeof s.clipSim === "number" ? s.clipSim.toFixed(2) : "?"}, DINOv2 ${typeof s.dinoSim === "number" ? s.dinoSim.toFixed(2) : "?"})` : "",
      `photo hash ${s.phashDistance ?? "?"}`,
    ].filter(Boolean);
    const text = bits.join(" · ");
    return `<div class="eif-pk-score" title="From the Copycat Hunt image scorer (beta): raw signals, not a verdict"><span>Score (beta)</span><b>${text}</b></div>`;
  }

  const TS_PREFIX = "eifTestSet:";
  const TS_MAX_HUNTS = 100;
  const TS_MAX_PER_SITE = 200;
  const tsTimers = new Map();
  function testSetRows(search) {
    const at = new Date().toISOString().slice(0, 10);
    const rows = [];
    search.items.slice(0, TS_MAX_PER_SITE).forEach((it, i) => {
      if (!it.itemNumber || it.itemNumber === search.itemNumber) return;
      rows.push({ m: "ebay", id: it.itemNumber, img: /^https:/.test(it.image || "") ? it.image : "", t: String(it.title || "").slice(0, 200), s: null, p: i + 1, at, own: isMineEbay(it.itemNumber) });
    });
    const az = search.amazon && search.amazon.state === "done" ? search.amazon.items : [];
    az.slice(0, TS_MAX_PER_SITE).forEach((it, i) => {
      if (!it.asin || it.asin === search.asin) return;
      rows.push({ m: "amazon", id: it.asin, img: /^https:/.test(it.image || "") ? it.image : "", t: String(it.title || "").slice(0, 200), s: typeof it.score === "number" ? Math.round(it.score * 1000) / 1000 : null, p: i + 1, at, own: amazonIsMine(it.asin) });
    });
    return rows;
  }
  function queueTestSet(search) {
    if (!hasStorage || !prefs.saveTestSet || !search || !search.hunt) return;
    clearTimeout(tsTimers.get(search.hunt));
    tsTimers.set(search.hunt, setTimeout(() => writeTestSet(search), 1500));
  }
  function writeTestSet(search) {
    tsTimers.delete(search.hunt);
    const rows = testSetRows(search);
    if (!rows.length || !prefs.saveTestSet) return;
    const key = TS_PREFIX + search.hunt;
    chrome.storage.local.get({ [key]: null, eifTestSetIndex: {} }, (d) => {
      const prev = d[key] && Array.isArray(d[key].items) ? d[key].items : [];
      const byId = new Map(prev.map((r) => [`${r.m}|${r.id}`, r]));
      rows.forEach((r) => {
        const old = byId.get(`${r.m}|${r.id}`);
        byId.set(`${r.m}|${r.id}`, old ? { ...r, at: old.at || r.at, own: !!(old.own || r.own) } : r);
      });
      const per = { ebay: 0, amazon: 0 };
      const items = [...byId.values()].filter((r) => per[r.m]++ < TS_MAX_PER_SITE);
      const image = (hunts.get(search.hunt) || {}).image || "";
      const now = new Date().toISOString();
      const order = Object.entries({ ...(d.eifTestSetIndex || {}), [search.hunt]: now }).sort((a, b) => String(b[1]).localeCompare(String(a[1])));
      chrome.storage.local.set({ [key]: { design: /^https:/.test(image) ? image : "", items, updatedAt: now }, eifTestSetIndex: Object.fromEntries(order.slice(0, TS_MAX_HUNTS)) });
      const drop = order.slice(TS_MAX_HUNTS).map(([h]) => TS_PREFIX + h);
      if (drop.length) chrome.storage.local.remove(drop);
    });
  }

  async function loadMoreResults() {
    const search = lastSearch;
    if (!search || !search.guid || search.loadingMore || !search.hasMore) return;
    search.loadingMore = true;
    renderLoadMore();
    try {
      const { items, hasMore } = await fetchResultsPage(search.guid, search.page + 1);
      if (lastSearch !== search) return;
      search.page += 1;
      const before = search.items.length;
      addSearchItems(search, items);
      search.hasMore = hasMore && search.items.length > before;
    } catch (e) {
      retryAfterEbayPause(e, "more", loadMoreResults, () => lastSearch === search);
      if (await isConnectionProblem(e)) {
        showToast("No internet connection. More results will load when you're back online.");
        retryWhenOnline("more", () => {
          if (lastSearch === search) loadMoreResults();
        });
      } else {
        showToast("Couldn't load more results");
      }
    }
    search.loadingMore = false;
    if (popup && popup.tab === "results") {
      appendResultCards();
      renderResultsStatus();
      renderLoadMore();
    }
    updateTabCounts();
  }

  const GENERIC_WORDS = new Set(
    (
      "t shirt tshirt tshirts shirt shirts tee tees top tops tank hoodie sweatshirt funny gift gifts " +
      "men mens women womens unisex kids youth adult black white navy grey gray heather graphic " +
      "novelty size sizes s m l xl xxl 2xl 3xl 4xl 5xl new nwt cotton short sleeve long crew neck " +
      "the a an and or of for in on to with by is it its at as from"
    ).split(" ")
  );

  function titleTokens(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/['’`]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean);
  }

  function shingles(tokens, size = 3) {
    const n = tokens.length < size ? Math.max(1, tokens.length) : size;
    const set = new Set();
    for (let i = 0; i + n <= tokens.length; i++) set.add(tokens.slice(i, i + n).join(" "));
    return set;
  }

  function dice(a, b) {
    if (!a.size || !b.size) return 0;
    let shared = 0;
    a.forEach((x) => {
      if (b.has(x)) shared++;
    });
    return (2 * shared) / (a.size + b.size);
  }

  function titleSimilarity(source, candidateTokens) {
    if (source.tokens.join(" ") === candidateTokens.join(" ")) return 1;
    const order = dice(source.trigrams, shingles(candidateTokens));
    const words = dice(new Set(source.tokens), new Set(candidateTokens));
    return 0.65 * order + 0.35 * words;
  }

  function highlightCopied(title, sourceTrigrams, distinctive) {
    const words = String(title || "").split(/\s+/).filter(Boolean);
    const norm = words.map((w) => titleTokens(w).join(""));
    const idx = [];
    norm.forEach((t, i) => {
      if (t) idx.push(i);
    });
    const level = new Map();
    for (let k = 0; k + 3 <= idx.length; k++) {
      const gram = [norm[idx[k]], norm[idx[k + 1]], norm[idx[k + 2]]].join(" ");
      if (!sourceTrigrams.has(gram)) continue;
      const strength = distinctive && distinctive.has(gram) ? 2 : 1;
      [idx[k], idx[k + 1], idx[k + 2]].forEach((i) => level.set(i, Math.max(level.get(i) || 0, strength)));
    }
    let html = "";
    let open = 0;
    words.forEach((word, i) => {
      const l = level.get(i) || 0;
      if (l !== open) {
        if (open) html += "</mark>";
        if (i) html += " ";
        if (l) html += `<mark class="${l === 2 ? "eif-mark-strong" : "eif-mark-common"}">`;
        open = l;
      } else if (i) {
        html += " ";
      }
      html += escapeHtml(word);
    });
    if (open) html += "</mark>";
    return html;
  }

  function buildTitleQueries(title) {
    const queries = [];
    const add = (q) => {
      q = q.replace(/\s+/g, " ").trim();
      if (q && q.split(" ").length >= 3 && !queries.includes(q)) queries.push(q);
    };
    const clean = String(title || "").replace(/\s+/g, " ").trim();
    add(clean);
    const distinctive = titleTokens(clean).filter((t) => !GENERIC_WORDS.has(t) && t.length > 1);
    add(distinctive.slice(0, 7).join(" "));
    if (distinctive.length > 6) add(distinctive.slice(Math.floor(distinctive.length / 3)).slice(0, 7).join(" "));
    return queries.slice(0, 3);
  }

  const photoHashCache = new Map();

  function ebayImageId(url) {
    const m = String(url || "").match(/i\.ebayimg\.com\/images\/g\/([^/]+)\//i);
    return m ? m[1] : null;
  }

  async function photoHash(imageId) {
    if (photoHashCache.has(imageId)) return photoHashCache.get(imageId);
    let hash = null;
    try {
      const res = await fetch(`https://i.ebayimg.com/images/g/${imageId}/s-l140.jpg`);
      if (res.ok) {
        const bitmap = await createImageBitmap(await res.blob());
        const canvas = document.createElement("canvas");
        canvas.width = 9;
        canvas.height = 8;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0, 9, 8);
        const d = ctx.getImageData(0, 0, 9, 8).data;
        let bits = "";
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const i = (y * 9 + x) * 4;
            const j = i + 4;
            const a = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
            const b = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114;
            bits += a > b ? "1" : "0";
          }
        }
        hash = bits;
      }
    } catch (e) {
      hash = null;
    }
    photoHashCache.set(imageId, hash);
    return hash;
  }

  function hamming(a, b) {
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d;
  }

  async function mapLimit(list, limit, fn) {
    const out = new Array(list.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i], i);
      }
    });
    await Promise.all(workers);
    return out;
  }

  async function readListing(itemNumber) {
    const res = await ebayFetch(`${EBAY}/itm/${itemNumber}`, { credentials: "include" });
    if (!res.ok) throw new Error(`Couldn't open listing #${itemNumber} (${res.status}).`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    let title =
      (doc.querySelector("h1.x-item-title__mainTitle") || doc.querySelector("h1") || {}).textContent || "";
    if (!title.trim()) {
      title = ((doc.querySelector('meta[property="og:title"]') || {}).content || "").replace(/\s*\|\s*eBay\s*$/i, "");
    }
    title = title.replace(/\s+/g, " ").trim();
    if (!title) throw new Error(`Couldn't read the title of listing #${itemNumber}.`);

    const storeLink = doc.querySelector('a[href*="/str/"]');
    const seller =
      (html.match(/"sellerUserName"\s*:\s*"([^"]+)"/) || [])[1] ||
      (storeLink && (storeLink.getAttribute("href").match(/\/str\/([^/?#]+)/) || [])[1]) ||
      "";

    const imageIds = [];
    doc.querySelectorAll(".ux-image-carousel-item img, .ux-image-grid img").forEach((img) => {
      const id = ebayImageId(img.getAttribute("data-zoom-src") || img.getAttribute("src") || img.getAttribute("data-src"));
      if (id && !imageIds.includes(id)) imageIds.push(id);
    });
    const og = ebayImageId((doc.querySelector('meta[property="og:image"]') || {}).content);
    if (og && !imageIds.includes(og)) imageIds.unshift(og);

    return { itemNumber, title, seller: seller.toLowerCase(), imageIds: imageIds.slice(0, 8) };
  }

  async function searchTitles(query) {
    const url = `${EBAY}/sch/i.html?_nkw=${encodeURIComponent(query)}&_ipg=120`;
    const res = await ebayFetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`The title search failed (${res.status}). Try again.`);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    return extractResultItems(doc);
  }

  function sellerName(sellerLine) {
    return (String(sellerLine || "").trim().split(/\s+/)[0] || "").toLowerCase();
  }

  let lastHijack = null;

  const HIJACK_STEPS = ["Read your listing", "Search for copied titles", "Compare photos"];

  async function startHijackCheck(itemNumber) {
    if (!requireSignIn()) return;
    itemNumber = normalizeItemNumber(itemNumber);
    if (!itemNumber) {
      showToast("Enter a valid item number");
      return;
    }
    const check = {
      id: `${Date.now()}${Math.random()}`,
      itemNumber,
      source: null,
      state: "loading",
      stage: 0,
      progress: 3,
      ceiling: 15,
      message: "Reading your listing…",
      matches: [],
      checked: 0,
    };
    lastHijack = check;
    hijackSite = "ebay";
    closeMini();
    openPopup("hijacks");

    const stage = (index, message, from, ceiling) => {
      if (lastHijack !== check) return false;
      check.stage = index;
      check.message = message;
      check.progress = Math.max(check.progress, from);
      check.ceiling = ceiling;
      updateHijackProgress();
      return true;
    };
    const creep = setInterval(() => {
      if (lastHijack !== check || check.state !== "loading") return clearInterval(creep);
      check.progress = Math.min(check.ceiling, check.progress + Math.max(0.15, (check.ceiling - check.progress) * 0.05));
      updateHijackProgress();
    }, 120);

    try {
      if (navigator.onLine === false) throw new TypeError("Failed to fetch");
      const source = await readListing(itemNumber);
      check.source = source;
      source.tokens = titleTokens(source.title);
      source.trigrams = shingles(source.tokens);
      if (lastHijack === check && popup && popup.tab === "hijacks") renderHijackView();

      const queries = buildTitleQueries(source.title);
      if (!stage(1, "Searching for copied titles…", 16, 58)) return;
      const pool = new Map();
      for (let q = 0; q < queries.length; q++) {
        const items = await searchTitles(queries[q]);
        if (lastHijack !== check) return;
        items.forEach((item) => {
          if (!pool.has(item.itemNumber)) pool.set(item.itemNumber, item);
        });
        check.progress = Math.max(check.progress, 16 + ((q + 1) / queries.length) * 40);
        updateHijackProgress();
      }

      await ebayOwnEnsure([...pool.values()].map((item) => item.itemNumber));
      const candidates = [...pool.values()].filter(
        (item) =>
          item.itemNumber !== itemNumber &&
          !isMineEbay(item.itemNumber) &&
          !(source.seller && sellerName(item.seller) === source.seller)
      );
      check.checked = candidates.length;

      candidates.forEach((item) => {
        item.tokens = titleTokens(item.title);
        item.trigrams = shingles(item.tokens);
        item.titleScore = titleSimilarity(source, item.tokens);
      });
      const distinctive = new Set();
      source.trigrams.forEach((gram) => {
        const used = candidates.filter((item) => item.trigrams.has(gram)).length;
        if (candidates.length < 10 || used / candidates.length < 0.2) distinctive.add(gram);
      });
      source.distinctive = distinctive;
      candidates.forEach((item) => {
        let shared = 0;
        distinctive.forEach((gram) => {
          if (item.trigrams.has(gram)) shared++;
        });
        item.uniqueShare = distinctive.size ? shared / distinctive.size : 0;
        item.exactTitle = item.tokens.join(" ") === source.tokens.join(" ");
      });

      if (!stage(2, "Comparing photos…", 60, 96)) return;
      if (navigator.onLine === false) throw new TypeError("Failed to fetch");
      const sourceHashes = (await mapLimit(source.imageIds, 6, photoHash)).filter(Boolean);
      const sourceIdSet = new Set(source.imageIds);
      let done = 0;
      await mapLimit(candidates.slice(0, 300), 8, async (item) => {
        const id = ebayImageId(item.image);
        item.samePhoto = false;
        if (id && sourceIdSet.has(id)) item.samePhoto = true;
        else if (id && sourceHashes.length) {
          const hash = await photoHash(id);
          if (hash) item.samePhoto = Math.min(...sourceHashes.map((h) => hamming(h, hash))) <= 6;
        }
        done++;
        if (done % 10 === 0 && lastHijack === check) {
          check.progress = Math.max(check.progress, 60 + (done / Math.min(candidates.length, 300)) * 34);
          updateHijackProgress();
        }
      });
      if (lastHijack !== check) return;
      if (navigator.onLine === false) throw new TypeError("Failed to fetch");

      const matches = [];
      candidates.forEach((item) => {
        const s = item.titleScore;
        const u = item.uniqueShare;
        let level = 0;
        if (item.exactTitle || (s >= 0.9 && u >= 0.6) || (item.samePhoto && s >= 0.6)) level = 3;
        else if ((u >= 0.5 && s >= 0.55) || item.samePhoto) level = 2;
        else if (s >= 0.55) level = 1;
        if (!level) return;
        item.level = level;
        item.kind = "hijack";
        matches.push(item);
        discovered.set(item.itemNumber, {
          title: item.title,
          url: item.url,
          image: item.image,
          price: item.price,
          seller: item.seller,
          kind: "hijack",
          source: itemNumber,
          hunt: `ebay:${itemNumber}`,
        });
      });
      matches.sort(
        (a, b) =>
          b.level - a.level ||
          Number(b.samePhoto) - Number(a.samePhoto) ||
          b.uniqueShare - a.uniqueShare ||
          b.titleScore - a.titleScore
      );
      check.matches = matches;

      stage(3, `Checked ${candidates.length} listings`, 100, 100);
      await new Promise((r) => setTimeout(r, 300));
      if (lastHijack !== check) return;
      clearInterval(creep);
      check.state = "done";
      if (popup && popup.tab === "hijacks") renderHijackView();
      updateTabCounts();
    } catch (err) {
      clearInterval(creep);
      if (lastHijack !== check) return;
      retryAfterEbayPause(err, "hijack", () => startHijackCheck(itemNumber), () => lastHijack === check);
      if (await isConnectionProblem(err)) {
        check.state = "offline";
        check.message = "No internet connection";
        retryWhenOnline("hijack", () => {
          if (lastHijack === check) startHijackCheck(itemNumber);
        });
      } else {
        check.state = "error";
        check.message = (err && err.message) || "Something went wrong. Try again.";
      }
      if (popup && popup.tab === "hijacks") renderHijackView();
    }
  }

  const LEVELS = {
    3: { label: "Exact copy", cls: "eif-lvl-3" },
    2: { label: "Likely copied", cls: "eif-lvl-2" },
    1: { label: "Common wording", cls: "eif-lvl-1" },
  };

  function hijackStartHtml() {
    const pageItem = currentPageItemNumber();
    const mine = [...protectedItems].slice(0, 12);
    return `
      <div class="eif-center eif-empty-plain">
        <div class="eif-empty-icon"><span class="eif-ic-hero"></span></div>
        <div class="eif-empty-title">Check for hijacked listings</div>
        <div class="eif-empty-sub">Finds listings that copy your <b>title</b> wording or reuse your actual <b>photos</b>, even when the design is different.</div>
        ${pageItem ? `<button class="eif-hunt-btn eif-hunt-btn-primary" type="button" data-action="hj-check" data-item-number="${pageItem}">Check this listing (#${pageItem})</button>` : ""}
        <div class="eif-hj-form">
          <input id="eif-hj-input" inputmode="numeric" maxlength="15" placeholder="Item number" />
          <button class="eif-hunt-btn" type="button" data-action="hj-check-input">Check</button>
        </div>
        ${
          mine.length
            ? `<div class="eif-hj-mine"><div class="eif-hj-mine-label">Your listings</div>${mine
                .map((n) => `<button class="eif-hj-chip" type="button" data-action="hj-check" data-item-number="${n}">#${n}</button>`)
                .join("")}</div>`
            : ""
        }
      </div>`;
  }

  function renderHijackView() {
    const view = viewEl();
    if (!view) return;
    if (hijackSite === "amazon") renderAmazonHijackView();
    else renderEbayHijackView();
    hijackSiteSwitch(view);
  }

  function renderEbayHijackView() {
    const view = viewEl();
    if (!view) return;
    const check = lastHijack;
    if (!check) {
      view.innerHTML = hijackStartHtml();
      return;
    }
    const source = check.source;
    const thumb = source && source.imageIds[0] ? `https://i.ebayimg.com/images/g/${source.imageIds[0]}/s-l140.jpg` : "";
    const counts = [3, 2, 1].map((l) => check.matches.filter((m) => m.level === l).length);
    const flagged = check.matches.filter((m) => m.level >= 2);
    const common = check.matches.filter((m) => m.level === 1);
    let status = escapeHtml(check.message);
    let tone = check.state === "error" || check.state === "offline" ? "err" : "";
    if (check.state === "done") {
      status = flagged.length
        ? `${flagged.length} likely hijack${flagged.length > 1 ? "s" : ""} in ${check.checked} listings checked (${counts[0]} exact, ${counts[1]} likely).`
        : `No copied titles or photos found in ${check.checked} listings checked.`;
      if (common.length) status += ` ${common.length} more only share common wording.`;
      tone = flagged.length ? "warn" : "ok";
    }

    view.innerHTML = `
      <div class="eif-results-head">
        ${thumb ? `<img class="eif-src-thumb" alt="" src="${safeSrc(thumb)}" />` : '<span class="eif-src-thumb"></span>'}
        <div class="eif-results-meta">
          <div class="eif-results-title eif-hj-source-title">${source ? escapeHtml(source.title) : "Your listing"} <span class="eif-hunt-source">#${check.itemNumber}</span></div>
          <div id="eif-hunt-status" class="${tone ? `eif-${tone}` : ""}">${status}</div>
        </div>
        ${check.state !== "loading" ? `<button class="eif-hunt-btn" type="button" data-action="hj-new">Check another</button>` : ""}
        ${check.state !== "loading" ? `<button class="eif-hunt-btn" type="button" data-action="hj-check" data-item-number="${check.itemNumber}">Re-check</button>` : ""}
      </div>
      <div class="eif-scroll">
        ${
          check.state === "loading"
            ? `<div class="eif-center"><div class="eif-progress-card">
                 <div class="eif-progress-top">${LOADER()}<span id="eif-hj-text">${escapeHtml(check.message)}</span><span id="eif-hj-pct">0%</span></div>
                 <div class="eif-progress"><div class="eif-progress-fill" id="eif-hj-fill"></div></div>
                 <ol class="eif-progress-steps">${HIJACK_STEPS.map((label, i) => `<li data-step="${i}">${label}</li>`).join("")}</ol>
               </div></div>`
            : check.state === "offline"
              ? offlineHtml("The hijack check")
              : check.state === "error"
              ? `<div class="eif-center eif-error"><div>${escapeHtml(check.message)}</div></div>`
              : hijackListHtml(check, flagged, common)
        }
      </div>`;
    if (check.state === "loading") updateHijackProgress();
    if (check.state === "done") refreshHijackRows();
  }

  function hijackListHtml(check, flagged, common) {
    const source = check.source;
    const fewOwnWords = source.distinctive && source.distinctive.size < 2;
    let html = "";
    if (fewOwnWords) {
      html += `<div class="eif-hj-note">Most of this title is wording every seller of this design uses (usually the slogan on the shirt), so title copies are hard to separate from design copies. Photo matches are still reliable.</div>`;
    }
    if (flagged.length) {
      const exact = flagged.filter((m) => m.level === 3).length;
      html += `<div class="eif-hj-bulk" id="eif-hj-bulk">
          <label class="eif-hj-all"><input type="checkbox" class="eif-hj-allcheck" /> Select all</label>
          <span class="eif-hj-selcount"></span>
          <button class="eif-hunt-btn" type="button" data-action="hj-track-sel" disabled>Mark selected as copycats</button>
          ${exact ? `<button class="eif-hunt-btn" type="button" data-action="hj-track-exact">Mark all exact copies (${exact})</button>` : ""}
          <button class="eif-hunt-btn eif-hunt-btn-green" type="button" data-action="hj-report">Report copycats</button>
        </div>`;
      html += `<div class="eif-list">${flagged.map((m) => hijackRowHtml(m, source)).join("")}</div>`;
    } else {
      html += `<div class="eif-center eif-hj-clean"><div class="eif-empty-title">No hijacks found</div><div class="eif-empty-sub">Nobody in these results copies your own title wording or reuses your photos.</div></div>`;
    }
    if (common.length) {
      html += `
        <details class="eif-hj-common">
          <summary>${common.length} listing${common.length > 1 ? "s" : ""} only share common wording <span>(the slogan or phrases most sellers use)</span></summary>
          <div class="eif-list">${common.map((m) => hijackRowHtml(m, source)).join("")}</div>
        </details>`;
    }
    return html;
  }

  function hijackRowHtml(item, source) {
    const level = LEVELS[item.level];
    return `
      <div class="eif-tr-row eif-hj-row" data-item-number="${item.itemNumber}">
        <input type="checkbox" class="eif-hj-check" data-item-number="${item.itemNumber}" aria-label="Select #${item.itemNumber}" />
        <a class="eif-hj-thumb" href="${safeHref(item.url)}" target="_blank" rel="noopener">
          ${item.image ? `<img src="${safeSrc(item.image)}" alt="" loading="lazy" />` : ""}
        </a>
        <div class="eif-tr-main">
          <a class="eif-hj-title" href="${safeHref(item.url)}" target="_blank" rel="noopener">${highlightCopied(item.title, source.trigrams, source.distinctive)}</a>
          <div class="eif-hj-tags">
            <span class="eif-hj-level ${level.cls}">${level.label}</span>
            <span class="eif-hj-score" title="How much of the title wording and word order matches yours">${Math.round(item.titleScore * 100)}% title match</span>
            ${source.distinctive && source.distinctive.size >= 2 ? `<span class="eif-hj-unique${item.uniqueShare ? "" : " eif-hj-unique-zero"}" title="How much of YOUR OWN wording (not the common slogan) they use">${Math.round(item.uniqueShare * 100)}% of your own wording</span>` : ""}
            ${item.samePhoto ? '<span class="eif-hj-photo">Same photo</span>' : ""}
            <span class="eif-tr-num">#${item.itemNumber}</span>
            ${item.seller ? `<span class="eif-hj-seller">${escapeHtml(sellerName(item.seller))}</span>` : ""}
            ${item.price ? `<span class="eif-hj-seller">${escapeHtml(item.price)}</span>` : ""}
          </div>
        </div>
        <button class="eif-hc-track eif-hj-track" type="button" data-action="track"></button>
      </div>`;
  }

  function hijackSelected() {
    return popup ? [...popup.overlay.querySelectorAll(".eif-hj-check:checked")].map((c) => c.dataset.itemNumber) : [];
  }
  function updateHijackBulk() {
    const bar = popup && popup.overlay.querySelector("#eif-hj-bulk");
    if (!bar) return;
    const flaggedBoxes = [...popup.overlay.querySelectorAll(".eif-list > .eif-hj-row .eif-hj-check")].filter((c) => !c.closest(".eif-hj-common"));
    const n = hijackSelected().length;
    const all = bar.querySelector(".eif-hj-allcheck");
    all.checked = flaggedBoxes.length > 0 && flaggedBoxes.every((c) => c.checked);
    all.indeterminate = !all.checked && flaggedBoxes.some((c) => c.checked);
    bar.querySelector(".eif-hj-selcount").textContent = n ? `${n} selected` : "";
    const t = bar.querySelector('[data-action="hj-track-sel"]');
    t.disabled = !n;
    t.textContent = n ? `Mark selected as copycats (${n})` : "Mark selected as copycats";
  }
  function trackMany(list) {
    let added = 0;
    list.forEach((n) => {
      if (!n || isMineEbay(n) || trackedItems.has(n)) return;
      const meta = discovered.get(n) || { title: "Untitled listing", url: `https://www.ebay.com/itm/${n}` };
      trackedItems.set(n, { ...meta, reportedAt: "" });
      huntImageFrom(meta.hunt, meta.image);
      added++;
    });
    if (!added) return 0;
    saveTrackedItems();
    list.forEach((n) => syncBadgeProtection(n));
    updatePanel();
    refreshHuntCards();
    return added;
  }

  function refreshHijackRows() {
    if (!popup || popup.tab !== "hijacks") return;
    updateHijackBulk();
    popup.overlay.querySelectorAll(".eif-hj-row").forEach((row) => {
      const itemNumber = row.dataset.itemNumber;
      const isTracked = trackedItems.has(itemNumber);
      const button = row.querySelector(".eif-hj-track");
      row.classList.toggle("eif-hj-tracked", isTracked);
      button.textContent = isTracked ? "✓ Copycat" : "Copycat";
      button.dataset.ic = isTracked ? "" : "bookmark";
      button.setAttribute("aria-pressed", String(isTracked));
    });
  }

  function updateHijackProgress() {
    const check = lastHijack;
    if (!popup || popup.tab !== "hijacks" || hijackSite !== "ebay" || !check || check.state !== "loading") return;
    const fill = popup.overlay.querySelector("#eif-hj-fill");
    if (!fill) {
      renderHijackView();
      return;
    }
    const pct = Math.round(check.progress);
    fill.style.width = `${pct}%`;
    popup.overlay.querySelector("#eif-hj-pct").textContent = `${pct}%`;
    M.swap(popup.overlay.querySelector("#eif-hj-text"), check.message);
    const status = popup.overlay.querySelector("#eif-hunt-status");
    if (status) status.textContent = check.message;
    popup.overlay.querySelectorAll(".eif-progress-steps li").forEach((li) => {
      const i = Number(li.dataset.step);
      li.classList.toggle("eif-step-done", i < check.stage || check.stage === 3);
      li.classList.toggle("eif-step-active", i === check.stage);
    });
  }

  const REPORT_BATCH = 25;
  const DETAILS_MAX = 1000;

  const REPORT_OPTIONS = {
    contentType: ["Product or listing", "Member or store information"],
    reason: ["Intellectual property (IP) infringement", "A problem in the listing", "Item not allowed"],
    detail: [
      "Infringes copyright",
      "Infringes design rights",
      "Counterfeit item",
      "Enables IP infringement",
      "Infringes patent",
      "Infringes rights of publicity",
    ],
  };

  const DEFAULT_TEMPLATES = [
    {
      id: "tpl-design",
      name: "Copied design",
      contentType: "Product or listing",
      reason: "Intellectual property (IP) infringement",
      detail: "Infringes copyright",
      text:
        "These {count} listings sell copies of my original design without my permission. I created this artwork and published it on {platform}: {original_link}. {copy_dates} The reported listings copy or recreate my design. Reported on {today}.",
    },
    {
      id: "tpl-changed",
      name: "Copied with changes",
      contentType: "Product or listing",
      reason: "Intellectual property (IP) infringement",
      detail: "Infringes copyright",
      text:
        "These {count} listings sell copies of my original design without my permission. I created this artwork and published it on {platform}: {original_link}. {copy_dates} The reported listings reproduce my artwork with small changes, such as an added element or different text, but the copied artwork is clearly mine. Reported on {today}.",
    },
    {
      id: "tpl-photos",
      name: "Hijacked listing photos",
      contentType: "Product or listing",
      reason: "Intellectual property (IP) infringement",
      detail: "Infringes copyright",
      text:
        "These {count} listings use my own product photos and listing content without my permission. My original listing is on {platform}: {original_link}. {copy_dates} Reported on {today}.",
    },
  ];

  let reportTemplates = DEFAULT_TEMPLATES.map((t) => ({ ...t }));
  let activeTemplateId = DEFAULT_TEMPLATES[0].id;
  let reportJob = null;
  let reportDraft = null;
  let rpChoicesOpen = false;
  let reportName = "";
  let reportSelection = null;
  let originals = {};
  let reportHistory = [];
  const originalFetches = new Set();

  const PLATFORMS = ["eBay", "Amazon", "Etsy", "Redbubble", "TeePublic", "Spreadshirt", "Printify / Shopify store", "My own website", "Other"];

  const OLD_DEFAULT_TEXTS = [
    "These {count} listings sell copies of my original design without my permission. I created this artwork and first published it on {platform} on {published}: {original_link}. {copy_dates} The reported listings copy or recreate my design. Reported on {today}.",
    "These {count} listings use my own product photos and listing content without my permission. My original listing is on {platform}, published on {published}: {original_link}. {copy_dates} Reported on {today}.",
    "These {count} listings sell copies of my original design without my permission. I created this artwork and first published it on {platform} on {published}: {original_link}. The reported listings copy or recreate my design. Reported on {today}.",
    "These {count} listings use my own product photos and listing content without my permission. My original listing is on {platform}, published on {published}: {original_link}. Reported on {today}.",
    "These listings sell my original artwork without my permission. I created this design and sell it in my own listing #{my_item} ({my_link}). The listings reported here copy or recreate my design. Reported on {date}.",
    "These listings use my own product photos and listing content, copied from my listing #{my_item} ({my_link}) without my permission. Reported on {date}.",
  ];

  function loadReportState(done) {
    if (!hasStorage) return done();
    chrome.storage.local.get({ eifTemplates: null, eifActiveTemplate: null, eifReportJob: null, eifOriginals: {}, eifReportHistory: [], eifTplChangedAdded: false }, (data) => {
      reportHistory = Array.isArray(data.eifReportHistory) ? data.eifReportHistory : [];
      if (Array.isArray(data.eifTemplates) && data.eifTemplates.length) {
        reportTemplates = data.eifTemplates.map((t) => {
          const builtIn = DEFAULT_TEMPLATES.find((d) => d.id === t.id);
          return builtIn && OLD_DEFAULT_TEXTS.includes(t.text) ? { ...t, text: builtIn.text } : t;
        });
        if (!data.eifTplChangedAdded && !reportTemplates.some((t) => t.id === "tpl-changed")) {
          const at = Math.max(0, reportTemplates.findIndex((t) => t.id === "tpl-design") + 1);
          reportTemplates.splice(at, 0, { ...DEFAULT_TEMPLATES.find((d) => d.id === "tpl-changed") });
          chrome.storage.local.set({ eifTemplates: reportTemplates });
        }
      }
      if (!data.eifTplChangedAdded) chrome.storage.local.set({ eifTplChangedAdded: true });
      originals = data.eifOriginals && typeof data.eifOriginals === "object" ? data.eifOriginals : {};
      if (data.eifActiveTemplate && reportTemplates.some((t) => t.id === data.eifActiveTemplate)) {
        activeTemplateId = data.eifActiveTemplate;
      }
      reportJob = data.eifReportJob || null;
      done();
    });
  }

  function saveTemplates() {
    if (hasStorage) chrome.storage.local.set({ eifTemplates: reportTemplates, eifActiveTemplate: activeTemplateId });
  }

  function saveHistory() {
    if (hasStorage) chrome.storage.local.set({ eifReportHistory: reportHistory.slice(-500) });
  }

  function saveOriginals() {
    if (hasStorage) chrome.storage.local.set({ eifOriginals: originals });
  }

  function saveJob() {
    if (hasStorage) chrome.storage.local.set({ eifReportJob: reportJob });
  }

  function activeTemplate() {
    return reportTemplates.find((t) => t.id === activeTemplateId) || reportTemplates[0];
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function niceDate(iso) {
    const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(iso || "");
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  }

  function huntThumb(key) {
    const h = hunts.get(key) || {};
    return h.image ? `<img class="eif-hunt-thumb" src="${safeSrc(h.image)}" alt="" loading="lazy" />` : "";
  }

  function huntMoveSelect(kind, id, keys, allowNew, label) {
    if (!keys.length && !allowNew) return "";
    return `<select class="eif-rp-move ${id.startsWith("@") ? "eif-rp-move-bulk" : ""}" data-move-kind="${kind}" data-move-id="${escapeHtml(id)}" title="Only if a copy ended up under the wrong design">
      <option value="" disabled selected hidden>${label || "Copy of…"}</option>${keys.map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(huntLabel(k))}</option>`).join("")}${allowNew ? '<option value="__new">A different design (new group)</option>' : ""}</select>`;
  }

  function moveToHunt(kind, id, key) {
    if (!key) return;
    const ids = String(id).split(",").filter(Boolean);
    if (ids.length > 1) {
      if (key === "__new") {
        moveToHunt(kind, ids[0], key);
        key = (kind === "ebay" ? trackedItems : amazonTracked).get(ids[0]).hunt;
        ids.shift();
      }
      ids.forEach((one) => moveToHunt(kind, one, key));
      return;
    }
    if (key === "__new") {
      const m = (kind === "ebay" ? trackedItems : amazonTracked).get(id);
      if (!m) return;
      const n = [...hunts.keys()].filter((k) => k.startsWith("split:")).length + 1;
      key = `split:${Date.now().toString(36)}`;
      registerHunt(key, { label: `Other design ${n}`, image: /^https:/.test(m.image || "") ? m.image : "" });
    }
    if (kind === "ebay") {
      const m = trackedItems.get(id);
      if (!m) return;
      m.hunt = key;
      m.source = "";
      saveTrackedItems();
    } else {
      const m = amazonTracked.get(id);
      if (!m) return;
      m.hunt = key;
      saveAmazon();
    }
    showToast(`Moved to ${huntLabel(key)}`);
  }

  function groupKey(group) {
    return (group && (group.key || group.source)) || "_unlinked";
  }

  function originalFor(group) {
    const key = groupKey(group);
    const info = originals[key] || {};
    const huntAsin = group && group.hunt && group.hunt.startsWith("amz:") ? group.hunt.slice(4) : "";
    const ownAsin = huntAsin && (amazonMine.has(huntAsin) || (typeof merchIsOwn === "function" && merchIsOwn(huntAsin))) ? huntAsin : "";
    const platform = info.platform || (group && group.source ? "eBay" : ownAsin ? "Amazon" : "");
    const link =
      info.link ||
      (platform === "eBay" && group && group.source ? `https://www.ebay.com/itm/${group.source}` : "") ||
      (platform === "Amazon" && ownAsin ? amzUrl(ownAsin) : "");
    return {
      ...info,
      platform,
      platformLabel: platform === "Other" ? info.platformName || "" : platform,
      link,
      published: info.published || "",
    };
  }

  const PLATFORM_HOSTS = {
    eBay: /(^|\.)ebay\.[a-z.]{2,}$/,
    Amazon: /(^|\.)(amazon\.[a-z.]{2,}|amzn\.to|amzn\.eu|a\.co)$/,
    Etsy: /(^|\.)(etsy\.com|etsy\.me)$/,
    Redbubble: /(^|\.)redbubble\.com$/,
    TeePublic: /(^|\.)teepublic\.com$/,
    Spreadshirt: /(^|\.)(spreadshirt|spreadshop)\.[a-z.]{2,}$/,
  };

  function linkProblem(platform, link) {
    const value = String(link || "").trim();
    if (!value) return "Paste the link to your original.";
    const notLink = "That isn't a web link. Copy the full address from your browser (it starts with https://).";
    let url;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
    } catch (e) {
      return notLink;
    }
    if (!/^https?:$/.test(url.protocol) || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(url.hostname)) return notLink;
    const host = url.hostname.toLowerCase();
    const rule = PLATFORM_HOSTS[platform];
    if (rule && !rule.test(host)) return `That link isn't on ${platform}. Paste the link to your design's page on ${platform}.`;
    if (rule && url.pathname.replace(/\/+$/, "").length < 2) return `That's ${platform}'s home page. Paste the link to your design's own page.`;
    return "";
  }

  function dateProblem(value) {
    const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return "Enter the date you first published it.";
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (isNaN(d) || d.getUTCMonth() !== +m[2] - 1) return "That date doesn't exist.";
    if (+m[1] < 1995) return "That year looks wrong. Enter the real date you first published it.";
    if (value > today()) return "That date is in the future.";
    return "";
  }

  function originalProblems(group) {
    const o = originalFor(group);
    const p = {};
    if (!o.platform) p.platform = "Choose where your original is.";
    else if (!(o.platform === "eBay" && group && group.source)) {
      const l = linkProblem(o.platform, o.link);
      if (l) p.link = l;
    }
    if (o.platform === "Other" && !String(o.platformName || "").trim()) p.platformName = "Type the platform's name.";
    const d = dateProblem(o.published);
    if (d) p.date = d;
    return p;
  }

  function missingInfo(text, group) {
    const o = originalFor(group);
    const bad = originalProblems(group);
    const miss = [];
    if (!o.platformLabel || bad.platform || bad.platformName) miss.push("platform");
    if (!o.link || bad.link) miss.push("link");
    if (bad.date) miss.push("date");
    return miss;
  }

  function fillPlaceholders(text, group) {
    const o = originalFor(group);
    return String(text || "")
      .replace(/\{platform\}/g, o.platformLabel || "[platform]")
      .replace(/\{original_link\}|\{my_link\}/g, (o.link && !originalProblems(group).link && o.link) || "[link to your original]")
      .replace(/\{my_item\}/g, (group && group.source) || o.link || "[your listing]")
      .replace(/\{published\}/g, o.published ? niceDate(o.published) : "[date first published]")
      .replace(/\{count\}/g, String(group ? group.items.length : 0))
      .replace(/\{copy_dates\}/g, () => copyDatesSentence(group, o))
      .replace(/\{today\}|\{date\}/g, niceDate(today()))
      .replace(/ {2,}/g, " ")
      .trim();
  }

  function parseListingDate(html) {
    const wrapped = html.match(/"(?:startDate|startTime|listingStartDate)"\s*:\s*\{\s*"value"\s*:\s*"(\d{4}-\d{2}-\d{2})/);
    if (wrapped) return wrapped[1];
    const iso =
      html.match(/"(?:listingStartDate|startDate|startTime|itemStartDate|creationDate|itemCreationDate)"\s*:\s*"(\d{4}-\d{2}-\d{2})/i) ||
      html.match(/"startTime"\s*:\s*\{[^}]{0,120}?"value"\s*:\s*"(\d{4}-\d{2}-\d{2})/i);
    if (iso) return iso[1];
    const ms = html.match(/"(?:startTime|listingStartTime)"\s*:\s*(\d{13})/);
    if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
    const text = html.match(/(?:Listed|Started)\s+(?:on|since)\s*:?\s*([A-Z][a-z]{2,8}\.?\s+\d{1,2},\s+\d{4})/);
    if (text) {
      const d = new Date(text[1].replace(".", ""));
      if (!isNaN(d)) return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10);
    }
    return "";
  }

  function pageSaysYourItem(textOrHtml) {
    return /your item is for sale/i.test(textOrHtml);
  }

  const listingDateFetches = new Set();
  const listingDateFails = new Map();
  const DATE_TRY_MS = 45000;
  const DATE_MAX_TRIES = 3;
  const dateRetryWait = (count) => 20000 * count;
  function dateGaveUp(n) {
    const f = listingDateFails.get(n);
    return !!f && f.count >= DATE_MAX_TRIES;
  }
  function dateWaiting(n) {
    const f = listingDateFails.get(n);
    return !!f && f.count < DATE_MAX_TRIES && Date.now() - f.at < dateRetryWait(f.count);
  }
  let dateRetryTimer = 0;
  function dateFailed(n) {
    const f = listingDateFails.get(n) || { count: 0, at: 0 };
    f.count++;
    f.at = Date.now();
    listingDateFails.set(n, f);
    if (f.count < DATE_MAX_TRIES && !dateRetryTimer) {
      dateRetryTimer = setTimeout(() => { dateRetryTimer = 0; if (popup && popup.tab === "report" && reportSite !== "amazon") loadReportDates(); }, dateRetryWait(f.count) + 500);
    }
  }
  let dateRenderTimer = 0;
  function dateScheduleRender() {
    clearTimeout(dateRenderTimer);
    dateRenderTimer = setTimeout(() => {
      applyDateSafety();
      if (popup && popup.tab === "report" && reportSite !== "amazon") renderReportView();
    }, 300);
  }
  async function fetchListingStart(itemNumber) {
    if (listingDateFetches.has(itemNumber)) return;
    listingDateFetches.add(itemNumber);
    let timer = 0;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("date-timeout"), { dateTimeout: true })), DATE_TRY_MS); });
      const res = await Promise.race([ebayFetch(`${EBAY}/itm/${itemNumber}`, { credentials: "include" }), timeout]);
      const meta = trackedItems.get(itemNumber);
      if (!res.ok) {
        if ((res.status === 404 || res.status === 410) && meta) { meta.listedAt = "unknown"; saveTrackedItems(); }
        else dateFailed(itemNumber);
        return;
      }
      const date = parseListingDate(await Promise.race([res.text(), timeout]));
      if (meta) {
        meta.listedAt = date || "unknown";
        saveTrackedItems();
      }
      listingDateFails.delete(itemNumber);
    } catch (e) {
      if (e && e.dateTimeout) { dateFailed(itemNumber); return; }
      const paused = e?.code === "EBAY_PAUSED";
      retryAfterEbayPause(e, "dates", loadReportDates, () => popup?.tab === "report");
      if (await isConnectionProblem(e)) retryWhenOnline("dates", loadReportDates);
      else if (!paused) dateFailed(itemNumber);
    } finally {
      clearTimeout(timer);
      listingDateFetches.delete(itemNumber);
      dateScheduleRender();
    }
  }

  let dateQueueBusy = false;
  async function loadReportDates() {
    if (dateQueueBusy || ebayRequestState?.paused) return;
    const todo = [...trackedItems.entries()]
      .filter(([n, m]) => !m.listedAt && !listingDateFetches.has(n) && !dateGaveUp(n) && !dateWaiting(n))
      .map(([n]) => n);
    if (!todo.length) return;
    dateQueueBusy = true;
    try {
      await mapLimit(todo, 4, fetchListingStart);
    } finally {
      dateQueueBusy = false;
    }
    dateScheduleRender();
  }

  function applyDateSafety() {
    if (!reportSelection) return;
    reportGroups(false).forEach((group) => {
      const published = originalFor(group).published;
      if (!published || dateProblem(published)) return;
      group.items.forEach((n) => {
        const meta = trackedItems.get(n);
        if (meta && /^\d{4}-/.test(meta.listedAt || "") && meta.listedAt < published && !meta.dateFlagSeen) {
          meta.dateFlagSeen = true;
          reportSelection.delete(n);
        }
      });
    });
  }

  function copyDatesSentence(group, o) {
    const dates = group
      ? group.items.map((n) => (trackedItems.get(n) || {}).listedAt).filter((d) => /^\d{4}-/.test(d || "")).sort()
      : [];
    const parts = [];
    if (dates.length) {
      const first = dates[0];
      const last = dates[dates.length - 1];
      parts.push(
        first === last
          ? `${dates.length > 1 ? "They" : "It"} appeared on ${niceDate(first)}.`
          : `They appeared between ${niceDate(first)} and ${niceDate(last)}.`
      );
    }
    if (o && o.published) {
      const beforeAll = dates.length && o.published <= dates[0];
      parts.push(`My original was live since ${niceDate(o.published)}${beforeAll ? `, before ${dates.length > 1 ? "all of them" : "it"}` : ""}.`);
    }
    return parts.join(" ");
  }

  function earliestCopyDate(items) {
    const dates = items.map((n) => (trackedItems.get(n) || {}).listedAt).filter((d) => /^\d{4}-/.test(d || "")).sort();
    return dates[0] || "";
  }

  async function fetchEbayOriginal(itemNumber) {
    if (originalFetches.has(itemNumber)) return;
    originalFetches.add(itemNumber);
    try {
      const res = await ebayFetch(`${EBAY}/itm/${itemNumber}`, { credentials: "include" });
      if (!res.ok) {
        originals[itemNumber] = { ...(originals[itemNumber] || {}), fetched: true };
        saveOriginals();
        if (popup && popup.tab === "mine") renderMineView();
        return;
      }
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const title = ((doc.querySelector("h1.x-item-title__mainTitle") || {}).textContent || "").replace(/\s+/g, " ").trim();
      const ogImage = (doc.querySelector('meta[property="og:image"]') || {}).content || "";
      const info = originals[itemNumber] || {};
      originals[itemNumber] = {
        ...info,
        platform: info.platform || "eBay",
        item: itemNumber,
        title: title || info.title || "",
        image: ogImage || info.image || "",
        fetched: true,
        verified: pageSaysYourItem(html),
        published: info.published || parseListingDate(html),
        dateFromEbay: !info.published && !!parseListingDate(html),
      };
      saveOriginals();
      if (popup && popup.tab === "report") renderReportView();
      if (popup && popup.tab === "mine") renderMineView();
    } catch (e) {
      originalFetches.delete(itemNumber);
      retryAfterEbayPause(e, `original-${itemNumber}`, () => fetchEbayOriginal(itemNumber), () => protectedItems.has(itemNumber) || Object.values(originals).some((o) => o.item === itemNumber));
      if (await isConnectionProblem(e)) {
        retryWhenOnline(`orig-${itemNumber}`, () => {
          if (popup && popup.tab === "report") renderReportView();
          else if (popup && popup.tab === "mine") renderMineView();
          else fetchEbayOriginal(itemNumber);
        });
      }
    }
  }

  function reportGroups(onlySelected) {
    const groups = new Map();
    trackedItems.forEach((meta, itemNumber) => {
      if (isMineEbay(itemNumber)) return;
      if (meta.reportedAt) return;
      if (onlySelected && reportSelection && !reportSelection.has(itemNumber)) return;
      let source = meta.source || "";
      if (!source && /^ebay:\d+$/.test(meta.hunt || "")) source = meta.hunt.slice(5);
      if (source && (!isMineEbay(source) || trackedItems.has(source))) source = "";
      const hunt = source ? "" : meta.hunt || "";
      const key = source || (hunt ? `h:${hunt}` : "_unlinked");
      if (!groups.has(key)) groups.set(key, { key, source, hunt, items: [] });
      groups.get(key).items.push(itemNumber);
    });
    return [...groups.values()];
  }

  function buildBatches(groups) {
    const batches = [];
    groups.forEach((group) => {
      for (let i = 0; i < group.items.length; i += REPORT_BATCH) {
        const chunk = group.items.slice(i, i + REPORT_BATCH);
        batches.push({ source: group.source, key: group.key || "", hunt: group.hunt || "", anchor: chunk[0], extras: chunk.slice(1), status: "pending" });
      }
    });
    return batches;
  }

  let merchMetaLoaded = false;
  let merchMeta = {};
  let merchStatus = null;
  const merchResults = new Map();
  const merchPending = new Map();
  let merchRevisionSeen = "";

  function merchConnected() {
    return !!(merchMeta && merchMeta.revision) && (!merchStatus || !!merchStatus.catalog?.sameAccount);
  }

  function merchResult(asin) {
    return merchResults.get(`${mpOfAsin(asin)}|${asin}`) || null;
  }

  function merchIsOwn(asin) {
    const r = merchResult(asin);
    return merchConnected() && !!(r && r.state === "catalog_matched");
  }

  function loadMerchMeta(done) {
    if (!hasStorage) return done && done();
    chrome.storage.local.get({ eifMerchMeta: {} }, (d) => {
      merchMeta = d.eifMerchMeta || {};
      const wasLoaded = merchMetaLoaded;
      merchMetaLoaded = true;
      if (!wasLoaded) refreshWidgetSub();
      merchRevisionSeen = merchMeta.revision || "";
      done && done();
    });
  }

  function onMerchMetaChange(next) {
    const wasGated = SITE === "amazon" && merchMetaLoaded && !merchConnected();
    const accountChanged = next?.account && merchMeta.account && next.account !== merchMeta.account;
    merchMeta = next || {};
    if (accountChanged) {
      merchStatus = { catalog: { sameAccount: false } };
      merchResults.clear();
      merchPending.clear();
      merchQueue.clear();
    }
    if (next?.state === "syncing") {
      merchGate = { state: "syncing", account: next.account };
      renderMerchGate();
    }
    if (wasGated && merchConnected()) {
      merchGate = { state: "idle" };
      onMerchUnlocked(merchMeta.count || 0);
    }
    if ((merchMeta.revision || "") !== merchRevisionSeen) {
      merchRevisionSeen = merchMeta.revision || "";
      merchResults.clear();
      merchPending.clear();
      merchQueue.clear();
    }
    if (popup && popup.tab === "report" && reportSite === "amazon") renderAmazonReportView();
    if (popup && popup.tab === "results" && lastSearch && lastSearch.view === "amazon") {
      merchLookupAsins([lastSearch.asin, ...((lastSearch.amazon && lastSearch.amazon.items) || []).map((i) => i.asin)]);
      refreshAmazonCards();
    }
  }

  let merchLookupTimer = 0;
  const merchQueue = new Set();
  function merchLookupAsins(asins, fresh) {
    if (!merchConnected()) return;
    asins.forEach((a) => {
      if (a && !merchResults.has(`${mpOfAsin(a)}|${a}`) && !merchPending.has(a)) merchQueue.add(a);
    });
    if (!merchQueue.size) return;
    clearTimeout(merchLookupTimer);
    merchLookupTimer = setTimeout(async () => {
      const batch = [...merchQueue];
      merchQueue.clear();
      const token = { revision: merchRevisionSeen };
      batch.forEach((a) => merchPending.set(a, token));
      const res = await bgSend({
        type: "eif-merch-lookup",
        items: batch.map((asin) => {
          const d = amazonDetails.get(dkey(asin));
          return { asin, marketplace: mpOfAsin(asin), pageAsins: (d && d.listing && d.listing.pageAsins) || [] };
        }),
        fresh: !!fresh,
      });
      batch.forEach((a) => {
        if (merchPending.get(a) === token) merchPending.delete(a);
      });
      if (token.revision !== merchRevisionSeen) return;
      if (res && res.ok) Object.entries(res.results || {}).forEach(([k, v]) => merchResults.set(k, v));
      batch.forEach((a) => { if (!merchResults.has(`${mpOfAsin(a)}|${a}`)) merchResults.set(`${mpOfAsin(a)}|${a}`, { state: "unknown", reason: "no_reply" }); });
      if (popup && popup.tab === "report" && reportSite === "amazon") azScheduleRender();
      if (popup && popup.tab === "results") refreshAmazonCards();
    }, 120);
  }

  async function merchSyncNow() {
    showToast("Syncing your Merch catalog…");
    merchMeta = { ...merchMeta, state: "syncing" };
    if (popup && popup.tab === "report") azScheduleRender();
    const res = await bgSend({ type: "eif-merch-sync" });
    if (res?.ok && res.catalog?.sameAccount) showToast(`Merch catalog synced: ${res.catalog.count} listings`);
    else showToast(merchReasonText(res?.meta?.lastError || res?.identity?.reason || "no_reply"));
    merchStatus = res;
    loadMerchMeta(() => { azScheduleRender(); if (popup && popup.tab === "mine") renderMineView(); });
  }

  function merchReasonText(reason) {
    return (
      {
        signed_out: "You're not signed in to merch.amazon.com in this browser.",
        logged_out: "Merch asked you to sign in again.",
        rate_limited: "Merch is rate-limiting requests. Try again in a few minutes.",
        identity_not_found: "Couldn't read your Merch account on the dashboard page.",
        network: "No connection to merch.amazon.com.",
        account_changed: "The signed-in Merch account changed during the sync. Sync again.",
        other_account: "You're signed in to a different Merch account than the synced catalog. Sync again.",
        not_synced: "Merch catalog not synced yet.",
        repeated_page_token: "Merch returned the same page twice. Sync stopped to be safe.",
        unexpected_response: "Merch answered in a format the extension doesn't recognise.",
        empty_result_kept_previous: "Merch returned no listings, so the previous catalog was kept.",
        too_many_pages: "The catalog is larger than expected. Sync stopped.",
        pagination_incomplete: "Merch stopped sending pages before the whole catalog arrived. The previous catalog was kept; sync again later.",
        timeout: "merch.amazon.com took too long to answer.",
        session_changed: "Your Amazon session changed during the check. Try again.",
        ambiguous_alias: "This ASIN points to more than one of your listings, so it can't be matched safely.",
        unrecognized_marketplace_records: "Some catalog records have a marketplace the extension doesn't recognise.",
        no_reply: "The extension's background script didn't answer. Reload the extension.",
        user_paused: "The catalog download is paused. Resume it on the setup page.",
        page_token_expired: "Merch no longer accepts the saved download position. Start over on the setup page.",
        pagination_runaway: "Merch kept sending pages past its own total, so the sync stopped. Sync again.",
        catalog_too_large: "This catalog has more listings than Copycat Hunt can keep (over 2,000,000).",
        storage_write: "Chrome couldn't save the catalog (disk full?). It tries again by itself.",
        staged_page_missing: "Part of the saved download is missing. Sync again.",
        storage_full: "Your computer's disk is full, so the catalog can't be saved. Free some space, then sync again.",
        storage_unavailable: "The catalog database on this computer didn't start. It tries again by itself.",
        storage_busy: "The catalog database on this computer is busy. Try again in a minute.",
        storage_io: "Chrome couldn't read or write the catalog database on this computer. Try again in a minute.",
        storage_timeout: "The catalog database took too long to answer. Try again in a minute.",
        storage_unsupported: "This browser can't keep the catalog database (Chrome 116 or newer needed).",
        storage_corrupt: "The catalog saved on this computer can't be read. Rebuild it on the setup page.",
        storage_newer: "The catalog on this computer is from a newer version of Copycat Hunt. Update the extension.",
        cancelled: "The catalog download was cancelled.",
        signed_out_during_sync: "Merch asked you to sign in again. The download continues after you sign in.",
        internal_error: "The catalog sync stopped unexpectedly. Sync again.",
      }[reason] || `Merch sync failed (${reason}).`
    );
  }

  function merchBoxHtml() {
    if (!merchStatus) {
      bgSend({ type: "eif-merch-status" }).then((st) => {
        merchStatus = st || { ok: false };
        const box = popup && popup.overlay.querySelector("#eif-az-merch");
        if (box) box.outerHTML = merchBoxHtml();
      });
      return '<div id="eif-az-merch" class="eif-az-merch"><span class="eif-rp-muted">Checking your Merch account…</span></div>';
    }
    const st = merchStatus;
    const meta = merchMeta || {};
    const ago = meta.syncedAt ? daysAgo(new Date(meta.syncedAt).toISOString().slice(0, 10)) : "";
    let line;
    if (meta.state === "syncing") line = LOADER() + escapeHtml(merchProgressText());
    else if (!st.ok) line = merchReasonText("no_reply");
    else if (st.catalog && st.catalog.sameAccount) line = `<span class="eif-rp-ok">✓ Connected</span> · account ${escapeHtml(st.catalog.account)} · ${st.catalog.count} listings · synced ${escapeHtml(ago || "today")}${st.identity.stale ? ' · <span class="eif-rp-warn">sign-in not rechecked (Merch is busy)</span>' : ""}`;
    else if (st.catalog && st.identity.state === "verified") line = `<span class="eif-rp-warn">${escapeHtml(merchReasonText("other_account"))}</span>`;
    else if (st.catalog) line = `<span class="eif-rp-warn">${escapeHtml(merchReasonText(st.identity.state === "logged_out" ? "signed_out" : st.identity.reason || st.identity.state))}</span> Catalog checks show "unknown" until you're back.`;
    else if (st.identity.state === "verified") line = `Signed in to Merch (account ${escapeHtml(st.identity.account)}). Sync to recognise your own listings automatically.`;
    else line = 'Not connected. Sign in at <a href="https://merch.amazon.com/dashboard" target="_blank" rel="noopener">merch.amazon.com</a>, then Sync.';
    const err = meta.lastError && meta.state !== "syncing" ? `<div class="eif-rp-muted">Last sync: ${escapeHtml(merchReasonText(meta.lastError))}</div>` : "";
    if (st.ok && st.catalog && st.catalog.sameAccount && meta.state !== "syncing" && !err && !st.identity.stale) {
      const when = ago === "today" || !ago ? "Synced today" : `Synced ${escapeHtml(ago)}`;
      return `<div id="eif-az-merch" class="eif-az-merch eif-az-merch-ok"><b>Merch catalog</b><span class="eif-rp-ok">✓ Connected</span><span class="eif-rp-muted">${when}</span><button type="button" class="eif-link-btn" data-action="az-merch-sync" title="Copycat Hunt keeps it up to date by itself. Use this after publishing new listings.">Sync now</button></div>`;
    }
    return `<div id="eif-az-merch" class="eif-az-merch"><div><b>Merch catalog</b> · ${line}</div>${err}
      <button class="eif-hunt-btn" type="button" data-action="az-merch-sync" ${meta.state === "syncing" ? "disabled" : ""}>${st.catalog ? "Sync again" : "Sync Merch catalog"}</button>
      <button class="eif-hunt-btn" type="button" data-action="az-merch-setup" title="Progress, pause and resume for big catalogs">Setup page</button>
      <div class="eif-rp-muted">A match means the listing is in your signed-in Merch account. It doesn't prove who made the artwork.</div></div>`;
  }

  const AZ = window.EifAmazonReport;
  let reportSite = SITE === "amazon" ? "amazon" : "ebay";
  let azSelection = null;
  let azDraft = { original: "", issue: "", brand: "", name: "", templates: {}, revision: 0 };
  let azReporter = { role: "", isSeller: null };
  let azPasteResult = null;
  let azJobs = [];
  let azStarting = false;
  let azStartStage = "";
  let azLoaded = false;

  let azLoading = false;
  const azLoadCallbacks = [];
  function loadAzState(done) {
    if (azLoaded) return done && done();
    if (done) azLoadCallbacks.push(done);
    if (azLoading) return;
    azLoading = true;
    const finish = (d = {}) => {
      if (d.eifAmazonDraft && typeof d.eifAmazonDraft === "object") azDraft = { ...azDraft, ...d.eifAmazonDraft, templates: { ...(d.eifAmazonDraft.templates || {}) } };
      if (d.eifAmazonReporter && typeof d.eifAmazonReporter === "object") azReporter = { ...azReporter, ...d.eifAmazonReporter }; if (azReporter.country && AZ.countryCode(azReporter.country)) azReporter.country = AZ.countryCode(azReporter.country);
      azLoaded = true;
      azLoading = false;
      azLoadCallbacks.splice(0).forEach((callback) => callback());
    };
    if (!hasStorage) return finish();
    chrome.storage.local.get({ eifAmazonDraft: null, eifAmazonReporter: null }, finish);
  }

  let azReportSource = null;
  function azPrepareSource() {
    const hunt = lastSearch && lastSearch.asin ? lastSearch : null;
    if (!hunt) {
      azReportSource = null;
      return;
    }
    if (!azReportSource || azReportSource.hunt !== hunt) {
      azReportSource = { hunt, asin: AZ.normalizeAsin(hunt.asin), applied: false, manual: false };
    }
    const source = azReportSource;
    if (!source.asin || source.manual || source.applied) return;
    if (azGroup !== null && azGroup !== hunt.hunt && azGroupsMap().has(hunt.hunt)) return;
    merchLookupAsins([source.asin]);
    if (!merchIsOwn(source.asin) && !amazonMine.has(source.asin)) return;
    source.applied = true;
    if (AZ.normalizeAsin(azDraft.original) !== source.asin) azDraft.brand = "";
    azDraft.original = source.asin;
    if (azSelection) azSelection.delete(source.asin);
    azBump();
    saveAzDraft();
    azEnrich([source.asin], false);
  }

  function azManualOriginal() {
    if (azReportSource && azReportSource.hunt === lastSearch) azReportSource.manual = true;
  }

  function amazonSourceTitle(asin) {
    return merchIsOwn(asin) ? "Your product · In your Merch catalog" : amazonMine.has(asin) ? "Your product" : "Searched product";
  }

  function saveAzDraft() {
    if (hasStorage) chrome.storage.local.set({ eifAmazonDraft: { original: azDraft.original, issue: azDraft.issue, brand: azDraft.brand, name: azDraft.name, templates: azDraft.templates, groups: azDraft.groups || {}, group: azDraft.group } });
  }
  function saveAzReporter() {
    if (hasStorage) chrome.storage.local.set({ eifAmazonReporter: azReporter });
  }

  function azTracked() {
    const locks = azReportLocks(reportHistory);
    return [...amazonTracked.entries()].filter(([asin, m]) => !m.reportedAt && !amazonMine.has(asin) && !merchIsOwn(asin) && !locks.has(asin)).map(([asin]) => asin);
  }
  function azTargets() {
    return azTracked().filter((a) => AZ.canReport((amazonTracked.get(a) || {}).marketplace || "US"));
  }

  let azGroup = null;

  function azGroupsMap() {
    const g = new Map();
    azTargets().forEach((a) => {
      const h = (amazonTracked.get(a) || {}).hunt || "";
      if (!g.has(h)) g.set(h, []);
      g.get(h).push(a);
    });
    return g;
  }

  function azCurrentGroup() {
    const g = azGroupsMap();
    if (azGroup !== null && g.has(azGroup)) return azGroup;
    const saved = azDraft && typeof azDraft.group === "string" && g.has(azDraft.group) ? azDraft.group : null;
    const fromHunt = lastSearch && lastSearch.hunt && g.has(lastSearch.hunt) ? lastSearch.hunt : null;
    const biggest = [...g.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    azSwitchGroup(fromHunt !== null ? fromHunt : saved !== null ? saved : biggest ? biggest[0] : "", true);
    return azGroup;
  }

  let azFocus = null;
  function azGroupTargets() {
    const all = azGroupsMap().get(azCurrentGroup()) || [];
    if (!azFocus) return all;
    const only = all.filter((a) => azFocus.has(a));
    return only.length ? only : all;
  }
  function azMarket() {
    const g = azGroupTargets();
    const pick = g.find((a) => azSelection && azSelection.has(a)) || g[0] || AZ.normalizeAsin(azDraft.original);
    return pick ? mpOfAsin(pick) : PAGE_MP;
  }
  function azGroupHidden() {
    if (!azFocus) return 0;
    return (azGroupsMap().get(azCurrentGroup()) || []).length - azGroupTargets().length;
  }

  function azSwitchGroup(key, initial) {
    azFocus = null;
    if (azGroup === key) return;
    azDraft.groups = azDraft.groups && typeof azDraft.groups === "object" ? azDraft.groups : {};
    if (azGroup !== null) azDraft.groups[azGroup] = { original: azDraft.original || "", brand: azDraft.brand || "" };
    azGroup = key;
    const saved = azDraft.groups[key];
    const huntAsin = key.startsWith("amz:") ? key.slice(4) : "";
    if (saved) {
      azDraft.original = saved.original;
      azDraft.brand = saved.brand;
    } else if (huntAsin && (amazonMine.has(huntAsin) || merchIsOwn(huntAsin))) {
      if (AZ.normalizeAsin(azDraft.original) !== huntAsin) azDraft.brand = "";
      azDraft.original = huntAsin;
    } else if (!initial) {
      azDraft.original = "";
      azDraft.brand = "";
    }
    azDraft.group = key;
    azSelection = new Set(azGroupsMap().get(key) || []);
    if (azDraft.original) azSelection.delete(AZ.normalizeAsin(azDraft.original));
    saveAzDraft();
  }

  function azGroupSwitchHtml() {
    const g = azGroupsMap();
    if (g.size <= 1 && !g.has("")) return "";
    if (g.size <= 1) return "";
    const cur = azCurrentGroup();
    const keys = [...g.keys()].sort((a, b) => (a === "") - (b === "") || g.get(b).length - g.get(a).length);
    return `<div class="eif-az-groups"><span class="eif-rp-muted">Copies found from:</span>${keys
      .map((k) => `<button type="button" class="${k === cur ? "eif-src-on" : ""}" data-action="az-group" data-group="${escapeHtml(k)}" title="${escapeHtml(k ? huntLabel(k) : "Marked before copycats were linked to a hunt")}">${k ? huntThumb(k) : ""}<span>${escapeHtml(k ? huntLabel(k) : "Not sorted yet")}</span> <span class="eif-src-n">${g.get(k).length}</span></button>`)
      .join("")}</div>`;
  }

  function azOwnership(asin) {
    return { catalog: asin && merchConnected() ? merchResult(asin) : null, selfDeclared: !!asin && azLoaded && amazonMine.has(asin), catalogConnected: merchConnected() };
  }

  function azListing(asin) {
    const d = amazonDetails.get(dkey(asin));
    return d ? d.listing || (d.state === "loading" ? { state: "loading" } : null) : null;
  }

  let azRenderTimer = 0;
  function azScheduleRender() {
    clearTimeout(azRenderTimer);
    azRenderTimer = setTimeout(() => {
      if (popup && popup.tab === "report" && reportSite === "amazon") renderAmazonReportView();
    }, 150);
  }

  const azRetried = new Map();
  function azEnrich(asins, refresh) {
    asins.forEach((asin) => {
      const d = amazonDetails.get(dkey(asin));
      const flaky = d && d.state === "error" && (d.offline || (d.listing && d.listing.reason === "timeout"));
      if (!refresh && flaky && !azRetried.has(asin) && Date.now() - (d.at || 0) > 20000) {
        azRetried.set(asin, Date.now());
        amazonDetails.delete(dkey(asin));
        loadAmazonDetails(asin, false).then(azScheduleRender);
        return;
      }
      if (!refresh && flaky && !azRetried.has(asin)) { setTimeout(azScheduleRender, 21000 - (Date.now() - (d.at || 0))); return; }
      if (!refresh && d) return;
      if (refresh) amazonDetails.delete(dkey(asin));
      loadAmazonDetails(asin, refresh).then(azScheduleRender);
    });
  }

  function azTemplate(issue) {
    return azDraft.templates[issue] != null ? azDraft.templates[issue] : AZ.DEFAULT_DESCRIPTIONS[issue] || "";
  }

  function azOriginalDate(asin) {
    const L = azListing(asin);
    return L && L.published && L.published.state === "known" ? L.published.isoDate : "";
  }

  function azFacts(count) {
    return {
      originalAsin: AZ.normalizeAsin(azDraft.original) || "",
      originalLink: AZ.productUrl(azMarket(), azDraft.original),
      published: azOriginalDate(azDraft.original),
      count,
      today: today(),
    };
  }

  function azBuildDraft() {
    const targets = azGroupTargets().filter((a) => azSelection && azSelection.has(a));
    return {
      marketplace: azMarket(),
      issue: azDraft.issue,
      brand: azDraft.brand || (azListing(azDraft.original) || {}).brand || "",
      description: azDraft.issue ? AZ.fillDescription(azTemplate(azDraft.issue), azFacts(targets.length)) : "",
      reporter: azReporter,
      original: { asin: azDraft.original, ownership: azOwnership(AZ.normalizeAsin(azDraft.original)), listing: azListing(AZ.normalizeAsin(azDraft.original)) },
      targets: targets.map((asin) => ({ asin, marketplace: mpOfAsin(asin), listing: azListing(asin), catalog: merchConnected() ? merchResult(asin) : null })),
    };
  }

  function azRefreshJobs() {
    return bgSend({ type: "eif-amazon-job-list" }).then((res) => {
      azJobs = res && res.ok ? res.jobs.filter((j) => ["prepared", "filling", "review_ready", "blocked", "failed"].includes(j.status)) : [];
      const el = popup && popup.overlay.querySelector("#eif-az-jobs");
      if (el) el.innerHTML = azJobsHtml();
    });
  }

  function azJobsHtml() {
    if (!azJobs.length) return "";
    const label = { prepared: "Opening Amazon's form…", filling: "Filling Amazon's form…", review_ready: "Filled. Waiting for you to review and submit on Amazon.", blocked: "Stopped. Open the Amazon tab to see why.", failed: "Stopped. Open the Amazon tab to see why." };
    return azJobs
      .map(
        (j) => `<div class="eif-hj-note eif-rp-active" data-job="${escapeHtml(j.id)}">${escapeHtml(j.name || `${j.targets.length} ASIN${j.targets.length > 1 ? "s" : ""}`)}: ${escapeHtml(label[j.status] || j.status)}${j.reason ? ` <span class="eif-rp-muted">${escapeHtml(j.reason)}</span>` : ""}
          ${j.status === "review_ready" ? '<button class="eif-hunt-btn eif-hunt-btn-green" type="button" data-action="az-job-submitted">I submitted it</button>' : ""}
          <button class="eif-hunt-btn" type="button" data-action="az-job-cancel">Cancel it</button></div>`
      )
      .join("");
  }

  function azIssuesHtml(issues) {
    const missing = issues.filter((i) => i.code === "required").map((i) => AZ.REPORTER_LABELS[i.field]);
    const early = issues.filter((i) => i.code === "target_before_original");
    let rest = issues.filter((i) => i.code !== "required" && i.code !== "target_before_original");
    const grouped = [];
    for (const [code, text] of [
      ["target_catalog_unknown", (n) => `${n} picked listings couldn't be checked against your Merch catalog.`],
      ["target_date_unknown", (n) => `${n} picked listings show no first-available date on Amazon, so they weren't compared with yours.`],
    ]) {
      const list = rest.filter((i) => i.code === code);
      if (list.length > 2) { rest = rest.filter((i) => i.code !== code); grouped.push({ severity: "review", message: text(list.length) }); }
    }
    rest = [...grouped, ...rest];
    if (missing.length) rest.unshift({ severity: "blocking", message: `Fill in your contact details: ${missing.join(", ")}.` });
    issues = rest;
    const blocking = issues.filter((i) => i.severity === "blocking");
    const review = issues.filter((i) => i.severity === "review");
    return `${blocking.length ? `<ul class="eif-az-issues eif-rp-over">${blocking.slice(0, 8).map((i) => `<li>${escapeHtml(i.message)}</li>`).join("")}${blocking.length > 8 ? `<li>…and ${blocking.length - 8} more</li>` : ""}</ul>` : ""}${
      review.length ? `<ul class="eif-az-issues eif-az-review">${review.slice(0, 5).map((i) => `<li>${i.html || escapeHtml(i.message)}</li>`).join("")}${review.length > 5 ? `<li>…and ${review.length - 5} more to check</li>` : ""}</ul>` : ""
    }`;
  }

  const azTouched = new Set();
  let azShowAll = false;
  const AZ_RADIO_FIELD = { role: "eif-az-role", isSeller: "eif-az-seller" };

  function azFootStatHtml(issues) {
    const blocking = issues.filter((i) => i.severity === "blocking");
    const review = issues.filter((i) => i.severity === "review");
    if (blocking.length) return `<span class="eif-rp-foot-bad">${blocking.length} thing${blocking.length === 1 ? "" : "s"} to fix before Amazon's form can be filled</span> <button type="button" class="eif-hj-link" data-action="az-show-issues">Show me</button>`;
    if (review.length) {
      const early = review.filter((i) => i.code === "target_before_original").length;
      const other = review.length - early;
      if (early && !other) return `<span class="eif-rp-foot-warn">Ready · ${early} picked listing${early === 1 ? " was" : "s were"} on Amazon before yours. Check ${early === 1 ? "it's a copy" : "they're copies"}.</span> <button type="button" class="eif-hj-link" data-action="az-show-before">Show ${early === 1 ? "it" : "them"}</button>`;
      const parts = [early ? `${early} listed before yours` : "", other ? `${other} other thing${other === 1 ? "" : "s"} to double-check` : ""].filter(Boolean).join(" · ");
      return `<span class="eif-rp-foot-warn">Ready · ${parts}</span> <button type="button" class="eif-hj-link" data-action="${early ? "az-show-before" : "az-show-issues"}">Show</button>`;
    }
    return '<span class="eif-rp-foot-ok">Ready. You tick Amazon\'s boxes and press Submit yourself.</span>';
  }

  function azMarkFields(issues) {
    if (!popup) return;
    const o = popup.overlay;
    const byField = new Map();
    issues.forEach((i) => i.field && !byField.has(i.field) && byField.set(i.field, i.message));
    o.querySelectorAll("[data-azr]").forEach((el) => {
      const key = el.dataset.azr;
      const msg = byField.get(key);
      const show = !!msg && (azShowAll || azTouched.has(key));
      el.classList.toggle("eif-rp-bad", show);
      const label = el.closest("label");
      let note = label && label.querySelector(".eif-rp-ferr");
      if (show && label && !note) {
        note = document.createElement("span");
        note.className = "eif-rp-ferr";
        label.appendChild(note);
      }
      if (note) {
        note.textContent = show ? msg : "";
        note.hidden = !show;
      }
    });
    Object.entries(AZ_RADIO_FIELD).forEach(([key, name]) => {
      const input = o.querySelector(`input[name="${name}"]`);
      const box = input && input.closest(".eif-rp-label");
      if (box) box.classList.toggle("eif-rp-bad-group", !!byField.get(key) && azShowAll);
    });
  }

  function azShowIssues() {
    azShowAll = true;
    const draft = azBuildDraft();
    const issues = AZ.validateDraft(draft);
    azMarkFields(issues);
    const o = popup && popup.overlay;
    const first = o && (o.querySelector(".eif-rp-bad, .eif-rp-bad-group") || o.querySelector("#eif-az-issues"));
    if (first) {
      first.scrollIntoView({ block: "center", behavior: "smooth" });
      if (first.focus && /INPUT|SELECT|TEXTAREA/.test(first.tagName)) first.focus({ preventScroll: true });
    }
  }

  function azSelectHtml(key, options) {
    const raw = String(azReporter[key] || "");
    const cur = key === "country" ? AZ.countryCode(raw) || raw : raw;
    const list = cur && !options.some(([v]) => v === cur) ? [[cur, `${cur} (not on Amazon's list)`], ...options] : options;
    return `<select class="eif-rp-orig-input eif-rp-select" data-azr="${key}"><option value="">Choose…</option>${list
      .map(([v, label]) => `<option value="${escapeHtml(v)}" ${v === cur ? "selected" : ""}>${escapeHtml(label)}</option>`)
      .join("")}</select>`;
  }

  function azReporterField(key, opts = {}) {
    const req = AZ.REPORTER_REQUIRED.includes(key);
    return `<label class="eif-rp-label eif-az-field ${opts.wide ? "eif-az-wide" : ""}"><span class="eif-az-lab">${escapeHtml(AZ.REPORTER_LABELS[key])}${req ? "" : ' <span class="eif-rp-muted">(optional)</span>'}</span>
      ${opts.options ? azSelectHtml(key, opts.options) : `<input class="eif-rp-orig-input" data-azr="${key}" type="${opts.type || "text"}" value="${escapeHtml(azReporter[key] || "")}" ${opts.list ? `list="${opts.list}"` : ""} autocomplete="off" />`}
    </label>`;
  }

  let azContactOpen = null;
  function azContactCollapsed() {
    const complete = !AZ.validateReporter(azReporter).length;
    if (azContactOpen === null) azContactOpen = !complete;
    return complete && !azContactOpen;
  }
  function azContactSummaryHtml() {
    const r = azReporter;
    const name = [r.firstName, r.lastName].filter(Boolean).join(" ");
    const parts = [name, r.contactEmail, r.city && r.country ? `${r.city}, ${r.country}` : r.country, r.role === "authorized_agent" ? "Authorized agent" : "Rights owner"].filter(Boolean);
    return `<div class="eif-az-contact-sum"><span class="eif-rp-ok">✓</span> <span>${escapeHtml(parts.join(" · "))}</span>
      <button type="button" class="eif-link-btn" data-action="az-contact-edit">Edit</button></div>`;
  }

  function azContactFieldsHtml() {
    return `<div class="eif-az-grid">
              ${azReporterField("firstName")}${azReporterField("lastName")}
              ${azReporterField("company", { wide: true })}
              ${azReporterField("addressLine1", { wide: true })}${azReporterField("addressLine2", { wide: true })}
              ${azReporterField("city")}${azReporterField("state")}
              ${azReporterField("postalCode")}${azReporterField("country", { options: AZ_COUNTRIES })}
              ${azReporterField("phone", { type: "tel" })}${azReporterField("contactName")}
              ${azReporterField("contactEmail", { type: "email", wide: true })}
            </div>
            <div class="eif-az-choices">
            <div class="eif-rp-label">Your role
              <label class="eif-az-radio"><input type="radio" name="eif-az-role" value="rights_owner" ${azReporter.role === "rights_owner" ? "checked" : ""}/> I'm the rights owner</label>
              <label class="eif-az-radio"><input type="radio" name="eif-az-role" value="authorized_agent" ${azReporter.role === "authorized_agent" ? "checked" : ""}/> I'm an agent authorized by the rights owner</label>
            </div>
            <div class="eif-rp-label">Do you sell on Amazon?
              <label class="eif-az-radio"><input type="radio" name="eif-az-seller" value="yes" ${azReporter.isSeller === true ? "checked" : ""}/> Yes</label>
              <label class="eif-az-radio"><input type="radio" name="eif-az-seller" value="no" ${azReporter.isSeller === false ? "checked" : ""}/> No</label>
            </div>
            </div>
            <span class="eif-rp-muted">The country list is Amazon's own, so what you pick is what Amazon's form gets.</span>`;
  }

  function azGateLeftText() {
    const n = AZ.validateReporter(azReporter).length;
    return n ? `${n} thing${n === 1 ? "" : "s"} left to fill in` : "All set";
  }
  function renderAmazonContactGate(view) {
    view.innerHTML = `<div class="eif-scroll eif-az-gate-wrap"><div class="eif-az-gate" role="form" aria-labelledby="eif-az-gate-h">
        <h3 class="eif-az-gate-h" id="eif-az-gate-h">Your contact details for Amazon</h3>
        <p class="eif-az-gate-p">Amazon's report form asks for these every time. Fill them in once: they're saved on this computer only and filled in for you on every report. You can change them later.</p>
        <div class="eif-az-contact-form">${azContactFieldsHtml()}</div>
        <div class="eif-az-gate-foot">
          <span id="eif-az-gate-left" class="eif-rp-muted">${escapeHtml(azGateLeftText())}</span>
          <button type="button" class="eif-hunt-btn eif-hunt-btn-primary" data-action="az-gate-done">Save and continue</button>
        </div>
      </div></div>`;
    reportSiteSwitch(view);
    azMarkFields(AZ.validateReporter(azReporter));
  }

  const AZ_COUNTRIES = (AZ && AZ.COUNTRIES) || [];

  let azPickedOnly = false;
  const azEarlySeen = new Set();
  let azBeforeOpen = false;
  let azPasteOpen = false;
  let azQuick = { after: [], title: [], before: [] };
  function renderAmazonReportView() {
    const view = viewEl();
    if (!view) return;
    if (!azLoaded) return loadAzState(() => {
      if (popup && popup.tab === "report" && reportSite === "amazon") renderAmazonReportView();
    });
    if (AZ.validateReporter(azReporter).length && azContactOpen !== true) return renderAmazonContactGate(view);
    azCurrentGroup();
    azPrepareSource();
    const scroll = view.querySelector(".eif-scroll");
    const scrollTop = scroll ? scroll.scrollTop : 0;
    const targets = azGroupTargets();
    if (!azSelection) azSelection = new Set(targets);
    [...azSelection].forEach((a) => !targets.includes(a) && azSelection.delete(a));
    const orig = AZ.normalizeAsin(azDraft.original);
    azEnrich([...targets, ...(orig ? [orig] : [])], false);
    if (!azDraft.issue) azDraft.issue = "copied_design";

    const oL = orig ? azListing(orig) : null;
    const dfa = oL && oL.published && oL.published.state === "known" ? oL.published.isoDate : "";
    const oDate = dfa;
    const draft = azBuildDraft();
    const issues = AZ.validateDraft(draft);
    const blocked = AZ.hasBlocking(issues);
    const selected = draft.targets.length;
    const activeJob = azJobs.some((j) => ["prepared", "filling"].includes(j.status));

    const beforeSet = new Set();
    const titleSet = new Set();
    const rowHtml = (asin) => {
        const m = amazonTracked.get(asin) || {};
        const L = azListing(asin);
        const p = L && L.published;
        const listed = p && p.state === "known" ? `Listed ${escapeHtml(AZ.formatIso(p.isoDate))}` : !L || L.state === "loading" ? "Reading date…" : L.state === "missing" ? "Page not found" : L.state === "blocked" ? "Check needed" : "Date unknown";
        const before = p && p.state === "known" && oDate && p.isoDate < oDate;
        if (before) beforeSet.add(asin);
        if ((m.copied || []).includes("title")) titleSet.add(asin);
        const img = m.image || (L && L.image) || "";
        return `
          <label class="eif-rp-item ${before ? "eif-rp-before" : ""}" title="${escapeHtml((L && L.title) || m.title || "")}">
            <input type="checkbox" class="eif-az-check" data-asin="${asin}" ${azSelection.has(asin) ? "checked" : ""} />
            ${img ? `<img src="${safeSrc(img)}" alt="" loading="lazy" />` : "<span></span>"}
            <span class="eif-rp-num">${asin}</span>
            <span class="eif-rp-listed">${listed}</span>
            <span class="eif-rp-status">${before ? '<span class="eif-rp-tag eif-rp-tag-warn">Before yours</span>' : ""}
            ${merchIsOwn(asin) ? '<span class="eif-rp-tag eif-rp-tag-warn">In your Merch catalog</span>' : ""}${copiedTag(m)}
            ${!azGroup ? huntMoveSelect("amazon", asin, [...azGroupsMap().keys()].filter(Boolean), true, "Move…") : ""}</span>
            <button type="button" class="eif-rp-x" data-action="az-remove" data-asin="${asin}" title="Remove from the list" aria-label="Remove ${asin}">&times;</button>
          </label>`;
      };
    const allRows = targets.map((a) => [a, rowHtml(a)]);
    const rows = allRows.filter(([a]) => !beforeSet.has(a)).map(([, h]) => h).join("");
    const beforeRows = allRows.filter(([a]) => beforeSet.has(a)).map(([, h]) => h).join("");
    let earlyChanged = false;
    beforeSet.forEach((a) => { if (!azEarlySeen.has(a)) { azEarlySeen.add(a); if (azSelection.delete(a)) earlyChanged = true; } });
    const beforeTicked = [...beforeSet].filter((a) => azSelection.has(a)).length;
    azQuick = { after: targets.filter((a) => !beforeSet.has(a)), title: targets.filter((a) => titleSet.has(a)), before: [...beforeSet] };

    merchLookupAsins([...targets, ...(orig ? [orig] : [])]);
    const own = AZ.ownershipOf(azOwnership(orig));
    const cat = orig && merchConnected() ? merchResult(orig) : null;
    const catLine = !merchConnected()
      ? ""
      : !cat
        ? '<span class="eif-rp-muted">Checking your Merch catalog…</span>'
        : cat.state === "catalog_matched"
          ? `<span class="eif-rp-ok">✓ In your Merch catalog</span>${cat.matchType !== "exact" ? ` <span class="eif-rp-muted">(through ${escapeHtml(cat.canonicalAsin)})</span>` : ""}`
          : cat.state === "not_found"
            ? '<span class="eif-rp-warn">Not in your Merch catalog.</span>'
            : `<span class="eif-rp-warn">Merch catalog check unknown: ${escapeHtml(merchReasonText(cat.reason))}</span>`;
    const selfLine = own.selfDeclared
      ? '<span class="eif-rp-ok">✓ Marked as yours</span> <span class="eif-rp-muted">(your own statement, with "This is mine")</span>'
      : own.basis === "catalog_matched"
        ? ""
        : '<span class="eif-rp-warn">Not marked as yours.</span> <button class="eif-hunt-btn" type="button" data-action="az-mark-mine">This is mine</button>';
    const origInfo = !orig
      ? '<div class="eif-rp-orig-line eif-rp-muted">Enter the ASIN of your own product on Amazon.</div>'
      : `<div class="eif-rp-orig-line">${oL && oL.title ? `<b>${escapeHtml(oL.title)}</b>` : `ASIN ${orig}`}</div>
         ${catLine ? `<div class="eif-rp-orig-line">${catLine}</div>` : ""}
         ${selfLine ? `<div class="eif-rp-orig-line">${selfLine}</div>` : ""}
         <div class="eif-rp-orig-line">${
           !oL || oL.state === "loading" ? '<span class="eif-rp-muted">Reading the product page…</span>'
           : oL.state === "blocked" ? `<span class="eif-rp-warn">Amazon asked for a sign-in or robot check. Open ${escapeHtml(AZ.marketplaceLabel(azMarket()))}, then press Refresh info.</span>`
           : oL.state === "missing" ? '<span class="eif-rp-warn">Product page not found.</span>'
           : dfa ? `First available ${escapeHtml(AZ.formatIso(dfa))} <span class="eif-rp-muted">(read from Amazon)</span>`
           : '<span class="eif-rp-warn">Amazon doesn’t show a Date First Available for it.</span>'
         }</div>`;
    const mineList = `<datalist id="eif-az-mine">${[...amazonMine].map((a) => `<option value="${a}"></option>`).join("")}</datalist>`;
    const tpl = azTemplate(azDraft.issue);
    const preview = AZ.fillDescription(tpl, azFacts(selected));

    view.innerHTML = `
      ${mineList}
      <div id="eif-az-jobs">${azJobsHtml()}</div>
      <div class="eif-scroll">
        <div class="eif-rp">
          <section class="eif-rp-col">
            <div class="eif-rp-h">Listings to report <span>${selected} selected</span></div>
            ${azGroupSwitchHtml()}
            <div class="eif-rp-group eif-rp-listbox${azPickedOnly ? " eif-rp-picked-only" : ""}">
              <div class="eif-rp-group-head"><span class="eif-rp-gt">${azGroup ? `${huntThumb(azGroup)}Copies found from ${escapeHtml(huntLabel(azGroup))}` : azGroupsMap().size > 1 ? "Not sorted yet <span class=\"eif-rp-muted\">(pick which design each is a copy of)</span>" : `Copies on ${escapeHtml(AZ.marketplaceLabel(azMarket()))}`}</span> <span class="eif-rp-limit">${targets.length} / ${AZ.TARGET_LIMIT}</span></div>
              ${targets.length ? `<div class="eif-rp-pickbar" role="toolbar" aria-label="Pick listings">
                <div class="eif-seg">
                  <button type="button" data-action="az-all">All</button>
                  <button type="button" data-action="az-none">None</button>
                  ${azQuick.before.length && azQuick.after.length ? `<button type="button" data-action="az-pick" data-pick="after" title="Only the ones listed after yours">After yours <i>${azQuick.after.length}</i></button>` : ""}
                  ${azQuick.title.length && azQuick.title.length < targets.length ? `<button type="button" data-action="az-pick" data-pick="title" title="Only the ones that copied your title">Title copied <i>${azQuick.title.length}</i></button>` : ""}
                </div>
                <span class="eif-rp-pickcount"><b>${selected}</b> of ${targets.length} picked</span>
                <button type="button" class="eif-rp-toggle" data-action="az-picked-only" aria-pressed="${azPickedOnly}">Picked only</button>
              </div>` : ""}
              ${azGroupHidden() ? `<div class="eif-az-focus">Showing the ${targets.length} you picked. <button type="button" class="eif-hj-link" data-action="az-show-all">Show all ${targets.length + azGroupHidden()} in this design</button></div>` : ""}
              ${rows ? `<div class="eif-rp-items">${rows}</div>` : beforeRows ? "" : '<div class="eif-rp-hint eif-az-empty">No Amazon listings yet. Press "Copycat" on Amazon look-alikes, or paste ASINs below.</div>'}
              ${beforeRows ? `<details class="eif-rp-before-group" ${azBeforeOpen ? "open" : ""}>
                <summary><span class="eif-rp-before-dot"></span><b>Listed before yours</b> <span class="eif-rp-muted">${beforeSet.size} · ${beforeTicked} picked · check these are really copies</span>
                  ${beforeTicked ? `<button type="button" class="eif-hj-link" data-action="az-pick" data-pick="unbefore">Unpick these</button>` : ""}</summary>
                <div class="eif-rp-items">${beforeRows}</div>
              </details>` : ""}
              <div class="eif-rp-more">
                <button type="button" class="eif-link-btn" data-action="az-paste-open" aria-expanded="${azPasteOpen}">Add ASINs</button>
                <button type="button" class="eif-link-btn" data-action="az-refresh">Refresh info</button>
                <button type="button" class="eif-link-btn" data-action="az-export" ${selected ? "" : "disabled"}>Export CSV</button>
                <button type="button" class="eif-link-btn eif-link-danger" data-action="az-remove-selected" ${selected ? "" : "disabled"}>Remove picked</button>
                ${azGroup && selected ? huntMoveSelect("amazon", "@ticked", [...azGroupsMap().keys()].filter((k) => k && k !== azGroup), true, "Wrong design? Move picked to…") : ""}
              </div>
              ${azPasteOpen || azPasteResult ? `<div class="eif-az-paste">
                <textarea id="eif-az-paste" rows="2" placeholder="Paste ASINs or ${escapeHtml(AZ.marketplaceLabel(azMarket()))} product links (up to ${AZ.TARGET_LIMIT})"></textarea>
                <button class="eif-hunt-btn" type="button" data-action="az-paste">Add</button>
              </div>` : ""}
              ${azPasteResult ? `<div class="eif-rp-hint eif-rp-pad">${escapeHtml(azPasteResult)}</div>` : ""}
            </div>
            <div class="eif-rp-h">Your original</div>
            <div class="eif-rp-group"><div class="eif-rp-orig">
              <label class="eif-rp-orig-field">ASIN of your product
                <input class="eif-rp-orig-input" id="eif-az-original" list="eif-az-mine" maxlength="10" value="${escapeHtml(azDraft.original || "")}" placeholder="B0…" />
              </label>
              ${origInfo}
              <label class="eif-rp-orig-field">Brand (as shown on your product)
                <input class="eif-rp-orig-input" id="eif-az-brand" maxlength="120" value="${escapeHtml(azDraft.brand || (oL && oL.brand) || "")}" placeholder="Brand name" />
              </label>
              <div class="eif-rp-muted">Copycat Hunt checks that this product is in your Merch catalog or marked as yours, and compares listing dates. That shows which listing came first, not who made the artwork.</div>
              ${merchBoxHtml()}
            </div></div>
          </section>
          <section class="eif-rp-col">
            <div class="eif-rp-h">Report details</div>
            <label class="eif-rp-label">Report name
              <input id="eif-az-name" class="eif-rp-name" maxlength="80" value="${escapeHtml(azDraft.name || "")}" placeholder="${escapeHtml(`Amazon copies of ${orig || "my design"}, ${AZ.formatIso(today())}`)}" />
            </label>
            <label class="eif-rp-label">What happened?
              <select class="eif-rp-select" id="eif-az-issue">${Object.entries(AZ.ISSUES).map(([k, v]) => `<option value="${k}" ${k === azDraft.issue ? "selected" : ""}>${escapeHtml(v.label)}</option>`).join("")}</select>
              <span class="eif-rp-muted">${escapeHtml((AZ.ISSUES[azDraft.issue] || {}).hint || "")} On Amazon's form this is Copyright → ${azDraft.issue === "copied_listing" ? "listing text" : "product or packaging"}.</span>
            </label>
            <label class="eif-rp-label">Description Amazon will read
              <textarea id="eif-az-desc" rows="6" maxlength="${AZ.DESCRIPTION_MAX}">${escapeHtml(tpl)}</textarea>
            </label>
            <div class="eif-rp-chips">Insert: ${AZ.PLACEHOLDERS.map((p) => `<button type="button" class="eif-hj-chip" data-action="az-insert" data-ph="{${p}}">{${p}}</button>`).join("")}
              <button type="button" class="eif-hunt-btn" data-action="az-desc-reset">Reset</button></div>
            <div class="eif-rp-count" id="eif-az-count">${preview.length} / ${AZ.DESCRIPTION_MAX}</div>
            <div class="eif-rp-preview"><div class="eif-rp-preview-h">Preview</div><span id="eif-az-preview">${escapeHtml(preview)}</span></div>

            <div class="eif-rp-h">Your contact details <span class="eif-rp-muted">sent to Amazon · saved on this computer only</span></div>
            ${azContactCollapsed() ? azContactSummaryHtml() : `<div class="eif-az-contact-form">
            ${azContactFieldsHtml()}
            ${AZ.validateReporter(azReporter).length ? "" : '<div><button type="button" class="eif-hunt-btn" data-action="az-contact-done">Done</button></div>'}
            </div>`}

            <div class="eif-rp-h">Send to Amazon</div>
            <p class="eif-rp-send">Amazon's form opens in a new tab and gets filled in. You check it, tick Amazon's declaration boxes and press <b>Submit</b> yourself.</p>
            <div id="eif-az-issues">${azIssuesHtml(issues)}</div>
          </section>
        </div>
      </div>
      <div class="eif-rp-footer">
        <div class="eif-rp-foot-main">
          <div class="eif-rp-summary"><b>${selected} listing${selected === 1 ? "" : "s"}</b> → 1 report on ${escapeHtml(AZ.marketplaceLabel(azMarket()))}</div>
          <div id="eif-az-footstat">${azFootStatHtml(issues)}</div>
        </div>
        <button class="eif-hunt-btn eif-hunt-btn-primary eif-rp-start" type="button" data-action="az-start" ${blocked || azStarting || activeJob ? "disabled" : ""}>${azStarting ? escapeHtml(azStartStage || "Checking…") : "Start Amazon report"}</button>
      </div>`;
    const newScroll = view.querySelector(".eif-scroll");
    if (newScroll) newScroll.scrollTop = scrollTop;
    azMarkFields(issues);
    reportSiteSwitch(view);
    if (earlyChanged) { azBump(); setTimeout(() => { if (popup && popup.tab === "report" && reportSite === "amazon") renderAmazonReportView(); }, 0); }
    if (Date.now() - azJobsCheckedAt > 3000) {
      azJobsCheckedAt = Date.now();
      azRefreshJobs();
    }
  }
  let azJobsCheckedAt = 0;

  function azUpdateLive() {
    if (!popup) return;
    const o = popup.overlay;
    const gateLeft = o.querySelector("#eif-az-gate-left");
    if (gateLeft) {
      gateLeft.textContent = azGateLeftText();
      azMarkFields(AZ.validateReporter(azReporter));
      return;
    }
    const draft = azBuildDraft();
    const issues = AZ.validateDraft(draft);
    const box = o.querySelector("#eif-az-issues");
    if (box) box.innerHTML = azIssuesHtml(issues);
    const fs = o.querySelector("#eif-az-footstat");
    if (fs) fs.innerHTML = azFootStatHtml(issues);
    azMarkFields(issues);
    const btn = o.querySelector('[data-action="az-start"]');
    if (btn) btn.disabled = AZ.hasBlocking(issues) || azStarting || azJobs.some((j) => ["prepared", "filling"].includes(j.status));
    const preview = AZ.fillDescription(azTemplate(azDraft.issue), azFacts(draft.targets.length));
    const pv = o.querySelector("#eif-az-preview");
    if (pv) pv.textContent = preview;
    const ct = o.querySelector("#eif-az-count");
    if (ct) {
      ct.textContent = `${preview.length} / ${AZ.DESCRIPTION_MAX}`;
      ct.classList.toggle("eif-rp-over", preview.length > AZ.DESCRIPTION_MAX);
    }
  }

  function azBump() {
    azDraft.revision++;
  }

  function azDownloadCsv() {
    const rows = azGroupTargets()
      .filter((a) => azSelection && azSelection.has(a))
      .map((asin) => {
        const L = azListing(asin) || {};
        return { marketplace: mpOfAsin(asin), asin, title: L.title || (amazonTracked.get(asin) || {}).title || "", published: L.published && L.published.state === "known" ? L.published.isoDate : "", state: L.state || "" };
      });
    const blob = new Blob([AZ.toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `amazon-copies-${today()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function azStart() {
    if (azStarting) return;
    azStarting = true;
    const stage = (text) => {
      azStartStage = text;
      const b = popup && popup.overlay.querySelector('[data-action="az-start"]');
      if (b) b.textContent = text;
    };
    stage("Reading your original…");
    renderAmazonReportView();
    try {
      const orig = AZ.normalizeAsin(azDraft.original);
      if (orig) await loadAmazonDetails(orig, true);
      const draft = azBuildDraft();
      const issues = AZ.validateDraft(draft);
      if (AZ.hasBlocking(issues)) {
        showToast("Fix the items in red first");
        return;
      }
      const oL = azListing(orig);
      const name = String(azDraft.name || "").trim() || `Amazon copies of ${orig}, ${AZ.formatIso(today())}`;
      stage("Checking your Merch catalog and opening Amazon's form…");
      const requestId = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
      const jobMsg = {
        type: "eif-amazon-job-open",
        job: {
          requestId,
          marketplace: draft.marketplace,
          name,
          original: orig,
          originalDate: azOriginalDate(orig),
          targets: draft.targets.map((t) => t.asin),
          targetImages: Object.fromEntries(draft.targets.map((t) => [t.asin, (amazonTracked.get(t.asin) || {}).image || (t.listing && t.listing.image) || ""])),
          issue: draft.issue,
          ownershipBasis: AZ.ownershipOf(draft.original.ownership).basis,
          brand: draft.brand,
          description: draft.description,
          reporter: { ...azReporter },
        },
      };
      let res = await bgSend(jobMsg);
      if (!res) {
        stage("Still opening Amazon's form…");
        await new Promise((r) => setTimeout(r, 1500));
        res = await bgSend(jobMsg);
      }
      if (!res || !res.ok) {
        const why = {
          "invalid-job": "The report details didn't pass the final check.",
          "target-recently-reported": `Reported in the last 5 days, still waiting on Amazon: ${((res && res.asins) || []).join(", ")}. Untick them.`,
          "target-in-catalog": `These are in your own Merch catalog and can't be reported: ${((res && res.asins) || []).join(", ")}`,
          "ownership-changed": "Your original's ownership check changed. Look at section 2 again.",
          "catalog-unavailable": `Couldn't confirm your Merch catalog right now. ${merchReasonText((res && res.reason) || "network")} You can try again, or mark the original "This is mine".`,
        }[res && res.error];
        showToast(
          why ||
            (!res
              ? "The extension's background didn't answer twice. Reload the extension (chrome://extensions), then try again."
              : `Couldn't open Amazon's form (${res.error || "unknown"}${res.detail ? `: ${res.detail}` : ""}). Try again.`)
        );
        if (res && res.error === "target-in-catalog") (res.asins || []).forEach((a) => merchResults.set(`${mpOfAsin(a)}|${a}`, { state: "catalog_matched", matchType: "exact", canonicalAsin: a }));
        return;
      }
      showToast(res.reused ? "Amazon's report form is already open in another tab" : "Amazon's report form opened in a new tab");
      await azRefreshJobs();
    } finally {
      azStarting = false;
      azStartStage = "";
      if (popup && popup.tab === "report" && reportSite === "amazon") renderAmazonReportView();
    }
  }

  function handleAzClick(action, target) {
    const asin = target.dataset.asin;
    if (action === "az-show-issues") return azShowIssues();
    if (action === "az-show-all") {
      azFocus = null;
      azBump();
      renderAmazonReportView();
      return;
    }
    if (action === "az-group") {
      azSwitchGroup(target.dataset.group || "", false);
      azBump();
      renderAmazonReportView();
      return;
    }
    if (action === "az-all" || action === "az-none") {
      azSelection = new Set(action === "az-all" ? azGroupTargets() : []);
      azBump();
      renderAmazonReportView();
    } else if (action === "az-pick") {
      const k = target.dataset.pick;
      if (k === "unbefore") azQuick.before.forEach((a) => azSelection && azSelection.delete(a));
      else azSelection = new Set(k === "after" ? azQuick.after : k === "title" ? azQuick.title : []);
      azBump();
      renderAmazonReportView();
    } else if (action === "az-picked-only") {
      azPickedOnly = !azPickedOnly;
      const box = popup.overlay.querySelector(".eif-rp-listbox");
      if (box) box.classList.toggle("eif-rp-picked-only", azPickedOnly);
      target.setAttribute("aria-pressed", String(azPickedOnly));
    } else if (action === "az-paste-open") {
      azPasteOpen = !azPasteOpen;
      renderAmazonReportView();
      if (azPasteOpen) { const t = popup.overlay.querySelector("#eif-az-paste"); if (t) t.focus(); }
    } else if (action === "az-show-before") {
      azBeforeOpen = true;
      renderAmazonReportView();
      const g = popup.overlay.querySelector(".eif-rp-before-group");
      if (g) g.scrollIntoView({ block: "start", behavior: "smooth" });
    } else if (action === "az-remove" || action === "az-remove-selected") {
      const list = action === "az-remove" ? [asin] : [...(azSelection || [])];
      if (!list.length) return;
      if (list.length > 1 && !window.confirm(`Remove ${list.length} listings from the Amazon list?`)) return;
      list.forEach((a) => {
        amazonTracked.delete(a);
        azSelection && azSelection.delete(a);
      });
      saveAmazon();
      azBump();
      updateTabCounts();
      renderAmazonReportView();
    } else if (action === "az-refresh") {
      azEnrich([...azTargets(), ...(AZ.normalizeAsin(azDraft.original) ? [AZ.normalizeAsin(azDraft.original)] : [])], true);
      renderAmazonReportView();
    } else if (action === "az-export") azDownloadCsv();
    else if (action === "az-paste") {
      const box = popup.overlay.querySelector("#eif-az-paste");
      const ownCatalog = [...merchResults.entries()].filter(([, v]) => v.state === "catalog_matched").map(([k]) => k.split("|")[1]);
      const res = AZ.parseTargetInput(box ? box.value : "", { existing: azTargets(), owned: [...amazonMine, ...ownCatalog], original: azDraft.original, locked: [...azReportLocks(reportHistory).keys()] });
      res.added.forEach((a) => {
        amazonTracked.set(a, { title: "", brand: "", price: "", image: "", url: AZ.productUrl(azMarket(), a), addedAt: today(), reportedAt: "", marketplace: azMarket(), hunt: azGroup || "" });
        if (azFocus) azFocus.add(a);
        azSelection && azSelection.add(a);
      });
      if (res.added.length) saveAmazon();
      const skipped = AZ.summarizeRejections(res.rejected).map((g) => `${g.items.length} ${g.label}${g.items.length <= 3 ? ` (${g.items.join(", ")})` : ""}`);
      azPasteResult = `Added ${res.added.length}.${skipped.length ? ` Skipped: ${skipped.join("; ")}.` : ""}`;
      azBump();
      updateTabCounts();
      renderAmazonReportView();
    } else if (action === "az-mark-mine") {
      const a = AZ.normalizeAsin(azDraft.original);
      if (!a) return;
      askMine("amazon", a).then((r) => {
        if (!r) return;
        if (r === "marked" && !amazonMine.has(a)) toggleAmazonMine(a);
        azBump();
        renderAmazonReportView();
      });
    } else if (action === "az-insert") {
      const ta = popup.overlay.querySelector("#eif-az-desc");
      const ph = target.dataset.ph;
      const start = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, start) + ph + ta.value.slice(ta.selectionEnd ?? start);
      azDraft.templates[azDraft.issue] = ta.value;
      saveAzDraft();
      azBump();
      azUpdateLive();
    } else if (action === "az-desc-reset") {
      delete azDraft.templates[azDraft.issue];
      saveAzDraft();
      azBump();
      renderAmazonReportView();
    } else if (action === "az-merch-sync") merchSyncNow();
    else if (action === "az-merch-setup") bgSend({ type: "eif-merch-open-setup" });
    else if (action === "az-contact-edit") { azContactOpen = true; renderAmazonReportView(); }
    else if (action === "az-contact-done") { azContactOpen = false; renderAmazonReportView(); }
    else if (action === "az-gate-done") {
      if (AZ.validateReporter(azReporter).length) {
        azShowAll = true;
        azUpdateLive();
        const bad = popup.overlay.querySelector(".eif-az-gate .eif-rp-bad, .eif-az-gate .eif-rp-bad-group");
        if (bad) bad.scrollIntoView({ block: "center", behavior: "smooth" });
        showToast("A few details are still missing (marked in red)");
      } else {
        saveAzReporter();
        azShowAll = false;
        azContactOpen = false;
        renderAmazonReportView();
        showToast("Saved on this computer. Now pick what to report.");
      }
    }
    else if (action === "az-start") azStart();
    else if (action === "az-job-cancel" || action === "az-job-submitted") {
      const id = target.closest("[data-job]").dataset.job;
      if (action === "az-job-cancel" && !window.confirm("Cancel this Amazon report? Nothing else will be filled in its tab.")) return;
      if (action === "az-job-submitted") return azMarkSubmitted(id);
      bgSend({ type: "eif-amazon-job-finish", jobId: id, how: "cancel" }).then(() => azRefreshJobs().then(renderAmazonReportView));
    }
  }

  let pendingReported = false;
  function afterReportSaved(added) {
    if (added.some((r) => r.site === "amazon")) {
      azSelection = null;
      azFocus = null;
      azDraft.name = "";
      azTouched.clear();
      azShowAll = false;
      azBump();
      saveAzDraft();
    }
    if (added.some((r) => r.site !== "amazon")) reportSelection = null;
    added.forEach((r) => histOpen.add(histDesignKey(r)));
    updateTabCounts();
    if (popup) {
      pendingReported = false;
      switchTab("reported");
    } else pendingReported = true;
  }

  async function azMarkSubmitted(jobId) {
    const res = await bgSend({ type: "eif-amazon-job-finish", jobId, how: "submitted" });
    if (!res || !res.ok) return showToast("Couldn't record it. The report may have expired.");
    const j = res.job;
    const d = today();
    reportHistory.push({
      id: `rep-az-${Date.now()}`,
      site: "amazon",
      marketplace: j.marketplace,
      name: j.name || "",
      sentAt: new Date().toISOString(),
      source: "",
      platform: "Amazon",
      originalLink: AZ.productUrl(j.marketplace, j.original),
      design: `amz:${j.original}`,
      detail: (AZ.ISSUES[j.issue] || {}).label || "",
      items: j.targets.map((n) => ({ n, image: (j.targetImages || {})[n] || "", status: "", checkedAt: "" })),
    });
    j.targets.forEach((a) => {
      const m = amazonTracked.get(a);
      if (m) m.reportedAt = d;
    });
    saveHistory();
    saveAmazon();
    showToast("Saved to the Reported tab");
    await azRefreshJobs();
    afterReportSaved([reportHistory[reportHistory.length - 1]]);
  }

  function handleAzInput(e) {
    const t = e.target;
    if (t.dataset.azr) {
      azReporter[t.dataset.azr] = t.value;
    } else if (t.id === "eif-az-desc") {
      azDraft.templates[azDraft.issue] = t.value;
    } else if (t.id === "eif-az-name") {
      azDraft.name = t.value;
      return;
    } else if (t.id === "eif-az-brand") {
      azDraft.brand = t.value;
    } else if (t.id === "eif-az-original") {
      azManualOriginal();
      if (AZ.normalizeAsin(azDraft.original) !== AZ.normalizeAsin(t.value)) azDraft.brand = "";
      azDraft.original = t.value.trim().toUpperCase();
    } else return;
    azBump();
    azUpdateLive();
  }

  function handleAzChange(e) {
    const t = e.target;
    if (t.classList.contains("eif-az-check")) {
      if (t.checked) azSelection.add(t.dataset.asin);
      else azSelection.delete(t.dataset.asin);
      azBump();
      renderAmazonReportView();
    } else if (t.name === "eif-az-role") {
      azReporter.role = t.value;
      saveAzReporter();
      azBump();
      azUpdateLive();
    } else if (t.name === "eif-az-seller") {
      azReporter.isSeller = t.value === "yes";
      saveAzReporter();
      azBump();
      azUpdateLive();
    } else if (t.dataset.azr) {
      azReporter[t.dataset.azr] = t.value.trim();
      saveAzReporter();
      azTouched.add(t.dataset.azr);
      if (t.tagName === "SELECT") {
        azBump();
        azUpdateLive();
      } else if (popup.overlay.querySelector("#eif-az-gate-left")) azUpdateLive();
      else azMarkFields(AZ.validateDraft(azBuildDraft()));
    } else if (t.id === "eif-az-issue") {
      azDraft.issue = t.value;
      saveAzDraft();
      if (azSelection) azSetReason([...azSelection].filter((a) => amazonTracked.has(a)), t.value);
      azBump();
      renderAmazonReportView();
    } else if (t.id === "eif-az-original") {
      azManualOriginal();
      if (AZ.normalizeAsin(azDraft.original) !== AZ.normalizeAsin(t.value)) azDraft.brand = "";
      azDraft.original = AZ.normalizeAsin(t.value) || t.value.trim().toUpperCase();
      saveAzDraft();
      azBump();
      renderAmazonReportView();
    } else if (t.id === "eif-az-brand" || t.id === "eif-az-desc" || t.id === "eif-az-name") {
      saveAzDraft();
    }
  }

  function reportSiteSwitch(view) {
    const ebayBtn = `<button type="button" role="tab" data-action="rp-site" data-site="ebay" class="${reportSite === "ebay" ? "eif-src-on" : ""}"><i class="eif-site-dot" aria-hidden="true"></i>eBay <span class="eif-src-n">${activeTracked().length}</span></button>`;
    const amzBtn = `<button type="button" role="tab" data-action="rp-site" data-site="amazon" class="${reportSite === "amazon" ? "eif-src-on" : ""}"><i class="eif-site-dot" aria-hidden="true"></i>Amazon <span class="eif-src-n">${azTargets().length}</span></button>`;
    view.insertAdjacentHTML("afterbegin", `<div id="eif-src-switch" class="eif-rp-switch" role="tablist" aria-label="Report on">${SITE === "amazon" ? amzBtn + ebayBtn : ebayBtn + amzBtn}</div>`);
  }

  async function checkAmazonStatus(asin) {
    const L = await bgSend({ type: "eif-amazon-listing", asin, marketplace: mpOfAsin(asin), refresh: true });
    if (!L) throw new TypeError("Failed to fetch");
    if (L.state === "missing") return { status: "removed", note: "The product page no longer exists." };
    if (L.state === "ready") return { status: "live", note: "" };
    if (L.state === "blocked") return { status: "", note: "Amazon asked for a robot check. Open amazon.com and try again." };
    if (L.reason === "network" || L.reason === "timeout") throw new TypeError("Failed to fetch");
    return { status: "", note: "Couldn't read the product page." };
  }

  function selectHtml(field, options, value) {
    return `<select class="eif-rp-select" data-field="${field}">${options
      .map((o) => `<option ${o === value ? "selected" : ""}>${escapeHtml(o)}</option>`)
      .join("")}</select>`;
  }

  function currentDraft() {
    if (!reportDraft) {
      const t = activeTemplate();
      reportDraft = { contentType: t.contentType, reason: t.reason, detail: t.detail, text: t.text };
    }
    return reportDraft;
  }

  const amazonDateFetches = new Set();
  const asinFromLink = (link) => ((String(link || "").match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/i) || [])[1] || "").toUpperCase();
  function fillAmazonOriginalDate(key, resolved) {
    const o = resolved || originals[key] || {};
    if (o.platform !== "Amazon" || !o.link) return;
    const asin = asinFromLink(o.link);
    if (!asin) return;
    const cur0 = originals[key] || {};
    if (cur0.published && cur0.dateAsin === asin) return;
    if (cur0.dateLookup === `none:${asin}` || cur0.dateLookup === `fail:${asin}`) return;
    const job = `${key}|${asin}`;
    if (amazonDateFetches.has(job)) return;
    amazonDateFetches.add(job);
    loadAmazonDetails(asin, !!cur0.dateForce, "high").then((d) => {
      amazonDateFetches.delete(job);
      const cur = { ...(originals[key] || {}) };
      delete cur.dateForce;
      if (asinFromLink(cur.link || o.link) !== asin) return;
      if (cur.published && cur.dateAsin === asin) return;
      const L = d && d.listing;
      if (d && d.firstAvailable) {
        originals[key] = { ...cur, published: d.firstAvailable, dateFromAmazon: true, dateAsin: asin, dateLookup: "" };
      } else if (d && d.state === "done" && L && (L.state === "ready" || L.state === "missing")) {
        originals[key] = cur.published && !cur.dateFromAmazon ? { ...cur, dateAsin: asin, dateLookup: `none:${asin}` } : { ...cur, published: "", dateFromAmazon: false, dateLookup: `none:${asin}` };
      } else {
        originals[key] = { ...cur, dateLookup: `fail:${asin}` };
      }
      saveOriginals();
      if (popup && popup.tab === "report" && reportSite !== "amazon") renderReportView();
    });
  }

  function amazonDateNote(key, o) {
    if (o.platform !== "Amazon" || !o.link || !asinFromLink(o.link)) return "";
    const asin = asinFromLink(o.link);
    const look = String((originals[key] || {}).dateLookup || "");
    const btn = (label) => ` <button type="button" class="eif-link-btn" data-action="rp-orig-date-read" data-key="${escapeHtml(key)}">${label}</button>`;
    if (o.published && o.dateFromAmazon) return '<span class="eif-rp-muted">read from Amazon (Date First Available)</span>';
    if (o.published) return `<span class="eif-rp-muted">entered by you.${btn("Read from Amazon")}</span>`;
    if (look === `none:${asin}`) return "<span class=\"eif-rp-muted\">Amazon doesn't show it. Enter it once.</span>";
    if (look === `fail:${asin}`) return `<span class="eif-rp-warn">Couldn't read the date from Amazon.${btn("Try again")}</span>`;
    return '<span class="eif-rp-muted">Reading the date from Amazon…</span>';
  }

  function originalBlockHtml(group) {
    const key = groupKey(group);
    const o = originalFor(group);
    if (o.platform === "Amazon" && o.link) fillAmazonOriginalDate(key, o);
    if (o.platform === "eBay" && group.source) fetchEbayOriginal(group.source);
    const platformSelect = `<select class="eif-rp-select eif-rp-orig-platform" data-key="${key}">
        <option value="" ${o.platform ? "" : "selected"} disabled>Choose…</option>
        ${PLATFORMS.map((p) => `<option ${p === o.platform ? "selected" : ""}>${escapeHtml(p)}</option>`).join("")}
      </select>`;
    const bad = originalProblems(group);
    const err = (k) => (bad[k] && (k !== "link" || o.link) && (k !== "date" || o.published) ? `<div class="eif-rp-err">${escapeHtml(bad[k])}</div>` : "");
    let body = "";
    if (o.platform === "eBay" && group.source) {
      const verified = o.verified === true;
      const checked = typeof o.verified === "boolean";
      body = `
        <div class="eif-rp-orig-line">${o.title ? `<b>${escapeHtml(o.title)}</b>` : `Listing #${group.source}`}</div>
        <div class="eif-rp-orig-line">${
          !checked
            ? '<span class="eif-rp-muted">Checking your listing…</span>'
            : verified
              ? '<span class="eif-rp-ok">✓ eBay shows this listing as yours</span>'
              : '<span class="eif-rp-warn">eBay doesn\u2019t show this listing as yours. Are you signed in with the account that sells it?</span>'
        }</div>
        <label class="eif-rp-orig-field">Listed on
          <input type="date" class="eif-rp-orig-input" data-key="${key}" data-f="published" value="${escapeHtml(o.published)}" max="${today()}" />
          <span class="eif-rp-muted">${o.dateFromEbay ? "read from eBay" : o.published ? "" : checked ? "eBay doesn't show it. Enter it once." : ""}</span>
        </label>${err("date")}`;
    } else if (o.platform === "eBay") {
      body = `
        <div class="eif-rp-orig-row">
          <input class="eif-rp-src-input" inputmode="numeric" maxlength="15" placeholder="Your eBay item number" list="eif-rp-mine" />
          <button class="eif-hunt-btn" type="button" data-action="rp-link">Link</button>
        </div>`;
    } else if (o.platform) {
      body = `
        ${o.platform === "Other" ? `<input class="eif-rp-orig-input" data-key="${key}" data-f="platformName" placeholder="Platform name" value="${escapeHtml(o.platformName || "")}" />` : ""}
        <input class="eif-rp-orig-input ${bad.link && o.link ? "eif-rp-bad" : ""}" data-key="${key}" data-f="link" type="url" placeholder="https://… link to your design on ${escapeHtml(o.platform === "Other" ? "that platform" : o.platform)}" value="${escapeHtml(o.link)}" />
        ${err("link")}
        <label class="eif-rp-orig-field">First published
          <input type="date" class="eif-rp-orig-input ${bad.date && o.published ? "eif-rp-bad" : ""}" data-key="${key}" data-f="published" data-asin="${escapeHtml(o.platform === "Amazon" ? asinFromLink(o.link) : "")}" value="${escapeHtml(o.published)}" min="1995-01-01" max="${today()}" />
          ${amazonDateNote(key, o)}
        </label>${err("date")}`;
    }
    return `
      <div class="eif-rp-orig">
        <label class="eif-rp-orig-field">Where is your original?${platformSelect}</label>
        ${body}
      </div>`;
  }

  function suggestedReportName(groups) {
    const first = groups && groups[0] && groups[0].items[0];
    const title = first ? String((trackedItems.get(first) || {}).title || "") : "";
    const short = title && title !== "Untitled listing" ? title.replace(/\s+(t-?shirt|tee|shirt)$/i, "").slice(0, 40).trim() : "Copied design";
    return `${short} copies, ${niceDate(today())}`;
  }

  let rpPickedOnly = false;
  const rpBeforeOpen = new Set();
  function renderReportView() {
    if (reportSite === "amazon") return renderAmazonReportView();
    renderEbayReportView();
    const view = viewEl();
    if (view) reportSiteSwitch(view);
  }

  function renderEbayReportView() {
    const view = viewEl();
    if (!view) return;
    const scroll = view.querySelector(".eif-scroll");
    const scrollTop = scroll ? scroll.scrollTop : 0;

    if (!reportSelection) {
      reportSelection = new Set();
      trackedItems.forEach((meta, n) => {
        if (!meta.reportedAt && !isMineEbay(n)) reportSelection.add(n);
      });
    }
    applyDateSafety();
    const draft = currentDraft();
    const groups = reportGroups(false);
    const chosen = reportGroups(true).filter((g) => g.items.length);
    const batches = buildBatches(chosen);
    const total = chosen.reduce((n, g) => n + g.items.length, 0);
    const longest = Math.max(0, ...chosen.map((g) => fillPlaceholders(draft.text, g).length), fillPlaceholders(draft.text, null).length);
    const tooLong = longest > DETAILS_MAX;
    const missing = chosen.map((g) => missingInfo(draft.text, g)).filter((m) => m.length);
    const needsLink = missing.length > 0;
    const signedOut = signedInState() === false;
    const jobActive = reportJob && reportJob.batches.some((b) => b.status !== "done");

    if (!activeTracked().length) {
      view.innerHTML = emptyStateHtml("Nothing to report on eBay yet", 'Mark copies first with "Copycat" on look-alikes or the "+" badges on eBay, then come back here.', findButtons());
      return;
    }

    let allCount = 0;
    const groupHtml = groups
      .map((group) => {
        const early = [];
        const rowOf = (n) => {
            const meta = trackedItems.get(n) || {};
            const published = originalFor(group).published;
            const listed = /^\d{4}-/.test(meta.listedAt || "") ? meta.listedAt : "";
            const before = listed && published && !dateProblem(published) && listed < published;
            if (before) early.push(n);
            return `
            <label class="eif-rp-item ${meta.reportedAt ? "eif-rp-done" : ""} ${before ? "eif-rp-before" : ""}" title="${before ? "Listed before your original. Check it before reporting: it might be the original." : ""}">
              <input type="checkbox" class="eif-rp-check" data-item-number="${n}" ${reportSelection.has(n) ? "checked" : ""} />
              ${meta.image ? `<img src="${safeSrc(meta.image)}" alt="" loading="lazy" />` : "<span></span>"}
              <span class="eif-rp-num">#${n}</span>
              <span class="eif-rp-listed">${listed ? `Listed ${escapeHtml(niceDate(listed))}` : meta.listedAt === "unknown" ? "Date unknown" : ebayRequestState?.paused ? "Check needed" : dateGaveUp(n) ? "Date not read" : "Reading date…"}</span>
              <span class="eif-rp-status">${before ? '<span class="eif-rp-tag eif-rp-tag-warn">Before yours</span>' : ""}
              ${meta.reportedAt ? `<span class="eif-rp-tag">Reported ${escapeHtml(meta.reportedAt)}</span>` : ""}
              ${!group.source && !group.hunt ? huntMoveSelect("ebay", n, groups.filter((g) => g.hunt || g.source).map((g) => g.hunt || `ebay:${g.source}`), true, "Move…") : ""}</span>
              <button type="button" class="eif-rp-x" data-action="rp-remove" data-item-number="${n}" title="Remove from the list (stops tracking it)" aria-label="Remove #${n}">&times;</button>
            </label>`;
          };
        const built = group.items.map((n) => [n, rowOf(n)]);
        allCount += group.items.length;
        const earlySet = new Set(early);
        const rows = built.filter(([n]) => !earlySet.has(n)).map(([, h]) => h).join("");
        const earlyRows = built.filter(([n]) => earlySet.has(n)).map(([, h]) => h).join("");
        const earlyPicked = early.filter((n) => reportSelection.has(n)).length;
        return `
          <div class="eif-rp-group eif-rp-listbox" data-gkey="${escapeHtml(group.key)}">
            <div class="eif-rp-group-head"><span class="eif-rp-gt">${
              group.source
                ? `Copies of your eBay listing <a href="https://www.ebay.com/itm/${group.source}" target="_blank" rel="noopener">#${group.source}</a>`
                : group.hunt
                ? `${huntThumb(group.hunt)}Copies found from ${escapeHtml(huntLabel(group.hunt))}`
                : groups.length > 1
                ? "Not sorted yet <span class=\"eif-rp-muted\">(tracked before copies were linked to a hunt: pick where each belongs)</span>"
                : "Copies of your design"
            }</span> <span>${(group.source || group.hunt) && group.items.some((i) => reportSelection.has(i)) ? huntMoveSelect("ebay", `@${group.key}`, groups.filter((g) => g.key !== group.key && (g.hunt || g.source)).map((g) => g.hunt || `ebay:${g.source}`), true, "Wrong design? Move ticked to…") : ""} ${group.items.length}</span></div>
            ${originalBlockHtml(group)}
            ${rows ? `<div class="eif-rp-items">${rows}</div>` : ""}
            ${earlyRows ? `<details class="eif-rp-before-group" data-gkey="${escapeHtml(group.key)}" ${rpBeforeOpen.has(group.key) ? "open" : ""}>
              <summary><span class="eif-rp-before-dot"></span><b>Listed before yours</b> <span class="eif-rp-muted">${early.length} · ${earlyPicked} picked · check these are really copies</span>
                ${earlyPicked ? `<button type="button" class="eif-hj-link" data-action="rp-unbefore" data-gkey="${escapeHtml(group.key)}">Unpick these</button>` : ""}</summary>
              <div class="eif-rp-items">${earlyRows}</div>
            </details>` : ""}
          </div>`;
      })
      .join("");

    setTimeout(loadReportDates, 0);
    const beforeCount = chosen.reduce(
      (n, g) => n + g.items.filter((i) => { const d = (trackedItems.get(i) || {}).listedAt || ""; const p = originalFor(g).published; return /^\d{4}-/.test(d) && p && !dateProblem(p) && d < p; }).length,
      0
    );
    const mineList = `<datalist id="eif-rp-mine">${[...protectedItems].map((n) => `<option value="${n}"></option>`).join("")}</datalist>`;
    view.innerHTML = `
      ${mineList}
      ${jobActive ? `<div class="eif-hj-note eif-rp-active">A report is in progress (${reportJob.batches.filter((b) => b.status === "done").length} of ${reportJob.batches.length} done). <button class="eif-hunt-btn" type="button" data-action="rp-resume">Go to next report</button> <button class="eif-hunt-btn" type="button" data-action="rp-cancel">Cancel it</button></div>` : ""}
      <div class="eif-scroll">
        <div class="eif-rp">
          <section class="eif-rp-col">
            <div class="eif-rp-h">Listings to report <span>${total} selected</span></div>
            <div class="eif-rp-pickbar eif-rp-pickbar-top" role="toolbar" aria-label="Pick listings">
              <div class="eif-seg">
                <button type="button" data-action="rp-all">All</button>
                <button type="button" data-action="rp-unreported" title="Only the ones you haven't reported yet">Not reported yet</button>
                <button type="button" data-action="rp-none">None</button>
              </div>
              <span class="eif-rp-pickcount"><b>${total}</b> of ${allCount} picked</span>
              <button type="button" class="eif-rp-toggle" data-action="rp-picked-only" aria-pressed="${rpPickedOnly}">Picked only</button>
            </div>
            <div class="eif-rp-groups${rpPickedOnly ? " eif-rp-picked-only" : ""}">${groupHtml}</div>
            <div class="eif-rp-more eif-rp-more-loose">
              <button type="button" class="eif-link-btn eif-link-danger" data-action="rp-remove-selected" ${total ? "" : "disabled"}>Remove picked</button>
            </div>
          </section>
          <section class="eif-rp-col">
            <div class="eif-rp-h">Report details</div>
            <label class="eif-rp-label">Report name
              <input id="eif-rp-name" class="eif-rp-name" maxlength="80" value="${escapeHtml(reportName)}" placeholder="${escapeHtml(suggestedReportName(chosen))}" />
              <span class="eif-rp-muted">Name it so you can find it later in the Reported tab, for example "Ducks shirt, Amazon copies". Leave it empty to use the name shown.</span>
            </label>
            <div class="eif-rp-row">
              <select class="eif-rp-select" id="eif-rp-template">${reportTemplates
                .map((t) => `<option value="${escapeHtml(t.id)}" ${t.id === activeTemplateId ? "selected" : ""}>${escapeHtml(t.name)}</option>`)
                .join("")}</select>
              <button class="eif-hunt-btn" type="button" data-action="rp-save">Save</button>
              <button class="eif-hunt-btn" type="button" data-action="rp-save-new">Save as new</button>
              <button class="eif-hunt-btn eif-hunt-btn-danger" type="button" data-action="rp-delete" ${reportTemplates.length < 2 ? "disabled" : ""}>Delete</button>
            </div>
            ${rpChoicesOpen ? `<label class="eif-rp-label">What would you like to report?${selectHtml("contentType", REPORT_OPTIONS.contentType, draft.contentType)}</label>
            <label class="eif-rp-label">Reason for report${selectHtml("reason", REPORT_OPTIONS.reason, draft.reason)}</label>
            <label class="eif-rp-label">Detailed reason${
              draft.reason === REPORT_OPTIONS.reason[0]
                ? selectHtml("detail", REPORT_OPTIONS.detail, draft.detail)
                : `<div class="eif-rp-hint">For this reason you'll pick the detailed reason on eBay's form.</div>`
            }</label>
            <div><button type="button" class="eif-hunt-btn" data-action="rp-choices-done">Done</button></div>`
            : `<div class="eif-az-contact-sum"><span class="eif-rp-muted">eBay's form:</span> <span>${escapeHtml([draft.contentType, draft.reason, draft.reason === REPORT_OPTIONS.reason[0] ? draft.detail : ""].filter(Boolean).join(" → "))}</span>
              <button type="button" class="eif-link-btn" data-action="rp-choices-edit">Change</button></div>`}
            <label class="eif-rp-label">Provide additional details
              <textarea id="eif-rp-text" rows="6" maxlength="1200">${escapeHtml(draft.text)}</textarea>
            </label>
            <div class="eif-rp-chips">Insert:
              ${["{platform}", "{original_link}", "{published}", "{copy_dates}", "{count}", "{today}"].map((p) => `<button type="button" class="eif-hj-chip" data-action="rp-insert" data-ph="${p}">${p}</button>`).join("")}
              <span class="eif-rp-count ${tooLong ? "eif-rp-over" : ""}">${longest} / ${DETAILS_MAX}</span>
            </div>
            <div class="eif-rp-preview"><div class="eif-rp-preview-h">Preview${chosen[0] && chosen[0].source ? ` (for #${chosen[0].source})` : ""}</div>${escapeHtml(fillPlaceholders(draft.text, chosen[0] || null))}</div>

            <div class="eif-rp-h">Send to eBay</div>
            <p class="eif-rp-send">Each report opens one copy's page and fills eBay's form there (up to 25 listings per report). You check it, tick eBay's confirmation box and press <b>Submit report</b>.</p>
            ${tooLong ? `<div class="eif-rp-hint eif-rp-over">Details are over eBay's ${DETAILS_MAX}-character limit.</div>` : ""}
            ${needsLink ? `<div class="eif-rp-hint eif-rp-over">Check "Where is your original?" on the left: it needs a real link to your design and the real date you first published it.</div>` : ""}
            ${signedOut ? `<div class="eif-rp-hint eif-rp-over">Sign in to eBay to send reports.</div>` : ""}
            ${beforeCount ? `<div class="eif-rp-hint eif-rp-over">${beforeCount} selected listing${beforeCount > 1 ? "s were" : " was"} listed before your original. Make sure they really copy you before reporting.</div>` : ""}
          </section>
        </div>
      </div>
      <div class="eif-rp-footer">
        <div class="eif-rp-foot-main">
          <div class="eif-rp-summary">${
            total
              ? `<b>${total} listing${total > 1 ? "s" : ""}</b> → ${batches.length} report${batches.length > 1 ? "s" : ""} on ebay.com <span class="eif-rp-muted">(up to 25 per report)</span>`
              : "Select at least one listing."
          }</div>
          <div class="eif-rp-footstat">${
            !total ? ""
            : signedOut ? '<span class="eif-rp-foot-bad">Sign in to eBay to send reports.</span>'
            : tooLong || needsLink ? '<span class="eif-rp-foot-bad">Fix the items in red in step 3 first.</span>'
            : beforeCount ? `<span class="eif-rp-foot-warn">Ready · ${beforeCount} listed before your original, double-check them</span>`
            : '<span class="eif-rp-foot-ok">Ready. You tick eBay\'s box and press Submit report yourself.</span>'
          }</div>
        </div>
        <button class="eif-hunt-btn eif-hunt-btn-primary eif-rp-start" type="button" data-action="rp-start" ${!total || tooLong || jobActive || needsLink || signedOut ? "disabled" : ""}>Start report${batches.length > 1 ? "s" : ""}</button>
      </div>`;
    const newScroll = view.querySelector(".eif-scroll");
    if (newScroll) newScroll.scrollTop = scrollTop;
  }

  function handleReportClick(action, target) {
    if (action === "rp-site") {
      reportSite = target.dataset.site === "amazon" ? "amazon" : "ebay";
      renderReportView();
      return;
    }
    const draft = currentDraft();
    if (action === "rp-all" || action === "rp-none" || action === "rp-unreported") {
      reportSelection = new Set();
      trackedItems.forEach((meta, n) => {
        if (isMineEbay(n)) return;
        if (action === "rp-all" || (action === "rp-unreported" && !meta.reportedAt)) reportSelection.add(n);
      });
      renderReportView();
    } else if (action === "rp-picked-only") {
      rpPickedOnly = !rpPickedOnly;
      const box = popup.overlay.querySelector(".eif-rp-groups");
      if (box) box.classList.toggle("eif-rp-picked-only", rpPickedOnly);
      target.setAttribute("aria-pressed", String(rpPickedOnly));
    } else if (action === "rp-unbefore") {
      const det = target.closest(".eif-rp-before-group");
      if (det) det.querySelectorAll(".eif-rp-check").forEach((c) => reportSelection.delete(c.dataset.itemNumber));
      renderReportView();
    } else if (action === "rp-remove" || action === "rp-remove-selected") {
      const list = action === "rp-remove" ? [target.dataset.itemNumber] : [...(reportSelection || [])].filter((n) => trackedItems.has(n));
      if (!list.length) return;
      if (list.length > 1 && !window.confirm(`Remove ${list.length} listings from the list? They'll stop being copycats.`)) return;
      list.forEach((n) => {
        trackedItems.delete(n);
        if (reportSelection) reportSelection.delete(n);
        syncBadgeProtection(n);
      });
      saveTrackedItems();
      updatePanel();
      updateTabCounts();
      renderReportView();
      showToast(list.length > 1 ? `Removed ${list.length} listings` : `Removed #${list[0]}`);
    } else if (action === "rp-insert") {
      const ta = popup.overlay.querySelector("#eif-rp-text");
      const ph = target.dataset.ph;
      const start = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, start) + ph + ta.value.slice(ta.selectionEnd ?? start);
      draft.text = ta.value;
      renderReportView();
      const again = popup.overlay.querySelector("#eif-rp-text");
      again.focus();
      again.selectionStart = again.selectionEnd = start + ph.length;
    } else if (action === "rp-choices-edit" || action === "rp-choices-done") {
      rpChoicesOpen = action === "rp-choices-edit";
      renderReportView();
    } else if (action === "rp-save") {
      const t = activeTemplate();
      Object.assign(t, draft);
      saveTemplates();
      showToast(`Template "${t.name}" saved`);
    } else if (action === "rp-save-new") {
      const name = (window.prompt("Name for this template:", `${draft.detail || "My"} template`) || "").trim();
      if (!name) return;
      const t = { id: `tpl-${Date.now()}`, name: name.slice(0, 60), ...draft };
      reportTemplates.push(t);
      activeTemplateId = t.id;
      saveTemplates();
      renderReportView();
      showToast(`Template "${t.name}" saved`);
    } else if (action === "rp-delete") {
      if (reportTemplates.length < 2) return;
      const t = activeTemplate();
      if (!window.confirm(`Delete the template "${t.name}"?`)) return;
      reportTemplates = reportTemplates.filter((x) => x.id !== t.id);
      activeTemplateId = reportTemplates[0].id;
      reportDraft = null;
      saveTemplates();
      renderReportView();
    } else if (action === "rp-orig-date-read") {
      const key = target.dataset.key;
      const cur = originals[key] || {};
      originals[key] = { ...cur, published: cur.dateFromAmazon ? cur.published : "", dateFromAmazon: !!cur.dateFromAmazon, dateAsin: cur.dateFromAmazon ? cur.dateAsin : "", dateLookup: "", dateForce: true };
      saveOriginals();
      renderReportView();
    } else if (action === "rp-link") {
      const input = target.parentElement.querySelector(".eif-rp-src-input");
      const source = normalizeItemNumber(input && input.value);
      if (!source) return showToast("Enter your listing's item number");
      (isMineEbay(source) ? Promise.resolve("recognised") : askMine("ebay", source)).then((r) => {
        if (!r) return;
        if (r === "marked") protectItem(source);
        trackedItems.forEach((meta, n) => {
          if (!meta.source && n !== source) meta.source = source;
        });
        originals[source] = { ...(originals[source] || {}), platform: "eBay" };
        saveOriginals();
        saveTrackedItems();
        renderReportView();
        showToast(`Linked to your listing #${source}`);
      });
    } else if (action === "rp-start") {
      startReportJob();
    } else if (action === "rp-resume") {
      goToCurrentBatch();
    } else if (action === "rp-cancel") {
      cancelReportJob();
      renderReportView();
    }
  }

  function handleReportInput(e) {
    if (reportSite === "amazon") return handleAzInput(e);
    const draft = currentDraft();
    if (e.target.id === "eif-rp-name") {
      reportName = e.target.value;
      return;
    }
    if (e.target.classList.contains("eif-rp-orig-input")) {
      const key = e.target.dataset.key;
      originals[key] = { ...(originals[key] || {}), [e.target.dataset.f]: e.target.value.trim() };
      return;
    }
    if (e.target.id === "eif-rp-text") {
      draft.text = e.target.value;
      const chosen = reportGroups(true).filter((g) => g.items.length);
      const longest = Math.max(0, ...chosen.map((g) => fillPlaceholders(draft.text, g).length), fillPlaceholders(draft.text, null).length);
      const count = popup.overlay.querySelector(".eif-rp-count");
      count.textContent = `${longest} / ${DETAILS_MAX}`;
      count.classList.toggle("eif-rp-over", longest > DETAILS_MAX);
      const prev = popup.overlay.querySelector(".eif-rp-preview");
      prev.lastChild.textContent = fillPlaceholders(draft.text, chosen[0] || null);
      const start = popup.overlay.querySelector(".eif-rp-start");
      if (start)
        start.disabled =
          longest > DETAILS_MAX ||
          !chosen.length ||
          chosen.some((g) => missingInfo(draft.text, g).length) ||
          signedInState() === false ||
          (reportJob && reportJob.batches.some((b) => b.status !== "done"));
    }
  }

  function handleReportChange(e) {
    if (reportSite === "amazon") return handleAzChange(e);
    const draft = currentDraft();
    if (e.target.id === "eif-rp-template") {
      activeTemplateId = e.target.value;
      reportDraft = null;
      saveTemplates();
      renderReportView();
    } else if (e.target.classList.contains("eif-rp-select") && e.target.dataset.field) {
      draft[e.target.dataset.field] = e.target.value;
      renderReportView();
    } else if (e.target.classList.contains("eif-rp-orig-platform")) {
      const key = e.target.dataset.key;
      const prev = originals[key] || {};
      originals[key] = { ...prev, platform: e.target.value, link: e.target.value === prev.platform ? prev.link : "" };
      saveOriginals();
      renderReportView();
    } else if (e.target.classList.contains("eif-rp-orig-input")) {
      const key = e.target.dataset.key;
      const f = e.target.dataset.f;
      let value = e.target.value.trim();
      if (f === "link" && value && !/^[a-z][a-z0-9+.-]*:/i.test(value) && /^[^\s/]+\.[a-z]{2,}(\/|$)/i.test(value)) value = `https://${value}`;
      if (f === "published" && document.activeElement === e.target) {
        originals[key] = { ...(originals[key] || {}), published: value, dateFromEbay: false, dateFromAmazon: false, dateAsin: e.target.dataset.asin || "" };
        if (!e.target._eifBlur) {
          e.target._eifBlur = true;
          e.target.addEventListener("blur", () => { saveOriginals(); renderReportView(); }, { once: true });
        }
        return;
      }
      originals[key] = { ...(originals[key] || {}), [f]: value };
      if (f === "published") {
        originals[key].dateFromEbay = false;
        originals[key].dateFromAmazon = false;
        originals[key].dateAsin = e.target.dataset.asin || "";
      }
      if (f === "link") {
        delete originals[key].dateLookup;
        const nowAsin = asinFromLink(value);
        if (originals[key].published && (originals[key].dateFromAmazon || (originals[key].dateAsin && originals[key].dateAsin !== nowAsin))) {
          originals[key].published = ""; originals[key].dateFromAmazon = false; originals[key].dateAsin = "";
        }
      }
      saveOriginals();
      renderReportView();
    } else if (e.target.classList.contains("eif-rp-check")) {
      const n = e.target.dataset.itemNumber;
      if (e.target.checked) reportSelection.add(n);
      else reportSelection.delete(n);
      renderReportView();
    }
  }

  function startReportJob() {
    if (!requireSignIn()) return;
    const chosen = reportGroups(true).filter((g) => g.items.length);
    const batches = buildBatches(chosen);
    if (!batches.length) return;
    const draft = currentDraft();
    reportJob = {
      id: `job-${Date.now()}`,
      created: today(),
      name: reportName.trim() || suggestedReportName(chosen),
      fields: { ...draft },
      batches: batches.map((b) => ({ ...b, details: fillPlaceholders(draft.text, { source: b.source, key: b.key, hunt: b.hunt, items: [b.anchor, ...b.extras] }) })),
    };
    reportName = "";
    saveJob();
    goToCurrentBatch();
  }

  function currentBatchIndex() {
    return reportJob ? reportJob.batches.findIndex((b) => b.status !== "done") : -1;
  }

  function goToCurrentBatch() {
    const i = currentBatchIndex();
    if (i < 0) return finishReportJob();
    if (navigator.onLine === false) {
      showReportBar({
        text: "No internet connection. The report continues as soon as you're back online.",
        tone: "err",
        buttons: [{ id: "cancel", label: "Cancel reports", run: cancelReportJob }],
      });
      retryWhenOnline("report", goToCurrentBatch);
      return;
    }
    const batch = reportJob.batches[i];
    if (currentPageItemNumber() === batch.anchor) {
      closePopup();
      runReportOnPage();
    } else {
      location.href = `https://www.ebay.com/itm/${batch.anchor}`;
    }
  }

  function cancelReportJob() {
    document.documentElement.classList.remove("eif-reporting");
    reportJob = null;
    saveJob();
    removeReportBar();
    showToast("Report cancelled");
  }

  function finishReportJob() {
    document.documentElement.classList.remove("eif-reporting");
    const n = reportJob ? reportJob.batches.length : 0;
    reportJob = null;
    saveJob();
    showReportBar({ text: n === 1 ? "Report sent. All done." : `All ${n} reports sent.`, done: true });
  }

  function markBatchReported(i) {
    const batch = reportJob.batches[i];
    batch.status = "done";
    const date = today();
    const items = [batch.anchor, ...batch.extras];
    items.forEach((n) => {
      const meta = trackedItems.get(n);
      if (meta) meta.reportedAt = date;
    });
    const o = originalFor({ source: batch.source, key: batch.key, hunt: batch.hunt, items });
    const count = reportJob.batches.length;
    reportHistory.push({
      id: `rep-${Date.now()}-${i}`,
      name: reportJob.name ? (count > 1 ? `${reportJob.name} (${i + 1} of ${count})` : reportJob.name) : "",
      sentAt: new Date().toISOString(),
      source: batch.source || "",
      platform: o.platformLabel || "",
      originalLink: o.link || "",
      design: batch.hunt || (batch.source ? `ebay:${batch.source}` : ""),
      detail: reportJob.fields.detail || reportJob.fields.reason || "",
      items: items.map((n) => ({ n, image: (trackedItems.get(n) || {}).image || "", status: "", checkedAt: "" })),
    });
    saveHistory();
    saveTrackedItems();
    saveJob();
    updatePanel();
  }

  function removeReportBar() {
    const bar = document.getElementById("eif-report-bar");
    if (bar) bar.remove();
  }

  function showReportBar({ text, tone = "", buttons = [], done = false }) {
    let bar = document.getElementById("eif-report-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "eif-report-bar";
      document.body.appendChild(bar);
      bar.addEventListener("click", (e) => {
        const b = e.target.closest("[data-rb]");
        if (b && bar._handlers && bar._handlers[b.dataset.rb]) bar._handlers[b.dataset.rb]();
      });
    }
    const i = currentBatchIndex();
    const step = reportJob && i >= 0 ? `Report ${i + 1} of ${reportJob.batches.length}` : "Reports";
    bar._handlers = {};
    buttons.forEach((b) => (bar._handlers[b.id] = b.run));
    bar.className = tone ? `eif-rb-${tone}` : "";
    bar.innerHTML = `
      <span class="eif-rb-icon">${LOGO}</span>
      <div class="eif-rb-main"><div class="eif-rb-step">${escapeHtml(step)}</div><div class="eif-rb-text">${escapeHtml(text)}</div></div>
      ${buttons.map((b) => `<button type="button" class="eif-hunt-btn ${b.primary ? "eif-hunt-btn-primary" : ""}" data-rb="${b.id}">${escapeHtml(b.label)}</button>`).join("")}
      <button type="button" class="eif-rb-x" data-rb="close" title="Hide">&times;</button>`;
    bar._handlers.close = removeReportBar;
    if (done) setTimeout(removeReportBar, 8000);
  }

  function resumeReportJobOnLoad() {
    const i = currentBatchIndex();
    if (i < 0) return;
    const batch = reportJob.batches[i];
    if (currentPageItemNumber() === batch.anchor) {
      runReportOnPage();
    } else {
      showReportBar({
        text: `Waiting on listing #${batch.anchor} (${1 + batch.extras.length} listings in this report).`,
        buttons: [
          { id: "go", label: "Go to it", primary: true, run: goToCurrentBatch },
          { id: "cancel", label: "Cancel reports", run: cancelReportJob },
        ],
      });
    }
  }

  function reportModal() {
    for (const m of document.querySelectorAll(".ifh-modal")) {
      const inner = m.querySelector('input[role="combobox"], .ifh-dsa-submit-button, textarea');
      if (inner && inner.getBoundingClientRect().height > 0) return m;
    }
    return null;
  }

  function findCombo(modal, labelStart) {
    return [...modal.querySelectorAll('input[role="combobox"]')].find((i) =>
      (i.getAttribute("aria-label") || "").trim().toLowerCase().startsWith(labelStart.toLowerCase())
    );
  }

  async function pickComboOption(modal, labelStart, optionText) {
    const input = await waitFor(() => findCombo(modal, labelStart), 6000);
    if (!input) throw new Error(`Couldn't find "${labelStart}" on eBay's form.`);
    if ((input.value || "").trim() === optionText) return;
    const listbox =
      (input.getAttribute("aria-controls") && document.getElementById(input.getAttribute("aria-controls"))) ||
      input.closest("[class*='combobox']")?.querySelector('[role="listbox"]');
    const option = await waitFor(
      () => [...(listbox || modal).querySelectorAll('[role="option"]')].find((o) => o.textContent.trim() === optionText),
      4000
    );
    if (!option) throw new Error(`eBay's form has no "${optionText}" option for "${labelStart}".`);
    option.click();
    await waitFor(() => (input.value || "").trim() === optionText, 3000);
    await new Promise((r) => setTimeout(r, 300));
  }

  function setTextarea(el, value) {
    el.focus();
    el.select();
    let ok = false;
    try {
      ok = value ? document.execCommand("insertText", false, value) : document.execCommand("delete", false);
    } catch (e) {
      ok = false;
    }
    if (!ok || el.value !== value) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, value);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
  }

  function fieldText(el) {
    const id = el.id;
    const label = id && document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label) return label.textContent;
    let box = el.parentElement;
    for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
      const t = box.querySelector("label, .field__label, [class*='label']");
      if (t && !t.contains(el)) return t.textContent;
    }
    return "";
  }

  let reportRunning = false;

  async function runReportOnPage() {
    if (reportRunning) return;
    const i = currentBatchIndex();
    if (i < 0) return;
    const batch = reportJob.batches[i];
    const fields = reportJob.fields;
    reportRunning = true;
    document.documentElement.classList.add("eif-reporting");
    showReportBar({ text: "Opening eBay's report form…" });
    try {
      let modal = reportModal();
      if (!modal) {
        const help = await waitFor(
          () => [...document.querySelectorAll("button")].find((b) => /^help/i.test(b.getAttribute("aria-label") || "")),
          12000
        );
        if (!help) throw new Error("Couldn't find eBay's \"?\" help button on this page.");
        help.click();
        const submitLink = await waitFor(
          () =>
            [...document.querySelectorAll("button, a")].find(
              (b) => b.textContent.trim() === "Submit report" && !b.classList.contains("ifh-dsa-submit-button") && b.getBoundingClientRect().height > 0
            ),
          8000
        );
        if (!submitLink) throw new Error("eBay's help panel didn't show \"Submit report\".");
        submitLink.click();
        modal = await waitFor(() => reportModal() && findCombo(reportModal(), "What would you like") && reportModal(), 8000);
        if (!modal) throw new Error("eBay's report form didn't open.");
      }

      showReportBar({ text: "Filling in the report…" });
      await pickComboOption(modal, "What would you like", fields.contentType);

      if (fields.contentType === REPORT_OPTIONS.contentType[0]) {
        const findItemsBox = () =>
          [...modal.querySelectorAll("textarea")].find((t) => /item number/i.test(fieldText(t))) ||
          [...modal.querySelectorAll("textarea")].find((t) => Number(t.getAttribute("maxlength")) > DETAILS_MAX);
        const findDetailsBox = () =>
          [...modal.querySelectorAll("textarea")].find((t) => /additional details/i.test(fieldText(t))) ||
          [...modal.querySelectorAll("textarea")].find((t) => Number(t.getAttribute("maxlength")) === DETAILS_MAX);

        if (batch.extras.length && !findItemsBox()) {
          const add = await waitFor(() => [...modal.querySelectorAll("button")].find((b) => b.textContent.trim() === "Add content"), 5000);
          if (!add) throw new Error("Couldn't find eBay's \"Add content\" button.");
          add.click();
          if (!(await waitFor(findItemsBox, 5000))) throw new Error("Couldn't find the additional item numbers box.");
        }

        await pickComboOption(modal, "Reason for report", fields.reason);
        if (fields.reason === REPORT_OPTIONS.reason[0] && fields.detail) {
          await pickComboOption(modal, "Detailed reason", fields.detail);
        }
        await new Promise((r) => setTimeout(r, 400));

        const wantItems = batch.extras.join(", ");
        const wantDetails = (batch.details || "").slice(0, DETAILS_MAX);
        for (let attempt = 0; attempt < 3; attempt++) {
          const itemsBox = batch.extras.length ? findItemsBox() : null;
          const detailsBox = await waitFor(findDetailsBox, 5000);
          if (itemsBox && itemsBox.value !== wantItems) setTextarea(itemsBox, wantItems);
          if (detailsBox && wantDetails && detailsBox.value !== wantDetails) setTextarea(detailsBox, wantDetails);
          await new Promise((r) => setTimeout(r, 500));
          const itemsOk = !batch.extras.length || (findItemsBox() && findItemsBox().value === wantItems);
          const detailsOk = !wantDetails || (findDetailsBox() && findDetailsBox().value === wantDetails);
          if (itemsOk && detailsOk) break;
          if (attempt === 2) throw new Error("eBay's form didn't keep the item numbers or details. Press \"Fill again\".");
        }
      }

      const checkbox = modal.querySelector('input[type="checkbox"]');
      const submit = modal.querySelector(".ifh-dsa-submit-button");
      if (checkbox) {
        const row = checkbox.closest("label, div") || checkbox;
        row.classList.add("eif-rp-attention");
        row.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      if (submit && !submit._eifWatched) {
        submit._eifWatched = true;
        submit.addEventListener("click", () => watchForSubmission(i), true);
      }
      showReportBar({
        text: `Filled in: ${1 + batch.extras.length} listing${batch.extras.length ? "s" : ""}. Check it, tick eBay's confirmation box, then press Submit report.`,
        tone: "ready",
        buttons: [
          { id: "refill", label: "Fill again", run: () => runReportOnPage() },
          { id: "cancel", label: "Cancel reports", run: cancelReportJob },
        ],
      });
    } catch (err) {
      if (navigator.onLine === false) {
        showReportBar({
          text: "No internet connection. Filling continues as soon as you're back online.",
          tone: "err",
          buttons: [{ id: "cancel", label: "Cancel reports", run: cancelReportJob }],
        });
        retryWhenOnline("fill", () => runReportOnPage());
        return;
      }
      showReportBar({
        text: (err && err.message) || "Something went wrong filling the form.",
        tone: "err",
        buttons: [
          { id: "retry", label: "Try again", primary: true, run: () => runReportOnPage() },
          ...(batch.extras.length
            ? [{ id: "swap", label: "Start from the next listing", run: () => swapAnchor() }]
            : []),
          { id: "cancel", label: "Cancel reports", run: cancelReportJob },
        ],
      });
    } finally {
      reportRunning = false;
    }
  }

  function swapAnchor() {
    const i = currentBatchIndex();
    if (i < 0) return;
    const batch = reportJob.batches[i];
    if (!batch.extras.length) return;
    batch.anchor = batch.extras.shift();
    saveJob();
    goToCurrentBatch();
  }

  async function watchForSubmission(i) {
    const before = document.querySelector(".ifh-modal")?.textContent || "";
    const confirmed = await waitFor(() => {
      const modal = document.querySelector(".ifh-modal");
      const text = modal ? modal.textContent : "";
      return (
        /thank|received your report|report (was|has been) (sent|submitted)|we.ll review/i.test(text) && text !== before
      );
    }, 8000);
    const proceed = () => {
      markBatchReported(i);
      const next = currentBatchIndex();
      if (next < 0) return finishReportJob();
      showReportBar({
        text: `Report ${i + 1} sent. ${reportJob.batches.length - next} to go.`,
        tone: "ready",
        buttons: [
          { id: "next", label: "Next report", primary: true, run: goToCurrentBatch },
          { id: "cancel", label: "Stop here", run: cancelReportJob },
        ],
      });
    };
    if (confirmed) return proceed();
    showReportBar({
      text: "Did eBay accept the report?",
      buttons: [
        { id: "yes", label: "Yes, it was sent", primary: true, run: proceed },
        { id: "no", label: "Not yet", run: () => resumeReportJobOnLoad() },
      ],
    });
  }

  async function checkListingStatus(itemNumber) {
    const res = await ebayFetch(`${EBAY}/itm/${itemNumber}`, { credentials: "include" });
    if (res.status === 404 || res.status === 410) {
      return { status: "removed", note: "The listing page no longer exists." };
    }
    if (!res.ok || !/\/itm\//.test(res.url || "")) return { status: "", note: "eBay could not verify this listing. Try later." };
    const html = await res.text();
    const state = (html.match(/"listingStatus"\s*:\s*"([A-Z_]+)"/) || [])[1] || "";
    const doc = new DOMParser().parseFromString(html, "text/html");
    const banner =
      [...doc.querySelectorAll('[class*="status"], [class*="message"], [class*="alert"], [class*="notice"]')]
        .map((e) => e.textContent.replace(/\s+/g, " ").trim())
        .find((t) => t && t.length < 240 && /this listing (?:was|has) (?:ended|removed)|no longer available/i.test(t)) || "";
    if (state === "ACTIVE") return { status: "live", note: "" };
    if (state === "ENDED" || banner) {
      const byEbay = /ended by ebay|removed by ebay|violat|policy|reported/i.test(banner);
      return { status: byEbay ? "removed" : "ended", note: banner };
    }
    if (doc.querySelector("h1.x-item-title__mainTitle")) return { status: "live", note: "" };
    return { status: "", note: "eBay did not return a recognizable listing page." };
  }

  let historyChecking = false;
  async function checkHistoryStatus(reportIds) {
    if (historyChecking) return;
    const reports = reportHistory.filter((r) => !reportIds || reportIds.includes(r.id));
    const jobs = [];
    reports.forEach((r) => r.items.forEach((it) => { if (!it.manual) jobs.push({ it, site: r.site }); }));
    if (!jobs.length && reports.some((r) => r.items.length)) { showToast("You set these statuses yourself. Choose \"Not checked\" on a listing to let the tool check it."); return; }
    if (!jobs.length) return;
    historyChecking = true;
    let done = 0;
    const progress = () => {
      const el = popup && popup.overlay.querySelector("#eif-hist-progress");
      if (el) el.textContent = `Checking ${done} of ${jobs.length}…`;
    };
    progress();
    try {
      await mapLimit(jobs, 4, async ({ it, site }) => {
        const result = site === "amazon" ? await checkAmazonStatus(it.n) : await checkListingStatus(it.n);
        if (result.status) it.status = result.status;
        it.note = result.note;
        it.checkedAt = new Date().toISOString();
        done++;
        progress();
      });
      showToast("Status updated");
    } catch (e) {
      retryAfterEbayPause(e, "history", () => checkHistoryStatus(reportIds), () => popup?.tab === "reported");
      if (await isConnectionProblem(e)) {
        showToast("No internet connection. The check continues when you're back online.");
        retryWhenOnline("history", () => checkHistoryStatus(reportIds));
      } else {
        showToast(e?.code === "EBAY_PAUSED" ? e.message : "Couldn't check every listing. Try again.");
      }
    }
    historyChecking = false;
    saveHistory();
    if (popup && popup.tab === "reported") renderReportedView();
  }

  const STATUS_CHOICES = [["live", "Still live"], ["ended", "Ended by seller"], ["removed", "Removed"], ["", "Not checked"]];
  function statusPicker(it) {
    const map = { live: ["Still live", "eif-st-live"], removed: ["Removed", "eif-st-removed"], ended: ["Ended by seller", "eif-st-ended"] };
    const [label, cls] = map[it.status] || ["Not checked", "eif-st-none"];
    return `<div class="eif-hist-menu eif-st-menu">
        <button type="button" class="eif-st ${cls}${it.manual ? " eif-st-manual" : ""}" data-action="hist-menu" aria-haspopup="true" title="${it.manual ? "Set by you. Click to change." : "Click to set the status yourself"}">${label}${it.manual ? ' <i class="eif-st-you">you</i>' : ""}<i class="eif-st-caret" aria-hidden="true"></i></button>
        <div class="eif-hist-pop" role="menu">
          <div class="eif-st-pop-h">Set status</div>
          ${STATUS_CHOICES.map(([v, l]) => `<button type="button" role="menuitem" data-action="hist-set-status" data-status="${v}"${(it.status || "") === v ? ' aria-checked="true"' : ""}>${l}</button>`).join("")}
        </div>
      </div>`;
  }

  function statusPill(status) {
    const map = { live: ["Still live", "eif-st-live"], removed: ["Removed", "eif-st-removed"], ended: ["Ended by seller", "eif-st-ended"] };
    const [label, cls] = map[status] || ["Not checked", "eif-st-none"];
    return `<span class="eif-st ${cls}">${label}</span>`;
  }

  let histFilter = "all";
  let histQuery = "";
  const histOpen = new Set();
  const histShowAll = new Set();

  function histDesignKey(r) {
    if (r.design) return r.design;
    const link = r.originalLink || "";
    const asin = (link.match(/\/dp\/([A-Z0-9]{10})/i) || [])[1];
    if (r.site === "amazon" && asin) return `amz:${asin.toUpperCase()}`;
    if (r.source) return `ebay:${r.source}`;
    const item = (link.match(/ebay\.com\/itm\/(\d{9,15})/) || [])[1];
    if (item) return `ebay:${item}`;
    if (asin) return `amz:${asin.toUpperCase()}`;
    return link ? `link:${link}` : "other";
  }

  function histDesignLabel(key, reports) {
    const h = hunts.get(key);
    if (h && h.label) return h.label;
    if (key.startsWith("amz:")) return `Your Amazon product ${key.slice(4)}`;
    if (key.startsWith("ebay:")) return `Your eBay listing #${key.slice(5)}`;
    if (key.startsWith("link:")) return `Original: ${key.slice(5).replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}`;
    if (key === "other") return "Other reports";
    const named = reports.find((r) => r.name);
    return named ? named.name : huntLabel(key);
  }

  function histMatches(r, q) {
    if (!q) return true;
    const hay = [r.name, r.detail, r.originalLink, histDesignKey(r), histDesignLabel(histDesignKey(r), [r]), ...r.items.map((it) => it.n)].join(" ").toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w.replace(/^#/, "")));
  }

  function statusSummary(items, waitingCount) {
    const c = (st) => items.filter((it) => it.status === st).length;
    const parts = [];
    if (c("removed")) parts.push(`<span class="eif-hs-ok">${c("removed")} removed</span>`);
    if (c("ended")) parts.push(`<span class="eif-hs-end">${c("ended")} ended</span>`);
    if (c("live")) parts.push(`<span class="eif-hs-live">${c("live")} still live</span>`);
    if (waitingCount) parts.push(`<span class="eif-hs-wait">${waitingCount} waiting on Amazon</span>`);
    const nc = items.filter((it) => !it.status).length;
    if (nc) parts.push(`<span>${nc} not checked</span>`);
    return parts.join(" · ");
  }

  function renderReportedView() {
    const view = viewEl();
    if (!view) return;
    if (!reportHistory.length) {
      view.innerHTML = emptyStateHtml("No reports sent yet", "Reports you send show up here, so you can check whether eBay or Amazon took the listings down.", activeTracked().length || azTargets().length ? [{ label: "Go to Report", action: "go-tab", go: "report", primary: true }] : findButtons());
      return;
    }
    const scrollEl = view.querySelector(".eif-scroll");
    const scrollTop = scrollEl ? scrollEl.scrollTop : 0;
    const searchFocused = document.activeElement && document.activeElement.id === "eif-hist-search";
    const caret = searchFocused ? document.activeElement.selectionStart : null;

    const siteOf = (r) => (r.site === "amazon" ? "amazon" : "ebay");
    const activeReports = reportHistory.filter((r) => !r.archived);
    const counts = {
      all: activeReports.length,
      amazon: activeReports.filter((r) => siteOf(r) === "amazon").length,
      ebay: activeReports.filter((r) => siteOf(r) === "ebay").length,
      archived: reportHistory.length - activeReports.length,
    };
    if (histFilter !== "all" && !counts[histFilter]) histFilter = "all";
    const shown = reportHistory.filter((r) =>
      (histFilter === "archived" ? r.archived : !r.archived && (histFilter === "all" || siteOf(r) === histFilter)) && histMatches(r, histQuery)
    );
    const all = activeReports.flatMap((r) => r.items);
    const count = (st) => all.filter((it) => it.status === st).length;
    const fmt = (iso) => {
      const d = new Date(iso);
      return isNaN(d) ? "" : d.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    };

    const groups = new Map();
    shown.forEach((r) => {
      const k = histDesignKey(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    });
    const ordered = [...groups.entries()]
      .map(([k, list]) => [k, list.sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)))])
      .sort((a, b) => String(b[1][0].sentAt).localeCompare(String(a[1][0].sentAt)));
    const autoOpen = ordered.length === 1 || !!histQuery;

    const reportCard = (r) => {
      const live = r.items.filter((it) => it.status === "live").length;
      const locks = r.site === "amazon" ? azReportLocks([r]) : new Map();
      const waiting = locks.size ? Math.max(...[...locks.values()].map((l) => l.until)) : 0;
      const limit = 12;
      const items = histShowAll.has(r.id) ? r.items : r.items.slice(0, limit);
      const more = r.items.length - items.length;
      return `
        <div class="eif-hist ${r.archived ? "eif-hist-archived" : ""}" data-report-id="${escapeHtml(r.id)}">
          <div class="eif-hist-head">
            <div class="eif-hist-info">
              <div class="eif-hist-title">${escapeHtml(r.name || fmt(r.sentAt))} <span class="eif-hist-when">· ${r.name ? `${escapeHtml(fmt(r.sentAt))} · ` : ""}${r.items.length} listing${r.items.length > 1 ? "s" : ""}</span>${r.archived ? ' <span class="eif-hist-tag">Archived</span>' : ""}</div>
              <div class="eif-hist-sub"><span class="eif-kind eif-kind-${siteOf(r)}">${siteOf(r) === "amazon" ? "Amazon" : "eBay"}</span> ${escapeHtml(r.detail || "")}${
                r.originalLink ? ` · <a href="${safeHref(r.originalLink)}" target="_blank" rel="noopener">your original</a>` : ""
              } · ${statusSummary(r.items, 0) || "not checked"}</div>
            </div>
            <div class="eif-hist-actions">
              <button class="eif-hunt-btn" type="button" data-action="hist-check" ${historyChecking ? "disabled" : ""}>Check status</button>
              ${waiting ? `<span class="eif-hist-wait" title="Amazon asks not to report the same listing twice while it reviews a report.">Waiting on Amazon until ${escapeHtml(lockDate(waiting))}</span><button class="eif-hunt-btn" type="button" data-action="hist-replied" title="Amazon emailed you its decision: unlock these listings now">Amazon replied</button>` : ""}
              ${live && !waiting && !r.archived ? `<button class="eif-hunt-btn eif-hunt-btn-green" type="button" data-action="hist-rereport">Report again (${live} still live)</button>` : ""}
              <div class="eif-hist-menu">
                <button class="eif-hist-dots" type="button" data-action="hist-menu" aria-haspopup="true" aria-label="More for this report" title="More">⋯</button>
                <div class="eif-hist-pop" role="menu">
                  <button type="button" role="menuitem" data-action="hist-rename">Rename</button>
                  <button type="button" role="menuitem" data-action="${r.archived ? "hist-unarchive" : "hist-archive"}">${r.archived ? "Move back from archive" : "Archive"}</button>
                  <button type="button" role="menuitem" class="eif-hist-del" data-action="hist-delete">Delete…</button>
                </div>
              </div>
            </div>
          </div>
          <div class="eif-hist-items">
            ${items
              .map(
                (it) => `
              <div class="eif-hist-item" data-n="${escapeHtml(it.n)}">
                <a class="eif-hist-link" href="${r.site === "amazon" ? AZ.productUrl(r.marketplace || "US", it.n) : `https://www.ebay.com/itm/${it.n}`}" target="_blank" rel="noopener" title="${it.manual ? `Set by you on ${escapeHtml(fmt(it.checkedAt))}` : it.checkedAt ? `${it.note ? escapeHtml(it.note) + " · " : ""}Checked ${escapeHtml(fmt(it.checkedAt))}` : "Not checked yet"}">
                  ${it.image ? `<img src="${safeSrc(it.image)}" alt="" loading="lazy" />` : "<span></span>"}
                  <span class="eif-rp-num">${r.site === "amazon" ? it.n : `#${it.n}`}</span>
                </a>
                ${statusPicker(it)}
              </div>`
              )
              .join("")}
            ${more > 0 ? `<button type="button" class="eif-hist-more" data-action="hist-show-all">Show all ${r.items.length} listings</button>` : ""}
          </div>
        </div>`;
    };

    const designRows = ordered
      .map(([key, list]) => {
        const items = list.flatMap((r) => r.items);
        const sites = [...new Set(list.map(siteOf))];
        const waitingCount = list.reduce((n, r) => n + (r.site === "amazon" && !r.archived ? azReportLocks([r]).size : 0), 0);
        const open = autoOpen || histOpen.has(key);
        const thumb = (hunts.get(key) || {}).image || (items.find((it) => it.image) || {}).image || "";
        const doneReports = list.filter((r) => !r.archived && r.items.length && r.items.every((it) => it.status === "removed" || it.status === "ended")).length;
        return `
        <section class="eif-hd ${open ? "eif-hd-open" : ""}" data-design="${escapeHtml(key)}">
          <button type="button" class="eif-hd-head" data-action="hist-toggle" aria-expanded="${open}">
            ${thumb ? `<img class="eif-hd-thumb" src="${safeSrc(thumb)}" alt="" loading="lazy" />` : '<span class="eif-hd-thumb"></span>'}
            <span class="eif-hd-main">
              <span class="eif-hd-title">${escapeHtml(histDesignLabel(key, list))}</span>
              <span class="eif-hd-sub">${sites.map((s) => `<span class="eif-kind eif-kind-${s}">${s === "amazon" ? "Amazon" : "eBay"}</span>`).join(" ")} ${list.length} report${list.length > 1 ? "s" : ""} · ${items.length} listing${items.length > 1 ? "s" : ""} · last ${escapeHtml(fmt(list[0].sentAt))}</span>
              <span class="eif-hd-status">${statusSummary(items, waitingCount) || "not checked yet"}</span>
            </span>
            <span class="eif-hd-chev" aria-hidden="true">›</span>
          </button>
          ${open ? `
          <div class="eif-hd-body">
            <div class="eif-hd-tools">
              <button class="eif-hunt-btn" type="button" data-action="hist-check-design" ${historyChecking ? "disabled" : ""}>Check this design</button>
              ${histFilter !== "archived" && doneReports ? `<button class="eif-hunt-btn" type="button" data-action="hist-archive-done" title="Archive the reports where every listing is gone">Archive finished reports (${doneReports})</button>` : ""}
            </div>
            ${list.map(reportCard).join("")}
          </div>` : ""}
        </section>`;
      })
      .join("");

    const chip = (id, label) => `<button type="button" class="${histFilter === id ? "eif-src-on" : ""}" data-action="hist-filter" data-filter="${id}" ${!counts[id] && id !== "all" ? "disabled" : ""}>${label} <span class="eif-src-n">${counts[id]}</span></button>`;
    view.innerHTML = `
      <div class="eif-list-head">
        <div>
          <div class="eif-list-title">${activeReports.length} report${activeReports.length === 1 ? "" : "s"} sent · ${all.length} listings</div>
          <div class="eif-list-sub">${count("removed")} removed · ${count("ended")} ended · ${count("live")} still live · ${all.filter((it) => !it.status).length} not checked <span id="eif-hist-progress"></span></div>
        </div>
        <div class="eif-list-actions">
          <button class="eif-hunt-btn eif-hunt-btn-primary" type="button" data-action="hist-check-all" ${historyChecking ? "disabled" : ""}>Check all statuses</button>
        </div>
      </div>
      <div class="eif-hist-bar">
        <div class="eif-hist-filters" role="tablist" aria-label="Show">${chip("all", "All")}${chip("amazon", "Amazon")}${chip("ebay", "eBay")}${chip("archived", "Archived")}</div>
        <input id="eif-hist-search" type="search" placeholder="Search a design, ASIN or item number" value="${escapeHtml(histQuery)}" autocomplete="off" />
      </div>
      <div class="eif-scroll"><div class="eif-list">${designRows || `<div class="eif-center"><div class="eif-empty-sub">${histQuery ? "Nothing matches that search." : histFilter === "archived" ? "No archived reports." : "No reports here."}</div></div>`}</div></div>`;
    const sc = view.querySelector(".eif-scroll");
    if (sc) sc.scrollTop = scrollTop;
    if (searchFocused) {
      const input = view.querySelector("#eif-hist-search");
      input.focus();
      try { input.setSelectionRange(caret, caret); } catch (e) {}
    }
  }

  function histReportOf(target) {
    const el = target.closest("[data-report-id]");
    return el ? reportHistory.find((x) => x.id === el.dataset.reportId) : null;
  }

  function deleteHistoryReport(rec) {
    const waiting = rec.site === "amazon" && azReportLocks([rec]).size;
    const msg = waiting
      ? `Delete "${rec.name || "this report"}"?\n\nAmazon is still reviewing it. Deleting it also lifts the 5-day lock, so these ${rec.items.length} listings could be tracked and reported again, which Amazon asks you not to do.\n\nArchive it instead if you just want it out of the way.`
      : `Delete "${rec.name || "this report"}" for good? This can't be undone. Archive it instead if you just want it out of the way.`;
    if (!window.confirm(msg)) return;
    reportHistory = reportHistory.filter((x) => x !== rec);
    saveHistory();
    updateTabCounts();
    renderReportedView();
    showToast("Report deleted");
  }

  function reReport(reportId) {
    const r = reportHistory.find((x) => x.id === reportId);
    if (!r) return;
    if (r.site === "amazon") {
      if (azReportLocks([r]).size) return showToast("Still waiting on Amazon for this report. Use \"Amazon replied\" once they answer, or wait 5 days.");
      const liveAz = r.items.filter((it) => it.status === "live").map((it) => it.n);
      liveAz.forEach((a) => {
        const m = amazonTracked.get(a);
        if (m) m.reportedAt = "";
        else amazonTracked.set(a, { title: "", brand: "", price: "", image: (r.items.find((it) => it.n === a) || {}).image || "", url: AZ.productUrl(r.marketplace || "US", a), addedAt: today(), reportedAt: "", marketplace: r.marketplace || "US" });
      });
      saveAmazon();
      azSelection = new Set(liveAz);
      reportSite = "amazon";
      switchTab("report");
      return;
    }
    const live = r.items.filter((it) => it.status === "live").map((it) => it.n);
    live.forEach((n) => {
      const meta = trackedItems.get(n);
      if (meta) meta.reportedAt = "";
      else trackedItems.set(n, { title: "Untitled listing", url: `https://www.ebay.com/itm/${n}`, image: (r.items.find((it) => it.n === n) || {}).image || "", source: r.source, kind: "copycat", reportedAt: "" });
    });
    saveTrackedItems();
    reportSelection = new Set(live);
    reportSite = "ebay";
    switchTab("report");
  }

  function activeTracked() {
    return [...trackedItems.entries()].filter(([, meta]) => !meta.reportedAt);
  }

  const onlineRetries = new Map();

  function retryWhenOnline(key, fn) {
    onlineRetries.set(key, fn);
  }

  function runOnlineRetries() {
    const fns = [...onlineRetries.values()];
    onlineRetries.clear();
    fns.forEach((fn) => {
      try {
        fn();
      } catch (e) {
      }
    });
  }

  async function isConnectionProblem(err) {
    if (err?.code === "EBAY_PAUSED") return false;
    if (navigator.onLine === false) return true;
    const msg = String((err && err.message) || err || "");
    if (!(err instanceof TypeError) && !/failed to fetch|networkerror|network request failed|load failed/i.test(msg)) return false;
    return false;
  }

  const WIFI_OFF = `
    <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <path d="M2 8.5a15 15 0 0 1 4.5-2.8M9.5 4.9A15 15 0 0 1 22 8.5"/>
      <path d="M5 12a10 10 0 0 1 3.4-2.2M13.5 9.6A10 10 0 0 1 19 12"/>
      <path d="M8.5 15.5a5 5 0 0 1 7 0"/>
      <circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none"/>
      <line x1="3" y1="3" x2="21" y2="21"/>
    </svg>`;

  function offlineHtml(what) {
    return `
      <div class="eif-center eif-offline-view">
        <div class="eif-offline-icon">${WIFI_OFF}</div>
        <div class="eif-empty-title">No internet connection</div>
        <div class="eif-empty-sub">${escapeHtml(what)} stopped because the connection dropped. It picks up where it stopped as soon as you're back online.</div>
        <button class="eif-hunt-btn eif-hunt-btn-primary" type="button" data-action="net-retry">Try again now</button>
      </div>`;
  }

  function setupConnectionWatch() {
    const html = document.documentElement;
    if (navigator.onLine === false) html.classList.add("eif-is-offline");
    window.addEventListener("offline", () => html.classList.add("eif-is-offline"));
    window.addEventListener("online", () => {
      html.classList.remove("eif-is-offline");
      if (onlineRetries.size) showToast("Back online. Picking up where it stopped…");
      runOnlineRetries();
    });
  }

  const itemDetails = new Map();

  function parseRevisions(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const rows = [];
    doc.querySelectorAll("table tr").forEach((tr) => {
      const cells = [...tr.querySelectorAll("td")];
      if (cells.length < 3) return;
      const whatCell = cells[2];
      let parts = [...whatCell.querySelectorAll("*")].filter((e) => !e.children.length).map((e) => e.textContent.replace(/\s+/g, " ").trim()).filter(Boolean);
      if (!parts.length) parts = [whatCell.textContent.replace(/\s+/g, " ").trim()].filter(Boolean);
      const fields = parts.filter((t) => !/[.!]$/.test(t));
      const notes = parts.filter((t) => /[.!]$/.test(t));
      rows.push({
        date: cells[0].textContent.replace(/\s+/g, " ").trim(),
        time: cells[1].textContent.replace(/\s+/g, " ").trim(),
        fields,
        notes,
        what: parts.join(", "),
      });
    });
    return rows;
  }

  async function loadItemDetails(n) {
    const known = itemDetails.get(n);
    if (known && (known.state !== "error" || ebayRequestState?.paused)) return known;
    const entry = { state: "loading", listedAt: "", revisions: [] };
    itemDetails.set(n, entry);
    try {
      const [itm, rvh] = await Promise.all([
        ebayFetch(`${EBAY}/itm/${n}`, { credentials: "include" }),
        ebayFetch(`${EBAY}/rvh/${n}`, { credentials: "include" }),
      ]);
      if (!itm.ok || !rvh.ok) throw new Error("eBay listing details are unavailable.");
      if (itm.ok) entry.listedAt = parseListingDate(await itm.text());
      if (rvh.ok) entry.revisions = parseRevisions(await rvh.text());
      entry.state = "done";
    } catch (e) {
      entry.state = "error";
      entry.paused = e?.code === "EBAY_PAUSED";
      const hunt = lastSearch;
      retryAfterEbayPause(e, `detail-${n}`, async () => {
        itemDetails.delete(n);
        await loadItemDetails(n);
        if (popup?.tab === "report") renderReportView();
      }, () => lastSearch === hunt || trackedItems.has(n));
      if (await isConnectionProblem(e)) entry.offline = true;
    }
    return entry;
  }

  function daysAgo(iso) {
    const t = Date.parse(iso + "T00:00:00Z");
    if (isNaN(t)) return "";
    const days = Math.max(0, Math.round((Date.now() - t) / 86400000));
    if (days < 1) return "today";
    if (days < 60) return `${days} day${days === 1 ? "" : "s"} ago`;
    const months = Math.round(days / 30.4);
    if (months < 24) return `${months} months ago`;
    return `${Math.floor(days / 365)} years ago`;
  }

  const VARIATION_RE = /(Buy It Now Price|Quantity|Price) for (.*?)(?=, (?:Buy It Now Price|Quantity|Price) for |:|$)/g;
  function shortRevision(text, max = 160) {
    let t = String(text || "").replace(/\s+/g, " ").trim();
    const cut = t.indexOf(": ");
    let fields = cut >= 0 ? t.slice(0, cut) : t;
    let notes = cut >= 0 ? t.slice(cut + 2) : "";
    const names = new Set();
    const kinds = new Set();
    let hits = 0;
    fields.replace(VARIATION_RE, (m, kind, name) => { hits++; names.add(name.trim()); kinds.add(/quantity/i.test(kind) ? "quantities" : "prices"); return m; });
    if (hits > 2) {
      const rest = fields.replace(VARIATION_RE, "").split(",").map((x) => x.trim()).filter(Boolean);
      const what = ["prices", "quantities"].filter((k) => kinds.has(k)).join(" and ");
      fields = [`${what.charAt(0).toUpperCase()}${what.slice(1)} (${names.size} variation${names.size === 1 ? "" : "s"})`, ...new Set(rest)].join(", ");
    }
    const seen = new Set();
    notes = notes.replace(/(The seller [^.]*\.)\s*/g, (m, sentence) => (seen.has(sentence) ? "" : (seen.add(sentence), m))).trim();
    t = notes ? `${fields}: ${notes}` : fields;
    if (t.length > max) t = `${t.slice(0, max).replace(/[\s,;:]+\S*$/, "")}…`;
    return t;
  }

  function peekHtml(item, index) {
    const det = itemDetails.get(item.itemNumber);
    const loading = !det || det.state === "loading";
    const sk = (w) => `<span class="eif-sk" style="width:${w}px"></span>`;
    const listed = det && det.listedAt ? `${escapeHtml(niceDate(det.listedAt))} <span class="eif-pk-dim">· ${escapeHtml(daysAgo(det.listedAt))}</span>` : loading ? sk(130) : '<span class="eif-pk-dim">Not shown by eBay</span>';
    const revs = det && det.revisions ? det.revisions : [];
    const revLine = loading
      ? sk(170)
      : det.state === "error"
        ? `<span class="eif-pk-dim">${det.paused ? "eBay check needed" : det.offline ? "Offline" : "Couldn't load"}</span>`
        : revs.length
          ? `${revs.length} <span class="eif-pk-dim">· last ${escapeHtml(revs[0].date)}</span>`
          : '0 <span class="eif-pk-dim">· never edited</span>';
    const SHOWN = 5;
    const revText = (r) => {
      const f = (r.fields || []).join(", ");
      const nt = (r.notes || []).join(" ");
      return shortRevision(f && nt ? `${f}: ${nt}` : f || nt || r.what || "");
    };
    const changes = !loading && revs.length
      ? `<div class="eif-pk-change"><span>${revs.length === 1 ? "Change" : `Changes (${revs.length})`}</span><ol class="eif-pk-revs">${revs
          .slice(0, SHOWN)
          .map((r) => `<li><em>${escapeHtml(r.date.replace(/,\s*\d{4}$/, ""))}</em>${escapeHtml(revText(r))}</li>`)
          .join("")}</ol>${revs.length > SHOWN ? `<div class="eif-pk-dim">+${revs.length - SHOWN} earlier change${revs.length - SHOWN === 1 ? "" : "s"}</div>` : ""}</div>`
      : "";
    const isSearched = lastSearch && lastSearch.itemNumber === item.itemNumber;
    const isMine = isSearched && searchIsMine(lastSearch);
    return `
      <div class="eif-pk-head">
        <span class="eif-pk-label">${isMine ? "Your listing" : isSearched ? "Searched listing" : "Listing info"}</span>
        <span class="eif-pk-num">#${item.itemNumber}</span>
      </div>
      <div class="eif-pk-title">${escapeHtml(item.title || "Untitled listing")}</div>
      <div class="eif-pk-stats">
        <div><span>Price</span><b>${escapeHtml(item.price || "—")}</b>${item.wasPrice ? `<s class="eif-pk-was">${escapeHtml(item.wasPrice)}</s>` : ""}</div>
        <div class="eif-pk-textstat" title="${escapeHtml(sellerName(item.seller) || "")}"><span>Seller</span><b>${escapeHtml(sellerName(item.seller) || "—")}</b></div>
        <div title="No match score for eBay yet"><span>Match <i class="eif-pk-demo">beta</i></span><b class="eif-pk-match eif-pk-match-none">—</b></div>${scorePeekRow(`ebay:${item.itemNumber}`)}
      </div>
      <div class="eif-pk-rows">
        <div><span>Listed on</span><b>${listed}</b></div>
        <div><span>Revisions</span><b>${revLine}</b></div>
        ${item.shipping ? `<div><span>Shipping</span><b>${escapeHtml(item.shipping)}</b></div>` : ""}
      </div>
      ${changes}`;
  }

  function setupPeek(overlay, modal) {
    const peek = document.createElement("div");
    peek.id = "eif-peek";
    peek.setAttribute("aria-hidden", "true");
    modal.appendChild(peek);
    let current = null;
    let showTimer = 0;
    let loadTimer = 0;

    const place = (card) => {
      const m = modal.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      const width = Math.min(460, m.width - 24);
      const roomRight = m.right - c.right;
      const left = roomRight >= width + 12 ? c.right - m.left - 4 : c.left - m.left - width + 4;
      const side = roomRight >= width + 12 ? "right" : "left";
      const minHeight = Math.max(c.height, 200);
      peek.style.width = `${width}px`;
      peek.style.minHeight = `${minHeight}px`;
      peek.style.maxHeight = `${Math.max(200, m.height - 16)}px`;
      const height = Math.min(Math.max(minHeight, peek.offsetHeight), m.height - 16);
      let top = c.top - m.top;
      top = Math.max(8, Math.min(top, m.height - height - 8));
      peek.style.left = `${Math.round(left)}px`;
      peek.style.top = `${Math.round(top)}px`;
      peek.dataset.side = side;
    };

    const render = () => {
      if (!current || !lastSearch) return;
      if (current.dataset.asin) {
        const list = (lastSearch.amazon && lastSearch.amazon.items) || [];
        const i = list.findIndex((x) => x.asin === current.dataset.asin);
        if (i >= 0) {
          peek.innerHTML = amazonPeekHtml(list[i], i);
          if (peek._markedFor !== current.dataset.asin) { peek._markedFor = current.dataset.asin; M.mark(peek.querySelectorAll(".eif-pk-w")); }
        }
        return;
      }
      const n = current.dataset.itemNumber;
      const index = lastSearch.items.findIndex((i) => i.itemNumber === n);
      if (index < 0) return;
      peek.innerHTML = peekHtml(lastSearch.items[index], index);
    };

    const show = (card) => {
      if (current && current !== card) current.classList.remove("eif-hc-peeking");
      current = card;
      card.classList.add("eif-hc-peeking");
      render();
      place(card);
      peek.classList.add("eif-peek-on");
      clearTimeout(loadTimer);
      const n = card.dataset.itemNumber;
      if (!n) {
        const asin = card.dataset.asin;
        const d = asin && amazonDetails.get(dkey(asin));
        if (asin && (!d || d.state === "error")) {
          loadTimer = setTimeout(async () => {
            const p = loadAmazonDetails(asin);
            render();
            await p;
            if (current && current.dataset.asin === asin) {
              render();
              place(current);
            }
          }, 220);
        }
        return;
      }
      if (!itemDetails.has(n) || itemDetails.get(n).state === "error") {
        loadTimer = setTimeout(async () => {
          await loadItemDetails(n);
          if (current && current.dataset.itemNumber === n) {
            render();
            place(current);
          }
        }, 220);
      }
    };

    const hide = () => {
      clearTimeout(showTimer);
      clearTimeout(loadTimer);
      peek.classList.remove("eif-peek-on");
      if (current) current.classList.remove("eif-hc-peeking");
      current = null;
    };

    overlay.addEventListener("mouseover", (e) => {
      const card = e.target.closest && e.target.closest("#eif-hunt-grid .eif-hc");
      if (!card) return;
      if (card === current) return;
      clearTimeout(showTimer);
      if (peek.classList.contains("eif-peek-on")) show(card);
      else if (prefs.hoverPanel) showTimer = setTimeout(() => show(card), 160);
    });
    overlay.addEventListener("mouseout", (e) => {
      const grid = e.target.closest && e.target.closest("#eif-hunt-grid");
      if (!grid) return;
      if (!e.relatedTarget || !grid.contains(e.relatedTarget)) hide();
    });
    overlay.addEventListener("scroll", hide, true);
    overlay.addEventListener("click", hide);
  }

  function ebayUserName() {
    if (SITE === "amazon") {
      const line = document.querySelector("#nav-link-accountList-nav-line-1");
      const name = line ? line.textContent.replace(/\s+/g, " ").trim().replace(/^Hello,?\s*/i, "") : "";
      return name && !/^sign in$/i.test(name) ? name : null;
    }
    const greet = document.querySelector(".gh-identity__greeting");
    if (greet) {
      const name = greet.textContent.replace(/\s+/g, " ").trim().replace(/^Hi\s*/i, "").replace(/!\s*$/, "").trim();
      if (name) return name;
    }
    const header = document.querySelector("#gh, header, [class*='gh-header']");
    const text = header ? header.textContent.replace(/\s+/g, " ").slice(0, 3000) : "";
    const m = text.match(/Hi\s+([^!<>]{1,40})!/);
    return m ? m[1].trim() : null;
  }

  function signedInState() {
    if (SITE === "amazon") return merchMetaLoaded ? merchConnected() : null;
    if (ebayUserName()) return true;
    if (SITE !== "ebay") return null;
    if (ebaySessionState === true) return true;
    const signIn = [...document.querySelectorAll("a[href*='signin.ebay']")].find((a) =>
      /^\s*sign\s*in\s*$/i.test(a.textContent)
    );
    if (signIn) return false;
    return null;
  }

  function signInUrl() {
    return `https://signin.ebay.com/ws/eBayISAPI.dll?SignIn&ru=${encodeURIComponent(location.href)}`;
  }
  function ebaySignInUrl() {
    return SITE === "ebay" ? signInUrl() : `https://signin.ebay.com/ws/eBayISAPI.dll?SignIn&ru=${encodeURIComponent("https://www.ebay.com/")}`;
  }

  function signInGateHtml() {
    if (SITE === "amazon") {
      if (merchGate.state === "idle") setTimeout(merchGateCheck, 0);
      return `
      <div class="eif-center eif-empty-plain">
        <div class="eif-empty-icon">${ICON}</div>
        <div class="eif-empty-title">Connect your Merch account first</div>
        <div class="eif-empty-sub">On Amazon, Copycat Hunt works with your Merch on Demand account. It reads your own listing list once, so it can tell your designs apart from copies. Your password stays with Amazon.</div>
        <div class="eif-merch-gate" data-merch-gate>${merchGateInner()}</div>
      </div>`;
    }
    return `
      <div class="eif-center eif-empty-plain">
        <div class="eif-empty-icon">${ICON}</div>
        <div class="eif-empty-title">Sign in to eBay first</div>
        <div class="eif-empty-sub">Copycat Hunt works with your eBay account. It uses it to recognise your own listings and to send reports. Your password stays with eBay.</div>
        <a class="eif-hunt-btn eif-hunt-btn-primary" href="${safeHref(signInUrl())}">Sign in to eBay</a>
      </div>`;
  }

  let merchGate = { state: "idle" };

  async function merchGateCheck() {
    if (merchGate.state === "checking" || merchGate.state === "syncing") return;
    merchGate = { state: "checking" };
    renderMerchGate();
    const st = await bgSend({ type: "eif-merch-status" });
    if (merchGate.state !== "checking") return;
    if (!st || !st.ok) merchGate = { state: "failed", reason: "no_reply" };
    else if (st.identity.state === "verified") {
      merchGate = { state: "signed_in", account: st.identity.account };
      return autoConnectMerch();
    }
    else if (st.identity.state === "logged_out") merchGate = { state: "signed_out" };
    else merchGate = { state: "failed", reason: st.identity.reason || st.identity.state };
    renderMerchGate();
  }

  async function merchGateSync() {
    merchGate = { state: "syncing", account: merchGate.account };
    renderMerchGate();
    const res = await bgSend({ type: "eif-merch-sync" });
    if (res && res.ok && res.catalog?.sameAccount) {
      merchGate = { state: "idle" };
      loadMerchMeta(() => onMerchUnlocked(res.catalog.count));
      return;
    }
    const reason = res?.meta?.lastError || res?.identity?.reason || "no_reply";
    merchGate = reason === "signed_out" || reason === "logged_out" ? { state: "signed_out" } : { state: "failed", reason, account: merchGate.account };
    renderMerchGate();
  }

  function merchProgressText() {
    const m = merchMeta || {};
    if (!m.rawScanned) return "Syncing your Merch catalog… Big catalogs can take a few minutes.";
    const total = m.expectedTotal ? ` of ${Number(m.expectedTotal).toLocaleString("en-US")}` : "";
    return `Syncing your Merch catalog: ${Number(m.rawScanned).toLocaleString("en-US")}${total} records read. You can close this; it continues where it stopped.`;
  }

  function merchGateInner() {
    const g = merchGate;
    const signInLink = `<a class="eif-hunt-btn eif-hunt-btn-primary" href="https://merch.amazon.com/dashboard" target="_blank" rel="noopener" data-gate="signin">Sign in to Merch</a>`;
    if (g.state === "idle" || g.state === "checking") return '<div class="eif-merch-gate-line">Checking if you\'re signed in to Merch…</div>';
    if (g.state === "signed_in")
      return `<div class="eif-merch-gate-line">✓ You're signed in to Merch${g.account ? ` (account ${escapeHtml(g.account)})` : ""}.</div>
        <button class="eif-hunt-btn eif-hunt-btn-primary" type="button" data-gate="sync">Sync my Merch catalog</button>`;
    if (g.state === "syncing") return `<div class="eif-merch-gate-line">${LOADER()}${escapeHtml(merchProgressText())}</div>
        <button class="eif-hunt-btn" type="button" data-gate="setup">Open the setup page</button>`;
    if (g.state === "signed_out")
      return `<div class="eif-merch-gate-line">You're not signed in to Merch in this browser. Sign in, then come back here.</div>
        ${signInLink}
        <button class="eif-hunt-btn" type="button" data-gate="recheck">I've signed in, check again</button>`;
    return `<div class="eif-merch-gate-line eif-rp-warn">${escapeHtml(merchReasonText(g.reason))}</div>
      <button class="eif-hunt-btn eif-hunt-btn-primary" type="button" data-gate="${g.account ? "sync" : "recheck"}">Try again</button>
      ${g.account ? "" : signInLink}`;
  }

  function renderMerchGate() {
    document.querySelectorAll("[data-merch-gate]").forEach((el) => (el.innerHTML = merchGateInner()));
    if (mini && mini.el) placeMini(mini.el);
  }

  let merchUnlockAnnounced = false;
  function onMerchUnlocked(count) {
    if (merchUnlockAnnounced) return;
    merchUnlockAnnounced = true;
    showToast(`Merch catalog synced: ${count} listing${count === 1 ? "" : "s"}. You're all set.`);
    refreshWidgetSub();
    if (mini) {
      closeMini();
      openMini();
    }
    if (popup) switchTab(popup.tab);
  }

  function refreshWidgetSub() {
    const sub = widget && widget.querySelector(".eif-hunt-sub");
    if (sub) sub.textContent = signedInState() === false ? (SITE === "amazon" ? "Connect Merch to start" : "Sign in to start") : "Drop your listing image";
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-gate]");
    if (!b || !b.closest("[data-merch-gate]")) return;
    const act = b.dataset.gate;
    if (act === "sync") {
      e.preventDefault();
      merchGateSync();
    } else if (act === "recheck") {
      e.preventDefault();
      merchGate = { state: "idle" };
      merchGateCheck();
    } else if (act === "signin") {
      merchGate = { state: "signed_out", waiting: true };
    } else if (act === "setup") {
      e.preventDefault();
      bgSend({ type: "eif-merch-open-setup" });
    }
  });

  function requireSignIn() {
    if (signedInState() !== false) return true;
    openPopup("results");
    return false;
  }

  function detectOwnListing() {
    if (!prefs.detectOwn) return;
    const itemNumber = currentPageItemNumber();
    if (!itemNumber || isMineEbay(itemNumber)) return;
    const main = document.querySelector("#mainContent, main") || document.body;
    if (!pageSaysYourItem(main.innerText || "")) return;
    protectedItems.add(itemNumber);
    setMineNote(`ebay:${itemNumber}`, { reason: "ebay_said", label: "", at: today() });
    if (trackedItems.delete(itemNumber)) saveTrackedItems();
    saveProtectedItems();
    syncBadgeProtection(itemNumber);
    updatePanel();
    const pageTitle = ((document.querySelector("h1.x-item-title__mainTitle") || {}).textContent || "").replace(/\s+/g, " ").trim();
    const pageImage = (document.querySelector('meta[property="og:image"]') || {}).content || "";
    const pageDate = parseListingDate(document.documentElement.innerHTML);
    const prev = originals[itemNumber] || {};
    originals[itemNumber] = {
      ...prev,
      platform: prev.platform || "eBay",
      item: itemNumber,
      verified: true,
      title: prev.title || pageTitle,
      image: prev.image || pageImage,
      published: prev.published || pageDate,
      dateFromEbay: prev.dateFromEbay || (!prev.published && !!pageDate),
    };
    saveOriginals();
    showToast("This is your listing. Added to My listings.");
  }

  let popup = null;

  let merchConnecting = false;
  let merchLastEnsureAt = 0;
  async function autoConnectMerch() {
    if (merchConnecting || navigator.onLine === false || Date.now() - merchLastEnsureAt < 10000) return;
    merchConnecting = true;
    merchLastEnsureAt = Date.now();
    merchGate = { state: "checking" };
    renderMerchGate();
    try {
      const st = await bgSend({ type: "eif-merch-ensure" });
      merchStatus = st;
      if (st?.ok && st.catalog?.sameAccount) {
        merchGate = { state: "idle" };
        for (const [key, result] of merchResults) if (result.state === "unknown") merchResults.delete(key);
        loadMerchMeta(() => { onMerchUnlocked(st.catalog.count); azScheduleRender(); });
        if (popup?.tab === "results" && lastSearch?.view === "amazon") {
          merchLookupAsins([lastSearch.asin, ...(lastSearch.amazon?.items || []).map((item) => item.asin)]);
          refreshAmazonCards();
        }
      } else {
        const reason = st?.meta?.lastError || st?.identity?.reason || st?.identity?.state || "no_reply";
        merchGate = st?.identity?.state === "logged_out" ? { state: "signed_out" } : { state: "failed", reason, account: st?.identity?.account };
        renderMerchGate();
        azScheduleRender();
      }
    } finally { merchConnecting = false; }
  }

  function refreshConnections() {
    if (SITE === "amazon" && prefs.autoMerchSync) autoConnectMerch();
    recoverEbay();
    refreshWidgetSub();
    if (SITE === "ebay" && popup && signedInState() !== false) switchTab(popup.tab);
  }
  window.addEventListener("focus", refreshConnections);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshConnections(); });

  function updateSafeBottom() {
    let gap = 0;
    try {
      const freeBottom = (screen.availTop || 0) + screen.availHeight;
      const winBottom = window.screenY + window.outerHeight;
      gap = winBottom - freeBottom;
      if (gap <= 12 && freeBottom >= screen.height - 2 && winBottom >= screen.height - 2) gap = 48;
      const zoom = window.outerWidth > 0 ? window.innerWidth / window.outerWidth : 1;
      gap *= Math.abs(zoom - 1) < 0.06 ? 1 : Math.min(4, Math.max(0.25, zoom));
    } catch (e) {}
    gap = gap > 12 ? Math.min(240, Math.round(gap)) : 0;
    document.documentElement.style.setProperty("--eif-safe-bottom", `${gap}px`);
    return gap;
  }
  let safeBottomTimer = 0;
  window.addEventListener("resize", () => { clearTimeout(safeBottomTimer); safeBottomTimer = setTimeout(updateSafeBottom, 150); });
  updateSafeBottom();

  function openPopup(tab = "results") {
    if (!licOk) { lockDismissed = false; showLockCard(); return; }
    updateSafeBottom();
    closeMini();
    if (pendingReported) {
      pendingReported = false;
      tab = "reported";
    }
    if (!popup) buildPopup();
    switchTab(tab);
    refreshConnections();
  }

  function watchMotion(overlay) {
    if (!M.enabled || typeof MutationObserver !== "function") return;
    let queued = false;
    const sweep = () => {
      queued = false;
      overlay.querySelectorAll(".eif-loader svg").forEach((svg) => {
        if (!svg._eifAnim) svg._eifAnim = M.claws(svg, { loop: true }) || true;
      });
      const s = lastSearch;
      if (!s || !popup || popup.tab !== "results") return;
      if (s.state === "done" && !s._entered) {
        const cards = overlay.querySelectorAll(".eif-hc:not(.eif-hc-amz)");
        if (cards.length) { s._entered = true; M.enterMany(cards); }
      }
      const a = s.amazon;
      if (a && a.state === "done" && !a._entered) {
        const cards = overlay.querySelectorAll(".eif-hc-amz");
        if (cards.length) { a._entered = true; M.enterMany(cards); }
      }
    };
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(sweep);
    }).observe(overlay, { childList: true, subtree: true });
    sweep();
    const crawl = setInterval(() => {
      if (!overlay.isConnected) { clearInterval(crawl); return; }
      overlay.querySelectorAll(".eif-progress-card").forEach((card) => {
        if (!card.offsetParent) return;
        if (!card._eifSeenAt) card._eifSeenAt = Number(card.dataset.since) || Date.now();
        if (card._eifSpiders || Date.now() - card._eifSeenAt < 8000) return;
        M.spiders(card);
        if (card._eifSpiders && !card.querySelector(".eif-crawl-note")) {
          const note = document.createElement("div");
          note.className = "eif-crawl-note";
          note.textContent = "Lots of listings to go through. Our crawlers are on it…";
          card.appendChild(note);
          M.enter(note);
        }
      });
    }, 1000);
  }

  function buildPopup() {
    const overlay = document.createElement("div");
    overlay.id = "eif-hunt-overlay";
    overlay.innerHTML = `
      <div id="eif-hunt-modal" role="dialog" aria-modal="true" aria-label="Copycat Hunt">
        <div id="eif-hunt-top">
          <div class="eif-brand"><span class="eif-brand-icon">${LOGO}</span><span>Copycat Hunt</span></div>
          <div id="eif-tabs" role="tablist">
            <div class="eif-find" role="group" aria-label="Find">
              <button type="button" role="tab" data-tab="results" title="Listings that look like your design. Check them and mark the copies">Look-alikes <span class="eif-tab-count" data-count="results"></span></button>
              <button type="button" role="tab" data-tab="hijacks" title="Listings that copy your title or photos">Hijacks <span class="eif-tab-count" data-count="hijacks"></span></button>
            </div>
            <span class="eif-tab-step" aria-hidden="true">›</span>
            <button type="button" role="tab" data-tab="tracked" title="Look-alikes you marked as copies, ready to report">Copycats <span class="eif-tab-count" data-count="tracked"></span></button>
            <span class="eif-tab-step" aria-hidden="true">›</span>
            <button type="button" role="tab" data-tab="report" title="Fill the eBay or Amazon report form">Report</button>
            <span class="eif-tab-step" aria-hidden="true">›</span>
            <button type="button" role="tab" data-tab="reported" title="Reports you sent and what happened to the listings">Reported <span class="eif-tab-count" data-count="reported"></span></button>
            <span class="eif-tab-gap" aria-hidden="true"></span>
            <button type="button" role="tab" data-tab="bestsellers" title="Your designs that sell the most. Hunt their copies first">Best sellers</button>
            <button type="button" role="tab" data-tab="mine" title="Your own eBay listings, never marked as copycats">My listings <span class="eif-tab-count" data-count="mine"></span></button>
          </div>
          <button id="eif-theme-toggle" type="button" role="switch"><span class="eif-tt eif-tt-s" aria-hidden="true"></span><span class="eif-tt eif-tt-m" aria-hidden="true"></span></button>
          <input id="eif-popup-file" type="file" accept="image/*" hidden />
        </div>
        <div id="eif-ebay-pause" hidden role="status">
          <span data-ebay-pause-message></span>
          <a href="https://www.ebay.com/" target="_blank" rel="noopener">Open eBay</a>
          <button class="eif-hunt-btn" type="button" data-action="ebay-resume">Resume</button>
        </div>
        <button id="eif-maint" type="button" data-action="maint-open" hidden></button>
        <div id="eif-offline-banner">${WIFI_OFF}<span>You're offline. Copycat Hunt will continue when the connection is back.</span></div>
        <div id="eif-view"></div>
        <div id="eif-drop-cover"><div>${ICON}<span>Drop to search for copies of this image</span></div></div>
      </div>`;
    document.body.appendChild(overlay);
    watchMotion(overlay);
    paintMaintenance(overlay);

    const modal = overlay.querySelector("#eif-hunt-modal");
    const fileInput = overlay.querySelector("#eif-popup-file");

    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) closePopup();
    });
    const themeBtn = overlay.querySelector("#eif-theme-toggle");
    const paintThemeBtn = () => {
      const light = !!(self.EifTheme && EifTheme.isLight());
      themeBtn.setAttribute("aria-checked", String(light));
      themeBtn.setAttribute("aria-label", "Light mode");
      themeBtn.title = light ? "Switch to dark mode" : "Switch to light mode";
    };
    themeBtn.addEventListener("click", () => { if (self.EifTheme) EifTheme.save(EifTheme.isLight() ? "dark" : "light"); });
    if (self.EifTheme) EifTheme.onChange(paintThemeBtn);
    paintThemeBtn();
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (file) startSearch({ file, imageUrl: null, itemNumber: null });
    });
    overlay.querySelectorAll("#eif-tabs [data-tab]").forEach((button) =>
      button.addEventListener("click", () => {
        if (button.dataset.tab === "report" && popup && popup.tab !== "report" && !reportHasWork()) {
          showToast('Nothing to report yet. Mark copies first with "Copycat" in Look-alikes or Hijacks.');
          return;
        }
        switchTab(button.dataset.tab);
      })
    );

    overlay.addEventListener("click", (e) => {
      if (!e.target.closest(".eif-hist-menu")) overlay.querySelectorAll(".eif-hist-menu.eif-open").forEach((m) => m.classList.remove("eif-open"));
      const trRow = popup && popup.tab === "tracked" && e.target.closest && e.target.closest(".eif-tr-list .eif-tr-row");
      if (trRow && !e.target.closest("a, button, input, label, select, textarea")) {
        const cb = trRow.querySelector(".eif-tr-check, .eif-amz-check");
        if (cb) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return;
      }
      const target = e.target.closest("[data-action]");
      if (!target || !overlay.contains(target)) return;
      const action = target.dataset.action;
      const itemNumber = target.dataset.itemNumber || (target.closest("[data-item-number]") || {}).dataset?.itemNumber;
      if (action === "ebay-resume") {
        target.disabled = true;
        recoverEbay(true).finally(() => { target.disabled = false; });
        return;
      }
      if (action === "net-retry") {
        if (navigator.onLine === false) showToast("Still offline. Check your connection.");
        else runOnlineRetries();
        return;
      }
      if (action.startsWith("rp-")) handleReportClick(action, target);
      else if (action.startsWith("az-") && action !== "az-go") handleAzClick(action, target);
      else if (action === "report-selected") {
        const list = [...overlay.querySelectorAll(".eif-tr-check:checked")].map((c) => c.dataset.itemNumber);
        reportSelection = list.length ? new Set(list) : null;
        reportSite = "ebay";
        switchTab("report");
      } else if (action === "upload") fileInput.click();
      else if (action === "track" && itemNumber) toggleTracked(itemNumber);
      else if ((action === "hj-track-sel" || action === "hj-track-exact") && lastHijack) {
        const list = action === "hj-track-sel"
          ? hijackSelected()
          : lastHijack.matches.filter((m) => m.level === 3).map((m) => m.itemNumber);
        const added = trackMany(list);
        showToast(added ? `${added} listing${added === 1 ? "" : "s"} marked as copycat${added === 1 ? "" : "s"}` : "Those are already copycats");
        refreshHijackRows();
      } else if (action === "hj-report" && lastHijack) {
        const ids = lastHijack.matches.map((m) => m.itemNumber).filter((n) => trackedItems.has(n) && !trackedItems.get(n).reportedAt);
        if (!ids.length) showToast('Mark the copies first ("Mark selected as copycats" or "Copycat"), then press Report');
        else {
          reportSelection = new Set(ids);
          reportSite = "ebay";
          switchTab("report");
        }
      }
      else if (action === "src" && lastSearch) {
        lastSearch.view = target.dataset.src === "amazon" ? "amazon" : "ebay";
        renderResultsView();
        updateTabCounts();
      } else if (action === "amz-track") toggleAmazonTracked(target.closest("[data-asin]").dataset.asin);
      else if (action === "amz-mine") {
        const asin = target.closest("[data-asin]").dataset.asin;
        if (amazonMine.has(asin)) {
          toggleAmazonMine(asin);
          if (popup && popup.tab === "mine") renderMineView();
        } else {
          askMine("amazon", asin).then((r) => {
            if (r === "marked" && !amazonMine.has(asin)) toggleAmazonMine(asin);
            if (r) { refreshAmazonCards(); if (popup && popup.tab === "mine") renderMineView(); }
          });
        }
      }
      else if (action === "amz-retry") retryAmazon();
      else if (action === "hunt-stop") stopHunt();
      else if (action === "amz-stop") stopAmazonSearch();
      else if (action === "ebay-stop") stopEbayRetry();
      else if (action === "hj-filter" && lastSearch) {
        const cat = target.dataset.cat || "";
        lastSearch.hjFilter = lastSearch.hjFilter === cat ? "" : cat;
        if (lastSearch.view !== "amazon") {
          lastSearch.view = "amazon";
          renderResultsView();
        } else {
          updateTextPill();
          refreshAmazonCards();
        }
      } else if (action === "tr-text") {
        trTextFilter = target.dataset.k || "";
        const list = overlay.querySelector(".eif-tr-list");
        if (list) list.dataset.filter = trTextFilter;
        overlay.querySelectorAll('[data-action="tr-text"]').forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.k || "") === trTextFilter)));
        overlay.querySelectorAll(".eif-tr-list .eif-amz-check:checked").forEach((c) => { if (!trRowShown(c.closest(".eif-tr-row"))) c.checked = false; });
        trSyncHeads();
      } else if (action === "hj-track-all") trackAllFlagged();
      else if (action === "hj-track-undo") undoTrackAll();
      else if (action === "hj-text-run" && lastSearch) {
        lastSearch.textCheckAsked = true;
        lastSearch.amazonText = null;
        maybeStartTextCheck(lastSearch);
        updateTextPill();
      } else if (action === "hj-retry" && lastSearch) {
        lastSearch.amazonText = null;
        lastSearch.hjFilter = "";
        maybeStartTextCheck(lastSearch);
        updateTextPill();
      }
      else if (action === "ebay-retry") retryEbay();
      else if (action === "ebay-open-tab") {
        target.disabled = true;
        target.textContent = "Opening eBay…";
        bgSend({ type: "eif-ebay-open-tab" }).then((r) => {
          if (r && r.ok) retryEbay();
          else {
            target.disabled = false;
            target.textContent = "Open eBay in a tab";
            showToast("eBay didn't finish loading. Open ebay.com in a tab, then press Try again.");
          }
        });
      }
      else if (action === "amz-untrack") {
        amazonTracked.delete(target.closest("[data-asin]").dataset.asin);
        saveAmazon();
        updatePanel();
        updateTabCounts();
        renderTrackedView();
      } else if (action === "amz-copy") {
        const list = amzActive();
        if (!list.length) showToast("No Amazon copycats");
        else copyList(list);
      } else if (action === "amz-copy-selected") {
        const list = amzSelected();
        if (!list.length) showToast("Nothing selected");
        else copyList(list);
      } else if (action === "amz-remove-selected") {
        const list = amzSelected();
        if (!list.length) showToast("Nothing selected");
        else if (list.length === 1 || window.confirm(`Take ${list.length} Amazon products off your copycats?`)) {
          amzRemove(list);
          showToast(`Removed ${list.length} Amazon product${list.length === 1 ? "" : "s"}`);
        }
      } else if (action === "amz-clear") {
        const list = amzActive();
        if (!list.length) return;
        if (!window.confirm(`Take all ${list.length} Amazon products off your copycats? Reported ones stay in the Reported tab.`)) return;
        amzRemove(list);
        showToast("Amazon list cleared");
      } else if (action === "az-go") {
        const picked = amzSelected().filter((a) => azTargets().includes(a));
        const shown = new Set([...overlay.querySelectorAll(".eif-tr-list .eif-amz-check")].filter((c) => trRowShown(c.closest(".eif-tr-row"))).map((c) => c.dataset.asin));
        const list = picked.length ? picked : amzActive().filter((a) => azTargets().includes(a) && (!trTextFilter || shown.has(a)));
        if (!list.length) return notReportableToast(amzSelected().length ? amzSelected() : amzActive()) || showToast("Nothing to report yet");
        azReportByReason(list);
      } else if (action === "tr-reason-go") {
        const h = target.dataset.hunt || "";
        const r = target.dataset.trReason || "";
        const inBox = amzActive().filter((a) => ((amazonTracked.get(a) || {}).hunt || "") === h && azReasonOf(amazonTracked.get(a)) === r);
        const list = inBox.filter((a) => azTargets().includes(a));
        if (!list.length) return notReportableToast(inBox) || showToast("Nothing to report yet");
        azReportByReason(list);
      }
      else if (action === "jump") jumpToMine();
      else if (action === "go-tab" && target.dataset.go) switchTab(target.dataset.go);
      else if (action === "report-search") {
        if (lastSearch && lastSearch.view === "amazon") {
          const asins = ((lastSearch.amazon && lastSearch.amazon.items) || [])
            .map((i) => i.asin)
            .filter((a) => amazonTracked.has(a) && !amazonTracked.get(a).reportedAt && !amazonMine.has(a) && !merchIsOwn(a) && a !== lastSearch.asin);
          if (!asins.length) {
            showToast('Mark the Amazon copies first with "Copycat", then press Report');
          } else {
            const h = lastSearch.hunt || "";
            const mine = asins.filter((a) => ((amazonTracked.get(a) || {}).hunt || "") === h);
            const pick = mine.length ? mine : asins;
            azReportByReason(pick);
          }
        } else {
          const ids = lastSearch ? lastSearch.items.map((i) => i.itemNumber).filter((n) => trackedItems.has(n)) : [];
          if (!ids.length) {
            showToast('Mark the copies first with "Copycat", then press Report');
          } else {
            reportSelection = new Set(ids);
            reportSite = "ebay";
            switchTab("report");
          }
        }
      }
      else if (action === "hunt-again" && lastSearch && lastSearch.again) startSearch(lastSearch.again);
      else if (action === "maint-open" && self.EifMessagesPage) self.EifMessagesPage.show(target.dataset.id || "");
      else if (action === "score-sort" && lastSearch && lastSearch.score) {
        lastSearch.score.sorted = !lastSearch.score.sorted;
        paintScores();
      } else if (action === "score-retry" && lastSearch) runScore(lastSearch);
      else if (action === "ebay-open-setup") bgSend({ type: "eif-merch-open-setup" });
      else if (action === "ebay-open-tab") bgSend({ type: "eif-ebay-open-tab" }).then(() => showToast("eBay opened in a new tab. Press Sync now when it has loaded."));
      else if (action === "ebay-sync-now") {
        bgSend({ type: "eif-ebay-sync" }).then((r) => {
          showToast(r && (r.state === "syncing" || r.state === "complete") ? "Syncing your eBay listings…" : r && r.error === "not_seller" ? "Syncing eBay listings is for sellers. Change your eBay answer on the setup page." : r && r.error ? ebayReasonText(r.error) : "Couldn't start the eBay sync. Try again.");
          ebaySync.status = null;
          ebaySync.asked = false;
          loadEbaySync();
        });
      } else if (action === "ebay-show-more") { ebaySync.shown += 200; renderMineView(); }
      else if (action === "bs-hunt") bsHunt(target.closest("[data-bs]"));
      else if (action === "bs-retry") { bs.retry = true; bs.data = null; loadBestSellers(); }
      else if (action === "bs-export") bsDownloadCsv();
      else if (action === "bs-copy") {
        const d = bs.data && bs.data.designs && bs.data.designs[Number(target.closest("[data-bs]").dataset.bs)];
        if (d) { copyToClipboard(d.asin); showToast(`Copied ${d.asin}`); }
      } else if (action === "bs-page") {
        bs.page = Math.max(0, bs.page + Number(target.dataset.go || 0));
        renderBestSellersView();
        const sc = viewEl() && viewEl().querySelector(".eif-scroll");
        if (sc) sc.scrollTop = 0;
        bsFillInfo();
      }
      else if (action === "more") loadMoreResults();
      else if (action === "protect-source" && lastSearch && lastSearch.itemNumber) {
        const src = lastSearch.itemNumber;
        const search = lastSearch;
        askMine("ebay", src).then((r) => {
        if (!r || lastSearch !== search) return;
        if (r === "recognised" || protectItem(src)) {
          let changed = false;
          for (const it of lastSearch.items) {
            if (it.itemNumber === src) continue;
            const d = discovered.get(it.itemNumber);
            if (d && !d.source) d.source = src;
            const t = trackedItems.get(it.itemNumber);
            if (t && !t.source) {
              t.source = src;
              changed = true;
            }
          }
          if (changed) saveTrackedItems();
          renderResultsView();
        }
        });
      }
      else if (action === "hj-check" && itemNumber) startHijackCheck(itemNumber);
      else if (action === "hj-site") {
        hijackSite = target.dataset.site === "amazon" ? "amazon" : "ebay";
        renderHijackView();
      } else if (action === "azhj-check") startAmazonHijackCheck(target.dataset.asin);
      else if (action === "azhj-check-input") {
        const v = (overlay.querySelector("#eif-azhj-input") || {}).value || "";
        startAmazonHijackCheck(AZ.asinFromUrl(v) || v);
      } else if (action === "azhj-new") {
        lastAzHijack = null;
        renderHijackView();
      } else if (action === "azhj-report") reportAzHijacks();
      else if (action === "azhj-track" && lastAzHijack) {
        const a = target.closest("[data-asin]").dataset.asin;
        const it = lastAzHijack.matches.find((m) => m.asin === a) || { asin: a };
        toggleAmazonTracked(a, { item: { asin: a, title: it.title, brand: it.brand, price: it.price, image: it.image }, hunt: `amz:${lastAzHijack.asin}`, result: it.result });
        renderHijackView();
      }
      else if (action === "hj-check-input") {
        const input = overlay.querySelector("#eif-hj-input");
        if (input) startHijackCheck(input.value);
      } else if (action === "hj-new") {
        lastHijack = null;
        renderHijackView();
        updateTabCounts();
      }
      else if (action === "untrack" && itemNumber) {
        trackedItems.delete(itemNumber);
        saveTrackedItems();
        syncBadgeProtection(itemNumber);
        updatePanel();
        refreshHuntCards();
      } else if (action === "unprotect" && itemNumber) unprotectItem(itemNumber);
      else if (action === "copy-selected") {
        const list = [...overlay.querySelectorAll(".eif-tr-check:checked")].map((c) => c.dataset.itemNumber);
        if (!list.length) showToast("Nothing selected");
        else copyList(list);
      } else if (action === "copy-all") {
        if (!activeTracked().length) showToast("No copycats yet");
        else copyList(activeTracked().map(([n]) => n));
      } else if (action === "remove-selected") {
        const list = [...overlay.querySelectorAll(".eif-tr-check:checked")].map((c) => c.dataset.itemNumber);
        if (!list.length) showToast("Nothing picked");
        else if (list.length === 1 || window.confirm(`Take ${list.length} eBay listings off your copycats?`)) {
          list.forEach((n) => { trackedItems.delete(n); syncBadgeProtection(n); });
          saveTrackedItems();
          updatePanel();
          refreshHuntCards();
          showToast(`Removed ${list.length} listing${list.length === 1 ? "" : "s"}`);
        }
      } else if (action === "clear") {
        if (!activeTracked().length) return;
        activeTracked().forEach(([n]) => trackedItems.delete(n));
        saveTrackedItems();
        refreshAllBadges();
        updatePanel();
        refreshHuntCards();
        showToast("Copycats cleared");
      } else if (action === "hist-check-all") {
        checkHistoryStatus(null);
        renderReportedView();
      } else if (action === "hist-check") {
        const id = target.closest("[data-report-id]").dataset.reportId;
        checkHistoryStatus([id]);
        renderReportedView();
      } else if (action === "hist-rename") {
        const id = target.closest("[data-report-id]").dataset.reportId;
        const rec = reportHistory.find((x) => x.id === id);
        if (!rec) return;
        const name = window.prompt("Name this report", rec.name || "");
        if (name === null) return;
        rec.name = name.trim().slice(0, 80);
        saveHistory();
        renderReportedView();
      } else if (action === "hist-replied") {
        const rec = reportHistory.find((x) => x.id === target.closest("[data-report-id]").dataset.reportId);
        if (!rec) return;
        rec.amazonReplied = new Date().toISOString();
        saveHistory();
        renderReportedView();
        showToast("Unlocked. Check status to see which listings are still live.");
      } else if (action === "hist-menu") {
        const menu = target.closest(".eif-hist-menu");
        const wasOpen = menu.classList.contains("eif-open");
        overlay.querySelectorAll(".eif-hist-menu.eif-open").forEach((m) => m.classList.remove("eif-open"));
        if (!wasOpen) menu.classList.add("eif-open");
      } else if (action === "hist-set-status") {
        const rec = histReportOf(target);
        const n = target.closest("[data-n]") && target.closest("[data-n]").dataset.n;
        const it = rec && rec.items.find((x) => String(x.n) === String(n));
        if (!it) return;
        const v = target.dataset.status;
        if (!["live", "ended", "removed", ""].includes(v)) return;
        it.status = v;
        if (v) { it.manual = true; it.checkedAt = new Date().toISOString(); it.note = "Set by you"; }
        else { delete it.manual; it.checkedAt = ""; it.note = ""; }
        saveHistory();
        renderReportedView();
        showToast(v ? "Status set" : "Back to automatic checks");
      } else if (action === "hist-archive" || action === "hist-unarchive") {
        const rec = histReportOf(target);
        if (!rec) return;
        if (action === "hist-archive") rec.archived = new Date().toISOString();
        else delete rec.archived;
        saveHistory();
        updateTabCounts();
        renderReportedView();
        showToast(action === "hist-archive" ? "Archived. Find it under Archived." : "Moved back");
      } else if (action === "hist-delete") {
        const rec = histReportOf(target);
        if (rec) deleteHistoryReport(rec);
      } else if (action === "hist-toggle") {
        const key = target.closest("[data-design]").dataset.design;
        if (histOpen.has(key)) histOpen.delete(key);
        else histOpen.add(key);
        renderReportedView();
      } else if (action === "hist-filter") {
        histFilter = target.dataset.filter || "all";
        renderReportedView();
      } else if (action === "hist-show-all") {
        const rec = histReportOf(target);
        if (rec) histShowAll.add(rec.id);
        renderReportedView();
      } else if (action === "hist-check-design") {
        const key = target.closest("[data-design]").dataset.design;
        checkHistoryStatus(reportHistory.filter((r) => histDesignKey(r) === key && !r.archived).map((r) => r.id));
        renderReportedView();
      } else if (action === "hist-archive-done") {
        const key = target.closest("[data-design]").dataset.design;
        const done = reportHistory.filter((r) => !r.archived && histDesignKey(r) === key && r.items.length && r.items.every((it) => it.status === "removed" || it.status === "ended"));
        const now = new Date().toISOString();
        done.forEach((r) => (r.archived = now));
        saveHistory();
        updateTabCounts();
        renderReportedView();
        showToast(`Archived ${done.length} finished report${done.length === 1 ? "" : "s"}`);
      } else if (action === "hist-rereport") {
        reReport(target.closest("[data-report-id]").dataset.reportId);
      } else if (action === "protect-add") {
        protectFromInput();
      } else if (action === "mine-check") mineLookup();
    });
    overlay.addEventListener("input", (e) => {
      if (e.target.id === "eif-bs-search") {
        bs.q = e.target.value.slice(0, 80);
        bs.page = 0;
        renderBestSellersView();
        bsFillInfo();
        return;
      }
      if (e.target.id === "eif-hist-search") {
        histQuery = e.target.value.slice(0, 80);
        renderReportedView();
        return;
      }
      if (popup && popup.tab === "report") handleReportInput(e);
    });
    overlay.addEventListener(
      "toggle",
      (e) => {
        const box = e.target;
        if (box.classList && box.classList.contains("eif-rp-before-group")) {
          if (box.dataset.gkey !== undefined) { if (box.open) rpBeforeOpen.add(box.dataset.gkey); else rpBeforeOpen.delete(box.dataset.gkey); }
          else azBeforeOpen = box.open;
          return;
        }
        if (!box.classList || !box.classList.contains("eif-tr-gbox")) return;
        if (box.open) trOpen.add(box.dataset.gid);
        else trOpen.delete(box.dataset.gid);
      },
      true
    );
    overlay.addEventListener("change", (e) => {
      if (e.target.id === "eif-bs-days" || e.target.id === "eif-bs-mp") {
        if (e.target.id === "eif-bs-days") bs.days = Number(e.target.value) || 30;
        else bs.mp = e.target.value || "";
        bs.page = 0;
        try { chrome.storage.local.set({ eifBestSellersView: { days: bs.days, mp: bs.mp } }); } catch (err) {}
        bs.data = null;
        loadBestSellers();
        return;
      }
      if (e.target.classList && e.target.classList.contains("eif-hj-allcheck")) {
        overlay.querySelectorAll(".eif-list > .eif-hj-row .eif-hj-check").forEach((c) => { if (!c.closest(".eif-hj-common")) c.checked = e.target.checked; });
        updateHijackBulk();
      } else if (e.target.classList && e.target.classList.contains("eif-hj-check")) updateHijackBulk();
      if (e.target.classList && (e.target.classList.contains("eif-amz-check") || e.target.classList.contains("eif-tr-check"))) {
        trSyncHeads();
      }
      if (e.target.classList && e.target.classList.contains("eif-rp-move")) {
        const kind = e.target.dataset.moveKind;
        let id = e.target.dataset.moveId;
        if (id === "@ticked") id = azGroupTargets().filter((a) => azSelection && azSelection.has(a)).join(",");
        else if (id.startsWith("@")) id = ((reportGroups(false).find((g) => g.key === id.slice(1)) || {}).items || []).filter((n) => reportSelection && reportSelection.has(n)).join(",");
        if (id) moveToHunt(kind, id, e.target.value);
        if (popup.tab === "report") renderReportView();
        else if (popup.tab === "tracked") renderTrackedView();
        return;
      }
      if (e.target.classList && e.target.classList.contains("eif-tr-reason")) {
        azSetReason([e.target.dataset.asin], e.target.value);
        renderTrackedView();
        return;
      }
      if (popup && popup.tab === "report") handleReportChange(e);
      const shownRow = (c) => trRowShown(c.closest(".eif-tr-row"));
      if (e.target.id === "eif-tr-all") {
        overlay.querySelectorAll(".eif-tr-check").forEach((c) => (c.checked = e.target.checked && shownRow(c)));
        trSyncHeads();
      }
      if (e.target.classList && e.target.classList.contains("eif-tr-gcheck")) {
        const box = e.target.closest(".eif-tr-gbox");
        box.querySelectorAll(".eif-amz-check, .eif-tr-check").forEach((c) => (c.checked = e.target.checked && shownRow(c)));
        if (e.target.checked) box.open = true;
        trSyncHeads();
        return;
      }
      if (e.target.id === "eif-amz-all") {
        overlay.querySelectorAll(".eif-amz-check").forEach((c) => (c.checked = e.target.checked && shownRow(c)));
        trSyncHeads();
      }
    });
    overlay.addEventListener("keydown", (e) => {
      if (e.target.id === "eif-hj-input" && e.key === "Enter") {
        e.preventDefault();
        startHijackCheck(e.target.value);
        return;
      }
      if (e.target.id === "eif-protect-input" && e.key === "Enter") {
        e.preventDefault();
        protectFromInput();
      }
      if (e.target.id === "eif-mine-lookup-input" && e.key === "Enter") {
        e.preventDefault();
        mineLookup();
      }
    });

    setupPeek(overlay, modal);

    makeDropTarget(modal, () => modal.classList.add("eif-drop-active"), () => modal.classList.remove("eif-drop-active"));

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closePopup();
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.documentElement.classList.add("eif-hunt-open");
    popup = { overlay, tab: "results", onKey };
    renderEbayPause();
    bgSend({ type: "eif-ebay-status" }).then((state) => {
      if (state && !state.error) { ebayRequestState = state; renderEbayPause(); }
    });
  }

  function closePopup() {
    if (!popup) return;
    document.removeEventListener("keydown", popup.onKey, true);
    popup.overlay.remove();
    document.documentElement.classList.remove("eif-hunt-open");
    popup = null;
    ebaySync.rechecked = false;
  }

  function switchTab(tab) {
    if (!popup) return;
    if (tab === "report" && popup.tab === "results" && lastSearch && lastSearch.view === "amazon") reportSite = "amazon";
    if (tab === "report" && popup.tab !== "report") { azContactOpen = null; rpChoicesOpen = false; }
    popup.tab = tab;
    if (signedInState() === false) {
      popup.overlay.querySelectorAll("#eif-tabs [data-tab]").forEach((b) => b.classList.remove("eif-tab-active"));
      const view = viewEl();
      if (view) view.innerHTML = signInGateHtml();
      return;
    }
    popup.overlay.querySelectorAll("#eif-tabs [data-tab]").forEach((button) => {
      const active = button.dataset.tab === tab;
      button.classList.toggle("eif-tab-active", active);
      button.setAttribute("aria-selected", String(active));
    });
    const find = popup.overlay.querySelector("#eif-tabs .eif-find");
    if (find) find.classList.toggle("eif-find-on", tab === "results" || tab === "hijacks");
    if (tab === "tracked") renderTrackedView();
    else if (tab === "mine") renderMineView();
    else if (tab === "bestsellers") renderBestSellersView();
    else if (tab === "hijacks") renderHijackView();
    else if (tab === "report") renderReportView();
    else if (tab === "reported") renderReportedView();
    else renderResultsView();
    updateTabCounts();
  }

  function reportHasWork() {
    return activeTracked().length + azTargets().length > 0;
  }

  function resultsCount(search) {
    if (!search) return 0;
    if (search.view === "amazon") {
      const a = search.amazon;
      return a && Array.isArray(a.items) && !amazonWaiting(a) ? a.items.length : 0;
    }
    return search.state === "done" ? search.items.length : 0;
  }

  function updateTabCounts() {
    if (!popup) return;
    const set = (key, value) => {
      const el = popup.overlay.querySelector(`[data-count="${key}"]`);
      if (el) {
        const before = Number(el.textContent) || 0;
        el.textContent = value ? String(value) : "";
        el.hidden = !value;
        if (key === "tracked" && value > before && M.pop) M.pop(el);
      }
    };
    set("results", resultsCount(lastSearch));
    const rt = popup.overlay.querySelector('#eif-tabs [data-tab="report"]');
    if (rt) {
      const off = !reportHasWork() && popup.tab !== "report";
      rt.classList.toggle("eif-tab-off", off);
      rt.title = off ? "Mark copies with \"Copycat\" in Look-alikes or Hijacks first" : "Fill the eBay or Amazon report form";
    }
    set("hijacks", (lastHijack && lastHijack.state === "done" ? lastHijack.matches.filter((m) => m.level >= 2).length : 0) + (lastAzHijack && lastAzHijack.state === "done" ? lastAzHijack.matches.filter((m) => m.result.category).length : 0));
    set("tracked", activeTracked().length + azTracked().length);
    set("reported", reportHistory.filter((r) => !r.archived).length);
    set("mine", protectedItems.size + amazonMine.size);
  }

  function paintMaintenance(overlay) {
    const el = overlay && overlay.querySelector("#eif-maint");
    if (!el || !hasStorage) return;
    chrome.storage.local.get({ eifMessages: null }, (d) => {
      const m = ((d && d.eifMessages && d.eifMessages.items) || []).find((x) => x && x.live && x.kind === "maintenance" && x.title);
      el.hidden = !m;
      if (!m) return;
      el.dataset.id = m.id;
      el.innerHTML = `<i></i><b>Maintenance</b><span>${escapeHtml(m.title)}</span><u>Details</u>`;
    });
  }

  function viewEl() {
    return popup && popup.overlay.querySelector("#eif-view");
  }

  function renderResultsView() {
    const view = viewEl();
    if (!view) return;
    const search = lastSearch;

    if (!search) {
      view.innerHTML = `
        <div class="eif-center eif-empty-drop">
          <div class="eif-empty-icon">${ICON}</div>
          <div class="eif-empty-title">Find copies of your listing</div>
          <div class="eif-empty-sub">Drag your listing's photo onto this window, paste an image (Ctrl+V), or upload one.</div>
          <button class="eif-hunt-btn eif-hunt-btn-primary" type="button" data-action="upload">Upload an image</button>
        </div>`;
      return;
    }

    const isMineProtected = searchIsMine(search);
    view.innerHTML = `
      <div class="eif-results-head">
        <img class="eif-src-thumb" alt="" ${search.thumb ? `src="${safeSrc(search.thumb)}"` : ""} />
        <div class="eif-results-meta">
          <div class="eif-results-title">${search.itemNumber ? `${isMineProtected ? "Your listing" : "Searched listing"} <span class="eif-hunt-source">#${search.itemNumber}</span>` : search.asin ? `${amazonSourceTitle(search.asin)} <span class="eif-hunt-source">${escapeHtml(search.asin)}</span>` : "Your image"}</div>
          <div id="eif-hunt-status"></div>
        </div>
        ${search.itemNumber ? `<button class="eif-hunt-btn" type="button" data-action="hj-check" data-item-number="${search.itemNumber}" title="Look for listings that copy this listing's title or photos">Check for hijacks</button>` : search.asin && amazonIsMine(search.asin) ? `<button class="eif-hunt-btn" type="button" id="eif-azhj-head-btn" data-action="azhj-check" data-asin="${search.asin}" title="Search Amazon for listings that copy your title, brand or bullets, with any design"${azHijackAlreadyRun(search) ? " hidden" : ""}>Check for hijacks</button>` : ""}
        ${search.itemNumber && !isMineProtected ? `<button class="eif-hunt-btn" type="button" data-action="protect-source" title="Save this item number as yours so it can never be marked as a copycat">Protect as mine</button>` : ""}
        ${search.state === "done" ? `<button class="eif-hunt-btn eif-hunt-btn-green" type="button" data-action="report-search" title="Report the copycats you marked in these results">Report</button>` : ""}
      </div>
      ${search.state === "done" ? sourceSwitchHtml(search) : ""}
      <div id="eif-score-bar" class="eif-score-bar" hidden></div>
      <div class="eif-scroll" id="eif-results-scroll">
        ${
          search.state === "offline"
            ? offlineHtml("The image search")
            : search.state === "loading"
            ? progressHtml(search)
            : search.state === "error"
              ? `<div class="eif-center eif-error"><div>${escapeHtml(search.message)}</div>${search.again ? '<button class="eif-hunt-btn eif-hunt-btn-primary" type="button" data-action="hunt-again">Try again</button>' : ""}<button class="eif-hunt-btn${search.again ? "" : " eif-hunt-btn-primary"}" type="button" data-action="upload">Upload an image instead</button></div>`
              : `<div id="eif-hunt-grid"></div><div id="eif-more"></div>`
        }
      </div>
      <div id="eif-pickbar" hidden></div>`;

    renderResultsStatus();
    if (search.state === "loading") updateProgressUI();
    if (search.state === "done" && search.view === "amazon") {
      renderAmazonGrid();
    } else if (search.state === "done" && search.ebayOff) {
      view.querySelector("#eif-hunt-grid").innerHTML = search.ebayOff === "no-account" || search.ebayOff === "not-connected"
        ? `<div class="eif-hunt-empty eif-amz-msg"><b>${search.ebayOff === "no-account" ? "eBay isn't searched: you said you don't have an eBay account." : "eBay isn't searched yet: your eBay account isn't connected."}</b><div>${search.ebayOff === "no-account" ? "To report copies on eBay you need one (a free account is enough, you don't need to sell). Connect it from the setup page." : "Sign in to eBay and finish the eBay step on the setup page; Amazon hunts include eBay after that."}</div><div class="eif-amz-btns"><button class="eif-hunt-btn eif-hunt-btn-primary" type="button" data-action="ebay-open-setup">Open the setup page</button><button class="eif-hunt-btn" type="button" data-action="ebay-retry">Search eBay anyway</button></div></div>`
        : `<div class="eif-hunt-empty eif-amz-msg"><b>eBay isn't searched automatically.</b><div>You turned it off in the Copycat Hunt menu (toolbar icon).</div><div class="eif-amz-btns"><button class="eif-hunt-btn eif-hunt-btn-primary" type="button" data-action="ebay-retry">Search eBay for this image</button></div></div>`;
      renderResultsStatus();
    } else if (search.state === "done" && search.ebayError) {
      view.querySelector("#eif-hunt-grid").innerHTML = `<div class="eif-hunt-empty eif-amz-msg"><b>${escapeHtml(search.ebayError)}</b>${search.retry ? `<div class="eif-amz-btns">${search.needsEbayTab ? '<button class="eif-hunt-btn eif-hunt-btn-primary" type="button" data-action="ebay-open-tab">Open eBay in a tab</button>' : ""}<button class="eif-hunt-btn" type="button" data-action="ebay-retry">Try again</button></div>` : ""}</div>`;
      renderResultsStatus();
    } else if (search.state === "done") {
      const grid = view.querySelector("#eif-hunt-grid");
      grid.innerHTML = search.items.length
        ? search.items.map(resultCardHtml).join("")
        : '<div class="eif-hunt-empty">No look-alike listings found for this image.</div>';
      refreshHuntCards();
      renderLoadMore();
    }
  }

  function resultCardHtml(item) {
    const index = lastSearch.items.indexOf(item);
    return `
      <div class="eif-hc" data-item-number="${item.itemNumber}">
        <a class="eif-hc-img" href="${safeHref(item.url)}" target="_blank" rel="noopener" aria-label="Open listing #${item.itemNumber}">
          ${item.image ? `<img src="${safeSrc(sharpThumb(item.image))}" data-hi="${escapeHtml(normalizeImageUrl(item.image) || item.image)}" alt="" loading="lazy" />` : ""}
        </a>
        <span class="eif-hc-rank">${index + 1}</span>
        <span class="eif-hc-tag" hidden></span>
        <span class="eif-hc-num">#${item.itemNumber}</span>
        <button class="eif-hc-track" type="button" data-action="track"></button>
      </div>`;
  }

  function appendResultCards() {
    const grid = popup && popup.overlay.querySelector("#eif-hunt-grid");
    if (!grid || !lastSearch) return;
    const shown = grid.querySelectorAll(".eif-hc").length;
    grid.insertAdjacentHTML("beforeend", lastSearch.items.slice(shown).map(resultCardHtml).join(""));
    refreshHuntCards();
  }

  function renderResultsStatus() {
    const status = popup && popup.overlay.querySelector("#eif-hunt-status");
    const search = lastSearch;
    if (!status || !search) return;
    const jump = popup.overlay.querySelector("#eif-jump");
    let text = search.message;
    let tone = "";
    if (search.state === "error" || search.state === "offline") tone = "err";
    if (search.state === "done" && search.view === "amazon") {
      const a = search.amazon || {};
      const mineHere = (a.items || []).filter((i) => amazonMine.has(i.asin)).length;
      text =
        amazonWaiting(a) ? "Searching Amazon…"
          : a.state === "done"
          ? `${a.items.length} look-alikes on ${search.marketplace && search.marketplace !== "US" ? AZ.marketplaceLabel(search.marketplace) : "Amazon"}${a.more && a.more.removed ? ` · ${a.more.removed} no longer on Amazon` : ""}${a.more && a.more.failed > 0 ? ` · ${a.more.failed} couldn't be loaded` : ""}${mineHere ? " · yours has the mint outline" : ""}`
          : "";
      tone = a.state === "done" || amazonWaiting(a) ? "" : a.state === "blocked" || a.state === "error" ? "warn" : "";
      if (jump) jump.hidden = true;
      status.textContent = text;
      status.className = tone ? `eif-${tone}` : "";
      return;
    }
    if (search.state === "done" && search.ebayError) {
      status.textContent = search.ebayError;
      status.className = "eif-warn";
      if (jump) jump.hidden = true;
      return;
    }
    if (search.state === "done") {
      const total = search.items.length;
      const rank = search.itemNumber ? search.items.findIndex((i) => i.itemNumber === search.itemNumber) + 1 : 0;
      const mine = searchIsMine(search);
      if (rank && mine) {
        text = `${total} look-alikes · your listing is #${rank}`;
        tone = "ok";
      } else if (search.itemNumber && mine) {
        text = `${total} look-alikes · your listing isn't among them`;
        tone = "warn";
      } else if (search.itemNumber) {
        text = `${total} look-alikes of #${search.itemNumber}${rank ? ` (shown at #${rank})` : ""} · not marked as yours`;
      } else {
        text = `${total} look-alikes`;
      }
      if (jump) jump.hidden = !(rank && mine);
    }
    status.textContent = text;
    status.className = tone ? `eif-${tone}` : "";
  }

  function renderLoadMore() {
    const more = popup && popup.overlay.querySelector("#eif-more");
    if (!more || !lastSearch) return;
    if (lastSearch.loadingMore) {
      more.innerHTML = `<div class="eif-more-loading">${LOADER() || '<div class="eif-spinner eif-spinner-sm"></div>'}Loading more…</div>`;
    } else if (lastSearch.hasMore) {
      more.innerHTML = '<button class="eif-hunt-btn" type="button" data-action="more">Load more results</button>';
    } else {
      more.innerHTML = lastSearch.items.length ? '<div class="eif-more-end">End of results</div>' : "";
    }
  }

  function pickedFromSearch() {
    const s = lastSearch;
    if (!s || s.state !== "done") return 0;
    if (s.view === "amazon") {
      return ((s.amazon && s.amazon.items) || []).filter((i) => {
        const a = i.asin;
        return amazonTracked.has(a) && !amazonTracked.get(a).reportedAt && !amazonMine.has(a) && !merchIsOwn(a) && a !== s.asin;
      }).length;
    }
    return s.items.filter((i) => trackedItems.has(i.itemNumber) && !(trackedItems.get(i.itemNumber) || {}).reportedAt).length;
  }

  function updatePickBar() {
    const bar = popup && popup.overlay.querySelector("#eif-pickbar");
    if (!bar) return;
    const n = popup.tab === "results" ? pickedFromSearch() : 0;
    bar.hidden = !n;
    if (!n) return;
    const site = lastSearch.view === "amazon" ? "Amazon" : "eBay";
    bar.innerHTML = `<span><b>${n}</b> copycat${n === 1 ? "" : "s"} from this search on ${site}</span><button class="eif-hunt-btn" type="button" data-action="go-tab" data-go="tracked">See copycats</button><button class="eif-hunt-btn eif-hunt-btn-primary" type="button" data-action="report-search">Report ${n}</button>`;
  }

  function refreshHuntCards() {
    updateTabCounts();
    updatePickBar();
    refreshHijackRows();
    if (!popup || popup.tab !== "results" || !lastSearch) return;
    const mine = lastSearch.itemNumber;
    const mineProven = searchIsMine(lastSearch);
    if (lastSearch.view === "amazon") return refreshAmazonCards();
    popup.overlay.querySelectorAll(".eif-hc:not(.eif-hc-amz)").forEach((card) => {
      const itemNumber = card.dataset.itemNumber;
      const isMine = mineProven && itemNumber === mine;
      const isSearched = !mineProven && !!mine && itemNumber === mine;
      const isOwn = !isMine && isMineEbay(itemNumber);
      const isTracked = !isMine && !isOwn && trackedItems.has(itemNumber);
      card.classList.toggle("eif-hc-mine", isMine);
      card.classList.toggle("eif-hc-searched", isSearched);
      card.classList.toggle("eif-hc-own", isOwn);
      card.classList.toggle("eif-hc-tracked", isTracked);

      const tag = card.querySelector(".eif-hc-tag");
      tag.textContent = isMine ? "Your listing" : isOwn ? (protectedItems.has(itemNumber) ? "Yours · protected" : "Your eBay listing") : isSearched ? "Searched listing" : "";
      tag.hidden = !(isMine || isOwn || isSearched);

      const button = card.querySelector(".eif-hc-track");
      if (isMine || isOwn) {
        button.disabled = true;
        button.textContent = isMine ? "Your listing" : "Protected";
        button.title = "Your own listing can't be flagged as a copycat";
      } else {
        button.disabled = false;
        button.textContent = isTracked ? "✓ Copycat" : "Copycat";
      button.dataset.ic = isTracked ? "" : "bookmark";
        button.title = isTracked ? "Remove from the copycat list" : "Add to the copycat list";
      }
    });
    const protectBtn = popup.overlay.querySelector('[data-action="protect-source"]');
    if (protectBtn && mine && isMineEbay(mine)) protectBtn.remove();
    paintScores();
  }

  function jumpToMine() {
    if (!popup) return;
    const card = popup.overlay.querySelector(".eif-hc-mine");
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("eif-hc-flash");
    void card.offsetWidth;
    card.classList.add("eif-hc-flash");
  }

  const trOpen = new Set();
  function withHuntHeaders(entries, keyOf, kind) {
    const keys = new Set(entries.map(keyOf));
    const sorted = [...entries].sort((a, b) => {
      const ka = keyOf(a), kb = keyOf(b);
      return (ka === "") - (kb === "") || ka.localeCompare(kb);
    });
    const grouped = keys.size > 1;
    const counts = new Map();
    const texts = new Map();
    sorted.forEach((e) => {
      const k = keyOf(e);
      counts.set(k, (counts.get(k) || 0) + 1);
      if (((e[1] && e[1].copied) || []).length) texts.set(k, (texts.get(k) || 0) + 1);
    });
    let last = null;
    return sorted.map((e, i) => {
      const k = keyOf(e);
      let head = "";
      if (grouped && k !== last) {
        const id = `${kind || "x"}|${k}`;
        const n = counts.get(k);
        const t = texts.get(k) || 0;
        head = `${last !== null ? "</div></details>" : ""}<details class="eif-tr-gbox" data-gid="${escapeHtml(id)}" ${trOpen.has(id) ? "open" : ""}>
          <summary class="eif-tr-group">
            <span class="eif-tr-chev" aria-hidden="true">›</span>
            <input type="checkbox" class="eif-tr-gcheck" title="Tick every copy of this design" aria-label="Tick every copy of this design" />
            ${k ? huntThumb(k) : ""}<span class="eif-tr-gname">${k ? escapeHtml(huntLabel(k)) : "Not sorted yet"}</span>
            <span class="eif-tr-gcount" data-n="${n}">${n} cop${n === 1 ? "y" : "ies"}</span>
            ${t ? `<span class="eif-copied-tag eif-copied-title">${t} copied your text</span>` : ""}
          </summary><div class="eif-tr-gbody">`;
      }
      last = k;
      const tail = grouped && i === sorted.length - 1 ? "</div></details>" : "";
      return [e[0], e[1], head, tail];
    });
  }

  function withReasonBoxes(list) {
    const key = (e) => `${(e[1] && e[1].hunt) || ""}|${azReasonOf(e[1])}`;
    const counts = new Map();
    list.forEach((e) => counts.set(key(e), (counts.get(key(e)) || 0) + 1));
    return list.map((e, i) => {
      const k = key(e);
      const r = azReasonOf(e[1]);
      const n = counts.get(k);
      const open = i === 0 || key(list[i - 1]) !== k;
      const close = i === list.length - 1 || key(list[i + 1]) !== k;
      const label = r ? AZ.ISSUES[r].label : "No reason yet";
      const head = open
        ? `<div class="eif-tr-rbox${r ? "" : " eif-tr-rbox-none"}" data-tr-reason="${r}">
            <div class="eif-tr-rhead"><span class="eif-tr-rname">${escapeHtml(label)}</span><span class="eif-tr-rcount" data-n="${n}">${n}</span>
              <button type="button" class="eif-hunt-btn eif-tr-rgo" data-action="tr-reason-go" data-hunt="${escapeHtml((e[1] && e[1].hunt) || "")}" data-tr-reason="${r}" title="${r ? `Report these on Amazon as “${escapeHtml(label)}”` : "Pick what they copied, then report"}">${n === 1 ? "Report it" : `Report these ${n}`}</button></div>`
        : "";
      return [e[0], e[1], e[2] + head, (close ? "</div>" : "") + e[3]];
    });
  }
  function azReasonSelect(asin, m) {
    const r = azReasonOf(m);
    return `<select class="eif-tr-reason" data-asin="${escapeHtml(asin)}" aria-label="What they copied" title="What they copied (the reason on the report)">
      <option value="" ${r ? "" : "selected"}>No reason yet</option>${AZ_REASON_ORDER.filter(Boolean).map((k) => `<option value="${k}" ${k === r ? "selected" : ""}>${escapeHtml(AZ.ISSUES[k].label)}</option>`).join("")}</select>`;
  }

  function amzActive() {
    return [...amazonTracked.entries()].filter(([, m]) => !m.reportedAt).map(([asin]) => asin);
  }

  function amzSelected() {
    return popup ? [...popup.overlay.querySelectorAll(".eif-amz-check:checked")].map((c) => c.dataset.asin) : [];
  }

  function amzRemove(list) {
    list.forEach((a) => amazonTracked.delete(a));
    saveAmazon();
    updatePanel();
    updateTabCounts();
    renderTrackedView();
    if (popup && popup.tab === "results") refreshAmazonCards();
  }

  function copiedKind(m) {
    const c = (m && m.copied) || [];
    return !c.length ? "" : c.includes("title") && c.length >= 3 ? "full" : c.includes("title") ? "title" : "part";
  }
  let trTextFilter = "";
  function trRowShown(row) {
    if (!row || !trTextFilter || !row.closest(".eif-tr-list[data-filter]")) return true;
    const t = row.dataset.text || "";
    return trTextFilter === "any" ? !!t : trTextFilter === "full" ? t === "full" : trTextFilter === "none" ? !t : true;
  }
  function trSyncHeads() {
    if (!popup) return;
    const o = popup.overlay;
    o.querySelectorAll(".eif-tr-gbox").forEach((box) => {
      const g = box.querySelector(".eif-tr-gcheck");
      if (!g) return;
      const rows = [...box.querySelectorAll(".eif-amz-check, .eif-tr-check")].filter((c) => trRowShown(c.closest(".eif-tr-row")));
      const cnt = box.querySelector(".eif-tr-gcount");
      const filtered = !!trTextFilter && !!box.closest(".eif-tr-list[data-filter]");
      if (cnt && cnt.dataset.n) {
        const n = Number(cnt.dataset.n);
        cnt.textContent = filtered && rows.length !== n ? `${rows.length} of ${n} copies` : `${n} cop${n === 1 ? "y" : "ies"}`;
      }
      box.hidden = filtered && rows.length === 0;
      g.checked = rows.length > 0 && rows.every((c) => c.checked);
      g.indeterminate = !g.checked && rows.some((c) => c.checked);
    });
    o.querySelectorAll(".eif-tr-rbox").forEach((box) => {
      box.hidden = ![...box.querySelectorAll(".eif-tr-row")].some(trRowShown);
    });
    [["#eif-amz-all", ".eif-amz-check"], ["#eif-tr-all", ".eif-tr-check"]].forEach(([h, sel]) => {
      const head = o.querySelector(h);
      if (!head) return;
      const rows = [...o.querySelectorAll(sel)].filter((c) => trRowShown(c.closest(".eif-tr-row")));
      head.checked = rows.length > 0 && rows.every((c) => c.checked);
      head.indeterminate = !head.checked && rows.some((c) => c.checked);
    });
  }

  function copiedTag(m) {
    const c = (m && m.copied) || [];
    if (!c.length) return "";
    const names = c.map((f) => (f === "description" ? "description" : f));
    const full = c.includes("title") && c.length >= 3;
    return ` <span class="eif-copied-tag ${full ? "eif-copied-full" : c.includes("title") ? "eif-copied-title" : "eif-copied-part"}" title="Listing text they copied from yours">${escapeHtml(full ? "Full hijack" : `${names.join(" + ").replace(/^./, (x) => x.toUpperCase())} copied`)}</span>`;
  }

  const AZ_REASON_ORDER = ["stolen_artwork", "copied_design", "modified_design", "copied_listing", ""];
  function azReasonOf(m) {
    return m && AZ && Object.prototype.hasOwnProperty.call(AZ.ISSUES, m.reason) ? m.reason : "";
  }
  function azSetReason(asins, reason) {
    asins.forEach((a) => {
      const m = amazonTracked.get(a);
      if (m) m.reason = reason || "";
    });
    saveAmazon();
  }
  function azOpenReport(list, reason) {
    const h = (amazonTracked.get(list[0]) || {}).hunt || "";
    const same = list.filter((x) => ((amazonTracked.get(x) || {}).hunt || "") === h);
    if (azGroupsMap().has(h)) azSwitchGroup(h, false);
    azDraft.issue = reason;
    saveAzDraft();
    reportSite = "amazon";
    switchTab("report");
    azFocus = new Set(same);
    azSelection = new Set(same.filter((a) => azGroupTargets().includes(a)));
    azBump();
    renderAmazonReportView();
    if (same.length < list.length) showToast("Those copies belong to different designs. Showing the first design; switch at the top for the others.");
    else showToast(`${azSelection.size} ticked · ${(AZ.ISSUES[reason] || {}).label || ""}`);
  }
  function notReportableToast(asins) {
    const mps = [...new Set(asins.map(mpOfAsin).filter((mp) => !AZ.canReport(mp)))];
    if (!mps.length) return false;
    showToast(`Reporting on ${mps.map(AZ.marketplaceLabel).join(", ")} comes in the next update. Those copies stay in Copycats.`);
    return true;
  }
  function azReportByReason(list) {
    if (list.every((a) => !AZ.canReport(mpOfAsin(a)))) return notReportableToast(list);
    list = list.filter((a) => AZ.canReport(mpOfAsin(a)));
    const need = list.filter((a) => !azReasonOf(amazonTracked.get(a)));
    const hunts = new Set(list.map((a) => (amazonTracked.get(a) || {}).hunt || ""));
    const withReason = (r) => [...new Set([...list, ...azTargets().filter((a) => hunts.has((amazonTracked.get(a) || {}).hunt || ""))])].filter((a) => azReasonOf(amazonTracked.get(a)) === r);
    if (need.length) {
      return askReportReason(need, (reason) => {
        azSetReason(need, reason);
        azOpenReport(withReason(reason), reason);
      });
    }
    const reasons = [...new Set(list.map((a) => azReasonOf(amazonTracked.get(a))))];
    if (reasons.length === 1) return azOpenReport(list, reasons[0]);
    if (!popup || popup.tab !== "tracked") switchTab("tracked");
    else renderTrackedView();
    showToast("These have different reasons. Amazon takes one reason per report: press Report on each reason group.");
  }

  function askReportReason(asins, go) {
    if (!prefs.askReason) return go(azDraft.issue || "copied_design");
    const withText = asins.filter((a) => ((amazonTracked.get(a) || {}).copied || []).includes("title")).length;
    const sel = scoreSelection();
    const changed = sel ? asins.filter((a) => sel.changed.has(`amazon:${a}`)).length : 0;
    const design = changed === asins.length ? "modified_design" : changed ? "" : "copied_design";
    const suggest = withText && withText === asins.length ? "copied_listing" : withText ? "" : design;
    const old = popup.overlay.querySelector("#eif-reason");
    if (old) old.remove();
    const box = document.createElement("div");
    box.id = "eif-reason";
    box.innerHTML = `
      <div class="eif-reason-card" role="dialog" aria-modal="true" aria-label="What did they copy?">
        <div class="eif-reason-h">What did they copy?</div>
        <div class="eif-reason-sub">${asins.length} listing${asins.length === 1 ? "" : "s"} selected${withText ? ` · ${withText} copied your listing text` : ""}. This picks the reason and the description on the report.</div>
        ${Object.entries(AZ.ISSUES).map(([k, v]) => `<button type="button" class="eif-reason-opt ${k === suggest ? "eif-suggested" : ""}" data-reason="${k}"><b>${escapeHtml(v.label)}${k === suggest ? ' <span class="eif-reason-tip">suggested</span>' : ""}</b><span>${escapeHtml(v.hint)}</span></button>`).join("")}
        ${withText && withText < asins.length ? '<div class="eif-reason-note">Some copied your text and some didn\u2019t. Amazon takes one reason per report, so you may want two reports.</div>' : ""}
        <button type="button" class="eif-hunt-btn eif-reason-cancel" data-reason="">Cancel</button>
      </div>`;
    box.addEventListener("click", (e) => {
      const b = e.target.closest("[data-reason]");
      if (!b && e.target !== box) return;
      box.remove();
      if (b && b.dataset.reason) go(b.dataset.reason);
    });
    (popup.overlay.querySelector("#eif-hunt-modal") || popup.overlay).appendChild(box);
    (box.querySelector(".eif-suggested") || box.querySelector(".eif-reason-opt")).focus();
  }

  const TR_ROOMY_MAX = 24;
  function renderTrackedView() {
    const view = viewEl();
    if (!view) return;
    const checked = new Set([...view.querySelectorAll(".eif-tr-check:checked")].map((c) => c.dataset.itemNumber));
    const amzChecked = new Set([...view.querySelectorAll(".eif-amz-check:checked")].map((c) => c.dataset.asin));
    const scroll = view.querySelector(".eif-scroll");
    const scrollTop = scroll ? scroll.scrollTop : 0;

    const byReason = ([, a], [, b]) => AZ_REASON_ORDER.indexOf(azReasonOf(a)) - AZ_REASON_ORDER.indexOf(azReasonOf(b));
    const amzList = withReasonBoxes(withHuntHeaders([...amazonTracked.entries()].filter(([, m]) => !m.reportedAt).sort(byReason), ([, m]) => m.hunt || "", "amz"));
    const amzTextCounts = { any: 0, full: 0 };
    amzList.forEach(([, m]) => { const k = copiedKind(m); if (k) amzTextCounts.any++; if (k === "full") amzTextCounts.full++; });
    const amzRows = amzList
      .map(
        ([asin, m, head, tail]) => `${head}
        <div class="eif-tr-row" data-asin="${escapeHtml(asin)}" data-text="${copiedKind(m)}">
          <input class="eif-amz-check" type="checkbox" data-asin="${escapeHtml(asin)}" ${amzChecked.has(asin) ? "checked" : ""} aria-label="Select ${escapeHtml(asin)}" />
          ${m.image ? `<img class="eif-tr-thumb" src="${safeSrc(m.image)}" alt="" loading="lazy" />` : '<span class="eif-tr-thumb"></span>'}
          <div class="eif-tr-main">
            <a class="eif-tr-title eif-tr-num-link" href="${escapeHtml(amzUrl(asin))}" target="_blank" rel="noopener" title="${escapeHtml(m.title)}">${escapeHtml(asin)}</a>
            <div class="eif-tr-sub"><span class="eif-kind eif-kind-amazon">Amazon</span>${m.marketplace && m.marketplace !== "US" ? `<span class="eif-tr-mp" title="Found on this Amazon marketplace">${escapeHtml(AZ.marketplaceLabel(m.marketplace))}</span>` : ""}${copiedTag(m)}${amazonLock(asin) ? ` <span class="eif-rp-tag eif-rp-tag-warn" title="Amazon asks not to report the same listing twice">${escapeHtml(lockText(amazonLock(asin)))}</span>` : ""} ${escapeHtml((m.title || "").slice(0, 70))}</div>
          </div>
          ${azReasonSelect(asin, m)}
          <button class="eif-row-x eif-tr-untrack" type="button" data-action="amz-untrack" title="Not a copy? Take it off your copycats" aria-label="Not a copycat">&times;<span>Not a copycat</span></button>
        </div>${tail}`
      )
      .join("");
    let amzSection = amzRows
      ? `<div class="eif-amz-section">
          <div class="eif-list-head eif-amz-head">
            <label class="eif-select-all"><input id="eif-amz-all" type="checkbox" /> <span>${amzActive().length} on Amazon, not reported yet</span></label>
            <div class="eif-list-actions">
              <button class="eif-hunt-btn eif-hunt-btn-green" type="button" data-action="az-go" title="Report the selected products (or all, if none selected) on Amazon">Report on Amazon</button>
            </div></div>
          ${amzTextCounts.any ? `<div class="eif-rp-pickbar eif-tr-filterbar">
            <div class="eif-seg" role="group" aria-label="Show">
              <button type="button" data-action="tr-text" data-k="" aria-pressed="${!trTextFilter}">All <i>${amzList.length}</i></button>
              <button type="button" data-action="tr-text" data-k="any" aria-pressed="${trTextFilter === "any"}">Text copied <i>${amzTextCounts.any}</i></button>
              ${amzTextCounts.full ? `<button type="button" data-action="tr-text" data-k="full" aria-pressed="${trTextFilter === "full"}">Full hijack <i>${amzTextCounts.full}</i></button>` : ""}
              <button type="button" data-action="tr-text" data-k="none" aria-pressed="${trTextFilter === "none"}">Design only <i>${amzList.length - amzTextCounts.any}</i></button>
            </div>
          </div>` : ""}
          <div class="eif-list eif-tr-list" data-filter="${trTextFilter}">${amzRows}</div>
          <div class="eif-rp-more">
            <button type="button" class="eif-link-btn" data-action="amz-copy-selected">Copy picked</button>
            <button type="button" class="eif-link-btn" data-action="amz-copy">Copy all</button>
            <button type="button" class="eif-link-btn eif-link-danger" data-action="amz-remove-selected">Remove picked</button>
            <button type="button" class="eif-link-btn eif-link-danger" data-action="amz-clear">Clear all</button>
          </div>
        </div>`
      : "";

    const roomy = activeTracked().length + amzList.length <= TR_ROOMY_MAX;
    if (roomy) amzSection = amzSection.replace('class="eif-list eif-tr-list"', 'class="eif-list eif-tr-list eif-tr-roomy"');
    if (!activeTracked().length && amzSection) {
      view.innerHTML = `<div class="eif-scroll">${amzSection}</div>`;
      return;
    }
    if (!activeTracked().length) {
      view.innerHTML = emptyStateHtml("No copycats yet", 'Press "Copycat" on a look-alike, or the "+" badge on eBay pages. Copycats stay here until you report or remove them.', findButtons());
      return;
    }

    const rows = withHuntHeaders(activeTracked(), ([n, m]) => (m.source && isMineEbay(m.source) ? `ebay:${m.source}` : m.hunt || ""), "ebay")
      .map(
        ([itemNumber, data, head, tail]) => `${head}
        <div class="eif-tr-row" data-item-number="${itemNumber}">
          <input class="eif-tr-check" type="checkbox" data-item-number="${itemNumber}" ${checked.has(itemNumber) ? "checked" : ""} aria-label="Select #${itemNumber}" />
          ${data.image ? `<img class="eif-tr-thumb" src="${safeSrc(data.image)}" alt="" loading="lazy" />` : '<span class="eif-tr-thumb"></span>'}
          <div class="eif-tr-main">
            <a class="eif-tr-title eif-tr-num-link" href="${safeHref(data.url)}" target="_blank" rel="noopener" title="Open listing">#${itemNumber}</a>
            <div class="eif-tr-sub"><span class="eif-kind eif-kind-${data.kind === "hijack" ? "hijack" : "copycat"}">${data.kind === "hijack" ? "Hijack" : "Design copy"}</span>${data.reportedAt ? ` <span class="eif-rp-tag">Reported ${escapeHtml(data.reportedAt)}</span>` : ""} ${escapeHtml((data.title && data.title !== "Untitled listing" ? data.title : "").slice(0, 70))}</div>
          </div>
          <button class="eif-row-x eif-tr-untrack" type="button" data-action="untrack" title="Not a copy? Take it off your copycats" aria-label="Not a copycat">&times;<span>Not a copycat</span></button>
        </div>${tail}`
      )
      .join("");

    view.innerHTML = `
      <div class="eif-list-head">
        <label class="eif-select-all"><input id="eif-tr-all" type="checkbox" /> <span>${activeTracked().length} tracked, not reported yet</span></label>
        <div class="eif-list-actions">
          <button class="eif-hunt-btn eif-hunt-btn-green" type="button" data-action="report-selected" title="Report the selected listings (or all, if none selected) to eBay">Report to eBay</button>
        </div>
      </div>
      <div class="eif-scroll"><div class="eif-list eif-tr-list eif-tr-list-ebay${roomy ? " eif-tr-roomy" : ""}">${rows}</div>
        <div class="eif-rp-more eif-tr-more">
          <button type="button" class="eif-link-btn" data-action="copy-selected">Copy picked</button>
          <button type="button" class="eif-link-btn" data-action="copy-all">Copy all</button>
          <button type="button" class="eif-link-btn eif-link-danger" data-action="remove-selected">Remove picked</button>
          <button type="button" class="eif-link-btn eif-link-danger" data-action="clear">Clear all</button>
        </div>${amzSection}</div>`;
    const newScroll = view.querySelector(".eif-scroll");
    if (newScroll) newScroll.scrollTop = scrollTop;
    trSyncHeads();
  }

  let ebaySync = { status: null, loading: false, shown: 60, rechecked: false };
  function loadEbaySync() {
    if (ebaySync.loading || !hasStorage) return;
    ebaySync.loading = true;
    bgSend({ type: "eif-ebay-catalog-status" }).then((st) => {
      ebaySync = { ...ebaySync, status: st && st.ok ? st : null, loading: false };
      if (popup && popup.tab === "mine") renderMineView();
    });
  }
  const ebayNeedsAction = (code) => ["signed_out", "logged_out", "needs_ebay_tab"].includes(code);
  function ebayReasonText(code) {
    return ({
      signed_out: "eBay signed you out. Sign in to eBay, then press Sync now.",
      logged_out: "eBay signed you out. Sign in to eBay, then press Sync now.",
      needs_ebay_tab: "eBay wants this read from an eBay tab. Open eBay, then press Sync now.",
      rate_limited: "eBay asked to slow down. The sync tries again by itself in a few minutes.",
      network: "No connection to eBay. Check your internet, then press Sync now.",
      not_seller_hub: "eBay didn't show a Seller Hub listings page for this account.",
      timeout: "eBay took too long to answer. Press Sync now to try again.",
    })[code] || "The eBay sync stopped. Press Sync now to try again.";
  }

  function ebaySyncedHtml() {
    if (!ebaySync.status && !ebaySync.loading && !ebaySync.asked) { ebaySync.asked = true; setTimeout(loadEbaySync, 0); }
    const st = ebaySync.status;
    const run = st && st.run;
    const meta = (st && st.meta) || {};
    let line;
    if (run && (run.state === "syncing" || run.state === "finalizing")) {
      line = `${LOADER()}Reading your Seller Hub listings… ${Number(run.rawScanned) || 0}${run.expectedTotal != null ? ` of ${Number(run.expectedTotal)}` : ""}`;
    } else if (st && st.catalog) {
      const ago = st.catalog.syncedAt ? daysAgo(new Date(st.catalog.syncedAt).toISOString().slice(0, 10)) : "";
      line = `<span class="eif-rp-ok">✓</span> <b>${st.catalog.count} listings</b> from your Seller Hub · synced ${escapeHtml(ago || "today")}${meta.state === "failed" && meta.lastError && !ebayNeedsAction(meta.lastError) ? ` · <span class="eif-rp-warn">last sync stopped: ${escapeHtml(ebayReasonText(meta.lastError))}</span>` : ""}`;
    } else {
      line = "Your eBay listings aren't synced yet. Sync to recognise all of them automatically.";
    }
    const needs = !(run && (run.state === "syncing" || run.state === "finalizing")) && (ebayNeedsAction(meta.lastError) || (run && run.state === "needs_login"));
    if (needs) {
      const signedOut = (run && run.state === "needs_login") || meta.lastError === "signed_out" || meta.lastError === "logged_out";
      if (!ebaySync.rechecked) {
        ebaySync.rechecked = true;
        bgSend({ type: "eif-ebay-session" }).then((r) => { if (r && r.session === "signed_in") { ebaySync.status = null; ebaySync.asked = false; renderMineView(); } });
      }
      const have = st && st.catalog ? `<span class="eif-rp-ok">✓</span> <b>${st.catalog.count} listings</b> from your last sync · ` : "";
      return signedOut
        ? `<div class="eif-mine-note">${have}<span class="eif-rp-warn">eBay signed you out.</span> <a class="eif-link-btn" href="${escapeHtml(ebaySignInUrl())}" target="_blank" rel="noopener">Sign in to eBay</a> <span class="eif-rp-muted">The sync button comes back once you're signed in.</span></div>`
        : `<div class="eif-mine-note">${have}<span class="eif-rp-warn">${escapeHtml(ebayReasonText(meta.lastError))}</span> <button type="button" class="eif-link-btn" data-action="ebay-open-tab">Open eBay</button> <button type="button" class="eif-link-btn" data-action="ebay-sync-now">Sync now</button></div>`;
    }
    if (st && st.ebayMode && st.ebayMode !== "seller" && !st.catalog) {
      const why = st.ebayMode === "none" ? "You said you don't have an eBay account" : "You said you don't sell on eBay";
      return `<div class="eif-mine-note">${why}, so there are no Seller Hub listings to sync. Listings you protect by hand are below. <button type="button" class="eif-link-btn" data-action="ebay-open-setup">Change on the setup page</button></div>`;
    }
    const busy = run && (run.state === "syncing" || run.state === "finalizing");
    return `<div class="eif-mine-note">${line} ${busy ? "" : '<button type="button" class="eif-link-btn" data-action="ebay-sync-now">Sync now</button>'}</div>`;
  }

  async function ebayCatalogHas(itemNumber) {
    if (ebayOwnItems.has(itemNumber)) return true;
    if (!hasStorage) return false;
    ebayOwnAsked.delete(itemNumber);
    await ebayOwnEnsure([itemNumber], 6000);
    return ebayOwnItems.has(itemNumber);
  }
  async function merchHas(asin, fresh) {
    if (merchIsOwn(asin)) return true;
    if (!merchConnected()) return false;
    const res = await bgSend({ type: "eif-merch-lookup", items: [{ asin, marketplace: mpOfAsin(asin), pageAsins: [] }], fresh: !!fresh });
    const r = res && res.ok && res.results && res.results[`${mpOfAsin(asin)}|${asin}`];
    if (r) merchResults.set(`${mpOfAsin(asin)}|${asin}`, r);
    return !!(r && r.state === "catalog_matched");
  }

  function askMine(kind, id) {
    const overlay = popup && popup.overlay;
    if (!overlay) return Promise.resolve(null);
    const amazon = kind === "amazon";
    const where = amazon ? "Merch" : "eBay";
    if (amazon ? merchIsOwn(id) : ebayOwnItems.has(id)) {
      showToast(amazon ? `${id} is already in your Merch catalog` : `#${id} is already in your synced eBay listings`);
      return Promise.resolve("recognised");
    }
    const canSync = amazon ? merchConnected() : setupEbayMode === "seller";
    const noSync = amazon
      ? "Your Merch account isn't connected, so there's nothing to re-sync. You can connect it on the setup page."
      : "You said you don't sell on eBay, so there are no synced eBay listings to check.";
    const label = amazon ? id : `#${id}`;
    const old = overlay.querySelector(".eif-mine-ask");
    if (old) old.remove();
    const box = document.createElement("div");
    box.className = "eif-mine-ask";
    box.innerHTML = `
      <div class="eif-mine-card" role="dialog" aria-modal="true" aria-labelledby="eif-mine-ask-h">
        <div class="eif-mine-ask-h" id="eif-mine-ask-h">Mark <span class="eif-mine-ask-id">${escapeHtml(label)}</span> as yours?</div>
        <div class="eif-mine-ask-sub">Copycat Hunt didn't recognise it as yours. Why not?</div>
        <label class="eif-mine-opt"><input type="radio" name="eif-mine-why" value="other" />
          <span><b>It's from another ${where} account I own</b><small>It stays marked by hand, with a note.</small></span></label>
        <div class="eif-mine-more" data-for="other" hidden><input type="text" class="eif-mine-label" maxlength="40" placeholder="Which account? (optional, e.g. Account 2)" /></div>
        <label class="eif-mine-opt${canSync ? "" : " eif-mine-opt-off"}"><input type="radio" name="eif-mine-why" value="missed" ${canSync ? "" : "disabled"} />
          <span><b>It's on my connected ${where} account, but wasn't picked up</b><small>${canSync ? "Re-sync first: if the sync finds it, there's nothing to mark." : escapeHtml(noSync)}</small></span></label>
        <div class="eif-mine-more" data-for="missed" hidden>
          <button type="button" class="eif-hunt-btn eif-hunt-btn-primary eif-mine-sync">Re-sync now</button>
          <span class="eif-mine-sync-msg"></span>
        </div>
        <label class="eif-mine-tick"><input type="checkbox" class="eif-mine-ok" /> <span>This listing is really mine. I take responsibility for reports based on it.</span></label>
        <div class="eif-mine-btns">
          <button type="button" class="eif-hunt-btn eif-mine-cancel">Cancel</button>
          <button type="button" class="eif-hunt-btn eif-hunt-btn-green eif-mine-go" disabled>Mark as mine</button>
        </div>
      </div>`;
    overlay.appendChild(box);
    const q = (sel) => box.querySelector(sel);
    let synced = false;
    let syncing = false;
    return new Promise((resolve) => {
      const close = (v) => {
        box.remove();
        window.removeEventListener("keydown", onKey, true);
        resolve(v);
      };
      const why = () => (box.querySelector('input[name="eif-mine-why"]:checked') || {}).value || "";
      const refresh = () => {
        const w = why();
        box.querySelectorAll(".eif-mine-more").forEach((el) => { el.hidden = el.dataset.for !== w; });
        q(".eif-mine-go").disabled = !(w && q(".eif-mine-ok").checked && (w !== "missed" || synced) && !syncing);
        q(".eif-mine-go").textContent = w === "missed" && synced ? "Mark anyway" : "Mark as mine";
      };
      const onKey = (e) => { if (e.key === "Escape") { e.stopImmediatePropagation(); e.preventDefault(); close(null); } };
      window.addEventListener("keydown", onKey, true);
      box.addEventListener("change", refresh);
      box.addEventListener("click", async (e) => {
        if (e.target === box || e.target.closest(".eif-mine-cancel")) return close(null);
        if (e.target.closest(".eif-mine-go")) {
          const w = why();
          if (!w || !q(".eif-mine-ok").checked) return;
          setMineNote(`${kind}:${id}`, { reason: w, label: w === "other" ? q(".eif-mine-label").value.trim().slice(0, 40) : "", at: today() });
          return close("marked");
        }
        if (e.target.closest(".eif-mine-sync") && !syncing) {
          syncing = true;
          const msg = q(".eif-mine-sync-msg");
          q(".eif-mine-sync").disabled = true;
          msg.innerHTML = `${LOADER()}Syncing your ${where} listings…`;
          refresh();
          let found = false;
          let problem = "";
          try {
            if (amazon) {
              const res = await bgSend({ type: "eif-merch-sync" });
              if (!(res && res.ok)) problem = merchReasonText(res?.meta?.lastError || res?.identity?.reason || "no_reply");
              loadMerchMeta(() => {});
              found = await merchHas(id, true);
            } else {
              const r = await bgSend({ type: "eif-ebay-sync" });
              if (!r || r.error) problem = r && r.error === "signed_out" ? "Sign in to eBay first." : "Couldn't start the eBay sync.";
              else {
                for (let i = 0; i < 90; i++) {
                  const st = await bgSend({ type: "eif-ebay-catalog-status" });
                  const run = st && st.run;
                  if (!run || (run.state !== "syncing" && run.state !== "finalizing")) {
                    if (st && st.meta && st.meta.state === "failed") problem = `The sync stopped${st.meta.lastError ? ` (${st.meta.lastError})` : ""}.`;
                    break;
                  }
                  msg.innerHTML = `${LOADER()}Reading your Seller Hub listings… ${Number(run.rawScanned) || 0}${run.expectedTotal != null ? ` of ${Number(run.expectedTotal)}` : ""}`;
                  await new Promise((res) => setTimeout(res, 2000));
                  if (!box.isConnected) return;
                }
                ebaySync.status = null;
                loadEbaySync();
              }
              found = await ebayCatalogHas(id);
            }
          } catch (err) { problem = "The sync didn't finish."; }
          syncing = false;
          synced = true;
          if (!box.isConnected) return;
          if (found) {
            showToast(`Found ${label} in your synced ${where} listings. It's recognised as yours automatically.`);
            return close("recognised");
          }
          msg.innerHTML = `<span class="eif-rp-warn">${escapeHtml(problem || `Still not in your synced ${where} listings.`)}</span> You can mark it anyway.`;
          q(".eif-mine-sync").disabled = false;
          q(".eif-mine-sync").textContent = "Sync again";
          refresh();
        }
      });
      const first = box.querySelector('input[name="eif-mine-why"]');
      if (first) first.focus();
    });
  }

  function protectFromInput() {
    const input = popup && popup.overlay.querySelector("#eif-protect-input");
    if (!input) return;
    const n = normalizeItemNumber(input.value);
    if (!n) return showToast("Enter a valid eBay item number");
    if (isMineEbay(n)) return showToast(`#${n} is already yours`);
    askMine("ebay", n).then((r) => {
      if (r === "marked") protectItem(n);
      if (r) { input.value = ""; if (popup && popup.tab === "mine") renderMineView(); }
    });
  }

  async function mineLookup() {
    const view = viewEl();
    const input = view && view.querySelector("#eif-mine-lookup-input");
    const out = view && view.querySelector("#eif-mine-lookup-res");
    if (!input || !out) return;
    const raw = input.value.trim();
    const asin = AZ.normalizeAsin(AZ.asinFromUrl ? AZ.asinFromUrl(raw) || raw : raw);
    const n = asin ? "" : normalizeItemNumber(raw);
    const say = (ok, text) => { out.className = `eif-mine-lookup-res ${ok ? "eif-ok" : "eif-no"}`; out.innerHTML = text; };
    if (asin) {
      if (amazonMine.has(asin)) return say(true, `✓ ${asin} is marked as yours by hand.`);
      if (!merchConnected()) return say(false, `${asin} isn't marked as yours, and your Merch catalog isn't connected.`);
      out.className = "eif-mine-lookup-res"; out.innerHTML = `${LOADER()}Checking…`;
      return (await merchHas(asin, false)) ? say(true, `✓ ${asin} is in your Merch catalog. It's recognised automatically.`) : say(false, `${asin} isn't in your Merch catalog. If it's yours, re-sync or mark it with "This is mine" on its card.`);
    }
    if (n) {
      if (protectedItems.has(n)) return say(true, `✓ #${n} is marked as yours by hand.`);
      return (await ebayCatalogHas(n)) ? say(true, `✓ #${n} is in your synced eBay listings. It's recognised automatically.`) : say(false, `#${n} isn't in your synced eBay listings.${setupEbayMode === "seller" ? " If it's yours, press Sync now or protect it above." : ""}`);
    }
    say(false, "Enter an eBay item number or an Amazon ASIN.");
  }

  const BS_DAYS = [7, 30, 90, 365];
  const BS_INFO_KEY = "eifBestSellerInfo";
  const BS_STALE_HUNT_MS = 30 * 24 * 60 * 60 * 1000;
  const BS_GONE_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
  const bsFlag = (m) => `<img class="eif-bs-flag" src="${chrome.runtime.getURL(`icons/flags/${m.toLowerCase()}.svg`)}" alt="${escapeHtml(AZ.MARKETPLACES[m].label)}" title="${escapeHtml(AZ.MARKETPLACES[m].label)}" />`;
  const bs = { days: 30, mp: "", data: null, loading: false, retry: false, info: new Map(), infoRead: false, asked: new Set(), q: "", page: 0 };
  const BS_PAGE = 50;
  if (hasStorage) {
    chrome.storage.local.get({ eifBestSellersView: null, [BS_INFO_KEY]: {} }, (d) => {
      const v = d.eifBestSellersView;
      if (v && BS_DAYS.includes(v.days)) bs.days = v.days;
      if (v && typeof v.mp === "string" && (!v.mp || AZ.MARKETPLACES[v.mp])) bs.mp = v.mp;
      for (const [k, x] of Object.entries(d[BS_INFO_KEY] || {})) if (x && typeof x === "object") bs.info.set(k, x);
      bs.infoRead = true;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.eifSalesMeta) return;
      const v = changes.eifSalesMeta.newValue || {};
      const was = changes.eifSalesMeta.oldValue || {};
      if (!popup || popup.tab !== "bestsellers") return;
      if (bs.data && bs.data.sales) bs.data.sales = { ...bs.data.sales, state: v.state, done: v.done || 0, total: v.total || 0 };
      if (v.state !== was.state) { bs.data = null; loadBestSellers(); }
      else renderBestSellersView();
    });
  }

  function loadBestSellers() {
    if (bs.loading) return;
    bs.loading = true;
    const retry = bs.retry;
    bs.retry = false;
    if (popup && popup.tab === "bestsellers") renderBestSellersView();
    bgSend({ type: "eif-best-sellers", days: bs.days, marketplace: bs.mp, retry }).then((r) => {
      bs.loading = false;
      bs.data = r && typeof r === "object" ? r : { ok: false, error: "network" };
      if (popup && popup.tab === "bestsellers") renderBestSellersView();
      bsFillInfo();
    });
  }

  const bsKey = (mp, asin) => `${mp}|${asin}`;

  async function bsFillInfo() {
    const designs = bsView().shown.map((x) => x.d);
    for (const d of designs) {
      const k = bsKey(d.marketplace, d.asin);
      const had = bs.info.get(k);
      if ((had && !(had.gone && Date.now() - (had.at || 0) > BS_GONE_RECHECK_MS)) || bs.asked.has(k)) continue;
      bs.asked.add(k);
      const L = await bgSend({ type: "eif-amazon-listing", asin: d.asin, marketplace: d.marketplace });
      if (L && L.state === "missing") bs.info.set(k, { gone: true, at: Date.now() });
      else if (!L || L.state !== "ready") continue;
      else bs.info.set(k, { title: String(L.title || "").slice(0, 200), image: /^https:/.test(L.image || "") ? L.image : "", at: Date.now() });
      bsSaveInfo();
      if (popup && popup.tab === "bestsellers") renderBestSellersView();
    }
  }

  let bsSaveTimer = 0;
  function bsSaveInfo() {
    if (!hasStorage) return;
    clearTimeout(bsSaveTimer);
    bsSaveTimer = setTimeout(() => {
      const keep = [...bs.info.entries()].sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 400);
      chrome.storage.local.set({ [BS_INFO_KEY]: Object.fromEntries(keep) });
    }, 500);
  }

  function bsLastHunt(d) {
    let last = 0;
    for (const l of d.listings || [{ asin: d.asin }]) {
      const h = hunts.get(`amz:${l.asin}`);
      const t = h ? Date.parse(h.last || h.at || "") || 0 : 0;
      if (t > last) last = t;
    }
    return last;
  }

  function bsHuntTag(d) {
    const last = bsLastHunt(d);
    if (!last) return '<span class="eif-bs-pill eif-bs-due">Not hunted yet</span>';
    if (Date.now() - last > BS_STALE_HUNT_MS) return '<span class="eif-bs-pill eif-bs-due eif-bs-stale">Not hunted in 30+ days</span>';
    return `<span class="eif-bs-pill eif-bs-hunted">Hunted ${escapeHtml(bsDate(last))}</span>`;
  }

  const bsDate = (t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  function bsView() {
    const ranked = [];
    ((bs.data && bs.data.designs) || []).forEach((d, i) => {
      if (!(bs.info.get(bsKey(d.marketplace, d.asin)) || {}).gone) ranked.push({ d, i, rank: ranked.length + 1 });
    });
    const q = bs.q.trim().toLowerCase();
    const found = !q ? ranked : ranked.filter(({ d }) => (d.listings || [d]).some((l) => l.asin.toLowerCase().includes(q) || String((bs.info.get(bsKey(l.marketplace, l.asin)) || {}).title || "").toLowerCase().includes(q)));
    const pages = Math.max(1, Math.ceil(found.length / BS_PAGE));
    if (bs.page >= pages) bs.page = pages - 1;
    return { ranked, found, pages, shown: found.slice(bs.page * BS_PAGE, (bs.page + 1) * BS_PAGE) };
  }

  function bsDownloadCsv() {
    const rows = bsView().found.map(({ d, rank }) => {
      const info = bs.info.get(bsKey(d.marketplace, d.asin)) || {};
      const last = bsLastHunt(d);
      return [rank, d.asin, AZ.MARKETPLACES[d.marketplace] ? AZ.MARKETPLACES[d.marketplace].label : d.marketplace, info.title || "", d.units, (d.marketplaces || []).map((m) => (AZ.MARKETPLACES[m] || { label: m }).label).join(" "), last ? new Date(last).toISOString().slice(0, 10) : ""];
    });
    const head = ["Rank", "ASIN", "Marketplace", "Title", "Sold", "Sold on", "Last hunted"];
    const csv = [head, ...rows].map((r) => r.map(AZ.csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `best-sellers-${bs.days === 365 ? "12-months" : `${bs.days}-days`}-${today()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function bsHunt(row) {
    const d = row && bs.data && bs.data.designs && bs.data.designs[Number(row.dataset.bs)];
    if (!d) return;
    const here = (d.listings || []).find((l) => l.marketplace === PAGE_MP);
    if (!here) {
      const url = AZ.productUrl(d.marketplace, d.asin);
      if (url) window.open(`${url}#eif-hunt`, "_blank", "noopener");
      showToast(`Opening ${AZ.MARKETPLACES[d.marketplace].label} to hunt there`);
      return;
    }
    const info = bs.info.get(bsKey(here.marketplace, here.asin)) || bs.info.get(bsKey(d.marketplace, d.asin)) || {};
    const go = (image, title) => {
      const img = normalizeImageUrl(image);
      if (!img) return showToast("Couldn't get this product's picture. Open it and hunt from its page.");
      asinMarket.set(here.asin, here.marketplace);
      startSearch({ imageUrl: img, file: null, itemNumber: null, designAsin: here.asin, huntTitle: title || here.asin });
    };
    if (info.image) return go(info.image, info.title);
    showToast("Getting the product picture…");
    bgSend({ type: "eif-amazon-listing", asin: here.asin, marketplace: here.marketplace, priority: "high" }).then((L) => go(L && L.state === "ready" ? L.image : "", L && L.title));
  }

  const BS_REASONS = {
    logged_out: "Your Merch sign-in ended, so your sales couldn't be read. Sign in to merch.amazon.com, then try again.",
    rate_limited: "Merch is limiting requests right now. Try again in a few minutes.",
    no_catalog: "Your products have to be synced first.",
    unexpected_response: "Merch sent your sales in a format the extension doesn't recognise.",
  };

  function renderBestSellersView() {
    const view = viewEl();
    if (!view) return;
    if (!bs.data && !bs.loading) loadBestSellers();
    const r = bs.data;
    const sales = (r && r.sales) || {};
    const opts = (list, cur) => list.map(([v, label]) => `<option value="${v}"${String(v) === String(cur) ? " selected" : ""}>${label}</option>`).join("");
    const searchFocused = document.activeElement && document.activeElement.id === "eif-bs-search";
    const caret = searchFocused ? document.activeElement.selectionStart : 0;
    const controls = `<div class="eif-bs-controls">
        <label class="eif-bs-search"><input id="eif-bs-search" type="search" placeholder="Search ASIN or title" value="${escapeHtml(bs.q)}" autocomplete="off" aria-label="Search ASIN or title" /></label>
        <select id="eif-bs-days" aria-label="Period">${opts(BS_DAYS.map((n) => [n, n === 365 ? "Last 12 months" : `Last ${n} days`]), bs.days)}</select>
        <select id="eif-bs-mp" aria-label="Marketplace">${opts([["", "All marketplaces"], ...Object.entries(AZ.MARKETPLACES).map(([k, m]) => [k, m.label])], bs.mp)}</select>
        <button type="button" class="eif-bs-export" data-action="bs-export" ${r && r.ok && r.designs.length ? "" : "disabled"}>Export CSV</button>
      </div>`;
    const head = `<div class="eif-list-head"><div><div class="eif-list-title">Best sellers</div><div class="eif-list-sub">Your designs that sell the most. Copycats go after these first.</div></div>${controls}</div>`;
    const loadingSales = sales.state === "loading" && !sales.stuck;
    const salesBar = loadingSales ? `<div class="eif-bs-progress"><div class="eif-bs-bar${sales.total ? "" : " eif-bs-bar-indet"}"><i style="width:${sales.total ? Math.round((sales.done / sales.total) * 100) : 30}%"></i></div><span>Reading your sales from Merch${sales.total ? ` · ${sales.done} of ${sales.total} months` : "…"}</span></div>` : "";
    let bodyHtml;
    if (!merchConnected() && !(r && r.catalog)) {
      bodyHtml = emptyStateHtml("Connect your Merch account", "Best sellers comes from your own Merch sales. Connect your account on the setup page.", [{ label: "Open setup", action: "ebay-open-setup", primary: true }]);
    } else if (!r) {
      bodyHtml = '<div class="eif-center eif-bs-wait"><div class="eif-bs-bar eif-bs-bar-indet"><i></i></div></div>';
    } else if (!r.ok) {
      bodyHtml = emptyStateHtml("Best sellers can't be shown right now", "The list saved on this computer couldn't be read. Try again in a minute.", [{ label: "Try again", action: "bs-retry", primary: true }]);
    } else if (!r.designs.length) {
      if (loadingSales || (!r.covered && !sales.error)) bodyHtml = `<div class="eif-center eif-empty-state"><div class="eif-empty-title">Reading your sales</div><div class="eif-empty-sub">This happens once, then only new days are read.</div>${salesBar || '<div class="eif-bs-progress"><div class="eif-bs-bar eif-bs-bar-indet"><i></i></div></div>'}</div>`;
      else if (sales.state === "failed") bodyHtml = emptyStateHtml("Your sales couldn't be read", escapeHtml(BS_REASONS[sales.error] || "Couldn't reach Merch. Try again in a minute."), [{ label: "Try again", action: "bs-retry", primary: true }]);
      else bodyHtml = emptyStateHtml("No sales in this period", bs.mp ? `Nothing sold on ${escapeHtml(AZ.MARKETPLACES[bs.mp].label)} in this period. Try all marketplaces or a longer period.` : "Try a longer period.");
    } else {
      const v = bsView();
      const period = bs.days === 365 ? "12 months" : `${bs.days} days`;
      const rows = v.shown
        .map(({ d, i, rank }) => {
          const info = bs.info.get(bsKey(d.marketplace, d.asin)) || {};
          const url = AZ.productUrl(d.marketplace, d.asin);
          const mps = (d.marketplaces || []).filter((m) => AZ.MARKETPLACES[m]).map(bsFlag).join("");
          return `<div class="eif-bs-row" data-bs="${i}">
            <span class="eif-bs-rank${rank <= 3 ? " eif-bs-top" : ""}">${rank}</span>
            <a class="eif-bs-thumb" href="${escapeHtml(url)}" target="_blank" rel="noopener" tabindex="-1">${info.image ? `<img src="${safeSrc(info.image)}" alt="" loading="lazy" />` : "<span></span>"}</a>
            <div class="eif-bs-product">
              <div class="eif-bs-asin"><span>${escapeHtml(d.asin)}</span><button type="button" class="eif-bs-copy" data-action="bs-copy" title="Copy ASIN" aria-label="Copy ASIN ${escapeHtml(d.asin)}"></button></div>
              <a class="eif-bs-title" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="${escapeHtml(info.title || "")}">${info.title ? escapeHtml(info.title) : '<span class="eif-bs-title-wait">Getting the title…</span>'}</a>
            </div>
            <span class="eif-bs-flags">${mps}</span>
            <span class="eif-bs-status">${bsHuntTag(d)}</span>
            <div class="eif-bs-units"><b>${d.units.toLocaleString("en-US")}</b><span>sold</span></div>
            <div class="eif-bs-actions">
              <a class="eif-bs-open" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="Open on ${escapeHtml(AZ.MARKETPLACES[d.marketplace].label)}" aria-label="Open on ${escapeHtml(AZ.MARKETPLACES[d.marketplace].label)}"></a>
              <button class="eif-hunt-btn eif-hunt-btn-primary eif-bs-hunt" type="button" data-action="bs-hunt" title="Hunt for look-alikes of this design">Hunt</button>
            </div>
          </div>`;
        })
        .join("");
      const th = `<div class="eif-bs-row eif-bs-th" aria-hidden="true"><span>Rank</span><span></span><span>Product</span><span>Sold on</span><span>Hunt status</span><span class="eif-bs-units">Sold</span><span></span></div>`;
      const from = v.found.length ? bs.page * BS_PAGE + 1 : 0;
      const to = Math.min(v.found.length, (bs.page + 1) * BS_PAGE);
      const of = bs.q.trim() ? `${v.found.length.toLocaleString("en-US")} matching` : `${v.found.length.toLocaleString("en-US")}`;
      const capped = !bs.q.trim() && r.total > r.designs.length ? ` · top ${r.designs.length} of ${r.total.toLocaleString("en-US")} that sold` : "";
      const pager = v.pages > 1 ? `<div class="eif-bs-pager"><button type="button" class="eif-bs-pg" data-action="bs-page" data-go="-1" ${bs.page ? "" : "disabled"}>Previous</button><span>${bs.page + 1} / ${v.pages}</span><button type="button" class="eif-bs-pg" data-action="bs-page" data-go="1" ${bs.page < v.pages - 1 ? "" : "disabled"}>Next</button></div>` : "";
      const foot = `<div class="eif-bs-foot"><span>Showing <b>${from}–${to}</b> of <b>${of}</b> design${v.found.length === 1 ? "" : "s"}${capped} · last ${period}</span>${pager}</div>`;
      const failedNote = sales.state === "failed" ? `<div class="eif-mine-note eif-bs-note">${escapeHtml(BS_REASONS[sales.error] || "Your newest sales couldn't be read.")} <button type="button" class="eif-link-btn" data-action="bs-retry">Try again</button></div>` : "";
      const table = v.shown.length ? `<div class="eif-bs-table">${th}${rows}</div>${foot}` : `<div class="eif-center"><div class="eif-empty-sub">Nothing matches that search.</div></div>`;
      bodyHtml = `<div class="eif-scroll">${salesBar}${failedNote}${table}</div>`;
    }
    const scroll = view.querySelector(".eif-scroll");
    const top = scroll ? scroll.scrollTop : 0;
    view.innerHTML = head + bodyHtml;
    const again = view.querySelector(".eif-scroll");
    if (again && top) again.scrollTop = top;
    if (searchFocused) {
      const input = view.querySelector("#eif-bs-search");
      input.focus();
      try { input.setSelectionRange(caret, caret); } catch (e) {}
    }
  }

  if (SITE === "amazon" && location.hash === "#eif-hunt") {
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    const startPageHunt = (tries) => {
      const main = document.getElementById("landingImage");
      const img = main && normalizeImageUrl(main.getAttribute("data-old-hires") || main.getAttribute("src"));
      if (img && currentPageAsin() && signedInState() !== null) startSearch({ imageUrl: img, file: null, itemNumber: null });
      else if (tries > 0) setTimeout(() => startPageHunt(tries - 1), 500);
    };
    setTimeout(() => startPageHunt(20), 800);
  }

  function emptyStateHtml(title, sub, buttons = []) {
    return `
      <div class="eif-center eif-empty-state">
        <div class="eif-empty-title">${title}</div>
        <div class="eif-empty-sub">${sub}</div>
        ${buttons.length ? `<div class="eif-empty-btns">${buttons
          .map((b) => `<button class="eif-hunt-btn ${b.primary ? "eif-hunt-btn-primary" : ""}" type="button" data-action="${b.action}" ${b.go ? `data-go="${b.go}"` : ""}>${b.label}</button>`)
          .join("")}</div>` : ""}
      </div>`;
  }

  function findButtons() {
    return lastSearch ? [{ label: "Back to Find", action: "go-tab", go: "results", primary: true }] : [{ label: "Upload an image", action: "upload", primary: true }];
  }

  function renderMineView() {
    const view = viewEl();
    if (!view) return;
    const input = view.querySelector("#eif-protect-input");
    const draft = input ? input.value : "";
    const hadFocus = input && document.activeElement === input;

    const lookupDraft = (view.querySelector("#eif-mine-lookup-input") || {}).value || "";
    const lookupRes = view.querySelector("#eif-mine-lookup-res");
    const lookupHtml = lookupRes ? lookupRes.outerHTML : '<div id="eif-mine-lookup-res" class="eif-mine-lookup-res"></div>';

    const ebayRows = [...protectedItems]
      .map((itemNumber) => {
        const info = originals[itemNumber] || {};
        if (!info.fetched && (!info.title || !info.image)) fetchEbayOriginal(itemNumber);
        const loading = !info.title && !info.fetched;
        return `
        <div class="eif-tr-row eif-mine-row" data-item-number="${itemNumber}">
          <a class="eif-mine-thumb" href="https://www.ebay.com/itm/${itemNumber}" target="_blank" rel="noopener">
            ${info.image ? `<img src="${safeSrc(info.image)}" alt="" loading="lazy" />` : '<span class="eif-mine-ph"></span>'}
            <span class="eif-mine-badge" title="Protected: never tracked, never reported">✓</span>
          </a>
          <div class="eif-tr-main">
            <a class="eif-tr-title eif-mine-title" href="https://www.ebay.com/itm/${itemNumber}" target="_blank" rel="noopener" title="${escapeHtml(info.title || "")}">${
              info.title ? escapeHtml(info.title) : loading ? '<span class="eif-rp-muted">Loading title…</span>' : "Untitled listing"
            }</a>
            <div class="eif-tr-sub"><span class="eif-site-tag eif-site-ebay">eBay</span><span class="eif-tr-num">#${itemNumber}</span> · <span class="eif-mine-why">${mineNoteText(`ebay:${itemNumber}`)}</span></div>
          </div>
          <button class="eif-hunt-btn" type="button" data-action="hj-check" title="Look for listings that copy this listing's title or photos">Check for hijacks</button>
          <button class="eif-row-x" type="button" data-action="unprotect" title="Remove: no longer treated as yours">&times;</button>
        </div>`;
      })
      .join("");
    const amazonRows = [...amazonMine]
      .map((a) => `<div class="eif-tr-row eif-mine-row" data-asin="${a}">
          <div class="eif-tr-main"><a class="eif-tr-title" href="${escapeHtml(amzUrl(a))}" target="_blank" rel="noopener">${a}</a>
          <div class="eif-tr-sub"><span class="eif-site-tag eif-site-amazon">Amazon</span><span class="eif-mine-why">${mineNoteText(`amazon:${a}`)}</span></div></div>
          <button class="eif-hunt-btn" type="button" data-action="amz-mine" title="Stop treating this product as yours">Not mine</button>
        </div>`)
      .join("");
    const handCount = protectedItems.size + amazonMine.size;
    const merchLine = merchConnected()
      ? `<span class="eif-rp-ok">✓</span> <b>${(Number(merchMeta.count) || 0).toLocaleString("en-US")} listings</b> in your Merch catalog, recognised automatically. <button type="button" class="eif-link-btn" data-action="az-merch-sync">Sync now</button>`
      : 'Merch catalog not connected. <button type="button" class="eif-link-btn" data-action="ebay-open-setup">Connect it on the setup page</button>';

    view.innerHTML = `
      <div class="eif-list-head">
        <div>
          <div class="eif-list-title">My listings</div>
          <div class="eif-list-sub">Your listings are outlined in results and can't be tracked or reported.</div>
        </div>
        <div class="eif-protect-form">
          <input id="eif-protect-input" inputmode="numeric" maxlength="15" placeholder="eBay item number" />
          <button class="eif-hunt-btn eif-hunt-btn-green" type="button" data-action="protect-add">Protect</button>
        </div>
      </div>
      <div class="eif-scroll">
        <div class="eif-mine-sec-h">Recognised automatically</div>
        <div class="eif-mine-auto">
          <div class="eif-mine-auto-row"><span class="eif-site-tag eif-site-amazon">Amazon</span><div class="eif-mine-auto-line">${merchLine}</div></div>
          <div class="eif-mine-auto-row"><span class="eif-site-tag eif-site-ebay">eBay</span><div class="eif-mine-auto-line">${ebaySyncedHtml().replace(/^<div class="eif-mine-note">|<\/div>$/g, "")}</div></div>
          <div class="eif-mine-lookup">
            <label for="eif-mine-lookup-input">Is this one recognised?</label>
            <input id="eif-mine-lookup-input" maxlength="200" placeholder="eBay item number or Amazon ASIN" />
            <button class="eif-hunt-btn" type="button" data-action="mine-check">Check</button>
          </div>
          ${lookupHtml}
        </div>
        <div class="eif-mine-sec-h">Marked by you <span>${handCount}</span></div>
        <div class="eif-mine-note">Listings from your other accounts, or ones the sync missed. Each one shows why it was marked.</div>
        ${handCount ? `<div class="eif-list eif-tr-list eif-mine-list">${amazonRows}${ebayRows}</div>` : '<div class="eif-mine-empty">None yet. Use "This is mine" on a result, "Protect as mine" after a search, or the item number box above.</div>'}
      </div>`;
    const li = view.querySelector("#eif-mine-lookup-input");
    if (li) li.value = lookupDraft;
    const newInput = view.querySelector("#eif-protect-input");
    newInput.value = draft;
    if (hadFocus) newInput.focus();
  }

  const PREF_DEFAULTS = Object.freeze({
    searchEbay: true,
    searchAmazon: true,
    autoTextCheck: true,
    widgetEbay: true,
    widgetAmazon: true,
    pageBadges: true,
    hoverPanel: true,
    detectOwn: true,
    autoMerchSync: true,
    askReason: true,
    heartbeat: true,
    animations: true,
    scorer: false,
    saveTestSet: false,
  });
  let prefs = { ...PREF_DEFAULTS };
  function readPrefs(raw) {
    const p = { ...PREF_DEFAULTS };
    if (raw && typeof raw === "object") Object.keys(PREF_DEFAULTS).forEach((k) => typeof raw[k] === "boolean" && (p[k] = raw[k]));
    if (!p.searchEbay && !p.searchAmazon) p.searchEbay = p.searchAmazon = true;
    return p;
  }
  function widgetWanted() {
    return SITE === "amazon" ? prefs.widgetAmazon : prefs.widgetEbay;
  }
  function applyPrefs(old) {
    document.documentElement.classList.toggle("eif-no-motion", prefs.animations === false);
    const w = document.getElementById("eif-widget");
    if (w) w.style.display = widgetWanted() ? "" : "none";
    if (!widgetWanted() && typeof closeMini === "function") closeMini();
    if (old && old.pageBadges && !prefs.pageBadges) document.querySelectorAll(".eif-badge").forEach((b) => b.remove());
    if (old && !old.pageBadges && prefs.pageBadges && SITE === "ebay") scan();
    if (!prefs.heartbeat && heartbeatEl) heartbeatEl.className = "";
    if (popup && popup.tab === "results" && lastSearch) renderResultsView();
  }

  let heartbeatEl = null;
  let heartbeatBusy = false;
  function heartbeatState() {
    const s = lastSearch;
    const T = s && s.amazonText;
    const busy =
      (s && s.state === "loading") ||
      (s && s.amazon && s.amazon.state === "loading") ||
      (T && (T.state === "reading" || T.state === "loading")) ||
      (lastHijack && lastHijack.state === "loading") ||
      (lastAzHijack && lastAzHijack.state === "loading");
    const trouble =
      (s && (s.state === "error" || s.state === "offline")) ||
      (s && s.amazon && (s.amazon.state === "blocked" || s.amazon.state === "error")) ||
      (T && (T.state === "blocked" || T.state === "partial" || T.state === "error")) ||
      (lastHijack && (lastHijack.state === "error" || lastHijack.state === "offline")) ||
      (lastAzHijack && (lastAzHijack.state === "blocked" || lastAzHijack.state === "error" || (lastAzHijack.notes || []).length > 0));
    return { busy: !!busy, trouble: !!trouble };
  }
  function updateHeartbeat() {
    if (!prefs.heartbeat) return;
    const { busy, trouble } = heartbeatState();
    if (busy === heartbeatBusy) return;
    if (!heartbeatEl) {
      heartbeatEl = document.createElement("div");
      heartbeatEl.id = "eif-heartbeat";
      heartbeatEl.setAttribute("aria-hidden", "true");
      document.documentElement.appendChild(heartbeatEl);
    }
    heartbeatBusy = busy;
    if (busy) {
      heartbeatEl.className = "eif-hb-on";
    } else {
      heartbeatEl.className = trouble ? "eif-hb-warn" : "eif-hb-done";
      clearTimeout(heartbeatEl._t);
      heartbeatEl._t = setTimeout(() => {
        if (!heartbeatBusy) heartbeatEl.className = "";
      }, 1600);
    }
  }

  let licOk = false;
  let licStatus = { ok: false, code: "CHECKING", message: "Checking your license…" };
  let mainStarted = false;
  let lockDismissed = false;
  let statusSeq = 0;
  function onReportForm() {
    return SITE === "amazon" && /^\/report\/infringement\/?$/.test(location.pathname);
  }
  function startMain() {
    if (mainStarted) return;
    mainStarted = true;
    initMain();
    if (!widgetWanted()) applyPrefs(null);
  }
  function applyLicense(st) {
    const ok = !!(st && st.ok === true && st.code === "VALID");
    licStatus = st && typeof st === "object" ? st : { ok: false, code: "UNAVAILABLE" };
    licOk = ok;
    document.documentElement.classList.toggle("eif-locked", !ok);
    if (ok) {
      removeLockCard();
      startMain();
      return;
    }
    if (popup) closePopup();
    if (typeof closeMini === "function" && mainStarted) closeMini();
    showLockCard();
  }
  function refreshLicense() {
    const mySeq = ++statusSeq;
    return bgSend({ type: "eif-license-status" }).then((r) => {
      if (mySeq !== statusSeq) return;
      if (!r || typeof r !== "object" || typeof r.ok !== "boolean") {
        applyLicense({ ok: false, code: "UNAVAILABLE", message: "Copycat Hunt couldn't start on this page. Reload the page; if that doesn't help, restart Chrome." });
      } else applyLicense(r);
    });
  }
  function removeLockCard() {
    const el = document.getElementById("eif-lock");
    if (el) el.remove();
  }
  function lockText() {
    const c = licStatus.code;
    if (c === "NO_KEY") return "Copycat Hunt needs a license key. Click the Copycat Hunt icon in Chrome's toolbar to enter it.";
    const m = typeof licStatus.message === "string" ? licStatus.message.slice(0, 300) : "";
    return m || "Copycat Hunt is locked. Open the Copycat Hunt menu in Chrome's toolbar.";
  }
  function showLockCard() {
    if (onReportForm() || lockDismissed || !widgetWanted()) return removeLockCard();
    let card = document.getElementById("eif-lock");
    if (!card) {
      card = document.createElement("div");
      card.id = "eif-lock";
      card.setAttribute("role", "status");
      card.setAttribute("aria-label", "Copycat Hunt license");
      card.addEventListener("click", onLockClick);
      document.body.appendChild(card);
    }
    const checking = licStatus.code === "CHECKING";
    card.innerHTML = `
      <div class="eif-lock-h"><span class="eif-lock-icon">${LOGO}</span><b>Copycat Hunt</b><button type="button" class="eif-lock-x" data-lock="close" aria-label="Hide">×</button></div>
      <p class="eif-lock-msg">${escapeHtml(lockText())}</p>
      ${checking ? "" : `<div class="eif-lock-row"><button type="button" class="eif-lock-btn eif-lock-primary" data-lock="menu">Open license settings</button></div>`}`;
  }
  function onLockClick(e) {
    const b = e.target.closest("[data-lock]");
    if (!b) return;
    const what = b.dataset.lock;
    const card = document.getElementById("eif-lock");
    if (what === "close") { lockDismissed = true; removeLockCard(); }
    else if (what === "menu") openMenuPanel();
  }

  let menuPanel = null;
  function openMenuPanel() {
    if (menuPanel) return;
    updateSafeBottom();
    const wrap = document.createElement("div");
    wrap.id = "eif-menu-panel";
    const frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL("popup.html");
    frame.title = "Copycat Hunt";
    wrap.appendChild(frame);
    document.documentElement.appendChild(wrap);
    menuPanel = { wrap, frame };
    frame.addEventListener("load", () => frame.focus(), { once: true });
    void wrap.offsetWidth;
    wrap.classList.add("eif-open");
    document.addEventListener("mousedown", onMenuOutside, true);
    document.addEventListener("keydown", onMenuKey, true);
    window.addEventListener("message", onMenuMessage);
  }
  function closeMenuPanel() {
    if (!menuPanel) return;
    const { wrap } = menuPanel;
    menuPanel = null;
    document.removeEventListener("mousedown", onMenuOutside, true);
    document.removeEventListener("keydown", onMenuKey, true);
    window.removeEventListener("message", onMenuMessage);
    wrap.classList.remove("eif-open");
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { wrap.remove(); return; }
    wrap.addEventListener("transitionend", () => wrap.remove(), { once: true });
    setTimeout(() => wrap.remove(), 400);
  }
  function onMenuOutside(e) { if (menuPanel && !menuPanel.wrap.contains(e.target)) closeMenuPanel(); }
  function onMenuKey(e) { if (e.key === "Escape") closeMenuPanel(); }
  function onMenuMessage(e) {
    if (!menuPanel || e.source !== menuPanel.frame.contentWindow) return;
    if (e.origin !== new URL(chrome.runtime.getURL("")).origin) return;
    if (e.data && e.data.type === "eif-menu-close") closeMenuPanel();
  }

  function init() {
    const go = () => {
      setTimeout(() => { if (!licOk && licStatus.code === "CHECKING") showLockCard(); }, 1500);
      refreshLicense();
      setInterval(refreshLicense, 60000);
    };
    if (SITE === "ebay") reportEbaySignInForSetup();
    if (!hasStorage) return go();
    chrome.storage.local.get({ eifPrefs: {} }, (d) => {
      prefs = readPrefs(d && d.eifPrefs);
      go();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.eifLicenseStatus) refreshLicense();
      if (changes.eifMessages && popup) paintMaintenance(popup.overlay);
      if (!changes.eifPrefs) return;
      const old = prefs;
      prefs = readPrefs(changes.eifPrefs.newValue);
      if (mainStarted) applyPrefs(old);
      if (!licOk) showLockCard();
    });
    if (chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, sender, reply) => {
        if (!msg || sender.id !== chrome.runtime.id) return;
        if (msg.type === "eif-open-tab") {
          if (!licOk) { lockDismissed = false; showLockCard(); reply({ ok: false, license: true }); return; }
          if (msg.tab === "az-hijack" && currentPageAsin()) startAmazonHijackCheck(currentPageAsin());
          else if (msg.tab === "hijack-page" && currentPageItemNumber()) startHijackCheck(currentPageItemNumber());
          else if (msg.tab === "upload") { closeMini(); openPopup("results"); const f = popup && popup.overlay.querySelector('input[type="file"]'); if (f) f.click(); }
          else openPopup(msg.tab || "results");
          reply({ ok: true });
        } else if (msg.type === "eif-menu-toggle") {
          if (menuPanel) closeMenuPanel(); else openMenuPanel();
          reply({ ok: true });
        } else if (msg.type === "eif-page-info") {
          reply({ ok: true, site: SITE, asin: currentPageAsin() || "", item: currentPageItemNumber() || "", mine: !!(currentPageAsin() && amazonIsMine(currentPageAsin())) });
        }
      });
    }
  }

  function reportEbaySignInForSetup() {
    if (!hasStorage) return;
    let tries = 0;
    const check = () => {
      chrome.storage.local.get({ eifSetup: null }, (d) => {
        const s = d && d.eifSetup;
        if (s && s.ebay) return;
        if (ebayUserName()) { bgSend({ type: "eif-setup-ebay-seen" }); return; }
        if (++tries < 3) setTimeout(check, 3000);
      });
    };
    setTimeout(check, 1500);
  }

  function initMain() {
    setInterval(updateHeartbeat, 300);
    if (SITE === "amazon" && /^\/report\/infringement\/?$/.test(location.pathname)) return;
    buildWidget();
    setupGlobalDragTracking();
    setupPaste();
    setupConnectionWatch();
    if (SITE === "amazon") {
      document.documentElement.classList.add("eif-on-amazon");
      loadState(() => {
        updatePanel();
        loadReportState(() => resumeReportJobOnLoad());
        loadAzState();
        loadMerchMeta();
      });
      watchStorage();
      return;
    }
    scan();
    loadState(() => {
      refreshAllBadges();
      updatePanel();
      loadAzState();
      loadMerchMeta();
      loadReportState(() => {
        resumeReportJobOnLoad();
        setTimeout(detectOwnListing, 1500);
      });
    });
    watchStorage();

    const observer = new MutationObserver((mutations) => {
      const relevant = mutations.some((m) => {
        const target = m.target;
        if (!target || !target.closest) return true;
        if (target.closest("#eif-widget, #eif-hunt-overlay, #eif-toast, .eif-badge")) return false;
        if (m.type === "childList") {
          const nodes = [...m.addedNodes, ...m.removedNodes];
          if (
            nodes.length &&
            nodes.every((n) => n.nodeType === 1 && (n.classList.contains("eif-badge") || /^eif-/.test(n.id || "")))
          ) {
            return false;
          }
        }
        return true;
      });
      if (!relevant) return;
      clearTimeout(init._t);
      init._t = setTimeout(scan, 300);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "href",
        "data-track",
        "iid",
        "data-iid",
        "data-item-id",
        "data-itemid",
        "data-listing-id",
        "data-listingid",
        "data-item-number",
        "data-listing-number",
        "data-url",
        "data-href",
        "data-analytics",
        "itemid",
        "listingid",
        "aria-label",
        "title",
      ],
    });

    setInterval(() => {
      if (!popup) scan();
    }, 1500);

    let resizeTimer;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(positionAllBadges, 100);
    });
    let scrollScanTimer;
    document.addEventListener(
      "scroll",
      (e) => {
        schedulePositionAllBadges();
        if (popup || (e.target && e.target.closest && e.target.closest("#eif-hunt-overlay"))) return;
        clearTimeout(scrollScanTimer);
        scrollScanTimer = setTimeout(scan, 350);
      },
      { passive: true, capture: true }
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
