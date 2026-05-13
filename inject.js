(function() {
  'use strict';

  const SHIFT_API_PATH = '/v1/companies/';
  const API_HOST = 'api.app.workaxle.com';

  function isShiftApiRequest(url) {
    if (!url) return false;
    const urlStr = typeof url === 'string' ? url : (url.href || url.url || '');
    return urlStr.includes(API_HOST) && urlStr.includes(SHIFT_API_PATH) && urlStr.includes('/shifts');
  }

  function sendToContentScript(data) {
    window.postMessage({ source: 'workaxle-sync-inject', payload: data }, '*');
  }

  function extractHeaders(headers) {
    let authToken = null;
    let clusterId = null;
    let companyId = null;

    if (!headers) return { authToken, clusterId, companyId };

    if (headers instanceof Headers) {
      authToken = headers.get('Authorization') || headers.get('authorization');
      clusterId = headers.get('Cluster-Id') || headers.get('cluster-id');
      companyId = headers.get('company-id') || headers.get('Company-Id');
    } else if (Array.isArray(headers)) {
      headers.forEach(([key, val]) => {
        const k = key.toLowerCase();
        if (k === 'authorization') authToken = val;
        if (k === 'cluster-id') clusterId = val;
        if (k === 'company-id') companyId = val;
      });
    } else {
      authToken = headers['Authorization'] || headers['authorization'];
      clusterId = headers['Cluster-Id'] || headers['cluster-id'];
      companyId = headers['company-id'] || headers['Company-Id'];
    }

    return { authToken, clusterId, companyId };
  }

  // ── Fetch hook ──────────────────────────────────────────────────────────────

  const originalFetch = window.fetch;
  window.fetch = function(input, init = {}) {
    const url = typeof input === 'string' ? input : (input?.url || input?.href || '');
    const method = ((init?.method) || input?.method || 'GET').toUpperCase();

    if (isShiftApiRequest(url) && method === 'GET') {
      let { authToken, clusterId, companyId } = extractHeaders(init?.headers);

      // Also check if input is a Request object
      if ((!authToken || !clusterId) && input?.headers?.get) {
        const h = extractHeaders(input.headers);
        authToken = authToken || h.authToken;
        clusterId = clusterId || h.clusterId;
        companyId = companyId || h.companyId;
      }

      // Extract companyId from URL if not in headers
      if (!companyId) {
        const match = url.match(/\/companies\/(\d+)\//);
        if (match) companyId = match[1];
      }

      if (authToken || clusterId) {
        sendToContentScript({ type: 'tokens-captured', authorization: authToken, clusterId, companyId, url });
      }
    }

    return originalFetch.apply(this, arguments);
  };

  // ── XHR hook ────────────────────────────────────────────────────────────────

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const xhrHeaders = new WeakMap();

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._workaxleUrl = url;
    this._workaxleMethod = method;
    xhrHeaders.set(this, {});
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    const headers = xhrHeaders.get(this) || {};
    headers[name] = value;
    xhrHeaders.set(this, headers);
    return originalSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    const url = this._workaxleUrl;
    const method = this._workaxleMethod;
    const reqHeaders = xhrHeaders.get(this) || {};

    if (isShiftApiRequest(url) && (method || 'GET').toUpperCase() === 'GET') {
      const { authToken, clusterId } = extractHeaders(reqHeaders);
      let companyId = reqHeaders['company-id'] || reqHeaders['Company-Id'] || null;

      if (!companyId) {
        const match = String(url).match(/\/companies\/(\d+)\//);
        if (match) companyId = match[1];
      }

      if (authToken || clusterId) {
        sendToContentScript({
          type: 'tokens-captured',
          authorization: authToken,
          clusterId,
          companyId,
          url: String(url)
        });
      }
    }

    return originalSend.apply(this, args);
  };

  sendToContentScript({ type: 'inject-ready' });
})();
