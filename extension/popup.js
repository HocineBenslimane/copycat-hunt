const DEFAULTS = {
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
};
const L = self.EifLicense;
const $ = (s) => document.querySelector(s);
let prefs = { ...DEFAULTS };
let activeTab = null;
const IN_PANEL = window.top !== window;
if (IN_PANEL) document.documentElement.classList.add("panel");
function closeMenu() {
  if (IN_PANEL) window.parent.postMessage({ type: "eif-menu-close" }, "*");
  else window.close();
}

const ICONS = {
  check: '<svg fill="currentColor" viewBox="0 0 24 24"><path d="M22.319,4.431,8.5,18.249a1,1,0,0,1-1.417,0L1.739,12.9a1,1,0,0,0-1.417,0h0a1,1,0,0,0,0,1.417l5.346,5.345a3.008,3.008,0,0,0,4.25,0L23.736,5.847a1,1,0,0,0,0-1.416h0A1,1,0,0,0,22.319,4.431Z"/></svg>',
  warn: '<svg fill="currentColor" viewBox="0 0 24 24"><path d="M11,13V7c0-.55,.45-1,1-1s1,.45,1,1v6c0,.55-.45,1-1,1s-1-.45-1-1Zm1,2c-.83,0-1.5,.67-1.5,1.5s.67,1.5,1.5,1.5,1.5-.67,1.5-1.5-.67-1.5-1.5-1.5Zm11.58,4.88c-.7,1.35-2.17,2.12-4.01,2.12H4.44c-1.85,0-3.31-.77-4.01-2.12-.71-1.36-.51-3.1,.5-4.56L8.97,2.6c.71-1.02,1.83-1.6,3.03-1.6s2.32,.58,3,1.57l8.08,12.77c1.01,1.46,1.2,3.19,.49,4.54Zm-2.15-3.42s-.02-.02-.02-.04L13.34,3.67c-.29-.41-.79-.67-1.34-.67s-1.05,.26-1.36,.71L2.59,16.42c-.62,.88-.76,1.84-.4,2.53,.35,.68,1.15,1.05,2.24,1.05h15.12c1.09,0,1.89-.37,2.24-1.05,.36-.69,.22-1.65-.37-2.49Z"/></svg>',
  hunt: '<svg fill="currentColor" viewBox="0 0 24 24"><path d="M24,22.586l-6.262-6.262a10.016,10.016,0,1,0-1.414,1.414L22.586,24ZM10,18a8,8,0,1,1,8-8A8.009,8.009,0,0,1,10,18Z"/></svg>',
  shield: '<svg fill="currentColor" viewBox="0 0 24 24"><path d="M18.581,2.14,12.316.051a1,1,0,0,0-.632,0L5.419,2.14A4.993,4.993,0,0,0,2,6.883V12c0,7.563,9.2,11.74,9.594,11.914a1,1,0,0,0,.812,0C12.8,23.74,22,19.563,22,12V6.883A4.993,4.993,0,0,0,18.581,2.14ZM20,12c0,5.455-6.319,9.033-8,9.889-1.683-.853-8-4.42-8-9.889V6.883A3,3,0,0,1,6.052,4.037L12,2.054l5.948,1.983A3,3,0,0,1,20,6.883Z"/><path d="M15.3,8.3,11.112,12.5,8.868,10.16a1,1,0,1,0-1.441,1.386l2.306,2.4a1.872,1.872,0,0,0,1.345.6h.033a1.873,1.873,0,0,0,1.335-.553l4.272-4.272A1,1,0,0,0,15.3,8.3Z"/></svg>',
  pin: '<svg fill="currentColor" viewBox="0 0 24 24"><path d="M20.137,24a2.8,2.8,0,0,1-1.987-.835L12,17.051,5.85,23.169a2.8,2.8,0,0,1-3.095.609A2.8,2.8,0,0,1,1,21.154V5A5,5,0,0,1,6,0H18a5,5,0,0,1,5,5V21.154a2.8,2.8,0,0,1-1.751,2.624A2.867,2.867,0,0,1,20.137,24ZM6,2A3,3,0,0,0,3,5V21.154a.843.843,0,0,0,1.437.6h0L11.3,14.933a1,1,0,0,1,1.41,0l6.855,6.819a.843.843,0,0,0,1.437-.6V5a3,3,0,0,0-3-3Z"/></svg>',
  flag: '<svg fill="currentColor" viewBox="0 0 24 24"><path d="m20 4h-5a4 4 0 0 0 -4-4h-7a4 4 0 0 0 -4 4v19a1 1 0 0 0 2 0v-10h8a4 4 0 0 0 4 4h6a4 4 0 0 0 4-4v-5a4 4 0 0 0 -4-4zm-18 7v-7a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1 -2 2zm20 2a2 2 0 0 1 -2 2h-6a2 2 0 0 1 -2-2v-.142a4 4 0 0 0 3-3.858v-3h5a2 2 0 0 1 2 2z"/></svg>',
  clock: '<svg fill="currentColor" viewBox="0 0 24 24"><path d="M12,0A11.972,11.972,0,0,0,4,3.073V1A1,1,0,0,0,2,1V4A3,3,0,0,0,5,7H8A1,1,0,0,0,8,5H5a.854.854,0,0,1-.1-.021A9.987,9.987,0,1,1,2,12a1,1,0,0,0-2,0A12,12,0,1,0,12,0Z"/><path d="M12,6a1,1,0,0,0-1,1v5a1,1,0,0,0,.293.707l3,3a1,1,0,0,0,1.414-1.414L13,11.586V7A1,1,0,0,0,12,6Z"/></svg>',
  user: '<svg fill="currentColor" viewBox="0 0 24 24"><path d="M21,24H19V18.957A2.96,2.96,0,0,0,16.043,16H7.957A2.96,2.96,0,0,0,5,18.957V24H3V18.957A4.963,4.963,0,0,1,7.957,14h8.086A4.963,4.963,0,0,1,21,18.957Z"/><path d="M12,12a6,6,0,1,1,6-6A6.006,6.006,0,0,1,12,12ZM12,2a4,4,0,1,0,4,4A4,4,0,0,0,12,2Z"/></svg>',
  shirt: '<svg fill="currentColor" viewBox="0 0 24 24"><path d="m20.814,1.195c-1.477-.793-3.032-1.195-4.624-1.195H7.81c-1.592,0-3.148.402-4.625,1.195C1.221,2.25,0,4.335,0,6.636v11.364c0,1.654,1.346,3,3,3h1.424c.774,1.763,2.531,3,4.576,3h6c2.045,0,3.802-1.237,4.576-3h1.424c1.654,0,3-1.346,3-3V6.636c0-2.301-1.221-4.386-3.186-5.44Zm-5.921.805c-.456,1.194-1.588,2-2.894,2s-2.438-.806-2.893-2h5.787Zm7.106,16c0,.551-.448,1-1,1h-1V7c0-.552-.447-1-1-1s-1,.448-1,1v12c0,1.654-1.346,3-3,3h-6c-1.654,0-3-1.346-3-3V7c0-.552-.448-1-1-1s-1,.448-1,1v12h-1c-.551,0-1-.449-1-1V6.636c0-1.563.817-2.973,2.131-3.679.937-.503,1.908-.801,2.897-.907.544,2.326,2.588,3.95,4.972,3.95s4.427-1.624,4.972-3.95c.988.106,1.96.404,2.898.907,1.314.706,2.131,2.116,2.131,3.679v11.364Z"/></svg>',
  open: '<svg fill="currentColor" viewBox="0 0 24 24"><path d="m24,3v7c0,.552-.447,1-1,1s-1-.448-1-1V3.414l-11.793,11.793c-.195.195-.451.293-.707.293s-.512-.098-.707-.293c-.391-.391-.391-1.023,0-1.414L20.586,2h-6.586c-.553,0-1-.448-1-1s.447-1,1-1h7c1.654,0,3,1.346,3,3Zm-1,11c-.553,0-1,.448-1,1v4c0,1.654-1.346,3-3,3H5c-1.654,0-3-1.346-3-3V5c0-1.654,1.346-3,3-3h4c.553,0,1-.448,1-1s-.447-1-1-1h-4C2.243,0,0,2.243,0,5v14c0,2.757,2.243,5,5,5h14c2.757,0,5-2.243,5-5v-4c0-.552-.447-1-1-1Z"/></svg>',
  refresh: '<svg fill="currentColor" viewBox="0 0 24 24"><path d="M12,2a10.032,10.032,0,0,1,7.122,3H16a1,1,0,0,0-1,1h0a1,1,0,0,0,1,1h4.143A1.858,1.858,0,0,0,22,5.143V1a1,1,0,0,0-1-1h0a1,1,0,0,0-1,1V3.078A11.981,11.981,0,0,0,.05,10.9a1.007,1.007,0,0,0,1,1.1h0a.982.982,0,0,0,.989-.878A10.014,10.014,0,0,1,12,2Z"/><path d="M22.951,12a.982.982,0,0,0-.989.878A9.986,9.986,0,0,1,4.878,19H8a1,1,0,0,0,1-1H9a1,1,0,0,0-1-1H3.857A1.856,1.856,0,0,0,2,18.857V23a1,1,0,0,0,1,1H3a1,1,0,0,0,1-1V20.922A11.981,11.981,0,0,0,23.95,13.1a1.007,1.007,0,0,0-1-1.1Z"/></svg>',
};

