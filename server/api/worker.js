// Copycat Hunt API (Cloudflare Worker).
//
// Runs the listing-text hijack comparison ("Full hijack", "Title copied",
// "Bullets copied"…) on the server, so a copy of the extension with its
// license checks removed doesn't get it. The extension proves its license by
// sending the signed Keygen validation answer it already has; this Worker
// checks that signature with the account's public Ed25519 key. No Keygen
// admin/product tokens and no Keygen calls from here. One secret since 1.2.0:
// GCP_SA_KEY, a Google key that can only call the copycat-vision scorer.
//
// Endpoints
//   GET  /v1/health   → { ok, version }
//   POST /v1/compare  → { ok, common: [...], results: { id: result } }
//   POST /v1/score    → { ok, original, timing, results: [{ id, status, rank, source, signals }] }
//
// Deploy: paste this file into a Cloudflare Worker (module syntax). See
// README.md next to it.

const VERSION = "1.3.0"; // 1.1.0: signed answers accepted up to 48 h old; 1.2.0: /v1/score; 1.3.0: drawing/text signals
const ACCOUNT = "c10a006b-77be-4206-908b-89a0b691210e";
const PRODUCT = "e063318f-88d2-4fd0-b99f-109f58cf29c9";
const PUBLIC_KEY_HEX = "c2c973660cec64eee3bb80e151c5ed4017b112504cd3d11a566b03d1b369a9cd"; // public, not a secret
const VALIDATE_PATH = `/v1/accounts/${ACCOUNT}/licenses/actions/validate-key`;
const MAX_EVIDENCE_AGE_MS = 48 * 3600e3; // the extension re-checks once a day (23 h) and locks after 47 h
const FUTURE_SKEW_MS = 10 * 60e3;
const MAX_BODY = 512 * 1024;
const MAX_OTHERS = 60;
const MAX_TITLES = 200;
const RATE_WINDOW_MS = 10 * 60e3;
const RATE_MAX = 120; // compare calls per license per 10 min (per Worker instance)

// ---------------------------------------------------------------------------
// Keygen evidence check (same rules as the extension's license-verify.js,
// minus the nonce, which only the extension knows).
let keyPromise = null;
function hexBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function importKey() {
  if (!keyPromise) {
    const raw = hexBytes(PUBLIC_KEY_HEX);
    keyPromise = crypto.subtle
      .importKey("raw", raw, { name: "Ed25519" }, false, ["verify"])
      .catch(() => crypto.subtle.importKey("raw", raw, { name: "NODE-ED25519", namedCurve: "NODE-ED25519" }, false, ["verify"]));
  }
  return keyPromise;
}
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function b64encode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64decode(str) {
  if (typeof str !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(str) || str.length % 4) return null;
  try {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) {
    return null;
  }
}
function parseSig(h) {
  if (typeof h !== "string" || h.length > 2048) return null;
  const out = {};
  for (const raw of h.split(",")) {
    const m = raw.trim().match(/^([a-z]+)="([^"]*)"$/);
    if (!m || Object.prototype.hasOwnProperty.call(out, m[1])) return null;
    out[m[1]] = m[2];
  }
  return ["keyid", "algorithm", "signature", "headers"].every((k) => typeof out[k] === "string") ? out : null;
}
const isoMs = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(v) ? Date.parse(v) : NaN);
const httpDateMs = (v) => (typeof v === "string" && /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(v) ? Date.parse(v) : NaN);
const relId = (o, n) => (isObj(o.relationships) && isObj(o.relationships[n]) && isObj(o.relationships[n].data) ? o.relationships[n].data.id : null);

