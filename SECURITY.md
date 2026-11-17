# SECURITY — Tiny Artist

## Current posture (storefront only, no backend)

Enforced today:

- **No secrets anywhere.** No API keys, tokens, passwords, or private keys
  in frontend code or in this repo. `.env.example` lists names only.
- **Input validation.** Checkout requires name (≥2 chars), a Pakistani
  mobile number (`^(\+92|0)?3[0-9]{9}$` after stripping spaces/dashes),
  city (≥2 chars), and address (≥8 chars). Length limits (`maxlength`)
  on every field. Invalid input shows field errors and never navigates.
- **Output escaping.** Customer-entered text rendered into the page goes
  through `esc()` (HTML-entity escaping). The WhatsApp message is built
  with `encodeURIComponent` over the whole message body.
- **No trust in client prices — locally.** Kit prices are fixed constants
  in the page; figure/pack prices come from the owner's local settings,
  and totals are recomputed from those — never from a submitted total.
  (True server-side enforcement arrives with Phase 2; see below.)
- **Duplicate orders blocked.** A submit guard disables the WhatsApp
  button during submission and resets only on navigation.
- **Orders start unconfirmed.** Every saved order is `Pending Confirmation`.
  Opening WhatsApp never changes status. Status changes in the local
  preview affect only that browser.
- **Security headers** (`vercel.json`): CSP (self + inline, as the page
  is a single file), `nosniff`, strict referrer policy, restrictive
  permissions policy, HSTS. Note: `'unsafe-inline'` is required while
  the page keeps inline scripts/styles; moving scripts to external files
  in a future refactor would allow a stricter CSP.
- **Privacy.** Analytics events skip `navigator.webdriver` (basic bot
  filtering) and are capped (500 events) in localStorage. Anonymous
  visitors are never identified by name/phone. No third-party trackers,
  no external scripts/fonts.
- **Fail-closed admin.** With no backend, admin sign-in is *disabled*
  and the dashboard is labelled a local preview. Nothing pretends to
  authenticate or authorise anyone.
- **Kill switch with confirmation + separate recovery.** Activation
  requires typing `DELETE`, ticking an acknowledgement, and a native
  confirm dialog. It flips a flag only — no code, rows, or repo content
  is deleted. Recovery lives in a separate file (`recovery.html`) with
  its own typed `RESTORE` confirmation. In local-preview mode the flag
  affects only that browser; in backend mode the server flag
  (`site_settings`) governs every visitor and only `is_admin()` callers
  can change it via the status API.

## Phase-2 requirements (must hold before admin goes live)

- **Server-side allowlist only.** `public.is_admin()` in
  `backend/supabase/schema.sql` decides admin status from the verified
  Auth email (exactly two addresses). Frontend checks are UI hints only.
- **Row Level Security on every table**, deny-by-default. Admin reads/
  writes require `is_admin()`; customers see only their own records;
  guest order creation goes through the `create_order()` function, which
  re-checks prices server-side and snapshots them.
- **No privilege escalation.** Users cannot change their own role
  (trigger in schema). Role changes happen only via the allowlist.
- **Service-role key is server-only.** It must appear only in Vercel
  environment variables for API routes, never in frontend bundles.
- **Sessions:** Supabase Auth with email confirmation required, secure
  HttpOnly cookies where the framework supports them, HTTPS only.
- **Rate limiting** on auth + order endpoints (Supabase Auth limits +
  Vercel/edge limits; add explicit limits on custom endpoints).
- **File uploads** (product images, Phase 2): allow images only
  (JPEG/PNG/WebP/AVIF), enforce size limits, validate magic bytes
  server-side, store in Supabase Storage (never as blobs in DB rows),
  serve via signed/public URLs with the storage bucket's own policies,
  strip EXIF where practical, and never execute uploaded content.
- **CSRF:** Supabase Auth uses bearer tokens (no cookie-based session
  CSRF surface for API calls made with the JS client); any future
  cookie-based endpoint must add CSRF tokens.
- **Dependency hygiene:** keep the dependency list minimal (today: zero
  runtime dependencies). When Phase 2 adds `@supabase/supabase-js`,
  pin versions and review advisories before each deploy.

## Known limitations (honest)

1. **localStorage data is per-browser and user-editable.** A visitor can
   edit their own cart/orders in DevTools. This affects only their own
   device and the WhatsApp message they send — the team confirms every
   order in chat, and Phase 2 re-validates prices server-side. Never
   treat localStorage orders as a source of truth for fulfilment.
2. **The local admin preview is not access-controlled.** Anyone can open
   it — but it shows only that browser's own data. It must be replaced
   by real authenticated admin before any shared data exists. Do not
   connect shared data to the preview.
3. **CSP uses `'unsafe-inline'`.** Acceptable for a single-file page
   with no user-supplied script sinks, but weaker than a nonce/hash CSP.
   Revisit if the page grows user-generated content.
4. **The local kill switch is not access-controlled.** Anyone who opens
   the local admin preview in their own browser can blank the site *for
   themselves only* — other visitors are unaffected, and recovery is
   one click away. The real, everyone-affecting switch exists only
   after the backend is wired, where it is admin-gated server-side.
   Do not treat a local blanking as a site-wide takedown, or vice versa.
5. **`site-status.json` is public by design.** Anyone can read whether
   the site is deactivated (they can see the blank page anyway). Only
   a redeploy (pre-backend) or an admin API call (backend mode) can
   change it — the file itself grants no write access.

## Reporting a problem

Email the site owner (address in the footer). Include the page URL, what
you did, and what you expected vs. what happened. Do not include
passwords or full customer details.
