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

/* Storage is loaded lazily and defensively. If @netlify/blobs is missing or
   fails to load for any reason, the site still deploys and Gemini still
   works — only sharing degrades, and /wayfare-health says so. A cosmetic
   dependency problem should never take the whole site down. */
let _getStore;
const _mem = new Map();

function memoryStore(name) {
  if (!_mem.has(name)) _mem.set(name, new Map());
  const m = _mem.get(name);
  return {
    async get(key, opts) {
      const v = m.get(key);
      if (v === undefined) return null;
      return (opts && opts.type === 'json') ? JSON.parse(v) : v;
    },
    async setJSON(key, val) { m.set(key, JSON.stringify(val)); },
    async set(key, val) { m.set(key, val); }
  };
}

async function getStoreSafe(name) {
  if (_getStore === undefined) {
    try {
      const mod = await import('@netlify/blobs');
      _getStore = mod.getStore;
    } catch (err) {
      console.warn('[wayfare] @netlify/blobs unavailable, using memory store:', err && err.message);
      _getStore = null;
    }
  }
  if (!_getStore) return memoryStore(name);
  try {
    return _getStore({ name, consistency: 'strong' });
  } catch (err) {
    console.warn('[wayfare] getStore failed, using memory store:', err && err.message);
    return memoryStore(name);
  }
}

const storageKind = () => (_getStore === undefined ? 'unknown' : _getStore ? 'blobs' : 'memory');

/* -------------------------------------------------------------- settings -- */

/* Clients older than this are refused. Someone with the page cached — or the
   file saved to disk — would otherwise keep writing against a server that has
   moved on. Only raise this when an old client would actually break. */
const MIN_CLIENT_BUILD = '2026-09-07 00:00';

const GOOGLE = 'https://generativelanguage.googleapis.com';

/* A modified browser could ask Gemini for the model's maximum output on every
   call. The ceiling belongs here, where it cannot be edited. */
const MAX_OUTPUT_TOKENS = 16384;

/* Plan generations per trip per day. Counted per REQUEST, and one trip is now
   an outline plus a request per day — so a ten-day trip costs eleven. Set high
   enough that a family regenerating freely never notices it. */
const DAILY_CAP = Number(process.env.WAYFARE_DAILY_CAP || 300);

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

const store = () => getStoreSafe('wayfare-trips');

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
  const s = await getStoreSafe('wayfare-meta');
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

/* Google's key errors all surface to a person as "it rejected my key", but the
   causes are unrelated and the fixes have nothing in common. This turns the
   raw refusal into the one sentence that says what to go and change. */
function explainGoogleError(status, text) {
  const t = String(text || '');
  const low = t.toLowerCase();

  if (low.includes('referer') || low.includes('referrer')) {
    return 'Your Google key is restricted to specific websites. That restriction cannot work here, ' +
           'because the call to Google is made by this site\'s server rather than by a browser, and a ' +
           'server sends no website name. Fix: at aistudio.google.com/apikey open the key, and under ' +
           'Application restrictions choose "None". Leave the API restriction alone.';
  }
  if (low.includes('api key not valid') || low.includes('api_key_invalid') || low.includes('invalid api key')) {
    return 'Google does not recognise this key. The most common cause in 2026 is an old-style "AIza" key: ' +
           'Google retired those in September 2026, and a retired key gives exactly this message. Make a ' +
           'new key at aistudio.google.com/apikey — new ones begin "AQ." and are several hundred ' +
           'characters long, which is normal. Otherwise: the key was deleted or regenerated after you ' +
           'pasted it, it was copied only in part, or something other than the key went into the Value box.';
  }
  if (low.includes('service_disabled') || low.includes('has not been used in project') ||
      low.includes('is disabled')) {
    return 'The key is real, but the Generative Language API is switched off for the Google project it ' +
           'belongs to. Easiest fix: at aistudio.google.com/apikey create a new key and let Google make a ' +
           'new project for it, then put that key into Netlify instead.';
  }
  if (low.includes('api_key_service_blocked') || low.includes('blocked')) {
    return 'This key is restricted to a list of Google APIs that does not include the Generative Language ' +
           'API. At aistudio.google.com/apikey open the key and either allow "Generative Language API" or ' +
           'remove the API restriction.';
  }
  if (status === 429 || low.includes('resource_exhausted') || low.includes('quota')) {
    return 'The key is fine, but Google\'s free allowance for today is used up. It resets on its own. ' +
           'You can still edit days by hand in the meantime.';
  }
  if (status === 403) {
    return 'Google refused the key (403). Check at aistudio.google.com/apikey that the key still exists ' +
           'and that its Application restrictions are set to "None".';
  }
  return null;
}