// → { ok: true, licenseId, fingerprint, signedAt } or { ok: false, reason }
async function verifyEvidence(ev, now) {
  if (!isObj(ev) || ev.status !== 200) return { ok: false, reason: "evidence" };
  const body = b64decode(ev.body);
  if (!body || body.length > 256 * 1024) return { ok: false, reason: "evidence" };
  const sig = parseSig(ev.signature);
  if (!sig || sig.keyid !== ACCOUNT || sig.algorithm !== "ed25519" || sig.headers !== "(request-target) host date digest") return { ok: false, reason: "signature" };
  const signedAt = httpDateMs(ev.date);
  if (!Number.isFinite(signedAt)) return { ok: false, reason: "date" };
  if (typeof ev.digest !== "string" || ev.digest !== "sha-256=" + b64encode(new Uint8Array(await crypto.subtle.digest("SHA-256", body)))) return { ok: false, reason: "digest" };
  const sigBytes = b64decode(sig.signature);
  if (!sigBytes || sigBytes.length !== 64) return { ok: false, reason: "signature" };
  const data = new TextEncoder().encode(`(request-target): post ${VALIDATE_PATH}\nhost: api.keygen.sh\ndate: ${ev.date}\ndigest: ${ev.digest}`);
  let good = false;
  try {
    const key = await importKey();
    good = await crypto.subtle.verify(key.algorithm, key, sigBytes, data);
  } catch (e) {
    good = false;
  }
  if (!good) return { ok: false, reason: "signature" };
  if (signedAt > now + FUTURE_SKEW_MS) return { ok: false, reason: "date" };
  if (now - signedAt > MAX_EVIDENCE_AGE_MS) return { ok: false, reason: "stale" };
  let json;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (e) {
    return { ok: false, reason: "evidence" };
  }
  const m = isObj(json) && isObj(json.meta) ? json.meta : null;
  const d = isObj(json) && isObj(json.data) ? json.data : null;
  if (!m || !d || m.valid !== true || m.code !== "VALID") return { ok: false, reason: "not-valid" };
  if (!isObj(m.scope) || m.scope.product !== PRODUCT || typeof m.scope.fingerprint !== "string" || !m.scope.fingerprint) return { ok: false, reason: "scope" };
  if (d.type !== "licenses" || !UUID_RE.test(d.id || "") || !isObj(d.attributes)) return { ok: false, reason: "evidence" };
  if (relId(d, "account") !== ACCOUNT || relId(d, "product") !== PRODUCT) return { ok: false, reason: "scope" };
  if (d.attributes.expiry !== null && d.attributes.expiry !== undefined) {
    const exp = isoMs(d.attributes.expiry);
    if (!Number.isFinite(exp) || now >= exp) return { ok: false, reason: "expired" };
  }
  return { ok: true, licenseId: d.id, fingerprint: m.scope.fingerprint, signedAt };
}

