// Toolbar menu: the license, shortcuts for the tab you're on, and the
// preferences (eifPrefs) that decide what Copycat Hunt does on its own.
// Must match PREF_DEFAULTS in content.js.
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
  saveTestSet: false,
  scoreTest: false, // v3.26.0
};
const L = self.EifLicense;
const $ = (s) => document.querySelector(s);
let prefs = { ...DEFAULTS };
let activeTab = null;

const ICONS = {
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  warn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 4v5"/><path d="M8 12h.01"/></svg>',
  hunt: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14" stroke-linecap="round"/></svg>',
  shield: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z"/></svg>',
  pin: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 2.5h8v11L8 11l-4 2.5z"/></svg>',
  flag: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14V2.5h7l-1.5 3 1.5 3H4"/></svg>',
  clock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/></svg>',
  user: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.8-2.3 2.7-3.5 5-3.5s4.2 1.2 5 3.5" stroke-linecap="round"/></svg>',
  shirt: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M5.5 2.5L2 4.5l1.5 3L5 7v6.5h6V7l1.5.5 1.5-3-3.5-2c-.4 1-1.4 1.6-2.5 1.6S5.9 3.5 5.5 2.5z"/></svg>',
  open: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h4v4"/><path d="M13 3L7.5 8.5"/><path d="M11 9.5V13H3V5h3.5"/></svg>',
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

// ---- Preferences -------------------------------------------------------------
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
  // The last marketplace that's on can't be switched off.
  const only = prefs.searchEbay !== prefs.searchAmazon;
  $('[data-pref="searchEbay"]').disabled = only && prefs.searchEbay;
  $('[data-pref="searchAmazon"]').disabled = only && prefs.searchAmazon;
  $("#one-on").hidden = !only;
  // One-line summaries on the closed sections.
  $("#sum-search").textContent = prefs.searchEbay && prefs.searchAmazon ? "eBay and Amazon" : prefs.searchEbay ? "eBay only" : "Amazon only";
  $("#sum-auto").textContent = countOn(["autoTextCheck", "detectOwn", "autoMerchSync"]);
  $("#sum-page").textContent = countOn(["widgetEbay", "widgetAmazon", "pageBadges", "hoverPanel", "heartbeat", "animations"]);
  $("#sum-report").textContent = prefs.askReason ? "Ask first" : "Don't ask";
  $("#sum-builder").textContent = [prefs.saveTestSet && "Saving results", prefs.scoreTest && "Scores on"].filter(Boolean).join(" · ") || "Off";
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

// A click on a locked switch explains why instead of doing nothing.
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

// Collapsible sections; open ones are remembered.
function readOpen() {
  try { return JSON.parse(localStorage.getItem("eifMenuOpen") || "[]"); } catch (e) { return []; }
}
function writeOpen(list) {
  try { localStorage.setItem("eifMenuOpen", JSON.stringify(list)); } catch (e) {}
}
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
  set(readOpen().includes(sec.dataset.fold));
  head.addEventListener("click", () => {
    const open = !sec.classList.contains("open");
    set(open);
    const list = readOpen().filter((x) => x !== sec.dataset.fold);
    if (open) list.push(sec.dataset.fold);
    writeOpen(list);
  });
});

// Reset asks first, inline.
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
    save("Settings reset");
    paintReset(false);
  });
  const no = el("button", { type: "button", class: "link" }, "Cancel");
  no.addEventListener("click", () => paintReset(false));
  w.append(yes, no);
  yes.focus();
}
paintReset(false);

