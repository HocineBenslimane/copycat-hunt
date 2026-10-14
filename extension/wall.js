// Copycat Hunt setup page: the moving wall of shirts on the right (v3.20.0).
// Every shirt is drawn here (no images, no real designs): a tee in a few
// colours with a simple shape, a status tag and a match %. Four columns move
// slowly up and down in turn. Plain CSS animation; it stands still with the
// Animations switch off or the system's "reduce motion", and is hidden on
// narrow windows (setup.css).
(function () {
  "use strict";
  const wall = document.getElementById("wall");
  if (!wall) return;

  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  const SHIRTS = ["#121214", "#1f2a44", "#7a1f2b", "#2b2b30", "#f2f2f2", "#2d4a3a", "#4a3b2a"];
  const ART = {
    sun: (ink) => `<circle cx="60" cy="62" r="14" fill="#ffb340"/><rect x="40" y="80" width="40" height="5" rx="2" fill="${ink}" opacity=".8"/>`,
    stripes: () => `<rect x="38" y="52" width="44" height="6" rx="3" fill="#ff6159"/><rect x="38" y="62" width="44" height="6" rx="3" fill="#ffb340"/><rect x="38" y="72" width="44" height="6" rx="3" fill="#2ee6a6"/>`,
    star: () => `<path d="M60 48l5 11 12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1z" fill="#ffd60a"/>`,
    text: (ink) => `<rect x="40" y="52" width="40" height="8" rx="2" fill="${ink}"/><rect x="44" y="64" width="32" height="8" rx="2" fill="#ff6159"/><rect x="40" y="76" width="40" height="8" rx="2" fill="${ink}"/>`,
    drop: () => `<path d="M60 46c8 12 12 18 12 24a12 12 0 0 1-24 0c0-6 4-12 12-24z" fill="#64b5ff"/>`,
    hills: () => `<path d="M38 82l12-18 8 10 6-8 18 16z" fill="#a78bfa"/><circle cx="70" cy="56" r="5" fill="#ffd60a"/>`,
    heart: () => `<path d="M60 82c-14-9-20-15-20-23a9 9 0 0 1 20-4 9 9 0 0 1 20 4c0 8-6 14-20 23z" fill="#ff6159"/>`,
  };
  const TAGS = [
    ["Copy found", "#ff6159", "rgba(255,97,89,.15)"],
    ["Your design", "#2ee6a6", "rgba(46,230,166,.15)"],
    ["Tracked", "#ffb340", "rgba(255,179,64,.15)"],
    ["Reported", "#a78bfa", "rgba(167,139,250,.15)"],
    ["Removed ✓", "#2ee6a6", "rgba(46,230,166,.15)"],
  ];

  function tee() {
    const shirt = pick(SHIRTS);
    const ink = shirt === "#f2f2f2" ? "#121214" : "#2ee6a6";
    const art = ART[pick(Object.keys(ART))](ink);
    const back = shirt === "#121214" ? "#ffffff" : shirt === "#f2f2f2" ? "#2a2a2e" : "#e9e9ee";
    const [label, fg, bg] = pick(TAGS);
    const match = 72 + Math.floor(rnd() * 28);
    return `<div class="wc"><div class="wimg" style="background:${back}"><svg viewBox="0 0 120 120" aria-hidden="true"><path d="M42 22l-22 14 10 16 8-4v52h44V48l8 4 10-16-22-14c-3 6-9 9-18 9s-15-3-18-9z" fill="${shirt}" stroke="rgba(255,255,255,.08)"/>${art}</svg></div><div class="wmeta"><span class="wtag" style="color:${fg};background:${bg}">${label}</span><span class="wm">${match}%</span></div></div>`;
  }

  // Each column holds its cards twice, so moving it by half its height loops
  // without a jump.
  const cols = [];
  for (let c = 0; c < 4; c++) {
    const cards = Array.from({ length: 6 }, tee).join("");
    cols.push(`<div class="wcol ${c % 2 ? "down" : "up"}"><div class="wtrack" style="animation-duration:${46 + c * 7}s">${cards}${cards}</div></div>`);
  }
  wall.innerHTML = `<div class="wcols">${cols.join("")}</div><div class="wfade"></div>`;

  // Stand still when animations are off in the menu.
  const apply = (p) => wall.classList.toggle("still", !!(p && p.animations === false));
  try {
    chrome.storage.local.get({ eifPrefs: {} }, (d) => apply(d && d.eifPrefs));
    chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.eifPrefs) apply(ch.eifPrefs.newValue); });
  } catch (e) { /* not an extension page */ }
})();