function el(tag, attrs, text) {
  const n = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => (k === "class" ? (n.className = v) : k === "html" ? (n.innerHTML = v) : n.setAttribute(k, v)));
  if (text != null && text !== "") n.textContent = text;
  return n;
}

let hudTimer;
function hud(text) {
  const h = $("#hud");
  h.textContent = text;
  h.classList.add("show");
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => h.classList.remove("show"), 1400);
}

function readPrefs(raw) {
  const p = { ...DEFAULTS };
  if (raw && typeof raw === "object") Object.keys(DEFAULTS).forEach((k) => typeof raw[k] === "boolean" && (p[k] = raw[k]));
  if (!p.searchEbay && !p.searchAmazon) p.searchEbay = p.searchAmazon = true;
  return p;
}

function countOn(keys) {
  const on = keys.filter((k) => prefs[k]).length;
  return on === keys.length ? "All on" : on === 0 ? "All off" : `${on} of ${keys.length} on`;
}

function paintPrefs() {
  document.querySelectorAll("[data-pref]").forEach((box) => (box.checked = !!prefs[box.dataset.pref]));
  const only = prefs.searchEbay !== prefs.searchAmazon;
  $('[data-pref="searchEbay"]').disabled = only && prefs.searchEbay;
  $('[data-pref="searchAmazon"]').disabled = only && prefs.searchAmazon;
  $("#one-on").hidden = !only;
  $("#sum-search").textContent = prefs.searchEbay && prefs.searchAmazon ? "eBay and Amazon" : prefs.searchEbay ? "eBay only" : "Amazon only";
  $("#sum-auto").textContent = countOn(["autoTextCheck", "detectOwn", "autoMerchSync"]);
  $("#sum-page").textContent = countOn(["widgetEbay", "widgetAmazon", "pageBadges", "hoverPanel", "heartbeat", "animations"]);
  $("#sum-report").textContent = prefs.askReason ? "Ask first" : "Don't ask";
  paintScorerSum();
  $("#sum-builder").textContent = prefs.saveTestSet ? "Saving results" : "Off";
}

