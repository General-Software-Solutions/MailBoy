// MailBoy service worker.
// Its only job right now: make the toolbar button open the side panel.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[MailBoy] side panel behavior:', err));
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[MailBoy] side panel behavior:', err));
});
