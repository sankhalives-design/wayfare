/* ============================================================================
   Wayfare server — everything in one file
   ----------------------------------------------------------------------------
   This single function answers all three server routes:

     /wayfare-health   "yes there is a server, and it holds the API key"
     /gapi/*           Gemini proxy — the key lives here, never in the browser
     /api/trip/*       shared trips, so several people can edit one itinerary

   It is deliberately one file so it can be created in GitHub's web editor by
   typing a filename, with no folder dragging.

   Nothing here is secret except the GEMINI_API_KEY environment variable,
   which you set in Netlify and which never reaches anyone's browser.
   ========================================================================== */

import { getStore } from '@netlify/blobs';

/* -------------------------------------------------------------- settings -- */

/* Clients older than this are refused. Someone with the page cached — or the
   file saved to disk — would otherwise keep writing against a server that has
   moved on. Only raise this when an old client would actually break. */
const MIN_CLIENT_BUILD = '2026-09-07 00:00';

const GOOGLE = 'https://generativelanguage.googleapis.com';

/* A modified browser could ask Gemini for the model's maximum output on every
   call. The ceiling belongs here, where it cannot be edited. */
const MAX_OUTPUT_TOKENS = 16384;

/* Plan generations per trip per day. Generous enough that nobody notices, but
   it exists so the number is ours to choose rather than a surprise later. */
const DAILY_CAP = Number(process.env.WAYFARE_DAILY_CAP || 60);

const MAX_BYTES = 3 * 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers':
    'content-type, x-goog-api-key, x-wayfare-device, x-wayfare-build, x-wayfare-trip, x-wayfare-who',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS'
};

/* --------------------------------------------------------------- helpers -- */

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...extra }
  });

const store = () => getStore({ name: 'wayfare-trips', consistency: 'strong' });

const now = () => new Date().toISOString();

/* Self-asserted, never treated as authentication. Phase 0 has no accounts,
   but recording who made each change means there is authorship to build on
   later rather than a blank column. */
const deviceOf = (req) => {
  const d = (req.headers.get('x-wayfare-device') || '').trim();
  return /^[a-z0-9_-]{6,64}$/i.test(d) ? d : 'unknown';
};

const whoOf = (req) => (req.headers.get('x-wayfare-who') || '').slice(0, 80) || 'someone';

function staleBuild(req) {
  const b = (req.headers.get('x-wayfare-build') || '').trim();
  if (!b) return null;                       // builds made before stamping: allow
  if (b < MIN_CLIENT_BUILD) {
    return json(426, { error: {
      code: 426, status: 'CLIENT_TOO_OLD',
      message: 'This copy of Wayfare is out of date. Reload the page to get the current version.',
      minBuild: MIN_CLIENT_BUILD, yourBuild: b
    }});
  }
  return null;
}

function newToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* Netlify Blobs is last-write-wins under concurrent writes, so this can
   undercount slightly in a race. Fine for a soft cap among family; a hard cap
   would need a database row with an atomic increment. */
async function bumpQuota(subject) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `quota/${day}/${subject}`;
  const s = getStore({ name: 'wayfare-meta', consistency: 'strong' });
  let count = 0;
  try {
    const prev = await s.get(key, { type: 'json' });
    count = (prev && prev.count) || 0;
  } catch (e) { /* first call of the day */ }
  if (count >= DAILY_CAP) return { allowed: false, count, cap: DAILY_CAP };
  try { await s.setJSON(key, { count: count + 1, at: Date.now() }); } catch (e) { /* never fail on the counter */ }
  return { allowed: true, count: count + 1, cap: DAILY_CAP };
}

/* Credential material and photo ids never leave the device that has them. */
const stripSecrets = (trip) => {
  const t = { ...trip };
  t.travelers = (t.travelers || []).map(v => {
    const c = { ...v };
    delete c.passHash; delete c.salt;
    return c;
  });
  delete t.days;
  return t;
};

const stripPhotos = (day) => ({
  ...day,
  photos: [],
  activities: (day.activities || []).map(a => ({ ...a, photos: [] }))
});

