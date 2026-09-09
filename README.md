# Wayfare v2

A trip itinerary planner. One HTML file for the app, three Netlify Functions
for the parts that must not run in a browser.

**Setup instructions for a human: see `V2 SETUP.txt` in the parent folder.**

## What changed from v1

v1 was a single file with a Gemini API key scrambled inside it. That worked,
but the key was readable by anyone who opened the page, and every visitor
drew on one shared project quota with no ceiling.

v2 moves the key to the server:

| | v1 | v2 |
|---|---|---|
| API key | in the page, XOR-scrambled | Netlify environment variable, never sent to the browser |
| Output tokens | whatever the client asked for | clamped server-side to 16,384 |
| Generation limit | none | per trip, per day, counted server-side |
| Old cached clients | kept working forever | refused with "reload this page" |
| Sharing | send the .html file | a link anyone can open, read-only |

## Layout

```
public/index.html          the whole app
public/og.png              link-preview image
netlify/functions/
  gapi.mjs                 Gemini proxy: holds the key, clamps, counts
  health.mjs               /wayfare-health - tells the client a server exists
  trip.mjs                 share links, stored day-sharded in Netlify Blobs
  _lib.mjs                 shared helpers
stamp.mjs                  writes the deploy time into the HTML at build
netlify.toml               publish dir, functions dir, cache headers
```

## Environment variables

| Name | Required | What it does |
|---|---|---|
| `GEMINI_API_KEY` | yes | The key. Set it in Netlify, never in the repo. |
| `WAYFARE_DAILY_CAP` | no | Generations per trip per day. Defaults to 60. |

## Design decisions worth knowing

**Share storage is sharded by day, not by trip.** Phase 0 only reads and writes
whole snapshots, so this buys nothing today. It is done now because reshaping
whole-document blobs into per-day rows later — with live users — is the most
expensive migration on the roadmap, and doing it up front costs a few lines.

**Every write records a device id.** There are no accounts yet. Each browser
mints a random id and sends it, so that when accounts arrive there is
authorship to back-fill from rather than a blank column. It is self-asserted
and must never be treated as authentication.

**The proxy is an allow-list, not a passthrough.** It forwards exactly two
shapes: the model list, and content generation. Anything else is a 404.
Otherwise it would be an open relay to Google on someone else's key.

**Timestamps that matter are server-assigned.** Client clocks are wrong often
enough to corrupt ordering, and it is undebuggable after the fact.

## Not in this version

Photos are not shared — they stay on the device that took them. Recipients of
a share link cannot edit. There is no real-time sync and no conflict merging;
that is Phase 1, and the scoping document argues for waiting until someone
actually tries to edit a shared trip before building it.
