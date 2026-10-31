const ADMIN_EMAIL = "support@copycathunt.com";
const ORIGIN = "https://api.copycathunt.com";
const KINDS = { info: "Announcement", maintenance: "Maintenance", price: "Price change" };
const MAX_ANNOUNCEMENTS = 50;
const HISTORY_MS = 60 * 864e5;
const SESSION_MS = 12 * 3600e3;
const IDLE_S = 30 * 60;
const LINK_MS = 15 * 60e3;
const REQUEST_TTL_S = 30 * 24 * 3600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VER_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
let keygenApi = "";
let BASE = "";

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const str = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function jsonRes(status, obj, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra } });
}

async function sign(env, text) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.LICENSE_KEY_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("ops-admin:" + text))));
}
function sameHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function sendMail(env, to, subject, text) {
  if (!env.RESEND_API_KEY) throw new Error("no-resend");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: "Copycat Hunt <licenses@copycathunt.com>", to: [to], reply_to: ADMIN_EMAIL, subject, text }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}`);
}

async function readAnnouncements(env) {
  const list = env.OPS ? await env.OPS.get("announcements", "json") : null;
  return Array.isArray(list) ? list : [];
}

function cleanAnnouncement(a) {
  return {
    id: a.id,
    kind: a.kind,
    title: a.title,
    body: a.body,
    link: a.link || "",
    linkText: a.linkText || "",
    startsAt: a.startsAt,
    endsAt: a.endsAt || null,
    maxVersion: a.maxVersion || "",
    dismissible: a.kind !== "maintenance",
  };
}

async function publicAnnouncements(env, now, history) {
  const all = (await readAnnouncements(env)).filter((a) => a.startsAt <= now);
  const isLive = (a) => !a.endsAt || a.endsAt > now;
  const items = history
    ? all.filter((a) => a.startsAt > now - HISTORY_MS).sort((a, b) => b.startsAt - a.startsAt).map((a) => ({ ...cleanAnnouncement(a), live: isLive(a) }))
    : all.filter(isLive).map(cleanAnnouncement);
  return jsonRes(200, { items }, { "cache-control": "public, max-age=60" });
}

const isOwner = (env, id) => String((env && env.OWNER_LICENSES) || "").toLowerCase().split(/[\s,]+/).includes(String(id).toLowerCase());

export function scorerStatus(lic, env) {
  if (isOwner(env, lic.licenseId)) return "approved";
  const s = isObj(lic.metadata) ? lic.metadata.scorer : "";
  return s === "approved" ? "approved" : s === "revoked" ? "revoked" : "none";
}

async function scorerAccess(request, env, now, deps) {
  if ((request.headers.get("content-type") || "").split(";")[0].trim() !== "application/json") return jsonRes(415, { error: "content-type" });
  const raw = await request.text();
  if (raw.length > 64 * 1024) return jsonRes(413, { error: "too-large" });
  let input;
  try { input = JSON.parse(raw); } catch (e) { return jsonRes(400, { error: "json" }); }
  if (!isObj(input)) return jsonRes(400, { error: "input" });
  const lic = await deps.verifyEvidence(input.evidence, now);
  if (!lic.ok) return jsonRes(401, { error: "license", reason: lic.reason });
  const status = scorerStatus(lic, env);
  if (status !== "none") return jsonRes(200, { status });
  const key = "req:" + lic.licenseId;
  const pending = env.OPS ? await env.OPS.get(key) : null;
  if (pending) return jsonRes(200, { status: "requested" });
  if (input.ask !== true) return jsonRes(200, { status: "none" });
  if (!env.OPS) return jsonRes(503, { error: "not-ready" });
  const email = str(isObj(lic.metadata) ? lic.metadata.email : "", 200);
  await env.OPS.put(key, JSON.stringify({ at: now, email, tier: str(isObj(lic.metadata) ? lic.metadata.tier : "", 20) }), { expirationTtl: REQUEST_TTL_S });
  try {
    await sendMail(env, ADMIN_EMAIL, `Scorer access request${email ? `: ${email}` : ""}`,
      `A customer asked for the image scorer.\n\nEmail: ${email || "(not on the license)"}\nLicense: ${lic.licenseId}\n\nApprove or decline here (you'll get a sign-in link if needed):\n${ORIGIN}${BASE}`);
  } catch (e) {
    console.log(JSON.stringify({ at: new Date(now).toISOString(), route: "scorer-access", error: String(e.message).slice(0, 80) }));
  }
  return jsonRes(200, { status: "requested" });
}

