(function (root) {
  "use strict";
  // Display helpers for the toolbar menu. Nothing here decides whether a
  // license is valid: only the service worker does that (license-service.js).
  const CONFIG = Object.freeze({
    buyUrl: "", // where people buy a license (optional, https only)
  });

  function formatExpiry(expiry) {
    if (typeof expiry !== "string") return "";
    const d = new Date(expiry);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function daysLeft(expiry) {
    const t = typeof expiry === "string" ? Date.parse(expiry) : NaN;
    return Number.isFinite(t) ? Math.ceil((t - Date.now()) / 86400000) : null;
  }

  const api = Object.freeze({ CONFIG, formatExpiry, daysLeft });
  root.EifLicense = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : globalThis);
