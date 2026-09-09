/* ============================================================================
   /api/trip/*  —  shared trips
   ----------------------------------------------------------------------------
   This is what makes several people able to work on one itinerary.

   The model, in plain terms:
     * A trip lives on the server, stored one blob per DAY plus one for the
       trip-level details. Nobody ever writes the whole thing at once.
     * Every day carries a version number that only the server assigns.
     * To save a day you send the version you started from. If it still
       matches, your write wins and the version goes up. If someone else
       saved that same day first, you get a 409 and their copy back, and the
       app asks you which to keep. Nothing is ever silently lost.
     * Comments are append-only, so they can never conflict.
     * Two people editing DIFFERENT days never conflict at all — which on a
       family trip is almost always the case.

   Access: the link is the credential, like a shared document link. Anyone
   holding it can read and write. No accounts. Everyone picks which traveller
   they are so edits are attributed.

   Routes:
     POST   /api/trip                          create a shared trip
     GET    /api/trip/<id>                     everything, with versions
     PUT    /api/trip/<id>/meta                trip-level fields
     PUT    /api/trip/<id>/day/<dayId>         one day
     POST   /api/trip/<id>/day/<dayId>/comment append a comment
     PUT    /api/trip/<id>/all                 wholesale replace (regenerate)
   ========================================================================== */

import { json, store, staleBuild, deviceOf, newToken, TOKEN_RE } from './_lib.mjs';

const MAX_BYTES = 3 * 1024 * 1024;

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, x-wayfare-device, x-wayfare-build, x-wayfare-trip, x-wayfare-who',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS'
};

const K = {
  meta:  (id)      => `trip/${id}/meta`,
  index: (id)      => `trip/${id}/index`,
  day:   (id, d)   => `trip/${id}/day/${d}`
};

const stripSecrets = (trip) => {
  const t = Object.assign({}, trip);
  t.travelers = (t.travelers || []).map(v => {
    const c = Object.assign({}, v);
    delete c.passHash; delete c.salt;      // credential material never leaves a device
    return c;
  });
  delete t.days;
  return t;
};

/* Photos live only on the device that took them for now, so ids would dangle. */
const stripPhotos = (day) => {
  const d = Object.assign({}, day, { photos: [] });
  d.activities = (day.activities || []).map(a => Object.assign({}, a, { photos: [] }));
  return d;
};

