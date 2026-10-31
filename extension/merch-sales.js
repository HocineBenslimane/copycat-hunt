(function (root) {
  "use strict";

  const REPORT_URL = "https://merch.amazon.com/api/reporting/purchases/report";
  const MARKETPLACES = { US: "ATVPDKIKX0DER", UK: "A1F83G8C2ARO7P", DE: "A1PA6795UKMFR9", FR: "A13V1IB3VIYZZH", IT: "APJ6JRA9NG5V4", ES: "A1RKKUPIHCS9HS" };
  const CODES = new Set(Object.keys(MARKETPLACES));
  const KEEP_DAYS = 365;
  const CHUNK_DAYS = 31;
  const REFRESH_DAYS = 14;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const TZ = "America/Los_Angeles";

  const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const partsFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

  function ptDay(ms) {
    return dayFmt.format(new Date(ms));
  }

  function ptOffset(ms) {
    const p = {};
    for (const x of partsFmt.formatToParts(new Date(ms))) p[x.type] = x.value;
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
  }

  function ptMidnight(day) {
    const [y, m, d] = String(day).split("-").map(Number);
    const utc = Date.UTC(y, m - 1, d);
    return utc - ptOffset(utc + 12 * 60 * 60 * 1000);
  }

  function addDays(day, n) {
    const [y, m, d] = String(day).split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

  function dayOf(value) {
    if (value == null || value === "") return "";
    if (typeof value === "number") return Number.isFinite(value) ? ptDay(value) : "";
    const s = String(value).trim();
    if (isDay(s)) return s;
    if (/^\d{10,13}$/.test(s)) return ptDay(Number(s));
    const t = Date.parse(s);
    return Number.isFinite(t) ? ptDay(t) : "";
  }

  function chunks(fromDay, toDay, size = CHUNK_DAYS) {
    const out = [];
    let end = toDay;
    while (end >= fromDay) {
      const start = addDays(end, -(size - 1)) < fromDay ? fromDay : addDays(end, -(size - 1));
      out.push({ from: start, to: end });
      end = addDays(start, -1);
    }
    return out;
  }

  function reportUrl(fromDay, toDay) {
    const ids = Object.values(MARKETPLACES).map((id) => `marketplaceId=${id}`).join("&");
    return `${REPORT_URL}?${ids}&fromDate=${ptMidnight(fromDay)}&toDate=${ptMidnight(addDays(toDay, 1)) - 1}`;
  }

  const count = (v) => {
    if (v == null || v === "" || typeof v === "boolean") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  };
  const first = (o, keys) => {
    for (const k of keys) if (o && o[k] != null && o[k] !== "") return o[k];
    return null;
  };
  const SOLD = ["unitsSold", "units", "quantity"];
  const CANCELLED = ["unitsCancelled", "cancelledUnits"];
  const RETURNED = ["unitsReturned", "returnedUnits"];
  const DATE_KEYS = ["period", "date", "day", "purchaseDate", "orderDate", "saleDate", "transactionDate", "timestamp"];

  function unitsOf(item) {
    const own = { sold: count(first(item, SOLD)), cancelled: count(first(item, CANCELLED)), returned: count(first(item, RETURNED)) };
    const vars = Array.isArray(item.salesAggregateForVariations) ? item.salesAggregateForVariations : [];
    if (own.sold != null || !vars.length) return { sold: own.sold || 0, cancelled: own.cancelled || 0, returned: own.returned || 0 };
    const sum = { sold: 0, cancelled: 0, returned: 0 };
    for (const v of vars) {
      if (!v || typeof v !== "object") continue;
      sum.sold += count(first(v, SOLD)) || 0;
      sum.cancelled += count(first(v, CANCELLED)) || 0;
      sum.returned += count(first(v, RETURNED)) || 0;
    }
    return sum;
  }

  function parseReport(data, fromDay, toDay, normalizeMarketplace, normalizeAsin) {
    const rows = new Map();
    let skipped = 0;
    const add = (item, mpHint, dayHint) => {
      if (!item || typeof item !== "object") return;
      const asin = normalizeAsin(item.asin);
      const mp = normalizeMarketplace(item.marketplaceId || item.marketplace || mpHint);
      const day = dayHint || dayOf(first(item, DATE_KEYS));
      if (!asin || !CODES.has(mp) || !isDay(day) || (fromDay && day < fromDay) || (toDay && day > toDay)) {
        skipped++;
        return;
      }
      const u = unitsOf(item);
      if (!u.sold && !u.cancelled && !u.returned) return;
      const k = `${day}|${mp}|${asin}`;
      const r = rows.get(k) || { day, marketplace: mp, asin, sold: 0, cancelled: 0, returned: 0 };
      r.sold += u.sold;
      r.cancelled += u.cancelled;
      r.returned += u.returned;
      rows.set(k, r);
    };
    const walk = (value, mpHint, dayHint, depth) => {
      if (!value || typeof value !== "object" || depth > 4) return;
      if (Array.isArray(value)) {
        for (const v of value) walk(v, mpHint, dayHint, depth + 1);
        return;
      }
      if (value.asin) return add(value, mpHint, dayHint);
      for (const [key, v] of Object.entries(value)) {
        const d = dayOf(key);
        if (isDay(key) || (d && /^\d{10,13}$/.test(key))) walk(v, mpHint, d, depth + 1);
        else if (/^[A-Z]{2}$/.test(normalizeMarketplace(key))) walk(v, key, dayHint, depth + 1);
        else walk(v, mpHint, dayHint, depth + 1);
      }
    };
    if (!data || typeof data !== "object") return null;
    walk(data, "", "", 0);
    return { rows: [...rows.values()], skipped };
  }

  async function fetchPeriod(period, deps) {
    const MC = deps.MC;
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const timeoutMs = deps.timeoutMs || 60000;
    for (let attempt = 0; attempt < 4; attempt++) {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; if (ctrl) ctrl.abort(); }, timeoutMs);
      let res;
      let text;
      try {
        res = await deps.fetch(reportUrl(period.from, period.to), {
          method: "GET",
          credentials: "include",
          headers: { Accept: "application/json" },
          ...(ctrl ? { signal: ctrl.signal } : {}),
        });
        if (res.status === 429 || /(?:^|\/)429(?:[/?#]|$)/.test(String(res.url || "").replace(/^https?:\/\/[^/]+/, ""))) {
          clearTimeout(timer);
          if (attempt === 3) return { ok: false, reason: "rate_limited" };
          const wait = Math.min(Math.max(MC.retryAfterMs(res), 3000 * (attempt + 1)), 5 * 60 * 1000);
          if (deps.onWait) await deps.onWait(wait);
          await sleep(wait);
          continue;
        }
        if (res.status === 401 || res.status === 403 || res.redirected || /\/ap\/signin/i.test(res.url || "")) { clearTimeout(timer); return { ok: false, reason: "logged_out" }; }
        if (!res.ok) {
          clearTimeout(timer);
          if (res.status >= 500 && attempt < 3) {
            await sleep(1500 * (attempt + 1));
            continue;
          }
          return { ok: false, reason: `http_${res.status}` };
        }
        const type = res.headers && typeof res.headers.get === "function" ? res.headers.get("content-type") || "" : "";
        if (type && !/json/i.test(type)) { clearTimeout(timer); return { ok: false, reason: "logged_out" }; }
        text = await res.text();
        clearTimeout(timer);
      } catch (e) {
        clearTimeout(timer);
        if (attempt === 3) return { ok: false, reason: timedOut ? "timeout" : "network" };
        await sleep(1000 * (attempt + 1));
        continue;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return { ok: false, reason: "logged_out" };
      }
      const parsed = parseReport(data, period.from, period.to, MC.normalizeMarketplace, MC.normalizeAsin);
      if (!parsed) return { ok: false, reason: "unexpected_response" };
      return { ok: true, rows: parsed.rows, skipped: parsed.skipped };
    }
    return { ok: false, reason: "network" };
  }

  function plan(meta, account, today) {
    const yearFrom = addDays(today, -(KEEP_DAYS - 1));
    const fresh = meta && meta.account === account && isDay(meta.coveredFrom) && isDay(meta.coveredTo) && meta.coveredFrom <= yearFrom && meta.coveredTo >= addDays(today, -REFRESH_DAYS);
    const from = fresh ? addDays(meta.coveredTo, -REFRESH_DAYS) : yearFrom;
    return { from: from < yearFrom ? yearFrom : from, to: today, full: !fresh, keepFrom: yearFrom };
  }

  const api = { REPORT_URL, MARKETPLACES, KEEP_DAYS, CHUNK_DAYS, REFRESH_DAYS, DAY_MS, ptDay, ptMidnight, addDays, dayOf, chunks, reportUrl, unitsOf, parseReport, fetchPeriod, plan };
  root.EifMerchSales = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
