/* ============================================================================
   Shared helpers for the Wayfare functions.
   Kept dependency-light on purpose: only @netlify/blobs, which ships with the
   platform. Everything here runs server-side only.
   ========================================================================== */

import { getStore } from '@netlify/blobs';

/* The oldest client build allowed to talk to this server. Someone with the
   old single-file app cached — or literally saved to disk — will otherwise
   keep writing against a server that has moved on. Bump this when a client
   change makes older builds incompatible, never casually. */
export const MIN_CLIENT_BUILD = '2026-09-07 00:00';

export const GOOGLE = 'https://generativelanguage.googleapis.com';

/* Hard server-side ceiling. The client asks for maxOutputTokens from its own
   settings, and a modified client could ask for the model maximum on every
   call. Clamp it here where it cannot be edited. */
export const MAX_OUTPUT_TOKENS = 16384;

/* Generations allowed per trip per day. Deliberately generous — nobody should
   notice it — but it exists so the number is ours to change, not a surprise
   on a bill. */
export const DAILY_GENERATION_CAP = Number(process.env.WAYFARE_DAILY_CAP || 60);

export const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }
  });

export const store = (name) => getStore({ name, consistency: 'strong' });

/* ---------------------------------------------------------------- identity */
/* Phase 0 has no accounts. Every device mints a random id and sends it, so
   that when accounts do arrive there is authorship to back-fill from rather
   than a void. Never trust it for authorisation — it is self-asserted. */
export function deviceOf(req) {
  const d = (req.headers.get('x-wayfare-device') || '').trim();
  return /^[a-z0-9_-]{6,64}$/i.test(d) ? d : 'unknown';
}

export function buildOf(req) {
  return (req.headers.get('x-wayfare-build') || '').trim();
}

/* Reject clients older than the floor. Returns a Response to send, or null. */
export function staleBuild(req) {
  const b = buildOf(req);
  if (!b) return null;                      // pre-stamp builds: let them pass
  if (b < MIN_CLIENT_BUILD) {
    return json(426, {
      error: {
        code: 426,
        status: 'CLIENT_TOO_OLD',
        message: 'This copy of Wayfare is out of date. Reload the page to get the current version.',
        minBuild: MIN_CLIENT_BUILD,
        yourBuild: b
      }
    });
  }
  return null;
}

/* ------------------------------------------------------------------- quota */
/* Counter per subject per UTC day. Netlify Blobs is documented as
   last-write-wins under concurrent writes, so this can undercount slightly
   under a race. That is acceptable for a soft cap among family; if a hard
   cap is ever needed this becomes a Postgres row with an atomic increment. */
export async function bumpQuota(subject) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `quota/${day}/${subject}`;
  const s = store('wayfare-meta');
  let count = 0;
  try {
    const prev = await s.get(key, { type: 'json' });
    count = (prev && prev.count) || 0;
  } catch (e) { /* first write of the day */ }
  if (count >= DAILY_GENERATION_CAP) {
    return { allowed: false, count, cap: DAILY_GENERATION_CAP };
  }
  count += 1;
  try {
    await s.setJSON(key, { count, at: Date.now() });
  } catch (e) { /* never fail a request because the counter did */ }
  return { allowed: true, count, cap: DAILY_GENERATION_CAP };
}

/* --------------------------------------------------------------- share ids */
export const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function newToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