// ---------------------------------------------------------------------------
// Listing-text comparison (moved here from the extension in v3.14.0).
const BOILERPLATE = [
  /^lightweight,? classic fit,? double-needle sleeve and bottom hem/i,
  /^solid colors?:? \d+% cotton/i,
  /^heather grey:? \d+% cotton/i,
  /^(machine wash|imported|pull on closure|classic fit|8\.5 oz|this premium t-shirt)/i,
  /^\d+% (cotton|polyester)/i,
];
const STOP = new Set("a an and the of to for with in on at by from or is it i m im my me you your this that are be as t shirt shirts tshirt tee tees top tops funny gift gifts men mens women womens kids boys girls youth adult novelty graphic".split(" "));
function words(s) {
  return String(s || "").toLowerCase().replace(/[’'`]/g, "").replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean);
}
const keyWords = (s) => words(s).filter((w) => !STOP.has(w) && w.length > 1);
function isBoilerplate(line) {
  const l = String(line || "").trim();
  return !l || BOILERPLATE.some((re) => re.test(l)) || words(l).length < 6;
}
function grams(list, n = 3) {
  const out = new Set();
  if (list.length && list.length < n) out.add(list.join(" "));
  for (let i = 0; i + n <= list.length; i++) out.add(list.slice(i, i + n).join(" "));
  return out;
}
function containment(mine, theirs, skip) {
  let total = 0, hit = 0;
  mine.forEach((g) => {
    if (skip && skip.has(g)) return;
    total++;
    if (theirs.has(g)) hit++;
  });
  return total ? hit / total : 0;
}
const brandKey = (b) => String(b || "").toLowerCase().replace(/^visit the\s+|\s+store$/g, "").replace(/[^a-z0-9]/g, "");
function oneEditApart(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
// Title 3-word runs most look-alikes share (the slogan on the design).
function commonTitleGrams(mineTitle, others) {
  const mine = grams(keyWords(mineTitle));
  const list = (others || []).filter(Boolean).map((t) => grams(keyWords(t)));
  const common = new Set();
  if (list.length < 8) return common;
  mine.forEach((g) => {
    if (list.filter((s) => s.has(g)).length / list.length >= 0.5) common.add(g);
  });
  return common;
}
// category: "full" | "title" | "part" | ""
function compareListingText(mine, theirs, commonGrams) {
  const out = { title: {}, brand: {}, bullets: {}, description: {}, category: "", copied: [] };
  const mk = keyWords(mine.title), tk = keyWords(theirs.title);
  const mg = grams(mk), tg = grams(tk);
  const tset = new Set(tk);
  const wordShare = mk.length ? mk.filter((w) => tset.has(w)).length / mk.length : 0;
  const gramShare = containment(mg, tg);
  const score = 0.5 * wordShare + 0.5 * gramShare;
  const own = containment(mg, tg, commonGrams);
  const ownCount = [...mg].filter((g) => !(commonGrams && commonGrams.has(g))).length;
  out.title = { score, own, ownCount, copied: !!mk.length && (score >= 0.85 || (ownCount >= 2 && own >= 0.5 && score >= 0.5)) };
  const mb = brandKey(mine.brand), tb = brandKey(theirs.brand);
  out.brand = { present: mb.length >= 2, copied: mb.length >= 2 && !!tb && (mb === tb || (mb.length >= 4 && oneEditApart(mb, tb))) };
  const myBullets = (mine.bullets || []).filter((b) => !isBoilerplate(b));
  const theirGrams = grams(keyWords((theirs.bullets || []).join(" . ") + " . " + (theirs.description || "")));
  const hits = myBullets.filter((b) => containment(grams(keyWords(b)), theirGrams) >= 0.6).length;
  out.bullets = { present: myBullets.length > 0, total: myBullets.length, copiedCount: hits, copied: hits > 0 };
  const md = keyWords(mine.description);
  const descGrams = grams(keyWords((theirs.description || "") + " . " + (theirs.bullets || []).join(" . ")));
  const dShare = md.length >= 8 ? containment(grams(md), descGrams) : 0;
  out.description = { present: md.length >= 8, share: dShare, copied: md.length >= 8 && dShare >= 0.5 };
  const others = ["brand", "bullets", "description"].filter((f) => out[f].present);
  const copiedOthers = others.filter((f) => out[f].copied);
  out.copied = [...(out.title.copied ? ["title"] : []), ...copiedOthers];
  if (out.title.copied && others.length >= 2 && copiedOthers.length === others.length) out.category = "full";
  else if (out.title.copied) out.category = "title";
  else if (copiedOthers.length) out.category = "part";
  return out;
}

// ---------------------------------------------------------------------------
// Input cleaning
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
function cleanListing(L) {
  if (!isObj(L)) return null;
  return {
    title: str(L.title, 400),
    brand: str(L.brand, 120),
    bullets: Array.isArray(L.bullets) ? L.bullets.slice(0, 10).map((b) => str(b, 600)) : [],
    description: str(L.description, 2000),
  };
}

const rate = new Map(); // licenseId → [timestamps]
function rateLimited(id, now) {
  const list = (rate.get(id) || []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  rate.set(id, list);
  if (rate.size > 5000) rate.clear();
  return list.length > RATE_MAX;
}

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });

async function handleCompare(request, now) {
  if ((request.headers.get("content-type") || "").split(";")[0].trim() !== "application/json") return json(415, { error: "content-type" });
  const len = Number(request.headers.get("content-length"));
  if (Number.isFinite(len) && len > MAX_BODY) return json(413, { error: "too-large" });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { error: "too-large" });
  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    return json(400, { error: "json" });
  }
  if (!isObj(input)) return json(400, { error: "input" });
  const lic = await verifyEvidence(input.evidence, now);
  if (!lic.ok) return json(401, { error: "license", reason: lic.reason });
  if (rateLimited(lic.licenseId, now)) return json(429, { error: "rate-limited" });
  const mine = cleanListing(input.mine);
  const others = Array.isArray(input.others) ? input.others.slice(0, MAX_OTHERS + 1) : null;
  if (!mine || !others || others.length > MAX_OTHERS) return json(400, { error: "input" });
  const titles = Array.isArray(input.titles) ? input.titles.slice(0, MAX_TITLES).map((t) => str(t, 400)) : [];
  const common = commonTitleGrams(mine.title, titles);
  const results = {};
  for (const o of others) {
    if (!isObj(o) || typeof o.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(o.id)) continue;
    const L = cleanListing(o);
    if (L) results[o.id] = compareListingText(mine, L, common);
  }
  console.log(JSON.stringify({ at: new Date(now).toISOString(), route: "compare", license: lic.licenseId.slice(0, 8), fp: lic.fingerprint.slice(0, 8), n: Object.keys(results).length, country: (request.cf && request.cf.country) || "" }));
  return json(200, { ok: true, common: [...common], results });
}