function save(msg) {
  chrome.storage.local.set({ eifPrefs: prefs });
  paintPrefs();
  if (msg) hud(msg);
}

document.addEventListener("change", (e) => {
  const k = e.target.dataset && e.target.dataset.pref;
  if (!k) return;
  prefs[k] = e.target.checked;
  if (!prefs.searchEbay && !prefs.searchAmazon) prefs[k] = true;
  save(e.target.checked ? "Turned on" : "Turned off");
});

document.addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  const box = row.querySelector("[data-pref]");
  if (box && box.disabled) {
    const n = $("#one-on");
    n.hidden = false;
    row.classList.remove("flash");
    void row.offsetWidth;
    row.classList.add("flash");
  }
});

const FOLD_KEY = "eifMenuOpen2";
function readOpen() {
  try { const v = JSON.parse(localStorage.getItem(FOLD_KEY)); if (Array.isArray(v)) return v; } catch (e) {}
  return ["search", "auto"];
}
function writeOpen(list) {
  try { localStorage.setItem(FOLD_KEY, JSON.stringify(list)); } catch (e) {}
}
const folds = {};
document.querySelectorAll(".fold").forEach((sec) => {
  const body = sec.querySelector(".fold-b");
  const inner = el("div", { class: "fold-in" });
  while (body.firstChild) inner.appendChild(body.firstChild);
  body.appendChild(inner);
  const head = sec.querySelector(".fold-h");
  const set = (open) => {
    sec.classList.toggle("open", open);
    head.setAttribute("aria-expanded", String(open));
    inner.querySelectorAll("input").forEach((i) => (i.tabIndex = open ? 0 : -1));
  };
  folds[sec.dataset.fold] = { sec, set, body, inner };
  set(readOpen().includes(sec.dataset.fold));
  head.addEventListener("click", () => {
    const open = !sec.classList.contains("open");
    set(open);
    const list = readOpen().filter((x) => x !== sec.dataset.fold);
    if (open) list.push(sec.dataset.fold);
    writeOpen(list);
    fitFolds();
  });
});

const FOLD_PAD = 6;
function heightWith(names) {
  let h = 0;
  for (const c of document.body.children) {
    if (c.id === "hud" || c.tagName === "SCRIPT") continue;
    const r = c.getBoundingClientRect();
    if (r.height) h = Math.max(h, r.bottom);
  }
  h += window.scrollY + parseFloat(getComputedStyle(document.body).paddingBottom);
  for (const [k, f] of Object.entries(folds)) h += (names.includes(k) ? f.inner.scrollHeight + FOLD_PAD : 0) - f.body.getBoundingClientRect().height;
  return Math.ceil(h);
}
function fitFolds() {
  const limit = IN_PANEL ? window.innerHeight : 600;
  const shown = Object.keys(folds).filter((k) => folds[k].sec.classList.contains("open") && !folds[k].sec.closest("[hidden]"));
  const order = readOpen();
  const open = shown.filter((k) => !order.includes(k)).concat(order.filter((k) => shown.includes(k)));
  const keep = open.slice();
  while (keep.length > 1 && heightWith(keep) > limit) keep.splice(keep.length - 2, 1);
  if (keep.length === open.length) return;
  open.filter((k) => !keep.includes(k)).forEach((k) => folds[k].set(false));
  writeOpen(readOpen().filter((k) => keep.includes(k) || !open.includes(k)));
}
let fitQueued = false;
const queueFit = () => { if (fitQueued) return; fitQueued = true; requestAnimationFrame(() => { fitQueued = false; fitFolds(); }); };
if (window.ResizeObserver) new ResizeObserver(queueFit).observe(document.body);
window.addEventListener("resize", queueFit);

function paintReset(confirming) {
  const w = $("#reset-wrap");
  w.textContent = "";
  if (!confirming) {
    const b = el("button", { type: "button", id: "reset", class: "link" }, "Reset settings");
    b.addEventListener("click", () => paintReset(true));
    w.append(b);
    return;
  }
  w.append(el("span", {}, "Reset all settings?"));
  const yes = el("button", { type: "button", id: "reset-yes", class: "link danger" }, "Reset");
  yes.addEventListener("click", () => {
    prefs = { ...DEFAULTS };
    if (self.EifTheme) EifTheme.save("dark");
    save("Settings reset");
    paintReset(false);
  });
  const no = el("button", { type: "button", class: "link" }, "Cancel");
  no.addEventListener("click", () => paintReset(false));
  w.append(yes, no);
  yes.focus();
}
paintReset(false);

function siteOf(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "www.ebay.com") return /^\/(signin|chk)\/|^\/ws\/eBayISAPI\.dll|^\/robots\.txt$/i.test(u.pathname) ? "" : "ebay";
    if (u.hostname === "www.amazon.com") return /^\/(ap|gp\/buy|checkout|gp\/cart|cart)\/|^\/robots\.txt$/i.test(u.pathname) ? "" : "amazon";
  } catch (e) {}
  return "";
}

