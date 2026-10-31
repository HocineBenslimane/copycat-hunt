(function (root) {
  "use strict";
  const API = "https://api.copycathunt.com";
  const SUPPORT = "support@copycathunt.com";
  const PLANS = [
    { id: "starter_monthly", price: "$9.99", per: "/ month" },
    { id: "starter_yearly", price: "$99", per: "/ year", note: "2 months free" },
  ];
  const STARTER = ["Unlimited hunts, tracking, reports and sync", "100 hijack checks a month", "1 computer"];
  const PRO = ["Everything in Starter", "Image scorer: sorts results by how likely each one is a copy", "500 hijack checks a month"];
  const checkoutHref = (plan) => `${API}/v1/checkout?plan=${encodeURIComponent(plan)}`;
  const buyHref = () => checkoutHref(PLANS[0].id);
  root.EifLinks = { API, SUPPORT, PLANS, STARTER, PRO, checkoutHref, buyHref };
})(typeof self !== "undefined" ? self : globalThis);
