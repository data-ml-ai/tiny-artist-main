# Tiny Artist — Admin Panel Setup

The admin panel is live at **`/admin`** on the same Vercel domain as the
storefront (for example `https://tiny-artist-2339.vercel.app/admin`). It is
not linked from the public website. Nothing in this document contains a
password, access code, or secret key — those are set only in the Supabase
and Vercel dashboards.

## How access works (code-only)

There are **no admin accounts** — no email sign-in, no passwords. The
access code is the only credential (owner decision, 2026-11-16):

1. **Access code** — verified server-side by `api/verify-code.js` against
   the `ADMIN_ACCESS_CODE` environment variable. 5 wrong attempts in 15
   minutes locks the caller out for 15 minutes. When the service-role
   key is also set (Step 2), the lockout is shared across all servers
   and logged in `access_attempts`; without it, the gate still works but
   
   the lockout is counted per server only. The code never appears in
   frontend code or in this repository.
2. **Signed gate token** — on a correct code the server returns an
   HMAC-signed token (see `api/_gate.js`) valid for 12 hours. The panel
   sends it with every request to `api/admin.js`.
3. **Server API** — `api/admin.js` checks the token on every request
   before using the service-role key to read or write the database. The
   browser never sees the service key and never talks to Supabase
   directly. Actions are an explicit whitelist with validated inputs;
   there is no generic table access. Every write is recorded in the
   audit log under the actor `access-code` (the panel no longer knows
   individual admins).

Anyone who knows the code has full admin access, including the emergency
deactivation controls. Keep the code secret, and make it long: a short
code is easy to guess, and the panel shows a warning banner while the
code is weak.

## Step 1 — Run the database schema (once)

1. Open the Supabase dashboard for this project and go to **SQL Editor**.
2. Open `backend/supabase/schema.sql` from the repository, copy the whole
   file, paste it into a new query, and press **Run**.
3. Run it **exactly once**. It creates the tables, security rules (RLS),
   the seed catalogue (poster kits, the 16 figures at Rs. 70, the three
   official ready-made packs, and the two colour packs unpriced), the
   audit log, the site settings flag, and the product-images storage
   bucket.

Until this step is done, the storefront keeps working exactly as before
(hardcoded catalogue, WhatsApp checkout) and the panel shows a
"Database not connected" notice instead of fake data.

Note: the schema still contains the `is_admin()` / `is_super_admin()`
email allowlist and the `set_site_deactivated` function from the
earlier account-based design. They are no longer used by the panel
(the code-only server API authorises with the gate token instead), but
they are kept because the RLS policies reference them for direct
database access. Do not remove them.

## Step 2 — Set the Vercel environment variables

In the Vercel dashboard, open the `tiny-artist-2339` project →
**Settings → Environment Variables**, and add:

| Variable | Value |
|---|---|
| `ADMIN_ACCESS_CODE` | A strong access code only the admins know. **Do not reuse a short code** — choose a longer secret before sharing the panel. |
| `SUPABASE_URL` | The project URL, e.g. `https://<project-ref>.supabase.co` (Supabase dashboard → Project Settings → API). Required: the server API uses it for every database call. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Required.** The service-role (secret) key from the same Supabase API settings page. Server-only: never put it in frontend code or the repository. Without it the admin API refuses to run (the panel shows "Database not connected"). It also enables the shared wrong-code lockout. |
| `GATE_TOKEN_SECRET` | Any long random string (used to sign the gate tokens). Recommended; if unset, the functions derive it from the access code. |

Apply the variables to **Production**, then redeploy the project
(Deployments → ⋯ → Redeploy) so the server functions pick them up.

## Step 3 — Open the panel and verify

1. Open `https://tiny-artist-2339.vercel.app/admin`.
2. Enter the access code. The dashboard opens directly — there is no
   second sign-in.
3. The dashboard should load with live (initially empty) data — no sample
   numbers. Place a test order on the storefront: it appears in Orders
   as "Pending Confirmation".
4. Open **Super Admin** and confirm the site state shows LIVE. Do not
   deactivate the live site except in a real emergency; deactivation
   needs the typed confirmation word, and the recovery route is
   `/recovery.html`.

## Step 4 — Finish the catalogue in the panel

- **Colour packs**: open Products, set real prices for the Small and
  Large Colour Packs. Until priced, custom packs stay unorderable
  (the same guard the storefront already had).
- **Stock**: open Inventory and enter real stock counts. Low-stock
  alerts trigger at 5 or fewer; 0 means out of stock.
- **Costs**: to see estimated profit on the dashboard, enter the real
  cost per item on each product. Profit is never guessed: if any sold
  product has no cost, the dashboard says so instead of showing a
  made-up number.
- **Settings**: the WhatsApp number and free-delivery threshold can be
  changed in Settings; the storefront picks them up on the next load.
- **Product images**: JPG, PNG, WebP or GIF, up to 2 MB each. Images go
  through the server to Supabase Storage.

## What is real, and what is still to come

Real and working now: access-code gate with lockout, code-only entry
(no accounts), server-side admin API with token checks and input
validation, dashboard with live counts and revenue, order management
with statuses/notes/export/print, product and pack management with
image uploads, inventory with audit history, customer lists (registered
+ guests from orders), website activity logs, admin audit logs,
settings, and the emergency kill switch with typed confirmation.

Not built yet (no fake UI for them — they are absent rather than
pretending to work):

- **Coupons, customer messages and reviews** — need new tables and
  storefront features first.
- **Google Maps / delivery-location picker** — needs a Google Maps API
  key and an explicit customer consent flow. The panel never tracks
  visitors; map links are built only from addresses customers type.
- **Customer registration on the storefront** — shoppers currently order
  as guests via WhatsApp. Accounts created in Supabase Auth appear under
  Customers.
- **Live cart sync** — the Carts section reads the database carts table,
  which fills once storefront cart syncing ships.

## Security notes

- The publishable key in `supabase-config.js` is designed to be public;
  Row Level Security decides what it can read. The service-role key must
  never enter the repository — if it ever does, rotate it immediately in
  the Supabase dashboard.
- The gate token lives only in the browser tab (session storage) and
  expires after 12 hours; signing out clears it.
- Every admin write (orders, products, prices, stock, settings, site
  state) is recorded in the audit log with the before/after values,
  under the actor `access-code`.
- The `set_site_deactivated` database function is not used by the panel:
  it requires a Supabase Auth JWT, which the code-only panel does not
  have. The server API updates the site-settings row directly after
  checking the gate token, setting the same fields the function would.
