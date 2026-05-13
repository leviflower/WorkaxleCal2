/**
 * WorkAxle iCal Feed — Cloudflare Worker
 *
 * Serves a live .ics feed of your WorkAxle shifts.
 * Apple Calendar, Outlook, and other apps can subscribe to this URL
 * and it will auto-refresh with your latest roster.
 *
 * Setup:
 *   1. Create a Cloudflare account at https://dash.cloudflare.com (free)
 *   2. Go to Workers & Pages → Create Worker
 *   3. Paste this entire file as the worker code
 *   4. Add your secrets via Settings → Variables → Secrets:
 *        WORKAXLE_AUTH_TOKEN   — your Authorization header value
 *        WORKAXLE_CLUSTER_ID   — your Cluster-Id header value
 *        WORKAXLE_COMPANY_ID   — your company ID (usually "1")
 *        FEED_SECRET           — any random string, e.g. "mysecret123"
 *                                (keeps your feed private)
 *   5. Deploy the worker
 *   6. Your feed URL will be:
 *        https://your-worker.your-subdomain.workers.dev/?secret=mysecret123
 *   7. Paste that URL into popup.js → CLOUDFLARE_WORKER_URL
 *
 * How to get your WorkAxle tokens:
 *   - Install the extension, open WorkAxle, let it capture tokens
 *   - Open DevTools on the WorkAxle page → Application → Session Storage
 *   - Copy the values of workaxleAuthToken, workaxleClusterId, workaxleCompanyId
 *
 * Note: Tokens expire. When they do, repeat the step above and update your
 * Worker secrets. You only need to do this when the feed stops working.
 */

