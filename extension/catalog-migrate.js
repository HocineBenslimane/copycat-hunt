(function (root) {
  "use strict";

  const RESUMABLE = new Set(["syncing", "finalizing", "paused", "needs_login", "waiting"]);
  const CHUNK = 5000;

  const SPECS = [
    {
      kind: "merch",
      runKey: "eifMerchRun",
      stagePrefix: "eifMerchStage:",
      catalogKey: "eifMerchCatalog",
      extraKeys: [],
      key: (p) => `${p.marketplace}|${p.asin}|${p.listingId}`,
      row: (p) => p,
      info: (c) => ({ accountId: c.accountId, customerId: c.customerId || "", revision: c.revision, syncedAt: c.syncedAt, hitCount: c.hitCount, rawScanned: c.rawScanned }),
    },
    {
      kind: "ebay",
      runKey: "eifEbayRun",
      stagePrefix: "eifEbayStage:",
      catalogKey: "eifEbayCatalog",
      extraKeys: ["eifEbayOwnIds"],
      key: (p) => `EBAY|${p.itemNumber || p.asin}`,
      row: (p) => ({ marketplace: "EBAY_US", asin: String(p.itemNumber || p.asin || "") }),
      info: (c) => ({ accountId: c.accountId, customerId: "", revision: c.revision, syncedAt: c.syncedAt, hitCount: c.total, rawScanned: c.total }),
    },
  ];

  function createMigrator(deps) {
    const storage = deps.storage;
    const db = deps.db;
    const log = deps.log || (() => {});

    const toRows = (spec, list) =>
      (Array.isArray(list) ? list : [])
        .filter((p) => p && typeof p === "object")
        .map((p) => ({ ...spec.row(p), k: spec.key(p) }))
        .filter((p) => p.asin);

    async function moveCatalog(spec) {
      let legacy = (await storage.get({ [spec.catalogKey]: null }))[spec.catalogKey];
      if (!legacy || !Array.isArray(legacy.products) || !legacy.accountId) {
        const stray = [spec.catalogKey, ...spec.extraKeys];
        const left = await storage.get(Object.fromEntries(stray.map((k) => [k, null])));
        const remove = stray.filter((k) => left[k] != null);
        if (remove.length) await storage.remove(remove);
        return { moved: false };
      }
      const live = (await db.call("active", { kind: spec.kind })).catalog;
      if (!live || live.revision !== legacy.revision) {
        const begin = await db.call("importBegin", { kind: spec.kind, info: spec.info(legacy) });
        const list = legacy.products;
        let sent = 0;
        let inserted = 0;
        for (let i = 0; i < list.length; i += CHUNK) {
          const rows = toRows(spec, list.slice(i, i + CHUNK));
          const r = await db.call("importChunk", { generation: begin.generation, startSeq: i, rows }, { timeoutMs: 120000 });
          sent += rows.length;
          inserted += Number(r.inserted) || 0;
        }
        const revision = legacy.revision;
        legacy = null;
        const done = await db.call("importCommit", { kind: spec.kind, generation: begin.generation }, { timeoutMs: 300000 });
        if (!done.kept && (!done.catalog || done.catalog.revision !== revision || done.catalog.count !== inserted || inserted > sent)) {
          throw Object.assign(new Error("catalog copy did not check out"), { code: "migration_mismatch" });
        }
        log(`${spec.kind}: ${inserted} listings moved${done.kept ? " (a newer catalog was already there)" : ""}`);
      }
      await storage.remove([spec.catalogKey, ...spec.extraKeys]);
      return { moved: true };
    }

    function stageKeys(spec, run) {
      const keys = [];
      for (let i = 0; i <= (Number(run.pagesDone) || 0) + 1; i++) keys.push(`${spec.stagePrefix}${run.runId}:${i}`);
      return keys;
    }

    async function moveRun(spec) {
      const run = (await storage.get({ [spec.runKey]: null }))[spec.runKey];
      if (!run || !run.runId) return { moved: false };
      const keys = stageKeys(spec, run);
      const pagesDone = Number(run.pagesDone) || 0;
      const BATCH = 20;
      const found = [];
      let missing = false;
      let moving = RESUMABLE.has(run.state) && !run.restartable && pagesDone > 0;
      if (moving) {
        const saved = (await db.call("getCursor", { kind: spec.kind })).cursor;
        if (saved && saved.runId === run.runId && (saved.pagesDone || 0) >= pagesDone) moving = false;
      }
      const have = moving ? new Set((await db.call("receipts", { kind: spec.kind, runId: run.runId })).pages) : new Set();
      for (let i = 0; i < keys.length; i += BATCH) {
        const part = keys.slice(i, i + BATCH);
        const got = await storage.get(Object.fromEntries(part.map((k) => [k, null])));
        for (let j = 0; j < part.length; j++) {
          const page = got[part[j]];
          if (page != null) found.push(part[j]);
          const n = i + j;
          if (!moving || missing || n >= pagesDone || have.has(n)) continue;
          if (!Array.isArray(page)) {
            missing = true;
            continue;
          }
          await db.call("importPage", { kind: spec.kind, runId: run.runId, page: n, rows: page.filter((p) => p && typeof p === "object").map((p) => ({ ...p, k: spec.key(p) })) });
        }
      }
      if (moving) {
        if (missing) {
          await db.call("clearRun", { kind: spec.kind, runId: run.runId });
          await storage.set({ [spec.runKey]: { ...run, state: "failed", error: "staged_page_missing", restartable: true, pagesDone: 0, rawScanned: 0, usable: 0, nextToken: [], seenTokens: [] } });
        } else {
          await db.call("setCursor", { kind: spec.kind, cursor: run });
        }
      }
      for (let i = 0; i < found.length; i += 200) await storage.remove(found.slice(i, i + 200));
      return { moved: true, pages: found.length };
    }

    async function migrate() {
      const out = {};
      for (const spec of SPECS) {
        out[spec.kind] = { run: await moveRun(spec), catalog: await moveCatalog(spec) };
      }
      return out;
    }

    return { migrate };
  }

  const api = { createMigrator, SPECS };
  root.EifCatalogMigrate = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
