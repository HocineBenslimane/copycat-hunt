(function () {
  "use strict";
  if (window.top !== window || self.EifMessagesPage) return;
  const store = self.chrome && chrome.storage && chrome.storage.local;
  if (!store) return;

  const KINDS = { info: "Announcement", maintenance: "Maintenance", price: "Price change" };
  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
  --bg: #1d1e21; --line: rgba(255,255,255,.09); --text: #e6e6ea; --strong: #fff; --muted: #9a9aa2;
  --accent: #2ee6a6; --accent-hi: #5cefbd; --ink: #08251a; --btn: rgba(255,255,255,.08); --btn-hi: rgba(255,255,255,.13);
  --info: #2ee6a6; --maintenance: #ffb340; --price: #64b5ff;
  font: 14px/1.55 "CH Plex Sans", "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  color: var(--text); -webkit-font-smoothing: antialiased;
}
.wrap.light {
  --bg: #fff; --line: rgba(17,19,24,.1); --text: #2a2d34; --strong: #15171c; --muted: #636875;
  --btn: rgba(17,19,24,.06); --btn-hi: rgba(17,19,24,.1); --info: #0a8a5c; --maintenance: #b36b00; --price: #0b63c5;
}
button { font: inherit; color: inherit; cursor: pointer; }
.back { position: fixed; inset: 0; z-index: 2147483640; background: rgba(0,0,0,.5); }
.win {
  position: fixed; left: 50%; top: 50%; z-index: 2147483641; transform: translate(-50%, -50%);
  width: min(480px, calc(100vw - 32px)); max-height: min(600px, calc(100vh - 48px)); display: flex; flex-direction: column;
  background: var(--bg); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 16px 48px rgba(0,0,0,.35); outline: none;
}
.top { display: flex; align-items: center; gap: 8px; padding: 16px 20px 0; color: var(--muted); font-size: 12.5px; }
.kind { font-weight: 600; }
.kind.info { color: var(--info); }
.kind.maintenance { color: var(--maintenance); }
.kind.price { color: var(--price); }
.sep { opacity: .6; }
.x { margin-left: auto; width: 28px; height: 28px; margin-right: -6px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font-size: 20px; line-height: 1; }
.x:hover { background: var(--btn); color: var(--strong); }
.body { overflow-y: auto; overscroll-behavior: contain; padding: 8px 20px 4px; }
.title { margin: 0 0 8px; color: var(--strong); font-size: 18px; line-height: 1.3; font-weight: 600; }
.text { white-space: pre-line; overflow-wrap: anywhere; }
.foot { display: flex; justify-content: flex-end; gap: 8px; padding: 16px 20px 18px; }
.btn { min-height: 34px; padding: 0 14px; border: 0; border-radius: 8px; font-size: 13.5px; font-weight: 600; text-decoration: none; display: inline-flex; align-items: center; }
.btn.primary { background: var(--accent); color: var(--ink); }
.btn.primary:hover { background: var(--accent-hi); }
.btn.plain { background: var(--btn); color: var(--strong); }
.btn.plain:hover { background: var(--btn-hi); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.win:focus-visible { outline: none; }
`;

  let items = [];
  let read = new Set();
  let seen = new Set();
  let host = null;
  let root = null;
  let openId = "";
  let lastFocus = null;
  let mode = "dark";

  const h = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null && text !== "") n.textContent = text;
    return n;
  };
  const date = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  const isLight = () => mode === "light" || (mode === "system" && !!(self.matchMedia && matchMedia("(prefers-color-scheme: light)").matches));

  function ensureRoot() {
    if (host && host.isConnected) return;
    host = document.createElement("copycat-hunt-messages");
    host.id = "eif-messages";
    host.style.setProperty("display", "block", "important");
    root = host.attachShadow({ mode: "closed" });
    const style = h("style");
    style.textContent = CSS;
    root.append(style, h("div", "wrap"));
    document.documentElement.appendChild(host);
    host.addEventListener("keydown", onKey);
  }

  function saveIds() {
    const ids = new Set(items.map((m) => m.id));
    store.get({ eifMessagesRead: [], eifMessagesSeen: [] }, (d) => {
      const r = new Set([...(Array.isArray(d.eifMessagesRead) ? d.eifMessagesRead : []), ...read]);
      const s = new Set([...(Array.isArray(d.eifMessagesSeen) ? d.eifMessagesSeen : []), ...seen]);
      store.set({ eifMessagesRead: [...r].filter((id) => ids.has(id)), eifMessagesSeen: [...s].filter((id) => ids.has(id)) });
    });
  }

  function render() {
    const m = openId && items.find((x) => x.id === openId);
    if (!m) {
      if (host) root.querySelector(".wrap").textContent = "";
      return;
    }
    ensureRoot();
    const w = root.querySelector(".wrap");
    w.className = "wrap" + (isLight() ? " light" : "");
    w.textContent = "";
    const back = h("div", "back");
    back.addEventListener("mousedown", close);
    const win = h("div", "win");
    win.setAttribute("role", "dialog");
    win.setAttribute("aria-modal", "true");
    win.setAttribute("aria-label", m.title);
    win.tabIndex = -1;
    const top = h("div", "top");
    top.append(h("span", `kind ${m.kind}`, KINDS[m.kind]), h("span", "sep", "·"), h("span", "", date(m.startsAt)), h("span", "sep", "·"), h("span", "", "Copycat Hunt"));
    const x = h("button", "x", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    x.addEventListener("click", close);
    top.append(x);
    const body = h("div", "body");
    body.append(h("h2", "title", m.title));
    if (m.body) body.append(h("div", "text", m.body));
    const foot = h("div", "foot");
    if (m.link) {
      const a = h("a", "btn plain", m.linkText || "Read more");
      a.href = m.link;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      foot.append(a);
    }
    const ok = h("button", "btn primary", "Got it");
    ok.type = "button";
    ok.addEventListener("click", close);
    foot.append(ok);
    win.append(top, body, foot);
    w.append(back, win);
    win.focus();
    if (!read.has(m.id)) {
      read.add(m.id);
      saveIds();
    }
  }

  function show(id) {
    if (!items.some((m) => m.id === id)) return false;
    if (!openId) lastFocus = document.activeElement;
    openId = id;
    render();
    return true;
  }
  function close() {
    openId = "";
    render();
    if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) {}
    lastFocus = null;
    showNew();
  }
  function onKey(e) {
    e.stopPropagation();
    if (!openId) return;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    const f = [...root.querySelectorAll(".win button, .win a[href]")];
    if (!f.length) return;
    const i = f.indexOf(root.activeElement);
    const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === f.length - 1 ? 0 : i + 1);
    e.preventDefault();
    f[next].focus();
  }

  function showNew() {
    if (openId || document.visibilityState !== "visible") return;
    const m = items.find((x) => x.live && !read.has(x.id) && !seen.has(x.id));
    if (!m) return;
    seen.add(m.id);
    saveIds();
    show(m.id);
  }

  function load(d) {
    items = (d.eifMessages && Array.isArray(d.eifMessages.items) ? d.eifMessages.items : []).filter((m) => m && m.id && KINDS[m.kind] && m.title);
    if (Array.isArray(d.eifMessagesRead)) read = new Set(d.eifMessagesRead);
    if (Array.isArray(d.eifMessagesSeen)) seen = new Set(d.eifMessagesSeen);
    if (openId && !items.some((m) => m.id === openId)) openId = "";
    showNew();
  }
  const reload = (then) => store.get({ eifMessages: null, eifMessagesRead: null, eifMessagesSeen: null }, (d) => { load(d); if (then) then(); });

  store.get({ eifAppearance: "dark" }, (d) => { mode = d.eifAppearance || "dark"; reload(); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.eifAppearance) { mode = ch.eifAppearance.newValue || "dark"; render(); }
    if (ch.eifMessages || ch.eifMessagesRead || ch.eifMessagesSeen) reload();
  });
  document.addEventListener("visibilitychange", showNew);
  try { chrome.runtime.sendMessage({ type: "eif-messages" }, () => void chrome.runtime.lastError); } catch (e) {}
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || msg.type !== "eif-messages-open" || sender.id !== chrome.runtime.id) return;
    reload(() => reply({ ok: show(String(msg.id || "")) }));
    return true;
  });
  self.EifMessagesPage = { show };
})();
