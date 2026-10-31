import { handleOps, scorerStatus } from "./ops.js";

const VERSION = "1.8.0";
const ACCOUNT = "c10a006b-77be-4206-908b-89a0b691210e";
const PRODUCT = "e063318f-88d2-4fd0-b99f-109f58cf29c9";
const PUBLIC_KEY_HEX = "c2c973660cec64eee3bb80e151c5ed4017b112504cd3d11a566b03d1b369a9cd";
const VALIDATE_PATH = `/v1/accounts/${ACCOUNT}/licenses/actions/validate-key`;
const MAX_EVIDENCE_AGE_MS = 48 * 3600e3;
const FUTURE_SKEW_MS = 10 * 60e3;
const MAX_BODY = 512 * 1024;
const MAX_OTHERS = 60;
const MAX_TITLES = 200;
const RATE_WINDOW_MS = 10 * 60e3;
const RATE_MAX = 120;

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
  return { ok: true, licenseId: d.id, fingerprint: m.scope.fingerprint, signedAt, metadata: isObj(d.attributes.metadata) ? d.attributes.metadata : {} };
}

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
const brandKey = (b) => String(b || "").toLowerCase().replace(/^visit the\s+|\s+store$/g, "").replace(/[^\p{L}\p{N}]/gu, "");
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
function exactWords(s) {
  return String(s || "").toLowerCase().replace(/[’'`ʼ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
}
const PRODUCT_TYPES = [
  "long sleeve t shirt", "long sleeve tshirt", "long sleeve shirt", "long sleeve tee", "v neck t shirt", "v neck tshirt", "v neck tee",
  "premium t shirt", "premium tshirt", "premium tee", "raglan baseball tee", "raglan baseball t shirt", "baseball tee", "racerback tank top",
  "tank top", "pullover hoodie", "zip hoodie", "full zip hoodie", "pullover sweatshirt", "sweatshirt", "hoodie", "t shirt", "tshirt", "tee", "shirt",
  "popsockets swappable popgrip", "popsockets popgrip", "popsockets grip", "popsockets standard popgrip", "throw pillow", "tote bag",
].map((p) => p.split(" ")).sort((a, b) => b.length - a.length);
const TITLE_PREFIXES = [["womens"], ["women", "s"]];
function titleCore(title) {
  let w = exactWords(title);
  const ends = (p) => w.length > p.length && p.every((x, i) => w[w.length - p.length + i] === x);
  const starts = (p) => w.length > p.length && p.every((x, i) => w[i] === x);
  const suffix = PRODUCT_TYPES.find(ends);
  if (suffix) w = w.slice(0, w.length - suffix.length);
  const prefix = TITLE_PREFIXES.find(starts);
  if (prefix) w = w.slice(prefix.length);
  return w.join(" ");
}
function hasRun(run, text) {
  return !!run && ` ${exactWords(text).join(" ")} `.includes(` ${run} `);
}

function compareListingText(mine, theirs) {
  const out = { title: {}, brand: {}, bullets: {}, description: {}, category: "", copied: [] };
  const mt = titleCore(mine.title);
  out.title = { copied: !!mt && mt === titleCore(theirs.title) };
  const mb = brandKey(mine.brand), tb = brandKey(theirs.brand);
  out.brand = { present: mb.length >= 2, copied: mb.length >= 2 && mb === tb };
  const theirTexts = [...(theirs.bullets || []), theirs.description || ""];
  const inTheirs = (text) => {
    const run = exactWords(text).join(" ");
    return theirTexts.some((t) => hasRun(run, t));
  };
  const myBullets = (mine.bullets || []).filter((b) => !isBoilerplate(b));
  const hits = myBullets.filter(inTheirs).length;
  out.bullets = { present: myBullets.length > 0, total: myBullets.length, copiedCount: hits, copied: hits > 0 };
  const md = exactWords(mine.description);
  out.description = { present: md.length >= 8, copied: md.length >= 8 && inTheirs(mine.description) };
  const others = ["brand", "bullets", "description"].filter((f) => out[f].present);
  const copiedOthers = others.filter((f) => out[f].copied);
  out.copied = [...(out.title.copied ? ["title"] : []), ...copiedOthers];
  if (out.title.copied && others.length >= 2 && copiedOthers.length === others.length) out.category = "full";
  else if (out.title.copied) out.category = "title";
  else if (copiedOthers.length) out.category = "part";
  return out;
}

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

const rate = new Map();
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

const DEFAULT_SCORER = { name: "cloud-run", url: "https://copycat-vision-308672515367.europe-west1.run.app", auth: "google", weight: 1 };
const SCORERS_TTL_MS = 60_000;
const PASS_TTL_S = 120;
const SCORE_MAX_BODY = 3_000_000;
const SCORE_MAX_CANDIDATES = 70;
const SCORE_TIMEOUT_MS = 60_000;
const SCORE_RATE_MAX = 30;
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

let scorersCache = null;
function scorerUrlOk(u) {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && !x.username && !x.password && x.pathname === "/" && !x.search;
  } catch (e) {
    return false;
  }
}
async function scorerList(env, now) {
  if (scorersCache && scorersCache.until > now) return scorersCache.list;
  let raw = null;
  try {
    raw = env && env.CONFIG ? await env.CONFIG.get("scorers", "json") : null;
  } catch (e) {
    raw = null;
  }
  const list = !Array.isArray(raw)
    ? [DEFAULT_SCORER]
    : raw
        .filter((x) => isObj(x) && typeof x.name === "string" && scorerUrlOk(x.url) && (x.auth === "pass" || x.auth === "google") && Number.isFinite(x.weight) && x.weight > 0)
        .map((x) => ({ name: x.name.slice(0, 40), url: new URL(x.url).origin, auth: x.auth, weight: x.weight }));
  scorersCache = { list, until: now + SCORERS_TTL_MS };
  return list;
}

function scorerOrder(list) {
  const left = list.slice();
  const out = [];
  while (left.length) {
    let r = Math.random() * left.reduce((sum, x) => sum + x.weight, 0);
    const i = Math.max(0, left.findIndex((x) => (r -= x.weight) < 0));
    out.push(left.splice(i, 1)[0]);
  }
  return out;
}

async function scorerPass(env, now) {
  const secret = env && env.SCORER_SECRET;
  if (typeof secret !== "string" || secret.length < 32) throw new Error("no-key");
  const exp = Math.floor(now / 1000) + PASS_TTL_S;
  const mac = [...(await hmacBytes(secret, `v1.${exp}./v1/score`))].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `v1.${exp}.${mac}`;
}

const gTokens = new Map();
const b64url = (bytes) => b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (s) => b64url(new TextEncoder().encode(s));
async function googleIdToken(env, now, audience) {
  const cached = gTokens.get(audience);
  if (cached && cached.until > now) return cached.token;
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
  const unsigned = `${b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64urlText(JSON.stringify({ iss: key.client_email, sub: key.client_email, aud: "https://oauth2.googleapis.com/token", target_audience: audience, iat, exp: iat + 3600 }))}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, new TextEncoder().encode(unsigned)));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${unsigned}.${b64url(sig)}`,
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || typeof j.id_token !== "string") throw new Error("token");
  gTokens.set(audience, { token: j.id_token, until: now + 50 * 60e3 });
  return j.id_token;
}

