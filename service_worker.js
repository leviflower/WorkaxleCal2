const API_BASE = 'https://api.app.workaxle.com/v1';
const GRAPHQL_ENDPOINT = 'https://api.app.workaxle.com/v2/graphql';
const SOURCE_TAG = 'workaxle';
const FOUR_WEEKS_DAYS = 28;

let authToken = null;
let clusterId = null;
let companyId = '1';
let accessToken = null;
let selectedCalendarId = 'primary';

const scheduleDetailsCache = new Map();

const STATUS = {
  IDLE: 'idle',
  SIGNING_IN: 'signing_in',
  FETCHING_SHIFTS: 'fetching_shifts',
  SYNCING: 'syncing',
  DONE: 'done',
  ERROR: 'error'
};

let currentStatus = STATUS.IDLE;
let statusListeners = [];

function notifyStatus(status, message = '') {
  currentStatus = status;
  statusListeners.forEach(fn => fn(status, message));
  // Broadcast to popup
  chrome.runtime.sendMessage({ type: 'status-update', status, message }).catch(() => {});
}

function onStatusChange(fn) {
  statusListeners.push(fn);
}

// ─── Token storage ──────────────────────────────────────────────────────────

async function storeTokens(token, cluster, company) {
  authToken = token;
  clusterId = cluster;
  companyId = company || companyId || '1';
  await chrome.storage.session.set({
    workaxleAuthToken: token,
    workaxleClusterId: cluster,
    workaxleCompanyId: companyId
  });
}

async function loadStoredTokens() {
  const result = await chrome.storage.session.get([
    'workaxleAuthToken', 'workaxleClusterId', 'workaxleCompanyId'
  ]);
  if (result.workaxleAuthToken && result.workaxleClusterId) {
    authToken = result.workaxleAuthToken;
    clusterId = result.workaxleClusterId;
    companyId = result.workaxleCompanyId || '1';
    return true;
  }
  return false;
}

// ─── WorkAxle API ────────────────────────────────────────────────────────────

async function fetchShifts(startDate, endDate) {
  if (!authToken || !clusterId) {
    throw new Error('Missing WorkAxle tokens. Please refresh the WorkAxle schedule page.');
  }

  const params = new URLSearchParams();
  params.append('filter[start_on][between][]', startDate);
  params.append('filter[start_on][between][]', endDate);
  params.append('display', 'employee_assigned');
  params.append('page[number]', '1');
  params.append('page[size]', '999');
  params.append('include', [
    'shiftsJobs.schedules.employee.profile.profileAvatar',
    'pauses',
    'shiftTags',
    'shiftsJobs.job',
    'branch',
    'shiftsJobs.schedules.acceptedShiftTrades.acceptedEmployee.profile',
    'shiftsJobs.schedules.fromShiftTrades.fromEmployee.profile',
    'shiftsJobs.schedules.fromShiftTrades.toSchedules.shift',
    'shiftsJobs.schedules.shiftCovers.fromEmployee.profile',
    'shiftsJobs.schedules.shiftCovers.toEmployees.profile',
    'shiftsJobs.schedules.timeEntry',
    'shiftsJobs.segments',
    'timeBucket',
    'timeBucket.timeBucketParent',
    'shiftsJobs.timeBucketChild',
    'shiftsJobs.timeBucketChild.timeBucketParent'
  ].join(','));

  const url = `${API_BASE}/companies/${companyId}/shifts?${params}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': authToken,
      'Cluster-Id': clusterId,
      'Accept': 'application/vnd.api+json'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WorkAxle API error: ${response.status} - ${text.substring(0, 100)}`);
  }

  return await response.json();
}