const K = {
  meta:  (id)    => `trip/${id}/meta`,
  index: (id)    => `trip/${id}/index`,
  day:   (id, d) => `trip/${id}/day/${d}`
};

/* ============================================================ health ===== */

function health() {
  return json(200, {
    wayfare: true,
    version: '2.0',
    hasServerKey: !!(process.env.GEMINI_API_KEY || '').trim(),
    sharing: true,
    collaboration: true,
    minClientBuild: MIN_CLIENT_BUILD,
    dailyGenerationCap: DAILY_CAP,
    appPresent: true
  });
}

/* ============================================================== gemini === */

async function gemini(req, url) {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) {
    return json(503, { error: {
      code: 503, status: 'NO_SERVER_KEY',
      message: 'This site has no GEMINI_API_KEY set. In Netlify go to Project configuration -> ' +
               'Environment variables, add GEMINI_API_KEY, then deploy again.'
    }});
  }

  const path = url.pathname.replace(/^\/gapi/, '');

  /* Allow-list. Without this the proxy is an open relay to Google on someone
     else's key — anyone could point their own app at it. */
  const isModelList = req.method === 'GET' && /^\/v1beta\/models\/?$/.test(path);
  const isGenerate = req.method === 'POST' &&
    /^\/v1beta\/models\/[A-Za-z0-9._-]+:(streamGenerateContent|generateContent)$/.test(path);

  if (!isModelList && !isGenerate) {
    return json(404, { error: {
      code: 404, status: 'NOT_PROXIED',
      message: 'This proxy only forwards the model list and content generation.'
    }});
  }

  const target = GOOGLE + path + (url.search || '');

  if (isModelList) {
    const r = await fetch(target, { headers: { 'x-goog-api-key': key } });
    return new Response(await r.text(), {
      status: r.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS }
    });
  }

  let body;
  try { body = await req.json(); }
  catch (e) { return json(400, { error: { code: 400, status: 'BAD_JSON', message: 'Body was not JSON.' } }); }

  body.generationConfig = body.generationConfig || {};
  const asked = Number(body.generationConfig.maxOutputTokens) || MAX_OUTPUT_TOKENS;
  body.generationConfig.maxOutputTokens = Math.max(256, Math.min(MAX_OUTPUT_TOKENS, asked));

  /* Counted per trip rather than per IP: mobile IPs rotate and home networks
     are shared, so an IP counter would punish the wrong people. */
  const trip = (req.headers.get('x-wayfare-trip') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const quota = await bumpQuota(trip || ('device-' + deviceOf(req)));
  if (!quota.allowed) {
    return json(429, { error: {
      code: 429, status: 'DAILY_CAP',
      message: `This trip has used its ${quota.cap} plan generations for today. ` +
               `It resets at midnight UTC — you can still edit the days by hand.`
    }});
  }

  const upstream = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body)
  });

  /* Streamed straight through, so the progress bar in the app stays live. */
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store',
      'x-wayfare-quota': `${quota.count}/${quota.cap}`,
      ...CORS
    }
  });
}

/* ========================================================= shared trips == */
/*
   Stored one blob per DAY plus one for the trip details. Nobody ever writes
   the whole trip at once, so two people planning different days never
   collide. Every day carries a version the server assigns; you send the
   version you started from, and if it has moved on you get a 409 with their
   copy back rather than silently overwriting anyone.
*/

async function readAll(s, id) {
  const meta = await s.get(K.meta(id), { type: 'json' });
  if (!meta) return null;
  const index = (await s.get(K.index(id), { type: 'json' })) || { days: [] };
  const days = [], versions = {};
  for (const e of index.days) {
    const d = await s.get(K.day(id, e.id), { type: 'json' });
    if (d) { days.push(d.day); versions[e.id] = d.version; }
  }
  return { meta, days, versions };
}