function openOnPage(tab) {
  if (!activeTab) return;
  chrome.tabs.sendMessage(activeTab.id, { type: "eif-open-tab", tab }, (res) => {
    if (chrome.runtime.lastError || !res) { hud("Reload this page, then try again"); return; }
    closeMenu();
  });
}

function item({ icon, color, label, value, onClick, href, info }) {
  const n = el(href ? "a" : info ? "div" : "button", { class: "item" + (info ? " info" : "") });
  if (href) { n.href = href; n.target = "_blank"; n.rel = "noopener"; }
  else if (!info) n.type = "button";
  n.append(el("span", { class: `ic ${color}`, html: ICONS[icon] || "" }));
  n.append(el("span", { class: "lbl" }, label));
  if (value !== undefined && value !== "") n.append(el("span", { class: "val" }, String(value)));
  if (!info) n.append(el("i", { class: "chev" }));
  if (onClick) n.addEventListener("click", onClick);
  return n;
}

async function counts() {
  const d = await chrome.storage.local.get({ eifTrackedItems: {}, eifAmazonTracked: {}, eifReportHistory: [], eifMerchMeta: {}, eifProtectedItems: [], eifAmazonMine: [] });
  const active = (o) => Object.values(o || {}).filter((m) => m && !m.reportedAt).length;
  return {
    tracked: active(d.eifTrackedItems) + active(d.eifAmazonTracked),
    reports: (Array.isArray(d.eifReportHistory) ? d.eifReportHistory : []).filter((r) => !r.archived).length,
    mine: (Array.isArray(d.eifProtectedItems) ? d.eifProtectedItems.length : 0) + (Array.isArray(d.eifAmazonMine) ? d.eifAmazonMine.length : 0),
    merch: merchLine(d.eifMerchMeta),
  };
}

function merchLine(m) {
  if (!m || m.state !== "ready") return null;
  const n = (v, one, many) => `${Number(v).toLocaleString("en-US")} ${Number(v) === 1 ? one : many}`;
  if (m.liveRevision && m.liveRevision === m.revision && m.designs != null) return `${n(m.designs, "design", "designs")} · ${n(m.liveProducts || 0, "product", "products")}`;
  return n(m.count || 0, "listing", "listings");
}

async function paintPage() {
  const line = $("#page-line");
  const sub = $("#page-sub");
  const list = $("#page-list");
  const open = $("#open-main");
  const mark = $("#site-mark");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  const site = tab && tab.url ? siteOf(tab.url) : "";
  const c = await counts();
  list.textContent = "";
  mark.className = "site " + site;
  $("#page").setAttribute("aria-busy", "false");
  const merchRow = () =>
    item({ icon: "shirt", color: "indigo", label: "Merch catalog", value: c.merch === null ? "Not connected" : c.merch, info: true });

  if (!site) {
    line.textContent = "";
    sub.textContent = "";
    $("#page").classList.add("no-head");
    open.hidden = true;
    list.append(
      item({ icon: "open", color: "orange", label: "Open Amazon", href: "https://www.amazon.com/" }),
      item({ icon: "open", color: "blue", label: "Open eBay", href: "https://www.ebay.com/" }),
      merchRow()
    );
    return;
  }
  const where = site === "ebay" ? "eBay" : "Amazon";
  const info = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: "eif-page-info" }, (res) => resolve(chrome.runtime.lastError ? null : res));
  });
  if (!info || !info.ok) {
    line.textContent = `On ${where}`;
    sub.textContent = "Reload this page to use Copycat Hunt here.";
    open.hidden = true;
    const r = item({ icon: "refresh", color: "gray", label: "Reload this page", onClick: () => { chrome.tabs.reload(tab.id); closeMenu(); } });
    list.append(r);
    return;
  }
  line.textContent = info.asin ? `Amazon product ${info.asin}` : info.item ? `eBay listing #${info.item}` : `On ${where}`;
  if (info.mine) line.append(el("span", { class: "mine-tag" }, "yours"));
  line.setAttribute("aria-label", info.asin ? `Amazon product ${info.asin}${info.mine ? " · yours" : ""}` : line.textContent);
  sub.textContent = info.asin || info.item ? "" : "Drop a listing photo on the page to start a hunt.";
  open.hidden = false;
  open.onclick = () => openOnPage("results");
  if (info.asin) list.append(item({ icon: "shield", color: "red", label: "Check this product for hijacks", onClick: () => openOnPage("az-hijack") }));
  else if (info.item) list.append(item({ icon: "shield", color: "red", label: "Check this listing for hijacks", onClick: () => openOnPage("hijack-page") }));
  else list.append(item({ icon: "shield", color: "red", label: "Hijacks", onClick: () => openOnPage("hijacks") }));
  list.append(
    item({ icon: "pin", color: "orange", label: "Copycats", value: c.tracked, onClick: () => openOnPage("tracked") }),
    item({ icon: "flag", color: "blue", label: "Report", onClick: () => openOnPage("report") }),
    item({ icon: "clock", color: "green", label: "Reported", value: c.reports, onClick: () => openOnPage("reported") }),
    item({ icon: "user", color: "gray", label: "My listings", value: c.mine || "", onClick: () => openOnPage("mine") }),
    merchRow()
  );
}

