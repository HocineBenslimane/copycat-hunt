// Copycat Hunt: small animation helpers (v3.18.0; eBay/Amazon pages v3.18.1).
//
// Every animation (menu, setup page, the panel on eBay/Amazon) goes through here, so one
// place decides whether motion runs at all:
//   - the "Animations" switch in the menu (eifPrefs.animations, on by default),
//   - the system "reduce motion" setting,
//   - GSAP being loaded (vendor/gsap.min.js, the unmodified npm file).
// When motion is off, every helper still sets the final state (the bar width,
// the number, the new text), so nothing depends on an animation finishing.
(function (root) {
  "use strict";

  let prefOn = true;
  const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  const G = () => (typeof root.gsap === "object" || typeof root.gsap === "function" ? root.gsap : null);
  const enabled = () => !!(prefOn && G() && !(mq && mq.matches));

  function setPref(v) {
    prefOn = v !== false;
    if (!prefOn && G()) G().globalTimeline.getChildren(true, true, true).forEach((t) => t.progress(1));
  }
  // Extension pages can read the switch themselves.
  try {
    if (root.chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ eifPrefs: {} }, (d) => setPref(!(d && d.eifPrefs && d.eifPrefs.animations === false)));
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === "local" && ch.eifPrefs) setPref(!(ch.eifPrefs.newValue && ch.eifPrefs.newValue.animations === false));
      });
    }
  } catch (e) { /* not an extension page */ }

  const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");

  // Progress bar: <div class="bar"><i></i></div>. The fill is scaled, not
  // resized, so it stays smooth. pct 0–100.
  function bar(fill, pct) {
    if (!fill) return;
    const v = Math.max(0, Math.min(100, Number(pct) || 0)) / 100;
    if (fill._v === v) return;
    fill._v = v;
    if (enabled()) G().to(fill, { scaleX: v, duration: 0.6, ease: "power2.out", overwrite: true });
    else fill.style.transform = `scaleX(${v})`;
  }

  // A number that counts to its new value.
  function count(el, value) {
    if (!el) return;
    const to = Math.max(0, Math.round(Number(value) || 0));
    const from = el._n == null ? to : el._n;
    el._n = to;
    if (from === to || !enabled()) { el.textContent = fmt(to); return; }
    // Start from what's on screen if the last count hadn't finished.
    const o = { n: el._o ? el._o.n : from };
    if (el._tw) el._tw.kill();
    el._o = o;
    el._tw = G().to(o, { n: to, duration: Math.min(0.9, 0.35 + Math.abs(to - o.n) / 4000), ease: "power1.out", onUpdate: () => (el.textContent = fmt(o.n)), onComplete: () => { el._o = null; el.textContent = fmt(to); } });
  }

  // A line of text that slides up to its new value.
  function swap(el, text) {
    if (!el || el._t === text) return;
    const first = el._t == null;
    el._t = text;
    if (first || !enabled()) { el.textContent = text; return; }
    G().timeline()
      .to(el, { y: -6, autoAlpha: 0, duration: 0.14, ease: "power1.in" })
      .add(() => (el.textContent = text))
      .fromTo(el, { y: 6 }, { y: 0, autoAlpha: 1, duration: 0.22, ease: "power2.out" });
  }

  // "Just synced" feed: newest titles slide in at the top, 3 lines kept.
  function feed(box, titles) {
    if (!box) return;
    const list = (Array.isArray(titles) ? titles : []).filter((t) => typeof t === "string" && t.trim()).slice(-3);
    const key = list.join("\n");
    if (box._k === key) return;
    box._k = key;
    const have = new Set([...box.children].map((c) => c.textContent));
    const fresh = list.filter((t) => !have.has(t));
    for (const t of fresh) {
      const li = document.createElement("li");
      li.textContent = t;
      box.prepend(li);
      if (enabled()) G().fromTo(li, { y: -10, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.3, ease: "power2.out" });
    }
    while (box.children.length > 3) box.lastElementChild.remove();
  }

  // The logo's three claw marks swipe in. loop: keep swiping while waiting.
  // Returns a stop function (stopping leaves the marks fully drawn).
  function claws(svg, opts = {}) {
    const marks = svg ? [...svg.querySelectorAll(".claw")] : [];
    if (!marks.length || !enabled()) return () => {};
    const g = G();
    // v3.19.2: each mark grows from its own base (its local 0,0, the bottom of
    // the scratch) by setting a plain SVG scale on the path. GSAP's own
    // transforms on a path inside a rotated group moved the marks up onto the
    // shoulder of the shirt.
    const state = marks.map(() => ({ s: 1, o: 1 }));
    const paint = () => marks.forEach((m, i) => {
      const k = Math.max(0.001, state[i].s).toFixed(3);
      const bx = m.getAttribute("data-bx"), by = m.getAttribute("data-by");
      m.setAttribute("transform", bx ? `translate(${bx} ${by}) scale(${k}) translate(${-bx} ${-by})` : `scale(1 ${k})`);
      m.setAttribute("opacity", state[i].o.toFixed(3));
    });
    // A loop stops by itself once its logo is gone from the page.
    const tl = g.timeline({ repeat: opts.loop ? -1 : 0, repeatDelay: 0.5, onUpdate: paint, onRepeat: () => { if (!svg.isConnected) tl.kill(); } });
    tl.fromTo(state, { s: 0, o: 1 }, { s: 1, duration: 0.3, ease: "power3.out", stagger: 0.08 });
    if (opts.loop) tl.to(state, { o: 0.15, duration: 0.35, ease: "power1.inOut" }, "+=0.6");
    return () => { tl.kill(); marks.forEach((m) => { m.removeAttribute("transform"); m.removeAttribute("opacity"); }); };
  }

  // A short "pop" for something that just finished (a step dot, a badge).
  function pop(el) {
    if (!el || !enabled()) return;
    G().fromTo(el, { scale: 0.6 }, { scale: 1, duration: 0.4, ease: "back.out(2.2)", clearProps: "transform" });
  }

  // Something new appears (a card, a message).
  function enter(el) {
    if (!el || !enabled()) return;
    G().fromTo(el, { y: 8, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.3, ease: "power2.out", clearProps: "transform,opacity,visibility" });
  }

  // Several new things at once (result cards): a short stagger, first 12 only.
  function enterMany(els) {
    const list = [...(els || [])].slice(0, 12);
    if (!list.length || !enabled()) return;
    G().fromTo(list, { y: 10, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.32, ease: "power2.out", stagger: 0.04, clearProps: "transform,opacity,visibility" });
  }

  // Words lighting up one after another (copied words in a title). The final
  // look comes from CSS; this only animates the way in.
  function mark(els) {
    const list = [...(els || [])];
    if (!list.length || !enabled()) return;
    G().fromTo(list, { backgroundColor: "rgba(46,230,166,0)" }, { backgroundColor: "rgba(46,230,166,0.26)", duration: 0.22, ease: "power1.out", stagger: 0.035, clearProps: "backgroundColor" });
  }

  // v3.20.0: crawling spiders for a search that's taking a while. One drops
  // down on a thread from the top edge and climbs back; two walk around the
  // card's edge; a faint web grows in the top-right corner. They never cover
  // the text (they stay on the border) and go away with the card.
  const SPIDER = `<svg viewBox="-14 -14 28 28" aria-hidden="true"><g class="legs-a" stroke="#2ee6a6" stroke-width="1.6" stroke-linecap="round" fill="none"><path d="M-3-2 L-9-7 L-12-3"/><path d="M-3 1 L-10 4 L-12 8"/><path d="M3 0 L10-2 L13 2"/><path d="M3 3 L8 8 L9 12"/></g><g class="legs-b" stroke="#2ee6a6" stroke-width="1.6" stroke-linecap="round" fill="none"><path d="M-3 0 L-10-2 L-13 2"/><path d="M-3 3 L-8 8 L-9 12"/><path d="M3-2 L9-7 L12-3"/><path d="M3 1 L10 4 L12 8"/></g><ellipse cx="0" cy="3" rx="4.2" ry="5.2" fill="#2ee6a6"/><circle cx="0" cy="-3.2" r="2.8" fill="#2ee6a6"/><circle cx="-1" cy="-3.6" r=".7" fill="#08251a"/><circle cx="1" cy="-3.6" r=".7" fill="#08251a"/></svg>`;
  function spiders(card) {
    if (!card || !enabled() || card._eifSpiders) return () => {};
    const g = G();
    const layer = document.createElement("div");
    layer.className = "eif-spiders";
    layer.innerHTML = `<svg class="eif-web" viewBox="0 0 70 70" fill="none" stroke="#2ee6a6" stroke-width=".8"><path d="M70 0 L0 70 M70 0 L20 70 M70 0 L0 20 M70 0 L45 70 M70 0 L0 45"/><path d="M58 0 Q62 8 70 12 M44 0 Q52 18 70 26 M30 0 Q42 28 70 40 M16 0 Q32 38 70 54"/></svg>
      <div class="eif-thread"></div><div class="eif-spider eif-dangler">${SPIDER}</div>
      <div class="eif-spider eif-walker">${SPIDER}</div><div class="eif-spider eif-walker">${SPIDER}</div>`;
    card.appendChild(layer);
    card._eifSpiders = true;
    const tweens = [];
    const alive = () => layer.isConnected;
    // The web fades in over ~20 s.
    tweens.push(g.fromTo(layer.querySelector(".eif-web"), { autoAlpha: 0 }, { autoAlpha: 0.32, duration: 20, ease: "none" }));
    // Dangler: lowers on its thread, sways, climbs back, waits, again.
    const thread = layer.querySelector(".eif-thread");
    const dangler = layer.querySelector(".eif-dangler");
    const dx = Math.round(card.clientWidth * 0.68);
    g.set([thread, dangler], { x: dx });
    const drop = { h: 0 };
    // It comes down from above the card and stops on its top edge, never over the text.
    g.set(thread, { y: -64 });
    const place = () => { g.set(thread, { height: drop.h }); g.set(dangler, { y: -64 + drop.h - 12 }); };
    const dtl = g.timeline({ repeat: -1, repeatDelay: 2.5, delay: 0.4, onUpdate: place, onRepeat: () => { if (!alive()) dtl.kill(); } });
    dtl.to(drop, { h: 58, duration: 1.6, ease: "power2.out" })
      .to(dangler, { rotation: 10, duration: 0.6, yoyo: true, repeat: 3, ease: "sine.inOut" }, ">")
      .to(drop, { h: 0, duration: 1.4, ease: "power2.in" }, ">");
    tweens.push(dtl);
    // Walkers go round the edge (clockwise), facing where they walk.
    const walkers = [...layer.querySelectorAll(".eif-walker")];
    walkers.forEach((w, i) => {
      const s = { t: i ? 0.55 : 0.08 };
      const tw = g.to(s, {
        t: `+=1`, duration: 38 + i * 9, ease: "none", repeat: -1, delay: i * 1.5,
        onUpdate: () => {
          if (!alive()) { tw.kill(); return; }
          const W = card.clientWidth, H = card.clientHeight, P = 2 * (W + H);
          let d = ((s.t % 1) + 1) % 1 * P, x, y, r;
          if (d < W) { x = d; y = 0; r = 90; }
          else if ((d -= W) < H) { x = W; y = d; r = 180; }
          else if ((d -= H) < W) { x = W - d; y = H; r = 270; }
          else { d -= W; x = 0; y = H - d; r = 0; }
          w.style.transform = `translate(${x - 11}px, ${y - 11}px) rotate(${r}deg)`;
        },
      });
      tweens.push(tw);
    });
    g.fromTo(layer.querySelectorAll(".eif-spider"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.6, stagger: 0.3 });
    return () => { tweens.forEach((t) => t.kill()); layer.remove(); card._eifSpiders = false; };
  }

  // Logo (v3.19.3: the owner's sharper vector art). The shirt is drawn solid
  // and the three scratches on top in mint, so each can grow from its own
  // base (data-bx/by) when animated. Looks the same as brand/logo.svg.
  function logoSvg(cls = "") {
    const mark = (d, bx, by) => `<path class="claw" data-bx="${bx}" data-by="${by}" fill="#2ee6a6" d="${d}"/>`;
    return `<svg class="${cls}" viewBox="0 0 125.83 125.67" aria-hidden="true" focusable="false"><rect fill="#2ee6a6" width="125.83" height="125.67" rx="28.22"/><path fill="#121214" d="M92.82,85.07v22.15h-59.81v-55.32l-5.43,3.62-13.21-17.5,22.33-19.57c4.1,2.69,8.35,5.57,12.44,8.28,1.38,1.17,3.37,4.16,4.94,5.1,5.33,3.17,10.8,3.4,16.42.7,2.49-1.2,4.27-3.88,6.27-5.87l12.34-8.21,22.33,19.56-13.16,17.54-5.48-3.66v25.7Z"/>${mark("M69.72,63.57l-22.56,35.98c-.05.08-.03.18.05.23,0,0,0,0,0,0l.05.04c1.65,1.01,8.02-6.19,14.24-16.1l.22-.35c6.22-9.91,9.92-18.78,8.29-19.82l-.05-.04c-.08-.05-.18-.03-.23.05,0,0,0,0,0,0Z", 47.2, 99.6)}${mark("M72.51,84.02c-3.63,5.78-7.09,11.86-10.37,18.26-.04.12.02.26.14.3.07.03.15.02.21-.03,4.83-4.12,9.36-9.55,13.6-16.29,4.23-6.74,7.16-13.18,8.77-19.32.02-.13-.07-.25-.2-.27-.08-.01-.16.02-.21.07-4.33,5.73-8.31,11.49-11.95,17.28Z", 62.2, 102.4)}${mark("M92.82,85.07c-6.36,9.09-11.98,18.42-16.85,27.98,6.52-3.7,13.17-14.33,16.85-20.5Z", 76, 113)}</svg>`;
  }

  root.EifMotion = { enabled, setPref, bar, count, swap, feed, claws, pop, enter, enterMany, mark, spiders, logoSvg, fmt };
})(typeof self !== "undefined" ? self : globalThis);
