self.sqlite3ApiConfig = { disable: { vfs: { opfs: true, "opfs-vfs": true, "opfs-wl": true } } };
importScripts("vendor/sqlite/sqlite3.js", "merch-catalog.js", "catalog-store.js");

const CS = self.EifCatalogStore;
const DB_FILE = "/copycat-catalog.sqlite3";
const POOL = { name: "eif-catalog-pool", directory: ".eif-catalog", initialCapacity: 6, clearOnInit: false };
const LOCK = "eif-catalog-db";

let sqlite3 = null;
let pool = null;
let db = null;
let store = null;
let state = { state: "starting" };

function takeLock() {
  if (!self.navigator || !navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks
      .request(LOCK, { mode: "exclusive", ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return null;
        }
        resolve(true);
        return new Promise(() => {});
      })
      .catch(() => resolve(false));
  });
}

function supported() {
  return !!(self.navigator && navigator.storage && navigator.storage.getDirectory && self.FileSystemFileHandle && FileSystemFileHandle.prototype.createSyncAccessHandle);
}

function openDb() {
  db = new pool.OpfsSAHPoolDb(DB_FILE);
  db.exec("PRAGMA locking_mode = EXCLUSIVE");
  db.exec("PRAGMA cache_size = -16384");
  db.exec("PRAGMA temp_store = FILE");
  store = CS.createCatalogStore(CS.oo1Adapter(db), { MC: self.EifMerchCatalog });
  store.init();
}

const ready = (async () => {
  try {
    if (!supported()) {
      state = { state: "failed", code: "storage_unsupported" };
      return;
    }
    if (!(await takeLock())) {
      state = { state: "failed", code: "storage_busy" };
      return;
    }
    sqlite3 = await self.sqlite3InitModule({
      locateFile: (f) => new URL(`vendor/sqlite/${f}`, self.location.href).href,
      print: () => {},
      printErr: () => {},
    });
    pool = await sqlite3.installOpfsSAHPoolVfs(POOL);
    self.__eifOtherOpfs = !!(sqlite3.opfs || (sqlite3.oo1 && (sqlite3.oo1.OpfsDb || sqlite3.oo1.OpfsWlDb)));
    openDb();
    state = { state: "ready", version: sqlite3.version.libVersion, sourceId: sqlite3.version.sourceId, vfs: "opfs-sahpool", otherOpfs: self.__eifOtherOpfs };
  } catch (e) {
    const code = e && e.code === "storage_newer" ? "storage_newer" : CS.classify(e);
    state = { state: "failed", code: code === "storage_write" ? "storage_unavailable" : code, message: String((e && e.message) || e).slice(0, 200) };
  }
})();

const fail = (code, message) => {
  const e = new Error(message || code);
  e.code = code;
  throw e;
};
const kindOf = (k) => (k === "merch" || k === "ebay" ? k : fail("bad_request", "kind"));
const intOf = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : fail("bad_request", "number"));
const textOf = (v, max) => (v == null ? "" : typeof v === "string" || typeof v === "number" ? String(v).slice(0, max) : fail("bad_request", "text"));
function rowsOf(list, max) {
  if (!Array.isArray(list) || list.length > max) fail("bad_request", "rows");
  return list.map((p) => {
    if (!p || typeof p !== "object") fail("bad_request", "row");
    return {
      k: textOf(p.k, 300) || fail("bad_request", "row key"),
      marketplace: textOf(p.marketplace, 40),
      asin: textOf(p.asin, 40),
      status: textOf(p.status, 40),
      designId: textOf(p.designId, 120),
      parentAsin: textOf(p.parentAsin, 40),
      adSafeAsin: textOf(p.adSafeAsin, 40),
    };
  });
}
function cursorOf(c) {
  if (!c || typeof c !== "object" || typeof c.runId !== "string" || !c.runId) fail("bad_request", "cursor");
  const json = JSON.stringify(c);
  if (json.length > 2000000) fail("bad_request", "cursor size");
  return c;
}
function runOf(r) {
  if (!r || typeof r !== "object") fail("bad_request", "run");
  return { runId: textOf(r.runId, 100) || fail("bad_request", "run id"), pagesDone: intOf(r.pagesDone, 100000), accountId: textOf(r.accountId, 200), customerId: textOf(r.customerId, 200) };
}
function infoOf(i) {
  i = i || {};
  const num = (v) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  return { revision: textOf(i.revision, 100), syncedAt: num(i.syncedAt) || 0, hitCount: num(i.hitCount), rawScanned: num(i.rawScanned), accountId: textOf(i.accountId, 200), customerId: textOf(i.customerId, 200) };
}

