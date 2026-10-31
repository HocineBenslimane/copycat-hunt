(function () {
  "use strict";
  const worker = new Worker("db-worker.js");
  const waiting = new Map();
  const BG_URL = chrome.runtime.getURL("background.js");

  worker.onmessage = (ev) => {
    const msg = ev.data || {};
    const reply = waiting.get(msg.id);
    if (!reply) return;
    waiting.delete(msg.id);
    reply(msg);
  };
  worker.onerror = () => {
    for (const [id, reply] of waiting) reply({ id, ok: false, code: "storage_unavailable", message: "database worker stopped" });
    waiting.clear();
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.eifDb !== 1) return false;
    if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== BG_URL) return false;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    waiting.set(id, (res) => sendResponse({ ok: res.ok, result: res.result, code: res.code, message: res.message }));
    worker.postMessage({ id, op: msg.op, args: msg.args });
    return true;
  });
})();