function licSend(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r));
    } catch (e) {
      resolve(null);
    }
  });
}

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  btn.textContent = "";
  if (busy) btn.append(el("span", { class: "spin" }));
  btn.append(document.createTextNode(label));
}

const KEY_MAX = 256;
let licSeq = 0;

function paintLicense(st, note) {
  const body = $("#lic-body");
  const form = $("#lic-form");
  const msg = $("#lic-msg");
  const valid = !!(st && st.ok === true && st.code === "VALID");
  document.body.classList.remove("loading");
  requestAnimationFrame(playIntro);
  document.body.classList.toggle("locked", !valid);
  body.textContent = "";
  msg.hidden = true;
  msg.className = "lic-msg";
  const exp = valid ? L.formatExpiry(st.expiry) : "";
  $("#owner").textContent = "";
  $("#license").hidden = false;

  if (!st) {
    body.append(el("p", { class: "lic-intro" }, "Copycat Hunt couldn't start. Close this menu and open it again; if that doesn't help, restart Chrome."));
    form.hidden = true;
    return;
  }

  if (valid) {
    form.hidden = true;
    if ($("#lic-buy")) $("#lic-buy").hidden = true;
    const left = L.daysLeft(st.expiry);
    const failed = st.checkFailed === true;
    const soon = left !== null && left <= 5;
    const name = typeof st.name === "string" ? st.name.slice(0, 80) : "";
    $("#license").classList.add("lic-card");
    $("#license").classList.toggle("lic-card-warn", failed || soon);
    const text = el("div", { class: "lic-text" });
    if (failed) {
      text.append(el("div", { class: "lic-title" }, "Couldn't check your license"));
      text.append(el("div", { class: "lic-sub warn" }, "It keeps working for now. We'll try again automatically."));
    } else if (soon) {
      text.append(el("div", { class: "lic-title" }, left > 0 ? `Expires in ${left} day${left === 1 ? "" : "s"}` : "Expires today"));
      text.append(el("div", { class: "lic-sub" }, "Renew to keep using Copycat Hunt."));
    } else {
      text.append(el("div", { class: "lic-title" }, name ? `Licensed to ${name}` : "Your license"));
      text.append(el("div", { class: "lic-sub" }, exp ? `Expires on ${exp}` : "No end date"));
    }
    const pill = el("span", { class: "lic-pill" + (failed || soon ? " warn" : "") }, failed ? "Not checked" : soon ? "Ending" : "Active");
    body.append(text, pill);
    if (failed) body.append(recheckButton());
    if (note) { msg.hidden = false; msg.textContent = note; }
    return;
  }

  $("#license").classList.remove("lic-card", "lic-card-warn");
  const code = st.code;
  if (st.hasKey && !["NO_KEY", "NOT_FOUND", "CHECKING"].includes(code)) {
    const bad = ["OFFLINE", "NEEDS_CHECK", "CLOCK"].includes(code) ? "warn" : "bad";
    const text = el("div", { class: "lic-text" });
    text.append(el("div", { class: "lic-title" }, code === "EXPIRED" ? "License expired" : bad === "warn" ? "License not checked" : "License can't be used"));
    text.append(el("div", { class: `lic-sub ${bad}` }, typeof st.message === "string" ? st.message : ""));
    body.append(el("span", { class: `lic-badge ${bad}`, html: ICONS.warn }), text);
    if (st.canRecheck) body.append(recheckButton());
  } else if (code === "CHECKING") {
    body.append(el("p", { class: "lic-intro" }, "Checking your license…"));
    if (st.canRecheck) body.append(recheckButton());
  } else if (code === "CRYPTO") {
    body.append(el("p", { class: "lic-intro" }, typeof st.message === "string" ? st.message : ""));
  } else {
    body.append(el("p", { class: "lic-intro" }, "Enter your license key to start using Copycat Hunt."));
  }
  form.hidden = code === "CRYPTO";
  const buy = $("#lic-buy");
  if (buy && self.EifLinks) {
    buy.hidden = form.hidden || code === "CHECKING";
    const open = $("#lic-buy-open");
    if (!open.dataset.wired) {
      open.dataset.wired = "1";
      open.addEventListener("click", () => {
        $("#lic-buy-more").hidden = false;
        open.setAttribute("aria-expanded", "true");
      });
    }
    const plans = $("#lic-plans");
    if (!plans.childElementCount) {
      for (const p of self.EifLinks.PLANS) {
        const a = el("a", { class: "lic-plan", href: self.EifLinks.checkoutHref(p.id), target: "_blank", rel: "noopener", "data-plan": p.id });
        a.append(el("b", {}, p.price), el("span", {}, p.per));
        if (p.note) a.append(el("i", {}, p.note));
        plans.append(a);
      }
    }
  }
  if (note) { msg.hidden = false; msg.textContent = note; }
  if (!form.hidden && document.activeElement === document.body) $("#lic-key").focus();
}

function recheckButton() {
  const b = el("button", { type: "button", class: "btn small", id: "lic-recheck" }, "Check now");
  b.addEventListener("click", async () => {
    setBusy(b, true, "Checking");
    const r = await licSend({ type: "eif-license-recheck" });
    if (r && r.ok && r.code === "VALID" && !r.checkFailed) hud("License checked");
    refreshLicense(r && r.throttled ? "Please wait a moment before checking again." : r && !r.ok ? r.message : "");
  });
  return b;
}

