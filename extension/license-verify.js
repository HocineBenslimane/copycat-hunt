(function (root) {
  "use strict";
  // Keygen response verification (service worker only).
  //
  // Every answer from Keygen that can unlock Copycat Hunt must carry a valid
  // Keygen-Signature (Ed25519, draft-cavage HTTP signatures) made with our
  // account's key. The signature covers the request target, host, date and a
  // SHA-256 digest of the exact response bytes. Validation answers must also
  // echo the random nonce we sent and name our license, product and
  // installation fingerprint. Nothing here trusts parsed JSON before the
  // signature over the raw bytes has been checked.
  //
  // The public key is pinned. It is stored split and mixed with filler bytes
  // only to make a search-and-replace a little slower; it is not secret and
  // this is not the protection. The protection is the signature check.

  const CONFIG = Object.freeze({
    account: "c10a006b-77be-4206-908b-89a0b691210e",
    product: "e063318f-88d2-4fd0-b99f-109f58cf29c9",
    host: "api.keygen.sh",
    origin: "https://api.keygen.sh",
    algorithm: "ed25519",
    signedHeaders: "(request-target) host date digest",
  });

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const CODE_RE = /^[A-Z][A-Z_]{1,59}$/;
  const MAX_BODY = 256 * 1024;

  // ---- pinned key ------------------------------------------------------------
  // First half: real bytes at even positions, filler at odd positions.
  const KP_A = [194, 96, 201, 22, 115, 186, 102, 165, 12, 191, 236, 158, 100, 182, 238, 200,
    227, 4, 187, 222, 128, 254, 225, 122, 81, 5, 197, 152, 237, 123, 64, 93];
  // Second half: five filler bytes, then the real bytes in reverse order.
  const KP_B = [10, 181, 49, 165, 45, 205, 169, 105, 179, 209, 3, 107, 86, 26, 209, 211,
    76, 80, 18, 177, 23];

  function reconstructPinnedKey(a, b) {
    a = a || KP_A;
    b = b || KP_B;
    const first = a.filter((_, i) => i % 2 === 0);
    const second = b.slice(5).reverse();
    const out = new Uint8Array(first.length + second.length);
    out.set(first, 0);
    out.set(second, first.length);
    if (out.length !== 32) throw new Error("key-length");
    return out;
  }

  // ---- small strict helpers --------------------------------------------------
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

  function isoMs(v) {
    // Keygen sends ISO 8601 UTC times such as 2026-11-06T16:00:59.386Z.
    if (typeof v !== "string" || v.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(v)) return NaN;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : NaN;
  }

  function httpDateMs(v) {
    // RFC 7231 IMF-fixdate, e.g. "Wed, 09 Jun 2021 16:08:15 GMT".
    if (typeof v !== "string" || !/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(v)) return NaN;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : NaN;
  }

  function b64encode(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function b64decode(str) {
    if (typeof str !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(str) || str.length % 4 !== 0) return null;
    try {
      const bin = atob(str);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) {
      return null;
    }
  }

  // keyid="…", algorithm="…", signature="…", headers="…" — each exactly once.
  function parseSignatureHeader(h) {
    if (typeof h !== "string" || !h || h.length > 2048) return null;
    const out = {};
    const parts = h.split(",");
    for (const raw of parts) {
      const m = raw.trim().match(/^([a-z]+)="([^"]*)"$/);
      if (!m) return null;
      if (Object.prototype.hasOwnProperty.call(out, m[1])) return null;
      out[m[1]] = m[2];
    }
    for (const k of ["keyid", "algorithm", "signature", "headers"]) if (typeof out[k] !== "string") return null;
    return out;
  }

  function signingString(method, path, host, date, digest) {
    return `(request-target): ${method.toLowerCase()} ${path}\nhost: ${host}\ndate: ${date}\ndigest: ${digest}`;
  }

  function importVerifyKey(subtle, raw) {
    if (!subtle || typeof subtle.importKey !== "function") return Promise.reject(new Error("no-webcrypto"));
    if (!(raw instanceof Uint8Array) || raw.length !== 32) return Promise.reject(new Error("bad-key"));
    return subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  }

  // Verifies one HTTP response. `headers` must offer get(name).
  async function verifyResponse({ subtle, key, method, path, headers, body, account, host }) {
    account = account || CONFIG.account;
    host = host || CONFIG.host;
    if (!key) return { ok: false, reason: "no-key" };
    if (!(body instanceof Uint8Array) || body.length > MAX_BODY) return { ok: false, reason: "body" };
    const sig = parseSignatureHeader(headers.get("keygen-signature"));
    if (!sig) return { ok: false, reason: "unsigned" };
    if (sig.keyid !== account) return { ok: false, reason: "keyid" };
    if (sig.algorithm !== CONFIG.algorithm) return { ok: false, reason: "algorithm" };
    if (sig.headers !== CONFIG.signedHeaders) return { ok: false, reason: "headers" };
    const date = headers.get("date");
    const dateMs = httpDateMs(date);
    if (!Number.isFinite(dateMs)) return { ok: false, reason: "date" };
    const digest = headers.get("digest");
    if (typeof digest !== "string" || !/^sha-256=[A-Za-z0-9+/]{43}=$/.test(digest)) return { ok: false, reason: "digest-format" };
    const computed = "sha-256=" + b64encode(new Uint8Array(await subtle.digest("SHA-256", body)));
    if (computed !== digest) return { ok: false, reason: "digest" };
    const sigBytes = b64decode(sig.signature);
    if (!sigBytes || sigBytes.length !== 64) return { ok: false, reason: "signature-format" };
    const data = new TextEncoder().encode(signingString(method, path, host, date, digest));
    let good = false;
    try {
      good = await subtle.verify({ name: "Ed25519" }, key, sigBytes, data);
    } catch (e) {
      good = false;
    }
    if (good !== true) return { ok: false, reason: "signature" };
    return { ok: true, signedAt: dateMs };
  }

  function parseJson(body) {
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch (e) {
      return undefined;
    }
  }

  function relId(obj, name) {
    const r = isObj(obj.relationships) && isObj(obj.relationships[name]) ? obj.relationships[name] : null;
    return r && isObj(r.data) && typeof r.data.id === "string" ? r.data.id : null;
  }

  // A signed validate-key answer → what it says about our license.
  function evaluateValidation(json, expect) {
    const { nonce, key, fingerprint, licenseId } = expect;
    const product = expect.product || CONFIG.product;
    const account = expect.account || CONFIG.account;
    if (!isObj(json) || !isObj(json.meta)) return { ok: false, reason: "structure" };
    const m = json.meta;
    if (!Number.isSafeInteger(nonce) || m.nonce !== nonce) return { ok: false, reason: "nonce" };
    if (typeof m.valid !== "boolean") return { ok: false, reason: "valid-type" };
    if (typeof m.code !== "string" || !CODE_RE.test(m.code)) return { ok: false, reason: "code" };
    if (!isObj(m.scope) || m.scope.fingerprint !== fingerprint || m.scope.product !== product) return { ok: false, reason: "scope" };
    const ts = isoMs(m.ts);
    if (!Number.isFinite(ts)) return { ok: false, reason: "ts" };
    if (m.valid !== (m.code === "VALID")) return { ok: false, reason: "valid-code" };
    const d = json.data;
    if (d === null || d === undefined) {
      if (m.valid) return { ok: false, reason: "data" };
      return { ok: true, valid: false, code: m.code, licenseId: null, expiry: null, name: "", ts };
    }
    if (!isObj(d) || d.type !== "licenses" || !isUuid(d.id) || !isObj(d.attributes)) return { ok: false, reason: "data" };
    if (licenseId && d.id !== licenseId) return { ok: false, reason: "license" };
    if (d.attributes.key !== key) return { ok: false, reason: "key" };
    if (relId(d, "account") !== account) return { ok: false, reason: "account" };
    if (relId(d, "product") !== product) return { ok: false, reason: "product" };
    const exp = d.attributes.expiry;
    let expiry = null;
    if (exp !== null && exp !== undefined) {
      expiry = isoMs(exp);
      if (!Number.isFinite(expiry)) return { ok: false, reason: "expiry" };
    }
    const nm = d.attributes.name;
    if (nm !== null && nm !== undefined && (typeof nm !== "string" || nm.length > 200)) return { ok: false, reason: "name" };
    return { ok: true, valid: m.valid, code: m.code, licenseId: d.id, expiry, name: typeof nm === "string" ? nm : "", ts };
  }

  // A signed POST /machines answer.
  function evaluateMachine(status, json, expect) {
    if (status === 201 || status === 200) {
      if (!isObj(json) || !isObj(json.data)) return { ok: false, reason: "structure" };
      const d = json.data;
      if (d.type !== "machines" || !isUuid(d.id) || !isObj(d.attributes)) return { ok: false, reason: "data" };
      if (d.attributes.fingerprint !== expect.fingerprint) return { ok: false, reason: "fingerprint" };
      if (relId(d, "license") !== expect.licenseId) return { ok: false, reason: "license" };
      return { ok: true, created: true, machineId: d.id };
    }
    if (status === 422 && isObj(json) && Array.isArray(json.errors) && json.errors.length && json.errors.length <= 20) {
      const text = json.errors.map((e) => (isObj(e) ? `${String(e.code || "")} ${String(e.detail || "")}` : "")).join(" ");
      if (/LIMIT_EXCEEDED|exceeded maximum/i.test(text)) return { ok: true, created: false, limit: true };
      if (/FINGERPRINT_TAKEN|has already been taken/i.test(text)) return { ok: true, created: false, taken: true };
      return { ok: true, created: false };
    }
    return { ok: false, reason: "status" };
  }

  const api = Object.freeze({
    CONFIG, MAX_BODY, reconstructPinnedKey, parseSignatureHeader, signingString, importVerifyKey,
    verifyResponse, parseJson, evaluateValidation, evaluateMachine, isoMs, httpDateMs, b64encode, b64decode, isUuid,
  });
  root.EifLicenseVerify = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
