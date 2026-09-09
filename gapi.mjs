/* ============================================================================
   /gapi/*  —  Gemini proxy
   ----------------------------------------------------------------------------
   The whole point of v2. The API key lives in a Netlify environment variable
   and never reaches the browser. The client already knew how to talk to a
   proxy at this path (it has since v1.3), so it needs almost no changes.

   Responsibilities beyond forwarding:
     * hold the key                     (the security fix)
     * clamp maxOutputTokens            (a modified client cannot ask for more)
     * count generations per trip/day   (Gemini cost is the real scaling cost)
     * refuse stale client builds       (see _lib.MIN_CLIENT_BUILD)
     * allow only the two endpoints we actually use
   ========================================================================== */

import {
  GOOGLE, MAX_OUTPUT_TOKENS, json, staleBuild, bumpQuota, deviceOf
} from './_lib.mjs';

export default async (req) => {
  const stale = staleBuild(req);
  if (stale) return stale;

  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) {
    return json(503, { error: {
      code: 503, status: 'NO_SERVER_KEY',
      message: 'This site has no GEMINI_API_KEY set. The owner needs to add it in ' +
               'Netlify under Project configuration -> Environment variables, then redeploy.'
    }});
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/gapi/, '');   // /v1beta/models/...

  /* Allow-list: only the two shapes the app actually uses. Without this the
     proxy is an open relay to Google on someone else's key. */
  const isModelList = req.method === 'GET' && /^\/v1beta\/models\/?$/.test(path);
  const genMatch = path.match(/^\/v1beta\/models\/([A-Za-z0-9._-]+):(streamGenerateContent|generateContent)$/);
  const isGenerate = req.method === 'POST' && !!genMatch;

  if (!isModelList && !isGenerate) {
    return json(404, { error: {
      code: 404, status: 'NOT_PROXIED',
      message: 'This proxy only forwards the model list and content generation.'
    }});
  }

  const target = GOOGLE + path + (url.search || '');

  /* ------------------------------------------------------------ model list */
  if (isModelList) {
    const r = await fetch(target, { headers: { 'x-goog-api-key': key } });
    const text = await r.text();
    return new Response(text, {
      status: r.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }

  /* ------------------------------------------------------------- generate  */
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json(400, { error: { code: 400, status: 'BAD_JSON', message: 'Body was not JSON.' } });
  }

  /* Clamp the output budget regardless of what the client asked for. */
  body.generationConfig = body.generationConfig || {};
  const asked = Number(body.generationConfig.maxOutputTokens) || MAX_OUTPUT_TOKENS;
  body.generationConfig.maxOutputTokens = Math.max(256, Math.min(MAX_OUTPUT_TOKENS, asked));

  /* Count it. Keyed on the trip, not the IP: mobile IPs rotate and home
     networks are shared, so an IP counter would punish the wrong people. */
  const trip = (req.headers.get('x-wayfare-trip') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const subject = trip || ('device-' + deviceOf(req));
  const quota = await bumpQuota(subject);
  if (!quota.allowed) {
    return json(429, { error: {
      code: 429, status: 'DAILY_CAP',
      message: `This trip has used its ${quota.cap} plan generations for today. ` +
               `It resets at midnight UTC — or edit the days by hand in the meantime.`
    }});
  }

  const upstream = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body)
  });

  /* Stream the response straight through so the progress bar stays live.
     Netlify Functions v2 returns a Response, so the body ReadableStream is
     passed along without buffering. */
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store',
      'x-wayfare-quota': `${quota.count}/${quota.cap}`
    }
  });
};

export const config = { path: '/gapi/*' };