async function setScorer(env, licenseId, value, now) {
  const got = await keygenGet(env, licenseId);
  if (!got) throw new Error("license-not-found");
  const metadata = { ...(isObj(got.attributes.metadata) ? got.attributes.metadata : {}), scorer: value, scorerAt: new Date(now).toISOString() };
  const res = await fetch(`${keygenApi}/licenses/${licenseId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${env.KEYGEN_TOKEN}`, accept: "application/vnd.api+json", "content-type": "application/vnd.api+json" },
    body: JSON.stringify({ data: { type: "licenses", attributes: { metadata } } }),
  });
  if (!res.ok) throw new Error(`keygen ${res.status}`);
  if (env.OPS) await env.OPS.delete("req:" + licenseId);
  return metadata;
}

async function keygenGet(env, licenseId) {
  if (!env.KEYGEN_TOKEN) throw new Error("no-keygen-token");
  const res = await fetch(`${keygenApi}/licenses/${licenseId}`, { headers: { authorization: `Bearer ${env.KEYGEN_TOKEN}`, accept: "application/vnd.api+json" } });
  if (res.status === 404) return null;
  const j = await res.json().catch(() => null);
  if (!res.ok || !isObj(j) || !isObj(j.data)) throw new Error(`keygen ${res.status}`);
  return j.data;
}

async function session(request, env, now) {
  const m = /(?:^|;\s*)ops=([0-9a-f]{32})\.([0-9a-f]{64})/.exec(request.headers.get("cookie") || "");
  if (!m || !sameHex(m[2], await sign(env, "session." + m[1]))) return "";
  const started = Number(await env.OPS.get("sess:" + m[1]));
  if (!started || now - started > SESSION_MS) return "";
  await env.OPS.put("sess:" + m[1], String(started), { expirationTtl: IDLE_S });
  return m[1];
}

function sameOrigin(request) {
  const o = request.headers.get("origin");
  if (o && o !== "null") return o === ORIGIN;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

function adminPage(title, body, status = 200, headers = {}) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} | Copycat Hunt admin</title>
<style>
:root{--ink:#161618;--muted:#555a61;--line:#e3e5e2;--mint:#2ee6a6;--mint-deep:#057a51;--paper:#f6f7f5}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 -apple-system,"Segoe UI",system-ui,sans-serif}
main{max-width:880px;margin:0 auto;padding:32px 16px 64px}h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:36px 0 12px}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px;margin:12px 0}
label{display:block;font-weight:600;font-size:13px;margin:12px 0 6px}input,select,textarea{width:100%;padding:10px 12px;border:1px solid #c4c8cc;border-radius:10px;font:inherit;background:#fff}
textarea{min-height:90px}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:640px){.row{grid-template-columns:1fr}}
button{border:0;border-radius:999px;padding:10px 18px;font:600 14px/1 inherit;cursor:pointer;background:var(--mint);color:var(--ink)}
button.ghost{background:transparent;border:1px solid #c4c8cc}button.danger{background:#fde2e1;color:#8a1c17}
.muted{color:var(--muted)}.tag{display:inline-block;padding:3px 8px;border-radius:999px;font-size:12px;font-weight:600;background:#eceeea}
.tag.info{background:#d9f8ec;color:#057a51}.tag.maintenance{background:#fff1d6;color:#8a5a00}.tag.price{background:#dfeaff;color:#1d4fa8}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top;font-size:14px}
form.inline{display:inline}.note{font-size:13px}
</style></head><body><main>${body}</main></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "same-origin", ...headers } });
}

const fmt = (ms) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "no end");