const SIGNAL_KEYS = ["validHomography", "edgeTilesMatched", "edgeTilesCounted", "edgeTileRecallMin", "edgeF1", "orbInliers", "coverageOriginal", "phashDistance", "drawingValid", "drawingTilesMatched", "drawingTilesCounted", "drawingTileRecallMin", "textValid", "textTilesMatched", "textTilesCounted", "artPixelDiff", "clipSim", "dinoSim", "sameIdea"];
function slimScore(r) {
  const s = isObj(r.signals) ? r.signals : null;
  const signals = s ? Object.fromEntries(SIGNAL_KEYS.filter((k) => typeof s[k] === "number" || typeof s[k] === "boolean").map((k) => [k, s[k]])) : null;
  return { id: String(r.id), status: String(r.status || ""), rank: Number.isInteger(r.rank) ? r.rank : null, source: String(r.source || ""), signals };
}

async function askScorer(scorer, body, env, now, licenseId) {
  const headers = { "content-type": "application/json" };
  try {
    if (scorer.auth === "google") {
      headers.authorization = `Bearer ${await googleIdToken(env, now, scorer.url)}`;
      const pass = await scorerPass(env, now).catch(() => null);
      if (pass) headers["x-copycat-pass"] = pass;
    } else headers["x-copycat-pass"] = await scorerPass(env, now);
  } catch (e) {
    return { next: true, reply: json(503, { error: "scorer-auth" }) };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SCORE_TIMEOUT_MS);
  let res, j;
  try {
    res = await fetch(`${scorer.url}/v1/score`, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    j = await res.json().catch(() => null);
  } catch (e) {
    return { next: !ctrl.signal.aborted, reply: json(503, { error: "scorer-busy", retryAfter: 5 }) };
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) {
    gTokens.delete(scorer.url);
    return { next: true, reply: json(502, { error: "scorer" }) };
  }
  if ([429, 502, 503, 504].includes(res.status)) {
    const ra = Number(res.headers.get("retry-after"));
    return { next: true, reply: json(503, { error: "scorer-busy", retryAfter: Number.isFinite(ra) && ra >= 1 && ra <= 60 ? Math.round(ra) : 10 }) };
  }
  if (res.status === 400 && j && j.error === "original") return { next: false, reply: json(422, { error: "design", reason: typeof j.reason === "string" ? j.reason.slice(0, 40) : "" }) };
  if (!res.ok || !j || !Array.isArray(j.results)) return { next: true, reply: json(502, { error: "scorer" }) };
  const o = isObj(j.original) ? j.original : {};
  console.log(JSON.stringify({ at: new Date(now).toISOString(), route: "score", scorer: scorer.name, license: licenseId.slice(0, 8), n: j.results.length, ms: isObj(j.timing) ? j.timing.totalMs : null }));
  return {
    next: false,
    reply: json(200, {
      ok: true,
      rankRule: typeof j.rankRule === "string" ? j.rankRule.slice(0, 200) : "",
      original: { kind: String(o.kind || ""), source: String(o.source || ""), warnings: Array.isArray(o.warnings) ? o.warnings.slice(0, 5).map((w) => String(w).slice(0, 120)) : [] },
      timing: isObj(j.timing) ? { totalMs: Number(j.timing.totalMs) || 0 } : {},
      results: j.results.slice(0, SCORE_MAX_CANDIDATES).filter(isObj).map(slimScore),
    }),
  };
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
  if (scorerStatus(lic, env) !== "approved") return json(403, { error: "scorer-not-approved" });
  const list = (scoreRate.get(lic.licenseId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  scoreRate.set(lic.licenseId, list);
  if (scoreRate.size > 5000) scoreRate.clear();
  if (list.length > SCORE_RATE_MAX) return json(429, { error: "rate-limited" });
  const body = cleanScoreInput(input);
  if (!body) return json(400, { error: "input" });
  const scorers = await scorerList(env, now);
  if (!scorers.length) return json(503, { error: "scorer-off" });
  let out = null;
  for (const scorer of scorerOrder(scorers)) {
    out = await askScorer(scorer, body, env, now, lic.licenseId);
    if (!out.next) break;
  }
  return out.reply;
}

const PLANS = { starter_monthly: "starter", starter_yearly: "starter" };
const POLICIES = { starter: "3e444f48-8c94-4f09-9f87-b63ea8098233" };
const GRACE_MS = 3 * 86400e3;
const WEBHOOK_TOLERANCE_S = 300;
const SITE = "https://h-bns.shop";
const SUPPORT_EMAIL = "support@copycathunt.com";
const API_ORIGIN = "https://api.copycathunt.com";
const LOGO_SVG = '<svg class="logo" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 125.83 125.67"><rect fill="#2ee6a6" width="125.83" height="125.67" rx="28.22" ry="28.22"/><path fill="#121214" d="M92.82,85.07v22.15h-59.81v-55.32l-5.43,3.62-13.21-17.5,22.33-19.57c4.1,2.69,8.35,5.57,12.44,8.28,1.38,1.17,3.37,4.16,4.94,5.1,5.33,3.17,10.8,3.4,16.42.7,2.49-1.2,4.27-3.88,6.27-5.87l12.34-8.21,22.33,19.56-13.16,17.54-5.48-3.66v25.7c-6.36,9.09-11.98,18.42-16.85,27.98,6.52-3.7,13.17-14.33,16.85-20.5ZM69.72,63.57l-22.56,35.98c-.05.08-.03.18.05.23,0,0,0,0,0,0l.05.04c1.65,1.01,8.02-6.19,14.24-16.1l.22-.35c6.22-9.91,9.92-18.78,8.29-19.82l-.05-.04c-.08-.05-.18-.03-.23.05,0,0,0,0,0,0ZM72.51,84.02c-3.63,5.78-7.09,11.86-10.37,18.26-.04.12.02.26.14.3.07.03.15.02.21-.03,4.83-4.12,9.36-9.55,13.6-16.29,4.23-6.74,7.16-13.18,8.77-19.32.02-.13-.07-.25-.2-.27-.08-.01-.16.02-.21.07-4.33,5.73-8.31,11.49-11.95,17.28Z"/></svg>';
const LOGO_PNG_B64 = "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";
const firstName = (n) => String(n || "").trim().split(/\s+/)[0].slice(0, 40);
const MAIL_FROM = "licenses@copycathunt.com";
const KEYGEN_API = `https://api.keygen.sh/v1/accounts/${ACCOUNT}`;
const ENDED = ["unpaid", "canceled", "incomplete_expired"];
const PAID = ["paid", "no_payment_required"];
const checkoutRate = new Map();

function formEncode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") formEncode(v, name, out);
    else out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(v))}`);
  }
  return out.join("&");
}
async function stripe(env, method, path, params) {
  if (!env.STRIPE_SECRET_KEY) throw new Error("no-stripe-key");
  const qs = params ? formEncode(params) : "";
  const res = await fetch(`https://api.stripe.com/v1${path}${method === "GET" && qs ? "?" + qs : ""}`, {
    method,
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
    body: method === "GET" ? undefined : qs,
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !isObj(j)) throw new Error(`stripe ${res.status} ${path.split("/")[1]}`);
  return j;
}
async function keygen(env, method, path, body) {
  if (!env.KEYGEN_TOKEN) throw new Error("no-keygen-token");
  const res = await fetch(`${KEYGEN_API}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.KEYGEN_TOKEN}`, accept: "application/vnd.api+json", "content-type": "application/vnd.api+json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => null);
  return { status: res.status, j };
}

async function hmacBytes(secret, text) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)));
}
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
async function licenseKeyFor(env, subscriptionId) {
  if (!env.LICENSE_KEY_SECRET || env.LICENSE_KEY_SECRET.length < 32) throw new Error("no-license-secret");
  const b = await hmacBytes(env.LICENSE_KEY_SECRET, `copycat-hunt:${subscriptionId}`);
  let s = "";
  for (let i = 0; i < 25; i++) s += KEY_ALPHABET[b[i] & 31];
  return s.match(/.{5}/g).join("-");
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function stripeEventFrom(raw, header, secret, now) {
  if (!secret || typeof header !== "string") return null;
  let t = null;
  const v1 = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
  }
  if (t === null || !v1.length || Math.abs(now / 1000 - t) > WEBHOOK_TOLERANCE_S) return null;
  const want = [...(await hmacBytes(secret, `${t}.${raw}`))].map((x) => x.toString(16).padStart(2, "0")).join("");
  if (!v1.some((s) => timingSafeEqualHex(s, want))) return null;
  try {
    const ev = JSON.parse(raw);
    return isObj(ev) && isObj(ev.data) && isObj(ev.data.object) ? ev : null;
  } catch (e) {
    return null;
  }
}

