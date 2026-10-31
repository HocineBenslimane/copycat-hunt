document.getElementById("rm").addEventListener("click", () => {
  try {
    chrome.management.uninstallSelf({ showConfirmDialog: true }, () => void chrome.runtime.lastError);
  } catch (e) {}
});