function parseShifts(json) {
  const shifts = [];
  const includedMap = {};

  if (json.included) {
    json.included.forEach(item => {
      includedMap[`${item.type}:${item.id}`] = item;
    });
  }

  function findIncluded(type, id) {
    return id ? (includedMap[`${type}:${id}`] || null) : null;
  }

  function getAttr(obj, key) {
    return obj?.attributes?.[key] ?? null;
  }

  (json.data || []).forEach(shift => {
    const attrs = shift.attributes || {};
    const relationships = shift.relationships || {};

    const startTime = attrs.startAt || attrs.start_at;
    const endTime = attrs.finishAt || attrs.end_at;

    if (!startTime || !endTime) return;

    let roleName = attrs.name || attrs.role || attrs.positionName || null;
    let siteName = null;
    let employeeName = null;
    let jobName = roleName;
    let jobDepartment = null;
    let jobTeam = null;
    let scheduleId = null;
    let tags = [];
    let costGroup = null;
    let costSubGroup = null;
    let note = null;

    // Branch / site
    if (relationships.branch?.data) {
      const branch = findIncluded('branches', relationships.branch.data.id);
      siteName = branch ? getAttr(branch, 'name') : null;
    }

    // shiftsJobs → job, schedule → employee, cost group
    const shiftsJobsData = relationships.shiftsJobs?.data;
    if (shiftsJobsData) {
      const jobList = Array.isArray(shiftsJobsData) ? shiftsJobsData : [shiftsJobsData];
      for (const sj of jobList) {
        const shiftsJob = findIncluded('shiftsJobs', sj.id);
        if (!shiftsJob) continue;

        // Job
        if (shiftsJob.relationships?.job?.data) {
          const job = findIncluded('jobs', shiftsJob.relationships.job.data.id);
          if (job) {
            jobName = getAttr(job, 'name') || jobName;
            jobDepartment = getAttr(job, 'department') || jobDepartment;
            jobTeam = getAttr(job, 'team') || jobTeam;
          }
        }

        // Schedule → employee
        const schedRef =
          shiftsJob.relationships?.schedule?.data ||
          shiftsJob.relationships?.schedules?.data?.[0] ||
          null;

        if (schedRef?.id) {
          if (!scheduleId) scheduleId = schedRef.id;
          const schedule = findIncluded('schedules', schedRef.id);
          if (!employeeName && schedule?.relationships?.employee?.data) {
            const employee = findIncluded('employees', schedule.relationships.employee.data.id);
            employeeName = employee ? getAttr(employee, 'name') : null;
          }
        }

        // Cost group from shiftsJob attributes
        if (!costGroup) {
          costGroup = getAttr(shiftsJob, 'costGroup') || getAttr(shiftsJob, 'cost_group');
          costSubGroup = getAttr(shiftsJob, 'costSubGroup') || getAttr(shiftsJob, 'cost_sub_group');
        }

        // Cost group from timeBucket relationship
        if (!costGroup && shiftsJob.relationships?.timeBucket?.data) {
          const tb = findIncluded('timeBuckets', shiftsJob.relationships.timeBucket.data.id);
          if (tb) {
            costGroup = getAttr(tb, 'costGroup') || getAttr(tb, 'cost_group');
            costSubGroup = getAttr(tb, 'costSubGroup') || getAttr(tb, 'cost_sub_group');
          }
        }

        // Cost group from timeBucketChild
        if (!costGroup && shiftsJob.relationships?.timeBucketChild?.data) {
          const tbc = findIncluded('timeBucketChildren', shiftsJob.relationships.timeBucketChild.data.id);
          if (tbc) {
            costSubGroup = getAttr(tbc, 'name');
            if (tbc.relationships?.timeBucketParent?.data) {
              const tbp = findIncluded('timeBucketParents', tbc.relationships.timeBucketParent.data.id);
              costGroup = tbp ? getAttr(tbp, 'name') : null;
            }
          }
        }
      }
    }

    // Tags
    const shiftTagsData = relationships.shiftTags?.data;
    if (shiftTagsData) {
      const tagList = Array.isArray(shiftTagsData) ? shiftTagsData : [shiftTagsData];
      for (const tagRef of tagList) {
        const tag = findIncluded('shiftTag', tagRef.id);
        if (tag) {
          const tagName = getAttr(tag, 'name') || getAttr(tag, 'label') || tag.id;
          if (tagName) tags.push(tagName);
        }
      }
    }

    // Notes
    note = attrs.note || attrs.notes || attrs.description || null;

    // Build cost group string
    let costGroupSubGroup = null;
    if (costGroup && costSubGroup) {
      costGroupSubGroup = `${costGroup} / ${costSubGroup}`;
    } else if (costGroup) {
      costGroupSubGroup = costGroup;
    } else if (costSubGroup) {
      costGroupSubGroup = costSubGroup;
    }

    shifts.push({
      id: shift.id,
      startTime,
      endTime,
      roleName: jobName || roleName || 'ICC Shift',
      department: jobDepartment,
      team: jobTeam,
      siteName,
      employeeName,
      tags,
      costGroup,
      costSubGroup,
      costGroupSubGroup,
      note,
      scheduleId
    });
  });

  const scheduleIds = [...new Set(shifts.map(s => s.scheduleId).filter(Boolean))];
  return { shifts, scheduleIds };
}

