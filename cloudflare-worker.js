/**
 * WorkAxle iCal Feed — Cloudflare Worker (Multi-User)
 *
 * One Worker serves all users. Each user gets their own private feed URL.
 * No Cloudflare account needed for users — just install the extension and click Subscribe.
 *
 * Endpoints:
 *   POST /register        { ownerSecret, authToken, clusterId, companyId }
 *                         → { success, userId, userSecret, feedUrl }
 *   POST /update-tokens   { userId, userSecret, authToken, clusterId, companyId }
 *                         → { success }
 *   GET  /feed            ?user=ID&secret=S  → .ics file
 *
 * One-time owner setup:
 *   1. Deploy this Worker
 *   2. Create a KV namespace named TOKENS and bind it to the Worker
 *   3. Add secret: OWNER_SECRET — any password you choose
 *   4. Add secret: WORKER_BASE_URL — your worker URL e.g. https://your-worker.workers.dev
 */

const API_BASE = 'https://api.app.workaxle.com/v1';
const FOUR_WEEKS_DAYS = 28;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function resp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

function icsResp(ics) {
  return new Response(ics, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="workaxle.ics"',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    }
  });
}

function generateId(len = 24) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => chars[b % chars.length]).join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── POST /register ────────────────────────────────────────────────────────
    if (url.pathname === '/register' && request.method === 'POST') {
      try {
        const body = await request.json();

        // Verify owner secret — rejects requests not from the extension
        if (!env.OWNER_SECRET || body.ownerSecret !== env.OWNER_SECRET) {
          return resp({ success: false, error: 'Unauthorized' }, 401);
        }
        if (!body.authToken || !body.clusterId) {
          return resp({ success: false, error: 'Missing tokens — open WorkAxle first' }, 400);
        }
        // Basic token validation — must look like a Bearer token
        if (!body.authToken.startsWith('Bearer ')) {
          return resp({ success: false, error: 'Invalid token format' }, 400);
        }

        const userId = generateId(16);
        const userSecret = generateId(24);

        await env.TOKENS.put(`user:${userId}`, JSON.stringify({
          userSecret,
          authToken: body.authToken,
          clusterId: body.clusterId,
          companyId: body.companyId || '1',
          updatedAt: Date.now()
        }));

        const workerBase = env.WORKER_BASE_URL || `https://${url.hostname}`;
        const feedUrl = `${workerBase}/feed?user=${userId}&secret=${userSecret}`;

        return resp({ success: true, userId, userSecret, feedUrl });
      } catch (err) {
        return resp({ success: false, error: err.message }, 500);
      }
    }

    // ── POST /update-tokens ───────────────────────────────────────────────────
    if (url.pathname === '/update-tokens' && request.method === 'POST') {
      try {
        const body = await request.json();

        // Support both single-user (legacy) and multi-user modes
        if (body.userId && body.userSecret) {
          const raw = await env.TOKENS.get(`user:${body.userId}`);
          if (!raw) return resp({ success: false, error: 'User not found' }, 404);
          const user = JSON.parse(raw);
          if (user.userSecret !== body.userSecret) {
            return resp({ success: false, error: 'Unauthorized' }, 401);
          }
          user.authToken = body.authToken;
          user.clusterId = body.clusterId;
          user.companyId = body.companyId || user.companyId || '1';
          user.updatedAt = Date.now();
          await env.TOKENS.put(`user:${body.userId}`, JSON.stringify(user));
          return resp({ success: true });
        }

        // Legacy single-user mode
        if (env.FEED_SECRET && body.secret !== env.FEED_SECRET) {
          return resp({ success: false, error: 'Unauthorized' }, 401);
        }
        if (env.TOKENS) {
          await env.TOKENS.put('authToken', body.authToken);
          await env.TOKENS.put('clusterId', body.clusterId);
          await env.TOKENS.put('companyId', body.companyId || '1');
          await env.TOKENS.put('updatedAt', String(Date.now()));
        }
        return new Response('Tokens updated', { status: 200, headers: CORS });
      } catch (err) {
        return resp({ success: false, error: err.message }, 500);
      }
    }

    // ── GET /feed ─────────────────────────────────────────────────────────────
    if (url.pathname === '/feed') {
      const userId = url.searchParams.get('user');
      const userSecret = url.searchParams.get('secret');

      if (!userId || !userSecret) {
        return new Response('Missing user or secret', { status: 400, headers: CORS });
      }

      try {
        const raw = await env.TOKENS.get(`user:${userId}`);
        if (!raw) return new Response('User not found', { status: 404, headers: CORS });

        const user = JSON.parse(raw);
        if (user.userSecret !== userSecret) {
          return new Response('Unauthorized', { status: 401, headers: CORS });
        }

        // Always try to fetch shifts first — only show reminder if tokens actually fail
        // This means the reminder only appears when genuinely needed, not on a timer
        try {
          const shifts = await fetchShifts(user.authToken, user.clusterId, user.companyId || '1');
          const ics = generateICS(shifts);
          return icsResp(ics);
        } catch (fetchErr) {
          // Only show reminder if tokens have actually expired (401)
          // For other errors (network, WorkAxle down) return last known state or error
          if (fetchErr.message.includes('expired') || fetchErr.message.includes('401')) {
            return icsResp(generateReminderICS());
          }
          // For other errors don't wipe the calendar — return a 500 so the
          // calendar app retries next hour rather than showing a reminder
          return new Response(`Error: ${fetchErr.message}`, { status: 500, headers: CORS });
        }
      } catch (err) {
        return new Response(`Error: ${err.message}`, { status: 500, headers: CORS });
      }
    }

    // ── Legacy single-user feed (GET /) ───────────────────────────────────────
    if (url.pathname === '/') {
      const secret = url.searchParams.get('secret');
      if (env.FEED_SECRET && secret !== env.FEED_SECRET) {
        return new Response('Unauthorized', { status: 401, headers: CORS });
      }
      try {
        const authToken = (env.TOKENS && await env.TOKENS.get('authToken')) || env.WORKAXLE_AUTH_TOKEN;
        const clusterId = (env.TOKENS && await env.TOKENS.get('clusterId')) || env.WORKAXLE_CLUSTER_ID;
        const companyId = (env.TOKENS && await env.TOKENS.get('companyId')) || env.WORKAXLE_COMPANY_ID || '1';
        const updatedAt = env.TOKENS ? Number(await env.TOKENS.get('updatedAt') || 0) : 0;
        const ageHours = (Date.now() - updatedAt) / 3600000;

        if (ageHours > TOKEN_STALE_HOURS && updatedAt > 0) {
          return icsResp(generateReminderICS());
        }

        try {
          const shifts = await fetchShifts(authToken, clusterId, companyId);
          return icsResp(generateICS(shifts));
        } catch (fetchErr) {
          if (fetchErr.message.includes('expired') || fetchErr.message.includes('401')) {
            return icsResp(generateReminderICS());
          }
          return new Response(`Error: ${fetchErr.message}`, { status: 500, headers: CORS });
        }
      } catch (err) {
        return new Response(`Error: ${err.message}`, { status: 500, headers: CORS });
      }
    }

    return new Response('Not found', { status: 404, headers: CORS });
  }
};