// ---- This tab ------------------------------------------------------------------
// Only the pages Copycat Hunt runs on (manifest content_scripts). v3.20.3:
// merch.amazon.com, Amazon sign-in/cart and eBay sign-in/checkout used to say
// "Reload this page", which never helped there.
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
    // v3.18.4: say so instead of closing silently when the page didn't answer.
    if (chrome.runtime.lastError || !res) { hud("Reload this page, then try again"); return; }
    window.close();
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
    merch: d.eifMerchMeta && d.eifMerchMeta.state === "ready" ? d.eifMerchMeta.count || 0 : null,
  };
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
    item({ icon: "shirt", color: "indigo", label: "Merch catalog", value: c.merch === null ? "Not connected" : `${c.merch} designs`, info: true });

  if (!site) {
    // v3.19.0: no header text on other sites, just the shortcuts.
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
  // Ask the page what it is (product / listing, yours or not).
  const info = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: "eif-page-info" }, (res) => resolve(chrome.runtime.lastError ? null : res));
  });
  if (!info || !info.ok) {
    line.textContent = `On ${where}`;
    sub.textContent = "Reload this page to use Copycat Hunt here.";
    open.hidden = true;
    const r = item({ icon: "clock", color: "gray", label: "Reload this page", onClick: () => { chrome.tabs.reload(tab.id); window.close(); } });
    list.append(r);
    return;
  }
  line.textContent = info.asin ? `Amazon product ${info.asin}` : info.item ? `eBay listing #${info.item}` : `On ${where}`;
  if (info.mine) line.append(el("span", { class: "mine-tag" }, "yours"));
  // Keep the old one-line wording for tests/screen readers.
  line.setAttribute("aria-label", info.asin ? `Amazon product ${info.asin}${info.mine ? " · yours" : ""}` : line.textContent);
  sub.textContent = info.asin || info.item ? "" : "Drop a listing photo on the page to start a hunt.";
  open.hidden = false;
  open.onclick = () => openOnPage("results");
  if (info.asin) list.append(item({ icon: "shield", color: "red", label: "Check this product for hijacks", onClick: () => openOnPage("az-hijack") }));
  else if (info.item) list.append(item({ icon: "shield", color: "red", label: "Check this listing for hijacks", onClick: () => openOnPage("hijack-page") }));
  else list.append(item({ icon: "shield", color: "red", label: "Hijacks", onClick: () => openOnPage("hijacks") }));
  list.append(
    item({ icon: "pin", color: "orange", label: "Tracked", value: c.tracked, onClick: () => openOnPage("tracked") }),
    item({ icon: "flag", color: "blue", label: "Report", onClick: () => openOnPage("report") }),
    item({ icon: "clock", color: "green", label: "Reported", value: c.reports, onClick: () => openOnPage("reported") }),
    item({ icon: "user", color: "gray", label: "My listings", value: c.mine || "", onClick: () => openOnPage("mine") }),
    merchRow()
  );
}

// ---- License -------------------------------------------------------------------
// The worker owns the key and decides; this menu only shows its sanitized
// status and sends the key the user types here (an extension page, so
// website scripts can't read it).
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
  // v3.23.2: the license sits in its own card with a status pill (owner
  // asked for the "ACTIVE" card from the startup template), not in the header.
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

  // Locked.
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
  // No key yet (or one that can't be used): offer a way to get a license.
  const buy = $("#lic-buy");
  if (buy && self.EifLinks) {
    buy.hidden = form.hidden || code === "CHECKING";
    $("#lic-buy-link").href = self.EifLinks.buyHref();
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

// ---- Setup reminder ----------------------------------------------------------------
// Unfinished setup, or a marketplace skipped there: offer to open the setup page.
function paintSetup(raw) {
  const s = raw && typeof raw === "object" ? raw : null;
  const row = $("#setup-row");
  let text = "";
  if (!s || s.state !== "complete") text = "Setup isn't finished yet.";
  else if (s.merch === "skipped") text = "Merch isn't connected. Connect it to recognise your own products on Amazon.";
  row.hidden = !text;
  $("#setup-text").textContent = text;
}
function openSetup() {
  chrome.runtime.sendMessage({ type: "eif-merch-open-setup" }, () => { void chrome.runtime.lastError; window.close(); });
}
$("#open-setup").addEventListener("click", openSetup);
$("#setup-link").addEventListener("click", openSetup);
chrome.storage.local.get({ eifSetup: null }, (d) => paintSetup(d && d.eifSetup));
chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.eifSetup) paintSetup(ch.eifSetup.newValue); });

// ---- Logo --------------------------------------------------------------------------
// Inline art, so the claw marks can swipe in when the menu opens locked.
const M = self.EifMotion || null;
if (M && M.logoSvg()) $("#logo").innerHTML = M.logoSvg();
// (v3.19.3: the claws swipe is part of the opening animation)

// v3.19.3: opening animation, played once when the menu has its content:
// the logo pops and its scratches swipe in, the name slides in, then each
// section rises into place one after another.
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

// ---- Builder tools (v3.25.0) -------------------------------------------------------
// Hidden for customers: 5 clicks on the version number show it (remembered in
// eifBuilderTools). The switch decides whether searches keep their results;
// Export builds a CSV here, from local storage only, and downloads it.
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
let verClicks = [];
$("#ver").addEventListener("click", () => {
  const now = Date.now();
  verClicks = verClicks.filter((t) => now - t < 3000).concat(now);
  if (verClicks.length < 5) return;
  verClicks = [];
  chrome.storage.local.set({ eifBuilderTools: true });
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

// ---- Start ---------------------------------------------------------------------
$("#ver").textContent = `v${chrome.runtime.getManifest().version}`;
chrome.storage.local.get({ eifPrefs: {} }, (d) => {
  prefs = readPrefs(d.eifPrefs);
  paintPrefs();
});
refreshLicense();
paintPage();

// v3.27.0: "Fix problems": unsticks syncs, clears an eBay pause, restarts and
// checks the database, closes old report jobs, checks the license. Says what
// it did; your data stays. "Restart the extension" is the last resort.
function paintFix(res) {
  const list = $("#fix-list");
  list.textContent = "";
  ((res && res.lines) || [{ ok: false, text: "The tool didn't answer. Try Restart the extension." }]).forEach((l) => {
    list.appendChild(el("li", { class: l.ok ? "ok" : "bad" }, l.text));
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