function formatScheduleDetails(shift) {
  const lines = ['Schedule Details'];

  if (shift.startTime) {
    const startDate = new Date(shift.startTime);
    lines.push(startDate.toLocaleDateString('en-AU', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    }));
  }

  if (shift.startTime && shift.endTime) {
    const start = new Date(shift.startTime);
    const end = new Date(shift.endTime);
    const startStr = start.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
    const endStr = end.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
    const durationHrs = ((end - start) / 3600000).toFixed(2);
    lines.push(`${startStr} – ${endStr} (${durationHrs} hrs)`);
  }

  lines.push('');

  if (shift.employeeName) lines.push(`Employee: ${shift.employeeName}`);

  if (shift.department && shift.roleName) {
    lines.push(`Position: ${shift.department} / ${shift.roleName}`);
  } else if (shift.roleName) {
    lines.push(`Position: ${shift.roleName}`);
  }

  if (shift.tags?.length > 0) {
    lines.push('Tags:');
    shift.tags.forEach(tag => lines.push(`- ${tag}`));
  }

  if (shift.costGroupSubGroup) lines.push(`Cost Group / Sub Group: ${shift.costGroupSubGroup}`);
  if (shift.note) lines.push(`Note: ${shift.note}`);

  return lines.join('\n');
}

async function fetchScheduleDetails(scheduleId) {
  if (!scheduleId) return null;

  if (scheduleDetailsCache.has(scheduleId)) {
    return scheduleDetailsCache.get(scheduleId);
  }

  const stored = await chrome.storage.session.get(`schedule_${scheduleId}`);
  if (stored[`schedule_${scheduleId}`]) {
    const cached = stored[`schedule_${scheduleId}`];
    scheduleDetailsCache.set(scheduleId, cached);
    return cached;
  }

  if (!authToken || !clusterId) return null;

  const query = `query Schedule($id: ID!) {
    schedule(id: $id) {
      id
      shift {
        timeBucketChild {
          name
          timeBucketParent { name }
        }
      }
    }
  }`;

  try {
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': authToken,
        'Cluster-Id': clusterId,
        'company-id': companyId,
        'core-company-id': companyId,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ operationName: 'Schedule', query, variables: { id: scheduleId } })
    });

    if (!response.ok) return null;

    const json = await response.json();
    if (json.errors) return null;

    const timeBucketChild = json.data?.schedule?.shift?.timeBucketChild;
    if (!timeBucketChild) return null;

    const costGroupName = timeBucketChild.timeBucketParent?.name || null;
    const subGroupName = timeBucketChild.name || null;

    let costGroupSubGroup = null;
    if (costGroupName && subGroupName) {
      costGroupSubGroup = `${costGroupName} / ${subGroupName}`;
    } else if (subGroupName) {
      costGroupSubGroup = subGroupName;
    }

    const result = { costGroupName, subGroupName, costGroupSubGroup };
    scheduleDetailsCache.set(scheduleId, result);
    await chrome.storage.session.set({ [`schedule_${scheduleId}`]: result });

    return result;
  } catch {
    return null;
  }
}

// ─── Date helpers ────────────────────────────────────────────────────────────

function formatDateForApi(date) {
  return date.toISOString().split('T')[0];
}

function getDateRange() {
  const today = new Date();
  const end = new Date(today);
  end.setDate(today.getDate() + FOUR_WEEKS_DAYS);
  return { start: formatDateForApi(today), end: formatDateForApi(end) };
}

// ─── Google OAuth ────────────────────────────────────────────────────────────
// Uses launchWebAuthFlow instead of getAuthToken so that:
//   1. The account picker is always shown — never auto-selects the browser default
//   2. Works correctly in Brave (getAuthToken is Chrome-profile-bound)

const OAUTH_CLIENT_ID = '291403322848-0qo05bs5bdo2gt9pi00ktclpn88omgjs.apps.googleusercontent.com';
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
].join(' ');

let authInProgress = false;