async function readAll(s, id) {
  const meta = await s.get(K.meta(id), { type: 'json' });
  if (!meta) return null;
  const index = (await s.get(K.index(id), { type: 'json' })) || { days: [] };
  const days = [];
  const versions = {};
  for (const e of index.days) {
    const d = await s.get(K.day(id, e.id), { type: 'json' });
    if (d) { days.push(d.day); versions[e.id] = d.version; }
  }
  return { meta, days, versions };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const stale = staleBuild(req);
  if (stale) return stale;

  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/trip\/?/, '').split('/').filter(Boolean);
  const id = parts[0] || '';
  const device = deviceOf(req);
  const who = (req.headers.get('x-wayfare-who') || '').slice(0, 80) || 'someone';
  const s = store('wayfare-trips');
  const now = () => new Date().toISOString();

  /* --------------------------------------------------------- create ------ */
  if (req.method === 'POST' && !id) {
    let payload = {};
    try { payload = await req.json(); } catch (e) {}
    const trip = payload.trip;
    if (!trip || !Array.isArray(trip.days)) {
      return json(400, { error: { code: 400, status: 'BAD_TRIP', message: 'No trip in the body.' } }, cors);
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
    return json(200, { id: tid, version: 1, serverAt: now() }, cors);
  }

  if (!TOKEN_RE.test(id)) {
    return json(400, { error: { code: 400, status: 'BAD_ID', message: 'That trip link is malformed.' } }, cors);
  }

  /* ----------------------------------------------------------- read ------ */
  if (req.method === 'GET') {
    const all = await readAll(s, id);
    if (!all) {
      return json(404, { error: {
        code: 404, status: 'NOT_FOUND',
        message: 'That trip link does not exist. It may have been created on a different site, or removed.'
      }}, cors);
    }
    const trip = Object.assign({}, all.meta.trip, { days: all.days });
    return json(200, {
      trip,
      tripVersion: all.meta.version,
      versions: all.versions,
      serverAt: all.meta.serverAt,
      updatedBy: all.meta.updatedBy || null
    }, cors);
  }

  if (req.method !== 'PUT' && req.method !== 'POST') {
    return json(405, { error: { code: 405, status: 'BAD_METHOD', message: 'Use GET, POST or PUT.' } }, cors);
  }

  const raw = await req.text();
  if (raw.length > MAX_BYTES) {
    return json(413, { error: { code: 413, status: 'TOO_BIG', message: 'That is too large to sync.' } }, cors);
  }
  let body;
  try { body = JSON.parse(raw); } catch (e) {
    return json(400, { error: { code: 400, status: 'BAD_JSON', message: 'Body was not JSON.' } }, cors);
  }

  const exists = await s.get(K.meta(id), { type: 'json' });
  if (!exists) {
    return json(404, { error: { code: 404, status: 'NOT_FOUND', message: 'That trip does not exist.' } }, cors);
  }

  /* ------------------------------------------------- write: one day ------ */
  if (parts[1] === 'day' && parts[2] && parts[3] !== 'comment' && req.method === 'PUT') {
    const dayId = parts[2];
    const day = body.day;
    if (!day || day.id !== dayId) {
      return json(400, { error: { code: 400, status: 'BAD_DAY', message: 'Day id mismatch.' } }, cors);
    }
    const cur = await s.get(K.day(id, dayId), { type: 'json' });
    const curVersion = cur ? cur.version : 0;
    const base = Number(body.baseVersion || 0);

    /* The whole point. If the day moved on under you, hand back what is there
       and let the person decide — never overwrite silently, never drop the
       edit on the floor. `force` is how the app says "I meant to replace
       this", which is what Regenerate and copy-day do. */
    if (!body.force && curVersion !== base) {
      return json(409, {
        error: { code: 409, status: 'CONFLICT',
                 message: `${cur?.updatedBy || 'Someone'} changed this day while you were editing.` },
        current: cur ? cur.day : null,
        version: curVersion,
        updatedBy: cur ? cur.updatedBy : null,
        serverAt: cur ? cur.serverAt : null
      }, cors);
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
    return json(200, { ok: true, version, serverAt: now() }, cors);
  }

  /* ------------------------------------------- append: one comment ------- */
  if (parts[1] === 'day' && parts[2] && parts[3] === 'comment' && req.method === 'POST') {
    const dayId = parts[2];
    const c = body.comment;
    if (!c || !c.text) {
      return json(400, { error: { code: 400, status: 'BAD_COMMENT', message: 'No comment text.' } }, cors);
    }
    const cur = await s.get(K.day(id, dayId), { type: 'json' });
    if (!cur) return json(404, { error: { code: 404, status: 'NO_DAY', message: 'No such day.' } }, cors);

    const day = cur.day;
    day.comments = day.comments || [];
    /* Appends cannot conflict, so this never returns 409. The server stamps
       the time because phone clocks are wrong often enough to misorder a
       conversation, and that is impossible to debug afterwards. */
    day.comments.push({
      id: c.id || ('c_' + Math.random().toString(36).slice(2, 10)),
      by: c.by || null, byName: who, text: String(c.text).slice(0, 4000),
      at: c.at || Date.now(), serverAt: now()
    });
    const version = cur.version + 1;
    await s.setJSON(K.day(id, dayId), { day, version, updatedBy: who, serverAt: now() });
    return json(200, { ok: true, version, comments: day.comments }, cors);
  }

  /* ----------------------------------------------- write: trip meta ------ */
  if (parts[1] === 'meta' && req.method === 'PUT') {
    const base = Number(body.baseVersion || 0);
    if (!body.force && exists.version !== base) {
      return json(409, {
        error: { code: 409, status: 'CONFLICT',
                 message: `${exists.updatedBy || 'Someone'} changed the trip details.` },
        current: exists.trip, version: exists.version
      }, cors);
    }
    const version = exists.version + 1;
    await s.setJSON(K.meta(id), Object.assign({}, exists, {
      trip: stripSecrets(body.trip || {}), version, updatedBy: who, serverAt: now()
    }));
    return json(200, { ok: true, version, serverAt: now() }, cors);
  }

  /* --------------------------------- wholesale replace (regenerate) ------ */
  if (parts[1] === 'all' && req.method === 'PUT') {
    const trip = body.trip;
    if (!trip || !Array.isArray(trip.days)) {
      return json(400, { error: { code: 400, status: 'BAD_TRIP', message: 'No trip in the body.' } }, cors);
    }
    const oldIndex = (await s.get(K.index(id), { type: 'json' })) || { days: [] };
    const index = { days: [] };
    const versions = {};
    for (const d of trip.days) {
      const prev = await s.get(K.day(id, d.id), { type: 'json' });
      const version = (prev ? prev.version : 0) + 1;
      await s.setJSON(K.day(id, d.id), { day: stripPhotos(d), version, updatedBy: who, serverAt: now() });
      index.days.push({ id: d.id, date: d.date });
      versions[d.id] = version;
    }
    /* days that no longer exist are dropped from the index; their blobs are
       left in place, which is cheap and means an accidental regenerate is
       recoverable by hand if it ever matters */
    await s.setJSON(K.index(id), index);
    const version = exists.version + 1;
    await s.setJSON(K.meta(id), Object.assign({}, exists, {
      trip: stripSecrets(trip), version, updatedBy: who, serverAt: now()
    }));
    return json(200, { ok: true, version, versions, serverAt: now(), replaced: oldIndex.days.length }, cors);
  }

  return json(404, { error: { code: 404, status: 'NO_ROUTE', message: 'Unknown trip route.' } }, cors);
};

export const config = { path: '/api/trip{/*}?' };