/* Asks Google, with the key this site actually holds, whether it works.
   Deliberately never returns the key or any part of it. */
async function testKey() {
  const raw = process.env.GEMINI_API_KEY || '';
  const key = raw.trim();
  /* Google has two key formats in circulation. "AIza..." standard keys are the
     old ones and are being switched off during 2026; "AQ." auth keys are what
     AI Studio issues now, and they are long because they carry a service
     account identity inside them. Both are sent the same way. */
  const isStandard = /^AIza[A-Za-z0-9_-]{30,}$/.test(key);
  const isAuth     = /^AQ\./.test(key);
  const buried     = !isStandard && !isAuth && /AIza[A-Za-z0-9_-]{30,}/.test(key);

  const shape = {
    present: !!key,
    length: key.length,
    keyType: isAuth ? 'auth (AQ.)' : isStandard ? 'standard (AIza) — being retired by Google' : 'unrecognised',
    /* Enough to name the mistake, nowhere near enough to use. */
    startsWith: key.slice(0, 3),
    hasQuotesAround: /^["']|["']$/.test(key),
    hadStraySpaces: raw !== key,
    hasLineBreaks: /[\r\n]/.test(key),
    keyIsBuriedInOtherText: buried
  };
  if (!key) return { ok: false, shape, verdict: 'No GEMINI_API_KEY is set on this site.' };

  if (buried) {
    return { ok: false, shape, verdict:
      'The value in Netlify contains a key with other text wrapped around it — which is what ' +
      'happens when you copy a code example instead of the key itself. Open the value, find the ' +
      'run of characters that is the key, and make that the entire value, with nothing else.' };
  }

  try {
    const r = await fetch(GOOGLE + '/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key } });
    const text = await r.text();
    if (r.ok) return { ok: true, shape, verdict: 'Google accepted this key.' };

    /* Google says "API key not valid" for a retired standard key too, which
       sends people hunting for a typo that is not there. */
    if (isStandard && /api.key.not.valid|API_KEY_INVALID/i.test(text)) {
      return { ok: false, shape, googleStatus: r.status, googleSaid: text.slice(0, 500), verdict:
        'This is an old-style "AIza" key, and Google stopped accepting those in September 2026. ' +
        'Nothing is wrong with how you pasted it — it simply no longer works. Go to ' +
        'aistudio.google.com/apikey, click Create API key, and use the new key you get. ' +
        'The new ones begin "AQ." and are much longer; that is expected.' };
    }
    return {
      ok: false, shape, googleStatus: r.status,
      googleSaid: text.slice(0, 500),
      verdict: explainGoogleError(r.status, text) || 'Google refused the key and did not say why.'
    };
  } catch (err) {
    return { ok: false, shape, verdict: 'Could not reach Google at all: ' + String(err && err.message) };
  }
}

/* Two probes, deliberately different. The first is the smallest legal request
   Google documents. The second is the request Wayfare actually sends, with the
   system instruction, the JSON response type and the token ceiling. If the
   first passes and the second fails, the fault is in what we ask for, and the
   difference between them names it. */
async function testGenerate(key, model, appStyle) {
  const target = GOOGLE + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const body = appStyle
    ? {
        contents: [{ role: 'user', parts: [{ text: 'Return {"ok":true} and nothing else.' }] }],
        systemInstruction: { parts: [{ text: 'You reply only with a single JSON object.' }] },
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: MAX_OUTPUT_TOKENS }
      }
    : { contents: [{ parts: [{ text: 'Say OK.' }] }] };

  try {
    const r = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body)
    });
    const text = await r.text();
    if (r.ok) return { style: appStyle ? 'as Wayfare sends it' : 'bare minimum', model, status: r.status, ok: true };
    console.error('[wayfare] generate probe failed', r.status, text.slice(0, 800));
    return {
      style: appStyle ? 'as Wayfare sends it' : 'bare minimum',
      model, status: r.status, ok: false,
      googleSaid: text.slice(0, 800),
      verdict: explainGoogleError(r.status, text) || null
    };
  } catch (err) {
    return { style: appStyle ? 'as Wayfare sends it' : 'bare minimum', model, ok: false,
             googleSaid: 'Could not reach Google: ' + String(err && err.message) };
  }
}

