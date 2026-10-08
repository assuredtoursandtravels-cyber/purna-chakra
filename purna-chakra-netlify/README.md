# Purna Chakra on Netlify

Interactive Digital Prototype / Concept Simulation. Static frontend in `public/`, one Netlify Function (`netlify/functions/api.mts`) serving `/api/*`, and Netlify Database (Postgres) with its schema in `netlify/database/migrations/`.

## Deploy

Requires Node 20.12.2+ and Netlify CLI 26+ (`npm install -g netlify-cli`). Netlify Database needs a Credit-based plan.

```
npm install
netlify login
netlify link            # or: netlify init  (creates the site)
```

Set these environment variables (UI: Site configuration > Environment variables, scope must include **Functions**). Do not put them in `netlify.toml` or commit them.

| Variable | Value |
|---|---|
| `JWT_SECRET` | 48+ random characters: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `ADMIN_EMAIL` | your admin login email |
| `ADMIN_PASSWORD` | a strong password you choose |

Then deploy a preview first, check it, then go to production:

```
netlify deploy          # preview
netlify deploy --prod
```

The deploy applies the migration (tables, prototype rates, two labelled demo stations) before publishing. Use `netlify database status` to confirm.

The admin account is created on the first API request after deploy, from `ADMIN_EMAIL` / `ADMIN_PASSWORD`, stored as a bcrypt hash. There is no admin registration route. Admin login is at `/#/admin/login`.

## Local development

```
netlify dev
netlify database migrations apply
```

## Rules enforced server-side

- Role comes from the database, never from the token or request body. Customers get 403 on `/api/admin/*` and on other users' data; unauthenticated requests get 401.
- Points, rate, userId and balance in a request are never read.
- Duplicate check, validation, transaction insert, balance update and system events share one database transaction. The UNIQUE `device_event_id` plus a catch for concurrent duplicates means one credit only.
- Each transaction stores `rate_used`; rate changes affect future transactions only.
- A partial unique index allows only one active station per QR value.
- Weight: grams convert once to kg; rejects missing, non-numeric, non-positive, under 0.001 kg and over 50 kg. Points are `round(weightKg x rate)`.
- Admin and customer queries select explicit columns, so password hashes are never returned.
- The function is rate limited to 120 requests per minute per IP.

## Notes and gaps

- Not yet run: this was written without network access, so deploy a preview and test it before relying on it.
- Preview deploys get a database branch seeded from production data. Preview links are public, so avoid sharing them once real customer data exists.
- Tokens last 8 hours and are not revoked on logout.
- No ESP32 device endpoint yet. A device route would authenticate the station with its own credential and reuse `recordTransaction` with a different `source`.
- The Netlify connector available to me can create projects and set variables but cannot upload files, so the deploy commands above need to be run by you.
