(function (root) {
  "use strict";
  const DB = "eif-credentials";
  const STORE = "kv";

  function open(idb) {
    return new Promise((resolve, reject) => {
      const req = idb.open(DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("idb-open"));
      req.onblocked = () => reject(new Error("idb-blocked"));
    });
  }

  function create(idb) {
    let dbp = null;
    const db = () => (dbp = dbp || open(idb).catch((e) => { dbp = null; throw e; }));
    const tx = (mode, fn) =>
      db().then(
        (d) =>
          new Promise((resolve, reject) => {
            const t = d.transaction(STORE, mode);
            const s = t.objectStore(STORE);
            let out;
            const r = fn(s);
            if (r) r.onsuccess = () => (out = r.result);
            t.oncomplete = () => resolve(out);
            t.onerror = () => reject(t.error || new Error("idb-tx"));
            t.onabort = () => reject(t.error || new Error("idb-abort"));
          })
      );
    const get = (k) => tx("readonly", (s) => s.get(k));
    const put = (k, v) => tx("readwrite", (s) => s.put(v, k)).then(() => undefined);
    const del = (k) => tx("readwrite", (s) => s.delete(k)).then(() => undefined);
    return {
      getInstall: () => get("install"),
      putInstall: (v) => put("install", v),
      getLicense: () => get("license"),
      putLicense: (v) => put("license", v),
      deleteLicense: () => del("license"),
    };
  }

  const api = Object.freeze({ create });
  root.EifLicenseStore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