async function getGoogleAuth(interactive = true) {
  // If we already have a valid token, use it
  if (accessToken) {
    const ok = await verifyToken(accessToken);
    if (ok) return accessToken;
    accessToken = null;
    await chrome.storage.session.remove('googleAccessToken');
  }

  // Always check session storage first regardless of interactive flag
  const stored = await chrome.storage.session.get('googleAccessToken');
  if (stored.googleAccessToken) {
    const ok = await verifyToken(stored.googleAccessToken);
    if (ok) {
      accessToken = stored.googleAccessToken;
      return accessToken;
    }
    await chrome.storage.session.remove('googleAccessToken');
  }

  // Non-interactive: return null rather than opening a popup
  if (!interactive) return null;

  // Prevent concurrent auth popups
  if (authInProgress) throw new Error('Sign-in already in progress');
  authInProgress = true;

  try {
    const redirectUri = chrome.identity.getRedirectURL();
    const authUrl =
      'https://accounts.google.com/o/oauth2/v2/auth' +
      `?client_id=${encodeURIComponent(OAUTH_CLIENT_ID)}` +
      `&response_type=token` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(OAUTH_SCOPES)}` +
      `&prompt=consent%20select_account`;

    return await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (responseUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error('OAuth error: ' + chrome.runtime.lastError.message));
          return;
        }
        if (!responseUrl) {
          reject(new Error('Sign-in was cancelled'));
          return;
        }

        const url = new URL(responseUrl);
        const params = new URLSearchParams(url.hash.replace('#', '?'));
        const token = params.get('access_token') || new URLSearchParams(url.search).get('access_token');

        if (!token) {
          reject(new Error('No access token in OAuth response'));
          return;
        }

        accessToken = token;
        await chrome.storage.session.set({ googleAccessToken: token });
        resolve(token);
      });
    });
  } finally {
    authInProgress = false;
  }
}

async function verifyToken(token) {
  try {
    const response = await fetch(
      `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${token}`
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function signOutGoogle() {
  const token = accessToken;
  accessToken = null;
  await chrome.storage.session.remove('googleAccessToken');

  if (token) {
    try {
      await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
    } catch { /* ignore */ }
  }
}

async function getGoogleAccountInfo() {
  try {
    const token = await getGoogleAuth(false);
    if (!token) return null;
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) return null;
    return await response.json(); // { email, name, picture }
  } catch {
    return null;
  }
}

// ─── Google Calendar API ─────────────────────────────────────────────────────

function normalizeCalendarId(calendarId) {
  // Google Calendar API requires 'primary' for the primary calendar
  // Do NOT convert email IDs — they are valid calendar IDs
  return calendarId || 'primary';
}

async function listCalendars() {
  const response = await fetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList',
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch calendars: ${response.status} - ${text.substring(0, 100)}`);
  }
  const data = await response.json();
  return data.items || [];
}

async function listEvents(calendarId, startDate, endDate) {
  const params = new URLSearchParams({
    timeMin: startDate + 'T00:00:00Z',
    timeMax: endDate + 'T23:59:59Z',
    privateExtendedProperty: `source=${SOURCE_TAG}`,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '2500'
  });

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(normalizeCalendarId(calendarId))}/events?${params}`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error('Failed to fetch calendar events: ' + response.status + ' - ' + text.substring(0, 100));
  }

  const data = await response.json();
  return data.items || [];
}

function makeEventId(shiftId) {
  // Google Calendar event IDs must be 5-1024 chars, only base32hex: [a-v][0-9]
  // (w, x, y, z are NOT valid). Prefix "shift" + padded ID satisfies this.
  const padded = String(shiftId).replace(/[^0-9a-v]/gi, '');
  return `shift${padded}`;
}

async function upsertEvent(calendarId, shift, existingEventIds) {
  const eventId = makeEventId(shift.id);
  const start = new Date(shift.startTime);
  const end = new Date(shift.endTime);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;

  const scheduleDetails = formatScheduleDetails(shift);

  const event = {
    id: eventId,
    summary: shift.roleName,
    location: shift.siteName || '',
    description: `Shift ID: ${shift.id}\n\n${scheduleDetails}`,
    start: { dateTime: start.toISOString(), timeZone: 'Australia/Sydney' },
    end: { dateTime: end.toISOString(), timeZone: 'Australia/Sydney' },
    extendedProperties: {
      private: { source: SOURCE_TAG, shift_id: String(shift.id) }
    }
  };

  const calId = normalizeCalendarId(calendarId);
  const exists = existingEventIds.has(eventId);

  let url, method;
  if (exists) {
    url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${eventId}`;
    method = 'PATCH';
  } else {
    url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`;
    method = 'POST';
  }

  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(event)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to upsert event: ${response.status} - ${text.substring(0, 200)}`);
  }

  return await response.json();
}