/* Whatever Google currently offers that can generate text, newest Flash first —
   so the probe never fails merely because a model name went out of date. */
async function bestModel(key) {
  try {
    const r = await fetch(GOOGLE + '/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
    if (!r.ok) return null;
    const j = await r.json();
    const usable = (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => String(m.name || '').replace(/^models\//, ''))
      .filter(id => id && !/embedding|aqa|imagen|veo|tts|audio|image|learnlm/i.test(id))
      .sort((a, b) => {
        const score = (id) => {
          const v = parseFloat((id.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
          return v * 20 + (/flash/.test(id) ? 100 : 0) + (/pro/.test(id) ? 60 : 0)
                 - (/lite/.test(id) ? 35 : 0) - (/preview|exp|thinking/.test(id) ? 25 : 0);
        };
        return score(b) - score(a);
      });
    return usable[0] || null;
  } catch (err) { return null; }
}

async function health(url) {
  /* Actually exercise storage rather than just loading the module. A store
     that constructs fine but fails on first read is the failure mode worth
     catching, and this is the page a person will be told to open. */
  let storage = 'unknown', storageError = null;
  try {
    const s = await getStoreSafe('wayfare-meta');
    await s.get('__healthprobe');
    storage = storageKind();
  } catch (err) {
    storage = 'error';
    storageError = String((err && err.message) || err).slice(0, 300);
  }
  /* /wayfare-health?test=1 goes further and actually tries the key against
     Google. Kept behind the parameter so the ordinary health check that the
     app makes on every load stays instant and makes no outbound calls. */
  const keyTest = (url && url.searchParams.get('test')) ? await testKey() : undefined;

  /* When the key is good but the app still cannot generate, the useful question
     is no longer "is the key valid" but "which part of the request is refused".
     Only runs when asked for, and only when the key already passed. */
  let generateTests;
  if (keyTest && keyTest.ok) {
    const key = (process.env.GEMINI_API_KEY || '').trim();
    const model = (url && url.searchParams.get('model')) || await bestModel(key) || 'gemini-3.8-flash';
    generateTests = [
      await testGenerate(key, model, false),
      await testGenerate(key, model, true)
    ];
    const bare = generateTests[0], full = generateTests[1];
    if (bare.ok && !full.ok) {
      generateTests.push({ conclusion:
        'The key and the model are fine. Google refuses the request only when Wayfare adds its own ' +
        'settings — the system instruction, the JSON response type, or the ' + MAX_OUTPUT_TOKENS +
        ' token ceiling. The "googleSaid" text above says which.' });
    } else if (!bare.ok) {
      generateTests.push({ conclusion:
        'Even the simplest possible request is refused, so this is not about how Wayfare asks. ' +
        'Read "googleSaid" above — it is Google\'s own words.' });
    } else {
      generateTests.push({ conclusion:
        'Both requests worked. Generation is healthy from the server, so if the app still fails, ' +
        'the app is sending something different — most likely a stale model saved in Settings.' });
    }
  }

  const durable = storage === 'blobs';
  return json(200, {
    wayfare: true,
    version: '2.0',
    hasServerKey: !!(process.env.GEMINI_API_KEY || '').trim(),
    keyTest,
    generateTests,
    sharing: durable,
    collaboration: durable,
    storage,
    storageError,
    minClientBuild: MIN_CLIENT_BUILD,
    dailyGenerationCap: DAILY_CAP,
    nodeVersion: (typeof process !== 'undefined' && process.version) || 'unknown',
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
    const text = await r.text();
    if (!r.ok) {
      const why = explainGoogleError(r.status, text);
      return json(r.status, { error: {
        code: r.status, status: 'GOOGLE_REFUSED',
        message: why || ('Google refused the key (' + r.status + ').'),
        googleSaid: text.slice(0, 500)
      }});
    }
    return new Response(text, {
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

  /* A refusal is never a stream — it is a small JSON error. Buffer it and say
     what it means, otherwise the app shows Google's wording, which describes
     the symptom and never the fix. */
  if (!upstream.ok) {
    const text = await upstream.text();
    const why = explainGoogleError(upstream.status, text);
    return json(upstream.status, { error: {
      code: upstream.status, status: 'GOOGLE_REFUSED',
      message: why || ('Google refused this request (' + upstream.status + ').'),
      googleSaid: text.slice(0, 500)
    }});
  }

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
  const s = await store();

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
    if (p === '/wayfare-health') return await health(url);
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