async function licActivate() {
  const input = $("#lic-key");
  const go = $("#lic-go");
  const form = $("#lic-form");
  const key = input.value.trim();
  const shake = () => { form.classList.remove("shake"); void form.offsetWidth; form.classList.add("shake"); };
  if (!key) { shake(); return refreshLicense("Paste your license key first."); }
  if (key.length > KEY_MAX) { shake(); return refreshLicense("That doesn't look like a license key. Copy it again from your email."); }
  setBusy(go, true, "Checking");
  input.disabled = true;
  const r = await licSend({ type: "eif-license-activate", key });
  input.disabled = false;
  setBusy(go, false, "Activate");
  if (r && r.ok) {
    input.value = "";
    hud("License activated");
    M && M.claws($("#logo svg"));
    return refreshLicense();
  }
  shake();
  refreshLicense((r && typeof r.message === "string" && r.message) || "Couldn't reach Copycat Hunt. Close this menu and try again.");
  input.select();
}

function refreshLicense(note) {
  const mySeq = ++licSeq;
  return licSend({ type: "eif-license-status" }).then((st) => {
    if (mySeq !== licSeq) return;
    paintLicense(st && typeof st === "object" && typeof st.ok === "boolean" ? st : null, note);
  });
}

$("#lic-form").addEventListener("submit", (e) => { e.preventDefault(); licActivate(); });
$("#lic-key").maxLength = KEY_MAX;
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if (ch.eifLicenseStatus) refreshLicense();
  if (ch.eifPrefs) { prefs = readPrefs(ch.eifPrefs.newValue); paintPrefs(); }
});

let setupRaw = null;
let merchMeta = null;
function nextSetupStep(s, meta) {
  if (!s || s.merch !== "done") {
    const started = meta && (meta.state === "syncing" || meta.state === "failed");
    return started ? "Step 3 of 4: Sync your products" : "Step 2 of 4: Connect your Merch account";
  }
  const answered = ["seller", "account", "none"].includes(s.ebayMode) || s.ebay === "skipped" || s.ebay === "signed_in";
  return answered ? "Almost done: open setup to finish." : "Step 4 of 4: Your eBay account";
}
function paintSetup() {
  const s = setupRaw && typeof setupRaw === "object" ? setupRaw : null;
  const pending = !s || s.state !== "complete";
  const row = $("#setup-row");
  let text = "";
  if (pending) text = nextSetupStep(s, merchMeta);
  else if (s.merch === "skipped") text = "Merch isn't connected. Connect it to recognise your own products on Amazon.";
  row.hidden = !text;
  document.body.classList.toggle("setup-pending", pending);
  $("#setup-title").hidden = !pending;
  $("#setup-title").textContent = pending ? "Finish setting up" : "";
  $("#setup-text").textContent = text;
  $("#open-setup").textContent = pending ? "Finish setup" : "Open setup";
}
function openSetup() {
  chrome.runtime.sendMessage({ type: "eif-merch-open-setup" }, () => { void chrome.runtime.lastError; closeMenu(); });
}
const LOOK_NAMES = { dark: "Dark", light: "Light", system: "Match my computer" };
function paintLook() {
  const m = self.EifTheme ? EifTheme.mode() : "dark";
  document.querySelectorAll("#look [data-look]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.look === m)));
  $("#sum-look").textContent = LOOK_NAMES[m];
}
document.querySelectorAll("#look [data-look]").forEach((b) => b.addEventListener("click", () => {
  if (!self.EifTheme || EifTheme.mode() === b.dataset.look) return;
  EifTheme.save(b.dataset.look);
  hud(`${LOOK_NAMES[b.dataset.look]} appearance`);
}));
if (self.EifTheme) EifTheme.onChange(paintLook);
paintLook();

$("#open-setup").addEventListener("click", openSetup);
$("#menu-close").addEventListener("click", closeMenu);
document.addEventListener("keydown", (e) => { if (IN_PANEL && e.key === "Escape") closeMenu(); });
$("#setup-link").addEventListener("click", openSetup);
chrome.storage.local.get({ eifSetup: null, eifMerchMeta: null }, (d) => { setupRaw = d && d.eifSetup; merchMeta = d && d.eifMerchMeta; paintSetup(); });
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !(ch.eifSetup || ch.eifMerchMeta)) return;
  if (ch.eifSetup) setupRaw = ch.eifSetup.newValue;
  if (ch.eifMerchMeta) merchMeta = ch.eifMerchMeta.newValue;
  paintSetup();
});

const M = self.EifMotion || null;
if (M && M.logoSvg()) $("#logo").innerHTML = M.logoSvg();

let introPlayed = false;
function playIntro() {
  if (introPlayed) return;
  introPlayed = true;
  const g = self.gsap;
  if (!M || !M.enabled() || !g) return;
  const sections = [...document.querySelectorAll("#license:not([hidden]), #app .group:not([hidden]), footer")].filter((el) => el.offsetParent);
  const tl = g.timeline({ defaults: { ease: "power3.out" } });
  tl.fromTo("#logo", { scale: 0.6, rotation: -8, autoAlpha: 0 }, { scale: 1, rotation: 0, autoAlpha: 1, duration: 0.45, ease: "back.out(2)", clearProps: "transform,opacity,visibility" })
    .add(() => M.claws($("#logo svg")), 0.12)
    .fromTo(".brand", { x: -10, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: 0.35, clearProps: "transform,opacity,visibility" }, 0.08)
    .fromTo(sections, { y: 16, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.42, stagger: 0.055, clearProps: "transform,opacity,visibility" }, 0.14);
}