const idOf = (v) => (typeof v === "string" ? v : isObj(v) && typeof v.id === "string" ? v.id : null);
const invoiceSubscription = (inv) => idOf(inv.subscription) || (isObj(inv.parent) && isObj(inv.parent.subscription_details) ? idOf(inv.parent.subscription_details.subscription) : null);
function invoicePeriodEnd(inv) {
  const lines = isObj(inv.lines) && Array.isArray(inv.lines.data) ? inv.lines.data : [];
  const ends = lines.map((l) => (isObj(l) && isObj(l.period) ? Number(l.period.end) : NaN)).filter(Number.isFinite);
  return ends.length ? Math.max(...ends) * 1000 : NaN;
}
function subscriptionTier(sub) {
  const items = isObj(sub.items) && Array.isArray(sub.items.data) ? sub.items.data : [];
  for (const it of items) {
    const p = isObj(it) && isObj(it.price) ? it.price : null;
    if (p && PLANS[p.lookup_key]) return PLANS[p.lookup_key];
    if (p && isObj(p.metadata) && POLICIES[p.metadata.tier]) return p.metadata.tier;
  }
  return null;
}

async function findLicense(env, key) {
  const r = await keygen(env, "GET", `/licenses/${encodeURIComponent(key)}`);
  if (r.status === 404) return null;
  if (r.status !== 200 || !isObj(r.j) || !isObj(r.j.data)) throw new Error(`keygen ${r.status} read`);
  return r.j.data;
}
async function findSubscriptionLicense(env, key, subId) {
  const byKey = await findLicense(env, key);
  if (byKey) return byKey;
  const r = await keygen(env, "GET", `/licenses?metadata[stripeSubscription]=${encodeURIComponent(subId)}&limit=1`);
  if (r.status !== 200 || !isObj(r.j) || !Array.isArray(r.j.data)) throw new Error(`keygen ${r.status} list`);
  return r.j.data.find((l) => isObj(l) && isObj(l.attributes) && isObj(l.attributes.metadata) && l.attributes.metadata.stripeSubscription === subId) || null;
}