// ---------------------------------------------------------------------------
// 1.2.0: image scores. The extension sends the design and the result photos;
// this Worker checks the license, then asks copycat-vision on Google Cloud
// Run (no public access) with a Google ID token made from the secret
// GCP_SA_KEY. That key can only call the scorer (Cloud Run Invoker on that
// one service). No image bytes, URLs or results are logged.
const SCORER_URL = "https://copycat-vision-308672515367.europe-west1.run.app";
const SCORE_MAX_BODY = 3_000_000; // same limit as the scorer
const SCORE_MAX_CANDIDATES = 70;
const SCORE_TIMEOUT_MS = 60_000;
const SCORE_RATE_MAX = 30; // scoring calls per license per 10 min (per Worker instance)
const IMAGE_HOSTS = ["m.media-amazon.com", "i.ebayimg.com"];
const scoreRate = new Map();

function imageUrlOk(u) {
  if (typeof u !== "string" || u.length > 2048) return false;
  try {
    const x = new URL(u);
    return x.protocol === "https:" && IMAGE_HOSTS.includes(x.hostname) && !x.username && !x.password && !x.port;
  } catch (e) {
    return false;
  }
}

function cleanScoreInput(input) {
  const o = input.original;
  let original = null;
  if (isObj(o) && o.kind === "url" && imageUrlOk(o.url)) original = { kind: "url", url: o.url };
  else if (isObj(o) && o.kind === "png" && typeof o.dataBase64 === "string" && o.dataBase64.length <= 2_900_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(o.dataBase64)) original = { kind: "png", dataBase64: o.dataBase64 };
  if (!original || !Array.isArray(input.candidates) || !input.candidates.length || input.candidates.length > SCORE_MAX_CANDIDATES) return null;
  const candidates = [];
  const seen = new Set();
  for (const c of input.candidates) {
    if (!isObj(c) || typeof c.id !== "string" || !/^(amazon|ebay):[A-Za-z0-9]{1,20}$/.test(c.id) || !imageUrlOk(c.url) || seen.has(c.id)) return null;
    seen.add(c.id);
    candidates.push({ id: c.id, url: c.url });
  }
  return { original, candidates, options: { includeDiagnostics: false } };
}

// Google ID token for the scorer, from the service account key (RS256 JWT
// exchanged at Google's token endpoint). Kept in memory ~50 min.
let gToken = null; // { token, until }
const b64url = (bytes) => b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (s) => b64url(new TextEncoder().encode(s));
async function googleIdToken(env, now) {
  if (gToken && gToken.until > now) return gToken.token;
  let key;
  try {
    key = JSON.parse(env && env.GCP_SA_KEY);
  } catch (e) {
    key = null;
  }
  if (!isObj(key) || typeof key.client_email !== "string" || typeof key.private_key !== "string") throw new Error("no-key");
  const pem = key.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const der = b64decode(pem);
  if (!der) throw new Error("no-key");
  const signer = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const iat = Math.floor(now / 1000);
  const unsigned = `${b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64urlText(JSON.stringify({ iss: key.client_email, sub: key.client_email, aud: "https://oauth2.googleapis.com/token", target_audience: SCORER_URL, iat, exp: iat + 3600 }))}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, new TextEncoder().encode(unsigned)));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${unsigned}.${b64url(sig)}`,
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || typeof j.id_token !== "string") throw new Error("token");
  gToken = { token: j.id_token, until: now + 50 * 60e3 };
  return gToken.token;
}