const OPS = {
  status: () => ({ ...state }),
  savePage: (a) => store.savePage(kindOf(a.kind), cursorOf(a.cursor), intOf(a.page, 100000), rowsOf(a.rows, 2000)),
  importPage: (a) => store.importPage(kindOf(a.kind), textOf(a.runId, 100) || fail("bad_request"), intOf(a.page, 100000), rowsOf(a.rows, 2000)),
  setCursor: (a) => store.setCursor(kindOf(a.kind), cursorOf(a.cursor)),
  getCursor: (a) => ({ cursor: store.getCursor(kindOf(a.kind)) }),
  receipts: (a) => ({ pages: store.receipts(kindOf(a.kind), textOf(a.runId, 100)) }),
  clearRun: (a) => store.clearRun(kindOf(a.kind), textOf(a.runId, 100)),
  finalize: (a) => store.finalize(kindOf(a.kind), runOf(a.run), infoOf(a.info)),
  active: (a) => ({ catalog: store.active(kindOf(a.kind)) }),
  summary: (a) => store.summary(kindOf(a.kind)),
  importBegin: (a) => store.importBegin(kindOf(a.kind), infoOf(a.info)),
  importChunk: (a) => store.importChunk(intOf(a.generation, 1e12), intOf(a.startSeq, 1e12), rowsOf(a.rows, 5000)),
  importCommit: (a) => store.importCommit(kindOf(a.kind), intOf(a.generation, 1e12)),
  merchLookup: (a) => {
    if (!Array.isArray(a.items) || a.items.length > 500) fail("bad_request", "items");
    const items = a.items.map((it) => ({
      asin: textOf(it && it.asin, 40),
      marketplace: textOf(it && it.marketplace, 60),
      pageAsins: Array.isArray(it && it.pageAsins) ? it.pageAsins.slice(0, 8).map((x) => textOf(x, 40)) : [],
    }));
    return store.merchLookup(items);
  },
  ebayOwn: (a) => {
    if (!Array.isArray(a.items) || a.items.length > 500) fail("bad_request", "items");
    return store.ebayOwn(a.items.map((x) => textOf(x, 20)).filter((x) => /^\d{9,15}$/.test(x)));
  },
  salesSave: (a) => {
    if (!Array.isArray(a.rows) || a.rows.length > 50000) fail("bad_request", "rows");
    const n = (v) => (Number.isInteger(v) && v >= 0 && v <= 1e7 ? v : fail("bad_request", "units"));
    const rows = a.rows.map((r) => {
      if (!r || typeof r !== "object") fail("bad_request", "row");
      return { day: textOf(r.day, 10), marketplace: textOf(r.marketplace, 8), asin: textOf(r.asin, 20), sold: n(r.sold), cancelled: n(r.cancelled), returned: n(r.returned) };
    });
    return store.salesSave(textOf(a.account, 200) || fail("bad_request", "account"), textOf(a.from, 10), textOf(a.to, 10), textOf(a.keepFrom, 10), rows);
  },
  salesCoverage: () => ({ coverage: store.salesCoverage() }),
  bestSellers: (a) => store.bestSellers(textOf(a.from, 10), textOf(a.marketplace, 8), intOf(a.limit == null ? 50 : a.limit, 200)),
  cleanup: (a) => store.cleanup(intOf(a.budget == null ? 50000 : a.budget, 500000)),
  stats: () => ({ ...store.stats(), engine: { ...state } }),
  quickCheck: () => store.quickCheck(),
  rebuild: () => {
    if (state.state === "ready") fail("bad_request", "the database is fine");
    if (!pool) fail(state.code || "storage_unavailable");
    try { if (db) db.close(); } catch (e) {}
    db = null;
    store = null;
    pool.unlink(DB_FILE);
    openDb();
    state = { state: "ready", version: sqlite3.version.libVersion, sourceId: sqlite3.version.sourceId, vfs: "opfs-sahpool", rebuilt: true };
    return { ok: true };
  },
};

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  const id = msg.id;
  const op = typeof msg.op === "string" && Object.prototype.hasOwnProperty.call(OPS, msg.op) ? msg.op : null;
  await ready;
  try {
    if (!op) fail("bad_request", "unknown operation");
    if (op !== "status" && op !== "rebuild" && state.state !== "ready") fail(state.code || "storage_unavailable", state.message);
    const result = OPS[op](msg.args && typeof msg.args === "object" ? msg.args : {});
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    let code = e && e.code && typeof e.code === "string" && !/^SQLITE_/.test(e.code) ? e.code : CS.classify(e);
    if (code === "storage_io" || code === "storage_write") {
      try {
        const est = await navigator.storage.estimate();
        if (est && est.quota != null && est.quota - (est.usage || 0) < 16 * 1024 * 1024) code = "storage_full";
      } catch (e2) {}
    }
    if (code === "storage_corrupt") state = { state: "failed", code, message: "the catalog database can't be read" };
    self.postMessage({ id, ok: false, code, message: String((e && e.message) || e).slice(0, 300) });
  }
};
