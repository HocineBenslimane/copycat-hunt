(function (root) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const KINDS = new Set(["merch", "ebay"]);
  const GONE = new Set(["DELETED", "REMOVED", "DELETING"]);
  const GONE_SQL = `(${[...GONE].map((s) => `'${s}'`).join(", ")})`;
  const SEQ_PAGE = 1000000;

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
    `CREATE TABLE IF NOT EXISTS sales(account TEXT NOT NULL, day TEXT NOT NULL, marketplace TEXT NOT NULL, asin TEXT NOT NULL, sold INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0, returned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account, marketplace, asin, day)) WITHOUT ROWID`,
  ];
  const SALES_META = "sales";
  const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
  const nextDay = (day, n) => {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  };

  class StoreError extends Error {
    constructor(code, message) {
      super(message || code);
      this.code = code;
    }
  }

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
    const MC = opts.MC || null;
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

    function savePage(kind, cursor, page, rows) {
      checkKind(kind);
      if (!cursor || !cursor.runId) throw new StoreError("bad_request", "cursor without a run");
      return tx(() => {
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

    function finalize(kind, run, info) {
      checkKind(kind);
      return tx(() => {
        const id = runRowId(kind, run.runId, false);
        if (id == null) {
          const done = D.get("SELECT * FROM generations WHERE kind = ? AND run_id = ? AND state IN ('published', 'retired') ORDER BY id DESC LIMIT 1", [kind, str(run.runId, 100)]);
          if (done) return { ok: true, catalog: metaOf(done), already: true };
        }
        const pages = Number(run.pagesDone) || 0;
        const rec = id == null ? { n: 0, last: null } : D.get("SELECT count(*) AS n, max(page) AS last FROM receipts WHERE run = ?", [id]);
        if (rec.n !== pages || (pages > 0 && rec.last !== pages - 1)) return { ok: false, reason: "staged_page_missing" };
        const gen = newGeneration(kind, { ...info, accountId: run.accountId, customerId: run.customerId, runId: run.runId }, "building", "sync");
        const count = D.run(
          `INSERT OR IGNORE INTO products(gen, k, seq, marketplace, asin, status, design_id, parent_asin, ad_safe_asin)
           SELECT ?, k, page * ${SEQ_PAGE} + seq, marketplace, asin, status, design_id, parent_asin, ad_safe_asin
           FROM stage WHERE run = ? ORDER BY page, seq`,
          [gen, id == null ? -1 : id]
        ).changes;
        const prev = activeGen(kind);
        if (!count && prev && prev.count > 0 && sameAccount(kind, prev, run)) {
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

    function importBegin(kind, info) {
      checkKind(kind);
      return tx(() => {
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
            const r = cleanRow(p);
            ins.run([gen, r[0], startSeq + i, r[1], r[2], r[3], r[4], r[5], r[6]]);
          });
        } finally {
          ins.finalize();
        }
        return { ok: true, rows: rows.length, inserted: D.get("SELECT total_changes() AS n").n - before };
      });
    }

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

    function summary(kind) {
      checkKind(kind);
      const g = activeGen(kind);
      if (!g) return { ok: true, summary: null };
      const r = D.get(
        `SELECT count(*) AS products,
                count(DISTINCT CASE WHEN design_id <> '' THEN 'd:' || design_id ELSE 'a:' || marketplace || '|' || asin END) AS designs
         FROM products WHERE gen = ? AND upper(status) NOT IN ${GONE_SQL}`,
        [g.id]
      );
      return { ok: true, summary: { revision: g.revision, total: g.count, products: Number(r.products) || 0, designs: Number(r.designs) || 0 } };
    }

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

    function salesCoverage() {
      const r = D.get("SELECT v FROM meta WHERE k = ?", [SALES_META]);
      if (!r) return null;
      try { return JSON.parse(r.v); } catch (e) { return null; }
    }

    function salesSave(account, from, to, keepFrom, rows) {
      if (!account || !isDay(from) || !isDay(to) || from > to || (keepFrom && !isDay(keepFrom))) throw new StoreError("bad_request", "sales period");
      return tx(() => {
        const prev = salesCoverage();
        if (prev && prev.account !== account) D.run("DELETE FROM sales WHERE account <> ?", [account]);
        D.run("DELETE FROM sales WHERE account = ? AND day >= ? AND day <= ?", [account, from, to]);
        const ins = D.prepare("INSERT INTO sales(account, day, marketplace, asin, sold, cancelled, returned) VALUES (?,?,?,?,?,?,?) ON CONFLICT(account, marketplace, asin, day) DO UPDATE SET sold = sold + excluded.sold, cancelled = cancelled + excluded.cancelled, returned = returned + excluded.returned");
        let saved = 0;
        try {
          for (const r of rows) {
            if (!isDay(r.day) || r.day < from || r.day > to) continue;
            ins.run([account, r.day, str(r.marketplace, 8), str(r.asin, 20), r.sold, r.cancelled, r.returned]);
            saved++;
          }
        } finally {
          ins.finalize();
        }
        if (keepFrom) D.run("DELETE FROM sales WHERE account = ? AND day < ?", [account, keepFrom]);
        let cover = { account, coveredFrom: from, coveredTo: to };
        if (prev && prev.account === account && isDay(prev.coveredFrom) && isDay(prev.coveredTo) && from <= nextDay(prev.coveredTo, 1) && to >= nextDay(prev.coveredFrom, -1)) {
          cover = { account, coveredFrom: prev.coveredFrom < from ? prev.coveredFrom : from, coveredTo: prev.coveredTo > to ? prev.coveredTo : to };
        }
        if (keepFrom && cover.coveredFrom < keepFrom) cover.coveredFrom = keepFrom;
        cover.at = now();
        D.run("INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)", [SALES_META, JSON.stringify(cover)]);
        return { ok: true, saved, coverage: cover };
      });
    }

    function bestSellers(fromDay, marketplace, limit) {
      const g = activeGen("merch");
      const cover = salesCoverage();
      if (!g) return { ok: true, catalog: null, coverage: cover, designs: [], total: 0, unmatched: [] };
      if (!cover || cover.account !== g.account_id) return { ok: true, catalog: metaOf(g), coverage: null, designs: [], total: 0, unmatched: [] };
      const rows = D.all(
        `SELECT s.marketplace, s.asin, s.net,
                (SELECT (CASE WHEN upper(status) IN ${GONE_SQL} THEN 'G' ELSE 'L' END) || design_id FROM products INDEXED BY idx_products_asin WHERE gen = ? AND asin = s.asin AND marketplace = s.marketplace ORDER BY (upper(status) IN ${GONE_SQL}), (design_id = ''), seq LIMIT 1) AS design
         FROM (SELECT marketplace, asin, sum(sold) - sum(cancelled) - sum(returned) AS net
               FROM sales WHERE account = ?${marketplace ? " AND marketplace = ?" : ""} AND day >= ? GROUP BY marketplace, asin) s`,
        marketplace ? [g.id, g.account_id, marketplace, fromDay] : [g.id, g.account_id, fromDay]
      );
      const designs = new Map();
      const unmatched = [];
      for (const r of rows) {
        const units = Math.max(0, Number(r.net) || 0);
        const hit = r.design != null ? { state: "catalog_matched", canonicalAsin: r.asin, designId: r.design.slice(1), gone: r.design[0] === "G" } : lookupOne(g, r.asin, r.marketplace, []);
        if (hit.state !== "catalog_matched") {
          if (hit.state === "not_found" && unmatched.length < 200) unmatched.push({ asin: r.asin, marketplace: r.marketplace });
          continue;
        }
        if (hit.gone || GONE.has(String(hit.status || "").toUpperCase())) continue;
        if (!units) continue;
        const asin = hit.canonicalAsin || r.asin;
        const key = hit.designId ? `d:${hit.designId}` : `a:${r.marketplace}|${asin}`;
        const d = designs.get(key) || { key, designId: hit.designId || "", units: 0, listings: new Map() };
        d.units += units;
        const lk = `${r.marketplace}|${asin}`;
        const l = d.listings.get(lk) || { marketplace: r.marketplace, asin, units: 0 };
        l.units += units;
        d.listings.set(lk, l);
        designs.set(key, d);
      }
      const byUnits = (a, b) => b.units - a.units || String(a.asin || a.key).localeCompare(String(b.asin || b.key));
      const all = [...designs.values()].map((d) => {
        const listings = [...d.listings.values()].sort(byUnits);
        return { key: d.key, designId: d.designId, units: d.units, asin: listings[0].asin, marketplace: listings[0].marketplace, marketplaces: [...new Set(listings.map((l) => l.marketplace))], listings: listings.slice(0, 12) };
      }).sort(byUnits);
      return { ok: true, catalog: metaOf(g), coverage: cover, designs: all.slice(0, limit), total: all.length, unmatched };
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
      summary,
      importBegin,
      importChunk,
      importCommit,
      merchLookup,
      ebayOwn,
      salesSave,
      salesCoverage,
      bestSellers,
      cleanup,
      stats,
      quickCheck,
    };
  }

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
