(function (root) {
  "use strict";
  const STATE_KEY = "eifEbayRequestStateV1";

  function retryAfterMs(value, now) {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const time = Date.parse(value);
    return Number.isFinite(time) ? Math.max(0, time - now) : 0;
  }

  function classify(result) {
    const status = Number(result.status || 0);
    const url = String(result.url || "");
    const html = String(result.text || "");
    const title = (html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    if (/\/(?:splashui|splashui_rc|challenge|captcha|ecaptcha)(?:[/?#]|$)/i.test(url) ||
        /pardon our interruption|security measure|verify (?:that )?you(?:'re| are) human|robot check|checking your browser/i.test(title) ||
        /<(?:form|iframe)\b[^>]*(?:action|src)=["'][^"']*\/(?:splashui|ecaptcha|captcha)(?:[/?#]|["'])/i.test(html)) return "captcha";
    if (status === 429) return "rate_limited";
    if (status === 403 || /access denied/i.test(title)) return "access_denied";
    if (status === 503) return "service_unavailable";
    if (status === 401 || /^https:\/\/signin\.ebay\.com\//i.test(url) || /\/(?:signin|ap\/signin)(?:[/?#]|$)/i.test(url)) return "signin";
    return null;
  }

  function create(options) {
    const now = options.now || Date.now;
    const sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const gapMs = options.gapMs ?? 2000;
    // No single request may hold the queue: after this it counts as a timeout
    // (not a block, so eBay isn't paused for everyone).
    const hardMs = options.hardTimeoutMs ?? 30000;
    const perform = (input, context) => {
      let timer;
      const cap = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: "timeout", status: 0 }), hardMs); });
      return Promise.race([Promise.resolve().then(() => options.perform(input, context)), cap]).finally(() => clearTimeout(timer));
    };
    const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    let state = { paused: false, reason: null, until: 0, lastAt: 0 };
    // Jobs run one at a time. Searches the user started ("high") go before
    // background reads (dates, hover panels, ownership checks).
    const jobs = { high: [], normal: [] };
    let running = false;
    let waiting = 0;
    const cache = new Map();
    const inFlight = new Map();
    const ready = Promise.resolve().then(() => options.load?.()).then((stored) => {
      if (stored && typeof stored === "object") state = {
        paused: stored.paused === true,
        reason: typeof stored.reason === "string" ? stored.reason : null,
        until: Math.max(0, Number(stored.until) || 0),
        lastAt: Math.max(0, Number(stored.lastAt) || 0),
        recoveryUrl: typeof stored.recoveryUrl === "string" ? stored.recoveryUrl : "",
      };
    });
    const snapshot = () => ({ ...state });
    const persist = () => options.save?.(snapshot());
    const pausedResult = () => ({ ok: false, error: "ebay-paused", ...snapshot(), retryAfterMs: Math.max(0, state.until - now()) });
    const pump = () => {
      if (running) return;
      const job = jobs.high.shift() || jobs.normal.shift();
      if (!job) return;
      running = true;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => { running = false; pump(); });
    };
    const enqueue = (fn, priority) => new Promise((resolve, reject) => {
      (priority === "high" ? jobs.high : jobs.normal).push({ fn, resolve, reject });
      pump();
    });

    function request(input, context) {
      const method = input.method || "GET";
      const key = method === "POST" ? null : `${method}:${input.url}`;
      if (key && inFlight.has(key)) return inFlight.get(key);
      if (waiting >= 40) return Promise.resolve({ ok: false, error: "queue-full" });
      waiting++;
      const task = enqueue(async () => {
        await ready;
        if (state.paused) return pausedResult();
        const cached = key && cache.get(key);
        if (!input.refresh && cached && now() - cached.at < ttlMs) return { ...cached.result, cached: true };
        const delay = Math.max(0, state.lastAt + gapMs - now());
        if (delay) await sleep(delay);
        state.lastAt = now();
        // Persist admission before I/O so service-worker restart keeps pacing.
        await persist();
        let result;
        try { result = await perform(input, context); }
        catch (e) { result = { ok: false, error: e?.name === "AbortError" ? "timeout" : "network" }; }
        // "quiet" requests (the listings sync) report a sign-in page or a block
        // to their caller instead of pausing every eBay feature.
        const reason = classify(result);
        if (reason) { try { options.onBlock?.(reason, result, input, context); } catch (e) { /* never breaks a request */ } }
        if (reason && input.quiet) return { ...result, quietReason: reason };
        if (reason) {
          const minimum = reason === "rate_limited" ? 60000 : reason === "service_unavailable" ? 120000 : 0;
          state = { ...state, paused: true, reason, recoveryUrl: method !== "POST" ? input.url : "", until: now() + Math.max(minimum, retryAfterMs(result.retryAfter, now())) };
          cache.clear();
          await persist();
          return { ...pausedResult(), status: result.status, url: result.url };
        }
        if (key && result.ok && !input.nocache) {
          cache.delete(key);
          cache.set(key, { at: now(), result });
          while (cache.size > 80) cache.delete(cache.keys().next().value);
        }
        return result;
      }, input.priority).finally(() => {
        waiting--;
        if (key && inFlight.get(key) === task) inFlight.delete(key);
      });
      if (key) inFlight.set(key, task);
      return task;
    }

    return {
      request,
      status: async () => { await ready; return snapshot(); },
      resume: (probe, context) => enqueue(async () => {
        await ready;
        if (!state.paused) return { ok: true, ...snapshot() };
        if (state.until > now()) return pausedResult();
        cache.clear();
        if (probe) {
          const delay = Math.max(0, state.lastAt + gapMs - now());
          if (delay) await sleep(delay);
          state.lastAt = now();
          await persist();
          let result;
          try { result = await perform(probe, context); }
          catch (e) { result = { ok: false, error: e?.name === "AbortError" ? "timeout" : "network" }; }
          const reason = classify(result);
          if (result.error === "needs-ebay-tab") {
            // Not a block: eBay only wants the request from an eBay page.
            state = { ...state, paused: false, reason: null, until: 0, recoveryUrl: "" };
            await persist();
            return { ok: false, error: "needs-ebay-tab", ...snapshot() };
          }
          if (reason || !result.ok) {
            const minimum = reason === "rate_limited" ? 60000 : reason === "service_unavailable" ? 120000 : 0;
            state = { ...state, paused: true, reason: reason || result.error || "request_failed", until: now() + Math.max(minimum, retryAfterMs(result.retryAfter, now())) };
            await persist();
            return pausedResult();
          }
          if ((probe.method || "GET") === "GET") cache.set(`GET:${probe.url}`, { at: now(), result });
        }
        state = { ...state, paused: false, reason: null, until: 0, recoveryUrl: "" };
        await persist();
        return { ok: true, ...snapshot() };
      }, "high"),
      pending: () => ({ high: jobs.high.length, normal: jobs.normal.length, running }),
    };
  }

  const api = { STATE_KEY, create, classify, retryAfterMs };
  root.EifEbayRequests = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
