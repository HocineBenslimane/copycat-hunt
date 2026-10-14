// Copycat Hunt: the local catalog database (v3.24.0).
//
// Your Merch and eBay catalogs live in one SQLite database on this computer
// (the official SQLite WebAssembly build, in the browser's private file
// storage). This file is only the SQL: it runs inside the database worker and,
// for the tests, on Node's built-in SQLite. It never sees chrome.* and never
// takes SQL from outside: every operation below is a fixed statement.
//
// Tables
//   runs        one row per sync run: its saved cursor (the run ledger)
//   stage       the listings each page of a run brought, page by page
//   receipts    one row per saved page (page number and row count)
//   dropped_runs runs whose staged pages are waiting to be deleted
//   generations every catalog that was built: building / published / retired
//   active      which generation is the live catalog, per kind
//   products    the listings of each generation (indexed by ASIN / item)
//   aliases     parent and ad-safe ASINs pointing at a listing's ASIN
//
// Rules
//   - A page and the cursor that points past it are saved in ONE transaction.
//   - A new catalog is built next to the live one and becomes live in the
//     same transaction that checks it. Until then lookups use the old one.
//   - Lookups read a few index rows. Nothing loads a whole catalog.
(function (root) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const KINDS = new Set(["merch", "ebay"]);
  const SEQ_PAGE = 1000000; // products.seq = page * SEQ_PAGE + position on the page

  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, run_id TEXT NOT NULL, cursor TEXT, updated_at INTEGER NOT NULL, UNIQUE(kind, run_id))`,
    `CREATE TABLE IF NOT EXISTS stage(run INTEGER NOT NULL, page INTEGER NOT NULL, seq INTEGER NOT NULL, k TEXT NOT NULL, marketplace TEXT NOT NULL, asin TEXT NOT NULL, status TEXT NOT NULL DEFAULT '', design_id TEXT NOT NULL DEFAULT '', parent_asin TEXT NOT NULL DEFAULT '', ad_safe_asin TEXT NOT NULL DEFAULT '', PRIMARY KEY(run, page, seq)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS dropped_runs(run INTEGER PRIMARY KEY)`,
    `CREATE TABLE IF NOT EXISTS receipts(run INTEGER NOT NULL, page INTEGER NOT NULL, rows INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(run, page)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS generations(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, state TEXT NOT NULL, account_id TEXT NOT NULL, customer_id TEXT NOT NULL DEFAULT '', revision TEXT NOT NULL, synced_at INTEGER NOT NULL DEFAULT 0, hit_count INTEGER, raw_scanned INTEGER, count INTEGER NOT NULL DEFAULT 0, unrecognized INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'sync', run_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS active(kind TEXT PRIMARY KEY, generation INTEGER NOT NULL) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS products(gen INTEGER NOT NULL, k TEXT NOT NULL, seq INTEGER NOT NULL, marketplace TEXT NOT NULL, asin TEXT NOT NULL, status TEXT NOT NULL DEFAULT '', design_id TEXT NOT NULL DEFAULT '', parent_asin TEXT NOT NULL DEFAULT '', ad_safe_asin TEXT NOT NULL DEFAULT '', PRIMARY KEY(gen, k)) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS idx_products_asin ON products(gen, asin, marketplace)`,
    `CREATE TABLE IF NOT EXISTS aliases(gen INTEGER NOT NULL, alias TEXT NOT NULL, marketplace TEXT NOT NULL, asin TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_aliases ON aliases(gen, alias, marketplace)`,
  ];

  class StoreError extends Error {
    constructor(code, message) {
      super(message || code);
      this.code = code;
    }
  }

  // SQLite result codes → what the caller can act on.
  function classify(e) {
    if (e && e.code && typeof e.code === "string" && !/^SQLITE_|^ERR_/.test(e.code)) return e.code;
    const msg = String((e && (e.message || e)) || "");
    const rc = e && (e.resultCode != null ? e.resultCode : e.errcode != null ? e.errcode : null);
    const base = rc == null ? null : rc & 0xff;
    if (base === 13 || /SQLITE_FULL|database or disk is full|QuotaExceeded|quota/i.test(msg)) return "storage_full";
    if (base === 11 || base === 26 || /SQLITE_CORRUPT|SQLITE_NOTADB|malformed|not a database/i.test(msg)) return "storage_corrupt";
    if (base === 5 || base === 6 || /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(msg)) return "storage_busy";
    if (base === 10 || /SQLITE_IOERR|disk I\/O/i.test(msg)) return "storage_io";
    return "storage_write";
  }

  const str = (v, max) => {
    const s = v == null ? "" : String(v);
    return s.length > max ? s.slice(0, max) : s;
  };

  function createCatalogStore(D, opts = {}) {
    const now = opts.now || Date.now;
    const MC = opts.MC || null; // merch-catalog.js: ASIN / marketplace normalizers
    const normAsin = MC ? MC.normalizeAsin || ((a) => String(a || "").trim().toUpperCase()) : (a) => String(a || "").trim().toUpperCase();
    const normMp = MC ? MC.normalizeMarketplace : (m) => String(m || "");

    let depth = 0;
    function tx(fn) {
      if (depth) return fn();
      D.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const out = fn();
        depth--;
        D.exec("COMMIT");
        return out;
      } catch (e) {
        depth--;
        try { D.exec("ROLLBACK"); } catch (e2) {}
        throw e;
      }
    }

    function init() {
      const uv = D.get("PRAGMA user_version");
      const version = uv ? Number(Object.values(uv)[0]) || 0 : 0;
      if (version > SCHEMA_VERSION) throw new StoreError("storage_newer", "the catalog database is from a newer version");
      if (version === 0) {
        // Must come before the first table: lets cleanup hand freed space back.
        try { D.exec("PRAGMA auto_vacuum = INCREMENTAL"); } catch (e) {}
      }
      tx(() => {
        for (const sql of SCHEMA) D.exec(sql);
        D.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
      return { version: SCHEMA_VERSION };
    }

    function checkKind(kind) {
      if (!KINDS.has(kind)) throw new StoreError("bad_request", "unknown catalog");
    }

    function runRowId(kind, runId, create) {
      const row = D.get("SELECT id FROM runs WHERE kind = ? AND run_id = ?", [kind, runId]);
      if (row) return row.id;
      if (!create) return null;
      D.run("INSERT INTO runs(kind, run_id, cursor, updated_at) VALUES (?, ?, NULL, ?)", [kind, runId, now()]);
      return D.get("SELECT id FROM runs WHERE kind = ? AND run_id = ?", [kind, runId]).id;
    }

    function cleanRow(p) {
      return [
        str(p.k, 300),
        str(p.marketplace, 40),
        str(p.asin, 40),
        str(p.status, 40),
        str(p.designId, 120),
        str(p.parentAsin, 40),
        str(p.adSafeAsin, 40),
      ];
    }

    function writePage(id, page, rows) {
      D.run("DELETE FROM stage WHERE run = ? AND page = ?", [id, page]);
      const ins = D.prepare("INSERT OR IGNORE INTO stage(run, page, seq, k, marketplace, asin, status, design_id, parent_asin, ad_safe_asin) VALUES (?,?,?,?,?,?,?,?,?,?)");
      try {
        rows.forEach((p, i) => ins.run([id, page, i, ...cleanRow(p)]));
      } finally {
        ins.finalize();
      }
      D.run("INSERT OR REPLACE INTO receipts(run, page, rows, at) VALUES (?, ?, ?, ?)", [id, page, rows.length, now()]);
    }

    // One page and the cursor that points past it, together or not at all.
    function savePage(kind, cursor, page, rows) {
      checkKind(kind);
      if (!cursor || !cursor.runId) throw new StoreError("bad_request", "cursor without a run");
      return tx(() => {
        // Only the page right after the saved cursor (page 0 for a new run).
        // A second copy of the engine working on the same run (an old worker
        // that wasn't really gone), or one whose run was cleared meanwhile, is
        // told to stop instead of mixing its pages in.
        const prev = D.get("SELECT cursor FROM runs WHERE kind = ? AND run_id = ?", [kind, cursor.runId]);
        let at = 0;
        if (prev && prev.cursor) {
          try { at = Number(JSON.parse(prev.cursor).pagesDone) || 0; } catch (e) {}
        }
        if (page !== at) throw new StoreError("stale_cursor", `page ${page}, saved cursor at ${at}`);
        const id = runRowId(kind, cursor.runId, true);
        writePage(id, page, rows);
        D.run("UPDATE runs SET cursor = ?, updated_at = ? WHERE id = ?", [JSON.stringify(cursor), now(), id]);
        return { ok: true, page, rows: rows.length };
      });
    }

    // Migration: a page from the old storage, without moving the cursor.
    function importPage(kind, runId, page, rows) {
      checkKind(kind);
      return tx(() => {
        const id = runRowId(kind, runId, true);
        writePage(id, page, rows);
        return { ok: true, page, rows: rows.length };
      });
    }

    function setCursor(kind, cursor) {
      checkKind(kind);
      return tx(() => {
        const id = runRowId(kind, cursor.runId, true);
        D.run("UPDATE runs SET cursor = ?, updated_at = ? WHERE id = ?", [JSON.stringify(cursor), now(), id]);
        return { ok: true };
      });
    }

    function getCursor(kind) {
      checkKind(kind);
      const row = D.get("SELECT cursor FROM runs WHERE kind = ? AND cursor IS NOT NULL ORDER BY updated_at DESC, id DESC LIMIT 1", [kind]);
      if (!row || !row.cursor) return null;
      try { return JSON.parse(row.cursor); } catch (e) { return null; }
    }

    function receipts(kind, runId) {
      checkKind(kind);
      const id = runRowId(kind, runId, false);
      if (id == null) return [];
      return D.all("SELECT page FROM receipts WHERE run = ? ORDER BY page", [id]).map((r) => r.page);
    }

    // Drop a run's cursor and receipts now; its staged rows go in cleanup.
    function clearRun(kind, runId) {
      checkKind(kind);
      return tx(() => {
        const id = runRowId(kind, runId, false);
        if (id == null) return { ok: true };
        D.run("DELETE FROM receipts WHERE run = ?", [id]);
        D.run("DELETE FROM runs WHERE id = ?", [id]);
        D.run("INSERT OR IGNORE INTO dropped_runs(run) VALUES (?)", [id]);
        return { ok: true };
      });
    }

    function sameAccount(kind, gen, run) {
      if (!gen || !run || !gen.account_id || !run.accountId) return false;
      if (kind === "ebay") return String(gen.account_id).toLowerCase() === String(run.accountId).toLowerCase();
      if (gen.account_id !== run.accountId) return false;
      if (gen.customer_id && run.customerId && gen.customer_id !== run.customerId) return false;
      return true;
    }

    function metaOf(g) {
      if (!g) return null;
      return {
        kind: g.kind,
        generation: g.id,
        accountId: g.account_id,
        customerId: g.customer_id || "",
        revision: g.revision,
        syncedAt: g.synced_at,
        hitCount: g.hit_count,
        rawScanned: g.raw_scanned,
        count: g.count,
        unrecognized: g.unrecognized,
        source: g.source,
      };
    }

    function activeGen(kind) {
      return D.get("SELECT g.* FROM active a JOIN generations g ON g.id = a.generation WHERE a.kind = ?", [kind]) || null;
    }

    function active(kind) {
      checkKind(kind);
      return metaOf(activeGen(kind));
    }

    function newGeneration(kind, info, state, source) {
      D.run(
        "INSERT INTO generations(kind, state, account_id, customer_id, revision, synced_at, hit_count, raw_scanned, count, unrecognized, source, run_id, created_at) VALUES (?,?,?,?,?,?,?,?,0,0,?,?,?)",
        [kind, state, str(info.accountId, 200), str(info.customerId, 200), str(info.revision, 100), Number(info.syncedAt) || 0, info.hitCount == null ? null : Number(info.hitCount), info.rawScanned == null ? null : Number(info.rawScanned), source, str(info.runId, 100), now()]
      );
      return D.get("SELECT last_insert_rowid() AS id").id;
    }

    // Aliases, counts, then the switch: the caller is inside tx().
    function publish(kind, gen) {
      D.run("INSERT INTO aliases(gen, alias, marketplace, asin) SELECT gen, parent_asin, marketplace, asin FROM products WHERE gen = ? AND parent_asin <> '' AND parent_asin <> asin", [gen]);
      D.run("INSERT INTO aliases(gen, alias, marketplace, asin) SELECT gen, ad_safe_asin, marketplace, asin FROM products WHERE gen = ? AND ad_safe_asin <> '' AND ad_safe_asin <> asin", [gen]);
      const count = D.get("SELECT count(*) AS n FROM products WHERE gen = ?", [gen]).n;
      const unrecognized = D.get("SELECT count(*) AS n FROM products WHERE gen = ? AND (marketplace = '' OR substr(marketplace, 1, 1) = '?')", [gen]).n;
      const prev = activeGen(kind);
      D.run("UPDATE generations SET state = 'published', count = ?, unrecognized = ? WHERE id = ?", [count, unrecognized, gen]);
      if (prev && prev.id !== gen) D.run("UPDATE generations SET state = 'retired' WHERE id = ?", [prev.id]);
      D.run("INSERT OR REPLACE INTO active(kind, generation) VALUES (?, ?)", [kind, gen]);
      return metaOf(D.get("SELECT * FROM generations WHERE id = ?", [gen]));
    }

    // Build the new catalog from a run's staged pages and make it live.
    //   run: { runId, pagesDone, accountId, customerId }
    //   info: { revision, syncedAt, hitCount, rawScanned }
    function finalize(kind, run, info) {
      checkKind(kind);
      return tx(() => {
        const id = runRowId(kind, run.runId, false);
        if (id == null) {
          // Asked again after an answer that never arrived: was it published?
          const done = D.get("SELECT * FROM generations WHERE kind = ? AND run_id = ? AND state IN ('published', 'retired') ORDER BY id DESC LIMIT 1", [kind, str(run.runId, 100)]);
          if (done) return { ok: true, catalog: metaOf(done), already: true };
        }
        const pages = Number(run.pagesDone) || 0;
        // A run whose very first page was empty saved nothing: that is fine.
        const rec = id == null ? { n: 0, last: null } : D.get("SELECT count(*) AS n, max(page) AS last FROM receipts WHERE run = ?", [id]);
        if (rec.n !== pages || (pages > 0 && rec.last !== pages - 1)) return { ok: false, reason: "staged_page_missing" };
        const gen = newGeneration(kind, { ...info, accountId: run.accountId, customerId: run.customerId, runId: run.runId }, "building", "sync");
        // First copy of a listing wins, in page order (the old in-memory rule).
        const count = D.run(
          `INSERT OR IGNORE INTO products(gen, k, seq, marketplace, asin, status, design_id, parent_asin, ad_safe_asin)
           SELECT ?, k, page * ${SEQ_PAGE} + seq, marketplace, asin, status, design_id, parent_asin, ad_safe_asin
           FROM stage WHERE run = ? ORDER BY page, seq`,
          [gen, id == null ? -1 : id]
        ).changes;
        const prev = activeGen(kind);
        if (!count && prev && prev.count > 0 && sameAccount(kind, prev, run)) {
          // Nothing came back but the account had listings: keep them.
          throw new StoreError("empty_result_kept_previous");
        }
        const meta = publish(kind, gen);
        if (id != null) {
          D.run("DELETE FROM receipts WHERE run = ?", [id]);
          D.run("DELETE FROM runs WHERE id = ?", [id]);
          D.run("INSERT OR IGNORE INTO dropped_runs(run) VALUES (?)", [id]);
        }
        return { ok: true, catalog: meta };
      });
    }

    // ---------- migration of a complete catalog from chrome.storage ----------
    function importBegin(kind, info) {
      checkKind(kind);
      return tx(() => {
        // A migration that stopped halfway starts over: retire its leftovers.
        D.run("UPDATE generations SET state = 'retired' WHERE kind = ? AND state = 'importing'", [kind]);
        return { ok: true, generation: newGeneration(kind, info, "importing", "migrated") };
      });
    }

    function importChunk(gen, startSeq, rows) {
      return tx(() => {
        const g = D.get("SELECT state FROM generations WHERE id = ?", [gen]);
        if (!g || g.state !== "importing") throw new StoreError("bad_request", "not an import in progress");
        const before = D.get("SELECT total_changes() AS n").n;
        const ins = D.prepare("INSERT OR IGNORE INTO products(gen, k, seq, marketplace, asin, status, design_id, parent_asin, ad_safe_asin) VALUES (?,?,?,?,?,?,?,?,?)");
        try {
          rows.forEach((p, i) => {
            const r = cleanRow(p); // [k, marketplace, asin, status, designId, parentAsin, adSafeAsin]
            ins.run([gen, r[0], startSeq + i, r[1], r[2], r[3], r[4], r[5], r[6]]);
          });
        } finally {
          ins.finalize();
        }
        // Rows actually added (a listing repeated in the old list counts once).
        return { ok: true, rows: rows.length, inserted: D.get("SELECT total_changes() AS n").n - before };
      });
    }

    // Publish the imported catalog, unless a newer sync already went live.
    function importCommit(kind, gen) {
      checkKind(kind);
      return tx(() => {
        const g = D.get("SELECT * FROM generations WHERE id = ? AND kind = ?", [gen, kind]);
        if (!g || g.state !== "importing") throw new StoreError("bad_request", "not an import in progress");
        const cur = activeGen(kind);
        if (cur && cur.synced_at >= g.synced_at) {
          D.run("UPDATE generations SET state = 'retired' WHERE id = ?", [gen]);
          return { ok: true, kept: "newer", catalog: metaOf(cur) };
        }
        return { ok: true, catalog: publish(kind, gen) };
      });
    }

    // ---------- lookups (a few index rows each) ----------
    // INDEXED BY: without it SQLite may walk the whole generation through the
    // primary key (gen, k) instead of the ASIN index (measured: 25 ms per item
    // at 100k listings, vs well under 1 ms).
    function exactHit(gen, mp, a) {
      return D.get("SELECT asin, design_id, status FROM products INDEXED BY idx_products_asin WHERE gen = ? AND asin = ? AND marketplace = ? ORDER BY (design_id = ''), seq LIMIT 1", [gen, a, mp]);
    }

    function matchIn(gen, mp, a) {
      const hit = exactHit(gen, mp, a);
      if (hit) return { state: "catalog_matched", matchType: "exact", canonicalAsin: hit.asin, designId: hit.design_id, status: hit.status };
      const via = D.all("SELECT DISTINCT asin FROM aliases INDEXED BY idx_aliases WHERE gen = ? AND alias = ? AND marketplace = ? LIMIT 2", [gen, a, mp]);
      if (via.length === 1) {
        const canonical = via[0].asin;
        const p = exactHit(gen, mp, canonical);
        return { state: "catalog_matched", matchType: "parent_or_ad_safe", canonicalAsin: canonical, designId: p ? p.design_id : "", status: p ? p.status : "" };
      }
      if (via.length > 1) return { state: "unknown", reason: "ambiguous_alias" };
      return null;
    }

    // Same answers as merch-catalog.js lookupOne, from the index.
    function lookupOne(g, asin, marketplace, pageAsins) {
      const a = normAsin(asin);
      const mp = normMp(marketplace);
      if (!a || !mp || mp.startsWith("?")) return { state: "unknown", reason: "bad_identity" };
      const own = matchIn(g.id, mp, a);
      if (own) return own;
      for (const c of [...new Set((pageAsins || []).map(normAsin).filter((x) => x && x !== a))].slice(0, 4)) {
        const viaPage = matchIn(g.id, mp, c);
        if (viaPage && viaPage.state === "catalog_matched") return { ...viaPage, matchType: "product_page", matchedVia: c };
        if (viaPage) return viaPage;
      }
      if (g.unrecognized) return { state: "unknown", reason: "unrecognized_marketplace_records" };
      return { state: "not_found" };
    }

    function merchLookup(items) {
      const g = activeGen("merch");
      if (!g) return { ok: true, catalog: null, results: [] };
      return { ok: true, catalog: metaOf(g), results: items.map((it) => lookupOne(g, it.asin, it.marketplace, it.pageAsins)) };
    }

    function ebayOwn(itemNumbers) {
      const g = activeGen("ebay");
      if (!g) return { ok: true, catalog: null, own: [] };
      const own = [];
      const q = "SELECT 1 AS x FROM products INDEXED BY idx_products_asin WHERE gen = ? AND asin = ? LIMIT 1";
      for (const n of itemNumbers) if (D.get(q, [g.id, n])) own.push(n);
      return { ok: true, catalog: metaOf(g), own };
    }

    // ---------- housekeeping ----------
    // Deletes old generations and leftover staged pages a slice at a time.
    function cleanup(budget = 50000) {
      let left = budget;
      const retired = D.all("SELECT id FROM generations WHERE state = 'retired' AND id NOT IN (SELECT generation FROM active) ORDER BY id LIMIT 5");
      for (const { id } of retired) {
        if (left <= 0) break;
        tx(() => {
          const a = D.run("DELETE FROM aliases WHERE rowid IN (SELECT rowid FROM aliases WHERE gen = ? LIMIT ?)", [id, left]).changes;
          left -= a;
          const p = left > 0 ? D.run("DELETE FROM products WHERE gen = ? AND k IN (SELECT k FROM products WHERE gen = ? LIMIT ?)", [id, id, left]).changes : 0;
          left -= p;
          if (!D.get("SELECT 1 AS x FROM products WHERE gen = ? LIMIT 1", [id]) && !D.get("SELECT 1 AS x FROM aliases WHERE gen = ? LIMIT 1", [id])) D.run("DELETE FROM generations WHERE id = ?", [id]);
        });
      }
      while (left > 0) {
        const gone = D.get("SELECT run FROM dropped_runs LIMIT 1");
        if (!gone) break;
        tx(() => {
          const n = D.run("DELETE FROM stage WHERE run = ? AND (page, seq) IN (SELECT page, seq FROM stage WHERE run = ? LIMIT ?)", [gone.run, gone.run, left]).changes;
          left -= n;
          if (!D.get("SELECT 1 AS x FROM stage WHERE run = ? LIMIT 1", [gone.run])) D.run("DELETE FROM dropped_runs WHERE run = ?", [gone.run]);
        });
      }
      const more =
        !!D.get("SELECT 1 AS x FROM generations WHERE state = 'retired' AND id NOT IN (SELECT generation FROM active) LIMIT 1") ||
        !!D.get("SELECT 1 AS x FROM dropped_runs LIMIT 1");
      if (!more) {
        // Each step frees one page and the statement has no columns, so the
        // object API's exec() would stop after one: step it to the end.
        try { D.drain("PRAGMA incremental_vacuum"); } catch (e) {}
      }
      return { ok: true, removed: budget - left, more };
    }

    function stats() {
      const n = (sql) => {
        const r = D.get(sql);
        return r ? Number(Object.values(r)[0]) || 0 : 0;
      };
      return {
        ok: true,
        schema: SCHEMA_VERSION,
        pageSize: n("PRAGMA page_size"),
        pageCount: n("PRAGMA page_count"),
        freePages: n("PRAGMA freelist_count"),
        autoVacuum: n("PRAGMA auto_vacuum"),
        journalMode: String(Object.values(D.get("PRAGMA journal_mode") || { m: "" })[0]),
        merch: active("merch"),
        ebay: active("ebay"),
        runs: n("SELECT count(*) FROM runs"),
        staged: n("SELECT count(*) FROM stage"),
      };
    }

    function quickCheck() {
      const r = D.all("PRAGMA quick_check(1)");
      const v = r.length ? String(Object.values(r[0])[0]) : "";
      return { ok: v === "ok", result: v.slice(0, 200) };
    }

    return {
      init,
      savePage,
      importPage,
      setCursor,
      getCursor,
      receipts,
      clearRun,
      finalize: (kind, run, info) => {
        try {
          return finalize(kind, run, info);
        } catch (e) {
          if (e && e.code === "empty_result_kept_previous") return { ok: false, reason: "empty_result_kept_previous" };
          throw e;
        }
      },
      active,
      importBegin,
      importChunk,
      importCommit,
      merchLookup,
      ebayOwn,
      cleanup,
      stats,
      quickCheck,
    };
  }

  // ---------- adapters ----------
  // The official build's object API (inside the worker).
  function oo1Adapter(db) {
    return {
      exec: (sql) => db.exec(sql),
      all: (sql, params) => db.exec({ sql, bind: params && params.length ? params : undefined, rowMode: "object", returnValue: "resultRows" }),
      get(sql, params) {
        const rows = db.exec({ sql, bind: params && params.length ? params : undefined, rowMode: "object", returnValue: "resultRows" });
        return rows.length ? rows[0] : null;
      },
      run(sql, params) {
        db.exec({ sql, bind: params && params.length ? params : undefined });
        return { changes: db.changes() };
      },
      prepare(sql) {
        const st = db.prepare(sql);
        return {
          run(params) {
            st.bind(params);
            st.stepReset();
          },
          finalize: () => st.finalize(),
        };
      },
      drain(sql) {
        const st = db.prepare(sql);
        try {
          while (st.step()) {}
        } finally {
          st.finalize();
        }
      },
    };
  }

  // Node's built-in node:sqlite (tests only).
  function nodeAdapter(db) {
    const cache = new Map();
    const stmt = (sql) => {
      let s = cache.get(sql);
      if (!s) {
        s = db.prepare(sql);
        cache.set(sql, s);
      }
      return s;
    };
    return {
      exec: (sql) => db.exec(sql),
      all: (sql, params) => stmt(sql).all(...(params || [])).map((r) => ({ ...r })),
      get(sql, params) {
        const r = stmt(sql).get(...(params || []));
        return r ? { ...r } : null;
      },
      run: (sql, params) => ({ changes: Number(stmt(sql).run(...(params || [])).changes) }),
      prepare(sql) {
        const s = db.prepare(sql);
        return { run: (params) => s.run(...params), finalize() {} };
      },
      drain: (sql) => { db.prepare(sql).all(); },
    };
  }

  const api = { createCatalogStore, oo1Adapter, nodeAdapter, classify, StoreError, SCHEMA_VERSION, SEQ_PAGE };
  root.EifCatalogStore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