async function deleteEvent(calendarId, eventId) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(normalizeCalendarId(calendarId))}/events/${eventId}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  return response.ok || response.status === 404;
}

// ─── iCal generation ─────────────────────────────────────────────────────────

function generateICS(shifts) {
  function icsDate(dateStr) {
    return new Date(dateStr).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  }

  function icsEscape(str) {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  }

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WorkAxle Sync//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:WorkAxle Shifts',
    'X-WR-TIMEZONE:Australia/Sydney'
  ];

  for (const shift of shifts) {
    const start = new Date(shift.startTime);
    const end = new Date(shift.endTime);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;

    const description = formatScheduleDetails(shift);

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:workaxle-${shift.id}@workaxle-sync`);
    lines.push(`DTSTAMP:${icsDate(new Date().toISOString())}`);
    lines.push(`DTSTART:${icsDate(shift.startTime)}`);
    lines.push(`DTEND:${icsDate(shift.endTime)}`);
    lines.push(`SUMMARY:${icsEscape(shift.roleName)}`);
    if (shift.siteName) lines.push(`LOCATION:${icsEscape(shift.siteName)}`);
    lines.push(`DESCRIPTION:${icsEscape(description)}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// ─── Main sync ───────────────────────────────────────────────────────────────

async function syncShifts() {
  const { start, end } = getDateRange();

  notifyStatus(STATUS.FETCHING_SHIFTS, 'Fetching shifts from WorkAxle...');
  const json = await fetchShifts(start, end);

  const apiShiftCount = json.data?.length || 0;
  const { shifts, scheduleIds } = parseShifts(json);

  if (apiShiftCount > 0 && shifts.length === 0) {
    const errorMsg = `API returned ${apiShiftCount} shifts but parser produced 0 — check console for details.`;
    notifyStatus(STATUS.ERROR, errorMsg);
    return { created: 0, updated: 0, deleted: 0, total: 0, error: errorMsg };
  }

  if (shifts.length === 0) {
    notifyStatus(STATUS.DONE, 'No shifts found in the next 4 weeks');
    return { created: 0, updated: 0, deleted: 0, total: 0 };
  }

  // Enrich with schedule details (cost group / sub group) via GraphQL
  for (const schedId of scheduleIds) {
    const details = await fetchScheduleDetails(schedId);
    if (details?.costGroupSubGroup) {
      shifts.forEach(s => {
        if (s.scheduleId === schedId && !s.costGroupSubGroup) {
          s.costGroupSubGroup = details.costGroupSubGroup;
        }
      });
    }
  }

  notifyStatus(STATUS.SYNCING, `Syncing ${shifts.length} shifts to Google Calendar...`);

  const existingEvents = await listEvents(selectedCalendarId, start, end);
  const existingEventIds = new Set(existingEvents.map(e => e.id));
  const processedEventIds = new Set();

  let created = 0;
  let updated = 0;

  for (const shift of shifts) {
    const eventId = makeEventId(shift.id);
    processedEventIds.add(eventId);

    await upsertEvent(selectedCalendarId, shift, existingEventIds);

    if (existingEventIds.has(eventId)) {
      updated++;
    } else {
      created++;
    }
  }

  let deleted = 0;
  for (const event of existingEvents) {
    if (!processedEventIds.has(event.id)) {
      await deleteEvent(selectedCalendarId, event.id);
      deleted++;
    }
  }

  const summary = `Synced: ${created} new, ${updated} updated, ${deleted} deleted`;
  notifyStatus(STATUS.DONE, summary);
  await chrome.storage.local.set({ lastSyncTime: new Date().toISOString(), lastSyncSummary: summary });
  return { created, updated, deleted, total: shifts.length };
}

async function buildICS() {
  const { start, end } = getDateRange();
  notifyStatus(STATUS.FETCHING_SHIFTS, 'Fetching shifts for iCal export...');
  const json = await fetchShifts(start, end);
  const { shifts, scheduleIds } = parseShifts(json);

  for (const schedId of scheduleIds) {
    const details = await fetchScheduleDetails(schedId);
    if (details?.costGroupSubGroup) {
      shifts.forEach(s => {
        if (s.scheduleId === schedId && !s.costGroupSubGroup) {
          s.costGroupSubGroup = details.costGroupSubGroup;
        }
      });
    }
  }

  return generateICS(shifts);
}



// ─── Cloudflare registration ──────────────────────────────────────────────────

async function registerWithWorker(workerBaseUrl, ownerSecret) {
  // Get current WorkAxle tokens
  const tokens = await chrome.storage.session.get(['workaxleAuthToken', 'workaxleClusterId', 'workaxleCompanyId']);

  if (!tokens.workaxleAuthToken || !tokens.workaxleClusterId) {
    throw new Error('No WorkAxle tokens found. Please open WorkAxle and refresh the schedule page first.');
  }

  const url = `${workerBaseUrl.replace(/\/$/, '')}/register`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ownerSecret,
      authToken: tokens.workaxleAuthToken,
      clusterId: tokens.workaxleClusterId,
      companyId: tokens.workaxleCompanyId || '1'
    })
  });

  const data = await response.json();
  if (!data.success) throw new Error(data.error || 'Registration failed');

  // Save user credentials
  await chrome.storage.local.set({
    cloudflareWorkerUrl: workerBaseUrl.replace(/\/$/, ''),
    cloudflareUserId: data.userId,
    cloudflareUserSecret: data.userSecret,
    cloudflareWorkerSecret: data.userSecret,
    cloudflareFeedUrl: data.feedUrl
  });

  return data.feedUrl;
}