const verFive = [];
let scorerState = null;
const SCORER_TEXT = {
  none: "Sorts your hunt results by how likely each one is a copy. In beta: access is approved by hand for each license.",
  requested: "Requested. You'll get an email when it's approved; then press Check again.",
  approved: "Approved for your license.",
  revoked: "The image scorer isn't available for this license.",
  license: "The image scorer needs an active license.",
  error: "Couldn't check right now. Try again in a minute.",
};
function paintScorerSum() {
  const st = scorerState;
  $("#sum-scorer").textContent = st === "approved" ? (prefs.scorer ? "On" : "Off") : st === "requested" ? "Requested" : st === "revoked" ? "Not available" : st === "none" ? "Not requested" : "";
}
function paintScorer(r) {
  const st = !r ? "error" : r.status || (r.error === "license" || r.error === "license-server" ? "license" : "error");
  if (r && r.status) scorerState = r.status;
  $("#sc-text").textContent = SCORER_TEXT[st];
  $("#sc-row").hidden = st !== "approved";
  $("#sc-ask").hidden = st !== "none";
  $("#sc-check").hidden = st === "approved" || st === "license";
  paintScorerSum();
}
function askScorer(opts) {
  const b = opts.ask ? $("#sc-ask") : $("#sc-check");
  b.disabled = true;
  return licSend({ type: "eif-scorer-access", ...opts }).then((r) => {
    b.disabled = false;
    paintScorer(r);
    return r;
  });
}
function showScorer(on) {
  $("#scorer").hidden = !on;
  if (!on) return;
  chrome.storage.local.get({ eifScorerAccess: null }, (d) => {
    if (d.eifScorerAccess && d.eifScorerAccess.status) paintScorer(d.eifScorerAccess);
    askScorer({});
  });
}
$("#sc-ask").addEventListener("click", () => askScorer({ ask: true }).then((r) => r && r.status === "requested" && hud("Request sent")));
$("#sc-check").addEventListener("click", () => askScorer({ force: true }).then((r) => r && r.status && hud(r.status === "approved" ? "Approved" : "Checked")));
let verClicks = [];
$("#ver").addEventListener("click", () => {
  const now = Date.now();
  verClicks = verClicks.filter((t) => now - t < 3000).concat(now);
  if (verClicks.length < 5) return;
  verClicks = [];
  chrome.storage.local.set({ eifScorerShown: true });
  document.body.classList.add("scorer-forced");
  showScorer(true);
  hud("Image scorer shown");
  verFive.forEach((f) => f());
});
chrome.storage.local.get({ eifScorerShown: false }, (d) => showScorer(d.eifScorerShown === true));

const MSG_KINDS = { info: "Announcement", maintenance: "Maintenance", price: "Price change" };
let messages = [];
let msgRead = new Set();
const msgDate = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
function markMsgRead(id) {
  if (msgRead.has(id)) return;
  msgRead.add(id);
  chrome.storage.local.set({ eifMessagesRead: [...msgRead].filter((x) => messages.some((m) => m.id === x)) });
  paintMsgCount();
}
function paintMsgCount() {
  const unread = messages.filter((m) => !msgRead.has(m.id)).length;
  $("#msg-count").hidden = !unread;
  $("#msg-count").textContent = unread > 9 ? "9+" : String(unread);
  $("#msg-btn").setAttribute("aria-label", unread ? `Messages, ${unread} unread` : "Messages");
}
function msgNode(m) {
  const n = el("li", { class: "msg" + (msgRead.has(m.id) ? "" : " unread") });
  const b = el("button", { type: "button", class: "msg-open" });
  const meta = el("div", { class: "msg-meta" });
  meta.append(el("span", { class: `msg-kind ${m.kind}` }, MSG_KINDS[m.kind]), el("span", {}, msgDate(m.startsAt)));
  b.append(meta, el("div", { class: "msg-title" }, m.title));
  if (m.body) b.append(el("div", { class: "msg-body" }, m.body));
  b.addEventListener("click", () => openMessage(m, n));
  n.append(b);
  return n;
}
async function showOnPage(id) {
  const [tab] = activeTab ? [activeTab] : await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return false;
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tab.id, { type: "eif-messages-open", id }, (r) => resolve(!chrome.runtime.lastError && !!(r && r.ok)));
    } catch (e) {
      resolve(false);
    }
  });
}
async function openMessage(m, node) {
  if (await showOnPage(m.id)) return closeMenu();
  markMsgRead(m.id);
  if (!node) {
    openMessages(true);
    node = [...$("#msgs-list").children].find((li) => li.dataset.id === m.id);
  }
  if (!node) return;
  node.classList.remove("unread");
  node.classList.add("full");
  if (m.link && !node.querySelector(".msg-link")) node.append(el("a", { class: "msg-link", href: m.link, target: "_blank", rel: "noopener noreferrer" }, m.linkText || "Read more"));
}
function paintMessages() {
  paintMsgCount();
  const live = messages.find((m) => m.live && m.kind === "maintenance");
  const note = $("#maint");
  note.hidden = !live;
  if (live) {
    note.textContent = "";
    note.append(el("i"), el("b", {}, "Maintenance"), el("span", {}, live.title));
    note.onclick = () => openMessage(live);
  }
  if ($("#msgs").hidden) return;
  const list = $("#msgs-list");
  list.textContent = "";
  if (!messages.length) list.append(el("li", { class: "empty" }, "No messages from Copycat Hunt yet."));
  messages.forEach((m) => { const n = msgNode(m); n.dataset.id = m.id; list.append(n); });
}
function openMessages(on) {
  $("#msgs").hidden = !on;
  document.body.classList.toggle("show-msgs", on);
  $("#msg-btn").classList.toggle("is-open", on);
  paintMessages();
}
$("#msg-btn").addEventListener("click", () => openMessages($("#msgs").hidden));
$("#msgs-close").addEventListener("click", () => openMessages(false));
function loadMessages(d) {
  messages = (d.eifMessages && Array.isArray(d.eifMessages.items) ? d.eifMessages.items : []).filter((m) => m && m.id && MSG_KINDS[m.kind]);
  msgRead = new Set(Array.isArray(d.eifMessagesRead) ? d.eifMessagesRead : messages.filter((m) => !m.live).map((m) => m.id));
  paintMessages();
}
const readMessages = () => chrome.storage.local.get({ eifMessages: null, eifMessagesRead: null }, loadMessages);
readMessages();
licSend({ type: "eif-messages" });
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.eifMessages) readMessages();
});

