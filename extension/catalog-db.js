(function (root) {
  "use strict";

  function createCatalogDb(deps) {
    const chromeApi = deps.chrome;
    const OFFSCREEN = "offscreen.html";
    let creating = null;

    async function hasDocument() {
      const url = chromeApi.runtime.getURL(OFFSCREEN);
      if (chromeApi.runtime.getContexts) {
        const ctx = await chromeApi.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
        return ctx.length > 0;
      }
      return false;
    }

    async function ensure() {
      if (await hasDocument()) return;
      if (!creating) {
        creating = chromeApi.offscreen
          .createDocument({ url: OFFSCREEN, reasons: ["WORKERS"], justification: "Keeps your synced Merch and eBay listings in a local database." })
          .catch((e) => {
            if (!/single offscreen|already exists/i.test(String((e && e.message) || e))) throw e;
          })
          .finally(() => {
            creating = null;
          });
      }
      await creating;
    }

    function codeError(code, message) {
      const e = new Error(message || code);
      e.code = code;
      return e;
    }

    async function send(op, args, timeoutMs) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(codeError("storage_timeout", `${op} took too long`)), timeoutMs);
      });
      try {
        return await Promise.race([chromeApi.runtime.sendMessage({ eifDb: 1, op, args: args || {} }), timeout]);
      } finally {
        clearTimeout(timer);
      }
    }

    async function call(op, args, opts = {}) {
      const timeoutMs = opts.timeoutMs || 60000;
      let res;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await ensure();
        } catch (e) {
          throw codeError("storage_unsupported", String((e && e.message) || e));
        }
        try {
          res = await send(op, args, timeoutMs);
        } catch (e) {
          if (e && e.code === "storage_timeout") throw e;
          res = null;
        }
        if (res) break;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
      if (!res) throw codeError("storage_unavailable", "the catalog database did not answer");
      if (!res.ok) throw codeError(res.code || "storage_unavailable", res.message);
      return res.result;
    }

    async function restart() {
      try {
        if (await hasDocument()) await chromeApi.offscreen.closeDocument();
      } catch (e) {  }
      await ensure();
    }

    return { call, ensure, restart };
  }

  const api = { createCatalogDb };
  root.EifCatalogDb = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
