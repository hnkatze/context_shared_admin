# Deploying to Vercel

## There is no `vercel.json`, and there should not be

`@astrojs/vercel` compiles the site into `.vercel/output/` following Vercel's Build Output
API v3 — routes, the serverless function, and the static assets are all described in
`.vercel/output/config.json`, which the build generates. Vercel reads that directly. Adding a
`vercel.json` would only introduce a second, competing source of routing truth.

Framework preset: **Astro**. Build command `npm run build`. Output is detected automatically.

## Before the first deploy: rotate the credentials

An early `.env.example` in this repo carried a real Supabase pooler password and a live `ctx_`
API token. They never reached a commit, but **they are still valid**, and the repository is
public. Rotate both in Supabase before pointing a public deployment at that database.

## Environment variables

Four, all server-side secrets. Set them in the Vercel project (Settings → Environment
Variables) for every environment you deploy.

### `CONTEXT_SHARED_DATABASE_URL`

```
postgresql://mcp_app.PROJECT_REF:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
```

Three things that are load-bearing:

- **Port 6543, the transaction-mode pooler — never 5432.** Vercel runs many isolated
  instances, each opening its own pool. The pool is capped at `max: 1` per instance for the
  same reason. A direct connection exhausts Postgres long before traffic does.
- **Connect as the dedicated application role.** On this Supabase project it is `context_app`
  (the local Docker seed calls it `mcp_app` — verify, do not assume). What matters is the
  privileges, and they were checked: `rolsuper = false`, `rolbypassrls = false`. Supabase's
  default `postgres` role and `service_role` both carry `BYPASSRLS`, which outranks
  `FORCE ROW LEVEL SECURITY`. Connect with either and every tenancy policy becomes decoration
  while the app keeps working perfectly — the failure is silent until a second organization
  exists. Confirm with:
  `select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user;`
- The pooler username is the role name, a dot, then the project ref.

### `PANEL_ORG_ID`

The `organizations.id` this deployment administers. Confirm which database your local `.env`
points at before assuming this differs from it — the checked-in assumption that `.env` is the
Docker instance has been wrong.

`organizations` has `FORCE ROW LEVEL SECURITY`, so you cannot list it without already knowing
the tenant. Resolve it through the `SECURITY DEFINER` function instead, with any active key
for the org:

```sql
select app.resolve_api_key('ctx_...');
```

A wrong id does not fail. RLS simply returns nothing and the panel renders healthy while
pointed at an empty organization — which is why `panelOrgId()` verifies the row exists once
per instance and throws instead.

### `PANEL_PASSWORD_HASH`

```bash
node scripts/hash-password.mjs 'the admin password'
```

Produces `scrypt:N:r:p:salt:key`. **The separator is a colon, not `$`.** Vite expands `$1` and
`$8` inside a `.env` file, which truncates a `$`-separated hash to a zero-length key — and a
zero-length key compares equal to everything, authenticating any password. `parseHash` now
rejects it on length, so the failure is loud rather than silent, but the colon format is what
avoids the problem entirely. Store the hash, never the password.

### `PANEL_SESSION_SECRET`

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Use a different value from local. The session cookie is signed with this **plus** the password
hash, so rotating either one invalidates every open session — there is no session store to
clear.

## Function region

Put the function in the region closest to the Supabase project (Vercel project Settings →
Functions). Every page render opens a transaction and runs at least one query, so a
cross-continent hop is paid on every request. This is project configuration, not code.

## After deploying

1. Load `/login` and sign in. A wrong `PANEL_PASSWORD_HASH` surfaces as "The panel is missing
   its login configuration", not as a wrong-password error.
2. Load `/` — if `PANEL_ORG_ID` is wrong you get "Could not reach the board" naming the id.
3. Issue a key on `/keys` and confirm it authenticates. That exercises the whole chain:
   tenant resolution, the transaction guard, and the SHA-256 hash agreeing with
   `app.resolve_api_key`.
