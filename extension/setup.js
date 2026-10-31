(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const M = self.EifMotion || { enabled: () => false, bar() {}, count(el, v) { if (el) el.textContent = (Number(v) || 0).toLocaleString("en-US"); }, swap(el, t) { if (el) el.textContent = t; }, feed() {}, claws: () => () => {}, pop() {}, enter() {}, logoSvg: () => "" };
  let st = null;
  let busy = false;
  let pollTimer = 0;
  let licNote = "";
  let autoStarted = false;
  let ebayAutoStarted = false;
  let autoResumed = false;
  let ebayChecking = false;
  let ebayCheckedAt = 0;
  let merchCheckedAt = 0;
  let watchUntil = { merch: 0, ebay: 0 };
  let sawPending = false;
  let autoClose = 0;

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r));
      } catch (e) {
        resolve(null);
      }
    });
  }

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n) => (Number(n) || 0).toLocaleString("en-US");
  function ago(t) {
    if (!t) return "";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return `${Math.round(s / 3600)} h ago`;
  }

  const REASONS = {
    user_paused: "Paused.",
    signed_out: "Your Merch sign-in expired. Sign in again; saved progress is kept.",
    rate_limited: "Merch is limiting requests. It continues by itself in a minute.",
    network: "No connection to merch.amazon.com. It continues by itself in a minute.",
    timeout: "Merch took too long to answer. It continues by itself in a minute.",
    page_token_expired: "Merch no longer accepts the saved position (it expired). Start over to sync again; your previous product list stays in use until then.",
    account_changed: "The signed-in Merch account changed. Start over for the account that's signed in now.",
    repeated_page_token: "Merch sent the same page twice, so the sync stopped to be safe. Start over.",
    pagination_runaway: "Merch kept sending pages past the total it reported, so the sync stopped. Start over.",
    pagination_incomplete: "Merch stopped sending pages before all your products arrived. Start over.",
    too_many_pages: "This catalog is larger than Copycat Hunt can sync (over 2,200,000 records).",
    catalog_too_large: "This catalog has more listings than Copycat Hunt can keep (over 2,000,000).",
    unexpected_response: "Merch answered in a format the extension doesn't recognise. Start over later.",
    storage_write: "Chrome couldn't save the sync (disk full?). Free some space; it tries again by itself.",
    staged_page_missing: "Part of the saved sync is missing. Start over.",
    storage_full: "Your computer's disk is full, so the sync can't be saved. Free some space, then press Resume. Your previous list stays in use.",
    storage_unavailable: "The catalog database on this computer didn't start. It tries again by itself in a minute.",
    storage_busy: "The catalog database on this computer is busy. It tries again by itself in a minute.",
    storage_io: "Chrome couldn't write to the catalog database on this computer. It tries again by itself in a minute.",
    storage_timeout: "The catalog database took too long to answer. It tries again by itself in a minute.",
    storage_unsupported: "This browser can't keep the catalog database (it needs Chrome 116 or newer, with site data allowed for extensions).",
    storage_corrupt: "The catalog saved on this computer can't be read. Rebuild it, then sync again.",
    storage_newer: "The catalog on this computer was saved by a newer version of Copycat Hunt. Update the extension, or rebuild the catalog.",
    empty_result_kept_previous: "Merch returned no listings, so your previous product list was kept.",
    cancelled: "Sync cancelled.",
    identity_not_found: "Couldn't read your Merch account from the dashboard page.",
    internal_error: "Something went wrong. Start over.",
  };
  const reason = (r) => REASONS[r] || (r ? `Stopped (${r}).` : "");
  const SALES_REASONS = {
    logged_out: "Your Merch sign-in ended before your sales were read.",
    rate_limited: "Merch is limiting requests, so your sales weren't read yet.",
    network: "Couldn't reach Merch to read your sales.",
    timeout: "Merch took too long to send your sales.",
    unexpected_response: "Merch sent your sales in a format the extension doesn't recognise.",
    no_catalog: "Your products have to be synced before your sales.",
  };
  const salesLoading = (sales) => sales.state === "loading" && !sales.stuck;

  const shown = {};
  const loops = {};
  function body(name, html) {
    if (shown[name] === html) return false;
    shown[name] = html;
    if (loops[name]) { loops[name](); loops[name] = null; }
    $(name + "-body").innerHTML = html;
    return true;
  }
  const stepWas = {};
  function setStep(name, cls, tag) {
    const el = $("step-" + name);
    el.classList.remove("on", "ok", "warn", "skip");
    if (cls) el.classList.add(cls);
    $(name + "-tag").textContent = tag || "";
    if (cls === "ok" && stepWas[name] !== undefined && stepWas[name] !== "ok") M.pop(el.querySelector(".dot"));
    stepWas[name] = cls || "";
  }

  const SALES_SHARE = 10;

  function syncBlock(name, kind, run, stage, buttons, sales) {
    const sig = `${kind}|${sales ? "finalizing" : run.state}|${buttons}`;
    const fresh = body(name, `<div class="sync" data-sig="${esc(sig)}">
      <div class="sync-top"><span class="sync-logo">${M.logoSvg()}</span><span class="sync-stage" data-f="stage"></span><span class="sync-pct" data-f="pct"></span></div>
      <div class="bar"><i data-f="bar"></i></div>
      <div class="nums"><span><b data-f="read">0</b><span data-f="of"> of <b data-f="total">0</b></span> ${kind === "merch" ? "records" : "listings"} read</span>${kind === "merch" ? '<span><b data-f="usable">0</b> usable listings</span>' : ""}<span>page <b data-f="page">0</b></span></div>
      <ul class="feed" data-f="feed" aria-label="Just synced"></ul>
      <p class="warn" data-f="wait" hidden></p>
      ${buttons}
    </div>`);
    const box = $(name + "-body");
    const f = (k) => box.querySelector(`[data-f="${k}"]`);
    if (fresh) loops[name] = M.claws(box.querySelector(".sync-logo svg"), { loop: true });
    const total = run.expectedTotal;
    let pct = total ? Math.min(100, Math.round((run.rawScanned / Math.max(1, total)) * 100)) : 0;
    if (kind === "merch") pct = sales ? 100 - SALES_SHARE + Math.round((SALES_SHARE * Math.min(sales.done || 0, sales.total || 0)) / Math.max(1, sales.total || 0)) : Math.round((pct * (100 - SALES_SHARE)) / 100);
    M.swap(f("stage"), stage);
    f("pct").textContent = total || sales ? `${pct}%` : "";
    const indet = !sales && (!total || run.state === "finalizing");
    box.querySelector(".bar").classList.toggle("indet", indet);
    if (indet) f("bar")._v = null;
    else M.bar(f("bar"), pct);
    M.count(f("read"), run.rawScanned);
    f("of").hidden = total == null;
    if (total != null) M.count(f("total"), total);
    if (f("usable")) M.count(f("usable"), run.usable);
    M.count(f("page"), run.pagesDone);
    M.feed(f("feed"), run.recent);
    const wait = run.waitUntil && run.waitUntil > Date.now() ? `${kind === "merch" ? "Merch" : "eBay"} asked us to wait. Continuing in ${Math.ceil((run.waitUntil - Date.now()) / 1000)} s.` : "";
    f("wait").hidden = !wait;
    f("wait").textContent = wait;
  }
  function buyLink() {
    const L = self.EifLinks;
    if (!L) return "";
    const list = (items) => `<ul>${items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;
    const prices = L.PLANS.map((p, i) => `<a class="btn${i === 0 ? " primary" : ""} plan-price" data-plan="${esc(p.id)}" href="${esc(L.checkoutHref(p.id))}" target="_blank" rel="noopener">${esc(p.price)} <span>${esc(p.per)}</span>${p.note ? ` <small>${esc(p.note)}</small>` : ""}</a>`).join("");
    return `<div class="buy">
      <p class="buy-head">No license yet? <button type="button" class="link" data-ui="plans" aria-expanded="false">Get one</button></p>
      <div class="plans-wrap">
      <div class="plans">
        <div class="plan"><div class="plan-name">Starter</div>${list(L.STARTER)}<div class="plan-prices">${prices}</div></div>
        <div class="plan soon" aria-disabled="true"><div class="plan-name">Pro <span class="soon-tag">Coming soon</span></div>${list(L.PRO)}</div>
      </div>
      <p class="buy-note">Payment is handled by Stripe in a new tab. After paying you'll see your key there: copy it and paste it in the box above.</p>
      </div>
    </div>`;
  }
  const merchSettled = (setup) => setup.merch === "done";
  function compact(on) {
    if (document.body.classList.contains("compact") === on) return;
    const top = document.querySelector(".top");
    const before = top.getBoundingClientRect().top;
    document.body.classList.toggle("compact", on);
    const dy = before - top.getBoundingClientRect().top;
    if (dy && M.enabled() && self.gsap) self.gsap.fromTo(".wrap", { y: dy }, { y: 0, duration: 0.45, ease: "expo.out", clearProps: "transform" });
  }
  const skipLink = (step, label) => `<div class="skiprow"><button type="button" class="link" data-act="skip-${step}">${label}</button></div>`;

  function runActive(run) {
    return run && (run.state === "syncing" || run.state === "finalizing");
  }

  function render() {
    if (!st) {
      body("license", "<p>Starting…</p>");
      return;
    }
    const lic = st.license || {};
    const id = st.identity || {};
    const run = st.run || { state: "idle" };
    const setup = st.setup || {};

    if (!lic.ok) {
      setStep("license", "on", "");
      body("license", `<p>${esc(lic.message || "Copycat Hunt needs a license key.")}</p>
        <form class="lic-form" id="lic-form" autocomplete="off">
          <input id="lic-key" type="text" maxlength="1024" spellcheck="false" placeholder="Paste your license key" aria-label="License key" />
          <button type="submit" class="btn primary" id="lic-go">Activate</button>
        </form>
        ${licNote ? `<p class="err">${esc(licNote)}</p>` : "<p>Your key is shown on the page you see after paying. Already have one from us by email? Paste that.</p>"}
        ${buyLink()}`);
      for (const n of ["signin", "sync", "ebay"]) { setStep(n, "", ""); body(n, ""); $("step-" + n).hidden = true; }
      compact(!document.body.classList.contains("plans-open"));
      $("tabs-note").hidden = !!(setup.state === "complete");
      $("done").hidden = true;
      $("skip").hidden = false;
      return;
    }
    licNote = "";
    for (const n of ["signin", "sync", "ebay"]) $("step-" + n).hidden = false;
    compact(false);
    setStep("license", "ok", "Active");
    {
      const until = lic.expiry ? new Date(lic.expiry).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
      $("license-tag").innerHTML = `${until ? `<span class="lic-until">Until ${esc(until)}</span>` : ""}<span class="lic-pill">Active</span>`;
    }
    $("tabs-note").hidden = !!(setup.state === "complete");
    body("license", "");

    renderMerch(id, run, setup);
    renderEbay(setup);

    const eb0 = st.ebay || {};
    const ebayStarting = ebayAutoStarted && ((eb0.run || {}).state || "idle") === "idle" && !eb0.catalog && (eb0.session === "signed_in" || eb0.session === "unchecked" || !eb0.session);
    const done = !!setup.resolved && !runActive(run) && !runActive(eb0.run) && !ebayStarting && !(setup.merch === "done" && salesLoading(st.sales || {}));
    const wasDone = !$("done").hidden;
    $("done").hidden = !done;
    $("skip").hidden = done;
    if (!done) sawPending = true;
    if (done && !wasDone) {
      $("done-logo").innerHTML = M.logoSvg();
      M.enter($("done"));
      M.claws($("done-logo").querySelector("svg"));
      if (sawPending && !autoClose) {
        autoClose = setTimeout(() => act("finish"), 2600);
      }
    }
    if (done) {
      const parts = [];
      if (setup.merch === "done") {
        const count = st.catalog ? st.catalog.count : run.usable;
        parts.push(`Your Merch products are synced (${num(count)} listing${count === 1 ? "" : "s"}), so Copycat Hunt can tell your own products from copies on Amazon.${st.sales && st.sales.state === "ready" ? " Your best sellers are ready in the Best sellers tab." : ""} It keeps both up to date by itself.`);
      }
      if (setup.ebay === "signed_in") {
        const ec = st.ebay && st.ebay.catalog;
        parts.push(setup.ebayMode === "account" ? "Your eBay account is connected for reporting copies on eBay." : ec ? `Your eBay listings are synced (${num(ec.count)}), so they're never tracked or reported.` : "eBay is connected.");
      }
      if (setup.ebay === "skipped") parts.push("No eBay account connected. If copies show up on eBay, make a free account and connect it from the setup page.");
      if (autoClose) parts.push("This page closes by itself.");
      $("done-text").textContent = parts.join(" ");
    }
  }

  function renderMerch(id, run, setup) {

    const signedIn = id.state === "verified";
    const expired = run.state === "needs_login";
    if (!signedIn || expired) {
      setStep("signin", "on", "");
      const msg = expired
        ? "Your Merch sign-in expired during the sync. Sign in again; the sync continues from where it stopped."
        : id.state === "logged_out"
          ? "Sign in to merch.amazon.com in this browser. Copycat Hunt uses that sign-in; it never asks for your password. This page notices by itself when you're back."
          : id.state === "rate_limited"
            ? "Merch is limiting requests right now. Try again in a minute."
            : id.state === "unchecked" || !id.state
              ? "Checking your Merch sign-in…"
              : `Couldn't check your Merch sign-in (${esc(id.reason || id.state)}).`;
      const checking = id.state === "unchecked" || !id.state;
      body("signin", `<p${expired ? ' class="warn"' : ""}>${msg}</p>
        ${checking ? "" : `<div class="row">${id.state === "logged_out" || expired ? '<button type="button" class="btn primary" data-act="signin">Sign in to Merch</button>' : ""}
        <button type="button" class="btn" data-act="recheck">Check again</button></div>`}`);
      setStep("sync", "", "");
      body("sync", expired ? `<p>${num(run.rawScanned)} records already synced and saved.</p>` : "<p>Starts by itself once you're signed in to Merch.</p>");
      return;
    }
    setStep("signin", "ok", id.account ? `Account ${esc(id.account)}` : "Signed in");
    body("signin", "");

    const store = st.storage || {};
    if (store.state === "failed" && store.code && !runActive(run)) {
      const fixable = store.code === "storage_corrupt" || store.code === "storage_newer";
      setStep("sync", "warn", "Can't save");
      body("sync", `<p class="warn">${esc(reason(store.code))}</p>
        ${fixable ? '<p>Rebuilding clears the catalog saved on this computer. Nothing on Merch or eBay changes.</p><div class="row"><button type="button" class="btn primary" data-act="rebuild-db">Rebuild the catalog</button></div>' : ""}`);
      return;
    }
    const total = run.expectedTotal;
    const pct = total ? Math.min(100, Math.round((run.rawScanned / Math.max(1, total)) * 100)) : 0;
    const nums = `<div class="nums"><span><b>${num(run.rawScanned)}</b>${total != null ? ` of <b>${num(total)}</b>` : ""} records read</span><span><b>${num(run.usable)}</b> usable listings</span><span>page <b>${num(run.pagesDone)}</b></span>${run.lastPageAt ? `<span>last page ${esc(ago(run.lastPageAt))}</span>` : ""}</div>`;
    if (runActive(run)) {
      const fin = run.state === "finalizing";
      setStep("sync", "on", fin ? "Saving…" : "Syncing");
      syncBlock("sync", "merch", run, fin ? "Checking and saving your products" : "Reading your Merch listings",
        fin ? "" : '<p>Big catalogs take a few minutes. You can keep using Chrome meanwhile.</p><div class="row"><button type="button" class="btn" data-act="pause">Pause</button><button type="button" class="btn" data-act="cancel">Cancel</button></div>');
      return;
    }
    if (run.state === "paused") {
      setStep("sync", "warn", "Paused");
      body("sync", `${nums}<p class="warn">${esc(reason(run.error))}</p>
        <div class="row"><button type="button" class="btn primary" data-act="resume">Resume</button><button type="button" class="btn" data-act="cancel">Cancel</button></div>`);
      return;
    }
    if (setup.merch === "done" && (run.state === "complete" || run.state === "idle" || (run.state === "failed" && run.error === "empty_result_kept_previous"))) {
      const count = st.catalog ? st.catalog.count : run.usable;
      const sales = st.sales || {};
      if (salesLoading(sales)) {
        setStep("sync", "on", "Syncing");
        syncBlock("sync", "merch", { ...run, rawScanned: run.rawScanned || count, usable: run.usable || count }, "Finishing the sync", "", sales);
        return;
      }
      setStep("sync", "ok", `${num(count)} listing${count === 1 ? "" : "s"}`);
      body("sync", sales.state === "failed" ? `<p class="warn">${esc(SALES_REASONS[sales.error] || "Your sales couldn't be read right now.")} Your products are synced; only Best sellers waits for this.</p>
        <div class="row"><button type="button" class="btn" data-act="sales-retry">Try again</button></div>` : "");
      return;
    }
    const failed = run.state === "failed" || run.state === "cancelled";
    const starting = !failed && autoStarted;
    setStep("sync", failed && run.error !== "cancelled" ? "warn" : "on", starting ? "Starting…" : "");
    const existing = st.catalog && st.catalog.sameAccount ? `<p>You already have ${num(st.catalog.count)} products from this account. They stay in use until a new sync finishes.</p>` : "";
    if (starting) {
      body("sync", `<div class="bar indet"><i></i></div><p>Connecting to Merch…</p>`);
      return;
    }
    body("sync", `${failed && run.error ? `<p class="warn">${esc(reason(run.error))}</p>` : ""}${existing}
      <p>Copycat Hunt reads the list of your Merch listings, then how many of each sold (units only, no money), and keeps both on this computer.</p>
      <div class="row"><button type="button" class="btn primary" data-act="${failed ? "restart" : "start"}">${failed && run.state !== "cancelled" ? "Start over" : "Sync my products"}</button></div>`);
  }

  const ebayChoices = () => `<div class="choices" role="group" aria-label="Your eBay account">
      <button type="button" class="choice" data-act="ebay-mode-seller"><b>I sell on eBay</b><span>Copycat Hunt reads your listings from Seller Hub so it never flags them as copies.</span></button>
      <button type="button" class="choice" data-act="ebay-mode-account"><b>I have an eBay account, but I don't sell there</b><span>That's enough to report copies of your designs on eBay.</span></button>
      <button type="button" class="choice" data-act="ebay-mode-none"><b>I don't have an eBay account</b><span>Skip eBay for now. You can make a free account later if copies show up there.</span></button>
    </div>`;
  const changeLink = () => `<div class="skiprow"><button type="button" class="link" data-act="ebay-mode-change">Change my answer</button></div>`;

  function renderEbay(setup) {
    const eb = st.ebay || {};
    const mode = setup.ebayMode;
    if (!mode) {
      setStep("ebay", merchSettled(setup) ? "on" : "", merchSettled(setup) ? "" : "Answer any time");
      body("ebay", `<p>Do you have an eBay account?</p>${ebayChoices()}`);
      return;
    }
    if (mode === "none") {
      setStep("ebay", "skip", "No account");
      body("ebay", `<p>No eBay account connected. Copycat Hunt works on Amazon. If copies of your designs show up on eBay, make a free eBay account (you don't need to sell there), then connect it here to report them.</p>
        <div class="row"><button type="button" class="btn" data-act="ebay-mode-change">I have an eBay account now</button></div>`);
      return;
    }
    if (!merchSettled(setup) && !(eb.catalog && eb.catalog.count >= 0) && !runActive(eb.run)) {
      setStep("ebay", "", "Next");
      body("ebay", `<p>${mode === "seller" ? "Your eBay listings sync" : "eBay sign-in is checked"} after your Merch products are synced.</p>${changeLink()}`);
      return;
    }
    if (mode === "account") {
      if (setup.ebay === "signed_in") {
        setStep("ebay", "ok", "Signed in · for reporting");
        body("ebay", "");
        return;
      }
      if (ebayChecking && !ebayCheckedAt) {
        setStep("ebay", "on", "Checking…");
        body("ebay", `<p>Checking your eBay sign-in…</p>`);
        return;
      }
      setStep("ebay", "on", "");
      const tabNeeded = eb.reason === "needs_ebay_tab";
      body("ebay", `<p>Sign in to ebay.com in this browser. Copycat Hunt uses that sign-in to open eBay's report form for you. Your password stays with eBay.</p>
        ${tabNeeded ? '<p class="warn">eBay only answered from an open eBay tab. Open one, then press Check again.</p>' : ""}
        <div class="row">${tabNeeded ? '<button type="button" class="btn" data-act="ebay-open-tab">Open eBay in a tab</button>' : ""}<button type="button" class="btn primary" data-act="signin-ebay">Sign in to eBay</button>
        <button type="button" class="btn" data-act="check-ebay"${ebayChecking ? " disabled" : ""}>${ebayChecking ? "Checking…" : "Check again"}</button></div>
        ${changeLink()}`);
      return;
    }
    if (setup.ebay === "signed_in" || (eb.catalog && eb.catalog.count >= 0)) return renderEbaySync(setup, eb);
    if (ebayChecking && !ebayCheckedAt) {
      setStep("ebay", "on", "Checking…");
      body("ebay", `<p>Checking your eBay sign-in…</p>`);
      return;
    }
    setStep("ebay", "on", "");
    const needTab = eb.reason === "needs_ebay_tab";
    const noHub = eb.reason === "not_seller_hub";
    body("ebay", `<p>Sign in to ebay.com in this browser so Copycat Hunt can read your listings from Seller Hub and send reports. Your password stays with eBay.</p>
      ${needTab ? '<p class="warn">eBay only answered from an open eBay tab. Open one, then press Check again.</p>' : ""}
      ${noHub ? '<p class="warn">This eBay account has no Seller Hub listings. If you don\'t sell on eBay, change your answer below.</p>' : ""}
      <div class="row">${needTab ? '<button type="button" class="btn primary" data-act="ebay-open-tab">Open eBay in a tab</button>' : ""}<button type="button" class="btn${needTab ? "" : " primary"}" data-act="signin-ebay">Sign in to eBay</button>
      <button type="button" class="btn" data-act="check-ebay"${ebayChecking ? " disabled" : ""}>${ebayChecking ? "Checking…" : "Check again"}</button></div>
      ${changeLink()}`);
  }

  const EBAY_REASONS = {
    needs_ebay_tab: "eBay only answers from an open eBay tab. Open one; the sync continues by itself.",
    captcha: "eBay wants to check that you're a person. Copycat Hunt opened eBay in a tab: complete the check there, then press Resume.",
    signed_out: "Your eBay sign-in expired. Sign in again; saved progress is kept.",
    rate_limited: "eBay is limiting requests. It continues by itself in a minute.",
    network: "No connection to eBay. It continues by itself in a minute.",
    timeout: "eBay took too long to answer. It continues by itself in a minute.",
    http_5xx: "eBay had a problem. It continues by itself in a minute.",
    unexpected_response: "Seller Hub answered in a way Copycat Hunt doesn't recognise. Start over later.",
    account_changed: "The signed-in eBay account changed. Start over for the account that's signed in now.",
    not_seller_hub: "This eBay account has no Seller Hub listings page yet.",
    pagination_incomplete: "Seller Hub stopped sending pages before all your listings arrived. Start over.",
    empty_result_kept_previous: "Seller Hub showed no listings, so your previous list was kept.",
  };
  const ebayReason = (r) => EBAY_REASONS[r] || reason(r);

  function renderEbaySync(setup, eb) {
    const run = eb.run || { state: "idle" };
    const cat = eb.catalog;
    const total = run.expectedTotal;
    const pct = total ? Math.min(100, Math.round((run.rawScanned / Math.max(1, total)) * 100)) : 0;
    const nums = `<div class="nums"><span><b>${num(run.rawScanned)}</b>${total != null ? ` of <b>${num(total)}</b>` : ""} listings read</span><span>page <b>${num(run.pagesDone)}</b></span>${run.lastPageAt ? `<span>last page ${esc(ago(run.lastPageAt))}</span>` : ""}</div>`;
    const store = st.storage || {};
    if (store.state === "failed" && store.code && !runActive(run) && !cat) {
      setStep("ebay", "warn", "Can't save");
      body("ebay", `<p class="warn">${esc(reason(store.code))}</p>`);
      return;
    }
    if (runActive(run)) {
      const fin = run.state === "finalizing";
      setStep("ebay", "on", fin ? "Saving…" : "Syncing");
      syncBlock("ebay", "ebay", run, fin ? "Saving your eBay listings" : "Reading your Seller Hub listings",
        fin ? "" : '<div class="row"><button type="button" class="btn" data-act="ebay-pause">Pause</button><button type="button" class="btn" data-act="ebay-cancel">Cancel</button></div>');
      return;
    }
    if (run.state === "paused" || run.state === "needs_login") {
      setStep("ebay", "warn", run.state === "needs_login" ? "Sign in" : "Paused");
      const tab = run.error === "needs_ebay_tab";
      body("ebay", `${nums}<p class="warn">${esc(ebayReason(run.error))}</p>
        <div class="row">${tab ? '<button type="button" class="btn primary" data-act="ebay-open-tab">Open eBay in a tab</button>' : ""}${run.state === "needs_login" ? '<button type="button" class="btn primary" data-act="signin-ebay">Sign in to eBay</button>' : ""}<button type="button" class="btn${tab || run.state === "needs_login" ? "" : " primary"}" data-act="ebay-resume">Resume</button><button type="button" class="btn" data-act="ebay-cancel">Cancel</button></div>`);
      return;
    }
    if (cat && (run.state === "complete" || run.state === "idle" || (run.state === "failed" && run.error === "empty_result_kept_previous"))) {
      setStep("ebay", "ok", `${num(cat.count)} listing${cat.count === 1 ? "" : "s"}`);
      body("ebay", "");
      return;
    }
    const failed = run.state === "failed" || run.state === "cancelled";
    const starting = !failed && ebayAutoStarted;
    if (starting && run.state === "idle" && eb.session && eb.session !== "signed_in" && eb.session !== "unchecked") {
      const tab = eb.reason === "needs_ebay_tab";
      const out = eb.session === "signed_out";
      setStep("ebay", "warn", out ? "Sign in" : "Couldn't start");
      body("ebay", `<p class="warn">${out ? "eBay asked you to sign in again. Sign in, then press Sync my listings." : esc(ebayReason(eb.reason || "network"))}</p>
        <div class="row">${tab ? '<button type="button" class="btn primary" data-act="ebay-open-tab">Open eBay in a tab</button>' : ""}${out ? '<button type="button" class="btn primary" data-act="signin-ebay">Sign in to eBay</button>' : ""}<button type="button" class="btn${tab || out ? "" : " primary"}" data-act="ebay-start">Sync my listings</button></div>`);
      return;
    }
    if (starting && run.state === "idle") {
      setStep("ebay", "on", "Starting…");
      body("ebay", `<div class="bar indet"><i></i></div><p>Connecting to Seller Hub…</p>`);
      return;
    }
    setStep("ebay", failed && run.error !== "cancelled" ? "warn" : "on", "Signed in");
    body("ebay", `${failed && run.error ? `<p class="warn">${esc(ebayReason(run.error))}</p>` : ""}
      <p>Copycat Hunt reads your active listings from Seller Hub (item numbers, titles and photos) and keeps them on this computer, so your own listings are never tracked or reported.</p>
      <div class="row"><button type="button" class="btn primary" data-act="${failed ? "ebay-restart" : "ebay-start"}">${failed && run.state !== "cancelled" ? "Start over" : "Sync my listings"}</button></div>`);
  }

  async function auto() {
    if (!st || !st.license || !st.license.ok || busy) return;
    const id = st.identity || {};
    const run = st.run || {};
    const setup = st.setup || {};
    const storeOk = !(st.storage && st.storage.state === "failed");
    if (setup.merch !== "done" && id.state === "verified" && run.state === "idle" && !autoStarted && storeOk) {
      autoStarted = true;
      render();
      await send({ type: "eif-setup-start" });
      return refresh();
    }
    if (id.state === "verified" && run.state === "needs_login" && !autoResumed) {
      autoResumed = true;
      await send({ type: "eif-setup-resume" });
      return refresh();
    }
    if (!merchSettled(setup)) return;
    const asked = setup.ebayMode === "seller" || setup.ebayMode === "account";
    if (asked && !setup.ebay && !ebayCheckedAt && !ebayChecking) checkEbay();
    const eb = st.ebay || {};
    if (setup.ebayMode === "seller" && setup.ebay === "signed_in" && !eb.catalog && (eb.run || {}).state === "idle" && !ebayAutoStarted && storeOk) {
      ebayAutoStarted = true;
      render();
      await send({ type: "eif-setup-ebay-start" });
      return refresh();
    }
  }

  async function checkEbay(force) {
    if (ebayChecking) return;
    ebayChecking = true;
    render();
    const r = await send({ type: "eif-setup-ebay-check", force: force === true });
    ebayChecking = false;
    ebayCheckedAt = Date.now();
    if (r && r.ok) st = r;
    render();
  }

  async function checkMerch() {
    merchCheckedAt = Date.now();
    const r = await send({ type: "eif-setup-recheck" });
    if (r && r.ok) st = r;
    render();
    auto();
  }

  function lookAgain(force) {
    if (!st || !st.license || !st.license.ok) return;
    const now = Date.now();
    const setup = st.setup || {};
    const id = st.identity || {};
    const needMerch = id.state !== "verified" || (st.run && st.run.state === "needs_login");
    if (needMerch && (force || now - merchCheckedAt > 5000)) checkMerch();
    if (merchSettled(setup) && !setup.ebay && (setup.ebayMode === "seller" || setup.ebayMode === "account") && !ebayChecking && (force || now - ebayCheckedAt > 5000)) checkEbay();
  }

  async function refresh() {
    const r = await send({ type: "eif-setup-status" });
    if (r && r.gate) { location.replace("info.html"); return; }
    if (r && r.ok) st = r;
    else if (!st) st = { license: { ok: false, message: "Copycat Hunt didn't answer. Reload this page." }, identity: {}, run: { state: "idle" }, setup: {} };
    render();
    schedule();
    auto();
  }

  function schedule() {
    clearTimeout(pollTimer);
    if (document.hidden) return;
    const active = runActive(st && st.run) || runActive(st && st.ebay && st.ebay.run);
    const watching = watchUntil.merch > Date.now() || watchUntil.ebay > Date.now();
    pollTimer = setTimeout(() => {
      if (watching) lookAgain(false);
      refresh();
    }, active ? 1000 : watching ? 6000 : 4000);
  }

  async function activate() {
    const input = $("lic-key");
    const go = $("lic-go");
    const key = input ? input.value.trim() : "";
    if (!key) { licNote = "Paste your license key first."; shown.license = null; render(); return; }
    if (busy) return;
    busy = true;
    input.disabled = true;
    go.disabled = true;
    go.textContent = "Checking…";
    const r = await send({ type: "eif-license-activate", key });
    busy = false;
    if (r && r.ok) {
      licNote = "";
      shown.license = null;
      return refresh();
    }
    licNote = (r && typeof r.message === "string" && r.message) || "Couldn't reach Copycat Hunt. Reload this page and try again.";
    input.disabled = false;
    go.disabled = false;
    go.textContent = "Activate";
    const keep = input.value;
    shown.license = null;
    render();
    const again = $("lic-key");
    if (again) { again.value = keep; again.select(); }
  }

  async function act(what, el) {
    if (busy) return;
    busy = true;
    if (el) el.disabled = true;
    try {
      if (what === "signin") {
        watchUntil.merch = Date.now() + 5 * 60 * 1000;
        await send({ type: "eif-setup-signin" });
      } else if (what === "signin-ebay") {
        watchUntil.ebay = Date.now() + 5 * 60 * 1000;
        await send({ type: "eif-setup-signin", site: "ebay" });
      } else if (what === "recheck") {
        busy = false;
        autoResumed = false;
        await checkMerch();
        return;
      } else if (what === "ebay-start") await send({ type: "eif-setup-ebay-start" });
      else if (what === "ebay-restart") await send({ type: "eif-setup-ebay-start", restart: true });
      else if (what === "ebay-resume") await send({ type: "eif-setup-ebay-resume" });
      else if (what === "ebay-pause") await send({ type: "eif-setup-ebay-pause" });
      else if (what === "ebay-cancel") {
        if (!window.confirm("Cancel the eBay sync? What was read so far is deleted. Your previous list (if any) stays.")) return;
        await send({ type: "eif-setup-ebay-cancel" });
      } else if (what === "ebay-open-tab") {
        await send({ type: "eif-setup-ebay-open-tab" });
        watchUntil.ebay = Date.now() + 5 * 60 * 1000;
      } else if (what === "check-ebay") {
        busy = false;
        await checkEbay(true);
        return;
      } else if (what.startsWith("ebay-mode-")) {
        const choice = what.slice(10);
        const r = await send({ type: "eif-setup-ebay-mode", mode: choice === "change" ? null : choice });
        if (r && r.ok) st = r;
        ebayCheckedAt = 0;
        ebayAutoStarted = false;
        if (r && r.mode && r.mode.error === "syncing") window.alert("Your eBay listings are syncing. Pause or cancel the sync first.");
      } else if (what === "skip-merch" || what === "skip-ebay" || what === "unskip-merch" || what === "unskip-ebay") {
        const step = what.endsWith("merch") ? "merch" : "ebay";
        const r = await send({ type: "eif-setup-skip", step, undo: what.startsWith("unskip") });
        if (r && r.ok) st = r;
        if (what === "unskip-merch") autoStarted = false;
        if (what === "unskip-ebay") { ebayCheckedAt = 0; }
      } else if (what === "rebuild-db") {
        if (!window.confirm("Rebuild the catalog on this computer? The saved Merch and eBay lists are cleared; sync again afterwards.")) return;
        await send({ type: "eif-setup-rebuild-db" });
        autoStarted = false;
      } else if (what === "sales-retry") await send({ type: "eif-setup-sales-retry" });
      else if (what === "start") await send({ type: "eif-setup-start" });
      else if (what === "restart") await send({ type: "eif-setup-start", restart: true });
      else if (what === "resume") await send({ type: "eif-setup-resume" });
      else if (what === "pause") await send({ type: "eif-setup-pause" });
      else if (what === "cancel") {
        if (!window.confirm("Cancel the sync? What was synced so far is deleted. Your previous product list (if any) stays.")) return;
        await send({ type: "eif-setup-cancel" });
      } else if (what === "finish" || what === "skip") {
        const r = await send({ type: "eif-setup-finish", skip: what === "skip" });
        if (!r || !r.ok) location.href = "https://www.amazon.com/";
        return;
      }
    } finally {
      busy = false;
      if (el) el.disabled = false;
    }
    await refresh();
  }

  document.addEventListener("submit", (e) => {
    if (e.target && e.target.id === "lic-form") { e.preventDefault(); activate(); }
  });
  document.addEventListener("click", (e) => {
    const p = e.target.closest && e.target.closest('[data-ui="plans"]');
    if (p) {
      const top = document.querySelector(".top");
      const before = top.getBoundingClientRect().top;
      document.body.classList.add("plans-open");
      p.setAttribute("aria-expanded", "true");
      document.body.classList.remove("compact");
      const dy = before - top.getBoundingClientRect().top;
      if (dy && M.enabled() && self.gsap) self.gsap.fromTo(".wrap", { y: dy }, { y: 0, duration: 0.45, ease: "expo.out", clearProps: "transform" });
      return;
    }
    const b = e.target.closest && e.target.closest("[data-act]");
    if (b) act(b.dataset.act, b);
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { refresh(); lookAgain(false); } });
  window.addEventListener("focus", () => { refresh(); lookAgain(false); });
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && (changes.eifMerchMeta || changes.eifEbayMeta || changes.eifLicenseStatus || changes.eifSetup || changes.eifCatalogStore || changes.eifSalesMeta)) refresh();
    });
  }
  if (M.logoSvg()) {
    $("top-logo").innerHTML = M.logoSvg();
    setTimeout(() => M.claws($("top-logo").querySelector("svg")), 150);
  }
  refresh();
})();