async function grantForInvoice(env, inv, now) {
  if (!isObj(inv) || inv.status !== "paid") return null;
  const subId = invoiceSubscription(inv);
  const paidUntil = invoicePeriodEnd(inv);
  if (!subId || !Number.isFinite(paidUntil)) return null;
  const sub = await stripe(env, "GET", `/subscriptions/${subId}`, { expand: ["items.data.price"] });
  const tier = subscriptionTier(sub);
  if (!tier) throw new Error("unknown-plan");
  const key = await licenseKeyFor(env, subId);
  const expiry = new Date(paidUntil + GRACE_MS).toISOString();
  let lic = await findSubscriptionLicense(env, key, subId);
  let created = false;
  if (!lic) {
    const r = await keygen(env, "POST", "/licenses", {
      data: {
        type: "licenses",
        attributes: {
          key,
          name: str(inv.customer_name, 120).trim() || str(inv.customer_email, 200) || null,
          expiry,
          metadata: { tier, email: str(inv.customer_email, 200), stripeSubscription: subId, stripeCustomer: idOf(inv.customer) || "", livemode: !!inv.livemode },
        },
        relationships: { policy: { data: { type: "policies", id: POLICIES[tier] } } },
      },
    });
    if (r.status === 201 && isObj(r.j) && isObj(r.j.data)) {
      lic = r.j.data;
      created = true;
    } else if (r.status === 422) {
      lic = await findLicense(env, key);
      if (!lic) throw new Error("keygen 422 create");
    } else throw new Error(`keygen ${r.status} create`);
  }
  const a = isObj(lic.attributes) ? lic.attributes : {};
  const current = isoMs(a.expiry);
  if (!created && (!Number.isFinite(current) || current < paidUntil + GRACE_MS)) {
    const r = await keygen(env, "PATCH", `/licenses/${lic.id}`, { data: { type: "licenses", attributes: { expiry } } });
    if (r.status !== 200) throw new Error(`keygen ${r.status} extend`);
  }
  if ((a.status === "SUSPENDED" || a.suspended === true) && !ENDED.includes(sub.status)) {
    const r = await keygen(env, "POST", `/licenses/${lic.id}/actions/reinstate`);
    if (r.status !== 200) throw new Error(`keygen ${r.status} reinstate`);
  }
  console.log(JSON.stringify({ at: new Date(now).toISOString(), route: "grant", license: String(lic.id).slice(0, 8), created, until: expiry.slice(0, 10) }));
  return { key: typeof a.key === "string" && a.key ? a.key : key, name: str(inv.customer_name, 120).trim(), license: lic, created, subscription: sub };
}