async function dashboard(env, now, msg) {
  const list = await readAnnouncements(env);
  const reqs = env.OPS ? (await env.OPS.list({ prefix: "req:" })).keys : [];
  const pending = [];
  for (const k of reqs.slice(0, 50)) pending.push({ id: k.name.slice(4), ...(JSON.parse((await env.OPS.get(k.name)) || "{}")) });
  const live = list.filter((a) => !a.endsAt || a.endsAt > now);
  const rows = live.map((a) => `<tr><td><span class="tag ${esc(a.kind)}">${esc(KINDS[a.kind] || a.kind)}</span></td><td><b>${esc(a.title)}</b><br><span class="muted">${esc(a.body)}</span>${a.link ? `<br><span class="muted note">${esc(a.linkText || "Link")}: ${esc(a.link)}</span>` : ""}${a.maxVersion ? `<br><span class="muted note">Only versions up to ${esc(a.maxVersion)}</span>` : ""}</td><td class="note">${a.startsAt > now ? "Starts " : "Since "}${fmt(a.startsAt)}<br>Until ${fmt(a.endsAt)}</td><td><form class="inline" method="post" action="${BASE}/announce/end"><input type="hidden" name="id" value="${esc(a.id)}"><button class="danger" type="submit">End now</button></form></td></tr>`).join("");
  const reqRows = pending.map((r) => `<tr><td>${esc(r.email || "(no email)")}<br><span class="muted note">${esc(r.id)}</span></td><td class="note">${fmt(r.at)}</td><td><form class="inline" method="post" action="${BASE}/scorer"><input type="hidden" name="lic" value="${esc(r.id)}"><input type="hidden" name="action" value="approved"><button type="submit">Approve</button></form> <form class="inline" method="post" action="${BASE}/scorer"><input type="hidden" name="lic" value="${esc(r.id)}"><input type="hidden" name="action" value="revoked"><button class="ghost" type="submit">Decline</button></form></td></tr>`).join("");
  return adminPage("Admin", `<h1>Copycat Hunt admin</h1><p class="muted">Signed in as ${ADMIN_EMAIL}. Messages reach users within about an hour.</p>${msg ? `<div class="card"><b>${esc(msg)}</b></div>` : ""}
<h2>New message for users</h2><form class="card" method="post" action="${BASE}/announce" id="ann">
<div class="row"><div><label for="kind">Type</label><select id="kind" name="kind"><option value="info">Announcement (users can close it)</option><option value="maintenance">Maintenance (shown until it ends)</option><option value="price">Price change</option></select></div>
<div><label for="maxVersion">Only show to versions up to (optional)</label><input id="maxVersion" name="maxVersion" placeholder="e.g. 3.34.9"></div></div>
<label for="title">Title</label><input id="title" name="title" maxlength="80" required placeholder="Scheduled maintenance">
<label for="body">Message</label><textarea id="body" name="body" maxlength="300" required placeholder="The hijack check will be unavailable on Saturday from 10:00 to 11:00 UTC."></textarea>
<div class="row"><div><label for="link">Link (optional, https)</label><input id="link" name="link" placeholder="https://copycathunt.com/..."></div><div><label for="linkText">Link text</label><input id="linkText" name="linkText" maxlength="30" placeholder="Read more"></div></div>
<div class="row"><div><label for="start">Show from (your local time; empty = now)</label><input id="start" type="datetime-local"></div><div><label for="end">Show until (empty = until you end it)</label><input id="end" type="datetime-local"></div></div>
<input type="hidden" name="startsAt" id="startsAt"><input type="hidden" name="endsAt" id="endsAt">
<p style="margin-top:18px"><button type="submit">Publish</button></p></form>
<script>document.getElementById("ann").addEventListener("submit",function(){var s=document.getElementById("start").value,e=document.getElementById("end").value;document.getElementById("startsAt").value=s?String(new Date(s).getTime()):"";document.getElementById("endsAt").value=e?String(new Date(e).getTime()):"";});</script>
<h2>Live and scheduled messages</h2>${rows ? `<div class="card"><table>${rows}</table></div>` : `<p class="muted">None.</p>`}
<h2>Scorer access requests</h2>${reqRows ? `<div class="card"><table>${reqRows}</table></div>` : `<p class="muted">No pending requests.</p>`}
<h2>Approve or remove a license by ID</h2><form class="card" method="post" action="${BASE}/scorer"><label for="lic">Keygen license ID</label><input id="lic" name="lic" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" required>
<p style="margin-top:14px"><button type="submit" name="action" value="approved">Approve scorer</button> <button class="ghost" type="submit" name="action" value="revoked">Remove scorer</button></p>
<p class="muted note">The customer sees the change the next time Copycat Hunt checks their license (they can press "Check again").</p></form>
<form method="post" action="${BASE}/logout"><button class="ghost" type="submit">Sign out</button></form>`);
}

