(function() {
  'use strict';

  let injected = false;

  function injectScript() {
    if (injected) return;
    injected = true;

    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    script.onload = function() { script.remove(); };
    (document.head || document.documentElement).appendChild(script);
  }

  function sendToServiceWorker(data) {
    chrome.runtime.sendMessage(data).catch(() => {});
  }

  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'workaxle-sync-inject') return;

    const payload = event.data.payload;

    if (payload.type === 'inject-ready') {
      sendToServiceWorker({ type: 'inject-ready' });
    } else if (payload.type === 'tokens-captured') {
      sendToServiceWorker({
        type: 'tokens-captured',
        authorization: payload.authorization,
        clusterId: payload.clusterId,
        companyId: payload.companyId,
        url: payload.url
      });
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectScript);
  } else {
    injectScript();
  }
})();