const API_BASE = 'https://api.app.workaxle.com/v1';
const FOUR_WEEKS_DAYS = 28;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const secret = url.searchParams.get('secret');

    // ── Token update endpoint (called by the browser extension) ──────────────
    // POST /update-tokens?secret=xxx   { authToken, clusterId, companyId }
    if (url.pathname === '/update-tokens') {
      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          }
        });
      }

      if (env.FEED_SECRET && secret !== env.FEED_SECRET) {
        return new Response('Unauthorized', {
          status: 401,
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      }
      if (request.method !== 'POST') {
        return new Response('Method not allowed', {
          status: 405,
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      }
      try {
        const body = await request.json();
        if (!body.authToken || !body.clusterId) {
          return new Response('Missing authToken or clusterId', {
            status: 400,
            headers: { 'Access-Control-Allow-Origin': '*' }
          });
        }
        if (env.TOKENS) {
          await env.TOKENS.put('authToken', body.authToken);
          await env.TOKENS.put('clusterId', body.clusterId);
          await env.TOKENS.put('companyId', body.companyId || '1');
        }
        return new Response('Tokens updated', {
          status: 200,
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      } catch (err) {
        return new Response('Error: ' + err.message, {
          status: 500,
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // ── iCal feed endpoint ────────────────────────────────────────────────────
    if (env.FEED_SECRET && secret !== env.FEED_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    const headers = {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="workaxle-shifts.ics"',
      'Cache-Control': 'no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    };

    try {
      // Prefer KV-stored tokens (auto-updated by extension) over env secrets
      const resolvedEnv = env.TOKENS ? {
        ...env,
        WORKAXLE_AUTH_TOKEN: await env.TOKENS.get('authToken') || env.WORKAXLE_AUTH_TOKEN,
        WORKAXLE_CLUSTER_ID: await env.TOKENS.get('clusterId') || env.WORKAXLE_CLUSTER_ID,
        WORKAXLE_COMPANY_ID: await env.TOKENS.get('companyId') || env.WORKAXLE_COMPANY_ID
      } : env;

      const shifts = await fetchShifts(resolvedEnv);
      const ics = generateICS(shifts);
      return new Response(ics, { status: 200, headers });
    } catch (err) {
      return new Response(
        `Error fetching shifts: ${err.message}`,
        { status: 500, headers: { 'Content-Type': 'text/plain' } }
      );
    }
  }
};

// ─── WorkAxle API ─────────────────────────────────────────────────────────────

async function fetchShifts(env) {
  const authToken = env.WORKAXLE_AUTH_TOKEN;
  const clusterId = env.WORKAXLE_CLUSTER_ID;
  const companyId = env.WORKAXLE_COMPANY_ID || '1';

  if (!authToken || !clusterId) {
    throw new Error('Missing WORKAXLE_AUTH_TOKEN or WORKAXLE_CLUSTER_ID secrets. See Worker setup instructions.');
  }

  const today = new Date();
  const endDate = new Date(today);
  endDate.setDate(today.getDate() + FOUR_WEEKS_DAYS);

  const startStr = today.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];

  const params = new URLSearchParams();
  params.append('filter[start_on][between][]', startStr);
  params.append('filter[start_on][between][]', endStr);
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

  const apiUrl = `${API_BASE}/companies/${companyId}/shifts?${params}`;

  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: {
      'Authorization': authToken,
      'Cluster-Id': clusterId,
      'Accept': 'application/vnd.api+json'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401) {
      throw new Error('WorkAxle token expired. Update WORKAXLE_AUTH_TOKEN in Worker secrets.');
    }
    throw new Error(`WorkAxle API error: ${response.status} — ${text.substring(0, 200)}`);
  }

  const json = await response.json();
  return parseShifts(json);
}

function parseShifts(json) {
  const includedMap = {};
  (json.included || []).forEach(item => {
    includedMap[`${item.type}:${item.id}`] = item;
  });

  function find(type, id) {
    return id ? (includedMap[`${type}:${id}`] || null) : null;
  }

  function attr(obj, key) {
    return obj?.attributes?.[key] ?? null;
  }

  const shifts = [];

  for (const shift of (json.data || [])) {
    const attrs = shift.attributes || {};
    const rels = shift.relationships || {};

    const startTime = attrs.startAt || attrs.start_at;
    const endTime = attrs.finishAt || attrs.end_at;
    if (!startTime || !endTime) continue;

    let roleName = attrs.name || attrs.role || 'ICC Shift';
    let siteName = null;
    let employeeName = null;
    let jobName = roleName;
    let costGroup = null;
    let costSubGroup = null;
    let tags = [];
    let note = attrs.note || attrs.notes || null;

    if (rels.branch?.data) {
      const branch = find('branches', rels.branch.data.id);
      siteName = branch ? attr(branch, 'name') : null;
    }

    const sjData = rels.shiftsJobs?.data;
    if (sjData) {
      for (const sjRef of (Array.isArray(sjData) ? sjData : [sjData])) {
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
            if (tbc.relationships?.timeBucketParent?.data) {
              const tbp = find('timeBucketParents', tbc.relationships.timeBucketParent.data.id);
              costGroup = tbp ? attr(tbp, 'name') : null;
            }
          }
        }
      }
    }

    const tagData = rels.shiftTags?.data;
    if (tagData) {
      for (const tagRef of (Array.isArray(tagData) ? tagData : [tagData])) {
        const tag = find('shiftTag', tagRef.id);
        if (tag) {
          const name = attr(tag, 'name') || attr(tag, 'label');
          if (name) tags.push(name);
        }
      }
    }

    let costGroupSubGroup = null;
    if (costGroup && costSubGroup) costGroupSubGroup = `${costGroup} / ${costSubGroup}`;
    else if (costGroup) costGroupSubGroup = costGroup;
    else if (costSubGroup) costGroupSubGroup = costSubGroup;

    shifts.push({ id: shift.id, startTime, endTime, roleName: jobName, siteName, employeeName, tags, costGroupSubGroup, note });
  }

  return shifts;
}

// ─── iCal generation ─────────────────────────────────────────────────────────

function generateICS(shifts) {
  function icsDate(dateStr) {
    return new Date(dateStr).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  }

  function escape(str) {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  }

  function fold(line) {
    // RFC 5545: lines must be max 75 octets, folded with CRLF + SPACE
    const bytes = new TextEncoder().encode(line);
    if (bytes.length <= 75) return line;
    const result = [];
    let offset = 0;
    let first = true;
    while (offset < line.length) {
      const chunk = line.substring(offset, offset + (first ? 75 : 74));
      result.push(first ? chunk : ' ' + chunk);
      offset += first ? 75 : 74;
      first = false;
    }
    return result.join('\r\n');
  }

  const now = icsDate(new Date().toISOString());

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WorkAxle Sync//Cloudflare Worker//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:WorkAxle Shifts',
    'X-WR-TIMEZONE:Australia/Sydney',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H'
  ];

  for (const shift of shifts) {
    try {
      const start = new Date(shift.startTime);
      const end = new Date(shift.endTime);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;

      const descParts = [];
      if (shift.employeeName) descParts.push(`Employee: ${shift.employeeName}`);
      if (shift.costGroupSubGroup) descParts.push(`Cost Group: ${shift.costGroupSubGroup}`);
      if (shift.tags?.length) descParts.push(`Tags: ${shift.tags.join(', ')}`);
      if (shift.note) descParts.push(`Note: ${shift.note}`);
      const description = descParts.join('\\n');

      lines.push('BEGIN:VEVENT');
      lines.push(`UID:workaxle-${shift.id}@workaxle-sync`);
      lines.push(`DTSTAMP:${now}`);
      lines.push(`DTSTART:${icsDate(shift.startTime)}`);
      lines.push(`DTEND:${icsDate(shift.endTime)}`);
      lines.push(fold(`SUMMARY:${escape(shift.roleName)}`));
      if (shift.siteName) lines.push(fold(`LOCATION:${escape(shift.siteName)}`));
      if (description) lines.push(fold(`DESCRIPTION:${description}`));
      lines.push('END:VEVENT');
    } catch { continue; }
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
