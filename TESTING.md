# TESTING REPORT — Tiny Artist (build of 2026-11-16)

> Note (2026-11-16): the admin panel is code-only since the rebuild
> described in ADMIN-SETUP.md — no Supabase Auth accounts. The admin
> checks below verify the code-only design.

## Automated tests — PASSED (2026-11-16, Node 24)

`node tests/checkout.test.js` runs the **real page scripts** from
`index.html` in a VM sandbox with stubbed browser storage/DOM and asserts
behaviour, plus host-side checks of the repo files. Result: **79/79
assertions passed** (62 storefront + 7 kill-switch + 10 repo/status checks).

`node tests/admin-checks.js` verifies the admin panel statically: no
access-code literal, admin emails or secret material in browser code,
the panel never calls Supabase directly and has no account login, the
server gate reads env vars only with rate limiting and lockout, the
gate works without the service-role key (per-instance lockout) but
still refuses to run with no code configured, the admin API requires
the service key, verifies the gate token and whitelists its actions,
the schema carries the 3-admin allowlist + super admin + seeds, the
`/admin` rewrite exists, and the storefront wiring (live catalogue,
order insert, event logging, site config) is present. Result: **58/58
checks passed**.

`node tests/gate-no-service-key.test.js` runs the real gate function
with only a dummy `ADMIN_ACCESS_CODE` set: right code → 200 + token,
wrong code → 401 with remaining attempts, 6th failure from one IP →
429 lockout, other IPs unaffected, no code configured → 503. Result:
**7/7 gate checks passed**.

`node tests/admin-api.test.js` runs the real `/api/admin` handler with
a stubbed fetch (no network): missing/bad/expired tokens → 401 with no
upstream call, unknown actions → 400, order/product/stock validation,
one-row patch targets, audit rows written as `access-code`, the kill
switch patching the settings row directly (never the JWT-bound RPC),
image type/size rules, search sanitisation, 503 with no service key,
and a token issued by `/api/verify-code` being accepted by the admin
API. Result: **27/27 admin API checks passed**.

Covered:

| Area | Assertions |
|---|---|
| Home rendering | Kits, fixed prices (PKR 1,000 / 1,300), Coming Soon, no demo-order text |
| Cart math | 1×1000 + 2×1300 = 3600; qty +/−; remove; pack totals |
| Delivery rule | FREE above Rs. 2,000; "To Be Confirmed" at/below 2,000 |
| WhatsApp message | Exact format, customer block, line totals, subtotal/delivery/total, instructions, closing line; `encodeURIComponent` round-trip; `wa.me/923098426672` |
| Phone validation | `03…`, `+92…`, spaced, 10-digit accepted; short/letters/landline rejected |
| Figure prices | Every figure defaults to Rs. 70 (owner-confirmed 2026-11-16); admin override wins, clearing restores 70; packs still unpriced by default |
| Unpriced guard | Unpriced colour pack → totals null, Order Now disabled; pricing it unblocks; pack totals use the pack priceKey plus Rs. 70 per figure |
| Shop | Category filters (Painting Kits / Space), search, kit detail page + poster images |
| Checkout validation | Bad name/phone/city/address → errors shown, no navigation, cart kept |
| Successful checkout | Order saved as **Pending Confirmation**, cart cleared, navigation to `wa.me` with full order in the message, confirmation view shows fallback link |
| Duplicate guard | Second submit while submitting is blocked; guard resets on navigation |
| Admin honesty | No fake/sample numbers or customers; local-preview labels; fixed kit prices listed |
| Kill switch | Typed-DELETE + acknowledgement guard; render blanks the page when deactivated; content returns after recovery; local flag persists/clears |
| Repo/status | `site-status.json` active; recovery page requires `RESTORE` and deletes nothing; schema allowlist holds both admin emails; `site_settings` + setter + RLS present; no admin emails in frontend or recovery page |

Also verified:

- `node --check` passes on both `<script>` blocks (no syntax errors).
- All referenced local assets exist: `assets/logo.png`, `assets/logo.webp`,
  `assets/kit-20pcs.png/.webp`, `assets/kit-30pcs.png/.webp`,
  `assets/collection.webp`, `collection.jpg`, favicon.
- Logo transparency check: the supplied logo's black corners were made
  transparent (border-connected near-black pixels only) and visually
  verified on the site's cream background — no black fringe.
- WebP savings: kit posters ~350 KB PNG → ~50 KB WebP each; PNG fallback
  kept via `<picture>`.
- No secrets in the repo: `grep` for keys/tokens/passwords in frontend
  files returns nothing (admin emails appear only in
  `backend/supabase/schema.sql`, as the server-side allowlist, per spec).
- No leftover fake/demo markers in customer flows (`SAMPLE-*`, sample
  customers, demo-order wording) — checked by the build script.

## Manual checklist — REQUIRED after deployment (not yet run)

These need a live URL and real devices, which were not available in the
build environment. Do not mark the site "verified" until they pass:

- [ ] Desktop (Chrome + one other browser): home, shop filters/sort/search,
      kit + figure detail pages, pack builder, cart, checkout, FAQ, About,
      Contact, footer links, burger menu at mobile width.
- [ ] Mobile (real Android phone + iPhone if available): tap **Order via
      WhatsApp** → WhatsApp app opens with the exact order message; send it
      and confirm it arrives at +92 309 8426672 with correct details.
- [ ] Desktop: **Order via WhatsApp** → WhatsApp Web opens with the message.
- [ ] Fallback: with WhatsApp blocked/uninstalled, the confirmation page's
      "Open WhatsApp Order Again" link works.
- [ ] No horizontal overflow at 360px, 768px, 1280px widths.
- [ ] Lighthouse (mobile + desktop): record Performance / Accessibility /
      Best Practices / SEO scores; fix any new regression vs. the original.
- [ ] Admin local preview: visit `/#/admin`, confirm the disabled sign-in
      + local-preview wording, and that no other device's data appears.
- [ ] Kill switch (local): Admin → Danger Zone → type `DELETE`, tick,
      confirm → page goes fully blank white; open `recovery.html`,
      type `RESTORE`, confirm → site returns. Confirm no files/data
      were deleted.
- [ ] Kill switch (server, after Phase 2): activate as one admin email,
      confirm blank page on a fresh device; restore as the other admin
      email; confirm a non-admin API call gets 403.
- [ ] Admin emails (after Phase 2): both allowlisted emails sign in and
      reach the dashboard; a third email is denied admin routes + APIs.
- [ ] Deployment consistency: compare the production URL against this
      repo file-for-file (same `index.html`, assets, `site-status.json`,
      `recovery.html`, `vercel.json`) and re-run the desktop/mobile
      checklist above on the live URL. Note: the Lovable project is a
      separate TanStack replica, not this codebase — do not expect it
      to match pixel-for-pixel; the GitHub files are the source of truth
      for Vercel.

## Explicitly NOT verified

- Real-device WhatsApp app opening (needs a phone + the live site).
- Vercel production deployment (Vercel connector returned 403 for the
  team scope during this build — see handover notes; deploy via
  dashboard/CLI and re-run the checklist above).
- Supabase backend, admin allowlist enforcement, shared orders/analytics,
  and server-side kill switch (Phase 2 — not connected; schema + plan in
  `SETUP.md`). Both admin emails are in the allowlist SQL and verified by
  automated repo checks, but live sign-in as either email is untested
  until Auth exists.
- Cross-browser rendering beyond the automated logic tests (no headless
  browser was available in the build environment).