// ─── Cloudflare Worker token push ────────────────────────────────────────────

async function pushTokensToWorker(authToken, clusterId, companyId) {
  const stored = await chrome.storage.local.get([
    'cloudflareWorkerUrl', 'cloudflareUserId', 'cloudflareUserSecret', 'cloudflareWorkerSecret'
  ]);
  const workerUrl = stored.cloudflareWorkerUrl;
  if (!workerUrl) return { success: false, reason: 'no-url' };

  const cleanUrl = workerUrl.replace(/\/$/, '');
  const body = { authToken, clusterId, companyId: companyId || '1' };

  // Multi-user mode
  if (stored.cloudflareUserId) {
    body.userId = stored.cloudflareUserId;
    body.userSecret = stored.cloudflareUserSecret;
  } else {
    // Legacy single-user mode
    body.secret = stored.cloudflareWorkerSecret || '';
  }

  try {
    const response = await fetch(`${cleanUrl}/update-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) return { success: false, reason: `${response.status}: ${text}` };
    await chrome.storage.local.set({ lastTokenPush: new Date().toISOString() });
    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ─── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'get-tokens') {
    sendResponse({
      hasTokens: !!(authToken && clusterId),
      tokenPreview: authToken
        ? `${authToken.substring(0, 6)}...${authToken.substring(authToken.length - 6)}`
        : null
    });
    return true;
  }

  if (message.type === 'tokens-captured') {
    (async () => {
      await storeTokens(message.authorization, message.clusterId, message.companyId);
      notifyStatus(STATUS.IDLE, 'Tokens captured successfully');
      // Push fresh tokens to Cloudflare Worker if configured
      await pushTokensToWorker(message.authorization, message.clusterId, message.companyId).catch(() => {});
      sendResponse({ success: true });
    })();
    return true;
  }

  if (message.type === 'push-tokens-now') {
    (async () => {
      const stored = await chrome.storage.session.get(['workaxleAuthToken', 'workaxleClusterId', 'workaxleCompanyId']);
      if (!stored.workaxleAuthToken) {
        sendResponse({ success: false, error: 'No WorkAxle tokens captured yet' });
        return;
      }
      const result = await pushTokensToWorker(stored.workaxleAuthToken, stored.workaxleClusterId, stored.workaxleCompanyId);
      sendResponse(result);
    })();
    return true;
  }

  if (message.type === 'register-worker') {
    (async () => {
      try {
        const feedUrl = await registerWithWorker(message.workerBaseUrl, message.ownerSecret);
        sendResponse({ success: true, feedUrl });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === 'get-feed-url') {
    (async () => {
      const stored = await chrome.storage.local.get(['cloudflareFeedUrl', 'cloudflareWorkerUrl', 'cloudflareWorkerSecret']);
      const feedUrl = stored.cloudflareFeedUrl ||
        (stored.cloudflareWorkerUrl
          ? `${stored.cloudflareWorkerUrl}/?secret=${stored.cloudflareWorkerSecret || ''}`
          : null);
      sendResponse({ feedUrl });
    })();
    return true;
  }

  if (message.type === 'deploy-cloudflare') {
    (async () => {
      try {
        const { workerUrl, feedSecret } = await deployCloudflareWorker(message.apiToken);
        sendResponse({ success: true, workerUrl, feedSecret });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === 'set-worker-url') {
    (async () => {
      await chrome.storage.local.set({ cloudflareWorkerUrl: message.url, cloudflareWorkerSecret: message.secret });
      sendResponse({ success: true });
    })();
    return true;
  }

  if (message.type === 'get-worker-url') {
    (async () => {
      const stored = await chrome.storage.local.get(['cloudflareWorkerUrl', 'cloudflareWorkerSecret']);
      sendResponse({ url: stored.cloudflareWorkerUrl || '', secret: stored.cloudflareWorkerSecret || '' });
    })();
    return true;
  }

  if (message.type === 'inject-ready') {
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'get-account') {
    (async () => {
      const info = await getGoogleAccountInfo();
      sendResponse({ success: true, account: info });
    })();
    return true;
  }

  if (message.type === 'sign-out') {
    (async () => {
      await signOutGoogle();
      sendResponse({ success: true });
    })();
    return true;
  }

  if (message.type === 'list-calendars') {
    (async () => {
      try {
        // Only use an existing token — do NOT trigger sign-in popup on load
        const token = await getGoogleAuth(message.interactive === true);
        if (!token) {
          sendResponse({ success: false, error: 'not-signed-in' });
          return;
        }
        const calendars = await listCalendars();
        sendResponse({ success: true, calendars });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === 'sync') {
    (async () => {
      try {
        if (!authToken || !clusterId) {
          const hasStored = await loadStoredTokens();
          if (!hasStored) {
            notifyStatus(STATUS.ERROR, 'No tokens. Refresh WorkAxle page first.');
            sendResponse({ success: false, error: 'No tokens captured yet. Please refresh the WorkAxle schedule page.' });
            return;
          }
        }

        notifyStatus(STATUS.SIGNING_IN, 'Signing into Google...');
        await getGoogleAuth();

        if (message.calendarId) {
          selectedCalendarId = message.calendarId;
          await chrome.storage.local.set({ autoSyncCalendarId: message.calendarId });
        }

        const result = await syncShifts();
        sendResponse({ success: true, ...result });
      } catch (error) {
        notifyStatus(STATUS.ERROR, error.message);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === 'export-ics') {
    (async () => {
      try {
        if (!authToken || !clusterId) {
          const hasStored = await loadStoredTokens();
          if (!hasStored) {
            sendResponse({ success: false, error: 'No tokens captured yet. Please refresh the WorkAxle schedule page.' });
            return;
          }
        }
        const icsContent = await buildICS();
        sendResponse({ success: true, icsContent });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  return false;
});

// ─── Init ────────────────────────────────────────────────────────────────────

(async () => {
  await loadStoredTokens();
  // Clear any cached Google token on startup so account picker always shows
  await chrome.storage.session.remove('googleAccessToken');
  accessToken = null;
})();
// ─── Auto-sync (alarms) ──────────────────────────────────────────────────────

const ALARM_NAME = 'workaxle-auto-sync';
const AUTO_SYNC_INTERVAL_MINUTES = 60; // sync every hour

async function runAutoSync() {
  // Only run if we have WorkAxle tokens and a Google token
  const hasWorkaxle = await loadStoredTokens();
  if (!hasWorkaxle) return;

  const token = await getGoogleAuth(false); // non-interactive only
  if (!token) return;

  try {
    // Use last known calendar ID, fall back to primary
    const stored = await chrome.storage.local.get('autoSyncCalendarId');
    if (stored.autoSyncCalendarId) selectedCalendarId = stored.autoSyncCalendarId;
    await syncShifts();
  } catch (err) {
    // Silent fail — will retry on next alarm
  }
}

// Register alarm when extension is installed or browser starts
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: AUTO_SYNC_INTERVAL_MINUTES,
    periodInMinutes: AUTO_SYNC_INTERVAL_MINUTES
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1, // short delay on startup to let tokens load
    periodInMinutes: AUTO_SYNC_INTERVAL_MINUTES
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runAutoSync();
  }
});

