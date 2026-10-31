(function () {
  if (self.EifTheme) return;
  const KEY = "eifAppearance";
  const MODES = ["dark", "light", "system"];
  const OWN_PAGE = location.protocol === "chrome-extension:";
  const mq = self.matchMedia ? matchMedia("(prefers-color-scheme: light)") : null;
  const listeners = [];
  let mode = "dark";
  const valid = (m) => (MODES.includes(m) ? m : "dark");
  const isLight = () => mode === "light" || (mode === "system" && !!(self.matchMedia && matchMedia("(prefers-color-scheme: light)").matches));
  function paint() {
    const light = isLight();
    document.documentElement.classList.toggle("eif-light", light);
    listeners.forEach((f) => { try { f(mode, light); } catch (e) {} });
  }
  function use(m) {
    mode = valid(m);
    if (OWN_PAGE) try { localStorage.setItem(KEY, mode); } catch (e) {}
    paint();
  }
  if (OWN_PAGE) try { mode = valid(localStorage.getItem(KEY)); } catch (e) {}
  paint();
  const store = self.chrome && chrome.storage && chrome.storage.local;
  if (store) {
    store.get({ [KEY]: "dark" }, (d) => { if (!chrome.runtime.lastError) use(d && d[KEY]); });
    chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch[KEY]) use(ch[KEY].newValue); });
  }
  const recheck = () => { if (mode === "system" && isLight() !== document.documentElement.classList.contains("eif-light")) paint(); };
  [mq, self.matchMedia && matchMedia("(prefers-color-scheme: dark)")].forEach((q) => q && q.addEventListener && q.addEventListener("change", recheck));
  self.addEventListener("focus", recheck);
  document.addEventListener("visibilitychange", recheck);
  self.EifTheme = {
    mode: () => mode,
    isLight,
    save(m) { use(m); if (store) store.set({ [KEY]: mode }); },
    onChange(f) { listeners.push(f); },
  };
})();
