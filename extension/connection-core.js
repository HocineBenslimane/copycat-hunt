(function (root) {
  "use strict";
  function createMerchCoordinator(deps) {
    let inFlight = null;
    const now = deps.now || Date.now;
    return {
      ensure(manual = false) {
        if (inFlight) return inFlight;
        inFlight = (async () => {
          const identity = await deps.identity(manual === true);
          if (identity.state !== "verified" || identity.stale) return deps.status();
          const loaded = await deps.catalog();
          const current = loaded && deps.sameAccount(loaded.catalog, identity);
          if (!manual && current && now() - loaded.catalog.syncedAt < 86400000) return deps.status();
          const failure = await deps.failure();
          if (!manual && failure && failure.account === identity.accountId && failure.until > now()) return deps.status();
          const result = await deps.sync(manual === true);
          await deps.saveFailure(result.ok ? null : { account: identity.accountId, until: now() + 300000 });
          return deps.status();
        })().finally(() => { inFlight = null; });
        return inFlight;
      },
    };
  }
  const api = { createMerchCoordinator };
  root.EifConnection = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