const SIGNAL_KEYS = ["validHomography", "edgeTilesMatched", "edgeTilesCounted", "edgeTileRecallMin", "edgeF1", "orbInliers", "coverageOriginal", "phashDistance", "drawingValid", "drawingTilesMatched", "drawingTilesCounted", "drawingTileRecallMin", "textValid", "textTilesMatched", "textTilesCounted", "artPixelDiff"]; // 1.3.0: drawing / text / art pixel signals
function slimScore(r) {
  const s = isObj(r.signals) ? r.signals : null;
  const signals = s ? Object.fromEntries(SIGNAL_KEYS.filter((k) => typeof s[k] === "number" || typeof s[k] === "boolean").map((k) => [k, s[k]])) : null;
  return { id: String(r.id), status: String(r.status || ""), rank: Number.isInteger(r.rank) ? r.rank : null, source: String(r.source || ""), signals };
}

async function handleScore(request, env, now) {
  if ((request.headers.get("content-type") || "").split(";")[0].trim() !== "application/json") return json(415, { error: "content-type" });
  const len = Number(request.headers.get("content-length"));
  if (Number.isFinite(len) && len > SCORE_MAX_BODY) return json(413, { error: "too-large" });
  const raw = await request.text();
  if (raw.length > SCORE_MAX_BODY) return json(413, { error: "too-large" });
  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    return json(400, { error: "json" });
  }
  if (!isObj(input)) return json(400, { error: "input" });
  const lic = await verifyEvidence(input.evidence, now);
  if (!lic.ok) return json(401, { error: "license", reason: lic.reason });
  const list = (scoreRate.get(lic.licenseId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  scoreRate.set(lic.licenseId, list);
  if (scoreRate.size > 5000) scoreRate.clear();
  if (list.length > SCORE_RATE_MAX) return json(429, { error: "rate-limited" });
  const body = cleanScoreInput(input);
  if (!body) return json(400, { error: "input" });
  let token;
  try {
    token = await googleIdToken(env, now);
  } catch (e) {
    return json(503, { error: "scorer-auth" });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SCORE_TIMEOUT_MS);
  let res, j;
  try {
    res = await fetch(`${SCORER_URL}/v1/score`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: ctrl.signal });
    j = await res.json().catch(() => null);
  } catch (e) {
    return json(504, { error: "scorer-timeout" });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) gToken = null;
  if (res.status === 503) return json(503, { error: "scorer-busy" });
  if (res.status === 400 && j && j.error === "original") return json(422, { error: "design", reason: typeof j.reason === "string" ? j.reason.slice(0, 40) : "" });
  if (!res.ok || !j || !Array.isArray(j.results)) return json(502, { error: "scorer" });
  const o = isObj(j.original) ? j.original : {};
  console.log(JSON.stringify({ at: new Date(now).toISOString(), route: "score", license: lic.licenseId.slice(0, 8), n: j.results.length, ms: isObj(j.timing) ? j.timing.totalMs : null }));
  return json(200, {
    ok: true,
    rankRule: typeof j.rankRule === "string" ? j.rankRule.slice(0, 200) : "",
    original: { kind: String(o.kind || ""), source: String(o.source || ""), warnings: Array.isArray(o.warnings) ? o.warnings.slice(0, 5).map((w) => String(w).slice(0, 120)) : [] },
    timing: isObj(j.timing) ? { totalMs: Number(j.timing.totalMs) || 0 } : {},
    results: j.results.slice(0, SCORE_MAX_CANDIDATES).filter(isObj).map(slimScore),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const now = Date.now();
    try {
      if (url.pathname === "/v1/health" && request.method === "GET") return json(200, { ok: true, version: VERSION });
      if (url.pathname === "/v1/compare") return request.method === "POST" ? await handleCompare(request, now) : json(405, { error: "method" });
      if (url.pathname === "/v1/score") return request.method === "POST" ? await handleScore(request, env, now) : json(405, { error: "method" });
      return json(404, { error: "not-found" });
    } catch (e) {
      return json(500, { error: "server" });
    }
  },
};

