(function() {
  'use strict';

  // ── Elements ────────────────────────────────────────────────────────────────

  const openScheduleBtn = document.getElementById('open-schedule-btn');
  const SCHEDULE_URL    = 'https://icc.workaxle.com/schedule';

  const tokenStatus     = document.getElementById('token-status');
  const accountInfo     = document.getElementById('account-info');
  const accountSignedOut = document.getElementById('account-signed-out');
  const accountAvatar   = document.getElementById('account-avatar');
  const accountEmail    = document.getElementById('account-email');
  const signOutBtn      = document.getElementById('sign-out-btn');
  const signInBtn       = document.getElementById('sign-in-btn');

  const tabBtns         = document.querySelectorAll('.tab-btn');
  const tabGoogle       = document.getElementById('tab-google');
  const tabApple        = document.getElementById('tab-apple');

  const calendarSelect  = document.getElementById('calendar-select');
  const refreshCalBtn   = document.getElementById('refresh-calendars');
  const syncBtn         = document.getElementById('sync-btn');

  const workerBaseInput = document.getElementById('worker-base-url');
  const workerSecretInput = document.getElementById('worker-secret');
  const saveWorkerBtn   = document.getElementById('save-worker-btn');
  const feedUrlSection  = document.getElementById('feed-url-section');
  const feedUrlInput    = document.getElementById('feed-url');
  const copyUrlBtn      = document.getElementById('copy-url-btn');
  const exportIcsBtn    = document.getElementById('export-ics-btn');
  const pushTokensBtn   = document.getElementById('push-tokens-btn');
  const getLinkBtn      = document.getElementById('get-link-btn');
  const setupStatus     = document.getElementById('setup-status');
  const appleSetup      = document.getElementById('apple-setup');
  const appleReady      = document.getElementById('apple-ready');
  const resetWorkerBtn  = document.getElementById('reset-worker-btn');

  const lastSyncDiv     = document.getElementById('last-sync');
  const statusArea      = document.getElementById('status');
  const spinner         = document.getElementById('spinner');
  const statusMessage   = document.getElementById('status-message');
  const resultDiv       = document.getElementById('result');

  // ── Config ───────────────────────────────────────────────────────────────────

  // ── State ────────────────────────────────────────────────────────────────────

  let isBusy = false;

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function setStatus(message, showSpinner = false) {
    statusMessage.textContent = message;
    spinner.classList.toggle('hidden', !showSpinner);
  }

  function showResult(text, isError = false) {
    resultDiv.textContent = text;
    resultDiv.classList.remove('hidden', 'error');
    if (isError) resultDiv.classList.add('error');
  }

  function hideResult() {
    resultDiv.classList.add('hidden');
  }

  function setBusy(busy, buttonEl) {
    isBusy = busy;
    if (buttonEl) buttonEl.disabled = busy;
    syncBtn.disabled = busy;
    exportIcsBtn.disabled = busy;
  }

  // ── Open Schedule ─────────────────────────────────────────────────────────────

  openScheduleBtn.addEventListener('click', () => {
    // Focus existing WorkAxle tab if open, otherwise open a new one
    chrome.tabs.query({ url: 'https://icc.workaxle.com/*' }, (tabs) => {
      if (tabs.length > 0) {
        chrome.tabs.update(tabs[0].id, { active: true, url: SCHEDULE_URL });
        chrome.windows.update(tabs[0].windowId, { focused: true });
      } else {
        chrome.tabs.create({ url: SCHEDULE_URL });
      }
      window.close();
    });
  });

  // ── Account ───────────────────────────────────────────────────────────────────

  async function loadAccount() {
    const response = await chrome.runtime.sendMessage({ type: 'get-account' });
    if (response?.account?.email) {
      accountInfo.classList.remove('hidden');
      accountSignedOut.classList.add('hidden');
      accountEmail.textContent = response.account.email;
      if (response.account.picture) {
        accountAvatar.src = response.account.picture;
        accountAvatar.classList.remove('hidden');
      } else {
        accountAvatar.classList.add('hidden');
      }
    } else {
      accountInfo.classList.add('hidden');
      accountSignedOut.classList.remove('hidden');
    }
  }

  signOutBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'sign-out' });
    accountInfo.classList.add('hidden');
    accountSignedOut.classList.remove('hidden');
    calendarSelect.innerHTML = '<option value="primary">Sign in to load calendars</option>';
    setStatus('Signed out. Click Sign in to use a different account.');
  });

  signInBtn.addEventListener('click', async () => {
    setStatus('Signing in...', true);
    try {
      // Trigger interactive sign-in, then reload calendars with the new token
      await loadCalendars(true);
      await loadAccount();
      setStatus('');
    } catch (err) {
      setStatus('Sign in failed: ' + err.message);
    }
  });

  // ── Token status ──────────────────────────────────────────────────────────────

  async function checkTokens() {
    try {
      const response = await Promise.race([
        chrome.runtime.sendMessage({ type: 'get-tokens' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
      ]);
      tokenStatus.classList.remove('has-tokens', 'no-tokens', 'error');
      if (response.hasTokens) {
        tokenStatus.classList.add('has-tokens');
        tokenStatus.querySelector('.status-text').textContent = 'WorkAxle: tokens captured';
      } else {
        tokenStatus.classList.add('no-tokens');
        tokenStatus.querySelector('.status-text').textContent = 'No tokens — refresh WorkAxle page';
      }
    } catch {
      tokenStatus.classList.remove('has-tokens', 'no-tokens');
      tokenStatus.classList.add('no-tokens');
      tokenStatus.querySelector('.status-text').textContent = 'No tokens — refresh WorkAxle page';
    }
  }

  // ── Calendars ─────────────────────────────────────────────────────────────────

  async function loadCalendars(interactive = false) {
    calendarSelect.innerHTML = '<option value="">Loading...</option>';
    const response = await chrome.runtime.sendMessage({ type: 'list-calendars', interactive });

    if (!response.success) {
      calendarSelect.innerHTML = '<option value="primary">Sign in to load calendars</option>';
      // Only show an error if it's a real failure (not just "not signed in yet")
      if (response.error && response.error !== 'not-signed-in') {
        showResult('Calendar error: ' + response.error, true);
      }
      return;
    }

    calendarSelect.innerHTML = '';
    response.calendars
      .filter(cal => cal.accessRole === 'owner' || cal.accessRole === 'writer')
      .forEach(cal => {
        const option = document.createElement('option');
        option.value = cal.id;
        option.textContent = cal.summary + (cal.primary ? ' (primary)' : '');
        if (cal.primary) option.selected = true;
        calendarSelect.appendChild(option);
      });
  }

  refreshCalBtn.addEventListener('click', () => loadCalendars());

  // ── Tabs ──────────────────────────────────────────────────────────────────────

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const tab = btn.dataset.tab;
      tabGoogle.classList.toggle('hidden', tab !== 'google');
      tabApple.classList.toggle('hidden', tab !== 'apple');

      hideResult();
      setStatus('');
    });
  });

  // ── iCal feed URL ─────────────────────────────────────────────────────────────

  // ── Apple Calendar state ─────────────────────────────────────────────────────

  async function loadAppleState() {
    const resp = await chrome.runtime.sendMessage({ type: 'get-feed-url' });
    if (resp.feedUrl) {
      showAppleReady(resp.feedUrl);
    } else {
      appleSetup.classList.remove('hidden');
      appleReady.classList.add('hidden');
    }
  }

  function showAppleReady(feedUrl) {
    appleSetup.classList.add('hidden');
    appleReady.classList.remove('hidden');
    if (feedUrlInput) feedUrlInput.value = feedUrl;
  }

  // Get My Subscribe Link button
  getLinkBtn.addEventListener('click', async () => {
    getLinkBtn.disabled = true;
    setupStatus.textContent = 'Setting up your personal feed...';

    const WORKER_BASE_URL = 'https://square-shadow-4dea.leviflower04.workers.dev';
    const OWNER_SECRET = 'workaxle123';

    try {
      // Check if already registered — reuse existing feed URL
      const existing = await chrome.runtime.sendMessage({ type: 'get-feed-url' });
      if (existing.feedUrl) {
        setupStatus.textContent = '';
        showAppleReady(existing.feedUrl);
        return;
      }

      const resp = await chrome.runtime.sendMessage({
        type: 'register-worker',
        workerBaseUrl: WORKER_BASE_URL,
        ownerSecret: OWNER_SECRET
      });

      if (resp.success) {
        setupStatus.textContent = '';
        showAppleReady(resp.feedUrl);
        showResult('Your personal feed is ready! Copy the link and add it to Apple Calendar.');
      } else {
        setupStatus.textContent = resp.error || 'Setup failed. Make sure WorkAxle is open first.';
      }
    } catch (err) {
      setupStatus.textContent = 'Error: ' + err.message;
    } finally {
      getLinkBtn.disabled = false;
    }
  });

  // Reset button — ask for confirmation first
  resetWorkerBtn.addEventListener('click', async () => {
    if (!confirm('This will remove your saved feed link. You will need to re-add the new link to Apple Calendar. Are you sure?')) return;
    await chrome.storage.local.remove(['cloudflareWorkerUrl', 'cloudflareUserId', 'cloudflareUserSecret', 'cloudflareWorkerSecret', 'cloudflareFeedUrl']);
    appleSetup.classList.remove('hidden');
    appleReady.classList.add('hidden');
    setupStatus.textContent = '';
    hideResult();
  });

  copyUrlBtn.addEventListener('click', () => {
    if (!feedUrlInput || !feedUrlInput.value) {
      showResult('No feed URL yet.', true);
      return;
    }
    navigator.clipboard.writeText(feedUrlInput.value).then(() => {
      copyUrlBtn.textContent = '✓';
      setTimeout(() => { copyUrlBtn.textContent = '⎘'; }, 1500);
    });
  });

  // Legacy save worker btn (hidden but keep functional)
  saveWorkerBtn && saveWorkerBtn.addEventListener && saveWorkerBtn.addEventListener('click', async () => {
    const url = workerBaseInput.value.trim();
    const secret = workerSecretInput.value.trim();
    if (url) await chrome.runtime.sendMessage({ type: 'set-worker-url', url, secret });
  });

  // ── Push tokens ──────────────────────────────────────────────────────────────

  pushTokensBtn.addEventListener('click', async () => {
    pushTokensBtn.disabled = true;
    pushTokensBtn.textContent = 'Pushing...';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'push-tokens-now' });
      if (result.success) {
        pushTokensBtn.textContent = '✓ Tokens pushed!';
        showResult('Tokens pushed to Cloudflare Worker successfully. Your iCal feed is now up to date.');
      } else {
        pushTokensBtn.textContent = 'Push Tokens to Worker Now';
        showResult('Push failed: ' + (result.reason || result.error || 'unknown error'), true);
      }
    } catch (err) {
      pushTokensBtn.textContent = 'Push Tokens to Worker Now';
      showResult('Push failed: ' + err.message, true);
    } finally {
      pushTokensBtn.disabled = false;
      setTimeout(() => { pushTokensBtn.textContent = 'Push Tokens to Worker Now'; }, 3000);
    }
  });

  // ── Google sync ───────────────────────────────────────────────────────────────

  syncBtn.addEventListener('click', async () => {
    if (isBusy) return;
    hideResult();
    setBusy(true, syncBtn);
    setStatus('Starting sync...', true);

    try {
      const calendarId = calendarSelect.value || 'primary';
      const response = await chrome.runtime.sendMessage({ type: 'sync', calendarId });

      if (response.success) {
        if (response.error) {
          setStatus('');
          showResult(response.error, true);
        } else {
          const { created, updated, deleted, total } = response;
          setStatus('Sync complete!');
          showResult(`Synced ${total} shifts: ${created} new, ${updated} updated, ${deleted} removed`);
        }
      } else {
        setStatus('');
        showResult(response.error || 'Sync failed', true);
      }
    } catch (err) {
      setStatus('');
      showResult(err.message, true);
    } finally {
      setBusy(false, syncBtn);
      spinner.classList.add('hidden');
    }
  });


  // ── iCal export ───────────────────────────────────────────────────────────────

  exportIcsBtn.addEventListener('click', async () => {
    if (isBusy) return;
    hideResult();
    setBusy(true, exportIcsBtn);
    setStatus('Fetching shifts for export...', true);

    try {
      const response = await chrome.runtime.sendMessage({ type: 'export-ics' });

      if (response.success) {
        // Trigger download
        const blob = new Blob([response.icsContent], { type: 'text/calendar;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `workaxle-shifts-${new Date().toISOString().split('T')[0]}.ics`;
        a.click();
        URL.revokeObjectURL(url);

        setStatus('');
        showResult('iCal file downloaded! Import it into Apple Calendar, Outlook, or any calendar app.');
      } else {
        setStatus('');
        showResult(response.error || 'Export failed', true);
      }
    } catch (err) {
      setStatus('');
      showResult(err.message, true);
    } finally {
      setBusy(false, exportIcsBtn);
      spinner.classList.add('hidden');
    }
  });

  // ── Status messages from service worker ───────────────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'status-update' && isBusy) {
      setStatus(message.message || message.status, true);
    }
  });

  // ── Last sync display ────────────────────────────────────────────────────────

  async function loadLastSync() {
    const stored = await chrome.storage.local.get(['lastSyncTime', 'lastSyncSummary']);
    if (stored.lastSyncTime) {
      const date = new Date(stored.lastSyncTime);
      const timeStr = date.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
      const dateStr = date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
      const isToday = date.toDateString() === new Date().toDateString();
      lastSyncDiv.textContent = `Last synced: ${isToday ? timeStr : dateStr + ' ' + timeStr}`;
      lastSyncDiv.classList.remove('hidden');
    }
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  (async () => {
    await loadAppleState().catch(() => {});
    await loadLastSync().catch(() => {});
    await checkTokens().catch(() => {
      tokenStatus.classList.add('no-tokens');
      tokenStatus.querySelector('.status-text').textContent = 'No tokens — refresh WorkAxle page';
    });
    await loadAccount().catch(() => {});
    await loadCalendars(false).catch(() => {});
    setStatus('');
  })();
})();
