(function (root) {
  "use strict";

  const DEFAULTS = Object.freeze({
    graceMs: 47 * 3600e3,
    recheckMs: 23 * 3600e3,
    skewMs: 10 * 60e3,
    rollbackMs: 10 * 60e3,
    highWaterStepMs: 5 * 60e3,
    timeoutMs: 15000,
    networkRetries: 2,
    retryDelaysMs: [1000, 3000],
    backoffMs: [60e3, 2 * 60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3, 60 * 60e3],
    forcedRecheckGapMs: 30e3,
    lockedRecheckGapMs: 23 * 3600e3,
    activateGapMs: 2000,
    activateWindowMs: 10 * 60e3,
    activateMaxInWindow: 8,
    keyMaxLength: 256,
  });

  const NEEDS_ACTIVATION = new Set(["NO_MACHINE", "NO_MACHINES", "FINGERPRINT_SCOPE_MISMATCH"]);

  const MESSAGES = {
    VALID: "Active",
    NO_KEY: "Enter your license key to start.",
    CHECKING: "Checking your license…",
    NEEDS_CHECK: "Your license needs to be checked online. Connect to the internet and open the Copycat Hunt menu.",
    OFFLINE: "Couldn't check your license for 2 days. Connect to the internet to keep using Copycat Hunt.",
    CLOCK: "Your computer's clock looks wrong. Set it to update automatically, then check your license again.",
    CRYPTO: "This version of Chrome can't check Copycat Hunt licenses. Update Chrome and try again.",
    NOT_FOUND: "That license key wasn't found. Check it and try again.",
    EXPIRED: "This license has expired. Renew it to keep using Copycat Hunt.",
    SUSPENDED: "This license is suspended. Contact support.",
    BANNED: "This license is blocked. Contact support.",
    OVERDUE: "This license needs to be checked online.",
    TOO_MANY_MACHINES: "This license is already in use on another computer. Contact support if you changed computers.",
    FINGERPRINT_SCOPE_MISMATCH: "This license is already in use on another computer. Contact support if you changed computers.",
    NO_MACHINE: "This computer isn't activated for this license. Enter your key again in the Copycat Hunt menu.",
    NO_MACHINES: "This computer isn't activated for this license. Enter your key again in the Copycat Hunt menu.",
    PRODUCT_SCOPE_MISMATCH: "This key is for a different product.",
    POLICY_SCOPE_MISMATCH: "This key is for a different plan.",
  };
  const message = (code) => MESSAGES[code] || "This license can't be used right now. Contact support.";

  function normalizeKey(raw) {
    if (typeof raw !== "string") return "";
    const k = raw.trim().replace(/\s+/g, "");
    return k;
  }

  function create(deps) {
    const V = deps.verify;
    const cfg = { ...DEFAULTS, ...(deps.config || {}) };
    const now = deps.now || (() => Date.now());
    const mono = deps.mono || (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const store = deps.store;
    const subtle = deps.subtle;
    const account = V.CONFIG.account;
    const VALIDATE_PATH = `/v1/accounts/${account}/licenses/actions/validate-key`;
    const MACHINES_PATH = `/v1/accounts/${account}/machines`;

    let keyPromise = null;
    let cryptoBroken = false;
    let fingerprint = null;
    let rec = null;
    let ver = null;
    let live = null;
    let rollback = false;
    let failed = null;
    let backoff = { n: 0, nextAt: 0 };
    let lastForced = -Infinity;
    let lastLockedCheck = -Infinity;
    let activations = [];
    let seq = 0;
    let gen = 0;
    let lock = Promise.resolve();
    let recheckInflight = null;
    let activateInflight = null;
    let ready = null;

    const withLock = (fn) => {
      const p = lock.then(fn, fn);
      lock = p.catch(() => {});
      return p;
    };

    function randomNonce() {
      const b = new Uint8Array(6);
      (deps.getRandomValues || ((a) => crypto.getRandomValues(a)))(b);
      let n = 0;
      for (const x of b) n = n * 256 + x;
      return n === 0 ? 1 : n;
    }

    function newFingerprint() {
      const b = new Uint8Array(16);
      (deps.getRandomValues || ((a) => crypto.getRandomValues(a)))(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }

    const validFp = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
    const validKey = (k) => typeof k === "string" && k.length >= 8 && k.length <= cfg.keyMaxLength && /^[A-Za-z0-9._+=/-]+$/.test(k);

    function getKey() {
      if (!keyPromise) {
        keyPromise = Promise.resolve()
          .then(() => V.importVerifyKey(subtle, deps.publicKey()))
          .catch((e) => {
            cryptoBroken = true;
            throw e;
          });
      }
      return keyPromise;
    }

    async function readCapped(res) {
      const len = Number(res.headers.get("content-length"));
      if (Number.isFinite(len) && len > V.MAX_BODY) throw new Error("too-large");
      if (!res.body || typeof res.body.getReader !== "function") {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length > V.MAX_BODY) throw new Error("too-large");
        return buf;
      }
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > V.MAX_BODY) {
          try { reader.cancel(); } catch (e) {}
          throw new Error("too-large");
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    }

    async function send(method, path, jsonBody, licenseKey) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      const headers = {
        Accept: "application/vnd.api+json",
        "Keygen-Accept-Signature": 'algorithm="ed25519"',
      };
      if (jsonBody) headers["Content-Type"] = "application/vnd.api+json";
      if (licenseKey) headers.Authorization = "License " + licenseKey;
      try {
        const res = await deps.fetch(V.CONFIG.origin + path, {
          method, headers, body: jsonBody ? JSON.stringify(jsonBody) : undefined,
          credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: ctrl.signal,
        });
        const body = await readCapped(res);
        return { status: res.status, headers: res.headers, body };
      } catch (e) {
        return { network: true, reason: e && e.name === "AbortError" ? "timeout" : e && e.message === "too-large" ? "too-large" : "network" };
      } finally {
        clearTimeout(timer);
      }
    }

    async function verified(method, path, r) {
      let key;
      try {
        key = await getKey();
      } catch (e) {
        return { ok: false, reason: "crypto" };
      }
      return V.verifyResponse({ subtle, key, method, path, headers: r.headers, body: r.body });
    }

    async function validateOnce(key, licenseId) {
      let attempt = 0;
      for (;;) {
        const nonce = randomNonce();
        const mySeq = ++seq;
        const body = { meta: { key, nonce, scope: { fingerprint, product: V.CONFIG.product } } };
        const r = await send("POST", VALIDATE_PATH, body);
        if (r.network) {
          if (attempt < cfg.networkRetries) {
            await sleep(cfg.retryDelaysMs[attempt] || 3000);
            attempt++;
            continue;
          }
          return { kind: "network", reason: r.reason };
        }
        const sig = await verified("POST", VALIDATE_PATH, r);
        if (!sig.ok) {
          if (sig.reason === "crypto") return { kind: "crypto" };
          if (sig.reason === "unsigned" && (r.status >= 500 || r.status === 429)) return { kind: "network", reason: "server" };
          if (sig.reason === "unsigned" && r.status === 404) return { kind: "suspicious", reason: "unsigned-404" };
          return { kind: "suspicious", reason: sig.reason };
        }
        const json = V.parseJson(r.body);
        if (r.status !== 200) {
          if (json && json.meta && json.meta.valid === true) return { kind: "suspicious", reason: "status" };
          if (r.status >= 500 || r.status === 429) return { kind: "network", reason: "server" };
        }
        const ev = V.evaluateValidation(json, { nonce, key, fingerprint, licenseId });
        if (!ev.ok) return { kind: "suspicious", reason: ev.reason };
        const evidence = {
          path: VALIDATE_PATH,
          status: r.status,
          date: r.headers.get("date"),
          digest: r.headers.get("digest"),
          signature: r.headers.get("keygen-signature"),
          body: V.b64encode(r.body),
          nonce,
        };
        return { kind: "verified", ev: { ...ev, signedAt: sig.signedAt }, evidence, seq: mySeq, receivedWall: now(), receivedMono: mono() };
      }
    }

    async function verifyStored(r) {
      if (!r || !r.evidence || !validKey(r.key)) return null;
      const e = r.evidence;
      if (e.path !== VALIDATE_PATH || !Number.isSafeInteger(e.nonce) || typeof e.body !== "string") return null;
      if (e.status !== 200 && e.status !== 404) return null;
      const body = V.b64decode(e.body);
      if (!body) return null;
      const headers = { get: (n) => ({ date: e.date, digest: e.digest, "keygen-signature": e.signature })[n.toLowerCase()] ?? null };
      const sig = await verified("POST", VALIDATE_PATH, { headers, body });
      if (!sig.ok) return null;
      const ev = V.evaluateValidation(V.parseJson(body), { nonce: e.nonce, key: r.key, fingerprint, licenseId: null });
      if (!ev.ok || (e.status !== 200 && ev.valid)) return null;
      return { ...ev, signedAt: sig.signedAt, seq: 0 };
    }

    function init(legacy) {
      if (!ready) ready = withLock(() => doInit(legacy || {}));
      return ready;
    }

    async function doInit(legacy) {
      try {
        await getKey();
      } catch (e) {
      }
      let install = null;
      try {
        install = await store.getInstall();
      } catch (e) {}
      if (install && validFp(install.fingerprint)) fingerprint = install.fingerprint;
      else {
        fingerprint = validFp(legacy.fingerprint) ? legacy.fingerprint : newFingerprint();
        await store.putInstall({ v: 1, fingerprint });
      }
      try {
        rec = await store.getLicense();
      } catch (e) {
        rec = null;
      }
      if (!rec || typeof rec !== "object" || rec.v !== 2 || !validKey(rec.key)) {
        rec = null;
        const k = normalizeKey(legacy.key);
        if (validKey(k)) {
          rec = { v: 2, key: k, licenseId: null, evidence: null, highWater: 0 };
          await store.putLicense(rec);
        }
      }
      ver = rec ? await verifyStored(rec) : null;
      if (rec && ver && !ver.valid && ver.licenseId) rec.licenseId = ver.licenseId;
      if (rec && ver && ver.licenseId) rec.licenseId = ver.licenseId;
      if (rec && !Number.isFinite(rec.highWater)) rec.highWater = 0;
      notify();
    }

    function decide() {
      if (cryptoBroken) return { ok: false, code: "CRYPTO" };
      if (!rec || !rec.key) return { ok: false, code: "NO_KEY" };
      if (!ver) return { ok: false, code: rec.evidence ? "NEEDS_CHECK" : "CHECKING" };
      if (!ver.valid) return { ok: false, code: ver.code };
      const t = now();
      if (live && t < live.wall + (mono() - live.mono) - cfg.rollbackMs) rollback = true;
      if (rollback) return { ok: false, code: "CLOCK" };
      if (rec.highWater && t < rec.highWater - cfg.rollbackMs) return { ok: false, code: "CLOCK" };
      let age = t - ver.signedAt;
      if (age < -cfg.skewMs) return { ok: false, code: "CLOCK" };
      if (live && live.signedAt === ver.signedAt) age = Math.max(age, mono() - live.mono);
      if (age > cfg.graceMs) return { ok: false, code: "OFFLINE" };
      if (ver.expiry !== null && Math.max(t, ver.signedAt) >= ver.expiry) return { ok: false, code: "EXPIRED" };
      return { ok: true, code: "VALID", due: age > cfg.recheckMs };
    }

    function sanitized(full) {
      const d = decide();
      const out = { ok: d.ok, code: d.code, message: message(d.code) };
      if (full) {
        out.hasKey = !!(rec && rec.key);
        out.name = d.ok && ver ? ver.name || "" : "";
        out.expiry = d.ok && ver && ver.expiry !== null ? new Date(ver.expiry).toISOString() : null;
        out.checkFailed = !!(d.ok && failed);
        out.canRecheck = out.hasKey;
      }
      return out;
    }

    function notify() {
      if (deps.onChange) {
        try { deps.onChange(sanitized(false)); } catch (e) {}
      }
    }

    async function commit(key, res, extra) {
      return withLock(async () => {
        if (extra && extra.startGen !== undefined && extra.startGen !== gen && (!rec || rec.key !== key)) return false;
        const cur = rec && rec.key === key ? ver : null;
        if (cur && (res.ev.signedAt < cur.signedAt || (res.ev.signedAt === cur.signedAt && res.seq <= (cur.seq || 0)))) return false;
        const next = {
          v: 2,
          key,
          licenseId: res.ev.licenseId || (rec && rec.key === key ? rec.licenseId : null),
          evidence: res.evidence,
          highWater: Math.max(rec && rec.key === key ? rec.highWater || 0 : 0, 0),
        };
        if (Math.abs(res.ev.signedAt - res.receivedWall) <= cfg.skewMs) next.highWater = res.receivedWall;
        await store.putLicense(next);
        rec = next;
        ver = { ...res.ev, seq: res.seq };
        live = { wall: res.receivedWall, mono: res.receivedMono, signedAt: res.ev.signedAt };
        rollback = false;
        gen++;
        if (extra && extra.clearFailure) failed = null;
        notify();
        return true;
      });
    }

    function noteFailure(kind) {
      failed = { at: now(), kind };
      const step = cfg.backoffMs[Math.min(backoff.n, cfg.backoffMs.length - 1)];
      backoff = { n: backoff.n + 1, nextAt: mono() + step };
      notify();
    }

    async function bumpHighWater() {
      if (!rec) return;
      const t = now();
      if (t > (rec.highWater || 0) + cfg.highWaterStepMs && !rollback) {
        await withLock(async () => {
          if (!rec) return;
          rec = { ...rec, highWater: Math.max(rec.highWater || 0, t) };
          await store.putLicense(rec);
        });
      }
    }

    async function recheck(opts) {
      await init();
      const force = !!(opts && opts.force);
      if (!rec || !rec.key) return sanitized(true);
      if (force) {
        if (mono() - lastForced < cfg.forcedRecheckGapMs) return { ...sanitized(true), throttled: true };
        lastForced = mono();
      } else if (mono() < backoff.nextAt) {
        return sanitized(true);
      }
      if (recheckInflight) return recheckInflight;
      const key = rec.key;
      const licenseId = rec.licenseId;
      const startGen = gen;
      recheckInflight = (async () => {
        const r = await validateOnce(key, licenseId);
        if (r.kind === "verified") {
          backoff = { n: 0, nextAt: 0 };
          await commit(key, r, { clearFailure: true, startGen });
        } else if (r.kind === "crypto") {
          cryptoBroken = true;
          notify();
        } else {
          noteFailure(r.kind);
        }
        return sanitized(true);
      })().finally(() => {
        recheckInflight = null;
      });
      return recheckInflight;
    }

    async function activate(raw) {
      await init();
      const key = normalizeKey(raw);
      if (!validKey(key)) return { ok: false, error: "bad-key", message: "That doesn't look like a license key. Copy it again from your email." };
      const t = mono();
      activations = activations.filter((x) => t - x < cfg.activateWindowMs);
      if (activations.length && t - activations[activations.length - 1] < cfg.activateGapMs) return { ok: false, error: "throttled", message: "Please wait a moment and try again." };
      if (activations.length >= cfg.activateMaxInWindow) return { ok: false, error: "throttled", message: "Too many attempts. Wait a few minutes and try again." };
      if (activateInflight) return { ok: false, error: "busy", message: "Already checking a key." };
      activations.push(t);
      activateInflight = doActivate(key).finally(() => {
        activateInflight = null;
      });
      return activateInflight;
    }

    async function doActivate(key) {
      const current = rec && rec.key === key;
      const r1 = await validateOnce(key, current ? rec.licenseId : null);
      const fail = (kind) =>
        kind === "network"
          ? { ok: false, error: "offline", message: "Couldn't reach the license server. Check your internet connection." }
          : kind === "crypto"
            ? { ok: false, error: "crypto", message: message("CRYPTO") }
            : { ok: false, error: "unverified", message: "Couldn't verify the license server's answer. Try again later." };
      if (r1.kind === "suspicious" && r1.reason === "unsigned-404" && !current) {
        return { ok: false, error: "NOT_FOUND", message: message("NOT_FOUND") };
      }
      if (r1.kind !== "verified") return fail(r1.kind);
      if (r1.ev.valid) {
        await commit(key, r1, { clearFailure: true });
        return { ok: true, status: sanitized(true) };
      }
      if (NEEDS_ACTIVATION.has(r1.ev.code) && r1.ev.licenseId) {
        const body = { data: { type: "machines", attributes: { fingerprint, name: "Copycat Hunt (Chrome)" }, relationships: { license: { data: { type: "licenses", id: r1.ev.licenseId } } } } };
        const m = await send("POST", MACHINES_PATH, body, key);
        if (m.network) return fail("network");
        const sig = await verified("POST", MACHINES_PATH, m);
        if (!sig.ok) return fail(sig.reason === "crypto" ? "crypto" : m.status >= 500 ? "network" : "suspicious");
        const mr = V.evaluateMachine(m.status, V.parseJson(m.body), { fingerprint, licenseId: r1.ev.licenseId });
        if (!mr.ok) return fail("suspicious");
        if (mr.limit) {
          if (current) await commit(key, r1, {});
          return { ok: false, error: "in-use", message: message("TOO_MANY_MACHINES") };
        }
        if (!mr.created && !mr.taken) return { ok: false, error: "activate", message: "Couldn't activate this computer. Contact support." };
        const r2 = await validateOnce(key, r1.ev.licenseId);
        if (r2.kind !== "verified") return fail(r2.kind);
        if (r2.ev.valid) {
          await commit(key, r2, { clearFailure: true });
          return { ok: true, status: sanitized(true) };
        }
        if (current) await commit(key, r2, {});
        return { ok: false, error: r2.ev.code, message: message(r2.ev.code) };
      }
      if (current) await commit(key, r1, {});
      return { ok: false, error: r1.ev.code, message: message(r1.ev.code) };
    }

    async function authorize() {
      await init();
      let d = decide();
      if (d.ok) {
        bumpHighWater().catch(() => {});
        if (d.due) recheck().catch(() => {});
        return { ok: true };
      }
      if (rec && rec.key && ["OFFLINE", "NEEDS_CHECK", "CHECKING", "CLOCK"].includes(d.code)) {
        await recheck();
        d = decide();
        if (d.ok) return { ok: true };
      } else if (rec && rec.key && !cryptoBroken && d.code !== "NO_KEY" && mono() - lastLockedCheck > cfg.lockedRecheckGapMs) {
        lastLockedCheck = mono();
        recheck().catch(() => {});
      }
      return { ok: false, code: d.code, message: message(d.code) };
    }

    async function serverEvidence(opts) {
      await init();
      let d = decide();
      if (d.ok && ver && now() - ver.signedAt > cfg.recheckMs) {
        await recheck(opts && opts.force ? { force: true } : undefined);
        d = decide();
      } else if (d.ok && opts && opts.force) {
        await recheck({ force: true });
        d = decide();
      }
      if (!d.ok || !rec || !rec.evidence || !ver || !ver.valid) return null;
      const e = rec.evidence;
      return { status: e.status, date: e.date, digest: e.digest, signature: e.signature, body: e.body };
    }

    async function status(full) {
      await init();
      return sanitized(full);
    }

    return { init, status, authorize, activate, recheck, serverEvidence, decide: () => decide() };
  }

  const api = Object.freeze({ create, DEFAULTS, MESSAGES, message, normalizeKey });
  root.EifLicenseService = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