// ─── Reminder ICS (shown when tokens are stale) ───────────────────────────────

function generateReminderICS() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);

  function icsDate(d) {
    return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  }

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WorkAxle Sync//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:WorkAxle Shifts',
    'X-WR-TIMEZONE:Australia/Sydney',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    'BEGIN:VEVENT',
    `UID:workaxle-refresh-reminder@workaxle-sync`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(tomorrow)}`,
    `DTEND:${icsDate(new Date(tomorrow.getTime() + 1800000))}`,
    'SUMMARY:⚠️ Open WorkAxle to refresh your calendar',
    'DESCRIPTION:Your WorkAxle calendar feed needs refreshing.\\nJust open WorkAxle in your browser and your shifts will update automatically.',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Open WorkAxle to refresh your shift calendar',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ];

  return lines.join('\r\n');
}

// ─── WorkAxle API ─────────────────────────────────────────────────────────────

async function fetchShifts(authToken, clusterId, companyId) {
  if (!authToken || !clusterId) {
    throw new Error('Missing tokens');
  }

  const today = new Date();
  const endDate = new Date(today);
  endDate.setDate(today.getDate() + FOUR_WEEKS_DAYS);

  const params = new URLSearchParams();
  params.append('filter[start_on][between][]', today.toISOString().split('T')[0]);
  params.append('filter[start_on][between][]', endDate.toISOString().split('T')[0]);
  params.append('display', 'employee_assigned');
  params.append('page[number]', '1');
  params.append('page[size]', '999');
  params.append('include', [
    'shiftsJobs.schedules.employee.profile',
    'shiftTags',
    'shiftsJobs.job',
    'branch',
    'shiftsJobs.timeBucketChild',
    'shiftsJobs.timeBucketChild.timeBucketParent'
  ].join(','));

  const response = await fetch(`${API_BASE}/companies/${companyId}/shifts?${params}`, {
    headers: {
      'Authorization': authToken,
      'Cluster-Id': clusterId,
      'Accept': 'application/vnd.api+json'
    }
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error('WorkAxle token expired');
    throw new Error(`WorkAxle API error: ${response.status}`);
  }

  return parseShifts(await response.json());
}

function parseShifts(json) {
  const map = {};
  (json.included || []).forEach(i => { map[`${i.type}:${i.id}`] = i; });

  const find = (type, id) => id ? (map[`${type}:${id}`] || null) : null;
  const attr = (obj, key) => obj?.attributes?.[key] ?? null;
  const shifts = [];

  for (const shift of (json.data || [])) {
    const attrs = shift.attributes || {};
    const rels = shift.relationships || {};
    const startTime = attrs.startAt || attrs.start_at;
    const endTime = attrs.finishAt || attrs.end_at;
    if (!startTime || !endTime) continue;

    let jobName = attrs.name || attrs.role || 'ICC Shift';
    let siteName = null;
    let employeeName = null;
    let costGroup = null, costSubGroup = null;
    const tags = [];
    const note = attrs.note || attrs.notes || null;

    if (rels.branch?.data) {
      const b = find('branches', rels.branch.data.id);
      siteName = b ? attr(b, 'name') : null;
    }

    for (const sjRef of [].concat(rels.shiftsJobs?.data || [])) {
      const sj = find('shiftsJobs', sjRef.id);
      if (!sj) continue;

      if (sj.relationships?.job?.data) {
        const job = find('jobs', sj.relationships.job.data.id);
        if (job) jobName = attr(job, 'name') || jobName;
      }

      const schedRef = sj.relationships?.schedule?.data || sj.relationships?.schedules?.data?.[0];
      if (schedRef?.id && !employeeName) {
        const sched = find('schedules', schedRef.id);
        if (sched?.relationships?.employee?.data) {
          const emp = find('employees', sched.relationships.employee.data.id);
          employeeName = emp ? attr(emp, 'name') : null;
        }
      }

      if (!costGroup && sj.relationships?.timeBucketChild?.data) {
        const tbc = find('timeBucketChildren', sj.relationships.timeBucketChild.data.id);
        if (tbc) {
          costSubGroup = attr(tbc, 'name');
          const tbp = find('timeBucketParents', tbc.relationships?.timeBucketParent?.data?.id);
          costGroup = tbp ? attr(tbp, 'name') : null;
        }
      }
    }

    for (const tagRef of [].concat(rels.shiftTags?.data || [])) {
      const tag = find('shiftTag', tagRef.id);
      const name = tag ? (attr(tag, 'name') || attr(tag, 'label')) : null;
      if (name) tags.push(name);
    }

    const costGroupSubGroup = costGroup && costSubGroup
      ? `${costGroup} / ${costSubGroup}`
      : (costGroup || costSubGroup || null);

    shifts.push({ id: shift.id, startTime, endTime, roleName: jobName, siteName, employeeName, tags, costGroupSubGroup, note });
  }

  return shifts;
}

// ─── iCal generation ─────────────────────────────────────────────────────────

function generateICS(shifts) {
  const icsDate = d => new Date(d).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const esc = s => s ? s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n') : '';

  function fold(line) {
    if (line.length <= 75) return line;
    const chunks = [];
    let i = 0;
    while (i < line.length) {
      chunks.push((i === 0 ? '' : ' ') + line.slice(i, i + (i === 0 ? 75 : 74)));
      i += i === 0 ? 75 : 74;
    }
    return chunks.join('\r\n');
  }

  const now = icsDate(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WorkAxle Sync//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:WorkAxle Shifts',
    'X-WR-TIMEZONE:Australia/Sydney',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H'
  ];

  for (const s of shifts) {
    try {
      const start = new Date(s.startTime);
      const end = new Date(s.endTime);
      if (isNaN(start) || isNaN(end)) continue;

      const durationHrs = ((end - start) / 3600000).toFixed(2);
      const startStr = start.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Sydney' });
      const endStr = end.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Sydney' });
      const dateStr = start.toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Australia/Sydney' });

      const desc = [
        'Schedule Details',
        dateStr,
        `${startStr} - ${endStr} (${durationHrs} hrs)`,
        '',
        s.employeeName ? `Employee: ${s.employeeName}` : null,
        s.roleName ? `Position: ${s.roleName}` : null,
        s.costGroupSubGroup ? `Cost Group / Sub Group: ${s.costGroupSubGroup}` : null,
        s.tags?.length ? `Tags: ${s.tags.join(', ')}` : null,
        s.note ? `Note: ${s.note}` : null
      ].filter(v => v !== null).join('\\n');

      lines.push('BEGIN:VEVENT');
      lines.push(`UID:workaxle-${s.id}@workaxle-sync`);
      lines.push(`DTSTAMP:${now}`);
      lines.push(`DTSTART:${icsDate(s.startTime)}`);
      lines.push(`DTEND:${icsDate(s.endTime)}`);
      lines.push(fold(`SUMMARY:${esc(s.roleName)}`));
      if (s.siteName) lines.push(fold(`LOCATION:${esc(s.siteName)}`));
      if (desc) lines.push(fold(`DESCRIPTION:${desc}`));
      lines.push('END:VEVENT');
    } catch { continue; }
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