async function trips(req, url) {
  const parts = url.pathname.replace(/^\/api\/trip\/?/, '').split('/').filter(Boolean);
  const id = parts[0] || '';
  const device = deviceOf(req);
  const who = whoOf(req);
  const s = store();

  /* ---------------------------------------------------------- create ---- */
  if (req.method === 'POST' && !id) {
    let payload = {};
    try { payload = await req.json(); } catch (e) {}
    const trip = payload.trip;
    if (!trip || !Array.isArray(trip.days)) {
      return json(400, { error: { code: 400, status: 'BAD_TRIP', message: 'No trip in the body.' } });
    }
    const tid = newToken();
    const index = { days: [] };
    for (const d of trip.days) {
      await s.setJSON(K.day(tid, d.id), { day: stripPhotos(d), version: 1, updatedBy: who, serverAt: now() });
      index.days.push({ id: d.id, date: d.date });
    }
    await s.setJSON(K.index(tid), index);
    await s.setJSON(K.meta(tid), {
      trip: stripSecrets(trip), version: 1,
      createdBy: device, createdAt: Date.now(), serverAt: now(), updatedBy: who
    });
    return json(200, { id: tid, version: 1, serverAt: now() });
  }

  if (!TOKEN_RE.test(id)) {
    return json(400, { error: { code: 400, status: 'BAD_ID', message: 'That trip link is malformed.' } });
  }

  /* ------------------------------------------------------------ read ---- */
  if (req.method === 'GET') {
    const all = await readAll(s, id);
    if (!all) {
      return json(404, { error: {
        code: 404, status: 'NOT_FOUND',
        message: 'That trip link does not exist. It may belong to a different site address.'
      }});
    }
    return json(200, {
      trip: { ...all.meta.trip, days: all.days },
      tripVersion: all.meta.version,
      versions: all.versions,
      serverAt: all.meta.serverAt,
      updatedBy: all.meta.updatedBy || null
    });
  }

  if (req.method !== 'PUT' && req.method !== 'POST') {
    return json(405, { error: { code: 405, status: 'BAD_METHOD', message: 'Use GET, POST or PUT.' } });
  }

  const raw = await req.text();
  if (raw.length > MAX_BYTES) {
    return json(413, { error: { code: 413, status: 'TOO_BIG', message: 'That is too large to sync.' } });
  }
  let body;
  try { body = JSON.parse(raw); }
  catch (e) { return json(400, { error: { code: 400, status: 'BAD_JSON', message: 'Body was not JSON.' } }); }

  const exists = await s.get(K.meta(id), { type: 'json' });
  if (!exists) {
    return json(404, { error: { code: 404, status: 'NOT_FOUND', message: 'That trip does not exist.' } });
  }

  /* -------------------------------------------------- write one day ----- */
  if (parts[1] === 'day' && parts[2] && parts[3] !== 'comment' && req.method === 'PUT') {
    const dayId = parts[2];
    const day = body.day;
    if (!day || day.id !== dayId) {
      return json(400, { error: { code: 400, status: 'BAD_DAY', message: 'Day id mismatch.' } });
    }
    const cur = await s.get(K.day(id, dayId), { type: 'json' });
    const curVersion = cur ? cur.version : 0;
    const base = Number(body.baseVersion || 0);

    /* The heart of it: never overwrite silently, never drop the edit.
       `force` is the app saying "I meant to replace this" — which is what
       Regenerate and copy-day mean. */
    if (!body.force && curVersion !== base) {
      return json(409, {
        error: { code: 409, status: 'CONFLICT',
                 message: `${(cur && cur.updatedBy) || 'Someone'} changed this day while you were editing.` },
        current: cur ? cur.day : null,
        version: curVersion,
        updatedBy: cur ? cur.updatedBy : null,
        serverAt: cur ? cur.serverAt : null
      });
    }

    const version = curVersion + 1;
    await s.setJSON(K.day(id, dayId), {
      day: stripPhotos(day), version, updatedBy: who, updatedByDevice: device, serverAt: now()
    });
    const index = (await s.get(K.index(id), { type: 'json' })) || { days: [] };
    if (!index.days.some(d => d.id === dayId)) {
      index.days.push({ id: dayId, date: day.date });
      index.days.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      await s.setJSON(K.index(id), index);
    }
    return json(200, { ok: true, version, serverAt: now() });
  }

  /* ----------------------------------------------- append a comment ----- */
  if (parts[1] === 'day' && parts[2] && parts[3] === 'comment' && req.method === 'POST') {
    const dayId = parts[2];
    const c = body.comment;
    if (!c || !c.text) {
      return json(400, { error: { code: 400, status: 'BAD_COMMENT', message: 'No comment text.' } });
    }
    const cur = await s.get(K.day(id, dayId), { type: 'json' });
    if (!cur) return json(404, { error: { code: 404, status: 'NO_DAY', message: 'No such day.' } });

    const day = cur.day;
    day.comments = day.comments || [];
    /* Appends cannot conflict, so this never returns 409 — which matters,
       because talking about a day is exactly when someone else is editing it.
       The server stamps the time: phone clocks are wrong often enough to
       misorder a conversation, and that is impossible to debug afterwards. */
    day.comments.push({
      id: c.id || ('c_' + Math.random().toString(36).slice(2, 10)),
      by: c.by || null, byName: who,
      text: String(c.text).slice(0, 4000),
      at: c.at || Date.now(), serverAt: now()
    });
    const version = cur.version + 1;
    await s.setJSON(K.day(id, dayId), { day, version, updatedBy: who, serverAt: now() });
    return json(200, { ok: true, version, comments: day.comments });
  }

  /* --------------------------------------------- write trip details ----- */
  if (parts[1] === 'meta' && req.method === 'PUT') {
    const base = Number(body.baseVersion || 0);
    if (!body.force && exists.version !== base) {
      return json(409, {
        error: { code: 409, status: 'CONFLICT',
                 message: `${exists.updatedBy || 'Someone'} changed the trip details.` },
        current: exists.trip, version: exists.version
      });
    }
    const version = exists.version + 1;
    await s.setJSON(K.meta(id), { ...exists, trip: stripSecrets(body.trip || {}), version, updatedBy: who, serverAt: now() });
    return json(200, { ok: true, version, serverAt: now() });
  }

  /* ----------------------------- replace everything (regenerate) -------- */
  if (parts[1] === 'all' && req.method === 'PUT') {
    const trip = body.trip;
    if (!trip || !Array.isArray(trip.days)) {
      return json(400, { error: { code: 400, status: 'BAD_TRIP', message: 'No trip in the body.' } });
    }
    const index = { days: [] }, versions = {};
    for (const d of trip.days) {
      const prev = await s.get(K.day(id, d.id), { type: 'json' });
      const version = (prev ? prev.version : 0) + 1;
      await s.setJSON(K.day(id, d.id), { day: stripPhotos(d), version, updatedBy: who, serverAt: now() });
      index.days.push({ id: d.id, date: d.date });
      versions[d.id] = version;
    }
    /* Days that no longer exist drop out of the index. Their blobs are left
       behind, which costs nothing and means a mistaken regenerate is still
       recoverable by hand if it ever matters. */
    await s.setJSON(K.index(id), index);
    const version = exists.version + 1;
    await s.setJSON(K.meta(id), { ...exists, trip: stripSecrets(trip), version, updatedBy: who, serverAt: now() });
    return json(200, { ok: true, version, versions, serverAt: now() });
  }

  return json(404, { error: { code: 404, status: 'NO_ROUTE', message: 'Unknown trip route.' } });
}

/* ============================================================== router === */

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const stale = staleBuild(req);
  if (stale) return stale;

  const url = new URL(req.url);
  const p = url.pathname;

  try {
    if (p === '/wayfare-health') return health();
    if (p.startsWith('/gapi/'))  return await gemini(req, url);
    if (p.startsWith('/api/trip')) return await trips(req, url);
  } catch (err) {
    return json(500, { error: { code: 500, status: 'SERVER_ERROR', message: String(err && err.message || err) } });
  }
  return json(404, { error: { code: 404, status: 'NO_ROUTE', message: 'Nothing here.' } });
};

/* One function, three URL patterns. */
export const config = {
  path: ['/wayfare-health', '/gapi/*', '/api/trip', '/api/trip/*']
};