async function suspendForSubscription(env, subId, now) {
  const lic = await findSubscriptionLicense(env, await licenseKeyFor(env, subId), subId);
  if (!lic || (isObj(lic.attributes) && lic.attributes.suspended === true)) return;
  const r = await keygen(env, "POST", `/licenses/${lic.id}/actions/suspend`);
  if (r.status !== 200) throw new Error(`keygen ${r.status} suspend`);
  console.log(JSON.stringify({ at: new Date(now).toISOString(), route: "suspend", license: String(lic.id).slice(0, 8) }));
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function emailKeyOnce(env, grant, to) {
  if (!env.RESEND_API_KEY || !to || !grant) return false;
  const sub = grant.subscription;
  if (isObj(sub.metadata) && sub.metadata.key_emailed) return false;
  const steps = "Paste it on the Copycat Hunt setup page and press Activate.";
  const manage = env.PORTAL_LOGIN_URL ? `To change your card or cancel, sign in here with this email address: ${env.PORTAL_LOGIN_URL}` : "";
  const hi = firstName(grant.name);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": `license-key/${sub.id}` },
    body: JSON.stringify({
      from: `Copycat Hunt <${MAIL_FROM}>`,
      to: [to],
      reply_to: SUPPORT_EMAIL,
      subject: "Your Copycat Hunt license key",
      text: `${hi ? `Hi ${hi},\n\n` : ""}Thank you for buying Copycat Hunt.\n\nYour license key:\n${grant.key}\n\n${steps}\nOne key works on one computer.\n\n${manage}\n\nQuestions? Just reply to this email.`,
      html: keyEmailHtml(grant.key, hi, env.PORTAL_LOGIN_URL),
    }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}`);
  await stripe(env, "POST", `/subscriptions/${sub.id}`, { metadata: { key_emailed: "1" } });
  return true;
}

function keyEmailHtml(key, hi, portal) {
  const F = "'IBM Plex Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const p = (t, extra = "") => `<p style="margin:0 0 14px;font:15px/1.6 ${F};color:#555a61;${extra}">${t}</p>`;
  const step = (n, t) => `<tr><td valign="top" style="padding:0 12px 12px 0;width:26px"><div style="width:24px;height:24px;border-radius:12px;background:#d9f8ec;color:#057a51;font:600 12px/24px ${F};text-align:center">${n}</div></td><td style="padding:0 0 12px;font:15px/1.5 ${F};color:#3d4147">${t}</td></tr>`;
  const store = "https://chromewebstore.google.com/detail/copycat-hunt/lpipaodhlgeakmanmlmgjhicbhbnhklk";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Your Copycat Hunt license key</title></head>
<body style="margin:0;padding:0;background:#f6f7f5">
<div style="display:none;max-height:0;overflow:hidden">Your license key is inside. Paste it on the setup page to start.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f5"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 20px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td><img src="${API_ORIGIN}/brand/logo.png" width="40" height="40" alt="Copycat Hunt" style="display:block;border:0;border-radius:10px"></td>
<td style="padding-left:12px;font:600 17px/1.2 ${F};color:#161618">Copycat Hunt</td></tr></table></td></tr>
<tr><td style="background:#ffffff;border:1px solid #e3e5e2;border-radius:16px;padding:32px">
<p style="margin:0 0 8px;font:600 22px/1.3 ${F};color:#161618">${hi ? `Thanks, ${esc(hi)}. You're all set.` : "Thanks. You're all set."}</p>
${p("Here is your Copycat Hunt license key:")}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 22px"><tr><td align="center" style="background:#d9f8ec;border:1px solid #2ee6a6;border-radius:12px;padding:16px 12px;font:600 19px/1.3 Consolas,'SFMono-Regular',Menlo,monospace;letter-spacing:1px;color:#161618">${esc(key)}</td></tr></table>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 10px">
${step(1, `Add Copycat Hunt to Chrome (it also works in Edge and Brave).`)}
${step(2, `Open the setup page, paste the key and press <b style="color:#161618">Activate</b>.`)}
${step(3, `Connect your Merch account and start your first hunt.`)}
</table>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 22px"><tr><td style="background:#2ee6a6;border-radius:999px"><a href="${store}" style="display:inline-block;padding:12px 22px;font:600 14px/1 ${F};color:#161618;text-decoration:none">Add to Chrome</a></td></tr></table>
${p("One key works on one computer.")}
${portal ? p(`To change your card, see receipts or cancel, <a href="${esc(portal)}" style="color:#057a51">sign in to your billing page</a> with this email address.`) : ""}
${p("Questions? Just reply to this email.", "margin:0")}
</td></tr>
<tr><td style="padding:20px 4px 0;font:12px/1.6 ${F};color:#8a8e94">Copycat Hunt by H.Bns LLC, 30 North Gould Street, Sheridan, WY 82801, USA.<br><a href="https://copycathunt.com" style="color:#8a8e94">copycathunt.com</a> · <a href="https://copycathunt.com/support" style="color:#8a8e94">Help center</a> · <a href="https://copycathunt.com/privacy" style="color:#8a8e94">Privacy</a> · <a href="https://copycathunt.com/terms" style="color:#8a8e94">Terms</a></td></tr>
</table></td></tr></table></body></html>`;
}

async function handleCheckout(request, env, url, now) {
  const plan = url.searchParams.get("plan") || "";
  if (!Object.prototype.hasOwnProperty.call(PLANS, plan)) return page(400, "Unknown plan", `<h1>Unknown plan</h1><p>That plan doesn't exist. Please pick a plan again in Copycat Hunt.</p>`);
  const ip = request.headers.get("cf-connecting-ip") || "";
  const list = (checkoutRate.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  checkoutRate.set(ip, list);
  if (checkoutRate.size > 5000) checkoutRate.clear();
  if (list.length > 20) return page(429, "Too many tries", `<h1>Too many tries</h1><p>Please wait a few minutes and try again.</p>`);
  const prices = await stripe(env, "GET", "/prices", { lookup_keys: [plan], active: "true", limit: 1 });
  const price = Array.isArray(prices.data) && prices.data[0];
  if (!price) throw new Error("no-price");
  const session = await stripe(env, "POST", "/checkout/sessions", {
    mode: "subscription",
    line_items: [{ price: price.id, quantity: 1 }],
    success_url: `${url.origin}/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${url.origin}/checkout/cancelled`,
    allow_promotion_codes: "true",
    billing_address_collection: "auto",
    managed_payments: { enabled: "true" },
    subscription_data: { metadata: { app: "copycat-hunt", plan } },
    metadata: { app: "copycat-hunt", plan },
  });
  if (typeof session.url !== "string" || !session.url.startsWith("https://checkout.stripe.com/")) throw new Error("no-session-url");
  return new Response(null, { status: 303, headers: { location: session.url, "cache-control": "no-store" } });
}

async function handleWebhook(request, env, now) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { error: "too-large" });
  const ev = await stripeEventFrom(raw, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET, now);
  if (!ev) return json(400, { error: "signature" });
  const o = ev.data.object;
  if (ev.type === "invoice.paid") {
    await grantForInvoice(env, o, now);
  } else if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {
    if (o.mode === "subscription" && PAID.includes(o.payment_status) && idOf(o.invoice)) {
      const grant = await grantForInvoice(env, await stripe(env, "GET", `/invoices/${idOf(o.invoice)}`), now);
      await emailKeyOnce(env, grant, (isObj(o.customer_details) && o.customer_details.email) || o.customer_email);
    }
  } else if (ev.type === "customer.subscription.deleted") {
    await suspendForSubscription(env, o.id, now);
  } else if (ev.type === "customer.subscription.updated") {
    if (ENDED.includes(o.status)) await suspendForSubscription(env, o.id, now);
  }
  return json(200, { received: true });
}

