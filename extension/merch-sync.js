// Copycat Hunt: resumable Merch catalog download (v3.16.0).
//
// One sync "run" downloads the signed-in account's catalog page by page and
// saves every page as it arrives, so a closed setup tab, a restarted service
// worker or a restarted browser continues where it stopped instead of
// starting over. Our own design; it reuses the page fetch, normalizer and
// identity checks from merch-catalog.js.
//
// Storage (v3.24.0: the local SQLite catalog database, catalog-store.js):
//   eifMerchRun (chrome.storage) a copy of the run ledger for the pages and
//                               the setup screen (state, account, progress)
//   database runs/stage/receipts each page of a run, saved in ONE transaction
//                               with the ledger (cursor) that points past it
//   database generations/products the last COMPLETE catalog; a new one is
//                               built next to it and switched to atomically
//   Before v3.24.0 pages were eifMerchStage:<runId>:<n> keys and the catalog
//   one eifMerchCatalog array (catalog-migrate.js moves them over once).
//
// Rules:
//  - A run belongs to one verified account. Resuming checks the account again
//    and never continues another account's run (its staged pages are dropped).
//  - Staged pages are never used for ownership. Lookups keep using the last
//    complete catalog until the new one is validated and published.
//  - If the copy of the ledger in chrome.storage is behind the database (the
//    worker stopped between the two writes), the database's cursor wins.
//  - The page token is opaque. A repeated token, a runaway page count, an
//    empty page before the reported total, or too many listings stops the run.
//  - Failures keep the last complete catalog. "Restartable" failures (expired
//    token, account change, bad data) need a fresh run; "resumable" ones
//    (signed out, network, rate limit, paused) continue from the saved page.
(function (root) {
  "use strict";

  const RUN_KEY = "eifMerchRun";
  const STAGE_PREFIX = "eifMerchStage:";
  // Explicit stops instead of a fixed 400-page ceiling. v3.24.0: raised from
  // 2,000 pages / 500,000 listings after the SQLite catalog passed real-browser
  // measurements at 500k, 1M and 2M listings (CATALOG-DATABASE.md).
  const DEFAULT_LIMITS = Object.freeze({
    maxPages: 4400, // 2,200,000 raw records at 500 per page (eBay sets its own)
    maxUsable: 2000000, // usable catalog listings kept in one catalog
    slackPages: 3, // pages allowed past ceil(reported total / page size)
    autoRetries: 5, // automatic resumes after network / rate-limit pauses
    retryDelayMs: 60 * 1000,
  });
  const ACTIVE = new Set(["syncing", "finalizing"]);
  // Page tokens remembered to catch a service sending one twice. Bounded so
  // the ledger stays small on long runs; a loop past this is still stopped
  // by the page ceiling and the reported-total check.
  const TOKEN_HISTORY = 1000;
  // Database errors that clear up by themselves: try again after a while.
  const STORAGE_RETRY = new Set(["storage_busy", "storage_timeout", "storage_unavailable", "storage_io"]);
  const storageCode = (e) => (e && typeof e.code === "string" && /^storage_/.test(e.code) ? e.code : "storage_write");
  const RESUMABLE = new Set(["syncing", "finalizing", "paused", "needs_login", "waiting"]);

  function newRunId(now) {
    return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function createEngine(deps) {
    const MC = deps.MC;
    const storage = deps.storage; // { get(defaults) → obj, set(obj) }: the ledger copy
    // The run's pages and the catalog, in the database:
    //   { savePage(cursor, page, rows), getCursor(), clear(runId),
    //     finalize(run, info) → { ok, catalog } | { ok: false, reason } }
    const pages = deps.pages;
    if (!pages) throw new Error("merch-sync: deps.pages is required");
    const now = deps.now || Date.now;
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const limits = { ...DEFAULT_LIMITS, ...(deps.limits || {}) };
    const pageSize = deps.pageSize || MC.PAGE_SIZE;
    const pauseMs = deps.pauseMs == null ? 500 : deps.pauseMs;
    let loop = null; // the one running download in this worker
    let loopRunId = "";

    // The same engine runs the eBay sync (v3.17.0) with its own keys.
    const runKey = deps.runKey || RUN_KEY;
    const keyOf = MC.productKey || ((p) => `${p.marketplace}|${p.asin}|${p.listingId}`);

    async function getRun() {
      const run = (await storage.get({ [runKey]: null }))[runKey];
      let saved = null;
      try {
        saved = await pages.getCursor();
      } catch (e) {
        return run; // database unavailable: the copy is all we have
      }
      if (saved && saved.runId && (!run || (run.runId === saved.runId && (saved.pagesDone || 0) > (run.pagesDone || 0)))) {
        // The page and its cursor were saved; the copy here was not.
        try { await storage.set({ [runKey]: saved }); } catch (e) {}
        return saved;
      }
      return run;
    }

    // What the UI may see: no tokens, no full account ids.
    function publicRun(run) {
      if (!run) return { state: "idle" };
      return {
        state: run.state,
        kind: run.kind,
        runId: run.runId,
        account: MC.maskId(run.accountId),
        pagesDone: run.pagesDone || 0,
        rawScanned: run.rawScanned || 0,
        usable: run.usable || 0,
        expectedTotal: run.expectedTotal == null ? null : run.expectedTotal,
        startedAt: run.startedAt || 0,
        lastPageAt: run.lastPageAt || 0,
        completedAt: run.completedAt || 0,
        error: run.error || "",
        restartable: !!run.restartable,
        resumeAt: run.resumeAt || 0,
        waitUntil: run.waitUntil || 0,
        recent: Array.isArray(run.recent) ? run.recent.slice(-3) : [],
        running: loopRunId === run.runId && !!loop,
      };
    }

    async function putRun(run) {
      await storage.set({ [runKey]: run });
      if (deps.onPublish) {
        try { await deps.onPublish(publicRun(run), run); } catch (e) {}
      }
    }

    async function clearStage(run) {
      if (!run || !run.runId) return;
      try { await pages.clear(run.runId); } catch (e) {}
    }

    function freshRun(kind, identity) {
      const t = now();
      return {
        v: 1,
        runId: newRunId(t),
        kind: kind || "sync",
        state: "syncing",
        accountId: identity.accountId,
        customerId: identity.customerId || "",
        pageSize,
        pagesDone: 0,
        rawScanned: 0,
        usable: 0,
        expectedTotal: null,
        nextToken: [],
        seenTokens: [],
        startedAt: t,
        lastPageAt: 0,
        error: "",
        restartable: false,
        autoRetries: 0,
        resumeAt: 0,
      };
    }

    async function fail(run, error, { restartable = false, keepStage = !restartable, state } = {}) {
      run.state = state || (restartable ? "failed" : "paused");
      run.error = error;
      run.restartable = restartable;
      if (!keepStage) {
        await clearStage(run);
        run.pagesDone = 0;
        run.rawScanned = 0;
        run.usable = 0;
        run.nextToken = [];
        run.seenTokens = [];
      }
      await putRun(run);
      return { ok: false, reason: error, run: publicRun(run) };
    }

    // Start a run, or adopt / resume the existing one.
    //   opts.restart  start over (drops staged pages of the old run)
    //   opts.auto     a routine background check: never overrides a user pause
    let starting = null;
    function start(opts = {}) {
      if (loop) return loop;
      if (starting) return starting; // two callers at once share one run
      starting = doStart(opts).finally(() => { starting = null; });
      return starting;
    }

    async function doStart(opts) {
      if (loop) return loop;
      let run = await getRun();
      if (opts.auto && run && run.state === "paused" && run.error === "user_paused") return { ok: false, reason: "user_paused", run: publicRun(run) };
      const identity = await deps.identity(true);
      if (!identity || identity.state !== "verified" || identity.stale) {
        const reason = identity && identity.state === "logged_out" ? "signed_out" : identity && identity.stale ? identity.lastFailure || "rate_limited" : (identity && (identity.reason || identity.state)) || "identity_unavailable";
        if (run && RESUMABLE.has(run.state)) {
          run.state = reason === "signed_out" ? "needs_login" : "paused";
          run.error = reason;
          await putRun(run);
        } else if (deps.onPublish) {
          try { await deps.onPublish({ state: reason === "signed_out" ? "needs_login" : "failed", error: reason }, null); } catch (e) {}
        }
        return { ok: false, reason, run: publicRun(run) };
      }
      if (run && RESUMABLE.has(run.state) && !opts.restart && !run.restartable) {
        if (!MC.sameAccount(run, identity)) {
          // Another account's half-finished run: never continue it.
          await clearStage(run);
          run = null;
        } else {
          run.state = run.state === "finalizing" || run.pendingFinalize ? "finalizing" : "syncing";
          run.error = "";
          run.resumeAt = 0;
          if (opts.kind === "setup") run.kind = "setup";
        }
      } else {
        if (run && run.runId) await clearStage(run);
        run = null;
      }
      if (!run) run = freshRun(opts.kind, identity);
      if (!opts.auto) run.autoRetries = 0;
      await putRun(run);
      if (opts.onBegin) { try { opts.onBegin(publicRun(run)); } catch (e) {} }
      loopRunId = run.runId;
      const revAtStart = deps.revision ? deps.revision() : 0;
      const stopKeepAlive = deps.keepAlive ? deps.keepAlive() : () => {};
      loop = execute(run.runId, revAtStart, identity)
        .catch(async (e) => {
          const cur = await getRun().catch(() => null);
          if (cur && cur.runId === loopRunId && ACTIVE.has(cur.state)) return fail(cur, "internal_error");
          return { ok: false, reason: "internal_error" };
        })
        .finally(() => {
          stopKeepAlive();
          loop = null;
          loopRunId = "";
        });
      return loop;
    }

    // Continue an interrupted run (worker restart, alarm, setup page reopened).
    async function resume(opts = {}) {
      if (loop) return loop;
      const run = await getRun();
      if (!run || !RESUMABLE.has(run.state) || run.restartable) return { ok: false, reason: "nothing_to_resume", run: publicRun(run) };
      if (opts.auto) {
        if (run.state === "paused" && run.error === "user_paused") return { ok: false, reason: "user_paused", run: publicRun(run) };
        if (run.state === "needs_login") return { ok: false, reason: "needs_login", run: publicRun(run) };
        if (run.state === "paused" && (run.resumeAt || 0) > now()) return { ok: false, reason: "waiting", run: publicRun(run) };
        if (run.state === "paused" && run.autoRetries >= limits.autoRetries) return { ok: false, reason: "retries_used", run: publicRun(run) };
        if (run.state === "paused") {
          run.autoRetries = (run.autoRetries || 0) + 1;
          await storage.set({ [runKey]: run });
        }
      }
      return start({ kind: run.kind, auto: !!opts.auto, onBegin: opts.onBegin });
    }

    async function pause() {
      const run = await getRun();
      if (!run || !RESUMABLE.has(run.state)) return { ok: false, reason: "not_running", run: publicRun(run) };
      if (run.state === "finalizing") return { ok: false, reason: "finalizing", run: publicRun(run) };
      run.state = "paused";
      run.error = "user_paused";
      run.resumeAt = 0;
      await putRun(run);
      return { ok: true, run: publicRun(run) };
    }

    async function cancel() {
      const run = await getRun();
      if (!run) return { ok: true, run: publicRun(null) };
      if (run.state === "finalizing") return { ok: false, reason: "finalizing", run: publicRun(run) };
      await clearStage(run);
      const done = { v: 1, runId: run.runId, kind: run.kind, state: "cancelled", accountId: run.accountId, customerId: run.customerId, pagesDone: 0, rawScanned: 0, usable: 0, expectedTotal: null, startedAt: run.startedAt, error: "cancelled", restartable: true };
      await putRun(done);
      return { ok: true, run: publicRun(done) };
    }

    async function status() {
      return publicRun(await getRun());
    }

    async function execute(runId, revAtStart, identity) {
      for (;;) {
        const run = await getRun();
        if (!run || run.runId !== runId) return { ok: false, reason: "superseded" };
        if (run.state === "finalizing") return finalize(run, revAtStart);
        if (run.state !== "syncing") return { ok: false, reason: run.error || run.state, run: publicRun(run) };
        if (deps.revision && deps.revision() !== revAtStart) return fail(run, "account_changed", { restartable: true });
        if (run.pagesDone >= limits.maxPages) return fail(run, "too_many_pages", { restartable: true });
        if (run.expectedTotal != null && run.pagesDone > Math.ceil(run.expectedTotal / run.pageSize) + limits.slackPages) return fail(run, "pagination_runaway", { restartable: true });
        if (run.pagesDone > 0 && pauseMs) await sleep(pauseMs);

        const got = await MC.fetchListingsPage(identity, run.nextToken, {
          fetch: deps.fetch,
          sleep,
          timeoutMs: deps.timeoutMs,
          pageSize: run.pageSize,
          onWait: async (ms, why) => {
            // Make a long service-requested wait visible (and survivable).
            const cur = await getRun();
            if (cur && cur.runId === runId) {
              cur.waitUntil = now() + ms;
              cur.error = why;
              await putRun(cur);
            }
          },
        });
        const cur = await getRun();
        if (!cur || cur.runId !== runId) return { ok: false, reason: "superseded" };
        // Another copy of this run saved a page meanwhile: this answer is stale.
        if ((cur.pagesDone || 0) !== (run.pagesDone || 0)) return { ok: false, reason: "superseded" };
        // Paused meanwhile: still keep the page that just arrived, then stop.
        const pausedMeanwhile = cur.state === "paused";
        if (cur.state !== "syncing" && !(pausedMeanwhile && got.ok)) return { ok: false, reason: cur.error || cur.state, run: publicRun(cur) };
        cur.waitUntil = 0;
        if (deps.revision && deps.revision() !== revAtStart) return fail(cur, "account_changed", { restartable: true });

        if (!got.ok) {
          const tokenSent = !MC.isEndToken(cur.nextToken);
          if (got.reason === "logged_out") return fail(cur, "signed_out", { state: "needs_login" });
          if (got.reason === "account_changed") return fail(cur, "account_changed", { restartable: true });
          if (tokenSent && (got.status === 400 || got.status === 404 || got.status === 410)) return fail(cur, "page_token_expired", { restartable: true });
          if (got.reason === "unexpected_response") return fail(cur, "unexpected_response", { restartable: true });
          // Network, timeout, rate limit, server errors: keep the pages, try again later.
          cur.resumeAt = now() + limits.retryDelayMs;
          return fail(cur, got.reason);
        }

        if (got.hitCount != null) cur.expectedTotal = got.hitCount;
        if (!got.results.length) {
          if (cur.expectedTotal == null || cur.rawScanned >= cur.expectedTotal) {
            cur.state = "finalizing";
            await putRun(cur);
            return finalize(cur, revAtStart);
          }
          return fail(cur, "pagination_incomplete", { restartable: true });
        }

        // Normalize this page; drop exact duplicates inside the page.
        const seen = new Set();
        const products = [];
        for (const r of got.results) {
          const p = MC.normalizeListing(r);
          if (!p) continue;
          const k = keyOf(p);
          if (seen.has(k)) continue;
          seen.add(k);
          products.push(p);
        }
        // A short page that brings the count to the reported total is the last
        // page, even if the service still hands out a next token: asking for
        // it only earns a rate-limit wait at 100%.
        if (!MC.isEndToken(got.next) && cur.expectedTotal != null && cur.rawScanned + got.results.length >= cur.expectedTotal && got.results.length < cur.pageSize) got.next = [];
        const nextKey = JSON.stringify(got.next);
        if (!MC.isEndToken(got.next) && (cur.seenTokens || []).includes(nextKey)) return fail(cur, "repeated_page_token", { restartable: true });

        // Checkpoint: the page and the ledger that points past it, in one
        // database transaction. Either both are saved or neither is; a retry
        // of the same page replaces it (no duplicates).
        const page = cur.pagesDone;
        const next = { ...cur };
        next.pagesDone += 1;
        next.rawScanned += got.results.length;
        next.usable += products.length;
        next.nextToken = got.next;
        if (!MC.isEndToken(got.next)) next.seenTokens = [...(cur.seenTokens || []), nextKey].slice(-Math.min(limits.maxPages, TOKEN_HISTORY));
        next.lastPageAt = now();
        // The last few titles read, for the "just synced" line on the setup page.
        next.recent = products.slice(-3).map((x) => String((x && x.title) || "").slice(0, 90)).filter(Boolean);
        next.error = "";
        next.autoRetries = 0;
        if (next.usable > limits.maxUsable) return fail(next, "catalog_too_large", { restartable: true });
        if (MC.isEndToken(got.next)) {
          if (next.expectedTotal != null && next.rawScanned < next.expectedTotal) return fail(next, "pagination_incomplete", { restartable: true });
          if (!pausedMeanwhile) next.state = "finalizing";
          else next.pendingFinalize = true;
        }
        if (pausedMeanwhile) next.error = "user_paused";
        try {
          await pages.savePage(next, page, products.map((p) => ({ ...p, k: keyOf(p) })));
        } catch (e) {
          // Another copy of this run got there first: leave the run to it.
          if (e && e.code === "stale_cursor") return { ok: false, reason: "superseded" };
          const code = storageCode(e);
          if (STORAGE_RETRY.has(code)) cur.resumeAt = now() + limits.retryDelayMs;
          return fail(cur, code);
        }
        // The copy for the pages; if it fails the database's cursor wins later.
        try { await putRun(next); } catch (e) {}
        if (next.state === "finalizing") return finalize(next, revAtStart);
        if (pausedMeanwhile) return { ok: false, reason: "user_paused", run: publicRun(next) };
      }
    }

    // Build the new catalog from the staged pages and switch to it (one
    // database transaction: nothing changes if any step fails).
    async function finalize(run, revAtStart) {
      if (deps.revision && deps.revision() !== revAtStart) return fail(run, "account_changed", { restartable: true });
      const t = now();
      const info = {
        revision: `${t}-${Math.random().toString(16).slice(2, 8)}`,
        syncedAt: t,
        hitCount: run.expectedTotal == null ? run.rawScanned : run.expectedTotal,
        rawScanned: run.rawScanned,
      };
      let res;
      try {
        res = await pages.finalize(run, info);
      } catch (e) {
        // Nothing published: the old catalog stays; the staged pages stay so
        // the publish can be tried again.
        run.state = "paused";
        run.error = storageCode(e);
        run.resumeAt = now() + limits.retryDelayMs;
        run.pendingFinalize = true;
        await putRun(run).catch(() => {});
        return { ok: false, reason: run.error, run: publicRun(run) };
      }
      if (!res || !res.ok) {
        const reason = (res && res.reason) || "storage_write";
        if (reason === "empty_result_kept_previous") {
          await clearStage(run);
          run.state = "failed";
          run.error = reason;
          run.restartable = true;
          await putRun(run);
          return { ok: false, reason, run: publicRun(run) };
        }
        return fail(run, reason, { restartable: reason === "staged_page_missing" });
      }
      const catalog = res.catalog;
      if (deps.onPublished) {
        try { await deps.onPublished(catalog); } catch (e) {}
      }
      run.state = "complete";
      run.usable = catalog.count;
      run.completedAt = catalog.syncedAt || t;
      run.error = "";
      run.restartable = false;
      run.nextToken = [];
      run.seenTokens = [];
      run.pendingFinalize = false;
      await putRun(run);
      if (deps.onComplete) {
        try { await deps.onComplete(run, catalog); } catch (e) {}
      }
      return { ok: true, count: catalog.count, run: publicRun(run) };
    }

    return { start, resume, pause, cancel, status, getRun, publicRun, isRunning: () => !!loop, limits };
  }

  const api = { createEngine, RUN_KEY, STAGE_PREFIX, DEFAULT_LIMITS };
  root.EifMerchSync = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
