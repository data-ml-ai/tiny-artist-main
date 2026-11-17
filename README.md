# TINY ARTIST — storefront

A whole world of screen-free play. Paintable figures and DIY painting kits
for children in Pakistan. Orders are placed via WhatsApp and confirmed by
the Tiny Artist team in chat. Cash on Delivery.

**Live design:** this project preserves the design of the existing website
(deployed 2026-11-08, single-file `index.html`, cream/coral palette, Fredoka/
Nunito Sans system stack, hash routing). The build in this folder enhances
that same file — it does not redesign it.

## What works right now (no backend needed)

- Homepage, Shop, product pages, Build Your Own Pack, About, FAQ, Contact.
- Two painting kits with **fixed prices from the supplied posters**:
  - 20 Pcs Painting Set — **PKR 1,000** (12 colours, Free Cash on Delivery)
  - 30 Pcs Painting Kit — **PKR 1,300** (12-colour strip, 3 big colours, 4 brushes)
- 16 paintable figures (browseable; individual prices are "Price Coming Soon"
  until the owner sets them — unpriced items cannot be ordered, by design).
- Cart: add/remove, quantity controls, subtotal/total, free-delivery progress
  (free above Rs. 2,000), persisted across refreshes (browser localStorage).
- Checkout: name / phone / address / city / instructions, validated
  (Pakistani mobile format). **Order via WhatsApp** opens
  `https://wa.me/923098426672` immediately with the full order message,
  URL-encoded, from the customer's click. Duplicate submissions are blocked,
  the order is saved locally as **Pending Confirmation** before navigation,
  and a fallback link is shown if WhatsApp does not open. Opening WhatsApp
  never marks an order confirmed.
- Floating WhatsApp button on every page.
- Coming Soon section (does not block shopping).
- Emergency deactivation ("Delete Website", Admin → Danger Zone): typed
  `DELETE` + tick-box + native confirm. When active, the public site
  renders a completely blank white page. Nothing is deleted — code,
  database records, and the repo are untouched. Recovery is via the
  separate `recovery.html` page (typed `RESTORE` + confirm). Today this
  is local-preview only (this browser); the server-controlled version
  reads `site_settings` in Supabase once Phase 2 is wired.
- Responsive desktop/tablet/mobile (same breakpoints as the original).

## What is intentionally NOT claimed

- There is **no shared database, customer login, or server-side admin yet**.
  The `/#/admin` page is a clearly-labelled **local preview** showing only
  data stored in that visitor's own browser. Its sign-in form stays disabled
  until the backend is connected — see `SETUP.md` and `SECURITY.md`.
- Analytics in the local preview count **this device only**. There are no
  fake totals and no fake customers.
- Customer/order records are **not shared** between devices until Phase 2.
  The WhatsApp message itself is the order record the team works from today.

## Project structure

```
index.html                  Whole store (HTML + CSS + JS, no build step)
recovery.html               Separate website-recovery page (see above)
site-status.json            Deployed on/off flag read on every load
collection.jpg              Hero photo: the 16-figure collection
assets/
  logo.png                  Tiny Artist logo (black corners made transparent)
  logo-original.png         Logo exactly as supplied
  kit-20pcs.png/.webp       20 Pcs poster (WebP served first, PNG fallback)
  kit-30pcs.png/.webp       30 Pcs poster (WebP served first, PNG fallback)
  collection.webp           Optimised hero photo
vercel.json                 Security headers + asset caching
.env.example                Backend variable names only (no secrets)
backend/
  supabase/schema.sql       Tables, RLS, admin allowlist, order function,
                            site_settings kill switch
  api/create-order.example.js  Server order endpoint (example, not active)
  api/site-status.example.js   Server kill-switch endpoint (example, not active)
tests/checkout.test.js      Node tests that run the real page scripts
README.md / SETUP.md / DEPLOYMENT.md / TESTING.md / SECURITY.md
```

## Run locally

```sh
# Any static server works. Examples:
python3 -m http.server 8000
# then open http://localhost:8000/
npx serve .
```

Or open `index.html` directly in a browser (double-click works).

## Test

```sh
node tests/checkout.test.js
# 74 assertions: cart math, WhatsApp message format + encoding, phone
# validation, unpriced-item guard, duplicate-submit guard, admin honesty,
# kill-switch guard + blank page + recovery, and server allowlist checks.
```

## Deploy

See `DEPLOYMENT.md`. In short: import this folder/repo into Vercel as a
static site (no build command, no framework preset). Then run the
post-deploy checklist in `TESTING.md`, including a real-phone WhatsApp test.

## Backend (Phase 2, not yet connected)

`SETUP.md` + `backend/supabase/schema.sql` define the Supabase backend:
authentication, a server-side admin allowlist for exactly two owner emails
(`moosamahmood20002512@gmail.com` and `asadvendor0@gmail.com` — both are
in `is_admin()`; removing either revokes that owner's access),
products/orders/analytics tables with Row Level Security, a
transactional order function that re-checks prices server-side, and the
`site_settings` kill switch. Nothing in the frontend pretends this
backend exists until it is actually configured.

## Notes / open questions for the owner

1. The contact email printed on the original site is
   `musamahmood20002512@gmail.com` (one `o` in "musa"). The admin/Vercel
   account email is `moosamahmood20002512@gmail.com` (two `o`s). The site
   email was left unchanged — please confirm which address customers
   should use.
2. Individual figure prices and colour-pack prices are unset. Set them in
   Admin → Products (local only, this device) or, after Phase 2, in the
   database. Figures cannot be ordered on WhatsApp until priced.
3. A price of Rs. 1,600 was mentioned in an earlier conversation but no
   poster or product confirms it. No Rs. 1,600 product was added — tell us
   what it is for and it can be added with its poster.
