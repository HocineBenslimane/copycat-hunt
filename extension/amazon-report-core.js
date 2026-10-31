(function (root) {
  "use strict";

  const MARKETPLACES = Object.freeze({
    US: { host: "www.amazon.com", label: "amazon.com", report: true },
    UK: { host: "www.amazon.co.uk", label: "amazon.co.uk", report: true },
    DE: { host: "www.amazon.de", label: "amazon.de", report: true },
    FR: { host: "www.amazon.fr", label: "amazon.fr", report: true },
    IT: { host: "www.amazon.it", label: "amazon.it", report: true },
    ES: { host: "www.amazon.es", label: "amazon.es", report: true },
  });
  const TARGET_LIMIT = 50;
  const DESCRIPTION_MAX = 2000;
  const ASIN_RE = /^[A-Z0-9]{10}$/;
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

  const ISSUES = Object.freeze({
    stolen_artwork: { label: "Stolen artwork", hint: "They uploaded your actual design file.", radio: "infringementTypeCOPYRIGHT_PRODUCT_PACKAGING" },
    copied_design: { label: "Copied design", hint: "They recreated or traced your design.", radio: "infringementTypeCOPYRIGHT_PRODUCT_PACKAGING" },
    modified_design: { label: "Copied with changes", hint: "They traced your design and added or changed something: a hat, glasses, an object, or different text.", radio: "infringementTypeCOPYRIGHT_PRODUCT_PACKAGING" },
    copied_listing: { label: "Copied listing", hint: "They copied your listing text.", radio: "infringementTypeCOPYRIGHT_TEXT" },
  });

  const DEFAULT_DESCRIPTIONS = Object.freeze({
    stolen_artwork:
      "I am reporting {count} listing(s) that use my original artwork without my permission. My original product is ASIN {original_asin} ({original_link}), first available on Amazon on {published}. The reported listings show the same artwork as my product. I did not authorize these sellers to use it. Reported on {today}.",
    copied_design:
      "I am reporting {count} listing(s) that copy my original design without my permission. My original product is ASIN {original_asin} ({original_link}), first available on Amazon on {published}. The reported listings reproduce my design. I did not authorize these sellers to use it. Reported on {today}.",
    modified_design:
      "I am reporting {count} listing(s) that copy my original design without my permission. My original product is ASIN {original_asin} ({original_link}), first available on Amazon on {published}. The reported listings reproduce my artwork with small changes, such as an added element or different text, but the copied artwork is clearly mine. I did not authorize these sellers to use it. Reported on {today}.",
    copied_listing:
      "I am reporting {count} listing(s) that copy the text of my original listing without my permission. My original product is ASIN {original_asin} ({original_link}), first available on Amazon on {published}. I did not authorize these sellers to use my listing content. Reported on {today}.",
  });
  const PLACEHOLDERS = ["original_asin", "original_link", "published", "count", "today"];

  function normalizeAsin(value) {
    const v = String(value == null ? "" : value).trim().toUpperCase();
    return ASIN_RE.test(v) ? v : null;
  }

  function normalizeMarketplace(value) {
    let v = String(value == null ? "" : value).trim().toUpperCase();
    if (v === "GB") v = "UK";
    return Object.prototype.hasOwnProperty.call(MARKETPLACES, v) ? v : null;
  }

  function marketplaceOfHost(hostname) {
    const h = String(hostname || "").toLowerCase();
    return Object.keys(MARKETPLACES).find((k) => MARKETPLACES[k].host === h || MARKETPLACES[k].host === `www.${h}`) || null;
  }
  function marketplaceLabel(marketplace) {
    const mp = normalizeMarketplace(marketplace);
    return mp ? MARKETPLACES[mp].label : "amazon.com";
  }
  function canReport(marketplace) {
    const mp = normalizeMarketplace(marketplace);
    return !!(mp && MARKETPLACES[mp].report);
  }

  function productKey(marketplace, asin) {
    const mp = normalizeMarketplace(marketplace);
    const a = normalizeAsin(asin);
    return mp && a ? `${mp}|${a}` : null;
  }

  function productUrl(marketplace, asin) {
    const mp = normalizeMarketplace(marketplace);
    const a = normalizeAsin(asin);
    return mp && a ? `https://${MARKETPLACES[mp].host}/dp/${a}` : "";
  }

  const AMAZON_HOST_RE = /^(?:www\.|smile\.|m\.)?amazon\.com$/i;

  function asinFromPath(text) {
    const m = String(text || "").match(/\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin)\/([A-Za-z0-9]{10})(?:[/?#&]|$)/);
    return m ? normalizeAsin(m[1]) : null;
  }

  function asinFromUrl(value) {
    let url;
    try {
      url = new URL(String(value || "").trim());
    } catch (e) {
      return null;
    }
    if (!/^https?:$/.test(url.protocol) || !AMAZON_HOST_RE.test(url.hostname)) return null;
    const direct = asinFromPath(url.pathname);
    if (direct) return direct;
    const pd = normalizeAsin(url.searchParams.get("pd_rd_i"));
    if (pd) return pd;
    let inner = url.searchParams.get("url") || "";
    for (let i = 0; i < 2 && inner; i++) {
      const found = asinFromPath(inner);
      if (found) return found;
      try {
        const next = decodeURIComponent(inner);
        if (next === inner) break;
        inner = next;
      } catch (e) {
        break;
      }
    }
    return null;
  }

  function parseTargetInput(text, options = {}) {
    const existing = new Set(options.existing || []);
    const owned = new Set(options.owned || []);
    const original = normalizeAsin(options.original);
    const locked = new Set(options.locked || []);
    const limit = options.limit || TARGET_LIMIT;
    let free = Math.max(0, limit - existing.size);
    const added = [];
    const rejected = [];
    const seen = new Set();
    const tokens = String(text || "").split(/[\s,;]+/).filter(Boolean);
    for (const raw of tokens) {
      const token = raw.slice(0, 300);
      let asin = normalizeAsin(token);
      if (!asin && /^https?:\/\//i.test(token)) {
        asin = asinFromUrl(token);
        if (!asin) {
          rejected.push({ token, reason: "unsupported_link" });
          continue;
        }
      }
      if (!asin) {
        rejected.push({ token, reason: "invalid" });
        continue;
      }
      if (seen.has(asin)) {
        rejected.push({ token, asin, reason: "duplicate" });
        continue;
      }
      seen.add(asin);
      if (existing.has(asin)) {
        rejected.push({ token, asin, reason: "already_listed" });
        continue;
      }
      if (owned.has(asin) || asin === original) {
        rejected.push({ token, asin, reason: "owned" });
        continue;
      }
      if (locked.has(asin)) {
        rejected.push({ token, asin, reason: "reported" });
        continue;
      }
      if (free <= 0) {
        rejected.push({ token, asin, reason: "capacity" });
        continue;
      }
      free--;
      added.push(asin);
    }
    return { added, rejected };
  }

  const REJECT_LABELS = {
    invalid: "not an ASIN",
    unsupported_link: "not an amazon.com product link",
    duplicate: "pasted twice",
    already_listed: "already in the list",
    owned: "marked as yours",
    capacity: `over the ${TARGET_LIMIT}-listing limit`,
    reported: "reported in the last 5 days, waiting on Amazon",
  };

  function summarizeRejections(rejected) {
    const by = {};
    for (const r of rejected) (by[r.reason] = by[r.reason] || []).push(r.asin || r.token);
    return Object.keys(by).map((reason) => ({ reason, label: REJECT_LABELS[reason] || reason, items: by[reason] }));
  }

  function isoFromParts(y, m, d) {
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function parseEnglishDate(raw) {
    const m = String(raw || "").match(/\b([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
    if (!m) return null;
    const word = m[1].toLowerCase();
    let month = MONTHS.indexOf(word);
    if (month < 0) month = MONTHS.findIndex((name) => name.slice(0, 3) === word || (word === "sept" && name === "september"));
    if (month < 0) return null;
    return isoFromParts(m[3], month + 1, m[2]);
  }

  const EU_MONTHS = {
    1: ["january", "jan", "januar", "janvier", "janv", "gennaio", "gen", "enero", "ene"],
    2: ["february", "feb", "februar", "février", "fevrier", "févr", "fevr", "febbraio", "febrero"],
    3: ["march", "mar", "märz", "maerz", "mär", "mars", "marzo"],
    4: ["april", "apr", "avril", "avr", "aprile", "abril", "abr"],
    5: ["may", "mai", "maggio", "mag", "mayo"],
    6: ["june", "jun", "juni", "juin", "giugno", "giu", "junio"],
    7: ["july", "jul", "juli", "juillet", "juil", "luglio", "lug", "julio"],
    8: ["august", "aug", "août", "aout", "agosto", "ago"],
    9: ["september", "sep", "sept", "septembre", "settembre", "set", "septiembre"],
    10: ["october", "oct", "oktober", "okt", "octobre", "ottobre", "ott", "octubre"],
    11: ["november", "nov", "novembre", "noviembre"],
    12: ["december", "dec", "dezember", "dez", "décembre", "decembre", "déc", "dicembre", "dic", "diciembre"],
  };
  const EU_MONTH_OF = new Map(Object.entries(EU_MONTHS).flatMap(([n, words]) => words.map((w) => [w, Number(n)])));
  function parseDayMonthYear(raw) {
    const m = String(raw || "").match(/\b(\d{1,2})\.?\s+(?:de\s+)?([\p{L}]+)\.?\s+(?:de\s+)?(\d{4})\b/u);
    if (!m) return null;
    const month = EU_MONTH_OF.get(m[2].toLowerCase());
    return month ? isoFromParts(m[3], month, m[1]) : null;
  }
  function parseSlashDate(raw) {
    const m = String(raw || "").match(/\b(\d{4})\/(\d{1,2})\/(\d{1,2})\b/);
    return m ? isoFromParts(m[1], m[2], m[3]) : null;
  }

  function isValidIso(value) {
    const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return !!(m && isoFromParts(m[1], m[2], m[3]));
  }

  function formatIso(iso) {
    if (!isValidIso(iso)) return "";
    const [y, m, d] = iso.split("-").map(Number);
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${names[m - 1]} ${d}, ${y}`;
  }

  function stripTags(html) {
    return String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&[a-z]+;|&#\d+;/gi, " ")
      .replace(/[‎‏]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function classifyAmazonHtml(html, finalUrl) {
    const text = String(html || "");
    const url = String(finalUrl || "");
    if (/\/errors\/validateCaptcha|captchacharacters|Type the characters you see/i.test(text)) return "captcha";
    if (/\/ap\/signin/i.test(url) || (/name="signIn"|id="ap_email"/i.test(text) && !/id="productTitle"/i.test(text))) return "login";
    if (/id="productTitle"/i.test(text)) return "ok";
    if (/Page Not Found|we couldn't find that page|looking for something\?/i.test(text)) return "missing";
    return "unknown";
  }

  const FIRST_AVAILABLE_LABELS = [
    "Date First Available",
    "Im Angebot von Amazon.de seit",
    "Date de mise en ligne sur Amazon.fr",
    "Disponibile su Amazon.it a partire dal",
    "Producto en Amazon.es desde",
    "Amazon.co.jp での取り扱い開始日",
  ];
  function firstAvailable(html) {
    const text = String(html || "");
    const label = FIRST_AVAILABLE_LABELS.find((l) => text.includes(l));
    if (!label) return { state: "unknown", reason: "not_shown" };
    const i = text.indexOf(label);
    const raw = stripTags(text.slice(i + label.length, i + label.length + 600)).replace(/^[\s:]+/, "").slice(0, 60);
    const forms = [
      [parseEnglishDate, /[A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}/],
      [parseDayMonthYear, /\d{1,2}\.?\s+(?:de\s+)?[\p{L}]+\.?\s+(?:de\s+)?\d{4}/u],
      [parseSlashDate, /\d{4}\/\d{1,2}\/\d{1,2}/],
    ];
    for (const [parse, re] of forms) {
      const iso = parse(raw);
      if (iso) return { state: "known", isoDate: iso, raw: raw.match(re)[0], source: "date_first_available" };
    }
    return { state: "unknown", raw, reason: "unreadable" };
  }

  function cleanBrand(text) {
    let b = stripTags(text);
    b = b
      .replace(/^(?:Visit the|Besuche den|Besuchen Sie den|Visitez la boutique|Visita lo Store di|Visita la tienda de)\s+/i, "")
      .replace(/(?:\s+|-)(?:Store|Shop)$/i, "")
      .replace(/のストアを表示$/, "")
      .replace(/^(?:Brand|Marke|Marque|Marca)\s*:\s*/i, "");
    return b.slice(0, 120).trim();
  }

  function parseListingHtml(html, finalUrl) {
    const kind = classifyAmazonHtml(html, finalUrl);
    if (kind === "captcha" || kind === "login") return { state: "blocked", reason: kind, published: { state: "unknown", reason: kind } };
    if (kind === "missing") return { state: "missing", published: { state: "unknown", reason: "missing" } };
    const titleM = String(html).match(/id="productTitle"[^>]*>([\s\S]*?)<\/span>/i);
    const title = titleM ? stripTags(titleM[1]).slice(0, 300) : "";
    if (!title) return { state: "error", reason: "no_title", published: firstAvailable(html) };
    const brandM = String(html).match(/id="bylineInfo"[^>]*>([\s\S]*?)<\/a>/i);
    const image =
      (String(html).match(/data-old-hires="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/i) || [])[1] ||
      (String(html).match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) || [])[1] ||
      "";
    return { state: "ready", title, brand: brandM ? cleanBrand(brandM[1]) : "", image, published: firstAvailable(html), pageAsins: pageAsins(html, finalUrl), bullets: parseBullets(html), description: parseDescription(html) };
  }

  const ABOUT_ITEM = ["About this item", "Über diesen Artikel", "À propos de cet article", "Informazioni su questo articolo", "Acerca de este artículo", "この商品について"];
  const ABOUT_RE = new RegExp(`^(?:${ABOUT_ITEM.join("|")})$`, "i");

  function parseBullets(html) {
    const text = String(html || "");
    const listAfter = (i) => {
      if (i < 0) return null;
      const start = text.indexOf("<ul", i);
      if (start < 0 || start - i > 3000) return null;
      const end = text.indexOf("</ul>", start);
      if (end < 0) return null;
      return [...text.slice(start, end).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => stripTags(m[1]).slice(0, 600)).filter((b) => b && !ABOUT_RE.test(b));
    };
    const facts = text.search(new RegExp(`class="product-facts-title"[^>]*>\\s*(?:${ABOUT_ITEM.join("|")})`, "i"));
    const fb = text.indexOf('id="feature-bullets"');
    const pqv = text.indexOf('id="pqv-feature-bullets"');
    for (const i of [facts, fb, pqv]) {
      const list = listAfter(i);
      if (list && list.length) return list.slice(0, 10);
    }
    return [];
  }

  function parseDescription(html) {
    const m = String(html || "").match(/<div id="productDescription"[^>]*>([\s\S]*?)<\/div>/i);
    if (!m) return "";
    return stripTags(m[1].replace(/<!--[\s\S]*?-->/g, " ")).slice(0, 2000);
  }

  const BOILERPLATE = [
    /^lightweight,? classic fit,? double-needle sleeve and bottom hem/i,
    /^solid colors?:? \d+% cotton/i,
    /^heather grey:? \d+% cotton/i,
    /^(machine wash|imported|pull on closure|classic fit|8\.5 oz|this premium t-shirt)/i,
    /^\d+% (cotton|polyester)/i,
  ];
  function isBoilerplate(line) {
    const l = String(line || "").trim();
    return !l || BOILERPLATE.some((re) => re.test(l)) || words(l).length < 6;
  }

  const STOP = new Set("a an and the of to for with in on at by from or is it i m im my me you your this that are be as t shirt shirts tshirt tee tees top tops funny gift gifts men mens women womens kids boys girls youth adult novelty graphic".split(" "));
  function words(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[’'`]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter(Boolean);
  }
  function keyWords(s) {
    return words(s).filter((w) => !STOP.has(w) && w.length > 1);
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
  function brandKey(b) {
    return String(b || "").toLowerCase().replace(/^visit the\s+|\s+store$/g, "").replace(/[^a-z0-9]/g, "");
  }

  function decodeEntities(s) {
    return String(s || "")
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }
  function parseSearchHtml(html) {
    const text = String(html || "");
    if (/\/errors\/validateCaptcha|captchacharacters|Type the characters you see/i.test(text)) return { state: "blocked" };
    const parts = text.split('data-component-type="s-search-result"');
    const items = [];
    const seen = new Set();
    for (let k = 1; k < parts.length; k++) {
      const asin = ((parts[k - 1].slice(-800).match(/data-asin="([A-Z0-9]{10})"[^>]*$/i) || [])[1] || "").toUpperCase();
      if (!asin || seen.has(asin)) continue;
      seen.add(asin);
      const seg = parts[k].slice(0, 30000);
      const img = seg.match(/<img[^>]*class="s-image"[^>]*>/i);
      const alt = img ? decodeEntities((img[0].match(/\balt="([^"]*)"/i) || [])[1] || "") : "";
      const h2s = [...seg.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => decodeEntities(stripTags(m[1])));
      const title = (alt || h2s[h2s.length - 1] || "").replace(/\s+/g, " ").trim().slice(0, 300);
      const image = img ? (img[0].match(/\bsrc="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/i) || [])[1] || "" : "";
      const price = decodeEntities((seg.match(/<span class="a-offscreen">([^<]*)<\/span>/i) || [])[1] || "").trim();
      items.push({ asin, title, image, price });
    }
    return { state: "ok", items };
  }

  function hijackQueries(mine) {
    const out = [];
    const t = String(mine.title || "").replace(/\b(t-?shirts?|tees?|shirts?|hoodies?|sweatshirts?|tank tops?|v-?neck)\b/gi, " ").replace(/\s+/g, " ").trim();
    if (t.split(" ").length >= 2) out.push({ kind: "title", q: t.slice(0, 120) });
    const bullet = (mine.bullets || []).filter((b) => !isBoilerplate(b))[0];
    if (bullet) {
      const firstSentence = bullet.split(/[.!?]/)[0];
      const ws = firstSentence.replace(/[^\w\s'’-]/g, " ").split(/\s+/).filter(Boolean).slice(0, 10).join(" ");
      if (ws.split(" ").length >= 5) out.push({ kind: "bullets", q: ws });
    }
    const b = String(mine.brand || "").trim();
    if (b.length >= 2 && brandKey(b).length >= 3) out.push({ kind: "brand", q: b.slice(0, 60) });
    return out.slice(0, 3);
  }

  function quickTitleScore(mineTitle, theirTitle) {
    const mk = keyWords(mineTitle), tk = new Set(keyWords(theirTitle));
    if (!mk.length) return 0;
    const ws = mk.filter((w) => tk.has(w)).length / mk.length;
    const gs = containment(grams(mk), grams(keyWords(theirTitle)));
    return 0.5 * ws + 0.5 * gs;
  }

  function pageAsins(html, finalUrl) {
    const text = String(html || "");
    const out = [];
    const parents = new Set([...text.matchAll(/"parentAsin"\s*:\s*"([A-Z0-9]{10})"/gi)].map((m) => m[1].toUpperCase()));
    if (parents.size === 1) out.push([...parents][0]);
    const input = text.match(/<input\b[^>]*\b(?:id|name)=["']ASIN["'][^>]*>/i);
    const cur = input ? normalizeAsin((input[0].match(/\bvalue=["']([A-Z0-9]{10})["']/i) || [])[1]) : "";
    const fromUrl = asinFromUrl(finalUrl || "");
    if (cur && cur !== fromUrl) out.push(cur);
    return [...new Set(out)].filter((a) => a !== fromUrl);
  }

  const REPORT_LOCK_DAYS = 5;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function reportLocks(history, now) {
    const t = now == null ? Date.now() : now;
    const out = new Map();
    for (const r of Array.isArray(history) ? history : []) {
      if (!r || r.site !== "amazon" || r.amazonReplied) continue;
      const sent = Date.parse(r.sentAt);
      if (!Number.isFinite(sent)) continue;
      const until = sent + REPORT_LOCK_DAYS * DAY_MS;
      if (until <= t) continue;
      for (const it of r.items || []) {
        const a = normalizeAsin(it && it.n);
        if (!a || it.status === "removed") continue;
        const prev = out.get(a);
        if (!prev || prev.until < until) out.set(a, { reportId: r.id, sentAt: r.sentAt, until });
      }
    }
    return out;
  }

  const COUNTRIES = Object.freeze([["AF", "Afghanistan"], ["AL", "Albania"], ["DZ", "Algeria"], ["AS", "American Samoa"], ["AD", "Andorra"], ["AO", "Angola"], ["AI", "Anguilla"], ["AQ", "Antarctica"], ["AG", "Antigua And Barbuda"], ["AR", "Argentina"], ["AM", "Armenia"], ["AW", "Aruba"], ["AU", "Australia"], ["AT", "Austria"], ["AZ", "Azerbaijan"], ["BS", "Bahamas"], ["BH", "Bahrain"], ["BD", "Bangladesh"], ["BB", "Barbados"], ["BY", "Belarus"], ["BE", "Belgium"], ["BZ", "Belize"], ["BJ", "Benin"], ["BM", "Bermuda"], ["BT", "Bhutan"], ["BO", "Bolivia"], ["BA", "Bosnia and Herzegovina"], ["BW", "Botswana"], ["BV", "Bouvet Island"], ["BR", "Brazil"], ["IO", "British Indian Ocean Territory"], ["BN", "Brunei Darussalam"], ["BG", "Bulgaria"], ["BF", "Burkina Faso"], ["BI", "Burundi"], ["KH", "Cambodia"], ["CM", "Cameroon"], ["CA", "Canada"], ["CV", "Cape Verde"], ["KY", "Cayman Islands"], ["CF", "Central African Republic"], ["TD", "Chad"], ["CL", "Chile"], ["CN", "China"], ["CX", "Christmas Island"], ["CC", "Cocos (Keeling) Islands"], ["CO", "Colombia"], ["KM", "Comoros"], ["CG", "Congo"], ["CD", "Congo, the Democratic Republic of the"], ["CK", "Cook Islands"], ["CR", "Costa Rica"], ["CI", "Cote d'Ivoire"], ["HR", "Croatia"], ["CY", "Cyprus"], ["CZ", "Czech Republic"], ["DK", "Denmark"], ["DJ", "Djibouti"], ["DM", "Dominica"], ["DO", "Dominican Republic"], ["TP", "East Timor"], ["EC", "Ecuador"], ["EG", "Egypt"], ["SV", "El Salvador"], ["GQ", "Equatorial Guinea"], ["ER", "Eritrea"], ["EE", "Estonia"], ["ET", "Ethiopia"], ["FK", "Falkland Islands"], ["FO", "Faroe Islands"], ["FJ", "Fiji"], ["FI", "Finland"], ["FR", "France"], ["GF", "French Guiana"], ["PF", "French Polynesia"], ["TF", "French Southern Territories"], ["GA", "Gabon"], ["GM", "Gambia"], ["GE", "Georgia"], ["DE", "Germany"], ["GH", "Ghana"], ["GI", "Gibraltar"], ["GR", "Greece"], ["GL", "Greenland"], ["GD", "Grenada"], ["GP", "Guadeloupe"], ["GU", "Guam"], ["GT", "Guatemala"], ["GN", "Guinea"], ["GW", "Guinea-Bissau"], ["GY", "Guyana"], ["HT", "Haiti"], ["HM", "Heard and Mc Donald Islands"], ["HN", "Honduras"], ["HK", "Hong Kong, China"], ["HU", "Hungary"], ["IS", "Iceland"], ["IN", "India"], ["ID", "Indonesia"], ["IE", "Ireland"], ["IL", "Israel"], ["IT", "Italy"], ["JM", "Jamaica"], ["JP", "Japan"], ["JO", "Jordan"], ["KZ", "Kazakhstan"], ["KE", "Kenya"], ["KI", "Kiribati"], ["KR", "Korea (South)"], ["KW", "Kuwait"], ["KG", "Kyrgyzstan"], ["LA", "Lao People's Democratic Republic"], ["LV", "Latvia"], ["LB", "Lebanon"], ["LS", "Lesotho"], ["LR", "Liberia"], ["LI", "Liechtenstein"], ["LT", "Lithuania"], ["LU", "Luxembourg"], ["MO", "Macau"], ["MK", "Macedonia"], ["MG", "Madagascar"], ["MW", "Malawi"], ["MY", "Malaysia"], ["MV", "Maldives"], ["ML", "Mali"], ["MT", "Malta"], ["MH", "Marshall Islands"], ["MQ", "Martinique"], ["MR", "Mauritania"], ["MU", "Mauritius"], ["YT", "Mayotte"], ["MX", "Mexico"], ["FM", "Micronesia, Federated States of"], ["MD", "Moldova, Republic of"], ["MN", "Mongolia"], ["MS", "Montserrat"], ["MA", "Morocco"], ["MZ", "Mozambique"], ["MM", "Myanmar"], ["NA", "Namibia"], ["NR", "Nauru"], ["NP", "Nepal"], ["NL", "Netherlands"], ["AN", "Netherlands Antilles"], ["NC", "New Caledonia"], ["NZ", "New Zealand"], ["NI", "Nicaragua"], ["NE", "Niger"], ["NG", "Nigeria"], ["NU", "Niue"], ["NF", "Norfolk Island"], ["MP", "Northern Mariana Islands"], ["NO", "Norway"], ["OM", "Oman"], ["PK", "Pakistan"], ["PW", "Palau"], ["PA", "Panama"], ["PG", "Papua New Guinea"], ["PY", "Paraguay"], ["PE", "Peru"], ["PH", "Philippines"], ["PN", "Pitcairn"], ["PL", "Poland"], ["PT", "Portugal"], ["PR", "Puerto Rico"], ["QA", "Qatar"], ["RE", "Reunion"], ["RO", "Romania"], ["RU", "Russia"], ["RW", "Rwanda"], ["KN", "Saint Kitts and Nevis"], ["LC", "Saint Lucia"], ["VC", "Saint Vincent and the Grenadines"], ["WS", "Samoa (Independent)"], ["SM", "San Marino"], ["ST", "Sao Tome and Principe"], ["SA", "Saudi Arabia"], ["SN", "Senegal"], ["SC", "Seychelles"], ["SL", "Sierra Leone"], ["SG", "Singapore"], ["SK", "Slovakia"], ["SI", "Slovenia"], ["SB", "Solomon Islands"], ["SO", "Somalia"], ["ZA", "South Africa"], ["GS", "South Georgia and the South Sandwich Islands"], ["ES", "Spain"], ["LK", "Sri Lanka"], ["SH", "St. Helena"], ["PM", "St. Pierre and Miquelon"], ["SR", "Suriname"], ["SJ", "Svalbard and Jan Mayen Islands"], ["SZ", "Swaziland"], ["SE", "Sweden"], ["CH", "Switzerland"], ["SY", "Syria"], ["TW", "Taiwan"], ["TJ", "Tajikistan"], ["TZ", "Tanzania"], ["TH", "Thailand"], ["TG", "Togo"], ["TK", "Tokelau"], ["TO", "Tonga"], ["TT", "Trinidad and Tobago"], ["TN", "Tunisia"], ["TR", "Turkey"], ["TM", "Turkmenistan"], ["TC", "Turks and Caicos Islands"], ["TV", "Tuvalu"], ["UG", "Uganda"], ["UA", "Ukraine"], ["AE", "United Arab Emirates"], ["GB", "United Kingdom"], ["US", "United States"], ["UM", "United States Minor Outlying Islands"], ["UY", "Uruguay"], ["UZ", "Uzbekistan"], ["VU", "Vanuatu"], ["VA", "Vatican City State (Holy See)"], ["VE", "Venezuela"], ["VN", "Vietnam"], ["VG", "Virgin Islands (British)"], ["VI", "Virgin Islands (U.S.)"], ["WF", "Wallis and Futuna Islands"], ["EH", "Western Sahara"], ["YE", "Yemen"], ["YU", "Yugoslavia"], ["ZM", "Zambia"], ["ZW", "Zimbabwe"]]);
  const COUNTRY_BY_CODE = new Map(COUNTRIES.map(([c, n]) => [c, n]));
  const COUNTRY_BY_NAME = new Map(COUNTRIES.map(([c, n]) => [n.toLowerCase(), c]));
  const COUNTRY_ALIASES = {
    "türkiye": "TR", "czechia": "CZ", "brunei": "BN", "laos": "LA", "hong kong": "HK", "macao": "MO",
    "north macedonia": "MK", "south korea": "KR", "korea": "KR", "moldova": "MD", "eswatini": "SZ",
    "cabo verde": "CV", "côte d'ivoire": "CI", "ivory coast": "CI", "timor-leste": "TP", "vatican city": "VA",
    "micronesia": "FM", "congo (democratic republic)": "CD", "samoa": "WS", "réunion": "RE",
    "são tomé and príncipe": "ST", "british virgin islands": "VG", "u.s. virgin islands": "VI",
    "pitcairn islands": "PN", "heard island and mcdonald islands": "HM", "antigua and barbuda": "AG",
    "saint helena, ascension and tristan da cunha": "SH", "saint pierre and miquelon": "PM",
    "svalbard and jan mayen": "SJ", "wallis and futuna": "WF", "usa": "US", "united states of america": "US", "uk": "GB",
  };

  function countryCode(value) {
    const v = String(value == null ? "" : value).trim();
    if (!v) return "";
    if (COUNTRY_BY_CODE.has(v.toUpperCase()) && v.length === 2) return v.toUpperCase();
    const k = v.toLowerCase();
    return COUNTRY_BY_NAME.get(k) || COUNTRY_ALIASES[k] || "";
  }

  function countryName(value) {
    return COUNTRY_BY_CODE.get(countryCode(value)) || "";
  }

  const REPORTER_REQUIRED = ["firstName", "lastName", "addressLine1", "city", "postalCode", "country", "phone", "contactName", "contactEmail"];
  const REPORTER_LABELS = {
    firstName: "First name",
    lastName: "Last name",
    company: "Company",
    addressLine1: "Address line 1",
    addressLine2: "Address line 2",
    city: "City",
    state: "State or region",
    postalCode: "Postal code",
    country: "Country",
    phone: "Phone",
    contactName: "Contact name",
    contactEmail: "Contact email",
    role: "Your role",
    isSeller: "Do you sell on Amazon?",
  };

  function validateReporter(r) {
    const issues = [];
    const v = r || {};
    for (const f of REPORTER_REQUIRED) {
      if (!String(v[f] || "").trim()) issues.push({ code: "required", field: f, severity: "blocking", message: `${REPORTER_LABELS[f]} is required.` });
    }
    if (String(v.contactEmail || "").trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v.contactEmail).trim())) {
      issues.push({ code: "email", field: "contactEmail", severity: "blocking", message: "That email address doesn't look right." });
    }
    const phone = String(v.phone || "").trim();
    if (phone && (!/^\+?[\d\s\-().]+$/.test(phone) || phone.replace(/\D/g, "").length < 7)) {
      issues.push({ code: "phone", field: "phone", severity: "blocking", message: "Enter a phone number with its digits (country code is fine)." });
    }
    if (String(v.country || "").trim() && !countryCode(v.country)) {
      issues.push({ code: "country", field: "country", severity: "blocking", message: "Pick your country from the list." });
    }
    if (v.role !== "rights_owner" && v.role !== "authorized_agent") {
      issues.push({ code: "role", field: "role", severity: "blocking", message: "Choose whether you're the rights owner or an authorized agent." });
    }
    if (v.isSeller !== true && v.isSeller !== false) {
      issues.push({ code: "seller", field: "isSeller", severity: "blocking", message: "Answer whether you sell on Amazon." });
    }
    return issues;
  }

  function fillDescription(template, facts) {
    const f = facts || {};
    const values = {
      original_asin: f.originalAsin || "",
      original_link: f.originalLink || "",
      published: f.published ? formatIso(f.published) : "",
      count: f.count != null ? String(f.count) : "",
      today: f.today ? formatIso(f.today) : "",
    };
    return String(template || "").replace(/\{(original_asin|original_link|published|count|today)\}/g, (m, k) => values[k] || m);
  }

  function unfilledPlaceholders(text) {
    return [...String(text || "").matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
  }

  function validateDraft(draft) {
    const issues = [];
    const d = draft || {};
    const block = (code, message, extra = {}) => issues.push({ code, severity: "blocking", message, ...extra });
    const review = (code, message, extra = {}) => issues.push({ code, severity: "review", message, ...extra });

    if (!canReport(d.marketplace)) block("marketplace", "This marketplace isn't supported yet.");
    const targets = Array.isArray(d.targets) ? d.targets : [];
    const otherSite = targets.filter((t) => t && t.marketplace && normalizeMarketplace(t.marketplace) !== normalizeMarketplace(d.marketplace));
    if (otherSite.length) block("other_marketplace", `${otherSite.length === 1 ? "1 ticked listing is" : `${otherSite.length} ticked listings are`} on another Amazon site (${[...new Set(otherSite.map((t) => marketplaceLabel(t.marketplace)))].join(", ")}). Amazon takes one site per report: untick ${otherSite.length === 1 ? "it" : "them"} and report ${otherSite.length === 1 ? "it" : "them"} separately.`, { asins: otherSite.map((t) => t.asin) });
    if (!targets.length) block("no_targets", "Select at least one listing to report.");
    if (targets.length > TARGET_LIMIT) block("too_many", `Amazon takes up to ${TARGET_LIMIT} listings per report. Untick some.`);

    const o = d.original || {};
    const oAsin = normalizeAsin(o.asin);
    let oDate = null;
    if (!oAsin) block("original_missing", "Enter the ASIN of your original product.");
    else {
      const own = ownershipOf(o.ownership);
      if (!own.passes) {
        if (own.catalogConnected && own.catalog === "unknown") block("original_unknown", `Couldn't check your Merch catalog (${own.reason || "unknown"}), and the original isn't marked "This is mine". Sync your Merch catalog again, or mark it yourself.`);
        else if (own.catalogConnected && own.catalog === "loading") block("original_loading_catalog", "Checking your Merch catalog…");
        else if (own.catalogConnected) block("original_not_owned", 'Your original isn\'t in your Merch catalog and isn\'t marked as yours. Check the ASIN, or use "This is mine" if it\'s yours.');
        else block("original_not_owned", 'Your original isn\'t marked as yours. Use "This is mine" on it, or sync your Merch catalog.');
      }
      const L = o.listing;
      if (!L || L.state === "loading") block("original_loading", "Still reading your original's product page…");
      else if (L.state === "blocked") block("original_blocked", "Amazon asked for a sign-in or robot check when reading your original. Open amazon.com, then refresh.");
      else if (L.state === "missing") block("original_gone", "Your original's product page wasn't found on Amazon.");
      else if (L.state !== "ready") block("original_error", "Couldn't read your original's product page. Refresh and try again.");
      else if (!L.published || L.published.state !== "known" || !isValidIso(L.published.isoDate)) block("original_date", "Your original's Date First Available couldn't be read, so the dates can't be compared.");
      else oDate = L.published.isoDate;
    }

    const aliases = new Set([oAsin, ...(d.aliases || []).map(normalizeAsin)].filter(Boolean));
    const seen = new Set();
    for (const t of targets) {
      const a = normalizeAsin(t.asin);
      if (!a) {
        block("target_invalid", `"${t.asin}" isn't a valid ASIN.`, { asin: t.asin });
        continue;
      }
      if (seen.has(a)) continue;
      seen.add(a);
      if (aliases.has(a)) {
        block("target_is_original", `${a} is your original. It can't be in the report.`, { asin: a });
        continue;
      }
      const c = t.catalog && t.catalog.state;
      if (c === "catalog_matched") {
        block("target_in_catalog", `${a} is in your own Merch catalog. You can't report your own listing.`, { asin: a });
        continue;
      }
      if (c === "unknown" && ownershipOf(o.ownership).catalogConnected) review("target_catalog_unknown", `${a}: couldn't check it against your Merch catalog.`, { asin: a });
      const L = t.listing;
      const p = L && L.published;
      if (L && L.state === "missing") review("target_gone", `${a}: product page not found. It may already be removed.`, { asin: a });
      if (p && p.state === "known" && oDate && p.isoDate < oDate) {
        review("target_before_original", `${a} was first available ${formatIso(p.isoDate)}, before your listing (${formatIso(oDate)}). If you relisted your design after deleting it, that's expected; otherwise check it's really a copy.`, { asin: a });
      } else if (!p || p.state !== "known") {
        review("target_date_unknown", `${a}: its first-available date isn't known, so it wasn't compared.`, { asin: a });
      }
    }

    if (!ISSUES[d.issue]) block("issue", "Choose what happened (stolen artwork, copied design, copied with changes or copied listing).");
    if (!String(d.brand || "").trim()) block("brand", "Enter the brand name for your original.");

    const desc = String(d.description || "");
    if (!desc.trim()) block("description_empty", "Write the description Amazon will read.");
    else {
      if (desc.length > DESCRIPTION_MAX) block("description_long", `The description is over ${DESCRIPTION_MAX} characters.`);
      const left = unfilledPlaceholders(desc);
      if (left.length) block("description_placeholders", `The description still has ${left.map((x) => `{${x}}`).join(", ")} that couldn't be filled.`);
    }

    validateReporter(d.reporter).forEach((i) => issues.push(i));
    return issues;
  }

  function ownershipOf(o) {
    if (typeof o === "string") return { passes: o === "owned", basis: o === "owned" ? "self_declared" : "", catalog: o === "unknown" ? "unknown" : "", catalogConnected: o === "unknown" };
    const v = o || {};
    const catalog = v.catalog ? v.catalog.state || "unknown" : v.catalogConnected ? "loading" : "";
    const matched = catalog === "catalog_matched";
    return {
      passes: matched || v.selfDeclared === true,
      basis: matched ? "catalog_matched" : v.selfDeclared === true ? "self_declared" : "",
      catalog,
      reason: v.catalog && v.catalog.reason,
      catalogConnected: !!v.catalogConnected,
      selfDeclared: v.selfDeclared === true,
    };
  }

  function hasBlocking(issues) {
    return (issues || []).some((i) => i.severity === "blocking");
  }

  function csvCell(value) {
    let s = value == null ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function toCsv(rows) {
    const out = [["#", "Marketplace", "Listing", "Published", "ASIN", "Status"].map(csvCell).join(",")];
    (rows || []).forEach((r, i) => {
      out.push([i + 1, r.marketplace, r.title || "", r.published ? formatIso(r.published) : "Unknown", r.asin, r.state || ""].map(csvCell).join(","));
    });
    return out.join("\r\n");
  }

  const api = {
    MARKETPLACES,
    marketplaceOfHost,
    marketplaceLabel,
    canReport,
    parseDayMonthYear,
    TARGET_LIMIT,
    DESCRIPTION_MAX,
    ISSUES,
    DEFAULT_DESCRIPTIONS,
    PLACEHOLDERS,
    REPORTER_REQUIRED,
    REPORTER_LABELS,
    normalizeAsin,
    normalizeMarketplace,
    productKey,
    productUrl,
    asinFromUrl,
    parseTargetInput,
    summarizeRejections,
    parseEnglishDate,
    isValidIso,
    formatIso,
    classifyAmazonHtml,
    parseListingHtml,
    parseBullets,
    parseDescription,
    isBoilerplate,
    parseSearchHtml,
    keyWords,
    hijackQueries,
    quickTitleScore,
    REPORT_LOCK_DAYS,
    reportLocks,
    COUNTRIES,
    countryCode,
    countryName,
    validateReporter,
    fillDescription,
    unfilledPlaceholders,
    validateDraft,
    ownershipOf,
    hasBlocking,
    csvCell,
    toCsv,
  };
  root.EifAmazonReport = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : globalThis);
