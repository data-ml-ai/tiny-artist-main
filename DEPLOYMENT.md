# DEPLOYMENT — Vercel (static site)

The storefront is a static site: no framework, no build step, no
server-side rendering. Any static host works; these steps are for Vercel.

## Option A — Vercel dashboard (recommended)

1. Push this folder to GitHub (see below), or drag the folder into a new
   Vercel project via **Add New → Project → Import**.
2. Framework Preset: **Other**. Build Command: *(leave empty)*.
   Output Directory: *(leave empty / `.`)*. Root Directory: repo root.
3. Deploy. Vercel serves `index.html` at `/`; all other pages are hash
   routes (`/#/shop`, `/#/cart`, …), so no rewrites are needed.
4. `vercel.json` in this repo applies security headers and long caching
   for `/assets/*` automatically.
5. Open the production URL and run the checklist in `TESTING.md`.

## Option B — Vercel CLI

```sh
npm i -g vercel
vercel login
vercel --prod
```

## GitHub push (from this folder)

```sh
git init
git add -A
git commit -m "Tiny Artist: WhatsApp checkout, real kit prices, local admin preview"
git branch -M main
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

Do **not** commit `.env` files. `.gitignore` already excludes them.
If the repository already exists with different history, clone it first
and copy these files in — do not force-push over unrelated history.

## Deployment consistency

There is **no build step**: Vercel serves the repo files exactly as
committed (`index.html`, `assets/*`, `collection.jpg`, `site-status.json`,
`recovery.html`, `vercel.json`). Nothing is generated, bundled, or
restyled at deploy time, so the production site matches the GitHub
version file-for-file. Verify after each deploy with the checklist in
`TESTING.md` on the live URL.

Important: the Lovable "Tiny artist" project is a **separate codebase**
(TanStack Start replica built from a screenshot). It is not the source
for this deployment and will differ in implementation details. The
GitHub repo in this project is the single source of truth for Vercel.
Do not "fix" Vercel output to match Lovable, or vice versa, without the
owner choosing one codebase.

`site-status.json` and `recovery.html` must deploy with the site —
without them the kill switch falls back to the per-browser flag only.

None are required for the storefront. Set the variables in `.env.example`
only when doing Phase 2 (see `SETUP.md`), in Vercel project settings —
never in the repo.

## Domains

- The site works on any `*.vercel.app` URL immediately.
- For a custom domain: Vercel → Project → Settings → Domains, then add
  the DNS records Vercel shows at your registrar. HTTPS is automatic.
- The previous address `https://tiny-artist.vercel.app/` belongs to a
  different Vercel account (see project history). Do not assume this
  deployment will reuse that exact address — confirm which Vercel account
  owns the target project before promising a URL.

## Rollback

Vercel keeps every deployment. To roll back: Deployments → pick the
previous good deployment → **Promote to Production**. The previous
`index.html` (2026-11-08 demo version) is preserved in git history once
this repo is pushed — tag it before replacing, if you want a named
fallback.