function page(status, title, body, extraHead = "") {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · Copycat Hunt</title>${extraHead}
<style>:root{color-scheme:dark;--bg:#161618;--card:#232326;--sep:rgba(255,255,255,.08);--text:#ececf0;--muted:#9a9aa2;--mint:#2ee6a6;--mint-hi:#5cefbd;--mint-ink:#08251a;--mint-text:#6ff0c3}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:560px;margin:0 auto;padding:48px 16px 40px}.top{display:flex;flex-direction:column;align-items:center;margin-bottom:24px}.logo{display:block;width:56px;height:56px;margin-bottom:12px}.brand{font-weight:700;font-size:19px;color:#fff;letter-spacing:-.01em}
.card{background:var(--card);border:1px solid var(--sep);border-radius:16px;padding:28px}
h1{font-size:23px;line-height:1.25;margin:0 0 12px;color:#fff;letter-spacing:-.02em}p{margin:0 0 14px}.mute{color:var(--muted);font-size:14px}a{color:var(--mint-text)}b{color:#fff}
.key{display:flex;gap:8px;align-items:stretch;margin:18px 0}.key code{flex:1;min-width:0;padding:13px 14px;background:var(--mint-ink);border:1px solid var(--mint);border-radius:12px;color:var(--mint-text);font:700 17px/1.3 Consolas,"SFMono-Regular",Menlo,monospace;letter-spacing:.06em;overflow-wrap:anywhere;user-select:all}
button{border:0;border-radius:12px;padding:0 20px;background:var(--mint);color:var(--mint-ink);font:650 15px system-ui,sans-serif;cursor:pointer}button:hover{background:var(--mint-hi)}ol{padding-left:20px;margin:0 0 16px}li{margin:4px 0}
.foot{margin-top:16px;text-align:center}@media (max-width:480px){.key{flex-direction:column}.key button{min-height:46px}}</style></head>
<body><main><div class="top">${LOGO_SVG}<div class="brand">Copycat Hunt</div></div><div class="card">${body}</div><p class="mute foot">Questions? <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}

async function handleThanks(env, url, now) {
  const id = url.searchParams.get("session_id") || "";
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(id)) return page(400, "Link not valid", `<h1>This link isn't valid</h1><p>If you just paid, check your email for your key, or write to us and we'll send it.</p>`);
  let session;
  try {
    session = await stripe(env, "GET", `/checkout/sessions/${id}`);
  } catch (e) {
    return page(404, "Not found", `<h1>We couldn't find this purchase</h1><p>If you just paid, check your email for your key, or write to us and we'll send it.</p>`);
  }
  const wait = `<meta http-equiv="refresh" content="4">`;
  if (session.status !== "complete") return page(200, "Payment not finished", `<h1>Payment not finished</h1><p>No money was taken. You can close this tab and pick a plan again in Copycat Hunt.</p>`);
  if (!PAID.includes(session.payment_status) || !idOf(session.invoice)) return page(200, "Payment processing", `<h1>Your payment is being processed</h1><p>This page refreshes by itself. Your key will appear here as soon as the payment clears.</p>`, wait);
  const grant = await grantForInvoice(env, await stripe(env, "GET", `/invoices/${idOf(session.invoice)}`), now);
  if (!grant) return page(200, "Almost ready", `<h1>Almost ready…</h1><p>This page refreshes by itself.</p>`, wait);
  const manage = env.PORTAL_LOGIN_URL ? `<p class="mute">To change your card or cancel later, <a href="${esc(env.PORTAL_LOGIN_URL)}" target="_blank" rel="noopener">sign in to your billing page</a> with the email you paid with.</p>` : "";
  const hi = firstName(grant.name);
  return page(200, "Your license key", `<h1>Thank you${hi ? `, ${esc(hi)}` : ""}! Here is your license key</h1>
<div class="key"><code id="k">${esc(grant.key)}</code><button type="button" id="c">Copy</button></div>
<p>Paste it on the setup page and press <b>Activate</b>.</p>
<p class="mute">One key works on one computer. Keep this key${env.RESEND_API_KEY ? ": we've also emailed it to you" : " somewhere safe"}.</p>${manage}
<script>document.getElementById("c").onclick=function(){var b=this;navigator.clipboard.writeText(document.getElementById("k").textContent).then(function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy"},1600)})}</script>`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const now = Date.now();
    try {
      if (url.pathname === "/v1/health" && request.method === "GET") return json(200, { ok: true, version: VERSION });
      const ops = await handleOps(request, env, url, now, { verifyEvidence, keygenApi: KEYGEN_API });
      if (ops) return ops;
      if (url.pathname === "/v1/compare") return request.method === "POST" ? await handleCompare(request, now) : json(405, { error: "method" });
      if (url.pathname === "/v1/score") return request.method === "POST" ? await handleScore(request, env, now) : json(405, { error: "method" });
      if (url.pathname === "/v1/checkout") {
        if (request.method !== "GET") return json(405, { error: "method" });
        try {
          return await handleCheckout(request, env, url, now);
        } catch (e) {
          console.log(JSON.stringify({ at: new Date(now).toISOString(), route: "checkout", error: String(e.message).slice(0, 80) }));
          return page(503, "Try again", `<h1>Checkout isn't available right now</h1><p>Nothing was charged. Please try again in a few minutes.</p>`);
        }
      }
      if (url.pathname === "/v1/stripe/webhook") {
        if (request.method !== "POST") return json(405, { error: "method" });
        try {
          return await handleWebhook(request, env, now);
        } catch (e) {
          console.log(JSON.stringify({ at: new Date(now).toISOString(), route: "webhook", error: String(e.message).slice(0, 80) }));
          return json(500, { error: "server" });
        }
      }
      if (url.pathname === "/thanks" && request.method === "GET") {
        try {
          return await handleThanks(env, url, now);
        } catch (e) {
          console.log(JSON.stringify({ at: new Date(now).toISOString(), route: "thanks", error: String(e.message).slice(0, 80) }));
          return page(503, "Almost ready", `<h1>Your payment went through</h1><p>We're still preparing your key. This page refreshes by itself.</p>`, `<meta http-equiv="refresh" content="6">`);
        }
      }
      if (url.pathname === "/brand/logo.png" && request.method === "GET") {
        const bin = atob(LOGO_PNG_B64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Response(bytes, { headers: { "content-type": "image/png", "cache-control": "public, max-age=604800", "x-content-type-options": "nosniff" } });
      }
      if (url.pathname === "/checkout/cancelled" && request.method === "GET") return page(200, "Checkout cancelled", `<h1>No problem</h1><p>Nothing was charged. You can close this tab and pick a plan any time in Copycat Hunt.</p>`);
      return json(404, { error: "not-found" });
    } catch (e) {
      return json(500, { error: "server" });
    }
  },
};
