/* ============================================================================
   /wayfare-health  —  "is there a server, and does it hold a key?"
   ----------------------------------------------------------------------------
   The client has probed this endpoint since v1.3 and already understands the
   hasServerKey flag: when it is true the browser stops asking anyone for an
   API key and routes generation through /gapi. Nothing on the client had to
   change for this to work — it was written expecting a server to appear.
   ========================================================================== */

import { json, MIN_CLIENT_BUILD, DAILY_GENERATION_CAP } from './_lib.mjs';

export default async () => json(200, {
  wayfare: true,
  version: '2.0',
  hasServerKey: !!(process.env.GEMINI_API_KEY || '').trim(),
  sharing: true,
  minClientBuild: MIN_CLIENT_BUILD,
  dailyGenerationCap: DAILY_GENERATION_CAP,
  appPresent: true
});

export const config = { path: '/wayfare-health' };
