# SUPABASE CONNECT — Step 1 (read-only kill switch)

> Correction 2026-11-16: the project CHANGED. The site now points at
> Tooba's Supabase project (`agcqfmbcnjquritvftha`) — the earlier project
> was inaccessible to the owner's Supabase account and is abandoned.
> The schema below was applied to the new project on 2026-11-16, so the
> old PGRST205 note no longer applies.

Status: **connected to Tooba's project** (URL + publishable key in
`supabase-config.js`, schema applied, `site_settings` readable). The
kill-switch read is live; on any read failure the site falls back to
`site-status.json`, exactly as before. Everything else in `SETUP.md`
step 5 is covered by the code-only admin panel + server API (see
`ADMIN-SETUP.md`), which needs `SUPABASE_SERVICE_ROLE_KEY` in Vercel.

## What changed in this step

- `supabase-config.js` (new) — the only browser-side Supabase config. It
  holds the project URL + publishable key and exposes
  `window.TINY_ARTIST_SUPABASE.fetchDeactivated()`, which returns
  `true`/`false` from `site_settings`, or `null` on any failure. It never
  throws and never blocks the page for more than ~3 seconds.
- `index.html` — loads `supabase-config.js`, and `fetchSiteStatus()` now
  checks, in order: (1) server API when `BACKEND_CONFIG` is enabled,
  (2) Supabase `site_settings` when configured, (3) `site-status.json`,
  (4) the local-browser flag. A definite Supabase answer wins; any
  failure falls through to the next source. No other behaviour changed.
- `recovery.html` — same Supabase read for its status display. Restore
  writes still need the server API + signed-in admin (TODO, per SETUP.md).
- `vercel.json` — Content Security Policy `connect-src` now also allows
  `https://*.supabase.co` so the deployed site may call Supabase. No other
  CSP directive changed.
- `.env.example` — documents the new Supabase key names (publishable /
  secret) against the variable names the server examples expect.

## Finish it (3 steps)

1. **Project URL** — done. `supabase-config.js` now holds the real project
   URL, verified live on 2026-11-16 (project responds, publishable key
   accepted). The publishable key is already in that file. Do not put the
   secret key anywhere in the repo.
2. **Apply the schema** if it has not been applied yet: in the Supabase
   SQL Editor, run `backend/supabase/schema.sql` in full (see `SETUP.md`
   steps 1–2). This creates `site_settings` with public read + the
   admin-only update policy. Without it, the Supabase read returns
   nothing and the site silently keeps using `site-status.json`.
3. **Redeploy** (Vercel redeploys on push), then verify: set
   `site_settings.deactivated = true` in Supabase (Table Editor) → the
   public site shows a blank white page on a fresh browser; set it back
   to `false` → the site returns. `recovery.html` shows the Supabase
   status once configured.

## Keys — which goes where

| Key (Supabase dashboard name) | Prefix | Goes where |
|---|---|---|
| Publishable key | `sb_publishable_...` | `supabase-config.js` only (browser-safe, RLS-protected) |
| Secret key | `sb_secret_...` | Vercel env var `SUPABASE_SERVICE_ROLE_KEY` only (server-only, never in code or the repo) |

The server examples (`backend/api/*.example.js`) still read
`SUPABASE_URL`, `SUPABASE_ANON_KEY` (= publishable key) and
`SUPABASE_SERVICE_ROLE_KEY` (= secret key) from environment variables.
Never commit a `.env` file.

## Still TODO (SETUP.md step 5, unchanged)

The code-only admin panel (see ADMIN-SETUP.md) is built; products read
from the database, server-side order creation, analytics, image upload
via Storage, and the server kill-switch write API all go through
`api/admin.js`. Do not call admin "connected" until the schema is run
and the service-role key is set (ADMIN-SETUP.md Steps 1–2).