async function admin(request, env, url, now) {
  const p = url.pathname;
  if (p === BASE + "/auth") {
    const q = request.method === "POST" ? await request.formData() : url.searchParams;
    const exp = Number(q.get("exp"));
    const sig = String(q.get("sig") || "");
    const expired = adminPage("Link expired", `<h1>This sign-in link has expired or was already used</h1><p><a href="${BASE}">Ask for a new one</a>.</p>`, 403);
    if (!Number.isFinite(exp) || exp < now || !/^[0-9a-f]{64}$/.test(sig) || !sameHex(sig, await sign(env, "link." + exp))) return expired;
    if (await env.OPS.get("used:" + sig)) return expired;
    if (request.method === "GET") {
      return adminPage("Sign in", `<h1>Copycat Hunt admin</h1><p class="muted">Press the button to sign in. This link works once.</p><form method="post" action="${BASE}/auth"><input type="hidden" name="exp" value="${exp}"><input type="hidden" name="sig" value="${esc(sig)}"><button type="submit">Continue to admin</button></form>`);
    }
    if (request.method !== "POST" || !sameOrigin(request)) return adminPage("Blocked", "<h1>Blocked</h1>", 403);
    await env.OPS.put("used:" + sig, "1", { expirationTtl: Math.max(60, Math.ceil((exp - now) / 1000) + 60) });
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
    await env.OPS.put("sess:" + id, String(now), { expirationTtl: IDLE_S });
    return new Response(null, { status: 303, headers: { location: BASE, "set-cookie": `ops=${id}.${await sign(env, "session." + id)}; Path=${BASE}; HttpOnly; Secure; SameSite=Lax`, "cache-control": "no-store" } });
  }
  if (p === BASE + "/login" && request.method === "POST") {
    if (!sameOrigin(request)) return adminPage("Blocked", "<h1>Blocked</h1>", 403);
    if (env.OPS && (await env.OPS.get("login-sent"))) return adminPage("Check your inbox", `<h1>Check your inbox</h1><p>A sign-in link was sent less than a minute ago to ${ADMIN_EMAIL}.</p>`);
    const exp = now + LINK_MS;
    await sendMail(env, ADMIN_EMAIL, "Your Copycat Hunt admin sign-in link", `Sign in to the Copycat Hunt admin page (link works once, within 15 minutes):\n${ORIGIN}${BASE}/auth?exp=${exp}&sig=${await sign(env, "link." + exp)}\n\nDidn't ask for this? Ignore this email.`);
    if (env.OPS) await env.OPS.put("login-sent", "1", { expirationTtl: 60 });
    return adminPage("Check your inbox", `<h1>Check your inbox</h1><p>We sent a sign-in link to ${ADMIN_EMAIL}. It works for 15 minutes.</p>`);
  }
  const sid = await session(request, env, now);
  if (!sid) {
    if (request.method !== "GET") return adminPage("Signed out", `<h1>You're signed out</h1><p><a href="${BASE}">Sign in again</a>.</p>`, 401);
    return adminPage("Sign in", `<h1>Copycat Hunt admin</h1><p class="muted">We'll email a sign-in link to ${ADMIN_EMAIL}.</p><form method="post" action="${BASE}/login"><button type="submit">Email me a sign-in link</button></form>`);
  }
  if (request.method === "POST" && !sameOrigin(request)) return adminPage("Blocked", "<h1>Blocked</h1>", 403);
  if (p === BASE && request.method === "GET") return dashboard(env, now, url.searchParams.get("msg") || "");
  const form = request.method === "POST" ? await request.formData() : null;
  const back = (msg) => new Response(null, { status: 303, headers: { location: BASE + "?msg=" + encodeURIComponent(msg), "cache-control": "no-store" } });
  if (p === BASE + "/logout" && form) {
    await env.OPS.delete("sess:" + sid);
    return new Response(null, { status: 303, headers: { location: BASE, "set-cookie": `ops=; Path=${BASE}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`, "cache-control": "no-store" } });
  }
  if (p === BASE + "/announce" && form) {
    const kind = KINDS[form.get("kind")] ? form.get("kind") : "info";
    const title = str(form.get("title"), 80);
    const body = str(form.get("body"), 300);
    let link = str(form.get("link"), 300);
    if (link && !/^https:\/\/[^\s"<>]+$/.test(link)) return back("The link must start with https://");
    const startsAt = Number(form.get("startsAt")) || now;
    const endsAt = Number(form.get("endsAt")) || null;
    const maxVersion = str(form.get("maxVersion"), 12);
    if (!title || !body) return back("Title and message are required.");
    if (endsAt && endsAt <= startsAt) return back("The end must be after the start.");
    if (maxVersion && !VER_RE.test(maxVersion)) return back("Version must look like 3.34.9");
    const list = (await readAnnouncements(env)).filter((a) => !a.endsAt || a.endsAt > now - HISTORY_MS);
    list.unshift({ id: crypto.randomUUID(), kind, title, body, link, linkText: link ? str(form.get("linkText"), 30) || "Read more" : "", startsAt, endsAt, maxVersion, createdAt: now });
    await env.OPS.put("announcements", JSON.stringify(list.slice(0, MAX_ANNOUNCEMENTS)));
    return back("Published.");
  }
  if (p === BASE + "/announce/end" && form) {
    const id = str(form.get("id"), 64);
    const list = (await readAnnouncements(env)).map((a) => (a.id === id ? { ...a, endsAt: now } : a));
    await env.OPS.put("announcements", JSON.stringify(list));
    return back("Message ended.");
  }
  if (p === BASE + "/scorer" && form) {
    const lic = str(form.get("lic"), 40).toLowerCase();
    const action = form.get("action") === "revoked" ? "revoked" : "approved";
    if (!UUID_RE.test(lic)) return back("That isn't a license ID.");
    try {
      const meta = await setScorer(env, lic, action, now);
      if (action === "approved" && meta.email) {
        await sendMail(env, meta.email, "Image scorer access approved | Copycat Hunt",
          `Hi,\n\nYour request for the Copycat Hunt image scorer (beta) is approved. Open the Copycat Hunt menu and press "Check again" in the Image scorer section, or wait until the next license check (within a day).\n\nThe scorer is in beta: its ranking helps you spot likely copies, but always check each listing yourself before reporting.\n\nCopycat Hunt Support\nhttps://copycathunt.com`).catch(() => {});
      }
      return back(action === "approved" ? "Scorer approved." : "Scorer access removed.");
    } catch (e) {
      return back("Couldn't update the license: " + String(e.message).slice(0, 60));
    }
  }
  return adminPage("Not found", "<h1>Not found</h1>", 404);
}

export async function handleOps(request, env, url, now, deps) {
  keygenApi = deps.keygenApi;
  env = env || {};
  const p = url.pathname;
  if (p === "/v1/announcements") return request.method === "GET" ? publicAnnouncements(env, now, url.searchParams.get("history") === "1") : jsonRes(405, { error: "method" });
  if (p === "/v1/scorer/access") return request.method === "POST" ? scorerAccess(request, env, now, deps) : jsonRes(405, { error: "method" });
  const base = typeof env.ADMIN_PATH === "string" && /^\/[A-Za-z0-9_-]{8,64}$/.test(env.ADMIN_PATH) ? env.ADMIN_PATH : "";
  if (base && (p === base || p.startsWith(base + "/"))) {
    BASE = base;
    if (url.hostname !== "api.copycathunt.com") return new Response("Not found", { status: 404 });
    if (!env.OPS || !env.LICENSE_KEY_SECRET) return adminPage("Not ready", "<h1>Admin isn't set up yet</h1>", 503);
    return admin(request, env, url, now);
  }
  return null;
}
