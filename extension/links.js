// Copycat Hunt: links shown in the menu and on the setup page (v3.18.2).
// BUY is the page where people get a license. There's no store page yet, so
// it's empty and the "Get a license" link emails support instead. When the
// page exists, put its https:// address here; nothing else needs to change.
(function (root) {
  "use strict";
  const BUY = "";
  const SUPPORT = "support@h-bns.shop";
  const buyHref = () => (/^https:\/\//.test(BUY) ? BUY : `mailto:${SUPPORT}?subject=${encodeURIComponent("Copycat Hunt license")}`);
  root.EifLinks = { BUY, SUPPORT, buyHref };
})(typeof self !== "undefined" ? self : globalThis);
