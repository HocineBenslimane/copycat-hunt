(function () {
  "use strict";
  if (window.top !== window) return;
  if (window.__eifAmazonFillLoaded) return;
  window.__eifAmazonFillLoaded = true;

  const AZ = self.EifAmazonReport;
  const match = String(location.hash || "").match(/(?:^#|&)eif-job=([a-f0-9]{32})(?:&|$)/);
  if (!match || !AZ) return;
  const jobId = match[1];

  const SEL = {
    start: "kat-button#pnf-website-start-report-button",
    searchBox: "textarea#text-search-input",
    searchButton: "button#text-search-button",
    selectAll: "input#selectAllAsinsCheckbox",
    rowCheckbox: 'kat-checkbox[id^="asin-checkbox-id-"]',
    actionButton: "kat-dropdown-button#discovery-header-action-button",
    ipToggle: 'button.btn.dropdown-toggle[data-toggle="dropdown"]',
    copyright: "button#COPYRIGHT.dropdown-item",
    brand: "input#selectedBrand",
    linkMode: 'input#copyrightTypeCOPYRIGHT_LINK[value="COPYRIGHT_LINK"]',
    link: "input#copyrightLink",
    description: "textarea#rav-form-text-area",
    firstName: "input#firstName",
    lastName: "input#lastName",
    company: "input#company",
    addressLine1: "input#addressLine1",
    addressLine2: "input#addressLine2",
    city: "input#city",
    state: "input#stateOrRegion",
    postalCode: "input#postalCode",
    countryDropdown: "kat-dropdown#countryCode",
    country: "input.rbt-input-main",
    countryOption: ".dropdown-item:not(.rbt-menu-pagination-option)",
    phone: "input#phoneNumber",
    contactName: "input#contactName",
    contactEmail: "input#contactEmailAddress",
    rightsOwner: "input#raOrRoRIGHTS_OWNER",
    agent: "input#raOrRoAGENT",
    sellerNo: "input#sellerNO",
    sellerYes: "input#sellerYES",
  };

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  let cancelled = false;
  let job = null;
  let leaseToken = "";
  const completed = [];
  const notes = [];

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res || null));
      } catch (e) {
        resolve(null);
      }
    });
  }
  async function report(patch) {
    const res = await send({ type: "eif-amazon-job-update", jobId, leaseToken, patch });
    if (!res || !res.ok) {
      cancelled = true;
      return false;
    }
    return true;
  }

  let bar = null;
  function showBar(text, tone, buttons = [], step = "Amazon report") {
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "eif-report-bar";
      bar.dataset.side = "right";
      document.body.appendChild(bar);
      bar.addEventListener("click", (e) => {
        const b = e.target.closest("[data-rb]");
        if (b && bar._h && bar._h[b.dataset.rb]) bar._h[b.dataset.rb]();
      });
    }
    bar._h = {};
    buttons.forEach((b) => (bar._h[b.id] = b.run));
    bar.className = tone ? `eif-rb-${tone}` : "";
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    bar.innerHTML = `
      <div class="eif-rb-main"><div class="eif-rb-step">${esc(step)}</div><div class="eif-rb-text">${esc(text)}</div></div>
      ${buttons.map((b) => `<button type="button" class="eif-hunt-btn ${b.primary ? "eif-hunt-btn-primary" : ""}" data-rb="${b.id}">${esc(b.label)}</button>`).join("")}`;
  }

  async function waitFor(fn, timeout = 8000, every = 100) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (cancelled) return null;
      const v = fn();
      if (v) return v;
      await delay(every);
    }
    return null;
  }
  const $ = (sel, root = document) => root.querySelector(sel);
  const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);

  function nativeSet(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const same = (a, b) => String(a || "").replace(/\s+/g, " ").trim() === String(b || "").replace(/\s+/g, " ").trim();

  async function setText(key, value, { optional = false, retrying = false } = {}) {
    const el = await waitFor(() => $(SEL[key]), optional ? 1500 : 8000);
    if (!el) {
      if (optional) return true;
      throw stepError(key, `Couldn't find the "${label(key)}" field on Amazon's form.`);
    }
    if (same(el.value, value)) return true;
    if (retrying && String(el.value || "").trim() && completed.includes(key)) {
      notes.push(`Kept your own edit in "${label(key)}".`);
      return true;
    }
    for (let i = 0; i < 3; i++) {
      el.focus();
      nativeSet(el, value);
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      await delay(200);
      if (same(el.value, value)) return true;
    }
    if (optional && !value) return true;
    throw stepError(key, `Amazon's "${label(key)}" field didn't keep the value.`);
  }

  async function clickWhere(getEl, check, key, timeout = 8000) {
    if (check()) return true;
    const el = await waitFor(getEl, timeout);
    if (!el) throw stepError(key, `Couldn't find "${label(key)}" on Amazon's form.`);
    for (let i = 0; i < 3; i++) {
      el.click();
      await delay(250);
      if (check()) return true;
    }
    throw stepError(key, `"${label(key)}" didn't stay selected.`);
  }

  function radioLabel(input) {
    if (!input) return null;
    return (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`)) || input.closest("label") || input;
  }

  function radioByText(anchor, re) {
    if (!anchor || !anchor.name) return null;
    const group = [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(anchor.name)}"]`)];
    return group.find((r) => re.test((radioLabel(r) || r).textContent || "")) || null;
  }

  function katClickTarget(box) {
    return (box.shadowRoot && box.shadowRoot.querySelector('[part="checkbox-check"], [role="checkbox"]')) || box;
  }
  function katChecked(box) {
    const inner = box.shadowRoot && box.shadowRoot.querySelector('[role="checkbox"]');
    if (inner && inner.getAttribute("aria-checked") != null) return inner.getAttribute("aria-checked") === "true";
    const attr = box.getAttribute("checked");
    return attr != null && attr !== "false";
  }

  async function pickKatOption(dd, value) {
    const ok = () => String(dd.getAttribute("value") || "") === value;
    if (ok()) return true;
    const option = dd.querySelector(`kat-option[value="${CSS.escape(value)}"]`);
    if (!option) return false;
    const opener = (dd.shadowRoot && dd.shadowRoot.querySelector(".select-header, .header, [part~='dropdown-header'], button")) || dd;
    opener.click();
    await delay(250);
    option.scrollIntoView && option.scrollIntoView({ block: "nearest" });
    option.click();
    await delay(300);
    if (ok()) return true;
    dd.setAttribute("value", value);
    dd.dispatchEvent(new CustomEvent("change", { bubbles: true, composed: true, detail: { value } }));
    await delay(300);
    return ok();
  }

  const LABELS = {
    start: "Start report",
    search: "ASIN search",
    results: "search results",
    selectAll: "Select the results",
    ipType: "Copyright",
    issue: "type of infringement",
    brand: "Brand",
    linkMode: "Link to your copyrighted work",
    link: "Link",
    description: "Description",
    firstName: "First name",
    lastName: "Last name",
    company: "Company",
    addressLine1: "Address line 1",
    addressLine2: "Address line 2",
    city: "City",
    state: "State or region",
    postalCode: "Postal code",
    country: "Country",
    phone: "Phone number",
    role: "Rights owner or agent",
    seller: "Are you a seller",
    contactName: "Contact name",
    contactEmail: "Contact email",
  };
  const label = (k) => LABELS[k] || k;

  function stepError(step, message, blocked = true) {
    const e = new Error(message);
    e.step = step;
    e.blocked = blocked;
    return e;
  }

  function formDisabledByAmazon() {
    const box = $(SEL.searchBox);
    const notice = [...document.querySelectorAll('[role="alert"], .a-alert-content, .alert, h4, strong, b')].some((e) => /access revoked|access to amazon.?s report infringement forms has been revoked/i.test(e.textContent || ""));
    return notice || !!(box && box.disabled);
  }

  function pageProblem() {
    if (formDisabledByAmazon()) return "Amazon shows that this account can't use the Report Infringement form right now (Access revoked). Copycat Hunt stops here and won't try to get around that. You can read Amazon's notice and appeal on this page.";
    if (/\/ap\/signin/.test(location.pathname)) return "Amazon wants you to sign in. Sign in in this tab, then press Try again.";
    if (document.querySelector('form[action*="validateCaptcha"], #captchacharacters')) return "Amazon is showing a robot check. Solve it yourself in this tab, then press Try again.";
    return "";
  }

  function resultAsins(region) {
    const clone = region.cloneNode(true);
    clone.querySelectorAll("textarea, input, script, style").forEach((n) => n.remove());
    return new Set((clone.textContent.toUpperCase().match(/\b[A-Z0-9]{10}\b/g) || []).filter((t) => /[0-9]/.test(t) && /^B0|^[0-9]{9}[0-9X]$/.test(t)));
  }

  async function run(retrying) {
    const r = job.reporter;
    const issue = AZ.ISSUES[job.issue];
    const steps = [
      [
        "start",
        async () => {
          if ($(SEL.searchBox)) return;
          const startEl = await waitFor(() => {
            const k = $(SEL.start);
            if (k) return k;
            return [...document.querySelectorAll("button, kat-button")].find((b) => /^\s*(start|begin)\b.*report/i.test(b.textContent || b.getAttribute("label") || ""));
          }, 10000);
          if (!startEl) throw stepError("start", 'Couldn\'t find Amazon\'s "Start report" button. Is this the right page?');
          (startEl.shadowRoot && startEl.shadowRoot.querySelector("button")) ? startEl.shadowRoot.querySelector("button").click() : startEl.click();
          if (!(await waitFor(() => $(SEL.searchBox), 10000))) throw stepError("start", "Amazon's ASIN search box didn't appear after Start.");
          await delay(300);
          const problem = pageProblem();
          if (problem) throw stepError("start", problem);
        },
      ],
      [
        "search",
        async () => {
          await setText("searchBox", job.targets.join(", "), { retrying }).catch((e) => {
            e.step = "search";
            throw e;
          });
          const btn = await waitFor(() => $(SEL.searchButton));
          if (!btn) throw stepError("search", "Couldn't find Amazon's Search button for the ASINs.");
          btn.click();
        },
      ],
      [
        "results",
        async () => {
          const ready = await waitFor(() => document.querySelector(SEL.rowCheckbox) || $(SEL.selectAll), 15000);
          if (!ready) throw stepError("results", "Amazon didn't show search results for the ASINs.");
          await delay(400);
          let found;
          if (document.querySelector(SEL.rowCheckbox)) {
            found = new Set([...document.querySelectorAll(SEL.rowCheckbox)].map((b) => b.id.replace("asin-checkbox-id-", "").toUpperCase()));
          } else {
            let region = $(SEL.selectAll);
            while (region.parentElement && resultAsins(region).size < 1) region = region.parentElement;
            if (!region || region === document.body) region = document.body;
            found = resultAsins(region);
          }
          const want = new Set(job.targets);
          const missing = [...want].filter((a) => !found.has(a));
          const extra = [...found].filter((a) => !want.has(a) && a !== job.original);
          if (found.has(job.original)) throw stepError("results", `Your own original (${job.original}) is in Amazon's results. Not selecting anything.`);
          if (missing.length) throw stepError("results", `Amazon's results don't include: ${missing.join(", ")}. They may be removed already. Check the results yourself, or go back and untick them.`);
          if (extra.length) throw stepError("results", `Amazon's results include ASINs you didn't choose: ${extra.slice(0, 5).join(", ")}. Not selecting anything. Check the results yourself.`);
        },
      ],
      [
        "selectAll",
        async () => {
          if (document.querySelector(SEL.rowCheckbox)) {
            for (const a of job.targets) {
              const box = document.getElementById(`asin-checkbox-id-${a}`);
              if (!box) throw stepError("selectAll", `Couldn't find the checkbox for ${a} in Amazon's results.`);
              await clickWhere(() => katClickTarget(box), () => katChecked(box), "selectAll");
            }
            const btn = $(SEL.actionButton);
            const label = btn ? btn.getAttribute("single-target-label") || "" : "";
            const n = Number((label.match(/(\d+)\s+selected/i) || [])[1]);
            if (btn && n !== job.targets.length) throw stepError("selectAll", `Amazon says "${label}", but ${job.targets.length} should be selected. Check the ticks yourself.`);
            return;
          }
          const box = $(SEL.selectAll);
          await clickWhere(
            () => (box ? radioLabel(box) : null),
            () => box && box.checked,
            "selectAll"
          );
        },
      ],
      [
        "ipType",
        async () => {
          const already = () => document.getElementById(issue.radio);
          if (already()) return;
          const action = $(SEL.actionButton);
          if (action && action.shadowRoot) {
            await waitFor(() => !action.hasAttribute("disabled") || action.getAttribute("disabled") === "false", 5000);
            const toggle = action.shadowRoot.querySelector('[part="dropdown-button-toggle-button"], button.indicator');
            if (!toggle) throw stepError("ipType", "Couldn't open Amazon's \"Report selected\" menu.");
            for (let i = 0; i < 3 && !already(); i++) {
              toggle.click();
              await delay(300);
              const opt = await waitFor(() => action.shadowRoot.querySelector('button.option[data-action="COPYRIGHT"]'), 3000);
              if (!opt) throw stepError("ipType", "Amazon's menu has no \"Copyright infringement\" choice.");
              opt.click();
              await waitFor(already, 3000);
            }
            if (!already()) throw stepError("ipType", "Picking \"Copyright infringement\" didn't open the copyright questions.");
            return;
          }
          const toggle = await waitFor(() => $(SEL.ipToggle));
          if (!toggle) throw stepError("ipType", "Couldn't find Amazon's infringement type menu.");
          toggle.click();
          await clickWhere(() => $(SEL.copyright), already, "ipType");
        },
      ],
      [
        "issue",
        async () => {
          const radio = await waitFor(() => document.getElementById(issue.radio));
          if (!radio) throw stepError("issue", `Couldn't find the "${issue.label}" option on Amazon's form.`);
          await clickWhere(() => radioLabel(radio), () => radio.checked, "issue");
        },
      ],
      ["brand", () => setText("brand", job.brand, { retrying })],
      [
        "linkMode",
        async () => {
          const radio = await waitFor(() => $(SEL.linkMode));
          if (!radio) throw stepError("linkMode", 'Couldn\'t find the "link to your work" option on Amazon\'s form.');
          await clickWhere(() => radioLabel(radio), () => radio.checked, "linkMode");
        },
      ],
      ["link", () => setText("link", AZ.productUrl(job.marketplace, job.original), { retrying })],
      ["description", () => setText("description", job.description, { retrying })],
      ["firstName", () => setText("firstName", r.firstName, { retrying })],
      ["lastName", () => setText("lastName", r.lastName, { retrying })],
      ["company", () => setText("company", r.company || "", { optional: true, retrying })],
      ["addressLine1", () => setText("addressLine1", r.addressLine1, { retrying })],
      ["addressLine2", () => setText("addressLine2", r.addressLine2 || "", { optional: true, retrying })],
      ["city", () => setText("city", r.city, { retrying })],
      ["state", () => setText("state", r.state || "", { optional: true, retrying })],
      ["postalCode", () => setText("postalCode", r.postalCode, { retrying })],
      [
        "country",
        async () => {
          const code = AZ.countryCode(r.country);
          const name = AZ.countryName(code) || r.country;
          if (!code) throw stepError("country", `"${r.country}" isn't on Amazon's country list. Pick your country in Copycat Hunt, then press Try again.`);
          const dd = await waitFor(() => $(SEL.countryDropdown) || $(SEL.country));
          if (!dd) throw stepError("country", "Couldn't find the Country field on Amazon's form.");
          if (dd.tagName === "KAT-DROPDOWN") {
            if (await pickKatOption(dd, code)) return;
            throw stepError("country", `Amazon's Country field didn't take "${name}". Pick it yourself on the form, then press Try again.`);
          }
          if (same(dd.value, name)) return;
          dd.focus();
          nativeSet(dd, "");
          await delay(100);
          nativeSet(dd, name);
          const option = await waitFor(() => [...document.querySelectorAll(SEL.countryOption)].find((o) => same(o.textContent, name)), 4000);
          if (!option) throw stepError("country", `Amazon's country list has no exact "${name}". Pick your country yourself, then press Try again.`);
          option.click();
          await delay(250);
          if (!same(dd.value, name)) throw stepError("country", "The country didn't stay selected. Pick it yourself, then press Try again.");
        },
      ],
      ["phone", () => setText("phone", r.phone, { retrying })],
      [
        "role",
        async () => {
          const owner = await waitFor(() => $(SEL.rightsOwner));
          if (!owner) throw stepError("role", 'Couldn\'t find the "rights owner or agent" question on Amazon\'s form.');
          const target = r.role === "rights_owner" ? owner : $(SEL.agent) || radioByText(owner, /agent|authori[sz]ed/i);
          if (!target) throw stepError("role", 'Couldn\'t find the "authorized agent" answer. Choose it yourself, then press Try again.');
          await clickWhere(() => radioLabel(target), () => target.checked, "role");
        },
      ],
      [
        "seller",
        async () => {
          const no = await waitFor(() => $(SEL.sellerNo));
          if (!no) throw stepError("seller", 'Couldn\'t find the "are you a seller" question on Amazon\'s form.');
          const target = r.isSeller ? $(SEL.sellerYes) || radioByText(no, /^\s*yes\b/i) : no;
          if (!target) throw stepError("seller", 'Couldn\'t find the "Yes" answer. Choose it yourself, then press Try again.');
          await clickWhere(() => radioLabel(target), () => target.checked, "seller");
        },
      ],
      ["contactName", () => setText("contactName", r.contactName, { retrying })],
      ["contactEmail", () => setText("contactEmail", r.contactEmail, { retrying })],
    ];

    for (const [id, fn] of steps) {
      if (cancelled) return;
      const problem = pageProblem();
      if (problem) throw stepError(id, problem);
      showBar(`Filling: ${label(id)}…`, "", [{ id: "cancel", label: "Stop", run: cancel }], `Amazon report · step ${steps.findIndex((s) => s[0] === id) + 1} of ${steps.length}`);
      await fn();
      if (!completed.includes(id)) completed.push(id);
      await report({ status: "filling", completedSteps: completed });
    }

    const finalChecks = [
      ["brand", job.brand],
      ["link", AZ.productUrl(job.marketplace, job.original)],
      ["firstName", r.firstName],
      ["lastName", r.lastName],
      ["addressLine1", r.addressLine1],
      ["city", r.city],
      ["postalCode", r.postalCode],
      ["phone", r.phone],
      ["contactName", r.contactName],
      ["contactEmail", r.contactEmail],
    ];
    for (const [key, want] of finalChecks) {
      const el = $(SEL[key]);
      if (!el || (!same(el.value, want) && !notes.some((n) => n.includes(label(key))))) {
        throw stepError(key, `"${label(key)}" changed after it was filled. Check it, then press Try again.`);
      }
    }
    const ddFinal = $(SEL.countryDropdown);
    const countryOk = ddFinal ? String(ddFinal.getAttribute("value") || "") === AZ.countryCode(r.country) : !!$(SEL.country) && same($(SEL.country).value, AZ.countryName(r.country) || r.country);
    if (!countryOk) throw stepError("country", '"Country" changed after it was filled. Check it, then press Try again.');
    const desc = $(SEL.description);
    if (!desc || (!same(desc.value, job.description) && !notes.some((n) => n.includes("Description")))) throw stepError("description", "The description changed after it was filled.");
  }

  async function cancel() {
    cancelled = true;
    await send({ type: "eif-amazon-job-finish", jobId, how: "cancel" });
    showBar("Stopped. Nothing else will be filled. Close this tab or finish the form yourself.", "err", [], "Amazon report");
  }

  async function markSubmitted() {
    const res = await send({ type: "eif-amazon-job-finish", jobId, how: "submitted" });
    if (!res || !res.ok) return showBar("Couldn't record it. The job may have expired.", "err");
    const j = res.job;
    try {
      const data = await chrome.storage.local.get({ eifReportHistory: [], eifAmazonTracked: {} });
      const history = Array.isArray(data.eifReportHistory) ? data.eifReportHistory : [];
      history.push({
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
      const tracked = data.eifAmazonTracked && typeof data.eifAmazonTracked === "object" ? data.eifAmazonTracked : {};
      const today = new Date().toISOString().slice(0, 10);
      j.targets.forEach((a) => {
        if (tracked[a]) tracked[a].reportedAt = today;
      });
      await chrome.storage.local.set({ eifReportHistory: history.slice(-500), eifAmazonTracked: tracked });
    } catch (e) {}
    showBar("Saved to the Reported tab. Amazon emails you its decision.", "ok", [], "Amazon report");
  }

  async function start(retrying) {
    cancelled = false;
    if (/^\/report\/infringement\/signin/.test(location.pathname)) {
      showBar(`Sign in to ${location.hostname.replace(/^www\./, "")} in this tab first. If Amazon's form doesn't come back by itself afterwards, go to Copycat Hunt and press Start Amazon report again.`, "err", [], "Amazon report");
      return;
    }
    const claim = await send({ type: "eif-amazon-job-claim", jobId });
    if (!claim || !claim.ok) {
      const why = {
        expired: "This report expired (30 minutes). Start it again from Copycat Hunt.",
        "other-tab": "This report belongs to another tab.",
        cancelled: "This report was cancelled.",
        submitted_by_user: "This report is already marked as submitted.",
        busy: "This report is being filled in another window.",
        missing: "This report wasn't found. Start it again from Copycat Hunt.",
        license: "Copycat Hunt needs an active license to fill this form. Open the Copycat Hunt toolbar menu to enter your key.",
      }[claim && claim.error] || "Couldn't load this report. Start it again from Copycat Hunt.";
      showBar(why, "err", [], "Amazon report");
      return;
    }
    job = claim.job;
    leaseToken = claim.leaseToken;
    notes.length = 0;
    try {
      await waitFor(() => document.readyState === "complete", 15000);
      await run(retrying);
      if (cancelled) return;
      await report({ status: "review_ready", completedSteps: completed, failedStep: "", reason: "", notes });
      showBar(
        `Filled ${job.targets.length} ASIN${job.targets.length > 1 ? "s" : ""} and your details${notes.length ? ` (${notes.join(" ")})` : ""}. Check everything on Amazon's form, tick Amazon's declaration boxes yourself, and press Submit yourself. Then press "I submitted it".`,
        "ok",
        [
          { id: "done", label: "I submitted it", primary: true, run: markSubmitted },
          { id: "again", label: "Fill again", run: () => start(true) },
          { id: "cancel", label: "Cancel", run: cancel },
        ],
        "Amazon report · ready for your review"
      );
    } catch (err) {
      if (cancelled) return;
      const blocked = err && err.blocked !== false;
      await report({ status: blocked ? "blocked" : "failed", completedSteps: completed, failedStep: (err && err.step) || "", reason: (err && err.message) || "Unknown error", notes });
      showBar((err && err.message) || "Something went wrong while filling the form.", "err", [
        { id: "retry", label: "Try again", primary: true, run: () => start(true) },
        { id: "cancel", label: "Cancel", run: cancel },
      ], `Amazon report · stopped at "${label((err && err.step) || "")}"`);
    }
  }

  window.__eifAmazonFill = { start, cancel, state: () => ({ completed: completed.slice(), notes: notes.slice(), cancelled }) };
  const go = () => setTimeout(() => start(false), 800);
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
})();