const TS = self.EifTestSet;
function showBuilder(on) {
  $("#builder").hidden = !on;
  if (on) paintTestSetCount();
}
function readTestSetData(cb) {
  chrome.storage.local.get(null, (all) => {
    const sets = {};
    Object.keys(all).forEach((k) => k.startsWith(TS.PREFIX) && (sets[k.slice(TS.PREFIX.length)] = all[k]));
    cb({ sets, hunts: all.eifHunts, ebayTracked: all.eifTrackedItems, amazonTracked: all.eifAmazonTracked, history: all.eifReportHistory, protectedItems: all.eifProtectedItems, amazonMine: all.eifAmazonMine });
  });
}
function paintTestSetCount() {
  readTestSetData((d) => {
    const n = Object.keys(d.sets).length;
    const c = TS.counts(TS.buildRows(d).rows);
    $("#ts-count").textContent = `${n} search${n === 1 ? "" : "es"} saved · ${c.reported} reported, ${c.tracked} tracked, ${c.skipped} skipped`;
  });
}
verFive.push(() => {
  chrome.storage.local.set({ eifBuilderTools: true });
  document.body.classList.add("builder-forced");
  showBuilder(true);
  hud("Builder tools shown");
});
$("#ts-hide").addEventListener("click", () => { chrome.storage.local.set({ eifBuilderTools: false }); showBuilder(false); });
$("#ts-export").addEventListener("click", () => {
  readTestSetData((d) => {
    const { rows, noDesign } = TS.buildRows(d);
    if (!rows.length) return hud("Nothing to export yet");
    const a = el("a", { href: URL.createObjectURL(new Blob([TS.toCsv(rows)], { type: "text/csv" })), download: `copycat-test-set-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    hud(`${rows.length} rows exported${noDesign ? ` (${noDesign} without a design left out)` : ""}`);
  });
});
let clearArmed = 0;
$("#ts-clear").addEventListener("click", () => {
  if (Date.now() - clearArmed > 3000) {
    clearArmed = Date.now();
    $("#ts-clear").textContent = "Click again to clear";
    return;
  }
  clearArmed = 0;
  $("#ts-clear").textContent = "Clear saved results";
  chrome.storage.local.get(null, (all) => {
    chrome.storage.local.remove([...Object.keys(all).filter((k) => k.startsWith(TS.PREFIX)), "eifTestSetIndex"], () => { paintTestSetCount(); hud("Saved results cleared"); });
  });
});
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && !$("#builder").hidden && Object.keys(ch).some((k) => k.startsWith(TS.PREFIX) || k === "eifTrackedItems" || k === "eifAmazonTracked" || k === "eifReportHistory")) paintTestSetCount();
});
chrome.storage.local.get({ eifBuilderTools: false }, (d) => showBuilder(d.eifBuilderTools === true));

$("#ver").textContent = `v${chrome.runtime.getManifest().version}`;
chrome.storage.local.get({ eifPrefs: {} }, (d) => {
  prefs = readPrefs(d.eifPrefs);
  paintPrefs();
});
refreshLicense();
paintPage();

function paintFix(res) {
  const list = $("#fix-list");
  list.textContent = "";
  ((res && res.lines) || [{ ok: false, text: "The tool didn't answer. Try Restart the extension." }]).forEach((l) => {
    list.appendChild(el("li", { class: l.ok === "info" ? "info" : l.ok ? "ok" : "bad" }, l.text));
  });
  $("#fix-out").hidden = false;
  $("#fix-restart").hidden = false;
}
$("#fix").addEventListener("click", () => {
  const b = $("#fix");
  if (b.disabled) return;
  b.disabled = true;
  b.textContent = "Fixing…";
  $("#fix-list").textContent = "";
  $("#fix-out").hidden = false;
  $("#fix-restart").hidden = true;
  chrome.runtime.sendMessage({ type: "eif-repair" }, (res) => {
    void chrome.runtime.lastError;
    b.disabled = false;
    b.textContent = "Fix problems";
    paintFix(res);
  });
});
$("#fix-close").addEventListener("click", () => { $("#fix-out").hidden = true; });
$("#fix-restart").addEventListener("click", () => {
  $("#fix-list").textContent = "";
  $("#fix-list").appendChild(el("li", { class: "ok" }, "Restarting. Refresh your open Amazon and eBay tabs afterwards."));
  chrome.runtime.sendMessage({ type: "eif-restart" }, () => { void chrome.runtime.lastError; });
});
