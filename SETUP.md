# SETUP — connecting the backend (Phase 2)

> Note (2026-11-16): the admin parts of this plan changed. The panel is
> now code-only (see ADMIN-SETUP.md): no Supabase Auth admin accounts,
> no `is_admin()` sign-in. The schema, RLS and order-creation steps
> below are still accurate. The live admin API is `api/admin.js`.

Status: **not done**. The storefront works today without a backend
(WhatsApp ordering + local cart/orders). This document is the exact plan
for adding shared data and secure admin. Do not skip steps, and do not
claim admin works until step 6 passes.

## 0. What you need

- A Supabase account (free tier is enough to start) — https://supabase.com
- Access to the two owner inboxes, for email verification:
  - `moosamahmood20002512@gmail.com`
  - `asadvendor0@gmail.com`
- The Vercel project for this site (to set server-only variables).

## 1. Create the Supabase project

1. Create a new project. Note its URL and keys (Project Settings → API).
2. In **Authentication → Providers**, enable Email. Turn **on**
   "Confirm email" so an admin cannot sign in with an unverified address.
3. In **Authentication → URL Configuration**, set the Site URL to the
   production site URL and add it to Redirect URLs.

## 2. Apply the database schema

In the Supabase SQL Editor, run `backend/supabase/schema.sql` in full.
It creates:

- `profiles`, `categories`, `products`, `product_images`, `carts`,
  `cart_items`, `orders`, `order_items`, `analytics_events`
- Row Level Security on every table (deny by default).
- `public.is_admin()` — true only when the signed-in user's verified email
  is one of the two allowlisted addresses. **This is the only place admin
  status is decided.** The frontend never decides it.
- `public.create_order(...)` — a `SECURITY DEFINER` function that takes
  cart items + delivery details, looks up **server-side** prices, snapshots
  them into `order_items`, and inserts the order as `Pending Confirmation`
  in one transaction. Client-submitted prices/totals are ignored.
- A trigger preventing users from changing their own `profiles.role`.
- `public.site_settings` (single row) + `public.set_site_deactivated()` —
  the server-controlled kill switch. Public read; admin-only change via
  `is_admin()`. Deactivation flips a flag only; it deletes nothing.

Review the SQL before applying it. If your Supabase project already has
tables with these names, resolve conflicts first — do not run it blindly.

## 3. Create the two admin accounts

1. Each owner registers at the site's sign-in page (to be wired in step 5)
   with their allowlisted email and verifies the email.
2. Verify in Supabase (Authentication → Users) that both accounts exist
   with confirmed emails.
3. `is_admin()` grants admin rights from the email alone — there is no
   manual "make admin" button and no role field a user can set.

## 4. Set environment variables in Vercel

In Vercel → Project → Settings → Environment Variables (Production):

| Variable | Value | Notes |
|---|---|---|
| `SUPABASE_URL` | Project URL | Safe to expose |
| `SUPABASE_ANON_KEY` | anon/public key | Safe to expose (RLS protects data) |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key | **Server only. Never in frontend code.** |
| `WHATSAPP_NUMBER` | `923098426672` | Must match `WA_NUMBER` in `index.html` |

Never commit a `.env` file. `.env.example` in this repo lists names only.

## 5. Wire the frontend (development work — not in this repo yet)

This is the remaining engineering. Do not improvise it in the browser:

1. Add Supabase Auth (email + password, or magic link) with session
   handling. Sign-in/sign-out, password reset via Supabase emails.
2. Replace the disabled admin sign-in with real Supabase sign-in. Admin
   pages must call the backend and render only what the backend returns;
   an `is_admin()` check happens on **every** admin read/write via RLS —
   a frontend route guard alone is never sufficient.
3. Products: read from the `products` table (public read). Admin
   create/edit/delete + image upload go through Supabase Storage with
   type/size validation (see `SECURITY.md`).
4. Orders: on WhatsApp checkout, call the server order endpoint
   (`backend/api/create-order.example.js`, moved to `api/create-order.js`
   with `@supabase/supabase-js` installed) **without blocking WhatsApp
   navigation**: save locally first (as today), navigate immediately,
   and let the server call complete independently — or, preferably, have
   the server call finish *before* navigation only if it returns within a
   short timeout, falling back to local save + WhatsApp either way.
   Never lose the cart because the server was slow, and never mark an
   order confirmed because WhatsApp opened.
5. Analytics: insert privacy-conscious events (page views, add-to-cart,
   checkout started) with anonymous session IDs for guests. Filter
   obvious bots. Admin reads aggregates only through RLS-protected
   queries/views.
6. Keep all prices server-side. The frontend must never trust a price,
   total, or role sent by the client.
7. Wire the kill switch: move `backend/api/site-status.example.js` to
   `api/site-status.js`, set `BACKEND_CONFIG.enabled = true` and
   `statusApi = "/api/site-status"` in `index.html` and `recovery.html`,
   and expose the Supabase client as `window.supabaseClient` so the
   admin/restore actions send the signed-in session token. Verify:
   deactivate as one admin → public site blank on a fresh device;
   restore from `recovery.html` as the other admin → site returns.
   Keep `site-status.json` deployed as the pre-backend fallback; once
   the API is live, the database is the source of truth.

## 6. Verify before calling it done

- [ ] Both allowlisted emails can sign in and see the admin dashboard
      with **real database** data.
- [ ] `select public.is_admin();` returns `true` for
      `moosamahmood20002512@gmail.com` and for `asadvendor0@gmail.com`,
      and `false` for any other verified email.
- [ ] A third email can register/sign in as a customer but gets
      access-denied on every admin route **and** every admin API call
      (test with `curl` + the user's token, not just the UI).
- [ ] Directly visiting `/#/admin/...` while signed out redirects to
      sign-in; no admin data loads.
- [ ] Attempting to set `role=admin` via a profile update is rejected.
- [ ] An order placed through checkout appears in the database with
      server-verified prices and status `Pending Confirmation`.
- [ ] WhatsApp still opens immediately with the correct message on
      desktop and on a real phone.
- [ ] No service-role key appears in any frontend bundle or repo file
      (`grep -r` the key prefix before deploying).
- [ ] Kill switch: activate as an admin → the public site shows a blank
      white page on a fresh browser/device, with no content visible;
      no code, database rows, or repo files are deleted; restore via
      `recovery.html` brings the site back; a non-admin attempting the
      status API gets 403 and nothing changes.

If any check fails, admin is **not** production-ready. Fix it; do not
work around it by disabling RLS or trusting the frontend.
